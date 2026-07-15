import { afterEach, describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import type { PayoutSubmit, QuoteRequest } from "../../application/ports";
import { A2aPayoutGateway, A2aQuoteGateway } from "./gateways";

const quoteReq: QuoteRequest = { amountUsd: 400, method: "yape", destCountry: "PE" };

const validQuoteResult = {
  slug: "remit-corridor-fx",
  quoteId: "cfx-1",
  rate: 3.7,
  feeUsd: 0.5,
  netDeliveredLocal: 1478.15,
  localCurrency: "PEN",
  etaMinutes: 30,
  expiresAt: "2026-07-09T18:10:00.000Z",
  provenance: "remit-corridor-fx",
};

const payoutReq: PayoutSubmit = {
  quoteId: "cfx-1",
  amountUsd: 400,
  expectedReceivePen: Money.of(1478.15, "PEN"),
  beneficiary: { name: "Mamá", country: "PE", method: "yape", destination: "999888777" },
  kycVerificationId: "v-1",
  idempotencyKey: "r-1:cfx-1",
};

function okJson(body: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => body }));
}

afterEach(() => vi.restoreAllMocks());

describe("A2aQuoteGateway (AC-3)", () => {
  it("POST /api/a2a/quote con {amountUsd,destCountry,payoutMethod} y mapea {result}→Quote", async () => {
    const fetchMock = okJson({ result: validQuoteResult });
    vi.stubGlobal("fetch", fetchMock);
    const q = await new A2aQuoteGateway().requestQuote(quoteReq);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/a2a/quote");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      amountUsd: 400,
      destCountry: "PE",
      payoutMethod: "yape",
    });
    expect(q.quoteId).toBe("cfx-1");
    expect(q.send).toEqual(Money.of(400, "USDC")); // del REQUEST
    expect(q.receive).toEqual(Money.of(1478.15, "PEN"));
    expect(q.feeUsd).toEqual(Money.of(0.5, "USDC"));
    expect(q.rate).toBe(3.7);
    expect(q.etaMinutes).toBe(30);
    expect(q.provenance).toBe("remit-corridor-fx");
  });

  it("AC-5: !ok → throw a2a_quote_unavailable (PII-free)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })));
    await expect(new A2aQuoteGateway().requestQuote(quoteReq)).rejects.toThrow("a2a_quote_unavailable");
  });

  it("AC-5: shape inválido → throw a2a_quote_bad_shape", async () => {
    vi.stubGlobal("fetch", okJson({ result: { quoteId: "x" } }));
    await expect(new A2aQuoteGateway().requestQuote(quoteReq)).rejects.toThrow("a2a_quote_bad_shape");
  });

  it("WKH-198 AC-4: expiresAt no-parseable → throw a2a_quote_bad_shape", async () => {
    vi.stubGlobal("fetch", okJson({ result: { ...validQuoteResult, expiresAt: "not-a-date" } }));
    await expect(new A2aQuoteGateway().requestQuote(quoteReq)).rejects.toThrow("a2a_quote_bad_shape");
  });
});

describe("A2aPayoutGateway (AC-4/AC-5/AC-14)", () => {
  it("AC-4: submit → POST /api/a2a/payout/submit; idempotencyKey INTACTO, kycPayoutAllowed:true sintetizado", async () => {
    const fetchMock = okJson({
      result: { slug: "remit-cashout-payout", executed: true, status: "submitted", payoutId: "po-1", deliveredLocal: null, txRef: null, reason: null, provenance: "remit-cashout-payout" },
    });
    vi.stubGlobal("fetch", fetchMock);
    const rec = await new A2aPayoutGateway().submit(payoutReq);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/a2a/payout/submit");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.idempotencyKey).toBe("r-1:cfx-1"); // CD-10 intacto
    expect(sent.kycPayoutAllowed).toBe(true); // DT-5 sintetizado
    expect(sent.kycVerificationId).toBe("v-1"); // propagado
    expect(sent.quoteId).toBe("cfx-1");
    expect(rec).toEqual({ payoutId: "po-1", status: "submitted", deliveredPen: null, txRef: null, failureReason: null, provenance: "remit-cashout-payout" });
  });

  it("AC-4: mapea settled con deliveredLocal→Money PEN + txRef", async () => {
    vi.stubGlobal("fetch", okJson({
      result: { status: "settled", payoutId: "po-2", deliveredLocal: 1478.15, txRef: "0xdlv", reason: null, provenance: "transfi" },
    }));
    const rec = await new A2aPayoutGateway().submit(payoutReq);
    expect(rec.status).toBe("settled");
    expect(rec.deliveredPen).toEqual(Money.of(1478.15, "PEN"));
    expect(rec.txRef).toBe("0xdlv");
    expect(rec.provenance).toBe("transfi"); // T-AC5c: provenance propagada en el mapeo
  });

  it("DT-13: blocked → failed", async () => {
    vi.stubGlobal("fetch", okJson({
      result: { status: "blocked", payoutId: null, deliveredLocal: null, txRef: null, reason: "sanctions_hit", provenance: "p" },
    }));
    const rec = await new A2aPayoutGateway().submit(payoutReq);
    expect(rec.status).toBe("failed");
    expect(rec.failureReason).toBe("sanctions_hit");
  });

  it("AC-5: !ok → throw a2a_payout_unavailable, mensaje NO contiene PII del beneficiario", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })));
    let msg = "";
    try {
      await new A2aPayoutGateway().submit(payoutReq);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toBe("a2a_payout_unavailable");
    expect(msg).not.toContain("Mamá");
    expect(msg).not.toContain("999888777");
  });

  it("AC-5: shape inválido (settled sin payoutId) → throw a2a_payout_bad_shape", async () => {
    vi.stubGlobal("fetch", okJson({
      result: { status: "settled", payoutId: null, deliveredLocal: 1478.15, txRef: "0x", reason: null, provenance: "p" },
    }));
    await expect(new A2aPayoutGateway().submit(payoutReq)).rejects.toThrow("a2a_payout_bad_shape");
  });

  it("AC-14: status(payoutId) devuelve el PayoutRecord cacheado del submit()", async () => {
    vi.stubGlobal("fetch", okJson({
      result: { status: "settled", payoutId: "po-3", deliveredLocal: 1478.15, txRef: "0xdlv", reason: null, provenance: "p" },
    }));
    const gw = new A2aPayoutGateway();
    const submitted = await gw.submit(payoutReq);
    const status = await gw.status("po-3");
    expect(status).toEqual(submitted);
  });

  it("MNR-B: status de un id desconocido (cache-miss) → NO-TERMINAL 'submitted', NUNCA 'failed' (no false-refund)", async () => {
    const gw = new A2aPayoutGateway();
    const status = await gw.status("nope");
    // Cache-miss (recarga → Map vacío) NO es evidencia de fallo. Fabricar "failed" false-refundearía
    // un payout que pudo ser exitoso. Estado no-terminal → TrackRemittance NO refundea sobre incertidumbre.
    expect(status.status).toBe("submitted");
    expect(status.status).not.toBe("failed");
    expect(status).toEqual({
      payoutId: "nope",
      status: "submitted",
      deliveredPen: null,
      txRef: null,
      failureReason: "payout_status_unknown",
      provenance: "", // WKH-200: record fabricado (cache-miss) → provenance vacía, cosmético
    });
  });
});
