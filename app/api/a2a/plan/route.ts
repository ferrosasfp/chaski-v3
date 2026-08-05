// Server-only: quién va a atender cada paso de la remesa, y cuánto cobra. Es el preview que la
// persona ve ANTES de aprobar.
//
// 🔴 USA `/discover`, NUNCA `/compose`. Descubrir es una lectura y es gratis; componer EJECUTA los
// pasos y los cobra. Un preview que compone no es un preview: es la operación, hecha dos veces.
//
// QUÉ SE PREGUNTA. No se pide un agente por nombre: se pide una CAPACIDAD y el catálogo contesta
// quién la cumple. Ese es el punto del preview y es lo que lo vuelve honesto mañana, cuando entre un
// agente mejor y esta pantalla lo muestre sola, sin que nadie toque este archivo.
//
// ⚠️ EL FILTRO ES `capabilities`, EN PLURAL. Medido contra el catálogo en vivo: `capabilities=X`
// devuelve 1 agente; `capability=X` (singular) NO filtra y devuelve los 23 del catálogo. Un typo acá
// no falla, muestra cualquier cosa, así que el nombre del parámetro no se toca sin volver a medirlo.
//
// 🔴 LO QUE ESTA RUTA NO HACE, y es la mitad del trabajo: no afirma que estos agentes vayan a correr.
// El carril del gateway está detrás de `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`, y con la bandera apagada
// la app llama a su agente punto a punto, que puede ser OTRO. Decir "el gateway elige X" mientras
// producción llama a Y sería exactamente la clase de pantalla que mide una cosa y afirma otra. Por eso
// cada paso viaja con su `transport` y la interfaz lo dice.
//
// La identidad NO figura como agente A PROPÓSITO: hoy Chaski habla con el proveedor de verificación
// directo, no a través de un agente del catálogo. Inventar una tercera fila sería fabricar la parte
// más vendible del preview.
import { NextResponse } from "next/server";
import {
  FX_DIRECT_AGENT_SLUG,
  FX_QUOTE_CAPABILITY,
  PAYOUT_CAPABILITY,
  PAYOUT_DIRECT_AGENT_SLUG,
} from "../../../../src/infrastructure/a2a/gateway-client";

/** Un paso del plan, tal como se le muestra a la persona. Sin URLs, sin claves, sin PII. */
interface PlanStep {
  capability: string;
  label: string;
  /** `null` = el catálogo no ofrece a nadie para esta capacidad. Se dice, no se esconde. */
  agent: { id: string; description: string; priceUsdc: number | null; verified: boolean; registry: string } | null;
  /** Por dónde corre HOY, no por dónde podría correr. */
  transport: "gateway" | "punto-a-punto";
  /**
   * QUIÉN corre hoy, cuando se sabe. Y se sabe en UN solo caso: el carril punto a punto, donde el
   * slug está cableado en la URL que la route invoca. Sale de la MISMA constante que ese fetch usa.
   *
   * `null` con `transport: "gateway"` NO es un dato faltante: es el hecho. Ahí no se llama a ningún
   * slug, se pide una capacidad y el gateway resuelve AL EJECUTAR, así que el agente que el catálogo
   * lista primero hoy puede no ser el que corra. Rellenarlo con el `agent.id` sería exactamente la
   * pantalla que mide una cosa y afirma otra.
   *
   * Por qué existe este campo: medido contra producción el 2026-08-05, `agent.id` daba
   * `remit-corridor-fx-solana` y `remit-cashout-payout-solana`, mientras las rutas llamaban a
   * `remit-corridor-fx` y `remit-cashout-payout`. La tarjeta nombraba a quien no corre.
   */
  runsTodayAgentId: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Lee del catálogo quién cumple una capacidad. Devuelve `null` ante cualquier duda: un preview que
 *  inventa un agente es peor que uno que dice que no pudo averiguarlo. */
async function discoverFor(base: string, capability: string): Promise<PlanStep["agent"]> {
  try {
    const res = await fetch(`${base}/discover?capabilities=${encodeURIComponent(capability)}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!isRecord(body)) return null;
    const list = body.agents;
    if (!Array.isArray(list) || list.length === 0) return null;
    const a: unknown = list[0]; // el catálogo ya devuelve ordenado por su propio ranking
    if (!isRecord(a) || typeof a.id !== "string") return null;
    return {
      id: a.id,
      description: typeof a.description === "string" ? a.description : "",
      // `null` ≠ 0. Un agente sin precio publicado NO se muestra como gratis.
      priceUsdc: typeof a.priceUsdc === "number" ? a.priceUsdc : null,
      // Se muestra tal cual viene. Hoy los tres dicen `false`, y esa es la verdad del catálogo:
      // nadie los verificó todavía. Pintarlos de verificados sería la mentira más fácil de esta pantalla.
      verified: a.verified === true,
      registry: typeof a.registry === "string" ? a.registry : "desconocido",
    };
  } catch {
    return null;
  }
}

export async function GET(): Promise<Response> {
  const base = process.env.WASIAI_A2A_GATEWAY_URL;
  if (!base) {
    // Sin gateway configurado no hay catálogo que consultar. 501 y no un plan vacío: "no pudimos
    // averiguarlo" y "no interviene nadie" son cosas distintas y no se dicen igual.
    return NextResponse.json({ error: "gateway_not_configured" }, { status: 501 });
  }
  const viaGateway = process.env.NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER === "a2a-gateway";
  const transport: PlanStep["transport"] = viaGateway ? "gateway" : "punto-a-punto";

  const fxCapability = process.env.WASIAI_A2A_FX_CAPABILITY ?? FX_QUOTE_CAPABILITY;
  const payoutCapability = process.env.WASIAI_A2A_PAYOUT_CAPABILITY ?? PAYOUT_CAPABILITY;

  const [fx, payout] = await Promise.all([
    discoverFor(base, fxCapability),
    discoverFor(base, payoutCapability),
  ]);

  const steps: PlanStep[] = [
    {
      capability: fxCapability,
      label: "Cotizar el cambio",
      agent: fx,
      transport,
      runsTodayAgentId: viaGateway ? null : FX_DIRECT_AGENT_SLUG,
    },
    {
      capability: payoutCapability,
      label: "Entregar el dinero",
      agent: payout,
      transport,
      runsTodayAgentId: viaGateway ? null : PAYOUT_DIRECT_AGENT_SLUG,
    },
  ];

  // El total suma SÓLO lo que tiene precio conocido, y se dice cuántos quedaron afuera. Un total que
  // trata un precio ausente como cero se lee como más barato de lo que es.
  const withPrice = steps.filter((s) => typeof s.agent?.priceUsdc === "number");
  const totalUsdc = withPrice.reduce((acc, s) => acc + (s.agent?.priceUsdc ?? 0), 0);

  return NextResponse.json({
    steps,
    totalUsdc,
    stepsWithoutPrice: steps.length - withPrice.length,
  });
}
