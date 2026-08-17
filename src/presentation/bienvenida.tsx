"use client";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { resolveSolanaNetworkConfig } from "../infrastructure/chain";
import { Aviso, Button, Card, Muted } from "./ui";

/**
 * WKH-063 / AC-1 · LA PRIMERA PANTALLA, que hasta esta HU no existía.
 *
 * 🔴 QUÉ DEFECTO CIERRA. La app abría DIRECTO en el formulario: lo primero que la persona veía era
 * "Paso 1 de 4" y una entrada de monto, sin una línea sobre qué es esto ni por qué darle una wallet.
 * En una app de remesas el primer trabajo de la primera pantalla no es cotizar: es contestar "¿por qué
 * te confío mi plata?" en cinco segundos.
 *
 * ⛔ Y LO QUE ESTA PANTALLA NO PUEDE HACER ES PEDIR QUE LE CREAN. Las tres frases están elegidas para
 * que ninguna sea una promesa sobre plata ajena:
 *   · "Tu plata no pasa por Chaski" — es DÓNDE quedan los USDC, que es un hecho verificable, y no
 *     "Chaski nunca toca tu plata", que es un absoluto falsable: el escrow tiene una
 *     release-authority operada por el equipo. Es la misma frase que el paso `connect` ya sostenía
 *     (y sigue sosteniendo: acá no se movió de allá, se dice también acá).
 *   · "Chaski nunca los tiene en una cuenta propia" — el límite concreto: los USDC quedan en una
 *     cuenta del contrato, nunca en una billetera de Chaski.
 *   · "no hace falta creernos" — lo más fuerte de la pantalla, y lo es porque NO afirma que seamos
 *     confiables: señala dónde ir a comprobarlo. ⛔ No se reemplaza por una frase que afirme
 *     confianza; eso convertiría la única línea honesta en marketing.
 *
 * ⛔ NO HAY MONTO NI TASA ACÁ (AC-1), y no es por prolijidad: una cifra en esta pantalla sería una
 * cotización que nadie pidió y que caduca. La cifra aparece cuando la persona pone su monto.
 *
 * ⛔ Y NO HAY NADA SOBRE RECUPERAR LOS FONDOS. Es cierto que se pueden recuperar, pero recién pasadas
 * las horas de la ventana de custodia, y esa condición no cabe en una tarjeta de bienvenida sin
 * volverse una promesa a medias. Vive en el flujo y en el destino "Recuperar", donde está escrita con
 * su condición al lado.
 *
 * AC-8 · UNA sola acción resolutiva, y va `primary`: es la que saca a la persona de esta pantalla.
 * La barra de destinos que se pinta debajo NO compite (son `<button>` planos, no `<Button>`).
 *
 * ── 🔴 SEGUNDO PASE (composición vertical) ──────────────────────────────────────────────────────
 *
 * QUÉ ESTABA MAL, MEDIDO SOBRE EL BUILD DE PRODUCCIÓN en un Pixel 7 (412x915, Chrome headless):
 * el CTA terminaba en 433px y la barra empezaba en 814px, o sea **381px de vacío, el 42% del
 * viewport**. Todo el contenido vivía en el tercio de arriba y abajo no había nada. Un vacío de ese
 * tamaño no se lee como aire: se lee como pantalla sin terminar, que es exactamente lo contrario de
 * lo que esta HU vino a lograr. No le faltaba contenido: le faltaba composición.
 *
 * LAS TRES COSAS QUE SE HICIERON, y por qué cada una:
 *
 * 1. EL BLOQUE SE CENTRA EN EL ESPACIO DISPONIBLE en vez de quedar anclado arriba
 *    (`flex flex-1 flex-col justify-center`).
 *    🔴 Y ACÁ HAY UNA MEDICIÓN QUE VALE MÁS QUE EL ARREGLO, porque la primera versión de esta línea
 *    decía `min-h-full` y era una clase MUERTA. El envoltorio de la pantalla es hijo del `motion.div`
 *    de `flow.tsx`, que era `flex-1` a secas: un ítem flex, no un contenedor flex. Contra eso, un
 *    porcentaje de altura no resuelve. Medido en el navegador, sobre el build de producción a
 *    412x915, poniendo las cuatro variantes por DOM y midiendo cada una:
 *        `min-height:100%`  ⇒ el hijo midió 644px dentro de un padre de 728px  (no hizo NADA)
 *        `height:100%`      ⇒ 644px                                            (tampoco)
 *        sin nada           ⇒ 644px                                            (idéntico: la prueba)
 *        padre `flex-col` + hijo `flex-grow:1` ⇒ 728px                          (el único que estira)
 *    O sea: `min-h-full` compilaba, pasaba el `tsc`, se veía exactamente igual y no producía ningún
 *    efecto. Es el modo de falla que este repo ya tiene escrito para un `rounded-xl2` olvidado, y la
 *    única razón por la que no se fue a producción es que la medición de píxeles se hizo DESPUÉS de
 *    escribir la clase y no en vez de.
 *    El arreglo son dos mitades y ninguna sirve sola: el padre gana `flex flex-col` (una edición de
 *    línea neutra en `flow.tsx`, para no correr sus 74 citas) y acá se pide `flex-1`.
 *    ⚠️ `flex-1` NO PUEDE RECORTAR EL CONTENIDO, y por eso `justify-center` es seguro incluso en un
 *    teléfono corto: un ítem de una columna flex tiene `min-height:auto`, así que nunca baja de su
 *    contenido; cuando el contenido no cabe, el `<main>` crece (es `min-h-dvh`, no `h-dvh`), la página
 *    scrollea y `justify-center` se queda sin sobrante que repartir. Y no es un razonamiento: medido a
 *    375x667, el documento midió 853px (nada se recortó) y el `send` que sigue midió 856px, o sea que
 *    donde esta pantalla scrollea el formulario ya scrolleaba, y por más. Las tres mediciones están en
 *    el encabezado de `bienvenida-composicion.test.tsx`.
 *
 * 2. UN BLOQUE NUEVO QUE SE GANA SU LUGAR: los tres pasos de lo que va a pasar (`PASOS`). No es
 *    relleno y la diferencia es testeable: cada uno de los tres describe un tramo que el flujo
 *    REALMENTE tiene, y el candado los EJECUTA en vez de asertar que el texto exista (es la lección
 *    que el auto-blindaje de esta misma HU ya dejó escrita: un test que verifica que el copy existe
 *    no se rompe cuando el copy se vuelve falso). Si mañana alguien saca el paso de identidad del
 *    recorrido, el segundo renglón de esta pantalla pasa a ser mentira y el test se pone rojo.
 *    ⛔ NO HAY NINGÚN NÚMERO INVENTADO acá, y no es un detalle de estilo: "10.000 envíos" o "4,9
 *    estrellas" son exactamente el tipo de relleno que convertiría la única pantalla honesta de la
 *    app en marketing. Lo que hay son tres hechos sobre el recorrido, y un nombre de red.
 *
 * 3. LA RED, DICHA CON SU NOMBRE, al pie y en peso menor. Es lo que hace ACCIONABLE a la frase de
 *    verificación de arriba: "abrilo en el explorador" no sirve si no se sabe en qué red mirar. Sale
 *    de `resolveSolanaNetworkConfig()`, el mismo resolver que el paso `connect` ya usa
 *    (`resolveSolanaNetworkConfig`, `flow.tsx:959`), así que la pantalla no puede nombrar una red
 *    distinta de la que va a firmar. Y va DEBAJO del CTA por el mismo criterio que AC-6 fijó para la
 *    frase de custodia de `connect`: una nota de honestidad no se pone donde tape la acción.
 *
 * ⛔ LO QUE **NO** SE HIZO, Y ES DELIBERADO: agrandar el titular. La escala de S-1 es cerrada y entre
 * `title` (17px) y `money` (32px) no hay nada, y `money` es el rol de LA CIFRA — su propio docblock
 * dice que es "el único rol que tiene derecho a ser grande". Escribir un titular con el rol del monto
 * es justo la inversión que S-1 existe para delatar, y agregar un séptimo rol al tema es un cambio del
 * sistema de diseño, no un arreglo de composición. El aire se consiguió donde sí está en la escala:
 * `aire` (24px) entre las SECCIONES de la pantalla, que es literalmente para lo que el token está
 * declarado, mientras adentro de cada tarjeta se mantiene `holgado` (16px), que es el suyo.
 *
 * MEDIDO DESPUÉS, mismo instrumento y mismo viewport, y los números completos (más los de tres
 * teléfonos distintos y los siete mutantes corridos) están en el encabezado de
 * `bienvenida-composicion.test.tsx`, que es el archivo que congela estas decisiones. El resumen: el
 * vacío pasó de **381px (42%) a 70px (8%)** entre el CTA y la barra, y a 42px (5%) contando desde el
 * final real del contenido.
 */

/**
 * Los tres tramos del envío, en el orden en que la persona los va a vivir.
 *
 * ⛔ CADA RENGLÓN ES UN HECHO SOBRE EL RECORRIDO, Y SE VERIFICA CORRIÉNDOLO. El candado no busca estas
 * frases en la pantalla: camina el flujo real y comprueba que el tramo que cada una anuncia existe
 * (`PASOS_ESPERADOS`, `bienvenida-composicion.test.tsx:133`). Por eso están escritas en términos de lo
 * que la app HACE y no de lo que se siente:
 *   · el 1 nombra los dos datos que el paso `send` pide (el monto y el CCI);
 *   · el 2 nombra la verificación de identidad y la firma, que son `verify` y `confirm`, y dice "una
 *     sola vez" porque es lo que el propio paso ya afirma ("Verificación única", `flow.tsx:1002`);
 *   · el 3 dice que se SIGUE el envío y que su estado está a la vista. ⛔ NO dice que el dinero
 *     llegue, ni cuándo: este repo ya borró un "llega en ~30 min" por prometer una entrega que el
 *     sistema no controla (la release del vault la dispara una persona), y `honest-copy.test.tsx`
 *     tiene un candado por cada mitad de esa frase.
 *     ⚠️ Y TAMPOCO DICE "con la transacción de Solana a la vista", que es lo que decía la primera
 *     versión de este renglón. Se cayó al escribirle la sonda, no al revisarlo: la fila "Depósito en
 *     Solana" del seguimiento existe SÓLO si hay un `principalTx`, o sea que en la rama donde el
 *     depósito no llegó a firmarse la frase era falsa. Lo verificable en TODAS las ramas es que el
 *     seguimiento existe y dice en qué estado está el envío. La verificabilidad en cadena ya la
 *     sostiene el aviso de arriba, y decirla dos veces con una mitad condicional debilitaba las dos.
 */
const PASOS = [
  "Ponés cuánto querés enviar y el CCI de la cuenta en Perú.",
  "Verificás tu identidad una sola vez y firmás el envío desde tu billetera.",
  "Seguís el envío desde la app, con su estado a la vista.",
] as const;

export function Bienvenida({ onEmpezar, disabled }: { onEmpezar: () => void; disabled?: boolean }) {
  return (
    <div className="flex flex-1 flex-col justify-center space-y-aire">
      <Card className="space-y-holgado text-center">
        {/* `h-14 w-14` no es un tamaño de ícono y por eso no está en la escala de S-4: es el círculo
            que lo CONTIENE. Es la MISMA receta que el paso `connect` ya pinta, y se reusa tal cual
            para que las dos pantallas de "acá se habla de tu plata" abran igual. */}
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-sand">
          <ShieldCheck className="size-icono-md text-cochineal" />
        </div>
        <div>
          <h2 className="text-title font-bold">Tu plata no pasa por Chaski</h2>
          <Muted className="mx-auto mt-ajustado max-w-xs">
            Cuando enviás, tus USDC quedan en un contrato en Solana. Chaski nunca los tiene en una
            cuenta propia.
          </Muted>
        </div>
        {/* `neutro` y no `bueno`: el verde de la app es el del dinero que llega, y acá no llegó nada
            todavía. Pintar de verde una afirmación sobre custodia la vestiría de buena noticia. */}
        <Aviso className="text-left">
          <Muted escala="label">
            Y no hace falta creernos: cada envío deja una transacción que podés abrir en el explorador
            de Solana.
          </Muted>
        </Aviso>
      </Card>

      {/* El bloque nuevo del segundo pase. Va en `<Card>` y no en una superficie propia: una tarjeta
          escrita a mano acá sería una segunda definición del mismo borde, radio y sombra, y el
          criterio de S-4 ya decidió que lo que apoya sobre el fondo de la pantalla es `caja`. */}
      <Card className="space-y-holgado">
        {/* ⚠️ ES UN `<h2>` Y SE VE MÁS CHICO QUE EL TITULAR, y las dos mitades son a propósito.
            NIVEL: `titulos.test.tsx` exige que ningún encabezado de esta pantalla pase de 2 (recorre
            los niveles renderizados y assertea `n <= 2`), así que un `<h3>`, que sería el nivel
            "natural" de un bloque dentro de una pantalla que ya tiene su `<h2>`, pondría rojo un
            candado que esta HU no puede romper.
            TAMAÑO: el rol `body` y no `title`, porque dos `title` en negrita en la misma pantalla
            compiten y la jerarquía visual se aplana. El nivel es semántica (una parada para quien
            navega por encabezados); el tamaño es composición. Son dos decisiones distintas y acá se
            toman distinto. Precedente del mismo repo: "Verificación única" (`flow.tsx:1002`). */}
        <h2 className="text-body font-semibold">Cómo funciona</h2>
        {/* Un `<ol>` de verdad: son pasos EN ORDEN, y el orden es el contenido. `@tailwind base`
            (preflight) ya le saca el marcador y el padding, así que el número visible es el `<span>`
            de abajo y no hay doble numeración. */}
        <ol className="space-y-normal">
          {PASOS.map((paso, i) => (
            <li key={paso} className="flex gap-normal">
              {/* `cochineal-ink` (#9E1C40) y no `cochineal` (#CB2A54): a 13px es texto NORMAL para
                  WCAG y el segundo da 5,25:1 contra el blanco de la tarjeta contra 7,46:1 del
                  primero. Los dos pasan AA, pero la lección de `ghost` en `ui.tsx` ya costó una
                  ronda: cuando hay dos tonos de la marca y uno es texto chico, se usa el oscuro. */}
              <span className="text-support font-bold text-cochineal-ink">{i + 1}</span>
              <Muted className="flex-1">{paso}</Muted>
            </li>
          ))}
        </ol>
      </Card>

      {/* El CTA y su nota al pie son UNA sección, así que van juntos y con `normal` entre ellos: la
          nota habla del botón que está arriba, no es una tercera sección de la pantalla. */}
      <div className="space-y-normal">
        <Button disabled={disabled} onClick={onEmpezar}>
          Empezar un envío <ArrowRight className="size-icono-sm" />
        </Button>
        <Muted escala="label" className="text-center">
          El contrato que guarda tus USDC corre en Solana {resolveSolanaNetworkConfig().cluster}.
        </Muted>
      </div>
    </div>
  );
}
