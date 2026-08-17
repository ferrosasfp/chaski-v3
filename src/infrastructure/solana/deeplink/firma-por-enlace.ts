// El motor de firma por enlace profundo (WKH-356). Es el ÚNICO llamador de producción de
// `interpretarVuelta` en todo el repo.
//
// 🔴 QUÉ ES ESTO Y POR QUÉ VIVE EN INFRAESTRUCTURA Y NO EN `ports.ts`. Es un colaborador interno del
// adaptador de billetera, no un puerto de aplicación: nadie fuera de `solana-wallet.ts` lo conoce, y
// la capa de aplicación no tiene por qué enterarse de que existe un protocolo de enlaces profundos.
//
// 🔴 POR QUÉ `resolver` ES SÍNCRONO, y esto NO es un detalle de estilo. La atomicidad de
// `interpretarVuelta` depende de que la lectura y la escritura del disco vivan en el MISMO bloque
// síncrono; el CR de 061 lo dejó escrito con esas palabras: "cualquier 'separación de
// responsabilidades' que rompa eso es una regresión, no un refactor". Un solo `await` acá adentro
// reintroduce la ventana que el fix-pack 2 de 061 cerró: dos pestañas, un snapshot rancio, y una
// `transaccionFirmada` que se pierde.
//
// 🔴 POR QUÉ NO TIRA. Los desenlaces malos de un viaje por enlace son ESPERADOS, no bugs: la persona
// canceló, el sobre no abrió, el viaje venció. Devolverlos como `{ tipo: "corte", causa }` hace que
// las diez variantes de `Vuelta` se puedan probar sin un `expect().rejects` por caso, y deja en UN
// solo lugar —el adaptador— la traducción causa → `throw`, que es la forma que el resto de
// `authorizePrincipal` ya usa (`wallet_not_connected`, `escrow_params_missing`).
//
// ⛔ DT-7 — acá NO se lee `window`, ni `Date`, ni `fetch`, ni `process.env`. El almacén, el instante
// y la URL entran por parámetro.
//
// ⚠️ [NO VERIFICADO] (CD-12) — nada de este archivo está medido en un teléfono. Que la billetera
// vuelva al mismo origen, que el `localStorage` sobreviva al salto y que la transacción que devuelve
// sea byte-idéntica a la que se le mandó son tres afirmaciones sobre un runtime móvil que este repo
// no ha medido.
import bs58 from "bs58";
import { Transaction } from "@solana/web3.js";
import {
  type DatosDeSesion,
  secretoCompartido,
  urlFirmarMensaje,
  urlFirmarTransaccion,
} from "./protocol";
import {
  type Almacen,
  type Viaje,
  enlaceDeVuelta,
  interpretarVuelta,
  leerViaje,
  terminarViaje,
} from "./sesion";
import { guardarPreparado, leerPreparado, terminarPreparado } from "./preparado";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Las causas. Strings estables: viajan como `Error.message` desde `authorizePrincipal`. Cada docblock
// dice QUÉ AFIRMA y QUÉ NO AFIRMA, porque la mitad de los errores caros de este repo salieron de una
// causa que afirmaba de más.
//
// 🔴 LO QUE LA PANTALLA HACE HOY CON ESTAS CAUSAS: NADA, y acá decía lo contrario. La frase anterior
// era "la capa de presentación las traduce" y es FALSA, medido en el AR de esta HU:
// `grep -rn "deeplink_" src/presentation` devuelve **0 resultados**, así que las nueve caen en el
// default de `humanError` (`flow-vm.ts`) y la persona lee la MISMA frase —"Algo salió mal. Intentá de
// nuevo."— tanto si canceló como si el blockhash venció. El trabajo de partir `rechazado` de
// `respuesta_ilegible` sirve igual (son dos causas distintas en los logs y en cualquier copy futuro),
// pero HOY no llega a la pantalla.
//
// ⛔ Y POR QUÉ EL COPY NO SE ESCRIBE EN ESTA HU, que es una decisión y no un olvido: ninguna de estas
// causas tiene camino de producción todavía. El colaborador de enlace NO se cablea en `container.ts`
// (CD-13, con su test en `container.test.ts`), así que un copy escrito hoy sería copy para un error
// que nadie puede provocar — exactamente el "código muerto de money-path" que el Story File usó para
// dejar la presentación fuera de scope. El copy es requisito de la ola 4, la misma que cablea el
// colaborador y escribe el connect.
//
// 🔒 Y para que este párrafo no envejezca solo, hay un candado que lo mide en cada `npm test`:
// `deeplink-callers.test.ts` cuenta las causas exportadas de acá y las busca en `src/presentation`.
// El día que alguien escriba el primer copy, ese test se pone rojo y obliga a reescribir esto.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * AFIRMA: el destino del depósito cambió entre el intento en que se pidió la firma y éste. **Nada se
 * firmó de nuevo y nada se serializó con el destino nuevo.**
 * NO AFIRMA: que alguien esté atacando. Un segundo `prepare()` puede haber elegido honestamente otro
 * agente de payout. Es fail-closed sobre una divergencia, no una acusación.
 */
export const DEEPLINK_PREPARE_DIVERGED = "deeplink_prepare_diverged";

/**
 * AFIRMA: la billetera que contestó no es la cuenta que esta remesa tiene como remitente.
 * NO AFIRMA: que esa cuenta sea de un atacante. Puede ser alguien que cambió de cuenta en su propia
 * billetera entre un paso y el siguiente.
 */
export const DEEPLINK_SENDER_MISMATCH = "deeplink_sender_mismatch";

/**
 * AFIRMA: la transacción no puede entrar en ningún bloque de acá en adelante, y **no se movió nada**.
 * La segunda mitad es fuerte y es correcta: nunca hubo POST al settle, así que ninguna transacción
 * salió de este navegador.
 * NO AFIRMA: que la persona haya hecho algo mal. El blockhash vence solo, por el tiempo que toma el
 * recorrido.
 */
export const DEEPLINK_BLOCKHASH_EXPIRED = "deeplink_blockhash_expired";

/**
 * AFIRMA: **no pudimos preguntarle a la cadena** si el blockhash sigue vivo (el RPC falló o venció el
 * techo de la sonda). Y sigue siendo cierto que no se movió nada: nunca hubo POST al settle.
 * NO AFIRMA: ⛔ que el blockhash haya vencido. Es el tercer valor que `deeplink_blockhash_expired` no
 * puede escribir, y existe por eso: colapsarlos convierte "no pude preguntar" en "no pasó", que es la
 * clase de error que este repo tiene medida. Consecuencia operativa, y es la mitad que importa: con
 * esta causa el recorrido **NO se limpia**, así que las dos firmas siguen en el disco y un reintento
 * puede completarlo. Con `deeplink_blockhash_expired` sí se limpia, porque ahí la transacción está
 * muerta para siempre.
 */
export const DEEPLINK_BLOCKHASH_DESCONOCIDO = "deeplink_blockhash_desconocido";

/**
 * AFIRMA: lo que volvió no es lo que se pidió firmar, o la firma no verifica sobre esos bytes, o lo
 * que este dispositivo recordó como firma no es una firma (un `object` en el disco donde tenía que
 * haber un string base58).
 * NO AFIRMA: ⛔ que la persona haya cancelado. A la persona NO se le muestra "cancelaste" con esto.
 */
export const DEEPLINK_TX_ALTERADA = "deeplink_tx_alterada";

/**
 * AFIRMA: este dispositivo no puede recordar lo que la billetera acaba de devolver, así que el viaje
 * no se puede completar: el resultado se perdería en el salto siguiente y el proceso va a morir.
 * NO AFIRMA: que la firma sea inválida. La firma puede ser perfecta; el problema es el disco.
 */
export const DEEPLINK_SIN_MEMORIA = "deeplink_sin_memoria";

/**
 * AFIRMA: lo que volvió por la URL dice que no.
 * NO AFIRMA: nada más. ⛔ Su `codigo` NO se usa como diagnóstico nuestro: viaja SIN cifrar y lo
 * escribe quien arme la URL, así que un tercero puede fabricar el código que quiera.
 */
export const DEEPLINK_RECHAZADO = "deeplink_rechazado";

/**
 * AFIRMA: falló algo de NUESTRO lado leyendo la respuesta (el conjunto cerrado `CodigoNuestro`).
 * NO AFIRMA: ⛔ que la persona haya cancelado. Colapsar esto con `deeplink_rechazado` es exactamente
 * cómo un fallo de cripto propio termina en pantalla como "cancelaste".
 */
export const DEEPLINK_RESPUESTA_ILEGIBLE = "deeplink_respuesta_ilegible";

/**
 * AFIRMA: este viaje no sirve más y hay que empezar uno nuevo. Cubre las cuatro formas de lo mismo:
 * venció la ventana, el paso ya se había leído (T11: un viaje sirve para UN pedido de cada paso), el
 * viaje guardado es de otra remesa, o no hay viaje utilizable en este dispositivo.
 * NO AFIRMA: que se haya movido plata, ni que la firma que la persona dio fuera inválida.
 */
export const DEEPLINK_VIAJE_VENCIDO = "deeplink_viaje_vencido";

export type CausaDeEnlace =
  | typeof DEEPLINK_PREPARE_DIVERGED
  | typeof DEEPLINK_SENDER_MISMATCH
  | typeof DEEPLINK_BLOCKHASH_EXPIRED
  | typeof DEEPLINK_BLOCKHASH_DESCONOCIDO
  | typeof DEEPLINK_TX_ALTERADA
  | typeof DEEPLINK_SIN_MEMORIA
  | typeof DEEPLINK_RECHAZADO
  | typeof DEEPLINK_RESPUESTA_ILEGIBLE
  | typeof DEEPLINK_VIAJE_VENCIDO;

// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Lo que el adaptador le da al motor. Sin `window`, sin `Date`, sin `fetch`, sin `process.env`. */
export interface PedidoDeFirma {
  almacen: Almacen;
  /** ms epoch, por parámetro. */
  ahora: number;
  /**
   * `window.location.href` COMPLETO, no `pathname + search`.
   *
   * 🔴 No es una preferencia: `enlaceDeVuelta` hace `new URL(origen)` y **TIRA** con una URL
   * relativa, sin declararlo en su firma (medido en 061, T9). El único sitio de composición que
   * arma este pedido pasa el href entero.
   */
  hrefActual: string;
  /** Para que la billetera muestre título e ícono en su diálogo. */
  appUrl: string;
  /**
   * El 2º argumento de `authorizePrincipal`, que es obligatorio. ⛔ NUNCA `null`: `interpretarVuelta`
   * acepta `null` como "no tengo remesa en contexto" y con eso **apaga el guard de cruce entre
   * remesas Y consume el paso igual** (T2). Acá no existe ningún camino que pueda pasarle `null`.
   */
  remittanceId: string;
  /**
   * La dirección del remitente, la de `this.getAddress()`. CD-11: **NUNCA sale del canal del
   * enlace**. El viaje sólo puede coincidir con ella o cortar; no puede sustituirla.
   */
  sender: string;
  /** El `beneficiary` del `prepare()` de ESTA invocación (atestado server-side). */
  beneficiary: string;
  /** El `authority` del `prepare()` de ESTA invocación (atestado server-side). */
  authority: string;
  /** base64 de `tx.serializeMessage()` de la tx recién armada. */
  mensajeBase64: string;
  /** bs58 de `tx.serialize({requireAllSignatures:false, verifySignatures:false})`. */
  transaccionBase58: string;
  /** La reference de la tx recién armada. */
  referenceBase58: string;
  /**
   * El mensaje canónico de patrocinio. Es una FUNCIÓN y no un valor porque lleva adentro la firma de
   * la transacción del paso 2, que recién se conoce cuando se recupera la tx firmada (AC-6). Por eso
   * también el patrocinio no puede pedirse antes que la firma de la transacción.
   */
  mensajeDePatrocinio: (firmaDelSenderB58: string) => Uint8Array;
}

/**
 * El desenlace del motor.
 *
 * ⛔ NO contiene `secreta` ni `secretaBytes` ni ninguna otra parte de la `LecturaDelViaje` (CD-9/T7).
 * `LecturaDelViaje.hay` expone la clave privada x25519 CRUDA: si saliera de este módulo viajaría al
 * puerto, a React, a un mensaje de error o a un `console`. Acá adentro se queda.
 */
export type DesenlaceDeFirma =
  | { tipo: "salto"; irA: string; esperando: "firma-tx" | "firma-patrocinio" }
  | {
      tipo: "completo";
      transaccionFirmadaBase58: string;
      firmaDePatrocinio: string;
      referenceBase58: string;
      /**
       * 🔴 EL ANCLA, DEVUELTA POR EL MISMO CAMINO QUE LA `reference`, y no es comodidad: es lo que
       * hace que el adaptador compare contra **el mismo registro que este motor validó**.
       *
       * Antes el adaptador volvía a llamar `leerPreparado` con OTRO `Date.now()`, así que había dos
       * lectores del mismo registro con dos relojes y la responsabilidad partida en dos capas (el
       * motor anclaba `beneficiary`/`authority`, el adaptador anclaba los bytes). Con esto hay una
       * sola lectura, un solo reloj, y desaparece la rama "leí el registro y ya no está" que nadie
       * podía alcanzar.
       */
      mensajeBase64: string;
    }
  | { tipo: "corte"; causa: CausaDeEnlace };

export interface FirmaPorEnlace {
  /** SÍNCRONO: no hay I/O adentro. Ver el bloque de arriba sobre por qué. */
  resolver(p: PedidoDeFirma): DesenlaceDeFirma;
}

/** Lo que hace falta del viaje para poder ARMAR un pedido cifrado. Sin los tres no hay canal. */
type ViajeConectado = Viaje & { claveBilletera: string; session: string; direccion: string };

function estaConectado(v: Viaje): v is ViajeConectado {
  return (
    typeof v.claveBilletera === "string" &&
    typeof v.session === "string" &&
    typeof v.direccion === "string"
  );
}

/**
 * ¿Esto que salió del disco es una firma, o es lo que alguien dejó ahí?
 *
 * 🔴 POR QUÉ HACE FALTA, medido en el AR: `leerViaje` NO valida los resultados a propósito —su
 * docblock dice que los campos que sólo se copian los valida quien los usa— y el que los usa es este
 * archivo. Con `firmaDePatrocinio: {"no":"soy un string"}` en el disco, `authorizePrincipal` devolvía
 * `{ estado: "listo" }` con un `popSignature` de tipo `object`, y eso es lo que se POSTea al settle.
 * Es el único de los campos que se COPIA A LA RED, o sea el único que no se puede dejar sin mirar.
 *
 * Vacío es peor que ausente: `"" === ""` da `true`, así que un string vacío "coincide" con otro y pasa
 * por comparaciones que tendrían que cortar. Es la misma razón que `esTextoUtil` en `preparado.ts`.
 *
 * ⛔ ESTE PREDICADO NO DECIDE SI SE PRESERVA UN RESULTADO EN UN CORTE, y durante un fix-pack lo decidió:
 * eso es `resultadoPreservable`, que es más estricto y explica por qué.
 */
function esFirmaUtil(x: unknown): x is string {
  return typeof x === "string" && x.trim() !== "";
}

/**
 * Saca la firma del `sender` de la transacción que devolvió la billetera, en base58.
 *
 * Devuelve `null` en vez de tirar: una transacción que no se puede leer es un desenlace del viaje
 * (`deeplink_tx_alterada`), no un error de programación. Es el mismo criterio que `decodificarSecreta`
 * en `sesion.ts`.
 */
function firmaDelSender(transaccionBase58: string, sender: string): string | null {
  try {
    const tx = Transaction.from(bs58.decode(transaccionBase58));
    const entrada = tx.signatures.find((s) => s.publicKey.toBase58() === sender);
    return entrada?.signature ? bs58.encode(new Uint8Array(entrada.signature)) : null;
  } catch {
    return null;
  }
}

/** 64 bytes en base58, que es lo que mide una firma ed25519. ⛔ NO VERIFICA NADA MÁS, y no puede: el
 *  mensaje contra el que la firma de patrocinio verifica lleva adentro la firma de la transacción y lo
 *  valida el settle, no este módulo. Es una medición de FORMA y se usa como tal. */
function tieneFormaDeFirma(x: unknown): boolean {
  if (!esFirmaUtil(x)) return false;
  try {
    return bs58.decode(x).length === 64;
  } catch {
    return false;
  }
}

/**
 * ¿Lo que hay en el disco es algo que este recorrido todavía puede USAR, o preservarlo lo deja trabado?
 *
 * 🔴 POR QUÉ NO ALCANZA `esFirmaUtil`, MEDIDO (AR-it2/BLQ-BAJO-1). La preservación de los cortes se
 * decidía con "string no vacío" mientras el comentario de al lado prometía lo contrario ("basura en el
 * campo de un resultado NO cuenta como firma"). Con `transaccionFirmada: "no-soy-una-transaccion"` en el
 * disco, CINCO invocaciones idénticas daban las cinco `deeplink_tx_alterada` con el viaje INTACTO: el
 * recorrido quedaba trabado hasta que `MAX_EDAD_MS` lo matara, que es exactamente el resultado que la
 * frase decía evitar. Y no hacía falta basura sintáctica: una transacción que decodifica pero NO trae la
 * firma del sender hacía lo mismo, porque el paso 9 corta sobre ella en cada vuelta.
 *
 * LA REGLA: se preserva lo que el motor podría llegar a usar. Para la transacción es el MISMO predicado
 * del paso 9 (`firmaDelSender(...) === null` ⇒ corte), y esa coincidencia ES el arreglo: el motor no
 * conserva nada sobre lo que él mismo cortaría en cada invocación.
 *
 * ⚠️ LOS DOS CAMPOS NO SE MIDEN IGUAL, y la asimetría es deliberada:
 *   · `transaccionFirmada` se verifica ACÁ MISMO —decodifica y trae la entrada del `sender`—, que es
 *     todo lo que este módulo puede afirmar sin preguntarle a nadie.
 *   · `firmaDePatrocinio` sólo se mide por FORMA (`tieneFormaDeFirma`). Preservar por este campo no
 *     puede TRABAR nada: sin `transaccionFirmada` el camino sigue al salto que falta, no al corte. Lo
 *     que la forma cierra es lo otro que el AR nombró: que a quien pueda escribir el disco le alcance
 *     con dejar cualquier string para que NINGÚN corte limpie durante 20 min.
 *
 * ⚠️ Y ES MÁS ESTRICTO QUE EL GUARD DEL PASO 6, a propósito: ahí `esFirmaUtil` decide si CORTAR, y un
 * falso positivo suyo le pediría a la persona una firma que ya dio; acá se decide si DESTRUIR.
 *
 * ⚠️ EL RESIDUO, dicho y con su `it`: el predicado pregunta por la firma de `p.sender`, o sea la cuenta
 * de ESTA invocación. Si la persona cambió de cuenta en su billetera, el corte es
 * `deeplink_sender_mismatch` y la firma de la cuenta VIEJA ya no se preserva. Se elige así porque la
 * alternativa —preguntar por `viaje.direccion`, que sale del disco— reabre el agujero entero: cualquiera
 * que escriba el disco pone una `direccion` propia y una tx firmada por SU par, y vuelve a tener un viaje
 * que ningún corte limpia. Y lo que se pierde no es plata: esa transacción nunca se transmitió.
 */
function resultadoPreservable(viaje: Viaje, sender: string): boolean {
  const txUtilizable =
    esFirmaUtil(viaje.transaccionFirmada) &&
    firmaDelSender(viaje.transaccionFirmada, sender) !== null;
  return txUtilizable || tieneFormaDeFirma(viaje.firmaDePatrocinio);
}

/**
 * El motor real.
 *
 * ⚠️ SE CONSTRUYE, PERO AL CERRAR 062 NADIE LO CONSTRUYE EN PRODUCCIÓN, y eso es por diseño: falta la
 * ola 4 (selector de billetera + connect por enlace). `container.ts` arma el `SolanaWalletAdapter`
 * SIN este colaborador, y hay un test que lo mide para que nadie lea "062 cerrada" como "el flujo
 * móvil anda" (CD-13).
 */
export class FirmaPorEnlaceReal implements FirmaPorEnlace {
  resolver(p: PedidoDeFirma): DesenlaceDeFirma {
    // 🔴 LA LIMPIEZA DE LOS CORTES VA EN UN SOLO LUGAR (CD-10/T6). `terminarViaje` es la única
    // limpieza que existe y SE LLEVA LOS RESULTADOS con ella, así que nunca va suelta en medio de una
    // rama.
    //
    // ⛔ Y NO SE LLAMA EN EL `"salto"`: ahí el viaje tiene que SOBREVIVIR, que es su razón de existir.
    //
    // ══ 🔴 UN CORTE NO PUEDE DESTRUIR UNA FIRMA QUE LA PERSONA YA DIO (AR/BLQ-ALTO-1) ══════════════
    //
    // Acá había un `terminarViaje` incondicional y era el agujero más caro de esta HU, MEDIDO: con un
    // viaje vigente que tenía una `transaccionFirmada` adentro —un depósito del camino del dinero que
    // la persona ya firmó y que NO ESTÁ EN MEMORIA DE NADIE, porque la página murió en el salto— tres
    // entradas distintas la tiraban a la basura:
    //   · `?rem=…&dl=firmar-tx`                          (una recarga o el botón atrás) ⇒ viaje BORRADO
    //   · `?rem=…&dl=firmar-patrocinio&errorCode=4001`   ⇒ viaje BORRADO
    //   · un `prepare()` que devolvió otro destino        ⇒ viaje BORRADO
    // Y los dos del medio los dispara TEXTO DE URL QUE NADIE AUTENTICÓ: el `errorCode` viaja sin
    // cifrar y lo escribe quien arme el enlace. Un enlace pegado en un chat, abierto a mitad de
    // recorrido, tiraba la firma del depósito. Es la trampa T4 que 061 midió, descargada sólo para
    // `manos-vacias`; por eso 061 decidió que un rechazo NO consuma el paso, y esto hacía algo peor.
    //
    // LA REGLA, y es la única que hace falta: **si en el disco hay un resultado que la persona ya
    // firmó, el corte NO borra nada.** Nada de excepciones por causa: cualquier causa que se agregue
    // mañana la hereda.
    //
    // ⚠️ LO QUE ESTO CUESTA, y acá estaba contado A MEDIAS (AR-it2/MNR-2). Cuando el corte preserva, la
    // x25519 privada del canal y la sesión sobreviven hasta que `MAX_EDAD_MS` (20 min) las venza, que es
    // justo lo que CD-10 quería evitar. Se elige el costo a sabiendas por dos razones medidas: (1) el
    // camino del `"salto"` YA deja exactamente eso en el disco por diseño, con la misma ventana, así que
    // no es una clase de exposición nueva; y (2) del otro lado lo que se destruye es una firma del camino
    // del dinero que no existe en ningún otro lugar del universo.
    //
    // 🔴 Y LA TERCERA RAZÓN QUE ESTABA ESCRITA ACÁ NO CORRE EN ESTE CAMINO, así que se tacha: decía que
    // "el que abandona de verdad tiene su propia limpieza, `abandonarAutorizacion()`". Ese método existe
    // (`abandonarAutorizacion`, `../../solana-wallet.ts:1099`) y lo llama UN solo sitio, `failAndRefund`
    // (`abandonarAutorizacion`, `../../../application/use-cases/confirm-and-send.ts:225`) — y el corte NO
    // pasa por ahí: la causa sube como `throw` desde `authorizePrincipal`, cuyo único llamador de
    // producción NO tiene `try/catch` alrededor (`authorizePrincipal`, `../../../application/use-cases/confirm-and-send.ts:486`),
    // así que `execute()` termina por excepción y nadie limpia nada. VERIFICADO leyendo los dos sitios.
    //
    // ⚠️ EL COSTO COMPLETO ES ÉSTE, con sus tres salidas y ni una más. Lo preservado se va del disco (a)
    // cuando una invocación nueva CIERRA el recorrido, (b) cuando la remesa muere de verdad y
    // `failAndRefund` corre, o (c) a los 20 min. Y (a) DEPENDE DE UN PRODUCTOR QUE HOY NO EXISTE: nadie
    // limpia el query string de vuelta, y MEDIDO con `?dl=…&errorCode=…` todavía en la barra tres
    // invocaciones idénticas repiten el mismo corte con el disco intacto, mientras que con el href limpio
    // SÍ retoma. O sea que en el navegador de hoy, para una URL de rechazo pegada a mano, la única salida
    // que queda es la ventana. El limpiador de la barra es de la ola 4 / HU-357.
    // 🔒 Y esas dos mitades no son prosa: las fija el `it` "con la URL de rechazo pegada, 3 invocaciones
    // repiten el corte sin tocar el disco; con el href limpio RETOMA", que muere con el mutante ALTO1-a.
    //
    // Y por qué se preserva TAMBIÉN el `Preparado` y no sólo el viaje: el `mensajeBase64` del registro
    // es lo ÚNICO contra lo que esa firma se puede verificar. Guardar la firma y borrar su ancla es
    // guardar algo que ya no sirve.
    const cortar = (causa: CausaDeEnlace): DesenlaceDeFirma => {
      const enDisco = leerViaje(p.almacen, p.ahora);
      // 🔴 SE PRESERVA LO QUE EL RECORRIDO TODAVÍA PUEDE USAR, no "cualquier string no vacío": el
      // predicado, su medición y su residuo están en `resultadoPreservable` (AR-it2/BLQ-BAJO-1). Acá
      // decía "basura en el campo de un resultado NO cuenta como firma" sobre un `esFirmaUtil` que
      // aceptaba cualquier basura no blanca, y eso trababa el recorrido hasta que la ventana lo mataba.
      const hayAlgoQueSalvar = enDisco.tipo === "hay" && resultadoPreservable(enDisco.viaje, p.sender);
      if (!hayAlgoQueSalvar) {
        terminarViaje(p.almacen);
        terminarPreparado(p.almacen);
      }
      return { tipo: "corte", causa };
    };

    // ── 1 · AC-5 / CD-5 — ¿el destino es el MISMO que el del intento en que se pidió la firma? ────
    //
    // 🔴 VA PRIMERO, ANTES DE `interpretarVuelta`, y el orden importa: `interpretarVuelta` es una
    // ESCRITURA con nombre de lectura (T1) que CONSUME el paso de forma irreversible. Si el destino
    // divergió, este viaje no va a servir para nada; quemarle un paso antes de decirlo sería tirar a
    // la basura una firma que la persona todavía podría dar en un viaje nuevo.
    //
    // 🔴 Y POR QUÉ ESTA COMPARACIÓN NO ES UNA REDUNDANCIA DEFENSIVA. El guard S3.5 del servidor cruza
    // el beneficiary contra `listPreparedDepositAddresses`, que devuelve **todas** las direcciones
    // preparadas para esa remesa y ese sender, y hace `includes(...)`: si una reanudación preparó una
    // SEGUNDA dirección, el servidor acepta **cualquiera de las dos**. Este caso no lo cubre el
    // servidor: lo cubre el cliente, acá.
    //
    // ⚠️ Lo persistido sólo sirve para COMPARAR, nunca para firmar: el valor que se firma siempre
    // salió de un `prepare()` cuya atestación se verificó en ESTE proceso. Por eso un disco
    // adulterado sólo puede producir un falso NEGATIVO (denegar un envío legítimo) y jamás un falso
    // positivo.
    const registro = leerPreparado(p.almacen, p.ahora);
    // 🔴 UN REGISTRO DE OTRA REMESA (O DE OTRA CUENTA) NO ES UN ANCLA — AR/BLQ-MED-2.
    //
    // La clave del `Preparado` es un SINGLETON del origen: no lleva la remesa ni el sender adentro.
    // Acá se comparaban `beneficiary` y `authority` y nada más, y los dos campos que sí dicen de quién
    // es el registro se persistían **y no los leía nadie**. Es el equivalente exacto de una cache key
    // sin `user_id`: un registro sobreviviente de otra remesa —o de otra cuenta de la misma
    // billetera— pasaba el guard y se adoptaba como ancla, con su `mensajeBase64` y su
    // `referenceBase58` ajenos. MEDIDO: con `remittanceId: "rem-DE-OTRA-REMESA"` y el mismo par
    // beneficiary/authority, el motor NO cortaba y el disco se quedaba con el registro ajeno.
    //
    // ⚠️ Y POR QUÉ ACÁ SE IGNORA EN VEZ DE CORTAR, al revés que con el viaje de más abajo: el
    // `Preparado` no tiene adentro ninguna firma ni ninguna clave —son identificadores y bytes
    // públicos— y sin el viaje de SU remesa no sirve para nada. Ignorarlo no destruye nada (la
    // sobre-escritura recién ocurre cuando ya se validó que el viaje es de ESTA remesa) y deja que el
    // recorrido nuevo empiece limpio. El viaje, en cambio, SÍ puede tener una firma adentro, y por eso
    // ése corta sin borrar.
    const ancla =
      registro.tipo === "hay" &&
      registro.preparado.remittanceId === p.remittanceId &&
      registro.preparado.sender === p.sender
        ? registro.preparado
        : null;
    if (ancla !== null) {
      // Los DOS campos, no uno: `authority` es quien puede liberar el vault. Comparar sólo el
      // `beneficiary` deja pasar una sustitución de la autoridad de release, que es la mitad cara.
      if (ancla.beneficiary !== p.beneficiary || ancla.authority !== p.authority) {
        return cortar(DEEPLINK_PREPARE_DIVERGED);
      }
    }

    // ── 2 · CD-11 / T12 — el viaje sólo puede COINCIDIR con el sender, nunca sustituirlo ──────────
    //
    // El paso 1 del protocolo es falsificable por diseño (no hay clave previa contra qué comparar) y
    // quien lo gana gana el viaje entero. Lo que esta línea garantiza es lo único que se puede
    // garantizar en esta capa: un connect forjado NO puede sustituir al depositante, sólo puede
    // DENEGAR el viaje. El `sender` sale de `this.getAddress()` y jamás del canal del enlace.
    //
    // ⛔ Comparación exacta. NUNCA `.toLowerCase()`: base58 es case-sensitive y bajarlo a minúsculas
    // fabrica colisiones. El adaptador ya canonicaliza los dos lados antes de llegar acá.
    const lectura = leerViaje(p.almacen, p.ahora);
    if (lectura.tipo !== "hay") return cortar(DEEPLINK_VIAJE_VENCIDO);
    const viaje = lectura.viaje;
    // Sin `claveBilletera`/`session`/`direccion` el connect nunca completó, así que no hay canal
    // cifrado con el que pedir nada. 062 NO es dueña del connect (es de la ola 4) y lo EXIGE: la
    // salida honesta es "este viaje no sirve, empezá uno nuevo".
    if (!estaConectado(viaje)) return cortar(DEEPLINK_VIAJE_VENCIDO);
    if (viaje.direccion !== p.sender) return cortar(DEEPLINK_SENDER_MISMATCH);

    // ── 3 · La ÚNICA llamada de producción de `interpretarVuelta` en todo el repo (CD-8/T1) ───────
    //
    // ⛔ PROHIBIDO llamarla desde un componente, un efecto, un `useMemo` o un render: consume el paso
    // de forma irreversible y un render puede correr dos veces (`reactStrictMode: true`).
    // `remesaEnCurso` va SIEMPRE con el id recibido, NUNCA `null` (T2).
    const vuelta = interpretarVuelta(
      p.almacen,
      new URLSearchParams(new URL(p.hrefActual).search),
      p.ahora,
      p.remittanceId,
    );

    // ── 4 · El `switch` sobre las diez variantes. ⛔ SIN `default` que trague ─────────────────────
    // El conjunto es cerrado: si mañana aparece una 11ª, el `never` del final NO COMPILA y hay que
    // decidir qué hacer con ella en vez de que caiga en un cajón.
    switch (vuelta.tipo) {
      case "no-volvimos":
        // No hay respuesta en esta URL: alguien entró de frente, o es la primera invocación. NO es un
        // rechazo. Se sigue al paso 5, que decide qué salto falta.
        break;
      case "huerfana":
        // 🔴 LOS DOS MOTIVOS NO SE TRATAN IGUAL, Y ÉSTA ES LA DIFERENCIA ENTRE BORRAR UNA FIRMA Y NO
        // BORRARLA (T4). `"manos-vacias"` significa que HAY viaje y puede tener una
        // `transaccionFirmada` adentro: reaccionar con "empezá de nuevo" + `terminarViaje` destruiría
        // una transacción del camino del dinero que no está en memoria de nadie.
        if (vuelta.motivo === "manos-vacias") break; // ⛔ NO limpiar: seguir a leer los resultados
        // `"sin-viaje"` es inalcanzable dado el guard 2 de arriba (que ya leyó un viaje vigente en
        // este mismo bloque síncrono), pero se escribe igual y NO se colapsa con el otro motivo:
        // colapsarlos es exactamente el bug que 061 midió.
        return cortar(DEEPLINK_VIAJE_VENCIDO);
      case "vencida":
        return cortar(DEEPLINK_VIAJE_VENCIDO);
      case "ya-consumida":
        // T11 — un viaje sirve para UN pedido de cada paso. Reintentar es empezar de cero, y es
        // además lo único compatible con la vida de un blockhash.
        return cortar(DEEPLINK_VIAJE_VENCIDO);
      case "otra-clave":
        // El sobre abrió, y ÉSE es el problema: lo cifró una clave que no es la que fijó el connect.
        // Los dos motivos (`no-coincide` y `sin-fijar`) dicen lo mismo para nosotros: lo que volvió
        // no es lo que esta app pidió firmar.
        return cortar(DEEPLINK_TX_ALTERADA);
      case "otra-remesa":
        return cortar(DEEPLINK_VIAJE_VENCIDO);
      case "conectado":
        // No debería llegar acá: el connect es de la ola 4 y NO suspende dentro de este método. Si
        // llega, este viaje no es el que esta invocación está manejando. Corte, no `throw`: el motor
        // no tira.
        //
        // ⛔ SIN TEST, DECLARADO, Y CON LA PRECONDICIÓN ESCRITA (AR-it2/MNR-3). Para que
        // `interpretarVuelta` devuelva `"conectado"` hacen falta LAS DOS COSAS A LA VEZ: (1) `dl=conectar`
        // en la URL con un sobre que abra con la clave que el disco ya tiene fijada, y (2) un viaje que YA
        // traiga `claveBilletera`/`session`/`direccion` —el guard `estaConectado` de arriba lo exige— pero
        // que NO tenga `"conectar"` en `pasosConsumidos`, porque si lo tiene la vuelta es `ya-consumida`
        // (`pasosConsumidos`, `sesion.ts:606`). Ese estado NO lo puede producir ningún escritor de
        // producción: el único que escribe `claveBilletera` es la rama del `conectar` (`claveBilletera`,
        // `sesion.ts:654`), y ese MISMO objeto agrega el paso a `pasosConsumidos` en la MISMA escritura
        // (`pasosConsumidos`, `sesion.ts:637`) — o la escritura falla entera y no persiste nada. MEDIDO
        // con una sonda: hand-escribiendo el disco con esa divergencia, la rama se alcanza; sin ella, no.
        // O sea que hoy sólo se llega con un disco escrito a mano, y este repo ya decidió dos veces qué
        // hacer con una rama así: borrarla o declararla, nunca congelarla en un test.
        // ⛔ Y BORRARLA NO COMPILA: el `never` del `default` es el candado. El día que la ola 4 escriba el
        // connect por enlace, esta rama pasa a ser alcanzable de verdad y ahí necesita su `it`.
        return cortar(DEEPLINK_VIAJE_VENCIDO);
      case "tx-firmada":
      case "patrocinio-firmado":
        // 🔴 SE MIRA LA `persistencia`, SIEMPRE (T3). Vive en 3 de las 10 variantes y nada del tipo
        // obliga a mirarla. `"no-se-pudo-guardar"` significa que el resultado es bueno pero este
        // dispositivo NO lo recuerda: se perdería en el salto siguiente, y el proceso va a morir en
        // ese salto. Saltar igual sería pedirle a la persona una firma que ya dio y que vamos a
        // volver a perder.
        if (vuelta.persistencia === "no-se-pudo-guardar") return cortar(DEEPLINK_SIN_MEMORIA);
        break;
      case "rechazo":
        // 🔴 EL `origen` DECIDE, NO EL `codigo` (T5). Son dos espacios distintos y mezclarlos hace que
        // un fallo de cripto NUESTRO se le muestre a la persona como "cancelaste".
        return cortar(
          vuelta.origen === "billetera" ? DEEPLINK_RECHAZADO : DEEPLINK_RESPUESTA_ILEGIBLE,
        );
      default: {
        // ⛔ ESTO NO TRAGA NADA: es el candado de exhaustividad. Si aparece una variante nueva en
        // `Vuelta`, esta asignación deja de compilar y `tsc` obliga a decidir qué hacer con ella.
        const nunca: never = vuelta;
        return cortar(nunca);
      }
    }

    // ── 5 · El viaje del disco tiene que ser DE ESTA REMESA ───────────────────────────────────────
    //
    // `interpretarVuelta` compara la remesa —y por eso existe `otra-remesa`— pero SÓLO cuando la URL
    // trae una respuesta. Por el camino `no-volvimos` / `huerfana-manos-vacias` nadie la compara, y los
    // resultados guardados de OTRA remesa entraban acá como si fueran de ésta (mismo defecto que el
    // `Preparado` del paso 1, y el `Viaje` es el que tiene las firmas adentro).
    //
    // Va DESPUÉS del `switch` a propósito: puesto antes dejaría `case "otra-remesa"` sin ningún camino
    // que lo alcance, y una rama inalcanzable con un test es una fantasía congelada. `no-volvimos` no
    // consume ningún paso, así que llegar hasta acá no cuesta nada.
    if (viaje.remittanceId !== p.remittanceId) return cortar(DEEPLINK_VIAJE_VENCIDO);

    // ── 6 · Qué falta — POR RESULTADOS, NUNCA por `viaje.paso` (T8) ───────────────────────────────
    //
    // `Viaje.paso` queda RANCIO por construcción: dice qué se fue a pedir en el salto en curso, no
    // qué se consiguió.
    //
    // 🔴 DE DÓNDE SALEN LOS RESULTADOS, y por qué acá ya no hay un segundo `leerViaje`. Antes se releía
    // el disco entero "porque `interpretarVuelta` acaba de escribir el resultado del paso que volvió",
    // y esa relectura traía dos ramas de error que NADIE podía alcanzar (medido: convertirlas en
    // `throw` no las dispara en la suite completa) — el mismo caso que este repo ya resolvió BORRANDO
    // la rama imposible en vez de dejarla sin test (`sesion.ts`, docblock de `LecturaDelViaje`).
    // El resultado que acaba de llegar viene EN LA `Vuelta` misma, y el guard de `persistencia` de más
    // arriba ya garantizó que el disco lo aceptó, así que releerlo no agregaba información: sólo
    // agregaba un segundo reloj y dos cortes fantasma.
    const txFirmadaCruda =
      vuelta.tipo === "tx-firmada" ? vuelta.transaccionBase58 : viaje.transaccionFirmada;
    const patrocinioCrudo =
      vuelta.tipo === "patrocinio-firmado" ? vuelta.firma : viaje.firmaDePatrocinio;
    // Presente pero basura ⇒ corte, no "ausente": tratarlo como ausente le pediría a la persona una
    // firma que ya dio. Ver `esFirmaUtil` por qué el disco puede traer un `object` acá.
    if (txFirmadaCruda !== undefined && !esFirmaUtil(txFirmadaCruda))
      return cortar(DEEPLINK_TX_ALTERADA);
    if (patrocinioCrudo !== undefined && !esFirmaUtil(patrocinioCrudo))
      return cortar(DEEPLINK_TX_ALTERADA);
    const txFirmada = txFirmadaCruda;
    const patrocinio = patrocinioCrudo;

    // ── 7 · Los `DatosDeSesion`, armados en UN SOLO SITIO (T10) ───────────────────────────────────
    //
    // ⛔ `secreta` y `publica` son las DOS base58 de 32 bytes y NADA detecta que se intercambien
    // hasta que la vuelta no abre. Por eso se arman una sola vez: `clavePublicaDeLaApp` sale de
    // `viaje.publica` (la que la billetera ya vio) y el secreto compartido de `secretaBytes` (la
    // privada, que NO sale de este módulo).
    const sesion = (paso: "firmar-tx" | "firmar-patrocinio"): DatosDeSesion => ({
      billetera: viaje.billetera,
      appUrl: p.appUrl,
      redirectLink: enlaceDeVuelta(p.hrefActual, paso), // el href COMPLETO (T9)
      clavePublicaDeLaApp: bs58.decode(viaje.publica),
      secreto: secretoCompartido(viaje.claveBilletera, lectura.secretaBytes),
      session: viaje.session,
    });

    // ── 8 · Falta la firma de la transacción ⇒ salto 2, Y EL ANCLA SE PONE SOBRE **ESTA** TX ───────
    //
    // ⛔ El orden `firmar-tx` → `firmar-patrocinio` es fijo (AC-6) y no es una convención: el mensaje
    // de patrocinio lleva ADENTRO la firma de la transacción, así que pedirlo antes es imposible.
    //
    // ══ 🔴 EL ANCLA Y LA TX QUE SE MANDA A FIRMAR SON LA MISMA COSA (AR/BLQ-MED-1) ═════════════════
    //
    // Acá estaba el segundo agujero caro de la HU. El `Preparado` se escribía UNA vez —en la primera
    // invocación— y no se refrescaba nunca, pero el salto del paso 2 se puede pedir más de una vez (y
    // se va a pedir: la persona vuelve sin haber firmado, y ése es el caso más común que existe), y
    // cada invocación rearma la tx con `reference` nueva, `deadline` nuevo y blockhash nuevo. O sea:
    // se le pedía firmar txB mientras el ancla seguía siendo msgA. MEDIDO: la invocación final tiraba
    // `deeplink_tx_alterada` —una causa FALSA, la billetera había devuelto exactamente lo que se le
    // pidió— y de paso destruía las dos firmas. El recorrido era **estructuralmente incapaz de
    // cerrar** en cuanto hubiera un segundo pedido del paso 2.
    //
    // La regla ahora es una sola línea de invariante: **el registro describe la tx que se está
    // mandando a firmar en este mismo momento.** Por eso la escritura vive acá, pegada al salto, y no
    // arriba.
    //
    // ⚠️ CUATRO COSAS QUE ESTA ESCRITURA **NO** HACE, y hay que leerlas juntas:
    //   · NO puede mover `beneficiary`/`authority`. Si hubieran divergido, el paso 1 ya cortó; si no
    //     divergieron, los de `p` son idénticos a los del registro. AC-5/CD-5 no se ablanda ni un
    //     poco: lo único que se mueve son los dos campos que DESCRIBEN la transacción.
    //   · NO refresca `desde`. Refrescarlo dejaría la ventana de 20 min corriendo de nuevo en cada
    //     invocación, o sea una ventana cuya duración la elige quien pueda provocar invocaciones. El
    //     recorrido vence cuando venció, no cuando se lo mira.
    //   · NO se ejecuta cuando ya hay una tx firmada. La condición del `if` ES la garantía: sólo se
    //     re-ancla cuando se va a mandar una tx nueva. Si la billetera ya devolvió la firma, el ancla
    //     es la de la tx que se firmó y nadie la toca.
    //   · NO le da al ancla más de UN SLOT, y ése es el residual declarado de este invariante
    //     (AR-it2/BLQ-BAJO-2). `Preparado` es un registro único, así que el salto B PISA el ancla del
    //     salto A mientras el pedido A sigue siendo contestable. MEDIDO con `Transaction` reales: si la
    //     billetera contesta A, el motor devuelve `"completo"` con la tx de A y el ancla de B, el
    //     adaptador compara bytes contra bytes (`mensajeDevuelto`, `../../solana-wallet.ts:896`) y tira
    //     `deeplink_tx_alterada` —limpiando— sobre una firma que la persona SÍ dio, con una causa que
    //     afirma "no es lo que se pidió firmar" cuando sí lo era, un pedido antes. Lo congela el `it`
    //     "la billetera contesta el pedido ANTERIOR…", que está escrito como limitación y no como
    //     comportamiento deseado.
    //     ⛔ NO SE ARREGLA EN 062, y no por costo: el disparador —que una billetera conteste un pedido
    //     que ya no es el último— es una afirmación sobre runtime móvil que NADIE midió, y CD-4/CD-12
    //     prohíben construir sobre eso. Las dos salidas quedan escritas para la ola 4: darle N slots al
    //     ancla (cambia el formato del disco y ensancha lo que el adaptador acepta, de "los bytes del
    //     último pedido" a "los de cualquiera de los N") o no re-anclar mientras haya un salto sin
    //     respuesta, que es LITERALMENTE el mutante MED1-a, o sea el bug que este invariante vino a
    //     cerrar. Plata en riesgo: NINGUNA —nunca hubo POST al settle—; el costo es una firma que hay que
    //     volver a pedir.
    //
    // Y sigue valiendo lo de siempre: `guardarPreparado` TIRA a propósito (igual que `guardarViaje`) y
    // esa excepción sube tal cual. Si el disco no acepta el registro, saltar sería mandar a la persona
    // a firmar algo contra lo que este dispositivo no va a poder comparar nada al volver — y esa
    // comparación es lo único que hay del lado del cliente contra una sustitución de depositante.
    if (txFirmada === undefined) {
      guardarPreparado(p.almacen, {
        remittanceId: p.remittanceId,
        sender: p.sender,
        beneficiary: p.beneficiary,
        authority: p.authority,
        mensajeBase64: p.mensajeBase64,
        referenceBase58: p.referenceBase58,
        desde: ancla?.desde ?? p.ahora,
      });
      return {
        tipo: "salto",
        irA: urlFirmarTransaccion({
          ...sesion("firmar-tx"),
          transaccionBase58: p.transaccionBase58,
        }),
        esperando: "firma-tx",
      };
    }

    // ── 9 · Hay una firma en el disco y no hay ancla contra la que verificarla ─────────────────────
    //
    // Este es el `deeplink_sin_memoria` que antes vivía en el adaptador, donde nadie podía alcanzarlo
    // ni testearlo. Acá sí: pasa cuando el registro venció, cuando se limpió solo por basura, o cuando
    // el que quedó es de otra remesa. Sin `mensajeBase64` no hay con qué hacer la verificación
    // bytes-contra-bytes, y firmar el settle sin ella sería aceptar lo que devuelva el canal.
    if (ancla === null) return cortar(DEEPLINK_SIN_MEMORIA);

    // AC-8 / CD-7 — con la tx ya firmada NO se vuelve a pedir esa firma: se sigue por el salto que
    // falta. Reiniciar los tres saltos sería pedirle a la persona una firma que ya dio.
    if (patrocinio === undefined) {
      const firma = firmaDelSender(txFirmada, p.sender);
      // Sin la firma del sender adentro de lo que volvió, no hay mensaje de patrocinio que armar: lo
      // que devolvió la billetera no es lo que se pidió firmar.
      if (firma === null) return cortar(DEEPLINK_TX_ALTERADA);
      return {
        tipo: "salto",
        irA: urlFirmarMensaje({
          ...sesion("firmar-patrocinio"),
          mensaje: p.mensajeDePatrocinio(firma),
        }),
        esperando: "firma-patrocinio",
      };
    }

    // ── 10 · Están las dos ⇒ completo ─────────────────────────────────────────────────────────────
    //
    // `referenceBase58` y `mensajeBase64` salen del ANCLA y no de `p`: los dos describen la
    // transacción que está firmada, no la que esta invocación armó y descartó.
    //
    // ⛔ Y ACÁ **NO** SE LIMPIA, que es un cambio deliberado respecto de la primera versión (AR/MNR-3).
    // La limpieza del camino de éxito la hace el adaptador DESPUÉS de verificar los bytes y de
    // preguntarle a la cadena por el blockhash, porque esas dos cosas pueden fallar: si se limpiara
    // acá, un RPC que no contesta dejaría a la persona sin nada que reanudar sobre un recorrido cuyas
    // dos firmas estaban perfectas. CD-10 pide "leer, usar, y DESPUÉS limpiar": el uso termina en el
    // adaptador, así que ahí termina la limpieza.
    return {
      tipo: "completo",
      transaccionFirmadaBase58: txFirmada,
      firmaDePatrocinio: patrocinio,
      referenceBase58: ancla.referenceBase58,
      mensajeBase64: ancla.mensajeBase64,
    };
  }
}
