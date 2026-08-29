#!/usr/bin/env node
// WKH-075 · EL INSTRUMENTO DE AC-6 — ATRIBUCIÓN POR CÓDIGO DE SALIDA.
//
// 🔴 QUÉ AGREGA ESTO SOBRE `npm test`. El archivo de test que lanza
// (`src/presentation/vuelta-por-enlace-carrera.test.tsx`) YA lo corre `npm test`, así que el
// COMPORTAMIENTO está cubierto por el gate del repo. Lo que este envoltorio agrega es **atribución**:
// traduce el resultado a códigos de salida distintos, para que quien lo corra sepa *cuál* de los
// desenlaces ocurrió sin leer la salida de vitest.
//
//   exit 0   la vuelta se resuelve por el camino por enlace y EL SELECTOR NO APARECE
//   exit 10  EL DEFECTO: el selector de la librería está en el DOM tras una vuelta válida
//   exit 20  el techo venció y la vuelta salió por la causa de AC-3
//   exit 30  EL INSTRUMENTO NO PUDO CORRER — ⛔ y esto NO ES UN VERDE. Es la lección del cero
//            uniforme: un barrido que no ejecutó nada y un barrido que no encontró nada se ven igual.
//
// ⛔ SU LLAMADOR, NOMBRADO Y SIN ADORNOS: se corre A MANO con
//
//   node scripts/probe-vuelta-por-enlace.mjs
//
// ⛔ NO ESTÁ CABLEADO A CI, y no se afirma que lo esté. Lo que corre en CI es `npm test`, que ejecuta
// el archivo de test —o sea el comportamiento— pero no esta atribución.
//
// ⚠️ LOS TRES LÍMITES, escritos ANTES de que alguien se apoye en su exit 0:
//   1. Corre en jsdom, no en un navegador. **El runner de tests no es el runtime real.**
//   2. Se mockea el BARREL de wallets (arrastra Ledger y no resuelve bajo vitest). Los adapters de
//      Phantom y Solflare son los REALES.
//   3. ⛔ NO SUSTITUYE A UN TELÉFONO.
//
// Reglas de implementación heredadas de `scripts/mutacion/bateria-065.mjs`:
//   · `spawnSync` SIN PIPES: en este entorno un pipe puede truncar la salida y dejar 33 bytes con
//     exit 0. El veredicto sale de `status` y del JSON, nunca de contar símbolos de la salida.
//   · `NO_COLOR=1 FORCE_COLOR=0`.
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const OBJETIVO = "src/presentation/vuelta-por-enlace-carrera.test.tsx";
const SALIDA = path.join(mkdtempSync(path.join(tmpdir(), "probe-075-")), "resultado.json");

function fin(codigo, mensaje) {
  console.log(`[probe-075] exit=${codigo} · ${mensaje}`);
  process.exit(codigo);
}

const r = spawnSync(
  "npx",
  ["vitest", "run", OBJETIVO, "--reporter=json", "--outputFile", SALIDA],
  { cwd: process.cwd(), env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, stdio: "inherit" },
);

if (r.error) fin(30, `el instrumento no pudo arrancar: ${r.error.message}`);

let informe;
try {
  informe = JSON.parse(readFileSync(SALIDA, "utf8"));
} catch (e) {
  // ⛔ Sin JSON no hay veredicto. Un `status === 0` acá NO se lee como verde.
  fin(30, `el instrumento corrió pero no dejó informe legible (${e.message}); status=${r.status}`);
}

const casos = (informe.testResults ?? []).flatMap((a) => a.assertionResults ?? []);
// 🔴 CONTROL POSITIVO DEL PROPIO INSTRUMENTO: si el archivo no aportó casos, esto NO es "no hay
// defecto", es "no medí". Un `every` sobre una lista vacía devuelve `true`.
if (casos.length === 0) fin(30, "el informe no trae un solo caso: el barrido no ejecutó nada");

const fallados = casos.filter((c) => c.status === "failed");
if (fallados.length === 0) fin(0, `${casos.length} casos, ninguno falló: el selector no aparece por ninguna de las dos puertas`);

const texto = JSON.stringify(fallados);
if (texto.includes("terminar de reconocer qué billetera hay en este navegador")) {
  fin(20, "el techo venció y la vuelta salió por la causa de AC-3");
}
if (texto.includes("el selector de la librería está en el DOM") || texto.includes("sigue abriendo el selector")) {
  fin(10, `EL DEFECTO: el selector de la librería está en el DOM tras una vuelta válida (${fallados.length} casos)`);
}
fin(30, `hubo ${fallados.length} caso(s) rojo(s) que este instrumento no sabe atribuir: leelos a mano`);
