// ⚠️ CD-15 · MUTANTE CORRIDO (2026-08-17): agregar un SEGUNDO llamador de producción de
// `interpretarVuelta` (`export const _segundoLlamador = () => interpretarVuelta(...)` en
// `firma-por-enlace.ts`) ⇒ exit=1 y UN solo `it` rojo, el de "hay exactamente UN sitio de producción".
// Restauración verificada byte a byte.
// T-062-10 (CD-8 / T1) · candado de CLASE: `interpretarVuelta` tiene UN SOLO llamador de producción.
//
// 🔴 QUÉ PROBLEMA CIERRA, Y POR QUÉ ES UN CANDADO DE CLASE Y NO DE INSTANCIA. `interpretarVuelta` es
// una ESCRITURA con nombre de lectura: consume el paso de forma irreversible y marca el viaje. El
// nombre invita justamente al uso que la rompe — llamarla "para ver qué pasó" desde un render, un
// `useMemo` o un efecto. Y `next.config.mjs` tiene `reactStrictMode: true`, así que en desarrollo los
// efectos se invocan DOS veces: la segunda lectura devuelve `ya-consumida` sobre una firma buena.
//
// Un test que dijera "el motor la llama con el argumento correcto" es de INSTANCIA: se pone verde y
// no dice nada del segundo llamador que alguien agregue mañana en un componente. La lección la dejó
// medida 061/MNR-1. Éste barre el árbol y cuenta.
//
// ⚠️ LO QUE ESTE CANDADO NO CIERRA, declarado:
//   1. Cuenta MENCIONES del identificador en archivos que no son de test, no llamadas resueltas por
//      un analizador. Un alias (`const f = interpretarVuelta; f(...)`) lo esquiva. Se prefirió el
//      barrido textual a un parser porque el modo de falla que importa —alguien escribe
//      `interpretarVuelta(` en un componente— es exactamente el que el texto ve.
//   2. No dice NADA sobre desde dónde se llama la única llamada que quedó: que esté en el motor y no
//      en un render lo fija el `expect` sobre la ruta, que es parte de este mismo `it`.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "app"];
const SCAN_EXTS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "doc", "migrations"]);

/** Ruta EXACTA de este archivo: sus propias menciones son de mentira. */
const SELF = path.resolve(ROOT, "src/infrastructure/solana/deeplink/deeplink-callers.test.ts");
/** Donde la función VIVE. Su declaración y su docblock no son llamadas. */
const DECLARACION = path.resolve(ROOT, "src/infrastructure/solana/deeplink/sesion.ts");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, out);
    } else if (SCAN_EXTS.has(path.extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

const ARCHIVOS = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

/** Un archivo de test no es producción: puede llamarla las veces que quiera. */
function esTest(rel: string): boolean {
  return /\.test\.tsx?$/.test(rel);
}

const LLAMADAS = ARCHIVOS.filter((abs) => {
  const rel = path.relative(ROOT, abs);
  return abs !== SELF && abs !== DECLARACION && !esTest(rel);
})
  .map((abs) => ({
    ruta: path.relative(ROOT, abs),
    veces: readFileSync(abs, "utf8").split("interpretarVuelta(").length - 1,
  }))
  .filter((x) => x.veces > 0);

describe("T-062-10 · CD-8: `interpretarVuelta` tiene UN solo llamador de producción", () => {
  // Sin esto el candado podría quedar vigilando CERO archivos (un `SCAN_DIRS` mal escrito, un
  // `walk` que devuelve vacío) y seguir en verde, que es como un guard deja de existir sin que nadie
  // lo note. El piso es holgado a propósito: lo que se mide es que el barrido VE el árbol.
  it("el barrido no está vacío (el candado existe de verdad)", () => {
    expect(ARCHIVOS.length).toBeGreaterThan(200);
  });

  // MUTANTE QUE MATA: agregar `interpretarVuelta(` en CUALQUIER archivo de producción —un
  // componente, un efecto, un helper— ⇒ este `it` se pone rojo y nombra el archivo.
  it("hay exactamente UN sitio de producción, y es el motor", () => {
    expect(
      LLAMADAS.map((x) => `${x.ruta} (x${x.veces})`),
      "`interpretarVuelta` CONSUME el paso de forma irreversible. Un segundo llamador de producción " +
        "—sobre todo en un render o un efecto, que React invoca dos veces en desarrollo— gasta una " +
        "firma que la persona ya dio y la vuelve `ya-consumida`. Si esta lista tiene más de una " +
        "entrada, o una entrada que no es el motor, no es un detalle de estilo.",
    ).toEqual(["src/infrastructure/solana/deeplink/firma-por-enlace.ts (x1)"]);
  });

  // ⛔ Y no puede llamarse desde presentación NI aunque alguien "sólo la mire". Este `it` es
  // redundante con el de arriba a propósito: nombra la clase de archivo prohibida, que es lo que un
  // lector busca cuando está por escribir el segundo llamador.
  it("NINGÚN archivo de presentación la menciona", () => {
    const enPresentacion = ARCHIVOS.filter((abs) => {
      const rel = path.relative(ROOT, abs);
      return rel.startsWith("src/presentation") && readFileSync(abs, "utf8").includes("interpretarVuelta");
    }).map((abs) => path.relative(ROOT, abs));
    expect(enPresentacion).toEqual([]);
  });
});
