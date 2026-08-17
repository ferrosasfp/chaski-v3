// @vitest-environment jsdom
//
// H2 · EL GUIÓN QUE SIGNIFICABA TRES COSAS DISTINTAS.
//
// 🔴 QUÉ DEFECTO CIERRA. `preview` era `Quote | null`, y ese `null` se usaba para tres situaciones que
// no tienen nada que ver entre sí:
//   1. la cotización todavía no llegó (300 ms de debounce + la ida al corredor),
//   2. el corredor falló,
//   3. el monto no llega al mínimo, así que NO SE PIDIÓ NADA.
// Las tres se mostraban con el MISMO guión adentro de la caja verde grande. Es el caso exacto de la
// lección de este repo: un `boolean` (o un `| null`) que ya perdió el tercer valor, y la pantalla no
// puede reponer una distinción que el estado no tiene.
//
// 🔬 EL NÚMERO QUE LO HIZO VISIBLE, medido contra producción el 2026-08-16 con un navegador de verdad:
// la cifra tarda **3661 ms** desde que arranca la navegación. Durante casi cuatro segundos, el número
// que la persona vino a ver era un guión. No se lee como "estoy calculando": se lee como roto.
//
// LO QUE ESTOS `it` CONGELAN, y por qué el cuarto es el que hace falsable a los otros tres: sin
// T-H2-4, "mostrar el bloque que palpita siempre que no haya cifra" pasaría en verde, y habríamos
// cambiado un estado indistinguible por otro.
//
// ⚠️ LO QUE NO VERIFICA: que el bloque efectivamente palpite. Acá no corre Tailwind y jsdom no hace
// layout — se leen NOMBRES DE CLASE y roles de accesibilidad, la misma limitación que ya declaran
// `jerarquia-relativa.test.tsx` y `touch-targets.test.tsx`. Tampoco verifica los 3661 ms: eso se midió
// afuera, contra el sitio desplegado, y este archivo sólo congela QUÉ SE MUESTRA mientras tanto.
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import type { Container } from "../composition/container";

afterEach(() => {
  cleanup();
});

const CALCULANDO = /Calculando cuánto recibe tu familia/;
const FALLA = /No pudimos calcular la tasa ahora/;

/** El corredor que nunca contesta: deja la pantalla clavada en el estado "pidiendo". */
function corredorQueNoContesta(): Partial<Container> {
  return { previewQuote: { execute: () => new Promise(() => {}) } as unknown as Container["previewQuote"] };
}

/** El corredor caído. Lo que antes se veía igual que "todavía no llegó". */
function corredorQueFalla(): Partial<Container> {
  return {
    previewQuote: {
      execute: async () => {
        throw new Error("quote_unavailable");
      },
    } as unknown as Container["previewQuote"],
  };
}

describe("H2 · la caja de «Tu familia recibe» distingue los tres estados", () => {
  it("T-H2-1: mientras la cotización está en vuelo se anuncia que se calcula, y NO se muestra el guión", async () => {
    // MUTANTE QUE MATA: devolverle a `flow.tsx` el `<Money>{preview ? … : "—"}</Money>` sin condición.
    render(<RemittanceFlow pasoInicial="send" container={buildTestContainer({ useCases: corredorQueNoContesta() })} />);
    const enCurso = await screen.findByRole("status", { name: CALCULANDO });
    expect(enCurso).toBeInTheDocument();
    // Y la caja NO puede estar mostrando además el guión: serían dos afirmaciones a la vez.
    expect(enCurso.textContent).toBe("");
    expect(screen.queryByText(FALLA)).toBeNull();
  });

  it("T-H2-2: cuando la cifra llega, el aviso de «calculando» se va y queda el monto", async () => {
    // El par positivo. Sin él, dejar el bloque que palpita para siempre pasaría en verde.
    render(<RemittanceFlow pasoInicial="send" container={buildTestContainer()} />);
    await waitFor(() => {
      expect(screen.queryByRole("status", { name: CALCULANDO })).toBeNull();
    });
    // El contenedor real ya cotiza con el monto por defecto, así que acá tiene que haber una cifra.
    // `getAllByText` y no `getByText`: la pantalla muestra DOS cifras en soles (lo que recibe la
    // familia y la tasa "1 USD ≈ S/ …"), y exigir una sola era un falso rojo de mi propio test.
    expect(screen.getAllByText(/S\/\s?[\d,]+/).length).toBeGreaterThan(0);
    // Y lo que prueba que la cifra LLEGÓ es que el guión ya no está: es el valor que ocupaba su lugar.
    expect(screen.queryByText("—")).toBeNull();
  });

  it("T-H2-3: si el corredor falla, se dice qué pasó — y NO se sigue anunciando que se calcula", async () => {
    // 🔴 ÉSTE es el estado que no existía. Antes, un corredor caído y una cotización en vuelo se veían
    // EXACTAMENTE igual, así que la persona esperaba para siempre un número que no iba a llegar.
    // MUTANTE QUE MATA: cambiar `setEstadoCotiza("falla")` por `setEstadoCotiza("pidiendo")` en el
    // `catch` de `flow.tsx`.
    render(<RemittanceFlow pasoInicial="send" container={buildTestContainer({ useCases: corredorQueFalla() })} />);
    await screen.findByText(FALLA);
    expect(screen.queryByRole("status", { name: CALCULANDO })).toBeNull();
  });

  it("T-H2-4(control): monto por debajo del mínimo ⇒ guión, sin «calculando» y sin «falla»", async () => {
    // El `it` que hace falsables a los otros tres. "Corto" NO es un fallo (no se pidió nada, no hay
    // conexión que revisar) y NO es una espera (no hay nada en vuelo). Si alguien colapsa los estados
    // otra vez, o muestra el bloque que palpita siempre que falte la cifra, acá se pone rojo.
    const { container } = render(<RemittanceFlow pasoInicial="send" container={buildTestContainer()} />);
    const monto = container.querySelector('input[inputmode="decimal"]') as HTMLInputElement;
    expect(monto).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(monto, "1");
      monto.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.queryByRole("status", { name: CALCULANDO })).toBeNull();
    });
    expect(screen.queryByText(FALLA)).toBeNull();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
