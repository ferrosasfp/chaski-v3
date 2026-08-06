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
import { HistoryView, RemittanceFlow, ResetWarning, TrackView } from "./flow";
import { escrowFundsKnowledge, escrowKnowledgeCopy } from "./flow-vm";
import { buildTestContainer } from "../test-support/test-container";
import { Money } from "../domain/money";
import {
  type KycVerification,
  Remittance,
  type RemittanceState,
  toPersistedIdentity,
} from "../domain/remittance";
import {
  PRINCIPAL_SETTLED_REFUND_MANUAL,
  PRINCIPAL_STATE_UNKNOWN,
} from "../application/use-cases/confirm-and-send";
import { ESCROW_REFUNDED_BY_SENDER } from "../application/use-cases/recover-escrow-funds";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakeSolanaEscrowRefundGateway,
  FakeSolanaWallet,
  InMemoryRepo,
  T0,
  TEST_CCI,
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

/**
 * El estado que trajo el fix del reembolso fabricado, y que esta pantalla no conocía: el settle no
 * nos dio respuesta, se le preguntó A LA CADENA y contestó que el depósito ESTÁ en el vault. La
 * remesa queda en payout_failed (recuperable) con el marcador escrito y SIN `principalTx`, porque
 * markPrincipalIn nunca corrió. Mirando sólo `principalTx` esta remesa parece no haber depositado
 * nunca: es exactamente la que no puede desaparecer de la lista.
 */
function inEscrowSnapshot(id: string, expiresAt = "2026-07-10T00:00:00.000Z"): RemittanceState {
  const r = quotedRemittance(id, expiresAt);
  r.applyKyc(passKyc, T0);
  r.confirm(T0);
  r.markPayoutFailed(PRINCIPAL_SETTLED_REFUND_MANUAL, T0);
  return r.snapshot;
}

/**
 * La ventana del navegador cerrado en el peor momento: la persona firmó la autorización del depósito
 * y NADIE registró el desenlace. Son los hasta 15 s del timeout del settle más el broadcast. No hay
 * `principalTx` (markPrincipalIn nunca corrió) ni `failureReason`: lo único que hay es `confirmed`.
 */
function confirmedSnapshot(id: string, expiresAt = "2026-07-10T00:00:00.000Z"): RemittanceState {
  const r = quotedRemittance(id, expiresAt);
  r.applyKyc(passKyc, T0);
  r.confirm(T0);
  return r.snapshot;
}

/** El guard de destino cortó ANTES del broadcast: el depósito NO salió, y eso está probado. */
function beneficiaryMismatchSnapshot(id: string): RemittanceState {
  const r = quotedRemittance(id, "2026-07-10T00:00:00.000Z");
  r.applyKyc(passKyc, T0);
  r.confirm(T0);
  r.markPayoutFailed("solana_settle_beneficiary_mismatch", T0);
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

  // El caso que el merge trajo, y el que se pierde si la pantalla sigue mirando sólo `principalTx`:
  // acá markPrincipalIn NUNCA corrió (el settle no contestó), pero la CADENA confirmó el depósito. Si
  // esta remesa se lista como "no llegaste a depositar", pierde la puerta y con ella el único camino
  // a USDC que sabemos que están en el vault.
  it("una remesa cuyo depósito confirmó la cadena llega hasta 'Recuperar fondos'", async () => {
    const { repo, gateway, container } = await seededFlow([inEscrowSnapshot("rem-1")]);
    render(<RemittanceFlow container={container} />);

    fireEvent.click(screen.getByRole("button", { name: /Ver mis envíos/ }));
    expect(await screen.findByText(/Tus envíos/)).toBeInTheDocument();
    expect(screen.getByText("Mamá")).toBeInTheDocument();
    expect(screen.getByText(/Tus USDC quedaron en el escrow, a tu nombre/)).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /Ver seguimiento/ }));
    const recuperar = await screen.findByRole("button", { name: /Recuperar fondos/ });
    expect(recuperar).toBeEnabled();
    fireEvent.click(recuperar);
    await waitFor(() => expect(gateway.calls).toHaveLength(1));
    expect(gateway.calls[0]).toEqual({ remittanceId: "rem-1", sender: FAKE_SOLANA_BENEFICIARY });

    // Y así queda el snapshot DESPUÉS de recuperar, que es de dónde sale la trampa 3: la remesa pasa
    // a `refunded` CONSERVANDO el marcador de depósito, porque venía de payout_failed
    // (recover-escrow-funds.ts:76). Leerlo sin mirar el status le diría a esta persona que sus USDC
    // siguen en el escrow cuando acaban de volver a su wallet.
    await waitFor(async () => expect((await repo.get("rem-1"))?.status).toBe("refunded"));
    const after = (await repo.get("rem-1"))?.snapshot;
    expect(after?.failureReason).toBe(PRINCIPAL_SETTLED_REFUND_MANUAL);
    expect(after && escrowFundsKnowledge(after)).not.toBe("in-escrow");
  });

  // 🔴 EL CALLEJÓN SIN SALIDA QUE ESTA HU CIERRA. `escrowFundsKnowledge` clasifica `confirmed` como
  // `unverified` (`escrowFundsKnowledge`, `flow-vm.ts:190`), así que el historial SÍ lo listaba, SÍ decía "No comprobamos si tus
  // USDC siguen en el escrow" y SÍ ofrecía "Ver seguimiento". Del otro lado de esa puerta no había
  // ningún botón: `refundeable` no incluía `confirmed`. La persona leía que no sabíamos dónde estaba
  // su plata y no tenía cómo pedir que volviera.
  it("una remesa `confirmed` (navegador cerrado tras firmar) llega hasta 'Recuperar fondos'", async () => {
    const { repo, gateway, container } = await seededFlow([confirmedSnapshot("rem-1")]);
    render(<RemittanceFlow container={container} />);

    fireEvent.click(screen.getByRole("button", { name: /Ver mis envíos/ }));
    expect(await screen.findByText(/Tus envíos/)).toBeInTheDocument();
    // La promesa que el historial ya hacía y el seguimiento no cumplía.
    expect(screen.getByText(/No comprobamos si tus USDC siguen en el escrow/)).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /Ver seguimiento/ }));
    const recuperar = await screen.findByRole("button", { name: /Recuperar fondos/ });
    expect(recuperar).toBeEnabled();
    fireEvent.click(recuperar);
    await waitFor(() => expect(gateway.calls).toHaveLength(1));
    expect(gateway.calls[0]).toEqual({ remittanceId: "rem-1", sender: FAKE_SOLANA_BENEFICIARY });
    await waitFor(async () => expect((await repo.get("rem-1"))?.status).toBe("refunded"));
  });

  // El copy de ese estado NO se inventó: es el mismo que ya existía para `PRINCIPAL_STATE_UNKNOWN`,
  // porque la duda es la misma (no sabemos si entró) y la salida es la misma (se pide y decide la
  // cadena). Este test compara las dos pantallas: si alguien reescribe una sola, se pone rojo.
  it("el seguimiento de `confirmed` dice lo mismo que el historial y ofrece la misma salida", async () => {
    const { container } = await seededFlow([confirmedSnapshot("rem-1")]);
    render(<RemittanceFlow container={container} />);
    fireEvent.click(screen.getByRole("button", { name: /Ver mis envíos/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Ver seguimiento/ }));
    await screen.findByRole("button", { name: /Recuperar fondos/ });

    // (a) qué sabemos: la MISMA frase que el historial (vía escrowKnowledgeCopy/escrowFundsKnowledge).
    expect(
      screen.getByText(escrowKnowledgeCopy(escrowFundsKnowledge(confirmedSnapshot("x")))),
    ).toBeInTheDocument();
    // (b) qué hacer: la frase reusada del caso `principalUnknown`, sin prometer que hay fondos.
    expect(
      screen.getByText(/si están en el escrow, vuelven a tu wallet; si nunca salieron, no hay nada que devolver/),
    ).toBeInTheDocument();
  });

  // Sin wallet conectada no hay botón, y entonces el texto NO puede mandar a apretar uno que no está.
  it("sin wallet conectada, `confirmed` manda a reconectar en vez de a un botón inexistente", () => {
    render(
      <TrackView
        rem={confirmedSnapshot("rem-1")}
        recover={undefined}
        sender={null}
        onRecovered={() => {}}
      />,
    );

    expect(screen.getByText(/conectá la misma wallet con la que enviaste/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Recuperar fondos/ })).toBeNull();
    expect(screen.queryByText(/Pedí que vuelvan con el botón/)).toBeNull();
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

  // Los dos estados que trajo el fix del reembolso fabricado, en la pantalla que no los conocía.
  it("si la cadena confirmó el depósito lo DICE, en vez de decir que no comprobamos nada", async () => {
    await open([inEscrowSnapshot("rem-1")]);
    expect(screen.getByText(/Tus USDC quedaron en el escrow, a tu nombre/)).toBeInTheDocument();
    expect(screen.queryByText(/No llegaste a depositar/)).toBeNull();
  });

  it("si no pudimos averiguar si entró, lo dice con esas palabras y ofrece la puerta", async () => {
    const s = inEscrowSnapshot("rem-1");
    await open([{ ...s, failureReason: PRINCIPAL_STATE_UNKNOWN }]);
    expect(screen.getByText(/No comprobamos si tus USDC siguen en el escrow/)).toBeInTheDocument();
    expect(screen.queryByText(/No llegaste a depositar/)).toBeNull();
    expect(screen.getByRole("button", { name: /Ver seguimiento/ })).toBeInTheDocument();
  });

  // `beneficiary_mismatch` es el único reason del catálogo que describe un ataque en curso, y el guard
  // corta ANTES del broadcast: el depósito NO salió. La pantalla NO puede sugerir que sus USDC podrían
  // estar en el escrow, o manda a la persona a buscar plata que nunca se movió.
  it("un fallo probado antes del broadcast NO insinúa que haya USDC en el escrow", async () => {
    await open([beneficiaryMismatchSnapshot("rem-1")]);
    expect(screen.getByText(/No llegaste a depositar/)).toBeInTheDocument();
    expect(screen.queryByText(/en el escrow/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Ver seguimiento/ })).toBeNull();
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

// ── El botón que borra ────────────────────────────────────────────────────────────────────────────
// "¿No sos vos?" llama a ForgetKyc, que hace repo.clearByOwner: borra TODAS las remesas del dueño del
// almacenamiento local (forget-kyc.ts:25). Su copy hablaba sólo de la verificación, así que ya mentía
// por omisión. Mientras no había historial el daño era invisible; ahora se lleva puesto el único
// camino que existe hacia una remesa con USDC en el escrow.
describe("el botón que borra avisa lo que se lleva", () => {
  it("dice que borra el registro de los envíos, no sólo la verificación", () => {
    render(<ResetWarning items={[]} />);
    expect(
      screen.getByText(/borra tu verificación y el registro de tus envíos en este dispositivo/),
    ).toBeInTheDocument();
  });

  it("con USDC sin comprobar lo advierte, y habla de perder el CAMINO, nunca la plata", () => {
    render(<ResetWarning items={[depositedSnapshot("rem-1")]} />);
    expect(screen.getByText(/no comprobamos si sus USDC siguen en el escrow/)).toBeInTheDocument();
    // El límite de la advertencia: borrar el localStorage no toca el vault, y no se dice que sí.
    expect(screen.getByText(/Borrarlos no toca esa plata/)).toBeInTheDocument();
  });

  it("cuenta cuántos envíos están en esa situación", () => {
    render(
      <ResetWarning
        items={[depositedSnapshot("a"), depositedSnapshot("b"), abandonedSnapshot("c")]}
      />,
    );
    expect(screen.getByText(/Tenés 2 envíos de los que no comprobamos/)).toBeInTheDocument();
  });

  // Lo que sí comprobamos no se anuncia como "no comprobamos": sería el mismo error de esta pantalla
  // hacia el otro lado, y encima ablanda la advertencia justo en el caso más caro.
  it("lo que la cadena confirmó se advierte con su propia frase, no con la de 'no comprobamos'", () => {
    render(<ResetWarning items={[inEscrowSnapshot("a"), depositedSnapshot("b")]} />);
    expect(screen.getByText(/Tenés 1 envío con USDC en el escrow, a tu nombre/)).toBeInTheDocument();
    expect(
      screen.getByText(/Tenés 1 envío del que no comprobamos si sus USDC/),
    ).toBeInTheDocument();
  });

  it("sin nada depositado no inventa una alarma", () => {
    render(<ResetWarning items={[abandonedSnapshot("c")]} />);
    expect(screen.queryByText(/no comprobamos si sus USDC/)).toBeNull();
  });

  // Si la consulta del historial falla, callar sería degradar la advertencia en silencio.
  it("si no pudo revisar el historial lo dice, en vez de no advertir nada", () => {
    render(<ResetWarning items={null} />);
    expect(
      screen.getByText(/No pudimos revisar si tenés envíos con USDC sin comprobar/),
    ).toBeInTheDocument();
  });

  // El camino que importa, y el que deja pasar un mutante si no se testea: la persona NUNCA abrió el
  // historial. Si la advertencia se conformara con lo que ya hubiera en memoria, acá no tendría nada
  // y diría "no pudimos revisar" sobre una remesa que sí está y sí tiene USDC sin comprobar. Por eso
  // `onAskReset` consulta el historial ANTES de ofrecer el borrado.
  it("advierte aunque la persona nunca haya abierto el historial", async () => {
    // Id distinto de "rem-N" a propósito: este test SÍ crea una remesa nueva, y SeqIds emite
    // "rem-1", que chocaría con la sembrada y haría fallar el save por CAS.
    const { container } = await seededFlow([depositedSnapshot("vieja-1")]);
    render(<RemittanceFlow container={container} />);

    // send → connect (así se setea `address` sin pasar por el historial).
    fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), {
      target: { value: "Mamá" },
    });
    fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), {
      target: { value: TEST_CCI },
    });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));
    await screen.findByText(/Revisá el envío/);

    fireEvent.click(screen.getByText("¿No sos vos?"));

    expect(
      await screen.findByText(/Tenés 1 envío del que no comprobamos si sus USDC/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No pudimos revisar/)).toBeNull();
  });

  it("en el flujo real, abrir '¿No sos vos?' con una remesa depositada muestra la advertencia", async () => {
    const { container } = await seededFlow([depositedSnapshot("rem-1")]);
    render(<RemittanceFlow container={container} />);
    // Conectar para que exista address (es lo que hace visible el control del header).
    fireEvent.click(screen.getByRole("button", { name: /Ver mis envíos/ }));
    await screen.findByText(/Tus envíos/);

    fireEvent.click(screen.getByText("¿No sos vos?"));
    expect(
      await screen.findByText(/no comprobamos si sus USDC siguen en el escrow/),
    ).toBeInTheDocument();
    // Y el CTA destructivo se llama por lo que hace.
    expect(screen.getByText("Borrar igual")).toBeInTheDocument();
  });
});
