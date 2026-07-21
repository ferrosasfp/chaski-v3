import { afterEach, describe, expect, it } from "vitest";
import {
  resolveActiveNetworkConfig,
  resolveActiveVm,
  resolveChain,
  resolveChainId,
  resolveNetworkConfig,
  resolveSolanaUsdcMint,
  resolveUsdcAddress,
} from "./chain";
import type { VmAuthorization } from "../application/ports";

// AC-7: NEXT_PUBLIC_CHAIN_ID es la única fuente del chainId; default fail-safe 84532 (Base Sepolia
// testnet — DT-5: jamás mainnet real). Solo Base mainnet (8453) / Base Sepolia (84532) soportados.
const ENV = "NEXT_PUBLIC_CHAIN_ID";

afterEach(() => {
  delete process.env[ENV];
  delete process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS;
  delete process.env.NEXT_PUBLIC_VM;
  delete process.env.NEXT_PUBLIC_SOLANA_USDC_MINT;
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

// ── Rama Solana (WKH-206 / HU-SOL-1) — tests NUEVOS, los 13 EVM de arriba intactos ──
const SOLANA_USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

describe("resolveActiveNetworkConfig — rama Solana (AC-2)", () => {
  it('NEXT_PUBLIC_VM="solana" → config vm:"solana" devnet, sin viemChain', () => {
    process.env.NEXT_PUBLIC_VM = "solana";
    const cfg = resolveActiveNetworkConfig();
    expect(cfg.vm).toBe("solana");
    if (cfg.vm === "solana") {
      expect(cfg.cluster).toBe("devnet");
      expect(cfg.usdcMintEnvVar).toBe("NEXT_PUBLIC_SOLANA_USDC_MINT");
      expect(cfg.rpcEnvVar).toBe("SOLANA_DEVNET_RPC_URL");
    }
    expect("viemChain" in cfg).toBe(false);
  });
});

describe("resolveSolanaUsdcMint — env-driven fail-loud (AC-3)", () => {
  it("mint base58 válido → devuelve el mint EXACTO", () => {
    process.env.NEXT_PUBLIC_SOLANA_USDC_MINT = SOLANA_USDC_DEVNET;
    expect(resolveSolanaUsdcMint()).toBe(SOLANA_USDC_DEVNET);
  });

  it("env ausente → throw solana_usdc_mint_not_configured", () => {
    delete process.env.NEXT_PUBLIC_SOLANA_USDC_MINT;
    expect(() => resolveSolanaUsdcMint()).toThrow("solana_usdc_mint_not_configured");
  });

  it('malformado ("0xNOT") → throw (fail-loud, no fallback)', () => {
    process.env.NEXT_PUBLIC_SOLANA_USDC_MINT = "0xNOT";
    expect(() => resolveSolanaUsdcMint()).toThrow("solana_usdc_mint_not_configured");
  });

  it("address EVM → RECHAZADA por el validador Solana (cruce prohibido CD-2)", () => {
    process.env.NEXT_PUBLIC_SOLANA_USDC_MINT = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    expect(() => resolveSolanaUsdcMint()).toThrow("solana_usdc_mint_not_configured");
  });
});

describe("VmAuthorization — discriminado por vm (AC-4)", () => {
  it('un valor { vm:"evm", ... } asigna a VmAuthorization y estrecha por vm', () => {
    const a: VmAuthorization = {
      vm: "evm",
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        value: "1",
        validAfter: "0",
        validBefore: "1",
        nonce: `0x${"0".repeat(64)}`,
      },
      signature: "0xsig",
    };
    expect(a.vm).toBe("evm");
    if (a.vm === "evm") {
      expect(a.authorization.from).toBe("0x0000000000000000000000000000000000000001");
    }
  });
});

describe("resolveActiveVm — default fail-safe (AC-5)", () => {
  it("NEXT_PUBLIC_VM unset → resolveActiveVm() === 'evm'", () => {
    delete process.env.NEXT_PUBLIC_VM;
    expect(resolveActiveVm()).toBe("evm");
  });
});

describe("resolveActiveVm / dispatcher — VM no soportada (AC-6)", () => {
  it('NEXT_PUBLIC_VM="aptos" → resolveActiveVm() throw unsupported_vm', () => {
    process.env.NEXT_PUBLIC_VM = "aptos";
    expect(() => resolveActiveVm()).toThrow("unsupported_vm");
  });

  it('NEXT_PUBLIC_VM="aptos" → resolveActiveNetworkConfig() propaga unsupported_vm', () => {
    process.env.NEXT_PUBLIC_VM = "aptos";
    expect(() => resolveActiveNetworkConfig()).toThrow("unsupported_vm");
  });
});
