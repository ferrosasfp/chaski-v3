// @vitest-environment jsdom
//
// WKH-063 · SEGUNDO PASE — LA COMPOSICIÓN VERTICAL DE LA PRIMERA PANTALLA.
//
// 🔴 EL DEFECTO QUE CIERRA, medido por el orquestador sobre el BUILD DE PRODUCCIÓN (`npm run build` +
// `npm start`) con Chrome headless a 412x915, que es un Pixel 7:
//
//     viewport                           915px
//     el CTA terminaba en                433px
//     la barra empezaba en               814px
//     VACÍO                              381px   ← el 42% del viewport
//
// Todo el contenido vivía en el tercio de arriba y debajo no había nada. Un vacío de ese tamaño no se
// lee como aire: se lee como pantalla sin terminar, que es exactamente lo contrario de lo que la HU
// vino a lograr ("que la DApp tenga caché", pedido del founder para el video de M5). No le faltaba
// contenido arriba: le faltaba composición.
//
// DESPUÉS, mismo instrumento, mismo viewport, misma forma de medir:
//
//     el contenido arranca en            128px   (antes 86px: el bloque está centrado, no anclado)
//     el CTA termina en                  744px
//     el contenido termina en            772px
//     la barra empieza en                814px
//     VACÍO (CTA → barra)                 70px   ← 8%   (era 381px / 42%)
//     VACÍO real (fin del contenido → barra) 42px ← 5%
//
// ⛔ LOS DOS NÚMEROS DE ARRIBA SALEN DEL INSTRUMENTO v2, QUE ES GANABLE SIN ARREGLAR NADA, y hasta el
// fix-pack esto no estaba dicho acá (AR/MNR-1 y CR/MNR-11, el mismo hallazgo desde dos revisiones). "El
// tramo entre la última tinta y la barra" se puede llevar a 0 clavando una nota al pie con `mt-auto` y
// dejando el agujero en el medio — lo declara el encabezado de `recuperar-composicion.test.tsx`, que es
// donde se escribió el instrumento v3 para arreglarlo. Y el v3 NUNCA se había corrido sobre esta
// pantalla, así que el "8%" de acá y el "9%" de allá no eran la misma medida y no se podían comparar.
//
// ── EL v3 SOBRE LAS TRES PANTALLAS, UNA SOLA CORRIDA, UNA SOLA DEFINICIÓN ────────────────────────────
// Definición, y es la que hace comparables las nueve celdas: se funden todas las bandas de tinta de
// DENTRO DEL `<main>` (nodos de texto por `Range`, elementos hoja, y todo lo que declare borde o fondo)
// y se reporta el SALTO MÁXIMO entre dos bandas consecutivas, en cualquier parte de la columna. La
// barra es una banda como cualquier otra, así que el tramo hasta ella entra en la cuenta. Medido el
// 2026-08-17, build de producción + Chrome headless, calibración verificada (el instrumento compara el
// `innerWidth`/`innerHeight` del layout contra el viewport pedido y aborta si no coinciden) y las nueve
// celdas idénticas en dos corridas:
//
//     viewport    bienvenida       send            recuperar
//     375x667      24px ( 4%)      30px ( 4%)       24px ( 4%)
//     390x844      24px ( 3%)      30px ( 4%)       52px ( 6%)
//     412x915      58px ( 6%)      30px ( 3%)       95px (10%)
//
// LO QUE ESTA TABLA DICE, y es distinto de lo que decían los dos números viejos: el peor hueco de la
// bienvenida está ARRIBA (entre el pie del header y la primera tarjeta, 62→120 a 412x915), no abajo. Y
// medida con el MISMO instrumento, la bienvenida (58px / 6%) está MEJOR que `recuperar` (95px / 10%),
// que es la comparación que antes no se podía hacer.
//
// ⚠️ ESTOS NÚMEROS NO SON LOS "DESPUÉS" DE LOS PARES ANTES/DESPUÉS de este archivo ni de
// `recuperar-composicion.test.tsx`, y no se mezclan: aquel v3 medía dentro del bloque de la pantalla y
// NO contaba el hueco entre el header de la app y el bloque, así que para `recuperar` a 412x915 daba
// 79px donde este da 95px. Los dos son ciertos con su definición al lado; el de acá es el más exigente
// y es el único que se corrió sobre las tres pantallas. Los "antes" (381px / 469px) se quedan con la
// etiqueta del instrumento que los midió, porque reproducirlos exigiría revertir el código.
//
// ⚠️ Y LO QUE NINGUNA DE LAS DOS VERSIONES DEL v3 PUEDE VER: un hueco DENTRO de una tarjeta. El fondo
// de la `<Card>` cuenta como tinta, así que una tarjeta con 200px de nada adentro se mide como una
// banda llena. Es el mismo agujero que tenía la v1 (medir la caja en vez de la tinta), acotado a la
// tarjeta en vez de a la pantalla, y no está cerrado.
//
// 🔴 Y ACÁ SE CAYÓ UNA CONCLUSIÓN, MEDIDA, POR CULPA DE OTRO ARREGLO DEL FIX-PACK ANTERIOR. La tabla de
// alturas de documento decía `bienvenida 853px · send 856px` a 375x667, y con eso se afirmaba *"donde la
// bienvenida scrollea, el formulario ya scrolleaba (y por más)"*. Condicionar la frase del `<Aviso>`
// (AR/BLQ-BAJO-2) le sumó un renglón a la tarjeta, así que el documento de la bienvenida pasó a **870px**
// y la afirmación se INVIRTIÓ.
//
// 🔴 Y LA RECONCILIACIÓN DEL PAR CONTRADICTORIO SE RESOLVIÓ HACIA EL VALOR EQUIVOCADO (fix-pack 2 ·
// AR-it2/BLQ-BAJO-1), en DOS celdas: el árbol tenía `send @375x667` = 856 acá y 834 en los dos archivos de
// `recuperar`, y el fix-pack anterior escribió **856 en los cuatro sitios**, pisando los dos que decían el
// número bueno; ídem la fila `390x844`, donde escribió 870 para la bienvenida. RE-MEDIDO CON UN
// INSTRUMENTO NUEVO (build de producción `npm run build` + `npm start`, Chrome headless,
// `deviceScaleFactor 1`, VIEWPORT CALIBRADO: el instrumento compara `innerWidth`/`innerHeight` contra lo
// pedido y ABORTA si no coinciden, dos veces por medición — antes y después de caminar), **dos corridas
// con las celdas idénticas**. Ningún píxel sale de un PNG: todos de `scrollHeight` del `<html>`.
//
//     viewport    bienvenida    send      recuperar    ¿scrollea a ese alto?
//     375x667        870px      834px       811px      las TRES (viewport 667)
//     390x844        848px      844px       844px      sólo la bienvenida (848 > 844, por 4px)
//     412x915        915px      915px       915px      ninguna
//
// ⛔ EL ESTADO ES PARTE DEL NÚMERO, y por eso va escrito al lado:
//   · `bienvenida`: la app recién abierta, sin tocar nada (h2 «Tu plata no pasa por Chaski», barra
//     presente, ninguna cifra en pantalla).
//   · `send`: abierto tocando «Empezar un envío», monto en el `$400` por defecto, nombre y CCI VACÍOS y la
//     previsualización del quote YA RESUELTA (S/1,478.15 visible). Con nombre y CCI válidos cargados da
//     834 igual, así que la celda no depende de eso.
//   · `recuperar`: abierto tocando su pestaña de la barra.
// Y LOS OTROS CINCO ESTADOS DE `send` A 375x667, medidos para poder decir que el 856 no es de ninguno:
// 834 intacto · 834 con nombre+CCI · **878 con CCI inválido** (la fila del error) · 850 con monto por
// debajo del mínimo · 810 con el monto vacío · 834 con la cotización abortada. **856 no aparece en
// ninguno**, y por eso el par contradictorio era 834 (bueno) contra 856 (irreproducible).
//
// LO QUE SE PUEDE AFIRMAR, y es menos de lo que se afirmaba: a 375x667 la bienvenida es la MÁS ALTA de
// las tres, no la más baja. Lo que sostiene `justify-center` no es esa comparación sino el mecanismo, y
// eso sí está medido: a 375x667 la tinta va de 24px a 830px dentro de un documento de 870px, o sea
// ENTERA adentro — `min-height:auto` no puede recortar, y si recortara el contenido arrancaría por
// encima de 0. El detalle está en el docblock de `bienvenida.tsx`.
// ⚠️ NINGUNA CONCLUSIÓN SE INVIERTE CON LOS NÚMEROS CORREGIDOS, y se verificó una por una: `811 < 834 <
// 870` sigue diciendo que `recuperar` es la más baja y la bienvenida la más alta a 375x667, y `848 > 844`
// sigue diciendo que a 390x844 scrollea sólo la bienvenida — con 4px de margen en vez de 26. Lo que
// cambia es que el margen es fino, así que un renglón más en la bienvenida ya no mueve nada y un renglón
// más en `send` la haría scrollear también.
//
// ⚠️ QUÉ PUEDE Y QUÉ NO PUEDE MEDIR ESTE ARCHIVO, declarado antes de los asserts. Acá corre jsdom, que
// NO hace layout, y tampoco corre Tailwind:
//   · NO mide un solo píxel. Los números de arriba son del navegador y están en este comentario porque
//     es el único lugar donde pueden estar; ningún test de este repo los reproduce.
//   · SÍ congela las DECISIONES de las que esos píxeles salen: que el bloque pida crecer y centrarse,
//     que el bloque nuevo esté y diga lo que dice, y que lo que dice sea EJECUTABLE en el flujo real.
//     Si alguna de las tres se cae, los píxeles se caen con ella.
//   · Y SÍ congela un caso raro que vale la pena: la clase que NO hay que usar (ver T-063-11b), porque
//     es la que se midió inerte en este layout y se ve exactamente igual en el código.
//
// ── LOS OCHO MUTANTES: APLICADOS Y CORRIDOS, no razonados ───────────────────────────────────────────
// Cada uno se editó en el árbol, se corrió este archivo y se anotó la salida. No es una lista de lo que
// "debería" fallar: son los conteos de la corrida.
//
// ⚠️ LOS OCHO SE RE-CORRIERON EN EL FIX-PACK, porque el archivo pasó de **11 a 14 tests** —los dos de
// `T-063-24` MÁS el de antivacuidad de `T-063-10`, o sea TRES y no dos (verificado contando los `it(` de
// los dos árboles, no de memoria)— y un total viejo (`… (11)`) ya no describe este árbol. Un conteo de
// mutación es relativo al tamaño de la suite y agregar tests lo invalida sin que nada se ponga rojo. 🔴 Y VOLVIÓ A PASAR: HU-068 llevó este archivo de **14 a 21 tests**, así que LOS DIECISÉIS NÚMEROS DE LA TABLA DE ABAJO SON DE LA CORRIDA DE 14 Y ESTÁN VIEJOS. No se les escribió un total nuevo encima —eso sería publicar como medido algo que no se re-corrió—: los tres que HU-068 SÍ re-corrió sobre 21 (el 4, el 5 y el 6) están al FINAL del archivo, con su conteo, junto con los diez mutantes nuevos de la banda.
//
// 🔴 Y EL FIX-PACK ANTERIOR PUBLICÓ ESTA TABLA CON **(13)** EN LAS OCHO FILAS SOBRE UN ARCHIVO DE **14**
// TESTS (fix-pack 2 · AR-it2/MNR-1). Los ocho `failed` estaban bien; los ocho totales estaban viejos por
// uno, o sea que la tabla decía "re-medida" y ocho de sus dieciséis números venían de la corrida anterior.
// Es EXACTAMENTE el antipatrón que el párrafo de arriba declara, en la tabla que está debajo del párrafo.
// LOS OCHO SE RE-CORRIERON DE NUEVO, uno por uno, sobre el árbol del fix-pack 2, cada uno con el conteo
// del patrón verificado en 1 ANTES de aplicar y con los archivos restaurados y comparados byte a byte
// después. Control sin mutante en la misma corrida: **`14 passed (14)`**.
//
//   MUTANTE APLICADO                                                        RESULTADO MEDIDO
//   1. la raíz sin `justify-center` (vuelve a quedar anclada arriba)         1 failed | 13 passed (14)
//   2. la raíz con `min-h-full` en vez de `flex-1` (la clase INERTE)         2 failed | 12 passed (14)
//   3. el `motion.div` de vuelta a `flex-1` a secas (sin `flex flex-col`)    1 failed | 13 passed (14)
//   4. `PASOS` con dos renglones en vez de tres                             3 failed | 11 passed (14)
//   5. el renglón 2 sin la mitad de la identidad                            1 failed | 13 passed (14)
//   6. `onContinue` de `review` saltando `verify` (`onContinue`, `flow.tsx:384`)  1 failed | 13 passed (14)
//   7. la nota de la red borrada                                            2 failed | 12 passed (14)
//   8. la fila `TxProof` del depósito borrada del comprobante (fix-pack)     1 failed | 13 passed (14)
//
// ⚠️ EL 2 MATA DOS Y ES EL QUE MÁS ENSEÑA: rompe el `it` que prohíbe `min-h-full` y también el que
// exige `flex-1`, o sea que la clase inerte no puede entrar disfrazada de "otra forma de escribirlo".
// Y el 6 es el único que toca el FLUJO y no el texto: es el que impide que este archivo sea un test de
// ortografía. Los mutantes 1 y 3 se corrieron además contra la suite COMPLETA (138 archivos): fuera de
// este archivo NADIE los ve, y eso es el dato — antes de este pase la composición vertical de la
// pantalla de entrada no la vigilaba ningún test.
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";
import React from "react";
import { Receipt, RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { Money } from "../domain/money";
import { Remittance, type RemittanceState, toPersistedIdentity } from "../domain/remittance";
import { FAKE_SOLANA_BENEFICIARY, TEST_CCI, T0, beneficiary } from "../test-support/fakes";
const KYC_PROVENANCE_LIVE = "didit"; // WKH-233: el literal se escribe ACÁ, en un test, porque el módulo que lo exportaba se borró con la HU (el juicio "esto es real" ya no lo hace Chaski). EN UNA SOLA LÍNEA: este archivo recibe citas `archivo:línea` y agregar líneas las corre.

// El MISMO doble que `barra-destinos.test.tsx`: sin él el `exit` de AnimatePresence no completa en el
// mismo tick y el cambio de pantalla no se puede seguir con `get*`. Y acá cumple una segunda función
// que sí importa: el proxy PASA LAS PROPS al tag, así que el `className` del `motion.div` de
// `flow.tsx` llega al DOM y T-063-11c lo puede leer. Un doble que se comiera las props dejaría ese
// test sin nada que mirar y en verde.
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  MotionConfig: ({ children }: { children: React.ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
          React.createElement(tag, props, children),
    },
  ),
}));

afterEach(cleanup);

/**
 * El envoltorio de la bienvenida y su padre, DERIVADOS del árbol y no buscados por la clase que estos
 * tests vigilan.
 *
 * 🔴 POR QUÉ NO ES UN `querySelector(".justify-center")`: sería el guard que se compara consigo mismo
 * que este repo ya tiene documentado. Se buscaría el elemento POR la clase que hay que verificar, así
 * que borrar la clase daría "no encontré el elemento" en vez de "la clase no está", y peor: cualquier
 * otro elemento centrado de la pantalla contestaría por él.
 *
 * Acá el ancla son dos hechos de la pantalla que no son de estilo: el titular y el CTA. La raíz es el
 * ancestro más cercano del CTA que TAMBIÉN contiene el titular, o sea el elemento que envuelve la
 * pantalla entera y ninguno más chico.
 */
function bloque() {
  const cta = screen.getByRole("button", { name: /Empezar un envío/ });
  const titulo = screen.getByRole("heading", { level: 2, name: "Tu plata no pasa por Chaski" });
  let raiz: HTMLElement | null = cta.parentElement;
  while (raiz !== null && !raiz.contains(titulo)) raiz = raiz.parentElement;
  if (raiz === null) throw new Error("no encontré el envoltorio de la bienvenida (¿cambió el árbol?)");
  const envoltorio = raiz.parentElement;
  if (envoltorio === null) throw new Error("el envoltorio de la bienvenida no tiene padre");
  return { raiz, envoltorio, cta, titulo };
}

const pintarBienvenida = () => render(<RemittanceFlow container={buildTestContainer()} />);

// ══ LOS TRES PASOS · la tabla escrita a mano, que es lo único normativo del bloque ════════════════
//
// 🔴 LAS FRASES VAN ESCRITAS ACÁ, LETRA POR LETRA, Y NO IMPORTADAS DE `bienvenida.tsx`. Un test que le
// pregunta al código qué dice y después verifica que dijo eso aprueba cualquier cosa; es el mismo
// criterio con el que `barra-destinos.test.tsx` escribe el literal de `DEMO_PILL` a mano.
//
// Y `sonda` es la otra mitad, la que impide que esto sea un test de ortografía: es lo que tiene que
// EXISTIR EN EL FLUJO REAL para que la frase sea cierta. La lección está en el auto-blindaje de esta
// misma HU: un test que verifica que el copy existe no se rompe cuando el copy se vuelve falso; uno
// que EJECUTA lo que el copy anuncia, sí.
//
// 🔴 LA TABLA PROMETÍA MÁS DE LO QUE SU TIPO OBLIGABA (fix-pack, CR/MNR-7). DOS de las tres `sonda` eran
// CUERPOS VACÍOS —un comentario diciendo "la sonda es el recorrido de T-063-10b"— y el trabajo real
// estaba escrito inline en ese `it`. Con eso no había verde vacuo HOY, pero una CUARTA fila con
// `sonda: () => {}` pasaba los cuatro `it` del bloque sin ejercitar nada, o sea que la próxima frase de
// producto podía entrar con una sonda de mentira. Se cerró por los dos lados:
//   · los asserts inline se MUDARON a la sonda de su renglón, así que ninguna queda vacía. Para eso la
//     sonda recibe un `seguir()`: el renglón 2 abarca dos pasos del flujo (`verify` y `confirm`) y
//     necesita avanzar en el medio. El `seguir` lo provee el recorrido, que sigue siendo el dueño de la
//     navegación;
//   · y hay un `it` de ANTIVACUIDAD que lee el cuerpo de cada sonda y exige que llame a `expect`. Una
//     fila nueva con `sonda: () => {}` se pone roja sola.
type Sondeo = { seguir: () => Promise<void> };
/**
 * 🔴 EL TECHO DE TODA ESPERA DE LA CAMINATA (WKH-233 fix-pack · H-13). El default de `findBy*` es
 * **1000 ms** —medido con una sonda en este mismo runner: sin argumento 1004 ms, `{timeout:2500}`
 * 2502 ms, `{timeout:150}` 151 ms, o sea que el default es ése y el TERCER argumento es el que
 * manda— y ese segundo NO alcanza cuando la máquina está cargada. El `it` que camina el flujo
 * reventaba en 2 de 4 corridas de la suite completa, y volvió a reventar —en OTRA de sus esperas—
 * corriendo con instrumentación de cobertura, que es más carga todavía.
 *
 * ⛔ NO ESCONDE NINGUNA REGRESIÓN: una regresión real nunca resuelve, así que el rojo sigue siendo
 * rojo — sólo tarda más en decirlo. Lo que el techo compra es que "lento" deje de leerse como "roto".
 * ⛔ Y NO SE ARREGLA CON `getBy*`: los elementos NO están montados cuando se piden (cada uno llega
 * después de trabajo asíncrono del use-case), así que un `getBy*` fallaría SIEMPRE, no a veces.
 *
 * ⚠️ PERÍMETRO, DECLARADO PORQUE ESTO ARREGLA UN ARCHIVO Y NO LA CLASE: al 2026-08-20 el árbol tiene
 * **327** llamadas `findBy*` y —contadas con el mismo barrido— NINGUNA pasaba `timeout`. Las demás
 * siguen con el techo de 1000 ms y pueden reventar por lo mismo bajo carga. El arreglo de la CLASE
 * sería `asyncUtilTimeout` global, y eso exige un `vitest.config.*` que este repo NO tiene a
 * propósito (`readme-test-count.test.ts` se apoya en el descubrimiento por defecto). Es otra HU.
 */
const TECHO_ESPERA = { timeout: 8_000 } as const;

/**
 * 🔴 LA CAUSA REAL DEL FLAKE, Y NO ERA LENTITUD (WKH-233 fix-pack · H-13, 2ª iteración).
 *
 * ⚠️ ACÁ PRIMERO ESCRIBÍ "es contención de CPU, con un techo de 8 s alcanza". **Lo corrí y NO
 * alcanzó**: con el techo puesto, el `it` esperó los 8,4 s COMPLETOS y falló igual, y el volcado del
 * DOM mostró la pantalla parada en `connect` ("Paso 1 de 4", el botón *Conectar wallet* presente y
 * sin ningún cartel de error). Esperar más no sirve cuando la pantalla no está tardando: está quieta.
 *
 * EL MECANISMO, leído del código y no inferido del síntoma:
 *   · `flow.tsx:300-314` — `guard()` hace `setBusy(true)` → `await fn()` → `setBusy(false)`.
 *   · `flow.tsx:964` — `<Button disabled={busy} onClick={onConnect}>`.
 *   · `fireEvent.click` sobre un botón DESHABILITADO **no hace nada, y no avisa** — MEDIDO con una
 *     sonda de dos casos: `disabled` ⇒ el `onClick` recibe 0 llamadas; el MISMO click sin
 *     `disabled` ⇒ 1. No es una creencia sobre la librería.
 * ⇒ Entre que el paso anterior cambia de pantalla y que su `guard` libera `busy`, el botón nuevo ya
 * está en el DOM pero todavía deshabilitado. `findByRole` lo encuentra —existe—, el click se dispara,
 * se descarta en silencio, y el flujo queda parado PARA SIEMPRE. Es una carrera, no un timeout: por
 * eso fallaba ~2 de 4 y por eso aislado pasaba 22/22.
 *
 * ⛔ POR ESO NO SE ARREGLA CON UN TECHO MÁS GRANDE, y el techo de arriba se queda igual pero por otra
 * razón (las esperas de PRESENCIA sí pueden tardar bajo carga). Lo que arregla la carrera es esperar
 * a que el botón esté HABILITADO antes de tocarlo, que es lo que hace este helper.
 *
 * ⚠️ Se re-consulta el botón DENTRO del `waitFor` y otra vez para el click: React lo re-crea en cada
 * render, así que guardar la referencia de la primera consulta sería clickear un nodo viejo.
 */
const clickCuandoHabilite = async (nombre: RegExp): Promise<void> => {
  await waitFor(() => {
    const b = screen.getByRole("button", { name: nombre });
    expect(b, `el botón «${nombre}» sigue deshabilitado: el click se descartaría en silencio`)
      .not.toBeDisabled();
  }, TECHO_ESPERA);
  fireEvent.click(screen.getByRole("button", { name: nombre }));
};

const PASOS_ESPERADOS: readonly { frase: string; sonda: (s: Sondeo) => Promise<void> }[] = [
  {
    frase: "Ponés el monto y el CCI de tu familiar.",
    // El paso `send` pide exactamente esos dos datos, y los dos se buscan por su etiqueta real.
    sonda: async () => {
      expect(screen.getByLabelText("Monto en dólares")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("002 193 004455667788 99")).toBeInTheDocument();
    },
  },
  {
    frase: "Verificás tu identidad y firmás el envío.",
    // Las dos mitades son dos pasos distintos del flujo (`verify` y `confirm`), y las dos se caminan:
    // primero la identidad, y DESPUÉS de avanzar, la firma. El orden es parte de lo que el renglón dice.
    sonda: async ({ seguir }) => {
      expect(
        await screen.findByRole("button", { name: /Verificar mi identidad/ }, TECHO_ESPERA),
        "el renglón 2 anuncia una verificación de identidad: el flujo tiene que tenerla",
      ).toBeInTheDocument();
      await seguir();
      expect(
        await screen.findByRole("button", { name: /Confirmar y enviar/ }, TECHO_ESPERA),
        "y el renglón 2 también anuncia una firma",
      ).toBeInTheDocument();
    },
  },
  {
    // ⚠️ ESTE RENGLÓN SE CORRIGIÓ AL ESCRIBIRLE LA SONDA, y vale más que el renglón. Decía "con su
    // transacción de Solana a la vista", y la sonda buscaba la fila "Depósito en Solana" del
    // seguimiento. Falló, y el rojo tenía razón: esa fila se pinta sólo si hay `principalTx`, así que
    // en la rama donde el depósito no llegó a firmarse la frase era FALSA. Se cambió la frase, no la
    // sonda. Es el caso puro de por qué la tabla lleva sonda: escrito a ojo, ese renglón se iba a
    // producción con una afirmación condicional presentada como incondicional.
    frase: "Seguís el envío y su estado desde la app.",
    // ⚠️ LA SONDA ES EL TRAMO, NO EL DESENLACE, y es deliberado: con los dobles por defecto el pago
    // falla (`FakePayoutGateway`), así que el TEXTO de estado que aparece depende de la rama y asertar
    // uno lo ataría a este doble. Lo que el renglón 3 afirma, y lo que vale en todas las ramas, es que
    // hay un cuarto tramo después de la firma. El stepper lo anuncia con texto real (un `sr-only`, no
    // un `aria-label` sobre un `<div>` genérico, que es el arreglo que ya vive en `Stepper`).
    sonda: async ({ seguir }) => {
      await seguir();
      expect(
        await screen.findByText("Paso 4 de 4", undefined, TECHO_ESPERA),
        "el renglón 3 anuncia un seguimiento: después de firmar el flujo tiene que seguir",
      ).toBeInTheDocument();
    },
  },
];

describe("T-063-10 (2º pase): la pantalla dice QUÉ VA A PASAR, y lo que dice se puede correr", () => {
  it("los tres renglones están, en orden, y son tres (no dos ni cuatro)", () => {
    // MUTANTE 4 (aplicado): `PASOS` con dos renglones ⇒ rojo por el `toEqual`, que es una lista
    // CERRADA y ORDENADA. Un `toContain` por renglón dejaría borrar el tercero sin decir nada, y el
    // tercero es justo el que sostiene la mitad de abajo de la composición.
    //
    // MUTANTE 5 (aplicado): dejar el renglón 2 en "Firmás el envío desde tu billetera." (o sea,
    // sacarle la mitad de la identidad) ⇒ rojo. Importa porque la verificación de identidad es lo
    // ÚNICO de este flujo que una persona no espera, y anunciarla acá es la mitad honesta del bloque.
    pintarBienvenida();
    const renglones = [...document.querySelectorAll("ol li")].map((li) =>
      (li.textContent ?? "").replace(/^\d+/, "").trim(),
    );
    expect(renglones).toEqual(PASOS_ESPERADOS.map((p) => p.frase));
  });

  it("es una lista ORDENADA de verdad, no tres párrafos con un número escrito adelante", () => {
    // El orden ES el contenido de este bloque: "primero los datos, después la identidad y la firma,
    // después el seguimiento". Un `<div>` con tres hijos se ve igual y no le dice nada a un lector de
    // pantalla, que es el mismo defecto que D-3 cerró para los títulos (se VEN como títulos y no lo
    // son). Acá se pide el elemento correcto, y que el número visible sea UNO por renglón.
    pintarBienvenida();
    const listas = document.querySelectorAll("ol");
    expect(listas, "el bloque de pasos tiene que ser un `<ol>`").toHaveLength(1);
    const items = [...(listas[0] as HTMLElement).querySelectorAll("li")];
    expect(items).toHaveLength(PASOS_ESPERADOS.length);
    expect(items.map((li) => (li.textContent ?? "").slice(0, 1))).toEqual(["1", "2", "3"]);
  });

  it("🔴 cada renglón anuncia un tramo que el flujo REALMENTE tiene (se camina, no se lee)", async () => {
    // MUTANTE 6 (aplicado): `const onContinue = () => setStep("verify")` (`flow.tsx:384`) cambiado a
    // `setStep("confirm")` ⇒ el flujo salta la identidad, el renglón 2 de la bienvenida pasa a ser
    // mentira, y ESTE test se pone rojo. Es el mutante que justifica el archivo: los otros dos de
    // arriba miran el texto, y un texto no puede medirse a sí mismo.
    // ⚠️ LA NAVEGACIÓN ES DE ESTE `it` Y LOS ASSERTS SON DE CADA SONDA (fix-pack, CR/MNR-7): antes los
    // asserts de los renglones 2 y 3 estaban acá inline y sus sondas eran cuerpos vacíos.
    const tocar = (nombre: RegExp) => async () => {
      await clickCuandoHabilite(nombre);
    };
    pintarBienvenida();
    await clickCuandoHabilite(/Empezar un envío/);

    // Renglón 1 · el monto y el CCI.
    await (PASOS_ESPERADOS[0] as { sonda: (s: Sondeo) => Promise<void> }).sonda({
      seguir: async () => {
        throw new Error("el renglón 1 no avanza: sus dos datos están en la misma pantalla");
      },
    });
    fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), {
      target: { value: "Mamá" },
    });
    fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), {
      target: { value: TEST_CCI },
    });
    await clickCuandoHabilite(/Continuar/);
    await clickCuandoHabilite(/Conectar wallet/);
    // 🔴 EL ÚNICO `findBy*` DEL REPO CON TECHO EXPLÍCITO, Y ES POR UN FLAKE MEDIDO (WKH-233 fix-pack ·
    // H-13). Esta línea reventaba en **2 de 4 corridas** de la suite completa, y NO por una aserción:
    // por el timeout de `findBy*`, que por defecto es **1000 ms** — y ese default NO se dedujo del
    // README de la librería: se MIDIÓ con una sonda (`findByText` sobre un texto inexistente, en este
    // mismo runner) que dio `sin argumento = 1004 ms`, `{timeout:2500} = 2502 ms`,
    // `{timeout:150} = 151 ms`. Esa misma sonda es la que prueba que el TERCER argumento es el que
    // manda: si se ignorara, los tres habrían dado ~1000. Aislado el `it` pasa 22/22. La causa
    // no es de esta HU —worktrees en `da0fb68` y `9e3e147` dan verde— sino CONTENCIÓN DE CPU: entre el
    // click de arriba y este texto corren `connectWallet` + `lockQuote`, y con la máquina cargada esa
    // cadena de microtareas no cierra en un segundo.
    //
    // ⛔ POR QUÉ UN TECHO Y NO `getByText`: el elemento NO está montado cuando se pide. El click de
    // arriba dispara trabajo asíncrono, así que un `getBy*` fallaría SIEMPRE, no a veces.
    // ⛔ Y POR QUÉ ESTO NO ESCONDE UNA REGRESIÓN: una regresión real nunca resuelve, así que el test
    // sigue rojo — sólo tarda más en decirlo. Lo que el techo compra es que "lento" deje de leerse
    // como "roto". El `it` lleva su propio techo (`20_000`) porque el default de vitest son 5000 ms y
    // sin subirlo el `it` moriría antes que el `findBy`.
    //
    // ⚠️ PERÍMETRO, DECLARADO PORQUE ESTO ARREGLA UN SITIO Y NO LA CLASE: al 2026-08-20 el árbol tiene
    // **327** llamadas `findBy*` y —contadas con el mismo barrido— **ninguna** pasaba `timeout`. O sea
    // que las otras 326 siguen con el techo de 1000 ms y pueden reventar por lo mismo bajo carga. No se
    // arreglan acá: el arreglo de la CLASE sería subir `asyncUtilTimeout` global, y eso exige un
    // `vitest.config.*` que este repo NO tiene a propósito (`readme-test-count.test.ts` se apoya en que
    // el descubrimiento sea el default). Es una HU aparte, no un renglón de este fix-pack.
    await screen.findByText(/Revisá el envío/, undefined, TECHO_ESPERA);
    await clickCuandoHabilite(/Continuar/);

    // Renglón 2 · la identidad primero y la firma después, en ese orden y con ese nombre.
    await (PASOS_ESPERADOS[1] as { sonda: (s: Sondeo) => Promise<void> }).sonda({
      seguir: tocar(/Verificar mi identidad/),
    });

    // Renglón 3 · después de firmar el flujo NO termina: hay un tramo de seguimiento.
    await (PASOS_ESPERADOS[2] as { sonda: (s: Sondeo) => Promise<void> }).sonda({
      seguir: tocar(/Confirmar y enviar/),
    });
    // El techo del `it`: ver el bloque del `findByText` de arriba. El default de vitest (5000 ms) es
    // MENOR que el techo que este test necesita, así que sin esto el `it` moriría primero y el rojo
    // volvería a leerse como "el flujo no llega", que es justo el diagnóstico equivocado.
  }, 20_000);

  it("🔴 ninguna fila de la tabla puede traer una sonda VACÍA (antivacuidad del propio candado)", () => {
    // MUTANTE (aplicado): agregar una cuarta fila con `frase: "…" , sonda: async () => {}` ⇒ rojo acá,
    // nombrando la frase. Sin este `it`, esa fila pasaba los cuatro `it` de arriba sin ejercitar nada:
    // el `toEqual` de los renglones se pone rojo por el TEXTO (hay que agregar la frase a `PASOS`
    // también), y con las dos mitades hechas la sonda vacía entraba sin que nada la mirara.
    //
    // Se lee el CUERPO de la función, que es lo único que distingue una sonda de un placeholder. No se
    // exige un mínimo de líneas (sería un número arbitrario): se exige que llame a `expect`, que es lo
    // que convierte una sonda en una medición.
    expect(PASOS_ESPERADOS.length, "ANTIVACUIDAD del antivacuidad: la tabla no puede estar vacía").toBe(3);
    for (const { frase, sonda } of PASOS_ESPERADOS) {
      expect(sonda.toString(), `la sonda de «${frase}» no assertea nada`).toContain("expect(");
    }
  });

  it("ningún renglón promete una entrega ni un plazo", () => {
    // La clase de defecto que `honest-copy.test.tsx` ya cerró una vez: "llega en ~30 min" prometía una
    // entrega que este sistema no controla (la release del vault la dispara una persona a mano). El
    // bloque nuevo es copy nueva sobre el mismo recorrido, así que hereda la prohibición. Lo que sí
    // puede decir, y dice, es que el envío se SIGUE.
    pintarBienvenida();
    const texto = PASOS_ESPERADOS.map((p) => p.frase).join(" ");
    expect(texto).not.toMatch(/llega|garantiz|asegur|\bmin\b|minutos/i);
  });
});

// ══ LA COMPOSICIÓN · las dos mitades que producen los píxeles del encabezado ══════════════════════

describe("T-063-11 (2º pase): el bloque pide crecer y centrarse, y su padre puede dárselo", () => {
  it("🔴 la raíz de la bienvenida pide las dos cosas: crecer (`flex-1`) y centrar (`justify-center`)", () => {
    // MUTANTE 1 (aplicado): borrar `justify-center` ⇒ rojo. Sin él el bloque crece igual pero el
    // contenido se apoya arriba y el sobrante vuelve entero abajo, que es el defecto original con más
    // contenido: medido, el vacío pasaba de 70px a 112px y el contenido volvía a arrancar en 86px.
    //
    // ⚠️ ESTO CONGELA LA DECLARACIÓN, NO EL PÍXEL, y está dicho así a propósito: jsdom no hace layout.
    // Que estas dos clases produzcan un bloque centrado lo hace el navegador, y ese número vive en el
    // encabezado de este archivo porque no hay forma de asertarlo desde acá.
    pintarBienvenida();
    const { raiz } = bloque();
    expect(raiz.className, "sin `flex-1` no hay altura contra la que centrar").toContain("flex-1");
    expect(raiz.className, "sin `justify-center` el sobrante vuelve entero abajo").toContain(
      "justify-center",
    );
    expect(raiz.className, "y tiene que ser una columna flex para que `justify-center` sea vertical").toContain("flex-col");
  });

  it("🔴 y NO usa `min-h-full`: en este layout esa clase se midió INERTE", () => {
    // MUTANTE 2 (aplicado): `min-h-full` en lugar de `flex-1` ⇒ rojo acá, y en el navegador NO SE VE
    // NINGUNA DIFERENCIA con no poner nada. Ésta es la razón de ser del `it`, y no es una hipótesis:
    // la primera versión del arreglo decía `min-h-full` y se midió en el build de producción, poniendo
    // las cuatro variantes por DOM y midiendo cada una a 412x915:
    //
    //     `min-height:100%`   ⇒ el hijo midió 644px dentro de un padre de 728px   (no hizo NADA)
    //     `height:100%`       ⇒ 644px                                             (tampoco)
    //     sin nada            ⇒ 644px                                             (idéntico: la prueba)
    //     padre `flex-col` + hijo `flex-grow:1` ⇒ 728px                            (el único que estira)
    //
    // El motivo: el padre era un ÍTEM flex (`flex-1`), no un CONTENEDOR flex, así que un porcentaje de
    // altura no tenía contra qué resolver. La clase compilaba, pasaba el `tsc`, se veía igual y no
    // producía ningún efecto: es el mismo modo de falla que el tema documenta para un `rounded-xl2`
    // olvidado. Un candado que sólo pidiera "que esté centrado" no distinguiría las dos versiones.
    pintarBienvenida();
    const { raiz } = bloque();
    expect(
      raiz.className,
      "`min-h-full` acá no hace nada (medido): el padre es un ítem flex, no un contenedor",
    ).not.toContain("min-h-full");
  });

  it("🔴 el envoltorio de los pasos es un CONTENEDOR flex en columna, o el `flex-1` de arriba no sirve", () => {
    // MUTANTE 3 (aplicado): devolver el `motion.div` de `flow.tsx` a `className="flex-1"` a secas ⇒
    // rojo. Es la otra mitad del arreglo y ninguna de las dos sirve sola: un hijo con `flex-1` dentro
    // de un padre que no es contenedor flex crece cero.
    //
    // ⛔ Y ESTE MISMO ENVOLTORIO NO PUEDE LLEVAR `justify-center`, que sería la forma "corta" de
    // arreglarlo: lo comparten TODAS las pantallas, así que centraría también el formulario y el
    // recibo. El centrado es una decisión de ESTA pantalla y por eso vive en su raíz.
    pintarBienvenida();
    const { envoltorio } = bloque();
    const clases = envoltorio.className.split(/\s+/);
    expect(clases, "el padre tiene que ser `display:flex`").toContain("flex");
    expect(clases, "y en columna, o `flex-1` crecería a lo ancho").toContain("flex-col");
    expect(clases, "y seguir siendo el que ocupa el alto sobrante del `<main>`").toContain("flex-1");
  });

  it("el envoltorio compartido NO centra por su cuenta: las otras pantallas siguen ancladas arriba", () => {
    // El par del test de arriba. Sin esto, "arreglar" la bienvenida moviendo el `justify-center` al
    // envoltorio pasaría los tres tests anteriores y cambiaría en silencio la composición de las siete
    // pantallas del flujo. Se mide en `send`, que es la que la persona ve inmediatamente después.
    render(<RemittanceFlow pasoInicial="send" container={buildTestContainer()} />);
    const volver = screen.getByRole("button", { name: /Volver al inicio/ });
    const envoltorio = volver.parentElement?.parentElement;
    expect(envoltorio, "no encontré el envoltorio del paso `send`").not.toBeNull();
    expect((envoltorio as HTMLElement).className).not.toContain("justify-center");
  });
});

// ══ LA RED, DICHA CON SU NOMBRE ══════════════════════════════════════════════════════════════════

// ⚠️ EL TÍTULO DE ESTE BLOQUE DECÍA "y es la que va a firmar", Y ESO NO ES LO QUE MIDE (fix-pack,
// AR/MNR-2). Mide que el literal de la pantalla sea `devnet`. Que ese literal COINCIDA con la red contra
// la que se firma no lo garantiza nada: el nombre es un literal (`cluster`, `../infrastructure/chain.ts:8`)
// y el endpoint sale de `NEXT_PUBLIC_SOLANA_RPC_URL` (`resolveSolanaRpcUrlPublic`,
// `../infrastructure/chain.ts:190`) sin validación cruzada. El detalle, con la precondición del env
// medida, está en el docblock de `bienvenida.tsx`.
describe("T-063-12 (2º pase): la pantalla nombra la red, y el nombre es un literal vigilado", () => {
  it("🔴 dice «Solana devnet», y el literal va escrito ACÁ y no importado del resolver", () => {
    // MUTANTE 7 (aplicado): borrar la nota del pie ⇒ rojo.
    //
    // POR QUÉ EL LITERAL A MANO. Si esto asserteara
    // `getByText(new RegExp(resolveSolanaNetworkConfig().cluster))` sería un guard que se compara
    // consigo mismo: pasaría con cualquier red, incluida la equivocada. Escrito a mano, el día que
    // `SolanaNetworkConfig` sume `mainnet-beta` este test se pone rojo y OBLIGA a decidir qué dice la
    // pantalla, que es exactamente la disciplina que `chain.ts` ya se impone con sus cuatro `switch`
    // sin `default` heredado.
    //
    // ⛔ Y NO ES DECORACIÓN: es lo que hace accionable la frase de arriba. "Abrí la transacción en el
    // explorador" no sirve si la persona no sabe en qué red mirar, y el explorador de Solana pide el
    // cluster en la URL (`resolveSolanaExplorerTxUrl`, `chain.ts:224`).
    pintarBienvenida();
    expect(screen.getByText(/corre en Solana devnet/)).toBeInTheDocument();
  });

  it("la nota va DEBAJO del CTA, no arriba", () => {
    // El mismo criterio que AC-6 fijó para la frase de custodia de `connect`: una nota de honestidad
    // no se pone donde tape la acción principal. Y es una relación de orden, así que
    // `compareDocumentPosition` la contesta en vez de una impresión.
    pintarBienvenida();
    const { cta } = bloque();
    const nota = screen.getByText(/corre en Solana devnet/);
    expect(
      cta.compareDocumentPosition(nota) & Node.DOCUMENT_POSITION_FOLLOWING,
      "la nota de la red quedó arriba del CTA",
    ).toBeTruthy();
  });

  it("y el bloque nuevo no metió ninguna cifra: AC-1 sigue valiendo con más contenido en pantalla", () => {
    // `barra-destinos.test.tsx` ya prohíbe monto y tasa en esta pantalla, y ese candado se escribió
    // cuando la pantalla tenía tres frases. Este pase le agregó tres renglones y una nota, o sea
    // cuatro lugares nuevos donde una cifra podría entrar "para que se vea más completo". Se
    // re-assertea acá, sobre la pantalla nueva, porque el riesgo es de ESTE pase.
    pintarBienvenida();
    const texto = document.body.textContent ?? "";
    expect(texto, "un monto en soles").not.toMatch(/S\/\s?[\d,]+\.\d{2}/);
    expect(texto, "un monto en dólares").not.toMatch(/\$\s?\d/);
    expect(texto, "una tasa").not.toMatch(/1 USD ≈/);
    // Los únicos dígitos legítimos de la pantalla son los tres números de la lista de pasos.
    expect((texto.match(/\d/g) ?? []).join("")).toBe("123");
  });
});

// ══ AR/BLQ-BAJO-2 · LA FRASE MÁS FUERTE DE LA PANTALLA, EJECUTADA EN LA RAMA MENOS FAVORABLE ═════
//
// 🔴 QUÉ DECÍA Y POR QUÉ ERA FALSO. El `<Aviso>` de la bienvenida decía *"cada envío deja una
// transacción que podés abrir en el explorador de Solana"*: incondicional, sobre un sistema condicional.
// `principalTx` se escribe recién en `markPrincipalIn`, así que una remesa en `confirmed` —la persona ya
// firmó la autorización del depósito y nadie llegó a registrar el desenlace, la ventana que
// `recover-escrow-funds.ts:30-35` documenta como "hasta 15 s del timeout del settle más el broadcast"—
// no tiene ninguna firma que enlazar. En esa rama la primera pantalla ya prometió una.
//
// ⚠️ Y SU ÚNICO CANDADO ERA UN `getByText`. Es exactamente el defecto que este mismo pase le arregló al
// renglón 3 de `PASOS` (ver el comentario de su fila): un test que verifica que el copy EXISTE no se
// rompe cuando el copy se vuelve falso. La regla la escribió esta HU y no se le aplicó a su propia
// frase más fuerte, que es la que sostiene AC-1.
//
// LOS DOS `it` SON UN PAR Y NINGUNO SIRVE SOLO: el primero ejecuta la rama SIN firma y exige que no haya
// enlace; el segundo ejecuta la rama CON firma y exige que sí lo haya. Sin el segundo, borrar `TxProof`
// del comprobante dejaría al primero en verde y la mitad condicional de la frase vacía. ⚠️ Y EL FIXTURE
// DEL CASO POSITIVO INCLUYE EL CAMPO de verdad (`markPrincipalIn`), que es la lección que este repo ya
// tiene escrita como "el test del camino feliz ejercitaba el agujero".
function remesaFirmada(id: string, conFirma: boolean): RemittanceState {
  const r = Remittance.create(id, beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(
    {
      quoteId: "q",
      send: Money.of(400, "USDC"),
      receive: Money.of(1478.15, "PEN"),
      feeUsd: Money.of(0.5, "USDC"),
      rate: 3.7,
      etaMinutes: 30,
      expiresAt: "2026-07-10T00:00:00.000Z",
      provenance: "didit",
    },
    T0,
  );
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  r.applyKyc(
    {
      verificationId: "v-1",
      approved: true,
      payoutAllowed: true, realVerified: true, verifiedAt: null,
      riskLevel: "low",
      provenance: KYC_PROVENANCE_LIVE,
      identity: toPersistedIdentity({
        firstName: "Ana",
        lastNamePaternal: "Quispe",
        lastNameMaternal: "Mamani",
        documentType: "DNI",
        documentNumber: "12345678",
        dateOfBirth: "1990-01-01",
        nationality: "PE",
      }),
    },
    T0,
  );
  r.confirm(T0); // `confirmed`: firmó la autorización, `principalTx` sigue en null
  if (conFirma) r.markPrincipalIn("5xFirmaDeMentira", T0);
  return r.snapshot;
}

describe("T-063-24 (AR/BLQ-BAJO-2): la promesa del explorador se ejecuta en las DOS ramas", () => {
  it("🔴 RAMA SIN FIRMA (`confirmed`): no hay ningún enlace al explorador, y la frase no promete uno", () => {
    // La precondición del test, medida y no supuesta: esta remesa está en un estado donde la persona YA
    // firmó y el sistema NO tiene la firma. Si mañana el dominio empezara a escribir `principalTx` en
    // `confirm()`, este assert cae y hay que venir a re-leer la frase, no a ajustar el test.
    const sinFirma = remesaFirmada("rem-sin", false);
    expect(sinFirma.status, "el estado que abre la ventana").toBe("confirmed");
    expect(sinFirma.principalTx, "y el sistema no tiene ninguna firma que enlazar").toBeNull();

    render(<Receipt rem={sinFirma} onNew={() => {}} />);
    expect(screen.queryByText("Depósito en Solana"), "no hay depósito que mostrar en esta rama").toBeNull();
    expect(document.querySelectorAll('[data-testid="tx-proof"]'), "ni un solo enlace al explorador").toHaveLength(0);

    // Y la frase de la bienvenida, en la misma corrida, no puede prometer lo que acá no existe.
    cleanup();
    pintarBienvenida();
    const texto = document.body.textContent ?? "";
    expect(texto, "la versión INCONDICIONAL no puede volver").not.toContain("cada envío deja una transacción");
    expect(texto, "y la que quedó dice CUÁNDO aparece el enlace").toContain(
      "en cuanto la app tiene su firma te da el enlace para abrirla en el explorador",
    );
  });

  it("🔴 RAMA CON FIRMA (`principal_in`): el enlace está, y apunta al explorador de Solana", () => {
    // MUTANTE que este `it` mata y el otro NO: borrar la fila `{rem.principalTx ? <Row … TxProof/> }` del
    // comprobante. Sin este `it`, la mitad condicional de la frase ("te da el enlace") quedaría sin nada
    // que la sostenga y el primer `it` seguiría verde.
    const conFirma = remesaFirmada("rem-con", true);
    expect(conFirma.principalTx, "ANTIVACUIDAD: el fixture positivo TIENE que traer la firma").toBe(
      "5xFirmaDeMentira",
    );

    render(<Receipt rem={conFirma} onNew={() => {}} />);
    expect(screen.getByText("Depósito en Solana")).toBeInTheDocument();
    const enlaces = [...document.querySelectorAll('[data-testid="tx-proof"] a')] as HTMLAnchorElement[];
    expect(enlaces, "la fila del depósito trae su enlace").toHaveLength(1);
    // No se compara contra la URL que el resolver produce (sería un guard que se compara consigo mismo):
    // se exige que el `href` sea del explorador de Solana y que lleve ESTA firma.
    expect((enlaces[0] as HTMLAnchorElement).href).toContain("5xFirmaDeMentira");
    expect((enlaces[0] as HTMLAnchorElement).href).toMatch(/explorer\.solana\.com|solscan|solana/i);
  });
});

// ══ HU-068 · LOS CANDADOS DE LA BANDA DE MARCA ════════════════════════════════════════════════════
//
// ⛔ VAN AL FINAL DEL ARCHIVO, Y NO ES ORDEN ESTÉTICO: `bienvenida.tsx:153` cita
// (`PASOS_ESPERADOS`, `bienvenida-composicion.test.tsx:289`), así que un `describe` insertado más
// arriba correría ese número y rompería una cita SALIENTE — el lado que HU-066 se olvidó de mirar.
// ⛔ Y POR LO MISMO NO HAY NINGÚN `import` NUEVO EN LA CABECERA: lo que estos tests necesitan de
// `node:fs`, de `lucide-react`, de `./marca` y del splash entra con `await import(...)` adentro del
// `it`. Un import de más arriba mueve las 602 líneas de abajo y con ellas el ancla de esa cita.
//
// ⚠️ LO QUE ESTOS CUATRO NO MIDEN, dicho antes de sus asserts: ni un píxel. Corren en jsdom, que no
// hace layout y no corre Tailwind (es la misma limitación declarada arriba, y sigue siendo cierta).
// Que la banda MIDA 40px y que el documento siga en 848 lo mide el instrumento del navegador de W0/W4,
// que no es un test de este repo: es un procedimiento.

const SELECTOR_BANDA = "[data-marca-entrada]";

describe("J-AC1 (HU-068/AC-1): la entrada monta un elemento visual DE MARCA, y un ícono no cuenta", () => {
  it("la banda existe, y adentro están la marca Y el motivo de grecas", async () => {
    const { MARCA_SRC } = await import("./marca");
    pintarBienvenida();
    const banda = document.querySelector(SELECTOR_BANDA) as HTMLElement | null;
    expect(banda, `no hay ningún ${SELECTOR_BANDA} en la pantalla de entrada`).not.toBeNull();
    // Se piden los dos por separado para que el rojo diga CUÁL falta. AC-1 se conforma con uno; esta
    // HU puso los dos, así que borrar cualquiera es una regresión y no una variante.
    expect(
      (banda as HTMLElement).querySelector("img")?.getAttribute("src") ?? null,
      "el <img> de la banda tiene que servir la MISMA URL que el header ya pide",
    ).toBe(MARCA_SRC);
    expect(
      (banda as HTMLElement).querySelector("pattern"),
      "y el motivo de grecas tiene que estar en el subárbol de la banda",
    ).not.toBeNull();
  });

  it("🔴 ANTI-TRAMPA: un árbol con SÓLO los dos íconos de `lucide-react` NO satisface el selector", async () => {
    // AC-1 lo dice con todas las letras: un ícono de `lucide-react` no lo satisface, y esta pantalla
    // YA tenía dos (`ArrowRight` y `ShieldCheck`). Sin este `it`, un guard escrito como "hay algún
    // <svg>" habría dado verde desde ANTES de que la banda existiera, porque los íconos son <svg>.
    const { ArrowRight, ShieldCheck } = await import("lucide-react");
    render(
      React.createElement(
        "div",
        null,
        React.createElement(ArrowRight),
        React.createElement(ShieldCheck),
      ),
    );
    expect(
      document.querySelectorAll("svg").length,
      "ANTIVACUIDAD: el árbol de control TIENE que traer los dos íconos",
    ).toBe(2);
    expect(
      document.querySelector(SELECTOR_BANDA),
      "dos íconos de lucide no son un elemento visual de marca",
    ).toBeNull();
  });
});

describe("J-AC4 (HU-068/AC-4): los `className` de `bienvenida.tsx` hablan por ROL, y el barrido se CALIBRA", () => {
  // La PRIMERA RAMA del barrido de `ola-2-pantallas.test.tsx:94` — y NO "la misma forma" (CR/MNR-5b):
  // aquél tiene una SEGUNDA rama (`:98`) para los mapas de variantes que esta copia no tiene. Reconoce
  // `className="…"` y `className={cn(…)}` y NADA MÁS: un `className={`…`}`, un ternario o una variable
  // son INVISIBLES acá, por eso CD-12 los prohíbe en la banda y por eso existe el piso derivado de abajo.
  function clasesDe(src: string): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{cn\(([\s\S]*?)\)\})/g)) {
      out.push(m[1] ?? m[2] ?? "");
    }
    return out;
  }

  const ROLES = ["money", "title", "body", "support", "label", "mono"]; // tailwind.config.ts:77-99
  const SEPARACION = ["ajustado", "normal", "holgado", "aire"]; // tailwind.config.ts:219-224
  // Los `text-*` que NO son tamaño: colores del tema y alineación. Escritos A MANO y no derivados del
  // config, para que un `text-*` nuevo tenga que pasar por acá a propósito y no entre solo.
  const TEXT_QUE_NO_ES_TAMANO = [
    "text-cochineal",
    "text-cochineal-ink",
    "text-stone",
    "text-left",
    "text-center",
    "text-right",
  ];

  function culpables(cadenas: string[]): string[] {
    const malas: string[] = [];
    for (const cadena of cadenas) {
      for (const c of cadena.split(/\s+/).filter(Boolean)) {
        const sep = /^(space-[xy]|gap|p[trblxy]?|m[trblxy]?)-(.+)$/.exec(c);
        if (/^text-\[/.test(c)) {
          malas.push(`${c} — tamaño a mano: la escala S-1 es cerrada`);
        } else if (/^text-(xs|sm|base|lg|xl|[2-9]xl)$/.test(c)) {
          malas.push(`${c} — tamaño de fábrica: el vocabulario es por rol`);
        } else if (/^text-/.test(c) && !ROLES.includes(c.slice(5)) && !TEXT_QUE_NO_ES_TAMANO.includes(c)) {
          malas.push(`${c} — ni un rol de fontSize ni un color declarado`);
        } else if (sep !== null && !SEPARACION.includes(sep[2] as string) && sep[2] !== "auto") {
          malas.push(`${c} — separación fuera de los cuatro tokens de spacing`);
        }
      }
    }
    return malas;
  }

  it("el barrido ve TODOS los `className` del archivo (si viera menos, los dos `it` de abajo pasarían por ciegos)", async () => {
    // 🔴 ACÁ HABÍA UN PISO ESCRITO A MANO —`toBeGreaterThan(10)` contra 18 medido— Y ERA ESQUIVABLE
    // (fix-pack, AR/MNR-2). Medido: pasando 7 de las 18 cadenas a la forma que el barrido no lee, el
    // conteo quedaba en 11 > 10, el piso seguía verde, y con él un `text-sm` y un `text-[20px]` REALES
    // quedaban invisibles ⇒ **AC-4 se violaba con la suite COMPLETA en verde** (`0 failed | 2793
    // passed (2793)`). Y el comentario decía que el piso "es el conteo MEDIDO (18)" mientras el código
    // escribía 10: la prosa no describía al código, que es el defecto #1 recurrente de este repo.
    //
    // ⇒ EL PISO NO SE SUBIÓ A 18: SE DERIVA. Un 18 a mano hay que re-medirlo en cada `className` nuevo
    // y es exactamente así como el 10 de arriba se volvió falso. El derivado sale de un escaneo A
    // PROPÓSITO MÁS TONTO que el del barrido: cuenta SITIOS de atributo sin mirar la FORMA del valor.
    // Los dos escanean el mismo texto y de la misma manera —comentarios incluidos—, así que difieren
    // sólo en la forma y la igualdad afirma exactamente una cosa: **no queda ningún `className` del
    // archivo que el barrido no sepa leer**.
    // ⚠️ Y ES LO QUE VUELVE EJECUTABLE A CD-12 (prohibido el template literal en las clases de esta
    // pantalla): antes lo declaraba este archivo y no lo verificaba nada, en ninguna parte.
    // ⚠️ EL AVISO CORRECTO, dicho para que no sorprenda: un ejemplo de la forma prohibida escrito en un
    // comentario de `bienvenida.tsx` pondría esto ROJO. Es lo que se pretende —el archivo objetivo se
    // barre como texto, no como AST— y el ejemplo se escribe sin el signo igual.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/src/presentation/bienvenida.tsx`, "utf8");
    const sitios = [...src.matchAll(/className=/g)].length;
    expect(sitios, "ANTIVACUIDAD: con 0 atributos en el archivo, todo lo de abajo pasa por vacío").toBeGreaterThan(0);
    expect(
      clasesDe(src).length,
      "hay `className` que el barrido NO ve, y AC-4 queda ciego ahí. Las TRES formas dan este mismo rojo: template literal, TERNARIO (`className={x ? \"a\" : \"b\"}`, el más común de los tres en React) o variable (`className={estilo}`) ⇒ ACCIÓN: volvela a `className=\"…\"` o `className={cn(…)}`, o extendé `clasesDe` Y agregale un caso al calibrador de abajo",
    ).toBe(sitios);
  });

  it("🔴 CALIBRADOR: contra una entrada sintética, el barrido reporta LAS DOS familias", () => {
    // Sin esto el guard es indistinguible de uno roto: "no encontré nada" y "no sé mirar" dan el mismo
    // verde. La entrada trae un tamaño de fábrica Y uno a mano, que son las dos formas que AC-4 prohíbe.
    const sintetico = '<div className="text-sm text-[20px] gap-normal mx-auto">x</div>';
    const reportadas = culpables(clasesDe(sintetico));
    expect(reportadas.join(" | "), "el barrido no ve el tamaño de fábrica").toContain("text-sm");
    expect(reportadas.join(" | "), "el barrido no ve el tamaño a mano").toContain("text-[20px]");
    expect(reportadas, "y no puede inventar culpables: `gap-normal` y `mx-auto` son legales").toHaveLength(2);
  });

  it("no hay ningún tamaño de fábrica, ningún `text-[Npx]` y ninguna separación fuera de los 4 tokens", async () => {
    // INPUT QUE LO PONE EN ROJO: un `text-sm` o un `text-[20px]` en la banda; o un `gap-3` en vez de
    // `gap-normal`. `bienvenida.tsx` NO estaba cubierto por `T-O2-2`, que barre sólo `flow.tsx` y
    // `ui.tsx` (`ola-2-pantallas.test.tsx:132`): este `it` es el que cierra ese agujero.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/src/presentation/bienvenida.tsx`, "utf8");
    expect(culpables(clasesDe(src))).toEqual([]);
  });
});

describe("J-AC8 (HU-068/AC-8): la banda no lleva texto ni superficie de color propia", () => {
  it("el subárbol de la banda no tiene ningún nodo de texto no vacío, ni un `bg-*`", () => {
    pintarBienvenida();
    const banda = document.querySelector(SELECTOR_BANDA) as HTMLElement | null;
    expect(banda, "ANTIVACUIDAD: sin banda este test pasaría por vacío").not.toBeNull();
    const caminante = document.createTreeWalker(banda as HTMLElement, NodeFilter.SHOW_TEXT);
    const textos: string[] = [];
    for (let n = caminante.nextNode(); n !== null; n = caminante.nextNode()) {
      const t = (n.textContent ?? "").trim();
      if (t !== "") textos.push(t);
    }
    // Con texto encima, AC-8 deja su rama fácil: el contraste habría que medirlo contra el color
    // COMPUESTO de la banda (α·ink sobre paper), que es justo la clase de cuenta que este repo ya
    // publicó una vez contra el fondo equivocado.
    expect(textos, "la banda es decorativa: si lleva texto, AC-8 pasa a exigir 4,5:1 medido").toEqual([]);
    const conFondo = [banda as HTMLElement, ...(banda as HTMLElement).querySelectorAll("*")]
      .map((e) => e.getAttribute("class") ?? "")
      .filter((clase) => /(^|\s)bg-/.test(clase));
    expect(conFondo, "una superficie de color propia es el otro disparador de AC-8").toEqual([]);
  });
});

describe("J-DT4 (HU-068/§0.3): el splash y la app conviven en UN documento, y ningún `id` se repite", () => {
  it("🔴 montados como en `app/page.tsx:20-21`, no hay dos elementos con el mismo `id`", async () => {
    // EL BUG QUE ESTE `it` CAZA, y que ningún artefacto anterior tenía: los dos subárboles conviven
    // ~1200 ms (`splash.tsx:60`), un `id` de SVG es del DOCUMENTO y `url(#…)` resuelve al PRIMERO en
    // orden de documento. Con el `id` repetido la banda de la entrada pintaría con el `<pattern>` del
    // splash, cuyo stroke es el tono para fondo oscuro, y se vería vacía. Intermitente y atada al reloj.
    const { Splash } = await import("./splash");
    // ⚠️ `RemittanceFlow` va en JSX y el splash por `createElement`: con los DOS por `createElement`,
    // `tsc` rechaza el `container` (TS2769, "'container' does not exist in type 'Attributes'") y la
    // suite pasa igual porque vitest no tipa. Medido en W3: `npm test` verde con `npm run typecheck`
    // en exit 2. El `createElement` queda sólo donde hace falta, que es el import dinámico.
    render(
      <>
        {React.createElement(Splash)}
        <RemittanceFlow container={buildTestContainer()} />
      </>,
    );
    // La PRECONDICIÓN, medida y no supuesta: si los dos `<pattern>` no convivieran, este test no
    // estaría midiendo el bug y daría verde igual.
    expect(
      document.querySelectorAll("pattern").length,
      "los dos motivos tienen que estar en el documento a la vez, o esto no mide nada",
    ).toBe(2);
    const conId = [...document.querySelectorAll("[id]")];
    expect(
      conId.length,
      "ANTIVACUIDAD: con 0 elementos con `id`, cualquier cosa pasaría",
    ).toBeGreaterThanOrEqual(2);
    const ids = conId.map((e) => e.id);
    expect(
      ids.filter((v, i) => ids.indexOf(v) !== i),
      "un `id` repetido hace que `url(#…)` resuelva al primero del documento y no al propio",
    ).toEqual([]);
  });
});

// ── HU-068 · LOS MUTANTES DE ESTA HU: APLICADOS Y CORRIDOS SOBRE 21 TESTS ──────────────────────────
//
// ⚠️ ESTA TABLA ES DE LA CORRIDA DE **21** TESTS, o sea el árbol de ANTES del fix-pack post-AR. No se
// re-corrió: sobrescribir sus totales sin volver a correrlos sería publicar como medido algo que no medí.
// Los números del árbol de hoy (**22** tests) están en la tabla del final del archivo.
//
// Cada uno se editó en el árbol, se verificó que la sustitución OCURRIÓ leyendo el texto resultante (un
// ancla que aparece dos veces no se sustituye y el `sed` sale 0 igual: dos de estos diez fallaron esa
// verificación en el primer intento y NO se corrieron hasta arreglarla), se corrió este archivo y se
// restauró comparando **md5**. Control sin mutante, en la misma tanda: **21 passed (21)**.
//
//   MUTANTE APLICADO                                                         RESULTADO MEDIDO
//   M4.  `PASOS` con dos renglones en vez de tres                            3 failed | 18 passed (21)
//   M5a. el renglón 2 sin la mitad de la identidad (sólo el código)           1 failed | 20 passed (21)
//   M6.  `onContinue` de `review` salta `verify` (`flow.tsx:384`)             1 failed | 20 passed (21)
//   J-AC1a. la banda sin su `data-*` estable (inalcanzable)                   2 failed | 19 passed (21)
//   J-AC1b. 🔴 la banda pasa a ser un `<ShieldCheck />`                       2 failed | 19 passed (21)
//   J-AC4a. `text-[20px]` en el `className` de la banda                      1 failed | 20 passed (21)
//   J-AC4b. `text-sm` en el `className` de la banda                          1 failed | 20 passed (21)
//   J-AC4c. 🔴 el BARRIDO ciego (se rompe el regex de `clasesDe`)             2 failed | 19 passed (21)
//   J-AC8.  un `<p>Envíos seguros</p>` encima de la banda                    1 failed | 20 passed (21)
//   J-DT4.  la banda con el `id="chaski-qhapaq-nan"` del splash              1 failed | 20 passed (21)
//
// 🔴 Y LOS DOS QUE SOBREVIVIERON, que valen más que los diez que murieron:
//
//   M5b. el renglón 2 sin la identidad **en el código Y en la tabla a la vez**  0 failed | 21 passed
//        ⇒ NADA en esta suite obliga al renglón 2 a nombrar la verificación de identidad si quien lo
//        cambia edita también la fila de `PASOS_ESPERADOS`. La `sonda` camina `verify` y `confirm`
//        diga lo que diga la frase: protege que el FLUJO no pierda el paso, no que el COPY no pierda la
//        afirmación. Eso último lo sostiene una persona leyendo la tabla, que es su diseño declarado
//        («las frases van escritas acá, letra por letra»), y así queda dicho en vez de suponerse.
//   J-AC4c(1ª versión). borrar SÓLO la rama `/^text-\[/` del barrido              0 failed | 21 passed
//        ⇒ no es un agujero: `text-[20px]` cae en la rama siguiente («ni un rol ni un color declarado»)
//        y se sigue reportando. O sea que la cobertura es REDUNDANTE, no ciega. El mutante que sí lo
//        mata es el de arriba (romper el regex), y por eso el calibrador se escribió contra el barrido
//        ENTERO y no contra una rama.

// ── FIX-PACK AR/MNR-1 · EL EJE QUE ESTA HU INAUGURÓ, Y QUE ERA EL ÚNICO SIN CANDADO ────────────────
//
// 🔴 POR QUÉ EXISTE ESTE `it`, con el número que lo pide. `Grecas` tiene DOS tonos y el sitio de llamada
// elige uno: (`Grecas`, `./bienvenida.tsx:212`). Cambiar ese literal a `sobre-oscuro` SOBREVIVÍA a la
// suite COMPLETA —medido en el fix-pack: `0 failed | 2793 passed (2793)`, y ningún test del repo
// mencionaba `tono`, `sobre-claro`, `sobre-oscuro` ni `TonoDeGrecas`—. Lo que pinta el tono equivocado es
// `#FBFAF7` al 5% sobre `paper` `#FBFAF7`: contraste **1,0000:1**, el color EXACTO del fondo. O sea la
// misma banda invisible que el bug del `id` que caza `J-DT4`, sólo que PERMANENTE en vez de durar los
// 1200 ms del splash. Y el piso que lo prohíbe —1,15:1, en el docblock de (`TONOS`, `./grecas.tsx:55`)—
// era prosa sin test: esta HU **creó** el eje configurable (antes el tono era un literal adentro del
// splash y no se podía equivocar) y gastó su candado en el eje hermano.
//
// ⚠️ NO COMPARA CONTRA EL LITERAL DEL TONO, y no es elegancia. Un `expect(stroke).toBe("#17130F")` afirma
// "es el color que escribí", que es un guard comparándose consigo mismo. Este `it` mide la PROPIEDAD que
// el módulo declara normativa —el contraste del color COMPUESTO contra la superficie que la banda tiene
// debajo— así que también se pone rojo si cambia la opacidad, si cambia el hex de `paper`, o si el
// `<body>` deja de pintar `paper`. Los tres cambian la conclusión y ninguno toca el literal del tono.
//
// ⚠️ LÍMITE, CON ESTAS PALABRAS (AR/MNR-7): esto NO mide que el motivo se VEA. El piso 1,15 y el techo
// 1,60 son un criterio convertido en número —el propio docblock de `TONOS` lo dice de sí mismo— y el
// tono elegido da **1,2301:1** componiendo en float, que es lo que hace este `it` (**1,2296:1** si el
// compuesto se redondea a hex, o sea #E4E3E0, que es lo que el navegador termina pintando; las dos
// cifras redondean al 1,230 publicado). En los dos casos el margen sobre el piso es **0,08**, y el piso
// lo declaró este mismo repo, no una norma externa. NADIE lo vio en
// un teléfono real: el instrumento de toda esta HU es Chrome headless con el viewport puesto a mano.
// Este `it` verifica que la banda esté DENTRO de la ventana declarada, no que la ventana sea la
// correcta. ⛔ El tono no se cambia sin medir: mirar la pantalla una vez en un teléfono real es la
// única verificación que puede refutar el 1,15, y sigue sin hacerse.
describe("J-MNR1 (fix-pack AR/MNR-1): el tono de la banda cae DENTRO de la ventana de contraste declarada", () => {
  const PISO = 1.15;
  const TECHO = 1.6;

  function canales(hex: string): readonly number[] {
    return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  }

  /** Luminancia relativa WCAG 2.x. Canales 0-255 en FLOAT: la composición no se redondea a hex. */
  function luminancia(rgb: readonly number[]): number {
    const [r, g, b] = rgb.map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
  }

  function contraste(a: readonly number[], b: readonly number[]): number {
    const la = luminancia(a);
    const lb = luminancia(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** `tinta` a opacidad `alfa` sobre `fondo`: lo que el navegador compone al aplicar `opacity-[…]`. */
  function compuesto(tinta: string, fondo: string, alfa: number): readonly number[] {
    const t = canales(tinta);
    const f = canales(fondo);
    return [0, 1, 2].map((i) => (t[i] as number) * alfa + (f[i] as number) * (1 - alfa));
  }

  it("🔴 el par (stroke, opacidad) que la banda RENDERIZA da entre 1,15:1 y 1,60:1 contra el fondo real", async () => {
    const { readFileSync } = await import("node:fs");
    // (1) EL FONDO NO SE ESCRIBE ACÁ: sale del tema. Y que ese sea el fondo de la banda tampoco se
    //     supone: la banda no tiene superficie propia (eso lo fija `J-AC8`), así que abajo tiene la del
    //     `<body>`, y eso se lee del archivo.
    const tema = readFileSync(`${process.cwd()}/tailwind.config.ts`, "utf8");
    const paper = /^\s*paper:\s*"(#[0-9A-Fa-f]{6})"/m.exec(tema)?.[1] ?? "";
    const ink = /^\s*ink:\s*"(#[0-9A-Fa-f]{6})"/m.exec(tema)?.[1] ?? "";
    expect(paper, "ANTIVACUIDAD: sin `paper` leído del tema no hay contra qué medir").toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(ink, "ANTIVACUIDAD: el calibrador de abajo necesita la tinta del tema").toMatch(/^#[0-9A-Fa-f]{6}$/);
    const layout = readFileSync(`${process.cwd()}/app/layout.tsx`, "utf8");
    expect(
      /<body className="[^"]*\bbg-paper\b/.test(layout),
      "PRECONDICIÓN: si el `<body>` deja de pintar `paper`, este número mide contra otro fondo",
    ).toBe(true);
    // (2) CALIBRADOR EN LAS DOS DIRECCIONES, con los hex del propio tema. Sin esto una fórmula rota
    //     aplaude: una que devolviera 1,5 fijo entra en la ventana y este `it` daría verde igual.
    expect(
      contraste(compuesto(ink, paper, 0), canales(paper)),
      "CALIBRADOR: a opacidad 0 el compuesto ES el fondo y tiene que caer bajo el piso",
    ).toBeLessThan(PISO);
    expect(
      contraste(compuesto(ink, paper, 1), canales(paper)),
      "CALIBRADOR: a opacidad 1 es tinta plena y tiene que pasarse del techo",
    ).toBeGreaterThan(TECHO);
    // (3) EL PAR SALE DEL DOM RENDERIZADO, no de la tabla `TONOS`.
    pintarBienvenida();
    const banda = document.querySelector(SELECTOR_BANDA) as HTMLElement | null;
    expect(banda, `no hay ningún ${SELECTOR_BANDA} en la pantalla de entrada`).not.toBeNull();
    const svg = (banda as HTMLElement).querySelector("svg");
    const stroke = (banda as HTMLElement).querySelector("pattern path")?.getAttribute("stroke") ?? "";
    const alfa = Number.parseFloat(/opacity-\[([\d.]+)\]/.exec(svg?.getAttribute("class") ?? "")?.[1] ?? "");
    expect(stroke, "el motivo tiene que traer su stroke en hex de 6 dígitos").toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(alfa > 0 && alfa <= 1, "y su opacidad tiene que poder leerse de la clase del svg").toBe(true);
    // (4) LA MEDICIÓN. Con `tono="sobre-oscuro"` esto da 1,0000 y el piso lo pone rojo.
    const medido = contraste(compuesto(stroke, paper, alfa), canales(paper));
    expect(
      medido,
      `el motivo da ${medido.toFixed(4)}:1 sobre ${paper} y el piso declarado es ${PISO}:1`,
    ).toBeGreaterThanOrEqual(PISO);
    expect(
      medido,
      `el motivo da ${medido.toFixed(4)}:1 y el techo es ${TECHO}:1 (arriba compite con el texto tenue)`,
    ).toBeLessThanOrEqual(TECHO);
  });
});

// ── FIX-PACK POST-AR · LOS 8 MUTANTES, SOBRE 22 TESTS ──────────────────────────────────────────────
//
// Mismo protocolo que la tabla de arriba: cada mutante se aplicó al árbol, se verificó **leyendo el texto
// resultante** que la sustitución ocurrió (nunca por el exit del comando), se corrió, y se restauró desde
// una copia previa comparando `md5sum`. ⛔ Nunca con `git checkout --`: no restaura el pre-mutante de un
// archivo que uno mismo editó, y en W2 de esta HU casi se llevó el trabajo.
// Control sin mutante, en la misma tanda: **22 passed (22)**, y la suite completa **2794 passed (2794)**
// en 3 corridas seguidas.
//
//   MUTANTE APLICADO                                                          RESULTADO MEDIDO
//   ── los dos que el AR pidió cerrar, medidos en la SUITE COMPLETA ────────────────────────────────────
//   MNR-1. `tono="sobre-claro"` ⇒ `"sobre-oscuro"`        ANTES: 0 failed | 2793 passed  (SOBREVIVÍA)
//                                                         AHORA: 1 failed | 2793 passed (2794)
//   MNR-2. 7 de las 18 clases a template literal, con un  ANTES: 0 failed | 2793 passed  (SOBREVIVÍA,
//          `text-sm` y un `text-[20px]` VIVOS adentro            y AC-4 quedaba ciego)
//                                                         AHORA: 1 failed | 2793 passed (2794)
//                                                         («expected 11 to be 18»)
//   ── cuatro más contra el `it` nuevo, para que no se lea como "compara dos literales" ────────────────
//   `opacity-[0.10]` ⇒ `opacity-[0.05]` (stroke intacto)              1 failed | 21 passed (22)
//   `opacity-[0.10]` ⇒ `opacity-[0.30]`                               1 failed | 21 passed (22)
//   el `<body>` de `app/layout.tsx` pinta `bg-card`                   1 failed | 21 passed (22)
//   la fórmula de contraste devuelve 1,5 FIJO (ataque al calibrador)  1 failed | 21 passed (22)
//   ── y dos sobre la cita nueva de `grecas.tsx`, que es lo que mide por qué se ancló ──────────────────
//   la cita anclada con el número corrido a `:296`        1 failed | 8 passed (9) en `citas-ancladas`
//   la MISMA cita de vuelta a la forma SUELTA             0 failed | 9 passed (9) ⇒ nadie la miraría
//
// 🔴 LO QUE SIGUE SIN CANDADO, DICHO ACÁ PARA NO REPETIR EL DEFECTO QUE ESTE FIX-PACK VINO A ARREGLAR:
//   · El COPY de los tres renglones. Vaciarlos a una letra, sincronizando `PASOS_ESPERADOS`, deja la suite
//     COMPLETA en `0 failed | 2793 passed`. Está decidido así (DT-5): el candado camina el FLUJO. Lo que
//     se corrigió es la PROSA de AC-5, que prometía un candado que no existe — no la cobertura.
//   · CD-12 en `grecas.tsx`. El barrido de `J-AC4` lee **sólo `bienvenida.tsx`**, así que la forma del
//     `className` de `grecas.tsx` la sostiene la revisión.
//   · El parseo del `stroke` del `it` nuevo: no se mutó un `<path>` sin `stroke` legible.
//   · 🔴 CR/MNR-4 — LA ESCAPATORIA QUE QUEDA EN ESTE MISMO ARCHIVO, Y EL CALIBRADOR NO LA CAZA: el piso
//     derivado de arriba cerró la de BAJAR un literal, pero ENSANCHAR el regex de `clasesDe` (`:669`) de
//     `\{cn\((...)\)\}` a `\{(...)\}` restaura la igualdad `clasesDe === sitios` y vuelve a CEGAR AC-4,
//     con este archivo en VERDE. Medido por simulación (no ejecutando el `it` mutado): sobre una fuente con
//     un `text-sm` y un `text-[20px]` VIVOS dentro de un ternario, el regex de hoy da 2/3 ⇒ ROJO, el ancho
//     da 3/3 ⇒ VERDE y `culpables()` devuelve `[]`; y el CALIBRADOR de `:736-744` sigue dando sus 2
//     culpables con el regex ancho, así que NO lo distingue. Es menor que la del 10 —aquélla se disparaba
//     editando el archivo OBJETIVO, ésta exige editar el GUARD a propósito— y por eso queda declarada acá
//     en vez de arreglada. Si algún día se cierra: un caso de calibrador con `className={x ? "text-sm" : "a"}`
//     que exija que `clasesDe` NO lo capture.
