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

import bs58 from "bs58";
import nacl from "tweetnacl";
import type { PopSigner } from "../../application/ports";
import { HttpPopSigner } from "../auth/http-pop-signer";
import { HttpSolanaPayoutPrepareGateway } from "./http-solana-prepare-gateway";
import { POST as CHALLENGE_POST } from "../../../app/api/a2a/payout/challenge/route";
import { POST as PREPARE_POST } from "../../../app/api/payout/prepare/route";

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
    return { tx: "unused" };
  },
  async signMessage(message: string): Promise<string> {
    return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), KP.secretKey));
  },
};

function prepareInput() {
  return {
    remittanceId: "rem-1",
    quoteId: "q-400",
    kycVerificationId: "v-1",
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
    if (target === "/api/payout/prepare") {
      // Dentro del handler, el fetch al agente usa la MISMA función global: se distingue por URL
      // absoluta (BASE) y se responde con el result del agente.
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

function agentOk(): Response {
  return new Response(
    JSON.stringify({
      result: {
        status: "submitted",
        payoutId: "transfi-po-1",
        deliveredLocal: null,
        txRef: null,
        reason: null,
        provenance: "transfi",
        depositAddress: DEPOSIT,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("HttpSolanaPayoutPrepareGateway — el body que arma el cliente ES el que la route acepta", () => {
  beforeEach(() => {
    KP = nacl.sign.keyPair();
    ADDR = bs58.encode(KP.publicKey);
    AUTHORITY = bs58.encode(nacl.sign.keyPair().publicKey);
    vi.stubEnv("REMIT_AGENTS_BASE_URL", "https://agents.test");
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "test-deposit-secret");
    vi.stubEnv("SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY", AUTHORITY);
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("PAYOUT_POP_SECRET", "pop-secret");
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "");
    checkRouteRateLimitMock.mockReset();
    checkRouteRateLimitMock.mockResolvedValue({ ok: true });
    authorityMock.mockReset();
    authorityMock.mockResolvedValue({ authorized: true, httpStatus: 200 });
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
