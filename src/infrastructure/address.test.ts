import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { canonicalizeAddress } from "./address";

// WKH-320: este archivo probaba además la rama `evm` de canonicalizeAddress (lowercase byte-idéntico,
// NUNCA throw) y `addressEqualsVm` entero, con su paridad contra el comparador hexadecimal de viem.
// Las dos cosas se fueron con la VM que describían: la firma ahora es de UN argumento y no hay rama
// que elegir. Lo que sobrevive —y es lo que importaba— es el invariante CASE-SENSITIVE de HU-SOL-7.

// Pubkey base58 válida y mixed-case (mint USDC devnet) — round-trip válido.
const SOLANA_MIXED = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOLANA_OTHER = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("canonicalizeAddress (HU-SOL-7 / WKH-213 · WKH-320)", () => {
  it("AC-1: round-trip PublicKey().toBase58()", () => {
    expect(canonicalizeAddress(SOLANA_MIXED)).toBe(new PublicKey(SOLANA_MIXED).toBase58());
  });

  // AC-2 / CD-7 — el invariante que cerró el IDOR cross-tenant de HU-SOL-7.
  it("AC-2: preserva el case; NUNCA colapsa a lowercase (CD-7)", () => {
    expect(canonicalizeAddress(SOLANA_MIXED)).not.toBe(SOLANA_MIXED.toLowerCase());
  });

  it("CD-7: dos pubkeys distintas NO colisionan (guard de ownership ⇒ 403)", () => {
    expect(canonicalizeAddress(SOLANA_MIXED)).not.toBe(canonicalizeAddress(SOLANA_OTHER));
  });

  it("AC-6: base58 malformado ⇒ throw address_canonicalization_failed (fail-closed)", () => {
    expect(() => canonicalizeAddress("no-base58-!!!")).toThrow("address_canonicalization_failed");
  });

  // AC-3.2 — el corazón de la barrera #3 de W0. Una address hexadecimal con checksum EIP-55 VÁLIDO
  // (o sea, no basura: una address EVM legítima) tiene que TIRAR, no devolver un `false` silencioso
  // ni un lowercase que después se compare contra una base58 y matchee por accidente.
  it("AC-3.2: una address hexadecimal con checksum válido ⇒ THROW, nunca un valor", () => {
    const evmChecksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    expect(() => canonicalizeAddress(evmChecksummed)).toThrow("address_canonicalization_failed");
  });

  it("AC-3.2: tampoco la lowercasea en silencio (el resultado no existe: es una excepción)", () => {
    const evmLower = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
    let result: string | undefined;
    try {
      result = canonicalizeAddress(evmLower);
    } catch {
      result = undefined;
    }
    expect(result).toBeUndefined();
  });

  it("el error NO ecoa la address recibida (no filtra el input en un log)", () => {
    const secretish = "0xDEADBEEFdeadbeefDEADBEEFdeadbeefDEADBEEF";
    try {
      canonicalizeAddress(secretish);
      throw new Error("debió tirar");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toBe("address_canonicalization_failed");
      expect(msg).not.toContain(secretish);
    }
  });

  it("la firma es de UN argumento (sin `vm` no hay rama que elegir)", () => {
    expect(canonicalizeAddress.length).toBe(1);
  });
});
