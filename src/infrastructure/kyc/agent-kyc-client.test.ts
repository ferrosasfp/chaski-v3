// T-CON-1/2 y T-CLI-1..5 — el borde con el agente de KYC (WKH-233/W1).
//
// Todos los asserts miran lo que SALE del proceso (body, cabeceras, query, logs), no el status: un
// test sobre el status no distingue "se mandó bien" de "se mandó cualquier cosa y el doble contestó
// 200 igual".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentKycSession, readAgentKycDecision } from "./agent-kyc-client";

const BASE = "https://agentes.test";

interface Llamada {
  url: string;
  init: RequestInit;
}

let llamadas: Llamada[] = [];

function responder(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      llamadas.push({ url: String(url), init });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as unknown as Response;
    }),
  );
}

const SESION_OK = {
  sessionId: "ses-1",
  url: "https://verificacion.example/ses-1",
  decisionToken: "k1.centinela-del-token",
  provenance: "didit",
};

const DECISION_OK = {
  terminal: true,
  status: "Approved",
  approved: true,
  riskLevel: "low",
  verificationId: "ses-1",
  provenance: "didit",
  payoutAllowed: true,
  reasons: [],
};

function headersDe(init: RequestInit): Record<string, string> {
  const h = (init.headers ?? {}) as Record<string, string>;
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

beforeEach(() => {
  llamadas = [];
  vi.stubEnv("KYC_AGENT_BASE_URL", BASE);
  vi.stubEnv("KYC_AGENT_INVOKE_SECRET", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("T-CON-1 · el body de /session lleva EXACTAMENTE las claves que el agente acepta", () => {
  it("con `identityRef` presente, `Object.keys(body)` es exactamente ['identityRef']", async () => {
    responder(200, SESION_OK);
    await createAgentKycSession({ identityRef: "4AvAjtGgPq" });
    const body = JSON.parse(String(llamadas[0]?.init.body));
    // 🧬 MUTANTE: agregar `callbackUrl` al body ⇒ 2 claves ⇒ ROJO. Y no es cosmético: el schema del
    // agente es `.strict()` y contesta 400 ante cualquier clave extra.
    expect(Object.keys(body)).toEqual(["identityRef"]);
    expect(body.identityRef).toBe("4AvAjtGgPq");
  });

  it("la URL de /session no lleva ningún query param", async () => {
    responder(200, SESION_OK);
    await createAgentKycSession({ identityRef: "4AvAjtGgPq" });
    expect(new URL(String(llamadas[0]?.url)).search).toBe("");
  });
});

describe("T-CON-2 · la respuesta se ESTRECHA, no se castea", () => {
  it.each([
    ["falta `decisionToken`", { sessionId: "s", url: "u", provenance: "didit" }],
    ["falta `sessionId`", { url: "u", decisionToken: "t", provenance: "didit" }],
    ["`url` no es string", { sessionId: "s", url: 7, decisionToken: "t", provenance: "didit" }],
    ["la raíz es un array", []],
  ])("/session con %s ⇒ THROW (no un `undefined` que siga viaje)", async (_caso, body) => {
    responder(200, body);
    // 🧬 MUTANTE: `as KycAgentSessionOutput` sobre el `unknown` ⇒ resuelve con `undefined` ⇒ ROJO.
    await expect(createAgentKycSession({})).rejects.toThrow(/kyc_agent_bad_response/);
  });

  it("/decision con `identityMatches` de tipo raro ⇒ THROW (⛔ nunca se normaliza a false)", async () => {
    responder(200, { ...DECISION_OK, identityMatches: "true" });
    await expect(
      readAgentKycDecision({ sessionId: "s", decisionToken: "t" }),
    ).rejects.toThrow(/kyc_agent_bad_response:decision:identityMatches/);
  });

  it("✅ calibración: un 200 BIEN formado se parsea entero (el guard no deniega todo)", async () => {
    responder(200, DECISION_OK);
    const r = await readAgentKycDecision({ sessionId: "ses-1", decisionToken: "t" });
    expect(r).toEqual({ ok: true, output: DECISION_OK });
    // Y sin `identityClaim` el agente omite la clave: acá se preserva AUSENTE, no `false`.
    expect(r.ok && "identityMatches" in r.output).toBe(false);
  });

  it("✅ calibración: con `identityMatches: false` explícito, la clave SÍ viaja como false", async () => {
    responder(200, { ...DECISION_OK, payoutAllowed: false, identityMatches: false });
    const r = await readAgentKycDecision({ sessionId: "s", identityClaim: "A", decisionToken: "t" });
    expect(r.ok && r.output.identityMatches).toBe(false);
  });

  it("un !ok NO tira: devuelve el status upstream para que la route lo pueda seguir reportando", async () => {
    responder(502, { error: "kyc_upstream_failed" });
    expect(await readAgentKycDecision({ sessionId: "s", decisionToken: "t" })).toEqual({
      ok: false,
      upstream: 502,
    });
  });
});

describe("T-CLI-1 · sin prueba de posesión, la clave `identityRef` SE OMITE (AC-4/P-4)", () => {
  it("`createAgentKycSession({})` manda un body SIN la clave (⛔ no manda `null`)", async () => {
    responder(200, SESION_OK);
    await createAgentKycSession({});
    const crudo = String(llamadas[0]?.init.body);
    const body = JSON.parse(crudo);
    // 🧬 MUTANTE: mandar `identityRef: null` ⇒ la clave viaja ⇒ ROJO. Y es el caso que importa: una
    // sesión SIN ATAR se verifica igual, y `null` sería un valor que el `.strict()` del agente
    // rechaza con 400 ⇒ la persona no podría ni empezar el KYC.
    expect(Object.keys(body)).toEqual([]);
    expect(crudo).not.toContain("identityRef");
  });

  it("✅ calibración: CON prueba, la clave viaja con la dirección probada", async () => {
    responder(200, SESION_OK);
    await createAgentKycSession({ identityRef: "So11111111111111111111111111111111111111112" });
    expect(JSON.parse(String(llamadas[0]?.init.body)).identityRef).toBe(
      "So11111111111111111111111111111111111111112",
    );
  });
});

describe("T-CLI-2 · CD-4 — el token va en la CABECERA y NUNCA en el query", () => {
  it("la cabecera es `x-kyc-decision-token` y la URL sólo lleva sessionId (+identityClaim)", async () => {
    responder(200, DECISION_OK);
    await readAgentKycDecision({
      sessionId: "ses-1",
      identityClaim: "4AvAjtGgPq",
      decisionToken: "k1.centinela-del-token",
    });
    const { url, init } = llamadas[0] as Llamada;
    expect(headersDe(init)["x-kyc-decision-token"]).toBe("k1.centinela-del-token");
    // 🧬 MUTANTE: mover el token al query string ⇒ ROJO. El query queda en el access log del hosting.
    expect(url).not.toContain("k1.centinela-del-token");
    expect([...new URL(url).searchParams.keys()].sort()).toEqual(["identityClaim", "sessionId"]);
    // ⛔ Y jamás con el nombre del HMAC de Chaski: son secretos de repos distintos.
    expect(headersDe(init)["x-kyc-token"]).toBeUndefined();
  });

  it("sin `identityClaim`, la clave NO se manda (el agente omite `identityMatches`: no se preguntó)", async () => {
    responder(200, DECISION_OK);
    await readAgentKycDecision({ sessionId: "ses-1", decisionToken: "t" });
    expect([...new URL(String(llamadas[0]?.url)).searchParams.keys()]).toEqual(["sessionId"]);
  });
});

describe("T-CLI-3 · CD-15 — ningún log lleva un VALOR", () => {
  const CENTINELAS = ["ses-1", "4AvAjtGgPq", "k1.centinela-del-token", BASE, "identityRef"];

  function espiarConsola(): () => string {
    const capturado: string[] = [];
    const anotar = (...args: unknown[]) => {
      capturado.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    vi.spyOn(console, "warn").mockImplementation(anotar);
    vi.spyOn(console, "error").mockImplementation(anotar);
    vi.spyOn(console, "log").mockImplementation(anotar);
    return () => capturado.join("\n");
  }

  it.each([
    ["!ok del agente", 502],
    ["400 del agente", 400],
  ])("con %s, el log lleva SÓLO la rama y el status upstream", async (_caso, status) => {
    responder(status, { error: "x" });
    const leer = espiarConsola();
    await readAgentKycDecision({
      sessionId: "ses-1",
      identityClaim: "4AvAjtGgPq",
      decisionToken: "k1.centinela-del-token",
    });
    const salida = leer();
    // 🧬 MUTANTE: `console.warn(..., { sessionId })` ⇒ ROJO.
    for (const c of CENTINELAS) expect(salida, `el log filtró «${c}»`).not.toContain(c);
    // ✅ Calibración en la otra dirección: el log EXISTE (un módulo que no loguea nada también
    // pasaría el assert de arriba, y sería un fallo indiagnosticable — la lección de `authority.ts`).
    expect(salida).toContain("[kyc-agent]");
    expect(salida).toContain(String(status));
  });

  it("con el transporte caído, el log lleva SÓLO `errorName` (nunca el `message`, que trae la URL)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const e = new Error(`connect ECONNREFUSED ${BASE}/api/agents/x/decision?sessionId=ses-1`);
        e.name = "TypeError";
        throw e;
      }),
    );
    const leer = espiarConsola();
    await expect(
      readAgentKycDecision({ sessionId: "ses-1", decisionToken: "k1.centinela-del-token" }),
    ).rejects.toThrow();
    const salida = leer();
    for (const c of CENTINELAS) expect(salida, `el log filtró «${c}»`).not.toContain(c);
    expect(salida).toContain("TypeError");
  });

  it("el camino FELIZ no loguea nada (ni el sessionId, ni el token)", async () => {
    responder(200, DECISION_OK);
    const leer = espiarConsola();
    await readAgentKycDecision({ sessionId: "ses-1", decisionToken: "k1.centinela-del-token" });
    expect(leer()).toBe("");
  });
});

describe("T-CLI-4 · la cabecera de invoke se manda SÓLO si el secreto está", () => {
  it("sin `KYC_AGENT_INVOKE_SECRET`, la cabecera NO EXISTE (byte-idéntico a hoy)", async () => {
    responder(200, SESION_OK);
    await createAgentKycSession({});
    responder(200, DECISION_OK);
    await readAgentKycDecision({ sessionId: "s", decisionToken: "t" });
    // 🧬 MUTANTE: mandarla siempre, con `""` de valor ⇒ la clave existe ⇒ ROJO. Y el mutante importa:
    // `Bearer ` pelado es `credential_malformed` para el agente el día que encienda su guard.
    for (const l of llamadas) expect(headersDe(l.init).authorization).toBeUndefined();
  });

  it("✅ con el secreto seteado, va `Authorization: Bearer <valor>` en LAS DOS funciones", async () => {
    vi.stubEnv("KYC_AGENT_INVOKE_SECRET", "s3cr3t0");
    responder(200, SESION_OK);
    await createAgentKycSession({});
    responder(200, DECISION_OK);
    await readAgentKycDecision({ sessionId: "s", decisionToken: "t" });
    expect(llamadas).toHaveLength(2);
    for (const l of llamadas) expect(headersDe(l.init).authorization).toBe("Bearer s3cr3t0");
  });

  it("un secreto de sólo espacios cuenta como ausente (no se manda un `Bearer` vacío)", async () => {
    vi.stubEnv("KYC_AGENT_INVOKE_SECRET", "   ");
    responder(200, SESION_OK);
    await createAgentKycSession({});
    expect(headersDe((llamadas[0] as Llamada).init).authorization).toBeUndefined();
  });

  it("el secreto NUNCA aparece en un log, ni en el camino de fallo", async () => {
    vi.stubEnv("KYC_AGENT_INVOKE_SECRET", "s3cr3t0");
    responder(401, { error: "unauthorized" });
    const capturado: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) =>
      capturado.push(a.map((x) => JSON.stringify(x)).join(" ")),
    );
    await readAgentKycDecision({ sessionId: "s", decisionToken: "t" });
    expect(capturado.join("\n")).not.toContain("s3cr3t0");
  });
});

describe("T-CLI-5 · el techo de 10 s está en las DOS funciones", () => {
  it("los dos `fetch` llevan un `signal`", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    responder(200, SESION_OK);
    await createAgentKycSession({});
    responder(200, DECISION_OK);
    await readAgentKycDecision({ sessionId: "s", decisionToken: "t" });
    // 🧬 MUTANTE: sacar el `signal` de cualquiera de las dos ⇒ el `signal` es undefined ⇒ ROJO.
    for (const l of llamadas) expect(l.init.signal).toBeDefined();
    expect(spy.mock.calls.map(([ms]) => ms)).toEqual([10_000, 10_000]);
  });
});

describe("el host se resuelve fail-closed también desde el cliente", () => {
  it("sin `KYC_AGENT_BASE_URL` las dos funciones TIRAN antes de cualquier fetch", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", undefined);
    responder(200, SESION_OK);
    await expect(createAgentKycSession({})).rejects.toThrow(/kyc_agent_base_url_unset/);
    await expect(readAgentKycDecision({ sessionId: "s", decisionToken: "t" })).rejects.toThrow(
      /kyc_agent_base_url_unset/,
    );
    // Lo que importa no es el throw: es que NO se gastó un viaje al agente.
    expect(llamadas).toHaveLength(0);
  });
});
