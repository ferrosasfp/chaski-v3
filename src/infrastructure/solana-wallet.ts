// src/infrastructure/solana-wallet.ts
// SolanaWalletAdapter implements WalletPort — puente React-free hacia el árbol Solana vía el
// singleton bridge. NUNCA importa @solana/wallet-adapter-* (seam AC-3). Valida base58 con PublicKey
// de @solana/web3.js (CD-SDD-5), NUNCA isAddress de viem. connect()/getAddress() son REALES;
// authorizePrincipal/signMessage son demo-simbólicos (Scope OUT: firma SPL=HU-SOL-2, PoP=HU-SOL-8).
import { PublicKey } from "@solana/web3.js";
import type { WalletPort } from "../application/ports";
import type { Quote } from "../domain/remittance";
import { solanaWalletBridge } from "./solana-wallet-bridge";

export class SolanaWalletAdapter implements WalletPort {
  private address: string | null = null;

  async connect(): Promise<string> {
    const state = solanaWalletBridge.getState();
    if (!state.connected || !state.publicKey) {
      solanaWalletBridge.openModal(); // abre el modal Phantom/Solflare (AC-2)
      await solanaWalletBridge.waitForConnection(); // throw en timeout/cancel (§flujo de error)
    }
    const base58 = solanaWalletBridge.getState().publicKey;
    if (!base58) throw new Error("wallet_not_connected");
    // Defensa en profundidad: valida base58 ANTES de cachear (espeja InjectedWallet:66).
    try {
      new PublicKey(base58);
    } catch {
      throw new Error("invalid_address");
    }
    this.address = base58; // OPACO, SIN toLowerCase (CD-3)
    return this.address;
  }

  async getAddress(): Promise<string | null> {
    return this.address; // el MISMO base58 case-sensitive (AC-6)
  }

  // Scope OUT (CD-4 / DT-SDD-6): firma real SPL = HU-SOL-2. Demo-simbólico como FallbackWallet.
  async authorizePrincipal(_quote: Quote): Promise<{ tx: string }> {
    return { tx: `solana-demo-${Date.now().toString(16)}` };
  }

  async signMessage(_message: string): Promise<string> {
    return `solana-demosig-${Date.now().toString(16)}`;
  }
}
