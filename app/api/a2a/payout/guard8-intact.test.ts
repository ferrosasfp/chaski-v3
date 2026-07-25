// Tests — CD-3/AC-6 (WKH-211): el guard 8 de /api/a2a/payout/submit (atestación de settlement, WKH-168)
// queda INTACTO byte-a-byte. WKH-211 NO lo toca (su garantía se re-aloja en el settle-binding + el
// deposit-gating de TransFi, DT-2). Regresión: con SETTLE_ATTESTATION_SECRET presente y SIN
// settlementAttestation en el body ⇒ 403 payout_principal_unverified (el gate G3 sigue cerrado).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WKH-218: spy del cliente del gateway para probar que, con adapter="a2a-gateway", los guards 1-8
// cortan ANTES de leer el adapter ⇒ el gateway ni se resuelve (guards byte-idénticos, CD-2).
const { runViaGatewayMock } = vi.hoisted(() => ({ runViaGatewayMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/a2a/gateway-client", () => ({
  runViaGateway: runViaGatewayMock,
}));

import { POST } from "./submit/route";

function req(payload: unknown): Request {
  return new Request("http://localhost/api/a2a/payout/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// Payload válido para pasar formato + autoridad (simulated_dev en local sin DIDIT_API_KEY) + PoP off.
const validPayload = {
  quoteId: "cfx-1",
  amountUsd: 400,
  kycVerificationId: "v-1",
  address: "0xSender",
  kycPayoutAllowed: true,
  beneficiary: { name: "Mamá", country: "PE", method: "yape", destination: "999888777" },
  idempotencyKey: "r-1:cfx-1",
};

describe("guard 8 de submit INTACTO (WKH-211 CD-3/AC-6, regresión WKH-168)", () => {
  beforeEach(() => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", "https://agents.example.com");
    vi.stubEnv("DIDIT_API_KEY", ""); // sin key + local ⇒ autoridad simulated_dev (authorized)
    vi.stubEnv("VERCEL_ENV", ""); // local ⇒ simulated_dev se acepta
    vi.stubEnv("PAYOUT_POP_SECRET", ""); // PoP off (no interfiere con el guard 8)
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", "settle-secret"); // guard 8 ACTIVO
    // fetch stub: si por un bug el guard NO cortara, no queremos red real (y detectaríamos el forward).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ result: {} }), { status: 200 })),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("CD-3: con SETTLE_ATTESTATION_SECRET y SIN settlementAttestation ⇒ 403 payout_principal_unverified (guard 8 sigue cerrado)", async () => {
    const res = await POST(req(validPayload)); // sin settlementAttestation
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_principal_unverified" });
    // El guard cortó ANTES del forward: fetch NO se llamó.
    expect(fetch).not.toHaveBeenCalled();
  });

  // WKH-218/CD-2: con el flag gateway ON, los guards 1-8 corren PRIMERO y byte-idénticos. Con el
  // secreto seteado y sin settlementAttestation ⇒ 403 sin forward, y el gateway NUNCA se resuelve
  // (los guards cortan antes de leer el adapter, que se lee recién post guard 8).
  it("CD-2/WKH-218: adapter='a2a-gateway' + secreto + SIN settlementAttestation ⇒ 403 sin forward; runViaGateway NUNCA llamado", async () => {
    runViaGatewayMock.mockReset();
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gateway");
    const res = await POST(req(validPayload)); // sin settlementAttestation
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_principal_unverified" });
    expect(fetch).not.toHaveBeenCalled(); // guard 8 cortó: ni gateway ni punto-a-punto
    expect(runViaGatewayMock).not.toHaveBeenCalled();
  });
});
