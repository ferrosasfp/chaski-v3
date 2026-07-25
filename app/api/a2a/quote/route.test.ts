import { afterEach, describe, expect, it, vi } from "vitest";
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
// WKH-218 — modo de transporte "a2a-gateway": quote vía /discover + /compose del gateway.
// ─────────────────────────────────────────────────────────────────────────────
const GW = "https://gateway.example.com";
const KEY = "ak_secret";
const agent = { slug: "remit-corridor-fx", registry: "default", capabilities: ["fx-quote"], status: "active" };
const discoverOk = { agents: [agent], total: 1, registries: ["default"] };
const composeOk = { success: true, steps: [{ output: validResult }] };

/** Router que separa las llamadas al gateway (/discover, /compose) del fetch DIRECTO al agente. */
function gwRouter(opts: { discover?: () => unknown; compose?: () => unknown; discoverThrows?: boolean }) {
  const directCalls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    if (url.includes("/discover")) {
      if (opts.discoverThrows) throw new Error("network");
      return { ok: true, json: async () => opts.discover?.() ?? discoverOk };
    }
    if (url.includes("/compose")) return { ok: true, json: async () => opts.compose?.() ?? composeOk };
    directCalls.push(url); // {BASE}/api/agents/.../invoke — el punto-a-punto que NUNCA debe ocurrir
    return { ok: true, json: async () => ({ result: validResult }) };
  });
  return { fn, directCalls };
}

describe("POST /api/a2a/quote — modo a2a-gateway (WKH-218)", () => {
  function setGatewayEnv() {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gateway");
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", GW);
    vi.stubEnv("WASIAI_A2A_AGENT_KEY", KEY);
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE); // seteada, pero el gateway NO debe usarla (DT-A2A-9)
  }

  it("AC-1: gateway → fetch a {GW}/discover + {GW}/compose (NO {BASE}/api/agents/...); 200 { result }", async () => {
    setGatewayEnv();
    const { fn, directCalls } = gwRouter({});
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: validResult });
    const urls = fn.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u === `${GW}/discover`)).toBe(true);
    expect(urls.some((u) => u === `${GW}/compose`)).toBe(true);
    expect(directCalls).toHaveLength(0); // AC-4: jamás el punto-a-punto
  });

  it("AC-4/fail-closed: /discover inalcanzable ⇒ 502; NUNCA fetch al {BASE}/api/agents (directFetch not called)", async () => {
    setGatewayEnv();
    const { fn, directCalls } = gwRouter({ discoverThrows: true });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_unavailable" });
    expect(directCalls).not.toContain(`${BASE}/api/agents/remit-corridor-fx/invoke`);
    expect(directCalls).toHaveLength(0);
  });

  it("AC-4/fail-closed: /discover agents:[] (vacío) ⇒ 502; directFetch NUNCA llamado", async () => {
    setGatewayEnv();
    const { fn, directCalls } = gwRouter({ discover: () => ({ agents: [], total: 0, registries: [] }) });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_unavailable" });
    expect(directCalls).toHaveLength(0); // AC-4 ESTRELLA: cero fallback silencioso
  });

  it("gateway not_configured (falta WASIAI_A2A_GATEWAY_URL) ⇒ 501, sin fetch", async () => {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gateway");
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", "");
    vi.stubEnv("WASIAI_A2A_AGENT_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "a2a_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
});
