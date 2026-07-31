// Tests de SolanaWalletAdapter.probeDeposit: la pregunta "¿entró el principal al vault?" hecha A LA
// CADENA. Es la pieza que le da al money-path su tercer valor: antes, perder la respuesta del settle
// se escribía como "el depósito no entró" y sobre eso se emitía un reembolso inexistente.
// Connection mockeada (cero red, mismo patrón que solana-wallet.refund.test.ts).
import { sha256 } from "@noble/hashes/sha256";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SolanaWalletAdapter } from "./solana-wallet";
import { escrowIdl } from "./solana/escrow-idl";
import { solanaWalletBridge } from "./solana-wallet-bridge";

const ESCROW_PROGRAM_ID = "DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x";
const MINT_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SENDER_KP = Keypair.generate();
const SENDER_B58 = SENDER_KP.publicKey.toBase58();

async function encodeEscrowState(status: "deposited" | "released" | "refunded"): Promise<Buffer> {
  const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
  return coder.encode("EscrowState", {
    sender: SENDER_KP.publicKey,
    beneficiary: Keypair.generate().publicKey,
    authority: Keypair.generate().publicKey,
    mint: new PublicKey(MINT_B58),
    amount: new anchor.BN(1_000_000),
    deadline: new anchor.BN(Math.floor(Date.now() / 1000)),
    status:
      status === "deposited"
        ? { Deposited: {} }
        : status === "released"
          ? { Released: {} }
          : { Refunded: {} },
    bump: 255,
  });
}

function mockAccountInfo(data: Buffer | null) {
  return vi.spyOn(Connection.prototype, "getAccountInfo").mockResolvedValue(
    data
      ? ({
          data,
          executable: false,
          lamports: 1,
          owner: new PublicKey(ESCROW_PROGRAM_ID),
          rentEpoch: 0,
        } as never)
      : null,
  );
}

/** La MISMA derivación que usa el deposit (seeds "escrow" | sender | sha256(id)[:16]). Se recalcula
 *  acá a propósito: si el probe mirara otra cuenta, estaría contestando sobre plata ajena. */
function expectedEscrowPda(remittanceId: string): PublicKey {
  const bytes = Uint8Array.from(sha256(new TextEncoder().encode(remittanceId)).subarray(0, 16));
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), SENDER_KP.publicKey.toBuffer(), Buffer.from(bytes)],
    new PublicKey(ESCROW_PROGRAM_ID),
  );
  return pda;
}

/** La dirección que el probe fue a leer, en base58. */
function probedPda(spy: ReturnType<typeof mockAccountInfo>): string {
  const call = spy.mock.calls[0];
  if (!call) throw new Error("getAccountInfo_not_called");
  return (call[0] as PublicKey).toBase58();
}

async function connectedAdapter(): Promise<SolanaWalletAdapter> {
  solanaWalletBridge.setState({ publicKey: SENDER_B58, connected: true });
  const adapter = new SolanaWalletAdapter();
  await adapter.connect();
  return adapter;
}

describe("SolanaWalletAdapter.probeDeposit: la cadena como fuente autoritativa", () => {
  afterEach(() => {
    solanaWalletBridge.reset();
    vi.restoreAllMocks();
  });

  it("cuenta del escrow presente y decodificable ⇒ deposited (la crea SÓLO la ix deposit)", async () => {
    const spy = mockAccountInfo(await encodeEscrowState("deposited"));
    const adapter = await connectedAdapter();

    const state = await adapter.probeDeposit({ remittanceId: "rem-1", sender: SENDER_B58 });

    expect(state).toBe("deposited");
    // Y miró la PDA de ESTA remesa y ESTE sender, no otra.
    expect(probedPda(spy)).toBe(expectedEscrowPda("rem-1").toBase58());
  });

  // El guard que sostiene todo lo demás: si la ausencia se leyera como "no entró", el use-case
  // volvería a afirmar un fallo que nadie midió, y con él el reembolso fabricado.
  it("cuenta AUSENTE ⇒ unknown, NUNCA not_deposited: la tx puede estar en vuelo y aterrizar después", async () => {
    mockAccountInfo(null);
    const adapter = await connectedAdapter();

    const state = await adapter.probeDeposit({ remittanceId: "rem-2", sender: SENDER_B58 });

    expect(state).toBe("unknown");
    expect(state).not.toBe("not_deposited");
  });

  it("el RPC se cae ⇒ unknown: no pudimos preguntar, y eso no es una respuesta negativa", async () => {
    vi.spyOn(Connection.prototype, "getAccountInfo").mockRejectedValue(new Error("rpc_down"));
    const adapter = await connectedAdapter();

    expect(await adapter.probeDeposit({ remittanceId: "rem-3", sender: SENDER_B58 })).toBe("unknown");
  });

  it("bytes indecodificables (cuenta ajena en esa dirección) ⇒ unknown, no se inventa un no", async () => {
    mockAccountInfo(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const adapter = await connectedAdapter();

    expect(await adapter.probeDeposit({ remittanceId: "rem-4", sender: SENDER_B58 })).toBe("unknown");
  });

  // Released/Refunded prueban que el depósito ENTRÓ (esos estados sólo existen después de un deposit).
  // Que después haya salido es otra pregunta; la que este método contesta es si el principal se movió.
  it("estado Released o Refunded ⇒ deposited: el principal entró en algún momento", async () => {
    for (const status of ["released", "refunded"] as const) {
      mockAccountInfo(await encodeEscrowState(status));
      const adapter = await connectedAdapter();
      expect(await adapter.probeDeposit({ remittanceId: "rem-5", sender: SENDER_B58 })).toBe(
        "deposited",
      );
      vi.restoreAllMocks();
      solanaWalletBridge.reset();
    }
  });

  it("sin sender y sin wallet conectada ⇒ unknown: no hay PDA que derivar, no es que no haya depósito", async () => {
    const adapter = new SolanaWalletAdapter(); // nunca conectó
    expect(await adapter.probeDeposit({ remittanceId: "rem-6", sender: "" })).toBe("unknown");
  });

  it("sin remittanceId ⇒ unknown (misma razón: no se puede mirar, no se puede negar)", async () => {
    const adapter = await connectedAdapter();
    expect(await adapter.probeDeposit({ remittanceId: "  ", sender: SENDER_B58 })).toBe("unknown");
  });

  it("sender vacío pero wallet conectada ⇒ usa la address conectada", async () => {
    const spy = mockAccountInfo(await encodeEscrowState("deposited"));
    const adapter = await connectedAdapter();

    expect(await adapter.probeDeposit({ remittanceId: "rem-7", sender: "" })).toBe("deposited");
    expect(probedPda(spy)).toBe(expectedEscrowPda("rem-7").toBase58());
  });
});
