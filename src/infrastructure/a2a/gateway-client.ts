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

/**
 * Piso de confianza del leg de FX (WKH-313). Mismo valor que el de payout, constante SEPARADA a
 * propósito: son dos decisiones de riesgo distintas y compartir el número las ataría (bajar el piso
 * de FX no puede bajar el de payout de rebote).
 *
 * ⚠️ POR QUÉ EL LEG DE FX MANDA UN PISO, SI LO QUE QUEREMOS ES ADMITIR AGENTES NUEVOS. Medido en el
 * gateway, no asumido: `allow_trial` se lee ÚNICAMENTE dentro de `if (query.minReputation != null)`
 * (`services/discovery.ts`, el bloque que llama a `applyReputationFloor`). Sin `min_reputation` la
 * clave `allow_trial` es LETRA MUERTA: viaja, el gateway la acepta, y no ejecuta nada.
 *
 * Y hay una segunda mitad, que es la que de verdad importa. La neutralización de `verified` y
 * `reputation` del admitido vive DENTRO de ese mismo bloque. Sin piso no hay neutralización, y esos
 * dos campos salen del card que el propio agente publica: un desconocido que declara
 * `verified: true, reputation: 100` gana el ranking de FX HOY MISMO (sin carril, sin piso y sin
 * que nadie lo note), porque `verified` es la PRIMERA clave del sort. Mandar el piso es lo que lo
 * manda al final de la fila.
 *
 * O sea: pedir el carril sin piso no sería "más abierto". Sería el carril apagado y encima el
 * ranking decidido por lo que el candidato dice de sí mismo.
 *
 * Valor 2 = "al menos una task liquidada" con la fórmula del gateway, igual que en payout. Tiene
 * que quedar por DEBAJO del techo `T` del carril (`TRIAL_MAX_MIN_REPUTATION`, default 10): con un
 * piso por encima de `T`, `isTrialEligible` devuelve false y el carril se apaga en silencio.
 *
 * ⚠️ LO QUE ESTE PISO CUESTA, dicho de frente, y son DOS cosas:
 *
 * 1. Hoy el leg de FX no manda ninguna constraint, así que ningún candidato queda excluido. Con el
 *    piso puesto, si NINGÚN agente del corredor llega a 2 y el carril no admite a nadie (por ejemplo
 *    porque el standing del gateway está degradado, que falla cerrado), el leg pasa de cotizar a un
 *    422 `no_agent_match`. Es una cotización que no sale, no plata perdida, y se ve antes de que la
 *    persona firme nada, pero es un modo de falla nuevo.
 *
 * 2. EL CARRIL NO PUEDE RESCATAR AL TITULAR. Medido: el único candidato de FX de hoy pasa por
 *    MÉRITO, con score 7 y 5 tasks liquidadas (el piso lee `computedReputation.score`, no el
 *    `reputation` del card). Si ese score cayera por debajo de 2, el carril de estreno NO lo
 *    levantaría: admite a quien NO tiene historial liquidado, y con 5 tasks ya no califica como
 *    novato. O sea que en ese escenario el titular queda afuera y el ÚNICO admisible pasa a ser un
 *    recién llegado sin historial. `allow_trial` no es una red debajo del titular; es una puerta
 *    para el que todavía no tiene puntaje. Hoy, de hecho, no admite a nadie: es preventivo.
 */
export const FX_MIN_REPUTATION = 2;

/** Constraints admitidas por el gateway. Cualquier otra clave ⇒ 400 (compose-step-shape del server). */
export type GatewayConstraints = {
  max_price_usdc?: number;
  min_reputation?: number;
  /**
   * WKH-313: opt-in al CARRIL DE ESTRENO de ESTE step: admite bajo `min_reputation` a un agente
   * sin historial liquidado. El admitido NO recibe score fabricado (conserva su 0, así que ordena
   * ÚLTIMO) y el gateway le neutraliza `verified`/`reputation`, que su propio card auto-reporta.
   * Sólo puede ganar cuando NINGÚN agente pasa por mérito.
   *
   * Sólo tiene efecto acompañado de `min_reputation` (ver FX_MIN_REPUTATION). No-booleano ⇒ 400.
   */
  allow_trial?: boolean;
};

export type GatewayStep = {
  capability: string; // NUNCA `agent` (CD-1)
  input: Record<string, unknown>; // el body TAL CUAL
  constraints?: GatewayConstraints;
};

/**
 * QUIÉN ejecutó un step, tal como lo dijo el gateway. Se lee de `steps[i].agent` (+ `resolvedFrom`),
 * que la respuesta de `/compose` YA traía y este cliente descartaba.
 *
 * Es trazabilidad, no una decisión: nada del transporte lo usa para elegir, reintentar ni validar.
 * Sirve para poder responder "qué agente atendió esta remesa", que sin esto no se podía responder.
 */
export type GatewayAgentRef = {
  slug: string;
  /** De qué catálogo salió. Ausente ⟹ el gateway no lo dijo (NO se rellena con "": ver AgentRef). */
  registry?: string;
  /** `resolvedFrom.capability`: presente SÓLO si lo eligió el gateway a partir de una capacidad. */
  capability?: string;
  /** `agent.trial.granted`: entró por el carril de estreno, o sea sin historial liquidado. */
  trial?: boolean;
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
  | {
      ok: true;
      outputs: Record<string, unknown>[]; // uno por step, en orden
      /**
       * Uno por step, en el MISMO orden que `outputs`. `null` = el gateway no dijo (o no dijo de
       * forma legible) qué agente ejecutó ese step.
       *
       * `null` y no un objeto con campos vacíos, a propósito: "no sé quién atendió" es un estado
       * real y el consumidor tiene que poder distinguirlo de "atendió alguien sin nombre". Y NO es
       * un error de transporte: la elección del agente no cambia por que no sepamos anotarla, así
       * que un `agent` ilegible NO invalida un output que sí es válido.
       */
      agents: (GatewayAgentRef | null)[];
    }
  | GatewayFailure;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Lee `steps[i].agent` (+ `resolvedFrom`) SIN inventar nada: sin `slug` string no-vacío no hay
 *  identidad que afirmar ⇒ `null`. Los opcionales entran sólo con el tipo exacto. */
function readAgentRef(entry: unknown): GatewayAgentRef | null {
  if (!isRecord(entry)) return null;
  const agent = entry.agent;
  if (!isRecord(agent)) return null;
  if (typeof agent.slug !== "string" || !agent.slug) return null;
  const resolvedFrom = entry.resolvedFrom;
  const capability =
    isRecord(resolvedFrom) && typeof resolvedFrom.capability === "string"
      ? resolvedFrom.capability
      : undefined;
  // `trial` sólo existe en la respuesta cuando la admisión ocurrió de verdad (el gateway lo omite,
  // no lo manda en false). Se copia `granted` tal cual; su ausencia NO se traduce a `false`, porque
  // "el gateway no lo marcó" no es "este agente tiene historial".
  const trial = isRecord(agent.trial) && agent.trial.granted === true ? true : undefined;
  return {
    slug: agent.slug,
    // MISMO criterio que capability/trial: si no vino con el tipo exacto, el campo NO se escribe. Un
    // `""` de relleno diría "el catálogo es vacío" en vez de "el gateway no lo dijo".
    ...(typeof agent.registry === "string" && agent.registry ? { registry: agent.registry } : {}),
    ...(capability !== undefined ? { capability } : {}),
    ...(trial !== undefined ? { trial } : {}),
  };
}

// Config server-only (SIN NEXT_PUBLIC_, CD-3), leída en runtime dentro de la fn (patrón !BASE).
//
// `paymentChain` (WASIAI_A2A_PAYMENT_CHAIN) selecciona en QUÉ red se cobra el fee del agente,
// vía el header `x-payment-chain` del gateway. Es OPCIONAL: ausente ⇒ no se manda el header y el
// gateway usa su red default, que es el comportamiento previo (cero cambio si nadie la setea).
//
// Por qué existe: el saldo de una Agent Key es POR RED. Sin este header, una key con saldo en
// `solana-devnet` contra un gateway cuya red default es OTRA recibe 403 INSUFFICIENT_BUDGET aunque
// tenga fondos — el caller no tenía forma de decir dónde cobrarle. La forma del error del gateway es
// "balance is 0; no x-payment-chain header sent, used default '<red>'; chains with balance:
// solana-devnet (6.793)": nombra la red que sí tiene saldo, que es justamente la que había que pedir.
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
  const agents: (GatewayAgentRef | null)[] = [];
  for (let i = 0; i < steps.length; i++) {
    const entry: unknown = steps[i];
    const output = isRecord(entry) ? entry.output : undefined;
    if (!isRecord(output)) return { ok: false, code: "bad_response", step: i };
    outputs.push(output);
    // QUIÉN lo ejecutó. El gateway ya lo mandaba en `steps[i].agent` y este cliente lo tiraba.
    // No participa de ninguna validación: un agente ilegible da `null`, nunca un bad_response.
    agents.push(readAgentRef(entry));
  }

  // 8. Happy path: outputs[i] = steps[i].output SIN re-desenvolver (el gateway ya hizo
  //    output = data.result ?? data, DT-A2A-6). Cada route revalida su propio shape final.
  return { ok: true, outputs, agents };
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
