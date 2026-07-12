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

  it("fetch throw (timeout/DNS) → 502 a2a_unavailable, NO 500 crudo", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("aborted"); }));
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_unavailable" });
  });
});
