import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runViaGateway } from "./gateway-client";

const URL = "https://gateway.example.com";
const KEY = "ak_super_secret_key";

const agent = {
  slug: "remit-corridor-fx",
  registry: "default",
  capabilities: ["fx-quote"],
  status: "active",
};

const discoverOk = { agents: [agent], total: 1, registries: ["default"] };
const quoteOutput = { quoteId: "cfx-1", rate: 3.7 };
const composeOk = { success: true, steps: [{ output: quoteOutput }] };

/** Router de fetch por URL: separa /discover de /compose para asertar orden y headers. */
function router(opts: {
  discover?: () => { ok: boolean; body?: unknown; throws?: boolean };
  compose?: () => { ok: boolean; body?: unknown; throws?: boolean };
}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const which = url.includes("/discover") ? opts.discover : opts.compose;
    const r = which?.() ?? { ok: true, body: url.includes("/discover") ? discoverOk : composeOk };
    if (r.throws) throw new Error("network");
    return { ok: r.ok, json: async () => r.body ?? {} };
  });
  return { fn, calls };
}

beforeEach(() => {
  vi.stubEnv("WASIAI_A2A_GATEWAY_URL", URL);
  vi.stubEnv("WASIAI_A2A_AGENT_KEY", KEY);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runViaGateway — AC-3: discover ANTES de compose, usa slug/registry resueltos", () => {
  it("llama /discover (capabilities:[cap]) y luego /compose con slug/registry del agente resuelto", async () => {
    const { fn, calls } = router({});
    vi.stubGlobal("fetch", fn);
    const r = await runViaGateway({ capability: "fx-quote", input: { amountUsd: 400 } });
    expect(r).toEqual({ ok: true, result: quoteOutput });
    // Orden: discover primero, compose después.
    expect(calls[0]!.url).toBe(`${URL}/discover`);
    expect(calls[1]!.url).toBe(`${URL}/compose`);
    // discover body lleva la capability.
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      capabilities: ["fx-quote"],
      includeInactive: false,
    });
    // compose usa slug/registry RESUELTOS del discover, no un slug hardcodeado.
    const composeBody = JSON.parse(calls[1]!.init!.body as string);
    expect(composeBody.steps[0].agent).toBe("remit-corridor-fx");
    expect(composeBody.steps[0].registry).toBe("default");
  });

  it("expectedSlug desambigua el pick entre varios agentes", async () => {
    const two = {
      agents: [
        { ...agent, slug: "other-fx", registry: "r2" },
        { ...agent, slug: "remit-corridor-fx", registry: "default" },
      ],
      total: 2,
      registries: ["default", "r2"],
    };
    const { fn, calls } = router({ discover: () => ({ ok: true, body: two }) });
    vi.stubGlobal("fetch", fn);
    const r = await runViaGateway({
      capability: "fx-quote",
      expectedSlug: "remit-corridor-fx",
      input: {},
    });
    expect(r.ok).toBe(true);
    expect(JSON.parse(calls[1]!.init!.body as string).steps[0].agent).toBe("remit-corridor-fx");
  });

  it("input viaja TAL CUAL en el step (idempotencyKey intacto, CD-8)", async () => {
    const { fn, calls } = router({});
    vi.stubGlobal("fetch", fn);
    const input = { amountUsd: 400, idempotencyKey: "r-1:cfx-1", beneficiary: { destination: "999" } };
    await runViaGateway({ capability: "cashout-payout", input });
    expect(JSON.parse(calls[1]!.init!.body as string).steps[0].input).toEqual(input);
  });
});

describe("runViaGateway — AC-4: fail-closed exhaustivo", () => {
  it("/discover throw (timeout/DNS) ⇒ unavailable, /compose NUNCA llamado", async () => {
    const { fn, calls } = router({ discover: () => ({ ok: false, throws: true }) });
    vi.stubGlobal("fetch", fn);
    const r = await runViaGateway({ capability: "fx-quote", input: {} });
    expect(r).toEqual({ ok: false, code: "unavailable" });
    expect(calls.some((c) => c.url.includes("/compose"))).toBe(false);
  });

  it("/discover !ok (5xx) ⇒ unavailable", async () => {
    const { fn } = router({ discover: () => ({ ok: false }) });
    vi.stubGlobal("fetch", fn);
    expect(await runViaGateway({ capability: "fx-quote", input: {} })).toEqual({
      ok: false,
      code: "unavailable",
    });
  });

  it("/discover shape inválido (no agents array) ⇒ unavailable", async () => {
    const { fn } = router({ discover: () => ({ ok: true, body: { total: 0 } }) });
    vi.stubGlobal("fetch", fn);
    expect(await runViaGateway({ capability: "fx-quote", input: {} })).toEqual({
      ok: false,
      code: "unavailable",
    });
  });

  it("/discover agents:[] (vacío) ⇒ no_agent, NUNCA cae al slug hardcodeado (CD-5)", async () => {
    const { fn, calls } = router({
      discover: () => ({ ok: true, body: { agents: [], total: 0, registries: [] } }),
    });
    vi.stubGlobal("fetch", fn);
    const r = await runViaGateway({ capability: "fx-quote", input: {} });
    expect(r).toEqual({ ok: false, code: "no_agent" });
    expect(calls.some((c) => c.url.includes("/compose"))).toBe(false);
  });

  it("/compose !ok ⇒ unavailable", async () => {
    const { fn } = router({ compose: () => ({ ok: false }) });
    vi.stubGlobal("fetch", fn);
    expect(await runViaGateway({ capability: "fx-quote", input: {} })).toEqual({
      ok: false,
      code: "unavailable",
    });
  });

  it("/compose throw ⇒ unavailable (nunca propaga)", async () => {
    const { fn } = router({ compose: () => ({ ok: false, throws: true }) });
    vi.stubGlobal("fetch", fn);
    expect(await runViaGateway({ capability: "fx-quote", input: {} })).toEqual({
      ok: false,
      code: "unavailable",
    });
  });

  it("/compose success:false ⇒ unavailable", async () => {
    const { fn } = router({ compose: () => ({ ok: true, body: { success: false, steps: [] } }) });
    vi.stubGlobal("fetch", fn);
    expect(await runViaGateway({ capability: "fx-quote", input: {} })).toEqual({
      ok: false,
      code: "unavailable",
    });
  });

  it("/compose steps vacío ⇒ unavailable", async () => {
    const { fn } = router({ compose: () => ({ ok: true, body: { success: true, steps: [] } }) });
    vi.stubGlobal("fetch", fn);
    expect(await runViaGateway({ capability: "fx-quote", input: {} })).toEqual({
      ok: false,
      code: "unavailable",
    });
  });

  it("/compose output no-record ⇒ unavailable", async () => {
    const { fn } = router({
      compose: () => ({ ok: true, body: { success: true, steps: [{ output: "not-an-object" }] } }),
    });
    vi.stubGlobal("fetch", fn);
    expect(await runViaGateway({ capability: "fx-quote", input: {} })).toEqual({
      ok: false,
      code: "unavailable",
    });
  });
});

describe("runViaGateway — AC-5: gateway resuelve precio/x402 (x-a2a-key, sin firma)", () => {
  it("el request a /compose lleva x-a2a-key; el body NO contiene challenge/firma x402", async () => {
    const { fn, calls } = router({});
    vi.stubGlobal("fetch", fn);
    await runViaGateway({ capability: "cashout-payout", input: { amountUsd: 400 } });
    const compose = calls.find((c) => c.url.includes("/compose"))!;
    const headers = compose.init!.headers as Record<string, string>;
    expect(headers["x-a2a-key"]).toBe(KEY);
    const raw = compose.init!.body as string;
    expect(raw).not.toContain("x402");
    expect(raw).not.toContain("signature");
    expect(raw).not.toContain("challenge");
    // /discover NO lleva auth.
    const discover = calls.find((c) => c.url.includes("/discover"))!;
    expect((discover.init!.headers as Record<string, string>)["x-a2a-key"]).toBeUndefined();
  });
});

// El saldo de una Agent Key es POR RED (`budget[chainId]`). Sin `x-payment-chain` el gateway cobra
// en su red default y una key con fondos en OTRA red recibe 403 INSUFFICIENT_BUDGET. Medido en vivo
// 2026-07-26 contra el gateway de prod: key con 6.793 en avalanche-fuji, default kite-ozone-testnet,
// resultado 403 → el /api/a2a/quote de Chaski devolvía 502 a2a_unavailable.
describe("runViaGateway — selección de la red de cobro (x-payment-chain)", () => {
  it("con WASIAI_A2A_PAYMENT_CHAIN, /compose lleva el header con ese valor", async () => {
    vi.stubEnv("WASIAI_A2A_PAYMENT_CHAIN", "avalanche-fuji");
    const { fn, calls } = router({});
    vi.stubGlobal("fetch", fn);
    await runViaGateway({ capability: "fx-quote", input: { amountUsd: 25 } });
    const compose = calls.find((c) => c.url.includes("/compose"))!;
    expect((compose.init!.headers as Record<string, string>)["x-payment-chain"]).toBe(
      "avalanche-fuji",
    );
    // /discover es sin auth y no cobra: no debe llevarlo.
    const discover = calls.find((c) => c.url.includes("/discover"))!;
    expect((discover.init!.headers as Record<string, string>)["x-payment-chain"]).toBeUndefined();
  });

  it("sin la env, el header NO se manda (preserva el comportamiento previo: red default del gateway)", async () => {
    const { fn, calls } = router({});
    vi.stubGlobal("fetch", fn);
    await runViaGateway({ capability: "fx-quote", input: { amountUsd: 25 } });
    const compose = calls.find((c) => c.url.includes("/compose"))!;
    expect((compose.init!.headers as Record<string, string>)["x-payment-chain"]).toBeUndefined();
    // La auth sigue intacta: el fix no toca x-a2a-key.
    expect((compose.init!.headers as Record<string, string>)["x-a2a-key"]).toBe(KEY);
  });

  it("env en blanco se trata como ausente (no manda un header vacío)", async () => {
    vi.stubEnv("WASIAI_A2A_PAYMENT_CHAIN", "   ");
    const { fn, calls } = router({});
    vi.stubGlobal("fetch", fn);
    await runViaGateway({ capability: "fx-quote", input: { amountUsd: 25 } });
    const compose = calls.find((c) => c.url.includes("/compose"))!;
    expect((compose.init!.headers as Record<string, string>)["x-payment-chain"]).toBeUndefined();
  });
});

describe("runViaGateway — AC-7: creds server-only, no logueadas", () => {
  it("sin WASIAI_A2A_GATEWAY_URL ⇒ not_configured SIN fetch", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await runViaGateway({ capability: "fx-quote", input: {} })).toEqual({
      ok: false,
      code: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sin WASIAI_A2A_AGENT_KEY ⇒ not_configured SIN fetch", async () => {
    vi.stubEnv("WASIAI_A2A_AGENT_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await runViaGateway({ capability: "fx-quote", input: {} })).toEqual({
      ok: false,
      code: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("el GatewayResult de error NUNCA contiene la URL ni la Agent Key (opaco)", async () => {
    const { fn } = router({ discover: () => ({ ok: false }) });
    vi.stubGlobal("fetch", fn);
    const r = await runViaGateway({ capability: "fx-quote", input: { beneficiary: "PII-999" } });
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(URL);
    expect(serialized).not.toContain("PII-999");
  });
});
