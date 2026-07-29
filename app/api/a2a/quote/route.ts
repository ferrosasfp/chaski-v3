// Server-side: proxy al agente remit-corridor-fx (WKH-186). REMIT_AGENTS_BASE_URL vive SOLO acá
// (CD-9, SIN NEXT_PUBLIC_): nunca llega al cliente; la ruta sólo devuelve { result }. Patrón de
// app/api/payout/validate: sin base → 501; TODO en try/catch (nunca 500 crudo); cero PII (CD-5:
// el body del request no se ecoa en errores). Espejo del A2aQuoteGateway cliente.
import { NextResponse } from "next/server";
import { isParseableIso } from "../../../../src/domain/remittance";
import {
  FX_QUOTE_CAPABILITY,
  logGatewayFailure,
  runViaGateway,
} from "../../../../src/infrastructure/a2a/gateway-client";

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
    isParseableIso(v.expiresAt) && // WKH-198 AC-4: rechaza fecha no-parseable
    typeof v.provenance === "string"
  );
}

export async function POST(req: Request): Promise<Response> {
  const adapter = process.env.NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER; // "fallback"(default) | "a2a" | "a2a-gateway"
  const body = await req.json().catch(() => ({}));

  // WKH-218 + WKH-304: 3er modo de transporte. Pide la CAPACIDAD al gateway wasiai-a2a vía POST
  // /compose (CD-7: /compose, NO /orchestrate) y es el GATEWAY el que resuelve qué agente la cumple:
  // acá ya no se descubre ni se elige agente por nombre, ni se cae al primero de la lista (CD-1).
  // El leg de FX NO lleva constraints a propósito: un piso de reputación no selecciona por
  // compatibilidad de contrato y sólo agrega superficie de fallo — lo que protege es
  // isValidQuoteResult, que corta con 502 si el agente que gana el ranking devuelve otro shape.
  // Fail-closed SIN fallback punto-a-punto (CD-1/AC-4): cualquier error del gateway corta con 502/501
  // opaco; NUNCA cae al fetch({BASE}/...) de abajo. El detalle granular del fallo va al log
  // (logGatewayFailure, sólo enums — CD-9), NUNCA al body de la respuesta (CD-8). Con el flag ≠
  // "a2a-gateway" (default) esta rama no se entra ⇒ la rama punto-a-punto queda byte-idéntica (CD-15).
  if (adapter === "a2a-gateway") {
    const r = await runViaGateway({
      steps: [
        {
          capability: process.env.WASIAI_A2A_FX_CAPABILITY ?? FX_QUOTE_CAPABILITY,
          input: body as Record<string, unknown>, // el body TAL CUAL (CD-8)
        },
      ],
    });
    if (!r.ok) {
      logGatewayFailure("quote", r);
      if (r.code === "not_configured")
        return NextResponse.json({ error: "a2a_not_configured" }, { status: 501 });
      return NextResponse.json({ error: "a2a_unavailable" }, { status: 502 });
    }
    if (!isValidQuoteResult(r.outputs[0]))
      return NextResponse.json({ error: "a2a_bad_shape" }, { status: 502 });
    return NextResponse.json({ result: r.outputs[0] }, { status: 200 }); // sólo el result (nunca URL ni PII)
  }

  // --- rama punto-a-punto / mock: BYTE-IDÉNTICA al actual (BASE, fetch, isValidQuoteResult) ---
  const BASE = process.env.REMIT_AGENTS_BASE_URL; // server-only (CD-9), leído en runtime
  if (!BASE) return NextResponse.json({ error: "a2a_not_configured" }, { status: 501 });
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
