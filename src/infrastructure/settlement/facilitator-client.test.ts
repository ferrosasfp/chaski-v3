// Tests — facilitator-client (HU-SOL-9 / WKH-208). T4: verifySolanaSettlement construye el envelope
// x402 base58 que _parseSolanaInput del adaptador Solana espera (verify-only, sin mutar la rama
// EIP-3009). T5: regresión byte-idéntica de broadcastSettle (payload EIP-3009 intacto, AC-2).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  broadcastSettle,
  type SettleBroadcastInput,
  type SolanaSettleInput,
  verifySolanaSettlement,
} from "./facilitator-client";

const MINT = "So11111111111111111111111111111111111111112"; // base58 pubkey
const PAYTO = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // base58 pubkey
const REFERENCE = "SysvarRent111111111111111111111111111111111"; // base58 pubkey
const SIGNATURE = "5".repeat(88); // base58, longitud 88 ∈ [64,120] — shape de una tx sig Solana

function solanaInput(over: Partial<SolanaSettleInput> = {}): SolanaSettleInput {
  return {
    cluster: "devnet",
    mint: MINT,
    payTo: PAYTO,
    amountMinor: "400000000",
    signature: SIGNATURE,
    reference: REFERENCE,
    resourceUrl: "https://chaski.test/api/settle/principal",
    ...over,
  };
}

function mockFetchOnce(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("verifySolanaSettlement (HU-SOL-9, AC-3) — envelope base58 verify-only", () => {
  beforeEach(() => {
    vi.stubEnv("FACILITATOR_BASE_URL", "https://facilitator.test");
    vi.stubEnv("FACILITATOR_API_KEY", "test-key");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("construye el envelope solana:<cluster> base58 que _parseSolanaInput espera (sin authorization)", async () => {
    const fetchMock = mockFetchOnce(200, { settled: true, transactionHash: SIGNATURE });
    const result = await verifySolanaSettlement(solanaInput());
    expect(result).toEqual({ ok: true, signature: SIGNATURE });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://facilitator.test/settle");
    expect((init as RequestInit).method).toBe("POST");
    const sentBody = JSON.parse((init as { body: string }).body);
    expect(sentBody.x402Version).toBe(2);
    expect(sentBody.resource).toEqual({ url: "https://chaski.test/api/settle/principal" });
    expect(sentBody.accepted.scheme).toBe("exact");
    expect(sentBody.accepted.network).toBe("solana:devnet");
    expect(sentBody.accepted.amount).toBe("400000000");
    expect(sentBody.accepted.asset).toBe(MINT); // base58, NO 0x
    expect(sentBody.accepted.payTo).toBe(PAYTO); // base58, NO 0x
    expect(sentBody.accepted.maxTimeoutSeconds).toBe(60);
    expect(sentBody.accepted.extra).toBeUndefined(); // SIN assetTransferMethod (no aplica a SPL)
    expect(sentBody.payload.signature).toBe(SIGNATURE); // base58
    expect(sentBody.payload.reference).toBe(REFERENCE); // base58
    expect("authorization" in sentBody.payload).toBe(false); // NO objeto authorization EIP-3009
  });

  it("200 + signature base58 válida ⇒ { ok:true, signature }", async () => {
    mockFetchOnce(200, { settled: true, transactionHash: SIGNATURE });
    expect(await verifySolanaSettlement(solanaInput())).toEqual({ ok: true, signature: SIGNATURE });
  });

  it("200 con transactionHash 0x-hex (shape EVM) ⇒ settle_unverified (CD-9: NO regex 0x)", async () => {
    mockFetchOnce(200, { settled: true, transactionHash: `0x${"a".repeat(64)}` });
    expect(await verifySolanaSettlement(solanaInput())).toEqual({
      ok: false,
      reason: "settle_unverified",
    });
  });

  it("200 con settled!==true ⇒ settle_unverified", async () => {
    mockFetchOnce(200, { settled: false, transactionHash: SIGNATURE });
    expect(await verifySolanaSettlement(solanaInput())).toEqual({
      ok: false,
      reason: "settle_unverified",
    });
  });

  it("mapea 4xx/5xx vía mapStatus (400→rejected, 409→in_flight, 503→unavailable, 500→reverted)", async () => {
    const table: [number, string][] = [
      [400, "settle_rejected"],
      [401, "settle_rejected"],
      [403, "settle_rejected"],
      [409, "settle_in_flight"],
      [429, "settle_unavailable"],
      [503, "settle_unavailable"],
      [500, "settle_reverted"],
    ];
    for (const [status, reason] of table) {
      mockFetchOnce(status, {});
      expect(await verifySolanaSettlement(solanaInput())).toEqual({ ok: false, reason });
    }
  });

  it("fetch throw (timeout/DNS) ⇒ settle_unavailable (nunca throw)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifySolanaSettlement(solanaInput())).resolves.toEqual({
      ok: false,
      reason: "settle_unavailable",
    });
  });

  it("sin config (envs ausentes) ⇒ settle_unavailable, sin fetch", async () => {
    vi.stubEnv("FACILITATOR_BASE_URL", "");
    vi.stubEnv("FACILITATOR_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await verifySolanaSettlement(solanaInput())).toEqual({
      ok: false,
      reason: "settle_unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── T5 (AC-2): regresión byte-idéntica de broadcastSettle — payload EIP-3009 intacto ──
const EVM_TXHASH = `0x${"a".repeat(64)}`;
function evmInput(): SettleBroadcastInput {
  return {
    authorization: {
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      value: "400000000",
      validAfter: "0",
      validBefore: "1783036800",
      nonce: `0x${"b".repeat(64)}`,
    },
    signature: "0xdeadbeef",
    payTo: "0x2222222222222222222222222222222222222222",
    asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    chainId: 84532,
    amountMinor: "400000000",
    resourceUrl: "https://chaski.test/api/settle/principal",
  };
}

describe("broadcastSettle (regresión AC-2) — payload EIP-3009 byte-idéntico", () => {
  beforeEach(() => {
    vi.stubEnv("FACILITATOR_BASE_URL", "https://facilitator.test");
    vi.stubEnv("FACILITATOR_API_KEY", "test-key");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("construye el payload EIP-3009 exacto (eip155, extra.assetTransferMethod, authorization) y 200 ⇒ txHash", async () => {
    const fetchMock = mockFetchOnce(200, { settled: true, transactionHash: EVM_TXHASH });
    const input = evmInput();
    const result = await broadcastSettle(input);
    expect(result).toEqual({ ok: true, txHash: EVM_TXHASH });

    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse((init as { body: string }).body);
    expect(sentBody).toEqual({
      x402Version: 2,
      resource: { url: input.resourceUrl },
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        amount: "400000000",
        asset: input.asset,
        payTo: input.payTo,
        maxTimeoutSeconds: 60,
        extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
      },
      payload: {
        signature: input.signature,
        authorization: input.authorization,
      },
    });
  });
});
