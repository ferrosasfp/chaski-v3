// WKH-227 / HU-SOL-24 — contract test (AC-1). Replaya el fixture VENDOREADO del provider
// remit-cashout-payout contra el validador del consumer: A2aPayoutGateway.submit (isValidPayoutShape,
// gateways.ts). Si el provider driftea el shape y se re-vendorea → el validador falla → ROJO.
import { afterEach, describe, expect, it, vi } from "vitest";
import { A2aPayoutGateway } from "../src/infrastructure/a2a/gateways";
import type { PayoutSubmit } from "../src/application/ports";
import { Money } from "../src/domain/money";
import { cashoutPayoutVendoredFixture } from "./vendored/cashout-payout.output.fixture";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Campos mínimos válidos del PayoutSubmit (ports.ts:63-83). NUNCA se loguea beneficiary (CD-5).
const req: PayoutSubmit = {
  quoteId: "q_fixed_0001",
  amountUsd: 100,
  expectedReceivePen: Money.of(368.65, "PEN"),
  beneficiary: { name: "Ana", country: "PE", method: "yape", destination: "999999999" },
  kycVerificationId: "fallback-910e0084",
  address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  idempotencyKey: "idem-0001",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("contract payout (AC-1) — A2aPayoutGateway.submit vs fixture vendoreado", () => {
  it("fixture CANÓNICO (blocked) ⇒ isValidPayoutShape pasa ⇒ mapea a PayoutRecord (no-throw)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ result: cashoutPayoutVendoredFixture })),
    );
    const rec = await new A2aPayoutGateway().submit(req);
    // status "blocked" → "failed" (DT-13); payoutId null → "" (validado en el guard, es blocked).
    expect(rec.status).toBe("failed");
    expect(rec.failureReason).toBe("kyc_gate_not_passed");
    expect(rec.provenance).toBe("n/a");
  });

  it("DRIFT (status inválido) ⇒ isValidPayoutShape falla ⇒ throw a2a_payout_bad_shape", async () => {
    const drifted = { ...cashoutPayoutVendoredFixture, status: "pending" };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ result: drifted })));
    await expect(new A2aPayoutGateway().submit(req)).rejects.toThrow("a2a_payout_bad_shape");
  });
});
