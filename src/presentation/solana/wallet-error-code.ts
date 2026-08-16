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

/**
 * WKH-MWA · El `name` que la librería de Mobile Wallet Adapter le pone a SUS excepciones.
 *
 * No es una convención de mensajes: `SolanaMobileWalletAdapterError` es una clase con su propio
 * `name` y un `code` de un enum cerrado.
 */
export const MWA_ERROR_NAME = "SolanaMobileWalletAdapterError";

/**
 * WKH-MWA · Los códigos que el paquete INSTALADO declara, copiados de su propia declaración de tipos:
 * `@solana-mobile/mobile-wallet-adapter-protocol/lib/types/index.d.ts:6-16`.
 *
 * ⛔ NO ES UN CATÁLOGO INVENTADO NI AMPLIABLE A OJO. Son los once, ni uno más. Si mañana la librería
 * agrega uno, `mwaErrorCode` igual lo va a dejar pasar —el `Set` sólo decide si el string es *conocido*,
 * y un código nuevo cae en la rama que NO afirma causa (ver `mwaHumanError`)— pero el texto propio hay
 * que escribirlo a mano leyendo qué significa, nunca adivinándolo del nombre.
 *
 * ⚠️ Y ESTA LISTA NO LA PUEDE VIGILAR `citas-ancladas.test.ts`: su regexp de rutas
 * (`citas-ancladas.test.ts:61`) no admite `@`, así que ninguna ruta bajo `@solana-mobile/…` puede ser
 * una cita anclada. Quien la vigila es `T-ERR-1`, que compara este `Set` contra el enum REAL importado
 * del paquete: si divergen, se pone rojo.
 */
export const MWA_CODES: ReadonlySet<string> = new Set([ // exportado SOLO para T-ERR-1, que lo compara contra el enum real del paquete
  "ERROR_ASSOCIATION_PORT_OUT_OF_RANGE",
  "ERROR_REFLECTOR_ID_OUT_OF_RANGE",
  "ERROR_FORBIDDEN_WALLET_BASE_URL",
  "ERROR_SECURE_CONTEXT_REQUIRED",
  "ERROR_SESSION_CLOSED",
  "ERROR_SESSION_TIMEOUT",
  "ERROR_WALLET_NOT_FOUND",
  "ERROR_INVALID_PROTOCOL_VERSION",
  "ERROR_BROWSER_NOT_SUPPORTED",
  "ERROR_LOOPBACK_ACCESS_BLOCKED",
  "ERROR_ASSOCIATION_CANCELLED",
]);

/** Tope de profundidad al recorrer la cadena. No es paranoia: una cadena ciclada colgaría el render. */
const MAX_PROF = 6;

/**
 * WKH-MWA · Busca un `SolanaMobileWalletAdapterError` ADENTRO de la cadena de causas y devuelve su
 * `code`.
 *
 * 🔴 POR QUÉ HAY QUE BAJAR Y NO ALCANZA CON MIRAR EL `name` DE ARRIBA. La cadena está MEDIDA, no
 * supuesta: se capturó el error real que emite el adapter instalado y su forma es
 *
 *     [0] WalletConnectionError          claves propias: error, name
 *     [1] Error                          (llegado por `.cause`)
 *     [2] Error                          (llegado por `.cause`)
 *     [3] SolanaMobileWalletAdapterError  code=ERROR_LOOPBACK_ACCESS_BLOCKED
 *
 * O sea que el `name` de arriba es SIEMPRE `WalletConnectionError`, que `KNOWN_CODES` mapea a
 * `wallet_connect_failed` = "puede que la hayas rechazado, o que la wallet haya fallado". Los once
 * códigos distintos se colapsaban en esa sola frase, y cada uno pide una acción distinta.
 *
 * SE RECORREN LOS DOS CAMPOS, y hacen falta los dos: `WalletError` de `@solana/wallet-adapter-base`
 * guarda la causa en `.error` (por eso `[0]` tiene esa clave propia), y `wallet-standard-mobile` usa
 * el `.cause` estándar de `Error`. Seguir uno solo no llega a `[3]`.
 */
export function mwaErrorCode(err: unknown, prof = 0): string | null {
  if (!err || typeof err !== "object" || prof > MAX_PROF) return null;
  const o = err as { name?: unknown; code?: unknown; error?: unknown; cause?: unknown };
  if (o.name === MWA_ERROR_NAME && typeof o.code === "string" && o.code) {
    // El `slice` es el mismo motivo que `MAX_NAME_LEN`: el string viene de un tercero y puede terminar
    // en pantalla.
    return o.code.slice(0, MAX_NAME_LEN);
  }
  return mwaErrorCode(o.error, prof + 1) ?? (o.cause === o.error ? null : mwaErrorCode(o.cause, prof + 1));
}

export function walletErrorCode(err: unknown): string {
  // PRIMERO la cadena de MWA, y el orden NO es intercambiable: si esto fuera después, el `name` de la
  // envoltura (`WalletConnectionError`) ganaría siempre y ningún código de MWA llegaría nunca a verse.
  const mwa = mwaErrorCode(err);
  if (mwa) return `mwa:${mwa}`;
  const name = nombreDe(err);
  if (!name) return "wallet_error:sin_nombre";
  const known = Object.prototype.hasOwnProperty.call(KNOWN_CODES, name)
    ? KNOWN_CODES[name]
    : undefined;
  if (known) return known;
  return `wallet_error:${name.slice(0, MAX_NAME_LEN)}`;
}

/**
 * WKH-MWA · Qué lee la persona cuando la conexión por Mobile Wallet Adapter falla.
 *
 * 🔴 LA REGLA DE ESTE MAPA, y es la que hay que respetar al agregarle una entrada: **sólo tiene texto
 * propio el código cuyo significado se puede afirmar leyendo la librería, Y que pide una acción
 * distinta de la persona.** Todo lo demás cae al default, que dice que la conexión falló y NO afirma
 * por qué. El precedente del repo es no acusar cuando no se sabe: es la misma decisión por la que
 * `wallet_connect_failed` nombra las dos posibilidades sin elegir una.
 *
 * Por eso acá hay SIETE entradas y no once. Las cuatro que faltan
 * —`ERROR_ASSOCIATION_PORT_OUT_OF_RANGE`, `ERROR_REFLECTOR_ID_OUT_OF_RANGE`,
 * `ERROR_FORBIDDEN_WALLET_BASE_URL`, `ERROR_INVALID_PROTOCOL_VERSION`— son fallas internas del
 * protocolo frente a las que la persona no puede hacer nada distinto, y darles un texto propio sería
 * inventar una acción. Caen al default CON EL CÓDIGO A LA VISTA, que es lo que sirve para
 * diagnosticar. Lo mismo vale para los códigos numéricos del otro enum del paquete
 * (el enum `SolanaMobileWalletAdapterProtocolErrorCode`, líneas 47-52 del mismo `index.d.ts` — sin backticks alrededor del número a propósito: con ellos `citas-ancladas.test.ts` lo lee como una cita a ESTE archivo, y una ruta con `@` no puede ser una cita anclada): no se enumeran acá
 * porque ninguno describe algo que la persona pueda corregir desde la pantalla.
 *
 * ⛔ NINGUNO DE ESTOS TEXTOS DICE "CANCELASTE", con UNA excepción medida: `ERROR_ASSOCIATION_CANCELLED`,
 * que es el único de los once que significa que la cancelación ocurrió, y ocurrió EN LA BILLETERA. Ése
 * es justamente el punto de toda esta HU: hasta acá los once decían "se cerró el selector".
 */
export function mwaHumanError(code: string): string {
  const bruto = code.startsWith("mwa:") ? code.slice(4) : code;
  switch (bruto) {
    case "ERROR_LOOPBACK_ACCESS_BLOCKED":
      return "Tu navegador bloqueó el permiso de red local, que es el que Chaski necesita para hablar con la app de tu billetera. Volver a intentar sin darlo va a fallar igual: abrí los permisos del sitio en Chrome, permití el acceso a la red local y recién ahí probá de nuevo.";
    case "ERROR_WALLET_NOT_FOUND":
      return "Ninguna app de billetera respondió en este teléfono. Si tenés Phantom instalada, abrí Chaski desde el navegador de Phantom con el enlace de la pantalla anterior.";
    case "ERROR_ASSOCIATION_CANCELLED":
      return "Se canceló la conexión desde la app de tu billetera. Volvé a intentar y aceptá la conexión ahí.";
    case "ERROR_SECURE_CONTEXT_REQUIRED":
      return "Esta página no está en https, y la conexión con la app de tu billetera solo funciona en https. Abrí Chaski por su dirección segura y volvé a intentar.";
    case "ERROR_BROWSER_NOT_SUPPORTED":
      return "Este navegador no puede abrir la app de tu billetera. Probá desde Chrome, o abrí Chaski adentro del navegador de Phantom.";
    case "ERROR_SESSION_TIMEOUT":
      return "La app de tu billetera no respondió a tiempo. Abrila, dejala en primer plano y volvé a intentar.";
    case "ERROR_SESSION_CLOSED":
      return "Se cortó la conexión con la app de tu billetera antes de terminar. Volvé a intentar sin cerrar la app.";
    default:
      // No sabemos qué pasó, y eso es lo que se dice. El código va a la vista para diagnosticar, igual
      // que hace `wallet_error:<Nombre>` con un nombre que no conocemos.
      return `No se pudo conectar con la app de tu billetera. No sabemos por qué: la billetera devolvió ${bruto}. Volvé a intentar, y si vuelve a pasar abrí Chaski adentro del navegador de Phantom.`;
  }
}
