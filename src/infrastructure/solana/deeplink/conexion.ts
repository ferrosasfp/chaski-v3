// La pata CONECTAR del recorrido por enlace profundo (WKH-358 / ola 4).
//
// 🔴 QUÉ ES ESTO Y QUÉ NO ES. El motor de firma (`firma-por-enlace.ts`) escribe los pasos 2 y 3 —firmar
// la transacción del depósito y firmar el mensaje de patrocinio—, y CONSUME un viaje que ya está
// conectado. Nadie escribía el paso 1. Este módulo lo escribe: abre el viaje, produce la URL del
// connect, y al volver completa `claveBilletera` / `session` / `direccion` en ese mismo viaje.
//
// ⛔ Y LO QUE ESTA HU NO ENTREGA, DICHO ACÁ PARA QUE NADIE LO LEA AL REVÉS: el DEPÓSITO por enlace no
// cierra con esto. `prepare()` exige una prueba de posesión firmada por el bridge
// (`http-solana-prepare-gateway.ts:222-235`), y en un teléfono sin extensión el bridge está vacío, así
// que todo depósito por enlace muere en `payout_pop_unavailable` ANTES de que la rama de enlace de
// `authorizePrincipal` ejecute una línea. Eso es una HU aparte (WKH-359). Lo que SÍ cierra acá es el
// recorrido de la CUENTA DE NONCE: connect por enlace, firma por enlace, broadcast, y lectura de la
// cadena.
//
// ⚠️ POR QUÉ VIVE EN ESTA CARPETA. Por la misma razón que el motor (`firma-por-enlace.ts:4-6`): es un
// colaborador interno del adaptador, y la clave privada x25519 del canal NO sale de acá.
//
// DT-7 — este módulo NO lee `window`, ni `Date`, ni `fetch`, ni `process.env`. El almacén, el instante y
// el href entran por parámetro, igual que en `sesion.ts` y en `preparado.ts`. Lo mide `T-065-PUREZA`.
//
// 🔴 Y ES SÍNCRONO, por la misma razón que el motor (`firma-por-enlace.ts:8-13`): la atomicidad de
// `interpretarVuelta` depende de que la lectura del disco y su escritura vivan en el MISMO bloque
// síncrono. Un `await` en el medio reintroduce la ventana de read-modify-write que el fix-pack 2 de la
// ola 1 cerró (el bloque de `interpretarVuelta` sobre eso está en `sesion.ts:554-570`).
import bs58 from "bs58";
import type { Almacen, Viaje } from "./sesion";
import { enlaceDeVuelta, guardarViaje } from "./sesion";
import type { BilleteraDeeplink } from "./protocol";
import { nuevoParDeCifrado, urlConectar } from "./protocol";
import type { CausaDeEnlace } from "./firma-por-enlace";

/**
 * La marca del salto que pide la firma de la transacción que CREA la cuenta de nonce.
 *
 * 🔴 NO ES UN `PasoDelViaje`, Y ESO ES EL MECANISMO, NO UN DESCUIDO. (`esPaso`, `sesion.ts:121`) es un
 * conjunto CERRADO de tres valores (`PasoDelViaje`, `sesion.ts:114`), así que `interpretarVuelta`
 * contesta `no-volvimos` para esta marca y **el motor no consume ni destruye nada** si esta marca queda
 * en la barra. Si en cambio fuera un cuarto `PasoDelViaje`, el motor la miraría, no sabría qué hacer con
 * ella, y el `switch` con `never` de (`nunca`, `firma-por-enlace.ts:639`) dejaría de compilar.
 *
 * ⛔ NO la agregues a `PasoDelViaje` "para que sea uniforme": ese conjunto describe los pasos del viaje
 * del DEPÓSITO, y este salto no es parte de ese viaje — pasa antes, y su resultado (una cuenta creada en
 * la cadena) sobrevive a todos los envíos que la persona haga después.
 */
export const MARCA_CREAR_NONCE = "crear-nonce";

/** Todo lo que este módulo necesita para decidir. Nada de esto lo lee él: se lo pasan. */
export interface PedidoDeConexion {
  almacen: Almacen;
  /** ms epoch, por parámetro (DT-7). */
  ahora: number;
  /**
   * El href COMPLETO, no `pathname + search`.
   *
   * 🔴 No es una preferencia: (`enlaceDeVuelta`, `sesion.ts:495`) hace `new URL(origen)` y **TIRA** con
   * una URL relativa, sin declararlo en su firma (medido en la ola 1, T9). Mismo requisito, misma razón
   * y mismas palabras que (`hrefActual`, `firma-por-enlace.ts:209`).
   */
  hrefActual: string;
  /** Para que la billetera muestre título e ícono en su diálogo. */
  appUrl: string;
  /**
   * Qué remesa. ⛔ **NUNCA `null`**, por el mismo motivo que (`remittanceId`, `firma-por-enlace.ts:217`):
   * `interpretarVuelta` acepta `null` como "no tengo remesa en contexto" y con eso **apaga el guard de
   * cruce entre remesas y consume el paso igual**. El viaje que se abre acá lleva el `remittanceId`
   * desde el primer byte (CD-5).
   */
  remittanceId: string;
  /**
   * `devnet` / `mainnet-beta` / … EXPLÍCITO, nunca omitido.
   *
   * El default de las DOS billeteras es `mainnet-beta` y Chaski está en devnet: omitirlo haría que la
   * persona autorice sobre la red equivocada. Es la misma razón que ya está escrita en
   * (`urlConectar`, `protocol.ts:149`), y lo mide `T-065-1`.
   */
  cluster: string;
}

/**
 * Qué salió de leer la URL de vuelta.
 *
 * `nonce-firmado` NO dice "la cuenta existe": dice que hay una transacción firmada que **todavía hay que
 * transmitir**, y transmitirla es del adaptador, que es el único que conoce la cadena (DT-7). Quién
 * contesta si la cuenta quedó creada es `leerNonce`, releyendo la cadena — nunca el resultado del
 * broadcast (§4.4 del Story File: "el RPC aceptó la tx" no es "la cuenta existe").
 */
export type VueltaDeConexion =
  /** En esta URL no hay ninguna marca NUESTRA. No es un rechazo y no se toca el disco. */
  | { tipo: "nada" }
  | { tipo: "conectado"; direccion: string }
  /** Hay que transmitirla. Lo hace el adaptador, con el patrón de `closeEscrow`. */
  | { tipo: "nonce-firmado"; transaccionBase58: string }
  | { tipo: "corte"; causa: CausaDeEnlace };

/**
 * La billetera que la persona eligió en el selector, o `null`.
 *
 * Es un tipo propio y no `BilleteraDeeplink | null` suelto para que el sitio que lo consume tenga que
 * nombrar el caso "no eligió nada", que es el que apaga el gate del recorrido por enlace.
 */
export type EleccionDeBilletera = BilleteraDeeplink | null;

/**
 * CLAVE PROPIA, la TERCERA del recorrido, distinta de la del `Viaje`
 * (`"chaski.billetera.viaje.v1"`, `sesion.ts:95`) y de la del `Preparado`
 * (`"chaski.billetera.preparado.v1"`, `preparado.ts:31`).
 *
 * ⛔ NO reusar ninguna de las otras dos, por el mismo argumento que ya está escrito en
 * (`CLAVE`, `preparado.ts:31`): son ciclos de vida distintos y compartir clave haría que limpiar uno se
 * llevara el otro. Acá la asimetría es la más fuerte de las tres: el viaje y el preparado se limpian en
 * CADA corte, y la elección de billetera tiene que sobrevivir a un corte — si no, una persona que vuelve
 * de un rechazo se encontraría el selector otra vez en vez de poder reintentar.
 *
 * 🔴 Y NO TIENE VENTANA DE EXPIRACIÓN, que es una decisión y no un olvido. La elección de billetera **no
 * es un secreto ni un paso consumible**: es una preferencia. Expirarla tendría un modo de falla propio y
 * peor que el que evita: si venciera ENTRE el salto 1 y la vuelta, el gate de `caminoPorEnlace()` se
 * apagaría y el recorrido caería al camino inyectado **en silencio**, con la vuelta de la billetera ya
 * en la barra y nadie que la lea. Lo único que la borra es un gesto explícito (`olvidarEleccion`).
 */
const CLAVE_ELECCION = "chaski.billetera.eleccion.v1";

/** El conjunto CERRADO de dos, comparado con literales para que `tsc` estreche en el que llama. */
function esBilletera(x: unknown): x is BilleteraDeeplink {
  return x === "phantom" || x === "solflare";
}

/**
 * Qué billetera eligió la persona, o `null`.
 *
 * 🔴 **NO TIRA NUNCA, Y ESO ES PARTE DEL CONTRATO.** Esta función la llama el gate del adaptador
 * (`caminoPorEnlace`), que corre DENTRO de `authorizePrincipal`, en el camino del dinero. Un
 * `localStorage` que no deja leer (cookies bloqueadas, modo privado) o un valor de basura tienen que
 * contestar `null` —o sea *"este recorrido no es por enlace"*— y degradar al camino inyectado, que es el
 * único verificado. ⛔ Si esto tirara, una falla de disco convertiría un depósito normal en una
 * excepción sin causa traducible.
 *
 * Valida contra el conjunto cerrado y no confía en el disco: lo escribe cualquiera que pueda ejecutar en
 * este origen. Un `"phantom "` con espacio, un `"PHANTOM"` o un `{}` salen `null`.
 */
export function leerEleccion(a: Almacen): EleccionDeBilletera {
  let crudo: string | null;
  try {
    crudo = a.leer(CLAVE_ELECCION);
  } catch {
    return null; // sin disco no hay elección que recordar, y el camino conocido es el inyectado
  }
  return esBilletera(crudo) ? crudo : null;
}

/**
 * Persiste la elección del selector.
 *
 * ⚠️ ESTA SÍ PUEDE TIRAR, y por la MISMA razón que (`guardarViaje`, `sesion.ts:222`): se llama ANTES del
 * salto. Un dispositivo que no puede recordar qué billetera se eligió no va a poder reconocer la vuelta,
 * así que saltar sería mandar a la persona a autorizar algo que este navegador no va a saber leer.
 *
 * 🔴 ES EL ÚNICO ESCRITOR DE ESTA CLAVE, y lo llama SÓLO el selector. El gate del adaptador la LEE y
 * nunca la escribe: si el adaptador pudiera escribirla, el recorrido por enlace podría encenderse a sí
 * mismo sin ningún gesto de la persona, que es exactamente lo que las dos condiciones del gate impiden.
 */
export function guardarEleccion(a: Almacen, billetera: BilleteraDeeplink): void {
  a.escribir(CLAVE_ELECCION, billetera);
}

/**
 * Olvida la elección. NO tira: es limpieza, igual que (`terminarViaje`, `sesion.ts:236`) y
 * (`terminarPreparado`, `preparado.ts:80`). Un almacén que no deja borrar deja basura, y decírselo a
 * quien llama no le da ninguna decisión mejor que seguir.
 */
export function olvidarEleccion(a: Almacen): void {
  try {
    a.borrar(CLAVE_ELECCION);
  } catch {
    // Ver arriba. Tirar acá rompería una salida entera por una limpieza.
  }
}

/**
 * PASO 1 · Abre un viaje NUEVO y devuelve la URL del connect.
 *
 * 🔴 ES EL ÚNICO ESCRITOR DE PRODUCCIÓN DE UN VIAJE **INICIAL**, y hasta esta HU no existía ninguno:
 * (`guardarViaje`, `sesion.ts:222`) sólo se alcanzaba desde `consumir`
 * (`consumir`, `sesion.ts:632`), que **actualiza** un viaje que ya está. Eso es lo que dejaba
 * al motor de firma sin nadie que lo alimentara.
 *
 * ⚠️ TIRA SI EL DISCO NO ACEPTA EL VIAJE, y es deliberado — es la misma decisión que
 * (`guardarViaje`, `sesion.ts:222`) ya tiene escrita en `:213-221`: se llama **antes** del salto, así
 * que un viaje que no se pudo guardar significa que este dispositivo no va a poder reconocer la vuelta.
 * Saltar igual sería mandar a la persona a autorizar a ciegas. ⛔ No envolver esto en un `try`.
 *
 * 🔒 EL `remittanceId` VA DESDE EL PRIMER BYTE (CD-5). El dueño cruzado del viaje —remesa **y**
 * sender— es lo que hace que una vuelta de otra remesa salga `otra-remesa`
 * (`remittanceId`, `sesion.ts:597`) en vez de aplicarse sobre la que está en curso.
 *
 * ⛔ NO fija `claveBilletera`, `session` ni `direccion`: esos TRES los escribe la vuelta del connect, y
 * el ancla `claveBilletera` es de UNA SOLA ESCRITURA (`claveBilletera`, `sesion.ts:148`). Un viaje
 * recién abierto NO está conectado (`estaConectado`, `firma-por-enlace.ts:277` exige los tres), y por
 * eso el motor de firma **corta antes** de tocarlo: los dos extremos del flujo no se pisan.
 */
export function iniciarConexion(
  p: PedidoDeConexion & { billetera: BilleteraDeeplink },
): { irA: string } {
  const par = nuevoParDeCifrado();
  const viaje: Viaje = {
    billetera: p.billetera,
    secreta: bs58.encode(par.secreta),
    publica: bs58.encode(par.publica),
    paso: "conectar",
    remittanceId: p.remittanceId,
    desde: p.ahora,
  };
  guardarViaje(p.almacen, viaje); // TIRA a propósito: ver el docblock
  return {
    irA: urlConectar({
      billetera: p.billetera,
      appUrl: p.appUrl,
      // La marca del paso la pone `enlaceDeVuelta`, que además LIMPIA del origen los parámetros de
      // respuesta que ya trajera. Sin esa limpieza, un `redirect_link` armado sobre una URL que ya
      // volvió de un salto se lleva el `nonce`/`data` viejos adentro.
      redirectLink: enlaceDeVuelta(p.hrefActual, "conectar"),
      clavePublicaDeLaApp: par.publica,
      // ⛔ EXPLÍCITO SIEMPRE. El default de las dos billeteras es `mainnet-beta`: omitirlo haría que la
      // persona autorice sobre la red equivocada. Lo mide `T-065-1`.
      cluster: p.cluster,
    }),
  };
}
