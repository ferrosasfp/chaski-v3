// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import bs58 from "bs58";
import { Receipt, RemittanceFlow, TarjetaDeCuentaDeNonce, TrackView } from "./flow";
import type {
  SolanaEscrowRefundGateway,
  SolanaEscrowRefundResult,
} from "../application/ports";
import { buildTestContainer } from "../test-support/test-container";
// WKH-339: el almacén REAL para T-339.4/.6. La forma de `ventana`/`renovar` de abajo es la MISMA que
// arma `container.ts` (un `peek` que decide, y un signer que graba en ESE almacén), así que lo que se
// mide es el mecanismo y no un doble que dice lo que se le pide.
import { InMemoryPopProofStore } from "../infrastructure/auth/pop-proof-store";
import { NONCE_ACCOUNT_RENT_LAMPORTS, formatLamportsAsSol } from "../application/solana-escrow-rent";
import { FallbackQuoteGateway } from "../infrastructure/fallback/gateways";
import type { ResumeKyc } from "../application/use-cases/resume-kyc";
import type { AbandonPendingKyc } from "../application/use-cases/abandon-pending-kyc";
import type { LockQuote } from "../application/use-cases/lock-quote";
import type { ConfirmAndSend } from "../application/use-cases/confirm-and-send";
import {
  PRINCIPAL_SETTLED_REFUND_MANUAL,
  PRINCIPAL_STATE_UNKNOWN,
  WALLET_ADDRESS_UNAVAILABLE,
} from "../application/use-cases/confirm-and-send";
import type { TrackRemittance } from "../application/use-cases/track-remittance";
import { Money } from "../domain/money";
import {
  type KycVerification,
  Remittance,
  type RemittanceState,
  toPersistedIdentity,
} from "../domain/remittance";
import {
  ESCROW_REFUNDED_BY_SENDER,
  RecoverEscrowFunds,
} from "../application/use-cases/recover-escrow-funds";
import { PREPARE_NO_AGENT_FOR_CAPABILITY, isPrepareRejection } from "../application/agent-rejections";
const KYC_PROVENANCE_LIVE = "didit"; // WKH-233: el literal se escribe ACÁ, en un test, porque el módulo que lo exportaba se borró con la HU (el juicio "esto es real" ya no lo hace Chaski). EN UNA SOLA LÍNEA: este archivo recibe citas `archivo:línea` y agregar líneas las corre.
import { ConnectWallet } from "../application/use-cases/connect-wallet";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge"; import { SolanaWalletAdapter } from "../infrastructure/solana-wallet"; import { guardarEleccion } from "../infrastructure/solana/deeplink/conexion"; import { almacenDeNavegador, guardarViaje } from "../infrastructure/solana/deeplink/sesion"; // WKH-358 agregó los tres últimos EN ESTA LÍNEA y ANTES de este comentario: `history-grupos.test.tsx:532` y `jerarquia-relativa.test.tsx:83` citan por número líneas de este archivo, así que tres líneas nuevas acá arriba las rotan a las dos. WKH-354/R-2: la costura del BANNER (el bridge global); la del guard es el `connectedWallet` inyectado
import {
  FAKE_SOLANA_BENEFICIARY,
  FAKE_SOLANA_SIGNATURE,
  FAKE_WALLET_ADDRESS, FakeConnectedWallet, FakeSolanaCloseableEscrowLister, // WKH-354
  FakeKycGateway,
  FakeKycStore,
  FakeSolanaEscrowRefundGateway,
  FakeSolanaWallet,
  FakeWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  TEST_CCI,
  beneficiary,
} from "../test-support/fakes";

// WKH-346 — la forma TRUNCADA que la pantalla muestra desde que el comprobante pasa por `TxProof`:
// primeros 8 + `…` + últimos 8, o sea 17 caracteres contra los 87 del valor entero. Va escrita A MANO
// y NO llamando a `shortTx`: un assert que la recalculara con la misma función que se está probando se
// movería junto con el mutante (subir el umbral `tx.length <= 16`) y pasaría siempre.
const SIGNATURE_CORTA = "99eUso3a…FzQyEQf8";

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
  payoutAllowed: true, realVerified: true, verifiedAt: null,
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
// ⚠️ ESTE DOBLE ES UNA LISTA CERRADA, y por eso hay que tocarlo cada vez que `flow.tsx` empieza a
// usar un export nuevo de framer-motion. No es un `importOriginal` parcial: lo que no esté acá
// NO EXISTE para este archivo, y el síntoma no es un test suelto en rojo sino la suite entera del
// archivo caída con «No "X" export is defined on the "framer-motion" mock». Medido al agregar
// `MotionConfig` en `flow.tsx` (D-2 · ola 1 de rediseño): 52 tests de ESTE archivo en rojo de golpe,
// y lo mismo en `honest-copy`, `solo-cci`, `wallet-availability` y `agent-plan-card`, que copian
// este mismo doble. Son cinco copias del mismo listado y ninguna se entera sola.
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  // Pasa de largo: el punto del doble es pintar DOM plano, y la config de framer no pinta nada.
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

afterEach(() => cleanup());

// ── Helpers de navegación (WKH-187: send → connect → review(pre-KYC) → verify → confirm) ──────
/**
 * WKH-063 · CÓMO SE LLEGA HOY AL HISTORIAL, y por qué son dos toques y no uno.
 *
 * Antes era un enlace al pie del formulario ("Ver mis envíos"). Hoy es la pestaña "Mis envíos" de la
 * barra de destinos, y la barra NO se pinta en los pasos del flujo (AC-3), así que desde `send` el
 * recorrido es: salir del flujo y tocar la pestaña. Es EXACTAMENTE lo que hace una persona, y por eso
 * el helper navega de verdad en vez de saltar con `pasoInicial`.
 *
 * Sincrónico porque este archivo mockea `framer-motion` (ver el `vi.mock` de arriba): sin ese doble,
 * el cambio de pantalla no completa en el mismo tick y estos dos clicks necesitarían `findBy`.
 */
// WKH-063 fix-pack (AR/BLQ-BAJO-1): la ruta hasta "Mis envíos" depende de DÓNDE estás, y desde este
// fix-pack hay dos puntos de partida posibles en el mismo test. Desde el FORMULARIO hay que salir primero
// con "Volver al inicio" (los pasos del flujo no pintan la barra, AC-3); desde un DESTINO la barra ya
// está y ese botón no existe. El `query*` es lo que hace al helper servir en los dos casos, y no es
// tolerancia floja: la segunda mitad —tocar la pestaña— es obligatoria y usa `getBy*`, así que si la
// barra no estuviera, el helper falla ruidosamente igual.
function irAMisEnvios(): void {
  const salir = screen.queryByRole("button", { name: /Volver al inicio/ });
  if (salir !== null) fireEvent.click(salir);
  fireEvent.click(screen.getByRole("button", { name: /Mis envíos/ }));
}

/** Entrar (o volver a entrar) al formulario desde la pantalla de entrada. */
function irAlFormulario(): void {
  fireEvent.click(screen.getByRole("button", { name: /Empezar un envío/ }));
}

function fillSend(recipient = "Mamá", destination = TEST_CCI): void {
  fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), {
    target: { value: recipient },
  });
  fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), {
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
  fireEvent.click(await screen.findByRole("button", { name: /Verificar mi identidad/ }));
  await screen.findByRole("button", { name: /Confirmar y enviar/ }); // paso confirm
}

// ── T1 — AC-4 (harness smoke) + banner "Modo demo" (WKH-178) ─────────────────
// FallbackQuoteGateway → provenance "local-fallback" → dispara isDemoMode.
it("T1: modo demo muestra el monto del quote (no S/0.00) y el banner 'Modo demo' una sola vez", async () => {
  render(<RemittanceFlow pasoInicial="send" container={buildTestContainer({ quotes: new FallbackQuoteGateway() })} />);

  await goToReview();

  // (b) el sello del modo demo presente, una sola vez.
  const banners = await screen.findAllByText(
    /Modo demo \(con pasos simulados\)/,
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
  render(<RemittanceFlow pasoInicial="send" container={buildTestContainer()} />);

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
  render(<RemittanceFlow pasoInicial="send" container={buildTestContainer()} />);

  const amountInput = await screen.findByLabelText("Monto en dólares");
  fireEvent.change(amountInput, { target: { value: "5" } });
  fillSend();

  expect(screen.getByRole("button", { name: /Continuar/ })).toBeEnabled();
  expect(screen.queryByRole("alert")).toBeNull();
});

// ── T-UI-2 — 🔴 REESCRITO POR WKH-233: la tarjeta YA NO MUESTRA DATOS DE IDENTIDAD ───────────────
// ⚠️ MEDÍA "nombre completo + documento enmascarado en pantalla", y eso dejó de existir: el agente NO
// devuelve ningún dato de identidad. 🔴 Y MIDE LAS **DOS** RAMAS, medido con un mutante: la versión
// anterior sólo miraba la rama "sin verificar", y con eso un `${id.firstName}` repuesto en la rama
// VERDE **SOBREVIVÍA**. El fixture positivo tiene que ejercitar el agujero, no esquivarlo.
it.each([
  ["sin verificar", { identity: null }, /Identidad sin verificar/],
  ["verificada", { identity: null, realVerified: true, verifiedAt: "2026-08-19T10:00:00.000Z" }, /Identidad verificada/],
])("T-UI-2: en la rama «%s» la tarjeta NO muestra nombre ni documento (WKH-233/D-2)", async (_c, over, marca) => {
  const cont = buildTestContainer({ kyc: new FakeKycGateway(over) });
  const { container } = render(<RemittanceFlow pasoInicial="send" container={cont} />);
  await goToConfirm();
  expect(await screen.findByText(marca)).toBeInTheDocument(); // ✅ calibración: la tarjeta SÍ está
  for (const d of ["Test Quispe Mamani", "DNI", "••••5678", "12345678"]) expect(container.textContent, `la tarjeta mostró «${d}»`).not.toContain(d);
});

// ── T4 — AC-7: control reset visible solo con address (WKH-184) ──────────────
it("T4: '¿No sos vos?' aparece solo con una address conectada", async () => {
  render(<RemittanceFlow pasoInicial="send" container={buildTestContainer()} />);

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
// El CTA se llama "Borrar igual" y no "Empezar de nuevo": el overlay de resume tiene un botón con
// ESE nombre que no borra nada, y dos botones con la misma etiqueta donde uno destruye datos y el
// otro no es un accidente esperando. Lo que el test verifica no cambió.
it("T5: 'Borrar igual' limpia address + PII del beneficiario y vuelve a la pantalla de entrada", async () => {
  render(<RemittanceFlow pasoInicial="send" container={buildTestContainer()} />);

  fillSend("Mamá", TEST_CCI);
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));

  // Con address conectada → abrir la confirmación y ejecutar forgetAndDisconnect.
  fireEvent.click(await screen.findByText("¿No sos vos?"));
  fireEvent.click(await screen.findByText("Borrar igual"));

  // (a) WKH-063 fix-pack (AR/BLQ-BAJO-1): vuelve a la PANTALLA DE ENTRADA, no al medio del formulario.
  // Antes este assert buscaba el input de monto directo, porque `forgetAndDisconnect` hacía
  // `setStep("send")` — y hasta WKH-063 `send` ERA el inicio. Hoy `send` es el paso 1 de 4 de un envío, y
  // aterrizar ahí después de decir "no soy yo" contradice el gesto. Los dos asserts van juntos: que la
  // pantalla de entrada esté Y que el formulario NO, porque "agregar la pantalla nueva" y "pintar las dos"
  // darían lo mismo con uno solo.
  expect(await screen.findByRole("heading", { name: "Tu plata no pasa por Chaski" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Monto en dólares")).toBeNull();
  // Y los campos siguen limpios cuando se vuelve a entrar, que es lo que el resto del test mide.
  irAlFormulario();
  const amountInput = (await screen.findByLabelText("Monto en dólares")) as HTMLInputElement;
  expect(amountInput).toBeInTheDocument();

  // (b) badge de address desaparece (address === null).
  await waitFor(() => expect(screen.queryByText(/4zMMC9/)).toBeNull());

  // (c) recipient limpio · (d) destino limpio · (e) monto vuelve al default "400".
  const recipientInput = screen.getByPlaceholderText("Nombre de tu familiar") as HTMLInputElement;
  const destinationInput = screen.getByPlaceholderText("002 193 004455667788 99") as HTMLInputElement;
  expect(recipientInput.value).toBe("");
  expect(destinationInput.value).toBe("");
  expect(amountInput.value).toBe("400");
});

// ── T-AC1 / T-REORDER (RTL) — AC-1: el quote es visible ANTES del KYC ─────────
it("T-AC1/T-REORDER: tras conectar, el paso review muestra el quote (S/ concreto) ANTES de cualquier UI de KYC", async () => {
  render(<RemittanceFlow pasoInicial="send" container={buildTestContainer()} />);

  await goToReview(); // send → connect → review (SIN pasar por verify)

  // (a) el monto que recibe la familia está visible en el review pre-KYC.
  const receive = screen.getByText(/^S\/[\d,]+\.\d{2}$/);
  expect(receive).toBeInTheDocument();
  expect(receive.textContent).not.toBe("S/0.00");
  // (b) todavía NO hay UI de KYC (ni escaneo ni badge de identidad).
  expect(screen.queryByRole("button", { name: /Verificar mi identidad/ })).toBeNull();
  expect(screen.queryByText(/Identidad verificada/)).toBeNull();
});

// ── T-AC2 — AC-2: "Continuar" del review NO auto-inicia el KYC ────────────────
it("T-AC2: el review tiene 'Continuar'; el escaneo aparece recién tras el tap (KYC no auto-inicia)", async () => {
  render(<RemittanceFlow pasoInicial="send" container={buildTestContainer()} />);

  await goToReview();

  // (a) el review pre-KYC no muestra el escaneo.
  expect(screen.queryByRole("button", { name: /Verificar mi identidad/ })).toBeNull();
  // (b) tras tapear "Continuar" recién aparece el escaneo (paso verify).
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  expect(await screen.findByRole("button", { name: /Verificar mi identidad/ })).toBeInTheDocument();
});

// ── T-AC4 — AC-4: KYC-once salta review+verify y va directo a confirm ─────────
it("T-AC4: KYC-once → tras conectar va directo a confirm (sin review ni escaneo), con quote lockeado", async () => {
  const kycStore = new FakeKycStore();
  await kycStore.save("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", passKyc); // wallet ya verificada
  render(<RemittanceFlow pasoInicial="send" container={buildTestContainer({ kycStore })} />);

  fillSend();
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));

  // (a) aterriza en confirm: botón "Confirmar y enviar" + identidad + quote.
  expect(await screen.findByRole("button", { name: /Confirmar y enviar/ })).toBeInTheDocument();
  expect(screen.getByText(/Identidad verificada/)).toBeInTheDocument();
  expect(screen.getByText(/^S\/[\d,]+\.\d{2}$/)).toBeInTheDocument();
  // (b) nunca pasó por el escaneo de DNI.
  expect(screen.queryByRole("button", { name: /Verificar mi identidad/ })).toBeNull();
});

// ── T-AC4b — WKH-333 / AR/BLQ-MED-1: el atajo KYC-once NO se toma si el servidor dijo que no hay fila
//
// 🔴 QUÉ PASABA SIN ESTE GUARD, y por qué el daño es de dinero aunque el guard sea de pantalla. El
// atajo manda de `connect` a `confirm` salteando la verificación. Para alguien verificado en ESTE
// navegador pero SIN fila server-side (`absent`), eso significa llegar a pagar y comerse el corte de
// AC-17 sin que la pantalla que lo arreglaría se le muestre nunca. El guard de verdad está en
// `StartKyc` (T-SK-6); ÉSTE evita además gastar un cupo del proveedor: si acá se llamara a `startKyc`,
// devolvería `redirect` y `onConnect` DESCARTA esa URL, así que la sesión creada no la usa nadie y la
// pantalla de verificación crearía una segunda.
it("T-AC4b: local verificado + el servidor dice `absent` ⇒ va a review, y NO se crea sesión de Didit", async () => {
  const kycStore = new FakeKycStore();
  await kycStore.save("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", passKyc);
  const wallet = new FakeWallet();
  const kyc = new FakeKycGateway({}, true); // redirect=true ⇒ crear sesión sería observable
  const startSpy = vi.spyOn(kyc, "start");
  // Gateway del veredicto que CONTESTA: no hay fila utilizable para esta billetera.
  const verdictGw = {
    async ensure() {
      return { lookup: { outcome: "absent", reason: "absent" } } as const;
    },
  };
  const container = buildTestContainer({
    kycStore,
    wallet,
    kyc,
    useCases: { connectWallet: new ConnectWallet(wallet, kycStore, verdictGw) },
  });
  render(<RemittanceFlow pasoInicial="send" container={container} />);

  fillSend();
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));

  // Aterriza en review (la CTA "Continuar" del paso review), NO en confirm.
  expect(
    await screen.findByRole("button", { name: /Continuar/ }),
    "el atajo KYC-once se tomó igual con el servidor diciendo que no hay fila: la persona llega a " +
      "pagar sin fila, se corta con AC-17, y la pantalla de verificación no se le muestra nunca",
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Confirmar y enviar/ })).toBeNull();
  expect(
    startSpy,
    "se creó una sesión de verificación en el connect: `onConnect` descarta la URL del redirect, así " +
      "que ese cupo del proveedor se gasta y no lo usa nadie",
  ).not.toHaveBeenCalled();
});

// El badge VERDE afirma una verificación, así que sólo sale cuando el AGENTE la declaró real
// (`realVerified: true`). El default de `FakeKycGateway` no lo declara y por eso cae en la tarjeta de
// "sin verificar": estos dos tests hablan del camino verificado, así que lo declaran. ⚠️ WKH-233: lo
// que gatea el badge dejó de ser la PROVENIENCIA y pasó a ser el juicio del agente.
const kycRealGateway = () => new FakeKycGateway({ provenance: KYC_PROVENANCE_LIVE, realVerified: true, verifiedAt: "2026-08-19T10:00:00.000Z", identity: null }); // 🔴 `identity: null` NO es decorativo: es lo que el agente devuelve SIEMPRE, y sin él T-UI-1 no ejercita el `if (!id) return null` que mide (MEDIDO: con identidad, ese mutante SOBREVIVÍA)

// ── T-UI-1 — DT-13(b): con `identity: null` la tarjeta RENDERIZA igual ────────
it("T-UI-1: el paso confirm muestra la tarjeta de identidad VERIFICADA aunque `identity` sea null", async () => {
  render(<RemittanceFlow pasoInicial="send" container={buildTestContainer({ kyc: kycRealGateway() })} />);
  // ⚠️ Δ0 EN LÍNEAS: este archivo recibe ~138 citas `flow.test.tsx:NN`; agregar o quitar una las corre.
  await goToConfirm();
  // 🧬 MUTANTE: reponer el `if (!id) return null` ⇒ la tarjeta DESAPARECE ⇒ ROJO. Ése es el modo de
  // falla que D-2 nombró: sin este test, la tarjeta se habría borrado sin que nadie lo notara.
  expect(screen.getByText(/Identidad verificada/)).toBeInTheDocument();
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
  render(
    <RemittanceFlow pasoInicial="send"
      container={buildTestContainer({ kyc: kycRealGateway(), useCases: { confirmAndSend: rejecting } })}
    />,
  );

  await goToConfirm();
  fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

  // (a) el error dispara el botón de recotización (MNR-1).
  const relock = await screen.findByRole("button", { name: /Recotizar tasa/ });
  fireEvent.click(relock);

  // (b) tras re-cotizar seguimos en confirm (vuelve el CTA de enviar), NUNCA al escaneo de DNI.
  expect(await screen.findByRole("button", { name: /Confirmar y enviar/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Verificar mi identidad/ })).toBeNull();
  expect(screen.getByText(/Identidad verificada/)).toBeInTheDocument(); // el KYC se conservó
});

// ── T-CODE — el error que se ve en pantalla deja rastro de QUÉ falló ──────────
// Motivo: un reporte desde un celular llegó como "Algo salió mal. Intentá de nuevo." y el código
// que lo originó no quedaba en ningún lado, ni en pantalla ni en consola. El fallo era real y la
// superficie no decía nada. Estos dos tests fijan que el código viaje SIEMPRE, y el segundo es el
// que importa: justamente cuando no sabemos traducirlo es cuando más falta hace verlo.
function rejectingWith(code: string) {
  return { execute: async () => { throw new Error(code); } } as unknown as ConfirmAndSend;
}

it("T-CODE-1: un código conocido muestra su copy propio Y el código", async () => {
  render(
    <RemittanceFlow pasoInicial="send"
      container={buildTestContainer({ useCases: { confirmAndSend: rejectingWith("wallet_connect_cancelled") } })}
    />,
  );
  await goToConfirm();
  fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

  expect(await screen.findByText(/selector de wallet/)).toBeInTheDocument();
  expect(screen.getByText("wallet_connect_cancelled")).toBeInTheDocument();
});

it("T-CODE-2: un código DESCONOCIDO cae al genérico pero el código sigue a la vista", async () => {
  render(
    <RemittanceFlow pasoInicial="send"
      container={buildTestContainer({ useCases: { confirmAndSend: rejectingWith("chirimoya_invertida") } })}
    />,
  );
  await goToConfirm();
  fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

  expect(await screen.findByText("Algo salió mal. Intentá de nuevo.")).toBeInTheDocument();
  // ⬅️ Esto es lo que faltaba: sin el código, el reporte de campo no era diagnosticable.
  expect(screen.getByText("chirimoya_invertida")).toBeInTheDocument();
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
  render(<RemittanceFlow pasoInicial="send" container={container} />);

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
  render(<RemittanceFlow pasoInicial="send" container={container} />);

  // (a) aterriza en confirm con el indicador de tasa actualizada.
  expect(await screen.findByText(/La tasa se actualizó/)).toBeInTheDocument();
  // (b) muestra el monto NUEVO (S/1,500.00), no el viejo.
  expect(screen.getByText("S/1,500.00")).toBeInTheDocument();
  // (c) sin re-escaneo de DNI: el KYC se conservó.
  expect(screen.queryByRole("button", { name: /Verificar mi identidad/ })).toBeNull();
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
    render(<RemittanceFlow pasoInicial="send" container={container} />);

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
    render(<RemittanceFlow pasoInicial="send" container={container} />);

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
    render(<RemittanceFlow pasoInicial="send" container={container} />);

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
    render(<RemittanceFlow pasoInicial="send" container={container} />);

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
    render(<RemittanceFlow pasoInicial="send" container={container} />);

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
    // La rama `failed` aterriza en `verify` con el snapshot y el banner; cualquier snapshot válido sirve.
    // ⚠️ DESDE WKH-063/fix-pack 3 ESA RAMA PASA POR UN GATE (`aterrizar`, `./flow.tsx:208`) y ya no son
    // tres sentencias sueltas: acá el gate NO frena porque este test no interactúa con nada, y por eso
    // este `it` es —medido con el mutante G2— el único de este archivo que vigila el aterrizaje del
    // `failed` sin interacción previa.
    const failedSnapshot = Remittance.create("rem-1", beneficiary(), Money.of(400, "USDC"), T0).snapshot;
    const container = buildTestContainer({
      useCases: {
        resumeKyc: {
          execute: async () => ({ kind: "failed" as const, snapshot: failedSnapshot }),
        } as unknown as ResumeKyc,
      },
    });
    render(<RemittanceFlow pasoInicial="send" container={container} />);

    // El primer poll es terminal (sin sleep) → aterriza en `verify`. Flush sin disparar el escape (5 s).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("button", { name: /Verificar mi identidad/ })).toBeInTheDocument();
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
    render(<RemittanceFlow pasoInicial="send" container={container} />);

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
        execute: async () => ({ estado: "listo" as const, remesa: Remittance.rehydrate(confirmSnapshot) }), // WKH-356: shape nuevo. El `as unknown as` de abajo saca este doble del alcance de `tsc`, así que con el shape viejo la compilación seguía dando 0 y el fallo aparecía recién en runtime, cuando `flow.tsx` lee `res.estado` sobre un `Remittance` y cae al camino equivocado.
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
  render(<RemittanceFlow pasoInicial="send" container={trackContainer(failed, failed, await seededKycStore())} />);

  await goToConfirmViaKycOnce();
  fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

  expect(await screen.findByText(/No se pudo entregar/)).toBeInTheDocument();
  expect(screen.queryByText(/Tu chaski está en camino/)).toBeNull();
});

// ── T-AC1b — AC-1: refunded en track renderiza la misma vista de fallo/reembolso ──────────────
it("T-AC1b: remesa en refunded muestra la vista de fallo/reembolso, nunca 'en camino'", async () => {
  const refunded = buildFlowSnapshot("refunded", null);
  render(<RemittanceFlow pasoInicial="send" container={trackContainer(refunded, refunded, await seededKycStore())} />);

  await goToConfirmViaKycOnce();
  fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

  expect(await screen.findByText(/No se pudo entregar/)).toBeInTheDocument();
  expect(screen.queryByText(/en camino/)).toBeNull();
});

// ── T-AC3c — AC-3: payout mock (didit quote/kyc) dispara el banner en track y en el Receipt ────
it("T-AC3c (track): quote/kyc reales pero payout local-fallback → banner 'Modo demo' en track", async () => {
  const submitted = buildFlowSnapshot("payout_submitted", "local-fallback");
  render(<RemittanceFlow pasoInicial="send" container={trackContainer(submitted, submitted, await seededKycStore())} />);

  await goToConfirmViaKycOnce();
  fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

  // sigue en track (payout_submitted, no settled) y el banner de demo aparece por el payout mock.
  // El encabezado ya no dice "en camino" acá: en payout_submitted no se mueve nada solo.
  expect(await screen.findByText(/Tu envío está esperando/)).toBeInTheDocument();
  expect(screen.getByText(/Modo demo/)).toBeInTheDocument();
});

it("T-AC3c (receipt): payout local-fallback settled → banner 'Modo demo' en el Receipt", async () => {
  const settled = buildFlowSnapshot("settled", "local-fallback");
  render(<RemittanceFlow pasoInicial="send" container={trackContainer(settled, settled, await seededKycStore())} />);

  await goToConfirmViaKycOnce();
  fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

  // settled → paso done → Receipt con el Pill de demo.
  expect(await screen.findByText(/recibió/)).toBeInTheDocument();
  expect(screen.getByText(/Modo demo/)).toBeInTheDocument();
});

// ── T-AC4 — AC-4: el banner demo cubre el paso verify ─────────────────────────────────────────
it("T-AC4: en step verify con quote demo (fallback) el banner 'Modo demo' es visible", async () => {
  render(<RemittanceFlow pasoInicial="send" container={buildTestContainer({ quotes: new FallbackQuoteGateway() })} />);

  await goToReview(); // quote fallback → isDemoMode true
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ })); // review → verify

  expect(await screen.findByRole("button", { name: /Verificar mi identidad/ })).toBeInTheDocument();
  const banners = await screen.findAllByText(
    /Modo demo \(con pasos simulados\)/,
    {},
    { timeout: 6000 },
  );
  expect(banners.length).toBeGreaterThanOrEqual(1);
});

// ── T-AC2 — AC-2: payout_failed corta el poll (clearInterval) aunque NO sea terminal ──────────
describe("WKH-200 poll stop (fake timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  /** Navega hasta `track` con la remesa que devuelva `final`, espiando el poll. */
  async function trackWith(final: RemittanceState) {
    const kycStore = new FakeKycStore();
    await kycStore.save("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", passKyc);
    // El poll devuelve SIEMPRE el estado persistido (que en el caso del refund quedó viejo).
    const trackSpy = vi.fn(async () => Remittance.rehydrate(final));
    const container = buildTestContainer({
      kycStore,
      useCases: {
        confirmAndSend: {
          execute: async () => ({ estado: "listo" as const, remesa: Remittance.rehydrate(final) }), // WKH-356: shape nuevo. `tsc` NO lo mira (el cast lo saca de su alcance); esto sólo se cae en runtime.
        } as unknown as ConfirmAndSend,
        trackRemittance: { execute: trackSpy } as unknown as TrackRemittance,
      },
    });
    render(<RemittanceFlow pasoInicial="send" container={container} />);

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
    return trackSpy;
  }

  it("T-AC2: sobre payout_failed el poll no queda corriendo (call-count estable), sin tocar TERMINAL_STATUSES", async () => {
    // Antes el poll arrancaba igual y frenaba en el 1er tick. Ahora ni arranca: desde payout_failed la
    // FSM sólo va a `refunded`, y a eso no se llega poleando. Menos llamadas, misma garantía.
    const trackSpy = await trackWith(buildFlowSnapshot("payout_failed", null));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000); // > 7 ticks de 1.5 s si NO frenara
    });
    const stabilized = trackSpy.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000);
    });
    expect(trackSpy.mock.calls.length).toBe(stabilized);
    expect(screen.getByText(/No se pudo entregar/)).toBeInTheDocument();
  });

  // El poll DESMENTÍA a la pantalla. El effect depende de `remStatus`, así que al pasar a `refunded`
  // arrancaba un intervalo NUEVO y 1,5 s después leía el estado PERSISTIDO (viejo si el save falló) y
  // hacía setRem: la persona veía "Recuperaste tus fondos" un segundo y medio y la pantalla volvía
  // sola a "Preparando el pago", con el botón otra vez, que al apretarlo el programa rechazaba.
  it("sobre una remesa ya recuperada el poll NO corre ni pisa la pantalla con el estado viejo", async () => {
    const recovered = Remittance.rehydrate(buildFlowSnapshot("payout_failed", null));
    recovered.markRefunded("refund-sig", T0);
    const stale = buildFlowSnapshot("payout_submitted", "transfi"); // lo que devolvería el repo viejo
    const trackSpy = await trackWith({
      ...recovered.snapshot,
      failureReason: ESCROW_REFUNDED_BY_SENDER,
    });
    // El poll, si corriera, devolvería el estado viejo: se lo cargamos explícitamente.
    trackSpy.mockImplementation(async () => Remittance.rehydrate(stale));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000); // 8 ticks de sobra
    });

    expect(trackSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/Recuperaste tus fondos/)).toBeInTheDocument();
    expect(screen.queryByText(/Preparando el pago a tu familiar/)).toBeNull();
  });
});

// ── T7 — HU-SOL-13 (AC-6/AC-7): acción refund en TrackView, SOLO vm=solana + refundeable + now>=deadline ──
// Se testea TrackView EN AISLAMIENTO (export): el render del flujo completo toca
// isFallbackWalletAddress (flow-vm, Scope OUT) que no canonicaliza el FALLBACK EVM en base58. deadline
// on-chain = floor(Date.parse(expiresAt)/1000); la UI compara contra Date.now() (proxy defensivo). Pasado
// ⇒ CTA visible; futuro ⇒ oculta. El guard AUTORITATIVO vive on-chain en wallet.refundEscrow.

/** Confirmada y NADA MÁS: `principalTx` sigue en null, o sea que la billetera todavía no firmó
 *  ningún depósito. Es el punto exacto en el que corta el `prepare`
 *  (`failAndRefund`, `../application/use-cases/confirm-and-send.ts:481`, con `"not_deposited"`), o sea que es la única
 *  forma que tiene una remesa cuyo `failureReason` es un fallo ANTERIOR a la primera firma. */
function solanaConfirmedSnapshot(expiresAt: string): RemittanceState {
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
  return r.snapshot;
}

function solanaPayoutSubmittedSnapshot(expiresAt: string): RemittanceState {
  const r = Remittance.rehydrate(solanaConfirmedSnapshot(expiresAt));
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
async function seededRecovery(rem: RemittanceState, gateway: SolanaEscrowRefundGateway) {
  const repo = new InMemoryRepo();
  await repo.save(Remittance.rehydrate(rem));
  return { repo, recover: new RecoverEscrowFunds(repo, new FixedClock(), gateway) };
}

// La SEGUNDA firma, para los casos de dos devoluciones seguidas. Se construye igual que
// `FAKE_SOLANA_SIGNATURE` (`fakes.ts:835`) con otro relleno, así que es base58 válido y DISTINTO; la
// forma corta va A MANO por el mismo motivo que `SIGNATURE_CORTA` de arriba: recalcularla con
// `shortTx` la movería junto con el mutante.
const SEGUNDA_FIRMA = bs58.encode(new Uint8Array(64).fill(9));
const SEGUNDA_CORTA = "BUguQsv2…m8XpSXRA";

/**
 * Un gateway que resuelve DISTINTO en llamadas sucesivas, que es lo único con lo que se puede
 * ejercitar la acumulación de comprobantes. `FakeSolanaEscrowRefundGateway` devuelve SIEMPRE la misma
 * firma, así que con él las dos órdenes serían la misma y el `some` del componente las colapsaría en
 * una: el test daría verde con el bug puesto.
 *
 * 🔴 VIVE ACÁ Y NO EN `test-support/fakes.ts` A PROPÓSITO, por la misma razón que su gemelo de
 * `lost-escrow-recovery.test.tsx`: ese módulo lo importan decenas de suites y agregarle un modo tiene
 * el radio de explosión más grande del repo para cero beneficio.
 *
 * ⚠️ Y LO QUE ESTE DOBLE NO PRUEBA: que dos devoluciones REALES en cadena acumulen. Es memoria, en
 * jsdom.
 */
class GatewayEnSecuencia implements SolanaEscrowRefundGateway {
  public calls: Array<{ remittanceId?: string; sender: string }> = [];
  constructor(private readonly guion: ReadonlyArray<SolanaEscrowRefundResult | string>) {}
  async refund(input: { remittanceId?: string; sender: string }): Promise<SolanaEscrowRefundResult> {
    this.calls.push(input);
    // El último desenlace se repite si alguien aprieta una vez más: un `undefined` acá sería un
    // TypeError que se lee como "la UI falló" cuando lo que faltó fue guion.
    const paso = this.guion[Math.min(this.calls.length - 1, this.guion.length - 1)];
    if (paso === undefined) throw new Error("guion_vacio");
    if (typeof paso === "string") throw new Error(paso);
    return paso;
  }
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
    // WKH-346: este assert pedía la firma ENTERA como texto y se puso rojo POR DISEÑO al truncarla —
    // es la señal de que la HU funcionó, no una regresión. Lo que se verifica ahora es que la pantalla
    // muestra la forma corta y que los 87 caracteres siguen vivos en el `href` del visor.
    const enlace = screen.getByRole("link", { name: SIGNATURE_CORTA });
    expect(enlace.getAttribute("href")).toContain(FAKE_SOLANA_SIGNATURE);
    expect(screen.queryByText(new RegExp(FAKE_SOLANA_SIGNATURE))).toBeNull();
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

  // AC-7 sigue intacto y NO se prueba acá: el guard real (pre-deadline ⇒ abortar antes de firmar y
  // sin broadcastear) vive en el adapter, `solana-wallet.refund.test.ts`, contra un escrow leído de
  // la cadena. `FakeSolanaEscrowRefundGateway` no modela el deadline: siempre resuelve. O sea que
  // este test NUNCA probó el guard, probó el proxy que la UI hacía por su cuenta.
  //
  // Ese proxy salía de `quote.expiresAt` y era correcto mientras el deadline del escrow FUERA ese
  // instante. El 2026-08-01 dejó de serlo (deadline = depósito + 2 h, cotización = 10 min), así que
  // la pantalla habilitaba el botón temprano y, peor, escribía la hora equivocada como un instante
  // concreto. Lo que este test sostiene ahora es lo único que esta capa puede sostener con verdad:
  // ofrece la salida y NO inventa una hora.
  it("con el plazo sin vencer, la pantalla ofrece la salida y NO promete una hora concreta", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway();
    const expiresAt = "2099-01-01T00:00:00.000Z"; // cotización con vencimiento futuro
    const rem = solanaPayoutSubmittedSnapshot(expiresAt);
    const { recover } = await seededRecovery(rem, gateway);
    render(<LiveTrackView initial={rem} recover={recover} />);

    expect(screen.getByRole("button", { name: /Recuperar fondos/ })).toBeEnabled();
    expect(screen.getByText(/El plazo se fija cuando depositás/)).toBeInTheDocument();

    // LA REGRESIÓN QUE ESTE TEST EXISTE PARA CAZAR. No alcanza con mirar el copy viejo: se asertea
    // que el instante de la COTIZACIÓN no aparezca renderizado en ninguna forma, porque volver a
    // derivar de ahí es exactamente el bug, se escriba con las palabras que se escriba.
    const horaDeLaCotizacion = new Date(expiresAt).toLocaleTimeString("es-PE", {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(screen.queryByText(new RegExp(horaDeLaCotizacion))).not.toBeInTheDocument();
    expect(screen.queryByText(/a partir de las/)).not.toBeInTheDocument();
  });

  // ── El refund que la cadena todavía no confirmó ────────────────────────────────────────────────
  // El caso: la persona firma en Phantom y tarda 40 s, el blockhash vence y la tx se cae. Antes la
  // pantalla decía "Recuperaste tus fondos. Los USDC volvieron a tu wallet" con la plata en el vault,
  // y el botón no volvía NUNCA (refunded es terminal). El verbo tiene que ser el de lo que sabemos.
  it("confirmation=pending ⇒ dice 'Enviamos la orden', NUNCA 'volvieron', y el botón sigue disponible", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway(FAKE_SOLANA_SIGNATURE, "resolve", "pending");
    const rem = solanaPayoutSubmittedSnapshot("2026-07-10T00:00:00.000Z");
    const { repo, recover } = await seededRecovery(rem, gateway);
    render(<LiveTrackView initial={rem} recover={recover} />);

    fireEvent.click(await screen.findByRole("button", { name: /Recuperar fondos/ }));

    expect(await screen.findByText(/Enviamos la orden de recuperación/)).toBeInTheDocument();
    expect(screen.queryByText(/Recuperaste tus fondos/)).toBeNull();
    expect(screen.queryByText(/volvieron a tu wallet/)).toBeNull();
    expect(screen.getByText(/Todavía no la vemos confirmada en la cadena/)).toBeInTheDocument();
    // WKH-346: rojo POR DISEÑO al truncar (ver el mismo cambio en el `it` de arriba). La orden que la
    // cadena todavía no confirmó es justo el caso en que la persona necesita abrir el visor, así que
    // acá el `href` no es un detalle: es la única vía para ir a mirar si entró.
    const enlacePending = screen.getByRole("link", { name: SIGNATURE_CORTA });
    expect(enlacePending.getAttribute("href")).toContain(FAKE_SOLANA_SIGNATURE);
    expect(screen.queryByText(new RegExp(FAKE_SOLANA_SIGNATURE))).toBeNull();
    // El reintento sigue existiendo: es lo único que salva a la persona si la tx se cayó.
    expect(screen.getByRole("button", { name: /Volver a intentar/ })).toBeEnabled();
    // Y nada terminal quedó escrito.
    expect((await repo.get("rem-1"))?.status).toBe("payout_submitted");
  });

  it("confirmation=unknown ⇒ dice que no pudimos preguntar, sin declarar éxito ni fracaso", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway(FAKE_SOLANA_SIGNATURE, "resolve", "unknown");
    const rem = solanaPayoutSubmittedSnapshot("2026-07-10T00:00:00.000Z");
    const { repo, recover } = await seededRecovery(rem, gateway);
    render(<LiveTrackView initial={rem} recover={recover} />);

    fireEvent.click(await screen.findByRole("button", { name: /Recuperar fondos/ }));

    expect(await screen.findByText(/Enviamos la orden de recuperación/)).toBeInTheDocument();
    expect(screen.getByText(/No pudimos consultar la cadena/)).toBeInTheDocument();
    expect(screen.queryByText(/Recuperaste tus fondos/)).toBeNull();
    expect(screen.queryByText(/No pudimos recuperar los fondos/)).toBeNull(); // tampoco un fracaso
    expect(screen.getByRole("button", { name: /Volver a intentar/ })).toBeEnabled();
    expect((await repo.get("rem-1"))?.status).toBe("payout_submitted");
  });

  it("el segundo intento SÍ llega a la cadena (el camino de reintento no se cerró)", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway(FAKE_SOLANA_SIGNATURE, "resolve", "pending");
    const rem = solanaPayoutSubmittedSnapshot("2026-07-10T00:00:00.000Z");
    const { recover } = await seededRecovery(rem, gateway);
    render(<LiveTrackView initial={rem} recover={recover} />);

    fireEvent.click(await screen.findByRole("button", { name: /Recuperar fondos/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Volver a intentar/ }));

    await waitFor(() => expect(gateway.calls).toHaveLength(2));
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

// ── El comprobante de una devolución transmitida no se pisa ──────────────────────────────────────
//
// 🔴 EL DEFECTO. `RefundAction` guardaba el desenlace en un casillero único
// (`{confirmation, refundTx} | null`) y "Volver a intentar" lo SOBRESCRIBÍA. Lo que guarda es la firma
// de una devolución YA TRANSMITIDA cuyo desenlace NADIE conoce (`"pending"` o `"unknown"`), o sea
// exactamente aquella que PUEDE haber llegado y que la persona necesita para ir al visor a
// averiguarlo. Y no vive en ningún otro lado: el use-case escribe `refundTx` en la remesa SÓLO cuando
// la cadena confirma, así que de las órdenes sin desenlace este componente es el único ejemplar.
//
// Es el mismo defecto que el fix-pack de WKH-346 arregló en `LostEscrowRecovery` (T-346-20/21). Esa HU
// lo detectó acá y no podía tocarlo: AC-9/CD-2 le prohibían editar el camino de firma.
//
// ⚠️ LO QUE ESTOS TESTS **NO** HACEN, y es deliberado: contar. Un `toHaveLength(N)` no distingue el
// arreglo del bug si N ya era cierto antes. Lo que se afirma es IDENTIDAD y CONTENIDO — que el nodo
// capturado tras el PRIMER click siga en el documento después del segundo, y que cada `href` conserve
// SU firma entera.
//
// ⚠️ Y LO QUE NO CUBREN, declarado: la secuencia `pending` → `confirmed`. Ahí el use-case escribe
// `refundTx` en la remesa, `showRefund` pasa a `false` y el componente entero se DESMONTA, así que la
// firma de la orden anterior se pierde igual — con el arreglo y sin él. Eso no se arregla cambiando la
// forma de este estado: hace falta persistir la orden transmitida, que es la capa de abajo.
describe("la devolución transmitida: dos órdenes, dos comprobantes", () => {
  afterEach(() => cleanup());

  it("dos órdenes sin desenlace dejan LOS DOS comprobantes, y el primero sigue siendo el primero", async () => {
    const gateway = new GatewayEnSecuencia([
      { refundTx: FAKE_SOLANA_SIGNATURE, confirmation: "pending" },
      { refundTx: SEGUNDA_FIRMA, confirmation: "unknown" },
    ]);
    const rem = solanaPayoutSubmittedSnapshot("2026-07-10T00:00:00.000Z");
    const { recover } = await seededRecovery(rem, gateway);
    render(<LiveTrackView initial={rem} recover={recover} />);

    fireEvent.click(await screen.findByRole("button", { name: /Recuperar fondos/ }));
    const primero = await screen.findByRole("link", { name: SIGNATURE_CORTA });
    fireEvent.click(await screen.findByRole("button", { name: /Volver a intentar/ }));
    const segundo = await screen.findByRole("link", { name: SEGUNDA_CORTA });

    // 🔴 EL ASSERT DEL DEFECTO: el nodo capturado tras el PRIMER click sigue vivo. Que el segundo
    // aparezca no prueba nada — con el casillero único aparecía igual, pisando al primero.
    expect(primero).toBeInTheDocument();
    // Y cada uno conserva SU firma entera, que es lo único auditable contra la cadena: un `.map()` que
    // reusara la misma firma para los dos pasaría el assert de arriba y caería acá.
    expect(primero.getAttribute("href")).toContain(FAKE_SOLANA_SIGNATURE);
    expect(segundo.getAttribute("href")).toContain(SEGUNDA_FIRMA);
    // Cada orden sigue diciendo lo SUYO. Colapsar los dos desenlaces en uno sería contar "no pudimos
    // preguntar" como "todavía no entró", que son cosas distintas.
    expect(screen.getByText(/Todavía no la vemos confirmada en la cadena/)).toBeInTheDocument();
    expect(screen.getByText(/No pudimos consultar la cadena/)).toBeInTheDocument();
    // Y el camino que FIRMA no se cerró: la segunda orden salió de verdad.
    expect(gateway.calls).toHaveLength(2);
  });

  // ⚠️ ESTE TEST NO DISTINGUE EL ARREGLO y se declara así: el código viejo también lo pasaba, porque el
  // `catch` nunca tocó el casillero. Vigila la OTRA forma de perder el comprobante — un reset metido en
  // el camino de error — que es la que quedaría sin nadie mirándola.
  it("un error posterior NO borra el comprobante de la orden ya transmitida", async () => {
    const gateway = new GatewayEnSecuencia([
      { refundTx: FAKE_SOLANA_SIGNATURE, confirmation: "pending" },
      "escrow_not_found",
    ]);
    const rem = solanaPayoutSubmittedSnapshot("2026-07-10T00:00:00.000Z");
    const { recover } = await seededRecovery(rem, gateway);
    render(<LiveTrackView initial={rem} recover={recover} />);

    fireEvent.click(await screen.findByRole("button", { name: /Recuperar fondos/ }));
    const comprobante = await screen.findByRole("link", { name: SIGNATURE_CORTA });
    fireEvent.click(await screen.findByRole("button", { name: /Volver a intentar/ }));

    expect(await screen.findByText(/No encontramos un depósito tuyo en el escrow/)).toBeInTheDocument();
    // El error es sobre el SEGUNDO intento; la orden del primero sigue transmitida y su firma es lo
    // único con lo que se puede ir a mirar si entró. ⚠️ Y es un caso REAL, no hipotético: si la primera
    // orden entró, la segunda falla con exactamente este código.
    expect(comprobante).toBeInTheDocument();
    expect(comprobante.getAttribute("href")).toContain(FAKE_SOLANA_SIGNATURE);
    expect(screen.getByText(/Enviamos la orden de recuperación/)).toBeInTheDocument();
  });
});

// ── Lo que la pantalla dice en cada uno de los tres casos ─────────────────────────────────────────
// Antes decía lo mismo en los tres: "No pudo entregarse. Si te cobramos, te reembolsamos", con una
// referencia de reembolso inventada al lado. Estos tests clavan que cada caso tiene su frase, y que
// la referencia sólo aparece cuando existe.
describe("los tres casos, dichos con palabras distintas", () => {
  afterEach(() => cleanup());

  /** Una remesa que ya falló, con el failureReason que escribió el use-case. */
  function failedWith(reason: string, expiresAt = "2026-07-10T00:00:00.000Z"): RemittanceState {
    const base = Remittance.rehydrate(solanaPayoutSubmittedSnapshot(expiresAt));
    base.markPayoutFailed(reason, T0);
    return base.snapshot;
  }

  /** Igual, pero SIN depósito: parte de `confirmed`, así que `principalTx` queda en null y
   *  `escrowFundsKnowledge` da "no-deposit". `failedWith` parte de `payout_submitted`, o sea de una
   *  remesa que YA pasó por `markPrincipalIn`: usarla para un corte ANTERIOR a la primera firma
   *  describe una remesa con depósito y le hace decir a la pantalla que no lo hubo (CR/BLQ-BAJO-1). */
  function failedBeforeDepositWith(
    reason: string,
    expiresAt = "2026-07-10T00:00:00.000Z",
  ): RemittanceState {
    const base = Remittance.rehydrate(solanaConfirmedSnapshot(expiresAt));
    base.markPayoutFailed(reason, T0);
    return base.snapshot;
  }

  it("NO SABEMOS: lo dice con esas palabras, no lo llama fallo ni reembolso", async () => {
    const rem = failedWith(PRINCIPAL_STATE_UNKNOWN);
    const { recover } = await seededRecovery(rem, new FakeSolanaEscrowRefundGateway());
    render(<LiveTrackView initial={rem} recover={recover} />);

    expect(screen.getByText(/No sabemos todavía si te cobramos/)).toBeInTheDocument();
    expect(screen.getByText(/todavía no lo sabemos/)).toBeInTheDocument();
    expect(screen.getByText(/Nadie te reembolsó nada/)).toBeInTheDocument();
    // NO se disfraza de fallo entregado ni de reembolso hecho.
    expect(screen.queryByText(/No pudo entregarse/)).toBeNull();
    expect(screen.queryByText(/te reembolsamos/)).toBeNull();
    expect(screen.queryByText(/Referencia de reembolso/)).toBeNull();
    // Y la salida está a la vista.
    expect(screen.getByRole("button", { name: /Recuperar fondos/ })).toBeEnabled();
  });

  it("SÍ ENTRÓ: dice dónde están los USDC y que los recupera la persona", async () => {
    const rem = failedWith(PRINCIPAL_SETTLED_REFUND_MANUAL);
    const { recover } = await seededRecovery(rem, new FakeSolanaEscrowRefundGateway());
    render(<LiveTrackView initial={rem} recover={recover} />);

    expect(screen.getByText(/Tus USDC quedaron en el escrow/)).toBeInTheDocument();
    expect(screen.getByText(/Los USDC siguen ahí, a tu nombre/)).toBeInTheDocument();
    expect(screen.queryByText(/Referencia de reembolso/)).toBeNull();
    expect(screen.getByRole("button", { name: /Recuperar fondos/ })).toBeEnabled();
  });

  // El cuarto caso, que ni siquiera es un fallo de entrega: no teníamos la dirección de la wallet, así
  // que el corte fue antes de la primera llamada de red. Antes se decía "No pudo entregarse. Si te
  // cobramos, te reembolsamos" — o sea, se dejaba a la persona esperando un reembolso inexistente en
  // vez de mandarla a lo único que lo arregla.
  it("SIN ADDRESS: manda a reconectar la wallet, no a esperar un reembolso", async () => {
    const rem = failedWith(WALLET_ADDRESS_UNAVAILABLE);
    const { recover } = await seededRecovery(rem, new FakeSolanaEscrowRefundGateway());
    render(<LiveTrackView initial={rem} recover={recover} />);

    expect(screen.getByText(/Reconectá tu wallet/)).toBeInTheDocument();
    expect(screen.getByText(/dirección de tu wallet/)).toBeInTheDocument();
    expect(screen.getByText(/no se movió ningún USDC/)).toBeInTheDocument();
    // Ni el fallo de entrega, ni el reembolso prometido, ni la identidad puesta en duda.
    expect(screen.queryByText(/No pudo entregarse/)).toBeNull();
    expect(screen.queryByText(/te reembolsamos/)).toBeNull();
    expect(screen.queryByText(/verificar tu identidad/)).toBeNull();
  });

  // Hallazgo #75 — el rechazo del agente de payout tampoco es un fallo de entrega. El prepare corre
  // ANTES de authorizePrincipal ((`prepare_unavailable`, `confirm-and-send.ts:477`)), o sea antes de que la wallet firme
  // nada: "no se movió ningún USDC" es un hecho que se lee del orden del use-case. Decirlo con las
  // palabras del payout fallido ("si te cobramos, te reembolsamos") deja esperando un reembolso que
  // no existe, por una causa que se arregla re-cotizando.
  it.each([
    "prepare_agent_rejected",
    "prepare_quote_amount_mismatch",
    "prepare_quote_unresolvable",
    "prepare_kyc_identity_claim_missing",
  ])("RECHAZADO EN PREPARE (%s): no promete reembolso y dice que no se movió nada", async (reason) => {
    const rem = failedWith(reason);
    const { recover } = await seededRecovery(rem, new FakeSolanaEscrowRefundGateway());
    render(<LiveTrackView initial={rem} recover={recover} />);

    expect(screen.getByText(/No pudimos preparar el envío/)).toBeInTheDocument();
    expect(screen.getByText(/no se movió ningún USDC/)).toBeInTheDocument();
    // Ni el fallo de entrega, ni el reembolso prometido, ni la incertidumbre sobre el cobro.
    expect(screen.queryByText(/No pudo entregarse/)).toBeNull();
    expect(screen.queryByText(/te reembolsamos/)).toBeNull();
    expect(screen.queryByText(/No sabemos todavía/)).toBeNull();
  });

  // AR fix-pack BLQ-ALTO-1 — el quinto caso, y el que la HU había dejado sin llegar a la pantalla.
  //
  // 🔴 QUÉ MIDE, con el input concreto. `prepare_no_agent_for_capability` NO está en
  // `PREPARE_REJECTION_ENUMS` (a propósito: nadie rechazó nada, no hubo agente), así que el `it.each`
  // de acá arriba no lo cubre. Sin la rama propia caía al `else` de `TrackView`, o sea a
  // `humanError("payout_failed")`, y la persona leía "No pudo entregarse" + "si tus USDC entraron al
  // escrow, los sacás vos firmando desde tu wallet" para un corte que ocurre ANTES de que la
  // billetera firme nada. Este `it` se pone rojo si alguien borra la rama: el título vuelve a ser
  // "No pudo entregarse" y aparece la frase del escrow.
  //
  // El único llamador del enum vivía en `flow-vm.test.ts`, o sea que el copy existía y ningún camino
  // de producto lo alcanzaba. Por eso este test RENDERIZA `TrackView` en vez de llamar a `humanError`.
  it("SIN AGENTE PARA LA CAPACIDAD: no lo dice como un fallo de entrega ni manda a buscar plata al escrow", async () => {
    const rem = failedBeforeDepositWith(PREPARE_NO_AGENT_FOR_CAPABILITY);
    const { recover } = await seededRecovery(rem, new FakeSolanaEscrowRefundGateway());
    render(<LiveTrackView initial={rem} recover={recover} />);

    expect(screen.getByText(/No hay quién entregue este envío/)).toBeInTheDocument();
    expect(screen.getByText(/no hay ningún proveedor/)).toBeInTheDocument();
    expect(screen.getByText(/No se movió ningún USDC/)).toBeInTheDocument();
    // Y ninguna de las tres frases de los OTROS desenlaces: ni el fallo de entrega, ni el reembolso
    // prometido, ni la invitación a sacar del escrow unos USDC que nunca entraron.
    expect(screen.queryByText(/No pudo entregarse/)).toBeNull();
    expect(screen.queryByText(/te reembolsamos/)).toBeNull();
    expect(screen.queryByText(/los sacás vos/)).toBeNull();
    // Ni el copy de la familia hermana: acá no hubo ningún agente que rechazara nada.
    expect(screen.queryByText(/El agente de pagos rechazó/)).toBeNull();
  });

  // 🔴 WKH-358 (fix-pack · AR/BLQ-MED-2) — EL SEXTO DESENLACE: "NO LLEGAMOS A PREGUNTARLE A NADIE".
  //
  // QUÉ MIDE, con el input concreto. `payout_pop_unavailable` y `prepare_unavailable` NO son
  // `isPrepareRejection` (medido: los 4 enums de esa familia no los incluyen) y hasta el fix-pack
  // NINGUNA rama los nombraba, así que caían en el `else` de `TrackView` ⇒ `humanError("payout_failed")`
  // ⇒ *"No se pudo entregar… si tus USDC entraron al escrow, los sacás vos firmando desde tu wallet"*.
  // Los dos salen de `failAndRefund(..., "not_deposited")`, o sea que "no entró ningún USDC" es CERTEZA:
  // esa frase mandaba a buscar plata donde se sabe que no hay.
  //
  // ⚠️ Y ESTE `it` MIDE ADEMÁS LO QUE EL COPY **NO** DICE: no niega la firma. `payout_pop_unavailable`
  // sale de que `pop.prove()` falló, y esa prueba SÍ le pide a la billetera firmar un mensaje (que no
  // mueve plata, pero es una firma). Decir "no se pidió ninguna firma" acá sería la misma clase de
  // afirmación de más que este desenlace vino a corregir.
  //
  // MUTANTE QUE MATA: borrar `prepareUnreachable` del dispatch de `TrackView` (las dos ramas o
  // cualquiera de las dos) ⇒ el título vuelve a "No pudo entregarse" y reaparece "los sacás vos".
  it.each(["payout_pop_unavailable", "prepare_unavailable"])(
    "NO LLEGAMOS A PREPARAR (%s): no lo dice como un payout fallido y no manda a sacar del escrow",
    async (reason) => {
      const rem = failedBeforeDepositWith(reason);
      // CD-18 — el fixture fabricó el caso: si este reason entrara a la familia de rechazos del agente,
      // este `it` estaría midiendo la rama de al lado y pasaría por el motivo equivocado.
      expect(isPrepareRejection(reason), "el reason entró a la familia de rechazos del agente").toBe(false);
      const { recover } = await seededRecovery(rem, new FakeSolanaEscrowRefundGateway());
      render(<LiveTrackView initial={rem} recover={recover} />);

      expect(screen.getByText(/No llegamos a preparar el envío/)).toBeInTheDocument();
      expect(screen.getByText(/no se movió ningún USDC de tu wallet/)).toBeInTheDocument();
      expect(screen.getByText(/no hay ningún reembolso pendiente/)).toBeInTheDocument();
      // ⛔ LAS TRES FRASES QUE NO PUEDEN ESTAR: la del payout fallido, la del reembolso prometido y la
      // que invita a sacar del escrow unos USDC que nunca entraron.
      expect(screen.queryByText(/No pudo entregarse/)).toBeNull();
      expect(screen.queryByText(/te reembolsamos/)).toBeNull();
      expect(screen.queryByText(/los sacás vos/)).toBeNull();
      // ⛔ Ni el copy de la familia hermana: acá NO hubo ningún agente que rechazara nada…
      expect(screen.queryByText(/El agente de pagos rechazó/)).toBeNull();
      expect(screen.queryByText(/No pudimos preparar el envío/)).toBeNull();
      // …⛔ ni la negación de la firma, que este desenlace no puede afirmar.
      expect(screen.queryByText(/No se pidió ninguna firma/)).toBeNull();
      expect(screen.queryByText(/antes de que firmaras nada/)).toBeNull();
    },
  );

  // 🔴 CR/BLQ-BAJO-1 — LA TARJETA NO PUEDE CONTRADECIRSE SOBRE LA PLATA DE LA PERSONA.
  //
  // Lo que el CR midió en el DOM, en UNA sola tarjeta y en este orden: *"No se movió ningún USDC de
  // tu wallet"* → botón **"Recuperar fondos"** → *"El plazo se fija cuando depositás y dura unas 2
  // horas"*. Una afirmación categórica sobre que no hubo depósito, y a tres nodos de distancia una
  // acción y un plazo que sólo existen si lo hubo.
  //
  // El `it` de acá arriba no podía verlo: sólo mira TEXTO, y el botón no es texto de la tarjeta.
  it("CR/BLQ-BAJO-1: si afirma que no se movió nada, NO ofrece recuperar ni habla de un plazo", async () => {
    const rem = failedBeforeDepositWith(PREPARE_NO_AGENT_FOR_CAPABILITY);
    const { recover } = await seededRecovery(rem, new FakeSolanaEscrowRefundGateway());
    render(<LiveTrackView initial={rem} recover={recover} />);

    // La afirmación categórica sigue estando (es el hecho que sostiene el orden del use-case)…
    expect(screen.getByText(/No se movió ningún USDC/)).toBeInTheDocument();
    // …y por eso lo que se va es lo que la desmentía.
    expect(screen.queryByRole("button", { name: /Recuperar fondos/ })).toBeNull();
    expect(screen.queryByText(/El plazo se fija cuando depositás/)).toBeNull();
  });

  // La otra dirección, que es la que impide "arreglarlo" tapando el botón siempre: con un depósito
  // que NO se puede descartar (`principalTx` puesto), la tarjeta deja de afirmar en categórico y el
  // botón vuelve. Sin este `it`, un `showRefund` que ignorara `escrowFundsKnowledge` pasaría igual —
  // y esa versión esconde la única salida hacia unos USDC que sí pueden estar en el escrow.
  it("CR/BLQ-BAJO-1 (candado): con depósito que no se puede descartar, vuelve el botón y se va la afirmación", async () => {
    const rem = failedWith(PREPARE_NO_AGENT_FOR_CAPABILITY); // parte de payout_submitted ⇒ principalTx
    const { recover } = await seededRecovery(rem, new FakeSolanaEscrowRefundGateway());
    render(<LiveTrackView initial={rem} recover={recover} />);

    expect(screen.getByRole("button", { name: /Recuperar fondos/ })).toBeEnabled();
    expect(screen.queryByText(/No se movió ningún USDC/)).toBeNull();
    expect(screen.queryByText(/No hay quién entregue este envío/)).toBeNull();
    // Y lo que dice en su lugar es el copy CONDICIONAL, que con el botón al lado no se contradice.
    expect(screen.getByText(/si tus USDC entraron al escrow/)).toBeInTheDocument();
  });

  // Y la familia hermana queda INTACTA: se excluyó de `showRefund`, no de `refundeable`.
  it.each(["prepare_agent_rejected", "prepare_quote_unresolvable", WALLET_ADDRESS_UNAVAILABLE])(
    "CR/BLQ-BAJO-1 (candado): %s conserva su botón de recuperar",
    async (reason) => {
      const rem = failedWith(reason);
      const { recover } = await seededRecovery(rem, new FakeSolanaEscrowRefundGateway());
      render(<LiveTrackView initial={rem} recover={recover} />);

      expect(screen.getByRole("button", { name: /Recuperar fondos/ })).toBeEnabled();
    },
  );

  it("NO ENTRÓ: sigue siendo el fallo de siempre, sin inventar un tercer estado", async () => {
    const rem = failedWith("solana_settle_rejected");
    const { recover } = await seededRecovery(rem, new FakeSolanaEscrowRefundGateway());
    render(<LiveTrackView initial={rem} recover={recover} />);

    expect(screen.getByText(/No pudo entregarse/)).toBeInTheDocument();
    expect(screen.queryByText(/No sabemos todavía/)).toBeNull();
    expect(screen.queryByText(/quedaron en el escrow/)).toBeNull();
    expect(screen.queryByText(/Referencia de reembolso/)).toBeNull();
  });

  // El mutante que hay que matar: alguien vuelve a escribir un comprobante fabricado en el estado.
  it("un refundTx fabricado en el estado se mostraría: por eso el use-case NO lo escribe", async () => {
    const base = Remittance.rehydrate(failedWith("partner_down"));
    base.markRefunded("refund-ledger-mabc", T0); // exactamente lo que el ledger devolvía antes
    const rem = base.snapshot;
    const { recover } = await seededRecovery(rem, new FakeSolanaEscrowRefundGateway());
    render(<LiveTrackView initial={rem} recover={recover} />);

    // La pantalla es fiel al estado: si el estado tiene una referencia, la muestra. Por eso la
    // defensa tiene que estar aguas arriba, y por eso el test de arriba verifica que NO llega acá.
    expect(screen.getByText(/Referencia de reembolso/)).toBeInTheDocument();
    // Y confirma el daño: en `refunded` la persona ya no tiene botón para recuperar nada.
    expect(screen.queryByRole("button", { name: /Recuperar fondos/ })).toBeNull();
  });

  it("escrow_not_found NO se dice como 'no pudimos recuperar tus fondos'", async () => {
    const rem = failedWith(PRINCIPAL_STATE_UNKNOWN);
    const gateway = new FakeSolanaEscrowRefundGateway(FAKE_SOLANA_SIGNATURE, "reject");
    vi.spyOn(gateway, "refund").mockRejectedValue(new Error("escrow_not_found"));
    const { recover } = await seededRecovery(rem, gateway);
    render(<LiveTrackView initial={rem} recover={recover} />);

    fireEvent.click(await screen.findByRole("button", { name: /Recuperar fondos/ }));

    expect(await screen.findByText(/No encontramos un depósito tuyo en el escrow/)).toBeInTheDocument();
    expect(screen.queryByText(/No pudimos recuperar los fondos/)).toBeNull();
  });
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

  // Arreglar la etiqueta no alcanzaba: encima seguía girando un spinner, y con la configuración de
  // hoy ahí no pasa nada solo (el release lo dispara una persona a mano). La animación afirmaba un
  // progreso inexistente, para siempre.
  it("en payout_submitted NADA gira: el paso que no avanza solo no se anima", () => {
    const rem = buildFlowSnapshot("payout_submitted", "transfi");
    const { container } = render(
      <TrackView rem={rem} recover={undefined} sender={null} onRecovered={() => {}} />,
    );

    expect(container.querySelectorAll(".animate-spin")).toHaveLength(0);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
  });

  // ── La tarjeta del desembolso en curso ────────────────────────────────────────────────────────
  // Esta pantalla es la que la persona mira más tiempo, y es la que el founder pidió que se viera
  // "más vendedora". Se rehizo, y estos tests son el límite de hasta dónde puede embellecerse.
  //
  // 🔴 EL RIESGO CONCRETO QUE VIGILAN. Este proyecto YA tuvo una pantalla que afirmaba "entregado"
  // sin consultar nada, mostrando el monto COTIZADO como si fuera el entregado. Se sacó. La presión
  // de hacer la pantalla más linda es exactamente la que la traería de vuelta, así que lo que se
  // assertea no es el diseño: es que el TIEMPO VERBAL siga siendo futuro y que la advertencia siga
  // estando. Las dos son lo único que separa esta tarjeta de aquella.
  it("el desembolso en curso muestra el monto en FUTURO y conserva la advertencia", () => {
    const rem = buildFlowSnapshot("payout_submitted", "transfi");
    render(<TrackView rem={rem} recover={undefined} sender={null} onRecovered={() => {}} />);

    expect(screen.getByText(/va a recibir/)).toBeInTheDocument(); // futuro, no "recibió"
    // La advertencia NO es opcional: sin ella la tarjeta afirma una entrega que nadie confirmó.
    expect(screen.getByText(/Todavía no tenemos la confirmación/)).toBeInTheDocument();
    expect(screen.getByText(/vimos entrar tus USDC al contrato/i)).toBeInTheDocument();
    // Y nunca el verbo en pasado sobre la llegada del dinero.
    expect(screen.queryByText(/ya recibió/i)).toBeNull();
    expect(screen.queryByText(/le llegó/i)).toBeNull();
  });

  // ── Las dos frases de esta tarjeta que afirmaban de más ───────────────────────────────────────
  //
  // Las dos se contradecían con algo escrito en ESTE MISMO archivo, que es la señal más barata de que
  // una frase afirma de más:
  //  · "El proveedor está procesando el desembolso" vs el comentario de TRACK_STEPS, quince líneas
  //    más arriba: "Nadie está pagando todavía". En payout_submitted lo único que pasó es que el
  //    agente aceptó crear la orden; los USDC siguen en el vault y el release lo dispara una persona.
  //  · "Tus USDC ya están en el contrato" (presente) vs lo que la MISMA remesa dice en el historial:
  //    "No comprobamos si tus USDC siguen en el escrow" (escrowFundsKnowledge → unverified). Lo único
  //    probado es el hecho pasado que respalda `principalTx`: la cadena confirmó que el depósito entró.
  it("la tarjeta del desembolso no afirma que alguien esté pagando ni que los USDC sigan ahí ahora", () => {
    const rem = buildFlowSnapshot("payout_submitted", "transfi");
    render(<TrackView rem={rem} recover={undefined} sender={null} onRecovered={() => {}} />);

    expect(screen.getByText("El proveedor aceptó la orden de pago")).toBeInTheDocument();
    // Nadie está procesando ni pagando: el paso lo destraba una persona del equipo.
    expect(screen.queryByText(/est[áa] procesando/i)).toBeNull();
    expect(screen.queryByText(/est[áa] pagando/i)).toBeNull();
    // Y el estado del vault se dice en pasado (lo vimos entrar), no en presente (siguen ahí).
    expect(screen.queryByText(/USDC ya est[áa]n en el contrato/i)).toBeNull();
    expect(screen.queryByText(/siguen en el contrato/i)).toBeNull();
  });

  // El sello del entorno de prueba se prende con `isDemoMode`, que es un OR de TRES proveniencias.
  // Decía "El desembolso es simulado: no se movió dinero real hacia ninguna cuenta bancaria", o sea
  // afirmaba cuál de los tres pasos había sido, y con la cotización simulada + un desembolso REAL las
  // dos mitades eran falsas a la vez. El texto ahora dice lo que la condición mide.
  it("el sello de prueba no elige cuál de los tres pasos fue el simulado", () => {
    const simulado = buildFlowSnapshot("payout_submitted", "local-fallback");
    render(<TrackView rem={simulado} recover={undefined} sender={null} onRecovered={() => {}} />);

    expect(screen.getByText(/Al menos uno de los pasos de este envío/)).toBeInTheDocument();
    expect(screen.queryByText(/El desembolso es simulado/)).toBeNull();
    expect(screen.queryByText(/no se movió dinero real/)).toBeNull();
    // Lo que SÍ se conserva, porque es verdad y es lo que distingue esta demo de una maqueta.
    expect(screen.getByText(/El depósito en la cadena sí es real/)).toBeInTheDocument();
  });

  it("el sello de entorno de prueba sale de la proveniencia REAL del desembolso, no de una bandera", () => {
    const simulado = buildFlowSnapshot("payout_submitted", "local-fallback");
    const { unmount } = render(
      <TrackView rem={simulado} recover={undefined} sender={null} onRecovered={() => {}} />,
    );
    expect(screen.getByText(/Entorno de prueba/)).toBeInTheDocument();
    expect(screen.getByText(/Al menos uno de los pasos de este envío/)).toBeInTheDocument();
    unmount();

    // Con un desembolso REAL el sello desaparece SOLO, porque cambió el dato y no porque alguien se
    // haya acordado de sacarlo. Ese es el punto de derivarlo de `payoutProvenance`.
    const real = buildFlowSnapshot("payout_submitted", "transfi");
    render(<TrackView rem={real} recover={undefined} sender={null} onRecovered={() => {}} />);
    expect(screen.queryByText(/Entorno de prueba/)).toBeNull();
  });

  it("en payout_submitted el encabezado no promete movimiento y avisa que el paso es manual", () => {
    const rem = buildFlowSnapshot("payout_submitted", "transfi");
    render(<TrackView rem={rem} recover={undefined} sender={null} onRecovered={() => {}} />);

    expect(screen.queryByText(/Tu chaski está en camino/)).toBeNull();
    expect(screen.getByText(/Tu envío está esperando/)).toBeInTheDocument();
    expect(screen.getByText(/Este paso no avanza solo/)).toBeInTheDocument();
    expect(screen.getByText(/la libera una persona del equipo/)).toBeInTheDocument();
  });

  // En principal_in el settle SÍ está en curso de verdad: ahí el spinner no miente y se queda.
  it("en principal_in el paso en curso SÍ se anima (ahí sí está pasando algo)", () => {
    const base = Remittance.rehydrate(buildFlowSnapshot("payout_submitted", "transfi"));
    const rem = { ...base.snapshot, status: "principal_in" as const };
    const { container } = render(
      <TrackView rem={rem} recover={undefined} sender={null} onRecovered={() => {}} />,
    );

    expect(container.querySelectorAll(".animate-spin").length).toBeGreaterThan(0);
    expect(screen.getByText(/Tu chaski está en camino/)).toBeInTheDocument();
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
    render(<RemittanceFlow pasoInicial="send" container={buildTestContainer({ wallet: new FakeSolanaWallet() })} />);

    // send → connect → review: si el render crasheara, "Revisá el envío" NUNCA aparecería.
    await goToReview();
    expect(screen.getByText(/Revisá el envío/)).toBeInTheDocument();

    // El banner "Sin aislamiento por wallet" ya no existe (se fue con isFallbackWalletAddress).
    expect(screen.queryByText(/Sin aislamiento por wallet/)).toBeNull();
  });
});

// ── T-6.1 — AC-6 · un proveniencia DESCONOCIDA cae del lado de "sin verificar" ────────────────────
//
// 🔴 QUÉ CONSERVA, y por qué esta HU lo mide en vez de darlo por hecho. `REAL_KYC_PROVENANCES` es una
// ALLOWLIST: lo desconocido NO se puede afirmar como verificado. Antes acá vivía la comparación
// contra el único valor simulado CONOCIDO, o sea que todo lo demás se leía como real, y con
// `DIDIT_ENV=mock` la pantalla escribía "Identidad verificada" sobre datos que nadie verificó.
//
// WKH-332 va exactamente en la dirección de que mañana la verificación la atienda un agente
// DESCUBIERTO, o sea un emisor de `provenance` que este archivo no conoce hoy. Ese es el input de
// este test: si la dirección de la allowlist se invirtiera —o si alguien la volviera env, que está
// prohibido por el mismo motivo que los pisos de reputación—, un agente nuevo prendería el badge
// verde el día que aparezca, sin que nada falle.
//
// CD-17: depende del `vi.mock("framer-motion")` de módulo y de los helpers `goToConfirm` /
// `buildTestContainer` de este archivo. Se corre en la suite completa, no solo.
it("T-6.1: sin el juicio del AGENTE ⇒ NO 'Identidad verificada', y SÍ el origen crudo", async () => {
  const agenteNuevo = "cualquier-agente-nuevo";
  render(
    <RemittanceFlow pasoInicial="send"
      container={buildTestContainer({ kyc: new FakeKycGateway({ provenance: agenteNuevo }) })}
    />,
  );

  await goToConfirm();

  // (a) el badge verde NO sale: afirmar una verificación exige que el AGENTE la haya declarado real.
  expect(screen.queryByText(/Identidad verificada/)).toBeNull();
  // (b) sale la tarjeta que dice que no se puede afirmar...
  expect(screen.getByText(/Identidad sin verificar/)).toBeInTheDocument();
  // (c) ...y NOMBRA el origen crudo, en vez de esconderlo. Sin esto la pantalla diría "no verificada"
  //     sin dar con qué discutirlo, y quien opera no sabría qué emisor mirar.
  expect(screen.getByText(new RegExp(agenteNuevo))).toBeInTheDocument();
  // (d) ⚠️ Y LO QUE ANTES ERA "los datos siguen mostrándose" YA NO APLICA: el agente no devuelve
  //     ningún dato de identidad, así que no hay datos que mostrar. Lo cubre T-UI-2.
});

// ── WKH-339 · T-339.2 (AC-1) — la ventana apagada tiene un gesto para volver a encenderse ─────────
//
// 🔴 QUÉ AGUJERO CIERRA. El seguimiento lee el desenlace del payout detrás de una prueba de posesión
// que vale 8 minutos y que la lectura NO renueva: el gateway sólo la CONSULTA. Cuando se apaga, el
// seguimiento deja de leer. Eso no miente —devuelve un estado no-terminal y la remesa se queda donde
// está— pero la persona no tenía NINGÚN gesto para volver a encenderla. Esto lo mide.
//
// 🔴 POR QUÉ VA POR `RemittanceFlow` Y NO POR `<TrackView>` A MANO, y es la mitad del valor de este
// test. Montar `TrackView` con la prop puesta a mano probaría que el componente sabe renderizar un
// botón, y NO probaría lo único que se puede olvidar: que el composition root le pase la capacidad.
// Los 22 mounts de `<TrackView` que ya existen en el repo pasan sin la prop y siguen pasando, así que
// ninguno puede ver ese olvido. Éste sí: llega a la pantalla por el mismo camino que una persona.
//
// El estado inicial del almacén de pruebas es el CASO REAL, no un montaje: `buildTestContainer` arma
// un `InMemoryPopProofStore` vacío, y una persona que recarga y entra desde el historial se encuentra
// exactamente eso — nunca hubo prueba, no venció ninguna. Por eso el aserto NO busca la palabra
// "venció" en ningún lado: buscar un gesto es falsable, buscar una historia que el sistema no puede
// distinguir no lo es.
//
// ⚠️ EL `sender` NO ES `null` ACÁ, Y HAY QUE VERIFICARLO O EL ROJO ES POR EL MOTIVO EQUIVOCADO: con
// `sender == null` la pantalla cae en el estado "sin billetera", que a propósito NO ofrece el gesto
// (no hay a quién pedirle la firma), y el test quedaría rojo antes Y después del fix. `openHistory`
// pasa por `resolveSender`, que hace `setAddress(addr)` (`resolveSender`, `./flow.tsx:396`), así que
// al llegar al seguimiento `sender` es la address del dueño. El aserto (b) lo clava.
//
// Molde: `seededFlow` de `history.test.tsx:130`, que es el mismo camino (pestaña "Mis envíos" → "Ver
// seguimiento"). Se reescribe acá en vez de importarse porque los helpers de ese archivo son locales.
it("T-339.2 (AC-1): con la ventana de lectura apagada, el seguimiento ofrece revisar ahora", async () => {
  const repo = new InMemoryRepo();
  const rem = solanaPayoutSubmittedSnapshot("2026-07-10T00:00:00.000Z");
  await repo.save(Remittance.rehydrate(rem));
  // `FakeSolanaWallet` para que `connect()` devuelva FAKE_SOLANA_BENEFICIARY, que es el dueño de la
  // remesa sembrada: sin eso el historial vendría vacío y no habría a dónde llegar.
  // `solanaRefund` NO es decorativo: es lo que hace montar "Recuperar fondos", y ese botón es el
  // instrumento del aserto (b) — sólo se renderiza con `sender` no nulo.
  const container = buildTestContainer({
    repo,
    wallet: new FakeSolanaWallet(),
    solanaRefund: new FakeSolanaEscrowRefundGateway(),
  });

  // Arranque en frío: el flujo monta en `send`. Es una recarga, y el almacén de pruebas está vacío
  // desde el primer milisegundo. NO se graba ninguna prueba a propósito.
  render(<RemittanceFlow pasoInicial="send" container={container} />);
  irAMisEnvios();
  fireEvent.click(await screen.findByRole("button", { name: /Ver seguimiento/ }));

  // (a) llegamos al seguimiento de una remesa en `payout_submitted` (si esto falla, el test mide otra
  //     cosa y el rojo de abajo no habla de la ventana).
  expect(await screen.findByText(/El proveedor aceptó la orden de pago/)).toBeInTheDocument();
  // (b) y con dueño conocido: es lo que descarta el estado "sin billetera" como causa del rojo.
  expect(await screen.findByRole("button", { name: /Recuperar fondos/ })).toBeInTheDocument();

  // (c) EL ASERTO. Existe un control accesible para revisar AHORA. En presente: el gesto, no la
  //     historia. ⚠️ El nombre de este `it` y esta línea decían "volver a revisar", que es una de las
  //     tres frases que el copy tiene PROHIBIDAS (implica que revisábamos antes). Lo cazó el eje
  //     VECINDAD del barrido de familia, sobre prosa que escribí en esta misma pasada.
  expect(await screen.findByRole("button", { name: /revisar/i })).toBeInTheDocument();
});

// ── WKH-339 · T-339.4 / T-339.6 / T-339.7 — los siete estados de la ventana en pantalla ─────────────
//
// 🔴 QUÉ SE MIDE ACÁ Y POR QUÉ SOBRE `TrackView` DIRECTO, no sobre `RemittanceFlow`. El cableado ya lo
// mide T-339.2 (y T-339.5 al nivel del container). Lo que falta es lo que sólo se puede ejercitar
// controlando los desenlaces de `prove()`, y ésos no se pueden inducir desde el flujo completo.
//
// `ventana` y `renovar` se arman con la MISMA forma que `container.ts`: un `peek` sobre un almacén real
// decide el estado, y el signer graba EN ESE almacén. Así "el control desaparece al renovar" no es un
// flag que el test setea: es la consecuencia de que `estado()` pase a `"vigente"`.
// El tick del control, para los `it` con fake timers. ⚠️ Es un SEGUNDO LITERAL de `VENTANA_CHECK_MS`
// (`flow.tsx`), que no está exportado. Se declara acá con su origen escrito en vez de dejarlo suelto: si
// alguien cambia el de producción, estos `it` avanzan de menos y se ponen rojos, que es la dirección
// correcta (fallan del lado de "no esperé lo suficiente", nunca del lado de dar por bueno un tick que no
// ocurrió).
const VENTANA_CHECK_MS_EN_TEST = 5000;

function ventanaDeTest(clock = new FixedClock()) {
  const store = new InMemoryPopProofStore(clock);
  const estado = vi.fn((a: string) => (store.peek(a) ? ("vigente" as const) : ("sin-prueba" as const)));
  return { store, ventana: { estado } };
}
/** El signer que SÍ graba, o sea el desenlace feliz de `prove()`. */
function signerQueGraba(store: InMemoryPopProofStore) {
  return {
    prove: vi.fn(async (a: string) => {
      const p = { challenge: "ch-339", signature: "sig-339" };
      store.record(a, p);
      return p;
    }),
  };
}

describe("WKH-339 — los siete estados de la ventana de lectura, en pantalla", () => {
  // ⚠️ EL `sessionStorage` SE LIMPIA ENTRE TESTS, y hace falta desde que el techo sobrevive al remonte
  // (CR/BLQ-MED-2): sin esto, el primer `it` que agota los 3 intentos deja el contador puesto y los
  // siguientes arrancan con el botón deshabilitado. Medido: 4 tests rojos por contaminación, ninguno por
  // el comportamiento. Es la contracara honesta de persistir: el estado que sobrevive a un remonte también
  // sobrevive a un `cleanup()`.
  beforeEach(() => window.sessionStorage.clear());
  afterEach(cleanup);
  const rem = solanaPayoutSubmittedSnapshot("2026-07-10T00:00:00.000Z");

  // ── T-339.6 (AC-5) · Estado 1: con la ventana VIGENTE el render es el de siempre ────────────────
  //
  // Molde de (`cleanup`, `./agent-plan-card.test.tsx:434`) —⚠️ acá decía `:406`, que es una línea EN BLANCO: una cita suelta que no se puede seguir (fix-pack · CR/MNR-8), ahora anclada y por lo tanto vigilada—: render → capturar → `cleanup()` → render → capturar →
  // comparar. ⚠️ El `cleanup()` NO es opcional: sin él quedan DOS árboles en el DOM y se compararía el
  // render anterior consigo mismo.
  //
  // Mata a M2 (`estado()` devuelve `"sin-prueba"` siempre) y a M3 (el botón se renderiza sin mirar el
  // estado): los dos harían aparecer el bloque nuevo con la ventana vigente, y el HTML dejaría de ser
  // idéntico al de sin `revision`.
  it("T-339.6: ventana VIGENTE ⇒ el HTML es byte-idéntico al de sin `revision` (nada nuevo en pantalla)", async () => {
    // (1) el render de referencia: sin la prop, o sea exactamente el de antes de esta HU.
    const { container: sinProp } = render(
      <TrackView rem={rem} sender={FAKE_SOLANA_BENEFICIARY} onRecovered={() => {}} />,
    );
    const htmlSinProp = sinProp.innerHTML;
    cleanup();

    // (2) el mismo render, con la prop puesta y una prueba YA grabada ⇒ la ventana está vigente.
    const { store, ventana } = ventanaDeTest();
    store.record(FAKE_SOLANA_BENEFICIARY, { challenge: "ch", signature: "sig" });
    const { container: conVentana } = render(
      <TrackView
        rem={rem}
        sender={FAKE_SOLANA_BENEFICIARY}
        onRecovered={() => {}}
        revision={{ ventana, renovar: signerQueGraba(store) }}
      />,
    );
    await waitFor(() => expect(ventana.estado).toHaveBeenCalled());

    expect(
      conVentana.innerHTML,
      "con la ventana VIGENTE la pantalla muestra algo que antes no mostraba: o `estado()` no discrimina " +
        "(M2), o el bloque nuevo se renderiza sin condicionar por el estado (M3)",
    ).toBe(htmlSinProp);
    expect(screen.queryByRole("button", { name: /revisar/i })).toBeNull();
  });

  // ── T-339.7 (AC-4) · Estado 5: sin billetera se explica, y NO se ofrece el gesto ────────────────
  //
  // Mata a M12 (`sin-billetera` colapsa en `sin-prueba`): ofrecería "Revisar ahora" sin tener a quién
  // pedirle la firma. ⚠️ Rama DEFENSIVA: que sea "alcanzable de verdad desde el historial" NO está medido
  // y la afirmación se sacó. Se cubre porque el tipo de `sender` admite `null`, no porque haya un camino
  // conocido. La evidencia correcta (CR/MNR-1, que corrigió la mía): `onOpenFromHistory` NO toca la
  // address —sólo `setError`/`setRem`/`setStep`—, pero al historial se llega sólo por `openHistory`, que
  // hace `await resolveSender()` antes de `setStep("history")`, y ése sí hace `setAddress`.
  it("T-339.7: `payout_submitted` SIN billetera ⇒ el texto de la wallet y NINGÚN botón de revisar", async () => {
    const { store, ventana } = ventanaDeTest();
    render(
      <TrackView
        rem={rem}
        sender={null}
        onRecovered={() => {}}
        revision={{ ventana, renovar: signerQueGraba(store) }}
      />,
    );

    expect(await screen.findByText(/Conectá la misma wallet con la que enviaste/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /revisar/i }),
      "se ofrece renovar sin billetera: no hay a quién pedirle la firma, así que es un botón que no " +
        "puede funcionar",
    ).toBeNull();
    // Y no dice "no estamos revisando": la razón es otra, y decir la equivocada manda a hacer lo que no sirve.
    expect(screen.queryByText(/No estamos revisando/)).toBeNull();
  });

  // ── T-339.4 (AC-4) · los CUATRO desenlaces de `prove()`, y ninguno culpa a quien no vio un popup ──
  //
  // 🔴 Mata a M6 (colapsar `null` con el `throw`): con 501 NUNCA se abrió un popup, así que decir "no
  // completaste la firma" es FALSO. Y mata a M7 (el estado local no vuelve de `"firmando"`): el texto
  // "Confirmá en tu billetera…" quedaría pegado después de que `prove()` resuelva.
  it("T-339.4a: éxito ⇒ el control DESAPARECE (porque `estado()` pasó a vigente, no por un flag)", async () => {
    const { store, ventana } = ventanaDeTest();
    const renovar = signerQueGraba(store);
    render(
      <TrackView
        rem={rem}
        sender={FAKE_SOLANA_BENEFICIARY}
        onRecovered={() => {}}
        revision={{ ventana, renovar }}
      />,
    );

    const btn = await screen.findByRole("button", { name: /revisar/i });
    expect(screen.getByText(/No estamos revisando/)).toBeInTheDocument();
    fireEvent.click(btn);

    await waitFor(() => expect(renovar.prove).toHaveBeenCalledWith(FAKE_SOLANA_BENEFICIARY));
    // El control se va solo, y con él el texto. Si esto no pasa, el botón queda para siempre y cada
    // toque quema un challenge de un cupo de 10 por IP.
    await waitFor(() => expect(screen.queryByRole("button", { name: /revisar/i })).toBeNull());
    expect(screen.queryByText(/No estamos revisando/)).toBeNull();
    expect(screen.queryByText(/Confirmá en tu billetera/)).toBeNull(); // M7: el texto no queda pegado
  });

  it("T-339.4b: `prove()` devuelve `null` (501) ⇒ 'es de nuestro lado' + 'no cambia el resultado', y NUNCA 'no completaste la firma'", async () => {
    const { store, ventana } = ventanaDeTest();
    void store;
    render(
      <TrackView
        rem={rem}
        sender={FAKE_SOLANA_BENEFICIARY}
        onRecovered={() => {}}
        revision={{ ventana, renovar: { prove: async () => null } }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /revisar/i }));

    expect(await screen.findByText(/es de nuestro lado/)).toBeInTheDocument();
    // 🔴 EL ASERTO QUE MATA A M6. Con 501 el mecanismo está apagado server-side: no hubo popup, no hubo
    // nada que la persona pudiera completar o rechazar.
    expect(screen.queryByText(/La firma no se completó/)).toBeNull();
    expect(screen.queryByText(/rechaz/i)).toBeNull();
    // 🔴 Y LA DISTINCIÓN CON EL 429 (AR/MNR-2): con el mecanismo apagado —que es el DEFAULT documentado—
    // reintentar NUNCA sirve, así que el copy no puede insinuar que más tarde sí. Un `"Ahora mismo"` a
    // secas lo insinuaba. Este aserto es lo que impide volver a colapsar 6b con 6.
    expect(screen.getByText(/no cambia el resultado/)).toBeInTheDocument();
    // Y el control SIGUE ahí: la ventana no se encendió, así que la salida tiene que seguir ofrecida.
    expect(screen.getByRole("button", { name: /revisar/i })).toBeEnabled();
  });

  it("T-339.4c: `throw 'pop_challenge_unavailable'` (400/5xx/**429 del cupo**) ⇒ el MISMO estado 6", async () => {
    const { store, ventana } = ventanaDeTest();
    void store;
    render(
      <TrackView
        rem={rem}
        sender={FAKE_SOLANA_BENEFICIARY}
        onRecovered={() => {}}
        revision={{
          ventana,
          renovar: {
            prove: async () => {
              throw new Error("pop_challenge_unavailable");
            },
          },
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /revisar/i }));

    // Éste es el camino del 429 cuando dos personas comparten la IP, que es el riesgo declarado de la
    // HU: el server rechazó ANTES de emitir el challenge ⇒ tampoco hubo popup.
    expect(await screen.findByText(/es de nuestro lado/)).toBeInTheDocument();
    expect(screen.queryByText(/La firma no se completó/)).toBeNull();
  });

  /** Monta el control con un `prove` que rechaza con `error`, y devuelve el DOM listo para leer. */
  async function trasUnFalloDe(error: unknown) {
    const { store, ventana } = ventanaDeTest();
    void store;
    render(
      <TrackView
        rem={rem}
        sender={FAKE_SOLANA_BENEFICIARY}
        onRecovered={() => {}}
        revision={{
          ventana,
          renovar: {
            prove: async () => {
              throw error;
            },
          },
        }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /revisar/i }));
  }

  it("T-339.4d: un error que la billetera DECLARA como suyo ⇒ 'La firma no se completó'", async () => {
    // La forma que produce producción, no una inventada: `@solana/wallet-adapter-base` etiqueta cada
    // excepción con su `name` en el constructor (MEDIDO en
    // `node_modules/@solana/wallet-adapter-base/lib/cjs/errors.js:99`). Ese `name` es lo ÚNICO
    // estructural que dice "acá hubo un popup"; el mensaje lo escribe un tercero y este repo ya declaró
    // que no está medido (`MENSAJE_FIRMA_RECHAZADA_SIN_MEDIR`, `../test-support/rpc-caido.ts:33`).
    const e = new Error("User rejected the request.");
    e.name = "WalletSignMessageError";
    await trasUnFalloDe(e);

    expect(await screen.findByText(/La firma no se completó/)).toBeInTheDocument();
    // ⛔ Y no dice "la rechazaste", aunque el mensaje de la billetera diga "rejected": ese mensaje no
    // distingue un rechazo de un fallo de la extensión, así que afirmarlo sería inventar la distinción.
    expect(screen.queryByText(/rechaz/i)).toBeNull();
    expect(screen.queryByText(/es de nuestro lado/)).toBeNull(); // no se colapsa con el estado 6
  });

  // ── 🔴 T-339.4f (AR/BLQ-MED-1) · LOS TRES INPUTS QUE LA PANTALLA LE ACHACABA A LA PERSONA ──────────
  //
  // Los tres están MEDIDOS en el árbol y los tres salían por el `else` que mandaba todo `throw` no
  // reconocido a *"La firma no se completó"*. El primero es **el input más común de una app de remesas en
  // celular**: quedarse sin red. La app le decía a la persona que SU firma falló cuando lo que se cayó
  // fue NUESTRA red.
  //
  // ⚠️ Se miden en el DOM además de en `gestoDespuesDeProve` (que tiene su propio `describe` en
  // `flow-vm.test.ts`), porque lo que el bloqueante describe es lo que la PERSONA LEE, y entre la función
  // pura y la pantalla está el `catch` del handler — que es justo donde vivía el `else`.
  it.each([
    ["sin conexión / server caído / CORS: `fetch` rechaza con un TypeError crudo", new TypeError("Failed to fetch")],
    ["el handle de firma no está montado: el bridge tira ANTES de cualquier popup", new Error("wallet_sign_not_available")],
    ["un `throw` que no es `Error`: no hay `name` ni `message` que mirar", "boom"],
  ])("T-339.4f: %s ⇒ 'es de nuestro lado', y NUNCA 'La firma no se completó'", async (_n, error) => {
    await trasUnFalloDe(error);

    expect(await screen.findByText(/es de nuestro lado/)).toBeInTheDocument();
    expect(
      screen.queryByText(/La firma no se completó/),
      "la pantalla le achaca a la persona una firma que nunca le pedimos: nunca se abrió un popup",
    ).toBeNull();
    expect(screen.queryByText(/rechaz/i)).toBeNull();
    // Y reintentar SÍ puede servir más tarde (a diferencia del 501), así que el botón sigue disponible.
    expect(screen.getByRole("button", { name: /revisar/i })).toBeEnabled();
    expect(screen.queryByText(/no cambia el resultado/)).toBeNull();
  });

  // ── 🔴 T-339.4g (AR/BLQ-MED-2) · EL TECHO DE CHALLENGES EXISTE Y ES MEDIBLE ────────────────────────
  //
  // Los dos frenos que la aritmética invocaba —el `disabled` mientras firma y que el botón desaparece al
  // renovar con éxito— NO acotan el camino de FALLO: tras un fallo el botón vuelve habilitado, no hay
  // cooldown, y el copy del estado 7 INVITA a reintentar. MEDIDO antes del arreglo: **6 toques ⇒ 6
  // challenges**, con el botón habilitado antes de cada uno.
  //
  // Y el daño no era teórico: `PAYOUT_CHALLENGE_RL` son 10 requests por "10 m" IP-only y COMPARTIDOS, y
  // con el secreto seteado el limitador corre DESPUÉS del 501 ⇒ cada toque consume un token. Un solo
  // remitente podía vaciar el cupo de su IP y tumbar el envío del vecino detrás del mismo NAT.
  it("T-339.4g: 6 toques sobre un `prove` que falla consumen SÓLO 3 challenges, y el botón queda deshabilitado", async () => {
    const { store, ventana } = ventanaDeTest();
    void store;
    const prove = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    render(
      <TrackView
        rem={rem}
        sender={FAKE_SOLANA_BENEFICIARY}
        onRecovered={() => {}}
        revision={{ ventana, renovar: { prove } }}
      />,
    );

    const btn = await screen.findByRole("button", { name: /revisar/i });

    // (1) SEIS toques uno por uno, esperando el re-render entre cada par. Es el camino que el AR midió:
    //     tras un fallo el botón vuelve habilitado y el copy invita a reintentar.
    for (let i = 0; i < 6; i += 1) {
      fireEvent.click(btn);
      await waitFor(() => expect(prove.mock.calls.length).toBeLessThanOrEqual(3));
    }
    expect(
      prove.mock.calls.length,
      "el camino de FALLO no tiene techo: cada toque es un challenge de un cupo de 10 COMPARTIDO por IP, " +
        "así que un solo remitente puede vaciar el cupo de su red y tumbar el envío del vecino",
    ).toBe(3);
    // Y la pantalla lo dice en vez de quedarse con un botón que no hace nada.
    expect(screen.getByRole("button", { name: /revisar/i })).toBeDisabled();
    // ⛔ Y la copy NO le pide remontar: eso era pedirle la acción que reiniciaba el techo, y encima
    //    mandaba a una salida que esta pantalla no tiene.
    expect(screen.getByText(/Podés recuperar tus USDC en vez de esperar/)).toBeInTheDocument();
    expect(screen.queryByText(/Volvé a abrir/)).toBeNull();
    // Y no repite verbatim la frase que `PayoutInProgress` ya pone en esta misma vista: si la copiara,
    // habría DOS nodos con el mismo texto (medido). Acá tiene que haber exactamente uno.
    expect(screen.getAllByText(/Si preferís no esperar, podés recuperar tus USDC/)).toHaveLength(1);
  });

  // ── 🔴 T-339.4j (CR/BLQ-MED-2) · EL TECHO SOBREVIVE AL REMONTE ─────────────────────────────────────
  //
  // MEDIDO por el CR sobre el código anterior: 5 toques ⇒ 3 challenges · `unmount()` · `render()` ·
  // 5 toques ⇒ **total 6**. Y el camino existe en producción, no es un montaje del test: recargar deja el
  // flujo en la pantalla de entrada (el `step` no persiste) → pestaña "Mis envíos" → la entrada → `onOpenFromHistory` ⇒
  // seguimiento montado de nuevo con el contador en 0. Y el almacén vacío por la recarga es justo el
  // estado que MUESTRA el botón. La cuenta del CR llegaba a los 10 del cupo.
  //
  // ⚠️ Lo que este `it` mide es la MITIGACIÓN, no un límite: `sessionStorage` es por pestaña y una pestaña
  // nueva lo reinicia. Está declarado así en el docblock de `leerIntentosGuardados`. El techo real por
  // remitente sigue siendo WKH-340.
  it("T-339.4j: tras `unmount()` + `render()`, el techo NO se reinicia (3 y no 6)", async () => {
    window.sessionStorage.clear();
    const { store, ventana } = ventanaDeTest();
    void store;
    const prove = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const montar = () =>
      render(
        <TrackView
          rem={rem}
          sender={FAKE_SOLANA_BENEFICIARY}
          onRecovered={() => {}}
          revision={{ ventana, renovar: { prove } }}
        />,
      );

    const primera = montar();
    const btn1 = await screen.findByRole("button", { name: /revisar/i });
    await act(async () => {
      for (let i = 0; i < 5; i += 1) fireEvent.click(btn1);
    });
    expect(prove.mock.calls.length).toBe(3);

    // El remonte, que es lo que hace una recarga + "Ver seguimiento".
    primera.unmount();
    montar();
    const btn2 = await screen.findByRole("button", { name: /revisar/i });
    await act(async () => {
      for (let i = 0; i < 5; i += 1) fireEvent.click(btn2);
    });

    expect(
      prove.mock.calls.length,
      "el techo se reinició con el remonte: recargar y volver al seguimiento vuelve a habilitar 3 " +
        "challenges, y con eso un solo remitente llega a los 10 del cupo de su IP",
    ).toBe(3);
    expect(btn2).toBeDisabled();
    window.sessionStorage.clear();
  });

  // ── 🔴 T-339.4g'' (CR/BLQ-BAJO-2) · LA RÁFAGA SÍNCRONA, que es lo que separa el `ref` del `disabled` ──
  //
  // ⚠️ ESTE `it` YO LO ESCRIBÍ, LO VI DAR 1 EN VEZ DE 3, Y CONCLUÍ QUE NO ERA TESTEABLE. Era testeable:
  // mi error fue el `await` entre clicks. `fireEvent.click` envuelve en `act()`, sí — pero **los `act()`
  // anidados no flushean: sólo el más externo**. Metiendo los 6 clicks DENTRO de un único `act()`, los 6
  // handlers corren antes de cualquier commit, que es exactamente el doble-tap real.
  //
  // MEDIDO por el CR y reproducido acá: **3 con la guarda del `ref`, 6 sin ella**. Y el `it` de arriba
  // (que espera el re-render entre toques) pasa igual sin la guarda, porque ahí el `disabled` ya se
  // aplicó ⇒ **sin este `it`, quitar el `return` temprano no lo mata nada**.
  //
  // Por qué el `ref` y no `useState`: en una ráfaga del mismo turno todas las closures ven el MISMO valor
  // viejo del estado, así que un contador en `useState` no corta. El `ref` se incrementa sincrónicamente.
  it("T-339.4g'': 6 clicks en UN solo `act()` (doble-tap) tampoco pasan de 3 challenges", async () => {
    const { store, ventana } = ventanaDeTest();
    void store;
    const prove = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    render(
      <TrackView
        rem={rem}
        sender={FAKE_SOLANA_BENEFICIARY}
        onRecovered={() => {}}
        revision={{ ventana, renovar: { prove } }}
      />,
    );
    const btn = await screen.findByRole("button", { name: /revisar/i });

    // ⛔ SIN `await` adentro: es lo que hace que los 6 handlers corran antes de cualquier re-render.
    await act(async () => {
      for (let i = 0; i < 6; i += 1) fireEvent.click(btn);
    });

    expect(
      prove.mock.calls.length,
      "una ráfaga síncrona atravesó el techo: o el contador es estado de React (todas las closures ven " +
        "el valor viejo), o la única guarda es el `disabled`, que se aplica DESPUÉS del commit",
    ).toBe(3);
  });

  // 🔴 T-339.4g' — EL TECHO CUENTA LOS ÉXITOS TAMBIÉN, no sólo los fallos.
  //
  // Es la otra mitad de BLQ-MED-2 y una propiedad distinta de la de arriba: lo que consume el cupo de la
  // IP es **la request**, no su desenlace, así que un contador que sólo mirara los fallos dejaría el
  // techo abierto por el camino feliz. Acá cada intento graba una prueba (éxito), la ventana pasa a
  // `"vigente"`, se la vence a mano y se vuelve a intentar: al cuarto ciclo ya no hay intentos.
  //
  // ⚠️ Y ES POR MONTAJE, no por sesión: remontar equivale a recargar, y una recarga ya vacía el almacén
  // de pruebas. Ese es el escape que evita que el techo deje a alguien sin salida.
  it("T-339.4g': el techo cuenta también los intentos EXITOSOS (lo que gasta el cupo es la request)", async () => {
    vi.useFakeTimers();
    try {
      const reloj = new FixedClock();
      const { store, ventana } = ventanaDeTest(reloj);
      const prove = vi.fn(async (a: string) => {
        const p = { challenge: "ch", signature: "sig" };
        store.record(a, p);
        return p;
      });
      render(
        <TrackView
          rem={rem}
          sender={FAKE_SOLANA_BENEFICIARY}
          onRecovered={() => {}}
          revision={{ ventana, renovar: { prove } }}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      // Cuatro ciclos de "renovar con éxito y dejar vencer la prueba". El cuarto no puede pedir nada.
      // ⚠️ Con fake timers hace falta avanzar el tick del control (5 s) para que la etiqueta se entere
      // del cambio de ventana; el `FixedClock` es el que decide si la prueba venció.
      for (let ciclo = 0; ciclo < 4; ciclo += 1) {
        const btn = screen.getByRole("button", { name: /revisar/i });
        if ((btn as HTMLButtonElement).disabled) break;
        await act(async () => {
          fireEvent.click(btn);
        });
        expect(screen.queryByText(/No estamos revisando/)).toBeNull(); // renovó: el bloque se fue
        // Se vence la prueba recién grabada: el bloque vuelve a aparecer y con él el botón.
        reloj.set(new Date(Date.parse(T0) + (ciclo + 1) * 9 * 60 * 1000).toISOString());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(VENTANA_CHECK_MS_EN_TEST);
        });
        expect(screen.getByText(/No estamos revisando/)).toBeInTheDocument();
      }

      expect(
        prove.mock.calls.length,
        "el techo no cuenta los intentos exitosos: lo que consume el cupo de la IP es la request, no su " +
          "desenlace, así que contar sólo los fallos deja el techo abierto por el camino feliz",
      ).toBe(3);
      expect(screen.getByRole("button", { name: /revisar/i })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── 🔴 T-339.4i (CR/BLQ-BAJO-3) · NINGÚN TEMPORIZADOR PIDE UNA FIRMA — Y EL CANDADO NO MIRA EL RELOJ ──
  //
  // 🔴 EL AGUJERO QUE CIERRA, MEDIDO POR EL CR CON TRES VARIANTES DEL MISMO MUTANTE, todas con `tsc`
  // exit 0 (`tsc` no puede impedirlo: las dos capacidades le llegan al MISMO componente en la MISMA prop):
  //     `setInterval(prove, 0)`     ⇒ 57 tests rojos
  //     `setInterval(prove, 1500)`  ⇒  1 test rojo
  //     `setInterval(prove, 60000)` ⇒  0 tests rojos   ← el invariante CENTRAL de la HU, sin guarda
  //
  // O sea que un futuro *"auto-renovar cada 5 minutos"* compilaba, pasaba la suite entera, y cada persona
  // recibía un popup que no pidió en medio de un payout. Los tests que lo cazaban sólo lo hacían porque
  // el temporizador era RÁPIDO y ensuciaba sus propias aserciones — o sea por accidente.
  //
  // ⇒ este candado es ESTÁTICO y no depende del reloj: lee el archivo y exige que ningún cuerpo de
  // `setInterval`/`setTimeout` de `flow.tsx` mencione `prove`. Es el mismo molde que los candados
  // estáticos que este repo ya usa (`readFileSync` + asertar sobre el texto).
  //
  // ⚠️ QUÉ NO CUBRE, dicho para que su verde no se lea de más: mira el TEXTO del cuerpo del temporizador,
  // así que un `setInterval(pedirFirmaIndirecta, 60000)` donde `prove` se llama dentro de esa función
  // NOMBRADA pasaría. Esa forma la cubre el `it` de abajo, que avanza el reloj falso media hora. Los dos
  // hacen falta: éste caza la forma directa a cualquier cadencia; ése caza la indirecta.
  it("T-339.4i (estático): ningún `setInterval`/`setTimeout` de flow.tsx menciona `prove`", () => {
    const src = readFileSync(path.resolve(process.cwd(), "src/presentation/flow.tsx"), "utf8");
    const sospechosos: string[] = [];
    for (const m of src.matchAll(/set(?:Interval|Timeout)\s*\(/g)) {
      // Balanceo de paréntesis desde la apertura de la llamada: es el cuerpo COMPLETO del temporizador,
      // no una ventana de N caracteres (una ventana fija se pasa de largo o se queda corta según el
      // formateo, que es justo lo que un candado no puede depender de).
      let i = (m.index ?? 0) + m[0].length;
      let nivel = 1;
      while (i < src.length && nivel > 0) {
        if (src[i] === "(") nivel += 1;
        else if (src[i] === ")") nivel -= 1;
        i += 1;
      }
      const cuerpo = src.slice(m.index ?? 0, i);
      if (/\bprove\b/.test(cuerpo)) sospechosos.push(cuerpo.slice(0, 160));
    }
    expect(
      sospechosos,
      "un temporizador de `flow.tsx` menciona `prove`: eso es un popup de billetera que la persona NO " +
        "pidió, y a una cadencia lenta NINGÚN otro test lo ve. `tsc` no puede impedirlo — las dos " +
        "capacidades llegan al mismo componente en la misma prop.",
    ).toEqual([]);
  });

  // La otra mitad: la forma INDIRECTA, que el candado estático no ve. Se avanza el reloj falso media hora
  // —360 ticks del control— sin ningún gesto, y `prove` no puede haber sido llamado ni una vez.
  it("T-339.4i': media hora de reloj sin ningún gesto ⇒ CERO llamadas a `prove`", async () => {
    vi.useFakeTimers();
    try {
      const { store, ventana } = ventanaDeTest();
      void store;
      const prove = vi.fn(async () => ({ challenge: "ch", signature: "sig" }));
      render(
        <TrackView
          rem={rem}
          sender={FAKE_SOLANA_BENEFICIARY}
          onRecovered={() => {}}
          revision={{ ventana, renovar: { prove } }}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000); // 30 min = 360 ticks de 5 s
      });
      expect(
        prove,
        "algo pidió una firma sin que la persona toque nada: el gesto es la ÚNICA fuente de un popup",
      ).not.toHaveBeenCalled();
      // Y el control sigue ofrecido: la ventana nunca se encendió porque nadie firmó.
      expect(screen.getByRole("button", { name: /revisar/i })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── 🟡 T-339.4h (AR/BLQ-BAJO-1) · EL TEXTO DE UN FALLO VIEJO NO REAPARECE ──────────────────────────
  //
  // Medido por el AR: fallo de billetera ⇒ el texto queda · otro gesto de la app graba una prueba en el
  // MISMO almacén (por ejemplo "Recuperar fondos") ⇒ el bloque desaparece · se cruza el plazo ⇒ **el
  // texto viejo VUELVE A APARECER**, dando como razón actual de que no estamos revisando un fallo de
  // firma que ya no es la razón.
  it("T-339.4h: tras un fallo, si otro gesto enciende la ventana, el texto viejo NO vuelve al vencerse", async () => {
    vi.useFakeTimers();
    try {
      const reloj = new FixedClock();
      const { store, ventana } = ventanaDeTest(reloj);
      const e = new Error("User rejected the request.");
      e.name = "WalletSignMessageError";
      render(
        <TrackView
          rem={rem}
          sender={FAKE_SOLANA_BENEFICIARY}
          onRecovered={() => {}}
          revision={{
            ventana,
            renovar: {
              prove: async () => {
                throw e;
              },
            },
          }}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      // (1) el fallo deja su texto.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /revisar/i }));
      });
      expect(screen.getByText(/La firma no se completó/)).toBeInTheDocument();

      // (2) OTRO gesto de la app graba una prueba en el MISMO almacén (es lo que hace "Recuperar fondos").
      //     El bloque desaparece porque la ventana pasó a `"vigente"`.
      store.record(FAKE_SOLANA_BENEFICIARY, { challenge: "ch-otro", signature: "sig-otro" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000); // un tick del control
      });
      expect(screen.queryByText(/La firma no se completó/)).toBeNull();

      // (3) se cruza el plazo de la prueba y el bloque vuelve. ⛔ TIENE que volver SIN el texto viejo.
      await act(async () => {
        // `FixedClock` no tiene `avanzar`: se mueve con `set`. Cruzar el TTL de 8 min es lo que hace que
        // el bloque vuelva a aparecer, que es el escenario entero de este `it`.
        //
        // ⚠️ ESTE `8 * 60 * 1000` ES UN SEGUNDO LITERAL DE `POP_PROOF_TTL_MS` (CR/MNR-4), y se declara
        // como se declaró el del tick (`VENTANA_CHECK_MS_EN_TEST`, más arriba en este archivo) en vez de
        // dejarlo suelto: la constante de producción NO se exporta
        // (`../infrastructure/auth/pop-proof-store.ts:40`), así que un test que quiera cruzar el plazo no
        // tiene de dónde importarla. Falla del lado seguro —si alguien SUBE el TTL de producción, este
        // `it` avanza de menos, el bloque no reaparece y se pone rojo— pero es un literal duplicado y hay
        // que decirlo. ⛔ Y va escrito con la MISMA FORMA que el original a propósito: el candado del TTL
        // matchea `(\d+) \* (\d+) \* (\d+)`, así que reescribirlo como `480_000` acá invitaría a
        // "unificar" el de producción y eso pone el candado rojo.
        reloj.set(new Date(Date.parse(T0) + 8 * 60 * 1000).toISOString());
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(screen.getByText(/No estamos revisando/)).toBeInTheDocument();
      expect(
        screen.queryByText(/La firma no se completó/),
        "el texto de un fallo viejo reaparece y se presenta como la razón ACTUAL de que no estemos revisando",
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── El botón `disabled` mientras firma, y el temporizador que se limpia ────────────────────────
  //
  // 🔴 Mata a M8 (el botón no se deshabilita): es uno de los DOS frenos estructurales que sostienen la
  // aritmética del cupo — un gesto = como máximo UN challenge. Sin él, N toques = N popups y N
  // challenges de un cupo de 10 por IP.
  //
  // 🔴 Y mata a M10 (el temporizador nunca se limpia): con fake timers, tras `unmount()` el contador de
  // `estado()` no puede volver a moverse. Sin el `clearInterval` del cleanup, el `setInterval` sigue
  // llamando a `peek()` —que BORRA entradas vencidas— sobre un componente desmontado.
  it("T-339.4e: `disabled` mientras firma (un gesto = un challenge), y el temporizador muere en el unmount", async () => {
    vi.useFakeTimers();
    try {
      const { store, ventana } = ventanaDeTest();
      let liberar: (() => void) | null = null;
      const enVuelo = new Promise<void>((res) => {
        liberar = res;
      });
      const renovar = {
        prove: vi.fn(async (a: string) => {
          await enVuelo; // se queda en vuelo hasta que el test lo suelte
          const p = { challenge: "ch", signature: "sig" };
          store.record(a, p);
          return p;
        }),
      };
      const { unmount } = render(
        <TrackView
          rem={rem}
          sender={FAKE_SOLANA_BENEFICIARY}
          onRecovered={() => {}}
          revision={{ ventana, renovar }}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      const btn = screen.getByRole("button", { name: /revisar/i });
      await act(async () => {
        fireEvent.click(btn);
      });

      // (1) EN VUELO: el botón está deshabilitado y el estado 3 se dice con su propio texto.
      expect(
        screen.getByRole("button", { name: /revisar/i }),
        "el botón sigue habilitado mientras la firma está en vuelo: N toques = N popups y N challenges",
      ).toBeDisabled();
      expect(screen.getByText(/Confirmá en tu billetera/)).toBeInTheDocument();
      expect(renovar.prove).toHaveBeenCalledTimes(1);

      // (2) un segundo toque no puede pedir un segundo challenge.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /revisar/i }));
      });
      expect(renovar.prove).toHaveBeenCalledTimes(1);

      // (3) se suelta la firma y el control se va solo.
      await act(async () => {
        liberar?.();
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.queryByRole("button", { name: /revisar/i })).toBeNull();

      // (4) M10: tras el unmount, el temporizador no puede seguir preguntando.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20000); // 4 ticks de 5 s
      });
      const antes = ventana.estado.mock.calls.length;
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60000); // 12 ticks más si NO se limpiara
      });
      expect(
        ventana.estado.mock.calls.length,
        "el `setInterval` sobrevivió al unmount: sigue llamando a `peek()`, que BORRA entradas vencidas, " +
          "sobre un componente que ya no existe",
      ).toBe(antes);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ═══ WKH-354 — la billetera cambió de cuenta y la app tiene que enterarse ════════════════════════
//
// ⚠️ LAS DOS COSTURAS (R-2), y no es una preferencia de diseño. El BANNER lee el bridge global
// (`useConnectedWalletAddress`), porque `useSyncExternalStore` exige un `getSnapshot` SÍNCRONO y
// `ConnectedWalletProbe.getConnectedAddress()` es `async`. El GUARD y `resolveSender` leen el puerto
// INYECTADO. En producción son el mismo adapter sobre el mismo bridge, así que todo recorrido que
// ejercite banner Y guard setea LAS DOS o está midiendo un estado que no existe. Ese es el trabajo
// de `cambiarDeCuentaA`.
describe("WKH-354 · cambiar de cuenta en la billetera sin perder el KYC", () => {
  const A = FAKE_WALLET_ADDRESS;
  const B = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8";

  /** La billetera de estos tests LEE EL BRIDGE, que es lo que hace el `SolanaWalletAdapter` real:
   *  `connect()` espera al bridge y devuelve su `publicKey`. Sin esto habria una TERCERA costura
   *  —el doble de la billetera— que hay que acordarse de mover a mano, y el gesto de AC-6, que pasa
   *  por `ConnectWallet.execute()`, adoptaria la cuenta VIEJA en el test y la nueva en produccion.
   *  Es subclase y no objeto literal porque el spread de una instancia no copia el prototipo. */
  class WalletDelBridge extends FakeWallet {
    constructor(private readonly siNoHayNadie: string = A) {
      super();
    }
    override async connect(): Promise<string> {
      return solanaWalletBridge.getState().publicKey ?? this.siNoHayNadie;
    }
    override async getAddress(): Promise<string | null> {
      return solanaWalletBridge.getState().publicKey ?? this.siNoHayNadie;
    }
  }

  /** LAS DOS COSTURAS JUNTAS. Nunca una sola. */
  function cambiarDeCuentaA(cuenta: string | null, probe: FakeConnectedWallet): void {
    act(() => {
      solanaWalletBridge.setState({ publicKey: cuenta, connected: cuenta != null });
    });
    probe.switchTo(cuenta);
  }

  afterEach(() => {
    // NO `reset()`: escribe `this.state` directo y NO notifica a los suscriptores, así que dejaría a
    // un árbol montado mostrando el valor viejo (ver el docblock de `subscribeState`).
    act(() => {
      solanaWalletBridge.setState({ publicKey: null, connected: false });
    });
  });

  // ── AC-2 · las tres puertas NO monetarias resuelven con la dirección VIVA ─────────────────────

  it("T-354-2a: el historial se pide con la cuenta VIVA, no con la que quedó cacheada", async () => {
    const probe = new FakeConnectedWallet(A);
    const repo = new InMemoryRepo();
    const c = buildTestContainer({ repo, wallet: new FakeSolanaWallet(), connectedWallet: probe });
    const spy = vi.spyOn(c.listHistory, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    // (1) primera visita: la sesión queda con `address = A`. Sin este paso no hay caché que exponer.
    irAMisEnvios();
    await waitFor(() => expect(spy).toHaveBeenCalledWith(A));
    fireEvent.click(await screen.findByRole("button", { name: /Volver/ }));

    // (2) la persona cambia de cuenta en Phantom.
    cambiarDeCuentaA(B, probe);

    // (3) misma puerta, otra vez: tiene que salir con B. Con el `address ??` de antes salía con A.
    irAMisEnvios();
    await waitFor(() => expect(spy.mock.calls.at(-1)?.[0]).toBe(B));
  });

  it("T-354-2b: la recuperación de un envío perdido sale con la cuenta VIVA", async () => {
    const probe = new FakeConnectedWallet(A);
    const refundGw = new FakeSolanaEscrowRefundGateway();
    const c = buildTestContainer({
      wallet: new FakeSolanaWallet(),
      solanaRefund: refundGw,
      connectedWallet: probe,
    });

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    // (1) 🔴 SIN ESTE PASO EL TEST NO DISCRIMINABA (AR r4 · MENOR-1). Acá el `render` era lo primero y
    // nadie conectaba antes, así que `address` seguía en `null` y NO había ninguna caché que exponer:
    // con el `address ??` viejo repuesto este test daba verde igual. Medido: el mutante M8
    // (`const addr = address ?? live ?? …` + deps `[address, c]`) mataba 2a y W12 y sobrevivía acá y
    // en 2c, o sea que las DOS puertas de recuperar plata volvían a salir con la cuenta vieja sin que
    // ningún test que hable de ellas se pusiera rojo. El pill del header es la señal de que la caché
    // quedó cargada: sólo se pinta con `address != null`.
    irAMisEnvios();
    expect(await screen.findByText(`${A.slice(0, 6)}…${A.slice(-4)}`)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Recuperar" })); // WKH-063: las dos puertas de la cadena ya no viven en `send` (adonde llevaba "Volver"): viven en el destino "Recuperar", y desde el historial se llega por la barra, que el historial SÍ pinta. Nombre exacto y no regex: /Recuperar/ matchearía también las dos puertas.

    // (2) recién ahora la persona cambia de cuenta en Phantom.
    cambiarDeCuentaA(B, probe);
    fireEvent.click(await screen.findByRole("button", { name: "Recuperar un envío perdido" }));
    fireEvent.click(await screen.findByRole("button", { name: /Buscar mis escrows/ }));

    await waitFor(() => expect(refundGw.calls).toHaveLength(1));
    expect(refundGw.calls[0]?.sender).toBe(B);
  });

  it("T-354-2c: la puerta de cuentas cerrables sale con la cuenta VIVA", async () => {
    const probe = new FakeConnectedWallet(A);
    const lister = new FakeSolanaCloseableEscrowLister([]);
    const c = buildTestContainer({
      wallet: new FakeSolanaWallet(),
      solanaCloseableEscrows: lister,
      connectedWallet: probe,
    });

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    // (1) la caché con A, por el mismo motivo que en 2b (AR r4 · MENOR-1): sin una sesión previa este
    // test pasaba con el `address ??` viejo puesto.
    irAMisEnvios();
    expect(await screen.findByText(`${A.slice(0, 6)}…${A.slice(-4)}`)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Recuperar" })); // WKH-063: las dos puertas de la cadena ya no viven en `send` (adonde llevaba "Volver"): viven en el destino "Recuperar", y desde el historial se llega por la barra, que el historial SÍ pinta. Nombre exacto y no regex: /Recuperar/ matchearía también las dos puertas.

    // (2) y recién después el cambio de cuenta.
    cambiarDeCuentaA(B, probe);
    fireEvent.click(
      await screen.findByRole("button", { name: /Recuperar el depósito de red de envíos anteriores/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Buscar envíos con cuentas abiertas/ }));

    await waitFor(() => expect(lister.calls).toHaveLength(1));
    expect(lister.calls[0]?.sender).toBe(B);
  });

  // 🔴 EL CONTROL SIN EL CUAL 2a-2c NO PRUEBAN NADA: si el doble contestara B pase lo que pase, los
  // tres pasarían igual. Acá NO se cambia de cuenta y las tres puertas tienen que salir con A.
  it("T-354-2d(control): sin cambio de cuenta, las tres puertas salen con la cuenta de siempre", async () => {
    const probe = new FakeConnectedWallet(A);
    const refundGw = new FakeSolanaEscrowRefundGateway();
    const lister = new FakeSolanaCloseableEscrowLister([]);
    const c = buildTestContainer({
      wallet: new FakeSolanaWallet(),
      solanaRefund: refundGw,
      solanaCloseableEscrows: lister,
      connectedWallet: probe,
    });
    const spy = vi.spyOn(c.listHistory, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    irAMisEnvios();
    await waitFor(() => expect(spy).toHaveBeenCalledWith(A));
    fireEvent.click(await screen.findByRole("button", { name: "Recuperar" })); // WKH-063: las dos puertas de la cadena ya no viven en `send` (adonde llevaba "Volver"): viven en el destino "Recuperar", y desde el historial se llega por la barra, que el historial SÍ pinta. Nombre exacto y no regex: /Recuperar/ matchearía también las dos puertas.

    fireEvent.click(await screen.findByRole("button", { name: "Recuperar un envío perdido" }));
    fireEvent.click(await screen.findByRole("button", { name: /Buscar mis escrows/ }));
    await waitFor(() => expect(refundGw.calls).toHaveLength(1));
    expect(refundGw.calls[0]?.sender).toBe(A);

    fireEvent.click(
      await screen.findByRole("button", { name: /Recuperar el depósito de red de envíos anteriores/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Buscar envíos con cuentas abiertas/ }));
    await waitFor(() => expect(lister.calls).toHaveLength(1));
    expect(lister.calls[0]?.sender).toBe(A);
  });

  it("T-354-2e: tras resolver con la cuenta viva, el pill del header muestra B", async () => {
    const probe = new FakeConnectedWallet(B);
    const c = buildTestContainer({ wallet: new FakeSolanaWallet(), connectedWallet: probe });

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    irAMisEnvios();

    // El `setAddress(addr)` de `resolveSender` es lo que hace que el header hable de la cuenta real.
    expect(await screen.findByText(`${B.slice(0, 6)}…${B.slice(-4)}`)).toBeInTheDocument();
  });

  // ── AC-3 · confirmar bajo otra identidad se corta ANTES de pedir ninguna firma ────────────────

  const COPY_AC3 =
    "Estás conectado con otra cuenta, distinta de la que verificamos para este envío. Cambiá en tu billetera a la cuenta con la que empezaste y tocá \"Recotizar tasa\", o usá el aviso de arriba para pasarte a la que tenés conectada ahora y empezar un envío nuevo.";

  it("T-354-3a: con la cuenta cambiada, 'Confirmar y enviar' no llama al use-case y explica por qué", async () => {
    const probe = new FakeConnectedWallet(A);
    const c = buildTestContainer({ connectedWallet: probe, wallet: new WalletDelBridge() });
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    await goToConfirm(); // la remesa queda con ownerAddress = A

    cambiarDeCuentaA(B, probe);
    fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

    // (i) la persona lee qué pasó y qué hacer.
    expect(await screen.findByText(COPY_AC3)).toBeInTheDocument();
    // (ii) 🔴 CERO llamadas: ningún challenge, ningún popup de firma condenado.
    expect(spy).toHaveBeenCalledTimes(0);
    // (iii) y la remesa NO quedó marcada como fallida: sigue confirmable.
    expect(screen.queryByText(/no pudimos preparar tu pago/i)).toBeNull();
  });

  it("T-354-3b: ejecutar la PRIMERA instrucción del copy (volver a tu cuenta) desbloquea el envío", async () => {
    const probe = new FakeConnectedWallet(A);
    const c = buildTestContainer({ connectedWallet: probe, wallet: new WalletDelBridge() });
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    await goToConfirm();
    cambiarDeCuentaA(B, probe);
    fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));
    expect(await screen.findByText(COPY_AC3)).toBeInTheDocument();

    // "Cambiá en tu billetera a la cuenta con la que empezaste" — ejecutado.
    cambiarDeCuentaA(A, probe);

    // 🔴 EL CANDADO DE CD-4, Y ES ESTE BLOQUE Y NO UN COMENTARIO. El nombre del control sale DEL
    // COPY, con un regex sobre el literal, y NO escrito a mano acá: si alguien saca el gesto de la
    // frase, o lo cambia por un control que en pantalla no existe, esto se pone rojo.
    //
    // POR QUÉ LA FRASE TIENE QUE NOMBRAR UN GESTO. Con `error` seteado, el paso `confirm` REEMPLAZA
    // "Confirmar y enviar" por "Recotizar tasa" (la rama `error ? ... : ...` de su render). Esa rama
    // es ANTERIOR a esta HU y vale para CUALQUIER error del paso, así que no se toca. Lo que sí es
    // nuestro es el copy: medido, los botones en pantalla en este punto son exactamente
    // ["¿No sos vos?", "Recotizar tasa"], o sea que una frase que dijera sólo "cambiá de cuenta"
    // estaría dando por supuesto un botón de confirmar que NO está.
    const nombrado = COPY_AC3.match(/tocá "([^"]+)"/)?.[1];
    expect(nombrado, "el copy dejó de nombrar el control que la persona tiene que tocar").toBeTruthy();
    // No hay ningún botón de confirmar acá: si lo hubiera, el copy no necesitaría nombrar nada.
    expect(screen.queryByRole("button", { name: /Confirmar y enviar/ })).toBeNull();
    // Y el control que la frase nombra EXISTE, con ese nombre accesible exacto.
    fireEvent.click(screen.getByRole("button", { name: nombrado as string }));

    // Y a partir de ahí el guard NO se pega: con la identidad de vuelta en su lugar, el envío sigue.
    fireEvent.click(await screen.findByRole("button", { name: /Confirmar y enviar/ }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(COPY_AC3)).toBeNull());
  });

  it("T-354-3c: ejecutar la SEGUNDA instrucción del copy (el aviso de arriba) empieza un envío nuevo sin borrar el KYC", async () => {
    const probe = new FakeConnectedWallet(A);
    const kycStore = new FakeKycStore();
    const c = buildTestContainer({ connectedWallet: probe, kycStore, wallet: new WalletDelBridge() });
    const forgetSpy = vi.spyOn(c.forgetKyc, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    await goToConfirm();
    cambiarDeCuentaA(B, probe);
    fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));
    expect(await screen.findByText(COPY_AC3)).toBeInTheDocument();

    // "usá el aviso de arriba para pasarte a la que tenés conectada ahora" — ejecutado.
    fireEvent.click(await screen.findByRole("button", { name: "Usar esta cuenta" }));

    // Vuelve a `send` con la cuenta nueva, y sin haber borrado nada.
    expect(await screen.findByRole("button", { name: /Continuar/ })).toBeInTheDocument();
    expect(await screen.findByText(`${B.slice(0, 6)}…${B.slice(-4)}`)).toBeInTheDocument();
    expect(forgetSpy).toHaveBeenCalledTimes(0);
  });

  it("T-354-3d(control): sin cambiar de cuenta, el mismo recorrido llega al use-case y el mensaje nunca aparece", async () => {
    const probe = new FakeConnectedWallet(A);
    const c = buildTestContainer({ connectedWallet: probe, wallet: new WalletDelBridge() });
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    await goToConfirm();
    fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(COPY_AC3)).toBeNull();
  });

  it("T-354-3e: con el probe en `null` el guard NO dispara (null es 'no hay nadie', no 'cambió')", async () => {
    // Éste es el estado del árbol que todavía no montó providers, o sea el de casi toda la suite.
    const probe = new FakeConnectedWallet(null);
    const c = buildTestContainer({ connectedWallet: probe, wallet: new WalletDelBridge() });
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    await goToConfirm();
    fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(COPY_AC3)).toBeNull();
  });

  // 🔴 T-354-3g — LA SEGUNDA INSTRUCCIÓN DEL COPY, LEÍDA EN LA VUELTA DE DIDIT (AR r4 · BLQ-BAJO-1).
  //
  // T-354-3c ya ejecuta esa instrucción, pero desde un recorrido que pasó por `onConnect`, o sea con
  // `address` puesta. El camino que NO pasa por ahí es el principal en móvil: `startKyc` navega la
  // MISMA pestaña a Didit (`window.location.href = res.url`) y, al volver, el efecto de resume hace
  // `setRem` + `setStep("confirm")` y NUNCA llama a `setAddress`. Se aterriza en `confirm` con
  // `address === null`, y `CuentaCambiada` no se pinta sin sesión (es su primera condición).
  // Resultado medido antes del arreglo: el copy aparecía, `queryByRole("button", {name: "Usar esta
  // cuenta"})` daba `null` y el único botón en pantalla era "Recotizar tasa". La frase mandaba a un
  // control que en esa pantalla no existe, que es EXACTAMENTE el defecto que WKH-352 y WKH-354
  // vinieron a cerrar, reaparecido en el camino principal.
  it("T-354-3g: volviendo de Didit (sin pasar por onConnect), el aviso que el copy nombra SÍ está", async () => {
    const probe = new FakeConnectedWallet(B);
    // `passedSnapshot` deja `ownerAddress = A`: la remesa se empezó con la cuenta vieja.
    const snapshot = passedSnapshot(1478.15, 3.7, "2099-01-01T00:00:00.000Z");
    const c = buildTestContainer({
      connectedWallet: probe,
      wallet: new WalletDelBridge(B),
      useCases: {
        resumeKyc: {
          execute: async () => ({ kind: "passed" as const, snapshot }),
        } as unknown as ResumeKyc,
      },
    });

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    cambiarDeCuentaA(B, probe); // la billetera quedó en B mientras la persona estaba en Didit

    // El resume aterriza en `confirm` sin haber pasado por `onConnect`.
    fireEvent.click(await screen.findByRole("button", { name: /Confirmar y enviar/ }));
    expect(await screen.findByText(COPY_AC3)).toBeInTheDocument();

    // Y el control que la SEGUNDA instrucción nombra existe acá también, no sólo en 3c.
    expect(await screen.findByRole("button", { name: "Usar esta cuenta" })).toBeInTheDocument();
  });

  // 🔴 T-354-3h(control) — EL CASO QUE PODÍA OBLIGAR A CAMBIAR EL COPY, Y NO LO OBLIGA.
  //
  // Tras una recarga la billetera puede NO quedar conectada, y ahí el banner tampoco se pinta (`viva`
  // es `null`). La pregunta era si eso deja el copy mandando a un aviso ausente otra vez. No: con
  // `viva == null` el guard de `onConfirm` NO dispara (CD-17, `null` es "no hay nadie" y no "cambió"),
  // así que ese copy NO ES ALCANZABLE en ese estado y no hay ninguna frase colgada que corregir. Sin
  // esta medición, la decisión entre repoblar la sesión y reescribir el copy era una opinión.
  it("T-354-3h(control): sin billetera conectada tras la recarga, el copy no aparece y el envío sigue", async () => {
    const probe = new FakeConnectedWallet(null); // nadie conectado después de volver de Didit
    const snapshot = passedSnapshot(1478.15, 3.7, "2099-01-01T00:00:00.000Z"); // ownerAddress = A
    const c = buildTestContainer({
      connectedWallet: probe,
      wallet: new WalletDelBridge(),
      useCases: {
        resumeKyc: {
          execute: async () => ({ kind: "passed" as const, snapshot }),
        } as unknown as ResumeKyc,
      },
    });
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    fireEvent.click(await screen.findByRole("button", { name: /Confirmar y enviar/ }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(COPY_AC3)).toBeNull();
    // Y el banner tampoco está, que es lo que hace que la pregunta se plantee.
    expect(screen.queryByRole("button", { name: "Usar esta cuenta" })).toBeNull();
  });

  // ── AC-4 · el KYC-once sigue funcionando después del gesto ────────────────────────────────────

  // 🔴 EL GESTO VA ADENTRO DE LOS DOS, Y NO ES COSMÉTICO (CR/MNR-1). La primera versión de este par se
  // llamaba "tras adoptar B" y "el mismo recorrido", y NINGUNO adoptaba: arrancaban sin sesión, hacían
  // `cambiarDeCuentaA(B)` y seguían derecho al envío, que es el recorrido de PRIMERA VISITA. Con eso
  // AC-4 —"el KYC-once sigue funcionando DESPUÉS del gesto"— no lo medía nadie: el gesto lo tocaban
  // T-354-6a y T-354-6e, y ninguno de los dos mira el atajo. Ahora los dos abren sesión con A (la ida
  // y vuelta al historial es lo que resuelve `address`; sin ella el banner no se pinta, T-354-6d),
  // cambian la billetera a B y tocan "Usar esta cuenta" ANTES de `fillSend()`.
  //
  // El resto del recorrido no cambia porque no puede: `onSend` manda a `connect` siempre, y el atajo
  // lo decide `onConnect` releyendo la billetera (`onConnect`, `./flow.tsx:330`), que después del
  // gesto ya devuelve B.
  //
  // ⚠️ HASTA DÓNDE LLEGA ESTE PAR, MEDIDO, para no dejarlo afirmando de más otra vez:
  //   · Sacando SÓLO el click de "Usar esta cuenta" y dejando todo lo demás ⇒ LOS DOS EN ROJO, en el
  //     assert del pill. O sea que el gesto acá se ejecuta de verdad y algo depende de él.
  //   · Sacando el click Y el assert del pill ⇒ LOS DOS EN VERDE. El atajo de KYC solo NO distingue
  //     si hubo gesto: `onConnect` relee la billetera, y el bridge ya tiene B desde
  //     `cambiarDeCuentaA`. Esto NO es un agujero del test, es el diseño que el docblock de
  //     (`adoptarCuentaConectada`, `./flow.tsx:623`) afirma —"el envío nuevo vuelve a pasar por
  //     `onConnect` entero… y no por una copia de acá"— y este par es lo que lo sostiene: si alguien
  //     duplicara ahí el atajo, la copia dejaría de coincidir con lo que estos dos miden.
  // Lo que este par SÍ cierra, y antes no lo cerraba nadie: que el recorrido gesto → envío nuevo
  // termine en `confirm` con la cuenta adoptada verificada, y en `review` cuando no lo está.
  it("T-354-4a: tras adoptar B, que YA estaba verificada, el envío nuevo salta directo a confirmar", async () => {
    const probe = new FakeConnectedWallet(A);
    const kycStore = new FakeKycStore();
    await kycStore.save(B, passKyc); // B ya se verificó alguna vez
    const c = buildTestContainer({
      connectedWallet: probe,
      kycStore,
      wallet: new WalletDelBridge(),
    });

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    irAMisEnvios();
    fireEvent.click(await screen.findByRole("button", { name: /Volver/ }));

    cambiarDeCuentaA(B, probe);
    fireEvent.click(await screen.findByRole("button", { name: "Usar esta cuenta" }));
    // El pill con B es la señal de que el gesto TERMINÓ (`setAddress` del `guard`). Sin esperarlo,
    // `busy` sigue en `true` y el botón del paso `connect` se llama "" (spinner), no "Conectar wallet".
    expect(await screen.findByText(`${B.slice(0, 6)}…${B.slice(-4)}`)).toBeInTheDocument();

    // WKH-063 fix-pack: el «Volver» del historial deja en la pantalla de entrada, no en el formulario.
    irAlFormulario();
    fillSend();
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));

    // KYC-once intacto: ni `review` ni `verify`, directo a confirmar.
    expect(await screen.findByRole("button", { name: /Confirmar y enviar/ })).toBeInTheDocument();
  });

  it("T-354-4b(control): con B SIN verificar, el mismo recorrido va a review, no a confirmar", async () => {
    const probe = new FakeConnectedWallet(A);
    const c = buildTestContainer({
      connectedWallet: probe,
      kycStore: new FakeKycStore(), // vacío: B no se verificó nunca
      wallet: new WalletDelBridge(),
    });

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    irAMisEnvios();
    fireEvent.click(await screen.findByRole("button", { name: /Volver/ }));

    cambiarDeCuentaA(B, probe);
    fireEvent.click(await screen.findByRole("button", { name: "Usar esta cuenta" }));
    // El pill con B es la señal de que el gesto TERMINÓ (`setAddress` del `guard`). Sin esperarlo,
    // `busy` sigue en `true` y el botón del paso `connect` se llama "" (spinner), no "Conectar wallet".
    expect(await screen.findByText(`${B.slice(0, 6)}…${B.slice(-4)}`)).toBeInTheDocument();

    // WKH-063 fix-pack: el «Volver» del historial deja en la pantalla de entrada, no en el formulario.
    irAlFormulario();
    fillSend();
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));

    expect(await screen.findByText(/Revisá el envío/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmar y enviar/ })).toBeNull();
  });

  // ── AC-6 · el gesto que adopta la cuenta y NO destruye nada ───────────────────────────────────

  it("T-354-6a: 'Usar esta cuenta' adopta B y deja intacto TODO lo de A (repo y store, no sólo espías)", async () => {
    const probe = new FakeConnectedWallet(A);
    const repo = new InMemoryRepo();
    const rA = Remittance.create("rem-A", beneficiary(), Money.of(400, "USDC"), T0);
    rA.attachQuote(
      {
        quoteId: "q",
        send: Money.of(400, "USDC"),
        receive: Money.of(1480, "PEN"),
        feeUsd: Money.of(0.5, "USDC"),
        rate: 3.7,
        etaMinutes: 30,
        expiresAt: QUOTE_EXPIRES,
        provenance: "fake",
      },
      T0,
    );
    rA.startKyc(T0, A); // ownerAddress = A ⇒ la entrada del historial es de A
    await repo.save(rA);
    const kycStore = new FakeKycStore();
    await kycStore.save(A, passKyc);
    const c = buildTestContainer({ repo, kycStore, connectedWallet: probe, wallet: new WalletDelBridge() });
    const forgetSpy = vi.spyOn(c.forgetKyc, "execute");
    const clearSpy = vi.spyOn(repo, "clearByOwner");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    // La sesión arranca con A (el pill aparece recién cuando `address` deja de ser null).
    irAMisEnvios();
    fireEvent.click(await screen.findByRole("button", { name: /Volver/ }));

    cambiarDeCuentaA(B, probe);

    // El banner, con su copy exacto.
    expect(await screen.findByText("Estás conectado con otra cuenta")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Tu billetera tiene activa una cuenta distinta de la que estás usando acá. Podés pasarte a ella sin perder nada: no se borra tu verificación ni tus envíos guardados, ni de esta cuenta ni de la otra.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Usar esta cuenta" }));

    // (i) el pill muestra B.
    expect(await screen.findByText(`${B.slice(0, 6)}…${B.slice(-4)}`)).toBeInTheDocument();
    // (ii) y (iii) ninguno de los dos caminos de borrado corrió.
    expect(forgetSpy).toHaveBeenCalledTimes(0);
    expect(clearSpy).toHaveBeenCalledTimes(0);
    // (iv) y (v) LO DURABLE SIGUE AHÍ. Estos dos leen el repo y el store, no cuentan espías: un
    //      borrado hecho por otro camino pasaría los dos asserts de arriba y moriría acá.
    expect(await repo.list(A)).toHaveLength(1);
    expect(await kycStore.get(A)).not.toBeNull();
  });

  it("T-354-6b(control): con la billetera en la MISMA cuenta de la sesión, el banner no está", async () => {
    const probe = new FakeConnectedWallet(A);
    const c = buildTestContainer({ connectedWallet: probe, wallet: new WalletDelBridge() });

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    irAMisEnvios();
    fireEvent.click(await screen.findByRole("button", { name: /Volver/ }));

    cambiarDeCuentaA(A, probe); // el bridge dice lo mismo que la sesión

    expect(await screen.findByText(`${A.slice(0, 6)}…${A.slice(-4)}`)).toBeInTheDocument();
    expect(screen.queryByText("Estás conectado con otra cuenta")).toBeNull();
  });

  it("T-354-6c: '¿No sos vos?' → 'Borrar igual' SIGUE borrando (los dos gestos no se degradaron)", async () => {
    const probe = new FakeConnectedWallet(A);
    const c = buildTestContainer({ connectedWallet: probe, wallet: new WalletDelBridge() });
    const forgetSpy = vi.spyOn(c.forgetKyc, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    irAMisEnvios();
    fireEvent.click(await screen.findByRole("button", { name: /Volver/ }));

    fireEvent.click(await screen.findByRole("button", { name: /¿No sos vos\?/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Borrar igual" }));

    await waitFor(() => expect(forgetSpy).toHaveBeenCalledTimes(1));
  });

  it("T-354-6d: sin sesión (nadie conectó todavía) el banner NO se pinta, aunque el bridge tenga cuenta", async () => {
    // Sin este guard el banner aparecería en la primera pantalla de cualquier persona: con
    // `autoConnect` la billetera puede tener cuenta activa antes de que nadie elija ninguna.
    // 🔴 Y ESTE TEST ES EL ÚNICO QUE LO SOSTIENE, medido: sacando `sesion == null ||` de
    // `CuentaCambiada` la suite entera da UN SOLO rojo, y es éste. Lo accionable es la unicidad, no
    // el total de la suite: el denominador que decía acá quedó viejo en dos commits. Acá además decía
    // "aparecería en el arranque de casi toda la suite", que es la frase que esa medición refuta.
    const probe = new FakeConnectedWallet(B);
    const c = buildTestContainer({ connectedWallet: probe, wallet: new WalletDelBridge() });

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    cambiarDeCuentaA(B, probe);

    expect(screen.queryByText("Estás conectado con otra cuenta")).toBeNull();
    expect(screen.queryByRole("button", { name: "Usar esta cuenta" })).toBeNull();
  });

  it("T-354-6e: con una remesa en vuelo, el banner lo dice y el gesto la descarta (CD-18)", async () => {
    const probe = new FakeConnectedWallet(A);
    const c = buildTestContainer({ connectedWallet: probe, wallet: new WalletDelBridge() });

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    await goToConfirm(); // remesa en vuelo con ownerAddress = A

    cambiarDeCuentaA(B, probe);

    expect(
      await screen.findByText("Este envío quedó a nombre de la cuenta anterior, así que empezás uno nuevo."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Usar esta cuenta" }));

    // Vuelve a `send`: no queda una remesa de A bajo la sesión B.
    expect(await screen.findByRole("button", { name: /Continuar/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmar y enviar/ })).toBeNull();
  });
});

// ── WKH-356 / AC-1 · T-062-22 — la suspensión en la pantalla ──────────────────────────────────────
//
// 🔴 QUÉ ESCENARIO ES. Firmar por enlace profundo en un celular hace que la pestaña NAVEGUE a la app
// de la billetera. `execute()` no puede resolver con una remesa —no hay ninguna todavía— ni tirar: el
// tercer desenlace es `{ estado: "hay-que-salir", irA, esperando }`, y lo único que la pantalla tiene
// que hacer con él es NAVEGAR.
//
// ⚠️ MUTANTE QUE MATA (MEDIDO en el fix-pack 1: exit=1, 1 `it` rojo, éste): ignorar la variante y caer
// al camino normal ⇒ la pantalla avanza a `track` y le
// dice a la persona que su plata está en camino SIN QUE SE HAYA FIRMADO NADA. Es el peor desenlace
// posible de este cambio, y el `as unknown as ConfirmAndSend` del doble saca el shape del alcance de
// `tsc`, así que el compilador no lo iba a atajar.
//
// ⚠️ [NO VERIFICADO] (CD-12) — esto corre en jsdom con un `location` de mentira. Que un teléfono real
// navegue a un enlace `phantom.app/ul/v1/...` y vuelva al mismo origen no lo mide este archivo.
// ⚠️ CD-15 · MUTANTE CORRIDO (2026-08-17, re-medido en el fix-pack 1 con la suite COMPLETA): neutralizar
// en `flow.tsx` la línea `if (res.estado === "hay-que-salir") { window.location.href = res.irA; return; }`
// ⇒ exit=1 y UN solo `it` rojo, éste. Restauración verificada byte a byte. Que sea UNO solo es el dato
// que importa: si esta línea se va, NADA MÁS en la suite lo nota.
it("T-062-22/AC-1: con `hay-que-salir` la pantalla NAVEGA a `irA` y no toca el estado de la remesa", async () => {
  const IR_A = "https://phantom.app/ul/v1/signTransaction?payload=abc&nonce=def";
  const container = buildTestContainer({
    kycStore: await seededKycStore(),
    useCases: {
      confirmAndSend: {
        // El doble devuelve la SUSPENSIÓN. Sin el narrowing de `flow.tsx`, `res.remesa` es `undefined`
        // y `res.remesa.snapshot` revienta — o, peor, con el shape viejo la pantalla avanzaría.
        execute: async () => ({ estado: "hay-que-salir" as const, irA: IR_A, esperando: "firma-tx" as const }),
      } as unknown as ConfirmAndSend,
    },
  });
  render(<RemittanceFlow pasoInicial="send" container={container} />);
  await goToConfirmViaKycOnce();

  // jsdom marca `location.href` como no asignable de verdad (navega); se reemplaza el objeto entero.
  const originalLocation = window.location;
  const asignado: string[] = [];
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...originalLocation,
      get href() {
        return originalLocation.href;
      },
      set href(v: string) {
        asignado.push(v);
      },
    },
  });

  try {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));
    });

    // 1. Navegó, y a la URL TAL CUAL vino: no se parsea, no se reescribe, no se le agregan parámetros.
    expect(
      asignado,
      "la pantalla no navegó a la URL de la billetera: la persona se queda mirando el botón mientras " +
        "el use-case ya dejó la remesa lista para reanudar",
    ).toEqual([IR_A]);

    // 2. Y NO avanzó a `track`: sigue en confirm. Este es el assert que mata el mutante — sin él, una
    //    pantalla que navega Y además avanza pasaría el punto 1.
    expect(
      screen.getByRole("button", { name: /Confirmar y enviar/ }),
      "la pantalla avanzó de `confirm` sin que se haya firmado nada",
    ).toBeInTheDocument();
    expect(screen.queryByText(/en camino/)).toBeNull();
    expect(screen.queryByText(/No se pudo entregar/)).toBeNull();
  } finally {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  }
});

// ═══ WKH-358 · T-065-CD11 — EL CORTE FUERA DEL CANAL, EN EL CAMINO POR ENLACE ════════════════════
//
// 🔴 QUÉ MIDE ESTO Y POR QUÉ EXISTE, dicho entero porque es lo que reemplaza a una afirmación que
// esta HU dejó de poder hacer.
//
// Hasta la ola 3, el corte contra la sustitución de depositante en el camino por enlace era
// (`DEEPLINK_SENDER_MISMATCH`, `../infrastructure/solana/deeplink/firma-por-enlace.ts:691`): el motor
// comparaba `viaje.direccion` contra el `sender`, y el `sender` salía del bridge, o sea de FUERA del
// canal del enlace. Desde que (`getAddress`, `../infrastructure/solana-wallet.ts:233`) es link-aware
// —y tiene que serlo, porque en un teléfono sin extensión el bridge está vacío— las dos mitades de esa
// comparación salen del MISMO disco y ese guard pasó a ser coherencia interna.
//
// 🔴 EL CORTE QUE SÍ ES UNA DEFENSA YA ESTABA EN EL ÁRBOL Y NO HUBO QUE ESCRIBIRLO: el cruce de
// (`live`, `./flow.tsx:506`) contra `rem.ownerAddress` (`./flow.tsx:507`), que tira
// `wallet_account_changed` (`./flow.tsx:518`). `ownerAddress` lo escribe `startKyc` en el REPO DE
// REMESAS, una fuente que el canal del enlace no puede escribir. Lo que esta HU cambió es que ese
// cruce, que en el camino por enlace comparaba `null` contra la remesa y no cortaba nunca, ahora
// recibe la dirección del enlace y CORTA. O sea: se volvió load-bearing sin una línea nueva.
//
// ⚠️ EL RESIDUAL, ESCRITO Y NO SUAVIZADO: el cruce sólo puede cortar cuando hay contra qué comparar, y
// `rem.ownerAddress == null` NO dispara (es correcto: `null` no es "cambió la identidad"). Para una
// remesa que llegara a firmar sin haber pasado por `startKyc`, un forjador del paso 1 SÍ puede
// sustituir al depositante. Qué le compra: no le compra plata —el depósito exige la firma ed25519 del
// `sender` sobre los bytes anclados, así que tendría que poner de su propia billetera— pero SÍ le
// compra un daño real: la PDA del escrow se deriva de `["escrow", sender, id16]`, así que el depósito
// queda en un escrow que la víctima no puede recuperar ni cerrar. El techo es que escribir
// `Viaje.direccion` exige ganar el paso 1, o sea llegar ANTES que la billetera real (el ancla es de
// una sola escritura) y dentro de la ventana de 20 minutos. Es el residual que las olas 1 y 2 ya
// declararon; esta HU no lo agranda ni lo cierra.
describe("WKH-358/T-065-CD11 · el cruce contra `ownerAddress` corta en el camino por enlace", () => {
  const A = FAKE_WALLET_ADDRESS; // con la que se hizo el KYC ⇒ la que queda en `rem.ownerAddress`
  const B = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8"; // la que el canal del enlace afirma

  /** Deja este navegador en el estado EXACTO del camino por enlace, con los escritores de PRODUCCIÓN
   *  y no con las claves a mano: la elección del selector, `availability === "none"` y la bandera del
   *  build (las TRES condiciones del gate; la 3ª la agregó el fix-pack) y un viaje CONECTADO cuya `direccion` es la que se le pasa. */
  function sembrarRecorridoPorEnlace(direccion: string): void {
    const almacen = almacenDeNavegador(window.localStorage);
    guardarEleccion(almacen, "phantom");
    solanaWalletBridge.setWalletAvailability("none");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true"); // la 3ª condición del gate (fix-pack · AR/BLQ-MED-1)
    guardarViaje(almacen, {
      billetera: "phantom",
      secreta: bs58.encode(new Uint8Array(32)),
      publica: bs58.encode(new Uint8Array(32)),
      claveBilletera: bs58.encode(new Uint8Array(32)),
      session: "s",
      direccion,
      paso: "conectar",
      remittanceId: "rem-de-este-test",
      desde: Date.now(),
    });
  }

  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllEnvs(); // la bandera del enlace que siembra `sembrarRecorridoPorEnlace` NO se filtra a otro archivo
    solanaWalletBridge.setWalletAvailability("unknown"); // el default del bridge
    act(() => {
      solanaWalletBridge.setState({ publicKey: null, connected: false });
    });
  });

  // MUTANTES QUE MATAN — tres sitios, y el tercero es el que prueba que esta HU volvió load-bearing al
  // cruce (los conteos van en LA BATERÍA DE MUTACIÓN, al final de
  // `../infrastructure/solana/deeplink/conexion.test.ts`, y no acá, para que no se pudran en dos lugares):
  //   (a) `flow.tsx:518` — borrar el `throw new Error("wallet_account_changed")`.
  //   (b) `solana-wallet.ts:252` — borrar la consulta a `direccionDelViajeConectado()` de
  //       `getConnectedAddress()` ⇒ el puerto contesta `null` (el bridge está vacío), el cruce no
  //       dispara y el use-case se llama igual. Ése es el estado del árbol ANTES de W2.3.
  //   (c) `flow.tsx:507` — borrar `&& rem.ownerAddress != null`. Este NO mata a este `it`: el cruce
  //       sigue cortando. ⚠️ Y ACÁ DECÍA «mata a los que miden el residual» SIN QUE EXISTIERA NINGUNO:
  //       corrido, ese mutante sobrevivía con exit=0 y 0 rojos, o sea que esta línea afirmaba una
  //       cobertura inexistente. El `it` que la da está más abajo en este archivo («el residual de
  //       CD-11: `ownerAddress == null` NO dispara el guard») y se escribió por esa medición.
  it("T-065-CD11: con `Viaje.direccion` = B y `rem.ownerAddress` = A, NO se pide ninguna firma", async () => {
    const c = buildTestContainer({
      connectedWallet: new SolanaWalletAdapter(), // 🔴 EL ADAPTADOR REAL: lo que se prueba es el CABLEADO
      wallet: new FakeWallet(), // el KYC se hace con A
    });
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    await goToConfirm(); // la remesa queda con `ownerAddress` = A

    sembrarRecorridoPorEnlace(B);

    // CD-18 — EL FIXTURE FABRICÓ EL CASO, y las dos mitades hacen falta: (i) el puerto contesta B, y
    // (ii) NO lo saca del bridge, que está vacío. Sin (ii) esto podría estar midiendo el guard viejo.
    expect(await c.connectedWallet.getConnectedAddress()).toBe(B);
    expect(
      solanaWalletBridge.getState().publicKey,
      "el bridge tiene una cuenta: este `it` ya no mide el camino por enlace",
    ).toBeNull();
    expect(B).not.toBe(A);

    fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

    // (i) la persona lee qué pasó; (ii) 🔴 CERO llamadas al use-case ⇒ ninguna firma, ningún salto.
    expect(await screen.findByText(/Estás conectado con otra cuenta/)).toBeInTheDocument();
    expect(spy, "el cruce fuera del canal no cortó: el depósito se pidió con la cuenta del enlace").toHaveBeenCalledTimes(0);
  });

  it("CONTROL: con `Viaje.direccion` = A (la misma del KYC), el recorrido llega al use-case", async () => {
    const c = buildTestContainer({
      connectedWallet: new SolanaWalletAdapter(),
      wallet: new FakeWallet(),
    });
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    await goToConfirm();

    sembrarRecorridoPorEnlace(A); // el canal del enlace afirma LA MISMA cuenta

    expect(await c.connectedWallet.getConnectedAddress()).toBe(A);
    fireEvent.click(screen.getByRole("button", { name: /Confirmar y enviar/ }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Estás conectado con otra cuenta/)).toBeNull();
  });
});

// ═══ WKH-358 · T-065-12 (AC-5 / CD-20) — el copy de la cuenta de nonce ═══════════════════════════
//
// 🔴 DOS FUENTES, Y ÉSTA ES LA DE LA DERIVACIÓN. La otra —la cadena `"0,0015"` escrita a mano— vive en
// `solana-escrow-rent.test.ts`. Con una sola, cambiar la constante movería los dos lados a la vez y la
// pantalla mostraría otro número en verde.
describe("WKH-358/T-065-12 · la tarjeta de la cuenta de nonce", () => {
  const noop = () => {};

  it("el estado `falta` dice la cifra, dice que NO vuelve, y ofrece las dos salidas", () => {
    render(
      <TarjetaDeCuentaDeNonce estado="falta" ocupado={false} onCrear={noop} onVolverAMirar={noop} onSeguirSinCrearla={noop} />,
    );
    const texto = document.body.textContent ?? "";
    // La cifra, DERIVADA de la constante (la segunda fuente la ancla a `"0,0015"` a mano).
    expect(texto).toContain(`${formatLamportsAsSol(NONCE_ACCOUNT_RENT_LAMPORTS)} SOL`);
    // 🔴 Y QUE NO VUELVE. Es la mitad del copy que AC-5 exige explícitamente.
    expect(texto).toContain("Chaski no te los devuelve con ningún botón");
    expect(screen.getByRole("button", { name: "Crear la cuenta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Seguir sin crearla" })).toBeInTheDocument();
    // ⛔ CD-16: sin em dashes en el copy que ve la persona.
    expect(texto).not.toContain("—");
    // ⛔ Y NO afirma que se movió plata: en este estado no se movió ninguna.
    expect(/se debitó|se cobró|te cobramos|se movió/i.test(texto)).toBe(false);
  });

  it("`en vuelo` no dice ni «ya está» ni «falló», y ofrece volver a mirar", () => {
    render(
      <TarjetaDeCuentaDeNonce estado="en-vuelo" ocupado={false} onCrear={noop} onVolverAMirar={noop} onSeguirSinCrearla={noop} />,
    );
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("la red todavía no la confirmó");
    expect(/ya está|falló|no se pudo/i.test(texto), "afirma un desenlace que la red no dio").toBe(false);
    expect(screen.getByRole("button", { name: "Volver a mirar" })).toBeInTheDocument();
    expect(texto).not.toContain("—");
  });

  it("`no-pudimos-preguntar` niega la PREGUNTA, no la cuenta", () => {
    render(
      <TarjetaDeCuentaDeNonce estado="no-pudimos-preguntar" ocupado={false} onCrear={noop} onVolverAMirar={noop} onSeguirSinCrearla={noop} />,
    );
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("no llegamos a preguntar");
    // 🔴 LA MITAD QUE IMPORTA: no dice que la cuenta falte. "No pude preguntar" no es "no pasó".
    expect(/no la tenés|no existe|falta una cuenta/i.test(texto)).toBe(false);
    expect(texto).not.toContain("—");
  });

  it("`existe` no muestra NINGUNA cifra: acá no se paga nada", () => {
    render(
      <TarjetaDeCuentaDeNonce estado="existe" ocupado={false} onCrear={noop} onVolverAMirar={noop} onSeguirSinCrearla={noop} />,
    );
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("Tu cuenta ya está lista");
    expect(/\d,\d{4}/.test(texto), "pidió plata en el estado en el que no se paga nada").toBe(false);
  });

  // MUTANTE QUE MATA: en `flow.tsx`, en la tarjeta, escribir `"0,0015"` como literal en vez de llamar a
  // `formatLamportsAsSol(NONCE_ACCOUNT_RENT_LAMPORTS)`. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`, que trae exit, `it` rojos y el árbol de los 54, y se re-corre con `node scripts/mutacion/bateria-065.mjs`.)
  //
  // ⚠️ POR QUÉ ESTE `it` ES TEXTUAL Y NO DE RENDER, dicho porque parece redundante con el primero: un
  // `it` de render que compare contra `formatLamportsAsSol(...)` da VERDE con el literal puesto, porque
  // hoy los dos valen `"0,0015"`. Lo que distingue una cifra derivada de una escrita a mano no es el
  // valor: es el CÓDIGO. Las tres reglas de CD-19 van aplicadas abajo.
  it("T-065-12: la cifra se DERIVA en el código, y no hay ningún literal de SOL en la tarjeta", () => {
    const fuente = readFileSync(path.resolve(process.cwd(), "src/presentation/flow.tsx"), "utf8");
    // ⚠️ EL CORTE ARRANCA EN EL DOCBLOCK Y NO EN LA FIRMA, y no es un detalle: la regla (c) de CD-19
    // exige que descontar los comentarios CAMBIE un número medido, y la única cifra con coma de este
    // bloque vive en la prosa. Cortando en la firma, el descuento no movía nada y este barrido
    // quedaba mirando otra cosa (medido: 0 y 0).
    // ⚠️ Y ARRANCA EN EL `/**`, no en la primera línea de la prosa: sin el abre-comentario adentro
    // del corte, el regex de bloque no matchea y el descuento no descuenta nada (medido: 1 y 1).
    const desde = fuente.indexOf("/**\n * WKH-358/AC-5 — LA CUENTA DE NONCE DEL REMITENTE");
    expect(desde, "no se encontró el docblock de la tarjeta en el archivo").toBeGreaterThan(0);
    const bruto = fuente.slice(desde);
    // (a) se descuentan los comentarios; el `(?<!:)` protege los `https://`.
    const cuerpo = bruto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
    // (b) el descuento no se comió el código que este barrido cree mirar.
    expect(cuerpo, "el descuento de comentarios se llevó el cuerpo de la tarjeta").toContain(
      "formatLamportsAsSol(NONCE_ACCOUNT_RENT_LAMPORTS)",
    );
    expect(cuerpo).toContain("Falta una cuenta para poder pagar desde tu billetera");
    // (c) el descuento CAMBIA una cantidad medida: los comentarios de la tarjeta SÍ nombran cifras con
    // coma. Sin esta afirmación, un descuento roto pasaría igual y nadie lo vería.
    const cifrasEnBruto = (bruto.match(/\d,\d{4}/g) ?? []).length;
    const cifrasEnCuerpo = (cuerpo.match(/\d,\d{4}/g) ?? []).length;
    expect(
      cifrasEnBruto,
      "ninguna cifra con coma aparece en los comentarios ⇒ descontarlos no cambia nada y el barrido es decorativo",
    ).toBeGreaterThan(cifrasEnCuerpo);
    // y el barrido: CERO cifras de SOL escritas a mano en el código de la tarjeta.
    expect(
      cuerpo.match(/\d,\d{4}/g) ?? [],
      "hay una cifra de SOL escrita a mano en la tarjeta: AC-5 exige que se DERIVE de la constante",
    ).toEqual([]);
  });
});

// ═══ WKH-358 · EL RESIDUAL DE T-065-CD11, CON SU PROPIO `it` ═════════════════════════════════════
//
// 🔴 POR QUÉ ESTE `it` EXISTE, Y ES UN HALLAZGO DE LA BATERÍA Y NO UN EXTRA. El comentario de
// `T-065-CD11` declaraba que el mutante «borrar `&& rem.ownerAddress != null` de `flow.tsx:507`» no
// mataba a ese `it` pero sí «a los que miden el residual». Corrido: ese mutante **no mataba a NADIE**
// (exit=0, 0 rojos). O sea que la frase afirmaba una cobertura que no existía, que es exactamente la
// clase de prosa que este repo tiene prohibida. Este `it` es la cobertura que faltaba.
//
// ⚠️ QUÉ AFIRMA, Y NO ES QUE EL RESIDUAL SEA SEGURO: afirma que `rem.ownerAddress == null` **no dispara
// el guard**, que es la mitad correcta (null no es "cambió la identidad", y acusar ahí convertiría un
// árbol todavía sin montar en una acusación falsa). El residual —que en ese caso un forjador del paso 1
// SÍ puede sustituir al depositante— sigue **abierto y declarado**, y está escrito sin suavizar en el
// bloque de CD-11 del motor. Esta HU no lo cierra.
describe("WKH-358 · el residual de CD-11: `ownerAddress == null` NO dispara el guard", () => {
  const B = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8";

  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllEnvs(); // ídem: la bandera del enlace no se filtra
    solanaWalletBridge.setWalletAvailability("unknown");
    act(() => {
      solanaWalletBridge.setState({ publicKey: null, connected: false });
    });
  });

  // MUTANTE QUE MATA: en `flow.tsx:507`, borrar `&& rem.ownerAddress != null` ⇒ `canonicalizeAddress`
  // recibe `null`, TIRA, el `catch` lo trata como desacuerdo (fail-closed) y el envío se corta sobre una
  // remesa que nunca declaró dueño. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`, que trae exit, `it` rojos y el árbol de los 54, y se re-corre con `node scripts/mutacion/bateria-065.mjs`.)
  it("con `rem.ownerAddress` en `null` y una dirección viva, el envío SIGUE", async () => {
    // La remesa llega a `confirm` SIN haber pasado por `startKyc`: es el caso que el residual describe.
    const sinDueño = { ...passedSnapshot(1478.15, 3.7, "2099-01-01T00:00:00.000Z"), ownerAddress: null };
    // CD-18 — el fixture fabricó el caso: sin esto, `passedSnapshot` deja `ownerAddress = A` y este
    // `it` mediría el camino de siempre.
    expect(sinDueño.ownerAddress, "el fixture no dejó la remesa sin dueño").toBeNull();

    const almacen = almacenDeNavegador(window.localStorage);
    guardarEleccion(almacen, "phantom");
    solanaWalletBridge.setWalletAvailability("none");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true"); // la 3ª condición del gate (fix-pack · AR/BLQ-MED-1)
    guardarViaje(almacen, {
      billetera: "phantom",
      secreta: bs58.encode(new Uint8Array(32)),
      publica: bs58.encode(new Uint8Array(32)),
      claveBilletera: bs58.encode(new Uint8Array(32)),
      session: "s",
      direccion: B,
      paso: "conectar",
      remittanceId: sinDueño.id,
      desde: Date.now(),
    });

    const c = buildTestContainer({
      connectedWallet: new SolanaWalletAdapter(),
      wallet: new WalletDelBridgeSuelto(),
      useCases: {
        resumeKyc: { execute: async () => ({ kind: "passed" as const, snapshot: sinDueño }) } as unknown as ResumeKyc,
      },
    });
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    // El puerto contesta B por el canal del enlace; la remesa no tiene con qué comparar.
    expect(await c.connectedWallet.getConnectedAddress()).toBe(B);
    fireEvent.click(await screen.findByRole("button", { name: /Confirmar y enviar/ }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText(/Estás conectado con otra cuenta/),
      "el guard acusó un cambio de identidad sobre una remesa que nunca declaró dueño",
    ).toBeNull();
  });
});

/** La billetera de este bloque: el `WalletDelBridge` de WKH-354 vive dentro de su describe. */
class WalletDelBridgeSuelto extends FakeWallet {
  override async connect(): Promise<string> {
    return solanaWalletBridge.getState().publicKey ?? FAKE_WALLET_ADDRESS;
  }
  override async getAddress(): Promise<string | null> {
    return solanaWalletBridge.getState().publicKey ?? FAKE_WALLET_ADDRESS;
  }
}
