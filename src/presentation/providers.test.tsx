// @vitest-environment jsdom
//
// WKH-320: este archivo probaba el GATING por VM: con VM=solana montaba el árbol Solana y con la VM
// unset/evm hacía passthrough sin montar nada. Ese segundo caso probaba un estado que dejó de ser
// expresable — no hay una VM que pueda no ser Solana, así que no hay configuración en la que el
// árbol NO se monte. Lo que se clava ahora es lo contrario y es más fuerte: se monta SIEMPRE, sin
// leer una sola env.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { Providers } from "./providers";

// Stub liviano del árbol Solana (evita CSS + lib pesada en vitest). El dynamic import de
// providers.tsx resuelve a este mock.
vi.mock("./solana/solana-providers", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="solana-tree">{children}</div>
  ),
}));

afterEach(() => {
  cleanup(); // desmonta el DOM entre tests (patrón flow.test.tsx) — evita children duplicados
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("Providers — el árbol Solana se monta SIEMPRE (WKH-320 / AC-1)", () => {
  it("monta el árbol Solana envolviendo children", async () => {
    render(
      <Providers>
        <div data-testid="child">app</div>
      </Providers>,
    );
    // next/dynamic({ssr:false}) resuelve el chunk tras el mount
    await waitFor(() => expect(screen.getByTestId("solana-tree")).toBeInTheDocument());
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("lo monta IGUAL sin ninguna env de configuración presente (cero dispatcher)", async () => {
    // Si alguien reintrodujera un `if` por env, con todo ausente caería al passthrough y esto
    // se pondría rojo.
    render(
      <Providers>
        <div data-testid="child">app</div>
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId("solana-tree")).toBeInTheDocument());
  });
});
