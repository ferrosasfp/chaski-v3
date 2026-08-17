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
// Las causas. Strings estables: viajan como `Error.message` desde `authorizePrincipal` y la capa de
// presentación las traduce. Cada docblock dice QUÉ AFIRMA y QUÉ NO AFIRMA, porque la mitad de los
// errores caros de este repo salieron de una causa que afirmaba de más.
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
 * AFIRMA: lo que volvió no es lo que se pidió firmar, o la firma no verifica sobre esos bytes.
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
    // 🔴 LA LIMPIEZA VA EN UN SOLO LUGAR Y SE LLAMA EN TODAS LAS SALIDAS DE CORTE (CD-10/T6).
    // `terminarViaje` es la única limpieza que existe y SE LLEVA LOS RESULTADOS con ella, así que
    // llamarla antes de haber leído lo que hace falta destruye una firma que la persona ya dio. Por
    // eso está acá abajo, encapsulada, y nunca suelta en medio de una rama.
    //
    // ⛔ Y NO SE LLAMA EN EL `"salto"`: ahí el viaje tiene que SOBREVIVIR, que es su razón de existir.
    const cortar = (causa: CausaDeEnlace): DesenlaceDeFirma => {
      terminarViaje(p.almacen);
      terminarPreparado(p.almacen);
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
    if (registro.tipo === "hay") {
      // Los DOS campos, no uno: `authority` es quien puede liberar el vault. Comparar sólo el
      // `beneficiary` deja pasar una sustitución de la autoridad de release, que es la mitad cara.
      if (
        registro.preparado.beneficiary !== p.beneficiary ||
        registro.preparado.authority !== p.authority
      ) {
        return cortar(DEEPLINK_PREPARE_DIVERGED);
      }
    }
    // Primera invocación: no hay nada contra qué comparar todavía, así que se ESCRIBE el registro
    // ANTES de pedir cualquier salto.
    //
    // ⚠️ `guardarPreparado` TIRA a propósito y esa excepción sube tal cual, igual que `guardarViaje`.
    // Si el disco no acepta el registro, saltar sería mandar a la persona a firmar algo contra lo
    // que este dispositivo no va a poder comparar nada al volver — y esa comparación es lo único que
    // hay del lado del cliente contra una sustitución de depositante (AC-5). Que no salte es el
    // comportamiento correcto.
    const preparado =
      registro.tipo === "hay"
        ? registro.preparado
        : (() => {
            const nuevo = {
              remittanceId: p.remittanceId,
              sender: p.sender,
              beneficiary: p.beneficiary,
              authority: p.authority,
              mensajeBase64: p.mensajeBase64,
              referenceBase58: p.referenceBase58,
              desde: p.ahora,
            };
            guardarPreparado(p.almacen, nuevo);
            return nuevo;
          })();

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

    // ── 5 · Qué falta — POR RESULTADOS, NUNCA por `viaje.paso` (T8) ───────────────────────────────
    //
    // `Viaje.paso` queda RANCIO por construcción: dice qué se fue a pedir en el salto en curso, no
    // qué se consiguió. Decidir con él manda al salto equivocado y le pide a la persona dos veces la
    // misma firma. Los resultados se releen del disco DESPUÉS de `interpretarVuelta`, porque es esa
    // llamada la que acaba de escribir el resultado del paso que volvió.
    const despues = leerViaje(p.almacen, p.ahora);
    if (despues.tipo !== "hay") return cortar(DEEPLINK_VIAJE_VENCIDO);
    const conseguido = despues.viaje;
    if (!estaConectado(conseguido)) return cortar(DEEPLINK_VIAJE_VENCIDO);
    const txFirmada = conseguido.transaccionFirmada;
    const patrocinio = conseguido.firmaDePatrocinio;

    // ── 6 · Los `DatosDeSesion`, armados en UN SOLO SITIO (T10) ───────────────────────────────────
    //
    // ⛔ `secreta` y `publica` son las DOS base58 de 32 bytes y NADA detecta que se intercambien
    // hasta que la vuelta no abre. Por eso se arman una sola vez: `clavePublicaDeLaApp` sale de
    // `viaje.publica` (la que la billetera ya vio) y el secreto compartido de `secretaBytes` (la
    // privada, que NO sale de este módulo).
    const sesion = (paso: "firmar-tx" | "firmar-patrocinio"): DatosDeSesion => ({
      billetera: conseguido.billetera,
      appUrl: p.appUrl,
      redirectLink: enlaceDeVuelta(p.hrefActual, paso), // el href COMPLETO (T9)
      clavePublicaDeLaApp: bs58.decode(conseguido.publica),
      secreto: secretoCompartido(conseguido.claveBilletera, despues.secretaBytes),
      session: conseguido.session,
    });

    // Falta la firma de la transacción ⇒ salto 2. ⛔ El orden `firmar-tx` → `firmar-patrocinio` es
    // fijo (AC-6) y no es una convención: el mensaje de patrocinio lleva ADENTRO la firma de la
    // transacción, así que pedirlo antes es imposible, no sólo incorrecto.
    if (txFirmada === undefined) {
      return {
        tipo: "salto",
        irA: urlFirmarTransaccion({
          ...sesion("firmar-tx"),
          transaccionBase58: p.transaccionBase58,
        }),
        esperando: "firma-tx",
      };
    }

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

    // ── 7 · Están las dos ⇒ completo. LEER TODO PRIMERO, limpiar DESPUÉS (CD-10/T6) ───────────────
    // `referenceBase58` sale del REGISTRO PERSISTIDO y no de `p`: la reference que vale es la que
    // está DENTRO de la transacción firmada, no la de la tx que esta invocación armó y descartó.
    const desenlace: DesenlaceDeFirma = {
      tipo: "completo",
      transaccionFirmadaBase58: txFirmada,
      firmaDePatrocinio: patrocinio,
      referenceBase58: preparado.referenceBase58,
    };
    terminarViaje(p.almacen);
    terminarPreparado(p.almacen);
    return desenlace;
  }
}
