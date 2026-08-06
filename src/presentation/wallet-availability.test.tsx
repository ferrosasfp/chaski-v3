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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RemittanceFlow } from "./flow";
import { phantomBrowseUrl } from "./wallet-availability";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
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
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  solanaWalletBridge.reset();
  quitarWalletInyectada();
  vi.clearAllMocks();
});

// ── (B) CABLEADO: la condición sale de la librería, no de un doble ────────────────────────────────
async function montarArbolYLeerDisponibilidad(): Promise<string> {
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
    await new Promise((r) => setTimeout(r, 1200));
  });
  return solanaWalletBridge.getWalletAvailability();
}

describe("cableado: el árbol REAL empuja la disponibilidad, nadie la setea a mano", () => {
  it("T-CABLE-1: celular sin wallet inyectada ⇒ 'none'", async () => {
    setUserAgent(UA_ANDROID_CHROME);
    // ⬅️ Invertir la condición de `solana-providers.tsx` (Installed → !== Installed) mata este test.
    expect(await montarArbolYLeerDisponibilidad()).toBe("none");
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
