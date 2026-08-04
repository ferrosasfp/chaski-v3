// COPIA PINNEADA, NO SE EDITA sin SDD explícito — WKH-321 / SDD 038.
// Origen: wasiai-facilitator/src/infra/env.ts (los 3 defaults) + src/methods/solana-sponsor/cr1.ts
// (la fórmula del fee). Verificado el 2026-08-03. Sincronización provider→consumer: MANUAL
// (ver CONTRACT-VERSIONS.md:43-51 — NO hay CI cross-repo).
//
// LO QUE ESTE FIXTURE **NO** ATRAPA — tres huecos reales, escritos acá para que nadie
// le atribuya de más:
//   1. Si el facilitator BAJA un default en env.ts y nadie re-vendorea esta copia, el CI de
//      chaski-v3 sigue verde y el 422 vuelve en producción. Esto es una COPIA, no una lectura.
//   2. Si el Railway de producción del facilitator tiene un OVERRIDE distinto del default
//      (p. ej. SOLANA_SPONSOR_MAX_COMPUTE_UNITS < 120000), este fixture no se entera: pinnea
//      defaults del código, no configuración de despliegue.
//   3. Si el facilitator cambia la FÓRMULA del fee (cr1.ts:328-331), la copia de abajo queda
//      vieja y el fee derivado acá deja de ser el que el facilitator calcula.
// Lo que SÍ atrapa: que CHASKI se mueva fuera de estos topes pinneados.

export const SOLANA_SPONSOR_LIMITS = Object.freeze({
  /** wasiai-facilitator/src/infra/env.ts:214 — SOLANA_SPONSOR_MAX_COMPUTE_UNITS */
  maxComputeUnits: 300_000,
  /** wasiai-facilitator/src/infra/env.ts:215 — SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS
   *  (tope POR UNIDAD; distinto del tope agregado de abajo — confundirlos causó el bug de WKH-321) */
  maxPriorityFeeMicroLamports: 50_000,
  /** wasiai-facilitator/src/infra/env.ts:218 — SOLANA_SPONSOR_MAX_FEE_LAMPORTS (tope AGREGADO) */
  maxFeeLamports: 100_000,
});

/** Fecha ISO de la lectura de la fuente. La revisión periódica la sostiene el AR/CR (CD-13),
 *  NO un assert contra el reloj: un test que se pone rojo por el paso del tiempo entrena al
 *  equipo a ignorar el rojo. */
export const VERIFIED_AT = "2026-08-03";

/** Política de margen de SDD 038 §4.3.4: ningún valor emitido usa más del 50 % de su tope. */
export const SPONSOR_MARGIN_MAX_RATIO = 0.5;

/** Fee base por firma, en lamports. COPIA de `BASE_FEE_LAMPORTS_PER_SIG`
 *  (wasiai-facilitator/src/methods/solana-sponsor/cr1.ts:49 — allá es `5000n`, bigint). */
const BASE_FEE_LAMPORTS_PER_SIG = 5_000;

/** COPIA de la fórmula de wasiai-facilitator/src/methods/solana-sponsor/cr1.ts:328-331.
 *  Es una copia: si el provider cambia la fórmula, esto NO se entera (hueco #3 del encabezado).
 *
 *  Verbatim del origen:
 *    numSigners            = max(1, tx.signatures.length)
 *    priorityLamports      = ceil(computeUnits * priceMicroLamports / 1_000_000)
 *    feeUpperBoundLamports = 5000 * numSigners + priorityLamports
 *
 *  El `ceil` es el `ceilDiv` entero del origen (cr1.ts:330), no un redondeo de punto flotante:
 *  se replica con Math.ceil sobre enteros seguros (120_000 × 50_000 = 6e9 « 2^53). */
export function deriveFeeUpperBoundLamports(
  computeUnits: number,
  priceMicroLamports: number,
  numSigners: number,
): number {
  const signers = Math.max(1, numSigners);
  const priorityLamports = Math.ceil((computeUnits * priceMicroLamports) / 1_000_000);
  return BASE_FEE_LAMPORTS_PER_SIG * signers + priorityLamports;
}
