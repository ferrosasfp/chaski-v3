// Cliente HTTP del agente de verificación de identidad (WKH-233/W1). SERVER-ONLY.
//
// ⛔ PROHIBIDO importar este módulo desde `src/presentation/**` ni desde cualquier módulo que llegue
// al bundle del cliente (CD-10). Lee `KYC_AGENT_INVOKE_SECRET` y habla con un host que el navegador
// no tiene por qué conocer. El adapter que SÍ vive del lado del navegador es `agent-kyc-gateway.ts`,
// y le habla a las rutas de ESTE repo, nunca al agente.
//
// 🔴 LOS LOGS SON VALUE-FREE POR CONTRATO (CD-15). Sólo salen: la etiqueta de la rama, el `name` del
// error y el status upstream. ⛔ NUNCA el `sessionId`, el `identityClaim`, el `decisionToken`, la URL
// del agente ni el body. El `sessionId` y el `identityClaim` viajan en el query string del agente, así
// que su access log ya los tiene (residual declarado del OTRO repo); ese es motivo de más para que el
// nuestro no los repita.
//
// ⚠️ EL BORDE NO SE CASTEA, SE ESTRECHA. Las respuestas entran como `unknown` y se validan campo por
// campo con `isRecord`. Un `as KycAgentDecisionOutput` haría que una clave faltante viajara como
// `undefined` hasta el gate del desembolso, donde `payoutAllowed === true` daría `false` por el
// motivo equivocado y nadie podría distinguir "el agente dijo que no" de "el agente no contestó eso".
// Exemplar: `src/infrastructure/a2a/gateway-client.ts`.
import type { KycAgentDecisionOutput, KycAgentSessionOutput } from "./agent-contract";
import { kycAgentUrl, resolveKycAgentBaseUrl } from "./agent-env";

/** El mismo techo que tenían los tres `fetch` que esta HU reemplaza. */
const TIMEOUT_MS = 10_000;

/** La cabecera de la credencial del `GET /decision`. ⛔ NO es `x-kyc-token` (CD-4): ése es el HMAC
 *  NUESTRO que ata la sesión al caller de la route de Chaski. Son secretos de repos distintos y
 *  reusar el nombre haría que un día alguien mandara uno donde va el otro. */
const DECISION_TOKEN_HEADER = "x-kyc-decision-token";

/**
 * 🔴 LA CABECERA DE INVOKE, FAIL-CLOSED (WKH-233 fix-pack · H-3).
 *
 * ⚠️ ACÁ HABÍA UN FAIL-OPEN, Y ERA UNA ASIMETRÍA CON LA ENV HERMANA, NO UNA DECISIÓN. Decía
 * `return secret ? {...} : {}` — sin secreto la cabecera no existe y la llamada sale igual. El host
 * de ese MISMO agente hace lo contrario en el mismo módulo: (`resolveKycAgentBaseUrl`, `./agent-env.ts:51`)
 * TIRA si su env falta, con este argumento escrito a mano: *"un servicio que no sabe a qué agente le
 * está preguntando por la identidad de una persona no pregunta"*. Ese argumento aplica TEXTUAL a la
 * credencial —un servicio que no puede acreditar quién es tampoco pregunta— y nadie lo transfirió.
 *
 * 🔴 LO QUE COSTÓ EL FAIL-OPEN, MEDIDO Y NO SUPUESTO: el agente encendió su `INVOKE_AUTH_SECRET` el
 * 2026-08-11 y desde entonces contesta **401 `credential_missing`**. Acá no se puso rojo NADA —ni el
 * build, ni un test, ni un log de arranque—: el único que lo veía era el usuario final, con un 502.
 * Ocho días. Un fail-open no falla: espera.
 *
 * ⛔ Y EL TEST QUE HABÍA BENDECÍA EL FAIL-OPEN. `T-CLI-4` afirmaba, verde, que sin el secreto *"la
 * cabecera NO EXISTE (byte-idéntico a hoy)"*. O sea que la suite no es que no cazó el bug: lo declaró
 * el comportamiento correcto. Su reemplazo es su inverso (`T-CLI-4'`).
 *
 * ⚠️ DÓNDE TIRA, Y ESTO ES LA PARTE QUE IMPORTA. Tira **dentro de la función que llama al agente**,
 * en el mismo punto del ciclo de vida que el host y ANTES de gastar el `fetch`. ⛔ NUNCA en
 * module-load: a nivel de módulo, `next build` evaluaría la env y voltearía rutas que no le hablan al
 * agente, y además rompería el orden de encendido (la env se siembra en el proveedor ANTES del
 * deploy). Lo mide `T-CLI-4'` importando el módulo con la env ausente y verificando que el import NO
 * tira.
 *
 * ⚠️ ORDEN DE ENCENDIDO, y el inverso rompe el KYC: 1º sembrar el secreto ACÁ, 2º recién después
 * setear `INVOKE_AUTH_SECRET` en el agente. Está escrito también en `.env.example`, que es lo único
 * que sobrevive a un `clone`.
 *
 * ⚠️ QUÉ ROMPE ESTO Y QUÉ NO. Los TRES consumidores envuelven la llamada en un `try/catch` y la
 * convierten en el 502 que ya devuelven cuando el agente contesta 401 ((`createAgentKycSession`, `../../../app/api/kyc/session/route.ts:375`),
 * (`readAgentKycDecision`, `../../../app/api/kyc/decision/route.ts:89`), (`readAgentKycDecision`, `../payout/authority.ts:180`) ⇒ `kyc_reauth_failed`). ⚠️ LAS TRES VAN ANCLADAS A PROPÓSITO (re-AR it3 · MNR-1): la de `session` decía `:253`, que es una línea MUDA (`//`). Nació correcta en `main` y la rompió esta misma rama al reescribir el párrafo sin re-derivar el número; una cita SUELTA no la mira ningún candado, y anclarla es lo que la mete adentro de `citas-ancladas.test.ts`.
 * ⛔ ACÁ DECÍA «⇒ el conjunto de errores observables NO cambia», Y ERA FALSO, MEDIDO (re-AR it2 ·
 * BLQ-MED-2): el `upstream` viaja en el BODY de `/api/kyc/session`, y sin la env pasaba de
 * `{error:"kyc_session_failed", upstream:401}` a `upstream:0`. El `401` era el ÚNICO dato que apuntaba
 * a la credencial, y este fail-closed lo borraba. **El status HTTP no cambia (502 en los tres); el body
 * y el log sí.**
 *
 * 🔴 Y PEOR QUE EL NÚMERO: LA ETIQUETA MENTÍA. Con `invokeAuthHeader()` evaluado DENTRO del `try` del
 * `fetch`, el throw de la credencial salía por el `catch` del transporte y el único rastro era
 * `session_transport_failed` — la MISMA etiqueta que un DNS caído, un timeout o un connection reset. Un
 * fail-closed que colapsa una misconfig NUESTRA en "transporte" reintroduce, con otro nombre, el daño
 * exacto que costó los ocho días: un diagnóstico que no distingue causas que se arreglan distinto.
 * ⇒ La credencial se resuelve **ANTES del `try`**, tira una `KycAgentConfigError` propia, y su log es
 * `<rama>_config_missing` **con el NOMBRE de la env** (nunca el valor). Las routes la mapean a
 * (`UPSTREAM_INVOKE_SECRET_UNSET`, `:104`) en vez de al `0` de "no hubo respuesta".
 * Lo mide `T-CLI-4''`: cero llamadas al doble de `fetch` + la etiqueta `config`, no `transport`.
 *
 * Un `.trim()` vacío cuenta como ausente: `Bearer ` pelado es
 * `credential_malformed` para el agente, que es peor que no salir.
 */
/** El nombre de la env. NO es un secreto —el secreto es su VALOR— y por eso puede ir al log: sin él,
 *  el operador lee "algo de configuración" y tiene que adivinar cuál. */
export const INVOKE_SECRET_ENV = "KYC_AGENT_INVOKE_SECRET";

/**
 * ⛔ UNA CLASE PROPIA Y NO UN `Error` PELADO, y no es estilo. Las routes tienen que poder distinguir
 * "no pudimos acreditarnos" de "el agente no contestó" SIN parsear el `message` —que es value-free a
 * propósito y no se puede ecoar—. Un `instanceof` es la única forma de que esa distinción sobreviva
 * hasta el body de la respuesta, que es donde el operador la lee.
 */
export class KycAgentConfigError extends Error {
  readonly env: string;
  constructor(env: string, message: string) {
    super(message);
    this.name = "KycAgentConfigError";
    this.env = env;
  }
}

/** El `upstream` de una misconfig NUESTRA. ⛔ NO es `0`: `0` significa "no hubo status upstream"
 *  —el agente no contestó— y colapsar las dos es exactamente lo que este fix-pack vino a deshacer.
 *  Es NEGATIVO para que no pueda chocar nunca con un status HTTP real ni con el `0` que ya existe. */
export const UPSTREAM_INVOKE_SECRET_UNSET = -1;

/**
 * ⛔ SE LLAMA **ANTES** DEL `try` DEL `fetch`, EN LAS DOS FUNCIONES. Adentro, su throw sale por el
 * `catch` del transporte y queda etiquetado `<rama>_transport_failed`, o sea con el diagnóstico de otra
 * causa (re-AR it2 · BLQ-MED-2). El `rama` viaja como argumento sólo para eso: para que el log diga de
 * qué llamada se trata sin heredar la etiqueta equivocada.
 */
function invokeAuthHeader(rama: "session" | "decision"): Record<string, string> {
  const secret = process.env[INVOKE_SECRET_ENV]?.trim();
  if (!secret) {
    // Value-free: NUNCA el valor, que es un secreto. Sólo el NOMBRE de la env y la acción.
    console.warn(`[kyc-agent] ${rama}_config_missing`, { env: INVOKE_SECRET_ENV });
    throw new KycAgentConfigError(
      INVOKE_SECRET_ENV,
      "kyc_agent_invoke_secret_unset: seteá KYC_AGENT_INVOKE_SECRET con la credencial de invoke del " +
        "agente de verificación de identidad. No se pregunta sin acreditarse: un servicio que no " +
        "puede decir quién es no pide la identidad de una persona.",
    );
  }
  return { authorization: `Bearer ${secret}` };
}

/** Resultado de un viaje al agente. El `upstream` existe para que las routes puedan seguir
 *  devolviendo el status del borde tal como lo devuelven hoy, sin ecoar nada del body. */
export type AgentKycCall<T> = { ok: true; output: T } | { ok: false; upstream: number };

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

/** Etiqueta de rama + status. NUNCA un valor. */
function warnUpstream(rama: string, upstream: number): void {
  console.warn(`[kyc-agent] ${rama}`, { upstream });
}

/** Etiqueta de rama + `err.name`. ⛔ NUNCA el `message`: puede traer la URL, que trae el sessionId. */
function warnError(rama: string, err: unknown): void {
  console.warn(`[kyc-agent] ${rama}`, {
    errorName: err instanceof Error ? err.name : "unknown",
  });
}

/**
 * `POST {base}/api/agents/<agente>/session`.
 *
 * ⛔ `identityRef` AUSENTE ⇒ LA CLAVE SE OMITE DEL BODY, nunca viaja `null` ni `undefined` explícito.
 * El schema del agente es `.strict()`: una clave desconocida —o una conocida con el tipo equivocado—
 * es un 400, no un descarte silencioso. Y omitirla es lo que materializa P-4/AC-4: sin prueba de
 * posesión la persona SE VERIFICA IGUAL, con la sesión SIN ATAR.
 *
 * ⛔ NO se manda `callbackUrl` (DT-11). El agente lo valida contra una allowlist de orígenes que
 * nace vacía (fail-closed), así que mandarlo sin esa env sería un 400 garantizado; y el retomar del
 * flujo de Chaski no depende del callback sino del pendiente en `localStorage`.
 */
export async function createAgentKycSessionDirect(input: {
  identityRef?: string;
}): Promise<AgentKycCall<KycAgentSessionOutput>> {
  const url = kycAgentUrl(resolveKycAgentBaseUrl(), "session");
  // `JSON.stringify` ya omite las claves `undefined`, pero el objeto se arma explícitamente para que
  // la omisión sea observable en el test y no un efecto colateral de la serialización.
  const body: Record<string, string> = {};
  if (input.identityRef !== undefined) body.identityRef = input.identityRef;

  const auth = invokeAuthHeader("session"); // ⛔ ANTES del `try`: adentro, su throw se etiquetaría como transporte
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    warnError("session_transport_failed", err);
    throw err;
  }
  if (!res.ok) {
    warnUpstream("session_rejected", res.status);
    return { ok: false, upstream: res.status };
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    warnError("session_bad_json", err);
    throw err;
  }
  if (!isRecord(raw)) throw new Error("kyc_agent_bad_response:session:root");
  return {
    ok: true,
    output: {
      sessionId: readString(raw, "sessionId", "session"),
      url: readString(raw, "url", "session"),
      decisionToken: readString(raw, "decisionToken", "session"),
      provenance: readString(raw, "provenance", "session"),
    },
  };
}

/**
 * `GET {base}/api/agents/<agente>/decision?sessionId=…[&identityClaim=…]`.
 *
 * 🔴 EL `decisionToken` VIAJA SÓLO EN LA CABECERA `x-kyc-decision-token` (CD-4). ⛔ Nunca en la URL,
 * nunca en el query, nunca en un log: el query string queda en el access log del hosting del agente,
 * y una credencial ahí es una credencial publicada.
 *
 * ⛔ `identityClaim` AUSENTE ⇒ LA CLAVE NO SE MANDA. El agente entonces OMITE `identityMatches`, que
 * es lo correcto: no se preguntó. Rellenarlo con cualquier valor que no venga de una prueba de
 * posesión reabre el binding falso que costó un bloqueante cerrar.
 */
export async function readAgentKycDecisionDirect(input: {
  sessionId: string;
  identityClaim?: string;
  decisionToken: string;
}): Promise<AgentKycCall<KycAgentDecisionOutput>> {
  const url = new URL(kycAgentUrl(resolveKycAgentBaseUrl(), "decision"));
  url.searchParams.set("sessionId", input.sessionId);
  if (input.identityClaim !== undefined) url.searchParams.set("identityClaim", input.identityClaim);

  const auth = invokeAuthHeader("decision"); // ⛔ ANTES del `try`, por lo mismo que en `session`
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { [DECISION_TOKEN_HEADER]: input.decisionToken, ...auth },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    warnError("decision_transport_failed", err);
    throw err;
  }
  if (!res.ok) {
    warnUpstream("decision_rejected", res.status);
    return { ok: false, upstream: res.status };
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    warnError("decision_bad_json", err);
    throw err;
  }
  if (!isRecord(raw)) throw new Error("kyc_agent_bad_response:decision:root");
  const reasons = raw.reasons;
  if (!Array.isArray(reasons) || reasons.some((r) => typeof r !== "string")) {
    throw new Error("kyc_agent_bad_response:decision:reasons");
  }
  // 🔴 REGLA NORMATIVA — CÓMO ENTRA UN CAMPO NUEVO DE `GET /decision` (HU 073 · W0, gate de la HU
  // hermana del agente). Esta wave NO cambia ningún comportamiento: congela el que ya existe.
  //
  // El discriminador que el agente va a agregar entra por el patrón de (`identityMatches`, `:302`):
  // OPCIONAL, y ausente se preserva AUSENTE. ⛔ NUNCA como un `readString`/`readBoolean` requerido de la
  // lista de acá abajo. El orden importa y está medido: si el agente lo agrega primero y después se le
  // hace ROLLBACK, un lector estricto convierte la respuesta en `kyc_agent_bad_response` ⇒ 502 en
  // (`readAgentKycDecision`, `../../../app/api/kyc/decision/route.ts:89`) ⇒ throw en
  // (`kyc_decision_failed`, `./agent-kyc-gateway.ts:73`) ⇒ el `catch` de
  // (`decision`, `../../application/use-cases/resume-kyc.ts:40`) devuelve `processing` para siempre ⇒
  // 20 s de spinner y la card del techo del resume PARA TODO EL MUNDO A LA VEZ. Un campo que el agente
  // agrega para informar mejor no puede ser el que corta el KYC entero.
  //
  // ⛔ Y jamás `?? false` sobre ese campo nuevo: ausente significa «no se preguntó», y `false` sería una
  // acusación sobre la persona. Es la misma regla que las tres líneas de abajo ya escriben para
  // `identityMatches`, repetida acá porque acá es donde se lee la respuesta.
  //
  // 🔒 La tolerancia está congelada por `T-073-TOL-1` (una clave DESCONOCIDA no tira y no se cuela) y su
  // control `T-073-TOL-2` (una clave CONOCIDA mal tipada SÍ tira), en `./agent-kyc-client.test.ts`.
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
  // 🔴 LA CLAVE SE PRESERVA AUSENTE (CD-3). ⛔ PROHIBIDO `identityMatches: raw.identityMatches ?? false`:
  // ausente significa "no se preguntó" y es un defecto NUESTRO; `false` afirmaría que la identidad NO
  // coincide, que es una acusación sobre la persona. Un tipo distinto tampoco se normaliza: tira.
  if ("identityMatches" in raw) {
    output.identityMatches = readBoolean(raw, "identityMatches", "decision");
  }
  return { ok: true, output };
}
