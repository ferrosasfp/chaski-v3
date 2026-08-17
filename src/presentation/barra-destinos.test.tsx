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
// 🔴 REGLA DE ESTE ARCHIVO: cada test nombra la edición que lo pone en rojo, y los mutantes se
// APLICARON Y SE CORRIERON, uno por uno. No es una lista de lo que "debería" fallar: es la salida de
// correrlos.
//
// ⚠️ LOS DOCE CONTEOS DE ABAJO SE RE-MIDIERON EN EL FIX-PACK, y hay un motivo que vale más que los
// números: el archivo pasó de **30 a 38 tests**, así que TODOS los totales viejos (`… (30)`) dejaron de
// describir este árbol. Un conteo de mutación es relativo al tamaño de la suite; agregar tests lo
// invalida sin que nada se ponga rojo. Los doce se volvieron a correr sobre el árbol de este fix-pack.
//
//   MUTANTE APLICADO                                                    RESULTADO MEDIDO
//   1. `pasoInicial = "send"` como default de `RemittanceFlow`          9 failed | 29 passed (38)
//   2. el CTA de la bienvenida llamando a `setStep("connect")`          3 failed | 35 passed (38)
//   3. `app/page.tsx` pasando `pasoInicial="send"`                      1 failed | 37 passed (38)
//   4. la barra pintada sin el guard `esDestino(step)`                 11 failed | 27 passed (38)
//   5. `esDestino` devolviendo `true` también para `"done"`             2 failed | 36 passed (38)
//   6. una cuarta pestaña, y que además es una acción                   5 failed | 33 passed (38)
//   7. la frase de custodia MOVIDA arriba del CTA en `connect`          1 failed | 37 passed (38)
//   7b. la MISMA frase DUPLICADA (arriba y abajo a la vez)              2 failed | 36 passed (38)
//   8. `DEMO_PILL` con otro texto                                       1 failed | 37 passed (38)
//   ── los cuatro del fix-pack ─────────────────────────────────────────────────────────────────────
//   F1. el guard de la barra de vuelta a `esDestino(step)` a secas      3 failed | 35 passed (38)
//   F2. un TERCER overlay en el ternario, sin sumarlo al guard          1 failed | 37 passed (38)
//   F3. `onBack={() => setStep("send")}` en el historial                1 failed | 37 passed (38)
//   F4. `setStep("send")` al final de `forgetAndDisconnect`             1 failed | 37 passed (38)
//
// Y los dos que este archivo NO mata, porque los ACs que tocan viven en otros candados. Se corrieron
// igual, y contra los archivos que sí los miran, para no dejar el par sin medir. También re-medidos en el
// fix-pack (`touch-targets.test.tsx` ganó `T-341-7`, así que su total pasó de 20 a 21):
//   9. la pestaña sin su `min-h-[52px]` (AC-5)   ⇒ touch-targets + jerarquia:  3 failed | 18 passed (21)
//  10. la pestaña activa con el vocabulario COMPLETO de `primary`
//                                               ⇒ jerarquia-relativa:         2 failed | 14 passed (16)
//
// 🔴 Y EL 10 DESTAPÓ UN LÍMITE DEL CANDADO DE JERARQUÍA QUE VALE MÁS QUE SU CONTEO. Mi primera versión
// del mutante le puso a la pestaña activa `bg-cochineal text-white font-bold` —o sea, la hizo VERSE como
// el CTA— y midió **`0 failed | 16 passed (16)`**: no mató nada. La causa es que `esPrimary`
// (`jerarquia-relativa.test.tsx`) exige que estén TODOS los tokens que distinguen a `primary`, y le
// faltaban `hover:bg-cochineal-ink` y `shadow-lift`. Con el vocabulario completo mata 2. ⇒ **El candado
// de AC-8 vigila el VOCABULARIO, no la apariencia**: una pestaña pintada con el color del CTA pero sin
// dos de sus cuatro tokens pasa en verde. Eso no lo cierra este fix-pack; queda declarado acá porque el
// conteo viejo (`1 failed`) venía de una mutación parcial y hacía creer lo contrario.
//
// ⚠️ EL 7 Y EL 7b SON DOS MUTANTES DISTINTOS, y acá había UN renglón para los dos (CR/MNR-1 es el mismo
// tipo de error en el archivo hermano). El de MOVER la frase deja UNA sola instancia y mata 1; el de
// DUPLICARLA deja dos y mata 2, porque el `getByText` del primer `it` del bloque se vuelve ambiguo. La
// nota vieja decía "el 7 mata dos" y describía, sin decirlo, el 7b. Lo que queda clavado en los dos
// casos es que debajo del CTA hay UNA.
//
// ⚠️ EL F1 MATA TRES Y NO DOS, y es el que más enseña de los cuatro: además de los dos `it` que montan
// los overlays, cae el que LEE EL FUENTE. Esos dos primeros prueban el comportamiento de hoy; el
// tercero es el que impide que un overlay futuro reabra el agujero.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { HistoryView, RemittanceFlow, STEP_INDEX } from "./flow";
import { DESTINOS, esDestino } from "./barra-destinos";
import { buildTestContainer } from "../test-support/test-container";
import type { Container } from "../composition/container";
import type { ResumeKycResult } from "../application/use-cases/resume-kyc";
import { Money } from "../domain/money";
import { Remittance, type RemittanceState, toPersistedIdentity } from "../domain/remittance";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakeKycGateway,
  FakeSolanaCloseableEscrowLister,
  FakeSolanaEscrowRefundGateway,
  FakeSolanaWallet,
  TEST_CCI,
  T0,
  beneficiary,
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
    // ⚠️ ESTA TERCERA FRASE CAMBIÓ EN EL FIX-PACK (AR/BLQ-BAJO-2) y el assert de acá SIGUE SIENDO DE
    // PRESENCIA a propósito: mide que la pantalla diga dónde se verifica. Que lo que dice sea cierto en
    // la rama SIN `principalTx` lo mide `T-063-24` en `bienvenida-composicion.test.tsx`, que monta el
    // comprobante en las dos ramas. El `not.toContain` de abajo es la mitad que impide reponer la
    // versión incondicional: decía "cada envío deja una transacción que podés abrir en el explorador", y
    // hay una rama alcanzable (`confirmed` sin firma registrada) donde no hay ninguna.
    expect(
      screen.getByText(/no hace falta creernos: el depósito de tus USDC es una transacción en Solana/),
      "dónde se verifica, que es lo que hace verificable a las otras dos",
    ).toBeInTheDocument();
    expect(
      document.body.textContent ?? "",
      "la versión INCONDICIONAL de esta frase no puede volver",
    ).not.toContain("cada envío deja una transacción");
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
//
// 🔴 ACÁ HABÍA UNA FILA VACUA, Y LA ENCONTRARON LAS DOS REVISIONES POR SEPARADO (CR/MNR-6 y AR/MNR-4).
// El barrido era un `it.each` sobre los TRES destinos con `pasoInicial={destino}`. Con
// `pasoInicial="history"` el estado `history` es `null`, así que el sitio de render de `flow.tsx` no
// pinta NINGUNA pantalla y lo que se barría eran el header y la barra. Medido en este árbol:
// `document.body.textContent` daba **59 caracteres** (`"Chaskitu plata a Perú, sin vueltasEnviarMis
// envíosRecuperar"`) contra 561 de los otros dos. De los tres destinos se barrían DOS, y la fila que
// faltaba era la que tiene MÁS copy generada (etiquetas de estado, encabezados de grupo, fechas).
//
// El arreglo son dos mitades, y ninguna sirve sola:
//   · el `it.each` queda sólo con los dos destinos que SÍ se pintan desde `pasoInicial`, y cada uno pide
//     un marcador de SU pantalla antes de barrer — un `pasoInicial` que dejara de pintar se pone rojo en
//     vez de barrer el header;
//   · `history` tiene su propio `it`, que monta `HistoryView` con filas de verdad.
const SIN_EM_DASH: Record<"bienvenida" | "recuperar", string> = {
  bienvenida: "Tu plata no pasa por Chaski",
  recuperar: "Recuperar fondos de un envío anterior",
};

/** Una remesa con depósito registrado: la fila del historial más cargada de copy generada. */
function remesaConDeposito(id: string): RemittanceState {
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
  r.confirm(T0);
  r.markPrincipalIn("5xFirmaDeMentira", T0);
  return r.snapshot;
}

describe("T-063-9: las tres pantallas de destino respetan las reglas de copy del founder", () => {
  it.each(Object.keys(SIN_EM_DASH) as ("bienvenida" | "recuperar")[])(
    "`%s` no mete ningún em dash",
    (destino) => {
      // `honest-copy.test.tsx` ya barre el RECORRIDO del envío; los destinos no están en ese recorrido,
      // así que sin esto la regla no los alcanzaba.
      render(<RemittanceFlow pasoInicial={destino} container={conLasDosPuertas().container} />);
      const texto = document.body.textContent ?? "";
      // ANTIVACUIDAD: primero que la pantalla ESTÉ. Sin esto el barrido puede mirar el header y aprobar.
      expect(texto, `«${destino}» no se pintó: el barrido de abajo no habla de esta pantalla`).toContain(
        SIN_EM_DASH[destino],
      );
      expect(texto).not.toContain("—");
    },
  );

  it("`history` tampoco, y se barre con FILAS de verdad (no con la pantalla vacía)", () => {
    // MUTANTE que este `it` mata y el `it.each` viejo NO: meter un em dash en cualquier copy que sólo
    // aparezca con filas (una etiqueta de estado, un encabezado de grupo). Con `pasoInicial="history"` y
    // `history === null` eso era invisible.
    render(
      <HistoryView
        items={[remesaConDeposito("rem-1"), remesaConDeposito("rem-2")]}
        onOpen={() => {}}
        onBack={() => {}}
      />,
    );
    const texto = document.body.textContent ?? "";
    expect(texto, "ANTIVACUIDAD: la lista tiene que haber pintado sus filas").toContain("Ver seguimiento");
    expect(texto.length, "y tiene que ser bastante más que el header solo").toBeGreaterThan(200);
    expect(texto).not.toContain("—");
  });
});

// ══ AR/BLQ-MED-1 · LA BARRA NO PUEDE PINTARSE ENCIMA DE UN OVERLAY ══════════════════════════════
//
// 🔴 EL DEFECTO, y es el camino del video de M5. El KYC se va a Didit con `window.location.href` y
// vuelve como RECARGA, así que el resume-loop corre al MONTAR. Y desde esta HU el default de
// `pasoInicial` es `"bienvenida"`, o sea que el `step` de ese montaje YA es un destino. La barra se
// pintaba fuera del ternario `resuming/timedOut`, así que quedaba DEBAJO de "Verificando tu identidad…"
// con las tres pestañas habilitadas; al tocar una, la pestaña se marcaba `aria-current="page"` —la barra
// AFIRMABA estar en Recuperar— y la pantalla seguía en el overlay. AC-3 dice lo contrario: hay un envío
// en curso, no hay barra.
//
// MUTANTES APLICADOS Y CORRIDOS (los conteos están al lado de cada `it`, medidos sobre este archivo).
describe("T-063-20 (AR/BLQ-MED-1): con un overlay de KYC arriba, la barra NO se pinta", () => {
  /** El container con un `resumeKyc` que contesta lo que el test necesita, sin tocar nada más. */
  const conResume = (execute: () => Promise<ResumeKycResult>) =>
    buildTestContainer({ useCases: { resumeKyc: { execute } as unknown as Container["resumeKyc"] } });

  it("🔴 mientras el resume dice `processing`, hay overlay y NO hay barra", async () => {
    // MUTANTE F1 (aplicado): devolver el guard a `esDestino(step)` a secas ⇒ `3 failed | 35 passed (38)`.
    // ⚠️ CAEN TRES Y NO DOS, y el tercero es el que importa: éste, el de `timedOut`, y el que lee el
    // FUENTE (porque la línea de la barra deja de contener `!resuming`). Sin el mutante: `38 passed`.
    render(<RemittanceFlow container={conResume(async () => ({ kind: "processing" }))} />);

    // La precondición: el overlay ESTÁ. Sin este assert, "no hay barra" pasaría también si el overlay
    // nunca hubiera aparecido, que es el falso verde de este test.
    expect(await screen.findByRole("heading", { name: /Verificando tu identidad/ })).toBeInTheDocument();
    expect(barra(), "la barra no puede convivir con el overlay del resume").toBeNull();
  });

  it("🔴 y con el resume vencido (`timedOut`) tampoco", async () => {
    // `resumeKyc` que TIRA: el loop hace `break` y cae en la rama de timeout, así que se llega al
    // segundo overlay sin esperar los 20 s de los 8 polls.
    render(
      <RemittanceFlow
        container={conResume(async () => {
          throw new Error("didit_caido");
        })}
      />,
    );
    expect(await screen.findByRole("heading", { name: /La verificación está tardando/ })).toBeInTheDocument();
    expect(barra(), "la barra no puede convivir con el overlay de timeout").toBeNull();
  });

  it("(control) sin nada en vuelo, el MISMO montaje sí pinta la barra", () => {
    // La otra mitad del par. Sin este `it`, "la barra no está" se podría conseguir borrándola.
    render(<RemittanceFlow container={conResume(async () => ({ kind: "none" }))} />);
    expect(barra()).not.toBeNull();
  });

  it("🔴 ningún overlay NUEVO puede nacer sin sumarse al guard de la barra (se lee el FUENTE)", () => {
    // ⚠️ ESTE `it` EXISTE PORQUE `!resuming && !timedOut` ES UNA LISTA, y una lista no se actualiza sola:
    // un tercer overlay agregado mañana al mismo ternario volvería a pintar la barra encima, que es
    // EXACTAMENTE el defecto que este bloque cierra. En vez de declararlo en prosa, se mide: se sacan
    // las banderas de las ramas del ternario del `<main>` y se exige que cada una esté negada en la
    // línea de la barra.
    //
    // MUTANTE F2 (aplicado): agregar `) : otroOverlay ? (` como tercera rama del ternario, sin tocar la
    // línea de la barra ⇒ `1 failed | 37 passed (38)`, y el único que cae es éste.
    // ⚠️ CÓMO SE IDENTIFICA "EL" TERNARIO, porque `flow.tsx` tiene 18 ternarios con esta forma y sólo UNO
    // decide si el flujo se pinta o no. El rasgo que lo distingue no es la indentación (el bloque de
    // `error` está al mismo nivel y coexiste con la barra A PROPÓSITO): es que su rama ELSE final es la
    // que renderiza `<AnimatePresence>`, o sea el flujo entero. Desde ahí se camina para atrás
    // recogiendo las ramas del MISMO nivel hasta la que abre el ternario.
    const fuente = readFileSync(path.join(ROOT, "src/presentation/flow.tsx"), "utf8").split("\n");
    const iElse = fuente.findIndex(
      (l, i) => /^\s*\) : \(\s*$/.test(l) && (fuente[i + 1] ?? "").includes("<AnimatePresence"),
    );
    expect(iElse, "no encontré el ternario que gatea el flujo: este candado dejó de mirar").toBeGreaterThan(0);
    const sangria = (/^(\s*)\)/.exec(fuente[iElse] as string) as RegExpExecArray)[1] as string;
    const banderas: string[] = [];
    for (let i = iElse - 1; i >= 0; i--) {
      const l = fuente[i] as string;
      const sigue = new RegExp(`^${sangria}\\) : (\\w+) \\? \\(\\s*$`).exec(l);
      if (sigue !== null) {
        banderas.unshift(sigue[1] as string);
        continue;
      }
      const abre = new RegExp(`^${sangria}\\{(\\w+) \\? \\(\\s*$`).exec(l);
      if (abre !== null) {
        banderas.unshift(abre[1] as string);
        break;
      }
    }
    // ANTIVACUIDAD: si los regex dejaran de matchear, `banderas` sería `[]` y el `for` de abajo pasaría
    // por vacuidad. Las dos que este bloque conoce tienen que ser EXACTAMENTE las encontradas: una
    // tercera que aparezca cae en el `for` y una que desaparezca cae acá.
    expect(banderas, "las ramas del ternario del overlay cambiaron: vení a leer el guard de la barra").toEqual([
      "resuming",
      "timedOut",
    ]);

    const lineaBarra = fuente.find((l) => l.includes("<BarraDestinos activo="));
    expect(lineaBarra, "no encontré el sitio de render de la barra").toBeDefined();
    for (const b of banderas) {
      expect(lineaBarra as string, `el overlay \`${b}\` no está negado en el guard de la barra`).toContain(`!${b}`);
    }
  });
});

describe("T-063-21 (AR/BLQ-MED-1, lo que NO se arregló): la ventana previa a la primera respuesta", () => {
  it("🔴 una elección hecha antes de que el resume contestara SE PIERDE, y queda medido", async () => {
    // ⚠️ ESTE `it` NO DEFIENDE UN ARREGLO: DOCUMENTA UN DEFECTO QUE SIGUE ABIERTO, medido en vez de
    // razonado. La barra ya no se pinta con el overlay arriba, pero `resuming` arranca en `false` y sólo
    // pasa a `true` cuando el primer `resumeKyc.execute()` CONTESTA. Y en el camino del video ese primer
    // execute hace una llamada de red a Didit (`kyc.decision`), o sea cientos de milisegundos con la
    // bienvenida y la barra en pantalla, las dos correctas. Si la persona toca un destino ahí, el resume
    // llega después y hace `setStep("confirm")` encima.
    //
    // POR QUÉ NO SE GUARDÓ EL `setStep`, y la decisión se midió: cortarlo con un ref del tipo "la
    // persona ya navegó" deja una identidad YA VERIFICADA sin ninguna pantalla que la retome — desde
    // `recuperar` no hay ningún camino de vuelta a `confirm`—, o sea que cambia una navegación tardía
    // por una remesa varada con el KYC pagado. Eso es peor, y elegirlo bien es diseño de una HU, no de
    // un fix-pack. Cuando se arregle, ESTE test se pone rojo y hay que venir a reescribirlo: es la
    // forma de que el defecto no se olvide.
    let resolver: ((r: ResumeKycResult) => void) | null = null;
    const enVuelo = new Promise<ResumeKycResult>((res) => {
      resolver = res;
    });
    const { container } = conLasDosPuertas();
    const conDeferido = {
      ...container,
      resumeKyc: { execute: () => enVuelo } as unknown as Container["resumeKyc"],
    };
    render(<RemittanceFlow container={conDeferido} />);

    // (1) La ventana: el resume todavía no contestó, así que NO hay overlay y la barra es correcta.
    expect(screen.queryByRole("heading", { name: /Verificando tu identidad/ })).toBeNull();
    const nav = barra();
    expect(nav, "en esta ventana la barra SÍ está, y eso no es el defecto").not.toBeNull();

    // (2) La persona elige un destino.
    fireEvent.click(within(nav as HTMLElement).getByRole("button", { name: "Recuperar" }));
    expect(screen.getByRole("heading", { name: /Recuperar fondos de un envío anterior/ })).toBeInTheDocument();

    // (3) El resume contesta, y pisa la elección.
    (resolver as unknown as (r: ResumeKycResult) => void)({ kind: "passed", snapshot: remesaConDeposito("rem-9") });
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Recuperar fondos de un envío anterior/ }),
        "DEFECTO ABIERTO: el resume se llevó puesta la pantalla que la persona eligió",
      ).toBeNull(),
    );
  });
});

// ══ AR/BLQ-BAJO-1 · DOS SITIOS TRATABAN `send` COMO "EL INICIO" ═════════════════════════════════
//
// Antes de esta HU `send` ERA el inicio: ahí vivían las tres puertas. La HU le cambió el significado
// (hoy es el paso 1 de 4 de un envío) y no revisó los dos sitios que lo asumían. Ningún `grep` de texto
// los caza: son el cableado de dos handlers, no un string. Los dos `it` de abajo CAMINAN el recorrido en
// vez de leer el handler.
describe("T-063-22 (AR/BLQ-BAJO-1): el «Volver» del historial va al inicio, no al medio del embudo", () => {
  it("🔴 desde el historial, «Volver» aterriza en la bienvenida y NO en el formulario", async () => {
    // MUTANTE F3 (aplicado): `onBack={() => setStep("send")}`, que es lo que decía ⇒ `1 failed |
    // 37 passed (38)`. El assert que lo mata es el segundo: sin él, "la bienvenida está" y "el
    // formulario está" podrían ser las dos verdad si alguien pintara las dos.
    render(<RemittanceFlow pasoInicial="history" container={conLasDosPuertas().container} />);
    // `pasoInicial="history"` con `history === null` no pinta la lista, así que se entra caminando.
    fireEvent.click(within(barra() as HTMLElement).getByRole("button", { name: "Mis envíos" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Volver$/ }));

    expect(screen.getByRole("heading", { name: "Tu plata no pasa por Chaski" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Monto en dólares"), "«Volver» no puede meter a nadie al embudo").toBeNull();
    expect(screen.queryByText(/Paso 1 de 4/)).toBeNull();
  });

  it("🔴 y el botón se queda por un motivo MEDIDO: es la única salida que sobrevive a `busy`", async () => {
    // ⚠️ POR QUÉ NO SE BORRÓ, que era la otra opción sobre la mesa (la barra ya ofrece "Enviar", así que
    // un «Volver» a pantalla completa dentro de un destino ES navegación duplicada, justo lo que el
    // work-item eliminó al borrar los enlaces del pie). Medido acá: con la billetera que nunca contesta,
    // `guard` deja `busy` en `true` sin timeout ni escape (AR/MNR-3) y las TRES pestañas quedan
    // `disabled`. El «Volver» no honra `disabled`, así que es el único control vivo de la pantalla.
    // Borrarlo cambiaba un defecto de duplicación por un congelamiento sin salida.
    // MUTANTE: ponerle `disabled={busy}` al «Volver» ⇒ este `it` se pone rojo, y ahí el botón deja de
    // tener motivo para existir y hay que borrarlo con su fila de `jerarquia-relativa.test.tsx`.
    const refund = new FakeSolanaEscrowRefundGateway();
    const lister = new FakeSolanaCloseableEscrowLister([]);
    const container = buildTestContainer({ wallet: new FakeSolanaWallet(), solanaRefund: refund, solanaCloseableEscrows: lister });
    render(<RemittanceFlow pasoInicial="history" container={container} />);
    fireEvent.click(within(barra() as HTMLElement).getByRole("button", { name: "Mis envíos" }));
    const volver = await screen.findByRole("button", { name: /^Volver$/ });

    // Se cuelga la billetera: `openHistory` vuelve a entrar en `guard` y `busy` se queda arriba.
    const conColgada = { ...container, connectWallet: { execute: () => new Promise<never>(() => {}) } as unknown as Container["connectWallet"] };
    cleanup();
    render(<RemittanceFlow pasoInicial="history" container={conColgada} />);
    const nav = barra() as HTMLElement;
    fireEvent.click(within(nav).getByRole("button", { name: "Mis envíos" }));
    await waitFor(() =>
      expect(
        within(barra() as HTMLElement).getByRole("button", { name: "Recuperar" }),
        "con la billetera colgada las pestañas quedan muertas: es la precondición de este test",
      ).toBeDisabled(),
    );
    // Y el control que este test defiende NO está disabled. Se mide sobre el render de arriba, que es
    // el que tiene la lista pintada.
    expect(volver, "el «Volver» del historial no puede honrar `busy`: es la salida de última instancia").not.toBeDisabled();
  });
});

describe("T-063-23 (AR/BLQ-BAJO-1): después de «Borrar igual», el dispositivo limpio arranca en el inicio", () => {
  it("🔴 no aterriza en el medio del formulario", async () => {
    // MUTANTE F4 (aplicado): `setStep("send")` al final de `forgetAndDisconnect`, que es lo que decía ⇒
    // `1 failed | 37 passed (38)`.
    //
    // El gesto significa "no soy yo, quiero un dispositivo limpio": borra el KYC de la address y la PII
    // del beneficiario. Aterrizar con "Paso 1 de 4" arriba contradice lo que se acaba de pedir.
    render(<RemittanceFlow pasoInicial="send" container={buildTestContainer({ wallet: new FakeSolanaWallet() })} />);
    fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), { target: { value: "Mamá" } });
    fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), { target: { value: TEST_CCI } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));
    await screen.findByText(/Revisá el envío/);

    fireEvent.click(await screen.findByRole("button", { name: /¿No sos vos\?/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Borrar igual/ }));

    expect(
      await screen.findByRole("heading", { name: "Tu plata no pasa por Chaski" }),
      "un dispositivo recién limpiado arranca en la pantalla de entrada",
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Monto en dólares")).toBeNull();
    expect(screen.queryByText(/Paso 1 de 4/)).toBeNull();
  });
});
