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
import { PASO_DE_ENTRADA, type PasoDelRecorrido } from "./pasos";

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
  const porEnlace = (ATERRIZAJE_POR_ENLACE as Record<string, PasoDelRecorrido | undefined>)[marca];
  return porEnlace ?? SIN_ATERRIZAJE;
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
 * `codigoDeError` es el código crudo que el camino de vuelta dejó, o `null`/ausente si volvió bien.
 * El texto legible sale de (`humanError`, `../flow-vm.ts:572`), que a su vez consulta primero a
 * (`copyDeEnlace`, `../flow-vm.ts:1503`): ⛔ acá no se escribe ni un mensaje de error nuevo.
 */
export function vueltaDeUnSalto(p: { href: string; codigoDeError?: string | null }): Vuelta {
  const marca = marcaDeLaUrl(p.href);
  if (marca === null) return { desenlace: "sin-marca" };
  const paso = aterrizajeDe(marca);
  if (paso === SIN_ATERRIZAJE) return { desenlace: "sin-aterrizaje", marca };
  const codigo = p.codigoDeError ?? null;
  return { desenlace: "aterriza", paso, motivo: codigo === null ? null : humanError(codigo) };
}

/**
 * ⛔ NINGÚN PASO DE ATERRIZAJE PUEDE SER LA PANTALLA DE ENTRADA (`AC-7`). Se expone como predicado
 * —y no como un comentario— para que el anfitrión pueda fallar cerrado si algún día lo fuera, en vez
 * de mandar a la persona al principio en silencio.
 */
export function aterrizaEnLaEntrada(a: Aterrizaje): boolean {
  return a !== SIN_ATERRIZAJE && a === PASO_DE_ENTRADA;
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
