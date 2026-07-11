import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueSessionToken, verifySessionToken } from "./kyc-auth";

afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.stubEnv("KYC_SESSION_SECRET", "test-secret-123"));

describe("kyc-auth — HMAC session token (WKH-179 B1)", () => {
  it("issue es determinístico para el mismo sessionId + secreto", () => {
    expect(issueSessionToken("sess-1")).toBe(issueSessionToken("sess-1"));
  });

  it("distinto sessionId → distinto token", () => {
    expect(issueSessionToken("sess-1")).not.toBe(issueSessionToken("sess-2"));
  });

  it("verify acepta el token emitido (timing-safe)", () => {
    const tok = issueSessionToken("sess-1");
    expect(verifySessionToken("sess-1", tok)).toBe(true);
  });

  it("verify rechaza un token de otra sesión", () => {
    const tok = issueSessionToken("sess-2");
    expect(verifySessionToken("sess-1", tok)).toBe(false);
  });

  it("verify rechaza un token de distinta longitud SIN throw (CD-9)", () => {
    expect(() => verifySessionToken("sess-1", "short")).not.toThrow();
    expect(verifySessionToken("sess-1", "short")).toBe(false);
    expect(verifySessionToken("sess-1", "")).toBe(false);
  });

  it("verify devuelve false si falta el secreto (defensa; la ruta corta con 500)", () => {
    vi.stubEnv("KYC_SESSION_SECRET", "");
    expect(verifySessionToken("sess-1", "anything")).toBe(false);
  });
});
