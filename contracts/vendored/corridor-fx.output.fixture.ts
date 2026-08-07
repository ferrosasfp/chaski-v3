// COPIA PINNEADA, NO SE EDITA — WKH-227 / HU-SOL-24.
// Origen: wasiai-remittance-agents/src/contracts/corridor-fx.output.fixture.ts. Sync: 2026-07-22.
// Fixture vendoreado del CONTRATO del provider. Se sincroniza MANUALMENTE en el mismo PR que cambie
// el provider (DT-1 — ver CONTRACT-VERSIONS.md). El contract test de este repo lo replaya contra el
// validador del consumer: si el provider driftea y se re-vendorea, el validador falla → ROJO (AC-1).
//
// Salida REAL de runCorridorFx({ amountUsd: 100 }) con el fallback FX (local-fallback). AC-5: FIAT
// (rate/feeUsd/netDeliveredLocal) queda `number`, NO se convierte a string/bigint. El consumer sólo
// exige el subconjunto (`RawQuoteResult`, `../../src/infrastructure/a2a/gateways.ts:28-36`);
// `slug`/`localCurrency` son extra ignorados. La cita iba SIN ancla y apuntaba a `:19-27`: WKH-332
// insertó líneas arriba y el número quedó viejo sin que nada lo viera. Anclada, la vigila
// `citas-ancladas.test.ts`.
export const corridorFxVendoredFixture = {
  slug: "remit-corridor-fx",
  rate: 3.705,
  feeUsd: 0.5,
  netDeliveredLocal: 368.65,
  localCurrency: "PEN",
  etaMinutes: 30,
  quoteId: "fallback-1753142400000",
  expiresAt: "2026-07-22T00:10:00.000Z",
  provenance: "local-fallback",
} as const;
