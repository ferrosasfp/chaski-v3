// Tests — HttpSolanaPayoutPrepareGateway (cliente) contra la route REAL /api/payout/prepare.
//
// Por qué este archivo existe: el gateway posteaba 7 campos y la route exige 9. Nadie lo notaba
// porque el gateway no tenía tests y la route se testeaba con un body escrito a mano en el test, que
// SÍ traía el PoP. Los dos lados estaban verdes y el camino estaba muerto. Acá el body lo arma el
// gateway de producción y lo valida el handler de producción: si un lado cambia de forma y el otro
// no, esto se pone rojo.
//
// El PoP corre REAL de punta a punta: el challenge sale del emisor HMAC real
// (/api/a2a/payout/challenge), la firma es ed25519 de verdad (nacl) y la verifica verifySolanaPop.
// Nada de esto está mockeado — es justamente lo que hay que probar que "calza".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Rate-limit: sin envs de Upstash es fail-closed 503. Mismo mock que los tests de las dos routes.
const { checkRouteRateLimitMock } = vi.hoisted(() => ({ checkRouteRateLimitMock: vi.fn() }));
vi.mock("../rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rate-limit")>();
  return { ...actual, checkRouteRateLimit: checkRouteRateLimitMock };
});

// Autoridad server-side (WKH-202): fuera del alcance de este test, mockeada en "autorizado".
const { authorityMock } = vi.hoisted(() => ({ authorityMock: vi.fn() }));
vi.mock("../payout/authority", () => ({ resolvePayoutAuthority: authorityMock }));

// Ledger apagado (la route lo trata best-effort).
vi.mock("../persistence/supabase-settlement-ledger", () => ({
  getSettlementLedger: () => null,
  CHAIN_ID_NOT_APPLICABLE: 0,
}));

// 🔴 WKH-333 (fix-pack AR/BLQ-ALTO-1) — el store del veredicto, con la fila del caller. Sin esto la
// factory REAL devuelve `null` (la env `KYC_VERDICT_STORE_ENABLED` no está en el ambiente de test) y
// la route corta con 503 ANTES de llegar al forward: los 17 casos de este archivo medirían el flag
// apagado en vez de medir que el body del gateway calza con lo que la route exige, que es lo único
// que este archivo existe para medir. El doble filtra por dueño de verdad (CD-17).
const { getVerdictStoreMock } = vi.hoisted(() => ({ getVerdictStoreMock: vi.fn() }));
vi.mock("../persistence/supabase-kyc-verdicts", () => ({
  getKycVerdictStore: getVerdictStoreMock,
}));

import bs58 from "bs58";
import nacl from "tweetnacl";
import { PREPARE_NO_AGENT_FOR_CAPABILITY } from "../../application/agent-rejections";
import { humanError } from "../../presentation/flow-vm";
import type { PopSigner } from "../../application/ports";
import { HttpPopSigner } from "../auth/http-pop-signer";
import { HttpSolanaPayoutPrepareGateway } from "./http-solana-prepare-gateway";
import { POST as CHALLENGE_POST } from "../../../app/api/a2a/payout/challenge/route";
import { POST as PREPARE_POST } from "../../../app/api/payout/prepare/route";
import { POST as ATTESTATION_POST } from "../../../app/api/payout/attestation/route";

const DEPOSIT = "So11111111111111111111111111111111111111112";
const beneficiary = {
  name: "Mamá",
  country: "PE",
  method: "yape" as const,
  destination: "999888777",
};

let KP: nacl.SignKeyPair;
let ADDR: string;
let AUTHORITY: string;

// Wallet mínima: sólo `signMessage`, que es lo único que HttpPopSigner necesita. Firma ed25519 REAL
// con la key cuya pubkey es la address del caller — así P3 (address match) y P5 (recuperación del
// firmante) de la route se ejercitan de verdad y no contra un stub complaciente.
const wallet = {
  async connect() {
    return ADDR;
  },
  async getAddress() {
    return ADDR;
  },
  async authorizePrincipal() {
    return { estado: "listo" as const, tx: "unused" };
  },
  async signMessage(message: string): Promise<string> {
    return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), KP.secretKey));
  },
};

function prepareInput() {
  return {
    remittanceId: "rem-1",
    quoteId: "q-400",
    // WKH-333: el gateway ya NO envía el identificador; lo resuelve la route desde su fila.
    address: ADDR,
    amountUsd: 400,
    beneficiary,
    idempotencyKey: "rem-1:q-400",
  };
}

// Rutea el `fetch` del cliente a los handlers REALES de las dos routes; el único fetch que sí se
// mockea es el del server hacia el agente remit-cashout-payout (cero red, cero orden real).
function routeFetch(agent: () => Response) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    const request = new Request(`http://localhost${target}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: init?.body as string,
    });
    if (target === "/api/a2a/payout/challenge") return CHALLENGE_POST(request);
    // El verificador de la atestación corre REAL, con el MISMO secreto que la emitió. Mockearlo
    // sería probar que el cliente llama a algo, no que la firma sirve para algo.
    if (target === "/api/payout/attestation") return ATTESTATION_POST(request);
    if (target === "/api/payout/prepare") {
      // Dentro del handler, el forward al gateway usa la MISMA función global: se distingue por ser
      // una URL absoluta ({GW}/compose) y se responde con el output que el gateway relaya.
      const outer = globalThis.fetch;
      vi.stubGlobal("fetch", async () => agent());
      try {
        return await PREPARE_POST(request);
      } finally {
        vi.stubGlobal("fetch", outer);
      }
    }
    throw new Error(`unexpected fetch: ${target}`);
  });
}

/** Igual que `routeFetch` para el PoP (el challenge sale del emisor REAL, así que la firma que viaja
 *  es una de verdad), pero la respuesta de `/api/payout/prepare` la escribe el test: sirve para
 *  entrar por un status+body EXACTOS de la route sin tener que levantarle la configuración que los
 *  produce. Nada más está mockeado: el que interpreta ese body es el gateway de producción. */
function prepareRespondsWith(status: number, body: unknown) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target === "/api/a2a/payout/challenge") {
      return CHALLENGE_POST(
        new Request(`http://localhost${target}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: init?.body as string,
        }),
      );
    }
    if (target === "/api/payout/prepare") {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${target}`);
  });
}

/** El output del agente, envuelto como lo entrega `POST /compose` (WKH-332/W3). Antes era `{ result }`,
 *  la respuesta del agente invocado por su slug; ese carril se borró y la route ya no sabe leerlo.
 *  Lo que este archivo mide —que el body que arma el cliente ES el que la route acepta— no cambia. */
function composeRelays(output: unknown): Response {
  return new Response(JSON.stringify({ success: true, steps: [{ output }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function agentOk(): Response {
  return composeRelays({
    status: "submitted",
    payoutId: "transfi-po-1",
    deliveredLocal: null,
    txRef: null,
    reason: null,
    provenance: "transfi",
    depositAddress: DEPOSIT,
  });
}

describe("HttpSolanaPayoutPrepareGateway — el body que arma el cliente ES el que la route acepta", () => {
  beforeEach(() => {
    KP = nacl.sign.keyPair();
    ADDR = bs58.encode(KP.publicKey);
    AUTHORITY = bs58.encode(nacl.sign.keyPair().publicKey);
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "test-deposit-secret");
    vi.stubEnv("SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY", AUTHORITY);
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("PAYOUT_POP_SECRET", "pop-secret");
    // W3: la route tiene UN transporte y hay que configurarlo. Antes acá se stubeaba la base de los
    // agentes y el flag en "" para forzar el carril punto a punto; los dos se fueron con ese carril.
    vi.stubEnv("WASIAI_A2A_GATEWAY_URL", "https://gateway.test");
    vi.stubEnv("WASIAI_A2A_AGENT_KEY", "ak_prepare_gateway_test");
    checkRouteRateLimitMock.mockReset();
    checkRouteRateLimitMock.mockResolvedValue({ ok: true });
    authorityMock.mockReset();
    authorityMock.mockResolvedValue({ authorized: true, httpStatus: 200 });
    getVerdictStoreMock.mockReset();
    getVerdictStoreMock.mockReturnValue({
      get: vi.fn(async (sender: string) =>
        sender === ADDR
          ? {
              senderAddress: ADDR,
              verificationId: "did-de-la-fila",
              approved: true,
              riskLevel: "low" as const,
              provenance: "didit",
              verifiedAt: "2026-08-01T00:00:00.000Z",
            }
          : null,
      ),
      put: vi.fn(),
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // EL test de esta HU. Antes del fix devolvía { ok:false, reason:"payout_pop_unverified" }: la
  // persona apretaba "Confirmar y enviar" y comía un error antes de que la wallet le pidiera nada.
  it("con el PoP cableado, prepare() completa 200 contra la route real (antes: 403 payout_pop_unverified)", async () => {
    vi.stubGlobal("fetch", routeFetch(agentOk));
    const gw = new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet));

    const out = await gw.prepare(prepareInput());

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.result.beneficiary).toBe(DEPOSIT);
    expect(out.result.authority).toBe(AUTHORITY);
    expect(out.result.payoutId).toBe("transfi-po-1");
  });

  // ── Hallazgo #75, de punta a punta ──────────────────────────────────────────────────────────────
  // Acá se prueba lo único que importa de verdad: que el enum que la route deriva del `reason` del
  // agente LLEGUE al `reason` que el use-case persiste en la remesa. Si el cliente lo colapsa, la
  // separación del server no existe para ninguna pantalla. El caso es real: antes de esto, los
  // cuatro rechazos del agente terminaban en `prepare_no_deposit_address`.
  function agentRejectsWith(reason: string | null): () => Response {
    return () =>
      composeRelays({
        status: "blocked",
        payoutId: null,
        deliveredLocal: null,
        txRef: null,
        reason,
        provenance: "transfi",
        depositAddress: null,
      });
  }

  it.each([
    ["quote_amount_mismatch", "prepare_quote_amount_mismatch"],
    ["quote_unresolvable", "prepare_quote_unresolvable"],
    ["kyc_identity_claim_missing", "prepare_kyc_identity_claim_missing"],
    ["kyc_gate_not_passed", "prepare_agent_rejected"], // colapsado a propósito (no-oráculo)
  ])("#75: el rechazo %s del agente llega al cliente como %s", async (reason, esperado) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", routeFetch(agentRejectsWith(reason)));
    const out = await new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)).prepare(
      prepareInput(),
    );
    expect(out).toEqual({ ok: false, reason: esperado });
  });

  // El default del cliente para "4xx que no reconozco" es `prepare_rejected`. Si alguien saca el
  // bloque de la allow-list, los cuatro casos de arriba caen ahí y vuelven a ser indistinguibles
  // entre sí — verdes en un test que sólo mirara `ok:false`. Este los compara.
  it("#75: los rechazos NO caen en el default `prepare_rejected` ni comparten reason entre sí", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reasons: string[] = [];
    for (const r of ["quote_amount_mismatch", "quote_unresolvable", "kyc_identity_claim_missing"]) {
      vi.stubGlobal("fetch", routeFetch(agentRejectsWith(r)));
      const out = await new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)).prepare(
        prepareInput(),
      );
      if (out.ok) throw new Error("unreachable");
      reasons.push(out.reason);
    }
    expect(reasons).not.toContain("prepare_rejected");
    expect(reasons).not.toContain("prepare_no_deposit_address");
    expect(new Set(reasons).size).toBe(3);
  });

  // CANDADO: la respuesta INCOMPLETA (el mock: submitted + sin dirección) no es un rechazo y sigue
  // saliendo por el enum que la describe bien.
  it("#75 CANDADO: el provider mock sigue dando prepare_no_deposit_address", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch(() =>
        composeRelays({
          status: "submitted",
          payoutId: "transfi-po-1",
          deliveredLocal: null,
          txRef: null,
          reason: null,
          provenance: "transfi",
          depositAddress: null,
        }),
      ),
    );
    const out = await new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)).prepare(
      prepareInput(),
    );
    expect(out).toEqual({ ok: false, reason: "prepare_no_deposit_address" });
  });

  // ── CR/BLQ-MED-1 · EL CABLEADO DE AC-13, NO LA RAMA QUE PINTA ───────────────────────────────────
  //
  // 🔴 QUÉ AGUJERO CIERRA, MEDIDO. `http-solana-prepare-gateway.ts`:68 es la ÚNICA línea que lleva el
  // enum de AC-13 desde el body del 422 de la route hasta el `failureReason` de la remesa. Mutándola
  // línea-neutra a `case ${PREPARE_NO_AGENT_FOR_CAPABILITY}_x:` (con backticks), `tsc` daba exit 0 y
  // la suite COMPLETA 1587/1587 verde, con el enum cayendo al default `prepare_rejected` y la
  // pantalla diciendo "Algo salió mal. Intentá de nuevo." — el copy de ANTES de la HU.
  //
  // Los tests que había no podían verlo: `flow.test.tsx` INYECTA el `failureReason` en el estado de
  // la remesa y `flow-vm.test.ts` llama a `humanError(...)` con el string a mano. Los dos prueban que
  // la rama pinta; ninguno prueba que el motivo llegue (`tests-que-registran-el-doble-no-prueban-el-cableado`).
  //
  // El `reason` que sale de acá es literalmente lo que `ConfirmAndSend` persiste como `failureReason`
  // (`failAndRefund`, `../../application/use-cases/confirm-and-send.ts:425`), y `TrackView` ramifica
  // por esa MISMA constante — por eso se compara contra la constante y no contra un literal.
  it("CABLEADO/AC-13: el 422 de la route llega al reason que se persiste, y de ahí al copy de 'no hay quién'", async () => {
    vi.stubGlobal("fetch", prepareRespondsWith(422, { error: PREPARE_NO_AGENT_FOR_CAPABILITY }));

    const out = await new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)).prepare(
      prepareInput(),
    );

    expect(out).toEqual({ ok: false, reason: PREPARE_NO_AGENT_FOR_CAPABILITY });
    if (out.ok) throw new Error("unreachable");
    // Y lo que la persona lee al final del cable. Sin la línea 68 esto es el genérico.
    expect(humanError(out.reason)).toContain("no hay ningún proveedor");
    expect(humanError(out.reason)).not.toBe("Algo salió mal. Intentá de nuevo.");
    // La otra mitad: no cayó al default de "4xx que no reconozco", que es a dónde iba sin el `case`.
    expect(out.reason).not.toBe("prepare_rejected");
    expect(humanError(out.reason)).not.toBe(humanError("prepare_rejected"));
  });

  // El challenge se pide ANTES del prepare y para la MISMA address del body. Si alguien firmara para
  // otra address, P3 de la route la rechazaría; este test clava el orden y el argumento.
  it("pide el challenge para la MISMA address que viaja en el body, y ANTES del prepare", async () => {
    const fetchMock = routeFetch(agentOk);
    vi.stubGlobal("fetch", fetchMock);
    await new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)).prepare(prepareInput());

    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls[0]).toBe("/api/a2a/payout/challenge");
    expect(calls[1]).toBe("/api/payout/prepare");
    const challengeBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      address: string;
    };
    expect(challengeBody.address).toBe(ADDR);
    const prepareBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      popChallenge?: string;
      popSignature?: string;
    };
    expect(typeof prepareBody.popChallenge).toBe("string");
    expect(typeof prepareBody.popSignature).toBe("string");
  });

  // Firma inservible ⇒ la route rechaza y el gateway propaga el enum TAL CUAL. No hay retry, no hay
  // degradación a "seguí sin PoP": el guard de la route es el que manda.
  it("una firma que no verifica ⇒ 403 de la route propagado como payout_pop_unverified", async () => {
    vi.stubGlobal("fetch", routeFetch(agentOk));
    const otro = nacl.sign.keyPair(); // firma con OTRA key: P5 (ed25519) falla
    const gw = new HttpSolanaPayoutPrepareGateway(
      new HttpPopSigner({
        ...wallet,
        async signMessage(message: string) {
          return bs58.encode(
            nacl.sign.detached(new TextEncoder().encode(message), otro.secretKey),
          );
        },
      }),
    );

    const out = await gw.prepare(prepareInput());
    expect(out).toEqual({ ok: false, reason: "payout_pop_unverified" });
  });

  // Sin PAYOUT_POP_SECRET el emisor responde 501 ⇒ prove() null. No se postea el prepare: sería un
  // viaje garantizado al 503 de la misma env. El enum es el mismo que devolvería la route.
  it("PoP apagado server-side (501) ⇒ payout_pop_unavailable y NINGÚN POST a /api/payout/prepare", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "");
    const fetchMock = routeFetch(agentOk);
    vi.stubGlobal("fetch", fetchMock);

    const out = await new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)).prepare(
      prepareInput(),
    );

    expect(out).toEqual({ ok: false, reason: "payout_pop_unavailable" });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["/api/a2a/payout/challenge"]);
  });

  // ── La atestación del depósito, conectada ────────────────────────────────────────────────────
  //
  // Estos tests existen porque `verifySolanaDepositAttestation` estaba escrita, testeada y NO LA
  // LLAMABA NADIE: la route firmaba el beneficiary y el cliente usaba el beneficiary de primer
  // nivel tirando la firma. Cada uno de acá abajo se pone ROJO si se quita la verificación.
  //
  // ⚠️ Lo que prueban es que una respuesta ALTERADA EN EL CAMINO no llega a la wallet. NO prueban
  // que la dirección sea legítima: la firma la pone nuestro servidor sobre lo que dijo el agente.
  // Y NO prueban nada sobre el intermediario que reescribe las DOS rutas: ese caso está clavado
  // abajo, con su resultado real, en "LÍMITE CONOCIDO".

  /** Deja pasar todo a las routes reales, pero reescribe el JSON del 200 de /api/payout/prepare y
   *  SÓLO ese: modela un adversario ACOTADO a esa respuesta (un proxy que reescribe por path, un
   *  bug de caché, una route nuestra que devuelve un campo cambiado). El adversario que además
   *  reescribe /api/payout/attestation NO está modelado acá y esta capa no lo detiene. */
  function tamperingFetch(patch: (body: Record<string, unknown>) => Record<string, unknown>) {
    const inner = routeFetch(agentOk);
    return vi.fn(async (url: string, init?: RequestInit) => {
      const res = await inner(url, init);
      if (String(url) !== "/api/payout/prepare" || res.status !== 200) return res;
      const body = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify(patch(body)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  // EL asesino del mutante. Sacá la llamada a verifyAttestation (o el mismatch check) y este test
  // se pone verde con el beneficiary del atacante viajando a la wallet.
  it("beneficiary adulterado en el camino con la atestación INTACTA ⇒ prepare_attestation_mismatch", async () => {
    const ATACANTE = bs58.encode(nacl.sign.keyPair().publicKey);
    vi.stubGlobal(
      "fetch",
      tamperingFetch((b) => ({ ...b, beneficiary: ATACANTE })),
    );

    const out = await new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)).prepare(
      prepareInput(),
    );

    expect(out).toEqual({ ok: false, reason: "prepare_attestation_mismatch" });
  });

  // Misma idea sobre la OTRA mitad del binding: la release-authority.
  it("authority adulterada en el camino con la atestación INTACTA ⇒ prepare_attestation_mismatch", async () => {
    const OTRA = bs58.encode(nacl.sign.keyPair().publicKey);
    vi.stubGlobal(
      "fetch",
      tamperingFetch((b) => ({ ...b, authority: OTRA })),
    );

    const out = await new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)).prepare(
      prepareInput(),
    );

    expect(out).toEqual({ ok: false, reason: "prepare_attestation_mismatch" });
  });

  // El atacante reescribe beneficiary Y atestación: sin el secreto no puede firmar, el HMAC no valida.
  it("atestación forjada (no firmada con el secreto) ⇒ prepare_attestation_unverified", async () => {
    const ATACANTE = bs58.encode(nacl.sign.keyPair().publicKey);
    const payload = Buffer.from(
      JSON.stringify({
        remittanceId: "rem-1",
        quoteId: "q-400",
        beneficiary: ATACANTE,
        authority: AUTHORITY,
        cluster: "devnet",
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
      "utf8",
    ).toString("base64url");
    vi.stubGlobal(
      "fetch",
      tamperingFetch((b) => ({
        ...b,
        beneficiary: ATACANTE,
        attestation: `${payload}.${Buffer.from("mac-inventado").toString("base64url")}`,
      })),
    );

    const out = await new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)).prepare(
      prepareInput(),
    );

    expect(out).toEqual({ ok: false, reason: "prepare_attestation_unverified" });
  });

  // Replay entre remesas: la atestación es AUTÉNTICA (nuestro servidor la firmó) pero es de OTRA
  // remesa. Sin el binding remittanceId+quoteId, el atacante se hace una remesa propia, se guarda su
  // atestación legítima y la pega entera acá.
  it("atestación AUTÉNTICA pero de otra remesa ⇒ prepare_attestation_unverified", async () => {
    let ajena: { beneficiary: unknown; authority: unknown; attestation: unknown } | null = null;
    const inner = routeFetch(agentOk);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const res = await inner(url, init);
      if (String(url) !== "/api/payout/prepare" || res.status !== 200) return res;
      const body = (await res.json()) as Record<string, unknown>;
      if (!ajena) {
        // primera corrida: es la remesa del atacante, nos quedamos con su triple
        ajena = {
          beneficiary: body.beneficiary,
          authority: body.authority,
          attestation: body.attestation,
        };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response(JSON.stringify({ ...body, ...ajena }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const gw = new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet));

    // 1) remesa del atacante: su atestación queda capturada
    const propia = await gw.prepare({ ...prepareInput(), remittanceId: "rem-atacante" });
    expect(propia.ok).toBe(true);
    // 2) remesa de la víctima: le inyectamos el triple ajeno, firma auténtica incluida
    const out = await gw.prepare(prepareInput());

    expect(out).toEqual({ ok: false, reason: "prepare_attestation_unverified" });
  });

  // El `agent` es trazabilidad y se lee sin inventar nada: un agente que viene con slug y sin
  // catálogo se guarda así. Rellenar `registry: ""` diría "el catálogo es vacío" en vez de "no lo
  // dijo", que es la misma clase de afirmación de más que este archivo vino a corregir.
  it("agent con slug y sin registry ⇒ el registry queda AUSENTE (no cadena vacía)", async () => {
    vi.stubGlobal(
      "fetch",
      tamperingFetch((b) => ({ ...b, agent: { slug: "remit-cashout-payout" } })),
    );

    const out = await new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)).prepare(
      prepareInput(),
    );

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.result.agent).toEqual({ slug: "remit-cashout-payout" });
    expect(out.result.agent).not.toHaveProperty("registry");
  });

  // ── LÍMITE CONOCIDO de esta capa, clavado con su resultado real ───────────────────────────────
  //
  // Este test PASA con el código actual y tiene que pasar: no documenta un éxito, documenta hasta
  // dónde llega la atestación. Si algún día alguien hace que este test se ponga rojo, la capa
  // mejoró de verdad y hay que reescribir el bloque de alcance de las dos puntas.
  //
  // El adversario es el MISMO de los tests de arriba, sin ninguna capacidad nueva: está en el
  // camino entre nuestro servidor y el navegador. Sólo que ahora reescribe las DOS respuestas, que
  // es lo que un intermediario hace por definición (mismo origen, misma sesión TLS, mismo `fetch`).
  // `verifyAttestation` no verifica firmas: le pregunta al server y le cree. Poniendo su dirección
  // en las dos respuestas, la igualdad que compara el gateway compara dos valores del atacante.
  it("LÍMITE CONOCIDO: el intermediario que reescribe LAS DOS rutas pasa, y el beneficiary del atacante llega a la wallet", async () => {
    const ATACANTE = bs58.encode(nacl.sign.keyPair().publicKey);
    const inner = routeFetch(agentOk);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const target = String(url);
        const res = await inner(url, init);
        if (res.status !== 200) return res;
        // 1) el 200 de prepare: le pone SU dirección (la atestación queda intacta, firmada sobre la real)
        if (target === "/api/payout/prepare") {
          const body = (await res.json()) as Record<string, unknown>;
          return new Response(JSON.stringify({ ...body, beneficiary: ATACANTE }), { status: 200 });
        }
        // 2) el 200 del verificador: le hace decir que el firmado era el suyo. No forjó ningún HMAC;
        //    reescribió el VEREDICTO, que es lo único que el cliente llega a ver.
        if (target === "/api/payout/attestation") {
          const body = (await res.json()) as Record<string, unknown>;
          return new Response(JSON.stringify({ ...body, beneficiary: ATACANTE }), { status: 200 });
        }
        return res;
      }),
    );

    const out = await new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)).prepare(
      prepareInput(),
    );

    // Pasa. Y devuelve la dirección del atacante, contra la que la wallet firmaría el depósito.
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.result.beneficiary).toBe(ATACANTE);
    expect(out.result.beneficiary).not.toBe(DEPOSIT);
    // Lo que corta ESTE ataque corre server-side y no está en este archivo: el settle compara el
    // beneficiary de los bytes de la tx firmada contra la deposit-address que el servidor persistió
    // al preparar (app/api/settle/solana-sponsor/route.ts, tests en su route.test.ts).
  });

  // Si NO se puede verificar, no se usa. Y "no pude preguntar" tampoco es "no valida": bloquea igual
  // pero con SU enum, porque es lo que queda escrito en la remesa fallada.
  it("el verificador caído (throw) ⇒ prepare_attestation_unavailable, el beneficiary NO se usa", async () => {
    const inner = routeFetch(agentOk);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url) === "/api/payout/attestation") throw new Error("network");
        return inner(url, init);
      }),
    );

    const out = await new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)).prepare(
      prepareInput(),
    );

    expect(out).toEqual({ ok: false, reason: "prepare_attestation_unavailable" });
  });

  // Un 503 del verificador (la route no puede verificar: sin secreto responde así) NO es un veredicto
  // sobre la firma. El 403, en cambio, SÍ lo es. Dos respuestas distintas ⇒ dos enums distintos.
  it("503 del verificador ⇒ unavailable; 403 ⇒ unverified (no se colapsan)", async () => {
    const casos: Array<[number, string]> = [
      [503, "prepare_attestation_unavailable"],
      [500, "prepare_attestation_unavailable"],
      [403, "prepare_attestation_unverified"],
    ];
    for (const [status, reason] of casos) {
      const inner = routeFetch(agentOk);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (String(url) === "/api/payout/attestation") {
            return new Response(JSON.stringify({ error: "x" }), { status });
          }
          return inner(url, init);
        }),
      );

      const out = await new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)).prepare(
        prepareInput(),
      );

      expect(out).toEqual({ ok: false, reason });
    }
  });

  // El POST al verificador lleva timeout: un fetch colgado dejaba la pantalla esperando para siempre
  // (sin error y sin firma que aprobar) porque este era el único fetch del flujo sin AbortSignal.
  it("el POST a /api/payout/attestation viaja con AbortSignal (no puede colgarse para siempre)", async () => {
    const fetchMock = routeFetch(agentOk);
    vi.stubGlobal("fetch", fetchMock);

    await new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)).prepare(prepareInput());

    const call = fetchMock.mock.calls.find((c) => String(c[0]) === "/api/payout/attestation");
    if (!call) throw new Error("no se posteó la atestación");
    expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  // La verificación ocurre ANTES de devolver el beneficiary, y el valor devuelto sale del payload
  // FIRMADO (no del campo de primer nivel).
  it("happy path: se postea a /api/payout/attestation despues del prepare y el beneficiary sale del payload firmado", async () => {
    const fetchMock = routeFetch(agentOk);
    vi.stubGlobal("fetch", fetchMock);

    const out = await new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet)).prepare(
      prepareInput(),
    );

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.result.beneficiary).toBe(DEPOSIT);
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls).toEqual([
      "/api/a2a/payout/challenge",
      "/api/payout/prepare",
      "/api/payout/attestation",
    ]);
    const verifyBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      remittanceId: string;
      quoteId: string;
    };
    expect(verifyBody.remittanceId).toBe("rem-1");
    expect(verifyBody.quoteId).toBe("q-400");
  });

  // El PopSigner lanza (red caída / 5xx del emisor) ⇒ fail-closed, sin postear.
  it("PopSigner que lanza ⇒ payout_pop_unavailable y NINGÚN POST a /api/payout/prepare", async () => {
    const fetchMock = routeFetch(agentOk);
    vi.stubGlobal("fetch", fetchMock);
    const throwing: PopSigner = {
      async prove() {
        throw new Error("pop_challenge_unavailable");
      },
    };

    const out = await new HttpSolanaPayoutPrepareGateway(throwing).prepare(prepareInput());

    expect(out).toEqual({ ok: false, reason: "payout_pop_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
