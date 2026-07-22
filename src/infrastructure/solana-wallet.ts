// src/infrastructure/solana-wallet.ts
// SolanaWalletAdapter implements WalletPort — puente React-free hacia el árbol Solana vía el
// singleton bridge. NUNCA importa @solana/wallet-adapter-* (seam AC-3). Valida base58 con PublicKey
// de @solana/web3.js (CD-SDD-5), NUNCA isAddress de viem. connect()/getAddress()/signMessage() son
// de HU-SOL-4 (NO se tocan). authorizePrincipal (HU-SOL-5) construye la ix `deposit` del escrow
// Anchor, fija feePayer=facilitator, partial-signa SÓLO con la wallet (bridge) y devuelve la tx
// serializada base64 — NUNCA broadcastea (CD-SDD-1, AC-3): el broadcast es del facilitator (HU-SOL-14).
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import type {
  Transaction as Web3Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { Idl, Provider } from "@coral-xyz/anchor";
import type {
  SolanaEscrowDeposit,
  SolanaPrincipalAuthorization,
  WalletPort,
} from "../application/ports";
import type { Quote } from "../domain/remittance";
import { isParseableIso } from "../domain/remittance";
import {
  resolveSolanaFacilitatorPubkey,
  resolveSolanaNetworkConfig,
  resolveSolanaRpcUrlPublic,
  resolveSolanaUsdcMint,
} from "./chain";
import { solanaWalletBridge } from "./solana-wallet-bridge";

export class SolanaWalletAdapter implements WalletPort {
  private address: string | null = null;

  async connect(): Promise<string> {
    const state = solanaWalletBridge.getState();
    if (!state.connected || !state.publicKey) {
      solanaWalletBridge.openModal(); // abre el modal Phantom/Solflare (AC-2)
      await solanaWalletBridge.waitForConnection(); // throw en timeout/cancel (§flujo de error)
    }
    const base58 = solanaWalletBridge.getState().publicKey;
    if (!base58) throw new Error("wallet_not_connected");
    // Defensa en profundidad: valida base58 ANTES de cachear (espeja InjectedWallet:66).
    try {
      new PublicKey(base58);
    } catch {
      throw new Error("invalid_address");
    }
    this.address = base58; // OPACO, SIN toLowerCase (CD-3)
    return this.address;
  }

  async getAddress(): Promise<string | null> {
    return this.address; // el MISMO base58 case-sensitive (AC-6)
  }

  /** [u8;16] DETERMINÍSTICO desde remittanceId: `sha256(remittanceId)` truncado a 16 bytes
   *  (DT-SDD-5). Reproducible server-side (HU-SOL-13 re-deriva la PDA `escrow_state`). NUNCA
   *  Math.random. Usa `sha256` de @noble/hashes (browser-safe, SÍNCRONO) — NO el builtin de Node,
   *  que NO resuelve en el bundle client de Next (BLQ-MED-1). Output byte-idéntico al hash previo:
   *  sha256(utf8(remittanceId))[:16]. */
  private remittanceIdToBytes16(remittanceId: string): Uint8Array {
    return Uint8Array.from(sha256(new TextEncoder().encode(remittanceId)).subarray(0, 16));
  }

  // HU-SOL-5 (AC-1..AC-4, AC-7, AC-8): construye la ix `deposit` del escrow Anchor, fija
  // feePayer=facilitator, partial-signa SÓLO con la wallet (bridge) y devuelve la tx serializada.
  async authorizePrincipal(
    quote: Quote,
    remittanceId: string,
    deposit?: { address: string; escrow?: SolanaEscrowDeposit },
  ): Promise<{ tx: string; solana?: SolanaPrincipalAuthorization }> {
    // ── GUARDS fail-loud (AC-7/CD-SDD-8) — ANTES de construir/firmar nada ──
    const sender = await this.getAddress(); // base58 del bridge (HU-SOL-4)
    if (!sender) throw new Error("wallet_not_connected"); // AC-7
    if (!deposit?.escrow?.beneficiary || !deposit?.escrow?.authority)
      throw new Error("escrow_params_missing"); // CD-SDD-8

    // ── lazy-import (DT-SDD-8, patrón wallet.ts:200) ──
    const web3 = await import("@solana/web3.js");
    const { PublicKey, Transaction, Connection, Keypair } = web3;
    const anchor = await import("@coral-xyz/anchor");
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const { escrowIdl } = await import("./solana/escrow-idl"); // la copia pinneada (W0.4)

    // ── Pubkeys (CD-SDD-7, validan base58) ──
    const senderPk = new PublicKey(sender);
    const beneficiaryPk = new PublicKey(deposit.escrow.beneficiary);
    const authorityPk = new PublicKey(deposit.escrow.authority);
    const mintPk = new PublicKey(deposit.escrow.mint ?? resolveSolanaUsdcMint()); // CD-SDD-4
    const programId = new PublicKey((escrowIdl as { address: string }).address); // BBQ9…79WA, CD-SDD-4

    // ── Args canónicos (AC-8/CD-SDD-3) — String(...) NO Number(...) ──
    const remittanceIdBytes = this.remittanceIdToBytes16(remittanceId); // [u8;16] determinístico
    const amount = new anchor.BN(String(quote.send.minor)); // u64, sin floats
    if (!isParseableIso(quote.expiresAt)) throw new Error("quote_expires_at_invalid");
    const deadline = new anchor.BN(String(Math.floor(Date.parse(quote.expiresAt) / 1000))); // i64 unix seconds

    // ── PDAs / ATAs (AC-1) ──
    const [escrowStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), senderPk.toBuffer(), Buffer.from(remittanceIdBytes)],
      programId,
    );
    // vault: ATA del mint owned por la PDA escrow_state (off-curve). sender_ata: ATA del sender.
    const vault = getAssociatedTokenAddressSync(mintPk, escrowStatePda, /*allowOwnerOffCurve*/ true);
    const senderAta = getAssociatedTokenAddressSync(mintPk, senderPk);

    // ── reference (AC-4/CD-SDD-13) — Pubkey único, @solana/web3.js, NO @solana/pay ──
    const reference = Keypair.generate().publicKey; // la privada se DESCARTA (nunca firma)

    // ── Build ix (AC-1/AC-4) — vía anchor Program (programId del idl.address) ──
    const connection = new Connection(
      resolveSolanaRpcUrlPublic(resolveSolanaNetworkConfig().cluster), // client-safe: NEXT_PUBLIC_SOLANA_RPC_URL ?? público (AR-MNR-2)
    );
    const program = new anchor.Program(escrowIdl as unknown as Idl, { connection } as Provider);
    // `escrowIdl as Idl` es el IDL genérico ⇒ `methods.deposit` no está tipado por-instrucción;
    // se accede vía un shape loose (los args/accounts/remaining se validan contra el IDL en runtime).
    const methods = program.methods as unknown as {
      deposit: (...args: unknown[]) => {
        accounts: (a: Record<string, PublicKey>) => {
          remainingAccounts: (
            r: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>,
          ) => { instruction: () => Promise<TransactionInstruction> };
        };
      };
    };
    const ix = await methods
      .deposit(Array.from(remittanceIdBytes), beneficiaryPk, authorityPk, amount, deadline)
      // escrow_state/vault son PDAs derivables por anchor, pero se pasan EXPLÍCITOS (AR-MNR-1): más
      // robusto ante cambios de resolución de anchor y elimina el dead code. sender_ata NO es PDA.
      // programs (address fija en el IDL) los resuelve anchor.
      .accounts({ sender: senderPk, mint: mintPk, escrowState: escrowStatePda, vault, senderAta })
      .remainingAccounts([{ pubkey: reference, isSigner: false, isWritable: false }]) // AC-4
      .instruction();

    // ── feePayer + blockhash + partial-sign + serializar (AC-2/AC-3) ──
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new Transaction().add(ix);
    tx.feePayer = new PublicKey(resolveSolanaFacilitatorPubkey()); // AC-2: facilitator paga el fee de red
    tx.recentBlockhash = blockhash;

    const signed = (await solanaWalletBridge.signTransaction(tx)) as Web3Transaction; // AC-2: partial-sign SÓLO wallet
    const serialized = signed
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
    // AC-3/CD-SDD-1: NUNCA connection.sendRawTransaction / sendTransaction acá.

    return {
      tx: serialized,
      solana: { vm: "solana", partialSignedTx: serialized, reference: reference.toBase58() },
    };
  }

  // HU-SOL-13 (WKH-216/AC-6/AC-7, CD-10): refund TRUSTLESS del escrow. El SENDER firma + el SENDER
  // broadcastea (feePayer=sender), SIN facilitator ni release-authority (CD-10). Antes de firmar lee
  // `EscrowState` on-chain (autoritativo, AH-14/NC-3) y ABORTA client-side si status≠Deposited o
  // now<deadline (evita una tx que revertiría; defensa en profundidad — el programa ya rechaza
  // EscrowNotDeposited/DeadlineNotReached). Reusa remittanceIdToBytes16 + la derivación PDA de
  // authorizePrincipal. CD-15: libs isomórficas (@noble/hashes, TextEncoder, Buffer polyfill de Next),
  // NUNCA node:crypto — el test-env `node` enmascara la falla del bundle browser.
  async refundEscrow(remittanceId: string, sender?: string): Promise<{ refundTx: string }> {
    // ── GUARDS fail-loud — ANTES de leer/construir/firmar nada ──
    const senderB58 = sender ?? (await this.getAddress());
    if (!senderB58) throw new Error("wallet_not_connected");

    // ── lazy-import (patrón authorizePrincipal, DT-SDD-8) ──
    const web3 = await import("@solana/web3.js");
    const { PublicKey, Transaction, Connection } = web3;
    const anchor = await import("@coral-xyz/anchor");
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const { escrowIdl } = await import("./solana/escrow-idl");

    const senderPk = new PublicKey(senderB58); // valida base58 (CD-SDD-7)
    const programId = new PublicKey((escrowIdl as { address: string }).address); // BBQ9…79WA

    // ── PDA escrow_state (misma derivación que authorizePrincipal / cross-repo, AH-9) ──
    const remittanceIdBytes = this.remittanceIdToBytes16(remittanceId); // [u8;16] determinístico
    const [escrowStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), senderPk.toBuffer(), Buffer.from(remittanceIdBytes)],
      programId,
    );

    const connection = new Connection(
      resolveSolanaRpcUrlPublic(resolveSolanaNetworkConfig().cluster), // client-safe
    );

    // ── Read on-chain (autoritativo): status==Deposited && now>=deadline (AC-6/AC-7) ──
    const info = await connection.getAccountInfo(escrowStatePda);
    if (!info) throw new Error("escrow_not_found"); // nada que refundear
    const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
    const state = coder.decode("EscrowState", info.data) as {
      mint: InstanceType<typeof PublicKey>;
      deadline: { toNumber(): number };
      status: Record<string, unknown>;
    };
    const statusKey = Object.keys(state.status)[0]; // enum anchor 0.30 → { Deposited: {} } | { Released: {} } | ...
    if (statusKey !== "Deposited") throw new Error("escrow_not_deposited"); // AC-6: sólo Deposited
    const deadlineSec = state.deadline.toNumber();
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < deadlineSec) throw new Error("refund_before_deadline"); // AC-7: bloquea pre-deadline

    // ── Build ix `refund` (AH-10) vía anchor Program (mismo shape loose que deposit) ──
    const mintPk = state.mint; // el mint on-chain (autoritativo), NUNCA del cliente
    const vault = getAssociatedTokenAddressSync(mintPk, escrowStatePda, /*allowOwnerOffCurve*/ true);
    const senderAta = getAssociatedTokenAddressSync(mintPk, senderPk);
    const program = new anchor.Program(escrowIdl as unknown as Idl, { connection } as Provider);
    const methods = program.methods as unknown as {
      refund: (...args: unknown[]) => {
        accounts: (a: Record<string, InstanceType<typeof PublicKey>>) => {
          instruction: () => Promise<TransactionInstruction>;
        };
      };
    };
    const ix = await methods
      .refund(Array.from(remittanceIdBytes))
      .accounts({ sender: senderPk, mint: mintPk, escrowState: escrowStatePda, vault, senderAta })
      .instruction();

    // ── feePayer=SENDER (CD-10: sin facilitator) + blockhash + sign SENDER + broadcast SENDER ──
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new Transaction().add(ix);
    tx.feePayer = senderPk; // AC-6/CD-10: el sender paga el fee y firma (NUNCA la release-authority)
    tx.recentBlockhash = blockhash;
    const signed = (await solanaWalletBridge.signTransaction(tx)) as Web3Transaction; // firma SÓLO el sender
    const signature = await connection.sendRawTransaction(
      signed.serialize(), // requireAllSignatures=true por default (el sender es el único signer)
    );
    return { refundTx: signature }; // signature base58 broadcasteada
  }

  // HU-SOL-8 (AC-1/CD-6/CD-SDD-3): firma REAL del proof-of-possession. El caller (http-pop-signer) pasa
  // el popMessage VERBATIM; la wallet (vía bridge) devuelve la firma ed25519 de 64 bytes; se codifica
  // base58 (simétrico con verifySolanaPop.signatureBase58). Browser+node-safe: bs58 + TextEncoder,
  // NUNCA Buffer node-only (auto-blindaje HU-SOL-5 BLQ-MED-1).
  async signMessage(message: string): Promise<string> {
    const bytes = new TextEncoder().encode(message); // browser+node-safe (NO Buffer)
    const sig = await solanaWalletBridge.signMessage(bytes); // Uint8Array(64) de la wallet
    // Normalizar a Uint8Array cubre adapters que devuelvan otro shape (R-2 del SDD).
    return bs58.encode(sig instanceof Uint8Array ? sig : new Uint8Array(sig));
  }
}
