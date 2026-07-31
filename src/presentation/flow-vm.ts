import type { Money } from "../domain/money";
import type { RemittanceState, RemittanceStatus } from "../domain/remittance";

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

/**
 * Monto a mostrar en el recibo, DICIENDO cuál de los dos es.
 *
 * Antes devolvía `deliveredPen ?? quote.receive` a secas, y la pantalla ponía los dos bajo la misma
 * frase: "{nombre} recibió {monto}". Con `deliveredPen` en null —que es el caso de TODA remesa cuyo
 * payout no reportó un monto entregado— el recibo afirmaba que la familia recibió una cifra que
 * nadie confirmó: era el número COTIZADO con cara de comprobante.
 *
 * Devolver el par (monto, confirmado) es lo que impide volver a confundirlos: quien lo consuma tiene
 * que decidir qué frase usar, y no puede hacerlo por accidente.
 */
export function deliveredDisplay(rem: RemittanceState): {
  amount: Money | null;
  confirmed: boolean;
} {
  if (rem.deliveredPen) return { amount: rem.deliveredPen, confirmed: true };
  return { amount: rem.quote?.receive ?? null, confirmed: false };
}

/** Copy del estado de la remesa para la persona. Existe porque el recibo tenía "Entregado"
 *  HARDCODEADO: decía lo mismo pasara lo que pasara. Acá el estado real elige la frase. */
export function statusDisplay(status: RemittanceStatus): {
  label: string;
  tone: "ok" | "active" | "bad" | "neutral";
} {
  switch (status) {
    case "settled":
      return { label: "Entregado", tone: "ok" };
    case "payout_submitted":
      return { label: "Pago en curso", tone: "active" };
    case "principal_in":
      return { label: "Fondos depositados", tone: "active" };
    case "confirmed":
      return { label: "Confirmado", tone: "active" };
    case "payout_failed":
      return { label: "No se pudo entregar", tone: "bad" };
    case "refunded":
      return { label: "Reembolsado", tone: "neutral" };
    default:
      // Fail-safe: un estado que no llega al recibo NO se disfraza de entregado.
      return { label: "En curso", tone: "neutral" };
  }
}

/**
 * Copy de los errores del refund del escrow (enum→frase fija, PII-free / CD-5).
 *
 * Existe porque la acción tenía UNA sola frase para todo: "No pudimos recuperar los fondos". Con el
 * caso indeterminado esa frase pasa a ser activamente engañosa: el error más probable ahí es
 * `escrow_not_found`, que significa "no hay depósito tuyo en el escrow" — o sea, la buena noticia de
 * que probablemente no salió un peso de tu wallet. Decirle a esa persona que no pudimos recuperar sus
 * fondos la deja creyendo que su plata está atrapada en algún lado.
 */
export function escrowRefundError(code: string): string {
  if (code.includes("escrow_not_found"))
    return "No encontramos un depósito tuyo en el escrow. Si nunca salió de tu wallet, tus USDC siguen ahí. Si acabás de enviarlo, probá de nuevo en un rato.";
  if (code.includes("escrow_not_deposited"))
    return "Ese depósito ya no está en el escrow: o volvió antes, o ya se liberó al pago.";
  if (code.includes("refund_before_deadline"))
    return "Todavía no: el contrato permite recuperar recién después del vencimiento.";
  if (code.includes("wallet_not_connected") || code.includes("no_account"))
    return "Reconectá o desbloqueá tu wallet para continuar.";
  return "No pudimos recuperar los fondos. Intentá de nuevo.";
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
