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
const fakeFallback: KycGateway = { verify: async () => fallbackResult };
const req = {
  amountUsd: 400,
  beneficiary: { name: "Mamá", country: "PE", method: "yape" as const, destination: "999" },
  purpose: "test",
};

afterEach(() => vi.restoreAllMocks());

describe("DiditKycGateway — server-truth (fallback si el server no tiene Didit)", () => {
  it("server sin Didit (501) → delega en el fallback (simulación)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 501, ok: false })));
    const gw = new DiditKycGateway(fakeFallback);
    const r = await gw.verify(req);
    expect(r.provenance).toBe("local-fallback");
    expect(r).toEqual(fallbackResult);
  });

  it("creación de sesión falla (500) → tira didit_session_failed (NO usa fallback)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 500, ok: false })));
    const gw = new DiditKycGateway(fakeFallback);
    await expect(gw.verify(req)).rejects.toThrow(/didit_session_failed/);
  });
});
