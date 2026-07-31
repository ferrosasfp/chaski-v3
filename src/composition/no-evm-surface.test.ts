// Tests — invariante anti-regresión repo-wide (WKH-320 / AC-1, AC-3.4, AC-6). Recorre el árbol
// fuente y falla si vuelve a aparecer superficie EVM. Patrón: contracts/idl/escrow-idl.hash.test.ts.
//
// Este es el control que sostiene el objetivo de la HU DESPUÉS de la HU: que alguien clone el repo y
// sólo encuentre tecnología Solana. La poda lo logra una vez; esto lo sostiene.
//
// TRES TRAMPAS, y cada una está resuelta a propósito:
//
// 1. EL TEST SE AUTO-DISPARA. Este archivo contiene los literales que prohíbe. La exclusión es por
//    RUTA EXACTA del propio archivo, NUNCA por glob `*.test.ts` — eso cegaría toda la suite y el
//    invariante dejaría de vigilar justo donde más código hay. Precedente en este repo: commit
//    78a278b, "saca los literales que disparaban el propio gate".
//
// 2. EL PATRÓN DE LA REGEX NO ES EL PATRÓN DE UNA ADDRESS. Se busca el TEXTO del validador escrito a
//    mano (`0x[0-9a-fA-F]{40}`), NO addresses que matcheen ese validador. Buscar addresses pondría
//    rojo a supabase-settlement-ledger.test.ts (`:76`, `:982`, `:1059`), que son fixtures LEGÍTIMOS
//    de filas EVM ya escritas en Postgres y que CD-11 protege. "Arreglar" ese rojo borrando los
//    fixtures sería violar CD-10 y CD-11 en el mismo movimiento.
//
// 3. LOS COMENTARIOS NO SON IMPORTS. Los patrones son import-shaped (`from "viem"`, `isAddress(`)
//    justamente para no matchear prosa: varios archivos Solana dicen "NUNCA un validador tipo
//    isAddress" como rationale, y eso es disciplina documentada, no superficie EVM.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "app", "scripts", "contracts"];
const SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "doc", "migrations"]);

// TRAMPA 1 — ruta EXACTA de este archivo, no un glob.
const SELF = path.resolve(ROOT, "src/composition/no-evm-surface.test.ts");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (SCAN_EXTS.has(path.extname(entry))) {
      if (path.resolve(full) !== SELF) out.push(full);
    }
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

/** Cada patrón es import-shaped o literal-shaped: matchea CÓDIGO, no prosa (trampa 3).
 *  `allow` = rutas EXACTAS (relativas a la raíz) donde el literal es legítimo. Se usa UNA sola vez y
 *  por una razón estructural: el guard de residuo TIENE que nombrar las envs que prohíbe, y sus dos
 *  tests tienen que nombrarlas para probar que las nombra. Es la única excepción, es enumerada, y
 *  NUNCA es un glob. */
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string; allow?: readonly string[] }> = [
  { pattern: /from\s+["']viem["']/, why: "import de viem" },
  { pattern: /from\s+["']viem\//, why: "import de un submódulo de viem (viem/chains, viem/utils…)" },
  { pattern: /require\(\s*["']viem["']\s*\)/, why: "require de viem" },
  { pattern: /from\s+["']wagmi["']/, why: "import de wagmi" },
  { pattern: /from\s+["']@walletconnect\/ethereum-provider["']/, why: "import del provider EVM de WalletConnect" },
  {
    pattern: /\bNEXT_PUBLIC_VM\b/,
    why: "el interruptor de VM: volvió a haber más de una VM",
    allow: [
      "src/composition/evm-residue-guard.ts", // el guard que la caza: nombrarla ES su trabajo
      "src/composition/evm-residue-guard.test.ts",
      "src/composition/evm-residue-guard.static.test.ts",
      // Ídem: prueba que el guard, ya montado como primera línea de createContainer(), la nombra.
      "src/composition/container.test.ts",
    ],
  },
  { pattern: /\bisAddress\s*\(/, why: "validador de address hexadecimal" },
  { pattern: /\bisAddressEqual\s*\(/, why: "comparador de address hexadecimal" },
  // TRAMPA 2 — el TEXTO de la regex, no una address que la matchee.
  { pattern: /0x\[0-9a-fA-F\]\{40\}/, why: "regex de address EVM escrita a mano" },
  { pattern: /0x\[a-fA-F0-9\]\{40\}/, why: "regex de address EVM escrita a mano" },
];

describe("AC-1/AC-3.4 — cero superficie EVM en el árbol fuente (WKH-320)", () => {
  it("el barrido encuentra archivos (si diera 0, este test no podría fallar nunca)", () => {
    expect(FILES.length).toBeGreaterThan(50);
    // Y se excluye a SÍ MISMO, no a toda la suite: los otros .test siguen vigilados.
    expect(FILES).not.toContain(SELF);
    expect(FILES.some((f) => f.endsWith(".test.ts"))).toBe(true);
  });

  for (const { pattern, why, allow } of FORBIDDEN) {
    it(`ningún archivo contiene ${pattern} (${why})`, () => {
      const allowed = new Set(allow ?? []);
      const hits = FILES.map((f) => path.relative(ROOT, f))
        .filter((rel) => !allowed.has(rel))
        .filter((rel) => pattern.test(readFileSync(path.join(ROOT, rel), "utf8")));
      expect(hits).toEqual([]);
    });
  }

  it("las rutas del allowlist EXISTEN (un allowlist con rutas muertas es una excepción sin dueño)", () => {
    for (const { allow } of FORBIDDEN) {
      for (const rel of allow ?? []) expect(existsSync(path.join(ROOT, rel))).toBe(true);
    }
  });
});

describe("AC-1 — package.json sin dependencias EVM (WKH-320)", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  for (const dep of ["viem", "wagmi", "@walletconnect/ethereum-provider"]) {
    it(`${dep} no está en dependencies ni devDependencies`, () => {
      expect(pkg.dependencies?.[dep]).toBeUndefined();
      expect(pkg.devDependencies?.[dep]).toBeUndefined();
    });
  }
});

// T12 — AC-6: la ruta no responde 404 por un handler que devuelve 404; NO EXISTE. Es la diferencia
// entre "apagado" y "no está", y es la que un revisor que clona el repo puede verificar con `ls`.
describe("AC-6 — las rutas EVM no existen en el árbol (WKH-320)", () => {
  for (const dir of [
    "app/api/settle/principal",
    "app/api/a2a/payout/submit",
    "src/infrastructure/wallet.ts",
    "src/infrastructure/settlement/onchain-verifier.ts",
    "src/infrastructure/settlement/attestation.ts",
    "src/infrastructure/settlement/attestation-store.ts",
    "src/infrastructure/auth/pop-nonce-store.ts",
    "src/infrastructure/settlement/http-settlement-gateway.ts",
    "src/infrastructure/settlement/http-payout-prepare-gateway.ts",
  ]) {
    it(`${dir} no está en el árbol`, () => {
      expect(existsSync(path.join(ROOT, dir))).toBe(false);
    });
  }

  it("el camino Solana que SÍ vive sigue en su lugar", () => {
    expect(existsSync(path.join(ROOT, "app/api/settle/solana-sponsor/route.ts"))).toBe(true);
    expect(existsSync(path.join(ROOT, "app/api/payout/prepare/route.ts"))).toBe(true);
    expect(existsSync(path.join(ROOT, "contracts/idl/escrow-idl.hash.test.ts"))).toBe(true);
  });
});
