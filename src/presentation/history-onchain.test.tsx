// @vitest-environment jsdom
//
// WKH-349 — LA PANTALLA DE HISTORIAL, AHORA QUE PREGUNTA.
//
// 🔴 EL DEFECTO QUE ESTOS TESTS FIJAN, con el input que lo demostraba: dos remesas con
// `status: "principal_in"` y `principalTx` distinto, una cuya PDA `escrow_state` sigue `Deposited`
// (con USDC recuperables adentro) y otra cuya cuenta ya no existe, producían EL MISMO TEXTO en la
// tarjeta: "No comprobamos si tus USDC siguen en el escrow". Ninguna de las dos funciones que decidían
// ese texto leía la cadena. Medido contra devnet sobre la wallet del founder: de sus 13 escrows, 3
// siguen `Deposited` (32 USDC) y 10 tienen la cuenta cerrada, y la pantalla decía lo mismo de todos.
//
// 🔴 REGLA DE ESTE ARCHIVO (CD-12): cada test nombra la edición plausible que lo pone en rojo. Un test
// que no puede nombrar su mutante no es cobertura.
import { afterEach, describe, expect, it, vi } from "vitest"; // WKH-352/CR MNR-2: acá decía que `history-grupos.test.tsx` citaba la línea 41 de este archivo y que `flow-vm.test.ts` citaba la 43 y la 251. Medido con grep: grupos NO cita este archivo por número en ningún lado, y las de `flow-vm.test.ts` eran la 43-45, la 255 y la 473, nunca la 251. Dos de las tres eran falsas, que es lo que le pasa a un bookkeeping en prosa. Hoy la única cita que entra acá va anclada (ver el comentario del import de los fakes)
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HistoryView, RemittanceFlow } from "./flow";
import { statusDisplay } from "./flow-vm";
import { buildTestContainer } from "../test-support/test-container";
import { Money } from "../domain/money";
import {
  type KycVerification,
  Remittance,
  type RemittanceState,
  toPersistedIdentity,
} from "../domain/remittance";
import { PRINCIPAL_SETTLED_REFUND_MANUAL } from "../application/use-cases/confirm-and-send";
import { ESCROW_REFUNDED_BY_SENDER } from "../application/use-cases/recover-escrow-funds";
import type { EscrowChainState } from "../application/ports";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakeSolanaEscrowChainStateReader, FakeSolanaEscrowRefundGateway, // WKH-352/CR MNR-2: acá decía "va EN ESTA LÍNEA" porque tres citas sin ancla de `flow-vm.test.ts` apuntaban a este archivo por número y una línea de más las corría en silencio. Ya no: la única que queda apunta a (`escrowOutcomeDisplay`, `:41-45`) y va ANCLADA, así que si esto se corre, `citas-ancladas.test.ts` se pone rojo en vez de mentir. El amontonamiento se deja como está para no correr nada en este commit, pero ya no es lo que sostiene la cita
  FakeSolanaWallet, FakeConnectedWallet, // WKH-354/R-2: `FakeConnectedWallet` EN ESTA LÍNEA — `:41` se cita por número desde `flow-vm.test.ts` y está debajo de este bloque
  InMemoryRepo,
  T0,
  beneficiary,
} from "../test-support/fakes";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); }); // WKH-352: el unstub va EN ESTA LÍNEA (ver el comentario del import)

// SIETE de las OCHO frases de cadena (`escrowOutcomeDisplay` produce ocho desde WKH-352; la única que
// falta es `chain-pending`, que sólo se ejercita en `flow-vm.test.ts`). Van ACÁ como literales y
// no derivadas del módulo bajo prueba: un test que le pregunta al código qué copy produce y después
// verifica que produjo ese copy es un guard que se compara consigo mismo. Estas cadenas son el
// contrato con la persona.
const CP1_DEPOSITADO = "El contrato dice que tus USDC siguen en el escrow, a tu nombre.";
const CP2_DEVUELTO = "El contrato dice que tus USDC ya volvieron a tu wallet.";
const CP3_LIBERADO = "El contrato dice que tus USDC ya salieron del escrow hacia el pago.";
const CP5_NO_PUDIMOS = "No pudimos preguntarle al contrato por este envío.";
/** La ventana de release ya venció: hay plata adentro y la única puerta que queda es la devolución. */
const CP8_VENTANA_VENCIDA =
  "El contrato dice que tus USDC siguen en el escrow y que el plazo para liberarlos al pago ya venció: la salida que queda es devolverlos a tu wallet, y sólo tu firma puede hacerlo.";
/** WKH-352 · la fila `absent` que SÍ tiene la prueba local del depósito (`principalTx`). */
const CP9_ABSENT_CON_DEPOSITO = "Tu depósito entró: de eso quedó la firma de la transacción, confirmada en la cadena. Y en la dirección que le corresponde a este envío no hay ninguna cuenta: miramos esa dirección sola, no el contrato entero, y eso es todo lo que medimos. Desde acá no podemos decir si terminó en un pago o en una devolución, ni descartar que la cuenta siga abierta en otra dirección: la que miramos se calcula con la wallet conectada, así que si depositaste con otra, cambiá a esa cuenta en tu billetera y volvé a la pantalla de inicio: ahí está la opción de recuperar un envío perdido.";
/** WKH-352 · la frase AMBIGUA, la de la fila `absent` SIN prueba. Está acá para asertar que la fila con prueba NO la dice. */
const CP_ABSENT_AMBIGUO = "En el contrato no hay ninguna cuenta para este envío: o el depósito nunca entró, o ya se cerró después de resolverse. Desde acá no podemos decir cuál de las dos.";
/** La frase de ANTES de esta HU. Que desaparezca es la mitad del punto: la tarjeta no puede decir las dos. */
const COPY_VIEJO = "No comprobamos si tus USDC siguen en el escrow.";

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

function quotedRemittance(id: string): Remittance {
  const r = Remittance.create(id, beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(
    {
      quoteId: "q",
      send: Money.of(400, "USDC"),
      receive: Money.of(1478.15, "PEN"),
      feeUsd: Money.of(0.5, "USDC"),
      rate: 3.7,
      etaMinutes: 30,
      expiresAt: "2026-07-10T00:00:00.000Z",
      provenance: "didit",
    },
    T0,
  );
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  return r;
}

/** `unverified`: el depósito entró y nadie volvió a mirar el vault. Es el ÚNICO bucket que se pregunta. */
function unverifiedSnapshot(id: string): RemittanceState {
  const r = quotedRemittance(id);
  r.applyKyc(passKyc, T0);
  r.confirm(T0);
  r.markPrincipalIn("solana-sig", T0);
  r.markPayoutSubmitted("transfi-sol-po-1", T0, "transfi");
  return r.snapshot;
}

/** `in-escrow`: la cadena YA contestó y quedó escrito. No se vuelve a preguntar (AC-8). */
function inEscrowSnapshot(id: string): RemittanceState {
  const r = quotedRemittance(id);
  r.applyKyc(passKyc, T0);
  r.confirm(T0);
  r.markPayoutFailed(PRINCIPAL_SETTLED_REFUND_MANUAL, T0);
  return r.snapshot;
}

/** `returned`: el refund se confirmó y se anotó. Tampoco se pregunta (AC-8). */
function returnedSnapshot(id: string): RemittanceState {
  return {
    ...unverifiedSnapshot(id),
    status: "refunded",
    refundTx: "5xRealSignature",
    failureReason: ESCROW_REFUNDED_BY_SENDER,
  };
}

/** `no-deposit`: nunca hubo plata en juego. Ni se pregunta ni se le inventa un desenlace (AC-6). */
function noDepositSnapshot(id: string): RemittanceState {
  const r = quotedRemittance(id);
  r.applyKyc({ ...passKyc, approved: false, payoutAllowed: false }, T0);
  return r.snapshot;
}

const mapa = (entradas: Array<[string, EscrowChainState]>): ReadonlyMap<string, EscrowChainState> =>
  new Map(entradas);

/** Container sembrado, o sea el mundo tal como lo encuentra quien acaba de recargar la página. */
async function seededFlow(
  snapshots: RemittanceState[],
  reader?: FakeSolanaEscrowChainStateReader,
) {
  const repo = new InMemoryRepo();
  for (const s of snapshots) await repo.save(Remittance.rehydrate(s));
  const container = buildTestContainer({
    repo,
    wallet: new FakeSolanaWallet(), // connect() → FAKE_SOLANA_BENEFICIARY, el dueño de las remesas
    solanaEscrowStates: reader,
  });
  return { repo, container };
}

describe("WKH-349 · el historial pregunta por el bucket que no sabe, y dice qué contestó", () => {
  // 🔴 T-U1 (AC-1, AC-6, AC-8) — SE PREGUNTA POR EL COMPLEMENTO EXACTO DE LO QUE EL SNAPSHOT SABE.
  // MUTANTE: `items.map(r => r.id)` sin el filtro. Preguntaría por las cuatro filas: multiplica el
  // costo del batch y, peor, abre la puerta a que una respuesta de cadena pise un marcador local.
  // El otro mutante que mata: no preguntar por ninguna (el filtro invertido) ⇒ `calls` queda vacío.
  it("T-U1: con las 4 clases de fila, se emite UNA llamada y sólo por la fila `unverified`", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(mapa([["rem-unverified", "deposited-window-open"]]));
    render(
      <HistoryView
        items={[
          noDepositSnapshot("rem-nodeposit"),
          inEscrowSnapshot("rem-inescrow"),
          returnedSnapshot("rem-returned"),
          unverifiedSnapshot("rem-unverified"),
        ]}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );
    await waitFor(() => expect(reader.calls).toHaveLength(1));
    expect(reader.calls[0]?.remittanceIds).toEqual(["rem-unverified"]);
  });

  // 🔴 T-U2 (AC-2) — LA TARJETA DICE LO QUE LA CADENA CONTESTÓ, Y DEJA DE DECIR LO ANTERIOR.
  // MUTANTE: renderizar el copy nuevo JUNTO al viejo (un `<p>` de más en vez de reemplazar el texto).
  // La tarjeta diría "siguen en el escrow" y "no comprobamos si siguen en el escrow" a la vez. Por eso
  // el assert de que la frase de hoy DESAPARECE es parte del test y no un adorno.
  it("T-U2: `deposited` ⇒ dice que los USDC siguen en el escrow, y ya no dice que no comprobamos", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(mapa([["rem-1", "deposited-window-open"]]));
    render(
      <HistoryView
        items={[unverifiedSnapshot("rem-1")]}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );
    expect(await screen.findByText(CP1_DEPOSITADO)).toBeInTheDocument();
    expect(screen.queryByText(COPY_VIEJO)).toBeNull();
  });

  // 🔴 T-U3 (AC-2) — LA MITAD VISUAL. El desenlace con plata adentro no se lee igual que los demás.
  // MUTANTE: fijar la clase del `<p>` a la de siempre ("text-xs text-stone") e ignorar el `emphasis`.
  // El texto seguiría cambiando y la fila que TIENE plata recuperable quedaría con el mismo peso que
  // la que ya se resolvió: AC-2 pide que se distinga "visualmente y textualmente".
  it("T-U3: el párrafo de `deposited` va en font-semibold; el de `refunded` no", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(
      mapa([
        ["rem-dep", "deposited-window-open"],
        ["rem-ref", "refunded"],
      ]),
    );
    render(
      <HistoryView
        items={[unverifiedSnapshot("rem-dep"), unverifiedSnapshot("rem-ref")]}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );
    const conPlata = await screen.findByText(CP1_DEPOSITADO);
    const devuelto = await screen.findByText(CP2_DEVUELTO);
    expect(conPlata.className).toContain("font-semibold");
    expect(conPlata.className).toContain("text-cochineal-ink");
    expect(devuelto.className).not.toContain("font-semibold");
    expect(devuelto.className).toContain("text-stone");
  });

  // 🔴 T-U4 (AC-3) — LA CADENA DICE "DEVUELTO" Y EL SNAPSHOT LOCAL NO LO SABÍA.
  // MUTANTE (el que OP-2 dejó escrito): un corte en `HistoryEntry` del tipo
  // `if (answer === "refunded") return escrowKnowledgeCopy(knowledge)`. Es la edición tentadora
  // ("la cadena dice devuelto y el snapshot no lo marcó `returned`, mejor no contradecirlo").
  // T-V2 NO la ve (el view-model sigue mapeando bien) y T-U2/T-U5 tampoco (miran otras respuestas).
  // ⚠️ LO QUE ESTE TEST NO MATA SOLO: el mutante grosero de "la pantalla no cablea
  // `escrowOutcomeDisplay` para ningún caso" lo matan además T-U2, T-U5 y T-U6.
  it("T-U4: `refunded` ⇒ dice que los USDC ya volvieron, y ya no dice que no comprobamos", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(mapa([["rem-1", "refunded"]]));
    render(
      <HistoryView
        items={[unverifiedSnapshot("rem-1")]}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );
    expect(await screen.findByText(CP2_DEVUELTO)).toBeInTheDocument();
    expect(screen.queryByText(COPY_VIEJO)).toBeNull();
  });

  // 🔴 T-U5 (AC-4, CD-16 · reescrito por WKH-351/AC-1) — SON DOS HECHOS DISTINTOS Y LA TARJETA
  // MUESTRA UNO SOLO: el de la plata. Hasta WKH-351 mostraba además el Pill del trámite, y bajo el
  // encabezado del grupo eso se leía como una contradicción ("Pago en curso" bajo "Necesitan tu firma").
  // 🔴 EL MUTANTE ORIGINAL NO LO MATA ESTE TEST, Y ESTÁ MEDIDO: que el desenlace de cadena reescriba
  // la etiqueta del trámite (pintar "Entregado" porque la PDA está `Released`). Hasta WKH-351 lo mataba
  // el assert de PRESENCIA del Pill, que es justo el que esta HU dio vuelta. Con ese mutante puesto en
  // `flow.tsx:3220` este archivo queda VERDE (10 passed): el rojo lo da T-N1, mitad (c), en
  // `history-grupos.test.tsx`, que es hoy su dueño. El hecho de fondo no cambió: `Released` dice que el
  // vault salió del escrow y "Entregado" dice que el partner de payout reportó haber entregado los PEN,
  // y uno no prueba el otro.
  // 🔴 LO QUE SÍ MATA EL ASSERT DE CP3_LIBERADO: que la respuesta `released` deje de producir la frase
  // del vault en la tarjeta. T-V8 cubre ese copy en PURO, no en el render: (`escrowOutcomeDisplay`, `flow-vm.test.ts:1715`).
  // 🔴 EL MUTANTE DEL QUE ESTE TEST SÍ ES DUEÑO, MEDIDO: devolver `<Pill tone={status.tone}>{status.label}</Pill>`
  // a `HistoryEntry` (`flow.tsx:3220`) pone rojo el assert de ausencia de abajo. ⚠️ Lo que NO caza es un
  // `<span>` que pinte la etiqueta con un prefijo ("Estado: Pago en curso"): `queryAllByText` es match
  // EXACTO. Ese lo caza T-N1(c), que compara por substring sobre el `textContent` del grupo.
  // ⚠️ El assert de ausencia va SIN scope de fila a propósito: este montaje renderiza UNA sola fila y
  // nada más en `HistoryView` puede producir esa cadena. El scope por grupo lo hace T-N1 en
  // `history-grupos.test.tsx`, que sí monta 12 filas.
  it("T-U5: `released` ⇒ dice que salieron hacia el pago, y la tarjeta no muestra la etiqueta del trámite", async () => {
    const rem = unverifiedSnapshot("rem-1");
    const reader = new FakeSolanaEscrowChainStateReader(mapa([["rem-1", "released"]]));
    render(
      <HistoryView
        items={[rem]}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );
    expect(await screen.findByText(CP3_LIBERADO)).toBeInTheDocument();
    // La etiqueta se DERIVA del mismo productor que la pintaba, así que no queda un literal
    // envejeciendo acá. Y el control: si `statusDisplay` devolviera "", el assert de ausencia sería
    // verde por defecto y este test dejaría de medir nada.
    expect(screen.queryAllByText(statusDisplay(rem.status).label)).toHaveLength(0);
    expect(statusDisplay(rem.status).label).not.toBe("");
  });

  // 🔴 T-U6 (AC-5, CD-18) — UN RPC CAÍDO NO DEJA A LA PERSONA SIN PANTALLA.
  // MUTANTE: meter la consulta dentro de `openHistory`, que corre en `guard(...)`: el catch mandaría el
  // error al banner ANTES de `setStep("history")` y la persona no vería su historial. Por eso este test
  // NO renderiza `HistoryView` directo — atraviesa el flujo entero desde el botón, que es el único
  // camino por el que ese mutante se puede observar.
  it("T-U6: con la consulta rota, la pantalla se ve entera y cada fila dice que no pudimos preguntar", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(new Map(), "reject");
    const { container } = await seededFlow(
      [unverifiedSnapshot("rem-1"), unverifiedSnapshot("rem-2")],
      reader,
    );
    render(<RemittanceFlow container={container} />);
    fireEvent.click(screen.getByRole("button", { name: /Ver mis envíos/ }));

    // (1) La pantalla existe: el título, el nombre de la beneficiaria y la puerta al seguimiento.
    expect(await screen.findByText(/Tus envíos/)).toBeInTheDocument();
    expect(await screen.findAllByText("Mamá")).toHaveLength(2);
    expect(await screen.findAllByRole("button", { name: /Ver seguimiento/ })).toHaveLength(2);
    // (2) Y las DOS filas dicen que no pudimos preguntar. No una: el fallo fue de la consulta entera.
    await waitFor(async () => expect(await screen.findAllByText(CP5_NO_PUDIMOS)).toHaveLength(2));
    // (3) "No pudimos preguntar" no se colapsa con el copy de antes, que afirmaba no haber comprobado.
    expect(screen.queryByText(COPY_VIEJO)).toBeNull();
  });

  // 🔴 T-U7 (AC-7) — SE PREGUNTA POR EL DUEÑO QUE LA PANTALLA RESOLVIÓ, TAL CUAL.
  // MUTANTE: normalizar la address (lowercase) o truncarla antes de pasarla. En base58 el case es
  // significativo: una address en minúsculas deriva OTRAS PDAs, así que la respuesta sería sobre los
  // escrows de nadie y todas las filas dirían "no hay cuenta". Por eso se compara byte a byte.
  it("T-U7: el `sender` del batch es idéntico, case incluido, al que resolvió la pantalla", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(mapa([["rem-1", "deposited-window-open"]]));
    const { container } = await seededFlow([unverifiedSnapshot("rem-1")], reader);
    render(<RemittanceFlow container={container} />);
    fireEvent.click(screen.getByRole("button", { name: /Ver mis envíos/ }));

    await waitFor(() => expect(reader.calls).toHaveLength(1));
    expect(reader.calls[0]?.sender).toBe(FAKE_SOLANA_BENEFICIARY);
    // El control: la address tiene mayúsculas y minúsculas, así que una normalización se notaría.
    expect(FAKE_SOLANA_BENEFICIARY).not.toBe(FAKE_SOLANA_BENEFICIARY.toLowerCase());
  });

  // 🔴 T-U8 (AC-6, CD-3) — A LA FILA SIN DEPÓSITO NO SE LE INVENTA NINGÚN DESENLACE.
  // MUTANTE: derivar `openable` del desenlace de cadena en vez del conocimiento local. Una respuesta
  // `absent` volvería "no abrible" a una remesa que la persona sí quiere mirar; y al revés, una fila
  // que nunca depositó abriría el seguimiento optimista sobre un envío que no llegó a existir.
  it("T-U8: la fila `no-deposit` conserva su copy y sigue sin puerta al seguimiento", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(new Map());
    render(
      <HistoryView
        items={[noDepositSnapshot("rem-1")]}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );
    expect(await screen.findByText("No llegaste a depositar.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ver seguimiento/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Ver recibo/ })).toBeNull();
    // Y ni siquiera se preguntó por ella: un `Map` vacío la habría dejado en "no pudimos preguntar".
    expect(reader.calls).toHaveLength(0);
    expect(screen.queryByText(CP5_NO_PUDIMOS)).toBeNull();
  });

  // 🔴 T-U9 (AC-1) — UNA LLAMADA POR APERTURA, NO UNA POR RENDER.
  // MUTANTE: armar la lista de ids en el cuerpo del componente (sin `useMemo`) o meterla en las deps
  // del efecto como literal. Cada render daría un array nuevo, el efecto volvería a correr y el
  // historial pegaría N llamadas RPC por apertura.
  // ⚠️ `useExhaustiveDependencies` está en `warn` en `biome.jsonc`: un array de deps mal armado NO
  // rompe el build, así que este test es el único lugar donde eso se ve.
  it("T-U9: re-renderizar con la misma lista no vuelve a preguntar", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(mapa([["rem-1", "deposited-window-open"]]));
    const items = [unverifiedSnapshot("rem-1")];
    const vista = (
      <HistoryView
        items={items}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader}
        sender={FAKE_SOLANA_BENEFICIARY}
      />
    );
    const { rerender } = render(vista);
    await waitFor(() => expect(reader.calls).toHaveLength(1));
    rerender(vista);
    rerender(vista);
    await screen.findByText(CP1_DEPOSITADO);
    expect(reader.calls).toHaveLength(1);
  });

  // 🔴 T-U10 (AC-11) — LA FILA CON LA VENTANA VENCIDA DICE POR QUÉ PUERTA SALE.
  // El caso REAL que lo motivó: al 2026-08-13 los tres escrows que le quedaban `Deposited` al founder
  // tenían el plazo vencido (deadlines del 11-ago), así que su única salida era la devolución que
  // firma el remitente. Con el desenlace único de antes, esas tres filas leían exactamente igual que
  // una con la ventana abierta.
  // MUTANTE (a) — EL CABLEADO INCOMPLETO: si el view-model no ramifica el valor nuevo, cae en el
  // `return "chain-unknown"` final de `escrowOutcome` y la fila diría "No pudimos preguntarle al
  // contrato" sobre una fila que SÍ contestó. El assert de que CP5 NO aparece es el que lo caza; sin
  // él, este test pasa igual.
  // MUTANTE (b): dibujar CP-8 JUNTO a CP-1 (un `<p>` de más en vez de reemplazar el texto), que es lo
  // que caza el assert de que CP1 no aparece.
  it("T-U10: `deposited-window-closed` ⇒ dice que el plazo venció y que queda la devolución, en negrita", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(mapa([["rem-1", "deposited-window-closed"]]));
    render(
      <HistoryView
        items={[unverifiedSnapshot("rem-1")]}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );

    const vencida = await screen.findByText(CP8_VENTANA_VENCIDA);
    expect(vencida).toBeInTheDocument();
    // Ni la frase de la ventana abierta, ni la de antes de esta HU, ni la de "no pudimos preguntar".
    expect(screen.queryByText(CP1_DEPOSITADO)).toBeNull();
    expect(screen.queryByText(COPY_VIEJO)).toBeNull();
    expect(screen.queryByText(CP5_NO_PUDIMOS)).toBeNull();
    // Sigue pesando `strong`: hay plata adentro, igual que en la fila con la ventana abierta.
    expect(vencida.className).toContain("font-semibold");
    expect(vencida.className).toContain("text-cochineal-ink");
  });

  /** WKH-352 · el gemelo de `unverifiedSnapshot` SIN la prueba del depósito: se firmó la autorización y
   *  nunca se registró el desenlace. Cae en `unverified` por `status: "confirmed"`, así que se le
   *  pregunta a la cadena igual, pero `principalTx` es `null`. Es el control de T-W7(b): el montaje
   *  IDÉNTICO salvo por el único dato que decide la frase. */
  function sinPruebaSnapshot(id: string): RemittanceState {
    const r = quotedRemittance(id);
    r.applyKyc(passKyc, T0);
    r.confirm(T0);
    return r.snapshot;
  }

  // 🔴 T-W6 (WKH-352 / AC-1) — LA FILA QUE YA TIENE LA PRUEBA DEL DEPÓSITO DEJA DE LEERSE COMO LAS OTRAS.
  // `unverifiedSnapshot` llama (`markPrincipalIn`, `:101`), o sea que ESTE fixture ya es el de AC-1:
  // no hace falta inventar ninguno. La cadena contesta `absent` y la fila, en vez de la disyunción,
  // dice que el depósito entró y que no se puede saber cómo terminó.
  // MUTANTE (a) MEDIDO — NO RAMIFICAR: volver `flow-vm.ts:1205` a `return "chain-absent";`. Medido:
  // T-W6 y T-W7 rojos (los dos esperan el copy nuevo en el DOM).
  // MUTANTE (b) MEDIDO — DIBUJAR LAS DOS: un `<p>` de más en `flow.tsx:3230` con
  // `escrowOutcomeDisplay("chain-absent").copy`, o sea el copy nuevo JUNTO al viejo en vez de
  // reemplazarlo. Medido: SÓLO T-W6 rojo, y sólo por el `queryByText(...)` `toBeNull()` de abajo. Por
  // eso el assert de ausencia es parte del test y no un adorno: sin él, ese mutante pasa entero y la
  // tarjeta queda diciendo "tu depósito entró" y "o el depósito nunca entró" a la vez.
  // QUÉ NO CUBRE (CD-14): no mide el grupo bajo el que cae la fila. Eso es T-W8, en `history-grupos`.
  it("T-W6: `absent` + `principalTx` ⇒ la tarjeta dice que el depósito entró, y no la disyunción", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(mapa([["rem-1", "absent"]]));
    render(
      <HistoryView
        items={[unverifiedSnapshot("rem-1")]}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );

    expect(await screen.findByText(CP9_ABSENT_CON_DEPOSITO)).toBeInTheDocument();
    // Y NINGUNA de las dos frases que esta fila decía antes sigue en la tarjeta.
    expect(screen.queryByText(CP_ABSENT_AMBIGUO)).toBeNull();
    expect(screen.queryByText(COPY_VIEJO)).toBeNull();
    // Tampoco "no pudimos preguntar": la cadena SÍ contestó, y clarísimo.
    expect(screen.queryByText(CP5_NO_PUDIMOS)).toBeNull();
  });

  // 🔴 T-W7 (WKH-352 / AC-3, CD-4) — EL CANDADO MECÁNICO: LA FRASE NUEVA NO CUESTA NI UNA LLAMADA.
  // Toda la HU es presentación sobre datos YA cargados. El mutante que existe para ser cazado acá es el
  // tentador: resolver la ambigüedad de verdad, con `getSignaturesForAddress` sobre la PDA, o pedir
  // cualquier dato extra al abrir el historial. Eso es UNA llamada POR FILA (no se batchea), está
  // costeado en `ports.ts:1065-1088` (R-1) y está DIFERIDO, no descartado (AC-6).
  // Dos mitades, las dos obligatorias: (a) un `fetch` que tira ante cualquier invocación, y (b) que
  // `calls` del reader no se mueva entre un montaje CON prueba y uno SIN prueba.
  // MUTANTE MEDIDO: en `HistoryEntry` (`flow.tsx:3205`), agregar
  // `if (escrowOutcome(rem, answer) === "chain-absent-after-deposit") void fetch("/api/solana/signatures");`
  // Medido: sólo este test se pone rojo, y con el mensaje del doble ("fetch_prohibido_en_esta_pantalla"),
  // que es la prueba de que lo que falló fue el candado y no otra cosa.
  // QUÉ NO CUBRE (CD-14): prueba que ESTA pantalla no emite llamadas nuevas. NO prueba que ningún otro
  // punto de la app lo haga, ni cubre un transporte que no sea `fetch` ni el reader inyectado.
  it("T-W7: producir la frase nueva no emite NINGUNA llamada extra", async () => {
    // (a) El doble que tira ante cualquier invocación.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fetch_prohibido_en_esta_pantalla");
      }),
    );
    // EL ASSERT DE CONTROL, que NO es opcional: sin él este test pasa igual aunque el doble esté mal
    // puesto (un `stubGlobal` que no llegó a aplicarse, o un nombre mal escrito) y quedaría verde POR
    // AUSENCIA, que es como un guard deja de existir. Misma disciplina que T-V7
    // en (`VERBOS`, `flow-vm.test.ts:1704-1707`) y que `evm-residue-guard.static.test.ts:40-43`.
    expect(() => (globalThis.fetch as unknown as () => void)()).toThrow(
      "fetch_prohibido_en_esta_pantalla",
    );

    // (b) Dos montajes IDÉNTICOS salvo por `principalTx`: el de arriba produce la frase nueva, el de
    // abajo la ambigua. Si producir la frase nueva costara una consulta, `calls` sería distinto.
    const readerConPrueba = new FakeSolanaEscrowChainStateReader(mapa([["rem-1", "absent"]]));
    render(
      <HistoryView
        items={[unverifiedSnapshot("rem-1")]}
        onOpen={() => {}}
        onBack={() => {}}
        reader={readerConPrueba}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );
    expect(await screen.findByText(CP9_ABSENT_CON_DEPOSITO)).toBeInTheDocument();
    cleanup();

    const readerSinPrueba = new FakeSolanaEscrowChainStateReader(mapa([["rem-1", "absent"]]));
    render(
      <HistoryView
        items={[sinPruebaSnapshot("rem-1")]}
        onOpen={() => {}}
        onBack={() => {}}
        reader={readerSinPrueba}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );
    expect(await screen.findByText(CP_ABSENT_AMBIGUO)).toBeInTheDocument();

    // Mismo largo y mismos ids: la fila con prueba no pidió nada que la otra no pidiera.
    expect(readerConPrueba.calls).toHaveLength(1);
    expect(readerSinPrueba.calls).toHaveLength(1);
    expect(readerConPrueba.calls[0]?.remittanceIds).toEqual(readerSinPrueba.calls[0]?.remittanceIds);
    expect(readerConPrueba.calls[0]?.remittanceIds).toEqual(["rem-1"]);
  });
});

/**
 * WKH-352 · AR r3 / BLQ-MED-1 — EL CONSEJO DEL COPY, EJECUTADO DE PUNTA A PUNTA.
 * WKH-354 · AC-7 — reescrito, porque la HU eliminó la mitad del consejo.
 *
 * 🔴 POR QUÉ ESTE BLOQUE EXISTE, y es lo primero que hay que leer. La frase de
 * `chain-absent-after-deposit` termina mandando a la persona a una puerta concreta, y tres rondas de
 * AR seguidas rechazaron ESA frase por prometer algo que el código no entregaba. Las tres se
 * "arreglaron" reescribiendo el texto, y la cuarta versión volvió a fallar por lo mismo. Un texto no
 * se puede medir a sí mismo: lo único que cierra el hallazgo es un test que EJECUTE el consejo y
 * falle si el consejo no funciona. Eso es lo que hay acá abajo.
 *
 * 🔴 EL DEFECTO QUE LO MOTIVÓ, Y QUE YA NO EXISTE. El copy decía "conectá esa y usá la opción de
 * recuperar un envío perdido", y en la sesión donde se leía eso era imposible: `address` es un
 * `useState` y `resolveSender` devolvía el valor local si ya lo tenía, así que no volvía a
 * preguntarle a la billetera; y esta tarjeta SÓLO se puede ver con `address != null`. La condición
 * que hacía visible el consejo era la misma que lo volvía inaplicable, y por eso el copy pasó a
 * mandar a una REAPERTURA de la app. WKH-354 cerró el defecto de raíz: `resolveSender` le pregunta
 * al puerto `connectedWallet`, o sea a la billetera VIVA, en cada una de las tres puertas. Con eso,
 * la reapertura dejó de hacer falta y el copy dejó de pedirla.
 *
 * QUÉ CAMBIÓ EN ESTE BLOQUE, Y POR QUÉ NO ES UN PARCHE. El par `cleanup()` + segundo `render()`
 * MODELABA LA REAPERTURA, que es exactamente lo que esta HU eliminó: un test que todavía reabriera
 * no estaría midiendo lo que la HU hizo, estaría midiendo el rodeo que la HU borró. Por eso el
 * recorrido de hoy va derecho: "Volver" y las dos puertas, sobre el MISMO árbol montado.
 *
 * ⛔ Y EL CONTROL VIEJO (`T-W12(control)`) SE BORRÓ, no se parcheó ni se skipeó. Aquel control
 * probaba que SIN reabrir la app la búsqueda salía con la cuenta VIEJA, o sea probaba la exigencia
 * que esta HU eliminó: hoy da lo contrario, y eso es correcto. Su propio docblock lo había declarado
 * por adelantado, textualmente: "ESTE CONTROL SE PONE ROJO EL DÍA QUE ALGUIEN ARREGLE `resolveSender`
 * PARA QUE VUELVA A PREGUNTARLE A LA BILLETERA, y ese rojo es la señal, no un falso positivo". Ese
 * día llegó. Lo reemplaza `T-354-W12(control)`, que mide lo que sí sigue teniendo sentido controlar:
 * que sin cambiar de cuenta la búsqueda sale con la de siempre.
 *
 * ⚠️ LAS DOS COSTURAS (WKH-354/R-2). El recorrido cambia la cuenta en el DOBLE DE LA BILLETERA y en
 * el PROBE INYECTADO, las dos, porque en producción son el mismo adapter sobre el mismo bridge: un
 * test que las ponga en desacuerdo mide un estado que no existe. Sin tocar el probe, `resolveSender`
 * seguiría resolviendo por el camino viejo y el test no diría nada de la HU.
 *
 * Esto tampoco modela el autoConnect del adapter real de la billetera. Mide el ÚNICO hecho del que
 * dependía el hallazgo: qué identidad viaja en la búsqueda después de seguir el consejo.
 */
describe("WKH-352/WKH-354 · el consejo del copy, ejecutado sin reabrir la app", () => {
  /** La otra cuenta de la misma billetera. base58 válida de 32 bytes (`bs58.encode(fill(3))`), para
   *  que nada de lo que atraviesa el camino la pueda rechazar por forma, y distinta byte a byte de
   *  `FAKE_SOLANA_BENEFICIARY`, que es la dueña de la fila local. */
  const OTRA_CUENTA = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8";

  /** Una billetera cuya CUENTA ACTIVA se puede cambiar: es el gesto que el copy le pide a la persona.
   *  `FakeSolanaWallet` contesta siempre la misma address, que es justo lo que acá no sirve. */
  class WalletQueCambiaDeCuenta extends FakeSolanaWallet {
    constructor(public actual: string) {
      super();
    }
    override async connect(): Promise<string> {
      return this.actual;
    }
    override async getAddress(): Promise<string | null> {
      return this.actual;
    }
  }

  /** El mundo del recorrido: una fila `unverified` CON `principalTx` (la de AC-1) cuya PDA la cadena
   *  contesta `absent` ⇒ la tarjeta muestra el copy con el consejo. Más la puerta de recuperación
   *  cableada, que sin `solanaRefund` ni se renderiza. */
  async function mundo() {
    const repo = new InMemoryRepo();
    await repo.save(Remittance.rehydrate(unverifiedSnapshot("rem-1")));
    const wallet = new WalletQueCambiaDeCuenta(FAKE_SOLANA_BENEFICIARY);
    const refundGw = new FakeSolanaEscrowRefundGateway();
    // WKH-354/R-2: la SEGUNDA costura. `resolveSender` ya no lee el `useState`: le pregunta a este
    // probe. Arranca en la misma cuenta que la billetera, que es el estado consistente de partida.
    const probe = new FakeConnectedWallet(FAKE_SOLANA_BENEFICIARY);
    const container = buildTestContainer({
      repo,
      wallet,
      solanaRefund: refundGw,
      connectedWallet: probe,
      solanaEscrowStates: new FakeSolanaEscrowChainStateReader(mapa([["rem-1", "absent"]])),
    });
    return { wallet, refundGw, probe, container };
  }

  /** Los dos clicks de "usá la opción de recuperar un envío perdido": abrir la puerta y buscar. */
  async function usarLaOpcionDeRecuperar() {
    // `find*` y no `get*`: volver a `send` desde el historial pasa por `AnimatePresence`, así que la
    // puerta no está en el DOM en el mismo tick del click. Con `get*` esto fallaba SÓLO en el control.
    fireEvent.click(await screen.findByRole("button", { name: "Recuperar un envío perdido" }));
    fireEvent.click(await screen.findByRole("button", { name: /Buscar mis escrows/ }));
  }

  // 🔴 T-354-W12 — SEGUIR EL CONSEJO TERMINA CON LA BILLETERA NUEVA, Y SIN REABRIR NADA.
  // Los pasos son los del copy, en su orden: se ve la tarjeta, se cambia de cuenta en la billetera, se
  // vuelve a la pantalla de inicio, y ahí se usa la opción de recuperar. El assert que cierra el
  // hallazgo es UNO: con qué `sender` salió la búsqueda.
  // ⛔ SIN `cleanup()` Y SIN UN SEGUNDO `render()`. Ese par era el modelo de la REAPERTURA, y la
  // reapertura es justamente lo que WKH-354 eliminó: un test que todavía reabra no mide lo que la HU
  // hizo. El árbol montado es UNO solo, de punta a punta.
  it("T-354-W12: se ve el consejo, se cambia de cuenta, se vuelve a la pantalla de inicio, y la búsqueda sale con la cuenta NUEVA", async () => {
    const { wallet, refundGw, probe, container } = await mundo();

    // (1) La tarjeta con el consejo, en pantalla, con la billetera de siempre.
    render(<RemittanceFlow container={container} />);
    fireEvent.click(screen.getByRole("button", { name: /Ver mis envíos/ }));
    expect(await screen.findByText(CP9_ABSENT_CON_DEPOSITO)).toBeInTheDocument();
    // (2) Y el consejo que este test va a ejecutar sale DEL COPY, no de la cabeza de quien lo escribió:
    // si alguien cambia la frase por otra, estos asserts se ponen rojos y obligan a re-medir el
    // recorrido. El `not.toContain` es el que caza la reposición del consejo viejo.
    expect(CP9_ABSENT_CON_DEPOSITO).toContain("cambiá a esa cuenta en tu billetera");
    expect(CP9_ABSENT_CON_DEPOSITO).toContain("volvé a la pantalla de inicio");
    expect(CP9_ABSENT_CON_DEPOSITO).toContain("recuperar un envío perdido");
    expect(CP9_ABSENT_CON_DEPOSITO).not.toContain("volvé a abrir Chaski");

    // (3) "cambiá a esa cuenta en tu billetera" — LAS DOS COSTURAS, que en producción son la misma
    //     (el mismo adapter sobre el mismo bridge). Sin la segunda, `resolveSender` no se entera.
    wallet.actual = OTRA_CUENTA;
    probe.switchTo(OTRA_CUENTA);

    // (4) "volvé a la pantalla de inicio: ahí está la opción de recuperar un envío perdido".
    fireEvent.click(screen.getByRole("button", { name: /Volver/ }));
    await usarLaOpcionDeRecuperar();

    // (5) EL ASSERT QUE CIERRA EL HALLAZGO.
    await waitFor(() => expect(refundGw.calls).toHaveLength(1));
    expect(refundGw.calls[0]?.sender).toBe(OTRA_CUENTA);
    expect(refundGw.calls[0]?.sender).not.toBe(FAKE_SOLANA_BENEFICIARY);
    // Sin `remittanceId`: es la resolución durable por sender, que es la puerta que el copy nombra.
    expect(refundGw.calls[0]?.remittanceId).toBeUndefined();
    // (6) Y el camino llega hasta el final visible, no sólo hasta el borde del gateway.
    expect(await screen.findByText("Recuperaste tus fondos")).toBeInTheDocument();
  });

  // 🔴 T-354-W12(control) — REEMPLAZA AL CONTROL BORRADO, y sin él T-354-W12 no mide nada: podría
  // estar verde porque el doble contesta `OTRA_CUENTA` pase lo que pase. Acá se hace EL MISMO
  // recorrido SIN cambiar de cuenta, y la búsqueda sale con la de siempre.
  //
  // (El control que vivía acá probaba lo contrario —que sin reabrir la app la búsqueda salía con la
  // cuenta VIEJA— y eso era la descripción del defecto, no de una garantía. Ver el docblock del
  // describe.)
  it("T-354-W12(control): sin cambiar de cuenta, el MISMO recorrido sale con la cuenta de siempre", async () => {
    const { probe, refundGw, container } = await mundo();

    render(<RemittanceFlow container={container} />);
    fireEvent.click(screen.getByRole("button", { name: /Ver mis envíos/ }));
    expect(await screen.findByText(CP9_ABSENT_CON_DEPOSITO)).toBeInTheDocument();

    // Nadie tocó la billetera: ni el doble ni el probe cambian.
    fireEvent.click(screen.getByRole("button", { name: /Volver/ }));
    await usarLaOpcionDeRecuperar();

    await waitFor(() => expect(refundGw.calls).toHaveLength(1));
    expect(refundGw.calls[0]?.sender).toBe(FAKE_SOLANA_BENEFICIARY);
    expect(refundGw.calls[0]?.sender).not.toBe(OTRA_CUENTA);
    // Y el doble PODÍA haber contestado otra cosa: si esto fallara, el control estaría midiendo un
    // doble incapaz de cambiar en vez de la ausencia de cambio. Va sobre el PROBE y no sobre
    // `wallet`, que era medir el doble equivocado (CR/MNR-3): después de esta HU el `sender` sale de
    // (`live`, `./flow.tsx:397`), o sea del probe, y como el probe no contesta `null` en ningún
    // momento de este recorrido, el `?? connectWallet.execute()` nunca corre y `wallet.connect()` no
    // se consulta. La versión anterior ni siquiera destructuraba `probe`, que `mundo()` sí devuelve.
    probe.switchTo(OTRA_CUENTA);
    expect(await probe.getConnectedAddress()).toBe(OTRA_CUENTA);
  });
});
