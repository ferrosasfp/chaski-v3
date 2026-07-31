// Infrastructure — proof-of-possession challenge HMAC del payout (WKH-206 / HU-SOL-8, AC-2/AC-3).
//
// Qué prueba: que el caller controla la private key de `address`. El server emite un challenge
// server-firmado (nonce + expiración + network-id CAIP-2) vía /api/a2a/payout/challenge; el caller
// firma el mensaje ed25519 con su wallet Solana; /api/payout/prepare recupera criptográficamente al
// firmante y exige que coincida con la address del body. El atacante NO puede forjar el challenge
// sin PAYOUT_POP_SECRET → es lo que ata el payout a la posesión real de la key.
//
// Formato: `${b64url(JSON.stringify(payload))}.${b64url(hmac(b64urlPayload))}`. El HMAC se calcula
// sobre el STRING base64url del payload (no sobre el JSON crudo): así verify() re-HMACea el string
// recibido tal cual y no depende de que JSON.stringify re-serialice idéntico.
//
// Este módulo exporta UN solo emisor y UN solo verificador, y eso es una BARRERA DEL COMPILADOR: no
// hay un segundo par de funciones con el que /api/payout/prepare pueda volver el PoP opt-in en vez
// de obligatorio — el intento no compila (TS2305).
//
// Crypto: node:crypto (createHmac/timingSafeEqual).
import { createHmac, timingSafeEqual } from "node:crypto";

/** TTL del challenge: la ventana challenge→prepare es de segundos; 10 min da margen sin volver el
 *  token un pase eterno. */
export const POP_CHALLENGE_TTL_SECONDS = 10 * 60;

// El secreto se lee DENTRO de la función (no en top-level) para que vi.stubEnv funcione (CD-14).
function secret(): string {
  const s = process.env.PAYOUT_POP_SECRET;
  if (!s) throw new Error("PAYOUT_POP_SECRET missing"); // la ruta corta antes con 503 fail-closed
  return s;
}

function sign(payloadB64: string): string {
  return createHmac("sha256", secret()).update(payloadB64).digest("base64url");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── HU-SOL-8 / WKH-211 — el challenge PoP ed25519 ─────────────────────────────────────────────────
// El challenge ata un network-id CAIP-2 (solana:devnet | solana:mainnet) — anti-replay cross-cluster
// (CD-3). Reusa secret()/sign()/isRecord() privados.

export interface SolanaPopChallenge {
  address: string; // base58 canónico (PublicKey.toBase58), case-sensitive (CD-8)
  networkId: string; // CAIP-2: "solana:devnet" | "solana:mainnet" (CD-3) — identifica el cluster
  nonce: string; // 32 hex (randomBytes(16).toString('hex'))
  exp: number; // epoch SEGUNDOS
}

/**
 * SSOT del mensaje (CD-6). 5 líneas \n-separadas, SIN newline final. El cliente lo firma VERBATIM; el
 * emisor (challenge/route) y el verificador (prepare) llaman a ESTA misma función ⇒ byte-idéntico.
 */
export function buildSolanaPopMessage(p: SolanaPopChallenge): string {
  return `Chaski Proof-of-Possession\naddress: ${p.address}\nnetwork: ${p.networkId}\nnonce: ${p.nonce}\nexpires: ${p.exp}`;
}

export function issueSolanaPopChallenge(p: SolanaPopChallenge): string {
  const payloadB64 = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Mirror de verifyPopChallenge (HMAC-first, parse en try/catch, expiración) pero con validación de
 * campos Solana. Devuelve null ante CUALQUIER problema (fail-closed → 403 opaco, CD-4 no-oracle). La
 * validez base58 del `address` la cierra el verifier ed25519 (verifySolanaPop), NO acá.
 */
export function verifySolanaPopChallenge(token: string, nowMs: number): SolanaPopChallenge | null {
  // 1. Formato: exactamente 2 partes no vacías.
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, macB64] = parts;
  if (!payloadB64 || !macB64) return null;

  // 2. Defensa: sin secreto no se verifica nada (la route ya hizo 503 fail-closed cuando ausente).
  if (!process.env.PAYOUT_POP_SECRET) return null;

  // 3. HMAC PRIMERO — longitud primero (timingSafeEqual TIRA con buffers de distinta longitud), luego
  //    la comparación timing-safe.
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

  // 5. Validar el tipo de CADA campo.
  const { address, networkId, nonce, exp } = parsed;
  if (typeof address !== "string" || !address.trim()) return null;
  if (typeof networkId !== "string" || !/^solana:(devnet|mainnet)$/.test(networkId)) return null;
  if (typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;

  // 6. Expiración.
  if (exp * 1000 <= nowMs) return null;

  return { address, networkId, nonce, exp };
}
