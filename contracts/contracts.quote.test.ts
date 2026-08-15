// WKH-227 / HU-SOL-24 — contract test (AC-1). Replaya el fixture VENDOREADO del provider de FX
// contra los DOS validadores del consumer:
//   (a) el handler POST de app/api/a2a/quote/route.ts (isValidQuoteResult, vía el handler — CD-8: NUNCA
//       se importa/exporta el helper de un route.ts de Next).
//   (b) A2aQuoteGateway.requestQuote (isValidQuoteShape, gateways.ts).
// Si el provider driftea y se re-vendorea con un shape incompatible → el validador falla → ROJO.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WKH-355 — el handler ahora consulta el limitador de tasa ANTES de componer, y falla CERRADO si
// Upstash no está configurado (que es el estado del runner). Sin este doble, los dos casos de abajo
// cortarían con 503 y este contract test pasaría a medir el limitador en vez del shape del provider,
// que es lo único que vino a medir. Se mockea SÓLO `checkRouteRateLimit`; `QUOTE_RL` y `clientIp`
// quedan reales. El candado del limitador NO es este archivo: es
// `app/api/a2a/quote/route.rate-limit.test.ts`.
const { checkRouteRateLimitMock } = vi.hoisted(() => ({ checkRouteRateLimitMock: vi.fn() }));
vi.mock("../src/infrastructure/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/infrastructure/rate-limit")>();
  return { ...actual, checkRouteRateLimit: checkRouteRateLimitMock };
});

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

/** El fixture del provider, envuelto como lo entrega `POST /compose` (WKH-332/W3: es el único
 *  transporte, y el handler ya no lee `{ result }` de un agente invocado por su slug). Lo que el
 *  contract test mide sigue siendo el MISMO: que el shape del provider pase `isValidQuoteResult`. */
function composeWith(output: unknown): Response {
  return jsonResponse({ success: true, steps: [{ output }] });
}

describe("contract quote (AC-1) — handler POST vs fixture vendoreado", () => {
  beforeEach(() => {
    // W3: la ruta ya no lee la base de los agentes; lo que necesita configurado es el gateway.
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", "https://gateway.test");
    vi.stubEnv("WASIAI_A2A_AGENT_KEY", "ak_contract_test");
    // El `afterEach` restaura los mocks ⇒ el doble volvería a devolver `undefined`. Default: pasa.
    checkRouteRateLimitMock.mockReset();
    checkRouteRateLimitMock.mockResolvedValue({ ok: true });
  });

  it("fixture CANÓNICO ⇒ isValidQuoteResult pasa ⇒ 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => composeWith(corridorFxVendoredFixture)),
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
    vi.stubGlobal("fetch", vi.fn(async () => composeWith(drifted)));
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
    vi.stubGlobal("fetch", vi.fn(async () => composeWith(drifted)));
    await expect(new A2aQuoteGateway().requestQuote(req)).rejects.toThrow("a2a_quote_bad_shape");
  });
});
