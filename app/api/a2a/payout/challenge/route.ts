// Server-side: emisor del challenge proof-of-possession del payout (WKH-206, AC-2). El caller pide un
// challenge para SU address; el server lo firma (HMAC PAYOUT_POP_SECRET, server-only SIN NEXT_PUBLIC_
// — CD-8) con un nonce single-use + expiración + chainId, y devuelve el popMessage que la wallet debe
// firmar VERBATIM. El nonce NO se quema acá (DT-5): se quema recién en /submit al presentar la firma.
//
// TODO defensivo: NUNCA 500 crudo. Sin secreto → 501 (no configurado, skip total del mecanismo).
// address malformada / body no-record → 400. NO fetchea Didit, NO lee estado KYC, NO escribe Upstash.
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { resolveChainId, resolveActiveVm } from "../../../../../src/infrastructure/chain";
import { canonicalizeAddress } from "../../../../../src/infrastructure/address";
import {
  POP_CHALLENGE_TTL_SECONDS,
  buildPopMessage,
  issuePopChallenge,
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

  const address = typeof body.address === "string" ? body.address : "";
  if (!isAddress(address)) {
    return NextResponse.json({ error: "pop_invalid_request" }, { status: 400 });
  }

  const nonce = randomBytes(16).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + POP_CHALLENGE_TTL_SECONDS;
  const chainId = resolveChainId(); // CD-9: la cadena sale de la ENV server-side, NUNCA del body
  const addr = canonicalizeAddress(address, resolveActiveVm());

  const challenge = issuePopChallenge({ address: addr, chainId, nonce, exp });
  const message = buildPopMessage({ address: addr, chainId, nonce, exp });

  return NextResponse.json({ popChallenge: challenge, popMessage: message, exp }, { status: 200 });
}
