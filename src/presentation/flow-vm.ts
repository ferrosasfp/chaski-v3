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
