// Invariante de documentacion: el conteo de archivos de test que declaran los DOS README es el que
// la suite realmente tiene. Patron: no-evm-surface.test.ts, que tambien recorre el arbol.
//
// POR QUE EXISTE. docs/architecture.md:3-5 declara al README el lugar canonico del conteo, textual,
// "para que no puedan quedar dos numeros distintos en dos documentos". Ese mecanismo no verificaba
// nada: el 2026-08-15 los dos README decian "750 tests en 59 archivos" y la suite daba 2109 en 121.
// Un factor de casi 3, en el unico documento que un revisor externo si ve (project-context.md y doc/
// estan gitignoreados). La decision de tener un lugar canonico era buena; lo que faltaba era esto.
//
// QUE CLAVA Y QUE NO:
//
//   SI  el numero de ARCHIVOS de test, que es exacto y derivable sin correr la suite.
//   NO  el numero de CASOS (2109 al escribir esto). Para saberlo hay que correr la suite, y un test
//       que corre la suite para contarla es recursivo. Por eso ese numero se SACO de los README y se
//       reemplazo por el comando: lo que no se puede clavar, no se escribe como numero. El tercer
//       bloque de abajo impide que vuelva a entrar.
//
// TRES TRAMPAS, cada una resuelta a proposito:
//
// 1. UN GUARD QUE NO ENCUENTRA NADA APLAUDE. Si el regex deja de matchear porque alguien reescribio
//    la frase, un `expect(declarado).toBe(real)` sobre `undefined` no protege: protege el caso en
//    que ambos son undefined. Por eso se asserta PRIMERO que el marcador aparece en los dos idiomas,
//    y aparte que el arbol devuelve mas de 50 archivos.
// 2. LA ASIMETRIA ENTRE IDIOMAS NO SE VE. El modo de falla de una traduccion parcial no es decir algo
//    falso: es OMITIR. Ya paso en este repo que la version en espanol se salteo un parrafo entero de
//    seguridad. Por eso los dos README se miden por separado y con su propio marcador, y ninguno
//    hereda el resultado del otro.
// 3. EL BARRIDO Y VITEST PUEDEN CONTAR DISTINTO. Este archivo cuenta bajo cuatro directorios; vitest,
//    sin config (no hay vitest.config.* en el repo), descubre desde la raiz. El tercer test de este
//    bloque cierra la diferencia: falla si aparece un test FUERA de esos cuatro directorios.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");

/** Los cuatro que hoy tienen tests. Si se agrega un quinto, T3 se pone rojo y hay que sumarlo aca. */
const TEST_DIRS = ["src", "app", "contracts", "scripts"] as const;

/** Artefactos de build y material vendorizado: ni vitest ni este barrido cuentan ahi. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".vercel",
  "dist",
  "coverage",
  "m5-keys",
  "doc",
  "public",
  "supabase",
]);

/** Mismo shape que el include por defecto de vitest: `*.{test,spec}.?(c|m)[jt]s?(x)`. */
const TEST_FILE = /\.(test|spec)\.(c|m)?[jt]sx?$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (TEST_FILE.test(entry)) {
      out.push(path.relative(ROOT, full));
    }
  }
  return out;
}

const TEST_FILES = TEST_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const ACTUAL = TEST_FILES.length;

/** Un marcador por idioma. Se declaran aca para que cambiar la frase en un README ponga esto rojo
 *  en vez de dejar el numero suelto sin vigilancia. */
const READMES = [
  { file: "README.md", marker: /\*\*(\d+) test files\*\*/, label: "ingles" },
  { file: "README.es.md", marker: /\*\*(\d+) archivos de test\*\*/, label: "espanol" },
] as const;

describe("el conteo de archivos de test de los README es el real", () => {
  it("el barrido encuentra tests (si diera 0, todo lo de abajo pasaria por vacio)", () => {
    expect(ACTUAL).toBeGreaterThan(50);
    expect(TEST_FILES).toContain(path.join("src", "composition", "readme-test-count.test.ts"));
  });

  for (const { file, marker, label } of READMES) {
    it(`${file} (${label}) declara ${"exactamente el numero real"}`, () => {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      const hit = text.match(marker);
      // TRAMPA 1: primero que el marcador EXISTA. Sin esto, reescribir la frase apaga el guard.
      expect(hit, `no se encontro ${marker} en ${file}: si cambiaste la frase, actualiza el marcador`).not.toBeNull();
      expect(Number((hit as RegExpMatchArray)[1])).toBe(ACTUAL);
    });
  }

  // TRAMPA 3: que vitest y este barrido cuenten el mismo conjunto.
  it("no hay archivos de test fuera de los cuatro directorios medidos", () => {
    const outside = walk(ROOT).filter(
      (rel) => !TEST_DIRS.some((d) => rel === d || rel.startsWith(`${d}${path.sep}`)),
    );
    expect(outside).toEqual([]);
  });

  // Lo que no se puede clavar no se escribe como numero: el conteo de CASOS sale de correr la suite.
  it("ningun README reintroduce un conteo de casos escrito a mano", () => {
    const offenders: string[] = [];
    for (const { file } of READMES) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      for (const line of text.split("\n")) {
        if (/\b\d{3,}\s+(tests|test cases|cases|casos|pruebas)\b/i.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
