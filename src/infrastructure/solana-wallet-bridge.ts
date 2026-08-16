// src/infrastructure/solana-wallet-bridge.ts
// SEAM React-free entre el árbol @solana/wallet-adapter-react (mundo React, montado SOLO si
// VM=solana) y el SolanaWalletAdapter (mundo imperativo, instanciado en container.ts). Este módulo
// es plain TS: NUNCA importa @solana/wallet-adapter-* ni React (garantiza AC-3 por construcción).

/** Estado que el sync component (dentro del árbol React) empuja en cada cambio de useWallet(). */
export interface SolanaWalletState {
  publicKey: string | null; // base58 OPACO (CD-3) — nunca toLowerCase
  connected: boolean;
}

/**
 * ¿Hay alguna wallet INYECTADA en este contexto de navegación?
 *
 * Son TRES valores y no dos, a propósito. Lo único que un navegador puede medir es si alguna wallet
 * expuso su API en el scope global de ESTA pestaña (`WalletReadyState.Installed`, ver
 * `@solana/wallet-adapter-base/lib/cjs/adapter.js`:37). Eso NO es lo mismo que "la persona tiene una
 * wallet instalada en el dispositivo": en el celular Phantom está instalada y no se inyecta salvo
 * adentro de su propio navegador. Cualquier copy que se apoye en esto tiene que hablar del navegador,
 * nunca del dispositivo.
 *
 * · "unknown"  — todavía no lo medimos (el árbol de providers no montó, o corriendo en el servidor).
 *                Es el valor inicial y NO habilita a afirmar nada.
 * · "injected" — al menos un adapter llegó a `Installed`.
 * · "none"     — ninguno. Sólo dice que acá no hay una wallet expuesta.
 */
export type SolanaWalletAvailability = "unknown" | "injected" | "none";

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
  private availability: SolanaWalletAvailability = "unknown"; private mwaOffered = false; private mwaListeners = new Set<() => void>(); // WKH-MWA: LOS TRES EN ESTA LÍNEA, no en tres — `:127` y `:146-150` los citan por número desde 3 sitios y están TODOS debajo de acá (mismo motivo que la línea de abajo)
  private availabilityListeners = new Set<() => void>(); private stateListeners = new Set<() => void>(); // WKH-354/AC-1: EN ESTA LÍNEA, no en una nueva — `:127` y `:146-150` de este archivo los citan por número desde otros 4 sitios y están TODOS debajo de acá
  private openModalHandle: OpenModalFn | null = null;
  private signTxHandle: SignTransactionFn | null = null;
  private signMsgHandle: SignMessageFn | null = null;
  private pendingResolve: (() => void) | null = null;
  private pendingReject: ((e: Error) => void) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  /** El sync component lo llama en cada cambio de useWallet(). Resuelve la espera si conectó. */
  setState(next: SolanaWalletState): void {
    const cambio = this.state.publicKey !== next.publicKey || this.state.connected !== next.connected; this.state = next; if (cambio) for (const listener of this.stateListeners) listener(); // WKH-354/AC-1: TODO EN ESTA LÍNEA — el guard "sin cambio no notifico" es el mismo de `setWalletAvailability` (`:65`) y evita el loop de render
    if (next.connected && next.publicKey) this.settle();
  }

  getState(): SolanaWalletState {
    return this.state;
  }

  /**
   * Lo empuja el sync component leyendo `useWallet().wallets[].readyState`, que es el ÚNICO lugar del
   * sistema que sabe si alguna wallet se inyectó. Vive acá y no en el árbol React para que la pantalla
   * pueda leerlo sin importar `@solana/wallet-adapter-*` (mismo seam que el resto del bridge).
   */
  setWalletAvailability(next: SolanaWalletAvailability): void {
    if (this.availability === next) return; // sin cambio no hay a quién avisarle
    this.availability = next;
    for (const listener of this.availabilityListeners) listener();
  }

  getWalletAvailability(): SolanaWalletAvailability {
    return this.availability;
  }

  /** Suscripción para `useSyncExternalStore`. La detección de wallets es ASÍNCRONA (la librería
   *  poliza el scope global cada segundo, `scopePollingDetectionStrategy`), así que leer una sola vez
   *  al renderizar podría congelar un "todavía no la vimos" que un instante después deja de ser
   *  cierto. Devuelve el desuscriptor. */
  subscribeWalletAvailability(listener: () => void): () => void {
    this.availabilityListeners.add(listener);
    return () => {
      this.availabilityListeners.delete(listener);
    };
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

  /** HU-SOL-8: lo registra el sync component (captura `useWallet().signMessage`).
   *  Esta frase decía exactamente lo mismo que la de `registerSignTransaction` de arriba, sin la
   *  advertencia y sin ningún test que la respaldara — y se midió que era igual de barata: borrando
   *  el efecto de `solana-providers.tsx` la suite quedaba 915/915 verde y `npm run qa` en exit 0.
   *  Ahora hay un test que monta el árbol REAL y no registra nada a mano
   *  (`solana-providers.test.tsx`, T-SIGN-3/4). Si volvés a leer esta frase, no le creas: mirá ese
   *  test. */
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

  /** Test-only: resetea el singleton entre tests. NO borra los listeners: desuscribirse es trabajo
   *  del `useEffect` de quien se suscribió, y vaciarlos acá dejaría muda a una pantalla montada. */
  reset(): void {
    this.clearPending();
    this.state = { publicKey: null, connected: false };
    this.setWalletAvailability("unknown"); // vuelve a "no lo medimos", nunca a un "no hay"
    this.openModalHandle = null;
    this.signTxHandle = null; // HU-SOL-5: aditivo, limpia el handle entre tests
    this.signMsgHandle = null; // HU-SOL-8: aditivo, limpia el handle entre tests
    this.setMwaOffered(false); // WKH-MWA: vuelve a "el selector no ofrece MWA", que es el valor que no agrega nada
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

  /** WKH-354/AC-1 · Suscripción para `useSyncExternalStore`. Mismo contrato que
   *  `subscribeWalletAvailability` (`:78-83`): devuelve el desuscriptor. Existe porque la cuenta
   *  activa de la wallet cambia SIN que la app haga nada, y hasta acá el bridge sólo se podía LEER
   *  (`getState()`), no ESCUCHAR: nadie en React se enteraba. Prohibido resolver esto con
   *  `setInterval` (CD-7): el dato ya llega por evento desde `useWallet()`.
   *
   *  ⚠️ `reset()` (`:173-180`) escribe `this.state` DIRECTO, sin pasar por `setState`, así que NO
   *  notifica a estos listeners. Es deliberado (`reset()` es test-only y su docblock ya avisa que
   *  tampoco vacía los listeners). Un test que quiera ver a un suscriptor volver a `null` tiene que
   *  llamar `setState({ publicKey: null, connected: false })`, no `reset()`. */
  subscribeState(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /**
   * WKH-MWA · ¿El selector de wallets ofrece HOY, en este navegador, la entrada de Mobile Wallet
   * Adapter?
   *
   * Es una MEDICIÓN, igual que `availability`: lo empuja el sync component leyendo la lista viva de
   * `useWallet().wallets` y comparando el nombre contra `MWA_WALLET_NAME`. Nadie mira el user agent
   * acá; quien lo mira es la librería, y esta bandera sólo reporta su conclusión.
   *
   * ⚠️ QUÉ SIGNIFICA Y QUÉ NO, porque las dos lecturas fáciles son falsas:
   *   · SÍ significa: la librería decidió que este navegador puede intentar una asociación local con
   *     una app de billetera, y por eso puso esa entrada en el selector.
   *   · NO significa que haya una app de billetera instalada en el teléfono. Eso no se puede saber
   *     desde el navegador, y es la misma honestidad que (`SolanaWalletAvailability`, `:27`).
   *   · NO significa que esa billetera vaya a poder firmar SIN enviar. La firma parcial es opcional
   *     en el protocolo MWA y se sabe recién al conectar (ver el docblock de `MWA_WALLET_NAME`).
   *
   * Arranca en `false` y no en un tercer valor "todavía no lo medimos" a propósito: nadie afirma nada
   * con `false`. Lo único que hace la pantalla con esta bandera es AGREGAR una salida; con `false` el
   * texto queda exactamente como estaba.
   */
  setMwaOffered(next: boolean): void {
    if (this.mwaOffered === next) return; // mismo guard que (`setWalletAvailability`, `:65`)
    this.mwaOffered = next;
    for (const listener of this.mwaListeners) listener();
  }

  getMwaOffered(): boolean {
    return this.mwaOffered;
  }

  /** Suscripción para `useSyncExternalStore`, mismo contrato que (`subscribeWalletAvailability`, `:78-83`):
   *  devuelve el desuscriptor. */
  subscribeMwaOffered(listener: () => void): () => void {
    this.mwaListeners.add(listener);
    return () => {
      this.mwaListeners.delete(listener);
    };
  }
}

/** Singleton compartido (browser). El sync component escribe, el adapter lee. */
export const solanaWalletBridge = new SolanaWalletBridge();

/**
 * WKH-MWA · El nombre con el que la librería publica la entrada de Mobile Wallet Adapter.
 *
 * 🔴 ESTO NO ES UNA FUNCIONALIDAD NUEVA, Y ESE ES EL HALLAZGO. `@solana/wallet-adapter-react@0.15.39`
 * YA antepone un `SolanaMobileWalletAdapter` a la lista de wallets cuando su propio `getEnvironment`
 * dice `MOBILE_WEB` (`node_modules/@solana/wallet-adapter-react/lib/cjs/WalletProvider.js:78-101`), y
 * `MOBILE_WEB` es exactamente: user agent Android, NO WebView, y ningún otro adapter en `Installed`
 * (`.../lib/cjs/getEnvironment.js:15-38`). O sea que en Chrome de Android esa entrada aparece en el
 * selector desde antes de esta HU, sin instalar nada.
 *
 * MEDIDO, montando el árbol real en jsdom (ver `wallet-availability.test.tsx`, T-MWA-*):
 *   · Android Chrome                    ⇒ `["Mobile Wallet Adapter" / Loadable]`
 *   · Android DENTRO de Phantom (WebView) ⇒ `[]`
 *   · iOS                                ⇒ `[]`
 *   · escritorio                         ⇒ `[]`
 * Las tres últimas son la garantía de que el camino que hoy funciona (el navegador interno de
 * Phantom) no ve esta entrada ni cuando está prendida la bandera: no hay nada que apagar ahí.
 *
 * ⚠️ EL VALOR ESTÁ ESCRITO ACÁ Y NO IMPORTADO, a propósito: importarlo obligaría a meter
 * `@solana-mobile/*` en el bundle de producción para leer una cadena de 21 caracteres. Lo que impide
 * que envejezca es un test que lo compara contra el nombre que la LIBRERÍA le pone al adapter que
 * produce (T-MWA-1), no un literal duplicado en el test.
 *
 * 🔴 QUÉ GARANTIZA EL ADAPTER Y QUÉ QUEDA A MERCED DE LA BILLETERA — leído en su código, no supuesto:
 *   · GARANTIZA que `signTransaction()` firma y DEVUELVE. Va derecho a `#performSignTransactions`
 *     (`@solana-mobile/wallet-adapter-mobile/lib/esm/index.browser.js:218-223`), que usa la feature
 *     `solana:signTransaction` si está, y si NO está TIRA
 *     `"Connected wallet does not support signing transactions"` (`:239` y `:252`). Nunca degrada a
 *     enviar. El único método que puede difundir es `sendTransaction()` (`:160-216`), que Chaski no
 *     llama en ningún lado y que T-MWA-3 vigila.
 *   · NO GARANTIZA que la billetera soporte esa feature. En el protocolo MWA `sign_transactions` es
 *     OPCIONAL: la lista de features sale de preguntarle a la app al conectar (`getCapabilities`,
 *     `@solana-mobile/wallet-standard-mobile/lib/esm/index.browser.js:1298`) y la feature se cae si la
 *     app no la declara (`:1326-1343`). Qué contesta Phantom en Android NO se puede leer del paquete,
 *     y por eso este archivo no lo afirma en ninguna línea.
 */
export const MWA_WALLET_NAME = "Mobile Wallet Adapter";
