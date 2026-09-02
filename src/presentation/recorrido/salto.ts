// WKH-374 · W1.0 — EL SALTO: ANUNCIO, ESTADO EN VUELO Y ATERRIZAJE
//
// ⛔ CERO DOM, CERO ALMACENAMIENTO, CERO LECTURA DE LA BARRA. Todo lo de acá son funciones puras
// sobre un `href` que el llamador pasa; quien lee la barra es el anfitrión, una vez, en el montaje.
//
// 🔴 EL INVARIANTE QUE ESTE MÓDULO SOSTIENE. Todo salto a la billetera o al verificador se ANUNCIA
// ANTES, se MUESTRA MIENTRAS PASA, y al volver SE ATERRIZA DONDE SE ESTABA, UN PASO MÁS ADELANTE.
// ⛔ NUNCA en la pantalla de entrada, ni en el camino feliz ni en el de error: el error cambia el
// MOTIVO en pantalla, ⛔ nunca el paso.
//
// 🔴 Y SE RESUELVE COMO FUNCIÓN PURA DE LA MARCA QUE TRAE LA URL. ⛔ No de un estado recordado, ⛔ no
// del disco, ⛔ no de la sesión, y no es preferencia de estilo: el salto REMONTA EL ÁRBOL DE REACT
// —medido, con su candado en `../el-salto-remonta-el-arbol.test.tsx`— y un árbol remontado no
// recuerda en qué paso estaba. Lo único que cruza la ida y la vuelta es la URL.
//
// ⚠️ EL LÍMITE DE «SE MUESTRA MIENTRAS PASA»: mientras la persona está en la billetera, nuestra
// pantalla NO está a la vista. Lo garantizado es lo que encuentra al volver la vista atrás.

import {
  PARAM_SALIDA,
  VALOR_SALIDA,
} from "../salida-al-navegador-de-la-billetera";
import { PARAM_KYC, VALOR_VUELTA_KYC } from "../splash-puerta";
import { humanError } from "../flow-vm";
// ⛔ ESTA CITA VA SIN ANCLA A PROPÓSITO, y el motivo es el mismo que el del docblock de
// `DESENLACE_CON_MARCA` en `../bitacora-de-vuelta.ts`: el módulo de sesión lleva marcadores de censo
// de citas entrantes por número, y anclar una cita nueva hacia él obligaría a editar ese marcador —
// que es un archivo fuera del alcance de esta ola. `MARCA` y `MARCAS_DE_VUELTA` viven los dos en
// `src/infrastructure/solana/deeplink/sesion.ts` (mismo módulo, `MARCAS_DE_VUELTA` en la misma línea
// física que `enlaceDeVuelta`: ⛔ no la partas).
import { MARCA, MARCAS_DE_VUELTA } from "../../infrastructure/solana/deeplink/sesion";
// El nombre del parámetro con el que la billetera reporta un rechazo. ⛔ NO se transcribe acá: es el
// mismo símbolo que `PARAMS_DE_RESPUESTA` consume en ese módulo, así que no puede divergir.
import { PARAM_ERROR } from "../../infrastructure/solana/deeplink/protocol";
import { PASO_DE_ENTRADA, type PasoDelRecorrido, esPasoDelRecorrido } from "./pasos";

/**
 * 🔴 EL TERCER VALOR, Y NO UN BOOLEANO NI UN PASO POR DEFECTO. Una marca que este repo no escribió no
 * tiene aterrizaje, y eso NO es «aterriza en el principio»: con un booleano se perdería la diferencia
 * entre «vuelve al paso X» y «no sé qué es esta marca». Mismo molde que
 * (`motivoParaNoMostrar`, `../splash-puerta.ts:84`), que por lo mismo contesta un motivo.
 */
export const SIN_ATERRIZAJE = "sin-aterrizaje";

/** Un paso de la tabla, o el tercer valor. ⛔ Nunca `undefined`, ⛔ nunca un paso inventado. */
export type Aterrizaje = PasoDelRecorrido | typeof SIN_ATERRIZAJE;

/**
 * Las marcas del verificador y de la salida al navegador de la billetera, en el MISMO vocabulario
 * que las del enlace profundo, para que `aterrizajeDe` tenga un solo dominio de entrada.
 *
 * ⛔ NINGÚN LITERAL SE ESCRIBE ACÁ: los dos tokens se COMPONEN de los símbolos que producción ya
 * exporta (`CD-W1-7`). Si alguno de esos símbolos cambia de valor, estos tokens cambian con él y no
 * hay ningún string de este archivo que se quede viejo en silencio.
 */
export const MARCA_DEL_VERIFICADOR = `${PARAM_KYC}=${VALOR_VUELTA_KYC}`;
export const MARCA_DE_LA_SALIDA = `${PARAM_SALIDA}=${VALOR_SALIDA}`;

/**
 * 🔴 LA TABLA DE ATERRIZAJE DEL ENLACE PROFUNDO, INDEXADA POR LA TUPLA DE PRODUCCIÓN.
 *
 * ⛔ LAS CLAVES NO SE ESCRIBEN: son las posiciones de la tupla que el módulo de sesión exporta, y eso
 * es lo que impide que la tabla quede incompleta en silencio. Una marca nueva en esa tupla queda sin
 * entrada acá, `aterrizajeDe` le contesta el tercer valor, y `T-374-W1-0` —que recorre la tupla
 * ENTERA— se pone rojo. Una lista de nombres a mano envejecería sola y en verde.
 *
 * Los índices, con su razón (⛔ los nombres de las marcas no se transcriben acá: `CD-W1-7`):
 *   [0] la vuelta de CONECTAR      ⇒ hay dirección ⇒ el paso siguiente, donde se arma el envío.
 *   [1] la vuelta de la firma de la TRANSACCIÓN     ⇒ la firma se dio ⇒ el envío ya está en curso.
 *   [2] la vuelta de la firma del PATROCINIO        ⇒ ídem: el envío ya está en curso.
 *   [3] la vuelta de la creación del NONCE DURABLE  ⇒ es un salto DENTRO de preparar la firma ⇒ se
 *       vuelve a la pantalla de firmar, que es de donde salió.
 *   [4] la vuelta de la prueba de posesión del PAGO ⇒ sirve para leer el estado, no para mover
 *       fondos ⇒ el seguimiento.
 *   [5] la vuelta de la prueba de posesión de la IDENTIDAD ⇒ ídem.
 */
const ATERRIZAJE_POR_ENLACE: Readonly<
  Record<(typeof MARCAS_DE_VUELTA)[number], PasoDelRecorrido>
> = {
  [MARCAS_DE_VUELTA[0]]: "envio",
  [MARCAS_DE_VUELTA[1]]: "seguimiento",
  [MARCAS_DE_VUELTA[2]]: "seguimiento",
  [MARCAS_DE_VUELTA[3]]: "firmar",
  [MARCAS_DE_VUELTA[4]]: "seguimiento",
  [MARCAS_DE_VUELTA[5]]: "seguimiento",
};

/**
 * Dónde aterriza una marca de vuelta. La función pura del invariante de arriba.
 *
 * 🔴 El verificador aterriza en IDENTIDAD y ⛔ no en el principio: es el pedido textual del founder, y
 * es lo que evita que una verificación ya pagada obligue a recorrer la app de nuevo.
 *
 * 🔴 La salida al navegador de la billetera aterriza en el paso siguiente al que la ofrece, que es la
 * pantalla de entrada (la única que la ofrece) ⇒ la del envío. ⛔ W1 NO lee el contexto de borrador
 * que esa marca transporta: volverlo durable es otra ola.
 */
export function aterrizajeDe(marca: string): Aterrizaje {
  if (marca === MARCA_DEL_VERIFICADOR) return "identidad";
  if (marca === MARCA_DE_LA_SALIDA) return "envio";
  // 🔴 `Object.hasOwn` Y ⛔ NUNCA UN ÍNDICE DIRECTO SOBRE EL OBJETO LITERAL (fix-pack AR/BLQ-MED-1).
  // Acá había un cast a `Record<string, PasoDelRecorrido | undefined>` y era INFUNDADO: el literal
  // hereda de `Object.prototype`, así que `aterrizajeDe("toString")` devolvía una FUNCIÓN tipada como
  // paso. Medido antes del arreglo: `typeof` daba `function`, `SIN_ATERRIZAJE` daba `false`, y
  // `<Recorrido hrefDeAterrizaje="…/?dl=toString"/>` dejaba el `body` en «Paso 1 de 5» sin ninguna
  // pantalla. Mismo recurso, y por el mismo motivo, que (`copyDeEnlace`, `../flow-vm.ts:1503`).
  if (!Object.hasOwn(ATERRIZAJE_POR_ENLACE, marca)) return SIN_ATERRIZAJE;
  const porEnlace: unknown = (ATERRIZAJE_POR_ENLACE as Record<string, unknown>)[marca];
  // Y LA SALIDA SE VALIDA CONTRA LA TABLA DE PASOS, ⛔ no se afirma por el tipo: `Object.hasOwn` cierra
  // el prototipo, y esto cierra el otro lado (una entrada de la tabla que dejara de ser un paso).
  return typeof porEnlace === "string" && esPasoDelRecorrido(porEnlace) ? porEnlace : SIN_ATERRIZAJE;
}

/**
 * ¿Esta URL vuelve del recorrido POR ENLACE PROFUNDO? ⛔ No es «trae una marca»: la del verificador y
 * la de la salida al navegador de la billetera son marcas y ⛔ no son el camino por enlace.
 *
 * Existe porque la cantidad de firmas que el camino elegido pide ⛔ no se puede escribir a mano en la
 * pantalla (era el `porEnlace` hardcodeado del anfitrión, AR/BLQ-BAJO-1): un salto REMONTA EL ÁRBOL,
 * así que al volver no queda ningún estado que diga por qué camino se venía, y lo único que cruza es
 * la marca de la URL.
 */
export function volvioPorEnlace(href: string): boolean {
  const marca = marcaDeLaUrl(href);
  return marca !== null && Object.hasOwn(ATERRIZAJE_POR_ENLACE, marca);
}

/**
 * La marca que trae un `href`, en el vocabulario único de `aterrizajeDe`, o `null` si no trae
 * ninguna.
 *
 * El ORDEN de las tres consultas es el mismo que el de
 * (`motivoParaNoMostrar`, `../splash-puerta.ts:84`), y por el mismo motivo: la vuelta del
 * verificador se reconoce por el par
 * nombre + valor, y la del enlace profundo por la PRESENCIA del parámetro, porque su valor es cuál
 * paso volvió y puede ser hasta uno que este repo no escribió.
 *
 * Un `href` que no parsea devuelve `null`: no se puede afirmar que traiga una marca algo que no se
 * deja leer, y el desenlace seguro es quedarse donde se estaba.
 */
export function marcaDeLaUrl(href: string): string | null {
  let params: URLSearchParams;
  try {
    params = new URL(href).searchParams;
  } catch {
    return null;
  }
  if (params.get(PARAM_KYC) === VALOR_VUELTA_KYC) return MARCA_DEL_VERIFICADOR;
  const porEnlace = params.get(MARCA);
  if (porEnlace !== null) return porEnlace;
  if (params.get(PARAM_SALIDA) === VALOR_SALIDA) return MARCA_DE_LA_SALIDA;
  return null;
}

/**
 * El desenlace de una vuelta: qué encuentra la persona cuando la pestaña vuelve a estar a la vista.
 *
 * 🔴 LAS DOS RAMAS —feliz y error— DEVUELVEN EL MISMO `paso`, y ésa es la mitad de `AC-8` que
 * importa. Lo único que el error cambia es `motivo`. Un desenlace de error que mandara a otro paso
 * (y sobre todo a la entrada) es el mutante que `T-374-W1-3` mata.
 */
export type Vuelta =
  | { desenlace: "sin-marca" }
  | { desenlace: "sin-aterrizaje"; marca: string }
  | { desenlace: "aterriza"; paso: PasoDelRecorrido; motivo: string | null };

/**
 * Qué hacer con la URL con la que se volvió.
 *
 * ⛔ UN SOLO INSUMO, Y ES LA URL. El código crudo del error lo lee `codigoDeErrorDeLaUrl` del MISMO
 * `href`, así que no hay ningún parámetro que un llamador se pueda olvidar de pasar — que es
 * exactamente lo que pasaba antes del fix-pack (AR/BLQ-MED-4).
 * El texto legible sale de (`humanError`, `../flow-vm.ts:572`), que a su vez consulta primero a
 * (`copyDeEnlace`, `../flow-vm.ts:1503`): ⛔ acá no se escribe ni un mensaje de error nuevo.
 */
export function vueltaDeUnSalto(p: { href: string }): Vuelta {
  const marca = marcaDeLaUrl(p.href);
  if (marca === null) return { desenlace: "sin-marca" };
  const paso = aterrizajeDe(marca);
  if (paso === SIN_ATERRIZAJE) return { desenlace: "sin-aterrizaje", marca };
  const codigo = codigoDeErrorDeLaUrl(p.href);
  return { desenlace: "aterriza", paso, motivo: codigo === null ? null : humanError(codigo) };
}

/**
 * El código de error que la billetera dejó en la URL de vuelta, o `null` si volvió sin ninguno.
 *
 * 🔴 ACÁ ESTABA EL `BLQ-MED-4` DEL AR, Y ERA DE FORMA, NO DE COPY: `vueltaDeUnSalto` recibía el código
 * por PARÁMETRO (`codigoDeError`) y ⛔ NINGÚN LLAMADOR SE LO PASABA. O sea que `motivo` era `null` para
 * TODA vuelta, incluida una firma rechazada, y la mitad de `AC-8` que importa era inalcanzable por
 * construcción mientras un `it` ejercitaba una rama que nadie construye. Hoy el productor es la URL,
 * que es de donde sale en producción, y el parámetro se fue.
 *
 * ⛔ EL NOMBRE DEL PARÁMETRO NO SE ESCRIBE ACÁ: entra por (`PARAM_ERROR`,
 * `../../infrastructure/solana/deeplink/protocol.ts:44`), el mismo símbolo que consume
 * `PARAMS_DE_RESPUESTA` en ese módulo.
 *
 * ⚠️ EL LÍMITE, declarado: este código viaja SIN CIFRAR y ⛔ no lo autenticó nadie, exactamente como
 * lo dice (`abrirSobre`, `../../infrastructure/solana/deeplink/protocol.ts:335`). No se usa para
 * afirmar un hecho sobre el dinero: lo único que decide es qué MOTIVO se lee en pantalla, y el paso no
 * lo toca (`AC-8`).
 */
export function codigoDeErrorDeLaUrl(href: string): string | null {
  let params: URLSearchParams;
  try {
    params = new URL(href).searchParams;
  } catch {
    return null;
  }
  const codigo = params.get(PARAM_ERROR);
  return codigo === null || codigo === "" ? null : codigo;
}

/**
 * ⛔ NINGÚN PASO DE ATERRIZAJE PUEDE SER LA PANTALLA DE ENTRADA (`AC-7`). Se expone como predicado
 * —y no como un comentario— para que el anfitrión pueda fallar cerrado si algún día lo fuera, en vez
 * de mandar a la persona al principio en silencio.
 */
export function aterrizaEnLaEntrada(a: Aterrizaje): boolean {
  return a !== SIN_ATERRIZAJE && a === PASO_DE_ENTRADA;
}

/**
 * 🔴 EL PASO DE UNA MARCA QUE ESTE REPO NO ESCRIBIÓ. ⛔ Y NO ES LA PANTALLA DE ENTRADA, que es
 * exactamente lo que `AC-8` prohíbe con la palabra NUNCA para este caso, con estas palabras: *«marca
 * ausente, marca sin consumidor, firma rechazada ⇒ aterrizar en el mismo paso con un motivo legible,
 * y NUNCA en la pantalla de entrada»*.
 *
 * ⚠️ POR QUÉ EL SEGUNDO PASO Y NO OTRO, dicho sin adornarlo: de una marca desconocida ⛔ no se puede
 * deducir en qué paso estaba la persona — el salto remonta el árbol y no hay estado que consultar. Lo
 * único que se sabe es que VOLVIÓ de algún lado, o sea que ya pasó por la entrada. El paso donde se
 * arma el envío es el primero que no la obliga a reconectar y el único que no salta a ningún lado,
 * así que es donde una persona puede seguir sin que le mintamos sobre lo que pasó.
 */
export const PASO_DE_LA_MARCA_DESCONOCIDA: PasoDelRecorrido = "envio";

/**
 * El motivo que se lee cuando la marca no tiene consumidor. ⛔ NO pasa por `humanError`, y es a
 * propósito: esto no es un código de error del sistema —no lo produjo ningún camino de producción—,
 * es una lectura de ESTE anfitrión sobre una URL que no reconoce. Escribirlo como una causa del
 * vocabulario del enlace sería inventarle un productor que no tiene.
 *
 * ⛔ Y NO DICE QUE FALLÓ EL ENVÍO, porque no falló: falló nuestra lectura de la vuelta.
 */
export const MOTIVO_SIN_ATERRIZAJE =
  "Volviste con una respuesta que no reconocemos, así que no la usamos para nada. Seguí desde este paso: tu billetera sigue conectada.";

/**
 * 🔴 EL DESENLACE DEL ANFITRIÓN: dónde se monta y qué motivo se lee. ⛔ NO ES UN `? :` SOBRE
 * `desenlace === "aterriza"`, y ahí estaba el `BLQ-ALTO-1` del AR.
 *
 * Lo que había en `../recorrido.tsx` era
 * `aterrizaje.desenlace === "aterriza" ? aterrizaje.paso : pasoDeArranque`, o sea el tercer valor
 * COLAPSADO contra el default. Medido montando el anfitrión con `?dl=marca-que-nadie-escribio`: la
 * persona aterrizaba en la PANTALLA DE ENTRADA y SIN MOTIVO — el caso que `AC-8` nombra con esas
 * palabras, y lo mismo que el docblock de arriba promete que no pasa. La diferencia existía en el
 * tipo y se perdía en el ternario.
 *
 * LOS TRES DESENLACES, cada uno con su paso conocido:
 *   · `sin-marca`       ⇒ arranque normal. `pasoDeArranque` es la costura de test, y su default ES la
 *                         pantalla de entrada: acá eso es correcto, porque nadie volvió de ningún lado.
 *   · `sin-aterrizaje`  ⇒ `PASO_DE_LA_MARCA_DESCONOCIDA` + motivo legible. ⛔ Nunca la entrada.
 *   · `aterriza`        ⇒ el paso de la tabla, con el motivo que la URL de vuelta haya traído.
 *
 * 🔴 Y ACÁ ES DONDE `aterrizaEnLaEntrada` TIENE SU LLAMADOR (el AR midió que tenía CERO). Es el
 * fallo-cerrado que su docblock promete: si la tabla de aterrizaje alguna vez apuntara a la entrada,
 * esto NO manda a la persona al principio en silencio, la deja en el paso de la marca desconocida y
 * le da el motivo. ⛔ No es decorativo: `T-374-W1-15` lo pone rojo mutando la tabla.
 */
export function aterrizajeDelAnfitrion(
  v: Vuelta,
  pasoDeArranque: PasoDelRecorrido,
): { paso: PasoDelRecorrido; motivo: string | null } {
  if (v.desenlace === "sin-marca") return { paso: pasoDeArranque, motivo: null };
  if (v.desenlace === "sin-aterrizaje") {
    return { paso: PASO_DE_LA_MARCA_DESCONOCIDA, motivo: MOTIVO_SIN_ATERRIZAJE };
  }
  if (aterrizaEnLaEntrada(v.paso)) {
    return { paso: PASO_DE_LA_MARCA_DESCONOCIDA, motivo: v.motivo ?? MOTIVO_SIN_ATERRIZAJE };
  }
  return { paso: v.paso, motivo: v.motivo };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// EL ANUNCIO (antes del salto) Y EL ESTADO EN VUELO (mientras pasa)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** Una firma que el camino elegido va a pedir. `queSeFirma` es lo que la persona lee. */
export interface Firma {
  readonly queSeFirma: string;
  readonly porQue: string;
}

/**
 * Las firmas que el camino elegido va a pedir.
 *
 * ⛔ LA PANTALLA RENDERIZA `.length` Y ⛔ NUNCA UN NÚMERO ESCRITO. Lo garantizado es eso: el número
 * que se muestra sale de contar la lista que se muestra.
 *
 * ⚠️ LO QUE ESTA FUNCIÓN **NO** ES: la lista se arma acá y ⛔ no se deriva de producción. Un camino
 * que empiece a pedir una firma más y no pase por acá quedaría mal enumerado, y ⛔ nada de esta ola lo
 * detectaría. Lo que sí queda cerrado es que la pantalla diga un número y enumere otra cosa.
 *
 * 🔴 LA PRUEBA DE POSESIÓN ENTRÓ POR EL `BLQ-BAJO-1` DEL AR, y su ausencia era un enunciado FALSO y no
 * una omisión: la lista del camino por enlace no la incluía, y el tipo `ResultadoDeEnvio` de
 * `../../application/use-cases/confirm-and-send.ts` la declara como una de sus tres salidas. ⛔ ESA
 * CITA VA SIN ANCLA A PROPÓSITO, y es el mismo motivo que el del import de `MARCAS_DE_VUELTA` de más
 * arriba: ese archivo lleva marcadores de censo de citas ancladas entrantes POR NÚMERO, y anclar una
 * cita nueva hacia él obligaría a editar marcadores de archivos fuera del alcance de este fix-pack.
 *
 * ⚠️ Y LO QUE LA LISTA SIGUE SIN ENUMERAR, declarado en vez de disimulado: la prueba de posesión que
 * (`execute`, `../../application/use-cases/connect-wallet.ts:73`) pide AL CONECTAR. Queda afuera
 * porque el anuncio de la pantalla de entrada se muestra JUSTO PARA ESE salto: enumerarla ahí sería
 * anunciar como futura la firma que la persona está por dar.
 */
export function firmasDelCamino(p: { porEnlace: boolean }): readonly Firma[] {
  const laTransaccion: Firma = {
    queSeFirma: "La transacción que deposita tus USDC en el escrow",
    porQue: "Es la que mueve tu plata. Sin esta firma no sale nada.",
  };
  if (!p.porEnlace) return [laTransaccion];
  return [
    {
      queSeFirma: "Un permiso corto para preparar la transacción",
      porQue: "Deja la transacción lista aunque tardes en volver de tu billetera.",
    },
    {
      queSeFirma: "Una prueba de que esa billetera es tuya",
      porQue: "No mueve ni un centavo: la pide nuestro servidor antes de preparar el pago.",
    },
    laTransaccion,
    {
      queSeFirma: "La autorización del patrocinio de la comisión de red",
      porQue: "Va aparte de la transacción de arriba porque la pide el camino patrocinado.",
    },
  ];
}

/** El bloque que se muestra ANTES de salir. ⛔ Nunca un salto sin aviso previo (`AC-5`). */
export interface Anuncio {
  readonly titulo: string;
  readonly aDondeVas: string;
  readonly firmas: readonly Firma[];
  readonly volves: string;
  readonly boton: string;
}

export function anuncioDe(p: { porEnlace: boolean }): Anuncio {
  return {
    titulo: "Vas a salir a tu billetera",
    aDondeVas: "Se abre tu billetera para que revises y firmes. Chaski no firma por vos.",
    firmas: firmasDelCamino(p),
    volves: "Cuando termines, volvés a esta misma pantalla y seguimos donde estabas.",
    boton: "Abrir mi billetera",
  };
}

/**
 * El texto del estado EN VUELO (`AC-6`). ⛔ Ni pantalla vacía ni un indicador mudo: mientras el salto
 * pasa, lo que queda montado dice con palabras qué está pasando y qué va a pasar al volver.
 */
export const TEXTO_EN_VUELO = "Estamos en tu billetera. Volvés acá mismo.";

/** El mismo estado, para el salto al verificador de identidad. */
export const TEXTO_EN_VUELO_IDENTIDAD = "Estamos en el verificador. Volvés acá mismo.";
