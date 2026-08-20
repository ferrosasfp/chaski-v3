/**
 * 🔴 EL CLICK QUE ESPERA A QUE EL BOTÓN ESTÉ HABILITADO (WKH-233 fix-pack · H-13 / re-AR it2 · BLQ-BAJO-2).
 *
 * ⚠️ VIVÍA EN `bienvenida-composicion.test.tsx` Y ESO DEJÓ EL FLAKE VIVO EN EL ARCHIVO DE AL LADO. La 1ª
 * iteración arregló el `it` que había visto fallar y no la FAMILIA: `agent-plan-card.test.tsx:119-120`
 * era literalmente el mismo par de líneas, en un archivo que el propio commit reportaba haber visto
 * fallar. Un helper privado de un archivo no se puede aplicar en otro, así que la primera parte del
 * arreglo es sacarlo de ahí.
 *
 * EL MECANISMO, leído del código de la app y no inferido del síntoma:
 *   · `flow.tsx` — `guard()` hace `setBusy(true)` → `await fn()` → `setBusy(false)` en un `finally`.
 *     El `setStep` que cambia de pantalla corre DENTRO del `await`, o sea con `busy === true`.
 *   · `flow.tsx` — la pantalla nueva renderiza `<Button disabled={busy} …>`.
 *   · `fireEvent.click` sobre un botón DESHABILITADO **no hace nada y no avisa**: el `onClick` recibe
 *     cero llamadas. Medido con una sonda de dos casos, no es una creencia sobre la librería.
 * ⇒ Entre que el paso anterior cambia de pantalla y que su `guard` libera `busy`, el botón nuevo ya
 * está en el DOM pero todavía deshabilitado. `findByRole` lo encuentra —existe—, el click se dispara,
 * se descarta en silencio, y el flujo queda parado PARA SIEMPRE. Es una CARRERA, no un timeout: por eso
 * fallaba ~2 de 4 y aislado pasaba 22/22, y por eso un techo más grande no la arregla.
 *
 * ⚠️ Se re-consulta el botón DENTRO del `waitFor` y otra vez para el click: React lo re-crea en cada
 * render, así que guardar la referencia de la primera consulta sería clickear un nodo viejo.
 *
 * ⛔ LO QUE ESTE HELPER **NO** DICE: que el flake esté muerto. Lo que está medido es el MECANISMO y que
 * este helper lo cierra en el sitio donde se usa. Repetir corridas verdes no prueba una tasa.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";

/** El mismo techo que usan las esperas de PRESENCIA: bajo carga, encontrar el nodo puede tardar. */
export const TECHO_ESPERA_CLICK = { timeout: 8_000 } as const;

/** ⚠️ El chequeo NO usa `expect(...).not.toBeDisabled()` a propósito: ese matcher lo instala
 *  `@testing-library/jest-dom/vitest`, que es un import del ARCHIVO DE TEST. Un helper compartido que
 *  dependa de que su consumidor lo haya importado falla con un `TypeError` críptico en el archivo que
 *  se olvidó, no con el mensaje de acá abajo. `waitFor` reintenta ante cualquier throw. */
export async function clickCuandoHabilite(nombre: RegExp): Promise<void> {
  await waitFor(() => {
    const b = screen.getByRole("button", { name: nombre });
    if (b.hasAttribute("disabled") || b.getAttribute("aria-disabled") === "true") {
      throw new Error(
        `el botón «${nombre}» sigue deshabilitado: el click se descartaría en silencio`,
      );
    }
  }, TECHO_ESPERA_CLICK);
  fireEvent.click(screen.getByRole("button", { name: nombre }));
}
