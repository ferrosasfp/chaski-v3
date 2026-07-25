// WKH-227 / HU-SOL-24 — contract test (AC-1). Replaya el fixture VENDOREADO del provider
// remit-corridor-fx contra los DOS validadores del consumer:
//   (a) el handler POST de app/api/a2a/quote/route.ts (isValidQuoteResult, vía el handler — CD-8: NUNCA
//       se importa/exporta el helper de un route.ts de Next).
//   (b) A2aQuoteGateway.requestQuote (isValidQuoteShape, gateways.ts).
// Si el provider driftea y se re-vendorea con un shape incompatible → el validador falla → ROJO.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/a2a/quote/route";
import { A2aQuoteGateway } from "../src/infrastructure/a2a/gateways";
import type { QuoteRequest } from "../src/application/ports";
import { corridorFxVendoredFixture } from "./vendored/corridor-fx.output.fixture";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("contract quote (AC-1) — handler POST vs fixture vendoreado", () => {
  beforeEach(() => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", "https://agent.test");
  });

  it("fixture CANÓNICO ⇒ isValidQuoteResult pasa ⇒ 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ result: corridorFxVendoredFixture })),
    );
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ amountUsd: 100 }) }),
    );
    expect(res.status).toBe(200);
  });

  it("DRIFT (feeUsd → feeUsd2) ⇒ isValidQuoteResult falla ⇒ 502", async () => {
    // Mutación in-memory del fixture (NO un 2º fixture en disco): simula un provider que renombró
    // un campo del contrato sin actualizar al consumer.
    const { feeUsd: _drop, ...rest } = corridorFxVendoredFixture;
    const drifted = { ...rest, feeUsd2: 0.5 };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ result: drifted })));
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ amountUsd: 100 }) }),
    );
    expect(res.status).toBe(502);
  });
});

describe("contract quote (AC-1) — A2aQuoteGateway vs fixture vendoreado", () => {
  const req: QuoteRequest = { amountUsd: 100, method: "yape", destCountry: "PE" };

  it("fixture CANÓNICO ⇒ isValidQuoteShape pasa ⇒ mapea a Quote (no-throw)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ result: corridorFxVendoredFixture })),
    );
    const quote = await new A2aQuoteGateway().requestQuote(req);
    expect(quote.quoteId).toBe(corridorFxVendoredFixture.quoteId);
    expect(quote.provenance).toBe(corridorFxVendoredFixture.provenance);
  });

  it("DRIFT (feeUsd → feeUsd2) ⇒ isValidQuoteShape falla ⇒ throw a2a_quote_bad_shape", async () => {
    const { feeUsd: _drop, ...rest } = corridorFxVendoredFixture;
    const drifted = { ...rest, feeUsd2: 0.5 };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ result: drifted })));
    await expect(new A2aQuoteGateway().requestQuote(req)).rejects.toThrow("a2a_quote_bad_shape");
  });
});
