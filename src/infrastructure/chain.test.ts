import { afterEach, describe, expect, it } from "vitest";
import {
  resolveSolanaNetworkConfig,
  resolveSolanaReleaseAuthorityPubkey,
  resolveSolanaUsdcMint,
} from "./chain";

// WKH-320: este archivo probaba además el resolver de chainId EVM (default fail-safe 84532), la
// config de red de Base (canonicalUsdc + domain EIP-712), resolveUsdcAddress, el dispatcher
// resolveActiveNetworkConfig y resolveActiveVm. Todo eso se fue con la VM que describía.

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SOLANA_USDC_MINT;
  delete process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY;
});

const SOLANA_USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

describe("resolveSolanaNetworkConfig — config de la red activa (AC-2)", () => {
  it('devuelve la config vm:"solana" devnet, sin ningún objeto Chain de una lib EVM', () => {
    const cfg = resolveSolanaNetworkConfig();
    expect(cfg.vm).toBe("solana");
    expect(cfg.cluster).toBe("devnet");
    expect(cfg.usdcMintEnvVar).toBe("NEXT_PUBLIC_SOLANA_USDC_MINT");
    expect(cfg.rpcEnvVar).toBe("SOLANA_DEVNET_RPC_URL");
    expect("viemChain" in cfg).toBe(false);
    expect("chainId" in cfg).toBe(false);
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

// ── T3 (HU-SOL-9 / WKH-208, AC-4/AC-6): release-authority env-driven fail-loud ──
const RELEASE_AUTHORITY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // base58 pubkey válida

describe("resolveSolanaReleaseAuthorityPubkey — env-driven fail-loud (AC-4/AC-6)", () => {
  it("base58 válido → devuelve el pubkey EXACTO (jamás lee del body, case-sensitive)", () => {
    process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY = RELEASE_AUTHORITY;
    expect(resolveSolanaReleaseAuthorityPubkey()).toBe(RELEASE_AUTHORITY);
  });

  it("env ausente → throw solana_release_authority_not_configured", () => {
    delete process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY;
    expect(() => resolveSolanaReleaseAuthorityPubkey()).toThrow(
      "solana_release_authority_not_configured",
    );
  });

  it('malformado ("0xNOT") → throw (fail-loud, no fallback)', () => {
    process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY = "0xNOT";
    expect(() => resolveSolanaReleaseAuthorityPubkey()).toThrow(
      "solana_release_authority_not_configured",
    );
  });

  it("address EVM → RECHAZADA por el validador Solana (cruce prohibido CD-2)", () => {
    process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY =
      "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    expect(() => resolveSolanaReleaseAuthorityPubkey()).toThrow(
      "solana_release_authority_not_configured",
    );
  });
});
