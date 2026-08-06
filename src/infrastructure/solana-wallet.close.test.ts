// Tests — SolanaWalletAdapter.closeEscrow (WKH-327 / AC-1..AC-5). El SENDER firma + broadcastea el
// `close` del escrow: barre el vault hacia su ATA, cierra `escrow_state` y el `vault` devolviéndole los
// 4.002.000 lamports de alquiler que él mismo pagó en el `deposit`, y saca la entrada del índice.
// Connection mockeada (cero red, patrón solana-wallet.refund.test).
//
// ⚠️ El doble de cadena de este archivo mapea POR PUBKEY (CD-14). `closeEscrow` hace DOS lecturas de
// PDAs DISTINTAS — el `escrow_state` (guard pre-firma) y el `escrow-index` (la sonda de AC-1/AC-2) — y
// un doble que responda por ORDEN DE LLAMADA le da al índice la respuesta del escrow: el test pasa en
// verde sin haber probado nada. El exemplar correcto es `mockChain` (solana-wallet.refund.test.ts:346),
// NO `mockAccountInfo` (:56), que devuelve lo mismo para toda pubkey.
import { sha256 } from "@noble/hashes/sha256";
import * as anchor from "@coral-xyz/anchor";
import type { Idl, Provider } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  type Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SolanaEscrowCloseGateway } from "./escrow/solana-escrow-close-gateway";
import { SolanaWalletAdapter } from "./solana-wallet";
import { escrowIdl } from "./solana/escrow-idl";
import { solanaWalletBridge } from "./solana-wallet-bridge";

const ESCROW_PROGRAM_ID = "DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x";
const CLOSE_DISCRIMINATOR = [98, 165, 201, 177, 108, 65, 206, 96];
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MINT_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const FIXED_BLOCKHASH = Keypair.generate().publicKey.toBase58();

const SENDER_KP = Keypair.generate();
const SENDER_B58 = SENDER_KP.publicKey.toBase58();
const AUTHORITY_PK = Keypair.generate().publicKey; // release-authority on-chain — NUNCA debe firmar

const PROGRAM_ID = new PublicKey(ESCROW_PROGRAM_ID);

function remittanceIdBytes16(remittanceId: string): Uint8Array {
  return Uint8Array.from(sha256(new TextEncoder().encode(remittanceId)).subarray(0, 16));
}

/** La MISMA derivación que `deriveEscrowState`, `solana-wallet.ts:258`. */
function escrowStatePdaOf(remittanceId: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), SENDER_KP.publicKey.toBuffer(), Buffer.from(remittanceIdBytes16(remittanceId))],
    PROGRAM_ID,
  )[0];
}

/** La PDA del índice del sender: seeds ["escrow-index", sender] (escrow-idl.ts:301-328). */
const ESCROW_INDEX_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from("escrow-index"), SENDER_KP.publicKey.toBuffer()],
  PROGRAM_ID,
)[0];

async function encodeEscrowState(
  status: "deposited" | "released" | "refunded",
  deadlineSec = Math.floor(Date.now() / 1000) - 3600,
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
      status === "deposited"
        ? { Deposited: {} }
        : status === "released"
          ? { Released: {} }
          : { Refunded: {} },
    bump: 255,
  });
}

/** EscrowIndex real y DECODIFICABLE: { sender, version, bump, entries: Vec<[u8;16]> }
 *  (escrow-idl.ts:1330-1360). Que decodifique es la mitad del punto de AC-2: la sonda no acepta
 *  "hay bytes en esa dirección", exige que sean el índice de ESTE sender. */
async function encodeEscrowIndex(entryIds: string[] = []): Promise<Buffer> {
  const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
  return coder.encode("EscrowIndex", {
    sender: SENDER_KP.publicKey,
    version: 1,
    bump: 254,
    entries: entryIds.map((id) => Array.from(remittanceIdBytes16(id))),
  });
}

function mockConfirm(result: { err: unknown } | "reject" | "hang" = { err: null }) {
  return vi.spyOn(Connection.prototype, "confirmTransaction").mockImplementation((async () => {
    if (result === "hang") return new Promise(() => {}); // el websocket ausente del RPC público
    if (result === "reject") throw new Error("block height exceeded");
    return { context: { slot: 1 }, value: result };
  }) as never);
}

/** Qué contesta la cadena para UNA pubkey. Un array = la MISMA cuenta a lo largo del tiempo (la
 *  lectura pre-firma y la sonda post-broadcast leen `escrow_state` dos veces y puede haber cambiado);
 *  el último elemento se repite. Eso NO es mapear por orden de llamada: la pubkey sigue eligiendo la
 *  respuesta, y una pubkey que nadie declaró contesta `null`, nunca la respuesta de otra cuenta. */
type Reply = Buffer | null | "throw" | "hang";

function accountInfo(data: Buffer) {
  return { data, executable: false, lamports: 1, owner: PROGRAM_ID, rentEpoch: 0 };
}

function mockChain(byPda: Record<string, Reply | Reply[]>): void {
  const seen = new Map<string, number>();
  vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation((async (k: PublicKey) => {
    const key = k.toBase58();
    const entry = byPda[key];
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    let reply: Reply;
    if (entry === undefined) {
      reply = null; // pubkey no declarada ⇒ la cadena dice "no existe" (jamás lo de otra cuenta)
    } else if (Array.isArray(entry)) {
      reply = entry[Math.min(n, entry.length - 1)] ?? null;
    } else {
      reply = entry;
    }
    if (reply === "throw") throw new Error("rpc_down");
    if (reply === "hang") return new Promise(() => {}); // nunca resuelve
    return reply ? accountInfo(reply) : null;
  }) as never);
}

function capturedTx(spy: ReturnType<typeof vi.fn>): Transaction {
  const call = spy.mock.calls[0];
  if (!call) throw new Error("signTransaction_not_called");
  return call[0] as Transaction;
}

function closeIx(spy: ReturnType<typeof vi.fn>): TransactionInstruction {
  const ix = capturedTx(spy).instructions[0];
  if (!ix) throw new Error("no_instruction");
  return ix;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// W0.c · CARACTERIZACIÓN de @coral-xyz/anchor 0.30.1 — la cuenta opcional omitida NO se omite
// ════════════════════════════════════════════════════════════════════════════════════════════════
// Este describe NO prueba producción: prueba la LIBRERÍA, por el mismo camino que usa producción
// (`new anchor.Program(idl, { connection })` → `.methods.close(...)` → `.accounts({...})` →
// `.instruction()`). Existe porque el footgun que ataca AC-1 vive acá abajo y no lo ve el compilador.
//
// Lo que fija, y que ninguna prosa reemplaza: las CUATRO formas de escribir la 7ª cuenta producen
// `keys.length === 7`, así que `expect(ix.keys.length).toBe(7)` es un guard que aplaude cualquier cosa.
// Lo único que discrimina es QUÉ HAY en `keys[6]`.
//
// Si un bump de anchor cambia este comportamiento, este test lo dice antes que producción.
//
// LÍMITE, dicho: esto mide qué BYTES arma el cliente. NO mide qué hace el validador con ellos. Que la
// forma "clave ausente" revierta `AccountNotInitialized` (3012) es un hecho de runtime que vive fuera
// de este repo y que acá NO SE PUDO VERIFICAR.
describe("caracterización de @coral-xyz/anchor 0.30.1: la cuenta opcional omitida NO se omite", () => {
  const REM_ID = "rem-caracterizacion";

  async function buildClose(
    accountsExtra: Record<string, PublicKey | null>,
  ): Promise<TransactionInstruction> {
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const connection = new Connection("http://127.0.0.1:8899"); // nunca se usa: no hay llamada de red
    const program = new anchor.Program(escrowIdl as unknown as Idl, { connection } as Provider);
    const methods = program.methods as unknown as {
      close: (...args: unknown[]) => {
        accounts: (a: Record<string, PublicKey | null>) => {
          instruction: () => Promise<TransactionInstruction>;
        };
      };
    };
    const escrowStatePda = escrowStatePdaOf(REM_ID);
    const mintPk = new PublicKey(MINT_B58);
    return methods
      .close(Array.from(remittanceIdBytes16(REM_ID)))
      .accounts({
        sender: SENDER_KP.publicKey,
        mint: mintPk,
        escrowState: escrowStatePda,
        vault: getAssociatedTokenAddressSync(mintPk, escrowStatePda, true),
        senderAta: getAssociatedTokenAddressSync(mintPk, SENDER_KP.publicKey),
        ...accountsExtra,
      })
      .instruction();
  }

  // Este `it` nació ROJO a propósito (CD-10, W0.c): se escribió assertando
  // `expect(ix.keys[6]!.pubkey.toBase58()).toBe(ESCROW_PROGRAM_ID)` con la clave ausente, y la corrida
  // devolvió la PDA del índice. Ésa fue la evidencia de que la aserción DISCRIMINA: sin ese rojo, un
  // verde no distingue "escribí la aserción bien" de "escribí una aserción que pasa igual". Invertido,
  // queda como caracterización permanente de la librería.
  it("con la clave `escrowIndex` AUSENTE, keys[6] es la PDA del índice y viene writable (NO se omitió)", async () => {
    const ix = await buildClose({}); // ← la clave no está en el objeto
    expect(ix.keys[6]!.pubkey.toBase58()).toBe(ESCROW_INDEX_PDA.toBase58());
    expect(ix.keys[6]!.isWritable).toBe(true);
    expect(ix.keys[6]!.pubkey.toBase58()).not.toBe(ESCROW_PROGRAM_ID);
    expect(ix.keys.length).toBe(7); // secundaria: NO discrimina nada (las 4 formas dan 7)
  });

  it("con `escrowIndex: undefined`, keys[6] es la PDA del índice: idéntico a omitir la clave (M6)", async () => {
    // La trampa que TypeScript no ve: una variable `PublicKey | null` que en algún camino recibe
    // `undefined` (un `?.`, un campo opcional, un `find()` que no encontró) reintroduce el bug sin que
    // el tipo se queje. Por eso CD-11 exige que el valor venga de una unión DISCRIMINADA.
    const ix = await buildClose({ escrowIndex: undefined as unknown as null });
    expect(ix.keys[6]!.pubkey.toBase58()).toBe(ESCROW_INDEX_PDA.toBase58());
    expect(ix.keys[6]!.isWritable).toBe(true);
  });

  it("con `escrowIndex: null` EXPLÍCITO, keys[6] es el program id y NO es writable: ésta sí omite", async () => {
    const ix = await buildClose({ escrowIndex: null });
    expect(ix.keys[6]!.pubkey.toBase58()).toBe(ESCROW_PROGRAM_ID);
    expect(ix.keys[6]!.isWritable).toBe(false);
    expect(ix.keys.length).toBe(7); // el MISMO 7 que las otras formas: por eso no sirve de aserción
  });

  it("con la PDA del índice PASADA, keys[6] es esa PDA y viene writable", async () => {
    const ix = await buildClose({ escrowIndex: ESCROW_INDEX_PDA });
    expect(ix.keys[6]!.pubkey.toBase58()).toBe(ESCROW_INDEX_PDA.toBase58());
    expect(ix.keys[6]!.isWritable).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC-1..AC-5 · closeEscrow en el adapter
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("SolanaWalletAdapter.closeEscrow (WKH-327)", () => {
  let signSpy: ReturnType<typeof vi.fn>;
  let sendSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
      blockhash: FIXED_BLOCKHASH,
      lastValidBlockHeight: 42,
    } as Awaited<ReturnType<Connection["getLatestBlockhash"]>>);
    sendSpy = vi.fn(async () => "close-sig-broadcasted");
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
    vi.useRealTimers();
  });

  async function connected(confirmTimeoutMs = 20): Promise<SolanaWalletAdapter> {
    solanaWalletBridge.setState({ publicKey: SENDER_B58, connected: true });
    const adapter = new SolanaWalletAdapter(undefined, confirmTimeoutMs);
    await adapter.connect();
    return adapter;
  }

  // ── AC-1 ────────────────────────────────────────────────────────────────────────────────────────
  it("AC-1: índice INEXISTENTE on-chain ⇒ keys[6] es el program id y NO es writable (`null` explícito)", async () => {
    const REM = "rem-sin-indice";
    mockChain({
      [escrowStatePdaOf(REM).toBase58()]: [await encodeEscrowState("released"), null],
      [ESCROW_INDEX_PDA.toBase58()]: null, // la cadena CONTESTÓ: no existe
    });
    const adapter = await connected();

    await adapter.closeEscrow(REM);
    const ix = closeIx(signSpy);
    expect(ix.keys[6]!.pubkey.toBase58()).toBe(ESCROW_PROGRAM_ID);
    expect(ix.keys[6]!.isWritable).toBe(false);
    expect(ix.keys[6]!.pubkey.toBase58()).not.toBe(ESCROW_INDEX_PDA.toBase58());
    expect(ix.keys.length).toBe(7); // CD-12: secundaria — las 4 formas del footgun dan 7
  });

  // ── AC-2 ────────────────────────────────────────────────────────────────────────────────────────
  // L-2: sólo la mitad CLIENTE de AC-2 es verificable acá. Que la entrada salga de `entries` exige un
  // EscrowIndex existente en cadena, y este repo NUNCA emite `register_escrow`.
  it("AC-2: índice PRESENTE y decodificable ⇒ keys[6] es esa PDA y viene writable", async () => {
    const REM = "rem-con-indice";
    mockChain({
      [escrowStatePdaOf(REM).toBase58()]: [await encodeEscrowState("refunded"), null],
      [ESCROW_INDEX_PDA.toBase58()]: await encodeEscrowIndex([REM]),
    });
    const adapter = await connected();

    await adapter.closeEscrow(REM);
    const ix = closeIx(signSpy);
    expect(ix.keys[6]!.pubkey.equals(ESCROW_INDEX_PDA)).toBe(true);
    expect(ix.keys[6]!.isWritable).toBe(true);
    expect(ix.keys[6]!.pubkey.toBase58()).not.toBe(ESCROW_PROGRAM_ID);
  });

  // ── AC-3 · los TRES inputs que colapsan en un solo código ────────────────────────────────────────
  it("AC-3(a): la sonda del índice LANZA ⇒ escrow_index_probe_failed, con 0 firmas y 0 broadcasts", async () => {
    const REM = "rem-sonda-rota";
    mockChain({
      [escrowStatePdaOf(REM).toBase58()]: await encodeEscrowState("released"),
      [ESCROW_INDEX_PDA.toBase58()]: "throw",
    });
    const adapter = await connected();

    await expect(adapter.closeEscrow(REM)).rejects.toThrow("escrow_index_probe_failed");
    expect(signSpy).not.toHaveBeenCalled(); // ANTES de armar y ANTES de firmar: no hay tx que abortar
    expect(sendSpy).not.toHaveBeenCalled();
  });

  // ⏱️ Este test espera ESCROW_INDEX_PROBE_TIMEOUT_MS de RELOJ REAL (5 s) y por eso lleva su propio
  // techo de 20 s. Es deliberado y costó una corrida entenderlo: la versión con `vi.useFakeTimers()` +
  // `advanceTimersByTimeAsync` pasaba corriendo el archivo SOLO y fallaba en la suite COMPLETA
  // ("Test timed out in 5000ms"). Subir el número de iteraciones del loop la habría puesto verde sin
  // que yo supiera por qué — que es exactamente cómo se fabrica un flake de 1 en N. Lo que este test
  // tiene que medir es que el TECHO VENCE de verdad, y el reloj real no depende de qué globals
  // reemplazó el faker ni de cuántos workers hay compitiendo.
  it("AC-3(b): la sonda del índice NUNCA RESUELVE ⇒ vence el techo, escrow_index_probe_failed, 0 firmas", async () => {
    // Sin `withTimeout` (M9) esto colgaría a la persona en "Cerrando…" para siempre. El doble que
    // resuelve no lo nota: hace falta la promesa que nunca resuelve.
    const REM = "rem-sonda-colgada";
    mockChain({
      [escrowStatePdaOf(REM).toBase58()]: await encodeEscrowState("released"),
      [ESCROW_INDEX_PDA.toBase58()]: "hang",
    });
    const adapter = await connected();

    await expect(adapter.closeEscrow(REM)).rejects.toThrow("escrow_index_probe_failed");
    expect(signSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  }, 20_000);

  it("AC-3(c): el índice devuelve bytes INDECODIFICABLES ⇒ escrow_index_probe_failed, 0 firmas", async () => {
    // Una cuenta escribible que no podemos identificar NO entra en una tx del money-path. "Hay bytes en
    // esa dirección" no es "es el índice de este sender".
    const REM = "rem-indice-deforme";
    mockChain({
      [escrowStatePdaOf(REM).toBase58()]: await encodeEscrowState("released"),
      [ESCROW_INDEX_PDA.toBase58()]: Buffer.alloc(64, 7), // discriminador ajeno
    });
    const adapter = await connected();

    await expect(adapter.closeEscrow(REM)).rejects.toThrow("escrow_index_probe_failed");
    expect(signSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  // ── AC-4 ────────────────────────────────────────────────────────────────────────────────────────
  it("AC-4: EscrowState en Deposited ⇒ escrow_not_terminal, sin firmar ni broadcastear", async () => {
    const REM = "rem-en-curso";
    mockChain({
      [escrowStatePdaOf(REM).toBase58()]: await encodeEscrowState("deposited"),
      [ESCROW_INDEX_PDA.toBase58()]: null,
    });
    const adapter = await connected();

    await expect(adapter.closeEscrow(REM)).rejects.toThrow("escrow_not_terminal");
    expect(signSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("AC-4: Released y Refunded SÍ son terminales (los dos llegan a broadcastear)", async () => {
    for (const st of ["released", "refunded"] as const) {
      const REM = `rem-terminal-${st}`;
      mockChain({
        [escrowStatePdaOf(REM).toBase58()]: [await encodeEscrowState(st), null],
        [ESCROW_INDEX_PDA.toBase58()]: null,
      });
      const adapter = await connected();
      await expect(adapter.closeEscrow(REM)).resolves.toEqual({
        closeTx: "close-sig-broadcasted",
        confirmation: "confirmed",
      });
    }
  });

  // ── AC-5 · los tres valores, y la ausencia como única prueba ────────────────────────────────────
  it("AC-5: confirmación limpia + cuenta AUSENTE ⇒ 'confirmed'", async () => {
    const REM = "rem-cerrado";
    mockChain({
      [escrowStatePdaOf(REM).toBase58()]: [await encodeEscrowState("released"), null],
      [ESCROW_INDEX_PDA.toBase58()]: null,
    });
    const adapter = await connected();
    await expect(adapter.closeEscrow(REM)).resolves.toEqual({
      closeTx: "close-sig-broadcasted",
      confirmation: "confirmed",
    });
  });

  it("AC-5: confirmación limpia + la cuenta SIGUE AHÍ ⇒ 'pending', NUNCA 'confirmed' (M4)", async () => {
    // Acá `confirmClose` se aparta de `confirmRefund` a propósito: aquél devuelve "confirmed" apenas la
    // tx confirma sin error (`confirmRefund`, `solana-wallet.ts:687`), SIN leer nada. AC-5 exige leer la AUSENCIA. Un
    // `confirmTransaction` sin `err` prueba que la tx entró; leer la ausencia prueba que hizo lo que
    // queríamos. Este es el único test que separa las dos cosas.
    const REM = "rem-no-cerro";
    const state = await encodeEscrowState("released");
    mockChain({
      [escrowStatePdaOf(REM).toBase58()]: [state, state], // sigue existiendo después del broadcast
      [ESCROW_INDEX_PDA.toBase58()]: null,
    });
    const adapter = await connected();
    await expect(adapter.closeEscrow(REM)).resolves.toEqual({
      closeTx: "close-sig-broadcasted",
      confirmation: "pending",
    });
  });

  it("AC-5: confirmTransaction que NUNCA responde + cuenta presente ⇒ 'pending' (vence el techo y va a la sonda)", async () => {
    const REM = "rem-confirm-colgado";
    const state = await encodeEscrowState("released");
    mockChain({
      [escrowStatePdaOf(REM).toBase58()]: [state, state],
      [ESCROW_INDEX_PDA.toBase58()]: null,
    });
    mockConfirm("hang");
    const adapter = await connected(10); // techo diminuto SOLO para el test
    await expect(adapter.closeEscrow(REM)).resolves.toEqual({
      closeTx: "close-sig-broadcasted",
      confirmation: "pending",
    });
  });

  it("AC-5: la lectura post-broadcast LANZA ⇒ 'unknown', jamás un éxito", async () => {
    const REM = "rem-rpc-caido";
    mockChain({
      [escrowStatePdaOf(REM).toBase58()]: [await encodeEscrowState("released"), "throw"],
      [ESCROW_INDEX_PDA.toBase58()]: null,
    });
    mockConfirm("reject");
    const adapter = await connected();
    await expect(adapter.closeEscrow(REM)).resolves.toEqual({
      closeTx: "close-sig-broadcasted",
      confirmation: "unknown",
    });
  });

  it("AC-5: la tx REVIRTIÓ y la cuenta sigue ahí ⇒ close_tx_failed (un 'no' medido)", async () => {
    const REM = "rem-revirtio";
    const state = await encodeEscrowState("released");
    mockChain({
      [escrowStatePdaOf(REM).toBase58()]: [state, state],
      [ESCROW_INDEX_PDA.toBase58()]: null,
    });
    mockConfirm({ err: { InstructionError: [0, { Custom: 3012 }] } });
    const adapter = await connected();
    await expect(adapter.closeEscrow(REM)).rejects.toThrow("close_tx_failed");
  });

  it("AC-5: la tx revirtió PERO la cuenta ya NO está ⇒ 'confirmed' (gana la fuente autoritativa)", async () => {
    // Un intento anterior de esta misma persona pudo haberla cerrado. Reportar fallo acá sería la
    // mentira vieja al revés.
    const REM = "rem-revirtio-pero-cerrado";
    mockChain({
      [escrowStatePdaOf(REM).toBase58()]: [await encodeEscrowState("released"), null],
      [ESCROW_INDEX_PDA.toBase58()]: null,
    });
    mockConfirm({ err: "AccountNotFound" });
    const adapter = await connected();
    await expect(adapter.closeEscrow(REM)).resolves.toEqual({
      closeTx: "close-sig-broadcasted",
      confirmation: "confirmed",
    });
  });

  // ── Guards y forma de la instrucción ────────────────────────────────────────────────────────────
  it("AC-10: el escrow_state NO existe ⇒ escrow_account_absent, sin firmar (no hay alquiler acá)", async () => {
    const REM = "rem-inexistente";
    mockChain({ [ESCROW_INDEX_PDA.toBase58()]: null }); // la PDA del escrow no está declarada ⇒ null
    const adapter = await connected();
    await expect(adapter.closeEscrow(REM)).rejects.toThrow("escrow_account_absent");
    expect(signSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("los bytes del escrow_state no decodifican ⇒ escrow_state_unreadable, sin firmar", async () => {
    const REM = "rem-deforme";
    mockChain({
      [escrowStatePdaOf(REM).toBase58()]: Buffer.alloc(64, 3),
      [ESCROW_INDEX_PDA.toBase58()]: null,
    });
    const adapter = await connected();
    await expect(adapter.closeEscrow(REM)).rejects.toThrow("escrow_state_unreadable");
    expect(signSpy).not.toHaveBeenCalled();
  });

  it("un remittanceId vacío/whitespace ⇒ escrow_id_required, SIN tocar la cadena (no hay fallback)", async () => {
    // A diferencia de `refundEscrow`, acá NO hay fallback al ledger: para `close` no existe "el"
    // escrow (todos los terminales son igual de cerrables) y elegir uno en silencio le cerraría a la
    // persona una cuenta que no eligió. El descubrimiento devuelve la LISTA y elige ella.
    mockChain({});
    const adapter = await connected();
    await expect(adapter.closeEscrow("   ")).rejects.toThrow("escrow_id_required");
    expect(vi.mocked(Connection.prototype.getAccountInfo)).not.toHaveBeenCalled();
    expect(signSpy).not.toHaveBeenCalled();
  });

  it("sin wallet conectada y sin sender ⇒ wallet_not_connected", async () => {
    const adapter = new SolanaWalletAdapter(); // sin connect
    await expect(adapter.closeEscrow("rem-x")).rejects.toThrow("wallet_not_connected");
  });

  it("feePayer = SENDER (nunca la release-authority) y el discriminador es el de `close`", async () => {
    const REM = "rem-forma";
    mockChain({
      [escrowStatePdaOf(REM).toBase58()]: [await encodeEscrowState("released"), null],
      [ESCROW_INDEX_PDA.toBase58()]: null,
    });
    const adapter = await connected();
    await adapter.closeEscrow(REM);

    const tx = capturedTx(signSpy);
    expect(tx.feePayer?.toBase58()).toBe(SENDER_B58);
    expect(tx.feePayer?.toBase58()).not.toBe(AUTHORITY_PK.toBase58());
    expect(tx.recentBlockhash).toBe(FIXED_BLOCKHASH);

    const ix = closeIx(signSpy);
    expect(ix.programId.toBase58()).toBe(ESCROW_PROGRAM_ID);
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(CLOSE_DISCRIMINATOR);
    const keys = ix.keys.map((k) => k.pubkey.toBase58());
    expect(keys[0]).toBe(SENDER_B58);
    expect(ix.keys[0]!.isSigner).toBe(true);
    expect(keys[1]).toBe(MINT_B58); // el mint ON-CHAIN, nunca el del cliente
    expect(keys[2]).toBe(escrowStatePdaOf(REM).toBase58());
    expect(keys[5]).toBe(TOKEN_PROGRAM);
    expect(ix.keys.some((k) => k.pubkey.toBase58() === AUTHORITY_PK.toBase58() && k.isSigner)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// El gateway — la única puerta de la UI hacia closeEscrow
// ════════════════════════════════════════════════════════════════════════════════════════════════
// 🔴 Este describe existe porque un mutante SOBREVIVIÓ sin él, medido: defaultear el `confirmation` a
// "confirmed" DENTRO del gateway dejaba los 8 tests de `close-escrow-accounts.test.ts` en verde, porque
// ésos usan `FakeSolanaEscrowCloseGateway` y nunca ejecutan esta clase. El use-case propagaba
// perfectamente un valor que el gateway ya había falsificado.
//
// Es el mismo lugar donde vive su hermano de refund (`solana-wallet.refund.test.ts:556-568`) y por la
// misma razón: el gateway es una capa de una sola línea que nadie más ejercita.
describe("SolanaEscrowCloseGateway — propaga el desenlace SIN ascenderlo", () => {
  for (const confirmation of ["confirmed", "pending", "unknown"] as const) {
    it(`confirmation="${confirmation}" del adapter ⇒ el gateway devuelve exactamente "${confirmation}"`, async () => {
      const closeEscrow = vi.fn(async () => ({ closeTx: "sig", confirmation }));
      const gw = new SolanaEscrowCloseGateway({ closeEscrow });

      await expect(gw.close({ remittanceId: "rem-9", sender: SENDER_B58 })).resolves.toEqual({
        closeTx: "sig",
        confirmation,
      });
      expect(closeEscrow).toHaveBeenLastCalledWith("rem-9", SENDER_B58);
    });
  }

  it("un fracaso medido del adapter sube tal cual, sin convertirse en un tri-estado", async () => {
    const closeEscrow = vi.fn(async () => {
      throw new Error("close_tx_failed");
    });
    const gw = new SolanaEscrowCloseGateway({ closeEscrow });
    await expect(gw.close({ remittanceId: "rem-9", sender: SENDER_B58 })).rejects.toThrow(
      "close_tx_failed",
    );
  });
});
