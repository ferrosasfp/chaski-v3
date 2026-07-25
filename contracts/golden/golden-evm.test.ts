// WKH-227 / HU-SOL-24 — GOLDEN EVM (AC-4). Congela la serialización EXACTA de 4 payloads EVM para un
// INPUT FIJO determinístico (§6.1). Un byte que cambie ⇒ ROJO. Los golden se GENERAN del código
// (UPDATE_GOLDEN=1 npm test -- contracts/golden/golden-evm.test.ts), NUNCA se editan a mano (CD-4).
//   #1 EIP-712 typed-data (params[1] de eth_signTypedData_v4)  → eip712-transfer-with-authorization.golden.json
//   #2 eip3009.authorization serializada                        → eip3009-authorization.golden.json
//   #3 body /settle EIP-3009 (== contract test #8)              → settle-eip3009-body.golden.json
//   #4 issueDepositAttestation (string b64url.b64url)           → deposit-attestation.golden.txt
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { broadcastSettle } from "../../src/infrastructure/settlement/facilitator-client";
import type { SettleBroadcastInput } from "../../src/infrastructure/settlement/facilitator-client";
import { issueDepositAttestation } from "../../src/infrastructure/settlement/deposit-attestation";
import { InjectedWallet } from "../../src/infrastructure/wallet";
import { resolveUsdcAddress } from "../../src/infrastructure/chain";
import { Money } from "../../src/domain/money";
import type { Quote } from "../../src/domain/remittance";

// ── Fixture determinístico (§6.1) ────────────────────────────────────────────────────────────────
const REMITTANCE_ID = "rmt_fixed_0001";
const QUOTE_ID = "q_fixed_0001";
const FROM = "0xf39fd6e51aad88f6f4ce6ab8827279cffFb92266"; // hardhat acct#0 (viem checksumea)
const DEPOSIT_ADDR = "0x1111111111111111111111111111111111111111";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // USDC Base Sepolia (checksum)
const EXPIRES_AT = "2030-01-01T00:00:00.000Z"; // → validBefore = 1893456000
const CHAIN_84532_HEX = "0x14a34"; // 84532 → evita wallet_switchEthereumChain
const DEPOSIT_SECRET = "golden-fixed-secret";
const EXP = 1893456000; // epoch SEG fijo (NO Date.now())

const GOLDEN_DIR = path.resolve(process.cwd(), "contracts/golden");

// Generación/verificación (CD-4): UPDATE_GOLDEN → write; si no → read + compare. NUNCA a mano.
function goldenJson(fileName: string, generated: unknown): void {
  const file = path.join(GOLDEN_DIR, fileName);
  if (process.env.UPDATE_GOLDEN) {
    writeFileSync(file, `${JSON.stringify(generated, null, 2)}\n`, "utf8");
    return;
  }
  const frozen: unknown = JSON.parse(readFileSync(file, "utf8"));
  expect(generated).toEqual(frozen);
}
function goldenText(fileName: string, generated: string): void {
  const file = path.join(GOLDEN_DIR, fileName);
  if (process.env.UPDATE_GOLDEN) {
    writeFileSync(file, generated, "utf8");
    return;
  }
  expect(generated).toBe(readFileSync(file, "utf8"));
}

interface ProviderCall {
  method: string;
  params?: unknown;
}
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
function typedDataJsonOf(calls: ProviderCall[]): unknown {
  const call = calls.find((c) => c.method === "eth_signTypedData_v4");
  if (!call) throw new Error("eth_signTypedData_v4 not called");
  const params = call.params as unknown[];
  const raw = params[1];
  if (typeof raw !== "string") throw new Error("typed-data param[1] not a string");
  return JSON.parse(raw); // viem serializa bigints → decimal string (CD-12)
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

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("golden EVM (AC-4) — serialización congelada, byte-idéntica", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS", USDC);
    vi.stubEnv("FACILITATOR_BASE_URL", "https://fac.test");
    vi.stubEnv("FACILITATOR_API_KEY", "k");
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", DEPOSIT_SECRET);
  });

  it("golden #1 + #2: EIP-712 typed-data + eip3009.authorization", async () => {
    const p = makeProvider();
    stubWindow(p);
    const w = new InjectedWallet();
    await w.connect();
    const res = await w.authorizePrincipal(fixedQuote, REMITTANCE_ID, { address: DEPOSIT_ADDR });
    if (!res.eip3009) throw new Error("expected eip3009 authorization");

    goldenJson("eip712-transfer-with-authorization.golden.json", typedDataJsonOf(p.calls));
    goldenJson("eip3009-authorization.golden.json", res.eip3009.authorization);
  });

  it("golden #3: body /settle EIP-3009 (mismo input que el contract test #8)", async () => {
    const p = makeProvider();
    stubWindow(p);
    const w = new InjectedWallet();
    await w.connect();
    const res = await w.authorizePrincipal(fixedQuote, REMITTANCE_ID, { address: DEPOSIT_ADDR });
    if (!res.eip3009) throw new Error("expected eip3009 authorization");
    const input: SettleBroadcastInput = {
      authorization: res.eip3009.authorization,
      signature: `0x${"ab".repeat(65)}`,
      payTo: DEPOSIT_ADDR,
      asset: resolveUsdcAddress(),
      chainId: 84532,
      amountMinor: "400000000",
      resourceUrl: "https://chaski.example/api/settle",
    };
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
    await broadcastSettle(input);
    goldenJson("settle-eip3009-body.golden.json", JSON.parse(captured));
  });

  it("golden #4: issueDepositAttestation (string exacto)", () => {
    const token = issueDepositAttestation({
      remittanceId: REMITTANCE_ID,
      quoteId: QUOTE_ID,
      depositAddress: DEPOSIT_ADDR,
      chainId: 84532,
      exp: EXP,
    });
    goldenText("deposit-attestation.golden.txt", token);
  });
});
