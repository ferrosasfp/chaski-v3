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
 * Los valores aceptados. Es una unión cerrada a propósito: un `string` suelto vuelve a permitir que
 * un typo se interprete en silencio.
 *
 * 🔴 `"a2a"` ES TRANSITORIO Y SALE EN W3 DE ESTA MISMA HU, en el MISMO diff que borra el carril
 * punto a punto de `app/api/a2a/quote/route.ts` y `app/api/payout/prepare/route.ts`. NO es un
 * olvido, y NO se puede sacar antes: hoy `"a2a"` es el valor con el que corre producción y significa
 * "usá los gateways A2A reales". Si saliera del conjunto mientras la env vale `"a2a"`, la app
 * dejaría de arrancar con la configuración vigente (mutante M2, que `container.test.ts:38` mata).
 * Cuando el carril viejo se borre, `"a2a"` pasa a TIRAR: en ese árbol ya no nombra ningún camino.
 */
export type ValueDeliveryAdapter = "a2a-gateway" | "a2a" | "fallback";

const ACCEPTED: ReadonlySet<string> = new Set<ValueDeliveryAdapter>([
  "a2a-gateway", // el carril real por gateway (WKH-218)
  "a2a", // 🔴 TRANSITORIO — sale en W3 (ver el docblock de ValueDeliveryAdapter)
  "fallback", // el demo con mocks, nombrado a propósito y no un accidente
]);

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
