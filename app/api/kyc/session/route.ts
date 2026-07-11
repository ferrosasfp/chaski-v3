// Server-side: crea una sesión de verificación en Didit. El API key vive SOLO acá (env),
// nunca llega al browser. POST /v3/session/ con header x-api-key. Env-gated (501 si no hay key).
// WKH-179: rate-limit por IP + address ANTES de llamar a Didit (financial-DoS, A2); callback
// reconstruido server-side (ignora body.callback, M6); emite el token HMAC de sesión (B1).
// Guard-order: 501 → 500 → rate-limit → callback server-side → Didit → issue token (CD-2).
import { NextResponse } from "next/server";
import { issueSessionToken } from "../../../../src/infrastructure/kyc-auth";
import { checkKycRateLimit } from "../../../../src/infrastructure/rate-limit";

const BASE = process.env.DIDIT_BASE_URL ?? "https://verification.didit.me";

// MNR-1: la key del rate-limit por IP debe venir de una fuente que el cliente NO pueda forjar.
// En Vercel, `x-vercel-forwarded-for` y `x-real-ip` los INYECTA/SOBRESCRIBE la edge de Vercel con la
// IP real del cliente (equivalen a `ipAddress()` de @vercel/functions, que lee `x-real-ip`) → fuente
// primaria confiable. El `x-forwarded-for` crudo es una cadena parcialmente controlada por el cliente:
// su entry MÁS A LA IZQUIERDA es spoofeable, y tomarlo (como antes) permitía evadir el límite por IP
// rotando el header. Por eso XFF es SOLO último recurso y, de usarlo, tomamos el valor MÁS A LA
// DERECHA (el que agrega el proxy de confianza más cercano), nunca el leftmost.
function clientIp(req: Request): string {
  const trusted =
    req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim();
  if (trusted) return trusted;

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1]!;
  }
  return "unknown";
}

export async function POST(req: Request): Promise<Response> {
  const apiKey = process.env.DIDIT_API_KEY;
  const workflowId = process.env.DIDIT_WORKFLOW_ID;
  if (!apiKey || !workflowId) {
    return NextResponse.json({ error: "didit_not_configured" }, { status: 501 });
  }

  if (!process.env.KYC_SESSION_SECRET) {
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  const body = (await req.json().catch(() => ({}))) as { vendorData?: string; callback?: string };

  // Rate-limit ANTES de cualquier fetch a Didit (CD-2). Fail-closed si Upstash no está (503).
  const rl = await checkKycRateLimit({ ip: clientIp(req), address: body.vendorData });
  if (rl.unavailable) {
    return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  }
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } },
    );
  }

  // Callback server-side: se IGNORA body.callback por completo (M6). Sin base URL → sin callback
  // (Didit muestra su pantalla default; el resume anda por localStorage).
  const callbackBase = process.env.KYC_CALLBACK_BASE_URL;
  const callback = callbackBase ? `${callbackBase}/kyc/callback` : undefined;

  const res = await fetch(`${BASE}/v3/session/`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      workflow_id: workflowId,
      vendor_data: body.vendorData,
      callback,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    return NextResponse.json({ error: "didit_session_failed", upstream: res.status }, { status: 502 });
  }

  const d = (await res.json()) as { session_id: string; url: string; session_token?: string };
  // sessionToken = de Didit (NO tocar). authToken = NUESTRO HMAC (nuevo, CD-10).
  const authToken = issueSessionToken(d.session_id);
  return NextResponse.json({
    sessionId: d.session_id,
    url: d.url,
    sessionToken: d.session_token,
    authToken,
  });
}
