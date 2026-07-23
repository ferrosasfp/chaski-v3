// WKH-227 / HU-SOL-24 — contract test (AC-1). El body EIP-3009 que arma broadcastSettle() para un
// INPUT FIJO determinístico DEBE ser byte-idéntico al fixture VENDOREADO del provider /settle. Si el
// facilitator agrega un campo requerido y se re-vendorea, el body no lo incluye → toEqual mismatch → ROJO.
// DOBLE USO: este mismo fixedSettleInput y su body son el golden #3 (contracts/golden/golden-evm.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { broadcastSettle } from "../src/infrastructure/settlement/facilitator-client";
import type { SettleBroadcastInput } from "../src/infrastructure/settlement/facilitator-client";
import { InjectedWallet } from "../src/infrastructure/wallet";
import { resolveUsdcAddress } from "../src/infrastructure/chain";
import { Money } from "../src/domain/money";
import type { Quote } from "../src/domain/remittance";
import { settleVendoredFixture } from "./vendored/settle-eip3009.body.fixture";

// ── Fixture determinístico compartido (§6.1 del Story File) ──────────────────────────────────────
const REMITTANCE_ID = "rmt_fixed_0001";
const QUOTE_ID = "q_fixed_0001";
const FROM = "0xf39fd6e51aad88f6f4ce6ab8827279cffFb92266"; // hardhat acct#0 (viem checksumea)
const DEPOSIT_ADDR = "0x1111111111111111111111111111111111111111";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // USDC Base Sepolia (checksum)
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";
const CHAIN_84532_HEX = "0x14a34"; // 84532 → evita wallet_switchEthereumChain

interface ProviderCall {
  method: string;
  params?: unknown;
}
// Provider EIP-1193 fake (patrón wallet.test.ts:42-65, replicado — no se exporta hoy).
function makeProvider() {
  const calls: ProviderCall[] = [];
  const request = vi.fn(async (args: { method: string; params?: unknown }): Promise<unknown> => {
    calls.push({ method: args.method, params: args.params });
    switch (args.method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [FROM];
      case "eth_chainId":
        return CHAIN_84532_HEX;
      case "eth_signTypedData_v4":
        return "0xtypedsig";
      default:
        throw new Error(`unhandled:${args.method}`);
    }
  });
  return { request, calls };
}

function stubWindow(provider: unknown): void {
  (globalThis as { window?: { ethereum?: unknown } }).window = { ethereum: provider };
}

const fixedQuote: Quote = {
  quoteId: QUOTE_ID,
  send: Money.of(400, "USDC"), // minor = 400_000000
  receive: Money.of(1480, "PEN"),
  feeUsd: Money.of(0.5, "USDC"),
  rate: 3.7,
  etaMinutes: 30,
  expiresAt: EXPIRES_AT,
  provenance: "golden",
};

/** Arma el SettleBroadcastInput fijo (authorization = firma EIP-3009 real determinística). */
async function buildFixedSettleInput(): Promise<SettleBroadcastInput> {
  const p = makeProvider();
  stubWindow(p);
  const w = new InjectedWallet();
  await w.connect();
  const res = await w.authorizePrincipal(fixedQuote, REMITTANCE_ID, { address: DEPOSIT_ADDR });
  if (!res.eip3009) throw new Error("expected eip3009 authorization");
  return {
    authorization: res.eip3009.authorization,
    signature: `0x${"ab".repeat(65)}`, // sig de shape (INPUT del broadcast; ver CD-4 en el fixture)
    payTo: DEPOSIT_ADDR,
    asset: resolveUsdcAddress(),
    chainId: 84532,
    amountMinor: "400000000",
    resourceUrl: "https://chaski.example/api/settle",
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("contract settle (AC-1) — body de broadcastSettle vs fixture vendoreado", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS", USDC);
    vi.stubEnv("FACILITATOR_BASE_URL", "https://fac.test");
    vi.stubEnv("FACILITATOR_API_KEY", "k");
  });

  it("body EIP-3009 == fixture vendoreado (toEqual)", async () => {
    const input = await buildFixedSettleInput();
    let captured = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        captured = init.body;
        return new Response(JSON.stringify({ settled: true, transactionHash: `0x${"11".repeat(32)}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const result = await broadcastSettle(input);
    expect(result.ok).toBe(true);
    expect(JSON.parse(captured)).toEqual(settleVendoredFixture);
  });
});
