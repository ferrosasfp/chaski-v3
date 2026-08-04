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
import { FallbackKycGateway } from "../infrastructure/fallback/gateways";
import type { KycPendingStore, KycStore } from "./ports";
import {
  beneficiary,
  FakeKycGateway,
  FakeKycPendingStore,
  FakeKycStore,
  FakePayoutAuthorityGateway,
  FakePayoutGateway,
  FakeQuoteGateway,
  FakeRefundGateway,
  FakeSolanaEscrowDepositProbe,
  FakeSolanaPayoutPrepareGateway,
  FakeSolanaSenderSolBalanceProbe,
  FakeSolanaSettlementGateway,
  FakeSolanaWallet,
  FAKE_SOLANA_BENEFICIARY,
  FAKE_SOLANA_SIGNATURE,
  FixedClock,
  InMemoryRepo,
  SeqIds,
  ThrowingKycPendingStore,
  ThrowingSaveKycStore,
} from "../test-support/fakes";

function setup(opts?: {
  kyc?: FakeKycGateway;
  payout?: FakePayoutGateway;
  kycStore?: KycStore;
  pending?: KycPendingStore;
  solanaGateway?: FakeSolanaSettlementGateway;
}) {
  const repo = new InMemoryRepo();
  const clock = new FixedClock();
  const ids = new SeqIds();
  const payout = opts?.payout ?? new FakePayoutGateway();
  const kycStore = opts?.kycStore ?? new FakeKycStore();
  const pending = opts?.pending ?? new FakeKycPendingStore();
  // WKH-320: el e2e corre sobre el CAMINO REAL. Antes usaba la FakeWallet demo y llegaba a
  // payouts.submit (paso 4), que post-poda es estructuralmente inalcanzable: sin `solana` inyectado
  // el tapón DT-8 falla la remesa fail-closed. Se inyecta el par prepare+gateway Solana, así el
  // recorrido create → lock → kyc → confirm → track sigue probado punta a punta.
  const wallet = new FakeSolanaWallet();
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
    confirm: new ConfirmAndSend(wallet, repo, clock, new FakePayoutAuthorityGateway(), new FakeRefundGateway(), {
      prepare: new FakeSolanaPayoutPrepareGateway(),
      gateway: opts?.solanaGateway ?? new FakeSolanaSettlementGateway(),
      probe: new FakeSolanaEscrowDepositProbe(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe(),
    }),
    track: new TrackRemittance(payout, repo, clock, new FakeRefundGateway()),
  };
}

const kycInput = (remittanceId: string) => ({
  remittanceId,
  address: FAKE_SOLANA_BENEFICIARY,
  purpose: "family support",
});

describe("Use-cases — money-path", () => {
  it("happy path: create → lock → kyc → confirm → track → settled", async () => {
    const { create, startKyc, lock, confirm, track } = setup();
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    let r = await lock.execute({ remittanceId: id }); // WKH-187: cotiza PRIMERO (created→quoted)
    expect(r.status).toBe("quoted");
    expect((await startKyc.execute(kycInput(id))).kind).toBe("done"); // quoted→kyc_pending→kyc_passed
    r = await confirm.execute({ remittanceId: id });
    expect(r.status).toBe("payout_submitted");
    r = await track.execute({ remittanceId: id });
    expect(r.status).toBe("settled"); // delivered dentro de tolerancia del receive lockeado (AC-6)
    expect(r.snapshot.deliveredPen).toEqual(Money.of(1478.15, "PEN"));
    expect(r.snapshot.principalTx).toBe(FAKE_SOLANA_SIGNATURE);
  });

  it("payout settled con deliveredPen null → settled preserva null (AC-1, no coalesce a S/0)", async () => {
    const { create, startKyc, lock, confirm, track } = setup({
      payout: new FakePayoutGateway({}, { deliveredPen: null }),
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await lock.execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC
    await startKyc.execute(kycInput(id));
    await confirm.execute({ remittanceId: id });
    const r = await track.execute({ remittanceId: id });
    expect(r.snapshot.status).toBe("settled");
    expect(r.snapshot.deliveredPen).toBeNull();
  });

  it("KYC no pasa → kyc_failed terminal, re-lock falla (el dominio fuerza el orden)", async () => {
    const { create, startKyc, lock } = setup({
      kyc: new FakeKycGateway({ approved: false, payoutAllowed: false }),
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await lock.execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC (created→quoted)
    const res = await startKyc.execute(kycInput(id)); // quoted→kyc_pending→kyc_failed
    expect(res.kind).toBe("done");
    if (res.kind === "done") expect(res.snapshot.status).toBe("kyc_failed");
    // kyc_failed es terminal: no se puede re-cotizar tras un KYC rechazado
    await expect(lock.execute({ remittanceId: id })).rejects.toThrow(/invalid_transition/);
  });

  it("no se puede startKyc antes de cotizar (WKH-187: created→kyc_pending inválido)", async () => {
    const { create, startKyc } = setup();
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    await expect(startKyc.execute(kycInput(r0.snapshot.id))).rejects.toThrow(
      /invalid_transition/,
    );
  });

  // WKH-320: antes este caso forzaba el fallo con un payout status:'failed' (paso 4, inalcanzable
  // post-poda). Se re-cablea sobre el settle, que es donde vive hoy el fallo del money-path.
  //
  // ⚠️ LEER LA CONDICIÓN: este caso corre con un adapter de refund que SÍ devuelve un comprobante
  // ("refund-fake"). Ése es el único escenario que autoriza `refunded`. El adapter que corre en
  // PRODUCCIÓN (LedgerRefundGateway) no revierte nada y devuelve null, así que ahí la remesa se queda
  // en payout_failed (recuperable) y sin ninguna referencia de reembolso. Ese otro caso está
  // cubierto en confirm-and-send.money-path.test.ts; no lo leas de acá.
  it("con un adapter que SÍ revierte, el settle falla → refunded, failureReason preservado (WKH-186)", async () => {
    const { create, startKyc, lock, confirm } = setup({
      solanaGateway: new FakeSolanaSettlementGateway({ ok: false, reason: "solana_settle_rejected" }),
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await lock.execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC
    await startKyc.execute(kycInput(id));
    const r = await confirm.execute({ remittanceId: id });
    // Antes de WKH-186 la remesa quedaba clavada en payout_failed; ahora el refund la avanza a
    // refunded en el mismo execute(). markRefunded solo patchea refundTx → failureReason sobrevive.
    expect(r.status).toBe("refunded");
    expect(r.snapshot.failureReason).toBe("solana_settle_rejected");
    expect(r.snapshot.refundTx).toBe("refund-fake");
    expect(r.snapshot.principalTx).toBeNull(); // el depósito no se confirmó ⇒ nunca principal_in
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
    expect(res.address).toBe(FAKE_SOLANA_BENEFICIARY);
    expect(res.rememberedKyc).toBeNull();
    await kycStore.save(FAKE_SOLANA_BENEFICIARY, {
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
    const { create, startKyc, lock } = setup({ kycStore });
    const r1 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    await lock.execute({ remittanceId: r1.snapshot.id }); // WKH-187: cotiza antes del KYC
    await startKyc.execute(kycInput(r1.snapshot.id)); // verifica + guarda en el store
    const r2 = await create.execute({ amountUsd: 200, beneficiary: beneficiary() });
    await lock.execute({ remittanceId: r2.snapshot.id });
    const res = await startKyc.execute({ remittanceId: r2.snapshot.id, address: FAKE_SOLANA_BENEFICIARY });
    expect(res.kind).toBe("done");
    if (res.kind === "done") expect(res.snapshot.status).toBe("kyc_passed");
  });

  it("Didit redirect → resume aplica la decisión y pasa el KYC (flujo móvil)", async () => {
    const { create, startKyc, lock, resumeKyc } = setup({ kyc: new FakeKycGateway({}, true) });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    await lock.execute({ remittanceId: r0.snapshot.id }); // WKH-187: cotiza antes del KYC
    const start = await startKyc.execute({ remittanceId: r0.snapshot.id, address: FAKE_SOLANA_BENEFICIARY });
    expect(start.kind).toBe("redirect"); // te manda a Didit

    const res = await resumeKyc.execute(); // simula el retorno de Didit
    expect(res.kind).toBe("passed");
    if (res.kind === "passed") expect(res.snapshot.status).toBe("kyc_passed");
  });

  it("AC-2: ResumeKyc persiste kyc_passed pese al fallo del cache (kycStore.save lanza)", async () => {
    const { create, startKyc, lock, resumeKyc, repo } = setup({
      kyc: new FakeKycGateway({}, true), // fuerza redirect (path resume)
      kycStore: new ThrowingSaveKycStore(), // save() SIEMPRE lanza
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await lock.execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC
    const start = await startKyc.execute({ remittanceId: id, address: FAKE_SOLANA_BENEFICIARY });
    expect(start.kind).toBe("redirect");

    // ThrowingSaveKycStore.save lanza SIEMPRE (más agresivo que el try/catch del store real): prueba
    // el reorder en aislamiento — repo.save YA corrió antes del kycStore.save que lanza, así que el
    // KYC queda persistido pese a la excepción del cache. Sin el reorder, el repo NO tendría kyc_passed.
    await expect(resumeKyc.execute()).rejects.toThrow(/kyc_store_unavailable/);
    expect((await repo.get(id))?.snapshot.status).toBe("kyc_passed"); // AC-2: persistido en el repo
  });

  it("AC-3: StartKyc completed persiste kyc_passed pese al fallo del cache (kycStore.save lanza)", async () => {
    const { create, startKyc, lock, repo } = setup({
      kycStore: new ThrowingSaveKycStore(), // save() SIEMPRE lanza; FakeKycGateway default → completed
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await lock.execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC
    // rama "completed": repo.save YA corrió antes del kycStore.save que lanza → kyc_passed persistido.
    await expect(startKyc.execute(kycInput(id))).rejects.toThrow(/kyc_store_unavailable/);
    expect((await repo.get(id))?.snapshot.status).toBe("kyc_passed"); // AC-3: persistido en el repo
  });

  it("V1 ⭐ AC-1/2/3: si pending.save falla en el redirect, la remesa NO queda huérfana en kyc_pending", async () => {
    const { create, startKyc, lock, repo } = setup({
      kyc: new FakeKycGateway({}, true), // fuerza redirect
      pending: new ThrowingKycPendingStore(), // save() siempre lanza
    });
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await lock.execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC (created→quoted)
    await expect(
      startKyc.execute({ remittanceId: id, address: FAKE_SOLANA_BENEFICIARY }),
    ).rejects.toThrow(/kyc_pending_unavailable/); // AC-1: re-lanza el Error, no crudo; AC-3: no {kind:"redirect"}
    const persisted = await repo.get(id);
    expect(persisted?.snapshot.status).toBe("quoted"); // AC-2 ⭐ WKH-187: último estado guardado = quoted, NO "kyc_pending"
  });

  it("V1 AC-4: tras un pending que falló, el retry con store sano avanza sin invalid_transition", async () => {
    // repo/clock compartidos para simular fallo → retry sobre la MISMA remesa persistida.
    const repo = new InMemoryRepo();
    const clock = new FixedClock();
    const createShared = new CreateRemittance(repo, clock, new SeqIds());
    const r0 = await createShared.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    await new LockQuote(new FakeQuoteGateway(), repo, clock).execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC

    const kycGw = new FakeKycGateway({}, true);
    const kycStore = new FakeKycStore();
    const failing = new StartKyc(kycGw, kycStore, new ThrowingKycPendingStore(), repo, clock);
    await expect(failing.execute({ remittanceId: id, address: FAKE_SOLANA_BENEFICIARY })).rejects.toThrow();
    expect((await repo.get(id))?.snapshot.status).toBe("quoted"); // WKH-187: último estado guardado = quoted

    const healthy = new StartKyc(kycGw, kycStore, new FakeKycPendingStore(), repo, clock);
    const res = await healthy.execute({ remittanceId: id, address: FAKE_SOLANA_BENEFICIARY }); // quoted→kyc_pending válido
    expect(res.kind).toBe("redirect");
    expect((await repo.get(id))?.snapshot.status).toBe("kyc_pending");
  });

  it("resume sin KYC pendiente → none (carga normal de la app)", async () => {
    const { resumeKyc } = setup();
    expect((await resumeKyc.execute()).kind).toBe("none");
  });

  it("AC-6: tras startKyc, el snapshot persistido queda con ownerAddress == caller.address", async () => {
    const { create, startKyc, lock, repo } = setup();
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    const id = r0.snapshot.id;
    expect(r0.snapshot.ownerAddress).toBeNull(); // creada sin owner
    await lock.execute({ remittanceId: id }); // WKH-187: cotiza antes del KYC
    await startKyc.execute({ remittanceId: id, address: FAKE_SOLANA_BENEFICIARY });
    const saved = await repo.get(id);
    expect(saved?.snapshot.ownerAddress).toBe(FAKE_SOLANA_BENEFICIARY);
  });

  it("AC-12: flujo fallback (sin sandbox Didit) queda verde con identity REDUCIDA presente", async () => {
    const repo = new InMemoryRepo();
    const clock = new FixedClock();
    const ids = new SeqIds();
    const create = new CreateRemittance(repo, clock, ids);
    const startKyc = new StartKyc(
      new FallbackKycGateway(),
      new FakeKycStore(),
      new FakeKycPendingStore(),
      repo,
      clock,
    );
    const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
    await new LockQuote(new FakeQuoteGateway(), repo, clock).execute({ remittanceId: r0.snapshot.id }); // WKH-187: cotiza antes del KYC
    const res = await startKyc.execute({ remittanceId: r0.snapshot.id, address: FAKE_SOLANA_BENEFICIARY });
    expect(res.kind).toBe("done");
    if (res.kind === "done") {
      expect(res.snapshot.status).toBe("kyc_passed");
      const idn = res.snapshot.kyc?.identity;
      expect(idn?.firstName).toBe("María Elena"); // fixture demo preservado (AC-12)
      expect(idn?.documentNumberLast4).toBe("6677"); // reducida
      expect(idn && "documentNumber" in idn).toBe(false); // sin PII cruda
    }
  });
});
