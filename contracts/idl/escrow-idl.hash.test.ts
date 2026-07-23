import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { escrowIdl } from "../../src/infrastructure/solana/escrow-idl"; // SIN extensión (bundler)
import { canonicalSha256 } from "./canonical-hash";

// Pinneada y verificada en F2 sobre los 3 IDL reales (todos canonicalizan igual, address DR5G).
// Re-pinneo SOLO con SDD explícito, jamás por drift silencioso (ver CONTRACT-VERSIONS.md).
const ESCROW_IDL_SHA256 = "aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71";

describe("escrow IDL — hash canónico (WKH-227 / AC-2, AC-3)", () => {
  // AC-2 (siempre corre): si alguien edita escrow-idl.ts a mano sin re-pinnear → ROJO.
  it("AC-2: canonicalSha256(escrowIdl) == constante pinneada", () => {
    expect(canonicalSha256(escrowIdl)).toBe(ESCROW_IDL_SHA256);
  });

  // AC-3 (best-effort, skip limpio si el sibling no existe en el workspace).
  const SIBLING = path.resolve(process.cwd(), "../solana-programs/target/idl/escrow.json");
  (existsSync(SIBLING) ? it : it.skip)("AC-3: coincide con solana-programs (sibling)", () => {
    const sibling: unknown = JSON.parse(readFileSync(SIBLING, "utf8")); // solo LECTURA (CD-2)
    expect(canonicalSha256(sibling)).toBe(ESCROW_IDL_SHA256);
  });
});
