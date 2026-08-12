// Contrato de ownership de `RemittanceRepository`: las MISMAS aserciones contra las DOS
// implementaciones (WKH-348 / AC-6).
//
// 🔴 QUÉ PROBLEMA CIERRA, Y POR QUÉ NO ALCANZABA CON ARREGLAR LOS DOS ARCHIVOS. `LocalRepo` y el
// doble `InMemoryRepo` tenían el mismo defecto porque el predicado de ownership estaba COPIADO A MANO
// en los dos. Arreglar las dos copias cumple el AC de hoy y deja intacto el mecanismo para la próxima
// vez. De ahí los dos mecanismos, con roles distintos:
//   1. PREVENCIÓN — el predicado existe UNA vez (`isOwnedBy`, en `infrastructure/address.ts`) y las
//      dos implementaciones lo importan. No hay dos textos que puedan divergir porque no hay dos
//      textos. Es el mismo criterio que el propio `fakes.ts` ya aplica a `REAL_PAYOUT_PROVENANCES`:
//      "un segundo Set con los mismos valores es exactamente cómo se desincronizan las dos capas".
//   2. DETECCIÓN — este archivo. La prevención NO impide que alguien, en tres meses, vuelva a escribir
//      un predicado inline en UNA de las dos. Eso lo caza esto, y con estos inputs concretos:
//      · veneno de las TRES familias en el almacén (vacío, EVM, y 44 caracteres del alfabeto base58 que
//        NO son una pubkey) ⇒ un re-inline que vuelva a canonicalizar el `ownerAddress` dentro del
//        `.filter()` tira, incluso si se protege con un pre-filtro por regex de base58: `P_B58` lo
//        atraviesa. Sin `P_B58` en el almacén ese re-inline pasaba en verde, y así se midió.
//      · la aserción de que el reset NO borra lo no atribuible (CD-18) ⇒ un `clearByOwner` que se
//        vuelva MÁS tolerante que el otro se pone rojo en su propia corrida. Sin esa aserción, un
//        `InMemoryRepo.clearByOwner` que borrara también lo no atribuible pasaba en verde.
//      ⚠️ Lo que este contrato NO caza, dicho en vez de sugerido: un re-inline con el MISMO
//      comportamiento observable (por ejemplo un regex que devuelva el valor crudo sin canonicalizar
//      nada). Acá se mide comportamiento, no texto, y ese caso no tiene comportamiento distinto en
//      ninguno de estos inputs. Lo mata la unidad de `isOwnedBy` (T-10, con un target crudo).
//
// Un tercer mecanismo evaluado y descartado: comparar el TEXTO FUENTE de los dos métodos. Es frágil
// (un rename lo rompe), no dice nada del comportamiento, y crea el falso verde inverso: dos textos
// idénticos con el mismo bug pasan.
//
// ⛔ QUÉ QUEDA AFUERA, A PROPÓSITO Y ESCRITO:
//   · `ThrowingClearByOwnerRepo` (el doble del storage roto de WKH-201/AC-4). Su contrato ES lanzar
//     siempre. Meterlo acá lo pondría rojo por diseño y la "solución" sería debilitar el contrato.
//   · Si aparece una 3ª implementación de `RemittanceRepository`, NADA la agrega sola: extender la
//     tabla es obligación de quien la escriba. Esto es CONVENCIÓN CON UN ROJO, no construcción.
//
// ⛔ QUÉ NO MIDE ESTE CONTRATO:
//   · EL ORDEN. `LocalRepo.list` ordena por `createdAt` descendente y `InMemoryRepo.list` no ordena.
//     Esa divergencia es PREEXISTENTE, está fuera de AC-6 y no se toca acá. Por eso las aserciones
//     comparan CONJUNTOS (ids ordenados alfabéticamente). El orden de `LocalRepo` lo asserta T-1c, en
//     `persistence.test.ts`, con dos entradas de `createdAt` distinto. 🔴 Hasta el fix-pack de la ronda
//     1, esta línea decía que el orden "se sigue asertando en `persistence.test.ts`" y no se asertaba
//     en NINGUNA parte: todos los fixtures de ese archivo se sembraban con el mismo `createdAt`, así
//     que reemplazar el `.sort(...)` por `.sort(() => 0)` dejaba la suite entera en verde.
//   · La persistencia real del blob más allá de lo que cada implementación hace por su cuenta.
//
// FORMA DEL BLOQUE PARAMÉTRICO: `for (… of IMPLS) { describe(…) }`, que es la convención viva del
// repo (79 `it.each` y este bucle; `describe.each` tiene CERO precedentes acá). `describe.each`
// también funcionaría; se eligió la que ya tiene exemplars en casa.
//
// 🔴 Y POR QUÉ EL GUARD DE VACUIDAD VA FUERA DEL BUCLE: un bucle sobre una lista vacía deja el archivo
// entero en verde SIN EJECUTAR NADA. Cero tests, cero fallos, exit 0: así es como un guard deja de
// existir sin que nadie lo note. Si el guard estuviera adentro, desaparecería junto con todo lo demás,
// que es justo el agujero que se quiere tapar.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RemittanceRepository } from "../application/ports";
import { Money } from "../domain/money";
import { type Quote, Remittance } from "../domain/remittance";
import { InMemoryRepo, beneficiary } from "../test-support/fakes";
import { LocalRepo } from "./persistence";

const KEY = "chaski.remittances.v1";
const NOW = "2026-07-11T00:00:00.000Z";

// TERCERA copia del stub de Storage, y a propósito: el de `persistence.test.ts` es local a ese
// archivo y NO se exporta, y ese archivo es append-only en esta HU (exportarlo sería editar sus
// primeras líneas). El precedente de duplicarlo ya existe en `kyc-store.test.ts`.
class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(key: string): string | null {
    return this.m.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.m.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  setItem(key: string, value: string): void {
    this.m.set(key, value);
  }
}

// 🔴 El stub de `window.localStorage` HACE FALTA aunque parezca que no: sin `window`, `LocalRepo.read`
// cae a su Map en memoria y `write` también, y ese camino NO pasa por el `JSON.parse` ni por
// `normalizeState`. Un contrato sin stub mediría un `LocalRepo` que nunca toca el blob, o sea MENOS de
// lo que su nombre afirma.
let storage: MemStorage;
beforeEach(() => {
  storage = new MemStorage();
  (globalThis as { window?: { localStorage: Storage } }).window = { localStorage: storage };
});
afterEach(() => {
  storage.removeItem(KEY);
  delete (globalThis as { window?: unknown }).window;
});

const quote: Quote = {
  quoteId: "q",
  send: Money.of(400, "USDC"),
  receive: Money.of(1480, "PEN"),
  feeUsd: Money.of(0.5, "USDC"),
  rate: 3.7,
  etaMinutes: 30,
  expiresAt: "2026-07-11T01:00:00.000Z", // > NOW
  provenance: "fake",
};

// Las mismas pubkeys que `persistence.test.ts`, y el mismo veneno. WKH-187: se cotiza ANTES del KYC,
// así que sin `attachQuote` la transición sería inválida y el test mediría el andamiaje.
const A = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const P_EMPTY = "";
const P_EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
// 🔴 `P_B58` no es decorativo: es el ÚNICO de los tres que atraviesa un regex de base58, o sea el
// input que separa la delegación a `PublicKey` de un pre-filtro por forma. `P_EMPTY` y `P_EVM` fallan
// cualquier regex de base58, así que sin esta tercera familia un re-inline con pre-filtro por regex
// nunca llegaba a canonicalizar y el contrato pasaba en verde. Es el mismo veneno que usa T-1b.
const P_B58 = "z".repeat(44);

async function sembrar(repo: RemittanceRepository, id: string, owner: string): Promise<void> {
  const r = Remittance.create(id, beneficiary(), Money.of(400, "USDC"), NOW);
  r.attachQuote(quote, NOW);
  r.startKyc(NOW, owner); // el dominio NO valida acá, así que siembra igual en las dos
  await repo.save(r);
}

/** El conjunto de ids, ordenado alfabéticamente: el contrato compara CONJUNTOS, no orden (R-3). */
function ids(states: { id: string }[]): string[] {
  return states.map((s) => s.id).sort();
}

const IMPLS: ReadonlyArray<readonly [string, () => RemittanceRepository]> = [
  ["LocalRepo", () => new LocalRepo()],
  ["InMemoryRepo", () => new InMemoryRepo()],
];

describe("contrato de ownership de RemittanceRepository (WKH-348/AC-6)", () => {
  it("el contrato corre con las DOS implementaciones (si la lista quedara vacía, nada podría fallar)", () => {
    expect(IMPLS.map(([nombre]) => nombre)).toEqual(["LocalRepo", "InMemoryRepo"]);
  });
});

// ── T-5 ──────────────────────────────────────────────────────────────────────────────────────────
// ROJO ANTES DEL CAMBIO EN LAS DOS CORRIDAS: las dos rechazaban con `address_canonicalization_failed`
// en cuanto el blob tenía una entrada que no se puede atribuir. Éste es exactamente el test que hoy
// no se podía escribir en la capa de aplicación, porque el propio doble lanzaba primero.
for (const [nombre, crear] of IMPLS) {
  describe(`T-5 · ${nombre}`, () => {
    it("con veneno de las TRES familias en el almacén, list(A) trae EXACTAMENTE lo de A", async () => {
      const repo = crear();
      await sembrar(repo, "a1", A);
      await sembrar(repo, "b1", B);
      await sembrar(repo, "p1", P_EMPTY);
      await sembrar(repo, "p2", P_EVM);
      await sembrar(repo, "p3", P_B58); // el que atraviesa un pre-filtro por regex

      expect(ids(await repo.list(A))).toEqual(["a1"]);
      expect(ids(await repo.list(B))).toEqual(["b1"]);
    });

    it("clearByOwner(A) NO rechaza con veneno presente, no toca a B y NO borra lo no atribuible", async () => {
      const repo = crear();
      await sembrar(repo, "a1", A);
      await sembrar(repo, "b1", B);
      await sembrar(repo, "p1", P_EMPTY);
      await sembrar(repo, "p2", P_EVM);
      await sembrar(repo, "p3", P_B58);

      await expect(repo.clearByOwner(A)).resolves.toBeUndefined();

      expect(ids(await repo.list(A))).toEqual([]);
      expect(ids(await repo.list(B))).toEqual(["b1"]);
      // CD-18 en las DOS implementaciones: borrar lo que no se puede atribuir ES atribuirlo a quien
      // pidió el reset, y destruye el único dato con el que algún día se podría atribuir. Sin estas
      // tres líneas, un `clearByOwner` que se volviera MÁS tolerante que el otro pasaba en verde: las
      // aserciones de `list` no lo ven, porque lo no atribuible no aparece en ninguna lista scopeada.
      expect((await repo.get("p1"))?.snapshot.ownerAddress).toBe(P_EMPTY);
      expect((await repo.get("p2"))?.snapshot.ownerAddress).toBe(P_EVM);
      expect((await repo.get("p3"))?.snapshot.ownerAddress).toBe(P_B58);
    });

    // AC-3 vale en las DOS: la tolerancia es sobre el dato guardado, nunca sobre la identidad de
    // quien pregunta. PRESERVACIÓN en las dos corridas.
    it("el target sigue fail-closed (PRESERVACIÓN): list de una address inválida RECHAZA", async () => {
      const repo = crear();
      await sembrar(repo, "a1", A);
      await sembrar(repo, "p1", P_EMPTY);

      await expect(repo.list("no-base58-!!!")).rejects.toThrow("address_canonicalization_failed");
    });
  });
}
