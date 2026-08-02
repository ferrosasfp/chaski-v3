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
/** HU-SOL-5: firma parcial la tx con la wallet conectada. `tx` opaco (`unknown`) para NO importar
 *  @solana/web3.js types acá (preserva el seam React-free de HU-SOL-4). El sync component captura
 *  `useWallet().signTransaction` y lo registra; el adapter lo consume. */
type SignTransactionFn = (tx: unknown) => Promise<unknown>;
/** HU-SOL-8: firma un mensaje arbitrario (ed25519) con la wallet conectada. El sync component captura
 *  `useWallet().signMessage` y lo registra; el adapter lo consume para el proof-of-possession. */
type SignMessageFn = (message: Uint8Array) => Promise<Uint8Array>;

class SolanaWalletBridge {
  private state: SolanaWalletState = { publicKey: null, connected: false };
  private openModalHandle: OpenModalFn | null = null;
  private signTxHandle: SignTransactionFn | null = null;
  private signMsgHandle: SignMessageFn | null = null;
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

  /** HU-SOL-5: lo registra el sync component (captura `useWallet().signTransaction`).
   *  Esta frase fue FALSA durante toda la vida del archivo y nadie lo notó, porque afirmaba un
   *  cableado que no existía: el único llamador era el propio test, que se lo pasaba a mano. Ahora
   *  hay un test que monta el árbol REAL y verifica el cableado, no el doble
   *  (`solana-providers.test.tsx`, T-SIGN-1/2). Si volvés a leer esta frase, no le creas: mirá ese
   *  test. */
  registerSignTransaction(fn: SignTransactionFn): void {
    this.signTxHandle = fn;
  }

  /** HU-SOL-5: partial-sign de la tx con la wallet conectada. Fail-loud si el árbol no montó el
   *  handle (nunca firma con una clave que no sea la de la wallet). */
  async signTransaction(tx: unknown): Promise<unknown> {
    if (!this.signTxHandle) throw new Error("wallet_sign_not_available");
    return this.signTxHandle(tx);
  }

  /** HU-SOL-8: registrado por el sync component (captura useWallet().signMessage). */
  registerSignMessage(fn: SignMessageFn): void {
    this.signMsgHandle = fn;
  }

  /** HU-SOL-8: firma un mensaje con la wallet conectada. Fail-loud si el árbol no montó el handle
   *  (mirror de signTransaction: nunca firma con una clave que no sea la de la wallet). */
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this.signMsgHandle) throw new Error("wallet_sign_not_available");
    return this.signMsgHandle(message);
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
    this.failConnection("wallet_connect_cancelled");
  }

  /** Corta la espera con una causa CONCRETA. La llama el sync component desde `onError` de
   *  WalletProvider, que es la única fuente que sabe POR QUÉ falló (wallet rechazada, no instalada,
   *  ventana cerrada). Sin esto, cualquier fallo de conexión terminaba en el timeout de 120 s o en
   *  un `wallet_connect_cancelled` genérico, y la UI no podía decir nada útil. No-op si no hay
   *  espera en curso: un error de una wallet que nadie está esperando no debe inventar un rechazo. */
  failConnection(code: string): void {
    const rej = this.pendingReject;
    if (!rej) return;
    this.clearPending();
    rej(new Error(code));
  }

  /** Test-only: resetea el singleton entre tests. */
  reset(): void {
    this.clearPending();
    this.state = { publicKey: null, connected: false };
    this.openModalHandle = null;
    this.signTxHandle = null; // HU-SOL-5: aditivo, limpia el handle entre tests
    this.signMsgHandle = null; // HU-SOL-8: aditivo, limpia el handle entre tests
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
