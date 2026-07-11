// Infrastructure — rate-limit KYC (WKH-179, hallazgo A2: financial-DoS).
// Cada POST /api/kyc/session dispara una verificación que Chaski PAGA en Didit. Este helper limita
// por IP y por address (sliding window, Upstash Redis REST) ANTES de llamar a Didit (CD-2).
//
// Fail-modes (SDD §4.4):
//  - Upstash NO configurado + Didit SÍ (prod-like) → fail-CLOSED → { unavailable:true } → ruta 503.
//  - Modo simulación (sin DIDIT_API_KEY): la ruta corta con 501 ANTES → este helper ni se invoca.
//  - Upstash configurado pero error transitorio → fail-OPEN + console.warn → { ok:true }.
//
// NO contadores en memoria (Vercel serverless efímero, CD-11): solo Upstash.
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export interface KycRateLimitInput {
  ip: string;
  address?: string;
}
export interface KycRateLimitResult {
  ok: boolean;
  retryAfter?: number; // segundos
  unavailable?: boolean; // Upstash no configurado (fail-closed)
}

// El tipo de ventana lo define Upstash (`${number} ${Unit}` | `${number}${Unit}`). Lo derivamos
// de la firma real para no divergir; el valor de env se valida en runtime, se castea al entrar.
type Duration = Parameters<typeof Ratelimit.slidingWindow>[1];

interface Limiters {
  ip: Ratelimit;
  address: Ratelimit;
}

// Cliente lazy: se construye UNA vez desde env. null hasta la primera resolución con env presente.
let cached: Limiters | null = null;

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// MNR-3: valida el formato de la ventana (`${number} ${unit}`, con o sin espacio) ANTES de castear.
// Un `KYC_RL_*_WINDOW` malformado (p.ej. "diez") producía NaN dentro del sliding window (Upstash
// nunca expira la ventana → contadores rotos). Ahora cae al default, igual que `num()` — fail-safe
// y simétrico. Unidades válidas de Upstash Duration: ms | s | m | h | d.
const WINDOW_RE = /^\d+\s*(ms|s|m|h|d)$/;
function win(name: string, fallback: Duration): Duration {
  const raw = process.env[name]?.trim();
  return raw && WINDOW_RE.test(raw) ? (raw as Duration) : fallback;
}

// Construye (memoizando) los limiters si hay env de Upstash. Devuelve null si falta config.
function getLimiters(): Limiters | null {
  if (cached) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const redis = new Redis({ url, token });
  cached = {
    // MNR-2: el bucket IP es la defensa NO omitible contra el financial-DoS (A2). Corre SIEMPRE en
    // checkKycRateLimit() con la IP confiable de Vercel (ver clientIp() en la ruta), a diferencia del
    // bucket address, que es tightening adicional del flujo legítimo. Default conservador: 5/10min por
    // IP (el flujo legítimo hace 1 sesión por remesa; 5 deja margen a reintentos sin abaratar el abuso
    // del costo por verificación que Chaski paga en Didit). Override vía KYC_RL_IP_MAX / KYC_RL_IP_WINDOW.
    ip: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(num("KYC_RL_IP_MAX", 5), win("KYC_RL_IP_WINDOW", "10 m")),
      prefix: "kyc:rl:ip",
    }),
    address: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(num("KYC_RL_ADDR_MAX", 3), win("KYC_RL_ADDR_WINDOW", "10 m")),
      prefix: "kyc:rl:addr",
    }),
  };
  return cached;
}

function retryAfterFrom(reset: number): number {
  return Math.max(1, Math.ceil((reset - Date.now()) / 1000));
}

export async function checkKycRateLimit(input: KycRateLimitInput): Promise<KycRateLimitResult> {
  const limiters = getLimiters();
  if (!limiters) return { ok: false, unavailable: true }; // fail-closed (Didit configurado, sin Upstash)

  try {
    // MNR-2: el bucket IP corre SIEMPRE (no depende de input.address) → es la defensa primaria y no
    // omitible. Un atacante que pega con body `{}` (sin vendorData) sigue cayendo bajo este límite,
    // ahora anclado a la IP confiable de Vercel (no forjable). El bucket address es tightening extra.
    const ipRes = await limiters.ip.limit(input.ip);
    if (!ipRes.success) return { ok: false, retryAfter: retryAfterFrom(ipRes.reset) };

    if (input.address) {
      const addrRes = await limiters.address.limit(input.address);
      if (!addrRes.success) return { ok: false, retryAfter: retryAfterFrom(addrRes.reset) };
    }
    return { ok: true };
  } catch (err) {
    // Error transitorio (red/timeout) → fail-OPEN: no bloquear tráfico legítimo por un blip de Redis.
    console.warn("[kyc-rate-limit] transient Upstash error, failing open:", err);
    return { ok: true };
  }
}

// Solo para tests: resetea el cliente memoizado entre stubs de env.
export function __resetKycRateLimitClient(): void {
  cached = null;
}
