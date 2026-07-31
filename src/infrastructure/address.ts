import { PublicKey } from "@solana/web3.js";

/**
 * Canonicalización de address Solana (HU-SOL-7 / WKH-213).
 * Round-trip new PublicKey(address).toBase58(): valida base58 32 bytes y normaliza la codificación
 * canónica. CASE-SENSITIVE ⇒ cierra la colisión IDOR que abrió HU-SOL-7. Malformado → throw
 * (fail-closed, no ecoa la address).
 *
 * La firma es de UN argumento a propósito: no hay nada que despachar, así que ninguna address
 * ajena al formato puede atravesar un borde de confianza sin que esto tire.
 * PROHIBIDO .toLowerCase() sobre base58 (CD-7).
 */
export function canonicalizeAddress(address: string): string {
  try {
    return new PublicKey(address).toBase58();
  } catch {
    throw new Error("address_canonicalization_failed");
  }
}
