// WKH-227 / HU-SOL-24 — contract test (AC-1) FORWARD-LOOKING. remit-kyc-validator NO tiene consumer
// productivo en chaski (el KYC real va por Didit /api/kyc/*, no por el agente A2A). Para mantener la
// simetría con los otros 2 contratos sin inventar un consumer, definimos un shape-guard TEST-ONLY que
// espeja KycAgentOutput (keys + typeof) y validamos el fixture vendoreado contra él. Ver CONTRACT-VERSIONS.md.
// CD-7: además se asegura que el fixture NO contiene PII (`travelRuleData` ni un legalId/DNI).
import { describe, expect, it } from "vitest";
import { kycValidatorVendoredFixture } from "./vendored/kyc-validator.output.fixture";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Espejo TEST-ONLY del contrato KycAgentOutput del provider (keys + typeof). NO es un validador de
// producción (chaski no consume este agente): existe sólo para cerrar el loop de drift del contrato.
function matchesKycAgentOutputShape(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const riskOk = v.riskLevel === "low" || v.riskLevel === "medium" || v.riskLevel === "high";
  return (
    typeof v.slug === "string" &&
    typeof v.approved === "boolean" &&
    riskOk &&
    Array.isArray(v.reasons) &&
    v.reasons.every((r) => typeof r === "string") &&
    typeof v.verificationId === "string" &&
    typeof v.provenance === "string" &&
    typeof v.payoutAllowed === "boolean"
  );
}

describe("contract kyc (AC-1, forward-looking) — shape-guard vs fixture vendoreado", () => {
  it("fixture CANÓNICO ⇒ cumple el shape KycAgentOutput", () => {
    expect(matchesKycAgentOutputShape(kycValidatorVendoredFixture)).toBe(true);
  });

  it("DRIFT (payoutAllowed removido) ⇒ shape-guard falla", () => {
    const { payoutAllowed: _drop, ...rest } = kycValidatorVendoredFixture;
    expect(matchesKycAgentOutputShape(rest)).toBe(false);
  });

  it("CD-7: el fixture NO contiene PII (travelRuleData / legalId / documentNumber)", () => {
    const serialized = JSON.stringify(kycValidatorVendoredFixture);
    expect(serialized).not.toContain("travelRuleData");
    expect(serialized).not.toContain("legalId");
    expect(serialized).not.toContain("documentNumber");
    expect(Object.keys(kycValidatorVendoredFixture)).not.toContain("travelRuleData");
  });
});
