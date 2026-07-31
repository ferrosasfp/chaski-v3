// Application: la regla ÚNICA que decide si un refund tiene comprobante, y por lo tanto si la remesa
// puede pasar a `refunded`.
//
// Existe porque los DOS use-cases del money-path (ConfirmAndSend y TrackRemittance) tomaban esa
// decisión por su cuenta, y tomaban la misma equivocada: escribían como `refundTx` lo que devolviera
// el adapter, sin preguntarse si detrás había un movimiento. El adapter default es ledger-only y
// devolvía un string fabricado (`refund-ledger-…`), así que la remesa terminaba en `refunded`,
// que es TERMINAL, con una "referencia de reembolso" que no referenciaba nada, mientras los USDC seguían en
// el vault del escrow. La persona veía un comprobante y perdía el botón para recuperar su plata.
//
// Duplicar este chequeo en cada use-case es cómo divergen los guards: acá vive una sola vez.

/** true SÓLO si el adapter devolvió un comprobante que existe. `null` (no revirtió nada) y `""`
 *  (comprobante vacío) son lo mismo para la persona: no hay nada que mostrarle ni que afirmar. */
export function isRealRefundReceipt(refundTx: string | null): refundTx is string {
  return typeof refundTx === "string" && refundTx.trim().length > 0;
}
