// Infrastructure — cliente del /settle de wasiai-facilitator (HU-SOL-9 / WKH-208).
//
// ⚠️ DIRECTIVA DE ARQUITECTURA (CD-20, fundamento legal/PSAV — no estético):
// Este es el ÚNICO archivo del repo que conoce FACILITATOR_BASE_URL / FACILITATOR_API_KEY y el único
// que hace el POST a /settle. Es la ÚNICA pieza con exposición regulatoria: la Res. SBS 02648-2024
// define PSAV por la ACTIVIDAD ("transferencia de activos virtuales para o en nombre de otra
// persona"), no por la autodenominación.
// Si el veredicto es adverso, se REEMPLAZA ESTE ARCHIVO (quién transmite), no la HU.
//
// ⚠️ CD-10: la respuesta 200 de este cliente NO es verificación on-chain propia. El facilitador ECOA
// campos de nuestro input, así que de la respuesta sólo se toma la signature.
//
// WKH-320: acá vivía `broadcastSettle` (el BROADCAST del transferWithAuthorization EIP-3009 firmado)
// con su input EVM y su enum. Se fue con el camino que transmitía. Lo que queda es la mitad Solana,
// que es VERIFY-ONLY: la tx ya está finalizada on-chain cuando llegamos acá.
//
// CD-5/CD-18: cero escritura on-chain propia — delegamos en el /settle auditado de wasiai-facilitator.
// CD-6: se consume ÚNICAMENTE como servicio HTTP; PROHIBIDO importar su código.

/** El facilitador espera el receipt (RECEIPT_TIMEOUT_MS): 45s, NO 10s. Un settle real tarda más
 *  que un proxy común — no lo bajes "por consistencia" con las otras rutas. */
const SETTLE_TIMEOUT_MS = 45_000;

/**
 * ¿Hay un facilitator configurado? Lo expone ESTE módulo para que la route NO tenga que leer sus
 * envs: CD-20 exige que sean privadas de este archivo. Si mañana cambia (veredicto legal PSAV), se
 * reemplaza este archivo y la route ni se entera. Env leída dentro de la función (CD-14).
 */
export function isBroadcasterConfigured(): boolean {
  return Boolean(process.env.FACILITATOR_BASE_URL && process.env.FACILITATOR_API_KEY);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Mapa HTTP del facilitador → nuestro enum (S14-S20). Fail-closed: cualquier status desconocido
 *  cae en settle_unavailable — sin default permisivo (CD-12, lección WKH-198). */
function mapStatus(status: number): SolanaFacilitatorFailure {
  if (status === 401 || status === 403) return "settle_rejected"; // S14
  if (status === 400) return "settle_rejected"; // S15
  if (status === 409) return "settle_in_flight"; // S16
  if (status === 429 || status === 503) return "settle_unavailable"; // S17
  if (status === 500) return "settle_reverted"; // S18 — TRANSACTION_FAILED
  return "settle_unavailable"; // cualquier otro status: ambiguo ⇒ bloquear
}

// ── Solana (HU-SOL-9 / WKH-208) — verify-only sobre una tx YA FINALIZADA on-chain ────────────────
// La semántica del /settle Solana del facilitator es VERIFY + dedup (solana-adapter.ts: la tx ya está
// minada), NO broadcast → la función se llama verifySolanaSettlement (DT-4). Enum de resultado PROPIO
// (SDD §10: la semántica verify-only es más honesta que la de un broadcast).
export type SolanaFacilitatorFailure =
  | "settle_rejected" // 400/401/403 (INVALID_*, allowlist, auth)
  | "settle_in_flight" // 409 CONFLICT — dedup en vuelo, NO re-enviar
  | "settle_unavailable" // 429/503, sin config, timeout/fetch throw
  | "settle_reverted" // 500 TRANSACTION_FAILED
  | "settle_unverified"; // 200 con shape malo / settled!==true / signature no-base58

export type SolanaFacilitatorResult =
  | { ok: true; signature: string }
  | { ok: false; reason: SolanaFacilitatorFailure };

export interface SolanaSettleInput {
  cluster: "devnet"; // → accepted.network = `solana:${cluster}`
  mint: string; // base58 — accepted.asset (CD-9: server-side, jamás el body crudo)
  payTo: string; // base58 — accepted.payTo (== beneficiary ATESTADO, AC-4)
  amountMinor: string; // u64 decimal canónico (SPL base units) — accepted.amount
  signature: string; // base58 — tx signature YA FINALIZADA on-chain (origen: HU-SOL-14, Scope OUT)
  reference: string; // base58 — payload.reference (Solana Pay correlation)
  resourceUrl: string;
}

// CD-9: la signature es base58, NUNCA hexadecimal. Mismo criterio que isBase58Signature del
// adaptador Solana (BASE58_RE + longitud 64-120).
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
function isBase58Signature(v: unknown): v is string {
  return typeof v === "string" && BASE58_RE.test(v) && v.length >= 64 && v.length <= 120;
}

/**
 * Construye el envelope x402 `solana:<cluster>` en base58 y hace POST al MISMO /settle del facilitator.
 * VERIFY-ONLY (la tx ya está finalizada; el facilitator verifica + dedup, NO broadcastea — HU-SOL-14
 * produce la signature). Devuelve `{ ok:true, signature }` o `{ ok:false, reason }`. Nunca throw: toda
 * excepción se mapea a settle_unavailable. Env leída DENTRO de la función (CD-14). Reusa
 * isBroadcasterConfigured() + mapStatus() sin cambios.
 */
export async function verifySolanaSettlement(
  input: SolanaSettleInput,
): Promise<SolanaFacilitatorResult> {
  const BASE = process.env.FACILITATOR_BASE_URL;
  const KEY = process.env.FACILITATOR_API_KEY;
  if (!BASE || !KEY) return { ok: false, reason: "settle_unavailable" };

  // base58 asset/payTo, payload.signature/reference base58, SIN objeto `authorization`, SIN
  // `extra.assetTransferMethod` (no aplica a SPL).
  const payload = {
    x402Version: 2, // z.literal(2)
    resource: { url: input.resourceUrl },
    accepted: {
      scheme: "exact",
      network: `solana:${input.cluster}`, // namespace → dispatch al adaptador Solana
      amount: input.amountMinor, // u64 decimal canónico (string)
      asset: input.mint, // base58 (NO 0x-hex) — CD-9: server-side
      payTo: input.payTo, // base58 (NO 0x-hex) — CD-9: == beneficiary atestado
      maxTimeoutSeconds: 60,
    },
    payload: {
      signature: input.signature, // base58 tx sig (NO 0x-hex, NO objeto authorization)
      reference: input.reference, // base58 (Solana Pay correlation)
    },
  };

  let res: Response;
  try {
    res = await fetch(`${BASE}/settle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${KEY}`, // credencial server-side, jamás en el cliente
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "settle_unavailable" }; // timeout/DNS/fetch throw
  }

  if (!res.ok) return { ok: false, reason: mapStatus(res.status) };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: "settle_unverified" };
  }
  if (!isRecord(body)) return { ok: false, reason: "settle_unverified" };
  if (body.settled !== true) return { ok: false, reason: "settle_unverified" };
  // CD-9: la signature base58 viaja en el campo transactionHash del facilitator (nombre heredado).
  if (!isBase58Signature(body.transactionHash)) {
    return { ok: false, reason: "settle_unverified" };
  }
  return { ok: true, signature: body.transactionHash };
}
