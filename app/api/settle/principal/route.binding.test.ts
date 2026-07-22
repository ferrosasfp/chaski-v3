// Tests — POST /api/settle/principal en MODO DEPOSIT-FLOW (WKH-211 W3.1). El guard B1-B6 ata el `to`
// firmado al depositAddress ATESTADO por HMAC. ATAQUE AC-3 (7 vectores): un `to` que NO coincide con la
// atestación se rechaza SIN transmitir ni verificar nada on-chain.
//
// broadcastSettle + verifySettlementOnChain se mockean con SPIES: en cada vector se assert que NINGUNO
// se llamó (rechazo PRE-broadcast). La DepositAttestation se emite REAL (HMAC de verdad).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { broadcastMock, isConfiguredMock } = vi.hoisted(() => ({
  broadcastMock: vi.fn(),
  isConfiguredMock: vi.fn(),
}));
vi.mock("../../../../src/infrastructure/settlement/facilitator-client", () => ({
  broadcastSettle: broadcastMock,
  isBroadcasterConfigured: isConfiguredMock,
}));

const { verifyMock } = vi.hoisted(() => ({ verifyMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/settlement/onchain-verifier", () => ({
  verifySettlementOnChain: verifyMock,
}));

// Ledger apagado (byte-idéntico): el binding no lo toca (es post-V9).
vi.mock("../../../../src/infrastructure/persistence/supabase-settlement-ledger", () => ({
  getSettlementLedger: () => null,
}));

import {
  type DepositAttestation,
  issueDepositAttestation,
} from "../../../../src/infrastructure/settlement/deposit-attestation";
import { verifySettlementAttestation } from "../../../../src/infrastructure/settlement/attestation";
import { POST } from "./route";

const RECEIVER = "0x2222222222222222222222222222222222222222";
const SENDER = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "0x4444444444444444444444444444444444444444"; // depositAddress atestado (el `to` legítimo)
const ATTACKER = "0x3333333333333333333333333333333333333333";
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const TX = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
const NONCE = "0xbbbb000000000000000000000000000000000000000000000000000000000002";
const VALUE = 400_000_000;

function attPayload(over: Partial<DepositAttestation> = {}): DepositAttestation {
  return {
    remittanceId: "rem-1",
    quoteId: "q-400",
    depositAddress: DEPOSIT,
    chainId: 84532,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...over,
  };
}
function authorization(over: Record<string, unknown> = {}) {
  return {
    from: SENDER,
    to: DEPOSIT, // por default el `to` firmado ES el depositAddress atestado (happy)
    value: String(VALUE),
    validAfter: "0",
    validBefore: "1783036800",
    nonce: NONCE,
    ...over,
  };
}
function body(over: Record<string, unknown> = {}) {
  return {
    authorization: authorization(),
    signature: "0xdeadbeef",
    address: SENDER,
    quoteId: "q-400",
    expectedValueMinor: VALUE,
    remittanceId: "rem-1",
    depositAttestation: issueDepositAttestation(attPayload()),
    ...over,
  };
}
function req(payload: unknown): Request {
  return new Request("https://chaski.test/api/settle/principal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/settle/principal — modo deposit-flow (WKH-211, B1-B6)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS", RECEIVER);
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS", USDC);
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "84532");
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", "settle-secret");
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "deposit-secret"); // ACTIVA el modo deposit-flow
    isConfiguredMock.mockReset();
    isConfiguredMock.mockReturnValue(true);
    broadcastMock.mockReset();
    broadcastMock.mockResolvedValue({ ok: true, txHash: TX });
    verifyMock.mockReset();
    verifyMock.mockResolvedValue({ ok: true, txHash: TX, from: SENDER, to: DEPOSIT, valueMinor: VALUE });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // ── Happy path (AC-1) ──────────────────────────────────────────────────────
  it("AC-1: binding válido ⇒ expectedTo = att.depositAddress a V1-V9 ⇒ 200 + settlement-attestation", async () => {
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    // El verificador recibió el depositAddress atestado como expectedTo (NO el receiver estático).
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(verifyMock.mock.calls[0]![0]).toEqual({
      txHash: TX,
      expectedFrom: SENDER,
      expectedTo: DEPOSIT,
      expectedValueMinor: VALUE,
    });
    // El broadcast también fue al depositAddress atestado.
    expect(broadcastMock.mock.calls[0]![0].payTo).toBe(DEPOSIT);
    const json = (await res.json()) as { attestation: string; to: string };
    expect(json.to).toBe(DEPOSIT);
    expect(verifySettlementAttestation(json.attestation, Date.now())).not.toBeNull();
  });

  // ── ATAQUE AC-3 — 7 vectores. En TODOS: broadcast NO llamado + verify NUNCA llamado + 400. ─────────
  it("(a) B6: `to` firmado ≠ att.depositAddress ⇒ 400 settle_receiver_mismatch, SIN broadcast ni verify", async () => {
    const res = await POST(req(body({ authorization: authorization({ to: ATTACKER }) })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "settle_receiver_mismatch" });
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("(b) B3: atestación de OTRO remittanceId ⇒ 400, SIN broadcast ni verify", async () => {
    const forgedAtt = issueDepositAttestation(attPayload({ remittanceId: "rem-OTRO" }));
    const res = await POST(req(body({ depositAttestation: forgedAtt })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "settle_binding_invalid" });
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("(c) B4: atestación de OTRO quoteId ⇒ 400, SIN broadcast ni verify", async () => {
    const forgedAtt = issueDepositAttestation(attPayload({ quoteId: "q-OTRO" }));
    const res = await POST(req(body({ depositAttestation: forgedAtt })));
    expect(res.status).toBe(400);
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("(d) B5: atestación de OTRO chainId ⇒ 400, SIN broadcast ni verify", async () => {
    const forgedAtt = issueDepositAttestation(attPayload({ chainId: 1 }));
    const res = await POST(req(body({ depositAttestation: forgedAtt })));
    expect(res.status).toBe(400);
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("(e) B2: HMAC forjado / sin el secreto correcto ⇒ 400, SIN broadcast ni verify", async () => {
    const valid = issueDepositAttestation(attPayload());
    const [p] = valid.split(".");
    const tampered = `${p}.ZZZZ`; // MAC corrupto
    const res = await POST(req(body({ depositAttestation: tampered })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "settle_binding_invalid" });
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("(f) B2: atestación vencida ⇒ 400, SIN broadcast ni verify", async () => {
    const expired = issueDepositAttestation(attPayload({ exp: Math.floor(Date.now() / 1000) - 1 }));
    const res = await POST(req(body({ depositAttestation: expired })));
    expect(res.status).toBe(400);
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("(g) B1: atestación ausente en modo deposit-flow ⇒ 400 settle_binding_missing, SIN broadcast ni verify", async () => {
    const noAtt = body();
    delete (noAtt as Record<string, unknown>).depositAttestation;
    const res = await POST(req(noAtt));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "settle_binding_missing" });
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });
});

// ── T6 (HU-SOL-9 / WKH-208, AC-4/AC-5): vm=solana fail-closed pre-broadcast (CD-5) ──
// NOTA (Auto-Blindaje HU-SOL-9): addressEquals NO se exporta (Next.js valida los exports de un
// route.ts contra los handlers → un export extra rompe tsc/.next/types). Además su rama Solana es
// forward-looking: el settle Solana completo (resolver receiver/att Solana-aware) es HU-SOL-13, así
// que la rama Solana de B6/S12/S13 no es alcanzable end-to-end vía la route en ESTA HU. Lo que SÍ se
// prueba acá: en vm=solana un `to` base58 fail-closea PRE-broadcast (CD-5, ningún fetch). La igualdad
// canónica base58 en sí está cubierta por address.test.ts (canonicalizeAddress). El path EVM de
// addressEquals lo ejercitan los 8 tests B1-B6 de arriba (byte-idéntico, AC-2).
const SOL_BENEFICIARY = "So11111111111111111111111111111111111111112"; // base58 pubkey
const SOL_OTHER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // base58 pubkey distinta

describe("POST /api/settle/principal — vm=solana fail-closed pre-broadcast (HU-SOL-9, CD-5)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS", RECEIVER);
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS", USDC);
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "84532");
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", "settle-secret");
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "deposit-secret");
    vi.stubEnv("NEXT_PUBLIC_VM", "solana"); // dark: activa la rama Solana
    isConfiguredMock.mockReset();
    isConfiguredMock.mockReturnValue(true);
    broadcastMock.mockReset();
    broadcastMock.mockResolvedValue({ ok: true, txHash: TX });
    verifyMock.mockReset();
    verifyMock.mockResolvedValue({ ok: true, txHash: TX, from: SENDER, to: DEPOSIT, valueMinor: VALUE });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("un `to` base58 en vm=solana fail-closea PRE-broadcast (NUNCA broadcastSettle/verify, sin fetch)", async () => {
    // La orquestación completa del settle Solana es HU-SOL-13; esta HU sólo deja B6/S12/S13 VM-safe.
    // El guard EIP-3009 (S5) fail-closea el `to` base58 ANTES de cualquier red (CD-5).
    const solBody = body({
      authorization: authorization({ to: SOL_BENEFICIARY, from: SOL_OTHER }),
      address: SOL_OTHER,
    });
    const res = await POST(req(solBody));
    expect(res.status).toBe(400);
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });
});
