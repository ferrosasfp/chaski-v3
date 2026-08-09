// Tests — T-341-1 (AC-1): el viewport de la app no declara techo de zoom.
//
// EL DEFECTO QUE CIERRA. `app/layout.tsx` declaraba `maximumScale: 1` en su `export const viewport`.
// Eso es un techo de zoom de 1x para TODA la app: quien no ve bien de cerca no podía agrandar
// ninguna pantalla, incluida la del CCI que hay que revisar antes de mandar plata.
//
// ⚠️ ESTE CANDADO ES MÁS DÉBIL QUE EL QUE SE INTENTÓ PRIMERO, Y ASÍ HAY QUE LEERLO.
// Lo que se quería era `import { viewport } from "./layout"` y asertar
// `viewport.maximumScale === undefined`, o sea el VALOR que Next consume. MEDIDO: no resuelve bajo
// vitest. La corrida devolvió
//   «Failed to load url @/presentation/providers (resolved id: @/presentation/providers) in
//    /…/app/layout.tsx. Does the file exist?»
// porque no hay `vitest.config.*` en la raíz de este repo y por lo tanto el alias `@/` no está
// mapeado (y `layout.tsx` también importa `next/font/google` y `./globals.css`). Crear una config de
// vitest está fuera del scope de esta HU.
//
// Así que este test lee el FUENTE como texto, no el valor que Next consume. Concretamente:
//   · NO prueba qué `<meta name="viewport">` emite Next en tiempo de build (nadie corrió `next build`
//     acá).
//   · NO prueba que el navegador deje hacer pinch-zoom.
//   · SÍ prueba que el bloque `export const viewport` del fuente no nombre `maximumScale` ni
//     `user-scalable`, que es la única forma de volver a poner el techo desde este archivo.
//
// INPUT QUE LO PONE EN ROJO: volver a agregar `maximumScale: 1,` dentro del bloque
// `export const viewport` de `app/layout.tsx`. También lo pone en rojo `user-scalable`, que es la
// otra forma de escribir el mismo techo.
//
// Y el aislamiento del bloque NO es decorativo: arriba de `export const viewport` hay un comentario
// que MENCIONA `maximumScale` para explicar por qué se fue. Un candado que grepeara el archivo
// entero estaría rojo hoy sin que nada esté mal. Por eso se recorta el bloque, y por eso el recorte
// falla ruidosamente (abajo) si el bloque cambia de forma: un candado que no encuentra lo que vigila
// y aun así pasa es un candado que dejó de existir.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FUENTE = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");

/** Recorta desde `export const viewport` hasta el primer `};` a comienzo de línea. */
function bloqueViewport(): string {
  const desde = FUENTE.indexOf("export const viewport");
  if (desde === -1) throw new Error("no se encontró `export const viewport` en app/layout.tsx");
  const hasta = FUENTE.indexOf("\n};", desde);
  if (hasta === -1) throw new Error("no se encontró el cierre del bloque `viewport`");
  return FUENTE.slice(desde, hasta + 3);
}

describe("T-341-1 (AC-1): el viewport no le pone techo al zoom", () => {
  it("el bloque `export const viewport` existe y se puede recortar", () => {
    // Si esto se rompe, los dos `it` de abajo estarían midiendo un string vacío y darían verde por
    // vacuidad. Este es el `it` que impide ese falso verde.
    const bloque = bloqueViewport();
    expect(bloque).toContain("Viewport");
    expect(bloque).toContain("initialScale");
  });

  it("no declara `maximumScale` ni `user-scalable`", () => {
    const bloque = bloqueViewport();
    expect(bloque).not.toContain("maximumScale");
    expect(bloque).not.toContain("maximum-scale");
    expect(bloque).not.toContain("user-scalable");
    expect(bloque).not.toContain("userScalable");
  });

  it("`initialScale: 1` se queda (fija el zoom de ENTRADA, no el máximo)", () => {
    // El par del `it` de arriba: "borralo todo" no es el arreglo. Sin esto, vaciar el bloque entero
    // pasaría el candado anterior.
    expect(bloqueViewport()).toContain("initialScale: 1");
  });
});
