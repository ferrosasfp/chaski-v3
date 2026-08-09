// Traduce un WalletError de @solana/wallet-adapter-base a un código interno estable.
// Módulo PURO a propósito (no importa React ni la lib): así se puede probar sin montar el árbol.
//
// Por qué existe: `WalletProvider.onError` es la ÚNICA fuente que sabe POR QUÉ falló una conexión.
// Sin esto, todo fallo de wallet terminaba en el timeout de 120 s o en un cancel genérico, y la
// pantalla decía "Algo salió mal" sin dejar rastro de la causa.

/** Nombres que la lib asigna en `error.name` (ver @solana/wallet-adapter-base/errors). */
const KNOWN_CODES: Readonly<Record<string, string>> = {
  // Reusamos los códigos que `humanError()` ya sabía traducir, para no duplicar copy.
  //
  // ⚠️ `WalletNotReadyError` NO está acá, y su ausencia es deliberada. Mapeaba a `no_wallet`, cuyo copy
  // afirmaba sobre lo instalado en el dispositivo (imposible de saber desde el navegador) y además no
  // tenía forma de aparecer: esta app nunca llama `useWallet().connect()`, que es el único disparador
  // del throw de `WalletProviderBase.js`:238, y el efecto de autoConnect exige `Installed || Loadable`
  // antes de tocar al adapter — o sea, filtra de antemano la condición que haría tirar esa excepción.
  // Sin entrada acá, un `WalletNotReadyError` cae en `wallet_error:WalletNotReadyError`: la persona lee
  // que la wallet devolvió un error que no reconocemos y el código queda a la vista para diagnosticar.
  // Eso es exactamente lo que promete el docblock de `walletErrorCode` para cualquier nombre nuevo.
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
/** El `name` que la librería puso, o `""` si el throw no es un objeto con `name` (un `throw "boom"`).
 *  Extraído a una función porque ahora lo leen DOS consumidores y el defecto de fondo de WKH-339/CR era
 *  justamente que hubiera dos clasificadores del mismo dato. */
function nombreDe(err: unknown): string {
  return err && typeof err === "object" && typeof (err as { name?: unknown }).name === "string"
    ? (err as { name: string }).name
    : "";
}

/**
 * WKH-339/CR-BLQ-MED-1 — 🔴 EL ÚNICO NOMBRE QUE SIGNIFICA "LA BILLETERA YA FUE TOCADA".
 *
 * Es UNO, y está MEDIDO en los dos adapters que esta app puede llegar a usar. El `name` lo pone la
 * librería en el constructor de cada excepción — `this.name = 'WalletSignMessageError';` en
 * `node_modules/@solana/wallet-adapter-base/lib/cjs/errors.js:99` — así que es un dato estructural y
 * no una convención de mensajes. `WalletProvider` pasa por
 * `useStandardWalletAdapters`, que descarta el adapter legacy de Phantom porque Phantom se registra como
 * Wallet Standard ⇒ el que corre es `StandardWalletAdapter`. En los dos, todo lo que ocurre DESPUÉS de
 * pedirle la firma se envuelve en `WalletSignMessageError`, y todo lo ANTERIOR sale con otro nombre:
 *
 *   node_modules/@solana/wallet-standard-wallet-adapter-base/lib/cjs/adapter.js
 *     :396  throw new WalletNotConnectedError()      ← antes de tocar la billetera
 *     :400  throw new WalletAccountError()           ← antes de tocar la billetera
 *     :402  ...features[SolanaSignMessage].signMessage({...})   ← ACÁ se toca
 *     :409  throw new WalletSignMessageError(...)    ← envuelve TODO lo de :402
 *
 *   node_modules/@solana/wallet-adapter-phantom/lib/cjs/adapter.js
 *     :247  throw new WalletNotConnectedError()
 *     :249  await wallet.signMessage(message)        ← ACÁ se toca
 *     :253  throw new WalletSignMessageError(...)    ← envuelve TODO lo de :249
 *
 * ⚠️⚠️ Y ESTAS CITAS **EL CANDADO DEL REPO NO LAS PUEDE VER**, así que no te apoyes en su verde para
 * creerles. `citas-ancladas.test.ts:61` exige que la ruta matchee `[\w./-]*?`, y **`@` no está en esa
 * clase** ⇒ ninguna ruta bajo `@solana/…` puede ser una cita ANCLADA, por más bien escrita que esté. Es
 * exactamente el punto ciego que TD-CITAS-VALOR nombra ("una cita mal formada no existe para él y queda
 * en verde"), sólo que acá la forma es imposible, no un descuido.
 * ⇒ **quien las verifica es `validar-log-mio.cjs` de `doc/sdd/050-…`, por TEXTO**, y las cuatro líneas
 * de arriba (`:396`, `:400`, `:402`, `:409`) están ahí como tripletas. Si tocás `@solana`, corré ése.
 * (⚠️ el nombre de esa carpeta NO se escribe con el glob completo acá: la secuencia de cierre de comentario
 * que lleva adentro TERMINA este bloque. Lo aprendí rompiendo el archivo.)
 */
export const WALLET_SIGN_MESSAGE_ERROR = "WalletSignMessageError";

/**
 * ¿El error viene de haberle PEDIDO la firma a la billetera? Sólo entonces se le puede decir a la
 * persona que **su** firma no se completó.
 *
 * 🔴 ES UNA ALLOWLIST DE VERDAD, DE UN SOLO NOMBRE, y la diferencia con la versión anterior no es
 * cosmética: ahí el discriminante era `/^Wallet[A-Za-z]*Error$/` menos una lista de 5 excepciones, o sea
 * una **denylist**. MEDIDO con esa forma, SIETE nombres caían del lado que ACUSA sin que se hubiera
 * abierto ningún popup: `WalletAccountError` (que el standard adapter tira en `:400`, **antes** de la
 * firma), `WalletWindowBlockedError` (el popup lo bloqueó el NAVEGADOR, o sea que nunca se abrió),
 * `WalletTimeoutError`, `WalletConnectionError`, `WalletPublicKeyError`, `WalletDisconnectionError` y
 * —el que muestra que la dirección estaba invertida para toda la familia— **cualquier nombre nuevo**:
 * un `WalletFuturoError` inventado daba `"sin-firma"`.
 *
 * ⇒ con una allowlist de un nombre, un nombre nuevo de la librería cae **por construcción** del lado que
 * no culpa a nadie, que es lo que el docblock de `flow-vm.ts` afirmaba y el código contradecía.
 *
 * ⚠️ Y VIVE ACÁ, no en `flow-vm.ts`, porque este módulo YA era el dueño de la tabla de nombres
 * (`KNOWN_CODES`) y tener dos clasificadores del mismo `name` era el defecto de fondo: `KNOWN_CODES`
 * mapea `WalletAccountError` a `wallet_connect_failed` —o sea "fallo de conexión"— mientras el otro
 * clasificador lo leía como "la firma no se completó". Dos módulos del mismo repo contradiciéndose sobre
 * el mismo dato. ⛔ No agregues un segundo lugar donde se decida por `name`.
 */
export function laBilleteraFueTocada(err: unknown): boolean {
  return nombreDe(err) === WALLET_SIGN_MESSAGE_ERROR;
}

export function walletErrorCode(err: unknown): string {
  const name = nombreDe(err);
  if (!name) return "wallet_error:sin_nombre";
  const known = Object.prototype.hasOwnProperty.call(KNOWN_CODES, name)
    ? KNOWN_CODES[name]
    : undefined;
  if (known) return known;
  return `wallet_error:${name.slice(0, MAX_NAME_LEN)}`;
}
