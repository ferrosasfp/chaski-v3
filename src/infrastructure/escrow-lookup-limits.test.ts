// Candado del techo de búsqueda de escrows. Lo que vigila NO es el valor 20: es que exista UN solo
// lugar donde ese valor se decide.
//
// ── QUÉ DEFECTO CIERRA, medido el 2026-08-10 ─────────────────────────────────────────────────────
//
// La route `app/api/solana/escrow/remittance-ids/route.ts` cortaba en un literal `20` y el cliente del
// camino de recuperación del PRINCIPAL pedía un literal `10`. Nada los ataba. Resultado: el servidor
// mandaba hasta 20 filas y el cliente descartaba hasta 10, en el camino que devuelve la plata, sin
// ganar nada — el sondeo on-chain es UNA sola llamada para 10 o para 20. El test que existía entonces
// (`solana-wallet.refund.test.ts`, "sondea como máximo 10 candidatos") **afirmaba ese defecto como
// comportamiento correcto**, con 14 ids y el refundeable en el 13 esperando `escrow_not_found`.
//
// ── POR QUÉ ES SOBRE EL TEXTO FUENTE Y NO SÓLO SOBRE LOS VALORES ────────────────────────────────
//
// Comparar `MAX_RECOVERY_CANDIDATES === ESCROW_ID_LOOKUP_CEILING` en runtime pasa igual si alguien
// escribe `= 20` a mano: los dos valen 20 y el candado aplaude. Eso es un guard que se compara consigo
// mismo. Lo único que distingue "derivado" de "coincidencia" es la FORMA del código, así que este
// candado lee el archivo y exige la expresión, no el número.
//
// ⚠️ LO QUE ESTE CANDADO NO HACE, para que su verde no se lea como más de lo que es:
//   · No verifica que la route USE `MAX_IDS` en la consulta (eso lo cubren sus propios tests).
//   · No impide que alguien agregue un TERCER consumidor con su propio literal. Vigila los tres sitios
//     que existen hoy y están nombrados abajo; un cuarto sitio hay que agregarlo acá a mano.
//   · No dice nada sobre si 20 es el número correcto. Es una decisión de producto, no un invariante.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_CLOSEABLE_CANDIDATES,
  MAX_RECOVERY_CANDIDATES,
} from "./solana-wallet";
import { ESCROW_ID_LOOKUP_CEILING } from "./escrow-lookup-limits";

const RAIZ = join(__dirname, "..", "..");
const leer = (rel: string): string => readFileSync(join(RAIZ, rel), "utf8");

const RUTA_LIMITES = "src/infrastructure/escrow-lookup-limits.ts";
const RUTA_WALLET = "src/infrastructure/solana-wallet.ts";
const RUTA_ROUTE = "app/api/solana/escrow/remittance-ids/route.ts";

describe("candado · el techo de búsqueda de escrows se decide en un solo lugar", () => {
  it("T-TECHO-1: los dos topes del cliente VALEN el techo", () => {
    expect(MAX_RECOVERY_CANDIDATES).toBe(ESCROW_ID_LOOKUP_CEILING);
    expect(MAX_CLOSEABLE_CANDIDATES).toBe(ESCROW_ID_LOOKUP_CEILING);
  });

  it("T-TECHO-2: y los DERIVAN, no los copian (si no, T-TECHO-1 se aplaude solo)", () => {
    const src = leer(RUTA_WALLET);
    expect(src).toContain("export const MAX_RECOVERY_CANDIDATES = ESCROW_ID_LOOKUP_CEILING;");
    expect(src).toContain("export const MAX_CLOSEABLE_CANDIDATES = ESCROW_ID_LOOKUP_CEILING;");
    // Y que no haya quedado el literal viejo en una declaración de estos topes.
    expect(src).not.toMatch(/export const MAX_(RECOVERY|CLOSEABLE)_CANDIDATES\s*=\s*\d/);
  });

  it("T-TECHO-3: la route deriva su tope duro del mismo lugar", () => {
    const src = leer(RUTA_ROUTE);
    expect(src).toContain("const MAX_IDS = ESCROW_ID_LOOKUP_CEILING;");
    expect(src).not.toMatch(/const MAX_IDS\s*=\s*\d/);
    expect(src).toContain("escrow-lookup-limits");
  });

  it("T-TECHO-4: el módulo del techo no importa nada (o deja de ser seguro para los dos bundles)", () => {
    const src = leer(RUTA_LIMITES);
    // Un `import` acá arrastra dependencias al bundle del cliente O al del servidor, según de quién
    // sean. El archivo se declara sin imports en su propio docblock; esto lo hace verdad verificable.
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });

  it("T-TECHO-5: el techo es un entero positivo, y el cliente nunca pide más que la route", () => {
    expect(Number.isInteger(ESCROW_ID_LOOKUP_CEILING)).toBe(true);
    expect(ESCROW_ID_LOOKUP_CEILING).toBeGreaterThan(0);
    // Pedir más que el techo del servidor no puede devolver más: sería una promesa que la route no
    // cumple. Pedir menos descarta filas ya enviadas, que es el defecto original.
    expect(MAX_RECOVERY_CANDIDATES).toBeLessThanOrEqual(ESCROW_ID_LOOKUP_CEILING);
    expect(MAX_CLOSEABLE_CANDIDATES).toBeLessThanOrEqual(ESCROW_ID_LOOKUP_CEILING);
  });
});
