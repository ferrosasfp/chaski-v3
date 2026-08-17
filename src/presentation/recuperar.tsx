"use client";
import type { ReactNode } from "react";
import { resolveSolanaNetworkConfig } from "../infrastructure/chain";
import { Aviso, Card, Muted } from "./ui";

/**
 * WKH-063 · EL DESTINO "RECUPERAR": la carcasa de las dos puertas que preguntan a la cadena.
 *
 * 🔴 POR QUÉ ES UNA CARCASA Y NO UN COMPONENTE QUE LAS MONTA. `LostEscrowRecovery` y
 * `EscrowRentRecovery` viven en `flow.tsx`; importarlas desde acá crearía un ciclo con el import que
 * `flow.tsx` hace de este archivo. Reciben su cableado (gateways, `resolveSender`) del mismo lugar de
 * siempre y entran por `children`: lo que esta HU cambia es DESDE DÓNDE se montan, nunca su lógica.
 *
 * DE DÓNDE VIENEN. Estaban al pie del formulario de envío, en un grupo titulado "¿Ya enviaste
 * antes?", donde salían con la misma métrica que el CTA del camino feliz. Un formulario con un botón
 * y tres puertas de rescate abajo se lee como una lista de opciones equivalentes. Acá las dos tienen
 * su propia pantalla, y el pie del formulario quedó con una sola cosa que hacer.
 *
 * ⛔ AC-8 · ESTA PANTALLA NO TIENE `primary`, y es un veredicto escrito, no un olvido: las dos puertas
 * ABREN UNA BÚSQUEDA en la cadena, no sacan a la persona de acá. Lo que resuelve —el refund, el
 * cierre de cuentas— aparece DESPUÉS de que la cadena contestó, adentro de cada componente, y ahí sí
 * cada uno decide su propia jerarquía. Si alguien decide que abrir la búsqueda ya es resolver, tiene
 * que venir a cambiar la fila de `jerarquia-relativa.test.tsx` y decir por qué.
 *   ⚠️ EL SEGUNDO PASE NO CAMBIÓ ESE VEREDICTO Y TAMPOCO LE AGREGÓ UNA ACCIÓN NUEVA, y eso fue una
 *   decisión y no una omisión: el candidato obvio para llenar espacio era un botón "Ver mis envíos"
 *   acá, y habría hecho DOS daños a la vez. Sería navegación duplicada (la barra ya tiene esa
 *   pestaña, y AC-4 pide que las pestañas sean los destinos) y sería una acción que SÍ saca a la
 *   persona de esta pantalla, o sea que la fila de `jerarquia-relativa.test.tsx` pasaría a
 *   `resolutiva: true` y esta pantalla necesitaría un `primary`. Se resolvió la composición sin
 *   tocar la jerarquía.
 *
 * ⛔ Y NO SE REPITE LO QUE CADA PUERTA YA EXPLICA (el plazo de la ventana de custodia, las firmas que
 * pide la billetera, el tope de la ventana de búsqueda). Cada una de esas frases pasó su propio
 * barrido de honestidad en su propio sitio; una segunda versión acá arriba es la forma en que una de
 * las dos queda vieja.
 *
 * ── 🔴 SEGUNDO PASE (composición vertical) ──────────────────────────────────────────────────────
 *
 * QUÉ ESTABA MAL, MEDIDO SOBRE EL BUILD DE PRODUCCIÓN a 412x915 (un Pixel 7, Chrome headless): el
 * contenido terminaba en 345px, la barra empezaba en 814px, o sea **469px de hueco, el 51% del
 * viewport**. Es el MISMO defecto que el primer pase le cerró a la bienvenida (381px / 42%) y acá era
 * peor: la mitad de la pantalla era nada. El primer pase lo midió y lo dejó abierto porque vivía en
 * otro archivo.
 *
 * ⛔ Y LA GRAMÁTICA DE LA BIENVENIDA NO SE COPIÓ ENTERA, porque este destino no es una bienvenida: es
 * un lugar al que se llega cuando algo salió mal. Allá la pregunta era "¿por qué te creo?" y se
 * contesta con una afirmación de custodia; acá la pregunta es **"¿qué puedo recuperar, y cómo?"**, y
 * eso no se contesta con más confianza sino con información que se pueda usar. Lo que sí se reusa es
 * lo estructural: el bloque se centra en el alto disponible y la nota de contexto va al pie.
 *
 * LAS CUATRO COSAS QUE SE HICIERON, y por qué ninguna es relleno. La regla que las decidió: sólo entra
 * lo que contesta "qué puedo recuperar" o "cómo", y nada que ya esté dicho adentro de una puerta.
 *
 * 1. LAS DOS PUERTAS DEJARON DE SER DOS ENLACES CIEGOS. Cada una era una línea subrayada con su
 *    nombre y nada más, así que para saber cuál era la tuya había que ABRIR una y leerla. Ahora cada
 *    una lleva debajo el renglón de `QUE_RECUPERA`, y lo que dice es la única diferencia que permite
 *    elegir sin clickear: **una busca USDC y la otra busca SOL**. Eso no es copy decorativa; es el
 *    dato que faltaba, y su candado no lo lee: ABRE cada puerta y comprueba que adentro se hable de
 *    la moneda que el renglón anunció (`T-063-13`).
 *    ⛔ Los dos renglones NO VIVEN en `flow.tsx` con las puertas: viven acá, juntos, porque el riesgo
 *    editorial de este bloque es que los dos digan lo mismo, y eso sólo se ve si se leen uno al lado
 *    del otro. Separados por 150 líneas de un archivo de 3843, nadie los compara.
 *
 * 2. EL PIE DICE CON QUÉ CUENTA SE BUSCA. Es la precondición que decide si las dos puertas pueden
 *    funcionar —las dos resuelven por `sender` (`resolveSender`, `flow.tsx:396`), que le pregunta a la
 *    billetera VIVA en cada búsqueda— y no estaba dicha en ninguna de las dos, ni abierta ni cerrada.
 *    Es también la causa #1 de un "no encontré nada" que no significa "no tenés nada": buscar con la
 *    cuenta B los envíos que firmó la A. El copy de la cadena ya manda gente acá justamente por eso
 *    (`escrowOutcomeDisplay`, `flow-vm.ts:1253`). Su candado tampoco lo lee: CAMBIA la cuenta
 *    conectada entre dos búsquedas y comprueba con qué `sender` sale cada una (`T-063-14`).
 *
 * 3. LA TERCERA FORMA DE RECUPERAR, QUE NO ES NINGUNA DE LAS DOS PUERTAS: el envío que la app SÍ
 *    conoce se recupera desde su propia pantalla, entrando por "Mis envíos". Sin eso, quien llega acá
 *    con un envío que está en su historial lee dos búsquedas en la cadena que no son su caso, y la
 *    pantalla es un callejón sin salida. Es lo que más faltaba de las cuatro, y no lo dice ninguna
 *    puerta: la primera explica por qué ELLA cubre los envíos que el dispositivo NO conoce, y eso no le
 *    dice a nadie qué hacer cuando sí los conoce. Su candado CAMINA el consejo hasta el botón
 *    (`T-063-15`), que es la lección que el auto-blindaje de esta HU ya dejó escrita.
 *
 * 4. LA RED, DICHA CON SU NOMBRE, igual que en la bienvenida y por una razón más fuerte que allá: en
 *    esta pantalla la persona puede querer ir a mirar sus cuentas al explorador por su cuenta, y el
 *    explorador pide el cluster en la URL (`resolveSolanaExplorerTxUrl`, `chain.ts:224`). Sale del
 *    mismo resolver que firma, así que la pantalla no puede nombrar una red distinta de la real.
 *
 * ⛔ LO QUE **NO** SE HIZO, Y ES LO QUE MÁS SE PARECÍA A UN ARREGLO: rellenar. El hueco restante NO se
 * cerró con un ícono grande de arribo (la pestaña activa ya lleva el mismo `LifeBuoy` y su
 * `aria-current`, así que un segundo salvavidas 100px más arriba no informa nada), ni con una caja de
 * confianza como la de la bienvenida (todas las frases candidatas —qué firma la billetera, qué pasa
 * si no encontramos nada, el plazo de la ventana— ya están escritas ADENTRO de las puertas, y
 * repetirlas es la forma en que una de las dos copias queda vieja), ni agrandando paddings.
 *
 * MEDIDO DESPUÉS, mismo instrumento y mismos tres teléfonos: los números completos, la definición
 * exacta de "hueco" y los mutantes corridos están en el encabezado de `recuperar-composicion.test.tsx`.
 * El resumen a 412x915: el hueco más grande de la columna pasó de **469px (51%) a 79px (9%)**, y dejó
 * de estar todo abajo — el bloque quedó centrado, con esos mismos 79px arriba y abajo. A 390x844 quedó
 * en 36px (4%) y a 375x667 en 24px (4%).
 */

/**
 * Qué busca cada puerta, en UNA línea y en el idioma de la persona.
 *
 * 🔴 LA DIFERENCIA QUE TIENEN QUE DEJAR CLARA ES LA MONEDA, y por eso las dos frases arrancan con
 * ella. Es la única distinción que permite elegir sin abrir: una puerta busca los USDC de un envío que
 * no se completó, la otra busca el SOL que la red retiene por las cuentas de un envío que SÍ terminó.
 * Escritas al revés, la persona abre la que no es y lee tres párrafos para descubrirlo.
 *
 * ⛔ NINGUNA DICE "DEVUELVE", Y NO ES UN MATIZ DE ESTILO. Las dos puertas pueden no encontrar nada, y
 * aun encontrando, la orden puede quedar sin confirmar: este repo ya tiene la regla escrita en
 * `RefundSentNotice` ("Enviamos la orden", NUNCA "volvieron"). El verbo es `busca`, que es lo que la
 * puerta hace cuando la tocás; lo que pase después lo cuenta cada una con su propio desenlace.
 *
 * ⛔ Y NINGUNA DE LAS DOS NOMBRA UN PLAZO, UNA CANTIDAD DE ENVÍOS NI UNA COMISIÓN. Los tres existen y
 * los tres están dichos adentro de la puerta correspondiente, con su condición al lado; acá arriba
 * serían una segunda copia sin condición, que es exactamente lo que el docblock de este archivo
 * prohíbe.
 *
 * El candado (`T-063-13`) no compara estas cadenas con la pantalla: abre cada puerta y comprueba que
 * lo que hay adentro hable de la moneda que el renglón anunció. Si mañana alguien intercambia los dos
 * renglones, el test se pone rojo aunque las dos frases sigan existiendo letra por letra.
 */
export const QUE_RECUPERA = {
  envioPerdido: "Busca USDC: los de un envío que no llegó a completarse y pueden seguir en el contrato.",
  depositoDeRed:
    "Busca SOL: el depósito que la red retiene por las cuentas de un envío, y que sólo se libera cerrándolas cuando ese envío ya terminó.",
} as const;

export function DestinoRecuperar({ children }: { children: ReactNode }) {
  return (
    // `flex flex-1 flex-col justify-center` — la MISMA receta que `Bienvenida`, y por la misma razón
    // medida: el padre (`motion.div` de `flow.tsx`) es `flex flex-col`, así que un hijo que pide
    // `flex-1` se estira al alto sobrante y `justify-center` reparte el resto arriba y abajo.
    // ⛔ NO SE USA `min-h-full` NI `h-full`: en este layout las dos son clases INERTES, medido en el
    // navegador — dan el MISMO alto que no poner nada (el detalle, con la tabla de las cuatro
    // variantes, está en el auto-blindaje de esta HU y en `bienvenida-composicion.test.tsx`).
    // ⚠️ `justify-center` no puede recortar nada: un ítem de una columna flex tiene `min-height:auto`,
    // así que nunca baja de su contenido; cuando el contenido no cabe, el `<main>` crece (es
    // `min-h-dvh`) y el sobrante que repartir es cero. Medido a 375x667, donde esta pantalla ya no
    // cabe: el documento midió 811px, menos que los 834px que el formulario ya medía ahí y menos que
    // los 853px de la bienvenida.
    <div className="flex flex-1 flex-col justify-center space-y-aire">
      <div>
        <h2 className="text-title font-bold">Recuperar fondos de un envío anterior</h2>
        {/* Este renglón dice qué es ESTE LUGAR, a un nivel arriba de las dos puertas: cada una
            declara su propio caso en su propio renglón de `QUE_RECUPERA`. Antes decía "Si un envío no
            llegó a completarse, tus USDC pueden seguir en el contrato", que es exactamente el caso de
            UNA de las dos puertas: escrito así, la cabecera de la pantalla anunciaba la mitad de lo
            que la pantalla ofrece. */}
        <Muted className="mt-ajustado">
          Lo que quedó tuyo en un envío anterior sigue en Solana. Desde acá se lo preguntamos a la
          cadena con tu billetera.
        </Muted>
      </div>
      {/* Las dos puertas separadas por una línea y no por aire: son dos preguntas distintas a la
          misma cadena (una busca escrows ABIERTOS, la otra cuentas de envíos ya TERMINADOS), y la
          línea dice que no son dos pasos de lo mismo. */}
      <Card className="divide-y divide-line">{children}</Card>
      {/* 🔴 LA TERCERA FORMA DE RECUPERAR, que es la que esta pantalla no nombraba y NO es ninguna de
          las dos puertas: el envío que la app SÍ conoce se recupera desde su propia pantalla, a la que
          se llega por "Mis envíos" (`RefundAction`, `flow.tsx:1938`). Sin este renglón, quien llega acá
          con un envío que está en su historial lee dos búsquedas en la cadena que no son su caso y la
          pantalla es un callejón. ⛔ No lo dice ninguna de las dos puertas: la de al lado explica por
          qué ELLA cubre los envíos que el dispositivo NO conoce, y eso no le dice a nadie qué hacer
          cuando sí los conoce.
          ⚠️ VA EN FORMA CONDICIONAL Y NO AFIRMATIVA, y la condición es real: la opción de recuperar de
          la pantalla del envío está gateada (`showRefund && recover && sender`), así que "cada envío
          tiene su recuperación" sería falso para uno ya entregado. Por eso dice "si sus USDC se pueden
          recuperar". El candado NO comprueba que esta frase exista: CAMINA el consejo desde acá hasta
          el botón (`T-063-15`), que es la lección que el auto-blindaje de esta HU ya dejó escrita —
          un copy que nombra un lugar se rompe cuando el lugar cambia, y sólo lo nota quien lo recorre.
          ⛔ Y ES PROSA, NO UN BOTÓN: un "Ver mis envíos" acá duplicaría la pestaña de la barra y
          convertiría esta pantalla en `resolutiva` (ver el docblock de arriba). */}
      <Aviso>
        <Muted escala="label">
          ¿El envío te aparece en "Mis envíos"? Abrilo desde ahí: la pantalla del envío dice en qué
          estado quedó, y si sus USDC se pueden recuperar la opción está en esa misma pantalla.
        </Muted>
      </Aviso>
      {/* Las dos notas del pie van juntas y en `escala="label"`, con el mismo criterio que la nota de
          la red de la bienvenida: una nota de contexto no se pone donde tape lo que hay que hacer.
          ⚠️ NINGUNA DE LAS DOS DICE "LAS DOS BÚSQUEDAS", en singular a propósito: cada puerta devuelve
          `null` si su gateway no está cableado, así que esta carcasa no puede afirmar cuántas hay. */}
      <div className="space-y-ajustado">
        <Muted escala="label">
          La búsqueda usa la cuenta que tengas conectada en tu billetera. Si el envío lo hiciste desde
          otra, cambiala ahí antes de buscar.
        </Muted>
        <Muted escala="label">
          Las cuentas de tus envíos viven en Solana {resolveSolanaNetworkConfig().cluster}.
        </Muted>
      </div>
    </div>
  );
}
