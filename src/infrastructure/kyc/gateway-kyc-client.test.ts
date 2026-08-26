// T-C4 / T-C6 / T-C8 / T-C11 (WKH-366 · AC-9 / AC-7' / AC-10) — el transporte por Coordinador.
//
// Todos los asserts miran lo que SALE del proceso (el body del `/compose`, sus cabeceras, las claves
// del input) o el desenlace EXACTO de una respuesta construida a mano. Ninguno mira un status: un
// test sobre el status no distingue "se mandó bien" de "se mandó cualquier cosa y el doble contestó
// 200 igual".
//
// ⛔ CD-7: esto dobla `fetch`, así que NO prueba el cableado. Prueba decisiones.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPSTREAM_GATEWAY_AGENT_MISMATCH,
  UPSTREAM_GATEWAY_BRIDGE_PRESENT,
  UPSTREAM_GATEWAY_FAILURE,
  createAgentKycSessionViaGateway,
  readAgentKycDecisionViaGateway,
} from "./gateway-kyc-client";

const GATEWAY = "https://gw.test";
const KEY = "ak_de_test";
/** El host del agente según la ENV DEL DEPLOY. Es contra esto que N3/parte-B compara (fix-pack AR). */
const AGENTE = "https://agentes.test";
/** La `invokeUrl` que el Coordinador reporta cuando el ejecutor es de verdad el nuestro. */
const INVOKE_PROPIA = `${AGENTE}/api/agents/remit-kyc-decision/invoke`;

const SESION_OK = {
  sessionId: "ses-1",
  url: "https://verificacion.example/ses-1",
  decisionToken: "k1.tok",
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

interface Llamada {
  url: string;
  init: RequestInit;
}
let llamadas: Llamada[] = [];

/** Arma la respuesta de `/compose`: un step, con el ejecutor y los extras que le pidan. */
function pasoDe(
  output: unknown,
  opts: {
    slug?: string;
    registry?: string | null;
    /** `null` ⇒ el step llega SIN la clave `invokeUrl` (el gateway no la dijo). */
    invokeUrl?: string | null;
    sinAgent?: boolean;
    bridgeType?: unknown;
  } = {},
): Record<string, unknown> {
  const step: Record<string, unknown> = { output };
  if (!opts.sinAgent) {
    const agent: Record<string, unknown> = { slug: opts.slug ?? "remit-kyc-session" };
    if (opts.registry !== null) agent.registry = opts.registry ?? "self-published";
    // El default es una URL del MISMO origen que la env stubeada: sin esto, todo `it` de este archivo
    // se pondría rojo por la parte B de N3 y ninguno mediría lo que dice medir.
    if (opts.invokeUrl !== null) agent.invokeUrl = opts.invokeUrl ?? INVOKE_PROPIA;
    step.agent = agent;
  }
  if ("bridgeType" in opts) step.bridgeType = opts.bridgeType;
  return step;
}

function responder(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: RequestInit) => {
      llamadas.push({ url: String(url), init });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as unknown as Response;
    }),
  );
}

/** El happy path del step de sesión, parametrizable. */
function responderSesion(
  output: unknown = SESION_OK,
  opts: Parameters<typeof pasoDe>[1] = {},
): void {
  responder({ success: true, steps: [pasoDe(output, { slug: "remit-kyc-session", ...opts })] });
}

function responderDecision(
  output: unknown = DECISION_OK,
  opts: Parameters<typeof pasoDe>[1] = {},
): void {
  responder({ success: true, steps: [pasoDe(output, { slug: "remit-kyc-decision", ...opts })] });
}

const bodyDe = (i = 0) => JSON.parse(String(llamadas[i]?.init.body));
const inputDe = (i = 0) => bodyDe(i).steps[0].input as Record<string, unknown>;

beforeEach(() => {
  llamadas = [];
  vi.stubEnv("WASIAI_A2A_GATEWAY_URL", GATEWAY);
  vi.stubEnv("WASIAI_A2A_AGENT_KEY", KEY);
  // 🔴 La env del DEPLOY contra la que N3/parte-B compara el origen del ejecutor. No es decorado: sin
  // ella `expectedAgentOrigin()` da `null` y NADA autoriza (fail-closed), que es lo que mide el `it`
  // «sin `KYC_AGENT_BASE_URL`» de más abajo.
  vi.stubEnv("KYC_AGENT_BASE_URL", AGENTE);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("T-C4 · el body lleva `agent`, NUNCA `capability`, y va UN SOLO step", () => {
  it.each([
    [
      "session",
      "remit-kyc-session",
      async () => {
        responderSesion();
        await createAgentKycSessionViaGateway({ identityRef: "4AvAjtGgPq" });
      },
    ],
    [
      "decision",
      "remit-kyc-decision",
      async () => {
        responderDecision();
        await readAgentKycDecisionViaGateway({ sessionId: "ses-1", decisionToken: "k1.tok" });
      },
    ],
  ])("la rama %s pinea el slug `%s`", async (_rama, slug, correr) => {
    await correr();
    const body = bodyDe();
    // 🧬 MUTANTE: emitir `{capability: "kyc-…"}` en vez de `{agent: slug}` ⇒ ROJO acá. Es el mutante
    // que importa: delegar la elección cambia QUIÉN contesta `payoutAllowed`.
    expect(body.steps).toHaveLength(1);
    expect(Object.keys(body.steps[0])).toEqual(["agent", "input"]);
    expect(body.steps[0].agent).toBe(slug);
    expect(String(llamadas[0]?.init.body)).not.toContain("capability");
    expect(llamadas[0]?.url).toBe(`${GATEWAY}/compose`);
    const headers = llamadas[0]?.init.headers as Record<string, string>;
    expect(headers["x-a2a-key"]).toBe(KEY);
  });

  it("un step único cierra CD-2 por ESTRUCTURA: no hay `siguiente` al que puentear", async () => {
    responderDecision();
    await readAgentKycDecisionViaGateway({ sessionId: "ses-1", decisionToken: "k1.tok" });
    // El bridge del Coordinador corre sólo dentro de `if (i < steps.length - 1)`. Con un solo step
    // ese bloque es inalcanzable. `bridged` (abajo) es el cinturón sobre este tirante.
    expect(bodyDe().steps).toHaveLength(1);
  });
});

describe("T-C11 · P-4: sin el dato, LA CLAVE SE OMITE (⛔ nunca `null`)", () => {
  // 🧬 MUTANTE: `identityRef: input.identityRef ?? null` ⇒ la clave aparece ⇒ ROJO. Y no es
  // cosmético: el schema del agente es `.strict()` y un `null` donde espera un string es un 400.
  it("session sin `identityRef` ⇒ el input es {} (cero claves)", async () => {
    responderSesion();
    await createAgentKycSessionViaGateway({});
    expect(Object.keys(inputDe()).sort()).toEqual([]);
  });

  it("session con `identityRef` ⇒ el input es exactamente ['identityRef']", async () => {
    responderSesion();
    await createAgentKycSessionViaGateway({ identityRef: "4AvAjtGgPq" });
    expect(Object.keys(inputDe()).sort()).toEqual(["identityRef"]);
    expect(inputDe().identityRef).toBe("4AvAjtGgPq");
  });

  it("decision sin `identityClaim` ⇒ exactamente ['decisionToken','sessionId']", async () => {
    responderDecision();
    await readAgentKycDecisionViaGateway({ sessionId: "ses-1", decisionToken: "k1.tok" });
    expect(Object.keys(inputDe()).sort()).toEqual(["decisionToken", "sessionId"]);
  });

  it("decision con `identityClaim` ⇒ exactamente las tres claves", async () => {
    responderDecision();
    await readAgentKycDecisionViaGateway({
      sessionId: "ses-1",
      identityClaim: "4AvAjtGgPq",
      decisionToken: "k1.tok",
    });
    expect(Object.keys(inputDe()).sort()).toEqual([
      "decisionToken",
      "identityClaim",
      "sessionId",
    ]);
  });
});

describe("T-C6 · CD-2: un bridge REPORTADO sobre el step ⇒ no hay veredicto", () => {
  // 🧬 MUTANTE: ignorar el campo ⇒ las cuatro primeras filas se ponen rojas.
  // 🧬 MUTANTE: enumerar sólo `"LLM"` ⇒ se ponen rojas las filas 2, 3 y 4. Es EL mutante que este
  // `it` existe para matar: se mide PRESENCIA, no valor, porque el vocabulario del campo lo controla
  // el Coordinador y cualquier valor nuevo que agregue mañana sería fail-OPEN.
  it.each([["LLM"], ["SKIPPED"], ["CACHE_L1"], [123], [null], [false]])(
    "`bridgeType: %s` (presente) ⇒ { ok:false, upstream:-4 }",
    async (valor) => {
      responderDecision(DECISION_OK, { bridgeType: valor });
      const r = await readAgentKycDecisionViaGateway({ sessionId: "ses-1", decisionToken: "t" });
      expect(r).toEqual({ ok: false, upstream: UPSTREAM_GATEWAY_BRIDGE_PRESENT });
      expect(UPSTREAM_GATEWAY_BRIDGE_PRESENT).toBe(-4);
    },
  );

  it("✅ calibración: SIN la clave, el mismo 200 pasa (el guard no deniega todo)", async () => {
    responderDecision();
    const r = await readAgentKycDecisionViaGateway({ sessionId: "ses-1", decisionToken: "t" });
    expect(r).toEqual({ ok: true, output: DECISION_OK });
  });

  it("✅ calibración: `bridgeType: undefined` es AUSENCIA, y pasa", async () => {
    responderDecision(DECISION_OK, { bridgeType: undefined });
    const r = await readAgentKycDecisionViaGateway({ sessionId: "ses-1", decisionToken: "t" });
    expect(r).toEqual({ ok: true, output: DECISION_OK });
  });
});

describe("N3/parte-B 🔴 el ORIGEN del ejecutor contra la env del DEPLOY (fix-pack AR/BLQ-ALTO-1)", () => {
  // 🔴 POR QUÉ ESTE `describe` EXISTE. El par `(slug, registry)` que mide el `describe` de abajo lo
  // puede publicar CUALQUIER caller autenticado del Coordinador: `POST /agents` es auth-only y el
  // slug es PK global primero-que-llega, y una fila self-published nace con `registry:
  // "self-published"` hardcodeado. O sea que las cuatro filas de abajo describen a un impostor
  // TORPE. Un impostor que se apropie del slug las pasa TODAS. Lo que no puede elegir es el origen
  // de `KYC_AGENT_BASE_URL`, que vive en el deploy.
  //
  // ⚠️ ESTE ARCHIVO NO ES DONDE SE DEMUESTRA EL DAÑO. Acá el desenlace es `{ok:false}`; que ese
  // `{ok:false}` NO AUTORICE UN DESEMBOLSO lo demuestra T-C5c en `../payout/authority.gateway.test.ts`.
  it.each<[string, string]>([
    ["el host del atacante", "https://evil.example/api/agents/remit-kyc-decision/invoke"],
    ["un dominio que TERMINA en el nuestro", "https://evil-agentes.test/api/x"],
    ["el nuestro como SUBdominio del atacante", "https://agentes.test.evil.example/api/x"],
    ["🔴 userinfo: el texto empieza con el nuestro y el host es otro", "https://agentes.test@evil.example/api/x"],
    ["un puerto que no es el default", "https://agentes.test:8443/api/x"],
    ["`http:` donde el deploy dice `https:`", "http://agentes.test/api/x"],
    ["una URL relativa", "/api/agents/remit-kyc-decision/invoke"],
    ["texto que no es una URL", "agentes.test"],
  ])("`invokeUrl` = %s ⇒ { ok:false, upstream:-3 }", async (_caso, invokeUrl) => {
    responder({
      success: true,
      steps: [pasoDe(DECISION_OK, { slug: "remit-kyc-decision", invokeUrl })],
    });
    const r = await readAgentKycDecisionViaGateway({ sessionId: "ses-1", decisionToken: "t" });
    expect(r).toEqual({ ok: false, upstream: UPSTREAM_GATEWAY_AGENT_MISMATCH });
  });

  it("🔴 el par PERFECTO con `invokeUrl` de otro host tampoco pasa (el par NO es el guard)", async () => {
    // 🧬 EL MUTANTE: borrar el bloque `2b` de `invocarPineado` ⇒ ROJO. Es la reproducción exacta del
    // BLQ-ALTO-1: slug correcto, `registry:"self-published"`, `payoutAllowed:true`, y el ejecutor es
    // el impostor. Antes del fix-pack esto devolvía `{ok:true}`.
    responder({
      success: true,
      steps: [
        pasoDe(DECISION_OK, {
          slug: "remit-kyc-decision",
          registry: "self-published",
          invokeUrl: "https://evil.example/api/agents/remit-kyc-decision/invoke",
        }),
      ],
    });
    const r = await readAgentKycDecisionViaGateway({ sessionId: "ses-1", decisionToken: "t" });
    expect(r).toEqual({ ok: false, upstream: UPSTREAM_GATEWAY_AGENT_MISMATCH });
  });

  it("`invokeUrl` AUSENTE ⇒ rechazo (⛔ no se trata como «el gateway no lo dijo, seguí»)", async () => {
    responder({
      success: true,
      steps: [pasoDe(DECISION_OK, { slug: "remit-kyc-decision", invokeUrl: null })],
    });
    const r = await readAgentKycDecisionViaGateway({ sessionId: "ses-1", decisionToken: "t" });
    expect(r).toEqual({ ok: false, upstream: UPSTREAM_GATEWAY_AGENT_MISMATCH });
  });

  it("🔴 sin `KYC_AGENT_BASE_URL` NADA autoriza, ni con el ejecutor correcto (fail-closed)", async () => {
    // 🧬 MUTANTE: `esperado === null ⇒ saltear el chequeo` (el clásico "si no puedo verificar, dejo
    // pasar") ⇒ ROJO. Y el `it` de calibración de más abajo demuestra que la MISMA respuesta pasa
    // cuando la env está: la diferencia es la env, no el escenario.
    vi.stubEnv("KYC_AGENT_BASE_URL", undefined);
    responderDecision();
    const r = await readAgentKycDecisionViaGateway({ sessionId: "ses-1", decisionToken: "t" });
    expect(r).toEqual({ ok: false, upstream: UPSTREAM_GATEWAY_AGENT_MISMATCH });
  });

  it.each<[string, string]>([
    ["mayúsculas en el host", "https://AGENTES.TEST/api/agents/remit-kyc-decision/invoke"],
    ["`:443` explícito (es el default de https)", "https://agentes.test:443/api/x"],
    ["otra ruta del MISMO host (la ruta no se compara)", "https://agentes.test/cualquier/cosa"],
  ])("✅ calibración: %s SÍ pasa", async (_caso, invokeUrl) => {
    responder({
      success: true,
      steps: [pasoDe(DECISION_OK, { slug: "remit-kyc-decision", invokeUrl })],
    });
    const r = await readAgentKycDecisionViaGateway({ sessionId: "ses-1", decisionToken: "t" });
    expect(r).toEqual({ ok: true, output: DECISION_OK });
  });
});

describe("N3/parte-A · el par (slug esperado, self-published) — cinturón, NO el guard", () => {
  // ⚠️ Este par lo elige el publicador: ver el docblock de `EXPECTED_REGISTRY`. Lo que estas cuatro
  // filas cazan es un impostor torpe y —lo que de verdad importa— la degradación al fanout federado
  // de `discoveryService.getAgent`, que no necesita atacante.
  it.each<[string, Parameters<typeof pasoDe>[1]]>([
    ["slug ajeno", { slug: "evil-kyc" }],
    ["registry ajeno", { registry: "un-registry-cualquiera" }],
    ["registry AUSENTE", { registry: null }],
    ["sin `agent` (agents[0] === null)", { sinAgent: true }],
  ])("%s ⇒ { ok:false, upstream:-3 }", async (_caso, opts) => {
    responder({ success: true, steps: [pasoDe(DECISION_OK, { slug: "remit-kyc-decision", ...opts })] });
    const r = await readAgentKycDecisionViaGateway({ sessionId: "ses-1", decisionToken: "t" });
    expect(r).toEqual({ ok: false, upstream: UPSTREAM_GATEWAY_AGENT_MISMATCH });
  });

  it("el slug se compara CONTRA EL DE LA RAMA: el de sesión no vale para la decisión", async () => {
    // 🧬 MUTANTE: comparar contra una constante única (o contra `ref.slug !== ""`) ⇒ ROJO. Los dos
    // steps son agentes distintos y cruzarlos sería adoptar el veredicto del que no se preguntó.
    responder({ success: true, steps: [pasoDe(DECISION_OK, { slug: "remit-kyc-session" })] });
    const r = await readAgentKycDecisionViaGateway({ sessionId: "ses-1", decisionToken: "t" });
    expect(r).toEqual({ ok: false, upstream: UPSTREAM_GATEWAY_AGENT_MISMATCH });
  });

  it("✅ calibración: con el par correcto, el MISMO 200 pasa", async () => {
    responderDecision();
    expect(await readAgentKycDecisionViaGateway({ sessionId: "s", decisionToken: "t" })).toEqual({
      ok: true,
      output: DECISION_OK,
    });
  });
});

describe("T-C8 / CD-19 · el borde se ESTRECHA, no se castea, y con los mismos códigos", () => {
  it("`payoutAllowed: \"true\"` (el STRING) ⇒ THROW, no un booleano truthy", async () => {
    // 🧬 MUTANTE: `Boolean(raw.payoutAllowed)` en vez de `readBoolean` ⇒ el string pasa como `true`
    // ⇒ ROJO. Y el daño sería un desembolso autorizado por un tipo equivocado.
    responderDecision({ ...DECISION_OK, payoutAllowed: "true" });
    await expect(
      readAgentKycDecisionViaGateway({ sessionId: "s", decisionToken: "t" }),
    ).rejects.toThrow("kyc_agent_bad_response:decision:payoutAllowed");
  });

  it("`payoutAllowed: false` NO se colapsa con lo anterior: es un veredicto válido", async () => {
    responderDecision({ ...DECISION_OK, payoutAllowed: false });
    const r = await readAgentKycDecisionViaGateway({ sessionId: "s", decisionToken: "t" });
    expect(r.ok && r.output.payoutAllowed).toBe(false);
  });

  it.each([
    ["falta `decisionToken`", { sessionId: "s", url: "u", provenance: "d" }, "session:decisionToken"],
    ["falta `sessionId`", { url: "u", decisionToken: "t", provenance: "d" }, "session:sessionId"],
    ["`url` no es string", { sessionId: "s", url: 7, decisionToken: "t", provenance: "d" }, "session:url"],
  ])("session con %s ⇒ THROW con el MISMO código que el directo", async (_c, output, code) => {
    responderSesion(output);
    await expect(createAgentKycSessionViaGateway({})).rejects.toThrow(
      `kyc_agent_bad_response:${code}`,
    );
  });

  it("`riskLevel` fuera del enum ⇒ THROW", async () => {
    responderDecision({ ...DECISION_OK, riskLevel: "altísimo" });
    await expect(
      readAgentKycDecisionViaGateway({ sessionId: "s", decisionToken: "t" }),
    ).rejects.toThrow("kyc_agent_bad_response:decision:riskLevel");
  });

  it("`reasons` con un no-string adentro ⇒ THROW", async () => {
    responderDecision({ ...DECISION_OK, reasons: ["ok", 7] });
    await expect(
      readAgentKycDecisionViaGateway({ sessionId: "s", decisionToken: "t" }),
    ).rejects.toThrow("kyc_agent_bad_response:decision:reasons");
  });

  it("un output que NO es un objeto ⇒ el gateway ya lo corta como fallo, no como veredicto", async () => {
    // `runViaGateway` devuelve `bad_response` cuando `steps[i].output` no es un record, así que acá
    // el desenlace es el sentinela de fallo y no un throw. Se fija para que quede escrito cuál de
    // los dos caminos toma, en vez de descubrirlo en producción.
    responderDecision(7);
    expect(await readAgentKycDecisionViaGateway({ sessionId: "s", decisionToken: "t" })).toEqual({
      ok: false,
      upstream: UPSTREAM_GATEWAY_FAILURE,
    });
  });

  it("`identityMatches` ausente se preserva AUSENTE (⛔ nunca `?? false`)", async () => {
    responderDecision();
    const r = await readAgentKycDecisionViaGateway({ sessionId: "s", decisionToken: "t" });
    expect(r.ok && "identityMatches" in r.output).toBe(false);
  });

  it("`identityMatches: false` explícito SÍ viaja como false", async () => {
    responderDecision({ ...DECISION_OK, payoutAllowed: false, identityMatches: false });
    const r = await readAgentKycDecisionViaGateway({ sessionId: "s", decisionToken: "t" });
    expect(r.ok && r.output.identityMatches).toBe(false);
  });

  it("`identityMatches` mal tipado ⇒ THROW (⛔ no se normaliza)", async () => {
    responderDecision({ ...DECISION_OK, identityMatches: "true" });
    await expect(
      readAgentKycDecisionViaGateway({ sessionId: "s", decisionToken: "t" }),
    ).rejects.toThrow("kyc_agent_bad_response:decision:identityMatches");
  });

  it("una clave DESCONOCIDA no tira y NO se cuela (los dos transportes toleran igual)", async () => {
    // `lifecycle` es el caso real: el agente lo devuelve y el transporte directo no lo lee. Si este
    // lector fuera estricto, un campo que el agente agrega y después revierte cortaría el KYC entero.
    responderDecision({ ...DECISION_OK, lifecycle: "pending" });
    const r = await readAgentKycDecisionViaGateway({ sessionId: "s", decisionToken: "t" });
    expect(r).toEqual({ ok: true, output: DECISION_OK });
  });
});

describe("la config ausente sale por el MISMO sentinela, sin un solo fetch", () => {
  it.each([["WASIAI_A2A_GATEWAY_URL"], ["WASIAI_A2A_AGENT_KEY"]])(
    "sin %s ⇒ { ok:false, upstream:-2 } y CERO llamadas",
    async (env) => {
      vi.stubEnv(env, undefined);
      responderDecision();
      const r = await readAgentKycDecisionViaGateway({ sessionId: "s", decisionToken: "t" });
      expect(r).toEqual({ ok: false, upstream: UPSTREAM_GATEWAY_FAILURE });
      expect(llamadas).toHaveLength(0);
    },
  );

  it("los tres sentinelas son NEGATIVOS y DISTINTOS entre sí y del -1 del directo", () => {
    // Sin esto, dos sentinelas iguales colapsarían dos causas que se arreglan distinto y nada se
    // pondría rojo. El `-1` es `UPSTREAM_INVOKE_SECRET_UNSET` del transporte directo.
    const todos = [
      UPSTREAM_GATEWAY_FAILURE,
      UPSTREAM_GATEWAY_AGENT_MISMATCH,
      UPSTREAM_GATEWAY_BRIDGE_PRESENT,
    ];
    expect(todos).toEqual([-2, -3, -4]);
    expect(new Set([...todos, -1, 0]).size).toBe(5);
  });
});
