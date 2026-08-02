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
import { solanaWalletBridge } from "../../infrastructure/solana-wallet-bridge";

// Estado mutable de los hooks, compartido con las factorías de vi.mock (hoisted).
const h = vi.hoisted(() => ({
  wallet: {
    publicKey: null as { toBase58: () => string } | null,
    connected: false,
    connecting: false,
    signMessage: undefined as ((m: Uint8Array) => Promise<Uint8Array>) | undefined,
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
  h.wallet = { publicKey: null, connected: false, connecting: false, signMessage: undefined };
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
    await act(async () => {
      onError?.(Object.assign(new Error("boom"), { name: "WalletNotReadyError" }));
    });

    expect(p.outcome()).toBe("no_wallet");
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
