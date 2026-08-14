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
// Esa propiedad es una FOTO, y las fotos envejecen solas: nadie que agregue mañana un segundo
// escritor va a leer el docblock de `flow-vm.ts`. Sin este candado, el día que alguien escriba
// `principalTx` desde otro lado —un backfill, un rehydrate de un webhook, un "lo seteo optimista y
// después lo confirmo"— la pantalla empieza a afirmar "tu plata entró" sobre plata que puede no haber
// entrado, y NINGÚN test se pone rojo. El daño no es un bug de render: es una afirmación falsa sobre
// el dinero de alguien.
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
 *  Las dos formas con las que este repo escribe estado. */
const ESCRITURA = /principalTx\s*[:=]/;
/** Llamar al escritor: un `.markPrincipalIn(`. El punto excluye la DECLARACIÓN del método.
 *  ⚠️ SIN `/g` A PROPÓSITO: `RegExp.test` sobre una regex GLOBAL es STATEFUL (avanza `lastIndex`), así
 *  que reusarla en un `.filter()` sobre muchos archivos se saltea matches y el candado deja pasar
 *  justo al intruso. Para contar hay una regex aparte, creada fresca en cada uso. */
const LLAMADA = /\.markPrincipalIn\s*\(/;
const todasLasLlamadas = (code: string): RegExpMatchArray | null =>
  code.match(/\.markPrincipalIn\s*\(/g);

const REMITTANCE = "src/domain/remittance.ts";
const CALL_SITE = "src/application/use-cases/confirm-and-send.ts";

describe("WKH-352 · AC-7: `principalTx` tiene un solo escritor, y corre después del `ok:true`", () => {
  // 🔴 EL ASSERT DE CONTROL DE LA DETECCIÓN. Sin esto, una regex rota (o un `stripComments` que
  // devolviera vacío) dejaría los tres invariantes verdes sobre CUALQUIER fuente, que es exactamente el
  // modo de fallo que `evm-residue-guard.static.test.ts:38-43` documenta: un guard que no puede fallar.
  it("control: la detección encuentra un escritor PLANTADO y no se traga el stripper", () => {
    // Un escritor plantado, en las dos formas que el candado busca.
    expect(ESCRITURA.test('const s = { ...prev, principalTx: "fabricada" };')).toBe(true);
    expect(ESCRITURA.test("state.principalTx = firmaInventada;")).toBe(true);
    // Una llamada plantada al escritor.
    expect('otro.markPrincipalIn("x", now);').toMatch(LLAMADA);
    // Y la detección NO matchea una simple LECTURA, que es lo que hace `flow-vm.ts` y debe seguir
    // pudiendo hacer. Si esto se pusiera rojo, el candado estaría prohibiendo leer el campo.
    expect(ESCRITURA.test("if (rem.principalTx != null) return true;")).toBe(false);
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
    const fuera = (code.slice(0, desde) + code.slice(hasta)).match(/principalTx\s*[:=]/g) ?? [];
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
});
