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

/** Elige la wallet REAL si hay una inyectada (MetaMask), si no la demo simulada. */
export function pickWallet(): WalletPort {
  return injectedProvider() ? new InjectedWallet() : new FallbackWallet();
}
