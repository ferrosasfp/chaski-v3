// Tests — SolanaWalletAdapter.refundEscrow (HU-SOL-13/AC-6/AC-7, CD-10). El SENDER firma + broadcastea
// el `refund` del escrow, SIN facilitator ni release-authority. Antes de firmar lee EscrowState on-chain
// y aborta si status≠Deposited o now<deadline. Connection mockeada (cero red, patrón solana-wallet.test).
import { sha256 } from "@noble/hashes/sha256";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SolanaWalletAdapter } from "./solana-wallet";
import { escrowIdl } from "./solana/escrow-idl";
import { solanaWalletBridge } from "./solana-wallet-bridge";

const ESCROW_PROGRAM_ID = "DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x";
const REFUND_DISCRIMINATOR = [2, 96, 183, 251, 63, 208, 46, 46];
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MINT_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const FIXED_BLOCKHASH = Keypair.generate().publicKey.toBase58();

const SENDER_KP = Keypair.generate();
const SENDER_B58 = SENDER_KP.publicKey.toBase58();
const AUTHORITY_PK = Keypair.generate().publicKey; // release-authority on-chain — NUNCA debe firmar

function remittanceIdBytes16(remittanceId: string): Uint8Array {
  return Uint8Array.from(sha256(new TextEncoder().encode(remittanceId)).subarray(0, 16));
}

/** Encodea un EscrowState (con el discriminator de cuenta) tal como lo devolvería getAccountInfo. */
async function encodeEscrowState(status: "deposited" | "released", deadlineSec: number): Promise<Buffer> {
  const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
  return coder.encode("EscrowState", {
    sender: SENDER_KP.publicKey,
    beneficiary: Keypair.generate().publicKey,
    authority: AUTHORITY_PK,
    mint: new PublicKey(MINT_B58),
    amount: new anchor.BN(1_000_000),
    deadline: new anchor.BN(deadlineSec),
    status: status === "deposited" ? { Deposited: {} } : { Released: {} },
    bump: 255,
  });
}

function mockAccountInfo(data: Buffer | null) {
  vi.spyOn(Connection.prototype, "getAccountInfo").mockResolvedValue(
    data
      ? ({ data, executable: false, lamports: 1, owner: new PublicKey(ESCROW_PROGRAM_ID), rentEpoch: 0 } as never)
      : null,
  );
}

async function connectedAdapter(): Promise<SolanaWalletAdapter> {
  solanaWalletBridge.setState({ publicKey: SENDER_B58, connected: true });
  const adapter = new SolanaWalletAdapter();
  await adapter.connect();
  return adapter;
}

function capturedTx(spy: ReturnType<typeof vi.fn>): Transaction {
  const call = spy.mock.calls[0];
  if (!call) throw new Error("signTransaction_not_called");
  return call[0] as Transaction;
}

describe("SolanaWalletAdapter.refundEscrow (HU-SOL-13)", () => {
  let signSpy: ReturnType<typeof vi.fn>;
  let sendSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
      blockhash: FIXED_BLOCKHASH,
      lastValidBlockHeight: 1,
    } as Awaited<ReturnType<Connection["getLatestBlockhash"]>>);
    sendSpy = vi.fn(async () => "refund-sig-broadcasted");
    vi.spyOn(Connection.prototype, "sendRawTransaction").mockImplementation(sendSpy as never);
    // El sender firma REALMENTE (partialSign con su keypair) — la única firma (feePayer=sender).
    signSpy = vi.fn(async (tx: Transaction) => {
      tx.partialSign(SENDER_KP);
      return tx;
    });
    solanaWalletBridge.registerSignTransaction(signSpy);
  });

  afterEach(() => {
    solanaWalletBridge.reset();
    vi.restoreAllMocks();
  });

  it("AC-6: Deposited + now>=deadline → arma la ix refund (discr + accounts en orden), sender=signer+feePayer, broadcastea", async () => {
    mockAccountInfo(await encodeEscrowState("deposited", Math.floor(Date.now() / 1000) - 3600)); // deadline pasado
    const adapter = await connectedAdapter();

    const out = await adapter.refundEscrow("rem-refund-ok");
    expect(out.refundTx).toBe("refund-sig-broadcasted");
    expect(sendSpy).toHaveBeenCalledTimes(1); // broadcast por el SENDER (sin facilitator)

    const tx = capturedTx(signSpy);
    // feePayer=sender (CD-10): NUNCA la release-authority.
    expect(tx.feePayer?.toBase58()).toBe(SENDER_B58);
    expect(tx.feePayer?.toBase58()).not.toBe(AUTHORITY_PK.toBase58());
    expect(tx.recentBlockhash).toBe(FIXED_BLOCKHASH);

    const ix = tx.instructions[0];
    if (!ix) throw new Error("no_instruction");
    expect(ix.programId.toBase58()).toBe(ESCROW_PROGRAM_ID);
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(REFUND_DISCRIMINATOR);
    // accounts EN ORDEN (AH-10): sender, mint, escrow_state, vault, sender_ata, token_program, assoc_token_program.
    const keys = ix.keys.map((k) => k.pubkey.toBase58());
    const programId = new PublicKey(ESCROW_PROGRAM_ID);
    const [escrowStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), SENDER_KP.publicKey.toBuffer(), Buffer.from(remittanceIdBytes16("rem-refund-ok"))],
      programId,
    );
    expect(keys[0]).toBe(SENDER_B58); // sender
    expect(ix.keys[0]!.isSigner).toBe(true); // sender es signer
    expect(ix.keys[0]!.isWritable).toBe(true); // + writable
    expect(keys[1]).toBe(MINT_B58); // mint (on-chain, autoritativo)
    expect(keys[2]).toBe(escrowStatePda.toBase58()); // escrow_state PDA
    expect(keys).toContain(TOKEN_PROGRAM);
    expect(keys).toContain(ASSOCIATED_TOKEN_PROGRAM);
    // La release-authority NO aparece como signer en ninguna key (CD-10).
    expect(ix.keys.some((k) => k.pubkey.toBase58() === AUTHORITY_PK.toBase58() && k.isSigner)).toBe(false);
  });

  it("AC-6: status≠Deposited (Released) → aborta escrow_not_deposited, SIN firmar ni broadcastear", async () => {
    mockAccountInfo(await encodeEscrowState("released", Math.floor(Date.now() / 1000) - 3600));
    const adapter = await connectedAdapter();
    await expect(adapter.refundEscrow("rem-released")).rejects.toThrow("escrow_not_deposited");
    expect(signSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("AC-7: now<deadline → aborta refund_before_deadline, SIN firmar ni broadcastear (defensa en profundidad)", async () => {
    mockAccountInfo(await encodeEscrowState("deposited", Math.floor(Date.now() / 1000) + 3600)); // deadline futuro
    const adapter = await connectedAdapter();
    await expect(adapter.refundEscrow("rem-early")).rejects.toThrow("refund_before_deadline");
    expect(signSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("escrow inexistente (getAccountInfo null) → aborta escrow_not_found", async () => {
    mockAccountInfo(null);
    const adapter = await connectedAdapter();
    await expect(adapter.refundEscrow("rem-none")).rejects.toThrow("escrow_not_found");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("AC-7: sin wallet conectada y sin sender → wallet_not_connected", async () => {
    const adapter = new SolanaWalletAdapter(); // sin connect
    await expect(adapter.refundEscrow("rem-x")).rejects.toThrow("wallet_not_connected");
  });
});
