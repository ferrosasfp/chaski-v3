import { afterEach, describe, expect, it, vi } from "vitest";
import { createContainer } from "./container";

// El container corre en entorno de módulo (node). pickWallet() sin window → FallbackWallet, sin I/O.
afterEach(() => vi.unstubAllEnvs());

describe("createContainer — flag adapter value-delivery (WKH-186 AC-1/AC-2)", () => {
  it("AC-1: sin flag (default) → construye OK (Fallback cableado, demo byte-idéntico)", () => {
    vi.unstubAllEnvs();
    expect(() => createContainer()).not.toThrow();
  });

  it("AC-2: flag 'a2a' (sin EIP-3009) → construye OK (adapters a2a cableados)", () => {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a");
    expect(() => createContainer()).not.toThrow();
  });
});

describe("createContainer — guard fail-loud EIP-3009 (WKH-186 AC-11, CD-3/4/16)", () => {
  it("CD-3: EIP-3009 on + adapter != a2a → throw eip3009_requires_a2a_adapter", () => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "fallback");
    expect(() => createContainer()).toThrow("eip3009_requires_a2a_adapter");
  });

  it("CD-4: EIP-3009 on + adapter a2a + sin receiver → throw eip3009_requires_receiver", () => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a");
    vi.stubEnv("NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS", "");
    expect(() => createContainer()).toThrow("eip3009_requires_receiver");
  });

  it("CD-16: EIP-3009 on + adapter a2a + receiver + sin usdc → throw eip3009_requires_usdc_contract", () => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a");
    vi.stubEnv("NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS", "0x1111111111111111111111111111111111111111");
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS", "");
    expect(() => createContainer()).toThrow("eip3009_requires_usdc_contract");
  });

  it("AC-11: EIP-3009 on + a2a + receiver + usdc → construye OK (todo configurado)", () => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a");
    vi.stubEnv("NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS", "0x1111111111111111111111111111111111111111");
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS", "0x5425890298aed601595a70ab815c96711a31bc65");
    expect(() => createContainer()).not.toThrow();
  });

  it("MNR-A: EIP-3009 on + a2a + receiver MALFORMADO (no isAddress) → throw en createContainer (fail-loud, NO en sign-time)", () => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a");
    vi.stubEnv("NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS", "0xNOT_A_VALID_ADDRESS"); // truthy pero malformado
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS", "0x5425890298aed601595a70ab815c96711a31bc65");
    // La app NO arranca: el receiver malformado (que antes se colaba por `as 0x${string}`) falla acá.
    expect(() => createContainer()).toThrow("payout_receiver_not_configured");
  });

  it("MNR-A: EIP-3009 on + a2a + receiver con checksum inválido → throw en createContainer", () => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a");
    // 40 hex chars con checksum mixto INVÁLIDO (isAddress lo rechaza) → simula un typo de address.
    vi.stubEnv("NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS", "0xAbCdEf1111111111111111111111111111111111");
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS", "0x5425890298aed601595a70ab815c96711a31bc65");
    expect(() => createContainer()).toThrow("payout_receiver_not_configured");
  });
});
