import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KycVerdictRecord } from "../../../../src/application/ports";
import { issueSessionToken } from "../../../../src/infrastructure/kyc-auth";

// El store del VEREDICTO. Default `null` (flag OFF) ⇒ los controles de guard-order corren sin
// escritura, exactamente como antes de WKH-333.
const { getStoreMock } = vi.hoisted(() => ({ getStoreMock: vi.fn(() => null as unknown) }));
vi.mock("../../../../src/infrastructure/persistence/supabase-kyc-verdicts", () => ({
  getKycVerdictStore: getStoreMock,
}));

// WKH-233 — el store del `decisionToken`. Se mockea el MÓDULO para poder CONTAR llamadas: T-TOK-5 no
// mira el status, mira que el store y el `fetch` reciban CERO llamadas antes del HMAC.
const { readMock, tokenStoreMock } = vi.hoisted(() => ({
  readMock: vi.fn(),
  tokenStoreMock: vi.fn(),
}));
vi.mock("../../../../src/infrastructure/persistence/supabase-kyc-session-tokens", () => ({
  getKycSessionTokenStore: tokenStoreMock,
}));

import { GET } from "./route";

const SESSION = "sess-abc";
const OWNER = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_CENTINELA = "k1.CENTINELA-QUE-NO-DEBE-SALIR";
const AHORA = "2026-08-19T12:00:00.000Z";

/** La salida del agente: 8 claves + `identityMatches` sólo si se mandó `identityClaim`. */
const AGENT_APPROVED = {
  terminal: true,
  status: "Approved",
  approved: true,
  riskLevel: "low",
  verificationId: SESSION,
  provenance: "didit",
  payoutAllowed: true,
  reasons: [],
  identityMatches: true,
};

function req(headers: Record<string, string> = {}, id = SESSION): Request {
  const url = `http://localhost/api/kyc/decision?sessionId=${encodeURIComponent(id)}`;
  return new Request(url, { headers });
}

/** Doble del agente. Devuelve siempre `body`, y registra url + init para poder mirar la cabecera. */
function agenteResponde(body: unknown, status = 200) {
  const m = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", m);
  return m;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
  // WKH-233 (fix-pack · H-3): la credencial de invoke es OBLIGATORIA desde que `invokeAuthHeader`
  // es fail-closed, así que sembrarla es PRE-REQUISITO de cualquier `it` que llegue al agente —
  // igual que el host de la línea de arriba. Sin esto, 45 `it` de tres archivos morían con
  // `kyc_agent_invoke_secret_unset` antes de llegar a lo que miden.
  vi.stubEnv("KYC_AGENT_INVOKE_SECRET", "invoke-secret-de-test");
  vi.stubEnv("KYC_SESSION_SECRET", "test-secret-123");
  getStoreMock.mockReset();
  getStoreMock.mockReturnValue(null);
  readMock.mockReset();
  readMock.mockResolvedValue({ token: TOKEN_CENTINELA, ownerAddress: OWNER });
  tokenStoreMock.mockReset();
  tokenStoreMock.mockReturnValue({ readForVerifiedSession: readMock });
});

describe("GET /api/kyc/decision — guard-order + anti-enumeración (P-5/P-6/P-7)", () => {
  it("token válido → 200 con la salida del agente + `verifiedAt`", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AHORA));
    agenteResponde(AGENT_APPROVED);
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...AGENT_APPROVED, verifiedAt: AHORA });
  });

  it("⛔ la respuesta NO trae ningún dato de identidad (el agente no devuelve ninguno)", async () => {
    agenteResponde(AGENT_APPROVED);
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("identity");
    expect(JSON.stringify(body)).not.toMatch(/documentNumber|firstName|dateOfBirth/);
  });

  // ⚠️ Las cabeceras se construyen DENTRO del `it`, no en el array: el array se evalúa al COLECTAR,
  // antes de que `beforeEach` stubee `KYC_SESSION_SECRET`, y `issueSessionToken` tiraría ahí.
  it.each([
    ["sin x-kyc-token", () => ({})],
    ["token errado", () => ({ "x-kyc-token": "forged-token" })],
    ["token de OTRA sesión", () => ({ "x-kyc-token": issueSessionToken("sess-otra") })],
  ])("%s → 401, y NI el store NI el agente reciben una llamada (P-6/P-7)", async (_c, mkHeaders) => {
    const fetchMock = agenteResponde(AGENT_APPROVED);
    const res = await GET(req(mkHeaders()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readMock).not.toHaveBeenCalled();
  });

  it("sin KYC_AGENT_BASE_URL → 501, sin exigir token", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", undefined);
    const res = await GET(req());
    expect(res.status).toBe(501);
  });

  it("con host del agente y sin KYC_SESSION_SECRET → 500", async () => {
    vi.stubEnv("KYC_SESSION_SECRET", "");
    const res = await GET(req({ "x-kyc-token": "whatever" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
  });

  it("sin sessionId → 400 (preservado)", async () => {
    const res = await GET(new Request("http://localhost/api/kyc/decision"));
    expect(res.status).toBe(400);
  });

  it("el fetch va al agente, con el token en la CABECERA y el claim en el query (CD-4/D-6)", async () => {
    const fetchMock = agenteResponde(AGENT_APPROVED);
    await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("https://agentes.test/api/agents/remit-kyc-validator/decision");
    expect(new URL(url).searchParams.get("identityClaim")).toBe(OWNER);
    expect(url).not.toContain(TOKEN_CENTINELA);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-kyc-decision-token"]).toBe(TOKEN_CENTINELA);
  });

  it("D-6: fila SIN dueño ⇒ la clave `identityClaim` NO se manda (no se preguntó)", async () => {
    readMock.mockResolvedValue({ token: TOKEN_CENTINELA, ownerAddress: null });
    // Sin claim, el agente OMITE la clave (no la manda `undefined`). El doble tiene que omitirla de
    // verdad: `{ identityMatches: undefined }` seguiría estando "in" el objeto, y el cliente —que
    // distingue ausente de presente-con-tipo-raro— tiraría. Es la distinción de CD-3, hecha fixture.
    const { identityMatches: _omitida, ...sinClaim } = AGENT_APPROVED;
    const fetchMock = agenteResponde({ ...sinClaim, payoutAllowed: false });
    await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    // 🧬 MUTANTE: rellenar el claim con cualquier cosa (la dirección conectada, el body) ⇒ ROJO. Y es
    // el mutante que reabre R-1: afirmaríamos un binding que nadie probó.
    expect([...url.searchParams.keys()]).toEqual(["sessionId"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-DEC-3 · sin fila de token ⇒ 502, y el agente recibe CERO llamadas
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("GET /api/kyc/decision — T-DEC-3: la credencial del borde sale del store, o no hay viaje", () => {
  it("sin fila ⇒ 502 `kyc_decision_failed` y el `fetch` al agente recibe CERO llamadas", async () => {
    readMock.mockResolvedValue(null);
    const fetchMock = agenteResponde(AGENT_APPROVED);
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    // 🧬 MUTANTE: llamar al agente igual, sin token ⇒ el doble recibe 1 llamada ⇒ ROJO.
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "kyc_decision_failed", upstream: 0 });
  });

  it("sin store (envs de Supabase ausentes) ⇒ el MISMO 502, indistinguible", async () => {
    tokenStoreMock.mockReturnValue(null);
    const fetchMock = agenteResponde(AGENT_APPROVED);
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "kyc_decision_failed", upstream: 0 });
  });

  it("un fallo de la base ⇒ el MISMO 502, sin eco del SQLSTATE", async () => {
    readMock.mockRejectedValue(new Error("kyc_session_token_read_failed:42P01"));
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("42P01");
  });

  it("✅ calibración inversa: CON fila, el agente recibe EXACTAMENTE 1 llamada", async () => {
    const fetchMock = agenteResponde(AGENT_APPROVED);
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("un !ok del agente ⇒ 502 con el mismo código y el status upstream", async () => {
    agenteResponde({ error: "unauthorized" }, 401);
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "kyc_decision_failed", upstream: 401 });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-DEC-4 · AR/BLQ-BAJO-1 — el cliente RECHAZA, y el 502 lo tiene que producir ESTA route
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ AGUJERO CIERRA. Los casos de arriba cubren el camino `{ ok:false, upstream }`, o sea el
// agente que CONTESTA mal. `readAgentKycDecision` tiene otro camino entero: RECHAZA (transporte
// caído, JSON roto, raíz no-objeto, `reasons` que no es array de strings, y cada clave del contrato
// faltante o con el tipo equivocado). Ese camino no pasaba por ningún `catch` de esta route ⇒ el
// rechazo escapaba y Next devolvía un **500 genérico**, no el 502 que el docblock declara.
//
// ⚠️ Y NO ES UN CASO DE LABORATORIO: la primera rama es "el agente no está disponible", que es el
// modo de falla más común de un servicio que vive en otro deployment.
describe("GET /api/kyc/decision — T-DEC-4: un RECHAZO del cliente sale por 502, nunca por 500", () => {
  /** El `fetch` no contesta: RECHAZA. Es el agente inalcanzable / DNS / timeout. */
  function agenteInalcanzable() {
    const m = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", m);
    return m;
  }

  it("T-DEC-4a: agente INALCANZABLE ⇒ 502 `kyc_decision_failed` con `upstream: 0` (no un 500 crudo)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = agenteInalcanzable();
    // 🧬 MUTANTE: quitarle el `try/catch` a la llamada del agente ⇒ esta promesa RECHAZA ⇒ ROJO.
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(fetchMock, "el caso no llegó a ejercitar el borde").toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
    // ⛔ `upstream: 0` = "no hubo status upstream", el MISMO valor de la rama sin fila ⇒ desde afuera
    // un fallo de transporte y una sesión inexistente siguen siendo indistinguibles (P-6).
    expect(await res.json()).toEqual({ error: "kyc_decision_failed", upstream: 0 });
  });

  it("T-DEC-4b: agente que contesta 200 SIN `payoutAllowed` ⇒ el MISMO 502, sin eco de la clave", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { payoutAllowed: _quitada, ...sinGate } = AGENT_APPROVED;
    agenteResponde(sinGate);
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "kyc_decision_failed", upstream: 0 });
  });

  it("T-DEC-4c: `reasons` que no es un array de strings ⇒ el MISMO 502", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    agenteResponde({ ...AGENT_APPROVED, reasons: "no-soy-un-array" });
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "kyc_decision_failed", upstream: 0 });
  });

  it("✅ calibración: con la respuesta COMPLETA, la misma ruta devuelve 200 (el 502 no es constante)", async () => {
    agenteResponde(AGENT_APPROVED);
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ payoutAllowed: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-TOK-5 · la excepción a CD-19 NO es un colador: el HMAC corre ANTES de tocar el store
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("GET /api/kyc/decision — T-TOK-5", () => {
  it.each([
    ["sin x-kyc-token", {}],
    ["con un token inválido", { "x-kyc-token": "forjado" }],
  ])("%s: store = 0 llamadas y fetch = 0 llamadas (no mira el status)", async (_c, headers) => {
    const fetchMock = agenteResponde(AGENT_APPROVED);
    await GET(req(headers));
    // 🧬 MUTANTE: mover la lectura del store ARRIBA del guard del HMAC ⇒ store recibe 1 ⇒ ROJO. Y es
    // el mutante que importa: `readForVerifiedSession` NO filtra por dueño, así que sin el HMAC
    // delante cualquiera que adivine un `sessionId` se lleva la credencial de esa verificación.
    expect(readMock, "el store se leyó SIN pasar el HMAC: eso es el IDOR original, de vuelta").toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("✅ calibración inversa: con el HMAC válido, store = 1 llamada y fetch = 1", async () => {
    const fetchMock = agenteResponde(AGENT_APPROVED);
    await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(readMock).toHaveBeenCalledTimes(1);
    expect(readMock).toHaveBeenCalledWith(SESSION);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-DEC-1 / T-DEC-2 · la escritura de la fila: el gate del AGENTE, y best-effort de verdad
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("GET /api/kyc/decision — la fila se escribe SÓLO con `payoutAllowed === true`", () => {
  function fakeStore(over: { putThrows?: boolean } = {}) {
    return {
      get: vi.fn(async () => null),
      put: vi.fn(async (_r: KycVerdictRecord) => {
        if (over.putThrows) throw new Error("kyc_verdict_insert_failed:08006");
        return "inserted" as const;
      }),
    };
  }

  // ── T-DEC-1 ──────────────────────────────────────────────────────────────────────────────────
  //
  // ⛔ ACÁ HABÍA UNA DEFENSA FALSA, Y SE RETIRA EN VEZ DE CORREGIRLA A MEDIAS (WKH-233 fix-pack · H-6).
  // Decía: *"POR QUÉ ESTE TEST NECESITA LOS DOS CASOS DE `identityMatches` … el mutante que sí muere
  // es `identityMatches !== false`, y para matarlo hacen falta las DOS ramas"*. **Es imposible**: los
  // TRES casos ponen `payoutAllowed: false`, y `persistKycVerdict` corta en su PRIMERA línea
  // (`route.ts:150`, `if (d.payoutAllowed !== true) return`) sin llegar a mirar `identityMatches`
  // jamás. Los tres decían la verdad ("no se escribe fila") por un motivo distinto del que afirmaban,
  // y ningún mutante sobre `identityMatches` podía morir acá. Los títulos se corrigieron para nombrar
  // el gate que de verdad los explica.
  //
  // 🔴 Y EL CASO QUE FALTABA ES EL QUE IMPORTA: `payoutAllowed: true` + `identityMatches: false`. Es
  // el único que separa lo que el expediente PIDE (AC-5/AC-7 del work-item: *"escribir la fila SÓLO
  // si `identityMatches === true`"*) de lo que el código HACE (DT-5': el gate es `payoutAllowed`).
  // No existía en la suite. Tiene su `it` propio abajo, y **afirma lo que el código hace**, no lo que
  // el AC dice.
  it.each([
    ["`payoutAllowed: false` (con `identityMatches: false`)", { payoutAllowed: false, identityMatches: false }],
    ["`payoutAllowed: false` (con `identityMatches` AUSENTE)", { payoutAllowed: false, identityMatches: undefined }],
    ["`payoutAllowed: false` con `approved: true` e `identityMatches: true`", { payoutAllowed: false }],
  ])("T-DEC-1: con %s ⇒ NO se escribe fila", async (_c, over) => {
    const body: Record<string, unknown> = { ...AGENT_APPROVED, ...over };
    if ("identityMatches" in over && over.identityMatches === undefined) delete body.identityMatches;
    agenteResponde(body);
    const store = fakeStore();
    getStoreMock.mockReturnValue(store);
    const alerta = vi.spyOn(console, "error").mockImplementation(() => {});
    await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(
      store.put,
      "se escribió una fila que el AGENTE no juzgó habilitante: esa fila es la fuente de autoridad " +
        "de un pago, y el invariante que sostiene todo lo demás es que existir signifique real",
    ).not.toHaveBeenCalled();
    expect(alerta).not.toHaveBeenCalled();
  });

  // ── T-DEC-1b (WKH-233 fix-pack · H-6) — EL CASO QUE SEPARA EL AC DEL CÓDIGO ───────────────────
  //
  // 🔴 QUÉ MIDE. `payoutAllowed: true` con `identityMatches: false`. El work-item dice que este caso
  // NO debe escribir fila (AC-7: *"sólo si `identityMatches === true`"*); el código SÍ la escribe,
  // porque el gate es `payoutAllowed` y nada más (DT-5', aprobado por el founder en MI-1). Este `it`
  // fija **lo que el código hace**. Si mañana alguien "arregla" el código para cumplir el AC como
  // está escrito, esto se pone rojo y obliga a decidir a propósito en vez de por deriva.
  //
  // ⛔ Y ACÁ VA EL LÍMITE, EXPLÍCITO, PORQUE ESTO ES ACOTAMIENTO Y NO CIERRE:
  //   · ESTE repo verifica que la fila se escribe si y sólo si el agente dijo `payoutAllowed === true`.
  //   · La premisa de que `payoutAllowed === true` YA EXIGE una identidad coincidente la sostiene el
  //     AGENTE, en otro repo (`sdd.md:704`), que es Scope OUT. **Chaski no puede verificarlo, y este
  //     test no lo verifica.** Si esa premisa dejara de valer del otro lado, acá no se pondría rojo
  //     nada: se escribiría una fila que habilita un pago sin identidad comprobada.
  // ⛔ PROHIBIDO reescribir este bloque como si la garantía estuviera cerrada.
  it("T-DEC-1b: `payoutAllowed: true` + `identityMatches: false` ⇒ SÍ escribe (el gate es DT-5')", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AHORA));
    agenteResponde({ ...AGENT_APPROVED, identityMatches: false });
    const store = fakeStore();
    getStoreMock.mockReturnValue(store);
    await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(
      store.put,
      "el código dejó de escribir con `identityMatches: false`. Puede ser correcto —es lo que AC-7 " +
        "pide— pero contradice DT-5', que el founder aprobó en MI-1: decidilo a propósito y " +
        "actualizá el work-item, no dejes que las dos versiones convivan",
    ).toHaveBeenCalledTimes(1);
  });

  it("✅ calibración inversa: con `payoutAllowed: true`, `store.put` recibe EXACTAMENTE 1 llamada", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AHORA));
    agenteResponde(AGENT_APPROVED);
    const store = fakeStore();
    getStoreMock.mockReturnValue(store);
    await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(store.put).toHaveBeenCalledTimes(1);
    const written = store.put.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    // El dueño sale de la FILA DEL TOKEN (la dirección PoP-probada), nunca de un eco del borde.
    expect(written.senderAddress).toBe(OWNER);
    expect(written.verificationId).toBe(SESSION);
    expect(written.verifiedAt).toBe(AHORA);
    expect(Object.keys(written).sort()).toEqual([
      "approved",
      "provenance",
      "riskLevel",
      "senderAddress",
      "verificationId",
      "verifiedAt",
    ]);
  });

  it("NO terminal ⇒ no escribe, y `verifiedAt` sale `null` en la respuesta", async () => {
    agenteResponde({ ...AGENT_APPROVED, terminal: false, status: "In Progress" });
    const store = fakeStore();
    getStoreMock.mockReturnValue(store);
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(store.put).not.toHaveBeenCalled();
    expect((await res.json()).verifiedAt).toBeNull();
  });

  // ── T-DEC-2 · P-13 ───────────────────────────────────────────────────────────────────────────
  it("T-DEC-2: la respuesta es BYTE-IDÉNTICA con el store OFF, ON, y con la escritura ROTA", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AHORA));
    agenteResponde(AGENT_APPROVED);
    const token = issueSessionToken(SESSION);

    getStoreMock.mockReturnValue(null);
    const off = await GET(req({ "x-kyc-token": token }));
    const offBody = await off.text();

    getStoreMock.mockReturnValue(fakeStore());
    const on = await GET(req({ "x-kyc-token": token }));
    const onBody = await on.text();

    vi.spyOn(console, "error").mockImplementation(() => {});
    getStoreMock.mockReturnValue(fakeStore({ putThrows: true }));
    const roto = await GET(req({ "x-kyc-token": token }));
    const rotoBody = await roto.text();

    // 🧬 MUTANTE: que un fallo de `store.put` cambie el status o el body ⇒ ROJO.
    expect(
      { status: on.status, body: onBody },
      "encender la persistencia cambió lo que la persona ve al terminar su verificación",
    ).toEqual({ status: off.status, body: offBody });
    expect(
      { status: roto.status, body: rotoBody },
      "un fallo de NUESTRA base de evidencia cambió el desenlace del KYC de una persona",
    ).toEqual({ status: off.status, body: offBody });
  });

  it("la escritura rota emite UNA alerta por el canal del ledger, VALUE-FREE", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    agenteResponde(AGENT_APPROVED);
    getStoreMock.mockReturnValue(fakeStore({ putThrows: true }));
    await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [line, fields] = errSpy.mock.calls[0] as [string, Record<string, string>];
    expect(line).toContain("[ledger][ALERT]");
    const payload = String(line) + JSON.stringify(fields ?? {});
    for (const secreto of [SESSION, OWNER, TOKEN_CENTINELA]) {
      expect(payload, `la alerta filtró \`${secreto}\``).not.toContain(secreto);
    }
  });

  it("8 polleos del MISMO sessionId ⇒ la route pide 8 escrituras iguales (la idempotencia es del CAS)", async () => {
    agenteResponde(AGENT_APPROVED);
    const store = {
      get: vi.fn(async () => null),
      put: vi.fn(async (_r: KycVerdictRecord) => "already_recorded" as const),
    };
    getStoreMock.mockReturnValue(store);
    const token = issueSessionToken(SESSION);
    for (let i = 0; i < 8; i++) await GET(req({ "x-kyc-token": token }));
    expect(store.put).toHaveBeenCalledTimes(8);
    const ids = store.put.mock.calls.map((c) => (c[0] as unknown as { verificationId: string }).verificationId);
    expect(new Set(ids).size).toBe(1);
    const owners = store.put.mock.calls.map((c) => (c[0] as unknown as { senderAddress: string }).senderAddress);
    expect(new Set(owners).size).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-TOK-3 / T-TOK-4 · CD-20 en la segunda de las tres rutas
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("GET /api/kyc/decision — el `decisionToken` no sale por ningún lado (CD-20)", () => {
  it("T-TOK-3: el centinela no aparece en el body NI en ninguna cabecera de la respuesta", async () => {
    agenteResponde(AGENT_APPROVED);
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    const cuerpo = await res.text();
    expect(cuerpo).not.toContain(TOKEN_CENTINELA);
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(TOKEN_CENTINELA);
    // ✅ Calibración: la respuesta SÍ trae su contenido (un 500 vacío también pasaría lo de arriba).
    expect(JSON.parse(cuerpo)).toMatchObject({ verificationId: SESSION, payoutAllowed: true });
  });

  it.each([
    ["camino feliz", 200],
    ["camino de fallo del agente", 502],
  ])("T-TOK-4: en el %s, ningún `console.*` lleva el token", async (_c, status) => {
    const capturado: string[] = [];
    const anotar = (...a: unknown[]) =>
      capturado.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    vi.spyOn(console, "warn").mockImplementation(anotar);
    vi.spyOn(console, "error").mockImplementation(anotar);
    vi.spyOn(console, "log").mockImplementation(anotar);
    agenteResponde(status === 200 ? AGENT_APPROVED : { error: "x" }, status);
    await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(capturado.join("\n")).not.toContain(TOKEN_CENTINELA);
    if (status !== 200) expect(capturado.join("\n")).toContain("[kyc-agent]");
  });
});
