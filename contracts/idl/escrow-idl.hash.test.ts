import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { escrowIdl } from "../../src/infrastructure/solana/escrow-idl"; // SIN extensión (bundler)
import { canonicalSha256 } from "./canonical-hash";

// Pinneada y verificada en F2 sobre los 3 IDL reales (todos canonicalizan igual, address DR5G).
// Re-pinneo SOLO con SDD explícito, jamás por drift silencioso (ver CONTRACT-VERSIONS.md).
// RE-PIN 2026-08-01 — ventana de custodia. Motivo, medido con un diff instrucción por instrucción
// contra el IDL nuevo: (a) `close` suma la cuenta `sender_ata` (el barrido del vault) y (b) entran
// los errores 6006 DeadlineTooSoon, 6007 DeadlineTooFar y 6008 ReleaseWindowClosed. NINGÚN código
// existente se renumeró ni se borró, y `deposit`, `refund`, `release`, `register_escrow` y
// `deregister_escrow` conservan discriminador, cuentas y args, así que el re-pin es compatible en
// las dos direcciones para todo lo que este repo realmente invoca (`close` no lo invoca nadie acá).
// EscrowStatus sigue con 3 variantes, o sea que el decode de la cuenta no se mueve.
// Valor idéntico al pineado en wasiai-facilitator (src/chains/escrow-idl.hash.test.ts).
// Anterior: 4bcc34a997396d360ab996ea5bb1015ffdd8a1d357d3f4b4cffcbfe8ea98d12b.
// RE-PIN 2026-07-28 — HU-SOL-20 / R2b (SDD solana-programs/doc/sdd/002-escrow-remittance-id-recovery
// /sdd.md §4.10 DT-9). Motivo: R1 agregó register_escrow + deregister_escrow, la cuenta EscrowIndex
// y el error 6005. Anterior: aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71.
const ESCROW_IDL_SHA256 = "fb64c937dbdab7a58045e663a85724808c4539707fedbdf244e11a28dbe5c071";

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

  // T-R2b-3 / AC-R2b-2 — el program id vive SOLO en el IDL (CD-15): un upgrade in-place NO lo cambia.
  // Incondicional a propósito: asertea el IDL vendoreado, que siempre existe (nunca con existsSync).
  it("AC-R2b-2: el address del IDL sigue siendo el program id DR5G (upgrade in-place)", () => {
    expect(escrowIdl.address).toBe("DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x");
  });

  // T-R2b-4 / AC-R2b-3 + AC-R2b-4 — R3 pinea las cuentas de CR-1 POR POSICIÓN: si el orden cambia y
  // nadie lo nota, la tx se rechaza en producción y el depósito no se broadcastea. Incondicional.
  it("AC-R2b-3/4: deposit y refund intactos (disc + orden de cuentas) y register_escrow con sus 4 cuentas en orden", () => {
    type IxView = { name: string; discriminator: number[]; accounts: ReadonlyArray<{ name: string }> };
    const ix = escrowIdl.instructions as unknown as ReadonlyArray<IxView>;
    const accountsOf = (name: string): string[] | undefined =>
      ix.find((i) => i.name === name)?.accounts.map((a) => a.name);
    const discOf = (name: string): number[] | undefined => ix.find((i) => i.name === name)?.discriminator;

    // Las 6 instrucciones post-R1 (4 viejas + 2 nuevas), en el orden alfabético que emite Anchor.
    expect(ix.map((i) => i.name)).toEqual([
      "close",
      "deposit",
      "deregister_escrow",
      "refund",
      "register_escrow",
      "release",
    ]);

    // NO-REGRESIÓN (CD-8): deposit conserva discriminador y sus 8 cuentas posicionales.
    expect(discOf("deposit")).toEqual([242, 35, 198, 137, 82, 225, 242, 182]);
    expect(accountsOf("deposit")).toEqual([
      "sender",
      "mint",
      "escrow_state",
      "vault",
      "sender_ata",
      "token_program",
      "associated_token_program",
      "system_program",
    ]);

    // NO-REGRESIÓN: refund (el camino que R0 acaba de tocar) conserva discriminador y sus 7 cuentas.
    expect(discOf("refund")).toEqual([2, 96, 183, 251, 63, 208, 46, 46]);
    expect(accountsOf("refund")).toEqual([
      "sender",
      "mint",
      "escrow_state",
      "vault",
      "sender_ata",
      "token_program",
      "associated_token_program",
    ]);

    // AC-R2b-4: register_escrow tal como lo fijó R1 — habilitador de R4.
    expect(discOf("register_escrow")).toEqual([200, 17, 194, 170, 224, 144, 127, 166]);
    expect(accountsOf("register_escrow")).toEqual([
      "sender",
      "escrow_state",
      "escrow_index",
      "system_program",
    ]);
  });
});
