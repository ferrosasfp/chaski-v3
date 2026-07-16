// Infrastructure — single-use del challenge proof-of-possession (WKH-206, AC-4).
//
// Qué resuelve: el challenge es un HMAC stateless ⇒ sin estado sería REPLAYABLE. Un atacante que
// interceptara UNA firma válida podría re-presentar el mismo challenge+firma N veces. Este flag
// `SET NX` por nonce lo quema en el primer uso.
//
// ⚠️ FAIL-CLOSED, a diferencia de rate-limit.ts (que hace fail-abierto a propósito y NO se debe
// copiar acá): un blip de Redis no debe bloquear tráfico KYC legítimo, pero en el MONEY-PATH un
// Upstash caído con la puerta abierta le regala al atacante exactamente el replay que este módulo
// previene. Upstash caído/no configurado ⇒ `unavailable` ⇒ la route responde 503 y NUNCA forwardea
// (CD-3). Este NO es rate-limit.ts.
//
// Namespace `pop:nonce:${nonce}` — distinto de `settle:att:${txHash}` (WKH-168): no colisiona.
import { Redis } from "@upstash/redis";

export type PopNonceClaim =
  | { ok: true }
  | { ok: false; alreadyUsed: true }
  | { ok: false; unavailable: true };

/** TTL del flag. Muy superior al TTL del challenge (10 min) ⇒ un challenge vigente jamás puede
 *  sobrevivir a su propio flag de uso (si el flag expirara antes, el replay volvería a ser posible). */
const CLAIM_TTL_SECONDS = 86_400; // > POP_CHALLENGE_TTL_SECONDS

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
 * Reclama el nonce de forma atómica. `SET key "1" NX EX ttl` → "OK" si lo creó (primer uso), null si
 * YA existía (replay). La atomicidad del NX es lo que hace que dos requests concurrentes no puedan
 * ganar las dos.
 */
export async function claimPopNonceOnce(nonce: string): Promise<PopNonceClaim> {
  const redis = getRedis();
  if (!redis) return { ok: false, unavailable: true }; // → 503, NUNCA forward (CD-3)

  try {
    const created = await redis.set(`pop:nonce:${nonce}`, "1", {
      nx: true,
      ex: CLAIM_TTL_SECONDS,
    });
    if (created !== "OK") return { ok: false, alreadyUsed: true }; // replay → 409
    return { ok: true };
  } catch {
    // fail-CLOSED. PROHIBIDO devolver { ok: true } acá (ver la cabecera): sería la puerta al replay.
    // No es rate-limit.ts.
    return { ok: false, unavailable: true };
  }
}

// Solo para tests: resetea el cliente memoizado entre stubs de env (gemelo de
// __resetAttestationStore). Sin esto, vi.stubEnv("UPSTASH_…") no toma efecto tras la 1ª llamada.
export function __resetPopNonceStore(): void {
  cached = null;
}
