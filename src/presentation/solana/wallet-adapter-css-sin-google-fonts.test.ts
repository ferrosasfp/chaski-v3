// H5 · EL CANDADO DE LA HOJA COPIADA A MANO.
//
// 🔴 QUÉ VIGILA. `wallet-adapter-vendor.css` es una copia de
// `@solana/wallet-adapter-react-ui/styles.css` a la que se le sacó UNA sola línea: el `@import` a
// Google Fonts que nuestro CSP bloquea. Copiar código de terceros tiene un costo conocido —envejece
// solo cuando el paquete cambia y nadie se entera—, así que la copia no se hace sin esto.
//
// LOS TRES `it`, y por qué hacen falta los tres:
//   · T-H5-1 la copia es EXACTAMENTE el original menos esa línea. Si el paquete cambia un estilo,
//     acá se pone rojo y hay que regenerar. Si alguien edita la copia a mano, también.
//   · T-H5-2 la copia no pide nada a un tercero. Es lo que el arreglo prometió.
//   · T-H5-3 mide el INSTRUMENTO: verifica que el original TODAVÍA traiga el `@import`. El día que
//     upstream lo saque, este `it` se pone rojo y nos avisa que este archivo entero sobra. Sin él, el
//     candado seguiría en verde para siempre defendiendo un arreglo que ya no hace falta.
//
// ⚠️ LO QUE NO VERIFICA: que el CSP efectivamente bloquee el `@import`, ni que el modal se vea bien.
// Lo primero se midió afuera, contra producción, con un navegador de verdad (2026-08-16); lo segundo
// necesita layout y acá no corre Tailwind ni hay motor de render.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DEL_PAQUETE = "node_modules/@solana/wallet-adapter-react-ui/styles.css";
const NUESTRA = "src/presentation/solana/wallet-adapter-vendor.css";

const leer = (p: string) => readFileSync(p, "utf-8");
/** Nuestra copia lleva un docblock propio arriba; el cuerpo empieza después de él. */
const cuerpoDeLaCopia = (s: string) => s.slice(s.indexOf("*/") + 2).replace(/^\n+/, "");

describe("H5 · la hoja del selector de wallets, sin el pedido a Google Fonts", () => {
  it("T-H5-1: la copia es el original menos su primera línea, y nada más", () => {
    const original = leer(DEL_PAQUETE).split("\n");
    const esperado = original.slice(1).join("\n").replace(/^\n+/, "");
    expect(cuerpoDeLaCopia(leer(NUESTRA))).toBe(esperado);
  });

  it("T-H5-2: la copia no le pide nada a ningún tercero", () => {
    // 🔴 SE MIDE EL CUERPO CSS, NO EL ARCHIVO ENTERO, y no es una comodidad: el docblock de la copia
    // CITA la URL para explicar por qué se sacó. Un `not.toContain` sobre todo el archivo daba rojo
    // por el comentario — o sea, medía el texto de la explicación en vez del pedido de red. Un
    // comentario no le pide nada a nadie.
    const cuerpo = cuerpoDeLaCopia(leer(NUESTRA));
    expect(cuerpo).not.toContain("fonts.googleapis");
    expect(cuerpo).not.toContain("fonts.gstatic");
    // Y ningún otro `@import` remoto que se cuele en una versión futura del paquete.
    expect(/@import\s+url\(\s*['"]?https?:/i.test(cuerpo)).toBe(false);
  });

  it("T-H5-3(instrumento): el paquete TODAVÍA trae el @import — si lo saca, este archivo sobra", () => {
    // Este `it` es el que impide que el candado se vuelva decorativo. Cuando se ponga rojo, la acción
    // NO es arreglarlo: es borrar la copia y volver a importar la hoja del paquete directamente.
    const primeraLinea = leer(DEL_PAQUETE).split("\n")[0];
    expect(primeraLinea).toContain("fonts.googleapis");
  });
});
