// Infrastructure — rate-limit genérico por ruta (WKH-179 A2 financial-DoS; generalizado en WKH-205).
// Cada POST caro (KYC session / payout validate / payout challenge) puede consumir recursos que Chaski
// PAGA (una verificación Didit) o CPU (HMAC). Este helper limita por IP y (opcional) por address
// (sliding window, Upstash Redis REST) ANTES de ejecutar el trabajo caro (CD-2).
//
// Fail-modes (SDD §4.4):
//  - Upstash NO configurado + entorno vivo (prod-like) → fail-CLOSED → { unavailable:true } → ruta 503.
//  - Modo simulación: la ruta corta ANTES (501 / sin DIDIT_API_KEY) → este helper ni se invoca.
//  - Upstash configurado pero error transitorio → fail-OPEN + console.warn → { ok:true }.
//
// NO contadores en memoria (Vercel serverless efímero, CD-11): solo Upstash.
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export interface RateLimitInput {
  ip: string;
  address?: string;
}
export interface RateLimitResult {
  ok: boolean;
  retryAfter?: number; // segundos
  unavailable?: boolean; // Upstash no configurado (fail-closed)
}

// El tipo de ventana lo define Upstash (`${number} ${Unit}` | `${number}${Unit}`). Lo derivamos
// de la firma real para no divergir; el valor de env se valida en runtime, se castea al entrar.
type Duration = Parameters<typeof Ratelimit.slidingWindow>[1];

// Config por-bucket (IP o address): de dónde leer max/window y sus defaults.
interface BucketConfig {
  envMax: string;
  defMax: number;
  envWindow: string;
  defWindow: Duration;
}

// Config por-ruta: prefijo de bucket (aísla contadores entre rutas) + bucket IP (siempre) +
// bucket address (opcional, IP-only si ausente — WKH-205: challenge).
export interface RouteRateLimitConfig {
  bucketPrefix: string;
  ip: BucketConfig;
  addr?: BucketConfig;
}

// Defaults exactos (DT-4): KYC IP 5/"10 m" addr 3/"10 m".
export const KYC_RL: RouteRateLimitConfig = {
  bucketPrefix: "kyc:rl",
  ip: { envMax: "KYC_RL_IP_MAX", defMax: 5, envWindow: "KYC_RL_IP_WINDOW", defWindow: "10 m" },
  addr: { envMax: "KYC_RL_ADDR_MAX", defMax: 3, envWindow: "KYC_RL_ADDR_WINDOW", defWindow: "10 m" },
};

// VALIDATE IP 5/"10 m" addr 3/"10 m" (mismo perfil que KYC: 1 sesión por remesa, margen a reintentos).
export const PAYOUT_VALIDATE_RL: RouteRateLimitConfig = {
  bucketPrefix: "payout:validate:rl",
  ip: {
    envMax: "PAYOUT_VALIDATE_RL_IP_MAX",
    defMax: 5,
    envWindow: "PAYOUT_VALIDATE_RL_IP_WINDOW",
    defWindow: "10 m",
  },
  addr: {
    envMax: "PAYOUT_VALIDATE_RL_ADDR_MAX",
    defMax: 3,
    envWindow: "PAYOUT_VALIDATE_RL_ADDR_WINDOW",
    defWindow: "10 m",
  },
};

// CHALLENGE IP 10/"10 m" (sin addr): CPU-DoS de HMAC, IP-only (el body aún no se parsea acá).
export const PAYOUT_CHALLENGE_RL: RouteRateLimitConfig = {
  bucketPrefix: "payout:challenge:rl",
  ip: {
    envMax: "PAYOUT_CHALLENGE_RL_IP_MAX",
    defMax: 10,
    envWindow: "PAYOUT_CHALLENGE_RL_IP_WINDOW",
    defWindow: "10 m",
  },
};

// PREPARE IP 10/"10 m" (sin addr): cada prepare crea una orden TransFi real → sin rate-limit, spam =
// órdenes huérfanas masivas (WKH-211/DT-5). IP-only (el body aún no se parsea acá). Mismo perfil que
// CHALLENGE (POST caro, CPU + side-effect externo).
export const DEPOSIT_PREPARE_RL: RouteRateLimitConfig = {
  bucketPrefix: "payout:prepare:rl",
  ip: {
    envMax: "DEPOSIT_PREPARE_RL_IP_MAX",
    defMax: 10,
    envWindow: "DEPOSIT_PREPARE_RL_IP_WINDOW",
    defWindow: "10 m",
  },
};

interface Limiters {
  ip: Ratelimit;
  address?: Ratelimit; // ausente cuando cfg.addr no está (IP-only)
}

// Cliente lazy por bucketPrefix: se construye UNA vez por ruta desde env. Aísla los contadores
// (kyc/validate/challenge NO comparten counter). __resetKycRateLimitClient() lo vacía entre tests.
const cache = new Map<string, Limiters>();

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// MNR-3: valida el formato de la ventana (`${number} ${unit}`, con o sin espacio) ANTES de castear.
// Un `*_WINDOW` malformado (p.ej. "diez") producía NaN dentro del sliding window (Upstash nunca
// expira la ventana → contadores rotos). Ahora cae al default, igual que `num()` — fail-safe y
// simétrico. Unidades válidas de Upstash Duration: ms | s | m | h | d.
const WINDOW_RE = /^\d+\s*(ms|s|m|h|d)$/;
function win(name: string, fallback: Duration): Duration {
  const raw = process.env[name]?.trim();
  return raw && WINDOW_RE.test(raw) ? (raw as Duration) : fallback;
}

// Construye (memoizando por bucketPrefix) los limiters si hay env de Upstash. null si falta config.
function getLimiters(cfg: RouteRateLimitConfig): Limiters | null {
  const hit = cache.get(cfg.bucketPrefix);
  if (hit) return hit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const redis = new Redis({ url, token });
  // MNR-2: el bucket IP es la defensa NO omitible contra el financial-DoS (A2). Corre SIEMPRE con la
  // IP confiable de Vercel (ver clientIp()). El bucket address es tightening adicional del flujo
  // legítimo — solo se construye si la config lo declara (challenge es IP-only).
  const limiters: Limiters = {
    ip: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(
        num(cfg.ip.envMax, cfg.ip.defMax),
        win(cfg.ip.envWindow, cfg.ip.defWindow),
      ),
      prefix: `${cfg.bucketPrefix}:ip`,
    }),
  };
  if (cfg.addr) {
    limiters.address = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(
        num(cfg.addr.envMax, cfg.addr.defMax),
        win(cfg.addr.envWindow, cfg.addr.defWindow),
      ),
      prefix: `${cfg.bucketPrefix}:addr`,
    });
  }
  cache.set(cfg.bucketPrefix, limiters);
  return limiters;
}

function retryAfterFrom(reset: number): number {
  return Math.max(1, Math.ceil((reset - Date.now()) / 1000));
}

// MNR-1: la key del rate-limit por IP debe venir de una fuente que el cliente NO pueda forjar.
// En Vercel, `x-vercel-forwarded-for` y `x-real-ip` los INYECTA/SOBRESCRIBE la edge de Vercel con la
// IP real del cliente (equivalen a `ipAddress()` de @vercel/functions, que lee `x-real-ip`) → fuente
// primaria confiable. El `x-forwarded-for` crudo es una cadena parcialmente controlada por el cliente:
// su entry MÁS A LA IZQUIERDA es spoofeable, y tomarlo (como antes) permitía evadir el límite por IP
// rotando el header. Por eso XFF es SOLO último recurso y, de usarlo, tomamos el valor MÁS A LA
// DERECHA (el que agrega el proxy de confianza más cercano), nunca el leftmost.
// WKH-205: extraído byte-idéntico de kyc/session/route.ts:19-31 (la copia de kyc/session queda, dup
// documentada — CD-11) para que las rutas nuevas (validate/challenge) reusen la misma fuente.
export function clientIp(req: Request): string {
  const trusted =
    req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim();
  if (trusted) return trusted;

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1]!;
  }
  return "unknown";
}

export async function checkRouteRateLimit(
  cfg: RouteRateLimitConfig,
  input: RateLimitInput,
): Promise<RateLimitResult> {
  const limiters = getLimiters(cfg);
  if (!limiters) return { ok: false, unavailable: true }; // fail-closed (entorno vivo, sin Upstash)

  try {
    // MNR-2: el bucket IP corre SIEMPRE (no depende de input.address) → defensa primaria no omitible.
    // Un atacante que pega con body `{}` (sin address) sigue cayendo bajo este límite, anclado a la IP
    // confiable de Vercel (no forjable). El bucket address es tightening extra (solo si la config lo trae).
    const ipRes = await limiters.ip.limit(input.ip);
    if (!ipRes.success) return { ok: false, retryAfter: retryAfterFrom(ipRes.reset) };

    if (limiters.address && input.address) {
      const addrRes = await limiters.address.limit(input.address);
      if (!addrRes.success) return { ok: false, retryAfter: retryAfterFrom(addrRes.reset) };
    }
    return { ok: true };
  } catch (err) {
    // Error transitorio (red/timeout) → fail-OPEN: no bloquear tráfico legítimo por un blip de Redis.
    console.warn("[route-rate-limit] transient Upstash error, failing open:", err);
    return { ok: true };
  }
}

// Wrapper histórico (WKH-179): firma + comportamiento byte-idéntico (CD-10). El KYC session lo importa.
export async function checkKycRateLimit(input: RateLimitInput): Promise<RateLimitResult> {
  return checkRouteRateLimit(KYC_RL, input);
}

// Solo para tests: resetea los clientes memoizados entre stubs de env. NOMBRE EXACTO preservado
// (el test lo importa). Ahora vacía el Map de todos los buckets.
export function __resetKycRateLimitClient(): void {
  cache.clear();
}
