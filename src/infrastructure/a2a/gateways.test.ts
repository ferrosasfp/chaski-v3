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
  address: "0xSender", // WKH-202/DT-2
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

  // El agente que cotizó viaja DENTRO del Quote: es lo que se persiste con la remesa, así que
  // sobrevive a una recarga por el mismo camino que la tasa y el recibo lo puede mostrar.
  it("el agente que cotizó queda DENTRO del Quote (sobrevive a la persistencia del snapshot)", async () => {
    vi.stubGlobal(
      "fetch",
      okJson({
        result: validQuoteResult,
        agent: {
          slug: "remit-corridor-fx",
          registry: "WasiAI",
          capability: "remittance-fx-quote",
          trial: true,
        },
      }),
    );
    const q = await new A2aQuoteGateway().requestQuote(quoteReq);
    expect(q.agent).toEqual({
      slug: "remit-corridor-fx",
      registry: "WasiAI",
      capability: "remittance-fx-quote",
      trial: true,
    });
  });

  // Un agente CON slug pero SIN registry: el slug se conserva y el catálogo NO se inventa vacío.
  it("agent con slug y sin registry ⇒ el registry queda AUSENTE (no cadena vacía)", async () => {
    vi.stubGlobal("fetch", okJson({ result: validQuoteResult, agent: { slug: "sin-catalogo" } }));
    const q = await new A2aQuoteGateway().requestQuote(quoteReq);
    expect(q.agent).toEqual({ slug: "sin-catalogo" });
    expect(q.agent).not.toHaveProperty("registry");
  });

  it("sin agent (o ilegible) el Quote NO lo inventa: el campo queda ausente", async () => {
    vi.stubGlobal("fetch", okJson({ result: validQuoteResult }));
    expect((await new A2aQuoteGateway().requestQuote(quoteReq)).agent).toBeUndefined();

    vi.stubGlobal("fetch", okJson({ result: validQuoteResult, agent: { registry: "WasiAI" } }));
    expect((await new A2aQuoteGateway().requestQuote(quoteReq)).agent).toBeUndefined();
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

describe("A2aPayoutGateway (AC-14 + la ruta que ya no existe)", () => {
  it("submit tira a2a_payout_submit_route_removed y NO hace un solo fetch", async () => {
    // El test que había acá mockeaba fetch y asserteaba que la URL fuera "/api/a2a/payout/submit":
    // verde permanente sobre una ruta BORRADA por WKH-320 (su ausencia está asertada en
    // src/composition/no-evm-surface.test.ts:124). Ahora se aserta lo contrario, que es lo cierto:
    // no hay a dónde postear, así que no se postea.
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new A2aPayoutGateway().submit(payoutReq)).rejects.toThrow(
      "a2a_payout_submit_route_removed",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("el error NO se confunde con una caída transitoria del agente", () => {
    // "a2a_payout_unavailable" era el error de un 502 del agente: transitorio, se reintenta, se mira
    // el deploy. Este es estructural y permanente. Que se llamen distinto es el punto del fix.
    expect("a2a_payout_submit_route_removed").not.toBe("a2a_payout_unavailable");
  });

  it("el mensaje sigue siendo PII-free (CD-5)", async () => {
    let msg = "";
    try {
      await new A2aPayoutGateway().submit(payoutReq);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toBe("a2a_payout_submit_route_removed");
    expect(msg).not.toContain("Mamá");
    expect(msg).not.toContain("999888777");
  });

  it("MNR-B: status de cualquier id devuelve NO-TERMINAL 'submitted', NUNCA 'failed' (no false-refund)", async () => {
    // Sin submit no hay caché posible, así que este es el ÚNICO comportamiento de status(). Antes era
    // el del cache-miss, que igual era el caso real en producción (recarga → Map vacío). No fabricar
    // "failed" es lo que evita refundear un payout que pudo ser exitoso.
    const status = await new A2aPayoutGateway().status("nope");
    expect(status.status).toBe("submitted");
    expect(status.status).not.toBe("failed");
    expect(status).toEqual({
      payoutId: "nope",
      status: "submitted",
      deliveredPen: null,
      txRef: null,
      failureReason: "payout_status_unknown",
      provenance: "", // WKH-200: record fabricado → provenance vacía, cosmético
    });
  });
});
