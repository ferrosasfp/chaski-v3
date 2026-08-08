import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FX_MIN_REPUTATION,
  PAYOUT_MIN_REPUTATION,
} from "../../../../src/infrastructure/a2a/gateway-client";
import { GET } from "./route";

const BASE = "https://gateway.test";

/** Card mínima con la forma que devuelve el catálogo en vivo (medida el 2026-08-02). */
const card = (id: string, priceUsdc: number) => ({
  id,
  description: `desc de ${id}`,
  priceUsdc,
  verified: false,
  registry: "self-published",
});

function stubCatalog(byCapability: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      const cap = new URL(String(url)).searchParams.get("capabilities") ?? "";
      const agents = byCapability[cap];
      return new Response(JSON.stringify({ agents: agents ?? [] }), { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/a2a/plan — el preview de quién atiende la remesa", () => {
  it("sin gateway configurado → 501, y NO un plan vacío", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", "");
    const res = await GET();
    expect(res.status).toBe(501);
    // "no pudimos averiguarlo" y "no interviene nadie" son cosas distintas: un 200 con steps
    // vacíos se leería como que la remesa no usa agentes, que es falso.
    expect(await res.json()).toEqual({ error: "gateway_not_configured" });
  });

  // 🔴 EL TEST QUE MÁS IMPORTA DE ESTE ARCHIVO. Medido contra el catálogo en vivo: `capabilities=X`
  // filtra y devuelve 1 agente; `capability=X` (singular) NO filtra y devuelve los 23 del catálogo.
  // El typo no falla, muestra al agente equivocado con su precio equivocado, y la pantalla se ve
  // perfectamente normal. Por eso se assertea el nombre del parámetro y no sólo el resultado.
  it("filtra por `capabilities` en PLURAL (el singular no filtra y mostraría cualquier agente)", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    const calls = stubCatalog({
      "remittance-fx-quote": [card("remit-corridor-fx-solana", 0.03)],
      "remittance-payout": [card("remit-cashout-payout-solana", 0.03)],
    });
    await GET();
    expect(calls).toHaveLength(2);
    for (const u of calls) {
      expect(new URL(u).searchParams.has("capabilities")).toBe(true);
      expect(new URL(u).searchParams.has("capability")).toBe(false);
    }
  });

  // Descubrir es gratis; componer EJECUTA los pasos y los cobra. Un preview que compone cobra la
  // remesa dos veces. Esta es la clase de error que no se ve hasta la factura.
  it("NUNCA llama a /compose ni a /orchestrate: un preview no ejecuta ni cobra", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    const calls = stubCatalog({ "remittance-fx-quote": [card("a", 0.01)] });
    await GET();
    for (const u of calls) {
      expect(u).toContain("/discover");
      expect(u).not.toContain("/compose");
      expect(u).not.toContain("/orchestrate");
    }
  });

  it("suma sólo los precios conocidos, y dice cuántos pasos quedaron sin precio", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    stubCatalog({
      "remittance-fx-quote": [card("fx", 0.03)],
      // agente SIN priceUsdc: no es gratis, es desconocido
      "remittance-payout": [{ id: "payout", description: "", verified: false, registry: "r" }],
    });
    const body = (await (await GET()).json()) as {
      totalUsdc: number;
      stepsWithoutPrice: number;
      steps: Array<{ agent: { priceUsdc: number | null } | null }>;
    };
    // 🔴 Un precio ausente NO suma 0: el total tiene que leerse como incompleto, no como barato.
    expect(body.totalUsdc).toBe(0.03);
    expect(body.stepsWithoutPrice).toBe(1);
    expect(body.steps[1]?.agent?.priceUsdc).toBeNull();
  });

  it("capacidad sin oferta → agent null, no un agente inventado", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    stubCatalog({}); // el catálogo no ofrece a nadie
    const body = (await (await GET()).json()) as { steps: Array<{ agent: unknown }> };
    expect(body.steps.every((s) => s.agent === null)).toBe(true);
  });

  // 🔴 EL DOMINIO DE `transport` CAMBIÓ EN W3: `"punto-a-punto"` salió con el carril y entró `"demo"`.
  // El eje del test NO cambia —el campo dice por dónde corre HOY, no por dónde podría—, y sigue
  // comparando los dos valores en la MISMA corrida: un `transport` hardcodeado a `"gateway"` (que es
  // lo que pasaría si alguien "simplificara" el campo) pone en rojo la primera mitad.
  it("declara el transporte REAL: con la bandera en fallback dice demo, con el gateway dice gateway", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "fallback");
    stubCatalog({ "remittance-fx-quote": [card("fx", 0.03)] });
    const off = (await (await GET()).json()) as { steps: Array<{ transport: string }> };
    // Con la bandera en "fallback" la cotización la arma un simulador del container: decir "gateway"
    // ahí sería una pantalla que mide una cosa y afirma otra. (La ENTREGA no la decide esta bandera.)
    expect(off.steps.every((s) => s.transport === "demo")).toBe(true);
    // Y el valor del carril borrado no puede volver por ninguna puerta.
    expect(JSON.stringify(off)).not.toContain("punto-a-punto");

    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gateway");
    stubCatalog({ "remittance-fx-quote": [card("fx", 0.03)] });
    const on = (await (await GET()).json()) as { steps: Array<{ transport: string }> };
    expect(on.steps.every((s) => s.transport === "gateway")).toBe(true);
  });

  // La env AUSENTE cae del lado del demo, igual que en el container (`resolveValueDeliveryAdapter`
  // traduce `undefined` a `"fallback"`). Sin este caso, un deployment sin la env vería la tarjeta
  // afirmando que el paso corre por el gateway mientras un simulador local cotiza.
  it("la bandera AUSENTE también dice demo, no gateway", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", undefined as unknown as string);
    stubCatalog({ "remittance-fx-quote": [card("fx", 0.03)] });
    const body = (await (await GET()).json()) as { steps: Array<{ transport: string }> };
    expect(body.steps.every((s) => s.transport === "demo")).toBe(true);
  });
});

// ── QUIÉN CORRE HOY: EL CAMPO MURIÓ, Y LO QUE QUEDA ES EL CANDADO DE SU AUSENCIA ─────────────────
//
// 🔴 DOS `it` MURIERON ACÁ (WKH-332/W3), y con ellos el campo que medían:
//   · "en punto-a-punto declara el slug REAL que las rutas invocan" — comparaba `runsTodayAgentId`
//     contra las dos constantes de slug. Las constantes se borraron con el `fetch` que las usaba, así
//     que el test no tiene contra qué comparar: su assert no se puede ni escribir.
//   · "en el carril del gateway NO nombra a nadie" — asertaba `runsTodayAgentId === null`, o sea el
//     único valor que ese campo podía tomar post-flip. Comprobar que un campo inexistente es `null`
//     no prueba nada.
// Lo que los reemplaza es un `it` de AUSENCIA, que es la propiedad que AC-2/AC-7 necesitan: el
// contrato de esta ruta no puede volver a llevar un nombre de agente que afirme QUIÉN corre.
describe("GET /api/a2a/plan — el contrato ya no puede decir QUIÉN corre", () => {
  it("ni con el gateway ni en demo aparece `runsTodayAgentId` en la respuesta", async () => {
    for (const flag of ["a2a-gateway", "fallback"]) {
      vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
      vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", flag);
      stubCatalog({
        "remittance-fx-quote": [card("un-proveedor-de-fx", 0.03)],
        "remittance-payout": [card("un-proveedor-de-payout", 0.03)],
      });
      const raw = await (await GET()).text();
      const body = JSON.parse(raw) as { steps: Array<Record<string, unknown>> };
      expect(body.steps.length, flag).toBe(2);
      // Sobre el TEXTO y sobre las claves: `toHaveProperty` en `undefined` pasaría si alguien mandara
      // la clave con valor `undefined`, que `JSON.stringify` borra pero que el tipo aceptaría.
      expect(raw, flag).not.toContain("runsTodayAgentId");
      for (const step of body.steps) {
        expect(Object.keys(step), flag).not.toContain("runsTodayAgentId");
      }
    }
  });

  // El agente del catálogo SÍ sigue viajando, y eso es lo que la HU vino a habilitar: la tarjeta
  // puede decir "el catálogo ofrece a X" sin afirmar que X vaya a correr. Borrar `agent` habría sido
  // tirar el premio.
  it("`agent` sigue viajando: decir quién OFRECE no es decir quién CORRE", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gateway");
    stubCatalog({ "remittance-fx-quote": [card("un-proveedor-de-fx", 0.03)] });
    const body = (await (await GET()).json()) as {
      steps: Array<{ agent: { id: string } | null }>;
    };
    expect(body.steps[0]?.agent?.id).toBe("un-proveedor-de-fx");
  });
});

// ── AC-14 · el preview pregunta lo MISMO que la ejecución ────────────────────────────────────────
//
// 🔴 EL AGUJERO QUE CIERRA, MEDIDO sobre el árbol previo a WKH-332: `discoverFor` llamaba a
// `/discover?capabilities=X` y NADA MÁS, mientras `payout/prepare` ejecutaba con
// `constraints.min_reputation = PAYOUT_MIN_REPUTATION` y `a2a/quote` con ese piso MÁS
// `allow_trial: true`. O sea que la tarjeta podía mostrar un agente que la ejecución iba a rechazar,
// y la persona aprobaba mirando a alguien que no iba a atenderla.
//
// CD-17: este `describe` depende del `afterEach` de arriba (`unstubAllEnvs` + `unstubAllGlobals`).
// Sin él, el `WASIAI_A2A_GATEWAY_URL` de un `it` se filtra al siguiente y el `stubCatalog` del
// anterior contesta por el de después.
describe("GET /api/a2a/plan — descubre con las MISMAS constraints que la ejecución (AC-14)", () => {
  /** Devuelve las URLs pedidas, indexadas por capacidad, para poder mirar una query concreta. */
  async function queriesDeUnPlan(): Promise<{ fx: URL; payout: URL; todas: string[] }> {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    const calls = stubCatalog({
      "remittance-fx-quote": [card("fx", 0.03)],
      "remittance-payout": [card("payout", 0.03)],
    });
    await GET();
    const urls = calls.map((u) => new URL(u));
    const fx = urls.find((u) => u.searchParams.get("capabilities") === "remittance-fx-quote");
    const payout = urls.find((u) => u.searchParams.get("capabilities") === "remittance-payout");
    if (!fx || !payout) throw new Error(`no salieron las dos queries: ${calls.join(" | ")}`);
    return { fx, payout, todas: calls };
  }

  // T-14.1
  it("T-14.1: el leg de payout manda min_reputation; el de FX manda min_reputation Y allowTrial", async () => {
    const { fx, payout } = await queriesDeUnPlan();
    // AR/MNR-2: los pisos salen de las CONSTANTES, no de un "2" clavado acá. Un `2` escrito a mano en
    // el test hace que mover un piso (algo que CD-12 prohíbe hoy, pero que algún día se decidirá con
    // su propio SDD) ponga rojo este `it` por una razón que no es la que dice vigilar.
    expect(payout.searchParams.get("min_reputation")).toBe(String(PAYOUT_MIN_REPUTATION));
    expect(fx.searchParams.get("min_reputation")).toBe(String(FX_MIN_REPUTATION));
    expect(fx.searchParams.get("allowTrial")).toBe("true");
    // La asimetría es deliberada y por eso se asserta: admitir a un agente sin historial liquidado
    // para COTIZAR cuesta una cotización mala; para ENTREGAR EL DINERO cuesta el dinero.
    expect(payout.searchParams.has("allowTrial")).toBe(false);
  });

  // T-14.2 — 🔴 CD-21. El candado de esta HU.
  it("T-14.2: NINGUNA query lleva `allow_trial` en snake — ese nombre da 400 y el 400 miente", async () => {
    const { todas } = await queriesDeUnPlan();
    // Por qué es una subcadena cruda y no `searchParams.has`: la trampa es que el nombre viaje
    // ESCRITO en la URL de cualquier forma. `/discover` valida los nombres contra un conjunto cerrado
    // (`ALLOWED_DISCOVER_PARAMS`, medido en el gateway: tiene `allowTrial`, `minReputation` y
    // `min_reputation`, y NO tiene `allow_trial`) y contesta 400 UNKNOWN_DISCOVER_PARAM. Ese 400 cae
    // en `!res.ok` ⇒ `no-consultado` ⇒ la tarjeta dice "no pudimos consultar el catálogo" sobre una
    // capacidad que SÍ tiene agente. No falla: miente.
    for (const u of todas) {
      expect(u).not.toContain("allow_trial");
      expect(u).not.toContain("allow-trial");
    }
  });

  // T-14.3 — el piso sale de la CONSTANTE, no de un número escrito a mano.
  it("T-14.3: el piso de cada query es la constante importada, no un 2 escrito a mano", async () => {
    const { fx, payout } = await queriesDeUnPlan();
    expect(payout.searchParams.get("min_reputation")).toBe(String(PAYOUT_MIN_REPUTATION));
    expect(fx.searchParams.get("min_reputation")).toBe(String(FX_MIN_REPUTATION));
  });

  // 🔴 LA MITAD ESTÁTICA DE T-14.3, Y NO ES ADORNO: SIN ELLA EL MUTANTE M5 SOBREVIVE. MEDIDO.
  //
  // Reemplacé en la route los dos `FX_MIN_REPUTATION` / `PAYOUT_MIN_REPUTATION` por un `2` escrito a
  // mano, corrí la suite COMPLETA y dio 1570 passed / 0 failed. La comparación de valores de acá
  // arriba no puede matarlo, y el motivo es aritmético: hoy las dos constantes VALEN 2, así que el
  // literal produce exactamente la misma query. El mutante no es equivalente —se vuelve visible el
  // día que alguien mueva un piso— pero ese día es justo el que ningún test de valor puede anticipar.
  //
  // Lo que se puede verificar hoy es el ACOPLAMIENTO, que es lo que la HU pide: que el número de la
  // query venga del mismo lugar que el de la ejecución. Eso es una propiedad del texto del módulo, y
  // por eso se lee el archivo. Sin esto, "el piso sale de la constante" sería una afirmación sobre el
  // código que ningún input pone en rojo.
  it("T-14.3 (estático): la route IMPORTA los pisos y no escribe ningún número de piso a mano", () => {
    const fuente = readFileSync(
      path.resolve(process.cwd(), "app/api/a2a/plan/route.ts"),
      "utf8",
    );
    expect(fuente).toContain("FX_MIN_REPUTATION");
    expect(fuente).toContain("PAYOUT_MIN_REPUTATION");
    // Y el piso de cada leg se ARMA con el identificador, no con un literal. `minReputation: 2` acá
    // sería el mutante M5, y esta línea es la que lo mata.
    expect(fuente).toContain("minReputation: FX_MIN_REPUTATION");
    expect(fuente).toContain("minReputation: PAYOUT_MIN_REPUTATION");
    expect(fuente).not.toMatch(/minReputation:\s*\d/);
    // 🔴 AR/MNR-1 — Y EL OTRO SITIO, QUE ESTE MISMO TEST NO MIRABA. Las dos líneas de arriba vigilan
    // `LegConstraints`; la query la ARMA `buildDiscoverUrl`, que es otro lugar y admite su propio
    // literal. El mutante que sobrevivía (M5b), MEDIDO: reemplazar en `buildDiscoverUrl` el
    // `String(c.minReputation)` por un `"2"` entre comillas deja los dos `toContain` de arriba en
    // verde (los identificadores siguen apareciendo en `LegConstraints`), la comparación de valores
    // también (las constantes VALEN 2 hoy), y la query sale igual. O sea: el acoplamiento se rompía
    // y ningún test lo veía. Estas dos líneas lo cierran en el sitio donde el número se escribe.
    expect(fuente).toContain("min_reputation: String(c.minReputation)");
    expect(fuente).not.toMatch(/min_reputation:\s*["'`]?\d/);
  });

  it("y las constraints con las que se preguntó VIAJAN en la respuesta, para que la tarjeta las pueda afirmar", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    stubCatalog({ "remittance-fx-quote": [card("fx", 0.03)] });
    const body = (await (await GET()).json()) as {
      steps: Array<{ constraints: { minReputation: number; allowTrial?: true } }>;
    };
    // "bajo el piso de este paso" tiene que ser falsable mirando la respuesta, no leyendo el código.
    expect(body.steps[0]?.constraints).toEqual({
      minReputation: FX_MIN_REPUTATION,
      allowTrial: true,
    });
    expect(body.steps[1]?.constraints).toEqual({ minReputation: PAYOUT_MIN_REPUTATION });
  });
});

// ── CD-18 · "no pudimos preguntar" NO es "no hay nadie" ──────────────────────────────────────────
//
// 🔴 Los cuatro desenlaces de `discoverFor` colapsaban en `agent: null`, y la pantalla afirmaba UNO
// de los cuatro: "El catálogo no ofrece a nadie para esta capacidad ahora mismo". Tres de esas cuatro
// salidas no dicen NADA sobre el catálogo: un 500, un body ilegible y un timeout de red nuestro.
//
// CD-17: mismo `afterEach` que arriba. Los `it` que stubean un `fetch` que TIRA dependen de que el
// `unstubAllGlobals` lo saque, o el siguiente archivo de la suite hereda un fetch roto.
describe("GET /api/a2a/plan — los tres estados de disponibilidad (AC-14 / CD-18)", () => {
  // T-14.4
  it("T-14.4: 200 con agente ⇒ `ofrecido`", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    stubCatalog({ "remittance-fx-quote": [card("fx", 0.03)] });
    const body = (await (await GET()).json()) as {
      steps: Array<{ availability: string; agent: unknown }>;
    };
    expect(body.steps[0]?.availability).toBe("ofrecido");
    expect(body.steps[0]?.agent).not.toBeNull();
  });

  it("T-14.4: 200 con `agents: []` ⇒ `sin-candidatos` — el catálogo CONTESTÓ que no hay nadie", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    stubCatalog({}); // stubCatalog devuelve `{agents: []}` con status 200 para toda capacidad
    const body = (await (await GET()).json()) as {
      steps: Array<{ availability: string; agent: unknown }>;
    };
    expect(body.steps.map((s) => s.availability)).toEqual(["sin-candidatos", "sin-candidatos"]);
    expect(body.steps.every((s) => s.agent === null)).toBe(true);
  });

  it("T-14.4: status 400 ⇒ `no-consultado`, NO `sin-candidatos` (es el caso del typo en un parámetro)", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "UNKNOWN_DISCOVER_PARAM" }), { status: 400 }),
      ),
    );
    const body = (await (await GET()).json()) as { steps: Array<{ availability: string }> };
    expect(body.steps.map((s) => s.availability)).toEqual(["no-consultado", "no-consultado"]);
  });

  it("T-14.4: un `fetch` que TIRA (red nuestra, timeout) ⇒ `no-consultado`", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ETIMEDOUT");
      }),
    );
    const body = (await (await GET()).json()) as { steps: Array<{ availability: string }> };
    // Una caída de red NUESTRA no es una afirmación sobre el catálogo. Es la clase de error que este
    // repo tiene escrita como lección: "no pude preguntar" no es "no pasó".
    expect(body.steps.map((s) => s.availability)).toEqual(["no-consultado", "no-consultado"]);
  });

  it("T-14.4: un body 200 ILEGIBLE ⇒ `no-consultado` (200 no alcanza: hay que entender la respuesta)", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ agents: "no soy una lista" }), { status: 200 })),
    );
    const body = (await (await GET()).json()) as { steps: Array<{ availability: string }> };
    expect(body.steps.map((s) => s.availability)).toEqual(["no-consultado", "no-consultado"]);
  });

  // 🔴 EL `it` QUE MATA AL MUTANTE M4. Los dos casos comparados ENTRE SÍ en el mismo test: uno que
  // sólo mire el caso nuevo no prueba que los dos estados se distingan, y colapsarlos lo dejaría
  // verde. Este se pone rojo con cualquier colapso, en cualquiera de las dos direcciones.
  it("T-14.4: `sin-candidatos` y `no-consultado` son estados DISTINTOS, comparados en el mismo test", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    stubCatalog({});
    const vacio = (await (await GET()).json()) as { steps: Array<{ availability: string }> };

    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const caido = (await (await GET()).json()) as { steps: Array<{ availability: string }> };

    expect(vacio.steps[0]?.availability).toBe("sin-candidatos");
    expect(caido.steps[0]?.availability).toBe("no-consultado");
    expect(vacio.steps[0]?.availability).not.toBe(caido.steps[0]?.availability);
  });
});
