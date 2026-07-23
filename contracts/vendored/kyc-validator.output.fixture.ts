// COPIA PINNEADA, NO SE EDITA — WKH-227 / HU-SOL-24.
// Origen: wasiai-remittance-agents/src/contracts/kyc-validator.output.fixture.ts. Sync: 2026-07-22.
// Fixture vendoreado del CONTRATO del provider. Se sincroniza MANUALMENTE en el mismo PR que cambie
// el provider (DT-1 — ver CONTRACT-VERSIONS.md). El contract test de este repo lo replaya contra el
// validador del consumer: si el provider driftea y se re-vendorea, el validador falla → ROJO (AC-1).
//
// Salida REAL de runKycValidator(kycInput) con el fallback KYC (local-fallback). CD-7: PROHIBIDO PII —
// el output NO lleva `travelRuleData` ni `legalId`; `verificationId` es un handle opaco (hashLite),
// NO el DNI. El gate money-path es FAIL-SAFE: fallback → `payoutAllowed:false`.
export const kycValidatorVendoredFixture = {
  slug: "remit-kyc-validator",
  approved: true,
  riskLevel: "low",
  reasons: ["fallback_no_real_verification"],
  verificationId: "fallback-910e0084",
  provenance: "local-fallback",
  payoutAllowed: false,
} as const;
