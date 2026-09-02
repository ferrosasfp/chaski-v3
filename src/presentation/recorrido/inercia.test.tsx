// @vitest-environment jsdom
//
// WKH-374 · W1.2 — LA INERCIA: CON LA BANDERA APAGADA, NADA CAMBIA
//
// 🔴 QUÉ MIDE ESTE ARCHIVO Y QUÉ NO. Mide que el recorrido nuevo esté detrás de un interruptor
// estricto y que, apagado, la página monte el árbol de HOY. ⛔ NO mide nada del recorrido nuevo en
// producción: con la bandera apagada el árbol nuevo NO SE EJECUTA, así que ningún número sobre él
// sale de acá. ⛔ Y nada de esto corre en un teléfono: todo es jsdom.

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// Los dos dobles que el árbol VIEJO necesita bajo jsdom. Sin ellos este archivo mediría el entorno y
// no el interruptor. Mismos reemplazos, y por los mismos motivos, que los de `../flow.test.tsx`.
vi.mock("@solana/wallet-adapter-wallets", async () => {
  const p = await import("@solana/wallet-adapter-phantom");
  const s = await import("@solana/wallet-adapter-solflare");
  return { PhantomWalletAdapter: p.PhantomWalletAdapter, SolflareWalletAdapter: s.SolflareWalletAdapter };
});
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  MotionConfig: ({ children }: { children: React.ReactNode }) => children,
  motion: new Proxy({} as Record<string, unknown>, {
    get: (t: Record<string, unknown>, tag: string) => {
      if (!(tag in t))
        t[tag] = ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
          React.createElement(tag, props, children);
      return t[tag];
    },
  }),
}));

import { RemittanceFlow } from "../flow";
import { buildTestContainer } from "../../test-support/test-container";
import { recorridoV2Enabled } from "./bandera";
import { Recorrido } from "./recorrido";

const ROOT = process.cwd();
const BANDERA = "NEXT_PUBLIC_CHASKI_RECORRIDO_V2";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

/**
 * El subárbol que `app/page.tsx` monta con el ternario, reproducido acá con la MISMA expresión.
 *
 * ⚠️ QUÉ PIERDE ESTA FORMA, dicho para que nadie le pida lo que no da: `app/page.tsx` importa por el
 * alias `@/` y este repo no tiene configuración de vitest, así que un `import` de la página muere en
 * «Failed to resolve import». Medido: es la misma limitación que ya tiene escrita el candado del
 * bloque de diagnóstico, que por eso mide el FUENTE. ⇒ acá se ejecuta la MISMA expresión y, aparte,
 * el `it` verifica contra el fuente que la página la escriba igual.
 */
function SubarbolDeLaPagina({ container }: { container: ReturnType<typeof buildTestContainer> }) {
  return recorridoV2Enabled() ? <Recorrido container={container} /> : <RemittanceFlow container={container} />;
}

describe("WKH-374/W1.2 · la bandera apagada no cambia nada (AC-13)", () => {
  // MUTANTE QUE MATA (`MW-10`): invertir el ternario de `app/page.tsx` ⇒ cae la aserción 2.
  // ⛔ FALSO KILLED A EVITAR: `MW-10` también pone rojo a otros `it` del árbol viejo que montan la
  // página. El `×` que cuenta es el de ESTE `it`, aserción 2, citado por su mensaje.
  it("T-374-W1-10: con la bandera APAGADA, la página monta el árbol de HOY y su innerHTML es idéntico", () => {
    // ── (1) LA BANDERA AUSENTE MONTA ALGO ────────────────────────────────────────────────────────
    vi.stubEnv(BANDERA, undefined as unknown as string);
    const { container: raizApagada } = render(<SubarbolDeLaPagina container={buildTestContainer()} />);
    const apagada = raizApagada.innerHTML;
    // Sin esto, un render que fallara antes dejaría `apagada` vacío y la comparación de abajo pasaría
    // por vacío. Es la pieza que el molde de la otra bandera llama su `toBeTruthy` de CD-18.
    expect(apagada, "no se llegó a renderizar el subárbol de la página con la bandera apagada").toBeTruthy();

    // ── (2) ES EL MISMO ÁRBOL QUE EL DE HOY, MONTADO SOLO ────────────────────────────────────────
    cleanup();
    const { container: raizHoy } = render(<RemittanceFlow container={buildTestContainer()} />);
    expect(
      raizHoy.innerHTML,
      "con la bandera apagada la página NO monta el árbol de hoy: el recorrido viejo cambió sin que nadie lo pidiera",
    ).toBe(apagada);

    // ── (3) LA MITAD QUE VUELVE FALSABLE A LA 2 ─────────────────────────────────────────────────
    // 🔴 Sin esta línea, la 2 pasaría porque el árbol nuevo NO SE MONTA NUNCA, no porque la bandera lo
    // decida. Con ella, las dos sólo pueden ser ciertas a la vez si la bandera es exactamente lo que
    // elige.
    cleanup();
    vi.stubEnv(BANDERA, "true");
    const { container: raizPrendida } = render(<SubarbolDeLaPagina container={buildTestContainer()} />);
    expect(
      raizPrendida.innerHTML,
      "con la bandera PRENDIDA la pantalla no cambió: el recorrido nuevo no se está montando",
    ).not.toBe(apagada);

    // ── (4) Y LA PÁGINA REAL ESCRIBE ESA MISMA EXPRESIÓN ────────────────────────────────────────
    // El `it` de arriba ejecuta una copia; esto ata la copia al original. ⛔ Sin esto, la página podría
    // haber dejado de tener el ternario y los tres puntos anteriores seguirían verdes.
    const pagina = readFileSync(path.join(ROOT, "app/page.tsx"), "utf8");
    expect(
      pagina,
      "`app/page.tsx` ya no monta el ternario de la bandera: este `it` estaría midiendo una copia sin original",
    ).toContain("recorridoV2Enabled() ? <Recorrido /> : <RemittanceFlow />");
  });

  // MUTANTE QUE MATA (`MW-11`): en `./bandera.ts`, cambiar `=== "true"` por
  // `?.toLowerCase() === "true"` ⇒ el valor en mayúsculas pasa a prender y la fila lo caza.
  // ⛔ FALSO KILLED A EVITAR: probar sólo el valor que prende y la ausencia. El molde prueba CINCO
  // formas de no prender, y se copian las cinco.
  it("T-374-W1-11: sólo el literal `true` prende la bandera del recorrido nuevo", () => {
    // Lo que SÍ prende, primero: sin esta fila el `it` pasaría con una función que devuelve `false`
    // siempre, que es el mutante más barato de todos.
    vi.stubEnv(BANDERA, "true");
    expect(recorridoV2Enabled(), "el literal `true` TIENE que prender, o esto no gatea nada").toBe(true);
    for (const v of ["", "1", "TRUE", "True", "true ", " true", "yes", "on"]) {
      vi.stubEnv(BANDERA, v);
      expect(recorridoV2Enabled(), `el valor ${JSON.stringify(v)} NO puede prender la bandera`).toBe(false);
    }
    vi.stubEnv(BANDERA, undefined as unknown as string);
    expect(recorridoV2Enabled(), "ausente tiene que estar APAGADA").toBe(false);
  });

  // ── LOS DOS BARRIDOS ESTÁTICOS DEL ÁRBOL NUEVO ────────────────────────────────────────────────
  //
  // MUTANTES QUE MATAN: `MW-12a` — un `window.localStorage.getItem` en `./pantallas.tsx` ⇒ cae (a).
  //                     `MW-12b` — un `className="text-sm"` en `./pantallas.tsx` ⇒ cae (b).
  // ⛔ FALSO KILLED A EVITAR: `MW-12b` NO pone rojo al `it` del vocabulario de diseño que ya existe en
  // `../ola-2-pantallas.test.tsx`, porque ése recorre una lista de DOS archivos escrita a mano y el
  // árbol nuevo queda fuera de su barrido. ⛔ Ese archivo no se toca y ⛔ no se lo importa: importar un
  // archivo de test corre sus `describe` y los duplica en el reporte. El predicado se re-escribe acá
  // con su cita al lado.
  //
  // 🔴 EXCLUSIÓN POR RUTA EXACTA, ⛔ nunca por glob ni por el sufijo de test: ESTE archivo escribe los
  // delatores en su propia prosa y en su control negativo, así que sin excluirse el barrido se leería
  // a sí mismo y el `it` no podría dar verde jamás — que es la otra cara de un guard que no puede
  // fallar. Molde: (`SELF`, `../../composition/citas-ancladas.test.ts:56`).
  it("T-374-W1-12: ninguna pantalla del recorrido nuevo toca disco, URL ni un tamaño de texto de fábrica", () => {
    // Las DOS exclusiones, por RUTA EXACTA y cada una con su motivo escrito:
    //   · este archivo, porque escribe los delatores en su prosa y en su control negativo;
    //   · el archivo que EJERCITA el recorrido, porque su control positivo siembra un token en el
    //     almacén a mano — es lo que separa «el token no está» de «el instrumento no mira».
    // ⛔ Ninguna es un glob ni el sufijo de test: `pasos.test.ts` y `salto.test.ts` siguen barridos.
    const EXCLUIDOS = [
      path.resolve(ROOT, "src/presentation/recorrido/inercia.test.tsx"),
      path.resolve(ROOT, "src/presentation/recorrido/recorrido.test.tsx"),
    ];
    for (const e of EXCLUIDOS) {
      // Una exclusión con un typo no excluye nada y no se nota; una que apunta a un archivo borrado
      // tampoco. Las dos tienen que existir.
      expect(existsSync(e), `la exclusión ${path.relative(ROOT, e)} no apunta a ningún archivo`).toBe(true);
    }
    const archivos = recorrer(path.join(ROOT, "src/presentation/recorrido")).filter(
      (f) => !EXCLUIDOS.includes(path.resolve(f)),
    );
    // Y los CINCO archivos de producción del árbol nuevo tienen que estar adentro del barrido: una
    // exclusión que se llevara puesto uno dejaría este `it` verde sobre el archivo que más importa.
    for (const rel of [
      "src/presentation/recorrido/pasos.ts",
      "src/presentation/recorrido/salto.ts",
      "src/presentation/recorrido/bandera.ts",
      "src/presentation/recorrido/pantallas.tsx",
      "src/presentation/recorrido/recorrido.tsx",
    ]) {
      expect(
        archivos.map((f) => path.relative(ROOT, f)),
        `${rel} quedó FUERA del barrido: el guard no lo estaría mirando`,
      ).toContain(rel);
    }
    expect(
      archivos.length,
      "el barrido no encontró archivos del recorrido nuevo: las dos patas pasarían por vacío",
    ).toBeGreaterThanOrEqual(5);

    // ── PATA (a) · NI DISCO NI BARRA DE DIRECCIONES ──────────────────────────────────────────────
    //
    // ⛔ Se lee con `readFileSync`, ⛔ nunca con `import`: un guard de existencia que importa lo que
    // vigila muere por «Failed to resolve import», y eso NO es un KILLED.
    //
    // ⚠️ EL LÍMITE DE LA PRIMERA FILA, declarado: prohíbe el objeto `localStorage` ENTERO, así que
    // también prohíbe LEERLO. Es a propósito: la costura que esto protege es que el árbol nuevo no
    // sepa dónde vive el borrador, y leerlo lo sabría igual que escribirlo.
    // 🔴 LOS PATRONES SON CALL-SHAPED O ASIGNACIÓN-SHAPED, ⛔ NUNCA SUBSTRINGS CRUDOS, y no es una
    // preferencia: con substrings crudos este `it` salió rojo la primera vez que lo corrí, y el
    // culpable eran los DOCBLOCKS de las propias pantallas, que nombran los delatores para prohibirlos.
    // Es la misma «TRAMPA 3» que este repo ya tiene escrita en
    // (`FORBIDDEN`, `../../composition/no-evm-surface.test.ts:56`): los comentarios no son código.
    //
    // 🔴 EL BARRIDO CORRE SOBRE EL ARCHIVO CON LOS SALTOS DE LÍNEA COLAPSADOS, Y ÉSE ES EL ARREGLO DEL
    // `BLQ-MED-2` DEL AR. Acá se barría LÍNEA POR LÍNEA, y el AR midió que cuatro escrituras metidas en
    // `./pantallas.tsx` dejaban este `it` en PASS y el lint sin una mención. Lo grave de una de ellas:
    // la forma que se escapaba era **el alias partido en dos líneas**, o sea el gesto que la quinta
    // fila vino a cerrar, con el salto de línea que el formateador produce solo. Un barrido por línea y
    // un formateador que envuelve son un agujero que se abre sin que nadie lo pida.
    //
    // ⚠️ EL LÍMITE, REESCRITO CON LO QUE QUEDA REALMENTE AFUERA (la frase anterior era de cobertura y
    // dos líneas la falsificaban):
    //   · un alias armado por REFLEXIÓN (`window["local" + "Storage"]`, un nombre de propiedad en una
    //     variable): no se cierra con un barrido de texto, y no se intenta;
    //   · la INDIRECCIÓN por otro módulo: una pantalla que llame a un helper de fuera de este
    //     directorio que toque el disco. El barrido mira estos archivos y ⛔ no sigue los imports;
    //   · el disco al que se llegue por una API que no sea ninguna de estas ocho (IndexedDB, la Cache
    //     API, `navigator.storage`). ⛔ Ninguna está en la tabla y ninguna se afirma cubierta.
    // Lo que sí queda cerrado, y está calibrado más abajo con un cebo PARTIDO EN DOS LÍNEAS: cualquiera
    // de las ocho formas, escrita en una línea o repartida en varias.
    const DELATORES = [
      {
        nombre: "localStorage",
        pattern: /\blocalStorage\s*\.\s*\w+\s*[([=]/,
        por: "el borrador dejaría de tener un solo dueño",
      },
      {
        nombre: "sessionStorage",
        pattern: /\bsessionStorage\s*\.\s*\w+\s*[([=]/,
        por: "ídem, en el almacén de la pestaña",
      },
      {
        nombre: "escritura de document.cookie",
        pattern: /\bdocument\s*\.\s*cookie\s*=[^=]/,
        por: "una cookie escrita desde la pantalla",
      },
      {
        nombre: "lectura de document.cookie",
        pattern: /\bdocument\s*\.\s*cookie\s*[.;),]/,
        por: "la pantalla estaría leyendo credenciales del documento",
      },
      {
        nombre: "asignación de window.location",
        pattern: /\bwindow\s*\.\s*location\s*(?:\.\s*\w+\s*)?=[^=]/,
        por: "la pantalla estaría navegando por su cuenta",
      },
      {
        nombre: "reescritura del historial",
        pattern: /\bhistory\s*\.\s*(?:replaceState|pushState)\s*\(/,
        por: "la pantalla estaría reescribiendo la barra",
      },
      {
        nombre: "alias de un almacén",
        pattern: /=\s*(?:window\s*\.\s*)?(?:local|session)Storage\b/,
        por: "tomar el almacén en una variable es tocarlo igual, sólo que en dos líneas",
      },
      {
        // La OCTAVA, del fix-pack: las cuatro primeras piden un `.` y se les escapa el corchete.
        nombre: "índice de un almacén",
        pattern: /\b(?:window\s*\.\s*)?(?:local|session)Storage\s*\[\s*["'`]/,
        por: "entrar al almacén por corchetes es tocarlo igual que por punto",
      },
    ] as const;

    // CONTROL NEGATIVO, con los LITERALES EXACTOS que el instrumento tiene que cazar, en memoria. Sin
    // esto, el `toEqual([])` de abajo es indistinguible de un barrido que no ve nada. ⚠️ Escrito por
    // el LITERAL y no por lo que significa: un control negativo redactado por su significado no caza.
    const cebos: Record<string, string> = {
      localStorage: 'window.localStorage.getItem("x");',
      sessionStorage: 'window.sessionStorage.setItem("x", "y");',
      "escritura de document.cookie": 'document.cookie = "x=1";',
      "lectura de document.cookie": "const c = document.cookie;",
      "asignación de window.location": 'window.location.href = "https://ejemplo.test/";',
      "reescritura del historial": 'window.history.replaceState(null, "", "/x");',
      "alias de un almacén": "const s = window.localStorage;",
      "índice de un almacén": 'window.localStorage["x"] = "y";',
    };
    for (const d of DELATORES) {
      const cebo = cebos[d.nombre] ?? "";
      expect(cebo, `falta el cebo del delator «${d.nombre}»`).not.toBe("");
      expect(
        d.pattern.test(cebo),
        `el barrido NO caza «${d.nombre}» escrito con todas las letras: no está midiendo nada`,
      ).toBe(true);
    }

    // 🔴 CONTROL NEGATIVO DE LA NORMALIZACIÓN, y es el que vuelve falsable al arreglo del `BLQ-MED-2`.
    // Los OCHO cebos de arriba se escriben en UNA línea, así que los pasaría también el barrido viejo.
    // Éste está PARTIDO, que es la forma que el AR usó para escaparse, y trae su propia refutación: se
    // exige que el barrido por línea NO lo cace y que el normalizado SÍ. Sin la segunda mitad, esto
    // sería un `it` que aplaude cualquier normalización, incluida una que no haga nada.
    const CEBO_PARTIDO = 'const s =\n  window.localStorage;\nconst t = s;';
    const aliasPartido = DELATORES.find((d) => d.nombre === "alias de un almacén");
    expect(aliasPartido, "el delator del alias desapareció de la tabla: el cebo partido no mide nada").toBeDefined();
    expect(
      CEBO_PARTIDO.split("\n").some((l) => aliasPartido?.pattern.test(l) === true),
      "el cebo PARTIDO se caza línea por línea: entonces no reproduce el escape que el AR midió y este control no dice nada",
    ).toBe(false);
    const normalizado = normalizar(CEBO_PARTIDO);
    expect(
      aliasPartido?.pattern.test(normalizado.texto),
      "el barrido normalizado NO caza el alias partido en dos líneas: sigue abierto el gesto que la quinta fila vino a cerrar",
    ).toBe(true);
    // Y la línea que reporta es la del arranque del match, no un número cualquiera.
    expect(
      normalizado.lineaDe(normalizado.texto.indexOf("=")),
      "el mapeo de posición a línea no apunta a la línea donde el match arranca: los hallazgos citarían un número inventado",
    ).toBe(1);
    expect(
      normalizado.lineaDe(normalizado.texto.indexOf("const t")),
      "el mapeo de posición a línea no llega a la tercera línea",
    ).toBe(3);

    const tocanElDisco: string[] = [];
    for (const abs of archivos) {
      const { texto, lineaDe } = normalizar(readFileSync(abs, "utf8"));
      for (const d of DELATORES) {
        // ⛔ La copia con `g` se arma ACÁ y por match: `test()` con `g` arrastra `lastIndex` entre
        // llamadas y saltearía uno de cada dos, que es un falso VERDE gratis de evitar.
        for (const m of texto.matchAll(new RegExp(d.pattern.source, "g"))) {
          tocanElDisco.push(
            `${path.relative(ROOT, abs)}:${lineaDe(m.index)} → ${d.nombre} (${d.por})`,
          );
        }
      }
    }
    expect(
      tocanElDisco,
      "una pantalla del recorrido nuevo toca disco o la barra de direcciones: eso rompe la costura que deja mover el borrador sin tocar una pantalla",
    ).toEqual([]);

    // ── PATA (b) · EL VOCABULARIO DE DISEÑO ES EL DE LA CASA ─────────────────────────────────────
    //
    // El mismo predicado que (`clasesDe`, `../ola-2-pantallas.test.tsx:91`) usa en su línea 130, con su
    // cita al lado y re-escrito acá porque aquel barrido no mira este árbol.
    const viejos = /^text-(xs|sm|base|lg|xl|[2-9]xl)$/;
    expect(viejos.test("text-sm"), "el predicado del vocabulario retirado no caza nada").toBe(true);
    expect(viejos.test("text-body"), "el predicado caza el vocabulario por ROL: estaría prohibiendo el bueno").toBe(
      false,
    );

    let clasesVistas = 0;
    const deFabrica: string[] = [];
    for (const abs of archivos) {
      for (const clases of clasesDe(abs)) {
        for (const c of clases.split(/\s+/)) {
          if (c === "") continue;
          clasesVistas++;
          if (viejos.test(c)) deFabrica.push(`${path.relative(ROOT, abs)}: ${c}`);
        }
      }
    }
    expect(
      clasesVistas,
      "el barrido de clases no encontró ninguna: la lista de abajo pasaría por vacío",
    ).toBeGreaterThan(20);
    expect(
      deFabrica,
      "quedó un tamaño de texto de fábrica en el recorrido nuevo: el vocabulario es por ROL",
    ).toEqual([]);
  });
});

/** Los `.ts`/`.tsx` de un directorio, recursivo.
 *  Molde: (`walk`, `../../composition/no-evm-surface.test.ts:35`). */
function recorrer(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) recorrer(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * 🔴 EL ARCHIVO CON LOS SALTOS DE LÍNEA COLAPSADOS, MÁS EL MAPA DE VUELTA A LA LÍNEA ORIGINAL.
 *
 * Existe por el `BLQ-MED-2` del AR: un barrido por línea no ve un delator que el formateador partió
 * en dos, y ésa era la forma con la que se le escapaban cuatro escrituras. Cada salto de línea pasa a
 * ser UN espacio —así una llamada envuelta se lee igual que una en una línea— y `lineaDe` devuelve la
 * línea donde arranca el match, para que el hallazgo se pueda citar por número.
 *
 * ⚠️ LO QUE ESTA FORMA EMPEORA, declarado: al pegar líneas, un delator escrito en la prosa de un
 * docblock puede juntarse con el código de la línea siguiente y dar un falso positivo. El efecto es
 * revisar de MÁS, nunca de menos, y las ocho formas son call-shaped o índice-shaped —nunca substrings
 * crudos— justamente para que la prosa de este árbol, que nombra los delatores para prohibirlos, no
 * los dispare. Medido: con las ocho filas y el árbol de hoy, el barrido devuelve la lista vacía.
 */
function normalizar(src: string): { texto: string; lineaDe: (i: number) => number } {
  const lineas = src.split("\n");
  const inicios: number[] = [];
  let largo = 0;
  for (const l of lineas) {
    inicios.push(largo);
    largo += l.length + 1; // +1 por el separador con el que se pegan
  }
  const texto = lineas.join(" ");
  return {
    texto,
    lineaDe: (i: number) => {
      let n = 1;
      for (let k = 0; k < inicios.length; k++) if ((inicios[k] as number) <= i) n = k + 1;
      return n;
    },
  };
}

/** Los `className="..."` de un archivo. ⛔ NUNCA el archivo entero: los comentarios de este repo citan
 *  clases viejas para contar su historia, y un barrido textual las contaría como usos. Mismo recorte,
 *  y por el mismo motivo, que (`clasesDe`, `../ola-2-pantallas.test.tsx:91`). */
function clasesDe(abs: string): string[] {
  const src = readFileSync(abs, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{cn\(([\s\S]*?)\)\})/g)) {
    out.push(m[1] ?? m[2] ?? "");
  }
  return out;
}
