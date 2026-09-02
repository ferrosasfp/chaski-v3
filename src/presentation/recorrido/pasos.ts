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

/** La etiqueta de UN paso. Existe para que un copy que necesite nombrar una pantalla la nombre como
 *  la nombra el indicador de progreso, ⛔ y no con un literal que se despega el día que la tabla
 *  cambie. Mismo cuerpo que `etiquetasDe`, para un solo paso. */
export function etiquetaDe(paso: PasoDelRecorrido): string {
  return TABLA.find((f) => f.id === paso)?.etiqueta ?? paso;
}

/** La posición de `paso` en `itin`, o `-1` si ese paso no le toca a esta persona. */
export function indiceEn(itin: readonly PasoDelRecorrido[], paso: PasoDelRecorrido): number {
  return itin.indexOf(paso);
}

/**
 * El paso siguiente. En el último devuelve el último: no hay «siguiente» que inventarle.
 *
 * 🔴 Y PARA UN PASO QUE ⛔ NO ESTÁ EN EL ITINERARIO DEVUELVE EL QUE LE SIGUE EN LA TABLA, ⛔ NUNCA EL
 * PRIMERO (CR/BLQ-BAJO-3). Acá había `return itin[0]`, o sea LA PANTALLA DE ENTRADA, que es lo único
 * que el invariante de esta HU prohíbe con la palabra NUNCA. El caso que lo alcanza es concreto:
 * quien ya tiene la identidad verificada no lleva ese paso en su itinerario, así que avanzar desde
 * ahí mandaba a la persona al principio del recorrido en vez de a la pantalla de firmar.
 *
 * ⚠️ Hoy ese caso no se puede provocar desde la app porque el prop que arma el itinerario corto ⛔ no
 * tiene ningún productor, y ésa es justamente la razón para arreglarlo ahora: es una mina que se arma
 * sola el día que se cablee, y para entonces nadie va a estar mirando esta función.
 *
 * ⛔ El último recurso es el ÚLTIMO paso del itinerario, y si el itinerario viniera vacío devuelve el
 * paso recibido (quedarse quieto). Ninguna de las dos salidas es la pantalla de entrada.
 */
export function siguiente(
  itin: readonly PasoDelRecorrido[],
  paso: PasoDelRecorrido,
): PasoDelRecorrido {
  const i = indiceEn(itin, paso);
  if (i >= 0) return itin[Math.min(i + 1, itin.length - 1)] ?? paso;
  const enLaTabla = TABLA.findIndex((f) => f.id === paso);
  for (const id of itin) if (TABLA.findIndex((f) => f.id === id) > enLaTabla) return id;
  return itin[itin.length - 1] ?? paso;
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
