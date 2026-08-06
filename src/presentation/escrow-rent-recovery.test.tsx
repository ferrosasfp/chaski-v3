// @vitest-environment jsdom
//
// LA PUERTA DEL ALQUILER (WKH-327 / AC-8).
//
// Qué cubre que no cubría nada: los envíos TERMINADOS de esta billetera que este navegador no conoce.
// El historial está scopeado por `localStorage` y declara que no consulta la cadena; la puerta de
// "envío perdido" busca escrows ABIERTOS, y un escrow terminal no está abierto. O sea que el alquiler
// de un envío hecho desde otro dispositivo no tenía ningún camino.
//
// Lo que estos tests clavan, en orden de importancia:
//   1. que un id que NO está en localStorage aparece igual como cerrable;
//   2. que "no encontramos" y "no llegamos a preguntar" NO se dicen con las mismas palabras;
//   3. que el número del copy sale de la constante, no escrito a mano;
//   4. que las firmas se explican ANTES de que aparezca ningún diálogo.
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EscrowRentRecovery } from "./flow";
import { MAX_CLOSEABLE_CANDIDATES } from "../infrastructure/solana-wallet";
import { CloseEscrowAccounts } from "../application/use-cases/close-escrow-accounts";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakeSolanaCloseableEscrowLister,
  FakeSolanaEscrowCloseGateway,
} from "../test-support/fakes";

afterEach(cleanup);

const sender = FAKE_SOLANA_BENEFICIARY;
const resolveSender = async () => sender;

function abrirPuerta(lister: FakeSolanaCloseableEscrowLister) {
  render(
    <EscrowRentRecovery
      lister={lister}
      close={new CloseEscrowAccounts(new FakeSolanaEscrowCloseGateway())}
      resolveSender={resolveSender}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Recuperar el depósito de red de envíos anteriores/ }),
  );
}

describe("AC-8: alcanza envíos que este navegador no conoce", () => {
  it("localStorage vacío + el lister devolviendo un id terminal ⇒ aparece como cerrable", () => {
    // El navegador arranca sin nada guardado: esto es EXACTAMENTE el caso que hoy no tiene camino.
    expect(localStorage.length).toBe(0);
    const lister = new FakeSolanaCloseableEscrowLister([
      { remittanceId: "rem-de-otro-dispositivo", status: "released" },
    ]);
    abrirPuerta(lister);

    fireEvent.click(screen.getByRole("button", { name: /Buscar envíos con cuentas abiertas/ }));

    return waitFor(() => {
      expect(screen.getByText(/rem-de-otro-dispositivo/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Cerrar y recuperar/ })).toBeInTheDocument();
      expect(lister.calls).toEqual([{ sender }]);
    });
  });

  it("el copy de 'no encontramos' nombra CUÁNTOS envíos miramos, con la constante importada", () => {
    const lister = new FakeSolanaCloseableEscrowLister([]); // la cadena contestó: no hay nada
    abrirPuerta(lister);

    fireEvent.click(screen.getByRole("button", { name: /Buscar envíos con cuentas abiertas/ }));

    return waitFor(() => {
      // El número NO se escribe a mano acá: sale de la MISMA constante que el adapter sondea, así que
      // si el tope cambia el copy no puede quedar diciendo el viejo.
      expect(
        screen.getByText(new RegExp(`últimos ${MAX_CLOSEABLE_CANDIDATES} envíos`)),
      ).toBeInTheDocument();
      expect(screen.getByText(/No encontramos envíos terminados/)).toBeInTheDocument();
    });
  });

  // 🔴 La distinción que este archivo existe para sostener. Una lista vacía es una RESPUESTA; una
  // excepción es nuestra propia falla. Decir "no tenés nada" sobre lo segundo es afirmar sobre las
  // cuentas de alguien a partir de que nosotros no pudimos mirar.
  it("el lister LANZANDO dice 'no llegamos a preguntar', nunca 'no encontramos'", () => {
    const lister = new FakeSolanaCloseableEscrowLister([], "reject", "escrow_recovery_unavailable");
    abrirPuerta(lister);

    fireEvent.click(screen.getByRole("button", { name: /Buscar envíos con cuentas abiertas/ }));

    return waitFor(() => {
      expect(screen.getByText(/no llegamos a preguntar/)).toBeInTheDocument();
      expect(screen.queryByText(/No encontramos envíos terminados/)).not.toBeInTheDocument();
      expect(screen.getByText(/no es una respuesta sobre tus cuentas/)).toBeInTheDocument();
    });
  });

  it("sin lister cableado la puerta no se ofrece (no hay botón que no lleve a nada)", () => {
    render(<EscrowRentRecovery resolveSender={resolveSender} />);
    expect(
      screen.queryByRole("button", { name: /Recuperar el depósito de red/ }),
    ).not.toBeInTheDocument();
  });
});

describe("AC-8: qué se dice ANTES de abrir ningún diálogo de firma", () => {
  it("explica las DOS firmas y qué hace cada una, antes de cualquier acción", () => {
    abrirPuerta(new FakeSolanaCloseableEscrowLister([]));
    // La puerta está abierta y todavía no se apretó "Buscar": nada tocó la wallet.
    expect(screen.getByText(/es un texto, no mueve fondos y no paga comisión de red/)).toBeInTheDocument();
    expect(screen.getByText(/su comisión de red la pagás vos/)).toBeInTheDocument();
  });

  it("dice qué se recupera y qué NO, con la cifra del floor y sin las equivocadas", () => {
    abrirPuerta(new FakeSolanaCloseableEscrowLister([]));
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("0,0040");
    expect(texto).not.toContain("0,0041"); // ceil, o el umbral de depósito
    expect(texto).not.toContain("0,0047"); // floor del alquiler del índice
    expect(texto).not.toContain("0,0048"); // ceil del mismo
    expect(texto).not.toContain("0,0087"); // floor de la suma con el índice
    expect(texto).not.toContain("0,0088"); // ceil de la misma
    // Y nombra aparte la cuenta que NO se cierra.
    expect(screen.getByText(/tercera cuenta/)).toBeInTheDocument();
  });
});
