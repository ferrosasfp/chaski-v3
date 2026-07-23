// COPIA PINNEADA, NO SE EDITA — WKH-227 / HU-SOL-24.
// Origen: wasiai-remittance-agents/src/contracts/cashout-payout.output.fixture.ts. Sync: 2026-07-22.
// Fixture vendoreado del CONTRATO del provider. Se sincroniza MANUALMENTE en el mismo PR que cambie
// el provider (DT-1 — ver CONTRACT-VERSIONS.md). El contract test de este repo lo replaya contra el
// validador del consumer: si el provider driftea y se re-vendorea, el validador falla → ROJO (AC-1).
//
// Salida REAL de runCashoutPayout(cashoutPayoutInput) en la rama determinística BLOCKED (fail-closed
// sin KYC real): executed:false, status:"blocked", reason:"kyc_gate_not_passed". WKH-212:
// `depositAddress` presente SIEMPRE (string|null); null en blocked/mock (no hubo payout).
export const cashoutPayoutVendoredFixture = {
  slug: "remit-cashout-payout",
  executed: false,
  status: "blocked",
  payoutId: null,
  deliveredLocal: null,
  txRef: null,
  reason: "kyc_gate_not_passed",
  provenance: "n/a",
  depositAddress: null,
} as const;
