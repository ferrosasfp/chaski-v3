// Infrastructure — single-use de la atestación de settlement (WKH-168, AC-11).
//
// Qué resuelve: la atestación es un HMAC stateless ⇒ sin estado sería REPLAYABLE. Un atacante que
// paga UNA vez podría presentar la misma atestación N veces y cobrar N payouts sobre un solo
// principal. Este flag `SET NX` por txHash la quema en el primer uso.
//
// ⚠️ FAIL-CLOSED, a diferencia de rate-limit.ts (que hace fail-OPEN a propósito y NO se debe copiar
// acá): un blip de Redis no debe bloquear tráfico KYC legítimo, pero en el MONEY-PATH un Upstash
// caído con fail-open le regala al atacante exactamente el replay que este módulo previene (tirá
// Upstash → cobrá N veces). Upstash caído/no configurado ⇒ `unavailable` ⇒ la route responde 503 y
// NUNCA forwardea. CD-12.
//
// ⚠️ CD-8: acá NO se guarda RemittanceState, ni beneficiario, ni monto, ni PII. SOLO un flag "1" por
// txHash. Es replay-protection efímera, NO persistencia de remesa (eso es WKH-207). Si te encontrás
// guardando cualquier otra cosa acá, estás violando CD-8.
import { Redis } from "@upstash/redis";

export type AttestationClaim =
  | { ok: true }
  | { ok: false; alreadyUsed: true }
  | { ok: false; unavailable: true };

/** TTL del flag. Muy superior al TTL de la atestación (15 min) ⇒ una atestación vigente jamás puede
 *  sobrevivir a su propio flag de uso (si el flag expirara antes, el replay volvería a ser posible). */
const CLAIM_TTL_SECONDS = 86_400;

let cached: Redis | null = null;

// Cliente memoizado. Env leída DENTRO (CD-14): en top-level, vi.stubEnv no tomaría efecto.
function getRedis(): Redis | null {
  if (cached) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  cached = new Redis({ url, token });
  return cached;
}

/**
 * Reclama la atestación de forma atómica. `SET key "1" NX EX ttl` → "OK" si la creó (primer uso),
 * null si YA existía (replay). La atomicidad del NX es lo que hace que dos requests concurrentes no
 * puedan ganar las dos.
 */
export async function claimAttestationOnce(txHash: string): Promise<AttestationClaim> {
  const redis = getRedis();
  if (!redis) return { ok: false, unavailable: true }; // A9 → 503, NUNCA forward

  try {
    const created = await redis.set(`settle:att:${txHash}`, "1", {
      nx: true,
      ex: CLAIM_TTL_SECONDS,
    });
    if (created !== "OK") return { ok: false, alreadyUsed: true }; // A8 → 409
    return { ok: true };
  } catch {
    // A9 — fail-CLOSED. PROHIBIDO devolver { ok: true } acá (ver la cabecera): sería la puerta al
    // replay. No es rate-limit.ts.
    return { ok: false, unavailable: true };
  }
}

// Solo para tests: resetea el cliente memoizado entre stubs de env (gemelo de
// __resetKycRateLimitClient). Sin esto, vi.stubEnv("UPSTASH_…") no toma efecto tras la 1ª llamada
// → tests flaky.
export function __resetAttestationStore(): void {
  cached = null;
}
