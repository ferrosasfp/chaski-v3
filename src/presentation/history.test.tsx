// @vitest-environment jsdom
//
// El daño que estos tests fijan: `step`, `rem` y `address` son estado de React. Al recargar, el flujo
// volvía al principio y la remesa quedaba SIN NINGÚN camino desde la interfaz, con los USDC en el
// vault del escrow. El botón de recuperar vive dentro del seguimiento, y al seguimiento no se volvía.
// El dato nunca se perdió (el repo guarda por dueño) y ListHistory estaba cableado en el composition
// root desde siempre: lo que no existía era la pantalla que lo mostrara.
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HistoryView, RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { Money } from "../domain/money";
import {
  type KycVerification,
  Remittance,
  type RemittanceState,
  toPersistedIdentity,
} from "../domain/remittance";
import { ESCROW_REFUNDED_BY_SENDER } from "../application/use-cases/recover-escrow-funds";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakeSolanaEscrowRefundGateway,
  FakeSolanaWallet,
  InMemoryRepo,
  T0,
  beneficiary,
} from "../test-support/fakes";

afterEach(cleanup);

// Mismo doble que en flow.test.tsx (allá es local al archivo).
const passKyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true,
  riskLevel: "low",
  provenance: "didit",
  identity: toPersistedIdentity({
    firstName: "Ana",
    lastNamePaternal: "Quispe",
    lastNameMaternal: "Mamani",
    documentType: "DNI",
    documentNumber: "12345678",
    dateOfBirth: "1990-01-01",
    nationality: "PE",
  }),
};

/** Remesa cotizada y con dueño (`ownerAddress`, que es el scope del historial). Base de las demás. */
function quotedRemittance(id: string, expiresAt: string): Remittance {
  const r = Remittance.create(id, beneficiary(), Money.of(400, "USDC"), T0);
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
  return r;
}

/** Una remesa que YA depositó en el escrow, con el deadline vencido (refund habilitado). */
function depositedSnapshot(id: string, expiresAt = "2026-07-10T00:00:00.000Z"): RemittanceState {
  const r = quotedRemittance(id, expiresAt);
  r.applyKyc(passKyc, T0);
  r.confirm(T0);
  r.markPrincipalIn("solana-sig", T0);
  r.markPayoutSubmitted("transfi-sol-po-1", T0, "transfi");
  return r.snapshot;
}

/** Una remesa abandonada ANTES de depositar: existe, pero nunca hubo plata en juego. */
function abandonedSnapshot(id: string): RemittanceState {
  const r = quotedRemittance(id, "2026-07-10T00:00:00.000Z");
  r.applyKyc({ ...passKyc, approved: false, payoutAllowed: false }, T0);
  return r.snapshot;
}

/** Container sembrado, o sea el mundo tal como lo encuentra una persona que acaba de recargar. */
async function seededFlow(snapshots: RemittanceState[]) {
  const repo = new InMemoryRepo();
  for (const s of snapshots) await repo.save(Remittance.rehydrate(s));
  const gateway = new FakeSolanaEscrowRefundGateway();
  const container = buildTestContainer({
    repo,
    wallet: new FakeSolanaWallet(), // connect() → FAKE_SOLANA_BENEFICIARY, el dueño de las remesas
    solanaRefund: gateway,
  });
  return { repo, gateway, container };
}

// ── EL test. Es el que tiene que ponerse rojo si una remesa con fondos deja de aparecer ───────────
describe("una remesa con fondos en el escrow siempre es alcanzable desde la interfaz", () => {
  it("tras recargar, 'Ver mis envíos' la lista y desde ahí se llega a 'Recuperar fondos'", async () => {
    const { gateway, container } = await seededFlow([depositedSnapshot("rem-1")]);

    // Arranque en frío: el flujo monta en `send`, sin `rem` ni `address`. Exactamente una recarga.
    render(<RemittanceFlow container={container} />);
    expect(screen.queryByText(/Mamá/)).toBeNull();

    // (1) La remesa aparece en el historial.
    fireEvent.click(screen.getByRole("button", { name: /Ver mis envíos/ }));
    expect(await screen.findByText(/Tus envíos/)).toBeInTheDocument();
    expect(screen.getByText("Mamá")).toBeInTheDocument();

    // (2) Se puede retomar.
    fireEvent.click(await screen.findByRole("button", { name: /Ver seguimiento/ }));

    // (3) Y desde el seguimiento se llega a recuperar los fondos, que es el punto de todo esto.
    const recuperar = await screen.findByRole("button", { name: /Recuperar fondos/ });
    expect(recuperar).toBeEnabled();
    fireEvent.click(recuperar);
    await waitFor(() => expect(gateway.calls).toHaveLength(1));
    expect(gateway.calls[0]).toEqual({ remittanceId: "rem-1", sender: FAKE_SOLANA_BENEFICIARY });
  });

  it("el refund retomado desde el historial ESCRIBE el estado (sobrevive a la próxima recarga)", async () => {
    const { repo, container } = await seededFlow([depositedSnapshot("rem-1")]);
    render(<RemittanceFlow container={container} />);

    fireEvent.click(screen.getByRole("button", { name: /Ver mis envíos/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Ver seguimiento/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Recuperar fondos/ }));

    expect(await screen.findByText(/Recuperaste tus fondos/)).toBeInTheDocument();
    await waitFor(async () => expect((await repo.get("rem-1"))?.status).toBe("refunded"));
  });

  // "Enviar otra" resetea el estado y vuelve a `send`. Era el agravante: producía a propósito el
  // mismo callejón que la recarga. Ahora `send` es justamente donde está la puerta de vuelta.
  it("la puerta al historial está en `send`, que es adonde vuelven la recarga y 'Enviar otra'", async () => {
    const { container } = await seededFlow([depositedSnapshot("rem-1")]);
    render(<RemittanceFlow container={container} />);
    expect(screen.getByRole("button", { name: /Ver mis envíos/ })).toBeInTheDocument();
  });

  it("lista TODAS las remesas del dueño, no sólo la última", async () => {
    const { container } = await seededFlow([
      depositedSnapshot("rem-1"),
      depositedSnapshot("rem-2"),
      abandonedSnapshot("rem-3"),
    ]);
    render(<RemittanceFlow container={container} />);
    fireEvent.click(screen.getByRole("button", { name: /Ver mis envíos/ }));
    await screen.findByText(/Tus envíos/);
    // 2 depositadas → 2 puertas al seguimiento. La abandonada se lista sin puerta (ver abajo).
    expect(await screen.findAllByRole("button", { name: /Ver seguimiento/ })).toHaveLength(2);
  });
});

// ── Lo que la pantalla puede y no puede afirmar ───────────────────────────────────────────────────
// Este proyecto viene de arreglar dos pantallas que afirmaban cosas que nadie había comprobado. El
// historial es la tercera candidata: muestra remesas viejas y nadie leyó el vault de ninguna.
describe("el historial dice lo que sabe, y del vault no sabe nada", () => {
  const open = async (items: RemittanceState[]) => {
    render(<HistoryView items={items} onOpen={() => {}} onBack={() => {}} />);
  };

  it("de una remesa depositada dice que NO comprobamos dónde están los USDC", async () => {
    await open([depositedSnapshot("rem-1")]);
    expect(
      screen.getByText(/No comprobamos si tus USDC siguen en el escrow/),
    ).toBeInTheDocument();
  });

  it("NO afirma que los USDC volvieron cuando el refund fue del ledger (un string, no una tx)", async () => {
    const s = depositedSnapshot("rem-1");
    const ledgerRefunded: RemittanceState = {
      ...s,
      status: "refunded",
      refundTx: "refund-ledger-abc123", // lo que produce LedgerRefundGateway, sin tocar la cadena
      failureReason: "payout_amount_mismatch",
    };
    await open([ledgerRefunded]);
    expect(screen.queryByText(/volvieron a tu wallet/)).toBeNull();
    expect(screen.getByText(/No comprobamos si tus USDC siguen en el escrow/)).toBeInTheDocument();
  });

  it("afirma que volvieron SÓLO con el marcador que se escribe tras confirmar la tx", async () => {
    const s = depositedSnapshot("rem-1");
    const recovered: RemittanceState = {
      ...s,
      status: "refunded",
      refundTx: "5xRealSignature",
      failureReason: ESCROW_REFUNDED_BY_SENDER,
    };
    await open([recovered]);
    expect(screen.getByText(/Tus USDC volvieron a tu wallet/)).toBeInTheDocument();
  });

  it("una remesa sin depósito se lista pero NO ofrece seguimiento (no hay nada que seguir)", async () => {
    await open([abandonedSnapshot("rem-3")]);
    expect(screen.getByText("Mamá")).toBeInTheDocument();
    expect(screen.getByText(/No llegaste a depositar/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ver seguimiento/ })).toBeNull();
  });

  it("la lista vacía dice de dónde salía, en vez de dejar concluir que no hay remesas", async () => {
    await open([]);
    expect(screen.getByText(/No encontramos envíos guardados para esta wallet/)).toBeInTheDocument();
    expect(screen.getByText(/Si borraste los datos del navegador o entrás desde otro/)).toBeInTheDocument();
  });
});
