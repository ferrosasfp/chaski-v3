// Server-side: proxy al agente remit-corridor-fx (WKH-186). REMIT_AGENTS_BASE_URL vive SOLO acá
// (CD-9, SIN NEXT_PUBLIC_): nunca llega al cliente; la ruta sólo devuelve { result }. Patrón de
// app/api/payout/validate: sin base → 501; TODO en try/catch (nunca 500 crudo); cero PII (CD-5:
// el body del request no se ecoa en errores). Espejo del A2aQuoteGateway cliente.
import { NextResponse } from "next/server";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Shape mínimo esperado del result del agente (validación defensiva, sin any).
function isValidQuoteResult(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return (
    typeof v.quoteId === "string" &&
    typeof v.rate === "number" &&
    typeof v.feeUsd === "number" &&
    typeof v.netDeliveredLocal === "number" &&
    typeof v.etaMinutes === "number" &&
    typeof v.expiresAt === "string" &&
    typeof v.provenance === "string"
  );
}

export async function POST(req: Request): Promise<Response> {
  const BASE = process.env.REMIT_AGENTS_BASE_URL; // server-only (CD-9), leído en runtime
  if (!BASE) return NextResponse.json({ error: "a2a_not_configured" }, { status: 501 });
  const body = await req.json().catch(() => ({}));
  try {
    const res = await fetch(`${BASE}/api/agents/remit-corridor-fx/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return NextResponse.json({ error: "a2a_upstream_error" }, { status: 502 });
    const { result } = (await res.json()) as { result: unknown };
    if (!isValidQuoteResult(result)) {
      return NextResponse.json({ error: "a2a_bad_shape" }, { status: 502 });
    }
    return NextResponse.json({ result }, { status: 200 }); // sólo el result (nunca BASE ni PII)
  } catch {
    // timeout/DNS/parse → 502 opaco (nunca 500 crudo, nunca ecoa el body)
    return NextResponse.json({ error: "a2a_unavailable" }, { status: 502 });
  }
}
