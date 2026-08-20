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
//      conjunto, y ese total NO se escribe acá porque envejece: se deriva con el regex de `:74`.
//   2. Un ancla que aparece en varias líneas del archivo destino da verde apuntando a cualquiera de
//      ellas. El ancla prueba "esta línea habla del símbolo", no "es LA línea". ⚠️ Y ACÁ VA EL TAMAÑO DEL AGUJERO, que hasta el fix-pack de WKH-359 (AR/MNR-3) nadie había medido: de las 658 citas ancladas del árbol, **580 (88,1 %) tienen su ancla en MÁS DE UNA línea del archivo destino** ⇒ el verde de este candado discrimina de verdad en ~12 % de los casos. ⛔ Los dos números son una FOTO —se mueven con cada comentario nuevo— y por eso NO hay ningún `expect` que los fije: se re-derivan con la receta de `:62` más un conteo de ocurrencias del ancla en el destino, y el instrumento que los derive tiene que calibrarse contra el total que cuenta ESTE archivo antes de que se le crea. Lo invariante sí es el reparto: este candado caza el ancla que NO existe en el destino, y no la línea equivocada dentro del mismo símbolo.
//   3. Sólo resuelve el archivo destino si la ruta es relativa al que cita o si el basename es único
//      en el árbol. Si no resuelve, el test FALLA (una cita a un archivo inexistente es un hallazgo,
//      no una excepción).
//   4. 🔴 UNA CITA A UN MÓDULO **BORRADO** PASA SIN CHISTAR SI NO ESTÁ ANCLADA, Y ESO YA COSTÓ SEIS
//      CITAS MUERTAS (WKH-233 fix-pack · H-8). WKH-233 borró `src/infrastructure/didit/` entero, y
//      quedaron SEIS comentarios citando `didit-env.ts` y `didit/decision.ts` como si fueran exemplares
//      vivos: `kyc-verdict-ttl-env.ts`, `kyc-verdict-ttl.ts`, `flow.tsx`, `flow-vm.ts`,
//      `persistence/supabase-kyc-verdicts.ts` y `app/api/mock-didit/v3/session/route.ts`. **Este
//      candado pasaba en verde (9 de 9) mientras las seis estaban rotas**, y no por un defecto: NINGUNA
//      estaba en formato anclado, así que ninguna entraba a su conjunto. El punto 3 de arriba —"si no
//      resuelve, el test FALLA"— sólo vale para las ANCLADAS, y leído rápido suena a que el candado
//      cubre todo archivo citado. NO lo cubre.
//      ⛔ Corolario, que es lo que hay que llevarse: **el verde de este archivo NO significa "las citas
//      del repo están bien"**. Significa "las que alguien decidió anclar están bien". El perímetro es
//      opt-in y quien lo lea tiene que saber de qué tamaño es lo que queda afuera.
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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// EL CENSO — las AFIRMACIONES NUMÉRICAS sobre el árbol, verificadas (WKH-359 / CR/MNR-2 + CR/MNR-3)
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ PROBLEMA CIERRA, MEDIDO, Y POR QUÉ NO ALCANZABA CON RE-MEDIR. Este repo justifica su
// convención Δ0 —"lo nuevo va al final, insertar arriba corre las citas de abajo"— con frases del tipo
// *"este archivo tiene 2362 líneas y recibe 116 citas ancladas"*. El razonamiento no envejece; **el
// número sí, y lo mueve el mismo commit que lo escribe**. La cuenta de esta sola HU:
//   · "2247 líneas / 85 citas / rompe 34"  ⇒ corregido a  "2362 / 116 / 50"  ⇒ hoy sería otro.
//   · "47 citas por número" en el gate de `solana-wallet.ts`, que era un conteo COPIADO del número
//     viejo del archivo.
//   · la corrección de ese 47 decía "RE-MEDIDO en el árbol de este commit" y reportaba, al dígito, los
//     cinco números del árbol BASE (CR/MNR-2). O sea: **el fix de un conteo inventado, repitiendo el
//     defecto una capa más arriba**, que es el peor lugar posible para tenerlo.
//   · seis cifras más que el propio commit volvió falsas sin que nadie editara una frase (CR/MNR-3).
// Y lo que cierra el caso: mientras se escribía ESTE bloque, los números medidos al empezar la sesión
// (123 entrantes a `solana-wallet.ts`, 87 a `flow.tsx`) ya habían cambiado a 126 y 98 por los commits
// del propio fix-pack. **Re-medir a mano produce la séptima cifra falsa, no la primera verdadera.**
//
// ⇒ LA ÚNICA FORMA QUE NO SE PUDRE ES QUE EL NÚMERO NO SE ESCRIBA A MANO, SINO QUE SE VERIFIQUE. El
// marcador ES la receta, y es EJECUTABLE:
//     [[CENSO ruta/desde/la/raiz.ts lineas=2498]]            <- lo que cuenta `wc -l`
//     [[CENSO ruta/desde/la/raiz.ts entrantes=126]]          <- citas ANCLADAS que apuntan a ese archivo
//     [[CENSO ruta/desde/la/raiz.ts destinos=68]]            <- líneas destino distintas
//     [[CENSO ruta/desde/la/raiz.ts entrantes-desde-906=75]] <- las que caen en la 906 o más abajo
//     [[CENSO ruta/desde/la/raiz.ts destinos-desde-463=4]]   <- ídem, contando líneas destino
// Si el árbol se mueve, el marcador se pone ROJO y hay que re-derivarlo. Es el mismo trato que
// `deriveTables()` en el repo hermano: **el criterio es la regla y el número es una foto**, sólo que acá
// la foto tiene fecha de vencimiento automática.
//
// ⚠️ LO QUE ESTE CANDADO **NO** CIERRA, declarado y no disfrazado:
//   1. Es OPT-IN, igual que las citas ancladas: una cifra escrita en prosa sin marcador sigue sin que
//      la mire nadie. Lo que se ganó no es cobertura total: es que la cifra AHORA SE PUEDE atar.
//   2. `entrantes` cuenta las citas ANCLADAS y nada más. Las SUELTAS —`flow.tsx:4009` sin símbolo
//      delante— también se rompen al insertar arriba y siguen sin contarse (es el agujero #1 de este
//      mismo archivo). Una frase que hable de "citas por número" y se apoye en un marcador `entrantes`
//      está diciendo MENOS de lo que parece, y tiene que decirlo.
//   3. No mira la PROSA alrededor del marcador. `[[CENSO x lineas=10]]` al lado de la frase "este
//      archivo es chico" da verde aunque la frase mienta por otro motivo.
//   4. `lineas` es `wc -l`, o sea SALTOS DE LÍNEA. Un archivo sin salto final cuenta uno menos que las
//      líneas que muestra un editor. Es la misma cuenta que usan las frases que vigila, a propósito.
//
// 🔴 LA BATERÍA, CORRIDA, con restauración por `cp` desde una copia y md5 verificado en las dos puntas
// (⛔ NO con `git checkout --`: el árbol de un fix-pack no está limpio y eso restaura a HEAD, que en
// esta misma sesión se llevó puesto un refactor sin commitear):
//   · **C4** — una línea nueva insertada arriba en `solana-wallet.ts`, que ES el defecto que este
//     candado existe para cazar: `3 failed | 6 passed (9)`, y el reporte nombra los dos marcadores
//     `lineas=2498` con su valor real (`el árbol dice 2499`) y el archivo:línea de cada uno.
//     ⚠️ En esa corrida cae TAMBIÉN la calibración del +1, y no es ruido: con el árbol movido, un
//     marcador viejo +1 puede COINCIDIR con el valor nuevo y dejar de reportarse. La calibración sólo
//     significa algo sobre un árbol verde; leerla al revés es leer dos síntomas del mismo hecho.
//   · **C2** — `desajustes()` devuelve SIEMPRE `[]`: `2 failed | 7 passed (9)`, y las dos que caen son
//     las calibraciones. El `it` principal pasa. Es exactamente para lo que están.
//   · **C3** — el regex `CENSO` no matchea nada: `1 failed | 8 passed (9)`, y cae el piso. Un candado
//     que deja de ver marcadores se pone rojo en vez de quedarse en verde vigilando el vacío.
const CENSO = /\[\[CENSO ([\w./-]+) (lineas|entrantes|destinos)(?:-desde-(\d+))?=(\d+)\]\]/g;

type Marcador = {
  desde: string;
  lineaDesde: number;
  ruta: string;
  campo: string;
  piso: number | null;
  dice: number;
  crudo: string;
};

function recolectarCenso(): Marcador[] {
  const out: Marcador[] = [];
  for (const abs of FILES) {
    const src = readFileSync(abs, "utf8").split("\n");
    const { marcas } = lineasConComentario(src);
    src.forEach((l, i) => {
      if (!marcas[i]) return;
      for (const m of l.matchAll(CENSO)) {
        out.push({
          desde: path.relative(ROOT, abs),
          lineaDesde: i + 1,
          ruta: m[1] as string,
          campo: m[2] as string,
          piso: m[3] === undefined ? null : Number(m[3]),
          dice: Number(m[4]),
          crudo: m[0] as string,
        });
      }
    });
  }
  return out;
}

/** Deriva el valor REAL del campo. `null` si el archivo que nombra el marcador no existe en el árbol. */
function derivarCenso(mk: Marcador): number | null {
  const abs = path.resolve(ROOT, mk.ruta);
  if (!existsSync(abs)) return null;
  // `lineas` = lo que cuenta `wc -l` (saltos), no `split("\n").length`, que da uno más.
  if (mk.campo === "lineas") return readFileSync(abs, "utf8").split("\n").length - 1;
  const hits = CITAS.filter((c) => resolverDestino(c) === abs && (mk.piso === null || c.linea >= mk.piso));
  return mk.campo === "destinos" ? new Set(hits.map((c) => c.linea)).size : hits.length;
}

/** Los marcadores cuyo número no coincide con el árbol. Es una función APARTE para poder CALIBRARLA. */
function desajustes(marcadores: readonly Marcador[]): string[] {
  const out: string[] = [];
  for (const mk of marcadores) {
    const real = derivarCenso(mk);
    if (real === null) {
      out.push(`${mk.desde}:${mk.lineaDesde} → ${mk.crudo}: el archivo ${mk.ruta} no existe`);
      continue;
    }
    if (real !== mk.dice) out.push(`${mk.desde}:${mk.lineaDesde} → ${mk.crudo}: el árbol dice ${real}`);
  }
  return out;
}

const CENSOS = recolectarCenso();

describe("candado anti-drift: toda afirmación numérica MARCADA coincide con el árbol", () => {
  // El piso es el conteo MEDIDO al escribirlo (24), no un objetivo, y se midió ROMPIÉNDOLO a propósito
  // —piso en 999 ⇒ `expected 24 to be greater than or equal to 999`— porque un guard que no expone su
  // total no se adivina. Sin este `it`, borrar todos los
  // marcadores deja al candado vigilando CERO y en verde, que es como un guard deja de existir sin que
  // nadie lo note.
  it("hay marcadores de censo para vigilar (el candado no está vacío)", () => {
    expect(CENSOS.length).toBeGreaterThanOrEqual(24);
  });

  it("cada marcador `[[CENSO …]]` dice el número que el árbol tiene hoy", () => {
    expect(desajustes(CENSOS)).toEqual([]);
  });

  // 🔴 LA CALIBRACIÓN, Y NO ES OPCIONAL: sin ella, un `desajustes()` que devolviera SIEMPRE `[]` —por un
  // `derivarCenso` roto, por un regex que no matchea nada, por un `filter` invertido— pasaría el `it` de
  // arriba con los 24 marcadores puestos y nadie se enteraría. Acá se le entra con los marcadores REALES
  // del árbol y el número corrido en uno, y se exige que los reporte a TODOS. Es el mismo trato que
  // `T-CITAS-LEXER` le da al lexer: el guard se prueba con la entrada que TIENE que ponerlo rojo.
  it("CALIBRACIÓN: con el número corrido en uno, el candado los reporta a todos", () => {
    const falsos = CENSOS.map((mk) => ({ ...mk, dice: mk.dice + 1 }));
    expect(desajustes(falsos)).toHaveLength(CENSOS.length);
    // Y la segunda mitad: el mensaje trae el número REAL, que es lo que hace accionable el rojo.
    const primero = CENSOS[0];
    if (primero !== undefined) {
      expect(desajustes([{ ...primero, dice: primero.dice + 1 }])[0]).toContain(`el árbol dice ${primero.dice}`);
    }
  });

  // Un marcador que apunta a un archivo inexistente es un hallazgo (se movió o se borró), no una
  // excepción. Con entrada SINTÉTICA, porque el árbol —correctamente— no tiene ninguno.
  it("CALIBRACIÓN: un marcador que apunta a un archivo que no existe se reporta", () => {
    const inventado: Marcador = {
      desde: "sintetico.ts",
      lineaDesde: 1,
      ruta: "src/no-existe-jamas.ts",
      campo: "lineas",
      piso: null,
      dice: 1,
      crudo: "[[CENSO src/no-existe-jamas.ts lineas=1]]",
    };
    expect(desajustes([inventado])).toEqual([
      "sintetico.ts:1 → [[CENSO src/no-existe-jamas.ts lineas=1]]: el archivo src/no-existe-jamas.ts no existe",
    ]);
  });
});
