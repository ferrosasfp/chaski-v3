// Tests del guard de ownership de resolvePayoutAuthority, A NIVEL MÓDULO.
//
// Por qué no alcanza con los de app/api/payout/validate/route.test.ts: esa ruta COLAPSA los tres
// reasons subject a `kyc_not_authorized` (WKH-205), así que desde ahí es imposible ver CUÁL reason
// devolvió la autoridad. Y el reason importa: `prepare/route.ts:347` despacha sobre él con un switch
// cerrado, y un reason que no esté en ese switch cae al default → 502 "la autoridad se cayó" en vez
// de 403 "no autorizado". Estos tests fijan el reason exacto.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePayoutAuthority } from "./authority";

const VID = "sess-abc";
const ADDR = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OTHER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function diditOk(raw: Record<string, unknown>) {
  return vi.fn(async () => ({ ok: true, json: async () => raw }));
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.stubEnv("DIDIT_API_KEY", "test-key");
  // DIDIT_ENV fijo a mock para que un DIDIT_ENV=live de la shell/CI no resuelva el host real.
  vi.stubEnv("DIDIT_ENV", "mock");
  vi.stubEnv("DIDIT_BASE_URL", "http://localhost:9999/didit-mock");
});

describe("resolvePayoutAuthority — ownership fail-closed", () => {
  it("vendor_data ausente → authorized:false kyc_ownership_mismatch (200)", async () => {
    vi.stubGlobal("fetch", diditOk({ status: "Approved", session_id: VID }));
    expect(await resolvePayoutAuthority({ verificationId: VID, address: ADDR })).toEqual({
      authorized: false,
      reason: "kyc_ownership_mismatch",
      httpStatus: 200,
    });
  });

  it("vendor_data '' explícito → authorized:false kyc_ownership_mismatch (200)", async () => {
    vi.stubGlobal("fetch", diditOk({ status: "Approved", session_id: VID, vendor_data: "" }));
    expect(await resolvePayoutAuthority({ verificationId: VID, address: ADDR })).toEqual({
      authorized: false,
      reason: "kyc_ownership_mismatch",
      httpStatus: 200,
    });
  });

  // El reason del caso "sin binding" es el MISMO que el del caso "binding distinto". Es deliberado:
  // agregar un reason nuevo rompería los dos switches cerrados aguas abajo (validate/route.ts:74,
  // prepare/route.ts:347). Si alguien lo separa, este test se pone rojo y hay que revisar los dos.
  it("vendor_data distinto → authorized:false kyc_ownership_mismatch (200), MISMO reason que sin binding", async () => {
    vi.stubGlobal("fetch", diditOk({ status: "Approved", session_id: VID, vendor_data: OTHER }));
    expect(await resolvePayoutAuthority({ verificationId: VID, address: ADDR })).toEqual({
      authorized: false,
      reason: "kyc_ownership_mismatch",
      httpStatus: 200,
    });
  });

  // CANDADO: el camino real de la DApp (kyc-gateway.ts:28 manda vendorData = senderAddress).
  //
  // ⚠️ CAMBIÓ DE EXPECTATIVA EN WKH-333, y la razón va acá al lado. Este `toEqual` exigía el objeto
  // EXACTO `{authorized:true, httpStatus:200}`. La rama de Didit REAL ahora agrega dos campos
  // ADITIVOS y OPCIONALES (`provenance`, `riskLevel`) que el backfill del veredicto necesita para no
  // persistir una decisión simulada como si fuera real (AC-8/CD-24). Lo que este test custodia sigue
  // intacto y se sigue asertando abajo, campo por campo: `authorized:true` y **la ausencia de
  // `reason`** — un `reason` presente acá rompería los dos switches cerrados aguas abajo.
  it("vendor_data == address → authorized:true SIN reason (el camino de la DApp, intacto)", async () => {
    vi.stubGlobal("fetch", diditOk({ status: "Approved", session_id: VID, vendor_data: ADDR }));
    const d = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(d.authorized).toBe(true);
    expect(d.httpStatus).toBe(200);
    expect(d.reason, "apareció un `reason` en la rama que autoriza: los switches cerrados de " +
      "validate/route.ts y prepare/route.ts lo mandarían al default").toBeUndefined();
  });

  // vendor_data vacío corta ANTES de canonicalizar: si canonicalizeAddress("") corriera, throwearía
  // y el catch lo convertiría en 502 kyc_reauth_failed, que le echaría la culpa a Didit de algo
  // nuestro. El assert que lo distingue es el httpStatus (200, no 502).
  it("vendor_data vacío NO se canonicaliza: 200, no 502 kyc_reauth_failed", async () => {
    vi.stubGlobal("fetch", diditOk({ status: "Approved", session_id: VID, vendor_data: "" }));
    const d = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(d.httpStatus).toBe(200);
    expect(d.reason).not.toBe("kyc_reauth_failed");
  });
});

// ── T-AUTH-1 (WKH-333/AC-10') ─────────────────────────────────────────────────────────────────────
// Lo que WKH-333 tenía PROHIBIDO tocar es el guard-order INTERNO de esta función. Lo único que cambia
// en la HU es su POSICIÓN dentro de `prepare` y el ORIGEN de su primer argumento. Este describe fija,
// rama por rama, la tripleta observable de hoy — `authorized` / `reason` / `httpStatus` —, que es
// exactamente lo que los dos switches cerrados aguas abajo despachan.
//
// ⚠️ Se asertan los TRES campos por separado y NO con un `toEqual` del objeto entero, a propósito: un
// `toEqual` se pondría rojo ante cualquier campo aditivo futuro y empujaría a "arreglarlo" copiando
// la salida, que es cómo un cambio de comportamiento real pasa desapercibido. Lo que se custodia es
// el contrato, no la forma del objeto.
describe("T-AUTH-1: el guard-order interno no cambió de comportamiento (AC-10')", () => {
  const cases: Array<{
    name: string;
    setup: () => void;
    expected: { authorized: boolean; reason: string | undefined; httpStatus: number };
  }> = [
    {
      name: "sin DIDIT_API_KEY + prod ⇒ 503 kyc_authority_unavailable, y NO se toca Didit",
      setup: () => {
        vi.stubEnv("DIDIT_API_KEY", "");
        vi.stubEnv("VERCEL_ENV", "production");
      },
      expected: { authorized: false, reason: "kyc_authority_unavailable", httpStatus: 503 },
    },
    {
      name: "sin DIDIT_API_KEY + no-prod ⇒ autoriza como simulated_dev (el demo local)",
      setup: () => {
        vi.stubEnv("DIDIT_API_KEY", "");
        vi.stubEnv("VERCEL_ENV", "");
      },
      expected: { authorized: true, reason: "simulated_dev", httpStatus: 200 },
    },
    {
      name: "con key + verificationId vacío ⇒ 400 invalid_verification_id, sin fetch",
      setup: () => {
        vi.stubEnv("DIDIT_API_KEY", "test-key");
      },
      expected: { authorized: false, reason: "invalid_verification_id", httpStatus: 400 },
    },
    {
      name: "con key + DIDIT_ENV inválido ⇒ 503 kyc_authority_misconfigured (nuestro, no de Didit)",
      setup: () => {
        vi.stubEnv("DIDIT_API_KEY", "test-key");
        vi.stubEnv("DIDIT_ENV", "sandbox");
      },
      expected: { authorized: false, reason: "kyc_authority_misconfigured", httpStatus: 503 },
    },
    {
      name: "Didit no-ok ⇒ 502 kyc_reauth_failed",
      setup: () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
      },
      expected: { authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 },
    },
    {
      name: "Didit Declined ⇒ 200 kyc_not_approved",
      setup: () => {
        vi.stubGlobal("fetch", diditOk({ status: "Declined", session_id: VID, vendor_data: ADDR }));
      },
      expected: { authorized: false, reason: "kyc_not_approved", httpStatus: 200 },
    },
    {
      name: "Didit Approved + vendor_data de OTRO ⇒ 200 kyc_ownership_mismatch",
      setup: () => {
        vi.stubGlobal("fetch", diditOk({ status: "Approved", session_id: VID, vendor_data: OTHER }));
      },
      expected: { authorized: false, reason: "kyc_ownership_mismatch", httpStatus: 200 },
    },
    {
      name: "Didit Approved + vendor_data == address ⇒ 200 authorized, SIN reason",
      setup: () => {
        vi.stubGlobal("fetch", diditOk({ status: "Approved", session_id: VID, vendor_data: ADDR }));
      },
      expected: { authorized: true, reason: undefined, httpStatus: 200 },
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      c.setup();
      const vid = c.name.includes("verificationId vacío") ? "" : VID;
      const d = await resolvePayoutAuthority({ verificationId: vid, address: ADDR });
      const observed = { authorized: d.authorized, reason: d.reason, httpStatus: d.httpStatus };
      expect(
        observed,
        "la autoridad de KYC cambió de veredicto en esta rama: WKH-333 sólo movió DÓNDE se la " +
          "consulta y de dónde sale su primer argumento, así que un cambio acá significa que se " +
          "debilitó (o endureció sin querer) el guard que decide si una persona puede cobrar",
      ).toEqual(c.expected);
    });
  }

  // Los campos aditivos salen SÓLO de la rama de Didit real: es el input que impide que el backfill
  // persista una decisión simulada como si fuera una verificación real (CD-24).
  it("provenance/riskLevel viajan SÓLO cuando autorizó Didit real; nunca en simulated_dev", async () => {
    vi.stubGlobal("fetch", diditOk({ status: "Approved", session_id: VID, vendor_data: ADDR }));
    const real = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(real.provenance).toBe("didit-mock"); // DIDIT_ENV=mock en el beforeEach ⇒ etiqueta honesta
    expect(real.riskLevel).toBe("low");

    vi.stubEnv("DIDIT_API_KEY", "");
    vi.stubEnv("VERCEL_ENV", "");
    const sim = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(
      sim.provenance,
      "la rama `simulated_dev` declaró una proveniencia: el backfill la tomaría por buena y " +
        "persistiría como verificación de identidad algo que nadie verificó",
    ).toBeUndefined();
    expect(sim.riskLevel).toBeUndefined();
  });
});
