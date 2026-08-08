// Server-side: el leg de FX de la remesa, pedido POR CAPACIDAD (WKH-186, reescrito en WKH-332/W3).
// Esta ruta NO nombra ningún agente y no tiene forma de hacerlo: manda `remittance-fx-quote` al
// gateway y el gateway resuelve quién la cumple. El `fetch({BASE}/api/agents/<slug>/invoke)` y la env
// `REMIT_AGENTS_BASE_URL` que lo alimentaba se BORRARON — un camino apagado por una bandera sigue
// siendo un camino, y era el que llamaba a un agente por su nombre (AC-1/CD-1).
// Sin gateway configurado → 501; cero 500 crudo; cero PII (CD-5: el body del request no se ecoa en
// errores). Espejo del A2aQuoteGateway cliente.
import { NextResponse } from "next/server";
import {
  QUOTE_NO_AGENT_FOR_CAPABILITY,
  noAgentMeansNobodyFits,
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

// 🔴 ACÁ VIVÍAN `isAgentRejectionStatus` Y `readQuoteRejection`, Y SE FUERON CON SU ÚNICO LLAMADOR
// (WKH-332/W3). Los dos leían la respuesta HTTP del agente invocado por su slug: el primero decidía
// si un 400/422 suyo era un rechazo del pedido, el segundo sacaba el `reason` de su body con
// `RELAYABLE_QUOTE_REJECTIONS` como filtro. Por el gateway no hay respuesta del agente que leer —
// `/compose` devuelve el step fallado sin `code` ni `reason` (es lo que WKH-335 abre en el otro
// repo), así que no hay nada que filtrar. El borrado NO es cosmético: dejarlos sin llamador daba 3
// errores de `noUnusedVariables` en biome, medido.

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
  const body = await req.json().catch(() => ({}));

  // WKH-218 + WKH-304: el ÚNICO transporte. Pide la CAPACIDAD al gateway wasiai-a2a vía POST
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
  // Fail-closed SIN fallback punto-a-punto (CD-1/AC-1): cualquier error del gateway corta con 502/501
  // opaco. Ya no hay un "abajo" al que caer: el `else` con el `fetch({BASE}/api/agents/<slug>/invoke)`
  // se BORRÓ en WKH-332/W3, y con él la última forma que tenía esta ruta de llamar a un agente por su
  // nombre. El detalle granular del fallo va al log (logGatewayFailure, sólo enums — CD-9), NUNCA al
  // body de la respuesta (CD-8).
  //
  // 🔴 ESTA RUTA YA NO LEE `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`, y no es una omisión. Había un solo
  // motivo para leerla —elegir entre dos transportes— y ahora hay uno.
  //
  // ⚠️ Y NO LEERLA SIGNIFICA QUE LA BANDERA NO PUEDE DETENER A ESTA RUTA (AR/BLQ-MED-1). Acá decía que
  // con `"fallback"` *"nadie llega hasta acá"* y que *"un valor no reconocido tampoco llega"*. Las dos
  // eran falsas para cualquier invocación server-side, y la segunda se BORRA: no tiene versión cierta.
  // Lo cierto es más chico y es esto: con `"fallback"` el container del CLIENTE cablea
  // `FallbackQuoteGateway` (`usesRealGateways`, `../../../../src/composition/value-delivery-adapter.ts:74`)
  // y la UI propia no llama a este endpoint; el endpoint NO lee la bandera y le contesta igual a quien
  // sea. Input que lo demuestra, en este repo: (`it.each`, `route.test.ts:386`) corre con la bandera en
  // `"fallback"` y en `undefined`, y en los dos casos exige 200 y un único fetch a `${GW}/compose`.
  //
  // 🔴 POR QUÉ NO ES UN DETALLE: §9 del Story File nombra el flip de esa bandera como la palanca de
  // rollback. Poner `"fallback"` NO corta esta ruta —sigue componiendo y gastando la Agent Key—. Lo
  // que sí la corta sin re-desplegar es sacarle la config del gateway: con la URL o la key ausentes la
  // config resuelve a `null` (`not_configured`, `gateway-client.ts:225`) ⇒ el 501 de abajo, sin fetch.
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
  // ⚠️ ESTA RAMA SIGUE MAYORMENTE COLAPSADA, Y ES DELIBERADO. `payment_required` (402, la Agent
  // Key sin saldo) y `unavailable` siguen saliendo los dos por `a2a_unavailable`. Lo que lo impide
  // es CD-8, que es una directiva y no una omisión: el detalle granular del gateway va al log y
  // nunca al body. Y no es sólo texto — hay un test que lo clava (`route.test.ts`, "el detalle
  // SÓLO al log": `Object.keys(json)` debe ser `["error"]`). Además, lo que un 402 filtraría no es
  // un dato del pedido de quien llama sino del estado operativo nuestro.
  //
  // 🔴 SE ABRE UNO SOLO: `no_agent_match` (WKH-332/AC-13). No es un eco del gateway (CD-5) —no
  // viaja su `message`, ni su `reason`, ni la URL—: es UNA palabra nuestra para un desenlace
  // nuestro, y el body sigue teniendo exactamente una clave. Se abre porque "ninguna capacidad
  // resolvió" no se arregla reintentando, y el 502 invitaba justamente a eso: la misma llamada, un
  // segundo después, vuelve a no encontrar a nadie. Abrir el 402 sigue necesitando su propio SDD.
  if (!r.ok) {
    logGatewayFailure("quote", r);
    if (r.code === "not_configured")
      return NextResponse.json({ error: "a2a_not_configured" }, { status: 501 });
    // 🔴 El `code` NO alcanza (AR/BLQ-MED-1): el 422 colapsa cuatro motivos y uno es
    // `reputation_unavailable`, o sea "el gateway no pudo leer el historial". Para ése, "no hay
    // ningún proveedor que pueda cotizar" es una afirmación que no podemos hacer, y "reintentar no
    // cambia el resultado" desaconseja lo único que puede funcionar. Ese cae al 502 de abajo, que
    // dice "algo salió mal, probá de nuevo" — vago y CIERTO. El `reason` se usa para ramificar,
    // nunca se ecoa: el body sigue teniendo exactamente una clave.
    if (r.code === "no_agent_match" && noAgentMeansNobodyFits(r.reason))
      return NextResponse.json({ error: QUOTE_NO_AGENT_FOR_CAPABILITY }, { status: 422 });
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
