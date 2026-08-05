// Tests — canarios ESTÁTICOS sobre quién escribe el `status` de una fila del ledger (WKH-325).
// Patrón: src/composition/no-evm-surface.test.ts.
//
// POR QUÉ EXISTEN. La clasificación de AC-1 se apoya en una inferencia: si una fila está en
// 'submitted', es porque el proveedor confirmó `asset_deposited`. Esa inferencia es correcta HOY
// porque `recordWebhookOutcome` es el ÚNICO escritor de 'submitted' en producción. No es una
// propiedad del tipo: es un hecho del árbol, y un hecho del árbol se degrada sin que nada se ponga
// rojo. Estos dos tests son lo que hace que el caso OBVIO de degradarlo cueste un rojo — el caso
// obvio y nada más. El barrido es TEXTUAL: un alias de tres líneas lo esquiva, y no prueba ausencia.
// El límite está enunciado entero, sin eufemismos, en el comentario de T-1d (más abajo); este
// encabezado NO lo hereda por estar arriba, así que tampoco promete más que él.
//
// LA EXCLUSIÓN ES POR RUTA EXACTA del propio archivo, NUNCA por un glob `*.test.ts`: excluir por glob
// cegaría el barrido justo donde más código hay. Se saltean `*.test.*` y `test-support/` porque un
// escritor de test NO es un escritor de producción, que es lo que estos canarios vigilan.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "app", "scripts"];
const SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "doc", "migrations", "test-support"]);

// Ruta EXACTA de este archivo (contiene los identificadores que cuenta), no un glob.
const SELF = path.resolve(ROOT, "src/infrastructure/persistence/webhook-outcome-writers.static.test.ts");

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
const SOURCES = FILES.map((f) => ({ rel: path.relative(ROOT, f), text: readFileSync(f, "utf8") }));

/** Call-sites de `<obj>.<method>(` en archivos de PRODUCCIÓN. La declaración del port y la
 *  implementación no matchean (no llevan el punto delante), que es exactamente lo que se quiere:
 *  vigila quién LLAMA, no quién define. */
function callSites(method: string): Array<{ rel: string; index: number }> {
  const re = new RegExp(`\\.${method}\\s*\\(`, "g");
  const hits: Array<{ rel: string; index: number }> = [];
  for (const { rel, text } of SOURCES) {
    for (const m of text.matchAll(re)) hits.push({ rel, index: m.index ?? 0 });
  }
  return hits;
}

describe("WKH-325 — canarios de los escritores de `status` del ledger", () => {
  it("el barrido encuentra archivos de producción (si diera 0, ningún test de acá podría fallar nunca)", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES).not.toContain(SELF);
    // Y realmente excluye los tests: si colara alguno, los conteos de abajo medirían otra cosa.
    expect(FILES.some((f) => isTestFile(f))).toBe(false);
  });

  // T-1c — si esto se pone rojo, apareció un segundo escritor de 'submitted' y la inferencia de AC-1
  // hay que re-examinarla.
  it("T-1c: `recordPayoutOutcome` sigue SIN call-sites de producción y `recordWebhookOutcome` tiene EXACTAMENTE uno", () => {
    expect(callSites("recordPayoutOutcome").map((h) => h.rel)).toEqual([]);
    const webhook = callSites("recordWebhookOutcome");
    expect(webhook.map((h) => h.rel)).toEqual(["app/api/webhooks/transfi/route.ts"]);
  });

  // T-1d — el GEMELO VIVO del residuo anterior. `markOutcome` acepta un `status:
  // SettlementLedgerStatus` y lo escribe crudo: el TIPO permite 'submitted'. Hoy su único caller pasa
  // el literal "manual_review", así que la inferencia de AC-1 se sostiene — por convención, no por
  // construcción.
  //
  // LÍMITE DE ESTE GUARD, declarado: es TEXTUAL. Caza el caso obvio (el literal cambiado por una
  // variable, un "submitted" escrito a mano, un segundo call-site). NO caza un `status` pasado por
  // spread (`{...opts}`), ni una llamada indirecta por alias (`const m = ledger.markOutcome`), ni un
  // `const S: SettlementLedgerStatus = "submitted"` referenciado por nombre.
  // ESTE TEST FUERZA A QUE UNA PERSONA MIRE; NO PRUEBA AUSENCIA. El cierre definitivo es angostar el
  // tipo del port (`status: "manual_review" | "settled" | "failed"`), que es una decisión de contrato
  // y está fuera del alcance de esta HU.
  it("T-1d: `markOutcome` tiene EXACTAMENTE un call-site de producción y le pasa un literal que NO es 'submitted'", () => {
    const hits = callSites("markOutcome");
    expect(hits.map((h) => h.rel)).toEqual(["app/api/admin/reconcile-orphans/route.ts"]);

    const { text } = SOURCES.find((s) => s.rel === hits[0]?.rel) ?? { text: "" };
    // El bloque de la llamada: desde `.markOutcome(` hasta el primer `});`.
    const start = text.indexOf(".markOutcome(");
    const end = text.indexOf("});", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = text.slice(start, end);

    const literal = /status:\s*"([a-z_]+)"/.exec(block);
    // Presencia: tiene que HABER un literal. Si alguien lo cambia por una variable, esto es null y el
    // test se cae acá — que es el punto.
    expect(literal?.[1]).toBeTypeOf("string");
    expect(literal?.[1]).not.toBe("submitted");
  });
});
