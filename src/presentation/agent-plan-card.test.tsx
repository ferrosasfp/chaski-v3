// @vitest-environment jsdom
//
// LA TARJETA QUE NOMBRABA A QUIEN NO CORRE — y que en WKH-332 dejó de poder nombrar a nadie.
//
// 🔴 ACÁ HABÍA TRES CITAS AL CARRIL PUNTO A PUNTO Y SE BORRARON, NO SE RENUMERARON (AC-10). Una de
// ellas decía que `payout/prepare` llama a un agente por su slug, con el número de línea del `fetch`.
// Ese `fetch` no existe: renumerarla habría dejado una cita perfecta a la nada, que es peor que
// ninguna porque entrena a no seguirlas.
//
// LO QUE ESTE ARCHIVO MIDE HOY. La tarjeta llegó a mostrar el agente del catálogo con la coletilla
// "hoy se llama directo", mientras la ejecución llamaba a un slug DISTINTO cableado en una URL. La
// reparación de WKH-330 fue decir los dos; la de esta HU es que la afirmación ya no se pueda hacer,
// porque no queda ninguna URL con un nombre adentro. Lo que la tarjeta dice ahora es POR DÓNDE corre
// el paso —gateway o demo—, y estos tests clavan que las dos frases viejas NO están en el DOM en
// ningún estado (T-7.1).
//
// El otro hallazgo de la misma tarjeta: "Lo que cobran los agentes: 0.06 USDC".
//
// ⚠️ ESE NÚMERO SUMA LOS STEPS CON PRECIO PUBLICADO, y por eso ninguna frase sobre él puede hablar de un
// solo leg (WKH-336/AR/BLQ-MED-1). Acá decía *"ese precio no lo cobra nadie"* apoyándose SÓLO en el
// adapter en `"fallback"`, y es falso para parte del número: es `withPrice` el que filtra y suma
// (`route.ts:294-295`) y cada leg deriva su transporte de SU bandera. Con `adapter="fallback"` +
// `settle="true"` el leg de ENTREGA viaja en `"gateway"` y ahí el fee del payout SÍ se paga, contra la
// Agent Key de Chaski. Lo que sí es cierto en los cuatro cuadrantes: **no se le cobra a la persona, no
// se suma a lo que envía**. Por leg:
//   · COTIZACIÓN: con el adapter en `"fallback"` la arma un simulador del container
//     (`FallbackQuoteGateway`, `container.ts:123`) y ese fee no lo cobra nadie; con el adapter en
//     `"a2a-gateway"` lo paga Chaski con su Agent Key.
//   · ENTREGA: lo decide el settle, no el adapter (`solanaSettleOn`, `container.ts:141`). Con el settle
//     en `"true"` se paga contra la Agent Key aunque el adapter esté en `"fallback"`; con el settle
//     apagado no lo paga nadie, porque el envío no corre: falla cerrado (`this.solana`,
//     `../application/use-cases/confirm-and-send.ts:336`).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { TEST_CCI } from "../test-support/fakes";

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  // Lista CERRADA: lo que no esté acá no existe para este archivo, y el faltante tira TODA la
  // suite del archivo, no un test. Ver el docblock del mismo doble en `flow.test.tsx`.
  MotionConfig: ({ children }: { children: React.ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
          React.createElement(tag, props, children),
    },
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type PlanStep = {
  capability: string;
  label: string;
  agent: {
    id: string;
    description: string;
    priceUsdc: number | null;
    verified: boolean;
    registry: string;
  } | null;
  availability?: "ofrecido" | "sin-candidatos" | "no-consultado";
  constraints?: { minReputation: number; allowTrial?: true };
  /** W3: `"punto-a-punto"` salió del dominio con el carril. Y `"demo"` NO significa lo mismo en los
   *  dos pasos (WKH-336): en la COTIZACIÓN es el adapter en `"fallback"`
   *  (`resolveValueDeliveryAdapter`, `../composition/container.ts:114`), y en la ENTREGA es el settle
   *  Solana apagado (`solanaSettleOn`, `../composition/container.ts:141`), donde el envío no se simula
   *  sino que falla cerrado. Por eso un plan de test puede traer los dos valores a la vez.
   *  `runsTodayAgentId` se fue del tipo porque se fue del contrato: no hay fuente que lo llene. */
  transport: "gateway" | "demo";
};

/** Monta el flujo hasta `review`, que es donde vive la tarjeta, con el plan que se le indique. */
async function verLaTarjeta(steps: PlanStep[], totalUsdc: number): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ steps, totalUsdc }) })),
  );
  render(<RemittanceFlow container={buildTestContainer()} />);
  fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), {
    target: { value: "Mamá" },
  });
  fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), { target: { value: TEST_CCI } });
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));
  await screen.findByText(/Revisá el envío/);
  await screen.findByText(/Quién va a atender tu envío/);
}

const paso = (over: Partial<PlanStep> = {}): PlanStep => ({
  capability: "remittance-fx-quote",
  label: "Cotizar el cambio",
  agent: {
    id: "remit-corridor-fx-solana",
    description: "",
    priceUsdc: 0.03,
    verified: false,
    registry: "self-published",
  },
  availability: "ofrecido",
  constraints: { minReputation: 2, allowTrial: true },
  // El default pasó a ser el carril REAL, que es el de producción desde el flip. Antes era
  // `"punto-a-punto"` y hoy ese valor no existe.
  transport: "gateway",
  ...over,
});

// ── T-7.1 · AC-7 ─────────────────────────────────────────────────────────────────────────────────
//
// 🔴 TRES `it` MURIERON ACÁ, Y CADA UNO CON SU RAZÓN ESCRITA (WKH-332/W3):
//   · "cuando el catálogo y la ejecución divergen, nombra a los dos" — la divergencia era entre el
//     agente del catálogo y el slug cableado en el `fetch`. Sin slug no hay dos cosas que comparar.
//   · "cuando coinciden, lo dice sin inventar una divergencia" — ídem.
//   · "si el server no dice quién corre, lo dice" — custodiaba el version-skew de `runsTodayAgentId`,
//     un campo que dejó de existir en el contrato.
// Los tres asertaban la PRESENCIA de las dos frases que AC-7 ahora prohíbe. Portarlos habría sido
// conservar el invariante viejo; lo que los reemplaza es el `it` de abajo, que asserta su AUSENCIA en
// TODOS los estados, no en uno.
describe("T-7.1: la tarjeta ya no puede afirmar que un paso corra por un agente nombrado", () => {
  // Los cuatro estados que la tarjeta sabe pintar con un agente presente o ausente. Se recorren todos
  // a propósito: un test que mirara un solo estado dejaría verde la frase sobreviviendo en otro.
  const ESTADOS: Array<{ label: string; step: PlanStep }> = [
    { label: "gateway + agente ofrecido", step: paso() },
    { label: "demo + agente ofrecido", step: paso({ transport: "demo" }) },
    {
      label: "sin candidatos",
      step: paso({ agent: null, availability: "sin-candidatos", constraints: { minReputation: 2 } }),
    },
    { label: "no consultado", step: paso({ agent: null, availability: "no-consultado" }) },
  ];

  it.each(ESTADOS)("en '$label' el DOM no dice 'Hoy se llama directo a' ni 'Hoy no corre ese'", async ({ step }) => {
    await verLaTarjeta([step], 0.03);
    const dom = document.body.textContent ?? "";
    expect(dom).not.toContain("Hoy se llama directo a");
    expect(dom).not.toContain("Hoy no corre ese");
    // Y la tarjeta SÍ se renderizó: sin esto el test pasaría con la tarjeta ausente del DOM.
    expect(screen.getByText(/Quién va a atender tu envío/)).toBeInTheDocument();
  });

  // El carril real: se dice que el gateway elige al ejecutar, sin nombrar a quién.
  it("en el carril del gateway dice que se elige al ejecutar, sin nombrar a nadie como el que corre", async () => {
    await verLaTarjeta([paso()], 0.03);
    expect(screen.getByText(/corre por el gateway, que elige al ejecutar/)).toBeInTheDocument();
    // El agente del catálogo SÍ se nombra, y eso es correcto: la frase dice "el catálogo ofrece a",
    // no "corre". La distinción es el punto de AC-7.
    expect(screen.getByText(/El catálogo ofrece a remit-corridor-fx-solana/)).toBeInTheDocument();
  });

  // 🔴 EL MODO DEMO, que es la razón por la que `transport` sobrevivió al borrado (DT-8). Sin este
  // campo la fila diría "corre por el gateway" mientras un simulador local cotiza.
  it("en modo demo NO dice que el paso corra por el gateway: dice que lo simula", async () => {
    await verLaTarjeta([paso({ transport: "demo" })], 0.03);
    expect(screen.getByText(/esta app está en modo demo y lo simula/)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toContain("corre por el gateway");
  });

  // 🔴 ESTE `it` MONTABA UN SOLO PLANO, Y LA REGLA ES ABSOLUTA (WKH-338/W2.5). Montaba `[paso()]`, o sea
  // el cuadrante (gateway, gateway), y desde que la nota de precio se elige por los DOS legs hay TRES
  // notas posibles: con un solo montaje las otras dos no las barría nadie y un em dash entraba en ellas
  // sin que nada se pusiera rojo. Acá el `document.body` SÍ sirve, y es la excepción: es un assert de
  // AUSENCIA global, no una comparación entre dos copys.
  it.each([
    ["gateway", "gateway"],
    ["gateway", "demo"],
    ["demo", "gateway"],
    ["demo", "demo"],
  ] as const)("no mete un em dash (cotización=%s, entrega=%s)", async (transporteFx, transporteEntrega) => {
    await verLaTarjeta(
      [
        paso({ transport: transporteFx }),
        paso({ capability: "remittance-payout", label: "Entregar el dinero", transport: transporteEntrega }),
      ],
      0.06,
    );
    expect(document.body.textContent ?? "").not.toContain("—");
  });
});

// ── El precio que la persona no paga ─────────────────────────────────────────────────────────────
//
// ⚠️ ESTE TÍTULO DECÍA *"El precio que nadie cobra"*, que es la variante MÁS CORTA del argumento de
// arriba y era ambigua entre dos cosas distintas (WKH-336/AR/BLQ-MED-1): *"no se le cobra a la
// persona"*, que es cierto en los cuatro cuadrantes, y *"nadie lo cobra"*, que es FALSO con
// `adapter="fallback"` + `settle="true"` —ahí el leg de entrega va por el gateway y su fee se paga
// contra la Agent Key de Chaski—. Se acota a lo que se puede sostener: la persona no lo paga.
//
// Decía "Lo que cobran los agentes: 0.06 USDC", y el precio es el de CATÁLOGO de agentes que pueden
// no ser los que corren. La frase del modo demo cambió de contenido en W3, no sólo de nombre: decía
// "la app los llama sin ningún pago y contestan igual", que describía el `fetch` liso del carril punto
// a punto contra un agente REAL. Borrado ese carril, la frase vieja pasó a ser falsa; y la que la
// reemplazó —*"no llama a ninguno de ellos"*— también, porque el ADAPTER no decide la ENTREGA (CR2):
// esa la decide el settle, y WKH-336 cerró ese residual.
describe("el precio dice qué es y quién lo cobraría", () => {
  it("en modo demo no afirma un cobro, y no afirma que se llame a nadie", async () => {
    await verLaTarjeta([paso({ transport: "demo" })], 0.06);

    expect(screen.getByText("Precio publicado en el catálogo")).toBeInTheDocument();
    expect(screen.getByText("0.06 USDC")).toBeInTheDocument(); // el dato se conserva
    expect(
      screen.getByText(/la cotización que estás aprobando la armó la app, no ellos/),
    ).toBeInTheDocument();
    // La frase vieja, que afirmaba un cobro que no ocurre.
    expect(screen.queryByText("Lo que cobran los agentes")).toBeNull();
    // Y las dos que se fueron: la del carril borrado, y la que generalizaba a TODOS los agentes (CR2).
    expect(document.body.textContent ?? "").not.toMatch(/los llama sin ningún pago|no llama a ninguno de ellos/);
  });

  // El otro carril SÍ paga, y por eso no puede compartir la frase: ahí el fee lo liquida el gateway
  // contra la Agent Key de Chaski. Decir "no se cobra" también ahí sería el mismo error al revés.
  it("en el carril del gateway dice quién paga, en vez de decir que no se cobra", async () => {
    await verLaTarjeta([paso()], 0.06);

    expect(screen.getByText(/lo paga Chaski con su Agent Key al ejecutar el paso/)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toContain("la armó la app, no ellos");
  });

  // ── T-R1 · WKH-336/R1 · la nota habla de la COTIZACIÓN, así que la elige el leg de la cotización ──
  //
  // 🔴 EL DEFECTO QUE ESTOS CUATRO CASOS MIDEN, y es uno que WKH-336 volvió alcanzable. El selector era
  // `plan.steps.some((s) => s.transport === "demo")`: preguntaba *"¿ALGÚN paso es demo?"* para elegir
  // entre dos notas cuya diferencia es una afirmación sobre la COTIZACIÓN (*"la cotización que estás
  // aprobando la armó la app, no ellos"*). Mientras el preview pegaba un `transport` único a los dos
  // pasos eso era inocuo: nunca discrepaban. Al derivar por leg apareció el cuadrante
  // `["gateway","demo"]` —adapter en el carril real, settle Solana apagado—, donde el `.some()` se
  // activa POR LA PATA DE ENTREGA y muestra una nota que dice que la cotización la armó la app,
  // mientras la armó el gateway. Ahora el selector mira `steps[0]`.
  //
  // ⚠️ LOS CUATRO CASOS ESTÁN, NO SÓLO EL NUEVO. Un test que sólo mirara el cuadrante mixto no probaría
  // que la elección sigue siendo la MISMA en los tres viejos, que es la mitad de la obligación: un
  // selector que devolviera siempre la nota GATEWAY también lo pasaría.
  //
  // Lo que mata el mutante: revertir a `.some((s) => s.transport === "demo")` deja los tres primeros
  // casos verdes y pone ROJO el cuarto (el mixto), porque ahí `.some()` es `true` y esta app mostraría
  // `AGENT_PRICE_NOTE_DEMO`. MEDIDO.
  const LA_ARMO_LA_APP = /la cotización que estás aprobando la armó la app, no ellos/;
  const LO_PAGA_CHASKI = /lo paga Chaski con su Agent Key al ejecutar el paso/;
  const fx = (t: "gateway" | "demo") => paso({ label: "Cotizar el cambio", transport: t });
  const payout = (t: "gateway" | "demo") =>
    paso({ capability: "remittance-payout", label: "Entregar el dinero", transport: t });

  it("T-R1a: los dos legs en gateway ⇒ la nota del gateway (adapter real + settle encendido)", async () => {
    await verLaTarjeta([fx("gateway"), payout("gateway")], 0.06);
    expect(screen.getByText(LO_PAGA_CHASKI)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(LA_ARMO_LA_APP);
  });

  it("T-R1b: la cotización en demo y la entrega en gateway ⇒ la nota del demo (settle encendido, adapter en fallback)", async () => {
    await verLaTarjeta([fx("demo"), payout("gateway")], 0.06);
    expect(screen.getByText(LA_ARMO_LA_APP)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(LO_PAGA_CHASKI);
  });

  it("T-R1c: los dos legs en demo ⇒ la nota del demo", async () => {
    await verLaTarjeta([fx("demo"), payout("demo")], 0.06);
    expect(screen.getByText(LA_ARMO_LA_APP)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(LO_PAGA_CHASKI);
  });

  // 🔴 EL CUADRANTE QUE WKH-336 VOLVIÓ ALCANZABLE, y el único que el `.some()` contestaba mal.
  it("T-R1d: la cotización en gateway y la entrega en demo ⇒ NO puede decir que la cotización la armó la app", async () => {
    await verLaTarjeta([fx("gateway"), payout("demo")], 0.06);
    expect(document.body.textContent ?? "").not.toMatch(LA_ARMO_LA_APP);
    expect(screen.getByText(LO_PAGA_CHASKI)).toBeInTheDocument();
    // Y la fila de la ENTREGA sigue diciendo lo suyo: la nota de precio no borra el transporte por paso.
    // ⚠️ Esta línea asserta el STRING QUE HOY SE RENDERIZA, no que la entrega se simule: con el settle
    // apagado no se simula, se corta (`this.solana`, `../application/use-cases/confirm-and-send.ts:336`).
    // Esa imprecisión es H1 de WKH-336, declarada y no corregida porque exige un tercer `transport`.
    expect(screen.getByText(/esta app está en modo demo y lo simula/)).toBeInTheDocument();
  });

  // T-R1e — AR/MNR-2. La nota se elige por la LLAVE del leg, no por la POSICIÓN en el array.
  //
  // Lo que mata: volver a `plan.steps[0]?.transport`. Con los pasos al revés ese índice devuelve el leg
  // de ENTREGA, que acá está en `"demo"`, y la tarjeta afirmaría que la cotización la armó la app
  // mientras la armó el gateway. MEDIDO: con el índice posicional este `it` es el único que se pone
  // rojo, y T-R1a..d siguen verdes (por eso el caso hace falta: el orden normal no lo distingue).
  //
  // ⚠️ El orden del server hoy está clavado (`route.ts:273-290` es un literal de dos elementos), así que
  // este `it` no reproduce un bug alcanzable HOY: clava la suposición del cliente, que es lo que no
  // estaba cubierto porque este archivo fabrica sus propios arrays.
  it("T-R1e: con los pasos al REVÉS la nota sigue saliendo del leg de la cotización, no del primero", async () => {
    await verLaTarjeta([payout("demo"), fx("gateway")], 0.06);
    expect(screen.getByText(LO_PAGA_CHASKI)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(LA_ARMO_LA_APP);
  });

  // T-R1f — AR/MNR-2, la otra mitad: la llave es el `label` y NO la `capability`, porque la capacidad
  // sale de una env overrideable (`route.ts:255`, `.env.example:181`). Un `find` por
  // `"remittance-fx-quote"` devolvería `undefined` con el override puesto y la nota caería SIEMPRE en la
  // del gateway, en silencio. Acá la capacidad es la overrideada y la nota tiene que seguir siendo la
  // del demo.
  it("T-R1f: con la capacidad overrideada por env la nota sigue saliendo del leg de la cotización", async () => {
    await verLaTarjeta(
      [
        paso({ capability: "fx-quote-de-otro-catalogo", label: "Cotizar el cambio", transport: "demo" }),
        payout("gateway"),
      ],
      0.06,
    );
    expect(screen.getByText(LA_ARMO_LA_APP)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(LO_PAGA_CHASKI);
  });

  // ── T-R1g · CR/BLQ-MED-1 · si no se puede identificar el leg de la cotización, NO SE AFIRMA NADA ──
  //
  // 🔴 LA RAMA QUE NO CUBRÍA NADIE. `paso()` pone el `label` por default, y los SEIS casos T-R1a..f lo
  // incluyen, así que ningún test entraba nunca al `find(...) === undefined`. Y esa rama caía en
  // `AGENT_PRICE_NOTE_GATEWAY` —la afirmación MÁS FUERTE de todas, la que dice que el fee se paga—
  // justo cuando no se sabe de qué leg se habla. Al revés del criterio del archivo: `no-consultado` y el
  // campo ausente NO afirman nada sobre el catálogo (docblock de `AgentUnavailable`).
  //
  // Es alcanzable por drift, no por el server de hoy: si el `label` de `route.ts:276` se renombra y
  // `FX_STEP_LABEL` se queda viejo, TODO plano de producción entra por acá. T-336.6 lo impide; este `it`
  // custodia que, si igual pasara, la pantalla CALLE en vez de afirmar de más.
  //
  // Lo que mata: volver a `…?.transport === "demo" ? DEMO : GATEWAY` sin la guarda ⇒ se renderiza la
  // nota del gateway y el segundo assert se pone rojo. MEDIDO.
  it("T-R1g: si ningún paso trae el label de la cotización, no se renderiza NINGUNA de las tres notas", async () => {
    await verLaTarjeta(
      [
        paso({ label: "Cotizar el tipo de cambio", transport: "demo" }), // el label renombrado
        payout("gateway"),
      ],
      0.06,
    );
    // La tarjeta sí se renderizó y el dato del precio se conserva: no es un test que pase por DOM vacío.
    expect(screen.getByText("Precio publicado en el catálogo")).toBeInTheDocument();
    expect(screen.getByText("0.06 USDC")).toBeInTheDocument();
    // Y ninguna de las TRES notas afirma nada (WKH-338 agregó la acotada; los dos asserts la alcanzan).
    expect(document.body.textContent ?? "").not.toMatch(LO_PAGA_CHASKI);
    expect(document.body.textContent ?? "").not.toMatch(LA_ARMO_LA_APP);
  });

  // ── T-338 · WKH-338 · la nota se elige leyendo LOS DOS legs, y sólo afirma lo que su pata garantiza ──
  //
  // 🔴 EL DEFECTO QUE ESTOS CASOS MIDEN. T-R1 dejó el selector mirando SÓLO el leg de la cotización, y
  // eso cerró la cláusula sobre quién armó la cotización pero no la otra: la nota GATEWAY dice que
  // *"ese fee"* —el total, o sea la suma de los steps que publican precio (`withPrice`,
  // `../../app/api/a2a/plan/route.ts:294`), que con las dos patas con precio son las dos— lo paga
  // Chaski. En el cuadrante
  // `adapter="a2a-gateway"` + settle apagado la mitad de ese número es el fee de un paso que no se va a
  // ejecutar: el envío falla cerrado antes de intentarlo (`this.solana`,
  // `../application/use-cases/confirm-and-send.ts:336`). Ahora la nota se acota NOMBRANDO la pata de la
  // cotización, y de la entrega no dice nada.
  //
  // ⚠️ DE LA ENTREGA NO DICE NADA A PROPÓSITO, Y NO ES UN OLVIDO. Decir *"la entrega no corre"* sería
  // cierto y contradiría, tres renglones más arriba en la MISMA tarjeta, la fila que renderiza
  // `AgentRunsToday` con *"esta app está en modo demo y lo simula"*. Esa imprecisión es H1 de WKH-336,
  // de otra HU, y hay un `it` cuyo eje literal es que la tarjeta no se contradiga a sí misma
  // (`honest-copy.test.tsx:432`). De la pata que no garantiza nada, la nota no dice nada.

  // 🔴 POR QUÉ EL HELPER AÍSLA EL NODO Y NO MIRA EL `document.body`, Y ES LA TRAMPA DE ESTA HU. Los
  // cuadrantes (gateway, gateway) y (gateway, demo) YA DIFIEREN en el body, hoy, sin ningún fix: la fila
  // de la ENTREGA dice *"corre por el gateway, que elige al ejecutar"* en el primero y *"esta app está
  // en modo demo y lo simula"* en el segundo, y las dos están asserteadas en este archivo (`:151` y
  // `:276`). Un T-338.1 escrito sobre `document.body.textContent` daría VERDE HOY —los bodies difieren
  // por la FILA, no por la NOTA— y sería decorativo para siempre: no podría detectar ni el defecto ni su
  // regresión. Por eso todo lo que compara notas compara ESTE nodo.
  function textoDeLaNota(): string {
    const nodos = screen.getAllByText(/publican en el catálogo/);
    // La tarjeta se monta en DOS pantallas (`AgentPlanCard`, `flow.tsx:1047` en `review` y `flow.tsx:1093`
    // en `confirm`) y `verLaTarjeta` para en `review`, así que hoy hay UN nodo. Un `cleanup()` olvidado
    // entre dos renders del mismo `it` deja DOS, y sin este assert se compararía la nota del render
    // ANTERIOR y el test daría verde por el DOM equivocado. Es el riesgo que este archivo ya declara en
    // el `describe` de abajo (CD-17).
    expect(nodos).toHaveLength(1);
    const [nodo] = nodos;
    const t = nodo?.textContent ?? "";
    // No-vacuidad: si el selector alguna vez capturara otro nodo, o si la nota quedara vacía, esto lo
    // dice en vez de dejar pasar una comparación entre dos strings vacíos.
    //
    // 🔴 ACÁ HUBO UN ASSERT DEBILITADO CON UN COMENTARIO AL LADO QUE DECÍA QUE NO DEBILITABA NADA
    // (CR/BLQ-MED-1). El fragmento era `"no se suma a lo que enviás"`; AR/MNR-3 cambió la cola de la
    // nota acotada a *"y ninguno de estos precios se suma a lo que enviás"*, el assert se puso rojo, y
    // lo resolví borrándole el `"no"` para que pasara: quedó `"se suma a lo que enviás"`, que es
    // subcadena de las dos formas y por lo tanto **no distingue la garantía de su inverso**. Al lado
    // escribí dos cosas FALSAS: que el fragmento estaba *"fuera de la cláusula que cambia"* —es su
    // COLA, por eso se había puesto rojo— y que *"no debilita nada"*.
    // MEDIDO por el CR, mutante línea-neutro sobre el literal: invertir la garantía de la nota GATEWAY
    // (`y no se suma…` ⇒ `y se suma…`) daba **3 rojos** antes de mi cambio y **102 files / 1643 PASS en
    // VERDE** después; ídem sobre la nota DEMO. O sea: la nota del cuadrante de producción podía afirmar
    // el INVERSO EXACTO de una garantía de dinero y la suite entera callaba. Un assert que se relaja
    // para que pase deja de ser un assert; y el comentario que dice que no se relajó es peor que el
    // relajamiento, porque apaga la revisión que lo habría encontrado.
    //
    // El fragmento de ahora es el ARRANQUE de la nota, que es lo único común a las tres y que NO es
    // parte de ninguna cláusula que esta familia de HUs toque (la de atribución ni la de garantía). Y
    // NO se reusa `publican en el catálogo`, que ya es el ancla del selector de arriba: un assert que
    // repite la condición del selector no puede fallar cuando el selector acierta, así que no mediría
    // nada. **La garantía NO se verifica acá**: la verifica `garantia` en cada uno de los cuatro
    // cuadrantes de T-338.3, con su forma exacta y negada.
    expect(t).toContain("Es lo que estos agentes");
    return t;
  }

  // T-338.1 · AC-1 — los dos cuadrantes del gateway NO pueden compartir la nota.
  //
  // Molde: render → capturar → `cleanup()` → render → capturar → comparar, el mismo del `it` que mata a
  // M4 más abajo en este archivo. Lo que mata: que el selector vuelva a mirar sólo
  // `cotizacion.transport` (M1, o sea el árbol previo a esta HU) ⇒ los dos textos son el MISMO string.
  it("T-338.1: con la entrega por el gateway y con la entrega apagada la nota NO es la misma", async () => {
    await verLaTarjeta([fx("gateway"), payout("gateway")], 0.06);
    const conEntregaPorGateway = textoDeLaNota();
    cleanup();
    await verLaTarjeta([fx("gateway"), payout("demo")], 0.06);
    const conEntregaApagada = textoDeLaNota();

    expect(conEntregaApagada).not.toBe(conEntregaPorGateway);
    // Y el test no puede pasar por haber ROTO la atribución en vez de acotarla: las DOS siguen diciendo
    // quién paga. Es la mitad de AC-3 que se puede afirmar acá sin tocar los asserts de T-R1a..g.
    expect(conEntregaPorGateway).toContain("lo paga Chaski con su Agent Key al ejecutar el paso");
    expect(conEntregaApagada).toContain("lo paga Chaski con su Agent Key al ejecutar el paso");
  });

  // T-338.5 · AC-4 (extensión) — la DIRECCIÓN del default cuando el leg de entrega no se identifica.
  //
  // El leg de entrega EXISTE en el plan, pero con un `label` que la llave del cliente no matchea, así
  // que el `find` devuelve `undefined`: es el cuadrante degenerado por drift del literal. Lo que mata:
  // escribir `entrega?.transport !== "demo"` en vez de `=== "gateway"` (M2). Con `undefined` ese `!==`
  // es `true` y la tarjeta caería en la afirmación MÁS FUERTE —que el fee del total se paga— justo
  // cuando no se sabe nada de la entrega. Cuando falta información la nota se DEBILITA, nunca se
  // fortalece.
  //
  // ⚠️ Las dos notas de referencia se CAPTURAN renderizando, no se copian a mano: un literal copiado se
  // queda viejo el día que la copy cambie y el test se compararía consigo mismo.
  it("T-338.5: si el leg de la entrega trae otro `label`, la nota es la MÁS DÉBIL y no la del total", async () => {
    await verLaTarjeta([fx("gateway"), payout("gateway")], 0.06);
    const cuadrante1 = textoDeLaNota();
    cleanup();
    await verLaTarjeta([fx("gateway"), payout("demo")], 0.06);
    const cuadrante2 = textoDeLaNota();
    cleanup();
    await verLaTarjeta(
      [fx("gateway"), paso({ capability: "remittance-payout", label: "Entregar la plata", transport: "gateway" })],
      0.06,
    );
    const sinPoderIdentificarLaEntrega = textoDeLaNota();

    expect(sinPoderIdentificarLaEntrega).not.toBe(cuadrante1);
    expect(sinPoderIdentificarLaEntrega).toBe(cuadrante2);
  });

  // T-338.3 · AC-2 — los CUATRO cuadrantes, cada uno con lo que su nota tiene que decir y lo que no.
  //
  // ⚠️ LOS CUATRO ESTÁN, NO SÓLO EL NUEVO: una nota que dijera SIEMPRE la más débil también arreglaría el
  // cuadrante 2, y sería una pérdida de información cierta en el cuadrante 1, el de las dos banderas
  // encendidas, donde Chaski sí paga los dos fees.
  // 🔴 `garantia` ES UN CAMPO APARTE DE `requiere`, Y ES LA CLÁUSULA DE DINERO (CR/BLQ-MED-1).
  //
  // La última cláusula de las tres notas dice que el número **NO** se le suma a lo que la persona envía.
  // Es la única afirmación de la tarjeta que habla de la plata de la persona, y es cierta en los cuatro
  // cuadrantes para las dos patas. **No la cubría ningún `requiere`** en los cuadrantes 1, 3 y 4: los
  // tres pedían sólo la atribución o el *"la armó la app"*. MEDIDO: invertirla (`no se suma` ⇒
  // `se suma`) daba **102 files / 1643 PASS en verde**, tanto en la nota GATEWAY como en la DEMO.
  //
  // Va en un campo propio y no pegada al `requiere` por dos razones: (a) su forma **difiere entre notas**
  // —la acotada dice *"ninguno de estos precios se suma"* por AR/MNR-3 y las otras dos *"no se suma"*—,
  // así que un fragmento único no puede cubrir las tres; (b) que sea un campo obligatorio del tipo
  // significa que **una nota nueva no se puede agregar a esta tabla sin declarar su garantía**, que es
  // exactamente el agujero por el que pasó la nota acotada.
  const CUADRANTES: Array<{
    caso: string;
    steps: PlanStep[];
    requiere: string;
    garantia: string;
    prohibe: string;
  }> = [
    {
      caso: "1 · (gateway, gateway) · adapter real + settle encendido",
      steps: [fx("gateway"), payout("gateway")],
      // Acá "ese fee" ES el total y es VERDADERO: con los dos legs por el gateway Chaski paga los dos
      // fees. Por eso esta nota no se acota: acotarla perdería información cierta y verificable.
      requiere: "ese fee lo paga Chaski con su Agent Key al ejecutar el paso",
      // El cuadrante de producción. Z1 es invertir esta cláusula acá.
      garantia: "y no se suma a lo que enviás.",
      prohibe: "la cotización que estás aprobando la armó la app, no ellos",
    },
    {
      caso: "2 · (gateway, demo) · adapter real + settle apagado",
      steps: [fx("gateway"), payout("demo")],
      // 🔴 EL `requiere` DE ESTE CUADRANTE INCLUYE LA ÚLTIMA CLÁUSULA A PROPÓSITO (AR/MNR-3). Sin ella,
      // volver a *"…, y no se suma a lo que enviás"* —acotando la GARANTÍA junto con la ATRIBUCIÓN—
      // pasaría en verde, y eso pierde información cierta para las dos patas en los cuatro cuadrantes.
      requiere:
        "el fee de la cotización lo paga Chaski con su Agent Key al ejecutar el paso, y ninguno de estos precios se suma a lo que enviás",
      // La forma acotada de la garantía, con su sujeto plural explícito.
      garantia: "y ninguno de estos precios se suma a lo que enviás.",
      // Lo que el defecto hacía: atribuir el pago del TOTAL cuando la mitad no la paga nadie.
      prohibe: "ese fee lo paga Chaski",
    },
    {
      caso: "3 · (demo, gateway) · adapter en fallback + settle encendido",
      steps: [fx("demo"), payout("gateway")],
      requiere: "la cotización que estás aprobando la armó la app, no ellos",
      // En la nota DEMO la garantía va pegada a los dos puntos, no a un "y". Z2 es invertirla acá.
      garantia: "catálogo: no se suma a lo que enviás,",
      prohibe: "lo paga Chaski",
    },
    {
      caso: "4 · (demo, demo) · adapter en fallback + settle apagado",
      steps: [fx("demo"), payout("demo")],
      requiere: "la cotización que estás aprobando la armó la app, no ellos",
      garantia: "catálogo: no se suma a lo que enviás,",
      prohibe: "lo paga Chaski",
    },
  ];

  // 🔴 ESTA LISTA **ES** I4 + I5 + I6 DEL SDD, ENTERAS, Y SE ACTUALIZA CON ELLAS. No es una selección.
  //
  // Acá había SIETE de las doce, y las cinco que faltaban incluían las TRES que DEFINEN CD-8 —`entrega`,
  // `Entregar`, `payout`—, o sea la restricción a la que el SDD le dedica una sección entera
  // (AR/BLQ-MED-2). MEDIDO con la lista corta: agregarle a la nota acotada
  // ` El fee de la entrega no está incluido en este total.` daba **1643 PASS** en verde, y esa frase
  // viola CD-8 **y es falsa** (el total sí lo incluye); agregarle ` El número es la suma de las dos
  // patas.` también daba verde, y es falsa con un leg en `priceUsdc: null`. O sea que la regresión que
  // esta HU vino a cerrar podía volver **sin un solo rojo**. Una guarda que enumera a mano un
  // subconjunto de su propia especificación no es una guarda: es una muestra.
  //
  // Por grupo, y por qué cada palabra está:
  //   · **I4 / CD-8** — `entrega`, `Entregar`, `payout`, `nadie`, `no corre`, `se simula`, `no lo paga`:
  //     cualquiera de las siete mete la nota a hablar de la pata que NO garantiza nada, y eso alcanza
  //     para prohibirla. `no corre` además CONTRADIRÍA a la fila de `AgentRunsToday`, que en ese mismo
  //     cuadrante dice que el paso *"se simula"* (H1 de WKH-336, residual de otra HU y no de ésta). Y
  //     `se simula` está por lo contrario: no contradiría a la fila, la REPETIRÍA, adoptando en la nota
  //     una imprecisión que esta HU declaró y no cerró.
  //   · **I5** — `—`: el em dash es regla absoluta del repo. Redundante con el `it.each` de arriba a
  //     propósito: ahí se mide sobre el body, acá sobre el nodo.
  //   · **I6 / CD-9** — `sumando`, `la suma de`, `los dos pasos`, `ambos pasos`: afirmarían QUÉ SUMA el
  //     número, y eso es falsable. Lo suma (`withPrice`, `../../app/api/a2a/plan/route.ts:294`), que
  //     filtra por precio conocido, y un leg puede venir con `priceUsdc: null`.
  //   · **I6, ampliación medida (CR/MNR-1)** — `cubre a las`, `cubre a los`, `cubre las dos`: es el
  //     MISMO argumento de I6 escrito sin la palabra "suma". No es una paráfrasis hipotética: es la
  //     formulación LITERAL que el AR acabó de borrar de `flow.tsx` por falsa, en DOS sitios
  //     (*"el número cubre a los dos"* y *"el número cubre a las dos patas"*), y que esta guarda dejaba
  //     pasar. Estaba prohibiendo `payout` —una palabra que nunca apareció en una nota— y permitiendo la
  //     que ya apareció falsa dos veces el mismo día.
  //
  // ⚠️ Si I4 o I6 crecen, **esta lista crece con ellas en el mismo commit**. Sin esta línea escrita, la
  // próxima ampliación del SDD vuelve a dejar la guarda corta y en verde, que es exactamente lo que pasó.
  //
  // 🔴 EL TECHO DE ESTA GUARDA, DECLARADO Y NO TAPADO (CR/MNR-1, TD-GUARDA-LITERAL). Esto compara
  // SUBCADENAS, así que **no puede cubrir paráfrasis**, y enumerarlas no escala. MEDIDO por el CR:
  // agregarle a la nota `" El segundo paso lo ejecuta la propia app."` viola CD-8 y **sobrevive en
  // verde**, porque no contiene ninguno de los literales de la lista. No se cierra acá, y no porque sea
  // difícil: cerrarlo es capacidad nueva.
  // ⚠️ **Y la salida futura ya existe fuera de la suite, medida**: el grupo `que-cubre-el-numero` de
  // `doc/sdd/049-wkh-338-nota-de-precio-atribucion-parcial-del-fee/barrido-familia.cjs` agrupa **por
  // ARGUMENTO y no por frase**, y el CR verificó que SÍ cae sobre `" El número cubre a las dos patas."`.
  // O sea que el criterio está escrito; lo que falta es cablearlo a la suite, y eso es otra HU. Hasta
  // entonces ese barrido **se invoca a mano** y no corre en `npm test`: no te apoyes en el verde de acá
  // para afirmar que la nota no habla de la otra pata.
  const PROHIBIDAS_EN_TODOS = [
    // I4 / CD-8
    "entrega",
    "Entregar",
    "payout",
    "nadie",
    "no corre",
    "se simula",
    "no lo paga",
    // I5
    "—",
    // I6 / CD-9
    "sumando",
    "la suma de",
    "los dos pasos",
    "ambos pasos",
    // I6, la ampliación de CR/MNR-1: el mismo argumento con el verbo "cubrir" en vez de "sumar".
    "cubre a las",
    "cubre a los",
    "cubre las dos",
  ];

  // 🔴 EL TÍTULO DICE LO QUE ESTE `it` MIDE, Y ANTES NO (CR/MNR-1). Decía *"la nota afirma lo de su pata
  // y nada de la otra"*, que es la INTENCIÓN (CD-8) y no el mecanismo: lo que mide es que la nota traiga
  // su atribución y su garantía, y que no contenga 15 literales. *"Nada de la otra"* es más de lo que
  // puede verificar —el techo está declarado arriba, con el mutante que sobrevive— y un título que
  // promete más que su cuerpo hace que el próximo lector no busque el agujero.
  it.each(CUADRANTES)(
    "T-338.3 · cuadrante $caso: la nota trae su atribución y su garantía, y ninguno de los literales prohibidos",
    async ({ steps, requiere, garantia, prohibe }) => {
      await verLaTarjeta(steps, 0.06);
      // 🔴 SOBRE EL NODO, NUNCA SOBRE EL BODY. `"nadie"` aparece LEGÍTIMAMENTE en otro nodo de esta misma
      // tarjeta (*"El catálogo no ofrece a nadie…"*, asserteado más abajo en este archivo), así que un
      // `not.toContain("nadie")` sobre `document.body` sería un FALSO ROJO.
      const nota = textoDeLaNota();
      expect(nota).toContain(requiere);
      // La cláusula de dinero, con su forma NEGADA y exacta. Es lo único de la tarjeta que habla de la
      // plata de la persona, y es el assert que faltaba en los cuadrantes 1, 3 y 4 (CR/BLQ-MED-1).
      expect(nota).toContain(garantia);
      expect(nota).not.toContain(prohibe);
      for (const prohibida of PROHIBIDAS_EN_TODOS) expect(nota).not.toContain(prohibida);
    },
  );

  // T-338.4 · H-1 de WKH-338 · la cláusula ELIDIDA de la nota DEMO.
  //
  // 🔴 QUÉ SE BORRÓ Y POR QUÉ, MEDIDO. La nota DEMO decía *"Es lo que estos agentes publican en el
  // catálogo, **no lo que se cobra en este envío**: …"*. Esa cláusula del medio es la variante ELIDIDA
  // del claim que el AR de WKH-336 ya refutó una vez —*"nadie lo cobra"*, acotado entonces a *"la persona
  // no lo paga"*—: no dice quién no cobra, así que se lee como que el número no se cobra a nadie. Y esta
  // nota se muestra en el cuadrante (demo, gateway) —adapter en `"fallback"`, settle encendido—, donde el
  // fee de la ENTREGA sí se cobra, contra la Agent Key de Chaski (`solanaSettleOn`,
  // `../composition/container.ts:141`). La cláusula que sigue —*"no se suma a lo que enviás"*— ya dice lo
  // verdadero y acotado a la persona, así que la de arriba no aporta y puede leerse falsa: se borra, no
  // se reescribe.
  //
  // Lo que mata (M7): conservar la cláusula ⇒ este `it` en rojo. Y la supresión NO toca
  // `"la armó la app, no ellos"`, así que ninguno de los asserts de `LA_ARMO_LA_APP` se mueve.
  it("T-338.4: la nota del demo no afirma que el número no se cobre en este envío", async () => {
    await verLaTarjeta([fx("demo"), payout("gateway")], 0.06);
    expect(textoDeLaNota()).not.toContain("no lo que se cobra en este envío");
  });
});

// ── T-14.5 · AC-14 / CD-18 · tres estados, tres frases, y una que NO puede acusar al catálogo ────
//
// 🔴 EL BUG QUE CIERRA, MEDIDO en el árbol previo a WKH-332: la tarjeta tenía UNA sola frase para el
// caso sin agente —"El catálogo no ofrece a nadie para esta capacidad ahora mismo"— y `discoverFor`
// llegaba a ese caso por CUATRO caminos, de los cuales tres no dicen nada del catálogo (un 500, un
// body ilegible, un timeout de red nuestro). La pantalla convertía una falla nuestra en una
// afirmación de hecho sobre el otro.
//
// CD-17: este `describe` depende del `afterEach` del tope del archivo (`cleanup` + `unstubAllGlobals`)
// y del `vi.mock("framer-motion")` de módulo. Sin el `cleanup`, `getByText` encuentra la tarjeta del
// `it` anterior y el test da verde por el DOM equivocado.
describe("T-14.5: los tres estados llegan a pantalla con tres textos distintos", () => {
  const sinAgente = (over: Partial<PlanStep> = {}): PlanStep =>
    paso({ agent: null, ...over });

  it("`sin-candidatos` afirma que el catálogo no ofrece a nadie, Y NOMBRA EL PISO que lo explica", async () => {
    await verLaTarjeta(
      [sinAgente({ availability: "sin-candidatos", constraints: { minReputation: 2 } })],
      0,
    );
    // El catálogo CONTESTÓ, así que acá sí se puede afirmar. Y se nombra el piso porque el piso es la
    // razón por la que la lista puede venir vacía teniendo el catálogo agentes para esa capacidad.
    expect(screen.getByText(/El catálogo no ofrece a nadie para esta capacidad/)).toBeInTheDocument();
    expect(screen.getByText(/con al menos 2 de reputación/)).toBeInTheDocument();
  });

  it("🔴 `no-consultado` NO contiene 'no ofrece a nadie': no se puede afirmar lo que no se preguntó", async () => {
    await verLaTarjeta([sinAgente({ availability: "no-consultado" })], 0);

    expect(screen.getByText(/No pudimos consultar el catálogo para este paso/)).toBeInTheDocument();
    // El candado de CD-18, sobre el DOM entero y no sobre un nodo: la subcadena no puede aparecer en
    // NINGUNA parte de la tarjeta cuando el estado es "no pudimos preguntar".
    expect(document.body.textContent ?? "").not.toContain("no ofrece a nadie");
  });

  it("y el campo AUSENTE (server viejo durante un deploy) cae del lado que no afirma nada", async () => {
    await verLaTarjeta([sinAgente({ availability: undefined })], 0);
    expect(screen.getByText(/No pudimos consultar el catálogo para este paso/)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toContain("no ofrece a nadie");
  });

  // 🔴 EL `it` QUE MATA A M4. Los dos estados renderizados y comparados ENTRE SÍ: colapsarlos deja
  // verde a cualquier test que mire un solo estado por vez.
  it("las dos frases son DISTINTAS entre sí (colapsarlas es el mutante M4)", async () => {
    await verLaTarjeta([sinAgente({ availability: "sin-candidatos", constraints: { minReputation: 2 } })], 0);
    const textoSinCandidatos = document.body.textContent ?? "";
    cleanup();
    await verLaTarjeta([sinAgente({ availability: "no-consultado" })], 0);
    const textoNoConsultado = document.body.textContent ?? "";

    expect(textoSinCandidatos).toContain("no ofrece a nadie");
    expect(textoNoConsultado).not.toContain("no ofrece a nadie");
    expect(textoNoConsultado).toContain("No pudimos consultar el catálogo");
    expect(textoSinCandidatos).not.toContain("No pudimos consultar el catálogo");
  });

  // AC-14, la mitad que se ve: la tarjeta DICE con qué se preguntó, y el número sale de la respuesta.
  // Se renderiza en `review`, o sea ANTES del KYC (`verLaTarjeta` llega hasta esa pantalla).
  it("dice con qué piso se consultó, y el número sale de la respuesta y no de un literal", async () => {
    await verLaTarjeta([paso({ constraints: { minReputation: 2, allowTrial: true } })], 0.03);
    expect(
      screen.getByText(/se consultó con el mismo piso de reputación con el que corre el envío \(2\)/),
    ).toBeInTheDocument();
  });

  it("si el server no manda las constraints, la frase del piso NO se muestra (no se afirma sin dato)", async () => {
    await verLaTarjeta([paso({ constraints: undefined })], 0.03);
    expect(document.body.textContent ?? "").not.toContain("piso de reputación con el que corre");
  });
});
