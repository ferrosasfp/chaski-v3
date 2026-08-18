"use client";
import { useEffect, useState } from "react";
import { cn } from "./cn";
import { LEMA, LOGO_SRC, NOMBRE, pildoraDeRed } from "./marca";
import { motivoParaNoMostrar, type MotivoParaNoMostrar } from "./splash-puerta";

/**
 * HU-066 · La pantalla de bienvenida de marca (splash), que es lo PRIMERO que se ve.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * LAS CUATRO DECISIONES, CON SU MOTIVO. Ninguna es de estilo.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * 1. 🔴 SE MONTA DESDE `app/page.tsx`, AL LADO DE `RemittanceFlow` Y NO ADENTRO. Un `step` nuevo
 *    delante de `bienvenida` habría sido lo "natural" y es la peor de las opciones: `pasoInicial`
 *    tiene default `"bienvenida"` y ese default es lo que corre en producción, así que mover el
 *    default habría cambiado la pantalla de entrada de ~150 tests que montan `RemittanceFlow` sin
 *    pasar el prop, y —peor— habría metido el splash ADENTRO del componente que atiende el resume del
 *    KYC y la vuelta por enlace. Afuera, el flujo queda byte-idéntico: los tests que renderizan
 *    `RemittanceFlow` no ven el splash porque no existe para ellos.
 *
 * 2. ⛔ NO SE RENDERIZA EN EL SERVIDOR, Y ES LO QUE CIERRA EL REQUISITO DE "SIN JS NO PUEDE TAPAR LA
 *    APP". El estado arranca en `"decidiendo"`, que no pinta nada, y sólo un efecto —que por
 *    definición no corre en el servidor ni sin JS— puede pasarlo a `"visible"`. O sea que el HTML que
 *    sale del servidor NO CONTIENE el splash: con JavaScript deshabilitado la app se ve entera y no
 *    hay ningún `<noscript>` que mantener sincronizado.
 *    ⚠️ EL COSTO, DICHO Y MEDIDO, no escondido: entre que el navegador pinta el HTML del servidor y
 *    que React hidrata hay una ventana en la que se ve la pantalla de bienvenida ANTES del splash. El
 *    número está en el reporte de la HU. Las dos alternativas que lo evitan son peores: pintar el
 *    splash en el HTML del servidor lo pondría encima del aterrizaje de un KYC durante esa misma
 *    ventana (que es justo lo que el punto 3 existe para impedir), y un `<script>` inline que decida
 *    antes del pintado es código que corre fuera de React sobre una app con CSP.
 *
 * 3. 🔴 SI HAY ALGO QUE ATENDER, NO SE MUESTRA. No "se cierra rápido": no se muestra. Quién decide es
 *    (`motivoParaNoMostrar`, `./splash-puerta.ts:84`), que es puro y tiene su propia suite. Los dos
 *    recorridos que vuelven a la app con una recarga completa —el KYC de Didit y el salto a la
 *    billetera por enlace— aterrizan en una pantalla concreta durante el montaje, y taparla es lo peor
 *    que esta HU puede hacerle a alguien que ya puso plata. La puerta mira las DOS claves de disco que
 *    son la condición real, no sólo la URL, y falla CERRADO.
 *
 * 4. UNA VEZ POR SESIÓN, y no siempre ni una vez para siempre. El uso lo decide: a Chaski se vuelve a
 *    mirar cómo va un envío, así que un splash en cada montaje sería un peaje sobre el gesto más
 *    frecuente de la app. Pero `sessionStorage` y no `localStorage`: "para siempre" convierte la
 *    primera pantalla de la marca en algo que la mayoría no ve nunca, y además deja un rastro
 *    permanente en el disco de alguien por una decoración.
 *    🔑 Y HAY UNA SEGUNDA RAZÓN, QUE ES DE SEGURIDAD DE LA UX Y VALE MÁS QUE LA PRIMERA: las dos
 *    vueltas del punto 3 son RECARGAS DE LA MISMA SESIÓN. O sea que la marca de sesión es un segundo
 *    candado sobre el mismo agujero: aunque la puerta fallara en reconocer una vuelta, esa vuelta pasa
 *    por un montaje donde el splash YA SE VIO, y no se vuelve a pintar. Los dos mecanismos son
 *    independientes y tapan el mismo hueco desde lados distintos.
 *
 * ⛔ Y NUNCA DEJA A NADIE ENCERRADO: sale solo por tiempo, y además con cualquier toque o cualquier
 * tecla. Si el temporizador no corriera —una pestaña en segundo plano estrangula los `setTimeout`— el
 * toque sigue estando; si la persona no toca, corre el tiempo. Hacen falta las dos fallas a la vez
 * para que el splash se quede, y aun así no bloquea el resume: `RemittanceFlow` está montado DEBAJO y
 * su efecto de montaje ya corrió.
 */

/** Cuánto se queda si nadie lo toca. Corto a propósito: es una marca, no una pantalla de carga. */
export const MS_EN_PANTALLA = 1200;

/** Cuánto dura el desvanecido. Sólo se usa cuando el movimiento NO está reducido. */
export const MS_DE_SALIDA = 260;

/**
 * La marca de "ya se vio en esta sesión". `sessionStorage`, no `localStorage` (ver decisión 4).
 * Versionada como todas las claves de este repo, por el mismo motivo: cambiar el significado del
 * contenido sin cambiar la clave deja lecturas viejas entrando como nuevas.
 */
export const CLAVE_YA_SE_VIO = "chaski.splash.visto.v1";

/** El motivo de sesión no vive en la puerta pura porque no depende del href ni del disco duro del
 *  recorrido: depende de si ESTA pestaña ya lo mostró. */
export type MotivoDelSplash = MotivoParaNoMostrar | "ya-se-vio-en-esta-sesion";

/**
 * La decisión, publicada en `<html data-splash="…">` una sola vez y para siempre.
 *
 * 🔴 POR QUÉ UN ATRIBUTO Y NO UN `console.log` NI NADA: es la ÚNICA forma de que "el splash no se
 * interpuso en la vuelta del KYC" sea una medición y no una declaración. Desde un navegador se lee
 * `document.documentElement.dataset.splash` y contesta cuál de los seis caminos se tomó. Un splash que
 * no se muestra es indistinguible de un splash que nunca se montó, y sin esto la evidencia de la HU
 * sería "no lo vi", que no es evidencia.
 *
 * ⚠️ NO CAMBIA cuando el splash se cierra: describe la DECISIÓN DEL MONTAJE, no el estado actual. Un
 * atributo que cambiara con el tiempo obligaría a la medición a ganarle una carrera.
 */
const ATRIBUTO = "splash";

function marcarLaDecision(valor: MotivoDelSplash | "mostrado"): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset[ATRIBUTO] = valor;
}

/** `sessionStorage` a través de un try/catch: en modo privado de algunos navegadores el acceso TIRA.
 *  Igual que la puerta, se falla cerrado — si no se puede preguntar, no se muestra. */
function sesion(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

type Estado = "decidiendo" | "visible" | "saliendo" | "fuera";

export function Splash({ msEnPantalla = MS_EN_PANTALLA }: { msEnPantalla?: number } = {}) {
  const [estado, setEstado] = useState<Estado>("decidiendo");
  // ⛔ NO es un `useRef`: la clase del desvanecido depende de esto, así que se PINTA. Arranca en
  // `false` para que el primer render (el del servidor, que no pinta nada igual) no prometa movimiento.
  const [conMovimiento, setConMovimiento] = useState(false);

  // ⛔ DEPS VACÍAS Y ES CORRECTO, no una supresión: este efecto no lee ninguna variable reactiva. La
  // decisión es del MONTAJE (ver el docblock de `ATRIBUTO`); re-evaluarla al cambiar la URL volvería a
  // pintar el splash encima de una app en uso, que es lo contrario de lo que la HU pide.
  useEffect(() => {
    const s = sesion();
    if (s === null) {
      marcarLaDecision("disco-ilegible");
      setEstado("fuera");
      return;
    }
    const motivo = motivoParaNoMostrar({
      href: window.location.href,
      // El lector se le pasa: la puerta es pura y no sabe que existe `localStorage`. Si el getter
      // tira, la excepción sube y la puerta la traduce a `"disco-ilegible"`, que es su caso cerrado.
      leer: (k) => localStorage.getItem(k),
    });
    if (motivo !== null) {
      marcarLaDecision(motivo);
      setEstado("fuera");
      return;
    }
    let yaSeVio: string | null;
    try {
      yaSeVio = s.getItem(CLAVE_YA_SE_VIO);
    } catch {
      marcarLaDecision("disco-ilegible");
      setEstado("fuera");
      return;
    }
    if (yaSeVio !== null) {
      marcarLaDecision("ya-se-vio-en-esta-sesion");
      setEstado("fuera");
      return;
    }
    try {
      s.setItem(CLAVE_YA_SE_VIO, "1");
    } catch {
      // Que no se pueda escribir la marca no es motivo para no mostrarlo: el peor caso es que se
      // vuelva a ver en el próximo montaje de esta sesión, y eso no tapa nada que importe.
    }
    // ⛔ `matchMedia` PUEDE NO EXISTIR, y no es defensivo porque sí: en el jsdom de esta suite
    // `typeof window.matchMedia` es `"undefined"` (está medido en `movimiento-reducido.test.tsx`).
    // Sin este `typeof`, el splash tiraría en cada test que montara la página.
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setConMovimiento(!reduce);
    marcarLaDecision("mostrado");
    setEstado("visible");
  }, []);

  useEffect(() => {
    if (estado !== "visible") return;
    // La salida, una sola función para los tres disparadores (tiempo, toque, tecla). Con el
    // movimiento reducido NO hay desvanecido: se va en el mismo tick, sin ninguna clase de transición.
    const salir = () => setEstado(conMovimiento ? "saliendo" : "fuera");
    const t = setTimeout(salir, msEnPantalla);
    // ⛔ `click` Y NO `pointerdown`: con `pointerdown` el splash se desmonta ENTRE el apretar y el
    // soltar, así que el `click` que sigue aterriza en lo que haya quedado debajo del dedo — que en la
    // bienvenida es «Empezar un envío». Escuchando `click`, el evento ya se consumió acá arriba.
    window.addEventListener("click", salir);
    window.addEventListener("keydown", salir);
    return () => {
      clearTimeout(t);
      window.removeEventListener("click", salir);
      window.removeEventListener("keydown", salir);
    };
  }, [estado, conMovimiento, msEnPantalla]);

  useEffect(() => {
    if (estado !== "saliendo") return;
    const t = setTimeout(() => setEstado("fuera"), MS_DE_SALIDA);
    return () => clearTimeout(t);
  }, [estado]);

  if (estado === "decidiendo" || estado === "fuera") return null;

  return (
    <div
      // `aria-hidden` + `pointer-events-none` durante la salida: mientras se desvanece ya no es
      // contenido ni obstáculo, y un toque en ese tramo tiene que llegar a la app de abajo.
      data-splash-overlay
      className={cn(
        "fixed inset-0 z-50 flex flex-col overflow-hidden bg-ink pb-segura-b pl-segura-l pr-segura-r pt-segura-t",
        conMovimiento && "transition-opacity ease-out",
        estado === "saliendo" && "pointer-events-none opacity-0",
      )}
      style={conMovimiento ? { transitionDuration: `${MS_DE_SALIDA}ms` } : undefined}
    >
      <Grecas />
      {/* ⛔ `w-full` NO ES REDUNDANTE Y ESTÁ MEDIDO. El overlay tenía `items-center` y con eso este
          bloque se encogía a su contenido (176px de 350 disponibles), así que el `w-[58%]` del logo
          resolvía contra 176 y el logo salía a **102px** en vez de 203: la mitad. Peor todavía, el
          ancho dependía de cuánto había cargado la imagen, así que la MISMA sonda daba 158px y 102px
          en dos corridas. El `items-center` bajó de acá a cada bloque y la columna estira.
          ⛔ Y EL AIRE VERTICAL VA EN `dvh` Y NO EN `%`, que fue el segundo error medido: un `pb-[16%]`
          se lee como "16% del alto" y NO LO ES —un porcentaje de `padding`/`margin` resuelve contra el
          ANCHO del contenedor, siempre, incluso en el eje vertical—. Medido: `mb-[15%]` en un viewport
          de 390x844 corría la píldora 52px (15% de los 350 de ancho útil) donde yo esperaba 127, y la
          composición quedaba 5 puntos más abajo que la referencia sin que nada se viera "roto". */}
      <div className="relative flex w-full flex-1 flex-col items-center justify-center pb-[9dvh]">
        {/* El resplandor granate de atrás. Es un círculo de la marca desenfocado y NO un degradado
            escrito a mano: así el color sale del tema (`cochineal`) en vez de ser un hex nuevo suelto
            adentro de un `bg-[radial-gradient(...)]`, que es donde los colores se escapan del sistema. */}
        <div aria-hidden className="absolute size-64 rounded-full bg-cochineal opacity-20 blur-3xl" />
        {/* biome-ignore lint/performance/noImgElement: mismo motivo que en `ChaskiMark` (ver su nota de payload). */}
        <img src={LOGO_SRC} alt={NOMBRE} className="relative w-[58%] max-w-[17rem]" />
        {/* ⛔ NO es un `<h1>` ni un `<h2>`: `titulos.test.tsx` exige que el `<h1>` de la app sea UNO
            solo y sea el nombre en el header, y este splash convive en el mismo documento con él. El
            nombre acá lo dice el logo (su `alt`), que es lo que un lector de pantalla anuncia. */}
        <p className="relative mt-aire text-body text-paper/80">{LEMA}</p>
      </div>
      <p className="relative mb-[12dvh] self-center inline-flex items-center gap-ajustado rounded-full border border-cochineal/40 px-holgado py-ajustado font-mono text-label tracking-[0.2em] text-cochineal-claro">
        <span aria-hidden className="size-1.5 rounded-full bg-cochineal-claro" />
        {pildoraDeRed()}
      </p>
    </div>
  );
}

/**
 * El fondo: el camino escalonado del Qhapaq Ñan, repetido y casi invisible.
 *
 * 🔴 ES EL DIBUJO QUE LA MARCA DEJÓ DE SER, Y ESO ES LO LINDO DEL CAMBIO. Hasta HU-066 `ChaskiMark`
 * ERA este camino escalonado, en blanco sobre un cuadrado de tinta. La marca nueva es el mensajero, y
 * el camino que corría bajó a ser el suelo por el que corre. No es una textura decorativa elegida al
 * azar: es la misma geometría que estaba en `ui.tsx`, en mosaico.
 *
 * ⛔ SIN ANIMACIÓN, NUNCA, con o sin `prefers-reduced-motion`. Un fondo que se mueve detrás de una
 * marca es exactamente el tipo de movimiento que la preferencia existe para apagar, y acá no aporta
 * nada. `aria-hidden` porque no dice nada: es tinta.
 */
function Grecas() {
  return (
    // ⛔ `aria-hidden="true"` ESCRITO CON EL STRING Y NO COMO ATAJO BOOLEANO. El atajo `aria-hidden`
    // renderiza lo mismo, y el linter (`a11y/noSvgWithoutTitle`) NO lo reconoce: exige un `<title>`,
    // que acá sería la respuesta equivocada —esto no es una imagen con contenido, es tinta de fondo, y
    // un `<title>` la metería en el árbol accesible para después esconderla—.
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full opacity-[0.05]">
      <defs>
        <pattern id="chaski-qhapaq-nan" width="28" height="28" patternUnits="userSpaceOnUse">
          <path
            d="M0 28 L0 21 L7 21 L7 14 L14 14 L14 7 L21 7 L21 0"
            stroke="#FBFAF7"
            strokeWidth="1.5"
            fill="none"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#chaski-qhapaq-nan)" />
    </svg>
  );
}
