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
});
