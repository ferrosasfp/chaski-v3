// Tests del guard de ownership de resolvePayoutAuthority, A NIVEL MÓDULO.
//
// Por qué no alcanza con los de app/api/payout/validate/route.test.ts: esa ruta COLAPSA los tres
// reasons subject a `kyc_not_authorized` (WKH-205), así que desde ahí es imposible ver CUÁL reason
// devolvió la autoridad. Y el reason importa: `prepare/route.ts:120` despacha sobre él con un switch
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
  // agregar un reason nuevo rompería los dos switches cerrados aguas abajo (validate/route.ts:62,
  // prepare/route.ts:120). Si alguien lo separa, este test se pone rojo y hay que revisar los dos.
  it("vendor_data distinto → authorized:false kyc_ownership_mismatch (200), MISMO reason que sin binding", async () => {
    vi.stubGlobal("fetch", diditOk({ status: "Approved", session_id: VID, vendor_data: OTHER }));
    expect(await resolvePayoutAuthority({ verificationId: VID, address: ADDR })).toEqual({
      authorized: false,
      reason: "kyc_ownership_mismatch",
      httpStatus: 200,
    });
  });

  // CANDADO: el camino real de la DApp (kyc-gateway.ts:23 manda vendorData = senderAddress).
  it("vendor_data == address → authorized:true SIN reason (el camino de la DApp, intacto)", async () => {
    vi.stubGlobal("fetch", diditOk({ status: "Approved", session_id: VID, vendor_data: ADDR }));
    expect(await resolvePayoutAuthority({ verificationId: VID, address: ADDR })).toEqual({
      authorized: true,
      httpStatus: 200,
    });
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
