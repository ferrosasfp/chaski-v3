// Tests — POST /api/settle/principal en MODO ESTÁTICO (WKH-211 regresión AC-5/AC-6). SIN
// DEPOSIT_ATTESTATION_SECRET el guard es el de WKH-168/209 BYTE-IDÉNTICO: S12 compara `to` contra el
// receiver de ENV y V1-V9 usa expectedTo = receiver. El campo depositAttestation del body se IGNORA.
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
vi.mock("../../../../src/infrastructure/persistence/supabase-settlement-ledger", () => ({
  getSettlementLedger: () => null,
}));

import { POST } from "./route";

const RECEIVER = "0x2222222222222222222222222222222222222222";
const SENDER = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x3333333333333333333333333333333333333333";
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const TX = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
const NONCE = "0xbbbb000000000000000000000000000000000000000000000000000000000002";
const VALUE = 400_000_000;

function body(over: Record<string, unknown> = {}, authOver: Record<string, unknown> = {}) {
  return {
    authorization: {
      from: SENDER,
      to: RECEIVER, // estático: el `to` firmado ES el receiver de ENV
      value: String(VALUE),
      validAfter: "0",
      validBefore: "1783036800",
      nonce: NONCE,
      ...authOver,
    },
    signature: "0xdeadbeef",
    address: SENDER,
    quoteId: "q-400",
    expectedValueMinor: VALUE,
    remittanceId: "rem-1",
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

describe("POST /api/settle/principal — modo estático (WKH-211 regresión AC-5/AC-6)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS", RECEIVER);
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS", USDC);
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "84532");
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", "settle-secret");
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", ""); // AUSENTE ⇒ modo estático
    isConfiguredMock.mockReset();
    isConfiguredMock.mockReturnValue(true);
    broadcastMock.mockReset();
    broadcastMock.mockResolvedValue({ ok: true, txHash: TX });
    verifyMock.mockReset();
    verifyMock.mockResolvedValue({ ok: true, txHash: TX, from: SENDER, to: RECEIVER, valueMinor: VALUE });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("AC-5/AC-6: sin DEPOSIT_ATTESTATION_SECRET ⇒ V1-V9 con expectedTo = receiver de ENV (byte-idéntico WKH-209)", async () => {
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(verifyMock.mock.calls[0]![0]).toEqual({
      txHash: TX,
      expectedFrom: SENDER,
      expectedTo: RECEIVER, // ENV, NO un depositAddress
      expectedValueMinor: VALUE,
    });
    expect(broadcastMock.mock.calls[0]![0].payTo).toBe(RECEIVER);
  });

  it("AC-6: S12 estático ⇒ `to` firmado ≠ receiver de ENV ⇒ 400 settle_receiver_mismatch, SIN broadcast", async () => {
    const res = await POST(req(body({}, { to: ATTACKER })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "settle_receiver_mismatch" });
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("AC-5: el campo depositAttestation del body se IGNORA en modo estático (no exige binding)", async () => {
    // Un depositAttestation basura NO cambia nada: el modo estático ni lo mira ⇒ 200 igual.
    const res = await POST(req(body({ depositAttestation: "garbage.token" })));
    expect(res.status).toBe(200);
    expect(verifyMock.mock.calls[0]![0].expectedTo).toBe(RECEIVER);
  });
});
