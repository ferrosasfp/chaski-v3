// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Receipt, RemittanceFlow, TrackView } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { FallbackQuoteGateway } from "../infrastructure/fallback/gateways";
import type { ResumeKyc } from "../application/use-cases/resume-kyc";
import type { AbandonPendingKyc } from "../application/use-cases/abandon-pending-kyc";
import type { LockQuote } from "../application/use-cases/lock-quote";
import type { ConfirmAndSend } from "../application/use-cases/confirm-and-send";
import type { TrackRemittance } from "../application/use-cases/track-remittance";
import { Money } from "../domain/money";
import {
  type KycVerification,
  Remittance,
  type RemittanceState,
  toPersistedIdentity,
} from "../domain/remittance";
import { RecoverEscrowFunds } from "../application/use-cases/recover-escrow-funds";
import {
  FAKE_SOLANA_BENEFICIARY,
  FAKE_SOLANA_SIGNATURE,
  FakeKycStore,
  FakeSolanaEscrowRefundGateway,
  FakeSolanaWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  beneficiary,
} from "../test-support/fakes";

// WKH-187: identidad reducida canónica (misma que FakeKycGateway) para snapshots de resume.
const passIdentity = toPersistedIdentity({
  firstName: "Test",
  lastNamePaternal: "Quispe",
  lastNameMaternal: "Mamani",
  documentType: "DNI",
  documentNumber: "12345678",
  dateOfBirth: "1990-01-01",
  nationality: "PE",
});
const passKyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true,
  riskLevel: "low",
  provenance: "didit",
  identity: passIdentity,
};

// Construye un snapshot kyc_passed (con quote) para stubbear resumeKyc en los tests de resume.
function passedSnapshot(receiveMajor: number, rate: number, expiresAt: string): RemittanceState {
  const r = Remittance.create("rem-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(
    {
      quoteId: "q",
      send: Money.of(400, "USDC"),
      receive: Money.of(receiveMajor, "PEN"),
      feeUsd: Money.of(0.5, "USDC"),
      rate,
      etaMinutes: 30,
      expiresAt,
      provenance: "fake",
    },
    T0,
  );
  r.startKyc(T0, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  r.applyKyc(passKyc, T0);
  return r.snapshot;
}

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
        ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
          React.createElement(tag, props, children),
    },
  ),
}));

afterEach(() => cleanup());

// ── Helpers de navegación (WKH-187: send → connect → review(pre-KYC) → verify → confirm) ──────
function fillSend(recipient = "Mamá", destination = "999888777"): void {
  fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), {
    target: { value: recipient },
  });
  fireEvent.change(screen.getByPlaceholderText("999 888 777"), {
    target: { value: destination },
  });
}

// send → connect → review pre-KYC (quote ya lockeado, sin escaneo aún).
async function goToReview(): Promise<void> {
  fillSend();
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));
  await screen.findByText(/Revisá el envío/); // paso review pre-KYC
}

// review → verify → confirm post-KYC (recorrido completo hasta el review con identidad).
async function goToConfirm(): Promise<void> {
  await goToReview();
  fireEvent.click(await screen.findByRole("button", { name: /Continuar/ })); // CTA review → verify
  fireEvent.click(await screen.findByRole("button", { name: /Escanear DNI \+ selfie/ }));
  await screen.findByRole("button", { name: /Confirmar y enviar/ }); // paso confirm
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

// ── WKH-314 — la interfaz no puede habilitar un envío que entrega cero ───────────────
//
// Antes: escribías 40 centavos, la pantalla decía "Tu familia recibe S/ 0.00" con la tasa y el
// ETA al lado como si fuera una cotización normal, y el botón Continuar quedaba HABILITADO
// (`canSend = amountNum > 0`). El depósito se arma con el monto ENVIADO, así que la persona
// terminaba poniendo dólares reales a cambio de nada.
//
// La protección real vive en el agente (`fx_amount_below_minimum`); esto es que la persona se
// entere ANTES del nombre, el KYC y la plata.
it("T-314-UI-1: por debajo del mínimo el botón NO habilita y se explica por qué", async () => {
  render(<RemittanceFlow container={buildTestContainer()} />);

  const amountInput = await screen.findByLabelText("Monto en dólares");
  fireEvent.change(amountInput, { target: { value: "0.40" } });
  fillSend(); // nombre y destino completos: lo ÚNICO que falta es que el monto alcance

  // ── EL EFECTO PRIMERO: no se puede avanzar ────────────────────────────────────────
  // Si esto fuera después del chequeo del texto, un mutante que rompiera el mensaje mataría
  // el test sin llegar a mirar lo que importa, que es que nadie pueda depositar.
  expect(screen.getByRole("button", { name: /Continuar/ })).toBeDisabled();
  // Y no se muestra un cero disfrazado de cotización.
  expect(screen.queryByText("S/0.00")).toBeNull();

  // ── y recién ahora, que la persona entienda qué hacer ─────────────────────────────
  expect(await screen.findByRole("alert")).toHaveTextContent(/mínimo para enviar es \$5/i);
});

// Contra-ejemplo OBLIGATORIO: sin esto, deshabilitar el botón SIEMPRE dejaba el test de arriba
// en verde y la app inutilizable.
it("T-314-UI-2: en el mínimo exacto el botón SÍ habilita y no hay advertencia", async () => {
  render(<RemittanceFlow container={buildTestContainer()} />);

  const amountInput = await screen.findByLabelText("Monto en dólares");
  fireEvent.change(amountInput, { target: { value: "5" } });
  fillSend();

  expect(screen.getByRole("button", { name: /Continuar/ })).toBeEnabled();
  expect(screen.queryByRole("alert")).toBeNull();
});

// ── T2 — AC-9: review nombre + doc enmascarado (CD-12) ───────────────────────
it("T2: confirm renderiza el nombre y el documento enmascarado; el número completo nunca está en el DOM", async () => {
  const { container } = render(<RemittanceFlow container={buildTestContainer()} />);

  await goToConfirm();

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

  // (ii) send → connect: FakeWallet.connect() = la pubkey base58 "4zMMC9…".
  fillSend();
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));

  // (b) con address conectada → aparece el control + el badge de address.
  expect(await screen.findByText("¿No sos vos?")).toBeInTheDocument();
  expect(screen.getByText(/4zMMC9/)).toBeInTheDocument();
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
  await waitFor(() => expect(screen.queryByText(/4zMMC9/)).toBeNull());

  // (c) recipient limpio · (d) destino limpio · (e) monto vuelve al default "400".
  const recipientInput = screen.getByPlaceholderText("Nombre de tu familiar") as HTMLInputElement;
  const destinationInput = screen.getByPlaceholderText("999 888 777") as HTMLInputElement;
  expect(recipientInput.value).toBe("");
  expect(destinationInput.value).toBe("");
  expect(amountInput.value).toBe("400");
});

// ── T-AC1 / T-REORDER (RTL) — AC-1: el quote es visible ANTES del KYC ─────────
it("T-AC1/T-REORDER: tras conectar, el paso review muestra el quote (S/ concreto) ANTES de cualquier UI de KYC", async () => {
  render(<RemittanceFlow container={buildTestContainer()} />);

  await goToReview(); // send → connect → review (SIN pasar por verify)

  // (a) el monto que recibe la familia está visible en el review pre-KYC.
  const receive = screen.getByText(/^S\/[\d,]+\.\d{2}$/);
  expect(receive).toBeInTheDocument();
  expect(receive.textContent).not.toBe("S/0.00");
  // (b) todavía NO hay UI de KYC (ni escaneo ni badge de identidad).
  expect(screen.queryByRole("button", { name: /Escanear DNI \+ selfie/ })).toBeNull();
  expect(screen.queryByText(/Identidad verificada/)).toBeNull();
});

// ── T-AC2 — AC-2: "Continuar" del review NO auto-inicia el KYC ────────────────
it("T-AC2: el review tiene 'Continuar'; el escaneo aparece recién tras el tap (KYC no auto-inicia)", async () => {
  render(<RemittanceFlow container={buildTestContainer()} />);

  await goToReview();

  // (a) el review pre-KYC no muestra el escaneo.
  expect(screen.queryByRole("button", { name: /Escanear DNI \+ selfie/ })).toBeNull();
  // (b) tras tapear "Continuar" recién aparece el escaneo (paso verify).
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  expect(await screen.findByRole("button", { name: /Escanear DNI \+ selfie/ })).toBeInTheDocument();
});

// ── T-AC4 — AC-4: KYC-once salta review+verify y va directo a confirm ─────────
it("T-AC4: KYC-once → tras conectar va directo a confirm (sin review ni escaneo), con quote lockeado", async () => {
  const kycStore = new FakeKycStore();
  await kycStore.save("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", passKyc); // wallet ya verificada
  render(<RemittanceFlow container={buildTestContainer({ kycStore })} />);

  fillSend();
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));

  // (a) aterriza en confirm: botón "Confirmar y enviar" + identidad + quote.
  expect(await screen.findByRole("button", { name: /Confirmar y enviar/ })).toBeInTheDocument();
  expect(screen.getByText(/Identidad verificada/)).toBeInTheDocument();
  expect(screen.getByText(/^S\/[\d,]+\.\d{2}$/)).toBeInTheDocument();
  // (b) nunca pasó por el escaneo de DNI.
  expect(screen.queryByRole("button", { name: /Escanear DNI \+ selfie/ })).toBeNull();
});

// ── T-AC8 — AC-8: confirm muestra el badge de identidad junto al quote ────────
it("T-AC8: el paso confirm muestra el badge de identidad (rem.kyc.identity) junto al quote", async () => {
  render(<RemittanceFlow container={buildTestContainer()} />);

  await goToConfirm();

  expect(screen.getByText(/Identidad verificada/)).toBeInTheDocument();
  expect(screen.getByText(/Test Quispe Mamani/)).toBeInTheDocument();
  expect(screen.getByText(/^S\/[\d,]+\.\d{2}$/)).toBeInTheDocument(); // quote junto a la identidad
});

// ── T-AC5b — AC-5: en confirm con quote vencido, Recotizar NO vuelve al escaneo ─
it("T-AC5b: en confirm, si el quote venció, 'Recotizar tasa' re-cotiza SIN re-escanear DNI", async () => {
  // confirmAndSend rechaza (quote vencido) → aparece el botón "Recotizar tasa".
  const rejecting = {
    execute: async () => {
      throw new Error("confirm_quote_expired");
    },
  } as unknown as ConfirmAndSend;
  render(<RemittanceFlow container={buildTestContainer({ useCases: { confirmAndSend: rejecting } })} />);

  await goToConfirm();
  fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

  // (a) el error dispara el botón de recotización (MNR-1).
  const relock = await screen.findByRole("button", { name: /Recotizar tasa/ });
  fireEvent.click(relock);

  // (b) tras re-cotizar seguimos en confirm (vuelve el CTA de enviar), NUNCA al escaneo de DNI.
  expect(await screen.findByRole("button", { name: /Confirmar y enviar/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Escanear DNI \+ selfie/ })).toBeNull();
  expect(screen.getByText(/Identidad verificada/)).toBeInTheDocument(); // el KYC se conservó
});

// ── T-AC6 — AC-6: resume con quote vigente → confirm SIN re-cotizar ───────────
it("T-AC6: resume 'passed' con quote vigente navega a confirm SIN re-cotizar", async () => {
  const snapshot = passedSnapshot(1478.15, 3.7, "2099-01-01T00:00:00.000Z"); // vigente en tiempo real
  const lockSpy = vi.fn();
  const container = buildTestContainer({
    useCases: {
      resumeKyc: { execute: async () => ({ kind: "passed" as const, snapshot }) } as unknown as ResumeKyc,
      lockQuote: { execute: lockSpy } as unknown as LockQuote,
    },
  });
  render(<RemittanceFlow container={container} />);

  // el efecto de resume corre al montar → quote vigente → confirm directo.
  expect(await screen.findByRole("button", { name: /Confirmar y enviar/ })).toBeInTheDocument();
  expect(lockSpy).not.toHaveBeenCalled(); // AC-6: NO re-cotiza
  expect(screen.queryByText(/La tasa se actualizó/)).toBeNull();
});

// ── T-REQUOTE (RTL) — AC-5: expiry durante el KYC → auto re-cotiza + monto nuevo ─
it("T-REQUOTE: resume 'passed' con quote vencido auto re-cotiza, muestra el monto nuevo y NO re-escanea", async () => {
  const stale = passedSnapshot(1478.15, 3.7, QUOTE_EXPIRES); // vencido en tiempo real
  const fresh = passedSnapshot(1500, 3.75, "2099-01-01T00:00:00.000Z"); // monto nuevo
  const container = buildTestContainer({
    useCases: {
      resumeKyc: { execute: async () => ({ kind: "passed" as const, snapshot: stale }) } as unknown as ResumeKyc,
      lockQuote: { execute: async () => ({ status: "quoted" as const, snapshot: fresh }) } as unknown as LockQuote,
    },
  });
  render(<RemittanceFlow container={container} />);

  // (a) aterriza en confirm con el indicador de tasa actualizada.
  expect(await screen.findByText(/La tasa se actualizó/)).toBeInTheDocument();
  // (b) muestra el monto NUEVO (S/1,500.00), no el viejo.
  expect(screen.getByText("S/1,500.00")).toBeInTheDocument();
  // (c) sin re-escaneo de DNI: el KYC se conservó.
  expect(screen.queryByRole("button", { name: /Escanear DNI \+ selfie/ })).toBeNull();
  expect(screen.getByText(/Identidad verificada/)).toBeInTheDocument();
});

// ── T-ESC1..T-ESC6 — WKH-188: escape visible + timeout de 20 s (fake timers) ───
describe("WKH-188 resume escape (fake timers aislados, CD-10)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  // Setup común: resumeKyc siempre "processing" → el overlay `resuming` se mantiene.
  function escapeContainer() {
    const resumeSpy = vi.fn(async () => ({ kind: "processing" as const }));
    const abandonSpy = vi.fn(async () => {});
    const container = buildTestContainer({
      useCases: {
        resumeKyc: { execute: resumeSpy } as unknown as ResumeKyc,
        abandonPendingKyc: { execute: abandonSpy } as unknown as AbandonPendingKyc,
      },
    });
    return { container, resumeSpy, abandonSpy };
  }

  // Ancla el timer del escape apenas `resuming` se vuelve true (1er flush chico), y luego avanza
  // bien pasado el umbral de 5 s → el botón de escape queda visible de forma determinista.
  // Auto-blindaje WKH-188: bajo fake timers, el flush del efecto passive de React se ancla al
  // FINAL del primer chunk de `advanceTimersByTimeAsync`; si el 1er advance es grande (p.ej. 6000),
  // el setTimeout(5000) del escape se agenda tarde y no dispara a tiempo. Un 1er flush de 1 ms lo
  // ancla cerca de t≈0 → el escape cruza los 5 s como se espera.
  async function armEscape(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1); // ancla: resuming=true + escape timer agendado ~t=0
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6999); // total ~7 s (> 5 s umbral, < 20 s timeout)
    });
  }

  // ── T-ESC1 — AC-1: el escape aparece a los 5 s, no antes ──────────────────
  it("T-ESC1: el escape aparece a los 5 s, no antes", async () => {
    const { container } = escapeContainer();
    render(<RemittanceFlow container={container} />);

    // Ancla el timer del escape apenas resuming=true (ver armEscape / auto-blindaje).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    // A ~4 s: sin botón de escape, pero el overlay de resume ya está visible.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3999); // total ~4 s
    });
    expect(screen.queryByRole("button", { name: /Empezar de nuevo/ })).toBeNull();
    expect(screen.getByText(/Verificando tu identidad/)).toBeInTheDocument();

    // Pasado el umbral de 5 s: el botón de escape aparece (sigue en resuming, lejos del timeout).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000); // total ~7 s
    });
    expect(screen.getByRole("button", { name: /Empezar de nuevo/ })).toBeInTheDocument();
  });

  // ── T-ESC2 — AC-2: cancelar limpia el pending y vuelve a `send` ───────────
  it("T-ESC2: cancelar limpia el pending y vuelve a 'send'", async () => {
    const { container, abandonSpy } = escapeContainer();
    render(<RemittanceFlow container={container} />);

    await armEscape();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Empezar de nuevo/ }));
    });

    // (a) abandonPendingKyc llamado 1× (antes de navegar).
    expect(abandonSpy).toHaveBeenCalledTimes(1);
    // (b) volvió al paso `send`; el overlay de resume desapareció.
    expect(screen.getByLabelText("Monto en dólares")).toBeInTheDocument();
    expect(screen.queryByText(/Verificando tu identidad/)).toBeNull();
  });

  // ── T-ESC3 — AC-3: cancelar detiene el loop (sin más resumeKyc) ──────────
  it("T-ESC3: cancelar detiene el loop (sin más resumeKyc)", async () => {
    const { container, resumeSpy } = escapeContainer();
    render(<RemittanceFlow container={container} />);

    await armEscape();
    const n = resumeSpy.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Empezar de nuevo/ }));
    });
    // Avanzar bien más allá del intervalo de poll: el loop no debe volver a poletear.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });

    expect(resumeSpy.mock.calls.length).toBe(n);
    expect(screen.getByLabelText("Monto en dólares")).toBeInTheDocument();
  });

  // ── T-ESC4 — AC-4: el escape NO abre camino a `confirm` sin KYC ──────────
  it("T-ESC4: el escape NO abre camino a confirm sin KYC", async () => {
    const { container } = escapeContainer();
    render(<RemittanceFlow container={container} />);

    await armEscape();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Empezar de nuevo/ }));
    });

    expect(screen.queryByRole("button", { name: /Confirmar y enviar/ })).toBeNull();
    expect(screen.queryByText(/Identidad verificada/)).toBeNull();
    expect(screen.getByLabelText("Monto en dólares")).toBeInTheDocument();
  });

  // ── T-ESC5 — AC-5: timeout total 20 s (no 100 s) + `timedOut` (ex-T3) ─────
  it("T-ESC5: tras el timeout del resume-KYC (8× sleep(2500) = 20 s) muestra 'Reintentar' y el retry NO recarga la página", async () => {
    // resumeKyc siempre "processing" → el resume-loop (8× sleep(2500) = 20 s) agota el timeout.
    const abandonSpy = vi.fn(async () => {});
    const container = buildTestContainer({
      useCases: {
        resumeKyc: {
          execute: async () => ({ kind: "processing" as const }),
        } as unknown as ResumeKyc,
        abandonPendingKyc: { execute: abandonSpy } as unknown as AbandonPendingKyc,
      },
    });
    render(<RemittanceFlow container={container} />);

    // MENOR-1 (CR): borde inferior — ANTES de los 20 s el timeout NO debe dispararse.
    // Guarda contra un timeout accidentalmente más corto (p.ej. RESUME_MAX_POLLS=4 → 10 s).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.queryByText("Reintentar")).toBeNull();
    expect(screen.getByText(/Verificando tu identidad/)).toBeInTheDocument();

    // Completar el loop (total 8 × 2500 ms = 20 s) → estado timedOut.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // (a) botón "Reintentar" visible + abandon llamado al agotarse (WKH-178).
    expect(screen.getByText("Reintentar")).toBeInTheDocument();
    expect(abandonSpy).toHaveBeenCalled();

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

  // ── T-ESC6 — AC-6: respuesta terminal `failed` sale de `resuming` al 1er poll ─
  it("T-ESC6: respuesta terminal 'failed' sale de resuming al primer poll", async () => {
    // La rama `failed` solo hace setRem + setStep("verify"); cualquier snapshot válido sirve.
    const failedSnapshot = Remittance.create("rem-1", beneficiary(), Money.of(400, "USDC"), T0).snapshot;
    const container = buildTestContainer({
      useCases: {
        resumeKyc: {
          execute: async () => ({ kind: "failed" as const, snapshot: failedSnapshot }),
        } as unknown as ResumeKyc,
      },
    });
    render(<RemittanceFlow container={container} />);

    // El primer poll es terminal (sin sleep) → aterriza en `verify`. Flush sin disparar el escape (5 s).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("button", { name: /Escanear DNI \+ selfie/ })).toBeInTheDocument();
    expect(screen.getByText(/La verificación no pasó/)).toBeInTheDocument();

    // El escape NUNCA aparece (el overlay `resuming` nunca estuvo activo el tiempo suficiente).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(screen.queryByRole("button", { name: /Empezar de nuevo/ })).toBeNull();
  });

  // ── T-ESC7 — BLQ-MED-1 (AR): escape durante execute() en vuelo NO re-cuelga el overlay ─
  // Regresión del bug que la HU vino a matar: si el usuario clickea "Empezar de nuevo" mientras
  // un `resumeKyc.execute()` está en vuelo y ese execute() resuelve DESPUÉS del click, el loop
  // NO debe volver a `setResuming(true)`. Sin el guard `cancelledRef` tras el `await execute()`
  // (flow.tsx, 3er punto de suspensión) este test queda ROJO: el overlay reaparece STUCK en `send`.
  it("T-ESC7: cancelar mientras execute() está en vuelo NO re-cuelga el overlay (BLQ-MED-1)", async () => {
    // resumeKyc.execute() devuelve promesas DIFERIDAS (resueltas a mano), para cruzar el click.
    const pendingResolvers: Array<(v: { kind: "processing" }) => void> = [];
    const resumeSpy = vi.fn(
      () =>
        new Promise<{ kind: "processing" }>((resolve) => {
          pendingResolvers.push(resolve);
        }),
    );
    const abandonSpy = vi.fn(async () => {});
    const container = buildTestContainer({
      useCases: {
        resumeKyc: { execute: resumeSpy } as unknown as ResumeKyc,
        abandonPendingKyc: { execute: abandonSpy } as unknown as AbandonPendingKyc,
      },
    });
    render(<RemittanceFlow container={container} />);

    // (1) 1er execute() creado al montar; lo resolvemos con `processing` → resuming=true + ancla el
    // timer del escape cerca de t≈0 (auto-blindaje WKH-188).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1); // deja que el loop llame al 1er execute()
    });
    await act(async () => {
      pendingResolvers[0]!({ kind: "processing" });
      await vi.advanceTimersByTimeAsync(1); // resuming=true, escape timer agendado
    });

    // (2) avanzar > 5 s: el sleep(2500) dispara el 2do execute() (que queda EN VUELO, sin resolver)
    // y el timer del escape hace visible el botón. El overlay sigue en `resuming`.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6999); // total ~7 s (> 5 s escape, < 20 s timeout)
    });
    expect(screen.getByRole("button", { name: /Empezar de nuevo/ })).toBeInTheDocument();
    expect(pendingResolvers.length).toBe(2); // el 2do execute() está en vuelo

    // (3) el usuario clickea el escape MIENTRAS el 2do execute() está en vuelo.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Empezar de nuevo/ }));
    });
    // ya volvió a `send` y el overlay desapareció.
    expect(screen.getByLabelText("Monto en dólares")).toBeInTheDocument();
    expect(screen.queryByText(/Verificando tu identidad/)).toBeNull();

    // (4) AHORA resuelve el execute() que estaba en vuelo (llega tarde, tras el cancel).
    await act(async () => {
      pendingResolvers[1]!({ kind: "processing" });
      await vi.advanceTimersByTimeAsync(1);
    });
    // dar tiempo a un eventual (indebido) sleep(2500) del loop re-colgado.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    // Con el guard BLQ-MED-1: el overlay NO reaparece y seguimos en `send`.
    // Sin el guard: setResuming(true) re-cuelga "Verificando tu identidad…" encima de `send` (ROJO).
    expect(screen.queryByText(/Verificando tu identidad/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Empezar de nuevo/ })).toBeNull();
    expect(screen.getByLabelText("Monto en dólares")).toBeInTheDocument();
  });
});

// ── WKH-200 — honestidad de estado en TrackView + banner demo cubre payout-mock ─────────────
// Construye un snapshot en el estado final pedido (quote/kyc REALES "didit"), variando SOLO la
// proveniencia del payout. expiresAt futuro real → los guards de expiry (dominio) no interfieren.
function buildFlowSnapshot(
  finalStatus: "payout_submitted" | "settled" | "payout_failed" | "refunded",
  payoutProvenance: string | null,
): RemittanceState {
  const r = Remittance.create("rem-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(
    {
      quoteId: "q",
      send: Money.of(400, "USDC"),
      receive: Money.of(1478.15, "PEN"), // (400 − 0.5) × 3.7, dentro de tolerancia
      feeUsd: Money.of(0.5, "USDC"),
      rate: 3.7,
      etaMinutes: 30,
      expiresAt: "2099-01-01T00:00:00.000Z",
      provenance: "didit", // quote REAL
    },
    T0,
  );
  r.startKyc(T0, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  r.applyKyc(passKyc, T0); // kyc REAL (didit)
  r.confirm(T0);
  r.markPrincipalIn("0xp", T0);
  const prov = payoutProvenance ?? undefined;
  if (finalStatus === "payout_submitted") {
    r.markPayoutSubmitted("p1", T0, prov);
  } else if (finalStatus === "settled") {
    r.markPayoutSubmitted("p1", T0, prov);
    r.markSettled("0xs", Money.of(1478.15, "PEN"), T0);
  } else if (finalStatus === "payout_failed") {
    r.markPayoutFailed("partner_down", T0);
  } else {
    r.markPayoutFailed("partner_down", T0);
    r.markRefunded("refund-x", T0);
  }
  return r.snapshot;
}

// Navega send → connect → confirm por el atajo KYC-once (sin escaneo ni sleeps): la wallet ya está
// verificada, así el paso confirm aparece sin timers de por medio.
async function goToConfirmViaKycOnce(): Promise<void> {
  fillSend();
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));
  await screen.findByRole("button", { name: /Confirmar y enviar/ });
}

function trackContainer(
  confirmSnapshot: RemittanceState,
  trackSnapshot: RemittanceState,
  kycStore: FakeKycStore,
) {
  return buildTestContainer({
    kycStore,
    useCases: {
      confirmAndSend: {
        execute: async () => Remittance.rehydrate(confirmSnapshot),
      } as unknown as ConfirmAndSend,
      trackRemittance: {
        execute: async () => Remittance.rehydrate(trackSnapshot),
      } as unknown as TrackRemittance,
    },
  });
}

async function seededKycStore(): Promise<FakeKycStore> {
  const kycStore = new FakeKycStore();
  await kycStore.save("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", passKyc);
  return kycStore;
}

// ── T-AC1a — AC-1: payout_failed en track renderiza la vista de fallo, no la optimista ─────────
it("T-AC1a: remesa en payout_failed muestra 'No se pudo entregar', nunca 'en camino'", async () => {
  const failed = buildFlowSnapshot("payout_failed", null);
  render(<RemittanceFlow container={trackContainer(failed, failed, await seededKycStore())} />);

  await goToConfirmViaKycOnce();
  fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

  expect(await screen.findByText(/No se pudo entregar/)).toBeInTheDocument();
  expect(screen.queryByText(/Tu chaski está en camino/)).toBeNull();
});

// ── T-AC1b — AC-1: refunded en track renderiza la misma vista de fallo/reembolso ──────────────
it("T-AC1b: remesa en refunded muestra la vista de fallo/reembolso, nunca 'en camino'", async () => {
  const refunded = buildFlowSnapshot("refunded", null);
  render(<RemittanceFlow container={trackContainer(refunded, refunded, await seededKycStore())} />);

  await goToConfirmViaKycOnce();
  fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

  expect(await screen.findByText(/No se pudo entregar/)).toBeInTheDocument();
  expect(screen.queryByText(/en camino/)).toBeNull();
});

// ── T-AC3c — AC-3: payout mock (didit quote/kyc) dispara el banner en track y en el Receipt ────
it("T-AC3c (track): quote/kyc reales pero payout local-fallback → banner 'Modo demo' en track", async () => {
  const submitted = buildFlowSnapshot("payout_submitted", "local-fallback");
  render(<RemittanceFlow container={trackContainer(submitted, submitted, await seededKycStore())} />);

  await goToConfirmViaKycOnce();
  fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

  // sigue en track (payout_submitted, no settled) y el banner de demo aparece por el payout mock.
  expect(await screen.findByText(/Tu chaski está en camino/)).toBeInTheDocument();
  expect(screen.getByText(/Modo demo/)).toBeInTheDocument();
});

it("T-AC3c (receipt): payout local-fallback settled → banner 'Modo demo' en el Receipt", async () => {
  const settled = buildFlowSnapshot("settled", "local-fallback");
  render(<RemittanceFlow container={trackContainer(settled, settled, await seededKycStore())} />);

  await goToConfirmViaKycOnce();
  fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

  // settled → paso done → Receipt con el Pill de demo.
  expect(await screen.findByText(/recibió/)).toBeInTheDocument();
  expect(screen.getByText(/Modo demo/)).toBeInTheDocument();
});

// ── T-AC4 — AC-4: el banner demo cubre el paso verify ─────────────────────────────────────────
it("T-AC4: en step verify con quote demo (fallback) el banner 'Modo demo' es visible", async () => {
  render(<RemittanceFlow container={buildTestContainer({ quotes: new FallbackQuoteGateway() })} />);

  await goToReview(); // quote fallback → isDemoMode true
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ })); // review → verify

  expect(await screen.findByRole("button", { name: /Escanear DNI \+ selfie/ })).toBeInTheDocument();
  const banners = await screen.findAllByText(/Modo demo \(sin dinero real\)/, {}, { timeout: 6000 });
  expect(banners.length).toBeGreaterThanOrEqual(1);
});

// ── T-AC2 — AC-2: payout_failed corta el poll (clearInterval) aunque NO sea terminal ──────────
describe("WKH-200 poll stop (fake timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("T-AC2: al recibir payout_failed el poll frena (call-count se estabiliza), sin tocar TERMINAL_STATUSES", async () => {
    const kycStore = new FakeKycStore();
    await kycStore.save("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", passKyc);
    // onConfirm deja la remesa en payout_failed (status !== settled → step "track"): el poll ARRANCA
    // igual (el efecto solo gatea por step). trackRemittance devuelve payout_failed en cada tick.
    const failed = buildFlowSnapshot("payout_failed", null);
    const trackSpy = vi.fn(async () => Remittance.rehydrate(failed));
    const container = buildTestContainer({
      kycStore,
      useCases: {
        confirmAndSend: {
          execute: async () => Remittance.rehydrate(failed),
        } as unknown as ConfirmAndSend,
        trackRemittance: { execute: trackSpy } as unknown as TrackRemittance,
      },
    });
    render(<RemittanceFlow container={container} />);

    // navegación con flush de microtasks (sin sleeps en el atajo KYC-once).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    fillSend();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Conectar wallet/ }));
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));
      await vi.advanceTimersByTimeAsync(1);
    });

    // ancla el setInterval del poll (auto-blindaje WKH-188) y deja correr hasta que el poll frena:
    // 1er tick → payout_failed → clearInterval (con el fix). Avanzamos amplio para que estabilice.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000); // > 7 ticks de 1.5 s si NO frenara
    });
    const stabilized = trackSpy.mock.calls.length;
    expect(stabilized).toBeGreaterThanOrEqual(1); // el poll SÍ arrancó y consultó al menos una vez

    // sin el fix (payout_failed no-terminal) el poll seguiría llamando cada 1.5 s → count crecería.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000);
    });
    expect(trackSpy.mock.calls.length).toBe(stabilized);
    expect(screen.getByText(/No se pudo entregar/)).toBeInTheDocument();
  });
});

// ── T7 — HU-SOL-13 (AC-6/AC-7): acción refund en TrackView, SOLO vm=solana + refundeable + now>=deadline ──
// Se testea TrackView EN AISLAMIENTO (export): el render del flujo completo toca
// isFallbackWalletAddress (flow-vm, Scope OUT) que no canonicaliza el FALLBACK EVM en base58. deadline
// on-chain = floor(Date.parse(expiresAt)/1000); la UI compara contra Date.now() (proxy defensivo). Pasado
// ⇒ CTA visible; futuro ⇒ oculta. El guard AUTORITATIVO vive on-chain en wallet.refundEscrow.
function solanaPayoutSubmittedSnapshot(expiresAt: string): RemittanceState {
  const r = Remittance.create("rem-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(
    {
      quoteId: "q",
      send: Money.of(400, "USDC"),
      receive: Money.of(1478.15, "PEN"), // (400 − 0.5) × 3.7, dentro de tolerancia
      feeUsd: Money.of(0.5, "USDC"),
      rate: 3.7,
      etaMinutes: 30,
      expiresAt,
      provenance: "didit",
    },
    T0,
  );
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  r.applyKyc(passKyc, T0);
  r.confirm(T0);
  r.markPrincipalIn("solana-sig", T0);
  r.markPayoutSubmitted("transfi-sol-po-1", T0, "transfi");
  return r.snapshot;
}

// Harness: TrackView con el estado VIVO, como lo tiene RemittanceFlow. Sin esto no se puede probar
// lo único que importa del refund — que después de recuperar, la PANTALLA cambia.
function LiveTrackView({
  initial,
  recover,
}: {
  initial: RemittanceState;
  recover: RecoverEscrowFunds;
}) {
  const [rem, setRem] = React.useState(initial);
  return (
    <TrackView rem={rem} recover={recover} sender={FAKE_SOLANA_BENEFICIARY} onRecovered={setRem} />
  );
}

// Arma el use-case real sobre un repo real, sembrado con la remesa. El único doble es el gateway
// on-chain (no hay cadena en el test); todo lo demás corre de verdad, que es lo que hace falta para
// que el test hable de la persistencia.
async function seededRecovery(rem: RemittanceState, gateway: FakeSolanaEscrowRefundGateway) {
  const repo = new InMemoryRepo();
  await repo.save(Remittance.rehydrate(rem));
  return { repo, recover: new RecoverEscrowFunds(repo, new FixedClock(), gateway) };
}

describe("HU-SOL-13 — acción refund en TrackView (T7)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    cleanup();
  });

  it("AC-6: now>=deadline (expiresAt pasado) ⇒ 'Recuperar fondos' visible; el click dispara el refund on-chain", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway();
    const rem = solanaPayoutSubmittedSnapshot("2026-07-10T00:00:00.000Z"); // pasado vs Date.now() real
    const { recover } = await seededRecovery(rem, gateway);
    render(<LiveTrackView initial={rem} recover={recover} />);

    const btn = await screen.findByRole("button", { name: /Recuperar fondos/ });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    await waitFor(() => expect(gateway.calls).toHaveLength(1));
    expect(gateway.calls[0]).toEqual({ remittanceId: "rem-1", sender: FAKE_SOLANA_BENEFICIARY });
  });

  // El test que faltaba, y el que describe el daño real: antes la signature entraba a un useState y
  // la remesa seguía diciendo "en camino". Tras una recarga volvía a payout_submitted, la persona
  // reintentaba, el programa rechazaba el escrow ya Refunded y la app le decía que había fallado
  // algo que había funcionado.
  it("un refund exitoso ESCRIBE el estado: la pantalla deja de decir 'en camino' y el repo dice refunded", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway();
    const rem = solanaPayoutSubmittedSnapshot("2026-07-10T00:00:00.000Z");
    const { repo, recover } = await seededRecovery(rem, gateway);
    render(<LiveTrackView initial={rem} recover={recover} />);

    fireEvent.click(await screen.findByRole("button", { name: /Recuperar fondos/ }));

    // (1) la pantalla: ya no promete una entrega en curso.
    expect(await screen.findByText(/Recuperaste tus fondos/)).toBeInTheDocument();
    expect(screen.queryByText(/Tu chaski está en camino/)).toBeNull();
    expect(screen.getByText(new RegExp(FAKE_SOLANA_SIGNATURE))).toBeInTheDocument();
    // (2) y el botón desaparece: no se ofrece repetir una recuperación ya hecha.
    expect(screen.queryByRole("button", { name: /Recuperar fondos/ })).toBeNull();
    // (3) el estado PERSISTIDO, que es lo que sobrevive a la recarga.
    const saved = await repo.get("rem-1");
    expect(saved?.status).toBe("refunded");
    expect(saved?.snapshot.refundTx).toBe(FAKE_SOLANA_SIGNATURE);
  });

  it("un refund que falla NO escribe estado y la remesa queda recuperable (se puede reintentar)", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway(FAKE_SOLANA_SIGNATURE, "reject");
    const rem = solanaPayoutSubmittedSnapshot("2026-07-10T00:00:00.000Z");
    const { repo, recover } = await seededRecovery(rem, gateway);
    render(<LiveTrackView initial={rem} recover={recover} />);

    fireEvent.click(await screen.findByRole("button", { name: /Recuperar fondos/ }));

    expect(await screen.findByText(/No pudimos recuperar los fondos/)).toBeInTheDocument();
    const saved = await repo.get("rem-1");
    expect(saved?.status).toBe("payout_submitted");
    expect(saved?.snapshot.refundTx).toBeNull();
    expect(screen.getByRole("button", { name: /Recuperar fondos/ })).toBeInTheDocument();
  });

  it("AC-7: now<deadline (expiresAt futuro) ⇒ 'Recuperar fondos' OCULTA (defensa en profundidad)", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway();
    const rem = solanaPayoutSubmittedSnapshot("2099-01-01T00:00:00.000Z"); // futuro ⇒ pre-deadline
    const { recover } = await seededRecovery(rem, gateway);
    render(<LiveTrackView initial={rem} recover={recover} />);

    expect(screen.queryByRole("button", { name: /Recuperar fondos/ })).toBeNull();
    expect(gateway.calls).toHaveLength(0);
  });

  // El botón vive en las DOS ramas de TrackView, no sólo en la optimista: una remesa que ya falló
  // sigue pudiendo tener los USDC dentro del vault.
  it("en payout_failed (rama de fallo) el botón TAMBIÉN está: el escrow puede seguir con fondos", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway();
    const base = Remittance.rehydrate(solanaPayoutSubmittedSnapshot("2026-07-10T00:00:00.000Z"));
    base.markPayoutFailed("partner_down", T0);
    const rem = base.snapshot;
    const { repo, recover } = await seededRecovery(rem, gateway);
    render(<LiveTrackView initial={rem} recover={recover} />);

    fireEvent.click(await screen.findByRole("button", { name: /Recuperar fondos/ }));

    await waitFor(() => expect(gateway.calls).toHaveLength(1));
    const saved = await repo.get("rem-1");
    expect(saved?.status).toBe("refunded");
  });

  // WKH-320: acá vivía "CD-2/regresión EVM: vm=evm + now>=deadline ⇒ NINGÚN botón 'Recuperar
  // fondos'". Probaba que la acción de refund NO se montara cuando la VM activa no era Solana — un
  // estado que dejó de ser expresable. Lo que queda probado arriba es lo que sí decide hoy si el
  // botón aparece: el deadline y el estado de la remesa, no la VM.
});

// ── Honestidad del recibo y de los tildes del tracking ──────────────────────────────────────────
describe("el recibo dice lo que sabe, y no más", () => {
  afterEach(() => cleanup());

  // El bug: `Estado: Entregado` estaba HARDCODEADO. Un recibo sobre una remesa que no se entregó
  // decía "Entregado" igual. Se prueba renderizando el recibo con un estado que dice otra cosa.
  it("un recibo sobre una remesa NO entregada no dice 'Entregado'", () => {
    const rem = buildFlowSnapshot("payout_submitted", "transfi");
    render(<Receipt rem={rem} onNew={() => {}} />);

    expect(screen.queryByText("Entregado")).toBeNull();
    expect(screen.getByText(/Pago en curso/)).toBeInTheDocument();
  });

  it("con la remesa entregada, ahí sí dice 'Entregado'", () => {
    render(<Receipt rem={buildFlowSnapshot("settled", "transfi")} onNew={() => {}} />);
    expect(screen.getByText("Entregado")).toBeInTheDocument();
  });

  // El monto: sin deliveredPen, el número es el COTIZADO. Decir "recibió" sobre él es afirmar una
  // entrega que nadie confirmó.
  it("sin monto entregado confirmado NO dice 'recibió': dice que es el cotizado", () => {
    const base = Remittance.rehydrate(buildFlowSnapshot("payout_submitted", "transfi"));
    base.markSettled("payout-tx", null, T0); // settled SIN deliveredPen
    render(<Receipt rem={base.snapshot} onNew={() => {}} />);

    expect(screen.queryByText(/recibió/)).toBeNull();
    expect(screen.getByText(/tiene que recibir/)).toBeInTheDocument();
    expect(screen.getByText(/Todavía no tenemos confirmación de cuánto llegó/)).toBeInTheDocument();
  });

  it("con deliveredPen confirmado sí dice 'recibió' y no muestra la advertencia", () => {
    render(<Receipt rem={buildFlowSnapshot("settled", "transfi")} onNew={() => {}} />);
    expect(screen.getByText(/recibió/)).toBeInTheDocument();
    expect(screen.queryByText(/Todavía no tenemos confirmación/)).toBeNull();
  });

  // principalTx es el ÚNICO dato del flujo verificado contra la cadena, y no se mostraba en NINGUNA
  // pantalla (grep de principalTx en src/presentation daba cero).
  it("muestra el depósito on-chain (principalTx), que es el único dato verificado", () => {
    const rem = buildFlowSnapshot("settled", "transfi"); // principalTx = "0xp"
    render(<Receipt rem={rem} onNew={() => {}} />);
    expect(screen.getByText(/Depósito en Solana/)).toBeInTheDocument();
    expect(screen.getByText(rem.principalTx as string)).toBeInTheDocument();
  });
});

describe("los tildes del tracking no marcan como hecho lo que está en curso", () => {
  afterEach(() => cleanup());

  function toneOf(label: string): string {
    const li = screen.getByText(label).closest("li");
    return li?.querySelector("span")?.className ?? "";
  }

  // El bug: en payout_submitted el paso "pagando a tu familiar" se pintaba con el tilde verde de
  // COMPLETADO. Los USDC siguen en el vault y el release lo dispara una persona a mano.
  it("en payout_submitted el paso del pago está EN CURSO, no completado", () => {
    const rem = buildFlowSnapshot("payout_submitted", "transfi");
    render(<TrackView rem={rem} recover={undefined} sender={null} onRecovered={() => {}} />);

    expect(toneOf("Preparando el pago a tu familiar")).toContain("bg-cochineal"); // activo
    expect(toneOf("Preparando el pago a tu familiar")).not.toContain("bg-verde"); // NO completado
    // El paso anterior sí está completado: el depósito on-chain existe (principalTx).
    expect(toneOf("Fondos en camino")).toContain("bg-verde");
    // Y el último no está ni activo ni completado.
    expect(toneOf("Entregado")).toContain("bg-line");
  });

  it("en principal_in el paso de los fondos está EN CURSO, no completado", () => {
    const base = Remittance.rehydrate(buildFlowSnapshot("payout_submitted", "transfi"));
    const rem = { ...base.snapshot, status: "principal_in" as const };
    render(<TrackView rem={rem} recover={undefined} sender={null} onRecovered={() => {}} />);

    expect(toneOf("Fondos en camino")).toContain("bg-cochineal");
    expect(toneOf("Fondos en camino")).not.toContain("bg-verde");
  });

  it("en settled los tres pasos sí están completados", () => {
    const rem = buildFlowSnapshot("settled", "transfi");
    render(<TrackView rem={rem} recover={undefined} sender={null} onRecovered={() => {}} />);

    for (const l of ["Fondos en camino", "Preparando el pago a tu familiar", "Entregado"]) {
      expect(toneOf(l)).toContain("bg-verde");
    }
  });
});

// ── T8 — BLQ-MED-1 (AR/CR): RemittanceFlow COMPLETO renderiza con la wallet conectada ──
// Regresión del crash de render: el flujo evaluaba isFallbackWalletAddress(address), que
// canonicalizaba una constante EVM ("0xDEMO…") con el canonicalizador Solana → THROW EN RENDER, y
// el árbol completo de RemittanceFlow se caía. WKH-320 eliminó esa función (R-4: su catch devolvía
// false SIEMPRE en producción, o sea que el control ya no señalaba nada), así que la causa raíz
// dejó de existir. El test se conserva como REGRESIÓN: si alguien reintroduce un canonicalizador en
// el render, esto se pone rojo antes que un usuario vea una pantalla en blanco.
describe("HU-SOL-13 / WKH-320 — BLQ-MED-1: RemittanceFlow completo renderiza (T8)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    cleanup();
  });

  it("BLQ-MED-1: wallet conectada ⇒ el flujo NO crashea (el paso review se ve); banner de fallback OCULTO", async () => {
    // FakeSolanaWallet.connect() → address base58 (FAKE_SOLANA_BENEFICIARY).
    render(<RemittanceFlow container={buildTestContainer({ wallet: new FakeSolanaWallet() })} />);

    // send → connect → review: si el render crasheara, "Revisá el envío" NUNCA aparecería.
    await goToReview();
    expect(screen.getByText(/Revisá el envío/)).toBeInTheDocument();

    // El banner "Sin aislamiento por wallet" ya no existe (se fue con isFallbackWalletAddress).
    expect(screen.queryByText(/Sin aislamiento por wallet/)).toBeNull();
  });
});
