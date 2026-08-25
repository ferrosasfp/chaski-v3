// EL PASO DE LA PRUEBA DE POSESIÓN por enlace profundo (WKH-359 / AC-1, AC-4, AC-5).
//
// 🔴 QUÉ ES ESTO Y QUÉ NO ES. `prepare()` del payout exige una prueba de posesión firmada
// (`../../settlement/http-solana-prepare-gateway.ts:193`), y en un teléfono sin extensión el bridge
// está vacío ⇒ hasta esta HU todo depósito por enlace moría en `payout_pop_unavailable`. Este módulo
// escribe el par ida/vuelta de ese permiso: ancla el desafío que emitió el servidor, produce la URL
// del salto, y al volver verifica la firma antes de dejar que nadie la use.
//
// ⛔ EL TECHO, Y NO SE SUAVIZA (CD-6). Esto prueba posesión de la clave que EL CANAL declara, NO que
// esa dirección sea la billetera de la persona que empezó el envío. Quien gane el paso 1 —el ancla
// write-once de (`claveBilletera`, `./sesion.ts:148`)— se queda con el canal entero y satisface
// cualquier desafío de acá CON SU PROPIA CLAVE. ⛔ Este módulo NO cierra esa falsificación, y ningún
// comentario de acá puede decir que sí.
//
// ⚠️ POR QUÉ VIVE EN ESTA CARPETA, y no en `preparacion-por-enlace.ts` que es quien lo va a cablear:
// por la misma razón que el motor (`./firma-por-enlace.ts:4-6`) y que (`./conexion.ts:16`), es un
// colaborador interno del adaptador y la clave privada x25519 del canal NO sale de acá.
//
// DT-7 — este módulo NO lee `window`, ni `Date`, ni `fetch`, ni `process.env`. El almacén y el
// instante entran por parámetro, igual que en `sesion.ts`, `conexion.ts` y `preparado.ts`.
// ⛔ Y NO USA `Buffer` (CD-13): es la lección de (`signMessage`, `../../solana-wallet.ts:1922`), que
// dice "browser+node-safe (NO Buffer)" en su propia línea. Acá se usa `TextEncoder` + `bs58`.
// ⛔ Y NO IMPORTA `pop-challenge.ts` (CD-13): ese módulo importa `node:crypto` y no puede entrar al
// bundle del cliente. La ventana sale del `exp` que el servidor manda en el JSON, nunca de una
// constante copiada de allá. Lo mide `T-067-20`.
//
// 🔴 Y ES SÍNCRONO, por la misma razón que sus dos vecinos: la atomicidad de la vuelta depende de que
// la lectura del disco y su escritura vivan en el MISMO bloque síncrono. Un `await` en el medio
// reintroduce la ventana de read-modify-write que el fix-pack 2 de la ola 1 cerró.
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { Almacen } from "./sesion";
import { enlaceDeVuelta, leerViaje } from "./sesion";
import { clavePublicaEnRespuesta, leerRespuesta, secretoCompartido, soloTextos, urlFirmarMensaje } from "./protocol";
import type { CausaDeEnlace } from "./firma-por-enlace";
import {
  DEEPLINK_POP_ALTERADO,
  DEEPLINK_POP_VENCIDO,
  DEEPLINK_RECHAZADO,
  DEEPLINK_RESPUESTA_ILEGIBLE,
  DEEPLINK_SIN_MEMORIA,
  DEEPLINK_VIAJE_VENCIDO,
} from "./firma-por-enlace";

/**
 * Las marcas de los dos saltos que piden la prueba de posesión.
 *
 * 🔴 NO SON `PasoDelViaje`, Y ESO ES EL MECANISMO, NO UN DESCUIDO. (`esPaso`, `./sesion.ts:121`) es un
 * conjunto CERRADO de tres valores (`PasoDelViaje`, `./sesion.ts:114`), así que `interpretarVuelta`
 * contesta `no-volvimos` para estas dos marcas y **el motor no consume ni destruye nada** si una de
 * ellas queda en la barra. Y hay una razón propia además de la heredada: la prueba de posesión no
 * mueve USDC ni consume un paso del viaje del DEPÓSITO —es un permiso para poder pedir el prepare—,
 * así que un salto suyo abandonado no puede costar una firma ya dada.
 *
 * ⚠️ ⛔ Y ACÁ VA LA CORRECCIÓN DE LA EVIDENCIA HEREDADA, que importa más que la regla: el docblock de
 * (`MARCA_CREAR_NONCE`, `./conexion.ts:54`) dice que si esto fuera un `PasoDelViaje` el `switch` con
 * `never` de (`nunca`, `./firma-por-enlace.ts:795`) "dejaría de compilar". **LO CORRÍ Y ES FALSO**:
 * agregué `"pop-payout"` a `PasoDelViaje` y a `esPaso`, y `tsc --noEmit` quedó VERDE y la suite
 * completa también. Ese `never` discrimina sobre (`Vuelta`, `./sesion.ts:407`), y `PasoDelViaje` entra
 * a esas variantes como CAMPO y no como discriminante ⇒ no hay variante nueva que el `switch` deba
 * mirar. ⇒ **el único candado real es `T-067-16`**, en `./sesion.test.ts`, y es de runtime.
 */
export const MARCA_POP_PAYOUT = "pop-payout";
export const MARCA_POP_KYC = "pop-kyc";

/**
 * La QUINTA clave del recorrido, y separada de las otras cuatro por el mismo argumento que ya está
 * escrito en (`CLAVE_NONCE`, `./conexion.ts:429`) y en (`CLAVE`, `./preparado.ts:31`): son ciclos de
 * vida distintos y compartir clave haría que limpiar uno se llevara el otro.
 *
 * Acá la asimetría es propia y va en la dirección contraria a la del nonce: este permiso vive MENOS
 * que el viaje del depósito, no más. Su ventana la fija el servidor y son 10 minutos; el viaje dura
 * 20. Compartir clave haría que terminar el permiso vencido se llevara el viaje que todavía sirve.
 */
const CLAVE_POP = "chaski.billetera.pop.v1";

/**
 * Lo que hay que recordar del salto que pide la firma del desafío. ⛔ NINGUNA clave de cifrado: la
 * sesión y la `claveBilletera` salen del VIAJE, que es donde el ancla write-once ya vive.
 */
export interface PasoPop {
  /**
   * ⛔ UN SOLO PROPÓSITO (CD-15). Un ancla sacada para el payout NO satisface un pedido del KYC ni al
   * revés: son dos desafíos distintos del servidor, y reusar uno para el otro sería exactamente el
   * "reuso de una prueba guardada para saltearse un prompt del money-path" que prohíbe la CD-6 de
   * (`prove`, `../../auth/http-pop-signer.ts:16`). Lo mide `T-067-17`.
   */
  proposito: typeof MARCA_POP_PAYOUT | typeof MARCA_POP_KYC;
  /**
   * El token opaco que emitió el servidor. Se guarda porque **la firma sola no sirve**: `prepare`
   * exige el PAR (`popChallenge` + `popSignature`) y verifica el HMAC del token antes de mirar la
   * firma (`../../../../app/api/payout/prepare/route.ts:219`).
   */
  popChallenge: string;
  /**
   * El texto EXACTO que el servidor dijo que hay que firmar. Es contra ESTOS bytes que se verifica lo
   * que vuelve, y por eso se guarda en vez de reconstruirse: reconstruirlo del lado del cliente sería
   * inventar acá la gramática que el servidor define, o sea un guard que se compara consigo mismo.
   */
  popMessage: string;
  /**
   * Segundos epoch, **el del SERVIDOR** (DT-10). Es la ÚNICA ventana de este ancla.
   *
   * 🔴 POR QUÉ NO `MAX_EDAD_MS`, que es lo que usa el ancla del nonce (`./conexion.ts:498`): serían
   * DOS relojes con arranques distintos. Con `MAX_EDAD_MS` (20 min) contra el TTL del desafío
   * (10 min), un ancla VIVA con un desafío MUERTO llegaría al `prepare` y volvería 403
   * `payout_pop_unverified` — el diagnóstico de una falsificación para un simple vencimiento.
   * 🔴 POR QUÉ NO COPIAR LA CONSTANTE DEL TTL: vive en `../../auth/pop-challenge.ts:22`, módulo que
   * importa `node:crypto` ⇒ no puede entrar al bundle del cliente (CD-13); y un literal duplicado
   * envejece solo el día que el servidor cambie el TTL.
   *
   * ⛔ LO QUE ESTE `exp` **NO** ES, y hay que decirlo para que nadie se apoye en él: **no está
   * autenticado de este lado**. El HMAC del desafío sólo lo verifica el servidor, así que un `exp`
   * adulterado se cree acá sin chistar. Se usa ÚNICAMENTE para "no molestes a la persona / no
   * POSTees en vano", **nunca** para autorizar nada. Quien autoriza es P2, server-side, en
   * `../../../../app/api/payout/prepare/route.ts:231`. Adelantarlo sólo se hace daño a sí mismo;
   * atrasarlo no compra nada, porque el servidor rechaza igual.
   */
  exp: number;
  /** La cuenta contra la que se va a verificar la firma. Sale de `Viaje.direccion`, no del servidor. */
  direccion: string;
  /** ms epoch de cuándo se guardó. ⚠️ NO define la ventana (eso es `exp`): sirve para descartar basura. */
  desde: number;
  /**
   * 🔴 EL ANTI-REPLAY DE LA VUELTA, y es propio porque `interpretarVuelta` no participa (estas marcas
   * no son `PasoDelViaje`). Sin este flag, volver a montar la pantalla con la MISMA URL en la barra
   * verificaría y entregaría la firma otra vez. Lo mide `T-067-12`.
   */
  consumido?: boolean;
  /**
   * El resultado, cuando ya volvimos: la firma en base58. Ausente hasta que la vuelta la escribe.
   *
   * ⚠️ QUE ESTÉ ACÁ NO LA HACE REUSABLE (CD-5/CD-15): quien la entrega —(`leerPruebaPop`, `:398`)— borra
   * el ancla en el mismo gesto. Un solo uso, y el que la quiera de nuevo salta de nuevo.
   */
  firma?: string;
}

/** Qué salió de leer la URL de vuelta del salto del PoP. */
export type VueltaDePop =
  /** En esta URL no hay ninguna respuesta de este paso. No es un rechazo y no se toca el disco. */
  | { tipo: "nada" }
  /** Hay firma verificada y anclada. Quien la necesite la saca con `leerPruebaPop`. */
  | { tipo: "pop-firmado"; proposito: typeof MARCA_POP_PAYOUT | typeof MARCA_POP_KYC }
  | { tipo: "corte"; causa: CausaDeEnlace };

/** Todo lo que este módulo necesita para decidir. Nada de esto lo lee él: se lo pasan (DT-7). */
export interface PedidoDePop {
  almacen: Almacen;
  /** ms epoch, por parámetro (DT-7). */
  ahora: number;
  /**
   * El href COMPLETO, no `pathname + search`. No es preferencia: (`enlaceDeVuelta`, `./sesion.ts:495`)
   * hace `new URL(origen)` y **TIRA** con una URL relativa, sin declararlo en su firma.
   */
  hrefActual: string;
  /** Para que la billetera muestre título e ícono en su diálogo. */
  appUrl: string;
}

/**
 * ⚠️ TIRA si el disco no acepta el ancla, igual que (`guardarPasoDelNonce`, `./conexion.ts:461`) y por
 * la misma razón: se llama ANTES del salto, y un ancla que no se pudo guardar significa que al volver
 * no vamos a poder verificar nada. Saltar a firmar sin poder verificar la vuelta es exactamente lo
 * que esta ancla existe para impedir.
 */
export function guardarPasoPop(a: Almacen, paso: PasoPop): void {
  a.escribir(CLAVE_POP, JSON.stringify(paso satisfies PasoPop));
}

/** Borra el ancla del PoP. NO tira: es limpieza. */
export function terminarPasoPop(a: Almacen): void {
  try {
    a.borrar(CLAVE_POP);
  } catch {
    // Un disco que no deja borrar deja basura; tirar acá rompería una salida entera por una limpieza.
  }
}

/**
 * Lee el ancla. `null` ante ausencia, basura, `exp` vencido o instante del futuro — y **limpia el
 * disco en los tres últimos casos**, por la lección de 061: un campo inválido que hace tirar y NO
 * limpia repite la excepción en CADA carga de la página.
 *
 * ⚠️ LA VENTANA ES EL `exp` DEL SERVIDOR Y NADA MÁS (DT-10). `desde` se valida como número finito y
 * se usa sólo para descartar un ancla que dice haber empezado en el FUTURO —basura, no juventud, el
 * mismo agujero que 061 midió en `leerViaje`—, nunca para vencer nada.
 */
export function leerPasoPop(a: Almacen, ahora: number): PasoPop | null {
  let crudo: string | null;
  try {
    crudo = a.leer(CLAVE_POP);
  } catch {
    return null; // un disco que no deja leer no tiene un ancla vencida: no tiene nada
  }
  if (!crudo) return null;
  let x: PasoPop;
  try {
    x = JSON.parse(crudo) as PasoPop;
  } catch {
    terminarPasoPop(a);
    return null;
  }
  if (
    (x?.proposito !== MARCA_POP_PAYOUT && x?.proposito !== MARCA_POP_KYC) ||
    typeof x?.popChallenge !== "string" ||
    x.popChallenge === "" ||
    typeof x?.popMessage !== "string" ||
    x.popMessage === "" ||
    typeof x?.direccion !== "string" ||
    x.direccion === "" ||
    !Number.isFinite(x?.exp) ||
    !Number.isFinite(x?.desde)
  ) {
    terminarPasoPop(a);
    return null;
  }
  // `exp` viene en SEGUNDOS epoch (es lo que emite el servidor) y `ahora` en MILISEGUNDOS. Mezclarlos
  // daría un ancla eterna o una muerta al nacer, según el lado del error.
  if (x.desde > ahora || ahora / 1000 >= x.exp) {
    terminarPasoPop(a);
    return null;
  }
  return x;
}

/**
 * PASO PoP · El salto que pide la firma del desafío que emitió el servidor.
 *
 * ⚠️ EL ORDEN DE LAS DOS ESCRITURAS NO ES ESTÉTICO: primero el ancla, después la URL. Es la misma
 * razón que (`iniciarCreacionDeNonce`, `./conexion.ts:613`): si la URL se devolviera antes de haber
 * podido guardar el ancla, la persona saltaría a firmar algo contra lo que este dispositivo no va a
 * poder verificar nada, y esa verificación es lo único que impide que se use una firma que no es.
 *
 * TIRA si el viaje no está conectado (no hay canal cifrado con el que pedir nada) o si el disco no
 * acepta el ancla. ⛔ No envolver esto en un `try`: tragarse cualquiera de las dos es saltar a ciegas.
 */
export function iniciarPop(
  p: PedidoDePop & {
    proposito: typeof MARCA_POP_PAYOUT | typeof MARCA_POP_KYC;
    popChallenge: string;
    popMessage: string;
    exp: number;
  },
): { irA: string } {
  const lectura = leerViaje(p.almacen, p.ahora);
  if (lectura.tipo !== "hay") throw new Error(DEEPLINK_VIAJE_VENCIDO);
  const viaje = lectura.viaje;
  if (
    typeof viaje.claveBilletera !== "string" ||
    typeof viaje.session !== "string" ||
    typeof viaje.direccion !== "string"
  ) {
    throw new Error(DEEPLINK_VIAJE_VENCIDO);
  }
  guardarPasoPop(p.almacen, {
    proposito: p.proposito,
    popChallenge: p.popChallenge,
    popMessage: p.popMessage,
    exp: p.exp,
    direccion: viaje.direccion,
    desde: p.ahora,
  }); // TIRA a propósito: ver el docblock
  return {
    irA: urlFirmarMensaje({
      billetera: viaje.billetera,
      appUrl: p.appUrl,
      // ⚠️ `enlaceDeVuelta` LIMPIA del origen los parámetros de respuesta que ya trajera: sin eso, un
      // `redirect_link` armado sobre una URL que ya volvió de un salto se lleva el `nonce`/`data`
      // viejos adentro, y `URLSearchParams.get` devuelve el PRIMERO.
      redirectLink: enlaceDeVuelta(p.hrefActual, p.proposito),
      clavePublicaDeLaApp: bs58.decode(viaje.publica),
      secreto: secretoCompartido(viaje.claveBilletera, lectura.secretaBytes),
      session: viaje.session,
      // ⛔ `display: "utf8"` lo pone `urlFirmarMensaje` y no es cosmético: hace que la persona LEA en
      // su billetera qué está autorizando. El desafío del servidor es texto legible a propósito.
      mensaje: new TextEncoder().encode(p.popMessage),
    }),
  };
}

/**
 * La vuelta del salto que pidió la firma del desafío.
 *
 * 🔴 QUÉ VERIFICA, EN ESTE ORDEN Y SIN SALTEARSE NINGUNO (los cinco de
 * (`vueltaDelNonce`, `./conexion.ts:528`), con el quinto endurecido):
 *   1. que haya un ancla **viva** (si no, no hay contra qué verificar y no se entrega nada);
 *   2. que **no esté consumida** — el anti-replay propio de este paso;
 *   3. que el **viaje esté conectado**, porque la sesión y la `claveBilletera` salen de ahí;
 *   4. que la respuesta venga cifrada con **LA MISMA `claveBilletera`** que el viaje ya tiene fijada
 *      (ancla write-once: un sobre de cualquier otra clave sale `deeplink_pop_alterado`);
 *   5. que la firma devuelta **VERIFIQUE ed25519 sobre los bytes del `popMessage` anclado**, contra
 *      la dirección que el viaje declara.
 *
 * 🔴 EL QUINTO ES DISTINTO DEL DE `vueltaDelNonce`, Y LA DIFERENCIA ESTÁ MEDIDA, no elegida. El Story
 * File pedía "que el `message` devuelto sea el `popMessage` anclado, BYTE A BYTE". **Ese chequeo no se escribe.**
 * ⚠️ Y LA RAZÓN QUE HABÍA ACÁ NO LO SOSTENÍA (fix-pack · CR/MNR-1): decía *"no se puede escribir: la billetera NO devuelve el `message`"*, y lo respaldaba con que la vuelta del paso `signMessage` se lee con (`soloTextos`, `./sesion.ts:668`) y nada más.
 * Eso mide qué conserva **NUESTRO lector**, no qué MANDA la billetera: son dos afirmaciones distintas y
 * la evidencia sólo alcanza la primera. La decisión NO cambia; quien la sostiene es el argumento de abajo.
 * ⇒ La verificación ed25519 sobre los bytes ANCLADOS es **el mismo chequeo, y más fuerte**: una firma
 * hecha sobre otro texto no verifica contra estos bytes, así que "es el mensaje que mandamos" sale
 * como consecuencia. Y de yapa prueba QUIÉN firmó, que una comparación de cadenas no puede.
 *
 * 🔴 Y POR QUÉ ACÁ SÍ SE VERIFICA ed25519 Y EN EL PASO DEL NONCE NO. La justificación de
 * `vueltaDelNonce` para no hacerlo es *"lo que está en juego en este paso es CERO USDC … la cadena
 * rechaza"*, y **acá no aplica**: nadie más va a rechazar una firma de PoP que no verifique. Sin este
 * chequeo el par viajaría a `prepare`, que contestaría 403 `payout_pop_unverified` — el diagnóstico de
 * una falsificación para lo que puede ser un canal cruzado con otro envío.
 *
 * ⛔ MARCA CONSUMIDO ANTES DE DEVOLVER, en la misma lectura (`vueltaDelNonce`, `./conexion.ts:528`). Si se escribiera
 * después, una recarga en el medio dejaría el ancla viva y la vuelta se procesaría dos veces.
 */
export function vueltaDelPop(p: PedidoDePop): VueltaDePop {
  const ancla = leerPasoPop(p.almacen, p.ahora);
  if (ancla === null) return { tipo: "corte", causa: DEEPLINK_POP_VENCIDO }; // ⚠️ NO es `DEEPLINK_POP_SIN_FIRMA`: llegar acá significa que la barra trae una marca del PoP, que sólo vive en el `redirect_link` que le dimos a la billetera ⇒ YA volvimos de ella y esto corta sin mirar un parámetro. `_SIN_FIRMA` es PRE-salto y su copy dice "todavía no te lo pedimos", que acá sería falso. El copy de `_VENCIDO` no afirma ni que se firmó ni que no ([NC-2]), que es lo único sostenible desde este punto
  if (ancla.consumido === true) return { tipo: "corte", causa: DEEPLINK_POP_VENCIDO }; // ⚠️ POST-vuelta también, y por eso comparte causa: el flag se escribe ANTES de devolver, así que llegar acá significa que esta misma respuesta ya se procesó una vez. ⛔ NO es `DEEPLINK_POP_ALTERADO`: no hay nada alterado, hay algo repetido, y acusar de alteración a una recarga de la pantalla mandaría a la persona a buscar un ataque que no existe

  const lectura = leerViaje(p.almacen, p.ahora);
  if (lectura.tipo !== "hay") return { tipo: "corte", causa: DEEPLINK_VIAJE_VENCIDO }; // el reloj del VIAJE (20 min) es independiente del `exp` del desafío (10 min) y puede vencer primero: arranca al tocar el selector. Es el residual declarado de [NC-2]
  const viaje = lectura.viaje;
  if (typeof viaje.claveBilletera !== "string" || typeof viaje.session !== "string") {
    return { tipo: "corte", causa: DEEPLINK_VIAJE_VENCIDO }; // sin canal no se puede abrir el sobre
  }

  const params = new URLSearchParams(new URL(p.hrefActual).search);
  // 🔒 EL ANCLA WRITE-ONCE, ANTES DE ABRIR NADA: la respuesta tiene que venir de la MISMA clave que
  // contestó el connect. Es el mismo guard que `interpretarVuelta` aplica a los pasos del motor.
  if (clavePublicaEnRespuesta(viaje.billetera, params) !== viaje.claveBilletera) {
    // ⚠️ Un rechazo explícito de la billetera llega SIN clave de cifrado, así que caería acá y se
    // leería como "alterada". Se mira primero el `errorCode`, que es lo único observable.
    const codigo = params.get("errorCode");
    if (codigo) return { tipo: "corte", causa: DEEPLINK_RECHAZADO };
    return { tipo: "corte", causa: DEEPLINK_POP_ALTERADO };
  }

  const desenlace = leerRespuesta(viaje.billetera, params, lectura.secretaBytes, soloTextos("signature"));
  if (desenlace.tipo === "ninguno") return { tipo: "nada" }; // la marca estaba pero no hay respuesta
  if (desenlace.tipo === "rechazo") {
    return {
      tipo: "corte",
      causa: desenlace.origen === "billetera" ? DEEPLINK_RECHAZADO : DEEPLINK_RESPUESTA_ILEGIBLE,
    };
  }

  // 5 · LA FIRMA CONTRA LOS BYTES ANCLADOS Y CONTRA LA DIRECCIÓN DEL VIAJE (AC-4). Un `false` acá y
  // una firma ilegible se tratan igual, y no es pereza: las dos significan que no podemos afirmar que
  // esto lo firmó quien decimos, y avanzar con cualquiera de las dos es avanzar sin prueba.
  if (!verificaPop(desenlace.datos.signature, ancla.popMessage, ancla.direccion)) {
    return { tipo: "corte", causa: DEEPLINK_POP_ALTERADO };
  }

  // ⛔ EL FLAG Y LA FIRMA SE ESCRIBEN ANTES DE DEVOLVER. Si se escribieran después, una recarga en el
  // medio dejaría el ancla viva y sin firma, y la persona firmaría dos veces lo mismo.
  try {
    guardarPasoPop(p.almacen, { ...ancla, consumido: true, firma: desenlace.datos.signature });
  } catch {
    // Un disco que no deja escribir no puede recordar ni la firma ni que esto se consumió ⇒ no se
    // usa el resultado. Es el lado conservador, igual que en `vueltaDelNonce`.
    return { tipo: "corte", causa: DEEPLINK_SIN_MEMORIA };
  }
  return { tipo: "pop-firmado", proposito: ancla.proposito };
}

/**
 * `true` sólo si `firmaBase58` es una firma ed25519 válida de `mensaje` hecha por `direccionBase58`.
 *
 * Devuelve `false` en vez de tirar por el mismo criterio que
 * (`firmaDelSender`, `./firma-por-enlace.ts:410`): una firma que no se puede decodificar es un
 * desenlace del viaje, no un error de programación.
 *
 * ⚠️ EL EXEMPLAR DE FORMA es (`nacl.sign.detached.verify`, `../../solana-wallet.ts:999`), que este
 * árbol ya usa en el cliente para la transacción del depósito ⇒ **no entra ninguna dependencia nueva**.
 */
function verificaPop(firmaBase58: string, mensaje: string, direccionBase58: string): boolean {
  try {
    const firma = bs58.decode(firmaBase58);
    const clave = bs58.decode(direccionBase58);
    // Los dos largos se chequean a mano porque `nacl` TIRA con un largo equivocado en vez de devolver
    // `false`, y un throw acá se leería como un error nuestro en vez de como una firma que no sirve.
    if (firma.length !== 64 || clave.length !== 32) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(mensaje), firma, clave);
  } catch {
    return false;
  }
}

/**
 * Entrega la prueba anclada **UNA SOLA VEZ** y borra el ancla en el mismo gesto (CD-15).
 *
 * 🔴 EL BORRADO ES EL "UN SOLO USO", y por eso va ANTES del `return` y no después: si se borrara
 * después de que el llamador la use, un fallo suyo dejaría la prueba viva y reusable, que es
 * exactamente el reuso que prohíbe la CD-6 de (`prove`, `../../auth/http-pop-signer.ts:16`).
 *
 * `null` cuando no hay ancla viva, cuando todavía no tiene firma (el salto está en curso), o cuando
 * el propósito **no es el que se pidió**: un permiso del KYC no autoriza un payout ni al revés
 * (`T-067-17`). ⛔ Sin default en `proposito`: quien pide tiene que decir para qué.
 */
export function leerPruebaPop(
  a: Almacen,
  ahora: number,
  proposito: typeof MARCA_POP_PAYOUT | typeof MARCA_POP_KYC,
): { popChallenge: string; firma: string; popMessage: string } | null {
  const ancla = leerPasoPop(a, ahora);
  if (ancla === null) return null;
  if (ancla.proposito !== proposito) return null; // ⛔ NO se borra el ancla del otro propósito, y ésta es la razón que SÍ se sostiene: esto es una LECTURA, y una lectura no destruye lo que no entrega. ⚠️ ACÁ DECÍA que borrarla «haría que pedir el PoP del payout cancelara el del KYC en curso», Y ESO ES FALSO (fix-pack · AR/MNR-1): el ancla es UNA SOLA RANURA ((`CLAVE_POP`, `:75`)), así que (`iniciarPop`, `:238`) YA pisa la del otro propósito al escribir la suya —reproducido: tras un `iniciarPop` de `pop-payout`, el ancla del KYC dejó de existir—. Lo que este `return null` sí garantiza es lo único que hay que garantizar (CD-15): un permiso de un propósito NO se entrega para el otro. Y el costo real de la ranura única va dicho: un desafío y un salto de más, no un agujero
  if (typeof ancla.firma !== "string" || ancla.firma === "") return null;
  terminarPasoPop(a); // ⛔ ANTES del return: ver el docblock
  return { popChallenge: ancla.popChallenge, firma: ancla.firma, popMessage: ancla.popMessage };
}

/**
 * Entrega la firma anclada **si y sólo si** es sobre EXACTAMENTE estos bytes, y borra el ancla en el
 * mismo gesto (CD-15). `null` si no hay ancla viva, si todavía no tiene firma, o si el texto anclado
 * no es el que se está pidiendo firmar.
 *
 * 🔴 POR QUÉ FILTRA POR EL MENSAJE Y NO POR EL PROPÓSITO, a diferencia de (`leerPruebaPop`, `:398`).
 * Quien la llama es (`signMessage`, `../../solana-wallet.ts:1922`), que recibe un texto y no sabe para
 * qué se lo piden: su contrato (`WalletPort`, `../../../application/ports.ts:494`) es `(message) =>
 * firma` y ⛔ **no se ensancha** (CD-16). El texto ES el discriminante acá, y es uno más fuerte que el
 * propósito: dos desafíos de propósitos distintos tienen textos distintos, así que exigir el texto ya
 * exige el propósito. Al revés no vale.
 *
 * ⛔ Y ES UNA LECTURA, NUNCA UN PEDIDO (CD-12). Si no hay nada que leer, esto contesta `null` y quien
 * llama corta: **no navega**. Un `signMessage` que navegara devolvería una promesa que nunca resuelve,
 * porque el proceso de JavaScript deja de existir en el salto — es el argumento que ya está escrito en
 * (`AutorizacionDelPrincipal`, `../../../application/ports.ts:1185`).
 */
export function leerFirmaParaMensaje(a: Almacen, ahora: number, mensaje: string): string | null {
  const ancla = leerPasoPop(a, ahora);
  if (ancla === null) return null;
  if (ancla.popMessage !== mensaje) return null; // ⛔ NO se borra: el ancla es de OTRO pedido y esto es una LECTURA. ⚠️ Misma corrección que en (`leerPruebaPop`, `:398`) (fix-pack · AR/MNR-1): no es que borrarla «cancelaría el permiso en curso» —la ranura es una sola y `iniciarPop` ya la pisa—, es que una lectura no destruye lo que no entrega
  if (typeof ancla.firma !== "string" || ancla.firma === "") return null;
  terminarPasoPop(a); // ⛔ ANTES del return, igual que `leerPruebaPop`: el borrado ES el "un solo uso"
  return ancla.firma;
}
