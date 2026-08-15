// @vitest-environment jsdom
//
// Tests — D-1: el área segura del dispositivo.
//
// 🔴 EL DEFECTO QUE CIERRAN, medido en 40f0b68 (el commit del que sale esta rama):
//     grep -rn "safe-area\|env(safe" app src public tailwind.config.ts next.config.mjs   ⇒ 0
// Cero. Y `public/manifest.json` declara `"display": "standalone"` con `"orientation": "portrait"`,
// o sea que la app se ofrece para instalarse a PANTALLA COMPLETA. Instalada en un teléfono con
// notch, el `<header>` que lleva la píldora de cuenta corría bajo la barra de estado y el pie bajo
// la barra de gestos: el contenedor era `px-5 pb-10 pt-6` y ninguno de los tres sumaba inset.
//
// ⚠️ EL ARREGLO SON DOS MITADES QUE SE ROMPEN POR SEPARADO, y por eso hay tests de las dos:
//   · `viewportFit: "cover"` en `app/layout.tsx`. Sin esto el navegador encoge la ventana hasta el
//     rectángulo seguro él mismo, y entonces las cuatro `env(safe-area-inset-*)` valen 0 SIEMPRE.
//     Los tokens seguirían existiendo y no harían nada: verde de fuente, defecto en el teléfono.
//   · Los cuatro tokens `p-segura-*` sumando el inset, consumidos por el contenedor.
// Borrar cualquiera de las dos devuelve el defecto original, así que ninguna alcanza sola.
//
// ⚠️ QUÉ NO PRUEBAN ESTOS TESTS, declarado y no disfrazado. Acá no corre Tailwind ni un navegador:
//   · NO prueban que Tailwind emita la clase `.pt-segura-t` (eso lo hace el build; esta suite no lo
//     corre). Prueban que el token esté en el theme con el valor que dice tener.
//   · NO prueban que el navegador respete `viewport-fit=cover` ni que `env()` resuelva a algo.
//   · NO miden un solo píxel: jsdom no hace layout y `getBoundingClientRect()` devuelve 0.
// Son un candado sobre la intención declarada. Leerlos como "el header no corre bajo el notch" es
// leerlos de más: eso se comprueba en un teléfono y no acá.
//
// LOS CUATRO MUTANTES SE APLICARON Y SE MIDIERON, uno por uno, sobre el árbol de esta rama (base
// 40f0b68). No es una lista de lo que "debería" fallar:
//   · sacar `viewportFit: "cover"` de `app/layout.tsx`            ⇒ 1 failed | 6 passed
//   · `segura-r` apuntando a `safe-area-inset-left`               ⇒ 2 failed | 5 passed
//   · dejar `pt-6` en el `<main>` junto con `pt-segura-t`         ⇒ 1 failed | 6 passed
//   · `segura-t` sin el `calc(1.5rem + …)` (sólo el inset)        ⇒ 1 failed | 6 passed
//   · `segura-t` sin el fallback `, 0px`                          ⇒ 2 failed | 5 passed
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import tailwind from "../../tailwind.config";
import { RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { FakeSolanaWallet } from "../test-support/fakes";

afterEach(cleanup);

/** Los cuatro lados, con el inset que le toca a cada uno y el padding base que ya tenía la app. */
const LADOS = [
  { token: "segura-t", inset: "safe-area-inset-top", base: "1.5rem", clase: "pt-segura-t" },
  { token: "segura-b", inset: "safe-area-inset-bottom", base: "2.5rem", clase: "pb-segura-b" },
  { token: "segura-l", inset: "safe-area-inset-left", base: "1.25rem", clase: "pl-segura-l" },
  { token: "segura-r", inset: "safe-area-inset-right", base: "1.25rem", clase: "pr-segura-r" },
] as const;

function padding(): Record<string, string> {
  const p = tailwind.theme?.extend?.padding;
  if (p === undefined) throw new Error("`theme.extend.padding` ya no existe en tailwind.config.ts");
  return p as Record<string, string>;
}

describe("D-1 · los cuatro tokens de área segura suman el inset del lado que les toca", () => {
  it("cada token nombra SU inset, y no el de otro lado", () => {
    // INPUT QUE LO PONE EN ROJO, y es el error que de verdad se comete: copiar la línea de arriba y
    // dejar `safe-area-inset-top` en los cuatro. En vertical los cuatro insets menos el de arriba
    // valen 0, así que el bug se ve idéntico al arreglo hasta que alguien gira el teléfono.
    for (const { token, inset } of LADOS) {
      expect(padding()[token], token).toContain(`env(${inset},`);
    }
  });

  it("cada `env()` lleva fallback: sin él la declaración entera se cae, no 'queda como antes'", () => {
    // `calc(1.5rem + env(safe-area-inset-top))` es INVÁLIDO donde la variable no existe (escritorio,
    // navegadores viejos), y un término inválido invalida el `calc()` completo ⇒ el elemento se queda
    // sin NINGÚN padding, no con el de antes. El fallback `, 0px` es lo que hace que el peor caso sea
    // "igual que antes" en vez de "sin margen".
    //
    // INPUT QUE LO PONE EN ROJO: borrar el `, 0px` de cualquiera de los cuatro.
    for (const { token, inset } of LADOS) {
      expect(padding()[token], token).toContain(`env(${inset}, 0px)`);
    }
  });

  it("el padding base es el que la app YA tenía: esto suma el inset, no rediseña el margen", () => {
    // El par del test de arriba. Sin esto, `"segura-t": "env(safe-area-inset-top, 0px)"` pasaría los
    // dos anteriores y en un teléfono SIN notch dejaría el header pegado al borde: el inset vale 0 y
    // el margen de 24 px que había desde siempre desapareció.
    for (const { token, base } of LADOS) {
      expect(padding()[token], token).toContain(`calc(${base} +`);
    }
  });
});

describe("D-1 · el contenedor de la app consume los cuatro, leído del DOM", () => {
  /** El `<main>` REALMENTE renderizado. Sale del DOM y no del fuente: un candado que grepeara
   *  `flow.tsx` daría verde aunque ese `className` colgara de un elemento que no se pinta nunca. */
  function mainRenderizado(): HTMLElement {
    const { container } = render(
      <RemittanceFlow container={buildTestContainer({ wallet: new FakeSolanaWallet() })} />,
    );
    const main = container.querySelector("main");
    if (main === null) throw new Error("RemittanceFlow ya no renderiza un <main>");
    return main;
  }

  it("declara los cuatro `p-segura-*`", () => {
    const cls = mainRenderizado().className;
    for (const { clase } of LADOS) expect(cls, clase).toContain(clase);
  });

  it("ya no quedan los `px-5 pb-10 pt-6` viejos peleando con los nuevos", () => {
    // 🔴 ESTE ES EL QUE ATRAPA EL "ARREGLO" A MEDIAS, y es el más probable de los dos errores:
    // agregar `pt-segura-t` y dejar `pt-6`. En CSS gana el que Tailwind emite ÚLTIMO, no el que está
    // último en el atributo `class`, así que quedarse con los dos no es "redundante": es un resultado
    // que depende del orden de generación y que nadie eligió.
    const cls = ` ${mainRenderizado().className} `;
    for (const vieja of ["px-5", "pt-6", "pb-10"]) {
      expect(cls, vieja).not.toContain(` ${vieja} `);
    }
  });
});

describe("D-1 · la otra mitad: el viewport deja que la ventana llegue al borde", () => {
  // Se lee el FUENTE y no el valor, por el mismo motivo que `app/viewport.test.ts` (`bloqueViewport`,
  // `viewport.test.ts:39`): `app/layout.tsx` importa `@/presentation/providers`, `next/font/google` y
  // `./globals.css`, y sin un `vitest.config.*` en la raíz el alias `@/` no está mapeado, así que el
  // módulo no resuelve bajo vitest. Ese límite se hereda tal cual: esto NO prueba qué
  // `<meta name="viewport">` emite Next, prueba qué dice el bloque.
  //
  // ⚠️ Y una diferencia con aquel archivo que no es de estilo: allá el fuente se abre con
  // `new URL(..., import.meta.url)`, y ACÁ ESO NO FUNCIONA. Este archivo corre bajo
  // `@vitest-environment jsdom`, donde `import.meta.url` es un `http://localhost/...` y no un
  // `file:`; medido, la corrida muere con «TypeError: The URL must be of scheme file» ANTES de
  // ejecutar un solo `it` (0 tests, suite fallida). Se resuelve por `process.cwd()`, que es lo que
  // ya hace `src/composition/citas-ancladas.test.ts`.
  const FUENTE = readFileSync(path.resolve(process.cwd(), "app/layout.tsx"), "utf8");

  function bloqueViewport(): string {
    const desde = FUENTE.indexOf("export const viewport");
    if (desde === -1) throw new Error("no se encontró `export const viewport` en app/layout.tsx");
    const hasta = FUENTE.indexOf("\n};", desde);
    if (hasta === -1) throw new Error("no se encontró el cierre del bloque `viewport`");
    return FUENTE.slice(desde, hasta + 3);
  }

  it("el bloque se puede recortar (si no, los `it` de abajo darían verde por vacuidad)", () => {
    expect(bloqueViewport()).toContain("initialScale");
  });

  it("declara `viewportFit: \"cover\"`", () => {
    // INPUT QUE LO PONE EN ROJO: sacar la propiedad, o cambiarla a `"auto"` / `"contain"`. Cualquiera
    // de las tres deja los cuatro tokens de arriba valiendo su base y cero inset, con TODOS los tests
    // de este archivo en verde salvo este.
    expect(bloqueViewport()).toContain('viewportFit: "cover"');
  });
});
