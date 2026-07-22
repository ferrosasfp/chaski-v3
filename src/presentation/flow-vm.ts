import type { Money } from "../domain/money";
import type { RemittanceState } from "../domain/remittance";
import { FALLBACK_WALLET_ADDRESS } from "../infrastructure/wallet";
import { canonicalizeAddress } from "../infrastructure/address";
import { resolveActiveVm } from "../infrastructure/chain";

/** Proveniencias de payout que representan un desembolso REAL (allowlist fail-safe, CD-8). Cualquier
 *  valor desconocido/typo cae del lado seguro → muestra el banner (over-warn), nunca lo oculta.
 *  Exemplar: REAL_KYC_PROVENANCES = new Set(["didit"]) en el agente KYC. */
const REAL_PAYOUT_PROVENANCES = new Set(["transfi"]);

/** true si la proveniencia del payout indica un desembolso NO real (mock). `null`/`undefined`
 *  (remesa sin payout aún / legacy) → false (no fuerza el banner por ausencia de dato). */
export function isPayoutDemo(p: string | null | undefined): boolean {
  return p != null && !REAL_PAYOUT_PROVENANCES.has(p);
}

/** "Modo demo" ⇔ algún dato del flujo vino del fallback local (no Didit / no partner real). */
export function isDemoMode(rem: RemittanceState): boolean {
  return (
    rem.quote?.provenance === "local-fallback" ||
    rem.kyc?.provenance === "local-fallback" ||
    isPayoutDemo(rem.payoutProvenance)
  );
}

/** true si la wallet conectada es la FallbackWallet demo (sin aislamiento real por wallet). WKH-184.
 *  Case-insensitive: el address del estado viene crudo mixed-case desde connect() (CD-9).
 *  BLQ-MED-1 (AR/CR): fail-safe. FALLBACK_WALLET_ADDRESS es un address EVM ("0xDEMO…"); bajo vm=solana
 *  canonicalizeAddress(FALLBACK, "solana") throwea (new PublicKey del EVM tira) → el render de
 *  RemittanceFlow completo crasheaba. Envuelto en try/catch (mismo patrón que addressEqualsVm en
 *  address.ts:39-43 y el resolveActiveVm try/catch en TrackView): si el address no canonicaliza bajo el
 *  VM activo, NO es el fallback → false. EVM (toLowerCase, NUNCA throw) queda byte-idéntico. */
export function isFallbackWalletAddress(address: string | null): boolean {
  if (!address) return false;
  try {
    const vm = resolveActiveVm();
    return canonicalizeAddress(address, vm) === canonicalizeAddress(FALLBACK_WALLET_ADDRESS, vm);
  } catch {
    return false;
  }
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
