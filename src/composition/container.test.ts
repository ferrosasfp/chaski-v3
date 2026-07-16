import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpSettlementGateway } from "../infrastructure/settlement/http-settlement-gateway";
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

// WKH-168 W4.4 — el settlement real se cablea SOLO con el flag on (AC-5/CD-1 por construcción).
// Se inspecciona la dependencia REALMENTE inyectada en ConfirmAndSend en vez de espiar la factory
// con vi.mock: vi.mock es hoisted a TODO el archivo y envolvería los 8 tests del guard fail-loud
// (riesgo de falso verde). Esto es evidencia más directa: qué recibió el use-case.
function settlementOf(
  c: ReturnType<typeof createContainer>,
): { gateway?: unknown; receiver?: unknown } | undefined {
  return (c.confirmAndSend as unknown as { settlement?: { gateway?: unknown; receiver?: unknown } })
    .settlement;
}

describe("createContainer — settlement del principal (WKH-168 AC-5/CD-1)", () => {
  it("AC-5/CD-1: flag EIP-3009 OFF (default) → ConfirmAndSend NO recibe settlement (demo byte-idéntico)", () => {
    vi.unstubAllEnvs();
    expect(settlementOf(createContainer())).toBeUndefined();
    // Tampoco con el adapter a2a solo: el gate es el flag EIP-3009, no el adapter.
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a");
    expect(settlementOf(createContainer())).toBeUndefined();
  });

  it("flag EIP-3009 ON + config completa → ConfirmAndSend recibe el HttpSettlementGateway (modo real)", () => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a");
    vi.stubEnv("NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS", "0x1111111111111111111111111111111111111111");
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS", "0x5425890298aed601595a70ab815c96711a31bc65");
    expect(settlementOf(createContainer())?.gateway).toBeInstanceOf(HttpSettlementGateway);
  });

  // AR/MNR-4 + CR/MNR-2: el composition root es el ÚNICO que resuelve el receiver, y lo inyecta
  // ACOPLADO al gateway. Antes el use-case lo leía de env importando infrastructure/chain.
  it("AR/MNR-4: modo real → el receiver de env viaja INYECTADO junto al gateway (application ya no lee env)", () => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a");
    vi.stubEnv("NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS", "0x1111111111111111111111111111111111111111");
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS", "0x5425890298aed601595a70ab815c96711a31bc65");
    // El receiver inyectado es el de la env, ya validado fail-loud por el guard (resolveReceiverAddress).
    expect(settlementOf(createContainer())?.receiver).toBe(
      "0x1111111111111111111111111111111111111111",
    );
  });
});
