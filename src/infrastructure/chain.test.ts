import { afterEach, describe, expect, it } from "vitest";
import { resolveChain, resolveChainId, resolveNetworkConfig, resolveUsdcAddress } from "./chain";

// AC-7: NEXT_PUBLIC_CHAIN_ID es la única fuente del chainId; default fail-safe 84532 (Base Sepolia
// testnet — DT-5: jamás mainnet real). Solo Base mainnet (8453) / Base Sepolia (84532) soportados.
const ENV = "NEXT_PUBLIC_CHAIN_ID";

afterEach(() => {
  delete process.env[ENV];
  delete process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS;
});

describe("resolveChainId / resolveChain — chain env-driven (AC-1/2/3, CD-5)", () => {
  it('AC-3: unset → 84532 (Base Sepolia, fail-safe testnet — NUNCA Avalanche, NUNCA mainnet)', () => {
    delete process.env[ENV];
    expect(resolveChainId()).toBe(84532);
    expect(resolveChain().id).toBe(84532);
    expect(resolveChainId()).not.toBe(43113);
    expect(resolveChainId()).not.toBe(43114);
    expect(resolveChainId()).not.toBe(8453);
  });

  it('AC-1: "84532" → Base Sepolia', () => {
    process.env[ENV] = "84532";
    expect(resolveChainId()).toBe(84532);
    expect(resolveChain().id).toBe(84532);
  });

  it('AC-2: "8453" → Base mainnet', () => {
    process.env[ENV] = "8453";
    expect(resolveChainId()).toBe(8453);
    expect(resolveChain().id).toBe(8453);
  });

  it('AC-3: "99" (red no soportada) → 84532 (fail-safe)', () => {
    process.env[ENV] = "99";
    expect(resolveChainId()).toBe(84532);
    expect(resolveChain().id).toBe(84532);
  });

  it('AC-3: basura ("abc") → 84532 (fail-safe)', () => {
    process.env[ENV] = "abc";
    expect(resolveChainId()).toBe(84532);
    expect(resolveChain().id).toBe(84532);
  });

  it('AC-3: "43113" (Avalanche Fuji, ya no soportada) → 84532 (jamás 43113)', () => {
    process.env[ENV] = "43113";
    expect(resolveChainId()).toBe(84532);
    expect(resolveChainId()).not.toBe(43113);
  });

  it('AC-3: "43114" (Avalanche mainnet, ya no soportada) → 84532 (jamás 43114/8453)', () => {
    process.env[ENV] = "43114";
    expect(resolveChainId()).toBe(84532);
    expect(resolveChainId()).not.toBe(43114);
    expect(resolveChainId()).not.toBe(8453);
  });
});

describe("resolveNetworkConfig — USDC canónico + domain EIP-712 por red (AC-7, CD-4)", () => {
  it("Base Sepolia: canonicalUsdc + eip712 name/version matchean el facilitator", () => {
    process.env[ENV] = "84532";
    const cfg = resolveNetworkConfig();
    expect(cfg.chainId).toBe(84532);
    expect(cfg.canonicalUsdc).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(cfg.eip712.name).toBe("USDC"); // testnet USDC usa "USDC", NO "USD Coin"
    expect(cfg.eip712.version).toBe("2");
    expect(cfg.rpcEnvVar).toBe("BASE_SEPOLIA_RPC_URL");
  });

  it("Base mainnet: canonicalUsdc + eip712 name/version matchean el facilitator", () => {
    process.env[ENV] = "8453";
    const cfg = resolveNetworkConfig();
    expect(cfg.chainId).toBe(8453);
    expect(cfg.canonicalUsdc).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(cfg.eip712.name).toBe("USD Coin");
    expect(cfg.eip712.version).toBe("2");
    expect(cfg.rpcEnvVar).toBe("BASE_MAINNET_RPC_URL");
  });
});

describe("resolveUsdcAddress — env-driven fail-loud (AC-7/AC-11, CD-8)", () => {
  it("env ausente → throw usdc_contract_not_configured", () => {
    delete process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS;
    expect(() => resolveUsdcAddress()).toThrow("usdc_contract_not_configured");
  });

  it("env malformada → throw usdc_contract_not_configured (fail-loud, no fallback)", () => {
    process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS = "0xNOT_AN_ADDRESS";
    expect(() => resolveUsdcAddress()).toThrow("usdc_contract_not_configured");
  });

  it("env bien formada → devuelve la address EXACTA (no canoniza ni fallbackea)", () => {
    process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
    expect(resolveUsdcAddress()).toBe("0x036cbd53842c5426634e7929541ec2318f3dcf7e");
  });
});
