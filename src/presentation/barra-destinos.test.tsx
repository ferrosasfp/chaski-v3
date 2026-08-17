// @vitest-environment jsdom
//
// WKH-063 — LA PRIMERA PANTALLA Y LA BARRA DE DESTINOS.
//
// 🔴 EL DEFECTO QUE CIERRAN, medido en el árbol de `ce4f31e`: `useState<Step>("send")`. La app abría
// DIRECTO en el formulario, así que lo primero que veía una persona era "Paso 1 de 4" y una entrada de
// monto, sin una línea sobre qué es esto ni por qué entregarle una billetera. Y no había ninguna
// navegación: las tres puertas a lo que ya existe (el historial y las dos de recuperación) eran tres
// enlaces subrayados al pie de ese mismo formulario, con la misma métrica que el CTA.
//
// ⚠️ QUÉ MIDEN ESTOS TESTS Y QUÉ NO, declarado y no disfrazado. Acá no corre Tailwind y jsdom NO hace
// layout:
//   · SÍ prueban qué se renderiza, con qué texto y en qué ORDEN de documento (que es lo que hace
//     falsable "no tapa la acción principal").
//   · SÍ prueban la PARTICIÓN de la máquina de `Step` entre pasos del flujo y destinos, recorriendo
//     `STEP_INDEX` entero contra una tabla escrita a mano.
//   · NO prueban que la barra se VEA al pie de la pantalla, ni que respete el inset del gesto. Eso
//     depende de Tailwind y del navegador; del lado del tema lo cuida `area-segura.test.tsx`.
//   · NO prueban el alto de toque de la pestaña: eso es `touch-targets.test.tsx`, que la mide como una
//     de las tres puertas de recuperar plata.
//   · NO prueban la jerarquía (`primary`) de las pantallas nuevas: eso es `jerarquia-relativa.test.tsx`,
//     que ganó una fila por cada una.
//
// 🔴 REGLA DE ESTE ARCHIVO: cada test nombra la edición que lo pone en rojo, y los DIEZ mutantes se
// APLICARON Y SE CORRIERON, uno por uno, sobre el árbol de esta rama (este archivo en 30 tests). No es
// una lista de lo que "debería" fallar: es la salida de correrlos.
//
//   MUTANTE APLICADO                                                    RESULTADO MEDIDO
//   1. `pasoInicial = "send"` como default de `RemittanceFlow`          7 failed | 23 passed (30)
//   2. el CTA de la bienvenida llamando a `setStep("connect")`          3 failed | 27 passed (30)
//   3. `app/page.tsx` pasando `pasoInicial="send"`                      1 failed | 29 passed (30)
//   4. la barra pintada sin el guard `esDestino(step)`                  8 failed | 22 passed (30)
//   5. `esDestino` devolviendo `true` también para `"done"`             2 failed | 28 passed (30)
//   6. una cuarta pestaña, y que además es una acción                   3 failed | 27 passed (30)
//   7. la frase de custodia de vuelta ARRIBA del CTA en `connect`       2 failed | 28 passed (30)
//   8. `DEMO_PILL` con otro texto                                       1 failed | 29 passed (30)
//
// Y los dos que este archivo NO mata, porque los ACs que tocan viven en otros candados. Se corrieron
// igual, y contra los archivos que sí los miran, para no dejar el par sin medir:
//   9. la pestaña sin su `min-h-[52px]` (AC-5)   ⇒ touch-targets + jerarquia:  3 failed | 17 passed (20)
//  10. la pestaña con el peso del CTA (AC-8)     ⇒ jerarquia-relativa:         1 failed | 15 passed (16)
//
// ⚠️ EL 7 MATA DOS Y NO UNO, y vale anotarlo: la frase duplicada rompe también el `getByText` del
// primer `it` del bloque, por ambigüedad. O sea que el mutante "moverla arriba" y el mutante
// "duplicarla" no se distinguen desde acá; lo que sí queda clavado es que abajo del CTA hay UNA.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { RemittanceFlow, STEP_INDEX } from "./flow";
import { DESTINOS, esDestino } from "./barra-destinos";
import { buildTestContainer } from "../test-support/test-container";
import {
  FakeKycGateway,
  FakeSolanaCloseableEscrowLister,
  FakeSolanaEscrowRefundGateway,
  FakeSolanaWallet,
  TEST_CCI,
} from "../test-support/fakes";
import { KYC_PROVENANCE_LIVE } from "../infrastructure/didit/decision";

// El MISMO doble que `flow.test.tsx` y `jerarquia-relativa.test.tsx`: sin él el `exit` de
// AnimatePresence no completa en el mismo tick y el cambio de pantalla no se puede seguir con `get*`.
// Lista CERRADA: lo que no esté acá no existe para este archivo.
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

const ROOT = process.cwd();

/** El container con las dos puertas de la cadena cableadas, que es lo que hace visible "Recuperar". */
const conLasDosPuertas = () => {
  const refund = new FakeSolanaEscrowRefundGateway();
  const lister = new FakeSolanaCloseableEscrowLister([]);
  return {
    refund,
    lister,
    container: buildTestContainer({
      wallet: new FakeSolanaWallet(),
      solanaRefund: refund,
      solanaCloseableEscrows: lister,
    }),
  };
};

/** La barra, o `null`. Se busca por ROL y nombre accesible, no por una clase. */
const barra = () => screen.queryByRole("navigation", { name: "Destinos" });

// ══ AC-1 · LA PANTALLA DE CONFIANZA ES LA PRIMERA ═══════════════════════════════════════════════

describe("T-063-1 (AC-1): la app arranca en la pantalla de confianza, no en el formulario", () => {
  it("sin nada en curso, lo primero es la afirmación de custodia y NO la entrada de monto", () => {
    // MUTANTE 1 (aplicado): `pasoInicial = "send"` como default ⇒ este `it` se pone rojo por los dos
    // lados a la vez, el que falta y el que sobra. Sin la segunda mitad, "agregar la pantalla nueva
    // ANTES del formulario" y "agregar la pantalla nueva AL LADO del formulario" darían lo mismo.
    render(<RemittanceFlow container={buildTestContainer()} />);

    expect(screen.getByRole("heading", { name: "Tu plata no pasa por Chaski" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Nombre de tu familiar")).toBeNull();
    expect(screen.queryByLabelText("Monto en dólares")).toBeNull();
  });

  it("las tres afirmaciones están, y son las que se pueden verificar", () => {
    // No es una repetición del `it` de arriba: aquél mide DÓNDE está la pantalla, éste QUÉ dice. La
    // pantalla podría ser la primera y decir "confiá en nosotros", que es exactamente lo que no puede
    // decir. Las tres frases se buscan por texto porque son el contrato con la persona.
    //
    // MUTANTE: reemplazar "no hace falta creernos" por cualquier afirmación de confianza ("somos una
    // empresa registrada", "miles de familias nos eligen") ⇒ rojo. Es la frase más fuerte de la
    // pantalla justamente porque NO afirma que seamos confiables: señala dónde ir a comprobarlo.
    render(<RemittanceFlow container={buildTestContainer()} />);

    expect(
      screen.getByText(/tus USDC quedan en un contrato en Solana/),
      "dónde queda la plata",
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Chaski nunca los tiene en una cuenta propia/),
      "el límite concreto de la custodia",
    ).toBeInTheDocument();
    expect(
      screen.getByText(/no hace falta creernos: cada envío deja una transacción que podés abrir en el explorador/),
      "dónde se verifica, que es lo que hace verificable a las otras dos",
    ).toBeInTheDocument();
  });

  it("no muestra monto ni tasa: no hay ninguna cotización que ofrecer todavía", () => {
    // AC-1 lo pide explícito. Una cifra acá sería una cotización que nadie pidió y que caduca sola; y
    // el `$400` del default del formulario aparecería como si fuera una oferta.
    //
    // MUTANTE: pintar `<Money>` con el monto por defecto en la bienvenida ⇒ rojo.
    render(<RemittanceFlow container={buildTestContainer()} />);
    const texto = document.body.textContent ?? "";
    expect(texto).not.toMatch(/S\/\s?[\d,]+\.\d{2}/); // el monto en soles
    expect(texto).not.toMatch(/\$\s?\d/); // el monto en dólares
    expect(texto).not.toMatch(/1 USD ≈/); // la tasa
  });

  it("el titular es un `<h2>` y el `<h1>` sigue siendo uno solo (el de la app)", () => {
    // La pantalla nueva es la primera parada de quien navega por encabezados, así que tiene que ser
    // un encabezado de verdad. Y no puede haber dos `<h1>`: es el candado de `titulos.test.tsx`, que
    // esta HU no puede romper agregando una pantalla con su propio título de app.
    render(<RemittanceFlow container={buildTestContainer()} />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: "Tu plata no pasa por Chaski" })).toBeInTheDocument();
  });

  it("el stepper NO se pinta acá: no es el paso 1 de nada", () => {
    // La mitad visual del defecto que AC-1 cierra. `STEP_INDEX` sigue teniendo fila para los tres
    // destinos (el tipo la exige), así que esto no lo garantiza el compilador: lo garantiza el
    // `esDestino(step)` del sitio de render.
    //
    // MUTANTE: sacar ese ternario ⇒ "Paso 1 de 4" vuelve a ser lo primero de la app ⇒ rojo.
    render(<RemittanceFlow container={buildTestContainer()} />);
    expect(screen.queryByText(/Paso 1 de 4/)).toBeNull();
  });
});

// ══ AC-2 · LA ACCIÓN LLEVA AL FORMULARIO, POR LA MÁQUINA DE `Step` ══════════════════════════════

describe("T-063-2 (AC-2): la acción de la bienvenida entra al formulario", () => {
  it("«Empezar un envío» monta el paso `send`, con su entrada de monto", () => {
    // MUTANTE 2 (aplicado): que el CTA haga `setStep("connect")` en vez de `"send"` ⇒ rojo. Un test
    // que sólo verificara "la bienvenida desapareció" lo dejaría pasar, y el salto a `connect` sin
    // monto ni beneficiario es un callejón.
    render(<RemittanceFlow container={buildTestContainer()} />);
    fireEvent.click(screen.getByRole("button", { name: /Empezar un envío/ }));

    expect(screen.getByPlaceholderText("Nombre de tu familiar")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Tu plata no pasa por Chaski" })).toBeNull();
  });

  it("lo escrito en el formulario sobrevive a salir y volver a entrar", () => {
    // La consecuencia de que sea la MISMA máquina de `Step` y no una ruta: `send` no se desmonta con
    // pérdida de estado, y "Volver al inicio" no es un reset. Si mañana alguien convierte esto en dos
    // rutas de Next (lo que CD-4 prohíbe), este test es el que lo nota.
    render(<RemittanceFlow container={buildTestContainer()} />);
    fireEvent.click(screen.getByRole("button", { name: /Empezar un envío/ }));
    fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), {
      target: { value: "Mamá" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Volver al inicio/ }));
    fireEvent.click(screen.getByRole("button", { name: /Empezar un envío/ }));

    expect(screen.getByPlaceholderText("Nombre de tu familiar")).toHaveValue("Mamá");
  });
});

describe("T-063-3 (AC-2 / CD-4): no hay ruta nueva, y producción no puede saltearse la pantalla", () => {
  it("`app/` no ganó ninguna ruta para las pantallas nuevas", () => {
    // CD-4 es una prohibición, y una prohibición sin candado es una intención. Se leen los directorios
    // de `app/`: una ruta de Next ES un directorio con un `page.tsx`.
    const dirs = readdirSync(path.join(ROOT, "app"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(dirs.length, "si `app/` no tuviera subdirectorios, esto pasaría por vacuidad").toBeGreaterThan(0);
    for (const prohibido of ["bienvenida", "recuperar", "inicio", "destinos"]) {
      expect(dirs, `«${prohibido}» sería una ruta nueva, y CD-4 lo prohíbe`).not.toContain(prohibido);
    }
  });

  it("🔴 el único `<RemittanceFlow>` de producción NO pasa `pasoInicial`", () => {
    // MUTANTE 3 (aplicado): `app/page.tsx` con `<RemittanceFlow pasoInicial="send" />` ⇒ rojo.
    //
    // POR QUÉ ESTE CANDADO EXISTE. `pasoInicial` es una costura de test, y una costura de test que
    // producción puede usar es una forma de apagar la pantalla nueva con la suite entera en verde: los
    // tests de arriba montan el componente ellos mismos, así que ninguno se enteraría. Acá se lee el
    // FUENTE de `app/` (no el DOM) porque lo que hay que prohibir es el sitio de llamada.
    const pagina = readFileSync(path.join(ROOT, "app/page.tsx"), "utf8");
    expect(pagina, "el `<RemittanceFlow>` de producción vive acá: si se mudó, este candado dejó de mirar").toContain("<RemittanceFlow");
    expect(pagina).not.toContain("pasoInicial");
  });
});

// ══ AC-3 + AC-4 · LA PARTICIÓN, QUE ES LO ÚNICO NORMATIVO DE LA BARRA ═══════════════════════════
//
// 🔴 LA TABLA ESTÁ ESCRITA A MANO Y ES EL PUNTO DEL BLOQUE. Si la partición se derivara de `esDestino`
// —la función que la barra usa para decidir—, el candado se compararía consigo mismo y aprobaría
// cualquier clasificación. Acá los dos lados se escriben, y el test cruza la unión contra
// `STEP_INDEX`, que es la tabla que el TIPO obliga a completar: un `Step` nuevo no puede quedarse sin
// clasificar en silencio.
const PASOS_DEL_FLUJO = ["send", "connect", "review", "verify", "confirm", "track", "done"] as const;
const DESTINOS_A_MANO = ["bienvenida", "history", "recuperar"] as const;

describe("T-063-4 (AC-3/AC-4): la máquina de `Step` está partida en pasos y destinos, sin sobrantes", () => {
  it("la unión de las dos listas es EXACTAMENTE la máquina de `Step`", () => {
    // MUTANTE: agregar un `Step` nuevo (p. ej. `"soporte"`) sin ponerlo en ninguna de las dos listas
    // ⇒ rojo, con el nombre del paso sin clasificar. Es lo que impide que una pantalla nueva herede
    // "sin barra" o "con barra" por accidente.
    expect([...PASOS_DEL_FLUJO, ...DESTINOS_A_MANO].sort()).toEqual(Object.keys(STEP_INDEX).sort());
  });

  it("`esDestino` coincide con la tabla escrita a mano, paso por paso", () => {
    // MUTANTE 5 (aplicado): `esDestino` devolviendo `true` también para `"done"` ⇒ rojo acá y en el
    // recorrido de abajo. Es la decisión que más se discutió (el recibo "se siente" como un final), y
    // por eso está clavada en los dos lugares.
    for (const paso of DESTINOS_A_MANO) expect(esDestino(paso), paso).toBe(true);
    for (const paso of PASOS_DEL_FLUJO) expect(esDestino(paso), paso).toBe(false);
    // Y la lista que la barra recorre para pintarse es la misma que la escrita a mano, en el MISMO
    // orden: el orden de las pestañas es parte de AC-4.
    expect([...DESTINOS]).toEqual([...DESTINOS_A_MANO]);
  });
});

describe("T-063-5 (AC-3): NINGÚN paso del envío pinta la barra", () => {
  // MUTANTE 4 (aplicado): pintar `<BarraDestinos>` sin el `esDestino(step)` ⇒ los 7 `it` de acá se
  // ponen rojos de una.
  it.each(PASOS_DEL_FLUJO)("en `%s` no hay barra de destinos", (paso) => {
    // ⚠️ VARIOS DE ESTOS PASOS NO RENDERIZAN CONTENIDO sin una remesa en estado (`review` exige
    // `rem?.quote`, `track` exige `rem`), y eso NO debilita el test: la barra depende de `step` y de
    // nada más, así que lo que se mide —que no esté— se mide igual. Recorrer los 7 por el flujo real
    // costaría siete recorridos y mediría lo mismo de la barra.
    render(<RemittanceFlow pasoInicial={paso} container={conLasDosPuertas().container} />);
    expect(barra(), `la barra no puede aparecer en el paso \`${paso}\``).toBeNull();
  });

  it("y el recorrido REAL de un envío tampoco la pinta en ningún paso", async () => {
    // El par del `it.each` de arriba, y no es redundante: aquél monta cada paso de una; éste lo camina.
    // Si algún día el montaje directo dejara de ser fiel al recorrido, este test es el que lo dice.
    render(
      <RemittanceFlow container={buildTestContainer({ kyc: new FakeKycGateway({ provenance: KYC_PROVENANCE_LIVE }) })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Empezar un envío/ }));
    expect(barra(), "send").toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), { target: { value: "Mamá" } });
    fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), { target: { value: TEST_CCI } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));
    await screen.findByText(/Revisá el envío/);
    expect(barra(), "review").toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: /Continuar/ }));
    await screen.findByRole("button", { name: /Verificar mi identidad/ });
    expect(barra(), "verify").toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Verificar mi identidad/ }));
    await screen.findByRole("button", { name: /Confirmar y enviar/ });
    expect(barra(), "confirm").toBeNull();
  });
});

describe("T-063-6 (AC-4): los tres destinos pintan la barra, con TRES pestañas y ninguna más", () => {
  it.each(DESTINOS_A_MANO)("en `%s` están las tres pestañas, en su orden", (destino) => {
    // MUTANTE 6 (aplicado): agregar una cuarta entrada a `DESTINOS` (p. ej. una acción, "Recuperar mis
    // fondos") ⇒ rojo por el `toEqual`, que es una lista cerrada y ordenada. Un `toContain` por
    // pestaña dejaría entrar la cuarta sin decir nada.
    render(<RemittanceFlow pasoInicial={destino} container={conLasDosPuertas().container} />);
    const nav = barra();
    expect(nav, `la barra tiene que estar en el destino \`${destino}\``).not.toBeNull();
    const pestanias = within(nav as HTMLElement)
      .getAllByRole("button")
      .map((b) => (b.textContent ?? "").trim());
    expect(pestanias).toEqual(["Enviar", "Mis envíos", "Recuperar"]);
  });

  it("la pestaña del destino activo se anuncia como la actual, y es UNA sola", () => {
    // Sin esto, tres pestañas que no dicen dónde estás son tres botones. `aria-current` es lo que un
    // lector de pantalla usa para contestar "¿en qué sección estoy?".
    render(<RemittanceFlow pasoInicial="recuperar" container={conLasDosPuertas().container} />);
    const actuales = within(barra() as HTMLElement)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") === "page")
      .map((b) => (b.textContent ?? "").trim());
    expect(actuales).toEqual(["Recuperar"]);
  });

  it("🔴 ninguna pestaña es una ACCIÓN: navegar entre las tres no toca la cadena", () => {
    // AC-4 dice "ninguna pestaña adicional que represente una acción en vez de un destino", y eso no
    // se puede medir contando pestañas: una pestaña llamada "Recuperar" podría estar disparando la
    // búsqueda al tocarla. Acá se toca LAS TRES y se mide que los dos gateways de la cadena —los que
    // piden firma y mueven plata— sigan sin una sola llamada.
    //
    // MUTANTE: que el `onIr` del destino "Recuperar" llame a `refund.refund(...)` o que la pestaña
    // dispare `resolveSender()` ⇒ rojo. Y ojo con el instrumento: `history` SÍ pasa por `openHistory`,
    // que conecta la billetera a propósito (la lista está scopeada por dueño); eso no es mover plata y
    // por eso lo que se cuenta son los dos gateways, no las conexiones.
    const { refund, lister, container } = conLasDosPuertas();
    render(<RemittanceFlow pasoInicial="bienvenida" container={container} />);
    for (const nombre of ["Recuperar", "Mis envíos", "Enviar"]) {
      const nav = barra();
      if (nav === null) throw new Error(`la barra desapareció antes de tocar «${nombre}»`);
      fireEvent.click(within(nav).getByRole("button", { name: nombre }));
    }
    expect(refund.calls, "ninguna pestaña puede disparar un refund").toHaveLength(0);
    expect(lister.calls, "ninguna pestaña puede disparar la búsqueda de cuentas abiertas").toHaveLength(0);
  });
});

// ══ AC-6 · LA COPIA DE CUSTODIA SE MOVIÓ, NO SE BORRÓ ═══════════════════════════════════════════

describe("T-063-7 (AC-6): en `connect`, la frase de custodia sigue estando y quedó DEBAJO del CTA", () => {
  /** Recorre hasta `connect` de verdad: es el único camino por el que la pantalla tiene su monto. */
  function irAConectar() {
    render(<RemittanceFlow pasoInicial="send" container={buildTestContainer()} />);
    fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), { target: { value: "Mamá" } });
    fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), { target: { value: TEST_CCI } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  }

  it("las dos afirmaciones están, palabra por palabra", async () => {
    // ⛔ CD-3(a) · NO SE BORRAN NI SE SUAVIZAN. La frase existe porque "Chaski nunca toca tu plata" es
    // un absoluto falsable (el escrow tiene una release-authority operada por el equipo) y ésta dice lo
    // único verificable: DÓNDE quedan los USDC. `honest-copy.test.tsx` ya la vigila en esta pantalla;
    // acá se re-assertea porque esta HU la MOVIÓ, y mover es la forma más fácil de perder algo.
    irAConectar();
    await screen.findByRole("button", { name: /Conectar wallet/ });
    expect(
      screen.getByText(/Tus USDC van a un contrato en Solana, no a una cuenta de Chaski/),
    ).toBeInTheDocument();
  });

  it("🔴 y aparece DESPUÉS del CTA en el orden del documento", async () => {
    // MUTANTE 7 (aplicado): devolver el `<Muted>` a su lugar viejo, entre el título y la caja del
    // monto ⇒ rojo. Es la mitad medible de AC-6: "moverla a un lugar que no tape la acción principal"
    // no es una impresión, es una relación de orden que `compareDocumentPosition` contesta.
    //
    // ⚠️ Y NO SE PERMITE PAGAR EL ORDEN CON TAMAÑO: el segundo assert exige que siga en el rol
    // `support` (el que tenía) y no en `label`. "Presentarla mejor" no puede significar "verla menos",
    // que es el riesgo que un AR ya dejó anotado para la píldora de demo.
    irAConectar();
    const cta = await screen.findByRole("button", { name: /Conectar wallet/ });
    const frase = screen.getByText(/Tus USDC van a un contrato en Solana, no a una cuenta de Chaski/);

    // DOCUMENT_POSITION_FOLLOWING = 4: `frase` viene después de `cta`.
    expect(
      cta.compareDocumentPosition(frase) & Node.DOCUMENT_POSITION_FOLLOWING,
      "la frase de custodia quedó arriba del CTA otra vez",
    ).toBeTruthy();
    expect(frase.className, "no se la achicó para acomodarla").toContain("text-support");
  });
});

// ══ AC-7 · LA PÍLDORA DE MODO DEMO, INTOCADA ════════════════════════════════════════════════════

describe("T-063-8 (AC-7): la píldora de modo demo no cambió de texto ni de condición", () => {
  it("con la verificación simulada, `confirm` la sigue mostrando con su texto exacto", async () => {
    // MUTANTE 8 (aplicado): cambiarle el texto a `DEMO_PILL` ⇒ rojo. El literal va ESCRITO acá y no
    // importado de `flow.tsx`: un test que le pregunta al código qué texto usa y después verifica que
    // usó ese texto es un guard que se compara consigo mismo.
    //
    // MUTANTE 8b: apagarla con el estado del KYC (`isDemoMode(rem) && !rem.kyc`) ⇒ rojo, porque este
    // recorrido llega a `confirm` justamente CON un KYC aplicado, y simulado.
    render(<RemittanceFlow pasoInicial="send" container={buildTestContainer()} />);
    fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), { target: { value: "Mamá" } });
    fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), { target: { value: TEST_CCI } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));
    // El recorrido completo: con el doble de KYC por defecto la identidad NO está recordada, así que
    // pasa por `review` y por `verify`. Es el camino que produce un `rem.kyc` con proveniencia
    // simulada, que es la entrada que `isDemoMode` mira.
    await screen.findByText(/Revisá el envío/);
    fireEvent.click(await screen.findByRole("button", { name: /Continuar/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Verificar mi identidad/ }));
    await screen.findByRole("button", { name: /Confirmar y enviar/ });

    expect(screen.getByText("Modo demo (con pasos simulados)")).toBeInTheDocument();
  });
});

// ══ Estilo del copy de las pantallas nuevas ═════════════════════════════════════════════════════

describe("T-063-9: las dos pantallas nuevas respetan las reglas de copy del founder", () => {
  it.each(DESTINOS_A_MANO)("`%s` no mete ningún em dash", (destino) => {
    // `honest-copy.test.tsx` ya barre el RECORRIDO del envío; los tres destinos no están en ese
    // recorrido, así que sin esto la regla no los alcanzaba. Es la extensión del candado a las
    // pantallas donde se van a escribir las próximas frases.
    render(<RemittanceFlow pasoInicial={destino} container={conLasDosPuertas().container} />);
    expect(document.body.textContent ?? "").not.toContain("—");
  });
});
