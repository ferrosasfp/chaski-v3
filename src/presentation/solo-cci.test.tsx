// @vitest-environment jsdom
//
// SÓLO CCI — la primera pantalla dejó de ofrecer lo que este sistema no puede entregar.
//
// Qué había, medido antes del cambio:
//   · `flow.tsx` mostraba tres botones: Yape · Plin · Banco (CCI).
//   · El valor por defecto de toda remesa nueva era `"yape"` (flow.tsx:108).
//   · `app/layout.tsx` decía, en la descripción que ve Google, "Reciben soles en su Yape".
// No existe integración de pago por Yape ni por Plin en NINGUNA capa de este repo: el agente de
// desembolso deposita a cuenta bancaria. Los dos botones y la descripción prometían un carril que
// nadie podía honrar, que es el mismo defecto que ya se corrigió en la tarjeta de agentes, en el
// sello de modo demo y en el escaneo de KYC.
//
// LO QUE ESTE ARCHIVO NO PRUEBA, y a propósito: que el backend no soporte otros métodos. Sigue
// soportándolos (`PayoutMethod` los tipa, el gateway los transporta) y sus tests siguen en
// `gateways.test.ts` / `payout/prepare/route.test.ts` con `"yape"`. Lo que cambió es qué se OFRECE.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Receipt, RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { LocalRepo } from "../infrastructure/persistence";
import { Money } from "../domain/money";
import {
  CCI_DIGITS,
  type KycVerification,
  OFFERED_PAYOUT_METHODS,
  Remittance,
  type RemittanceState,
  cciDigits,
  isValidCci,
} from "../domain/remittance";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakeSolanaWallet,
  InMemoryRepo,
  T0,
  TEST_CCI,
  beneficiary,
} from "../test-support/fakes";

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

const CCI_PLACEHOLDER = "002 193 004455667788 99";
const CONTINUAR = { name: /Continuar/ };

function renderSend(): void {
  render(<RemittanceFlow container={buildTestContainer()} />);
}
function typeRecipient(v = "Mamá"): void {
  fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), { target: { value: v } });
}
function typeDestination(v: string): void {
  fireEvent.change(screen.getByPlaceholderText(CCI_PLACEHOLDER), { target: { value: v } });
}

// ── 1. La pantalla ofrece CCI, y sólo CCI ────────────────────────────────────────────────────────

describe("la primera pantalla ofrece un único destino", () => {
  it("T-CCI-1: no hay NINGÚN control para elegir Yape ni Plin", () => {
    renderSend();
    // La pregunta que decide no es "¿aparece la palabra Yape?" (aparece: la pantalla aclara que NO
    // manda por ahí, y eso es justamente lo honesto), sino "¿puede la persona ELEGIR Yape?".
    expect(screen.queryByRole("button", { name: /Yape/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Plin/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Banco \(CCI\)/ })).toBeNull();
  });

  it("T-CCI-2: el único destino anunciado es el depósito a cuenta bancaria", () => {
    renderSend();
    expect(screen.getByText("Depósito a su cuenta bancaria en Perú")).toBeInTheDocument();
    expect(OFFERED_PAYOUT_METHODS).toEqual(["bank_cci"]);
  });

  it("T-CCI-3: la pantalla dice que no manda a Yape ni a Plin", () => {
    renderSend();
    // Frase falsable con un input concreto: es falsa el día que exista un botón de Yape (T-CCI-1)
    // o que una remesa nueva se cree con `method: "yape"` (T-CCI-6).
    expect(screen.getByText("Chaski no manda a Yape ni a Plin. Deposita a una cuenta bancaria.")).toBeInTheDocument();
  });

  it("T-CCI-4: el campo de destino pide un CCI, no un celular", () => {
    renderSend();
    expect(screen.getByText("CCI de su cuenta")).toBeInTheDocument();
    expect(screen.queryByText("Número de celular")).toBeNull();
    expect(screen.queryByPlaceholderText("999 888 777")).toBeNull();
  });
});

// ── 2. El destino valida lo que corresponde ──────────────────────────────────────────────────────

describe("el destino tiene que ser un CCI", () => {
  it("T-CCI-5: un celular de 9 dígitos NO deja continuar, y la pantalla dice por qué", () => {
    renderSend();
    typeRecipient();
    typeDestination("999888777"); // exactamente lo que la pantalla vieja aceptaba sin chistar
    expect(screen.getByRole("button", CONTINUAR)).toBeDisabled();
    expect(
      screen.getByText(
        "Un CCI tiene 20 dígitos y este tiene 9. Los espacios y los guiones no cuentan.",
      ),
    ).toBeInTheDocument();
  });

  it("T-CCI-5b: el campo vacío no muestra error (no empezado ≠ mal escrito)", () => {
    renderSend();
    typeRecipient();
    expect(screen.queryByText(/Un CCI tiene 20 dígitos/)).toBeNull();
    expect(screen.getByRole("button", CONTINUAR)).toBeDisabled();
  });

  it("T-CCI-6: 20 dígitos con espacios y guiones SÍ dejan continuar, y se guardan sin separadores", async () => {
    renderSend();
    typeRecipient();
    typeDestination("002-193 0044 5566 7788 99"); // el mismo número que TEST_CCI, como lo imprime el banco
    expect(screen.getByRole("button", CONTINUAR)).toBeEnabled();

    fireEvent.click(screen.getByRole("button", CONTINUAR));
    fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));
    await screen.findByText(/Revisá el envío/);
    // La remesa creada por la pantalla: método bancario (NO "yape") y el CCI en dígitos limpios.
    expect(screen.getByText(`cuenta bancaria · ${TEST_CCI}`)).toBeInTheDocument();
  });

  it("T-CCI-7: `isValidCci` mide largo de dígitos, no formato", () => {
    expect(CCI_DIGITS).toBe(20);
    expect(isValidCci(TEST_CCI)).toBe(true);
    expect(isValidCci("002-193 0044 5566 7788 99")).toBe(true);
    expect(isValidCci("999888777")).toBe(false);
    expect(isValidCci(`${TEST_CCI}0`)).toBe(false); // 21 dígitos tampoco es un CCI
    expect(isValidCci("")).toBe(false);
    expect(cciDigits("002-193 0044 5566 7788 99")).toBe(TEST_CCI);
  });
});

// ── 3. Las remesas YA GUARDADAS no se rompen ─────────────────────────────────────────────────────
//
// El estado vive en el localStorage de cada navegador. Sacar "yape" del tipo `PayoutMethod` no
// borra ni un byte de esos datos: sólo deja de tipar la lectura. Estos tests fijan la decisión
// tomada (el tipo sigue LEYENDO los valores viejos, la interfaz nunca los OFRECE) contra las dos
// alternativas descartadas: migrarlos al leer reescribiría una remesa que ya ocurrió, y colapsar
// `methodLabel` a "cuenta bancaria" haría que el recibo de una remesa vieja nombrara un destino
// que no fue el suyo.

const passKyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true,
  riskLevel: "low",
  provenance: "didit",
  identity: null,
};

/** Una remesa VIEJA: creada cuando la pantalla ofrecía Yape, con un celular como destino, y ya
 *  con la orden de desembolso puesta (que es cuando el seguimiento nombra el método). */
function legacyYapeSnapshot(id = "vieja-yape"): RemittanceState {
  const r = Remittance.create(id, beneficiary("yape"), Money.of(400, "USDC"), T0);
  r.attachQuote(
    {
      quoteId: "q",
      send: Money.of(400, "USDC"),
      receive: Money.of(1478.15, "PEN"),
      feeUsd: Money.of(0.5, "USDC"),
      rate: 3.7,
      etaMinutes: 30,
      expiresAt: "2100-01-01T00:00:00.000Z",
      provenance: "fake",
    },
    T0,
  );
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY); // setea ownerAddress: es el scope del historial
  r.applyKyc(passKyc, T0);
  r.confirm(T0);
  r.markPrincipalIn("solana-sig", T0);
  r.markPayoutSubmitted("transfi-po-1", T0, "transfi");
  return r.snapshot;
}

describe("una remesa guardada con un método que ya no se ofrece", () => {
  it("T-LEGACY-1: sobrevive al viaje por localStorage con su método intacto", async () => {
    window.localStorage.clear();
    // El blob EXACTO que dejó la app vieja, escrito a mano: sin pasar por el writer de hoy, porque
    // lo que se prueba es la LECTURA de algo que ya está en el disco de una persona.
    const owner = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    window.localStorage.setItem(
      "chaski.remittances.v1",
      JSON.stringify([
        {
          ...legacyYapeSnapshot("vieja-1"),
          ownerAddress: owner,
          sendUsd: { __m: [400_000_000, "USDC"] },
          quote: null,
          version: 1,
        },
      ]),
    );

    const repo = new LocalRepo();
    const items = await repo.list(owner);
    expect(items).toHaveLength(1);
    // Ni migrado ni normalizado: dice lo que dijo siempre.
    expect(items[0]?.beneficiary.method).toBe("yape");
    expect(items[0]?.beneficiary.destination).toBe("999888777");
    window.localStorage.clear();
  });

  it("T-LEGACY-2: la pantalla de historial la lista y el seguimiento la abre, sin romperse", async () => {
    // El recorrido REAL de una persona que abre la app hoy y tiene una remesa de antes: arranque en
    // frío en `send`, "Ver mis envíos", "Ver seguimiento". Es la pregunta del encargo (¿se cae el
    // historial?) contestada por la pantalla, no por el tipo.
    const repo = new InMemoryRepo();
    await repo.save(Remittance.rehydrate(legacyYapeSnapshot("vieja-1")));
    const container = buildTestContainer({ repo, wallet: new FakeSolanaWallet() });
    render(<RemittanceFlow container={container} />);

    fireEvent.click(screen.getByRole("button", { name: /Ver mis envíos/ }));
    expect(await screen.findByText(/Tus envíos/)).toBeInTheDocument();
    expect(screen.getByText("Mamá")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /Ver seguimiento/ }));
    // La nombra por lo que FUE, no por lo único que hoy se ofrece.
    expect(await screen.findByText(/Yape · 999888777/)).toBeInTheDocument();
    expect(screen.queryByText(/cuenta bancaria · 999888777/)).toBeNull();
  });

  it("T-LEGACY-3: el recibo de una remesa vieja dice Yape", () => {
    const r = Remittance.rehydrate(legacyYapeSnapshot("vieja-2"));
    r.markSettled("payout-sig", Money.of(1478.15, "PEN"), T0);
    render(<Receipt rem={r.snapshot} onNew={() => {}} />);
    expect(screen.getByText("en su Yape")).toBeInTheDocument();
  });
});

// ── 4. La descripción pública del sitio ──────────────────────────────────────────────────────────

describe("lo que Google y las vistas previas de un enlace leen del sitio", () => {
  it("T-META-1: la descripción no promete Yape y nombra el mismo destino que la pantalla", () => {
    // Se lee el fuente en vez de importar `app/layout.tsx`: ese módulo arrastra `next/font/google`
    // y `./globals.css`, que no cargan bajo vitest. Lo que importa es el literal que Next serializa
    // en el <meta>, y el literal está acá.
    const layout = readFileSync(resolve(process.cwd(), "app/layout.tsx"), "utf8");
    const description = /description:\s*\n?\s*"([^"]+)"/.exec(layout)?.[1];
    expect(description).toBe(
      "Mandá plata a tu familia en Perú con solo pedirlo. Reciben soles depositados en su cuenta bancaria.",
    );
    expect(description).not.toContain("Yape");
    expect(description).not.toContain("Plin");
  });
});
