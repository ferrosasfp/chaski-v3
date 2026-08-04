// Tests — ConfirmAndSend: el ORDEN de los guards del camino no-custodial (WKH-211 / HU-SOL-13).
//
// Orden que se clava: confirm → autoridad → expiry → prepare → authorizePrincipal → settle →
// markPrincipalIn → markPayoutSubmitted. Un guard movido de lugar pone esto rojo.
import { describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import { type KycVerification, type Quote, Remittance } from "../../domain/remittance";
import {
  FAKE_SOLANA_AUTHORITY,
  FAKE_SOLANA_BENEFICIARY,
  FAKE_SOLANA_SIGNATURE,
  FakePayoutAuthorityGateway,
  FakePayoutGateway,
  FakeRefundGateway,
  FakeSolanaEscrowDepositProbe,
  FakeSolanaPayoutPrepareGateway,
  FakeSolanaSenderSolBalanceProbe,
  FakeSolanaSettlementGateway,
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

async function seedQuoted(repo: InMemoryRepo): Promise<string> {
  const r = Remittance.create("r-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0);
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  r.applyKyc(passKyc, T0);
  await repo.save(r);
  return "r-1";
}

describe("ConfirmAndSend — orden de los guards del camino no-custodial (WKH-211 / HU-SOL-13)", () => {
  it("AC-1: orden = prepare → authorizePrincipal → settle; el escrow firmado es el de prepare", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const prepareSpy = vi.spyOn(prepare, "prepare");
    const settleSpy = vi.spyOn(gateway, "settle");
    const id = await seedQuoted(repo);

    await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      new FakeRefundGateway(),
      { prepare, gateway, probe: new FakeSolanaEscrowDepositProbe(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe() },
    ).execute({ remittanceId: id });

    // Orden REAL de invocación: prepare ANTES de firmar ANTES de settle.
    expect(prepareSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      authorizeSpy.mock.invocationCallOrder[0]!,
    );
    expect(authorizeSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      settleSpy.mock.invocationCallOrder[0]!,
    );
    // AC-1: authorizePrincipal recibió el beneficiary+authority RESUELTOS SERVER-SIDE por prepare,
    // nunca algo del body. Si alguien invirtiera la fuente, esto se pone rojo.
    expect(authorizeSpy.mock.calls[0]![2]).toEqual({
      address: FAKE_SOLANA_BENEFICIARY,
      escrow: { beneficiary: FAKE_SOLANA_BENEFICIARY, authority: FAKE_SOLANA_AUTHORITY },
    });
  });

  it("la AUTORIDAD corre ANTES que prepare: authority false ⇒ prepare NUNCA se invoca", async () => {
    const repo = new InMemoryRepo();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const prepareSpy = vi.spyOn(prepare, "prepare");
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(
      new FakeSolanaWallet(),
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway({ authorized: false, reason: "kyc_not_approved" }),
      new FakeRefundGateway(),
      { prepare, gateway: new FakeSolanaSettlementGateway(), probe: new FakeSolanaEscrowDepositProbe(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe() },
    ).execute({ remittanceId: id });

    expect(prepareSpy).not.toHaveBeenCalled(); // no se crea una orden real sin autoridad
    expect(out.snapshot.failureReason).toBe("kyc_not_approved");
  });

  it("el EXPIRY corre ANTES que prepare: quote vencido ⇒ prepare NUNCA se invoca", async () => {
    const repo = new InMemoryRepo();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const prepareSpy = vi.spyOn(prepare, "prepare");
    const id = await seedQuoted(repo);

    const clock = new ScriptedClock([T0, "2026-07-09T18:11:00.000Z"]); // vence en el re-check
    const out = await new ConfirmAndSend(
      new FakeSolanaWallet(),
      repo,
      clock,
      new FakePayoutAuthorityGateway(),
      new FakeRefundGateway(),
      { prepare, gateway: new FakeSolanaSettlementGateway(), probe: new FakeSolanaEscrowDepositProbe(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe() },
    ).execute({ remittanceId: id });

    expect(prepareSpy).not.toHaveBeenCalled();
    expect(out.snapshot.failureReason).toBe("quote_expired_before_submit");
  });

  it("AC-7: prepare !ok ⇒ failAndRefund SIN authorizePrincipal (la wallet NUNCA firma un destino no confirmado)", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const gateway = new FakeSolanaSettlementGateway();
    const settleSpy = vi.spyOn(gateway, "settle");
    const refund = new FakeRefundGateway();
    const id = await seedQuoted(repo);
    // prepare devuelve !ok (agente caído / depositAddress null server-side).
    const prepare = new FakeSolanaPayoutPrepareGateway({
      ok: false,
      reason: "prepare_no_deposit_address",
    });

    const out = await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      refund,
      { prepare, gateway, probe: new FakeSolanaEscrowDepositProbe(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe() },
    ).execute({ remittanceId: id });

    expect(authorizeSpy).not.toHaveBeenCalled(); // AC-7: NUNCA se pidió la firma
    expect(settleSpy).not.toHaveBeenCalled();
    expect(out.snapshot.principalTx).toBeNull(); // el principal NUNCA entró
    expect(out.snapshot.failureReason).toBe("prepare_no_deposit_address");
    expect(refund.calls[0]?.reason).toBe("prepare_no_deposit_address");
  });

  it("DT-7: el camino real NO llama payouts.submit; marca payout_submitted con el payoutId de prepare", async () => {
    const repo = new InMemoryRepo();
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(
      new FakeSolanaWallet(),
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      new FakeRefundGateway(),
      {
        prepare: new FakeSolanaPayoutPrepareGateway(),
        gateway: new FakeSolanaSettlementGateway(),
        probe: new FakeSolanaEscrowDepositProbe(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe(),
      },
    ).execute({ remittanceId: id });

    // DT-7/DT-11: el use-case ya ni recibe el PayoutGateway; este spy no puede dispararse ni por
    // accidente. El PEN lo libera el proveedor al detectar el depósito on-chain.
    expect(submitSpy).not.toHaveBeenCalled();
    expect(out.snapshot.status).toBe("payout_submitted");
    // markPrincipalIn SOLO con la signature VERIFICADA on-chain (CD-6), nunca con la firma cruda.
    expect(out.snapshot.principalTx).toBe(FAKE_SOLANA_SIGNATURE);
  });

  it("markPrincipalIn ocurre DESPUÉS del settle, nunca antes (el orden que la HU vino a proteger)", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    // El settle falla ⇒ si markPrincipalIn corriera antes, la remesa quedaría diciendo "plata
    // adentro" sobre un depósito que nunca se confirmó. Ese es exactamente el bug.
    const gateway = new FakeSolanaSettlementGateway({
      ok: false,
      reason: "solana_settle_rejected",
    });

    const out = await new ConfirmAndSend(
      new FakeSolanaWallet(),
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway(),
      new FakeRefundGateway(),
      { prepare: new FakeSolanaPayoutPrepareGateway(), gateway, probe: new FakeSolanaEscrowDepositProbe(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe() },
    ).execute({ remittanceId: id });

    expect(out.snapshot.principalTx).toBeNull();
    expect(out.snapshot.failureReason).toBe("solana_settle_rejected");
    expect(out.snapshot.status).not.toBe("principal_in");
  });
});
