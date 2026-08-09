// Domain — qué proveniencias de payout representan un desembolso REAL (allowlist fail-safe, CD-8).
//
// 🔴 POR QUÉ VIVE ACÁ Y NO EN `presentation/` (CR/MNR-4). Es una REGLA DE NEGOCIO —"de qué desembolsos
// podemos afirmar que son reales"— y la consultan tres capas: la presentación (el banner de modo demo),
// la infraestructura (el ledger que clasifica un desenlace, y el gateway que lo lee) y un script de
// smoke. Mientras el conjunto estaba en `presentation/flow-vm.ts`, cada consulta desde infraestructura
// era una importación de presentación hacia adentro, o sea capas invertidas: WKH-337 introdujo DOS
// (`supabase-settlement-ledger.ts` y `test-support/fakes.ts`) y el fix-pack del CR habría agregado una
// tercera. Bajarlo a `domain/` las corrige todas y no le agrega dependencias a nadie: este módulo no
// importa nada.
//
// ⚠️ `presentation/flow-vm.ts` lo RE-EXPORTA en su línea 25, y eso es deliberado: hay 4 citas
// `archivo:línea` apuntando ahí y un candado estático que fija el TEXTO del import de
// `scripts/smoke-helpers.ts` (`scripts/smoke-helpers.test.ts:327`). El re-export mantiene las dos cosas
// verdaderas sin mover una sola línea. ⛔ No "limpies" el re-export sin re-medir esas dos.
//
// Cualquier valor desconocido/typo cae del lado seguro → muestra el banner (over-warn), nunca lo oculta.
// La comparación es EXACTA (`Set.has`): `"TransFi"` con mayúscula NO está en el conjunto, a propósito.
// Un segundo Set con los mismos valores es exactamente cómo se desincronizan las capas.
export const REAL_PAYOUT_PROVENANCES: ReadonlySet<string> = new Set(["transfi"]);

/**
 * ¿Podemos AFIRMAR que este desembolso fue real? Es la pregunta en positivo, y es la única forma segura
 * de preguntarla.
 *
 * ⛔ PROHIBIDO usar `!isPayoutDemo(p)` en su lugar: `isPayoutDemo(null)` devuelve `false` (no fuerza el
 * banner por ausencia de dato), así que su negación leería `null` —que es NO CONSTA— como REAL. Es el
 * inverso exacto del criterio, y es el mutante M3 de WKH-337.
 */
export function isRealPayoutProvenance(p: string | null | undefined): boolean {
  return typeof p === "string" && REAL_PAYOUT_PROVENANCES.has(p);
}
