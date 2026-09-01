// Tests — readDepositBeneficiary: el lector server-side del destino que está DENTRO de la tx firmada.
//
// El test que importa es el primero: la tx la produce el ESCRITOR REAL de producción
// (SolanaWalletAdapter.authorizePrincipal, el mismo que corre en el navegador) y la lee el LECTOR
// REAL del settle. Ninguna de las dos puntas está mockeada, así que esto prueba el cableado y no una
// constante escrita dos veces. Si el escritor cambia el orden de los args de la ix, o cambia el IDL,
// o pasa a tx versionada, este archivo se pone rojo.
import type { Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import type { Quote } from "../../domain/remittance";
import { SolanaWalletAdapter } from "../solana-wallet";
import { solanaWalletBridge } from "../solana-wallet-bridge";
import { escrowIdl } from "../solana/escrow-idl";
import { readDepositBeneficiary } from "./solana-deposit-beneficiary"; import { esperarAutorizacionLista } from "../../test-support/desenlaces"; // WKH-356: narrowing de AutorizacionDelPrincipal. TIRA si el adaptador suspende donde el test no lo espera.

const MINT_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SENDER_KP = Keypair.generate();
const BENEFICIARY_B58 = Keypair.generate().publicKey.toBase58();
const AUTHORITY_B58 = Keypair.generate().publicKey.toBase58();
const FACILITATOR_B58 = Keypair.generate().publicKey.toBase58();
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

function quote(): Quote {
  return {
    quoteId: "q-read-1",
    send: Money.fromMinor(12_345_678, "USDC"),
    receive: Money.fromMinor(4_500_00, "PEN"),
    feeUsd: Money.fromMinor(100_000, "USDC"),
    rate: 3.64,
    etaMinutes: 5,
    expiresAt: "2099-01-01T00:00:00.000Z",
    provenance: "test",
  };
}

/** La tx REAL que arma la wallet de producción, serializada como la manda el cliente. */
async function realDepositTx(beneficiary: string): Promise<string> {
  solanaWalletBridge.setState({ publicKey: SENDER_KP.publicKey.toBase58(), connected: true });
  // SDD 037 — la wallet fake firma DE VERDAD: el adapter necesita la firma de la tx para armar el
  // mensaje canónico del segundo prompt. Antes devolvía la tx sin tocar, o sea que este test corría
  // contra una wallet que decía "listo" sin firmar nada.
  solanaWalletBridge.registerSignTransaction(async (tx: unknown) => {
    (tx as Transaction).partialSign(SENDER_KP);
    return tx;
  });
  solanaWalletBridge.registerSignMessage(async (bytes: Uint8Array) =>
    nacl.sign.detached(bytes, SENDER_KP.secretKey),
  );
  const adapter = new SolanaWalletAdapter();
  await adapter.connect();
  const res = esperarAutorizacionLista(await adapter.authorizePrincipal(quote(), "rem-read-1", {
    address: "unused",
    escrow: { beneficiary, authority: AUTHORITY_B58 },
  }, "https://chaski.test/enviar"));
  const b64 = res.solana?.partialSignedTx;
  if (!b64) throw new Error("no_partial_signed_tx");
  return b64;
}

/** Una tx cualquiera con UNA ix arbitraria: sirve para los casos "no es un deposit del escrow". */
function txWith(programId: PublicKey, data: Buffer): string {
  const ix = new TransactionInstruction({
    programId,
    keys: [{ pubkey: SENDER_KP.publicKey, isSigner: true, isWritable: true }],
    data,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = new PublicKey(FACILITATOR_B58);
  tx.recentBlockhash = BLOCKHASH;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

describe("readDepositBeneficiary", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_USDC_MINT", MINT_B58);
    vi.stubEnv("NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY", FACILITATOR_B58);
    vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1,
    } as Awaited<ReturnType<Connection["getLatestBlockhash"]>>);
    // 🔴 WKH-347 — SIN ESTO EL ESCRITOR REAL PEGA A LA RED. `authorizePrincipal` pasó a sondear la PDA
    // `["escrow-index", sender]` antes de armar la tx, y sin mock cada uno de estos `it` esperaba los
    // 5 s del techo de la sonda contra un RPC real y moría por timeout. `null` significa que la cadena
    // CONTESTÓ que el índice no existe, o sea el caso de un remitente que deposita por primera vez:
    // la tx sale con sus DOS ix de negocio, que es la forma que estos tests tienen que leer.
    vi.spyOn(Connection.prototype, "getAccountInfo").mockResolvedValue(null);
  });
  afterEach(() => {
    solanaWalletBridge.reset();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("la tx que arma authorizePrincipal DE VERDAD ⇒ devuelve el MISMO beneficiary que se le pidió firmar", async () => {
    const b64 = await realDepositTx(BENEFICIARY_B58);
    await expect(readDepositBeneficiary(b64)).resolves.toEqual({
      state: "read",
      beneficiary: BENEFICIARY_B58,
      escrowIndexRegistration: "registered", // el `beforeEach` deja el índice AUSENTE ⇒ la tx registra
    });
  });

  it("dos beneficiarios distintos ⇒ dos lecturas distintas (no devuelve una constante)", async () => {
    const otro = Keypair.generate().publicKey.toBase58();
    const a = await readDepositBeneficiary(await realDepositTx(BENEFICIARY_B58));
    solanaWalletBridge.reset();
    const b = await readDepositBeneficiary(await realDepositTx(otro));
    expect(a).toEqual({
      state: "read",
      beneficiary: BENEFICIARY_B58,
      escrowIndexRegistration: "registered",
    });
    expect(b).toEqual({ state: "read", beneficiary: otro, escrowIndexRegistration: "registered" });
  });

  it("base64 que no es una tx / vacío / basura ⇒ unreadable (nunca tira)", async () => {
    for (const raw of ["AQIDBAUGBwg=", "", "no-base64-!!", "AA=="]) {
      await expect(readDepositBeneficiary(raw)).resolves.toEqual({ state: "unreadable" });
    }
  });

  it("tx sin ninguna ix del escrow ⇒ unreadable (no se juzga lo que no es un depósito)", async () => {
    const b64 = txWith(Keypair.generate().publicKey, Buffer.alloc(104, 7));
    await expect(readDepositBeneficiary(b64)).resolves.toEqual({ state: "unreadable" });
  });

  it("ix DEL escrow pero que no es `deposit` ⇒ unreadable (el discriminator manda)", async () => {
    const idl = escrowIdl as unknown as {
      address: string;
      instructions: Array<{ name: string; discriminator: number[] }>;
    };
    const close = idl.instructions.find((i) => i.name === "close");
    if (!close) throw new Error("idl_sin_close");
    const b64 = txWith(
      new PublicKey(idl.address),
      Buffer.concat([Buffer.from(close.discriminator), Buffer.alloc(16, 0)]),
    );
    await expect(readDepositBeneficiary(b64)).resolves.toEqual({ state: "unreadable" });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // WKH-347 · la lectura del REGISTRO EN EL ÍNDICE, contra el escritor REAL
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // 🔴 POR QUÉ CONTRA `authorizePrincipal` Y NO CONTRA UNA TX ARMADA A MANO. Una tx a mano prueba el
  // decoder; lo que hace falta probar es el CABLEADO — que el escritor real y el lector real coincidan
  // sobre las DOS formas que el escritor puede emitir. Con una tx a mano, el día que el escritor cambie
  // el orden o el shape de la 2ª ix, estos tests siguen verdes y el 400 aparece en producción.
  describe("¿registró el escrow en el índice? (WKH-347/AC-10)", () => {
    /** Un `EscrowIndex` real y decodificable con N entradas, para que el escritor vea el índice LLENO. */
    async function encodeEscrowIndex(n: number): Promise<Buffer> {
      const anchor = await import("@coral-xyz/anchor");
      const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
      return coder.encode("EscrowIndex", {
        sender: SENDER_KP.publicKey,
        version: 1,
        bump: 254,
        entries: Array.from({ length: n }, (_, i) => Array.from({ length: 16 }, () => i % 256)),
      });
    }

    it("índice AUSENTE ⇒ el escritor emite 2 ix y el lector dice `registered`", async () => {
      // El `beforeEach` ya deja `getAccountInfo` en `null` (la cadena contestó: no hay índice).
      const read = await readDepositBeneficiary(await realDepositTx(BENEFICIARY_B58));
      expect(read).toEqual({
        state: "read",
        beneficiary: BENEFICIARY_B58,
        escrowIndexRegistration: "registered",
      });
    });

    // 🔴 EL OTRO LADO, sin el cual el de arriba no prueba nada: un lector que devolviera "registered"
    // constante lo pasaría. Acá el índice está LLENO (32 entradas), así que el escritor omite la 2ª ix
    // a propósito (AC-5: un índice lleno NO puede impedir un depósito) y el lector tiene que verlo.
    it("índice LLENO ⇒ el escritor emite 1 ix y el lector dice `not_registered`", async () => {
      const data = await encodeEscrowIndex(32);
      vi.spyOn(Connection.prototype, "getAccountInfo").mockResolvedValue({
        data,
        executable: false,
        lamports: 1,
        owner: new PublicKey((escrowIdl as { address: string }).address),
        rentEpoch: 0,
      } as Awaited<ReturnType<Connection["getAccountInfo"]>>);

      const read = await readDepositBeneficiary(await realDepositTx(BENEFICIARY_B58));
      expect(read).toEqual({
        state: "read",
        beneficiary: BENEFICIARY_B58,
        escrowIndexRegistration: "not_registered",
      });
    });

    // 🔴 T-347-20 (R-2/CD-13) — EL ORDEN INVERTIDO, AL NIVEL DEL DECODER. Con `register_escrow` en la
    // posición 0, este archivo devuelve `unreadable` y su caller responde 400 para TODO depósito
    // patrocinado. Es el test que fija por qué la posición del `deposit` no se toca.
    it("T-347-20: `register_escrow` en la posición 0 ⇒ unreadable (el `deposit` va SIEMPRE primero)", async () => {
      const idl = escrowIdl as unknown as {
        address: string;
        instructions: Array<{ name: string; discriminator: number[] }>;
      };
      const register = idl.instructions.find((i) => i.name === "register_escrow");
      if (!register) throw new Error("idl_sin_register_escrow");
      // 24 bytes exactos: 8 de discriminador + 16 del remittance_id.
      const b64 = txWith(
        new PublicKey(idl.address),
        Buffer.concat([Buffer.from(register.discriminator), Buffer.alloc(16, 3)]),
      );
      await expect(readDepositBeneficiary(b64)).resolves.toEqual({ state: "unreadable" });
    });

    // 🔴 Y LA TERCERA RAMA, que es la que un `boolean` habría colapsado: hay una 2ª ix del escrow y NO
    // se puede nombrar. Eso NO es "salió sin registrar" — es "no pude leerlo" — y el beneficiary sigue
    // siendo perfectamente legible, así que la lectura NO degrada a `unreadable` entera.
    it("2ª ix del escrow que no es `register_escrow` ⇒ `unreadable` en el campo, no en la lectura", async () => {
      const idl = escrowIdl as unknown as {
        address: string;
        instructions: Array<{ name: string; discriminator: number[] }>;
      };
      const programId = new PublicKey(idl.address);
      // Se parte de la tx REAL (que trae el `deposit` bien formado en la posición 0) y se le reemplaza
      // la 2ª ix por una del escrow con un discriminador que el IDL no conoce.
      const real = Transaction.from(Buffer.from(await realDepositTx(BENEFICIARY_B58), "base64"));
      const tx = new Transaction();
      const escrowIxs = real.instructions.filter((i) => i.programId.equals(programId));
      expect(escrowIxs).toHaveLength(2); // control: la tx real trae las dos
      for (const i of real.instructions) {
        if (i === escrowIxs[1]) {
          tx.add(
            new TransactionInstruction({
              programId,
              keys: i.keys,
              data: Buffer.concat([Buffer.alloc(8, 0xab), Buffer.alloc(16, 1)]),
            }),
          );
        } else tx.add(i);
      }
      tx.feePayer = new PublicKey(FACILITATOR_B58);
      tx.recentBlockhash = BLOCKHASH;
      const b64 = tx
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64");

      await expect(readDepositBeneficiary(b64)).resolves.toEqual({
        state: "read",
        beneficiary: BENEFICIARY_B58,
        escrowIndexRegistration: "unreadable",
      });
    });
  });
});
