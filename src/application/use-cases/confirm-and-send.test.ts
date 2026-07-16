import { describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import { type KycVerification, type Quote, Remittance } from "../../domain/remittance";
import {
  FAKE_RECEIVER,
  FAKE_SETTLE_TX,
  FakePayoutAuthorityGateway,
  FakePayoutGateway,
  FakeRefundGateway,
  FakeSettlementGateway,
  FakeWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  ScriptedClock,
  T0,
  beneficiary,
} from "../../test-support/fakes";
import type { Eip3009Authorization, SettlementFailureReason } from "../ports";
import { ConfirmAndSend } from "./confirm-and-send";

const passKyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true,
  riskLevel: "low",
  provenance: "didit",
  identity: null,
};
const quote: Quote = {
  quoteId: "q1",
  send: Money.of(400, "USDC"),
  receive: Money.of(1480, "PEN"),
  feeUsd: Money.of(0.5, "USDC"),
  rate: 3.7,
  etaMinutes: 30,
  expiresAt: QUOTE_EXPIRES,
  provenance: "fake",
};

// Construye una remesa lista para confirm() (estado "quoted" con KYC pasado + quote válido).
async function seedQuoted(repo: InMemoryRepo, kyc: KycVerification = passKyc): Promise<string> {
  const r = Remittance.create("r-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0); // WKH-187: cotiza antes del KYC (created→quoted)
  r.startKyc(T0, "0xSender"); // quoted→kyc_pending
  r.applyKyc(kyc, T0); // kyc_pending→kyc_passed (quote sobrevive)
  await repo.save(r);
  return "r-1";
}

describe("ConfirmAndSend — enforcement autoridad server-side (WKH-180)", () => {
  it("AC-1/AC-2/AC-6: authority false → payout_failed, submit + authorizePrincipal NOT called", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeWallet();
    const payouts = new FakePayoutGateway();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const submitSpy = vi.spyOn(payouts, "submit");
    const authority = new FakePayoutAuthorityGateway({ authorized: false, reason: "kyc_not_approved" });
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority, new FakeRefundGateway()).execute({
      remittanceId: id,
    });

    // WKH-186: refund-on-failure avanza payout_failed → refunded en el mismo execute(); failureReason
    // sobrevive (markRefunded solo patchea refundTx). Los guards de WKH-180 siguen intactos: NO firma, NO submit.
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("kyc_not_approved");
    expect(out.snapshot.refundTx).toBe("refund-fake");
    expect(authorizeSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
    // La autoridad recibió el verificationId real + la address del caller.
    expect(authority.calls).toEqual([{ verificationId: "v-1", address: "0xSender" }]);
  });

  it("AC-6: kyc.approved:true FORJADO pero authority false → bloqueado (override server-side gana)", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeWallet();
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    // El estado client-side dice approved:true/payoutAllowed:true (como si localStorage estuviera forjado).
    const forged: KycVerification = { ...passKyc, approved: true, payoutAllowed: true };
    const authority = new FakePayoutAuthorityGateway({ authorized: false, reason: "kyc_ownership_mismatch" });
    const id = await seedQuoted(repo, forged);

    const out = await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority, new FakeRefundGateway()).execute({
      remittanceId: id,
    });

    expect(out.status).toBe("refunded"); // WKH-186: refund-on-failure; override server-side igual gana
    expect(out.snapshot.failureReason).toBe("kyc_ownership_mismatch");
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("AC-1: authority true → flujo completo → submit llamado → payout_submitted (regresión demo)", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeWallet();
    const payouts = new FakePayoutGateway();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const submitSpy = vi.spyOn(payouts, "submit");
    const authority = new FakePayoutAuthorityGateway({ authorized: true }); // default dev sin key
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority, new FakeRefundGateway()).execute({
      remittanceId: id,
    });

    expect(authorizeSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("payout_submitted");
    expect(out.snapshot.principalTx).toBe("0xprincipal");
  });

  it("authority true + payout settled → settled (happy path completo)", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeWallet();
    const payouts = new FakePayoutGateway({ status: "settled", txRef: "0xdelivered", deliveredPen: Money.of(1480, "PEN") });
    const authority = new FakePayoutAuthorityGateway({ authorized: true });
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority, new FakeRefundGateway()).execute({
      remittanceId: id,
    });

    expect(out.status).toBe("settled");
  });

  it("T-AC5d: propaga la provenance del payout al snapshot (payout mock → local-fallback)", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeWallet();
    const payouts = new FakePayoutGateway(
      { status: "settled", txRef: "0xdelivered", deliveredPen: Money.of(1480, "PEN"), provenance: "local-fallback" },
    );
    const authority = new FakePayoutAuthorityGateway({ authorized: true });
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority, new FakeRefundGateway()).execute({
      remittanceId: id,
    });

    expect(out.status).toBe("settled");
    expect(out.snapshot.payoutProvenance).toBe("local-fallback");
  });
});

describe("ConfirmAndSend — expiry re-check M2 + payload M3 (AC-5/AC-6)", () => {
  it("AC-5: quote vence ENTRE confirm y submit (ScriptedClock) → payout_failed, sin firma ni submit", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeWallet();
    const payouts = new FakePayoutGateway();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const submitSpy = vi.spyOn(payouts, "submit");
    const authority = new FakePayoutAuthorityGateway({ authorized: true }); // autoridad OK: aísla el guard de expiry
    const id = await seedQuoted(repo);

    // 1ª llamada (confirm) = T0 válido; 2ª (re-check) = 18:11 > QUOTE_EXPIRES (18:10).
    const clock = new ScriptedClock([T0, "2026-07-09T18:11:00.000Z"]);
    const out = await new ConfirmAndSend(wallet, payouts, repo, clock, authority, new FakeRefundGateway()).execute({
      remittanceId: id,
    });

    expect(out.status).toBe("refunded"); // WKH-186: refund-on-failure; guard de expiry intacto
    expect(out.snapshot.failureReason).toBe("quote_expired_before_submit");
    expect(authorizeSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("MNR-A: válido en el 1er check pero vence DURANTE la firma → payout_failed, firma SÍ ocurre, submit NO", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeWallet();
    const payouts = new FakePayoutGateway();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const submitSpy = vi.spyOn(payouts, "submit");
    const authority = new FakePayoutAuthorityGateway({ authorized: true }); // aísla el 2º guard de expiry
    const id = await seedQuoted(repo);

    // Reloj: confirm=T0, 1er re-check=T0 (válido, pasa la firma), markPrincipalIn=T0,
    // 2º re-check (nowBeforeSubmit) = 18:11 > QUOTE_EXPIRES (18:10) → venció DURANTE la firma.
    const clock = new ScriptedClock([T0, T0, T0, "2026-07-09T18:11:00.000Z"]);
    const out = await new ConfirmAndSend(wallet, payouts, repo, clock, authority, new FakeRefundGateway()).execute({
      remittanceId: id,
    });

    expect(out.status).toBe("refunded"); // WKH-186: principal adentro → refund-on-failure lo cierra
    expect(out.snapshot.failureReason).toBe("quote_expired_before_submit");
    expect(authorizeSpy).toHaveBeenCalledTimes(1); // la firma SÍ ocurrió (ventana larga)
    expect(submitSpy).not.toHaveBeenCalled(); // pero NO se submitea sobre un quote muerto
    expect(out.snapshot.principalTx).toBe("0xprincipal"); // principal ya adentro → refund path
  });

  it("AC-6: happy path → submit recibe expectedReceivePen == quote.receive (Money PEN lockeado)", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeWallet();
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    const authority = new FakePayoutAuthorityGateway({ authorized: true });
    const id = await seedQuoted(repo);

    await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority, new FakeRefundGateway()).execute({
      remittanceId: id,
    });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const arg = submitSpy.mock.calls[0]?.[0];
    expect(arg?.expectedReceivePen).toEqual(Money.of(1480, "PEN"));
    expect(arg?.amountUsd).toBe(400); // amountUsd preservado (no reemplazado)
  });

  it("WKH-202/DT-2: submit recibe el address del wallet (el server re-valida ownership vs Didit)", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeWallet();
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    const authority = new FakePayoutAuthorityGateway({ authorized: true });
    const id = await seedQuoted(repo);

    await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority, new FakeRefundGateway()).execute({
      remittanceId: id,
    });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const arg = submitSpy.mock.calls[0]?.[0];
    expect(arg?.address).toBe("0xSender"); // sin esto la route rechaza con 400 (fail-closed)
  });
});

describe("ConfirmAndSend — reconciliación + refund-on-failure (WKH-186 AC-6/AC-7)", () => {
  it("AC-6: submit settled con deliveredPen FUERA de tolerancia → refunded payout_amount_mismatch, NUNCA settled", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeWallet();
    // receive lockeado = 1480 PEN (tol 14.8); delivered 368 → mismatch grueso.
    const payouts = new FakePayoutGateway({ status: "settled", txRef: "0xbad", deliveredPen: Money.of(368, "PEN") });
    const authority = new FakePayoutAuthorityGateway({ authorized: true });
    const refund = new FakeRefundGateway();
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority, refund).execute({
      remittanceId: id,
    });

    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("payout_amount_mismatch");
    expect(out.snapshot.refundTx).toBe("refund-fake");
    expect(refund.calls[0]?.amountUsd).toEqual(Money.of(400, "USDC"));
  });

  it("AC-6: submit settled con deliveredPen DENTRO de tolerancia → settled (sin refund)", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeWallet();
    const payouts = new FakePayoutGateway({ status: "settled", txRef: "0xok", deliveredPen: Money.of(1480, "PEN") });
    const authority = new FakePayoutAuthorityGateway({ authorized: true });
    const refund = new FakeRefundGateway();
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority, refund).execute({
      remittanceId: id,
    });

    expect(out.status).toBe("settled");
    expect(refund.calls).toHaveLength(0);
  });

  it("AC-7: submit lanza (partner caído) → catch → refunded, creditBack llamado en el mismo execute()", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeWallet();
    const payouts = new FakePayoutGateway();
    vi.spyOn(payouts, "submit").mockRejectedValueOnce(new Error("a2a_payout_unavailable"));
    const authority = new FakePayoutAuthorityGateway({ authorized: true });
    const refund = new FakeRefundGateway();
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority, refund).execute({
      remittanceId: id,
    });

    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("a2a_payout_unavailable");
    expect(refund.calls).toHaveLength(1);
  });

  it("AC-7: submit status failed → refunded, failureReason preservado", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeWallet();
    const payouts = new FakePayoutGateway({ status: "failed", failureReason: "partner_down" });
    const authority = new FakePayoutAuthorityGateway({ authorized: true });
    const refund = new FakeRefundGateway();
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority, refund).execute({
      remittanceId: id,
    });

    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("partner_down");
  });

  it("AC-7: refund falla (reject) → queda en payout_failed (best-effort, no throw)", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeWallet();
    const payouts = new FakePayoutGateway({ status: "failed", failureReason: "partner_down" });
    const authority = new FakePayoutAuthorityGateway({ authorized: true });
    const refund = new FakeRefundGateway("reject");
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority, refund).execute({
      remittanceId: id,
    });

    expect(out.status).toBe("payout_failed");
    expect(out.snapshot.failureReason).toBe("partner_down");
    expect(out.snapshot.refundTx).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WKH-168 W5.2 — settle REAL del principal (ramas C1-C8).
//
// El bug que esto mata: `markPrincipalIn(tx)` marcaba "plata adentro" con una FIRMA. Nadie
// transmitía nada, nadie esperaba un receipt → el payout salía sobre dinero que podía no existir.
// Modo real ⇔ el 7º arg (settlement) está inyectado; sin él, TODO queda byte-idéntico (AC-5).
// ─────────────────────────────────────────────────────────────────────────────

const SENDER = "0x1111111111111111111111111111111111111111";
const authorization: Eip3009Authorization = {
  from: SENDER,
  to: FAKE_RECEIVER,
  value: "400000000",
  validAfter: "0",
  validBefore: "1783036800",
  nonce: "0xbbbb000000000000000000000000000000000000000000000000000000000002",
};
const eip3009 = { authorization, signature: "0xSIGNATURE_CRUDA" };

/** Wallet en modo REAL: devuelve el payload EIP-3009 además del tx (como InjectedWallet con el flag on). */
function realWallet(): FakeWallet {
  return new FakeWallet(eip3009);
}

// AR/MNR-4 + CR/MNR-2: el 7º arg es `{ gateway, receiver }`. El receiver se INYECTA (antes el
// use-case lo leía de process.env vía infrastructure/chain) ⇒ estos tests unitarios volvieron a ser
// env-free: cero stubEnv, cero unstubAllEnvs. Es SETUP: ningún assert cambió.
function realMode(gateway: FakeSettlementGateway, receiver: `0x${string}` = FAKE_RECEIVER) {
  return { gateway, receiver };
}

function okSettle(over: Partial<{ txHash: string; valueMinor: number; to: string }> = {}) {
  return new FakeSettlementGateway({
    ok: true,
    txHash: FAKE_SETTLE_TX,
    valueMinor: 400_000_000,
    to: FAKE_RECEIVER,
    from: SENDER,
    attestation: "att-fake",
    ...over,
  });
}

describe("ConfirmAndSend — settle real del principal (WKH-168, C1-C6)", () => {
  it("AC-1: modo real ⇒ settle() recibe la AUTORIZACIÓN COMPLETA (no solo la firma) + el expectedValueMinor", async () => {
    const repo = new InMemoryRepo();
    const settlement = okSettle();
    const id = await seedQuoted(repo);
    await new ConfirmAndSend(
      realWallet(),
      new FakePayoutGateway(),
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      new FakeRefundGateway(),
      realMode(settlement),
    ).execute({ remittanceId: id });

    expect(settlement.calls).toHaveLength(1);
    expect(settlement.calls[0]?.authorization).toEqual(authorization);
    expect(settlement.calls[0]?.signature).toBe("0xSIGNATURE_CRUDA");
    expect(settlement.calls[0]?.expectedValueMinor).toBe(400_000_000); // del QUOTE, no del caller
    expect(settlement.calls[0]?.quoteId).toBe("q1");
  });

  it("AC-4/C6: happy real ⇒ principalTx es el HASH VERIFICADO on-chain, NUNCA la firma cruda", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    const out = await new ConfirmAndSend(
      realWallet(),
      new FakePayoutGateway(),
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      new FakeRefundGateway(),
      realMode(okSettle()),
    ).execute({ remittanceId: id });

    expect(out.snapshot.principalTx).toBe(FAKE_SETTLE_TX);
    expect(out.snapshot.principalTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out.snapshot.principalTx).not.toBe("0xSIGNATURE_CRUDA"); // ← el bug que la HU mata
    expect(out.snapshot.principalTx).not.toBe("0xprincipal");
  });

  it("AC-10: la atestación del settle se forwardea al submit del payout", async () => {
    const repo = new InMemoryRepo();
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    const id = await seedQuoted(repo);
    await new ConfirmAndSend(
      realWallet(),
      payouts,
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      new FakeRefundGateway(),
      realMode(okSettle()),
    ).execute({ remittanceId: id });

    expect(submitSpy.mock.calls[0]?.[0].settlementAttestation).toBe("att-fake");
  });

  it("C1: modo real pero la wallet NO devolvió eip3009 (invariante rota) ⇒ payout_failed, NUNCA principal_in", async () => {
    const repo = new InMemoryRepo();
    const settlement = okSettle();
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    const id = await seedQuoted(repo);
    // FakeWallet SIN eip3009 = la wallet demo. En modo real eso es una invariante rota: fail-loud.
    const out = await new ConfirmAndSend(
      new FakeWallet(),
      payouts,
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      new FakeRefundGateway(),
      realMode(settlement),
    ).execute({ remittanceId: id });

    expect(out.snapshot.principalTx).toBeNull();
    expect(out.snapshot.failureReason).toBe("settlement_unverified");
    expect(settlement.calls).toHaveLength(0); // nada que transmitir
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("AC-3/C2: cada SettlementFailureReason ⇒ payout_failed, principalTx null, submit NO llamado, creditBack sí", async () => {
    const reasons: SettlementFailureReason[] = [
      "settlement_unavailable",
      "settlement_rejected",
      "settlement_amount_mismatch",
      "settlement_receiver_mismatch",
      "settlement_reverted",
      "settlement_unverified",
    ];
    for (const reason of reasons) {
      const repo = new InMemoryRepo();
      const payouts = new FakePayoutGateway();
      const submitSpy = vi.spyOn(payouts, "submit");
      const refund = new FakeRefundGateway();
      const id = await seedQuoted(repo);
      const out = await new ConfirmAndSend(
        realWallet(),
        payouts,
        repo,
        new FixedClock(),
        new FakePayoutAuthorityGateway(),
        refund,
        realMode(new FakeSettlementGateway({ ok: false, reason })),
      ).execute({ remittanceId: id });

      expect(out.snapshot.principalTx).toBeNull(); // AC-3: NUNCA principal_in
      expect(out.snapshot.failureReason).toBe(reason);
      expect(submitSpy).not.toHaveBeenCalled(); // el payout NO se dispara sin plata
      expect(refund.calls[0]?.reason).toBe(reason);
    }
  });

  it("AC-3/C3: settle() THROW (red/bug) ⇒ settlement_unavailable, principalTx null, ninguna excepción escapa", async () => {
    const repo = new InMemoryRepo();
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    const id = await seedQuoted(repo);
    const throwing = new FakeSettlementGateway(undefined, "reject");

    const out = await new ConfirmAndSend(
      realWallet(),
      payouts,
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      new FakeRefundGateway(),
      realMode(throwing),
    ).execute({ remittanceId: id });

    expect(out.snapshot.principalTx).toBeNull();
    expect(out.snapshot.failureReason).toBe("settlement_unavailable");
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("AC-2/C4: settle ok pero valueMinor ≠ quote.send.minor ⇒ amount_mismatch, markPrincipalIn NUNCA llamado", async () => {
    const repo = new InMemoryRepo();
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    const id = await seedQuoted(repo);
    // El settle "exitoso" reporta 1 micro-USDC: el use-case NO puede creerle.
    const out = await new ConfirmAndSend(
      realWallet(),
      payouts,
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      new FakeRefundGateway(),
      realMode(okSettle({ valueMinor: 1 })),
    ).execute({ remittanceId: id });

    expect(out.snapshot.principalTx).toBeNull();
    expect(out.snapshot.failureReason).toBe("settlement_amount_mismatch");
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("AC-2/C5: settle ok pero el `to` no es el receiver de env ⇒ receiver_mismatch, sin principal_in", async () => {
    const repo = new InMemoryRepo();
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    const id = await seedQuoted(repo);
    const out = await new ConfirmAndSend(
      realWallet(),
      payouts,
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      new FakeRefundGateway(),
      realMode(okSettle({ to: "0x9999999999999999999999999999999999999999" })),
    ).execute({ remittanceId: id });

    expect(out.snapshot.principalTx).toBeNull();
    expect(out.snapshot.failureReason).toBe("settlement_receiver_mismatch");
    expect(submitSpy).not.toHaveBeenCalled();
  });
});

describe("ConfirmAndSend — marca AC-6 (principal REALMENTE adentro, refund manual)", () => {
  it("AC-6/C7: modo real + quote vencido DURANTE el settle ⇒ principal_settled_refund_manual", async () => {
    const repo = new InMemoryRepo();
    const refund = new FakeRefundGateway();
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    const id = await seedQuoted(repo);
    // Llamadas a nowIso(): 1) confirm 2) re-check 2.5 (válido) 3) markPrincipalIn 4) re-check 3.5
    // (VENCIDO: el quote murió DURANTE el settle, que en real tarda — espera el receipt).
    const clock = new ScriptedClock([T0, T0, T0, "2026-07-09T18:20:00.000Z"]);

    const out = await new ConfirmAndSend(
      realWallet(),
      payouts,
      repo,
      clock,
      new FakePayoutAuthorityGateway(),
      refund,
      realMode(okSettle()),
    ).execute({ remittanceId: id });

    // El principal YA está adentro on-chain: el "refund" del ledger NO lo revierte (DT-8) → la marca
    // dice la verdad en vez de mentir con quote_expired_before_submit.
    expect(out.snapshot.principalTx).toBe(FAKE_SETTLE_TX);
    expect(out.snapshot.failureReason).toBe("principal_settled_refund_manual");
    expect(refund.calls[0]?.reason).toBe("principal_settled_refund_manual");
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("AC-6/C8 + contraste AC-5: payout falla ⇒ real = marca manual; DEMO = el reason de hoy INTACTO", async () => {
    // (a) modo REAL: el principal entró de verdad → marca AC-6.
    const repoR = new InMemoryRepo();
    const refundR = new FakeRefundGateway();
    const idR = await seedQuoted(repoR);
    const outR = await new ConfirmAndSend(
      realWallet(),
      new FakePayoutGateway({ status: "failed", failureReason: "partner_down" }),
      repoR,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      refundR,
      realMode(okSettle()),
    ).execute({ remittanceId: idR });
    expect(outR.snapshot.failureReason).toBe("principal_settled_refund_manual");
    expect(refundR.calls[0]?.reason).toBe("principal_settled_refund_manual");

    // (b) modo DEMO (sin 7º arg): NADA cambia respecto de pre-HU — el reason del partner sobrevive.
    const repoD = new InMemoryRepo();
    const refundD = new FakeRefundGateway();
    const idD = await seedQuoted(repoD);
    const outD = await new ConfirmAndSend(
      new FakeWallet(),
      new FakePayoutGateway({ status: "failed", failureReason: "partner_down" }),
      repoD,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      refundD,
    ).execute({ remittanceId: idD });
    expect(outD.snapshot.failureReason).toBe("partner_down");
    expect(refundD.calls[0]?.reason).toBe("partner_down");
    expect(outD.snapshot.principalTx).toBe("0xprincipal"); // demo byte-idéntico
  });
});
