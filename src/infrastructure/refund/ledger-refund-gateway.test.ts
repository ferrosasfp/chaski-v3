import { describe, expect, it } from "vitest";
import { Money } from "../../domain/money";
import { LedgerRefundGateway } from "./ledger-refund-gateway";

describe("LedgerRefundGateway — refund ledger-only (WKH-186 AC-8/CD-8)", () => {
  // El test viejo era `expect(refundTx).toMatch(/^refund-ledger-/)`: CLAVABA la mentira. Verificaba
  // que este adapter, que no mueve un solo USDC, devolviera igual algo con forma de comprobante.
  it("creditBack NO devuelve comprobante: no revirtió nada, así que no hay nada que mostrar", async () => {
    const gw = new LedgerRefundGateway();
    const { refundTx } = await gw.creditBack({
      remittanceId: "r-1",
      amountUsd: Money.of(400, "USDC"),
      reason: "partner_down",
    });
    expect(refundTx).toBeNull();
  });

  // Guard anti-regresión con nombre propio: lo que NO puede volver es un identificador FABRICADO.
  // Si alguien reinstala el `refund-ledger-${Date.now()}` (o cualquier otro string inventado), este
  // test se pone rojo aunque el de arriba se haya "arreglado" aflojando el toBeNull.
  it("NUNCA devuelve un string con forma de comprobante (ni refund-ledger-, ni ningún otro)", async () => {
    const gw = new LedgerRefundGateway();
    for (const reason of ["partner_down", "solana_settle_unavailable", "principal_state_unknown"]) {
      const { refundTx } = await gw.creditBack({
        remittanceId: "r-x",
        amountUsd: Money.of(1, "USDC"),
        reason,
      });
      expect(typeof refundTx).not.toBe("string");
      expect(refundTx ?? "").not.toMatch(/refund-ledger-/);
    }
  });

  it("no lanza para ningún reason (best-effort, ledger-only nunca falla)", async () => {
    const gw = new LedgerRefundGateway();
    await expect(
      gw.creditBack({ remittanceId: "r-2", amountUsd: Money.of(1, "USDC"), reason: "payout_amount_mismatch" }),
    ).resolves.toHaveProperty("refundTx");
  });
});
