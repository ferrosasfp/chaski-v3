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
import { MARCA, enlaceDeVuelta, guardarViaje, interpretarVuelta, leerViaje } from "./sesion";
import type { BilleteraDeeplink } from "./protocol";
import { PARAMS_DE_RESPUESTA, nuevoParDeCifrado, urlConectar } from "./protocol";
import type { CausaDeEnlace } from "./firma-por-enlace";
import {
  DEEPLINK_RECHAZADO,
  DEEPLINK_RESPUESTA_ILEGIBLE,
  DEEPLINK_SIN_MEMORIA,
  DEEPLINK_TX_ALTERADA,
  DEEPLINK_VIAJE_VENCIDO,
} from "./firma-por-enlace";

/**
 * La marca del salto que pide la firma de la transacción que CREA la cuenta de nonce.
 *
 * 🔴 NO ES UN `PasoDelViaje`, Y ESO ES EL MECANISMO, NO UN DESCUIDO. (`esPaso`, `sesion.ts:121`) es un
 * conjunto CERRADO de tres valores (`PasoDelViaje`, `sesion.ts:114`), así que `interpretarVuelta`
 * contesta `no-volvimos` para esta marca y **el motor no consume ni destruye nada** si esta marca queda
 * en la barra. Si en cambio fuera un cuarto `PasoDelViaje`, el motor la miraría, no sabría qué hacer con
 * ella, y el `switch` con `never` de (`nunca`, `firma-por-enlace.ts:712`) dejaría de compilar.
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
 * recién abierto NO está conectado (`estaConectado`, `firma-por-enlace.ts:293` exige los tres), y por
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

/**
 * Lee la URL y el disco y decide qué pasó.
 *
 * 🔴 **EL SEGUNDO Y ÚLTIMO LLAMADOR DE PRODUCCIÓN DE `interpretarVuelta`** (CD-11). El otro es el motor
 * (`firma-por-enlace.ts`). Lo mide `T-062-10`, invertido en esta HU a la lista exacta de dos.
 *
 * ⛔ PROHIBIDO LLAMARLA DESDE UN RENDER, UN `useMemo` O UN EFECTO SIN GATE DE MONTAJE. Consume el paso
 * de forma IRREVERSIBLE y `reactStrictMode: true` invoca los efectos dos veces: la segunda lectura
 * devolvería `ya-consumida` sobre una respuesta buena. Su único llamador es el productor de montaje de
 * `flow.tsx`, gateado por un ref.
 *
 * 🔴 POR QUÉ NO TOCA LAS MARCAS DEL MOTOR, que es la línea más peligrosa de este módulo: `firmar-tx` y
 * `firmar-patrocinio` son vueltas que el MOTOR necesita consumir. Llamarlas acá **quemaría el paso**
 * —`interpretarVuelta` marca el paso consumido en la misma escritura en la que devuelve el resultado—
 * y el motor recibiría después `ya-consumida` sobre una firma que la persona sí dio. Lo mide `T-065-4`.
 */
export function completarVuelta(p: PedidoDeConexion): VueltaDeConexion {
  const params = new URLSearchParams(new URL(p.hrefActual).search);
  const marca = params.get(MARCA);

  // ⛔ SIN TOCAR EL DISCO. Ni `conectar` ni nada: acá no hay ninguna marca nuestra que interpretar.
  // Incluye el caso de una marca DESCONOCIDA (algo que nadie de este repo escribió).
  if (marca !== "conectar") {
    // 🔴 ÉSTA ES LA LÍNEA QUE PROTEGE AL MOTOR. `firmar-tx` y `firmar-patrocinio` caen acá y salen
    // `nada` SIN pasar por `interpretarVuelta`. La marca del nonce (`crear-nonce`) también sale por
    // acá hasta que su rama exista, y eso es seguro por construcción: `esPaso("crear-nonce")` es
    // falso, así que `interpretarVuelta` contestaría `no-volvimos` y no consumiría nada igual.
    return { tipo: "nada" };
  }

  const vuelta = interpretarVuelta(p.almacen, params, p.ahora, p.remittanceId);

  // ⚠️ LA TRADUCCIÓN ES LA MISMA QUE LA DEL MOTOR, CAUSA POR CAUSA, y eso es deliberado: son las mismas
  // diez variantes y el mismo vocabulario `deeplink_*` llega a la misma pantalla. Un segundo criterio
  // acá haría que la misma vuelta se le explique distinto a la persona según qué paso estaba corriendo.
  // ⛔ SIN `default` QUE TRAGUE: el `never` del final es el candado de exhaustividad.
  switch (vuelta.tipo) {
    case "conectado":
      // 🔴 SE MIRA LA `persistencia`, igual que el motor con `tx-firmada`. `"no-se-pudo-guardar"`
      // significa que la billetera contestó bien pero este dispositivo NO lo recuerda: la dirección se
      // perdería en el salto siguiente. Seguir sería construir el recorrido sobre un dato que ya sabemos
      // que no sobrevive.
      if (vuelta.persistencia === "no-se-pudo-guardar") return { tipo: "corte", causa: DEEPLINK_SIN_MEMORIA };
      return { tipo: "conectado", direccion: vuelta.direccion };
    case "no-volvimos":
      // La marca estaba pero `interpretarVuelta` no vio respuesta. No es un rechazo.
      return { tipo: "nada" };
    case "huerfana":
      // Mismos dos motivos y mismo trato asimétrico que el motor: `manos-vacias` NO limpia nada.
      return vuelta.motivo === "manos-vacias"
        ? { tipo: "nada" }
        : { tipo: "corte", causa: DEEPLINK_VIAJE_VENCIDO };
    case "vencida":
    case "ya-consumida":
    case "otra-remesa":
      return { tipo: "corte", causa: DEEPLINK_VIAJE_VENCIDO };
    case "otra-clave":
      // 🔒 ACÁ MUERE EL CONNECT FORJADO TARDÍO. El ancla `claveBilletera` es write-once
      // (`claveBilletera`, `sesion.ts:148`), así que una vez fijada ningún connect posterior la pisa.
      // Lo mide `T-065-3`.
      return { tipo: "corte", causa: DEEPLINK_TX_ALTERADA };
    case "rechazo":
      // El `origen` decide y no el `codigo`, por lo mismo que en el motor: el `errorCode` viaja SIN
      // cifrar y lo escribe quien arme la URL, así que un fallo de cripto NUESTRO no puede salir como
      // "cancelaste".
      return {
        tipo: "corte",
        causa: vuelta.origen === "billetera" ? DEEPLINK_RECHAZADO : DEEPLINK_RESPUESTA_ILEGIBLE,
      };
    case "tx-firmada":
    case "patrocinio-firmado":
      // Inalcanzable con `dl=conectar`: `interpretarVuelta` decide la rama por la MARCA, y con
      // `"conectar"` sólo puede devolver `conectado` (o un corte). Se escribe igual y NO se colapsa en
      // el `never`, porque son variantes reales del tipo y tragarlas en el `default` haría que el
      // candado de exhaustividad dejara de avisar si mañana la marca decidiera otra cosa.
      return { tipo: "nada" };
    default: {
      const nunca: never = vuelta;
      return { tipo: "corte", causa: nunca };
    }
  }
}

/**
 * Qué remesa dice el viaje en curso estar manejando, o `null` si no hay viaje utilizable.
 *
 * 🔴 POR QUÉ HACE FALTA, Y CUÁL ES SU RESIDUAL — LAS DOS COSAS, PORQUE LA SEGUNDA NO SE PUEDE OMITIR.
 *
 * El salto a la billetera **mata el proceso de la pestaña**: al volver, el componente monta de cero y
 * su `rem` está en `null`. El `remittanceId` que `completarVuelta` necesita no existe en ninguna parte
 * de la memoria de la app; el único lugar donde sobrevivió es el propio viaje, que lo lleva desde el
 * primer byte (CD-5, lo escribe `iniciarConexion`).
 *
 * ⚠️ **CONSECUENCIA, DICHA SIN SUAVIZAR**: cuando el `remittanceId` sale de acá, el guard de cruce
 * entre remesas de `interpretarVuelta` (`remittanceId`, `./sesion.ts:597`) compara el viaje contra sí
 * mismo y **no puede contestar `otra-remesa` en la vuelta del connect**. No es un ablandamiento del
 * guard —sigue entero y sigue cortando para el motor de firma, que recibe el id desde
 * `authorizePrincipal` y no desde el disco—, pero **sí es una puerta en la que ese guard no aplica**, y
 * queda escrito acá en vez de descubrirse en un AR.
 *
 * ⛔ LO QUE **NO** SE HIZO, y por qué: pasarle `null` a `interpretarVuelta`. `null` no es "sin guard":
 * es "no tengo remesa en contexto", y con eso **apaga el guard Y consume el paso igual** (está escrito
 * en `PedidoDeConexion.remittanceId`). Devolver un id que al menos nombra una remesa deja al llamador
 * poder verificar que esa remesa exista de su lado, que es una fuente distinta del canal del enlace.
 *
 * 🔴 NO TIRA NUNCA: la llama el productor de montaje, y un disco que no se deja leer tiene que
 * contestar "no hay viaje", nunca romper el montaje de la pantalla.
 */
/**
 * Qué marca nuestra trae esta URL, o `null`. **PURA**: no toca el disco y no consume nada.
 *
 * ⚠️ ES SÓLO UN LECTOR, y por eso se puede llamar antes que `completarVuelta` sin romper DT-12: el que
 * consume el paso de forma irreversible es `completarVuelta`, y esto ni siquiera mira el almacén. Hace
 * falta porque quien decide qué hacer DESPUÉS de la vuelta —reanudar o no— necesita saber de qué paso
 * se volvió, y para entonces la barra ya está limpia.
 *
 * ⛔ NO valida contra `PasoDelViaje`: devuelve lo que haya, incluida una marca que nadie de este repo
 * escribió. Quien la use decide qué hacer con lo que no reconoce, y la decisión fail-closed (no
 * reanudar nada que no sea un paso del motor) vive en el llamador, no acá.
 */
export function marcaDeVuelta(hrefActual: string): string | null {
  try {
    return new URL(hrefActual).searchParams.get(MARCA);
  } catch {
    return null; // un href que no parsea no trae ninguna marca nuestra
  }
}

/**
 * El href sin los parámetros de respuesta ni la marca, para `history.replaceState` (AC-4). **PURA**.
 *
 * 🔴 QUÉ SACA Y QUÉ NO, porque la mitad importante es la segunda. Saca exactamente
 * (`PARAMS_DE_RESPUESTA`, `./protocol.ts:82`) más (`MARCA`, `./sesion.ts:480`), **y NADA MÁS**: todo
 * otro parámetro del origen sigue viajando, empezando por `?kyc=return`, que es el que trae de vuelta
 * el recorrido de Didit. Es la misma disciplina que ya tiene (`enlaceDeVuelta`, `./sesion.ts:495`), y
 * por el mismo motivo: esta función corre sobre la URL **de la persona**, no sobre una nuestra.
 *
 * ⚠️ POR QUÉ HACE FALTA, medido en la ola 2: un `errorCode` que queda en la barra hace que la
 * invocación SIGUIENTE vuelva a leer el mismo rechazo y repita el corte. `firma-por-enlace.ts` tiene
 * ese caso medido con tres invocaciones idénticas. Sin esta limpieza, la persona no puede reintentar.
 *
 * ⛔ Y CUÁNDO SE LLAMA: **DESPUÉS** de haber leído la vuelta, nunca antes. Antes borraría la respuesta
 * que nadie leyó todavía (DT-10).
 */
export function hrefSinRastroDeVuelta(hrefActual: string): string {
  let u: URL;
  try {
    u = new URL(hrefActual);
  } catch {
    return hrefActual; // no se puede limpiar lo que no se puede parsear, y devolver otra cosa sería peor
  }
  for (const p of PARAMS_DE_RESPUESTA) u.searchParams.delete(p);
  u.searchParams.delete(MARCA);
  // `URL.toString()` deja un `?` colgando cuando no queda ningún parámetro, y eso se ve en la barra.
  return u.searchParams.size === 0 ? `${u.origin}${u.pathname}${u.hash}` : u.toString();
}

export function remesaDelViaje(a: Almacen, ahora: number): string | null {
  let lectura: ReturnType<typeof leerViaje>;
  try {
    lectura = leerViaje(a, ahora);
  } catch {
    return null;
  }
  if (lectura.tipo !== "hay") return null;
  const id = lectura.viaje.remittanceId;
  // `leerViaje` NO valida los campos que sólo se copian (lo declara su bloque de validación), así que
  // el `typeof` va acá: quien usa el campo es quien sabe qué forma necesita. Un `""` es peor que
  // ausente —compara `true` contra otro `""`— por la misma razón que `esTextoUtil` en `preparado.ts`.
  return typeof id === "string" && id !== "" ? id : null;
}
