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
export type HitoDeVuelta = "pantalla" | "connect" | "continuacion" | "error" | "salida-al-navegador"; // WKH-372/W1 — EL QUINTO, EN ESTA MISMA LÍNEA (Δ0), y con su renglón: lo pinta el renglón `salida navegador` del bloque de diagnóstico (`./diagnostico-de-vuelta.tsx:589`). La pregunta que contesta está en (`anotarLaSalidaAlNavegador`, `:176`)

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

/**
 * HU-075/gesto — LA FORMA DEL DESTINO DEL SALTO, y ⛔ NUNCA EL DESTINO.
 *
 * 🔴 QUÉ PREGUNTA CONTESTA. El diagnóstico del teléfono mostraba `connect: hay-que-salir` con la
 * persona parada en la bienvenida, y eso admitía dos causas que la foto no separaba: que el `irA`
 * llegara VACÍO —y entonces no había a dónde navegar— o que el navegador móvil descartara la
 * navegación programática sin gesto. Este renglón separa las dos EN EL TELÉFONO, que es donde la
 * hipótesis 1 se puede volver a levantar si algo cambia río arriba.
 *
 * ⛔ POR QUÉ ESTO NO VIOLA LA REGLA DE ARRIBA («ningún valor que venga del disco o de la billetera»).
 * Lo que devuelve es esquema + host + path + LARGO, y nada más:
 *   · el esquema/host/path salen del mapa `BASE` de `../infrastructure/solana/deeplink/protocol.ts`,
 *     que es una constante que escribe ESTE repo (`https://phantom.app/ul/v1`, `https://solflare.com/ul/v1`);
 *   · ⛔ LA QUERY SE TIRA ENTERA, y ahí es donde viven el sobre cifrado, el `nonce` y la `session`;
 *   · el largo es un número.
 * Las dos ramas de falla tampoco imprimen el valor: dicen qué le pasa y cuánto mide.
 *
 * ⚠️ NO afirma que la URL sea BUENA: una URL absoluta bien formada puede igual apuntar a cualquier
 * lado. Afirma que existe y qué forma tiene, que es exactamente lo que hace falta para descartar «no
 * había a dónde ir».
 */
export function formaDelDestino(irA: string): string {
  if (irA === "") return "VACÍO (0 chars)";
  let u: URL;
  try {
    u = new URL(irA);
  } catch {
    return `NO ES UNA URL ABSOLUTA (${irA.length} chars)`;
  }
  return `${u.protocol}//${u.host}${u.pathname} (${irA.length} chars)`;
}

/**
 * WKH-372/W1 — EL QUINTO HITO: ¿qué se encontró la app al ATERRIZAR dentro del navegador de la
 * billetera?
 *
 * 🔴 QUÉ PREGUNTA CONTESTA, que es lo que el renglón de arriba exige antes de aceptar un quinto valor:
 * *"¿el `localStorage` cruzó el salto al navegador de la billetera?"*. Nadie la contestó todavía en un
 * teléfono, y este repo NO la afirma: la mide en el campo. El navegador de la billetera es OTRA
 * PARTICIÓN DE ALMACENAMIENTO —no es volver al mismo origen, es el mismo origen en otro navegador—,
 * así que la respuesta no se puede heredar de ninguna medición previa.
 *
 * TRES VALORES, y ninguno se puede colapsar en otro:
 *   · `con-marca-y-borrador`  — se salió con datos cargados y del otro lado ESTÁN ⇒ el disco cruzó.
 *   · `con-marca-sin-borrador`— se salió con datos cargados y del otro lado NO están ⇒ no cruzó.
 *   · `sin-marca`             — no se llegó por una salida: es una visita nueva en este navegador, y
 *     de ahí no se puede concluir NADA sobre el almacenamiento. ⛔ Colapsarlo en `sin-borrador` sería
 *     convertir "no pude preguntar" en "no pasó".
 *
 * ⛔ QUÉ **NO** ENTRA ACÁ, y es la regla de este archivo: ninguna dirección, ninguna clave, ninguna
 * URL. Los tres son etiquetas que escribe ESTE repo, igual que los cuatro de arriba. Por eso la
 * función recibe DOS BOOLEANOS y no el href ni el blob del disco: lo que sabe leerlos es la pantalla,
 * y lo único que cruza esta puerta es el veredicto.
 *
 * 🔴 SE ANOTA UNA SOLA VEZ, Y ES LA PARTE QUE IMPORTA: la pregunta es sobre el ATERRIZAJE. Si se
 * re-anotara en cada cambio de pantalla, la primera carga del formulario poblaría el disco y el hito
 * pasaría a decir `con-marca-y-borrador` sobre un borrador que creó la propia persona DESPUÉS de
 * llegar. O sea que se estaría midiendo el resultado de la medición. `olvidarHitos()` lo limpia entre
 * tests, igual que a los otros cuatro.
 */
export function anotarLaSalidaAlNavegador(p: { vinoConMarca: boolean; hayBorrador: boolean }): void {
  if (hitos.has("salida-al-navegador")) return;
  hitos.set(
    "salida-al-navegador",
    p.vinoConMarca ? (p.hayBorrador ? "con-marca-y-borrador" : "con-marca-sin-borrador") : "sin-marca",
  );
}
