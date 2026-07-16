// Infrastructure — proof-of-possession challenge HMAC del payout (WKH-206, AC-2/AC-3).
//
// Qué prueba: que el caller controla la private key de `address`. El server emite un challenge
// server-firmado (nonce single-use + expiración + chainId) vía /api/a2a/payout/challenge; el caller
// firma el mensaje con su wallet; /api/a2a/payout/submit recupera criptográficamente al firmante y
// exige que coincida con la address del body. El atacante NO puede forjar el challenge sin
// PAYOUT_POP_SECRET → es lo que ata el payout a la posesión real de la key.
//
// Formato: `${b64url(JSON.stringify(payload))}.${b64url(hmac(b64urlPayload))}`. El HMAC se calcula
// sobre el STRING base64url del payload (no sobre el JSON crudo): así verify() re-HMACea el string
// recibido tal cual y no depende de que JSON.stringify re-serialice idéntico.
//
// Crypto: node:crypto (createHmac/timingSafeEqual). Mirror byte-a-byte de attestation.ts (WKH-168).
import { createHmac, timingSafeEqual } from "node:crypto";
import { isAddress } from "viem";

export interface PopChallenge {
  address: string; // 0x + 40 hex, lowercased
  chainId: number; // entero
  nonce: string; // 32 hex (sin 0x)
  exp: number; // epoch SEGUNDOS
}

/** TTL del challenge: la ventana challenge→submit es de segundos; 10 min da margen sin volver el
 *  token un pase eterno. */
export const POP_CHALLENGE_TTL_SECONDS = 10 * 60;

// El secreto se lee DENTRO de la función (no en top-level) para que vi.stubEnv funcione (CD-14).
function secret(): string {
  const s = process.env.PAYOUT_POP_SECRET;
  if (!s) throw new Error("PAYOUT_POP_SECRET missing"); // la ruta corta antes (skip cuando ausente)
  return s;
}

function sign(payloadB64: string): string {
  return createHmac("sha256", secret()).update(payloadB64).digest("base64url");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function issuePopChallenge(p: PopChallenge): string {
  const payloadB64 = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Formato del mensaje que el caller firma. ÚNICA fuente de verdad (DT-3/CD-10): el endpoint /challenge
 * lo emite como popMessage y el guard de /submit lo reconstruye desde el challenge HMAC-verificado ⇒
 * byte-idéntico por construcción. 5 líneas \n-separadas, SIN newline final. NO reconstruir a mano.
 */
export function buildPopMessage(p: PopChallenge): string {
  return `Chaski Proof-of-Possession\naddress: ${p.address}\nchainId: ${p.chainId}\nnonce: ${p.nonce}\nexpires: ${p.exp}`;
}

/**
 * Devuelve null ante CUALQUIER problema (formato, HMAC, exp, tipos). Nunca throw por token inválido
 * (fail-closed en cada paso). El HMAC malo y la expiración colapsan acá → ambos devuelven null → el
 * mismo 403 opaco en la route (CD-4, no-oracle).
 */
export function verifyPopChallenge(token: string, nowMs: number): PopChallenge | null {
  // 1. Formato: exactamente 2 partes no vacías.
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, macB64] = parts;
  if (!payloadB64 || !macB64) return null;

  // 2. Defensa: sin secreto no se verifica nada (la route ya hizo skip total cuando ausente).
  if (!process.env.PAYOUT_POP_SECRET) return null;

  // 3. HMAC PRIMERO — antes de parsear nada. Longitud primero (timingSafeEqual TIRA con buffers de
  //    distinta longitud), luego comparación timing-safe.
  const expected = Buffer.from(sign(payloadB64));
  const received = Buffer.from(macB64);
  if (expected.length !== received.length) return null;
  if (!timingSafeEqual(expected, received)) return null;

  // 4. Parse DENTRO de try/catch (un payload b64 válido puede no ser JSON).
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  // 5. Validar el tipo de CADA campo (un HMAC válido sobre un payload deforme sigue siendo deforme).
  const { address, chainId, nonce, exp } = parsed;
  if (typeof address !== "string" || !isAddress(address)) return null;
  if (typeof chainId !== "number" || !Number.isInteger(chainId)) return null;
  if (typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;

  // 6. Expiración.
  if (exp * 1000 <= nowMs) return null;

  return { address, chainId, nonce, exp };
}
