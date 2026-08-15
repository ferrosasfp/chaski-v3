// @vitest-environment jsdom
//
// Tests — D-2: con el movimiento reducido activado, ningún indicador afirma un progreso que no está
// mostrando.
//
// 🔴 EL DEFECTO QUE CIERRAN, medido en 40f0b68. `app/globals.css` le ponía
// `animation-duration: 0.001ms !important` a TODO bajo `prefers-reduced-motion: reduce`. Eso no
// apaga una animación: la CONGELA en su primer cuadro. En ese commit `flow.tsx` tenía 7
// `animate-spin` y 1 `animate-pulse`, así que quien navega con el movimiento reducido veía un
// spinner DETENIDO encima de "Preparando el pago a tu familiar". Un spinner quieto sobre esa frase
// afirma un avance que no está ocurriendo.
//
// Y había una segunda mitad sin cubrir: framer-motion escribe estilos en línea cuadro a cuadro, así
// que ninguna regla de CSS lo toca. Medido en el mismo commit: `grep -rn "useReducedMotion\|
// MotionConfig" app src` ⇒ 0, y el default de `MotionConfigContext` en la versión instalada es
// `reducedMotion: "never"`, o sea que framer IGNORA la preferencia del sistema salvo que se le diga.
//
// ── EL LÍMITE DEL ENTORNO, MEDIDO Y NO SUPUESTO ─────────────────────────────────────────────────
//
// ⚠️ ACÁ NO SE PUEDE SIMULAR EL MEDIA QUERY. Se probó, con este montaje: inyectar un `<style>` con
// una regla dentro de `@media` y leer `getComputedStyle`. Resultado:
//   · una regla PLANA sí se aplica            (`animation-duration: 5s` ⇒ se lee `5s`)
//   · la misma regla dentro de `@media (min-width: 1px)` NO se aplica (el color quedó en el de la
//     regla plana, no en el del bloque `@media`)
//   · `typeof window.matchMedia` es `"undefined"` en el jsdom de esta suite
// O sea: jsdom resuelve la cascada pero ignora los bloques `@media`. Por lo tanto NINGÚN test de
// este archivo prueba que el navegador entre al bloque cuando la persona activa la preferencia. Eso
// se comprueba en un navegador y no acá.
//
// LO QUE SÍ SE HACE CON ESO, en vez de resignarse a grepear el archivo: se lee `app/globals.css` de
// verdad, se le SACA el envoltorio `@media` al bloque de movimiento reducido y se inyectan sus
// reglas como CSS plano. Entonces jsdom sí resuelve la cascada sobre el archivo REAL, y queda
// probado que la excepción de los indicadores le gana al `!important` universal que los congelaba,
// con el motor y no con un `toContain`.
//
// ⚠️ PERO NO PRUEBA *POR QUÉ* GANA, Y LA DIFERENCIA IMPORTA. Medido en este mismo jsdom:
//     `* { animation-duration: 0.001ms !important } .c { animation-duration: 1.6s !important }` ⇒ 1.6s
//     invertido el orden de esas dos reglas                                                    ⇒ 0.001ms
// O sea: entre dos `!important`, jsdom decide por ORDEN DE APARICIÓN, no por especificidad. Un
// navegador decide por especificidad y el orden le da igual. Las dos lecturas coinciden con el
// archivo como está escrito hoy (la excepción va después del universal), y por eso está escrito así.
// Lo que este archivo NO puede detectar es que alguien mueva la excepción arriba: seguiría bien en
// el navegador, y acá se pondría en rojo. Es el sentido cómodo del error, pero conviene saberlo.
//
// ⚠️ Y un segundo límite del motor, que es el que decidió la forma del CSS: jsdom NO expande el
// shorthand `animation:` (medido: `animation: foo 1.6s ease-in-out infinite` computa
// `animation-duration: ""` y `animation-name: ""`). Por eso la excepción de `globals.css` está
// escrita con los cuatro longhands. Con el atajo sería CSS válido e invisible para este candado.
//
// LOS MUTANTES SE APLICARON Y SE MIDIERON, uno por uno, sobre el árbol de esta rama (base 40f0b68):
//   · borrar la excepción `.animate-spin, .animate-pulse` de globals.css      ⇒ 3 failed | 3 passed
//   · dejar la excepción sólo como `animation-duration: 1.6s` (sigue girando) ⇒ 1 failed | 5 passed
//   · `reducedMotion="never"` en el MotionConfig de flow.tsx                  ⇒ 1 failed | 5 passed
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";

const CSS = readFileSync(path.resolve(process.cwd(), "app/globals.css"), "utf8");

/** Recorta el bloque `@media (prefers-reduced-motion: reduce) { … }` contando llaves, y devuelve su
 *  INTERIOR. Falla ruidosamente si no lo encuentra: un helper que devolviera "" haría que todo lo de
 *  abajo pasara por vacuidad, que es como un candado deja de existir sin que nadie lo note. */
function interiorDelBloqueDeMovimientoReducido(): string {
  const i = CSS.indexOf("@media (prefers-reduced-motion: reduce)");
  if (i === -1) throw new Error("no está el bloque `prefers-reduced-motion: reduce` en globals.css");
  const abre = CSS.indexOf("{", i);
  let nivel = 0;
  for (let j = abre; j < CSS.length; j++) {
    if (CSS[j] === "{") nivel++;
    else if (CSS[j] === "}") {
      nivel--;
      if (nivel === 0) return CSS.slice(abre + 1, j);
    }
  }
  throw new Error("el bloque `prefers-reduced-motion: reduce` no cierra");
}

/** Monta el interior del bloque como CSS PLANO (más los `@keyframes` del archivo, que viven fuera) y
 *  devuelve el estilo computado de un elemento con las clases pedidas. */
function computadoBajoMovimientoReducido(clases: string): CSSStyleDeclaration {
  const keyframes = CSS.match(/@keyframes[\s\S]*?\n}/g)?.join("\n") ?? "";
  const style = document.createElement("style");
  style.textContent = `${keyframes}\n${interiorDelBloqueDeMovimientoReducido()}`;
  document.head.appendChild(style);
  const el = document.createElement("div");
  el.className = clases;
  document.body.appendChild(el);
  return getComputedStyle(el);
}

afterEach(() => {
  cleanup();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe("D-2 · el CSS: el indicador de progreso no queda congelado", () => {
  it("el recorte encuentra el bloque y no está vacío (si no, todo lo de abajo sería vacuo)", () => {
    expect(interiorDelBloqueDeMovimientoReducido().trim().length).toBeGreaterThan(0);
  });

  it("un elemento cualquiera SÍ queda congelado: la regla universal sigue viva", () => {
    // El control. Sin este test, "sacar el bloque entero" sería un arreglo válido para los de abajo,
    // y no lo es: la regla universal es la que respeta la preferencia en todo lo demás.
    expect(computadoBajoMovimientoReducido("cualquier-cosa").animationDuration).toBe("0.001ms");
  });

  it("`animate-spin` NO queda congelado: su duración no es la del `!important` universal", () => {
    // 🔴 ESTE ES EL DEFECTO, dicho como lo mide la máquina. Con la excepción borrada, esta duración
    // vuelve a ser `0.001ms` y el spinner que la persona ve encima de "Preparando el pago a tu
    // familiar" está quieto para siempre.
    //
    // La pregunta real que responde: entre dos declaraciones `!important`, ¿gana `.animate-spin`
    // (0,1,0) o el `*` (0,0,0)? La responde el motor de cascada de jsdom con el archivo REAL, no un
    // `toContain` sobre el fuente.
    const dur = computadoBajoMovimientoReducido("animate-spin").animationDuration;
    expect(dur).not.toBe("0.001ms");
    expect(dur).not.toBe("0s");
  });

  it("`animate-pulse` tampoco: el latido de la marca es el mismo tipo de afirmación", () => {
    const dur = computadoBajoMovimientoReducido("animate-pulse").animationDuration;
    expect(dur).not.toBe("0.001ms");
    expect(dur).not.toBe("0s");
  });

  it("lo que reemplaza al giro no rota ni se traslada: late", () => {
    // El par de los dos de arriba, y no es decorativo. "Que no esté congelado" lo cumpliría también
    // dejar el `spin` girando a 1s, o sea desobedecer la preferencia en vez de atenderla. Lo que se
    // pidió no es "menos información": es "sin movimiento vestibular". Este test fija que la señal
    // elegida sea la opacidad.
    //
    // INPUT QUE LO PONE EN ROJO: cambiar la excepción a `animation-duration: 2s !important` (deja el
    // `spin` de Tailwind girando lento) ⇒ el `animation-name` deja de ser el del latido.
    const cs = computadoBajoMovimientoReducido("animate-spin");
    expect(cs.animationName).toBe("chaski-en-curso");
    const kf = CSS.slice(CSS.indexOf("@keyframes chaski-en-curso"));
    const cuerpo = kf.slice(0, kf.indexOf("\n}") + 2);
    expect(cuerpo).toContain("opacity");
    for (const vestibular of ["transform", "rotate", "translate", "scale"]) {
      expect(cuerpo, vestibular).not.toContain(vestibular);
    }
  });
});

// ── framer-motion ───────────────────────────────────────────────────────────────────────────────
//
// La otra mitad. El `<MotionConfig reducedMotion="user">` tiene que estar EN EL ÁRBOL QUE SE PINTA,
// no en el fuente: uno declarado en una rama muerta dejaría verde a un grep y no cambiaría nada.
// Por eso se espía el componente real de framer y se mira si lo renderizaron y con qué prop.
const espia = vi.hoisted(() => ({ props: [] as unknown[] }));

vi.mock("framer-motion", async (importOriginal) => {
  const real = await importOriginal<typeof import("framer-motion")>();
  const { createElement } = await import("react");
  return {
    ...real,
    MotionConfig: (props: Record<string, unknown>) => {
      espia.props.push(props.reducedMotion);
      return createElement(real.MotionConfig, props);
    },
  };
});

describe("D-2 · framer: la preferencia del sistema deja de ignorarse", () => {
  it("el árbol animado se pinta dentro de un MotionConfig con `reducedMotion: \"user\"`", async () => {
    // POR QUÉ ESTE TEST Y NO UN GREP: `MotionConfig` se cuenta cuando REACT LO RENDERIZA. Si mañana
    // alguien lo deja escrito pero fuera de la rama que se pinta, `espia.props` queda vacío.
    //
    // ⚠️ LO QUE NO PRUEBA: que framer efectivamente reduzca algo. No puede probarlo acá y el motivo
    // está medido arriba — `window.matchMedia` es `undefined` en este jsdom, y framer lee justamente
    // eso (`initPrefersReducedMotion`, en `utils/reduced-motion/index.mjs` del paquete): sin
    // `matchMedia` fija `prefersReducedMotion.current = false`. O sea que acá framer NUNCA cree que
    // haya preferencia, y montar un falso de `matchMedia` sólo probaría que el falso funciona.
    // Lo que este test compra es el CABLEADO: que el default `"never"` de `MotionConfigContext`
    // —que es el que hacía que framer ignorara la preferencia— ya no sea el que rige este árbol.
    espia.props.length = 0;
    const { RemittanceFlow } = await import("./flow");
    const { buildTestContainer } = await import("../test-support/test-container");
    const { FakeSolanaWallet } = await import("../test-support/fakes");
    render(<RemittanceFlow container={buildTestContainer({ wallet: new FakeSolanaWallet() })} />);
    expect(espia.props.length).toBeGreaterThan(0);
    for (const p of espia.props) expect(p).toBe("user");
  });
});
