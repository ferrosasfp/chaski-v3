import { afterEach, describe, expect, it, vi } from "vitest";
import { FX_DIRECT_AGENT_SLUG } from "../../../../src/infrastructure/a2a/gateway-client";
import { POST } from "./route";

const BASE = "https://agents.example.com";

function req(payload: unknown): Request {
  return new Request("http://localhost/api/a2a/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const validResult = {
  quoteId: "cfx-1",
  rate: 3.7,
  feeUsd: 0.5,
  netDeliveredLocal: 1478.15,
  etaMinutes: 30,
  expiresAt: "2026-07-09T18:10:00.000Z",
  provenance: "remit-corridor-fx",
};

afterEach(() => vi.restoreAllMocks());

describe("POST /api/a2a/quote — proxy server-only a remit-corridor-fx (WKH-186)", () => {
  it("sin REMIT_AGENTS_BASE_URL → 501 a2a_not_configured, fetch NOT called (CD-9)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" }));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "a2a_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("con base + agente ok → 200 { result }, NO ecoa la base (CD-9)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/api/agents/remit-corridor-fx/invoke`);
      return { ok: true, json: async () => ({ result: validResult }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" }));
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(BASE);
    expect(JSON.parse(raw)).toEqual({ result: validResult });
  });

  // El test de arriba clava el VALOR del slug; éste clava el CABLEADO. Son cosas distintas: el preview
  // de `/api/a2a/plan` dice "hoy corre X" leyendo `FX_DIRECT_AGENT_SLUG`, y esa afirmación sólo vale si
  // ESTA route llama a esa misma constante. Cuando eran dos literales sueltos, la pantalla terminó
  // nombrando `remit-corridor-fx-solana` mientras acá se llamaba a `remit-corridor-fx`.
  it("la URL sale de la MISMA constante que el preview publica como 'quién corre hoy'", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return { ok: true, json: async () => ({ result: validResult }) };
      }),
    );
    await POST(req({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" }));
    expect(urls).toEqual([`${BASE}/api/agents/${FX_DIRECT_AGENT_SLUG}/invoke`]);
  });

  it("agente !ok → 502 a2a_upstream_error (nunca 500)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_upstream_error" });
  });

  it("shape inválido del agente → 502 a2a_bad_shape", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ result: { quoteId: "x" } }) })));
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_bad_shape" });
  });

  it("WKH-198 AC-4: expiresAt no-parseable del agente → 502 a2a_bad_shape (CD-9)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { ...validResult, expiresAt: "not-a-date" } }),
    })));
    const res = await POST(req({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_bad_shape" });
  });

  it("fetch throw (timeout/DNS) → 502 a2a_unavailable, NO 500 crudo", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("aborted"); }));
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_unavailable" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hallazgo #75 — un RECHAZO del agente no es el agente caído.
//
// Medido en producción el 2026-08-04: `{"amountUsd":2}` y `{"amountUsd":50000}` devolvían los dos
// 502 `a2a_upstream_error`, cuando el agente había contestado 400 `fx_amount_below_minimum` y 400
// `fx_amount_above_maximum`. Cada `it` de acá abajo muere si esa causa vuelve a colapsar en el enum
// viejo, y el último candado muere si un fallo de infraestructura genuino deja de ser 502.
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/a2a/quote — rechazo del agente ≠ agente caído (hallazgo #75)", () => {
  /** Agente que contesta un no-2xx con el body de error dado. */
  function agentRejects(status: number, body: unknown) {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status, json: async () => body })),
    );
  }

  it("monto BAJO EL MÍNIMO ⇒ 400 a2a_quote_rejected + reason fx_amount_below_minimum (no 502)", async () => {
    agentRejects(400, { error: "fx_amount_below_minimum", minSendUsd: 5 });
    const res = await POST(req({ amountUsd: 2, destCountry: "PE", payoutMethod: "yape" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "a2a_quote_rejected",
      reason: "fx_amount_below_minimum",
    });
  });

  it("monto SOBRE EL TECHO ⇒ 400 a2a_quote_rejected + reason fx_amount_above_maximum (no 502)", async () => {
    agentRejects(400, { error: "fx_amount_above_maximum", maxSendUsd: 10000 });
    const res = await POST(req({ amountUsd: 50000, destCountry: "PE", payoutMethod: "yape" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "a2a_quote_rejected",
      reason: "fx_amount_above_maximum",
    });
  });

  // Las dos causas nuevas tienen que ser distinguibles ENTRE SÍ, no sólo del 502. Un mapeo que las
  // colapsara a un único enum de rechazo pasaría los dos `it` de arriba por separado si el enum
  // fuera el mismo; este las corre juntas y compara.
  it("mínimo y techo NO comparten enum (las dos causas se distinguen entre sí)", async () => {
    agentRejects(400, { error: "fx_amount_below_minimum" });
    const bajo = (await (await POST(req({ amountUsd: 2 }))).json()) as { reason?: string };
    agentRejects(400, { error: "fx_amount_above_maximum" });
    const alto = (await (await POST(req({ amountUsd: 50000 }))).json()) as { reason?: string };
    expect(bajo.reason).not.toBe(alto.reason);
  });

  // El agente rechaza pero con un enum que este código no conoce: sale el enum de FAMILIA, sin el
  // reason. La allow-list es lo que decide, y un string crudo del agente NUNCA llega al browser.
  it("rechazo con enum desconocido ⇒ 400 a2a_quote_rejected SIN reason (allow-list, cero eco crudo)", async () => {
    agentRejects(400, { error: "fx_corredor_en_mantenimiento", detalle: "texto libre del agente" });
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(400);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({ error: "a2a_quote_rejected" });
    expect(raw).not.toContain("fx_corredor_en_mantenimiento");
    expect(raw).not.toContain("texto libre");
  });

  it("el enum del rechazo se lee de `code`/`reason` además de `error` (el contrato de error no está vendoreado)", async () => {
    agentRejects(422, { code: "fx_amount_below_minimum" });
    expect(await (await POST(req({ amountUsd: 2 }))).json()).toEqual({
      error: "a2a_quote_rejected",
      reason: "fx_amount_below_minimum",
    });
    agentRejects(422, { reason: "fx_amount_above_maximum" });
    expect(await (await POST(req({ amountUsd: 99999 }))).json()).toEqual({
      error: "a2a_quote_rejected",
      reason: "fx_amount_above_maximum",
    });
  });

  it("rechazo con body ILEGIBLE ⇒ sigue siendo 400 (rechazo), nunca 502 ni 500 crudo", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => {
          throw new Error("<html>bad gateway page</html>");
        },
      })),
    );
    const res = await POST(req({ amountUsd: 2 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "a2a_quote_rejected" });
  });

  // ── CANDADO DE NO-REGRESIÓN ────────────────────────────────────────────────────────────────────
  // Un fallo de infraestructura GENUINO sigue siendo 502. Si alguien "arregla" la separación
  // mandando todo no-2xx por la rama de rechazo, esto se pone rojo: un 503 del agente NO es culpa
  // del monto que escribió la persona, y decirle "revisá tu pedido" la manda a corregir algo que
  // está bien. 401/403/404 están por la misma razón: son credenciales/ruta NUESTRAS, no su pedido.
  it.each([500, 502, 503, 504, 401, 403, 404, 429])(
    "CANDADO: status %i del agente ⇒ sigue siendo 502 a2a_upstream_error",
    async (status) => {
      agentRejects(status, { error: "fx_amount_below_minimum" }); // aunque el body mienta
      const res = await POST(req({ amountUsd: 2 }));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "a2a_upstream_error" });
    },
  );

  it("CANDADO: timeout/DNS (fetch throw) ⇒ sigue siendo 502 a2a_unavailable", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("aborted");
      }),
    );
    const res = await POST(req({ amountUsd: 2 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_unavailable" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WKH-218 + WKH-304 — modo de transporte "a2a-gateway": el quote se pide por CAPACIDAD a
// POST /compose y el gateway resuelve. Ya NO hay /discover ni slug esperado: los tests que
// asertaban la llamada a /discover se portaron al contrato nuevo (no se borró ningún caso).
// ─────────────────────────────────────────────────────────────────────────────
const GW = "https://gateway.example.com";
const KEY = "ak_secret";
const composeOk = { success: true, steps: [{ output: validResult }] };

/** Router que separa la llamada al gateway (/compose) del fetch DIRECTO al agente.
 *  directCalls > 0 ⇒ hubo fallback punto-a-punto (prohibido, CD-1). */
function gwRouter(
  opts: {
    compose?: () => unknown;
    status?: number;
    composeThrows?: boolean;
    captureCompose?: (init?: RequestInit) => void;
  } = {},
) {
  const directCalls: string[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/compose")) {
      if (opts.composeThrows) throw new Error("network");
      opts.captureCompose?.(init);
      const status = opts.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => opts.compose?.() ?? composeOk,
      };
    }
    directCalls.push(url); // {BASE}/api/agents/.../invoke — el punto-a-punto que NUNCA debe ocurrir
    return { ok: true, status: 200, json: async () => ({ result: validResult }) };
  });
  return { fn, directCalls };
}

describe("POST /api/a2a/quote — modo a2a-gateway (WKH-218 / WKH-304)", () => {
  function setGatewayEnv() {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gateway");
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", GW);
    vi.stubEnv("WASIAI_A2A_AGENT_KEY", KEY);
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE); // seteada, pero el gateway NO debe usarla (DT-A2A-9)
  }

  // (portado del caso "AC-1: /discover + /compose") — ahora el único request es /compose y lo que
  // viaja es la CAPACIDAD, no un nombre de agente.
  it("AC-1: gateway → ÚNICO fetch a {GW}/compose con la capability (cero /discover, cero {BASE}/api/agents)", async () => {
    setGatewayEnv();
    // Ausencia REAL de la env (stubEnv(…, undefined) la BORRA) ⇒ default del código (CD-14). Ojo:
    // el `??` de la route sólo cae al default con la env ausente, no con la env en "" — por eso el
    // stub es undefined y no "" (y por eso el test es determinista aunque la shell la exporte).
    vi.stubEnv("WASIAI_A2A_FX_CAPABILITY", undefined);
    let composeInit: RequestInit | undefined;
    const { fn, directCalls } = gwRouter({ captureCompose: (init) => (composeInit = init) });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: validResult });

    const urls = fn.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual([`${GW}/compose`]);
    expect(urls.some((u) => u.includes("/discover"))).toBe(false);
    expect(directCalls).toHaveLength(0); // CD-1: jamás el punto-a-punto

    const step = JSON.parse(composeInit!.body as string).steps[0];
    expect(step.capability).toBe("remittance-fx-quote"); // el default REAL del catálogo (M8)
    expect(step).not.toHaveProperty("agent"); // M5: nunca el nombre del agente
    // WKH-313: el leg de FX pide el carril de estreno, y el piso viaja CON él. `allow_trial` solo
    // seria letra muerta: el gateway solo lo lee dentro del bloque de `min_reputation`.
    expect(step.constraints).toEqual({ min_reputation: 2, allow_trial: true });
    expect(step.input).toEqual({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" });
  });

  // Trazabilidad: el gateway dice a quién eligió y hasta ahora la respuesta lo tiraba. Si mañana el
  // descubrimiento puede traer cualquier agente, no poder decir CUÁL cotizó es no tener traza.
  it("el 200 informa QUÉ agente cotizó (slug/registry/capability/carril), sin URL ni PII", async () => {
    setGatewayEnv();
    const { fn } = gwRouter({
      compose: () => ({
        success: true,
        steps: [
          {
            output: validResult,
            agent: {
              slug: "remit-corridor-fx",
              registry: "WasiAI",
              invokeUrl: "https://interno.example.com/invoke", // NO debe salir
              trial: { granted: true, under_min_reputation: 2 },
            },
            resolvedFrom: { capability: "remittance-fx-quote" },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" }));

    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("interno.example.com");
    expect(JSON.parse(raw)).toEqual({
      result: validResult,
      agent: {
        slug: "remit-corridor-fx",
        registry: "WasiAI",
        capability: "remittance-fx-quote",
        trial: true,
      },
    });
  });

  // Un agente ilegible no rompe la cotización: la clave simplemente no viaja y quien la lea sabe
  // que no sabemos. Lo prohibido es fabricar un agente para llenar el campo.
  it("agente ilegible ⇒ el 200 NO trae la clave agent (y el quote sigue siendo válido)", async () => {
    setGatewayEnv();
    const { fn } = gwRouter({
      compose: () => ({ success: true, steps: [{ output: validResult, agent: { registry: "X" } }] }),
    });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ amountUsd: 400 }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: validResult });
  });

  it("WASIAI_A2A_FX_CAPABILITY override manda sobre el default del código", async () => {
    setGatewayEnv();
    vi.stubEnv("WASIAI_A2A_FX_CAPABILITY", "remittance-fx-quote-v2");
    let composeInit: RequestInit | undefined;
    const { fn } = gwRouter({ captureCompose: (init) => (composeInit = init) });
    vi.stubGlobal("fetch", fn);
    await POST(req({ amountUsd: 400 }));
    expect(JSON.parse(composeInit!.body as string).steps[0].capability).toBe(
      "remittance-fx-quote-v2",
    );
  });

  // (portado de "/discover inalcanzable ⇒ 502")
  it("AC-4/fail-closed: /compose inalcanzable (throw) ⇒ 502 a2a_unavailable; cero punto-a-punto", async () => {
    setGatewayEnv();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fn, directCalls } = gwRouter({ composeThrows: true });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_unavailable" });
    expect(directCalls).not.toContain(`${BASE}/api/agents/remit-corridor-fx/invoke`);
    expect(directCalls).toHaveLength(0);
  });

  // (portado de "/discover agents:[] (vacío) ⇒ 502") — el vacío del discover ya no existe: hoy el
  // "no hay agente para esa capacidad" es un 422 no_agent_match del gateway, y sigue sin fallback.
  it("AC-2/AC-4 ESTRELLA: 422 no_agent_match ⇒ 502 opaco, cero punto-a-punto, y el detalle SÓLO al log", async () => {
    setGatewayEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fn, directCalls } = gwRouter({
      status: 422,
      compose: () => ({
        error: "no agent matched capability remittance-fx-quote",
        code: "no_agent_match",
        reason: "no_candidates",
        step: 0,
      }),
    });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json).toEqual({ error: "a2a_unavailable" });
    expect(Object.keys(json)).toEqual(["error"]); // CD-8: cero eco del gateway en el body
    expect(directCalls).toHaveLength(0); // cero fallback silencioso
    // CD-9/AC-2: el operador SÍ puede distinguir "no hay agente" de "gateway caído", pero por log.
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain("no_agent_match");
    expect(logged).toContain("no_candidates");
    expect(logged).not.toContain("no agent matched capability"); // el message del gateway NO se loguea
  });

  it("gateway not_configured (falta WASIAI_A2A_GATEWAY_URL) ⇒ 501, sin fetch", async () => {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gateway");
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", "");
    vi.stubEnv("WASIAI_A2A_AGENT_KEY", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "a2a_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // R-1 hecho test: sin expectedSlug puede ganar OTRO agente el ranking. Lo que protege NO es el
  // nombre del agente, es el shape: un quote que no valida corta con 502 antes de llegar al cliente.
  it("gateway shape inválido (compose output no-quote) ⇒ 502 a2a_bad_shape", async () => {
    setGatewayEnv();
    const { fn } = gwRouter({ compose: () => ({ success: true, steps: [{ output: { quoteId: "x" } }] }) });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_bad_shape" });
  });

  it("AC-6: flag='a2a' (no gateway) ⇒ punto-a-punto byte-idéntico ({BASE}/api/agents/remit-corridor-fx/invoke)", async () => {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a"); // no gateway
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/api/agents/remit-corridor-fx/invoke`); // el path de siempre
      return { ok: true, json: async () => ({ result: validResult }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: validResult });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // T-A4.1 — byte-identidad flag OFF: aunque las envs del gateway estén SETEADAS, con el flag ≠
  // "a2a-gateway" el gateway se IGNORA por completo (CD-15). "construye, no enciende".
  // El assert es sobre /compose: con /discover borrado, asertar que NO se llama a /discover pasa
  // trivialmente y deja de proteger nada.
  it.each(["fallback", "a2a", undefined])(
    "T-A4.1: flag=%s + WASIAI_A2A_* seteadas ⇒ gateway IGNORADO (fetch al {BASE}/api/agents/...)",
    async (flag) => {
      if (flag === undefined) vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "");
      else vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", flag);
      vi.stubEnv("WASIAI_A2A_GATEWAY_URL", GW); // seteadas, pero NO deben usarse
      vi.stubEnv("WASIAI_A2A_AGENT_KEY", KEY);
      vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
      const { fn, directCalls } = gwRouter({});
      vi.stubGlobal("fetch", fn);
      const res = await POST(req({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" }));
      expect(res.status).toBe(200);
      const urls = fn.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes("/compose"))).toBe(false); // gateway NUNCA tocado
      expect(directCalls).toEqual([`${BASE}/api/agents/remit-corridor-fx/invoke`]);
    },
  );
});
