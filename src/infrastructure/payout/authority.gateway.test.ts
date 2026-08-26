// T-C5 / T-C5b / T-C7 / T-C9 / T-C10 (WKH-366 · AC-6 / AC-10 / AC-11 / AC-12) — la autoridad de
// payout CON EL TRANSPORTE POR COORDINADOR ENCENDIDO.
//
// 🔴 POR QUÉ ESTOS `it` VIVEN ACÁ Y NO EN `gateway-kyc-client.test.ts`. Lo que WKH-366 tiene que
// demostrar no es que el cliente devuelva `{ok:false}`: es que ese `{ok:false}` **NO AUTORICE UN
// DESEMBOLSO**. Esas son dos afirmaciones distintas y sólo la segunda es la que importa. Un test a
// nivel del cliente puede ser verde con una autoridad que ignore su respuesta.
//
// ⚠️ Este archivo NO reemplaza a `authority.test.ts`: aquél mide el guard-order y los `reason` bajo
// el transporte DIRECTO y sigue corriendo intacto. Acá se enciende la bandera.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// El store del `decisionToken`. HONESTO: aplica el filtro por dueño de verdad. Mismo criterio que
// `authority.test.ts` — un `mockResolvedValue` fijo dejaría sobrevivir la pérdida del filtro, que es
// el IDOR sobre la credencial del desembolso.
const { getTokenStoreMock } = vi.hoisted(() => ({ getTokenStoreMock: vi.fn() }));
vi.mock("../persistence/supabase-kyc-session-tokens", () => ({
  getKycSessionTokenStore: getTokenStoreMock,
}));

// 🔴 POR QUÉ SE DOBLA `canonicalizeAddress`, Y NO ES COMODIDAD (mismo argumento que T-AUTH-7). Con la
// función real, canonicalizar es la IDENTIDAD sobre todo lo que `new PublicKey()` acepta, así que el
// mutante "mandar el claim CRUDO en vez del canonicalizado" daría el mismo byte y T-C10 sería vacuo.
// El doble DELEGA en la función real por default y sólo el `it` de la canonicalización le cambia la
// implementación.
const { canonSpy } = vi.hoisted(() => ({ canonSpy: vi.fn<(a: string) => string>() }));
vi.mock("../address", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../address")>();
  return { ...actual, canonicalizeAddress: (a: string) => canonSpy(a) };
});
const REAL_CANON = (await vi.importActual<typeof import("../address")>("../address"))
  .canonicalizeAddress;

import { resolvePayoutAuthority } from "./authority";

const GATEWAY = "https://gw.test";
const VID = "sess-abc";
const ADDR = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OTHER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN = "k1.token-del-agente";

/** La salida del agente, APROBADA. `payoutAllowed:true` es el único gate del desembolso. */
const AGENTE_SI = {
  terminal: true,
  status: "Approved",
  approved: true,
  riskLevel: "low",
  verificationId: VID,
  provenance: "didit",
  payoutAllowed: true,
  reasons: [],
  identityMatches: true,
};

/**
 * El host del agente según la env del deploy (`KYC_AGENT_BASE_URL`, stubeada en el `beforeEach`).
 * Es el lado derecho de la comparación de N3/parte-B, y el único que un publicador NO puede elegir.
 */
const AGENTE = "https://agentes.test";

/**
 * Quién dijo el Coordinador que ejecutó, cuando el ejecutor es de verdad el nuestro.
 *
 * 🔴 `invokeUrl` NO ES DECORADO (fix-pack AR/BLQ-ALTO-1): el par `(slug, registry)` lo publica
 * cualquier caller autenticado del Coordinador, así que estos dos primeros campos NO distinguen a
 * nuestro agente de un impostor. El que distingue es el tercero, y por eso T-C5c cambia SÓLO ese.
 */
const EJECUTOR_PROPIO = {
  slug: "remit-kyc-decision",
  registry: "self-published",
  invokeUrl: `${AGENTE}/api/agents/remit-kyc-decision/invoke`,
};

/** Orden de EFECTOS observado, para T-C9. Cada doble anota su nombre al ser invocado. */
let orden: string[] = [];
let fetchCalls = 0;

/**
 * Doble del `/compose`. `respuesta` describe qué contesta el gateway; nada más se toca.
 * Devuelve el mock para poder contar llamadas.
 */
function gateway(respuesta: {
  status?: number;
  body?: unknown;
  throws?: boolean;
}): ReturnType<typeof vi.fn> {
  const m = vi.fn(async () => {
    orden.push("fetch");
    fetchCalls += 1;
    if (respuesta.throws) throw new Error("network");
    const status = respuesta.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => respuesta.body ?? {},
    };
  });
  vi.stubGlobal("fetch", m);
  return m;
}

/**
 * Centinela para "el step NO trae la clave `agent`".
 *
 * ⚠️ NO se usa `undefined`, y eso NO es estilo: `compose200(out, undefined)` DISPARA el parámetro por
 * defecto, así que la fila "sin la clave `agent`" terminaba mandando el ejecutor propio y el `it`
 * fallaba por el motivo equivocado. Medido acá mismo antes de escribir esta línea.
 */
const SIN_AGENT = Symbol("sin-agent");

/** Un `/compose` de 200 con un step, su output y su ejecutor. */
function compose200(output: unknown, agent: unknown = EJECUTOR_PROPIO): { body: unknown } {
  const step: Record<string, unknown> = { output };
  if (agent !== SIN_AGENT) step.agent = agent;
  return { body: { success: true, steps: [step] } };
}

/** Store con UNA fila: `(VID, owner)`. El filtro se aplica de verdad. */
function storeConLaFilaDe(sessionId: string, owner: string) {
  const getForOwner = vi.fn(async (s: string, o: string) => {
    orden.push("getForOwner");
    return s === sessionId && o === owner ? TOKEN : null;
  });
  getTokenStoreMock.mockReturnValue({ getForOwner });
  return getForOwner;
}

beforeEach(() => {
  orden = [];
  fetchCalls = 0;
  canonSpy.mockImplementation(REAL_CANON);
  // 🔴 `KYC_AGENT_BASE_URL` SIGUE SIENDO OBLIGATORIA BAJO `gateway` (G-5). El Guard 1 de la autoridad
  // la resuelve ANTES de cualquier transporte, y sin ella el desenlace en prod es 503. Que esté acá
  // no es decorado: es la mitad del interruptor de rollback D-1.
  vi.stubEnv("KYC_AGENT_BASE_URL", AGENTE);
  vi.stubEnv("KYC_AGENT_INVOKE_SECRET", "invoke-secret-de-test");
  vi.stubEnv("WASIAI_A2A_GATEWAY_URL", GATEWAY);
  vi.stubEnv("WASIAI_A2A_AGENT_KEY", "ak_de_test");
  vi.stubEnv("KYC_TRANSPORT", "gateway");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════

describe("T-C5 🔴 AC-6/N3 — un 200 PERFECTAMENTE VÁLIDO de OTRO agente NO autoriza un desembolso", () => {
  // 🧬 EL MUTANTE QUE ESTE `it` EXISTE PARA MATAR: borrar el chequeo de slug de `invocarPineado`.
  // Con el chequeo borrado, esta MISMA respuesta —200, `success:true`, un output de decisión
  // impecable con `payoutAllowed:true`, firmado por `evil-kyc`— hace que `resolvePayoutAuthority`
  // devuelva `{authorized:true}`. O sea: **el mutante autoriza un desembolso**. Ése es el tamaño de
  // lo que N3 sostiene, y por eso el assert de abajo mira `authorized`, no un código interno.
  it("slug `evil-kyc` con `payoutAllowed:true` ⇒ NO autoriza (kyc_reauth_failed / 502)", async () => {
    storeConLaFilaDe(VID, ADDR);
    gateway(compose200(AGENTE_SI, { slug: "evil-kyc", registry: "self-published" }));

    const r = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });

    expect(r.authorized).toBe(false);
    expect(r).toEqual({ authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 });
  });

  // ✅ EL CONTROL POSITIVO DEL INSTRUMENTO. Sin esto, el `it` de arriba podría ser verde porque el
  // escenario no llega nunca al gate (un env mal sembrado, un store vacío, un doble que no contesta),
  // y su rojo no vendría del chequeo de slug. Acá se cambia UNA SOLA COSA —el slug del ejecutor— y el
  // desenlace se da vuelta: MISMO output, MISMA fila, MISMO transporte, y AUTORIZA.
  it("✅ CONTROL: la MISMA respuesta con el slug propio SÍ autoriza (la diferencia es el slug)", async () => {
    storeConLaFilaDe(VID, ADDR);
    gateway(compose200(AGENTE_SI, EJECUTOR_PROPIO));

    const r = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });

    expect(r).toEqual({
      authorized: true,
      httpStatus: 200,
      provenance: "didit",
      riskLevel: "low",
    });
  });
});

describe("T-C5c 🔴🔴 AR/BLQ-ALTO-1 — el impostor QUE SE APROPIÓ DEL PAR no autoriza un desembolso", () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // 🔴 ÉSTE ES EL `it` QUE CIERRA EL BLOQUEANTE, y describe un atacante REAL, no uno de laboratorio.
  //
  // T-C5 (arriba) usa `slug: "evil-kyc"`. El AR midió que ese escenario **subestima al atacante**:
  // `POST /agents` del Coordinador es auth-only y el slug de `a2a_agents` es PK global,
  // primero-que-llega, sin scoping por owner ⇒ quien publique un agente llamado `Remit Kyc Decision`
  // se queda con el slug EXACTO, y su fila nace con `registry: "self-published"` hardcodeado. O sea
  // que el impostor real llega acá con el par PERFECTO y `payoutAllowed: true`.
  //
  // Lo único que NO puede elegir es a qué host le habla el Coordinador de verdad: eso es su
  // `invokeUrl`, y se cruza contra `KYC_AGENT_BASE_URL`, que vive en el deploy.
  //
  // 🧬 EL MUTANTE QUE ESTE `it` EXISTE PARA MATAR, Y SE APLICÓ: borrar el bloque `2b` de
  // `invocarPineado` (`gateway-kyc-client.ts`) — el chequeo de origen. Con el mutante puesto, ESTA
  // MISMA respuesta hace que `resolvePayoutAuthority` devuelva `{authorized: true}`: **el mutante
  // autoriza un desembolso.** Ése es el tamaño de lo que este chequeo sostiene, y por eso el assert
  // mira `authorized` y no un sentinela interno.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  const IMPOSTOR = {
    slug: "remit-kyc-decision", // el slug EXACTO: se lo quedó publicando primero
    registry: "self-published", // regalado por el propio Coordinador al publicar
    invokeUrl: "https://evil.example/api/agents/remit-kyc-decision/invoke", // lo ÚNICO que lo delata
  };

  it("par (slug, self-published) EXACTO + `payoutAllowed:true`, pero OTRO host ⇒ NO autoriza", async () => {
    storeConLaFilaDe(VID, ADDR);
    gateway(compose200(AGENTE_SI, IMPOSTOR));

    const r = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });

    expect(r.authorized).toBe(false);
    expect(r).toEqual({ authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 });
  });

  // ✅ EL CONTROL POSITIVO DEL INSTRUMENTO. Cambia UNA sola clave —el host de `invokeUrl`— y el
  // desenlace se da vuelta. Sin esto, el `it` de arriba podría ser verde porque el escenario nunca
  // llega al gate (env mal sembrada, store vacío, doble que no contesta) y su rojo no vendría del
  // chequeo de origen.
  it("✅ CONTROL: la MISMA respuesta con el host del deploy SÍ autoriza (la diferencia es el host)", async () => {
    storeConLaFilaDe(VID, ADDR);
    gateway(compose200(AGENTE_SI, { ...IMPOSTOR, invokeUrl: EJECUTOR_PROPIO.invokeUrl }));

    const r = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });

    expect(r).toEqual({
      authorized: true,
      httpStatus: 200,
      provenance: "didit",
      riskLevel: "low",
    });
  });

  it.each<[string, string]>([
    ["un dominio que TERMINA en el nuestro", "https://evil-agentes.test/api/x"],
    ["el nuestro como SUBdominio del atacante", "https://agentes.test.evil.example/api/x"],
    ["userinfo: el texto arranca con el nuestro", "https://agentes.test@evil.example/api/x"],
    ["otro puerto del mismo host", "https://agentes.test:8443/api/x"],
  ])("%s tampoco autoriza (⛔ la comparación es igualdad, no sufijo)", async (_caso, invokeUrl) => {
    storeConLaFilaDe(VID, ADDR);
    gateway(compose200(AGENTE_SI, { ...IMPOSTOR, invokeUrl }));
    const r = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(r).toEqual({ authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 });
  });

  it("`invokeUrl` AUSENTE con el par perfecto ⇒ NO autoriza (fail-closed, no «no sé ⇒ dale»)", async () => {
    storeConLaFilaDe(VID, ADDR);
    gateway(compose200(AGENTE_SI, { slug: "remit-kyc-decision", registry: "self-published" }));
    const r = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(r).toEqual({ authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 });
  });
});

// 🔴 EL TÍTULO NOMBRA LAS CATEGORÍAS Y NO LAS CUENTA (fix-pack CR/MNR-4). Acá decía «las otras TRES
// formas» y eran cuatro filas de dos clases; y el mismo conjunto está enumerado como CUATRO en las
// ramas de `invocarPineado` (`gateway-kyc-client.ts`, bloques 2 y 2b) y como CINCO en el docblock de
// `assertExecutor` (`scripts/smoke-kyc-helpers.ts`), porque cada sitio corta la misma superficie por
// donde le sirve. Ningún número era comprobable contra los otros dos, así que ninguno decía nada. Lo
// que NO se mueve al agregar una fila es el criterio: o el catálogo dijo que fue otro, o no dijo
// nada legible. La forma que un impostor SÍ puede ganar —apropiarse del par— vive en T-C5c, que es
// el guard de origen y no éste.
describe("T-C5b · N3 — el `registry` no es el nuestro, o el `agent` no se puede leer: ninguna autoriza", () => {
  it.each<[string, unknown]>([
    ["registry ajeno", { slug: "remit-kyc-decision", registry: "un-registry-cualquiera" }],
    ["registry AUSENTE", { slug: "remit-kyc-decision" }],
    ["`agent` ilegible ⇒ agents[0] === null", { registry: "self-published" }],
    ["sin la clave `agent`", SIN_AGENT],
  ])("%s ⇒ NO autoriza", async (_caso, agent) => {
    storeConLaFilaDe(VID, ADDR);
    gateway(compose200(AGENTE_SI, agent));
    // 🧬 MUTANTE: chequear SÓLO el slug (soltar el `registry`) ⇒ las dos primeras filas se ponen
    // rojas. Y no es hipotético: si nuestra fila quedara deshabilitada, el gateway cae al fanout
    // federado y ahí un tercero SÍ puede servir un card con este mismo slug.
    const r = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(r).toEqual({ authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 });
  });

  it("un BRIDGE reportado sobre el step tampoco autoriza (CD-2)", async () => {
    storeConLaFilaDe(VID, ADDR);
    gateway({
      body: {
        success: true,
        steps: [{ output: AGENTE_SI, agent: EJECUTOR_PROPIO, bridgeType: "LLM" }],
      },
    });
    const r = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(r).toEqual({ authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 });
  });
});

describe("T-C7 🔴 AC-10 — fail-closed POR DEFECTO, no por enumeración: las 10 filas", () => {
  // 🔴 LA DÉCIMA FILA ES LA QUE IMPORTA. Las nueve primeras son códigos que HOY existen; la décima
  // es un código que no está en ningún `union` de este repo, y está para que el `default` quede
  // ejercitado. El status HTTP real del agente SE PIERDE al pasar por `/compose` (del otro lado sólo
  // sobrevive la clase binaria `agentFailure`), así que enumerar casos conocidos es estructuralmente
  // imposible de hacer bien: siempre hay una respuesta nueva cayendo al default.
  //
  // 🧬 MUTANTE: un `default: return {ok:true, …}` en la escalera del cliente ⇒ varias filas se ponen
  // rojas de golpe, y la décima siempre.
  const FILAS: [string, { status?: number; body?: unknown; throws?: boolean }, boolean][] = [
    ["not_configured (sin la env del gateway)", {}, true],
    ["unavailable (la red se cayó)", { throws: true }, false],
    ["bad_response (200 con un output que no es un objeto)", { body: { success: true, steps: [{ output: 7 }] } }, false],
    ["payment_required (402)", { status: 402, body: { error_code: "PAYMENT_REQUIRED" } }, false],
    ["forbidden (403)", { status: 403, body: { error_code: "INSUFFICIENT_BUDGET" } }, false],
    ["no_agent_match (422)", { status: 422, body: { reason: "no_candidates" } }, false],
    ["step_failed + AGENT_ERROR", { body: { success: false, steps: [], agentFailure: "AGENT_ERROR" } }, false],
    ["step_failed + INPUT_REJECTED", { body: { success: false, steps: [], agentFailure: "INPUT_REJECTED" } }, false],
    ["step_failed SIN agentFailure", { body: { success: false, steps: [] } }, false],
    ["un código que no existe en ningún union", { status: 599, body: { code: "teapot_overflow" } }, false],
  ];

  it.each(FILAS)("%s ⇒ kyc_reauth_failed / 502, y NO autoriza", async (_caso, resp, sinEnv) => {
    if (sinEnv) vi.stubEnv("WASIAI_A2A_GATEWAY_URL", undefined);
    storeConLaFilaDe(VID, ADDR);
    gateway(resp);

    const r = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });

    expect(r.authorized).toBe(false);
    expect(r).toEqual({ authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 });
  });

  it("las 10 filas están, y ninguna es PASS (el conjunto no se vació al editarlo)", () => {
    expect(FILAS).toHaveLength(10);
  });

  it("`payoutAllowed:false` NO se colapsa con las 10: es un NO del agente, no una caída", async () => {
    // Las dos negativas son distintas y `prepare` las despacha distinto: 502 manda a mirar la
    // autoridad; 200 con `kyc_not_approved` es "el agente dijo que no".
    storeConLaFilaDe(VID, ADDR);
    gateway(compose200({ ...AGENTE_SI, payoutAllowed: false }));
    const r = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(r).toEqual({ authorized: false, reason: "kyc_not_approved", httpStatus: 200 });
  });
});

describe("T-C9 · AC-11/P-7 — el guard-order NO se movió: la credencial va ANTES del viaje", () => {
  it("`tokenStore.getForOwner` se llamó ANTES del `fetch`, bajo el transporte nuevo", async () => {
    const getForOwner = storeConLaFilaDe(VID, ADDR);
    gateway(compose200(AGENTE_SI));

    await resolvePayoutAuthority({ verificationId: VID, address: ADDR });

    // 🧬 MUTANTE: mover el Guard 3 después del viaje ⇒ el orden se invierte ⇒ ROJO. Es P-7: ningún
    // `fetch` al borde antes de pasar los guards; un par ajeno no gasta ni una consulta.
    expect(orden[0]).toBe("getForOwner");
    expect(orden).toEqual(["getForOwner", "fetch"]);
    expect(getForOwner).toHaveBeenCalledTimes(1);
    expect(getForOwner).toHaveBeenCalledWith(VID, ADDR);
  });

  it("la firma de la llamada al transporte no cambió: sessionId + identityClaim + decisionToken", async () => {
    storeConLaFilaDe(VID, ADDR);
    const m = gateway(compose200(AGENTE_SI));
    await resolvePayoutAuthority({ verificationId: VID, address: ADDR });

    const init = m.mock.calls[0]?.[1] as RequestInit;
    const input = JSON.parse(String(init.body)).steps[0].input;
    expect(Object.keys(input).sort()).toEqual(["decisionToken", "identityClaim", "sessionId"]);
    expect(input.sessionId).toBe(VID);
    expect(input.decisionToken).toBe(TOKEN);
  });
});

describe("T-C10 🔴 AC-12 — el ownership mismatch corta ANTES del transporte, bajo LOS DOS", () => {
  it.each([["direct"], ["gateway"]])(
    "con KYC_TRANSPORT=%s: un par que no matchea ⇒ kyc_ownership_mismatch/200 y CERO viajes",
    async (transporte) => {
      vi.stubEnv("KYC_TRANSPORT", transporte);
      storeConLaFilaDe(VID, OTHER); // la fila es de OTRO dueño
      gateway(compose200(AGENTE_SI));

      const r = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });

      expect(r).toEqual({ authorized: false, reason: "kyc_ownership_mismatch", httpStatus: 200 });
      // 🧬 MUTANTE: bajar el Guard 3 después del viaje ⇒ el contador deja de ser 0 ⇒ ROJO. Y bajo
      // `gateway` el daño sería peor que antes: cada viaje que no debería salir se COBRA.
      expect(fetchCalls).toBe(0);
    },
  );

  it("✅ el claim que viaja (y con el que se busca al dueño) es el CANONICALIZADO, no el crudo", async () => {
    // 🔴 SIN ESTE DOBLE EL `it` SERÍA VACUO: con la función real, canonicalizar es la identidad y el
    // mutante "mandar el crudo" produce el mismo byte. Acá se fuerza una canonicalización que SÍ
    // cambia el valor, y la fila del store existe SÓLO para el canonicalizado.
    const CRUDO = "  4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU  ";
    canonSpy.mockImplementation((a: string) => a.trim());
    storeConLaFilaDe(VID, ADDR);
    const m = gateway(compose200(AGENTE_SI));

    const r = await resolvePayoutAuthority({ verificationId: VID, address: CRUDO });

    // 🧬 MUTANTE: pasar `address` crudo a `getForOwner` ⇒ no matchea ⇒ `kyc_ownership_mismatch` ⇒
    // este `toBe(true)` se pone ROJO. 🧬 MUTANTE: pasar `address` crudo como `identityClaim` al
    // transporte ⇒ el `expect` del input se pone ROJO.
    expect(r.authorized).toBe(true);
    const init = m.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body)).steps[0].input.identityClaim).toBe(ADDR);
  });
});
