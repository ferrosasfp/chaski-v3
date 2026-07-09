// Infrastructure — WalletPort. InjectedWallet (REAL, abre MetaMask via viem) + FallbackWallet (demo).
// pickWallet() usa la real si hay wallet inyectada, si no la simulada (para que el demo corra igual).
import { createWalletClient, custom } from "viem";
import { avalanche } from "viem/chains";
import type { WalletPort } from "../application/ports";
import type { Quote } from "../domain/remittance";

// biome-ignore lint/suspicious/noExplicitAny: provider EIP-1193 inyectado (window.ethereum)
function injectedProvider(): any {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ethereum?: unknown }).ethereum;
}

/** REAL — usa la wallet inyectada (MetaMask/Rabby/etc.). connect() abre el modal de la wallet. */
export class InjectedWallet implements WalletPort {
  private address: `0x${string}` | null = null;

  async connect(): Promise<string> {
    const eth = injectedProvider();
    if (!eth) throw new Error("no_wallet");
    const client = createWalletClient({ chain: avalanche, transport: custom(eth) });
    const [addr] = await client.requestAddresses(); // eth_requestAccounts → abre la wallet
    if (!addr) throw new Error("no_account");
    this.address = addr;
    return addr;
  }

  async getAddress(): Promise<string | null> {
    return this.address;
  }

  async authorizePrincipal(quote: Quote): Promise<{ tx: string }> {
    const eth = injectedProvider();
    if (!eth || !this.address) throw new Error("wallet_not_connected");
    const client = createWalletClient({ chain: avalanche, transport: custom(eth) });
    // DEMO: firma un MENSAJE (prompt real de la wallet). En producción: EIP-3009 signTypedData del
    // transferWithAuthorization → el principal viaja gasless al partner via el facilitator.
    const sig = await client.signMessage({
      account: this.address,
      message: `Chaski · autorizo enviar ${quote.send.format()} (remesa ${quote.quoteId})`,
    });
    return { tx: sig };
  }
}

/** Demo — simula conectar + firmar (sin wallet real). Se usa si no hay wallet inyectada. */
export class FallbackWallet implements WalletPort {
  private address: string | null = null;
  async connect(): Promise<string> {
    await new Promise((r) => setTimeout(r, 400));
    this.address = "0xDEMO00000000000000000000000000000A11ce";
    return this.address;
  }
  async getAddress(): Promise<string | null> {
    return this.address;
  }
  async authorizePrincipal(_quote: Quote): Promise<{ tx: string }> {
    return { tx: `0xdemo${Date.now().toString(16)}` };
  }
}

// EIP-1193 mínimo que expone el provider de WalletConnect (lo que usamos).
interface WcProvider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  connect(): Promise<void>;
  accounts: string[];
}

/** REAL vía WalletConnect — para navegadores móviles normales (Safari/Chrome): abre modal/deep-link
 * a la wallet instalada en el cel. connect() dispara el deep-link; la lib mantiene la sesión. */
export class WalletConnectWallet implements WalletPort {
  private address: `0x${string}` | null = null;
  private provider: WcProvider | null = null;

  constructor(private readonly projectId: string) {}

  private async ensureProvider(): Promise<WcProvider> {
    if (this.provider) return this.provider;
    // Lazy-import: la lib de WC es pesada y usa APIs del browser → solo se carga en el cliente.
    const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
    const p = await EthereumProvider.init({
      projectId: this.projectId,
      chains: [43114], // Avalanche
      showQrModal: true, // QR en desktop, deep-link a la wallet en móvil
      qrModalOptions: { themeMode: "light" }, // evita el modal negro-sobre-negro
      metadata: {
        name: "Chaski",
        description: "Envía USDC a Perú, sin vueltas",
        url: typeof window !== "undefined" ? window.location.origin : "https://chaski-v2.vercel.app",
        icons: [],
      },
    });
    this.provider = p as unknown as WcProvider;
    return this.provider;
  }

  async connect(): Promise<string> {
    const provider = await this.ensureProvider();
    await provider.connect(); // abre el modal WC / deep-link a la wallet del cel
    const addr = provider.accounts?.[0];
    if (!addr) throw new Error("no_account");
    this.address = addr as `0x${string}`;
    return this.address;
  }

  async getAddress(): Promise<string | null> {
    return this.address;
  }

  async authorizePrincipal(quote: Quote): Promise<{ tx: string }> {
    const provider = await this.ensureProvider();
    if (!this.address) throw new Error("wallet_not_connected");
    const client = createWalletClient({ chain: avalanche, transport: custom(provider) });
    const sig = await client.signMessage({
      account: this.address,
      message: `Chaski · autorizo enviar ${quote.send.format()} (remesa ${quote.quoteId})`,
    });
    return { tx: sig };
  }
}

/**
 * Elige la wallet:
 * - inyectada (MetaMask desktop / browser de la wallet en el cel) → InjectedWallet
 * - navegador móvil normal con projectId de WalletConnect → WalletConnectWallet (deep-link)
 * - si no hay ninguna → demo simulada
 */
export function pickWallet(): WalletPort {
  if (injectedProvider()) return new InjectedWallet();
  const wcId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;
  if (typeof window !== "undefined" && wcId) return new WalletConnectWallet(wcId);
  return new FallbackWallet();
}
