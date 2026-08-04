// Server-side: proxy al agente remit-corridor-fx (WKH-186). REMIT_AGENTS_BASE_URL vive SOLO acá
// (CD-9, SIN NEXT_PUBLIC_): nunca llega al cliente; la ruta sólo devuelve { result }. Patrón de
// app/api/payout/validate: sin base → 501; TODO en try/catch (nunca 500 crudo); cero PII (CD-5:
// el body del request no se ecoa en errores). Espejo del A2aQuoteGateway cliente.
import { NextResponse } from "next/server";
import {
  QUOTE_REJECTED,
  RELAYABLE_QUOTE_REJECTIONS,
  relayableRejection,
} from "../../../../src/application/agent-rejections";
import { isParseableIso } from "../../../../src/domain/remittance";
import {
  FX_MIN_REPUTATION,
  FX_QUOTE_CAPABILITY,
  logGatewayFailure,
  runViaGateway,
} from "../../../../src/infrastructure/a2a/gateway-client";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * ¿Este status del agente es un RECHAZO del pedido, o el agente que no pudo atenderlo?
 *
 * 400 y 422 son los dos únicos que prueban que el agente leyó el body y lo negó. Todo lo demás
 * (401/403 = nuestra credencial, 404 = la ruta, 429 = su rate-limit, 5xx = él caído) es un problema
 * de infraestructura NUESTRO o SUYO, no del monto que escribió la persona, y sigue saliendo por el
 * 502 de siempre. Meter un 403 acá diría "revisá tu pedido" cuando lo que hay que revisar es la
 * credencial del server.
 */
function isAgentRejectionStatus(status: number): boolean {
  return status === 400 || status === 422;
}

/**
 * Lee el enum del rechazo del body de error del agente, con la lista de relayables como filtro.
 *
 * Escanea tres claves porque el contrato de error del agente NO está vendoreado (ver
 * `contracts/CONTRACT-VERSIONS.md`: el fixture pinneado es el del OUTPUT feliz) y adivinar una sola
 * sería apostar. Escanear de más es inofensivo: lo que decide qué sale es la allow-list, no la
 * clave. Un body ilegible o un enum desconocido ⇒ el enum de familia, nunca el string crudo.
 */
async function readQuoteRejection(res: Response): Promise<string> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return QUOTE_REJECTED; // el agente rechazó y no dijo por qué de forma legible
  }
  if (!isRecord(body)) return QUOTE_REJECTED;
  for (const raw of [body.error, body.code, body.reason]) {
    const mapped = relayableRejection(QUOTE_REJECTED, raw, RELAYABLE_QUOTE_REJECTIONS);
    if (mapped !== QUOTE_REJECTED) return mapped;
  }
  return QUOTE_REJECTED;
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
  //
  // WKH-313: el leg de FX (y SÓLO el de FX) pide el CARRIL DE ESTRENO: admite agentes sin
  // historial liquidado, que ordenan ÚLTIMOS y sólo ganan si ninguno pasa por mérito.
  //
  // Va acá y no en el payout por una razón de MAGNITUD, no de gusto: un agente nuevo que cotiza mal
  // produce una cotización mala, y eso se ve ANTES de que la persona firme nada (el shape lo valida
  // isValidQuoteResult, el monto lo mira la persona). Un agente nuevo en el payout decide A DÓNDE VA
  // LA PLATA. No es el mismo riesgo y no se trata igual.
  //
  // El piso viaja JUNTO con el carril y no es opcional: `allow_trial` sin `min_reputation` es letra
  // muerta del lado del gateway, y sin piso los campos `verified`/`reputation` que el agente
  // AUTO-REPORTA deciden el ranking. El detalle medido está en FX_MIN_REPUTATION.
  //
  // Lo que este pedido NO reemplaza: isValidQuoteResult, que corta con 502 si el agente que gana el
  // ranking devuelve otro shape. El piso sube el piso, no valida la respuesta.
  // Fail-closed SIN fallback punto-a-punto (CD-1/AC-4): cualquier error del gateway corta con 502/501
  // opaco; NUNCA cae al fetch({BASE}/...) de abajo. El detalle granular del fallo va al log
  // (logGatewayFailure, sólo enums — CD-9), NUNCA al body de la respuesta (CD-8). Con el flag ≠
  // "a2a-gateway" (default) esta rama no se entra ⇒ la rama punto-a-punto queda byte-idéntica (CD-15).
  if (adapter === "a2a-gateway") {
    const r = await runViaGateway({
      steps: [
        {
          capability: process.env.WASIAI_A2A_FX_CAPABILITY ?? FX_QUOTE_CAPABILITY,
          // Las dos claves juntas o ninguna: ver FX_MIN_REPUTATION.
          constraints: { min_reputation: FX_MIN_REPUTATION, allow_trial: true },
          input: body as Record<string, unknown>, // el body TAL CUAL (CD-8)
        },
      ],
    });
    // ⚠️ ESTA RAMA SIGUE COLAPSADA, Y ES DELIBERADO. La separación rechazo/caída que sí se hizo en
    // la rama punto-a-punto de abajo NO se replicó acá: `payment_required` (402, la Agent Key sin
    // saldo), `no_agent_match` (422) y `unavailable` siguen saliendo por el mismo
    // `a2a_unavailable`. Lo que lo impide es CD-8, que es una directiva, no una omisión: el detalle
    // granular del gateway va al log y nunca al body. Y no es sólo texto — hay un test que lo
    // clava (`route.test.ts`, "el detalle SÓLO al log": `Object.keys(json)` debe ser `["error"]`).
    // Además, lo que un 402 filtraría no es un dato del pedido de quien llama sino del estado
    // operativo nuestro. Abrir esto necesita su propio SDD que revise CD-8, no un parche acá.
    if (!r.ok) {
      logGatewayFailure("quote", r);
      if (r.code === "not_configured")
        return NextResponse.json({ error: "a2a_not_configured" }, { status: 501 });
      return NextResponse.json({ error: "a2a_unavailable" }, { status: 502 });
    }
    if (!isValidQuoteResult(r.outputs[0]))
      return NextResponse.json({ error: "a2a_bad_shape" }, { status: 502 });
    // QUIÉN cotizó. El gateway lo dice en `steps[0].agent` y hasta acá se tiraba. Sigue sin
    // viajar ni la URL ni PII: sólo el slug/registry/capability del agente elegido, que es
    // exactamente lo que hace auditable una elección hecha server-side. Ausente ⇒ no se manda la
    // clave, y la remesa queda diciendo "no sé quién", que es la verdad.
    const chosen = r.agents[0];
    return NextResponse.json(
      { result: r.outputs[0], ...(chosen ? { agent: chosen } : {}) },
      { status: 200 },
    );
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
    // Un rechazo del agente NO es el agente caído. Acá salían los dos por el mismo 502
    // `a2a_upstream_error`, y por eso un envío de 2 dólares se leía en pantalla como una caída (ver
    // la medición en `src/application/agent-rejections.ts`). El 400 dice lo que es: el pedido llegó,
    // se entendió y se negó, así que reintentar igual no lo va a arreglar — hay que cambiar el monto.
    // El `reason` viaja SÓLO si está en la allow-list; lo demás sale colapsado (CD-5: nunca se ecoa
    // el body del request ni texto libre del agente).
    if (!res.ok) {
      if (isAgentRejectionStatus(res.status)) {
        const reason = await readQuoteRejection(res);
        return NextResponse.json(
          reason === QUOTE_REJECTED ? { error: QUOTE_REJECTED } : { error: QUOTE_REJECTED, reason },
          { status: 400 },
        );
      }
      return NextResponse.json({ error: "a2a_upstream_error" }, { status: 502 });
    }
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
