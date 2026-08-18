/**
 * Vocabulario de los RECHAZOS DE NEGOCIO: las respuestas en que el agente que atendió el paso LEYÓ el
 * pedido y lo negó. No son lo mismo que el agente caído, y hasta acá se decían igual.
 *
 * 🔴 ACÁ SE NOMBRABAN DOS AGENTES POR SU SLUG, Y DESDE WKH-332 NO SE PUEDE (AC-2). Este repo pide
 * CAPACIDADES: `remittance-fx-quote` y `remittance-payout`. Quién las cumple lo resuelve el gateway
 * AL EJECUTAR, así que una familia de rechazos que dijera "el agente X rechazó" estaría nombrando a
 * alguien que puede no haber sido. Las familias se nombran por la capacidad, que es lo que sí sabemos.
 *
 * QUÉ ESTABA MAL, medido en producción el 2026-08-04 contra `/api/a2a/quote`:
 *
 *     POST {"amountUsd":2}     -> 502 a2a_upstream_error
 *     POST {"amountUsd":50000} -> 502 a2a_upstream_error
 *
 * El agente había contestado `400 fx_amount_below_minimum` y `400 fx_amount_above_maximum`. O sea
 * que "el monto está fuera del rango que este corredor acepta" llegaba como "el agente se cayó":
 * un diagnóstico que manda a mirar la red y el deploy, cuando lo único que hay que hacer es cambiar
 * el número. Del lado del desembolso pasaba lo mismo con más causas: `prepare_no_deposit_address`
 * cubría CINCO (cuatro rechazos del agente más "el provider es mock"), y el `reason` que el agente
 * mandaba se validaba de tipo y no se leía nunca.
 *
 * ── DOS LISTAS, Y NO ES BUROCRACIA ───────────────────────────────────────────────────────────────
 * Un `reason` puede ser seguro de LOGUEAR y a la vez inseguro de DEVOLVER. El body de una ruta
 * pública es un oráculo para cualquiera que la sondee, y este repo ya colapsó a propósito los tres
 * veredictos de KYC en uno solo por esa razón (WKH-205, `app/api/payout/validate/route.ts`:78).
 * El criterio que separa las dos listas, escrito para que se pueda aplicar a un reason nuevo:
 *
 *   · RELAYABLE — el rechazo habla del PEDIDO QUE HIZO QUIEN LLAMA: su monto, su cotización, un
 *     campo que no mandó. Quien llama ya sabe lo que mandó, así que devolvérselo no le informa nada
 *     que no tuviera, y es lo único que le permite corregir.
 *   · SÓLO LOG — el rechazo es un VEREDICTO sobre un estado que quien llama no controla (el estado
 *     KYC de una verificación, por ejemplo). Devolverlo convierte la ruta en un oráculo de ese
 *     estado, que es exactamente lo que WKH-205 cerró.
 *
 * Ante la duda gana la lista corta: lo que no está en RELAYABLE sale COLAPSADO en el enum de
 * familia y el detalle queda en el log del server, donde el operador sí lo ve. Colapsado no es
 * perdido, y el enum de familia ya dice la mitad que importaba (rechazo, no caída).
 */

/** Familia: quien atendió la capacidad `remittance-fx-quote` rechazó la cotización. Enum que sale al
 *  browser SIEMPRE que llegue un rechazo de ese leg.
 *
 *  ⚠️ HOY NINGÚN PRODUCTOR DE ESTA APP LO EMITE, y eso está escrito acá para que no se lea como un
 *  camino vivo. Lo emitía la rama punto a punto de `/api/a2a/quote`, que leía el body de error del
 *  agente; WKH-332/W3 la borró y por `/compose` el step fallado viaja sin `code` y sin `reason`. Se
 *  conserva porque el valor SÍ puede llegar desde el almacenamiento local: una remesa guardada antes
 *  de ese deploy tiene este enum en su `failureReason`, y `humanError` le sigue dando copy propio.
 *  El desenlace estructural está pedido en WKH-335 (`wasiai-a2a`, otro repo). */
export const QUOTE_REJECTED = "a2a_quote_rejected";

// 🔴 ACÁ VIVÍA `RELAYABLE_QUOTE_REJECTIONS` = ["fx_amount_below_minimum", "fx_amount_above_maximum"],
// Y SE FUE CON SU ÚNICO CAMINO (WKH-332/W4, AC-5). Era la allow-list de los `reason` del agente de FX
// que se relayaban al browser, y `fx_*` es su vocabulario PRIVADO. Los dos lectores que tenía —el
// `readQuoteRejection` de la route y el de `gateways.ts`— filtraban el `reason` que llegaba en el body
// de error del agente invocado por su slug. Ese carril no existe, así que la lista no filtra nada: no
// hay `reason` que llegar. Dejarla habría sido una allow-list de un canal cerrado, o sea un control
// que se lee como activo y no mira nada.
// ⛔ Reintroducirla exigiría que `/compose` mande el desenlace estructural (WKH-335, otro repo). Hasta
// entonces, AC-4 está declarado NO CUMPLIDO y el candado que lo deja escrito es T-4.1' en
// `src/presentation/flow-vm.test.ts`.

/** Familia: quien atendió la capacidad `remittance-payout` rechazó crear la orden. Enum que sale al
 *  browser SIEMPRE. */
export const PREPARE_REJECTED = "prepare_agent_rejected";

/**
 * Rechazos del leg de `remittance-payout` que SÍ se devuelven al browser. Los tres hablan del pedido
 * de quien llama: su cotización (monto que no coincide / cotización que ya no resuelve) y un campo de
 * identidad que su propio request no traía.
 *
 * ⚠️ A DIFERENCIA DE LA LISTA DE FX, ESTA SIGUE VIVA, y la asimetría no es un descuido: el agente de
 * payout contesta su rechazo en el `output` del step (`status: "blocked"` + `reason`), o sea DENTRO
 * del 200 de `/compose`, que sí llega intacto. El de FX lo contestaba con un status HTTP de error, que
 * es justamente lo que el gateway colapsa.
 *
 * ⚠️ `kyc_gate_not_passed` NO está en esta lista, y su ausencia es la decisión, no un olvido. Es un
 * VEREDICTO sobre una verificación de identidad, o sea la familia exacta que WKH-205 colapsó del
 * lado de `/api/payout/validate`. Devolverlo abriría un segundo canal para preguntar por el estado
 * KYC de una verificación — y encima un canal que puede discrepar del nuestro, porque el gate del
 * agente y `resolvePayoutAuthority` no leen lo mismo. Sale colapsado en `PREPARE_REJECTED`, que ya
 * dice lo que la persona necesita saber (el envío no se preparó, no se movió nada), y el detalle
 * queda en el log del server.
 */
export const RELAYABLE_PREPARE_REJECTIONS: readonly string[] = [
  "quote_amount_mismatch",
  "quote_unresolvable",
  "kyc_identity_claim_missing",
];

/**
 * El enum que la route emite por un rechazo relayable: el reason del agente con el prefijo del
 * resto de los enums de esa route (`prepare_*`).
 *
 * El prefijo no es cosmético: el `reason` termina persistido como `failureReason` de la remesa y
 * leído por el cliente igual que `prepare_upstream_error` o `prepare_unavailable`. Un
 * `quote_amount_mismatch` pelado ahí adentro no dice de qué paso salió, y `quote` ya nombra otra
 * cosa en este flujo (`quote_expired_before_submit`).
 */
export function prepareRejectionEnum(raw: unknown): string {
  return typeof raw === "string" && RELAYABLE_PREPARE_REJECTIONS.includes(raw)
    ? `prepare_${raw}`
    : PREPARE_REJECTED;
}

/** Los enums de rechazo del prepare, ya prefijados: lo que ve el cliente y lo que queda escrito en
 *  `failureReason`. Familia incluida, porque un rechazo colapsado es un rechazo igual. */
export const PREPARE_REJECTION_ENUMS: readonly string[] = [
  PREPARE_REJECTED,
  ...RELAYABLE_PREPARE_REJECTIONS.map((r) => `prepare_${r}`),
];

/**
 * Reasons del payout que se loguean VERBATIM. Es una lista cerrada a propósito: el `reason` del
 * agente es `string | null` por contrato y nada garantiza que un agente roto no meta ahí texto
 * libre. Loguear sólo lo que está en esta lista hace que el log sea value-free POR CONSTRUCCIÓN
 * (CD-5/CD-9) en vez de por confianza en el otro repo. Lo que no está se loguea como `unmapped`,
 * que sigue siendo la señal útil: "llegó un rechazo que este código no conoce, andá a mirar el
 * agente". Incluye `kyc_gate_not_passed`, que es loggable aunque no sea relayable.
 */
export const LOGGABLE_PREPARE_REJECTIONS: readonly string[] = [
  ...RELAYABLE_PREPARE_REJECTIONS,
  "kyc_gate_not_passed",
];

// 🔴 ACÁ VIVÍA `relayableRejection(family, raw, relayable)` Y SE FUE CON LA LISTA QUE FILTRABA
// (WKH-332/W4). Era el helper genérico que decidía si un `reason` del agente se propagaba crudo o
// colapsado, y su ÚNICO llamador de producción era el `readQuoteRejection` de `/api/a2a/quote`, que se
// borró en W3. MEDIDO al borrarla: los llamadores que quedaban estaban todos en `*.test.*`, y este
// repo tiene escrito por qué eso no cuenta — si todos los call-sites de una función están en tests, la
// función no existe en producción y su verde no habla del código.
// El equivalente del leg de payout, `prepareRejectionEnum` (abajo), SÍ tiene llamador y se queda: ese
// `reason` llega dentro del 200 de `/compose`, no en un status HTTP de error.

/**
 * ── "NO HAY QUIÉN" ES UN DESENLACE PROPIO, NI UN RECHAZO NI UNA CAÍDA (WKH-332/AC-13) ────────────
 *
 * El gateway resuelve la capacidad al ejecutar. Cuando NINGÚN agente la cumple bajo las constraints
 * del step, contesta 422 y el cliente lo trae como `no_agent_match` (`gateway-client.ts`, el `case
 * 422` de `mapErrorStatus`). Hasta acá eso salía colapsado en `prepare_upstream_error` / `a2a_unavailable`,
 * o sea con las palabras de "el otro lado se cayó", y la pantalla invitaba a reintentar. Reintentar
 * no crea un agente: la misma llamada, un segundo después, vuelve a no encontrar a nadie.
 *
 * ⚠️ POR QUÉ NO ENTRAN EN NINGUNA DE LAS DOS LISTAS DE ARRIBA. Las listas RELAYABLE / SÓLO-LOG
 * clasifican el `reason` que un AGENTE devolvió tras LEER el pedido. Acá no hubo agente: nadie leyó
 * nada. Aplicarles el criterio de esas listas sería clasificar una respuesta que no existe.
 *
 * Y por eso mismo tampoco entran en `PREPARE_REJECTION_ENUMS`: esa constante habilita el copy *"El
 * agente de pagos rechazó esta remesa"* (`flow.tsx`, la rama `prepareRejected`), y esa frase sería
 * FALSA acá — afirmaría un acto de un agente que nunca fue elegido. Es la misma clase de error que
 * esta HU vino a cerrar, sólo que del lado del texto.
 *
 * Lo que sí comparten con esa familia es el HECHO que habilita la segunda mitad del copy: el prepare
 * corre ANTES de `authorizePrincipal` (`confirm-and-send.ts`:384-388), o sea antes de que la wallet
 * firme nada. "No se movió ningún USDC" no es un consuelo: se lee del orden del use-case.
 *
 * 🔴 Un enum propio NUESTRO no es un eco del gateway (CD-5): no viaja el `message`, ni la URL, ni el
 * `reason` del otro lado. Viaja UNA palabra nuestra, elegida por nosotros, para un desenlace nuestro.
 * Y sólo se abre `no_agent_match`: `payment_required` (402, la Agent Key sin saldo) SIGUE colapsado
 * en el enum de caída a propósito, porque lo que un 402 filtraría no es un dato del pedido de quien
 * llama sino del estado operativo nuestro.
 *
 * ⚠️ NINGUNO DE LOS DOS CONTIENE LAS SUBCADENAS "kyc" NI "payout", y eso NO es casualidad:
 * `humanError` decide por `code.includes(...)` en cascada con dos catch-all al final, así que un
 * enum que las contuviera quedaría tragado por el copy equivocado. `prepare_no_agent_for_capability`
 * empieza con "prepare", no con "payout". T-13.3 lo custodia como propiedad, no como comentario.
 */
export const PREPARE_NO_AGENT_FOR_CAPABILITY = "prepare_no_agent_for_capability";
export const QUOTE_NO_AGENT_FOR_CAPABILITY = "a2a_no_agent_for_capability";

/**
 * ── EL 422 NO ES UN SOLO DESENLACE: SON CUATRO, Y UNO ES "NO PUDE PREGUNTAR" (AR/BLQ-MED-1) ───────
 *
 * `mapErrorStatus` traduce TODO 422 a `no_agent_match`, pero el gateway manda además un `reason` que
 * viaja intacto en `GatewayFailure.reason`. Los cuatro valores que emite hoy, MEDIDOS en
 * `wasiai-a2a/src/services/capability-resolver.ts:69-80`:
 *
 *   · `no_candidates`          — ninguna capacidad de ese nombre en el catálogo
 *   · `excluded_by_scope`      — los hay, pero nuestra credencial no los alcanza
 *   · `excluded_by_reputation` — los hay, y ninguno llega al piso
 *   · `reputation_unavailable` — 🔴 EL GATEWAY NO PUDO LEER EL HISTORIAL. Su propio docblock allá:
 *     *"acá no sabemos si llegan. Un reintento PUEDE resolverlo; bajar el piso, no."*
 *
 * Los tres primeros son hechos sobre el CATÁLOGO y el copy de esta HU los dice bien. El cuarto es un
 * hecho sobre el GATEWAY, y para él las dos mitades de ese copy son FALSAS: no dice "no hay ningún
 * proveedor" —no lo sabemos— y "volver a intentar no cambia el resultado" desaconseja exactamente lo
 * único que puede funcionar. Colapsarlos era una REGRESIÓN DE PRECISIÓN: antes salía por el copy
 * genérico ("Algo salió mal. Intentá de nuevo"), que para ese caso era vago y CORRECTO.
 *
 * 🔴 LA DIRECCIÓN DEL DEFAULT ES LA DECISIÓN, y es fail-closed hacia lo vago: sólo los reasons de
 * esta allowlist habilitan la afirmación fuerte. Un `reason` ausente (un 422 de un proxy, de un
 * middleware o de una versión del gateway que no lo mande) o uno que no conozcamos NO la habilita, y
 * sale por el enum de caída. El costo de equivocarse hacia acá es un diagnóstico pobre; hacia el
 * otro lado es una frase falsa sobre el catálogo, que es el bug que esta HU vino a cerrar.
 *
 * Es la misma técnica que `prepareRejectionEnum` (arriba): se RAMIFICA por el valor del otro lado,
 * NUNCA se lo ecoa. Lo que sale al browser sigue siendo una palabra nuestra, y el body sigue
 * teniendo exactamente una clave (CD-8).
 */
export const NO_AGENT_REASONS_MEANING_NOBODY: readonly string[] = [
  "no_candidates",
  "excluded_by_scope",
  "excluded_by_reputation",
];

/**
 * ¿Este 422 dice "no hay quién", o dice "no pude averiguarlo"?
 *
 * Input que la pone en rojo: `reason: "reputation_unavailable"` devolviendo `true` — ahí la pantalla
 * volvería a afirmar que no hay proveedor y a desaconsejar el reintento que sí sirve.
 */
export function noAgentMeansNobodyFits(reason: unknown): boolean {
  return typeof reason === "string" && NO_AGENT_REASONS_MEANING_NOBODY.includes(reason);
}

/**
 * ¿Este `failureReason` de una remesa viene de un rechazo del agente de payout en el PREPARE?
 *
 * Existe para la UI, y lo que habilita es una afirmación de hecho: el prepare corre ANTES de
 * `authorizePrincipal` (`confirm-and-send.ts`:381-386), o sea antes de que la wallet firme nada.
 * Cuando el corte es acá, "no se movió ningún USDC" no es un consuelo: es un hecho verificable
 * leyendo el orden del use-case.
 */
export function isPrepareRejection(reason: string | null | undefined): boolean {
  return PREPARE_REJECTION_ENUMS.includes(reason ?? "");
}

/**
 * ── "NO LLEGAMOS A PREGUNTAR" NO ES UN RECHAZO, Y HASTA EL FIX-PACK SE DECÍA COMO UN PAYOUT FALLADO
 *    (WKH-358 fix-pack · AR/BLQ-MED-2) ──────────────────────────────────────────────────────────────
 *
 * 🔴 QUÉ AGUJERO CIERRA, MEDIDO. Estos dos enums NO están en `PREPARE_REJECTION_ENUMS` (correcto: nadie
 * rechazó nada) y tampoco los nombraba ninguna rama de la pantalla, así que caían en el `else` del
 * dispatch de `track` ⇒ `humanError("payout_failed")` ⇒ *"No se pudo entregar. No hay un reembolso
 * automático: si tus USDC entraron al escrow, los sacás vos firmando desde tu wallet."* Esa frase manda
 * a buscar plata a un lugar donde hay CERTEZA de que no hay: los dos salen de `failAndRefund(..., "not_deposited")`
 * (`prepare_unavailable`, `./use-cases/confirm-and-send.ts:477`), o sea ANTES de `authorizePrincipal` y
 * sin un solo POST al settle. Es el mismo defecto que `PREPARE_NO_AGENT_FOR_CAPABILITY` cerró de su lado.
 *
 * ⚠️ EN QUÉ SE DIFERENCIAN DE LA FAMILIA `prepareRejected`, y por eso son una rama propia y no una fila
 * más de esa lista: allá un agente LEYÓ el pedido y lo negó, así que el copy puede afirmar dos cosas
 * ("el agente rechazó" + "no se firmó nada"). Acá **no hubo respuesta de nadie**: la petición no salió,
 * o salió y no volvió. Lo único que se puede afirmar es la segunda mitad.
 *
 * ⛔ Y EL COPY NO PUEDE DECIR "no se pidió ninguna firma": `payout_pop_unavailable` sale de que
 * `pop.prove()` falló ((`prove`, `../infrastructure/settlement/http-solana-prepare-gateway.ts:224`)).
 * ⚠️ ACÁ DECÍA QUE «esa prueba SÍ le pide a la billetera firmar un mensaje», Y ES DEMASIADO ANCHO (re-AR
 * it2 · MNR-4): (`prove`, `../infrastructure/auth/http-pop-signer.ts:16`) tiene TRES salidas y **sólo una
 * toca la billetera**. Las otras dos cortan ANTES de (`signMessage`, `../infrastructure/auth/http-pop-signer.ts:29`):
 * el `501` de `:22` (nuestro server sin `PAYOUT_POP_SECRET` ⇒ devuelve `null`) y el `!ok`/red caída de
 * `:23`. El fundamento correcto es más chico y alcanza igual: la tercera salida EXISTE y es alcanzable,
 * así que NO SE PUEDE AFIRMAR que no se pidió firma. Ese mensaje no mueve plata, pero es una firma, y
 * negarla sería exactamente la clase de afirmación de más que esta familia vino a corregir.
 * ⚠️ Y LA CONTRACARA, QUE VIVE EN EL COPY Y NO ACÁ: el sub-caso 501 es NUESTRO, no de la red ni del
 * navegador. El copy de (`payout_pop_unavailable`, `../presentation/flow-vm.ts:742`) nombraba sólo esas dos causas y
 * dejaba a la persona sin la real y sin señal de que el problema es de nuestro lado; hoy nombra las tres.
 *
 * ⚠️ LOS DOS LITERALES ESTÁN ESCRITOS ACÁ Y TAMBIÉN EN SUS PRODUCTORES, y eso es una segunda lista — el
 * defecto que WKH-332/AR-BLQ-ALTO-2 midió en `container.ts`. No se puede cerrar por construcción sin
 * mover enums que esta HU no toca, así que se cierra por MEDICIÓN: `agent-rejections.test.ts` deriva los
 * dos del texto de sus productores con un regex y exige que `isPrepareUnreachable` los reconozca. Si
 * alguien renombra un enum del gateway, ese `it` se pone rojo y esta lista no queda mintiendo sola.
 */
export const PREPARE_UNREACHABLE_ENUMS: readonly string[] = ["prepare_unavailable", "payout_pop_unavailable"];

/** ¿Este `failureReason` dice "no llegamos a preguntarle a nadie", en vez de "alguien nos dijo que no"? */
export function isPrepareUnreachable(reason: string | null | undefined): boolean {
  return PREPARE_UNREACHABLE_ENUMS.includes(reason ?? "");
}
