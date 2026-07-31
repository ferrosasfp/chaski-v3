// Tests — ConfirmAndSend: los guards que corren ANTES de tocar el money-path.
//
// Alcance de este archivo: SÓLO los guards previos (identidad verificada, autoridad de payout,
// vigencia de la cotización). El paso `payouts.submit` NO se ejerce acá porque es estructuralmente
// inalcanzable: sin `solana` inyectado el use-case corta en el tapón fail-closed DT-8, probado en
// confirm-and-send.money-path.test.ts. DT-11: el port PayoutGateway sigue vivo — TrackRemittance usa
// `payouts.status()`.
//
// El camino completo (prepare → firma → settle) se prueba en confirm-and-send.money-path.test.ts, y el
// ORDEN de sus guards en confirm-and-send.reorder.test.ts.
import { describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import { type KycVerification, type Quote, Remittance } from "../../domain/remittance";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakePayoutAuthorityGateway,
  FakeRefundGateway,
  FakeSolanaWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  ScriptedClock,
  T0,
  beneficiary,
} from "../../test-support/fakes";
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
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY); // quoted→kyc_pending
  r.applyKyc(kyc, T0); // kyc_pending→kyc_passed (quote sobrevive)
  await repo.save(r);
  return "r-1";
}

describe("ConfirmAndSend — enforcement autoridad server-side (WKH-180)", () => {
  it("AC-1/AC-2/AC-6: authority false → payout_failed, NO se le pide la firma a la wallet", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const authority = new FakePayoutAuthorityGateway({
      authorized: false,
      reason: "kyc_not_approved",
    });
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      authority,
      new FakeRefundGateway(),
    ).execute({ remittanceId: id });

    // WKH-186: refund-on-failure avanza payout_failed → refunded en el mismo execute(); failureReason
    // sobrevive (markRefunded solo patchea refundTx). El guard de WKH-180 sigue intacto: NO firma.
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("kyc_not_approved");
    expect(out.snapshot.refundTx).toBe("refund-fake");
    expect(out.snapshot.principalTx).toBeNull();
    expect(authorizeSpy).not.toHaveBeenCalled();
    // La autoridad recibió el verificationId real + la address del caller.
    expect(authority.calls).toEqual([{ verificationId: "v-1", address: FAKE_SOLANA_BENEFICIARY }]);
  });

  it("AC-6: kyc.approved:true FORJADO pero authority false → bloqueado (override server-side gana)", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    // El estado client-side dice approved:true/payoutAllowed:true (como si localStorage estuviera forjado).
    const forged: KycVerification = { ...passKyc, approved: true, payoutAllowed: true };
    const authority = new FakePayoutAuthorityGateway({
      authorized: false,
      reason: "kyc_ownership_mismatch",
    });
    const id = await seedQuoted(repo, forged);

    const out = await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      authority,
      new FakeRefundGateway(),
    ).execute({ remittanceId: id });

    expect(out.status).toBe("refunded"); // WKH-186: refund-on-failure; override server-side igual gana
    expect(out.snapshot.failureReason).toBe("kyc_ownership_mismatch");
    expect(authorizeSpy).not.toHaveBeenCalled();
  });
});

describe("ConfirmAndSend — re-check de vigencia del quote (M2/AC-5)", () => {
  it("AC-5: el quote vence ENTRE confirm y la firma (ScriptedClock) → refunded, SIN firma", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const authority = new FakePayoutAuthorityGateway({ authorized: true }); // aísla el guard de expiry
    const id = await seedQuoted(repo);

    // 1ª llamada (confirm) = T0 válido; 2ª (re-check) = 18:11 > QUOTE_EXPIRES (18:10).
    const clock = new ScriptedClock([T0, "2026-07-09T18:11:00.000Z"]);
    const out = await new ConfirmAndSend(
      wallet,
      repo,
      clock,
      authority,
      new FakeRefundGateway(),
    ).execute({ remittanceId: id });

    expect(out.status).toBe("refunded"); // WKH-186: refund-on-failure; guard de expiry intacto
    expect(out.snapshot.failureReason).toBe("quote_expired_before_submit");
    expect(out.snapshot.principalTx).toBeNull();
    expect(authorizeSpy).not.toHaveBeenCalled();
  });
});

describe("ConfirmAndSend — refund-on-failure best-effort (WKH-186 AC-7)", () => {
  // Se conserva el invariante, re-cableado sobre un camino que SÍ existe: antes se ejercitaba con un
  // payout con status 'failed' (paso 4, inalcanzable post-poda); ahora con el guard de autoridad.
  it("AC-7: si el credit-back falla (reject) la remesa queda en payout_failed, y execute NO lanza", async () => {
    const repo = new InMemoryRepo();
    const authority = new FakePayoutAuthorityGateway({ authorized: false, reason: "partner_down" });
    const refund = new FakeRefundGateway("reject");
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(
      new FakeSolanaWallet(),
      repo,
      new FixedClock(),
      authority,
      refund,
    ).execute({ remittanceId: id });

    expect(out.status).toBe("payout_failed"); // best-effort: NO escala a refunded ni tira
    expect(out.snapshot.failureReason).toBe("partner_down");
    expect(out.snapshot.refundTx).toBeNull();
  });

  it("AC-7: el credit-back recibe el monto ENVIADO de la remesa, no otro", async () => {
    const repo = new InMemoryRepo();
    const authority = new FakePayoutAuthorityGateway({
      authorized: false,
      reason: "kyc_not_approved",
    });
    const refund = new FakeRefundGateway();
    const id = await seedQuoted(repo);

    await new ConfirmAndSend(
      new FakeSolanaWallet(),
      repo,
      new FixedClock(),
      authority,
      refund,
    ).execute({ remittanceId: id });

    expect(refund.calls).toHaveLength(1);
    expect(refund.calls[0]?.amountUsd).toEqual(Money.of(400, "USDC"));
    expect(refund.calls[0]?.remittanceId).toBe("r-1");
  });
});

describe("ConfirmAndSend — invariantes de entrada", () => {
  it("remesa inexistente → throw remittance_not_found (no devuelve algo a medias)", async () => {
    const repo = new InMemoryRepo();
    await expect(
      new ConfirmAndSend(
        new FakeSolanaWallet(),
        repo,
        new FixedClock(),
        new FakePayoutAuthorityGateway({ authorized: true }),
        new FakeRefundGateway(),
      ).execute({ remittanceId: "no-existe" }),
    ).rejects.toThrow("remittance_not_found");
  });
});
