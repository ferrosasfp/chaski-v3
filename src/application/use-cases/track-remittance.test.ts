import { describe, expect, it } from "vitest";
import { Money } from "../../domain/money";
import { type KycVerification, type Quote, Remittance } from "../../domain/remittance";
import {
  FakePayoutGateway,
  FakeRefundGateway,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  beneficiary,
} from "../../test-support/fakes";
import { TrackRemittance } from "./track-remittance";

const passKyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true,
  riskLevel: "low",
  provenance: "didit",
  identity: null,
};

// receive lockeado = 1480 PEN → tolerancia = max(0.02, 1480*0.01) = 14.8 PEN (AC-6/CD-6).
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

// Construye una remesa ya en payout_submitted (lista para track()).
async function seedSubmitted(repo: InMemoryRepo): Promise<string> {
  const r = Remittance.create("r-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.startKyc(T0, "0xSender");
  r.applyKyc(passKyc, T0);
  r.attachQuote(quote, T0);
  r.confirm(T0);
  r.markPrincipalIn("0xprincipal", T0);
  r.markPayoutSubmitted("p-1", T0);
  await repo.save(r);
  return "r-1";
}

describe("TrackRemittance — reconciliación PRE-markSettled (AC-6/CD-6)", () => {
  it("deliveredPen dentro de tolerancia → settled", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const payouts = new FakePayoutGateway({}, { status: "settled", deliveredPen: Money.of(1480, "PEN"), txRef: "0xok" });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), new FakeRefundGateway()).execute({ remittanceId: id });
    expect(out.status).toBe("settled");
    expect(out.snapshot.deliveredPen).toEqual(Money.of(1480, "PEN"));
  });

  it("deliveredPen en el borde exacto de la tolerancia (+14.8) → settled", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const payouts = new FakePayoutGateway({}, { status: "settled", deliveredPen: Money.of(1494.8, "PEN"), txRef: "0xok" });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), new FakeRefundGateway()).execute({ remittanceId: id });
    expect(out.status).toBe("settled");
  });

  it("deliveredPen FUERA de tolerancia → refunded razón payout_amount_mismatch, NUNCA settled (AC-6/AC-7)", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const refund = new FakeRefundGateway();
    const payouts = new FakePayoutGateway({}, { status: "settled", deliveredPen: Money.of(368, "PEN"), txRef: "0xbad" });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), refund).execute({ remittanceId: id });
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("payout_amount_mismatch");
    expect(out.snapshot.refundTx).toBe("refund-fake");
    expect(refund.calls).toHaveLength(1);
    expect(refund.calls[0]?.reason).toBe("payout_amount_mismatch");
    expect(refund.calls[0]?.amountUsd).toEqual(Money.of(400, "USDC")); // se refundea el principal
  });

  it("deliveredPen null (fallback) → settled con null, reconciliación NO corre (regresión byte-idéntica)", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const refund = new FakeRefundGateway();
    const payouts = new FakePayoutGateway({}, { status: "settled", deliveredPen: null, txRef: null });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), refund).execute({ remittanceId: id });
    expect(out.status).toBe("settled");
    expect(out.snapshot.deliveredPen).toBeNull();
    expect(refund.calls).toHaveLength(0);
  });
});

describe("TrackRemittance — refund-on-failure (AC-7/CD-7)", () => {
  it("status failed → refunded, failureReason preservado, creditBack llamado", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const refund = new FakeRefundGateway();
    const payouts = new FakePayoutGateway({}, { status: "failed", failureReason: "partner_down", deliveredPen: null });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), refund).execute({ remittanceId: id });
    expect(out.status).toBe("refunded");
    expect(out.snapshot.failureReason).toBe("partner_down");
    expect(out.snapshot.refundTx).toBe("refund-fake");
    expect(refund.calls).toHaveLength(1);
  });

  it("refund falla (reject) → queda en payout_failed (best-effort, no throw)", async () => {
    const repo = new InMemoryRepo();
    const id = await seedSubmitted(repo);
    const refund = new FakeRefundGateway("reject");
    const payouts = new FakePayoutGateway({}, { status: "failed", failureReason: "partner_down", deliveredPen: null });
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), refund).execute({ remittanceId: id });
    expect(out.status).toBe("payout_failed");
    expect(out.snapshot.failureReason).toBe("partner_down");
    expect(out.snapshot.refundTx).toBeNull();
  });
});

describe("TrackRemittance — guard (idempotencia)", () => {
  it("no corre si el estado no es payout_submitted (terminal/otro) → no-op", async () => {
    const repo = new InMemoryRepo();
    // remesa recién creada (created) → el guard corta sin tocar payout
    const r = Remittance.create("r-2", beneficiary(), Money.of(400, "USDC"), T0);
    await repo.save(r);
    const refund = new FakeRefundGateway();
    const payouts = new FakePayoutGateway();
    const out = await new TrackRemittance(payouts, repo, new FixedClock(), refund).execute({ remittanceId: "r-2" });
    expect(out.status).toBe("created");
    expect(refund.calls).toHaveLength(0);
  });
});
