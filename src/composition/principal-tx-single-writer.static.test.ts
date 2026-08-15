// Tests ESTÁTICOS — `principalTx` tiene UN SOLO ESCRITOR (WKH-352 / AC-7, T-W9). Lee el FUENTE del
// árbol, no lo ejecuta. Patrón: `evm-residue-guard.static.test.ts` (readFileSync +
// path.resolve(cwd) + stripComments + assert de control del propio stripper).
//
// POR QUÉ ESTE ARCHIVO EXISTE, que es la parte que no se puede omitir:
// WKH-352 hace que la pantalla de historial le diga a la persona "Tu depósito entró: de eso quedó la
// firma de la transacción, confirmada en la cadena" cuando `rem.principalTx != null`. Esa frase es
// sostenible SÓLO porque hoy hay un único escritor del campo, y ese escritor corre después del
// `ok:true` del settle, o sea después de una transacción ya broadcasteada y confirmada.
//
// 🔵 DÓNDE VIVE LA PALABRA "CONFIRMADA", Y POR QUÉ ESTE ARCHIVO NO LA CUBRE (AR r2 · BLQ-MED-2). El
// `ok:true` no lo decide este repo: el facilitator sólo lo devuelve tras un
// `connection.confirmTransaction(signature, 'confirmed')` con `conf.value.err` nulo, y si no confirma
// contesta `ok:false` con `SPONSOR_BROADCAST_EXPIRED` o `SPONSOR_BROADCAST_FAILED`. Está en OTRO
// repo: `wasiai-facilitator` → `src/methods/solana-sponsor/broadcast.ts:339-342`, leído sobre su
// commit `8177b6e`. O sea que la confirmación EXISTE y la frase de la pantalla no afirma de más.
// ⚠️ EL RESIDUO, dicho como es: eso es una lectura del código de otro servicio, con fecha. Lo que
// estos invariantes candan es el ESCRITOR (uno solo) y su POSICIÓN respecto del gate; el significado
// del `ok:true` del otro lado del cable no lo mide NADA de acá. Si mañana el facilitator contestara
// antes de confirmar, o bajara el commitment a `processed`, la pantalla seguiría diciendo "confirmada
// en la cadena" y esta suite seguiría verde. No hay contrato verificable entre los dos repos.
//
// Esa propiedad es una FOTO, y las fotos envejecen solas: nadie que agregue mañana un segundo
// escritor va a leer el docblock de `flow-vm.ts`. Sin este candado, el día que alguien escriba
// `principalTx` desde otro lado la pantalla empieza a afirmar "tu plata entró" sobre plata que puede
// no haber entrado, y NINGÚN test se pone rojo. El daño no es un bug de render: es una afirmación
// falsa sobre el dinero de alguien.
//
// 🔴 LO QUE ESTE PÁRRAFO DECÍA DE MÁS, Y CÓMO SE MIDIÓ (AR · BLQ-BAJO-2). Acá arriba estaba escrito
// que el candado existía para el día que alguien escribiera `principalTx` "desde otro lado —un
// backfill, UN REHYDRATE DE UN WEBHOOK, un 'lo seteo optimista'—". Lo del webhook era FALSO y se
// plantó el escenario para verlo: un `src/application/use-cases/mutante-webhook-sync.ts` con
// `JSON.parse(payload)`, `{ ...local.snapshot, ...remoto }` y `repo.save(Remittance.rehydrate(...))`.
// Compila (`tsc --noEmit` exit 0), escribe `principalTx` de verdad y desde la RED, y los invariantes
// (a)/(a-bis)/(b)/(c) daban `5 passed`: el texto `principalTx` no aparece nunca. El residual de más
// abajo tampoco lo tapaba, porque habla de un snapshot fabricado a mano en `localStorage` por la
// misma persona, y acá el dato viene del servidor y es código de producción nuevo. Atribuirle a un
// candado una cobertura que no tiene es el hallazgo de WKH-351, y estaba pasando otra vez.
// El arreglo NO fue borrar la frase: son los INVARIANTES (d) y (d-bis) de más abajo, con su alcance
// exacto en el punto 5 de acá abajo.
//
// 🔴 Y ACÁ DECÍA QUE (d) "SÍ CIERRA ESE CAMINO MECÁNICAMENTE", QUE ERA FALSO Y SE MIDIÓ (AR r2 ·
// BLQ-BAJO-3). (d) mira la LISTA DE ARCHIVOS. El AR agregó UNA línea a un archivo YA listado,
// `export function fromState(s: RemittanceState): Remittance { return Remittance.rehydrate(s); }` al
// final de `persistence.ts`, y con eso re-creó el escenario del webhook en un archivo nuevo sin
// escribir jamás las palabras `rehydrate` ni `principalTx`: `tsc --noEmit` exit 0, `6 passed`, suite
// verde. O sea que el wrapper de una línea no es un uso "local" como decía el punto 5: reabre el
// camino para TODO archivo futuro. Se replantó el escenario completo antes de tocar nada y dio lo
// mismo que el AR reportó. El arreglo es (d-bis), que cuenta las rehidrataciones de cada archivo de
// la lista y mata ESE mutante; lo que (d-bis) NO cierra está escrito en su propio comentario y en el
// punto 5, y esta vez con el input que lo demuestra en vez de un adverbio.
//
// ⚠️ QUÉ NO CUBRE ESTE ARCHIVO (CD-14), declarado y no disfrazado:
//   1. NO mira el VALOR escrito. Que la signature sea la correcta lo cubren
//      `confirm-and-send.money-path.test.ts` y `confirm-and-send.reorder.test.ts`, que ya existen.
//   2. NO evalúa el flujo en ejecución: es un check sobre el texto del fuente. Un escritor construido
//      en runtime (por ejemplo `state[campo] = x` con `campo` calculado) no lo ve.
//   3. NO cubre un `principalTx` introducido por un snapshot FABRICADO A MANO en `localStorage` y
//      rehidratado. Ese residual es preexistente, es el mismo modelo de confianza que ya gobierna toda
//      la pantalla de historial y el `TxProof` del recibo (`flow.tsx:3349-3350`), y no es una
//      regresión de esta HU: ahí el atacante y la víctima son la misma persona.
//   4. NO mira los `*.test.ts(x)`: los tests fabrican estados a propósito y deben poder seguir
//      haciéndolo. El invariante es sobre el código que corre en producción.
//   5. Los invariantes del rehydrate NO cierran el camino entero, y acá va el alcance exacto de cada
//      uno, con el input que lo demuestra:
//        · (d) vigila la LISTA DE ARCHIVOS que llaman `Remittance.rehydrate(`. Caza el sync nuevo en
//          un archivo nuevo, que es la forma que tomó el primer escenario medido.
//        · (d-bis) vigila CUÁNTAS veces rehidrata cada archivo de esa lista. Caza el wrapper
//          AGREGADO, que es la forma que tomó el segundo (una línea en `persistence.ts` y el camino
//          reabierto para todo archivo futuro). MEDIDO: `persistence.ts` pasa de 1 a 2 y sólo
//          (d-bis) se pone rojo.
//        · LO QUE SIGUE ABIERTO, y también está MEDIDO, no supuesto: mover la llamada que YA existe
//          adentro de un helper exportado, sin agregar ninguna. Se plantó (`get` llamando a un
//          `fromState` exportado que envuelve esa misma línea): la cuenta sigue en 1, `tsc` exit 0 y
//          `7 passed`. O sea que el camino queda abierto igual y ningún candado de acá lo ve. Cerrarlo
//          pide mirar quién importa qué desde esos tres archivos, y no se hizo: `flow.tsx` ya
//          rehidrata adentro de un componente exportado, así que un candado por "export" necesitaría
//          una excepción el primer día. Queda declarado, y no disfrazado de cobertura.
//   6. El stripper de comentarios NO entiende los LITERALES DE REGEX (CR · MNR-5). Un `/['"]/` en un
//      fuente de producción le abre una comilla que no existe, y ese tramo queda SIN strippear: es el
//      modo de fallo viejo, no uno nuevo que borre código. El alcance exacto, la razón de que el error
//      se corte en el `\n` y el mutante que lo mide están en el docblock de `escanear`. El control
//      "ninguna comilla queda abierta" mide el árbol de HOY; lo que no ve es una desincronización que
//      abre y cierra en el medio de un archivo.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "app", "scripts"];
const SCAN_EXTS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "doc", "migrations"]);

/** El invariante es sobre el CÓDIGO, no sobre la prosa: este mismo archivo, y los docblocks de
 *  `flow-vm.ts`, NOMBRAN `principalTx` y `markPrincipalIn` muchas veces. Sin strippear, el candado se
 *  auto-dispararía con sus propias explicaciones y habría que aflojarlo hasta volverlo inútil.
 *
 *  🔴 Y EL STRIPPER SACABA MENOS DE LO QUE ESE PÁRRAFO AFIRMABA (CR · MNR-5). Era
 *  `.replace(/^\s*\/\/.*$/gm, "")`, que saca los `//` A PRINCIPIO DE LÍNEA y NADA MÁS: un comentario de
 *  FIN DE LÍNEA sobrevivía entero. MEDIDO sobre las funciones puras, antes de tocar nada:
 *  `stripComments('if (rem.principalTx != null) return true; // ojo: principalTx = la prueba')` devolvía
 *  la línea COMPLETA y `ESCRITURA.test(...)` daba `true`. Y medido también de punta a punta: con
 *  `// ojo: principalTx = la prueba del deposito` pegado al final de una LECTURA de verdad, la de
 *  (`principalTx`, `../presentation/flow-vm.ts:1205`), T-W9(a) denunciaba a `flow-vm.ts` como
 *  escritor. Por qué eso es grave lo escribe este mismo archivo más arriba: un candado que se dispara
 *  con las lecturas es uno que alguien va a aflojar hasta volverlo inútil.
 *
 *  POR QUÉ UN RECORRIDO Y NO UNA REGEX MÁS ANCHA. El arreglo ingenuo (`.replace(/\/\/.*$/gm, "")`) parte
 *  cualquier `//` que viva ADENTRO de un string. MEDIDO: `const u = "https://rpc/x"; // nota` queda como
 *  `const u = "https:`, o sea el stripper borrando código. Y no es un caso inventado para el ejemplo:
 *  el control de (`refundTx`, `:346`) de este mismo archivo lleva un `//` adentro de un string. Por eso
 *  esto recorre el fuente carácter por carácter llevando el estado de comillas (simple, doble y
 *  backtick, con `\` de escape) y corta sólo los `//` que quedan FUERA de una.
 *
 *  ⚠️ QUÉ NO MODELA, y está medido, no supuesto: los LITERALES DE REGEX. Un `/['"]/` abre una comilla
 *  que no existe. El daño está ACOTADO a esa línea a propósito (una comilla que no es backtick se cierra
 *  en el `\n`, porque en JS un string de comillas no cruza la línea), y la dirección del error es la
 *  segura: ese tramo queda SIN strippear, que es el modo de fallo VIEJO, no uno nuevo que borre código.
 *  Lo que puede correr hasta el final del archivo es un backtick impar, y para eso está el control
 *  "ninguna comilla queda abierta" de abajo, que hoy recorre los fuentes de producción y da CERO. Lo que
 *  ese control NO ve es una desincronización que abre y cierra en el medio del archivo. */
type Escaneo = { code: string; comillaAbierta: boolean };
function escanear(src: string): Escaneo {
  let out = "";
  let i = 0;
  let comilla: string | null = null;
  while (i < src.length) {
    const c = src[i] as string;
    const sig = src[i + 1];
    if (comilla !== null) {
      if (c === "\\") {
        out += c + (sig ?? "");
        i += 2;
        continue;
      }
      out += c;
      // Un string de comillas simples o dobles NO cruza la línea: si llegamos al `\n` sin cerrar, lo que
      // se abrió no era un string (un literal de regex, típicamente) y el error se corta acá.
      if (c === comilla || (c === "\n" && comilla !== "`")) comilla = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      comilla = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && sig === "*") {
      const fin = src.indexOf("*/", i + 2);
      i = fin === -1 ? src.length : fin + 2;
      continue;
    }
    if (c === "/" && sig === "/") {
      const fin = src.indexOf("\n", i);
      i = fin === -1 ? src.length : fin;
      continue;
    }
    out += c;
    i += 1;
  }
  return { code: out, comillaAbierta: comilla !== null };
}
const stripComments = (src: string): string => escanear(src).code;

function esTest(rel: string): boolean {
  return /\.test\.tsx?$/.test(rel);
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, out);
    } else if (SCAN_EXTS.has(path.extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

/** Los fuentes de PRODUCCIÓN: todo `.ts`/`.tsx` bajo src/, app/ y scripts/ que no sea un test. El
 *  `crudo` se guarda para el control del stripper: sin el original no hay contra qué medirlo. */
const FUENTES: { rel: string; code: string; crudo: string }[] = SCAN_DIRS.flatMap((d) =>
  walk(path.join(ROOT, d)),
)
  .map((abs) => {
    const crudo = readFileSync(abs, "utf8");
    return { rel: path.relative(ROOT, abs), code: stripComments(crudo), crudo };
  })
  .filter((f) => !esTest(f.rel));

/** Escribir el campo: `principalTx:` en un objeto (o en la declaración del tipo) y `principalTx =`.
 *  Las dos formas con las que este repo escribe estado.
 *
 *  ⚠️ LA COMILLA OPCIONAL NO ES ADORNO, Y ESTE CANDADO SE SALTEABA SIN ELLA. La primera versión era
 *  `/principalTx\s*[:=]/`, y una clave ENTRE COMILLAS no matchea, porque `"` no es `\s`. Este repo
 *  escribe claves entre comillas seguido (`GRUPO_POR_DESENLACE`, `../presentation/flow-vm.ts:1354`),
 *  así que no era una forma exótica. MEDIDO: con `const MUTANTE2: Record<string, string> = {
 *  "principalTx": "fabricada" };` agregado a `container.ts`, la versión sin comilla daba
 *  `5 passed`; con esta da rojo en T-W9(a). El `\]?` cierra la misma puerta por acceso indexado
 *  (`state["principalTx"] = x`). El control de abajo planta las formas que el patrón busca, porque el
 *  agujero era invisible a su propio control: éste sólo probaba las dos SIN comillas.
 *
 *  🔴 Y LA CLASE DE COMILLAS DECÍA `["']`, QUE ES DOS DE LAS TRES QUE TIENE JS (AR r2 · BLQ-BAJO-2).
 *  El backtick faltaba y no es exótico: es una clave computada válida. MEDIDO, plantando en
 *  `container.ts` la línea `export const MUTANTE_BT: Record<string, string> = { [`principalTx`]: "fabricada" };`
 *  ⇒ `tsc --noEmit` exit 0 y `6 passed`. Con el backtick en la clase, ese mismo mutante da rojo en
 *  T-W9(a). Lo mismo con `state[`principalTx`] = sig;`. El control de abajo suma esa quinta forma.
 *
 *  🔴 Y `Object.defineProperty(state, "principalTx", {...})` TAMBIÉN EVADÍA, porque después de la
 *  comilla viene una coma y no un `:` ni un `=`. Se decidió CUBRIRLO y no declararlo, con un alternante
 *  propio (`defineProperty(...principalTx`) en vez de aflojar el primero para que acepte una coma:
 *  aceptar la coma haría matchear cualquier `"principalTx"` en una lista de nombres de campo, que es
 *  LECTURA, y un candado que se dispara con las lecturas es uno que alguien va a aflojar hasta
 *  volverlo inútil. Medido: no hay ningún `defineProperty` en los fuentes de producción de este árbol
 *  (los cuatro que existen están en `*.test.tsx`, que este barrido no mira), así que el alternante no
 *  introduce falsos positivos hoy.
 *
 *  🔴 Y ESE ALTERNANTE CUBRÍA MENOS DE LO QUE ESTE DOCBLOCK AFIRMABA (AR r3 · MNR-2). Decía "se decidió
 *  CUBRIRLO", y el tramo entre el paréntesis y la comilla era `[^)]*`, que NO CRUZA UN `)`: sólo veía
 *  el caso en que el primer argumento no es una llamada. MEDIDO con `node -e`, sobre el patrón viejo:
 *  `Object.defineProperty(state, "principalTx", { value: x });` ⇒ `true`, y
 *  `Object.defineProperty(getState(), "principalTx", { value: x });` ⇒ `false`. O sea un escritor real
 *  que el candado no veía, dos líneas después de invocar la regla de que cada alternante necesita su
 *  control. Hoy ese tramo es `(?:[^();{]|\([^)]*\))*`: cualquier carácter salvo `)`, `;` y `{`, MÁS un
 *  grupo entre paréntesis completo, que es lo que deja pasar `getState()` o `repo.getState(id)`. El
 *  `;` y el `{` son el freno, no un adorno: sin ellos el alternante cruzaría hasta el descriptor o
 *  hasta la sentencia siguiente, y cualquier `defineProperty` cerca de la palabra sería un falso
 *  positivo. El control de (`refundTx`, `:346`) planta exactamente ese caso y sigue dando `false`. Esa
 *  cita decía `:236`, y en esa línea no hay ningún assert: hay un comentario sobre los backticks. Ahora
 *  va ANCLADA, o sea que la vigila `citas-ancladas.test.ts`. El `(` se saca de
 *  la clase para que las dos ramas de la alternancia no puedan matchear el mismo carácter: si pudieran,
 *  una entrada larga sin cierre haría backtracking exponencial.
 *
 *  ⚠️ LO QUE SIGUE AFUERA, MEDIDO Y NO SUPUESTO: DOS niveles de anidamiento
 *  (`Object.defineProperty(get(state(x)), "principalTx", ...)` ⇒ `false` también con el patrón nuevo,
 *  y hay un control abajo que lo fija para que la afirmación no envejezca), `Reflect.set(state,
 *  "principalTx", x)`, un `Object.assign(state, JSON.parse(x))` y cualquier nombre de campo calculado
 *  en runtime. El punto 2 de "QUÉ NO CUBRE" ya lo dice en general, y esto lo hace concreto: el candado
 *  cubre las formas que ENUMERA, y la lista no es "todas las maneras de escribir una propiedad en JS".
 *
 *  ⚠️ EL PATRÓN SE ESCRIBE UNA SOLA VEZ, en `ESCRITURA_SRC`, y de ahí salen las DOS regex que este
 *  archivo usa (la de `test` y la de contar, que necesita `/g` fresco por lo de `lastIndex` que está
 *  explicado abajo). Escribirlo dos veces es cómo un arreglo se aplica a una y no a la otra: hasta
 *  este commit T-W9(a-bis) llevaba su propia copia literal, y la comilla se le habría escapado. */
const ESCRITURA_SRC = "principalTx[\"'`]?\\s*\\]?\\s*[:=]|defineProperty\\s*\\((?:[^();{]|\\([^)]*\\))*[\"'`]principalTx";
const ESCRITURA = new RegExp(ESCRITURA_SRC);
const todasLasEscrituras = (code: string): RegExpMatchArray | null =>
  code.match(new RegExp(ESCRITURA_SRC, "g"));
/** Llamar al escritor: un `.markPrincipalIn(`. El punto excluye la DECLARACIÓN del método.
 *  ⚠️ SIN `/g` A PROPÓSITO: `RegExp.test` sobre una regex GLOBAL es STATEFUL (avanza `lastIndex`), así
 *  que reusarla en un `.filter()` sobre muchos archivos se saltea matches y el candado deja pasar
 *  justo al intruso. Para contar hay una regex aparte, creada fresca en cada uso. */
const LLAMADA = /\.markPrincipalIn\s*\(/;
const todasLasLlamadas = (code: string): RegExpMatchArray | null =>
  code.match(/\.markPrincipalIn\s*\(/g);

/** Reconstruir un `Remittance` desde un `RemittanceState` cualquiera. El punto excluye la
 *  DECLARACIÓN (`static rehydrate(`, `../domain/remittance.ts:304`). Es la OTRA forma de escribir
 *  `principalTx` sin nombrarlo: `{ ...local.snapshot, ...remoto }` y a rehidratar. */
const REHIDRATA = /\.rehydrate\s*\(/;
/** ⚠️ FRESCA EN CADA USO, por lo del `lastIndex` explicado tres comentarios más arriba. */
const todasLasRehidrataciones = (code: string): RegExpMatchArray | null =>
  code.match(/\.rehydrate\s*\(/g);

const REMITTANCE = "src/domain/remittance.ts";
const CALL_SITE = "src/application/use-cases/confirm-and-send.ts";

/** Los ÚNICOS archivos de producción que reconstruyen un `Remittance` desde un estado suelto, con el
 *  motivo de cada uno escrito a mano leyendo el código, no volcando la salida del escáner:
 *   · `persistence.ts`: el repo, que es de dónde tiene que salir un estado rehidratado.
 *   · `flow.tsx`: LECTURA. Rehidrata para preguntar `isQuoteStillValid` y NO guarda nada.
 *   · `fakes.ts`: test-support. No es un `*.test.ts` y por eso entra al barrido, pero no corre en
 *     producción; está acá para que el conjunto sea el medido y no uno con un agujero sin nombre.
 *
 *  ⚠️ EL NÚMERO ES PARTE DE LA LISTA, y no es decoración (AR r2 · BLQ-BAJO-3): cada archivo declara
 *  CUÁNTAS veces rehidrata. Una lista de nombres sola deja entrar una línea nueva en un archivo ya
 *  listado, que es exactamente el escape que el AR midió. Los tres valores son 1, leídos a mano:
 *  `persistence.ts:134` (`get`), `flow.tsx:234` (el resume) y `fakes.ts:112` (el repo en memoria).
 *  Si una de estas cuentas sube legítimamente, hay que subirla ACÁ y escribir por qué, que es el
 *  precio de que no se pueda subir en silencio. */
const REHIDRATACIONES_POR_ARCHIVO: Record<string, number> = {
  "src/infrastructure/persistence.ts": 1,
  "src/presentation/flow.tsx": 1,
  "src/test-support/fakes.ts": 1,
};
/** DERIVADA, no una segunda lista escrita a mano: dos listas que dicen lo mismo son dos listas que
 *  algún día dicen cosas distintas. Es la misma lección que `ESCRITURA_SRC` tiene arriba. */
const REHIDRATADORES = Object.keys(REHIDRATACIONES_POR_ARCHIVO).sort();

describe("WKH-352 · AC-7: `principalTx` tiene un solo escritor, y corre después del `ok:true`", () => {
  // 🔴 EL ASSERT DE CONTROL DE LA DETECCIÓN. Sin esto, una regex rota (o un `stripComments` que
  // devolviera vacío) dejaría los tres invariantes verdes sobre CUALQUIER fuente, que es exactamente el
  // modo de fallo que `evm-residue-guard.static.test.ts:38-43` documenta: un guard que no puede fallar.
  it("control: la detección encuentra un escritor PLANTADO y no se traga el stripper", () => {
    // Un escritor plantado, en CADA forma que el candado busca: una por forma, sin excepción, porque
    // una forma sin control es una que puede morir en silencio. LA REGLA, ESCRITA ACÁ Y NO CITADA
    // (AR r3 · MNR-1): SI EL PATRÓN TIENE N FORMAS, EL CONTROL NECESITA N. Antes esto decía "la regla
    // está escrita en `auto-blindaje.md:139`", y esa cita no la podía seguir nadie: `doc/` está
    // gitignoreado (`.gitignore:36`) y `git ls-files doc` da 0, así que desde un clone limpio ese
    // archivo NO EXISTE; encima el número estaba corrido (la frase vive en la línea 140, no en la
    // 139). Una regla que el lector no puede leer no es una regla, y este archivo ya la pagó tres
    // veces: primero la comilla, después el backtick, después el `)` del argumento que es una llamada.
    // El conteo NO se escribe acá: era "las CUATRO formas" y quedó viejo el día que el
    // patrón ganó alternantes, o sea la misma clase de cifra que envejece sola que el repo persigue.
    // Las de comilla y las de backtick daban `false` con las versiones anteriores del patrón, y cada
    // una se plantó de verdad en `container.ts` para verlo. Son parte del control, no un extra.
    expect(ESCRITURA.test('const s = { ...prev, principalTx: "fabricada" };')).toBe(true);
    expect(ESCRITURA.test("state.principalTx = firmaInventada;")).toBe(true);
    expect(ESCRITURA.test('const M: Record<string, string> = { "principalTx": "fabricada" };')).toBe(true);
    expect(ESCRITURA.test("state[\"principalTx\"] = firmaInventada;")).toBe(true);
    // Y las DOS del backtick (AR r2 · BLQ-BAJO-2), que es la tercera comilla de JS y la que faltaba.
    // Las dos se plantaron de verdad en `container.ts` antes de arreglar el patrón: `tsc` exit 0 y
    // `6 passed`, o sea un escritor real que el candado no veía.
    expect(ESCRITURA.test("const M: Record<string, string> = { [`principalTx`]: \"fabricada\" };")).toBe(true);
    expect(ESCRITURA.test("state[`principalTx`] = firmaInventada;")).toBe(true);
    // Y la forma sin `:` ni `=` en ningún lado, que evadía por una coma. Tiene alternante propio.
    expect(ESCRITURA.test('Object.defineProperty(state, "principalTx", { value: firmaInventada });')).toBe(true);
    expect(ESCRITURA.test("Object.defineProperty(state, `principalTx`, { value: x });")).toBe(true);
    // Y las dos con el primer argumento SIENDO UNA LLAMADA, que es lo que el `[^)]*` viejo no cruzaba
    // (AR r3 · MNR-2). Las dos daban `false` con el patrón anterior: eran escritores reales invisibles.
    expect(ESCRITURA.test('Object.defineProperty(getState(), "principalTx", { value: x });')).toBe(true);
    expect(ESCRITURA.test("Object.defineProperty(repo.getState(id), `principalTx`, { value: x });")).toBe(true);
    // 🔴 Y EL LÍMITE, FIJADO COMO CONTROL Y NO COMO PROSA: DOS niveles de anidamiento siguen evadiendo.
    // Este assert existe para que la frase "cubre un nivel" no pueda envejecer en silencio: si alguien
    // amplía el patrón, esto se pone rojo y hay que venir a reescribir el docblock, que es el punto.
    expect(ESCRITURA.test('Object.defineProperty(get(state(x)), "principalTx", { value: x });')).toBe(false);
    // Una llamada plantada al escritor.
    expect('otro.markPrincipalIn("x", now);').toMatch(LLAMADA);
    // Y una rehidratación plantada, que es el camino de (d). Va con el `await repo.save(...)` alrededor
    // porque es la forma exacta que tomó el escenario del AR.
    expect("await repo.save(Remittance.rehydrate(merged));").toMatch(REHIDRATA);
    // La DECLARACIÓN no cuenta: sin el punto, `static rehydrate(` no es una llamada. Si esto se
    // pusiera rojo, (d) estaría acusando a `remittance.ts` de llamarse a sí mismo.
    expect(REHIDRATA.test("  static rehydrate(state: RemittanceState): Remittance {")).toBe(false);
    // Y la detección NO matchea una simple LECTURA, que es lo que hace `flow-vm.ts` y debe seguir
    // pudiendo hacer. Si esto se pusiera rojo, el candado estaría prohibiendo leer el campo. Va
    // también la lectura por índice, que es la que el `\]?` de arriba podría haber roto.
    expect(ESCRITURA.test("if (rem.principalTx != null) return true;")).toBe(false);
    expect(ESCRITURA.test('if (rem["principalTx"] != null) return true;')).toBe(false);
    expect(ESCRITURA.test("if (rem[`principalTx`] != null) return true;")).toBe(false);
    // Y el alternante de `defineProperty` no se dispara con OTRA propiedad de la misma llamada: si lo
    // hiciera, cualquier `defineProperty` cerca de la palabra sería un falso positivo.
    expect(ESCRITURA.test('Object.defineProperty(state, "refundTx", { value: x }); // principalTx')).toBe(false);
    // 🔴 EL CONTROL DEL STRIPPER, QUE ES EL QUE FALTABA (CR · MNR-5). Un comentario de FIN DE LÍNEA con
    // `principalTx` adentro NO puede disparar el candado: la línea de abajo es una LECTURA. Antes de
    // este commit los dos asserts daban al revés, y con el comentario pegado a una línea real de
    // `flow-vm.ts` el invariante (a) denunciaba a ese archivo como escritor.
    const LECTURA_COMENTADA = "if (rem.principalTx != null) return true; // ojo: principalTx = la prueba";
    expect(stripComments(LECTURA_COMENTADA)).toBe("if (rem.principalTx != null) return true; ");
    expect(ESCRITURA.test(stripComments(LECTURA_COMENTADA))).toBe(false);
    // Y el otro lado, que es lo que rompe el arreglo por regex ancha: el `//` que vive ADENTRO de un
    // string se QUEDA. Si esto se pusiera rojo, el stripper estaría borrando código, no comentarios.
    const URL_COMENTADA = 'const u = "https://rpc.devnet/x"; // nota';
    expect(stripComments(URL_COMENTADA)).toBe('const u = "https://rpc.devnet/x"; ');
    // Y lo que el stripper ya hacía sigue haciéndolo: comentario de línea entera y bloque.
    expect(stripComments("  // principalTx: fabricada\nconst x = 1;")).toBe("  \nconst x = 1;");
    expect(stripComments("/* principalTx = x */\nconst y = 2;")).toBe("\nconst y = 2;");
    // El stripper no vació los fuentes que este archivo mira.
    const remittance = FUENTES.find((f) => f.rel === REMITTANCE);
    expect(remittance?.code).toContain("markPrincipalIn");
    expect(FUENTES.find((f) => f.rel === CALL_SITE)?.code).toContain("settle(");
    // Y el barrido efectivamente barrió: si `FUENTES` quedara vacío, todo lo de abajo pasaría por
    // ausencia. El piso es holgado a propósito: mide que el walk anduvo, no el tamaño del repo.
    expect(FUENTES.length).toBeGreaterThan(50);
  });

  // 🔴 EL CONTROL DE QUE EL MODELO DE COMILLAS DEL STRIPPER LE SIRVA A ESTE ÁRBOL (CR · MNR-5). El
  // recorrido no entiende literales de regex: un `/['"]/` en un fuente de producción le abre una comilla
  // que no existe. Ese error se corta en el `\n` (una comilla que no es backtick no cruza la línea), y
  // el único que puede correr hasta el final del archivo es un BACKTICK impar. Esto lo mide en vez de
  // prometerlo. MEDIDO hoy: 0 de los fuentes de producción quedan con una comilla abierta.
  // MUTANTE MEDIDO: un `const RE = /`/;` en `src/composition/container.ts` ⇒ rojo acá, y sólo acá.
  // ⚠️ LO QUE NO VE: una desincronización que abre y cierra en el MEDIO del archivo. Eso queda declarado
  // en el docblock de `escanear`, con la dirección del error (deja sin strippear, no borra código).
  it("control: ningún fuente de producción deja una comilla abierta al terminar el recorrido", () => {
    const desincronizados = FUENTES.filter((f) => escanear(f.crudo).comillaAbierta).map((f) => f.rel);
    expect(desincronizados).toEqual([]);
  });

  // 🔴 INVARIANTE (a) — UN SOLO ARCHIVO DE PRODUCCIÓN ESCRIBE EL CAMPO.
  // MUTANTE MEDIDO: plantar `const MUTANTE = { principalTx: "fabricada" };` en
  // `src/composition/container.ts`. Medido: este test, y sólo éste, se pone rojo (la lista de
  // escritores pasa a tener 2 elementos y deja de ser exactamente `remittance.ts`).
  it("T-W9(a): `principalTx` sólo se escribe en `src/domain/remittance.ts`", () => {
    const escritores = FUENTES.filter((f) => ESCRITURA.test(f.code)).map((f) => f.rel).sort();
    expect(escritores).toEqual([REMITTANCE]);
  });

  // 🔴 INVARIANTE (a-bis) — Y DENTRO DE ESE ARCHIVO, EL ESCRITOR ESTÁ EN `markPrincipalIn`.
  // Que el campo se escriba en un solo ARCHIVO no alcanza: `remittance.ts` tiene otras transiciones, y
  // meter `principalTx` en el patch de cualquiera de ellas rompería la premisa igual.
  // MUTANTE MEDIDO: mover `{ principalTx: tx }` al patch de `markPayoutSubmitted` ⇒ rojo.
  it("T-W9(a-bis): el escritor vive en el cuerpo de `markPrincipalIn`, no en otra transición", () => {
    const code = FUENTES.find((f) => f.rel === REMITTANCE)?.code ?? "";
    const desde = code.indexOf("markPrincipalIn(");
    const hasta = code.indexOf("markPayoutSubmitted(");
    expect(desde).toBeGreaterThan(-1);
    expect(hasta).toBeGreaterThan(desde);
    const cuerpo = code.slice(desde, hasta);
    expect(cuerpo).toContain("principalTx: tx");
    // Las ÚNICAS otras menciones en write-position del archivo son la declaración del campo en el tipo
    // y su inicialización en `null` al crear la remesa. Cualquier tercera es un escritor nuevo.
    const fuera = todasLasEscrituras(code.slice(0, desde) + code.slice(hasta)) ?? [];
    expect(fuera).toHaveLength(2);
  });

  // 🔴 INVARIANTE (b) — UN SOLO CALL-SITE DE PRODUCCIÓN.
  // MUTANTE MEDIDO: plantar un `r.markPrincipalIn("x", "now")` en
  // `src/application/use-cases/track-remittance.ts`. Medido: este test, y sólo éste, se pone rojo (la
  // lista de llamadores pasa a 2). Que el escritor sea único no sirve si cualquiera puede invocarlo
  // desde donde quiera, sin el gate del settle.
  it("T-W9(b): `markPrincipalIn` se llama desde UN solo sitio de producción", () => {
    const llamadores = FUENTES.filter((f) => LLAMADA.test(f.code)).map((f) => f.rel).sort();
    expect(llamadores).toEqual([CALL_SITE]);
    const code = FUENTES.find((f) => f.rel === CALL_SITE)?.code ?? "";
    expect(todasLasLlamadas(code) ?? []).toHaveLength(1);
  });

  // 🔴 INVARIANTE (c) — ESE CALL-SITE ESTÁ DESPUÉS DEL GATE, NO ANTES.
  // Es lo que convierte a `principalTx` en evidencia y no en una intención: sólo se escribe si el
  // settle contestó `ok:true`, y las dos salidas de fallo (`catch` y `!res.ok`) retornan antes.
  // MUTANTE MEDIDO: MOVER la llamada arriba del `if (!res.ok)` (moverla, no duplicarla: si se duplica
  // cae T-W9(b) y no se aprende nada de éste). Medido con el movimiento real: sólo este test se pone
  // rojo, "expected 6058 to be greater than 6114".
  it("T-W9(c): el call-site corre DESPUÉS del `if (!res.ok)` del settle", () => {
    const code = FUENTES.find((f) => f.rel === CALL_SITE)?.code ?? "";
    const gate = code.indexOf("if (!res.ok)");
    const llamada = code.search(/\.markPrincipalIn\s*\(/);
    expect(gate).toBeGreaterThan(-1);
    expect(llamada).toBeGreaterThan(gate);
    // Y el `catch` del settle también corta antes: la otra puerta por la que se podría llegar a la
    // llamada sin un `ok:true`.
    const catchDelSettle = code.indexOf("failAfterBroadcast");
    expect(catchDelSettle).toBeGreaterThan(-1);
    expect(llamada).toBeGreaterThan(catchDelSettle);
  });

  // 🔴 INVARIANTE (d) — LA OTRA FORMA DE ESCRIBIR EL CAMPO SIN NOMBRARLO (AR · BLQ-BAJO-2).
  //
  // (a) y (b) buscan el TEXTO `principalTx` y el TEXTO `markPrincipalIn`. Hay un camino que escribe el
  // campo sin que ninguno de los dos aparezca: tomar un `RemittanceState` entero de otra fuente y
  // rehidratarlo. `{ ...local.snapshot, ...remoto }` copia `principalTx` con todo lo demás, y
  // `Remittance.rehydrate` no pasa por ningún guard de transición. Ese estado sale por
  // (`snapshot`, `../domain/remittance.ts:308`) igual que cualquier otro, y la pantalla le cree.
  //
  // MEDIDO, no supuesto: se plantó `src/application/use-cases/mutante-webhook-sync.ts` con
  // `JSON.parse(payload)` + spread + `repo.save(Remittance.rehydrate(merged))`. Compila (`tsc
  // --noEmit` exit 0) y con (a)/(a-bis)/(b)/(c) solos daba `5 passed`. Con (d): rojo acá, y sólo acá.
  //
  // POR QUÉ UNA LISTA Y NO "UN SOLO SITIO": son TRES y los tres son legítimos, cada uno por su motivo,
  // escrito arriba en `REHIDRATADORES`. Una lista con el motivo de cada entrada es verificable; un
  // "un solo sitio" sería falso y habría que aflojarlo el primer día.
  //
  // ⚠️ QUÉ NO CUBRE (y está también en el punto 5 del docblock de arriba): mira la LISTA DE ARCHIVOS,
  // no lo que cada uno hace. Un `rehydrate` nuevo DENTRO de `persistence.ts`, `flow.tsx` o `fakes.ts`
  // pasa POR ACÁ: ése lo caza (d-bis), que es el `it` de abajo, y por eso este comentario ya no dice
  // que el camino queda cerrado. Y ninguno de los dos dice nada del VALOR rehidratado.
  it("T-W9(d): `Remittance.rehydrate` se llama sólo desde los archivos que tienen su motivo escrito", () => {
    const rehidratadores = FUENTES.filter((f) => REHIDRATA.test(f.code)).map((f) => f.rel).sort();
    expect(rehidratadores).toEqual(REHIDRATADORES);
  });

  // 🔴 INVARIANTE (d-bis) — Y CADA UNO DE ESOS TRES REHIDRATA LAS VECES QUE DECLARA (AR r2 · BLQ-BAJO-3).
  //
  // POR QUÉ EXISTE, medido y no supuesto. (d) sola vigila la LISTA DE ARCHIVOS, y el AR la evadió con
  // UNA línea agregada a un archivo YA listado: `export function fromState(s: RemittanceState):
  // Remittance { return Remittance.rehydrate(s); }` al final de `persistence.ts`. Con eso, cualquier
  // archivo nuevo del árbol puede rehidratar un estado que vino de la red sin escribir nunca
  // `rehydrate` ni `principalTx`. Se re-plantó el escenario completo (un `mutante-webhook-sync2.ts`
  // con `JSON.parse`, spread y `repo.save(fromState(merged))`): `tsc --noEmit` exit 0 y `6 passed`.
  // O sea que el docblock que decía que (d) "cierra ese camino mecánicamente" era FALSO, y era la
  // misma clase de over-claim que el AR ya había marcado una vez en este mismo archivo.
  //
  // MUTANTE MEDIDO: ese mismo `fromState` en `persistence.ts`. Aplicado y medido: este test, y sólo
  // éste, se pone rojo (`persistence.ts` pasa de 1 a 2 rehidrataciones). (d) sigue verde, porque el
  // archivo ya estaba en la lista: ésa es justamente la razón de ser de (d-bis).
  //
  // ⚠️ QUÉ NO CUBRE, dicho como es y no como quisiéramos que fuera. Esto caza la rehidratación
  // AGREGADA, no la EXPORTADA: si alguien MUEVE la única llamada que ya existe adentro de un helper
  // exportado (el `get` de `persistence.ts` pasando a llamar a un `fromState` que envuelve esa misma
  // línea), la cuenta sigue en 1, el candado sigue verde, y el camino queda igual de abierto para todo
  // archivo futuro. Cerrar ESO pide mirar quién importa qué desde esos tres archivos, y no se hizo:
  // `flow.tsx` ya rehidrata adentro de un componente exportado, así que un candado por "export" pediría
  // una excepción el primer día y sería uno de los que se aflojan hasta no medir nada. Queda declarado.
  it("T-W9(d-bis): cada rehidratador llama a `.rehydrate(` exactamente las veces que declara", () => {
    const cuentas = Object.fromEntries(
      REHIDRATADORES.map((rel) => [
        rel,
        (todasLasRehidrataciones(FUENTES.find((f) => f.rel === rel)?.code ?? "") ?? []).length,
      ]),
    );
    expect(cuentas).toEqual(REHIDRATACIONES_POR_ARCHIVO);
  });
});
