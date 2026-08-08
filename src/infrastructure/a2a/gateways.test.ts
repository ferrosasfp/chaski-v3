import { afterEach, describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import { QUOTE_NO_AGENT_FOR_CAPABILITY } from "../../application/agent-rejections";
import { humanError } from "../../presentation/flow-vm";
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
  // WKH-333: `kycVerificationId` se eliminó de `PayoutSubmit`. El backend saca ese identificador
  // de su propia fila; un cliente ya no puede proponerlo (CD-26/CD-27).
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

  // Hallazgo #75 — el cliente tiene que PROPAGAR la distinción que la route ahora hace. Si estos
  // enums se colapsan acá, la separación del server no llega a ninguna pantalla: `humanError()` sólo
  // ve el `message` del Error que sale de este método.
  function rejects(body: unknown, status = 400) {
    return vi.fn(async () => ({ ok: false, status, json: async () => body }));
  }

  it("#75: rechazo por mínimo ⇒ throw fx_amount_below_minimum (NO a2a_quote_unavailable)", async () => {
    vi.stubGlobal(
      "fetch",
      rejects({ error: "a2a_quote_rejected", reason: "fx_amount_below_minimum" }),
    );
    await expect(new A2aQuoteGateway().requestQuote(quoteReq)).rejects.toThrow(
      "fx_amount_below_minimum",
    );
  });

  it("#75: rechazo por techo ⇒ throw fx_amount_above_maximum (NO a2a_quote_unavailable)", async () => {
    vi.stubGlobal(
      "fetch",
      rejects({ error: "a2a_quote_rejected", reason: "fx_amount_above_maximum" }),
    );
    await expect(new A2aQuoteGateway().requestQuote(quoteReq)).rejects.toThrow(
      "fx_amount_above_maximum",
    );
  });

  it("#75: rechazo colapsado (sin reason) ⇒ throw a2a_quote_rejected, que tampoco es 'unavailable'", async () => {
    vi.stubGlobal("fetch", rejects({ error: "a2a_quote_rejected" }));
    await expect(new A2aQuoteGateway().requestQuote(quoteReq)).rejects.toThrow(
      "a2a_quote_rejected",
    );
  });

  // Un `reason` que NO está en la allow-list no se propaga aunque la route se lo mande: el cliente
  // filtra igual que el server. Sin esto, un server comprometido o driftado podría hacer que este
  // adapter tire un string arbitrario que después se muestra en pantalla como código.
  it("#75: reason fuera de la allow-list ⇒ cae al enum de familia, nunca el string crudo", async () => {
    vi.stubGlobal(
      "fetch",
      rejects({ error: "a2a_quote_rejected", reason: "sarasa_inventada" }),
    );
    await expect(new A2aQuoteGateway().requestQuote(quoteReq)).rejects.toThrow(
      "a2a_quote_rejected",
    );
  });

  // ── CR/BLQ-MED-1 · EL CABLEADO DE AC-13, NO LA RAMA QUE PINTA ───────────────────────────────────
  //
  // 🔴 QUÉ AGUJERO CIERRA, MEDIDO. `gateways.ts`:109 es la ÚNICA línea que lleva el enum de AC-13
  // desde el body del 422 de la route hasta `humanError`. Mutándola línea-neutra a
  // `body.error === ${QUOTE_NO_AGENT_FOR_CAPABILITY}_x` (con backticks), `tsc` daba exit 0 y la
  // suite COMPLETA 1587/1587 verde, y lo que la persona leía era "Algo salió mal. Intentá de nuevo."
  // — el copy de ANTES de la HU. Los tests que había NO podían verlo: los de `flow-vm.test.ts`
  // llaman a `humanError(...)` con el string escrito a mano, y el de `flow.test.tsx` inyecta el
  // `failureReason` directo en el estado de la remesa. Los dos prueban que la RAMA pinta; ninguno
  // prueba que el motivo LLEGUE. Es la lección `tests-que-registran-el-doble-no-prueban-el-cableado`.
  //
  // Por eso este `it` arranca en el 422 tal como la route lo escribe (`{error:"a2a_no_agent_for_capability"}`,
  // (`a2a_no_agent_for_capability`, `../../../app/api/a2a/quote/route.test.ts:405`)) y termina en la frase que se lee en
  // pantalla. Lo único NO mockeado en el medio es el gateway de producción.
  it("CABLEADO/AC-13: el 422 de la route llega hasta el copy de 'no hay quién', sin pasar por el genérico", async () => {
    vi.stubGlobal("fetch", rejects({ error: QUOTE_NO_AGENT_FOR_CAPABILITY }, 422));

    const err = await new A2aQuoteGateway()
      .requestQuote(quoteReq)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const code = (err as Error).message;
    expect(code).toBe(QUOTE_NO_AGENT_FOR_CAPABILITY);
    // Y lo que la persona lee al final del cable. Sin la línea 109 esto es el genérico.
    expect(humanError(code)).toContain("no hay ningún proveedor");
    expect(humanError(code)).not.toBe("Algo salió mal. Intentá de nuevo.");
    // La otra mitad: el enum de caída sigue siendo OTRO. Un mutante que mapeara los dos al mismo
    // string dejaría verdes los dos asserts de arriba.
    expect(code).not.toBe("a2a_quote_unavailable");
    expect(humanError(code)).not.toBe(humanError("a2a_quote_unavailable"));
  });

  // CANDADO: la infraestructura caída sigue diciendo lo de siempre.
  it("#75 CANDADO: 502 sin body de rechazo ⇒ sigue siendo a2a_quote_unavailable", async () => {
    vi.stubGlobal("fetch", rejects({ error: "a2a_upstream_error" }, 502));
    await expect(new A2aQuoteGateway().requestQuote(quoteReq)).rejects.toThrow(
      "a2a_quote_unavailable",
    );
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
