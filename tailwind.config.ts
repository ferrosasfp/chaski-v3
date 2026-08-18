import type { Config } from "tailwindcss";

// Identidad Chaski (reusada del demo): cochinilla + verde andino, neutros cálidos, Hanken Grotesk.
export default {
  content: ["./app/**/*.{ts,tsx}", "./src/presentation/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#FBFAF7",
        card: "#FFFFFF",
        ink: "#17130F",
        stone: "#8A8178",
        line: "#EBE7DF",
        // `claro` lo agrega HU-066 y es el ÚNICO tono pensado para fondo OSCURO: el splash es la
        // primera superficie de tinta que tiene esta app y ninguno de los dos cochinillas de arriba
        // sirve ahí. MEDIDO con la fórmula de luminancia relativa de WCAG 2.x sobre los hex del tema,
        // contra `ink` (#17130F), que es el fondo del splash: `cochineal` (#CB2A54) da **3,50:1** y NO
        // llega al 4,5:1 de AA para texto normal —y la píldora de red es texto de 12px—; `claro`
        // (#E08AA0) da **7,27:1**, o sea AAA. ⛔ NO se usa sobre `paper` ni sobre `card`: contra el
        // blanco de una tarjeta da 2,26:1 y sería ilegible. Es un color de superficie oscura y nada más.
        cochineal: { DEFAULT: "#CB2A54", ink: "#9E1C40", claro: "#E08AA0" },
        verde: { DEFAULT: "#12805C", bg: "#E7F3EE" },
        sand: "#F3EFE7",
      },
      fontFamily: {
        sans: ["var(--font-hanken)", "system-ui", "sans-serif"],
        // ⚠️ ESTA FAMILIA FALTABA, y `font-mono` se usaba igual (1 vez en 40f0b68, sobre una firma de
        // transacción). Sin declararla, Tailwind emitía su default y la firma se renderizaba con la
        // pila de fuentes que trajera el navegador: en un teléfono eso puede no ser monoespaciada,
        // y una firma base58 que no alinea es una firma que no se puede comparar de un vistazo con
        // la del explorador, que es exactamente para lo que está en pantalla.
        //
        // POR QUÉ UNA PILA DEL SISTEMA Y NO `next/font`: la CSP de esta app está EN MODO BLOQUEO y
        // su `font-src` es `'self' data:` (lo arma `buildCspPolicy` en
        // `src/infrastructure/security/csp-policy.mjs`; sin número de línea porque este archivo no
        // lo escanea el candado anti-drift y una cita anclada acá parecería verificada sin estarlo).
        // Una pila del sistema
        // no pide un solo byte a la red, así que no toca la política ni suma peso al bundle. Traer
        // otra familia por `next/font` sería legal (Next la auto-hospeda, que es por lo que Hanken
        // no viola nada) pero pagaría descarga por texto que es accesorio. Lo que NO se puede hacer
        // nunca acá es un `<link>` a un CDN de fuentes: la política lo bloquea y el candado T-CSP-11
        // lo cierra.
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      letterSpacing: { heading: "-0.03em" },

      // ── S-1 · La escala tipográfica, cerrada y nombrada por ROL ───────────────────────────────
      //
      // LO QUE HABÍA, medido en 40f0b68 sobre los `.tsx` que no son test:
      //   text-xs 67 · text-sm 57 · text-[15px] 5 · text-base 3 · text-3xl 3 · text-4xl 2 ·
      //   text-2xl 2 · text-xl 1 · text-lg 1 · text-[11px] 1
      // Diez tamaños. El 87% del uso vive en dos, y la parte alta está desparramada en cinco que
      // suman nueve usos: o sea que los tamaños grandes NO forman una escala, son cinco decisiones
      // sueltas tomadas de a una.
      //
      // 🔴 Y LO QUE MÁS PESA NO ES EL TAMAÑO, ES EL INTERLINEADO. En todo el árbol había UN solo
      // `leading-*` (`leading-none`, una vez), contra párrafos de copy de hasta 570 caracteres
      // (medido: el más largo vive en `flow-vm.ts`). Un párrafo de 570 caracteres a interlineado por
      // defecto, en un ancho de teléfono, es un bloque en el que el ojo pierde el renglón. Por eso
      // cada rol de acá abajo declara tamaño E interlineado, y no sólo tamaño.
      //
      // POR QUÉ SE NOMBRAN POR ROL Y NO POR TAMAÑO: `text-sm` no dice para qué sirve, así que la
      // pregunta "¿qué tamaño le pongo a esto?" se contesta comparando pantallas, y así es como diez
      // tamaños se vuelven diez. `text-support` sí se contesta sola, y hace visible el error: si un
      // título termina escrito con el rol de la explicación, el nombre lo delata.
      //
      // ⚠️ ESTO SÓLO AGREGA. Los `text-xs`/`text-sm`/… de Tailwind siguen existiendo, porque los 137
      // sitios de llamada se mueven en la ola 2. Mientras tanto conviven, y eso es a propósito: el
      // cambio de vocabulario y el cambio de pantallas son dos revisiones distintas.
      fontSize: {
        // La cifra. En una app de remesas la persona vino a ver ese número, así que es el único rol
        // que tiene derecho a ser grande. Interlineado casi cerrado (1.05) porque nunca envuelve, y
        // el tracking negativo de la marca, que a este tamaño es lo que evita que se vea suelto.
        money: ["2rem", { lineHeight: "1.05", letterSpacing: "-0.03em" }],
        // Títulos de pantalla y de tarjeta. Absorbe los `text-base` (16px) y los `text-sm` en negrita
        // que hacían de título: eran el mismo rol escrito de dos maneras.
        title: ["1.0625rem", { lineHeight: "1.3", letterSpacing: "-0.02em" }],
        // El texto que se lee de corrido. Absorbe `text-sm` (14px) y `text-[15px]`.
        body: ["0.9375rem", { lineHeight: "1.5" }],
        // 🔴 La explicación honesta: larga, y en este repo NO se recorta ni se resume, porque decir
        // menos sería decir de menos. Su interlineado (1.7) es el más generoso de la escala y ES la
        // razón de que `support` exista como rol separado de `body`: mismo párrafo, dos legibilidades
        // distintas. A 570 caracteres la diferencia no es de gusto.
        support: ["0.8125rem", { lineHeight: "1.7" }],
        // Etiquetas, píldoras, encabezados de fila. Texto corto que casi nunca envuelve, así que su
        // interlineado es ajustado; el tracking apenas positivo es lo que necesita todo texto chico
        // para no empastarse.
        label: ["0.75rem", { lineHeight: "1.35", letterSpacing: "0.005em" }],
        // Firmas, códigos de error, direcciones. Va un punto más chico que `body` porque una pila
        // monoespaciada se ve más grande al mismo tamaño nominal que la Hanken.
        mono: ["0.8125rem", { lineHeight: "1.5" }],
      },
      boxShadow: {
        card: "0 1px 2px rgba(23,19,15,0.04), 0 10px 30px -14px rgba(23,19,15,0.14)",
        lift: "0 2px 6px rgba(23,19,15,0.06), 0 20px 50px -20px rgba(203,42,84,0.20)",
      },
      // ── S-4 · Radios: dos, con el criterio escrito ────────────────────────────────────────────
      //
      // LO QUE HABÍA, medido en 40f0b68: `rounded-xl` 13 · `rounded-full` 11 · `rounded-xl2` 6 ·
      // `rounded-lg` 2. Cuatro valores, y el token propio del proyecto (`xl2`) era el MENOS usado de
      // los tres que son radios de verdad: o sea que la pieza que alguien definió a propósito perdió
      // contra las que vienen de fábrica.
      //
      // EL CRITERIO, que es lo único normativo de acá y por eso está escrito antes que los valores:
      //
      //     `caja`    → superficies que apoyan sobre el fondo de la pantalla (tarjetas, bloques).
      //     `control` → todo lo que va ADENTRO de una superficie (entradas, botones, avisos, filas).
      //
      // Y la regla que lo hace decidible sin mirar una maqueta: **lo anidado va siempre con menos
      // radio que lo que lo contiene.** Dos radios iguales, uno dentro del otro, dejan un hueco en la
      // esquina que se lee como un error de alineación. Con dos valores y esta regla, la pregunta
      // "¿cuál uso?" la contesta la posición del elemento, no el gusto de quien escribe.
      //
      // `rounded-full` no entra en la cuenta: no es un valor de una escala, es una forma (píldoras y
      // puntos de estado). Se queda como está.
      //
      // ✅ `xl2` YA NO ESTÁ (ola 2 · M-1). Vivía acá porque `ui.tsx` lo usaba en `Button` y en `Card`
      // y borrarlo antes de mover los sitios de llamada habría dejado esas clases sin emitir, con
      // `touch-targets.test.tsx` midiendo un botón sin estilo. Los sitios se migraron a `caja`, que
      // vale exactamente lo mismo (1.25rem), así que ningún borde cambió de forma.
      //
      // 🔴 Y OJO CON LA FORMA DE COMPROBARLO, porque acá el compilador NO ayuda: una clase de
      // Tailwind es un string dentro de un `className`, así que un `rounded-xl2` olvidado compila,
      // pasa el `tsc` y simplemente NO EMITE NINGUNA REGLA. El borde desaparece en silencio, que es
      // el peor modo de falla posible. Lo que sí lo caza es un barrido del árbol, y vive en
      // `ola-2-pantallas.test.tsx` (T-O2-1).
      borderRadius: {
        caja: "1.25rem",
        control: "0.75rem",
      },

      // ── S-4 · Íconos: tres tamaños ────────────────────────────────────────────────────────────
      //
      // LO QUE HABÍA, medido en 40f0b68: diez tamaños distintos de `h-N w-N`
      // (h-3, h-3.5, h-4, h-5, h-6, h-7, h-8, h-9, más h-1.5 y h-14). El dominante es `h-4 w-4` con
      // 16 usos y el resto son de dos o tres cada uno, que es la firma de una decisión que se toma
      // de nuevo cada vez.
      //
      // EL CRITERIO: el tamaño lo decide la RELACIÓN con el texto de al lado, no el gusto.
      //   `icono-sm` (16px) → va en la misma línea que un texto. Es el caso dominante.
      //   `icono-md` (24px) → va solo en su fila, o encabeza un bloque.
      //   `icono-lg` (32px) → estado vacío, o el único elemento de una tarjeta.
      // Cubre los diez: 3/3.5/4 caen en `sm`, 5/6/7 en `md`, 8/9 en `lg`.
      //
      // Los otros dos NO son íconos y por eso quedan afuera: `h-14 w-14` es el círculo que CONTIENE
      // un ícono, y `h-1.5 w-1.5` es el punto de estado de la píldora de cuenta. Meterlos en esta
      // escala habría sido contarlos mal para que el número cerrara.
      // ⚠️ LA MISMA ESCALA VA EN `height` PORQUE `size-*` NO ALCANZA PARA UNA MARCA QUE NO ES CUADRADA.
      // `size-icono-lg` fija una caja de 32x32 y `object-contain` mete adentro la proporcion real; la
      // marca de Chaski es 1,51:1, asi que pintaba 32 de ancho por 21 de ALTO y se leia mas liviana
      // que el cuadrado macizo que reemplazo. Lo que hay que fijar es el ALTO y dejar que el ancho
      // salga solo: `h-icono-lg w-auto`.
      // ⛔ Y NO SE PUEDE USAR `h-icono-lg` SIN ESTE BLOQUE, medido el 2026-08-18: con la escala
      // declarada solo en `size`, la clase `h-icono-lg` NO EMITE NINGUNA REGLA y la imagen sale a su
      // tamano intrinseco — 128x85 en vez de 32 de alto. Compila, se ve, y no hace nada: el mismo
      // modo de falla que el docblock de `borderRadius` describe mas abajo.
      height: {
        "icono-sm": "1rem",
        "icono-md": "1.5rem",
        "icono-lg": "2rem",
      },
      size: {
        "icono-sm": "1rem",
        "icono-md": "1.5rem",
        "icono-lg": "2rem",
      },

      // ── Área segura (D-1) ────────────────────────────────────────────────────────────────────
      //
      // EL DEFECTO QUE CIERRAN, medido en 40f0b68: `grep -rn "safe-area\|env(safe" app src public
      // tailwind.config.ts next.config.mjs` devolvía CERO, y `public/manifest.json` declara
      // `"display": "standalone"`. O sea: la app se ofrece para instalarse a pantalla completa y no
      // tiene una sola línea que contemple los recortes del dispositivo. Instalada en un teléfono con
      // notch, el `<header>` con la píldora de cuenta corre bajo la barra de estado y el pie bajo la
      // barra de gestos. El contenedor era `px-5 pb-10 pt-6` y ninguno de los tres sumaba inset.
      //
      // POR QUÉ SON CUATRO TOKENS Y NO UN `px-`. `px-` pondría el MISMO valor a izquierda y derecha, y
      // los dos insets horizontales son distintos: en apaisado el recorte está de un solo lado. En
      // vertical los dos dan 0 y se ven iguales, que es justo el modo en que un `px-` compartido
      // pasaría desapercibido hasta que alguien gire el teléfono.
      //
      // POR QUÉ EL SEGUNDO ARGUMENTO DE `env()` NO ES DECORATIVO: `env(safe-area-inset-top)` sin
      // fallback es un valor INVÁLIDO donde la variable no existe (escritorio, navegadores viejos), y
      // un `calc()` con un término inválido invalida la declaración ENTERA. Sin el `, 0px` el padding
      // no sería "el de siempre": sería NINGUNO.
      //
      // ⚠️ LO QUE ESTOS TOKENS NO HACEN: no sirven de nada sin `viewportFit: "cover"` en
      // `app/layout.tsx`, porque sin eso el navegador ya recorta la ventana él mismo y los cuatro
      // `env()` valen 0 siempre. Los dos cambios son UNA sola cosa y se rompen por separado.
      //
      // Los cuatro valores base son los que YA tenía el contenedor de `flow.tsx` (`pt-6` / `pb-10` /
      // `px-5`): esto suma el inset, no rediseña el margen. `app/kyc-simulado/page.tsx` tenía `p-6` y
      // pasa a usar estos mismos cuatro, que es la reducción de escala de S-4 aplicada al caso más
      // barato: dos contenedores de pantalla con un solo marco en vez de dos.
      // ── S-4 · Espaciado: una escala de cuatro pasos ───────────────────────────────────────────
      //
      // LO QUE HABÍA, medido en 40f0b68 sobre los `.tsx` que no son test: 19 valores distintos de
      // padding (`p-`/`px-`/`py-`/`pt-`/…) y 12 de separación (`gap-` + `space-y-`). Treinta y un
      // números para decir "separá esto de aquello".
      //
      // EL CRITERIO: el paso lo decide QUÉ RELACIÓN hay entre las dos cosas que se separan.
      //   `ajustado` (8px)  → partes de UNA misma cosa (el ícono y su etiqueta, la fila y su valor).
      //   `normal`   (12px) → cosas distintas que se leen juntas (dos renglones de un mismo aviso).
      //   `holgado`  (16px) → bloques dentro de una tarjeta.
      //   `aire`     (24px) → secciones de una pantalla.
      // Cuatro pasos alcanzan porque la app tiene cuatro niveles de anidamiento y no más: pantalla →
      // tarjeta → bloque → fila. Un quinto paso sería un nivel que no existe.
      //
      // Va en `spacing` y no en `padding` a propósito: `spacing` alimenta `p-`, `m-`, `gap-` y
      // `space-y-` de una sola vez, así que el mismo vocabulario sirve para separar por adentro y por
      // afuera. Dos escalas paralelas (una de padding y otra de gap) es justo cómo se llega a 31.
      spacing: {
        ajustado: "0.5rem",
        normal: "0.75rem",
        holgado: "1rem",
        aire: "1.5rem",
      },

      padding: {
        "segura-t": "calc(1.5rem + env(safe-area-inset-top, 0px))", // pt-6  (24px) + inset
        "segura-b": "calc(2.5rem + env(safe-area-inset-bottom, 0px))", // pb-10 (40px) + inset
        "segura-l": "calc(1.25rem + env(safe-area-inset-left, 0px))", // px-5  (20px) + inset
        "segura-r": "calc(1.25rem + env(safe-area-inset-right, 0px))", // px-5  (20px) + inset
      },
    },
  },
  plugins: [],
} satisfies Config;
