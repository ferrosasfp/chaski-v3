// T-C1 / T-C2 / T-C3 (WKH-366 · AC-8) — la bandera `KYC_TRANSPORT`, y el CERO CAMBIO OBSERVABLE.
//
// 🔴 QUÉ MIDE ESTE ARCHIVO, Y POR QUÉ ASÍ. La afirmación que WKH-366 tiene que sostener en W3 no es
// "el camino nuevo anda": es que **con la bandera ausente o en `direct` no cambió NADA**. Eso no se
// puede medir mirando el status de la respuesta —el doble contesta 200 igual, se haya mandado lo
// correcto o cualquier cosa—, así que acá se mide:
//   · CONTANDO a qué HOST salió cada llamada (T-C1). Un contador en cero de un lado y ≥1 del otro es
//     falsable; "devolvió ok" no lo es.
//   · con un SNAPSHOT del `RequestInit` (T-C2), tomado del `main` PREVIO a esta HU.
//
// ⚠️ NINGÚN `it` de acá prueba el CABLEADO real (CD-7): todos doblan `fetch`. Lo que prueban son
// DECISIONES. El cableado contra servicios desplegados lo mide `scripts/smoke-kyc-via-gateway.ts`,
// y ninguno de los dos reemplaza al otro.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentKycSession, readAgentKycDecision, readKycTransport } from "./kyc-transport";

const AGENT_BASE = "https://agentes.test";
const GATEWAY_BASE = "https://gw.test";
const SECRETO = "invoke-secret-de-test";

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

/**
 * Un solo doble para los DOS hosts. Es lo que hace que "cero llamadas al otro" sea un assert y no una
 * suposición: si el despachador mandara al host equivocado, la llamada quedaría igualmente anotada.
 *
 * Del lado del gateway contesta un `/compose` VÁLIDO Y CON EL EJECUTOR ESPERADO: si contestara
 * cualquier cosa, T-C1 no podría distinguir "fue al gateway y el gateway rechazó" de "no fue".
 *
 * 🔴 Y «EL EJECUTOR ESPERADO» YA NO ES SÓLO EL PAR `(slug, registry)` (fix-pack AR/BLQ-ALTO-1): el
 * ejecutor tiene que traer una `invokeUrl` cuyo ORIGEN sea el de `KYC_AGENT_BASE_URL`, o el
 * transporte rechaza fail-closed. Se compone con `AGENT_BASE` —la MISMA constante que se siembra en
 * la env— a propósito: si se escribiera el host a mano, el día que una de las dos cambie este doble
 * empezaría a rechazar y el `it` fallaría por el motivo equivocado.
 */
function doblarFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: RequestInit) => {
      const u = String(url);
      llamadas.push({ url: u, init });
      if (u.startsWith(GATEWAY_BASE)) {
        const step = JSON.parse(String(init.body)).steps[0];
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            steps: [
              {
                output: step.agent === "remit-kyc-session" ? SESION_OK : DECISION_OK,
                agent: {
                  slug: step.agent,
                  registry: "self-published",
                  invokeUrl: `${AGENT_BASE}/api/agents/${step.agent}/invoke`,
                },
              },
            ],
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => (u.includes("/session") ? SESION_OK : DECISION_OK),
      } as unknown as Response;
    }),
  );
}

const alAgente = () => llamadas.filter((l) => l.url.startsWith(AGENT_BASE)).length;
const alGateway = () => llamadas.filter((l) => l.url.startsWith(GATEWAY_BASE)).length;

beforeEach(() => {
  llamadas = [];
  // Las CUATRO envs sembradas SIEMPRE, en los dos sentidos. Si sólo se sembraran las del transporte
  // que toca, un `it` podría pasar porque el otro camino ni siquiera podía salir, y estaríamos
  // midiendo una config ausente en vez de la bandera. (Y `KYC_AGENT_BASE_URL` presente bajo
  // `gateway` no es decorado: sigue siendo obligatoria, G-5.)
  vi.stubEnv("KYC_AGENT_BASE_URL", AGENT_BASE);
  vi.stubEnv("KYC_AGENT_INVOKE_SECRET", SECRETO);
  vi.stubEnv("WASIAI_A2A_GATEWAY_URL", GATEWAY_BASE);
  vi.stubEnv("WASIAI_A2A_AGENT_KEY", "ak_de_test");
  doblarFetch();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("T-C1 — la bandera conmuta, y se mide CONTANDO a qué host salió la llamada", () => {
  // 🧬 MUTANTE: invertir el default (`=== "direct" ? "direct" : "gateway"`) ⇒ las dos primeras filas
  // se ponen rojas, porque el conteo del gateway pasa de 0 a 2.
  it.each([
    ["ausente", undefined],
    ["direct", "direct"],
  ])("con KYC_TRANSPORT %s: ≥1 llamada al AGENTE y CERO al gateway", async (_caso, valor) => {
    vi.stubEnv("KYC_TRANSPORT", valor);
    await createAgentKycSession({ identityRef: "4AvAjtGgPq" });
    await readAgentKycDecision({ sessionId: "ses-1", decisionToken: "k1.tok" });
    expect(alAgente()).toBeGreaterThanOrEqual(1);
    expect(alGateway()).toBe(0);
    expect(readKycTransport()).toBe("direct");
  });

  it("con KYC_TRANSPORT=gateway: ≥1 llamada al GATEWAY y CERO al agente", async () => {
    vi.stubEnv("KYC_TRANSPORT", "gateway");
    const s = await createAgentKycSession({ identityRef: "4AvAjtGgPq" });
    const d = await readAgentKycDecision({ sessionId: "ses-1", decisionToken: "k1.tok" });
    expect(alGateway()).toBeGreaterThanOrEqual(1);
    expect(alAgente()).toBe(0);
    expect(readKycTransport()).toBe("gateway");
    // Y que el camino nuevo devuelva el MISMO shape que el viejo: si devolviera otra cosa, el
    // conteo de arriba sería verde con un transporte que no sirve.
    expect(s).toEqual({ ok: true, output: SESION_OK });
    expect(d).toEqual({ ok: true, output: DECISION_OK });
  });
});

describe("T-C2 — con `direct`, el `RequestInit` es BYTE-IDÉNTICO al de antes de WKH-366", () => {
  // 🔴 DE DÓNDE SALEN ESTOS CUATRO REGISTROS. No se escribieron a ojo: se capturaron el 2026-08-26
  // corriendo el cliente directo sobre el `main` PREVIO a esta HU, volcando `init` tal cual llega al
  // `fetch`. Por eso el body va como STRING y no parseado: el orden de las claves también es parte
  // de "byte-idéntico", y `JSON.parse` lo borra.
  //
  // 🧬 MUTANTE: tocar el cuerpo del cliente directo —agregar un header, mandar `identityRef: null`
  // en vez de omitir la clave, mover el `decisionToken` al query— ⇒ ROJO en la fila que le toca.
  it("las 4 llamadas del cliente directo salen exactamente como salían", async () => {
    vi.stubEnv("KYC_TRANSPORT", "direct");
    await createAgentKycSession({ identityRef: "4AvAjtGgPq" });
    await createAgentKycSession({});
    await readAgentKycDecision({
      sessionId: "ses-1",
      identityClaim: "4AvAjtGgPq",
      decisionToken: "k1.tok",
    });
    await readAgentKycDecision({ sessionId: "ses-1", decisionToken: "k1.tok" });

    expect(
      llamadas.map((l) => ({
        url: l.url,
        method: l.init.method ?? "(sin method)",
        headers: l.init.headers,
        body: l.init.body ?? "(sin body)",
        signal: l.init.signal?.constructor?.name ?? "(sin signal)",
      })),
    ).toEqual([
      {
        url: `${AGENT_BASE}/api/agents/remit-kyc-validator/session`,
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRETO}` },
        body: '{"identityRef":"4AvAjtGgPq"}',
        signal: "AbortSignal",
      },
      {
        url: `${AGENT_BASE}/api/agents/remit-kyc-validator/session`,
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRETO}` },
        body: "{}",
        signal: "AbortSignal",
      },
      {
        url: `${AGENT_BASE}/api/agents/remit-kyc-validator/decision?sessionId=ses-1&identityClaim=4AvAjtGgPq`,
        method: "(sin method)",
        headers: { "x-kyc-decision-token": "k1.tok", authorization: `Bearer ${SECRETO}` },
        body: "(sin body)",
        signal: "AbortSignal",
      },
      {
        url: `${AGENT_BASE}/api/agents/remit-kyc-validator/decision?sessionId=ses-1`,
        method: "(sin method)",
        headers: { "x-kyc-decision-token": "k1.tok", authorization: `Bearer ${SECRETO}` },
        body: "(sin body)",
        signal: "AbortSignal",
      },
    ]);
  });
});

describe("T-C3 — SÓLO el literal exacto tras `.trim()` enciende el camino nuevo", () => {
  // ⚠️ CADA FILA ES SU PROPIO `it`, Y NO UN BARRIDO DENTRO DE UNO SOLO. `vi.stubEnv` no se deshace
  // entre iteraciones del mismo `it`, así que un barrido en un `for` mediría el último valor pegado
  // a los anteriores. Y cada fila asserta el DESENLACE POSITIVO de su rama (a qué host salió), no
  // sólo la ausencia de algo malo: un barrido que sólo verifica ausencias pasa igual cuando no
  // ejecutó nada.
  //
  // 🧬 MUTANTE: `toLowerCase()` ⇒ la fila `"GATEWAY"` se pone roja. 🧬 MUTANTE: truthiness
  // (`Boolean(process.env.KYC_TRANSPORT)`) ⇒ se ponen rojas `"GATEWAY"`, `"1"`, `"true"` y `"direct"`.
  // 🧬 MUTANTE: sacar el `.trim()` ⇒ se ponen rojas `" gateway"` y `"gateway "`.
  it.each<[string, string | undefined, "direct" | "gateway"]>([
    ["ausente", undefined, "direct"],
    ["direct", "direct", "direct"],
    ["gateway", "gateway", "gateway"],
    [" gateway (trim ⇒ SÍ enciende)", " gateway", "gateway"],
    ["gateway  (trim ⇒ SÍ enciende)", "gateway ", "gateway"],
    ["GATEWAY", "GATEWAY", "direct"],
    ["Gateway", "Gateway", "direct"],
    ["1", "1", "direct"],
    ["true", "true", "direct"],
    ["cadena vacía", "", "direct"],
    ["gatewayy", "gatewayy", "direct"],
    ["a2a-gateway", "a2a-gateway", "direct"],
  ])("«%s» ⇒ %s", async (_caso, valor, esperado) => {
    vi.stubEnv("KYC_TRANSPORT", valor);
    expect(readKycTransport()).toBe(esperado);
    // El desenlace, no la lectura: a qué host salió de verdad la llamada.
    await createAgentKycSession({});
    expect(alGateway()).toBe(esperado === "gateway" ? 1 : 0);
    expect(alAgente()).toBe(esperado === "direct" ? 1 : 0);
  });
});
