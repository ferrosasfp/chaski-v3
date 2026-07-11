import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Money } from "../domain/money";
import type { Quote } from "../domain/remittance";
import {
  FALLBACK_WALLET_ADDRESS,
  FallbackWallet,
  InjectedWallet,
  pickWallet,
  WalletConnectWallet,
} from "./wallet";

// MNR-B: mock del lazy-import de @walletconnect/ethereum-provider. El WalletConnectWallet hace
// `await import("@walletconnect/ethereum-provider")` dentro de ensureProvider() → interceptamos el
// módulo y hacemos que EthereumProvider.init() devuelva un fake EIP-1193 (mismo patrón de fake
// provider que InjectedWallet, adaptado a la forma WC: connect() + .accounts + .request). El
// `wc` compartido (vi.hoisted, disponible en el hoist de vi.mock) deja cada test inyectar su provider.
const wc = vi.hoisted(() => ({ provider: null as unknown }));
vi.mock("@walletconnect/ethereum-provider", () => ({
  EthereumProvider: { init: vi.fn(async () => wc.provider) },
}));

// AC-8/AC-9 sobre InjectedWallet (viem + provider inyectado = mockable con window.ethereum).
// Env de test = node (sin window/jsdom) → stub de globalThis.window, patrón persistence.test.ts:35-41.
// El chain configurado por default es 43114 (NEXT_PUBLIC_CHAIN_ID unset → resolveChainId()=43114).

const VALID_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cffFb92266"; // hardhat acct#0 (viem lo checksumea)
const CHAIN_MAINNET_HEX = "0xa86a"; // 43114
const CHAIN_ETH_HEX = "0x1"; // 1 (red distinta → dispara el switch)

interface ProviderCall {
  method: string;
  params?: unknown;
}
interface FakeProviderOpts {
  accounts?: string[];
  chainIdHex?: string;
  switchRejects?: boolean;
}

function makeProvider(opts: FakeProviderOpts = {}) {
  const calls: ProviderCall[] = [];
  const request = vi.fn(async (args: { method: string; params?: unknown }): Promise<unknown> => {
    calls.push({ method: args.method, params: args.params });
    switch (args.method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return opts.accounts ?? [VALID_ADDR];
      case "eth_chainId":
        return opts.chainIdHex ?? CHAIN_MAINNET_HEX;
      case "wallet_switchEthereumChain":
        if (opts.switchRejects) throw new Error("user_rejected");
        return null;
      case "personal_sign":
      case "eth_sign":
        return "0xsignature";
      default:
        throw new Error(`unhandled:${args.method}`);
    }
  });
  return { request, calls };
}

function stubWindow(provider: unknown): void {
  (globalThis as { window?: { ethereum?: unknown } }).window = { ethereum: provider };
}

// Fake provider EIP-1193 con la FORMA que consume WalletConnectWallet: connect() + .accounts +
// .request (para eth_chainId / wallet_switchEthereumChain / personal_sign). Reusa CHAIN_*_HEX y
// VALID_ADDR del bloque InjectedWallet (path compartido: chainId hex parse + switch + guard isAddress).
function makeWcProvider(opts: FakeProviderOpts = {}) {
  const calls: ProviderCall[] = [];
  const request = vi.fn(async (args: { method: string; params?: unknown }): Promise<unknown> => {
    calls.push({ method: args.method, params: args.params });
    switch (args.method) {
      case "eth_chainId":
        return opts.chainIdHex ?? CHAIN_MAINNET_HEX;
      case "wallet_switchEthereumChain":
        if (opts.switchRejects) throw new Error("user_rejected");
        return null;
      case "personal_sign":
      case "eth_sign":
        return "0xsignature";
      default:
        throw new Error(`unhandled:${args.method}`);
    }
  });
  const connect = vi.fn(async (): Promise<void> => {});
  // El provider WC real devuelve accounts ya en checksum EIP-55 (a diferencia de InjectedWallet, que
  // pasa por viem requestAddresses() que checksumea); connect() lo consume crudo → checksumeamos acá.
  return { request, connect, accounts: opts.accounts ?? [getAddress(VALID_ADDR)], calls };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete process.env.NEXT_PUBLIC_CHAIN_ID;
  wc.provider = null;
});

describe("FallbackWallet — connect (WKH-184 AC-8/AC-9)", () => {
  it("AC-8/AC-9: connect() retorna la constante única FALLBACK_WALLET_ADDRESS", async () => {
    const addr = await new FallbackWallet().connect();
    expect(addr).toBe(FALLBACK_WALLET_ADDRESS);
  });
});

describe("pickWallet — sin wallet real (WKH-184 AC-8, CD-2)", () => {
  it("sin provider inyectado y sin window (SSR/test) → FallbackWallet (flujo completa sin wallet real)", () => {
    // Entorno node de vitest: sin window ni provider inyectado → cae al demo, sin gating nuevo.
    expect(pickWallet()).toBeInstanceOf(FallbackWallet);
  });
});

describe("InjectedWallet — chainId check + switch suave (AC-8)", () => {
  it("chain coincide (43114) → connect OK, NO dispara switch", async () => {
    const p = makeProvider({ chainIdHex: CHAIN_MAINNET_HEX });
    stubWindow(p);
    const w = new InjectedWallet();
    const addr = await w.connect();
    expect(addr.toLowerCase()).toBe(VALID_ADDR.toLowerCase());
    expect(p.calls.some((c) => c.method === "wallet_switchEthereumChain")).toBe(false);
  });

  it("chain distinta → dispara wallet_switchEthereumChain (switch suave) y conecta", async () => {
    const p = makeProvider({ chainIdHex: CHAIN_ETH_HEX });
    stubWindow(p);
    const w = new InjectedWallet();
    await w.connect();
    expect(p.calls.some((c) => c.method === "wallet_switchEthereumChain")).toBe(true);
  });

  it("chain distinta + switch RECHAZADO → throw wrong_chain", async () => {
    const p = makeProvider({ chainIdHex: CHAIN_ETH_HEX, switchRejects: true });
    stubWindow(p);
    const w = new InjectedWallet();
    await expect(w.connect()).rejects.toThrow(/wrong_chain/);
  });
});

describe("InjectedWallet — validación de address (AC-9)", () => {
  const quote: Quote = {
    quoteId: "q1",
    send: Money.of(400, "USDC"),
    receive: Money.of(1480, "PEN"),
    feeUsd: Money.of(0.5, "USDC"),
    rate: 3.7,
    etaMinutes: 30,
    expiresAt: "2026-07-09T18:10:00.000Z",
    provenance: "fake",
  };

  it("authorizePrincipal con address malformada → throw invalid_address SIN pedir firma", async () => {
    const p = makeProvider();
    stubWindow(p);
    const w = new InjectedWallet();
    // Inyecta una address malformada en el campo privado (defensa en profundidad: el guard debe
    // disparar aunque connect() no la haya validado). TS `private` es solo compile-time.
    (w as unknown as { address: string }).address = "0xNOT_AN_ADDRESS";
    await expect(w.authorizePrincipal(quote)).rejects.toThrow(/invalid_address/);
    expect(p.calls.some((c) => c.method === "personal_sign" || c.method === "eth_sign")).toBe(false);
  });
});

// MNR-B: WalletConnectWallet es código de PROD cuando NEXT_PUBLIC_REOWN_PROJECT_ID está seteado
// (navegador móvil normal → deep-link). Sin estos tests, la lógica NUEVA de WC (chainId hex parse
// vía provider.request + wallet_switchEthereumChain + guard isAddress) quedaba sin cobertura. El
// lazy-import de @walletconnect está mockeado (arriba) → EthereumProvider.init devuelve wc.provider.
describe("WalletConnectWallet — chainId hex parse + switch suave (AC-8)", () => {
  it("chain coincide (43114) → connect OK, NO dispara switch", async () => {
    wc.provider = makeWcProvider({ chainIdHex: CHAIN_MAINNET_HEX });
    const w = new WalletConnectWallet("proj-id");
    const addr = await w.connect();
    expect(addr.toLowerCase()).toBe(VALID_ADDR.toLowerCase());
    const p = wc.provider as ReturnType<typeof makeWcProvider>;
    expect(p.calls.some((c) => c.method === "wallet_switchEthereumChain")).toBe(false);
  });

  it("chain distinta → dispara wallet_switchEthereumChain (switch suave) y conecta", async () => {
    wc.provider = makeWcProvider({ chainIdHex: CHAIN_ETH_HEX });
    const w = new WalletConnectWallet("proj-id");
    await w.connect();
    const p = wc.provider as ReturnType<typeof makeWcProvider>;
    expect(p.calls.some((c) => c.method === "wallet_switchEthereumChain")).toBe(true);
  });

  it("chain distinta + switch RECHAZADO por el usuario → throw wrong_chain", async () => {
    wc.provider = makeWcProvider({ chainIdHex: CHAIN_ETH_HEX, switchRejects: true });
    const w = new WalletConnectWallet("proj-id");
    await expect(w.connect()).rejects.toThrow(/wrong_chain/);
  });
});

describe("WalletConnectWallet — validación de address (AC-9)", () => {
  const quote: Quote = {
    quoteId: "q1",
    send: Money.of(400, "USDC"),
    receive: Money.of(1480, "PEN"),
    feeUsd: Money.of(0.5, "USDC"),
    rate: 3.7,
    etaMinutes: 30,
    expiresAt: "2026-07-09T18:10:00.000Z",
    provenance: "fake",
  };

  it("authorizePrincipal con address malformada → throw invalid_address SIN pedir firma", async () => {
    wc.provider = makeWcProvider();
    const w = new WalletConnectWallet("proj-id");
    // Address malformada inyectada en el campo privado (mismo patrón que InjectedWallet): el guard
    // isAddress debe disparar antes de crear el walletClient / pedir firma. TS `private` = compile-time.
    (w as unknown as { address: string }).address = "0xNOT_AN_ADDRESS";
    await expect(w.authorizePrincipal(quote)).rejects.toThrow(/invalid_address/);
    const p = wc.provider as ReturnType<typeof makeWcProvider>;
    expect(p.calls.some((c) => c.method === "personal_sign" || c.method === "eth_sign")).toBe(false);
  });
});
