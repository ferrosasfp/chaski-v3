// @vitest-environment jsdom
//
// Tests · D-3: la app tiene títulos, y por lo tanto estructura.
//
// 🔴 EL DEFECTO QUE CIERRAN, medido en 40f0b68: `grep -c "<h[1-6]" src/presentation/flow.tsx` ⇒ 0.
// Cero. Todos los títulos de pantalla eran `<p className="text-base font-bold">`: se VEN como
// títulos y para un lector de pantalla no lo son. La consecuencia concreta no es estética. Quien
// navega por encabezados (el gesto estándar de VoiceOver y TalkBack para saltar entre secciones) no
// tenía ni una parada en toda la aplicación: la app era un bloque plano, y para llegar a "Recuperar
// un envío perdido" (una de las tres puertas para recuperar plata) había que recorrer todo el texto
// de arriba, en orden.
//
// ⚠️ POR QUÉ ESTO NO CAMBIA UN PIXEL, que es lo que hace al cambio barato. `app/globals.css` abre con
// `@tailwind base`, o sea preflight, que resetea `font-size`, `font-weight` y `margin` de h1..h6 a
// heredar. Sin preflight, cambiar un `<p>` por un `<h1>` traería los estilos por defecto del
// navegador y sí se vería. Acá el tamaño y el peso siguen saliendo enteros del `className`, que no
// se tocó en ninguno de los doce sitios.
// ⚠️ Y esta suite NO puede probar eso: jsdom no carga `globals.css` ni aplica preflight. Es un
// razonamiento sobre el CSS, no una medición, y así hay que leerlo.
//
// ── DOS NIVELES Y NO TRES, A PROPÓSITO ──────────────────────────────────────────────────────────
//
// Se usan `<h1>` (el nombre de la app, en el header, que se pinta siempre) y `<h2>` (los títulos de
// pantalla y de bloque). NO se introduce un tercer nivel en esta ola, y el motivo es medible:
// bloques como "Recuperar un envío perdido" (`h2`, `flow.tsx:2376`) se pintan dentro del paso `send`, que
// NO tiene título propio. Marcarlos `<h3>` ahí sería saltear el nivel 2, que es un defecto distinto
// del que se está cerrando. Los sub-encabezados que sí tienen un padre claro ("Verificación única",
// "Quién va a atender tu envío", los encabezados de grupo del historial) quedan como `<p>` para la
// ola 2, que es cuando los sitios de llamada se mueven de todos modos.
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LostEscrowRecovery, RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { FAKE_SOLANA_BENEFICIARY, FakeSolanaEscrowRefundGateway, FakeSolanaWallet } from "../test-support/fakes";

afterEach(cleanup);

function pintarFlujo() {
  return render(<RemittanceFlow container={buildTestContainer({ wallet: new FakeSolanaWallet() })} />);
}

describe("D-3 · la primera pantalla ya no es un bloque plano", () => {
  it("hay al menos un encabezado (el candado no está vacío)", () => {
    // Sin este `it`, borrar TODOS los encabezados dejaría a los de abajo fallando por "no encontré
    // el elemento", que es el mismo rojo que da un test mal escrito. Este dice cuál de las dos cosas
    // pasó.
    pintarFlujo();
    expect(screen.getAllByRole("heading").length).toBeGreaterThan(0);
  });

  it("el nombre de la app es el `<h1>`, y es UNO solo", () => {
    // INPUT QUE LO PONE EN ROJO: devolver el título del header a un párrafo (`h1`, `flow.tsx:664`).
    //
    // Y el `toHaveLength(1)` no es celo: dos `<h1>` en la misma página vuelven a dejar sin respuesta
    // la pregunta "¿dónde estoy?", que es justo lo que un `<h1>` contesta.
    pintarFlujo();
    const h1 = screen.getAllByRole("heading", { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]).toHaveTextContent("Chaski");
  });

  it("no aparece ningún nivel 3 o más: no se saltea el 2", () => {
    // El par del test de arriba. "Poner encabezados" mal hecho es marcar todo `<h3>` porque se ve
    // del tamaño que uno quiere: un lector de pantalla anuncia entonces una jerarquía que no existe.
    //
    // ⚠️ ESTO NO PIDE QUE HAYA UN `<h2>`, y el motivo se midió. La primera versión de este test
    // aserteaba `[1, 2]` y dio ROJO con "expected [ 1 ] to deeply equal [ 1, 2 ]": en el paso `send`,
    // que es la pantalla de entrada, el ÚNICO encabezado es el `<h1>` del header. Esa pantalla no
    // tiene ningún título de sección (ni antes ni ahora), y ponerle uno sería escribir copy nueva,
    // que esta ola tiene prohibido. Así que el invariante que se puede sostener hoy es el de arriba:
    // ningún nivel salteado. Que la pantalla de entrada gane un título es una decisión de producto,
    // no de tipografía.
    pintarFlujo();
    const niveles = screen.getAllByRole("heading").map((h) => Number(h.tagName.slice(1)));
    expect(niveles).not.toEqual([]);
    for (const n of niveles) expect(n).toBeLessThanOrEqual(2);
  });
});

describe("D-3 · las puertas de recuperar plata son paradas de navegación", () => {
  it("«Recuperar un envío perdido» es un encabezado, no un párrafo en negrita", () => {
    // 🔴 ESTE ES EL CASO QUE JUSTIFICA LA HU. Es una de las tres puertas para recuperar plata (las
    // mismas que `touch-targets.test.tsx` cuida por el lado del área tocable). Sin encabezado, quien
    // navega por secciones no tiene forma de saltar hasta acá.
    //
    // ⚠️ Ojo con el montaje, y esto también se midió: recién montado, este componente pinta SÓLO el
    // botón que abre el bloque. El primer intento de este test buscaba el encabezado sin tocar nada
    // y falló listando un único rol disponible, `button`. El título vive en el bloque que ese botón
    // despliega, así que hay que abrirlo primero.
    //
    // Y la consulta pide explícitamente el ROL: el botón y el título comparten texto, así que un
    // `getByText` traería los dos y no distinguiría un `<p>` de un `<h2>`, que es exactamente lo que
    // hay que distinguir acá.
    render(
      <LostEscrowRecovery
        refund={new FakeSolanaEscrowRefundGateway()}
        resolveSender={async () => FAKE_SOLANA_BENEFICIARY}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Recuperar un envío perdido/ }));
    expect(screen.getByRole("heading", { name: "Recuperar un envío perdido" })).toBeInTheDocument();
  });
});
