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
// El catálogo lista a quien mejor rankea AHORA; el gateway resuelve AL EJECUTAR, y puede tocarle otro.
// Y con `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` en `"fallback"` no corre ningún agente: corren los
// simuladores del container. Decir "el gateway elige X" en ese modo sería la clase de pantalla que
// mide una cosa y afirma otra. Por eso cada paso viaja con su `transport` y la interfaz lo dice.
//
// La identidad NO figura como agente A PROPÓSITO: hoy Chaski habla con el proveedor de verificación
// directo, no a través de un agente del catálogo. Inventar una tercera fila sería fabricar la parte
// más vendible del preview.
import { NextResponse } from "next/server";
import {
  FX_MIN_REPUTATION,
  FX_QUOTE_CAPABILITY,
  PAYOUT_CAPABILITY,
  PAYOUT_MIN_REPUTATION,
} from "../../../../src/infrastructure/a2a/gateway-client";

/** Lo que el catálogo dice de quien atendería este paso. Sin URLs, sin claves, sin PII. */
type PlanAgent = {
  id: string;
  description: string;
  priceUsdc: number | null;
  verified: boolean;
  registry: string;
};

/**
 * Las constraints con las que se PREGUNTÓ, tal cual, para que la tarjeta pueda afirmar "bajo el piso
 * de este paso" y esa frase sea falsable mirando la respuesta y no leyendo el código.
 *
 * Los nombres van en camelCase porque son NUESTRO contrato con NUESTRA UI. En el cable a `/discover`
 * son otros y no coinciden entre sí: el piso viaja como `min_reputation` (snake, alias explícito de
 * esa API) y el carril de estreno como `allowTrial` (camel, y SÓLO camel — `allow_trial` no está
 * entre los parámetros aceptados y produce 400). Ver `buildDiscoverUrl`.
 */
type LegConstraints = { minReputation: number; allowTrial?: true };

/** Un paso del plan, tal como se le muestra a la persona. Sin URLs, sin claves, sin PII. */
interface PlanStep {
  capability: string;
  label: string;
  /** `null` = no hay agente que mostrar. `availability` dice POR QUÉ, que no es lo mismo. */
  agent: PlanAgent | null;
  /**
   * 🔴 POR QUÉ ESTE CAMPO EXISTE (WKH-332/AC-14, CD-18). `agent: null` colapsaba cuatro desenlaces
   * distintos en uno, y la pantalla afirmaba UNO solo de los cuatro: *"El catálogo no ofrece a nadie
   * para esta capacidad ahora mismo"*. O sea que un 500 del gateway, un body ilegible o un timeout de
   * red NUESTRO se leían como una afirmación de hecho SOBRE EL CATÁLOGO.
   *
   * · `ofrecido`        — 200, lista con al menos un card legible. Es el único caso con `agent`.
   * · `sin-candidatos`  — 200 y el catálogo contestó que NO hay nadie que cumpla el piso de este paso.
   *                       Es una respuesta, y por eso se puede afirmar.
   * · `no-consultado`   — no pudimos preguntar, o no entendimos la respuesta. NO se puede afirmar NADA
   *                       sobre el catálogo desde acá.
   *
   * "No pude preguntar" no es "no pasó". Con las constraints puestas (AC-14) `no-consultado` se vuelve
   * MÁS alcanzable, no menos: un nombre de parámetro equivocado en la query da 400, y un 400 cae en
   * `!res.ok`. Colapsarlo en `sin-candidatos` sería agrandar una mentira mientras se dice que se la
   * está arreglando.
   */
  availability: "ofrecido" | "sin-candidatos" | "no-consultado";
  /** Con qué se preguntó. Las MISMAS constraints que la ejecución manda a `/compose` (AC-14). */
  constraints: LegConstraints;
  /**
   * Por dónde corre HOY, no por dónde podría correr.
   *
   * 🔴 EL DOMINIO CAMBIÓ EN WKH-332/W3, Y SOBREVIVIR ES LA DECISIÓN. El work-item mandaba borrar este
   * campo junto con `runsTodayAgentId`; se cumplió la primera mitad y no la segunda, y el motivo es
   * falsable: `"fallback"` sigue siendo un valor legal de `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`, y con
   * él NO corre ningún agente — el container cablea `FallbackQuoteGateway`/`FallbackPayoutGateway`,
   * que son simuladores locales. Sin este campo, en ese modo la tarjeta afirmaría *"Hoy este paso
   * corre por el gateway, que elige al ejecutar"* mientras corre un mock. Esa es, exactamente, la
   * pantalla que mide una cosa y afirma otra: el bug que la tarjeta existe para cerrar.
   *
   * `"punto-a-punto"` desapareció con el carril que nombraba. Se deriva del VALOR DE LA BANDERA, y
   * nunca de un nombre de agente: no queda ninguno del que derivarlo.
   */
  transport: "gateway" | "demo";
}

// 🔴 ACÁ ESTABA `runsTodayAgentId`, Y MURIÓ EN W3 POR FALTA DE FUENTE, no por gusto. Su único valor
// posible eran las dos constantes de slug del carril punto a punto, y ese carril ya no existe. En el
// carril del gateway el campo siempre valió `null` —ahí no se llama a ningún slug, se pide una
// capacidad y el gateway resuelve AL EJECUTAR—, así que lo único que se pierde es el `null`.
// ⛔ Rellenarlo con el `agent.id` del catálogo sería reintroducir el bug al revés: el catálogo lista
// a quien mejor rankea HOY, no a quien va a correr.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** El resultado de preguntarle al catálogo. Unión discriminada porque las tres ramas se dicen
 *  distinto en pantalla, y hasta WKH-332 las cuatro salidas colapsaban en un `null`. */
type Discovery =
  | { availability: "ofrecido"; agent: PlanAgent }
  | { availability: "sin-candidatos"; agent: null }
  | { availability: "no-consultado"; agent: null };

const SIN_CANDIDATOS = { availability: "sin-candidatos", agent: null } as const;
const NO_CONSULTADO = { availability: "no-consultado", agent: null } as const;

/**
 * Arma la URL de `/discover` con las MISMAS constraints que la ejecución manda a `/compose` (AC-14).
 *
 * 🔴 LOS NOMBRES DE LOS PARÁMETROS NO SON LOS DE `/compose`, Y UN TYPO ACÁ NO FALLA: MIENTE.
 * `/discover` valida los nombres contra un conjunto cerrado y responde 400 `UNKNOWN_DISCOVER_PARAM`
 * ante cualquiera que no esté. Un 400 cae en `!res.ok`, o sea en `no-consultado`, así que un typo se
 * lee en pantalla como "no pudimos consultar el catálogo" sobre una capacidad que sí tiene agente.
 *
 * · el piso va como `min_reputation` (snake). Es un ALIAS explícito de esa API, no una casualidad.
 * · el carril de estreno va como `allowTrial` (CAMEL, y sólo camel). `allow_trial` —el nombre que SÍ
 *   usa `/compose`— NO está en el conjunto aceptado por `/discover`. Verificado leyendo
 *   `ALLOWED_DISCOVER_PARAMS` en el gateway: contiene `allowTrial`, `min_reputation` y `minReputation`,
 *   y no contiene `allow_trial`. CD-21 lo prohíbe y T-14.2 lo custodia.
 *
 * `URLSearchParams` se encarga del encoding: el `encodeURIComponent` a mano de antes cubría un solo
 * parámetro y ahora son tres.
 */
function buildDiscoverUrl(base: string, capability: string, c: LegConstraints): string {
  const qs = new URLSearchParams({
    capabilities: capability, // 🔴 PLURAL. El singular no filtra y devuelve el catálogo entero.
    min_reputation: String(c.minReputation),
  });
  if (c.allowTrial) qs.set("allowTrial", "true");
  return `${base}/discover?${qs.toString()}`;
}

/** Le pregunta al catálogo quién cumple una capacidad BAJO LAS CONSTRAINTS DE ESE LEG, y distingue
 *  "el catálogo dijo que no hay nadie" de "no pudimos preguntar". Un preview que inventa un agente es
 *  peor que uno que dice que no pudo averiguarlo, y uno que confunde las dos cosas es peor que los dos. */
async function discoverFor(
  base: string,
  capability: string,
  constraints: LegConstraints,
): Promise<Discovery> {
  try {
    const res = await fetch(buildDiscoverUrl(base, capability, constraints), {
      signal: AbortSignal.timeout(8_000),
    });
    // El catálogo contestó mal (incluido el 400 de un nombre de parámetro equivocado). No sabemos.
    if (!res.ok) return NO_CONSULTADO;
    const body: unknown = await res.json();
    if (!isRecord(body)) return NO_CONSULTADO; // body ilegible: tampoco sabemos
    const list = body.agents;
    // Un `agents` que no es lista es un body que no entendimos, y eso NO es "no hay nadie".
    if (!Array.isArray(list)) return NO_CONSULTADO;
    // 🔴 LA ÚNICA RAMA QUE PUEDE AFIRMAR ALGO SOBRE EL CATÁLOGO: contestó 200 y la lista vino vacía.
    if (list.length === 0) return SIN_CANDIDATOS;
    const a: unknown = list[0]; // el catálogo ya devuelve ordenado por su propio ranking
    if (!isRecord(a) || typeof a.id !== "string") return NO_CONSULTADO; // card ilegible
    return {
      availability: "ofrecido",
      agent: {
        id: a.id,
        description: typeof a.description === "string" ? a.description : "",
        // `null` ≠ 0. Un agente sin precio publicado NO se muestra como gratis.
        priceUsdc: typeof a.priceUsdc === "number" ? a.priceUsdc : null,
        // Se muestra tal cual viene. Hoy los tres dicen `false`, y esa es la verdad del catálogo:
        // nadie los verificó todavía. Pintarlos de verificados sería la mentira más fácil de esta pantalla.
        verified: a.verified === true,
        registry: typeof a.registry === "string" ? a.registry : "desconocido",
      },
    };
  } catch {
    return NO_CONSULTADO; // timeout, DNS, red nuestra. Nada de esto habla del catálogo.
  }
}

export async function GET(): Promise<Response> {
  const base = process.env.WASIAI_A2A_GATEWAY_URL;
  if (!base) {
    // Sin gateway configurado no hay catálogo que consultar. 501 y no un plan vacío: "no pudimos
    // averiguarlo" y "no interviene nadie" son cosas distintas y no se dicen igual.
    return NextResponse.json({ error: "gateway_not_configured" }, { status: 501 });
  }
  // El único valor de la bandera que cablea agentes reales es `"a2a-gateway"`; el otro legal es
  // `"fallback"` (y su ausencia, que cae en él), que cablea simuladores.
  //
  // ⚠️ ACÁ DECÍA *"un valor no reconocido no llega hasta acá: `resolveValueDeliveryAdapter` tira en el
  // arranque del container"*, Y ERA FALSO PARA TODA INVOCACIÓN DE ESTA RUTA (AR/BLQ-MED-1). Este
  // handler NO valida la bandera: la lee cruda y **cualquier** string que no sea `"a2a-gateway"` cae
  // en `"demo"` y devuelve 200. MEDIDO con una sonda sobre este mismo `GET` (2026-08-07, descartada
  // después): `"a2a-gateway"` ⇒ 200 `["gateway","gateway"]`; `"fallback"`, `"a2a"`, `"a2a-gatewayy"` y
  // `"A2A-GATEWAY"` ⇒ 200 `["demo","demo"]` los cuatro. Cinco valores, cero throws.
  // Quien tira con un valor ilegal es `createContainer()`, en el composition root del CLIENTE. Este
  // GET no pasa por ahí —no lo importa, y el repo no tiene `middleware.ts`—, así que un `curl` llega
  // igual. Lo que el `transport` describe es qué va a cablear LA APP PROPIA, no una garantía sobre
  // quién llamó. Input que lo pone en rojo si alguien invierte el mapeo: (`transport`,
  // `route.test.ts:117`) y (`transport`, `route.test.ts:135`).
  const transport: PlanStep["transport"] =
    process.env.NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER === "a2a-gateway" ? "gateway" : "demo";

  const fxCapability = process.env.WASIAI_A2A_FX_CAPABILITY ?? FX_QUOTE_CAPABILITY;
  const payoutCapability = process.env.WASIAI_A2A_PAYOUT_CAPABILITY ?? PAYOUT_CAPABILITY;

  // 🔴 LAS CONSTRAINTS SALEN DE LAS MISMAS CONSTANTES QUE LA EJECUCIÓN (AC-14 / CD-21). Escribir el
  // número a mano acá haría que el día que alguien mueva un piso, el preview siga preguntando por el
  // viejo y muestre un agente que la ejecución va a rechazar. Con el import, el preview se mueve solo.
  // Los pisos NO son env y no pueden serlo: ver PAYOUT_MIN_REPUTATION en gateway-client.ts.
  const fxConstraints: LegConstraints = { minReputation: FX_MIN_REPUTATION, allowTrial: true };
  // El leg del PRINCIPAL no pide el carril de estreno, y esa asimetría es deliberada: admitir a un
  // agente sin historial liquidado para cotizar cuesta una cotización mala; para entregar el dinero
  // cuesta el dinero. La ejecución tampoco lo pide.
  const payoutConstraints: LegConstraints = { minReputation: PAYOUT_MIN_REPUTATION };

  const [fx, payout] = await Promise.all([
    discoverFor(base, fxCapability, fxConstraints),
    discoverFor(base, payoutCapability, payoutConstraints),
  ]);

  const steps: PlanStep[] = [
    {
      capability: fxCapability,
      label: "Cotizar el cambio",
      agent: fx.agent,
      availability: fx.availability,
      constraints: fxConstraints,
      transport,
    },
    {
      capability: payoutCapability,
      label: "Entregar el dinero",
      agent: payout.agent,
      availability: payout.availability,
      constraints: payoutConstraints,
      transport,
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
