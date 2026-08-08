import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_AGENT_REASONS_MEANING_NOBODY } from "../../../../src/application/agent-rejections";
import { POST } from "./route";

function req(payload: unknown): Request {
  return new Request("http://localhost/api/a2a/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const validResult = {
  quoteId: "cfx-1",
  rate: 3.7,
  feeUsd: 0.5,
  netDeliveredLocal: 1478.15,
  etaMinutes: 30,
  expiresAt: "2026-07-09T18:10:00.000Z",
  provenance: "fx-quote-provider",
};

afterEach(() => vi.restoreAllMocks());

// 🔴 ACÁ VIVÍAN LOS 15 TESTS DEL CARRIL PUNTO A PUNTO, Y MURIERON CON ÉL (WKH-332/W3).
//
// Eran dos `describe`: "proxy server-only al agente <slug>" (7 `it`) y "rechazo del agente ≠ agente
// caído (hallazgo #75)" (8 `it`, contando el `it.each` de 8 statuses como uno). LOS DOS ejercitaban
// el `fetch({base}/api/agents/<slug>/invoke)` que esta HU borró, así que no hay forma de portarlos:
// no queda ninguna respuesta HTTP de un agente que la route lea. Lo que probaban, y dónde quedó:
//
//  · "sin la base de los agentes → 501": el 501 sigue existiendo y ahora lo produce la config que de
//    verdad se usa. Lo cubre "gateway not_configured (falta WASIAI_A2A_GATEWAY_URL) ⇒ 501, sin fetch".
//  · "la URL sale de la MISMA constante que el preview publica": no hay constante ni URL con un
//    nombre adentro. Lo que la reemplaza es un candado ESTÁTICO, no un `it`:
//    `src/composition/agent-slug-residue.static.test.ts` (T-2.1).
//  · shape inválido / expiresAt no-parseable / fetch que tira: sobreviven enteros en el describe del
//    gateway ("gateway shape inválido ⇒ 502 a2a_bad_shape", "/compose inalcanzable (throw) ⇒ 502").
//  · 🔴 EL HALLAZGO #75 DEL LADO DE FX SE PIERDE, Y VA DECLARADO, NO DISIMULADO. Distinguir "el
//    agente rechazó el monto" de "el agente se cayó" exigía leer su `400 fx_amount_below_minimum`, y
//    por `/compose` ese enum NO LLEGA: el step fallado viaja sin `code` y sin `reason`. Es la
//    regresión de AC-4, declarada NO CUMPLIDA por decisión del founder, con `WKH-335` abierta en
//    `wasiai-a2a` para que el desenlace vuelva a llegar estructural. El candado que deja escrito que
//    el copy YA NO promete distinguir la causa es T-4.1', en `src/presentation/flow-vm.test.ts`.


// ─────────────────────────────────────────────────────────────────────────────
// WKH-218 + WKH-304 — modo de transporte "a2a-gateway": el quote se pide por CAPACIDAD a
// POST /compose y el gateway resuelve. Ya NO hay /discover ni slug esperado: los tests que
// asertaban la llamada a /discover se portaron al contrato nuevo (no se borró ningún caso).
// ─────────────────────────────────────────────────────────────────────────────
const GW = "https://gateway.example.com";
const KEY = "ak_secret";
const composeOk = { success: true, steps: [{ output: validResult }] };

/** Router que separa la llamada al gateway (/compose) del fetch DIRECTO al agente.
 *  directCalls > 0 ⇒ hubo fallback punto-a-punto (prohibido, CD-1). */
function gwRouter(
  opts: {
    compose?: () => unknown;
    status?: number;
    composeThrows?: boolean;
    captureCompose?: (init?: RequestInit) => void;
  } = {},
) {
  const directCalls: string[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/compose")) {
      if (opts.composeThrows) throw new Error("network");
      opts.captureCompose?.(init);
      const status = opts.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => opts.compose?.() ?? composeOk,
      };
    }
    directCalls.push(url); // cualquier URL que no sea /compose — con W3 ya no debería existir ninguna
    return { ok: true, status: 200, json: async () => ({ result: validResult }) };
  });
  return { fn, directCalls };
}

describe("POST /api/a2a/quote — modo a2a-gateway (WKH-218 / WKH-304)", () => {
  function setGatewayEnv() {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gateway");
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", GW);
    vi.stubEnv("WASIAI_A2A_AGENT_KEY", KEY);
    // 🔴 ACÁ SE STUBEABA TAMBIÉN LA BASE DE LOS AGENTES, "seteada pero que el gateway no debe usar".
    // Ya no hay nada que no usar: la env se borró del código en W3 y ningún test de este archivo la
    // stubea. Que los 16 `it` pasen sin ella es la evidencia de runtime de que la route no la lee.
  }

  // (portado del caso "AC-1: /discover + /compose") — ahora el único request es /compose y lo que
  // viaja es la CAPACIDAD, no un nombre de agente.
  it("AC-1: gateway → ÚNICO fetch a {GW}/compose con la capability (cero /discover, cero /api/agents/)", async () => {
    setGatewayEnv();
    // Ausencia REAL de la env (stubEnv(…, undefined) la BORRA) ⇒ default del código (CD-14). Ojo:
    // el `??` de la route sólo cae al default con la env ausente, no con la env en "" — por eso el
    // stub es undefined y no "" (y por eso el test es determinista aunque la shell la exporte).
    vi.stubEnv("WASIAI_A2A_FX_CAPABILITY", undefined);
    let composeInit: RequestInit | undefined;
    const { fn, directCalls } = gwRouter({ captureCompose: (init) => (composeInit = init) });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: validResult });

    const urls = fn.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual([`${GW}/compose`]);
    expect(urls.some((u) => u.includes("/discover"))).toBe(false);
    expect(directCalls).toHaveLength(0); // CD-1: jamás el punto-a-punto

    const step = JSON.parse(composeInit!.body as string).steps[0];
    expect(step.capability).toBe("remittance-fx-quote"); // el default REAL del catálogo (M8)
    expect(step).not.toHaveProperty("agent"); // M5: nunca el nombre del agente
    // WKH-313: el leg de FX pide el carril de estreno, y el piso viaja CON él. `allow_trial` solo
    // seria letra muerta: el gateway solo lo lee dentro del bloque de `min_reputation`.
    expect(step.constraints).toEqual({ min_reputation: 2, allow_trial: true });
    expect(step.input).toEqual({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" });
  });

  // Trazabilidad: el gateway dice a quién eligió y hasta ahora la respuesta lo tiraba. Si mañana el
  // descubrimiento puede traer cualquier agente, no poder decir CUÁL cotizó es no tener traza.
  it("el 200 informa QUÉ agente cotizó (slug/registry/capability/carril), sin URL ni PII", async () => {
    setGatewayEnv();
    const { fn } = gwRouter({
      compose: () => ({
        success: true,
        steps: [
          {
            output: validResult,
            agent: {
              slug: "fx-provider-elegido-por-el-gateway",
              registry: "WasiAI",
              invokeUrl: "https://interno.example.com/invoke", // NO debe salir
              trial: { granted: true, under_min_reputation: 2 },
            },
            resolvedFrom: { capability: "remittance-fx-quote" },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" }));

    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("interno.example.com");
    expect(JSON.parse(raw)).toEqual({
      result: validResult,
      agent: {
        slug: "fx-provider-elegido-por-el-gateway",
        registry: "WasiAI",
        capability: "remittance-fx-quote",
        trial: true,
      },
    });
  });

  // Un agente ilegible no rompe la cotización: la clave simplemente no viaja y quien la lea sabe
  // que no sabemos. Lo prohibido es fabricar un agente para llenar el campo.
  it("agente ilegible ⇒ el 200 NO trae la clave agent (y el quote sigue siendo válido)", async () => {
    setGatewayEnv();
    const { fn } = gwRouter({
      compose: () => ({ success: true, steps: [{ output: validResult, agent: { registry: "X" } }] }),
    });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ amountUsd: 400 }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: validResult });
  });

  it("WASIAI_A2A_FX_CAPABILITY override manda sobre el default del código", async () => {
    setGatewayEnv();
    vi.stubEnv("WASIAI_A2A_FX_CAPABILITY", "remittance-fx-quote-v2");
    let composeInit: RequestInit | undefined;
    const { fn } = gwRouter({ captureCompose: (init) => (composeInit = init) });
    vi.stubGlobal("fetch", fn);
    await POST(req({ amountUsd: 400 }));
    expect(JSON.parse(composeInit!.body as string).steps[0].capability).toBe(
      "remittance-fx-quote-v2",
    );
  });

  // (portado de "/discover inalcanzable ⇒ 502")
  it("AC-4/fail-closed: /compose inalcanzable (throw) ⇒ 502 a2a_unavailable; cero punto-a-punto", async () => {
    setGatewayEnv();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fn, directCalls } = gwRouter({ composeThrows: true });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_unavailable" });
    expect(directCalls).toHaveLength(0);
  });

  // (portado de "/discover agents:[] (vacío) ⇒ 502") — el vacío del discover ya no existe: hoy el
  // "no hay agente para esa capacidad" es un 422 no_agent_match del gateway, y sigue sin fallback.
  // 🔴 T-13.2 (WKH-332/AC-13) — ESTE CASO CAMBIÓ DE VEREDICTO, Y LA RAZÓN VA ESCRITA.
  //
  // Hasta acá este `it` clavaba `502 a2a_unavailable`, o sea que "ninguna capacidad resolvió" salía
  // con las palabras de una caída y la pantalla invitaba a reintentar. Reintentar no crea un agente:
  // la misma llamada, un segundo después, vuelve a no encontrar a nadie. Ahora sale 422 con enum
  // PROPIO. Lo que NO cambió, y por eso se conserva línea por línea abajo: el body sigue teniendo
  // exactamente una clave, sigue sin haber ningún fetch punto-a-punto, y el `message` del gateway
  // sigue sin loguearse. Un enum nuestro no es un eco del gateway (CD-5).
  it("T-13.2/AC-13: 422 no_agent_match ⇒ 422 con enum PROPIO, cero punto-a-punto, y el detalle SÓLO al log", async () => {
    setGatewayEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fn, directCalls } = gwRouter({
      status: 422,
      compose: () => ({
        error: "no agent matched capability remittance-fx-quote",
        code: "no_agent_match",
        reason: "no_candidates",
        step: 0,
      }),
    });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json).toEqual({ error: "a2a_no_agent_for_capability" });
    expect(Object.keys(json)).toEqual(["error"]); // CD-8: cero eco del gateway en el body
    expect(directCalls).toHaveLength(0); // cero fallback silencioso
    // CD-9/AC-2: el operador SÍ puede distinguir "no hay agente" de "gateway caído", pero por log.
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain("no_agent_match");
    expect(logged).toContain("no_candidates");
    expect(logged).not.toContain("no agent matched capability"); // el message del gateway NO se loguea
  });

  // 🔴 LOS DOS DESENLACES EN EL MISMO `it`, COMPARADOS ENTRE SÍ. Un test que sólo mire el caso nuevo
  // no prueba que se DISTINGAN: pasaría igual con los dos mapeados al mismo enum. Lo que AC-13 pide
  // no es que exista un 422, es que "no hay quién" y "el otro lado se cayó" dejen de decirse igual.
  it("T-13.2/AC-13: no_agent_match y una caída del gateway NO comparten ni status ni enum", async () => {
    setGatewayEnv();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const sinAgente = gwRouter({
      status: 422,
      compose: () => ({ code: "no_agent_match", reason: "no_candidates", step: 0 }),
    });
    vi.stubGlobal("fetch", sinAgente.fn);
    const resSinAgente = await POST(req({ amountUsd: 400 }));
    const jsonSinAgente = await resSinAgente.json();

    // 503 del gateway ⇒ `unavailable` en el cliente ⇒ el 502 de siempre, INTACTO (CD-22: sólo se
    // abrió `no_agent_match`; `payment_required` y el resto siguen colapsados).
    const caido = gwRouter({ status: 503, compose: () => ({ code: "unavailable" }) });
    vi.stubGlobal("fetch", caido.fn);
    const resCaido = await POST(req({ amountUsd: 400 }));
    const jsonCaido = await resCaido.json();

    expect(resSinAgente.status).toBe(422);
    expect(jsonSinAgente).toEqual({ error: "a2a_no_agent_for_capability" });
    expect(resCaido.status).toBe(502);
    expect(jsonCaido).toEqual({ error: "a2a_unavailable" });
    // La comparación explícita: el mutante que mapee los dos al mismo lado muere acá.
    expect(resSinAgente.status).not.toBe(resCaido.status);
    expect(jsonSinAgente.error).not.toBe(jsonCaido.error);
    expect(sinAgente.directCalls).toHaveLength(0);
    expect(caido.directCalls).toHaveLength(0);
  });

  // T-13.5 (AR fix-pack BLQ-MED-1) — el leg de FX, mismo agujero: el 422 no es un solo desenlace.
  //
  // `reputation_unavailable` es "el gateway no pudo leer el historial" (MEDIDO en
  // `wasiai-a2a/src/services/capability-resolver.ts`), no "no hay nadie". El copy del enum nuevo dice
  // "no hay ningún proveedor que pueda cotizar" y "volver a intentar no cambia el resultado": las dos
  // mitades son falsas para ese motivo, y la segunda desaconseja el reintento que sí puede servir.
  // El 502 genérico ("Algo salió mal, probá de nuevo") es vago y CIERTO, así que ahí vuelve.
  it("T-13.5/AR: `reputation_unavailable` NO sale como 'no hay proveedor' — vuelve al 502 genérico", async () => {
    setGatewayEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const nadie = gwRouter({
      status: 422,
      compose: () => ({ code: "no_agent_match", reason: "no_candidates", step: 0 }),
    });
    vi.stubGlobal("fetch", nadie.fn);
    const resNadie = await POST(req({ amountUsd: 400 }));
    const jsonNadie = await resNadie.json();

    // Mismo status, mismo `code`, otro `reason`: lo único que cambia es lo que el gateway SABE.
    const noSabe = gwRouter({
      status: 422,
      compose: () => ({ code: "no_agent_match", reason: "reputation_unavailable", step: 0 }),
    });
    vi.stubGlobal("fetch", noSabe.fn);
    const resNoSabe = await POST(req({ amountUsd: 400 }));
    const jsonNoSabe = await resNoSabe.json();

    expect(resNadie.status).toBe(422);
    expect(jsonNadie).toEqual({ error: "a2a_no_agent_for_capability" });
    expect(resNoSabe.status).toBe(502);
    expect(jsonNoSabe).toEqual({ error: "a2a_unavailable" });
    expect(resNadie.status).not.toBe(resNoSabe.status);

    // Un 422 sin `reason` tampoco habilita la afirmación fuerte.
    const mudo = gwRouter({ status: 422, compose: () => ({ code: "no_agent_match", step: 0 }) });
    vi.stubGlobal("fetch", mudo.fn);
    expect((await POST(req({ amountUsd: 400 }))).status).toBe(502);

    // CD-5/CD-8: se ramificó por el `reason` y NO se ecoó. Al log sí va, que es donde el operador lo
    // necesita para saber que el problema no está en el catálogo.
    expect(Object.keys(jsonNoSabe)).toEqual(["error"]);
    expect(JSON.stringify(jsonNoSabe)).not.toContain("reputation");
    expect(JSON.stringify(warn.mock.calls)).toContain("reputation_unavailable");
    expect(noSabe.directCalls).toHaveLength(0);
  });

  // T-13.6 (CR/BLQ-MED-2) — LOS TRES VALORES DE LA ALLOWLIST, EJERCITADOS CONTRA LA ROUTE.
  //
  // Los dos `it` de arriba usan `no_candidates` y nada más. `excluded_by_scope` y
  // `excluded_by_reputation` estaban en la constante y no los ejercitaba ninguna route: cada uno de
  // ellos SÍ tiene que salir por el enum de AC-13, y `excluded_by_reputation` es el 422 más probable
  // en producción con los pisos de reputación en 2.
  //
  // Se recorre la CONSTANTE, no una lista copiada: un valor nuevo entra a este `each` solo. Lo que
  // este `each` NO puede ver es el BORRADO de un valor (deja de correrse y sigue verde); eso lo mata
  // la tabla del universo en `src/application/agent-rejections.test.ts`.
  it.each(NO_AGENT_REASONS_MEANING_NOBODY)(
    "T-13.6/AC-13: el 422 con reason '%s' sale por el enum propio, no por el de caída",
    async (reason) => {
      setGatewayEnv();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { fn, directCalls } = gwRouter({
        status: 422,
        compose: () => ({ code: "no_agent_match", reason, step: 0 }),
      });
      vi.stubGlobal("fetch", fn);

      const res = await POST(req({ amountUsd: 400 }));
      const json = await res.json();

      expect(res.status).toBe(422);
      expect(json).toEqual({ error: "a2a_no_agent_for_capability" });
      expect(Object.keys(json)).toEqual(["error"]); // CD-8: cero eco del gateway en el body
      expect(JSON.stringify(json)).not.toContain(reason); // se ramifica por el reason, no se ecoa
      expect(directCalls).toHaveLength(0);
    },
  );

  it("gateway not_configured (falta WASIAI_A2A_GATEWAY_URL) ⇒ 501, sin fetch", async () => {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gateway");
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", "");
    vi.stubEnv("WASIAI_A2A_AGENT_KEY", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "a2a_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // R-1 hecho test: sin expectedSlug puede ganar OTRO agente el ranking. Lo que protege NO es el
  // nombre del agente, es el shape: un quote que no valida corta con 502 antes de llegar al cliente.
  it("gateway shape inválido (compose output no-quote) ⇒ 502 a2a_bad_shape", async () => {
    setGatewayEnv();
    const { fn } = gwRouter({ compose: () => ({ success: true, steps: [{ output: { quoteId: "x" } }] }) });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_bad_shape" });
  });

  // T-1.1 (WKH-332/AC-1) — EL CANDADO DEL TRANSPORTE ÚNICO.
  //
  // 🔴 QUÉ REEMPLAZA, Y POR QUÉ NO ES EL MISMO TEST CON OTRO NOMBRE. Acá había dos `it` que asertaban
  // lo CONTRARIO: "flag='a2a' ⇒ punto-a-punto byte-idéntico" y T-A4.1 "flag=fallback|a2a|ausente ⇒ el
  // gateway se IGNORA y se hace el fetch al agente por su slug". Los dos clavaban que existiera un
  // segundo transporte alcanzable por una env, que es exactamente lo que esta HU borró: portarlos
  // habría sido conservar el invariante viejo. Se invierten, y el eje que sobrevive es el que importa:
  // NINGÚN valor de la bandera produce un fetch a un agente por su nombre.
  //
  // Que `directCalls` sea 0 no es una tautología del router: `gwRouter` empuja a `directCalls` TODA
  // URL que no contenga "/compose", así que un fetch a cualquier otra parte lo pondría rojo.
  //
  // ⚠️ `"a2a"` NO está en esta lista, y no por olvido: post-W3 ese valor ni siquiera llega a la route
  // —`createContainer()` tira antes—, y esta route ya no lee la bandera. Su caso vive donde importa:
  // `src/composition/value-delivery-adapter.test.ts` y `src/composition/container.test.ts`.
  it.each(["a2a-gateway", "fallback", undefined])(
    "T-1.1: con la bandera en %s el ÚNICO fetch es {GW}/compose — cero /api/agents/",
    async (flag) => {
      if (flag === undefined) vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", undefined as unknown as string);
      else vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", flag);
      vi.stubEnv("WASIAI_A2A_GATEWAY_URL", GW);
      vi.stubEnv("WASIAI_A2A_AGENT_KEY", KEY);
      const { fn, directCalls } = gwRouter({});
      vi.stubGlobal("fetch", fn);
      const res = await POST(req({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" }));
      expect(res.status).toBe(200);
      const urls = fn.mock.calls.map((c) => c[0] as string);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain("/compose");
      expect(directCalls).toHaveLength(0);
      // El eje de AC-1 dicho como texto: la subcadena del carril viejo no aparece en NINGUNA URL.
      expect(urls.some((u) => u.includes("/api/agents/"))).toBe(false);
    },
  );
});
