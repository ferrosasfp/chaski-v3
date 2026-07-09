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
    },
  },
  plugins: [],
} satisfies Config;
