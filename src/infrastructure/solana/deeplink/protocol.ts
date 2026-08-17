/**
 * OLA 1 · EL PROTOCOLO DE ENLACES PROFUNDOS DE PHANTOM Y SOLFLARE, SIN NADA MÁS.
 *
 * 🔴 QUÉ PROBLEMA VIENE A RESOLVER TODA ESTA CARPETA. En un navegador de celular no hay ninguna
 * billetera inyectada. Hasta hoy la única salida de Chaski era mandar a la persona al navegador
 * INTERNO de Phantom, y eso tiene dos costos que se sienten:
 *   · el navegador de Phantom es OTRO contexto de almacenamiento, así que el borrador de la remesa
 *     (monto, nombre, 20 dígitos de CCI) no viaja y hay que cargarlo de nuevo;
 *   · una app que se puede INSTALAR en el teléfono y que después te manda al navegador de otra app
 *     no es una DApp instalable, es un atajo con disfraz.
 *
 * Los enlaces profundos son la otra salida: la persona se va a la APP de su billetera, autoriza ahí,
 * y vuelve. Según la documentación de Phantom y de Solflare, el enlace universal `https://` abre la
 * app instalada tanto en iOS como en Android desde cualquier navegador. **[NO VERIFICADO]**: nadie
 * de este equipo lo corrió en un teléfono, y el work-item de esta HU dice lo contrario para un caso
 * concreto (RIESGO-1: en iOS una PWA instalada puede NO capturar el universal link de vuelta, y la
 * vuelta cae en Safari). Se eligió esta vía frente a Mobile Wallet Adapter, que según la
 * documentación de Solana Mobile **no existe en ningún navegador de iOS** y en Android sólo anda en
 * Chrome.
 *
 * ⚠️ POR QUÉ EL ESTADO DEBERÍA SOBREVIVIR, que es lo que haría viable todo esto: el `redirect_link`
 * apunta a NUESTRO PROPIO ORIGEN, y `localStorage` es por origen. **[NO VERIFICADO]** que la
 * billetera abra una pestaña nueva en web móvil y que esa pestaña conserve el origen: las dos son
 * afirmaciones sobre el runtime de un teléfono y acá no corre ninguno. Lo que sí es decisión de este
 * código: la memoria en RAM no sobrevive a la navegación, así que ninguna promesa de este módulo la
 * cruza. Cada viaje se corta acá y se retoma leyendo la URL de vuelta más el disco.
 *
 * ══ LO QUE ESTE ARCHIVO ES Y LO QUE NO ES ═══════════════════════════════════════════════════════
 * ES: armar URLs y abrir/cerrar los sobres cifrados. Funciones puras, sin `window`, sin `fetch`, sin
 * estado. Por eso se puede probar entera y por eso vive separada del transporte.
 * NO ES: la máquina de estados del viaje, ni dónde se guarda el secreto, ni la pantalla. Eso es de
 * las olas siguientes, y cada una tiene su propio archivo.
 *
 * ⛔ NO se implementa `signAndSendTransaction`, y la omisión es la decisión: el depósito de Chaski es
 * PATROCINADO. El facilitator es el `feePayer`, la billetera firma PARCIALMENTE y el broadcast lo
 * hace el facilitator después de verificar. Que la billetera lo mandara sola rompería ese diseño.
 * Las dos billeteras separan los dos métodos, y Solflare lo dice explícito: con `signTransaction`
 * "no envía la transacción", la manda la app.
 */
import nacl from "tweetnacl";
import bs58 from "bs58";

/** Las dos billeteras que hablan este protocolo. Los dos lo implementan igual salvo un nombre. */
export type BilleteraDeeplink = "phantom" | "solflare";

/**
 * Base de los enlaces universales de cada una.
 *
 * ⚠️ Se usa la forma `https://` y NO el esquema propio (`phantom://`), que la documentación de
 * Phantom marca como desaconsejado. Y para una web hay una razón adicional: un esquema propio que
 * NADIE tiene registrado deja al navegador sin nada que abrir y el toque no hace absolutamente nada,
 * que es exactamente el síntoma que ya nos costó una tarde con Mobile Wallet Adapter.
 */
const BASE: Record<BilleteraDeeplink, string> = {
  phantom: "https://phantom.app/ul/v1",
  solflare: "https://solflare.com/ul/v1",
};

/**
 * Cómo se llama, en la respuesta, la clave pública que puso la billetera.
 *
 * Es LO ÚNICO que difiere entre los dos protocolos. Tenerlo en un mapa y no en un `if` es lo que
 * permite que el resto del archivo no sepa con cuál está hablando.
 */
const CLAVE_EN_RESPUESTA: Record<BilleteraDeeplink, string> = {
  phantom: "phantom_encryption_public_key",
  solflare: "solflare_encryption_public_key",
};

/**
 * TODO lo que una billetera escribe en la URL de vuelta.
 *
 * Existe para que `enlaceDeVuelta` pueda BORRARLOS del origen antes de armar el `redirect_link`: si
 * el origen ya trae la respuesta de un salto anterior y la billetera AGREGA los suyos en vez de
 * reemplazarlos, `URLSearchParams.get` devuelve el PRIMERO, o sea el viejo. Si la billetera agrega o
 * reemplaza es **[NO VERIFICADO]** (lo prueba un teléfono), y por eso no se decide suponiendo: se
 * limpia siempre, que es correcto en los dos casos.
 */
export const PARAMS_DE_RESPUESTA: readonly string[] = [
  ...Object.values(CLAVE_EN_RESPUESTA),
  "nonce",
  "data",
  "errorCode",
  "errorMessage",
];

/**
 * La clave pública de cifrado que la billetera puso en ESTA URL, o `null` si acá no hay ninguna.
 *
 * Se exporta porque `sesion.ts` necesita compararla contra la que fijó en el connect, y el nombre
 * del parámetro (lo único que difiere entre las dos billeteras) vive acá.
 */
export function clavePublicaEnRespuesta(
  billetera: BilleteraDeeplink,
  params: URLSearchParams,
): string | null {
  return params.get(CLAVE_EN_RESPUESTA[billetera]);
}

/** El par efímero de cifrado de la app. La clave secreta NUNCA sale de este dispositivo. */
export interface ParDeCifrado {
  publica: Uint8Array;
  secreta: Uint8Array;
}

/**
 * Un par nuevo por sesión, como recomiendan las dos documentaciones.
 *
 * ⚠️ Esto NO es la billetera de nadie ni firma nada: es sólo el canal cifrado entre esta pestaña y
 * la app de la billetera. Perderlo no pierde fondos; obliga a volver a conectar.
 */
export function nuevoParDeCifrado(): ParDeCifrado {
  const par = nacl.box.keyPair();
  return { publica: par.publicKey, secreta: par.secretKey };
}

/** El secreto compartido Diffie-Hellman, una vez que la billetera contestó con su clave pública. */
export function secretoCompartido(clavePublicaBilletera: string, secretaDeLaApp: Uint8Array): Uint8Array {
  return nacl.box.before(bs58.decode(clavePublicaBilletera), secretaDeLaApp);
}

/** Lo que hay que saber para armar cualquier pedido. */
export interface DatosDelPedido {
  billetera: BilleteraDeeplink;
  /** URL de la app, para que la billetera muestre título e ícono en el diálogo. */
  appUrl: string;
  /** A dónde vuelve la persona. Tiene que ser de NUESTRO origen: de ahí sale que el estado sobreviva. */
  redirectLink: string;
}

/**
 * PASO 1 · Conectar. Es el único pedido que NO va cifrado: todavía no hay secreto compartido.
 *
 * `cluster` va explícito porque el default de las dos billeteras es `mainnet-beta`, y Chaski está en
 * devnet. Omitirlo haría que la persona autorice sobre la red equivocada.
 */
export function urlConectar(
  d: DatosDelPedido & { clavePublicaDeLaApp: Uint8Array; cluster: string },
): string {
  const q = new URLSearchParams({
    app_url: d.appUrl,
    dapp_encryption_public_key: bs58.encode(d.clavePublicaDeLaApp),
    redirect_link: d.redirectLink,
    cluster: d.cluster,
  });
  return `${BASE[d.billetera]}/connect?${q.toString()}`;
}

/** Lo que se necesita para cualquier pedido POSTERIOR al connect: hay secreto y hay sesión. */
export interface DatosDeSesion extends DatosDelPedido {
  clavePublicaDeLaApp: Uint8Array;
  secreto: Uint8Array;
  /** Opaco. Lo devolvió la billetera al conectar y hay que reenviárselo tal cual. */
  session: string;
}

/** Mete un objeto en un sobre cifrado y devuelve los dos parámetros que viajan en la URL. */
function sobre(payload: unknown, secreto: Uint8Array): { nonce: string; payload: string } {
  const nonce = nacl.randomBytes(24);
  const cerrado = nacl.box.after(new TextEncoder().encode(JSON.stringify(payload)), nonce, secreto);
  return { nonce: bs58.encode(nonce), payload: bs58.encode(cerrado) };
}

/**
 * PASO 2 · Firmar la transacción del depósito, SIN enviarla.
 *
 * `transaction` va en base58 de la transacción SERIALIZADA. Como el `feePayer` es el facilitator y su
 * firma todavía no está, hay que serializar sin exigir todas las firmas
 * (`tx.serialize({ requireAllSignatures: false, verifySignatures: false })`); eso lo hace quien
 * llama, porque este módulo no conoce `@solana/web3.js` a propósito.
 */
export function urlFirmarTransaccion(d: DatosDeSesion & { transaccionBase58: string }): string {
  const { nonce, payload } = sobre({ transaction: d.transaccionBase58, session: d.session }, d.secreto);
  const q = new URLSearchParams({
    dapp_encryption_public_key: bs58.encode(d.clavePublicaDeLaApp),
    nonce,
    redirect_link: d.redirectLink,
    payload,
  });
  return `${BASE[d.billetera]}/signTransaction?${q.toString()}`;
}

/**
 * PASO 3 · Firmar el mensaje canónico de patrocinio (SDD 037).
 *
 * `display: "utf8"` no es cosmético: hace que la persona LEA en su billetera qué está autorizando,
 * en vez de un bloque de bytes. El mensaje incluye adentro la firma de la transacción del paso 2, así
 * que este paso va DESPUÉS y nunca antes.
 */
export function urlFirmarMensaje(d: DatosDeSesion & { mensaje: Uint8Array }): string {
  const { nonce, payload } = sobre(
    { message: bs58.encode(d.mensaje), session: d.session, display: "utf8" },
    d.secreto,
  );
  const q = new URLSearchParams({
    dapp_encryption_public_key: bs58.encode(d.clavePublicaDeLaApp),
    nonce,
    redirect_link: d.redirectLink,
    payload,
  });
  return `${BASE[d.billetera]}/signMessage?${q.toString()}`;
}

/**
 * EL DESENLACE DE UN VIAJE, CON SUS TRES VALORES SEPARADOS.
 *
 * 🔴 LOS TRES NO COLAPSAN, y el que se pierde siempre es el tercero. Es la misma lección que este
 * repo ya tiene escrita en `failAndRefund` y en `ConnectedWalletProbe`: un `null` o un `boolean` no
 * tiene dónde poner "acá no pasó nada", así que lo escribe como "falló".
 *   · "ok"        la billetera contestó y el sobre abrió.
 *   · "rechazo"   la billetera contestó que NO. La persona canceló, o el pedido estaba mal armado.
 *   · "ninguno"   en esta URL no hay ninguna respuesta. Alguien entró a la página de frente.
 *
 * Colapsar "ninguno" en "rechazo" le diría "cancelaste" a quien nunca fue a ningún lado. Ya nos pasó
 * con Mobile Wallet Adapter y costó una noche.
 */
export type Desenlace<T> =
  | { tipo: "ok"; datos: T }
  | { tipo: "rechazo"; codigo: string; mensaje: string }
  | { tipo: "ninguno" };

/** Lo que devuelve un connect que salió bien. */
export interface DatosDeConexion {
  public_key: string;
  session: string;
}

/**
 * Lee la URL de vuelta y abre el sobre.
 *
 * `secretaDeLaApp` es la clave privada guardada antes del salto. Si no coincide con el sobre, esto
 * devuelve `rechazo` con `sobre_ilegible` y NO revienta: una respuesta que no se puede abrir es un
 * desenlace del viaje, no un error de programación.
 *
 * 🔴 `forma` NO es opcional, y la razón es un defecto medido. Antes esto hacía `JSON.parse(...) as T`
 * y devolvía `ok` con lo que fuera: un cuerpo `{ ok: true }` salía como `{ tipo: "conectado",
 * direccion: undefined }` con `direccion` TIPADA `string`, y un cuerpo `null` reventaba con
 * `Cannot read properties of null`. El `as` es una afirmación sobre datos de un tercero que nadie
 * verificó. Ahora el que llama declara qué campos espera; si no están, es un desenlace
 * (`forma_inesperada`) y no un `undefined` que viaja disfrazado de `string` hasta el facilitator.
 */
export function leerRespuesta<T>(
  billetera: BilleteraDeeplink,
  params: URLSearchParams,
  secretaDeLaApp: Uint8Array,
  forma: (crudo: unknown) => T | null,
): Desenlace<T> {
  const codigo = params.get("errorCode");
  if (codigo) {
    return { tipo: "rechazo", codigo, mensaje: params.get("errorMessage") ?? "" };
  }
  const clave = clavePublicaEnRespuesta(billetera, params);
  const nonce = params.get("nonce");
  const data = params.get("data");
  // Los tres tienen que estar. Que falte alguno NO es un rechazo: es que acá no hay respuesta.
  if (!clave || !nonce || !data) return { tipo: "ninguno" };

  let abierto: Uint8Array | null = null;
  try {
    const secreto = secretoCompartido(clave, secretaDeLaApp);
    abierto = nacl.box.open.after(bs58.decode(data), bs58.decode(nonce), secreto);
  } catch {
    abierto = null; // base58 inválido, longitudes que no cierran: todo cae acá
  }
  if (!abierto) return { tipo: "rechazo", codigo: "sobre_ilegible", mensaje: "" };

  let crudo: unknown;
  try {
    crudo = JSON.parse(new TextDecoder().decode(abierto));
  } catch {
    return { tipo: "rechazo", codigo: "json_ilegible", mensaje: "" };
  }
  const datos = forma(crudo);
  if (datos === null) return { tipo: "rechazo", codigo: "forma_inesperada", mensaje: "" };
  return { tipo: "ok", datos };
}

/**
 * El validador que usan los tres pasos: un objeto con estos campos, todos texto NO VACÍO.
 *
 * Es a propósito lo más chico que sirve. No valida largos ni base58 —eso lo verifica quien use el
 * valor— pero sí que el campo EXISTA y sea un `string`, que es lo único que el tipo de retorno
 * afirma y antes no se cumplía.
 *
 * 🔴 Y QUE NO ESTÉ VACÍO, que es la mitad que faltaba. Medido en el re-AR: un connect con
 * `{"public_key":"","session":""}` salía `{ tipo: "conectado", direccion: "", session: "" }`, o sea
 * una cadena vacía viajando hacia el camino del dinero disfrazada de cuenta de Solana. `""` pasa
 * `typeof === "string"` pero no es ninguno de los valores que estos tres pasos pueden devolver: una
 * dirección, una sesión opaca, una transacción o una firma vacías no existen. Se trata como lo que
 * es —el campo NO vino— y cae en `forma_inesperada`, que es el desenlace que ya existe para eso.
 */
export function soloTextos<K extends string>(
  ...campos: K[]
): (crudo: unknown) => Record<K, string> | null {
  return (crudo) => {
    if (typeof crudo !== "object" || crudo === null) return null;
    const o = crudo as Record<string, unknown>;
    const salida = {} as Record<K, string>;
    for (const campo of campos) {
      const v = o[campo];
      if (typeof v !== "string" || v === "") return null;
      salida[campo] = v;
    }
    return salida;
  };
}
