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
 *    línea neutra en `flow.tsx`, para no correr las citas por número que recibe — el número y su definición viven en UN solo lugar, el comentario de su línea 44; acá decía "74", copiado de allá cuando allá ya era falso, y esa copia es el antipatrón que el auto-blindaje de esta HU prohíbe) y acá se pide `flex-1`.
 *    ⚠️ `flex-1` NO PUEDE RECORTAR EL CONTENIDO, y por eso `justify-center` es seguro incluso en un
 *    teléfono corto. El mecanismo: un ítem de una columna flex tiene `min-height:auto`, así que nunca
 *    baja de su contenido; cuando el contenido no cabe, el `<main>` crece (es `min-h-dvh`, no `h-dvh`),
 *    la página scrollea y `justify-center` se queda sin sobrante que repartir.
 *    Y ESTO ES LO QUE LO MIDE, no un razonamiento: a 375x667 el documento crece a **870px** contra un
 *    viewport de 667 —o sea que la pantalla scrollea— y la tinta va de **24px a 830px**, entera adentro
 *    del documento. Nada quedó afuera ni con altura negativa: si `justify-center` recortara, el
 *    contenido arrancaría por encima de 0.
 *    🔴 Y ACÁ SE CAYÓ EL ARGUMENTO COMPARATIVO QUE ESTA LÍNEA TENÍA, POR CULPA DE OTRO ARREGLO DE ESTE
 *    MISMO FIX-PACK. Decía *"el `send` que sigue midió 856px, o sea que donde esta pantalla scrollea el
 *    formulario ya scrolleaba, y por más"*, y eso **ya es falso**: alargar la frase del `<Aviso>` para
 *    condicionarla (AR/BLQ-BAJO-2) le sumó un renglón a la tarjeta, y el documento de esta pantalla pasó
 *    de 853px a **870px**. A 375x667 la bienvenida es hoy **la MÁS ALTA de las tres** (870 · send 856 ·
 *    recuperar 811). Lo que sostiene la decisión es el mecanismo de arriba, que no depende de ninguna
 *    comparación; el número comparativo era corroboración secundaria y se retira en vez de conservarse.
 *    ⚠️ Y EL 856 DEL `send` SE RE-MIDIÓ IGUAL, porque un CR lo puso en duda con razón: el árbol tenía
 *    DOS valores para lo mismo (856 acá; 834 en los dos archivos de `recuperar`). Medido de nuevo sobre
 *    el build de producción con la calibración del viewport verificada: **856px**. El par equivocado era
 *    el de `recuperar` y se corrigió allá — pero el 856 correcto ya no alcanza para el argumento viejo,
 *    porque el que se movió fue el otro lado de la comparación. Las nueve mediciones están en el
 *    encabezado de `bienvenida-composicion.test.tsx`.
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
 *    (`resolveSolanaNetworkConfig`, `flow.tsx:959`), así que las dos pantallas dicen SIEMPRE lo mismo.
 *    🔴 PERO ACÁ DECÍA "la pantalla no puede nombrar una red distinta de la que va a firmar", Y ESO ES
 *    FALSO COMO IMPOSIBILIDAD (fix-pack, AR/MNR-2). El nombre que se pinta es un LITERAL del código
 *    (`cluster: "devnet"`, `chain.ts:8` y `:18`), y el endpoint contra el que se firma sale de
 *    `NEXT_PUBLIC_SOLANA_RPC_URL` (`resolveSolanaRpcUrlPublic`, `chain.ts:190`) SIN ninguna validación
 *    cruzada contra ese literal. Nada en el código impide que el env apunte a mainnet mientras la
 *    pantalla sigue diciendo "devnet". El repo ya lo tenía medido y escrito en otro lado:
 *    `flow-vm.ts:1224` lista "una `NEXT_PUBLIC_SOLANA_RPC_URL` mal apuntada" como uno de sus cuatro
 *    disparadores reales, "que es hoy y sin desplegar código".
 *    ✅ LO QUE SÍ ES CIERTO, y es lo que se afirma ahora: la copia coincide con la red real mientras el
 *    env no la contradiga. Medido en este worktree (2026-08-17): `NEXT_PUBLIC_SOLANA_RPC_URL` no está
 *    seteada, así que `resolveSolanaRpcUrlPublic` cae al `clusterApiUrl(cluster)` derivado del MISMO
 *    literal y las dos no pueden divergir. En un deploy donde la env sí está seteada, nadie las cruza.
 *    ⛔ No se agrega la validación cruzada acá: es un cambio de `chain.ts` con su propio candado, y el
 *    cutover a mainnet que `resolveSolanaNetworkId` (`chain.ts:32`) tiene escrito como pendiente es
 *    quien tiene que traerla. Lo que este fix-pack arregla es la FRASE, que apagaba esa revisión.
 *    Y va DEBAJO del CTA por el mismo criterio que AC-6 fijó para la frase de custodia de `connect`:
 *    una nota de honestidad no se pone donde tape la acción.
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
 *
 * ⛔ ESAS DOS CIFRAS SALEN DEL INSTRUMENTO v2, QUE SE GANA SIN ARREGLAR NADA (basta una nota al pie con
 * `mt-auto`), y el fix-pack lo dejó dicho acá porque hasta entonces sólo estaba dicho en el archivo de
 * `recuperar`. La medida que sí se puede comparar entre pantallas es el salto máximo entre bandas de
 * tinta (v3), y NUNCA se había corrido sobre esta pantalla. Corrido el 2026-08-17: **58px (6%) a
 * 412x915**, y el peor hueco está ARRIBA (entre el header y la primera tarjeta, 62→120), no abajo. Con
 * ese mismo instrumento `recuperar` da 95px (10%), o sea que esta pantalla está mejor, no peor. La tabla
 * de las nueve celdas —tres pantallas por tres teléfonos— y lo que el v3 tampoco puede ver están en el
 * encabezado de `bienvenida-composicion.test.tsx`.
 */

/**
 * Los tres tramos del envío, en el orden en que la persona los va a vivir.
 *
 * ⛔ CADA RENGLÓN ES UN HECHO SOBRE EL RECORRIDO, Y SE VERIFICA CORRIÉNDOLO. El candado no busca estas
 * frases en la pantalla: camina el flujo real y comprueba que el tramo que cada una anuncia existe
 * (`PASOS_ESPERADOS`, `bienvenida-composicion.test.tsx:201`). Por eso están escritas en términos de lo
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
            todavía. Pintar de verde una afirmación sobre custodia la vestiría de buena noticia.

            🔴 ESTA FRASE ERA INCONDICIONAL SOBRE UN SISTEMA CONDICIONAL (AR/BLQ-BAJO-2), y es la misma
            rama que este pase ya le arregló al renglón 3 de `PASOS`. Decía *"cada envío deja una
            transacción que podés abrir en el explorador de Solana"*, y hay una rama alcanzable donde no
            hay ninguna: `principalTx` se escribe recién en `markPrincipalIn`, así que una remesa en
            `confirmed` —la persona YA firmó la autorización y nadie llegó a registrar el desenlace, una
            ventana documentada de hasta 15 s más el broadcast en `recover-escrow-funds.ts:30-35`— tiene
            firma de la persona y NINGÚN enlace que abrir. El `Receipt` lo dice bien: la fila "Depósito
            en Solana" está detrás de `{rem.principalTx ? …}` (`:3498`).
            ⛔ Y ERA LA FRASE MÁS FUERTE DE LA PANTALLA, la que sostiene AC-1, con un solo `getByText`
            cuidándola — el mismo test de presencia que `recuperar-composicion.test.tsx` llama "test de
            ortografía". La regla que incumplía está escrita 30 líneas más arriba, en esta misma HU.
            ✅ QUÉ DICE AHORA, partido en la mitad incondicional y la condicional: que el depósito ES una
            transacción en Solana (cierto siempre que haya depósito) y que el enlace aparece CUANDO la
            app tiene la firma (cierto siempre, y explícitamente condicional). No se ablandó la
            verificabilidad: se le puso la condición que el sistema tiene.
            ✅ Y SU CANDADO NO LA LEE: `T-063-24` monta el comprobante en las DOS ramas y mide qué hay.
            En la rama sin `principalTx` exige que NO haya enlace (o sea, ejecuta la rama menos
            favorable, que es lo que la regla pide); en la rama con `principalTx` exige que el enlace
            esté y apunte al explorador, así que la mitad condicional tampoco se puede vaciar. */}
        <Aviso className="text-left">
          <Muted escala="label">
            Y no hace falta creernos: el depósito de tus USDC es una transacción en Solana, y en cuanto
            la app tiene su firma te da el enlace para abrirla en el explorador.
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
                  WCAG y el segundo da 5,25:1 contra el blanco de la tarjeta contra 7,80:1 del
                  primero. Los dos pasan AA (4,5:1), y sólo el oscuro pasa AAA (7:1). La lección de
                  `ghost` en `ui.tsx` ya costó una ronda: cuando hay dos tonos de la marca y uno es
                  texto chico, se usa el oscuro.
                  🔴 ACÁ DECÍA 7,46:1 Y ERA UN NÚMERO HEREDADO, NO MEDIDO (fix-pack, CR/MNR-4): el
                  7,46 sale de `ui.tsx:40`, que lo mide contra el fondo de la APP (`paper` #FBFAF7) y
                  ahí es correcto. La tarjeta no es `paper`: `Card` pinta `bg-card`, que
                  `tailwind.config.ts:10` declara `#FFFFFF`. Re-calculado sobre los hex del tema con
                  la fórmula de luminancia relativa de WCAG 2.x: #9E1C40 sobre #FFFFFF da **7,80:1**
                  y sobre #FBFAF7 da 7,47:1. La conclusión no cambia; el número sí, y copiar una
                  cifra de contraste sin su fondo al lado es cómo se cuela una que no aplica. */}
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
