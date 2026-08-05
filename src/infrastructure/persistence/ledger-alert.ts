// Prefijo ÚNICO de las alertas del ledger. SERVER-ONLY.
//
// Existe para que el string sobre el que alerta producción tenga una sola definición: lo usan
// logLedgerWriteFailure (write fallido) y logLedgerAlert (escritura que corrió y NO dejó la evidencia
// que correspondía), que son dos señales distintas con el mismo canal de salida.
export const LEDGER_ALERT_PREFIX = "[ledger][ALERT]";

/** Señal de que la evidencia durable NO quedó como corresponde, SIN que haya habido un error de
 *  escritura (para eso está logLedgerWriteFailure). NO cambia el control de flujo. NUNCA PII (CD-7):
 *  sólo identificadores de correlación. */
export function logLedgerAlert(event: string, fields: Record<string, string>): void {
  console.error(`${LEDGER_ALERT_PREFIX} ${event}`, fields);
}
