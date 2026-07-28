// Server-side: recuperación de los `remittanceId` de un sender Solana (HU-SOL-20/AC-2). La PDA del
// escrow se deriva del remittanceId; si el cliente lo perdió (localStorage borrado / otro dispositivo)
// los fondos quedan inalcanzables. Este endpoint expone la fila durable que `prepare` ya escribe en
// `remittance_settlements` — pero SOLO a quien prueba posesión de la wallet.
//
// CD-16: sin proof-of-possession Solana esto sería un IDOR (cualquiera enumeraría las remesas de otro).
// El PoP (P1..P5) es OBLIGATORIO y el `.eq('sender_address', ...)` del ledger es el guard REAL de
// ownership (el cliente Supabase usa el service key y BYPASSEA RLS).
//
// Guard-order fail-closed (envs en runtime, CD-14): PAYOUT_POP_SECRET → rate-limit → parse body →
// PoP completo → getSettlementLedger() → query. El check del ledger va DESPUÉS del PoP a propósito: si
// fuese antes, un caller sin firmar usaría el 501 como oráculo del estado del flag (no-oracle).
//
// TODO defensivo: NUNCA 500 crudo, NUNCA eco del motivo (enums estables), NUNCA PII ni value_minor.
import { NextResponse } from "next/server";
import {
  buildSolanaPopMessage,
  verifySolanaPopChallenge,
} from "../../../../../src/infrastructure/auth/pop-challenge";
import { verifySolanaPop } from "../../../../../src/infrastructure/auth/pop-verify-solana";
import { resolveSolanaNetworkId } from "../../../../../src/infrastructure/chain";
import { canonicalizeAddress } from "../../../../../src/infrastructure/address";
import { getSettlementLedger } from "../../../../../src/infrastructure/persistence/supabase-settlement-ledger";
import {
  ESCROW_RECOVERY_RL,
  checkRouteRateLimit,
  clientIp,
} from "../../../../../src/infrastructure/rate-limit";

// Límite duro server-side: un sender legítimo no necesita más para recuperar su escrow, y acota el
// tamaño de la respuesta ante una cuenta con mucha historia.
const MAX_IDS = 20;

// Excluye arrays (mirror de prepare/route.ts:44-46).
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function POST(req: Request): Promise<Response> {
  // R1 — sin secreto no se puede verificar NINGÚN PoP ⇒ 503 fail-closed (NUNCA fail-open: sin esto el
  // endpoint degradaría a IDOR abierto). Mirror de prepare/route.ts:145-147.
  const POP_SECRET = process.env.PAYOUT_POP_SECRET; // CD-14: dentro del handler
  if (!POP_SECRET) {
    return NextResponse.json({ error: "escrow_recovery_unavailable" }, { status: 503 });
  }

  // R2 — rate-limit IP-only, TRAS el 503 del secreto y ANTES de parsear/verificar (CPU-DoS del HMAC +
  // ed25519, y anti-enumeración). Mirror de challenge/route.ts:44-53.
  const rl = await checkRouteRateLimit(ESCROW_RECOVERY_RL, { ip: clientIp(req) });
  if (rl.unavailable) {
    return NextResponse.json({ error: "escrow_recovery_unavailable" }, { status: 503 }); // fail-closed
  }
  if (!rl.ok) {
    return NextResponse.json(
      { error: "escrow_recovery_rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } },
    );
  }

  // R3 — body null-safe: req.json() RESUELVE `null` para el body literal `null` (el .catch NO dispara);
  // isRecord cubre null y los no-objeto por igual.
  const parsed: unknown = await req.json().catch(() => null);
  const body: Record<string, unknown> = isRecord(parsed) ? parsed : {};
  const rawSender = typeof body.sender === "string" ? body.sender : "";
  let sender: string;
  try {
    sender = canonicalizeAddress(rawSender, "solana"); // base58 32 bytes; malformado → throw
  } catch {
    return NextResponse.json({ error: "escrow_recovery_invalid_request" }, { status: 400 });
  }

  // R4 — proof-of-possession Solana OBLIGATORIO (CD-16). Copiado del bloque P1..P5 de
  // prepare/route.ts:148-186. SIN claim-once del nonce (igual que prepare: se quema recién en submit).
  // CUALQUIER falla colapsa en el MISMO 403 opaco (no-oracle: no distinguir el motivo).
  const popChallenge = body.popChallenge;
  const popSignature = body.popSignature;
  // P1 — presencia + tipo.
  if (
    typeof popChallenge !== "string" ||
    !popChallenge.trim() ||
    typeof popSignature !== "string" ||
    !popSignature.trim()
  ) {
    return NextResponse.json({ error: "escrow_recovery_unverified" }, { status: 403 });
  }
  // P2 — HMAC + exp + tipos colapsan en null.
  const ch = verifySolanaPopChallenge(popChallenge, Date.now());
  if (!ch) {
    return NextResponse.json({ error: "escrow_recovery_unverified" }, { status: 403 });
  }
  // P3 — address match (base58 case-sensitive): el challenge tiene que ser DE ESTE sender. Sin esto,
  // un caller presentaría el challenge+firma de la wallet A y pediría los ids de la wallet B (IDOR).
  try {
    if (canonicalizeAddress(ch.address, "solana") !== sender) {
      return NextResponse.json({ error: "escrow_recovery_unverified" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "escrow_recovery_unverified" }, { status: 403 });
  }
  // P4 — binding CAIP-2: el network-id del token vs el resuelto server-side, NUNCA del body
  // (anti-replay cross-cluster).
  if (ch.networkId !== resolveSolanaNetworkId()) {
    return NextResponse.json({ error: "escrow_recovery_unverified" }, { status: 403 });
  }
  // P5 — ed25519 sobre el mensaje reconstruido con la MISMA buildSolanaPopMessage (única fuente del
  // formato): prueba criptográfica de posesión de la private key de `sender`.
  if (
    !verifySolanaPop({
      addressBase58: ch.address,
      message: buildSolanaPopMessage(ch),
      signatureBase58: popSignature,
    })
  ) {
    return NextResponse.json({ error: "escrow_recovery_unverified" }, { status: 403 });
  }

  // R5 — ledger DESPUÉS del PoP (no-oracle: el 501 no puede ser un sensor del flag para un anónimo).
  const ledger = getSettlementLedger();
  if (!ledger) {
    return NextResponse.json({ error: "escrow_recovery_not_enabled" }, { status: 501 });
  }

  // R6 — lectura OWNER-SCOPED. `sender` es la address PoP-verificada, NUNCA un valor crudo del body.
  let refs: Array<{ remittanceId: string; status: string; createdAt: string }>;
  try {
    refs = await ledger.listRemittanceIdsBySender({
      senderAddress: sender,
      vm: "solana",
      limit: MAX_IDS,
    });
  } catch {
    // NUNCA 500 crudo, NUNCA eco del error.code de Postgres.
    return NextResponse.json({ error: "escrow_recovery_unavailable" }, { status: 502 });
  }

  // R7 — 200. Solo remittanceId/status/createdAt: ni PII, ni montos, ni addresses (CD-7).
  return NextResponse.json({ remittanceIds: refs }, { status: 200 });
}
