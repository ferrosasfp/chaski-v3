// Tests — wiring del depositAddress en A2aPayoutGateway (WKH-211 W4.1 / WKH-212, AC-1/CD-10). El
// contrato del wire del agente ahora incluye depositAddress (string | null); isValidPayoutShape lo
// valida. CD-10 (lección WKH-212): un campo nuevo en el wire DEBE reflejarse en el guard de shape, o
// un result stale pasaría en silencio.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import type { PayoutSubmit } from "../../application/ports";
import { A2aPayoutGateway } from "./gateways";

const payoutReq: PayoutSubmit = {
  quoteId: "cfx-1",
  amountUsd: 400,
  expectedReceivePen: Money.of(1478.15, "PEN"),
  beneficiary: { name: "Mamá", country: "PE", method: "yape", destination: "999888777" },
  kycVerificationId: "v-1",
  address: "0xSender",
  idempotencyKey: "r-1:cfx-1",
};

function okJson(body: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => body }));
}
function result(over: Record<string, unknown> = {}) {
  return {
    status: "submitted",
    payoutId: "po-1",
    deliveredLocal: null,
    txRef: null,
    reason: null,
    provenance: "transfi",
    depositAddress: null,
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("A2aPayoutGateway — wiring depositAddress (WKH-211/WKH-212, CD-10)", () => {
  it("acepta un result con depositAddress string (isValidPayoutShape) y lo mapea a PayoutRecord (sin romper el contrato del submit)", async () => {
    vi.stubGlobal(
      "fetch",
      okJson({ result: result({ depositAddress: "0x4444444444444444444444444444444444444444" }) }),
    );
    const rec = await new A2aPayoutGateway().submit(payoutReq);
    // PayoutRecord NO cambia (el submit no usa depositAddress; el prepare lo lee del result crudo).
    expect(rec).toEqual({
      payoutId: "po-1",
      status: "submitted",
      deliveredPen: null,
      txRef: null,
      failureReason: null,
      provenance: "transfi",
    });
  });

  it("acepta depositAddress null (mock/blocked)", async () => {
    vi.stubGlobal("fetch", okJson({ result: result({ depositAddress: null }) }));
    const rec = await new A2aPayoutGateway().submit(payoutReq);
    expect(rec.status).toBe("submitted");
  });

  it("CD-10: result SIN depositAddress (shape stale) ⇒ throw a2a_payout_bad_shape (el guard lo caza)", async () => {
    const stale = result();
    delete (stale as Record<string, unknown>).depositAddress;
    vi.stubGlobal("fetch", okJson({ result: stale }));
    await expect(new A2aPayoutGateway().submit(payoutReq)).rejects.toThrow("a2a_payout_bad_shape");
  });

  it("CD-10: depositAddress de tipo inválido (number) ⇒ throw a2a_payout_bad_shape", async () => {
    vi.stubGlobal("fetch", okJson({ result: result({ depositAddress: 123 }) }));
    await expect(new A2aPayoutGateway().submit(payoutReq)).rejects.toThrow("a2a_payout_bad_shape");
  });
});
