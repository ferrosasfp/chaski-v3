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
  //
  // 🔴 Y EL EJE DEL TEST SÍ CAMBIÓ, EN WKH-336. Acá decía *"el eje del test NO cambia"*, y dejó de ser
  // cierto: este `it` variaba UNA env (el adapter) y miraba los dos pasos con un `.every()`. Ahora hay
  // DOS ejes —el adapter y `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED`— y la granularidad es POR PASO, porque
  // cada leg deriva su transporte de SU propia bandera. La matriz completa de los dos ejes vive en el
  // `describe` del final del archivo (T-336.1…4); acá queda el caso que compara los DOS valores del
  // campo en la MISMA corrida, que es el eje que sí valía y que NO se pierde.
  //
  // ⚠️ LA REESCRITURA NO ES UNA RELAJACIÓN, Y ES VERIFICABLE RENGLÓN POR RENGLÓN: el kill-set nuevo
  // contiene al viejo y le suma cuatro mutantes.
  //
  //   | Mutante en `plan/route.ts`                                  | ¿lo mataba el viejo? | ¿el nuevo? |
  //   | M1 `transport` clavado en `"gateway"` para los dos           | sí                   | sí (T-336.2, T-336.5) |
  //   | M2 `transport` clavado en `"demo"` para los dos              | sí                   | sí (T-336.1, T-336.3) |
  //   | M3 mapeo del adapter invertido                               | sí                   | sí (T-336.3, T-336.5) |
  //   | M4 los DOS legs derivan del ADAPTER (= el defecto de WKH-336)| NO — era el verde    | sí (T-336.1) |
  //   | M5 los DOS legs derivan del SETTLE                           | sí                   | sí (T-336.3) |
  //   | M6 el leg de entrega usa truthiness / `!== "false"`          | NO — nunca variaba el settle | sí (T-336.2: `"false"`, `"1"`) |
  //   | M7 el leg de entrega compara case-insensitive                | NO                   | sí (T-336.2: `"TRUE"`) |
  //   | M8 se vuelve a colapsar en un solo `transport` compartido    | NO — `.every()` es ciego a eso | sí (T-336.1, T-336.5, per-step) |
  //
  // El paréntesis de abajo —*"la ENTREGA no la decide esta bandera"*— era un comentario y pasó a ser
  // un hecho verificado: lo mide T-336.1.
  it("T-336.5: el adapter mueve la COTIZACIÓN y no la entrega, con los dos valores en la MISMA corrida", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "fallback");
    // CD-12: las DOS envs se fijan explícitamente. `undefined as unknown as string` BORRA la env, que
    // es la ausencia real; `""` sería *presente y vacía* y es otro caso (T-336.2 lo cubre aparte).
    vi.stubEnv("NEXT_PUBLIC_SOLANA_SETTLE_ENABLED", undefined as unknown as string);
    stubCatalog({ "remittance-fx-quote": [card("fx", 0.03)] });
    const off = (await (await GET()).json()) as { steps: Array<{ transport: string }> };
    // Con el adapter en "fallback" la cotización la arma un simulador del container: decir "gateway"
    // ahí sería una pantalla que mide una cosa y afirma otra. La ENTREGA no la decide esta bandera —
    // la decide el settle, y acá está ausente, así que también cae en "demo", por OTRO motivo.
    expect(off.steps[0]?.transport).toBe("demo");
    expect(off.steps[1]?.transport).toBe("demo");
    // Y el valor del carril borrado no puede volver por ninguna puerta.
    expect(JSON.stringify(off)).not.toContain("punto-a-punto");

    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gateway");
    stubCatalog({ "remittance-fx-quote": [card("fx", 0.03)] });
    const on = (await (await GET()).json()) as { steps: Array<{ transport: string }> };
    // El adapter movió SÓLO la cotización: el settle sigue ausente y la entrega sigue en "demo". Si
    // alguien volviera a pegar un valor único a los dos pasos (M8), la segunda línea se pone roja.
    expect(on.steps[0]?.transport).toBe("gateway");
    expect(on.steps[1]?.transport).toBe("demo");
  });

  // La env AUSENTE cae del lado del demo, igual que en el container (`resolveValueDeliveryAdapter`
  // traduce `undefined` a `"fallback"`). Sin este caso, un deployment sin la env vería la tarjeta
  // afirmando que el paso corre por el gateway mientras un simulador local cotiza. Se mira POR PASO
  // (CD-4): un `.every()` acá no distinguiría "los dos comparten valor" de "cada uno deriva del suyo".
  it("las DOS banderas ausentes dicen demo en los DOS pasos, no gateway", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", undefined as unknown as string);
    vi.stubEnv("NEXT_PUBLIC_SOLANA_SETTLE_ENABLED", undefined as unknown as string);
    stubCatalog({ "remittance-fx-quote": [card("fx", 0.03)] });
    const body = (await (await GET()).json()) as { steps: Array<{ transport: string }> };
    expect(body.steps[0]?.transport).toBe("demo");
    expect(body.steps[1]?.transport).toBe("demo");
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

  // 🔴 T-336.6 (estático) — UNA COPY DE USUARIO SOSTIENE UNA DECISIÓN DE LÓGICA, Y NADA LAS ATABA.
  //
  // `flow.tsx` elige entre las dos notas de precio buscando el paso de la cotización POR SU `label`
  // (`FX_STEP_LABEL`), porque la `capability` sale de una env overrideable y no sirve de llave. O sea
  // que un string de copy EN ESPAÑOL decide qué afirma la pantalla sobre quién paga el fee. Las dos
  // copias del literal viven en archivos distintos y **nada las ataba**.
  //
  // ⚠️ EL ROJO SILENCIOSO, MEDIDO (CR/BLQ-MED-1, reproducido en este árbol antes de escribir esto):
  // renombrar el `label` de la route a `"Cotizar el tipo de cambio"` da 5 rojos, y los 5 caen ACÁ
  // (T-336.1 ×3, T-336.3 ×2) — ninguno en `flow.tsx` ni en `agent-plan-card.test.tsx`. Aplicando el
  // arreglo natural y mínimo que haría cualquiera —actualizar los dos `expect(...label)` de este
  // archivo a la copy nueva— la suite vuelve a 102 files / 1630 PASS con `flow.tsx` conservando el
  // literal VIEJO. Y ahí el `find` devuelve `undefined`, la nota se elige por la rama de abajo, y la
  // pantalla vuelve a afirmar de más. Renombrar una copy en español no puede tener ese efecto en una
  // familia de HUs cuyo objeto ES reescribir copy.
  //
  // ⚠️ Y NO ALCANZA CON COMPARAR: si las dos regex dejaran de matchear, `undefined === undefined`
  // pasaría en verde y el candado quedaría aplaudiendo el vacío. Por eso los dos `toBeTypeOf` de
  // antes de la comparación: son la parte que impide que este test se compare consigo mismo.
  //
  // ⚠️ Este candado NO clava la copy: renombrar las DOS a la vez lo deja verde a propósito. Lo que
  // clava es el ACOPLAMIENTO, igual que T-14.3 con los pisos de reputación.
  it("T-336.6 (estático): el `label` del leg de FX es el MISMO literal en la route y en `flow.tsx`", () => {
    const enLaRoute = /capability: fxCapability,\s*\n\s*label: "([^"]+)"/.exec(
      readFileSync(path.resolve(process.cwd(), "app/api/a2a/plan/route.ts"), "utf8"),
    )?.[1];
    const enElCliente = /const FX_STEP_LABEL = "([^"]+)";/.exec(
      readFileSync(path.resolve(process.cwd(), "src/presentation/flow.tsx"), "utf8"),
    )?.[1];
    // Sin estos dos, un cambio de forma (no de valor) dejaría el candado vacío y en verde.
    expect(enLaRoute, "la route ya no declara el `label` del leg de FX donde el candado lo busca").toBeTypeOf("string");
    expect(enElCliente, "`flow.tsx` ya no declara `FX_STEP_LABEL` donde el candado lo busca").toBeTypeOf("string");
    // El invariante: el cliente busca por el MISMO string que el server escribe.
    expect(enElCliente).toBe(enLaRoute);
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

// ── WKH-336 · CADA LEG DERIVA SU TRANSPORTE DE SU PROPIA BANDERA ──────────────────────────────────
//
// 🔴 EL DEFECTO QUE ESTOS `it` MIDEN, Y POR QUÉ NINGÚN TEST ANTERIOR PODÍA VERLO. La route calculaba
// UN `transport` desde `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` y lo pegaba a los DOS pasos. Pero quién
// decide si la ENTREGA la corre un agente real es la OTRA bandera,
// `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` (`solanaSettleOn`, `container.ts:141`): con el settle en
// `"true"` el envío postea a `/api/payout/prepare`, y ese POST compone contra el gateway con
// CUALQUIER valor del adapter (`it.each`, `../../payout/prepare/route.test.ts:1296`). O sea que con
// `settle="true"` + `adapter="fallback"` la fila "Entregar el dinero" decía "modo demo" mientras se
// llamaba a un agente real y se le cobraba.
//
// ⚠️ POR QUÉ NINGÚN ASSERT DE ACÁ USA `.every()` (CD-4). `steps.every((s) => s.transport === X)` no
// puede distinguir *"los dos steps comparten un valor"* de *"cada uno deriva del suyo y hoy
// coinciden"*: es ciego exactamente al defecto que esta HU cierra. Cada assert nombra su índice —
// `steps[0]` = "Cotizar el cambio" (FX), `steps[1]` = "Entregar el dinero" (payout).
//
// ⚠️ LAS DOS ENVS SE STUBEAN EN CADA CASO (CD-12), y `undefined` y `""` son casos DISTINTOS:
// `stubEnv(nombre, undefined as unknown as string)` BORRA la env (ausencia real), mientras `""` es
// *presente y vacía*. Apoyarse en la ausencia por defecto haría que el resultado dependiera de lo que
// la shell exporte (`quote/route.test.ts:97-100` lo documenta medido).
describe("GET /api/a2a/plan — cada leg deriva su transporte de SU bandera (WKH-336)", () => {
  /** Un plan con las DOS envs fijadas explícitamente. `undefined` = env BORRADA (CD-12). */
  async function planCon(adapter: string | undefined, settle: string | undefined) {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", adapter as unknown as string);
    vi.stubEnv("NEXT_PUBLIC_SOLANA_SETTLE_ENABLED", settle as unknown as string);
    stubCatalog({
      "remittance-fx-quote": [card("un-proveedor-de-fx", 0.03)],
      "remittance-payout": [card("un-proveedor-de-payout", 0.03)],
    });
    return (await (await GET()).json()) as {
      steps: Array<{ label: string; transport: string }>;
    };
  }

  // T-336.1 — AC-1. El rojo pre-fix, y es el único `it` de la matriz que mata el defecto de la HU
  // (M4: los DOS legs derivando del adapter). Los dos asserts van en el MISMO `it` a propósito: es lo
  // único que prueba que los legs se DISTINGUEN. Uno que sólo mirara `steps[1]` quedaría verde con un
  // `transport` clavado en `"gateway"` para los dos.
  it.each(["fallback", undefined, ""])(
    "T-336.1: settle=\"true\" + adapter=%s ⇒ la ENTREGA dice gateway y la COTIZACIÓN dice demo",
    async (adapter) => {
      const body = await planCon(adapter, "true");
      expect(body.steps[1]?.label).toBe("Entregar el dinero");
      expect(body.steps[1]?.transport).toBe("gateway");
      expect(body.steps[0]?.label).toBe("Cotizar el cambio");
      expect(body.steps[0]?.transport).toBe("demo");
    },
  );

  // T-336.2 — AC-2. El candado de CD-3: la comparación es `=== "true"` LITERAL, igual que
  // `container.ts:141`. Cada valor de esta lista mata una relajación concreta: `"false"` y `"1"` matan
  // la truthiness (`Boolean(env)`) y el `!== "false"`; `"TRUE"` mata el `.toLowerCase()`. Si el
  // preview entendiera `"TRUE"` como encendido diría que la entrega corre por el gateway mientras
  // `container.ts:141` la deja apagada: la pantalla mediría una cosa y afirmaría otra.
  it.each([
    [undefined, "fallback"],
    [undefined, "a2a-gateway"],
    ["", "fallback"],
    ["", "a2a-gateway"],
    ["false", "fallback"],
    ["false", "a2a-gateway"],
    ["1", "fallback"],
    ["1", "a2a-gateway"],
    ["TRUE", "fallback"],
    ["TRUE", "a2a-gateway"],
  ])("T-336.2: settle=%s (no es \"true\") + adapter=%s ⇒ la ENTREGA dice demo", async (settle, adapter) => {
    const body = await planCon(adapter, settle);
    expect(body.steps[1]?.label).toBe("Entregar el dinero");
    expect(body.steps[1]?.transport).toBe("demo");
  });

  // T-336.3 — AC-3. El leg de la COTIZACIÓN sigue derivando ESTRICTAMENTE del adapter: mata un `&&`
  // de las dos banderas (que apagaría el FX cuando el settle está apagado) y la inversión del mapeo
  // del adapter. El segundo caso además fija el cuadrante nuevo que esta HU vuelve alcanzable:
  // gateway en la cotización y demo en la entrega, en la MISMA respuesta.
  it.each(["true", undefined])(
    "T-336.3: adapter=\"a2a-gateway\" + settle=%s ⇒ la COTIZACIÓN dice gateway igual",
    async (settle) => {
      const body = await planCon("a2a-gateway", settle);
      expect(body.steps[0]?.label).toBe("Cotizar el cambio");
      expect(body.steps[0]?.transport).toBe("gateway");
      if (settle === undefined) expect(body.steps[1]?.transport).toBe("demo");
    },
  );

  // T-336.4 — AC-4. El shape NO cambia: un `transport: "gateway" | "demo"` por paso, sin campos
  // nuevos y sin unión ampliada. Es lo que hace que `flow.tsx` no necesite ningún cambio de lógica de
  // render (`<AgentRunsToday transport={s.transport} />` ya itera por paso). Mata un
  // `transportSource` agregado "para explicar", un tercer valor tipo `"unavailable"` y un `transport`
  // que desaparece de un step.
  it.each([
    ["a2a-gateway", "true"],
    ["a2a-gateway", undefined],
    ["fallback", "true"],
    ["fallback", undefined],
  ])("T-336.4: adapter=%s + settle=%s ⇒ el shape de los DOS steps es el mismo de siempre", async (adapter, settle) => {
    const body = await planCon(adapter, settle);
    const esperado = ["capability", "label", "agent", "availability", "constraints", "transport"];
    expect(Object.keys(body.steps[0] ?? {})).toEqual(esperado);
    expect(Object.keys(body.steps[1] ?? {})).toEqual(esperado);
    expect(["gateway", "demo"]).toContain(body.steps[0]?.transport);
    expect(["gateway", "demo"]).toContain(body.steps[1]?.transport);
  });
});
