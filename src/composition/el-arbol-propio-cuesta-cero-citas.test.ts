// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-374 · W0-4 — EL COSTO DEL CAMINO CONTRARIO: qué cuesta UNA cita anclada nueva hacia `flow.tsx`
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ NO MIDE, Y POR QUÉ SE CAMBIÓ. El work-item proponía correr el candado de citas contra un
// módulo nuevo vacío y verificar que su censo entrante es 0. Eso es TAUTOLÓGICO: nadie cita un archivo
// que acaba de nacer, y un `it` que no puede fallar no es un control.
//
// LO QUE SÍ MIDE: cuánto cuesta la ALTERNATIVA, que es un número real y es el que decide `DT-1`. Hoy
// `src/presentation/flow.tsx` es el destino de un censo declarado en marcadores repartidos por el
// árbol; UNA cita anclada nueva hacia él corre ese número y pone rojo a TODOS los marcadores que lo
// declaran, o sea que obliga a editar archivos que esta ola tiene prohibido tocar. Una cita SUELTA no
// mueve ninguno. Ésa es la diferencia que este `it` convierte en aserción.
//
// ⛔ NO SE IMPORTA `citas-ancladas.test.ts`, y no es prolijidad: importar un `.test.ts` CORRE sus
// `describe` y los duplica en el reporte. El regex se RE-IMPLEMENTA acá, con su cita al lado, y la
// aserción 4 lo CALIBRA contra lo que los marcadores del árbol declaran.
//
// ⚠️ Y LO QUE ESTE INSTRUMENTO **NO** ES: no es el candado real. El de verdad
// (`../composition/citas-ancladas.test.ts`, ⛔ cita SIN ancla a propósito: es el archivo que este
// docblock está describiendo y anclarlo lo ataría a un número suyo) sigue el estado de un lexer para
// decidir qué línea LLEVA comentario; el de acá no. Medido hoy: para el destino `flow.tsx` los dos
// dan el mismo número, porque no hay ninguna cita anclada a `flow.tsx` fuera de un comentario. La
// aserción 4 existe exactamente para que el día que eso deje de ser cierto esto se ponga ROJO en vez
// de seguir midiendo otra cosa en silencio.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "app", "scripts", "contracts"];
const EXTS = new Set([".ts", ".tsx"]);
const SKIP = new Set(["node_modules", ".next", "doc", "migrations"]);
const DESTINO = "src/presentation/flow.tsx";

/** 🔴 RUTA EXACTA, ⛔ NUNCA UN GLOB NI EL SUFIJO `.test.`. Este archivo fabrica citas de mentira; sin
 *  excluirse, se contaría a sí mismo. Mismo recurso que (`SELF`, `./citas-ancladas.test.ts:56`). */
const SELF = path.resolve(ROOT, "src/composition/el-arbol-propio-cuesta-cero-citas.test.ts");

/** El regex ANCLADO, re-implementado del que vive en (`ANCLADA`, `./citas-ancladas.test.ts:74`).
 *  🔴 LA COMA ENTRE LOS DOS BACKTICKS ES LO QUE VUELVE ANCLADA A UNA CITA. Sin ella es una cita
 *  SUELTA y no la cuenta nadie: ése es el agujero que la aserción 3 mide, y el que hace barata la
 *  alternativa que esta ola eligió. */
const ANCLADA = /`([A-Za-z_$][\w$.]*)`,\s*`([\w./-]*?):(\d+)(?:-\d+)?`/g;
/** El regex del CENSO, re-implementado de (`CENSO`, `./citas-ancladas.test.ts:331`). */
const CENSO = /\[\[CENSO ([\w./-]+) (lineas|entrantes|destinos)(?:-desde-(\d+))?=(\d+)\]\]/g;

type Fuente = { archivo: string; lineas: readonly string[] };
type Cita = { desde: string; ancla: string; archivo: string; linea: number };
type Marca = { desde: string; ruta: string; campo: string; dice: number };

function leerElArbol(dir: string, out: Fuente[] = []): Fuente[] {
  for (const entrada of readdirSync(dir)) {
    const full = path.join(dir, entrada);
    if (statSync(full).isDirectory()) {
      if (!SKIP.has(entrada)) leerElArbol(full, out);
    } else if (EXTS.has(path.extname(entrada)) && path.resolve(full) !== SELF) {
      out.push({ archivo: path.relative(ROOT, full), lineas: readFileSync(full, "utf8").split("\n") });
    }
  }
  return out;
}

const ARBOL = SCAN_DIRS.flatMap((d) => leerElArbol(path.join(ROOT, d)));
const RUTAS = new Set(ARBOL.map((f) => f.archivo));

/** 🔴 SE RECOLECTA LÍNEA POR LÍNEA, y eso NO es un detalle de implementación: es lo que hace que un
 *  ancla PARTIDA por un salto de línea quede afuera del conjunto. El candado real hace lo mismo, así
 *  que la cita partida queda ROTA Y VERDE, POR AUSENCIA — 47 ocurrencias preexistentes en el árbol al
 *  escribir esto. El fixture de la aserción 3b le entra con una y exige que NO se cuente: si este
 *  recolector la contara, diferiría del real en un caso borde y la calibración pasaría de casualidad. */
function recolectar(fuentes: readonly Fuente[]): Cita[] {
  const out: Cita[] = [];
  for (const f of fuentes) {
    f.lineas.forEach((l) => {
      for (const m of l.matchAll(ANCLADA)) {
        out.push({ desde: f.archivo, ancla: m[1] as string, archivo: m[2] as string, linea: Number(m[3]) });
      }
    });
  }
  return out;
}

/** Resuelve el destino igual que el candado real: relativo al que cita, o por basename único. */
function resolver(c: Cita): string | null {
  if (c.archivo === "") return c.desde;
  const rel = path.relative(ROOT, path.resolve(path.dirname(path.resolve(ROOT, c.desde)), c.archivo));
  if (RUTAS.has(rel)) return rel;
  const base = path.basename(c.archivo);
  const porNombre = [...RUTAS].filter((r) => path.basename(r) === base);
  return porNombre.length === 1 ? (porNombre[0] as string) : null;
}

const entrantesA = (citas: readonly Cita[], destino: string): number =>
  citas.filter((c) => resolver(c) === destino).length;
const destinosDe = (citas: readonly Cita[], destino: string): number =>
  new Set(citas.filter((c) => resolver(c) === destino).map((c) => c.linea)).size;

function recolectarCenso(fuentes: readonly Fuente[]): Marca[] {
  const out: Marca[] = [];
  for (const f of fuentes) {
    f.lineas.forEach((l) => {
      for (const m of l.matchAll(CENSO)) {
        out.push({ desde: f.archivo, ruta: m[1] as string, campo: m[2] as string, dice: Number(m[4]) });
      }
    });
  }
  return out;
}

const CITAS = recolectar(ARBOL);
const MARCAS = recolectarCenso(ARBOL).filter((m) => m.ruta === DESTINO);
const porCampo = (campo: string): Marca[] => MARCAS.filter((m) => m.campo === campo);

/** Los backticks se arman por concatenación A PROPÓSITO: así NINGUNA línea de este archivo contiene
 *  el patrón anclado entero, y este archivo no puede contarse a sí mismo ni siquiera si mañana alguien
 *  le saca la exclusión `SELF`. La defensa que vale es `SELF`; ésta hace que el modo de falla sea un
 *  rojo y no un falso verde. */
const B = "`";
const citaAnclada = `// ver (${B}unSimbolo${B}, ${B}${DESTINO}:100${B}) y seguir`;
const citaSuelta = `// ver (${B}${DESTINO}:100${B}) y seguir`;
const citaPartida = [`// ver (${B}unSimbolo${B},`, `//     ${B}${DESTINO}:100${B}) y seguir`];

describe("W0-4 · el costo de una cita ANCLADA nueva hacia `flow.tsx`", () => {
  // MUTANTE QUE LO TIENE QUE MATAR: M-6 · quitarle al regex `ANCLADA` de acá arriba la coma
  // obligatoria (`` `sim`,\s*`f:NN` `` ⇒ `` `f:NN` ``) ⇒ la cita SUELTA empieza a contarse y cae la
  // aserción 3.
  // ⛔ LOS TRES FALSOS KILLED A EVITAR: (1) auto-lectura ⇒ exclusión por RUTA EXACTA, arriba;
  // (2) el ancla PARTIDA, que el candado real NO cuenta ⇒ la aserción 3b exige que ésta tampoco;
  // (3) importar el candado real ⇒ correría sus `describe`. Se re-implementa y se calibra (aserción 4).
  it("T-374-W0-4: una cita ANCLADA nueva hacia flow.tsx mueve 12 marcadores en 6 archivos; una SUELTA no mueve ninguno", () => {
    // 1 · EL CENSO DE HOY. Los nombres SE DERIVAN del barrido y van en el mensaje del rojo para que
    //     sea accionable; lo que se afirma son los CUATRO números, que son la foto que envejece.
    const archivos = [...new Set(MARCAS.map((m) => m.desde))].sort();
    expect(
      [archivos.length, porCampo("entrantes").length, porCampo("lineas").length, porCampo("destinos").length],
      `el censo de \`${DESTINO}\` se movió. Archivos que lo declaran hoy: ${archivos.join(", ")}`,
    ).toEqual([6, 12, 8, 1]);

    // 4 · 🔴 LA CALIBRACIÓN, Y VA ANTES DE USAR EL INSTRUMENTO: lo que ESTE recolector deriva tiene
    //     que ser lo que los marcadores del árbol declaran. Si no coincide, el instrumento está mal o
    //     el árbol se movió, y ⛔ ningún número de abajo vale. Los dos lados se derivan; ⛔ el `165`
    //     no se escribe en ninguna línea de este archivo.
    const declarado = porCampo("entrantes")[0]?.dice;
    expect(
      new Set(porCampo("entrantes").map((m) => m.dice)).size,
      "los 12 marcadores `entrantes` no dicen todos el mismo número: el árbol quedó a medio actualizar",
    ).toBe(1);
    expect(
      entrantesA(CITAS, DESTINO),
      "el conteo de este `it` no coincide con el que los marcadores del árbol declaran: o este " +
        "instrumento está mal, o el árbol se movió y hay que re-derivar el censo entero",
    ).toBe(declarado);
    expect(destinosDe(CITAS, DESTINO), "los `destinos` derivados no coinciden con el marcador").toBe(
      porCampo("destinos")[0]?.dice,
    );

    // 2 · UNA CITA ANCLADA NUEVA, sobre líneas SINTÉTICAS (⛔ no se escribe ningún archivo, en ningún
    //     lado): el conteo sube en uno ⇒ los 12 marcadores quedan desajustados de golpe.
    const conAnclada = recolectar([...ARBOL, { archivo: "src/sintetico.ts", lineas: [citaAnclada] }]);
    expect(
      entrantesA(conAnclada, DESTINO),
      "una cita ANCLADA nueva hacia `flow.tsx` no movió el conteo: el instrumento no ve el costo que " +
        "este `it` existe para medir",
    ).toBe((declarado as number) + 1);
    expect(
      porCampo("entrantes").filter((m) => m.dice !== entrantesA(conAnclada, DESTINO)).length,
      "una cita anclada nueva dejó marcadores en su sitio: el costo declarado es menor que el real",
    ).toBe(12);

    // 3 · LA MISMA CITA, SIN ANCLA (⛔ sin la coma entre backticks): no mueve NADA. Ése es el motivo
    //     por el que esta ola cita `flow.tsx` suelto y con su motivo al lado.
    const conSuelta = recolectar([...ARBOL, { archivo: "src/sintetico.ts", lineas: [citaSuelta] }]);
    expect(
      entrantesA(conSuelta, DESTINO),
      "una cita SUELTA movió el conteo: el regex dejó de exigir la coma y la alternativa barata de " +
        "esta ola dejó de ser barata",
    ).toBe(declarado);

    // 3b · EL ANCLA PARTIDA POR UN SALTO DE LÍNEA: el candado real NO la cuenta, y éste tampoco.
    //      ⛔ No es una virtud: es un AGUJERO, y se fija acá para que los dos instrumentos tengan el
    //      MISMO agujero. Si difirieran, la calibración de la aserción 4 pasaría por casualidad.
    const conPartida = recolectar([...ARBOL, { archivo: "src/sintetico.ts", lineas: citaPartida }]);
    expect(
      entrantesA(conPartida, DESTINO),
      "el ancla PARTIDA se contó acá: este recolector difiere del candado real en un caso borde y su " +
        "calibración deja de significar algo",
    ).toBe(declarado);
  });
});
