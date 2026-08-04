import type { Money } from "../domain/money";
import { MIN_SEND_USD } from "../domain/remittance";
import type { RemittanceState, RemittanceStatus } from "../domain/remittance";
import {
  PRINCIPAL_SETTLED_REFUND_MANUAL,
  PRINCIPAL_STATE_UNKNOWN,
} from "../application/use-cases/confirm-and-send";
import { ESCROW_REFUNDED_BY_SENDER } from "../application/use-cases/recover-escrow-funds";
import {
  SENDER_MIN_LAMPORTS_FOR_DEPOSIT,
  formatLamportsAsSol,
} from "../application/solana-escrow-rent";

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
 * Qué sabemos del DINERO de una remesa que el historial va a listar. CUATRO valores, y ninguno
 * colapsa en otro: "no lo comprobamos" no es "no hay nada", y "la cadena dijo que está" tampoco es
 * "no lo comprobamos".
 *
 * Esta función no lee la cadena: se calcula SOLO con el snapshot persistido, así que lo único que
 * puede afirmar es lo que alguien ya midió y llegamos a ESCRIBIR. Por eso los dos valores que
 * afirman algo del vault salen de marcadores que se escriben en UN solo lugar y bajo UNA sola
 * condición, nunca de deducir un final a partir del status.
 *
 * - `returned`   los USDC volvieron. Lo respalda `ESCROW_REFUNDED_BY_SENDER`, que RecoverEscrowFunds
 *                escribe recién con `confirmation === "confirmed"` (recover-escrow-funds.ts:70-77),
 *                o sea después de ver la tx del refund confirmada.
 * - `in-escrow`  los USDC están en el vault, a nombre de la persona. Lo respalda
 *                `PRINCIPAL_SETTLED_REFUND_MANUAL`, que ConfirmAndSend escribe SÓLO cuando el probe
 *                le contestó `"deposited"`, y ese probe le pregunta A LA CADENA
 *                (confirm-and-send.ts:113-118 + ports.ts `SolanaEscrowDepositProbe`). Es el segundo
 *                hecho de la cadena que un snapshot puede contener, y llegó con el fix del reembolso
 *                fabricado: antes esta remesa no existía como estado propio.
 * - `unverified` se autorizó o entró un depósito y NADIE leyó el vault desde entonces, o lo leímos y
 *                la cadena no contestó (`PRINCIPAL_STATE_UNKNOWN`). Puede haber USDC ahí o no.
 * - `no-deposit` sabemos que el depósito NO salió: nunca se autorizó, o el intento murió ANTES del
 *                broadcast y eso está probado (SETTLE_REASONS_BEFORE_BROADCAST en
 *                confirm-and-send.ts:48-53, que incluye `solana_settle_beneficiary_mismatch`). No
 *                hay plata en juego y por eso es el único valor que NO ofrece camino de recuperación.
 *
 * ⚠️ TRES COSAS QUE PARECEN PRUEBA Y NO LO SON. Si "simplificás" esto usándolas, la pantalla vuelve
 * a afirmar lo que nadie midió:
 *
 * 1. `refundTx != null` NO prueba que los USDC volvieron. Hoy el adapter DEFAULT devuelve `null` y
 *    `refunded` exige un comprobante real (refund-receipt.ts), pero la regla que sostiene eso vive en
 *    OTRO archivo y cualquier adapter que vuelva a fabricar un identificador la rompe sin tocar este
 *    archivo. Acá se mira el marcador, no el campo: es lo que hace que este archivo no dependa de la
 *    honestidad del de al lado.
 * 2. `status === "settled"` NO prueba que el vault se liberó. `settled` dice que el partner de payout
 *    reportó haber entregado los PEN; la release del vault la dispara hoy una persona a mano y este
 *    repo no la llama nunca (confirm-and-send.ts:283-292). Son dos hechos distintos y sólo tenemos
 *    el primero, así que una remesa entregada también cae en `unverified`.
 * 3. Un `failureReason` de depósito NO sigue valiendo después de un `refunded`. `principal_settled_
 *    refund_manual` describe el depósito de ANTES de que la persona lo recuperara, y RecoverEscrowFunds
 *    conserva ese reason cuando la remesa ya venía de payout_failed (recover-escrow-funds.ts:76). Leer
 *    el marcador sin mirar el status le diría "tus USDC están en el escrow" a quien ya los tiene en la
 *    wallet. Por eso `refunded` se resuelve PRIMERO y por sí solo.
 */
export type EscrowKnowledge = "no-deposit" | "in-escrow" | "returned" | "unverified";

export function escrowFundsKnowledge(rem: RemittanceState): EscrowKnowledge {
  // 1. `refunded` es terminal y se resuelve entero acá, antes de mirar ningún marcador de depósito:
  //    el depósito que esos marcadores describen es justamente el que ya pudo volver (trampa 3).
  //    Sólo el marcador del sender afirma la vuelta; cualquier otro `refunded` cae del lado que no
  //    afirma nada del vault, que es el lado seguro.
  if (rem.status === "refunded")
    return rem.failureReason === ESCROW_REFUNDED_BY_SENDER ? "returned" : "unverified";
  // 2. Lo que la CADENA contestó cuando el settle no nos dio respuesta. Son enums estables escritos
  //    en un solo lugar (failAndRefund), no interpretaciones del status.
  if (rem.failureReason === PRINCIPAL_SETTLED_REFUND_MANUAL) return "in-escrow";
  if (rem.failureReason === PRINCIPAL_STATE_UNKNOWN) return "unverified";
  // 3. `principalTx` = vimos entrar el depósito. `confirmed` = firmamos la autorización y nunca
  //    registramos el desenlace, que es justo el caso en que el browser se cerró con los USDC en vuelo.
  if (rem.principalTx != null || rem.status === "confirmed") return "unverified";
  // 4. Todo lo demás: nunca salió. Incluye los fallos probados ANTES del broadcast, entre ellos
  //    `solana_settle_beneficiary_mismatch`, donde el guard de destino cortó y no hay tx viajando.
  return "no-deposit";
}

/**
 * Cuántas de estas remesas pierden el camino a sus USDC si se borra el almacenamiento local, partidas
 * en los dos casos que NO se pueden decir con la misma frase. Lo consume la advertencia del botón que
 * BORRA las remesas del dueño (ForgetKyc → repo.clearByOwner).
 *
 * Ese botón siempre fue más destructivo de lo que decía: su copy hablaba sólo de la verificación y
 * ya borraba las remesas. Mientras no había pantalla de historial el daño era invisible; ahora que
 * las remesas son alcanzables, borrarlas es perder el único camino que existe hacia ellas.
 *
 * Por qué DOS números y no uno: `inEscrow` son remesas cuyo depósito la cadena confirmó, y meterlas
 * en el mismo balde que las `unverified` haría que la advertencia dijera "no comprobamos" sobre plata
 * que sí comprobamos. Es el mismo error que esta HU vino a matar, sólo que en el otro sentido.
 *
 * Ojo con lo que estos números NO dicen: borrar el almacenamiento local no toca los USDC. La
 * advertencia que los use tiene que hablar de perder el CAMINO, nunca de perder la plata.
 */
export function escrowFundsAtRisk(items: RemittanceState[]): {
  inEscrow: number;
  unverified: number;
} {
  let inEscrow = 0;
  let unverified = 0;
  for (const r of items) {
    const k = escrowFundsKnowledge(r);
    if (k === "in-escrow") inEscrow += 1;
    else if (k === "unverified") unverified += 1;
  }
  return { inEscrow, unverified };
}

/** La frase que acompaña a cada valor. Ninguna afirma un estado del vault que no hayamos medido. */
export function escrowKnowledgeCopy(k: EscrowKnowledge): string {
  if (k === "returned") return "Tus USDC volvieron a tu wallet.";
  if (k === "in-escrow") return "Tus USDC quedaron en el escrow, a tu nombre.";
  if (k === "unverified") return "No comprobamos si tus USDC siguen en el escrow.";
  return "No llegaste a depositar.";
}

/**
 * Copy de los errores del refund del escrow (enum→frase fija, PII-free / CD-5).
 *
 * Existe porque la acción tenía UNA sola frase para todo: "No pudimos recuperar los fondos". Con el
 * caso indeterminado esa frase pasa a ser activamente engañosa: el error más probable ahí es
 * `escrow_not_found`, que significa "no hay depósito tuyo en el escrow", o sea, la buena noticia de
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

/** Mensaje humano + el código interno que lo originó. Van JUNTOS en un solo estado a propósito: con
 *  dos `useState` separados podían quedar desincronizados y mostrar el código de un fallo viejo
 *  debajo del mensaje de uno nuevo. */
export type FlowError = { message: string; code?: string };

/** Cota de lo que se muestra en pantalla como código. `humanError()` recibe el `message` de
 *  cualquier Error, y algunos traen texto largo de una librería o de un fetch. */
const MAX_CODE_LEN = 80;

/**
 * El código corto que se muestra debajo del mensaje humano.
 *
 * Existe porque `humanError()` tiene un default ("Algo salió mal") y ese default BORRABA la única
 * pista de qué falló: un reporte desde un celular llegaba sin nada que buscar en el código. Mostrar
 * el código no es filtrar nada sensible, los códigos de este flujo son etiquetas fijas del dominio.
 *
 * Devuelve `undefined` para un mensaje vacío: es preferible no mostrar nada a mostrar un renglón en
 * blanco que parece un error de render.
 */
export function shortErrorCode(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_CODE_LEN ? `${trimmed.slice(0, MAX_CODE_LEN)}…` : trimmed;
}

/** Traduce un código de error interno a copy humano para la UI. */
export function humanError(code: string): string {
  if (code.includes("quote_expired") || code.includes("QUOTE_STALE"))
    return "La tasa cambió. Revisá el nuevo monto.";
  // Familia rechazo-de-cotización. Los tres caían en el default "Algo salió mal. Intentá de nuevo",
  // que para un monto fuera de rango es un consejo equivocado: intentar de nuevo con el mismo monto
  // vuelve a fallar. El texto nombra la causa y la única acción que la arregla.
  // El mínimo se formatea desde la MISMA constante que usa el guard de la pantalla, así que no
  // puede quedar desactualizado respecto de lo que el flujo exige. Del techo no hay copia local: el
  // agente es la autoridad y no publicamos un número que no tenemos.
  if (code.includes("fx_amount_below_minimum"))
    return `El monto es menor al mínimo que acepta este corredor. Probá con ${MIN_SEND_USD} dólares o más.`;
  if (code.includes("fx_amount_above_maximum"))
    return "El monto supera el máximo que este corredor acepta por envío. Probá con un monto menor.";
  if (code.includes("a2a_quote_rejected"))
    return "No pudimos cotizar este envío: el corredor lo rechazó. Probá con otro monto.";
  // CD-5: ANTES de includes("kyc") — el string "kyc_pending_unavailable" contiene "kyc".
  if (code.includes("kyc_pending_unavailable") || code.includes("pending_unavailable"))
    return "No pudimos preparar la verificación. Probá de nuevo.";
  if (code.includes("no_wallet"))
    return "No se detectó una wallet instalada. Instalá o desbloqueá tu wallet.";
  if (code.includes("no_account") || code.includes("wallet_not_connected"))
    return "Reconectá o desbloqueá tu wallet para continuar.";
  // Familia wallet_*: hasta acá TODOS estos códigos caían en el default "Algo salió mal", que es lo
  // que veía quien intentaba conectar desde el celular. Cada rama nombra una causa distinta; ninguna
  // afirma más de lo que la librería nos dice.
  if (code.includes("wallet_connect_cancelled"))
    return "Se cerró el selector de wallet sin conectar. Podés volver a intentarlo cuando quieras.";
  if (code.includes("wallet_connect_timeout"))
    return "La wallet tardó demasiado en responder. Probá de nuevo.";
  if (code.includes("wallet_window_closed"))
    return "Se cerró la ventana de la wallet antes de terminar. Probá de nuevo.";
  if (code.includes("wallet_window_blocked"))
    return "El navegador bloqueó la ventana de la wallet. Permití las ventanas emergentes para este sitio.";
  // NO decimos "la rechazaste": la librería usa el mismo error para el rechazo de la persona y para
  // un fallo interno de la wallet. Nombramos las dos y no elegimos.
  if (code.includes("wallet_connect_failed"))
    return "La wallet no llegó a conectarse. Puede que la conexión se haya rechazado, o que la wallet haya fallado. Probá de nuevo.";
  // No pudimos leer la dirección de la wallet. Es local y es trivial, y sin embargo antes se decía
  // como "No pudimos verificar tu identidad" (la autoridad de payout devolvía kyc_reauth_failed al
  // canonicalizar un string vacío). El texto nombra la causa real y la acción que la arregla, y dice
  // lo único que se puede afirmar del dinero: el corte fue antes de mover nada.
  if (code.includes("wallet_address_unavailable"))
    return "No pudimos leer la dirección de tu wallet. Reconectala y volvé a intentar: no se movió ningún USDC.";
  // Le falta SOL para el rent de las cuentas del escrow. El texto tiene que decir tres cosas que antes
  // no decía ninguna: cuánto hace falta, por qué hace falta (el fee lo paga WasiAI, el rent no), y que
  // no se movió nada. Sin esto, esta causa salía por el peor camino posible: "No sabemos todavía si te
  // cobramos", que es lo que la pantalla dice cuando el depósito puede estar en el escrow.
  // El número NO está escrito a mano: se formatea desde la MISMA constante que compara el guard, así
  // que no puede quedar desactualizado respecto de lo que el código exige.
  if (code.includes("solana_sender_sol_insufficient"))
    return `Te falta SOL en la wallet: necesitás al menos ${formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEPOSIT)} SOL para crear las cuentas del escrow. La comisión de red la pagamos nosotros, pero ese depósito de las cuentas sale de tu wallet. Cargá SOL y volvé a intentar: no se movió ningún USDC.`;
  // Nuestro servidor no pudo consultar el registro de direcciones preparadas y cortó ANTES de
  // reenviar la transacción (route.ts:126-133, antes del fetch de la línea 156). Sin frase propia
  // caía en el default "Algo salió mal", que no dice ni que la plata está quieta ni que reintentar
  // sirve. Y antes de tener reason propio era peor: salía por "No sabemos todavía si te cobramos",
  // o sea que la pantalla dudaba de algo que el código sabía con certeza.
  // No promete un reembolso porque no hay nada que reembolsar, y nombra la única acción útil.
  if (code.includes("solana_settle_ledger_unavailable"))
    return "No pudimos comprobar la dirección de destino, así que cortamos el envío antes de transmitir nada: no se movió ningún USDC de tu wallet. Es una falla temporal nuestra, probá de nuevo en un rato.";
  if (code.includes("wallet_bridge_not_mounted") || code.includes("wallet_sign_not_available"))
    return "La wallet todavía no está lista. Recargá la página y probá de nuevo.";
  if (code.includes("wallet_error"))
    return "La wallet devolvió un error que no reconocemos. Probá de nuevo.";
  if (code.includes("kyc")) return "No pudimos verificar tu identidad.";
  if (code.includes("payout")) return "No se pudo entregar. Si te cobramos, te reembolsamos.";
  return "Algo salió mal. Intentá de nuevo.";
}
