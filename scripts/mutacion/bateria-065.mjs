#!/usr/bin/env node
// LA BATERÍA DE MUTACIÓN DE WKH-358 / 065 — EL HARNESS, COMMITEADO (fix-pack · CR/BLQ-BAJO-3).
//
// 🔴 POR QUÉ ESTE ARCHIVO EXISTE. La tabla de mutación de esta HU vivía al final de
// `src/infrastructure/solana/deeplink/conexion.test.ts` y citaba un `scratchpad/bateria.mjs` que **no
// estaba en el repo ni en el disco**: la única vía de re-correrla se fue con la sesión que la escribió,
// así que la tabla era una lista de números que nadie podía volver a derivar. El CR lo marcó como
// bloqueante y tiene razón: una medición que no se puede repetir no es una medición, es una
// declaración. Esto es el instrumento, y vive en el repo.
//
// ⛔ NO CORRE SOLO. No es un test (vitest no lo colecta: no es `*.test.*`), no lo corre `npm test`, no
// lo corre CI. Se corre a mano cuando hay que RE-DERIVAR la tabla, que es exactamente cada vez que el
// árbol cambia. Un conteo de `it` rojos es una propiedad del ÁRBOL y no del mutante: cualquier `it`
// nuevo lo mueve, así que no se hereda.
//
//   node scripts/mutacion/bateria-065.mjs --dry            # sólo verifica que cada aguja exista 1 vez
//   node scripts/mutacion/bateria-065.mjs                  # corre los N (≈20 s cada uno)
//   node scripts/mutacion/bateria-065.mjs --solo T-065-15  # uno solo
//   node scripts/mutacion/bateria-065.mjs --salida /tmp/b.json
//
// ══ EL PROTOCOLO QUE ESTE ARCHIVO IMPLEMENTA, Y POR QUÉ CADA REGLA ══════════════════════════════════
//
//  1. RESPALDO POR COPIA (`copyFileSync`), nunca `git checkout --`: si el harness muere en el medio, el
//     árbol se restaura desde un archivo que existe, no desde el índice de git, que puede tener otras
//     cosas.
//  2. LA AGUJA SE CUENTA Y SE EXIGE `== 1`. Un mutante cuya aguja aparece dos veces toca DOS sitios y su
//     veredicto no vale. Esto no es teórico: `T-065-14` arrancó como instrumento roto exactamente así.
//  3. SE VERIFICA EL TEXTO RESULTANTE, no sólo el conteo: después de sustituir, el archivo TIENE que
//     contener el reemplazo y NO contener la aguja. Un `replace` que no hizo nada da verde sin esto.
//  4. LAS LÍNEO-NEUTRAS SE VERIFICAN: si el mutante se declara `neutro`, el largo del archivo no puede
//     cambiar. Un mutante que agrega líneas pone rojo al candado de citas ancladas por
//     DESPLAZAMIENTO, y ese rojo NO es cobertura de comportamiento.
//  5. LA SUITE CORRE COMPLETA, con `NO_COLOR=1 FORCE_COLOR=0`, por `spawnSync` y **SIN PIPES**: en este
//     entorno un pipe puede truncar la salida y dejar 33 bytes con exit 0. El exit sale de `status`.
//  6. EL CONTEO SALE DE LA LÍNEA `Tests N failed`, nunca de contar símbolos de la salida.
//  7. RESTAURACIÓN VERIFICADA por `md5` y por `git status --short` COMPLETO después de CADA mutante.
//     Si el md5 no vuelve, el harness ABORTA en vez de seguir midiendo sobre un árbol sucio.
//
// ⚠️ LO QUE ESTE HARNESS NO PUEDE CONTESTAR, dicho para que nadie se apoye en su salida:
//   · no sabe si un mutante que SOBREVIVE es equivalente o es un agujero. Eso lo decide una persona
//     leyendo el código, y esta HU ya tiene un caso medido en que el mutante estaba mal (T-065-19).
//   · no corre `tsc` ni `lint`: un mutante que no compila igual puede dar `it` rojos y parecer que mata.
//   · el `it` que muere se lee de las líneas `FAIL …` de vitest. Si un archivo entero falla al
//     colectar, esa línea nombra el archivo y no un `it`, y así queda reportado.
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const RAIZ = process.cwd();
const ESPEC = path.resolve(RAIZ, "scripts/mutacion/mutantes-065.json");
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const SOLO = args.includes("--solo") ? args[args.indexOf("--solo") + 1] : null;
const SALIDA = args.includes("--salida") ? args[args.indexOf("--salida") + 1] : null;

const md5 = (f) => createHash("md5").update(readFileSync(f)).digest("hex");
const arbolLimpio = () =>
  spawnSync("git", ["status", "--short"], { cwd: RAIZ, encoding: "utf8" }).stdout.trim();

/** El sha del árbol sobre el que se mide. Es lo que la tabla tiene que citar: un árbol direccionable. */
function shaDelArbol() {
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: RAIZ, encoding: "utf8" }).stdout.trim();
  const sucio = arbolLimpio();
  return { sha, sucio };
}

/** Corre la suite COMPLETA. Sin pipes: la salida vuelve por `spawnSync`, el exit por `status`. */
function correrSuite() {
  const r = spawnSync("npx", ["vitest", "run"], {
    cwd: RAIZ,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 512,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const salida = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // Regla 6: el conteo sale de la LÍNEA de resumen.
  const linea = salida.split("\n").find((l) => /^\s*Tests\s/.test(l)) ?? "";
  const rojos = Number(/(\d+)\s+failed/.exec(linea)?.[1] ?? 0);
  const verdes = Number(/(\d+)\s+passed/.exec(linea)?.[1] ?? 0);
  const its = [...new Set(salida.split("\n").filter((l) => /^\s*FAIL\s/.test(l)).map((l) => l.trim()))];
  return { exit: r.status, rojos, verdes, its, resumen: linea.trim() };
}

/** Los `it` rojos, recortados a `archivo > … > nombre` para que entren en una celda de tabla. */
function nombreCorto(linea) {
  const sinFail = linea.replace(/^FAIL\s+/, "");
  const partes = sinFail.split(" > ");
  if (partes.length === 1) return `${path.basename(partes[0])} (el archivo entero)`;
  return `${path.basename(partes[0])} › ${partes[partes.length - 1]}`;
}

const mutantes = JSON.parse(readFileSync(ESPEC, "utf8"));
const seleccion = SOLO ? mutantes.filter((m) => m.id === SOLO) : mutantes;
if (seleccion.length === 0) {
  console.error(`No hay ningún mutante con id ${SOLO}`);
  process.exit(2);
}

const { sha, sucio } = shaDelArbol();
if (sucio && !DRY) {
  console.error("⛔ El árbol NO está limpio. Un conteo medido sobre cambios sin commitear no es\n" +
    "re-derivable, que es justo el defecto que este harness vino a cerrar.\n" + sucio);
  process.exit(2);
}
console.error(`# árbol: ${sha}${sucio ? " (SUCIO)" : ""} · mutantes: ${seleccion.length}${DRY ? " · DRY" : ""}`);

// ── (0) LA LÍNEA BASE, PRIMERO. Sin ella no se sabe si el árbol arranca verde, y todos los conteos de
//     abajo estarían midiendo el rojo de otro. ─────────────────────────────────────────────────────
let base = null;
if (!DRY) {
  base = correrSuite();
  console.error(`# base: exit=${base.exit} · ${base.resumen}`);
  if (base.exit !== 0) {
    console.error("⛔ La suite NO arranca verde. Cualquier conteo de abajo mediría este rojo.");
    process.exit(2);
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), "bateria-065-"));
const resultados = [];

for (const m of seleccion) {
  // Un mutante puede tocar MÁS DE UN SITIO (el del CR para `T-065-COPY-1` toca dos archivos, y mover el
  // lookup de `humanError` son dos ediciones del mismo archivo). La forma corta de un solo sitio se
  // normaliza acá para que el resto del harness vea siempre una lista.
  const edits = m.edits ?? [{ archivo: m.archivo, buscar: m.buscar, reemplazar: m.reemplazar }];
  const archivos = [...new Set(edits.map((e) => path.resolve(RAIZ, e.archivo)))];
  const md5Antes = Object.fromEntries(archivos.map((a) => [a, md5(a)]));
  const respaldos = Object.fromEntries(
    archivos.map((a, i) => [a, path.join(tmp, `${m.id.replace(/[^\w.-]/g, "_")}.${i}.bak`)]),
  );
  for (const a of archivos) copyFileSync(a, respaldos[a]); // regla 1

  // Regla 2 — cada aguja se cuenta y se exige == 1, ANTES de tocar nada.
  let instrumentoRoto = null;
  for (const e of edits) {
    const abs = path.resolve(RAIZ, e.archivo);
    const apariciones = readFileSync(abs, "utf8").split(e.buscar).length - 1;
    if (apariciones !== 1) instrumentoRoto = `aguja ×${apariciones} en ${e.archivo}`;
  }
  if (instrumentoRoto) {
    console.error(`⛔ ${m.id}: INSTRUMENTO ROTO — ${instrumentoRoto} (tiene que ser 1)`);
    resultados.push({ ...m, instrumento: `ROTO: ${instrumentoRoto}` });
    continue;
  }
  if (DRY) {
    resultados.push({ ...m, instrumento: "aguja ×1 OK" });
    continue;
  }

  const largoAntes = Object.fromEntries(archivos.map((a) => [a, readFileSync(a, "utf8").split("\n").length]));
  for (const e of edits) {
    const abs = path.resolve(RAIZ, e.archivo);
    writeFileSync(abs, readFileSync(abs, "utf8").split(e.buscar).join(e.reemplazar));
  }
  try {
    // Regla 3 — el TEXTO RESULTANTE, no el conteo.
    for (const e of edits) {
      const leido = readFileSync(path.resolve(RAIZ, e.archivo), "utf8");
      if (e.reemplazar !== "" && !leido.includes(e.reemplazar)) throw new Error(`${e.archivo}: el reemplazo NO quedó escrito`);
      // ⚠️ LA SEGUNDA MITAD NO APLICA SIEMPRE, y hay que decir por qué en vez de sacarla: un mutante que
      // AGREGA algo (la `const` sin efecto de la calibración) tiene la aguja ADENTRO de su reemplazo, así
      // que exigir que la aguja desaparezca lo daría por no aplicado. El caso que esta comprobación cubre
      // —un `split/join` que no hizo nada— ya lo cubre la regla 2 (aguja == 1) más la línea de arriba.
      if (!e.reemplazar.includes(e.buscar) && leido.includes(e.buscar)) {
        throw new Error(`${e.archivo}: la aguja sigue estando`);
      }
    }
    // Regla 4 — línea-neutro declarado, línea-neutro verificado.
    let desplaza = 0;
    for (const a of archivos) desplaza += readFileSync(a, "utf8").split("\n").length - largoAntes[a];
    if (m.neutro && desplaza !== 0) throw new Error(`se declaró línea-neutro y movió ${desplaza} líneas`);

    const r = correrSuite();
    const veredicto = r.exit === 0 ? "VIVE" : "muere";
    resultados.push({
      ...m,
      exit: r.exit,
      rojos: r.rojos,
      verdes: r.verdes,
      veredicto,
      desplaza,
      itsRojos: r.its.map(nombreCorto),
    });
    console.error(`${veredicto === "muere" ? "✔" : "·"} ${m.id.padEnd(22)} exit=${r.exit} rojos=${r.rojos} ${veredicto}`);
  } finally {
    // Regla 7 — restauración VERIFICADA, y si no vuelve, se aborta.
    for (const a of archivos) copyFileSync(respaldos[a], a);
    for (const a of archivos) {
      if (md5(a) !== md5Antes[a]) {
        console.error(`⛔ ${m.id}: el md5 de ${a} NO volvió a su valor. El árbol quedó sucio: ABORTA.`);
        process.exit(3);
      }
    }
    const sucioAhora = arbolLimpio();
    if (sucioAhora !== sucio) {
      console.error(`⛔ ${m.id}: \`git status --short\` cambió tras restaurar:\n${sucioAhora}`);
      process.exit(3);
    }
  }
}

// ── LA SALIDA: la tabla en el mismo formato que la de `conexion.test.ts`, para copiarla sin editarla ──
if (!DRY) {
  console.log(`// medido sobre ${sha} · base ${base.resumen}`);
  console.log("// | id | mutante · sitio exacto | exit | rojos | `it` que muere | veredicto |");
  for (const r of resultados) {
    const it = r.itsRojos?.length ? r.itsRojos[0] + (r.itsRojos.length > 1 ? ` (+${r.itsRojos.length - 1})` : "") : "—";
    console.log(`// | ${r.id} | ${r.nota ?? ""} | exit=${r.exit} | ${r.rojos} | ${it} | ${r.veredicto} |`);
  }
}
if (SALIDA) writeFileSync(SALIDA, JSON.stringify({ sha, base, resultados }, null, 2));
