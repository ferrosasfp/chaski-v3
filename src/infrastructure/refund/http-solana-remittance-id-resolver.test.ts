// Tests — HttpSolanaRemittanceIdResolver (HU-SOL-20/AC-2, T-R0-11). Firma el PoP ANTES de pedir (el
// endpoint lo exige, CD-16) y degrada a [] cuando el mecanismo está apagado o no verificado, sin
// lanzar. `fetch` stubeado: cero red.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PopSigner } from "../../application/ports";
import { HttpSolanaRemittanceIdResolver } from "./http-solana-remittance-id-resolver";

const SENDER = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function popOk(): PopSigner {
  return { prove: vi.fn(async () => ({ challenge: "ch-token", signature: "sig-b58" })) };
}
function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

describe("HttpSolanaRemittanceIdResolver (HU-SOL-20/AC-2)", () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("T-R0-11: POSTea sender + popChallenge + popSignature al endpoint y devuelve los ids", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(200, {
        remittanceIds: [
          { remittanceId: "rem-A1", status: "prepared", createdAt: "2026-07-27T00:00:00.000Z" },
          { remittanceId: "rem-A2", status: "settled", createdAt: "2026-07-26T00:00:00.000Z" },
        ],
      }),
    );
    const pop = popOk();
    const out = await new HttpSolanaRemittanceIdResolver(pop).listBySender(SENDER);
    expect(out).toEqual(["rem-A1", "rem-A2"]);

    // El PoP se pide para EL MISMO sender que se consulta (si no, el endpoint responde 403).
    expect(pop.prove).toHaveBeenCalledWith(SENDER);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/solana/escrow/remittance-ids");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      sender: SENDER,
      popChallenge: "ch-token",
      popSignature: "sig-b58",
    });
  });

  it("T-R0-11: prove() → null (PoP apagado server-side) ⇒ [] y NI SE LLAMA al endpoint", async () => {
    const pop: PopSigner = { prove: vi.fn(async () => null) };
    const out = await new HttpSolanaRemittanceIdResolver(pop).listBySender(SENDER);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("T-R0-11: 501 (ledger apagado) y 403 (no verificado) ⇒ [] sin lanzar", async () => {
    for (const status of [501, 403]) {
      fetchMock.mockResolvedValue(jsonRes(status, { error: "x" }));
      await expect(new HttpSolanaRemittanceIdResolver(popOk()).listBySender(SENDER)).resolves.toEqual(
        [],
      );
    }
  });

  it("T-R0-11: cualquier otro !ok (429/502/503) ⇒ LANZA escrow_recovery_unavailable (fail-loud)", async () => {
    for (const status of [400, 429, 500, 502, 503]) {
      fetchMock.mockResolvedValue(jsonRes(status, { error: "x" }));
      await expect(
        new HttpSolanaRemittanceIdResolver(popOk()).listBySender(SENDER),
      ).rejects.toThrow("escrow_recovery_unavailable");
    }
  });

  it("T-R0-11: 200 con shape deforme ⇒ [] (nunca undefined/NaN aguas abajo)", async () => {
    for (const body of [{}, { remittanceIds: [] }, { remittanceIds: [{}, { remittanceId: 7 }, { remittanceId: "" }] }]) {
      fetchMock.mockResolvedValue(jsonRes(200, body));
      await expect(new HttpSolanaRemittanceIdResolver(popOk()).listBySender(SENDER)).resolves.toEqual(
        [],
      );
    }
  });

  it("T-R0-11: filtra los ids no-string y conserva los válidos", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(200, { remittanceIds: [{ remittanceId: null }, { remittanceId: "rem-ok" }] }),
    );
    await expect(new HttpSolanaRemittanceIdResolver(popOk()).listBySender(SENDER)).resolves.toEqual([
      "rem-ok",
    ]);
  });
});

// 🔴 2º fix-pack (AR/BLQ-MED-2). Los tests de arriba clavan el COLAPSO a `[]`, que es el contrato del
// refund. Los de acá clavan que el colapso NO es la única lectura posible: el mismo intercambio HTTP
// tiene tres desenlaces distintos de "el servidor contestó que no hay nada", y `lookupBySender` los
// separa. Sin estos, un cambio que devolviera `answered/[]` en el 501 pasaría toda la suite de arriba.
describe("HttpSolanaRemittanceIdResolver.lookupBySender — los TRES desenlaces", () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prove() → null (mecanismo PoP apagado) ⇒ not_asked/pop_disabled, sin tocar el endpoint", async () => {
    const pop: PopSigner = { prove: vi.fn(async () => null) };
    await expect(new HttpSolanaRemittanceIdResolver(pop).lookupBySender(SENDER)).resolves.toEqual({
      outcome: "not_asked",
      reason: "pop_disabled",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("501 (registro apagado) ⇒ not_asked/registry_disabled", async () => {
    fetchMock.mockResolvedValue(jsonRes(501, { error: "escrow_recovery_not_enabled" }));
    await expect(
      new HttpSolanaRemittanceIdResolver(popOk()).lookupBySender(SENDER),
    ).resolves.toEqual({ outcome: "not_asked", reason: "registry_disabled" });
  });

  it("403 (la prueba de posesión no verificó) ⇒ not_asked/pop_rejected", async () => {
    fetchMock.mockResolvedValue(jsonRes(403, { error: "pop_invalid" }));
    await expect(
      new HttpSolanaRemittanceIdResolver(popOk()).lookupBySender(SENDER),
    ).resolves.toEqual({ outcome: "not_asked", reason: "pop_rejected" });
  });

  // El control que separa los tres de arriba del cuarto desenlace: acá el servidor SÍ contestó, y
  // contestó que no hay nada. Mismo método, misma forma, y `outcome` distinto — que es toda la
  // diferencia entre poder afirmar algo sobre la billetera de alguien y no poder.
  it("CONTROL: 200 con la lista vacía ⇒ answered/[] (ESO sí habla de la billetera)", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { remittanceIds: [] }));
    await expect(
      new HttpSolanaRemittanceIdResolver(popOk()).lookupBySender(SENDER),
    ).resolves.toEqual({ outcome: "answered", remittanceIds: [] });
  });

  it("el !ok que ya lanzaba sigue lanzando (429/502) — no se convirtió en un not_asked", async () => {
    for (const status of [429, 502]) {
      fetchMock.mockResolvedValue(jsonRes(status, { error: "x" }));
      await expect(
        new HttpSolanaRemittanceIdResolver(popOk()).lookupBySender(SENDER),
      ).rejects.toThrow("escrow_recovery_unavailable");
    }
  });

  // `listBySender` se implementa SOBRE `lookupBySender`, así que hay una forma de que divergieran:
  // que el colapso dejara de ser el mismo. Esto lo clava para los tres motivos.
  it("y `listBySender` sigue colapsando los tres a [] (el contrato del refund, intacto)", async () => {
    for (const status of [501, 403]) {
      fetchMock.mockResolvedValue(jsonRes(status, { error: "x" }));
      await expect(
        new HttpSolanaRemittanceIdResolver(popOk()).listBySender(SENDER),
      ).resolves.toEqual([]);
    }
    const popOff: PopSigner = { prove: vi.fn(async () => null) };
    await expect(new HttpSolanaRemittanceIdResolver(popOff).listBySender(SENDER)).resolves.toEqual(
      [],
    );
  });
});
