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

// ⚠️ EL DEFAULT DE `KYC_AGENT_INVOKE_SECRET` CAMBIÓ EN EL FIX-PACK DE WKH-233 (H-3): era `undefined`,
// y desde que la credencial es OBLIGATORIA ese default haría tirar a TODOS los `it` del archivo antes
// de llegar a lo que miden (el body, el query, las cabeceras, los logs). Ahora el default es el camino
// feliz —la credencial presente— y los `it` que miden su AUSENCIA la sacan a propósito con su propio
// `vi.stubEnv(..., undefined)`. Es el mismo criterio que `KYC_AGENT_BASE_URL`, que también se siembra
// acá y sólo se saca en el `describe` que mide su guard.
const SECRETO_POR_DEFECTO = "invoke-secret-de-test";

beforeEach(() => {
  llamadas = [];
  vi.stubEnv("KYC_AGENT_BASE_URL", BASE);
  vi.stubEnv("KYC_AGENT_INVOKE_SECRET", SECRETO_POR_DEFECTO);
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
  // T-073-TOL-1/2 (HU 073 · W0) — CONGELA la tolerancia que YA existe, sin cambiar comportamiento.
  // Es el gate declarado hacia la HU hermana del agente: si el agente agrega un discriminador nuevo a
  // `GET /decision` y este lector fuera ESTRICTO, un rollback del agente cortaría el KYC entero
  // (ver el docblock de `readAgentKycDecision`, `./agent-kyc-client.ts:234`).
  it("T-073-TOL-1: una clave que el agente NO devuelve hoy no tira, y NO se cuela en `output`", async () => {
    responder(200, { ...DECISION_OK, unaClaveQueElAgenteNoDevuelveHoy: "x" });
    const r = await readAgentKycDecision({ sessionId: "ses-1", decisionToken: "t" });
    // 🧬 MUTANTE: reemplazar el estrechamiento por `raw as KycAgentDecisionOutput` ⇒ la clave desconocida
    // aparece en `output` ⇒ ROJO por el segundo assert.
    expect(r.ok, "una clave desconocida NO puede tirar: un agente más nuevo cortaría el KYC entero").toBe(
      true,
    );
    expect(
      r.ok && "unaClaveQueElAgenteNoDevuelveHoy" in r.output,
      "la clave desconocida se DESCARTA: el lector estrecha, no castea",
    ).toBe(false);
  });

  it("T-073-TOL-2 (control positivo): una clave CONOCIDA con el tipo equivocado SÍ tira", async () => {
    // ⛔ Sin este control, T-073-TOL-1 pasaría también con un lector que no valida NADA: ése es todo su
    // motivo. La tolerancia es a lo DESCONOCIDO, no a lo mal tipado.
    responder(200, { ...DECISION_OK, terminal: "si" });
    await expect(
      readAgentKycDecision({ sessionId: "ses-1", decisionToken: "t" }),
    ).rejects.toThrow(/kyc_agent_bad_response/);
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

// ⛔ ACÁ VIVÍA `T-CLI-4 · la cabecera de invoke se manda SÓLO si el secreto está`, Y SE RETIRÓ EN EL
// FIX-PACK DE WKH-233 (H-3). Su primer `it` afirmaba —verde, y verde desde siempre— que sin
// `KYC_AGENT_INVOKE_SECRET` *"la cabecera NO EXISTE (byte-idéntico a hoy)"*. O sea que la suite no es
// que no cazó el bug: **lo declaró el comportamiento correcto**. El agente encendió su guard el
// 2026-08-11, empezó a contestar 401 `credential_missing`, y este test siguió en verde ocho días
// mientras el 100 % de los usuarios veía "No pudimos verificar tu identidad".
//
// Lo reemplaza su INVERSO. El resto del bloque (el `it` del secreto presente, el de sólo-espacios y
// el de que el secreto no se loguea) se conserva: seguían siendo ciertos y siguen midiendo algo.
describe("T-CLI-4' · la credencial de invoke es OBLIGATORIA (fail-closed, WKH-233/H-3)", () => {
  it("sin `KYC_AGENT_INVOKE_SECRET`, las dos funciones TIRAN y NO se gasta ningún viaje", async () => {
    vi.stubEnv("KYC_AGENT_INVOKE_SECRET", undefined);
    responder(200, SESION_OK);
    await expect(createAgentKycSession({})).rejects.toThrow(/kyc_agent_invoke_secret_unset/);
    responder(200, DECISION_OK);
    await expect(readAgentKycDecision({ sessionId: "s", decisionToken: "t" })).rejects.toThrow(
      /kyc_agent_invoke_secret_unset/,
    );
    // 🧬 MUTANTE: volver al `return secret ? {...} : {}` ⇒ las dos resuelven ⇒ ROJO en los `rejects`.
    // Y lo que importa no es el throw: es que NO se le preguntó al agente por la identidad de una
    // persona sin poder acreditar quién pregunta. Mismo criterio que el guard del host, abajo.
    expect(llamadas, "se gastó un viaje al agente sin credencial").toHaveLength(0);
  });

  it("un secreto de sólo espacios TAMBIÉN tira: `Bearer ` pelado es peor que no salir", async () => {
    vi.stubEnv("KYC_AGENT_INVOKE_SECRET", "   ");
    responder(200, SESION_OK);
    await expect(createAgentKycSession({})).rejects.toThrow(/kyc_agent_invoke_secret_unset/);
    expect(llamadas).toHaveLength(0);
  });

  // 🔴 DÓNDE TIRA, MEDIDO. Si tirara en module-load, `next build` voltearía rutas que no le hablan al
  // agente y el orden de encendido (sembrar la env ANTES del deploy) dejaría de funcionar. Este `it`
  // importa el módulo con la env AUSENTE: si el import resuelve, la evaluación es perezosa.
  it("🔴 el módulo se puede IMPORTAR con la env ausente: tira en la llamada, no en el import", async () => {
    vi.stubEnv("KYC_AGENT_INVOKE_SECRET", undefined);
    const mod = await import("./agent-kyc-client");
    expect(typeof mod.createAgentKycSession).toBe("function");
    expect(typeof mod.readAgentKycDecision).toBe("function");
  });

  // 🧪 CONTROL POSITIVO: el error es el de la CREDENCIAL y no el del host. Sin esto, los `it` de
  // arriba pasarían igual si el throw viniera de `resolveKycAgentBaseUrl` por un `beforeEach` mal
  // armado, y estaríamos midiendo el guard viejo creyendo que medimos el nuevo.
  it("CONTROL: con el host presente y el secreto ausente, el error es el de la CREDENCIAL", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", BASE);
    vi.stubEnv("KYC_AGENT_INVOKE_SECRET", undefined);
    responder(200, SESION_OK);
    await expect(createAgentKycSession({})).rejects.toThrow(/kyc_agent_invoke_secret_unset/);
    await expect(createAgentKycSession({})).rejects.not.toThrow(/kyc_agent_base_url_unset/);
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

  // ⛔ ACÁ VIVÍA el `it` que afirmaba que un secreto de sólo espacios *"cuenta como ausente (no se
  // manda un `Bearer` vacío)"* y seguía adelante con la llamada. Es la misma bendición del fail-open
  // aplicada al valor en blanco, y lo reemplaza el `it` de sólo-espacios de arriba, que exige el
  // throw. El `.trim()` que lo detecta no cambió; lo que cambió es qué se hace con el resultado.

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

// ── T-CLI-4'' (fix-pack it2 · re-AR/BLQ-MED-2) — DÓNDE tira, y CON QUÉ ETIQUETA ────────────────────
//
// 🔴 QUÉ DEFECTO CIERRA. La 1ª iteración puso el fail-closed con `invokeAuthHeader()` DENTRO del `try`
// del `fetch`, así que su throw salía por el `catch` del transporte y el ÚNICO rastro que quedaba era
// `session_transport_failed` — la misma etiqueta que un DNS caído, un timeout o un connection reset.
// El fail-open costó ocho días **porque el diagnóstico no distinguía causas**; un fail-closed que
// colapsa una misconfig nuestra en "transporte" reintroduce ese daño con otro nombre.
//
// ⛔ ESTE `describe` VA AL FINAL DEL ARCHIVO: appendear no rota ninguna línea de las de arriba.
describe("T-CLI-4'' · la credencial se resuelve ANTES del `fetch`, y su log dice CONFIG", () => {
  /** Captura `console.warn` como texto plano, argumentos incluidos. */
  function espiarWarn(): () => string {
    const out: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) =>
      out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")),
    );
    return () => out.join("\n");
  }

  it("sin la credencial: CERO llamadas al `fetch` y el log dice `config`, no `transport`", async () => {
    vi.stubEnv("KYC_AGENT_INVOKE_SECRET", undefined);
    responder(200, SESION_OK);
    const leer = espiarWarn();
    await expect(createAgentKycSession({})).rejects.toThrow(/kyc_agent_invoke_secret_unset/);
    const salida = leer();
    // 1. No se gastó un viaje. Es el assert que distingue "tira antes" de "tira después".
    expect(llamadas, "salió un `fetch` sin credencial").toHaveLength(0);
    // 2. 🧬 MUTANTE: mover `invokeAuthHeader("session")` de vuelta ADENTRO del `try` ⇒ el log pasa a
    //    `session_transport_failed` ⇒ estas dos aserciones se ponen ROJAS (las dos, no una).
    expect(salida, "la misconfig se etiquetó como un fallo de transporte").not.toContain(
      "session_transport_failed",
    );
    expect(salida).toContain("session_config_missing");
    // 3. Y el log NOMBRA la env. Sin esto, el operador lee "algo de configuración" y adivina cuál.
    expect(salida).toContain("KYC_AGENT_INVOKE_SECRET");
  });

  it("lo mismo en la otra función: `decision_config_missing`, y ningún viaje", async () => {
    vi.stubEnv("KYC_AGENT_INVOKE_SECRET", undefined);
    responder(200, DECISION_OK);
    const leer = espiarWarn();
    await expect(readAgentKycDecision({ sessionId: "s", decisionToken: "t" })).rejects.toThrow(
      /kyc_agent_invoke_secret_unset/,
    );
    const salida = leer();
    expect(llamadas).toHaveLength(0);
    expect(salida).not.toContain("decision_transport_failed");
    expect(salida).toContain("decision_config_missing");
  });

  // 🧪 CONTROL POSITIVO, EN LA MISMA CORRIDA: la etiqueta `*_transport_failed` SIGUE EXISTIENDO y
  // sigue siendo la que se emite cuando el transporte REALMENTE se cae. Sin este `it`, los dos de
  // arriba pasarían igual si alguien borrara el `catch` del transporte entero: estarían comprobando
  // la ausencia de una cadena que ya no produce nadie.
  it("CONTROL: con la credencial puesta y el transporte caído, el log SÍ dice `transport`", async () => {
    vi.stubEnv("KYC_AGENT_INVOKE_SECRET", "s3cr3t0");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const e = new Error("connect ECONNREFUSED");
        e.name = "TypeError";
        throw e;
      }),
    );
    const leer = espiarWarn();
    await expect(createAgentKycSession({})).rejects.toThrow();
    const salida = leer();
    expect(salida).toContain("session_transport_failed");
    expect(salida).not.toContain("session_config_missing");
  });

  // 🔴 EL TIPO DEL ERROR ES LO QUE LAS ROUTES LEEN, y por eso se mide acá y no sólo en las routes:
  // sin una clase propia, el `upstream` de la misconfig tendría que salir de parsear el `message`, que
  // es value-free a propósito. El `instanceof` es el único canal que sobrevive hasta el body.
  it("el error es una `KycAgentConfigError` que NOMBRA la env (y un fallo de transporte NO lo es)", async () => {
    const mod = await import("./agent-kyc-client");
    vi.stubEnv("KYC_AGENT_INVOKE_SECRET", undefined);
    responder(200, SESION_OK);
    const err = await createAgentKycSession({}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(mod.KycAgentConfigError);
    expect((err as InstanceType<typeof mod.KycAgentConfigError>).env).toBe("KYC_AGENT_INVOKE_SECRET");
    // 🧪 CONTROL: el sentinela no puede chocar con un status HTTP real ni con el `0` del transporte.
    expect(mod.UPSTREAM_INVOKE_SECRET_UNSET).toBeLessThan(0);
  });
});
