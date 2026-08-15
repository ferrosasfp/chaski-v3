// @vitest-environment jsdom
//
// La razón de existir de este archivo es UNA carrera concreta que tenía la DApp sin poder conectar
// wallet desde un celular.
//
// El mecanismo, leído en la librería y no supuesto:
// `WalletModal.handleWalletClick` llama `select(name)` y acto seguido `handleClose()`, que hace
// `setTimeout(() => setVisible(false), 150)`
// (node_modules/@solana/wallet-adapter-react-ui/lib/cjs/WalletModal.js:65-76).
// O sea: 150 ms después de tocar una wallet, el modal se cierra SOLO, con la conexión todavía en
// curso. El efecto de cancelación miraba únicamente `!visible && !connected`, así que interpretaba
// ese cierre automático como "la persona se arrepintió" y rechazaba la espera con
// `wallet_connect_cancelled`. En el escritorio no se notaba (con la extensión ya autorizada la
// conexión resuelve antes de los 150 ms); en un teléfono, donde hay que leer un cartel y tocar
// aprobar, la carrera se perdía SIEMPRE.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// El enum REAL, a propósito: este archivo NO mockea `@solana/wallet-adapter-base`, así que los tests de
// la gracia usan los mismos valores que la librería le pone a cada adapter. Con strings escritos a mano
// un typo pasaría desapercibido y el criterio quedaría sin vigilar.
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { solanaWalletBridge } from "../../infrastructure/solana-wallet-bridge";

// Estado mutable de los hooks, compartido con las factorías de vi.mock (hoisted).
const h = vi.hoisted(() => ({
  wallet: {
    publicKey: null as { toBase58: () => string } | null,
    connected: false,
    connecting: false,
    signMessage: undefined as ((m: Uint8Array) => Promise<Uint8Array>) | undefined,
    signTransaction: undefined as ((t: unknown) => Promise<unknown>) | undefined,
    // La lista viva de adapters que expone `useWallet()`. Vacía por defecto: estos tests son sobre la
    // carrera del modal y el cableado de los firmantes, no sobre la detección.
    wallets: [] as Array<{ readyState: string }>,
  },
  modal: { visible: false, setVisible: (_v: boolean) => {} },
  /** Captura los props que SolanaProviders le pasa a WalletProvider (para probar el cableado). */
  walletProviderProps: {} as Record<string, unknown>,
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => h.wallet,
  ConnectionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  WalletProvider: (props: { children: React.ReactNode }) => {
    Object.assign(h.walletProviderProps, props);
    return <>{props.children}</>;
  },
}));
vi.mock("@solana/wallet-adapter-react-ui", () => ({
  useWalletModal: () => h.modal,
  WalletModalProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@solana/wallet-adapter-react-ui/styles.css", () => ({}));
vi.mock("@solana/wallet-adapter-wallets", () => ({
  PhantomWalletAdapter: class {},
  SolflareWalletAdapter: class {},
}));

import SolanaProviders, { SolanaWalletBridgeSync } from "./solana-providers";

/** Observa cómo termina la espera del adapter sin hacer que un reject sin manejar tumbe el test. */
function watchPending(): { outcome: () => string | null } {
  let outcome: string | null = null;
  solanaWalletBridge.waitForConnection(60_000).then(
    () => {
      outcome = "conectada";
    },
    (e: Error) => {
      outcome = e.message;
    },
  );
  return { outcome: () => outcome };
}

beforeEach(() => {
  solanaWalletBridge.reset();
  h.wallet = {
    publicKey: null,
    connected: false,
    connecting: false,
    signMessage: undefined,
    signTransaction: undefined,
    wallets: [],
  };
  h.modal = { visible: false, setVisible: () => {} };
  h.walletProviderProps = {};
});

afterEach(() => {
  cleanup();
  solanaWalletBridge.reset();
  vi.clearAllMocks();
});

describe("SolanaWalletBridgeSync — el auto-cierre del modal vs una conexión en curso", () => {
  it("T-RACE-1: el modal se cierra solo mientras la wallet conecta ⇒ NO cancela", async () => {
    const p = watchPending();
    h.modal = { visible: true, setVisible: () => {} }; // selector abierto
    const { rerender } = render(<SolanaWalletBridgeSync />);

    // La persona toca "Phantom": la lib arranca connect() ⇒ connecting = true.
    await act(async () => {
      h.wallet = { ...h.wallet, connecting: true };
      rerender(<SolanaWalletBridgeSync />);
    });

    // 150 ms después el modal se cierra SOLO, con la aprobación todavía pendiente en el teléfono.
    await act(async () => {
      h.modal = { visible: false, setVisible: () => {} };
      rerender(<SolanaWalletBridgeSync />);
    });

    // ⬅️ Con el código anterior acá había "wallet_connect_cancelled" y la DApp mostraba el error.
    expect(p.outcome()).toBeNull();

    // Y cuando por fin llega la aprobación, la espera resuelve normalmente.
    await act(async () => {
      solanaWalletBridge.setState({ publicKey: "9xQe", connected: true });
    });
    expect(p.outcome()).toBe("conectada");
  });

  it("T-RACE-2: el modal se cierra SIN conexión en curso ⇒ sí cancela (la persona salió)", async () => {
    // El par con T-RACE-1 es lo que hace válido el guard: borrar el efecto entero pasaría el
    // primero y rompería este; borrar el `!connecting` pasaría este y rompería el primero.
    const p = watchPending();
    h.modal = { visible: true, setVisible: () => {} };
    const { rerender } = render(<SolanaWalletBridgeSync />);

    await act(async () => {
      h.modal = { visible: false, setVisible: () => {} }; // cerró sin elegir nada
      rerender(<SolanaWalletBridgeSync />);
    });

    expect(p.outcome()).toBe("wallet_connect_cancelled");
  });
});

// El firmante de TRANSACCIONES nunca estuvo cableado: el bridge decía "lo registra el sync
// component" y el único `registerSignTransaction()` del repo vivía en los tests, que se lo pasaban a
// mano. O sea que los tests probaban el DOBLE y no el cableado, y en el navegador
// `signTransaction()` tiraba `wallet_sign_not_available` siempre: el depósito al escrow no se podía
// firmar desde la app en ninguna plataforma. Estos dos tests montan el árbol REAL y NO registran
// nada a mano: es la única forma de que el cableado ausente se vea.
describe("SolanaWalletBridgeSync — el firmante de transacciones sale del árbol, no del test", () => {
  it("T-SIGN-1: montar el árbol deja el bridge capaz de firmar la tx del depósito", async () => {
    const firmada = { firmada: true };
    const spy = vi.fn(async () => firmada);
    h.wallet = { ...h.wallet, signTransaction: spy };

    render(<SolanaWalletBridgeSync />);

    const tx = { deposito: 1 };
    // ⬅️ Antes de este arreglo, acá tiraba `wallet_sign_not_available`.
    await expect(solanaWalletBridge.signTransaction(tx)).resolves.toBe(firmada);
    expect(spy).toHaveBeenCalledWith(tx);
  });

  it("T-SIGN-2: si la wallet NO expone signTransaction, sigue siendo fail-loud", async () => {
    // El par que impide 'arreglarlo' registrando cualquier cosa: sin firmante real de la wallet, el
    // bridge tiene que negarse, JAMÁS firmar con otra clave.
    h.wallet = { ...h.wallet, signTransaction: undefined };
    render(<SolanaWalletBridgeSync />);
    await expect(solanaWalletBridge.signTransaction({})).rejects.toThrow("wallet_sign_not_available");
  });
});

// El firmante de MENSAJES tenía exactamente el mismo agujero que su gemelo de arriba, y se midió
// igual: borrando el efecto `registerSignMessage` de `solana-providers.tsx` la suite entera quedaba
// en 915/915 y `npm run qa` en exit 0. Los cuatro tests que lo ejercitan se registran el handle a
// mano (`solana-wallet.test.ts`, `solana-deposit-beneficiary.test.ts`), así que prueban el DOBLE y
// no el cableado. Importa más que antes: el SDD 037 convirtió `signMessage` en paso OBLIGATORIO del
// money-path (`solana-wallet.ts`, dentro de `authorizePrincipal`), o sea que sin este efecto el
// depósito no se puede autorizar desde el navegador en ninguna plataforma. Estos dos montan el árbol
// REAL y NO registran nada a mano.
describe("SolanaWalletBridgeSync — el firmante de mensajes sale del árbol, no del test", () => {
  it("T-SIGN-3: montar el árbol deja el bridge capaz de firmar el mensaje de patrocinio", async () => {
    const firma = new Uint8Array([1, 2, 3]);
    const spy = vi.fn(async () => firma);
    // El beforeEach deja `signMessage: undefined`, así que hay que ponerlo ACÁ y antes del render:
    // el efecto sólo registra si la wallet lo expone.
    h.wallet = { ...h.wallet, signMessage: spy };

    render(<SolanaWalletBridgeSync />);

    const mensaje = new TextEncoder().encode("WasiAI Sponsor Request v1");
    // ⬅️ Sin el efecto de cableado, acá tira `wallet_sign_not_available`.
    await expect(solanaWalletBridge.signMessage(mensaje)).resolves.toBe(firma);
    expect(spy).toHaveBeenCalledWith(mensaje);
  });

  it("T-SIGN-4: si la wallet NO expone signMessage, sigue siendo fail-loud", async () => {
    // El par que impide 'arreglarlo' registrando cualquier cosa: sin firmante real de la wallet, el
    // bridge tiene que negarse. Firmar el mensaje de patrocinio con otra clave sería peor que no
    // firmarlo: el facilitator lo verifica contra el pubkey que sale de la transacción.
    h.wallet = { ...h.wallet, signMessage: undefined };
    render(<SolanaWalletBridgeSync />);
    await expect(solanaWalletBridge.signMessage(new Uint8Array([0]))).rejects.toThrow(
      "wallet_sign_not_available",
    );
  });
});

describe("SolanaProviders — cableado de onError", () => {
  it("T-ERR-1: le pasa un onError a WalletProvider que corta la espera con la causa real", async () => {
    const p = watchPending();
    render(
      <SolanaProviders>
        <div />
      </SolanaProviders>,
    );

    const onError = h.walletProviderProps.onError as ((e: unknown) => void) | undefined;
    expect(typeof onError).toBe("function");

    // La lib entrega el WalletError acá y en ningún otro lado.
    //
    // El error inyectado era `WalletNotReadyError`, que ya no tiene código propio: su copy afirmaba
    // qué wallet había instalada en el dispositivo y nadie podía leerlo (la app no llama
    // `useWallet().connect()`, el único disparador de esa excepción). Se cambió por uno que SÍ
    // tiene traducción, porque lo que este test prueba es el cableado con una causa concreta: con un
    // nombre que cae en la rama de los desconocidos, un `onError` que no tradujera nada pasaría igual.
    await act(async () => {
      onError?.(Object.assign(new Error("boom"), { name: "WalletWindowClosedError" }));
    });

    expect(p.outcome()).toBe("wallet_window_closed");
  });

  it("T-ERR-2: un error de wallet sin espera en curso no inventa un rechazo", async () => {
    render(
      <SolanaProviders>
        <div />
      </SolanaProviders>,
    );
    const onError = h.walletProviderProps.onError as ((e: unknown) => void) | undefined;
    // Sin waitForConnection() previo no hay nada que rechazar: debe ser no-op, no un throw.
    expect(() =>
      onError?.(Object.assign(new Error("boom"), { name: "WalletConnectionError" })),
    ).not.toThrow();
  });
});

// ── WKH-341 / D-5 — la OTRA carrera: la de la disponibilidad ───────────────────────────────────────
//
// EL DEFECTO, medido en la fuente de la librería y no supuesto. El efecto de disponibilidad escribía
// `"none"` en el PRIMER render tras el montaje si ningún adapter reportaba `Installed`. Y en ese primer
// render la lista de Wallet Standard es la foto SÍNCRONA de
// node_modules/@solana/wallet-standard-wallet-adapter-react/src/useStandardWalletAdapters.ts:10: las
// altas llegan después, por `on('register')` (:12-26). O sea que un teléfono DENTRO del navegador de
// Phantom veía "no vemos ninguna wallet" en la única puerta de entrada de la app, y lo veía antes de
// que hubiera con qué decirlo.
//
// El arreglo es una gracia corta anclada al MONTAJE (dos efectos, ver `solana-providers.tsx`). Estos
// siete tests clavan, en orden de importancia:
//   1. que después de la gracia el aviso SÍ aparece (T-341-7/8) — sin esto el arreglo sería "nunca
//      avisar", que rompe justo el caso que AC-5 protege;
//   2. que la pared NO se desliza con cada `readyStateChange` (T-341-9);
//   3. que un alta tardía cancela el aviso sin pasar por `"none"` (T-341-10/11);
//   4. que el criterio sigue siendo `Installed` y NADA más (T-341-12);
//   5. que antes de la gracia el estado es `"unknown"`, no `"none"` (T-341-13).
//
// ⚠️ CD-8 — POR QUÉ LOS NÚMEROS VAN LITERALES (`1499`, `1500`) Y NO SE IMPORTA `WALLET_GRACE_MS`.
// Un test que avanzara el reloj por la propia constante que vigila pasaría con CUALQUIER valor,
// incluidos diez minutos: sería un guard que se compara consigo mismo y aplaudiría cualquier cosa. En
// este repo eso ya pasó y tiene su lección escrita. La frontera 1499/1500 está en literales a
// propósito, y si alguien mueve la constante estos tests se ponen rojos — que es todo el punto.
//
// ⚠️ NADA DE DORMIR: se avanza un reloj FALSO. Ningún test de este bloque tarda 1.5 s de verdad.
//
// 📋 T-341-15 (AC-8) — SIN TEST, Y ESTE ES EL MOTIVO. El AC pedía verificar que
// `@solana-mobile/wallet-adapter-mobile` esté presente (es lo que hace que Wallet Standard registre la
// wallet en un teléfono). MEDIDO: está presente, instalado ANIDADO en
// node_modules/@solana/wallet-adapter-react/node_modules/@solana-mobile/wallet-adapter-mobile/. La
// sonda válida es la del consumidor —`require.resolve(pkg, {paths:["node_modules/@solana/wallet-adapter-react/lib/cjs"]})`
// resuelve, y `require("@solana/wallet-adapter-react")` carga OK—. Las sondas que miran sólo la raíz
// (`ls node_modules/@solana-mobile/…`, o un `require.resolve` desde la raíz) dicen "ausente" y están
// EQUIVOCADAS: sólo miden la posición hoisted. No hay test porque un test que resolviera ese paquete
// no protegería ninguna línea del código de esta HU: vigilaría el árbol de npm, no el nuestro.
describe("SolanaWalletBridgeSync — la gracia antes de afirmar 'acá no hay ninguna wallet'", () => {
  // Local a este describe para NO contaminar los T-RACE-*/T-SIGN-*/T-ERR- de arriba, que corren con
  // timers reales. Los hooks anidados corren antes que el `afterEach` de archivo.
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Monta el sync component con una lista de adapters dada y el reloj ya falseado. */
  function montar(readyStates: string[]) {
    vi.useFakeTimers();
    h.wallet = { ...h.wallet, wallets: readyStates.map((readyState) => ({ readyState })) };
    return render(<SolanaWalletBridgeSync />);
  }

  /** Cambia la lista de adapters con una identidad NUEVA (es lo que dispara el efecto A). */
  async function cambiarWallets(
    rerender: (ui: React.ReactElement) => void,
    readyStates: string[],
  ) {
    await act(async () => {
      h.wallet = { ...h.wallet, wallets: readyStates.map((readyState) => ({ readyState })) };
      rerender(<SolanaWalletBridgeSync />);
    });
  }

  async function avanzar(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  }

  it("T-341-7 (AC-5): sin ninguna wallet, pasada la gracia el aviso SÍ aparece", async () => {
    // 🔴 EL TEST QUE PROTEGE LA PUERTA DE ENTRADA. Es el que impide "arreglar" D-5 no avisando nunca.
    // INPUT QUE LO PONE EN ROJO: borrar el efecto B (el del setTimeout); o implementar la variante
    // descartada de "esperar a que la lista cambie al menos una vez" — en un escritorio pelado no
    // llega NINGÚN cambio nunca y el estado quedaría en `"unknown"` para siempre.
    montar([]);
    await avanzar(1500);
    expect(solanaWalletBridge.getWalletAvailability()).toBe("none");
  });

  it("T-341-8 (AC-5): la frontera — a 1499 ms todavía no se afirma nada, a 1500 sí", async () => {
    // Los números van LITERALES, no importados de `WALLET_GRACE_MS` (CD-8, ver el docblock de arriba).
    // INPUT QUE LO PONE EN ROJO: subir la gracia a 5000 ⇒ a 1500 sigue en `"unknown"`. Y bajarla a 0
    // ⇒ a 1499 ya es `"none"`. Los dos lados de la pared quedan clavados.
    montar([]);
    await avanzar(1499);
    expect(solanaWalletBridge.getWalletAvailability()).toBe("unknown");
    await avanzar(1);
    expect(solanaWalletBridge.getWalletAvailability()).toBe("none");
  });

  it("T-341-9 (AC-5): la pared NO se desliza con cada cambio de la lista de adapters", async () => {
    // 🔴 ESTE ES EL TEST DEL MECANISMO, no del resultado. La identidad de `wallets` cambia en cada
    // `readyStateChange` (WalletProviderBase.js:104-118). Si el timer se re-armara —un `clearTimeout`
    // en el cleanup de `[wallets]`— el retraso total pasaría a depender de cuántas transiciones emita
    // la librería, y con dos cambios el aviso llegaría a t=2500 en vez de t=1500.
    // INPUT QUE LO PONE EN ROJO: exactamente esa versión con `clearTimeout` en el cleanup de
    // `[wallets]` ⇒ a t=1500 sigue en `"unknown"`.
    const { rerender } = montar([]);
    await avanzar(500);
    await cambiarWallets(rerender, [WalletReadyState.NotDetected]);
    await avanzar(500); // t = 1000
    await cambiarWallets(rerender, [WalletReadyState.NotDetected, WalletReadyState.Loadable]);
    expect(solanaWalletBridge.getWalletAvailability()).toBe("unknown");
    await avanzar(500); // t = 1500 EXACTO
    expect(solanaWalletBridge.getWalletAvailability()).toBe("none");
  });

  it("T-341-10 (AC-6): un alta DENTRO de la gracia nunca deja pasar por 'none'", async () => {
    // Lo que este test observa no es el estado final, es el CAMINO: `subscribeWalletAvailability`
    // registra cada transición, así que un destello de `"none"` de un solo cuadro se ve igual.
    // INPUT QUE LO PONE EN ROJO: el código anterior a esta HU, que escribía
    // `hayInstalada ? "injected" : "none"` en el primer efecto ⇒ el camino arranca con `"none"`.
    const transiciones: string[] = [];
    const desuscribir = solanaWalletBridge.subscribeWalletAvailability(() => {
      transiciones.push(solanaWalletBridge.getWalletAvailability());
    });
    try {
      const { rerender } = montar([]);
      await avanzar(800);
      await cambiarWallets(rerender, [WalletReadyState.Installed]);
      expect(solanaWalletBridge.getWalletAvailability()).toBe("injected");
      // Y la gracia que ya estaba en curso no lo pisa cuando vence.
      await avanzar(2200); // t = 3000
      expect(solanaWalletBridge.getWalletAvailability()).toBe("injected");
      expect(transiciones).not.toContain("none");
      expect(transiciones).toContain("injected");
    } finally {
      desuscribir();
    }
  });

  it("T-341-11 (AC-6): un alta DESPUÉS de la gracia corrige el aviso sin remontar nada", async () => {
    // Sin esto, alguien que abre la app en el navegador de Phantom, ve el aviso y recién entonces
    // instala/desbloquea la wallet quedaría con el cartel puesto hasta recargar. No hay interacción ni
    // remontaje en este test: sólo llega el alta.
    // INPUT QUE LO PONE EN ROJO: cambiar las deps del efecto A de `[wallets]` a `[]` ⇒ queda clavado
    // en `"none"`.
    const { rerender } = montar([]);
    await avanzar(1500);
    expect(solanaWalletBridge.getWalletAvailability()).toBe("none");
    await cambiarWallets(rerender, [WalletReadyState.Installed]);
    expect(solanaWalletBridge.getWalletAvailability()).toBe("injected");
  });

  it("T-341-12 (CD-1): `Loadable` NO cuenta como wallet presente", async () => {
    // 🔴 EL PAR OBLIGATORIO. Sin este test, T-341-10 se pasa "arreglando" D-5 con
    // `readyState !== NotDetected`, y eso borraría el aviso en TODO dispositivo: Solflare fija
    // `Loadable` en su CONSTRUCTOR
    // (node_modules/@solana/wallet-adapter-solflare/lib/cjs/adapter.js:67-69), o sea que hay un
    // `Loadable` en la lista incluso en un escritorio sin ninguna extensión instalada.
    // INPUT QUE LO PONE EN ROJO: aceptar `Loadable` en el criterio ⇒ da `"injected"`.
    montar([WalletReadyState.Loadable]);
    await avanzar(1500);
    expect(solanaWalletBridge.getWalletAvailability()).toBe("none");
  });

  it("T-341-13 (CD-2): antes de la gracia el estado es 'unknown', que no afirma nada", async () => {
    // `"unknown"` es lo que hace que `NoWalletHere` NO pinte: su guard es
    // `if (availability !== "none") return null;` (`flow.tsx:1221`).
    //
    // ⚠️ ESTE TEST CUBRE LA MITAD DEL AC, Y LA OTRA MITAD LA CUBRE OTRO. El Story File pedía además
    // que "`NoWalletHere` no pinta". Este archivo NO puede probar eso: mockea entero el árbol de
    // `@solana/wallet-adapter-*` y nunca renderiza la pantalla. La pata de PANTALLA está cubierta por
    // (`T-UI-1`, `wallet-availability.test.tsx:179`), que renderiza el flujo real y asierta que con
    // `"unknown"` el aviso NO está en el DOM y con `"none"` sí. Acá se prueba el VALOR, allá la
    // PANTALLA — y hacen falta los dos.
    //
    // Acá vivía un `expect(...).not.toBe("none")` puesto inmediatamente después del `toBe("unknown")`.
    // Se borró: era un assert que NO PODÍA FALLAR, y un assert que no puede fallar es peor que no
    // tenerlo porque se cuenta como cobertura.
    //
    // INPUT QUE LO PONE EN ROJO: escribir `"none"` de arranque (el código anterior a esta HU).
    montar([]);
    expect(solanaWalletBridge.getWalletAvailability()).toBe("unknown");
  });
});

// ── WKH-354/AC-1 ─────────────────────────────────────────────────────────────────────────────────
// Hasta acá el bridge sólo se podía LEER (`getState()`), y la cuenta activa de la wallet cambia SIN
// que la app haga nada: nadie en React se enteraba. Estos tres montan el árbol REAL y no registran
// ningún listener a mano en el efecto — el estado que empuja `useWallet()` es el de `h.wallet`.
//
// ⚠️ NINGUNO usa `solanaWalletBridge.reset()` para volver a `null`: `reset()` escribe `this.state`
// DIRECTO, sin pasar por `setState`, así que NO notifica a los `stateListeners` (es correcto y
// deliberado; su docblock ya avisa que tampoco vacía los listeners). Para eso está
// `setState({ publicKey: null, connected: false })`.
describe("SolanaWalletBridgeSync — WKH-354/AC-1: el bridge ahora se puede ESCUCHAR", () => {
  const CUENTA_B = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8";

  it("T-354-1: la persona cambia de cuenta en la wallet ⇒ los suscriptores se enteran y el bridge ya tiene la nueva", async () => {
    const listener = vi.fn();
    const off = solanaWalletBridge.subscribeState(listener);
    const { rerender } = render(<SolanaWalletBridgeSync />);

    // Phantom pasa a la cuenta B sin que la app haga nada: `useWallet()` emite otro publicKey.
    await act(async () => {
      h.wallet = { ...h.wallet, publicKey: { toBase58: () => CUENTA_B }, connected: true };
      rerender(<SolanaWalletBridgeSync />);
    });

    // (i) alguien avisó. Sin la notificación de `setState`, esto queda en 0.
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(1);
    // (ii) y cuando avisó, el estado YA era el nuevo (la notificación va después de asignarlo).
    expect(solanaWalletBridge.getState().publicKey).toBe(CUENTA_B);
    off();
  });

  it("T-354-1b: el desuscriptor desuscribe de verdad (no un `() => {}` de adorno)", async () => {
    const listener = vi.fn();
    const off = solanaWalletBridge.subscribeState(listener);

    solanaWalletBridge.setState({ publicKey: CUENTA_B, connected: true });
    const despuesDeUnCambio = listener.mock.calls.length;
    expect(despuesDeUnCambio).toBeGreaterThanOrEqual(1);

    off();
    // Otro cambio REAL después de desuscribirse: el conteo no se mueve.
    solanaWalletBridge.setState({ publicKey: null, connected: false });
    expect(listener.mock.calls.length).toBe(despuesDeUnCambio);
  });

  it("T-354-1c: `setState` con el MISMO estado NO notifica (el guard que evita el loop de render)", async () => {
    // Se arranca desde un estado distinto para que la PRIMERA llamada sí sea un cambio.
    solanaWalletBridge.setState({ publicKey: null, connected: false });
    const listener = vi.fn();
    const off = solanaWalletBridge.subscribeState(listener);

    solanaWalletBridge.setState({ publicKey: CUENTA_B, connected: true });
    solanaWalletBridge.setState({ publicKey: CUENTA_B, connected: true }); // idéntico: no hay nada que avisar

    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});
