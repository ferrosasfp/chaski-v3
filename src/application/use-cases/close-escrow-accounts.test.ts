// Tests — CloseEscrowAccounts (WKH-327 / AC-7 guard, AC-5 propagación).
//
// Lo que este archivo cuida son dos cosas que se rompen en silencio: (a) que la acción NO se dispare
// desde una billetera que no es la del remitente, y (b) que el desenlace de tres valores llegue al
// caller SIN traducirse ni defaultearse. Las dos fallan con la suite en verde si los tests miran sólo
// el mensaje de error o sólo el camino feliz.
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { FakeConnectedWallet, FakeSolanaEscrowCloseGateway } from "../../test-support/fakes";
import { CloseEscrowAccounts } from "./close-escrow-accounts";

const SENDER = Keypair.generate().publicKey.toBase58();
const OTRA_BILLETERA = Keypair.generate().publicKey.toBase58();

describe("CloseEscrowAccounts — AC-7: sólo cierra quien pagó el alquiler", () => {
  // 🔴 Las DOS aserciones, y la segunda es la que importa: un mutante que llame al gateway y DESPUÉS
  // tire pasa el `rejects.toThrow` igual. Ese mutante ya habría hecho firmar una tx.
  it("una billetera distinta del sender ⇒ close_not_sender, con el gateway en 0 llamadas", async () => {
    const gw = new FakeSolanaEscrowCloseGateway();
    const uc = new CloseEscrowAccounts(gw, new FakeConnectedWallet(OTRA_BILLETERA));

    await expect(uc.execute({ remittanceId: "rem-1", sender: SENDER })).rejects.toThrow(
      "close_not_sender",
    );
    expect(gw.calls).toHaveLength(0);
  });

  it("la MISMA billetera ⇒ llama al gateway con el id y el sender tal cual", async () => {
    const gw = new FakeSolanaEscrowCloseGateway();
    const uc = new CloseEscrowAccounts(gw, new FakeConnectedWallet(SENDER));

    await uc.execute({ remittanceId: "rem-1", sender: SENDER });
    expect(gw.calls).toEqual([{ remittanceId: "rem-1", sender: SENDER }]);
  });

  // 🚫 CD-13. base58 es CASE-SENSITIVE: `SENDER` y `SENDER.toLowerCase()` son dos addresses distintas,
  // y una comparación con `.toLowerCase()` las haría iguales — que es la colisión IDOR que
  // `canonicalizeAddress` existe para cerrar. Si alguien "arregla" el guard con toLowerCase, este test
  // se pone rojo por la razón correcta.
  it("la misma address con OTRA capitalización NO es la misma address (sin toLowerCase)", async () => {
    const gw = new FakeSolanaEscrowCloseGateway();
    const uc = new CloseEscrowAccounts(gw, new FakeConnectedWallet(SENDER.toLowerCase()));

    await expect(uc.execute({ remittanceId: "rem-1", sender: SENDER })).rejects.toThrow(
      "close_not_sender",
    );
    expect(gw.calls).toHaveLength(0);
  });

  // La decisión sobre una address basura, escrita como test para que no quede al azar: no se deja
  // salir `address_canonicalization_failed`, se responde el mismo close_not_sender fail-closed.
  it("una address que ni siquiera parsea ⇒ close_not_sender, no un error de parseo, y 0 llamadas", async () => {
    const gw = new FakeSolanaEscrowCloseGateway();
    const uc = new CloseEscrowAccounts(gw, new FakeConnectedWallet("no-soy-una-address"));

    await expect(uc.execute({ remittanceId: "rem-1", sender: SENDER })).rejects.toThrow(
      "close_not_sender",
    );
    expect(gw.calls).toHaveLength(0);
  });

  // Fix-pack AR/BLQ-BAJO-1. Sin billetera conectada NO se puede afirmar que el envío sea de otra:
  // son dos situaciones distintas y la persona hace cosas distintas con cada una (reconectar vs.
  // cambiar de cuenta). Colapsarlas en `close_not_sender` la manda a buscar un problema que no tiene.
  it("sin ninguna billetera conectada ⇒ wallet_not_connected (NO close_not_sender), y 0 llamadas", async () => {
    const gw = new FakeSolanaEscrowCloseGateway();
    const uc = new CloseEscrowAccounts(gw, new FakeConnectedWallet(null));

    await expect(uc.execute({ remittanceId: "rem-1", sender: SENDER })).rejects.toThrow(
      "wallet_not_connected",
    );
    expect(gw.calls).toHaveLength(0);
  });

  // 🔴 El control que impide que el guard vuelva a compararse consigo mismo. Si alguien "simplifica"
  // el use-case usando `input.sender` como la dirección conectada, la comparación vuelve a ser
  // `x === x`, el caso de arriba (billetera distinta) sigue en verde SÓLO si el doble se consulta —
  // y este test se pone rojo porque el puerto nunca se llamó.
  it("el guard CONSULTA la billetera viva: no se compara con el argumento que recibió", async () => {
    const gw = new FakeSolanaEscrowCloseGateway();
    const billetera = new FakeConnectedWallet(SENDER);
    const uc = new CloseEscrowAccounts(gw, billetera);

    await uc.execute({ remittanceId: "rem-1", sender: SENDER });
    expect(billetera.calls).toBe(1);
  });

  // Y el que ata las dos mitades: la MISMA instancia, dos clicks, y en el medio la persona cambia de
  // cuenta. El primero pasa y el segundo no. Un use-case que leyera la billetera una sola vez (o que
  // la recibiera congelada del llamador) dejaría pasar los dos.
  it("cambiar de billetera entre dos ejecuciones cambia el desenlace del guard", async () => {
    const gw = new FakeSolanaEscrowCloseGateway();
    const billetera = new FakeConnectedWallet(SENDER);
    const uc = new CloseEscrowAccounts(gw, billetera);

    await uc.execute({ remittanceId: "rem-1", sender: SENDER });
    expect(gw.calls).toHaveLength(1);

    billetera.switchTo(OTRA_BILLETERA); // como cambiar de cuenta en Phantom sin recargar
    await expect(uc.execute({ remittanceId: "rem-1", sender: SENDER })).rejects.toThrow(
      "close_not_sender",
    );
    expect(gw.calls).toHaveLength(1); // el segundo NO llegó al gateway: 0 firmas nuevas
  });
});

describe("CloseEscrowAccounts — AC-5: el desenlace llega SIN traducirse", () => {
  // Los TRES valores, uno por uno. Con sólo el caso "confirmed" un mutante que defaultee a "confirmed"
  // sobrevive: es el mismo default que borraría la única lectura que prueba algo.
  for (const confirmation of ["confirmed", "pending", "unknown"] as const) {
    it(`confirmation="${confirmation}" del gateway ⇒ el use-case devuelve exactamente "${confirmation}"`, async () => {
      const gw = new FakeSolanaEscrowCloseGateway("sig-close", "resolve", confirmation);
      const uc = new CloseEscrowAccounts(gw, new FakeConnectedWallet(SENDER));

      await expect(uc.execute({ remittanceId: "rem-1", sender: SENDER })).resolves.toEqual({
        closeTx: "sig-close",
        confirmation,
      });
    });
  }

  it("un fracaso MEDIDO del gateway sube tal cual: no se convierte en un tri-estado", async () => {
    const gw = new FakeSolanaEscrowCloseGateway("sig", "reject", "confirmed", "close_tx_failed");
    const uc = new CloseEscrowAccounts(gw, new FakeConnectedWallet(SENDER));

    await expect(uc.execute({ remittanceId: "rem-1", sender: SENDER })).rejects.toThrow(
      "close_tx_failed",
    );
  });
});
