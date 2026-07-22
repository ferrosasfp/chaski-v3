import { PublicKey } from "@solana/web3.js";
import { isAddressEqual } from "viem";

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

/** Comparación de address SERVER-controlada VM-discriminada (HU-SOL-9 / WKH-208).
 *  - evm:    isAddressEqual (byte-idéntico al comportamiento WKH-168/211 — CD-1). NUNCA case-collapse.
 *  - solana: igualdad canónica base58 vía canonicalizeAddress (case-sensitive, CD-2/CD-10). Malformado
 *            hace throwear a canonicalizeAddress → try/catch → false (fail-closed, nunca 500 crudo).
 *  NUNCA isAddressEqual sobre base58 (TIRA). Consumido por B6/S12/S13 en settle/principal; en solana el
 *  settle runtime completo es HU-SOL-13 (esta HU deja la comparación VM-safe).
 *  Extraído de app/api/settle/principal/route.ts (MNR-1): un route.ts no puede exportar helpers
 *  (Next valida los exports contra los handlers HTTP en .next/types → rompe tsc); acá es un módulo
 *  normal, importable y unit-testeable. */
export function addressEqualsVm(a: string, b: string, vm: "evm" | "solana"): boolean {
  if (vm === "solana") {
    try {
      return canonicalizeAddress(a, "solana") === canonicalizeAddress(b, "solana");
    } catch {
      return false;
    }
  }
  return isAddressEqual(a as `0x${string}`, b as `0x${string}`);
}
