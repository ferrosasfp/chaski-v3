// Tests — SolanaWalletAdapter.refundEscrow (HU-SOL-13/AC-6/AC-7, CD-10). El SENDER firma + broadcastea
// el `refund` del escrow, SIN facilitator ni release-authority. Antes de firmar lee EscrowState on-chain
// y aborta si status≠Deposited o now<deadline. Connection mockeada (cero red, patrón solana-wallet.test).
import { sha256 } from "@noble/hashes/sha256";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SolanaEscrowRefundGateway } from "./refund/solana-escrow-refund-gateway";
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

// ── HU-SOL-20/AC-2 · fallback de recuperación del remittanceId (T-R0-9 / T-R0-10) ──────────────────
// La PDA del escrow se deriva del remittanceId. Si el cliente lo perdió (localStorage borrado / otro
// dispositivo) los fondos quedan inalcanzables. El fallback lo recupera del store durable server-side y
// elige el candidato ON-CHAIN (nunca a ciegas). El path con id presente queda intacto (AC-6).
describe("SolanaWalletAdapter.refundEscrow — fallback HU-SOL-20 (AC-2/AC-6)", () => {
  let signSpy: ReturnType<typeof vi.fn>;
  let sendSpy: ReturnType<typeof vi.fn>;
  const PROGRAM_ID = new PublicKey(ESCROW_PROGRAM_ID);

  function pdaOf(remittanceId: string): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), SENDER_KP.publicKey.toBuffer(), Buffer.from(remittanceIdBytes16(remittanceId))],
      PROGRAM_ID,
    )[0];
  }
  function accountInfo(data: Buffer) {
    return { data, executable: false, lamports: 1, owner: PROGRAM_ID, rentEpoch: 0 };
  }

  /** Mockea el RPC como una cadena honesta: cada PDA responde SU propio estado (o null si no existe).
   *  Así el fallback tiene que decodificar de verdad para elegir bien — un `ids[0]` a ciegas se cae. */
  async function mockChain(states: Record<string, "deposited" | "released">): Promise<void> {
    const byPda = new Map<string, Buffer>();
    for (const [id, st] of Object.entries(states)) {
      byPda.set(pdaOf(id).toBase58(), await encodeEscrowState(st, Math.floor(Date.now() / 1000) - 3600));
    }
    vi.spyOn(Connection.prototype, "getMultipleAccountsInfo").mockImplementation(
      (async (keys: PublicKey[]) =>
        keys.map((k) => {
          const d = byPda.get(k.toBase58());
          return d ? accountInfo(d) : null;
        })) as never,
    );
    vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation(
      (async (k: PublicKey) => {
        const d = byPda.get(k.toBase58());
        return d ? accountInfo(d) : null;
      }) as never,
    );
  }

  beforeEach(() => {
    vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
      blockhash: FIXED_BLOCKHASH,
      lastValidBlockHeight: 1,
    } as Awaited<ReturnType<Connection["getLatestBlockhash"]>>);
    sendSpy = vi.fn(async () => "refund-sig-recovered");
    vi.spyOn(Connection.prototype, "sendRawTransaction").mockImplementation(sendSpy as never);
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

  async function connectedWith(resolver?: { listBySender: ReturnType<typeof vi.fn> }) {
    solanaWalletBridge.setState({ publicKey: SENDER_B58, connected: true });
    const adapter = new SolanaWalletAdapter(resolver);
    await adapter.connect();
    return adapter;
  }

  // ── T-R0-9 · AC-6 byte-idéntico: con id presente el resolver NI SE ROZA ──────────────────────────
  it("T-R0-9 (AC-6): con remittanceId presente el resolver NO se invoca (0 llamadas) y el refund sale igual", async () => {
    await mockChain({ "rem-refund-ok": "deposited" });
    const listBySender = vi.fn(async () => ["rem-otro"]);
    const adapter = await connectedWith({ listBySender });

    const out = await adapter.refundEscrow("rem-refund-ok");
    expect(out.refundTx).toBe("refund-sig-recovered");
    expect(listBySender).toHaveBeenCalledTimes(0); // el path que ya funcionaba no consulta nada
    // Y refundeó EXACTAMENTE el id pedido (no el que devolvería el resolver).
    const ix = capturedTx(signSpy).instructions[0];
    if (!ix) throw new Error("no_instruction");
    expect(ix.keys[2]!.pubkey.toBase58()).toBe(pdaOf("rem-refund-ok").toBase58());
  });

  it("T-R0-9: un remittanceId vacío/whitespace NO cuenta como presente (cae al fallback)", async () => {
    await mockChain({ "rem-recovered": "deposited" });
    const listBySender = vi.fn(async () => ["rem-recovered"]);
    const adapter = await connectedWith({ listBySender });
    await expect(adapter.refundEscrow("   ")).resolves.toEqual({ refundTx: "refund-sig-recovered" });
    expect(listBySender).toHaveBeenCalledTimes(1);
  });

  // ── T-R0-10 · AC-2: elige el candidato Deposited leyendo la cadena ───────────────────────────────
  it("T-R0-10 (AC-2/CD-10): sin id, con 2 candidatos (1º Released, 2º Deposited) ⇒ refundea el 2º; feePayer=sender", async () => {
    await mockChain({ "rem-released": "released", "rem-deposited": "deposited" });
    // Orden created_at desc tal como llega del ledger: el primero NO es refundeable.
    const listBySender = vi.fn(async () => ["rem-released", "rem-deposited"]);
    const adapter = await connectedWith({ listBySender });

    const out = await adapter.refundEscrow(); // ← sin remittanceId: el caso que hoy pierde la plata
    expect(out.refundTx).toBe("refund-sig-recovered");
    expect(listBySender).toHaveBeenCalledTimes(1);
    expect(listBySender).toHaveBeenCalledWith(SENDER_B58);

    const tx = capturedTx(signSpy);
    // CD-10: el sender paga el fee y firma — NUNCA la release-authority ni el facilitator.
    expect(tx.feePayer?.toBase58()).toBe(SENDER_B58);
    expect(tx.feePayer?.toBase58()).not.toBe(AUTHORITY_PK.toBase58());
    const ix = tx.instructions[0];
    if (!ix) throw new Error("no_instruction");
    // La PDA refundeada es la del 2º candidato: prueba que se LEYÓ el estado on-chain y no se tomó ids[0].
    expect(ix.keys[2]!.pubkey.toBase58()).toBe(pdaOf("rem-deposited").toBase58());
    expect(ix.keys[2]!.pubkey.toBase58()).not.toBe(pdaOf("rem-released").toBase58());
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("T-R0-10: UNA sola llamada RPC batch para todos los candidatos (no N getAccountInfo)", async () => {
    await mockChain({ "rem-1": "released", "rem-2": "released", "rem-3": "deposited" });
    const listBySender = vi.fn(async () => ["rem-1", "rem-2", "rem-3"]);
    const adapter = await connectedWith({ listBySender });
    await adapter.refundEscrow();
    const batch = vi.mocked(Connection.prototype.getMultipleAccountsInfo);
    expect(batch).toHaveBeenCalledTimes(1);
    expect((batch.mock.calls[0]?.[0] as PublicKey[] | undefined)?.length).toBe(3);
  });

  it("T-R0-10: 0 candidatos en el ledger ⇒ escrow_not_found, SIN firmar ni broadcastear", async () => {
    await mockChain({});
    const listBySender = vi.fn(async () => []);
    const adapter = await connectedWith({ listBySender });
    await expect(adapter.refundEscrow()).rejects.toThrow("escrow_not_found");
    expect(signSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("T-R0-10: candidatos que existen pero NINGUNO está Deposited ⇒ escrow_not_found, sin firmar", async () => {
    await mockChain({ "rem-a": "released", "rem-b": "released" });
    const listBySender = vi.fn(async () => ["rem-a", "rem-b"]);
    const adapter = await connectedWith({ listBySender });
    await expect(adapter.refundEscrow()).rejects.toThrow("escrow_not_found");
    expect(signSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("T-R0-10: candidatos cuya PDA no existe on-chain se saltan (null ⇒ no candidata)", async () => {
    await mockChain({ "rem-real": "deposited" }); // "rem-fantasma" no tiene cuenta
    const listBySender = vi.fn(async () => ["rem-fantasma", "rem-real"]);
    const adapter = await connectedWith({ listBySender });
    await adapter.refundEscrow();
    const ix = capturedTx(signSpy).instructions[0];
    if (!ix) throw new Error("no_instruction");
    expect(ix.keys[2]!.pubkey.toBase58()).toBe(pdaOf("rem-real").toBase58());
  });

  it("T-R0-10: sondea como máximo 10 candidatos (tope de la recuperación)", async () => {
    const ids = Array.from({ length: 14 }, (_, i) => `rem-${i}`);
    await mockChain({ "rem-13": "deposited" }); // el refundeable queda FUERA del tope
    const listBySender = vi.fn(async () => ids);
    const adapter = await connectedWith({ listBySender });
    await expect(adapter.refundEscrow()).rejects.toThrow("escrow_not_found");
    const batch = vi.mocked(Connection.prototype.getMultipleAccountsInfo);
    expect((batch.mock.calls[0]?.[0] as PublicKey[] | undefined)?.length).toBe(10);
  });

  it("T-R0-10 (fail-loud): sin resolver inyectado y sin id ⇒ escrow_id_unavailable (nunca silencioso)", async () => {
    await mockChain({ "rem-x": "deposited" });
    const adapter = await connectedWith(); // sin resolver
    await expect(adapter.refundEscrow()).rejects.toThrow("escrow_id_unavailable");
    expect(signSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("T-R0-10: el guard on-chain autoritativo NO se saltea — candidato Deposited pero pre-deadline ⇒ refund_before_deadline", async () => {
    // El batch ve Deposited (lo elige), y la re-lectura autoritativa aplica el deadline futuro.
    const id = "rem-early-recovered";
    const pda = pdaOf(id).toBase58();
    const deposited = await encodeEscrowState("deposited", Math.floor(Date.now() / 1000) + 3600);
    vi.spyOn(Connection.prototype, "getMultipleAccountsInfo").mockImplementation(
      (async (keys: PublicKey[]) =>
        keys.map((k) => (k.toBase58() === pda ? accountInfo(deposited) : null))) as never,
    );
    vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation(
      (async (k: PublicKey) => (k.toBase58() === pda ? accountInfo(deposited) : null)) as never,
    );
    const adapter = await connectedWith({ listBySender: vi.fn(async () => [id]) });
    await expect(adapter.refundEscrow()).rejects.toThrow("refund_before_deadline");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("T-R0-10: un candidato con data indecodificable se DESCARTA y la recuperación sigue con el siguiente", async () => {
    // Cuenta existente cuyos bytes no son un EscrowState (discriminator ajeno): decode lanza. Sin el
    // try/catch, un solo escrow deforme dejaría al dueño sin poder recuperar NINGUNO.
    const good = await encodeEscrowState("deposited", Math.floor(Date.now() / 1000) - 3600);
    const garbagePda = pdaOf("rem-basura").toBase58();
    const goodPda = pdaOf("rem-sana").toBase58();
    const garbage = Buffer.alloc(64, 7); // 64 bytes de basura
    vi.spyOn(Connection.prototype, "getMultipleAccountsInfo").mockImplementation(
      (async (keys: PublicKey[]) =>
        keys.map((k) =>
          k.toBase58() === garbagePda
            ? accountInfo(garbage)
            : k.toBase58() === goodPda
              ? accountInfo(good)
              : null,
        )) as never,
    );
    vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation(
      (async (k: PublicKey) => (k.toBase58() === goodPda ? accountInfo(good) : null)) as never,
    );
    const adapter = await connectedWith({ listBySender: vi.fn(async () => ["rem-basura", "rem-sana"]) });
    await expect(adapter.refundEscrow()).resolves.toEqual({ refundTx: "refund-sig-recovered" });
    const ix = capturedTx(signSpy).instructions[0];
    if (!ix) throw new Error("no_instruction");
    expect(ix.keys[2]!.pubkey.toBase58()).toBe(goodPda);
  });

  it("sin wallet conectada y sin id ⇒ wallet_not_connected ANTES de consultar el resolver", async () => {
    const listBySender = vi.fn(async () => ["rem-1"]);
    const adapter = new SolanaWalletAdapter({ listBySender }); // sin connect
    await expect(adapter.refundEscrow()).rejects.toThrow("wallet_not_connected");
    expect(listBySender).not.toHaveBeenCalled();
  });

  // El gateway es el único camino de la UI hacia refundEscrow: si no propagara el `remittanceId`
  // OPCIONAL tal cual, la recuperación de AC-2 nunca se activaría (o pasaría un id equivocado).
  it("HU-SOL-20: SolanaEscrowRefundGateway propaga (remittanceId, sender) tal cual, con y sin id", async () => {
    const refundEscrow = vi.fn(async () => ({ refundTx: "sig" }));
    const gw = new SolanaEscrowRefundGateway({ refundEscrow });
    await expect(gw.refund({ remittanceId: "rem-9", sender: SENDER_B58 })).resolves.toEqual({
      refundTx: "sig",
    });
    expect(refundEscrow).toHaveBeenLastCalledWith("rem-9", SENDER_B58);
    await gw.refund({ sender: SENDER_B58 }); // sin id ⇒ delega el fallback al adapter
    expect(refundEscrow).toHaveBeenLastCalledWith(undefined, SENDER_B58);
  });
});
