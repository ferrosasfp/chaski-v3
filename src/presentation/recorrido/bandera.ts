// WKH-374 · W1.0 — EL INTERRUPTOR DEL RECORRIDO NUEVO
//
// ⚠️ Este archivo es casi todo prosa, y está declarado de antemano en el presupuesto de la ola. ⛔ No
// se lo baje más: lo que ocupa el espacio es el gotcha de despliegue, que es lo único que separa
// «prendí la bandera» de «prendí la bandera y no pasó nada».

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
 * 🔴 QUÉ GATEA Y QUÉ NO: elige cuál de los dos árboles monta `app/page.tsx`, y nada más. Con la
 * bandera APAGADA el árbol nuevo NO SE EJECUTA ⇒ ningún número medido sobre él sale de producción.
 * Lo que sí queda afirmado es lo simétrico y más chico, y lo mide `T-374-W1-10`: apagada, la página
 * monta el árbol de HOY byte por byte.
 *
 * ⚠️ GOTCHA DE DESPLIEGUE: hay que REBUILDEAR. Cambiar el valor en el panel de Vercel y REDESPLEGAR
 * EL MISMO ARTEFACTO **no cambia nada**, y el síntoma es el peor posible: un despliegue que reporta
 * éxito y no despliega el cambio.
 *
 * 🔴 Y ACÁ VA UNA CORRECCIÓN DE MI PROPIA EVIDENCIA, QUE VALE MÁS QUE LA CONCLUSIÓN (fix-pack ·
 * AR/MNR-2). Este bloque decía que el motivo era el mismo que el de `mwaEnabled`: *«las
 * `NEXT_PUBLIC_` las inlinea el BUILD»* y *«una ausente queda ausente en el bundle para siempre»*.
 * **ESO NO APLICA A ESTA BANDERA**, y el AR lo midió sobre el artefacto: el inlineado es del bundle
 * de CLIENTE, y el único llamador de esta función es `app/page.tsx`, que ⛔ NO lleva `"use client"`
 * ⇒ la lectura queda VIVA en el bundle de servidor. Con el motivo falso escrito acá, el día que
 * alguien lo siga va a concluir cosas que no valen.
 *
 * 🔴 EL MOTIVO VERDADERO, Y ES OTRO: `/` se PRERENDERIZA ESTÁTICA. La bandera se evalúa una vez, en
 * el build, y el HTML que se sirve ya trae el árbol elegido. Por eso hay que rebuildear.
 *
 * ⚠️ RIESGO DEL MOTIVO FALSO, dicho para que no se pierda: el día que `/` deje de ser estática (un
 * `cookies()`, un `dynamic = "force-dynamic"`, cualquier cosa que la vuelva dinámica), un cambio en
 * el panel prende el recorrido ENTERO sin rebuild, porque la lectura sigue viva del lado del
 * servidor. El docblock viejo decía que eso no podía pasar. **Sí puede.**
 *
 * La bandera se despliega APAGADA a propósito (`CD-W1-14`); prenderla es una ola aparte, con su
 * propia medición en teléfono.
 */
export function recorridoV2Enabled(): boolean {
  return process.env.NEXT_PUBLIC_CHASKI_RECORRIDO_V2 === "true";
}
