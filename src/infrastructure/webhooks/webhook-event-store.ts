// Infrastructure — single-use (claim-once) del webhook de TransFi (WKH-210, CD-4). Es el ÚNICO
// claim-once del repo: el anti-replay del PoP dentro de su TTL es del facilitator (residual R-3).
//
// Qué resuelve: TransFi puede re-entregar el MISMO evento (retries, at-least-once). Sin estado, un 2º
// delivery re-mutaría el ledger. Este flag `SET NX` por eventId lo quema en el primer uso: el 2º
// delivery ve `alreadyUsed` ⇒ 200 sin re-mutar.
//
// Este store es un dedup BEST-EFFORT: la route muta el ledger PRIMERO (idempotente por el filtro
// STALE_STATUSES) y RECIÉN quema la key. Con Upstash caído/no configurado ⇒ `unavailable` ⇒ la route
// NO puede dedupear, pero igual responde 200 porque la mutación ya se aplicó de forma idempotente
// (un re-delivery re-muta sin daño). La garantía anti-doble-procesamiento la da la idempotencia de la
// mutación, no este claim. PROHIBIDO igual devolver { ok: true } en el catch: enmascararía un fallo de
// Upstash como "ya procesado" y saltearía el dedup silenciosamente.
//
// Namespace `transfi:evt:${key}` — distinto de `pop:nonce:${nonce}` / `settle:att:${txHash}`: no colisiona.
import { Redis } from "@upstash/redis";

export type WebhookEventClaim =
  | { ok: true }
  | { ok: false; alreadyUsed: true }
  | { ok: false; unavailable: true };

/** TTL del flag. 24h: cubre de sobra la ventana de retries de TransFi para un mismo evento. */
const CLAIM_TTL_SECONDS = 86_400;

let cached: Redis | null = null;

// Cliente memoizado. Env leída DENTRO (CD-10): en top-level, vi.stubEnv no tomaría efecto.
function getRedis(): Redis | null {
  if (cached) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  cached = new Redis({ url, token });
  return cached;
}

/**
 * Reclama el evento de forma atómica. `SET key "1" NX EX ttl` → "OK" si lo creó (primer uso), null si
 * YA existía (replay/re-delivery). La atomicidad del NX es lo que hace que dos deliveries concurrentes
 * no puedan ganar los dos.
 */
export async function claimWebhookEventOnce(key: string): Promise<WebhookEventClaim> {
  const redis = getRedis();
  if (!redis) return { ok: false, unavailable: true }; // dedup no disponible; la route ya mutó (idempotente) → 200

  try {
    const created = await redis.set(`transfi:evt:${key}`, "1", {
      nx: true,
      ex: CLAIM_TTL_SECONDS,
    });
    if (created !== "OK") return { ok: false, alreadyUsed: true }; // re-delivery → 200 deduped
    return { ok: true };
  } catch {
    // fail-CLOSED. PROHIBIDO devolver { ok: true } acá (ver la cabecera): sería la puerta al
    // doble-procesamiento. No es rate-limit.ts.
    return { ok: false, unavailable: true };
  }
}

// Solo para tests: resetea el cliente memoizado entre stubs de env. Sin esto, vi.stubEnv("UPSTASH_…")
// no toma efecto tras la 1ª llamada.
export function __resetWebhookEventStore(): void {
  cached = null;
}
