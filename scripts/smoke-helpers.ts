// scripts/smoke-helpers.ts
// Piezas PURAS del smoke e2e de devnet (`scripts/smoke-solana-e2e.ts`). Viven en su propio módulo por
// una razón concreta: el smoke aborta con `process.exit(1)` en su PRIMER statement si no está
// `SMOKE_ALLOW_REAL=true`, así que importarlo desde un test mataría al runner. Acá no hay red, no hay
// `process.env` y no hay side-effects: todo esto se puede testear (`smoke-helpers.test.ts`).
import { createHmac } from "node:crypto";

/** Alfabeto y rango base58 de una signature Solana. MISMO literal que el validador del proxy
 *  (`app/api/settle/solana-sponsor/route.ts:18`): si el proxy la aceptaría, el smoke la acepta, y al
 *  revés. Un `typeof === "string"` no alcanza: "" y "0xdeadbeef" son strings. */
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;

/** true si `v` es una signature base58 plausible (formato, no existencia on-chain). */
export function isBase58Signature(v: unknown): v is string {
  return typeof v === "string" && BASE58_SIGNATURE.test(v);
}

/**
 * Encoding INYECTIVO del mensaje de la atestación de release. Espejo EXACTO de
 * `wasiai-facilitator/src/routes/solana-escrow.ts:86-88` (`encodeAttestationMessage`).
 *
 * El naive `${remittanceId}:${sender}` NO es inyectivo: ("a:b","c") y ("a","b:c") producen el mismo
 * mensaje. Con el largo adelante, el borde entre los dos campos es inambiguo.
 */
export function encodeReleaseAttestationMessage(remittanceId: string, sender: string): string {
  return `${remittanceId.length}:${remittanceId}${sender}`;
}

/**
 * HMAC-SHA256 hex sobre el mensaje inyectivo, con el secreto compartido con el facilitator
 * (`SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET`). Espejo de `computeReleaseAttestation`
 * (`wasiai-facilitator/src/routes/solana-escrow.ts:97-105`).
 *
 * ⚠️ QUÉ SIGNIFICA ESTE VALOR, y por qué el smoke calculándolo NO prueba lo que parece: en el diseño
 * del sistema esta atestación es el CERTIFICADO de que el KYC se aprobó y la orden fiat se completó.
 * El facilitator la exige antes de firmar el release porque confía en que la emitió alguien que
 * verificó esas dos cosas. Cuando el smoke se la auto emite, no verificó ninguna: sólo demuestra que
 * tiene el secreto. La pata on-chain queda probada; la pata fiat NO queda probada en absoluto.
 */
export function computeReleaseAttestation(
  remittanceId: string,
  sender: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(encodeReleaseAttestationMessage(remittanceId, sender))
    .digest("hex");
}

export type NumericEnvResult = { ok: true; value: number } | { ok: false; reason: string };

/**
 * Parseo fail-loud de una env numérica. El bug que cierra: `Number.parseInt(raw, 10)` sobre un valor
 * no numérico devuelve `NaN` en silencio, el `NaN` se propaga (a un deadline, a un monto) y la corrida
 * revienta más adelante sin decir NUNCA qué env estaba mal.
 *
 * `reason` nombra la env y describe la restricción, NUNCA imprime el valor (CD-4, igual que
 * `requireEnv`).
 */
export function parseNumericEnv(
  name: string,
  raw: string | undefined,
  opts: { readonly integer?: boolean; readonly min?: number } = {},
): NumericEnvResult {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, reason: `env requerida ausente o vacía: ${name}` };
  }
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) {
    return { ok: false, reason: `env no numérica: ${name} (se esperaba un número finito)` };
  }
  if (opts.integer === true && !Number.isInteger(value)) {
    return { ok: false, reason: `env no entera: ${name} (se esperaba un entero)` };
  }
  if (opts.min !== undefined && value < opts.min) {
    return { ok: false, reason: `env fuera de rango: ${name} (se esperaba >= ${opts.min})` };
  }
  return { ok: true, value };
}

/** USDC tiene 6 decimales: unidades menores = usd * 1e6, redondeado. Aislado acá para poder testear
 *  que un monto con más de 6 decimales no se cuela como fracción de unidad menor. */
export function usdToUsdcMinorUnits(amountUsd: number): bigint {
  return BigInt(Math.round(amountUsd * 1_000_000));
}
