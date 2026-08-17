// @vitest-environment jsdom
//
// EL AGUJERO QUE ESTOS TESTS TAPAN, medido antes de escribir una línea de arreglo.
//
// Con la librería REAL en jsdom, user agent de Android y NINGUNA wallet inyectada:
//   · `Phantom=NotDetected, Solflare=Loadable`
//   · el selector igual lista Phantom, con el título en inglés "Connect a wallet on Solana to continue"
//   · al tocar Phantom, `WalletProviderBase` sale EN SILENCIO porque el readyState no es `Installed`
//     ni `Loadable` (`WalletProviderBase.js`:166-172): no intenta conectar y no emite ningún error
//   · 150 ms después el selector se cierra solo y la espera termina en `wallet_connect_cancelled`
// O sea que la persona leía "Se cerró el selector de wallet sin conectar", que le atribuye una acción
// que no hizo, y el copy de `no_wallet` (`flow-vm.ts:253`) NUNCA aparecía por ese camino.
//
// Dos capas, a propósito:
//   (B) CABLEADO — monta el árbol de providers REAL y NO llama a `setWalletAvailability` a mano. Es lo
//       único que prueba que la condición sale del `readyState` de la librería. Sin esta capa, la
//       función no tendría ningún productor fuera de los tests.
//   (A) PANTALLA — renderiza `RemittanceFlow`, el componente real, y comprueba qué lee la persona.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RemittanceFlow } from "./flow";
import { phantomBrowseUrl } from "./wallet-availability"; import { humanError } from "./flow-vm"; import { mwaErrorCode } from "./solana/wallet-error-code"; // WKH-MWA: los dos EN ESTA LÍNEA — `wallet-availability.test.tsx:62` lo cita `tx-proof.test.tsx:84` por número
import { MWA_WALLET_NAME, solanaWalletBridge } from "../infrastructure/solana-wallet-bridge"; import { useWallet } from "@solana/wallet-adapter-react"; import { useWalletModal } from "@solana/wallet-adapter-react-ui"; // WKH-MWA: los dos imports EN ESTA LÍNEA — `wallet-availability.test.tsx:62` lo cita `tx-proof.test.tsx:84` por número, y agregar una línea acá lo correría
import { buildTestContainer } from "../test-support/test-container";
import { TEST_CCI } from "../test-support/fakes";

// El barrel `@solana/wallet-adapter-wallets` arrastra el adapter de Ledger, que no resuelve bajo
// vitest. Se reemplaza por los adapters REALES de sus propios paquetes: lo único que se saltea es el
// re-export, la detección que se está probando sigue siendo la de la librería.
vi.mock("@solana/wallet-adapter-wallets", async () => {
  const p = await import("@solana/wallet-adapter-phantom");
  const s = await import("@solana/wallet-adapter-solflare");
  return {
    PhantomWalletAdapter: p.PhantomWalletAdapter,
    SolflareWalletAdapter: s.SolflareWalletAdapter,
  };
});

// CD-8 / DT-7: framer-motion pass-through (mismo mock que flow.test.tsx). jsdom no implementa
// requestAnimationFrame y sin esto los steps del flujo nunca montan.
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  // Lista CERRADA: lo que no esté acá no existe para este archivo, y el faltante tira TODA la
  // suite del archivo, no un test. Ver el docblock del mismo doble en `flow.test.tsx`.
  MotionConfig: ({ children }: { children: React.ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
          React.createElement(tag, props, children),
    },
  ),
}));

const UA_ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const UA_ESCRITORIO =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function setUserAgent(value: string): void {
  Object.defineProperty(window.navigator, "userAgent", { value, configurable: true });
}

/** Inyecta una wallet en el scope global, como hace la extensión del escritorio y como hace el
 *  navegador interno de Phantom en el celular. Los dos nombres son los que la librería sondea
 *  (`@solana/wallet-adapter-phantom/lib/cjs/adapter.js`: `window.isPhantomInstalled` +
 *  `window.phantom.solana.isPhantom`). */
function inyectarWallet(): void {
  const solana = {
    isPhantom: true,
    isConnected: false,
    publicKey: { toBytes: () => new Uint8Array(32).fill(1) },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
  };
  const w = window as unknown as Record<string, unknown>;
  w.isPhantomInstalled = true;
  w.phantom = { solana };
  w.solana = solana;
}

function quitarWalletInyectada(): void {
  const w = window as unknown as Record<string, unknown>;
  w.isPhantomInstalled = undefined;
  w.phantom = undefined;
  w.solana = undefined;
}

beforeEach(() => {
  solanaWalletBridge.reset();
  quitarWalletInyectada();
  setUserAgent(UA_ESCRITORIO);
  window.history.replaceState({}, "", "/"); window.localStorage.clear(); // WKH-MWA: EN ESTA LÍNEA (no correr `:62`). `WalletProvider` PERSISTE la wallet elegida en `localStorage["walletName"]` (WalletProvider.js:102), así que sin esto un test que elige MWA deja al siguiente con la wallet ya seleccionada y ya autoconectada desde el montaje: `select()` sale por `if (walletName === nextWalletName) return` y no arranca ninguna asociación. Medido: T-CANCEL-1 y T-CANCEL-2 pasaban en aislamiento y fallaban en la corrida del archivo.
});

afterEach(() => {
  cleanup();
  solanaWalletBridge.reset();
  quitarWalletInyectada();
  vi.clearAllMocks(); vi.unstubAllEnvs(); vi.restoreAllMocks(); // WKH-MWA: los tres EN ESTA LÍNEA, para no correr `:62` (lo cita `tx-proof.test.tsx:84`). `unstubAllEnvs` apaga la bandera de MWA entre tests; sin él T-MWA-5 heredaría el `true` de T-MWA-3
});

// ── (B) CABLEADO: la condición sale de la librería, no de un doble ────────────────────────────────
async function montarArbolYLeerDisponibilidad(esperaMs = 1200): Promise<string> {
  const { default: SolanaProviders } = await import("./solana/solana-providers");
  await act(async () => {
    render(
      <SolanaProviders>
        <div />
      </SolanaProviders>,
    );
  });
  // La detección de la librería es asíncrona (poliza el scope global cada segundo,
  // `scopePollingDetectionStrategy`), así que se le da tiempo a más de un tick.
  await act(async () => {
    await new Promise((r) => setTimeout(r, esperaMs));
  });
  return solanaWalletBridge.getWalletAvailability();
}

describe("cableado: el árbol REAL empuja la disponibilidad, nadie la setea a mano", () => {
  it("T-CABLE-1: celular sin wallet inyectada ⇒ 'none'", async () => {
    setUserAgent(UA_ANDROID_CHROME);
    // ⬅️ Invertir la condición de `solana-providers.tsx` (Installed → !== Installed) mata este test.
    //
    // La espera se subió de 1200 ms a 1700 (WKH-341/D-5). MEDIDO: con 1200 este test daba
    // «expected 'unknown' to be 'none'». No es un flake ni un timeout de infra: desde D-5 el árbol NO
    // afirma `"none"` en el primer efecto, espera una gracia de `WALLET_GRACE_MS` (1500 ms) anclada al
    // montaje, porque el primer render trae la foto SÍNCRONA de la lista de wallets y un teléfono
    // DENTRO de Phantom perdía esa carrera. O sea que a los 1200 ms el valor correcto es `"unknown"`.
    //
    // Estos 1700 ms son de reloj REAL a propósito, y es lo que hace valioso a este test: es el único
    // que ejercita la librería de verdad (los adapters reales, el polling real) en vez de un reloj
    // falso. Los tests de la frontera 1499/1500 viven en `solana-providers.test.tsx` (T-341-7/8) y ésos
    // sí avanzan un reloj falso. Si alguien sube la gracia por encima de 1700, este test se pone rojo
    // — y eso es correcto: querría decir que un teléfono sin wallet tarda más de 1.7 s en enterarse.
    expect(await montarArbolYLeerDisponibilidad(1700)).toBe("none");
  });

  it("T-CABLE-2: celular DENTRO del navegador de Phantom ⇒ 'injected' (user agent de celular igual)", async () => {
    // Este es el par que impide 'arreglarlo' mirando el user agent: mismo teléfono, misma cadena de
    // user agent que T-CABLE-1, y acá SÍ hay wallet. La pregunta que decide es "¿hay wallet acá?".
    setUserAgent(UA_ANDROID_CHROME);
    inyectarWallet();
    expect(await montarArbolYLeerDisponibilidad()).toBe("injected");
  });

  it("T-CABLE-3: escritorio con la extensión ⇒ 'injected'", async () => {
    setUserAgent(UA_ESCRITORIO);
    inyectarWallet();
    expect(await montarArbolYLeerDisponibilidad()).toBe("injected");
  });

  it("T-CABLE-4: antes de montar el árbol la disponibilidad es 'unknown', no 'none'", () => {
    // Sin haber medido nada no se afirma nada. Si el valor inicial fuera "none", la pantalla
    // acusaría de "no hay wallet" durante el primer cuadro de CUALQUIER navegador, escritorio incluido.
    expect(solanaWalletBridge.getWalletAvailability()).toBe("unknown");
  });
});

// ── (A) PANTALLA: qué lee la persona ──────────────────────────────────────────────────────────────
const AVISO = /No vemos ninguna wallet en este navegador/;
const CAMINO = /Abrir Chaski en Phantom/;

/** Renderiza el flujo real y avanza hasta el paso `connect`, que es donde vive el botón de conectar. */
function irAlPasoConectar(): void {
  render(<RemittanceFlow container={buildTestContainer()} />);
  fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), {
    target: { value: "Mamá" },
  });
  fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), { target: { value: TEST_CCI } });
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
}

describe("la pantalla de conectar dice la verdad cuando no hay wallet en este navegador", () => {
  it("T-UI-1: sin wallet disponible ⇒ aparece el aviso Y el camino", async () => {
    irAlPasoConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });
    // Hasta que no se midió nada, no se afirma nada.
    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();

    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
    });

    expect(screen.getByText(AVISO)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: CAMINO })).toBeInTheDocument();
    // El botón de conectar SIGUE ahí: la persona puede desbloquear la extensión y reintentar, y
    // deshabilitarlo sería afirmar que ese camino está muerto.
    expect(screen.getByRole("button", { name: /Conectar wallet/ })).toBeInTheDocument();
  });

  it("T-UI-2: el texto NO afirma nada sobre lo que hay instalado en el dispositivo", async () => {
    irAlPasoConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
    });

    const texto = (screen.getByText(AVISO).closest("div")?.parentElement?.textContent ?? "").trim();
    // Lo que sí dice: que el navegador no expone ninguna, y que eso no habla de lo instalado.
    expect(texto).toContain("Esto no dice si tenés una wallet instalada");
    // Lo que NO puede decir: nadie desde el navegador puede saber qué hay instalado en el teléfono.
    // Alguien con Phantom en el celular, mirando esta misma pantalla en Chrome, leería una mentira.
    expect(texto).not.toMatch(/no ten[ée]s Phantom/i);
    expect(texto).not.toMatch(/no est[áa] instalad/i);
    expect(texto).not.toMatch(/instal[áa] Phantom en tu (celular|tel[ée]fono)/i);
    // Sin em dashes en el copy que ve la persona.
    expect(texto).not.toContain("—");
  });

  it("T-UI-3: CON wallet inyectada la pantalla queda EXACTAMENTE como estaba", async () => {
    irAlPasoConectar();
    const antes = (await screen.findByText(/Conectá tu wallet/)).closest("div")?.parentElement
      ?.parentElement?.innerHTML;

    await act(async () => {
      solanaWalletBridge.setWalletAvailability("injected");
    });

    // ⬅️ ESTE ES EL TEST QUE PROTEGE EL ESCRITORIO. Hacer que el aviso aparezca también con wallet
    // inyectada lo mata: el HTML del paso deja de ser idéntico y el aviso aparece.
    const despues = screen.getByText(/Conectá tu wallet/).closest("div")?.parentElement?.parentElement
      ?.innerHTML;
    expect(despues).toBe(antes);
    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: CAMINO })).not.toBeInTheDocument();

    // Y el camino de siempre sigue funcionando igual: conectar lleva al review.
    fireEvent.click(screen.getByRole("button", { name: /Conectar wallet/ }));
    await screen.findByText(/Revisá el envío/);
  });

  it("T-UI-4: celular DENTRO del navegador de Phantom ⇒ camino normal, sin aviso", async () => {
    // Wallet presente + user agent de celular. Si el arreglo mirara el user agent, acá saldría el
    // aviso y la demo del founder tendría un cartel de error en la pantalla que sí funciona.
    setUserAgent(UA_ANDROID_CHROME);
    irAlPasoConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("injected");
    });

    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Conectar wallet/ }));
    await screen.findByText(/Revisá el envío/);
  });
});

describe("el enlace lleva a ESTA DApp adentro de Phantom", () => {
  it("T-LINK-1: el href del aviso apunta a la URL viva de la página, query string incluida", async () => {
    // Con query string a propósito: el flujo del KYC vuelve a `/?kyc=return`, y un `?` sin encodear se
    // comería el `?ref=` del universal link.
    window.history.replaceState({}, "", "/?kyc=return");
    irAlPasoConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
    });

    // Literal, NO recalculado con la misma función que se está probando.
    expect(screen.getByRole("link", { name: CAMINO })).toHaveAttribute(
      "href",
      "https://phantom.app/ul/browse/http%3A%2F%2Flocalhost%3A3000%2F%3Fkyc%3Dreturn?ref=http%3A%2F%2Flocalhost%3A3000",
    );
  });

  // ── WKH-354/AC-1 · el hook de la cuenta activa ─────────────────────────────────────────────────
  //
  // ⚠️ El `afterEach` de este archivo llama `solanaWalletBridge.reset()`, y `reset()` escribe
  // `this.state` DIRECTO, sin pasar por `setState`: NO notifica a los `stateListeners`. Por eso este
  // test vuelve a `null` con `setState({ publicKey: null, connected: false })` explícito y no con
  // `reset()` — con `reset()` el componente montado se quedaría mostrando el valor viejo y el test
  // estaría midiendo el bug que dice prevenir.
  it("T-354-1d: `useConnectedWalletAddress` sigue a la cuenta viva SIN remontar nada", async () => {
    const { useConnectedWalletAddress } = await import("./wallet-availability");
    const CUENTA_B = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8";
    function Sonda() {
      return <span data-testid="cuenta">{useConnectedWalletAddress() ?? "sin-cuenta"}</span>;
    }

    render(<Sonda />);
    // (i) arranca sin cuenta: `null` es "no hay ninguna billetera conectada".
    expect(screen.getByTestId("cuenta")).toHaveTextContent("sin-cuenta");

    // (ii) la wallet activa otra cuenta y el MISMO árbol montado la muestra. Con un `useState` de
    //      lectura única (el patrón que esta HU vino a matar) acá seguiría diciendo "sin-cuenta".
    await act(async () => {
      solanaWalletBridge.setState({ publicKey: CUENTA_B, connected: true });
    });
    expect(screen.getByTestId("cuenta")).toHaveTextContent(CUENTA_B);

    // Y vuelve, por el camino que SÍ notifica.
    await act(async () => {
      solanaWalletBridge.setState({ publicKey: null, connected: false });
    });
    expect(screen.getByTestId("cuenta")).toHaveTextContent("sin-cuenta");
  });

  it("T-354-1d(server): el snapshot del servidor es `null`, no una dirección", async () => {
    // (iii) El servidor no sabe qué tiene conectado el navegador de nadie. Se mide el 3er argumento
    // de `useSyncExternalStore` por el mismo camino que lo usa React: renderizando a string en el
    // servidor, sin DOM. Un `getServerSnapshot` que devolviera la dirección haría que el HTML del
    // servidor afirme una billetera que nadie conectó.
    const { renderToString } = await import("react-dom/server");
    const { useConnectedWalletAddress } = await import("./wallet-availability");
    solanaWalletBridge.setState({ publicKey: "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8", connected: true });
    function Sonda() {
      return <span>{useConnectedWalletAddress() ?? "sin-cuenta"}</span>;
    }
    expect(renderToString(<Sonda />)).toContain("sin-cuenta");
  });

  it("T-LINK-2: el esquema es el MISMO que dispara la librería en iOS", () => {
    // Copiado de la rama `readyState === Loadable` de
    // `node_modules/@solana/wallet-adapter-phantom/lib/cjs/adapter.js`:
    //   window.location.href = `https://phantom.app/ul/browse/${url}?ref=${ref}`
    // con url/ref encodeURIComponent. No es un esquema inventado por nosotros.
    expect(phantomBrowseUrl("https://chaski.app/?a=1&b=2", "https://chaski.app")).toBe(
      "https://phantom.app/ul/browse/https%3A%2F%2Fchaski.app%2F%3Fa%3D1%26b%3D2?ref=https%3A%2F%2Fchaski.app",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-MWA · Mobile Wallet Adapter en Android
//
// 🔴 EL HALLAZGO QUE ORDENA TODO ESTE BLOQUE, y que da vuelta la premisa con la que se abrió la HU:
// **MWA no hay que instalarlo, ya está.** `@solana/wallet-adapter-react@0.15.39` antepone un
// `SolanaMobileWalletAdapter` a la lista de wallets por su cuenta cuando su propio `getEnvironment`
// dice `MOBILE_WEB` (`node_modules/@solana/wallet-adapter-react/lib/cjs/WalletProvider.js:78-101` y
// `.../getEnvironment.js:15-38`), y `@solana-mobile/wallet-adapter-mobile` ya figura en el
// `package-lock.json` commiteado como dependencia suya. La entrada existe en Chrome de Android desde
// antes de esta rama, sin agregar un solo paquete.
//
// POR QUÉ ESTOS TESTS VIVEN EN ESTE ARCHIVO Y NO EN UNO NUEVO: dos razones, las dos sustantivas.
//   1. Es el único archivo de la suite que monta el árbol REAL sin mockear
//      `@solana/wallet-adapter-react` (`solana-providers.test.tsx` lo mockea entero, así que allá no
//      existiría ningún adapter de MWA que medir: se estaría midiendo el doble).
//   2. Un archivo nuevo mueve el conteo que vigila `readme-test-count.test.ts` y obliga a tocar los
//      dos README, que en esta ventana los está escribiendo otra persona.
//
// ⚠️ LO QUE ESTE BLOQUE **NO** PUEDE PROBAR, dicho como tal y no escondido: si Phantom en Android
// soporta `sign_transactions` (firmar SIN enviar). Eso es comportamiento de un tercero, se sabe recién
// al conectar contra la app instalada y no se puede leer de ningún paquete ni montar en jsdom. Nada de
// acá abajo lo afirma. La verificación es un teléfono.

/** El nombre que Chaski tiene escrito en `MWA_WALLET_NAME`. T-MWA-2 lo compara contra el que produce
 *  la LIBRERÍA, no contra otro literal. */
const NOMBRE_MWA_ESCRITO_EN_CHASKI = "Mobile Wallet Adapter";

const UA_ANDROID_PHANTOM_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36";
const UA_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/**
 * 🔴 HTTPS NO ES UN DETALLE DEL TEST, ES UNA PRECONDICIÓN DE MWA, y conviene leerla dos veces porque
 * cambia lo que el founder tiene que hacer en el teléfono.
 *
 * El adapter decide su `readyState` en el CONSTRUCTOR, con
 * `window.isSecureContext && /android/i.test(navigator.userAgent)`
 * (`@solana-mobile/wallet-adapter-mobile/lib/esm/index.browser.js:8-9`, usado en `:37`). Sin contexto
 * seguro el adapter nace `Unsupported`, y `WalletProviderBase` filtra los `Unsupported` fuera de la
 * lista (`WalletProviderBase.js:88`): la entrada NO APARECE, sin ningún error.
 *
 * O sea: **por http:// no hay MWA**. Probarlo contra un `next dev` por IP de la red local no muestra
 * nada, y no porque esté roto. jsdom arranca con `isSecureContext` en `false`, así que acá se pone en
 * `true` para reproducir la condición de producción, que es https. No es maquillaje: es la condición
 * que el navegador real ya cumple en el dominio desplegado.
 */
/**
 * 🔴 ESTO NO ES RUIDO DEL TEST: ES UN DEFECTO DE LA LIBRERÍA, Y ES EL MISMO QUE CAUSA EL BUG.
 *
 * `SolanaMobileWalletAdapter.connect()` hace `this.#connect();` sin `await` y sin `return`
 * (.../@solana-mobile/wallet-adapter-mobile/lib/esm/index.browser.js:88-90). La promesa interna queda
 * SIN DUEÑO: nadie puede engancharle un `.catch()`, ni la app ni `WalletProviderBase` (que awaitea la
 * de afuera, que ya resolvió). O sea que **toda falla de asociación de MWA produce, además, un
 * unhandled rejection en la consola**, en jsdom y en un navegador. No se puede arreglar desde acá.
 *
 * Lo que hace este listener es sólo evitar que ese rechazo estructural tumbe la corrida: vitest cuenta
 * los unhandled rejections del archivo como errores y sale con exit 1 aunque los tests pasen (medido).
 *
 * ⚠️ Y ES ESTRECHO A PROPÓSITO. Traga SÓLO lo que trae un código de MWA adentro de la cadena; cualquier
 * otro rechazo suelto se vuelve a tirar en un `setTimeout`, o sea que sale como excepción no capturada
 * y vitest lo reporta igual. Un `() => {}` pelado acá habría apagado la red de seguridad de TODO el
 * archivo, que es como un guard deja de existir sin que nadie lo note.
 */
function tragarRechazosSueltosDeMwa(): void {
  process.on("unhandledRejection", (motivo: unknown) => {
    if (mwaErrorCode(motivo) !== null) return;
    setTimeout(() => {
      throw motivo;
    }, 0);
  });
}

function ponerContextoSeguro(): void {
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
}

/**
 * 🔴 EL `beforeAll` QUE NO ES HIGIENE: sin él, T-MWA-2 y T-MWA-4 son un FALSO ROJO, y se midió.
 *
 * `WalletProvider.js:57-64` guarda el user agent en un `let _userAgent` de MÓDULO y lo lee UNA sola
 * vez en la vida del proceso: el PRIMER montaje del archivo lo congela para todos los demás. Como los
 * tests de más arriba montan con el user agent de escritorio, cualquier test de MWA que viniera después
 * leería `['Phantom','Solflare']` con el user agent de Android puesto.
 *
 * Y no alcanza con `vi.resetModules()`. Medido: la librería queda externalizada (es CJS), así que su
 * caché no la toca ni `resetModules()` ni purgar `require.cache` (el barrido devolvió 0 entradas).
 * La única palanca que quedó es CUÁL es el primer montaje del archivo, y eso es lo que fija esto.
 *
 * Un `beforeAll` declarado al final del archivo corre igual antes que TODOS los tests: vitest colecta
 * el archivo entero antes de ejecutar nada.
 *
 * ⚠️ EFECTO SOBRE LOS TESTS DE ARRIBA, que no se esconde: desde acá, `getEnvironment` ve Android para
 * todo el archivo. No los cambia, y el motivo es mecánico: `getEnvironment` devuelve DESKTOP_WEB en
 * cuanto hay CUALQUIER adapter en `Installed` (`getEnvironment.js:16-27`), que es el caso de T-CABLE-2
 * y T-CABLE-3; y en T-CABLE-1 el adapter de MWA sí se agrega pero reporta `Loadable`, así que la
 * disponibilidad sigue siendo `"none"`. Las tres siguen verdes, y si algún día dejan de estarlo esta
 * es la primera línea a leer.
 */
beforeAll(async () => {
  tragarRechazosSueltosDeMwa();
  ponerContextoSeguro();
  setUserAgent(UA_ANDROID_CHROME);
  const { default: SolanaProviders } = await import("./solana/solana-providers");
  await act(async () => {
    render(
      <SolanaProviders>
        <div />
      </SolanaProviders>,
    );
  });
  cleanup();
});

type AdapterEspiado = {
  name: string;
  connecting: boolean;
  signTransaction: (tx: unknown) => Promise<unknown>;
  sendTransaction: (...args: unknown[]) => Promise<string>;
  emit: (evento: string, ...args: unknown[]) => boolean;
};

let listaViva: Array<{ name: string; adapter: AdapterEspiado }> = [];
let elegir: ((nombre: string) => void) | null = null;
/** WKH-MWA · las palancas del selector y el `connecting` que engañaba al guard viejo. Los lee T-CANCEL-*. */
let abrirSelector: ((v: boolean) => void) | null = null;
let ultimoConnecting = false;

/** Espía DENTRO del árbol: la única forma de ver la lista que la librería arma de verdad. */
function EspiaDeWallets(): null {
  const { wallets, select, connecting } = useWallet();
  const { setVisible } = useWalletModal();
  listaViva = wallets.map((w) => ({
    name: String(w.adapter.name),
    adapter: w.adapter as unknown as AdapterEspiado,
  }));
  elegir = (nombre: string) => select(nombre as never);
  abrirSelector = setVisible;
  ultimoConnecting = connecting;
  return null;
}

async function montarArbolConEspia(esperaMs = 1700): Promise<void> {
  listaViva = [];
  const { default: SolanaProviders } = await import("./solana/solana-providers");
  await act(async () => {
    render(
      <SolanaProviders>
        <EspiaDeWallets />
      </SolanaProviders>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, esperaMs));
  });
}

describe("WKH-MWA · dónde aparece la entrada de Mobile Wallet Adapter y dónde no", () => {
  it("T-MWA-1: la librería decide MOBILE_WEB SOLO en Android fuera de un WebView (las 4 plataformas)", async () => {
    // Se importa `getEnvironment` por ruta y no por el nombre del paquete a propósito: es la función
    // que DECIDE si hay MWA, no está reexportada del índice, y es la única forma de medir las cuatro
    // plataformas en un mismo archivo (`getUserAgent` congela el user agent en el primer montaje, ver
    // el `beforeAll`). Acá el user agent entra como ARGUMENTO, así que no hay memo que valga.
    //
    // Y se apunta a `src/` y no a `lib/`: el paquete publica su fuente TypeScript (`files: ["lib","src"]`),
    // así que por ahí el import queda TIPADO y `tsc --noEmit` lo revisa. Contra `lib/esm/*.js` no hay
    // `.d.ts` adyacente y haría falta un `@ts-expect-error`, o sea apagar la verificación justo en el
    // renglón que sostiene la conclusión.
    const { default: getEnvironment, Environment } = await import(
      "../../node_modules/@solana/wallet-adapter-react/src/getEnvironment"
    );
    const { DESKTOP_WEB, MOBILE_WEB } = Environment;

    // El único caso donde MWA entra en juego.
    expect(getEnvironment({ adapters: [], userAgentString: UA_ANDROID_CHROME })).toBe(MOBILE_WEB);
    // Y los tres donde NO, que son los que protegen lo que hoy funciona. El primero es el importante:
    // el navegador interno de Phantom es un WebView, y ahí la librería NO ofrece MWA.
    expect(getEnvironment({ adapters: [], userAgentString: UA_ANDROID_PHANTOM_WEBVIEW })).toBe(DESKTOP_WEB);
    expect(getEnvironment({ adapters: [], userAgentString: UA_IOS })).toBe(DESKTOP_WEB);
    expect(getEnvironment({ adapters: [], userAgentString: UA_ESCRITORIO })).toBe(DESKTOP_WEB);
    // Control anti-verde-por-vacío: si los dos valores fueran el mismo número, las cuatro aserciones de
    // arriba pasarían con cualquier implementación.
    expect(DESKTOP_WEB).not.toBe(MOBILE_WEB);
  });

  it("T-MWA-2: Android Chrome ⇒ el árbol REAL lista MWA, y el nombre que Chaski tiene escrito es ESE", async () => {
    setUserAgent(UA_ANDROID_CHROME);
    await montarArbolConEspia();
    // (i) El hecho, con el árbol de verdad: la entrada existe sin que este repo importe nada de
    //     `@solana-mobile/*`.
    expect(listaViva.map((w) => w.name)).toContain(NOMBRE_MWA_ESCRITO_EN_CHASKI);
    // (ii) EL GUARD DEL NOMBRE. `MWA_WALLET_NAME` es un literal y envejecería en silencio si la
    //      librería renombrara su adapter. No se compara contra otro literal escrito a mano: se compara
    //      contra el nombre que la librería acaba de producir en (i).
    expect(MWA_WALLET_NAME).toBe(NOMBRE_MWA_ESCRITO_EN_CHASKI);
    expect(solanaWalletBridge.getMwaOffered()).toBe(true);
    // (iii) Y NO toca la disponibilidad: MWA reporta `Loadable`, nunca `Installed`. Si alguien lo
    //       "arreglara" contando MWA como inyectada, esto y T-CABLE-1 se ponen rojos a la vez, porque
    //       la app estaría afirmando que hay una wallet en este navegador, que es lo que no puede saber.
    expect(solanaWalletBridge.getWalletAvailability()).toBe("none");
  });

  it("T-MWA-3: el navegador interno de Phantom NO ve MWA, con el MISMO user agent de Android", async () => {
    // El par negativo que hace valioso a T-MWA-2, y el que protege el recorrido que ya movió USDC de
    // verdad. Lo que decide acá no es el user agent (es el mismo que en T-MWA-2): es que haya una
    // wallet INYECTADA, o sea un adapter en `Installed`, que es exactamente lo que pasa adentro del
    // navegador de Phantom. La librería devuelve DESKTOP_WEB por esa sola razón (`getEnvironment.js:16-27`).
    setUserAgent(UA_ANDROID_CHROME);
    inyectarWallet();
    await montarArbolConEspia();

    expect(listaViva.length).toBeGreaterThan(0); // control: el árbol montó y hay algo que mirar
    expect(listaViva.map((w) => w.name)).not.toContain(NOMBRE_MWA_ESCRITO_EN_CHASKI);
    expect(solanaWalletBridge.getMwaOffered()).toBe(false);
    expect(solanaWalletBridge.getWalletAvailability()).toBe("injected");
  });
});

describe("WKH-MWA · CANDADO: con MWA en juego, el depósito sigue saliendo por FIRMA PARCIAL", () => {
  /**
   * 🔴 QUÉ CIERRA ESTE CANDADO, y por qué es el único test de la rama que protege plata.
   *
   * Chaski NO envía la transacción del depósito: pide una firma PARCIAL y la difunde el facilitator,
   * que es quien paga el fee (`solana-wallet.ts:985-989`). El protocolo MWA tiene DOS operaciones
   * distintas y la que necesitamos es la OPCIONAL: `sign_transactions` (firmar y devolver) frente a
   * `sign_and_send_transactions` (firmar y enviar). Una billetera que sólo ofrezca la segunda no sirve
   * para el patrocinio: no puede enviar una transacción cuyo pagador de fees es otra cuenta.
   *
   * El modo de falla que esto vigila no es teórico, es el atajo obvio: alguien ve que el adapter de MWA
   * expone `sendTransaction`, lo cablea "para que funcione en el celular", y el depósito pasa a salir
   * por un camino donde la persona paga gas y el facilitator no firma nada.
   *
   * ⚠️ POR QUÉ LA ASERCIÓN QUE DECIDE ES LA NEGATIVA. "Se registró un firmante" la cumple TAMBIÉN el
   * camino malo: `sendTransaction` también firma. Un test que sólo pidiera eso se confirmaría con lo
   * que vino a detectar. Lo que distingue los dos caminos es que `sendTransaction` no se llame nunca.
   *
   * Y nada acá deriva su expectativa del código que vigila: la transacción de prueba es un objeto opaco
   * creado en el test, y las dos aserciones salen del contrato de patrocinio, no de lo que el bridge
   * haga hoy.
   */
  it("T-MWA-4: con la bandera PRENDIDA y MWA conectado, se firma con `signTransaction` y NUNCA con `sendTransaction`", async () => {
    // En el navegador esta env la inlinea el build (`NEXT_PUBLIC_`); bajo vitest se lee en runtime, así
    // que `stubEnv` es la forma de ponerla. Se prende a propósito: el candado es sobre el caso "MWA
    // prendido", que es el único en el que alguien podría querer cablear el camino de enviar.
    vi.stubEnv("NEXT_PUBLIC_SOLANA_MWA_ENABLED", "true");
    setUserAgent(UA_ANDROID_CHROME);
    await montarArbolConEspia();

    const mwa = listaViva.find((w) => w.name === NOMBRE_MWA_ESCRITO_EN_CHASKI)?.adapter;
    expect(mwa, "sin la entrada de MWA no hay nada que vigilar acá").toBeDefined();
    if (!mwa) return;

    const firmaParcial = vi.spyOn(mwa, "signTransaction").mockImplementation(async (tx) => tx);
    const firmaYEnvia = vi
      .spyOn(mwa, "sendTransaction")
      .mockResolvedValue("firma-que-no-deberia-existir");

    // 🔴 EL `connect` SE DOBLA, Y ESO TAMBIÉN ES UN HALLAZGO PARA EL TELÉFONO: el connect REAL de MWA
    // arranca pidiendo el permiso de RED LOCAL del navegador
    // (`navigator.permissions.query({ name: "loopback-network" })`,
    // `@solana-mobile/wallet-standard-mobile/src/getIsSupported.ts`), porque la asociación local va por
    // un WebSocket a loopback. jsdom no implementa `navigator.permissions`, así que sin este doble la
    // corrida termina con un rechazo no manejado (`ERROR_LOOPBACK_ACCESS_BLOCKED`) y vitest avisa que
    // puede dar falsos positivos. En un Chrome de Android de verdad eso NO es un error: es un diálogo
    // de permiso que la persona tiene que aceptar, y está en la lista de lo que hay que probar.
    // Doblarlo no debilita nada de lo que este test mide: acá se mide POR QUÉ MÉTODO sale la firma, no
    // cómo se establece la sesión.
    vi.spyOn(mwa as unknown as { connect: () => Promise<void> }, "connect").mockResolvedValue();
    vi.spyOn(mwa as unknown as { autoConnect: () => Promise<void> }, "autoConnect").mockResolvedValue();

    // Elegir la wallet y darla por conectada. El `connect` es un evento de la librería y no un atajo
    // nuestro: `WalletProviderBase` deriva de ahí el `connected` que habilita a `signTransaction`.
    await act(async () => {
      elegir?.(NOMBRE_MWA_ESCRITO_EN_CHASKI);
    });
    await act(async () => {
      mwa.emit("connect", { toBase58: () => "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" });
    });

    const TX_OPACA = { marca: "la tx del deposito" };
    const devuelta = await solanaWalletBridge.signTransaction(TX_OPACA).catch((e: Error) => e);

    // (i) LA ASERCIÓN QUE DECIDE, y va primero para que su rojo sea lo primero que se lea: nada salió
    //     a la red por la billetera. Es la única que distingue los dos caminos; las de abajo las
    //     cumpliría también un cableado que difunde.
    expect(firmaYEnvia).not.toHaveBeenCalled();
    // (ii) Y firmó, y firmó ESTA transacción: el bridge no puede haber inventado otra ni haber fallado
    //      en silencio. El `.catch` de arriba existe para que un rechazo NO se lea como "no difundió".
    expect(firmaParcial).toHaveBeenCalledTimes(1);
    expect(firmaParcial).toHaveBeenCalledWith(TX_OPACA);
    expect(devuelta).toBe(TX_OPACA);
  });

  it("T-MWA-5: el seam que toca `useWallet()` no nombra `sendTransaction` en ningún lado", async () => {
    // Segunda capa, y de otra naturaleza: T-MWA-4 mide una CORRIDA, esto mide el TEXTO. Hace falta
    // porque `useWallet().sendTransaction` es el único camino de difusión que NO pasa por `Connection`
    // (va derecho a la app de la billetera), así que el guard que ya existe —espiar
    // `Connection.prototype`, `solana-wallet.test.ts:453-454`— no lo ve ni podría verlo.
    // `solana-providers.tsx` es el ÚNICO archivo del repo que puede leer ese hook (seam AC-3), así que
    // el barrido es exacto y no heurístico: un archivo, una palabra.
    const { readFileSync } = await import("node:fs");
    const path = (await import("node:path")).default;
    // `process.cwd()` y no `import.meta.url`: bajo jsdom el `import.meta.url` no es una URL `file:` y
    // `readFileSync` tira ERR_INVALID_URL_SCHEME. Mismo ancla que usa `citas-ancladas.test.ts`.
    const fuente = readFileSync(
      path.join(process.cwd(), "src/presentation/solana/solana-providers.tsx"),
      "utf8",
    );
    expect(fuente).not.toContain("sendTransaction");
    // Control de que el barrido está mirando el archivo que cree: si lee otra cosa, esto avisa.
    expect(fuente).toContain("registerSignTransaction");
  });
});

describe("WKH-MWA · la bandera: qué cambia en la pantalla y qué no", () => {
  it("T-MWA-6: bandera APAGADA + MWA ofrecido ⇒ la pantalla dice EXACTAMENTE lo de siempre", async () => {
    // El caso que protege la demo: con la bandera apagada esto tiene que ser indistinguible de antes
    // de la HU, incluso en el navegador donde MWA sí se ofrece.
    irAlPasoConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setMwaOffered(true);
      solanaWalletBridge.setWalletAvailability("none");
    });
    expect(screen.getByText(/Phantom solo se conecta desde su propio navegador/)).toBeInTheDocument();
    expect(screen.queryByText(/puede abrirse la app de tu billetera/)).not.toBeInTheDocument();
  });

  it("T-MWA-7: bandera PRENDIDA + MWA ofrecido ⇒ el texto cambia, y el enlace a Phantom SIGUE", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_MWA_ENABLED", "true");
    irAlPasoConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setMwaOffered(true);
      solanaWalletBridge.setWalletAvailability("none");
    });
    expect(screen.getByText(/puede abrirse la app de tu billetera/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Phantom solo se conecta desde su propio navegador/),
    ).not.toBeInTheDocument();
    // El camino de siempre NO se saca: si la app de billetera no abre, la salida está a un toque.
    expect(screen.getByRole("link", { name: CAMINO })).toBeInTheDocument();
    // Y el texto nuevo no promete nada: dice "puede abrirse", no "se abre". Nadie midió un teléfono acá.
    const texto = screen.getByText(/puede abrirse la app de tu billetera/).textContent ?? "";
    expect(texto).not.toMatch(/se abre la app|vas a poder|funciona/i);
    expect(texto).not.toContain("—"); // sin em dashes en el copy que ve la persona
  });

  it("T-MWA-8: bandera PRENDIDA pero el selector NO ofrece MWA ⇒ texto de siempre (iOS, escritorio)", async () => {
    // El par que impide leer la bandera como "decilo en todos lados". En iOS MWA no existe, y prometer
    // ahí que se abre una app sería mentir con la bandera prendida.
    vi.stubEnv("NEXT_PUBLIC_SOLANA_MWA_ENABLED", "true");
    irAlPasoConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none"); // sin `setMwaOffered(true)`
    });
    expect(screen.getByText(/Phantom solo se conecta desde su propio navegador/)).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-MWA · CANDADO: un fallo de conexión NO se puede reportar como una cancelación de la persona
//
// 🔴 REPORTADO DESDE UN ANDROID REAL, contra producción: la persona tocó "Mobile Wallet Adapter" en el
// selector, no se abrió ninguna billetera, y la app mostró
//     "Se cerró el selector de wallet sin conectar. Podés volver a intentarlo cuando quieras."
//     wallet_connect_cancelled
// Nadie cerró nada. El mensaje le atribuye a la persona una acción que no hizo, Y tira la causa real.
//
// EL MECANISMO, medido en el árbol real y no supuesto (la reproducción es T-CANCEL-1):
//   1. `SolanaMobileWalletAdapter.connect()` llama a su `#connect()` SIN `await` y SIN `return`
//      (.../@solana-mobile/wallet-adapter-mobile/lib/esm/index.browser.js:88-90), así que resuelve al
//      instante con la asociación todavía en vuelo.
//   2. `WalletProviderBase` hace `yield onAutoConnectRequest()` y después `finally { setConnecting(false) }`
//      (WalletProviderBase.js:176-190) ⇒ `useWallet().connecting` vuelve a `false` enseguida.
//   3. 150 ms después del toque, `WalletModal` se cierra solo (WalletModal.js:65-76).
//   4. El efecto de `solana-providers.tsx:202` veía `!connecting` en `true` y llamaba `cancelConnection()`.
//   5. `cancelConnection()` rechaza el pending y hace `clearPending()`, así que cuando el error REAL
//      llegaba, `failConnection(causaReal)` era un no-op (`solana-wallet-bridge.ts:166`).
//
// ⚠️ POR QUÉ LA ASERCIÓN QUE DECIDE ES "NO SALIÓ COMO CANCELACIÓN", y va primera: un test que sólo
// pidiera "se mostró un error" lo pasa TAMBIÉN el comportamiento roto, porque `wallet_connect_cancelled`
// es un error. Lo que distingue los dos mundos es CUÁL error, y el candado tiene que separar
// cancelación de falla, no error de no-error.

/** Le presta a jsdom la API de permisos que un Chrome de Android SÍ tiene, y la hace TARDAR. */
function permisoDeRedQueTarda(ms: number): void {
  Object.defineProperty(window.navigator, "permissions", {
    value: {
      query: async () => {
        await new Promise((r) => setTimeout(r, ms));
        return { state: "granted" };
      },
    },
    configurable: true,
  });
}

/**
 * Construye un error de MWA con las clases REALES de las dos librerías, con la forma de cadena que el
 * adapter produce de verdad: `WalletConnectionError` (que guarda su causa en `.error`) envolviendo un
 * `Error` que guarda la suya en `.cause`, y adentro el `SolanaMobileWalletAdapterError` con su `code`.
 * Que ésa sea la forma real lo mide T-CANCEL-4 contra el adapter vivo.
 */
function errorRealDeMwa(code: string): Error {
  const { createRequire } = require("node:module") as typeof import("node:module");
  const path = require("node:path") as typeof import("node:path");
  const desdeElAdapter = createRequire(
    path.join(
      process.cwd(),
      "node_modules/@solana/wallet-adapter-react/node_modules/@solana-mobile/wallet-adapter-mobile/lib/cjs/index.js",
    ),
  );
  const proto = desdeElAdapter("@solana-mobile/mobile-wallet-adapter-protocol") as {
    SolanaMobileWalletAdapterError: new (c: string, m: string) => Error;
  };
  const base = require("@solana/wallet-adapter-base") as {
    WalletConnectionError: new (m: string, e: unknown) => Error;
  };
  const adentro = new proto.SolanaMobileWalletAdapterError(code, `falla real: ${code}`);
  return new base.WalletConnectionError("lo que ve `onError`", new Error("intermedia", { cause: adentro }));
}

function sinApiDePermisos(): void {
  Object.defineProperty(window.navigator, "permissions", { value: undefined, configurable: true });
}

/** Monta, abre el selector, empieza a esperar la conexión y devuelve las palancas. */
async function escenarioDeConexion(): Promise<{
  mwa: Record<string, unknown> | undefined;
  desenlace: () => string | null;
  cerrarModal: () => Promise<void>;
}> {
  await montarArbolConEspia();
  await act(async () => {
    abrirSelector?.(true);
  });
  let desenlace: string | null = null;
  solanaWalletBridge.waitForConnection(60_000).then(
    () => {
      desenlace = "conectada";
    },
    (e: Error) => {
      desenlace = e.message;
    },
  );
  const mwa = listaViva.find((w) => w.name === NOMBRE_MWA_ESCRITO_EN_CHASKI)?.adapter as unknown as
    | Record<string, unknown>
    | undefined;
  return {
    mwa,
    desenlace: () => desenlace,
    // Exactamente lo que hace WalletModal: 150 ms después del toque, `setVisible(false)`.
    cerrarModal: async () => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 150));
      });
      await act(async () => {
        abrirSelector?.(false);
      });
    },
  };
}

describe("WKH-MWA · CANDADO: una conexión que falla no puede decir que la cancelaste", () => {
  it("T-CANCEL-1: la asociación sigue viva cuando el selector se auto-cierra ⇒ NO se acusa de cancelar", async () => {
    // La reproducción exacta del reporte: una asociación que tarda MÁS que los 150 ms del auto-cierre.
    permisoDeRedQueTarda(400);
    setUserAgent(UA_ANDROID_CHROME);
    const { mwa, desenlace, cerrarModal } = await escenarioDeConexion();
    expect(mwa, "sin la entrada de MWA no hay nada que reproducir").toBeDefined();
    if (!mwa) return;

    console.log("### adapter.connecting ANTES de elegir =", mwa.connecting);
    await act(async () => {
      elegir?.(NOMBRE_MWA_ESCRITO_EN_CHASKI);
    });
    await cerrarModal();

    // (i) LA ASERCIÓN QUE DECIDE. Con el guard viejo acá había `"wallet_connect_cancelled"`.
    expect(desenlace()).not.toBe("wallet_connect_cancelled");

    // (ii) EL CONTROL QUE IMPIDE EL VERDE POR VACÍO, y es lo que hace que (i) signifique algo: en este
    //      instante TIENE que haber una asociación viva, y el dato que el guard viejo miraba TIENE que
    //      estar diciendo lo contrario. Sin esto, un test que nunca llegara a tocar MWA pasaría (i).
    expect(mwa.connecting, "la asociación tiene que seguir viva").toBe(true);
    expect(ultimoConnecting, "`useWallet().connecting` es el dato que engañaba al guard viejo").toBe(
      false,
    );
    // (iii) Y no se inventa un éxito tampoco: la espera sigue abierta, que es lo honesto mientras el
    //       adapter no conteste.
    expect(desenlace()).toBeNull();
  });

  it("T-CANCEL-2: el error REAL llega DESPUÉS del auto-cierre y es ÉSE el que ve la persona", async () => {
    // El escenario COMPLETO del reporte, no una mitad: la asociación tarda más que los 150 ms del
    // auto-cierre (como en T-CANCEL-1) Y ADEMÁS termina fallando. Con el guard viejo, en el momento en
    // que este error llega la espera YA estaba rechazada con "cancelaste" y `failConnection` era un
    // no-op, así que esta causa no podía llegar nunca.
    permisoDeRedQueTarda(400);
    setUserAgent(UA_ANDROID_CHROME);
    const { mwa, desenlace, cerrarModal } = await escenarioDeConexion();
    expect(mwa).toBeDefined();
    if (!mwa) return;

    await act(async () => {
      elegir?.(NOMBRE_MWA_ESCRITO_EN_CHASKI);
    });
    await cerrarModal();
    expect(mwa.connecting, "la asociación tiene que seguir viva al cerrarse el selector").toBe(true);

    // El error se entrega por el MISMO camino que usa la librería: `#runWithGuard` hace
    // `this.emit("error", e)` antes de re-tirar, y `WalletProviderBase` escucha ese evento
    // (`adapter.on('error', handleError)`, WalletProviderBase.js:150) y lo manda al `onError` del
    // provider. Se emite a mano en vez de esperar al fallo real porque el fallo real de jsdom depende
    // de un timeout de detección de terceros: un test que espera ESE reloj es un flake.
    // ⚠️ El OBJETO no lo inventa el test: lo construyen las clases reales de las dos librerías, y que
    // esa forma sea la que el adapter produce de verdad lo mide T-CANCEL-4, end to end.
    await act(async () => {
      (mwa as unknown as { emit: (e: string, x: unknown) => boolean }).emit(
        "error",
        errorRealDeMwa("ERROR_WALLET_NOT_FOUND"),
      );
    });

    const fin = desenlace();
    // (i) LA ASERCIÓN QUE DECIDE, primero: no salió como cancelación.
    expect(fin).not.toBe("wallet_connect_cancelled");
    // (ii) Ni colapsado en el genérico de la envoltura, que es lo que da leer sólo el `name` de arriba.
    expect(fin).not.toBe("wallet_connect_failed");
    // (iii) Salió la causa real, la que el adapter puso adentro de la cadena.
    expect(fin).toBe("mwa:ERROR_WALLET_NOT_FOUND");
    // (iv) Y lo que LEE la persona dice qué pasó y qué hacer, en vez de acusarla de cerrar el selector.
    const copy = humanError(fin as string);
    expect(copy).not.toMatch(/Se cerró el selector/);
    expect(copy).not.toMatch(/cancelaste|rechazaste|cerraste/i);
    expect(copy).toMatch(/Ninguna app de billetera respondió/);
  });

  it("T-CANCEL-3(control): cerrar el selector SIN elegir nada sigue siendo una cancelación", async () => {
    // El par que impide 'arreglarlo' borrando `cancelConnection()`. Este camino tiene que seguir vivo:
    // acá la persona SÍ cerró el selector sin elegir, y decirlo es correcto. Si esto se pone verde por
    // el motivo equivocado —porque nadie cancela nunca— el candado de arriba deja de significar algo.
    sinApiDePermisos();
    setUserAgent(UA_ANDROID_CHROME);
    const { desenlace, cerrarModal } = await escenarioDeConexion();
    await cerrarModal(); // sin `elegir(...)`: nadie tocó ninguna wallet
    expect(desenlace()).toBe("wallet_connect_cancelled");
  });
  it("T-CANCEL-4: la cadena de causas no la inventa el test, la produce el adapter", async () => {
    // Sin la API de permisos el adapter falla de verdad y al instante: `checkLocalNetworkAccessPermission`
    // revienta en el primer renglón. El error que llega acá lo construyó ENTERO la librería. Es el par
    // que impide que T-CANCEL-2 y T-ERR-2 se estén confirmando con una forma de cadena que yo inventé:
    // si el adapter la cambiara, esto se pone rojo y esos dos seguirían verdes.
    sinApiDePermisos();
    setUserAgent(UA_ANDROID_CHROME);
    const { mwa, desenlace, cerrarModal } = await escenarioDeConexion();
    expect(mwa).toBeDefined();
    if (!mwa) return;

    await act(async () => {
      elegir?.(NOMBRE_MWA_ESCRITO_EN_CHASKI);
    });
    await cerrarModal();

    expect(desenlace()).not.toBe("wallet_connect_cancelled");
    expect(desenlace()).toBe("mwa:ERROR_LOOPBACK_ACCESS_BLOCKED");
    expect(humanError(desenlace() as string)).toMatch(/permiso de red local/i);
  });

});

// ══ H1 · LA PANTALLA DEJA DE OFRECER UNA PUERTA QUE NO ABRE ═══════════════════════════════════════
//
// 🔴 EL DEFECTO, MEDIDO EN UN TELÉFONO DE VERDAD (2026-08-16, el del founder): en Chrome de Android sin
// wallet inyectada, el selector de la librería ofrece UNA sola entrada, Mobile Wallet Adapter, y tocarla
// no abre nada — ni siquiera aparece un diálogo de permiso. La pantalla ponía su CTA más grande y más
// rojo ahí, justo debajo del cartel que dice "no vemos ninguna wallet en este navegador". La pantalla se
// contradecía, y frente a un botón grande y un párrafo, se le cree al botón.
//
// LO QUE ESTOS `it` CONGELAN, y por qué son cuatro y no uno:
//   · T-H1-1 la mitad que arregla: sin salida ⇒ el CTA no está y el enlace toma su lugar.
//   · T-H1-2 la mitad que lo hace falsable: con la bandera PRENDIDA el CTA VUELVE. Sin este `it`,
//     "esconder el botón siempre" pasaría en verde y la bandera no significaría nada.
//   · T-H1-3 que el enlace ascendido mida lo mismo que un `<Button>` DE VERDAD. El alto NO se escribe
//     acá: se lee de un `<Button>` renderizado. Escribir `52` a mano sería el candado que se aplaude
//     solo — pasaría aunque `ui.tsx` cambiara el alto del CTA y las dos cosas se separaran.
//   · T-H1-4 el control de escritorio: sin MWA en el selector el CTA se queda, porque ahí el selector
//     todavía lista qué instalar. Sin este `it`, "esconderlo en toda pantalla sin wallet" pasaría.
//
// ⚠️ LO QUE NO VERIFICA: que MWA efectivamente no funcione en Android. Eso no lo puede medir jsdom — es
// comportamiento de una app de terceros en un teléfono, y la evidencia es el recorrido del founder, no
// este archivo. Acá sólo se congela QUÉ OFRECE LA PANTALLA dado ese hecho.
describe("H1 · cuando conectar no lleva a ningún lado, la pantalla no lo ofrece", () => {
  const sinSalida = async () => {
    irAlPasoConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setMwaOffered(true);
      solanaWalletBridge.setWalletAvailability("none");
    });
  };

  it("T-H1-1: MWA es lo único que ofrece el selector y nadie lo verificó ⇒ el CTA no está, y el enlace ocupa su lugar", async () => {
    // MUTANTE QUE MATA: quitarle el `conectarEsCallejon ? null :` al `<Button>` de `flow.tsx`.
    await sinSalida();
    expect(screen.queryByRole("button", { name: /Conectar wallet/ })).toBeNull();
    const enlace = screen.getByRole("link", { name: CAMINO });
    expect(enlace).toBeInTheDocument();
    // Y ES la acción resolutiva, no un enlace más: fondo del CTA, no borde sobre fondo claro.
    expect(enlace.className).toContain("bg-cochineal");
    expect(enlace.className).not.toContain("bg-card");
  });

  it("T-H1-2: con la bandera PRENDIDA el CTA vuelve — es lo que hace honesta a la bandera", async () => {
    // Sin este `it`, borrar la condición entera y esconder el botón siempre daría verde. La bandera
    // significa "alguien ya probó MWA en un teléfono": si eso pasa, MWA deja de ser un callejón.
    vi.stubEnv("NEXT_PUBLIC_SOLANA_MWA_ENABLED", "true");
    await sinSalida();
    expect(screen.getByRole("button", { name: /Conectar wallet/ })).toBeInTheDocument();
    // Y entonces el enlace vuelve a ser la salida secundaria, no la resolutiva.
    expect(screen.getByRole("link", { name: CAMINO }).className).toContain("bg-card");
  });

  it("T-H1-3: el enlace ascendido mide lo mismo que un `<Button>` real, y el alto se LEE, no se escribe", async () => {
    // 🔴 Este es el `it` que impide que las dos recetas se separen en silencio. `flow.tsx` copia a mano
    // la receta de `ui.tsx:66` porque necesita un `<a>` (el deep link tiene que navegar) y `Button`
    // emite un `<button>`. Esa duplicación es deliberada y está declarada allá; acá está su candado.
    const { Button } = await import("./ui");
    const { container: refCtr } = render(<Button>referencia</Button>);
    const altoDelCtaReal = /(?:^|\s)(h-\[\d+px\])/.exec(
      (refCtr.querySelector("button") as HTMLElement).className,
    )?.[1];
    // Se mide el instrumento antes de usarlo: si `ui.tsx` dejara de emitir un `h-[NNpx]`, esta
    // expectativa se pone roja acá y no en un assert vacuamente verde más abajo.
    expect(altoDelCtaReal).toMatch(/^h-\[\d+px\]$/);
    cleanup();

    await sinSalida();
    expect(screen.getByRole("link", { name: CAMINO }).className).toContain(altoDelCtaReal as string);
  });

  it("T-H1-4(control): escritorio sin extensión ⇒ el CTA se queda, porque ahí el selector sí ofrece algo", async () => {
    // El par negativo. En escritorio la librería NO antepone MWA, y el selector lista wallets para
    // instalar: esconder el botón dejaría la pantalla sin ninguna acción.
    irAlPasoConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setMwaOffered(false);
      solanaWalletBridge.setWalletAvailability("none");
    });
    expect(screen.getByRole("button", { name: /Conectar wallet/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: CAMINO }).className).toContain("bg-card");
  });
});
