import { PublicKey } from "@solana/web3.js";

/**
 * Canonicalización de address Solana (HU-SOL-7 / WKH-213).
 * Round-trip new PublicKey(address).toBase58(): valida base58 32 bytes y normaliza la codificación
 * canónica. CASE-SENSITIVE ⇒ cierra la colisión IDOR que abrió HU-SOL-7. Malformado → throw
 * (fail-closed, no ecoa la address).
 *
 * La firma es de UN argumento a propósito: no hay nada que despachar, así que ninguna address
 * ajena al formato puede atravesar un borde de confianza sin que esto tire.
 * PROHIBIDO .toLowerCase() sobre base58 (CD-7).
 */
export function canonicalizeAddress(address: string): string {
  try {
    return new PublicKey(address).toBase58();
  } catch {
    throw new Error("address_canonicalization_failed");
  }
}

/**
 * Canonicalización TOLERANTE, y el único consumidor es el predicado de abajo (WKH-348 / CD-9).
 *
 * 🚫 NO SE EXPORTA, y las tres razones para exportarla suenan bien y ninguna alcanza:
 *   · "así la testeo directo" — se testea A TRAVÉS de `isOwnedBy`, que es observable. Un helper con
 *     test propio y sin consumidor legítimo es superficie muerta en un borde de confianza.
 *   · "kyc-store y payout/authority tienen el mismo problema" — no lo tienen: canonicalizan UN valor
 *     que viene del caller o de la red, no iteran lo guardado.
 *   · "así `isOwnedBy` no tiene que existir" — `isOwnedBy` devuelve un boolean, y un boolean no se
 *     puede usar para canonicalizar nada. Exportar esto sería una afordancia para convertir cualquier
 *     borde fail-closed en fail-open, justo al lado del borde que cerró HU-SOL-7.
 * La alternativa evaluada era exportarla con un candado textual de call-sites permitidos. Se descartó:
 * un candado textual le pone un NÚMERO al agujero. No exportarla lo elimina.
 */
function canonicalOrNull(raw: string): string | null {
  try {
    return canonicalizeAddress(raw);
  } catch {
    return null;
  }
}

/**
 * ¿Esta entrada YA GUARDADA es del dueño que pregunta? (WKH-348 / AC-1, AC-5, AC-6, AC-7)
 *
 * Existe UNA sola vez: `LocalRepo` y el doble `InMemoryRepo` lo IMPORTAN en vez de copiarlo. Cuatro
 * copias del mismo criterio son el mecanismo de drift que esta HU cierra (CD-5/CD-11). El precedente
 * de "descartá la entrada mala, conservá las buenas" ya está en producción en este repo, sobre el
 * mismo tipo de blob: (`isEntry`, `kyc-store.ts:85`). Y la mitad de arriba de `persistence.ts` ya es
 * tolerante — su docblock dice "Normaliza al shape reducido SIN crashear"—; el filtro por dueño era
 * el outlier.
 *
 * LAS 6 REGLAS, cada una con su test:
 *  1. `stored.ownerAddress == null` ⇒ `false`. Preserva WKH-201/AC-7: la remesa abandonada sin
 *     verificar sigue excluida de cualquier lista scopeada (T-7).
 *  2. Un `ownerAddress` que NO canonicaliza ⇒ `false`, SIN lanzar. Eso es lo único que cambia en el
 *     comportamiento: esa entrada deja de tapar a las demás (T-7, T-11).
 *  3. 🔴 Si la canonicalización del `ownerAddress` da `null`, NUNCA puede haber match: el `null` se
 *     chequea EXPLÍCITAMENTE antes de comparar. Sin esa línea, un `canonicalTarget` nulo en runtime
 *     (un caller JS sin tipos) daría `null === null` ⇒ `true` ⇒ una entrada que no se puede atribuir
 *     se atribuiría a quien pregunta: un IDOR (T-9).
 *  4. `canonicalTarget` llega YA canonicalizado; esto NO lo canonicaliza. Un valor crudo no matchea
 *     (falla cerrado, nunca filtra). El fail-loud del target lo garantiza el CALLER, a la vista y
 *     testeable ahí (T-4).
 *  5. CASE-SENSITIVE siempre. Único comparador: `===` sobre la salida de `PublicKey.toBase58()`.
 *     PROHIBIDO `.toLowerCase()`, `localeCompare`, normalización Unicode o comparación laxa: eso
 *     fabrica la colisión IDOR que cerró HU-SOL-7 (T-8).
 *  6. No ecoa ni loguea el `ownerAddress` descartado. Si algún día se quiere observabilidad, el único
 *     dato publicable es el CONTEO, y eso es otra HU (T-11).
 *
 * ⛔ Lo que este predicado NO hace: no atribuye la entrada cuyo `ownerAddress` no canonicaliza. No se
 * puede atribuir lo que no canonicaliza, y por eso esa entrada tampoco se borra en un reset (AC-5).
 *
 * El parámetro es ESTRUCTURAL (`{ ownerAddress: string | null }`) y no `RemittanceState`: importar el
 * dominio desde infraestructura crearía una arista que nadie pidió. Este archivo sigue dependiendo
 * sólo de `@solana/web3.js`.
 */
export function isOwnedBy(
  stored: { ownerAddress: string | null },
  canonicalTarget: string,
): boolean {
  if (stored.ownerAddress == null) return false; // regla 1
  const owner = canonicalOrNull(stored.ownerAddress); // regla 2
  if (owner === null) return false; // regla 3 — sin esta línea, `null === null` sería un match
  return owner === canonicalTarget; // reglas 4 y 5
}
