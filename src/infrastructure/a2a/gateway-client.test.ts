// Tests del transporte del gateway (WKH-304). El contrato viejo (/discover + pick del agente por
// slug, con `agents.find(...) ?? agents[0]` de fallback) YA NO EXISTE: acá se prueba que el cliente
// pide por CAPACIDAD, que el gateway es el único que resuelve, y que todo fallo se propaga TIPADO y
// GRANULAR (índice del step + code/reason reales) sin segundo intento ni agente alternativo.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FX_QUOTE_CAPABILITY,
  PAYOUT_CAPABILITY,
  PAYOUT_MIN_REPUTATION,
  type GatewayFailure,
  type GatewayStep,
  logGatewayFailure,
  runViaGateway,
} from "./gateway-client";

const URL = "https://gateway.example.com";
const KEY = "ak_super_secret_key";

const quoteOutput = { quoteId: "cfx-1", rate: 3.7 };
const composeOk = { success: true, steps: [{ output: quoteOutput }] };

/** Stub de fetch: un solo endpoint (/compose). `status` decide ok/!ok; `throws` simula red caída. */
function router(
  opts: { status?: number; body?: unknown; throws?: boolean; jsonThrows?: boolean } = {},
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (opts.throws) throw new Error("network");
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (opts.jsonThrows) throw new Error("invalid json");
        return opts.body ?? composeOk;
      },
    };
  });
  return { fn, calls };
}

/** Body del /compose parseado (el único request que este cliente emite). */
function composeBody(calls: { url: string; init?: RequestInit }[]): {
  steps: Record<string, unknown>[];
} {
  const compose = calls.find((c) => c.url.includes("/compose"));
  if (!compose) throw new Error("no hubo request a /compose");
  return JSON.parse(compose.init?.body as string);
}

const fxStep = { capability: FX_QUOTE_CAPABILITY, input: { amountUsd: 400 } };

beforeEach(() => {
  vi.stubEnv("WASIAI_A2A_GATEWAY_URL", URL);
  vi.stubEnv("WASIAI_A2A_AGENT_KEY", KEY);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runViaGateway — AC-1: se pide por CAPACIDAD, el gateway resuelve (cero /discover)", () => {
  // T-A1.1 (asesino de M5): el body lleva `capability` y NUNCA `agent`/`registry`. Sin este assert,
  // reintroducir el nombre del agente al lado de la capacidad pasaría desapercibido en el cliente.
  it("T-A1.1: el body del /compose trae capability y NO las claves agent/registry; ninguna URL es /discover", async () => {
    const { fn, calls } = router();
    vi.stubGlobal("fetch", fn);
    const r = await runViaGateway({ steps: [fxStep] });
    expect(r).toEqual({ ok: true, outputs: [quoteOutput] });

    expect(calls.map((c) => c.url)).toEqual([`${URL}/compose`]);
    expect(calls.some((c) => c.url.includes("/discover"))).toBe(false);

    const body = composeBody(calls);
    expect(body.steps).toHaveLength(1);
    expect(Object.keys(body.steps[0]!)).toEqual(["capability", "input"]);
    expect(body.steps[0]!.capability).toBe("remittance-fx-quote");
    expect(body.steps[0]).not.toHaveProperty("agent");
    expect(body.steps[0]).not.toHaveProperty("registry");
    // CD-6: tampoco el chaining del servidor (passOutput) ni el field-mapping de WKH-305.
    const raw = calls[0]!.init!.body as string;
    expect(raw).not.toContain("passOutput");
    expect(raw).not.toContain("inputFromPrevious");
  });

  // T-A1.2 (asesino de M5): las envs de slug del contrato viejo son IGNORADAS por completo. Si algo
  // volviera a leerlas, el body cambiaría con sólo setearlas.
  it("T-A1.2: con WASIAI_A2A_FX_SLUG y WASIAI_A2A_PAYOUT_SLUG seteadas, el body emitido no cambia", async () => {
    vi.stubEnv("WASIAI_A2A_FX_SLUG", "slug-fx-viejo");
    vi.stubEnv("WASIAI_A2A_PAYOUT_SLUG", "slug-payout-viejo");
    const { fn, calls } = router();
    vi.stubGlobal("fetch", fn);
    await runViaGateway({ steps: [fxStep] });
    const raw = calls[0]!.init!.body as string;
    expect(raw).not.toContain("slug-fx-viejo");
    expect(raw).not.toContain("slug-payout-viejo");
    expect(JSON.parse(raw)).toEqual({
      steps: [{ capability: "remittance-fx-quote", input: { amountUsd: 400 } }],
    });
  });

  // T-A1.3 (asesino de M8): los defaults viejos ("fx-quote"/"cashout-payout") NO existen en ningún
  // AgentCard — con el fallback silencioso borrado darían 422 no_agent_match en TODOS los legs.
  it("T-A1.3: las capacidades son las declaradas por el catálogo real (CD-14)", () => {
    expect(FX_QUOTE_CAPABILITY).toBe("remittance-fx-quote");
    expect(PAYOUT_CAPABILITY).toBe("remittance-payout");
  });

  it("T-A1.3b: las constraints viajan SÓLO cuando se piden, y con las claves que el server admite", async () => {
    const { fn, calls } = router();
    vi.stubGlobal("fetch", fn);
    await runViaGateway({
      steps: [
        {
          capability: PAYOUT_CAPABILITY,
          constraints: { min_reputation: PAYOUT_MIN_REPUTATION },
          input: {},
        },
      ],
    });
    expect(composeBody(calls).steps[0]).toEqual({
      capability: "remittance-payout",
      input: {},
      constraints: { min_reputation: 2 },
    });
  });

  // El step emitido NO es el step recibido: se re-serializa clave por clave. Esa es la propiedad que
  // hace imposible que un caller cuele chaining (`inputFromPrevious`, `passOutput`) o el nombre de un
  // agente en el body — y la que hay que testear ACÁ, no en la route (donde el assert equivalente
  // miraría el body ya filtrado y no podría ponerse rojo por nada que haga el caller).
  // El tipo `GatewayStep` ya rechaza esas claves en compilación (TS2353); el intersect con
  // Record<string, unknown> es lo que permite construir el caso hostil SIN `any` ni `as unknown as`.
  it("T-A1.1b: el step emitido es un whitelist (capability/input/constraints): lo que el caller agregue de más NO viaja", async () => {
    const hostile: GatewayStep & Record<string, unknown> = {
      capability: PAYOUT_CAPABILITY,
      input: { amountUsd: 400 },
      inputFromPrevious: { quoteId: "quoteId" }, // chaining: sólo con WKH-305 + decisión de producto
      passOutput: true, // chaining viejo del server
      agent: "remit-cashout-payout", // nombre del agente (CD-1)
      registry: "default",
    };
    const { fn, calls } = router();
    vi.stubGlobal("fetch", fn);
    await runViaGateway({ steps: [hostile] });

    const raw = calls[0]!.init!.body as string;
    expect(Object.keys(composeBody(calls).steps[0]!)).toEqual(["capability", "input"]);
    expect(raw).not.toContain("inputFromPrevious");
    expect(raw).not.toContain("passOutput");
    expect(raw).not.toContain("registry");
    expect(raw).not.toContain("remit-cashout-payout");
  });

  it("el input viaja TAL CUAL en el step (idempotencyKey/beneficiary intactos, CD-8)", async () => {
    const { fn, calls } = router();
    vi.stubGlobal("fetch", fn);
    const input = {
      amountUsd: 400,
      idempotencyKey: "r-1:cfx-1",
      beneficiary: { destination: "999" },
    };
    await runViaGateway({ steps: [{ capability: PAYOUT_CAPABILITY, input }] });
    expect(composeBody(calls).steps[0]!.input).toEqual(input);
  });

  it("multi-step: un output por step pedido, en orden", async () => {
    const { fn } = router({
      body: { success: true, steps: [{ output: { a: 1 } }, { output: { b: 2 } }] },
    });
    vi.stubGlobal("fetch", fn);
    const r = await runViaGateway({
      steps: [
        { capability: FX_QUOTE_CAPABILITY, input: {} },
        { capability: PAYOUT_CAPABILITY, input: {} },
      ],
    });
    expect(r).toEqual({ ok: true, outputs: [{ a: 1 }, { b: 2 }] });
  });
});

describe("runViaGateway — AC-2: fallo TIPADO y granular, cero segundo intento", () => {
  // T-A2.1 (asesino de M2): el 422 es EL modo de fallo del anti-fallback — nadie resolvió la
  // capacidad. Se conserva `reason` y `step`, y NO hay reintento con otro agente.
  it("T-A2.1: 422 no_agent_match/no_candidates ⇒ failure completo y UNA sola llamada (corta, no reintenta)", async () => {
    const { fn } = router({
      status: 422,
      body: {
        error: "no agent matched capability remittance-payout",
        code: "no_agent_match",
        reason: "no_candidates",
        capability: "remittance-payout",
        step: 0,
      },
    });
    vi.stubGlobal("fetch", fn);
    const r = await runViaGateway({ steps: [{ capability: PAYOUT_CAPABILITY, input: {} }] });
    expect(r).toEqual({
      ok: false,
      code: "no_agent_match",
      step: 0,
      gatewayCode: "no_agent_match",
      reason: "no_candidates",
      message: "no agent matched capability remittance-payout",
      httpStatus: 422,
    });
    expect(fn).toHaveBeenCalledTimes(1); // ni segundo intento ni "el primero de la lista"
  });

  // T-A2.2 (asesino de M2): el otro reason del 422, y un step ≠ 0.
  it("T-A2.2: 422 excluded_by_scope con step:1 preserva reason Y step", async () => {
    const { fn } = router({
      status: 422,
      body: { error: "excluded", code: "no_agent_match", reason: "excluded_by_scope", step: 1 },
    });
    vi.stubGlobal("fetch", fn);
    const r = await runViaGateway({
      steps: [
        { capability: FX_QUOTE_CAPABILITY, input: {} },
        { capability: PAYOUT_CAPABILITY, input: {} },
      ],
    });
    expect(r).toMatchObject({
      ok: false,
      code: "no_agent_match",
      reason: "excluded_by_scope",
      step: 1,
      httpStatus: 422,
    });
  });

  // T-A2.3 (asesino de M2): cada status tiene SU código. Colapsar todo a "unavailable" es
  // exactamente lo que impide distinguir "no hay agente" de "el gateway está caído".
  it("T-A2.3: 404/503/400/402/403 mapean cada uno a su code (no colapsan a unavailable)", async () => {
    const cases: {
      status: number;
      body: unknown;
      expected: Partial<GatewayFailure>;
    }[] = [
      {
        status: 404,
        body: { error: "agent not found", error_code: "AGENT_NOT_FOUND" },
        expected: { code: "agent_not_found", gatewayCode: "AGENT_NOT_FOUND", httpStatus: 404 },
      },
      {
        status: 503,
        body: { error: "registry down", error_code: "REGISTRY_UNAVAILABLE" },
        expected: {
          code: "registry_unavailable",
          gatewayCode: "REGISTRY_UNAVAILABLE",
          httpStatus: 503,
        },
      },
      {
        status: 400,
        body: { error: "agent and capability are mutually exclusive", code: "ambiguous_step", step: 0 },
        expected: {
          code: "invalid_request",
          gatewayCode: "ambiguous_step",
          step: 0,
          httpStatus: 400,
        },
      },
      {
        status: 400,
        body: { error: "steps[0].constraints has unknown key", code: "VALIDATION_ERROR" },
        expected: { code: "invalid_request", gatewayCode: "VALIDATION_ERROR", httpStatus: 400 },
      },
      {
        status: 402,
        body: { errorCode: "DEST_CAP_EXCEEDED" },
        expected: { code: "payment_required", httpStatus: 402 },
      },
      {
        status: 403,
        body: { errorCode: "SCOPE_DENIED" },
        expected: { code: "forbidden", httpStatus: 403 },
      },
    ];
    for (const c of cases) {
      const { fn } = router({ status: c.status, body: c.body });
      vi.stubGlobal("fetch", fn);
      const r = await runViaGateway({ steps: [{ capability: PAYOUT_CAPABILITY, input: {} }] });
      expect(r, `status ${c.status}`).toMatchObject(c.expected);
    }
  });

  // T-A2.4 (asesino de M10): fallo mid-pipeline. `steps` trae SÓLO los pasos completados ⇒ el índice
  // del que falló es steps.length. Y NUNCA se devuelven outputs parciales como si fueran éxito.
  it("T-A2.4: 200 success:false con 1 paso completado ⇒ step_failed con step:1 y ok:false (sin outputs)", async () => {
    const { fn } = router({
      body: {
        success: false,
        steps: [{ output: quoteOutput }],
        error: "Step 1 failed: agent returned 500",
      },
    });
    vi.stubGlobal("fetch", fn);
    const r = await runViaGateway({
      steps: [
        { capability: FX_QUOTE_CAPABILITY, input: {} },
        { capability: PAYOUT_CAPABILITY, input: {} },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r).toEqual({
      ok: false,
      code: "step_failed",
      step: 1,
      message: "Step 1 failed: agent returned 500",
    });
    expect(r).not.toHaveProperty("outputs");
  });

  // §5: el 400 tiene DOS formas. `success:false` es un fallo mid-pipeline (post-débito, el gateway
  // ya reembolsa su step-0) y NO un error de shape ⇒ no se puede colapsar con el VALIDATION_ERROR.
  it("T-A2.4b: 400 success:false (fallo mid-pipeline con status de error) ⇒ step_failed, no invalid_request", async () => {
    const { fn } = router({
      status: 400,
      body: { success: false, steps: [], error: "Step 1 failed", step: 0 },
    });
    vi.stubGlobal("fetch", fn);
    const r = await runViaGateway({ steps: [{ capability: PAYOUT_CAPABILITY, input: {} }] });
    expect(r).toMatchObject({ ok: false, code: "step_failed", step: 0, httpStatus: 400 });
  });

  // T-A2.5 (asesino de M11): un 200 cuyo shape no es el pedido es bad_response, NO un éxito parcial.
  it("T-A2.5: bad_response (steps no-array / largo ≠ al pedido / output no-record) y unavailable (red, status no mapeado)", async () => {
    const twoSteps = [
      { capability: FX_QUOTE_CAPABILITY, input: {} },
      { capability: PAYOUT_CAPABILITY, input: {} },
    ];

    // steps no-array
    const a = router({ body: { success: true, steps: "nope" } });
    vi.stubGlobal("fetch", a.fn);
    expect(await runViaGateway({ steps: [fxStep] })).toEqual({ ok: false, code: "bad_response" });

    // largo ≠ al pedido (se pidieron 2, volvió 1) ⇒ leer outputs[i] sería leer el step equivocado
    const b = router({ body: { success: true, steps: [{ output: quoteOutput }] } });
    vi.stubGlobal("fetch", b.fn);
    expect(await runViaGateway({ steps: twoSteps })).toEqual({ ok: false, code: "bad_response" });

    // output no-record (con el índice del primer inválido)
    const c = router({
      body: { success: true, steps: [{ output: quoteOutput }, { output: "not-an-object" }] },
    });
    vi.stubGlobal("fetch", c.fn);
    expect(await runViaGateway({ steps: twoSteps })).toEqual({
      ok: false,
      code: "bad_response",
      step: 1,
    });

    // 200 con JSON ilegible
    const d = router({ jsonThrows: true });
    vi.stubGlobal("fetch", d.fn);
    expect(await runViaGateway({ steps: [fxStep] })).toEqual({ ok: false, code: "bad_response" });

    // red caída (throw) ⇒ unavailable, sin httpStatus
    const e = router({ throws: true });
    vi.stubGlobal("fetch", e.fn);
    expect(await runViaGateway({ steps: [fxStep] })).toEqual({ ok: false, code: "unavailable" });

    // status no mapeado ⇒ unavailable PERO con el status real (para poder diagnosticarlo)
    const f = router({ status: 418, body: { error: "teapot" } });
    vi.stubGlobal("fetch", f.fn);
    expect(await runViaGateway({ steps: [fxStep] })).toMatchObject({
      ok: false,
      code: "unavailable",
      httpStatus: 418,
    });
  });

  // ESTE es el escenario que justifica leer el body de forma tolerante en la rama de error: un 5xx
  // servido por un proxy/CDN no trae JSON, trae HTML. Si el mapeo dependiera de que el body parsee,
  // un registry caído se reportaría como "el gateway contestó cualquier cosa" (bad_response) en vez
  // de "el registry no está" (registry_unavailable), y el diagnóstico apuntaría al lugar equivocado.
  it("T-A2.5b: status de error con body ILEGIBLE (HTML de un proxy) ⇒ igual mapea por status", async () => {
    const html = router({ status: 503, jsonThrows: true });
    vi.stubGlobal("fetch", html.fn);
    expect(await runViaGateway({ steps: [fxStep] })).toEqual({
      ok: false,
      code: "registry_unavailable",
      httpStatus: 503,
    });

    // Mismo razonamiento con un body que SÍ parsea pero no es un objeto: no hay campos granulares
    // que copiar y el status sigue mandando (no se inventa un gatewayCode).
    const notRecord = router({ status: 404, body: "not-a-record" });
    vi.stubGlobal("fetch", notRecord.fn);
    const r = await runViaGateway({ steps: [fxStep] });
    expect(r).toEqual({ ok: false, code: "agent_not_found", httpStatus: 404 });
    expect(r).not.toHaveProperty("gatewayCode");
  });

  // Hermana de T-A2.4: sin `steps` en el body no se puede DERIVAR el índice del paso que falló, y
  // entonces no se reporta ninguno. Nunca un 0 inventado (que se leería como "falló el primero").
  it("T-A2.5c: success:false SIN steps ⇒ step_failed sin `step` (no se inventa el índice)", async () => {
    const { fn } = router({ body: { success: false, error: "boom" } });
    vi.stubGlobal("fetch", fn);
    const r = await runViaGateway({ steps: [fxStep] });
    expect(r).toEqual({ ok: false, code: "step_failed", message: "boom" });
    expect(r).not.toHaveProperty("step");
  });

  // T-A2.6: opacidad. El failure se serializa y viaja por logs/telemetría: no puede llevar el
  // secreto, la URL interna ni el PII del input.
  it("T-A2.6: el GatewayFailure serializado no contiene la Agent Key, la URL del gateway ni el PII del input", async () => {
    const { fn } = router({ status: 422, body: { error: "no candidates", code: "no_agent_match" } });
    vi.stubGlobal("fetch", fn);
    const r = await runViaGateway({
      steps: [
        {
          capability: PAYOUT_CAPABILITY,
          input: { beneficiary: { name: "PII-999", destination: "999888777" } },
        },
      ],
    });
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(URL);
    expect(serialized).not.toContain("PII-999");
    expect(serialized).not.toContain("999888777");
  });

  it("T-A2.7: steps vacío ⇒ invalid_steps SIN fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await runViaGateway({ steps: [] })).toEqual({ ok: false, code: "invalid_steps" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("T-A2.7b: sin WASIAI_A2A_GATEWAY_URL ⇒ not_configured SIN fetch", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await runViaGateway({ steps: [fxStep] })).toEqual({
      ok: false,
      code: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("T-A2.7c: sin WASIAI_A2A_AGENT_KEY ⇒ not_configured SIN fetch", async () => {
    vi.stubEnv("WASIAI_A2A_AGENT_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await runViaGateway({ steps: [fxStep] })).toEqual({
      ok: false,
      code: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("logGatewayFailure — sólo enums (CD-9)", () => {
  // T-A2.8: el log es la ÚNICA superficie donde vive el detalle operativo (la respuesta HTTP es un
  // enum opaco). Por eso tiene que traer code/step/gatewayCode/reason... y NADA más.
  it("T-A2.8: emite UN console.warn con los enums y sin message/URL/key/input", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure: GatewayFailure = {
      ok: false,
      code: "no_agent_match",
      step: 0,
      gatewayCode: "no_agent_match",
      reason: "no_candidates",
      message: `no agent matched at ${URL} for key ${KEY} (beneficiary PII-999)`,
      httpStatus: 422,
    };
    logGatewayFailure("payout-prepare", failure);

    expect(warn).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(warn.mock.calls[0]);
    expect(serialized).toContain("payout-prepare");
    expect(serialized).toContain("no_agent_match");
    expect(serialized).toContain("no_candidates");
    expect(serialized).toContain('"step":0');
    expect(serialized).toContain('"httpStatus":422');
    // Lo prohibido (CD-9): el message del gateway, la URL, la key y cualquier PII del input.
    expect(serialized).not.toContain("no agent matched at");
    expect(serialized).not.toContain(URL);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain("PII-999");
  });
});

describe("runViaGateway — AC-5: gateway resuelve precio/x402 (x-a2a-key, sin firma)", () => {
  it("el request a /compose lleva x-a2a-key; el body NO contiene challenge/firma x402", async () => {
    const { fn, calls } = router();
    vi.stubGlobal("fetch", fn);
    await runViaGateway({ steps: [{ capability: PAYOUT_CAPABILITY, input: { amountUsd: 400 } }] });
    const compose = calls.find((c) => c.url.includes("/compose"))!;
    const headers = compose.init!.headers as Record<string, string>;
    expect(headers["x-a2a-key"]).toBe(KEY);
    const raw = compose.init!.body as string;
    expect(raw).not.toContain("x402");
    expect(raw).not.toContain("signature");
    expect(raw).not.toContain("challenge");
  });
});

// El saldo de una Agent Key es POR RED. Sin `x-payment-chain` el gateway cobra en su red default y
// una key con fondos en OTRA red recibe 403 INSUFFICIENT_BUDGET; visto en vivo contra el gateway de
// prod, con el resultado de que el /api/a2a/quote de Chaski devolvía 502 a2a_unavailable.
describe("runViaGateway — selección de la red de cobro (x-payment-chain)", () => {
  it("con WASIAI_A2A_PAYMENT_CHAIN, /compose lleva el header con ese valor", async () => {
    vi.stubEnv("WASIAI_A2A_PAYMENT_CHAIN", "solana-devnet");
    const { fn, calls } = router();
    vi.stubGlobal("fetch", fn);
    await runViaGateway({ steps: [fxStep] });
    const compose = calls.find((c) => c.url.includes("/compose"))!;
    expect((compose.init!.headers as Record<string, string>)["x-payment-chain"]).toBe(
      "solana-devnet",
    );
  });

  it("sin la env, el header NO se manda (preserva el comportamiento previo: red default del gateway)", async () => {
    const { fn, calls } = router();
    vi.stubGlobal("fetch", fn);
    await runViaGateway({ steps: [fxStep] });
    const compose = calls.find((c) => c.url.includes("/compose"))!;
    expect((compose.init!.headers as Record<string, string>)["x-payment-chain"]).toBeUndefined();
    // La auth sigue intacta: el fix no toca x-a2a-key.
    expect((compose.init!.headers as Record<string, string>)["x-a2a-key"]).toBe(KEY);
  });

  it("env en blanco se trata como ausente (no manda un header vacío)", async () => {
    vi.stubEnv("WASIAI_A2A_PAYMENT_CHAIN", "   ");
    const { fn, calls } = router();
    vi.stubGlobal("fetch", fn);
    await runViaGateway({ steps: [fxStep] });
    const compose = calls.find((c) => c.url.includes("/compose"))!;
    expect((compose.init!.headers as Record<string, string>)["x-payment-chain"]).toBeUndefined();
  });
});

// T-A6.1 (parte GC): CD-7 — mientras WKH-233 no esté DONE no se compone ningún step de identidad.
describe("runViaGateway — AC-6: ningún step de identidad/KYC compuesto (CD-7)", () => {
  it("T-A6.1: el body serializado no contiene 'kyc' ni 'identity', y las capacidades son sólo FX/payout", async () => {
    for (const capability of [FX_QUOTE_CAPABILITY, PAYOUT_CAPABILITY]) {
      const { fn, calls } = router();
      vi.stubGlobal("fetch", fn);
      await runViaGateway({ steps: [{ capability, input: { amountUsd: 400 } }] });
      const raw = calls[0]!.init!.body as string;
      expect(raw).not.toContain("kyc");
      expect(raw).not.toContain("identity");
      const body = composeBody(calls);
      expect(body.steps).toHaveLength(1);
      expect([FX_QUOTE_CAPABILITY, PAYOUT_CAPABILITY]).toContain(body.steps[0]!.capability);
    }
  });
});
