// Infrastructure — BROADCAST del transferWithAuthorization firmado (WKH-168, AC-1/AC-7).
//
// ⚠️ DIRECTIVA DE ARQUITECTURA (CD-20, fundamento legal/PSAV — no estético):
// Este es el ÚNICO archivo del repo que conoce FACILITATOR_BASE_URL / FACILITATOR_API_KEY y el único
// que hace el POST a /settle. Es la ÚNICA pieza con exposición regulatoria: la Res. SBS 02648-2024
// define PSAV por la ACTIVIDAD ("transferencia de activos virtuales para o en nombre de otra
// persona"), no por la autodenominación. Que nuestro relayer transmita el transferWithAuthorization
// del usuario es el caso ambiguo que está con el abogado.
// Si el veredicto es adverso, se REEMPLAZA ESTE ARCHIVO (quién transmite), no la HU: el verificador
// on-chain (onchain-verifier.ts) es agnóstico del broadcaster (CD-21) y sobrevive intacto.
//
// ⚠️ CD-10: la respuesta 200 de este cliente NO es verificación on-chain. El facilitador ECOA
// nuestro propio input (base-adapter.ts:811,817-819: "Fields from input params, NOT re-read from
// chain"). Este archivo NO verifica nada: devuelve un txHash o un error. La verificación es del
// onchain-verifier, que lee la cadena por su cuenta. NO importa el verificador (CD-21).
//
// CD-5/CD-18: cero escritura on-chain propia — delegamos en el /settle auditado de wasiai-facilitator.
// CD-6: se consume ÚNICAMENTE como servicio HTTP; PROHIBIDO importar su código.
import type { Eip3009Authorization } from "../../application/ports";

/** Motivos de fallo del BROADCAST. Mapa cerrado: nada del facilitador se ecoa al caller (CD-12,
 *  no-oracle) — solo nuestros enums. */
export type FacilitatorFailure =
  | "settle_rejected" // 401/403 (allowlist de payTo, auth) y 400 (INVALID_*, NETWORK_MISMATCH…)
  | "settle_in_flight" // 409 CONFLICT — el cliente NO debe re-firmar (DT-6)
  | "settle_unavailable" // 429/503 (RATE_LIMITED, CHAIN_UNAVAILABLE, OPERATOR_FUNDING_LOW), timeout
  | "settle_reverted" // 500 TRANSACTION_FAILED (incluye revert on-chain)
  | "settle_unverified"; // 200 con shape malo / settled!==true / txHash inválido

export type FacilitatorResult =
  | { ok: true; txHash: string }
  | { ok: false; reason: FacilitatorFailure };

export interface SettleBroadcastInput {
  authorization: Eip3009Authorization;
  signature: string;
  /** Fuente OBLIGATORIA: env server-side (CD-9). NUNCA del body. */
  payTo: string;
  asset: string;
  chainId: number;
  /** Ya pinneado igual a authorization.value por S11 (igualdad EXACTA). */
  amountMinor: string;
  resourceUrl: string;
}

/** El facilitador espera el receipt (RECEIPT_TIMEOUT_MS): 45s, NO 10s. Un settle real tarda más
 *  que un proxy común — no lo bajes "por consistencia" con las otras rutas. */
const SETTLE_TIMEOUT_MS = 45_000;

/**
 * ¿Hay un broadcaster configurado? (rama S2 → 501). Lo expone ESTE módulo para que la route NO
 * tenga que leer las envs del broadcaster: CD-20 exige que sean privadas de este archivo. Si mañana
 * el broadcaster cambia (veredicto legal PSAV), se reemplaza este archivo y la route ni se entera.
 * Env leída dentro de la función (CD-14).
 */
export function isBroadcasterConfigured(): boolean {
  return Boolean(process.env.FACILITATOR_BASE_URL && process.env.FACILITATOR_API_KEY);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Mapa HTTP del facilitador → nuestro enum (S14-S20). Fail-closed: cualquier status desconocido
 *  cae en settle_unavailable — sin default permisivo (CD-12, lección WKH-198). */
function mapStatus(status: number): FacilitatorFailure {
  if (status === 401 || status === 403) return "settle_rejected"; // S14
  if (status === 400) return "settle_rejected"; // S15
  if (status === 409) return "settle_in_flight"; // S16
  if (status === 429 || status === 503) return "settle_unavailable"; // S17
  if (status === 500) return "settle_reverted"; // S18 — TRANSACTION_FAILED
  return "settle_unavailable"; // cualquier otro status: ambiguo ⇒ bloquear
}

/**
 * Transmite la autorización firmada. Devuelve un txHash (que TODAVÍA hay que verificar on-chain) o
 * un error opaco. Nunca throw: toda excepción se mapea (CD-12).
 *
 * Env leída DENTRO de la función (CD-14: vi.stubEnv). Sin config → settle_unavailable (la route ya
 * cortó antes con 501 en S2; esto es defensa en profundidad).
 */
export async function broadcastSettle(input: SettleBroadcastInput): Promise<FacilitatorResult> {
  const BASE = process.env.FACILITATOR_BASE_URL;
  const KEY = process.env.FACILITATOR_API_KEY;
  if (!BASE || !KEY) return { ok: false, reason: "settle_unavailable" };

  // Contrato EXACTO del Zod del facilitador. TODOS los objetos son .strict() ⇒ un campo extra = 400.
  const payload = {
    x402Version: 2, // z.literal(2) — el NÚMERO 2, no "2"
    resource: { url: input.resourceUrl },
    accepted: {
      scheme: "exact",
      network: `eip155:${input.chainId}`,
      amount: input.amountMinor, // uint256 decimal canónico (string)
      asset: input.asset, // CD-9: env, jamás el body
      payTo: input.payTo, // CD-9: env, jamás el body
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
    },
    payload: {
      signature: input.signature,
      authorization: input.authorization, // ya en strings canónicos (CD-16, serializado en wallet.ts)
    },
  };

  let res: Response;
  try {
    res = await fetch(`${BASE}/settle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${KEY}`, // AC-7: la credencial vive server-side, jamás en el cliente
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS),
    });
  } catch {
    // S19 — timeout/DNS/fetch throw. AMBIGUO: la tx PUDO minarse. Fail-closed igual; el reintento con
    // el MISMO nonce determinístico (CD-19) es seguro: el contrato revierte el 2º settle.
    return { ok: false, reason: "settle_unavailable" };
  }

  if (!res.ok) return { ok: false, reason: mapStatus(res.status) }; // S14-S18

  // S20 — NUNCA asumir éxito por HTTP 200.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: "settle_unverified" };
  }
  if (!isRecord(body)) return { ok: false, reason: "settle_unverified" };
  if (body.settled !== true) return { ok: false, reason: "settle_unverified" };
  const txHash = body.transactionHash;
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: "settle_unverified" };
  }

  // S21 — el 200 NO es suficiente: `amount`/`from`/`to` de la respuesta son un ECO de nuestro input
  // (CD-10) y se IGNORAN a propósito. Solo devolvemos el txHash → la rama V lo verifica leyendo la
  // cadena. Chequear body.to === payTo acá sería comparar nuestro input contra nuestro input.
  return { ok: true, txHash };
}

// ── Solana (HU-SOL-9 / WKH-208) — verify-only sobre una tx YA FINALIZADA on-chain ────────────────
// La semántica del /settle Solana del facilitator es VERIFY + dedup (solana-adapter.ts: la tx ya está
// minada), NO broadcast → la función se llama verifySolanaSettlement (DT-4). Función + objeto literal
// NUEVOS: el objeto `payload` de la rama EIP-3009 (broadcastSettle) NO se muta (AC-3). Enum de
// resultado PROPIO (SDD §10: semántica verify-only más honesta, no se mezcla con la de broadcast).
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

// CD-9: NO se reusa el regex 0x-64 de la respuesta EVM (rechazaría una signature base58). Mismo
// criterio que isBase58Signature del adaptador Solana (BASE58_RE + longitud 64-120).
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

  // Objeto literal NUEVO (AC-3): base58 asset/payTo, payload.signature/reference base58, SIN el
  // objeto `authorization` de EIP-3009, SIN `extra.assetTransferMethod` (no aplica a SPL).
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
  // CD-9: la signature base58 viaja en transactionHash (el adaptador la castea `as 0x` por tipo).
  if (!isBase58Signature(body.transactionHash)) {
    return { ok: false, reason: "settle_unverified" };
  }
  return { ok: true, signature: body.transactionHash };
}
