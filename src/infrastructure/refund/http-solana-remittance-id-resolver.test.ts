// Tests — HttpSolanaRemittanceIdResolver (HU-SOL-20/AC-2, T-R0-11). Firma el PoP ANTES de pedir (el
// endpoint lo exige, CD-16) y devuelve `not_asked/<motivo>` cuando el mecanismo está apagado o no
// verificado, sin lanzar. `fetch` stubeado: cero red.
//
// WKH-331: el método que devolvía `string[]` y colapsaba los tres `not_asked` en `[]` ya no existe,
// así que estos casos consultan la primitiva. Ninguno se perdió en la migración: la que era única de
// cada uno (la forma del POST, los cinco status que lanzan, el shape deforme, el filtro de no-strings)
// se conservó tal cual, y los dos que sólo repetían lo que el segundo `describe` ya prueba se borraron.
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
    const out = await new HttpSolanaRemittanceIdResolver(pop).lookupBySender(SENDER);
    expect(out).toEqual({ outcome: "answered", remittanceIds: ["rem-A1", "rem-A2"] });

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

  it("T-R0-11: cualquier otro !ok (429/502/503) ⇒ LANZA escrow_recovery_unavailable (fail-loud)", async () => {
    for (const status of [400, 429, 500, 502, 503]) {
      fetchMock.mockResolvedValue(jsonRes(status, { error: "x" }));
      await expect(
        new HttpSolanaRemittanceIdResolver(popOk()).lookupBySender(SENDER),
      ).rejects.toThrow("escrow_recovery_unavailable");
    }
  });

  it("T-R0-11: 200 con shape deforme ⇒ answered con lista vacía (nunca undefined/NaN aguas abajo)", async () => {
    for (const body of [{}, { remittanceIds: [] }, { remittanceIds: [{}, { remittanceId: 7 }, { remittanceId: "" }] }]) {
      fetchMock.mockResolvedValue(jsonRes(200, body));
      await expect(
        new HttpSolanaRemittanceIdResolver(popOk()).lookupBySender(SENDER),
      ).resolves.toEqual({ outcome: "answered", remittanceIds: [] });
    }
  });

  it("T-R0-11: filtra los ids no-string y conserva los válidos", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(200, { remittanceIds: [{ remittanceId: null }, { remittanceId: "rem-ok" }] }),
    );
    await expect(
      new HttpSolanaRemittanceIdResolver(popOk()).lookupBySender(SENDER),
    ).resolves.toEqual({ outcome: "answered", remittanceIds: ["rem-ok"] });
  });
});

// 🔴 2º fix-pack (AR/BLQ-MED-2). Los de acá clavan que "lista vacía" NO es la única lectura posible
// de un intercambio que no trajo ids: hay tres desenlaces distintos de "el servidor contestó que no
// hay nada", y son los que separan poder afirmar algo sobre la billetera de alguien de no poder. Sin
// estos, un cambio que devolviera `answered/[]` en el 501 pasaría los casos de arriba sin romper nada.
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
});

// 🔴 3er fix-pack (AR/BLQ-MED-1) — el TERCER salto del camino de recuperación que enumera C-3.
// Los otros dos (el ledger y la ruta) ya tienen su candado con fixture LOCAL (T-330-5a / T-330-5b).
// Éste es el que traduce la respuesta HTTP a la lista de remittanceId con la que la persona pide el
// refund trustless de su escrow, y hasta este `describe` estaba candeado SÓLO por el literal
// `status: "prepared"` del fixture de T-R0-11 (`:40`) — un fixture escrito para probar la FORMA del
// POST, que nadie tiene motivo de mantener en 'prepared'.
//
// 🟩 MEDIDO por el AR sobre `b0be6fd`: cambiando ese literal a `"principal_in"` e insertando en
// `http-solana-remittance-id-resolver.ts:43` un `.filter((r) => r.status !== "prepared")` antes del
// `.map`, la suite completa quedaba `90 passed / 1391 passed`, EXIT=0 — VERDE ENTERA. Y el mutante
// solo (sin tocar el literal) moría por `T-R0-11`, que es un test sobre el cuerpo del POST: quien
// leyera ese rojo aprendía que rompió el request, NO que dejó irrecuperable un depósito real.
// Ése es exactamente el defecto que esta HU existe para matar, un salto más abajo.
//
// El fixture de acá es LOCAL y propio: no comparte una sola constante con los `describe` de arriba.
describe("HttpSolanaRemittanceIdResolver — 3er salto de C-3: la fila 'prepared' del depósito real (WKH-330/AC-5)", () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("T-330-5c: conserva el remittanceId de la fila 'prepared' — es el depósito real cuyo write falló, y sin ese id no hay refund", async () => {
    // Fixture LOCAL: el par exacto que importa, y nada más.
    //   · WRITE_FALLIDO es la fila de WKH-330: el depósito OCURRIÓ on-chain (la signature está
    //     verificada) y el write que la movía a 'principal_in' falló por infra (SQLSTATE clase 08),
    //     así que quedó en 'prepared'. 'prepared' dice "no hay depósito REGISTRADO", que NO es lo
    //     mismo que "no hubo depósito".
    //   · TERMINAL es una fila normal, y está para que el assert de abajo no pueda pasar por la vía
    //     de que el resolver devuelva todo o se rompa.
    const WRITE_FALLIDO = "rem-330-resolver-write-fallido";
    const TERMINAL = "rem-330-resolver-settled";
    fetchMock.mockResolvedValue(
      jsonRes(200, {
        remittanceIds: [
          { remittanceId: WRITE_FALLIDO, status: "prepared", createdAt: "2026-08-06T00:00:00.000Z" },
          { remittanceId: TERMINAL, status: "settled", createdAt: "2026-08-05T00:00:00.000Z" },
        ],
      }),
    );

    const out = await new HttpSolanaRemittanceIdResolver(popOk()).lookupBySender(SENDER);
    // Si el desenlace dejara de ser `answered`, `ids` queda `[]` y el assert nombrado de abajo es el
    // que se pone rojo — que es lo que se quiere: el rojo tiene que hablar de la recuperación.
    const ids = out.outcome === "answered" ? [...out.remittanceIds] : [];

    expect(
      ids,
      "el resolver dejó de devolver el remittanceId de la fila 'prepared': el depósito real cuyo write falló se volvió irrecuperable desde el navegador y la persona no puede pedir el refund trustless de su escrow",
    ).toContain(WRITE_FALLIDO);
    // Control de no-vacuidad: el filtro que se persigue descarta 'prepared' y deja pasar el resto, así
    // que sin este assert un resolver que devolviera SIEMPRE `[WRITE_FALLIDO]` también pasaría.
    expect(ids).toContain(TERMINAL);
  });
});
