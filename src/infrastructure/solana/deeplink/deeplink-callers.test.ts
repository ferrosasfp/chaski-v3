// ⚠️ CD-15 · LOS DOS MUTANTES DE ESTE ARCHIVO SE CORRIERON (2026-08-17, re-medidos en el fix-pack 1),
// con la suite COMPLETA y restauración verificada byte a byte:
//
// | mutante                                                                | exit | `it` rojos |
// |---|---|---|
// | agregar un SEGUNDO llamador de producción de `interpretarVuelta`        | 1 | 1 |
// | escribir `deeplink_rechazado` en un archivo de `src/presentation`       | 1 | 3 |
//
// El segundo mutante mata 3 y no 1, y los tres nombran algo distinto: el `it` de copy de acá, el
// candado de citas de `scripts/` y el de citas ancladas — porque el mutante mete una línea en
// `flow-vm.ts` y eso DESPLAZA citas. Es colateral y va dicho: si no se dice, alguien cuenta 3 y cree
// que el candado de copy es más fuerte de lo que es.
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

  // MUTANTE QUE MATA (MEDIDO: exit=1, 1 `it` rojo, éste): agregar `interpretarVuelta(` en CUALQUIER
  // archivo de producción —un componente, un efecto, un helper— ⇒ rojo, y nombra el archivo.
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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AR/BLQ-BAJO-2 — las causas de enlace NO tienen copy, y eso está declarado EN EL CÓDIGO
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ MIDE ESTE CANDADO Y POR QUÉ ES AL REVÉS DE LO QUE PARECE. El AR midió que
// `grep -rn "deeplink_" src/presentation` da CERO, o sea que las causas de enlace caen todas en el
// default de `humanError` y la persona lee la misma frase para "cancelaste" y para "se venció el
// blockhash". El docblock del motor afirmaba lo contrario ("la presentación las traduce") y esa
// afirmación era FALSA.
//
// La decisión de esta HU fue corregir la afirmación y NO escribir el copy, con un motivo mecánico: el
// colaborador de enlace no está cableado (CD-13), así que ninguna de estas causas tiene camino de
// producción, y un copy para un error que nadie puede provocar es código muerto de money-path — la
// misma razón por la que el efecto de vuelta quedó fuera de scope. El copy es de la ola 4.
//
// Este `it` es lo que hace que esa decisión no envejezca sola: el día que alguien escriba el primer
// copy, se pone ROJO y obliga a reescribir el docblock del motor en el mismo commit.
// MUTANTE QUE MATA (MEDIDO: exit=1, 3 `it` rojos — éste más dos candados de citas que el mutante
// desplaza de refilón): agregar un `case DEEPLINK_RECHAZADO:` (o cualquier `"deeplink_"`) en
// `src/presentation/flow-vm.ts` ⇒ rojo, nombrando el archivo.
describe("AR/BLQ-BAJO-2 · las causas de enlace y la pantalla", () => {
  const MOTOR = path.resolve(ROOT, "src/infrastructure/solana/deeplink/firma-por-enlace.ts");
  /** Las causas se DERIVAN del módulo, no se listan a mano: una lista a mano no ve la novena. */
  const CAUSAS = [...readFileSync(MOTOR, "utf8").matchAll(/^export const (DEEPLINK_\w+) = "(\w+)";$/gm)].map(
    (m) => m[2] as string,
  );
  const PRESENTACION = ARCHIVOS.filter((abs) =>
    path.relative(ROOT, abs).startsWith("src/presentation"),
  );

  // Refutación: sin esto, un regex que dejara de matchear pondría el `it` de abajo en verde sobre una
  // lista vacía, que es exactamente cómo un candado deja de existir sin que nadie lo note.
  it("las causas se derivaron de verdad del módulo", () => {
    expect(CAUSAS.length, "el barrido no encontró NINGUNA causa exportada: no está midiendo nada").toBeGreaterThanOrEqual(
      8,
    );
    expect(CAUSAS).toContain("deeplink_rechazado");
    expect(PRESENTACION.length).toBeGreaterThan(10);
  });

  it("HOY ninguna causa de enlace tiene copy, y el docblock del motor lo dice así", () => {
    const conCopy = PRESENTACION.filter((abs) => {
      const txt = readFileSync(abs, "utf8");
      return CAUSAS.some((c) => txt.includes(c));
    }).map((abs) => path.relative(ROOT, abs));
    expect(
      conCopy,
      "alguien escribió copy para una causa de enlace. Es una buena noticia y rompe este candado a " +
        "propósito: hay que (1) actualizar el docblock de `firma-por-enlace.ts`, que hoy declara que la " +
        "pantalla NO las traduce, y (2) revisar que el copy distinga `deeplink_rechazado` " +
        "('cancelaste') de `deeplink_respuesta_ilegible` (un fallo NUESTRO) y de " +
        "`deeplink_blockhash_desconocido` ('no pudimos preguntar'), que es el trabajo fino que esta HU " +
        "dejó hecho del lado del motor.",
    ).toEqual([]);
  });
});
