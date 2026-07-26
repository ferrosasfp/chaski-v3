// Infrastructure — cliente server-only del gateway wasiai-a2a (WKH-218). 3er modo de transporte
// value-delivery ("a2a-gateway"): resuelve el agente vía POST /discover (SIN auth) y lo invoca vía
// POST /compose (single-step, auth x-a2a-key). Lo importan SOLO las routes server-only app/api/a2a/*
// (NUNCA container.ts ni "use client" — CD-A2A-10). Fail-closed exhaustivo (CD-5): cualquier error
// del gateway (timeout/DNS/5xx/shape inválido/discover vacío) devuelve { ok:false } → la route corta
// con 502/501 opaco, CERO fallback silencioso al punto-a-punto. Cero PII / cero secreto en logs
// (CD-3/CD-4): jamás se loguea el input (contiene beneficiary), la Agent Key ni la URL. Sin any /
// sin as unknown (CD-A2A-11): responses tipadas unknown y estrechadas con isRecord + Array.isArray.
// Chaski NO firma x402 (AC-5): el único header es x-a2a-key; el body NO lleva challenge ni firma.

export type GatewayFailCode = "not_configured" | "no_agent" | "unavailable";
export type GatewayResult =
  | { ok: true; result: unknown }
  | { ok: false; code: GatewayFailCode };

// Tipos narrow del gateway (reproducidos local, NO importados de wasiai-a2a — CD-1).
interface GatewayAgent {
  slug: string; // → ComposeStep.agent
  registry: string; // → ComposeStep.registry
  capabilities: string[];
  status: "active" | "inactive" | "unreachable";
  // (id/name/description/priceUsdc/verified/... presentes en el gateway pero NO consumidos)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Config server-only (SIN NEXT_PUBLIC_, CD-3), leída en runtime dentro de la fn (patrón !BASE).
//
// `paymentChain` (WASIAI_A2A_PAYMENT_CHAIN) selecciona en QUÉ red se cobra el fee del agente,
// vía el header `x-payment-chain` del gateway. Es OPCIONAL: ausente ⇒ no se manda el header y el
// gateway usa su red default, que es el comportamiento previo (cero cambio si nadie la setea).
//
// Por qué existe: el saldo de una Agent Key es POR RED (`budget[chainId]`). Sin este header, una
// key con saldo en avalanche-fuji contra un gateway cuya default es kite-ozone-testnet recibe
// 403 INSUFFICIENT_BUDGET aunque tenga fondos — el caller no tenía forma de decir dónde cobrarle.
// Medido 2026-07-26: "chain 2368 (kite-ozone-testnet) balance is 0; no x-payment-chain header
// sent, used default 'kite-ozone-testnet'; chains with balance: avalanche-fuji (6.793)".
function readGatewayConfig(): {
  url: string;
  key: string;
  paymentChain?: string;
} | null {
  const url = process.env.WASIAI_A2A_GATEWAY_URL;
  const key = process.env.WASIAI_A2A_AGENT_KEY;
  if (!url || !key) return null; // ausente/vacío ⇒ not_configured
  const paymentChain = process.env.WASIAI_A2A_PAYMENT_CHAIN?.trim();
  return paymentChain ? { url, key, paymentChain } : { url, key };
}

export async function runViaGateway(params: {
  capability: string; // WASIAI_A2A_FX_CAPABILITY | WASIAI_A2A_PAYOUT_CAPABILITY
  expectedSlug?: string; // WASIAI_A2A_FX_SLUG | WASIAI_A2A_PAYOUT_SLUG (desambigua el pick)
  input: Record<string, unknown>; // el body TAL CUAL (idempotencyKey/beneficiary intactos, CD-8)
}): Promise<GatewayResult> {
  // 1. Config: ausente ⇒ not_configured SIN fetch.
  const cfg = readGatewayConfig();
  if (!cfg) return { ok: false, code: "not_configured" };

  // 2. POST /discover — SIN auth. Cualquier throw / !ok / shape inválido ⇒ unavailable (fail-closed).
  let discovery: unknown;
  try {
    const res = await fetch(`${cfg.url}/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilities: [params.capability], includeInactive: false }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, code: "unavailable" };
    discovery = await res.json();
  } catch {
    return { ok: false, code: "unavailable" }; // timeout/DNS/parse → opaco, NUNCA propaga
  }
  if (!isRecord(discovery) || !Array.isArray(discovery.agents)) {
    return { ok: false, code: "unavailable" };
  }

  // 3. Pick del agente resuelto (NUNCA el slug hardcodeado del punto-a-punto — CD-5).
  const agents = discovery.agents as GatewayAgent[];
  const pick = params.expectedSlug
    ? (agents.find((a) => a.slug === params.expectedSlug) ?? agents[0])
    : agents[0];
  if (agents.length === 0 || pick == null) return { ok: false, code: "no_agent" };

  // 4. POST /compose — single-step, auth x-a2a-key, input TAL CUAL. Throw / !ok ⇒ unavailable.
  let composed: unknown;
  try {
    const res = await fetch(`${cfg.url}/compose`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-key": cfg.key,
        // Solo si está configurada: sin ella el gateway cobra en su red default (ver readGatewayConfig).
        ...(cfg.paymentChain ? { "x-payment-chain": cfg.paymentChain } : {}),
      },
      body: JSON.stringify({
        steps: [{ agent: pick.slug, registry: pick.registry, input: params.input }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, code: "unavailable" };
    composed = await res.json();
  } catch {
    return { ok: false, code: "unavailable" };
  }

  // 5. Validación de la respuesta del compose (sin any: estrechada con isRecord + Array.isArray).
  if (!isRecord(composed) || composed.success !== true) return { ok: false, code: "unavailable" };
  const steps = composed.steps;
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, code: "unavailable" };
  const output = (steps[0] as { output?: unknown }).output;
  if (!isRecord(output)) return { ok: false, code: "unavailable" };

  // 6. Happy path: steps[0].output SIN re-desenvolver (el gateway ya hizo output = data.result ?? data,
  //    DT-A2A-6). La route revalida el shape final con su propio isValid*Result.
  return { ok: true, result: output };
}
