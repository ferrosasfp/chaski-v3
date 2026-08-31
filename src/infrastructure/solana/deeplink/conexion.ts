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
import { Transaction } from "@solana/web3.js";
import type { Almacen, Viaje } from "./sesion";
import { MARCA, MAX_EDAD_MS, enlaceDeVuelta, guardarViaje, interpretarVuelta, leerViaje } from "./sesion";
import type { BilleteraDeeplink } from "./protocol";
import { PARAMS_DE_RESPUESTA, clavePublicaEnRespuesta, leerRespuestaAnclada, nuevoParDeCifrado, secretoCompartido, soloTextos, urlConectar, urlFirmarTransaccion } from "./protocol";
import type { CausaDeEnlace } from "./firma-por-enlace";
import {
  DEEPLINK_RECHAZADO, DEEPLINK_NONCE_YA_CONSUMIDO, DEEPLINK_NONCE_SIN_CONTEXTO, // WKH-358 (fix-pack · AR/BLQ-BAJO-2; la tercera, del re-AR it2 · BLQ-BAJO-1): las dos entran EN ESTA LÍNEA para no correr las citas por número que este archivo recibe. ⚠️ ACÁ DECÍA «las 4 (`:129`, `:149`, `:254`, `:400`)» Y YA ERA FALSO CUANDO SE ESCRIBIÓ: el propio fix-pack agregó una quinta al citar `vueltaDelNonce`. RE-MEDIDO en el árbol de este commit con el instrumento de `citas-ancladas.test.ts` (su regex `ANCLADA` + su resolución de destino, sumando entrantes largas y auto-citas ancladas): **13 ocurrencias a 7 destinos** (`:129` x2, `:149`, `:209` x2, `:254`, `:400` x2, `:461` x2, `:528` x3). El número es una foto y este mismo commit lo movió de 7 a 13 escribiendo comentarios; el invariante es que los 7 destinos apuntan más abajo de esta línea
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
 * en la barra. ⚠️ Y ACÁ VA LA CORRECCIÓN DE LA EVIDENCIA, que importa más que la regla: esta línea decía que si esta marca fuera un cuarto `PasoDelViaje` el `switch` con `never` de (`nunca`, `firma-por-enlace.ts:795`) *"dejaría de compilar"*. **LO CORRÍ Y ES FALSO**, y no sólo en HEAD: medido también en `723ca3c` —o sea que la afirmación ya era falsa el día que WKH-358 se desplegó—. Agregando `"crear-nonce"` a (`PasoDelViaje`, `sesion.ts:114`) **y** a (`esPaso`, `sesion.ts:121`), `tsc --noEmit` queda VERDE y la suite COMPLETA también. El motivo es estructural y no un descuido: ese `never` es exhaustividad sobre (`Vuelta`, `sesion.ts:407`), y `PasoDelViaje` entra a esas variantes como CAMPO (`paso: PasoDelViaje`) y no como discriminante ⇒ agregarle un valor no crea ninguna variante nueva que el `switch` esté obligado a mirar.
 * ⇒ **el único candado real es `T-067-16`**, en `sesion.test.ts`, y es de RUNTIME. Desde el fix-pack del AR itera también sobre `"crear-nonce"`: antes miraba sólo las dos marcas del PoP, así que esta marca —la que este mismo archivo define— no la vigilaba nadie.
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
   * y mismas palabras que (`hrefActual`, `firma-por-enlace.ts:292`).
   */
  hrefActual: string;
  /** Para que la billetera muestre título e ícono en su diálogo. */
  appUrl: string;
  /**
   * Qué remesa. ⛔ **NUNCA `null`**, por el mismo motivo que (`remittanceId`, `firma-por-enlace.ts:300`):
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
 * ((`CLAVE`, `sesion.ts:95`)) y de la del `Preparado`
 * ((`CLAVE`, `preparado.ts:31`)).
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
 * en la barra y nadie que la lea. Lo único que la borra es un gesto explícito (`olvidarEleccion`). ⚠️ QUÉ COSTABA ESA DECISIÓN, Y QUÉ HIZO FALTA AGREGARLE (fix-pack · AR/BLQ-MED-1). Sin TTL y **sin ningún llamador de producción de `olvidarEleccion`** —que es como se cerró la ola 4, con el docblock de `olvidar()` afirmando lo contrario— la elección era PEGAJOSA SIN SALIDA: quien elegía Phantom quedaba con el gate del adaptador armado para ese origen para siempre, y un build con la bandera del enlace apagada NO lo replegaba. La decisión de no expirar sigue en pie (su modo de falla sigue siendo peor); lo que se agregó son las DOS puertas que faltaban, y ninguna es un reloj: la bandera como 3ª condición del gate ((`caminoPorEnlace`, `../../solana-wallet.ts:2239`)) y el gesto explícito que este párrafo ya prometía ((`OlvidarBilleteraDeEnlace`, `../../../presentation/flow.tsx:4243`)).
 */
export const CLAVE_ELECCION = "chaski.billetera.eleccion.v1"; // HU-075/diagnóstico: SE EXPORTA, y el `export` entra EN ESTA LÍNEA y no con un bloque nuevo arriba, por lo mismo que (`CLAVE`, `./sesion.ts:95`) — esta línea está citada por número y un renglón nuevo la correría. POR QUÉ: el bloque de diagnóstico de `../../../presentation/diagnostico-de-vuelta.tsx` informa la PRESENCIA de esta clave, y copiar el literal allá habría dejado dos sitios escribiendo el mismo string. ⛔ SIGUE SIENDO DE ESTE MÓDULO: el único escritor es `guardarEleccion` y el único borrador `olvidarEleccion`; afuera sólo se lee para decir si está o no.

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
 * recién abierto NO está conectado (`estaConectado`, `firma-por-enlace.ts:376` exige los tres), y por
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

  // 🔴 EL PASO DEL NONCE TIENE SU PROPIO LECTOR, y `interpretarVuelta` NO PARTICIPA: `esPaso` es un
  // conjunto cerrado de tres y `"crear-nonce"` no está adentro, así que ese lector contestaría
  // `no-volvimos` sin consumir nada. El anti-replay de este paso es su propio flag `consumido`.
  if (marca === MARCA_CREAR_NONCE) return vueltaDelNonce(p);

  // ⛔ SIN TOCAR EL DISCO. Ni `conectar` ni nada: acá no hay ninguna marca nuestra que interpretar.
  // Incluye el caso de una marca DESCONOCIDA (algo que nadie de este repo escribió).
  if (marca !== "conectar") {
    // 🔴 ÉSTA ES LA LÍNEA QUE PROTEGE AL MOTOR. `firmar-tx` y `firmar-patrocinio` caen acá y salen
    // `nada` SIN pasar por `interpretarVuelta`. Consumirlas acá QUEMARÍA el paso que el motor
    // necesita: ese lector marca el paso consumido en la MISMA escritura en la que devuelve el
    // resultado, así que el motor recibiría después `ya-consumida` sobre una firma que la persona dio.
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

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// EL PASO DEL NONCE — su propio almacén, su propia ancla y su propio anti-replay
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * La CUARTA clave del recorrido, y separada de las otras tres por el mismo argumento que ya está
 * escrito en (`CLAVE`, `./preparado.ts:31`): son ciclos de vida distintos y compartir clave haría que
 * limpiar uno se llevara el otro.
 *
 * Acá la asimetría es propia: la creación de la cuenta de nonce **no es parte del viaje del
 * depósito**. Pasa antes, su resultado (una cuenta en la cadena) sobrevive a todos los envíos que la
 * persona haga después, y un corte del depósito no tiene por qué borrar el ancla de una transacción
 * de creación que puede estar en vuelo.
 */
export const CLAVE_NONCE = "chaski.billetera.nonce.v1"; // HU-075/diagnóstico: SE EXPORTA, mismo motivo y mismas condiciones que (`CLAVE_ELECCION`, `:129`).

/**
 * Lo que hay que recordar del salto que pide la firma de la creación. ⛔ NINGUNA clave: la sesión y la
 * `claveBilletera` salen del VIAJE, que es donde el ancla write-once ya vive.
 */
interface PasoDelNonce {
  /**
   * base64 de `tx.serializeMessage()` de la transacción que se mandó a firmar. Es contra ESTO que se
   * compara lo que devuelve la billetera.
   *
   * ⛔ NUNCA contra una transacción RECONSTRUIDA, por la misma razón que
   * (`mensajeBase64`, `./preparado.ts:47`): el blockhash sale de la red y cambia en cada intento, así
   * que una reconstrucción no coincidiría jamás y el chequeo sería uno que alguien termina borrando.
   */
  mensajeBase64: string;
  /** ms epoch del momento en que se guardó. Misma ventana que el viaje, por el mismo motivo. */
  desde: number;
  /**
   * 🔴 EL ANTI-REPLAY DE ESTE PASO, y es propio porque `interpretarVuelta` no participa. Sin este
   * flag, volver a montar la pantalla con la MISMA URL en la barra transmitiría la transacción otra
   * vez. Lo mide `T-065-16`.
   */
  consumido?: boolean;
}

/**
 * ⚠️ TIRA si el disco no acepta el ancla, igual que (`guardarViaje`, `./sesion.ts:222`) y por la misma
 * razón: se llama ANTES del salto, y un ancla que no se pudo guardar significa que al volver no vamos
 * a poder comparar nada. Transmitir una transacción que no pudimos verificar contra lo que mandamos a
 * firmar es exactamente lo que esta ancla existe para impedir.
 */
export function guardarPasoDelNonce(a: Almacen, mensajeBase64: string, ahora: number): void {
  a.escribir(CLAVE_NONCE, JSON.stringify({ mensajeBase64, desde: ahora } satisfies PasoDelNonce));
}

/** Borra el ancla del paso del nonce. NO tira: es limpieza. */
export function terminarPasoDelNonce(a: Almacen): void {
  try {
    a.borrar(CLAVE_NONCE);
  } catch {
    // Un disco que no deja borrar deja basura; tirar acá rompería una salida entera por una limpieza.
  }
}

/** Lee el ancla. `null` ante ausencia, basura, ventana vencida o instante del futuro — y limpia el
 *  disco en DOS de esos cuatro casos, basura y ventana vencida, por la lección de 061: un campo inválido que hace tirar y NO
 *  limpia repite la excepción en CADA carga de la página. 🔴 ACÁ DECÍA «limpia el disco en los TRES últimos casos» Y ESTE MISMO COMMIT LO VOLVIÓ FALSO (AR-fp/BLQ-BAJO-1): la rama del futuro es hoy la ÚNICA de las tres que NO limpia (`terminarPasoDelNonce`, `:498`), y ésa es exactamente la corrección que el addendum declaró obligatoria para el gemelo de `preparado.ts:61` y que acá quedó sin hacer. Lo que se borraba era el `mensajeBase64` del nonce durable de alguien que quizás YA FIRMÓ, y `Date.now()` puede retroceder: una LECTURA no destruye lo que no entrega. */
function leerPasoDelNonce(a: Almacen, ahora: number): PasoDelNonce | null {
  let crudo: string | null;
  try {
    crudo = a.leer(CLAVE_NONCE);
  } catch {
    return null; // un disco que no deja leer no tiene un ancla vencida: no tiene nada
  }
  if (!crudo) return null;
  let x: PasoDelNonce;
  try {
    x = JSON.parse(crudo) as PasoDelNonce;
  } catch {
    terminarPasoDelNonce(a);
    return null;
  }
  if (typeof x?.mensajeBase64 !== "string" || x.mensajeBase64 === "" || !Number.isFinite(x?.desde)) {
    terminarPasoDelNonce(a);
    return null;
  }
  // 🔴 DOS GUARDS, NO UNO, Y ANTES ERAN UN SOLO `||` QUE DESTRUÍA LAS DOS RAMAS. Un ancla que empezó en
  // el FUTURO no se puede fechar (`ahora - desde` es negativo y nunca supera la ventana), pero `Date.now()`
  if (x.desde > ahora) return null; if (ahora - x.desde > MAX_EDAD_MS) { // 🔴 `MAX_EDAD_MS` SIGUE EN ESTA LÍNEA A PROPÓSITO: (`MAX_EDAD_MS`, `./pop-por-enlace.ts:104`) la cita por número justamente por eso, y moverla la rompería. ⛔ LA RAMA DEL FUTURO NO LLAMA `terminarPasoDelNonce`: es reloj de PARED y puede RETROCEDER (corrección NTP), así que un retroceso borraba el `mensajeBase64` del nonce durable de alguien que quizás YA FIRMÓ. El retorno sigue siendo `null` —esta función no gana forma nueva— y el copy que su llamador emite (`deeplink_nonce_sin_contexto`) sigue sin afirmar que no se firmó: dice «Si llegaste a firmar, la cuenta puede haber quedado creada». 🔴 PERO ⛔ NO SE PUEDE DECIR QUE «ES HONESTO PARA ESTE CASO», que es lo que decía acá y lo VOLVIÓ FALSO ESTE MISMO ARREGLO (AR-fp/BLQ-BAJO-3): el addendum evaluó ese copy en UN SOLO EJE —«¿afirma que no se firmó?»— y el arreglo cambió el valor de verdad de OTRA cláusula de la misma oración. Ese copy dice «este navegador ya no tiene los datos para leer esa respuesta» y eso HOY ES FALSO: el ancla sigue en el disco y revive en cuanto el reloj pasa su `desde`. Queda como RESIDUAL DECLARADO y ⛔ el copy no se toca en esta pasada (es scope de `flow-vm.ts` y arrastra `T-065-18`). Lo que este guard resuelve, y es lo único que se afirma acá, es que no hacía falta un estado nuevo: hacía falta dejar de destruir. Y una LECTURA no destruye lo que no entrega, que es la regla que este módulo ya tiene escrita en (`ancla`, `./pop-por-enlace.ts:405`).
    terminarPasoDelNonce(a);
    return null;
  }
  return x;
}

/**
 * La vuelta del salto que pidió la firma de la transacción que CREA la cuenta de nonce.
 *
 * 🔴 QUÉ VERIFICA, EN ESTE ORDEN Y SIN SALTEARSE NINGUNO:
 *   1. que haya un ancla viva (si no, no hay contra qué comparar y no se transmite nada);
 *   2. que **no esté consumida** — el anti-replay propio de este paso;
 *   3. que el viaje esté conectado, porque la sesión y la `claveBilletera` salen de ahí;
 *   4. que la respuesta venga cifrada con **LA MISMA `claveBilletera`** que el viaje ya tiene fijada
 *      (ancla write-once: un sobre de cualquier otra clave sale `deeplink_tx_alterada`);
 *   5. que **los bytes del mensaje de la transacción devuelta sean IDÉNTICOS** a los del ancla.
 *
 * ⚠️ QUÉ **NO** VERIFICA, y hace falta decirlo para que nadie se apoye en su verde: **no verifica la
 * firma ed25519 del sender**. Los bytes del mensaje coinciden igual si la billetera devuelve la misma
 * transacción con la firma en cero, porque las firmas no son parte del mensaje. Lo que sí garantiza el
 * paso 5 es que **no se transmita otra transacción que la que mandamos a firmar**, que es el ataque que
 * importa acá: sin él, un sobre bien cifrado podría cambiar el destino de esa creación.
 * 🔴 ACÁ DECÍA QUE ESA VERIFICACIÓN «VIVE EN EL ADAPTADOR, QUE YA LA HACE PARA EL DEPÓSITO EN `solana-wallet.ts:999`», Y ESO ERA UN PUNTERO FALSO (CR/BLQ-BAJO-6): ese sitio es la verificación del DEPÓSITO, en la rama de `authorizePrincipal`, y **por el camino del nonce no pasa nadie por ahí**. En ESTE camino nadie verifica ed25519, ni acá ni después. MEDIDO por el CR: una vuelta con la firma en cero pasa los cinco pasos de arriba y llega al broadcast.
 * ⇒ POR QUÉ ALCANZA IGUAL, y es el argumento entero, no una tranquilización: **la cadena rechaza**. `sendRawTransaction` de una tx sin la firma de su `feePayer` no entra en ningún bloque, así que el desenlace es "la cuenta no se creó" y NO "se creó una cuenta que no querías". Y lo que está en juego en este paso es CERO USDC: no hay escrow, no hay orden de payout, y el alquiler sólo se debita si la tx entra, o sea si la firma era buena. Verificar acá cambiaría el DIAGNÓSTICO, no el resultado — y ese diagnóstico ya se arregló del otro lado, con (`DEEPLINK_NONCE_NO_ENTRO`, `./firma-por-enlace.ts:245`), que dejó de afirmar que venció un reloj.
 * ⛔ QUÉ COSTARÍA AGREGARLA, MEDIDO Y NO ESTIMADO, para que la decisión se pueda revisar: los siete `it` del paso del nonce firman con un `Keypair.generate()` que **no es** `viaje.direccion` (`transaccion`, `conexion.test.ts:514`), o sea que el fixture del caso POSITIVO no satisface el guard que habría que agregar. Agregarla exige re-fabricar esos siete fixtures en el mismo cambio; si no, el `it` del camino feliz se pondría rojo y la tentación sería aflojar el guard. Queda declarado y sin hacer.
 *
 * ⛔ MARCA CONSUMIDO ANTES DE DEVOLVER, en la misma lectura. Es lo que impide que un segundo montaje
 * sobre la misma URL vuelva a transmitir (`T-065-16`).
 */
function vueltaDelNonce(p: PedidoDeConexion): VueltaDeConexion {
  const ancla = leerPasoDelNonce(p.almacen, p.ahora);
  if (ancla === null) return { tipo: "corte", causa: DEEPLINK_NONCE_SIN_CONTEXTO }; // ⚠️ ACÁ SALÍA `DEEPLINK_VIAJE_VENCIDO`, y las dos mitades de su copy («No se firmó nada. Empezá el envío de nuevo.») son falsas TAMBIÉN acá (re-AR it2 · BLQ-BAJO-1). Esta salida NO es pre-firma: es PRE-LECTURA. Llegar a esta función significa que la barra trae `MARCA_CREAR_NONCE`, que sólo vive en el `redirect_link` que le dimos a la billetera, así que ya volvimos de ella y esto corta sin mirar un solo parámetro. El razonamiento completo, con los dos relojes, está en el bloque de (`DEEPLINK_NONCE_SIN_CONTEXTO`, `./firma-por-enlace.ts:262`)
  if (ancla.consumido === true) return { tipo: "corte", causa: DEEPLINK_NONCE_YA_CONSUMIDO }; // ⚠️ ACÁ SALÍA `DEEPLINK_VIAJE_VENCIDO`, y su copy dice «No se firmó nada. Empezá el envío de nuevo.»: las DOS mitades son falsas en esta rama (AR/BLQ-BAJO-2 + CR/MNR-10). Es POST-firma —la billetera devolvió la tx firmada y el flag se escribe ANTES del broadcast, así que puede haber salido— y no es el envío sino la creación de una cuenta. Ver el docblock de `DEEPLINK_NONCE_YA_CONSUMIDO`

  const lectura = leerViaje(p.almacen, p.ahora);
  if (lectura.tipo !== "hay") return { tipo: "corte", causa: DEEPLINK_NONCE_SIN_CONTEXTO }; // 🔴 ÉSTA ES LA ALCANZABLE CON EL ANCLA VIVA, y es lo que hace que el error no sea de precisión: los dos relojes usan la MISMA (`MAX_EDAD_MS`, `./sesion.ts:111`) pero el del viaje arranca en (`iniciarConexion`, `:209`) —al tocar el selector— y `consumir` conserva su `desde`, mientras que el del ancla arranca en (`guardarPasoDelNonce`, `:461`), mucho después ⇒ el viaje vence primero. Selector t=0, «Crear la cuenta» t=15m, firma, vuelta t=21m: ancla viva, viaje vencido, y con la causa vieja la persona leía «No se firmó nada» recién salida de firmar. Lo mide `T-065-22`
  const viaje = lectura.viaje;
  if (typeof viaje.claveBilletera !== "string" || typeof viaje.session !== "string") {
    return { tipo: "corte", causa: DEEPLINK_NONCE_SIN_CONTEXTO }; // ídem: sin canal no se puede abrir el sobre, pero eso no dice nada sobre si se firmó
  }

  const params = new URLSearchParams(new URL(p.hrefActual).search);
  // 🔒 EL ANCLA WRITE-ONCE. ⛔ ACÁ HABÍA UN `!==` A SECAS Y CORTABA TODA FIRMA BUENA, EXACTAMENTE COMO EN EL PASO DEL PoP
  // ((`vueltaDelPop`, `./pop-por-enlace.ts:313`)): comparaba la clave de la URL contra el ancla sin preguntar primero si la URL
  // TRAÍA una. La respuesta de `/signTransaction` NO trae clave de cifrado —docs.phantom.com la documenta en la del `/connect`,
  // y sólo ahí—, así que `null !== ancla` era SIEMPRE cierto y toda vuelta buena de este paso salía `deeplink_tx_alterada`.
  // 🔴 ⇒ LA CREACIÓN DE LA CUENTA DE NONCE POR ENLACE NUNCA PUDO FUNCIONAR, y hay que decirlo aunque nadie lo haya reportado:
  // el recorrido del founder corta antes, en el PoP, así que este camino no tiene medición en teléfono. Lo que sí hay es la
  // línea de arriba, que es LA MISMA. ⚠️ Y cambia qué hay que probar: el paso 2-BIS no está cubierto por «anduvo el PoP».
  // ⛔ EL TERCER SITIO CON ESTA FORMA es (`interpretarVuelta`, `./sesion.ts:578`), y ahí el guard YA preguntaba si la clave
  // estaba: no cortaba, pero el lector de abajo sí, así que `firmar-tx` y `firmar-patrocinio` volvían «huérfanas».
  // 🔒 QUIÉN SOSTIENE HOY LA PROPIEDAD («viene de la MISMA billetera que contestó el connect»): NO esta comparación, sino que el
  // sobre se abre con el secreto derivado de la clave ANCLADA ((`leerRespuestaAnclada`, `./protocol.ts:321`)) y un sobre cerrado
  // contra cualquier otra clave no abre. Lo que queda acá es DIAGNÓSTICO: con una clave en la URL que no es la anclada se dice
  // «alterada» y no «ilegible». El `errorCode` manda porque un rechazo explícito no es una alteración; y sin clave en la URL ese
  // mismo rechazo lo traduce igual `leerRespuestaAnclada`, que lo mira antes que nada.
  const claveEnLaUrl = clavePublicaEnRespuesta(viaje.billetera, params); if (claveEnLaUrl !== null && claveEnLaUrl !== viaje.claveBilletera) return { tipo: "corte", causa: params.get("errorCode") ? DEEPLINK_RECHAZADO : DEEPLINK_TX_ALTERADA };
  const desenlace = leerRespuestaAnclada(params, lectura.secretaBytes, viaje.claveBilletera, soloTextos("transaction"));
  if (desenlace.tipo === "ninguno") return { tipo: "nada" }; // la marca estaba pero no hay respuesta
  if (desenlace.tipo === "rechazo") {
    return {
      tipo: "corte",
      causa: desenlace.origen === "billetera" ? DEEPLINK_RECHAZADO : DEEPLINK_RESPUESTA_ILEGIBLE,
    };
  }

  // 5 · BYTES CONTRA BYTES. `null` acá es "no se pudo leer la transacción", que se trata igual que
  // "no es la que mandamos": las dos cosas significan que no podemos afirmar qué se va a transmitir.
  const mensaje = mensajeDeLaTransaccion(desenlace.datos.transaction);
  if (mensaje === null || mensaje !== ancla.mensajeBase64) {
    return { tipo: "corte", causa: DEEPLINK_TX_ALTERADA };
  }

  // ⛔ EL FLAG SE ESCRIBE ANTES DE DEVOLVER. Si se escribiera después de transmitir, una recarga en el
  // medio dejaría el ancla viva y la transmitiría dos veces.
  try {
    p.almacen.escribir(CLAVE_NONCE, JSON.stringify({ ...ancla, consumido: true } satisfies PasoDelNonce));
  } catch {
    // Un disco que no deja escribir no puede recordar que esto se consumió ⇒ no se transmite. Es el
    // lado conservador: transmitir sin poder recordarlo es exactamente el replay que el flag evita.
    return { tipo: "corte", causa: DEEPLINK_SIN_MEMORIA };
  }
  return { tipo: "nonce-firmado", transaccionBase58: desenlace.datos.transaction };
}

/** base64 de `tx.serializeMessage()` de una transacción en base58, o `null` si no se puede leer.
 *
 *  Devuelve `null` en vez de tirar por el mismo criterio que `firmaDelSender`
 *  ((`firmaDelSender`, `./firma-por-enlace.ts:410`)): una transacción que no se puede leer es un desenlace del viaje, no
 *  un error de programación. */
function mensajeDeLaTransaccion(transaccionBase58: string): string | null {
  try {
    return Buffer.from(Transaction.from(bs58.decode(transaccionBase58)).serializeMessage()).toString("base64");
  } catch {
    return null;
  }
}

/**
 * PASO 2-BIS · El salto que pide la firma de la transacción que CREA la cuenta de nonce.
 *
 * ⚠️ ES OTRO SALTO Y NO EL DEL DEPÓSITO, y por eso lleva marca propia. La transacción la ARMA el
 * adaptador (necesita la cadena para el blockhash y el alquiler); acá se cifra el sobre con la sesión
 * del viaje y se guarda el ancla de bytes contra la que se va a comparar al volver.
 *
 * ⚠️ EL ORDEN DE LAS DOS ESCRITURAS NO ES ESTÉTICO: primero el ancla, después la URL. Si la URL se
 * devolviera antes de haber podido guardar el ancla, la persona saltaría a firmar algo contra lo que
 * este dispositivo no va a poder comparar nada, y la comparación de bytes es lo único que impide que
 * se transmita una transacción distinta de la que mandamos a firmar.
 *
 * TIRA si el viaje no está conectado (no hay canal cifrado con el que pedir nada) o si el disco no
 * acepta el ancla, por la misma razón que `iniciarConexion`: saltar sin poder recordar es mandar a
 * firmar a ciegas. ⛔ No envolver esto en un `try`.
 */
export function iniciarCreacionDeNonce(
  p: PedidoDeConexion & { transaccionBase58: string; mensajeBase64: string },
): { irA: string } {
  const lectura = leerViaje(p.almacen, p.ahora);
  if (lectura.tipo !== "hay") throw new Error(DEEPLINK_VIAJE_VENCIDO);
  const viaje = lectura.viaje;
  if (typeof viaje.claveBilletera !== "string" || typeof viaje.session !== "string") {
    throw new Error(DEEPLINK_VIAJE_VENCIDO);
  }
  guardarPasoDelNonce(p.almacen, p.mensajeBase64, p.ahora); // TIRA a propósito: ver el docblock
  return {
    irA: urlFirmarTransaccion({
      billetera: viaje.billetera,
      appUrl: p.appUrl,
      // ⚠️ `enlaceDeVuelta` LIMPIA del origen los parámetros de respuesta que ya trajera: sin eso, un
      // `redirect_link` armado sobre una URL que ya volvió de un salto se lleva el `nonce`/`data`
      // viejos adentro, y `URLSearchParams.get` devuelve el PRIMERO.
      redirectLink: enlaceDeVuelta(p.hrefActual, MARCA_CREAR_NONCE),
      clavePublicaDeLaApp: bs58.decode(viaje.publica),
      secreto: secretoCompartido(viaje.claveBilletera, lectura.secretaBytes),
      session: viaje.session,
      transaccionBase58: p.transaccionBase58,
    }),
  };
}
