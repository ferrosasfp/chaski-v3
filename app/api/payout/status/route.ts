// Server-side: el DESENLACE de un payout, leído del ledger (WKH-337/AC-1). La verdad ya existe —el
// webhook de TransFi muta `remittance_settlements` correlacionando por `payout_id`
// (`recordWebhookOutcome`, `../../webhooks/transfi/route.ts:89`)— y hasta ahora no la leía nadie: las
// DOS implementaciones de `PayoutGateway` son ciegas (sin `fetch`, sin usar el `payoutId`) y las dos lo
// declaran en su propio comentario. Esta ruta es la lectura que faltaba, no un gateway nuevo.
//
// CD-5/CD-14: sin proof-of-possession Solana esto sería un IDOR (con el `payoutId` de otro se leería el
// estado de su remesa). El PoP (P1..P5) es OBLIGATORIO y el `.eq('sender_address', ...)` del ledger es
// el guard REAL de ownership (el cliente Supabase usa el service key y BYPASSEA RLS).
//
// Guard-order fail-closed (envs en runtime, CD-14): PAYOUT_POP_SECRET → rate-limit → parse body → PoP
// completo → getSettlementLedger() → query. El check del ledger va DESPUÉS del PoP a propósito: si
// fuese antes, un caller sin firmar usaría el 501 como oráculo del estado del flag (no-oracle).
//
// 🔴 LO QUE ESTA RUTA NO PUEDE HACER, Y ES LA GARANTÍA DE LA HU: inventar un desenlace. `settled` no
// está en `RECOVERABLE` (`RECOVERABLE`,
// `../../../../src/application/use-cases/recover-escrow-funds.ts:40`) y no tiene transición de salida
// ⇒ un `settled` fabricado le quita al remitente su ÚNICO camino a sus USDC, para siempre. Toda
// degradación (429, 502, 501, 403, JSON roto) sale con un `error`, JAMÁS con un `payout.outcome`.
//
// CD-15/CD-16: NUNCA 500 crudo, NUNCA eco del `error.code` de Postgres, NUNCA se distingue en la
// respuesta por qué falló el PoP (403 opaco único). El 200 lleva UNA clave con ≤3 campos escalares:
// ni monto, ni value_minor, ni address, ni tx_hash, ni last_error, ni el eco del `payoutId`.
import { NextResponse } from "next/server";
import {
  buildSolanaPopMessage,
  verifySolanaPopChallenge,
} from "../../../../src/infrastructure/auth/pop-challenge";
import { verifySolanaPop } from "../../../../src/infrastructure/auth/pop-verify-solana";
import { resolveSolanaNetworkId } from "../../../../src/infrastructure/chain";
import { canonicalizeAddress } from "../../../../src/infrastructure/address";
import { getSettlementLedger } from "../../../../src/infrastructure/persistence/supabase-settlement-ledger";
import {
  PAYOUT_STATUS_RL,
  checkRouteRateLimit,
  clientIp,
} from "../../../../src/infrastructure/rate-limit";

// Tope de largo del `payoutId`. Los del proveedor son identificadores cortos; 200 deja margen de sobra
// y acota lo que entra al `.eq(...)` sin inventar un formato que el proveedor no garantiza.
const MAX_PAYOUT_ID_LEN = 200;

// Excluye arrays (mirror de prepare/route.ts:74-76).
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function POST(req: Request): Promise<Response> {
  // R1 — sin secreto no se puede verificar NINGÚN PoP ⇒ 503 fail-closed (NUNCA fail-open: sin esto el
  // endpoint degradaría a IDOR abierto).
  const POP_SECRET = process.env.PAYOUT_POP_SECRET; // CD-14: dentro del handler
  if (!POP_SECRET) {
    return NextResponse.json({ error: "payout_status_unavailable" }, { status: 503 });
  }

  // R2 — rate-limit IP-only, TRAS el 503 del secreto y ANTES de parsear/verificar (CPU-DoS del HMAC +
  // ed25519, y anti-enumeración de payoutId).
  const rl = await checkRouteRateLimit(PAYOUT_STATUS_RL, { ip: clientIp(req) });
  if (rl.unavailable) {
    return NextResponse.json({ error: "payout_status_unavailable" }, { status: 503 }); // fail-closed
  }
  if (!rl.ok) {
    return NextResponse.json(
      { error: "payout_status_rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } },
    );
  }

  // R3 — body null-safe: req.json() RESUELVE `null` para el body literal `null` (el .catch NO dispara);
  // isRecord cubre null y los no-objeto por igual.
  const parsed: unknown = await req.json().catch(() => null);
  const body: Record<string, unknown> = isRecord(parsed) ? parsed : {};
  const rawSender = typeof body.sender === "string" ? body.sender : "";
  const payoutId = typeof body.payoutId === "string" ? body.payoutId.trim() : "";
  if (!payoutId || payoutId.length > MAX_PAYOUT_ID_LEN) {
    return NextResponse.json({ error: "payout_status_invalid_request" }, { status: 400 });
  }
  let sender: string;
  try {
    sender = canonicalizeAddress(rawSender); // base58 32 bytes; malformado → throw
  } catch {
    return NextResponse.json({ error: "payout_status_invalid_request" }, { status: 400 });
  }

  // R4 — proof-of-possession Solana OBLIGATORIO. Copiado del bloque P1..P5 de
  // `remittance-ids/route.ts:73-113`. SIN claim-once del nonce (igual que prepare: se quema recién en
  // submit), y por eso la MISMA prueba sirve para las lecturas de una sesión de 10 min sin pedir una
  // firma nueva — que es lo que hace posible que el seguimiento no abra un popup cada 1,5 s.
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
    return NextResponse.json({ error: "payout_status_unverified" }, { status: 403 });
  }
  // P2 — HMAC + exp + tipos colapsan en null.
  const ch = verifySolanaPopChallenge(popChallenge, Date.now());
  if (!ch) {
    return NextResponse.json({ error: "payout_status_unverified" }, { status: 403 });
  }
  // P3 — address match (base58 case-sensitive): el challenge tiene que ser DE ESTE sender. Sin esto, un
  // caller presentaría el challenge+firma de la wallet A y pediría el estado del payout de la wallet B
  // (IDOR). Es el guard que T-337.9 ataca de frente.
  let chAddress: string;
  try {
    chAddress = canonicalizeAddress(ch.address);
    if (chAddress !== sender) {
      return NextResponse.json({ error: "payout_status_unverified" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "payout_status_unverified" }, { status: 403 });
  }
  // P4 — binding CAIP-2: el network-id del token vs el resuelto server-side, NUNCA del body
  // (anti-replay cross-cluster).
  if (ch.networkId !== resolveSolanaNetworkId()) {
    return NextResponse.json({ error: "payout_status_unverified" }, { status: 403 });
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
    return NextResponse.json({ error: "payout_status_unverified" }, { status: 403 });
  }

  // R5 — ledger DESPUÉS del PoP (no-oracle: el 501 no puede ser un sensor del flag para un anónimo).
  const ledger = getSettlementLedger();
  if (!ledger) {
    return NextResponse.json({ error: "payout_status_not_enabled" }, { status: 501 });
  }

  // R6 — lectura OWNER-SCOPED. 🔴 `chAddress` es la address del challenge VERIFICADO, JAMÁS
  // `body.sender`: P3 acaba de probar que son la misma, y ésta es la que no depende de lo que el caller
  // escribió. Si esto se alimentara del body, el `.eq(...)` se estaría comparando contra el input.
  let payout: Awaited<ReturnType<typeof ledger.lookupPayoutOutcome>>;
  try {
    payout = await ledger.lookupPayoutOutcome({ payoutId, senderAddress: chAddress });
  } catch {
    // NUNCA 500 crudo, NUNCA eco del error.code de Postgres. Y NUNCA un `payout` inventado: el cliente
    // tiene que poder distinguir "no se pudo leer" de los cuatro "no sé" reales.
    return NextResponse.json({ error: "payout_status_unavailable" }, { status: 502 });
  }

  // R7 — 200. UNA clave, ≤3 campos escalares (CD-16). `provenance` no es un dato nuevo para el cliente:
  // `/api/payout/prepare` ya se lo devuelve.
  return NextResponse.json({ payout }, { status: 200 });
}
