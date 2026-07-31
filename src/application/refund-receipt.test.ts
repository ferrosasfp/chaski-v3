// Tests: la regla única que decide si un refund tiene comprobante. Es la que impide que una remesa
// llegue a `refunded` (terminal, sin salida) sin que nadie haya movido plata.
import { describe, expect, it } from "vitest";
import { isRealRefundReceipt } from "./refund-receipt";

describe("isRealRefundReceipt: sin movimiento no hay comprobante", () => {
  it("null ⇒ false: el adapter ledger-only no revirtió nada", () => {
    expect(isRealRefundReceipt(null)).toBe(false);
  });

  it('"" y espacios ⇒ false: un comprobante vacío no es un comprobante', () => {
    expect(isRealRefundReceipt("")).toBe(false);
    expect(isRealRefundReceipt("   ")).toBe(false);
  });

  it("una signature real ⇒ true: hay algo que la persona puede buscar", () => {
    expect(isRealRefundReceipt("5w1t9qk3mF8s")).toBe(true);
  });
});
