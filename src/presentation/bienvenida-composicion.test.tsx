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
// 🔴 Y ACÁ SE CAYÓ UNA CONCLUSIÓN, MEDIDA, POR CULPA DE OTRO ARREGLO DE ESTE MISMO FIX-PACK. La tabla de
// alturas de documento decía `bienvenida 853px · send 856px` a 375x667, y con eso se afirmaba *"donde la
// bienvenida scrollea, el formulario ya scrolleaba (y por más)"*. Condicionar la frase del `<Aviso>`
// (AR/BLQ-BAJO-2) le sumó un renglón a la tarjeta, así que el documento de la bienvenida pasó a **870px**
// y la afirmación se INVIRTIÓ. Re-medido al cierre del fix-pack, mismo build, misma calibración:
//
//     viewport    bienvenida    send      recuperar    ¿scrollea a ese alto?
//     375x667        870px      856px       811px      las TRES (viewport 667)
//     390x844        870px      844px       844px      sólo la bienvenida (870 > 844)
//     412x915        915px      915px       915px      ninguna
//
// LO QUE SE PUEDE AFIRMAR, y es menos de lo que se afirmaba: a 375x667 la bienvenida es la MÁS ALTA de
// las tres, no la más baja. Lo que sostiene `justify-center` no es esa comparación sino el mecanismo, y
// eso sí está medido: a 375x667 la tinta va de 24px a 830px dentro de un documento de 870px, o sea
// ENTERA adentro — `min-height:auto` no puede recortar, y si recortara el contenido arrancaría por
// encima de 0. El detalle está en el docblock de `bienvenida.tsx`.
// ⚠️ El `send 856px` es correcto y se re-midió (era el número que un CR puso en duda: el árbol tenía 856
// acá y 834 en los dos archivos de `recuperar`, y el par equivocado era el de allá). Lo que cambió no fue
// ese lado de la comparación sino el otro, y por eso tener el 856 bien ya no alcanza para la frase vieja.
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
// ⚠️ LOS OCHO SE RE-CORRIERON EN EL FIX-PACK, porque el archivo pasó de **11 a 13 tests** (los dos de
// `T-063-24`) y un total viejo (`… (11)`) ya no describe este árbol. Un conteo de mutación es relativo
// al tamaño de la suite y agregar tests lo invalida sin que nada se ponga rojo.
//
//   MUTANTE APLICADO                                                        RESULTADO MEDIDO
//   1. la raíz sin `justify-center` (vuelve a quedar anclada arriba)         1 failed | 12 passed (13)
//   2. la raíz con `min-h-full` en vez de `flex-1` (la clase INERTE)         2 failed | 11 passed (13)
//   3. el `motion.div` de vuelta a `flex-1` a secas (sin `flex flex-col`)    1 failed | 12 passed (13)
//   4. `PASOS` con dos renglones en vez de tres                             3 failed | 10 passed (13)
//   5. el renglón 2 sin la mitad de la identidad                            1 failed | 12 passed (13)
//   6. `onContinue` de `review` saltando `verify` (`flow.tsx:384`)           1 failed | 12 passed (13)
//   7. la nota de la red borrada                                            2 failed | 11 passed (13)
//   8. la fila `TxProof` del depósito borrada del comprobante (fix-pack)     1 failed | 12 passed (13)
//
// ⚠️ EL 2 MATA DOS Y ES EL QUE MÁS ENSEÑA: rompe el `it` que prohíbe `min-h-full` y también el que
// exige `flex-1`, o sea que la clase inerte no puede entrar disfrazada de "otra forma de escribirlo".
// Y el 6 es el único que toca el FLUJO y no el texto: es el que impide que este archivo sea un test de
// ortografía. Los mutantes 1 y 3 se corrieron además contra la suite COMPLETA (138 archivos): fuera de
// este archivo NADIE los ve, y eso es el dato — antes de este pase la composición vertical de la
// pantalla de entrada no la vigilaba ningún test.
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import React from "react";
import { Receipt, RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { Money } from "../domain/money";
import { Remittance, type RemittanceState, toPersistedIdentity } from "../domain/remittance";
import { FAKE_SOLANA_BENEFICIARY, TEST_CCI, T0, beneficiary } from "../test-support/fakes";
import { KYC_PROVENANCE_LIVE } from "../infrastructure/didit/decision";

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
const PASOS_ESPERADOS: readonly { frase: string; sonda: (s: Sondeo) => Promise<void> }[] = [
  {
    frase: "Ponés cuánto querés enviar y el CCI de la cuenta en Perú.",
    // El paso `send` pide exactamente esos dos datos, y los dos se buscan por su etiqueta real.
    sonda: async () => {
      expect(screen.getByLabelText("Monto en dólares")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("002 193 004455667788 99")).toBeInTheDocument();
    },
  },
  {
    frase: "Verificás tu identidad una sola vez y firmás el envío desde tu billetera.",
    // Las dos mitades son dos pasos distintos del flujo (`verify` y `confirm`), y las dos se caminan:
    // primero la identidad, y DESPUÉS de avanzar, la firma. El orden es parte de lo que el renglón dice.
    sonda: async ({ seguir }) => {
      expect(
        await screen.findByRole("button", { name: /Verificar mi identidad/ }),
        "el renglón 2 anuncia una verificación de identidad: el flujo tiene que tenerla",
      ).toBeInTheDocument();
      await seguir();
      expect(
        await screen.findByRole("button", { name: /Confirmar y enviar/ }),
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
    frase: "Seguís el envío desde la app, con su estado a la vista.",
    // ⚠️ LA SONDA ES EL TRAMO, NO EL DESENLACE, y es deliberado: con los dobles por defecto el pago
    // falla (`FakePayoutGateway`), así que el TEXTO de estado que aparece depende de la rama y asertar
    // uno lo ataría a este doble. Lo que el renglón 3 afirma, y lo que vale en todas las ramas, es que
    // hay un cuarto tramo después de la firma. El stepper lo anuncia con texto real (un `sr-only`, no
    // un `aria-label` sobre un `<div>` genérico, que es el arreglo que ya vive en `Stepper`).
    sonda: async ({ seguir }) => {
      await seguir();
      expect(
        await screen.findByText("Paso 4 de 4"),
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
      fireEvent.click(await screen.findByRole("button", { name: nombre }));
    };
    pintarBienvenida();
    fireEvent.click(screen.getByRole("button", { name: /Empezar un envío/ }));

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
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));
    await screen.findByText(/Revisá el envío/);
    fireEvent.click(await screen.findByRole("button", { name: /Continuar/ }));

    // Renglón 2 · la identidad primero y la firma después, en ese orden y con ese nombre.
    await (PASOS_ESPERADOS[1] as { sonda: (s: Sondeo) => Promise<void> }).sonda({
      seguir: tocar(/Verificar mi identidad/),
    });

    // Renglón 3 · después de firmar el flujo NO termina: hay un tramo de seguimiento.
    await (PASOS_ESPERADOS[2] as { sonda: (s: Sondeo) => Promise<void> }).sonda({
      seguir: tocar(/Confirmar y enviar/),
    });
  });

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
      payoutAllowed: true,
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
