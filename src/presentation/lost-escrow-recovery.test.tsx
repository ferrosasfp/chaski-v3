// @vitest-environment jsdom
//
// LA PUERTA QUE NO EXISTÍA.
//
// La recuperación durable estaba ENTERA y sin un solo consumidor:
//   · `POST /api/solana/escrow/remittance-ids` está vivo en producción (medido: responde 403
//     `escrow_recovery_unverified` sin PoP),
//   · `refundEscrow()` acepta el id ausente y lo resuelve contra ese endpoint sondeando hasta
//     `MAX_RECOVERY_CANDIDATES` PDAs (`resolveRemittanceIdFromLedger`, `solana-wallet.ts:286`),
//   · el gateway está cableado en el composition root (`solanaRefund`, `container.ts:150`).
// Y la interfaz llamaba únicamente a `recoverEscrowFunds`, que arranca con `repo.get(remittanceId)` y
// tira `remittance_not_found` (`recover-escrow-funds.ts`:49-50). O sea: quien borró los datos del
// navegador, o entra desde otro dispositivo, no tenía NINGÚN camino hacia sus USDC.
//
// Lo que estos tests clavan, en orden de importancia:
//   1. que la llamada sale SIN remittanceId (es lo único que dispara la resolución durable);
//   2. que la pantalla dice qué se va a firmar ANTES de que aparezca ningún diálogo;
//   3. que "no encontramos nada" NUNCA se dice como "no tenés fondos".
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LostEscrowRecovery, RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { MAX_RECOVERY_CANDIDATES } from "../infrastructure/solana-wallet";
import {
  FAKE_SOLANA_BENEFICIARY,
  FAKE_SOLANA_SIGNATURE,
  FakeSolanaEscrowRefundGateway,
  FakeSolanaWallet,
} from "../test-support/fakes";

afterEach(cleanup);

const sender = FAKE_SOLANA_BENEFICIARY;
const resolveSender = async () => sender;

/** Abre la tarjeta (el paso que muestra el texto) y devuelve el gateway para inspeccionar llamadas. */
function abrirPuerta(gateway: FakeSolanaEscrowRefundGateway) {
  render(<LostEscrowRecovery refund={gateway} resolveSender={resolveSender} />);
  fireEvent.click(screen.getByRole("button", { name: /Recuperar un envío perdido/ }));
}

describe("recuperar un envío perdido: la llamada", () => {
  // EL test. Con `remittanceId` presente el adapter NO consulta el resolver (path byte-idéntico al
  // que ya andaba): la ausencia del campo es literalmente lo que enciende la recuperación durable.
  it("llama al gateway SIN remittanceId, que es lo que dispara la resolución contra el servidor", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway();
    abrirPuerta(gateway);

    fireEvent.click(screen.getByRole("button", { name: /Buscar mis escrows/ }));

    await waitFor(() => expect(gateway.calls).toHaveLength(1));
    expect(gateway.calls[0]).toEqual({ sender });
    expect(gateway.calls[0]?.remittanceId).toBeUndefined();
  });

  it("con la cadena confirmando, dice que volvieron y muestra el comprobante", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway();
    abrirPuerta(gateway);

    fireEvent.click(screen.getByRole("button", { name: /Buscar mis escrows/ }));

    expect(await screen.findByText(/Recuperaste tus fondos/)).toBeInTheDocument();
    expect(screen.getByText(/Tus USDC volvieron a tu wallet/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(FAKE_SOLANA_SIGNATURE))).toBeInTheDocument();
  });

  // El tercer valor: el RPC aceptó la transacción y nadie la vio confirmada. Es el MISMO texto que la
  // otra puerta, y por eso vive en un solo componente.
  it.each([["pending"], ["unknown"]] as const)(
    "confirmation=%s: dice que la orden se envió, NUNCA que la plata volvió",
    async (confirmation) => {
      const gateway = new FakeSolanaEscrowRefundGateway(
        FAKE_SOLANA_SIGNATURE,
        "resolve",
        confirmation,
      );
      abrirPuerta(gateway);

      fireEvent.click(screen.getByRole("button", { name: /Buscar mis escrows/ }));

      expect(await screen.findByText(/Enviamos la orden de recuperación/)).toBeInTheDocument();
      expect(screen.queryByText(/Recuperaste tus fondos/)).toBeNull();
      expect(screen.queryByText(/Tus USDC volvieron a tu wallet/)).toBeNull();
    },
  );
});

describe("recuperar un envío perdido: lo que se dice antes de firmar", () => {
  // La persona va a ver DOS diálogos de firma de su billetera, por dos motivos distintos. Una app que
  // los abre sin haber dicho qué se firma entrena a la gente a firmar cualquier cosa.
  it("nombra las dos firmas y para qué es cada una, ANTES de tocar el gateway", () => {
    const gateway = new FakeSolanaEscrowRefundGateway();
    render(<LostEscrowRecovery refund={gateway} resolveSender={resolveSender} />);

    // Cerrada: todavía no se explicó nada, así que tampoco hay acción que dispare una firma.
    expect(screen.queryByRole("button", { name: /Buscar mis escrows/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Recuperar un envío perdido/ }));

    expect(screen.getByText(/una firma para probar que es tuya: es un texto/)).toBeInTheDocument();
    expect(screen.getByText(/no mueve fondos y no paga comisión de red/)).toBeInTheDocument();
    expect(
      screen.getByText(/una segunda firma, y esa sí es la transacción que saca tus USDC/),
    ).toBeInTheDocument();
    // Y el texto está en pantalla ANTES de que nada haya llamado al gateway.
    expect(gateway.calls).toHaveLength(0);
  });

  it("dice de dónde sale la lista que NO la tiene, que es el motivo de esta puerta", () => {
    abrirPuerta(new FakeSolanaEscrowRefundGateway());
    expect(
      screen.getByText(/Si borraste los datos del navegador o entrás desde otro dispositivo/),
    ).toBeInTheDocument();
  });
});

describe("recuperar un envío perdido: qué se dice cuando no aparece nada", () => {
  // 🔴 El error más caro de esta pantalla. `escrow_not_found` acá NO prueba que la persona no tenga
  // fondos: sale de "el servidor no devolvió ids" o de "ninguno de los sondeados estaba Deposited".
  it("no afirma que no tenga fondos: dice sobre cuántos envíos miramos", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway(
      FAKE_SOLANA_SIGNATURE,
      "reject",
      "confirmed",
      "escrow_not_found",
    );
    abrirPuerta(gateway);

    fireEvent.click(screen.getByRole("button", { name: /Buscar mis escrows/ }));

    const msg = await screen.findByText(/No encontramos escrows abiertos para esta billetera/);
    expect(msg).toBeInTheDocument();
    expect(msg).toHaveTextContent("Esto no dice que no tengas fondos");
    // El número sale de la MISMA constante que sondea, no de un literal escrito en el copy.
    expect(msg).toHaveTextContent(`los últimos ${MAX_RECOVERY_CANDIDATES} envíos`);
    // Y no se recicla el copy de la otra puerta, que sí habla de un depósito concreto.
    expect(screen.queryByText(/No encontramos un depósito tuyo en el escrow/)).toBeNull();
  });

  // "No pudimos preguntar" no es "no hay nada". Es el mismo criterio del tri-estado del money-path.
  it("si no pudimos consultar el registro, lo dice como lo que es: no llegamos a preguntar", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway(
      FAKE_SOLANA_SIGNATURE,
      "reject",
      "confirmed",
      "escrow_recovery_unavailable",
    );
    abrirPuerta(gateway);

    fireEvent.click(screen.getByRole("button", { name: /Buscar mis escrows/ }));

    const msg = await screen.findByText(/No pudimos consultar el registro de envíos/);
    expect(msg).toHaveTextContent("no llegamos a preguntar");
    expect(screen.queryByText(/No encontramos escrows abiertos/)).toBeNull();
  });
});

describe("recuperar un envío perdido: la puerta en el recorrido", () => {
  // Vive en `send` porque es donde aterriza toda recarga y adonde vuelve "Enviar otra". Quien llega
  // desde otro dispositivo ve esta pantalla y ninguna otra.
  it("está en `send`, al lado de 'Ver mis envíos'", () => {
    const container = buildTestContainer({
      wallet: new FakeSolanaWallet(),
      solanaRefund: new FakeSolanaEscrowRefundGateway(),
    });
    render(<RemittanceFlow container={container} />);

    expect(screen.getByRole("button", { name: /Ver mis envíos/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Recuperar un envío perdido/ })).toBeInTheDocument();
  });

  // Sin gateway cableado no se ofrece una puerta que no lleva a ningún lado.
  it("sin gateway de refund no se muestra", () => {
    render(<RemittanceFlow container={buildTestContainer()} />);
    expect(screen.queryByRole("button", { name: /Recuperar un envío perdido/ })).toBeNull();
  });

  // El PoP se firma con la wallet del sender, así que la address tiene que salir de la wallet
  // conectada y no de un campo que alguien tipea. Si se rompe el cableado, la llamada sale con otra.
  it("el sender sale de la wallet conectada, no de un input", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway();
    const container = buildTestContainer({
      wallet: new FakeSolanaWallet(),
      solanaRefund: gateway,
    });
    render(<RemittanceFlow container={container} />);

    fireEvent.click(screen.getByRole("button", { name: /Recuperar un envío perdido/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Buscar mis escrows/ }));

    await waitFor(() => expect(gateway.calls).toHaveLength(1));
    expect(gateway.calls[0]?.sender).toBe(FAKE_SOLANA_BENEFICIARY);
  });

  it("no mete un em dash en el recorrido", () => {
    abrirPuerta(new FakeSolanaEscrowRefundGateway());
    expect(document.body.textContent ?? "").not.toContain("—");
  });
});
