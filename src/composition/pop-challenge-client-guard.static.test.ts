// Tests — WKH-359 · T-067-20 (CD-13): el emisor del desafío es SERVER-ONLY y no puede entrar al
// bundle del cliente. Patrón: `kyc-verification-id-guard.static.test.ts`.
//
// 🔴 QUÉ AGUJERO CIERRA, Y POR QUÉ NO ALCANZA CON `tsc`. `src/infrastructure/auth/pop-challenge.ts`
// importa `node:crypto` (`createHmac`, `timingSafeEqual`). Ese módulo NO existe en el navegador, así
// que importarlo desde el camino del cliente no es un detalle de estilo: rompe el bundle, o —peor—
// lo hace crecer con un polyfill y el fallo aparece en un teléfono y no en CI. ⛔ Y `tsc` NO lo caza:
// para él `node:crypto` resuelve perfecto, porque los tipos de Node están en el proyecto.
//
// La tentación concreta que este guard vigila: `POP_CHALLENGE_TTL_SECONDS` vive en ese módulo, y el
// ancla del PoP por enlace necesita una ventana. Importar la constante sería lo más natural del mundo
// y metería `node:crypto` en el cliente de un plumazo. Por eso la ventana sale del `exp` que el
// SERVIDOR manda en el JSON (DT-10) y no de una constante compartida.
//
// ⚠️ LO QUE ESTE CANDADO **NO** CIERRA, enunciado y no insinuado:
//   1. Sigue el grafo de imports RELATIVOS (`./…`, `../…`) y por extensión `.ts`/`.tsx`. Un import por
//      alias de `tsconfig`, uno dinámico (`await import(…)`) o uno de un paquete lo esquivan.
//   2. Arranca desde las raíces listadas abajo, que son las del recorrido por enlace. **No barre el
//      cliente entero**: un módulo de UI que no esté aguas abajo de estas raíces no lo mira nadie acá.
//   3. Mira el IMPORT, no el uso. Un `import type` (que se borra en compilación y sería inofensivo)
//      también lo pondría rojo. Sesgo elegido: prefiere el falso positivo, que alguien va a mirar.
//   4. El chequeo de `Buffer` es TEXTUAL sobre el módulo nuevo, y descuenta comentarios con la misma
//      heurística del guard vecino: corta en `//` y en `/* */`, no es un parser.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const PROHIBIDO = path.resolve(ROOT, "src/infrastructure/auth/pop-challenge.ts");

/** Las raíces del recorrido por enlace: todo lo que corre en el navegador durante el PoP. */
const RAICES = [
  "src/infrastructure/solana/deeplink/pop-por-enlace.ts",
  "src/infrastructure/solana/deeplink/conexion.ts",
  "src/infrastructure/solana/deeplink/firma-por-enlace.ts",
  "src/infrastructure/solana/deeplink/sesion.ts",
  "src/infrastructure/solana/deeplink/protocol.ts",
  "src/infrastructure/solana/preparacion-por-enlace.ts",
  "src/infrastructure/solana-wallet.ts",
].map((p) => path.resolve(ROOT, p));

const IMPORT_RELATIVO = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;

/** Resuelve un especificador relativo a un archivo del árbol, o `null` si no es uno nuestro. */
function resolver(desde: string, spec: string): string | null {
  const base = path.resolve(path.dirname(desde), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(cand) && cand.endsWith(".ts")) return cand;
    if (existsSync(cand) && cand.endsWith(".tsx")) return cand;
  }
  return null;
}

/** Cierre transitivo de imports relativos desde las raíces. Devuelve archivo → quién lo trajo. */
function alcanzables(): Map<string, string> {
  const visto = new Map<string, string>();
  const pendiente = [...RAICES];
  for (const r of RAICES) visto.set(r, "(raíz)");
  while (pendiente.length > 0) {
    const actual = pendiente.pop() as string;
    if (!existsSync(actual)) continue;
    const src = readFileSync(actual, "utf8");
    for (const m of src.matchAll(IMPORT_RELATIVO)) {
      const destino = resolver(actual, m[1] as string);
      if (destino === null || visto.has(destino)) continue;
      visto.set(destino, path.relative(ROOT, actual));
      pendiente.push(destino);
    }
  }
  return visto;
}

function sinComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
}

describe("T-067-20 (CD-13): el emisor del desafío no entra al bundle del cliente", () => {
  const ALCANZABLES = alcanzables();

  // Refutación del instrumento, y va PRIMERO: un barrido que no encuentra nada aplaude. Sin esto, un
  // regex roto dejaría `ALCANZABLES` con 7 entradas (las raíces) y el `it` de abajo daría verde sobre
  // un grafo que nunca se recorrió.
  it("el barrido recorrió el grafo de verdad", () => {
    expect(
      ALCANZABLES.size,
      "el cierre transitivo no salió de las raíces: el regex de imports dejó de matchear",
    ).toBeGreaterThan(RAICES.length + 5);
    // Y llegó a un módulo que SÍ está aguas abajo, por un camino de más de un salto.
    expect(ALCANZABLES.has(path.resolve(ROOT, "src/infrastructure/solana/deeplink/sesion.ts"))).toBe(true);
    expect(existsSync(PROHIBIDO), "el módulo prohibido cambió de ruta: este guard vigila un fantasma").toBe(true);
  });

  // 🔴 MUTANTE QUE MATA: agregar
  // `import { POP_CHALLENGE_TTL_SECONDS } from "../../auth/pop-challenge";` en `pop-por-enlace.ts`.
  // `tsc` queda VERDE (los tipos de Node están en el proyecto) y este `it` se pone rojo.
  it("ningún módulo alcanzable desde el recorrido por enlace importa `pop-challenge.ts`", () => {
    const quien = ALCANZABLES.get(PROHIBIDO);
    expect(
      quien ?? null,
      "`pop-challenge.ts` importa `node:crypto`, que no existe en el navegador. La ventana del ancla " +
        "sale del `exp` que el SERVIDOR manda en el JSON (DT-10), nunca de una constante importada " +
        "de este módulo.",
    ).toBeNull();
  });

  // ⛔ La otra mitad de CD-13, y es la lección de `solana-wallet.ts:1918-1921` (auto-blindaje HU-SOL-5
  // BLQ-MED-1): `Buffer` tampoco existe en el navegador sin polyfill.
  // MUTANTE QUE MATA: cambiar `new TextEncoder().encode(...)` por `Buffer.from(...)` en el módulo.
  it("el módulo nuevo no usa `Buffer` en su código", () => {
    const p = path.resolve(ROOT, "src/infrastructure/solana/deeplink/pop-por-enlace.ts");
    const cuerpo = sinComentarios(readFileSync(p, "utf8"));
    expect(
      /\bBuffer\b/.test(cuerpo),
      "`Buffer` no existe en el navegador sin polyfill. Se usa `TextEncoder` + `bs58`.",
    ).toBe(false);
    // Refutación del descuento de comentarios: el archivo SÍ nombra `Buffer` en su docblock, así que
    // sin el descuento este `it` sería rojo siempre y estaría midiendo la prosa en vez del código.
    expect(
      /\bBuffer\b/.test(readFileSync(p, "utf8")),
      "el módulo dejó de mencionar `Buffer` en sus comentarios: este assert ya no prueba que el " +
        "descuento funcione, y hay que buscarle otro anclaje",
    ).toBe(true);
  });
});
