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
// Y el control que hace honesta a esa mejora, porque "llené la pantalla" es fácil de conseguir mal:
// la bienvenida NO quedó más alta que la pantalla a la que lleva. Altura del documento medida en el
// mismo build, en tres teléfonos:
//
//     375x667   bienvenida 853px   ·   send 856px
//     390x844   bienvenida 853px   ·   send 844px
//     412x915   bienvenida 915px   ·   send 915px
//
// O sea: donde la bienvenida scrollea, el formulario ya scrolleaba (y por más). La pantalla nueva no
// introduce una clase de dispositivo donde la app deje de caber.
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
// ── LOS SIETE MUTANTES: APLICADOS Y CORRIDOS, no razonados ──────────────────────────────────────────
// Cada uno se editó en el árbol, se corrió este archivo (11 tests) y se anotó la salida. No es una
// lista de lo que "debería" fallar: son los conteos de la corrida.
//
//   MUTANTE APLICADO                                                        RESULTADO MEDIDO
//   1. la raíz sin `justify-center` (vuelve a quedar anclada arriba)         1 failed | 10 passed (11)
//   2. la raíz con `min-h-full` en vez de `flex-1` (la clase INERTE)         2 failed |  9 passed (11)
//   3. el `motion.div` de vuelta a `flex-1` a secas (sin `flex flex-col`)    1 failed | 10 passed (11)
//   4. `PASOS` con dos renglones en vez de tres                             3 failed |  8 passed (11)
//   5. el renglón 2 sin la mitad de la identidad                            1 failed | 10 passed (11)
//   6. `onContinue` de `review` saltando `verify` (`flow.tsx:384`)           1 failed | 10 passed (11)
//   7. la nota de la red borrada                                            2 failed |  9 passed (11)
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
import { RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { TEST_CCI } from "../test-support/fakes";

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
const PASOS_ESPERADOS = [
  {
    frase: "Ponés cuánto querés enviar y el CCI de la cuenta en Perú.",
    // El paso `send` pide exactamente esos dos datos, y los dos se buscan por su etiqueta real.
    sonda: () => {
      expect(screen.getByLabelText("Monto en dólares")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("002 193 004455667788 99")).toBeInTheDocument();
    },
  },
  {
    frase: "Verificás tu identidad una sola vez y firmás el envío desde tu billetera.",
    // Las dos mitades son dos pasos distintos del flujo (`verify` y `confirm`), y las dos se caminan.
    sonda: () => {
      /* la sonda de este renglón es el recorrido de T-063-10b, que llega hasta los dos botones */
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
    sonda: () => {
      /* ídem: la sonda es el último tramo del recorrido de T-063-10b */
    },
  },
] as const;

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
    pintarBienvenida();
    fireEvent.click(screen.getByRole("button", { name: /Empezar un envío/ }));

    // Renglón 1 · el monto y el CCI.
    PASOS_ESPERADOS[0].sonda();
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
    expect(
      await screen.findByRole("button", { name: /Verificar mi identidad/ }),
      "el renglón 2 anuncia una verificación de identidad: el flujo tiene que tenerla",
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Verificar mi identidad/ }));
    const firmar = await screen.findByRole("button", { name: /Confirmar y enviar/ });
    expect(firmar, "y el renglón 2 también anuncia una firma").toBeInTheDocument();

    // Renglón 3 · después de firmar el flujo NO termina: hay un tramo de seguimiento.
    //
    // ⚠️ LA SONDA ES EL TRAMO, NO EL DESENLACE, y es deliberado: con los dobles por defecto el pago
    // falla (`FakePayoutGateway`), así que el TEXTO de estado que aparece depende de la rama y asertar
    // uno lo ataría a este doble. Lo que el renglón 3 afirma, y lo que vale en todas las ramas, es que
    // hay un cuarto tramo después de la firma. El stepper lo anuncia con texto real (un `sr-only`, no
    // un `aria-label` sobre un `<div>` genérico, que es el arreglo que ya vive en `Stepper`).
    fireEvent.click(firmar);
    expect(
      await screen.findByText("Paso 4 de 4"),
      "el renglón 3 anuncia un seguimiento: después de firmar el flujo tiene que seguir",
    ).toBeInTheDocument();
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

describe("T-063-12 (2º pase): la pantalla nombra la red, y es la que va a firmar", () => {
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
