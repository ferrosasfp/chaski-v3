// WKH-374 · W1.0 — LA TABLA ÚNICA Y ENUMERABLE DEL RECORRIDO NUEVO (AC-2)
//
// ⛔ CERO JSX, CERO DOM, CERO ALMACENAMIENTO. Este módulo es la aritmética del recorrido: qué pasos
// hay, cuáles se muestran a esta persona y cómo se avanza y se retrocede entre ellos. Todo lo que
// dibuja vive en `./pantallas.tsx` y todo lo que decide en vivo vive en `./recorrido.tsx`.
//
// ⚠️ ESTE ARCHIVO NO SE EJECUTA EN PRODUCCIÓN TODAVÍA. La bandera de `./bandera.ts` está APAGADA y su
// encendido es otra ola. Nada de lo de acá cambia una sola pantalla de la app de hoy.

/**
 * Los pasos del recorrido nuevo. La unión y la tabla de abajo son EL MISMO conjunto, y ése es el
 * punto de `AC-2`: un sitio único donde el conjunto está escrito.
 *
 * ⛔ NO SE ESCRIBE EN NINGÚN LADO CUÁNTOS SON. El tamaño sale de `TABLA.length` — un número escrito
 * a mano se queda viejo el día que la tabla crece y nadie se entera, que es exactamente la clase de
 * artefacto que esta HU vino a eliminar.
 */
export type PasoDelRecorrido = "entrar" | "envio" | "identidad" | "firmar" | "seguimiento";

/**
 * La pantalla de entrada, nombrada aparte porque es el ÚNICO paso sobre el que hay una prohibición:
 * ⛔ ninguna vuelta de un salto puede aterrizar acá (`AC-7`, y lo mide `T-374-W1-3`).
 * Tenerlo como constante es lo que deja que `./salto.ts` lo compare por valor sin volver a escribirlo.
 */
export const PASO_DE_ENTRADA: PasoDelRecorrido = "entrar";

export interface FilaDelRecorrido {
  /** El identificador estable del paso. Es lo que viaja por la máquina de estado. */
  readonly id: PasoDelRecorrido;
  /** Lo que la persona lee en el indicador de progreso. */
  readonly etiqueta: string;
  /**
   * `true` ⇒ el paso se muestra SÓLO la primera vez (`AC-4`). Es lo que hace que un envío recurrente
   * tenga un itinerario más corto que uno de primera vez, y por eso el indicador de progreso recibe
   * el ITINERARIO y ⛔ nunca la tabla: si recibiera la tabla, una persona recurrente vería una
   * etiqueta de más y un paso de menos.
   */
  readonly soloLaPrimeraVez: boolean;
}

/**
 * 🔴 LA TABLA. Es el único sitio del árbol nuevo donde el conjunto de pasos está escrito.
 *
 * El orden ES load-bearing y es la mitad de `AC-1`: conectar la billetera es el PRIMER paso, no el
 * tercero. De ahí sale que cuando se pide monto, beneficiario y CCI ya hay una dirección conectada a
 * la que atar el envío, y de ahí sale —§3.2 del Story File— que la pantalla donde se tipea no
 * necesite saltar a ningún lado.
 */
export const TABLA: readonly FilaDelRecorrido[] = [
  { id: "entrar", etiqueta: "Entrar", soloLaPrimeraVez: false },
  { id: "envio", etiqueta: "Cuánto y para quién", soloLaPrimeraVez: false },
  { id: "identidad", etiqueta: "Tu identidad", soloLaPrimeraVez: true },
  { id: "firmar", etiqueta: "Firmar y enviar", soloLaPrimeraVez: false },
  { id: "seguimiento", etiqueta: "Seguimiento", soloLaPrimeraVez: false },
] as const;

/** ¿`x` es uno de los pasos de la tabla? Se resuelve CONTRA la tabla y no contra una lista aparte:
 *  un paso nuevo queda reconocido sin tocar esta función. */
export function esPasoDelRecorrido(x: string): x is PasoDelRecorrido {
  return TABLA.some((f) => f.id === x);
}

/**
 * El itinerario DE ESTA PERSONA (`AC-4`).
 *
 * Con la identidad ya verificada el paso condicional se cae y el recorrido queda más corto; sin
 * verificar, se muestra entero. ⛔ Los dos largos salen de filtrar la tabla: ninguno está escrito.
 */
export function itinerario(p: { identidadYaVerificada: boolean }): readonly PasoDelRecorrido[] {
  return TABLA.filter((f) => !(f.soloLaPrimeraVez && p.identidadYaVerificada)).map((f) => f.id);
}

/**
 * Las etiquetas del itinerario, en su orden.
 *
 * 🔴 EL INVARIANTE QUE ESTA FUNCIÓN EXISTE PARA SOSTENER: `etiquetasDe(i).length === i.length`,
 * SIEMPRE. Se cumple por construcción —se mapea el mismo arreglo— y no por una comparación que
 * alguien tenga que acordarse de hacer. Lo mide `T-374-W1-2` en los DOS casos, porque en el de
 * primera vez el itinerario y la tabla coinciden y un error ahí no se ve.
 */
export function etiquetasDe(itin: readonly PasoDelRecorrido[]): readonly string[] {
  return itin.map((id) => TABLA.find((f) => f.id === id)?.etiqueta ?? id);
}

/** La posición de `paso` en `itin`, o `-1` si ese paso no le toca a esta persona. */
export function indiceEn(itin: readonly PasoDelRecorrido[], paso: PasoDelRecorrido): number {
  return itin.indexOf(paso);
}

/**
 * El paso siguiente dentro del itinerario. En el último paso devuelve el último: el seguimiento es
 * el estado terminal del recorrido y ⛔ no hay ningún «siguiente» que inventarle.
 * Un paso que no está en el itinerario devuelve el primero que sí está — es el caso de la identidad
 * ya verificada, donde el paso condicional no existe para esta persona.
 */
export function siguiente(
  itin: readonly PasoDelRecorrido[],
  paso: PasoDelRecorrido,
): PasoDelRecorrido {
  const i = indiceEn(itin, paso);
  if (i < 0) return itin[0] ?? PASO_DE_ENTRADA;
  return itin[Math.min(i + 1, itin.length - 1)] ?? paso;
}

/**
 * El paso anterior dentro del itinerario: es lo que hace «Volver» (`AC-3`).
 *
 * ⛔ RETROCEDER NO BORRA NADA. Esta función devuelve un identificador de paso y no toca ningún dato:
 * lo cargado vive en el estado del anfitrión, que ⛔ no se limpia al retroceder. Lo mide
 * `T-374-W1-6` afirmando los VALORES de los tres campos, y no el paso — el paso volvería bien igual
 * con el estado borrado, que es el falso KILLED que ese `it` existe para evitar.
 */
export function anterior(
  itin: readonly PasoDelRecorrido[],
  paso: PasoDelRecorrido,
): PasoDelRecorrido {
  const i = indiceEn(itin, paso);
  if (i <= 0) return itin[0] ?? PASO_DE_ENTRADA;
  return itin[i - 1] ?? paso;
}
