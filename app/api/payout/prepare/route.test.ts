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

// Ledger: default null (flag OFF ⇒ byte-idéntico). Un test lo apunta a un mock.
const { ledgerMock, getLedgerMock } = vi.hoisted(() => ({
  ledgerMock: { recordOrderPrepared: vi.fn() },
  getLedgerMock: vi.fn(),
}));
vi.mock("../../../../src/infrastructure/persistence/supabase-settlement-ledger", () => ({
  getSettlementLedger: getLedgerMock,
}));

import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  issueSolanaPopChallenge,
  buildSolanaPopMessage,
} from "../../../../src/infrastructure/auth/pop-challenge";
import {
  verifyDepositAttestation,
  verifySolanaDepositAttestation,
} from "../../../../src/infrastructure/settlement/deposit-attestation";
// WKH-304/CD-11: el par (capacidad, piso) se assertea contra las MISMAS constantes que consume la
// route y que consume submit — nunca contra literales copiados en el test.
import {
  PAYOUT_CAPABILITY,
  PAYOUT_MIN_REPUTATION,
} from "../../../../src/infrastructure/a2a/gateway-client";
import { POST } from "./route";

const ADDR = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "0x4444444444444444444444444444444444444444";
const beneficiary = { name: "Mamá", country: "PE", method: "yape", destination: "999888777" };

function bodyOf(over: Record<string, unknown> = {}) {
  return {
    remittanceId: "rem-1",
    quoteId: "q-400",
    kycVerificationId: "v-1",
    address: ADDR,
    amountUsd: 400,
    beneficiary,
    idempotencyKey: "rem-1:q-400",
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
// mockImplementation (NO mockResolvedValue): el body de un Response se consume en la 1ª lectura.
function agentResponds(status: number, result: unknown): void {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ result }), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
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
    vi.stubEnv("REMIT_AGENTS_BASE_URL", "https://agents.test");
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "test-deposit-secret");
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "84532");
    vi.stubEnv("VERCEL_ENV", ""); // local/CI por default
    vi.stubEnv("PAYOUT_POP_SECRET", ""); // PoP apagado por default
    // WKH-304: PR7 ahora LEE este flag. Sin stubearlo, las suites de arriba dependerían del ambiente
    // (un NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=a2a-gateway exportado en la shell las mandaría al
    // gateway). "" ⇒ camino punto-a-punto determinista, byte-idéntico al de antes de esta HU.
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "");
    checkRouteRateLimitMock.mockReset();
    checkRouteRateLimitMock.mockResolvedValue({ ok: true });
    authorityMock.mockReset();
    authorityMock.mockResolvedValue({ authorized: true, httpStatus: 200 });
    ledgerMock.recordOrderPrepared.mockReset();
    ledgerMock.recordOrderPrepared.mockResolvedValue(undefined);
    getLedgerMock.mockReset();
    getLedgerMock.mockReturnValue(null);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ── Happy path (AC-1) ──────────────────────────────────────────────────────
  it("AC-1: config OK + agente con depositAddress real → 200 { depositAddress, attestation, payoutId, provenance }; la attestation VERIFICA", async () => {
    agentResponds(200, agentResult());
    const res = await POST(req(bodyOf()));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.depositAddress).toBe(DEPOSIT);
    expect(json.payoutId).toBe("transfi-po-1");
    expect(json.provenance).toBe("transfi");
    // La attestation es real: verifica con el secreto y ata remittanceId/quoteId/chainId/depositAddress.
    const att = verifyDepositAttestation(json.attestation as string, Date.now());
    expect(att).not.toBeNull();
    expect(att?.remittanceId).toBe("rem-1");
    expect(att?.quoteId).toBe("q-400");
    expect(att?.depositAddress).toBe(DEPOSIT);
    expect(att?.chainId).toBe(84532); // CD-9: de la ENV, no del body
    // NUNCA ecoa BASE ni el beneficiary (CD-5).
    const raw = JSON.stringify(json);
    expect(raw).not.toContain("agents.test");
    expect(raw).not.toContain("Mamá");
    expect(raw).not.toContain("999888777");
  });

  // ── PR1/PR2 — config (AC-7) ────────────────────────────────────────────────
  it("PR1: sin REMIT_AGENTS_BASE_URL → 501 prepare_not_configured, NINGÚN fetch", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", "");
    const res = await POST(req(bodyOf()));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "prepare_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PR2: sin DEPOSIT_ATTESTATION_SECRET → 503 prepare_unavailable (fail-closed, NUNCA fail-open)", async () => {
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "");
    const res = await POST(req(bodyOf()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "prepare_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
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
    for (const over of [
      { remittanceId: "" },
      { quoteId: "" },
      { kycVerificationId: "" },
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
    const res = await POST(req(bodyOf())); // sin popChallenge
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
    expect(arg.chainId).toBe(84532);
    expect(arg.senderAddress).toBe(ADDR);
    expect(arg.payoutId).toBe("transfi-po-1");
    // NUNCA PII del beneficiary.
    expect(JSON.stringify(arg)).not.toContain("Mamá");
    expect(JSON.stringify(arg)).not.toContain("999888777");
  });

  it("CD-17: ledger ON + recordOrderPrepared throw → prepare responde 200 igual (best-effort)", async () => {
    getLedgerMock.mockReturnValue(ledgerMock);
    ledgerMock.recordOrderPrepared.mockRejectedValue(new Error("db down"));
    agentResponds(200, agentResult());
    const res = await POST(req(bodyOf()));
    expect(res.status).toBe(200);
    expect(ledgerMock.recordOrderPrepared).toHaveBeenCalledTimes(1);
  });

  // ── HU-SOL-8: PR6 rama Solana — PoP OBLIGATORIO (AC-3). Actualizado por HU-SOL-9: PR4 ahora valida
  //    base58 en vm=solana (antes exigía 0x), así que el address del caller debe ser un pubkey base58
  //    para pasar PR4 y llegar a PR6. Las assertions (503/403/no-fetch) NO cambian. ──
  const SOL_ADDR = "So11111111111111111111111111111111111111112"; // base58 pubkey (pasa PR4 en solana)
  describe("PR6 rama Solana (HU-SOL-8)", () => {
    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_VM", "solana");
    });

    it("AC-3: vm=solana + PAYOUT_POP_SECRET unset ⇒ 503 payout_pop_unavailable, NINGÚN fetch (jamás skip)", async () => {
      vi.stubEnv("PAYOUT_POP_SECRET", ""); // OBLIGATORIO en Solana: sin secreto → 503 fail-closed
      const res = await POST(req(bodyOf({ address: SOL_ADDR }))); // base58 pasa PR4; vm=solana ⇒ PR6 exige PoP
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "payout_pop_unavailable" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("AC-3: vm=solana + secreto presente + sin popChallenge/popSignature ⇒ 403 payout_pop_unverified, NINGÚN fetch", async () => {
      vi.stubEnv("PAYOUT_POP_SECRET", "pop-secret");
      const res = await POST(req(bodyOf({ address: SOL_ADDR }))); // sin campos PoP
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "payout_pop_unverified" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ── HU-SOL-11: rama Solana del BLOQUE DE RESPUESTA (PR8-PR11). vm=solana + PoP ed25519 REAL válido
  //    (OBLIGATORIO en Solana) → 200 con el shape del gateway {beneficiary,authority,attestation,
  //    payoutId,provenance} base58. La atestación es REAL (verifica con verifySolanaDepositAttestation).
  //    beneficiary = deposit-address base58 del agente; caller.address = pubkey del keypair que firma PR6. ──
  describe("rama Solana de respuesta (HU-SOL-11)", () => {
    const SOL_BENEFICIARY = "So11111111111111111111111111111111111111112"; // base58 válido (== SOL_ADDR)
    let kp: nacl.SignKeyPair;
    let callerAddr: string;
    let authorityPubkey: string;
    beforeEach(() => {
      kp = nacl.sign.keyPair();
      callerAddr = bs58.encode(kp.publicKey); // pubkey del firmante = address del caller (P3)
      authorityPubkey = bs58.encode(nacl.sign.keyPair().publicKey); // CD-10: NUNCA base58 a mano
      vi.stubEnv("NEXT_PUBLIC_VM", "solana");
      vi.stubEnv("PAYOUT_POP_SECRET", "pop-secret"); // OBLIGATORIO en Solana para pasar PR6
      vi.stubEnv("SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY", authorityPubkey);
    });

    it("AC-1: vm=solana + PoP válido + depositAddress base58 → 200 shape Solana; la atestación VERIFICA", async () => {
      agentResponds(200, agentResult({ depositAddress: SOL_BENEFICIARY }));
      const res = await POST(
        req(bodyOf({ address: callerAddr, ...signedSolanaPop(kp, callerAddr) })),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      // Shape EXACTO de isValidSolanaPrepareShape (http-solana-prepare-gateway.ts:48).
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
      // NUNCA ecoa PII del beneficiary ni la BASE (CD-5).
      const raw = JSON.stringify(json);
      expect(raw).not.toContain("Mamá");
      expect(raw).not.toContain("999888777");
      expect(raw).not.toContain("agents.test");
    });

    it("AC-2: vm=solana + authority env ausente/malformada → 503 prepare_solana_authority_unavailable", async () => {
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

    it("AC-3: vm=solana + depositAddress null / no-base58 → 502 prepare_no_deposit_address", async () => {
      for (const bad of [null, "0xNOT_BASE58"]) {
        agentResponds(200, agentResult({ depositAddress: bad }));
        const res = await POST(
          req(bodyOf({ address: callerAddr, ...signedSolanaPop(kp, callerAddr) })),
        );
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: "prepare_no_deposit_address" });
      }
    });

    it("AC-3: vm=solana + depositAddress base58 válido pero payoutId ausente (vacío/whitespace) → 502 prepare_no_deposit_address (guard route.ts:272-275)", async () => {
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
  // circunstancia, terminar creando la orden por el camino punto-a-punto.
  describe("rama a2a-gateway de PR7 (WKH-304)", () => {
    const GW = "https://gateway.test";
    const GW_KEY = "ak_prepare_secret";
    const AGENT_URL = "https://agents.test/api/agents/remit-cashout-payout/invoke";

    function setGatewayEnv() {
      vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a-gateway");
      vi.stubEnv("WASIAI_A2A_GATEWAY_URL", GW);
      vi.stubEnv("WASIAI_A2A_AGENT_KEY", GW_KEY);
      // REMIT_AGENTS_BASE_URL sigue seteada por el beforeEach raíz: PR1 la exige byte-idéntico
      // (DT-A2A-9) aunque el forward ya no la use para el transporte.
    }

    /** Router de fetch: separa el /compose del gateway del fetch DIRECTO al agente.
     *  agentCalls.length > 0 ⇒ hubo fallback punto-a-punto (prohibido, CD-1). */
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
        agentCalls.push(url); // el punto-a-punto que NUNCA debe ocurrir en modo gateway
        return new Response(JSON.stringify({ result: agentResult() }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      return { agentCalls };
    }

    it("T-A3.1: prepare feliz por gateway ⇒ 200 con depositAddress + attestation que VERIFICA; nunca el agente directo", async () => {
      setGatewayEnv();
      const { agentCalls } = gwRouter();
      const res = await POST(req(bodyOf()));
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.depositAddress).toBe(DEPOSIT);
      expect(json.payoutId).toBe("transfi-po-1");
      // PR9 sigue siendo el ÚNICO emisor: la atestación es REAL y ata la dirección a ESTA remesa.
      const att = verifyDepositAttestation(json.attestation as string, Date.now());
      expect(att).not.toBeNull();
      expect(att?.remittanceId).toBe("rem-1");
      expect(att?.quoteId).toBe("q-400");
      expect(att?.depositAddress).toBe(DEPOSIT);
      expect(att?.chainId).toBe(84532); // de la ENV server-side, no del body
      // El transporte fue el gateway y SÓLO el gateway.
      const urls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(urls).toEqual([`${GW}/compose`]);
      expect(agentCalls).toHaveLength(0);
      // Ni la URL del gateway ni la del agente ni el PII salen en la respuesta (CD-5/CD-8).
      const raw = JSON.stringify(json);
      expect(raw).not.toContain(GW);
      expect(raw).not.toContain("agents.test");
      expect(raw).not.toContain("999888777");
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

      // PR6 — PoP.
      vi.stubEnv("PAYOUT_POP_SECRET", "pop-secret");
      const rPop = await POST(req(bodyOf()));
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
    it("T-A3.4 ANTI-FALLBACK: 422 / 503 / throw del gateway ⇒ 502 prepare_upstream_error, CERO llamadas al agente, CERO ledger, body = { error }", async () => {
      setGatewayEnv();
      getLedgerMock.mockReturnValue(ledgerMock);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const cases: { label: string; opts: Parameters<typeof gwRouter>[0] }[] = [
        {
          label: "422 no_agent_match (nadie cumple la capacidad con el piso)",
          opts: {
            status: 422,
            body: { error: "no candidates", code: "no_agent_match", reason: "no_candidates", step: 0 },
          },
        },
        {
          label: "503 registry_unavailable",
          opts: { status: 503, body: { error: "registry down", error_code: "REGISTRY_UNAVAILABLE" } },
        },
        { label: "throw de red", opts: { composeThrows: true } },
      ];
      for (const c of cases) {
        const { agentCalls } = gwRouter(c.opts);
        const res = await POST(req(bodyOf()));
        expect(res.status, c.label).toBe(502);
        const json = (await res.json()) as Record<string, unknown>;
        expect(json, c.label).toEqual({ error: "prepare_upstream_error" });
        // CD-8: el body es EXACTAMENTE { error } — ni detail, ni code, ni el message del gateway.
        expect(Object.keys(json), c.label).toEqual(["error"]);
        // CD-1: jamás se creó la orden por el otro camino.
        expect(agentCalls, c.label).toHaveLength(0);
        expect(
          fetchMock.mock.calls.map((x) => x[0] as string).includes(AGENT_URL),
          c.label,
        ).toBe(false);
      }
      // Y no se escribió NADA en el ledger: sin orden no hay fila que reconciliar después.
      expect(ledgerMock.recordOrderPrepared).not.toHaveBeenCalled();
    });

    it("T-A3.5: rama Solana en modo gateway ⇒ base58 atesta (verifica de verdad); una address EVM muere en PR8 (residual R-3)", async () => {
      const kp = nacl.sign.keyPair();
      const callerAddr = bs58.encode(kp.publicKey);
      const authorityPubkey = bs58.encode(nacl.sign.keyPair().publicKey);
      const SOL_BENEFICIARY = "So11111111111111111111111111111111111111112";
      setGatewayEnv();
      vi.stubEnv("NEXT_PUBLIC_VM", "solana");
      vi.stubEnv("PAYOUT_POP_SECRET", "pop-secret");
      vi.stubEnv("SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY", authorityPubkey);

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
      // resolver al agente EVM y devolver una address no-base58. PR8 es VM-discriminado y corta ANTES
      // de atestar. El arreglo real es de catálogo, no de código cliente.
      gwRouter({ output: agentResult({ depositAddress: DEPOSIT }) }); // 0x… en vm=solana
      const bad = await POST(req(bodyOf({ address: callerAddr, ...signedSolanaPop(kp, callerAddr) })));
      expect(bad.status).toBe(502);
      const badJson = (await bad.json()) as Record<string, unknown>;
      expect(badJson).toEqual({ error: "prepare_no_deposit_address" });
      expect(badJson).not.toHaveProperty("attestation");
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
    it("T-A5.2: el piso NO reemplaza a PR8 — depositAddress inválido da el MISMO 502 con el flag encendido que apagado", async () => {
      // (a) flag apagado (camino punto-a-punto de siempre)
      agentResponds(200, agentResult({ depositAddress: "0xNOT_AN_ADDRESS" }));
      const off = await POST(req(bodyOf()));
      const offJson = await off.json();

      // (b) flag encendido, con el piso viajando en el step
      setGatewayEnv();
      gwRouter({ output: agentResult({ depositAddress: "0xNOT_AN_ADDRESS" }) });
      const on = await POST(req(bodyOf()));
      const onJson = await on.json();

      expect(off.status).toBe(502);
      expect(on.status).toBe(off.status);
      expect(onJson).toEqual(offJson);
      expect(onJson).toEqual({ error: "prepare_no_deposit_address" });
    });

    // T-A5.2b — espejo del anterior con el SHAPE roto en vez de la dirección rota. isValidPayoutResult
    // es lo único que exige `status ∈ {submitted,settled,failed,blocked}`, y después de PR8 nadie
    // vuelve a mirar `status`. El gate corre para las DOS ramas de transporte; sin este test se podía
    // desactivarlo sólo en la de gateway y la suite entera quedaba verde — justo en el transporte
    // donde el que responde ya no es una URL fija sino el agente que eligió el gateway.
    it("T-A5.2b: shape inválido del result da el MISMO 502 prepare_upstream_error con el flag encendido que apagado, y NUNCA atesta", async () => {
      // (a) flag apagado (camino punto-a-punto de siempre)
      agentResponds(200, agentResult({ status: "weird" }));
      const off = await POST(req(bodyOf()));
      const offJson = (await off.json()) as Record<string, unknown>;

      // (b) flag encendido: el gate de shape tiene que correr IGUAL en la rama de gateway
      setGatewayEnv();
      gwRouter({ output: agentResult({ status: "weird" }) });
      const on = await POST(req(bodyOf()));
      const onJson = (await on.json()) as Record<string, unknown>;

      expect(off.status).toBe(502);
      expect(on.status).toBe(off.status);
      expect(onJson).toEqual(offJson);
      expect(onJson).toEqual({ error: "prepare_upstream_error" });
      expect(onJson).not.toHaveProperty("attestation");
    });

    // T-A4.1 (mitad P) — "construye, no enciende": con el flag ≠ a2a-gateway el gateway se ignora
    // aunque sus envs estén seteadas. El assert es sobre /compose (con el discovery borrado, asertar
    // que no se llama a /discover pasa trivialmente y deja de proteger nada).
    it.each(["fallback", "a2a", undefined])(
      "T-A4.1: flag=%s + WASIAI_A2A_* seteadas ⇒ gateway IGNORADO (fetch al agente punto-a-punto)",
      async (flag) => {
        if (flag === undefined) vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "");
        else vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", flag);
        vi.stubEnv("WASIAI_A2A_GATEWAY_URL", GW); // seteadas, pero NO deben usarse
        vi.stubEnv("WASIAI_A2A_AGENT_KEY", GW_KEY);
        const { agentCalls } = gwRouter();
        const res = await POST(req(bodyOf()));
        expect(res.status).toBe(200);
        const urls = fetchMock.mock.calls.map((c) => c[0] as string);
        expect(urls.some((u) => u.includes("/compose"))).toBe(false);
        expect(agentCalls).toEqual([AGENT_URL]);
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
  });
});
