"use client";
import { ArrowLeft, LifeBuoy, List, Send } from "lucide-react";
import { cn } from "./cn";

/**
 * WKH-063 · LA BARRA DE DESTINOS, y antes que el componente, LA REGLA QUE PARTE LA MÁQUINA EN DOS.
 *
 * La app tenía una sola clase de pantalla: pasos de un envío. Todo lo que no era un paso —el
 * historial— entraba igual a la misma unión de `Step` con un comentario explicando que no lo era. Esta
 * HU hace explícita la distinción, porque de ella depende un invariante que se puede testear:
 *
 *   · DESTINO      → un lugar donde la persona está, sin nada en curso. La barra se ve.
 *   · PASO DEL FLUJO → un tramo de un envío que empezó y todavía no terminó. La barra NO se ve.
 *
 * 🔴 `done` ES UN PASO Y NO UN DESTINO, y es la decisión que más se discutió. El recibo se lee como
 * "ya terminó, devolveme la navegación", y es tentador devolverle la barra ahí. No se hace, y el
 * motivo es que la regla de arriba tiene que ser decidible sin mirar cada pantalla: `done` es el
 * último tramo de la línea `send → … → done`, y el recibo ya tiene su propia acción resolutiva
 * ("Enviar otra"). Una excepción en `done` convertiría el invariante en una lista de casos.
 *
 * ⛔ LA UNIÓN VIVE ACÁ Y NO EN `flow.tsx`, a propósito: `type Step` se DERIVA de `Destino`
 * (`flow.tsx`), así que un destino nuevo entra en un solo lugar y `esDestino` lo reconoce solo. Al
 * revés —la lista escrita dos veces— es como se agrega un destino que la barra no sabe pintar.
 */
export type Destino = "bienvenida" | "history" | "recuperar";

/** El ORDEN es el que se ve en pantalla, y es parte del contrato (AC-4). */
export const DESTINOS = ["bienvenida", "history", "recuperar"] as const;

/**
 * ⚠️ RECIBE UN `string` Y NO UN `Step`, para que sirva de guard de verdad. Con la firma estrecha,
 * TypeScript ya sabría la respuesta en cada sitio de llamada y el test no podría preguntarle por un
 * paso cualquiera de la unión: el candado de AC-3/AC-4 recorre `STEP_INDEX` entero, incluidos los
 * pasos del flujo, y necesita poder pasarle cada clave.
 */
export function esDestino(paso: string): paso is Destino {
  return (DESTINOS as readonly string[]).includes(paso);
}

/**
 * Las etiquetas, en el vocabulario de la persona y no en el del código: `bienvenida` es "Enviar"
 * porque desde ahí se empieza un envío, y `history` es "Mis envíos" porque es lo que lista.
 *
 * ⛔ NINGUNA PESTAÑA REPRESENTA UNA ACCIÓN (AC-4). Es la mitad que se rompe sola: una barra con un
 * "Enviar ahora" o un "Recuperar mis fondos" mezcla navegar con hacer, y entonces tocar una pestaña
 * puede mover plata. Las tres dicen DÓNDE se va, y lo que se hace lo decide la pantalla de destino.
 */
const ETIQUETAS: Record<Destino, string> = {
  bienvenida: "Enviar",
  history: "Mis envíos",
  recuperar: "Recuperar",
};

const ICONOS: Record<Destino, typeof Send> = {
  bienvenida: Send,
  history: List,
  recuperar: LifeBuoy,
};

export function BarraDestinos({
  activo,
  onIr,
  disabled,
}: {
  activo: Destino;
  onIr: (destino: Destino) => void;
  disabled?: boolean;
}) {
  return (
    // `mt-auto` y NO `fixed`/`sticky`, y es una decisión medida contra el área segura: el `<main>` de
    // `flow.tsx` es un `flex min-h-dvh flex-col` con `pb-segura-b`, así que una barra al final de esa
    // columna aterriza sola en el borde inferior de la pantalla Y por encima del inset del gesto,
    // sin sumar ningún padding nuevo. Una barra `fixed` obligaría a repetir el inset acá y a
    // compensar la altura en el contenedor, que es el par de números que se desincroniza.
    <nav aria-label="Destinos" className="mt-auto flex gap-ajustado border-t border-line pt-ajustado">
      {DESTINOS.map((destino) => {
        const Icono = ICONOS[destino];
        const esElActivo = destino === activo;
        return (
          <button
            key={destino}
            type="button"
            onClick={() => onIr(destino)}
            disabled={disabled}
            aria-current={esElActivo ? "page" : undefined}
            className={cn(
              // ⛔ `min-h-[52px]` SE ESCRIBE ASÍ Y NO CON UN TOKEN, por el mismo motivo que el
              // `h-[52px]` del `<Button>` (ver su comentario en `ui.tsx`): `touch-targets.test.tsx`
              // lee el número del `className` RENDERIZADO. Y acá no es ceremonia: la pestaña "Mis
              // envíos" ES una de las tres puertas de recuperar plata (desde el historial se llega a
              // "Recuperar fondos"), así que este número está bajo AC-5.
              // `text-label font-medium` y no el peso del CTA: la barra navega, no resuelve.
              // `gap-1` (4px) queda fuera de la escala de S-4 (8/12/16/24) y se escribe igual, con el
              // mismo criterio y el mismo precedente que la fila del header de `flow.tsx`: 8px entre
              // un ícono y su etiqueta dentro de un control de 52px los separa en dos cosas.
              "inline-flex min-h-[52px] flex-1 flex-col items-center justify-center gap-1 rounded-control text-label font-medium transition-colors disabled:opacity-50",
              esElActivo ? "bg-sand text-cochineal-ink" : "text-stone hover:bg-sand/60",
            )}
          >
            <Icono className="size-icono-sm" />
            {ETIQUETAS[destino]}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * LA OTRA MITAD DE LA REGLA, y sin ella la barra es una trampa.
 *
 * Si los pasos del flujo no pintan la barra (AC-3), quien entra al formulario se queda sin ninguna
 * forma de volver a los destinos: los tres enlaces del pie de `send` se fueron con esta HU, así que la
 * única salida era recargar la página. Esto es esa salida.
 *
 * ⚠️ NO ES UNA PESTAÑA Y NO SE VE COMO UNA. Es un solo destino (el de entrada) y llega desde adentro
 * del flujo, así que se pinta como lo que es: un "atrás". `min-h-[44px]` y no 52, el mínimo de WCAG
 * 2.5.5, que es el mismo criterio con el que los tres controles del bloque de reset comparten fila en
 * el header: no devuelve fondos ni destruye nada, mueve `step` y nada más.
 */
export function VolverAlInicio({
  onVolver,
  disabled,
}: {
  onVolver: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onVolver}
      disabled={disabled}
      className="inline-flex min-h-[44px] items-center gap-1 text-label font-medium text-stone underline underline-offset-2 disabled:opacity-50"
    >
      <ArrowLeft className="size-icono-sm" /> Volver al inicio
    </button>
  );
}
