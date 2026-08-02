// Traduce un WalletError de @solana/wallet-adapter-base a un código interno estable.
// Módulo PURO a propósito (no importa React ni la lib): así se puede probar sin montar el árbol.
//
// Por qué existe: `WalletProvider.onError` es la ÚNICA fuente que sabe POR QUÉ falló una conexión.
// Sin esto, todo fallo de wallet terminaba en el timeout de 120 s o en un cancel genérico, y la
// pantalla decía "Algo salió mal" sin dejar rastro de la causa.

/** Nombres que la lib asigna en `error.name` (ver @solana/wallet-adapter-base/errors). */
const KNOWN_CODES: Readonly<Record<string, string>> = {
  // Reusamos los códigos que `humanError()` ya sabía traducir, para no duplicar copy.
  WalletNotReadyError: "no_wallet",
  WalletNotConnectedError: "wallet_not_connected",
  WalletDisconnectedError: "wallet_not_connected",
  WalletTimeoutError: "wallet_connect_timeout",
  // Códigos nuevos, con copy propio en humanError().
  WalletWindowClosedError: "wallet_window_closed",
  WalletWindowBlockedError: "wallet_window_blocked",
  WalletConnectionError: "wallet_connect_failed",
  WalletAccountError: "wallet_connect_failed",
  WalletPublicKeyError: "wallet_connect_failed",
};

/** Cota del código que puede llegar a verse en pantalla. No es cosmética: `error.name` viene de una
 *  librería de terceros y no queremos volcar un texto arbitrariamente largo en la UI. */
const MAX_NAME_LEN = 40;

/**
 * Devuelve un código interno estable para un error de wallet.
 *
 * DELIBERADAMENTE no intenta adivinar si la persona rechazó la conexión o si la wallet falló sola:
 * `WalletConnectionError` cubre las dos cosas y la librería no las distingue. Inventar la distinción
 * acá sería afirmar de más — el copy correspondiente nombra las dos posibilidades sin elegir una.
 *
 * Un nombre desconocido NO se colapsa a un genérico: se devuelve `wallet_error:<Nombre>` para que el
 * reporte de campo siga siendo diagnosticable aunque la librería agregue errores nuevos.
 */
export function walletErrorCode(err: unknown): string {
  const name =
    err && typeof err === "object" && typeof (err as { name?: unknown }).name === "string"
      ? (err as { name: string }).name
      : "";
  if (!name) return "wallet_error:sin_nombre";
  const known = Object.prototype.hasOwnProperty.call(KNOWN_CODES, name)
    ? KNOWN_CODES[name]
    : undefined;
  if (known) return known;
  return `wallet_error:${name.slice(0, MAX_NAME_LEN)}`;
}
