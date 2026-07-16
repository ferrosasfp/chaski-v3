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
import { resolveChainId } from "../../../../../src/infrastructure/chain";
import {
  POP_CHALLENGE_TTL_SECONDS,
  buildPopMessage,
  issuePopChallenge,
} from "../../../../../src/infrastructure/auth/pop-challenge";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export async function POST(req: Request): Promise<Response> {
  const POP_SECRET = process.env.PAYOUT_POP_SECRET; // CD-14: dentro del handler
  if (!POP_SECRET) {
    // Mecanismo apagado (default): el cliente lo trata como skip.
    return NextResponse.json({ error: "pop_not_configured" }, { status: 501 });
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
  const addr = address.toLowerCase();

  const challenge = issuePopChallenge({ address: addr, chainId, nonce, exp });
  const message = buildPopMessage({ address: addr, chainId, nonce, exp });

  return NextResponse.json({ popChallenge: challenge, popMessage: message, exp }, { status: 200 });
}
