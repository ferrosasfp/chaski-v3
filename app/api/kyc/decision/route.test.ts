import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueSessionToken } from "../../../../src/infrastructure/kyc-auth";
import type { KycVerdictRecord } from "../../../../src/application/ports";

// WKH-333 — el store del veredicto. Default `null` (flag OFF) ⇒ los tests de WKH-179 de más abajo
// corren EXACTAMENTE como antes: sin store no hay escritura y la respuesta es la de siempre.
const { getStoreMock } = vi.hoisted(() => ({ getStoreMock: vi.fn(() => null as unknown) }));
vi.mock("../../../../src/infrastructure/persistence/supabase-kyc-verdicts", () => ({
  getKycVerdictStore: getStoreMock,
}));

import { GET } from "./route";

const SESSION = "sess-abc";
const DECISION_RAW = {
  status: "Approved",
  session_id: SESSION,
  id_verifications: [
    { document_number: "44556677", first_name: "Ana", date_of_birth: "1990-05-14" },
  ],
};

function req(headers: Record<string, string> = {}, id = SESSION): Request {
  const url = `http://localhost/api/kyc/decision?sessionId=${encodeURIComponent(id)}`;
  return new Request(url, { headers });
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.stubEnv("DIDIT_API_KEY", "test-key");
  vi.stubEnv("KYC_SESSION_SECRET", "test-secret-123");
  // Ambiente de Didit declarado (fail-closed): sin esto la ruta corta en 500 didit_env_misconfigured
  // antes del fetch. Mismo razonamiento que el stub de DIDIT_API_KEY de arriba: además de habilitar
  // el path, BLINDA contra un DIDIT_ENV=live exportado en la shell/CI, que mandaría estos tests a
  // resolver el host REAL de Didit. El fetch está mockeado, pero un test NUNCA debe poder resolver
  // producción.
  vi.stubEnv("DIDIT_ENV", "mock");
  vi.stubEnv("DIDIT_BASE_URL", "http://localhost:9999/didit-mock");
});

describe("GET /api/kyc/decision — guard-order + IDOR + masking (WKH-179)", () => {
  it("token válido → 200 + decision con documentNumber enmascarado (AC-1, AC-3)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => DECISION_RAW })));
    const token = issueSessionToken(SESSION);
    const res = await GET(req({ "x-kyc-token": token }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: { documentNumber: string; firstName: string; dateOfBirth: string } };
    expect(body.identity.documentNumber).toBe("****6677");
    expect(body.identity.firstName).toBe("Ana");
    expect(body.identity.dateOfBirth).toBe("1990-05-14");
  });

  it("sin x-kyc-token → 401, fetch NO llamado (AC-2, AC-7, CD-2)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("token errado → 401 mismo body que 'sin token', fetch NO llamado (CD-5, AC-7)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(req({ "x-kyc-token": "forged-token" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("token de OTRA sesión → 401 (IDOR: no sirve el token de sess-X para sess-Y)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const otherToken = issueSessionToken("sess-otra");
    const res = await GET(req({ "x-kyc-token": otherToken }));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sin DIDIT_API_KEY → 501, sin exigir token (AC-4)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "");
    const res = await GET(req());
    expect(res.status).toBe(501);
  });

  it("DIDIT_API_KEY presente pero sin KYC_SESSION_SECRET → 500 (CD-7)", async () => {
    vi.stubEnv("KYC_SESSION_SECRET", "");
    const res = await GET(req({ "x-kyc-token": "whatever" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
  });

  it("sin sessionId → 400 (preservado)", async () => {
    const url = "http://localhost/api/kyc/decision";
    const res = await GET(new Request(url));
    expect(res.status).toBe(400);
  });

  // ── Ambiente de Didit: fail-closed (elimina el default productivo) ──────────
  it("key válida + token válido + SIN DIDIT_ENV → 500 didit_env_misconfigured y NO se llama a Didit", async () => {
    vi.stubEnv("DIDIT_ENV", undefined);
    vi.stubEnv("DIDIT_BASE_URL", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "didit_env_misconfigured" });
    // EL assert que importa: sin ambiente declarado NO sale un request a Didit (ni a producción
    // ni a ningún lado). Antes de este fix, acá se fetcheaba el host PRODUCTIVO de Didit por
    // default. (El literal no se escribe acá a propósito: lo vigila el canario de didit-env.test.ts.)
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DIDIT_ENV=mock + DIDIT_BASE_URL → el fetch va al MOCK, nunca al host de Didit", async () => {
    // El `_url: string` NO es decorativo: sin parámetro declarado, `mock.calls` se tipa como `[]`
    // y `calls[0][0]` no compila con strict (TS2493).
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => DECISION_RAW }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(res.status).toBe(200);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe(`http://localhost:9999/didit-mock/v3/session/${SESSION}/decision/`);
    expect(url).not.toContain("didit.me");
  });
});

// ── WKH-333 W3 — la escritura del veredicto (AC-1, AC-9, CD-13, CD-25) ────────────────────────────
// La regla que estos tests custodian: la persona que está verificando su identidad NO puede ver un
// desenlace distinto porque nuestra base de evidencia falló. La escritura es best-effort de verdad.
describe("GET /api/kyc/decision — persistencia del veredicto (WKH-333)", () => {
  const OWNER = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const APPROVED_WITH_OWNER = { ...DECISION_RAW, vendor_data: OWNER };

  function fakeStore(over: { putThrows?: boolean } = {}) {
    return {
      get: vi.fn(async () => null),
      // El `_r: KycVerdictRecord` NO es decorativo: sin parámetro declarado, `mock.calls` se tipa
      // como `[]` y `calls[0][0]` no compila con strict (TS2493). Mismo gotcha que el `_url: string`
      // del test de más arriba.
      put: vi.fn(async (_r: KycVerdictRecord) => {
        if (over.putThrows) throw new Error("kyc_verdict_insert_failed:08006");
        return "inserted" as const;
      }),
    };
  }

  beforeEach(() => {
    getStoreMock.mockReset();
    getStoreMock.mockReturnValue(null);
  });

  // ── T-DEC-1 ────────────────────────────────────────────────────────────────────────────────────
  it("T-DEC-1: la respuesta es BYTE-IDÉNTICA con el store OFF, con el store ON y con la escritura rota (M-11)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => APPROVED_WITH_OWNER })));
    const token = issueSessionToken(SESSION);

    getStoreMock.mockReturnValue(null); // OFF
    const off = await GET(req({ "x-kyc-token": token }));
    const offBody = await off.text();

    getStoreMock.mockReturnValue(fakeStore()); // ON, escribe bien
    const on = await GET(req({ "x-kyc-token": token }));
    const onBody = await on.text();

    vi.spyOn(console, "error").mockImplementation(() => {});
    getStoreMock.mockReturnValue(fakeStore({ putThrows: true })); // ON, escritura rota
    const broken = await GET(req({ "x-kyc-token": token }));
    const brokenBody = await broken.text();

    expect(
      { status: on.status, body: onBody },
      "encender la persistencia cambió lo que la persona ve al terminar su verificación",
    ).toEqual({ status: off.status, body: offBody });
    expect(
      { status: broken.status, body: brokenBody },
      "un fallo de NUESTRA base de evidencia cambió el desenlace del KYC de una persona: la " +
        "verificación salió bien y la pantalla diría otra cosa",
    ).toEqual({ status: off.status, body: offBody });
  });

  // ── T-DEC-2 ────────────────────────────────────────────────────────────────────────────────────
  it("T-DEC-2: terminal + approved + vendor_data válido ⇒ escribe UNA fila, con la address del binding", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => APPROVED_WITH_OWNER })));
    const store = fakeStore();
    getStoreMock.mockReturnValue(store);
    await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(store.put).toHaveBeenCalledTimes(1);
    const written = store.put.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(written.senderAddress).toBe(OWNER);
    expect(written.approved).toBe(true);
    expect(written.verificationId).toBe(SESSION);
    // SIN PII (CD-2): la decisión de Didit trae nombre y número de documento, y nada de eso viaja.
    const keys = Object.keys(written).sort();
    expect(
      keys,
      "la fila del veredicto cambió de campos: cada campo nuevo acá puede ser un dato de identidad " +
        "de una persona pasando a vivir en nuestra base",
    ).toEqual([
      "approved",
      "provenance",
      "riskLevel",
      "senderAddress",
      "verificationId",
      "verifiedAt",
    ]);
    expect(JSON.stringify(written)).not.toContain("44556677");
    expect(JSON.stringify(written)).not.toContain("Ana");
    expect(JSON.stringify(written)).not.toContain("1990-05-14");
  });

  it("T-DEC-2b: NO terminal ⇒ no escribe (todavía no hay veredicto que persistir)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ ...APPROVED_WITH_OWNER, status: "In Review" }) })),
    );
    const store = fakeStore();
    getStoreMock.mockReturnValue(store);
    await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(store.put).not.toHaveBeenCalled();
  });

  it("T-DEC-2c: terminal pero DECLINED ⇒ no escribe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ ...APPROVED_WITH_OWNER, status: "Declined" }) })),
    );
    const store = fakeStore();
    getStoreMock.mockReturnValue(store);
    await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));
    expect(store.put).not.toHaveBeenCalled();
  });

  // ── T-DEC-3 ────────────────────────────────────────────────────────────────────────────────────
  it("T-DEC-3: vendor_data vacío o no-address ⇒ NO escribe (fail-closed, M-12)", async () => {
    const store = fakeStore();
    getStoreMock.mockReturnValue(store);

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => DECISION_RAW }))); // sin vendor_data
    await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ ...DECISION_RAW, vendor_data: "" }) })),
    );
    await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ ...DECISION_RAW, vendor_data: "no-es-una-address" }) })),
    );
    await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));

    expect(
      store.put,
      "se escribió una fila sin saber DE QUIÉN es la verificación: con el flag encendido esa fila " +
        "es la fuente de autoridad de un pago, así que una a nombre equivocado es peor que ninguna",
    ).not.toHaveBeenCalled();
  });

  // ── T-DEC-4 ────────────────────────────────────────────────────────────────────────────────────
  it("T-DEC-4: la escritura tira ⇒ UNA alerta por el canal del ledger, VALUE-FREE (M-11b)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => APPROVED_WITH_OWNER })));
    getStoreMock.mockReturnValue(fakeStore({ putThrows: true }));
    await GET(req({ "x-kyc-token": issueSessionToken(SESSION) }));

    expect(errSpy).toHaveBeenCalledTimes(1);
    const [line, fields] = errSpy.mock.calls[0] as [string, Record<string, string>];
    expect(
      line,
      "la alerta no sale por el prefijo del ledger: quien tenga la búsqueda montada sobre ese " +
        "prefijo no se entera de que la evidencia no quedó",
    ).toContain("[ledger][ALERT]");
    const payload = String(line) + JSON.stringify(fields ?? {});
    for (const secret of [SESSION, OWNER, "44556677", "Ana", "1990-05-14"]) {
      expect(
        payload,
        `la alerta filtró \`${secret}\`: es la credencial del money-path o un dato de identidad, y ` +
          "un log es el lugar donde más gente lo lee sin pedir permiso",
      ).not.toContain(secret);
    }
  });

  // ── T-DEC-5 ────────────────────────────────────────────────────────────────────────────────────
  it("T-DEC-5: 8 polleos del MISMO verificationId ⇒ el store decide, y devuelve 'already_recorded'", async () => {
    // La route llama `put` una vez por polleo a propósito: la idempotencia vive en el CAS del store
    // (una sola operación atómica), no en un chequeo previo que quedaría obsoleto entre el SELECT y
    // el INSERT. Lo que este test fija es que la route NO inventa un camino distinto y que la fila
    // que se le pide escribir es SIEMPRE la misma — con `verifiedAt` como único campo que varía, y
    // que el store descarta (T-REPO-4 mide que no se mueve).
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => APPROVED_WITH_OWNER })));
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
