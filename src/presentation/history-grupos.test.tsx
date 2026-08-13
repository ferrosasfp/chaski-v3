// @vitest-environment jsdom
//
// WKH-350 — "VER MIS ENVÍOS" AGRUPADO POR LO QUE DICE LA CADENA.
//
// La pantalla pasó de una lista plana a 4 secciones con encabezado. El criterio de pertenencia es el
// `EscrowOutcome` que ya se calculaba antes de esta HU, no el `status` de la remesa. Estos tests fijan
// que nada se pierda en el reparto, que el grupo vacío no se muestre, que el orden entre secciones y
// dentro de cada sección sea el acordado, que no aparezca ningún botón nuevo, y que la ausencia de
// respuesta no se disfrace de respuesta.
//
// ⚠️ COBERTURA REAL: 10 DE LOS 11 DESENLACES A NIVEL COMPONENTE, no los 11. Nueve salen del montaje
// base de T-H4 y `unverified` sale de T-H9. El que falta es `chain-pending`, y no es un olvido: el
// doble `FakeSolanaEscrowChainStateReader` tiene modos `"resolve"` y `"reject"`, y para que la
// pantalla quede en `pending` haría falta uno que NUNCA resuelva, lo que obliga a editar
// `src/test-support/fakes.ts`, que está fuera del alcance de esta HU. `chain-pending` queda cubierto
// sólo a nivel puro, por T-H3 en `flow-vm.test.ts`. Es la misma situación que este repo ya declara en
// `history-onchain.test.tsx:41-42` para `chain-absent` y `chain-pending`.
//
// ⚠️ POR QUÉ TAMPOCO ENTRAN LOS 11 EN UN SOLO MONTAJE: con `reader` y `sender` presentes y la promesa
// resuelta, la respuesta de la pantalla es un `Map`, y una clave faltante se lee `"unknown"`, nunca
// `"not-asked"`. O sea que con reader NINGUNA fila puede dar `unverified`. Ese desenlace sólo existe
// sin reader y sin sender, que es justo el montaje de T-H9.
//
// ⚠️ LO QUE NINGÚN TEST DE ACÁ MIDE, dicho para que nadie lea de más en su verde:
//   1. Ninguna clase de Tailwind. Que `space-y-2` y `space-y-4` produzcan el espaciado no lo prueba
//      nadie acá, porque jsdom no hace layout. Misma limitación ya declarada para `TxProof`.
//   2. Accesibilidad de los encabezados, más allá de que su texto esté en el DOM.
//   3. `chain-pending` a nivel componente (arriba).
//   4. Si un par (encabezado, miembros) NUEVO es honesto. Estos tests, igual que T-H1/T-H2/T-H3,
//      eliminan el drift de una mitad respecto de la otra; no juzgan una mentira escrita coherente en
//      las dos mitades a la vez.
//
// 🔴 REGLA DE ESTE ARCHIVO, heredada de `history-onchain.test.tsx`: cada test nombra la edición
// plausible que lo pone en rojo. Un test que no puede nombrar su mutante no es cobertura.
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { HistoryView } from "./flow";
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
  FakeSolanaEscrowChainStateReader,
  T0,
  beneficiary,
} from "../test-support/fakes";

afterEach(cleanup);

// Los 4 encabezados, escritos A MANO y no derivados del módulo. Un test que le pregunta al código qué
// texto produce y después verifica que produjo ese texto es un guard que se compara consigo mismo.
const H_FIRMA = "Necesitan tu firma";
const H_CON_PLATA = "Con plata en el escrow";
const H_SIN_PLATA = "Sin plata en el escrow";
const H_SIN_RESPUESTA = "Sin respuesta sobre tu plata";

// El copy POR FILA, que esta HU no toca ni un byte. Va como literal por el mismo motivo de arriba: es
// el contrato con la persona, y que sobreviva a la reagrupación es la mitad de AC-3.
const CP_IN_ESCROW = "Tus USDC quedaron en el escrow, a tu nombre.";
const CP_UNVERIFIED = "No comprobamos si tus USDC siguen en el escrow.";
const CP_NO_DEPOSIT = "No llegaste a depositar.";
const CP_RETURNED = "Tus USDC volvieron a tu wallet.";

// Los fixtures se REPLICAN acá en vez de exportarse desde `history-onchain.test.tsx`: ese archivo es
// NO-TOUCH en esta HU, y agregarle un `export` es tocarlo.
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

/** `unverified`: el depósito entró y nadie volvió a mirar el vault. Es el único bucket que se pregunta. */
function unverifiedSnapshot(id: string): RemittanceState {
  const r = quotedRemittance(id);
  r.applyKyc(passKyc, T0);
  r.confirm(T0);
  r.markPrincipalIn("solana-sig", T0);
  r.markPayoutSubmitted("transfi-sol-po-1", T0, "transfi");
  return r.snapshot;
}

/** `in-escrow`: la cadena YA contestó y quedó escrito. No se vuelve a preguntar. */
function inEscrowSnapshot(id: string): RemittanceState {
  const r = quotedRemittance(id);
  r.applyKyc(passKyc, T0);
  r.confirm(T0);
  r.markPayoutFailed(PRINCIPAL_SETTLED_REFUND_MANUAL, T0);
  return r.snapshot;
}

/** `returned`: el refund se confirmó y se anotó. Tampoco se pregunta. */
function returnedSnapshot(id: string): RemittanceState {
  return {
    ...unverifiedSnapshot(id),
    status: "refunded",
    refundTx: "5xRealSignature",
    failureReason: ESCROW_REFUNDED_BY_SENDER,
  };
}

/** `no-deposit`: nunca hubo plata en juego. Ni se pregunta ni se le inventa un desenlace. */
function noDepositSnapshot(id: string): RemittanceState {
  const r = quotedRemittance(id);
  r.applyKyc({ ...passKyc, approved: false, payoutAllowed: false }, T0);
  return r.snapshot;
}

const mapa = (entradas: Array<[string, EscrowChainState]>): ReadonlyMap<string, EscrowChainState> =>
  new Map(entradas);

/**
 * Las 9 filas del montaje base: una por cada desenlace alcanzable con reader presente. Reparto
 * esperado: 1 en firma, 2 en con plata, 4 en sin plata, 2 en sin respuesta. Los 4 grupos con filas,
 * que es lo que T-H6 necesita para poder comparar 4 posiciones.
 */
const NUEVE_FILAS: RemittanceState[] = [
  noDepositSnapshot("rem-nodeposit"),
  inEscrowSnapshot("rem-inescrow"),
  returnedSnapshot("rem-returned"),
  unverifiedSnapshot("rem-open"),
  unverifiedSnapshot("rem-closed"),
  unverifiedSnapshot("rem-released"),
  unverifiedSnapshot("rem-refunded"),
  unverifiedSnapshot("rem-absent"),
  unverifiedSnapshot("rem-unknown"),
];

const NUEVE_RESPUESTAS = mapa([
  ["rem-open", "deposited-window-open"],
  ["rem-closed", "deposited-window-closed"],
  ["rem-released", "released"],
  ["rem-refunded", "refunded"],
  ["rem-absent", "absent"],
  ["rem-unknown", "unknown"],
]);

describe("WKH-350 · el historial se reparte en 4 secciones y no pierde nada por el camino", () => {
  // 🔴 T-H4 (AC-3) — NADA SE PIERDE EN EL REPARTO, Y EL COPY POR FILA NO CAMBIA NI UN BYTE.
  // MUTANTE: un `if (g === undefined) return null` o cualquier filtro que descarte un desenlace no
  // contemplado. Una tarjeta desaparece de la pantalla sin que nadie se entere, que es la peor forma
  // de romper esto: la persona deja de ver un envío suyo y la app no lo dice.
  // ⚠️ EL TÍTULO DICE LO QUE MIDE Y NADA MÁS: las 9 filas se cuentan como `listitem`, pero la frase se
  // verifica sólo en las 3 LOCALES. Las 6 de cadena están candadeadas por texto en
  // `history-onchain.test.tsx` y en los T-V de `flow-vm.test.ts`, no acá.
  it("T-H4: las 9 filas siguen estando, y las 3 locales con la frase de siempre", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(NUEVE_RESPUESTAS);
    render(
      <HistoryView
        items={NUEVE_FILAS}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(9));
    expect(screen.getByText(CP_IN_ESCROW)).toBeInTheDocument();
    expect(screen.getByText(CP_NO_DEPOSIT)).toBeInTheDocument();
    expect(screen.getByText(CP_RETURNED)).toBeInTheDocument();
  });

  // 🔴 T-H5 (AC-4) — EL GRUPO SIN FILAS NO SE MUESTRA, NI SIQUIERA CON UN CERO.
  // Un encabezado sobre un conjunto vacío es una afirmación vacía, y un "0 envíos" es peor: un número
  // invita a leerse como una medición.
  // MUTANTE: renderizar los 4 encabezados incondicionalmente, o sacar el `return null` del grupo
  // vacío. Los otros 3 encabezados aparecen sobre nada.
  it("T-H5: con filas de un solo grupo, los otros 3 encabezados no existen", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(
      mapa([
        ["rem-released", "released"],
        ["rem-refunded", "refunded"],
      ]),
    );
    render(
      <HistoryView
        items={[
          noDepositSnapshot("rem-nodeposit"),
          returnedSnapshot("rem-returned"),
          unverifiedSnapshot("rem-released"),
          unverifiedSnapshot("rem-refunded"),
        ]}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );
    await waitFor(() => expect(screen.queryByText(H_SIN_RESPUESTA)).toBeNull());
    expect(screen.getByText(H_SIN_PLATA)).toBeInTheDocument();
    expect(screen.queryByText(H_FIRMA)).toBeNull();
    expect(screen.queryByText(H_CON_PLATA)).toBeNull();
  });

  // 🔴 T-H6 (AC-5) — EL ORDEN ENTRE SECCIONES ES FIJO Y POR SEVERIDAD DECRECIENTE.
  // Primero lo que necesita una acción de la persona, después lo que tiene plata adentro, después lo
  // que no la tiene, y al final lo que no sabemos.
  // MUTANTE: recorrer `Object.keys` del mapa en vez de `HISTORY_GROUP_ORDER`, ordenar alfabéticamente,
  // ordenar por cantidad de filas, o invertir el orden. Cualquiera de los cuatro.
  it("T-H6: los 4 encabezados aparecen en el orden firma, con plata, sin plata, sin respuesta", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(NUEVE_RESPUESTAS);
    const { container } = render(
      <HistoryView
        items={NUEVE_FILAS}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );
    await waitFor(() => expect(screen.getByText(H_FIRMA)).toBeInTheDocument());
    const t = container.textContent ?? "";
    const posiciones = [H_FIRMA, H_CON_PLATA, H_SIN_PLATA, H_SIN_RESPUESTA].map((h) => t.indexOf(h));
    for (const p of posiciones) expect(p).toBeGreaterThanOrEqual(0);
    expect(posiciones[0]).toBeLessThan(posiciones[1] as number);
    expect(posiciones[1]).toBeLessThan(posiciones[2] as number);
    expect(posiciones[2]).toBeLessThan(posiciones[3] as number);
  });

  // 🔴 T-H7 (AC-6) — DENTRO DE UN GRUPO, EL ORDEN ES EL QUE LA LISTA YA TRAÍA.
  // La lista llega ordenada de arriba; reordenarla acá cambiaría lo que la persona espera ver primero
  // sin que nadie lo haya decidido.
  // MUTANTES, y son CUATRO, uno por criterio: un `.sort()` dentro del grupo por nombre, por id, por
  // fecha o por monto. Los cuatro campos están desalineados a propósito entre sí y con el orden de
  // entrada, en las dos direcciones:
  //   entrada  Cira(r2, 300 USDC, 18:02) · Ana(r3, 500, 18:03) · Beto(r1, 400, 18:01)
  //   nombre ↑ Ana, Beto, Cira      · id ↑ Beto, Cira, Ana
  //   monto ↑  Cira, Beto, Ana      · fecha ↑ Beto, Cira, Ana
  // Ninguna de esas seis permutaciones (ni sus inversas) es el orden de entrada, así que cualquiera de
  // los cuatro `.sort()` mueve al menos una fila y este test se pone rojo.
  // ⚠️ La versión anterior de este test AFIRMABA cubrir fecha, monto e id y sólo mataba el de nombre:
  // las tres filas salían con el mismo `T0` y el mismo `Money.of(400)`, y con un sort estable ordenar
  // por un campo constante deja el orden intacto. Por eso ahora los valores se escriben acá.
  it("T-H7: tres filas del mismo grupo conservan el orden de entrada", () => {
    render(
      <HistoryView
        items={[
          {
            ...returnedSnapshot("r2"),
            beneficiary: { ...beneficiary(), name: "Cira" },
            sendUsd: Money.of(300, "USDC"),
            createdAt: "2026-07-09T18:02:00.000Z",
          },
          {
            ...returnedSnapshot("r3"),
            beneficiary: { ...beneficiary(), name: "Ana" },
            sendUsd: Money.of(500, "USDC"),
            createdAt: "2026-07-09T18:03:00.000Z",
          },
          {
            ...returnedSnapshot("r1"),
            beneficiary: { ...beneficiary(), name: "Beto" },
            sendUsd: Money.of(400, "USDC"),
            createdAt: "2026-07-09T18:01:00.000Z",
          },
        ]}
        onOpen={() => {}}
        onBack={() => {}}
      />,
    );
    const t = screen.getByText(H_SIN_PLATA).parentElement?.textContent ?? "";
    expect(t.indexOf("Cira")).toBeGreaterThanOrEqual(0);
    expect(t.indexOf("Cira")).toBeLessThan(t.indexOf("Ana"));
    expect(t.indexOf("Ana")).toBeLessThan(t.indexOf("Beto"));
  });

  // 🔴 T-H8 (AC-2) — LA TARJETA SIGUE SIENDO LA MISMA: UN SOLO BOTÓN, Y ES EL DE SIEMPRE.
  // Agrupar es presentación. Esta HU no agrega ninguna acción, y el AC que pedía una acción de refund
  // se sacó a una HU sucesora a propósito.
  // MUTANTE: agregar un botón propio del grupo "Necesitan tu firma", que es exactamente la tentación
  // que ese encabezado provoca. El conteo dentro del `<li>` pasa de 1 a 2.
  // El `within` no es un adorno: el botón "Volver" de la pantalla está fuera de la lista, así que un
  // conteo global daría 2 y este test estaría midiendo otra cosa.
  it("T-H8: la fila que necesita firma tiene exactamente un botón, y dice Ver seguimiento", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(
      mapa([["rem-closed", "deposited-window-closed"]]),
    );
    render(
      <HistoryView
        items={[unverifiedSnapshot("rem-closed")]}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );
    await waitFor(() => expect(screen.getByText(H_FIRMA)).toBeInTheDocument());
    const fila = screen.getByRole("listitem");
    const botones = within(fila).getAllByRole("button");
    expect(botones).toHaveLength(1);
    expect(botones[0]).toHaveTextContent("Ver seguimiento");
  });

  // 🔴 T-H9 (AC-7) — LA AUSENCIA DE RESPUESTA NO SE DISFRAZA DE RESPUESTA.
  // Sin reader y sin sender no se emite ninguna consulta, así que de la fila `unverified` no sabemos
  // nada. Va bajo "Sin respuesta sobre tu plata" y NO bajo "Con plata en el escrow".
  // MUTANTE: mapear `unverified` a "con-plata" con el argumento de que "probablemente tenga plata".
  // Eso es exactamente aparentar una consulta que nunca existió, y la fila `in-escrow` de al lado
  // muestra la diferencia: de esa sí sabemos.
  it("T-H9: sin consulta, la fila sin verificar cae en sin respuesta y no en con plata", () => {
    render(
      <HistoryView
        items={[unverifiedSnapshot("rem-unverified"), inEscrowSnapshot("rem-inescrow")]}
        onOpen={() => {}}
        onBack={() => {}}
      />,
    );
    const sinRespuesta = screen.getByTestId("grupo-sin-respuesta");
    const conPlata = screen.getByTestId("grupo-con-plata");
    expect(within(sinRespuesta).getByText(CP_UNVERIFIED)).toBeInTheDocument();
    expect(within(conPlata).queryByText(CP_UNVERIFIED)).toBeNull();
    expect(within(conPlata).getByText(CP_IN_ESCROW)).toBeInTheDocument();
  });
});
