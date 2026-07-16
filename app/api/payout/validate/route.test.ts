import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpPayoutAuthorityGateway } from "../../../../src/infrastructure/payout/payout-authority-gateway";

// WKH-205: el rate-limit corre cuando DIDIT_API_KEY está seteado. Los tests de autoridad no fijan
// Upstash env (fail-closed → 503) → mockeamos checkRouteRateLimit a { ok:true } por default y lo
// overrideamos en los tests AC-4 (!ok → 429) / AC-6 (unavailable → 503). clientIp/PAYOUT_VALIDATE_RL
// se conservan reales (rest-spread del módulo original).
const { checkRouteRateLimitMock } = vi.hoisted(() => ({ checkRouteRateLimitMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/rate-limit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/infrastructure/rate-limit")>();
  return { ...actual, checkRouteRateLimit: checkRouteRateLimitMock };
});

import { POST } from "./route";

const VID = "sess-abc";
const ADDR = "0xSender";

function req(payload: unknown): Request {
  return new Request("http://localhost/api/payout/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function diditOk(raw: Record<string, unknown>) {
  return vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    json: async () => raw,
  }));
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  // Default: rate-limit permite el paso (los tests de autoridad no lo ejercitan).
  checkRouteRateLimitMock.mockReset();
  checkRouteRateLimitMock.mockResolvedValue({ ok: true });
});

describe("POST /api/payout/validate — autoridad server-side (WKH-180)", () => {
  // ── Guard 1: sin key ────────────────────────────────────────────────────────
  it("VERCEL_ENV=production + sin key → 503 authorized:false kyc_authority_unavailable, fetch NOT called (AC-3, CD-4)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "");
    vi.stubEnv("VERCEL_ENV", "production");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_authority_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sin VERCEL_ENV + sin key → 200 authorized:true simulated_dev, fetch NOT called (AC-4)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "");
    vi.stubEnv("VERCEL_ENV", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: true, reason: "simulated_dev" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Guard 2: formato → COLAPSA a kyc_not_authorized/200 (WKH-205 AC-1, oráculo cerrado) ─────────
  it("verificationId '' (con key) → 200 kyc_not_authorized (colapsado), fetch NOT called (AC-1/AC-5)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ verificationId: "", address: ADDR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_not_authorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verificationId ausente (con key) → 200 kyc_not_authorized (colapsado), fetch NOT called (AC-1/AC-5)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ address: ADDR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_not_authorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Didit real ──────────────────────────────────────────────────────────────
  it("key + Didit Approved → 200 authorized:true (AC-1)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    vi.stubGlobal("fetch", diditOk({ status: "Approved", session_id: VID }));
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: true });
  });

  it("key + Didit Declined → 200 kyc_not_authorized (colapsado, oráculo cerrado) (AC-1)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    vi.stubGlobal("fetch", diditOk({ status: "Declined", session_id: VID }));
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_not_authorized" });
  });

  it("key + Didit !res.ok → 502 kyc_reauth_failed NO colapsa (técnico preservado) (AC-2)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    // AC-2: reason técnico (502) NO se colapsa a kyc_not_authorized ni a 200; conserva su forma.
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_reauth_failed" });
  });

  it("key + Didit fetch throws (timeout) → 502 authorized:false kyc_reauth_failed, NO 500 crudo (MNR-A fail-closed)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("The operation was aborted due to timeout"); }));
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_reauth_failed" });
  });

  // ── Ownership (vendor_data) ──────────────────────────────────────────────────
  it("vendor_data mismatch vs address → 200 kyc_not_authorized (colapsado) (AC-1 ownership)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    vi.stubGlobal("fetch", diditOk({ status: "Approved", session_id: VID, vendor_data: "0xOtherWallet" }));
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_not_authorized" });
  });

  it("vendor_data match (case-insensitive) → true", async () => {
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    vi.stubGlobal("fetch", diditOk({ status: "Approved", session_id: VID, vendor_data: "0xSENDER" }));
    const res = await POST(req({ verificationId: VID, address: "0xsender" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: true });
  });

  it("vendor_data ausente → true (residual documentado)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    vi.stubGlobal("fetch", diditOk({ status: "Approved", session_id: VID }));
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: true });
  });

  // ── Cero PII / key server-only ───────────────────────────────────────────────
  it("respuesta nunca contiene identity/documentNumber ni el API key (AC-7, CD-A8)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "super-secret-key");
    vi.stubGlobal(
      "fetch",
      diditOk({
        status: "Approved",
        session_id: VID,
        vendor_data: ADDR,
        id_verifications: [{ document_number: "44556677", first_name: "Ana" }],
      }),
    );
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    const raw = await res.text();
    expect(raw).not.toContain("identity");
    expect(raw).not.toContain("documentNumber");
    expect(raw).not.toContain("44556677");
    expect(raw).not.toContain("super-secret-key");
    expect(JSON.parse(raw)).toEqual({ authorized: true });
  });

  // ── WKH-205 AC-1: oráculo cerrado — los 3 reasons subject son INDISTINGUIBLES ──────────────────
  it("AC-1: Declined / ownership-mismatch / verificationId-inválido → body+status BYTE-IDÉNTICOS", async () => {
    vi.stubEnv("DIDIT_API_KEY", "test-key");

    // (1) Didit Declined
    vi.stubGlobal("fetch", diditOk({ status: "Declined", session_id: VID }));
    const declined = await POST(req({ verificationId: VID, address: ADDR }));
    const declinedBody = await declined.json();

    // (2) ownership mismatch (Approved pero vendor_data != address)
    vi.stubGlobal("fetch", diditOk({ status: "Approved", session_id: VID, vendor_data: "0xOtherWallet" }));
    const mismatch = await POST(req({ verificationId: VID, address: ADDR }));
    const mismatchBody = await mismatch.json();

    // (3) verificationId inválido (formato) — sin fetch
    const invalid = await POST(req({ verificationId: "", address: ADDR }));
    const invalidBody = await invalid.json();

    // Mismo status y mismo body para los 3 → un caller no autenticado no puede distinguir el estado KYC ajeno.
    expect(declined.status).toBe(200);
    expect(mismatch.status).toBe(200);
    expect(invalid.status).toBe(200);
    expect(declinedBody).toEqual({ authorized: false, reason: "kyc_not_authorized" });
    expect(declinedBody).toEqual(mismatchBody);
    expect(mismatchBody).toEqual(invalidBody);
  });

  // ── WKH-205 AC-3: body no-record → nunca 500 (isRecord + resolvePayoutAuthority guard), sin Didit ──
  it.each<[string, unknown]>([
    ["null", null],
    ["array", []],
    ["number", 123],
    ["string", "str"],
  ])("AC-3: body no-record (%s) con key → nunca 500 (200 kyc_not_authorized), fetch NOT called", async (_label, payload) => {
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req(payload));
    expect(res.status).not.toBe(500);
    // body no-record → verificationId/address "" → invalid_verification_id → colapsa a kyc_not_authorized/200.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_not_authorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── WKH-205 AC-4: rate-limit excedido → 429, autoridad/Didit NO consultadas ───────────────────
  it("AC-4: rate-limit !ok (con key) → 429, resolvePayoutAuthority/fetch NOT called", async () => {
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    checkRouteRateLimitMock.mockResolvedValue({ ok: false, retryAfter: 30 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_rate_limited" });
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── WKH-205 AC-6: Upstash ausente en entorno vivo → 503 fail-closed ───────────────────────────
  it("AC-6: rate-limit unavailable (con key) → 503 kyc_authority_unavailable fail-closed, fetch NOT called", async () => {
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    checkRouteRateLimitMock.mockResolvedValue({ ok: false, unavailable: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_authority_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("HttpPayoutAuthorityGateway — adapter fail-closed (WKH-180, CD-A4)", () => {
  it("fetch throw/red-caída → { authorized:false, kyc_authority_error }", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const gw = new HttpPayoutAuthorityGateway();
    const r = await gw.authorize({ verificationId: VID, address: ADDR });
    expect(r).toEqual({ authorized: false, reason: "kyc_authority_error" });
  });

  it("body sin authorized boolean → { authorized:false, kyc_authority_error }", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ foo: "bar" }) })));
    const gw = new HttpPayoutAuthorityGateway();
    const r = await gw.authorize({ verificationId: VID, address: ADDR });
    expect(r).toEqual({ authorized: false, reason: "kyc_authority_error" });
  });

  it("propaga { authorized:true } de la ruta (simulated_dev) → demo sigue OK", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ authorized: true, reason: "simulated_dev" }) })));
    const gw = new HttpPayoutAuthorityGateway();
    const r = await gw.authorize({ verificationId: VID, address: ADDR });
    expect(r).toEqual({ authorized: true, reason: "simulated_dev" });
  });
});
