// Tests ESTÁTICOS — assertNoEvmResidue (WKH-320 / AC-3.3, CD-16). Lee el FUENTE del guard, no lo
// ejecuta. Patrón: contracts/idl/escrow-idl.hash.test.ts (readFileSync + path.resolve(cwd)).
//
// POR QUÉ ESTE ARCHIVO EXISTE, que es la parte que no se puede omitir:
// El guard tiene que fallar en el BUNDLE DEL CLIENTE. Next inlinea `process.env.NEXT_PUBLIC_X` ahí
// SÓLO si aparece como MEMBER EXPRESSION LITERAL (acceso estático). Un acceso dinámico
// —`process.env[k]` dentro de un for— NO se inlinea: en el browser da `undefined` siempre, el guard
// nunca tira, y NO ES UN GUARD. Ese refactor es tentador (6 ifs parecen repetición) y, crucialmente,
// **pasa entero evm-residue-guard.test.ts**, porque en Node `process.env` sí es un objeto real.
// O sea: el test de comportamiento NO puede distinguir el guard bueno del inútil. Sólo el fuente.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const GUARD_SRC = path.resolve(process.cwd(), "src/composition/evm-residue-guard.ts");
const raw = readFileSync(GUARD_SRC, "utf8");

/** El invariante es sobre el CÓDIGO, no sobre la prosa. Sin esto el test se auto-dispara: el propio
 *  guard EXPLICA en un comentario por qué `process.env[k]` está prohibido, y esa explicación no debe
 *  volverse impublicable. Strippear también hace el check MÁS fuerte en la otra dirección: las 6
 *  member expressions tienen que estar en código ejecutable, no mencionadas en un comentario. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const source = stripComments(raw);

// Las 6 member expressions EXACTAS que Next tiene que poder inlinear.
const REQUIRED_MEMBER_EXPRESSIONS = [
  "process.env.NEXT_PUBLIC_VM",
  "process.env.NEXT_PUBLIC_EIP3009_ENABLED",
  "process.env.NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS",
  "process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS",
  "process.env.NEXT_PUBLIC_CHAIN_ID",
  "process.env.NEXT_PUBLIC_REOWN_PROJECT_ID",
] as const;

describe("evm-residue-guard — fuente (CD-16: acceso estático, no dinámico)", () => {
  // Guard del propio stripper: si un cambio de formato lo dejara devolviendo vacío, los `not.toContain`
  // pasarían por ausencia y este archivo se volvería un test que no puede fallar.
  it("el fuente strippeado sigue conteniendo el cuerpo del guard (el stripper no lo vació)", () => {
    expect(source).toContain("export function assertNoEvmResidue()");
    expect(source).toContain("evm_config_residue");
  });

  it("CD-16: el fuente NO contiene un acceso dinámico a process.env", () => {
    // `process.env[` cubre `process.env[k]`, `process.env[name]` y `process.env["X"]`: las tres
    // formas que Next NO inlinea.
    expect(source).not.toContain("process.env[");
  });

  it("CD-16: el fuente contiene las 6 member expressions literales", () => {
    for (const expr of REQUIRED_MEMBER_EXPRESSIONS) {
      expect(source).toContain(expr);
    }
  });

  it("el fuente no arma nombres de env por concatenación ni template (tampoco se inlinean)", () => {
    expect(source).not.toContain("process.env`");
    expect(source).not.toMatch(/process\.env\s*\[/);
  });
});
