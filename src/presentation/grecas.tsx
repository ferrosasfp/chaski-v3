// Presentation — el motivo del Qhapaq Ñan, en UN solo lugar y con su `id` a la vista.
//
// 🔴 POR QUÉ EXISTE ESTE ARCHIVO (HU-068). El camino escalonado estaba escrito adentro de `splash.tsx`
// como una función privada, y la pantalla de entrada lo necesita también. Copiarlo era la salida
// tentadora y es exactamente la que `marca.ts:6-7` ya prohibió con su motivo escrito: "dos literales
// idénticos sin nada que los ate es exactamente cómo uno se corrige y el otro no". Acá la geometría
// —el `path`, el paso de 28px, el `strokeWidth`— está escrita UNA vez y los dos sitios la leen.
//
// 🔴 Y EL `id` ES UN PROP REQUERIDO, SIN DEFAULT, POR UN BUG MEDIDO Y NO POR GUSTO. `app/page.tsx:21-22`
// monta `<Splash />` y `<RemittanceFlow />` como HERMANOS, así que los dos subárboles conviven en UN
// solo documento durante los ~1200 ms que el splash se queda (`MS_EN_PANTALLA`, `splash.tsx:60`). Un
// `id` de SVG no pertenece al componente: pertenece al documento, y `fill="url(#…)"` resuelve al PRIMERO
// en orden de documento. Con el `id` repetido, la banda de la entrada pintaría con el `<pattern>` del
// splash —cuyo `stroke` es `#FBFAF7`, el tono para fondo OSCURO, casi el color de `paper`— y se vería
// VACÍA hasta que el splash se desmonte. Es una falla intermitente y atada al reloj, o sea la clase que
// una suite verde no caza sola. Candado: el `it` que monta los dos juntos y prohíbe `id` repetidos, en
// `bienvenida-composicion.test.tsx`.
//
// ⛔ DESCARTADO `useId()` de React 19 (está disponible: `package.json` declara react 19.0.0). Genera
// ids con dos puntos (`:r0:`), válidos como atributo y rotos para cualquier `querySelector('#…')`
// posterior — incluido el de un test. Un prop explícito se lee, se testea y se cita.
//
// ⛔ SIN ANIMACIÓN, NUNCA, con o sin `prefers-reduced-motion`: un fondo que se mueve detrás de una
// marca es justo el movimiento que la preferencia existe para apagar, y acá no aporta nada.
//
// ⚠️ LO QUE ESTE MÓDULO **NO** GARANTIZA: que el motivo se VEA. La opacidad es una clase de Tailwind, y
// Tailwind sólo emite reglas para los archivos de su `content` (`tailwind.config.ts:5`:
// `./app/**` y `./src/presentation/**`). Por eso este archivo vive en `src/presentation/` y no en un
// `src/ui/` más prolijo: afuera de esos dos globs `opacity-[0.10]` no emitiría NINGUNA regla, el motivo
// saldría a opacidad 1 y el defecto se vería, compilaría y estaría mal — el mismo modo de falla que
// `tailwind.config.ts:160-163` documenta para `h-icono-lg`.
import { cn } from "./cn";

/**
 * Los dos tonos, y cada uno con el fondo REAL contra el que se midió al lado del número. No hacerlo ya
 * le costó a este repo una cifra contra el fondo equivocado: la corrección, en (`Card`, `./bienvenida.tsx:295`).
 *
 * `sobre-oscuro` — `#FBFAF7` (`paper`) al 5%. Es EXACTAMENTE lo que el splash pinta hoy sobre `bg-ink`,
 * copiado sin cambiarle un dígito para que el render del splash quede idéntico.
 *
 * `sobre-claro` — `#17130F` (`ink`) al 10%, sobre `paper` (#FBFAF7), que es el fondo de la app y el que
 * la banda de la entrada tiene debajo. Contraste del color compuesto (0,10·ink + 0,90·paper = #E4E3E0)
 * contra `paper`: **1,230:1**, con la fórmula de luminancia relativa de WCAG 2.x sobre los hex del tema.
 *
 * ⚠️ EL PISO Y EL TECHO SON UN CRITERIO CONVERTIDO EN NÚMERO, NO UNA MEDICIÓN DE LA NATURALEZA, y así
 * hay que leerlos: piso **1,15:1** (por debajo el motivo no se distingue del papel y la banda es una
 * promesa vacía; al 5% da 1,109 y quedaría abajo) y techo **1,60:1**. Lo que SÍ es medición es el techo:
 * el texto más tenue de la pantalla es `text-stone` (#8A8178) sobre `paper` y da **3,663:1** (escrito
 * también en `ui.tsx:64`), así que una textura de fondo que se le acerque compite con él; 1,230 le deja
 * un margen de casi 3×.
 *
 * ⛔ Y NO SE USA `cochineal-claro` (#E08AA0) para esto: sobre blanco da **2,53:1**. Es un tono de
 * superficie oscura (`tailwind.config.ts:14-21`) y al 12% teñiría de rosa media pantalla.
 */
const TONOS = {
  "sobre-oscuro": { stroke: "#FBFAF7", opacidad: "opacity-[0.05]" },
  "sobre-claro": { stroke: "#17130F", opacidad: "opacity-[0.10]" },
} as const;

export type TonoDeGrecas = keyof typeof TONOS;

export function Grecas({ id, tono }: { id: string; tono: TonoDeGrecas }) {
  const { stroke, opacidad } = TONOS[tono];
  return (
    // ⛔ `aria-hidden="true"` ESCRITO CON EL STRING Y NO COMO ATAJO BOOLEANO. El atajo `aria-hidden`
    // renderiza lo mismo, y el linter (`a11y/noSvgWithoutTitle`) NO lo reconoce: exige un `<title>`,
    // que acá sería la respuesta equivocada —esto no es una imagen con contenido, es tinta de fondo, y
    // un `<title>` la metería en el árbol accesible para después esconderla—.
    <svg
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 size-full", opacidad)}
    >
      <defs>
        <pattern id={id} width="28" height="28" patternUnits="userSpaceOnUse">
          <path
            d="M0 28 L0 21 L7 21 L7 14 L14 14 L14 7 L21 7 L21 0"
            stroke={stroke}
            strokeWidth="1.5"
            fill="none"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
