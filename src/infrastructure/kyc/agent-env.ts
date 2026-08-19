// Base URL del agente de verificación de identidad — ÚNICA fuente de verdad del repo (WKH-233/CD-2).
//
// Exemplar: la regla 2 del módulo que este reemplaza (`src/infrastructure/didit/didit-env.ts`, que
// esta HU borra). Las dos reglas que se conservan, y son las que importan:
//
//  1. FAIL-CLOSED, SIN DEFAULT. Sin `KYC_AGENT_BASE_URL` no se resuelve ningún host y esto TIRA.
//     ⛔ PROHIBIDO agregar un `?? "https://…"`: un default (cualquiera, incluso el seguro) es
//     exactamente el defecto que el módulo anterior existía para cerrar — N lugares creyendo cosas
//     distintas, y el que se olvida termina hablándole al deploy equivocado.
//
//  2. UNA SOLA FUENTE, GARANTIZADA POR EL COMPILADOR. `KycAgentBaseUrl` es un brand NOMINAL: es
//     asignable a `string`, pero un `string` NO es asignable a él. Sólo esta función puede producir
//     uno, así que un literal hardcodeado o un segundo default NO COMPILA en los call sites.
//
// 🔴 Y ADEMÁS ESTE ES EL ÚNICO SITIO DE PRODUCCIÓN DONDE SE ESCRIBE EL NOMBRE DEL AGENTE (CD-2).
// Por eso el nombre se compone acá (`kycAgentUrl`) y NUNCA en el cliente: si el cliente concatenara
// la ruta, el nombre aparecería dos veces y el candado `agent-slug-residue.static.test.ts` dejaría de
// significar lo que dice. El comentario tampoco lo nombra a propósito — `T-ENV-3` cuenta apariciones
// TEXTUALES en este archivo, así que mencionarlo en prosa lo pondría rojo.
//
// ⚠️ ESTA ENV ES TAMBIÉN EL INTERRUPTOR DE ROLLBACK DE WKH-233 (D-1). Quitarla hace que
// `POST /api/kyc/session` responda 501, que `AgentKycGateway.start` caiga al fallback y que el demo
// quede byte-idéntico a como estaba sin credenciales del proveedor. ⛔ PROHIBIDO agregar una segunda
// perilla (`KYC_AGENT_ENABLED` o similar): dos apagados para una cosa es peor que uno, y este repo ya
// tiene el precedente escrito en `.env.example` con `KYC_VERDICT_STORE_ENABLED`.
//
// ⛔ Y EL ROLLBACK NO ES ROTAR `KYC_DECISION_TOKEN_SECRET` EN EL AGENTE: eso es un CORTE (CD-21).
// Invalida TODOS los `decisionToken` en vuelo, incluidos los de personas ya verificadas que todavía
// no cobraron, y no hay dónde re-emitirlos.

/** Segmento del agente dentro del host. El nombre vive acá y en ningún otro lado de producción. */
const KYC_AGENT_PATH = "/api/agents/remit-kyc-validator";

// Brand nominal: ver la regla 2 de la cabecera.
declare const kycAgentBaseUrlBrand: unique symbol;
export type KycAgentBaseUrl = string & { readonly [kycAgentBaseUrlBrand]: "kyc-agent-base-url" };

/** Los dos endpoints del agente que este repo consume. Conjunto CERRADO. */
export type KycAgentEndpoint = "session" | "decision";

/**
 * Resuelve el host del agente. ÚNICA fábrica de `KycAgentBaseUrl` del repo.
 *
 * ⚠️ Se llama LAZY (dentro del handler / de la función), NUNCA a nivel de módulo. Evaluarlo al
 * importar voltearía rutas que ni le hablan al agente, y rompería el orden de despliegue: la env se
 * siembra en el proveedor ANTES del deploy, y el deploy la levanta ya seteada.
 *
 * Lanza —siempre con el mismo error, que NUNCA ecoa el valor— si la env falta, está vacía, es sólo
 * espacios, o no parsea como URL absoluta.
 */
export function resolveKycAgentBaseUrl(): KycAgentBaseUrl {
  const raw = process.env.KYC_AGENT_BASE_URL?.trim();
  if (!raw) {
    throw new Error(
      "kyc_agent_base_url_unset: seteá KYC_AGENT_BASE_URL con el host del agente de verificación " +
        "de identidad. No se asume ninguno: un servicio que no sabe a qué agente le está " +
        "preguntando por la identidad de una persona no pregunta.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Value-free: el valor puede traer credenciales embebidas en la URL. Sólo la etiqueta de rama.
    throw new Error("kyc_agent_base_url_invalid: KYC_AGENT_BASE_URL no es una URL absoluta válida.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("kyc_agent_base_url_invalid: KYC_AGENT_BASE_URL no es una URL absoluta válida.");
  }
  // Sin la barra final: `kycAgentUrl` concatena una ruta que ya empieza con `/`.
  return raw.replace(/\/+$/, "") as KycAgentBaseUrl;
}

/**
 * Compone la URL de uno de los dos endpoints del agente.
 *
 * ⛔ PROHIBIDO que un call site arme esta URL por su cuenta: el nombre del agente aparecería una
 * segunda vez en producción y violaría CD-2. El parámetro es una unión cerrada, no un `string`, para
 * que un endpoint inventado no compile.
 */
export function kycAgentUrl(base: KycAgentBaseUrl, endpoint: KycAgentEndpoint): string {
  return `${base}${KYC_AGENT_PATH}/${endpoint}`;
}
