// Infrastructure — atestación HMAC del depositAddress no-custodial (WKH-211, AC-2). TERCERA
// atestación HMAC del repo: mirror en FORMA de attestation.ts (WKH-168) y pop-challenge.ts (WKH-206).
//
// Qué prueba: que el server creó la orden TransFi y ató el `depositAddress` asignado a ESTA remesa
// (remittanceId + quoteId + chainId) ANTES de que el cliente firme. El atacante NO puede forjarla sin
// DEPOSIT_ATTESTATION_SECRET → es lo que impide inyectar un `to` propio en la firma EIP-3009 y desviar
// los fondos (el vector no-custodial que esta HU cierra).
//
// Formato: `${b64url(JSON.stringify(payload))}.${b64url(hmac(b64urlPayload))}`. El HMAC se calcula
// sobre el STRING base64url del payload (no sobre el JSON crudo): así verify() re-HMACea el string
// recibido tal cual y no depende de que JSON.stringify re-serialice idéntico.
//
// Crypto: node:crypto (createHmac/timingSafeEqual). NO jsonwebtoken/jose (patrón attestation.ts).
// SIN claim-once (DT-6): el binding es stateless — el nonce EIP-3009 determinístico
// (keccak256(remittanceId:quoteId)) hace el 2º settle contract-imposible; B3/B4/B5 matan el reuse.
import { createHmac, timingSafeEqual } from "node:crypto";
import { isAddress } from "viem";

export interface DepositAttestation {
  remittanceId: string; // no-vacío
  quoteId: string; // no-vacío
  depositAddress: string; // 0x + 40 hex (isAddress)
  chainId: number; // entero
  exp: number; // epoch SEGUNDOS
}

/** TTL de la atestación: 10 min acota la ventana de orden TransFi huérfana (DT-5) y queda por debajo
 *  de los 15 min de la atestación de settlement (DT-4). */
export const DEPOSIT_ATTESTATION_TTL_SECONDS = 10 * 60;

// Secreto NUEVO, SEPARADO de SETTLE_ATTESTATION_SECRET (DT-4: dominios distintos pre/post-settlement,
// jamás compartir). Se lee DENTRO de la función (no top-level) para que vi.stubEnv funcione (CD-14).
function secret(): string {
  const s = process.env.DEPOSIT_ATTESTATION_SECRET;
  if (!s) throw new Error("DEPOSIT_ATTESTATION_SECRET missing"); // la route corta antes (503)
  return s;
}

function sign(payloadB64: string): string {
  return createHmac("sha256", secret()).update(payloadB64).digest("base64url");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function issueDepositAttestation(p: DepositAttestation): string {
  const payloadB64 = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Devuelve null ante CUALQUIER problema (formato, HMAC, exp, tipos). Nunca throw por token inválido
 * (fail-closed en cada paso, CD-12). El HMAC malo y la expiración colapsan acá → ambos devuelven null
 * → el mismo 400 opaco en la route (no-oracle). Mirror byte-a-byte de verifySettlementAttestation.
 */
export function verifyDepositAttestation(
  token: string,
  nowMs: number,
): DepositAttestation | null {
  // 1. Formato: exactamente 2 partes no vacías.
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, macB64] = parts;
  if (!payloadB64 || !macB64) return null;

  // 2. Defensa: sin secreto no se verifica nada (la route ya cortó en PR2/503).
  if (!process.env.DEPOSIT_ATTESTATION_SECRET) return null;

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
  const { remittanceId, quoteId, depositAddress, chainId, exp } = parsed;
  if (typeof remittanceId !== "string" || remittanceId.length === 0) return null;
  if (typeof quoteId !== "string" || quoteId.length === 0) return null;
  if (typeof depositAddress !== "string" || !isAddress(depositAddress)) return null;
  if (typeof chainId !== "number" || !Number.isInteger(chainId)) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;

  // 6. Expiración.
  if (exp * 1000 <= nowMs) return null;

  return { remittanceId, quoteId, depositAddress, chainId, exp };
}
