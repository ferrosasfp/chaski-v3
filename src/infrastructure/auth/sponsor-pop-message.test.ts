// T-G1 (chaski) — el builder del mensaje canónico de patrocinio contra el vector golden.
//
// Su gemelo vive en `wasiai-facilitator/src/__tests__/unit/solana-sponsor.pop.test.ts` con el MISMO
// literal. Ése es el punto: un mutante que cambie un byte del builder de UN solo repo (M10) deja ese
// repo internamente coherente y sólo se manifiesta contra una billetera real. Acá muere si el
// mutante se aplica de este lado.
//
// ⚠️ Se compara contra un LITERAL escrito a mano, NUNCA contra otra llamada al builder (CD-9): esa
// aserción se movería junto con el mutante y pasaría siempre.
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { buildSponsorPopMessage } from "./sponsor-pop-message";
import { GOLDEN } from "../../test-support/sponsor-pop-golden";

describe("T-G1 — el builder del mensaje canónico (chaski)", () => {
  it("★ produce EXACTAMENTE el string del vector golden", () => {
    const built = buildSponsorPopMessage({
      sender: GOLDEN.senderBase58,
      networkId: GOLDEN.networkId,
      remittanceId: GOLDEN.remittanceId,
      amountMinor: GOLDEN.amountMinor,
      mint: GOLDEN.mintBase58,
      txSignatureB58: GOLDEN.txSignatureB58,
    });
    expect(built).toBe(GOLDEN.expectedMessage);
  });

  it("el mensaje tiene 7 líneas y NO termina en newline", () => {
    const built = buildSponsorPopMessage({
      sender: GOLDEN.senderBase58,
      networkId: GOLDEN.networkId,
      remittanceId: GOLDEN.remittanceId,
      amountMinor: GOLDEN.amountMinor,
      mint: GOLDEN.mintBase58,
      txSignatureB58: GOLDEN.txSignatureB58,
    });
    expect(built.split("\n")).toHaveLength(7);
    expect(built.endsWith("\n")).toBe(false);
  });

  it("abre con su propio separador de dominio, distinto del leg de payout", () => {
    const built = buildSponsorPopMessage({
      sender: GOLDEN.senderBase58,
      networkId: GOLDEN.networkId,
      remittanceId: GOLDEN.remittanceId,
      amountMinor: GOLDEN.amountMinor,
      mint: GOLDEN.mintBase58,
      txSignatureB58: GOLDEN.txSignatureB58,
    });
    expect(built.startsWith("WasiAI Sponsor Request v1\n")).toBe(true);
    expect(built.startsWith("Chaski Proof-of-Possession")).toBe(false);
  });

  it("★ la seed publicada firma el mensaje golden y da la firma golden", () => {
    // Esto es lo que ata este repo al otro: la MISMA firma que el facilitator verifica en su T-G1.
    const kp = Keypair.fromSeed(Uint8Array.from(GOLDEN.senderSeed));
    expect(kp.publicKey.toBase58()).toBe(GOLDEN.senderBase58);

    const signature = nacl.sign.detached(
      new TextEncoder().encode(GOLDEN.expectedMessage),
      kp.secretKey,
    );
    expect(bs58.encode(signature)).toBe(GOLDEN.expectedSignature);
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(GOLDEN.expectedMessage),
        bs58.decode(GOLDEN.expectedSignature),
        kp.publicKey.toBytes(),
      ),
    ).toBe(true);
  });

  it("un byte distinto en cualquier línea rompe la verificación", () => {
    const kp = Keypair.fromSeed(Uint8Array.from(GOLDEN.senderSeed));
    const tampered = GOLDEN.expectedMessage.replace("network: solana:devnet", "Network: solana:devnet");
    expect(tampered).not.toBe(GOLDEN.expectedMessage);
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(tampered),
        bs58.decode(GOLDEN.expectedSignature),
        kp.publicKey.toBytes(),
      ),
    ).toBe(false);
  });
});
