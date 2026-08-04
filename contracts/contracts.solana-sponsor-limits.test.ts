// WKH-321 / SDD 038 — contract test (AC-4). Replaya los 3 topes anti-drenaje que el facilitator
// aplica a la tx de depósito patrocinada (copia pinneada en `vendored/solana-sponsor-limits.fixture.ts`,
// origen `wasiai-facilitator/src/infra/env.ts:214,215,218`) contra los valores que **Chaski emite**
// (`resolveSolanaComputeUnitLimit` / `resolveSolanaComputeUnitPriceMicroLamports`, chain.ts).
//
// Qué pone rojo: que Chaski se mueva fuera de esos topes pinneados. Qué NO detecta: que el provider
// baje un default y nadie re-vendoree la copia, ni un override de Railway distinto del default — los
// 3 huecos están escritos en el encabezado del fixture. Ver CONTRACT-VERSIONS.md.
import { describe, expect, it } from "vitest";
import {
  resolveSolanaComputeUnitLimit,
  resolveSolanaComputeUnitPriceMicroLamports,
} from "../src/infrastructure/chain";
import {
  deriveFeeUpperBoundLamports,
  SOLANA_SPONSOR_LIMITS,
  SPONSOR_MARGIN_MAX_RATIO,
  VERIFIED_AT,
} from "./vendored/solana-sponsor-limits.fixture";

// La tx de Chaski tiene 2 firmantes requeridos (feePayer facilitator + sender). Verificado sobre una
// tx deserializada: `Transaction.from(...)` conserva una entrada por firmante requerido aunque sólo
// una traiga firma, y CR-1 hace `max(1, tx.signatures.length)` (cr1.ts:329). Se deriva con 2 por ser
// el mayor de los dos casos ⇒ conservador.
const NUM_SIGNERS_CHASKI = 2;

describe("contract solana-sponsor-limits (AC-4) — lo que Chaski emite CABE en los topes pinneados", () => {
  // T7 — assert DURO: caber o no caber. Si esto se pone rojo, el depósito vuelve al 422.
  it("T7: los 3 valores emitidos caben en los topes del facilitator", () => {
    const limit = resolveSolanaComputeUnitLimit();
    const price = resolveSolanaComputeUnitPriceMicroLamports();
    const fee = deriveFeeUpperBoundLamports(limit, price, NUM_SIGNERS_CHASKI);

    expect(
      limit,
      `NO CABE: computeUnitLimit=${limit} supera SOLANA_SPONSOR_MAX_COMPUTE_UNITS=${SOLANA_SPONSOR_LIMITS.maxComputeUnits}. El facilitator rechazaría con COMPUTE_UNITS_ABOVE_MAX.`,
    ).toBeLessThanOrEqual(SOLANA_SPONSOR_LIMITS.maxComputeUnits);

    expect(
      price,
      `NO CABE: computeUnitPrice=${price} µL/CU supera SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS=${SOLANA_SPONSOR_LIMITS.maxPriorityFeeMicroLamports} (tope POR UNIDAD). El facilitator rechazaría con PRIORITY_FEE_ABOVE_MAX.`,
    ).toBeLessThanOrEqual(SOLANA_SPONSOR_LIMITS.maxPriorityFeeMicroLamports);

    expect(
      fee,
      `NO CABE: feeUpperBound=${fee} lamports supera SOLANA_SPONSOR_MAX_FEE_LAMPORTS=${SOLANA_SPONSOR_LIMITS.maxFeeLamports} (tope AGREGADO). El facilitator rechazaría con FEE_ABOVE_MAX.`,
    ).toBeLessThanOrEqual(SOLANA_SPONSOR_LIMITS.maxFeeLamports);
  });

  // T8 — assert de MARGEN, separado de T7 y con otro mensaje A PROPÓSITO: "cabe pero sin margen" y
  // "no cabe" son dos hallazgos distintos. Un solo assert los confundiría en el mismo rojo.
  it("T8: ningún valor emitido usa más del 50 % de su tope (política de margen)", () => {
    const limit = resolveSolanaComputeUnitLimit();
    const price = resolveSolanaComputeUnitPriceMicroLamports();
    const fee = deriveFeeUpperBoundLamports(limit, price, NUM_SIGNERS_CHASKI);

    expect(
      limit,
      `CABE PERO SIN MARGEN: computeUnitLimit=${limit} usa más del ${SPONSOR_MARGIN_MAX_RATIO * 100} % del tope (${SOLANA_SPONSOR_LIMITS.maxComputeUnits}). Cabe hoy, pero cualquier baja del tope o del margen del programa lo saca.`,
    ).toBeLessThanOrEqual(SPONSOR_MARGIN_MAX_RATIO * SOLANA_SPONSOR_LIMITS.maxComputeUnits);

    expect(
      price,
      `CABE PERO SIN MARGEN: computeUnitPrice=${price} usa más del ${SPONSOR_MARGIN_MAX_RATIO * 100} % del tope por unidad (${SOLANA_SPONSOR_LIMITS.maxPriorityFeeMicroLamports}).`,
    ).toBeLessThanOrEqual(
      SPONSOR_MARGIN_MAX_RATIO * SOLANA_SPONSOR_LIMITS.maxPriorityFeeMicroLamports,
    );

    expect(
      fee,
      `CABE PERO SIN MARGEN: feeUpperBound=${fee} lamports usa más del ${SPONSOR_MARGIN_MAX_RATIO * 100} % del tope agregado (${SOLANA_SPONSOR_LIMITS.maxFeeLamports}).`,
    ).toBeLessThanOrEqual(SPONSOR_MARGIN_MAX_RATIO * SOLANA_SPONSOR_LIMITS.maxFeeLamports);
  });

  // T9 — el fee derivado, con los literales calculados A MANO además del cálculo por fórmula. Un test
  // que sólo comparara deriveFeeUpperBoundLamports contra sí misma sería un guard que se compara
  // consigo mismo: aplaudiría ante cualquier fórmula, incluso una que devolviera siempre 0.
  it("T9: el fee derivado es 11.200 lamports con 2 firmantes y 6.200 con 1", () => {
    const limit = resolveSolanaComputeUnitLimit();
    const price = resolveSolanaComputeUnitPriceMicroLamports();

    // Este test depende a la vez de la fórmula copiada Y de los valores que Chaski emite, así que
    // un rojo acá tiene DOS causas posibles y el diff numérico solo no las distingue. El mensaje
    // las nombra: T7 y T8 llevan mensajes ricos por el mismo motivo.
    const porQue = (esperado: number, firmantes: number) =>
      `El fee derivado dejó de ser ${esperado} lamports con ${firmantes} firmante(s). DOS causas ` +
      `posibles, y hay que distinguirlas antes de tocar nada: (a) se movió la fórmula copiada en ` +
      `vendored/solana-sponsor-limits.fixture.ts:49-57 (o su BASE_FEE_LAMPORTS_PER_SIG) y hay que ` +
      `re-verificarla contra cr1.ts:328-331 del facilitator; o (b) se re-derivó legítimamente el ` +
      `límite/precio en chain.ts (hoy ${limit} CU × ${price} µL/CU) y este literal quedó viejo. ` +
      `En el caso (b) el número nuevo hay que recalcularlo A MANO, nunca copiarlo del rojo: ` +
      `pegar el "received" convierte este test en un guard que se compara consigo mismo.`;

    // A mano: priority = ceil(120.000 × 10.000 / 1e6) = 1.200 lamports.
    //         2 firmantes → 5000×2 + 1.200 = 11.200. 1 firmante → 5000 + 1.200 = 6.200.
    expect(deriveFeeUpperBoundLamports(limit, price, 2), porQue(11_200, 2)).toBe(11_200);
    expect(deriveFeeUpperBoundLamports(limit, price, 1), porQue(6_200, 1)).toBe(6_200);
    // Las dos formas pasan el tope agregado, así que el conteo de firmantes no decide el veredicto.
    // Se assertea el valor DERIVADO, no el literal: `expect(11_200).toBeLessThanOrEqual(...)` sería
    // correcto sólo porque vitest aborta en el primer fallo, y se LEE como el antipatrón del guard
    // que se compara consigo mismo. Además, el caso de 1 firmante no lo cubre ningún otro test
    // (T7 y T8 derivan siempre con 2).
    expect(deriveFeeUpperBoundLamports(limit, price, 2)).toBeLessThanOrEqual(
      SOLANA_SPONSOR_LIMITS.maxFeeLamports,
    );
    expect(deriveFeeUpperBoundLamports(limit, price, 1)).toBeLessThanOrEqual(
      SOLANA_SPONSOR_LIMITS.maxFeeLamports,
    );
  });

  it("T9b: la fórmula copiada redondea la propina hacia ARRIBA y trata numSigners=0 como 1", () => {
    // ceil, no floor: 1 CU × 1 µL/CU = 0,000001 lamports → 1, no 0. Un floor convertiría el
    // "upper bound" en un lower bound, que es el bug que el facilitator ya documenta en cr1.ts:134-139.
    expect(deriveFeeUpperBoundLamports(1, 1, 1)).toBe(5_001);
    // max(1, numSigners): con 0 firmantes el fee base sigue siendo el de una firma.
    expect(deriveFeeUpperBoundLamports(120_000, 10_000, 0)).toBe(6_200);
  });

  // T10 — el fixture está bien formado y fechado. SIN ningún assert dependiente de "hoy" (CD-13): un
  // test que se pone rojo por el paso del tiempo entrena al equipo a ignorar el rojo.
  it("T10: el fixture pinneado está bien formado y su fecha de verificación no está en el futuro", () => {
    for (const [name, value] of Object.entries(SOLANA_SPONSOR_LIMITS)) {
      expect(Number.isInteger(value), `${name} debe ser entero`).toBe(true);
      expect(value, `${name} debe ser positivo`).toBeGreaterThan(0);
    }
    expect(SPONSOR_MARGIN_MAX_RATIO).toBeGreaterThan(0);
    expect(SPONSOR_MARGIN_MAX_RATIO).toBeLessThanOrEqual(1);

    expect(VERIFIED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const verifiedAt = Date.parse(VERIFIED_AT);
    expect(Number.isNaN(verifiedAt)).toBe(false);
    // Única comparación con el reloj: una fecha de verificación EN EL FUTURO es un error de tipeo,
    // y su rojo no llega solo con el paso del tiempo (el futuro se acerca, no se aleja).
    expect(verifiedAt).toBeLessThanOrEqual(Date.now());
  });

  it("T10b: el fixture está congelado (una escritura accidental no lo muta)", () => {
    expect(Object.isFrozen(SOLANA_SPONSOR_LIMITS)).toBe(true);
  });
});
