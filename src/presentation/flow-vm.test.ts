import { describe, expect, it } from "vitest";
import { Money } from "../domain/money";
import type { RemittanceState } from "../domain/remittance";
import { deliveredDisplay, isDemoMode } from "./flow-vm";

describe("flow-vm — deliveredDisplay", () => {
  it("AC-2: deliveredPen null → usa quote.receive", () => {
    const rem = {
      deliveredPen: null,
      quote: { receive: Money.of(1490, "PEN") },
    } as RemittanceState;
    expect(deliveredDisplay(rem)).toEqual(Money.of(1490, "PEN"));
  });

  it("prioriza deliveredPen real sobre quote.receive", () => {
    const rem = {
      deliveredPen: Money.of(368, "PEN"),
      quote: { receive: Money.of(1490, "PEN") },
    } as RemittanceState;
    expect(deliveredDisplay(rem)).toEqual(Money.of(368, "PEN"));
  });

  it("AC-3: deliveredPen y quote null → null (UI muestra '—')", () => {
    const rem = { deliveredPen: null, quote: null } as RemittanceState;
    expect(deliveredDisplay(rem)).toBeNull();
  });
});

describe("flow-vm — isDemoMode", () => {
  it("AC-4: quote.provenance local-fallback → true", () => {
    const rem = {
      quote: { provenance: "local-fallback" },
      kyc: null,
    } as RemittanceState;
    expect(isDemoMode(rem)).toBe(true);
  });

  it("AC-4: kyc.provenance local-fallback → true", () => {
    const rem = {
      quote: null,
      kyc: { provenance: "local-fallback" },
    } as RemittanceState;
    expect(isDemoMode(rem)).toBe(true);
  });

  it("AC-5: estado done demo (deliveredPen null + quote local-fallback) → true", () => {
    const rem = {
      status: "settled",
      deliveredPen: null,
      quote: { provenance: "local-fallback", receive: Money.of(1490, "PEN") },
      kyc: null,
    } as RemittanceState;
    expect(isDemoMode(rem)).toBe(true);
  });

  it("AC-6: ambos provenance didit → false (deriva de provenance, no de flag)", () => {
    const rem = {
      quote: { provenance: "didit" },
      kyc: { provenance: "didit" },
    } as RemittanceState;
    expect(isDemoMode(rem)).toBe(false);
  });
});
