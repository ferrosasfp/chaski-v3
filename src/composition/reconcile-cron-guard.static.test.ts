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
// 🔴 LO QUE LOS TESTS DE ESTE ARCHIVO **NO** PRUEBAN — dicho, no escondido:
//   · No ejecutan el workflow, no hablan con GitHub, y NO PUEDEN probar que el schedule haya quedado
//     REGISTRADO. Eso es un procedimiento humano de tres niveles, y el unico que prueba algo es una
//     corrida cuyo evento sea `schedule`
//     (`gh run list --workflow=reconcile-orphans.yml --json event`). Ni el .yml commiteado (eso es
//     la INTENCION) ni un `gh workflow run` verde (que queda con evento `workflow_dispatch`) ni un
//     HTTP 200 (que prueba el endpoint, no el productor) cuentan como prueba de registro.
//   · Un `sed` que reescriba el YAML con otra sintaxis igualmente valida los pasa en verde. Son un
//     candado ANTI-REGRESION, no una prueba de funcionamiento.
//   · No prueban que el cron CORRA: la ausencia de corridas es invisible y esta HU no entrega
//     heartbeat. Ver el encabezado del propio workflow, item 1 de "que NO mide".
//   · NO son un validador del schema de GitHub Actions. `bloqueAnidado` comprueba que la ESTRUCTURA
//     que GitHub va a leer exista (`jobs.<job>.steps[i].run`), asi que un YAML sin clave `jobs:` —que
//     GitHub no puede registrar— se pone rojo. Lo que sigue pasando en verde es un YAML con la
//     estructura correcta y un VALOR invalido: un `runs-on:` que no existe, o un `cron:` de cinco
//     campos fuera de rango. El parser de GitHub no esta disponible offline.
//   · Miran el TEXTO del `.yml`, no el resultado de ejecutarlo. Que `-o body.json` este escrito no
//     prueba que el body no se filtre por otra via (`head body.json`, un `set -x`, una accion de
//     terceros): prueba que las formas medidas de filtrarlo no estan.
//
// ⚠️ TRAMPA RESUELTA A PROPOSITO, Y AHORA EN LOS DOS SENTIDOS — LOS COMENTARIOS NO SON
// CONFIGURACION. El encabezado del workflow EXPLICA por que no tiene trigger `pull_request`, asi que
// la palabra `pull_request` aparece DOS veces en el archivo, en prosa. Un barrido del texto completo
// buscando esa palabra daria rojo con el workflow correcto.
// 🔴 Y la version PELIGROSA de la misma trampa, que en la primera entrega de este archivo estaba
// abierta y quedo medida: un comentario tambien SATISFACE una asercion que exige que algo ESTE. El
// comentario `# -o body.json ⇒ el cuerpo va a un ARCHIVO` alcanzaba para que `expect(L1).toMatch(
// /-o\s+body\.json/)` pasara con el `-o` BORRADO del curl — o sea, con el body (que lleva
// remittanceId / quoteId / payoutId de remesas REALES) imprimiendose en el log de un repo PUBLICO.
// ⇒ REGLA DE ESTE ARCHIVO, sin excepciones: **toda** asercion sobre lo que el workflow hace corre
// contra el CODIGO y nunca contra el archivo crudo. `bloqueAnidado` devuelve los bloques ya sin
// comentarios, `PASOS[i].run` es el cuerpo del `run:` sin comentarios, y `CODIGO` es todo `jobs:` sin
// comentarios. El unico barrido que toca `YAML` crudo es el de `name:` y el conteo de lineas de
// T-042B-0. Es la misma leccion que la trampa 3 de no-evm-surface.test.ts, y la que quedo escrita en
// doc/sdd/042-*/auto-blindaje.md.
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

function sangriaDe(linea: string): number {
  return linea.length - linea.trimStart().length;
}

/** Las lineas HIJAS de una clave ANIDADA, navegando por INDENTACION y sobre el texto SIN comentarios.
 *  Devuelve "" si algun tramo de `ruta` no esta a la sangria que le toca.
 *
 *  🔴 POR QUE ESTO Y NO UN BARRIDO DE TEXTO. Un barrido no distingue "esta escrito en el archivo" de
 *  "esta en el lugar donde GitHub lo va a leer". Medido: renombrar `jobs:` a `jobss:` deja un YAML
 *  sintacticamente VALIDO (`yaml.safe_load` lo lee sin chistar) que GitHub NO PUEDE REGISTRAR —o sea,
 *  el cron no corre nunca— y el barrido de texto lo aprobaba 15/15. Con la navegacion por estructura
 *  la ruta se corta y el bloque queda "", que es lo que T-042B-0 pone rojo.
 *
 *  ⚠️ POR QUE NO SE IMPORTA UN PARSER DE YAML DE VERDAD. `yaml@2.9.0` esta en `node_modules`, pero
 *  SOLO como dependencia TRANSITIVA (`npm ls yaml` ⇒ tailwindcss → postcss-load-config, y
 *  @solana/wallet-adapter-react → react-native → metro-config). Importarla desde un test la vuelve una
 *  dependencia FANTASMA: el dia que tailwind cambie de loader, este archivo explota AL IMPORTAR y se
 *  cae la suite entera por una razon que no tiene nada que ver con el workflow. Declararla en
 *  package.json esta fuera del Scope IN de esta HU. Asi que se navega a mano, y el precio esta
 *  declarado en el encabezado (esto NO valida el schema de GitHub) y calibrado en las dos direcciones
 *  en T-042B-0.
 *
 *  ⚠️ Las lineas en blanco se descartan antes de navegar: dentro de un block scalar `run: |` valen
 *  como contenido, pero su sangria es 0 y cortarian la navegacion en el primer renglon vacio del
 *  script. Para las aserciones de este archivo (regex sobre el codigo del shell) es indiferente. */
function bloqueAnidado(texto: string, ruta: readonly string[]): string {
  let lineas = sinComentarios(texto)
    .split("\n")
    .filter((l) => l.trim() !== "");
  let sangria = 0;
  for (const clave of ruta) {
    const i = lineas.findIndex(
      (l) =>
        sangriaDe(l) === sangria &&
        (l.trim() === `${clave}:` || l.trim().startsWith(`${clave}: `)),
    );
    if (i === -1) return "";
    let j = i + 1;
    while (j < lineas.length && sangriaDe(lineas[j] as string) > sangria) j++;
    lineas = lineas.slice(i + 1, j);
    if (lineas.length === 0) return "";
    sangria = sangriaDe(lineas[0] as string);
  }
  return lineas.join("\n");
}

/** Los nombres de job bajo `jobs:`. Se DERIVAN, no se hardcodean: renombrar el job es legitimo para
 *  GitHub y no tiene por que poner este candado rojo. Lo que no es legitimo es que `jobs:` no exista
 *  (no se registra) o que aparezca un segundo job que nadie reviso. */
function nombresDeJob(): readonly string[] {
  const jobs = bloqueAnidado(YAML, ["jobs"]);
  if (jobs === "") return [];
  const lineas = jobs.split("\n");
  const sangria = sangriaDe(lineas[0] as string);
  return lineas
    .filter((l) => sangriaDe(l) === sangria)
    .map((l) => /^([A-Za-z0-9_-]+):/.exec(l.trim())?.[1] ?? "")
    .filter((n) => n !== "");
}

const JOBS = nombresDeJob();
const JOB = JOBS[0] ?? "";

/** El CODIGO del workflow: todo lo que cuelga de `jobs:`, sin una sola linea de comentario. Los
 *  barridos de literales prohibidos van contra esto y NUNCA contra el archivo crudo. */
const CODIGO = bloqueAnidado(YAML, ["jobs"]);

type Paso = { readonly nombre: string; readonly crudo: string; readonly run: string };

/** Los pasos de `jobs.<job>.steps`, con su `run:` YA sin comentarios de shell. FUENTE UNICA de todo
 *  lo que se assertea de L1 y L2: si el YAML deja de tener esa ruta la lista queda VACIA, y
 *  T-042B-0 —que va primero— se pone rojo antes de que cualquier otro test asserte sobre "". */
function pasosDelJob(): readonly Paso[] {
  const steps = bloqueAnidado(YAML, ["jobs", JOB, "steps"]);
  if (steps === "") return [];
  const lineas = steps.split("\n");
  const sangriaItem = sangriaDe(lineas[0] as string);
  const pasos: { nombre: string; crudo: string[]; run: string[] }[] = [];
  let enRun = false;
  for (const l of lineas) {
    const t = l.trim();
    const s = sangriaDe(l);
    if (s === sangriaItem && t.startsWith("- ")) {
      pasos.push({ nombre: "", crudo: [], run: [] });
      enRun = false;
    }
    const actual = pasos[pasos.length - 1];
    if (actual === undefined) continue;
    actual.crudo.push(l);
    // Una clave del paso: `- name: x` y `name: x` son la misma cosa, el `- ` ocupa dos columnas.
    if (s === sangriaItem || s === sangriaItem + 2) {
      enRun = false;
      const clave = /^(?:- )?([a-z-]+):(.*)$/.exec(t);
      if (clave?.[1] === "name") actual.nombre = (clave[2] as string).trim();
      if (clave?.[1] === "run") enRun = true;
      continue;
    }
    if (enRun) actual.run.push(l);
  }
  return pasos.map((p) => ({ nombre: p.nombre, crudo: p.crudo.join("\n"), run: p.run.join("\n") }));
}

const PASOS = pasosDelJob();
const L1 = PASOS[0]?.run ?? "";
const L2 = PASOS[1]?.run ?? "";

/** El bloque `if … ; then … fi` de un `run:` cuya PRIMERA linea matchea `condicion`. Cuenta `if`/`fi`
 *  para no cortar en un anidado. Devuelve "" si no hay ninguno.
 *
 *  🔴 POR QUE EXISTE, y es el corazon de este candado: `expect(L1).toMatch(/exit 1/)` se satisface con
 *  CUALQUIERA de los tres `exit 1` del paso. Medido: cambiar a `exit 0` el `exit 1` del chequeo de
 *  status —o sea, un 401 / 404 / 501 / 503 deja el job en VERDE y el cron pasa a ser decorativo—
 *  dejaba los 15 tests en verde, porque el `exit 1` del secreto vacio seguia escrito unas lineas mas
 *  arriba. Un chequeo puede quedar PRESENTE Y SIN DIENTES, y es exactamente la mutacion que el runbook
 *  predice como tentacion humana ("un job cronicamente rojo entrena a ignorarlo… la decision no es
 *  bajarle el volumen"). Asi que el corte se assertea DENTRO de su condicion, no suelto en el paso. */
function bloqueIf(run: string, condicion: RegExp): string {
  const lineas = run.split("\n");
  for (let i = 0; i < lineas.length; i++) {
    const cabeza = lineas[i] as string;
    if (!/^\s*if\b/.test(cabeza) || !condicion.test(cabeza)) continue;
    let profundidad = 0;
    for (let j = i; j < lineas.length; j++) {
      const t = (lineas[j] as string).trim();
      if (/^if\b/.test(t)) profundidad++;
      if (/^fi\b/.test(t)) {
        profundidad--;
        if (profundidad === 0) return lineas.slice(i, j + 1).join("\n");
      }
    }
    return "";
  }
  return "";
}

/** Las anotaciones `::error` de un `run:` que NO cortan: el primer `exit` que aparece despues de la
 *  anotacion (antes de la siguiente) tiene que ser `exit 1`. Devuelve la lista de las que fallan.
 *
 *  🔴 POR QUE ES EL INVARIANTE Y NO UNA LISTA DE LINEAS. Un `::error` sin corte es el peor de los dos
 *  mundos: pinta la anotacion de rojo en la UI de Actions y DEJA EL PASO EN VERDE, asi que parece que
 *  hay senal y el job aprueba. Este workflow tiene SEIS anotaciones con su `exit 1`, y las seis
 *  sobrevivian al mutante `exit 1 → exit 0` mientras el corte se asserteaba por presencia (medido: las
 *  del status y de los hallazgos por el AR; las dos de los `case` de validacion de forma, que no viven
 *  en ningun `if`, las medi yo en el fix-pack y tambien sobrevivian). El invariante las cubre a las
 *  seis de una vez y NO ENVEJECE: una septima anotacion con su `exit 1` lo deja verde, y sin su
 *  `exit 1` lo pone rojo, sin tocar este archivo. */
function anotacionesSinCorte(run: string): readonly string[] {
  const lineas = run.split("\n");
  const sueltas: string[] = [];
  for (let i = 0; i < lineas.length; i++) {
    if (!(lineas[i] as string).includes("::error")) continue;
    const titulo = /::error title=([^:]*)/.exec(lineas[i] as string)?.[1] ?? `linea ${i}`;
    let corte = "";
    for (let j = i + 1; j < lineas.length; j++) {
      const m = /^\s*exit\s+(\d+)\s*$/.exec(lineas[j] as string);
      if (m) {
        corte = m[1] as string;
        break;
      }
      if ((lineas[j] as string).includes("::error")) break;
    }
    if (corte !== "1") sueltas.push(`${titulo} → ${corte === "" ? "ningun exit" : `exit ${corte}`}`);
  }
  return sueltas;
}

/** Las URLs de un texto. Se comparte entre la asercion y su sonda de calibracion a proposito: si el
 *  patron y la sonda fueran dos copias, la sonda podria seguir cazando algo que la asercion ya no ve. */
const URL_RE = /https?:\/\/[^\s"'`)]+/g;
function urlsDe(texto: string): readonly string[] {
  return [...texto.matchAll(URL_RE)].map((m) => m[0]);
}

/** El `cron:` del YAML es la FUENTE UNICA de la cadencia. No se hardcodea en este archivo a
 *  proposito: si estuviera escrito aca, cambiar el cron y la prosa de forma coordinada pero errada
 *  dejaria este candado en verde comparando dos copias de lo mismo. */
const CRON = YAML.match(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/m)?.[1] ?? "";

/** Las 6 capitalizaciones de la negacion, igual que prepared-claims-guard.static.test.ts: cubrir
 *  solo la minuscula ya dejo pasar `principal NO entro` una vez en este repo. */
const NEGACIONES = ["NUNCA", "Nunca", "nunca", "NO", "No", "no"] as const;
const CLAIM_RE = new RegExp(`principal[^.;]{0,60}?(${NEGACIONES.join("|")})\\s+entr`, "g");

describe("WKH-328B — candado estatico del workflow que invoca reconcile-orphans", () => {
  // ── T-042B-0 · CD-8 — ANTI-VACIO Y ANTI-ESTRUCTURA-ROTA, VA PRIMERO ─────────────────────────
  // Sin esto, borrar el workflow dejaria a los demas assertando sobre la cadena vacia, y varios de
  // ellos (los que exigen NO encontrar algo) pasarian en verde. Un guard que no encuentra nada
  // aplaude.
  it("T-042B-0: el workflow existe, se llama reconcile-orphans y tiene UN job con DOS pasos con cuerpo", () => {
    expect(existsSync(path.join(ROOT, WORKFLOW_REL)), `falta ${WORKFLOW_REL}`).toBe(true);
    expect(YAML.split("\n").length).toBeGreaterThan(25);
    expect(YAML.match(/^name:\s*(.+)$/m)?.[1]?.trim()).toBe("reconcile-orphans");
    // 🔴 ESTRUCTURA, NO TEXTO. `jobs:` tiene que existir como clave de PRIMER NIVEL. Medido: con el
    // barrido de texto anterior, renombrarla a `jobss:` pasaba 15/15 — y un workflow sin clave `jobs`
    // GitHub no lo registra, asi que no corre NUNCA. Es el mismo modo de falla que esta HU vino a
    // arreglar ("el archivo declara la intencion y nadie inscribio el schedule"), pero disfrazado de
    // suite verde.
    expect(JOBS, "no hay una clave `jobs:` de primer nivel con jobs adentro").toHaveLength(1);
    expect(CODIGO.length, "el bloque `jobs:` esta vacio").toBeGreaterThan(500);
    // Los dos pasos, con `- name:` y con cuerpo `run:`.
    expect(PASOS).toHaveLength(2);
    for (const [i, p] of PASOS.entries()) {
      expect(p.nombre, `el paso ${i} no tiene \`- name:\``).not.toBe("");
      expect(p.run.length, `el paso ${i} (${p.nombre}) no tiene cuerpo \`run:\``).toBeGreaterThan(100);
    }
    // ⚠️ CALIBRACION DEL LECTOR, EN LAS DOS DIRECCIONES. Un lector estructural escrito a mano puede
    // fabricar su propio bug, y entonces todo lo que cuelga de el aplaude. Asi que se prueba que
    // encuentre lo que tiene que encontrar Y que devuelva "" cuando la ruta NO esta.
    expect(bloqueAnidado(YAML, ["jobs", JOB, "steps"])).not.toBe("");
    expect(bloqueAnidado(YAML, ["jobs", JOB, "clave-que-no-existe"])).toBe("");
    expect(bloqueAnidado("jobss:\n  reconcile:\n    steps:\n      - name: x\n", ["jobs", "reconcile", "steps"])).toBe("");
    expect(bloqueAnidado("jobs:\n  reconcile:\n    steps:\n      - name: x\n", ["jobs", "reconcile", "steps"])).toBe("      - name: x");
  });

  // ── AC-B1 — hay un productor programado ─────────────────────────────────────────────────────
  it("T-042B-1: el `on:` tiene un `schedule:` con una expresion cron", () => {
    const on = bloqueAnidado(YAML, ["on"]);
    expect(on, "no se encontro el bloque `on:`").not.toBe("");
    expect(on).toMatch(/^\s+schedule:/m);
    // 5 campos separados por espacios: es lo que hace que esto dispare solo.
    expect(CRON.trim().split(/\s+/)).toHaveLength(5);
  });

  it("T-042B-2: el `on:` tiene EXACTAMENTE schedule + workflow_dispatch (ni push ni pull_request)", () => {
    const on = bloqueAnidado(YAML, ["on"]);
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
    // Y llega por `env:`, no interpolado dentro del `run:`. Se mide sobre el paso COMPLETO (el
    // `env:` no vive dentro del `run:`) y sin comentarios.
    expect(PASOS[0]?.crudo ?? "").toMatch(
      /RECONCILE_ADMIN_SECRET:\s*\$\{\{\s*secrets\.RECONCILE_ADMIN_SECRET\s*\}\}/,
    );
  });

  it("T-042B-4: despues de `Bearer ` solo hay una expansion, cero literales", () => {
    // ⚠️ Sobre CODIGO (sin comentarios), no sobre el YAML crudo: medido, un comentario del estilo
    // `# CONTRAEJEMPLO PROHIBIDO: nunca -H "authorization: Bearer sk-live-EJEMPLO"` ponia este test
    // ROJO con el workflow CORRECTO, y escribir ese comentario es la evolucion natural de un archivo
    // cuyo estilo es explicar sus propias prohibiciones. El riesgo no es el rojo: es que alguien con
    // la suite roja y el workflow bien relaje el patron, y el falso rojo se vuelva falso verde.
    const usos = [...CODIGO.matchAll(/Bearer\s+([^"'\n]+)/g)].map((m) => (m[1] as string).trim());
    expect(usos.length, "no aparece ningun `Bearer ` en el codigo del workflow").toBeGreaterThan(0);
    for (const u of usos) {
      // `${VAR}` (env del paso) o `${{ secrets.X }}` (expresion de Actions). Nada mas.
      expect(u, `secreto en texto plano despues de Bearer: ${u}`).toMatch(/^\$\{\{?[^}]*\}?\}$/);
    }
  });

  // ── AC-B3 — el secreto NUNCA en la URL ──────────────────────────────────────────────────────
  it("T-042B-5: la URL del curl es un LITERAL: ni expansion, ni query-string", () => {
    // 🔴 LISTA BLANCA, NO LISTA NEGRA. La version anterior prohibia `secrets.`, `${` y cuatro
    // literales (`?secret=`, `&secret=`, `?token=`, `&token=`). Medido: `?s=$RECONCILE_ADMIN_SECRET`
    // —sin llaves, que en bash expande igual, y con un nombre de parametro que no estaba en la lista de
    // cuatro— pasaba 15/15, y el secreto viajaba en la query-string. GitHub enmascara el secreto en el
    // log de Actions, asi que ese agujero NO se veria por ahi: se veria en los logs de Vercel, del CDN
    // y de cualquier proxy, que es donde no hay candado. Enumerar grafias prohibidas no cierra: lo que
    // cierra es exigir que la URL sea un literal.
    // Y sobre L1 (el `run:` sin comentarios), no sobre el YAML crudo: el docblock del workflow nombra
    // la misma URL para explicar contra que se pega.
    const urls = urlsDe(L1);
    expect(urls, "el paso L1 no tiene ninguna URL").not.toEqual([]);
    for (const u of urls) {
      expect(u, `URL con expansion (shell o Actions): ${u}`).not.toMatch(/\$/);
      expect(u, `URL con query-string, que queda escrita en logs de proxies y del CDN: ${u}`).not.toMatch(/[?&]/);
      expect(u, `URL con expansion de secretos: ${u}`).not.toMatch(/secrets\./);
    }
    // Control de no-vacuidad del patron: si `URL_RE` dejara de capturar la parte peligrosa, los tres
    // `not.toMatch` de arriba pasarian sobre una cadena inofensiva y no dirian nada.
    const sonda = urlsDe('curl "https://ejemplo.test/api/x?s=$RECONCILE_ADMIN_SECRET")');
    expect(sonda).toHaveLength(1);
    expect(sonda[0]).toMatch(/\$/);
    expect(sonda[0]).toMatch(/[?&]/);
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
  it("T-042B-8: L1 valida el secreto vacio, compara el status contra 200, y cada rojo CORTA", () => {
    // ⚠️ L1 ya viene del `run:` estructural y SIN COMENTARIOS, asi que todas las aserciones de este
    // test miran codigo. No es un detalle de estilo, son dos bugs medidos en la primera entrega:
    //   · el comentario que explica este mismo chequeo dice "ANTES del curl", asi que sobre el texto
    //     crudo `curl` aparecia 233 caracteres ANTES del `-z` y la comparacion de orden daba ROJO con
    //     el workflow CORRECTO;
    //   · y en la direccion peligrosa, el comentario `# -o body.json ⇒ …` SATISFACIA por si solo la
    //     asercion del `-o`, asi que borrar el `-o` del curl pasaba 15/15 — y sin `-o` el body entero
    //     (con remittanceId / quoteId / payoutId de remesas REALES) se captura en `code` y el YAML lo
    //     imprime en el `::error` y en el `$GITHUB_STEP_SUMMARY` de un repo PUBLICO.
    expect(L1).toMatch(/set -euo pipefail/);
    expect(L1).toMatch(/-z\s+"\$\{RECONCILE_ADMIN_SECRET\}"/);
    expect(L1.indexOf("-z ")).toBeLessThan(L1.indexOf("curl"));
    expect(L1).toMatch(/%\{http_code\}/);
    expect(L1).toMatch(/!=\s*"200"/);
    expect(L1).toMatch(/-o\s+body\.json/);
    // 🔴 CADA GUARDA CON SU `exit 1` DENTRO DE SU PROPIO `if`, no suelto en el paso. Ver el docblock
    // de `bloqueIf`: con `expect(L1).toMatch(/exit 1/)` bastaba que quedara UNO de los tres, asi que
    // voltear a `exit 0` el del chequeo de status —un 401 en VERDE— pasaba 15/15.
    const guardas = [
      ["el secreto esta vacio", /-z\s+"\$\{RECONCILE_ADMIN_SECRET\}"/],
      ["el curl no completa", /curl/],
      ['el status no es "200"', /!=\s*"200"/],
    ] as const;
    for (const [etiqueta, condicion] of guardas) {
      const bloque = bloqueIf(L1, condicion);
      expect(bloque, `L1 no tiene un \`if\` para: ${etiqueta}`).not.toBe("");
      expect(bloque, `el \`if\` de "${etiqueta}" no corta con exit 1`).toMatch(/^\s*exit 1$/m);
    }
    // ⚠️ CALIBRACION DE `bloqueIf`, EN LAS DOS DIRECCIONES: que encuentre el corte cuando esta DENTRO
    // del bloque, y que NO lo vea cuando esta afuera. Sin esta sonda, un extractor con un bug propio
    // (devolver el `run:` entero, por ejemplo) haria que las tres guardas de arriba aplaudan.
    // (La sonda usa `$x` y no `${x}` a proposito: escrito con llaves, biome lo marca con
    // lint/suspicious/noTemplateCurlyInString. Es la misma razon por la que el literal prohibido de
    // T-042B-10 esta partido en dos. Lo que la sonda ejercita es la condicion, no la sintaxis de la var.)
    expect(bloqueIf('if [ "$x" != "200" ]; then\n  exit 1\nfi', /!=\s*"200"/)).toMatch(/exit 1/);
    expect(bloqueIf('if [ "$x" != "200" ]; then\n  echo hola\nfi\nexit 1', /!=\s*"200"/)).not.toMatch(
      /exit 1/,
    );
    // Y ninguna anotacion queda sin corte: un `::error` sin `exit 1` pinta rojo y aprueba el paso.
    expect(anotacionesSinCorte(L1)).toEqual([]);
    expect(L1, "L1 tiene un `exit 0` explicito: un corte que no corta").not.toMatch(/^\s*exit 0\s*$/m);
  });

  it("T-042B-9: L2 valida la forma, compara los TRES contadores, y cada rojo CORTA", () => {
    // 🔴 Las tres comparaciones tienen que estar EN EL MISMO `if` que corta, no repartidas por el
    // paso: una comparacion que vive fuera del `if` no produce ningun rojo.
    const ifHallazgos = bloqueIf(L2, /-gt 0/);
    expect(ifHallazgos, "L2 no tiene un `if` que compare los contadores").not.toBe("");
    for (const v of ["prepared_total", "failed", "manual_review"]) {
      expect(ifHallazgos, `falta la comparacion de ${v} en el \`if\` de hallazgos`).toMatch(
        new RegExp(`\\$\\{${v}\\}"\\s+-gt 0`),
      );
    }
    // Medido: con `expect(L2).toMatch(/exit 1/)` suelto, voltear este corte a `exit 0` —hay hallazgos
    // y el job sale VERDE— pasaba 15/15, porque los `exit 1` de la validacion de forma seguian
    // escritos. Y es la mutacion que el runbook predice como tentacion humana con L2 cronicamente
    // roja (`docs/runbook-reconcile-orphans.md`: "la decision no es bajarle el volumen").
    expect(ifHallazgos, "el `if` de hallazgos no corta con exit 1").toMatch(/^\s*exit 1$/m);
    // ⚠️ `truncated` es un BOOLEANO (en el endpoint sale de comparar el total contra el largo de la
    // pagina), asi que se valida como true/false. Si se le aplicara la validacion de entero de los
    // otros cuatro campos, este paso quedaria ROJO SIEMPRE.
    expect(L2).toMatch(/true\s*\|\s*false\)/);
    expect(L2).not.toMatch(/\$\{prepared_truncated\}"\s+-gt/);
    // Y el resumen se escribe siempre, en verde y en rojo.
    expect(L2).toMatch(/GITHUB_STEP_SUMMARY/);
    // 🔴 Los otros dos cortes de L2 (la validacion de forma de los cuatro enteros, y la de
    // `truncated`) viven en `case`, no en un `if`, asi que ningun `bloqueIf` los alcanza. Los cubre el
    // invariante de las anotaciones. Medi los dos mutantes en el fix-pack: los dos sobrevivian.
    expect(anotacionesSinCorte(L2)).toEqual([]);
    expect(L2, "L2 tiene un `exit 0` explicito: un corte que no corta").not.toMatch(/^\s*exit 0\s*$/m);
    // ⚠️ CALIBRACION DEL INVARIANTE, EN LAS DOS DIRECCIONES: verde con el par correcto, rojo con el
    // `exit 0` y rojo con la anotacion que no corta nada.
    expect(anotacionesSinCorte('echo "::error title=x::y"\nexit 1')).toEqual([]);
    expect(anotacionesSinCorte('echo "::error title=x::y"\nexit 0')).toHaveLength(1);
    expect(anotacionesSinCorte('echo "::error title=x::y"\necho fin')).toHaveLength(1);
  });

  // ── AC-B6 · CD-10 — los logs de un repo PUBLICO son publicos ────────────────────────────────
  it("T-042B-10: el workflow no ecoa el body ni los IDs de correlacion", () => {
    // El array de items lleva remittanceId / quoteId / payoutId de remesas REALES.
    // ⚠️ Sobre CODIGO (sin comentarios) y no sobre el YAML crudo: medido, un comentario que NOMBRE la
    // prohibicion (`# CONTRAEJEMPLO PROHIBIDO: nunca \`cat body.json\``) ponia este test ROJO con el
    // workflow CORRECTO.
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
      expect(CODIGO.includes(p), `el workflow imprimiria datos de remesas reales: ${p}`).toBe(false);
    }
    // 🔴 Y LA LISTA BLANCA, que es la que cierra el agujero de verdad. Una lista negra no puede
    // enumerar todas las formas de imprimir el array: medido, agregar la linea
    // `echo "detalle: $(jq -c '.preparedOrphans' body.json)"` —que publica remittanceId, quoteId y
    // payoutId de remesas REALES en el log de un repo publico— no matchea ninguno de los nueve
    // literales de arriba y pasaba 15/15. Asi que se assertan las lecturas PERMITIDAS: toda linea del
    // codigo que invoque `jq` tiene que ser una lectura de UNO de los cinco agregados a una variable,
    // y cualquier otra forma es roja.
    const AGREGADOS = [
      ".scanned",
      ".manualReview",
      ".failed",
      ".preparedOrphans.total",
      ".preparedOrphans.truncated",
    ] as const;
    const LECTURA_PERMITIDA = /^\s*[a-z_]+="\$\(jq -r '(\.[A-Za-z.]+)' body\.json\)"$/;
    const lineasJq = CODIGO.split("\n").filter((l) => /\bjq\b/.test(l));
    expect(lineasJq, "el codigo del workflow no invoca `jq` en ninguna linea").not.toEqual([]);
    const leidos: string[] = [];
    for (const l of lineasJq) {
      const m = LECTURA_PERMITIDA.exec(l);
      expect(m, `linea con \`jq\` que no es la lectura de un agregado a una variable: ${l.trim()}`).not.toBeNull();
      leidos.push((m?.[1] as string) ?? l.trim());
    }
    expect([...leidos].sort()).toEqual([...AGREGADOS].sort());
    // ⚠️ LO QUE ESTA LISTA BLANCA NO CUBRE, declarado: cubre `jq`, no cualquier otra forma de leer el
    // archivo. `head body.json`, `cat < body.json` o un `set -x` que ecoe el comando siguen pasando —
    // los dos primeros por no estar en la lista negra de arriba, el tercero porque este candado mira
    // el texto del .yml y no el log que produce.
  });

  // ── AC-B7 — solapamiento y cota de duracion ─────────────────────────────────────────────────
  it("T-042B-11: hay concurrency (sin cancelar la corrida en curso) y un timeout", () => {
    const c = bloqueAnidado(YAML, ["concurrency"]);
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
