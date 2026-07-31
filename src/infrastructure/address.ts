import { PublicKey } from "@solana/web3.js";

/**
 * Canonicalización de address Solana (HU-SOL-7 / WKH-213 · WKH-320).
 * Round-trip new PublicKey(address).toBase58(): valida base58 32 bytes y normaliza la codificación
 * canónica. CASE-SENSITIVE ⇒ cierra la colisión IDOR que abrió HU-SOL-7. Malformado → throw
 * (fail-closed, no ecoa la address).
 *
 * WKH-320: la firma es de UN argumento a propósito. Sin `vm` no hay rama `evm`, y ninguna address
 * `0x…` puede atravesar un borde de confianza: new PublicKey("0x…") tira y esta función propaga.
 * PROHIBIDO .toLowerCase() sobre base58 (CD-7).
 */
export function canonicalizeAddress(address: string): string {
  try {
    return new PublicKey(address).toBase58();
  } catch {
    throw new Error("address_canonicalization_failed");
  }
}
