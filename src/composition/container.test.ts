// Tests — createContainer (T2, WKH-320 / AC-3.1).
//
// QUÉ SE FUE DE ACÁ Y POR QUÉ (CD-10/CD-22): este archivo probaba el guard fail-loud de EIP-3009
// (adapter=a2a + receiver + usdc + formato del receiver, 6 casos), el cableado del
// HttpSettlementGateway/HttpPayoutPrepareGateway con el flag ON, y el dispatcher de wallet por VM
// (VM=solana → SolanaWalletAdapter; VM inválida → unsupported_vm). Los tres grupos probaban ramas
// que ya no existen: no hay flag EIP-3009, no hay gateways EVM que cablear, y no hay una VM que
// pueda no ser Solana. Lo que los reemplaza está abajo, y es más fuerte: el estado peligroso dejó
// de ser expresable, y lo único que NO se resuelve por construcción —una env EVM huérfana en el
// panel de Vercel— lo caza assertNoEvmResidue().
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { SolanaWalletAdapter } from "../infrastructure/solana-wallet";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { createContainer } from "./container";

// Las envs EVM tienen que estar AUSENTES para que el container arranque (assertNoEvmResidue).
const EVM_ENVS = [
  "NEXT_PUBLIC_VM",
  "NEXT_PUBLIC_EIP3009_ENABLED",
  "NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS",
  "NEXT_PUBLIC_USDC_CONTRACT_ADDRESS",
  "NEXT_PUBLIC_CHAIN_ID",
  "NEXT_PUBLIC_REOWN_PROJECT_ID",
] as const;

beforeEach(() => {
  for (const k of EVM_ENVS) vi.stubEnv(k, undefined as unknown as string);
});
afterEach(() => {
  vi.unstubAllEnvs();
  solanaWalletBridge.reset();
});

describe("createContainer — se construye SIN leer ninguna env EVM (AC-3.1)", () => {
  it("con TODAS las envs EVM ausentes construye OK", () => {
    expect(() => createContainer()).not.toThrow();
  });

  it("el flag de value-delivery sigue funcionando (a2a) sin ninguna env EVM", () => {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "a2a");
    expect(() => createContainer()).not.toThrow();
  });

  // El ternario `solanaWallet ?? pickWallet()` era el punto donde una wallet EVM podía entrar. Ya no
  // hay ternario: la wallet es SIEMPRE el adapter Solana, sin importar la configuración.
  it("AC-3.1: la wallet es SIEMPRE el SolanaWalletAdapter (no hay ternario que pueda elegir otra)", () => {
    const c = createContainer();
    const wallet = (c.connectWallet as unknown as { wallet: unknown }).wallet;
    expect(wallet).toBeInstanceOf(SolanaWalletAdapter);
  });

  it("AC-3.1: y lo sigue siendo con el adapter de value-delivery en 'fallback' (el gate no es ese flag)", () => {
    vi.stubEnv("NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER", "fallback");
    const c = createContainer();
    expect((c.connectWallet as unknown as { wallet: unknown }).wallet).toBeInstanceOf(
      SolanaWalletAdapter,
    );
  });

  // T2 — `pickWallet` no es "una función que no se llama": el MÓDULO no existe.
  it("AC-3.1: el módulo de la wallet EVM no existe en el árbol (pickWallet no es importable)", () => {
    expect(existsSync(path.resolve(process.cwd(), "src/infrastructure/wallet.ts"))).toBe(false);
  });
});

describe("createContainer — assertNoEvmResidue es la PRIMERA línea (AC-3.3)", () => {
  // Va antes de cualquier `new`: un deploy con config EVM huérfana no arranca, en vez de arrancar
  // a medias con la mitad del grafo construido.
  it("una env EVM residual ⇒ el container NO se construye, y el error la nombra", () => {
    vi.stubEnv("NEXT_PUBLIC_VM", "solana");
    expect(() => createContainer()).toThrow("evm_config_residue");
    expect(() => createContainer()).toThrow("NEXT_PUBLIC_VM");
  });

  it("también con NEXT_PUBLIC_EIP3009_ENABLED, que antes ENCENDÍA un camino y ahora lo bloquea", () => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    expect(() => createContainer()).toThrow("evm_config_residue");
  });
});

describe("createContainer — money-path Solana (HU-SOL-13)", () => {
  it("flag Solana OFF ⇒ ConfirmAndSend NO recibe `solana` (y su tapón DT-8 falla fail-closed)", () => {
    const c = createContainer();
    const solana = (c.confirmAndSend as unknown as { solana?: unknown }).solana;
    expect(solana).toBeUndefined();
  });

  it("flag Solana ON sin mint configurado ⇒ throw fail-loud en construcción (la app NO arranca)", () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_SETTLE_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_USDC_MINT", "");
    expect(() => createContainer()).toThrow("solana_usdc_mint_not_configured");
  });

  it("flag Solana ON con mint pero sin facilitator ⇒ throw fail-loud en construcción", () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_SETTLE_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_USDC_MINT", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY", "");
    expect(() => createContainer()).toThrow("solana_facilitator_not_configured");
  });

  it("flag Solana ON con todo configurado ⇒ ConfirmAndSend recibe prepare+gateway ACOPLADOS", () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_SETTLE_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_USDC_MINT", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    vi.stubEnv(
      "NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    );
    const c = createContainer();
    const solana = (c.confirmAndSend as unknown as {
      solana?: { prepare?: unknown; gateway?: unknown };
    }).solana;
    // Los dos JUNTOS o ninguno: un `prepare` suelto que quede undefined saltearía el binding en silencio.
    expect(solana?.prepare).toBeDefined();
    expect(solana?.gateway).toBeDefined();
  });

  // HU-SOL-20/AC-2: el adapter Solana se construye CON su resolver de remittanceId. El wiring tiene un
  // ciclo aparente (adapter → resolver → PopSigner → wallet=adapter) que se rompe difiriendo el
  // PopSigner; esto lo ejercita END-TO-END en el container real. Si el diferido estuviera mal
  // (TDZ / instancia a medio construir), acá saldría un ReferenceError, no un escrow_not_found.
  it("HU-SOL-20: el resolver de remittanceId queda cableado sin ciclo — el refund sin id pide el PoP", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ error: "pop_not_configured" }, { status: 501 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const c = createContainer();
      const gw = c.solanaRefund as unknown as {
        refund(i: { remittanceId?: string; sender: string }): Promise<{ refundTx: string }>;
      };
      expect(gw).toBeDefined();
      // 501 ⇒ prove() null ⇒ resolver devuelve [] ⇒ escrow_not_found (nunca un crash de wiring).
      await expect(
        gw.refund({ sender: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }),
      ).rejects.toThrow("escrow_not_found");
      // Prueba de que el PopSigner diferido SE construyó con el propio adapter y corrió.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/a2a/payout/challenge");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
