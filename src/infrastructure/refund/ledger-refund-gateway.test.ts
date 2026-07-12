import { describe, expect, it } from "vitest";
import { Money } from "../../domain/money";
import { LedgerRefundGateway } from "./ledger-refund-gateway";

describe("LedgerRefundGateway — refund ledger-only (WKH-186 AC-8/CD-8)", () => {
  it("creditBack resuelve un refundTx sintético (prefijo refund-ledger-)", async () => {
    const gw = new LedgerRefundGateway();
    const { refundTx } = await gw.creditBack({
      remittanceId: "r-1",
      amountUsd: Money.of(400, "USDC"),
      reason: "partner_down",
    });
    expect(refundTx).toMatch(/^refund-ledger-/);
  });

  it("no lanza para ningún reason (best-effort, ledger-only nunca falla)", async () => {
    const gw = new LedgerRefundGateway();
    await expect(
      gw.creditBack({ remittanceId: "r-2", amountUsd: Money.of(1, "USDC"), reason: "payout_amount_mismatch" }),
    ).resolves.toHaveProperty("refundTx");
  });
});
