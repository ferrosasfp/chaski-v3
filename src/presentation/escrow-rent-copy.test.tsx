// @vitest-environment jsdom
//
// EL COPY DEL CIERRE DE CUENTAS (WKH-327 / AC-6, AC-7, AC-4).
//
// Lo que estos tests cuidan no es "que el texto exista": es que la CIFRA que la pantalla promete sea la
// del alquiler que de verdad vuelve, y no la de al lado.
//
// 🔴 POR QUÉ HAY ASERCIONES POR AUSENCIA Y NO SÓLO DE PRESENCIA. `formatLamportsAsSol` (el ceil) mapea
// DOS constantes distintas a la MISMA cadena "0,0041": el umbral de depósito (4.100.000) y el alquiler
// de las dos cuentas (4.002.000). O sea que un test que sólo assertara la presencia de un número pasa
// igual con la constante equivocada adentro, o con el formateador equivocado. Las tres aserciones por
// ausencia ("0,0041", "0,0048", "0,0088") son las que distinguen:
//   · "0,0041" aparece si se usó el ceil, o si se formateó el umbral en vez del alquiler;
//   · "0,0048" aparece si se mostró el alquiler del EscrowIndex;
//   · "0,0088" aparece si se sumó el índice al total.
//
// 🔴 POR QUÉ `within(...)` Y NO `document.body`. `humanError("solana_sender_sol_insufficient")`
// renderiza "0,0041" LEGÍTIMAMENTE (flow-vm.ts, el copy del umbral de SOL). Una aserción de ausencia
// sobre todo el documento se pondría roja por una razón que no tiene nada que ver con AC-6, y el
// arreglo "obvio" sería borrar la aserción — que es justo la que ataja el error que este archivo
// existe para atajar.
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { CloseEscrowAction, TrackView } from "./flow";
import {
  escrowCloseError,
  escrowCloseSentCopy,
  escrowRentExplainer,
} from "./flow-vm";
import { CloseEscrowAccounts } from "../application/use-cases/close-escrow-accounts";
import { FAKE_SOLANA_BENEFICIARY, FakeSolanaEscrowCloseGateway } from "../test-support/fakes";
import type { RemittanceState } from "../domain/remittance";

afterEach(cleanup);

const sender = FAKE_SOLANA_BENEFICIARY;
const OTRA_BILLETERA = "8tJVcM2JmYcMNCcNFYtUpXVWvKNTfnrCEwLuTRHpF9dQ";

function useCase(): CloseEscrowAccounts {
  return new CloseEscrowAccounts(new FakeSolanaEscrowCloseGateway());
}

/** El subárbol del componente de cierre, y NADA más del documento (ver la cabecera). */
function subarbolDelCierre(): HTMLElement {
  return screen.getByTestId("close-escrow-action");
}

function remesa(overrides: Partial<RemittanceState> = {}): RemittanceState {
  return {
    id: "rem-1",
    status: "settled",
    version: 1,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    ownerAddress: sender,
    // El camino optimista de TrackView renderiza `PayoutInProgress`, que lee `rem.beneficiary.name`:
    // sin esto el test de AC-4 se cae por una razón que no tiene nada que ver con AC-4.
    beneficiary: {
      name: "Rosa Quispe",
      country: "PE",
      method: "bank_cci",
      destination: "00212345678901234567",
    },
    ...overrides,
  } as RemittanceState;
}

describe("AC-6: la cifra que se promete es la del alquiler que vuelve, no la de al lado", () => {
  it("muestra 0,0040 y NO muestra ninguno de los tres números equivocados", () => {
    render(<CloseEscrowAction remittanceId="rem-1" sender={sender} close={useCase()} />);
    const card = within(subarbolDelCierre());

    expect(card.getByText(/0,0040/)).toBeInTheDocument();

    const texto = subarbolDelCierre().textContent ?? "";
    // ⚠️ CADA número equivocado se asserta en SUS DOS grafías, la del ceil y la del floor, y esto
    // costó un mutante que sobrevivió. La lista original ("0,0041", "0,0048", "0,0088") sale de la
    // tabla medida con `formatLamportsAsSol` (ceil); la implementación usa el FLOOR, y con el floor el
    // índice se escribe "0,0047" y la suma "0,0087". Un mutante que AGREGABA la suma del índice
    // formateada con el floor pasó los cinco `not.toContain` de la lista vieja en verde.
    expect(texto).not.toContain("0,0041"); // ceil del alquiler, y también el umbral de depósito
    expect(texto).not.toContain("0,0048"); // ceil del alquiler del EscrowIndex
    expect(texto).not.toContain("0,0047"); // floor del mismo
    expect(texto).not.toContain("0,0088"); // ceil de la suma con el índice
    expect(texto).not.toContain("0,0087"); // floor de la misma
    expect(texto).not.toContain("4.774.560"); // el índice en lamports
    expect(texto).not.toContain("4774560");
  });

  it("nombra LAS DOS cuentas que se cierran, no 'tu alquiler' a secas (CD-3)", () => {
    render(<CloseEscrowAction remittanceId="rem-1" sender={sender} close={useCase()} />);
    const texto = subarbolDelCierre().textContent ?? "";
    expect(texto).toContain("dos cuentas");
    expect(texto).toContain("la del contrato");
    expect(texto).toContain("la que guardó tus USDC");
  });

  it("menciona APARTE la tercera cuenta que NO se cierra y cuyo depósito no vuelve", () => {
    render(<CloseEscrowAction remittanceId="rem-1" sender={sender} close={useCase()} />);
    const texto = subarbolDelCierre().textContent ?? "";
    expect(texto).toContain("tercera cuenta");
    expect(texto).toContain("índice");
    expect(texto).toContain("no vuelve");
    // Y NO la suma a la cifra: eso es lo que asserta el test de arriba por ausencia de "0,0088".
  });

  it("NO promete un neto: dice que hay comisión y que no sabemos cuánto (CD-3)", () => {
    const { body } = escrowRentExplainer();
    expect(body).toContain("comisión");
    expect(body).toContain("no lo sabemos de antemano");
  });
});

describe("AC-4 / AC-7: cuándo NO se ofrece la acción", () => {
  const noop = () => {};

  it("AC-7: la remesa es de OTRA billetera ⇒ el botón no está en el documento", () => {
    render(
      <TrackView
        rem={remesa({ ownerAddress: OTRA_BILLETERA })}
        closeEscrow={useCase()}
        sender={sender}
        onRecovered={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /Cerrar y recuperar/ })).not.toBeInTheDocument();
  });

  it("AC-4: la remesa NO está en un estado terminal ⇒ el botón no está en el documento", () => {
    render(
      <TrackView
        rem={remesa({ status: "payout_submitted" })}
        closeEscrow={useCase()}
        sender={sender}
        onRecovered={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /Cerrar y recuperar/ })).not.toBeInTheDocument();
  });

  // El caso que hay que mirar dos veces: un envío que falló puede tener el principal TODAVÍA adentro
  // del escrow (Deposited en cadena), que es justo lo que `close` rechaza.
  it("AC-4: payout_failed tampoco ofrece el cierre (el principal puede seguir en el escrow)", () => {
    render(
      <TrackView
        rem={remesa({ status: "payout_failed" })}
        closeEscrow={useCase()}
        sender={sender}
        onRecovered={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /Cerrar y recuperar/ })).not.toBeInTheDocument();
  });

  it("AC-7: sin billetera conectada ⇒ el botón no está en el documento", () => {
    render(
      <TrackView rem={remesa()} closeEscrow={useCase()} sender={null} onRecovered={noop} />,
    );
    expect(screen.queryByRole("button", { name: /Cerrar y recuperar/ })).not.toBeInTheDocument();
  });

  // El control positivo: sin él, los cuatro `not.toBeInTheDocument()` de arriba pasarían igual si el
  // botón no se montara NUNCA — que es como un test de ausencia deja de probar nada.
  it("control positivo: remesa terminal + billetera del dueño ⇒ el botón SÍ está", () => {
    render(
      <TrackView rem={remesa()} closeEscrow={useCase()} sender={sender} onRecovered={noop} />,
    );
    expect(screen.getByRole("button", { name: /Cerrar y recuperar/ })).toBeInTheDocument();
  });
});

describe("qué dice y qué NO dice el desenlace", () => {
  // CD-15: la ausencia de `escrow_state` prueba que las cuentas se cerraron y NADA MÁS. No dice a
  // dónde fue la plata, así que el copy del éxito no puede nombrar los USDC.
  it("el copy de éxito NO menciona los USDC", () => {
    expect(escrowCloseSentCopy("confirmed")).not.toContain("USDC");
  });

  it("pending y unknown se dicen distinto: uno es 'todavía no', el otro es 'no pudimos preguntar'", () => {
    expect(escrowCloseSentCopy("pending")).toContain("todavía no nos confirma");
    expect(escrowCloseSentCopy("unknown")).toContain("no pudimos preguntarle a la red");
    expect(escrowCloseSentCopy("pending")).not.toBe(escrowCloseSentCopy("unknown"));
  });

  // `escrow_account_absent` NO es un error: o ya se cerraron, o nunca se crearon, y en las dos no pasó
  // nada malo. Decir "error" manda a buscar un problema que no existe.
  it("escrow_account_absent no se dice como un fallo: sin 'error' ni 'no pudimos'", () => {
    const copy = escrowCloseError("escrow_account_absent");
    expect(copy).not.toContain("error");
    expect(copy).not.toContain("no pudimos");
    expect(copy).toContain("ya se cerraron");
    expect(copy).toContain("nunca llegaron a crearse");
  });

  it("escrow_index_probe_failed dice que NO se firmó nada (es lo que la persona necesita saber)", () => {
    const copy = escrowCloseError("escrow_index_probe_failed");
    expect(copy).toContain("no firmamos nada");
    expect(copy).toContain("No se movió nada de tu billetera");
  });

  it("escrow_not_terminal NO afirma dónde están los USDC", () => {
    expect(escrowCloseError("escrow_not_terminal")).toContain("no dice dónde están tus USDC");
  });

  it("close_not_sender manda a conectar la billetera que pagó, sin nombrarla", () => {
    const copy = escrowCloseError("close_not_sender");
    expect(copy).toContain("otra billetera");
    expect(copy).not.toContain(sender); // PII-free: nunca se interpola una address
  });
});
