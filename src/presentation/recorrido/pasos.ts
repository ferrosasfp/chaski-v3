// WKH-374 · W1.0 — LA TABLA ÚNICA Y ENUMERABLE DEL RECORRIDO NUEVO (AC-2)
//
// ⛔ CERO JSX, CERO DOM, CERO ALMACENAMIENTO: acá vive la aritmética del recorrido y nada más.
// ⚠️ Y todavía no se ejecuta en producción: la bandera de `./bandera.ts` está APAGADA.

/**
 * Los pasos del recorrido. La unión y la tabla de abajo son EL MISMO conjunto, y ése es el punto de
 * `AC-2`. ⛔ Cuántos son no se escribe en ningún lado: sale de `TABLA.length`, porque un número a
 * mano se queda viejo el día que la tabla crece y nadie se entera.
 */
export type PasoDelRecorrido = "entrar" | "envio" | "identidad" | "firmar" | "seguimiento";

/** La pantalla de entrada. Va aparte porque es el ÚNICO paso con una prohibición: ⛔ ninguna vuelta
 *  de un salto aterriza acá (`AC-7`, lo mide `T-374-W1-3`), y `./salto.ts` la compara POR VALOR. */
export const PASO_DE_ENTRADA: PasoDelRecorrido = "entrar";

export interface FilaDelRecorrido {
  /** El identificador estable del paso. Es lo que viaja por la máquina de estado. */
  readonly id: PasoDelRecorrido;
  /** Lo que la persona lee en el indicador de progreso. */
  readonly etiqueta: string;
  /** `true` ⇒ se muestra SÓLO la primera vez (`AC-4`). Por eso el indicador de progreso recibe el
   *  ITINERARIO y ⛔ nunca la tabla: con la tabla, una persona recurrente vería una etiqueta de más
   *  y un paso de menos. */
  readonly soloLaPrimeraVez: boolean;
}

/**
 * 🔴 LA TABLA. El único sitio del árbol nuevo donde el conjunto de pasos está escrito.
 *
 * El orden ES load-bearing y es la mitad de `AC-1`: conectar es el PRIMER paso y no el tercero. De
 * ahí sale que la pantalla donde se tipea ya tenga una dirección conectada, y de ahí sale que no
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
 * Las etiquetas del itinerario, en su orden. 🔴 El invariante que sostiene es
 * `etiquetasDe(i).length === i.length`, SIEMPRE, y se cumple por construcción: se mapea el mismo
 * arreglo. Lo mide `T-374-W1-2` en los DOS casos, porque en el de primera vez itinerario y tabla
 * coinciden y un error ahí no se ve.
 */
export function etiquetasDe(itin: readonly PasoDelRecorrido[]): readonly string[] {
  return itin.map((id) => TABLA.find((f) => f.id === id)?.etiqueta ?? id);
}

/** La posición de `paso` en `itin`, o `-1` si ese paso no le toca a esta persona. */
export function indiceEn(itin: readonly PasoDelRecorrido[], paso: PasoDelRecorrido): number {
  return itin.indexOf(paso);
}

/** El paso siguiente. En el último devuelve el último (el seguimiento es terminal y ⛔ no hay
 *  «siguiente» que inventarle), y un paso que no está en el itinerario devuelve el primero que sí
 *  está: es el caso de la identidad ya verificada. */
export function siguiente(
  itin: readonly PasoDelRecorrido[],
  paso: PasoDelRecorrido,
): PasoDelRecorrido {
  const i = indiceEn(itin, paso);
  if (i < 0) return itin[0] ?? PASO_DE_ENTRADA;
  return itin[Math.min(i + 1, itin.length - 1)] ?? paso;
}

/**
 * El paso anterior: es lo que hace «Volver» (`AC-3`).
 *
 * ⛔ RETROCEDER NO BORRA NADA. Esto devuelve un identificador y no toca ningún dato. Lo mide
 * `T-374-W1-6` afirmando los VALORES de los tres campos y ⛔ no el paso: el paso volvería bien igual
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
