// LA JUNTA entre las DOS firmas del refund perdido y el copy que las traduce (WKH-331 / AC-5,
// fix-pack AR/BLQ-BAJO-1).
//
// 🔴 POR QUÉ ESTE ARCHIVO EXISTE. La puerta "Recuperar un envío perdido" pide DOS firmas por motivos
// distintos: la de posesión (un texto, adentro del resolver, para que el servidor entregue los ids) y
// la de la orden de devolución (la transacción). Las dos las escribe la MISMA billetera con el MISMO
// texto ("User rejected the request." en Phantom), y las dos salen de `refundEscrow` por el mismo
// `catch` de `flow.tsx`. La rama de AC-5 atendía a las dos y decía "no llegamos a preguntar".
//
// Para la SEGUNDA esa frase es falsa, y de la manera cara: preguntamos, el servidor contestó, miramos
// la cadena y encontramos un escrow abierto y vencido con los USDC de la persona adentro. Decirle "no
// llegamos a preguntar" es la sobre-corrección exacta que esta HU existe para no cometer, y además le
// tira a la basura la única información útil que teníamos para darle.
//
// Este archivo no elige el mensaje: lo PRODUCE. Corre el `SolanaWalletAdapter` REAL, hace fallar UNA
// de las dos firmas, y le pasa al copy REAL lo que salga de ahí. Los dos casos usan el MISMO texto de
// billetera y difieren SÓLO en qué fase lo tira: si las dos copias volvieran a ser la misma, esa
// igualdad es lo que se pone rojo.
//
// ⚠️ NO renderiza React a propósito: en jsdom la derivación de la PDA se cae antes de llegar a la
// cadena (`escrow-rent-discovery-junta.test.ts` explica con qué mensaje). La mitad de UI la cubren
// `refund-perdido-registro-mudo.test.tsx` (los desenlaces del registro) y
// `lost-escrow-recovery.test.tsx`.
import { sha256 } from "@noble/hashes/sha256";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemittanceIdLookup } from "../application/ports";
import { MAX_RECOVERY_CANDIDATES, SolanaWalletAdapter } from "../infrastructure/solana-wallet";
import { escrowIdl } from "../infrastructure/solana/escrow-idl";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { lostEscrowRecoveryError } from "./flow-vm";

// ⚠️ El string lo escribe la billetera y no lo controlamos. Es el mismo en las dos fases: ésa es la
// premisa de todo este archivo, y por eso va en UNA constante que los dos casos comparten.
const LO_QUE_ESCRIBE_PHANTOM = "User rejected the request.";
const ESCROW_PROGRAM_ID = "DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x";
const MINT_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SENDER_KP = Keypair.generate();
const SENDER_B58 = SENDER_KP.publicKey.toBase58();
const REM_ABIERTO = "rem-abierto-y-vencido";

function pdaOf(remittanceId: string): PublicKey {
  const bytes = Uint8Array.from(sha256(new TextEncoder().encode(remittanceId)).subarray(0, 16));
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), SENDER_KP.publicKey.toBuffer(), Buffer.from(bytes)],
    new PublicKey(ESCROW_PROGRAM_ID),
  );
  return pda;
}

/** Un EscrowState `Deposited` con el deadline YA vencido: el único estado que habilita el refund. */
async function escrowAbiertoYVencido(): Promise<Buffer> {
  const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
  return coder.encode("EscrowState", {
    sender: SENDER_KP.publicKey,
    beneficiary: Keypair.generate().publicKey,
    authority: Keypair.generate().publicKey,
    mint: new PublicKey(MINT_B58),
    amount: new anchor.BN(1_000_000),
    deadline: new anchor.BN(Math.floor(Date.now() / 1000) - 3600),
    status: { Deposited: {} },
    bump: 255,
  });
}

describe("la junta: qué firma no se completó, medido con el adapter REAL (WKH-331/AC-5)", () => {
  let lookupBySender: Mock;
  let batchSpy: Mock;

  beforeEach(async () => {
    const cuenta = {
      data: await escrowAbiertoYVencido(),
      executable: false,
      lamports: 1,
      owner: new PublicKey(ESCROW_PROGRAM_ID),
      rentEpoch: 0,
    };
    const pdaAbierta = pdaOf(REM_ABIERTO).toBase58();
    const delPda = (k: PublicKey) => (k.toBase58() === pdaAbierta ? cuenta : null);
    batchSpy = vi.fn(async (keys: PublicKey[]) => keys.map(delPda));
    vi.spyOn(Connection.prototype, "getMultipleAccountsInfo").mockImplementation(batchSpy as never);
    vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation((async (k: PublicKey) =>
      delPda(k)) as never);
    vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    } as Awaited<ReturnType<Connection["getLatestBlockhash"]>>);
    // El servidor CONTESTÓ, y contestó con un envío que la cadena dice abierto: este archivo mide el
    // desenlace de las FIRMAS, no el del registro (ése lo mide `refund-perdido-registro-mudo`).
    lookupBySender = vi.fn(
      async (): Promise<RemittanceIdLookup> => ({
        outcome: "answered",
        remittanceIds: [REM_ABIERTO],
      }),
    );
    solanaWalletBridge.setState({ publicKey: SENDER_B58, connected: true });
  });

  afterEach(() => {
    solanaWalletBridge.reset();
    vi.restoreAllMocks();
  });

  /** Corre el adapter REAL sin `remittanceId` y devuelve el copy que la pantalla mostraría. */
  async function copyRealDelRefundPerdido(): Promise<string> {
    const adapter = new SolanaWalletAdapter({ lookupBySender });
    await adapter.connect();
    try {
      await adapter.refundEscrow();
    } catch (e) {
      return lostEscrowRecoveryError(
        e instanceof Error ? e.message : String(e),
        MAX_RECOVERY_CANDIDATES,
      );
    }
    throw new Error("el_refund_no_falló_y_este_test_necesita_que_falle");
  }

  /** La fase 1 no se completa: la billetera rechaza la firma de posesión, adentro del resolver. */
  function laPosesiónNoSeFirma(): void {
    lookupBySender.mockRejectedValue(new Error(LO_QUE_ESCRIBE_PHANTOM));
  }

  /** La fase 1 SÍ se completa (el resolver contesta y la cadena se mira); la que no, es la fase 2. */
  function laOrdenNoSeFirma(): void {
    solanaWalletBridge.registerSignTransaction(async () => {
      throw new Error(LO_QUE_ESCRIBE_PHANTOM);
    });
  }

  it("FASE 1 (la de posesión): no se completó ⇒ el copy dice que no llegamos a preguntar", async () => {
    laPosesiónNoSeFirma();
    const copy = await copyRealDelRefundPerdido();

    expect(copy).toContain("no llegamos a preguntar");
    // Y la evidencia MEDIDA de que efectivamente no se preguntó: no se tocó la cadena.
    expect(batchSpy).not.toHaveBeenCalled();
  });

  it("FASE 2 (la de la orden): no se completó ⇒ 🚫 el copy NO puede decir que no llegamos a preguntar", async () => {
    laOrdenNoSeFirma();
    const copy = await copyRealDelRefundPerdido();

    // 🔴 Lo que este archivo existe para impedir. Preguntamos (1 llamada al registro), miramos
    // (1 batch a la cadena) y encontramos un escrow abierto: las tres cosas están medidas abajo.
    expect(copy).not.toContain("no llegamos a preguntar");
    expect(copy).not.toContain("prueba que la billetera es tuya");
    // Y no basta con callarse: la información útil (hay un escrow abierto esperando) tiene que llegar.
    expect(copy).toContain("Encontramos un envío tuyo");
    expect(copy).toContain("segunda firma");
    expect(lookupBySender).toHaveBeenCalledTimes(1); // SÍ se preguntó
    expect(batchSpy).toHaveBeenCalledTimes(1); // SÍ se miró la cadena
  });

  // 🔴 EL CONTROL QUE HACE FALSABLES A LOS DOS DE ARRIBA. Cada uno por separado lo satisfacen textos
  // que no distinguen nada (uno pide una subcadena, el otro pide que falte). Lo que el arreglo tiene
  // que sostener es que el MISMO texto de billetera produzca DOS copias distintas según la fase: si el
  // etiquetado de fase se borra, las dos vuelven a ser la misma cadena y esto se pone rojo.
  it("el MISMO texto de billetera produce copias DISTINTAS según la fase", async () => {
    laPosesiónNoSeFirma();
    const fase1 = await copyRealDelRefundPerdido();
    lookupBySender.mockResolvedValue({ outcome: "answered", remittanceIds: [REM_ABIERTO] });
    laOrdenNoSeFirma();
    const fase2 = await copyRealDelRefundPerdido();

    expect(fase1).not.toBe(fase2);
  });
});
