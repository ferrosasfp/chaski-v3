import type { Money } from "../domain/money"; import type { EscrowChainState } from "../application/ports"; // WKH-349: EN ESTA LÍNEA, no en una nueva — `:25`, `:29`, `:30`, `:206`, `:253`, `:327`, `:329` y `:1137` de este archivo los cita otro por número y están TODOS debajo de acá
import type { RemittanceState, RemittanceStatus } from "../domain/remittance";
import {
  PRINCIPAL_SETTLED_REFUND_MANUAL,
  PRINCIPAL_STATE_UNKNOWN,
} from "../application/use-cases/confirm-and-send";
import { ESCROW_REFUNDED_BY_SENDER } from "../application/use-cases/recover-escrow-funds"; import { laBilleteraFueTocada } from "./solana/wallet-error-code"; // WKH-339/CR: EN ESTA LÍNEA, no en una nueva — `:25`, `:29`, `:30`, `:206` y `:253` de este archivo los cita otro por número
import {
  ESCROW_DEPOSIT_RENT_LAMPORTS,
  SENDER_MIN_LAMPORTS_FOR_DEPOSIT,
  formatLamportsAsSol,
  formatLamportsAsSolFloor,
} from "../application/solana-escrow-rent";
import { KYC_PROVENANCE_LIVE } from "../infrastructure/didit/decision";

/** Proveniencias de payout que representan un desembolso REAL (allowlist fail-safe, CD-8). Cualquier
 *  valor desconocido/typo cae del lado seguro → muestra el banner (over-warn), nunca lo oculta.
 *  Exemplar: REAL_KYC_PROVENANCES = new Set(["didit"]) en el agente KYC. La misma dirección se aplica
 *  al KYC más abajo, en `REAL_KYC_PROVENANCES` de este archivo.
 *
 *  Se EXPORTA (y no se copia a ningún lado) porque el smoke de devnet decide con este mismo conjunto
 *  si abortar: `scripts/smoke-helpers.ts` lo importa. Un segundo Set con los mismos valores es
 *  exactamente cómo se desincronizan las dos capas. La comparación es EXACTA (`Set.has`), acá y allá:
 *  "TransFi" NO está en el conjunto. */
import { REAL_PAYOUT_PROVENANCES } from "../domain/payout-provenance"; export { REAL_PAYOUT_PROVENANCES }; // CR/MNR-4: BAJÓ a domain/ (capas). Se importa Y se re-exporta en UNA línea: `isPayoutDemo` (`:30`) necesita el binding local, y las 4 citas a `:25` y el candado de `smoke-helpers.test.ts:327` no se pueden mover

/** true si la proveniencia del payout indica un desembolso NO real (mock). `null`/`undefined`
 *  (remesa sin payout aún / legacy) → false (no fuerza el banner por ausencia de dato). */
export function isPayoutDemo(p: string | null | undefined): boolean {
  return p != null && !REAL_PAYOUT_PROVENANCES.has(p);
}

/**
 * Los ORÍGENES DE VERIFICACIÓN QUE PODEMOS AFIRMAR (allowlist fail-safe, misma dirección que
 * `REAL_PAYOUT_PROVENANCES`). El valor NO se escribe a mano acá: se importa de la MISMA constante que
 * lo produce (`decision.ts`), así que un rename del literal rompe la compilación en vez de dejar esta
 * lista apuntando a un valor que ya nadie emite.
 *
 * 🔴 EL RE-ENCUADRE DE WKH-332/W4, Y ES DE SIGNIFICADO, NO DE DIRECCIÓN. Este conjunto se leía como
 * "qué proveedor usamos", una lista de nuestros integrados. Con el catálogo abierto esa lectura invita
 * al error exacto que CD-7 prohíbe: pensar que si el gateway eligió a alguien, ese alguien "verifica".
 * Lo que la lista significa es lo otro: de qué orígenes podemos AFIRMAR en pantalla que hubo una
 * verificación. Nada más.
 *
 * ⛔ PROHIBIDO volverla env (mismo motivo que los pisos de reputación: una env con default ausente es
 * un control que se apaga solo en un entorno nuevo, sin que falle nada).
 * ⛔ PROHIBIDO derivar "es real" de que el gateway haya elegido al agente, de su `verified` o de su
 * reputación: `verified` y `reputation` los AUTO-REPORTA el propio card del agente, y el gateway sólo
 * los neutraliza cuando el step viaja con `min_reputation` (CD-7). Un desconocido que declara
 * `verified: true` no verificó a nadie.
 *
 * 🔴 POR QUÉ ES UNA ALLOWLIST Y NO UN `=== "local-fallback"`. Acá vivía la comparación contra el
 * único valor simulado CONOCIDO, o sea que todo lo desconocido se leía como real. Con `DIDIT_ENV=mock`
 * la decisión llega con `didit-mock` (decision.ts:22 y :91, vía `DiditKycGateway`, que sólo cae al
 * fallback si el server contesta 501): el sello de demo no se prendía y la pantalla de `confirm`
 * escribía "Identidad verificada" sobre datos que nadie verificó. Invertida la dirección, lo
 * desconocido SOBRE-AVISA: un valor nuevo, un typo o una proveniencia que este archivo no conoce
 * prende el sello, que es el error gratis. El error caro es el otro.
 *
 * El consumidor autoritativo del lado del dinero sigue siendo `REAL_KYC_PROVENANCES` de
 * `wasiai-remittance-agents/src/providers/kyc.ts` (es el que abre el desembolso). Este conjunto es
 * el de la PANTALLA y no decide nada del money-path: sólo decide qué se puede afirmar en pantalla.
 */
export const REAL_KYC_PROVENANCES: ReadonlySet<string> = new Set([KYC_PROVENANCE_LIVE]);

/**
 * true si la verificación de identidad NO se puede afirmar como real.
 *
 * ⚠️ AUSENTE O VACÍA CUENTA COMO NO REAL, y es lo contrario de `isPayoutDemo`. La diferencia no es un
 * descuido: `payoutProvenance` ausente significa "esta remesa todavía no tiene payout", un estado
 * normal del que no hay nada que avisar. Un `KycVerification` que EXISTE y no declara de dónde salió
 * es otra cosa: es un objeto que la pantalla ya está mostrando como identidad de la persona. Ausencia
 * de dato no es prueba de que sea real. Es alcanzable en producción por dos caminos, no hipotéticos:
 * `kyc-gateway.ts`:52 castea la respuesta HTTP sin validar (`provenance` puede no venir), y
 * `kyc-store.ts`:86 / `persistence.ts`:64 rehidratan snapshots viejos con un spread, así que un
 * snapshot guardado antes de que el campo existiera vuelve con `undefined`.
 *
 * Quién NO llega acá: una remesa sin KYC (`rem.kyc == null`). Eso lo filtra `isDemoMode`, porque ahí
 * no hay ninguna verificación que la pantalla pueda estar afirmando de más.
 */
export function isKycDemo(p: string | null | undefined): boolean {
  return typeof p !== "string" || !REAL_KYC_PROVENANCES.has(p);
}

/**
 * La frase que dice POR QUÉ esta identidad no se muestra como verificada. Nunca afirma que los datos
 * sean falsos ni que nadie los haya mirado: afirma lo ÚNICO comprobable con un input concreto, que su
 * origen no está en `REAL_KYC_PROVENANCES`. Con `didit-mock` sale el valor tal cual, que es lo que
 * hace la frase falsable a simple vista.
 *
 * El `provenance` se muestra en claro a propósito: es una etiqueta de configuración de un conjunto
 * chico (mismo criterio que el eco de `DIDIT_ENV` en `didit-env.ts`:76-81), nunca un secreto ni PII.
 */
export function kycOriginNotice(p: string | null | undefined): string {
  const raw = typeof p === "string" ? p.trim() : "";
  if (!raw)
    return "Estos datos no dicen de qué verificador salieron, así que no podemos llamarlos verificados.";
  return `Estos datos salieron de "${raw}", que no está en la lista de verificadores reales.`;
}

/** "Modo demo" ⇔ alguno de los tres pasos del flujo no está confirmado como real: la cotización vino
 *  del fallback local, la verificación no salió de un verificador de la allowlist, o el desembolso no
 *  salió de un partner de la allowlist. */
export function isDemoMode(rem: RemittanceState): boolean {
  return (
    rem.quote?.provenance === "local-fallback" ||
    (rem.kyc != null && isKycDemo(rem.kyc.provenance)) ||
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
 * condición, nunca de deducir un final a partir del status. ⚠️ Y SIGUE SIN LEERLA después de WKH-349, que NO tocó esta función: esa HU agregó una capa ENCIMA —(`escrowOutcome`, `:1193`) y (`escrowOutcomeDisplay`, `:1251`), al final de este archivo— que le pregunta a la cadena por el bucket `unverified` cuando se abre el historial. O sea que la PANTALLA de historial hoy sí mira la cadena; esta función, no. Si leés este docblock y concluís que el historial nunca mira la cadena, la conclusión es vieja.
 *
 * - `returned`   los USDC volvieron. Lo respalda `ESCROW_REFUNDED_BY_SENDER`, que RecoverEscrowFunds
 *                escribe recién con `confirmation === "confirmed"` (recover-escrow-funds.ts:70-77),
 *                o sea después de ver la tx del refund confirmada.
 * - `in-escrow`  los USDC están en el vault, a nombre de la persona. Lo respalda
 *                `PRINCIPAL_SETTLED_REFUND_MANUAL`, que ConfirmAndSend escribe SÓLO cuando el probe
 *                le contestó `"deposited"`, y ese probe le pregunta A LA CADENA
 *                (confirm-and-send.ts:112-117 + ports.ts `SolanaEscrowDepositProbe`). Es el segundo
 *                hecho de la cadena que un snapshot puede contener, y llegó con el fix del reembolso
 *                fabricado: antes esta remesa no existía como estado propio.
 * - `unverified` se autorizó o entró un depósito y NADIE leyó el vault desde entonces, o lo leímos y
 *                la cadena no contestó (`PRINCIPAL_STATE_UNKNOWN`). Puede haber USDC ahí o no.
 * - `no-deposit` sabemos que el depósito NO salió: nunca se autorizó, o el intento murió ANTES del
 *                broadcast y eso está probado (SETTLE_REASONS_BEFORE_BROADCAST en
 *                confirm-and-send.ts:47-52, que incluye `solana_settle_beneficiary_mismatch`). No
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
 *    repo no la llama nunca — y eso es una AUSENCIA, así que no se prueba con un número de línea
 *    sino con el comando que la refutaría:
 *    `command grep -rn "release(\|releaseEscrow\|buildRelease\|releaseIx" src/ app/ --include=*.ts --include=*.tsx`
 *    devuelve CERO líneas (exit 1) — no existe ningún call-site del leg de release del escrow.
 *    Son dos hechos distintos y sólo tenemos
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

/**
 * Copy de los errores de la puerta "Recuperar un envío perdido" (la recuperación SIN remittanceId).
 *
 * Existe porque el MISMO código significa dos cosas distintas según por dónde se entró, y la más
 * cara es `escrow_not_found`:
 *
 *  · En la acción normal el id es conocido, así que "no encontramos un depósito tuyo en el escrow"
 *    habla de UNA remesa concreta y la frase de `escrowRefundError` es correcta.
 *  · Acá el id no existe: se le pide la lista al store durable server-side y se sondean hasta
 *    `maxCandidates` PDAs on-chain (`resolveRemittanceIdFromLedger`, `solana-wallet.ts:353`). `escrow_not_found` sale de DOS
 *    situaciones que no se distinguen desde afuera: el servidor no devolvió ningún id, o ninguno de
 *    los sondeados estaba `Deposited`. Ninguna de las dos prueba que la persona no tenga fondos.
 *
 * Por eso la frase habla de lo que MIRAMOS, no de lo que la persona tiene. `maxCandidates` entra por
 * parámetro y no como un número escrito acá: el llamador pasa la MISMA constante que sondea
 * (`MAX_RECOVERY_CANDIDATES`), así que el copy no puede quedar diciendo un número que el código dejó
 * de usar.
 */
export function lostEscrowRecoveryError(code: string, maxCandidates: number): string {
  // 🔴 LA FASE DE LA TRANSACCIÓN, PRIMERA (AR/BLQ-BAJO-1). Esta puerta pide DOS firmas: la de posesión
  // (adentro del resolver) y la de la orden de devolución. Las dos las escribe la misma billetera con
  // el mismo texto, así que la regexp de abajo NO puede distinguirlas: la fase la etiqueta
  // `refundEscrow` con este código, que es lo único que llega acá pudiendo decir cuál de las dos fue.
  // Para llegar a emitirse hicieron falta las cuatro cosas que este texto afirma: se firmó la
  // posesión, el servidor contestó, se miró la cadena, y había un escrow de esta billetera abierto y
  // vencido. Decir "no llegamos a preguntar" acá sería falso, y encima tiraría la información útil.
  if (code.includes("escrow_refund_signature_incomplete"))
    return "Encontramos un envío tuyo todavía abierto en el escrow y ya vencido, así que se puede recuperar. Lo que no se completó es la segunda firma, la de la orden que devuelve tus USDC a tu billetera. Volvé a intentar y aceptá esa segunda firma.";
  // PRIMERA a propósito, y es seguro: ninguno de los tres literales que esta regexp reconoce contiene
  // la subcadena `escrow_not_found`, así que no le roba casos a la rama de abajo. Eso no se supone:
  // lo vigila el control de orden de ramas en `flow-vm.test.ts`, que exige que `escrow_not_found`
  // siga saliendo por su texto. Sin ese control, ensanchar esta regexp sería invisible.
  // ⚠️ El string lo escribe la wallet y no lo controlamos ("User rejected the request." en Phantom).
  // La regexp está DUPLICADA de `escrowRentDiscoveryError` a propósito (CD-2 prohíbe tocar esa
  // función para extraerla a una constante). Que las dos no diverjan lo vigila el guard de CD-12.
  if (/user rejected|wallet_connect_cancelled|wallet_sign_not_available/i.test(code))
    return "No se completó la firma que prueba que la billetera es tuya, así que no llegamos a preguntar. Esto no es una respuesta sobre tus fondos: volvé a intentar y aceptá la firma.";
  // WKH-347 — ANTES de `escrow_not_found` y con los textos en el apéndice (los `function` se hoistean).
  // Es seguro: ninguno de los dos literales contiene la subcadena `escrow_not_found`, así que no le
  // roban casos a la rama de abajo. Eso NO se supone: lo vigila el control de orden de ramas.
  if (code.includes("escrow_index_absent")) return sinIndiceCopy(maxCandidates);
  if (code.includes("escrow_index_unreadable")) return indiceIlegibleCopy();
  if (code.includes("escrow_not_found"))
    return sinAbiertosCopy(maxCandidates); // el texto vive en el apéndice; `esVentanaSinAbiertos` lo reconoce delegando acá
  // "No pudimos preguntar" no es "no hay nada". Cinco productores llegan acá, no dos.
  // `escrow_id_unavailable` = esta pantalla no tiene el resolver cableado. `escrow_recovery_unavailable`
  // llega con CUATRO orígenes: el endpoint contestó algo que no es 200/403/501
  // (`escrow_recovery_unavailable`, `http-solana-remittance-id-resolver.ts:40`), y los TRES `not_asked`
  // que el refund empezó a propagar en WKH-331 con el motivo pegado al código
  // (`pop_disabled` / `registry_disabled` / `pop_rejected`). Los cuatro se dicen IGUAL: la persona no
  // puede hacer nada distinto con cada uno, y el motivo NO se interpola en el texto (CD-5). En los
  // cinco casos no llegamos a mirar la cadena.
  if (code.includes("escrow_id_unavailable") || code.includes("escrow_recovery_unavailable"))
    return "No pudimos consultar el registro de envíos. Esto no es una respuesta sobre tus fondos: no llegamos a preguntar. Probá de nuevo en un rato.";
  // 🔴 LA FASE DE LA CONEXIÓN, que salía por la red de seguridad diciendo "no sabemos hasta dónde
  // llegamos" (AR/MNR-9). Acá SÍ sabemos: no se llegó a nada. Esta puerta arranca con
  // `resolveSender()` → `connectWallet.execute()` → `SolanaWalletAdapter.connect()`, y estos códigos
  // salen todos de ese método ANTES de que exista una address con la que preguntarle nada al registro
  // (`connect`, `solana-wallet.ts:188`): `wallet_bridge_not_mounted` lo tira `openModal` si el árbol
  // de providers no montó; los otros cuatro rechazan `waitForConnection`, tres de ellos vía
  // `walletErrorCode` desde el `onError` del provider (`failConnection`, `solana-providers.tsx:213`)
  // e `invalid_address` desde el chequeo base58 del propio adapter.
  //
  // 🔴 EL POPUP BLOQUEADO VA APARTE, y no es cosmético: para esa causa "probá de nuevo en un rato" —lo
  // que decía la red de seguridad— es un callejón sin salida. Reintentar con el bloqueador puesto
  // vuelve a fallar siempre; lo único que lo destraba es permitir las ventanas emergentes.
  if (code.includes("wallet_window_blocked"))
    return "El navegador bloqueó la ventana de tu billetera, así que no llegamos a preguntar. Esto no es una respuesta sobre tus fondos: permití las ventanas emergentes para este sitio y volvé a intentar.";
  // ⚠️ DOS CÓDIGOS DE LA MISMA FAMILIA QUE NO ENTRAN ACÁ, a propósito:
  //  · `wallet_not_connected` sale de `connect()` también, pero ya tiene copy propio y accionable por
  //    la enumeración de abajo ("Reconectá o desbloqueá tu wallet"), que no afirma nada sobre fondos.
  //  · `wallet_error:<Nombre>` (un error de la librería que no sabemos nombrar) se queda en la red de
  //    seguridad: es justo el caso en que "no sabemos hasta dónde llegamos" es lo cierto, y afirmar la
  //    fase apoyándose en qué errores puede inventar mañana una dependencia sería afirmar de más.
  // Y `no_wallet` NO se enumera porque no tiene productor: su mapeo se borró (ver `humanError` más
  // abajo), y un `WalletNotReadyError` sale hoy como `wallet_error:WalletNotReadyError`.
  if (
    /wallet_bridge_not_mounted|wallet_connect_timeout|wallet_window_closed|wallet_connect_failed|invalid_address/.test(
      code,
    )
  )
    return "No llegamos a conectar tu billetera, así que no llegamos a preguntar. Esto no es una respuesta sobre tus fondos: conectá la billetera y volvé a intentar.";
  // Lo que SÍ es una respuesta sobre el dinero, y por eso sigue saliendo por `escrowRefundError`. Va
  // enumerado y no como un `else`: es la lista de códigos sobre los que se puede afirmar algo.
  // `refund_tx_failed` no lo reconoce esa función y cae a su default, que para ESE código es cierto:
  // `confirmRefund` sólo lo tira habiendo MEDIDO que la tx entró en un bloque y revirtió, y que el
  // escrow no quedó Refunded. Ahí "no pudimos recuperar los fondos" es exactamente lo que pasó.
  if (
    /escrow_not_deposited|refund_before_deadline|wallet_not_connected|no_account|refund_tx_failed/.test(
      code,
    )
  )
    return escrowRefundError(code);
  // 🔴 LA RED DE SEGURIDAD, que antes no existía (AR/MNR-3). Acá caía el default de `escrowRefundError`
  // ("No pudimos recuperar los fondos. Intentá de nuevo."), y por acá salen desenlaces que son un "no
  // llegamos a preguntar" y no un fracaso: `pop_challenge_unavailable` (el 429 del rate-limit del
  // challenge, que se saca con dos clicks seguidos en "Buscar", y el 503 fail-closed) y el
  // "Failed to fetch" del navegador sin red. Ninguno de los dos sabe si la plata está o no.
  // Este texto tampoco puede irse al otro extremo: no afirma que no preguntamos (puede haber fallado
  // después de preguntar, incluso después de firmar), afirma lo único cierto, que no sabemos dónde se
  // cortó. Los códigos que SÍ responden sobre el dinero ya salieron arriba.
  return "Algo se cortó antes de terminar. No sabemos hasta dónde llegamos, así que esto no es una respuesta sobre tus fondos. Probá de nuevo en un rato.";
}

// ── WKH-327 · el copy del cierre de cuentas ─────────────────────────────────────────────────────────
/**
 * Qué recupera la persona al cerrar, en su idioma.
 *
 * 🔴 La cifra sale de `formatLamportsAsSolFloor(ESCROW_DEPOSIT_RENT_LAMPORTS)`, NUNCA de un literal.
 * Un "0,0040" escrito a mano es lo que permite que la constante y el copy diverjan sin que nada se
 * ponga rojo. Y el FLOOR no es un detalle de estilo: `formatLamportsAsSol` (ceil) devuelve "0,0041"
 * para este mismo valor, que es EXACTAMENTE la misma cadena que el umbral del depósito — o sea que con
 * el ceil el copy sobreestima 2,4% lo que la persona cobra, y además un test no puede distinguir si se
 * formateó la constante correcta.
 *
 * Lo que este texto NO dice, a propósito:
 *  · No dice "recuperá tu alquiler" a secas: dice CUÁLES dos cuentas.
 *  · No suma ni nombra el `EscrowIndex` en la cifra. Lo menciona aparte, como lo que NO vuelve.
 *  · No promete un neto. Dice que hay comisión y que NO sabemos cuánto agrega la billetera: la propina
 *    que inyecta es una incógnita declarada del propio repo (`propina`, `solana-escrow-rent.ts:128`) y esta
 *    acción además no declara ComputeBudget, así que tampoco hay un techo de CU que la acote.
 *
 * 🔴 POR QUÉ HAY DOS VOCES Y POR QUÉ EL PARÁMETRO NO TIENE DEFAULT (fix-pack CR/BLQ-BAJO-1). Este
 * texto tenía UN solo `body`, escrito en la voz de un envío concreto y ya terminado ("las dos cuentas
 * de ese envío", "Este envío ya terminó, así que se pueden cerrar"). Es correcto en `CloseEscrowAction`,
 * que recibe un `remittanceId`. Pero la PUERTA de descubrimiento lo monta antes de que exista ninguna
 * selección: ahí no hay envío del que hablar, y la frase afirmaba un hecho sobre una remesa que
 * todavía no se había buscado. Peor: cuando el descubrimiento fallaba, la pantalla quedaba diciendo
 * las dos cosas juntas, "Este envío ya terminó" y "no llegamos a preguntar".
 *
 * Por eso `voice` es OBLIGATORIO y no un booleano con default: un default elige por el call-site nuevo,
 * y el call-site nuevo es exactamente donde se coló este bug. Quien monte este texto tiene que decir si
 * ya tiene un envío o todavía no.
 *
 *  · "remittance" — hay UN envío elegido y ya terminado. Pasado, y afirma sobre él.
 *  · "discovery"  — todavía no hay ninguno. Presente general: describe el mecanismo y la CONDICIÓN
 *                   ("sólo se pueden cerrar las de un envío que ya terminó"), sin afirmar que la haya
 *                   cumplido nadie.
 *
 * Lo que NO cambia entre las dos, y es deliberado: la cifra, las dos cuentas nombradas, la comisión
 * declarada como desconocida y el `notRecovered`. Esos son hechos del mecanismo, no de un envío.
 */
export function escrowRentExplainer(voice: "discovery" | "remittance"): {
  title: string;
  body: string;
  notRecovered: string;
} {
  const monto = formatLamportsAsSolFloor(ESCROW_DEPOSIT_RENT_LAMPORTS);
  return {
    title: "Recuperá tu depósito de red",
    body:
      voice === "remittance"
        ? `Cuando enviaste, Solana retuvo ${monto} SOL tuyos para mantener abiertas las dos cuentas de ese envío: la del contrato y la que guardó tus USDC. Ese depósito es tuyo y vuelve a tu billetera al cerrarlas. Este envío ya terminó, así que se pueden cerrar. Vas a firmar una transacción y la red te va a cobrar su comisión por hacerla; cuánto exactamente lo decide tu billetera y no lo sabemos de antemano.`
        : `Cada envío deja abiertas dos cuentas en Solana, la del contrato y la que guardó tus USDC, y por mantenerlas la red retiene ${monto} SOL tuyos. Ese depósito es tuyo y vuelve a tu billetera cuando esas cuentas se cierran, y sólo se pueden cerrar las de un envío que ya terminó. Por cada uno que cierres vas a firmar una transacción y la red te va a cobrar su comisión por hacerla; cuánto exactamente lo decide tu billetera y no lo sabemos de antemano.`,
    notRecovered:
      "Hay una tercera cuenta, el índice de tu billetera, que no se cierra con esto y cuyo depósito no vuelve. Es una sola vez por billetera, no una por envío.",
  };
}

/**
 * El desenlace del cierre, con sus TRES valores separados.
 *
 * ⚠️ El texto de "confirmed" NO menciona los USDC, y es una regla, no una omisión: lo único que la
 * ausencia de `escrow_state` prueba es que las dos cuentas se cerraron. A dónde fue la plata no lo
 * dice — es la misma trampa que `probeEscrowRefunded` ya tiene escrita (`probeEscrowRefunded`, `solana-wallet.ts:1078`).
 */
export function escrowCloseSentCopy(confirmation: "confirmed" | "pending" | "unknown"): string {
  if (confirmation === "confirmed")
    return "Listo: las dos cuentas de ese envío están cerradas y su depósito volvió a tu billetera.";
  if (confirmation === "pending")
    return "Mandamos la orden de cierre y la red todavía no nos confirma que entró. No es un fallo: puede entrar en el próximo bloque. Podés volver a intentar en un rato.";
  return "Mandamos la orden de cierre y no pudimos preguntarle a la red si entró. No sabemos si las cuentas se cerraron; volvé a intentar más tarde.";
}

/**
 * Copy de los errores del cierre.
 *
 * ⚠️ `escrow_account_absent` NO es un error y su texto no lo trata como tal. Son DOS situaciones
 * indistinguibles desde el cliente — las cuentas ya se cerraron, o nunca llegaron a crearse — y en las
 * dos no hay alquiler que recuperar acá y nada salió mal. El texto nombra las dos y no dice "error" ni
 * "no pudimos": decir que algo falló cuando no falló nada le hace buscar un problema que no existe.
 */
export function escrowCloseError(code: string): string {
  if (code.includes("escrow_not_terminal"))
    return "Este envío todavía está en curso, así que sus cuentas no se pueden cerrar. Esto no dice dónde están tus USDC.";
  if (code.includes("escrow_account_absent"))
    return "No hay cuentas abiertas para este envío: o ya se cerraron, o nunca llegaron a crearse. No hay depósito de red que recuperar acá.";
  // Los TRES inputs que producen este código (RPC caído, techo de tiempo vencido, bytes que no
  // decodifican) están colapsados a propósito aguas abajo: la persona no puede hacer nada distinto con
  // cada uno. Lo que sí importa decirle es que NO se firmó nada.
  if (code.includes("escrow_index_probe_failed"))
    return "No pudimos consultar la red para preparar el cierre, así que no firmamos nada. No se movió nada de tu billetera. Probá de nuevo en un rato.";
  if (code.includes("close_not_sender"))
    return "Este envío se firmó con otra billetera. El depósito de red vuelve a la que lo pagó, así que hay que conectar esa.";
  if (code.includes("close_tx_failed"))
    return "La red rechazó el cierre. Tu depósito sigue donde estaba y podés volver a intentar.";
  if (code.includes("escrow_state_unreadable"))
    return "No pudimos leer las cuentas de este envío, así que no firmamos nada. Probá de nuevo en un rato.";
  if (code.includes("wallet_not_connected") || code.includes("no_account"))
    return "Reconectá o desbloqueá tu wallet para continuar.";
  return "No pudimos cerrar las cuentas de este envío. Intentá de nuevo.";
}

/**
 * Copy del DESCUBRIMIENTO de envíos cerrables (AC-8), cuando la cadena SÍ contestó y no hay nada.
 *
 * Es la ÚNICA función de este par que puede afirmar algo sobre las cuentas de la persona, y por eso
 * es la única que se llama desde el camino feliz de `listCloseable` (la lista vacía). Si te encontrás
 * queriendo llamarla desde un `catch`, la respuesta es no: ahí no miramos nada.
 *
 * ⚠️ DE QUÉ PREMISA CUELGA ESTA FRASE, dicho porque ya se rompió una vez (AR/BLQ-MED-2). "La lista
 * vacía = el servidor contestó y no hay nada" es cierto SÓLO porque `listCloseable` consume
 * `lookupBySender`, que separa "contestó" de "no llegamos a preguntar", y tira ante lo segundo. Antes
 * consumía `listBySender`, que colapsa las tres degradaciones del resolver (PoP apagado, registro
 * apagado, PoP rechazado) en `[]`, y esta frase salía en pantalla —medida, textual— sin que nadie
 * hubiera mirado ni un envío. Si alguien vuelve a alimentar esta función desde un `[]` que no probó
 * ser una respuesta, el texto vuelve a mentir sin que se rompa nada.
 *
 * `maxCandidates` entra por parámetro y no como número escrito acá, por la misma razón que en
 * `lostEscrowRecoveryError`: el llamador pasa la MISMA constante que sondea
 * (`MAX_CLOSEABLE_CANDIDATES`), así que el copy no puede quedar diciendo un número que el código dejó
 * de usar.
 */
export function escrowRentDiscoveryEmpty(maxCandidates: number): string {
  return `No encontramos envíos terminados con cuentas abiertas para esta billetera. Miramos los últimos ${maxCandidates} envíos que el servidor tiene guardados de ella.`;
}

/**
 * Copy del DESCUBRIMIENTO cuando NO llegamos a preguntar (AC-8).
 *
 * 🔴 POR QUÉ ESTA FUNCIÓN NO PUEDE DECIR "no encontramos", NUNCA, POR NINGÚN CÓDIGO. Acá se entra
 * sólo desde un `catch`, y una excepción significa que la consulta no terminó: no hay ninguna
 * observación sobre las cuentas de la persona que se pueda reportar. `listCloseable` propaga a
 * propósito (`solana-wallet.ts`, razón 3 de su docblock: "🚫 SI EL RPC LANZA, PROPAGA. NUNCA devuelve
 * []") y ese trabajo se tira a la basura si el copy vuelve a colapsar los dos desenlaces.
 *
 * ⚠️ ESTO ESTUVO AL REVÉS Y ASÍ SE ESCAPÓ (AR/BLQ-MED-1). La función reconocía DOS códigos y todo lo
 * demás caía a un `return` final que decía "No encontramos envíos terminados… Miramos los últimos 20".
 * Medido: con el RPC apuntado a un puerto muerto, el mensaje que el adapter propaga de verdad es
 * `"fetch failed"` — que no contiene ninguno de los dos códigos. O sea que la pantalla afirmaba haber
 * mirado 20 envíos justo cuando no había mirado ninguno. El default ahora es el desenlace honesto, y
 * los códigos conocidos sólo AFINAN de qué consulta hablamos.
 *
 * El código de la wallet NO se interpola (CD-5): esto es enum→copy fijo, igual que `escrowCloseError`.
 */
export function escrowRentDiscoveryError(code: string): string {
  // El rechazo de la firma de posesión. La persona cerró el popup: no es una falla nuestra ni de la
  // red, y decirle "no pudimos consultar" la manda a esperar a que algo se arregle solo.
  // ⚠️ El string lo escribe la wallet y no lo controlamos ("User rejected the request." en Phantom).
  // Si algún día no matchea, cae al default de abajo, que TAMBIÉN dice "no llegamos a preguntar": la
  // rama es una mejora del mensaje, nunca lo que sostiene la honestidad.
  if (/user rejected|wallet_connect_cancelled|wallet_sign_not_available/i.test(code))
    return "No se completó la firma que prueba que la billetera es tuya, así que no llegamos a preguntar. Esto no es una respuesta sobre tus cuentas: volvé a intentar y aceptá la firma.";
  // Acá caen también los tres códigos `escrow_recovery_unavailable:<motivo>` que el descubrimiento
  // emite cuando el registro no nos contestó (PoP apagado / registro apagado / PoP rechazado). Los
  // tres se dicen IGUAL a propósito: la persona no puede hacer nada distinto con cada uno, y el motivo
  // viaja en el código para el diagnóstico. El motivo NO se interpola en el texto (CD-5).
  if (code.includes("escrow_id_unavailable") || code.includes("escrow_recovery_unavailable"))
    return "No pudimos consultar el registro de envíos. Esto no es una respuesta sobre tus cuentas: no llegamos a preguntar.";
  return "No pudimos consultar la red para buscar tus envíos. Esto no es una respuesta sobre tus cuentas: no llegamos a preguntar.";
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
  // 🔴 ACÁ VIVÍAN DOS RAMAS `fx_*` Y SE FUERON EN WKH-332/W4 (AC-5), con la regresión declarada.
  //
  // Eran el copy de `fx_amount_below_minimum` ("Probá con N dólares o más") y de
  // `fx_amount_above_maximum`. `fx_*` es el vocabulario PRIVADO de un agente concreto, y llegaba acá
  // porque el carril punto a punto leía el body de error del agente y relayaba su `reason`. Ese
  // carril se borró: por `/compose` el step fallado viaja SIN `code` y SIN `reason`, así que NINGÚN
  // productor puede emitir esos códigos. Dejar el copy habría hecho que la pantalla PAREZCA capaz de
  // nombrar la causa de un rechazo de monto cuando AC-4 está declarado NO CUMPLIDO — una promesa que
  // el código no puede sostener, que es peor que la regresión.
  //
  // ⚠️ CONSECUENCIA DECLARADA, no descubierta en producción: una remesa guardada ANTES de este deploy
  // puede tener `failureReason: "fx_amount_below_minimum"` en el almacenamiento local. Esa remesa
  // ahora lee el default genérico en vez del copy del mínimo. Es la misma regresión de AC-4 aplicada
  // al historial, y se acepta por la misma razón: el alternativo es una frase que afirma más que el
  // dato. El guard de la PANTALLA sigue impidiendo el envío por debajo del mínimo antes de cotizar
  // (`MIN_SEND_USD`), así que el caso nuevo se corta antes de llegar a un rechazo.
  //
  // El enum de FAMILIA sí se queda: `a2a_quote_rejected` es una palabra NUESTRA, no del agente, y es
  // lo único que una remesa vieja puede traer que siga siendo cierto (el corredor rechazó, sin decir
  // por qué).
  if (code.includes("a2a_quote_rejected"))
    return "No pudimos cotizar este envío: el corredor lo rechazó. Probá con otro monto.";
  // CD-5: ANTES de includes("kyc") — el string "kyc_pending_unavailable" contiene "kyc".
  if (code.includes("kyc_pending_unavailable") || code.includes("pending_unavailable"))
    return "No pudimos preparar la verificación. Probá de nuevo.";
  // ⚠️ ACÁ VIVÍA EL COPY DE `no_wallet`: "No se detectó una wallet instalada. Instalá o desbloqueá tu
  // wallet." Se borró por las dos razones a la vez, y cada una alcanzaba sola.
  //
  // 1. AFIRMABA SOBRE EL DISPOSITIVO. Un navegador no puede saber qué hay instalado en el teléfono:
  //    sólo si alguna wallet expuso su API en ESTE contexto. Quien tiene Phantom en el celular y abre
  //    Chaski en Chrome leía una frase falsa. Lo que sí se puede decir vive en `NoWalletHere`
  //    (`flow.tsx`), que habla del navegador y no del aparato.
  // 2. NADIE PODÍA LEERLA. `no_wallet` sale de un solo lugar (`walletErrorCode`, mapeando
  //    `WalletNotReadyError`) y esa excepción no tiene productor en esta app: la app nunca llama
  //    `useWallet().connect()` (única fuente del throw de `WalletProviderBase.js`:238), y el efecto de
  //    autoConnect ya exige `Installed || Loadable` antes de invocar al adapter, que es exactamente la
  //    condición que el adapter volvería a chequear para tirarla. El mapeo se borró junto con esta
  //    rama (`solana/wallet-error-code.ts`): si la librería alguna vez la emite, cae en
  //    `wallet_error:WalletNotReadyError` y el código se muestra en pantalla, que es lo que ese módulo
  //    promete para un nombre que no conocemos.
  if (code.includes("no_account") || code.includes("wallet_not_connected"))
    return "Reconectá o desbloqueá tu wallet para continuar."; if (code.includes("wallet_account_changed")) return "Estás conectado con otra cuenta, distinta de la que verificamos para este envío. Cambiá en tu billetera a la cuenta con la que empezaste y tocá \"Recotizar tasa\", o usá el aviso de arriba para pasarte a la que tenés conectada ahora y empezar un envío nuevo."; // WKH-354/AC-3: EN ESTA LÍNEA, no en una nueva — este archivo tiene que terminar en 1375 líneas (CD-16), porque lo citan por número desde muchos lados y `scripts/smoke-helpers.test.ts:336` vigila `:25` y `:30`
  // Familia wallet_*: hasta acá TODOS estos códigos caían en el default "Algo salió mal", que es lo
  // que veía quien intentaba conectar desde el celular. Cada rama nombra una causa distinta; ninguna
  // afirma más de lo que la librería nos dice.
  if (code.includes("wallet_connect_cancelled"))
    return "Se cerró el selector de wallet sin conectar. Podés volver a intentarlo cuando quieras.";
  // "La wallet tardó demasiado en responder" afirmaba que alguien le preguntó a una wallet, y este
  // código tiene DOS productores: `WalletTimeoutError` de la librería (ahí sí hubo una wallet lenta) y
  // el timeout propio del bridge (`solana-wallet-bridge.ts`:146-150), que salta al vencerse la espera
  // aunque la persona haya dejado el selector abierto sin elegir ninguna. En ese segundo caso no hubo
  // ninguna wallet a la que culpar. El texto dice lo único cierto en los dos: la conexión no se cerró
  // a tiempo.
  if (code.includes("wallet_connect_timeout"))
    return "La conexión no se completó a tiempo. Probá de nuevo.";
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
  // no decía ninguna: cuánto hace falta, por qué hace falta (el fee del depósito lo paga WasiAI, el
  // rent no), y que no se movió nada. Sin esto, esta causa salía por el peor camino posible: "No
  // sabemos todavía si te cobramos", que es lo que la pantalla dice cuando el depósito puede estar en
  // el escrow.
  // El número NO está escrito a mano: se formatea desde la MISMA constante que compara el guard, así
  // que no puede quedar desactualizado respecto de lo que el código exige.
  // "La comisión de red la pagamos nosotros" a secas pasó a ser falso cuando el umbral incorporó la
  // comisión del refund: ésa la paga el sender (`refundEscrow` fija `tx.feePayer = senderPk`), y es
  // parte de lo que se le está pidiendo que cargue. El texto ahora dice cuál de las dos es cuál.
  if (code.includes("solana_sender_sol_insufficient"))
    return `Te falta SOL en la wallet: necesitás al menos ${formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEPOSIT)} SOL. La comisión de red del depósito la pagamos nosotros; de tu wallet salen el alquiler de las cuentas del escrow y la comisión de la transacción con la que podrías recuperar tus USDC. Cargá SOL y volvé a intentar: no se movió ningún USDC.`;
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
  // WKH-333 — VA ANTES del catch-all de `kyc`, porque `prepare_kyc_verdict_missing` contiene "kyc" y
  // caería ahí. "No pudimos verificar tu identidad" es cierto pero no dice la ACCIÓN. Pasa cuando el
  // servidor no tiene fila del veredicto para la dirección que firmó (AC-17). El corte es ANTES del
  // prepare y ANTES de la primera firma, así que "no se movió ningún USDC" es un hecho del orden de
  // la ruta, no un consuelo.
  //
  // 🔴 LA ACCIÓN CAMBIÓ TRAS MEDIR QUIÉN LLEGA ACÁ (AR/BLQ-MED-1). Decía "Necesitamos verificar tu
  // identidad otra vez desde esta billetera", y para la mayoría de quienes ven este mensaje eso es un
  // consejo caro y equivocado: son personas YA verificadas cuya fila no se rellenó porque no hubo
  // firma al conectar (rechazada, emisor apagado, 429 del limiter). Para ellas el arreglo es
  // reconectar y aceptar la firma — ahí el backfill re-consulta a la autoridad con la pista del
  // navegador y escribe la fila SIN gastar otra verificación. Volver a escanear el documento es el
  // segundo intento, no el primero, y por eso va segundo en la frase.
  //
  // 🔴 Y LA PROMESA SE CAMBIÓ POR SU CONDICIÓN (CR/MNR-1). Decía "con eso alcanza en casi todos los
  // casos": eso es una afirmación sobre la POBLACIÓN de quienes ven el mensaje, nada la mide, y decae
  // sola a medida que cambia la mezcla de gente. Ahora dice CUÁNDO alcanza —"si ya te verificaste
  // antes desde esta billetera"—, que es una condición que la persona puede evaluar sobre sí misma y
  // que es exactamente la que hace funcionar al backfill: sin una verificación previa ATADA a esta
  // dirección, la autoridad devuelve `kyc_ownership_mismatch` y no hay fila que rescatar.
  if (code.includes("prepare_kyc_verdict_missing"))
    return "Volvé a conectar tu billetera y aceptá la firma que te pide: si ya te verificaste antes desde esta billetera, con eso alcanza. Si te lo vuelve a pedir, vas a tener que verificar tu identidad otra vez. No se movió ningún USDC.";
  // Misma familia, otra causa: no pudimos CONSULTAR el registro (no que no estés verificado). Se
  // distingue a propósito — mandar a re-verificarse por una caída nuestra es un consejo equivocado.
  if (code.includes("prepare_kyc_verdict_unavailable"))
    return "No pudimos comprobar tu verificación de identidad. No se movió ningún USDC: es una falla temporal nuestra, probá de nuevo en un rato.";
  // WKH-332/AC-13 — NO HAY QUIÉN. Es el tercer desenlace, y hasta acá se decía con las palabras de
  // los otros dos: salía por `prepare_upstream_error` / `a2a_unavailable`, o sea "el otro lado se
  // cayó", y el copy invitaba a reintentar. Reintentar no crea un agente. Las dos frases dicen las
  // dos cosas que hay que decir: (1) que volver a intentar igual no cambia nada, y (2) que no se
  // movió ningún USDC — que acá NO es un consuelo sino un hecho del orden de la ruta: el prepare
  // corre antes de `authorizePrincipal` (`confirm-and-send.ts`:384-388), o sea antes de la primera
  // firma de la billetera.
  //
  // ⚠️ VAN ANTES de los dos catch-all de abajo (`kyc` y `payout`) a propósito. Los enums elegidos no
  // contienen ninguna de esas dos subcadenas —`prepare_no_agent_for_capability` empieza con
  // "prepare"—, así que hoy la posición no cambia el resultado; lo que la vuelve load-bearing es el
  // día que alguien renombre un enum. T-13.3 clava la propiedad (los enums no contienen "kyc" ni
  // "payout") en vez del orden, porque la propiedad es lo que un input concreto puede romper.
  //
  // Y NINGUNA de las dos dice quién era el agente ni por qué no calificó: no lo sabemos, no hubo
  // agente. Prometer ese detalle sería la clase de frase que esta HU vino a sacar de la pantalla.
  //
  // 🔴 LAS DOS AFIRMAN "no hay ningún proveedor", Y ESA AFIRMACIÓN LA SOSTIENE LA ROUTE, NO ESTE
  // ARCHIVO (AR/BLQ-MED-1). El 422 del gateway colapsa cuatro motivos y uno —`reputation_unavailable`—
  // significa "no pude leer el historial", o sea que NO sabemos si hay proveedor. Las dos rutas
  // filtran por `noAgentMeansNobodyFits` (`src/application/agent-rejections.ts`) antes de emitir
  // estos enums; ese motivo sale por el enum de caída. Input que vuelve falsa la frase de acá abajo:
  // borrar ese filtro de `prepare/route.ts` o de `quote/route.ts` — T-13.4 y T-13.5 se ponen rojos.
  //
  // Son DOS ramas y no una compartida porque los dos legs cortan en momentos distintos del flujo: el
  // de FX antes de que exista una cotización, el del desembolso con la cotización ya en pantalla. Una
  // sola frase para los dos tendría que ser vaga en uno de los dos.
  if (code.includes("prepare_no_agent_for_capability"))
    return "Ahora mismo no hay ningún proveedor que pueda entregar este envío. No se movió ningún USDC de tu wallet. Volver a intentar ahora no cambia el resultado: probá más tarde.";
  if (code.includes("a2a_no_agent_for_capability"))
    return "Ahora mismo no hay ningún proveedor que pueda cotizar este envío, así que no llegamos a darte un precio. No se movió ningún USDC de tu wallet. Volver a intentar ahora no cambia el resultado: probá más tarde.";
  if (code.includes("kyc")) return "No pudimos verificar tu identidad.";
  // ⚠️ ACÁ SE PROMETÍA UN REEMBOLSO QUE NO EXISTE: "Si te cobramos, te reembolsamos". El adapter de
  // refund por defecto (`LedgerRefundGateway`) no mueve un peso y devuelve `refundTx: null` a
  // propósito; el use-case ni siquiera escribe `refunded` sin comprobante real
  // (`confirm-and-send.ts`:219-222). Sacar los USDC del vault es o el refund trustless que firma la
  // propia persona, o la release-authority a mano. O sea que nadie devuelve nada solo.
  //
  // Es el texto que MÁS se lee de este archivo: TrackView lo usa como último recurso para cualquier
  // `payout_failed` cuyo reason no reconozca (`humanError`, `flow.tsx:1675`), justo cuando no sabemos dónde está la
  // plata. Prometer un reembolso ahí manda a esperar sentado en vez de a la única acción que sirve.
  // WKH-333 — VA ANTES del catch-all de `payout`, y arregla un defecto de copy PREEXISTENTE que este
  // cambio vuelve mucho más alcanzable. `payout_not_authorized` no contiene "kyc", así que caía en el
  // catch-all de abajo y la persona leía "si tus USDC entraron al escrow, los sacás vos firmando" —
  // hablando de USDC en el escrow cuando NO SE MOVIÓ NADA: la ruta corta en su guard de autoridad,
  // que está antes del forward al agente y antes de `authorizePrincipal`, o sea antes de la primera
  // firma de la billetera. Mandaba a buscar plata a un lugar donde no hay plata.
  if (code.includes("payout_not_authorized"))
    return "Tu verificación de identidad no autoriza este envío. No se movió ningún USDC de tu wallet.";
  if (code.includes("payout"))
    return "No se pudo entregar. No hay un reembolso automático: si tus USDC entraron al escrow, los sacás vos firmando desde tu wallet.";
  return "Algo salió mal. Intentá de nuevo.";
}

// ── WKH-339 · qué está haciendo la pantalla de seguimiento con la lectura del payout ───────────────
//
// ⛔ TODO ESTE BLOQUE VA AL FINAL DEL ARCHIVO, y no es prolijidad: `:7`, `:25`, `:29`, `:30`, `:206` y
// `:253` de acá los cita otro archivo POR NÚMERO, y están todos arriba. Una inserción aguas arriba los
// rota en silencio.
//
// ⚠️ Y NO HAY UN `import` NUEVO ARRIBA POR LA MISMA RAZÓN: `EstadoVentanaLectura` se referencia con un
// `import type` INLINE, que no desplaza ni una línea. La alternativa —volver a escribir
// `"vigente" | "sin-prueba"` acá— sería una SEGUNDA LISTA de los mismos valores sin nada que la ate al
// original, que es el defecto que este repo ya cazó dos veces (la de `adapter === "a2a"` en
// `container.ts` y la de las proveniencias). Un `import type` se borra en compilación, así que no crea
// ningún ciclo en runtime.

/** Los CUATRO estados de la lectura, y ninguno colapsa en otro.
 *
 *  · `"no-aplica"`  — la remesa no está en `payout_submitted`: no hay nada que leer.
 *  · `"sin-billetera"` — está en `payout_submitted` pero no sabemos de quién es el envío. NO es
 *    `"sin-prueba"`: no hay a quién pedirle la firma, así que ofrecer el gesto sería ofrecer un botón
 *    que no puede funcionar. El gateway ya corta por su lado con `payout_status_no_wallet`
 *    (`noSe`, `../infrastructure/settlement/ledger-payout-status-gateway.ts:148`).
 *  · `"mirando"`    — la ventana está vigente: la lectura corre y la pantalla no tiene que decir nada
 *    nuevo.
 *  · `"sin-prueba"` — la ventana está apagada: la pantalla lo dice y ofrece el gesto. */
export type LecturaSeguimiento = "no-aplica" | "sin-billetera" | "mirando" | "sin-prueba";

/** El estado LOCAL del gesto de renovar, que se superpone SÓLO sobre `"sin-prueba"`.
 *
 *  🔴 SON CINCO VALORES Y NO UN BOOLEANO, porque pedir la firma tiene **CUATRO** desenlaces y un
 *  booleano perdería tres. Los cuatro están MEDIDOS en el árbol, no supuestos:
 *   1. `prove()` devuelve `null` ⇐ 501 `pop_not_configured`: el mecanismo está apagado server-side.
 *      **Nunca se abrió un popup**, y **reintentar NUNCA sirve** mientras el secreto no esté ⇒
 *      `"mecanismo-apagado"`.
 *   2. `prove()` tira `"pop_challenge_unavailable"` ⇐ 400 / 5xx / **429 del cupo**
 *      (`pop_challenge_unavailable`, `../infrastructure/auth/http-pop-signer.ts:23`). **Nunca se abrió un
 *      popup**, y reintentar **puede** servir más tarde ⇒ `"no-se-pudo-pedir"`.
 *   3. `prove()` tira algo que **NO viene de la billetera**: el `TypeError` crudo de `fetch` cuando no
 *      hay red (su docblock lo declara: *"o un fallo de red (fetch rechaza) ⇒ LANZA"*,
 *      `../infrastructure/auth/http-pop-signer.ts:8`), o `wallet_sign_not_available`, que el bridge tira
 *      **antes de cualquier popup** (`signMsgHandle`, `../infrastructure/solana-wallet-bridge.ts:127`), o
 *      un `throw` que no es un `Error`. **Tampoco hubo popup** ⇒ `"no-se-pudo-pedir"`.
 *   4. `prove()` tira un error **de la billetera**: hubo popup y no se completó ⇒ `"sin-firma"`.
 *
 *  🔴 EL CASO 3 ES EL QUE ESTA UNIÓN NO TENÍA, Y ERA EL MÁS COMÚN. El input más frecuente de una app de
 *  remesas en celular es **perder conectividad**, y con un `else` que mandaba todo `throw` no reconocido
 *  a `"sin-firma"` la pantalla le decía a la persona que **su** firma falló cuando lo que se cayó fue
 *  **nuestra** red. ⛔ Colapsar cualquiera de los cuatro rompe la regla 2 del copy de más abajo. */
export type GestoRenovacion =
  | "idle"
  | "firmando"
  | "mecanismo-apagado"
  | "no-se-pudo-pedir"
  | "sin-firma";

/** El desenlace crudo de `prove()`, en la forma que `gestoDespuesDeProve` puede clasificar sin efectos.
 *  Es un objeto etiquetado y no un `unknown | null` porque `null` es un desenlace CON significado
 *  (el 501) y no la ausencia de uno: un `unknown` los volvería indistinguibles. */
export type ResultadoDelGesto =
  | { readonly tipo: "prueba" }
  | { readonly tipo: "null" }
  | { readonly tipo: "error"; readonly error: unknown };

/**
 * 🔴 CÓMO SE DECIDE SI LA BILLETERA FUE TOCADA — y por qué la decisión NO vive en este archivo.
 *
 * `laBilleteraFueTocada` es una **allowlist de UN nombre** (`WalletSignMessageError`) y vive en
 * `./solana/wallet-error-code.ts`, que ya era el dueño de la tabla de nombres de la librería. La razón
 * está medida y es el hallazgo de fondo del CR: acá había un SEGUNDO clasificador del mismo `name`, con
 * la forma `/^Wallet[A-Za-z]*Error$/` menos 5 excepciones —o sea una **denylist**— y los dos módulos se
 * contradecían sobre el mismo dato (`KNOWN_CODES` lee `WalletAccountError` como fallo de CONEXIÓN; esto
 * lo leía como firma no completada).
 *
 * Lo que la denylist dejaba pasar, MEDIDO: **7 nombres** caían del lado que ACUSA sin que se hubiera
 * abierto ningún popup, incluido `WalletWindowBlockedError` (el popup lo bloqueó el navegador) y
 * **cualquier nombre nuevo** — un `WalletFuturoError` inventado daba `"sin-firma"`. O sea que la
 * dirección fail-safe que este docblock declaraba estaba **invertida para toda la familia**.
 *
 * ⛔ NO vuelvas a decidir por `name` acá. Si hace falta otro nombre, va en `wallet-error-code.ts`, con su
 * medición del adapter al lado.
 */

/**
 * Clasifica el desenlace del gesto. Función PURA: sin reloj, sin red, sin efectos.
 *
 * ⛔ VIVE ACÁ Y NO EN EL COMPONENTE, y es la razón por la que este arreglo se puede medir con inputs
 * concretos en vez de con un render: los cuatro desenlaces son datos, y el `it` que los cubre puede
 * pasarle un `TypeError` real sin montar nada.
 */
export function gestoDespuesDeProve(r: ResultadoDelGesto): GestoRenovacion {
  if (r.tipo === "prueba") return "idle";
  if (r.tipo === "null") return "mecanismo-apagado";
  // ⛔ EL DEFAULT ES `"no-se-pudo-pedir"`, Y ESA DIRECCIÓN ES EL ARREGLO. Primero esto era un `else` que
  // mandaba todo lo no reconocido a `"sin-firma"` (el caso más común —quedarse sin red— le achacaba a la
  // persona una firma que nunca le pedimos). Después fue una denylist, que dejaba pasar 7 nombres y
  // TODOS los futuros. Ahora la condición es positiva y de un solo nombre: se acusa sólo cuando la
  // librería DECLARA que el error salió de haberle pedido la firma a la billetera.
  return laBilleteraFueTocada(r.error) ? "sin-firma" : "no-se-pudo-pedir";
}

/**
 * De qué está hablando la pantalla de seguimiento. Función PURA: sin reloj, sin efectos, sin `peek`.
 *
 * 🔴 EL ORDEN DE LAS CUATRO RAMAS ES LA DECISIÓN, y cada una tiene un input que la falsearía:
 *  1. `status !== "payout_submitted"` ⇒ `"no-aplica"`. Es la única rama que no habla de la ventana: en
 *     cualquier otro estado no hay un desenlace de payout que leer.
 *  2. `sender == null` ⇒ `"sin-billetera"`, Y VA ANTES DE MIRAR LA VENTANA. Colapsarla en `"sin-prueba"`
 *     ofrecería el gesto de firmar cuando no hay a quién pedirle la firma. ⚠️ Es una rama **DEFENSIVA**:
 *     acá se afirmaba que era "alcanzable de verdad… desde el historial sin haber conectado" y **no está
 *     medido**. ⚠️ Y mi corrección anterior citaba mal la evidencia: decía que "los dos sitios que ponen
 *     `step` en `track` pasan antes por `setAddress`", y eso es **falso** para `onOpenFromHistory` —
 *     la garantía está UN SALTO ANTES: (`onOpenFromHistory`, `./flow.tsx:406`) sólo
 *     hace `setError`/`setRem`/`setStep` —**no toca la address**—, pero a la pantalla de historial se
 *     llega únicamente por `openHistory`, que hace `await resolveSender()` (y ése sí hace `setAddress`)
 *     ANTES de `setStep("history")`. El otro sitio (`:427`, tras confirmar) llega con la wallet ya
 *     conectada. Existe porque el tipo de `sender` admite `null`.
 *  3. `ventana === "vigente"` ⇒ `"mirando"`. La lectura corre; la pantalla no dice nada nuevo.
 *  4. Todo lo demás ⇒ `"sin-prueba"`. Es el default, y su dirección es la segura: ante la duda la
 *     pantalla OFRECE el gesto en vez de callarse. ⛔ Un default `"mirando"` es el mutante que hay que
 *     matar: dejaría la pantalla afirmando que vigila justo cuando dejó de vigilar.
 *
 * ⚠️ NO recibe el `RemittanceState` entero sino los tres datos que decide, y es deliberado: así el `it`
 * que la mide no tiene que construir un agregado, y así no puede aparecer una quinta rama que mire un
 * campo que este razonamiento no nombra.
 */
export function lecturaSeguimiento(de: {
  status: RemittanceStatus;
  sender: string | null;
  ventana: import("../composition/container").EstadoVentanaLectura;
}): LecturaSeguimiento {
  if (de.status !== "payout_submitted") return "no-aplica";
  if (de.sender == null) return "sin-billetera";
  if (de.ventana === "vigente") return "mirando";
  return "sin-prueba";
}

// ── El copy, y las tres reglas que NO se negocian ───────────────────────────────────────────────────
//
// 1. 🔴 PRESENTE, SIN PASADO. La consulta COLAPSA "venció" con "nunca hubo", a propósito y por
//    construcción (`peek`, `../infrastructure/auth/pop-proof-store.ts:70` devuelve `null` para los dos).
//    El segundo caso es REAL: se entra al seguimiento desde el historial tras una recarga y el almacén,
//    que es en memoria, está vacío desde el primer milisegundo. ⛔ Decir *"venció"* o *"dejamos de
//    revisar"* sería afirmar una historia que el sistema NO puede distinguir. El input que falsea
//    cualquier verbo en pasado es exactamente esa recarga.
// 2. 🔴 NINGUNA CULPA A LA PERSONA. `prove()` tiene **CUATRO** desenlaces y **TRES** ocurren SIN que se
//    haya abierto un popup: el 501, el 429/400/5xx, y todo lo que no viene de la billetera (el
//    `TypeError` de `fetch` sin red, `wallet_sign_not_available`, un `throw` que no es `Error`). Decir
//    *"no completaste la firma"* en cualquiera de los tres es FALSO. ⚠️ Acá decía "TRES desenlaces y dos
//    de ellos", y el tercero —el más común de todos, quedarse sin red— caía en el copy que acusa.
// 3. La pantalla no afirma que ESTÁ mirando. El criterio es "no puede afirmar que mira cuando dejó de
//    mirar", no "tiene que afirmar que mira": una afirmación positiva nueva agranda la superficie
//    falsable por cero beneficio, y sólo sería sostenible mientras la prueba viva.
//
// ⚠️ Lo normativo son esas tres reglas, NO las palabras. El texto lo puede reescribir el founder; las
// tres reglas no.

/** Estado 2 — la ventana está apagada. Presente puro: qué NO está pasando, sin contar qué pasó antes. */
export const REVISION_APAGADA = "No estamos revisando si el envío ya se completó.";
/** Estado 2 — el gesto. "Revisar ahora", no "volver a revisar": lo segundo afirma que revisamos antes. */
export const REVISION_GESTO = "Revisar ahora";
/** Estado 3 — mientras el popup está abierto. El botón queda `disabled`: un gesto, un challenge. */
export const REVISION_FIRMANDO = "Confirmá en tu billetera…";
/** Estado 5 — `payout_submitted` sin billetera conectada. SIN gesto: no hay a quién pedirle la firma.
 *  El gateway ya corta por su lado con `payout_status_no_wallet`.
 *
 *  ⚠️ ESTE ESTADO ES **DEFENSIVO**, y hay que decirlo así. Acá se afirmaba que era *"alcanzable de
 *  verdad: entrar al seguimiento desde el historial sin haber conectado"*, y **eso no está medido**:
 *  **nadie encontró el camino**. Se conserva porque la prop `sender` es `string | null` y el tipo admite
 *  el caso: la alternativa sería no cubrirlo y confiar en que ningún llamador futuro lo produzca.
 *  T-339.7 lo clava. Lo que se saca es la afirmación.
 *
 *  🔴 Y LA EVIDENCIA CORREGIDA (CR/MNR-1), porque mi primera corrección citaba mal: la garantía está UN SALTO ANTES: (`onOpenFromHistory`, `./flow.tsx:406`) sólo
 *     hace `setError`/`setRem`/`setStep` —**no toca la address**—, pero a la pantalla de historial se
 *     llega únicamente por `openHistory`, que hace `await resolveSender()` (y ése sí hace `setAddress`)
 *     ANTES de `setStep("history")`. El otro sitio (`:427`, tras confirmar) llega con la wallet ya
 *     conectada. */
export const REVISION_SIN_BILLETERA =
  "Para revisar tenemos que saber que este envío es tuyo. Conectá la misma wallet con la que enviaste.";
/** Estado 6 — no pudimos PEDIR la firma, y **reintentar puede servir más tarde** (400/5xx/429 del cupo,
 *  o un fallo de red, o cualquier error que la billetera no declare como suyo). En todos NUNCA se abrió
 *  un popup, así que la frase dice de qué lado está el problema en vez de culpar a la billetera. */
export const REVISION_NO_SE_PUDO_PEDIR =
  "Ahora mismo no podemos pedirle la firma a tu billetera. No es tu wallet: es de nuestro lado.";
/** Estado 6b — el mecanismo está apagado server-side (501, sin `PAYOUT_POP_SECRET`), que es el DEFAULT
 *  documentado. Comparte con el estado 6 el no culpar a nadie, y se separa en UNA cosa que importa:
 *  acá **reintentar no sirve**, así que la frase no puede insinuar que más tarde sí. `"Ahora mismo"` a
 *  secas lo insinuaba, y por eso esta copy dice explícitamente que volver a intentar no cambia el
 *  resultado — la misma forma que `humanError` ya usa para los cortes que no se arreglan reintentando. */
export const REVISION_MECANISMO_APAGADO =
  "Ahora no podemos revisar este envío desde acá. No es tu wallet: es de nuestro lado, y volver a intentar no cambia el resultado.";
/** Estado 7 — hubo popup y no se completó. ⛔ NO dice "la rechazaste": el error viene de la billetera y
 *  no distingue un rechazo de un fallo de la extensión. */
export const REVISION_SIN_FIRMA = "La firma no se completó. Podés intentar de nuevo.";
/** El techo del gesto se alcanzó. Ver `MAX_CHALLENGES_POR_MONTAJE` en `./flow.tsx`.
 *
 *  🔴 ACÁ DECÍA *"Volvé a abrir el seguimiento para reintentar"*, Y ERA DOS DEFECTOS EN UNA FRASE
 *  (CR/BLQ-MED-2 y CR/BLQ-BAJO-4):
 *   · **le pedía a la persona justo la acción que REINICIA el techo**. El contador vivía por montaje, y
 *     remontar el seguimiento lo volvía a 0 ⇒ la copy invitaba a vaciar el cupo de la IP. Una copy que
 *     recomienda la acción que desarma la mitigación es peor que no tener mitigación.
 *   · **mandaba a una salida que esta pantalla NO TIENE**: medido, el seguimiento no expone ningún
 *     control de navegación (ni botón, ni `onBack`, ni "Ver mis envíos" — eso vive sólo en la pantalla de
 *     envío). Desde acá la única forma de "volver a abrir" es RECARGAR, algo que la frase no nombraba.
 *
 *  ⇒ ahora **no da ninguna instrucción de remonte** y nombra una acción que **sí está en esta pantalla**.
 *  No promete que reintentar funcione, no culpa a nadie, y no afirma nada del vault.
 *
 *  ⚠️ Y NO REPITE VERBATIM la frase de `PayoutInProgress` ("Si preferís no esperar, podés recuperar tus
 *  USDC.", `flow.tsx:2566`), aunque nombre la misma acción. Mi primera versión la copiaba tal cual para
 *  reusar copy ya vetada, y MEDIDO: `getByText` encontraba **dos** nodos, o sea que la pantalla le decía
 *  lo mismo dos veces en el mismo lugar. Reusar copy vetada es bueno; duplicarla en la misma vista no. */
export const REVISION_TECHO_ALCANZADO =
  "Por ahora no podemos seguir intentando desde acá. Podés recuperar tus USDC en vez de esperar.";

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Apéndice WKH-346 (fix-pack AR/BLQ-BAJO-1). Va al FINAL a propósito, y el motivo es mecánico. El
 * criterio accionable no cambió: **antes de insertar líneas en el cuerpo de este archivo, corré
 * `citas-ancladas.test.ts`**. Lo que cambió es el POR QUÉ, que es lo que va a usar el próximo editor.
 *
 * 🔴 ACÁ EL MOTIVO ESTABA AL REVÉS (fix-pack WKH-347, CR/MNR-4), y va corregido porque un motivo
 * invertido manda a mirar el lado equivocado:
 *   · DECÍA que este archivo tiene citas ancladas cuyo destino está en su propia mitad de abajo, así
 *     que una inserción aguas arriba las desplazaría a todas. **Falso, y se mide en un comando**: de
 *     las citas ancladas de este archivo, NINGUNA apunta a este archivo — todas apuntan afuera
 *     (`solana-wallet.ts`, `flow.tsx`, `http-pop-signer.ts`, …), y a esas no las mueve nada de lo que
 *     se escriba acá. Insertar arriba no rompe ninguna cita PROPIA.
 *   · EL PELIGRO ES EL OPUESTO: son OTROS archivos los que citan a este POR NÚMERO de línea, y a esos
 *     sí los rota cualquier inserción aguas arriba. Se enumeran con
 *     `grep -rn "flow-vm\.ts:[0-9]" src app scripts contracts`, que es el instrumento y no envejece.
 *     🔴 ACÁ DECÍA "WKH-347 rompió DOS", y el número era mío y estaba mal (fix-pack r2, re-AR/MNR-3).
 *     Corriendo ese grep contra `main` y contra la rama, los sitios rotos por esta HU fueron CINCO. Van
 *     descritos y NO por número —escribir la lista de números acá sería repetir la lista vencida que
 *     este mismo comentario sacó—: el docblock del `useState` de `sinAbiertos` en `flow.tsx`; las DOS
 *     citas a `sinAbiertosCopy` de `flow.tsx` (el hint de "puede haber más" y la frase de cierre de
 *     ventana), de las que el fix-pack r1 arregló una sola; y las dos al bloque de los CINCO productores
 *     de `escrow_recovery_unavailable` —una en `flow.tsx`, otra en `lost-escrow-recovery.test.tsx`—, que
 *     esta HU corrió cinco líneas hacia abajo al insertar las dos ramas del índice.
 *     Un apéndice desplaza 0, y por eso sigue siendo apéndice; el resto del archivo NO, y por eso el
 *     grep va ANTES de escribir y otra vez DESPUÉS del último hunk del commit. Medir a mitad es
 *     exactamente cómo se rompe una cita con la edición siguiente, y acá pasó.
 *
 * ⚠️ Y LA OTRA FRASE IMPRECISA, dicha para no repetirla: acá vivía una lista de cuatro números
 * (`:728`, `:852`, `:912`, `:949`) y este comentario afirmaba que "ninguno de los cuatro seguía siendo
 * el sitio que nombraba". Re-medido sobre `main`: TRES de los cuatro seguían siendo líneas con una cita
 * ancladas y todo, sólo que apuntando a `flow.tsx` y no a este archivo. La lista se saca igual —vive en
 * prosa y ningún guard la mira—, pero el motivo es que envejece sola, no que estuviera toda mal.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * El texto de `escrow_not_found` para la puerta "Recuperar un envío perdido", en UN solo lugar.
 *
 * Lo extraigo de `lostEscrowRecoveryError` (`:326-327`) porque ahora lo necesitan DOS consumidores:
 * esa función, que lo devuelve, y `esVentanaSinAbiertos`, que lo usa para RECONOCER el desenlace
 * "la ventana no tiene ningún escrow abierto" sin volver a clasificar el código.
 *
 * ⚠️ El valor de retorno de `lostEscrowRecoveryError("escrow_not_found", N)` NO cambia. Eso lo
 * congelan (`lostEscrowRecoveryError`, `flow-vm.test.ts:481`) y
 * (`lostEscrowRecoveryError`, `refund-perdido-registro-mudo.test.tsx:383`), el `it` "el copy legítimo
 * REAL es EXACTAMENTE el literal vetado", y siguen verdes sin tocarlos.
 *
 * 🔴 ESTA CITA LA ROMPÍ DOS VECES SEGUIDAS, y la segunda fue con mi propia edición (fix-pack r2,
 * re-AR/BLQ-BAJO-1). Primero apuntaba a `:316`, una línea de comentario. La corregí a `:377` midiendo
 * bien y, EN EL MISMO COMMIT, inserté 5 líneas de comentario aguas arriba en ese archivo: `:377` pasó a
 * ser también un comentario. Y quedó invisible porque la escribí en prosa suelta: sin la coma entre los
 * dos backticks, `citas-ancladas.test.ts` no la mira y `npm test` da verde con la cita rota. Las dos
 * lecciones, que son distintas: **anclá el formato** (§6, es lo que la vuelve verificable) y **re-medí
 * después del ÚLTIMO hunk del commit**, no cuando la escribís.
 */
export function sinAbiertosCopy(maxCandidates: number): string {
  return `No encontramos escrows abiertos para esta billetera. Esto no dice que no tengas fondos: dice que ninguno de los últimos ${maxCandidates} envíos que el servidor tiene guardados de esta billetera, ni ninguno de los que la cadena tiene registrados en el índice de esta billetera, está abierto en el contrato.`;
}

/**
 * WKH-347 — el índice on-chain de esta billetera NO EXISTE. La cadena contestó; no es que no pudimos
 * preguntar.
 *
 * 🔴 ESTE DESENLACE TIENE DOS MITADES Y ACÁ LA DEL ÍNDICE TAPABA A LA DEL LEDGER (fix-pack WKH-347,
 * AR/BLQ-1). El texto empezaba con "Eso pasa si nunca depositaste", y hay un input —pinneado en
 * `solana-wallet.refund.test.ts`, el caso de dos remesas `Released`— en que el navegador tiene, en ese
 * mismo instante, la respuesta del registro durable con envíos de esta billetera: nuestro propio dato
 * refutaba la primera historia que la pantalla ofrecía. Y no es un borde: al desplegar, NINGUNA
 * billetera existente tiene índice (la PDA se crea con el primer depósito posterior a esta HU), así
 * que ésta pasa a ser la respuesta que ve la población entera.
 *
 * ⇒ EL TEXTO DICE LAS DOS MITADES, EN ORDEN: primero lo que el registro durable contestó (que es un
 * hecho y no una hipótesis), después lo que la cadena contestó sobre el índice, y las tres historias al
 * final, sin que la refutable vaya primera.
 *
 * 🔑 POR QUÉ SE PUEDE AFIRMAR LA PRIMERA MITAD SIN RECIBIR NINGÚN DATO NUEVO: este código tiene UN
 * productor y está aguas abajo de una precondición. `escrow_index_absent` sólo se emite desde el camino
 * del índice, y a ese camino se entra ÚNICAMENTE cuando el registro durable ya contestó y su ventana no
 * tenía ningún escrow abierto (el `catch` que lo habilita filtra por `escrow_not_found`, y los tres
 * `not_asked` pasan de largo con su propio código). O sea que "ya miramos los últimos N guardados y
 * ninguno está abierto" es cierto en los DOS inputs que llegan acá: el servidor sin ids, y el servidor
 * con ids de los que ninguno está `Deposited`. ⛔ Si alguien le agrega un segundo productor a este
 * código, esta frase deja de estar sostenida y hay que volver acá.
 *
 * 🔴 LAS TRES HISTORIAS QUE ESTE DESENLACE NO PUEDE DISTINGUIR, y por eso el texto las nombra a las
 * tres en vez de elegir una. Que la PDA no exista es compatible con:
 *   · depositaste ANTES de que empezáramos a registrar en el índice (WKH-347 no existía);
 *   · depositaste después, y en ese momento no pudimos registrarlo (el índice estaba lleno, o la sonda
 *     no se pudo leer y el depósito salió sin la segunda instrucción);
 *   · nunca depositaste.
 * Desde el navegador no se puede saber cuál de las TRES es la de esta persona, así que prometer un
 * diagnóstico fino sería el mismo error que `probeEscrowIndex` ya tiene documentado. Lo que sí se puede,
 * y es lo que cambió, es no ofrecer primera la historia que nuestro propio dato ya matizó.
 *
 * 🔑 LA CLÁUSULA "no pudimos registrarlo" NO ES RELLENO: es la única parte del copy que le dice a la
 * persona que la ausencia puede ser culpa NUESTRA y no suya. Existe por las dos ramas en que el depósito
 * sale sin registrar. ⛔ No la borres al pulir el texto.
 *
 * `maxCandidates` entra POR PARÁMETRO, igual que en `sinAbiertosCopy` y por la misma razón (CD-17): el
 * llamador pasa la misma constante que sondea, así que el copy no puede quedar diciendo un número que el
 * código dejó de usar.
 *
 * ⚠️ Y NO AFIRMA NADA SOBRE LOS FONDOS. "No hay índice" no es "no tenés nada": un depósito que no se
 * registró está igual de abierto en el contrato, con la plata adentro.
 */
export function sinIndiceCopy(maxCandidates: number): string {
  return `Ya miramos los últimos ${maxCandidates} envíos que el servidor tiene guardados de esta billetera y ninguno está abierto en el contrato. En la cadena, además, no hay un índice de envíos de esta billetera: eso pasa si depositaste antes de que empezáramos a registrar, si en ese momento no pudimos registrarlo, o si nunca depositaste. No es una respuesta sobre tus fondos.`;
}

/**
 * WKH-347 — no se pudo LEER el índice on-chain. "No pude preguntar" no es "no".
 *
 * Es el mismo tri-estado que el resto del money-path respeta: hay un "sí", un "no" y un "no llegué a
 * saberlo", y este texto es el tercero. Los tres inputs que llegan acá (el RPC caído, el techo de la
 * sonda vencido, y bytes que no decodifican como `EscrowIndex`) colapsan en UN código a propósito: la
 * persona no puede hacer nada distinto con cada uno.
 *
 * 🔴 ACÁ DECÍA "así que no llegamos a preguntar", Y ERA FALSO (fix-pack WKH-347, AR/BLQ-2). La regla del
 * repo es que *no pude preguntar* no es *no*; su RECÍPROCA vale igual: **"pregunté una de las dos fuentes
 * y me contestó" no es "no llegamos a preguntar"**. A este código sólo se llega después de que el
 * registro durable contestó y su ventana no tenía ningún escrow abierto (misma precondición que
 * `sinIndiceCopy` explica en detalle), así que la frase convertía una respuesta PARCIAL en una
 * no-respuesta total y tiraba la mitad que sí teníamos. Ahora dice cuál fuente contestó y cuál quedó sin
 * revisar.
 *
 * ⚠️ Y NO NOMBRA EL NÚMERO DE LA VENTANA, a diferencia de `sinIndiceCopy`, y no es una omisión: acá la
 * búsqueda NO terminó, y "ninguno de los últimos N" al lado de un índice que no se pudo leer se lee como
 * si la pregunta estuviera cerrada. Eso lo vigila un assert por ausencia en
 * `refund-perdido-registro-mudo.test.tsx` (el caso E, que recorre esto de punta a punta en jsdom).
 *
 * ⛔ NO puede decir "no encontramos", ni "no tenés", ni sugerir que la búsqueda terminó. La única cosa
 * accionable es reintentar, y es lo único que promete.
 */
export function indiceIlegibleCopy(): string {
  return "El registro de envíos guardados de esta billetera ya lo consultamos y ahí no hay ninguno abierto. Lo que no pudimos leer es el índice de envíos que la cadena guarda de esta billetera, así que esa segunda fuente quedó sin revisar. Esto no es una respuesta sobre tus fondos: probá de nuevo en un rato.";
}

/**
 * ¿Este código de error significa "en la ventana que miramos no hay NINGÚN escrow abierto"?
 *
 * 🔴 DELEGA a `lostEscrowRecoveryError` en vez de re-clasificar, y eso NO es estilo: es lo que hace
 * imposible la divergencia. La alternativa obvia —`code.includes("escrow_not_found")` acá— es
 * exactamente la duplicación contra la que este archivo ya escribió una advertencia en `:312-318`:
 * una segunda copia de un clasificador necesita un guard que alguien mantenga, y el día que nadie lo
 * mantenga las dos respuestas se contradicen.
 *
 * Delegando, la PRECEDENCIA DE RAMAS vale para las dos respuestas sin ningún guard:
 * `lostEscrowRecoveryError` decide primero por `escrow_refund_signature_incomplete` (`:310`) y por
 * `user rejected|wallet_connect_cancelled|wallet_sign_not_available` (`:319`), y esas dos GANAN antes
 * que `escrow_not_found` (`:326`). Un predicado que hiciera el `includes` por su cuenta podría
 * contradecir al copy el día que un código traiga dos de esas subcadenas a la vez.
 *
 * ⛔ Devuelve `false` para `escrow_recovery_unavailable` y para `escrow_id_unavailable`, y eso es
 * deliberado: "no pude preguntar" NO es "no hay". Esos códigos llegan con cinco productores
 * (`:328-337`) y NINGUNO afirma que la ventana esté vacía, así que la pantalla tiene que seguir
 * diciendo que puede haber más. Colapsar los dos desenlaces es el error que este repo ya tiene
 * documentado; `T-346-15` existe sólo para eso.
 *
 * 🔴 SON DOS COPIAS ACEPTADAS Y NO UNA (fix-pack WKH-347, AR/BLQ-1), y el cambio es de COMPORTAMIENTO:
 * `escrow_index_absent` también significa "en la ventana que miramos no hay ninguno abierto", así que
 * ahora prende la tarjeta de cierre de WKH-346. Las dos razones, y las dos son medibles:
 *   · **Es cierto.** A ese código se llega sólo después de que el registro durable contestó y su ventana
 *     no tenía ningún escrow abierto; que además la cadena no tenga índice no agrega candidatos que
 *     revisar. La tarjeta afirma exactamente eso y nada más ("ya no queda ninguno abierto ENTRE los
 *     últimos N guardados"), así que no pasa a afirmar sobre los fondos.
 *   · **Sin esto era una regresión para la población entera.** Al desplegar, ninguna billetera existente
 *     tiene índice, así que TODA búsqueda posterior a una recuperación exitosa terminaba en
 *     `escrow_index_absent` ⇒ la tarjeta no se prendía nunca y el final exitoso del camino se pintaba
 *     como error. Antes de esta HU ese mismo click daba `escrow_not_found` y sí la prendía.
 *
 * ⛔ `escrow_index_unreadable` sigue dando `false`, y ahí está la línea: `absent` es una RESPUESTA de la
 * cadena, `unreadable` es no haber podido preguntarle. El tri-estado se respeta en el predicado igual que
 * en el copy.
 *
 * ⚠️ Y SIGUE DELEGANDO: no clasifica el `code`, compara el copy PRODUCIDO contra las dos copias que
 * significan "se miró y no hay ninguno abierto". Un `code.includes("escrow_index_absent")` acá sería la
 * duplicación contra la que este archivo ya escribió su advertencia.
 */
export function esVentanaSinAbiertos(code: string, maxCandidates: number): boolean {
  const copy = lostEscrowRecoveryError(code, maxCandidates);
  return copy === sinAbiertosCopy(maxCandidates) || copy === sinIndiceCopy(maxCandidates);
}

/**
 * WKH-349 — LO QUE LA CADENA CONTESTÓ sobre una fila del historial, en la forma en que la fila lo
 * recibe. Son los seis de (`EscrowChainState`, `../application/ports.ts:1122`) más DOS que no hablan
 * de la respuesta sino de la PREGUNTA, y que por eso no se pueden colapsar con ninguno de aquéllos:
 *
 *  · `"not-asked"` — NO SE PREGUNTÓ. Es lo que ve una pantalla sin reader cableado, sin `sender`, o
 *      cuyo bucket de filas a preguntar quedó vacío. No es "no pudimos preguntar": nadie levantó el
 *      teléfono. El input que muestra la diferencia: renderizar el historial sin `reader` — si eso
 *      dibujara "No pudimos preguntarle al contrato", la pantalla estaría acusando el fallo de una
 *      consulta que nunca existió.
 *  · `"pending"`   — se preguntó y la respuesta todavía no volvió. Tampoco es "no pudimos": la promesa
 *      sigue viva y el desenlace puede terminar siendo cualquiera de los seis.
 */
export type EscrowChainAnswer = EscrowChainState | "pending" | "not-asked";

/**
 * El desenlace que la fila del historial muestra: lo que el snapshot local ya sabía, O lo que la
 * cadena contestó cuando el snapshot no sabía.
 *
 * Es un tipo HERMANO de (`EscrowKnowledge`, `:204`) y no un ensanchamiento suyo, a propósito.
 * Ensanchar aquél rompería a (`escrowFundsAtRisk`, `:241`), que lo consume exhaustivamente, y con él
 * el copy de la advertencia de borrado — que está fuera del alcance de esta HU. Y volvería falso su
 * docblock, que afirma "Esta función no lee la cadena": esa frase sigue siendo verdadera después de
 * WKH-349 porque (`escrowFundsKnowledge`, `:206`) no cambió ni una línea.
 */
export type EscrowOutcome =
  | EscrowKnowledge
  | "chain-deposited-window-open"
  | "chain-deposited-window-closed"
  | "chain-released"
  | "chain-refunded"
  | "chain-absent" | "chain-absent-after-deposit"
  | "chain-unknown"
  | "chain-pending";

/**
 * Qué decir de esta remesa, dado lo que el snapshot local sabe y lo que la cadena contestó.
 *
 * 🔴 EL PRIMER `if` ES EL CORTE, Y EL ORDEN NO ES DECORATIVO. Si el conocimiento local ya resolvió el
 * desenlace, la respuesta de la cadena NO entra: un marcador local se escribió después de ver una tx
 * confirmada, y dejar que una lectura de PDA lo pise es reabrir el caso que ese marcador cerró. El
 * input que lo demuestra: una remesa con `ESCROW_REFUNDED_BY_SENDER` (⇒ `"returned"`) cuya PDA está
 * `Deposited` porque el refund todavía no cerró la cuenta — mover este corte debajo del mapeo le diría
 * "tus USDC siguen en el escrow" a quien ya los tiene en la wallet. Candado: T-V1.
 *
 * El mismo `if` es la implementación literal de AC-6 y AC-8: la cadena sólo se consulta, y sólo se
 * mira, para el bucket `"unverified"`. Las filas `"no-deposit"` conservan su copy de siempre.
 *
 * La función es TOTAL: para cualquier par (`EscrowKnowledge` × `EscrowChainAnswer`) devuelve un
 * `EscrowOutcome`, nunca `undefined`. Candado: T-V6.
 */
export function escrowOutcome(rem: RemittanceState, answer: EscrowChainAnswer): EscrowOutcome {
  const k = escrowFundsKnowledge(rem);
  if (k !== "unverified") return k; // AC-6 + AC-8: el snapshot ya contestó; la cadena no entra
  if (answer === "not-asked") return k; // no se preguntó ⇒ el copy de siempre, sin inventar nada
  if (answer === "pending") return "chain-pending";
  // Los dos `deposited-*` van en ramas SEPARADAS y no en una común: agruparlos ("total, en las dos hay
  // plata") vuelve a colapsar justo la distinción que esta capa existe para mostrar — cuál es la única
  // puerta que le queda a esa fila. Candado: T-V10.
  if (answer === "deposited-window-open") return "chain-deposited-window-open";
  if (answer === "deposited-window-closed") return "chain-deposited-window-closed";
  if (answer === "released") return "chain-released";
  if (answer === "refunded") return "chain-refunded";
  if (answer === "absent") return rem.principalTx != null ? "chain-absent-after-deposit" : "chain-absent";
  // `"unknown"` y cualquier valor que un `EscrowChainAnswer` futuro agregue: "no pudimos preguntar".
  // Es el lado seguro del tri-estado — el que no afirma nada sobre los fondos.
  return "chain-unknown";
}

/**
 * La frase y el peso visual de cada desenlace. Salen de LA MISMA función, igual que en
 * (`statusDisplay`, `:133`), para que no puedan divergir por descuido: un copy que dice "siguen en el
 * escrow" con el mismo gris que "no pudimos preguntar" pierde la mitad de AC-2.
 *
 * ⚠️ LAS CUATRO FRASES LOCALES NO SE COPIAN ACÁ: se delegan en (`escrowKnowledgeCopy`, `:256`). Es la
 * misma lección que este archivo ya tiene escrita en el docblock de
 * (`lostEscrowRecoveryError`, `:302`) sobre el número del copy: escribir la frase dos veces es cómo
 * queda una pantalla diciendo algo que el código dejó de decir.
 *
 * Sobre `absent`, que desde WKH-352 tiene DOS ramas y la evidencia que las separa es `rem.principalTx` (la firma del depósito, que sólo se escribe tras un `ok:true` del settle): sin ella lo único honesto sigue siendo hablar de NOSOTROS ("no podemos decir cuál de las dos"); con ella se refuta el "nunca entró", Y NADA MÁS. 🔵 DE DÓNDE SALE EL "confirmada en la cadena" DE ESA FRASE, que es lo que faltaba escribir acá (AR r2 · BLQ-MED-2, refutado en su parte grave y anotado en ésta). El `ok:true` del settle NO significa "lo transmitimos": el facilitator sólo lo devuelve después de un `connection.confirmTransaction(signature, 'confirmed')` cuyo `conf.value.err` es nulo. Vive en OTRO repo: `wasiai-facilitator` → `src/methods/solana-sponsor/broadcast.ts:339-342`, medido sobre su commit `8177b6e`. Si no confirma, esa función devuelve `ok:false` con `SPONSOR_BROADCAST_EXPIRED` o `SPONSOR_BROADCAST_FAILED`, y entonces `markPrincipalIn` no corre (el gate está en `confirm-and-send.ts`, candado T-W9(c)). O sea: la confirmación existe, y por eso la frase no se debilita a "nos devolvieron su firma". ⚠️ RESIDUO, dicho como es: esa garantía es de OTRO servicio y de OTRO repo. Si el facilitator dejara de confirmar antes de contestar (o cambiara el commitment a `processed`), la palabra "confirmada" de este copy pasaría a ser falsa y NINGÚN test de ESTE repo se pondría rojo. No hay contrato verificable entre los dos lados: hay una lectura del código del otro, con fecha. Lo que sí está candado acá es el ESCRITOR único y su posición respecto del gate (`principal-tx-single-writer.static.test.ts`), no lo que el `ok:true` significa del otro lado del cable.
 * ⚠️ `absent` NO PRUEBA QUE LA CUENTA SE HAYA CERRADO, y por eso el copy nuevo NO lo dice. Lo ÚNICO medido es "en la dirección que derivamos HOY no hay cuenta". Esa dirección sale de tres cosas y el snapshot no guarda las dos que importan: el programa es un literal del código (`address`, `../infrastructure/solana/escrow-idl.ts:16`), el endpoint lo elige (`resolveSolanaRpcUrlPublic`, `../infrastructure/chain.ts:190`) leyendo `NEXT_PUBLIC_SOLANA_RPC_URL` sin ninguna validación cruzada, y (`RemittanceState`, `../domain/remittance.ts:250`) tiene `principalTx` y `ownerAddress` pero ni `programId` ni cluster.
 * CUATRO DISPARADORES REALES de que la dirección de hoy no sea la de aquel depósito, ninguno hipotético: cambiar el program address (ya pasó en este repo, commit `89628d8`, en un commit normal); el cutover a mainnet que (`resolveSolanaNetworkId`, `../infrastructure/chain.ts:32`) tiene escrito como pendiente, y que ese día haría que TODA fila devnet dijera lo que no es; una `NEXT_PUBLIC_SOLANA_RPC_URL` mal apuntada, que es hoy y sin desplegar código; y un cambio de cuenta en la wallet entre el KYC y el confirm.
 * Un "se cerró" ahí le diría a alguien que no hay nada que recuperar sobre una fila donde SÍ lo hay, y le apagaría (`LostEscrowRecovery`, `flow.tsx:890`), que es la puerta que le queda. Por eso el copy dice lo MEDIDO y deja abierta la tercera posibilidad. Candado: T-W10. R-1 en (`EscrowChainState`, `../application/ports.ts:1122`). 🔴 Y EL COPY DECÍA DOS COSAS QUE ESTE MISMO DOCBLOCK REFUTA (AR r2 · BLQ-BAJO-1), corregidas acá. (1) Decía "en EL CONTRATO que estamos consultando no figura ninguna cuenta", que generaliza de UNA lectura a todo el programa: lo que se lee es una sola dirección, la que (`deriveEscrowStateFromId16`, `../infrastructure/solana-wallet.ts:294`) deriva de `["escrow", sender, id16]`. Ahora dice la dirección de este envío y que miramos esa sola. (2) La tercera posibilidad decía "siga abierta en un contrato que no estamos mirando", y ése es justo el lugar donde el disparador MÁS PLAUSIBLE de los cuatro de arriba NO la pone: si la fila quedó con un `ownerAddress` y el depósito lo firmó otra cuenta de la wallet, la PDA existe en ESTE MISMO programa, sembrada con el otro sender, y (`LostEscrowRecovery`, `flow.tsx:890`) la encuentra porque resuelve por sender. Por eso el copy ahora nombra la otra dirección y manda a esa puerta, en vez de mandar a un contrato que nadie va a ir a buscar. ⚠️ RESIDUO DE ESA ÚLTIMA FRASE: nombra la puerta en prosa ("recuperar un envío perdido"), no por su label. Si alguien renombra el label de esa puerta, que hoy dice "Recuperar un envío perdido" en el cuerpo de (`LostEscrowRecovery`, `flow.tsx:2178`), esta frase queda apuntando a algo que en pantalla se llama de otra forma. ⚠️ ESO CAMBIÓ A MEDIAS: T-W12 (el candado de acá abajo) busca ese botón POR SU LABEL, así que un renombre lo pone rojo y obliga a mirar esta frase; lo que sigue sin vigilancia es que la PROSA del copy y el label digan LO MISMO, porque nadie los compara. Duplicar el label byte a byte cambiaría un riesgo por el otro, el de las dos copias que divergen. 🔴 EL CONSEJO NO SE PODÍA CUMPLIR DESDE DONDE SE LEE (AR r3 · BLQ-MED-1), Y ESO SE CERRÓ EN DOS ETAPAS. Decía "conectá esa y usá la opción de recuperar un envío perdido", y eso ERA inaplicable en la sesión en la que se lee: `address` es un `useState` (`address`, `flow.tsx:147`) y (`resolveSender`, `flow.tsx:380`) devolvía el valor local cuando ya lo tenía —un `address ??` que cacheaba la primera cuenta para siempre—, así que nunca se le volvía a preguntar a la billetera. Y esta tarjeta SÓLO puede verse con `address != null`, por construcción: (`HistoryView`, `flow.tsx:1119`) recibe `sender={address}`, su efecto corta sin sender (`reader`, `flow.tsx:3168`) y sin consulta la respuesta es `not-asked`, que devuelve el conocimiento local (`answer`, `:1196`). O sea: LA MISMA CONDICIÓN QUE HACÍA VISIBLE EL CONSEJO ERA LA QUE LO VOLVÍA IMPOSIBLE. Lo único que limpiaba `address` era (`forgetAndDisconnect`, `flow.tsx:540`), detrás de "Borrar igual", que además borra el KYC y las entries del owner. ETAPA 1 (WKH-352): el copy pasó a mandar a volver a abrir la app, porque el montaje nuevo arranca con `address` en `null`. ETAPA 2 (WKH-354), que es la que vale hoy: se ELIMINÓ el `address ??`, y (`resolveSender`, `flow.tsx:380`) le pregunta al puerto `connectedWallet` —la billetera VIVA— en cada una de las tres puertas no monetarias, así que la reapertura dejó de hacer falta y el copy dejó de pedirla. Acá decía "⛔ NO se agregó ningún control de cambiar billetera ni se tocó `resolveSender`: eso cambia la conexión para TODA la app y es otra HU": esa HU fue WKH-354 y esa frase ya es falsa, por eso se reescribió. Y el arreglo NO es esta prosa: es T-354-W12 + su control en `history-onchain.test.tsx`, que ejecutan el consejo de punta a punta —sin reabrir la app— y assertan con qué `sender` sale la recuperación. Tres rondas de AR se fueron en reescribir texto que prometía de más; un texto no se puede medir a sí mismo.
 *
 * Sobre los dos `"chain-deposited-*"`: los dos pesan `strong` porque los dos tienen plata adentro —
 * el peso visual separa "hay plata" de "no hay nada que hacer", no "urgente" de "no urgente". Lo que
 * los separa es el TEXTO: el vencido dice cuál es la única puerta que le queda. Y de qué lado del
 * `deadline` cae esa fila lo decidió NUESTRO reloj, no la cadena: ver R-4 en el mismo docblock.
 *
 * ⚠️ RESIDUAL DE `"chain-deposited-window-closed"`, DECLARADO ACÁ PORQUE NO ESTABA EN NINGÚN LADO: la
 * frase nombra una salida —"devolverlos a tu wallet, y sólo tu firma puede hacerlo"— que la TARJETA de
 * la que sale NO SIEMPRE OFRECE. El input: una fila `status: "settled"` con `principalTx != null` cae
 * en `"unverified"` por la rama (`principalTx`, `:219`) de `escrowFundsKnowledge`, y si su PDA sigue
 * `Deposited` con el plazo vencido la tarjeta muestra esta frase y, como ÚNICO botón, "Ver recibo",
 * que no lleva a ningún refund: `settled` no está en (`refundeable`, `flow.tsx:1479`), que es
 * lo que monta `RefundAction`. WKH-351 sacó el Pill de esa tarjeta; el residual sigue vivo.
 *
 * DÓNDE ESTÁ LA PUERTA para esa fila, que es lo que faltaba decir: (`LostEscrowRecovery`,
 * `flow.tsx:890`), en la pantalla de inicio. No mira el estado local de la remesa: resuelve el id
 * contra el registro durable y elige el PRIMER escrow `Deposited` del sender
 * (`Deposited`, `../infrastructure/solana-wallet.ts:400`); del `deadline` se ocupa después el guard
 * del refund. Lo que QUEDA VIVO, y son DOS cosas: la frase no dice dónde está esa puerta, y si el
 * primer escrow abierto del sender NO está vencido, esa puerta tira `refund_before_deadline` y NO
 * llega hasta esta fila. Se ACOTÓ; no se cerró.
 *
 * Sobre `"chain-released"`: dice "salieron del escrow hacia el pago" y NO dice "entregado". Esa
 * palabra ya es de (`statusDisplay`, `:133`) para `settled`, que habla de otro hecho, el partner de
 * payout reportando que entregó los PEN. Desde WKH-351 esa etiqueta vive en el recibo. Candado: T-V8.
 */
export function escrowOutcomeDisplay(o: EscrowOutcome): {
  copy: string;
  emphasis: "strong" | "normal";
} {
  if (o === "chain-deposited-window-open")
    return { copy: "El contrato dice que tus USDC siguen en el escrow, a tu nombre.", emphasis: "strong" };
  if (o === "chain-deposited-window-closed")
    return {
      copy: "El contrato dice que tus USDC siguen en el escrow y que el plazo para liberarlos al pago ya venció: la salida que queda es devolverlos a tu wallet, y sólo tu firma puede hacerlo.",
      emphasis: "strong",
    };
  if (o === "chain-refunded")
    return { copy: "El contrato dice que tus USDC ya volvieron a tu wallet.", emphasis: "normal" };
  if (o === "chain-released")
    return { copy: "El contrato dice que tus USDC ya salieron del escrow hacia el pago.", emphasis: "normal" };
  if (o === "chain-absent-after-deposit")
    return { copy: "Tu depósito entró: de eso quedó la firma de la transacción, confirmada en la cadena. Y en la dirección que le corresponde a este envío no hay ninguna cuenta: miramos esa dirección sola, no el contrato entero, y eso es todo lo que medimos. Desde acá no podemos decir si terminó en un pago o en una devolución, ni descartar que la cuenta siga abierta en otra dirección: la que miramos se calcula con la wallet conectada, así que si depositaste con otra, cambiá a esa cuenta en tu billetera y volvé a la pantalla de inicio: ahí está la opción de recuperar un envío perdido.", emphasis: "normal" };
  // La frase de abajo queda BYTE-IDÉNTICA (CD-8): la rama nueva se AGREGA, no reescribe a `chain-absent`.
  if (o === "chain-absent")
    return { copy: "En el contrato no hay ninguna cuenta para este envío: o el depósito nunca entró, o ya se cerró después de resolverse. Desde acá no podemos decir cuál de las dos.", emphasis: "normal" };
  if (o === "chain-unknown")
    return { copy: "No pudimos preguntarle al contrato por este envío.", emphasis: "normal" };
  if (o === "chain-pending")
    return { copy: "Le estamos preguntando al contrato.", emphasis: "normal" };
  return { copy: escrowKnowledgeCopy(o), emphasis: "normal" };
}

/**
 * WKH-350 · LA AGRUPACIÓN DEL HISTORIAL: bajo qué encabezado se muestra cada fila.
 *
 * Acá NO se calcula ningún desenlace nuevo ni se le pregunta nada a la cadena. Se toma el
 * `EscrowOutcome` que ya produce (`escrowOutcome`, `:1193`) y se dice a qué sección va esa fila.
 *
 * LA PARTICIÓN ES TOTAL. Los 12 valores de (`EscrowOutcome`, `:1167`) se reparten entre los 4 grupos
 * sin solapamiento y sin sobrantes, así que toda fila aparece siempre, exactamente una vez, bajo un
 * encabezado visible. De ahí se sigue que ocultar un grupo sin filas es inocuo: un grupo vacío
 * significa "ninguna de tus filas cayó acá", nunca "acá hay filas que no te estamos mostrando".
 *
 * ⚠️ RESIDUAL DECLARADO. Ese razonamiento vale mientras los grupos sean estos 4. Si alguien agrega un
 * 5.º grupo que SÍ pueda quedar vacío significando "esto no lo medimos", ocultarlo pasa a esconder una
 * ausencia de medición, y ahí hay que mostrarlo diciendo que no se midió. Quien agregue ese grupo
 * tiene que volver a este comentario, porque el razonamiento de arriba deja de valer.
 *
 * POR QUÉ G3 SE LLAMA "Sin plata en el escrow" Y NO "Resueltos". Sus cuatro miembros no comparten
 * ningún final. `chain-released` dice que los USDC ya salieron del escrow hacia el pago
 * (`escrowOutcomeDisplay`, `:1251`), y eso NO es "entregado": esa palabra es de
 * (`statusDisplay`, `:133`) para `settled` y habla de otro hecho, el partner reportando que pagó. Y
 * `no-deposit` dice "No llegaste a depositar." (`escrowKnowledgeCopy`, `:256`), que no es un envío
 * resuelto sino uno que no ocurrió. Lo único que los cuatro sostienen es que no hay plata tuya
 * adentro del escrow, y eso es exactamente lo que el encabezado dice.
 *
 * POR QUÉ G4 SE LLAMA "Sin respuesta sobre tu plata" Y NO "Sin respuesta clara de la cadena". Sus miembros, que son CINCO y
 * hay que contarlos en (`GRUPO_POR_DESENLACE`, `:1354`) y no en este párrafo, no llegaron por el mismo motivo. `chain-absent`
 * y `chain-absent-after-deposit` SÍ recibieron respuesta, y clarísima: no hay cuenta; lo que no se puede es inferir qué
 * significa. `chain-pending` tiene la consulta EN VUELO. A `unverified` no se le preguntó NUNCA (sale sólo por ese bucket,
 * (`idsAConsultar`, `flow.tsx:3151`), y (`escrowOutcome`, `:1193`) devuelve el conocimiento local tal cual con `"not-asked"`)
 * y a `chain-unknown` no se le PUDO: un encabezado que hable de "respuesta de la cadena" aparenta, para esos DOS, una consulta que no existió.
 *
 * POR QUÉ G2 NO DICE "todavía en plazo". A `in-escrow` no se le pregunta a la cadena, así que el
 * sistema no sabe si esa fila está en plazo, y la frase por fila de `chain-deposited-window-open`
 * calla el plazo a propósito (`escrowOutcomeDisplay`, `:1251`). Afirmarlo en el encabezado
 * reintroduce un nivel más arriba el error que ya se cerró a nivel de fila.
 *
 * ⚠️ RESIDUAL DE G1, Y ES EL QUE NO ESTABA DECLARADO EN NINGÚN LADO: "Necesitan tu firma" NO contiene
 * a todas las filas que necesitan una firma. G1 es exactamente `chain-deposited-window-closed`, y ese
 * desenlace sólo se alcanza por filas `unverified`, porque (`escrowOutcome`, `:1193`) corta en su
 * primer `if` y descarta la respuesta de la cadena cuando el conocimiento local ya resolvió. Input
 * concreto: una fila con `PRINCIPAL_SETTLED_REFUND_MANUAL` (⇒ `"in-escrow"` por la rama 2 de
 * (`escrowFundsKnowledge`, `:206`), el `if` de la línea 215) para la que la cadena contesta
 * `deposited-window-closed` cae en G2, no en G1: su plazo venció y su única salida también es una
 * firma, y el encabezado que la nombra dice otra cosa.
 *
 * Esto NO es un bug del corte —el corte está argumentado en (`escrowOutcome`, `:1193`) y su candado es
 * T-V1— ni rompe ningún AC: los ACs definen G1 por `EscrowOutcome === "chain-deposited-window-closed"`,
 * y esa fila sigue visible, con su copy de siempre, bajo G2. Lo que queda vivo es la LECTURA del
 * encabezado: se lee como "estas son TODAS las que necesitan tu firma" y es "estas son las que la
 * cadena nos dejó saber que la necesitan". Quien agregue la acción de refund por grupo tiene que
 * volver acá: colgarla sólo de G1 la deja fuera del alcance de estas filas.
 */
export type HistoryGroup = "firma" | "con-plata" | "sin-plata" | "sin-respuesta";

/** Orden de render, por severidad decreciente. No alfabético, no cronológico, no por cantidad. */
export const HISTORY_GROUP_ORDER: readonly HistoryGroup[] = [
  "firma",
  "con-plata",
  "sin-plata",
  "sin-respuesta",
];

/** El texto de cada encabezado. Cambiar uno de estos cuatro pone rojo a T-H1 y a T-H2. */
export const HISTORY_GROUP_HEADING: Record<HistoryGroup, string> = {
  firma: "Necesitan tu firma",
  "con-plata": "Con plata en el escrow",
  "sin-plata": "Sin plata en el escrow",
  "sin-respuesta": "Sin respuesta sobre tu plata",
};

/**
 * El mapa, con las 12 claves. Es un `Record` y NO una cadena de `if`, a propósito: si mañana
 * (`EscrowOutcome`, `:1167`) gana un valor nuevo y nadie le da grupo, esto NO COMPILA. Un `if`-chain
 * cerrado con un `return` por defecto se traga el mismo olvido y se despliega en silencio. La
 * diferencia entre un candado y una prosa. Ojo: lo caza `tsc`, no vitest, que no typechequea.
 */
const GRUPO_POR_DESENLACE: Record<EscrowOutcome, HistoryGroup> = {
  "chain-deposited-window-closed": "firma",
  "in-escrow": "con-plata",
  "chain-deposited-window-open": "con-plata",
  returned: "sin-plata",
  "chain-refunded": "sin-plata",
  "chain-released": "sin-plata",
  "no-deposit": "sin-plata",
  unverified: "sin-respuesta",
  "chain-pending": "sin-respuesta",
  "chain-absent": "sin-respuesta", "chain-absent-after-deposit": "sin-respuesta",
  "chain-unknown": "sin-respuesta",
};

export function historyGroupFor(o: EscrowOutcome): HistoryGroup {
  // El `??` es inalcanzable por tipos y existe sólo para un valor que llegue de afuera del tipo. El
  // fallback es "sin-respuesta" y no otro porque es el grupo que MENOS afirma: un desconocido bajo
  // "Sin plata en el escrow" sería una afirmación falsa y tranquilizadora sobre la plata de alguien;
  // bajo "Sin respuesta sobre tu plata" no afirma nada. Es la misma doctrina que ya está escrita para
  // el desenlace en (`escrowOutcome`, `:1193`): el lado seguro, el que no afirma nada sobre fondos.
  return GRUPO_POR_DESENLACE[o] ?? "sin-respuesta";
}
