// T-CARR-3 y el resto del adapter del navegador (WKH-233/W1). Exemplar: el test del adapter que este
// reemplaza. Lo que este archivo agrega y aquél no podía tener es la ASIMETRÍA de D-4.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KycGateway } from "../../application/ports";
import type { KycVerification } from "../../domain/remittance";
import { AgentKycGateway } from "./agent-kyc-gateway";

const simulada: KycVerification = {
  verificationId: "fb-1",
  approved: true,
  payoutAllowed: true, realVerified: false, verifiedAt: null,
  riskLevel: "low",
  provenance: "local-fallback",
  identity: null,
};
let fallbackDecisionLlamados = 0;
const fakeFallback: KycGateway = {
  start: async () => ({ kind: "completed", verification: simulada }),
  decision: async () => {
    fallbackDecisionLlamados += 1;
    return { terminal: true, verification: simulada };
  },
};
const req = {
  amountUsd: 400,
  beneficiary: { name: "Mamá", country: "PE", method: "yape" as const, destination: "999" },
  purpose: "test",
};

const DECISION_200 = {
  terminal: true,
  status: "Approved",
  approved: true,
  riskLevel: "low",
  verificationId: "s1",
  provenance: "didit",
  payoutAllowed: true,
  reasons: [],
  identityMatches: true,
  verifiedAt: "2026-08-19T10:00:00.000Z",
};

afterEach(() => {
  fallbackDecisionLlamados = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("T-CARR-3 · D-4 — la ASIMETRÍA entre `start` y `decision` ante un 501", () => {
  it("🔴 `decision` con 501 LANZA y NO delega en el fallback (no se fabrica un veredicto)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 501, ok: false })));
    const gw = new AgentKycGateway(fakeFallback);
    // 🧬 MUTANTE: `if (dres.status === 501) return this.fallback.decision(sessionId)` ⇒ resolvería con
    // `approved:true, payoutAllowed:true` sobre una verificación REAL ⇒ ROJO por los DOS asserts.
    await expect(gw.decision("s1", "tok")).rejects.toThrow(/kyc_decision_failed/);
    expect(
      fallbackDecisionLlamados,
      "el fallback contestó por una verificación real: eso no es fallar, es MENTIR",
    ).toBe(0);
  });

  it("✅ calibración: `start` con 501 SÍ delega y devuelve `completed` (el demo sigue andando)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 501, ok: false })));
    const res = await new AgentKycGateway(fakeFallback).start(req);
    expect(res.kind).toBe("completed");
    if (res.kind === "completed") expect(res.verification.provenance).toBe("local-fallback");
  });

  it("`decision` con 502 también lanza (misma rama fail-closed, sin fallback)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 502, ok: false })));
    await expect(new AgentKycGateway(fakeFallback).decision("s1", "tok")).rejects.toThrow(
      /kyc_decision_failed/,
    );
    expect(fallbackDecisionLlamados).toBe(0);
  });

  it("`start` con 500 lanza (NO usa el fallback: 501 es 'no configurado', 500 es 'se rompió')", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 500, ok: false })));
    await expect(new AgentKycGateway(fakeFallback).start(req)).rejects.toThrow(/kyc_session_failed/);
  });
});

describe("AgentKycGateway — el viaje del token HMAC de Chaski y el body de la sesión", () => {
  it("`start` manda `vendorData` (hint del limiter) y ⛔ NO manda `callback` (DT-11)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      status: 200,
      ok: true,
      json: async () => ({ sessionId: "s1", url: "https://verificacion.example/s1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await new AgentKycGateway(fakeFallback).start({
      ...req,
      senderAddress: "0xabc",
      callbackUrl: "https://chaski.example/kyc/callback",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.vendorData).toBe("0xabc");
    expect(Object.keys(body)).not.toContain("callback");
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain("kyc/callback");
  });

  it("el token viaja start()→decision(): se emite como `authToken` y vuelve como `x-kyc-token`", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ sessionId: "s1", url: "https://verificacion.example/s1", authToken: "hmac-tok" }),
      })),
    );
    const gw = new AgentKycGateway(fakeFallback);
    const started = await gw.start(req);
    expect(started.kind).toBe("redirect");
    const authToken = started.kind === "redirect" ? started.authToken : undefined;
    expect(authToken).toBe("hmac-tok");

    const decFetch = vi.fn(async (_url: string, _init: RequestInit) => ({
      status: 200,
      ok: true,
      json: async () => DECISION_200,
    }));
    vi.stubGlobal("fetch", decFetch);
    await gw.decision("s1", authToken);
    const headers = decFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-kyc-token"]).toBe("hmac-tok");
    // ⛔ Y el token del AGENTE no se conoce ni se manda desde el navegador (CD-20/CD-4).
    expect(headers["x-kyc-decision-token"]).toBeUndefined();
  });
});

describe("el mapeo de `decision` — los dos campos que no se pueden confundir (D-3)", () => {
  function conDecision(body: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 200, ok: true, json: async () => body })),
    );
    return new AgentKycGateway(fakeFallback).decision("s1", "tok");
  }

  it("`payoutAllowed` del dominio sale de `approved`; `realVerified` sale del `payoutAllowed` del agente", async () => {
    // El caso que separa los dos: el agente APROBÓ la identidad pero NO habilita el desembolso
    // (verificación simulada). El flujo tiene que llegar a `kyc_passed` igual —eso es `payoutAllowed`—
    // y la pantalla tiene que decir "sin verificar" —eso es `realVerified`—.
    const d = await conDecision({ ...DECISION_200, approved: true, payoutAllowed: false });
    // 🧬 MUTANTE: `payoutAllowed: d.payoutAllowed` ⇒ `false` ⇒ el flujo no llega a `kyc_passed` ⇒ ROJO.
    expect(d.verification.payoutAllowed).toBe(true);
    // 🧬 MUTANTE: `realVerified: d.approved` ⇒ `true` ⇒ la pantalla afirmaría una verificación real ⇒ ROJO.
    expect(d.verification.realVerified).toBe(false);
  });

  it("✅ calibración inversa: con `payoutAllowed: true` del agente, `realVerified` es true", async () => {
    const d = await conDecision(DECISION_200);
    expect(d.verification.realVerified).toBe(true);
    expect(d.verification.payoutAllowed).toBe(true);
  });

  it("un rechazo del agente (`approved:false`) NO llega a `kyc_passed`", async () => {
    const d = await conDecision({ ...DECISION_200, approved: false, payoutAllowed: false, status: "Declined" });
    expect(d.verification.approved).toBe(false);
    expect(d.verification.payoutAllowed).toBe(false);
    expect(d.verification.realVerified).toBe(false);
  });

  it("`identity` es SIEMPRE null (el agente no devuelve ningún dato de identidad) y `verifiedAt` viaja", async () => {
    const d = await conDecision(DECISION_200);
    expect(d.verification.identity).toBeNull();
    expect(d.verification.verifiedAt).toBe("2026-08-19T10:00:00.000Z");
    expect(d.verification.provenance).toBe("didit");
    expect(d.verification.riskLevel).toBe("low");
  });
});
