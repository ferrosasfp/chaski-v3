import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// 🔴 POR QUÉ ESTE ARCHIVO DEJÓ DE SER UNA LÍNEA, y no es prolijidad: sin esto, los tokens propios
// del tema se PIERDEN en silencio al pasar por `cn`.
//
// LO QUE SE MIDIÓ (ola 1 de rediseño, base 40f0b68), con el `twMerge` sin configurar:
//
//     cn("text-support", "text-stone")   ⇒  "text-stone"          ← el TAMAÑO desapareció
//     cn("text-money",   "text-verde")   ⇒  "text-verde"          ← ídem
//     cn("text-stone",   "text-support") ⇒  "text-support"        ← y al revés desaparece el color
//
// La causa: `tailwind-merge` no lee `tailwind.config.ts`. Trae su propia tabla, y ahí una palabra
// suelta detrás de `text-` es un COLOR. Así que `text-support` y `text-stone` le parecen dos colores
// en conflicto y se queda con uno. Es la peor forma posible del error: no rompe el build, no rompe
// el tipo, no rompe ningún test que no mire el `className`, y el resultado depende del ORDEN en que
// se pasaron los argumentos. Lo destapó `sistema-de-diseno.test.tsx` con un
// «expected 'text-stone' to contain 'text-support'».
//
// Y NO ES SÓLO EL TAMAÑO. Con la tabla de fábrica, `cn("p-holgado", "p-4")` devuelve LAS DOS y el
// ganador lo decide el orden en que Tailwind emitió las reglas, que no lo eligió nadie. Lo mismo con
// `rounded-*`, `gap-*` y `space-y-*`. Por eso se declaran todas las escalas propias y no sólo la que
// dio el síntoma.
//
// ⚠️ UN CASO QUE SE MIDIÓ Y RESULTÓ ESTAR BIEN, para no arreglar lo que no está roto: los valores
// arbitrarios YA funcionaban. `cn("text-[15px] font-semibold", "bg-cochineal text-white")` conserva
// los dos, porque `tailwind-merge` sabe leer un `[15px]` como longitud. O sea que el `<Button>` de
// este repo nunca tuvo este bug; lo trae el vocabulario nuevo, que usa palabras en vez de medidas.
//
// ⚠️ ESTA TABLA ES UNA SEGUNDA COPIA DEL TEMA, y hay que decirlo: los nombres de acá tienen que
// coincidir a mano con los de `tailwind.config.ts`. Agregar un rol tipográfico allá y no acá lo deja
// expuesto al mismo borrado silencioso. El candado que lo cierra vive en
// `sistema-de-diseno.test.tsx`: deriva los nombres del tema y comprueba que `cn` los conserve, así
// que la copia que se desactualiza se pone roja en vez de perder clases sin avisar.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      // Alimentan `p-`, `m-`, `gap-` y `space-*` de una sola vez (S-4).
      spacing: ["ajustado", "normal", "holgado", "aire"],
      // `xl2` estuvo acá mientras existió (tampoco lo conocía `tailwind-merge`, así que
      // `cn("rounded-xl2", "rounded-full")` devolvía los dos: el mismo defecto, más viejo). La ola 2
      // migró sus sitios a `caja` y borró el token del tema, así que se va de acá con él.
      borderRadius: ["caja", "control"],
      // Los cuatro del área segura (D-1), que sólo se usan como padding.
      padding: ["segura-t", "segura-b", "segura-l", "segura-r"],
    },
    classGroups: {
      // `font-size` no sale de la clave `theme` de tailwind-merge (no tiene una), así que va como
      // grupo explícito. Es exactamente el grupo que hacía falta separar de `text-color`.
      "font-size": [{ text: ["money", "title", "body", "support", "label", "mono"] }],
      size: [{ size: ["icono-sm", "icono-md", "icono-lg"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
