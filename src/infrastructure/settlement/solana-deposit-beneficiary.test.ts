// Tests — readDepositBeneficiary: el lector server-side del destino que está DENTRO de la tx firmada.
//
// El test que importa es el primero: la tx la produce el ESCRITOR REAL de producción
// (SolanaWalletAdapter.authorizePrincipal, el mismo que corre en el navegador) y la lee el LECTOR
// REAL del settle. Ninguna de las dos puntas está mockeada, así que esto prueba el cableado y no una
// constante escrita dos veces. Si el escritor cambia el orden de los args de la ix, o cambia el IDL,
// o pasa a tx versionada, este archivo se pone rojo.
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Money } from "../../domain/money";
import type { Quote } from "../../domain/remittance";
import { SolanaWalletAdapter } from "../solana-wallet";
import { solanaWalletBridge } from "../solana-wallet-bridge";
import { escrowIdl } from "../solana/escrow-idl";
import { readDepositBeneficiary } from "./solana-deposit-beneficiary";

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
  const res = await adapter.authorizePrincipal(quote(), "rem-read-1", {
    address: "unused",
    escrow: { beneficiary, authority: AUTHORITY_B58 },
  });
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
    });
  });

  it("dos beneficiarios distintos ⇒ dos lecturas distintas (no devuelve una constante)", async () => {
    const otro = Keypair.generate().publicKey.toBase58();
    const a = await readDepositBeneficiary(await realDepositTx(BENEFICIARY_B58));
    solanaWalletBridge.reset();
    const b = await readDepositBeneficiary(await realDepositTx(otro));
    expect(a).toEqual({ state: "read", beneficiary: BENEFICIARY_B58 });
    expect(b).toEqual({ state: "read", beneficiary: otro });
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
});
