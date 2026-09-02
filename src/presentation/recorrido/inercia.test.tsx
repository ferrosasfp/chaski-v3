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
    // ⚠️ EL LÍMITE DE ESTA FORMA, declarado: un delator al que se llame por un alias tomado en OTRA
    // línea se le escapa a las cuatro primeras filas. Por eso existe la quinta, que caza justamente el
    // gesto de tomar el alias. ⛔ Lo que sigue afuera es un alias armado por reflexión
    // (`window["local" + "Storage"]`), y eso no se cierra con un barrido de texto.
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
    };
    for (const d of DELATORES) {
      const cebo = cebos[d.nombre] ?? "";
      expect(cebo, `falta el cebo del delator «${d.nombre}»`).not.toBe("");
      expect(
        d.pattern.test(cebo),
        `el barrido NO caza «${d.nombre}» escrito con todas las letras: no está midiendo nada`,
      ).toBe(true);
    }

    const tocanElDisco: string[] = [];
    for (const abs of archivos) {
      readFileSync(abs, "utf8")
        .split("\n")
        .forEach((l, i) => {
          for (const d of DELATORES) {
            if (d.pattern.test(l)) {
              tocanElDisco.push(`${path.relative(ROOT, abs)}:${i + 1} → ${d.nombre} (${d.por})`);
            }
          }
        });
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
