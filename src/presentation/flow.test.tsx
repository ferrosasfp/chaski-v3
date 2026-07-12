// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { FallbackQuoteGateway } from "../infrastructure/fallback/gateways";
import { ResumeKyc } from "../application/use-cases/resume-kyc";

// CD-8 / DT-7: framer-motion pass-through. jsdom no implementa requestAnimationFrame → el exit de
// AnimatePresence no completa y los steps (review, vuelta a send) NUNCA montarían. El mock solo
// elimina la animación (presentación), no la lógica.
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...props }: any) =>
          React.createElement(tag, props, children),
    },
  ),
}));

afterEach(() => cleanup());

// ── Helpers de navegación (send → connect → verify → review) ─────────────────
function fillSend(recipient = "Mamá", destination = "999888777"): void {
  fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), {
    target: { value: recipient },
  });
  fireEvent.change(screen.getByPlaceholderText("999 888 777"), {
    target: { value: destination },
  });
}

async function goToReview(): Promise<void> {
  fillSend();
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Escanear DNI \+ selfie/ }));
}

// ── T1 — AC-4 (harness smoke) + banner "Modo demo" (WKH-178) ─────────────────
// FallbackQuoteGateway → provenance "local-fallback" → dispara isDemoMode.
it("T1: modo demo muestra el monto del quote (no S/0.00) y el banner 'Modo demo' una sola vez", async () => {
  render(<RemittanceFlow container={buildTestContainer({ quotes: new FallbackQuoteGateway() })} />);

  await goToReview();

  // (b) banner "Modo demo — sin dinero real" presente, una sola vez.
  const banners = await screen.findAllByText(
    /Modo demo \(sin dinero real\)/,
    {},
    { timeout: 6000 },
  );
  expect(banners).toHaveLength(1);
  expect(banners[0]).toBeInTheDocument();

  // (a) el card de review muestra un monto PEN concreto del quote — nunca "S/0.00" ni "—".
  const receive = screen.getByText(/^S\/[\d,]+\.\d{2}$/);
  expect(receive).toBeInTheDocument();
  expect(receive.textContent).not.toBe("S/0.00");
  // (c) cero red: los fakes no llaman fetch de negocio (FallbackQuoteGateway cae al estático, CD-5).
});

// ── T2 — AC-9: review nombre + doc enmascarado (CD-12) ───────────────────────
it("T2: review renderiza el nombre y el documento enmascarado; el número completo nunca está en el DOM", async () => {
  const { container } = render(<RemittanceFlow container={buildTestContainer()} />);

  await goToReview();

  // (a) nombre completo visible.
  expect(await screen.findByText(/Test Quispe Mamani/)).toBeInTheDocument();
  // (b) documento enmascarado visible (DNI + últimos 4).
  expect(screen.getByText(/DNI/)).toBeInTheDocument();
  expect(screen.getByText(/••••5678/)).toBeInTheDocument();
  // (c) CD-12: el número de documento completo NUNCA aparece en el DOM.
  expect(screen.queryByText(/12345678/)).toBeNull();
  expect(container.textContent).not.toContain("12345678");
});

// ── T4 — AC-7: control reset visible solo con address (WKH-184) ──────────────
it("T4: '¿No sos vos?' aparece solo con una address conectada", async () => {
  render(<RemittanceFlow container={buildTestContainer()} />);

  // (i) render inicial: address === null → sin control de reset.
  expect(screen.queryByText("¿No sos vos?")).toBeNull();

  // (ii) send → connect: FakeWallet.connect() = "0xSender".
  fillSend();
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));

  // (b) con address conectada → aparece el control + el badge de address.
  expect(await screen.findByText("¿No sos vos?")).toBeInTheDocument();
  expect(screen.getByText(/0xSend/)).toBeInTheDocument();
});

// ── T5 — AC-6 + AC-8: reset limpia estado React + PII (WKH-184 + MNR-1) ───────
it("T5: 'Empezar de nuevo' limpia address + PII del beneficiario y vuelve a 'send'", async () => {
  render(<RemittanceFlow container={buildTestContainer()} />);

  fillSend("Mamá", "999888777");
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));

  // Con address conectada → abrir la confirmación y ejecutar forgetAndDisconnect.
  fireEvent.click(await screen.findByText("¿No sos vos?"));
  fireEvent.click(await screen.findByText("Empezar de nuevo"));

  // (a) vuelve a "send" (input de monto visible de nuevo).
  const amountInput = (await screen.findByLabelText("Monto en dólares")) as HTMLInputElement;
  expect(amountInput).toBeInTheDocument();

  // (b) badge de address desaparece (address === null).
  await waitFor(() => expect(screen.queryByText(/0xSend/)).toBeNull());

  // (c) recipient limpio · (d) destino limpio · (e) monto vuelve al default "400".
  const recipientInput = screen.getByPlaceholderText("Nombre de tu familiar") as HTMLInputElement;
  const destinationInput = screen.getByPlaceholderText("999 888 777") as HTMLInputElement;
  expect(recipientInput.value).toBe("");
  expect(destinationInput.value).toBe("");
  expect(amountInput.value).toBe("400");
});

// ── T3 — AC-5: botón "Reintentar" + retry sin reload (fake timers, CD-10) ─────
describe("T3 (fake timers aislados, CD-10)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("tras el timeout del resume-KYC muestra 'Reintentar' y el retry NO recarga la página", async () => {
    // resumeKyc siempre "processing" → el resume-loop (40× sleep(2500)) agota el timeout.
    const container = buildTestContainer({
      useCases: {
        resumeKyc: {
          execute: async () => ({ kind: "processing" as const }),
        } as unknown as ResumeKyc,
      },
    });
    render(<RemittanceFlow container={container} />);

    // Agotar el loop (40 × 2500 ms = 100 s) → estado timedOut.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100_000);
    });

    // (a) botón "Reintentar" visible.
    expect(screen.getByText("Reintentar")).toBeInTheDocument();

    // Spy sobre window.location.reload — onRetryKyc NO debe recargar. jsdom marca reload como
    // non-configurable, así que se reemplaza el objeto location entero (restaurado al final).
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });

    try {
      // (b) click "Reintentar" → vuelve a "send"; "Reintentar" desaparece.
      act(() => {
        fireEvent.click(screen.getByText("Reintentar"));
      });
      expect(screen.getByLabelText("Monto en dólares")).toBeInTheDocument();
      expect(screen.queryByText("Reintentar")).toBeNull();

      // (c) onRetryKyc no llama a window.location.reload.
      expect(reloadSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });
});
