// Tests — ConfirmAndSend REORDER no-custodial (WKH-211 W4.2, AC-1/AC-7). Modo real:
// prepare → firmar(to=depositAddress) → settle(depositAttestation) → markPayoutSubmitted(payoutId de
// prepare). Todo mockeado (AC-4/CD-1): cero orden real, cero on-chain real.
import { describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import { type KycVerification, type Quote, Remittance } from "../../domain/remittance";
import {
  FAKE_DEPOSIT_ADDRESS,
  FAKE_SETTLE_TX,
  FakePayoutAuthorityGateway,
  FakePayoutGateway,
  FakePayoutPrepareGateway,
  FakeRefundGateway,
  FakeSettlementGateway,
  FakeWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  beneficiary,
} from "../../test-support/fakes";
import type { Eip3009Authorization } from "../ports";
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
const SENDER = "0x1111111111111111111111111111111111111111";
const authorization: Eip3009Authorization = {
  from: SENDER,
  to: FAKE_DEPOSIT_ADDRESS,
  value: "400000000",
  validAfter: "0",
  validBefore: "1783036800",
  nonce: "0xbbbb000000000000000000000000000000000000000000000000000000000002",
};
function realWallet(): FakeWallet {
  return new FakeWallet({ authorization, signature: "0xSIG" });
}
function okSettle() {
  return new FakeSettlementGateway({
    ok: true,
    txHash: FAKE_SETTLE_TX,
    valueMinor: 400_000_000,
    to: FAKE_DEPOSIT_ADDRESS, // el `to` verificado = depositAddress atestado ⇒ C5 matchea
    from: SENDER,
    attestation: "att-fake",
  });
}
async function seedQuoted(repo: InMemoryRepo): Promise<string> {
  const r = Remittance.create("r-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0);
  r.startKyc(T0, SENDER);
  r.applyKyc(passKyc, T0);
  await repo.save(r);
  return "r-1";
}

describe("ConfirmAndSend — reorder no-custodial (WKH-211)", () => {
  it("AC-1: orden = prepare → authorizePrincipal → settle; el `to` firmado es el depositAddress de prepare", async () => {
    const repo = new InMemoryRepo();
    const wallet = realWallet();
    const prepare = new FakePayoutPrepareGateway();
    const gateway = okSettle();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const prepareSpy = vi.spyOn(prepare, "prepare");
    const settleSpy = vi.spyOn(gateway, "settle");
    const id = await seedQuoted(repo);

    await new ConfirmAndSend(
      wallet,
      new FakePayoutGateway(),
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      new FakeRefundGateway(),
      { gateway, prepare },
    ).execute({ remittanceId: id });

    // Orden real de invocación: prepare ANTES de firmar ANTES de settle.
    expect(prepareSpy.mock.invocationCallOrder[0]!).toBeLessThan(authorizeSpy.mock.invocationCallOrder[0]!);
    expect(authorizeSpy.mock.invocationCallOrder[0]!).toBeLessThan(settleSpy.mock.invocationCallOrder[0]!);
    // AC-1: authorizePrincipal recibió el depositAddress de prepare como 3er arg (to = depositAddress).
    expect(authorizeSpy.mock.calls[0]![2]).toEqual({ address: FAKE_DEPOSIT_ADDRESS });
    // El binding HMAC de prepare viaja al settle.
    expect(settleSpy.mock.calls[0]![0].depositAttestation).toBe("deposit-att-fake");
  });

  it("AC-7: prepare !ok ⇒ failAndRefund SIN authorizePrincipal (la wallet NUNCA firma un `to` no confirmado)", async () => {
    const repo = new InMemoryRepo();
    const wallet = realWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const gateway = okSettle();
    const settleSpy = vi.spyOn(gateway, "settle");
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    const refund = new FakeRefundGateway();
    const id = await seedQuoted(repo);
    // prepare devuelve !ok (agente caído / depositAddress null server-side).
    const prepare = new FakePayoutPrepareGateway({ ok: false, reason: "prepare_no_deposit_address" });

    const out = await new ConfirmAndSend(
      wallet,
      payouts,
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      refund,
      { gateway, prepare },
    ).execute({ remittanceId: id });

    expect(authorizeSpy).not.toHaveBeenCalled(); // AC-7: NUNCA se pidió la firma
    expect(settleSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
    expect(out.snapshot.principalTx).toBeNull(); // el principal NUNCA entró
    expect(out.snapshot.failureReason).toBe("prepare_no_deposit_address");
    expect(refund.calls[0]?.reason).toBe("prepare_no_deposit_address");
  });

  it("AC-7: prepare TIRA (red/bug) ⇒ fail-closed prepare_unavailable, SIN firma ni settle", async () => {
    const repo = new InMemoryRepo();
    const wallet = realWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const id = await seedQuoted(repo);
    const prepare = new FakePayoutPrepareGateway(undefined, "reject"); // prepare() throw

    const out = await new ConfirmAndSend(
      wallet,
      new FakePayoutGateway(),
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      new FakeRefundGateway(),
      { gateway: okSettle(), prepare },
    ).execute({ remittanceId: id });

    expect(authorizeSpy).not.toHaveBeenCalled();
    expect(out.snapshot.principalTx).toBeNull();
    expect(out.snapshot.failureReason).toBe("prepare_unavailable");
  });

  it("DT-7: modo real NO llama payouts.submit; marca payout_submitted con el payoutId de prepare", async () => {
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
      { gateway: okSettle(), prepare: new FakePayoutPrepareGateway() },
    ).execute({ remittanceId: id });

    expect(submitSpy).not.toHaveBeenCalled(); // DT-7
    expect(out.snapshot.status).toBe("payout_submitted");
    expect(out.snapshot.principalTx).toBe(FAKE_SETTLE_TX); // markPrincipalIn SOLO tras V1-V9 (CD-6)
  });

  it("C5: settle ok pero res.to ≠ depositAddress de prepare ⇒ settlement_receiver_mismatch, sin principal_in", async () => {
    const repo = new InMemoryRepo();
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    const id = await seedQuoted(repo);
    // el settle reporta un `to` distinto del depositAddress atestado (drift cliente↔server).
    const gateway = new FakeSettlementGateway({
      ok: true,
      txHash: FAKE_SETTLE_TX,
      valueMinor: 400_000_000,
      to: "0x9999999999999999999999999999999999999999",
      from: SENDER,
      attestation: "att-fake",
    });

    const out = await new ConfirmAndSend(
      realWallet(),
      payouts,
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      new FakeRefundGateway(),
      { gateway, prepare: new FakePayoutPrepareGateway() },
    ).execute({ remittanceId: id });

    expect(out.snapshot.principalTx).toBeNull();
    expect(out.snapshot.failureReason).toBe("settlement_receiver_mismatch");
    expect(submitSpy).not.toHaveBeenCalled();
  });
});
