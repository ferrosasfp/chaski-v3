import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FX_DIRECT_AGENT_SLUG,
  PAYOUT_DIRECT_AGENT_SLUG,
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

  it("declara el transporte REAL: con el carril apagado dice punto-a-punto", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "fallback");
    stubCatalog({ "remittance-fx-quote": [card("fx", 0.03)] });
    const off = (await (await GET()).json()) as { steps: Array<{ transport: string }> };
    // Con la bandera apagada la app llama a su agente directo, que puede ser OTRO. Afirmar que lo
    // elige el catálogo sería una pantalla que mide una cosa y afirma otra.
    expect(off.steps.every((s) => s.transport === "punto-a-punto")).toBe(true);

    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gateway");
    stubCatalog({ "remittance-fx-quote": [card("fx", 0.03)] });
    const on = (await (await GET()).json()) as { steps: Array<{ transport: string }> };
    expect(on.steps.every((s) => s.transport === "gateway")).toBe(true);
  });
});

// ── Quién corre hoy, no sólo por dónde ───────────────────────────────────────────────────────────
//
// 🔴 EL BUG MEDIDO (producción, 2026-08-05): este endpoint devolvía `remit-corridor-fx-solana` y
// `remit-cashout-payout-solana`, y la tarjeta los mostraba con "hoy se llama directo". Pero
// `POST /api/a2a/quote` contestaba `result.slug = "remit-corridor-fx"`, y `payout/prepare` llama a
// `remit-cashout-payout`. Son slugs distintos: la pantalla nombraba a quien NO corre.
describe("GET /api/a2a/plan — quién corre hoy cada paso", () => {
  it("en punto-a-punto declara el slug REAL que las rutas invocan, no el del catálogo", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "fallback");
    // Exactamente lo que devuelve el catálogo en vivo, con el sufijo `-solana`.
    stubCatalog({
      "remittance-fx-quote": [card("remit-corridor-fx-solana", 0.03)],
      "remittance-payout": [card("remit-cashout-payout-solana", 0.03)],
    });

    const body = (await (await GET()).json()) as {
      steps: Array<{ agent: { id: string } | null; runsTodayAgentId: string | null }>;
    };

    // El slug sale de la MISMA constante que el `fetch` de cada route usa.
    expect(body.steps[0]?.runsTodayAgentId).toBe(FX_DIRECT_AGENT_SLUG);
    expect(body.steps[1]?.runsTodayAgentId).toBe(PAYOUT_DIRECT_AGENT_SLUG);
    // Y la divergencia, que es el hecho que la pantalla tiene que poder decir.
    expect(body.steps[0]?.runsTodayAgentId).not.toBe(body.steps[0]?.agent?.id);
    expect(body.steps[1]?.runsTodayAgentId).not.toBe(body.steps[1]?.agent?.id);
  });

  // En el carril del gateway NO se llama a ningún slug: se pide la capacidad y el gateway resuelve al
  // ejecutar. Rellenar el campo con el `agent.id` sería el mismo bug al revés.
  it("en el carril del gateway NO nombra a nadie: ahí se elige al ejecutar", async () => {
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", BASE);
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gateway");
    stubCatalog({
      "remittance-fx-quote": [card("remit-corridor-fx-solana", 0.03)],
      "remittance-payout": [card("remit-cashout-payout-solana", 0.03)],
    });

    const body = (await (await GET()).json()) as {
      steps: Array<{ runsTodayAgentId: string | null }>;
    };
    expect(body.steps.every((s) => s.runsTodayAgentId === null)).toBe(true);
  });
});
