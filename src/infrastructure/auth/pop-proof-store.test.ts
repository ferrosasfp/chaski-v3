// Tests — InMemoryPopProofStore (WKH-337). Comportamiento + el candado estático que ata los DOS
// literales de TTL que no se pueden derivar por import.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Clock } from "../../application/ports";
import { InMemoryPopProofStore } from "./pop-proof-store";

/** Reloj movible: el almacén NO usa `Date.now()`, así que el test controla el tiempo sin `vi.useFakeTimers`. */
class RelojMovible implements Clock {
  constructor(private ms = Date.parse("2026-08-08T12:00:00.000Z")) {}
  nowIso(): string {
    return new Date(this.ms).toISOString();
  }
  avanzar(ms: number): void {
    this.ms += ms;
  }
}
const PROOF = { challenge: "ch-1", signature: "sig-1" };
const ADDR_A = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ADDR_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("InMemoryPopProofStore — la prueba se OBSERVA, y vence (WKH-337)", () => {
  it("sin nada grabado, peek devuelve null (no un objeto vacío ni una prueba inventada)", () => {
    expect(new InMemoryPopProofStore(new RelojMovible()).peek(ADDR_A)).toBeNull();
  });

  it("lo grabado se puede leer, y sólo para SU address (el Map es por dueño)", () => {
    const store = new InMemoryPopProofStore(new RelojMovible());
    store.record(ADDR_A, PROOF);
    expect(store.peek(ADDR_A)).toEqual(PROOF);
    expect(store.peek(ADDR_B)).toBeNull(); // la prueba de A no sirve para pedir por B
  });

  it("la última grabada gana (una prueba más nueva siempre es preferible)", () => {
    const store = new InMemoryPopProofStore(new RelojMovible());
    store.record(ADDR_A, PROOF);
    store.record(ADDR_A, { challenge: "ch-2", signature: "sig-2" });
    expect(store.peek(ADDR_A)).toEqual({ challenge: "ch-2", signature: "sig-2" });
  });

  it("a los 8 minutos EXACTOS ya no se entrega: el borde es >=, no >", () => {
    const reloj = new RelojMovible();
    const store = new InMemoryPopProofStore(reloj);
    store.record(ADDR_A, PROOF);
    reloj.avanzar(8 * 60 * 1000 - 1);
    expect(store.peek(ADDR_A), "un ms antes del vencimiento todavía vale").toEqual(PROOF);
    reloj.avanzar(1);
    expect(store.peek(ADDR_A), "en el ms exacto del vencimiento ya no vale").toBeNull();
  });

  // 🔴 R-1, DECLARADO Y NO MITIGADO ACÁ. Pasada la ventana sin ningún gesto, el seguimiento deja de
  // leer y la remesa se queda en `payout_submitted` — que es EXACTAMENTE el comportamiento de hoy, o
  // sea la dirección segura. El sistema no miente: calla. Lo que renueva la ventana es cualquier acción
  // de la persona, porque los tres call-sites de `prove()` cuelgan de un gesto.
  it("R-1: vencida y sin gesto nuevo, sigue en null — NO se auto-renueva sola", () => {
    const reloj = new RelojMovible();
    const store = new InMemoryPopProofStore(reloj);
    store.record(ADDR_A, PROOF);
    reloj.avanzar(60 * 60 * 1000); // una hora
    expect(store.peek(ADDR_A)).toBeNull();
    expect(store.peek(ADDR_A)).toBeNull(); // y el segundo peek tampoco la resucita
    store.record(ADDR_A, PROOF); // un gesto nuevo la renueva
    expect(store.peek(ADDR_A)).toEqual(PROOF);
  });

  it("un reloj ilegible NO deja la prueba válida para siempre (NaN compara false en todo)", () => {
    const roto: Clock = { nowIso: () => "no soy una fecha" };
    const store = new InMemoryPopProofStore(roto);
    store.record(ADDR_A, PROOF);
    // Sin el guard de `Number.isFinite`, `NaN - NaN >= TTL` es `false` ⇒ la prueba se entregaría
    // eternamente. Un reloj que no se puede leer cae del lado seguro: sin prueba.
    expect(store.peek(ADDR_A)).toBeNull();
  });
});

// ── 🔴 T-337.5 · el candado estático que ata los DOS literales (CD-12) ───────────────────────────────
//
// POR QUÉ ES ESTÁTICO Y NO UN IMPORT. `pop-challenge.ts` importa `node:crypto`, así que no se puede
// importar desde el bundle del browser — y `InMemoryPopProofStore` se instancia en el composition root,
// que ES código de cliente. Entonces el TTL del cliente es un SEGUNDO literal, y un segundo literal sin
// candado es el punto ciego que el Auto-Blindaje de WKH-336 nombra: los dos números pueden divergir y
// nada se pone rojo. El día que el del cliente supere al del server, el almacén entregaría pruebas que
// el server ya rechaza por vencidas y el seguimiento pagaría una request + una verificación de firma
// para obtener el mismo "no sé" que tenía gratis.
//
// Exemplar: `T-336.6 (estático)` (`app/api/a2a/plan/route.test.ts:336`) — `readFileSync` + comparar los
// dos valores + `toBeTypeOf` ANTES de comparar.
//
// ⚠️ Y NO ALCANZA CON COMPARAR: si las dos regex dejaran de matchear, `undefined < undefined` sería
// `false` y el `expect(...).toBe(true)` se pondría rojo por la razón equivocada, o peor, una comparación
// laxa daría verde aplaudiendo el vacío. Por eso los dos `toBeTypeOf("number")` van ANTES: son la parte
// que impide que este candado se compare consigo mismo.
//
// ⚠️ Este candado NO clava los valores: mover los DOS conservando la desigualdad lo deja verde a
// propósito. Lo que clava es la RELACIÓN, igual que T-336.6 con el label del leg.
describe("T-337.5 (estático): el TTL de la prueba observada es MENOR que el del challenge", () => {
  const leer = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), "utf8");

  it("POP_PROOF_TTL_MS < POP_CHALLENGE_TTL_SECONDS × 1000", () => {
    // El del SERVER, en segundos, con su forma exacta de declaración.
    const mServer = /export const POP_CHALLENGE_TTL_SECONDS = (\d+) \* (\d+);/.exec(
      leer("src/infrastructure/auth/pop-challenge.ts"),
    );
    const servidorMs =
      mServer === null ? undefined : Number(mServer[1]) * Number(mServer[2]) * 1000;
    // El del CLIENTE, en ms.
    const mCliente = /const POP_PROOF_TTL_MS = (\d+) \* (\d+) \* (\d+);/.exec(
      leer("src/infrastructure/auth/pop-proof-store.ts"),
    );
    const clienteMs =
      mCliente === null
        ? undefined
        : Number(mCliente[1]) * Number(mCliente[2]) * Number(mCliente[3]);

    // Sin estos dos, un cambio de FORMA (no de valor) dejaría el candado vacío y en verde.
    expect(
      servidorMs,
      "`pop-challenge.ts` ya no declara POP_CHALLENGE_TTL_SECONDS donde el candado lo busca: el " +
        "candado quedó ciego y hay que reapuntarlo, no borrarlo",
    ).toBeTypeOf("number");
    expect(
      clienteMs,
      "`pop-proof-store.ts` ya no declara POP_PROOF_TTL_MS donde el candado lo busca: ídem",
    ).toBeTypeOf("number");

    // El invariante: la prueba observada NUNCA puede sobrevivir al challenge que la valida.
    expect(
      (clienteMs as number) < (servidorMs as number),
      `POP_PROOF_TTL_MS (${clienteMs} ms) tiene que ser MENOR que POP_CHALLENGE_TTL_SECONDS×1000 ` +
        `(${servidorMs} ms), o el almacén entrega pruebas que el server rechaza por vencidas`,
    ).toBe(true);
  });
});
