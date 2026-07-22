// src/infrastructure/solana-wallet-bridge.ts
// SEAM React-free entre el árbol @solana/wallet-adapter-react (mundo React, montado SOLO si
// VM=solana) y el SolanaWalletAdapter (mundo imperativo, instanciado en container.ts). Este módulo
// es plain TS: NUNCA importa @solana/wallet-adapter-* ni React (garantiza AC-3 por construcción).

/** Estado que el sync component (dentro del árbol React) empuja en cada cambio de useWallet(). */
export interface SolanaWalletState {
  publicKey: string | null; // base58 OPACO (CD-3) — nunca toLowerCase
  connected: boolean;
}

type OpenModalFn = () => void;

class SolanaWalletBridge {
  private state: SolanaWalletState = { publicKey: null, connected: false };
  private openModalHandle: OpenModalFn | null = null;
  private pendingResolve: (() => void) | null = null;
  private pendingReject: ((e: Error) => void) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  /** El sync component lo llama en cada cambio de useWallet(). Resuelve la espera si conectó. */
  setState(next: SolanaWalletState): void {
    this.state = next;
    if (next.connected && next.publicKey) this.settle();
  }

  getState(): SolanaWalletState {
    return this.state;
  }

  /** Registrado por el sync component (captura useWalletModal().setVisible). */
  registerOpenModal(fn: OpenModalFn): void {
    this.openModalHandle = fn;
  }

  /** Abre el modal Phantom/Solflare. Throw si el árbol de providers no está montado. */
  openModal(): void {
    if (!this.openModalHandle) throw new Error("wallet_bridge_not_mounted");
    this.openModalHandle();
  }

  /** Deferred: resuelve cuando el estado transiciona a connected && publicKey; timeout → reject. */
  waitForConnection(timeoutMs = 120_000): Promise<void> {
    if (this.state.connected && this.state.publicKey) return Promise.resolve();
    if (this.pendingResolve) {
      // ya hay una espera en curso: no dupliques deferred, reusá una promesa nueva encadenada
      return new Promise<void>((res, rej) => {
        const prevRes = this.pendingResolve;
        const prevRej = this.pendingReject;
        this.pendingResolve = () => { prevRes?.(); res(); };
        this.pendingReject = (e) => { prevRej?.(e); rej(e); };
      });
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.pendingTimer = setTimeout(() => {
        const rej = this.pendingReject;
        this.clearPending();
        rej?.(new Error("wallet_connect_timeout"));
      }, timeoutMs);
    });
  }

  /** El sync component la llama cuando el modal se cierra sin conectar (best-effort cancel). */
  cancelConnection(): void {
    const rej = this.pendingReject;
    if (!rej) return;
    this.clearPending();
    rej(new Error("wallet_connect_cancelled"));
  }

  /** Test-only: resetea el singleton entre tests. */
  reset(): void {
    this.clearPending();
    this.state = { publicKey: null, connected: false };
    this.openModalHandle = null;
  }

  private settle(): void {
    const res = this.pendingResolve;
    this.clearPending();
    res?.();
  }

  private clearPending(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingResolve = null;
    this.pendingReject = null;
  }
}

/** Singleton compartido (browser). El sync component escribe, el adapter lee. */
export const solanaWalletBridge = new SolanaWalletBridge();
