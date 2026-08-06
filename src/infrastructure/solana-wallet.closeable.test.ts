// Tests — SolanaWalletAdapter.listCloseable (WKH-327 / AC-8). El descubrimiento de envíos terminados
// que todavía tienen sus dos cuentas abiertas: cruza los ids que el servidor tiene guardados con una
// sonda ON-CHAIN, así que alcanza envíos que NO están en el localStorage de este navegador.
//
// ⚠️ El doble de cadena mapea POR PUBKEY (CD-14), copiado de `mockChain`
// (solana-wallet.refund.test.ts:346-366). Un doble ordenado le daría a cada PDA la respuesta de otra y
// los tests pasarían sin probar que el filtro lee el estado de verdad.
import { sha256 } from "@noble/hashes/sha256";
import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RemittanceIdLookup,
  RemittanceIdLookupBlocked,
  SolanaRemittanceIdResolver,
} from "../application/ports";
import { MAX_CLOSEABLE_CANDIDATES, SolanaWalletAdapter } from "./solana-wallet";
import { escrowIdl } from "./solana/escrow-idl";
import { solanaWalletBridge } from "./solana-wallet-bridge";

const ESCROW_PROGRAM_ID = "DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x";
const MINT_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PROGRAM_ID = new PublicKey(ESCROW_PROGRAM_ID);

const SENDER_KP = Keypair.generate();
const SENDER_B58 = SENDER_KP.publicKey.toBase58();

function remittanceIdBytes16(remittanceId: string): Uint8Array {
  return Uint8Array.from(sha256(new TextEncoder().encode(remittanceId)).subarray(0, 16));
}

function pdaOf(remittanceId: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), SENDER_KP.publicKey.toBuffer(), Buffer.from(remittanceIdBytes16(remittanceId))],
    PROGRAM_ID,
  )[0];
}

async function encodeEscrowState(status: "deposited" | "released" | "refunded"): Promise<Buffer> {
  const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
  return coder.encode("EscrowState", {
    sender: SENDER_KP.publicKey,
    beneficiary: Keypair.generate().publicKey,
    authority: Keypair.generate().publicKey,
    mint: new PublicKey(MINT_B58),
    amount: new anchor.BN(1_000_000),
    deadline: new anchor.BN(Math.floor(Date.now() / 1000) - 3600),
    status:
      status === "deposited"
        ? { Deposited: {} }
        : status === "released"
          ? { Released: {} }
          : { Refunded: {} },
    bump: 255,
  });
}

function accountInfo(data: Buffer) {
  return { data, executable: false, lamports: 1, owner: PROGRAM_ID, rentEpoch: 0 };
}

/** El batch mapeado POR PUBKEY: cada PDA responde SU propio estado, o null si no existe. */
function mockBatch(byPda: Map<string, Buffer>): void {
  vi.spyOn(Connection.prototype, "getMultipleAccountsInfo").mockImplementation(
    (async (keys: PublicKey[]) =>
      keys.map((k) => {
        const d = byPda.get(k.toBase58());
        return d ? accountInfo(d) : null;
      })) as never,
  );
}

/** Un resolver doble con sus DOS métodos coherentes entre sí: `listBySender` colapsa lo mismo que
 *  colapsa el resolver real. Se construyen juntos para que un test no pueda armar un doble que
 *  contesta una cosa por un método y otra por el otro. */
function resolverQueContesta(ids: readonly string[]) {
  return {
    lookupBySender: vi.fn(
      async (): Promise<RemittanceIdLookup> => ({ outcome: "answered", remittanceIds: ids }),
    ),
    listBySender: vi.fn(async () => [...ids]),
  };
}

/** El resolver NO pudo preguntar. Su `listBySender` devuelve `[]` — que es exactamente el disfraz que
 *  `listCloseable` ya no puede usar, y por eso estos tests existen. */
function resolverQueNoPudoPreguntar(reason: RemittanceIdLookupBlocked) {
  return {
    lookupBySender: vi.fn(async (): Promise<RemittanceIdLookup> => ({ outcome: "not_asked", reason })),
    listBySender: vi.fn(async () => [] as string[]),
  };
}

async function connectedWith(resolver?: SolanaRemittanceIdResolver) {
  solanaWalletBridge.setState({ publicKey: SENDER_B58, connected: true });
  const adapter = new SolanaWalletAdapter(resolver);
  await adapter.connect();
  return adapter;
}

afterEach(() => {
  solanaWalletBridge.reset();
  vi.restoreAllMocks();
});

describe("SolanaWalletAdapter.listCloseable (WKH-327/AC-8)", () => {
  it("devuelve SÓLO los terminales: descarta el Deposited y el que no tiene cuenta", async () => {
    const byPda = new Map<string, Buffer>([
      [pdaOf("rem-en-curso").toBase58(), await encodeEscrowState("deposited")],
      [pdaOf("rem-liberado").toBase58(), await encodeEscrowState("released")],
      // "rem-sin-cuenta" no está en el mapa ⇒ el batch devuelve null para su PDA
    ]);
    mockBatch(byPda);
    const resolver = resolverQueContesta(["rem-en-curso", "rem-liberado", "rem-sin-cuenta"]);
    const adapter = await connectedWith(resolver);

    await expect(adapter.listCloseable({ sender: SENDER_B58 })).resolves.toEqual([
      { remittanceId: "rem-liberado", status: "released" },
    ]);
    expect(resolver.lookupBySender).toHaveBeenCalledWith(SENDER_B58);
    // Y NO por el método que colapsa: el descubrimiento pregunta por el que distingue los tres.
    expect(resolver.listBySender).not.toHaveBeenCalled();
  });

  it("Refunded también es cerrable, y se reporta como tal (no todo cae en 'released')", async () => {
    mockBatch(
      new Map([
        [pdaOf("rem-a").toBase58(), await encodeEscrowState("refunded")],
        [pdaOf("rem-b").toBase58(), await encodeEscrowState("released")],
      ]),
    );
    const adapter = await connectedWith(resolverQueContesta(["rem-a", "rem-b"]));

    await expect(adapter.listCloseable({ sender: SENDER_B58 })).resolves.toEqual([
      { remittanceId: "rem-a", status: "refunded" },
      { remittanceId: "rem-b", status: "released" },
    ]);
  });

  it("sin resolver inyectado ⇒ escrow_id_unavailable (fail-loud, nunca una lista vacía)", async () => {
    const adapter = await connectedWith(); // sin resolver
    await expect(adapter.listCloseable({ sender: SENDER_B58 })).rejects.toThrow(
      "escrow_id_unavailable",
    );
  });

  // 🔴 EL test de M12. Una excepción y una lista vacía son respuestas DISTINTAS y la diferencia es
  // toda la honestidad del copy: "no llegamos a preguntar" no es "no tenés nada".
  it("si el RPC LANZA, propaga la excepción — 🚫 NUNCA devuelve []", async () => {
    vi.spyOn(Connection.prototype, "getMultipleAccountsInfo").mockImplementation((async () => {
      throw new Error("rpc_down");
    }) as never);
    const adapter = await connectedWith(resolverQueContesta(["rem-a"]));

    await expect(adapter.listCloseable({ sender: SENDER_B58 })).rejects.toThrow("rpc_down");
  });

  // El control que hace que el test de arriba signifique algo: la lista vacía SÍ existe, y sale de la
  // cadena habiendo contestado. Sin este caso, "propaga" y "devuelve []" no estarían separados.
  it("si la cadena contesta y ninguno es terminal ⇒ lista VACÍA (que no es lo mismo que lanzar)", async () => {
    mockBatch(new Map([[pdaOf("rem-a").toBase58(), await encodeEscrowState("deposited")]]));
    const adapter = await connectedWith(resolverQueContesta(["rem-a"]));

    await expect(adapter.listCloseable({ sender: SENDER_B58 })).resolves.toEqual([]);
  });

  it("sondea como máximo MAX_CLOSEABLE_CANDIDATES pubkeys en UNA sola llamada batch", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `rem-${i}`);
    mockBatch(new Map());
    const adapter = await connectedWith(resolverQueContesta(ids));

    await adapter.listCloseable({ sender: SENDER_B58 });
    const batch = vi.mocked(Connection.prototype.getMultipleAccountsInfo);
    expect(batch).toHaveBeenCalledTimes(1); // UNA sola llamada RPC, no N
    const enviadas = (batch.mock.calls[0]?.[0] as PublicKey[] | undefined)?.length;
    expect(enviadas).toBe(20);
    // Atado a la constante, no al número escrito a mano: el tope lo decide el servidor.
    expect(enviadas).toBe(MAX_CLOSEABLE_CANDIDATES);
  });

  it("una cuenta con bytes indecodificables se descarta y las otras dos se resuelven igual", async () => {
    // Sin el try/catch alrededor del decode, UN solo escrow deforme dejaría a la persona sin poder
    // recuperar el alquiler de NINGUNO.
    mockBatch(
      new Map([
        [pdaOf("rem-basura").toBase58(), Buffer.alloc(64, 7)], // discriminador ajeno
        [pdaOf("rem-sana-1").toBase58(), await encodeEscrowState("released")],
        [pdaOf("rem-sana-2").toBase58(), await encodeEscrowState("refunded")],
      ]),
    );
    const adapter = await connectedWith(
      resolverQueContesta(["rem-basura", "rem-sana-1", "rem-sana-2"]),
    );

    await expect(adapter.listCloseable({ sender: SENDER_B58 })).resolves.toEqual([
      { remittanceId: "rem-sana-1", status: "released" },
      { remittanceId: "rem-sana-2", status: "refunded" },
    ]);
  });

  it("el servidor no tiene ids para esta billetera ⇒ [] sin tocar la cadena", async () => {
    const batch = vi.spyOn(Connection.prototype, "getMultipleAccountsInfo");
    const adapter = await connectedWith(resolverQueContesta([]));

    await expect(adapter.listCloseable({ sender: SENDER_B58 })).resolves.toEqual([]);
    expect(batch).not.toHaveBeenCalled();
  });

  // 🔴 2º fix-pack (AR/BLQ-MED-2). El test de arriba y los TRES de abajo se leen juntos: los cuatro
  // terminan sin ningún candidato, y sólo el de arriba puede devolver `[]`. Los tres de acá son "no
  // llegamos a preguntar" y salen por el MISMO `throw` que un RPC caído — la propiedad que faltaba.
  for (const reason of ["pop_disabled", "registry_disabled", "pop_rejected"] as const) {
    it(`el resolver no pudo preguntar (${reason}) ⇒ LANZA, 🚫 nunca []`, async () => {
      const batch = vi.spyOn(Connection.prototype, "getMultipleAccountsInfo");
      const adapter = await connectedWith(resolverQueNoPudoPreguntar(reason));

      // El código lleva el motivo pegado para el diagnóstico; el prefijo es el que el copy reconoce.
      await expect(adapter.listCloseable({ sender: SENDER_B58 })).rejects.toThrow(
        `escrow_recovery_unavailable:${reason}`,
      );
      expect(batch).not.toHaveBeenCalled(); // no se preguntó nada, ni al servidor ni a la cadena
    });
  }
});
