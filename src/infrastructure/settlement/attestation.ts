// Infrastructure — atestación HMAC del settlement del principal (WKH-168, AC-10).
//
// Qué prueba: que /api/settle/principal VERIFICÓ on-chain (receipt + log Transfer del USDC) que el
// principal entró, con `from`/`to`/`value` correctos. El atacante NO puede forjarla sin
// SETTLE_ATTESTATION_SECRET → es lo que ata el payout al USDC realmente recibido.
//
// Formato: `${b64url(JSON.stringify(payload))}.${b64url(hmac(b64urlPayload))}`. El HMAC se calcula
// sobre el STRING base64url del payload (no sobre el JSON crudo): así verify() re-HMACea el string
// recibido tal cual y no depende de que JSON.stringify re-serialice idéntico.
//
// Crypto: node:crypto (createHmac/timingSafeEqual). NO jsonwebtoken/jose (patrón kyc-auth.ts).
import { createHmac, timingSafeEqual } from "node:crypto";
import { isAddress } from "viem";

export interface SettlementAttestation {
  txHash: string;
  chainId: number;
  valueMinor: number;
  from: string;
  to: string;
  quoteId: string;
  exp: number; // epoch SEGUNDOS
}

/** TTL de la atestación: la ventana settle→submit es de segundos; 15 min da margen sin volver el
 *  token un pase eterno. */
export const ATTESTATION_TTL_SECONDS = 15 * 60;

// El secreto se lee DENTRO de la función (no en top-level) para que vi.stubEnv funcione (CD-14).
function secret(): string {
  const s = process.env.SETTLE_ATTESTATION_SECRET;
  if (!s) throw new Error("SETTLE_ATTESTATION_SECRET missing"); // la ruta corta antes (S1/S2)
  return s;
}

function sign(payloadB64: string): string {
  return createHmac("sha256", secret()).update(payloadB64).digest("base64url");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function issueSettlementAttestation(p: SettlementAttestation): string {
  const payloadB64 = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Devuelve null ante CUALQUIER problema (formato, HMAC, exp, tipos). Nunca throw por token inválido
 * (CD-12: fail-closed en cada paso). A4 (HMAC) y A5 (exp) colapsan acá → ambos devuelven null → el
 * mismo 403 opaco en la route (CD-12, no-oracle).
 */
export function verifySettlementAttestation(
  token: string,
  nowMs: number,
): SettlementAttestation | null {
  // 1. Formato: exactamente 2 partes no vacías.
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, macB64] = parts;
  if (!payloadB64 || !macB64) return null;

  // 6. Defensa: sin secreto no se verifica nada (la route ya cortó en A1/A2).
  if (!process.env.SETTLE_ATTESTATION_SECRET) return null;

  // 2. HMAC PRIMERO — antes de parsear nada. Longitud primero (timingSafeEqual TIRA con buffers de
  //    distinta longitud), luego comparación timing-safe.
  const expected = Buffer.from(sign(payloadB64));
  const received = Buffer.from(macB64);
  if (expected.length !== received.length) return null;
  if (!timingSafeEqual(expected, received)) return null;

  // 3. Parse DENTRO de try/catch (un payload b64 válido puede no ser JSON).
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  // 4. Validar el tipo de CADA campo (un HMAC válido sobre un payload deforme sigue siendo deforme).
  const { txHash, chainId, valueMinor, from, to, quoteId, exp } = parsed;
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
  if (typeof chainId !== "number" || !Number.isInteger(chainId)) return null;
  if (typeof valueMinor !== "number" || !Number.isInteger(valueMinor) || valueMinor <= 0) return null;
  if (typeof from !== "string" || !isAddress(from)) return null;
  if (typeof to !== "string" || !isAddress(to)) return null;
  if (typeof quoteId !== "string" || quoteId.length === 0) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;

  // 5. Expiración (A5).
  if (exp * 1000 <= nowMs) return null;

  return { txHash, chainId, valueMinor, from, to, quoteId, exp };
}
