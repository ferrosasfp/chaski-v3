// Infrastructure — verificador ed25519 aislado del proof-of-possession Solana (HU-SOL-8 / WKH-211,
// AC-1/AC-2/AC-5). Mirror del patrón fail-closed de attestation.ts: cada rama devuelve false ante el
// mínimo problema, el input malformado NUNCA llega a nacl.sign.detached.verify.
//
// Crypto: tweetnacl (nacl.sign.detached.verify, verbatim al AC-1) + bs58 (decode isomórfico de la
// firma de 64 bytes). El pubkey se decodifica SOLO vía new PublicKey(addr).toBytes() (path auditado de
// HU-SOL-7, CD-4). Browser+node-safe: bs58 + TextEncoder, NUNCA Buffer node-only (CD-SDD-3).
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

// Decode del pubkey base58 → EXACTAMENTE 32 bytes vía el path AUDITADO de HU-SOL-7 (CD-4). PublicKey
// throwea si el largo ≠ 32 o el base58 es inválido ⇒ el input malformado NUNCA llega a nacl.verify
// (AC-5). PROHIBIDO un decoder base58 ad-hoc para el pubkey.
function pubkeyBytes(addressBase58: string): Uint8Array {
  return new PublicKey(addressBase58).toBytes(); // 32 bytes exactos o throw
}

export function verifySolanaPop(params: {
  addressBase58: string;
  message: string; // buildSolanaPopMessage(...) VERBATIM (CD-6)
  signatureBase58: string; // 64 bytes base58
}): boolean {
  let pub: Uint8Array;
  try {
    pub = pubkeyBytes(params.addressBase58);
  } catch {
    return false; // AC-5
  }
  if (pub.length !== 32) return false; // defensa en profundidad
  // La FIRMA (64 bytes) NO es un PublicKey ⇒ se decodifica con bs58 (isomórfico, evita Buffer node-only).
  let sig: Uint8Array;
  try {
    sig = bs58.decode(params.signatureBase58);
  } catch {
    return false;
  }
  if (sig.length !== 64) return false; // AC-5 (firma)
  const msg = new TextEncoder().encode(params.message); // browser+node-safe
  try {
    return nacl.sign.detached.verify(msg, sig, pub); // AC-1: (msg, sig, pubkey)
  } catch {
    return false;
  }
}
