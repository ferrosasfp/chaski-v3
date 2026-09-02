// WKH-374 · W1.0 — EL INTERRUPTOR DEL RECORRIDO NUEVO
//
// ⚠️ ESTE ARCHIVO ES CASI TODO PROSA, Y ESTÁ DECLARADO DE ANTEMANO EN EL PRESUPUESTO DE LA OLA (§11
// del Story File, ~65 %). ⛔ No se lo baje: lo que ocupa el espacio es el gotcha de despliegue, que
// es lo único que separa «prendí la bandera» de «prendí la bandera y no pasó nada».

/**
 * WKH-374 · ¿Está prendido el recorrido nuevo de cinco pantallas?
 *
 * OPT-IN ESTRICTO, mismo patrón y por la misma razón que (`mwaEnabled`, `../wallet-availability.ts:98`)
 * y (`deeplinkEnabled`, `../wallet-availability.ts:156`): sólo el literal `"true"` prende. Ausente,
 * vacía, `"1"`, `"TRUE"`, `"true "` con espacio o un typo ⇒ APAGADA. No hay ningún valor que la
 * prenda por accidente, y acá eso importa el doble: lo que enciende es un recorrido ENTERO distinto
 * del que la persona conoce, no una salida de más en una pantalla. Lo mide `T-374-W1-11`, que copia
 * los cinco valores del molde (`T-065-20`, `../wallet-availability.test.tsx:1021`).
 *
 * 🔴 QUÉ GATEA, EXACTAMENTE: cuál de los dos árboles monta `app/page.tsx`. Nada más. `<Splash/>` y
 * el bloque de diagnóstico se montan igual con la bandera prendida o apagada, y eso no es una
 * promesa: es la forma del ternario, y la fija `T-DIAG-CABLEADO`
 * (`../diagnostico-de-vuelta.test.tsx:435`) leyendo el fuente de la página.
 *
 * 🔴 QUÉ **NO** GATEA, dicho antes de que alguien lea su verde de más: con la bandera APAGADA el
 * árbol nuevo **no se ejecuta**, así que ningún número medido sobre el recorrido nuevo sale de
 * producción. Lo que `T-374-W1-10` sí afirma es lo simétrico y más chico: con la bandera apagada, la
 * página monta el árbol de HOY, byte por byte.
 *
 * ⚠️ GOTCHA DE DESPLIEGUE, el mismo que el de `mwaEnabled` (`../wallet-availability.ts:95-96`) y por
 * eso se repite acá adentro en vez de citarse: las `NEXT_PUBLIC_` las inlinea el BUILD, no se leen en
 * runtime. Cambiar el valor en el panel de Vercel y REDESPLEGAR EL MISMO ARTEFACTO **no cambia
 * nada**: hay que REBUILDEAR. Este ecosistema ya perdió una tarde con esa exacta confusión, y el
 * síntoma es el peor posible — un despliegue que reporta éxito y no despliega el cambio.
 *
 * ⛔ Y AL REVÉS TAMBIÉN: una `NEXT_PUBLIC_` AUSENTE en el momento del build queda ausente en el
 * bundle para siempre, aunque después aparezca en el panel. La bandera se despliega APAGADA a
 * propósito (`CD-W1-14`); prenderla es una ola aparte, con su propia medición en teléfono.
 */
export function recorridoV2Enabled(): boolean {
  return process.env.NEXT_PUBLIC_CHASKI_RECORRIDO_V2 === "true";
}
