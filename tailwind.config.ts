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
        cochineal: { DEFAULT: "#CB2A54", ink: "#9E1C40" },
        verde: { DEFAULT: "#12805C", bg: "#E7F3EE" },
        sand: "#F3EFE7",
      },
      fontFamily: { sans: ["var(--font-hanken)", "system-ui", "sans-serif"] },
      letterSpacing: { heading: "-0.03em" },
      boxShadow: {
        card: "0 1px 2px rgba(23,19,15,0.04), 0 10px 30px -14px rgba(23,19,15,0.14)",
        lift: "0 2px 6px rgba(23,19,15,0.06), 0 20px 50px -20px rgba(203,42,84,0.20)",
      },
      borderRadius: { xl2: "1.25rem" },

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
