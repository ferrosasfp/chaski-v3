// Server-side: proxy al agente remit-cashout-payout (WKH-186). REMIT_AGENTS_BASE_URL vive SOLO acá
// (CD-9, SIN NEXT_PUBLIC_): nunca llega al cliente; la ruta sólo devuelve { result }. Forwarda el
// beneficiary al agente (necesario para el payout) pero NUNCA lo loguea ni lo ecoa en un error
// (CD-5). El idempotencyKey se forwarda TAL CUAL (CD-10, no regenerar). TODO en try/catch: nunca
// 500 crudo. El agente corre en PAYOUT_ALLOW_MOCK (no desembolsa real sin creds TransFi) — 2ª capa
// money-path fuera de esta HU.
import { NextResponse } from "next/server";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Shape mínimo esperado del result del agente (validación defensiva, sin any).
function isValidPayoutResult(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const statusOk =
    v.status === "submitted" || v.status === "settled" || v.status === "failed" || v.status === "blocked";
  if (!statusOk) return false;
  if (!(typeof v.payoutId === "string" || v.payoutId === null)) return false;
  if (!(typeof v.deliveredLocal === "number" || v.deliveredLocal === null)) return false;
  if (!(typeof v.txRef === "string" || v.txRef === null)) return false;
  if (!(typeof v.reason === "string" || v.reason === null)) return false;
  // MNR-C: alineado con isValidPayoutShape del gateway (gateways.ts, la autoridad de shape). payoutId
  // null SOLO es válido cuando el payout no se ejecutó (failed/blocked); settled/submitted sin payoutId
  // → shape inválido (no podríamos trackear el payout). La route es tan estricta como el gateway.
  if (v.payoutId === null && v.status !== "failed" && v.status !== "blocked") return false;
  return true;
}

export async function POST(req: Request): Promise<Response> {
  const BASE = process.env.REMIT_AGENTS_BASE_URL; // server-only (CD-9), leído en runtime
  if (!BASE) return NextResponse.json({ error: "a2a_not_configured" }, { status: 501 });
  const body = await req.json().catch(() => ({}));
  try {
    const res = await fetch(`${BASE}/api/agents/remit-cashout-payout/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body), // idempotencyKey/beneficiary forwardeados tal cual (CD-10)
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return NextResponse.json({ error: "a2a_upstream_error" }, { status: 502 });
    const { result } = (await res.json()) as { result: unknown };
    if (!isValidPayoutResult(result)) {
      return NextResponse.json({ error: "a2a_bad_shape" }, { status: 502 });
    }
    return NextResponse.json({ result }, { status: 200 }); // sólo el result (nunca BASE ni PII)
  } catch {
    // timeout/DNS/parse → 502 opaco (nunca 500 crudo, nunca ecoa el beneficiary)
    return NextResponse.json({ error: "a2a_unavailable" }, { status: 502 });
  }
}
