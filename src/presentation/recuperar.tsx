"use client";
import type { ReactNode } from "react";
import { Card, Muted } from "./ui";

/**
 * WKH-063 · EL DESTINO "RECUPERAR": la carcasa de las dos puertas que preguntan a la cadena.
 *
 * 🔴 POR QUÉ ES UNA CARCASA Y NO UN COMPONENTE QUE LAS MONTA. `LostEscrowRecovery` y
 * `EscrowRentRecovery` viven en `flow.tsx`; importarlas desde acá crearía un ciclo con el import que
 * `flow.tsx` hace de este archivo. Reciben su cableado (gateways, `resolveSender`) del mismo lugar de
 * siempre y entran por `children`: lo que esta HU cambia es DESDE DÓNDE se montan, nunca su lógica.
 *
 * DE DÓNDE VIENEN. Estaban al pie del formulario de envío, en un grupo titulado "¿Ya enviaste
 * antes?", donde salían con la misma métrica que el CTA del camino feliz. Un formulario con un botón
 * y tres puertas de rescate abajo se lee como una lista de opciones equivalentes. Acá las dos tienen
 * su propia pantalla, y el pie del formulario quedó con una sola cosa que hacer.
 *
 * ⛔ AC-8 · ESTA PANTALLA NO TIENE `primary`, y es un veredicto escrito, no un olvido: las dos puertas
 * ABREN UNA BÚSQUEDA en la cadena, no sacan a la persona de acá. Lo que resuelve —el refund, el
 * cierre de cuentas— aparece DESPUÉS de que la cadena contestó, adentro de cada componente, y ahí sí
 * cada uno decide su propia jerarquía. Si alguien decide que abrir la búsqueda ya es resolver, tiene
 * que venir a cambiar la fila de `jerarquia-relativa.test.tsx` y decir por qué.
 *
 * ⛔ Y NO SE REPITE LO QUE CADA PUERTA YA EXPLICA (el plazo de la ventana de custodia, las firmas que
 * pide la billetera, el tope de la ventana de búsqueda). Cada una de esas frases pasó su propio
 * barrido de honestidad en su propio sitio; una segunda versión acá arriba es la forma en que una de
 * las dos queda vieja.
 */
export function DestinoRecuperar({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-holgado">
      <div>
        <h2 className="text-title font-bold">Recuperar fondos de un envío anterior</h2>
        <Muted className="mt-ajustado">
          Si un envío no llegó a completarse, tus USDC pueden seguir en el contrato. Desde acá se lo
          preguntamos a Solana con tu billetera.
        </Muted>
      </div>
      {/* Las dos puertas separadas por una línea y no por aire: son dos preguntas distintas a la
          misma cadena (una busca escrows ABIERTOS, la otra cuentas de envíos ya TERMINADOS), y la
          línea dice que no son dos pasos de lo mismo. */}
      <Card className="divide-y divide-line">{children}</Card>
    </div>
  );
}
