// Tests — `POST /api/payout/prepare` CON LA AUTORIDAD DE KYC REAL EN EL LAZO (AR/BLQ-ALTO-1).
//
// 🔴 POR QUÉ ESTE ARCHIVO EXISTE, Y POR QUÉ NO PODÍA SER UN `it` MÁS EN `route.test.ts`. Aquel archivo
// mockea el módulo entero de la autoridad (`vi.mock(".../payout/authority")`, `:15-18`) y su
// `beforeEach` la deja en `{authorized:true}`. Con ese mock, `T-PR-12` afirmaba en verde que "con el
// flag apagado la ruta conserva su comportamiento actual (nadie se queda sin pagar)" — y con la
// autoridad REAL eso era **400 a todo pagador legítimo**, porque el `""` que la ruta le pasaba sin
// store cae en su guard de formato (`authority.ts`, `invalid_verification_id`). Un `vi.mock` es por
// ARCHIVO: la única forma de tener la dependencia real en el lazo es un archivo sin ese mock.
//
// Acá NO se mockea `resolvePayoutAuthority`. Lo que se mockea es todo lo que NO está bajo prueba:
//   · el rate-limit (sin Upstash env el limiter real es fail-closed 503 y ningún caso llegaría);
//   · la factory del store (es EL FLAG: es la variable independiente del experimento);
//   · `fetch`, que acá sirve DOS destinos distintos y los cuenta por separado — el `GET
//     /v3/session/{id}/decision/` que hace la autoridad de verdad, y el `POST {GW}/compose` del
//     gateway (antes de WKH-332/W3 era el `POST …/invoke` del agente por su slug: ese carril se borró).
//
// La afirmación que este archivo clava, y que ningún otro test puede clavar: **con el flag apagado
// nadie puede pagar**, y **con el flag encendido y fila, un pagador legítimo paga** — las dos medidas
// contra la misma autoridad que corre en producción.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Rate-limit: mismo patrón que route.test.ts. clientIp/DEPOSIT_PREPARE_RL quedan reales.
const { checkRouteRateLimitMock } = vi.hoisted(() => ({ checkRouteRateLimitMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/infrastructure/rate-limit")>();
  return { ...actual, checkRouteRateLimit: checkRouteRateLimitMock };
});

// El FLAG. `null` = `KYC_VERDICT_STORE_ENABLED` ausente (lo que devuelve la factory real, ver
// `supabase-kyc-verdicts.ts`). Es la única cosa que cambia entre los dos casos de abajo.
// WKH-233 — el store del `decisionToken`. HONESTO (aplica el filtro por dueño de verdad, CD-19): un
// `mockResolvedValue` fijo dejaría pasar la pérdida del `.eq("owner_address", …)`, que es el IDOR.
const { getTokenStoreMock } = vi.hoisted(() => ({ getTokenStoreMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/persistence/supabase-kyc-session-tokens", () => ({
  getKycSessionTokenStore: getTokenStoreMock,
}));

const { getVerdictStoreMock } = vi.hoisted(() => ({ getVerdictStoreMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/persistence/supabase-kyc-verdicts", () => ({
  getKycVerdictStore: getVerdictStoreMock,
}));

// Ledger: null (flag OFF) — no participa de lo que se mide y su ausencia es el default productivo.
vi.mock("../../../../src/infrastructure/persistence/supabase-settlement-ledger", () => ({
  getSettlementLedger: () => null,
  CHAIN_ID_NOT_APPLICABLE: 0,
}));

import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  buildSolanaPopMessage,
  issueSolanaPopChallenge,
} from "../../../../src/infrastructure/auth/pop-challenge";
import { POST } from "./route";

const DEPOSIT = "So11111111111111111111111111111111111111112";
const beneficiary = { name: "Mamá", country: "PE", method: "yape", destination: "999888777" };
const ROW_ID = "v-DE-LA-FILA";
const BODY_ID = "v-QUE-EL-CLIENTE-PROPUSO";

let KP: nacl.SignKeyPair;
let ADDR: string;
let fetchMock: ReturnType<typeof vi.fn>;
/** URLs que salieron por `fetch`, en orden. Es lo que distingue "consultó a la autoridad" de "creó
 *  una orden real": las dos cosas pasan por el mismo `fetch` y por eso se cuentan por su URL. */
let urls: string[];

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

function bodyOf(over: Record<string, unknown> = {}) {
  return {
    remittanceId: "rem-1",
    quoteId: "q-400",
    // El caller manda un identificador igual que antes de la HU: se ignora, y acá se puede MEDIR con
    // la autoridad real porque la URL que ella fetchea lleva el id adentro.
    kycVerificationId: BODY_ID,
    address: ADDR,
    amountUsd: 400,
    beneficiary,
    idempotencyKey: "rem-1:q-400",
    ...signedSolanaPop(KP, ADDR),
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

/** Fila del veredicto, con el filtro por dueño aplicado DE VERDAD (CD-17): un `mockResolvedValue`
 *  fijo dejaría pasar la pérdida del `.eq('sender_address', …)`. */
function honestVerdictStore(rows: Array<{ senderAddress: string; verificationId: string }>) {
  return {
    get: vi.fn(async (sender: string) => {
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
    }),
    put: vi.fn(),
  };
}

describe("prepare + autoridad REAL — la semántica del flag OFF (AR/BLQ-ALTO-1)", () => {
  beforeEach(() => {
    KP = nacl.sign.keyPair();
    ADDR = bs58.encode(KP.publicKey);
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "test-deposit-secret");
    vi.stubEnv("SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY", bs58.encode(nacl.sign.keyPair().publicKey));
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("PAYOUT_POP_SECRET", "pop-secret");
    // W3: hay UN transporte y hay que configurarlo. Antes acá se stubeaba la base de los agentes y el
    // flag en "" para forzar el carril punto a punto; los dos se fueron con ese carril.
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", "https://gateway.test");
    vi.stubEnv("WASIAI_A2A_AGENT_KEY", "ak_flag_off_secret");
    // 🔴 CON host del agente: es lo que hace que la autoridad REAL tome su camino de producción
    // (consultar al agente de KYC) en vez de la rama `simulated_dev`. Sin esto el test mediría el
    // demo, no el money-path.
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
    vi.stubEnv("KYC_AGENT_INVOKE_SECRET", "invoke-secret-de-test"); // WKH-233 (fix-pack · H-3): la credencial de invoke pasó a ser OBLIGATORIA (`invokeAuthHeader` es fail-closed), así que sembrarla es PRE-REQUISITO de todo `it` que llegue al agente. Estaba en `undefined` a propósito cuando la ausencia era inocua; hoy la ausencia CORTA, y dejarla haría que estos `it` midieran el guard nuevo en vez de lo que dicen medir.
    getTokenStoreMock.mockReset();
    getTokenStoreMock.mockReturnValue({
      // El filtro por dueño, aplicado: sólo devuelve el token si el par (sesión, dirección) coincide.
      getForOwner: vi.fn(async (sessionId: string, owner: string) =>
        sessionId === ROW_ID && owner === ADDR ? "k1.token-del-agente" : null,
      ),
    });
    checkRouteRateLimitMock.mockReset();
    checkRouteRateLimitMock.mockResolvedValue({ ok: true });
    getVerdictStoreMock.mockReset();

    urls = [];
    fetchMock = vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes("/api/agents/")) {
        // El agente de KYC contestando que SÍ, con su juicio ya hecho: `payoutAllowed: true` exige,
        // por construcción, que la identidad reclamada COINCIDA — o sea el pagador legítimo.
        return new Response(
          JSON.stringify({
            terminal: true,
            status: "Approved",
            approved: true,
            riskLevel: "low",
            verificationId: ROW_ID,
            provenance: "didit",
            payoutAllowed: true,
            reasons: [],
            identityMatches: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // El gateway relayando el output del agente que resolvió la capacidad (forma de `POST /compose`).
      return new Response(
        JSON.stringify({
          success: true,
          steps: [
            {
              output: {
                status: "submitted",
                payoutId: "transfi-po-1",
                deliveredLocal: null,
                txRef: null,
                reason: null,
                provenance: "transfi",
                depositAddress: DEPOSIT,
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ── T-FLAG-1 ───────────────────────────────────────────────────────────────────────────────────
  it("T-FLAG-1: FLAG ON + fila ⇒ el pagador legítimo paga, y la autoridad recibe el id DE LA FILA", async () => {
    getVerdictStoreMock.mockReturnValue(
      honestVerdictStore([{ senderAddress: ADDR, verificationId: ROW_ID }]),
    );
    const res = await POST(req(bodyOf()));
    expect(
      res.status,
      "con el flag encendido y fila, un pagador legítimo NO pudo pagar contra la autoridad real: " +
        "eso es el money-path caído, y ningún test con la autoridad mockeada lo vería",
    ).toBe(200);
    // El id viaja DENTRO de la URL que la autoridad fetchea, así que acá se mide contra la
    // implementación real y no contra el argumento de un espía.
    const authorityUrl = urls.find((u) => u.includes("/api/agents/"));
    expect(authorityUrl, "la autoridad real no se consultó").toBeDefined();
    expect(
      authorityUrl,
      "la autoridad real recibió el identificador que vino en el body: quien tenga el de otra " +
        "persona puede cobrar bajo la verificación de esa persona (CD-26)",
    ).toContain(ROW_ID);
    expect(authorityUrl).not.toContain(BODY_ID);
  });

  // ── T-FLAG-2 — el hallazgo ─────────────────────────────────────────────────────────────────────
  it("T-FLAG-2: FLAG OFF ⇒ el MISMO pagador legítimo NO paga. El flag no es un kill-switch", async () => {
    getVerdictStoreMock.mockReturnValue(null); // KYC_VERDICT_STORE_ENABLED ausente
    const res = await POST(req(bodyOf()));
    expect(
      res.status,
      "con el flag apagado la ruta dejó pasar un pago: o consultó a la autoridad con un " +
        "identificador que no salió de ninguna fila, o aceptó el del cliente (CD-26)",
    ).not.toBe(200);
    // 503 y NO 400: lo que falta es configuración NUESTRA. El 400 `prepare_invalid_request` que
    // devolvía antes de este arreglo le echaba la culpa al que llama, y encima era el mismo enum con
    // el que la ruta rechaza un body malformado — indistinguible para quien mira los logs.
    expect(
      res.status,
      "el flag apagado responde 400: le dice al pagador que su pedido está mal cuando el pedido " +
        "está bien y lo que falta es una variable de entorno nuestra",
    ).toBe(503);
    expect(await res.json()).toEqual({ error: "prepare_kyc_verdict_unavailable" });
    // Y NADA salió a la red: ni a la autoridad, ni al gateway. Un corte que igual gasta cupo del
    // proveedor de identidad sería el peor de los dos mundos.
    expect(urls, "el corte por flag apagado igual salió a la red").toEqual([]);
  });

  // ── T-FLAG-3 — el kill-switch invertido, dicho como comportamiento ─────────────────────────────
  it("T-FLAG-3: apagar el flag DESPUÉS de un pago exitoso corta ese mismo pago (interruptor de una sola dirección)", async () => {
    // Mismo caller, mismo body, misma autoridad. Lo ÚNICO que cambia entre las dos corridas es el
    // flag. Es la forma ejecutable de la frase "apagarlo ante un incidente mata los pagos": si
    // mañana alguien vuelve a escribir que el flag es reversible, este test lo contradice con dos
    // status distintos producidos por la misma entrada.
    const store = honestVerdictStore([{ senderAddress: ADDR, verificationId: ROW_ID }]);
    getVerdictStoreMock.mockReturnValue(store);
    const conFlag = await POST(req(bodyOf()));
    getVerdictStoreMock.mockReturnValue(null);
    const sinFlag = await POST(req(bodyOf()));
    expect([conFlag.status, sinFlag.status]).toEqual([200, 503]);
  });
});
