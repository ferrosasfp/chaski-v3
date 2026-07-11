import { describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import { type KycVerification, type Quote, Remittance } from "../../domain/remittance";
import {
  FakePayoutAuthorityGateway,
  FakePayoutGateway,
  FakeWallet,
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
  r.startKyc(T0, "0xSender");
  r.applyKyc(kyc, T0);
  r.attachQuote(quote, T0);
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

    const out = await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority).execute({
      remittanceId: id,
    });

    expect(out.status).toBe("payout_failed");
    expect(out.snapshot.failureReason).toBe("kyc_not_approved");
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

    const out = await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority).execute({
      remittanceId: id,
    });

    expect(out.status).toBe("payout_failed");
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

    const out = await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority).execute({
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

    const out = await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority).execute({
      remittanceId: id,
    });

    expect(out.status).toBe("settled");
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
    const out = await new ConfirmAndSend(wallet, payouts, repo, clock, authority).execute({
      remittanceId: id,
    });

    expect(out.status).toBe("payout_failed");
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
    const out = await new ConfirmAndSend(wallet, payouts, repo, clock, authority).execute({
      remittanceId: id,
    });

    expect(out.status).toBe("payout_failed");
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

    await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority).execute({
      remittanceId: id,
    });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const arg = submitSpy.mock.calls[0]?.[0];
    expect(arg?.expectedReceivePen).toEqual(Money.of(1480, "PEN"));
    expect(arg?.amountUsd).toBe(400); // amountUsd preservado (no reemplazado)
  });
});
