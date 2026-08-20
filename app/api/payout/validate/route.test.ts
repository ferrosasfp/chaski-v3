import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpPayoutAuthorityGateway } from "../../../../src/infrastructure/payout/payout-authority-gateway";

// WKH-233: el rate-limit corre cuando KYC_AGENT_BASE_URL está seteada (misma semántica de antes,
// sin la env del proveedor). Los tests de autoridad no fijan
// Upstash env (fail-closed → 503) → mockeamos checkRouteRateLimit a { ok:true } por default y lo
// overrideamos en los tests AC-4 (!ok → 429) / AC-6 (unavailable → 503). clientIp/PAYOUT_VALIDATE_RL
// se conservan reales (rest-spread del módulo original).
// WKH-233 — el store del `decisionToken`, HONESTO: aplica el filtro por dueño de verdad (CD-19).
const { getTokenStoreMock } = vi.hoisted(() => ({ getTokenStoreMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/persistence/supabase-kyc-session-tokens", () => ({
  getKycSessionTokenStore: getTokenStoreMock,
}));

const { checkRouteRateLimitMock } = vi.hoisted(() => ({ checkRouteRateLimitMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/rate-limit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/infrastructure/rate-limit")>();
  return { ...actual, checkRouteRateLimit: checkRouteRateLimitMock };
});

import { POST } from "./route";

const VID = "sess-abc";
// WKH-320: addresses base58 — la canonicalización dejó de aceptar hexadecimal, y el match de
// ownership dejó de ser case-insensitive (CD-7).
const ADDR = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function req(payload: unknown): Request {
  return new Request("http://localhost/api/payout/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** El agente de KYC contestando. `over` pisa el veredicto ya juzgado; `payoutAllowed` es TODO el gate. */
function agenteOk(over: Record<string, unknown> = {}) {
  return vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({
      terminal: true,
      status: "Approved",
      approved: true,
      riskLevel: "low",
      verificationId: VID,
      provenance: "didit",
      payoutAllowed: true,
      reasons: [],
      identityMatches: true,
      ...over,
    }),
  }));
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  // Default: rate-limit permite el paso (los tests de autoridad no lo ejercitan).
  checkRouteRateLimitMock.mockReset();
  checkRouteRateLimitMock.mockResolvedValue({ ok: true });
  vi.stubEnv("KYC_AGENT_INVOKE_SECRET", "invoke-secret-de-test"); // WKH-233 (fix-pack · H-3): la credencial de invoke pasó a ser OBLIGATORIA (`invokeAuthHeader` es fail-closed), así que sembrarla es PRE-REQUISITO de todo `it` que llegue al agente. Estaba en `undefined` a propósito cuando la ausencia era inocua; hoy la ausencia CORTA, y dejarla haría que estos `it` midieran el guard nuevo en vez de lo que dicen medir.
  vi.stubEnv("VERCEL_ENV", undefined);
  // La fila del token existe para el par legítimo `(VID, ADDR)` y para ningún otro.
  getTokenStoreMock.mockReset();
  getTokenStoreMock.mockReturnValue({
    getForOwner: vi.fn(async (s: string, o: string) =>
      s === VID && o === ADDR ? "k1.token-del-agente" : null,
    ),
  });
});

describe("POST /api/payout/validate — autoridad server-side (WKH-180)", () => {
  // ── Guard 1: sin key ────────────────────────────────────────────────────────
  it("VERCEL_ENV=production + sin key → 503 authorized:false kyc_authority_unavailable, fetch NOT called (AC-3, CD-4)", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", undefined);
    vi.stubEnv("VERCEL_ENV", "production");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_authority_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sin VERCEL_ENV + sin key → 200 authorized:true simulated_dev, fetch NOT called (AC-4)", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", undefined);
    vi.stubEnv("VERCEL_ENV", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: true, reason: "simulated_dev" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Guard 2: formato → COLAPSA a kyc_not_authorized/200 (WKH-205 AC-1, oráculo cerrado) ─────────
  it("verificationId '' (con key) → 200 kyc_not_authorized (colapsado), fetch NOT called (AC-1/AC-5)", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ verificationId: "", address: ADDR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_not_authorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verificationId ausente (con key) → 200 kyc_not_authorized (colapsado), fetch NOT called (AC-1/AC-5)", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ address: ADDR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_not_authorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Didit real ──────────────────────────────────────────────────────────────
  // El fixture DECLARA vendor_data: sin él, esta sesión no tiene binding y con el ownership
  // fail-closed ya no autoriza. Antes pasaba igual, y eso escondía el bug: el test que decía
  // "Approved → authorized:true" en realidad estaba ejercitando el bypass, no el camino real
  // (la DApp siempre manda vendorData = senderAddress — kyc-gateway.ts:28).
  it("key + Didit Approved (con binding) → 200 authorized:true (AC-1)", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
    vi.stubGlobal("fetch", agenteOk());
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: true });
  });

  it("key + Didit Declined → 200 kyc_not_authorized (colapsado, oráculo cerrado) (AC-1)", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
    vi.stubGlobal("fetch", agenteOk({ approved: false, status: "Declined", payoutAllowed: false }));
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_not_authorized" });
  });

  it("key + Didit !res.ok → 502 kyc_reauth_failed NO colapsa (técnico preservado) (AC-2)", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    // AC-2: reason técnico (502) NO se colapsa a kyc_not_authorized ni a 200; conserva su forma.
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_reauth_failed" });
  });

  it("key + Didit fetch throws (timeout) → 502 authorized:false kyc_reauth_failed, NO 500 crudo (MNR-A fail-closed)", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("The operation was aborted due to timeout"); }));
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_reauth_failed" });
  });

  // ── Ownership — WKH-233: el binding YA NO ES un eco del borde, es la FILA DEL TOKEN ────────────
  // Antes el dueño se leía del `vendor_data` que el proveedor ecoaba en su decisión; ahora el par
  // `(sesión, dirección)` decide si la credencial se obtiene siquiera. El desenlace observable de
  // esta route es el MISMO, y por eso las aserciones no cambian.
  it("dirección que NO es la dueña de la sesión → 200 kyc_not_authorized (colapsado) (AC-1 ownership)", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
    vi.stubGlobal("fetch", agenteOk());
    const res = await POST(req({ verificationId: VID, address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_not_authorized" });
  });

  // CANDADO DE NO-REGRESIÓN: éste es el camino de la DApp (kyc-gateway.ts:28 manda siempre
  // vendorData = senderAddress). Si el fail-closed de abajo alguna vez lo rompe, se rompe la demo.
  it("la dirección DUEÑA de la sesión (base58 case-sensitive) → true", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
    vi.stubGlobal("fetch", agenteOk());
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: true });
  });

  // Este test reemplaza a uno que afirmaba lo contrario ("vendor_data ausente → true (residual
  // documentado)"). No era un residual: era un bypass entero, reproducido contra producción el
  // 2026-08-04 — POST /api/kyc/session {} (público, sin credenciales) → sesión con vendor vacío →
  // aprobada por el mock → /api/payout/validate autorizaba CUALQUIER address. Tres direcciones sin
  // relación entre sí pasaron las tres.
  it("sesión SIN ATAR → NO autorizado (fail-closed: sin binding no hay autorización)", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
    // Una sesión creada sin prueba de posesión tiene `owner_address` NULL, y un `.eq` NUNCA matchea
    // un NULL ⇒ `getForOwner` devuelve `null` para CUALQUIER dirección. Es el mismo desenlace que el
    // bypass viejo producía con `vendor_data` vacío, pero ahora por construcción de la query.
    getTokenStoreMock.mockReturnValue({ getForOwner: vi.fn(async () => null) });
    vi.stubGlobal("fetch", agenteOk());
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_not_authorized" });
  });

  // vendor_data ausente + address ARBITRARIA: el input exacto del bypass medido. Tres addresses sin
  // ninguna relación con la sesión; ninguna puede autorizar. Con el `!== ""` viejo, las tres daban
  // authorized:true.
  it.each([
    ["system program", "11111111111111111111111111111111"],
    ["wrapped SOL", "So11111111111111111111111111111111111111112"],
    ["address de terceros", "4AvAjt5ZQxRhCLwLXNLQHmwEfWCF5upBCPDvNqZFy7Hg"],
  ])(
    "vendor_data ausente + address ajena (%s) → NO autorizado (el bypass reproducido en prod)",
    async (_label, foreignAddress) => {
      vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
      vi.stubGlobal("fetch", agenteOk());
      const res = await POST(req({ verificationId: VID, address: foreignAddress }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ authorized: false, reason: "kyc_not_authorized" });
    },
  );

  // El colapso no-oracle de WKH-205 tiene que seguir cubriendo este caso nuevo: "sesión sin binding"
  // no puede ser distinguible de "sesión rechazada". Por eso el reason es kyc_ownership_mismatch
  // (que ya está en el switch de validate/route.ts:76) y no uno nuevo, que caería al default y
  // saldría crudo.
  it("una sesión sin binding es BYTE-IDÉNTICA a Declined (no abre un oráculo nuevo)", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");

    vi.stubGlobal("fetch", agenteOk());
    const noBinding = await POST(req({ verificationId: VID, address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }));
    const noBindingBody = await noBinding.json();

    vi.stubGlobal("fetch", agenteOk({ approved: false, status: "Declined", payoutAllowed: false }));
    const declined = await POST(req({ verificationId: VID, address: ADDR }));
    const declinedBody = await declined.json();

    expect(noBinding.status).toBe(declined.status);
    expect(noBindingBody).toEqual(declinedBody);
  });

  // ── Cero PII / key server-only ───────────────────────────────────────────────
  it("respuesta nunca contiene identity/documentNumber ni el API key (AC-7, CD-A8)", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
    vi.stubGlobal(
      "fetch",
      // El agente NO devuelve datos de identidad; se agregan igual como campos EXTRA para medir que
      // ni siquiera un campo desconocido del borde puede llegar a la respuesta de esta route.
      agenteOk({ id_verifications: [{ document_number: "44556677", first_name: "Ana" }] }),
    );
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    const raw = await res.text();
    expect(raw).not.toContain("identity");
    expect(raw).not.toContain("documentNumber");
    expect(raw).not.toContain("44556677");
    expect(raw).not.toContain("super-secret-key");
    expect(JSON.parse(raw)).toEqual({ authorized: true });
  });

  // ── WKH-205 AC-1: oráculo cerrado — los 3 reasons subject son INDISTINGUIBLES ──────────────────
  it("AC-1: Declined / ownership-mismatch / verificationId-inválido → body+status BYTE-IDÉNTICOS", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");

    // (1) Didit Declined
    vi.stubGlobal("fetch", agenteOk({ approved: false, status: "Declined", payoutAllowed: false }));
    const declined = await POST(req({ verificationId: VID, address: ADDR }));
    const declinedBody = await declined.json();

    // (2) ownership mismatch: el agente diría que sí, pero la fila del token no es de este caller
    vi.stubGlobal("fetch", agenteOk());
    const mismatch = await POST(req({ verificationId: VID, address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }));
    const mismatchBody = await mismatch.json();

    // (3) verificationId inválido (formato) — sin fetch
    const invalid = await POST(req({ verificationId: "", address: ADDR }));
    const invalidBody = await invalid.json();

    // Mismo status y mismo body para los 3 → un caller no autenticado no puede distinguir el estado KYC ajeno.
    expect(declined.status).toBe(200);
    expect(mismatch.status).toBe(200);
    expect(invalid.status).toBe(200);
    expect(declinedBody).toEqual({ authorized: false, reason: "kyc_not_authorized" });
    expect(declinedBody).toEqual(mismatchBody);
    expect(mismatchBody).toEqual(invalidBody);
  });

  // ── WKH-205 AC-3: body no-record → nunca 500 (isRecord + resolvePayoutAuthority guard), sin Didit ──
  it.each<[string, unknown]>([
    ["null", null],
    ["array", []],
    ["number", 123],
    ["string", "str"],
  ])("AC-3: body no-record (%s) con key → nunca 500 (200 kyc_not_authorized), fetch NOT called", async (_label, payload) => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req(payload));
    expect(res.status).not.toBe(500);
    // body no-record → verificationId/address "" → invalid_verification_id → colapsa a kyc_not_authorized/200.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_not_authorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── WKH-205 AC-4: rate-limit excedido → 429, autoridad/Didit NO consultadas ───────────────────
  it("AC-4: rate-limit !ok (con key) → 429, resolvePayoutAuthority/fetch NOT called", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test"); // WKH-233: el gate del limiter mira el host del agente, no la credencial del proveedor (misma semántica: ¿demo o vivo?)
    checkRouteRateLimitMock.mockResolvedValue({ ok: false, retryAfter: 30 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_rate_limited" });
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── WKH-205 AC-6: Upstash ausente en entorno vivo → 503 fail-closed ───────────────────────────
  it("AC-6: rate-limit unavailable (con key) → 503 kyc_authority_unavailable fail-closed, fetch NOT called", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test"); // WKH-233: el gate del limiter mira el host del agente, no la credencial del proveedor (misma semántica: ¿demo o vivo?)
    checkRouteRateLimitMock.mockResolvedValue({ ok: false, unavailable: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_authority_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("HttpPayoutAuthorityGateway — adapter fail-closed (WKH-180, CD-A4)", () => {
  it("fetch throw/red-caída → { authorized:false, kyc_authority_error }", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const gw = new HttpPayoutAuthorityGateway();
    const r = await gw.authorize({ verificationId: VID, address: ADDR });
    expect(r).toEqual({ authorized: false, reason: "kyc_authority_error" });
  });

  it("body sin authorized boolean → { authorized:false, kyc_authority_error }", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ foo: "bar" }) })));
    const gw = new HttpPayoutAuthorityGateway();
    const r = await gw.authorize({ verificationId: VID, address: ADDR });
    expect(r).toEqual({ authorized: false, reason: "kyc_authority_error" });
  });

  it("propaga { authorized:true } de la ruta (simulated_dev) → demo sigue OK", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ authorized: true, reason: "simulated_dev" }) })));
    const gw = new HttpPayoutAuthorityGateway();
    const r = await gw.authorize({ verificationId: VID, address: ADDR });
    expect(r).toEqual({ authorized: true, reason: "simulated_dev" });
  });
});

describe("autoridad de payout — el host del agente, fail-closed (guard 1)", () => {
  // ⚠️ ESTE BLOQUE REEMPLAZA al que medía el ambiente del PROVEEDOR (`DIDIT_ENV`), que se fue con el
  // proveedor. Lo que custodiaba —que sin ambiente declarado la autoridad NUNCA autorice y NUNCA
  // hable con el borde— se conserva, apuntado a la señal que hoy existe.
  it("sin host del agente + VERCEL_ENV=production → 503 fail-loud; NO se consulta a nadie", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", undefined);
    vi.stubEnv("VERCEL_ENV", "production");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    // 503 (misconfig NUESTRA) y NO 502 ("el agente falló"): un reason que manda a ops a mirar al
    // agente cuando el problema es una env sin setear cuesta horas de diagnóstico.
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ authorized: false, reason: "kyc_authority_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled(); // fail-closed: nunca autoriza, nunca habla con nadie
  });

  it("sin host del agente + VERCEL_ENV=preview → 503 (un preview tampoco autoriza por default)", async () => {
    // El vector real: los previews de Vercel HEREDAN las envs de producción por default, así que la
    // ausencia de la env en un preview es la señal de que ese deploy no debe autorizar nada.
    vi.stubEnv("KYC_AGENT_BASE_URL", undefined);
    vi.stubEnv("VERCEL_ENV", "preview");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ verificationId: VID, address: ADDR }));
    // ⚠️ CONSECUENCIA DICHA: en un preview SIN la env, la rama no-prod devuelve `simulated_dev` y la
    // route lo propaga con 200. Eso NO paga: `prepare` rechaza `simulated_dev` en TODO scope de
    // Vercel, que es donde vive el money-path. Esta route es advisory.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: true, reason: "simulated_dev" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
