// Infrastructure — atestación HMAC del destino no-custodial del depósito (WKH-211 / HU-SOL-9, AC-2).
//
// Qué prueba: que el server creó la orden TransFi y ató el destino asignado a ESTA remesa
// (remittanceId + quoteId + cluster) ANTES de que el cliente firme. El atacante NO puede forjarla sin
// DEPOSIT_ATTESTATION_SECRET → es lo que impide inyectar un destino propio en la firma y desviar los
// fondos (el vector no-custodial que esta HU cierra).
//
// Formato: `${b64url(JSON.stringify(payload))}.${b64url(hmac(b64urlPayload))}`. El HMAC se calcula
// sobre el STRING base64url del payload (no sobre el JSON crudo): así verify() re-HMACea el string
// recibido tal cual y no depende de que JSON.stringify re-serialice idéntico.
//
// Crypto: node:crypto (createHmac/timingSafeEqual). NO jsonwebtoken/jose.
// SIN claim-once (DT-6): el binding es stateless — el escrow Anchor hace el 2º depósito imposible a
// nivel programa (la PDA por remittanceId ya existe), no hace falta estado extra acá.
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalizeAddress } from "../address";

// Binding pre-settlement del escrow Solana (HU-SOL-9 / WKH-208, DT-2 / CD-8).
export interface SolanaDepositAttestation {
  remittanceId: string; // no-vacío
  quoteId: string; // no-vacío
  beneficiary: string; // base58 — destino del release del escrow (== payTo atestado, AC-4)
  authority: string; // base58 — release-authority (facilitator, resuelto server-side env-driven)
  cluster: "devnet"; // análogo Solana de chainId (anti-replay cross-cluster, AC-5)
  exp: number; // epoch SEGUNDOS
}

/** TTL de la atestación: 10 min acota la ventana de orden TransFi huérfana (DT-5). */
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

// ── Solana (HU-SOL-9 / WKH-208) — issue/verify sobre el esqueleto HMAC ────────────────────────────
export function issueSolanaDepositAttestation(p: SolanaDepositAttestation): string {
  const payloadB64 = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Devuelve null ante CUALQUIER problema (formato, HMAC, exp, tipos, base58 deforme). Nunca throw por
 * token inválido (fail-closed en cada paso, AC-5, no-oracle). Esqueleto:
 * formato → HMAC-primero (longitud-primero + timingSafe) → parse try/catch → tipos por-campo → exp.
 * `beneficiary`/`authority`: base58 vía canonicalizeAddress() en try/catch → null si throwea (NUNCA un
 * validador hexadecimal, CD-2). La igualdad se compara canónica case-sensitive (CD-10), NO lowercase.
 */
export function verifySolanaDepositAttestation(
  token: string,
  nowMs: number,
): SolanaDepositAttestation | null {
  // 1. Formato: exactamente 2 partes no vacías.
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, macB64] = parts;
  if (!payloadB64 || !macB64) return null;

  // 2. Defensa: sin secreto no se verifica nada.
  if (!process.env.DEPOSIT_ATTESTATION_SECRET) return null;

  // 3. HMAC PRIMERO — longitud primero (timingSafeEqual TIRA con buffers de distinta longitud),
  //    luego comparación timing-safe.
  const expected = Buffer.from(sign(payloadB64));
  const received = Buffer.from(macB64);
  if (expected.length !== received.length) return null;
  if (!timingSafeEqual(expected, received)) return null;

  // 4. Parse DENTRO de try/catch.
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  // 5. Validar el tipo de CADA campo.
  const { remittanceId, quoteId, beneficiary, authority, cluster, exp } = parsed;
  if (typeof remittanceId !== "string" || remittanceId.length === 0) return null;
  if (typeof quoteId !== "string" || quoteId.length === 0) return null;
  if (typeof beneficiary !== "string" || beneficiary.length === 0) return null;
  if (typeof authority !== "string" || authority.length === 0) return null;
  // base58 válido: canonicalizeAddress throwea con base58 deforme → fail-closed a null (CD-2, sin
  // ecoar la address). NO se lowercasea (CD-10: reabre el IDOR de aliasing).
  try {
    canonicalizeAddress(beneficiary);
    canonicalizeAddress(authority);
  } catch {
    return null;
  }
  if (cluster !== "devnet") return null; // única entrada de esta HU (anti-replay cross-cluster)
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;

  // 6. Expiración.
  if (exp * 1000 <= nowMs) return null;

  return { remittanceId, quoteId, beneficiary, authority, cluster, exp };
}
