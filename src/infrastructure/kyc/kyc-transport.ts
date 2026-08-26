// Despachador del transporte de KYC (WKH-366 / W3). SERVER-ONLY.
//
// Exporta las MISMAS DOS FIRMAS que el cliente directo: los 3 call sites cambian sólo de DÓNDE
// importan, y ninguno cambia de forma (AC-11). Ésa es toda la ambición de este archivo.
//
// 🔴 POR QUÉ UN DESPACHADOR Y NO UN `if` ADENTRO DEL CLIENTE ACTUAL (DT-12). En el paso 7 (la HU de
// seguimiento) se BORRA UN ARCHIVO ENTERO —`agent-kyc-client.ts`— y este módulo pasa a re-exportar
// sólo el camino por gateway. Con un `if` adentro del cliente habría que desenredar dos caminos
// entrelazados en el mismo cuerpo, que es como se cuelan los cambios de comportamiento en un borrado.
//
// ⚠️ LO QUE ESTE ARCHIVO NO APAGA, y es lo que más se olvida (G-5 del Story File): la bandera NO
// reemplaza a `KYC_AGENT_BASE_URL`. Los TRES preflights que la resuelven viven FUERA del transporte
// —en las dos rutas y en la autoridad de payout— y son el interruptor de rollback D-1 de WKH-233.
// Quitar esa env apaga el KYC entero, sea cual sea el valor de `KYC_TRANSPORT`.
import type { KycAgentDecisionOutput, KycAgentSessionOutput } from "./agent-contract";
import type { AgentKycCall } from "./agent-kyc-client";
import {
  createAgentKycSessionDirect,
  readAgentKycDecisionDirect,
} from "./agent-kyc-client";
import {
  createAgentKycSessionViaGateway,
  readAgentKycDecisionViaGateway,
} from "./gateway-kyc-client";

// Re-export de lo que los call sites importan HOY del cliente directo. Sin esto, los 3 call sites
// cambiarían MÁS que el especificador del import y AC-11 dejaría de ser cierto.
export type { AgentKycCall } from "./agent-kyc-client";
export { KycAgentConfigError, UPSTREAM_INVOKE_SECRET_UNSET } from "./agent-kyc-client";
export {
  UPSTREAM_GATEWAY_AGENT_MISMATCH,
  UPSTREAM_GATEWAY_BRIDGE_PRESENT,
  UPSTREAM_GATEWAY_FAILURE,
} from "./gateway-kyc-client";

/** Los dos transportes. Conjunto CERRADO. */
export type KycTransport = "direct" | "gateway";

/**
 * ⛔ FAIL-SAFE: cualquier valor que NO sea exactamente `"gateway"` (tras `.trim()`) resuelve a
 * `"direct"`. Un typo NO enciende el camino nuevo.
 *
 * ⛔ NADA de `toLowerCase()`, nada de truthiness: `"GATEWAY"`, `"1"`, `"true"`, `"gateway "` (que
 * tras el trim SÍ enciende) y `""` tienen cada uno un desenlace que T-C3 escribe fila por fila. El
 * `.trim()` va ANTES de la comparación, igual que en `invokeAuthHeader` y en `resolveKycAgentBaseUrl`.
 *
 * ⚠️ Se lee LAZY, dentro de la llamada. A nivel de módulo, `next build` congelaría el valor del
 * momento del build y el rollback dejaría de ser "borrar la env sin redeploy".
 */
export function readKycTransport(): KycTransport {
  return process.env.KYC_TRANSPORT?.trim() === "gateway" ? "gateway" : "direct";
}

/** Misma firma y mismo tipo de resultado que las dos implementaciones. */
export async function createAgentKycSession(input: {
  identityRef?: string;
}): Promise<AgentKycCall<KycAgentSessionOutput>> {
  return readKycTransport() === "gateway"
    ? createAgentKycSessionViaGateway(input)
    : createAgentKycSessionDirect(input);
}

/** Ídem. El `decisionToken` no se toca acá: viaja tal cual al transporte que corresponda. */
export async function readAgentKycDecision(input: {
  sessionId: string;
  identityClaim?: string;
  decisionToken: string;
}): Promise<AgentKycCall<KycAgentDecisionOutput>> {
  return readKycTransport() === "gateway"
    ? readAgentKycDecisionViaGateway(input)
    : readAgentKycDecisionDirect(input);
}
