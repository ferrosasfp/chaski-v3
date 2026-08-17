// Tests — candado anti-drift de las citas `archivo:línea` de los comentarios (WKH-327 / CR-MNR-2).
//
// 🔴 QUÉ PROBLEMA CIERRA, MEDIDO. Esta rama movió ocho archivos y dejó 48 citas `archivo:línea`
// apuntando a otra cosa: docblocks que decían "ver `:211-246`" y esa línea ya era el cuerpo de otra
// función. Ninguna estaba vigilada. El único candado que existía —`scripts/smoke-helpers.test.ts`,
// "cada `flow-vm.ts:NN` citado en scripts/ apunta a la línea que dice"— cubre SEIS citas de UN
// archivo, así que las seis se actualizaron y las 48 restantes no las miró nadie. En un repo cuya
// disciplina es "cada frase falsable", una cita que apunta a otra función entrena a no seguirlas.
//
// 🔴 POR QUÉ ESTE CANDADO PIDE UN ANCLA Y NO VERIFICA TODAS LAS CITAS. Un número de línea solo no
// codifica QUÉ se quiso citar, así que no hay nada contra qué compararlo. Las dos alternativas se
// descartaron con su razón:
//   · Un SNAPSHOT del texto citado (tabla archivo→línea→contenido) sería un guard que se regenera
//     cuando molesta, o sea uno que se compara consigo mismo. Este repo ya tiene esa lección escrita.
//   · Verificar TODAS las citas exigiría reescribir ~150 comentarios en una sola pasada, y varias
//     apuntan a un bloque o a un comentario que no tiene ningún símbolo que sirva de ancla.
// La forma que sí se puede verificar sin inventar nada es hacer explícito lo que la cita quiso decir:
// el símbolo. Es opt-in, y por eso el candado declara abajo su propio agujero.
//
// FORMATO ANCLADO (el que este archivo vigila):
//     (`símbolo`, `:NN`)                 ← cita al PROPIO archivo
//     (`símbolo`, `ruta/archivo.ts:NN`)  ← cita a otro archivo
// La coma entre los dos backticks es lo que lo hace una cita anclada. Una cita suelta —`flow.tsx:340`
// sin símbolo delante— NO se verifica: el candado no puede adivinar qué quiso decir.
//
// ⚠️ LO QUE ESTE CANDADO NO CIERRA, declarado y no disfrazado:
//   1. Las citas SIN ancla siguen sin vigilancia. Son la mayoría.
//   2. Un ancla que aparece en varias líneas del archivo destino da verde apuntando a cualquiera de
//      ellas. El ancla prueba "esta línea habla del símbolo", no "es LA línea".
//   3. Sólo resuelve el archivo destino si la ruta es relativa al que cita o si el basename es único
//      en el árbol. Si no resuelve, el test FALLA (una cita a un archivo inexistente es un hallazgo,
//      no una excepción).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "app", "scripts", "contracts"];
const SCAN_EXTS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "doc", "migrations"]);

/** Ruta EXACTA de este archivo (nunca un glob): sus ejemplos de formato son citas de mentira. */
const SELF = path.resolve(ROOT, "src/composition/citas-ancladas.test.ts");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, out);
    } else if (SCAN_EXTS.has(path.extname(entry)) && path.resolve(full) !== SELF) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(ROOT, []).length === 0 ? [] : SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

/** `símbolo` + coma + `[archivo:]línea`. El símbolo admite puntos (`pop.prove`, `Set.has`). */
const ANCLADA = /`([A-Za-z_$][\w$.]*)`,\s*`([\w./-]*?):(\d+)(?:-\d+)?`/g;

function esComentario(linea: string): boolean {
  const t = linea.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

type Cita = {
  desde: string;
  lineaDesde: number;
  ancla: string;
  archivo: string;
  linea: number;
  crudo: string;
};

function recolectar(): Cita[] {
  const out: Cita[] = [];
  for (const abs of FILES) {
    const src = readFileSync(abs, "utf8").split("\n");
    src.forEach((l, i) => {
      if (!esComentario(l)) return;
      for (const m of l.matchAll(ANCLADA)) {
        out.push({
          desde: path.relative(ROOT, abs),
          lineaDesde: i + 1,
          ancla: m[1] as string,
          archivo: m[2] as string,
          linea: Number(m[3]),
          crudo: m[0] as string,
        });
      }
    });
  }
  return out;
}

/** Resuelve el destino: relativo al que cita, o por basename único en el árbol. */
function resolverDestino(cita: Cita): string | null {
  if (cita.archivo === "") return path.resolve(ROOT, cita.desde); // cita al propio archivo
  const relativo = path.resolve(path.dirname(path.resolve(ROOT, cita.desde)), cita.archivo);
  if (existsSync(relativo)) return relativo;
  const base = path.basename(cita.archivo);
  const porNombre = FILES.filter((f) => path.basename(f) === base);
  return porNombre.length === 1 ? (porNombre[0] as string) : null;
}

const CITAS = recolectar();

describe("candado anti-drift: toda cita ANCLADA apunta a una línea que nombra su símbolo", () => {
  // Sin esto el candado puede quedar vigilando CERO citas y seguir en verde, que es como un guard
  // deja de existir sin que nadie lo note. El piso es el conteo MEDIDO al escribirlo (41), no un
  // objetivo: si alguien borra anclas en masa, esto se pone rojo y hay que decir por qué.
  it("hay citas ancladas para vigilar (el candado no está vacío)", () => {
    expect(CITAS.length).toBeGreaterThanOrEqual(41);
  });

  it("cada cita anclada resuelve a un archivo del árbol", () => {
    const rotas = CITAS.filter((c) => resolverDestino(c) === null).map(
      (c) => `${c.desde}:${c.lineaDesde} → ${c.crudo}`,
    );
    expect(rotas).toEqual([]);
  });

  it("cada cita anclada apunta a una línea que contiene su símbolo", () => {
    const rotas: string[] = [];
    for (const c of CITAS) {
      const destino = resolverDestino(c);
      if (destino === null) continue; // ya lo reporta el `it` de arriba
      const lineas = readFileSync(destino, "utf8").split("\n");
      const linea = lineas[c.linea - 1];
      if (linea === undefined) {
        rotas.push(`${c.desde}:${c.lineaDesde} → ${c.crudo}: la línea no existe`);
        continue;
      }
      if (!linea.includes(c.ancla)) {
        rotas.push(
          `${c.desde}:${c.lineaDesde} → ${c.crudo}: la línea dice «${linea.trim().slice(0, 70)}»`,
        );
      }
    }
    expect(rotas).toEqual([]);
  });
});
