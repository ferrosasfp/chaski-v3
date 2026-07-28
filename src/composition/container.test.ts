import { afterEach, describe, expect, it, vi } from "vitest";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { HttpPayoutPrepareGateway } from "../infrastructure/settlement/http-payout-prepare-gateway";
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
): { gateway?: unknown; prepare?: unknown } | undefined {
  return (c.confirmAndSend as unknown as { settlement?: { gateway?: unknown; prepare?: unknown } })
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

  // WKH-211 [SDD-GAP #1]: el composition root inyecta el `prepare` gateway ACOPLADO dentro de
  // `settlement` (ya NO un `receiver`). modo real ⇔ gateway Y prepare presentes juntos (anti-fail-open).
  it("WKH-211: modo real → settlement lleva el HttpPayoutPrepareGateway acoplado (no un receiver suelto)", () => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a");
    vi.stubEnv("NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS", "0x1111111111111111111111111111111111111111");
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS", "0x5425890298aed601595a70ab815c96711a31bc65");
    const s = settlementOf(createContainer());
    expect(s?.prepare).toBeInstanceOf(HttpPayoutPrepareGateway);
    expect(s?.gateway).toBeInstanceOf(HttpSettlementGateway); // ambos juntos ⇔ modo real
  });
});

describe("createContainer — dispatcher de wallet por VM (HU-SOL-4, AC-4/AC-5)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    solanaWalletBridge.reset();
  });

  it("AC-4: VM=solana → cablea el SolanaWalletAdapter (no pickWallet)", async () => {
    vi.stubEnv("NEXT_PUBLIC_VM", "solana");
    const c = createContainer();
    // El adapter Solana sin árbol montado → openModal throw wallet_bridge_not_mounted.
    // (En rama evm, FallbackWallet resolvería a la address demo → distinguible = mata la mutación.)
    await expect(c.connectWallet.execute()).rejects.toThrow("wallet_bridge_not_mounted");
  });

  it("AC-5: VM inválida → createContainer throw unsupported_vm (fail-loud)", () => {
    vi.stubEnv("NEXT_PUBLIC_VM", "aptos");
    expect(() => createContainer()).toThrow("unsupported_vm");
  });

  // HU-SOL-20/AC-2: el adapter Solana se construye CON su resolver de remittanceId. El wiring tiene un
  // ciclo aparente (adapter → resolver → PopSigner → wallet=adapter) que se rompe difiriendo el
  // PopSigner; este test lo ejercita END-TO-END en el container real. Si el diferido estuviera mal
  // (TDZ / instancia a medio construir), acá saldría un ReferenceError, no un escrow_not_found.
  it("HU-SOL-20: VM=solana cablea el resolver de remittanceId sin ciclo — el refund sin id pide el PoP", async () => {
    vi.stubEnv("NEXT_PUBLIC_VM", "solana");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ error: "pop_not_configured" }, { status: 501 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const c = createContainer();
      // El port declara remittanceId requerido (la UI de recuperación es R4); acá se ejercita la
      // capacidad ya cableada del adapter: refund SIN id.
      const gw = c.solanaRefund as unknown as {
        refund(i: { remittanceId?: string; sender: string }): Promise<{ refundTx: string }>;
      };
      expect(gw).toBeDefined();
      // 501 ⇒ prove() null ⇒ resolver devuelve [] ⇒ escrow_not_found (nunca un crash de wiring).
      await expect(gw.refund({ sender: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" })).rejects.toThrow(
        "escrow_not_found",
      );
      // Prueba de que el PopSigner diferido SE construyó con el propio adapter y corrió.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/a2a/payout/challenge");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
