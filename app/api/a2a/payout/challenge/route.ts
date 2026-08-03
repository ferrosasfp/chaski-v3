// Server-side: emisor del challenge proof-of-possession del payout (WKH-206 / HU-SOL-8, AC-2). El
// caller pide un challenge para SU address; el server lo firma (HMAC PAYOUT_POP_SECRET, server-only
// SIN NEXT_PUBLIC_ — CD-8) con un nonce + expiración + network-id CAIP-2, y devuelve el popMessage
// que la wallet debe firmar VERBATIM.
// El nonce NO se quema (DT-5). Acá decía que el anti-replay dentro del TTL "es responsabilidad del
// facilitator, que es quien exige y verifica la prueba": es falso, y el SDD 037 lo corrige. Aquella
// prueba pertenecía al leg de PATROCINIO (otro mecanismo, otro dominio de mensaje) y además fue
// borrada. El facilitator nunca ve ESTE challenge y no puede quemar ESTE nonce. Lo cierto: nadie lo
// quema, así que dentro del TTL de 10 minutos un par (challenge, firma) capturado se puede reenviar.
// Residual R-3 documentado.
//
// TODO defensivo: NUNCA 500 crudo. Sin secreto → 501 (no configurado, skip total del mecanismo).
// address malformada / body no-record → 400. NO fetchea Didit, NO lee estado KYC, NO escribe Upstash.
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { resolveSolanaNetworkId } from "../../../../../src/infrastructure/chain";
import { canonicalizeAddress } from "../../../../../src/infrastructure/address";
import {
  POP_CHALLENGE_TTL_SECONDS,
  buildSolanaPopMessage,
  issueSolanaPopChallenge,
} from "../../../../../src/infrastructure/auth/pop-challenge";
import {
  PAYOUT_CHALLENGE_RL,
  checkRouteRateLimit,
  clientIp,
} from "../../../../../src/infrastructure/rate-limit";

// CD-5/MNR-5: excluye arrays.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function POST(req: Request): Promise<Response> {
  const POP_SECRET = process.env.PAYOUT_POP_SECRET; // CD-14: dentro del handler
  if (!POP_SECRET) {
    // Mecanismo apagado (default): el cliente lo trata como skip.
    return NextResponse.json({ error: "pop_not_configured" }, { status: 501 });
  }

  // WKH-205 AC-5/AC-6/CD-9: rate-limit IP-only, TRAS el 501 de POP_SECRET y ANTES de parsear el body
  // / emitir el HMAC (CPU-DoS). IP-only: el body (y el address) aún no se parsean acá.
  const rl = await checkRouteRateLimit(PAYOUT_CHALLENGE_RL, { ip: clientIp(req) });
  if (rl.unavailable) {
    return NextResponse.json({ error: "pop_rate_limit_unavailable" }, { status: 503 }); // AC-6 fail-closed
  }
  if (!rl.ok) {
    return NextResponse.json(
      { error: "pop_rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } },
    );
  }

  // BLQ-BAJO-1 (auto-blindaje WKH-202): req.json() RESUELVE con `null` para el literal `null` → el
  // .catch NO dispara; isRecord cubre null y los no-objeto por igual.
  const parsed: unknown = await req.json().catch(() => null);
  const body: Record<string, unknown> = isRecord(parsed) ? parsed : {};

  const rawAddress = typeof body.address === "string" ? body.address : "";

  // HU-SOL-8/CD-3: challenge ed25519 con network-id CAIP-2 (server-side, NUNCA del body).
  let addr: string;
  try {
    addr = canonicalizeAddress(rawAddress); // base58 32 bytes (CD-8)
  } catch {
    return NextResponse.json({ error: "pop_invalid_request" }, { status: 400 });
  }
  const networkId = resolveSolanaNetworkId(); // CD-3: server-side, NUNCA del body
  const nonce = randomBytes(16).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + POP_CHALLENGE_TTL_SECONDS;
  const popChallenge = issueSolanaPopChallenge({ address: addr, networkId, nonce, exp });
  const popMessage = buildSolanaPopMessage({ address: addr, networkId, nonce, exp });
  return NextResponse.json({ popChallenge, popMessage, exp }, { status: 200 });
}
