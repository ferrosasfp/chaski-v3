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

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// HU-075/diagnóstico it2 — LOS CUATRO HITOS DEL RECORRIDO
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 POR QUÉ HACE FALTA UN SEGUNDO MECANISMO Y NO ALCANZA CON `ultimo`. El bloque de diagnóstico es
// HERMANO de `RemittanceFlow` en `app/page.tsx`, no hijo: ⛔ no puede leer un solo `useState` suyo.
// Y las cuatro cosas que la captura del founder no distingue —en qué paso está la pantalla, qué
// contestó `connectWallet.execute()`, cómo terminó `onConnect`, qué error atrapó `guard`— son las
// cuatro estado de React adentro de ese componente. Sin este canal, la única forma de verlas sería
// meter el bloque adentro de `flow.tsx`, que es exactamente lo que su docblock evita.
//
// ⛔ NO SALE DEL DISPOSITIVO, igual que `ultimo`: sin `fetch`, sin `localStorage`, sin `console`. Vive
// lo que vive la pestaña.
//
// 🔴 Y ⛔ **NO NOTIFICA**, a diferencia de `anotarCorteDeVuelta`, y la razón es medible y no de gusto:
// uno de los cuatro (`pantalla`) se anota desde un efecto de `RemittanceFlow`, y un store que avisara
// haría que un componente HERMANO se re-renderizara por el render de otro. React lo permite desde un
// efecto, pero encadenarlo así ata el bloque al ciclo de la pantalla que está observando, que es
// justo lo que un observador no tiene que hacer. En su lugar el bloque REFRESCA SOLO
// ((`REFRESCO_MS`, `./diagnostico-de-vuelta.tsx:160`)), que además es lo que necesita para ver
// cambiar el disco. ⇒ `anotarHito` es una asignación a un `Map`, sin oyentes y sin costo.
//
// ⛔ QUÉ **NO** PUEDE ENTRAR ACÁ: ningún valor que venga del disco o de la billetera. Los cuatro son
// etiquetas que este repo escribe —un `Step`, el `estado` de un resultado, una frase fija del
// desenlace de `onConnect`— más el código de error que la pantalla YA pinta con `shortErrorCode`. Es
// el mismo argumento que ya está escrito arriba para la causa del corte.

/** Los cuatro, cerrados. Un quinto obliga a decidir qué pregunta contesta y a darle renglón. */
export type HitoDeVuelta = "pantalla" | "connect" | "continuacion" | "error";

const hitos = new Map<HitoDeVuelta, string>();

/** Lo llaman cuatro sitios de `./flow.tsx`, todos en líneas que ya existían (Δ0). */
export function anotarHito(clave: HitoDeVuelta, valor: string): void {
  hitos.set(clave, valor);
}

/** `null` = ese hito no se anotó nunca en esta carga, que ⛔ NO es lo mismo que un valor vacío: es
 *  «no corrió», y separar esas dos es la mitad del valor de estos campos. */
export function leerHito(clave: HitoDeVuelta): string | null {
  return hitos.get(clave) ?? null;
}

/** Test-only, mismo contrato que `olvidarCorteDeVuelta`: limpia entre `it` y no avisa a nadie. */
export function olvidarHitos(): void {
  hitos.clear();
}
