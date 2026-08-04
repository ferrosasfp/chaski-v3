import { describe, expect, it } from "vitest";
import { humanError } from "../flow-vm";
import { walletErrorCode } from "./wallet-error-code";

describe("walletErrorCode", () => {
  it("reusa los códigos que la UI ya sabía traducir, en vez de inventar sinónimos", () => {
    expect(walletErrorCode({ name: "WalletNotConnectedError" })).toBe("wallet_not_connected");
    expect(walletErrorCode({ name: "WalletDisconnectedError" })).toBe("wallet_not_connected");
    expect(walletErrorCode({ name: "WalletTimeoutError" })).toBe("wallet_connect_timeout");
  });

  it("distingue las causas que la librería sí distingue", () => {
    expect(walletErrorCode({ name: "WalletWindowClosedError" })).toBe("wallet_window_closed");
    expect(walletErrorCode({ name: "WalletWindowBlockedError" })).toBe("wallet_window_blocked");
    expect(walletErrorCode({ name: "WalletConnectionError" })).toBe("wallet_connect_failed");
  });

  // El punto del hallazgo original: un código que nadie reconoce NO puede evaporarse, porque
  // entonces el reporte desde un celular vuelve a quedar sin nada que buscar.
  it("un nombre desconocido conserva el nombre en el código, no se colapsa a un genérico", () => {
    expect(walletErrorCode({ name: "WalletFuturoError" })).toBe("wallet_error:WalletFuturoError");
  });

  it("acota el nombre: viene de una librería de terceros y termina en pantalla", () => {
    const code = walletErrorCode({ name: "W".repeat(300) });
    expect(code.length).toBeLessThanOrEqual("wallet_error:".length + 40);
  });

  it("un valor que no es un error tampoco rompe: da un código nombrable", () => {
    for (const raro of [null, undefined, "boom", 42, {}, { name: 7 }]) {
      expect(walletErrorCode(raro)).toBe("wallet_error:sin_nombre");
    }
  });

  it("NO afirma que la persona rechazó: la librería usa el mismo error para el rechazo y para un fallo interno", () => {
    const copy = humanError(walletErrorCode({ name: "WalletConnectionError" }));
    expect(copy).not.toMatch(/rechazaste|cancelaste/i);
    expect(copy).toMatch(/rechazado|falla|fallado/i);
  });

  // `WalletNotReadyError` YA NO tiene entrada propia, y este test lo fija. Su código mapeaba a
  // `no_wallet`, cuyo copy afirmaba qué wallet había instalada en el dispositivo (el navegador no lo
  // puede saber) y encima nadie podía leerlo: la app no llama `useWallet().connect()`, y el efecto de
  // autoConnect exige `Installed || Loadable` antes de tocar al adapter, que es la misma condición que
  // el adapter volvería a chequear para tirar esa excepción.
  //
  // Lo que se conserva es lo diagnosticable: el nombre sobrevive dentro del código que se muestra en
  // pantalla, igual que cualquier error nuevo de la librería.
  it("WalletNotReadyError sale por la rama de los nombres que no conocemos, con el nombre intacto", () => {
    expect(walletErrorCode({ name: "WalletNotReadyError" })).toBe(
      "wallet_error:WalletNotReadyError",
    );
    expect(humanError(walletErrorCode({ name: "WalletNotReadyError" }))).toContain(
      "no reconocemos",
    );
  });

  // El contrato con la otra mitad: si alguien agrega un código acá y se olvida del copy, esto se
  // pone rojo en vez de reaparecer en producción como "Algo salió mal".
  it("TODO código que produce este módulo tiene copy propio en humanError()", () => {
    const nombres = [
      "WalletNotReadyError",
      "WalletNotConnectedError",
      "WalletDisconnectedError",
      "WalletTimeoutError",
      "WalletWindowClosedError",
      "WalletWindowBlockedError",
      "WalletConnectionError",
      "WalletAccountError",
      "WalletPublicKeyError",
      "WalletLoQueVenga",
    ];
    for (const name of nombres) {
      expect(humanError(walletErrorCode({ name }))).not.toBe("Algo salió mal. Intentá de nuevo.");
    }
  });
});
