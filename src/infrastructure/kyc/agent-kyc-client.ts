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
 * 🔴 LA CABECERA DE INVOKE, Y POR QUÉ SE MANDA CONDICIONALMENTE.
 *
 * El guard del agente (`guardInvokeAuth`) lee `Authorization: Bearer <secreto>` y NACE APAGADO: sin
 * `INVOKE_AUTH_SECRET` seteada allá devuelve `null` SIEMPRE, o sea que hoy no exige nada. Si acá la
 * mandáramos siempre —aunque fuera vacía—, el día que el agente encienda su guard el valor no
 * coincidiría y TODAS las llamadas pasarían a 401 sin aviso; y si nunca la mandáramos, ese mismo día
 * se rompería igual. Por eso: presente ⇒ se manda; ausente ⇒ la cabecera NO EXISTE, byte-idéntico al
 * comportamiento de hoy.
 *
 * ⚠️ ORDEN DE ENCENDIDO, y el inverso rompe el KYC: 1º sembrar el secreto ACÁ, 2º recién después
 * setear `INVOKE_AUTH_SECRET` en el agente. Está escrito también en `.env.example`, que es lo único
 * que sobrevive a un `clone`.
 *
 * La env se lee DENTRO de la función, nunca a nivel de módulo: a nivel de módulo quedaría congelada
 * en el build y el paso 1 del orden de encendido no tendría efecto hasta un re-deploy.
 */
function invokeAuthHeader(): Record<string, string> {
  const secret = process.env.KYC_AGENT_INVOKE_SECRET?.trim();
  return secret ? { authorization: `Bearer ${secret}` } : {};
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
export async function createAgentKycSession(input: {
  identityRef?: string;
}): Promise<AgentKycCall<KycAgentSessionOutput>> {
  const url = kycAgentUrl(resolveKycAgentBaseUrl(), "session");
  // `JSON.stringify` ya omite las claves `undefined`, pero el objeto se arma explícitamente para que
  // la omisión sea observable en el test y no un efecto colateral de la serialización.
  const body: Record<string, string> = {};
  if (input.identityRef !== undefined) body.identityRef = input.identityRef;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...invokeAuthHeader() },
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
export async function readAgentKycDecision(input: {
  sessionId: string;
  identityClaim?: string;
  decisionToken: string;
}): Promise<AgentKycCall<KycAgentDecisionOutput>> {
  const url = new URL(kycAgentUrl(resolveKycAgentBaseUrl(), "decision"));
  url.searchParams.set("sessionId", input.sessionId);
  if (input.identityClaim !== undefined) url.searchParams.set("identityClaim", input.identityClaim);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { [DECISION_TOKEN_HEADER]: input.decisionToken, ...invokeAuthHeader() },
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
