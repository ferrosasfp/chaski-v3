// Tests — SolanaWalletAdapter.refundEscrow (HU-SOL-13/AC-6/AC-7, CD-10). El SENDER firma + broadcastea
// el `refund` del escrow, SIN facilitator ni release-authority. Antes de firmar lee EscrowState on-chain
// y aborta si status≠Deposited o now<deadline. Connection mockeada (cero red, patrón solana-wallet.test).
import { sha256 } from "@noble/hashes/sha256";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemittanceIdLookup, SolanaRemittanceIdResolver } from "../application/ports";
import { ESCROW_ID_LOOKUP_CEILING } from "./escrow-lookup-limits";
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
async function encodeEscrowState(
  status: "deposited" | "released" | "refunded",
  deadlineSec: number,
): Promise<Buffer> {
  const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
  return coder.encode("EscrowState", {
    sender: SENDER_KP.publicKey,
    beneficiary: Keypair.generate().publicKey,
    authority: AUTHORITY_PK,
    mint: new PublicKey(MINT_B58),
    amount: new anchor.BN(1_000_000),
    deadline: new anchor.BN(deadlineSec),
    status:
      status === "deposited" ? { Deposited: {} } : status === "released" ? { Released: {} } : { Refunded: {} },
    bump: 255,
  });
}

/** confirmTransaction mockeado: por default confirma SIN error (el caso feliz de los tests viejos). */
function mockConfirm(result: { err: unknown } | "reject" = { err: null }) {
  return vi.spyOn(Connection.prototype, "confirmTransaction").mockImplementation((async () => {
    if (result === "reject") throw new Error("block height exceeded");
    return { context: { slot: 1 }, value: result };
  }) as never);
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
    mockConfirm(); // la confirmación es parte del camino normal: sin ella el refund no afirma nada
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

// ── Confirmación del refund: "el RPC la aceptó" NO es "la plata volvió" ──────────────────────────
// El daño que cubren estos tests: la persona firma en Phantom y tarda 40 s, el blockhash vence, la tx
// se cae — y la app le decía "Recuperaste tus fondos" con los USDC todavía en el vault, cerrando el
// camino de reintento con un estado terminal. La signature sola nunca fue evidencia de nada.
describe("SolanaWalletAdapter.refundEscrow — confirmación (tri-estado)", () => {
  const PAST_DEADLINE = () => Math.floor(Date.now() / 1000) - 3600;

  /** getAccountInfo que responde una secuencia: 1ª lectura = guard pre-firma, 2ª = probe post-envío. */
  async function mockAccountSequence(
    ...states: Array<"deposited" | "released" | "refunded" | null | "throw">
  ) {
    const datas = await Promise.all(
      states.map(async (s) =>
        s === null || s === "throw" ? s : await encodeEscrowState(s, PAST_DEADLINE()),
      ),
    );
    let i = 0;
    vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation((async () => {
      const d = datas[Math.min(i, datas.length - 1)];
      i++;
      if (d === "throw") throw new Error("rpc_down");
      return d
        ? { data: d, executable: false, lamports: 1, owner: new PublicKey(ESCROW_PROGRAM_ID), rentEpoch: 0 }
        : null;
    }) as never);
  }

  async function connected(confirmTimeoutMs = 20): Promise<SolanaWalletAdapter> {
    solanaWalletBridge.setState({ publicKey: SENDER_B58, connected: true });
    const adapter = new SolanaWalletAdapter(undefined, confirmTimeoutMs);
    await adapter.connect();
    return adapter;
  }

  beforeEach(() => {
    vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
      blockhash: FIXED_BLOCKHASH,
      lastValidBlockHeight: 42,
    } as Awaited<ReturnType<Connection["getLatestBlockhash"]>>);
    vi.spyOn(Connection.prototype, "sendRawTransaction").mockImplementation((async () =>
      "refund-sig") as never);
    const sign: ReturnType<typeof vi.fn> = vi.fn(async (tx: Transaction) => {
      tx.partialSign(SENDER_KP);
      return tx;
    });
    solanaWalletBridge.registerSignTransaction(sign);
  });
  afterEach(() => {
    solanaWalletBridge.reset();
    vi.restoreAllMocks();
  });

  it("confirmada sin error ⇒ 'confirmed', y se confirma la MISMA signature que se broadcasteó", async () => {
    await mockAccountSequence("deposited");
    const confirmSpy = mockConfirm({ err: null });
    const adapter = await connected();

    await expect(adapter.refundEscrow("rem-1")).resolves.toEqual({
      refundTx: "refund-sig",
      confirmation: "confirmed",
    });
    const arg = confirmSpy.mock.calls[0]?.[0] as unknown as {
      signature: string;
      blockhash: string;
      lastValidBlockHeight: number;
    };
    expect(arg.signature).toBe("refund-sig"); // la que devolvió sendRawTransaction, no una inventada
    expect(arg.blockhash).toBe(FIXED_BLOCKHASH); // el blockhash de ESTA tx: la estrategia de expiry
    expect(arg.lastValidBlockHeight).toBe(42);
  });

  // El caso del AR, exacto: el blockhash vence mientras la persona firma. Nadie puede decir que volvió.
  it("blockhash vencido + escrow SIGUE Deposited ⇒ 'pending' (ni éxito ni fracaso), sin tirar", async () => {
    await mockAccountSequence("deposited", "deposited");
    mockConfirm("reject");
    const adapter = await connected();

    await expect(adapter.refundEscrow("rem-1")).resolves.toEqual({
      refundTx: "refund-sig",
      confirmation: "pending",
    });
  });

  // Un blockhash vencido prueba que la tx no puede entrar DE ACÁ EN ADELANTE, no que no haya entrado.
  it("no pudimos ver la tx pero el escrow quedó Refunded ⇒ 'confirmed' (gana la fuente autoritativa)", async () => {
    await mockAccountSequence("deposited", "refunded");
    mockConfirm("reject");
    const adapter = await connected();

    await expect(adapter.refundEscrow("rem-1")).resolves.toEqual({
      refundTx: "refund-sig",
      confirmation: "confirmed",
    });
  });

  it("no pudimos ver la tx NI leer el escrow (RPC caído) ⇒ 'unknown', jamás un éxito", async () => {
    await mockAccountSequence("deposited", "throw");
    mockConfirm("reject");
    const adapter = await connected();

    await expect(adapter.refundEscrow("rem-1")).resolves.toEqual({
      refundTx: "refund-sig",
      confirmation: "unknown",
    });
  });

  // La cuenta ausente NO prueba un refund: la ix `close` la borra tanto después de un refund como de
  // un release. Ausencia = no sabemos a dónde fue la plata.
  it("escrow ya cerrado tras el envío ⇒ 'unknown' (la ausencia no es evidencia de reembolso)", async () => {
    await mockAccountSequence("deposited", null);
    mockConfirm("reject");
    const adapter = await connected();

    const out = await adapter.refundEscrow("rem-1");
    expect(out.confirmation).toBe("unknown");
  });

  it("la tx entró y REVIRTIÓ (y el escrow no está Refunded) ⇒ refund_tx_failed: un 'no' medido", async () => {
    await mockAccountSequence("deposited", "deposited");
    mockConfirm({ err: { InstructionError: [0, { Custom: 6002 }] } });
    const adapter = await connected();

    await expect(adapter.refundEscrow("rem-1")).rejects.toThrow("refund_tx_failed");
  });

  // No repetir la mentira vieja al revés: si un intento anterior ya devolvió la plata, este revert no
  // puede reportarse como "no pudimos recuperar".
  it("la tx revirtió PERO el escrow está Refunded ⇒ 'confirmed' (la plata ya había vuelto)", async () => {
    await mockAccountSequence("deposited", "refunded");
    mockConfirm({ err: "AccountNotFound" });
    const adapter = await connected();

    const out = await adapter.refundEscrow("rem-1");
    expect(out.confirmation).toBe("confirmed");
  });

  it("la confirmación que nunca responde no cuelga a la persona: vence el techo y cae al probe", async () => {
    await mockAccountSequence("deposited", "deposited");
    // Promesa que NUNCA resuelve: el websocket ausente del RPC público es exactamente esto.
    vi.spyOn(Connection.prototype, "confirmTransaction").mockImplementation(
      (() => new Promise(() => {})) as never,
    );
    const adapter = await connected(10); // techo diminuto SOLO para el test

    await expect(adapter.refundEscrow("rem-1")).resolves.toEqual({
      refundTx: "refund-sig",
      confirmation: "pending",
    });
  });

  it("el refund SIEMPRE pregunta: confirmTransaction se llama una vez por broadcast", async () => {
    await mockAccountSequence("deposited");
    const confirmSpy = mockConfirm({ err: null });
    const adapter = await connected();

    await adapter.refundEscrow("rem-1");
    expect(confirmSpy).toHaveBeenCalledTimes(1);
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

  /** La PDA del índice del sender: seeds ["escrow-index", sender]. Portada de
   *  `solana-wallet.close.test.ts`, misma derivación. */
  const ESCROW_INDEX_PDA = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow-index"), SENDER_KP.publicKey.toBuffer()],
    PROGRAM_ID,
  )[0];

  /** Los 16 bytes que la CADENA consume, en hex minúscula: la forma de un `EscrowId16`. */
  function id16Of(bytes: Uint8Array | number[]): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  /** La PDA `escrow_state` derivada DESDE los 16 bytes, sin pasar por ningún `remittanceId`. Es el
   *  camino que el índice habilita: del id16 no se vuelve al remittanceId, así que la derivación
   *  tiene que poder arrancar de los bytes. */
  function pdaOfBytes(bytes: Uint8Array | number[]): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), SENDER_KP.publicKey.toBuffer(), Buffer.from(Uint8Array.from(bytes))],
      PROGRAM_ID,
    )[0];
  }

  /** `EscrowIndex` real y DECODIFICABLE. Portado de `solana-wallet.close.test.ts`. Acepta strings
   *  (que se hashean como lo haría un depósito) o los 16 bytes crudos, que es lo que hace falta para
   *  probar el caso en que NADIE conoce el `remittanceId` de origen. */
  async function encodeEscrowIndex(entradas: Array<string | number[]> = []): Promise<Buffer> {
    const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
    return coder.encode("EscrowIndex", {
      sender: SENDER_KP.publicKey,
      version: 1,
      bump: 254,
      entries: entradas.map((e) => (typeof e === "string" ? Array.from(remittanceIdBytes16(e)) : e)),
    });
  }

  /** Qué contesta la cadena para UNA pubkey. Portado de `solana-wallet.close.test.ts`: `"throw"` es
   *  el RPC caído y `"hang"` el que acepta la conexión y no contesta. */
  type Reply = Buffer | null | "throw" | "hang";

  /** Mockea el RPC como una cadena honesta: cada PDA responde SU propio estado (o null si no existe).
   *  Así el fallback tiene que decodificar de verdad para elegir bien — un `ids[0]` a ciegas se cae.
   *
   *  WKH-347 — el segundo parámetro es lo que contesta la PDA del ÍNDICE. Sin él, esa pubkey queda sin
   *  declarar y la cadena dice `null`, o sea "el índice no existe": ése es el default y es el que
   *  cambió el desenlace de tres tests de este archivo, a propósito. */
  async function mockChain(
    states: Record<string, "deposited" | "released">,
    indice?: Reply,
    extras: Array<{ bytes: number[]; status: "deposited" | "released"; deadlineSec?: number }> = [],
  ): Promise<void> {
    const byPda = new Map<string, Reply>();
    for (const [id, st] of Object.entries(states)) {
      byPda.set(pdaOf(id).toBase58(), await encodeEscrowState(st, Math.floor(Date.now() / 1000) - 3600));
    }
    for (const e of extras) {
      byPda.set(
        pdaOfBytes(e.bytes).toBase58(),
        await encodeEscrowState(e.status, e.deadlineSec ?? Math.floor(Date.now() / 1000) - 3600),
      );
    }
    if (indice !== undefined) byPda.set(ESCROW_INDEX_PDA.toBase58(), indice);
    const buffered = (k: PublicKey): Buffer | null => {
      const r = byPda.get(k.toBase58());
      return r instanceof Buffer ? r : null;
    };
    vi.spyOn(Connection.prototype, "getMultipleAccountsInfo").mockImplementation(
      (async (keys: PublicKey[]) =>
        keys.map((k) => {
          const d = buffered(k);
          return d ? accountInfo(d) : null;
        })) as never,
    );
    vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation(
      (async (k: PublicKey) => {
        const r = byPda.get(k.toBase58());
        if (r === "throw") throw new Error("rpc_down");
        if (r === "hang") return new Promise(() => {}); // nunca resuelve
        return r instanceof Buffer ? accountInfo(r) : null;
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
    mockConfirm();
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

  async function connectedWith(resolver?: SolanaRemittanceIdResolver) {
    solanaWalletBridge.setState({ publicKey: SENDER_B58, connected: true });
    const adapter = new SolanaWalletAdapter(resolver);
    await adapter.connect();
    return adapter;
  }

  // ── T-R0-9 · AC-6 byte-idéntico: con id presente el resolver NI SE ROZA ──────────────────────────
  it("T-R0-9 (AC-6): con remittanceId presente el resolver NO se invoca (0 llamadas) y el refund sale igual", async () => {
    await mockChain({ "rem-refund-ok": "deposited" });
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: ["rem-otro"] }));
    const adapter = await connectedWith({ lookupBySender });

    const out = await adapter.refundEscrow("rem-refund-ok");
    expect(out.refundTx).toBe("refund-sig-recovered");
    expect(lookupBySender).toHaveBeenCalledTimes(0); // el path que ya funcionaba no consulta nada
    // Y refundeó EXACTAMENTE el id pedido (no el que devolvería el resolver).
    const ix = capturedTx(signSpy).instructions[0];
    if (!ix) throw new Error("no_instruction");
    expect(ix.keys[2]!.pubkey.toBase58()).toBe(pdaOf("rem-refund-ok").toBase58());
  });

  it("T-R0-9: un remittanceId vacío/whitespace NO cuenta como presente (cae al fallback)", async () => {
    await mockChain({ "rem-recovered": "deposited" });
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: ["rem-recovered"] }));
    const adapter = await connectedWith({ lookupBySender });
    await expect(adapter.refundEscrow("   ")).resolves.toEqual({
      refundTx: "refund-sig-recovered",
      confirmation: "confirmed",
    });
    expect(lookupBySender).toHaveBeenCalledTimes(1);
  });

  // ── T-R0-10 · AC-2: elige el candidato Deposited leyendo la cadena ───────────────────────────────
  it("T-R0-10 (AC-2/CD-10): sin id, con 2 candidatos (1º Released, 2º Deposited) ⇒ refundea el 2º; feePayer=sender", async () => {
    await mockChain({ "rem-released": "released", "rem-deposited": "deposited" });
    // Orden created_at desc tal como llega del ledger: el primero NO es refundeable.
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: ["rem-released", "rem-deposited"] }));
    const adapter = await connectedWith({ lookupBySender });

    const out = await adapter.refundEscrow(); // ← sin remittanceId: el caso que hoy pierde la plata
    expect(out.refundTx).toBe("refund-sig-recovered");
    expect(lookupBySender).toHaveBeenCalledTimes(1);
    expect(lookupBySender).toHaveBeenCalledWith(SENDER_B58);

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
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: ["rem-1", "rem-2", "rem-3"] }));
    const adapter = await connectedWith({ lookupBySender });
    await adapter.refundEscrow();
    const batch = vi.mocked(Connection.prototype.getMultipleAccountsInfo);
    expect(batch).toHaveBeenCalledTimes(1);
    expect((batch.mock.calls[0]?.[0] as PublicKey[] | undefined)?.length).toBe(3);
  });

  // 🔴 EL CONTROL UNITARIO DE AC-3 (WKH-331). Hasta esta HU el doble de acá era `async () => []`: una
  // lista vacía que no decía de dónde venía, y que por construcción representaba igual de bien "el
  // servidor contestó que no hay nada" que "nunca preguntamos". Ahora dice `answered`, y recién ahí el
  // nombre del test es cierto. Sus tres `expect` no se debilitan: son lo que se pone rojo si el
  // arreglo se pasa de largo y convierte también este caso en un "no llegamos a preguntar".
  // 🔴 PARTIDO EN DOS POR WKH-347, y el desenlace del primero CAMBIÓ a propósito. Hasta esta HU el
  // ledger era la única fuente, así que "el servidor contestó y no tiene ids" agotaba la búsqueda.
  // Ahora hay una segunda fuente —el índice on-chain, derivable de la pubkey del remitente sola— y
  // hay que decir CUÁL de las dos cosas pasó: que el índice no exista NO es "no tenés nada".
  it("T-R0-10 (a): 0 candidatos en el ledger y SIN índice on-chain ⇒ escrow_index_absent, SIN firmar ni broadcastear", async () => {
    await mockChain({}); // la PDA del índice queda sin declarar ⇒ la cadena dice que no existe
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: [] }));
    const adapter = await connectedWith({ lookupBySender });
    await expect(adapter.refundEscrow()).rejects.toThrow("escrow_index_absent");
    expect(signSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("T-R0-10 (b): 0 candidatos en el ledger y el índice EXISTE y está VACÍO ⇒ escrow_not_found, SIN firmar ni broadcastear", async () => {
    // Éste sí conserva el código de siempre, y por la misma razón de siempre: las DOS fuentes
    // contestaron y ninguna lista nada. Es la única forma de este test en que la frase de la pantalla
    // ("no encontramos escrows abiertos") es cierta.
    await mockChain({}, await encodeEscrowIndex([]));
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: [] }));
    const adapter = await connectedWith({ lookupBySender });
    await expect(adapter.refundEscrow()).rejects.toThrow("escrow_not_found");
    expect(signSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  // 🔴 MISMO TRATAMIENTO, y este par es el que prueba que la segunda fuente se consulta también en el
  // SEGUNDO punto donde el camino del ledger se queda sin nada (recorrió los candidatos y ninguno
  // está Deposited), no sólo en el primero. Implementar sólo el primero dejaría el resultado colgado
  // de si la persona casualmente tiene una remesa vieja e irrelevante guardada.
  it("T-R0-10 (a): candidatos del ledger que existen pero NINGUNO está Deposited, y sin índice ⇒ escrow_index_absent", async () => {
    await mockChain({ "rem-a": "released", "rem-b": "released" });
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: ["rem-a", "rem-b"] }));
    const adapter = await connectedWith({ lookupBySender });
    await expect(adapter.refundEscrow()).rejects.toThrow("escrow_index_absent");
    expect(signSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("T-R0-10 (b): candidatos del ledger sin ninguno Deposited y el índice EXISTE y está VACÍO ⇒ escrow_not_found", async () => {
    await mockChain({ "rem-a": "released", "rem-b": "released" }, await encodeEscrowIndex([]));
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: ["rem-a", "rem-b"] }));
    const adapter = await connectedWith({ lookupBySender });
    await expect(adapter.refundEscrow()).rejects.toThrow("escrow_not_found");
    expect(signSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("T-R0-10: candidatos cuya PDA no existe on-chain se saltan (null ⇒ no candidata)", async () => {
    await mockChain({ "rem-real": "deposited" }); // "rem-fantasma" no tiene cuenta
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: ["rem-fantasma", "rem-real"] }));
    const adapter = await connectedWith({ lookupBySender });
    await adapter.refundEscrow();
    const ix = capturedTx(signSpy).instructions[0];
    if (!ix) throw new Error("no_instruction");
    expect(ix.keys[2]!.pubkey.toBase58()).toBe(pdaOf("rem-real").toBase58());
  });

  // 🔴 ESTE TEST AFIRMABA EL DEFECTO. Su versión anterior usaba 14 ids con el refundeable en el 13 y
  // esperaba `escrow_not_found` "porque queda FUERA del tope", con el lote clavado en 10. O sea que
  // pinneaba como correcto que la persona NO recuperara su principal teniendo la route ya devuelta la
  // fila. El tope del cliente era 10 y el de la route 20: se descartaba la mitad, gratis, porque el
  // sondeo es UNA sola llamada `getMultipleAccounts` para 10 o para 20.
  it("T-R0-10a: un refundeable en la posición 13 de 14 SÍ se recupera (antes se descartaba)", async () => {
    const ids = Array.from({ length: 14 }, (_, i) => `rem-${i}`);
    await mockChain({ "rem-13": "deposited" });
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: ids }));
    const adapter = await connectedWith({ lookupBySender });
    await adapter.refundEscrow(); // no tira: 14 <= ESCROW_ID_LOOKUP_CEILING
    const ix = capturedTx(signSpy).instructions[0];
    if (!ix) throw new Error("no_instruction");
    expect(ix.keys[2]!.pubkey.toBase58()).toBe(pdaOf("rem-13").toBase58());
  });

  // El techo SIGUE existiendo y sigue teniendo un borde: lo que cambió es dónde está, no que no esté.
  // Se afirma contra la constante y no contra un literal, porque un literal acá es la mitad del bug que
  // este cambio arregla — el número tiene que venir del mismo lugar que lo decide.
  it("T-R0-10b: más allá del techo el candidato no se sondea, y el lote es exactamente el techo", async () => {
    const ids = Array.from({ length: ESCROW_ID_LOOKUP_CEILING + 4 }, (_, i) => `rem-${i}`);
    await mockChain({ [`rem-${ESCROW_ID_LOOKUP_CEILING + 3}`]: "deposited" }); // fuera del techo
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: ids }));
    const adapter = await connectedWith({ lookupBySender });
    // 🔴 EL CÓDIGO CAMBIÓ EN WKH-347 y el assert que importa NO: agotado el ledger se consulta la
    // segunda fuente, y acá el índice no existe. Lo que este test candea sigue siendo el TECHO del
    // lote del ledger, que es la línea de abajo y quedó intacta.
    await expect(adapter.refundEscrow()).rejects.toThrow("escrow_index_absent");
    const batch = vi.mocked(Connection.prototype.getMultipleAccountsInfo);
    expect((batch.mock.calls[0]?.[0] as PublicKey[] | undefined)?.length).toBe(ESCROW_ID_LOOKUP_CEILING);
  });

  // ── WKH-331 · AC-1 + CD-7: los TRES desenlaces en que no se llegó a preguntar ────────────────────
  // 🔴 Se leen JUNTO al control de arriba (`answered` con lista vacía). Los cuatro terminan sin ningún
  // candidato, y sólo aquél puede decir `escrow_not_found`: es el único en que el servidor contestó.
  // Los tres de acá salen por un código propio, y el corte tiene que ocurrir ANTES de tocar la cadena
  // y ANTES de pedir ninguna firma — eso se AFIRMA, no se supone.
  for (const reason of ["pop_disabled", "registry_disabled", "pop_rejected"] as const) {
    it(`T-R0-10 (AC-1): el resolver no pudo preguntar (${reason}) ⇒ escrow_recovery_unavailable:${reason}, 🚫 nunca escrow_not_found`, async () => {
      await mockChain({});
      const lookupBySender = vi.fn(
        async (): Promise<RemittanceIdLookup> => ({ outcome: "not_asked", reason }),
      );
      const adapter = await connectedWith({ lookupBySender });

      // El prefijo es el que el copy reconoce; la cola distingue los tres desenlaces acá y en ningún
      // otro lado: la pantalla descarta el código (AR/MNR-4). O sea que este `expect` es el único
      // lugar donde el motivo se mira, y por eso se exige entero y no sólo el prefijo.
      await expect(adapter.refundEscrow()).rejects.toThrow(`escrow_recovery_unavailable:${reason}`);
      expect(vi.mocked(Connection.prototype.getMultipleAccountsInfo)).not.toHaveBeenCalled();
      expect(signSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // WKH-347 · la SEGUNDA fuente: el índice on-chain del remitente
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // El índice se deriva de `["escrow-index", sender]`, o sea de la pubkey sola. Por eso sigue
  // alcanzable justo cuando el `remittanceId` se perdió, que es el caso que deja los fondos
  // inalcanzables. Lo que NO es: autoritativo sobre el estado de un escrow. Dice que alguna vez se
  // registró; el estado lo dice la cuenta, y esos guards corren igual.

  it("T-347-9 (AC-3): el ledger contestó SIN ids y el índice tiene 3 entradas, una Deposited ⇒ refundea ESA", async () => {
    const bytes = Array.from(remittanceIdBytes16("rem-en-el-indice"));
    await mockChain(
      {},
      await encodeEscrowIndex(["rem-idx-viejo", "rem-en-el-indice", "rem-idx-otro"]),
      [{ bytes, status: "deposited" }],
    );
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: [] }));
    const adapter = await connectedWith({ lookupBySender });

    const out = await adapter.refundEscrow();
    expect(out.refundTx).toBe("refund-sig-recovered");
    // El registro durable se consultó UNA vez y no se lo volvió a molestar: el índice no le pregunta
    // nada al servidor, que es justamente lo que lo hace útil cuando el servidor no tiene el dato.
    expect(lookupBySender).toHaveBeenCalledTimes(1);

    const ix = capturedTx(signSpy).instructions[0];
    if (!ix) throw new Error("no_instruction");
    // La PDA refundeada es la de la entrada Deposited, no la de la primera del índice: prueba que se
    // LEYÓ el estado on-chain de cada candidata y no se tomó `entries[0]` a ciegas.
    expect(ix.keys[2]!.pubkey.toBase58()).toBe(pdaOfBytes(bytes).toBase58());
    expect(ix.keys[2]!.pubkey.toBase58()).not.toBe(pdaOf("rem-idx-viejo").toBase58());
  });

  // T-347-10 — TRES inputs, TRES códigos DISTINTOS. Si dos coincidieran, la pantalla estaría diciendo
  // lo mismo sobre situaciones que autorizan afirmaciones distintas, que es el defecto que esta HU no
  // puede introducir.
  it("T-347-10 (AC-3/AC-11): índice ausente, ilegible y vacío dan TRES códigos distintos", async () => {
    const lookup = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: [] }));

    // (a) la cadena CONTESTÓ: la PDA no existe. NO es "no tenés nada": también es compatible con
    // haber depositado antes de que se registrara, o con no haber podido registrar en su momento.
    await mockChain({});
    await expect((await connectedWith({ lookupBySender: lookup })).refundEscrow()).rejects.toThrow(
      "escrow_index_absent",
    );

    // (b) NO se pudo preguntar. No dice absolutamente nada sobre los fondos.
    await mockChain({}, "throw");
    await expect((await connectedWith({ lookupBySender: lookup })).refundEscrow()).rejects.toThrow(
      "escrow_index_unreadable",
    );

    // (c) el índice EXISTE y no lista nada. Recién acá se agotaron las dos fuentes.
    await mockChain({}, await encodeEscrowIndex([]));
    await expect((await connectedWith({ lookupBySender: lookup })).refundEscrow()).rejects.toThrow(
      "escrow_not_found",
    );

    // Y que los tres sean DISTINTOS entre sí, escrito como assert y no como lectura del test: un
    // copiar-pegar que dejara dos iguales pasaría los tres `rejects` de arriba.
    expect(new Set(["escrow_index_absent", "escrow_index_unreadable", "escrow_not_found"]).size).toBe(3);
  });

  // T-347-10 (d) — EL QUINTO DESENLACE SIN NOMBRE. Los cuatro de §7.3 son cuatro, y todo lo que no sea
  // uno de ellos es un quinto sin nombre. `probeEscrowIndex` atrapa lo SUYO (el techo, el RPC de la
  // sonda, el decode), pero el resto del camino del índice no lo atrapaba nadie: los `await import()`,
  // el `new PublicKey(sender)`, la derivación de las PDAs de los candidatos y la llamada batch que los
  // sondea. Un error de ahí escapaba CRUDO hasta la red de seguridad de la pantalla, que dice "no
  // sabemos hasta dónde llegamos" — y sí sabíamos: no pudimos leer el índice.
  //
  // 🔴 EL INPUT QUE LO PONE EN ROJO: sacar el mapeo de `resolveFromEscrowIndex`. Sin él esto rechaza con
  // "batch_down" y las dos aserciones se caen. Y NO lo cubre T-347-10: sus tres inputs fallan ADENTRO
  // de `probeEscrowIndex`, que ya los atrapaba solo.
  it("T-347-10 (d): el índice se leyó pero el SONDEO de candidatos falla ⇒ escrow_index_unreadable, nunca el error crudo", async () => {
    const lookup = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: [] }));
    await mockChain({}, await encodeEscrowIndex(["rem-idx-0", "rem-idx-1"]));
    // La sonda del índice YA contestó `present`. Lo que falla es la llamada de DESPUÉS, que está fuera
    // del try/catch de `probeEscrowIndex`.
    vi.spyOn(Connection.prototype, "getMultipleAccountsInfo").mockImplementation((async () => {
      throw new Error("batch_down");
    }) as never);

    const adapter = await connectedWith({ lookupBySender: lookup });
    // `then(ok, err)` y no `.catch(...)`: con `.catch` el tipo queda `Error | SolanaEscrowRefundResult`
    // y `tsc` rechaza leerle `.message`. Acá el camino feliz devuelve `null`, así que si NO rechazara,
    // el assert de abajo compara `undefined` y falla diciéndolo.
    const err = await adapter.refundEscrow().then(
      () => null,
      (e: unknown) => e as Error,
    );
    // Igualdad EXACTA y no `toThrow`: es lo que prueba que el mensaje crudo de la dependencia no viaja
    // pegado al código. Esta cadena llega a `lostEscrowRecoveryError`, y "batch_down" no es un enum que
    // la pantalla pueda traducir.
    expect(err?.message).toBe("escrow_index_unreadable");
  });

  it("T-347-11 (CD-15): el índice se sondea ENTERO — 32 entradas, la Deposited en la posición 31", async () => {
    // 🔴 EL INPUT QUE LO PONE EN ROJO: aplicarle `MAX_RECOVERY_CANDIDATES` (20) a las entradas del
    // índice. Ese techo es el de la ROUTE del registro durable, que es OTRA fuente; el índice no
    // tiene servidor y `getMultipleAccountsInfo` sondea 32 en la misma llamada que 20. Recortarlas
    // sería tirar hasta 12 candidatos del camino que devuelve el principal.
    const entradas = Array.from({ length: 32 }, (_, i) => `rem-idx-${i}`);
    const bytesUltima = Array.from(remittanceIdBytes16(entradas[31] as string));
    await mockChain({}, await encodeEscrowIndex(entradas), [{ bytes: bytesUltima, status: "deposited" }]);
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: [] }));
    const adapter = await connectedWith({ lookupBySender });

    await adapter.refundEscrow();
    const ix = capturedTx(signSpy).instructions[0];
    if (!ix) throw new Error("no_instruction");
    expect(ix.keys[2]!.pubkey.toBase58()).toBe(pdaOfBytes(bytesUltima).toBase58());
    // Y el lote sondeado son las 32, no el techo del ledger.
    const batch = vi.mocked(Connection.prototype.getMultipleAccountsInfo);
    const ultimo = batch.mock.calls[batch.mock.calls.length - 1]?.[0] as PublicKey[] | undefined;
    expect(ultimo?.length).toBe(32);
    expect(ultimo?.length).not.toBe(ESCROW_ID_LOOKUP_CEILING);
  });

  // T-347-12 (AC-4) — el caso que sólo el índice puede resolver: 16 bytes que NO son el sha256 de
  // ningún string conocido. Nadie, ni el servidor ni el navegador, puede producir el `remittanceId`
  // de origen, porque sha256 no se invierte. La recuperación tiene que funcionar igual, operando por
  // los bytes, y los guards autoritativos tienen que correr COMPLETOS.
  const BYTES_SIN_ORIGEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

  it("T-347-12 (AC-4): un id16 sin `remittanceId` conocido se refundea igual, derivando la PDA de los bytes", async () => {
    await mockChain({}, await encodeEscrowIndex([BYTES_SIN_ORIGEN]), [
      { bytes: BYTES_SIN_ORIGEN, status: "deposited" },
    ]);
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: [] }));
    const adapter = await connectedWith({ lookupBySender });

    await adapter.refundEscrow();
    const ix = capturedTx(signSpy).instructions[0];
    if (!ix) throw new Error("no_instruction");
    expect(ix.keys[2]!.pubkey.toBase58()).toBe(pdaOfBytes(BYTES_SIN_ORIGEN).toBase58());
    // Y el arg de la ix `refund` son ESOS 16 bytes, no otros: 8 del discriminador + 16 del id.
    expect(Array.from(ix.data.subarray(8, 24))).toEqual(BYTES_SIN_ORIGEN);
    // La forma hex del mismo valor, que es lo que este repo llama `EscrowId16`.
    expect(id16Of(BYTES_SIN_ORIGEN)).toBe("0102030405060708090a0b0c0d0e0f10");
  });

  it("T-347-12 (AC-4/CD-6): el guard de estado corre igual para el candidato del índice ⇒ escrow_not_deposited", async () => {
    await mockChain({}, await encodeEscrowIndex([BYTES_SIN_ORIGEN]), [
      { bytes: BYTES_SIN_ORIGEN, status: "released" },
    ]);
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: [] }));
    const adapter = await connectedWith({ lookupBySender });
    // El índice listaba la entrada y aun así no se firma nada: el índice NO es autoritativo sobre el
    // estado. Sale por `escrow_not_found` del selector, que descarta a la no-Deposited.
    await expect(adapter.refundEscrow()).rejects.toThrow("escrow_not_found");
    expect(signSpy).not.toHaveBeenCalled();
  });

  it("T-347-12 (AC-4/CD-6): el guard de deadline corre igual para el candidato del índice ⇒ refund_before_deadline", async () => {
    await mockChain({}, await encodeEscrowIndex([BYTES_SIN_ORIGEN]), [
      { bytes: BYTES_SIN_ORIGEN, status: "deposited", deadlineSec: Math.floor(Date.now() / 1000) + 3600 },
    ]);
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: [] }));
    const adapter = await connectedWith({ lookupBySender });
    // El escrow está Deposited y el índice lo lista, pero la ventana de custodia sigue abierta: el
    // guard pre-firma corta igual que para cualquier otro camino de entrada.
    await expect(adapter.refundEscrow()).rejects.toThrow("refund_before_deadline");
    expect(signSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
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
    const adapter = await connectedWith({ lookupBySender: vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: [id] })) });
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
    const adapter = await connectedWith({
      lookupBySender: vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: ["rem-basura", "rem-sana"] })),
    });
    await expect(adapter.refundEscrow()).resolves.toEqual({
      refundTx: "refund-sig-recovered",
      confirmation: "confirmed",
    });
    const ix = capturedTx(signSpy).instructions[0];
    if (!ix) throw new Error("no_instruction");
    expect(ix.keys[2]!.pubkey.toBase58()).toBe(goodPda);
  });

  // ── WKH-331 · AR/BLQ-BAJO-1: CUÁL de las dos firmas no se completó ───────────────────────────────
  // 🔴 En la recuperación hay DOS firmas (posesión adentro del resolver, orden acá) y la billetera
  // escribe el MISMO texto para las dos. Sin etiquetar la fase, el copy de la pantalla dice "no
  // llegamos a preguntar" cuando ya preguntamos, miramos y encontramos un escrow abierto. Lo que sale
  // por acá es lo único que puede distinguirlas. La junta con el copy la mide
  // `refund-perdido-junta.test.ts`.
  it("T-R0-11 (AR/BLQ-BAJO-1): sin id, la firma de la ORDEN rechazada ⇒ escrow_refund_signature_incomplete", async () => {
    await mockChain({ "rem-deposited": "deposited" });
    signSpy.mockRejectedValue(new Error("User rejected the request."));
    const adapter = await connectedWith({
      lookupBySender: vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: ["rem-deposited"] })),
    });

    await expect(adapter.refundEscrow()).rejects.toThrow("escrow_refund_signature_incomplete");
    // Y no se llegó a broadcastear nada: la etiqueta habla de una firma que no ocurrió, no de una tx.
    expect(sendSpy).not.toHaveBeenCalled();
  });

  // El otro lado de CD-4/AC-6: con el id presente hay UNA sola firma, no hay ambigüedad que resolver,
  // y el camino que ya funcionaba propaga EXACTAMENTE lo que propagaba. Sin este control, el etiquetado
  // de arriba podría tragarse el mensaje de la billetera también donde nadie lo pidió.
  it("T-R0-11 (CD-4): con id presente la firma rechazada propaga el texto de la billetera SIN re-etiquetar", async () => {
    await mockChain({ "rem-deposited": "deposited" });
    signSpy.mockRejectedValue(new Error("User rejected the request."));
    const adapter = await connectedWith({
      lookupBySender: vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: ["rem-otro"] })),
    });

    await expect(adapter.refundEscrow("rem-deposited")).rejects.toThrow("User rejected the request.");
    await expect(adapter.refundEscrow("rem-deposited")).rejects.not.toThrow(
      "escrow_refund_signature_incomplete",
    );
  });

  it("sin wallet conectada y sin id ⇒ wallet_not_connected ANTES de consultar el resolver", async () => {
    const lookupBySender = vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: ["rem-1"] }));
    const adapter = new SolanaWalletAdapter({ lookupBySender }); // sin connect
    await expect(adapter.refundEscrow()).rejects.toThrow("wallet_not_connected");
    expect(lookupBySender).not.toHaveBeenCalled();
  });

  // El gateway es el único camino de la UI hacia refundEscrow: si no propagara el `remittanceId`
  // OPCIONAL tal cual, la recuperación de AC-2 nunca se activaría (o pasaría un id equivocado).
  it("HU-SOL-20: SolanaEscrowRefundGateway propaga (remittanceId, sender) tal cual, con y sin id", async () => {
    const refundEscrow = vi.fn(async () => ({ refundTx: "sig", confirmation: "pending" as const }));
    const gw = new SolanaEscrowRefundGateway({ refundEscrow });
    // Y propaga el `confirmation` SIN ascenderlo: un gateway que devolviera "confirmed" acá volvería
    // a poner la afirmación no verificada arriba de la cadena.
    await expect(gw.refund({ remittanceId: "rem-9", sender: SENDER_B58 })).resolves.toEqual({
      refundTx: "sig",
      confirmation: "pending",
    });
    expect(refundEscrow).toHaveBeenLastCalledWith("rem-9", SENDER_B58);
    await gw.refund({ sender: SENDER_B58 }); // sin id ⇒ delega el fallback al adapter
    expect(refundEscrow).toHaveBeenLastCalledWith(undefined, SENDER_B58);
  });
});
