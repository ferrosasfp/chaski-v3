// Infrastructure — cliente server-only del gateway wasiai-a2a (WKH-218, reescrito en WKH-304). 3er
// modo de transporte value-delivery ("a2a-gateway"): NO resuelve el agente por nombre — manda
// `capability` (+ `constraints` opcionales) por step a POST /compose y el GATEWAY resuelve, fail-closed
// (WKH-304/CD-1). Este cliente ya no descubre agentes ni los elige: la resolución por nombre y su
// caída silenciosa al primer agente de la lista se borraron enteras — corrían OTRO agente sin
// decirlo, que es el anti-patrón que esta HU cierra.
// Multi-step por contrato (`steps[]`), errores GRANULARES (índice del paso + code/reason reales del
// gateway) en vez de colapsar todo a "unavailable". Lo importan SOLO las routes server-only
// (NUNCA container.ts ni "use client" — CD-A2A-10). Cero PII / cero secreto en logs (CD-8/CD-9):
// jamás se loguea el input (contiene beneficiary), la Agent Key, la URL ni el `message` del gateway.
// Sin tipos de escape ni conversiones forzadas (CD-12): las responses se tipan `unknown` y se
// estrechan con isRecord + Array.isArray. (La regla se enuncia sin nombrar los literales prohibidos:
// el gate de QA es un grep sobre este archivo y un comentario que los cite lo deja en rojo.)
// Chaski NO firma x402 (AC-5): el único header de auth es x-a2a-key; el body NO lleva challenge ni firma.

/** Capacidades verificadas contra el catálogo en vivo del gateway (2026-07-28). CD-14.
 *  Los defaults viejos ("fx-quote" / "cashout-payout") NO existen en ningún AgentCard: sólo
 *  "funcionaban" porque el fallback silencioso al primer agente descubierto los tapaba. */
export const FX_QUOTE_CAPABILITY = "remittance-fx-quote";
export const PAYOUT_CAPABILITY = "remittance-payout";

/** Piso de confianza del leg de payout (AC-5 / CD-5). Constante de código, NO env: una env con
 *  default ausente es un piso que se apaga solo (nadie la setea en un entorno nuevo, min_reputation
 *  queda undefined, el filtro no filtra y el control desaparece sin que falle nada). NO es un control
 *  de seguridad: sube el piso, no reemplaza PR8 (formato del depositAddress) ni PR9 (atestación HMAC),
 *  que corren idénticos con piso o sin piso. Valor 2 = "al menos una task liquidada con historial
 *  limpio" según la fórmula del gateway (score = round(min(tasksSettled/50,1) * 100 * successRate)
 *  ⇒ 2 puntos por task liquidada; sin score computado el agente cuenta 0 y queda excluido si min > 0). */
export const PAYOUT_MIN_REPUTATION = 2;

/** Constraints admitidas por el gateway. Cualquier otra clave ⇒ 400 (compose-step-shape del server). */
export type GatewayConstraints = {
  max_price_usdc?: number;
  min_reputation?: number;
};

export type GatewayStep = {
  capability: string; // NUNCA `agent` (CD-1)
  input: Record<string, unknown>; // el body TAL CUAL
  constraints?: GatewayConstraints;
};

export type GatewayFailCode =
  | "not_configured" // envs ausentes ⇒ cero fetch
  | "invalid_steps" // steps vacío ⇒ cero fetch
  | "no_agent_match" // 422 — ninguna capacidad resolvió
  | "invalid_request" // 400 de shape (VALIDATION_ERROR / ambiguous_step)
  | "agent_not_found" // 404
  | "registry_unavailable" // 503
  | "payment_required" // 402
  | "forbidden" // 403
  | "step_failed" // success:false mid-pipeline
  | "bad_response" // 200 con shape inválido / JSON ilegible
  | "unavailable"; // red, timeout, status no mapeado

export type GatewayFailure = {
  ok: false;
  code: GatewayFailCode;
  /** Índice del step que falló: del body (400/422) o derivado de steps.length (mid-pipeline). */
  step?: number;
  /** `code` / `error_code` REAL del gateway, sin traducir. */
  gatewayCode?: string;
  /** `reason` del 422: 'no_candidates' | 'excluded_by_scope'. */
  reason?: string;
  /** Mensaje del gateway. SERVER-ONLY: prohibido ecoarlo al browser y prohibido loguearlo (CD-8/CD-9). */
  message?: string;
  httpStatus?: number;
};

export type GatewayResult =
  | { ok: true; outputs: Record<string, unknown>[] } // uno por step, en orden
  | GatewayFailure;

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

/** Copia los campos granulares del body de error del gateway SIN traducirlos (§5 del Story).
 *  Sólo `code`/`error_code` → gatewayCode, `reason`, `step` numérico y `error` → message. */
function readFailureFields(body: unknown): Omit<GatewayFailure, "ok" | "code"> {
  if (!isRecord(body)) return {};
  const step = typeof body.step === "number" ? body.step : undefined;
  const gatewayCode =
    typeof body.code === "string"
      ? body.code
      : typeof body.error_code === "string"
        ? body.error_code
        : undefined;
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  const message = typeof body.error === "string" ? body.error : undefined;
  return {
    ...(step !== undefined ? { step } : {}),
    ...(gatewayCode !== undefined ? { gatewayCode } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

/** Mapeo POR STATUS de la tabla §5. Status desconocido ⇒ unavailable (con httpStatus). */
function mapErrorStatus(status: number, body: unknown): GatewayFailCode {
  switch (status) {
    case 400:
      // Dos 400 distintos: el de shape (VALIDATION_ERROR / ambiguous_step, pre-débito) y el
      // `success:false` de un fallo mid-pipeline. Se discrimina por el campo `success`.
      return isRecord(body) && body.success === false ? "step_failed" : "invalid_request";
    case 402:
      return "payment_required";
    case 403:
      return "forbidden";
    case 404:
      return "agent_not_found";
    case 422:
      return "no_agent_match";
    case 503:
      return "registry_unavailable";
    default:
      return "unavailable";
  }
}

export async function runViaGateway(params: { steps: GatewayStep[] }): Promise<GatewayResult> {
  // 1. Config: ausente ⇒ not_configured SIN fetch.
  const cfg = readGatewayConfig();
  if (!cfg) return { ok: false, code: "not_configured" };

  // 2. Sin steps no hay nada que componer ⇒ invalid_steps SIN fetch. El cliente NO replica el
  //    MAX_COMPOSE_STEPS del servidor: el servidor lo valida pre-débito y duplicar el número en dos
  //    lados es cómo se desincronizan.
  if (params.steps.length === 0) return { ok: false, code: "invalid_steps" };

  // 3. POST /compose — auth x-a2a-key, un step por capacidad, input TAL CUAL. El step emite EXACTO
  //    tres claves: capability, input y (opcional) constraints. Nada de nombre/registro del agente
  //    (`agent` + `capability` juntos ⇒ ambiguous_step del servidor, CD-1) y NADA de chaining entre
  //    pasos.
  //    Por qué no hay chaining, al día de hoy: el mapeo de campos entre pasos YA EXISTE del lado
  //    servidor (WKH-305, mergeada), y su regla S8 RECHAZA con 400 pre-cobro un mapeo declarado en el
  //    step 0 — porque no hay paso anterior del cual mapear. Esta HU manda exactamente UN step por
  //    llamada (un leg por request), así que todo step que emite este cliente ES el step 0: declarar
  //    un mapeo acá no sería un no-op, sería un 400 garantizado. Lo que WKH-305 destraba es FUSIONAR
  //    cotización + desembolso en una sola llamada, y eso es un cambio de diseño que además necesita
  //    una decisión de producto sobre re-cotizar (§11 del Story), no un campo más en el body.
  //    El tipo `GatewayStep` no declara la clave: el intento se cae en compilación (TS2353).
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/compose`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-key": cfg.key,
        // Solo si está configurada: sin ella el gateway cobra en su red default (ver readGatewayConfig).
        ...(cfg.paymentChain ? { "x-payment-chain": cfg.paymentChain } : {}),
      },
      body: JSON.stringify({
        steps: params.steps.map((s) => ({
          capability: s.capability,
          input: s.input,
          ...(s.constraints ? { constraints: s.constraints } : {}),
        })),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // 4a. timeout/DNS/red → opaco, NUNCA propaga.
    return { ok: false, code: "unavailable" };
  }

  // 4b. Body ilegible: en un status de error se sigue mapeando POR STATUS (defensivo, el gateway
  //     detrás de un proxy puede devolver HTML); en un 200 es `bad_response`.
  let parsed: unknown;
  let parseOk = true;
  try {
    parsed = await res.json();
  } catch {
    parseOk = false;
  }

  // 5. Status de error ⇒ mapeo granular por status + copia de los campos REALES del gateway.
  if (!res.ok) {
    const code = mapErrorStatus(res.status, parsed);
    return {
      ok: false,
      code,
      ...readFailureFields(parsed),
      httpStatus: res.status,
    };
  }
  if (!parseOk || !isRecord(parsed)) return { ok: false, code: "bad_response" };

  // 6. 200 con success:false ⇒ fallo mid-pipeline. El índice del paso que falló es ESTRUCTURAL:
  //    el servidor devuelve en `steps` sólo los pasos COMPLETADOS ⇒ el que falló es steps.length.
  //    PROHIBIDO parsear el texto "Step 2 failed: ..." (message queda server-only, CD-8/CD-9).
  if (parsed.success !== true) {
    const completed = Array.isArray(parsed.steps) ? parsed.steps.length : undefined;
    return {
      ok: false,
      code: "step_failed",
      ...(completed !== undefined ? { step: completed } : {}),
      ...(typeof parsed.error === "string" ? { message: parsed.error } : {}),
    };
  }

  // 7. Un output por step pedido, en orden. Largo distinto ⇒ bad_response (el gateway no compuso lo
  //    que se le pidió: aceptarlo sería leer el output de OTRO step).
  const steps = parsed.steps;
  if (!Array.isArray(steps) || steps.length !== params.steps.length) {
    return { ok: false, code: "bad_response" };
  }
  const outputs: Record<string, unknown>[] = [];
  for (let i = 0; i < steps.length; i++) {
    const entry: unknown = steps[i];
    const output = isRecord(entry) ? entry.output : undefined;
    if (!isRecord(output)) return { ok: false, code: "bad_response", step: i };
    outputs.push(output);
  }

  // 8. Happy path: outputs[i] = steps[i].output SIN re-desenvolver (el gateway ya hizo
  //    output = data.result ?? data, DT-A2A-6). Cada route revalida su propio shape final.
  return { ok: true, outputs };
}

/** Log de fallo con SÓLO enums (CD-9): ni el `message` del gateway, ni el input (PII), ni la URL,
 *  ni la Agent Key. Existe porque el valor operativo es poder distinguir "no hay agente para esa
 *  capacidad" (no_agent_match/no_candidates) de "el gateway está caído" (unavailable) sin adivinar. */
export function logGatewayFailure(
  leg: "quote" | "payout-submit" | "payout-prepare",
  f: GatewayFailure,
): void {
  console.warn("[a2a-gateway] leg_failed", {
    leg,
    code: f.code,
    step: f.step,
    gatewayCode: f.gatewayCode,
    reason: f.reason,
    httpStatus: f.httpStatus,
  });
}
