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
// el símbolo. Es opt-in, y por eso el candado declara abajo su propio agujero. ⚠️ Y QUÉ CUENTA COMO COMENTARIO no es obvio: hasta el fix-pack de WKH-063 este archivo sólo veía los que ARRANCAN la línea, y se le escapaban 7 citas de 383 (3 de ellas rotas). El detalle está en el docblock de `lineasConComentario`.
//
// FORMATO ANCLADO (el que este archivo vigila):
//     (`símbolo`, `:NN`)                 ← cita al PROPIO archivo
//     (`símbolo`, `ruta/archivo.ts:NN`)  ← cita a otro archivo
// La coma entre los dos backticks es lo que lo hace una cita anclada. Una cita suelta —`flow.tsx:340`
// sin símbolo delante— NO se verifica: el candado no puede adivinar qué quiso decir.
//
// ⚠️ LO QUE ESTE CANDADO NO CIERRA, declarado y no disfrazado:
//   1. Las citas SIN ancla siguen sin vigilancia, y NADA las cuenta: lo único medido es el otro lado del
//      conjunto, y ese total NO se escribe acá porque envejece: se deriva con el regex de `:62`.
//   2. Un ancla que aparece en varias líneas del archivo destino da verde apuntando a cualquiera de
//      ellas. El ancla prueba "esta línea habla del símbolo", no "es LA línea". ⚠️ Y ACÁ VA EL TAMAÑO DEL AGUJERO, que hasta el fix-pack de WKH-359 (AR/MNR-3) nadie había medido: de las 658 citas ancladas del árbol, **580 (88,1 %) tienen su ancla en MÁS DE UNA línea del archivo destino** ⇒ el verde de este candado discrimina de verdad en ~12 % de los casos. ⛔ Los dos números son una FOTO —se mueven con cada comentario nuevo— y por eso NO hay ningún `expect` que los fije: se re-derivan con la receta de `:62` más un conteo de ocurrencias del ancla en el destino, y el instrumento que los derive tiene que calibrarse contra el total que cuenta ESTE archivo antes de que se le crea. Lo invariante sí es el reparto: este candado caza el ancla que NO existe en el destino, y no la línea equivocada dentro del mismo símbolo.
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

/**
 * 🔴 QUÉ ESTABA MAL Y POR QUÉ IMPORTA MÁS QUE LAS CITAS QUE DESTAPÓ (WKH-063 / CR/BLQ-BAJO-1).
 *
 * Esto era un predicado por línea: `startsWith("//" | "*" | "/*")`. O sea que sólo veía comentarios que
 * ARRANCAN la línea. Y la técnica de "edición línea-neutra" que este repo usa para no correr las citas
 * por número de `flow.tsx` —colgar el comentario del `>` como primer hijo JSX, o pegarlo al final de una
 * línea de código que ya existía— produce **exactamente** las líneas que el predicado viejo no podía ver.
 *
 * ⛔ La consecuencia era circular: **la técnica que protege a las citas de desplazarse creaba, en el
 * mismo gesto, citas que este candado no revisaba.** Medido antes del arreglo: 383 citas ancladas en el
 * árbol, **376 vistas y 7 ciegas**; de esas 7, **3 estaban rotas** (dos por off-by-one heredado de antes
 * de WKH-063, una desplazada por la HU). El barrido de citas de la HU acertó las 62 externas hacia
 * `flow.tsx` y falló sólo en las ciegas, que es el perfil de un agujero que no se ve desde el verde.
 *
 * CÓMO SE ARREGLÓ: dejó de ser un predicado por línea y pasó a ser un escaneo POR ARCHIVO que sigue el
 * estado del lexer (dentro/fuera de un bloque `/* *\/`, dentro/fuera de una cadena) y marca cada línea
 * que LLEVA texto de comentario, arranque con él o no. Después del cambio **no queda ninguna ciega**, y
 * esa diferencia-en-cero es lo invariante. ⚠️ EL TOTAL NO SE ESCRIBE ACÁ, y el motivo está medido: cada
 * comentario nuevo lo mueve, y WKH-357/063/358 lo movieron cuatro veces. Lo que vale es lo que los
 * `it` de abajo miden, sin depender de ninguna cifra escrita acá.
 *
 * ⚠️ POR QUÉ SE SALTEAN LAS CADENAS: sin eso, un `"https://…"` abre un comentario de línea falso y un
 * abre-bloque dentro de una cadena se traga el resto del archivo.
 * 🔴 Y ACÁ HAY UNA CORRECCIÓN DE MI PROPIA EVIDENCIA, que vale más que la defensa: primero escribí que
 * el mutante "borrarle el salteo de cadenas" daba `2 failed | 2 passed`. **Lo corrí y da `4 passed`.**
 * O sea: hoy NINGÚN archivo del árbol tiene una cadena que engañe al lexer, así que los tres `it` de
 * abajo no pueden distinguir el lexer con salteo del lexer sin salteo. La defensa era inventada.
 * Por eso el salteo tiene su propio `it` con entrada SINTÉTICA (`T-CITAS-LEXER`): es el único que lo
 * ejercita, y con él el mutante sí muere. Un guard defensivo cuyo caso no existe en el árbol necesita
 * un fixture, no una declaración.
 *
 * ⚠️ LO QUE SIGUE AFUERA: los templates multilínea (una cadena con backtick no cruza de línea acá, se
 * corta al fin de línea a propósito) y las regex con `/` que el lexer puede leer como comentario. Los
 * dos pueden hacer que una línea se marque como comentario sin serlo; el efecto es **revisar de más**,
 * nunca de menos, y una cita de mentira en una cadena se pondría roja y habría que declararla.
 */
function lineasConComentario(lineas: readonly string[]): { marcas: boolean[]; abiertoAlFinal: boolean } {
  const marcas = new Array<boolean>(lineas.length).fill(false);
  let enBloque = false;
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i] as string;
    if (enBloque) marcas[i] = true;
    let j = 0;
    let comilla: string | null = null;
    while (j < l.length) {
      const c = l[j];
      const d = l[j + 1];
      if (enBloque) {
        if (c === "*" && d === "/") {
          enBloque = false;
          j += 2;
          continue;
        }
        j++;
        continue;
      }
      if (comilla !== null) {
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === comilla) comilla = null;
        j++;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        comilla = c;
        j++;
        continue;
      }
      if (c === "/" && d === "/") {
        marcas[i] = true; // el resto de la línea es comentario
        break;
      }
      if (c === "/" && d === "*") {
        marcas[i] = true;
        enBloque = true;
        j += 2;
        continue;
      }
      j++;
    }
  }
  return { marcas, abiertoAlFinal: enBloque };
}

type Cita = {
  desde: string;
  lineaDesde: number;
  ancla: string;
  archivo: string;
  linea: number;
  crudo: string;
};

/** Los archivos cuyo escaneo se descarriló: bloque de comentario abierto al EOF. Ver el `it` de abajo. */
const DESCARRILADOS: string[] = [];

function recolectar(): Cita[] {
  const out: Cita[] = [];
  for (const abs of FILES) {
    const src = readFileSync(abs, "utf8").split("\n");
    const { marcas, abiertoAlFinal } = lineasConComentario(src);
    if (abiertoAlFinal) DESCARRILADOS.push(path.relative(ROOT, abs));
    src.forEach((l, i) => {
      if (!marcas[i]) return;
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

  // 🔴 LA PRECONDICIÓN DEL ESCÁNER, y sin ella los dos `it` de abajo pueden pasar por ceguera en vez de
  // por corrección. Si el lexer se descarrila, el bloque queda abierto hasta el EOF y desde ahí TODO se
  // marca como comentario. Un bloque abierto al final de un archivo real es imposible (no compilaría),
  // así que este `it` sólo se pone rojo cuando el instrumento se equivocó, no cuando el código está mal.
  it("ningún archivo termina DENTRO de un bloque de comentario abierto (el escáner no se descarriló)", () => {
    expect(DESCARRILADOS).toEqual([]);
  });

  // T-CITAS-LEXER · EL SALTEO DE CADENAS, con entrada SINTÉTICA porque el árbol no la tiene.
  //
  // ⚠️ ESTE `it` EXISTE POR UNA MEDICIÓN QUE ME SALIÓ AL REVÉS: el mutante "borrarle al lexer el salteo
  // de cadenas" (el bloque `if (comilla !== null)` y la apertura de comilla) corrido contra los otros
  // tres `it` da **`4 passed`** — no mata nada. Hoy ningún archivo del árbol tiene una cadena con `//`
  // ni con un abre-bloque adentro, así que el salteo es código sin un solo caso que lo ejercite. Con
  // este `it` puesto, el MISMO mutante da **`1 failed | 4 passed (5)`**, y el que cae es éste.
  //
  // Las tres filas son las tres formas en que una cadena puede mentirle al lexer, y la 3 es la peligrosa:
  // un abre-bloque en una cadena deja el bloque abierto y contagia el resto del archivo.
  it("T-CITAS-LEXER: una cadena con pinta de comentario NO abre un comentario", () => {
    const abre = `/${"*"}`; // el abre-bloque, armado por concatenación: escrito literal cerraría ESTE comentario
    const fuente = [
      `const url = "https://ejemplo.test/x";`, //  1. `//` dentro de una cadena
      `const raro = '${abre} no soy un comentario';`, //  2. abre-bloque en cadena simple
      `const t = \`${abre}\`; const y = 1;`, //  3. abre-bloque en template
      `const z = 2; // (\`ancla\`, \`:1\`) acá SÍ hay comentario`,
    ];
    const { marcas, abiertoAlFinal } = lineasConComentario(fuente);
    expect(marcas, "sólo la última línea lleva comentario de verdad").toEqual([false, false, false, true]);
    expect(abiertoAlFinal, "ninguna de las cadenas pudo dejar un bloque abierto").toBe(false);
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
