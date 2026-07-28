import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueSessionToken } from "../../../../src/infrastructure/kyc-auth";
import { GET } from "./route";

const SESSION = "sess-abc";
const DECISION_RAW = {
  status: "Approved",
  session_id: SESSION,
  id_verifications: [
    { document_number: "44556677", first_name: "Ana", date_of_birth: "1990-05-14" },
  ],
};

function req(headers: Record<string, string> = {}, id = SESSION): Request {
  const url = `http://localhost/api/kyc/decision?sessionId=${encodeURIComponent(id)}`;
  return new Request(url, { headers });
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.stubEnv("DIDIT_API_KEY", "test-key");
  vi.stubEnv("KYC_SESSION_SECRET", "test-secret-123");
  // Ambiente de Didit declarado (fail-closed): sin esto la ruta corta en 500 didit_env_misconfigured
  // antes del fetch. Mismo razonamiento que el stub de DIDIT_API_KEY de arriba: además de habilitar
  // el path, BLINDA contra un DIDIT_ENV=live exportado en la shell/CI, que mandaría estos tests a
  // resolver el host REAL de Didit. El fetch está mockeado, pero un test NUNCA debe poder resolver
  // producción.
  vi.stubEnv("DIDIT_ENV", "mock");
  vi.stubEnv("DIDIT_BASE_URL", "http://localhost:9999/didit-mock");
});

describe("GET /api/kyc/decision — guard-order + IDOR + masking (WKH-179)", () => {
  it("token válido → 200 + decision con documentNumber enmascarado (AC-1, AC-3)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => DECISION_RAW })));
    const token = issueSessionToken(SESSION);
    const res = await GET(req({ "x-kyc-token": token }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: { documentNumber: string; firstName: string; dateOfBirth: string } };
    expect(body.identity.documentNumber).toBe("****6677");
    expect(body.identity.firstName).toBe("Ana");
    expect(body.identity.dateOfBirth).toBe("1990-05-14");
  });

  it("sin x-kyc-token → 401, fetch NO llamado (AC-2, AC-7, CD-2)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("token errado → 401 mismo body que 'sin token', fetch NO llamado (CD-5, AC-7)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(req({ "x-kyc-token": "forged-token" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("token de OTRA sesión → 401 (IDOR: no sirve el token de sess-X para sess-Y)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const otherToken = issueSessionToken("sess-otra");
    const res = await GET(req({ "x-kyc-token": otherToken }));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sin DIDIT_API_KEY → 501, sin exigir token (AC-4)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "");
    const res = await GET(req());
    expect(res.status).toBe(501);
  });

  it("DIDIT_API_KEY presente pero sin KYC_SESSION_SECRET → 500 (CD-7)", async () => {
    vi.stubEnv("KYC_SESSION_SECRET", "");
    const res = await GET(req({ "x-kyc-token": "whatever" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
  });

  it("sin sessionId → 400 (preservado)", async () => {
    const url = "http://localhost/api/kyc/decision";
    const res = await GET(new Request(url));
    expect(res.status).toBe(400);
  });

  // ── Ambiente de Didit: fail-closed (elimina el default productivo) ──────────
  it("key válida + token válido + SIN DIDIT_ENV → 500 didit_env_misconfigured y NO se llama a Didit", async () => {
    vi.stubEnv("DIDIT_ENV", undefined);
    vi.stubEnv("DIDIT_BASE_URL", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "didit_env_misconfigured" });
    // EL assert que importa: sin ambiente declarado NO sale un request a Didit (ni a producción
    // ni a ningún lado). Antes de este fix, acá se fetcheaba el host PRODUCTIVO de Didit por
    // default. (El literal no se escribe acá a propósito: lo vigila el canario de didit-env.test.ts.)
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DIDIT_ENV=mock + DIDIT_BASE_URL → el fetch va al MOCK, nunca al host de Didit", async () => {
    // El `_url: string` NO es decorativo: sin parámetro declarado, `mock.calls` se tipa como `[]`
    // y `calls[0][0]` no compila con strict (TS2493).
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => DECISION_RAW }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(res.status).toBe(200);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe(`http://localhost:9999/didit-mock/v3/session/${SESSION}/decision/`);
    expect(url).not.toContain("didit.me");
  });
});
