import { afterEach, describe, expect, it, vi } from "vitest";
import type { KycGateway } from "../../application/ports";
import type { KycVerification } from "../../domain/remittance";
import { DiditKycGateway } from "./kyc-gateway";

const fallbackResult: KycVerification = {
  verificationId: "fb-1",
  approved: true,
  payoutAllowed: true,
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
});
