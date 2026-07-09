import { describe, it, expect } from "vitest";
import { ConfirmAndSend } from "./use-cases/confirm-and-send";
import { ConnectWallet } from "./use-cases/connect-wallet";
import { CreateRemittance } from "./use-cases/create-remittance";
import { LockQuote } from "./use-cases/lock-quote";
import { PreviewQuote } from "./use-cases/preview-quote";
import { RunKyc } from "./use-cases/run-kyc";
import { TrackRemittance } from "./use-cases/track-remittance";
import {
  beneficiary,
  FakeKycGateway,
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
  const wallet = new FakeWallet();
  return {
    repo,
    clock,
    kycStore,
    create: new CreateRemittance(repo, clock, ids),
    connect: new ConnectWallet(wallet, kycStore),
    kyc: new RunKyc(opts?.kyc ?? new FakeKycGateway(), kycStore, repo, clock),
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
    const { create, kyc, lock, confirm, track } = setup();
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await kyc.execute(kycInput(id));
    let r = await lock.execute({ remittanceId: id });
    expect(r.status).toBe("quoted");
    r = await confirm.execute({ remittanceId: id });
    expect(r.status).toBe("payout_submitted");
    r = await track.execute({ remittanceId: id });
    expect(r.status).toBe("settled");
    expect(r.snapshot.deliveredPen?.currency).toBe("PEN");
    expect(r.snapshot.principalTx).toBe("0xprincipal");
  });

  it("KYC no pasa → kyc_failed, y lock falla (el dominio fuerza el orden)", async () => {
    const { create, kyc, lock } = setup({
      kyc: new FakeKycGateway({ approved: false, payoutAllowed: false }),
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const r = await kyc.execute(kycInput(r0.snapshot.id));
    expect(r.status).toBe("kyc_failed");
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
    const { create, kyc, lock, confirm } = setup({
      payout: new FakePayoutGateway({ status: "failed", failureReason: "partner_down" }),
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await kyc.execute(kycInput(id));
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
    const { create, kyc } = setup({ kycStore });
    const r1 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    await kyc.execute(kycInput(r1.snapshot.id)); // verifica + guarda en el store
    const r2 = await create.execute({ amountUsd: 200, beneficiary: beneficiary() });
    // 2da remesa, misma wallet, SIN datos de identidad → reusa el KYC recordado
    const r = await kyc.execute({ remittanceId: r2.snapshot.id, address: "0xSender" });
    expect(r.status).toBe("kyc_passed");
  });
});
