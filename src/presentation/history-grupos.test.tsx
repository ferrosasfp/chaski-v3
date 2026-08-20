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
// ⚠️ COBERTURA REAL: 11 DE LOS 12 DESENLACES A NIVEL COMPONENTE, no los 12. Nueve salen del montaje
// base de T-H4, `unverified` sale de T-H9 y `chain-absent` sale del segundo montaje de T-W8. El que
// falta es `chain-pending`, y no es un olvido: el doble `FakeSolanaEscrowChainStateReader` tiene modos
// `"resolve"` y `"reject"`, y para que la pantalla quede en `pending` haría falta uno que NUNCA
// resuelva, lo que obliga a editar `src/test-support/fakes.ts`, fuera del alcance. `chain-pending`
// queda cubierto sólo a nivel puro, por T-H3 en `flow-vm.test.ts`. ⚠️ OJO CON EL MONTAJE BASE: desde
// WKH-352 su fila `rem-absent` da `chain-absent-after-deposit`, NO `chain-absent` (trae `principalTx`).
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
import { HistoryView, Receipt } from "./flow";
import { statusDisplay } from "./flow-vm";
import { Money } from "../domain/money";
import {
  type KycVerification,
  Remittance,
  type RemittanceState, type RemittanceStatus,
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
  payoutAllowed: true, realVerified: true, verifiedAt: null,
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

// WKH-351 — LA ETIQUETA DEL TRÁMITE YA NO ESTÁ EN LA TARJETA DEL HISTORIAL.
//
// EL INVARIANTE: ninguna tarjeta del historial muestra a la vez el encabezado de su grupo y una
// etiqueta del trámite de pago. El Pill hablaba del TRÁMITE (un hecho que este cliente recuerda) y la
// frase habla de la PLATA (un hecho que decide la cadena). Son ejes independientes: se medió
// contradicción alcanzable en 3 de los 4 grupos, no sólo en el caso fotografiado por el founder.
//
// 🔴 EL CANDADO TIENE DOS MITADES Y DOS CONTROLES, Y NINGUNA SOBRA:
//   (b) ESTRUCTURAL — dentro del grupo no hay ningún `span.rounded-full`, que es la forma del `Pill`
//       (`ui.tsx:185`). Mata: restaurar `<Pill tone={status.tone}>{status.label}</Pill>`, y TAMBIÉN
//       una etiqueta nueva con texto propio (`<Pill tone="neutral">Trámite</Pill>`), que (c) NO caza.
//   (c) SEMÁNTICA — ninguna de las 7 etiquetas de `statusDisplay` aparece dentro del `textContent` del
//       grupo, COMO SUBSTRING. Mata: pintar `status.label` SIN Pill, en un `<span className="text-xs">`,
//       que (b) NO caza; y también envuelto en un prefijo ("Estado: Pago en curso"), que el
//       `queryAllByText` con el que nació esta mitad dejaba pasar verde. Cada mitad mata un mutante que
//       la otra deja pasar.
//   ctrl-1 — el MISMO selector de (b) encuentra exactamente 1 Pill en el `Receipt`. Sin esto, si
//       `ui.tsx:185` dejara de usar `rounded-full`, (b) sería VACUAMENTE verde para siempre.
//   ctrl-2 — el conjunto de (c) tiene 7 etiquetas y ninguna vacía. Sin esto, un `statusDisplay`
//       mutado a `label: ""` dejaría a (c) buscando cadenas vacías y verde con cualquier cosa.
//   Los dos controles existen porque UNA ASERCIÓN DE AUSENCIA ES VERDE POR DEFECTO: hay que probar
//   que el instrumento mide antes de creerle que no encontró nada.
//
// ⚠️ EL LÍMITE DECLARADO, para que nadie lea de más en el verde de esto:
//   1. LO QUE SE ESCAPA ES UNA ETIQUETA SIN CLASE DE PILL CUYO TEXTO NO CONTENGA NINGUNA DE LAS 7.
//      (b) mira la FORMA y (c) las 7 PALABRAS conocidas como substring; un `<span>` sin `rounded-full`
//      que diga "En trámite" se escapa de las dos. Un prefijo o un sufijo sobre una de las 7 —"Estado:
//      Pago en curso"— NO se escapa: eso es lo que cambió respecto de la primera versión de (c), que
//      usaba `queryAllByText` (match exacto) y lo dejaba pasar. Las dos mitades abaratan la
//      reincidencia; NO la eliminan.
//   2. Verifica AUSENCIA, no HONESTIDAD. Igual que T-H1/T-H3, un encabezado mentiroso con filas que
//      le calzan pasa verde. Esa contradicción la sigue cerrando la revisión humana.
//   3. (b) depende de un NOMBRE DE CLASE. Lo detecta ctrl-1, y sólo mientras el `Receipt` siga
//      montando un Pill. Si algún día no lo monta, hay que REHACER el selector, no borrar el control.
//   4. `chain-pending` sigue sin cobertura a nivel componente (el doble no tiene modo "nunca
//      resuelve", limitación ya declarada en `:10-17`). Para esa fila el invariante vale POR
//      CONSTRUCCIÓN (no hay Pill en el JSX), pero no está medido.
//   5. jsdom no hace layout: que el bloque quede bien con un solo hijo en el flex no lo prueba nadie.
//
// 🔴 REGLA DEL ARCHIVO, heredada: cada test nombra la edición plausible que lo pone en rojo.

// La frase de la ventana vencida y la de la ventana abierta, A MANO. Mismo motivo que los H_*: un test
// que le pregunta al código qué copy produce y después verifica que produjo ese copy se compara consigo
// mismo. Estas cadenas son el contrato con la persona.
const CP_VENTANA_VENCIDA =
  "El contrato dice que tus USDC siguen en el escrow y que el plazo para liberarlos al pago ya venció: la salida que queda es devolverlos a tu wallet, y sólo tu firma puede hacerlo.";
const CP_VENTANA_ABIERTA = "El contrato dice que tus USDC siguen en el escrow, a tu nombre.";

// Las etiquetas SÍ se derivan del productor, y es la decisión opuesta a la de arriba a propósito: acá
// el conjunto PROHIBIDO tiene que seguir a `statusDisplay` si alguien le cambia una palabra, o el
// candado quedaría vigilando una etiqueta que ya nadie pinta. El `Record` fuerza la exhaustividad por
// tipos, mismo molde que (`TODOS`, `flow-vm.test.ts:1873`): un `RemittanceStatus` nuevo no compila
// hasta que entra acá.
const TODOS_LOS_STATUS: Record<RemittanceStatus, true> = {
  created: true,
  quoted: true,
  kyc_pending: true,
  kyc_passed: true,
  kyc_failed: true,
  confirmed: true,
  principal_in: true,
  payout_submitted: true,
  settled: true,
  payout_failed: true,
  refunded: true,
};
const ETIQUETAS_DE_TRAMITE: string[] = [
  ...new Set(
    (Object.keys(TODOS_LOS_STATUS) as RemittanceStatus[]).map((s) => statusDisplay(s).label),
  ),
];

const LOS_4_GRUPOS = ["firma", "con-plata", "sin-plata", "sin-respuesta"] as const;

/** El molde de (`returnedSnapshot`, `:131-138`): se fuerza el `status` sobre una fila `unverified`. */
function conStatus(id: string, status: RemittanceStatus): RemittanceState {
  return { ...unverifiedSnapshot(id), status };
}

// El montaje base trae 4 de las 7 etiquetas (payout_submitted, payout_failed, refunded y el default
// por kyc_failed). Las otras 3 entran con `status` forzado, y con una respuesta de cadena que las
// reparte en 3 grupos distintos, así que las 7 quedan representadas y los 4 grupos tienen filas.
const DOCE_FILAS: RemittanceState[] = [
  ...NUEVE_FILAS,
  conStatus("rem-settled", "settled"),
  conStatus("rem-principalin", "principal_in"),
  conStatus("rem-confirmed", "confirmed"),
];

const DOCE_RESPUESTAS = mapa([
  ...NUEVE_RESPUESTAS,
  ["rem-settled", "deposited-window-closed"],
  ["rem-principalin", "deposited-window-open"],
  ["rem-confirmed", "released"],
]);

describe("WKH-351 · la tarjeta del historial no muestra la etiqueta del trámite", () => {
  // 🔴 T-N1 (AC-1, AC-4 parcial) — EL INVARIANTE, EN LOS 4 GRUPOS, CON LAS 7 ETIQUETAS PRESENTES.
  // MUTANTE (a): esconder el encabezado del grupo "para evitar la contradicción", que es resolver la
  // HU al revés: sacarle a la persona el dato que la cadena SÍ sostiene.
  // MUTANTE (b): restaurar el Pill en `flow.tsx:3423`, o poner cualquier otra etiqueta con forma de
  // Pill y texto nuevo.
  // MUTANTE (c): pintar `status.label` sin Pill, en un `<span className="text-xs">`.
  it("T-N1: en los 4 grupos está el encabezado y no hay ninguna etiqueta de trámite", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(DOCE_RESPUESTAS);
    render(
      <HistoryView
        items={DOCE_FILAS}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(12));
    // (a) los 4 encabezados están: el invariante es "encabezado SIN etiqueta", no "nada de nada".
    for (const h of [H_FIRMA, H_CON_PLATA, H_SIN_PLATA, H_SIN_RESPUESTA]) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
    for (const g of LOS_4_GRUPOS) {
      const grupo = screen.getByTestId(`grupo-${g}`);
      // (b) estructural. El scope por grupo NO es un adorno: el chip de la wallet del header
      // (`flow.tsx:708-709`) también es un `span.rounded-full`, y un selector global lo contaría.
      expect(grupo.querySelectorAll("span.rounded-full")).toHaveLength(0);
      // (c) semántica, por SUBSTRING sobre el `textContent` del grupo y no por `queryAllByText`.
      // Medido, y es el motivo del cambio: con `<span className="text-xs">Estado: {status.label}</span>`
      // en `flow.tsx:3423` la tarjeta decía "Estado: Pago en curso" bajo "Necesitan tu firma" —el caso
      // exacto del founder, con sus mismas palabras— y `queryAllByText`, que es match EXACTO, lo dejaba
      // pasar verde. Un prefijo no puede evadir un `includes`.
      const texto = grupo.textContent ?? "";
      expect(ETIQUETAS_DE_TRAMITE.filter((label) => texto.includes(label))).toEqual([]);
    }
    // ctrl-1 — el instrumento mide: el MISMO selector encuentra 1 Pill en el `Receipt`, que a
    // propósito sigue mostrando la etiqueta. Se monta en su propio container y se consulta por el
    // container, no por `screen`, así que no interfiere con los asserts de arriba.
    const recibo = render(<Receipt rem={unverifiedSnapshot("rem-recibo")} onNew={() => {}} />);
    expect(recibo.container.querySelectorAll("span.rounded-full")).toHaveLength(1);
    // ctrl-2 — el instrumento mide: 7 etiquetas distintas y ninguna vacía.
    expect(ETIQUETAS_DE_TRAMITE).toHaveLength(7);
    for (const l of ETIQUETAS_DE_TRAMITE) expect(l).not.toBe("");
  });

  // 🔴 T-N2 (AC-5) — EL CASO QUE EL FOUNDER REPORTÓ, CON EL FIXTURE REAL.
  // `payout_submitted` + respuesta `deposited-window-closed` ⇒ grupo "Necesitan tu firma". Es
  // literalmente lo de producción: 3 filas, 32 USDC, con "Pago en curso" al lado de "el plazo venció".
  // MUTANTE: volver a la Opción 1 (Pill condicional por grupo) preservándolo justo para
  // `payout_submitted`; revertir sólo el hunk de `flow.tsx:3423` dejando el de `flow.tsx:3403`; o mover la
  // etiqueta del trámite al encabezado del grupo.
  // POR QUÉ NO ALCANZA T-N1: T-N1 recorre grupos con un conjunto derivado; T-N2 fija el par exacto
  // (status, respuesta) del reporte y lo nombra con literales. Si mañana alguien reordena fixtures,
  // T-N2 sigue nombrando el caso del founder.
  it("T-N2: la fila del caso reportado cae bajo firma y no dice ni 'Pago en curso' ni 'Entregado'", async () => {
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
    const grupo = screen.getByTestId("grupo-firma");
    expect(within(grupo).getByText(CP_VENTANA_VENCIDA)).toBeInTheDocument();
    // Substring, por lo mismo que (c) en T-N1: "Estado: Pago en curso" evade el match exacto de
    // `queryAllByText`, y este test es justo el que nombra el caso del founder con sus palabras.
    const texto = grupo.textContent ?? "";
    expect(["Pago en curso", "Entregado"].filter((l) => texto.includes(l))).toEqual([]);
  });

  // 🔴 T-N3 (AC-3) — `statusDisplay` SIGUE VIVA Y EL RECIBO SIGUE MOSTRÁNDOLA.
  // Esta HU mueve la etiqueta, no la borra. El recibo es una sola remesa ya elegida: no tiene
  // encabezado de grupo con el que contradecirse, así que ahí la etiqueta no miente.
  // MUTANTE: sacar el Pill del `Receipt` "por consistencia", que es el sobre-cumplimiento, el error
  // simétrico al bug; borrar `statusDisplay` (no compila); o cambiarle una etiqueta al pasar.
  // NO DUPLICA: (`statusDisplay`, `flow-vm.test.ts:76-101`) candadea el PURO y (`showRefund`, `flow.test.tsx:1576-1584`) cubre 2 de
  // los 7 estados en el recibo. Esto es el lado del RENDER con el conjunto completo.
  it("T-N3: el recibo sigue mostrando la etiqueta, y las 7 siguen siendo 7 y no vacías", () => {
    const { container } = render(
      <Receipt rem={unverifiedSnapshot("rem-recibo")} onNew={() => {}} />,
    );
    expect(within(container).getByText("Pago en curso")).toBeInTheDocument();
    expect(container.querySelectorAll("span.rounded-full")).toHaveLength(1);
    expect(ETIQUETAS_DE_TRAMITE).toHaveLength(7);
    for (const l of ETIQUETAS_DE_TRAMITE) expect(l).not.toBe("");
  });

  // 🔴 T-N4 (AC-4) — LO QUE LA TARJETA SIGUE MOSTRANDO, Y ES TODO MENOS LA ETIQUETA.
  // MUTANTE: la limpieza tentadora de borrar el `<div className="flex items-start justify-between
  // gap-normal">` de `flow.tsx:3416` junto con el Pill ("un flex con un solo hijo sobra"), que se lleva
  // puestos el nombre, el monto y la fecha. O borrar el bloque `flow.tsx:3416-3424` entero. Además, esas 4
  // líneas de desplazamiento las cazaría el control de línea-neutralidad.
  // ⚠️ LA FECHA NO SE COMPARA CONTRA UN LITERAL: `toLocaleDateString("es-PE")` depende del ICU del
  // runtime. Se verifica que la línea del monto exista y que NO diga "sin fecha", que es lo que
  // `formatEntryDate` (`flow.tsx:3445`) devuelve cuando el `createdAt` es implanteable.
  it("T-N4: la tarjeta sigue mostrando nombre, monto, fecha, la frase y exactamente un botón", async () => {
    const reader = new FakeSolanaEscrowChainStateReader(
      mapa([["rem-open", "deposited-window-open"]]),
    );
    render(
      <HistoryView
        items={[unverifiedSnapshot("rem-open")]}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );
    expect(await screen.findByText(CP_VENTANA_ABIERTA)).toBeInTheDocument();
    const fila = screen.getByRole("listitem");
    expect(within(fila).getByText("Mamá")).toBeInTheDocument();
    const montoYFecha = within(fila).getByText(/^\$400\.00 ·/);
    expect(montoYFecha.textContent).not.toContain("sin fecha");
    expect(within(fila).getAllByRole("button")).toHaveLength(1);
  });
});

describe("WKH-352 · el desenlace nuevo cae en el grupo que esa fila ya tenía", () => {
  /** WKH-352 · las dos frases de `absent`, ESCRITAS A MANO y no derivadas del módulo (un test que le
   *  pregunta al código qué copy produce y después verifica que produjo ese copy es un guard que se
   *  compara consigo mismo). Van acá abajo y no con las otras `CP_` porque son de otra HU. ⚠️ ACÁ HABÍA
   *  UN BOOKKEEPING DE CITAS ("el docblock de WKH-352 de `flow-vm.test.ts` cita TRES líneas de acá sin ancla"),
   *  y se borró (CR · MNR-2): esas citas ya no existen, y las dos que este archivo hace a `flow-vm.test.ts`
   *  van ANCLADAS, así que el desplazamiento lo caza `citas-ancladas.test.ts` y no una regla en prosa. */
  const CP_ABSENT_CON_DEPOSITO =
    "Tu depósito entró: de eso quedó la firma de la transacción, confirmada en la cadena. Y en la dirección que le corresponde a este envío no hay ninguna cuenta: miramos esa dirección sola, no el contrato entero, y eso es todo lo que medimos. Desde acá no podemos decir si terminó en un pago o en una devolución, ni descartar que la cuenta siga abierta en otra dirección: la que miramos se calcula con la wallet conectada, así que si depositaste con otra, cambiá a esa cuenta en tu billetera y abrí la pestaña Recuperar de la barra de abajo: ahí está la opción de recuperar un envío perdido.";
  const CP_ABSENT_AMBIGUO =
    "En el contrato no hay ninguna cuenta para este envío: o el depósito nunca entró, o ya se cerró después de resolverse. Desde acá no podemos decir cuál de las dos.";

  /** WKH-352 · el gemelo SIN la prueba del depósito: se firmó la autorización y nunca se registró el
   *  desenlace. Cae en `unverified` por `status: "confirmed"`, así que se le pregunta igual, pero
   *  `principalTx` es `null` y la cadena `absent` lo deja en `chain-absent`. */
  function sinPruebaSnapshot(id: string): RemittanceState {
    const r = quotedRemittance(id);
    r.applyKyc(passKyc, T0);
    r.confirm(T0);
    return r.snapshot;
  }

  // 🔴 T-W8 (WKH-352 / AC-4) — EL DESENLACE NUEVO NO MUEVE NINGUNA FILA DE GRUPO.
  // El montaje base ya sirve tal cual: `rem-absent` es `unverifiedSnapshot` (`:163`), que llama
  // (`markPrincipalIn`, `:116`), así que desde WKH-352 esa fila ES el caso de AC-1. Lo que este test
  // fija es que ganar una frase propia NO la mueve: sigue bajo "Sin respuesta sobre tu plata", que es
  // el grupo que ya tenía, y el reparto de las 9 filas no cambia.
  // MUTANTE MEDIDO: mapear `"chain-absent-after-deposit"` a `"sin-plata"` en `GRUPO_POR_DESENLACE`
  // (`flow-vm.ts:1366`), que es la edición tentadora ("total, ya se resolvió"). Es justo la que
  // AFIRMARÍA sobre la plata de alguien: mandaría bajo "Sin plata en el escrow" una fila de la que lo
  // único que se sabe es que el depósito entró y que la cuenta se cerró.
  // Medido: T-W8 rojo. Y medido también lo que NO es exclusivo de acá: ese mismo mutante pone rojo a
  // T-H3 en `flow-vm.test.ts`, a nivel puro. Lo que T-W8 agrega es que la fila esté REALMENTE bajo ese
  // encabezado en el DOM, que es lo que T-H3 no puede ver.
  // SEGUNDO MONTAJE, y no es un adorno: cubre `chain-absent` a nivel componente, que el montaje base
  // dejó de cubrir cuando `rem-absent` pasó a tener `principalTx`. Sin él, esta HU BAJA la cobertura de
  // componente en un desenlace y nadie se entera.
  // QUÉ NO CUBRE (CD-14): no mide el texto de la frase nueva (eso es T-W6), ni el orden dentro del
  // grupo, ni `chain-pending` (ver el encabezado del archivo).
  it("T-W8: la fila con prueba del depósito sigue en 'Sin respuesta sobre tu plata', y nada se mueve", async () => {
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

    // La frase de AC-1 está, y está DENTRO del grupo "sin-respuesta".
    const sinRespuesta = screen.getByTestId("grupo-sin-respuesta");
    expect(within(sinRespuesta).getByText(CP_ABSENT_CON_DEPOSITO)).toBeInTheDocument();
    // Y NO está en ninguno de los otros tres. Es la mitad que caza el mutante: si el valor nuevo
    // mapeara a "sin-plata", la frase aparecería ahí y este assert cae.
    for (const otro of ["grupo-firma", "grupo-con-plata", "grupo-sin-plata"]) {
      expect(within(screen.getByTestId(otro)).queryByText(CP_ABSENT_CON_DEPOSITO)).toBeNull();
    }
    // El reparto no cambió: siguen siendo 9 filas, ni una se perdió ni se duplicó.
    expect(screen.getAllByRole("listitem")).toHaveLength(9);

    // SEGUNDO MONTAJE: la fila SIN la prueba cae en el MISMO grupo, con la frase ambigua. Las dos
    // variantes de `absent` comparten grupo, que es exactamente lo que AC-4 pide.
    cleanup();
    const reader2 = new FakeSolanaEscrowChainStateReader(mapa([["rem-sin-prueba", "absent"]]));
    render(
      <HistoryView
        items={[sinPruebaSnapshot("rem-sin-prueba")]}
        onOpen={() => {}}
        onBack={() => {}}
        reader={reader2}
        sender={FAKE_SOLANA_BENEFICIARY}
      />,
    );
    const sinRespuesta2 = await screen.findByTestId("grupo-sin-respuesta");
    expect(within(sinRespuesta2).getByText(CP_ABSENT_AMBIGUO)).toBeInTheDocument();
    // Y esa fila NO dice la frase de AC-1: sin prueba, no se afirma que el depósito entró.
    expect(within(sinRespuesta2).queryByText(CP_ABSENT_CON_DEPOSITO)).toBeNull();
  });
});
