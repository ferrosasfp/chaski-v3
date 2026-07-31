// Tests — ConfirmAndSend rama SOLANA (HU-SOL-13/WKH-216, 9º param `solana`). AC-1: el deposit se cablea
// con beneficiary/authority resueltos SERVER-SIDE (del prepare, NUNCA del body). AC-4/CD-7: prepare !ok /
// gateway !ok / gateway throw ⇒ failAndRefund, NUNCA markPrincipalIn. Cero @solana/web3.js (fakes puros).
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
  FakeSolanaPayoutPrepareGateway,
  FakeSolanaSettlementGateway,
  FakeSolanaWallet,
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
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  r.applyKyc(passKyc, T0);
  await repo.save(r);
  return "r-1";
}

// Construye el camino real: el 6º arg `solana` (prepare+gateway acoplados). WKH-320: ya no hay 7º/8º
// args (`settlement` EVM y `pop`) porque no hay una segunda VM con la que ser mutuamente excluyente.
function build(
  repo: InMemoryRepo,
  wallet: FakeSolanaWallet,
  prepare: FakeSolanaPayoutPrepareGateway,
  gateway: FakeSolanaSettlementGateway,
  _payouts?: FakePayoutGateway,
  refund: FakeRefundGateway = new FakeRefundGateway(),
): ConfirmAndSend {
  return new ConfirmAndSend(
    wallet,
    repo,
    new FixedClock(),
    new FakePayoutAuthorityGateway({ authorized: true }),
    refund,
    { prepare, gateway },
  );
}

describe("ConfirmAndSend — rama Solana (HU-SOL-13)", () => {
  it("T1/AC-1: happy — beneficiary/authority server-side → authorizePrincipal(escrow) → settle → markPrincipalIn + payout_submitted", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway();
    const payouts = new FakePayoutGateway();
    const submitSpy = vi.spyOn(payouts, "submit");
    const id = await seedQuoted(repo);

    const out = await build(repo, wallet, prepare, gateway, payouts).execute({ remittanceId: id });

    // prepare resolvió {beneficiary, authority} server-side (una sola llamada).
    expect(prepare.calls).toHaveLength(1);
    // authorizePrincipal recibió el escrow con beneficiary/authority DEL PREPARE (server-side), NUNCA del body.
    expect(wallet.authorizeCalls).toHaveLength(1);
    expect(wallet.authorizeCalls[0]!.deposit?.escrow).toEqual({
      beneficiary: FAKE_SOLANA_BENEFICIARY,
      authority: FAKE_SOLANA_AUTHORITY,
    });
    // gateway.settle broadcasteó la tx partial-firmada + reference.
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]!.partialSignedTx).toBe("AQID");
    expect(gateway.calls[0]!.remittanceId).toBe("r-1");
    // markPrincipalIn con la signature base58 verificada on-chain por /solana/sponsor.
    expect(out.snapshot.principalTx).toBe(FAKE_SOLANA_SIGNATURE);
    // payout_submitted con el payoutId + provenance de prepare (la orden TransFi ya se creó).
    expect(out.status).toBe("payout_submitted");
    expect(out.snapshot.payoutId).toBe("transfi-sol-po-1");
    expect(out.snapshot.payoutProvenance).toBe("transfi");
    // En modo Solana el submit del payout NO se llama (la release la dispara el facilitator async).
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("T2/AC-1: prepare !ok ⇒ failAndRefund ANTES de firmar; authorizePrincipal + settle NUNCA; principalTx null", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway({ ok: false, reason: "prepare_no_deposit_address" });
    const gateway = new FakeSolanaSettlementGateway();
    const id = await seedQuoted(repo);

    const out = await build(repo, wallet, prepare, gateway, new FakePayoutGateway()).execute({
      remittanceId: id,
    });

    expect(wallet.authorizeCalls).toHaveLength(0); // NUNCA firmó
    expect(gateway.calls).toHaveLength(0); // NUNCA broadcasteó
    expect(out.snapshot.principalTx).toBeNull(); // NUNCA markPrincipalIn
    expect(out.status).toBe("refunded"); // refund-on-failure (FakeRefundGateway resuelve)
    expect(out.snapshot.failureReason).toBe("prepare_no_deposit_address");
  });

  it("T2/AC-4: gateway !ok ⇒ failAndRefund; firma SÍ ocurre, markPrincipalIn NUNCA; principalTx null", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway({ ok: false, reason: "solana_settle_rejected" });
    const id = await seedQuoted(repo);

    const out = await build(repo, wallet, prepare, gateway, new FakePayoutGateway()).execute({
      remittanceId: id,
    });

    expect(wallet.authorizeCalls).toHaveLength(1); // firmó (arma la ix deposit)
    expect(gateway.calls).toHaveLength(1); // intentó broadcastear
    expect(out.snapshot.principalTx).toBeNull(); // pero NUNCA markPrincipalIn
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("solana_settle_rejected");
  });

  it("T2/AC-4: gateway throw (red/bug) ⇒ fail-closed solana_settle_unavailable; principalTx null", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway(undefined, "reject"); // settle() throw
    const id = await seedQuoted(repo);

    const out = await build(repo, wallet, prepare, gateway, new FakePayoutGateway()).execute({
      remittanceId: id,
    });

    expect(out.snapshot.principalTx).toBeNull();
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("solana_settle_unavailable");
  });

  it("T2/AC-1: sin envelope solana (wallet no arma el deposit) ⇒ settlement_unverified, sin broadcast", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet(null); // authorizePrincipal devuelve { tx } sin solana
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const gateway = new FakeSolanaSettlementGateway();
    const id = await seedQuoted(repo);

    const out = await build(repo, wallet, prepare, gateway, new FakePayoutGateway()).execute({
      remittanceId: id,
    });

    expect(gateway.calls).toHaveLength(0); // NUNCA broadcastea sin envelope
    expect(out.snapshot.principalTx).toBeNull();
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("settlement_unverified");
  });
});

// ── T7 / DT-8 (WKH-320) — el tapón fail-closed ────────────────────────────────────────────────────
// Al quedar la rama Solana como CAMINO ÚNICO, su ausencia ya no cae a un camino alternativo: cae al
// vacío. Sin este tapón, execute() llegaría al final y devolvería la remesa 'confirmed' SIN haber
// movido nada — un no-op silencioso en el money-path, peor que el throw de antes.
describe("ConfirmAndSend — DT-8: sin `solana` inyectado (WKH-320)", () => {
  it("T7: solana === undefined ⇒ payout_failed/refunded con reason settlement_unavailable", async () => {
    const repo = new InMemoryRepo();
    const wallet = new FakeSolanaWallet();
    const authorizeSpy = vi.spyOn(wallet, "authorizePrincipal");
    const refund = new FakeRefundGateway();
    const id = await seedQuoted(repo);

    const out = await new ConfirmAndSend(
      wallet,
      repo,
      new FixedClock(),
      new FakePayoutAuthorityGateway({ authorized: true }),
      refund,
      // sin 6º arg: flag apagado / envs faltantes
    ).execute({ remittanceId: id });

    // NUNCA 'confirmed' en silencio.
    expect(out.status).toBe("refunded");
    expect(out.status).not.toBe("confirmed");
    expect(out.snapshot.failureReason).toBe("settlement_unavailable");
    // NUNCA markPrincipalIn: no entró un peso.
    expect(out.snapshot.principalTx).toBeNull();
    // Y ni siquiera se le pidió la firma a la wallet.
    expect(authorizeSpy).not.toHaveBeenCalled();
    // El credit-back corrió en el MISMO execute (ninguna remesa queda huérfana).
    expect(refund.calls).toHaveLength(1);
    expect(refund.calls[0]?.reason).toBe("settlement_unavailable");
  });

  it("T7: NINGUNA excepción escapa de execute() (fail-closed controlado, no un throw crudo)", async () => {
    const repo = new InMemoryRepo();
    const id = await seedQuoted(repo);
    await expect(
      new ConfirmAndSend(
        new FakeSolanaWallet(),
        repo,
        new FixedClock(),
        new FakePayoutAuthorityGateway({ authorized: true }),
        new FakeRefundGateway(),
      ).execute({ remittanceId: id }),
    ).resolves.toBeDefined();
  });
});
