// WKH-332 (AC-3 / CD-3) — el conjunto CERRADO de valores que `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`
// puede tomar, y la única función autorizada a interpretarlo.
//
// EL MODO DE FALLA QUE ESTE ARCHIVO EXISTE PARA CERRAR, con su input concreto:
// antes de esta HU `container.ts` derivaba `useA2a = adapter === "a2a" || adapter === "a2a-gateway"`.
// Con la env en `"a2a-gatewayy"` (un typo de una letra) esa expresión da `false`, el container cablea
// `FallbackQuoteGateway` / `FallbackPayoutGateway` —los simuladores— y la app NO falla: cotiza de
// mock y muestra la pantalla normal. Un default que degrada a simulación no falla, MIENTE.
// Acá ese input tira. Input que pone en rojo la afirmación anterior: T-3.2 quedando verde después de
// cambiar el `throw` de abajo por un `return "fallback"` (mutante M1).
//
// El valor SÍ va en el mensaje, y no es una filtración: `NEXT_PUBLIC_*` es, por definición de Next,
// una variable que ya viaja inlineada en el bundle del browser. No hay nada acá que el navegador no
// tuviera antes. Lo que NO va nunca en el mensaje es una URL de gateway ni una Agent Key (CD-5), y
// esta función no las ve.

/**
 * 🔴 LA ÚNICA LISTA. No hay una segunda en ningún otro archivo, y ese es el punto.
 *
 * El tipo se DERIVA de este array (`(typeof …)[number]`), así que agregar o sacar un valor mueve el
 * conjunto aceptado Y la unión de tipos en la misma edición. La alternativa —un `type` escrito a
 * mano al lado de un `Set` escrito a mano— es la que produjo el bug de abajo.
 *
 * 🔴 `"a2a"` ES TRANSITORIO Y SALE EN W3 DE ESTA MISMA HU, en el MISMO diff que borra el carril
 * punto a punto de `app/api/a2a/quote/route.ts` y `app/api/payout/prepare/route.ts`. NO es un
 * olvido, y NO se puede sacar antes: hoy `"a2a"` es el valor con el que corre producción y significa
 * "usá los gateways A2A reales". Si saliera del conjunto mientras la env vale `"a2a"`, la app
 * dejaría de arrancar con la configuración vigente (mutante M2, que `container.test.ts:38` mata).
 * Cuando el carril viejo se borre, `"a2a"` pasa a TIRAR: en ese árbol ya no nombra ningún camino.
 *
 * Sacarlo de acá pone en rojo el `case "a2a"` de `usesRealGateways` con un error de `tsc`
 * (TS2678: el literal no es comparable con la unión), o sea que W3 NO PUEDE sacar el valor y
 * olvidarse del mapeo: el compilador lo frena.
 */
export const VALUE_DELIVERY_ADAPTERS = [
  "a2a-gateway", // el carril real por gateway (WKH-218)
  "a2a", // 🔴 TRANSITORIO — sale en W3 (ver el docblock de este array)
  "fallback", // el demo con mocks, nombrado a propósito y no un accidente
] as const;

/**
 * Los valores aceptados. Es una unión cerrada a propósito: un `string` suelto vuelve a permitir que
 * un typo se interprete en silencio.
 */
export type ValueDeliveryAdapter = (typeof VALUE_DELIVERY_ADAPTERS)[number];

const ACCEPTED: ReadonlySet<string> = new Set<string>(VALUE_DELIVERY_ADAPTERS);

/**
 * ¿Este adapter cablea los gateways A2A REALES, o los simuladores?
 *
 * ── POR QUÉ ESTA FUNCIÓN EXISTE, Y NO ES UNA ENVOLTURA DECORATIVA (AR/BLQ-ALTO-2) ────────────────
 *
 * El guard de arriba cierra "un valor ILEGAL no cablea el mock". No cerraba nada sobre los valores
 * LEGALES: qué hace cada uno vivía en una segunda expresión, en otro archivo, sin guarda y sin test
 * de valor. `container.ts` decía, literalmente:
 *
 *     const useA2a = adapter === "a2a" || adapter === "a2a-gateway";
 *
 * o sea la lista otra vez, escrita a mano. MEDIDO por el AR: borrando `adapter === "a2a" ||` de esa
 * línea la suite COMPLETA daba 1580/1580 en verde, y con la env en `"a2a"` —la de producción— el
 * container cableaba `FallbackQuoteGateway`. Exactamente el estado que este módulo declara
 * imposible: los simuladores, en silencio, con todo verde.
 *
 * Dos cosas lo cierran ahora, y ninguna es disciplina:
 *  1. El `switch` es EXHAUSTIVO sobre la unión derivada de `VALUE_DELIVERY_ADAPTERS`. Agregar un
 *     valor al array sin decir a qué cablea deja esta función devolviendo `undefined` contra un tipo
 *     de retorno `boolean` ⇒ `tsc` rojo. Sacar un valor deja un `case` incomparable ⇒ `tsc` rojo.
 *  2. `container.test.ts` recorre `VALUE_DELIVERY_ADAPTERS` y asserta QUÉ CLASE queda cableada para
 *     cada valor, no que no tire. Input que lo pone en rojo: devolver `false` en el `case "a2a"`.
 */
export function usesRealGateways(adapter: ValueDeliveryAdapter): boolean {
  switch (adapter) {
    case "a2a-gateway":
      return true;
    // 🔴 Sale en W3 junto con el valor. Mientras exista, cablea lo REAL: es la env de producción.
    case "a2a":
      return true;
    case "fallback":
      return false;
  }
}

/**
 * Traduce el valor crudo de la env al adapter, o TIRA.
 *
 * `undefined` (env AUSENTE) ⇒ `"fallback"`: es el default documentado en `.env.example`
 * (*"unset/'fallback' (default) → Fallback gateways (demo, payout MOCK)"*).
 *
 * `""` (env PRESENTE Y VACÍA) ⇒ TIRA, y la distinción con `undefined` no es cosmética: `vercel env
 * pull` escribe VACÍO lo que no puede leer, así que un `""` es una key que alguien escribió y quedó
 * en blanco —una mala configuración— y no una ausencia deliberada. Este repo ya declara esa
 * diferencia en `quote/route.test.ts:276-279`.
 *
 * @param raw el valor tal cual sale de `process.env.NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`. Se recibe
 *   por parámetro y NO se lee acá adentro: Next sólo inlinea `process.env.NEXT_PUBLIC_X` cuando
 *   aparece como acceso estático literal, y una lectura dentro de un helper compartido no lo es.
 *   Mismo motivo que `evm-residue-guard.ts:3-7`.
 */
export function resolveValueDeliveryAdapter(raw: string | undefined): ValueDeliveryAdapter {
  if (raw === undefined) return "fallback";
  if (ACCEPTED.has(raw)) return raw as ValueDeliveryAdapter;
  throw new Error(
    `value_delivery_adapter_invalido: NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=${JSON.stringify(raw)} no esta entre ${[...ACCEPTED].join(" | ")}`,
  );
}
