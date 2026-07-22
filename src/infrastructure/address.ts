import { PublicKey } from "@solana/web3.js";

/**
 * Canonicalización de address VM-aware (HU-SOL-7 / WKH-213).
 *  - evm:    address.toLowerCase() PURO, byte-idéntico (checksum EVM case-insensitive). SIN isAddress
 *            (CD-2, supremacía del byte-idéntico sobre el fail-loop de AC-6 en la rama EVM — SDD §4.3.1).
 *            NUNCA throw.
 *  - solana: round-trip new PublicKey(address).toBase58() (valida base58 32 bytes + normaliza la
 *            codificación canónica). Case-sensitive ⇒ cierra la colisión IDOR (AC-2). Malformado → throw.
 *  - vm desconocido: throw (fail-loud, AC-6). Sin inferencia por shape (CD-4).
 */
export function canonicalizeAddress(address: string, vm: "evm" | "solana"): string {
  switch (vm) {
    case "evm":
      return address.toLowerCase(); // byte-idéntico, NUNCA throw (CD-2)
    case "solana":
      try {
        return new PublicKey(address).toBase58(); // valida + normaliza, preserva el case
      } catch {
        throw new Error("address_canonicalization_failed"); // fail-loud, no ecoa la address
      }
    default:
      throw new Error("address_canonicalization_failed"); // vm desconocido (fail-loud, AC-6)
  }
}
