// Server-side: consulta la decisión de una sesión Didit y la mapea a nuestro modelo.
// GET /v3/session/{id}/decision/ con header x-api-key. Env-gated (501 si no hay key).
// WKH-179: exige token HMAC de sesión (x-kyc-token) → cierra el IDOR/PII-leak (B1). El
// documentNumber se enmascara en la respuesta (defensa en profundidad). Guard-order: 501 → 500
// → 400 → 401 → recién Didit (nunca fetch a Didit sin autorización, CD-2).
import { NextResponse } from "next/server";
import { mapDiditDecision, maskDecision } from "../../../../src/infrastructure/didit/decision";
import { verifySessionToken } from "../../../../src/infrastructure/kyc-auth";

const BASE = process.env.DIDIT_BASE_URL ?? "https://verification.didit.me";

export async function GET(req: Request): Promise<Response> {
  const apiKey = process.env.DIDIT_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "didit_not_configured" }, { status: 501 });

  if (!process.env.KYC_SESSION_SECRET) {
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "missing_session" }, { status: 400 });

  // Auth: mismo cuerpo/status para "sin token" y "token inválido" (anti-enumeración, CD-5).
  // NO se llama a Didit en ninguno de los dos casos (CD-2).
  const token = req.headers.get("x-kyc-token");
  if (!token || !verifySessionToken(sessionId, token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const res = await fetch(`${BASE}/v3/session/${encodeURIComponent(sessionId)}/decision/`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    return NextResponse.json({ error: "didit_decision_failed", upstream: res.status }, { status: 502 });
  }

  const decision = await res.json();
  return NextResponse.json(maskDecision(mapDiditDecision(decision)));
}
