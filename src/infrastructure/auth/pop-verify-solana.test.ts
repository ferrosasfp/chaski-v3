// @vitest-environment node
// Tests — verificador ed25519 aislado del PoP Solana (HU-SOL-8 W3.1, AC-1/AC-2/AC-5). Keypair REAL
// (nacl.sign.keyPair) firma buildSolanaPopMessage; el verificador debe aceptar sólo la firma legítima.
// El spy sobre nacl.sign.detached.verify prueba que el input malformado NUNCA llega a la cripto (AC-5).
import { afterEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { buildSolanaPopMessage, type SolanaPopChallenge } from "./pop-challenge";
import { verifySolanaPop } from "./pop-verify-solana";

const KP = nacl.sign.keyPair();
const ADDRESS = bs58.encode(KP.publicKey); // base58 32 bytes válido

function challenge(over: Partial<SolanaPopChallenge> = {}): SolanaPopChallenge {
  return {
    address: ADDRESS,
    networkId: "solana:devnet",
    nonce: "abcdef0123456789abcdef0123456789",
    exp: Math.floor(Date.now() / 1000) + 300,
    ...over,
  };
}

/** Firma el mensaje con `secretKey` y devuelve la firma base58 (64 bytes). */
function sign(message: string, secretKey: Uint8Array): string {
  const sig = nacl.sign.detached(new TextEncoder().encode(message), secretKey);
  return bs58.encode(sig);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifySolanaPop (HU-SOL-8)", () => {
  it("AC-1: firma ed25519 legítima sobre buildSolanaPopMessage ⇒ true", () => {
    const ch = challenge();
    const message = buildSolanaPopMessage(ch);
    const signatureBase58 = sign(message, KP.secretKey);
    expect(
      verifySolanaPop({ addressBase58: ch.address, message, signatureBase58 }),
    ).toBe(true);
  });

  it("AC-2: (a) firma random de 64 bytes ⇒ false", () => {
    const ch = challenge();
    const message = buildSolanaPopMessage(ch);
    const random64 = bs58.encode(nacl.randomBytes(64));
    expect(
      verifySolanaPop({ addressBase58: ch.address, message, signatureBase58: random64 }),
    ).toBe(false);
  });

  it("AC-2: (b) firma de OTRA key ⇒ false", () => {
    const other = nacl.sign.keyPair();
    const ch = challenge();
    const message = buildSolanaPopMessage(ch);
    const signatureBase58 = sign(message, other.secretKey); // firmada por otra clave
    expect(
      verifySolanaPop({ addressBase58: ch.address, message, signatureBase58 }),
    ).toBe(false);
  });

  it("AC-2: (c) mensaje alterado ⇒ false", () => {
    const ch = challenge();
    const signatureBase58 = sign(buildSolanaPopMessage(ch), KP.secretKey);
    // Se verifica contra un mensaje DISTINTO al firmado (otro nonce).
    const tampered = buildSolanaPopMessage(challenge({ nonce: "00000000000000000000000000000000" }));
    expect(
      verifySolanaPop({ addressBase58: ch.address, message: tampered, signatureBase58 }),
    ).toBe(false);
  });

  it("AC-5: (d) pubkey base58 de 31/33 bytes ⇒ false SIN invocar nacl.verify", () => {
    const spy = vi.spyOn(nacl.sign.detached, "verify");
    const message = buildSolanaPopMessage(challenge());
    const signatureBase58 = sign(message, KP.secretKey); // firma bien formada (64 bytes)
    for (const len of [31, 33]) {
      const badPubkey = bs58.encode(nacl.randomBytes(len)); // decodifica a ≠32 bytes
      expect(
        verifySolanaPop({ addressBase58: badPubkey, message, signatureBase58 }),
      ).toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("AC-5: (e) pubkey base58 inválido ⇒ false SIN invocar nacl.verify", () => {
    const spy = vi.spyOn(nacl.sign.detached, "verify");
    const message = buildSolanaPopMessage(challenge());
    const signatureBase58 = sign(message, KP.secretKey);
    for (const badPubkey of ["0OIl-not-base58", "", "not base58 !!!"]) {
      expect(
        verifySolanaPop({ addressBase58: badPubkey, message, signatureBase58 }),
      ).toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("AC-5: (f) firma que decodifica a ≠64 bytes ⇒ false SIN invocar nacl.verify", () => {
    const spy = vi.spyOn(nacl.sign.detached, "verify");
    const ch = challenge();
    const message = buildSolanaPopMessage(ch);
    for (const sigLen of [32, 63, 65]) {
      const badSig = bs58.encode(nacl.randomBytes(sigLen));
      expect(
        verifySolanaPop({ addressBase58: ch.address, message, signatureBase58: badSig }),
      ).toBe(false);
    }
    // base58 inválido en la firma también ⇒ false sin cripto.
    expect(
      verifySolanaPop({ addressBase58: ch.address, message, signatureBase58: "0OIl!" }),
    ).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
