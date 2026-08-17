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

/**
 * ⚠️ `disabled` APAGA LAS TRES PESTAÑAS A LA VEZ, Y ESO ES UN DEFECTO DECLARADO, NO UN DISEÑO
 * (AR/MNR-3). Queda escrito acá, en el sitio del prop, porque el encabezado de
 * `barra-destinos.test.tsx` declara otros límites y no éste.
 *
 * QUÉ PASA, MEDIDO (T-063-22, segundo `it`): el único sitio de llamada le pasa `busy`, y `busy` lo pone
 * `guard` (`flow.tsx:300-314`), que NO tiene timeout. Con una billetera que nunca contesta —tocar "Mis
 * envíos" entra por `openHistory` → `resolveSender` → `connectWallet.execute()`— las tres pestañas y el
 * CTA de la bienvenida quedan `disabled` para siempre y la única salida es RECARGAR la página.
 *
 * ⛔ POR QUÉ EXISTÍA ANTES Y AHORA MOLESTA MÁS: el congelamiento por `busy` es pre-WKH-063. Lo que
 * cambió es que ahora se lleva puesta la ÚNICA navegación de la app, porque esta HU borró los tres
 * enlaces del pie de `send`. Y el repo ya trata esta clase como defecto: el overlay `resuming` tiene
 * escape manual a los 5 s (WKH-188, `flow.tsx:288-298`); esto no tiene ninguno.
 *
 * 🔴 POR QUÉ EL FIX-PACK NO LO ARREGLÓ, y la alternativa se evaluó en serio. Lo obvio es que sólo la
 * pestaña que necesita la billetera honre `disabled` (`history`; las otras dos son estado local). Eso
 * cambia el congelamiento por una CARRERA: la persona se va a `recuperar`, la billetera contesta tarde y
 * `openHistory` hace `setStep("history")` encima, o sea el MISMO defecto que AR/BLQ-MED-1 con otro
 * disparador (ver `T-063-21`, que lo mide para el resume). Las dos instancias piden el mismo mecanismo
 * —cancelar o versionar la navegación en vuelo— y elegirlo bien es diseño de una HU, no de un fix-pack.
 *
 * ⚠️ LA MITIGACIÓN QUE SÍ HAY **Y SU PRECONDICIÓN**, que el fix-pack anterior no escribió y por eso decía "mitigado en un camino de tres" a secas (fix-pack 2 · AR-it2/MNR-3). Desde `history` el botón «Volver» de `HistoryView` NO honra `disabled`, así que sobrevive al congelamiento — 🔴 PERO ESE BOTÓN SÓLO EXISTE SI LA LISTA YA ESTÁ PINTADA (`history`, `flow.tsx:1185`: el sitio de render exige `history` no nula), o sea SÓLO en un SEGUNDO toque, con la billetera ya colgada de antes. Y el disparador natural es el PRIMER toque de "Mis envíos": ahí `history` sigue en `null`, no se pinta ningún «Volver», y la pantalla queda con CERO controles vivos. Medido en jsdom, censo de botones NO deshabilitados: `bienvenida` con la billetera colgada desde el arranque ⇒ `[]` · `bienvenida` tras el primer toque de "Mis envíos" que se cuelga ⇒ `[]` · `recuperar` colgado ⇒ dos vivos ("Recuperar un envío perdido" y "Recuperar el depósito de red de envíos anteriores"), pero NINGUNO de los dos navega: son las dos puertas de la cadena.
 * Es la razón medida por la que ese botón no se borró pese a ser navegación duplicada dentro de un
 * destino. Desde `bienvenida` y `recuperar` no hay ninguna salida hacia otra pantalla: eso queda ABIERTO
 * y sin candado, y la frase "mitigado" vale sólo con la precondición de arriba.
 */
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
