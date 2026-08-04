/**
 * Vocabulario de los RECHAZOS DE NEGOCIO de los agentes remit-*: las respuestas en que el agente
 * LEYÓ el pedido y lo negó. No son lo mismo que el agente caído, y hasta acá se decían igual.
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
 * veredictos de KYC en uno solo por esa razón (WKH-205, `app/api/payout/validate/route.ts`:66).
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

/** Familia: `remit-corridor-fx` rechazó la cotización. Enum que sale al browser SIEMPRE que el
 *  agente conteste un rechazo, con o sin `reason` relayable al lado. */
export const QUOTE_REJECTED = "a2a_quote_rejected";

/**
 * Rechazos de `remit-corridor-fx` que SÍ se devuelven al browser.
 *
 * Los dos hablan del monto que mandó quien llama contra una política pública del corredor: el
 * mínimo ya está copiado en el cliente (`MIN_SEND_USD`, `src/domain/remittance.ts`:160) y se
 * muestra en pantalla, así que devolverlo no publica nada nuevo. Del techo no había copia local:
 * antes de esto un envío por encima del máximo era indistinguible de una caída.
 */
export const RELAYABLE_QUOTE_REJECTIONS: readonly string[] = [
  "fx_amount_below_minimum",
  "fx_amount_above_maximum",
];

/** Familia: `remit-cashout-payout` rechazó crear la orden. Enum que sale al browser SIEMPRE. */
export const PREPARE_REJECTED = "prepare_agent_rejected";

/**
 * Rechazos de `remit-cashout-payout` que SÍ se devuelven al browser. Los tres hablan del pedido de
 * quien llama: su cotización (monto que no coincide / cotización que ya no resuelve) y un campo de
 * identidad que su propio request no traía.
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

/** El reason tal como se propaga al cliente: el detalle del agente si es relayable, y si no el
 *  enum de familia. NUNCA el string crudo de un reason desconocido. */
export function relayableRejection(
  family: string,
  raw: unknown,
  relayable: readonly string[],
): string {
  return typeof raw === "string" && relayable.includes(raw) ? raw : family;
}

/**
 * ¿Este `failureReason` de una remesa viene de un rechazo del agente de payout en el PREPARE?
 *
 * Existe para la UI, y lo que habilita es una afirmación de hecho: el prepare corre ANTES de
 * `authorizePrincipal` (`confirm-and-send.ts`:313-333), o sea antes de que la wallet firme nada.
 * Cuando el corte es acá, "no se movió ningún USDC" no es un consuelo: es un hecho verificable
 * leyendo el orden del use-case.
 */
export function isPrepareRejection(reason: string | null | undefined): boolean {
  return PREPARE_REJECTION_ENUMS.includes(reason ?? "");
}
