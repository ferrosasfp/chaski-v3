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
// ⚠️ LOS CONTEOS DE ABAJO SE RE-MIDIERON EN EL FIX-PACK 3, y hay un motivo que vale más que los números:
// el archivo pasó de **30 → 38 → 39 → 43 tests** (los cuatro nuevos son los dos caminos que el fix-pack 2
// dejó declarados y abiertos, cada uno con su control o su aislamiento), así que TODOS los totales de la
// tabla anterior (`… (39)`) dejaron de describir este árbol. Un conteo de mutación es relativo al tamaño
// de la suite; agregar UN test lo invalida sin que nada se ponga rojo, y eso es exactamente el hallazgo
// AR-it2/MNR-1 en el archivo hermano. Los QUINCE se volvieron a aplicar y correr, uno por uno, con el
// conteo de cada patrón verificado ANTES de aplicar, el TEXTO resultante verificado también (no alcanza
// `count == 1`: hay que mirar que la sustitución diga lo que se quería) y los archivos restaurados y
// comparados byte a byte después. Control en la misma corrida: **`43 passed (43)`**.
//
//   MUTANTE APLICADO                                                    RESULTADO MEDIDO
//   1. `pasoInicial = "send"` como default de `RemittanceFlow`         14 failed | 29 passed (43)
//   2. el CTA de la bienvenida llamando a `setStep("connect")`          5 failed | 38 passed (43)
//   3. `app/page.tsx` pasando `pasoInicial="send"`                      1 failed | 42 passed (43)
//   4a. el guard de la barra ENTERO borrado (se pinta siempre)         11 failed | 32 passed (43)
//   4b. SÓLO `esDestino(step)` borrado (quedan las dos banderas)        8 failed | 35 passed (43)
//   5. `esDestino` devolviendo `true` también para `"done"`             2 failed | 41 passed (43)
//   6. una cuarta pestaña, y que además es una acción                   4 failed | 39 passed (43)
//   7. la frase de custodia MOVIDA arriba del CTA en `connect`          1 failed | 42 passed (43)
//   7b. la MISMA frase DUPLICADA (arriba y abajo a la vez)              2 failed | 41 passed (43)
//   8. `DEMO_PILL` con otro texto                                       1 failed | 42 passed (43)
//   ── los cuatro del primer fix-pack ──────────────────────────────────────────────────────────────
//   F1. el guard de la barra de vuelta a `esDestino(step)` a secas      3 failed | 40 passed (43)
//   F2. un TERCER overlay en el ternario, DECLARADO, sin sumarlo al guard  1 failed | 42 passed (43)
//   F3. `onBack={() => setStep("send")}` en el historial                1 failed | 42 passed (43)
//   F4. `setStep("send")` al final de `forgetAndDisconnect`             1 failed | 42 passed (43)
//   ── el del fix-pack 2, con su patrón CORREGIDO ──────────────────────────────────────────────────
//   F5. el «Volver» de `HistoryView` deshabilitado (`disabled`)         2 failed | 41 passed (43)
//   ── los cinco del gate del pisón viven en el bloque de `T-063-21`, con su tabla propia ──────────
//
// 🔴 DOS FILAS NO SON EL MISMO MUTANTE QUE ANTES, y decirlo importa más que el número. **F5**: el
// renglón viejo decía `disabled={busy}`, y `HistoryView` NO RECIBE `busy` (no es un prop de su firma),
// así que ese patrón es un `ReferenceError` en render y no mide nada. Lo aplicado es `disabled` a secas,
// que es la misma pregunta ("el «Volver» honra el congelamiento") sin romper el módulo; mata **2** y no
// 1, porque además del `it` del congelamiento cae el primero de `T-063-22`, que lo CLICKEA. **El 6**: la
// versión aplicada acá agrega `"enviarAhora"` a `Destino`/`DESTINOS`/`ETIQUETAS`/`ICONOS` con la etiqueta
// "Enviar ahora" y mata **4**, no 5. No sé si es exactamente el patrón del fix-pack 2 (el renglón no lo
// escribía), así que el número que vale es el de acá, que sí dice qué se aplicó.
//
// ⚠️ EL CRECIMIENTO DE 1 Y DE 2 ES INFORMACIÓN, no ruido: el 1 pasó de matar 10 a matar **14** y el 2 de
// 3 a **5**, y los cuatro/dos de más son los `it` nuevos. Los dos vigilan el default `bienvenida` y el
// destino del CTA, que es por dónde entra el embudo.
//
// 🔴 EL 4 ERA UNA FILA AMBIGUA Y AHORA SON DOS, y la diferencia no es de un test: son 11 contra 8. Decía
// "la barra pintada sin el guard `esDestino(step)`", que se lee de dos maneras — borrar el guard COMPLETO
// (y ahí caen además los tres `it` de `T-063-20`, porque la barra se pinta encima de los dos overlays) o
// borrar sólo ese término y dejar `!resuming && !timedOut`. El `11 failed` de la tabla vieja es la
// PRIMERA lectura; la segunda da 8 y es la que aísla lo que su nombre dice. Mismo tratamiento que el par
// 7 / 7b, que ya se había partido por lo mismo.
// ⚠️ EL 1 MATA CATORCE, y los cuatro que se sumaron sobre el 10 del fix-pack 2 son los cuatro `it` nuevos
// de `T-063-21`: los SEIS de ese bloque montan el default (`bienvenida`) y caen los seis. Es información y
// no ruido: dice que esos `it` también vigilan el default, no sólo el gate.
// ⛔ DOS DE ESTOS MUTANTES ESTUVIERON MAL ESCRITOS EN LA PRIMERA PASADA DEL FIX-PACK 2, y queda anotado
// porque un mutante que rompe el módulo no mide nada:
//   · el 7 puesto como HERMANO del `<div>` raíz del bloque `connect` deja dos hijos en una rama `&&` ⇒
//     error de compilación y `no tests` (cero, ni verde ni rojo). Va como PRIMER HIJO de ese `<div>`.
//   · el F2 con `otroOverlay` SIN DECLARAR es un `ReferenceError` en render ⇒ `34 failed | 5 passed (39)`,
//     que parece un mutante potentísimo y es un módulo roto. Con `const otroOverlay = false;` declarado
//     mata **1**, y el que cae es el que lee el FUENTE — que es lo que ese `it` promete.
//
// Y los dos que este archivo NO mata, porque los ACs que tocan viven en otros candados. NO se re-corrieron
// en el fix-pack 2 ni en el 3, y el motivo es medible: sus totales son relativos a `touch-targets.test.tsx`
// y `jerarquia-relativa.test.tsx`, y ninguno de los dos fix-packs tocó ninguno de los dos archivos (no
// aparecen en su `git status`). Re-derivado en el fix-pack 3 sin aplicar los mutantes, que es la
// precondición y no la conclusión: `vitest run touch-targets jerarquia-relativa` da **`21 passed (21)`**
// (5 + 16), así que 21 y 16 siguen describiendo esos árboles:
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
import { Remittance, type RemittanceState, toPersistedIdentity } from "../domain/remittance"; import { clickCuandoHabilite } from "../test-support/clicks"; // re-AR it2/BLQ-BAJO-2 — EN ESTA LÍNEA (Δ0). Un click sobre un botón `disabled={busy}` se descarta EN SILENCIO y el flujo queda parado para siempre; el helper espera a que se habilite. El mecanismo, en su docblock
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
const KYC_PROVENANCE_LIVE = "didit"; // WKH-233: el literal se escribe ACÁ, en un test, porque el módulo que lo exportaba se borró con la HU (el juicio "esto es real" ya no lo hace Chaski). EN UNA SOLA LÍNEA: este archivo recibe citas `archivo:línea` y agregar líneas las corre.

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
    fireEvent.click(screen.getByRole("button", { name: /Empezar un envío/ })); // ⚠️ SIGUE SIENDO UN CLICK CRUDO, Y ES DELIBERADO (re-AR it2 · BLQ-BAJO-2): el click de la línea de arriba es `VolverAlInicio`, cuyo `onVolver` es un `setStep` SÍNCRONO (`barra-destinos.tsx:158` ⇒ `flow.tsx:807`), no un `guard()`. Sin `guard` no hay `setBusy(true)`, así que la carrera que cierra `clickCuandoHabilite` no existe acá. Convertirlo obligaría a volver `async` a este `it` y no mediría nada nuevo

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
  // MUTANTE 4b (aplicado): borrar `esDestino(step)` del guard de la barra, dejando `!resuming &&
  // !timedOut` ⇒ `8 failed | 31 passed (39)`. Los 7 `it` de este `it.each` MÁS el que camina el
  // recorrido real, que está abajo: OCHO y no siete (fix-pack 2). Con el guard ENTERO borrado son 11,
  // porque caen también los tres de `T-063-20`; las dos filas están en el encabezado.
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
    await clickCuandoHabilite(/Conectar wallet/);
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
    await clickCuandoHabilite(/Conectar wallet/);
    // El recorrido completo: con el doble de KYC por defecto la identidad NO está recordada, así que
    // pasa por `review` y por `verify`. Es el camino que produce un `rem.kyc` con proveniencia
    // simulada, que es la entrada que `isDemoMode` mira.
    await screen.findByText(/Revisá el envío/);
    fireEvent.click(await screen.findByRole("button", { name: /Continuar/ }));
    await clickCuandoHabilite(/Verificar mi identidad/);
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
    // MUTANTE F1 (aplicado): devolver el guard a `esDestino(step)` a secas ⇒ `3 failed | 36 passed (39)`.
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
    // línea de la barra ⇒ `1 failed | 38 passed (39)`, y el único que cae es éste. ⚠️ Y `otroOverlay`
    // TIENE QUE ESTAR DECLARADO: sin declararlo el mutante es un `ReferenceError` en render y da `34
    // failed | 5 passed (39)`, que no mide este `it` sino un módulo roto (fix-pack 2).
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

describe("T-063-21 (AR-it2/BLQ-MED-1): la ventana previa a la primera respuesta ya no pisa la elección", () => {
  /** El resume que no contesta hasta que el test lo suelta: ES la ventana, sin depender de ningún reloj. */
  const conResumeDeferido = () => {
    let resolver: ((r: ResumeKycResult) => void) | null = null;
    const enVuelo = new Promise<ResumeKycResult>((res) => {
      resolver = res;
    });
    const { container } = conLasDosPuertas();
    return {
      container: { ...container, resumeKyc: { execute: () => enVuelo } as unknown as Container["resumeKyc"] },
      contestar: (r: ResumeKycResult) => (resolver as unknown as (x: ResumeKycResult) => void)(r),
    };
  };

  it("🔴 la pantalla que la persona eligió SOBREVIVE, y el aviso dice que la verificación está lista", async () => {
    // ⚠️ ESTE `it` CAMBIÓ DE SIGNO EN EL FIX-PACK 2, y decirlo es la mitad del valor: hasta `6eb57e6`
    // CONGELABA LA LIMITACIÓN (asserteaba que la elección SE PERDÍA, para que el día que alguien cerrara
    // el defecto el test se pusiera rojo y viniera a reescribirlo). Eso es exactamente lo que pasó: el
    // gate del pisón lo puso rojo, y esto es la reescritura. Lo que congela ahora es el comportamiento
    // NUEVO.
    //
    // 🔴 POR QUÉ SE CERRÓ, y las dos mitades del argumento viejo estaban medidas al revés (AR-it2):
    //   · "cortarlo deja una identidad verificada sin pantalla que la retome" es FALSO: `ResumeKyc`
    //     persiste la verificación (`kycStore`, `../application/use-cases/resume-kyc.ts:49`) ANTES de que
    //     la UI navegue, y el atajo KYC-once de `onConnect` (`rememberedKyc`, `./flow.tsx:358`) la retoma
    //     con CERO llamadas a Didit. Lo que se perdía al cortar era un formulario para volver a tipear, no
    //     el KYC pagado. ⚠️ EL AR-it2 CITABA `:47` PARA ESA LÍNEA, Y ES EL `applyKyc`: el `kycStore.save`
    //     está dos líneas más abajo. El hecho ("corre antes de que la UI navegue") aguanta; el número no.
    //   · "la ventana es corta (cientos de ms)" también es FALSO: el `fetch` del cliente a
    //     `/api/kyc/decision` no tiene timeout y el del server es `AbortSignal.timeout(10_000)`
    //     (`AbortSignal`, `../infrastructure/kyc/agent-kyc-client.ts:248` — WKH-233 lo movió: el `fetch` del borde salió de la route y vive en el cliente del agente, con el MISMO techo de 10 s), así que son HASTA 10 s cuando la
    //     petición llega, y sin techo cuando no llega — el caso plausible, porque la app se está
    //     recargando desde un redirect externo en una red móvil.
    // Y el aterrizaje no era una pantalla de navegación: era `confirm`, la que pide la firma que mueve la
    // plata, sin barra y con una única salida DESTRUCTIVA ("¿No sos vos?" borra el KYC de la address y la
    // PII del beneficiario).
    //
    // ── LOS DOS MUTANTES DEL GATE, APLICADOS Y CORRIDOS, uno por `it` ─────────────────────────────
    // ⚠️ HACEN FALTA DOS Y NO UNO, y esto lo aprendí midiendo: mi primera versión de este comentario
    // decía que UN mutante mataba los dos `it` de este bloque, y es FALSO. Un gate condicional tiene dos
    // formas de romperse y cada una mata un `it` distinto:
    //   G1. `aterrizar` sin su guard, o sea el pisón a secas: SIEMPRE navega (1 sustitución, con el
    //       conteo verificado antes de aplicar) ⇒ `4 failed | 39 passed (43)`, y los cuatro que caen son
    //       los cuatro `it` del defecto (éste, los dos del embudo y el del `failed`). Es el defecto
    //       original, repuesto. ⚠️ EN EL FIX-PACK 2 ESTE MUTANTE MATABA 1: pasó a matar 4 porque el gate
    //       pasó a cubrir cuatro caminos, y eso es información, no ruido.
    //   G2. `aterrizar` sin su condición, o sea que NUNCA navega y siempre avisa (1 sustitución) ⇒
    //       `2 failed | 41 passed (43)`, y los dos que caen son los dos CONTROLES (el de abajo y el del
    //       `failed`). En el fix-pack 2 mataba 1; ahora hay dos controles.
    // O sea: G1 no toca los controles y G2 no toca este `it`. Un gate que se "cerrara" borrando la
    // navegación pasaría este `it` en verde, y ése es todo el motivo de que los controles existan.
    // Y el costo real de G2 está medido FUERA de este archivo, que es donde vive el camino principal:
    // `src/presentation/flow.test.tsx` da `5 failed | 106 passed (111)`. ⚠️ SON CINCO Y NO CUATRO, y el
    // quinto es información nueva del fix-pack 3: además de `T-AC6`, `T-REQUOTE`, `T-354-3g` y
    // `T-354-3h` cae `T-ESC6`, que es el único de ese archivo que mide el aterrizaje del `failed` sin
    // interacción — y sólo puede caer porque el fix-pack 3 metió el `failed` en el mismo gate. Sin G2
    // medido, "el arreglo es no navegar" se lee razonable.
    const { container, contestar } = conResumeDeferido();
    render(<RemittanceFlow container={container} />);

    // (1) La ventana: el resume todavía no contestó, así que NO hay overlay y la barra es correcta.
    expect(screen.queryByRole("heading", { name: /Verificando tu identidad/ })).toBeNull();
    const nav = barra();
    expect(nav, "en esta ventana la barra SÍ está, y es la precondición de todo el test").not.toBeNull();

    // (2) La persona elige un destino.
    fireEvent.click(within(nav as HTMLElement).getByRole("button", { name: "Recuperar" }));
    expect(screen.getByRole("heading", { name: /Recuperar fondos de un envío anterior/ })).toBeInTheDocument();

    // (3) El resume contesta. El aviso aparece; la pantalla elegida NO se mueve.
    contestar({ kind: "passed", snapshot: remesaConDeposito("rem-9") });
    expect(await screen.findByText("Tu verificación quedó lista")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Recuperar fondos de un envío anterior/ }),
      "el resume no puede llevarse puesta la pantalla que la persona eligió",
    ).toBeInTheDocument();
    // Y no aterrizó en la pantalla de la firma, que es lo que hacía antes.
    expect(screen.queryByRole("button", { name: /Confirmar y enviar/ })).toBeNull();

    // (4) EL AVISO NO ES UN DEAD-END, y este assert es el que obliga a que `setRem` se haya conservado:
    // sin el snapshot en estado, `confirm` no tiene remesa que mostrar y el botón no lleva a ninguna
    // parte. La barra sólo ofrece los tres destinos y "Empezar un envío" crearía una remesa NUEVA, así
    // que este botón es el ÚNICO camino de vuelta al envío que se estaba haciendo.
    fireEvent.click(screen.getByRole("button", { name: "Seguir con ese envío" }));
    expect(await screen.findByRole("button", { name: /Confirmar y enviar/ })).toBeInTheDocument();
    expect(screen.queryByText("Tu verificación quedó lista"), "el aviso se consume al usarlo").toBeNull();
  });

  it("🔴 (la otra mitad) sin ningún toque de barra, el resume SÍ navega solo", async () => {
    // ⚠️ SIN ESTE `it` EL GATE SE PODRÍA "CERRAR" BORRANDO LA NAVEGACIÓN, y eso rompería el camino
    // principal del KYC en móvil: la vuelta de Didit es una recarga, y si nadie tocó nada la persona
    // TIENE que aterrizar en `confirm` sola. Medido fuera de este archivo por `T-AC6`, `T-REQUOTE`,
    // `T-354-3g` y `T-354-3h` (los cuatro montan `pasoInicial="send"`); acá se mide en el MISMO montaje
    // que el `it` de arriba —default `bienvenida`, con la barra en pantalla— para que las dos mitades del
    // gate se lean juntas. La diferencia entre los dos `it` es UN click.
    // MUTANTE G2 (aplicado y corrido, ver el bloque de arriba): `aterrizar` sin su condición
    // ⇒ `1 failed | 42 passed (43)` acá y `4 failed | 107 passed (111)` en `flow.test.tsx`.
    const { container, contestar } = conResumeDeferido();
    render(<RemittanceFlow container={container} />);
    expect(barra(), "la barra está y no se la toca: eso es todo el contraste").not.toBeNull();

    contestar({ kind: "passed", snapshot: remesaConDeposito("rem-8") });
    expect(await screen.findByRole("button", { name: /Confirmar y enviar/ })).toBeInTheDocument();
    expect(
      screen.queryByText("Tu verificación quedó lista"),
      "sin elección previa no hay nada que avisar: navegar ES el comportamiento correcto acá",
    ).toBeNull();
  });

  // ══ LOS DOS CAMINOS QUE EL FIX-PACK 2 DEJÓ DECLARADOS Y ABIERTOS (fix-pack 3) ══════════════════
  //
  // 🔴 POR QUÉ NO ALCANZABA CON EL GATE DEL FIX-PACK 2: su condición era "eligió un destino CON LA
  // BARRA", y en la ventana del resume hay más de una forma de estar usando la app. Los dos caminos que
  // quedaban afuera están medidos abajo, uno por `it`, con su sonda de ANTES escrita al lado.
  //
  // ⚠️ Y LA PREGUNTA "¿HAY UN TERCERO?" SE MIDIÓ EN VEZ DE RAZONARSE. Censo de botones habilitados en el
  // montaje del resume (default `bienvenida`, sin overlay porque el resume todavía no contestó):
  //     ["Empezar un envío", "Enviar", "Mis envíos", "Recuperar"]
  // Son CUATRO y nada más: el CTA del embudo más las tres pestañas. Las puertas de `recuperar`
  // (`["Recuperar un envío perdido", "Recuperar el depósito de red de envíos anteriores"]`) y el
  // «Volver» del historial NO están en ese censo porque sus pantallas no están montadas todavía, y para
  // montarlas hay que tocar una pestaña, que YA marca el ref. Por eso `openHistory` no lleva marca
  // propia y las puertas de `recuperar` tampoco: no son primeras interacciones alcanzables.
  //
  //   MUTANTE                                                              RESULTADO MEDIDO
  //   G3. la marca del CTA de la bienvenida borrada (queda sólo la barra)  2 failed | 41 passed (43)
  //   G4. el `failed` de vuelta a sus tres sentencias sueltas              1 failed | 42 passed (43)
  //   G5. `aterrizar` aplicando `setRem(snapshot)` ANTES del gate          1 failed | 42 passed (43)
  // G3 mata los DOS `it` del embudo y ninguno de los del `failed`; G4 mata SÓLO el `it` del `failed`
  // gateado (su control pasa, y tiene que pasar: G4 es "navegar siempre", que es justo lo que el control
  // pide); G5 no mata ninguno de esos tres y sí el de la remesa en curso. O sea: los tres defectos son
  // independientes y cada uno tiene su candado.
  // ⚠️ Y LOS CONTEOS DE G1/G2 CAMBIARON CON EL FIX-PACK 3, así que los de arriba están re-medidos, no
  // heredados: G1 pasó de matar 1 a matar **4** (los cuatro `it` del defecto, porque ahora son cuatro) y
  // G2 de matar 1 a matar **2** (los dos controles). Ese crecimiento es la evidencia de que el gate pasó
  // a cubrir dos caminos más, y era el número que un fix-pack se olvida de volver a mirar.

  it("🔴 el EMBUDO también cuenta: entrar a tipear y recibir el resume NO se lleva puesto el formulario", async () => {
    // 🔴 EL CAMINO 1 DE LOS DOS QUE EL FIX-PACK 2 DECLARÓ ABIERTOS. Sonda de ANTES, en este mismo
    // montaje: «Empezar un envío» → monto `137` → llega el `passed` ⇒ la entrada de monto DESAPARECE y
    // los controles quedan en `["¿No sos vos?", "Confirmar y enviar $400.00"]`, sin ningún aviso. O sea
    // la pantalla de la firma, con la cifra de OTRA remesa, sobre una persona que estaba tipeando.
    // Sonda de DESPUÉS (lo que este `it` congela): la entrada sigue en pantalla con `137` y los
    // controles son `["¿No sos vos?", "Seguir con ese envío", "Volver al inicio", "Continuar"]`.
    // MUTANTE G3 (aplicado y corrido): borrarle la marca al handler del CTA (`onEmpezar={() =>
    // setStep("send")}`, que es lo que decía) ⇒ `2 failed | 41 passed (43)`, y los dos que caen son éste
    // y el de abajo. El monto `137` NO es cosmético: `400` es el default del formulario, así que con el
    // default los dos snapshots miden lo mismo y el assert no podría discriminar.
    const { container, contestar } = conResumeDeferido();
    render(<RemittanceFlow container={container} />);
    fireEvent.click(screen.getByRole("button", { name: /Empezar un envío/ }));
    fireEvent.change(screen.getByLabelText("Monto en dólares"), { target: { value: "137" } });

    contestar({ kind: "passed", snapshot: remesaConDeposito("rem-11") });
    expect(await screen.findByText("Tu verificación quedó lista")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Monto en dólares"),
      "el resume no puede sacar del formulario a alguien que está tipeando en él",
    ).toHaveValue("137");
    expect(screen.queryByRole("button", { name: /Confirmar y enviar/ })).toBeNull();
  });

  it("🔴 y la remesa EN CURSO no se reemplaza: el `setRem` del resume espera al botón del aviso", async () => {
    // 🔴 LA MITAD DEL CAMINO 1 QUE NO ES NAVEGACIÓN SINO PÉRDIDA DE DATOS, y es la que el fix-pack 2 no
    // podía ver porque dejó el `setRem` FUERA del gate a propósito. Sonda de ANTES, recorrido completo:
    // «Empezar un envío» → `137` + nombre + CCI → «Continuar» (que CREA la remesa) → llega el `passed`
    // ⇒ controles `["¿No sos vos?", "Confirmar y enviar $400.00"]`, y la remesa recién creada queda en el
    // repo como `created` con `ownerAddress: null`. Eso último es lo que la vuelve INALCANZABLE: el
    // `ownerAddress` sólo se puebla en `startKyc` (`startKyc`, `../domain/remittance.ts:325`), así que
    // `repo.list(address)` no la devuelve nunca y "Mis envíos" no la lista. Medido: `repo.list(dueño del
    // KYC)` da `[]` y la única fila del repo es la de `137` con `owner: null`.
    // Sonda de DESPUÉS: se queda en `connect` con su «Conectar wallet», y el aviso al lado.
    // MUTANTE G5 (aplicado y corrido): devolverle a `aterrizar` el `setRem(snapshot)` ANTES del `if`
    // ⇒ `1 failed | 42 passed (43)`, y el único que cae es ÉSTE. Los otros tres del bloque pasan, que es
    // el motivo de que este `it` exista aparte: los avisos y las pantallas se comportan igual con el
    // `setRem` adelantado, y lo único que cambia es de quién es la remesa que quedó en estado.
    const { container, contestar } = conResumeDeferido();
    render(<RemittanceFlow container={container} />);
    fireEvent.click(screen.getByRole("button", { name: /Empezar un envío/ }));
    fireEvent.change(screen.getByLabelText("Monto en dólares"), { target: { value: "137" } });
    fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), { target: { value: "Mamá" } });
    fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), { target: { value: TEST_CCI } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    expect(await screen.findByRole("button", { name: /Conectar wallet/ })).toBeInTheDocument();

    contestar({ kind: "passed", snapshot: remesaConDeposito("rem-12") });
    expect(await screen.findByText("Tu verificación quedó lista")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Conectar wallet/ }),
      "la persona estaba a un paso de conectar SU envío: el resume no puede moverla de ahí",
    ).toBeInTheDocument();
    // 🔴 EL ASSERT QUE MATA A G5, y sin él este `it` pasaba con el `setRem` adelantado: quedarse en
    // `connect` no dice de QUIÉN es la remesa que hay en estado. `connect` pinta "Vas a enviar" con
    // (`sendUsd`, `./flow.tsx:958`), así que la cifra de esa tarjeta ES la identidad de la remesa en curso, y
    // con el `setRem` antes del gate pasa a `$400.00` (la del KYC) sin que nada más en la pantalla
    // cambie. Medido: con G5 este `it` era el ÚNICO de los cuatro del bloque que caía, y sin este assert
    // no caía ninguno.
    const vasAEnviar = screen.getByText("Vas a enviar").parentElement as HTMLElement;
    expect(vasAEnviar.textContent, "la remesa en curso sigue siendo la de la persona").toContain("$137.00");
    expect(vasAEnviar.textContent, "y NO la que trajo el resume").not.toContain("$400.00");

    // Y el camino de vuelta a la remesa del KYC existe y es explícito. ⚠️ ES DE UNA SOLA DIRECCIÓN, y
    // conviene decirlo: al usarlo, `rem` pasa a ser la remesa del KYC y la de `137` queda sin fila que la
    // liste (su `ownerAddress` sigue en `null`). La diferencia con el defecto es QUIÉN decide: acá lo
    // decide un toque, no la latencia de una petición. Lo que sobrevive del formulario son los valores
    // tipeados, que siguen en estado.
    fireEvent.click(screen.getByRole("button", { name: "Seguir con ese envío" }));
    expect(await screen.findByRole("button", { name: "Confirmar y enviar $400.00" })).toBeInTheDocument();
  });

  it("🔴 el resume `failed` pasa por el MISMO gate, y su aviso NO puede decir que la verificación está lista", async () => {
    // 🔴 EL CAMINO 2. El fix-pack 2 gateó los tres `aterrizarEnConfirm` y dejó el `failed` con sus tres
    // sentencias sueltas (`setRem` + `setStep("verify")` + `setError`). Sonda de ANTES: tocar «Recuperar»
    // en la ventana y recibir después un `failed` ⇒ la pantalla elegida DESAPARECE, controles
    // `["¿No sos vos?", "Verificar mi identidad"]` y el banner "La verificación no pasó" arriba. Y el
    // control con el resume `failed` SIN tocar nada da EXACTAMENTE los mismos controles, o sea que antes
    // del fix los dos casos eran indistinguibles.
    // 🔴 POR QUÉ NO SIRVE EL COPY DE `passed`, y es la mitad del arreglo que no es cableado: "Tu
    // verificación quedó lista" es FALSO en esta rama. La variante dice que necesita otro intento, su
    // `tono` es `atencion` y no `bueno` (el verde de esta app es el del dinero que llega, no el de
    // cualquier novedad), y su botón lleva a `verify`, que es donde se reintenta.
    // ⚠️ EL BANNER DE ERROR NO SE PRENDE MIENTRAS EL AVISO ESTÁ, y es a propósito: habla de la pantalla a
    // la que se llega. Prenderlo sin navegar lo pondría sobre `recuperar`, que no tuvo ningún fallo. Se
    // prende al usar el botón, y eso es la última mitad de este `it`.
    // MUTANTE G4 (aplicado y corrido): devolverle al `else` sus tres sentencias sueltas ⇒ `1 failed |
    // 42 passed (43)`, y el único que cae es ÉSTE. El de abajo NO cae con G4 y no puede caer: G4 es
    // "navegar siempre", que es exactamente lo que el control pide. Quien mata al de abajo es G2.
    const { container, contestar } = conResumeDeferido();
    render(<RemittanceFlow container={container} />);
    fireEvent.click(within(barra() as HTMLElement).getByRole("button", { name: "Recuperar" }));

    contestar({ kind: "failed", snapshot: remesaConDeposito("rem-13") });
    expect(await screen.findByText("Tu verificación necesita otro intento")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Recuperar fondos de un envío anterior/ }),
      "un `failed` tampoco puede llevarse puesta la pantalla que la persona eligió",
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Tu verificación quedó lista"),
      "el copy del caso bueno no puede aparecer cuando la verificación NO pasó",
    ).toBeNull();
    expect(
      screen.queryByText(/La verificación no pasó/),
      "el banner habla de `verify`: sobre `recuperar` no tiene de qué hablar",
    ).toBeNull();

    // El botón es el que navega, y recién ahí el banner dice lo que pasó.
    fireEvent.click(screen.getByRole("button", { name: "Reintentar la verificación" }));
    expect(await screen.findByRole("button", { name: /Verificar mi identidad/ })).toBeInTheDocument();
    expect(screen.getByText(/La verificación no pasó/)).toBeInTheDocument();
  });

  it("🔴 (control del `failed`) sin tocar nada, el `failed` SÍ navega solo a `verify`, con su banner", async () => {
    // La otra mitad del par, por el mismo motivo que el control del `passed`: sin este `it`, el camino 2
    // se podría "cerrar" haciendo que el `failed` NUNCA navegue, y eso rompe el camino principal en
    // móvil (la vuelta de Didit es una recarga: si nadie tocó nada, una verificación rechazada TIENE que
    // dejar a la persona en la pantalla donde se reintenta, con el motivo a la vista).
    // ⚠️ ACÁ IBA A ESCRIBIR "ESTE CONTROL NO LO CUBRE NADIE AFUERA" Y ES FALSO, MEDIDO: los cuatro que
    // `flow.test.tsx` tiene para el aterrizaje sin interacción (`T-AC6`, `T-REQUOTE`, `T-354-3g`,
    // `T-354-3h`) son todos del `passed`, pero hay un QUINTO que es del `failed` y no lo había contado:
    // `T-ESC6` monta `pasoInicial="send"`, contesta `failed` al primer poll y exige `verify` + el banner.
    // Lo destapó el mutante G2, que en `flow.test.tsx` mata **5** y no 4. Este `it` sigue valiendo —mide
    // el mismo contraste en el montaje de la barra, a un click del `it` de arriba— pero "nadie más lo
    // cubre" habría sido una frase de más.
    const { container, contestar } = conResumeDeferido();
    render(<RemittanceFlow container={container} />);
    expect(barra(), "la barra está y no se la toca: eso es todo el contraste").not.toBeNull();

    contestar({ kind: "failed", snapshot: remesaConDeposito("rem-14") });
    expect(await screen.findByRole("button", { name: /Verificar mi identidad/ })).toBeInTheDocument();
    expect(screen.getByText(/La verificación no pasó/)).toBeInTheDocument();
    expect(
      screen.queryByText("Tu verificación necesita otro intento"),
      "sin interacción previa no hay nada que avisar: navegar ES el comportamiento correcto acá",
    ).toBeNull();
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
    // 38 passed (39)`. El assert que lo mata es el segundo: sin él, "la bienvenida está" y "el
    // formulario está" podrían ser las dos verdad si alguien pintara las dos.
    render(<RemittanceFlow pasoInicial="history" container={conLasDosPuertas().container} />);
    // `pasoInicial="history"` con `history === null` no pinta la lista, así que se entra caminando.
    fireEvent.click(within(barra() as HTMLElement).getByRole("button", { name: "Mis envíos" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Volver$/ }));

    expect(screen.getByRole("heading", { name: "Tu plata no pasa por Chaski" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Monto en dólares"), "«Volver» no puede meter a nadie al embudo").toBeNull();
    expect(screen.queryByText(/Paso 1 de 4/)).toBeNull();
  });

  it("🔴 y el botón se queda por un motivo MEDIDO: sobrevive a `busy` en la pantalla congelada", async () => {
    // ⚠️ POR QUÉ NO SE BORRÓ, que era la otra opción sobre la mesa (la barra ya ofrece "Enviar", así que
    // un «Volver» a pantalla completa dentro de un destino ES navegación duplicada, justo lo que el
    // work-item eliminó al borrar los enlaces del pie). Medido acá: con la billetera que nunca contesta,
    // `guard` deja `busy` en `true` sin timeout ni escape (AR/MNR-3) y las TRES pestañas quedan
    // `disabled`. El «Volver» no honra `disabled`, así que sobrevive al congelamiento.
    //
    // 🔴 ACÁ DECÍA «es el ÚNICO control vivo de la pantalla», Y ES FALSO — MEDIDO (fix-pack 2 ·
    // AR-it2/MNR-2). Censo completo de botones NO deshabilitados en el árbol que este test mide
    // (`history` con la lista pintada y la billetera colgada después):
    //     ["¿No sos vos?", "Ver seguimiento", "Volver"]
    // Son TRES. El gesto del header (`¿No sos vos?`) no honra `busy`, y el botón de fila del historial
    // tampoco: se pinta con `onOpen` y sin ningún prop de deshabilitado (`onOpen`, `flow.tsx:3435`). La
    // conclusión de fondo no se
    // mueve —el «Volver» sí sobrevive, y borrarlo cambiaba un defecto de duplicación por una pantalla más
    // pobre— pero "único" afirmaba de más, y de los otros dos uno es DESTRUCTIVO (`¿No sos vos?` borra el
    // KYC de la address y la PII del beneficiario) y el otro no sale del destino. Como salida NO
    // destructiva hacia otra pantalla, el «Volver» es el único; eso es lo que se puede afirmar.
    //
    // 🔴 Y ESTE `it` MEDÍA UN ÁRBOL DESMONTADO (fix-pack 2 · AR-it2/MNR-4). La versión vieja capturaba el
    // «Volver» del PRIMER render, hacía `cleanup()`, montaba un árbol nuevo con la billetera colgada y
    // asserteaba sobre el nodo del árbol viejo: el assert no hablaba de la pantalla congelada. Ahora hay
    // UN solo árbol y un `connectWallet` que anda la 1ª vez (pinta la lista) y se cuelga desde la 2ª.
    // ⛔ Y EL NODO SE RE-QUERYEA DESPUÉS DE COLGAR, no se cachea, porque en este árbol un nodo capturado
    // NO SOBREVIVE A UN RE-RENDER: medido, `document.body.contains(nodoCapturado) === false` y el nodo
    // fresco es OTRO objeto. La causa está medida y es del doble de `framer-motion` de este archivo: su
    // `Proxy` devuelve una función NUEVA en cada acceso, así que `motion.div === motion.div` da **false**
    // y React ve un tipo de componente distinto en cada render ⇒ remonta el subárbol entero.
    // MUTANTE (aplicado y corrido): ponerle `disabled={busy}` al «Volver» ⇒ este `it` se pone rojo, y ahí
    // el botón deja de tener motivo para existir y hay que borrarlo con su fila de
    // `jerarquia-relativa.test.tsx`. El conteo está en el encabezado, mutante F5.
    const refund = new FakeSolanaEscrowRefundGateway();
    const lister = new FakeSolanaCloseableEscrowLister([]);
    const base = buildTestContainer({ wallet: new FakeSolanaWallet(), solanaRefund: refund, solanaCloseableEscrows: lister });
    let intentos = 0;
    const container = {
      ...base,
      // Anda una vez (hace falta para PINTAR la lista) y se cuelga desde la segunda: `openHistory`
      // vuelve a entrar en `guard` y `busy` se queda arriba para siempre.
      connectWallet: {
        execute: () => {
          intentos += 1;
          return intentos === 1 ? base.connectWallet.execute() : new Promise<never>(() => {});
        },
      } as unknown as Container["connectWallet"],
      listHistory: { execute: async () => [remesaConDeposito("rem-7")] } as unknown as Container["listHistory"],
    };
    render(<RemittanceFlow pasoInicial="history" container={container} />);
    fireEvent.click(within(barra() as HTMLElement).getByRole("button", { name: "Mis envíos" }));
    // PRECONDICIÓN 1: la lista está PINTADA. Sin esto el árbol no es la pantalla que este test describe.
    expect(await screen.findByRole("button", { name: /Ver seguimiento/ })).toBeInTheDocument();

    // Se cuelga la billetera, en el MISMO árbol.
    fireEvent.click(within(barra() as HTMLElement).getByRole("button", { name: "Mis envíos" }));
    // PRECONDICIÓN 2: las pestañas quedaron muertas.
    await waitFor(() =>
      expect(
        within(barra() as HTMLElement).getByRole("button", { name: "Recuperar" }),
        "con la billetera colgada las pestañas quedan muertas: es la precondición de este test",
      ).toBeDisabled(),
    );
    // PRECONDICIÓN 3: la lista sigue pintada DESPUÉS de colgar (si se hubiera ido, lo de abajo mediría
    // otra pantalla).
    expect(screen.getByRole("button", { name: /Ver seguimiento/ })).toBeInTheDocument();

    // Y el control que este test defiende NO está disabled, en ESTE árbol y con el nodo re-queryeado.
    expect(
      screen.getByRole("button", { name: /^Volver$/ }),
      "el «Volver» del historial no puede honrar `busy`: es la salida de última instancia",
    ).not.toBeDisabled();
  });
});

describe("T-063-23 (AR/BLQ-BAJO-1): después de «Borrar igual», el dispositivo limpio arranca en el inicio", () => {
  it("🔴 no aterriza en el medio del formulario", async () => {
    // MUTANTE F4 (aplicado): `setStep("send")` al final de `forgetAndDisconnect`, que es lo que decía ⇒
    // `1 failed | 38 passed (39)`.
    //
    // El gesto significa "no soy yo, quiero un dispositivo limpio": borra el KYC de la address y la PII
    // del beneficiario. Aterrizar con "Paso 1 de 4" arriba contradice lo que se acaba de pedir.
    render(<RemittanceFlow pasoInicial="send" container={buildTestContainer({ wallet: new FakeSolanaWallet() })} />);
    fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), { target: { value: "Mamá" } });
    fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), { target: { value: TEST_CCI } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    await clickCuandoHabilite(/Conectar wallet/);
    await screen.findByText(/Revisá el envío/);

    fireEvent.click(await screen.findByRole("button", { name: /¿No sos vos\?/ }));
    await clickCuandoHabilite(/Borrar igual/); // re-AR it3/MNR-3 — el 2º click va sobre `<button disabled={busy}>` (`flow.tsx:722`)

    expect(
      await screen.findByRole("heading", { name: "Tu plata no pasa por Chaski" }),
      "un dispositivo recién limpiado arranca en la pantalla de entrada",
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Monto en dólares")).toBeNull();
    expect(screen.queryByText(/Paso 1 de 4/)).toBeNull();
  });
});
