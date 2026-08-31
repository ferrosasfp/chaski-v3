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
import { phantomBrowseUrl, deeplinkEnabled } from "./wallet-availability"; import { humanError } from "./flow-vm"; import { mwaErrorCode } from "./solana/wallet-error-code"; // WKH-MWA: los dos EN ESTA LÍNEA — `wallet-availability.test.tsx:62` lo cita `tx-proof.test.tsx:84` por número
import { MWA_WALLET_NAME, solanaWalletBridge } from "../infrastructure/solana-wallet-bridge"; import { useWallet } from "@solana/wallet-adapter-react"; import { useWalletModal } from "@solana/wallet-adapter-react-ui"; // WKH-MWA: los dos imports EN ESTA LÍNEA — `wallet-availability.test.tsx:62` lo cita `tx-proof.test.tsx:84` por número, y agregar una línea acá lo correría
import { buildTestContainer } from "../test-support/test-container"; import { RecorridoPorEnlaceNulo } from "../test-support/fakes"; // WKH-358 (fix-pack): EN ESTA LÍNEA, no en una nueva — `wallet-availability.test.tsx:62` lo cita `tx-proof.test.tsx:84` por número
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
  // 🔴 CACHEA POR TAG, y el caché ES el target del Proxy (WKH-233 it4 · F4/§4.3): un `get` que fabrica en cada acceso da un TIPO de componente distinto por render y React REMONTA el subárbol entero.
  motion: new Proxy({} as Record<string, unknown>, {
    get: (t: Record<string, unknown>, tag: string) => {
      if (!(tag in t))
        t[tag] = ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
          React.createElement(tag, props, children);
      return t[tag];
    },
  }),
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
function irAlPasoConectar(container = buildTestContainer()): void { // WKH-358 (fix-pack): el parámetro es OPCIONAL y su default es el de siempre, así que los ~20 `it` que ya lo llamaban sin argumentos no cambian de comportamiento. Lo necesita el `it` del control «Cambiar de billetera», que tiene que montar un doble con una elección puesta
  render(<RemittanceFlow pasoInicial="send" container={container} />);
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
  // 🔴 WKH-372/W1 — ESTE `it` ESTABA VERDE CONGELANDO UN DEFECTO, Y ESO ES LO QUE HAY QUE LEER ACÁ.
  //
  // Su expectativa literal era
  // `…/ul/browse/http%3A%2F%2Flocalhost%3A3000%2F%3Fkyc%3Dreturn?ref=…`, o sea que afirmaba que el
  // `?kyc=return` VIAJA al navegador de Phantom. Y viajaba: `NoWalletHere` tomaba
  // `window.location.href` crudo. El problema es lo que pasa del otro lado — el navegador de Phantom
  // es OTRA partición de almacenamiento, así que la puerta del splash lee ese parámetro como una
  // vuelta del verificador y arranca a retomar un trámite que en ESE disco no existe.
  //
  // ⚠️ O sea que el `it` no estaba mal escrito: estaba midiendo bien un comportamiento equivocado, y
  // por eso su verde no protegía nada. Al arreglarlo se puso rojo, y ese rojo es INFORMACIÓN.
  //
  // Qué mide ahora, que son DOS propiedades y no una:
  //   (a) el ENCODEADO sigue entero —que era el motivo original de este `it`: un `?` sin encodear se
  //       comería el `?ref=` del universal link—, y se mide con un parámetro que es DE LA APP y que
  //       por lo tanto tiene que sobrevivir el salto;
  //   (b) el rastro del navegador de ORIGEN (`kyc`) NO viaja;
  //   (c) la marca `wb=1` SÍ viaja, porque en el paso `connect` ya hay una remesa cargada. Es la
  //       prueba de que la prop `hayBorrador` está CABLEADA de punta a punta: si nadie la pasara, el
  //       literal de abajo no tendría el `%26wb%3D1` y este `it` se pondría rojo.
  // ⛔ El literal se sigue escribiendo a mano y NO se recalcula con la función que se está probando.
  it("T-LINK-1: el href del aviso apunta a la URL viva, encodeada, y SIN los rastros del navegador de origen", async () => {
    window.history.replaceState({}, "", "/?monto=400&kyc=return");
    irAlPasoConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
    });

    // Literal, NO recalculado con la misma función que se está probando.
    expect(screen.getByRole("link", { name: CAMINO })).toHaveAttribute(
      "href",
      "https://phantom.app/ul/browse/http%3A%2F%2Flocalhost%3A3000%2F%3Fmonto%3D400%26wb%3D1?ref=http%3A%2F%2Flocalhost%3A3000",
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
   * que es quien paga el fee (`signTransaction`, `solana-wallet.ts:1114`). El protocolo MWA tiene DOS
   * operaciones distintas y la que necesitamos es la OPCIONAL: `sign_transactions` (firmar y devolver) frente a
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
    // `Connection.prototype`, `solana-wallet.test.ts:477-478`— no lo ve ni podría verlo.
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

// ── WKH-358 / AC-9 · LA BANDERA DEL CAMINO POR ENLACE ────────────────────────────────────────────
//
// 🔴 POR QUÉ ESTOS DOS `it` SON DE CLASES DISTINTAS Y HACEN FALTA LOS DOS. `T-065-20` mide la FUNCIÓN
// (qué valores prenden) y `T-065-21` mide la PANTALLA (que apagada no cambie un byte). Una sola de las
// dos deja un agujero entero: con sólo la función, alguien puede leerla bien y montar el selector sin
// gatearlo; con sólo la pantalla, el opt-in podría aflojarse a `"TRUE"` sin que nada se ponga rojo.
//
// El `afterEach` de este archivo ya llama `vi.unstubAllEnvs()` (`:106`), así que la bandera NO se filtra
// entre tests y el resto del archivo sigue midiendo "lo de siempre" con la bandera ausente.
const SELECTOR = /Conectá desde tu app de billetera/;

describe("WKH-358/AC-9: la bandera NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED es opt-in ESTRICTO", () => {
  // MUTANTE QUE MATA: en `wallet-availability.ts`, en `deeplinkEnabled()`, cambiar `=== "true"` por
  // `?.toLowerCase() === "true"` ⇒ `"TRUE"` pasa a prender y la fila de abajo lo caza.
  it("T-065-20: sólo el literal `true` prende; ausente, vacía, `1`, `TRUE` y `true ` NO", () => {
    // Lo que SÍ prende, primero: sin esta fila el `it` podría pasar con una función que devuelve
    // `false` siempre, que es el mutante más barato de todos (CD-18).
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
    expect(deeplinkEnabled(), "el literal `true` TIENE que prender, o esto no gatea nada").toBe(true);
    for (const v of ["", "1", "TRUE", "True", "true ", " true", "yes", "on"]) {
      vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", v);
      expect(deeplinkEnabled(), `el valor ${JSON.stringify(v)} NO puede prender la bandera`).toBe(false);
    }
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", undefined as unknown as string);
    expect(deeplinkEnabled(), "ausente tiene que estar APAGADA").toBe(false);
  });

  // MUTANTE QUE MATA: en `flow.tsx`, en el JSX del paso `connect`, borrar el gate
  // `mostrarSelectorDeEnlace ?` del selector ⇒ el selector aparece con la bandera apagada y el
  // `innerHTML` deja de ser idéntico.
  it("T-065-21: con la bandera APAGADA el paso `connect` es byte-idéntico al de hoy", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", undefined as unknown as string);
    irAlPasoConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
    });
    const apagada = screen.getByText(/Conectá tu wallet/).closest("div")?.parentElement?.parentElement
      ?.innerHTML;
    // CD-18 — que el fixture haya llegado al cuadrante que se quiere medir. Sin esto, un render que
    // fallara antes dejaría `apagada === undefined` y la comparación de abajo pasaría por vacío.
    expect(apagada, "no se llegó a renderizar el paso `connect`").toBeTruthy();
    expect(screen.queryByText(SELECTOR), "el selector apareció con la bandera APAGADA").not.toBeInTheDocument();
    // Y el enlace a Phantom, que es el camino verificado en cadena, sigue estando.
    expect(screen.getByRole("link", { name: CAMINO })).toBeInTheDocument();

    cleanup();
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
    irAlPasoConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
    });
    const prendida = screen.getByText(/Conectá tu wallet/).closest("div")?.parentElement?.parentElement
      ?.innerHTML;
    // 🔴 LA MITAD QUE HACE FALSABLE A LA OTRA: si el `innerHTML` fuera igual con la bandera prendida,
    // el `toBe(apagada)` de arriba estaría pasando porque el selector NO se monta nunca, no porque la
    // bandera lo gatee. Con esta línea, las dos afirmaciones sólo pueden ser ciertas a la vez si la
    // bandera es exactamente lo que decide.
    expect(prendida, "con la bandera PRENDIDA la pantalla no cambió: el selector no se está montando").not.toBe(apagada);
    expect(screen.getByText(SELECTOR)).toBeInTheDocument();
    // Y `NoWalletHere` NO se borró ni se escondió: se degradó a salida secundaria.
    expect(screen.getByRole("link", { name: CAMINO })).toBeInTheDocument();
    expect(screen.getByText(AVISO)).toBeInTheDocument();
  });

  // AC-6 / CD-2 — el selector NO aparece fuera del cuadrante `none`, ni siquiera con la bandera
  // prendida. Es la mitad que impide que este camino se ofrezca donde el gate del adaptador nunca se
  // enciende (un escritorio con extensión), o sea una puerta que no lleva a donde dice.
  it("T-065-21b: con la bandera PRENDIDA y una wallet inyectada, el selector NO aparece", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
    irAlPasoConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("injected");
    });
    expect(
      screen.queryByText(SELECTOR),
      "el selector se ofreció con una wallet INYECTADA. Ahí el gate `caminoPorEnlace()` devuelve " +
        "`null` siempre, así que el salto volvería y el recorrido correría por el camino inyectado: " +
        "una puerta que no lleva a donde dice.",
    ).not.toBeInTheDocument();
  });

  // CD-16 — el copy del selector no puede prometer que se pueda PAGAR por enlace, porque el depósito
  // por enlace NO cierra en esta HU (el PoP es WKH-359). Y sin em dashes.
  it("T-065-COPY-SELECTOR: el copy del selector no promete pagar, y no tiene em dashes", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
    irAlPasoConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
    });
    const texto = (screen.getByText(SELECTOR).closest("div")?.parentElement?.textContent ?? "").trim();
    expect(texto, "el fixture no capturó el copy del selector").toContain("Elegí cuál usás");
    expect(texto).not.toContain("—");
    // ⛔ Lo que el copy NO puede insinuar: que por acá se paga, se envía o se deposita.
    expect(texto).not.toMatch(/pag(ar|á|as)\b/i);
    expect(texto).not.toMatch(/enviar tu plata|depositar|firmar el env[íi]o/i);
  });

  // ── T-065-OLVIDAR (fix-pack · AR/BLQ-MED-1 + AR/BLQ-BAJO-3 + CR/BLQ-BAJO-4) ─────────────────────
  //
  // 🔴 QUÉ AGUJERO MIDEN ESTOS TRES `it`, Y NO ES COPY. Al cerrar la ola 4, `olvidar()` tenía **cero
  // llamadores de producción** (todos en `*.test.*`) y `CLAVE_ELECCION` no expira: elegir una billetera
  // una vez dejaba el gate del adaptador armado para ese origen **para siempre y sin salida en la
  // pantalla**. El docblock de `olvidar()` afirmaba lo contrario. Estos `it` son el candado del llamador
  // que faltaba, y el 3º es el de la otra mitad (que la bandera pueda replegar la superficie).
  //
  // ⚠️ EL DOBLE IMITA EL DISCO A PROPÓSITO (`olvidar()` deja `eleccion()` en `null`), y no se queda
  // devolviendo `"phantom"` para "probar" que el componente esconde el control por su estado local: eso
  // sería medir una decisión de implementación mintiendo sobre el almacén. Lo que se mide es lo que la
  // persona obtiene: el control aparece cuando hay elección, dispara UNA llamada al borrador, y se va.
  class RecorridoConEleccion extends RecorridoPorEnlaceNulo {
    public elegida: "phantom" | "solflare" | null = "phantom";
    override eleccion(): "phantom" | "solflare" | null {
      return this.elegida;
    }
    override olvidar(): void {
      super.olvidar(); // suma a `olvidos`, que es lo que se assertea
      this.elegida = null;
    }
  }
  const CAMBIAR = /Cambiar de billetera/;

  // MUTANTE QUE MATA: en `flow.tsx`, borrar del paso `connect` el montaje de
  // `<OlvidarBilleteraDeEnlace .../>` ⇒ el control desaparece y el primer `expect` cae. Es el mutante
  // que prueba que el llamador de producción de `olvidar()` existe.
  it("T-065-OLVIDAR: con una elección puesta, el control «Cambiar de billetera» aparece y BORRA la elección", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
    const recorrido = new RecorridoConEleccion();
    irAlPasoConectar(buildTestContainer({ recorridoPorEnlace: recorrido }));
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
    });
    // CD-18 — el fixture fabricó el caso: el doble declara una elección puesta ANTES de mirar nada.
    expect(recorrido.eleccion(), "el doble no dejó ninguna elección: no hay nada que olvidar").toBe("phantom");
    expect(recorrido.olvidos, "alguien llamó a `olvidar()` sin que nadie toque el control").toBe(0);
    const control = screen.getByRole("button", { name: CAMBIAR });

    await act(async () => {
      fireEvent.click(control);
    });

    expect(recorrido.olvidos, "el control no llamó a `olvidar()`, o lo llamó más de una vez").toBe(1);
    expect(recorrido.eleccion(), "la elección quedó en el disco después de olvidarla").toBeNull();
    expect(
      screen.queryByRole("button", { name: CAMBIAR }),
      "el control sigue ofreciendo olvidar una elección que ya no existe",
    ).not.toBeInTheDocument();
    // Y el selector sigue estando: olvidar devuelve a la persona al punto de elegir, no a la nada.
    expect(screen.getByText(SELECTOR)).toBeInTheDocument();
  });

  // El par negativo, y es la mitad que hace falsable al `it` de arriba: sin esto, un control que se
  // pintara SIEMPRE pasaría el de arriba igual.
  it("T-065-OLVIDAR(control): sin ninguna elección en el disco, el control NO se pinta", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
    const recorrido = new RecorridoConEleccion();
    recorrido.elegida = null; // nadie eligió: es el estado de un navegador que recién llega
    irAlPasoConectar(buildTestContainer({ recorridoPorEnlace: recorrido }));
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
    });
    expect(screen.getByText(SELECTOR), "no se llegó al cuadrante que se quiere medir").toBeInTheDocument();
    expect(screen.queryByRole("button", { name: CAMBIAR })).not.toBeInTheDocument();
    expect(recorrido.olvidos).toBe(0);
  });

  // 🔴 T-065-GATE-5 (AC-9) — LA OTRA MITAD DEL REPLIEGUE, Y LA QUE EL AR MIDIÓ COMO ROTA. Con la
  // bandera apagada, un dispositivo que YA eligió no tiene que quedar con nada del camino por enlace
  // pintado. El gate del adaptador ((`caminoPorEnlace`, `../infrastructure/solana-wallet.ts:2239`))
  // consulta la misma bandera como 3ª condición, así que las dos mitades se apagan con el mismo
  // interruptor. El `it` que mide el gate del ADAPTADOR con la bandera apagada vive en
  // `../infrastructure/solana/preparacion-por-enlace.test.ts`; éste mide la PANTALLA.
  // MUTANTE QUE MATA: borrar `deeplinkEnabled() &&` de `mostrarSelectorDeEnlace` (`flow.tsx:147`).
  it("T-065-GATE-5: con la bandera APAGADA y una elección YA puesta, no queda nada del camino por enlace", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", undefined as unknown as string);
    const recorrido = new RecorridoConEleccion();
    irAlPasoConectar(buildTestContainer({ recorridoPorEnlace: recorrido }));
    await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
    });
    // CD-18 — la elección está puesta: sin esto el `it` pasaría por no haber nada que replegar.
    expect(recorrido.eleccion(), "el fixture no dejó ninguna elección puesta").toBe("phantom");
    expect(screen.queryByText(SELECTOR), "el selector apareció con la bandera APAGADA").not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: CAMBIAR })).not.toBeInTheDocument();
    // Y el camino verificado en cadena sigue estando: replegar no es dejar a nadie sin salida.
    expect(screen.getByRole("link", { name: CAMINO })).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-372 / W1.2 — LA PUERTA DE ENTRADA AL NAVEGADOR DE LA BILLETERA
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// ⛔ APÉNDICE AL FINAL, y nada de lo de arriba se reordena: este archivo recibe citas por número.
//
// Qué se agrega en la pantalla y qué mide cada `it`:
//   · La OFERTA en `bienvenida` (AC-1-1)          → `T-372-W1-1` y su control negativo `T-372-W1-2`
//   · Lo que el `href` de la oferta LLEVA (AC-1-1)→ `T-372-W1-1`, tercera mitad (AR/BLQ-BAJO-1)
//   · El segundo enlace, el de instalar (AC-1-4)  → `T-372-W1-6`
//   · El aviso de aterrizaje, TRES casos (AC-1-4b)→ `T-372-W1-7`
//   · La pantalla donde el aviso se pinta (I-2(b))→ `T-372-W1-7c` (AR/MNR-4)
import {
  PARAM_SALIDA,
  URL_INSTALAR_PHANTOM,
  VALOR_SALIDA,
} from "./salida-al-navegador-de-la-billetera";
import { KEY as CLAVE_DEL_REPO } from "../infrastructure/persistence";
import { leerHito, olvidarHitos } from "./bitacora-de-vuelta";
import { DiagnosticoDeVuelta } from "./diagnostico-de-vuelta";
// AR/BLQ-BAJO-1 — los tres traen lo que hace falta para mirar ADENTRO del enlace de la oferta:
// `PARAM_KYC`/`VALOR_VUELTA_KYC` son el rastro que NO tiene que viajar, y `hrefQueLaBilleteraVaAAbrir`
// es el desarmado del universal link. ⛔ Los tres se IMPORTAN y ninguno se re-escribe acá.
import { PARAM_KYC, VALOR_VUELTA_KYC } from "./splash-puerta";
import { hrefQueLaBilleteraVaAAbrir } from "../test-support/salida-al-navegador";

const OFERTA = /¿Estás en un celular con Phantom\?/;
const INSTALAR = /Instalarla y crear mi billetera/;
const AVISO_ATERRIZAJE = /Acá no están los datos que cargaste antes/;

/** Monta la pantalla de entrada y deja que el árbol decida la disponibilidad, igual que el resto del
 *  archivo: primero se renderiza, después se empuja el cuadrante que el `it` quiere medir. */
async function enLaBienvenida(disponibilidad: "none" | "injected" | "unknown"): Promise<void> {
  render(<RemittanceFlow pasoInicial="bienvenida" container={buildTestContainer()} />);
  await act(async () => {
    solanaWalletBridge.setWalletAvailability(disponibilidad);
  });
}

describe("WKH-372/AC-1-1: la oferta de abrir Chaski adentro del navegador de la billetera", () => {
  // MUTANTE QUE LO TIENE QUE MATAR: cambiar el `<a href>` de la oferta por un `<button onClick>` ⇒
  // `getByRole("link", …)` no encuentra nada.
  // ⛔ FALSO KILLED A EVITAR: un mutante que rompa el render entero mata cualquier `it`. Por eso el
  // control negativo (`T-372-W1-2`, abajo) tiene que seguir VERDE con el mismo mutante puesto: si los
  // dos caen a la vez, lo que se rompió es la pantalla y no la oferta.
  //
  // 🔴 AR/BLQ-BAJO-1 — LA TERCERA MITAD, Y POR QUÉ EXISTE. Hasta el fix-pack este `it` miraba
  // SOLAMENTE el `hostname` del enlace, y eso lo medió el AR: reemplazando la expresión del `href` de
  // la oferta (`flow.tsx:757`) por el enlace CRUDO de antes de W1 —o sea reintroduciendo el defecto que
  // esta ola viene a cerrar— la suite entera quedaba en `exit 0`, `3420 passed`. El arreglo estaba
  // vigilado en el enlace SECUNDARIO (`T-LINK-1`) y no en el principal, que es la puerta que la ola
  // construye. Acá se cierra: el enlace se DESARMA y se mira lo que lleva adentro.
  // MUTANTE QUE TIENE QUE MATAR LA TERCERA MITAD (MUT-I): en `flow.tsx:757`, cambiar
  // `urlDeSalidaAlNavegadorDeLaBilletera({…})` por `phantomBrowseUrl(window.location.href, origin)`.
  it("T-372-W1-1: en `bienvenida` sin wallet aparece un ENLACE al universal link, no navega solo, y el rastro del KYC no viaja", async () => {
    // 🔴 EL FIXTURE FABRICA EL CUADRANTE R-5, y sin él este `it` no puede distinguir nada: la persona
    // está parada en el aterrizaje del verificador de identidad (`urlDeVueltaDeKyc`) con un monto ya
    // cargado en la barra. Es el caso donde el enlace crudo se lleva el `?kyc=return` al otro
    // navegador y allá arranca a retomar un trámite que en ESE almacenamiento no existe.
    window.history.replaceState({}, "", `/?monto=400&${PARAM_KYC}=${VALOR_VUELTA_KYC}`);
    const antesDeMedir = window.location.href;
    await enLaBienvenida("none");

    const enlace = screen.getByRole("link", { name: /Abrir Chaski en Phantom/ });
    // 1 · ES UN `<a href>` Y NO UN BOTÓN. La diferencia no es de estilo: fuera de un gesto de la
    //     persona los navegadores móviles descartan la navegación a otra app SIN error y SIN rastro.
    expect(enlace.tagName, "la oferta dejó de ser un elemento que la persona toca").toBe("A");
    // 2 · Y APUNTA AL UNIVERSAL LINK DE LA BILLETERA. El prefijo NO se escribe acá: se deriva del
    //     productor de producción, que es el mismo que este repo ya tenía desplegado.
    expect(new URL(enlace.getAttribute("href") as string).hostname).toBe(
      new URL(phantomBrowseUrl("https://x.test/", "https://x.test")).hostname,
    );
    // 3 · NADIE NAVEGÓ EN EL MONTAJE. Es la mitad que impide "arreglarlo" con un efecto: si algún
    //     `useEffect` asignara `location.href`, la barra habría cambiado sola.
    expect(
      window.location.href,
      "algo navegó solo al montar: el salto tiene que ocurrir DENTRO de un gesto de la persona",
    ).toBe(antesDeMedir);
    // 4 · CD-18 — el fixture reprodujo el defecto: el rastro del KYC estaba puesto ANTES de medir. Sin
    //     esto, una URL pelada dejaría la fila de abajo verde sin haber ejercitado ninguna limpieza.
    expect(
      new URL(antesDeMedir).searchParams.get(PARAM_KYC),
      "el fixture no dejó el rastro del KYC en la URL de origen: no hay nada que limpiar",
    ).toBe(VALOR_VUELTA_KYC);
    // 5 · LO QUE LA BILLETERA VA A ABRIR, DESARMADO. ⛔ El prefijo `…/browse/…` no se escribe acá: el
    //     helper toma el último segmento del `path` y lo decodifica, sea cual sea ese prefijo.
    const abre = hrefQueLaBilleteraVaAAbrir(enlace.getAttribute("href") as string);
    expect(
      abre.searchParams.get(PARAM_KYC),
      "el `?kyc=return` viaja al navegador de la billetera: allá la puerta lo lee como una vuelta de " +
        "verificación y retoma un trámite que en ESE almacenamiento no existe",
    ).toBeNull();
    // 6 · Y LA OTRA MITAD, la que hace falsable a la de arriba: lo que SÍ es de la app sigue viajando.
    //     Sin esto, un `href` que borrara todos los parámetros —o que apuntara a la raíz pelada—
    //     pasaría la fila 5 sin haber limpiado nada en particular.
    expect(
      abre.searchParams.get("monto"),
      "el enlace se llevó puesto un parámetro de la app: limpiar el rastro no es vaciar la URL",
    ).toBe("400");
  });

  // MUTANTE QUE LO TIENE QUE MATAR: quitar la condición `disponibilidadWallet === "none"` de la
  // oferta ⇒ el bloque aparece también con la billetera inyectada y el `innerHTML` deja de ser
  // idéntico.
  // ⛔ FALSO KILLED A EVITAR: comparar sólo un texto en vez del `innerHTML` deja pasar cambios de
  // estructura. Patrón obligatorio: `T-065-21` (`:1037`), que compara el
  // `innerHTML` del paso entero.
  it("T-372-W1-2(control): con la billetera INYECTADA la pantalla de entrada es byte-idéntica", async () => {
    await enLaBienvenida("injected");
    const conInyectada = document.body.innerHTML;
    // CD-18 — que el fixture haya llegado a renderizar algo. Sin esto, dos pantallas vacías serían
    // "idénticas" y este `it` pasaría por vacío.
    expect(conInyectada.length, "no se llegó a renderizar la pantalla de entrada").toBeGreaterThan(200);
    expect(screen.queryByText(OFERTA), "la oferta apareció con la billetera INYECTADA").not.toBeInTheDocument();
    cleanup();

    // La otra mitad, la que hace falsable a la de arriba: en `"none"` la pantalla SÍ cambia. Sin esto,
    // un bloque que no se montara nunca pasaría el `queryByText` de arriba igual.
    await enLaBienvenida("none");
    expect(
      document.body.innerHTML,
      "la pantalla es igual en los dos cuadrantes: la oferta no se está montando en ninguno",
    ).not.toBe(conInyectada);
    expect(screen.getByText(OFERTA)).toBeInTheDocument();
  });

  // MUTANTE QUE LO TIENE QUE MATAR: borrar el segundo enlace (el de instalar) del bloque de la oferta.
  // ⛔ PROHIBIDO escribir acá el literal de la URL de descarga: sería el guard leyéndose a sí mismo, y
  // cambiar los dos lados a la vez lo dejaría verde. Se IMPORTA la constante.
  it("T-372-W1-6: la oferta trae un SEGUNDO enlace, el de instalar la billetera, y no es un callejón", async () => {
    await enLaBienvenida("none");

    const instalar = screen.getByRole("link", { name: INSTALAR });
    expect(instalar).toHaveAttribute("href", URL_INSTALAR_PHANTOM);
    // Y va a la MISMA billetera que el universal link, no a cualquier lado: el recorrido de
    // instalación termina en el mismo camino principal.
    expect(
      new URL(URL_INSTALAR_PHANTOM).hostname.split(".")[0],
      "el enlace de instalación no apunta a la misma billetera que el enlace de abrir",
    ).toBe(new URL(phantomBrowseUrl("https://x.test/", "https://x.test")).hostname.split(".")[0]);
    // ⛔ Y NO SE OFRECE NINGUNA BILLETERA CUSTODIAL NI EMBEBIDA: el único enlace de instalación es el
    // de la app no custodial, y no hay ningún «creá tu cuenta acá» que guarde la clave por la persona.
    const texto = screen.getByText(OFERTA).closest("div")?.parentElement?.textContent ?? "";
    expect(texto, "no se capturó el copy de la oferta").toContain("Abrí Chaski adentro de Phantom");
    expect(texto, "el copy ofrece una billetera custodial").not.toMatch(/custodi/i);
    expect(texto, "sin em dashes en el copy que ve la persona").not.toContain("—");
    // ⛔ CD-12 — esta ola NO baja el SOL del remitente a cero, y el copy no puede insinuarlo.
    expect(texto, "el copy afirma algo sobre el SOL que esta ola no cambió").not.toMatch(/no necesit[áa]s? SOL/i);
  });
});

describe("WKH-372/AC-1-4b: el aterrizaje dentro del navegador de la billetera, con sus TRES desenlaces", () => {
  /** Aterriza en la app con (o sin) la marca de salida, y con (o sin) borrador en el disco. */
  async function aterrizar(p: { conMarca: boolean; conBorrador: boolean }): Promise<void> {
    // ⛔ El hito se anota UNA sola vez por carga de la pestaña (es la foto del aterrizaje), así que
    //    sin esto el segundo caso leería el veredicto del primero.
    olvidarHitos();
    window.history.replaceState({}, "", p.conMarca ? `/?${PARAM_SALIDA}=${VALOR_SALIDA}` : "/");
    window.localStorage.setItem(
      CLAVE_DEL_REPO,
      p.conBorrador ? JSON.stringify([{ id: "r-1", status: "created" }]) : "[]",
    );
    await enLaBienvenida("none");
  }

  // MUTANTE QUE LO TIENE QUE MATAR: invertir la condición del aviso ⇒ el caso (c) se pone rojo, que
  // es el control que impide el aviso falso al visitante nuevo.
  // ⛔ SIN EL CASO (c), un mutante que ponga la condición en `true` SOBREVIVE: los casos (a) y (b) no
  // alcanzan para distinguir "aparece cuando corresponde" de "aparece siempre".
  it("T-372-W1-7: marca sin borrador AVISA; marca con borrador NO; sin marca NO", async () => {
    // (a) La marca dice que al salir había algo cargado, y en este disco no está ⇒ se dice.
    await aterrizar({ conMarca: true, conBorrador: false });
    expect(
      screen.getByText(AVISO_ATERRIZAJE),
      "la persona cruzó con datos cargados, del otro lado no están, y la app no se lo dijo",
    ).toBeInTheDocument();
    // El copy no explica una causa que nadie midió, y no dice que algo falló.
    const texto = screen.getByText(AVISO_ATERRIZAJE).closest("div")?.textContent ?? "";
    expect(texto, "el copy afirma una causa que nadie midió").not.toMatch(/guarda todo aparte|partición/i);
    expect(texto, "el copy dice que algo falló, y no falló").not.toMatch(/fall[óo]|error|se perdi[óo]/i);
    expect(texto, "el copy dice «empezá de nuevo», que es el pecado que este repo persigue").not.toMatch(
      /empez[áa] de nuevo/i,
    );
    // Y EL HITO, que es lo mismo pero legible desde `?diag=1` en el teléfono del founder. Sin este
    // par de aserciones, `anotarLaSalidaAlNavegador` sería un artefacto que alguien llama y que nadie
    // mira: el renglón diría cualquier cosa y la suite seguiría verde.
    expect(leerHito("salida-al-navegador"), "el hito no distingue el caso (a)").toBe("con-marca-sin-borrador");
    cleanup();

    // (b) La marca está y el borrador TAMBIÉN cruzó ⇒ no hubo nada que contar.
    await aterrizar({ conMarca: true, conBorrador: true });
    expect(
      screen.queryByText(AVISO_ATERRIZAJE),
      "el borrador cruzó y la app igual dijo que no estaba",
    ).not.toBeInTheDocument();
    expect(leerHito("salida-al-navegador"), "el hito no distingue el caso (b)").toBe("con-marca-y-borrador");
    cleanup();

    // (c) 🔴 EL CONTROL QUE SOSTIENE A LOS OTROS DOS: sin marca no hay aviso. A alguien que entra por
    //     primera vez dentro del navegador de la billetera no se le puede hablar de datos que nunca
    //     cargó. Este es el caso que un mutante «condición siempre verdadera» tiene que romper.
    await aterrizar({ conMarca: false, conBorrador: false });
    expect(
      screen.queryByText(AVISO_ATERRIZAJE),
      "a un visitante nuevo se le avisó sobre datos que nunca cargó",
    ).not.toBeInTheDocument();
    // ⛔ Y EL HITO DICE `sin-marca`, que NO es lo mismo que `con-marca-sin-borrador`: de una visita
    //    nueva no se puede concluir nada sobre si el almacenamiento cruzó. Colapsar los dos sería
    //    convertir «no pude preguntar» en «no pasó».
    expect(leerHito("salida-al-navegador"), "el hito colapsó `sin-marca` con `sin-borrador`").toBe("sin-marca");
    // Y la pantalla de entrada sigue siendo la de siempre: la oferta está, porque no hay wallet acá.
    expect(screen.getByText(OFERTA)).toBeInTheDocument();
  });

  // 🔴 EL RENGLÓN DEL BLOQUE DE DIAGNÓSTICO, Y POR QUÉ ESTE `it` EXISTE. La regla del propio
  // `./bitacora-de-vuelta.ts` es que un quinto hito «obliga a decidir qué pregunta contesta y a darle
  // renglón». El renglón se escribió, y MEDIDO: mientras nadie lo miraba, borrarlo dejaba la suite
  // entera en VERDE (`36 passed` en `diagnostico-de-vuelta.test.tsx`, `39 passed` acá). O sea que era
  // decoración: un artefacto que nadie mira no es un instrumento.
  //
  // 🔴 AR/MNR-1 — ACÁ DECÍA «Este `it` es su único guard» Y ERA FALSO. Corregido midiendo: MUT-D
  // (borrar el renglón del template) mata DOS, éste y (`T-DIAG-CAPTURA`,
  // `./diagnostico-de-vuelta.test.tsx:846`), que pinnea el texto EXACTO de los quince renglones y por
  // eso se pone rojo ante cualquiera que falte. Éste es su guard DEDICADO; aquél lo cubre de rebote,
  // por pinneo del texto. La frase vieja se escribió con la medición tomada ANTES de actualizar el
  // valor esperado de `T-DIAG-CAPTURA` —cuando el bloque todavía tenía catorce renglones y borrar el
  // decimoquinto no tocaba nada— y no se volvió a medir después de actualizarlo.
  // ⇒ Y LO QUE ESTE `it` APORTA SOBRE AQUÉL, que es por qué los dos hacen falta: `T-DIAG-CAPTURA`
  // anota los hitos A MANO y no monta `RemittanceFlow`, así que su valor esperado es `no corrió`. Éste
  // monta la pantalla real, o sea que es el único que mide que el renglón diga lo que el ATERRIZAJE
  // midió, y no un literal que alguien dejó puesto.
  //
  // MUTANTE QUE LO TIENE QUE MATAR: borrar del template de `./diagnostico-de-vuelta.tsx` el renglón
  // `salida navegador: …`.
  // ⛔ El bloque se monta APARTE porque en producción no cuelga del flujo sino de `app/page.tsx`;
  //    montarlo acá es lo que hace que este `it` mida el renglón REAL y no una copia.
  it("T-372-W1-7b: el bloque de diagnóstico publica el veredicto del aterrizaje, legible desde el teléfono", async () => {
    olvidarHitos();
    window.history.replaceState({}, "", `/?${PARAM_SALIDA}=${VALOR_SALIDA}&diag=1`);
    window.localStorage.setItem(CLAVE_DEL_REPO, "[]");
    await enLaBienvenida("none");
    // CD-18 — el hito se anotó: sin esto el renglón podría decir «no corrió» y el `it` mediría el
    // texto de un caso que nunca ocurrió.
    expect(leerHito("salida-al-navegador"), "el aterrizaje no se anotó").toBe("con-marca-sin-borrador");

    await act(async () => {
      render(<DiagnosticoDeVuelta />);
    });

    const bloque = document.querySelector("pre")?.textContent ?? "";
    expect(bloque, "el bloque de diagnóstico no se montó: `?diag=1` no lo encendió").toContain("DIAG");
    expect(
      bloque,
      "el bloque de diagnóstico no publica el veredicto del aterrizaje: en el teléfono no hay forma " +
        "de leer si el almacenamiento cruzó el salto",
    ).toContain("salida navegador: con-marca-sin-borrador");
  });

  // 🔴 AR/MNR-4 — LA PANTALLA DONDE EL AVISO SE PINTA, QUE HASTA EL FIX-PACK NO TENÍA GATE. El aviso
  // de aterrizaje no llevaba ninguna condición de `step`, así que con la marca puesta y el disco vacío
  // seguía clavado arriba de `send`, `history` y `recuperar`: «Acá no están los datos que cargaste
  // antes» encima de una lista vacía en «Mis envíos». Esta HU existe porque la experiencia no se veía
  // profesional, y eso es exactamente eso. La OFERTA de al lado ya llevaba `step === "bienvenida"` con
  // su motivo escrito, así que el gate nuevo es CONSISTENCIA con el vecino, no diseño nuevo.
  //
  // MUTANTE QUE LO TIENE QUE MATAR: quitar `step === "bienvenida" &&` de la condición del aviso
  // (`flow.tsx:757`) ⇒ el caso (b) se pone rojo.
  // ⛔ FALSO KILLED A EVITAR: sin el caso (a), un aviso que no se montara en NINGUNA pantalla pasaría
  //    el `queryByText` de (b) sin haber medido nada.
  // ⚠️ LA PANTALLA MEDIDA ES `recuperar` Y NO `history`, y no es capricho: con `pasoInicial="history"`
  //    el estado del historial es `null` y el sitio de render no pinta NINGUNA pantalla (medido en
  //    `barra-destinos.test.tsx:504-518`: 59 caracteres de body). El fixture sería el header solo, y
  //    entonces la fila (b) pasaría por no haber montado un destino. `recuperar` sí se pinta, y por eso
  //    puede traer su propio marcador de CD-18.
  it("T-372-W1-7c: el aviso de aterrizaje vive en la bienvenida y no se cuela en los destinos", async () => {
    olvidarHitos();
    window.history.replaceState({}, "", `/?${PARAM_SALIDA}=${VALOR_SALIDA}`);
    window.localStorage.setItem(CLAVE_DEL_REPO, "[]");

    // (a) EN LA BIENVENIDA SÍ. Es la mitad que hace falsable a la otra.
    await enLaBienvenida("none");
    expect(
      screen.getByText(AVISO_ATERRIZAJE),
      "el aviso dejó de aparecer en la pantalla donde SÍ corresponde: el fixture no reproduce el caso",
    ).toBeInTheDocument();
    cleanup();

    // (b) EN UN DESTINO NO. El mismo aterrizaje, otra pantalla.
    render(<RemittanceFlow pasoInicial="recuperar" container={buildTestContainer()} />);
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
    });
    // CD-18 — el destino se montó de verdad: sin esto, una pantalla que no pintara nada dejaría la
    // aserción de abajo verde sin haber ejercitado el gate.
    expect(
      screen.getByText(/Recuperar fondos de un envío anterior/),
      "la pantalla de destino no se montó: la fila de abajo no mediría ningún gate",
    ).toBeInTheDocument();
    expect(
      screen.queryByText(AVISO_ATERRIZAJE),
      "el aviso del aterrizaje quedó clavado arriba de una pantalla de destino, que es la falta de " +
        "prolijidad que esta HU vino a cerrar",
    ).not.toBeInTheDocument();
  });
});
