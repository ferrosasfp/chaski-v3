// WKH-373 — LA FORMA DE UN HREF DE VUELTA, y ⛔ NUNCA EL HREF.
//
// 🔴 QUÉ PREGUNTA CONTESTA, Y POR QUÉ ES LA QUE DECIDE. La causa raíz que este arreglo cierra fue que
// el paso 2 del productor de montaje ((`limpiarLaBarra`, `../../../presentation/flow.tsx:4023`)) le
// borra a la barra el `dl`, el `nonce`, el `data` y la clave de cifrado ANTES de que el único lector
// de la vuelta del DEPÓSITO la mire, y ese lector leía `globalThis.location.href` EN VIVO. Desde la
// pantalla ese caso es INDISTINGUIBLE de «la billetera devolvió otra transacción» y de «la firma no
// verifica»: los tres terminan en el mismo copy. Este renglón los separa con una captura, y sin
// pedirle a nadie que vuelva a probar cuatro veces en un teléfono.
//
// ⛔ POR QUÉ ESTO NO VIOLA LA REGLA DEL BLOQUE DE DIAGNÓSTICO («ningún secreto»). Lo que sale son
// BOOLEANOS y una etiqueta de un conjunto CERRADO que escribe este repo:
//   · `dl=` es la marca, VALIDADA contra `MARCAS_DE_VUELTA`; cualquier otra cosa sale `?`, así que
//     ⛔ nunca se pinta un string arbitrario de la URL. Es el mismo criterio que
//     (`pasoDelViaje`, `../../../presentation/diagnostico-de-vuelta.tsx:363`) ya aplica para el paso
//     del viaje, y por la misma razón: la marca la puede escribir cualquiera.
//   · de `nonce`, `data` y la clave de cifrado sale `sí`/`no` y NADA MÁS. ⛔ El `data` es el sobre
//     cifrado y la clave pública es el otro extremo del canal: ninguno de los dos VALORES entra acá
//     más que para preguntar si están.
//
// ⚠️ NO AFIRMA QUE LA VUELTA SEA BUENA: un `nonce=sí data=sí` puede ser igual un sobre que no abre, o
// la respuesta de OTRO salto. Afirma qué le LLEGÓ al consumidor, que es exactamente lo que hace falta
// para descartar «se lo borramos nosotros» y nada más que eso.
import { CLAVE_EN_RESPUESTA } from "./protocol";
import { MARCA, MARCAS_DE_VUELTA } from "./sesion";

/** `dl=firmar-tx nonce=sí data=sí key=no`. ⛔ PURA: no toca el disco, no consume ninguna marca y no
 *  escribe nada — es la misma disciplina que (`marcaDeVuelta`, `./conexion.ts:338`) ya declara, y es
 *  lo que permite llamarla desde el productor de montaje sin quitarle la vuelta a nadie. */
export function formaDelHref(href: string): string {
  let p: URLSearchParams;
  try {
    p = new URL(href).searchParams;
  } catch {
    // Una URL que no parsea no tiene parámetros. ⛔ Decir `no` a los cuatro sería afirmar que se
    // preguntó, y no se pudo: es la misma distinción que el resto del recorrido hace entre «no hay» y
    // «no pudimos preguntar». El largo va porque separa «vino vacío» de «vino algo que no es una URL».
    return `ILEGIBLE (${href.length} chars)`;
  }
  const cruda = p.get(MARCA);
  const dl = cruda === null ? "—" : (MARCAS_DE_VUELTA as readonly string[]).includes(cruda) ? cruda : "?";
  // Las DOS billeteras, del mapa que las declara. ⛔ Nada de copiar los nombres de los parámetros acá:
  // sería una lista que envejece sola en cuanto se agregue una tercera.
  const key = Object.values(CLAVE_EN_RESPUESTA).some((k) => p.get(k) !== null);
  const si = (b: boolean): string => (b ? "sí" : "no");
  return `dl=${dl} nonce=${si(p.get("nonce") !== null)} data=${si(p.get("data") !== null)} key=${si(key)}`;
}
