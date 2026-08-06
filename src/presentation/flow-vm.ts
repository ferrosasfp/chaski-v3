import type { Money } from "../domain/money";
import { MIN_SEND_USD } from "../domain/remittance";
import type { RemittanceState, RemittanceStatus } from "../domain/remittance";
import {
  PRINCIPAL_SETTLED_REFUND_MANUAL,
  PRINCIPAL_STATE_UNKNOWN,
} from "../application/use-cases/confirm-and-send";
import { ESCROW_REFUNDED_BY_SENDER } from "../application/use-cases/recover-escrow-funds";
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
export const REAL_PAYOUT_PROVENANCES: ReadonlySet<string> = new Set(["transfi"]);

/** true si la proveniencia del payout indica un desembolso NO real (mock). `null`/`undefined`
 *  (remesa sin payout aún / legacy) → false (no fuerza el banner por ausencia de dato). */
export function isPayoutDemo(p: string | null | undefined): boolean {
  return p != null && !REAL_PAYOUT_PROVENANCES.has(p);
}

/**
 * Proveniencias de KYC que representan una verificación REAL (allowlist fail-safe, misma dirección
 * que `REAL_PAYOUT_PROVENANCES`). El valor NO se escribe a mano acá: se importa de la MISMA constante
 * que lo produce (`decision.ts`), así que un rename del literal rompe la compilación en vez de dejar
 * esta lista apuntando a un valor que ya nadie emite.
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
 * `kyc-gateway.ts`:42 castea la respuesta HTTP sin validar (`provenance` puede no venir), y
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

/**
 * Copy de los errores de la puerta "Recuperar un envío perdido" (la recuperación SIN remittanceId).
 *
 * Existe porque el MISMO código significa dos cosas distintas según por dónde se entró, y la más
 * cara es `escrow_not_found`:
 *
 *  · En la acción normal el id es conocido, así que "no encontramos un depósito tuyo en el escrow"
 *    habla de UNA remesa concreta y la frase de `escrowRefundError` es correcta.
 *  · Acá el id no existe: se le pide la lista al store durable server-side y se sondean hasta
 *    `maxCandidates` PDAs on-chain (`resolveRemittanceIdFromLedger`, `solana-wallet.ts:277`). `escrow_not_found` sale de DOS
 *    situaciones que no se distinguen desde afuera: el servidor no devolvió ningún id, o ninguno de
 *    los sondeados estaba `Deposited`. Ninguna de las dos prueba que la persona no tenga fondos.
 *
 * Por eso la frase habla de lo que MIRAMOS, no de lo que la persona tiene. `maxCandidates` entra por
 * parámetro y no como un número escrito acá: el llamador pasa la MISMA constante que sondea
 * (`MAX_RECOVERY_CANDIDATES`), así que el copy no puede quedar diciendo un número que el código dejó
 * de usar.
 */
export function lostEscrowRecoveryError(code: string, maxCandidates: number): string {
  if (code.includes("escrow_not_found"))
    return `No encontramos escrows abiertos para esta billetera. Esto no dice que no tengas fondos: dice que ninguno de los últimos ${maxCandidates} envíos que el servidor tiene guardados de esta billetera está abierto en el contrato.`;
  // "No pudimos preguntar" no es "no hay nada". `escrow_id_unavailable` = esta pantalla no tiene el
  // resolver cableado; `escrow_recovery_unavailable` = el endpoint contestó algo que no es 200/403/501
  // (`escrow_recovery_unavailable`, `http-solana-remittance-id-resolver.ts:40`). En los dos casos no llegamos a mirar la cadena.
  if (code.includes("escrow_id_unavailable") || code.includes("escrow_recovery_unavailable"))
    return "No pudimos consultar el registro de envíos. Esto no es una respuesta sobre tus fondos: no llegamos a preguntar. Probá de nuevo en un rato.";
  return escrowRefundError(code);
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
 *    que inyecta es una incógnita declarada del propio repo (`solana-escrow-rent.ts:80-82`) y esta
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
 * dice — es la misma trampa que `probeEscrowRefunded` ya tiene escrita (`probeEscrowRefunded`, `solana-wallet.ts:692`).
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
    return "Reconectá o desbloqueá tu wallet para continuar.";
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
  if (code.includes("kyc")) return "No pudimos verificar tu identidad.";
  // ⚠️ ACÁ SE PROMETÍA UN REEMBOLSO QUE NO EXISTE: "Si te cobramos, te reembolsamos". El adapter de
  // refund por defecto (`LedgerRefundGateway`) no mueve un peso y devuelve `refundTx: null` a
  // propósito; el use-case ni siquiera escribe `refunded` sin comprobante real
  // (`confirm-and-send.ts`:218-221). Sacar los USDC del vault es o el refund trustless que firma la
  // propia persona, o la release-authority a mano. O sea que nadie devuelve nada solo.
  //
  // Es el texto que MÁS se lee de este archivo: TrackView lo usa como último recurso para cualquier
  // `payout_failed` cuyo reason no reconozca (`humanError`, `flow.tsx:1262`), justo cuando no sabemos dónde está la
  // plata. Prometer un reembolso ahí manda a esperar sentado en vez de a la única acción que sirve.
  if (code.includes("payout"))
    return "No se pudo entregar. No hay un reembolso automático: si tus USDC entraron al escrow, los sacás vos firmando desde tu wallet.";
  return "Algo salió mal. Intentá de nuevo.";
}
