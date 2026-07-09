// Server-side: consulta la decisión de una sesión Didit y la mapea a nuestro modelo.
// GET /v3/session/{id}/decision/ con header x-api-key. Env-gated (501 si no hay key).
import { NextResponse } from "next/server";
import { mapDiditDecision } from "../../../../src/infrastructure/didit/decision";

const BASE = process.env.DIDIT_BASE_URL ?? "https://verification.didit.me";

export async function GET(req: Request): Promise<Response> {
  const apiKey = process.env.DIDIT_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "didit_not_configured" }, { status: 501 });

  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "missing_session" }, { status: 400 });

  const res = await fetch(`${BASE}/v3/session/${encodeURIComponent(sessionId)}/decision/`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    return NextResponse.json({ error: "didit_decision_failed", upstream: res.status }, { status: 502 });
  }

  const decision = await res.json();
  return NextResponse.json(mapDiditDecision(decision));
}
