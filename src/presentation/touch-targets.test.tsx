// @vitest-environment jsdom
//
// Tests — T-341-3/4/5/6 (AC-2, AC-3): el alto de toque de los controles que NO son `<Button>`.
//
// EL DEFECTO QUE CIERRAN, medido en un teléfono. Seis controles de la DApp eran texto subrayado sin
// alto propio: el área tocable era el alto de la línea de texto (~20 px con `text-sm`, ~16 px con
// `text-xs`), contra los 52 px que el CTA del camino feliz ya tenía. Tres de esos seis son las ÚNICAS
// puertas para recuperar plata:
//   · "Ver mis envíos"                                    (`flow.tsx:892`)
//   · "Recuperar un envío perdido"                        (`flow.tsx:2367`)
//   · "Recuperar el depósito de red de envíos anteriores"  (`flow.tsx:2517`)
// Y otros tres viven apretados en una fila del header, uno de ellos destructivo:
//   · "Borrar igual" (borra los datos locales)             (`flow.tsx:694`)
//   · "Cancelar"                                           (`flow.tsx:701`)
//   · "¿No sos vos?"                                       (`flow.tsx:711`)
//
// ⚠️ QUÉ MIDEN ESTOS TESTS Y QUÉ NO. jsdom NO hace layout: `getBoundingClientRect()` devuelve 0 y el
// alto real en píxeles NO se puede medir acá. Así que estos tests leen el NÚMERO QUE ESTÁ DENTRO DEL
// NOMBRE DE LA CLASE (`min-h-[52px]` ⇒ 52) sobre el elemento REALMENTE RENDERIZADO, y comparan ese
// número. O sea:
//   · SÍ prueban que la clase llega al `<button>` que la persona toca (sale del DOM, no del fuente).
//   · SÍ prueban la relación entre los números (≥ 52, ≥ 44, y los tres iguales).
//   · NO prueban que `min-h-[52px]` produzca 52 px. Eso lo hace Tailwind y esta suite no lo verifica.
//   · NO prueban nada del alto del texto ni del `padding` heredado.
// Es un candado sobre la intención declarada. Leerlo como "el control mide 52 px en el teléfono" es
// leerlo de más.
//
// Por qué `min-h-` y no `h-`: en una pantalla angosta el texto de estos controles envuelve, y con `h-`
// fijo quedaría recortado. Por eso el regex pide `min-h-`.
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EscrowRentRecovery, LostEscrowRecovery, RemittanceFlow } from "./flow";
import { Button } from "./ui";
import { buildTestContainer } from "../test-support/test-container";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakeSolanaCloseableEscrowLister,
  FakeSolanaEscrowRefundGateway,
  FakeSolanaWallet,
} from "../test-support/fakes";

afterEach(cleanup);

const resolveSender = async () => FAKE_SOLANA_BENEFICIARY;

/** El px declarado en el nombre de la clase del elemento renderizado. Falla RUIDOSAMENTE si no hay
 *  ninguno: un helper que devolviera 0 o `null` haría que los `expect` de abajo pasaran por vacuidad,
 *  y un candado que no encuentra lo que vigila es un candado que dejó de existir. */
function minHpx(el: HTMLElement): number {
  const m = /(?:^|\s)min-h-\[(\d+)px\]/.exec(el.className);
  if (m === null)
    throw new Error(
      `«${el.textContent}» no declara ningún min-h-[Npx]. className = «${el.className}»`,
    );
  return Number(m[1]);
}

/** El px del CTA del camino feliz, leído del `<Button>` REALMENTE renderizado (`ui.tsx:43`). Es un
 *  `h-` fijo, no un `min-h-`: ese control ya cumplía y esta HU no lo toca (CD-4), sólo lo lee. */
function pxDelCtaDelCaminoFeliz(): number {
  const { unmount } = render(<Button>referencia</Button>);
  const el = screen.getByRole("button", { name: "referencia" });
  const m = /(?:^|\s)h-\[(\d+)px\]/.exec(el.className);
  unmount();
  if (m === null) throw new Error("el <Button> de ui.tsx ya no declara ningún h-[Npx]");
  return Number(m[1]);
}

/** Las tres puertas de recuperar plata, cada una en su montaje mínimo. */
function puertasDeRecuperarPlata(): Array<{ nombre: string; el: HTMLElement }> {
  render(
    <RemittanceFlow container={buildTestContainer({ wallet: new FakeSolanaWallet() })} />,
  );
  const verEnvios = screen.getByRole("button", { name: /Ver mis envíos/ });

  render(
    <LostEscrowRecovery
      refund={new FakeSolanaEscrowRefundGateway()}
      resolveSender={resolveSender}
    />,
  );
  const envioPerdido = screen.getByRole("button", { name: /Recuperar un envío perdido/ });

  render(
    <EscrowRentRecovery
      lister={new FakeSolanaCloseableEscrowLister([])}
      resolveSender={resolveSender}
    />,
  );
  const alquiler = screen.getByRole("button", {
    name: /Recuperar el depósito de red de envíos anteriores/,
  });

  return [
    { nombre: "Ver mis envíos", el: verEnvios },
    { nombre: "Recuperar un envío perdido", el: envioPerdido },
    { nombre: "Recuperar el depósito de red de envíos anteriores", el: alquiler },
  ];
}

describe("T-341-3 (AC-2): las tres puertas de recuperar plata declaran alto de toque", () => {
  it("las tres declaran min-h de 52 px o más", () => {
    // INPUT QUE LO PONE EN ROJO: borrarle la clase `min-h-[52px]` a cualquiera de las tres
    // (`className`, `flow.tsx:892`), (`className`, `flow.tsx:2367`), (`className`, `flow.tsx:2517`)
    // ⇒ `minHpx` no matchea ⇒ throw con el nombre del control.
    //
    // El ancla es `className` porque es el ÚNICO símbolo de esas líneas, y eso acota lo que compra:
    // `citas-ancladas.test.ts` prueba que la cita cayó en una línea que declara clases, NO que sea LA
    // línea (`className` aparece en 238 líneas de `flow.tsx`; el número es una foto, la limitación no).
    // Igual es lo que faltaba: estas tres eran citas SUELTAS y por eso el candado nunca las miró, así
    // que `:2143` y `:2293` sobrevivieron sin apuntar a nada desde antes de WKH-354.
    for (const { nombre, el } of puertasDeRecuperarPlata()) {
      expect(minHpx(el), nombre).toBeGreaterThanOrEqual(52);
    }
  });
});

describe("T-341-4 (AC-2): el 52 no está escrito a mano, sale del CTA del camino feliz", () => {
  it("ninguna de las tres puertas es más baja que el CTA que ya cumplía", () => {
    // El 52 de arriba es un número suelto: si mañana el CTA del camino feliz sube a 56, estas tres
    // volverían a ser las más chicas de la pantalla y el `>= 52` seguiría verde. Este test ata la
    // relación en vez del número.
    //
    // INPUT QUE LO PONE EN ROJO: subir el `h-[52px]` de `ui.tsx:43` a `h-[56px]` sin tocar las tres.
    const referencia = pxDelCtaDelCaminoFeliz();
    expect(referencia).toBeGreaterThan(0);
    for (const { nombre, el } of puertasDeRecuperarPlata()) {
      expect(minHpx(el), nombre).toBeGreaterThanOrEqual(referencia);
    }
  });
});

/**
 * Los tres controles del bloque de reset. "¿No sos vos?" y el par "Borrar igual"/"Cancelar" NO
 * coexisten: el primero es el que abre el bloque y desaparece al abrirlo (es un ternario:
 * (`confirmReset`, `flow.tsx:686`), y la otra rama es la que pinta "¿No sos vos?"
 * (`onAskReset`, `flow.tsx:710`)). Así que el px de "¿No sos vos?" se lee ANTES del click y
 * el de los otros dos DESPUÉS. Un test que los buscara a los tres al mismo tiempo no encontraría
 * ninguno de los tres.
 */
async function pxDelBloqueDeReset(): Promise<{
  noSosVos: number;
  borrarIgual: number;
  cancelar: number;
}> {
  render(<RemittanceFlow container={buildTestContainer({ wallet: new FakeSolanaWallet() })} />);
  // El bloque de reset vive en el header y sólo aparece con `address` puesta. Abrir el historial es
  // lo que la resuelve: conecta la wallet y hace `setAddress` (`resolveSender`, `flow.tsx:380`).
  fireEvent.click(screen.getByRole("button", { name: /Ver mis envíos/ }));
  const noSosVos = await screen.findByRole("button", { name: "¿No sos vos?" });
  const px = { noSosVos: minHpx(noSosVos), borrarIgual: 0, cancelar: 0 };

  fireEvent.click(noSosVos);
  px.borrarIgual = minHpx(await screen.findByRole("button", { name: "Borrar igual" }));
  px.cancelar = minHpx(screen.getByRole("button", { name: "Cancelar" }));
  return px;
}

describe("T-341-5 (AC-3): los tres controles del bloque de reset llegan al mínimo de toque", () => {
  it("los tres declaran min-h de 44 px o más", async () => {
    // 44 px es el mínimo de WCAG 2.5.5 / HIG. No son 52 porque los tres viven en una MISMA fila del
    // header (`flow.tsx:689`) y a 52 cada uno el header crece más de lo necesario.
    //
    // INPUT QUE LO PONE EN ROJO: dejar cualquiera de los tres sin `min-h-`
    // (`className`, `flow.tsx:694`), (`className`, `flow.tsx:701`), (`className`, `flow.tsx:711`)
    // ⇒ `minHpx` no matchea ⇒ throw nombrando el control. Mismo ancla débil que en T-341-3 y por el
    // mismo motivo: es el único símbolo de la línea.
    const px = await pxDelBloqueDeReset();
    expect(px.noSosVos, "¿No sos vos?").toBeGreaterThanOrEqual(44);
    expect(px.borrarIgual, "Borrar igual").toBeGreaterThanOrEqual(44);
    expect(px.cancelar, "Cancelar").toBeGreaterThanOrEqual(44);
  });
});

describe("T-341-6 (AC-3): el destructivo mide EXACTAMENTE lo mismo que sus vecinos", () => {
  it("«Borrar igual» no es ni el más chico ni el más grande de la fila", async () => {
    // 🔴 ESTE TEST CLAVA LOS DOS LADOS, y por eso es una igualdad y no una desigualdad:
    //   · Bajar «Borrar igual» a 36 ⇒ ROJO. Es el defecto original: la acción que borra datos era la
    //     más chica de la fila, así que quien apunta y falla pega en otra cosa.
    //   · Subir «Borrar igual» a 56 ⇒ ROJO. Es el defecto OPUESTO, y sería el "arreglo" intuitivo:
    //     agrandar el destructivo invita el toque accidental en la única acción que borra datos.
    // Iguales cierran el defecto sin crear su opuesto. Una desigualdad (`>= 44`) admitiría las dos
    // cosas, y de hecho T-341-5 las admite: por eso hacen falta los dos tests y no uno.
    const px = await pxDelBloqueDeReset();
    expect(px.borrarIgual).toBe(px.cancelar);
    expect(px.borrarIgual).toBe(px.noSosVos);
  });
});
