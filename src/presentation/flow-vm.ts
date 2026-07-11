import type { Money } from "../domain/money";
import type { RemittanceState } from "../domain/remittance";

/** "Modo demo" ⇔ algún dato del flujo vino del fallback local (no Didit / no partner real). */
export function isDemoMode(rem: RemittanceState): boolean {
  return rem.quote?.provenance === "local-fallback" || rem.kyc?.provenance === "local-fallback";
}

/** Monto a MOSTRAR como entregado: el real; si no llegó, el cotizado; si tampoco, null → UI muestra "—". */
export function deliveredDisplay(rem: RemittanceState): Money | null {
  return rem.deliveredPen ?? rem.quote?.receive ?? null;
}

/** Traduce un código de error interno a copy humano para la UI. */
export function humanError(code: string): string {
  if (code.includes("quote_expired") || code.includes("QUOTE_STALE"))
    return "La tasa cambió. Revisá el nuevo monto.";
  // CD-5: ANTES de includes("kyc") — el string "kyc_pending_unavailable" contiene "kyc".
  if (code.includes("kyc_pending_unavailable") || code.includes("pending_unavailable"))
    return "No pudimos preparar la verificación. Probá de nuevo.";
  if (code.includes("no_wallet"))
    return "No se detectó una wallet instalada. Instalá o desbloqueá tu wallet.";
  if (code.includes("no_account") || code.includes("wallet_not_connected"))
    return "Reconectá o desbloqueá tu wallet para continuar.";
  if (code.includes("kyc")) return "No pudimos verificar tu identidad.";
  if (code.includes("payout")) return "No se pudo entregar. Si te cobramos, te reembolsamos.";
  return "Algo salió mal. Intentá de nuevo.";
}
