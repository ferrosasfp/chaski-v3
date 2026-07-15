import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  address: "0xSender", // WKH-202: el guard lo exige. SETUP del fixture, no un assert (AC-6 intacto).
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

// WKH-202 §4.7: los tests de WKH-186 no stubean DIDIT_API_KEY/VERCEL_ENV. Con el guard nuevo su
// resultado pasaría a depender del shell ambiente (vitest no carga .env.local, pero un DIDIT_API_KEY
// exportado en la shell/CI haría fetchear Didit → rojo intermitente). Esto es SETUP, no asserts:
// los 7 de WKH-186 caen en simulated_dev + VERCEL_ENV="" → autorizado → el único fetch que ven sus
// mocks sigue siendo el del agente.
beforeEach(() => {
  vi.stubEnv("DIDIT_API_KEY", ""); // → rama simulated_dev, sin fetch a Didit
  vi.stubEnv("VERCEL_ENV", ""); // → no-prod y no-Vercel: la simulación se acepta (DT-5 no dispara)
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs(); // restoreAllMocks NO deshace stubEnv
});

// Despacha por URL y registra las llamadas AL AGENTE por separado, para que
// expect(agentCalls).toHaveLength(0) pruebe literalmente "el agente NUNCA fue invocado" (AC-1/2/5).
function fetchRouter(opts: { didit?: () => unknown; diditThrows?: boolean }) {
  const agentCalls: string[] = [];
  const fn = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("/v3/session/")) {
      if (opts.diditThrows) throw new Error("The operation was aborted due to timeout");
      return { ok: true, json: async () => opts.didit?.() ?? {} };
    }
    agentCalls.push(url);
    return { ok: true, json: async () => ({ result: validResult }) };
  });
  return { fn, agentCalls };
}

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

  it("MNR-C: result { status:'settled', payoutId:null } → 502 a2a_bad_shape (alineado con el gateway)", async () => {
    // Antes la route lo aceptaba (validador divergente del gateway isValidPayoutShape). payoutId null
    // SOLO válido en failed/blocked: un settled/submitted sin payoutId no es trackeable → bad shape.
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { status: "settled", payoutId: null, deliveredLocal: 1478.15, txRef: "0x", reason: null, provenance: "p" } }),
    })));
    const res = await POST(req(validPayload));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_bad_shape" });
  });

  it("MNR-C: result { status:'submitted', payoutId:null } → 502 a2a_bad_shape (submitted también requiere payoutId)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { status: "submitted", payoutId: null, deliveredLocal: null, txRef: null, reason: null, provenance: "p" } }),
    })));
    const res = await POST(req(validPayload));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_bad_shape" });
  });

  it("MNR-C: result { status:'failed', payoutId:null } → 200 (payoutId null SÍ válido en failed)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    const failedResult = { status: "failed", payoutId: null, deliveredLocal: null, txRef: null, reason: "partner_down", provenance: "p" };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ result: failedResult }) })));
    const res = await POST(req(validPayload));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: failedResult });
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

describe("POST /api/a2a/payout/submit — enforcement server-side del payout (WKH-202)", () => {
  it("sin address → 400 payout_invalid_request; NINGÚN fetch (AC-1)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ ...validPayload, address: undefined }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "payout_invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled(); // ni Didit ni el agente
  });

  it("sin kycVerificationId → 400 payout_invalid_request; NINGÚN fetch (AC-1)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ ...validPayload, kycVerificationId: undefined }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "payout_invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled(); // ni Didit ni el agente
  });

  // BLQ-BAJO-1 (AR): `req.json()` RESUELVE con `null` ante el body literal `null` (no rechaza) → el
  // .catch() no disparaba y el acceso al campo tiraba un TypeError FUERA del try → 500 crudo. Los
  // otros no-record ([], 123, "str") ya daban 400 (acceso a campo sobre ellos = undefined); se
  // incluyen igual para fijar el contrato: NINGÚN body no-record llega al fetch.
  it.each([
    ["null", null],
    ["array", []],
    ["number", 123],
    ["string", "str"],
  ])("body no-record (%s) → 400 payout_invalid_request; NINGÚN fetch (AC-1)", async (_label, payload) => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req(payload));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "payout_invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled(); // ni Didit ni el agente
  });

  // MNR-4 (CR): los 8 tests de WKH-186 que llegan al forward pasan por simulated_dev, rama que DT-5
  // rechaza en todo scope de Vercel → la composición "autorizar → forwardear" sólo estaba cubierta
  // por el camino que NUNCA corre en prod. Este test cubre el que SÍ corre: key real + Approved +
  // vendor_data == address → forward.
  it("forward path REAL (key + Approved + ownership ok) → 200 + agente invocado 1 vez (AC-4)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    const { fn, agentCalls } = fetchRouter({
      didit: () => ({ status: "Approved", session_id: "v-1", vendor_data: "0xSender" }),
    });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req(validPayload)); // address: "0xSender"
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: validResult });
    expect(agentCalls).toHaveLength(1); // el agente SÍ se invoca cuando la autoridad REAL autoriza
  });

  it("Didit Declined → 403 payout_not_authorized; agente NO invocado (AC-2)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    const { fn, agentCalls } = fetchRouter({ didit: () => ({ status: "Declined", session_id: "v-1" }) });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req(validPayload));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_not_authorized" });
    expect(agentCalls).toHaveLength(0);
  });

  it("ownership mismatch (vendor_data ≠ address) → 403; agente NO invocado (AC-2)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    const { fn, agentCalls } = fetchRouter({
      didit: () => ({ status: "Approved", session_id: "v-1", vendor_data: "0xOtherWallet" }),
    });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req(validPayload)); // address: "0xSender"
    expect(res.status).toBe(403);
    // CD-12 (no-oracle): MISMO code que Declined — el endpoint no revela POR QUÉ rechazó.
    expect(await res.json()).toEqual({ error: "payout_not_authorized" });
    expect(agentCalls).toHaveLength(0);
  });

  it("fetch a Didit throws (timeout) → 502 payout_authority_unavailable; agente NO invocado (AC-5)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    const { fn, agentCalls } = fetchRouter({ diditThrows: true });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req(validPayload));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "payout_authority_unavailable" });
    expect(agentCalls).toHaveLength(0);
  });

  it("DT-5: VERCEL_ENV=preview + sin DIDIT_API_KEY → 503; agente NO invocado (AC-5)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubEnv("DIDIT_API_KEY", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    const res = await POST(req(validPayload));
    // La simulación NO autoriza un payout en ningún scope de Vercel (fail-open real, CD-4).
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "payout_authority_unavailable" });
    expect(agentCalls).toHaveLength(0);
  });
});
