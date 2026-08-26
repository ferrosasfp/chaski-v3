// Cliente del agente de verificación de identidad POR EL COORDINADOR (WKH-366 / W3). SERVER-ONLY.
//
// Es el hermano de `agent-kyc-client.ts`: MISMAS DOS FIRMAS, MISMO tipo de resultado, MISMOS códigos
// de estrechado. Lo único que cambia es la capa más baja del stack —el `fetch` físico—: en vez de
// hablarle al host del agente, manda un `POST /compose` de UN step al gateway wasiai-a2a, que cobra,
// resuelve e invoca. Ningún control del borde vive acá: el rate-limit, la key no forjable del
// limiter, el binding a la dirección PROBADA, la credencial de `/decision` y el 401 byte-idéntico
// siguen todos en las rutas, aguas arriba (P-1..P-7 del Story File de WKH-366).
//
// ⛔ PROHIBIDO importarlo desde `src/presentation/**`, desde `container.ts` ni desde nada que llegue
// al bundle del navegador (CD-20). Maneja el `decisionToken`, que es una credencial bearer que NO
// vence: no puede salir de este servidor.
//
// ⚠️ EL BORDE NO SE CASTEA, SE ESTRECHA (CD-19). La respuesta entra como `unknown` y se valida campo
// por campo con los MISMOS lectores y los MISMOS códigos `kyc_agent_bad_response:<rama>:<campo>` que
// el transporte directo, de modo que **los dos transportes fallan igual**. Un
// `as KycAgentDecisionOutput` haría que una clave faltante viajara como `undefined` hasta el gate del
// desembolso, donde `payoutAllowed === true` daría `false` por el motivo equivocado.
//
// 🔴 LOS LECTORES ESTÁN DUPLICADOS, Y SE DICE EN VEZ DE DISIMULARLO. `readString`/`readBoolean`/
// `readRiskLevel` son privados del cliente directo y esta HU tiene prohibido tocar sus cuerpos
// (los dos transportes tienen que quedar comparables byte a byte hasta que W6 borre uno). El costo
// es real: si alguien cambia un código de error de un lado y no del otro, los dos transportes dejan
// de fallar igual y nada se pone rojo. Lo que lo acota hoy son los tests de estrechado de ESTE
// archivo, escritos contra los mismos códigos. El día que W6 borre el transporte directo, esta copia
// queda como la única y el problema desaparece con él.
import { runViaGateway } from "../a2a/gateway-client";
import type { KycAgentDecisionOutput, KycAgentSessionOutput } from "./agent-contract";
import { resolveKycAgentBaseUrl } from "./agent-env";
import type { AgentKycCall } from "./agent-kyc-client";
import { sameOrigin } from "./agent-origin";

/**
 * Los DOS slugs pineados (N1 de AC-6/CD-1). ⛔ NUNCA se pide la capacidad: el ranking del gateway
 * ordena por `verified`, que el candidato AUTO-REPORTA, así que delegar la elección cambiaría quién
 * contesta `payoutAllowed`. El Coordinador además rechaza esas dos capacidades con 400 pre-débito.
 *
 * Cada uno aparece EXACTAMENTE UNA VEZ en producción, y su candado es
 * `src/composition/kyc-gateway-slug-count.static.test.ts` (T-KGS-1 / T-KGS-2).
 */
const KYC_SESSION_SLUG = "remit-kyc-session";
const KYC_DECISION_SLUG = "remit-kyc-decision";

/**
 * El catálogo del que TIENE que salir el ejecutor. Es el identificador de las filas propias del
 * Coordinador (`SELF_PUBLISHED_REGISTRY_ID` en `wasiai-a2a/src/types/index.ts`).
 *
 * ⛔⛔ ESTE VALOR **NO ES UN GUARD DE SEGURIDAD**, Y ACÁ ESTÁ LA MEDICIÓN QUE LO DICE ⛔⛔
 *
 * El docblock anterior afirmaba que el par `(slug, registry)` *"no es forjable desde el card de un
 * candidato federado"*. **Era falso**, y el AR de WKH-366 lo midió por dos caminos, los dos con una
 * sola llamada HTTP y sin permisos especiales:
 *
 *   (a) `POST /agents` del Coordinador es **auth-only** (`wasiai-a2a/src/routes/agents.ts`), y el
 *       `slug` de `a2a_agents` es **PK global, primero-que-llega, sin scoping por owner**
 *       (`src/services/agent.ts`: el slug se deriva del `name`, y el pre-check de colisión es
 *       "cualquier owner"). Quien publique primero un agente llamado `Remit Kyc Decision` se queda
 *       con el slug — y su fila nace con `registry: "self-published"` HARDCODEADO, o sea que
 *       apropiarse del slug REGALA el registry. El par completo, de una.
 *   (b) `self-published` no existe como fila en `registries`, y `POST /registries` no tenía
 *       blocklist de nombres ⇒ el id estaba libre para cualquiera. (El fix-pack lo reserva del lado
 *       del Coordinador, pero eso es defensa en profundidad: no arregla (a).)
 *
 * Y el propio Coordinador ya lo tenía escrito, para otra cosa, en `services/compose.ts`: *"el
 * `registry_id` NO es un guard de seguridad… cualquier caller autenticado puede `POST /registries`
 * con ese nombre"*. WKH-366 convirtió esa advertencia, sin querer, en el guard del desembolso.
 *
 * ⇒ **La comparación que sostiene N3 es la del ORIGEN** (`expectedAgentBaseUrl`, abajo). Ésta se
 * conserva como cinturón, y lo que aporta es acotado y vale la pena decirlo con precisión: detecta
 * la DEGRADACIÓN silenciosa de `discoveryService.getAgent`, que ante un fallo del SELECT local cae
 * al fanout federado sin que nada se ponga rojo. Ese caso no necesita atacante —alcanza un hipo de
 * la base en el momento del desembolso— y ahí un card federado con otro `registry` cae acá.
 * ⛔ PROHIBIDO volver a escribir que esto es "no forjable".
 */
const EXPECTED_REGISTRY = "self-published";

/**
 * 🔴 EL HOST QUE NINGÚN PUBLICADOR PUEDE ELEGIR — la mitad de N3 que de verdad sostiene AC-6.
 *
 * Sale de `KYC_AGENT_BASE_URL`, que vive en una **env del deploy**, no en el catálogo. Es la MISMA
 * fábrica que usan los tres preflights del rollback D-1 y el transporte directo (⛔ prohibido un
 * segundo `process.env.KYC_AGENT_BASE_URL` acá: la regla 2 de `agent-env.ts` es que haya una sola
 * fuente, garantizada por el brand nominal).
 *
 * ⛔ FAIL-CLOSED: la env ausente/ilegible NO se propaga como excepción, devuelve `null`, y `null`
 * **no autoriza** — `sameOrigin(x, null)` es `false` por construcción. Se resuelve LAZY, dentro de la
 * llamada, por el mismo motivo que en `agent-env.ts`: a nivel de módulo, `next build` congelaría el
 * valor y el rollback dejaría de ser "borrar la env".
 *
 * ⚠️ En la práctica no puede ser `null` cuando esto corre: los tres call sites resuelven la MISMA env
 * antes (las dos rutas y `payout/authority.ts`, cada uno con su desenlace propio — 501 y 503). El
 * `catch` es cinturón, no el camino esperado.
 */
function expectedAgentBaseUrl(): string | null {
  try {
    return resolveKycAgentBaseUrl();
  } catch {
    return null;
  }
}

// ── Los tres sentinelas de `upstream` ─────────────────────────────────────────────────────────────
//
// 🔴 SON NEGATIVOS A PROPÓSITO: así no pueden chocar NUNCA con un status HTTP real, ni con el `0`
// ("no hubo status upstream"), ni con el `-1` de `UPSTREAM_INVOKE_SECRET_UNSET` del cliente directo.
//
// ⚠️ Y ESTO **SÍ** CAMBIA EL CONJUNTO OBSERVABLE, dicho en voz alta —igual que se dijo cuando entró
// el `-1`—: bajo `KYC_TRANSPORT=gateway`, el body de `/api/kyc/session` y de `/api/kyc/decision`
// puede traer `upstream: -2 | -3 | -4` donde antes traía un status del agente. **El STATUS HTTP no
// cambia** (502 en los tres), y `resolvePayoutAuthority` no mira `upstream` en ninguna línea: su
// rama `!r.ok` es `kyc_reauth_failed`/502 sin discriminar, así que el conjunto observable de
// `prepare` queda igual. Lo que cambia es el body de las dos rutas, y es información que ganamos:
// sin estos tres, una suplantación y un timeout saldrían con el mismo número.

/** El gateway devolvió un `{ok:false}` de CUALQUIER código, incluida la config ausente. */
export const UPSTREAM_GATEWAY_FAILURE = -2;
/**
 * 200, pero el ejecutor no es nuestro agente. N3 de AC-6, y son DOS causas bajo el mismo número:
 * el par `(slug, registry)` no coincide, **o** —la que importa— el ORIGEN de su `invokeUrl` no es el
 * de `KYC_AGENT_BASE_URL`. Se separan en el log (`…_agent_mismatch` vs `…_agent_origin_mismatch`),
 * no en el body: ver el comentario del paso 2b en `invocarPineado`.
 */
export const UPSTREAM_GATEWAY_AGENT_MISMATCH = -3;
/** 200, pero el gateway reportó que un BRIDGE corrió sobre el step. CD-2. */
export const UPSTREAM_GATEWAY_BRIDGE_PRESENT = -4;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readString(row: Record<string, unknown>, key: string, rama: string): string {
  const v = row[key];
  // Una clave faltante TIRA. No devuelve "" ni `undefined`: ver la cabecera.
  if (typeof v !== "string") throw new Error(`kyc_agent_bad_response:${rama}:${key}`);
  return v;
}

function readBoolean(row: Record<string, unknown>, key: string, rama: string): boolean {
  const v = row[key];
  if (typeof v !== "boolean") throw new Error(`kyc_agent_bad_response:${rama}:${key}`);
  return v;
}

function readRiskLevel(row: Record<string, unknown>): "low" | "medium" | "high" {
  const v = row.riskLevel;
  if (v === "low" || v === "medium" || v === "high") return v;
  throw new Error("kyc_agent_bad_response:decision:riskLevel");
}

/** Etiqueta de rama + el sentinela. ⛔ NUNCA el input, ni el slug del impostor, ni el token. */
function warnGateway(rama: string, upstream: number): void {
  console.warn(`[kyc-gateway] ${rama}`, { upstream });
}

/**
 * El viaje, con la escalera de fallo. 🔴 EL DEFAULT ES FALLO (CD-15): se devuelve el output crudo
 * SÓLO cuando las tres condiciones positivas se cumplen, y cualquier otra cosa es un rechazo.
 *
 * ⛔ PROHIBIDO escribir esto como un `switch` sobre códigos conocidos con un `default: ok`. El status
 * HTTP real del agente **se pierde** al pasar por `/compose` —del otro lado sólo sobrevive la clase
 * binaria `agentFailure` (`INPUT_REJECTED` / `AGENT_ERROR`)—, así que enumerar los casos conocidos es
 * estructuralmente imposible de hacer bien: siempre habría una respuesta nueva cayendo al default.
 *
 * ⛔ EXACTAMENTE UN STEP POR LLAMADA, y eso además cierra CD-2 por estructura: el bridge del
 * Coordinador corre sólo dentro de `if (i < steps.length - 1)`, o sea que un pipeline de un step
 * nunca entra al bloque. El chequeo de `bridged` es el cinturón sobre ese tirante.
 *
 * 🔴 Y ESE «UN SOLO STEP» SOSTIENE UNA SEGUNDA COSA, QUE NO ES CD-2 (AR/MNR-1). Es lo único que hoy
 * mantiene el `decisionToken` FUERA del retry adaptativo con LLM del Coordinador. La cadena, medida:
 * ante un 4xx con `fieldErrors`, `wasiai-a2a/src/services/compose.ts` (el bloque de `willRetry`) le
 * manda **el input completo del step** a un modelo para que lo regenere; el 400 del endpoint nuevo
 * usa `parsed.error.flatten()`, que emite exactamente `fieldErrors`, así que el parser del
 * Coordinador MATCHEA. Lo único que lo vuelve inalcanzable es aritmética de índices: ese camino exige
 * `stepDebitedUsd > 0` y el débito per-step está gateado en `if (i > 0 …)` ⇒ con un solo step, el
 * nuestro es SIEMPRE el índice 0 y nunca hay débito per-step. El día que un step de KYC deje de ser
 * el índice 0 —fusionar cotización + KYC en un `/compose`, meter un paso previo, cualquier cosa— la
 * credencial de desembolso de una persona real le llega a un LLM de terceros.
 *
 * ⛔ ESTA HU **NO CAMBIA** ESE COMPORTAMIENTO, y la nota no es una advertencia decorativa: es el
 * pre-requisito que hay que leer antes de agregarle un segundo step a esta función. La mitigación de
 * fondo (excluir las capacidades de autorización del camino `willRetry`, del lado del Coordinador)
 * está fuera del alcance de este fix-pack.
 */
async function invocarPineado(
  slug: string,
  input: Record<string, unknown>,
  rama: "session" | "decision",
): Promise<{ ok: true; raw: Record<string, unknown> } | { ok: false; upstream: number }> {
  const r = await runViaGateway({ steps: [{ agent: slug, input }] });

  // 1 — cualquier `{ok:false}`: red, timeout, 402, 403, 422, `step_failed`, `not_configured`…
  //     No se ramifica por código: todos son "no hay veredicto".
  if (!r.ok) {
    warnGateway(`${rama}_gateway_failed`, UPSTREAM_GATEWAY_FAILURE);
    return { ok: false, upstream: UPSTREAM_GATEWAY_FAILURE };
  }

  // 2 — N3, PARTE A: el par (slug, registry). `null` (el gateway no lo dijo de forma legible) es un
  //     rechazo: no se puede autorizar un desembolso con un veredicto de autor desconocido.
  //     ⚠️ ESTO SOLO NO ALCANZA — los dos campos los elige el publicador (ver `EXPECTED_REGISTRY`).
  //     Lo que aporta está acotado y escrito allá; el guard que sostiene N3 es el de la PARTE B.
  const ref = r.agents[0] ?? null;
  if (ref === null || ref.slug !== slug || ref.registry !== EXPECTED_REGISTRY) {
    warnGateway(`${rama}_gateway_agent_mismatch`, UPSTREAM_GATEWAY_AGENT_MISMATCH);
    return { ok: false, upstream: UPSTREAM_GATEWAY_AGENT_MISMATCH };
  }

  // 2b — N3, PARTE B 🔴 EL GUARD REAL: ¿a QUIÉN le habló el Coordinador? Se cruza el ORIGEN de la
  //      `invokeUrl` del ejecutor contra el del deploy. Es la única comparación de N3 cuyo lado
  //      derecho NO sale del catálogo: sale de una env que ningún publicador puede tocar.
  //
  //      ⛔ FAIL-CLOSED POR LOS DOS LADOS, Y SIN UNA RAMA PROPIA PARA CADA UNO: `sameOrigin` ya
  //      devuelve `false` si CUALQUIERA de los dos lados no tiene origen afirmable (env ausente,
  //      `invokeUrl` ausente, texto que no parsea, esquema exótico). Escribir acá un
  //      `if (base === null)` aparte habría sido una rama que ningún test puede distinguir de la
  //      otra: el desenlace es el mismo y la condición es redundante.
  //
  //      ⚠️ EL DATO SALE DE `r.invokeUrls[0]`, NO DE `ref.invokeUrl`, y ese renglón tiene su
  //      historia: primero se agregó `invokeUrl` adentro de `GatewayAgentRef`, y como las dos rutas
  //      de `/api/a2a/quote` y `/api/payout/prepare` ecoan ese objeto ENTERO al browser, empezó a
  //      filtrarse la URL interna del agente al navegador. Lo cazó el gate. Vive en un arreglo
  //      PARALELO justamente para que no pueda volver a pasar.
  //
  //      🔴 LA COMPARACIÓN NO SE ESCRIBE ACÁ, SE LLAMA — y eso NO es estética. Se midió: con la
  //      comparación inline (`originOf(r.invokeUrls[0]) !== esperado`), el mutante que rompe
  //      `sameOrigin` mataba `agent-origin.test.ts` y **dejaba VERDE el test del desembolso**, o sea
  //      que la función que el test puro vigila no era la que decidía la plata. Ahora los dos
  //      consumidores —éste y la sonda de W4— pasan por la MISMA función, y el mutante mata a los dos.
  //
  //      🔴 SENTINELA COMPARTIDO CON LA PARTE A, Y ES DELIBERADO: las dos son la misma clase ("el
  //      ejecutor no es nuestro agente") y el conjunto observable de `/api/kyc/*` no se amplía otra
  //      vez. Lo que SÍ discrimina es la ETIQUETA del log, que es donde ops necesita separarlas: un
  //      `agent_mismatch` manda a mirar el catálogo; un `agent_origin_mismatch` es un incidente de
  //      suplantación. ⛔ La etiqueta no lleva el origen observado: ese string lo controla un tercero.
  if (!sameOrigin(r.invokeUrls[0], expectedAgentBaseUrl())) {
    warnGateway(`${rama}_gateway_agent_origin_mismatch`, UPSTREAM_GATEWAY_AGENT_MISMATCH);
    return { ok: false, upstream: UPSTREAM_GATEWAY_AGENT_MISMATCH };
  }

  // 3 — CD-2: si el gateway reportó un bridge sobre este step, el veredicto pudo pasar por un modelo.
  //     `!== false` y no `=== true`: un `undefined` (arreglo más corto de lo esperado) también cae.
  if (r.bridged[0] !== false) {
    warnGateway(`${rama}_gateway_bridged`, UPSTREAM_GATEWAY_BRIDGE_PRESENT);
    return { ok: false, upstream: UPSTREAM_GATEWAY_BRIDGE_PRESENT };
  }

  // 4 — la raíz del output. Mismo código que el directo.
  const raw = r.outputs[0];
  if (!isRecord(raw)) throw new Error(`kyc_agent_bad_response:${rama}:root`);
  return { ok: true, raw };
}

/**
 * `POST /compose` con UN step pineado a la creación de la sesión hosted-redirect.
 *
 * ⛔ `identityRef` AUSENTE ⇒ LA CLAVE SE OMITE DEL INPUT, nunca viaja `null` ni `undefined` explícito
 * (P-4/AC-4, la MISMA regla que el transporte directo). El schema del agente es `.strict()`: una
 * clave desconocida —o una conocida con el tipo equivocado— es un 400, no un descarte silencioso. Y
 * omitirla es lo que materializa "sin prueba de posesión la persona SE VERIFICA IGUAL, con la sesión
 * SIN ATAR".
 *
 * ⛔ NO se manda `callbackUrl`: el `inputSchema` publicado del step de sesión ni siquiera lo declara.
 */
export async function createAgentKycSessionViaGateway(input: {
  identityRef?: string;
}): Promise<AgentKycCall<KycAgentSessionOutput>> {
  // El objeto se arma explícitamente (y no apoyándose en que `JSON.stringify` borra los `undefined`)
  // para que la omisión sea OBSERVABLE en el test y no un efecto colateral de la serialización.
  const body: Record<string, unknown> = {};
  if (input.identityRef !== undefined) body.identityRef = input.identityRef;

  const r = await invocarPineado(KYC_SESSION_SLUG, body, "session");
  if (!r.ok) return { ok: false, upstream: r.upstream };
  return {
    ok: true,
    output: {
      sessionId: readString(r.raw, "sessionId", "session"),
      url: readString(r.raw, "url", "session"),
      decisionToken: readString(r.raw, "decisionToken", "session"),
      provenance: readString(r.raw, "provenance", "session"),
    },
  };
}

/**
 * `POST /compose` con UN step pineado a la lectura del veredicto.
 *
 * 🔴 LOS TRES DATOS VIAJAN EN EL INPUT DEL STEP, Y ES OBLIGADO: el Coordinador NO propaga cabeceras
 * hacia el agente (sólo emite las suyas), así que el `decisionToken` no puede ir donde va en el
 * transporte directo. Es superficie nueva y está declarada como tal (R-2 del Story File): el
 * `/compose` no persiste ni loguea los inputs de step, pero la credencial pasa por un servicio más.
 *
 * ⛔ `identityClaim` AUSENTE ⇒ LA CLAVE NO SE MANDA. El agente entonces OMITE `identityMatches`, que
 * es lo correcto: no se preguntó.
 */
export async function readAgentKycDecisionViaGateway(input: {
  sessionId: string;
  identityClaim?: string;
  decisionToken: string;
}): Promise<AgentKycCall<KycAgentDecisionOutput>> {
  const body: Record<string, unknown> = {
    sessionId: input.sessionId,
    decisionToken: input.decisionToken,
  };
  if (input.identityClaim !== undefined) body.identityClaim = input.identityClaim;

  const r = await invocarPineado(KYC_DECISION_SLUG, body, "decision");
  if (!r.ok) return { ok: false, upstream: r.upstream };

  const raw = r.raw;
  const reasons = raw.reasons;
  if (!Array.isArray(reasons) || reasons.some((x) => typeof x !== "string")) {
    throw new Error("kyc_agent_bad_response:decision:reasons");
  }
  // 🔒 LA TOLERANCIA SE REPLICA IGUAL QUE EL RESTO. Una clave DESCONOCIDA no tira y no se cuela (el
  // campo `lifecycle` del agente es exactamente ese caso, y el transporte directo tampoco lo lee).
  // Si este lector fuera estricto, un campo que el agente agrega y después revierte cortaría el KYC
  // entero: 502 ⇒ throw en el gateway de pantalla ⇒ `processing` para siempre.
  const output: KycAgentDecisionOutput = {
    terminal: readBoolean(raw, "terminal", "decision"),
    status: readString(raw, "status", "decision"),
    approved: readBoolean(raw, "approved", "decision"),
    riskLevel: readRiskLevel(raw),
    verificationId: readString(raw, "verificationId", "decision"),
    provenance: readString(raw, "provenance", "decision"),
    payoutAllowed: readBoolean(raw, "payoutAllowed", "decision"),
    reasons: reasons as string[],
  };
  // 🔴 LA CLAVE SE PRESERVA AUSENTE (CD-3). ⛔ PROHIBIDO `?? false`: ausente significa "no se
  // preguntó" y es un defecto NUESTRO; `false` afirmaría que la identidad NO coincide, que es una
  // acusación sobre la persona. Un tipo distinto tampoco se normaliza: tira.
  if ("identityMatches" in raw) {
    output.identityMatches = readBoolean(raw, "identityMatches", "decision");
  }
  return { ok: true, output };
}
