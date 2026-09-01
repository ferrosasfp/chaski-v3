// Tests — InMemorySesionStore (WKH-372/W3.4). Comportamiento + el candado estático que ata los DOS
// literales de TTL que no se pueden derivar por import.
//
// Molde: `./pop-proof-store.test.ts`, y no es parecido: es el MISMO problema con otra credencial, así
// que el patrón se copia en vez de inventarse.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Clock } from "../../application/ports";
import { InMemorySesionStore } from "./sesion-store";

/** Reloj movible: el almacén NO usa `Date.now()`, así que el test controla el tiempo sin fake timers. */
class RelojMovible implements Clock {
  constructor(private ms = Date.parse("2026-08-31T12:00:00.000Z")) {}
  nowIso(): string {
    return new Date(this.ms).toISOString();
  }
  avanzar(ms: number): void {
    this.ms += ms;
  }
}
const TOKEN = "payload.mac";
const ADDR_A = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ADDR_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ⛔ MUTANTES QUE MATAN A `T-372-W3-7`, y se corren POR SEPARADO:
//   (i)  en `./sesion-store.ts`, cambiar `>=` por `>` en la comparación del TTL ⇒ muere la mitad (d),
//        con el mensaje "en el ms exacto del vencimiento ya no vale";
//   (ii) borrar la línea `if (!Number.isFinite(ahora)) return null;` ⇒ muere la mitad (f), con el
//        mensaje "un reloj ilegible dejó la sesión válida para siempre".
// ⚠️ FALSO KILLED A EVITAR: un `it` que sólo probara "sin nada grabado da null" daría verde con un
// almacén que devolviera `null` SIEMPRE. Por eso cada mitad negativa viaja con su mitad positiva.
describe("InMemorySesionStore — la sesión se transporta, y vence (WKH-372/W3.4)", () => {
  it("T-372-W3-7: `peek` colapsa «no hay» y «venció» en null, borra la vencida, y un reloj ilegible cae del lado seguro", () => {
    // (a) MITAD POSITIVA, primero: sin ella todo lo de abajo lo pasaría un almacén inerte.
    const reloj = new RelojMovible();
    const store = new InMemorySesionStore(reloj);
    store.record(ADDR_A, TOKEN);
    expect(store.peek(ADDR_A), "lo grabado no se pudo leer: el almacén no transporta nada").toBe(TOKEN);

    // (b) «NO HAY» ⇒ null, y por dueño: la sesión de A no sirve para pedir por B.
    expect(store.peek(ADDR_B), "la sesión de A se entregó para B: el Map no está indexado por dueño").toBeNull();
    expect(new InMemorySesionStore(new RelojMovible()).peek(ADDR_A)).toBeNull();

    // (c) La última gana: una sesión más nueva siempre es preferible.
    store.record(ADDR_A, "otro.token");
    expect(store.peek(ADDR_A)).toBe("otro.token");

    // (d) EL BORDE ES `>=`, NO `>`  ⇒ mutante (i).
    reloj.avanzar(28 * 60 * 1000 - 1);
    expect(store.peek(ADDR_A), "un ms antes del vencimiento todavía vale").toBe("otro.token");
    reloj.avanzar(1);
    expect(store.peek(ADDR_A), "en el ms exacto del vencimiento ya no vale").toBeNull();

    // (e) Y LA BORRA: pasada la ventana no se auto-renueva sola, ni el segundo `peek` la resucita.
    reloj.avanzar(60 * 60 * 1000);
    expect(store.peek(ADDR_A)).toBeNull();
    expect(store.peek(ADDR_A)).toBeNull();
    store.record(ADDR_A, TOKEN); // un gesto nuevo la renueva, que es lo que hace el `/api/kyc/verdict`
    expect(store.peek(ADDR_A)).toBe(TOKEN);

    // (f) UN RELOJ ILEGIBLE NO DEJA LA SESIÓN VÁLIDA PARA SIEMPRE  ⇒ mutante (ii).
    // Sin el guard de `Number.isFinite`, `NaN - NaN >= TTL` es `false` ⇒ se entregaría eternamente.
    const roto = new InMemorySesionStore({ nowIso: () => "no soy una fecha" });
    roto.record(ADDR_A, TOKEN);
    expect(roto.peek(ADDR_A), "un reloj ilegible dejó la sesión válida para siempre").toBeNull();
  });

  // 🔴 EL LECTOR NO TIENE `record` Y EL ESCRITOR NO TIENE `peek`, Y ESO LO CAZA `tsc`, NO ESTE `it`.
  // Acá sólo se mide que la clase concreta implementa las DOS caras, que es lo que le permite al
  // composition root inyectar la MISMA instancia de los dos lados (lo mide `T-372-W3-16`, por nombre,
  // en `../../composition/container.test.ts`).
  it("T-372-W3-7b: la clase concreta expone las dos caras, que es lo que permite compartir la instancia", () => {
    const store = new InMemorySesionStore(new RelojMovible());
    expect(typeof store.record, "el almacén no sabe grabar").toBe("function");
    expect(typeof store.peek, "el almacén no sabe leer").toBe("function");
  });
});

// ── 🔴 EL CANDADO ESTÁTICO QUE ATA LOS DOS LITERALES ─────────────────────────────────────────────
//
// POR QUÉ ES ESTÁTICO Y NO UN IMPORT: `sesion-de-posesion.ts` importa `node:crypto`, así que no se
// puede importar desde el bundle del browser, y `InMemorySesionStore` se instancia en el composition
// root, que ES código de cliente. Entonces el TTL del cliente es un SEGUNDO literal, y dos literales
// sin candado divergen sin que nada se ponga rojo. El día que el del cliente supere al del servidor,
// el almacén entregaría sesiones que el servidor ya rechaza por vencidas y el gateway pagaría una
// request de más para replegarse al PoP que tenía gratis.
//
// Exemplar, calcado: `T-337.5 (estático)`, por nombre, en `./pop-proof-store.test.ts`.
//
// ⚠️ LOS DOS `toBeTypeOf("number")` VAN ANTES DE COMPARAR, y son la parte que impide que el candado se
// compare consigo mismo: si las regex dejaran de matchear, `undefined < undefined` sería `false` y
// esto se pondría rojo por la razón equivocada, o peor, una comparación laxa aplaudiría el vacío.
//
// ⚠️ Este candado NO clava los valores: mover los DOS conservando la desigualdad lo deja verde a
// propósito. Lo que clava es la RELACIÓN.
describe("T-372-W3-7c (estático): el TTL de la sesión del cliente es MENOR que el del servidor", () => {
  const leer = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), "utf8");

  it("SESION_STORE_TTL_MS < SESION_TTL_SECONDS × 1000", () => {
    const mServidor = /export const SESION_TTL_SECONDS = (\d+) \* (\d+);/.exec(
      leer("src/infrastructure/auth/sesion-de-posesion.ts"),
    );
    const servidorMs = mServidor === null ? undefined : Number(mServidor[1]) * Number(mServidor[2]) * 1000;
    const mCliente = /const SESION_STORE_TTL_MS = (\d+) \* (\d+) \* (\d+);/.exec(
      leer("src/infrastructure/auth/sesion-store.ts"),
    );
    const clienteMs =
      mCliente === null ? undefined : Number(mCliente[1]) * Number(mCliente[2]) * Number(mCliente[3]);

    expect(
      servidorMs,
      "`sesion-de-posesion.ts` ya no declara SESION_TTL_SECONDS donde el candado lo busca: el candado " +
        "quedó ciego y hay que reapuntarlo, no borrarlo",
    ).toBeTypeOf("number");
    expect(
      clienteMs,
      "`sesion-store.ts` ya no declara SESION_STORE_TTL_MS donde el candado lo busca: ídem",
    ).toBeTypeOf("number");

    expect(
      (clienteMs as number) < (servidorMs as number),
      `SESION_STORE_TTL_MS (${clienteMs} ms) tiene que ser MENOR que SESION_TTL_SECONDS×1000 ` +
        `(${servidorMs} ms), o el almacén entrega sesiones que el servidor rechaza por vencidas`,
    ).toBe(true);
  });
});
