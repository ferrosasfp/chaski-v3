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
// El arreglo NO fue borrar la frase: es el INVARIANTE (d) de más abajo, que sí cierra ese camino
// mecánicamente, con su alcance exacto escrito en el punto 5 de acá abajo.
//
// ⚠️ QUÉ NO CUBRE ESTE ARCHIVO (CD-14), declarado y no disfrazado:
//   1. NO mira el VALOR escrito. Que la signature sea la correcta lo cubren
//      `confirm-and-send.money-path.test.ts` y `confirm-and-send.reorder.test.ts`, que ya existen.
//   2. NO evalúa el flujo en ejecución: es un check sobre el texto del fuente. Un escritor construido
//      en runtime (por ejemplo `state[campo] = x` con `campo` calculado) no lo ve.
//   3. NO cubre un `principalTx` introducido por un snapshot FABRICADO A MANO en `localStorage` y
//      rehidratado. Ese residual es preexistente, es el mismo modelo de confianza que ya gobierna toda
//      la pantalla de historial y el `TxProof` del recibo (`flow.tsx:3185-3186`), y no es una
//      regresión de esta HU: ahí el atacante y la víctima son la misma persona.
//   4. NO mira los `*.test.ts(x)`: los tests fabrican estados a propósito y deben poder seguir
//      haciéndolo. El invariante es sobre el código que corre en producción.
//   5. El invariante (d) —el que cierra el camino del rehydrate— vigila la LISTA DE ARCHIVOS que
//      llaman `Remittance.rehydrate(`, no lo que cada uno hace con el estado. O sea: caza el sync
//      nuevo, en un archivo nuevo, que es la forma que tomó el escenario medido. NO caza un
//      `rehydrate` agregado DENTRO de alguno de los tres archivos ya listados (`persistence.ts`,
//      `flow.tsx`, `fakes.ts`). Ese hueco queda declarado acá y no disfrazado de cobertura.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "app", "scripts"];
const SCAN_EXTS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "doc", "migrations"]);

/** El invariante es sobre el CÓDIGO, no sobre la prosa: este mismo archivo, y los docblocks de
 *  `flow-vm.ts`, NOMBRAN `principalTx` y `markPrincipalIn` muchas veces. Sin strippear, el candado se
 *  auto-dispararía con sus propias explicaciones y habría que aflojarlo hasta volverlo inútil. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

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

/** Los fuentes de PRODUCCIÓN: todo `.ts`/`.tsx` bajo src/, app/ y scripts/ que no sea un test. */
const FUENTES: { rel: string; code: string }[] = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)))
  .map((abs) => ({ rel: path.relative(ROOT, abs), code: stripComments(readFileSync(abs, "utf8")) }))
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
 *  (`state["principalTx"] = x`). El control de abajo planta las cuatro formas, porque el agujero era
 *  invisible a su propio control: éste sólo probaba las dos SIN comillas.
 *
 *  ⚠️ EL PATRÓN SE ESCRIBE UNA SOLA VEZ, en `ESCRITURA_SRC`, y de ahí salen las DOS regex que este
 *  archivo usa (la de `test` y la de contar, que necesita `/g` fresco por lo de `lastIndex` que está
 *  explicado abajo). Escribirlo dos veces es cómo un arreglo se aplica a una y no a la otra: hasta
 *  este commit T-W9(a-bis) llevaba su propia copia literal, y la comilla se le habría escapado. */
const ESCRITURA_SRC = "principalTx[\"']?\\s*\\]?\\s*[:=]";
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

const REMITTANCE = "src/domain/remittance.ts";
const CALL_SITE = "src/application/use-cases/confirm-and-send.ts";

/** Los ÚNICOS archivos de producción que reconstruyen un `Remittance` desde un estado suelto, con el
 *  motivo de cada uno escrito a mano leyendo el código, no volcando la salida del escáner:
 *   · `persistence.ts`: el repo, que es de dónde tiene que salir un estado rehidratado.
 *   · `flow.tsx`: LECTURA. Rehidrata para preguntar `isQuoteStillValid` y NO guarda nada.
 *   · `fakes.ts`: test-support. No es un `*.test.ts` y por eso entra al barrido, pero no corre en
 *     producción; está acá para que el conjunto sea el medido y no uno con un agujero sin nombre. */
const REHIDRATADORES = [
  "src/infrastructure/persistence.ts",
  "src/presentation/flow.tsx",
  "src/test-support/fakes.ts",
].sort();

describe("WKH-352 · AC-7: `principalTx` tiene un solo escritor, y corre después del `ok:true`", () => {
  // 🔴 EL ASSERT DE CONTROL DE LA DETECCIÓN. Sin esto, una regex rota (o un `stripComments` que
  // devolviera vacío) dejaría los tres invariantes verdes sobre CUALQUIER fuente, que es exactamente el
  // modo de fallo que `evm-residue-guard.static.test.ts:38-43` documenta: un guard que no puede fallar.
  it("control: la detección encuentra un escritor PLANTADO y no se traga el stripper", () => {
    // Un escritor plantado, en las CUATRO formas que el candado busca. Las dos de abajo son las que
    // faltaban: con la regex anterior (`/principalTx\s*[:=]/`) daban `false` y el candado se saltaba
    // con una clave entre comillas. Son parte del control, no un extra.
    expect(ESCRITURA.test('const s = { ...prev, principalTx: "fabricada" };')).toBe(true);
    expect(ESCRITURA.test("state.principalTx = firmaInventada;")).toBe(true);
    expect(ESCRITURA.test('const M: Record<string, string> = { "principalTx": "fabricada" };')).toBe(true);
    expect(ESCRITURA.test("state[\"principalTx\"] = firmaInventada;")).toBe(true);
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
    // El stripper no vació los fuentes que este archivo mira.
    const remittance = FUENTES.find((f) => f.rel === REMITTANCE);
    expect(remittance?.code).toContain("markPrincipalIn");
    expect(FUENTES.find((f) => f.rel === CALL_SITE)?.code).toContain("settle(");
    // Y el barrido efectivamente barrió: si `FUENTES` quedara vacío, todo lo de abajo pasaría por
    // ausencia. El piso es holgado a propósito: mide que el walk anduvo, no el tamaño del repo.
    expect(FUENTES.length).toBeGreaterThan(50);
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
  // pasa. Y no dice nada del VALOR rehidratado.
  it("T-W9(d): `Remittance.rehydrate` se llama sólo desde los archivos que tienen su motivo escrito", () => {
    const rehidratadores = FUENTES.filter((f) => REHIDRATA.test(f.code)).map((f) => f.rel).sort();
    expect(rehidratadores).toEqual(REHIDRATADORES);
  });
});
