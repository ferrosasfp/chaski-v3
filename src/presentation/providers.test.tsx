// @vitest-environment jsdom
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

const ORIGINAL_VM = process.env.NEXT_PUBLIC_VM;
afterEach(() => {
  cleanup(); // desmonta el DOM entre tests (patrón flow.test.tsx) — evita children duplicados
  if (ORIGINAL_VM === undefined) delete process.env.NEXT_PUBLIC_VM;
  else process.env.NEXT_PUBLIC_VM = ORIGINAL_VM;
  vi.clearAllMocks();
});

describe("Providers — gating por VM", () => {
  it("VM=solana → monta el árbol Solana envolviendo children (AC-1)", async () => {
    process.env.NEXT_PUBLIC_VM = "solana";
    render(
      <Providers>
        <div data-testid="child">app</div>
      </Providers>,
    );
    // next/dynamic({ssr:false}) resuelve el chunk tras el mount
    await waitFor(() => expect(screen.getByTestId("solana-tree")).toBeInTheDocument());
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("VM unset/evm → passthrough, NINGÚN provider Solana montado (AC-3)", () => {
    delete process.env.NEXT_PUBLIC_VM; // default = evm
    render(
      <Providers>
        <div data-testid="child">app</div>
      </Providers>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(screen.queryByTestId("solana-tree")).toBeNull(); // cero árbol Solana
  });
});
