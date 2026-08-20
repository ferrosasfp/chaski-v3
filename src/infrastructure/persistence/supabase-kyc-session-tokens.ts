// Infrastructure — el `decisionToken` del agente de KYC, at-rest (WKH-233/W2.5). SERVER-ONLY (CD-10):
// usa el cliente de `supabase-server.ts` (SUPABASE_SERVICE_ROLE_KEY / BYPASSRLS). ⛔ PROHIBIDO
// importarlo desde el browser, desde `src/presentation/**` o desde cualquier módulo "use client".
//
// Exemplar: `supabase-kyc-verdicts.ts` (mismo repo). El patrón de ownership NO se inventa acá: se
// copia de ahí.
//
// 🔴 QUÉ GUARDA Y POR QUÉ ES SENSIBLE. `decision_token` es una CREDENCIAL BEARER: es lo único que
// autoriza a leer la decisión de una sesión de verificación en el agente. Misma clase de sensibilidad
// que `kyc_verdicts.verification_id`. NUNCA sale en una respuesta HTTP ni en un log (CD-20). Queda
// at-rest EN TEXTO PLANO, y se dice por qué: este repo no tiene KMS ni gestión de claves de datos, y
// agregar uno sería diseño nuevo dentro de una HU de migración. Residual DECLARADO, no ignorado.
//
// 🔴 EL TOKEN NO VENCE, NUNCA, Y ES A PROPÓSITO (CD-21). Es una decisión medida del OTRO repo
// (`wasiai-remittance-agents`, `src/auth/decision-token.ts`, bloque "POR QUÉ EL TOKEN NO VENCE"). La
// tabla NO tiene columna de vencimiento y NO la va a tener: un TTL del lado de Chaski sería un corte
// de desembolso a alguien YA verificado. Los únicos dos caminos que invalidan un token viven allá
// —rotar `KYC_DECISION_TOKEN_SECRET` o subir la versión `k1`→`k2`— y los dos son un CORTE, no un
// rollback: invalidan TODOS los tokens en vuelo, incluidos los de personas ya verificadas que
// todavía no cobraron, y NO HAY DÓNDE RE-EMITIRLOS.
// · Camino de fallo en el momento del pago, especificado: el agente contesta 401 ⇒
//   `resolvePayoutAuthority` NO autoriza (`kyc_reauth_failed`/502) ⇒ `prepare` responde
//   `payout_authority_unavailable`/502. La persona NO pierde plata; pierde el pago hasta
//   re-verificarse. ⛔ PROHIBIDO agregar un reintento con otra credencial, un respaldo, o un `?? true`.
//
// 🔴 EL GUARD REAL DE OWNERSHIP ES APP-LAYER (CD-19). El cliente usa el service key y BYPASSEA RLS,
// así que el `.eq("owner_address", canonicalizeAddress(...))` de `getForOwner` NO es una
// optimización: es lo único que impide que una dirección use la credencial de otra para autorizar un
// desembolso. La política RLS de la migración es defensa en profundidad ante un cliente con anon-key,
// no el guard.
//
// 🔴 Y `owner_address` NULLABLE NO DEBILITA ESE GUARD: LO REFUERZA. Un `.eq("owner_address", X)`
// NUNCA matchea un NULL ⇒ una sesión creada SIN prueba de posesión (P-4/AC-4) jamás puede autorizar
// un desembolso, por construcción de la query, sin que nadie tenga que acordarse de chequearlo. Es la
// misma dirección fail-closed que el corte por binding ausente del camino anterior.
import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalizeAddress } from "../address";
import { getSupabaseServerClient } from "./supabase-server";

const TABLE = "kyc_session_tokens";

/** `unique_violation`. Acá significa UNA cosa concreta: esa sesión YA tiene fila (el índice único es
 *  `uq_kyc_session_tokens_session` sobre `session_id`). Es un enum del motor, no un texto libre. */
const SQLSTATE_UNIQUE_VIOLATION = "23505";

/**
 * 🔴 El modo de falla NUEVO del hotfix 2026-08-20 · F-3, y NO es "no se pudo escribir": es "esta
 * sesión ya está atada a OTRA dirección, o llegó sin dirección probada sobre una fila ya atada".
 * Se arregla distinto (una es infra, la otra es un intento de usar la sesión de otra persona), así
 * que no puede compartir etiqueta — la misma doctrina que separó `probe_failed` de `write_failed`.
 *
 * ⛔ EL CALL SITE NO LO IMPORTA DE ACÁ, Y ES A PROPÓSITO: `app/api/kyc/session/route.ts` mockea este
 * módulo entero en sus tests, así que un import de esta constante llegaría `undefined` ahí y la
 * comparación `causa.errorCode === undefined` matchearía CUALQUIER error sin código — o sea que el
 * mock convertiría el discriminador en un comodín. La route lleva el literal, y lo que ata las dos
 * copias no es un candado textual sino un test que corre la route contra ESTE store de verdad
 * (`T-HF3-*` en `app/api/kyc/session/route.test.ts`): renombrar acá lo pone rojo allá.
 *
 * Su forma respeta el filtro de `causaDe` de la route (`^[a-z][a-z0-9_]{2,47}`, sin `:`), así que
 * sale al log como `errorCode` y sin `dbCode`.
 */
export const KYC_SESSION_OWNER_CONFLICT = "kyc_session_owner_conflict";

export class SupabaseKycSessionTokenStore {
  constructor(private readonly client: SupabaseClient) {}

  /**
   * MONEY-PATH. Devuelve el `decisionToken` de esta sesión **sólo si esta dirección es su dueña**.
   *
   * 🔴 CD-19: filtra por `session_id` **Y** `owner_address`. El `ownerAddress` es `string`, JAMÁS
   * `string | undefined`: con un opcional, un call site nuevo que lo omitiera COMPILARÍA, y el filtro
   * se caería sin que nada se ponga rojo. Eso es un IDOR sobre la credencial del desembolso.
   *
   * ⛔ Devuelve **el token y nada más**, nunca el row: un row entero invita a que el próximo lea de
   * ahí el `owner_address` "para chequearlo", que es el guard-que-se-mira-al-espejo.
   *
   * `canonicalizeAddress` es base58 CASE-SENSITIVE y tira ante lo malformado.
   * ⛔ PROHIBIDO `.toLowerCase()`: lowercasear abre una colisión entre dos direcciones distintas.
   */
  async getForOwner(sessionId: string, ownerAddress: string): Promise<string | null> {
    const owner = canonicalizeAddress(ownerAddress);
    const { data, error } = await this.client
      .from(TABLE)
      .select("decision_token")
      .eq("session_id", sessionId) // ← el id
      .eq("owner_address", owner) // ← EL GUARD (CD-19)
      .maybeSingle();
    // NUNCA se ecoa el mensaje del driver (puede traer el valor del filtro). Sólo el SQLSTATE, que es
    // un enum estable y sirve para diagnosticar (42P01 = la tabla no existe ⇒ falta la migración).
    if (error) throw new Error(`kyc_session_token_read_failed:${error.code ?? "unknown"}`);
    if (!data) return null;
    const token = (data as unknown as { decision_token?: unknown }).decision_token;
    return typeof token === "string" ? token : null;
  }

  /**
   * PANTALLA. **LA ÚNICA EXCEPCIÓN A CD-19, y su motivo va escrito ACÁ y no en `doc/`** (que no viaja
   * con el repo).
   *
   * El camino de pantalla (`app/api/kyc/decision/route.ts`) **NO TIENE dueño al que filtrar**: una
   * sesión creada sin prueba de posesión (P-4/AC-4) no tiene dirección probada, y exigir una acá
   * dejaría a esa persona sin poder leer su propio veredicto — que es exactamente el agujero que
   * costó un bloqueante cerrar en la HU anterior (la puerta de entrada al KYC no se cierra).
   *
   * Su guard equivalente es el HMAC `verifySessionToken(sessionId, x-kyc-token)`, que corre **ANTES**
   * de esta lectura y que es el mismo control que cerró el IDOR original (P-5/WKH-179 B1). Que corra
   * antes no es un detalle de orden: es todo el guard, y tiene su candado propio (T-TOK-5, que cuenta
   * llamadas al store y al `fetch`, no status).
   *
   * ⛔ PROHIBIDO llamarla desde `src/infrastructure/payout/**`. Ahí NO hay HMAC que la anteceda, así
   * que usarla sería la lectura sin filtro de dueño entrando al money-path: el IDOR.
   * Candado mecánico: G-5 en `src/composition/kyc-provider-residue.static.test.ts`.
   */
  async readForVerifiedSession(
    sessionId: string,
  ): Promise<{ token: string; ownerAddress: string | null } | null> {
    const { data, error } = await this.client
      .from(TABLE)
      .select("decision_token, owner_address")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (error) throw new Error(`kyc_session_token_read_failed:${error.code ?? "unknown"}`);
    if (!data) return null;
    const row = data as unknown as { decision_token?: unknown; owner_address?: unknown };
    if (typeof row.decision_token !== "string") return null;
    return {
      token: row.decision_token,
      ownerAddress: typeof row.owner_address === "string" ? row.owner_address : null,
    };
  }

  /**
   * PRE-VUELO DE LA ESCRITURA (hotfix 2026-08-20 · F-2). Corre **ANTES** de crear la sesión en el
   * agente, o sea antes de gastar cuota del proveedor.
   *
   * 🔴 POR QUÉ EXISTE, Y ES UN INCIDENTE MEDIDO, NO UNA PRECAUCIÓN. El 2026-08-20 a las 14:09:58 UTC
   * el agente contestó 200 —la sesión SE CREÓ en el proveedor y la cuota SE GASTÓ— y recién después
   * falló el `put` de acá abajo: `/api/kyc/session` devolvió 503 sin darle la URL a la persona.
   * Pagamos una verificación y no entregamos nada. El molde de la doctrina que esto aplica es el
   * docblock de `wasiai-remittance-agents/src/app/api/agents/remit-kyc-validator/session/route.ts`
   * ("si se resolvieran DESPUÉS, una misconfiguración NUESTRA dejaría una sesión creada en el partner
   * que nadie va a poder consultar: CUOTA GASTADA y un BINDING COLGADO").
   *
   * ⚠️ QUÉ PRUEBA Y QUÉ **NO** PRUEBA, y la distinción es el punto entero:
   *   SÍ  que la tabla existe, que el proyecto de Supabase es alcanzable, que la credencial sirve y
   *       que tenemos permiso de **LEER** (42P01/PGRST205 = falta la migración; PGRST301/401 = la
   *       credencial; PGRST106 = el esquema; un rechazo de transporte = la base no responde).
   *   NO  que podamos **ESCRIBIR**. Un `select` no ejercita el `insert`: quedan afuera un
   *       `NOT NULL`/`CHECK`/FK que sólo dispara al insertar, una columna que falta en el `insert`
   *       (PGRST204), y un GRANT que da SELECT y niega INSERT (42501).
   *       Esa clase de fallo **sigue ocurriendo después** de gastar la cuota, y su 503 se distingue
   *       del de acá por la etiqueta del log (`..._write_failed` vs `..._probe_failed`).
   *       ⚠️ ACÁ ESTABA LISTADO EL `23505` (`session_id` duplicado) Y EL HOTFIX F-3 LO SACÓ DE ESTA
   *       LISTA, porque dejó de ser un fallo: hoy significa "esa sesión ya tiene fila" y `put` la
   *       ATA o la rechaza por dueño. Lo que sí quedó, y es un modo de falla NUEVO que este
   *       pre-vuelo tampoco puede ver, es ese rechazo: `kyc_session_owner_conflict`, que sale por
   *       su propia etiqueta en el log de la route, también DESPUÉS de gastar la cuota.
   *   NO  nada sobre la ventana entre este `select` y el `insert`: la base puede caerse en el medio.
   *
   * ⛔ LA ALTERNATIVA QUE SE DESCARTÓ, con su motivo: un `insert` de prueba + `delete`. Ejercitaría
   * de verdad el permiso de escritura, y por eso se evaluó. Se descarta porque escribe basura en una
   * tabla del money-path: si el `delete` falla queda un residuo con un `decision_token` de mentira,
   * el `session_id` centinela colisiona consigo mismo (23505) en cada request, y el propio repo
   * prohíbe rellenar estas columnas con valores que no salieron de una prueba. Se prefiere cubrir
   * MENOS y no escribir nada.
   *
   * Devuelve `void` **a propósito**: `data` no sale de esta función, así que no hay ninguna fila que
   * un dueño equivocado pueda leer y CD-19 no tiene nada que decir acá. No es la lectura sin filtro
   * de dueño que vigila G-5 — ésa devuelve la credencial; ésta no devuelve nada.
   *
   * NUNCA se ecoa el `message` del driver (puede traer el valor de un filtro). Sólo el SQLSTATE,
   * igual que las dos lecturas de arriba y que `put`.
   *
   * ⛔ EL NOMBRE NO ES `probeWritable`, Y NO ES UN DETALLE: se llama `probeReachable` porque eso es
   * lo único que mide. Un nombre que prometiera escritura invitaría al próximo a leer su verde como
   * "el `put` va a andar", que es exactamente la afirmación que este método NO puede hacer.
   */
  async probeReachable(): Promise<void> {
    const { error } = await this.client.from(TABLE).select("session_id").limit(1);
    if (error) throw new Error(`kyc_session_token_probe_failed:${error.code ?? "unknown"}`);
  }

  /**
   * Escritura. `ownerAddress` `null` = sesión SIN ATAR (sin prueba de posesión), y se escribe `null`
   * de verdad: ⛔ PROHIBIDO rellenarlo con un centinela, con la dirección del body o con cualquier
   * valor que no haya salido de una prueba de posesión.
   *
   * ⚠️ NO ES BEST-EFFORT en su call site: si esto lanza, `/api/kyc/session` responde 503 y NO devuelve
   * la URL de verificación. La razón está escrita ahí.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * 🔴 YA NO ES UN `insert` PELADO, Y EL MOTIVO ES UN INCIDENTE MEDIDO (hotfix 2026-08-20 · F-3).
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * El 2026-08-20 a las 21:43:40 UTC, con el log de causa del hotfix anterior ya desplegado:
   *   `kyc_session_token_write_failed { atada: true, errorCode: 'kyc_session_token_write_failed',
   *    dbCode: '23505' }`
   * `23505` = `unique_violation`, y la única restricción única de la tabla es
   * `uq_kyc_session_tokens_session` sobre `session_id`
   * (`supabase/migrations/20260819T000000_add_kyc_session_tokens.sql:133`). Medido contra bdwv: 5
   * filas, los 5 `session_id` distintos ⇒ la fila que falló NUNCA ENTRÓ. Y la secuencia fue
   * 21:22:14 una sesión SIN ATAR que entró bien, y 21:43:40 la MISMA sesión del proveedor, ahora
   * CON prueba de posesión, contra un `insert` que sólo sabe crear ⇒ 503 y la persona sin poder
   * verificarse. El proveedor devuelve la sesión que ya estaba abierta; el `insert` no sabía atarla.
   *
   * 🔴 EL INVARIANTE QUE ESTA FUNCIÓN GARANTIZA, Y QUE ES TODO EL PUNTO. Esta fila es una
   * CREDENCIAL DEL MONEY-PATH: con su `decision_token` se lee el veredicto de KYC de una persona, y
   * ese veredicto gatea el desembolso. Un `upsert(..., { onConflict: "session_id" })` ingenuo
   * arreglaría el 503 y abriría un secuestro de identidad: la segunda llamada REESCRIBIRÍA el
   * `owner_address` de una sesión ya atada a otra persona. Las transiciones permitidas son
   * EXACTAMENTE éstas, y no hay una cuarta:
   *   · fila inexistente            ⇒ se crea (el `insert` de abajo), atada o sin atar.
   *   · `owner_address` NULL        ⇒ se PUEDE atar (NULL → una dirección). Es el caso del incidente.
   *   · ya atada a la MISMA         ⇒ idempotente: se refresca el token, no se toca el dueño.
   *   · ya atada a OTRA (o llega    ⇒ ⛔ FALLA CERRADO con `kyc_session_owner_conflict`. No se
   *     sin dirección probada)         reescribe, no se borra a NULL, no se devuelve URL.
   *
   * 🔴 CÓMO SE GARANTIZA — POR LA FORMA DE LA QUERY, NO POR UN CHEQUEO QUE ALGUIEN RECUERDE. Es la
   * misma dirección que CD-19: el filtro ES el guard. ⛔ PROHIBIDO reemplazar esto por
   * "leer la fila, comparar el dueño en JS y después escribir": eso es un TOCTOU sobre la credencial
   * del desembolso — entre la lectura y la escritura, otra request ata la fila y la segunda la pisa.
   * EL PATRÓN NO SE INVENTA ACÁ: es el mismo "escritura CAS, sin lectura previa, todo el estado que
   * importa viaja en el WHERE" que ya está en producción en este repo, en el store de al lado
   * (`put`, `supabase-kyc-verdicts.ts:107`), con su mismo `.select(…)` para contar filas afectadas y
   * su mismo `23505` leído como "la fila ya existe".
   * Acá cada intento es UNA sentencia `UPDATE ... WHERE`, que Postgres evalúa atómicamente, y el
   * `WHERE` es el que hace imposible la transición prohibida:
   *   1. ATAR: `UPDATE … WHERE session_id = $1 AND owner_address IS NULL` — sólo puede ganar contra
   *      una fila SIN dueño. Si alguien la ató en el medio, afecta 0 filas.
   *   2. MISMA: `UPDATE … WHERE session_id = $1 AND owner_address = $2` — y su payload NI SIQUIERA
   *      INCLUYE `owner_address`, así que este intento es estructuralmente incapaz de cambiar de
   *      dueño, no sólo improbable.
   *   3. Si ninguno afectó exactamente 1 fila ⇒ se lanza. Fail-closed por defecto.
   * ⛔ Y NO se arma ningún filtro por interpolación de strings (un `.or("owner_address.eq." + x)`):
   * `.eq`/`.is` serializan el valor por `URLSearchParams`, así que no hay ninguna superficie donde un
   * valor con un separador de PostgREST se convierta en otro filtro. Dos viajes en el caso raro
   * (repetición del MISMO dueño) es el precio, y se paga.
   *
   * ⚠️ QUÉ **NO** GARANTIZA ESTO, dicho acá y no descubierto por el próximo:
   *   · NO es la base la que lo impone. El cliente usa el service key (BYPASSRLS) ⇒ ninguna policy
   *     nos frena, y un `CHECK` no puede ver el `OLD`. El candado de base equivalente es el trigger
   *     de `supabase/migrations/20260820T000000_kyc_session_tokens_owner_binding_immutable.sql`,
   *     que **NO está aplicado** hasta que el founder lo aplique: hasta entonces, cualquier OTRO
   *     escritor (un script, un `psql` a mano, otro repo) puede reescribir el dueño y esta función
   *     no se entera. Este código es hoy la única línea de defensa.
   *   · NO impide que el proveedor le entregue la MISMA sesión a dos personas distintas. Si eso
   *     pasa, el desembolso sigue cerrado (el `owner_address` no se mueve ⇒ `getForOwner` de la
   *     segunda persona da `null`), pero la segunda llamada que FALLA acá es la que lo cierra: por
   *     eso el caso "llega sin dirección probada sobre una fila ya atada" también lanza, en vez de
   *     refrescar el token en silencio.
   *   · 23505 se trata como "la fila ya existe" porque `uq_kyc_session_tokens_session` es hoy la
   *     única restricción única con la que un `insert` de esta forma puede chocar (la PK es un
   *     `gen_random_uuid()`). Si mañana hubiera otra, el 23505 caería igual en los `UPDATE`s de
   *     abajo, que filtran por `session_id`: afectarían 0 filas ⇒ se lanza. Fail-closed también ahí.
   */
  async put(record: {
    sessionId: string;
    decisionToken: string;
    ownerAddress: string | null;
  }): Promise<void> {
    const owner = record.ownerAddress === null ? null : canonicalizeAddress(record.ownerAddress);
    const { error } = await this.client.from(TABLE).insert({
      session_id: record.sessionId,
      decision_token: record.decisionToken,
      owner_address: owner,
    });
    if (!error) return;
    // Cualquier fallo que NO sea "esa sesión ya está en la tabla" sigue siendo lo de siempre: se
    // lanza con su SQLSTATE y el call site responde 503. ⛔ NUNCA el `message` del driver.
    if (error.code !== SQLSTATE_UNIQUE_VIOLATION) {
      throw new Error(`kyc_session_token_write_failed:${error.code ?? "unknown"}`);
    }

    // El `decision_token` SÍ se refresca: la sesión repetida trae uno nuevo, y el viejo puede haber
    // dejado de servir. `updated_at` se escribe explícitamente porque su `default now()` sólo corre
    // en el INSERT: sin esta línea, una fila atada horas después seguiría diciendo que no se tocó.
    const patch = {
      decision_token: record.decisionToken,
      updated_at: new Date().toISOString(),
    };

    if (owner !== null) {
      // (1) ATAR. Único intento que escribe `owner_address`, y sólo puede ganarle a una fila SIN
      // dueño. Es el caso del incidente: la primera llamada la creó sin prueba de posesión.
      const atadas = await this.patchGuarded(
        record.sessionId,
        { ...patch, owner_address: owner },
        { kind: "null" },
      );
      if (atadas === 1) return;
      // 0 ⇒ la fila ya tiene dueño: se cae al intento (2), que exige que sea ESTE.
      // >1 ⇒ el índice único no está: se lanza sin intentar nada más.
      if (atadas !== 0) throw new Error(KYC_SESSION_OWNER_CONFLICT);
    }

    // (2) MISMA (o sigue sin atar). El payload NO lleva `owner_address` ⇒ este camino no puede
    // cambiar de dueño ni borrarlo a NULL. Con `owner === null` el filtro es `IS NULL`, así que una
    // llamada sin prueba de posesión JAMÁS toca una fila ya atada.
    const mismas = await this.patchGuarded(
      record.sessionId,
      patch,
      owner === null ? { kind: "null" } : { kind: "eq", value: owner },
    );
    if (mismas !== 1) throw new Error(KYC_SESSION_OWNER_CONFLICT);
  }

  /**
   * Un `UPDATE ... WHERE session_id = $1 AND <guard de dueño>` y **cuántas filas afectó**.
   *
   * El `.select("session_id")` no es cosmético: sin él supabase-js devuelve `data: null` en un PATCH
   * y no habría forma de distinguir "actualicé la fila" de "el WHERE no matcheó nada", que es
   * exactamente la diferencia entre atar y rechazar. Devuelve `session_id` —un valor que el caller
   * YA TIENE, porque es el que filtró— y ninguna columna más: ni el token, ni el dueño. Un `select`
   * de la fila entera acá sería la lectura sin filtro de dueño entrando por la puerta de atrás.
   *
   * ⚠️ Un `0` significa "ninguna fila cumple el guard", y eso incluye —además del conflicto de
   * dueño— el caso en que la fila desapareció entre el `insert` y este `UPDATE`. Hoy NADA borra
   * filas de esta tabla, así que se reporta como conflicto; si algún día algo las borra, esa causa
   * se va a leer mal y hay que separarla.
   */
  private async patchGuarded(
    sessionId: string,
    patch: Record<string, unknown>,
    guard: { kind: "null" } | { kind: "eq"; value: string },
  ): Promise<number> {
    const conSesion = this.client.from(TABLE).update(patch).eq("session_id", sessionId);
    const conDueno =
      guard.kind === "null"
        ? conSesion.is("owner_address", null)
        : conSesion.eq("owner_address", guard.value);
    const { data, error } = await conDueno.select("session_id");
    if (error) throw new Error(`kyc_session_token_write_failed:${error.code ?? "unknown"}`);
    return Array.isArray(data) ? data.length : 0;
  }
}

/**
 * Factory. `null` cuando el cliente Supabase es `null` (envs ausentes).
 *
 * ⛔ NO hay un flag propio, y es deliberado (D-1): el interruptor de esta HU es la PRESENCIA de
 * `KYC_AGENT_BASE_URL`. Dos perillas para una cosa es peor que una, y este repo ya tiene el
 * precedente escrito (`KYC_VERDICT_STORE_ENABLED` + el cliente Supabase: dos fuentes de `null` para
 * el mismo apagado, y el `.env.example` tuvo que explicarlo).
 *
 * 🔴 CONSECUENCIA DEL `null`, dicha: `/api/kyc/session` responde 503 y NO crea la sesión (la
 * escritura del token no es best-effort), y `resolvePayoutAuthority` devuelve
 * `kyc_authority_unavailable`/503 — misconfig NUESTRA, no una caída del agente.
 */
export function getKycSessionTokenStore(): SupabaseKycSessionTokenStore | null {
  const client = getSupabaseServerClient();
  if (!client) return null;
  return new SupabaseKycSessionTokenStore(client);
}
