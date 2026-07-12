import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const BASE = "https://agents.example.com";

function req(payload: unknown): Request {
  return new Request("http://localhost/api/a2a/payout/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const validPayload = {
  quoteId: "cfx-1",
  amountUsd: 400,
  kycVerificationId: "v-1",
  kycPayoutAllowed: true,
  beneficiary: { name: "Mamá", country: "PE", method: "yape", destination: "999888777" },
  idempotencyKey: "r-1:cfx-1",
};

const validResult = {
  status: "submitted",
  payoutId: "po-1",
  deliveredLocal: null,
  txRef: null,
  reason: null,
  provenance: "remit-cashout-payout",
};

afterEach(() => vi.restoreAllMocks());

describe("POST /api/a2a/payout/submit — proxy server-only a remit-cashout-payout (WKH-186)", () => {
  it("sin REMIT_AGENTS_BASE_URL → 501 a2a_not_configured, fetch NOT called (CD-9)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req(validPayload));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "a2a_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("con base + agente ok → 200 { result }; idempotencyKey forwardeado tal cual (CD-10); NO ecoa base/PII", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE}/api/agents/remit-cashout-payout/invoke`);
      const fwd = JSON.parse((init as RequestInit).body as string);
      expect(fwd.idempotencyKey).toBe("r-1:cfx-1"); // CD-10 intacto
      return { ok: true, json: async () => ({ result: validResult }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req(validPayload));
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(BASE);
    // CD-5: la respuesta al cliente sólo lleva el result del agente (no ecoa el beneficiary del request).
    expect(raw).not.toContain("999888777");
    expect(JSON.parse(raw)).toEqual({ result: validResult });
  });

  it("agente !ok → 502 a2a_upstream_error (nunca 500)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const res = await POST(req(validPayload));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_upstream_error" });
  });

  it("shape inválido del agente → 502 a2a_bad_shape", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ result: { status: "weird" } }) })));
    const res = await POST(req(validPayload));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_bad_shape" });
  });

  it("fetch throw (timeout/DNS) → 502 a2a_unavailable, NO 500 crudo, no ecoa el beneficiary", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("aborted"); }));
    const res = await POST(req(validPayload));
    expect(res.status).toBe(502);
    const raw = await res.text();
    expect(raw).not.toContain("999888777");
    expect(JSON.parse(raw)).toEqual({ error: "a2a_unavailable" });
  });
});
