import { afterEach, describe, expect, it, vi } from "vitest";
import type { KycGateway } from "../../application/ports";
import type { KycVerification } from "../../domain/remittance";
import { DiditKycGateway } from "./kyc-gateway";

const fallbackResult: KycVerification = {
  verificationId: "fb-1",
  approved: true,
  payoutAllowed: true, realVerified: false, verifiedAt: null,
  riskLevel: "low",
  provenance: "local-fallback",
  identity: null,
};
const fakeFallback: KycGateway = {
  start: async () => ({ kind: "completed", verification: fallbackResult }),
  decision: async () => ({ terminal: true, verification: fallbackResult }),
};
const req = {
  amountUsd: 400,
  beneficiary: { name: "Mamá", country: "PE", method: "yape" as const, destination: "999" },
  purpose: "test",
};

afterEach(() => vi.restoreAllMocks());

describe("DiditKycGateway — server-truth + redirect", () => {
  it("server sin Didit (501) → start delega en el fallback (simulación)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 501, ok: false })));
    const gw = new DiditKycGateway(fakeFallback);
    const res = await gw.start(req);
    expect(res.kind).toBe("completed");
    if (res.kind === "completed") expect(res.verification.provenance).toBe("local-fallback");
  });

  it("creación de sesión falla (500) → tira didit_session_failed (NO usa fallback)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 500, ok: false })));
    const gw = new DiditKycGateway(fakeFallback);
    await expect(gw.start(req)).rejects.toThrow(/didit_session_failed/);
  });

  it("start OK → devuelve redirect con url + sessionId (para el redirect same-tab)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ sessionId: "s1", url: "https://verify.didit.me/session/s1" }),
      })),
    );
    const gw = new DiditKycGateway(fakeFallback);
    const res = await gw.start(req);
    expect(res.kind).toBe("redirect");
    if (res.kind === "redirect") {
      expect(res.sessionId).toBe("s1");
      expect(res.url).toContain("didit");
    }
  });

  it("start manda senderAddress como vendorData en el body (WKH-179 rate-limit)", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      void init;
      return { status: 200, ok: true, json: async () => ({ sessionId: "s1", url: "https://verify.didit.me/s1" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const gw = new DiditKycGateway(fakeFallback);
    await gw.start({ ...req, senderAddress: "0xabc" });
    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(sentBody.vendorData).toBe("0xabc");
  });

  it("el token viaja start()→decision(): start emite authToken, decision lo manda como x-kyc-token (WKH-179 B1)", async () => {
    // start() → devuelve authToken
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ sessionId: "s1", url: "https://verify.didit.me/s1", authToken: "hmac-tok" }),
      })),
    );
    const gw = new DiditKycGateway(fakeFallback);
    const started = await gw.start(req);
    expect(started.kind).toBe("redirect");
    const authToken = started.kind === "redirect" ? started.authToken : undefined;
    expect(authToken).toBe("hmac-tok");

    // decision(sessionId, authToken) → manda el header x-kyc-token
    const decFetch = vi.fn(async (_url: string, init: RequestInit) => {
      void init;
      return {
        status: 200,
        ok: true,
        json: async () => ({
          terminal: true,
          verificationId: "s1",
          approved: true,
          payoutAllowed: true,
          riskLevel: "low",
          provenance: "didit",
          status: "Approved",
          identity: null,
        }),
      };
    });
    vi.stubGlobal("fetch", decFetch);
    await gw.decision("s1", authToken);
    const headers = decFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["x-kyc-token"]).toBe("hmac-tok");
  });

  it("modo simulación (501) end-to-end sin token/Upstash → start delega en fallback (AC-10)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 501, ok: false })));
    const gw = new DiditKycGateway(fakeFallback);
    const started = await gw.start(req);
    expect(started.kind).toBe("completed");
    const dec = await gw.decision("whatever");
    expect(dec.terminal).toBe(true);
    expect(dec.verification.provenance).toBe("local-fallback");
  });
});
