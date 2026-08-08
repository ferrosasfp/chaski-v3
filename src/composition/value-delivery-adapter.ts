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
 * 🔴 `"a2a"` YA NO ESTÁ, Y SALIÓ EN EL MISMO COMMIT QUE BORRÓ EL CARRIL PUNTO A PUNTO (W3). Era el
 * nombre del transporte que llamaba a los agentes por su slug desde `app/api/a2a/quote/route.ts` y
 * `app/api/payout/prepare/route.ts`. Ese código ya no existe, así que el valor no nombra ningún
 * camino: pasa a TIRAR. Sacarlo antes —con el carril todavía vivo y la env de producción en `"a2a"`—
 * habría dejado la app sin arrancar con la configuración vigente; sacarlo después habría dejado una
 * ventana en la que `"a2a"` no era reconocido Y se traducía a "no uses los gateways reales", o sea
 * los simuladores en silencio. Por eso las dos ediciones son una sola.
 *
 * ⚠️ QUIÉN SOSTIENE EL INVARIANTE, Y NO ES UN TEST (CR/MNR-1). Es `tsc`, antes de que corra un solo
 * test: sacar un valor de este array deja huérfano su `case` en (`usesRealGateways`, `:74`) ⇒ TS2678,
 * y deja su fila de la tabla `CABLEADO` de `container.test.ts` como propiedad de más ⇒ TS2353. Un
 * test no llega a ejecutarse en un árbol que no compila. Input que lo pone en rojo: borrar el `case`
 * o la fila sin borrar el valor, o al revés — cualquiera de las dos mitades sola deja `tsc` rojo.
 */
export const VALUE_DELIVERY_ADAPTERS = [
  "a2a-gateway", // el carril real por gateway (WKH-218)
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
 *     cada valor, no que no tire. Input que lo pone en rojo: `false` en el `case "a2a-gateway"`.
 */
export function usesRealGateways(adapter: ValueDeliveryAdapter): boolean {
  switch (adapter) {
    case "a2a-gateway":
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
 * diferencia en (`stubEnv`, `../../app/api/a2a/quote/route.test.ts:98-100`).
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
