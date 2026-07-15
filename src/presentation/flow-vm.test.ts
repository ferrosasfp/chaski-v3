import { describe, expect, it } from "vitest";
import { Money } from "../domain/money";
import type { RemittanceState } from "../domain/remittance";
import { FALLBACK_WALLET_ADDRESS } from "../infrastructure/wallet";
import { deliveredDisplay, humanError, isDemoMode, isFallbackWalletAddress } from "./flow-vm";

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

  it("T-AC3a (AC-3/5): quote/kyc reales pero payout mock (local-fallback) → true", () => {
    const rem = {
      quote: { provenance: "didit" },
      kyc: { provenance: "didit" },
      payoutProvenance: "local-fallback",
    } as RemittanceState;
    expect(isDemoMode(rem)).toBe(true);
  });

  it("T-AC3b (AC-3/5): payout real transfi / null / ausente (quote/kyc reales) → false", () => {
    const real = {
      quote: { provenance: "didit" },
      kyc: { provenance: "didit" },
      payoutProvenance: "transfi",
    } as RemittanceState;
    expect(isDemoMode(real)).toBe(false);

    const noPayout = {
      quote: { provenance: "didit" },
      kyc: { provenance: "didit" },
      payoutProvenance: null,
    } as RemittanceState;
    expect(isDemoMode(noPayout)).toBe(false);

    const absent = {
      quote: { provenance: "didit" },
      kyc: { provenance: "didit" },
    } as RemittanceState; // payoutProvenance undefined (legacy) → false
    expect(isDemoMode(absent)).toBe(false);
  });
});

describe("flow-vm — isFallbackWalletAddress (WKH-184 AC-7/AC-9)", () => {
  it("AC-7: la address demo → true", () => {
    expect(isFallbackWalletAddress(FALLBACK_WALLET_ADDRESS)).toBe(true);
  });

  it("AC-9: case-insensitive (variante uppercase de la const) → true", () => {
    expect(isFallbackWalletAddress(FALLBACK_WALLET_ADDRESS.toUpperCase())).toBe(true);
  });

  it("AC-7: address real mixed-case → false", () => {
    expect(isFallbackWalletAddress("0xAbC1230000000000000000000000000000000001")).toBe(false);
  });

  it("AC-7: null → false", () => {
    expect(isFallbackWalletAddress(null)).toBe(false);
  });
});

describe("flow-vm — humanError", () => {
  it("AC-5: no_wallet → copy específico (≠ genérico)", () => {
    expect(humanError("no_wallet")).toContain("wallet instalada");
    expect(humanError("no_wallet")).not.toBe("Algo salió mal. Intentá de nuevo.");
  });

  it("AC-6: no_account / wallet_not_connected → reconectar", () => {
    expect(humanError("no_account")).toContain("Reconectá");
    expect(humanError("wallet_not_connected")).toContain("Reconectá");
  });

  it("CD-5: kyc_pending_unavailable se evalúa ANTES de includes('kyc')", () => {
    expect(humanError("kyc_pending_unavailable")).toBe(
      "No pudimos preparar la verificación. Probá de nuevo.",
    );
    expect(humanError("kyc_pending_unavailable")).not.toBe("No pudimos verificar tu identidad.");
  });

  it("kyc genérico y payout siguen mapeando a su copy", () => {
    expect(humanError("kyc_rejected")).toBe("No pudimos verificar tu identidad.");
    expect(humanError("payout_failed")).toContain("reembolsamos");
    expect(humanError("otra_cosa")).toBe("Algo salió mal. Intentá de nuevo.");
  });
});
