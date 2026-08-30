// HU-075/diagnóstico — LA BITÁCORA DEL CORTE DE LA VUELTA POR ENLACE.
//
// 🔴 QUÉ PROBLEMA RESUELVE, Y POR QUÉ NO ALCANZABA CON LO QUE YA SE VE EN PANTALLA.
// Cuando `useVueltaPorEnlace` corta, llama a `alFallar(causa)` y la pantalla pinta
// `humanError(causa)`. Ese copy es lo que la persona LEE, pero `humanError` tiene un default
// («Algo salió mal. Intentá de nuevo.», el que mide `deeplink-callers.test.ts:157`), así que una
// causa sin copy propio llega a la pantalla **sin decir cuál era**: exactamente el motivo por el que
// (`shortErrorCode`, `./flow-vm.ts:565`) existe para el OTRO camino de error. La rama de la vuelta por
// enlace no le pasa `code` al banner, y por eso la causa cruda se pierde.
//
// ⚠️ Y HAY UN SEGUNDO VALOR, QUE ES EL QUE MOTIVÓ ESTO: distinguir «cortó y no vi el banner» de
// **«no produjo nada»**. Un reporte humano («no me apareció ningún error») no distingue esas dos, y
// el productor de montaje tiene un retorno MUDO —(`remId`, `./flow.tsx:4010`)— que termina
// exactamente igual que un corte que nadie leyó: sin banner y en la pantalla de entrada.
//
// ⛔ NO ES TELEMETRÍA Y NO SALE DEL DISPOSITIVO. No hay `fetch`, no hay `localStorage`, no hay
// `console`. Es una variable de módulo que vive lo que vive la pestaña.
//
// ⛔ NO GUARDA NADA MÁS QUE LA CAUSA. Las causas del vocabulario del enlace son etiquetas fijas del
// dominio (`deeplink_*`), no datos de la persona — es el mismo argumento que ya está escrito en
// (`shortErrorCode`, `./flow-vm.ts:565`): «mostrar el código no es filtrar nada sensible». ⛔ Acá NO
// entra ninguna dirección, ninguna clave, ningún `session` ni ninguna transacción.
//
// 🔴 POR QUÉ UN STORE CON SUSCRIPCIÓN Y NO UN `let` SUELTO: quien la lee es un componente que puede
// estar montado ANTES de que el corte ocurra (el bloque de diagnóstico se pinta al montar y el corte
// llega después de varios `await`). Un `let` sin aviso lo dejaría mostrando el estado de un instante
// que ya pasó. Es el mismo patrón, y por la misma razón, que
// (`subscribeWalletAvailability`, `../infrastructure/solana-wallet-bridge.ts:78`).

/** El último corte, o `null` si el recorrido no cortó en esta carga de la página. */
let ultimo: string | null = null;

const oyentes = new Set<() => void>();

/**
 * Lo llama el `alFallar` de (`useVueltaPorEnlace`, `./flow.tsx:286`), en la MISMA línea y antes del
 * `setError`.
 *
 * ⛔ ES LO ÚNICO QUE ESTE MÓDULO LE AGREGA AL CAMINO DE PRODUCCIÓN, y no cambia ningún
 * comportamiento observable: sin nadie suscripto, `oyentes` está vacío y esto es una asignación. El
 * bloque de diagnóstico es el único que se suscribe, y sólo existe con el parámetro de URL puesto.
 */
export function anotarCorteDeVuelta(causa: string): void {
  ultimo = causa;
  for (const avisar of oyentes) avisar();
}

/** El snapshot para `useSyncExternalStore`: un `string | null`, o sea estable por identidad. */
export function ultimoCorteDeVuelta(): string | null {
  return ultimo;
}

export function suscribirAlCorteDeVuelta(avisar: () => void): () => void {
  oyentes.add(avisar);
  return () => {
    oyentes.delete(avisar);
  };
}

/** Test-only: limpia la causa entre tests. ⛔ NO borra los oyentes —desuscribirse es trabajo de quien
 *  se suscribió— y ⛔ NO avisa a nadie, por lo mismo que
 *  (`reset`, `../infrastructure/solana-wallet-bridge.ts:173`): un reset que notifica haría que un
 *  test pise el estado de un componente todavía montado de otro. */
export function olvidarCorteDeVuelta(): void {
  ultimo = null;
}
