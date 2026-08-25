// Tests — POST /api/payout/prepare (WKH-211 W1.1). Guards PR1-PR11 fail-closed. La DepositAttestation
// se emite REAL (HMAC de verdad) y DEBE verificar con verifyDepositAttestation. fetch al agente + la
// autoridad + el ledger mockeados: cero red real, cero orden TransFi real (CD-1/AC-4).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Rate-limit: sin Upstash env → fail-closed 503; mockeamos a { ok:true } por default (mismo patrón
// que challenge.route.test.ts). clientIp/DEPOSIT_PREPARE_RL se conservan reales.
const { checkRouteRateLimitMock } = vi.hoisted(() => ({ checkRouteRateLimitMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/infrastructure/rate-limit")>();
  return { ...actual, checkRouteRateLimit: checkRouteRateLimitMock };
});

// Autoridad server-side (WKH-202): default authorized. Los tests de guard la overridean.
const { authorityMock } = vi.hoisted(() => ({ authorityMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/payout/authority", () => ({
  resolvePayoutAuthority: authorityMock,
}));

// WKH-333 — store del veredicto de KYC.
//
// 🔴 EL DEFAULT CAMBIÓ EN EL FIX-PACK DEL AR (BLQ-ALTO-1), y la razón importa. Era `null` (flag OFF)
// "para que TODOS los tests de arriba corran exactamente como antes de esta HU". Esa premisa era
// falsa: con el flag apagado la ruta NO conserva su camino: no tiene de dónde sacar el identificador
// (el del cliente no se acepta, CD-26) y corta con 503. Con el default en `null`, los 55 casos de
// guard-order de este archivo pasaban a medir el corte por flag apagado en vez del guard que cada uno
// dice medir.
// Ahora el default es una fila REAL de la address del caller (ver `storeConFilaDe`), o sea el estado
// de producción con el flag encendido. Los casos que cortan ANTES de PR5.5 no lo tocan nunca; los que
// llegan más allá miden lo que dicen medir. El flag apagado tiene sus dos casos propios: `T-PR-12` acá
// y `route.flag-off.test.ts`, este último con la autoridad REAL.
const { getVerdictStoreMock } = vi.hoisted(() => ({ getVerdictStoreMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/persistence/supabase-kyc-verdicts", () => ({
  getKycVerdictStore: getVerdictStoreMock,
}));

// Ledger: default null (flag OFF ⇒ byte-idéntico). Un test lo apunta a un mock.
const { ledgerMock, getLedgerMock } = vi.hoisted(() => ({
  ledgerMock: { recordOrderPrepared: vi.fn() },
  getLedgerMock: vi.fn(),
}));
vi.mock("../../../../src/infrastructure/persistence/supabase-settlement-ledger", () => ({
  getSettlementLedger: getLedgerMock,
  // WKH-320: la route también importa esta constante del mismo módulo. Si el factory no la exporta,
  // llega `undefined` a la route y el bloque del ledger se cae en silencio dentro de su try/catch
  // best-effort — o sea, el test verde y el ledger sin escribir. Se re-exporta con su valor real.
  CHAIN_ID_NOT_APPLICABLE: 0,
}));

import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  issueSolanaPopChallenge,
  buildSolanaPopMessage,
} from "../../../../src/infrastructure/auth/pop-challenge";
import { verifySolanaDepositAttestation } from "../../../../src/infrastructure/settlement/deposit-attestation";
// WKH-304/CD-11: el par (capacidad, piso) se assertea contra las MISMAS constantes que consume la
// route y que consume submit — nunca contra literales copiados en el test.
import {
  FX_MIN_REPUTATION,
  PAYOUT_CAPABILITY,
  PAYOUT_MIN_REPUTATION,
} from "../../../../src/infrastructure/a2a/gateway-client";
import { POST } from "./route";
// El leg de FX, para poder afirmar la ASIMETRÍA en una sola corrida (ver el candado del carril de
// estreno al final del archivo). Se importa la route, no se la re-implementa: un test que copiara
// las constraints de FX a mano seguiría verde el día que alguien se las saque de verdad.
import { POST as QUOTE_POST } from "../../a2a/quote/route";

// WKH-320: la ruta dejó de tener dispatch por VM. El caller manda una address base58 y el PoP es
// OBLIGATORIO, así que el body por defecto de TODOS los tests de guard-order lleva un PoP ed25519
// REAL firmado en el beforeEach (antes el default era una address 0x y el PoP apagado). Las
// assertions de orden, códigos HTTP y enums NO cambian: eso es exactamente lo que CD-4 protege.
const DEPOSIT = "So11111111111111111111111111111111111111112"; // deposit-address base58 del agente
const beneficiary = { name: "Mamá", country: "PE", method: "yape", destination: "999888777" };

// Seteados en el beforeEach: el keypair que firma el PoP y su pubkey (= address del caller).
let KP: nacl.SignKeyPair;
let ADDR: string;
let AUTHORITY: string;

function bodyOf(over: Record<string, unknown> = {}) {
  return {
    remittanceId: "rem-1",
    quoteId: "q-400",
    kycVerificationId: "v-1",
    address: ADDR,
    amountUsd: 400,
    beneficiary,
    idempotencyKey: "rem-1:q-400",
    ...signedSolanaPop(KP, ADDR), // PR6 es OBLIGATORIO: sin esto todo muere en 403
    ...over,
  };
}
function req(payload: unknown): Request {
  return new Request("http://localhost/api/payout/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
function rawReq(raw: string): Request {
  return new Request("http://localhost/api/payout/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

// Las envs del ÚNICO transporte. Suben a nivel de módulo en WKH-332/W3 porque ahora las necesita el
// `beforeEach` raíz: antes el default de los ~50 casos de guard-order era el carril punto a punto y
// el gateway se configuraba sólo dentro de su propio describe.
const GW = "https://gateway.test";
const GW_KEY = "ak_prepare_secret";

/**
 * El agente contesta — POR EL GATEWAY, que es el único transporte desde W3.
 *
 * 🔴 QUÉ CAMBIÓ Y POR QUÉ NO ES COSMÉTICO. Este helper devolvía `{ result }` con el status pedido,
 * que era la respuesta del `fetch({BASE}/api/agents/<slug>/invoke)`. Ese fetch no existe más, así
 * que un mock con esa forma haría que los ~50 casos de guard-order de este archivo midieran un
 * `bad_response` del cliente del gateway en vez del guard que cada uno dice medir. Ahora envuelve el
 * mismo `result` en la forma de `POST /compose` (`{ success:true, steps:[{ output }] }`), que es lo
 * que `runViaGateway` sabe leer.
 *
 * `status` sigue significando lo mismo para el llamador: el status HTTP de la respuesta upstream. Un
 * 502 sigue saliendo por `prepare_upstream_error` (antes por `!res.ok`, ahora por `unavailable`).
 */
function agentResponds(status: number, result: unknown): void {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ success: true, steps: [{ output: result }] }), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}
/** Mini-store HONESTO: filtra por `senderAddress` como lo hace el `.eq(...)` de Postgres. Con un
 *  `vi.fn().mockResolvedValue(fila)`, quitarle el filtro por dueño a la ruta (M-29) dejaría estos
 *  tests en verde y el IDOR entraría con la suite aplaudiendo (CD-17).
 *  Vive a nivel de módulo porque los DOS `describe` de este archivo lo usan: el de abajo para sus
 *  casos, y el de arriba como default del `beforeEach` (ver la nota del `vi.mock`). */
function honestVerdictStore(rows: Array<{ senderAddress: string; verificationId: string }>) {
  const get = vi.fn(async (sender: string) => {
    const hit = rows.find((r) => r.senderAddress === sender);
    return hit
      ? {
          senderAddress: hit.senderAddress,
          verificationId: hit.verificationId,
          approved: true,
          riskLevel: "low" as const,
          provenance: "didit",
          verifiedAt: "2026-08-01T00:00:00.000Z",
        }
      : null;
  });
  return { get, put: vi.fn() };
}

/** El default de los dos `beforeEach`: el caller TIENE su fila. `ADDR` se regenera en cada test, así
 *  que esto se llama adentro del `beforeEach` y no una vez a nivel de módulo. */
function storeConFilaDe(address: string) {
  return honestVerdictStore([{ senderAddress: address, verificationId: "did-de-la-fila-default" }]);
}

function agentResult(over: Record<string, unknown> = {}) {
  return {
    status: "submitted",
    payoutId: "transfi-po-1",
    deliveredLocal: null,
    txRef: null,
    reason: null,
    provenance: "transfi",
    depositAddress: DEPOSIT,
    ...over,
  };
}

// HU-SOL-11 — PoP Solana firmado REAL (ed25519), portado de submit/route.test.ts:983-1000. El challenge
// corre REAL (HMAC de verdad, exige PAYOUT_POP_SECRET stubeado) y la firma es REAL (nacl). CD-10: la
// address del challenge = pubkey del keypair (P3 pasa); networkId solana:devnet (P4 pasa).
function signedSolanaPop(keypair: nacl.SignKeyPair, addr: string) {
  const ch = {
    address: addr,
    networkId: "solana:devnet",
    nonce: "abcdef0123456789abcdef0123456789",
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const popChallenge = issueSolanaPopChallenge(ch);
  const popSignature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(buildSolanaPopMessage(ch)), keypair.secretKey),
  );
  return { popChallenge, popSignature };
}

describe("POST /api/payout/prepare (WKH-211)", () => {
  beforeEach(() => {
    KP = nacl.sign.keyPair();
    ADDR = bs58.encode(KP.publicKey); // pubkey del firmante = address del caller (P3)
    AUTHORITY = bs58.encode(nacl.sign.keyPair().publicKey); // CD-10: NUNCA base58 a mano
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "test-deposit-secret");
    vi.stubEnv("SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY", AUTHORITY);
    vi.stubEnv("VERCEL_ENV", ""); // local/CI por default
    vi.stubEnv("PAYOUT_POP_SECRET", "pop-secret"); // PR6 OBLIGATORIO (WKH-320): nunca skip
    // 🔴 ACÁ SE STUBEABA LA BASE DE LOS AGENTES Y EL FLAG DE TRANSPORTE EN "" (WKH-332/W3).
    // Las dos se fueron: PR1 ya no existe (la env se borró del código) y PR7 ya no lee el flag —hay
    // un solo transporte—. Lo que hace falta configurar ahora es el gateway, porque sin él TODOS los
    // casos que llegan hasta PR7 cortarían con 501 `not_configured` y medirían eso en vez del guard
    // que cada uno dice medir. Que ningún `it` de este archivo stubee la env vieja es la evidencia de
    // runtime de que la ruta dejó de leerla.
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", GW);
    vi.stubEnv("WASIAI_A2A_AGENT_KEY", GW_KEY);
    checkRouteRateLimitMock.mockReset();
    checkRouteRateLimitMock.mockResolvedValue({ ok: true });
    authorityMock.mockReset();
    authorityMock.mockResolvedValue({ authorized: true, httpStatus: 200 });
    ledgerMock.recordOrderPrepared.mockReset();
    ledgerMock.recordOrderPrepared.mockResolvedValue(undefined);
    getLedgerMock.mockReset();
    getLedgerMock.mockReturnValue(null);
    getVerdictStoreMock.mockReset();
    // WKH-333 + AR/BLQ-ALTO-1: el caller TIENE su fila (flag encendido = producción). Ver la nota
    // larga del `vi.mock` de este módulo, arriba.
    getVerdictStoreMock.mockReturnValue(storeConFilaDe(ADDR));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ── Happy path (AC-1) ──────────────────────────────────────────────────────
  it("AC-1: config OK + agente con depositAddress real → 200 { beneficiary, authority, attestation, payoutId, provenance }; la attestation VERIFICA", async () => {
    agentResponds(200, agentResult());
    const res = await POST(req(bodyOf()));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.beneficiary).toBe(DEPOSIT);
    expect(json.authority).toBe(AUTHORITY);
    expect(json.payoutId).toBe("transfi-po-1");
    expect(json.provenance).toBe("transfi");
    // La attestation es real: verifica con el secreto y ata remittanceId/quoteId/beneficiary/cluster.
    const att = verifySolanaDepositAttestation(json.attestation as string, Date.now());
    expect(att).not.toBeNull();
    expect(att?.remittanceId).toBe("rem-1");
    expect(att?.quoteId).toBe("q-400");
    expect(att?.beneficiary).toBe(DEPOSIT);
    expect(att?.authority).toBe(AUTHORITY); // CD-9: de la ENV server-side, NUNCA del body
    expect(att?.cluster).toBe("devnet");
    // NUNCA ecoa la URL del transporte ni el beneficiary (CD-5). Antes acá se buscaba la base de los
    // agentes; se busca el gateway, que es la URL que la ruta realmente tiene en la mano — un assert
    // contra una cadena que ya no existe en ninguna parte pasa siempre y no protege nada.
    const raw = JSON.stringify(json);
    expect(raw).not.toContain(GW);
    expect(raw).not.toContain("Mamá");
    expect(raw).not.toContain("999888777");
  });

  // ── PR2 — config (AC-7) ────────────────────────────────────────────────────
  //
  // T-9.2 (WKH-332/AC-9) — LA MUERTE DE PR1, ASSERTADA EN LAS DOS DIRECCIONES.
  //
  // 🔴 ACÁ ESTABA `it("PR1: sin la base de los agentes → 501 …")`, y se INVIRTIÓ, no se borró. PR1 era
  // el primer guard de la ruta y era el único que se va con esta HU: leía la env de la base de los
  // agentes remit-*, que existía para armar la URL con el slug adentro. Sin ese fetch, el guard
  // custodiaba una configuración que nadie usa, o sea que devolvía 501 a un deployment que podía
  // pagar perfectamente.
  //
  // Las dos mitades son necesarias y ninguna alcanza sola: la primera prueba que el guard SE FUE, la
  // segunda que su MOTIVO —"sin configuración no se crea ninguna orden"— sigue en pie y ahora lo
  // sostiene la config que de verdad se usa. Sin la segunda, borrar PR1 sería aflojar un fail-closed.
  it("T-9.2: la base de los agentes remit-* dejó de ser un guard, y el 501 lo produce la config que SÍ se usa", async () => {
    // (a) sin la env vieja —ni stubeada ni presente— la ruta llega al forward y devuelve 200.
    agentResponds(200, agentResult());
    const sinBaseVieja = await POST(req(bodyOf()));
    expect(
      sinBaseVieja.status,
      "la ruta volvió a exigir la env del carril borrado: eso es un 501 a un deployment que puede pagar",
    ).toBe(200);

    // (b) sin la URL del gateway —la única configuración de transporte que queda— SÍ corta con 501,
    // y SIN un solo fetch: `runViaGateway` resuelve `not_configured` antes de tocar la red.
    fetchMock.mockClear();
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sinGateway = await POST(req(bodyOf()));
    expect(sinGateway.status).toBe(501);
    expect(await sinGateway.json()).toEqual({ error: "prepare_not_configured" });
    expect(fetchMock, "se intentó un fetch con el transporte sin configurar").not.toHaveBeenCalled();
  });

  it("PR2: sin DEPOSIT_ATTESTATION_SECRET → 503 prepare_unavailable (fail-closed, NUNCA fail-open)", async () => {
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "");
    const res = await POST(req(bodyOf()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "prepare_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── T-9.1 · AC-9 / CD-4 · EL GUARD-ORDER, MEDIDO COMO SECUENCIA Y NO COMO PROSA ────────────────
  //
  // 🔴 QUÉ AGUJERO CIERRA, Y POR QUÉ NO ALCANZABAN LOS `it` QUE YA ESTABAN. El orden de los guards
  // estaba custodiado a pedazos: cada `it` mira un corte y asserta "y no se llamó a X". Eso caza que
  // un guard DESAPAREZCA, y NO caza que dos guards INTERCAMBIEN posición cuando los dos siguen
  // cortando. El caso concreto: mover el bloque de la fila del veredicto (PR5.5, el que WKH-333 dejó
  // y que CD-13 prohíbe tocar) DESPUÉS de la consulta a la autoridad. Los dos siguen ahí, los dos
  // siguen cortando, y la ruta pasa a gastar un fetch al proveedor de identidad por cada intento de
  // un caller que no tiene fila — que es exactamente el oráculo que WKH-333 cerró.
  //
  // Cómo se mide: cada doble empuja su nombre a un log compartido, y se asserta la SECUENCIA. Un
  // intercambio de dos bloques cambia el array aunque los dos status finales sean los mismos.
  //
  // CD-17: depende del `beforeEach` de este describe (que resetea los tres dobles y configura el
  // gateway). Los tres primeros casos se corren en el MISMO `it` a propósito: comparados entre sí,
  // no cada uno contra su propia expectativa.
  it("T-9.1: el orden observable de los cortes es 503-secreto → rate-limit → formato → PoP → fila → autoridad → forward", async () => {
    const orden: string[] = [];
    checkRouteRateLimitMock.mockImplementation(async () => {
      orden.push("rate-limit");
      return { ok: true };
    });
    const store = {
      get: vi.fn(async (sender: string) => {
        orden.push("fila-del-veredicto");
        return sender === ADDR
          ? {
              senderAddress: ADDR,
              verificationId: "did-de-la-fila-default",
              approved: true,
              riskLevel: "low" as const,
              provenance: "didit",
              verifiedAt: "2026-08-01T00:00:00.000Z",
            }
          : null;
      }),
      put: vi.fn(),
    };
    getVerdictStoreMock.mockReturnValue(store);
    authorityMock.mockImplementation(async () => {
      orden.push("autoridad");
      return { authorized: true, httpStatus: 200 };
    });
    fetchMock.mockImplementation(async () => {
      orden.push("forward");
      return new Response(JSON.stringify({ success: true, steps: [{ output: agentResult() }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // (a) EL CAMINO COMPLETO: la secuencia entera, en orden, sin repeticiones.
    const ok = await POST(req(bodyOf()));
    expect(ok.status).toBe(200);
    expect(
      orden,
      "el guard-order cambió: dos bloques intercambiaron posición aunque los dos sigan cortando",
    ).toEqual(["rate-limit", "fila-del-veredicto", "autoridad", "forward"]);

    // (b) SIN SECRETO ⇒ 503 ANTES del rate-limit. El rate-limit consume una cuota de Upstash: un
    // deployment que no puede atestar no tiene por qué gastarla.
    orden.length = 0;
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "");
    const sinSecreto = await POST(req(bodyOf()));
    expect(sinSecreto.status).toBe(503);
    expect(orden, "el 503 por falta de secreto corrió DESPUÉS del rate-limit").toEqual([]);
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "test-deposit-secret");

    // (c) PoP INVÁLIDO ⇒ 403 ANTES de tocar el store del veredicto. Se cuenta la llamada al doble, no
    // se infiere del status: un 403 puede salir igual habiendo leído la fila.
    orden.length = 0;
    const popRoto = await POST(req(bodyOf({ popSignature: "3".repeat(88) })));
    expect(popRoto.status).toBe(403);
    expect(orden, "el PoP inválido llegó a leer la fila del veredicto").toEqual(["rate-limit"]);

    // (d) SIN FILA ⇒ 403 ANTES de cualquier consulta a la autoridad. Es la mitad que mata al mutante
    // M8: con PR5.5 corrido después de la autoridad, acá aparecería "autoridad" en el log.
    orden.length = 0;
    getVerdictStoreMock.mockReturnValue({
      get: vi.fn(async () => {
        orden.push("fila-del-veredicto");
        return null;
      }),
      put: vi.fn(),
    });
    const sinFila = await POST(req(bodyOf()));
    expect(sinFila.status).toBe(403);
    expect(
      orden,
      "sin fila la ruta igual consultó al proveedor de identidad: eso es cupo nuestro que cualquiera " +
        "drena con un curl, y el oráculo que WKH-333 cerró",
    ).toEqual(["rate-limit", "fila-del-veredicto"]);
  });

  // ── PR3 — rate-limit (AC-6) ────────────────────────────────────────────────
  it("PR3: rate-limit !ok → 429 con Retry-After; unavailable → 503; NINGÚN fetch", async () => {
    checkRouteRateLimitMock.mockResolvedValue({ ok: false, retryAfter: 42 });
    const r429 = await POST(req(bodyOf()));
    expect(r429.status).toBe(429);
    expect(r429.headers.get("Retry-After")).toBe("42");
    expect(fetchMock).not.toHaveBeenCalled();

    checkRouteRateLimitMock.mockResolvedValue({ ok: false, unavailable: true });
    const r503 = await POST(req(bodyOf()));
    expect(r503.status).toBe(503);
    expect(await r503.json()).toEqual({ error: "prepare_rate_limit_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── PR4 — formato (CD-9) ───────────────────────────────────────────────────
  it("PR4/CD-9: body null literal → 400 (nunca 500); campos faltantes/address malformada → 400, NINGÚN fetch", async () => {
    expect((await POST(rawReq("null"))).status).toBe(400);
    // ⚠️ CAMBIÓ EN WKH-333: `{ kycVerificationId: "" }` SALIÓ de esta lista. Exigirlo en el guard de
    // formato era exigirle al cliente un dato que ya no le corresponde tener, y rechazar por su
    // ausencia sería un camino de respaldo escondido dentro de un guard de formato. Hoy el valor del
    // body se lee para DESCARTARLO (AC-16) y el identificador sale de la fila del dueño
    // PoP-verificado; que un cliente lo mande, lo mande vacío o no lo mande es indistinguible, y eso
    // se asserta en T-PR-8.
    for (const over of [
      { remittanceId: "" },
      { quoteId: "" },
      { address: "0xNOPE" },
      { address: 123 },
    ]) {
      const res = await POST(req(bodyOf(over)));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "prepare_invalid_request" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── PR5 — autoridad (AC-6/AC-7) ────────────────────────────────────────────
  it("PR5: KYC no autorizado → 403 payout_not_authorized; authority_unavailable → 503; NINGÚN fetch", async () => {
    authorityMock.mockResolvedValue({ authorized: false, reason: "kyc_not_approved", httpStatus: 200 });
    expect((await POST(req(bodyOf()))).status).toBe(403);

    authorityMock.mockResolvedValue({ authorized: false, reason: "kyc_ownership_mismatch", httpStatus: 200 });
    const r403 = await POST(req(bodyOf()));
    expect(r403.status).toBe(403);
    expect(await r403.json()).toEqual({ error: "payout_not_authorized" }); // no-oracle: mismo enum

    authorityMock.mockResolvedValue({ authorized: false, reason: "kyc_authority_unavailable", httpStatus: 503 });
    expect((await POST(req(bodyOf()))).status).toBe(503);

    authorityMock.mockResolvedValue({ authorized: false, reason: "reason_desconocido", httpStatus: 200 });
    expect((await POST(req(bodyOf()))).status).toBe(502); // fail-closed default

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("AC-6: autoridad simulated_dev en Vercel → 503 (nunca autoriza por simulación en deploy)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    authorityMock.mockResolvedValue({ authorized: true, reason: "simulated_dev", httpStatus: 200 });
    const res = await POST(req(bodyOf()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "payout_authority_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── PR6 — PoP (AC-6) ───────────────────────────────────────────────────────
  it("AC-6: con PAYOUT_POP_SECRET, sin popChallenge/popSignature válidos → 403 payout_pop_unverified, NINGÚN fetch", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "pop-secret");
    const res = await POST(req(bodyOf({ popChallenge: undefined, popSignature: undefined })));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_pop_unverified" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── PR7/PR8 — forward + depositAddress (AC-7 fail-closed) ──────────────────
  it("AC-7: agente 502 → 502; timeout → 502 (nunca 500 crudo)", async () => {
    agentResponds(502, {});
    expect((await POST(req(bodyOf()))).status).toBe(502);
    fetchMock.mockRejectedValue(new Error("timeout"));
    const to = await POST(req(bodyOf()));
    expect(to.status).toBe(502);
    expect(await to.json()).toEqual({ error: "prepare_upstream_error" });
  });

  it("AC-7 (el corazón): agente devuelve depositAddress:null (mock) → 502 prepare_no_deposit_address; NUNCA se atesta", async () => {
    agentResponds(200, agentResult({ depositAddress: null }));
    const res = await POST(req(bodyOf()));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "prepare_no_deposit_address" });
  });

  it("AC-7: depositAddress malformado → 502 prepare_no_deposit_address", async () => {
    agentResponds(200, agentResult({ depositAddress: "0xNOT_AN_ADDRESS" }));
    expect((await POST(req(bodyOf()))).status).toBe(502);
  });

  // ── Hallazgo #75 — cinco causas, un enum ───────────────────────────────────
  // `prepare_no_deposit_address` cubría los cuatro rechazos del agente (que llegan en su campo
  // (`reason`, `route.ts:89`), validado de TIPO y nunca leído) MÁS el provider mock. Acá decía
  // `route.ts:62`, sin ancla, y esa línea es el cuerpo de `isRecord`: dice `typeof v === "object"`,
  // o sea que un lector apurado ve un `typeof` y da la cita por buena sin haber comprobado nada
  // (CR/MNR-1). Cada `it` de acá
  // muere si su causa vuelve a colapsar; el último candado muere si el mock deja de ser 502.
  describe("rechazo del agente ≠ 'no nos dio dirección' (hallazgo #75)", () => {
    /** Rechazo del agente: 200 con status blocked/failed + su reason. NO trae depositAddress. */
    function agentRejects(reason: string | null, status: "failed" | "blocked" = "blocked") {
      agentResponds(200, agentResult({ status, payoutId: null, depositAddress: null, reason }));
    }

    it.each([
      ["quote_amount_mismatch", "prepare_quote_amount_mismatch"],
      ["quote_unresolvable", "prepare_quote_unresolvable"],
      ["kyc_identity_claim_missing", "prepare_kyc_identity_claim_missing"],
    ])("reason %s del agente ⇒ 422 %s (ya no prepare_no_deposit_address)", async (reason, enumo) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      agentRejects(reason);
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: enumo });
    });

    // Las tres causas relayables tienen que ser distinguibles ENTRE SÍ, no sólo del enum viejo. Un
    // mapeo que las volviera a colapsar (a `prepare_agent_rejected`, por ejemplo) pasaría los `it`
    // de arriba si el enum esperado fuera el mismo; este los corre juntos y compara.
    it("las tres causas relayables NO comparten enum entre sí", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const enums: string[] = [];
      for (const reason of [
        "quote_amount_mismatch",
        "quote_unresolvable",
        "kyc_identity_claim_missing",
      ]) {
        agentRejects(reason);
        const json = (await (await POST(req(bodyOf()))).json()) as { error: string };
        enums.push(json.error);
      }
      expect(new Set(enums).size).toBe(3);
    });

    // ⚠️ COLAPSADO A PROPÓSITO. `kyc_gate_not_passed` es un VEREDICTO sobre una verificación de
    // identidad: la familia exacta que WKH-205 cerró en /api/payout/validate. Sale como el enum de
    // familia — pero 422 y no 502, así que la mitad que importaba (rechazo, no caída) sí se dice.
    it("kyc_gate_not_passed sale COLAPSADO en prepare_agent_rejected (no-oráculo, WKH-205)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      agentRejects("kyc_gate_not_passed");
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(422);
      const raw = await res.text();
      expect(JSON.parse(raw)).toEqual({ error: "prepare_agent_rejected" });
      expect(raw).not.toContain("kyc_gate_not_passed"); // el veredicto NO viaja al browser
    });

    // ...pero el operador SÍ tiene que poder distinguirlo, y para eso está el log. Mismo patrón que
    // logGatewayFailure: sólo enums, nunca el beneficiary ni la BASE.
    it("el detalle colapsado SÍ queda en el log del server (sólo enums, cero PII)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      agentRejects("kyc_gate_not_passed");
      await POST(req(bodyOf()));
      const logged = JSON.stringify(warn.mock.calls[0]);
      expect(logged).toContain("kyc_gate_not_passed");
      expect(logged).toContain("prepare_agent_rejected");
      expect(logged).not.toContain("Mamá");
      expect(logged).not.toContain("999888777");
    });

    // Un reason que este código no conoce NO se ecoa crudo: se anota `unmapped` (señal útil: "llegó
    // algo que no conozco") y el body sale colapsado. Es el log el que queda value-free POR
    // CONSTRUCCIÓN, no por confiar en que el otro repo nunca mande texto libre.
    it.each([null, "reason_que_no_conocemos", "texto libre con el 999888777 adentro"])(
      "reason desconocido (%s) ⇒ 422 colapsado y log `unmapped`, nunca el string crudo",
      async (reason) => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        agentRejects(reason);
        const res = await POST(req(bodyOf()));
        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({ error: "prepare_agent_rejected" });
        const logged = JSON.stringify(warn.mock.calls[0]);
        expect(logged).toContain("unmapped");
        expect(logged).not.toContain("999888777");
      },
    );

    it("status failed (no sólo blocked) también cuenta como rechazo", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      agentRejects("quote_unresolvable", "failed");
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "prepare_quote_unresolvable" });
    });

    // ── CANDADO DE NO-REGRESIÓN ──────────────────────────────────────────────
    // La quinta causa NO es un rechazo y no puede irse con las otras cuatro: el provider mock
    // contesta `status:"submitted"` con `depositAddress:null`, o sea una respuesta INCOMPLETA. Ahí
    // `prepare_no_deposit_address` describe bien lo que pasó y tiene que seguir siendo 502.
    it("CANDADO: el mock (submitted + depositAddress null) SIGUE siendo 502 prepare_no_deposit_address", async () => {
      agentResponds(200, agentResult({ depositAddress: null }));
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "prepare_no_deposit_address" });
    });

    it("CANDADO: el agente caído (502/timeout) SIGUE siendo 502 prepare_upstream_error", async () => {
      agentResponds(502, {});
      expect((await POST(req(bodyOf()))).status).toBe(502);
      fetchMock.mockRejectedValue(new Error("timeout"));
      const to = await POST(req(bodyOf()));
      expect(to.status).toBe(502);
      expect(await to.json()).toEqual({ error: "prepare_upstream_error" });
    });
  });

  it("PR8: shape del agente inválido (status raro) → 502 prepare_upstream_error", async () => {
    agentResponds(200, agentResult({ status: "weird" }));
    const res = await POST(req(bodyOf()));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "prepare_upstream_error" });
  });

  // ── PR10 — ledger best-effort (AC-8/CD-17) ─────────────────────────────────
  it("PR10/AC-8: ledger ON → recordOrderPrepared con IDs/address/chainId (NUNCA PII); 200 igual", async () => {
    getLedgerMock.mockReturnValue(ledgerMock);
    agentResponds(200, agentResult());
    const res = await POST(req(bodyOf()));
    expect(res.status).toBe(200);
    expect(ledgerMock.recordOrderPrepared).toHaveBeenCalledTimes(1);
    const arg = ledgerMock.recordOrderPrepared.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.remittanceId).toBe("rem-1");
    expect(arg.depositAddress).toBe(DEPOSIT);
    expect(arg.chainId).toBe(0); // WKH-320: CHAIN_ID_NOT_APPLICABLE — vmNetworkColumns lo descarta
    expect(arg.vm).toBe("solana");
    expect(arg.senderAddress).toBe(ADDR);
    expect(arg.payoutId).toBe("transfi-po-1");
    // NUNCA PII del beneficiary.
    expect(JSON.stringify(arg)).not.toContain("Mamá");
    expect(JSON.stringify(arg)).not.toContain("999888777");
  });

  // ── El CANDADO de la proveniencia ────────────────────────────────────────────────────────────────
  // El bug: `provenanceSol` se leía del result del agente (route.ts), se mandaba en el 200 y NO se le
  // pasaba al ledger — estaba a UNA LÍNEA de distancia. Consecuencia: toda fila de una orden simulada
  // quedaba indistinguible de una real, y la tabla de "evidencia money-path" no podía contestar si
  // había movido plata.
  //
  // El candado tiene DOS mitades, y hacen falta las dos:
  //   · COMPILACIÓN: `payoutProvenance: string` (sin `?`) en el port ⇒ BORRAR el pase no compila.
  //     Eso ya mata el bug exacto que ocurrió, pero no mata al que hardcodea un valor.
  //   · ESTOS TESTS: lo que llega al ledger es EL MISMO valor que el 200 le cuenta al browser, y
  //     CAMBIA cuando el agente dice otra cosa. Un literal fijo en el call-site se pone rojo acá.
  describe("PR10 — la proveniencia que declara el agente LLEGA al ledger (candado)", () => {
    it("agente 'transfi' ⇒ el ledger recibe 'transfi', el MISMO valor que sale en el 200", async () => {
      getLedgerMock.mockReturnValue(ledgerMock);
      agentResponds(200, agentResult({ provenance: "transfi" }));
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(200);
      const arg = ledgerMock.recordOrderPrepared.mock.calls[0]![0] as Record<string, unknown>;
      expect(arg.payoutProvenance).toBe("transfi");
      expect(arg.payoutProvenance).toBe((await res.json()).provenance); // ni una copia ni un recálculo
    });

    it("agente 'devnet-stub' ⇒ el ledger recibe 'devnet-stub' (NO un literal fijo del call-site)", async () => {
      getLedgerMock.mockReturnValue(ledgerMock);
      agentResponds(200, agentResult({ provenance: "devnet-stub" }));
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(200);
      const arg = ledgerMock.recordOrderPrepared.mock.calls[0]![0] as Record<string, unknown>;
      // Esta es la assertion que MUERE si alguien clava "transfi" en la llamada al ledger, que es
      // exactamente la forma en que este bug puede volver sin romper la compilación.
      expect(
        arg.payoutProvenance,
        "el ledger tiene que recibir lo que DIJO el agente, no un valor decidido en el call-site",
      ).toBe("devnet-stub");
      expect(arg.payoutProvenance).toBe((await res.json()).provenance);
    });

    it("dos órdenes con proveniencias distintas ⇒ el ledger recibe valores DISTINTOS (no una constante)", async () => {
      getLedgerMock.mockReturnValue(ledgerMock);
      agentResponds(200, agentResult({ provenance: "transfi" }));
      expect((await POST(req(bodyOf()))).status).toBe(200);
      agentResponds(200, agentResult({ provenance: "local-fallback" }));
      expect((await POST(req(bodyOf()))).status).toBe(200);
      const first = ledgerMock.recordOrderPrepared.mock.calls[0]![0] as Record<string, unknown>;
      const second = ledgerMock.recordOrderPrepared.mock.calls[1]![0] as Record<string, unknown>;
      expect(first.payoutProvenance).not.toBe(second.payoutProvenance);
      expect([first.payoutProvenance, second.payoutProvenance]).toEqual(["transfi", "local-fallback"]);
    });

    it("el agente NO declara proveniencia ⇒ el ledger recibe '' (ausencia), no un default inventado", async () => {
      getLedgerMock.mockReturnValue(ledgerMock);
      agentResponds(200, agentResult({ provenance: undefined }));
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(200);
      const arg = ledgerMock.recordOrderPrepared.mock.calls[0]![0] as Record<string, unknown>;
      expect(arg.payoutProvenance).toBe(""); // el ledger lo persiste como NULL: "no consta"
    });

    it("una proveniencia NO string (el agente mandó basura) ⇒ '' y el 200 sigue saliendo", async () => {
      getLedgerMock.mockReturnValue(ledgerMock);
      agentResponds(200, agentResult({ provenance: 42 }));
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(200); // el money-path no se rompe por una etiqueta
      const arg = ledgerMock.recordOrderPrepared.mock.calls[0]![0] as Record<string, unknown>;
      expect(arg.payoutProvenance).toBe("");
    });
  });

  it("CD-17: ledger ON + recordOrderPrepared throw → prepare responde 200 igual (best-effort)", async () => {
    getLedgerMock.mockReturnValue(ledgerMock);
    ledgerMock.recordOrderPrepared.mockRejectedValue(new Error("db down"));
    agentResponds(200, agentResult());
    const res = await POST(req(bodyOf()));
    expect(res.status).toBe(200);
    expect(ledgerMock.recordOrderPrepared).toHaveBeenCalledTimes(1);
  });

  // ── HU-SOL-8: PR6 — PoP OBLIGATORIO (AC-3). El address del caller es un pubkey base58 (pasa PR4)
  //    y llega a PR6. Las assertions (503/403/no-fetch) NO cambian con WKH-320: eso es CD-4. ──
  const SOL_ADDR = "So11111111111111111111111111111111111111112"; // base58 pubkey (pasa PR4)
  describe("PR6 — PoP obligatorio (HU-SOL-8)", () => {
    it("AC-3: PAYOUT_POP_SECRET unset ⇒ 503 payout_pop_unavailable, NINGÚN fetch (jamás skip)", async () => {
      // El body se arma ANTES de apagar el secreto: issueSolanaPopChallenge lo necesita para firmar.
      // Que el PoP venga BIEN FORMADO es lo que hace fuerte al caso: el 503 no se explica por un body
      // incompleto, se explica por el secreto ausente (fail-closed, jamás skip).
      const body = bodyOf({ address: SOL_ADDR });
      vi.stubEnv("PAYOUT_POP_SECRET", ""); // OBLIGATORIO: sin secreto → 503 fail-closed
      const res = await POST(req(body));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "payout_pop_unavailable" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("AC-3: secreto presente + sin popChallenge/popSignature ⇒ 403 payout_pop_unverified, NINGÚN fetch", async () => {
      vi.stubEnv("PAYOUT_POP_SECRET", "pop-secret");
      const res = await POST(
        req(bodyOf({ address: SOL_ADDR, popChallenge: undefined, popSignature: undefined })),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "payout_pop_unverified" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ── HU-SOL-11: BLOQUE DE RESPUESTA (PR8-PR11). PoP ed25519 REAL válido (OBLIGATORIO)
  //    → 200 con el shape del gateway {beneficiary,authority,attestation,
  //    payoutId,provenance} base58. La atestación es REAL (verifica con verifySolanaDepositAttestation).
  //    beneficiary = deposit-address base58 del agente; caller.address = pubkey del keypair que firma PR6. ──
  describe("bloque de respuesta PR8-PR11 (HU-SOL-11)", () => {
    const SOL_BENEFICIARY = "So11111111111111111111111111111111111111112"; // base58 válido (== SOL_ADDR)
    let kp: nacl.SignKeyPair;
    let callerAddr: string;
    let authorityPubkey: string;
    beforeEach(() => {
      kp = nacl.sign.keyPair();
      callerAddr = bs58.encode(kp.publicKey); // pubkey del firmante = address del caller (P3)
      authorityPubkey = bs58.encode(nacl.sign.keyPair().publicKey); // CD-10: NUNCA base58 a mano
      vi.stubEnv("PAYOUT_POP_SECRET", "pop-secret"); // OBLIGATORIO en Solana para pasar PR6
      vi.stubEnv("SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY", authorityPubkey);
      // Este bloque firma con SU PROPIO keypair, no con el `ADDR` del `beforeEach` de arriba, así que
      // necesita su propia fila: el store del default está indexado por dueño y NO le devolvería
      // ninguna (que es justamente lo que hay que preservar — ver M-29).
      getVerdictStoreMock.mockReturnValue(storeConFilaDe(callerAddr));
    });

    it("AC-1: PoP válido + depositAddress base58 → 200 shape Solana; la atestación VERIFICA", async () => {
      agentResponds(200, agentResult({ depositAddress: SOL_BENEFICIARY }));
      const res = await POST(
        req(bodyOf({ address: callerAddr, ...signedSolanaPop(kp, callerAddr) })),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      // Shape EXACTO de isValidSolanaPrepareShape (http-solana-prepare-gateway.ts:87).
      expect(json.beneficiary).toBe(SOL_BENEFICIARY);
      expect(json.authority).toBe(authorityPubkey);
      expect(json.payoutId).toBe("transfi-po-1");
      expect(typeof json.provenance).toBe("string");
      // La atestación Solana es REAL: verifica y ata beneficiary/authority/cluster.
      const att = verifySolanaDepositAttestation(json.attestation as string, Date.now());
      expect(att).not.toBeNull();
      expect(att?.beneficiary).toBe(SOL_BENEFICIARY);
      expect(att?.authority).toBe(authorityPubkey);
      expect(att?.cluster).toBe("devnet");
      // NUNCA ecoa PII del beneficiary ni la URL del transporte (CD-5).
      const raw = JSON.stringify(json);
      expect(raw).not.toContain("Mamá");
      expect(raw).not.toContain("999888777");
      expect(raw).not.toContain(GW);
    });

    it("AC-2: authority env ausente/malformada → 503 prepare_solana_authority_unavailable", async () => {
      for (const bad of ["", "0xNOT"]) {
        vi.stubEnv("SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY", bad);
        agentResponds(200, agentResult({ depositAddress: SOL_BENEFICIARY }));
        const res = await POST(
          req(bodyOf({ address: callerAddr, ...signedSolanaPop(kp, callerAddr) })),
        );
        expect(res.status).toBe(503);
        // NUNCA payout_authority_unavailable, NUNCA 200 parcial, NO ecoa el env.
        expect(await res.json()).toEqual({ error: "prepare_solana_authority_unavailable" });
      }
    });

    it("AC-3: depositAddress null / no-base58 → 502 prepare_no_deposit_address", async () => {
      for (const bad of [null, "0xNOT_BASE58"]) {
        agentResponds(200, agentResult({ depositAddress: bad }));
        const res = await POST(
          req(bodyOf({ address: callerAddr, ...signedSolanaPop(kp, callerAddr) })),
        );
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: "prepare_no_deposit_address" });
      }
    });

    it("AC-3: depositAddress base58 válido pero payoutId ausente (vacío/whitespace) → 502 prepare_no_deposit_address (guard route.ts:482-486)", async () => {
      // payoutId="" pasa isValidPayoutResult (status submitted) pero muere en el guard fail-closed:
      // no se atesta una orden sin id trackeable. (payoutId=null+submitted lo caza antes PR8 → upstream_error.)
      for (const badPayoutId of ["", "   "]) {
        agentResponds(200, agentResult({ depositAddress: SOL_BENEFICIARY, payoutId: badPayoutId }));
        const res = await POST(
          req(bodyOf({ address: callerAddr, ...signedSolanaPop(kp, callerAddr) })),
        );
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: "prepare_no_deposit_address" });
      }
    });
  });

  // ── WKH-304 W2: rama de gateway de PR7 ───────────────────────────────────────────────────────
  // ESTE es el único leg del money-path que cambia de transporte: el que crea la orden y cuyo
  // depositAddress termina FIRMADO en la DepositAttestation. Por eso la propiedad que más se
  // testea acá no es el happy path, es la NEGATIVA: un fallo del gateway no puede, bajo ninguna
  // circunstancia, terminar creando la orden por otro camino: desde W3 no hay ninguno.
  describe("PR7 por gateway — el único transporte (WKH-304, borrado del carril en WKH-332)", () => {
    // `GW` y `GW_KEY` viven a nivel de módulo desde W3: el `beforeEach` raíz también los necesita.
    // `AGENT_URL` —la URL del agente con su slug adentro— se BORRÓ con el carril que la usaba: no hay
    // ninguna URL que este archivo pueda construir con un nombre de agente adentro.

    function setGatewayEnv() {
      vi.stubEnv("WASIAI_A2A_GATEWAY_URL", GW);
      vi.stubEnv("WASIAI_A2A_AGENT_KEY", GW_KEY);
    }

    /** Router de fetch: el /compose del gateway contra CUALQUIER otra URL.
     *  agentCalls.length > 0 ⇒ alguien reintrodujo un fetch a un agente (prohibido, CD-1/AC-1). */
    function gwRouter(
      opts: {
        output?: unknown;
        status?: number;
        body?: unknown;
        composeThrows?: boolean;
        captureCompose?: (init?: RequestInit) => void;
      } = {},
    ) {
      const agentCalls: string[] = [];
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes("/compose")) {
          if (opts.composeThrows) throw new Error("network");
          opts.captureCompose?.(init);
          const status = opts.status ?? 200;
          const payload =
            opts.body ?? { success: true, steps: [{ output: opts.output ?? agentResult() }] };
          return new Response(JSON.stringify(payload), {
            status,
            headers: { "content-type": "application/json" },
          });
        }
        agentCalls.push(url); // cualquier fetch que no sea /compose: con W3 no debería existir ninguno
        return new Response(JSON.stringify({ result: agentResult() }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      return { agentCalls };
    }

    it("T-A3.1: prepare feliz por gateway ⇒ 200 con beneficiary + attestation que VERIFICA; nunca el agente directo", async () => {
      setGatewayEnv();
      const { agentCalls } = gwRouter();
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.beneficiary).toBe(DEPOSIT);
      expect(json.payoutId).toBe("transfi-po-1");
      // PR9 sigue siendo el ÚNICO emisor: la atestación es REAL y ata la dirección a ESTA remesa.
      const att = verifySolanaDepositAttestation(json.attestation as string, Date.now());
      expect(att).not.toBeNull();
      expect(att?.remittanceId).toBe("rem-1");
      expect(att?.quoteId).toBe("q-400");
      expect(att?.beneficiary).toBe(DEPOSIT);
      expect(att?.authority).toBe(AUTHORITY); // de la ENV server-side, no del body
      // El transporte fue el gateway y SÓLO el gateway.
      const urls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(urls).toEqual([`${GW}/compose`]);
      expect(agentCalls).toHaveLength(0);
      // Ni la URL del gateway ni el PII salen en la respuesta (CD-5/CD-8).
      const raw = JSON.stringify(json);
      expect(raw).not.toContain(GW);
      expect(raw).not.toContain("999888777");
    });

    // Traza del dinero: el 200 tiene que decir QUIÉN dio la dirección que se acaba de atestar.
    // Sin esto, con el carril de estreno encendido, se atesta una dirección sin poder decir de
    // dónde salió.
    it("el 200 informa QUÉ agente dio el depositAddress, sin filtrar la URL del gateway", async () => {
      setGatewayEnv();
      gwRouter({
        body: {
          success: true,
          steps: [
            {
              output: agentResult(),
              agent: {
                slug: "remit-cashout-payout",
                registry: "WasiAI",
                invokeUrl: "https://interno.test/invoke",
                trial: { granted: true, under_min_reputation: 2 },
              },
              resolvedFrom: { capability: "remittance-payout" },
            },
          ],
        },
      });
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.agent).toEqual({
        slug: "remit-cashout-payout",
        registry: "WasiAI",
        capability: "remittance-payout",
        trial: true,
      });
      expect(JSON.stringify(json)).not.toContain("interno.test");
    });

    // La identidad del agente NO es un guard: que no se sepa no puede tumbar un prepare válido.
    it("agente ilegible ⇒ 200 sin la clave agent (el prepare NO se cae por no saber quién fue)", async () => {
      setGatewayEnv();
      gwRouter({
        body: { success: true, steps: [{ output: agentResult(), agent: { registry: "X" } }] },
      });
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.beneficiary).toBe(DEPOSIT);
      expect(json).not.toHaveProperty("agent");
    });

    it("T-A3.2: guard-order INTACTO con el flag encendido (PR3/PR5/PR6/PR4 cortan igual y NINGÚN fetch)", async () => {
      setGatewayEnv();
      gwRouter();

      // PR3 — rate-limit 429 y 503.
      checkRouteRateLimitMock.mockResolvedValue({ ok: false, retryAfter: 42 });
      const r429 = await POST(req(bodyOf()));
      expect(r429.status).toBe(429);
      expect(r429.headers.get("Retry-After")).toBe("42");
      checkRouteRateLimitMock.mockResolvedValue({ ok: false, unavailable: true });
      const r503 = await POST(req(bodyOf()));
      expect(r503.status).toBe(503);
      expect(await r503.json()).toEqual({ error: "prepare_rate_limit_unavailable" });
      checkRouteRateLimitMock.mockResolvedValue({ ok: true });

      // PR4 — formato.
      const r400 = await POST(req(bodyOf({ address: "0xNOPE" })));
      expect(r400.status).toBe(400);
      expect(await r400.json()).toEqual({ error: "prepare_invalid_request" });

      // PR5 — autoridad (403 y 503).
      authorityMock.mockResolvedValue({ authorized: false, reason: "kyc_not_approved", httpStatus: 200 });
      const r403 = await POST(req(bodyOf()));
      expect(r403.status).toBe(403);
      expect(await r403.json()).toEqual({ error: "payout_not_authorized" });
      authorityMock.mockResolvedValue({ authorized: false, reason: "kyc_authority_unavailable", httpStatus: 503 });
      expect((await POST(req(bodyOf()))).status).toBe(503);
      authorityMock.mockResolvedValue({ authorized: true, httpStatus: 200 });

      // PR6 — PoP. WKH-320: es OBLIGATORIO, así que el corte se ejercita QUITÁNDOLE la prueba al
      // body (antes bastaba con encender el secreto, porque sin él la ruta skipeaba).
      const rPop = await POST(req(bodyOf({ popChallenge: undefined, popSignature: undefined })));
      expect(rPop.status).toBe(403);
      expect(await rPop.json()).toEqual({ error: "payout_pop_unverified" });

      // En NINGUNO de los casos se tocó la red: ni el gateway ni el agente.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("T-A3.3: modo gateway + depositAddress ausente/inválido o payoutId vacío ⇒ 502 prepare_no_deposit_address SIN attestation (PR8 sigue mandando)", async () => {
      setGatewayEnv();
      const cases: { label: string; over: Record<string, unknown> }[] = [
        { label: "depositAddress null", over: { depositAddress: null } },
        { label: "depositAddress no-isAddress", over: { depositAddress: "0xNOT_AN_ADDRESS" } },
        { label: "payoutId vacío", over: { payoutId: "" } },
      ];
      for (const c of cases) {
        gwRouter({ output: agentResult(c.over) });
        const res = await POST(req(bodyOf()));
        expect(res.status, c.label).toBe(502);
        const json = (await res.json()) as Record<string, unknown>;
        expect(json, c.label).toEqual({ error: "prepare_no_deposit_address" });
        expect(json, c.label).not.toHaveProperty("attestation");
      }
    });

    // T-A3.4 — EL test de la HU. Si esto pasa a verde con un fallback puesto, la HU no hizo nada.
    //
    // ⚠️ WKH-332/AC-13 — EL STATUS Y EL ENUM ESPERADOS PASARON A SER POR CASO, Y LA RAZÓN ES QUE UNO
    // DE LOS TRES CAMBIÓ DE VEREDICTO. El 422 `no_agent_match` ya no sale como una caída: "nadie
    // cumple la capacidad" no se arregla reintentando y el 502 invitaba a eso. Los otros dos siguen
    // en 502 `prepare_upstream_error`, byte por byte. Lo que este `it` custodia —CERO fallback al
    // agente directo, CERO ledger, body de UNA sola clave— NO cambió y se sigue asertando para los
    // TRES casos por igual: si alguien fuera a colar un fallback, este test se pone rojo lo mismo.
    it("T-A3.4 ANTI-FALLBACK: 422 / 503 / throw del gateway ⇒ corte fail-closed, CERO llamadas al agente, CERO ledger, body = { error }", async () => {
      setGatewayEnv();
      getLedgerMock.mockReturnValue(ledgerMock);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const cases: {
        label: string;
        opts: Parameters<typeof gwRouter>[0];
        /** El status que la RUTA devuelve (distinto del `opts.status`, que es el del gateway). */
        esperado: number;
        error: string;
      }[] = [
        {
          label: "422 no_agent_match (nadie cumple la capacidad con el piso)",
          opts: {
            status: 422,
            body: { error: "no candidates", code: "no_agent_match", reason: "no_candidates", step: 0 },
          },
          // Desenlace PROPIO (AC-13): no es una caída, y decirlo como caída invitaba a reintentar.
          esperado: 422,
          error: "prepare_no_agent_for_capability",
        },
        {
          label: "503 registry_unavailable",
          opts: { status: 503, body: { error: "registry down", error_code: "REGISTRY_UNAVAILABLE" } },
          esperado: 502,
          error: "prepare_upstream_error",
        },
        {
          label: "throw de red",
          opts: { composeThrows: true },
          esperado: 502,
          error: "prepare_upstream_error",
        },
      ];
      for (const c of cases) {
        const { agentCalls } = gwRouter(c.opts);
        const res = await POST(req(bodyOf()));
        expect(res.status, c.label).toBe(c.esperado);
        const json = (await res.json()) as Record<string, unknown>;
        expect(json, c.label).toEqual({ error: c.error });
        // CD-8: el body es EXACTAMENTE { error } — ni detail, ni code, ni el message del gateway.
        expect(Object.keys(json), c.label).toEqual(["error"]);
        // CD-1/AC-1: jamás se creó la orden por otro camino. El assert pasó de "no se llamó a ESA
        // URL" (la del agente por su slug, que ya no se puede construir) a la propiedad que la
        // reemplaza y es más fuerte: ninguna URL emitida contiene la subcadena del carril borrado.
        expect(agentCalls, c.label).toHaveLength(0);
        expect(
          fetchMock.mock.calls.map((x) => x[0] as string).some((u) => u.includes("/api/agents/")),
          c.label,
        ).toBe(false);
      }
      // Y no se escribió NADA en el ledger: sin orden no hay fila que reconciliar después.
      expect(ledgerMock.recordOrderPrepared).not.toHaveBeenCalled();
    });

    it("T-A3.5: modo gateway ⇒ base58 atesta (verifica de verdad); una address no-base58 muere en PR8 (residual R-3)", async () => {
      const kp = nacl.sign.keyPair();
      const callerAddr = bs58.encode(kp.publicKey);
      const authorityPubkey = bs58.encode(nacl.sign.keyPair().publicKey);
      const SOL_BENEFICIARY = "So11111111111111111111111111111111111111112";
      setGatewayEnv();
      vi.stubEnv("SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY", authorityPubkey);
      // Caller propio ⇒ fila propia (el store del default filtra por dueño y no le daría ninguna).
      getVerdictStoreMock.mockReturnValue(storeConFilaDe(callerAddr));

      // (i) el agente que gana la capacidad devuelve base58 ⇒ 200 con atestación Solana REAL.
      gwRouter({ output: agentResult({ depositAddress: SOL_BENEFICIARY }) });
      const ok = await POST(req(bodyOf({ address: callerAddr, ...signedSolanaPop(kp, callerAddr) })));
      expect(ok.status).toBe(200);
      const json = (await ok.json()) as Record<string, unknown>;
      expect(json.beneficiary).toBe(SOL_BENEFICIARY);
      expect(json.authority).toBe(authorityPubkey);
      const att = verifySolanaDepositAttestation(json.attestation as string, Date.now());
      expect(att).not.toBeNull();
      expect(att?.beneficiary).toBe(SOL_BENEFICIARY);
      expect(att?.cluster).toBe("devnet");

      // (ii) R-3: el resolver rechaza por diseño una restricción de chain, así que la capacidad puede
      // resolver a un agente que devuelva una address no-base58. PR8 corta ANTES de atestar. El
      // arreglo real es de catálogo, no de código cliente.
      gwRouter({ output: agentResult({ depositAddress: "0x4444444444444444444444444444444444444444" }) });
      const bad = await POST(req(bodyOf({ address: callerAddr, ...signedSolanaPop(kp, callerAddr) })));
      expect(bad.status).toBe(502);
      const badJson = (await bad.json()) as Record<string, unknown>;
      expect(badJson).toEqual({ error: "prepare_no_deposit_address" });
      expect(badJson).not.toHaveProperty("attestation");
    });

    // ── T-13.1 (WKH-332 / AC-13) — "no hay quién" deja de decirse como "el otro lado se cayó" ────
    //
    // 🔴 LOS DOS DESENLACES EN EL MISMO `it`, Y ESO ES EL TEST. Un `it` que sólo mirara el 422 nuevo
    // daría verde aunque los dos casos salieran por el mismo enum: lo que AC-13 pide no es que exista
    // un 422, es que "ninguna capacidad resolvió" y "el gateway se cayó" dejen de ser indistinguibles
    // para quien mira la pantalla. Reintentar arregla la segunda y no puede arreglar la primera.
    //
    // CD-17: depende del `setGatewayEnv()` de este `describe` y del `getVerdictStoreMock` de su
    // `beforeEach`; sin la fila del veredicto la ruta corta en 403 ANTES de llegar al forward y el
    // test daría verde sin haber ejercitado nada de lo que dice ejercitar.
    it("T-13.1/AC-13: no_agent_match ⇒ 422 con enum propio; una caída ⇒ sigue siendo 502, comparados entre sí", async () => {
      setGatewayEnv();
      vi.spyOn(console, "warn").mockImplementation(() => {});

      // (a) el gateway dice que NINGÚN agente cumple la capacidad bajo el piso del step.
      const sinAgente = gwRouter({
        status: 422,
        body: { code: "no_agent_match", reason: "no_candidates", step: 0 },
      });
      const resSinAgente = await POST(req(bodyOf()));
      const jsonSinAgente = (await resSinAgente.json()) as Record<string, unknown>;

      // (b) el gateway se cayó. CD-22: sólo se abrió `no_agent_match`; todo lo demás sigue en 502.
      const caido = gwRouter({ status: 503, body: { code: "unavailable" } });
      const resCaido = await POST(req(bodyOf()));
      const jsonCaido = (await resCaido.json()) as Record<string, unknown>;

      expect(resSinAgente.status).toBe(422);
      expect(jsonSinAgente).toEqual({ error: "prepare_no_agent_for_capability" });
      expect(resCaido.status).toBe(502);
      expect(jsonCaido).toEqual({ error: "prepare_upstream_error" });

      // La comparación explícita: cualquier mutante que mapee los dos al mismo lado muere acá.
      expect(resSinAgente.status).not.toBe(resCaido.status);
      expect(jsonSinAgente.error).not.toBe(jsonCaido.error);

      // CD-1/CD-5, intactos: ni un fetch punto-a-punto, y el body sigue con UNA sola clave (nada del
      // `message`, el `reason` ni la URL del gateway se ecoa al browser).
      expect(sinAgente.agentCalls).toHaveLength(0);
      expect(caido.agentCalls).toHaveLength(0);
      expect(Object.keys(jsonSinAgente)).toEqual(["error"]);
    });

    // ── WKH-335 (§9.4) — LA PATA DE DINERO. Es el camino que decide A DÓNDE VA LA PLATA, y hasta
    // acá un rechazo del agente por el CONTENIDO del pedido salía con las palabras de una caída.
    //
    // ⚠️ Lo que estos `it` NO prueban, declarado: que el Coordinador REAL emita `agentFailure`.
    // El gateway acá es un doble y el campo lo pone el test. Que `/compose` lo emita de verdad lo
    // prueba `wasiai-a2a/src/services/compose.test.ts` (§9.1) y sólo ese archivo.

    // 🔴 LOS DOS DESENLACES EN EL MISMO `it`, COMPARADOS ENTRE SÍ: un test que sólo mire
    // `INPUT_REJECTED` pasaría igual con los dos mapeados al mismo enum.
    it("T-335-P-1/AC-7: INPUT_REJECTED ⇒ 422 prepare_agent_rejected; AGENT_ERROR ⇒ sigue 502, comparados entre sí", async () => {
      setGatewayEnv();
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const rechazado = gwRouter({
        status: 400,
        body: {
          success: false,
          steps: [],
          error: "Step 0 failed: Agent remit-payout-solana returned 400: bad amount",
          agentFailure: "INPUT_REJECTED",
        },
      });
      const resRechazado = await POST(req(bodyOf()));
      const jsonRechazado = (await resRechazado.json()) as Record<string, unknown>;

      const roto = gwRouter({
        status: 400,
        body: {
          success: false,
          steps: [],
          error: "Step 0 failed: Agent remit-payout-solana returned 500",
          agentFailure: "AGENT_ERROR",
        },
      });
      const resRoto = await POST(req(bodyOf()));
      const jsonRoto = (await resRoto.json()) as Record<string, unknown>;

      expect(resRechazado.status).toBe(422);
      expect(jsonRechazado).toEqual({ error: "prepare_agent_rejected" });
      expect(resRoto.status).toBe(502);
      expect(jsonRoto).toEqual({ error: "prepare_upstream_error" });
      // La comparación explícita: el mutante que mapee los dos al mismo lado muere acá.
      expect(resRechazado.status).not.toBe(resRoto.status);
      expect(jsonRechazado.error).not.toBe(jsonRoto.error);
      // CD-1: cero fallback punto-a-punto en los dos cortes.
      expect(rechazado.agentCalls).toHaveLength(0);
      expect(roto.agentCalls).toHaveLength(0);
    });

    // AC-8: el body sigue con EXACTAMENTE una clave, y el `message` del gateway no se loguea.
    it("T-335-P-2/AC-8: body = { error } y cero eco del gateway; el enum SÍ al log", async () => {
      setGatewayEnv();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { agentCalls } = gwRouter({
        status: 400,
        body: {
          success: false,
          steps: [],
          error: "Step 0 failed: Agent remit-payout-solana returned 422: quote_amount_mismatch",
          agentFailure: "INPUT_REJECTED",
        },
      });
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(422);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json).toEqual({ error: "prepare_agent_rejected" });
      expect(Object.keys(json)).toEqual(["error"]);
      expect(agentCalls).toHaveLength(0);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain("INPUT_REJECTED"); // el enum SÍ (canal de sólo-enums)
      expect(logged).not.toContain("quote_amount_mismatch"); // el message del gateway NO
      expect(logged).not.toContain("remit-payout-solana"); // ni el slug del agente
    });

    // AC-10 — el orden de despliegue equivocado es INOCUO: sin el campo, el 502 de hoy, byte por
    // byte. ⚠️ No prueba que el orden se haya respetado, sólo que equivocarlo no rompe nada.
    it("T-335-P-3: sin agentFailure (gateway viejo) ⇒ 502 prepare_upstream_error, igual que hoy", async () => {
      setGatewayEnv();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { agentCalls } = gwRouter({
        status: 400,
        body: {
          success: false,
          steps: [],
          error: "Step 0 failed: Agent remit-payout-solana returned 400: bad amount",
        },
      });
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "prepare_upstream_error" });
      expect(agentCalls).toHaveLength(0);
    });

    // CD-5 — `payment_required` (402) SIGUE colapsado, y eso es la decisión, no un olvido: habla de
    // NUESTRO saldo de Agent Key, no del pedido de quien llama. El guard por `code === "step_failed"`
    // es lo que impide que la rama nueva se lo lleve puesto aunque el body traiga el campo.
    it("T-335-P-4/CD-5: 402 payment_required sigue colapsado en prepare_upstream_error", async () => {
      setGatewayEnv();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { agentCalls } = gwRouter({
        status: 402,
        // El campo viene puesto A PROPÓSITO: si el guard mirara sólo `agentFailure` y no el `code`,
        // este 402 se iría por el 422 nuevo. Muere acá.
        body: { error: "insufficient budget", code: "payment_required", agentFailure: "INPUT_REJECTED" },
      });
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "prepare_upstream_error" });
      expect(agentCalls).toHaveLength(0);
    });

    // T-13.4 (AR fix-pack BLQ-MED-1) — el 422 colapsa CUATRO motivos, y uno es "no pude preguntar".
    //
    // 🔴 QUÉ MIDE, con el input concreto. `mapErrorStatus` traduce todo 422 a `no_agent_match`, pero
    // el gateway manda además un `reason`. `reputation_unavailable` significa que el gateway NO PUDO
    // LEER el historial (medido en `capability-resolver.ts`), o sea que no sabe si hay agentes que
    // califiquen. El copy del 422 nuevo afirma dos cosas —"no hay ningún proveedor" y "volver a
    // intentar no cambia el resultado"— que para ese motivo son las DOS falsas, y la segunda encima
    // desaconseja lo único que puede funcionar. Antes de la HU salía por el copy genérico ("Algo
    // salió mal, intentá de nuevo"), que era vago y CIERTO: colapsarlo fue una regresión de precisión.
    //
    // Los dos casos van en el MISMO `it` y se comparan entre sí a propósito: un test que sólo mirara
    // `reputation_unavailable` daría verde aunque los cuatro motivos salieran iguales.
    //
    // CD-17: mismo `setGatewayEnv()` y mismo `getVerdictStoreMock` del `beforeEach` que T-13.1.
    it("T-13.4/AR: `reputation_unavailable` NO se dice como 'no hay proveedor' (sale por el 502 de caída)", async () => {
      setGatewayEnv();
      vi.spyOn(console, "warn").mockImplementation(() => {});

      // (a) el gateway SÍ evaluó y no hay nadie.
      gwRouter({ status: 422, body: { code: "no_agent_match", reason: "no_candidates", step: 0 } });
      const resNadie = await POST(req(bodyOf()));
      const jsonNadie = (await resNadie.json()) as Record<string, unknown>;

      // (b) el gateway NO PUDO evaluar: mismo status, mismo `code`, otro `reason`.
      const noSabe = gwRouter({
        status: 422,
        body: { code: "no_agent_match", reason: "reputation_unavailable", step: 0 },
      });
      const resNoSabe = await POST(req(bodyOf()));
      const jsonNoSabe = (await resNoSabe.json()) as Record<string, unknown>;

      expect(resNadie.status).toBe(422);
      expect(jsonNadie).toEqual({ error: "prepare_no_agent_for_capability" });
      expect(resNoSabe.status).toBe(502);
      expect(jsonNoSabe).toEqual({ error: "prepare_upstream_error" });
      expect(resNadie.status).not.toBe(resNoSabe.status);

      // Y un 422 SIN `reason` tampoco habilita la afirmación fuerte: no saber por qué no es lo mismo
      // que saber que no hay nadie (fail-closed hacia el copy vago y cierto).
      gwRouter({ status: 422, body: { code: "no_agent_match", step: 0 } });
      const resMudo = await POST(req(bodyOf()));
      expect(resMudo.status).toBe(502);

      // CD-5/CD-8 intactos: el `reason` se usó para DECIDIR y no se ecoó. Una sola clave, y no dice
      // "reputation".
      expect(Object.keys(jsonNoSabe)).toEqual(["error"]);
      expect(JSON.stringify(jsonNoSabe)).not.toContain("reputation");
      expect(noSabe.agentCalls).toHaveLength(0);
    });

    it("T-A3.6: flag encendido + envs del gateway ausentes ⇒ 501 prepare_not_configured y CERO fetch", async () => {
      vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gateway");
      vi.stubEnv("WASIAI_A2A_GATEWAY_URL", "");
      vi.stubEnv("WASIAI_A2A_AGENT_KEY", "");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      gwRouter();
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: "prepare_not_configured" });
      expect(fetchMock).not.toHaveBeenCalled(); // ni un intento: not_configured se resuelve sin red
    });

    // T-A5.1 / T-A5.3 (mitad P). Los dos asserts del piso son intencionales: el segundo mata un piso
    // en cero, que existe pero no filtra nada. Y el par se compara contra las MISMAS constantes que
    // usa submit ⇒ si un leg diverge del otro, este test se cae (CD-11).
    it("T-A5.1/T-A5.3: el step lleva la capacidad de payout y constraints.min_reputation = PAYOUT_MIN_REPUTATION (> 0)", async () => {
      setGatewayEnv();
      vi.stubEnv("WASIAI_A2A_PAYOUT_CAPABILITY", undefined); // ausencia real ⇒ default del código
      let composeInit: RequestInit | undefined;
      gwRouter({ captureCompose: (init) => (composeInit = init) });
      const res = await POST(req(bodyOf()));
      const sent = JSON.parse(composeInit!.body as string);
      // VA PRIMERO, antes del status: si alguien fusiona los legs en una sola llamada, el 200 se cae
      // por otro motivo (largo de outputs ≠ al pedido ⇒ 502) y el que rompió la decisión ve seis
      // tests hablando del piso y de la atestación, ninguno nombrándole lo que acaba de tocar.
      expect(
        sent.steps,
        "1 step por llamada: fusionar cotización+desembolso necesita WKH-305 + decisión de producto sobre re-cotizar (§11)",
      ).toHaveLength(1);
      expect(res.status).toBe(200);
      const step = sent.steps[0];
      expect(step.capability).toBe(PAYOUT_CAPABILITY);
      expect(step.capability).toBe("remittance-payout"); // el valor REAL del catálogo (M8)
      expect(step.constraints).toEqual({ min_reputation: PAYOUT_MIN_REPUTATION });
      expect(PAYOUT_MIN_REPUTATION).toBeGreaterThan(0);
      // WKH-313: el CARRIL DE ESTRENO no se enciende acá, y es una decision, no un olvido: un
      // agente nuevo que cotiza mal produce una cotizacion mala (se ve antes de firmar nada); un
      // agente nuevo en payout decide A DONDE VA LA PLATA. El toEqual de arriba ya lo cubre, pero
      // el assert nombrado es lo que hace que quien copie la linea del leg de FX lea POR QUE no va.
      expect(step.constraints).not.toHaveProperty("allow_trial");
      expect(composeInit!.body as string).not.toContain("allow_trial");
      expect(step).not.toHaveProperty("agent"); // M5: nunca el nombre del agente
      // El input viaja TAL CUAL (el agente strippea con Zod lo que no conoce).
      expect(step.input.idempotencyKey).toBe("rem-1:q-400");
      expect(step.input.quoteId).toBe("q-400");
      // (Acá vivían dos asserts de que el body no contuviera `inputFromPrevious`/`passOutput`. No
      // protegían nada: runViaGateway re-serializa el step con un whitelist de tres claves, así que
      // ningún caller podía ponerlos rojos. La propiedad real —el whitelist— se testea donde vive,
      // en gateway-client.test.ts, y el campo además lo bloquea el tipo GatewayStep en compilación.)
    });

    // T-A5.2 — capas INDEPENDIENTES. El piso no es un control de seguridad: no verifica que la
    // dirección sea del agente ni que sea válida. Con el piso puesto, PR8 rechaza exactamente igual
    // que sin él, y si mañana el piso se sube, se baja o se saca, esto no cambia.
    // ⚠️ ESTE TEST COMPARABA DOS TRANSPORTES Y AHORA HAY UNO (WKH-332/W3). La mitad (a) stubeaba el
    // flag en "" y ejercitaba el carril punto a punto; ese carril se borró, así que la comparación
    // quedaría comparando el gateway contra sí mismo — un guard que se compara consigo mismo aplaude
    // cualquier cosa. Lo que SÍ sigue siendo falsable es la propiedad de fondo: con el piso viajando
    // en el step, PR8 rechaza igual. El input que lo pone en rojo: mover el guard del depositAddress
    // adentro de un `if` que dependa de las constraints.
    it("T-A5.2: el piso NO reemplaza a PR8 — un depositAddress inválido corta con 502 igual, con el piso puesto", async () => {
      setGatewayEnv();
      let composeInit: RequestInit | undefined;
      gwRouter({
        output: agentResult({ depositAddress: "0xNOT_AN_ADDRESS" }),
        captureCompose: (init) => (composeInit = init),
      });
      const res = await POST(req(bodyOf()));
      const json = await res.json();
      // El piso VIAJÓ (si no, este test probaría que PR8 corta sin piso, que es otra cosa).
      expect(JSON.parse(composeInit!.body as string).steps[0].constraints).toEqual({
        min_reputation: PAYOUT_MIN_REPUTATION,
      });
      expect(res.status).toBe(502);
      expect(json).toEqual({ error: "prepare_no_deposit_address" });
    });

    // T-A5.2b — espejo del anterior con el SHAPE roto en vez de la dirección rota. isValidPayoutResult
    // es lo único que exige `status ∈ {submitted,settled,failed,blocked}`, y después de PR8 nadie
    // vuelve a mirar `status`. El gate corre para las DOS ramas de transporte; sin este test se podía
    // desactivarlo sólo en la de gateway y la suite entera quedaba verde — justo en el transporte
    // donde el que responde ya no es una URL fija sino el agente que eligió el gateway.
    // ⚠️ MISMA REESCRITURA QUE T-A5.2: la mitad "flag apagado" ejercitaba el carril borrado. Lo que
    // sobrevive es la propiedad, que es la que importa en el transporte donde el que responde ya no
    // es una URL fija sino el agente que eligió el gateway: `isValidPayoutResult` es lo ÚNICO que
    // exige `status ∈ {submitted,settled,failed,blocked}`, y después de PR8 nadie vuelve a mirarlo.
    it("T-A5.2b: shape inválido del result ⇒ 502 prepare_upstream_error, y NUNCA atesta", async () => {
      setGatewayEnv();
      gwRouter({ output: agentResult({ status: "weird" }) });
      const res = await POST(req(bodyOf()));
      const json = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(502);
      expect(json).toEqual({ error: "prepare_upstream_error" });
      expect(json).not.toHaveProperty("attestation");
    });

    // T-1.2 (WKH-332/AC-1) — 🔴 ESTE TEST SE INVIRTIÓ, Y LA INVERSIÓN ES EL PUNTO.
    //
    // Era T-A4.1: `it.each(["fallback","a2a",undefined])` asertando que con el flag ≠ "a2a-gateway"
    // el gateway se IGNORA y se hace el fetch al agente por su slug (`expect(agentCalls).toEqual(
    // [AGENT_URL])`). O sea: clavaba que el segundo transporte fuera alcanzable por una env. Eso es
    // exactamente lo que esta HU borró, así que portar el test habría sido conservar el invariante
    // viejo con nombre nuevo. Ahora asserta lo contrario, y para los mismos valores del flag: NINGUNO
    // produce un fetch a `/api/agents/`.
    //
    // ⚠️ `"a2a"` sale de la lista y no por olvido: post-W3 la app no arranca con ese valor
    // (`createContainer()` tira), y esta ruta ya no lee la bandera. Su caso vive donde importa,
    // en `src/composition/value-delivery-adapter.test.ts` y `src/composition/container.test.ts`.
    it.each(["a2a-gateway", "fallback", undefined])(
      "T-1.2: con la bandera en %s el prepare NO hace NINGÚN fetch a /api/agents/",
      async (flag) => {
        if (flag === undefined)
          vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", undefined as unknown as string);
        else vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", flag);
        const { agentCalls } = gwRouter();
        const res = await POST(req(bodyOf()));
        expect(res.status).toBe(200);
        const urls = fetchMock.mock.calls.map((c) => c[0] as string);
        expect(urls).toEqual([`${GW}/compose`]);
        expect(agentCalls).toHaveLength(0);
        expect(urls.some((u) => u.includes("/api/agents/"))).toBe(false);
      },
    );

    // T-A6.1 (mitad P) — CD-7: mientras WKH-233 no esté DONE no se compone ningún step de identidad.
    it("T-A6.1: el /compose lleva EXACTAMENTE 1 step y su body no menciona identidad/KYC", async () => {
      setGatewayEnv();
      let composeInit: RequestInit | undefined;
      gwRouter({ captureCompose: (init) => (composeInit = init) });
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(200);
      const sent = JSON.parse(composeInit!.body as string);
      expect(sent.steps).toHaveLength(1);
      expect(sent.steps[0].capability).toBe(PAYOUT_CAPABILITY);
      const rawBody = composeInit!.body as string;
      expect(rawBody).not.toContain("kyc-verification");
      expect(rawBody).not.toContain("identity");
    });

    // ── CANDADO: el leg de payout NUNCA pide el carril de estreno ─────────────────────────────
    //
    // Hasta acá lo único que sostenía esta decisión era un comentario en la route (route.ts:396,
    // "CD-5: NUNCA omitir") y dos asserts colgados del happy path (T-A5.1, arriba). Eso alcanza
    // contra un descuido y NO alcanza contra el escenario que de verdad va a pasar, que está medido
    // y es este: el día que se encienda `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=a2a-gateway`, el agente
    // de payout del catálogo no llega al piso (hoy no tiene ninguna task liquidada ⇒ cuenta 0) y el
    // gateway contesta 422 no_agent_match. El leg muere fail-closed, que es lo correcto, y el
    // arreglo tentador es de una línea: copiar `allow_trial: true` del leg de FX. Ese es
    // exactamente el cambio que abre el agujero, y el 422 no lo hace ver más chico.
    //
    // Por eso los tres casos de abajo miran cosas distintas: el happy path (que ya estaba, con la
    // grafía camelCase cubierta), EL 422 (que no lo miraba nadie: un retry-con-carril tras el
    // rechazo dejaba la suite entera verde) y la asimetría contra FX en la MISMA corrida, para que
    // "unificar los dos legs" tampoco sea un cambio silencioso.
    describe("candado del carril de estreno (allow_trial) en el leg del PRINCIPAL", () => {
      const POR_QUE =
        "el leg de payout NO puede pedir el carril de estreno: el agente que gana ESTE step elige " +
        "la dirección A DONDE VA EL PRINCIPAL de la persona, y el carril admite justamente a quien " +
        "no tiene ninguna task liquidada. En el leg de FX sí va, a propósito: una cotización mala se " +
        "ve antes de que se firme nada, un desembolso mal dirigido no vuelve. Si llegaste hasta acá " +
        "por un 422 no_agent_match, ese 422 se arregla del lado del catálogo (que el agente de " +
        "payout acumule historial liquidado, o corregir su standing degradado), NO agregando la clave.";

      /** Cualquier grafía de la clave del carril: allow_trial / allowTrial / allow-trial. */
      const TRIAL_KEY = /^allow[_-]?trial$/i;

      /** Rutas de TODAS las claves del carril dentro de un valor, a cualquier profundidad. */
      function trialKeyPaths(value: unknown, path = "$"): string[] {
        if (Array.isArray(value)) return value.flatMap((v, i) => trialKeyPaths(v, `${path}[${i}]`));
        if (typeof value === "object" && value !== null) {
          return Object.entries(value).flatMap(([k, v]) =>
            TRIAL_KEY.test(k) ? [`${path}.${k}`] : trialKeyPaths(v, `${path}.${k}`),
          );
        }
        return [];
      }

      /** Escanea el body de /compose SALVO el `input` de cada step. El `input` es el body del caller
       *  TAL CUAL (route.ts:397): una clave con ese nombre ahí la puso quien llamó, no este leg, y el
       *  gateway sólo lee el carril dentro de `constraints`. Todo lo demás del body SÍ se escanea,
       *  así que la clave no se salva escondiéndola a nivel step ni a nivel raíz. */
      function trialKeysSentTo(rawBody: string): string[] {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
        return trialKeyPaths({
          ...parsed,
          steps: steps.map((s) =>
            typeof s === "object" && s !== null && !Array.isArray(s)
              ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== "input"))
              : s,
          ),
        });
      }

      /** Captura el body de CADA /compose (no sólo el último): un retry manda dos. */
      function captureComposeBodies(opts: Parameters<typeof gwRouter>[0] = {}) {
        const bodies: string[] = [];
        gwRouter({ ...opts, captureCompose: (init) => bodies.push(init?.body as string) });
        return bodies;
      }

      /** El body del /compose nº `i`. Tira si no hubo tantas llamadas: un candado que inspecciona
       *  un body inexistente pasaría por las razones equivocadas. */
      function composeBody(bodies: string[], i: number): string {
        const raw = bodies[i];
        if (typeof raw !== "string") throw new Error(`no hubo un /compose #${i + 1} que inspeccionar`);
        return raw;
      }

      it("prepare feliz ⇒ el /compose del payout no lleva el carril en NINGUNA grafía", async () => {
        setGatewayEnv();
        const bodies = captureComposeBodies();
        const res = await POST(req(bodyOf()));
        expect(res.status).toBe(200);
        expect(bodies).toHaveLength(1);
        expect(trialKeysSentTo(composeBody(bodies, 0)), POR_QUE).toEqual([]);
      });

      // EL caso nuevo. Un `if (r.code === "no_agent_match") reintentar con allow_trial` deja verde
      // todo lo demás: T-A3.4 sólo mira que el 502 salga y que no se llame al agente directo (las
      // dos cosas siguen siendo ciertas con el retry puesto), y T-A5.1 nunca ve un 422.
      it("el gateway contesta 422 no_agent_match ⇒ NINGÚN /compose lleva el carril (ni un reintento)", async () => {
        setGatewayEnv();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const bodies = captureComposeBodies({
          status: 422,
          body: { error: "no candidates", code: "no_agent_match", reason: "no_candidates", step: 0 },
        });
        const res = await POST(req(bodyOf()));
        // WKH-332/AC-13 — el veredicto de ESTE assert cambió (era 502 `prepare_upstream_error`): el
        // 422 ahora sale con enum propio, porque "no hay quién" no se arregla reintentando y decirlo
        // con las palabras de una caída invitaba justamente a eso. Lo que este `it` custodia NO
        // cambió y es lo de abajo: el leg NO se destraba solo agregando el carril de estreno.
        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({ error: "prepare_no_agent_for_capability" });
        expect(bodies.length).toBeGreaterThan(0); // hubo /compose: el escaneo de abajo mira algo real
        for (const [i, raw] of bodies.entries()) {
          expect(trialKeysSentTo(raw), `${POR_QUE} (intento #${i + 1} del /compose)`).toEqual([]);
        }
      });

      // La asimetría, afirmada en UNA corrida: no es "el carril está prohibido", es "el carril va en
      // el leg que cotiza y no en el que desembolsa". Sin la mitad de FX, el candado se podría
      // satisfacer apagando el carril en los dos lados, que no es la decisión que se tomó.
      it("misma corrida: FX SÍ pide el carril y payout NO", async () => {
        setGatewayEnv();
        vi.stubEnv("WASIAI_A2A_FX_CAPABILITY", undefined);
        vi.stubEnv("WASIAI_A2A_PAYOUT_CAPABILITY", undefined);
        const fxResult = {
          quoteId: "q-lock-1",
          rate: 3.7,
          feeUsd: 0.5,
          netDeliveredLocal: 1478.15,
          etaMinutes: 30,
          expiresAt: "2026-07-09T18:10:00.000Z",
          provenance: "remit-corridor-fx",
        };
        // (a) payout
        const payoutBodies = captureComposeBodies();
        expect((await POST(req(bodyOf()))).status).toBe(200);
        // (b) FX, con el MISMO fetch mockeado
        const fxBodies = captureComposeBodies({ output: fxResult });
        const fxRes = await QUOTE_POST(
          new Request("http://localhost/api/a2a/quote", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" }),
          }),
        );
        expect(fxRes.status).toBe(200);

        expect(payoutBodies).toHaveLength(1);
        expect(fxBodies).toHaveLength(1);
        const payoutStep = JSON.parse(composeBody(payoutBodies, 0)).steps[0];
        const fxStep = JSON.parse(composeBody(fxBodies, 0)).steps[0];
        expect(payoutStep.capability).toBe(PAYOUT_CAPABILITY);
        expect(payoutStep.constraints, POR_QUE).toEqual({ min_reputation: PAYOUT_MIN_REPUTATION });
        // Y el otro lado de la misma decisión: el carril de FX sigue encendido, con su piso al lado
        // (sin `min_reputation` el gateway ni siquiera lee `allow_trial` — ver FX_MIN_REPUTATION).
        expect(
          fxStep.constraints,
          "el leg de FX SÍ pide el carril de estreno a propósito: si esto se puso rojo, el candado del payout no es la causa y apagar el carril de FX no es el arreglo",
        ).toEqual({ min_reputation: FX_MIN_REPUTATION, allow_trial: true });
      });
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-333 — el backend deja de aceptar el identificador de la verificación (AC-16, AC-17, AC-18)
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// ⚠️ CÓMO SE MIDE "una llamada a Didit" en este archivo: `resolvePayoutAuthority` está mockeada, y es
// el ÚNICO punto de esta ruta que le habla al proveedor de identidad (su implementación real hace el
// `GET /v3/session/{id}/decision/`). Contar sus invocaciones es contar las consultas a Didit que esta
// ruta produce. NO se cuentan peticiones HTTP reales: eso NO SE PUDO VERIFICAR desde un test.
describe("POST /api/payout/prepare — el identificador sale de la fila, no del cliente (WKH-333)", () => {
  const OTHER_KP = nacl.sign.keyPair();
  const OTHER_ADDR = bs58.encode(OTHER_KP.publicKey);

  // `honestVerdictStore` vive a nivel de módulo (arriba): lo comparten los dos `describe`.

  // ⚠️ ESTE `beforeEach` REPLICA el del describe de arriba a propósito: este bloque es hermano, no
  // anidado, así que no hereda nada. Sin esto, `issueSolanaPopChallenge` tira "PAYOUT_POP_SECRET
  // missing" al armar el body y los 11 casos fallan por el andamiaje, no por lo que miden.
  /** El input con el que se consultó la autoridad en la llamada `n`. Concentra el acceso porque el
   *  `!` es la única forma que TypeScript acepta (un `?.` encadenado dispara
   *  `noUnsafeOptionalChaining`, que en este repo es ERROR de lint). */
  function authorityInput(n = 0): { verificationId: string; address: string } {
    const call = authorityMock.mock.calls[n];
    if (!call) throw new Error("no se consultó a la autoridad");
    return call[0] as { verificationId: string; address: string };
  }

  beforeEach(() => {
    KP = nacl.sign.keyPair();
    ADDR = bs58.encode(KP.publicKey);
    AUTHORITY = bs58.encode(nacl.sign.keyPair().publicKey);
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "test-deposit-secret");
    vi.stubEnv("SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY", AUTHORITY);
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("PAYOUT_POP_SECRET", "pop-secret");
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", GW); // W3: un solo transporte, y hay que configurarlo
    vi.stubEnv("WASIAI_A2A_AGENT_KEY", GW_KEY);
    checkRouteRateLimitMock.mockReset();
    checkRouteRateLimitMock.mockResolvedValue({ ok: true });
    authorityMock.mockReset();
    authorityMock.mockResolvedValue({ authorized: true, httpStatus: 200 });
    ledgerMock.recordOrderPrepared.mockReset();
    ledgerMock.recordOrderPrepared.mockResolvedValue(undefined);
    getLedgerMock.mockReset();
    getLedgerMock.mockReturnValue(null);
    getVerdictStoreMock.mockReset();
    getVerdictStoreMock.mockReturnValue(storeConFilaDe(ADDR)); // ver la nota del `vi.mock`
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    agentResponds(200, agentResult());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ── T-PR-2 — AC-18 / M-25 ──────────────────────────────────────────────────────────────────────
  it("T-PR-2: sin PAYOUT_POP_SECRET ⇒ 503, y NO se consulta a la autoridad de KYC", async () => {
    // El challenge se EMITE con secreto (el emisor lo necesita) y se PRESENTA sin él, igual que el
    // exemplar de remittance-ids: lo que se prueba es el guard de la ruta, no el del emisor.
    const body = bodyOf();
    vi.stubEnv("PAYOUT_POP_SECRET", "");
    const res = await POST(req(body));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "payout_pop_unavailable" });
    expect(
      authorityMock,
      "un deployment que NO PUEDE verificar posesión igual gastó una consulta al proveedor de " +
        "identidad: eso es cupo nuestro que cualquiera drena con un `curl`",
    ).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── T-PR-3 — AC-18 ────────────────────────────────────────────────────────────────────────────
  it("T-PR-3: sin PoP ⇒ 403 payout_pop_unverified, y CERO consultas a la autoridad", async () => {
    const { popChallenge, popSignature, ...noPop } = bodyOf();
    void popChallenge;
    void popSignature;
    const res = await POST(req(noPop));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_pop_unverified" });
    expect(authorityMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── T-PR-4 — 🔴 EL ORÁCULO QUE SE CIERRA (§0.4) ───────────────────────────────────────────────
  it("T-PR-4: un id INVENTADO y uno REAL, los dos sin PoP ⇒ respuestas IDÉNTICAS byte a byte y CERO consultas a Didit", async () => {
    // Antes de WKH-333, este mismo par de requests era distinguible y cada uno provocaba un fetch a
    // Didit: un id que existía y no autorizaba volvía 403 `payout_not_authorized`, y uno inventado
    // volvía 502 `payout_authority_unavailable` (la autoridad no lo reconocía). O sea que esta ruta
    // le contestaba a CUALQUIERA si un identificador de verificación existe o no, detrás de nada más
    // que el rate-limit por IP, y encima nos gastaba cupo del proveedor en cada intento.
    //
    // El aserto es la INDISTINGUIBILIDAD, comparada entre las dos respuestas y no contra un literal:
    // si mañana el enum cambia, este test sigue midiendo lo que importa.
    getVerdictStoreMock.mockReturnValue(
      honestVerdictStore([{ senderAddress: ADDR, verificationId: "did-REAL-de-esta-address" }]),
    );
    // Así respondía la autoridad ante un id inexistente: el 502 era el que delataba.
    authorityMock.mockResolvedValue({ authorized: false, reason: undefined, httpStatus: 502 });

    const { popChallenge, popSignature, ...anon } = bodyOf();
    void popChallenge;
    void popSignature;

    const inventado = await POST(req({ ...anon, kycVerificationId: "did-QUE-NO-EXISTE-EN-NINGUN-LADO" }));
    const bodyInventado = await inventado.text();
    const real = await POST(req({ ...anon, kycVerificationId: "did-REAL-de-esta-address" }));
    const bodyReal = await real.text();

    expect(
      { status: real.status, body: bodyReal },
      "las dos respuestas se distinguen: esta ruta vuelve a ser un oráculo que le dice a cualquier " +
        "anónimo si un identificador de verificación de identidad existe y en qué estado está",
    ).toEqual({ status: inventado.status, body: bodyInventado });

    expect(
      authorityMock.mock.calls.length,
      "un caller anónimo provocó una consulta al proveedor de identidad: además del oráculo, es " +
        "cupo del tier gratuito que se drena con un bucle de `curl`",
    ).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled(); // ni una orden de payout creada
  });

  // ── T-PR-6 — CD-18 / M-26 ─────────────────────────────────────────────────────────────────────
  it("T-PR-6: PoP de A presentado con `address` de B ⇒ 403, sin autoridad y sin leer la fila", async () => {
    const store = honestVerdictStore([
      { senderAddress: ADDR, verificationId: "did-de-A" },
      { senderAddress: OTHER_ADDR, verificationId: "did-de-B" },
    ]);
    getVerdictStoreMock.mockReturnValue(store);
    // El PoP lo firma A (bodyOf lo arma con KP/ADDR) y el body declara la address de B.
    const res = await POST(req({ ...bodyOf(), address: OTHER_ADDR }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_pop_unverified" });
    expect(
      store.get,
      "se leyó el veredicto de una dirección que el caller no probó poseer: eso es el IDOR que la " +
        "prueba de posesión existe para cerrar",
    ).not.toHaveBeenCalled();
    expect(authorityMock).not.toHaveBeenCalled();
  });

  // ── T-PR-7 — AC-16 ────────────────────────────────────────────────────────────────────────────
  it("T-PR-7: con PoP y fila, la autoridad recibe el identificador DE LA FILA", async () => {
    getVerdictStoreMock.mockReturnValue(
      honestVerdictStore([{ senderAddress: ADDR, verificationId: "did-de-la-fila" }]),
    );
    const res = await POST(req(bodyOf()));
    expect(res.status).toBe(200);
    expect(authorityMock).toHaveBeenCalledWith({
      verificationId: "did-de-la-fila",
      address: ADDR,
    });
  });

  // ── T-PR-8 — AC-16 / M-27, M-28 ───────────────────────────────────────────────────────────────
  it("T-PR-8: el `kycVerificationId` del body se IGNORA — aunque sea el de otra persona (M-27, M-28)", async () => {
    getVerdictStoreMock.mockReturnValue(
      honestVerdictStore([
        { senderAddress: ADDR, verificationId: "did-de-A" },
        { senderAddress: OTHER_ADDR, verificationId: "did-de-B" },
      ]),
    );
    // A firma el PoP y manda en el body el identificador de B. Si la ruta lo usara, A pagaría bajo la
    // verificación de identidad de B.
    const res = await POST(req(bodyOf({ kycVerificationId: "did-de-B" })));
    expect(res.status).toBe(200);
    const call = authorityInput();
    expect(
      call.verificationId,
      "la autoridad recibió el identificador que vino en el body: quien tenga el de otra persona " +
        "—de un log, de la red, de un navegador ajeno— puede cobrar bajo la verificación de esa persona",
    ).toBe("did-de-A");
    expect(call.address).toBe(ADDR);

    // Y mandarlo VACÍO, o no mandarlo, da exactamente lo mismo: el valor del cliente no participa.
    authorityMock.mockClear();
    await POST(req(bodyOf({ kycVerificationId: "" })));
    expect(authorityInput().verificationId).toBe("did-de-A");
    authorityMock.mockClear();
    const { kycVerificationId, ...sinCampo } = bodyOf();
    void kycVerificationId;
    await POST(req(sinCampo));
    expect(authorityInput().verificationId).toBe("did-de-A");
  });

  // ── T-PR-9 — AC-17 / M-28, M-31 ───────────────────────────────────────────────────────────────
  it("T-PR-9: con PoP y SIN fila ⇒ 403 prepare_kyc_verdict_missing, sin forward, sin atestación, sin ledger", async () => {
    getVerdictStoreMock.mockReturnValue(honestVerdictStore([])); // la dirección no tiene fila
    getLedgerMock.mockReturnValue(ledgerMock);
    const res = await POST(req(bodyOf()));
    expect(
      res.status,
      "sin fila utilizable la ruta siguió adelante: o creó una orden de payout con un identificador " +
        "que no verificó nadie, o cayó a un camino de respaldo con el valor del cliente",
    ).toBe(403);
    expect(await res.json()).toEqual({ error: "prepare_kyc_verdict_missing" });
    expect(authorityMock).not.toHaveBeenCalled();
    expect(fetchMock, "se creó una orden de payout REAL sin veredicto").not.toHaveBeenCalled();
    expect(ledgerMock.recordOrderPrepared).not.toHaveBeenCalled();
  });

  it("T-PR-9b: si la lectura de la fila FALLA ⇒ 503, y NO se confunde con 'no estás verificado'", async () => {
    // "No pude preguntar" no es "no hay". Mandar a re-verificarse a alguien porque nuestra base se
    // cayó es un consejo equivocado, y el copy de flow-vm.ts los distingue por eso.
    getVerdictStoreMock.mockReturnValue({
      get: vi.fn(async () => {
        throw new Error("kyc_verdict_read_failed:42P01");
      }),
      put: vi.fn(),
    });
    const res = await POST(req(bodyOf()));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "prepare_kyc_verdict_unavailable" });
    expect(text, "se ecoó el SQLSTATE de Postgres al cliente").not.toContain("42P01");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── T-PR-10 — CD-5 / M-29 ─────────────────────────────────────────────────────────────────────
  it("T-PR-10: con DOS dueños en el store, el identificador que llega a la autoridad es el del caller", async () => {
    const store = honestVerdictStore([
      { senderAddress: OTHER_ADDR, verificationId: "did-de-B" },
      { senderAddress: ADDR, verificationId: "did-de-A" },
    ]);
    getVerdictStoreMock.mockReturnValue(store);
    await POST(req(bodyOf()));
    // El VALOR con el que se consultó la base, no sólo que se consultó.
    expect(store.get).toHaveBeenCalledWith(ADDR);
    expect(
      authorityInput().verificationId,
      "el filtro por dueño no aisló nada: la ruta autorizó con la verificación de identidad de otra " +
        "billetera",
    ).toBe("did-de-A");
  });

  // ── T-PR-11 — AC-16 / M-30 ────────────────────────────────────────────────────────────────────
  // ⚠️ EL TÍTULO DECÍA "en LAS DOS ramas de transporte" Y AHORA HAY UNA (WKH-332/W3). La mitad
  // punto-a-punto se borró junto con el `else` de la route. Lo que M-30 vigilaba —que una futura
  // división en dos sitios de saneo no pudiera regresar en silencio— ya no puede ocurrir por
  // construcción: `forwardBody` se arma UNA vez y hay un solo consumidor. La propiedad que queda es
  // la que importa y sigue siendo falsable: lo que sale al gateway lleva el id DE LA FILA, y el que
  // propuso el cliente no aparece en ninguna parte del body.
  it("T-PR-11: el payload forwardeado al gateway lleva el id DE LA FILA, no el que propuso el cliente", async () => {
    getVerdictStoreMock.mockReturnValue(
      honestVerdictStore([{ senderAddress: ADDR, verificationId: "did-de-la-fila" }]),
    );
    let composeBody = "";
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/compose")) composeBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ success: true, steps: [{ output: agentResult() }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const gwRes = await POST(req(bodyOf({ kycVerificationId: "did-QUE-EL-CLIENTE-PROPUSO" })));
    expect(gwRes.status, "la rama del gateway no llegó a forwardear").toBe(200);
    expect(composeBody, "no se capturó el /compose del gateway").not.toBe("");
    expect(
      composeBody,
      "la rama del gateway le reenvió al agente el identificador que propuso el cliente",
    ).toContain("did-de-la-fila");
    expect(composeBody).not.toContain("did-QUE-EL-CLIENTE-PROPUSO");
  });

  // ── T-PR-12 — AC-12 / §8.5.i · 🔴 REESCRITO POR AR/BLQ-ALTO-1 ─────────────────────────────────
  //
  // ⚠️ ESTE TEST AFIRMABA LO CONTRARIO, Y ERA UN MOCK QUE MENTÍA. Decía "con el flag APAGADO la ruta
  // conserva su comportamiento actual (nadie se queda sin pagar)" y esperaba **200**. Pasaba en verde
  // sólo porque este archivo mockea el módulo entero de la autoridad (`:15-18`) con
  // `{authorized:true}`: con la autoridad REAL, el `""` que la ruta le pasaba sin store caía en su
  // guard de formato y devolvía 400 a TODO pagador legítimo. O sea que el test existía justamente
  // para custodiar "nadie se queda sin pagar" y custodiaba la afirmación equivocada.
  //
  // No se borra: se corrige y se le pone al lado la razón. El candado con la dependencia REAL vive en
  // `route.flag-off.test.ts`, que no mockea la autoridad — sin eso, esta decisión no tendría candado.
  it("T-PR-12: con el flag APAGADO la ruta CORTA con 503 y no crea ninguna orden (AR/BLQ-ALTO-1)", async () => {
    getVerdictStoreMock.mockReturnValue(null); // KYC_VERDICT_STORE_ENABLED ausente
    const res = await POST(req(bodyOf()));
    expect(
      res.status,
      "sin store, la ruta siguió adelante: o consultó a la autoridad con un identificador que no " +
        "salió de ninguna fila, o cayó a un camino de respaldo con el valor del cliente (CD-26)",
    ).toBe(503);
    expect(await res.json()).toEqual({ error: "prepare_kyc_verdict_unavailable" });
    // 400 sería mentirle al que llama: su pedido está bien, lo que falta es configuración nuestra.
    expect(res.status).not.toBe(400);
    expect(
      authorityMock,
      "se gastó una consulta al proveedor de identidad con un identificador vacío",
    ).not.toHaveBeenCalled();
    expect(fetchMock, "se creó una orden de payout REAL sin veredicto").not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-TOK-3c / T-TOK-4c · AR/MNR-5 — LA TERCERA PATA DEL BARRIDO DE CD-20, QUE FALTABA
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ FALTABA, MEDIDO. El Story File declara que el barrido del centinela corre sobre TRES rutas
// —`kyc/session`, `kyc/decision` y ESTA— y la Done Definition lo daba por cumplido. Las dos primeras
// lo tienen; acá había **cero ocurrencias de `CENTINELA`**. No había fuga viva: faltaba el candado.
//
// 🔴 POR DÓNDE PODRÍA ENTRAR EL TOKEN A ESTA RUTA, que es lo que hace que este `it` no sea decorativo.
// `prepare` nunca ve el `decisionToken` directamente: su único contacto con esa credencial es a través
// del objeto que devuelve `resolvePayoutAuthority`, que HOY trae `provenance` y `riskLevel` —dos
// campos que la ruta NO ecoa: el `provenance` del 200 sale del resultado del AGENTE DE PAYOUT, no de
// la autoridad—. El mutante realista es que alguien haga `NextResponse.json({ ...d, … })` para "no
// perder información", o que un día `PayoutAuthorityDecision` gane un campo con la credencial adentro.
// Por eso el doble de la autoridad devuelve el centinela EN SUS PROPIOS CAMPOS: es el único canal por
// el que la credencial podría llegar hasta acá.
describe("POST /api/payout/prepare — T-TOK-3c/T-TOK-4c: nada de la autoridad se ecoa (CD-20)", () => {
  const TOKEN_CENTINELA = "k1.CENTINELA-QUE-NO-DEBE-SALIR"; // el MISMO literal que las otras dos rutas

  // ⚠️ Replica el `beforeEach` del primer describe a propósito: este bloque es hermano, no anidado.
  beforeEach(() => {
    KP = nacl.sign.keyPair();
    ADDR = bs58.encode(KP.publicKey);
    AUTHORITY = bs58.encode(nacl.sign.keyPair().publicKey);
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "test-deposit-secret");
    vi.stubEnv("SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY", AUTHORITY);
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("PAYOUT_POP_SECRET", "pop-secret");
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", GW);
    vi.stubEnv("WASIAI_A2A_AGENT_KEY", GW_KEY);
    checkRouteRateLimitMock.mockReset();
    checkRouteRateLimitMock.mockResolvedValue({ ok: true });
    authorityMock.mockReset();
    // 🔴 EL CENTINELA VIAJA EN LOS CAMPOS DE LA AUTORIDAD. `provenance`/`riskLevel` son los dos campos
    // aditivos que ESA función ya devuelve; `decisionToken` es el campo que no debería existir nunca
    // ahí, y está puesto justamente para que el barrido lo cace el día que alguien lo agregue.
    authorityMock.mockResolvedValue({
      authorized: true,
      httpStatus: 200,
      provenance: TOKEN_CENTINELA,
      riskLevel: TOKEN_CENTINELA,
      decisionToken: TOKEN_CENTINELA,
    });
    ledgerMock.recordOrderPrepared.mockReset();
    ledgerMock.recordOrderPrepared.mockResolvedValue(undefined);
    getLedgerMock.mockReset();
    getLedgerMock.mockReturnValue(null);
    getVerdictStoreMock.mockReset();
    getVerdictStoreMock.mockReturnValue(storeConFilaDe(ADDR));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    agentResponds(200, agentResult());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("T-TOK-3c/T-TOK-4c: el centinela no aparece en el body, ni en las cabeceras, ni en `console.*`", async () => {
    const capturado: string[] = [];
    const anotar = (...a: unknown[]) => {
      capturado.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    };
    vi.spyOn(console, "warn").mockImplementation(anotar);
    vi.spyOn(console, "error").mockImplementation(anotar);
    vi.spyOn(console, "log").mockImplementation(anotar);

    const res = await POST(req(bodyOf()));

    // ✅ CONTROL POSITIVO, y va PRIMERO: sin él, cualquier corte temprano (403, 503) dejaría los tres
    // asserts de abajo verdes por vacío — que es exactamente cómo un barrido se vuelve decorativo.
    expect(res.status, "el caso no llegó al 200: el barrido de abajo sería vacuo").toBe(200);
    const cuerpo = await res.text();
    expect(JSON.parse(cuerpo)).toMatchObject({ beneficiary: DEPOSIT, payoutId: "transfi-po-1" });

    // 🧬 MUTANTE: `NextResponse.json({ ...d, beneficiary, … })` en la rama del 200 —o cualquier eco de
    // `d.provenance`— ⇒ ROJO en el primero.
    expect(cuerpo, "un campo de la autoridad se ecoó en el body del 200").not.toContain(TOKEN_CENTINELA);
    expect(
      JSON.stringify([...res.headers.entries()]),
      "un campo de la autoridad se ecoó en una cabecera",
    ).not.toContain(TOKEN_CENTINELA);
    expect(capturado.join("\n"), "un campo de la autoridad se ecoó a un log").not.toContain(
      TOKEN_CENTINELA,
    );
  });

  it("T-TOK-3c (rama de rechazo): tampoco sale por el 403 de `payout_not_authorized`", async () => {
    // El otro camino observable: la autoridad NO autoriza. El body de rechazo es un enum fijo, y este
    // caso fija que sigue siéndolo aunque la autoridad devuelva campos con contenido.
    authorityMock.mockResolvedValue({
      authorized: false,
      reason: "kyc_ownership_mismatch",
      httpStatus: 200,
      provenance: TOKEN_CENTINELA,
    });
    const res = await POST(req(bodyOf()));
    expect(res.status).toBe(403);
    const cuerpo = await res.text();
    expect(JSON.parse(cuerpo)).toEqual({ error: "payout_not_authorized" }); // control positivo
    expect(cuerpo).not.toContain(TOKEN_CENTINELA);
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(TOKEN_CENTINELA);
  });
});
