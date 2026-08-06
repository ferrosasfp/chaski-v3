// Tests — canario ESTÁTICO contra la afirmación de que una fila 'prepared' implica que el principal
// nunca entró (WKH-330 / AC-4). Patrón: src/infrastructure/persistence/webhook-outcome-writers.static.test.ts.
//
// 🔴 QUÉ PROBLEMA CIERRA, MEDIDO. Sobre el commit base 4541789 este barrido daba TOTAL = 2 en
// producción, y los dos sitios decían lo mismo y era falso:
//   · app/api/admin/reconcile-orphans/route.ts:123-124 — "una 'prepared' no se re-procesa (su
//     principal nunca entró)". Es el comentario que le explica al operador qué está viendo en
//     `preparedOrphans`, o sea la superficie donde un depósito real aparecería.
//   · src/infrastructure/persistence/supabase-settlement-ledger.ts:40 — "re-procesara órdenes cuyo
//     principal NUNCA entró".
// La afirmación es falsa porque el write que mueve 'prepared' → 'principal_in' es best-effort: si
// falla por infra (SQLSTATE clase 08), el depósito ya ocurrió, la signature ya está verificada
// on-chain, y la fila se queda en 'prepared'. 'prepared' dice "no hay depósito REGISTRADO", que no es
// lo mismo que "no hubo depósito". Refutación de que el problema fuera real: correr este barrido
// sobre 4541789 y ver los dos hits.
//
// ⚠️ ESTE GUARD BARRE EL TEXTO COMPLETO DE CADA ARCHIVO, NUNCA LÍNEA POR LÍNEA. No es una preferencia
// de estilo: MEDIDO sobre reconcile-orphans/route.ts en 4541789, el barrido por texto completo da 1
// hit y el barrido por línea da 0, porque la frase cruza el salto de línea (":123" termina en "su
// principal" y ":124" empieza en "nunca entró"). Un guard escrito de la forma obvia habría dado verde
// el día uno con la frase falsa intacta. Refutación: leer las dos formas contra el mismo archivo.
//
// ⚠️ LO QUE ESTE CANDADO **NO** CIERRA — enunciado, no insinuado:
//   1. Es un barrido TEXTUAL, y lo textual es MÁS angosto de lo que suena. Son DOS evasiones, no una:
//      (a) SEMÁNTICA — una reformulación con otras palabras ("la plata no llegó", "sin fondos
//          entrantes") lo esquiva y este test sigue verde.
//      (b) ORTOGRÁFICA — el regex enumera formas EXACTAS. Cubre las 6 capitalizaciones de la negación
//          (ver `NEGACIONES` más abajo), pero una capitalización mixta (`nUNCA`, `nO`) lo esquiva
//          igual, y lo mismo cualquier variante de `principal`/`entr` que no sea la escrita.
//      🔴 La rama (b) NO estaba declarada acá y costó un bloqueante: el regex cubría `NUNCA` y `nunca`
//      pero de `no` sólo la minúscula, así que `principal NO entró` —el caso OBVIO, y exactamente como
//      lo escribe supabase/migrations/20260718T000000_add_prepared_status.sql:5— pasaba de largo con
//      este guard en verde. La lección no es "faltaba una mayúscula": es que declarar la evasión
//      semántica y callar la ortográfica hacía leer el verde como más fuerte de lo que era
//      (CR/BLQ-BAJO-3). ⛔ Nadie puede leer su verde como "ninguna afirmación de este tipo existe".
//   2. NO mira los `*.test.*` ni `*.spec.*` ni `test-support/`: un escritor de test no es un escritor
//      de producción, que es lo que este canario vigila. Al cerrar WKH-330 quedó vivo exactamente un
//      sitio de test con esta frase, y quedó vivo A PROPÓSITO:
//      src/application/use-cases/confirm-and-send.reorder.test.ts:160 — ahí la afirmación es
//      VERDADERA: ese test corta antes de cualquier firma (authorizeSpy nunca se llama, principalTx
//      queda null, el resultado es prepare_no_deposit_address), así que en ese escenario el principal
//      efectivamente nunca entró. Reemplazarla por la frase cauta sería cambiar una verdad por una
//      vaguedad. Los otros dos sitios de test que existían en 4541789 SÍ se corrigieron en esta HU,
//      aunque este guard no los mire: app/api/admin/reconcile-orphans/route.test.ts:191 (sigue en
//      :191, la edición fue neutra en líneas) y supabase-settlement-ledger.test.ts, que estaba en
//      :1309 en 4541789 y hoy está en :1366 porque esta misma HU insertó un test más arriba —
//      buscarla por su texto, «No está en la cola de varadas», no por el número.
//   3. El barrido NO cubre el repo: cubre EXACTAMENTE `SCAN_DIRS` (la const de más abajo en este
//      mismo archivo — se cita por NOMBRE y no por número a propósito: escribir acá el `:NN` ya se
//      desfasó una vez al crecer este mismo encabezado; hoy vale `["src","app","scripts"]`)
//      y sólo los `.ts`/`.tsx` (`SCAN_EXTS`), menos lo de `SKIP_DIRS`. Todo lo demás queda afuera, y
//      no es una lista corta: quedan afuera `contracts/` (los programas Anchor y sus comentarios) y
//      `supabase/` (las migraciones .sql, que sí llevan comentarios sobre el ciclo de vida de estas
//      filas), además de `doc/`, `migrations/` y cualquier extensión que no sea .ts/.tsx. 🟩 Medido
//      con el MISMO regex al cerrar WKH-330: `contracts/` 9 archivos / 0 hits y `supabase/` 5
//      archivos / 0 hits, así que hoy no hay nada que corregir ahí — pero ese 0 es una FOTO que este
//      test no vuelve a medir nunca. ⛔ No leer la regla como "los directorios
//      que faltan son estos dos": la regla es `SCAN_DIRS`, y esta enumeración envejece con cada
//      directorio nuevo del repo (CD-N7). Para saber qué se barre, leer `SCAN_DIRS`, no este párrafo.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "app", "scripts"];
const SCAN_EXTS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "doc", "migrations", "test-support"]);

/** Ruta EXACTA de este archivo (su encabezado cita las frases que persigue), NUNCA un glob: excluir
 *  por glob `*.static.test.ts` cegaría el barrido sobre archivos que nadie revisó. */
const SELF = path.resolve(ROOT, "src/composition/prepared-claims-guard.static.test.ts");

function isTestFile(full: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path.basename(full));
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (SCAN_EXTS.has(path.extname(entry))) {
      if (path.resolve(full) !== SELF && !isTestFile(full)) out.push(full);
    }
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

/** "principal … (NUNCA|Nunca|nunca|NO|No|no) entr[ó|a|ado]". El `[^.;]{0,60}?` deja pasar el salto de
 *  línea y el `//` de la línea siguiente, que es exactamente lo que el barrido por línea no ve. Se
 *  corta en `.` y `;` para no cruzar de una oración a otra y fabricar un match que nadie escribió.
 *
 *  🔴 LA NEGACIÓN VA ENUMERADA EN SUS 6 CAPITALIZACIONES. La versión anterior escribía
 *  `(NUNCA|nunca|no)`: cubría las DOS capitalizaciones de "nunca" pero de "no" sólo la minúscula, así
 *  que `NO entró`, `No entró` y `Nunca entró` pasaban de largo con este guard en verde. No es
 *  hipotético — el propio repo escribe esa afirmación con `NO` en mayúscula:
 *  supabase/migrations/20260718T000000_add_prepared_status.sql:5 dice "el principal aún NO entró
 *  on-chain" (queda fuera de SCAN_DIRS por el agujero #3, pero prueba que ese es el estilo de énfasis
 *  del repo). Refutación: escribir la frase con `NO` mayúscula en un archivo de producción y correr
 *  T-330-4 con el regex viejo ⇒ verde entera. CR/BLQ-BAJO-3.
 *
 *  🟩 POR QUÉ ENUMERAR Y NO PONER EL FLAG `i` — MEDIDO, no elegido por gusto. El flag `i` no ampliaría
 *  sólo la negación: también `principal` y `entr`, que no son de lo que trata el arreglo. Sobre los 88
 *  archivos que este guard barre, las tres variantes (vieja, enumerada, flag `i`) dan 0 hits, o sea
 *  que ahí la pregunta NO se contesta; sobre un corpus ANCHO de 471 archivos (src/ app/ scripts/
 *  supabase/ contracts/ doc/, incluidos tests y .md) sí se ve: la enumeración agrega 3 hits sobre el
 *  regex viejo y los 3 son la frase perseguida (uno es la migración de arriba), y el flag `i` agrega
 *  2 MÁS, de los cuales uno matchea dentro de un IDENTIFICADOR y no en prosa: el comentario
 *  «NUNCA markPrincipalIn: no entró un peso.» de confirm-and-send.money-path.test.ts (hoy `:567`,
 *  buscarlo por su texto). El match es «PrincipalIn: no entr», o sea que el ancla `principal` la pone
 *  el identificador `markPrincipalIn`, no el sustantivo. Ese es el falso positivo que el flag `i`
 *  compra, y en este repo `principalIn`/`PrincipalIn` es un identificador frecuente.
 *
 *  ⛔ Lo que la enumeración NO cubre, dicho y no insinuado: capitalizaciones mixtas (`nUNCA`, `nO`,
 *  `NUnca`). Es una apuesta a que nadie las escribe, no una cobertura. Está en el agujero #1(b). */
const CLAIM_RE = /principal[^.;]{0,60}?(NUNCA|Nunca|nunca|NO|No|no)\s+entr/g;

/** Las 6 capitalizaciones que `CLAIM_RE` declara cubrir. Vive afuera del `it` porque el assert de
 *  no-vacuidad las recorre una por una: si mañana alguien saca una del regex, el test se cae diciendo
 *  CUÁL sacó, en vez de quedarse verde como quedó hasta el CR. */
const NEGACIONES = ["NUNCA", "Nunca", "nunca", "NO", "No", "no"] as const;

interface Hit {
  rel: string;
  line: number;
  text: string;
}

function findClaims(): Hit[] {
  const hits: Hit[] = [];
  for (const full of FILES) {
    const text = readFileSync(full, "utf8");
    for (const m of text.matchAll(CLAIM_RE)) {
      const line = text.slice(0, m.index ?? 0).split("\n").length;
      hits.push({
        rel: path.relative(ROOT, full),
        line,
        text: m[0].replace(/\s+/g, " "),
      });
    }
  }
  return hits;
}

// ⚠️ El nombre de este `describe` nombra el MECANISMO (un barrido textual con un regex), NUNCA su
// resultado. La versión anterior decía "ningún archivo de producción afirma que…", que es la promesa
// de exhaustividad que el **agujero #1** del encabezado declara ilegítima (se cita por NOMBRE y no por
// `:NN`: acá decía `:26` y mi propia edición del agujero #1 lo corrió — es la TERCERA vez en esta HU
// que una auto-cita numérica de este archivo se desfasa sola). Vitest imprime el path
// completo del `describe`, así que lo que un lector del verde veía era la promesa y no el agujero.
// Exemplar del repo que ya lo resuelve: webhook-outcome-writers.static.test.ts:61 (neutro, sin
// universal). AR/BLQ-BAJO-1.
describe("WKH-330 / AC-4 — barrido textual de la frase «el principal … nunca entró» en producción", () => {
  it("el barrido no es vacuo: encuentra archivos y el regex matchea la frase que persigue", () => {
    // Sin esto, un `toEqual([])` sobre una lista vacía por un walk roto pasaría sin decir nada.
    // 50 es un PISO, no la medición: al escribir esto el barrido veía 88 archivos de producción, y
    // ese número cambia con cada archivo nuevo. Lo que el piso descarta es el caso "el walk devolvió
    // (casi) nada", que es la forma en que este guard se volvería vacuo sin ponerse rojo.
    expect(FILES.length).toBeGreaterThan(50);
    // Y el regex sí caza la frase original, incluida la variante que cruza el salto de línea.
    const unaLinea = "// una 'prepared' no se re-procesa: su principal nunca entró";
    const dosLineas = "// una 'prepared' no se re-procesa (su principal\n  // nunca entró; cancelar)";
    expect([...unaLinea.matchAll(CLAIM_RE)]).toHaveLength(1);
    expect([...dosLineas.matchAll(CLAIM_RE)]).toHaveLength(1);
    // 🔴 Y LAS 6 CAPITALIZACIONES DE LA NEGACIÓN, UNA POR UNA. Los dos asserts de arriba prueban SÓLO
    // minúscula, así que el regex perdió `NO`/`No`/`Nunca` sin que nada se pusiera rojo y el guard dio
    // verde con la frase falsa escrita en el estilo de énfasis más común del repo (CR/BLQ-BAJO-3).
    // Esto es el candado DEL ARREGLO: no alcanza con ampliar el regex si el que lo vigila mira una
    // sola capitalización. El texto de la sonda es el de la migración
    // 20260718T000000_add_prepared_status.sql:5, que ya escribe esta afirmación con `NO`.
    for (const negacion of NEGACIONES) {
      const enUnaLinea = `// una 'prepared': el principal aún ${negacion} entró on-chain`;
      const cruzandoLinea = `// una 'prepared' no se re-procesa (su principal\n  // ${negacion} entró; cancelar)`;
      expect(
        [...enUnaLinea.matchAll(CLAIM_RE)],
        `la negación «${negacion}» en una línea se le escapa a CLAIM_RE`,
      ).toHaveLength(1);
      expect(
        [...cruzandoLinea.matchAll(CLAIM_RE)],
        `la negación «${negacion}» cruzando el salto de línea se le escapa a CLAIM_RE`,
      ).toHaveLength(1);
    }
  });

  it("T-330-4 (AC-4): cero hits del regex en los .ts/.tsx de producción bajo SCAN_DIRS", () => {
    const hits = findClaims();
    // El assert nombra los sitios, no sólo el número: un `expected 2 to be 0` no le dice a nadie
    // dónde mirar. La frase cauta que corresponde es "no hay depósito REGISTRADO", que no afirma
    // nada sobre el mundo — sólo sobre la fila.
    expect(
      hits.map((h) => `${h.rel}:${h.line}  «${h.text}»`),
      "hay comentarios de producción que afirman que una fila 'prepared' implica que el principal no entró; es falso cuando el write del principal falló por infra (WKH-330)",
    ).toEqual([]);
  });
});
