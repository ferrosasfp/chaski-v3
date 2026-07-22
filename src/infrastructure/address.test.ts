import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { isAddressEqual } from "viem";
import { addressEqualsVm, canonicalizeAddress } from "./address";
import { FALLBACK_WALLET_ADDRESS } from "./wallet";

// Pubkey base58 válida y mixed-case (mint devnet de chain.ts) — round-trip válido.
const SOLANA_MIXED = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

describe("canonicalizeAddress (HU-SOL-7 / WKH-213)", () => {
  // AC-1 evm
  it("AC-1 evm: lowercasea byte-idéntico", () => {
    expect(canonicalizeAddress("0xAbC123", "evm")).toBe("0xabc123");
  });

  // AC-1 solana
  it("AC-1 solana: round-trip PublicKey().toBase58()", () => {
    expect(canonicalizeAddress(SOLANA_MIXED, "solana")).toBe(
      new PublicKey(SOLANA_MIXED).toBase58(),
    );
  });

  // AC-2 no-colisión: el case NUNCA colapsa al lowercase
  it("AC-2 solana: preserva el case (NUNCA colapsa a lowercase)", () => {
    expect(canonicalizeAddress(SOLANA_MIXED, "solana")).not.toBe(
      SOLANA_MIXED.toLowerCase(),
    );
  });

  // AC-6: Solana malformada → throw fail-loud
  it("AC-6 solana malformada → throw", () => {
    expect(() => canonicalizeAddress("no-base58-!!!", "solana")).toThrow();
  });

  // AC-6: vm desconocido → throw fail-loud
  it("AC-6 vm desconocido → throw", () => {
    expect(() => canonicalizeAddress("x", "dogecoin" as unknown as "evm")).toThrow();
  });

  // AC-5 byte-id / no-hex: la rama EVM NUNCA usa isAddress ni throw
  it("AC-5 evm no-hex: '0xAAA' → '0xaaa'", () => {
    expect(canonicalizeAddress("0xAAA", "evm")).toBe("0xaaa");
  });

  it("AC-5 evm no-hex: '0xZZZ' → '0xzzz'", () => {
    expect(canonicalizeAddress("0xZZZ", "evm")).toBe("0xzzz");
  });

  it("AC-5 evm: FALLBACK_WALLET_ADDRESS no-hex NUNCA throw, === lowercase", () => {
    expect(() => canonicalizeAddress(FALLBACK_WALLET_ADDRESS, "evm")).not.toThrow();
    expect(canonicalizeAddress(FALLBACK_WALLET_ADDRESS, "evm")).toBe(
      FALLBACK_WALLET_ADDRESS.toLowerCase(),
    );
  });

  // W3.3 (CD-9): invariante del guard PoP (submit L143 / prepare L127). Con dos pubkeys Solana
  // case-distintas la comparación canonicalizada da true ⇒ el guard responde 403 (el ataque falla).
  it("CD-9 guard-PoP Solana: pubkeys case-distintas NO colapsan ⇒ mismatch ⇒ 403", () => {
    const chAddr = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    const attacker = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    expect(canonicalizeAddress(chAddr, "solana")).not.toBe(
      canonicalizeAddress(attacker, "solana"),
    );
  });
});

// Extraído inline de settle/principal/route.ts (MNR-1, HU-SOL-9 / WKH-208). Testea AMBAS ramas VM.
// EVM byte-idéntico ⇒ mismas assertions que isAddressEqual (CD-1). Solana case-sensitive fail-closed.
describe("addressEqualsVm (HU-SOL-9 / WKH-208)", () => {
  // EIP-55 checksums (viem los acepta). El .toLowerCase() es la MISMA address, distinto case.
  const EVM_A = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const EVM_B = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
  const SOLANA_A = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const SOLANA_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  // evm: case-distintas iguales → true (paridad byte-idéntica con isAddressEqual)
  it("evm: mismas address case-distintas → true (paridad isAddressEqual)", () => {
    expect(addressEqualsVm(EVM_A, EVM_A.toLowerCase(), "evm")).toBe(true);
    expect(addressEqualsVm(EVM_A, EVM_A.toLowerCase(), "evm")).toBe(
      isAddressEqual(EVM_A, EVM_A.toLowerCase() as `0x${string}`),
    );
  });

  // evm: distintas → false (paridad con isAddressEqual)
  it("evm: address distintas → false (paridad isAddressEqual)", () => {
    expect(addressEqualsVm(EVM_A, EVM_B, "evm")).toBe(false);
    expect(addressEqualsVm(EVM_A, EVM_B, "evm")).toBe(isAddressEqual(EVM_A, EVM_B));
  });

  // solana: dos pubkeys base58 iguales → true (round-trip canónico)
  it("solana: pubkeys iguales → true", () => {
    expect(addressEqualsVm(SOLANA_A, SOLANA_A, "solana")).toBe(true);
  });

  // solana: dos pubkeys distintas → false (no colisión)
  it("solana: pubkeys distintas → false", () => {
    expect(addressEqualsVm(SOLANA_A, SOLANA_B, "solana")).toBe(false);
  });

  // solana: una malformada → false fail-closed (NO throw, replica el inline try/catch)
  it("solana: pubkey malformada → false fail-closed (no throw)", () => {
    expect(() => addressEqualsVm(SOLANA_A, "no-base58-!!!", "solana")).not.toThrow();
    expect(addressEqualsVm(SOLANA_A, "no-base58-!!!", "solana")).toBe(false);
  });

  // solana case-sensitivity: pubkey vs versión con case alterado → false (cruza HU-SOL-7, no IDOR)
  it("solana: case alterado NO colisiona → false (case-sensitive, HU-SOL-7)", () => {
    expect(addressEqualsVm(SOLANA_A, SOLANA_A.toLowerCase(), "solana")).toBe(false);
  });
});
