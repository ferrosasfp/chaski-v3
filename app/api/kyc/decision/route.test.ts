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
});
