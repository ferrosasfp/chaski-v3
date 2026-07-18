// Tests — ConfirmAndSend en MODO DEMO (WKH-211 W4.2, AC-5). settlement === undefined ⇒ flujo pre-HU
// byte-idéntico: llama payouts.submit, SIN prepare, sin deposit en la firma. El reorder no-custodial es
// código muerto sin el 7º arg (POR CONSTRUCCIÓN, el use-case nunca lee env — CD-14).
import { describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import { type KycVerification, type Quote, Remittance } from "../../domain/remittance";
import {
  FakePayoutAuthorityGateway,
  FakePayoutGateway,
  FakeRefundGateway,
  FakeWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
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
async function seedQuoted(repo: InMemoryRepo): Promise<string> {
  const r = Remittance.create("r-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0);
  r.startKyc(T0, "0xSender");
  r.applyKyc(passKyc, T0);
  await repo.save(r);
  return "r-1";
}

describe("ConfirmAndSend — demo byte-idéntico (WKH-211 AC-5)", () => {
  it("AC-5: settlement === undefined ⇒ llama payouts.submit, authorizePrincipal SIN 3er arg deposit", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeWallet(); // demo: sin eip3009
    const payouts = new FakePayoutGateway();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const submitSpy = vi.spyOn(payouts, "submit");
    const id = await seedQuoted(repo);

    // Sin 7º arg (settlement) ⇒ modo demo.
    const out = await new ConfirmAndSend(
      wallet,
      payouts,
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      new FakeRefundGateway(),
    ).execute({ remittanceId: id });

    // El submit del payout SÍ se llama (a diferencia del modo real, DT-7).
    expect(submitSpy).toHaveBeenCalledTimes(1);
    // authorizePrincipal se llamó SIN 3er arg deposit (undefined) ⇒ path signMessage demo.
    expect(authorizeSpy).toHaveBeenCalledTimes(1);
    expect(authorizeSpy.mock.calls[0]![2]).toBeUndefined();
    // El submit NO recibe ningún artefacto de prepare/deposit.
    expect(submitSpy.mock.calls[0]![0]).not.toHaveProperty("depositAttestation");
    expect(out.snapshot.status).toBe("payout_submitted");
    expect(out.snapshot.principalTx).toBe("0xprincipal"); // demo: firma simbólica, byte-idéntico
  });
});
