import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock del helper de rate-limit → controlamos el veredicto sin Upstash real.
const { rlMock } = vi.hoisted(() => ({ rlMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/rate-limit", () => ({ checkKycRateLimit: rlMock }));

import { POST } from "./route";

const DIDIT_OK = { session_id: "s1", url: "https://verify.didit.me/session/s1", session_token: "didit-tok" };

function req(body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/kyc/session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
    body: JSON.stringify(body),
  });
}

function reqWithHeaders(headers: Record<string, string>, body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/kyc/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  rlMock.mockReset();
  rlMock.mockResolvedValue({ ok: true });
  vi.stubEnv("DIDIT_API_KEY", "test-key");
  vi.stubEnv("DIDIT_WORKFLOW_ID", "wf-1");
  vi.stubEnv("KYC_SESSION_SECRET", "test-secret-123");
  vi.stubEnv("KYC_CALLBACK_BASE_URL", "");
  // Ambiente de Didit declarado (fail-closed): sin esto la ruta corta en 500 didit_env_misconfigured
  // antes del rate-limit. Además BLINDA contra un DIDIT_ENV=live exportado en la shell/CI: un test
  // jamás debe poder resolver el host REAL de Didit (crea verificaciones con PII).
  vi.stubEnv("DIDIT_ENV", "mock");
  vi.stubEnv("DIDIT_BASE_URL", "http://localhost:9999/didit-mock");
});

describe("POST /api/kyc/session — guard-order + rate-limit + callback + token (WKH-179)", () => {
  it("sin DIDIT_API_KEY → 501, rate-limit NO invocado (AC-4)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req());
    expect(res.status).toBe(501);
    expect(rlMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DIDIT_API_KEY sin KYC_SESSION_SECRET → 500 (CD-7)", async () => {
    vi.stubEnv("KYC_SESSION_SECRET", "");
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
  });

  it("rate-limit consultado ANTES del fetch a Didit (AC-5, CD-2)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => DIDIT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    await POST(req({ vendorData: "0xabc" }));
    expect(rlMock).toHaveBeenCalledWith({ ip: "9.9.9.9", address: "0xabc" });
  });

  it("IP viene de x-vercel-forwarded-for (fuente confiable de Vercel); XFF malicioso se ignora (MNR-1)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => DIDIT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    // Atacante intenta forjar el leftmost del XFF; Vercel inyecta la IP real en x-vercel-forwarded-for.
    await POST(
      reqWithHeaders(
        { "x-vercel-forwarded-for": "5.5.5.5", "x-forwarded-for": "1.1.1.1, 6.6.6.6" },
        { vendorData: "0xabc" },
      ),
    );
    expect(rlMock).toHaveBeenCalledWith({ ip: "5.5.5.5", address: "0xabc" });
  });

  it("IP cae a x-real-ip cuando no hay x-vercel-forwarded-for; XFF forjado no la cambia (MNR-1)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => DIDIT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    await POST(reqWithHeaders({ "x-real-ip": "7.7.7.7", "x-forwarded-for": "1.2.3.4" }));
    expect(rlMock).toHaveBeenCalledWith({ ip: "7.7.7.7", address: undefined });
  });

  it("sin headers de Vercel → XFF como último recurso toma el valor MÁS A LA DERECHA, no el leftmost (MNR-1)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => DIDIT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    // 1.1.1.1 lo puede forjar el cliente; 8.8.8.8 (rightmost) lo agrega el proxy de confianza.
    await POST(reqWithHeaders({ "x-forwarded-for": "1.1.1.1, 8.8.8.8" }));
    expect(rlMock).toHaveBeenCalledWith({ ip: "8.8.8.8", address: undefined });
  });

  it("limiter ok:false → 429 + Retry-After, fetch NO llamado (AC-6, AC-7)", async () => {
    rlMock.mockResolvedValue({ ok: false, retryAfter: 42 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ vendorData: "0xabc" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Upstash ausente (unavailable) → 503 fail-closed, fetch NO llamado (AC-6)", async () => {
    rlMock.mockResolvedValue({ ok: false, unavailable: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "rate_limit_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("body.callback IGNORADO; a Didit va el callback server-side (AC-8, AC-9, M6)", async () => {
    vi.stubEnv("KYC_CALLBACK_BASE_URL", "https://chaski.app");
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      void init;
      return { ok: true, json: async () => DIDIT_OK };
    });
    vi.stubGlobal("fetch", fetchMock);
    await POST(req({ callback: "http://evil.com", vendorData: "0xabc" }));
    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(sentBody.callback).toBe("https://chaski.app/kyc/callback");
    expect(JSON.stringify(sentBody)).not.toContain("evil");
  });

  it("sin KYC_CALLBACK_BASE_URL → callback undefined (nunca body.callback, AC-9)", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      void init;
      return { ok: true, json: async () => DIDIT_OK };
    });
    vi.stubGlobal("fetch", fetchMock);
    await POST(req({ callback: "http://evil.com" }));
    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(sentBody.callback).toBeUndefined();
    expect(JSON.stringify(sentBody)).not.toContain("evil");
  });

  it("éxito → 200 con authToken (nuestro) + sessionToken (de Didit), distintos (CD-10)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => DIDIT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ vendorData: "0xabc" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; sessionToken: string; authToken: string };
    expect(body.sessionId).toBe("s1");
    expect(body.sessionToken).toBe("didit-tok");
    expect(typeof body.authToken).toBe("string");
    expect(body.authToken).not.toBe(body.sessionToken);
  });

  // ── Ambiente de Didit: fail-closed (elimina el default productivo) ──────────
  it("key + workflow válidos + SIN DIDIT_ENV → 500 didit_env_misconfigured y NO se crea sesión en Didit", async () => {
    vi.stubEnv("DIDIT_ENV", undefined);
    vi.stubEnv("DIDIT_BASE_URL", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ vendorData: "0xabc" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "didit_env_misconfigured" });
    // EL assert que importa: esta ruta CREA verificaciones de identidad. Sin ambiente declarado no
    // sale ni un request. Antes de este fix, acá se creaba una sesión REAL en producción de Didit.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DIDIT_ENV=mock + DIDIT_BASE_URL → el fetch va al MOCK, nunca al host de Didit", async () => {
    // El `_url: string` NO es decorativo: sin parámetro declarado, `mock.calls` se tipa como `[]`
    // y `calls[0][0]` no compila con strict (TS2493).
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => DIDIT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ vendorData: "0xabc" }));
    expect(res.status).toBe(200);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe("http://localhost:9999/didit-mock/v3/session/");
    expect(url).not.toContain("didit.me");
  });
});
