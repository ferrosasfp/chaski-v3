// Tests — el predicado de ownership sobre una entrada YA GUARDADA (WKH-348 / AC-1, AC-5, AC-7).
//
// 🔴 QUÉ PROBLEMA CIERRA. `LocalRepo.list()` canonicalizaba el `ownerAddress` de cada entrada DENTRO
// del predicado de un `.filter()`. `Array.prototype.filter` no atrapa excepciones del predicado y
// `canonicalizeAddress` tira ante cualquier valor que no sea una pubkey base58 de 32 bytes ⇒ UNA
// entrada que no se puede atribuir hacía desaparecer la lista ENTERA, y no se arreglaba sola porque
// el blob de `localStorage` no cambia por sí mismo.
//
// ⛔ LO QUE ESTE PREDICADO NO HACE, y no se puede escribir de otra manera (AC-5): la entrada cuyo
// `ownerAddress` no canonicaliza NO se atribuye a nadie. No se puede atribuir lo que no canonicaliza.
// Lo único que cambia es que deja de tapar a las demás.
//
// LA ASIMETRÍA QUE SE MIDE ACÁ (T-10): el veredicto del predicado es el de `PublicKey`, no el de un
// regex de base58 ni el de un largo. `"z".repeat(44)` pasa `^[1-9A-HJ-NP-Za-km-z]{32,44}$` y sin
// embargo NO es una pubkey; `"1".repeat(32)` sí lo es. Un pre-filtro por forma aceptaría la primera.
//
// CD-19: ningún esperado de acá se calcula llamando al predicado que se vigila. Son literales
// (`true`/`false`) escritos a mano.
import { describe, expect, it } from "vitest";
import { canonicalizeAddress, isOwnedBy } from "./address";

// Las MISMAS pubkeys que ya usan `persistence.test.ts` y `address.test.ts`: no se redefinen con otro
// valor para que un fixture no diverja del otro.
const A = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Veneno: los tres valores que hoy hacen tirar al filtro. `P_EVM` es el literal de `address.test.ts`,
// que ya prueba que tira. `P_B58` es el que separa la delegación de un pre-filtro por regex.
const P_EMPTY = "";
const P_EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const P_B58 = "z".repeat(44);

describe("isOwnedBy — el predicado de ownership de una entrada guardada (WKH-348)", () => {
  // ── T-7 ────────────────────────────────────────────────────────────────────────────────────────
  // ROJO en W0 por símbolo inexistente. Después: la unidad del predicado, valor por valor.
  it("T-7: la entrada del dueño matchea; la de otro dueño, la sin dueño y las tres venenosas NO", () => {
    const target = canonicalizeAddress(A);
    expect(isOwnedBy({ ownerAddress: A }, target)).toBe(true);
    expect(isOwnedBy({ ownerAddress: B }, target)).toBe(false);
    // Regla 1 — preserva WKH-201/AC-7: la remesa abandonada sin verificar sigue excluida.
    expect(isOwnedBy({ ownerAddress: null }, target)).toBe(false);
    // Regla 2 — no canonicaliza ⇒ false, y SIN lanzar (eso es lo que hoy se lleva la lista entera).
    expect(isOwnedBy({ ownerAddress: P_EMPTY }, target)).toBe(false);
    expect(isOwnedBy({ ownerAddress: P_EVM }, target)).toBe(false);
    expect(isOwnedBy({ ownerAddress: P_B58 }, target)).toBe(false);
  });

  it("T-7: la entrada de OTRO dueño no matchea con su propio target (el scope es por dueño)", () => {
    expect(isOwnedBy({ ownerAddress: B }, canonicalizeAddress(B))).toBe(true);
    expect(isOwnedBy({ ownerAddress: A }, canonicalizeAddress(B))).toBe(false);
  });

  // ── T-8 ────────────────────────────────────────────────────────────────────────────────────────
  // El invariante que cerró el IDOR de HU-SOL-7, aplicado al predicado nuevo. Mutante que lo mata:
  // m2 — cualquier `.toLowerCase()`, `localeCompare` o comparación laxa en los dos lados.
  it("T-8: CASE-SENSITIVE siempre — bajar el case de cualquiera de los dos lados NO fabrica un match", () => {
    expect(isOwnedBy({ ownerAddress: A }, canonicalizeAddress(A).toLowerCase())).toBe(false);
    expect(isOwnedBy({ ownerAddress: A.toLowerCase() }, canonicalizeAddress(A))).toBe(false);
  });

  // ── T-9 ────────────────────────────────────────────────────────────────────────────────────────
  // 🔴 EL CASO QUE CONVIERTE LA TOLERANCIA EN UN IDOR SI FALTA UNA LÍNEA. Si la canonicalización del
  // `ownerAddress` da `null` y eso se compara directo contra el target, un `canonicalTarget` nulo en
  // runtime (un caller JS sin tipos) daría `null === null` ⇒ `true` ⇒ la entrada que no se puede
  // atribuir se atribuiría a quien pregunta. Mutante que lo mata: m1 — quitar el chequeo explícito
  // de `null` antes de comparar.
  //
  // Se usa un CAST y no `@ts-expect-error`: un `@ts-expect-error` en un archivo que el tsconfig no
  // evalúa no lo mira nadie.
  it("T-9: ownerAddress que no canonicaliza + target nulo en runtime ⇒ false, NUNCA un match", () => {
    expect(isOwnedBy({ ownerAddress: P_EMPTY }, null as unknown as string)).toBe(false);
    expect(isOwnedBy({ ownerAddress: P_EVM }, null as unknown as string)).toBe(false);
    expect(isOwnedBy({ ownerAddress: null }, null as unknown as string)).toBe(false);
  });

  // ── T-10 ───────────────────────────────────────────────────────────────────────────────────────
  // El veredicto es el de `PublicKey`, medido con los dos inputs que separan las opciones. Mutante
  // que lo mata: reemplazar la delegación por un regex de base58 o por un chequeo de largo.
  it("T-10: el veredicto es el de PublicKey, no el de un regex de base58 ni el de un largo", () => {
    // 44 caracteres, todos del alfabeto base58, y NO es una pubkey: un pre-filtro por forma lo
    // aceptaría y después la canonicalización tiraría igual.
    expect(P_B58).toHaveLength(44);
    expect(isOwnedBy({ ownerAddress: P_B58 }, canonicalizeAddress(A))).toBe(false);
    // 32 caracteres y SÍ es una pubkey válida (32 bytes en cero): un filtro por largo la rechazaría
    // y le sacaría al dueño una entrada que es suya.
    const zeros = "1".repeat(32);
    expect(isOwnedBy({ ownerAddress: zeros }, canonicalizeAddress(zeros))).toBe(true);
  });

  // ── T-11 ───────────────────────────────────────────────────────────────────────────────────────
  it("T-11: el predicado NO lanza, y el error del módulo NO ecoa la address descartada", () => {
    expect(() => isOwnedBy({ ownerAddress: P_EVM }, canonicalizeAddress(A))).not.toThrow();
    expect(() => isOwnedBy({ ownerAddress: P_EMPTY }, canonicalizeAddress(A))).not.toThrow();
    expect(() => isOwnedBy({ ownerAddress: P_B58 }, canonicalizeAddress(A))).not.toThrow();
    // Y el único error que este módulo produce sigue sin filtrar el input en un log.
    try {
      canonicalizeAddress(P_EVM);
      throw new Error("debió tirar");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toBe("address_canonicalization_failed");
      expect(msg).not.toContain(P_EVM);
    }
  });
});
