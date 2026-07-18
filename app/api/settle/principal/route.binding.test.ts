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
