import { describe, expect, it } from "vitest";
import { Money } from "../domain/money";
import { ConfirmAndSend } from "./use-cases/confirm-and-send";
import { ConnectWallet } from "./use-cases/connect-wallet";
import { CreateRemittance } from "./use-cases/create-remittance";
import { LockQuote } from "./use-cases/lock-quote";
import { PreviewQuote } from "./use-cases/preview-quote";
import { ResumeKyc } from "./use-cases/resume-kyc";
import { StartKyc } from "./use-cases/start-kyc";
import { TrackRemittance } from "./use-cases/track-remittance";
import {
  beneficiary,
  FakeKycGateway,
  FakeKycPendingStore,
  FakeKycStore,
  FakePayoutGateway,
  FakeQuoteGateway,
  FakeWallet,
  FixedClock,
  InMemoryRepo,
  SeqIds,
} from "../test-support/fakes";

function setup(opts?: { kyc?: FakeKycGateway; payout?: FakePayoutGateway; kycStore?: FakeKycStore }) {
  const repo = new InMemoryRepo();
  const clock = new FixedClock();
  const ids = new SeqIds();
  const payout = opts?.payout ?? new FakePayoutGateway();
  const kycStore = opts?.kycStore ?? new FakeKycStore();
  const pending = new FakeKycPendingStore();
  const wallet = new FakeWallet();
  const kycGw = opts?.kyc ?? new FakeKycGateway();
  return {
    repo,
    clock,
    kycStore,
    pending,
    create: new CreateRemittance(repo, clock, ids),
    connect: new ConnectWallet(wallet, kycStore),
    startKyc: new StartKyc(kycGw, kycStore, pending, repo, clock),
    resumeKyc: new ResumeKyc(kycGw, kycStore, pending, repo, clock),
    lock: new LockQuote(new FakeQuoteGateway(), repo, clock),
    confirm: new ConfirmAndSend(wallet, payout, repo, clock),
    track: new TrackRemittance(payout, repo, clock),
  };
}

const kycInput = (remittanceId: string) => ({
  remittanceId,
  address: "0xSender",
  purpose: "family support",
});

describe("Use-cases — money-path", () => {
  it("happy path: create → kyc → lock → confirm → track → settled", async () => {
    const { create, startKyc, lock, confirm, track } = setup();
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    expect((await startKyc.execute(kycInput(id))).kind).toBe("done");
    let r = await lock.execute({ remittanceId: id });
    expect(r.status).toBe("quoted");
    r = await confirm.execute({ remittanceId: id });
    expect(r.status).toBe("payout_submitted");
    r = await track.execute({ remittanceId: id });
    expect(r.status).toBe("settled");
    expect(r.snapshot.deliveredPen).toEqual(Money.of(368, "PEN"));
    expect(r.snapshot.principalTx).toBe("0xprincipal");
  });

  it("payout settled con deliveredPen null → settled preserva null (AC-1, no coalesce a S/0)", async () => {
    const { create, startKyc, lock, confirm, track } = setup({
      payout: new FakePayoutGateway({}, { deliveredPen: null }),
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await startKyc.execute(kycInput(id));
    await lock.execute({ remittanceId: id });
    await confirm.execute({ remittanceId: id });
    const r = await track.execute({ remittanceId: id });
    expect(r.snapshot.status).toBe("settled");
    expect(r.snapshot.deliveredPen).toBeNull();
  });

  it("KYC no pasa → kyc_failed, y lock falla (el dominio fuerza el orden)", async () => {
    const { create, startKyc, lock } = setup({
      kyc: new FakeKycGateway({ approved: false, payoutAllowed: false }),
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const res = await startKyc.execute(kycInput(r0.snapshot.id));
    expect(res.kind).toBe("done");
    if (res.kind === "done") expect(res.snapshot.status).toBe("kyc_failed");
    await expect(lock.execute({ remittanceId: r0.snapshot.id })).rejects.toThrow(
      /invalid_transition/,
    );
  });

  it("no se puede lock antes de KYC", async () => {
    const { create, lock } = setup();
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    await expect(lock.execute({ remittanceId: r0.snapshot.id })).rejects.toThrow(
      /invalid_transition/,
    );
  });

  it("payout falla → payout_failed (con reason)", async () => {
    const { create, startKyc, lock, confirm } = setup({
      payout: new FakePayoutGateway({ status: "failed", failureReason: "partner_down" }),
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await startKyc.execute(kycInput(id));
    await lock.execute({ remittanceId: id });
    const r = await confirm.execute({ remittanceId: id });
    expect(r.status).toBe("payout_failed");
    expect(r.snapshot.failureReason).toBe("partner_down");
  });

  it("PreviewQuote no crea remesa", async () => {
    const q = await new PreviewQuote(new FakeQuoteGateway()).execute({
      amountUsd: 400,
      method: "yape",
    });
    expect(q.receive.currency).toBe("PEN");
    expect(q.send.major).toBe(400);
  });

  it("ConnectWallet devuelve address + KYC recordado (login de la DApp)", async () => {
    const kycStore = new FakeKycStore();
    const { connect } = setup({ kycStore });
    let res = await connect.execute();
    expect(res.address).toBe("0xSender");
    expect(res.rememberedKyc).toBeNull();
    await kycStore.save("0xSender", {
      verificationId: "v",
      approved: true,
      payoutAllowed: true,
      riskLevel: "low",
      provenance: "didit",
      identity: null,
    });
    res = await connect.execute();
    expect(res.rememberedKyc?.approved).toBe(true);
  });

  it("KYC-once: la 2da remesa de la misma wallet reusa el KYC (sin re-verificar)", async () => {
    const kycStore = new FakeKycStore();
    const { create, startKyc } = setup({ kycStore });
    const r1 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    await startKyc.execute(kycInput(r1.snapshot.id)); // verifica + guarda en el store
    const r2 = await create.execute({ amountUsd: 200, beneficiary: beneficiary() });
    const res = await startKyc.execute({ remittanceId: r2.snapshot.id, address: "0xSender" });
    expect(res.kind).toBe("done");
    if (res.kind === "done") expect(res.snapshot.status).toBe("kyc_passed");
  });

  it("Didit redirect → resume aplica la decisión y pasa el KYC (flujo móvil)", async () => {
    const { create, startKyc, resumeKyc } = setup({ kyc: new FakeKycGateway({}, true) });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const start = await startKyc.execute({ remittanceId: r0.snapshot.id, address: "0xSender" });
    expect(start.kind).toBe("redirect"); // te manda a Didit

    const res = await resumeKyc.execute(); // simula el retorno de Didit
    expect(res.kind).toBe("passed");
    if (res.kind === "passed") expect(res.snapshot.status).toBe("kyc_passed");
  });

  it("resume sin KYC pendiente → none (carga normal de la app)", async () => {
    const { resumeKyc } = setup();
    expect((await resumeKyc.execute()).kind).toBe("none");
  });
});
