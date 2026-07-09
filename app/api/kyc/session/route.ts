// Server-side: crea una sesión de verificación en Didit. El API key vive SOLO acá (env),
// nunca llega al browser. POST /v3/session/ con header x-api-key. Env-gated (501 si no hay key).
import { NextResponse } from "next/server";

const BASE = process.env.DIDIT_BASE_URL ?? "https://verification.didit.me";

export async function POST(req: Request): Promise<Response> {
  const apiKey = process.env.DIDIT_API_KEY;
  const workflowId = process.env.DIDIT_WORKFLOW_ID;
  if (!apiKey || !workflowId) {
    return NextResponse.json({ error: "didit_not_configured" }, { status: 501 });
  }

  const body = (await req.json().catch(() => ({}))) as { vendorData?: string; callback?: string };

  const res = await fetch(`${BASE}/v3/session/`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      workflow_id: workflowId,
      vendor_data: body.vendorData,
      callback: body.callback,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    return NextResponse.json({ error: "didit_session_failed", upstream: res.status }, { status: 502 });
  }

  const d = (await res.json()) as { session_id: string; url: string; session_token?: string };
  return NextResponse.json({ sessionId: d.session_id, url: d.url, sessionToken: d.session_token });
}
