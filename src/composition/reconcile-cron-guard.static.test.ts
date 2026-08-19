// Tests — candado ESTATICO del productor de POST /api/admin/reconcile-orphans (WKH-328 parte B).
// Patron: no-evm-surface.test.ts (barrido de texto + exclusion por ruta exacta),
// readme-test-count.test.ts (assertar el MARCADOR antes que el valor) y
// prepared-claims-guard.static.test.ts (barrido por TEXTO COMPLETO, nunca por linea).
//
// 🔴 POR QUE EXISTE. `npm run lint` es `biome lint src app scripts`: NO mira `.github/`. Los dos
// `tsc` tampoco (tsconfig.json es la app, tsconfig.scripts.json es scripts/). Sin este archivo, el
// workflow seria el UNICO artefacto de esta HU sin ninguna verificacion mecanica: un typo en el
// nombre del secreto, o alguien que "simplifica" el curl y le saca el chequeo de status, pasaria
// `npm run qa` entero en verde.
//
// 🔴 LO QUE ESTOS 14 TESTS **NO** PRUEBAN — dicho, no escondido:
//   · Son estaticos SOBRE TEXTO. No ejecutan el workflow, no hablan con GitHub, y NO PUEDEN probar
//     que el schedule haya quedado REGISTRADO. Eso es un procedimiento humano de tres niveles, y el
//     unico que prueba algo es una corrida cuyo evento sea `schedule`
//     (`gh run list --workflow=reconcile-orphans.yml --json event`). Ni el .yml commiteado (eso es
//     la INTENCION) ni un `gh workflow run` verde (que queda con evento `workflow_dispatch`) ni un
//     HTTP 200 (que prueba el endpoint, no el productor) cuentan como prueba de registro.
//   · Un `sed` que reescriba el YAML con otra sintaxis igualmente valida los pasa en verde. Son un
//     candado ANTI-REGRESION, no una prueba de funcionamiento.
//   · No prueban que el cron CORRA: la ausencia de corridas es invisible y esta HU no entrega
//     heartbeat. Ver el encabezado del propio workflow, item 1 de "que NO mide".
//
// ⚠️ TRAMPA RESUELTA A PROPOSITO — LOS COMENTARIOS NO SON CONFIGURACION. El encabezado del workflow
// EXPLICA por que no tiene trigger `pull_request`, asi que la palabra `pull_request` aparece DOS
// veces en el archivo, en prosa. Un barrido del texto completo buscando esa palabra daria rojo con
// el workflow correcto. Por eso T-042B-2 extrae el BLOQUE `on:` (y le saca los comentarios) y
// asserta sobre las claves de ese bloque, no sobre el archivo entero. Es la misma leccion que la
// trampa 3 de no-evm-surface.test.ts.
//
// ⚠️ POR QUE NO HAY BARRIDO DE DIRECTORIOS ACA. Este archivo lee CINCO rutas fijas. No recorre
// ningun arbol, asi que no puede auto-dispararse con los literales que persigue (`.items`,
// `cat body.json`) y no necesita excluirse a si mismo. Si algun dia se le agrega un barrido, la
// exclusion tiene que ser por RUTA EXACTA y nunca por glob `*.test.ts`, que cegaria toda la suite.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const WORKFLOW_REL = ".github/workflows/reconcile-orphans.yml";
const RUNBOOK_REL = "docs/runbook-reconcile-orphans.md";
const ROUTE_REL = "app/api/admin/reconcile-orphans/route.ts";

/** Lectura defensiva: si el archivo no existe devuelve "" en vez de tirar en tiempo de import. Sin
 *  esto, borrar el workflow haria que el archivo ENTERO explote al colectar y ningun `it` correria
 *  — y lo que CD-8 pide comprobar a mano es que T-042B-0 SE PONGA ROJO, no que la suite se caiga. */
function leer(rel: string): string {
  const full = path.join(ROOT, rel);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

const YAML = leer(WORKFLOW_REL);
const RUNBOOK = leer(RUNBOOK_REL);
const ROUTE = leer(ROUTE_REL);
const GITIGNORE = leer(".gitignore");
const ENV_EXAMPLE = leer(".env.example");

/** Saca los comentarios de linea completa. NO toca los `#` que van a mitad de linea: en este YAML no
 *  hay ninguno dentro de los bloques que se inspeccionan, y un borrado ingenuo se comeria un `#`
 *  legitimo dentro de una cadena. */
function sinComentarios(texto: string): string {
  return texto
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/** El bloque de una clave de primer nivel: desde `clave:` hasta la proxima linea que arranque en la
 *  columna 0 con otra clave. Devuelve "" si la clave no esta. */
function bloqueTopLevel(texto: string, clave: string): string {
  const lineas = sinComentarios(texto).split("\n");
  const i = lineas.findIndex((l) => l === `${clave}:` || l.startsWith(`${clave}: `));
  if (i === -1) return "";
  let j = i + 1;
  while (j < lineas.length && !/^[A-Za-z]/.test(lineas[j] as string)) j++;
  return lineas.slice(i, j).join("\n");
}

/** El cuerpo `run:` de un paso, ubicado por su `- name:`. FUENTE UNICA para los tests de L1 y L2:
 *  asserta sobre el paso que corresponde y no sobre el archivo entero, asi un chequeo que vive en el
 *  paso equivocado no pasa por bueno. */
function runDelPaso(indice: number): string {
  const marcas = [...YAML.matchAll(/^ {6}- name: .+$/gm)];
  const inicio = marcas[indice]?.index;
  if (inicio === undefined) return "";
  const fin = marcas[indice + 1]?.index ?? YAML.length;
  return YAML.slice(inicio, fin);
}

const L1 = runDelPaso(0);
const L2 = runDelPaso(1);

/** El `cron:` del YAML es la FUENTE UNICA de la cadencia. No se hardcodea en este archivo a
 *  proposito: si estuviera escrito aca, cambiar el cron y la prosa de forma coordinada pero errada
 *  dejaria este candado en verde comparando dos copias de lo mismo. */
const CRON = YAML.match(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/m)?.[1] ?? "";

/** Las 6 capitalizaciones de la negacion, igual que prepared-claims-guard.static.test.ts: cubrir
 *  solo la minuscula ya dejo pasar `principal NO entro` una vez en este repo. */
const NEGACIONES = ["NUNCA", "Nunca", "nunca", "NO", "No", "no"] as const;
const CLAIM_RE = new RegExp(`principal[^.;]{0,60}?(${NEGACIONES.join("|")})\\s+entr`, "g");

describe("WKH-328B — candado estatico del workflow que invoca reconcile-orphans", () => {
  // ── T-042B-0 · CD-8 — ANTI-VACIO, VA PRIMERO ────────────────────────────────────────────────
  // Sin esto, borrar el workflow dejaria a los 13 de abajo assertando sobre la cadena vacia, y
  // varios de ellos (los que exigen NO encontrar algo) pasarian en verde. Un guard que no encuentra
  // nada aplaude.
  it("T-042B-0: el workflow existe, tiene cuerpo y se llama reconcile-orphans", () => {
    expect(existsSync(path.join(ROOT, WORKFLOW_REL)), `falta ${WORKFLOW_REL}`).toBe(true);
    expect(YAML.split("\n").length).toBeGreaterThan(25);
    expect(YAML.match(/^name:\s*(.+)$/m)?.[1]?.trim()).toBe("reconcile-orphans");
    // Y los dos pasos existen: sin ellos, L1 y L2 serian "" y sus tests pasarian por vacio.
    expect(L1.length).toBeGreaterThan(0);
    expect(L2.length).toBeGreaterThan(0);
  });

  // ── AC-B1 — hay un productor programado ─────────────────────────────────────────────────────
  it("T-042B-1: el `on:` tiene un `schedule:` con una expresion cron", () => {
    const on = bloqueTopLevel(YAML, "on");
    expect(on, "no se encontro el bloque `on:`").not.toBe("");
    expect(on).toMatch(/^\s+schedule:/m);
    // 5 campos separados por espacios: es lo que hace que esto dispare solo.
    expect(CRON.trim().split(/\s+/)).toHaveLength(5);
  });

  it("T-042B-2: el `on:` tiene EXACTAMENTE schedule + workflow_dispatch (ni push ni pull_request)", () => {
    const on = bloqueTopLevel(YAML, "on");
    const claves = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
    // Ordenado para no depender del orden de escritura.
    expect([...claves].sort()).toEqual(["schedule", "workflow_dispatch"]);
    // GitHub no expone secretos a workflows de `pull_request` desde un fork; al no tener el trigger,
    // ni siquiera existe la superficie.
    expect(claves).not.toContain("pull_request");
    expect(claves).not.toContain("push");
  });

  // ── AC-B2 — el mismo mecanismo de auth que el endpoint ya exige ──────────────────────────────
  it("T-042B-3: el secreto viaja en un header `authorization: Bearer`, alimentado por secrets.RECONCILE_ADMIN_SECRET", () => {
    expect(L1).toMatch(/-H\s+"authorization:\s*Bearer\s+\$\{RECONCILE_ADMIN_SECRET\}"/);
    // Y llega por `env:`, no interpolado dentro del `run:`.
    expect(L1).toMatch(/RECONCILE_ADMIN_SECRET:\s*\$\{\{\s*secrets\.RECONCILE_ADMIN_SECRET\s*\}\}/);
  });

  it("T-042B-4: despues de `Bearer ` solo hay una expansion, cero literales", () => {
    const usos = [...YAML.matchAll(/Bearer\s+([^"'\n]+)/g)].map((m) => (m[1] as string).trim());
    expect(usos.length, "no aparece ningun `Bearer ` en el workflow").toBeGreaterThan(0);
    for (const u of usos) {
      // `${VAR}` (env del paso) o `${{ secrets.X }}` (expresion de Actions). Nada mas.
      expect(u, `secreto en texto plano despues de Bearer: ${u}`).toMatch(/^\$\{\{?[^}]*\}?\}$/);
    }
  });

  // ── AC-B3 — el secreto NUNCA en la URL ──────────────────────────────────────────────────────
  it("T-042B-5: ninguna URL lleva el secreto (ni expansion, ni query-string)", () => {
    const urls = [...YAML.matchAll(/https?:\/\/[^\s"'`]+/g)].map((m) => m[0]);
    expect(urls.length, "el workflow no tiene ninguna URL").toBeGreaterThan(0);
    for (const u of urls) {
      expect(u, `URL con expansion de secreto: ${u}`).not.toMatch(/secrets\./);
      expect(u, `URL con expansion: ${u}`).not.toMatch(/\$\{/);
    }
    // Una query-string es cacheable y queda escrita en logs de proxies.
    for (const p of ["?secret=", "&secret=", "?token=", "&token="]) {
      expect(YAML.includes(p), `el secreto viaja en la query-string: ${p}`).toBe(false);
    }
  });

  // ── AC-B4 — no-regresion: esta HU es WIRING, no rediseno del endpoint ───────────────────────
  it("T-042B-6: route.ts sigue exportando SOLO POST", () => {
    expect(ROUTE, `falta ${ROUTE_REL}`).not.toBe("");
    const verbos = [...ROUTE.matchAll(/export\s+async\s+function\s+([A-Z]+)/g)].map((m) => m[1]);
    expect(verbos).toEqual(["POST"]);
    // Agregar GET es justo lo que exigiria Vercel Cron, y le daria semantica de lectura a una
    // operacion que MUTA.
    for (const v of ["GET", "PUT", "PATCH", "DELETE", "HEAD"]) expect(verbos).not.toContain(v);
  });

  it("T-042B-7: route.ts sigue con UNA sola llamada a markOutcome y CERO a fetch", () => {
    expect(ROUTE).not.toBe("");
    expect([...ROUTE.matchAll(/markOutcome\(/g)]).toHaveLength(1);
    // Cero fetch es lo que vuelve el doble-pago imposible por construccion.
    expect([...ROUTE.matchAll(/\bfetch\(/g)]).toHaveLength(0);
  });

  // ── AC-B5 — las dos capas fallan de verdad ──────────────────────────────────────────────────
  it("T-042B-8: L1 valida el secreto vacio y compara el status contra 200 con exit 1", () => {
    expect(L1).toMatch(/set -euo pipefail/);
    // Chequeo de secreto vacio ANTES del curl: sin el, el sintoma seria un 401 confuso.
    expect(L1).toMatch(/-z\s+"\$\{RECONCILE_ADMIN_SECRET\}"/);
    // ⚠️ El ORDEN se mide sobre el paso SIN COMENTARIOS, y no es un detalle: el comentario que
    // explica este mismo chequeo dice "ANTES del curl", asi que sobre el texto crudo la palabra
    // `curl` aparece 233 caracteres ANTES del `-z` y esta comparacion daba rojo con el workflow
    // CORRECTO. Es la misma trampa que el encabezado de este archivo declara para `pull_request`,
    // y la pague aca: un barrido de texto no distingue configuracion de prosa si no se la saca.
    const l1Codigo = sinComentarios(L1);
    expect(l1Codigo.indexOf("-z ")).toBeLessThan(l1Codigo.indexOf("curl"));
    // El status se captura y se compara. Sin esto, un 401 daria VERDE y el cron seria decorativo.
    expect(L1).toMatch(/%\{http_code\}/);
    expect(L1).toMatch(/!=\s*"200"/);
    expect(L1).toMatch(/exit 1/);
    // Y el cuerpo va a un archivo, no a stdout.
    expect(L1).toMatch(/-o\s+body\.json/);
  });

  it("T-042B-9: L2 compara los TRES contadores y sale con exit 1 si alguno es > 0", () => {
    // Las tres, no dos: borrar una deja un hallazgo entero sin senal.
    for (const v of ["prepared_total", "failed", "manual_review"]) {
      expect(L2, `falta la comparacion de ${v}`).toMatch(new RegExp(`\\$\\{${v}\\}"\\s+-gt 0`));
    }
    expect(L2).toMatch(/exit 1/);
    // ⚠️ `truncated` es un BOOLEANO (en el endpoint sale de comparar el total contra el largo de la
    // pagina), asi que se valida como true/false. Si se le aplicara la validacion de entero de los
    // otros cuatro campos, este paso quedaria ROJO SIEMPRE.
    expect(L2).toMatch(/true\s*\|\s*false\)/);
    expect(L2).not.toMatch(/\$\{prepared_truncated\}"\s+-gt/);
    // Y el resumen se escribe siempre, en verde y en rojo.
    expect(L2).toMatch(/GITHUB_STEP_SUMMARY/);
  });

  // ── AC-B6 · CD-10 — los logs de un repo PUBLICO son publicos ────────────────────────────────
  it("T-042B-10: el workflow no ecoa el body ni los IDs de correlacion", () => {
    // El array de items lleva remittanceId / quoteId / payoutId de remesas REALES.
    const prohibidos = [
      "cat body.json",
      'cat "body.json"',
      "jq . body.json",
      "jq '.' body.json",
      'jq "." body.json',
      ".items",
      "$(cat body",
      "echo $body",
      // Partido en dos a proposito: escrito de corrido, biome lo marca con
      // lint/suspicious/noTemplateCurlyInString (cree que es un template literal mal escrito).
      // Un guard tiene que NOMBRAR el literal que prohibe, asi que se lo nombra sin ensuciar el lint.
      `$${"{body}"}`,
    ];
    for (const p of prohibidos) {
      expect(YAML.includes(p), `el workflow imprimiria datos de remesas reales: ${p}`).toBe(false);
    }
  });

  // ── AC-B7 — solapamiento y cota de duracion ─────────────────────────────────────────────────
  it("T-042B-11: hay concurrency (sin cancelar la corrida en curso) y un timeout", () => {
    const c = bloqueTopLevel(YAML, "concurrency");
    expect(c, "no se encontro el bloque `concurrency:`").not.toBe("");
    expect(c).toMatch(/^\s+group:\s*\S+/m);
    // `false` y no `true`: cancelar la corrida en curso dejaria el batch a la mitad. Sin concurrency,
    // dos corridas solapadas doble-incrementan `attempts` sobre la misma fila.
    expect(c).toMatch(/cancel-in-progress:\s*false/);
    expect(YAML).toMatch(/^\s+timeout-minutes:\s*\d+/m);
  });

  // ── AC-B8 — el runbook, y que sea VISIBLE en el repo publico ────────────────────────────────
  it("T-042B-12: el runbook existe y esta whitelisteado en .gitignore", () => {
    expect(existsSync(path.join(ROOT, RUNBOOK_REL)), `falta ${RUNBOOK_REL}`).toBe(true);
    expect(RUNBOOK.length).toBeGreaterThan(500);
    // `docs/*` esta ignorado y solo se rescatan archivos nombrados a mano: sin esta linea el runbook
    // queda en el disco y FUERA del repo, o sea invisible para quien revisa este repo publico.
    expect(GITIGNORE.split("\n")).toContain(`!${RUNBOOK_REL}`);
  });

  it("T-042B-13: el runbook no afirma que una fila prepared implique que no hubo deposito", () => {
    // 🔴 BARRIDO POR TEXTO COMPLETO, NUNCA POR LINEA: medido en este repo, la frase cruzaba el salto
    // de linea y el barrido por linea daba 0 hits con la frase falsa intacta.
    const hits = [...RUNBOOK.matchAll(CLAIM_RE)].map((m) => m[0].replace(/\s+/g, " "));
    expect(hits).toEqual([]);
    // Control de no-vacuidad: si el regex dejara de matchear la frase que persigue, el `[]` de
    // arriba no diria nada. prepared-claims-guard NO mira `.md`, asi que aca no hay otra red.
    const sonda = "una fila prepared dice que su principal nunca entro";
    expect([...sonda.matchAll(CLAIM_RE)]).toHaveLength(1);
    for (const neg of NEGACIONES) {
      expect([...`el principal ${neg} entro`.matchAll(CLAIM_RE)]).toHaveLength(1);
    }
  });

  it("T-042B-14: la cadencia del runbook y de .env.example es la MISMA string que el cron del YAML", () => {
    // Fuente unica: el cron sale del YAML, no de una copia escrita en este test.
    expect(CRON, "no se pudo leer el `cron:` del workflow").not.toBe("");
    expect(RUNBOOK.includes(CRON), `el runbook no declara la cadencia ${CRON}`).toBe(true);
    expect(ENV_EXAMPLE.includes(CRON), `.env.example no declara la cadencia ${CRON}`).toBe(true);
  });
});
