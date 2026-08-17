import { sha256 } from "@noble/hashes/sha256";
import nacl from "tweetnacl";
import bs58 from "bs58";
import * as anchor from "@coral-xyz/anchor";
import type { Idl, Provider } from "@coral-xyz/anchor";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Money } from "../domain/money";
import type { Quote } from "../domain/remittance";
import { CUSTODY_WINDOW_SECS, SolanaWalletAdapter } from "./solana-wallet"; import { SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT } from "../application/solana-escrow-rent"; // WKH-357: EN ESTA LÍNEA, no en una nueva — `solana-wallet.test.ts:453-454` y `:506` se citan por número desde otros dos archivos (ver el comentario de más abajo), así que una línea nueva acá arriba los rota. Y el umbral se IMPORTA, nunca se escribe como literal en un test (CD-12)
import { escrowIdl } from "./solana/escrow-idl";
import { solanaWalletBridge } from "./solana-wallet-bridge"; import { esperarAutorizacionLista } from "../test-support/desenlaces"; import { readFileSync } from "node:fs"; import path from "node:path"; import { FirmaPorEnlaceReal, type DesenlaceDeFirma, type FirmaPorEnlace, type PedidoDeFirma } from "./solana/deeplink/firma-por-enlace"; import { direccionDelNonce } from "./solana/nonce-duradero"; // WKH-356: TODO en esta línea — `solana-wallet.test.ts:453-454` y `:506` los citan por número desde otros dos archivos, así que una línea nueva acá arriba los rota. WKH-357 agregó el último por la MISMA razón y ANTES de este comentario

const VALID_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // base58 válido (mixed-case)

afterEach(() => {
  solanaWalletBridge.reset();
  vi.restoreAllMocks();
});

describe("SolanaWalletAdapter", () => {
  it("connect() abre el modal y devuelve el base58 del bridge sin transformar (AC-2, CD-3)", async () => {
    const openSpy = vi.fn();
    solanaWalletBridge.registerOpenModal(openSpy);
    const adapter = new SolanaWalletAdapter();
    const p = adapter.connect();
    expect(openSpy).toHaveBeenCalledOnce(); // openModal se llamó antes del await
    // simula que el usuario conectó Phantom → el sync component empuja el estado
    solanaWalletBridge.setState({ publicKey: VALID_B58, connected: true });
    await expect(p).resolves.toBe(VALID_B58); // sin transformación (CD-3)
  });

  it("getAddress() tras connect() devuelve el MISMO base58 case-sensitive (AC-6, CD-3)", async () => {
    solanaWalletBridge.setState({ publicKey: VALID_B58, connected: true });
    const adapter = new SolanaWalletAdapter();
    await adapter.connect();
    const got = await adapter.getAddress();
    expect(got).toBe(VALID_B58);
    expect(got).not.toBe(VALID_B58.toLowerCase()); // NO se lowercasea (base58 case-sensitive)
  });

  it("base58 malformado del bridge → throw invalid_address sin cachear (CD-SDD-5)", async () => {
    // '0OIl' contiene chars fuera del alfabeto base58 → new PublicKey lanza
    solanaWalletBridge.setState({ publicKey: "0OIl-not-base58", connected: true });
    const adapter = new SolanaWalletAdapter();
    await expect(adapter.connect()).rejects.toThrow("invalid_address");
    expect(await adapter.getAddress()).toBeNull(); // no cacheó nada
  });

  // ── Rehidratación tras la recarga ────────────────────────────────────────────────────────────────
  // El daño que cubren estos cuatro: el KYC navega a Didit y vuelve, lo que MATA el `address` en
  // memoria del adapter. El resume salta derecho a `confirm` sin volver a pasar por `connect()`, así
  // que `getAddress()` contestaba `null`, el use-case mandaba `address: ""` y la autoridad de payout
  // moría canonicalizando el vacío → 502 `kyc_reauth_failed`. Un fallo local disfrazado de caída del
  // proveedor de identidad, y el flujo se cortaba ANTES de pedir la firma.
  it("SIN connect(): con el bridge ya conectado (autoConnect tras la recarga) getAddress() devuelve la address", async () => {
    const openSpy = vi.fn();
    solanaWalletBridge.registerOpenModal(openSpy);
    // Lo que hace el sync component solo al remontar el árbol: empujar lo que dice useWallet().
    solanaWalletBridge.setState({ publicKey: VALID_B58, connected: true });

    const adapter = new SolanaWalletAdapter(); // instancia nueva: el cache en memoria se perdió

    expect(await adapter.getAddress()).toBe(VALID_B58); // sin transformación (CD-3)
    // Y lo consiguió sin molestar a nadie: cero modales, que es lo que lo hace usable a mitad de flujo.
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("bridge con publicKey pero connected:false ⇒ null (no hay conexión viva que respalde esa address)", async () => {
    solanaWalletBridge.setState({ publicKey: VALID_B58, connected: false });
    const adapter = new SolanaWalletAdapter();
    expect(await adapter.getAddress()).toBeNull();
  });

  it("bridge con base58 deforme ⇒ null: la rehidratación valida igual que connect() (CD-SDD-5)", async () => {
    solanaWalletBridge.setState({ publicKey: "0OIl-not-base58", connected: true });
    const adapter = new SolanaWalletAdapter();
    expect(await adapter.getAddress()).toBeNull();
  });

  it("la rehidratación NO cachea: si la wallet se desconecta, la llamada siguiente vuelve a null", async () => {
    solanaWalletBridge.setState({ publicKey: VALID_B58, connected: true });
    const adapter = new SolanaWalletAdapter();
    expect(await adapter.getAddress()).toBe(VALID_B58);
    // La persona desconecta desde Phantom → el sync component empuja el estado nuevo.
    solanaWalletBridge.setState({ publicKey: null, connected: false });
    expect(await adapter.getAddress()).toBeNull(); // fail-loud, NO una address vieja que ya no firma
  });

  it("connect() gana sobre el bridge: la address cacheada sobrevive a un bridge que se vació", async () => {
    solanaWalletBridge.setState({ publicKey: VALID_B58, connected: true });
    const adapter = new SolanaWalletAdapter();
    await adapter.connect();
    solanaWalletBridge.setState({ publicKey: null, connected: false });
    expect(await adapter.getAddress()).toBe(VALID_B58); // candado: el path viejo no cambió
  });

  it("modal cerrado sin conectar → waitForConnection rechaza → connect() throw", async () => {
    solanaWalletBridge.registerOpenModal(() => {});
    const adapter = new SolanaWalletAdapter();
    const p = adapter.connect();
    solanaWalletBridge.cancelConnection(); // usuario cierra el modal
    await expect(p).rejects.toThrow("wallet_connect_cancelled");
  });

  it("openModal sin árbol montado → throw wallet_bridge_not_mounted", async () => {
    const adapter = new SolanaWalletAdapter(); // bridge reseteado, sin openModal registrado
    await expect(adapter.connect()).rejects.toThrow("wallet_bridge_not_mounted");
  });
});

// ── HU-SOL-5 (WKH-207*) — authorizePrincipal real: ix deposit al escrow (SPL, gasless) ────────
const ESCROW_PROGRAM_ID = "DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x";
const DEPOSIT_DISCRIMINATOR = [242, 35, 198, 137, 82, 225, 242, 182];
// WKH-347 — el de la 2ª ix de negocio. Verificado en dos lugares independientes: la copia pinneada
// del IDL y el pin de contracts/idl/escrow-idl.hash.test.ts.
const REGISTER_ESCROW_DISCRIMINATOR = [200, 17, 194, 170, 224, 144, 127, 166];
const FIXED_BLOCKHASH = Keypair.generate().publicKey.toBase58(); // 32 bytes base58 válido (NO devnet)

// Pubkeys de test (on-curve, base58 válidos) — nada hardcodeado en el adapter.
const SENDER_KP = Keypair.generate();
const SENDER_B58 = SENDER_KP.publicKey.toBase58();
const BENEFICIARY_B58 = Keypair.generate().publicKey.toBase58();
const AUTHORITY_B58 = Keypair.generate().publicKey.toBase58();
const FACILITATOR_B58 = Keypair.generate().publicKey.toBase58();
const MINT_B58 = VALID_B58;

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    quoteId: "q-sol-5",
    send: Money.fromMinor(12_345_678, "USDC"), // 12.345678 USDC → u64 minor
    receive: Money.fromMinor(4_500_00, "PEN"),
    feeUsd: Money.fromMinor(100_000, "USDC"),
    rate: 3.64,
    etaMinutes: 5,
    expiresAt: "2099-01-01T00:00:00.000Z",
    provenance: "test",
    ...overrides,
  };
}

/** Conecta el adapter simulando que la wallet ya está conectada (bridge state). */
async function connectedAdapter(): Promise<SolanaWalletAdapter> {
  solanaWalletBridge.setState({ publicKey: SENDER_B58, connected: true });
  const adapter = new SolanaWalletAdapter();
  await adapter.connect();
  return adapter;
}

/** [u8;16] determinístico (mismo algoritmo que el adapter: sha256(remittanceId)[:16]). */
function remittanceIdBytes16(remittanceId: string): Uint8Array {
  return Uint8Array.from(sha256(new TextEncoder().encode(remittanceId)).subarray(0, 16));
}

/** Narrowing helpers (tsc noUncheckedIndexedAccess) — la tx firmada capturada por el bridge fake. */
function capturedTx(spy: ReturnType<typeof vi.fn>): Transaction {
  const call = spy.mock.calls[0];
  if (!call) throw new Error("signTransaction_not_called");
  return call[0] as Transaction;
}
/** Las ix DE NEGOCIO de la tx, en orden: las que no son de ComputeBudget.
 *
 *  Se filtra por el programId de ComputeBudget y NO se toma `instructions[2]` a ciegas, y esa parte
 *  no cambió: WKH-321 antepuso dos ComputeBudget y la billetera puede anteponer más, así que la
 *  POSICIÓN ABSOLUTA del `deposit` sigue sin ser un invariante.
 *
 *  🔴 LO QUE SÍ CAMBIÓ (WKH-347). Esto era un `.find()` por programId, y su comentario decía que
 *  buscar por índice codificaría un invariante inexistente. A partir de esta HU la transacción lleva
 *  DOS ix del MISMO programId —`deposit` y `register_escrow`—, así que un `.find()` devuelve la
 *  primera y NO DISTINGUE un orden invertido: el mutante que las intercambia pasaba en verde. Y ese
 *  orden sí es un invariante, con TRES actores que dependen de él por posición: el CR-1 del
 *  facilitator, el Guard A de SDD 037 y nuestro propio servidor
 *  (`tx.instructions.filter`, `settlement/solana-deposit-beneficiary.ts:106`).
 *  ⇒ el orden RELATIVO entre las de negocio se asserta posicionalmente: `[0]` es el `deposit` y `[1]`
 *  el `register_escrow`. */
function businessIx(tx: Transaction) {
  // 🔴 WKH-357 — SE FILTRA TAMBIÉN EL SYSTEM PROGRAM, y no es cosmético: la rama de enlace prepone una
  // `nonceAdvance`, que NO es de ComputeBudget, así que con el filtro viejo `businessIx(tx)[0]` dejó de
  // ser el `deposit` y pasó a ser la `nonceAdvance` — 4 bytes de `data` en vez de 104.
  //
  // ⚠️ CÓMO SE MANIFESTÓ, porque es la parte que importa: el `it` "CASO B" pisa 32 bytes en el offset
  // 24 del `data` con `Buffer.copy`, y `copy` sobre un buffer de 4 bytes en el offset 24 NO TIRA: no
  // copia nada, en silencio. O sea que el test dejó de alterar la transacción y pasó a afirmar que una
  // tx intacta es una tx intacta — verde sobre nada. Sin este filtro, el `it` que mide la alteración
  // deja de medirla.
  const cb = ComputeBudgetProgram.programId;
  return tx.instructions.filter(
    (i) => !i.programId.equals(cb) && !i.programId.equals(SystemProgram.programId),
  );
}
/** La ix de negocio de la POSICIÓN 0, que es y tiene que seguir siendo el `deposit`. */
function depositIx(tx: Transaction) {
  const ix = businessIx(tx)[0];
  if (!ix) throw new Error("deposit_ix_not_found");
  return ix;
}

/** La PDA del índice del sender: seeds ["escrow-index", sender]. Portado de
 *  `solana-wallet.close.test.ts`, misma derivación. */
const ESCROW_INDEX_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from("escrow-index"), SENDER_KP.publicKey.toBuffer()],
  new PublicKey(ESCROW_PROGRAM_ID),
)[0];

/** `EscrowIndex` real y DECODIFICABLE. Portado de `solana-wallet.close.test.ts`: que decodifique es
 *  la mitad del punto, porque la sonda no acepta "hay bytes en esa dirección", exige que sean el
 *  índice de ESTE sender. `entries` es `vec<[u8;16]>`, o sea los bytes crudos del id16. */
function encodeEscrowIndex(entryIds: string[] = []): Buffer {
  const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
  return coder.encode("EscrowIndex", {
    sender: SENDER_KP.publicKey,
    version: 1,
    bump: 254,
    entries: entryIds.map((id) => Array.from(remittanceIdBytes16(id))),
  }) as unknown as Buffer;
}

/** Qué contesta la cadena para UNA pubkey. Portado de `solana-wallet.close.test.ts`. Mapea POR PDA y
 *  nunca por orden de llamada: una pubkey que nadie declaró contesta `null`, jamás la respuesta de
 *  otra cuenta. `"throw"` simula el RPC caído y `"hang"` el que acepta la conexión y no contesta. */
type Reply = Buffer | null | "throw" | "hang";

function mockChain(byPda: Record<string, Reply> = {}) {
  return vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation((async (k: PublicKey) => {
    const reply = byPda[k.toBase58()] ?? null;
    if (reply === "throw") throw new Error("rpc_down");
    if (reply === "hang") return new Promise(() => {}); // nunca resuelve
    return reply
      ? { data: reply, executable: false, lamports: 1, owner: new PublicKey(ESCROW_PROGRAM_ID), rentEpoch: 0 }
      : null;
  }) as never);
}

describe("SolanaWalletAdapter.authorizePrincipal (HU-SOL-5)", () => {
  let signSpy: ReturnType<typeof vi.fn>;
  let signMessageSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_USDC_MINT", MINT_B58);
    vi.stubEnv("NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY", FACILITATOR_B58);
    // Blockhash mock — NUNCA pega a devnet (Story Test Expectations).
    vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
      blockhash: FIXED_BLOCKHASH,
      lastValidBlockHeight: 1,
    } as Awaited<ReturnType<Connection["getLatestBlockhash"]>>);
    // Spies de broadcast — AC-3: deben quedar en 0 (mock para no pegar a red).
    vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("sig-never" as never);
    vi.spyOn(Connection.prototype, "sendTransaction").mockResolvedValue("sig-never" as never);
    // 🔴 WKH-357 — SIN ESTE MOCK, 13 `it` DE LA RAMA DE ENLACE PEGABAN A DEVNET DE VERDAD, y no es una
    // hipótesis: `authorizePrincipal` pasó a consultar el saldo del remitente antes de armar la tx, y
    // `probeSenderSolBalance` arma su PROPIA `Connection` contra el RPC público. Medido el 2026-08-17
    // corriendo `getBalance` de una pubkey nueva contra `api.devnet.solana.com`: devuelve `0`, o sea
    // `{status:"known", lamports:0}`, que está por debajo del umbral y cortaba los 13 con
    // `deeplink_saldo_insuficiente` antes de que pudieran medir su propio guard. Un test que depende
    // de que la red conteste 0 no está midiendo lo que dice medir, y encima viola la regla de este
    // repo de no pegar a devnet en la suite.
    //
    // El valor: MUY por encima del umbral del camino por enlace, para que ningún `it` de acá dependa
    // del número exacto. Los `it` que SÍ miden el guard de saldo (T-27) lo pisan con su propio valor.
    vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(1_000_000_000 as never);
    // 🔴 WKH-347 — SIN ESTO LA SONDA DEL ÍNDICE PEGA A LA RED DE VERDAD. `authorizePrincipal` pasó a
    // leer la PDA `["escrow-index", sender]` antes de armar la tx, y sin mock cada `it` de este
    // describe esperaba los 5 s del techo de la sonda contra un RPC real y moría por timeout de
    // vitest. El default es el índice AUSENTE, que es el caso de un remitente que deposita por
    // primera vez: la cadena CONTESTA que no existe ⇒ la tx lleva la 2ª ix de negocio. Los describes
    // que necesitan otra respuesta (índice lleno, RPC caído) la declaran ellos.
    mockChain({});
    // Bridge signTransaction fake — partial-sign SÓLO wallet: devuelve la MISMA tx (AC-2).
    //
    // ⚠️ SDD 037: este fake antes devolvía la tx SIN firmarla, o sea que simulaba una wallet que
    // dice "listo" y no firma nada. Nadie lo notaba porque nada leía la firma. Ahora el adapter la
    // necesita para armar la línea `tx:` del mensaje canónico, así que el fake firma DE VERDAD con
    // SENDER_KP. El test dejó de aceptar una wallet que no hace su trabajo.
    signSpy = vi.fn(async (tx: unknown) => {
      (tx as Transaction).partialSign(SENDER_KP);
      return tx;
    });
    solanaWalletBridge.registerSignTransaction(signSpy);
    // SDD 037 — SEGUNDO prompt: la wallet firma además el mensaje canónico (ed25519 real).
    signMessageSpy = vi.fn(async (bytes: Uint8Array) =>
      nacl.sign.detached(bytes, SENDER_KP.secretKey),
    );
    solanaWalletBridge.registerSignMessage(signMessageSpy);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const escrowDeposit = () => ({
    address: "unused-evm-field",
    escrow: { beneficiary: BENEFICIARY_B58, authority: AUTHORITY_B58 },
  });

  it("AC-1: arma la ix deposit (programId DR5G…SE4x, discriminator, accounts del IDL + PDAs/ATA)", async () => {
    const adapter = await connectedAdapter();
    const rid = "rem-ac1";
    await adapter.authorizePrincipal(makeQuote(), rid, escrowDeposit());

    const ix = depositIx(capturedTx(signSpy));
    expect(ix.programId.toBase58()).toBe(ESCROW_PROGRAM_ID);
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(DEPOSIT_DISCRIMINATOR);

    // accounts del IDL (9 desde WKH-343) + reference (1) = 10, sin alterar el set del IDL.
    expect(ix.keys).toHaveLength(10);
    const programId = new PublicKey(ESCROW_PROGRAM_ID);
    const bytes = remittanceIdBytes16(rid);
    const [escrowStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), SENDER_KP.publicKey.toBuffer(), Buffer.from(bytes)],
      programId,
    );
    const mintPk = new PublicKey(MINT_B58);
    const vault = getAssociatedTokenAddressSync(mintPk, escrowStatePda, true);
    const senderAta = getAssociatedTokenAddressSync(mintPk, SENDER_KP.publicKey);
    const keyStrs = ix.keys.map((k) => k.pubkey.toBase58());
    expect(keyStrs).toContain(escrowStatePda.toBase58()); // escrow_state PDA
    expect(keyStrs).toContain(vault.toBase58()); // vault ATA
    expect(keyStrs).toContain(senderAta.toBase58()); // sender_ata
    expect(keyStrs).toContain(SENDER_B58); // sender (signer)
  });

  // ── WKH-343 — la NOVENA cuenta del deposit, la que rompió producción ───────────────────────────
  //
  // Qué se rompió y por qué este test no es "contar hasta 9": el programa desplegado pasó a exigir
  // `beneficiary_ata` en el índice 8; el IDL vendoreado declaraba 8 cuentas y no la incluía; Anchor
  // completa las que faltan DESDE el IDL y tolera cuentas de más pero no de menos ⇒ la ix salía con 8
  // y CADA depósito fallaba. Un assert de longitud sola no habría cazado nada de eso: el `reference`
  // de los remainingAccounts ya hacía que la ix tuviera 9 keys ANTES del fix, así que "9" era el
  // número de la versión ROTA. Por eso acá se asertea POSICIÓN por POSICIÓN contra pubkeys derivadas
  // de forma independiente, y no un total.
  //
  // Los inputs que lo ponen en rojo, MEDIDOS uno por uno con el fix puesto, no deducidos:
  //   1. revertir el IDL vendoreado a las 8 cuentas viejas → ROJO. Es la regresión de producción
  //      exacta, y es la mutación que importa: el índice 8 pasa a ser el `reference`.
  //   2. derivar la ATA del sender en vez del beneficiario → ROJO por el assert posicional.
  //   3. mandarla con `mut` o como firmante → ROJO por los dos asserts de flags.
  // Y uno que NO lo pone en rojo, escrito acá para que nadie lo descubra a los golpes: sacar
  // `beneficiaryAta` del `.accounts()` del adapter deja este test VERDE, porque con el IDL nuevo el
  // resolver de anchor deriva la cuenta solo. No es un agujero del test: es que el explícito es
  // defensa en profundidad (AR-MNR-1) y el que sostiene la corrección es el IDL. Lo que candea el
  // IDL es el caso 1 de arriba, más el pin de contracts/idl/escrow-idl.hash.test.ts.
  it("★ WKH-343: la ix deposit lleva 9 cuentas del IDL y la del índice 8 es la ATA del BENEFICIARIO, no writable y no signer", async () => {
    const adapter = await connectedAdapter();
    const rid = "rem-wkh343";
    await adapter.authorizePrincipal(makeQuote(), rid, escrowDeposit());

    const ix = depositIx(capturedTx(signSpy));
    const programId = new PublicKey(ESCROW_PROGRAM_ID);
    const mintPk = new PublicKey(MINT_B58);
    const beneficiaryPk = new PublicKey(BENEFICIARY_B58);
    const [escrowStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), SENDER_KP.publicKey.toBuffer(), Buffer.from(remittanceIdBytes16(rid))],
      programId,
    );
    // Derivadas acá, no copiadas del adapter. La del beneficiario SIN allowOwnerOffCurve: su dueño es
    // una cuenta on-curve, a diferencia del vault (dueño = PDA). Si el adapter usara `true` acá, la
    // dirección sería la MISMA para un owner on-curve, así que ese error no lo caza esta línea: lo
    // caza que el adapter no puede derivar una ATA de un owner off-curve sin el flag y tiraría.
    const expected = [
      SENDER_KP.publicKey.toBase58(), // 0 sender
      mintPk.toBase58(), // 1 mint
      escrowStatePda.toBase58(), // 2 escrow_state
      getAssociatedTokenAddressSync(mintPk, escrowStatePda, true).toBase58(), // 3 vault
      getAssociatedTokenAddressSync(mintPk, SENDER_KP.publicKey).toBase58(), // 4 sender_ata
      TOKEN_PROGRAM_ID.toBase58(), // 5 token_program
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), // 6 associated_token_program
      SystemProgram.programId.toBase58(), // 7 system_program
      getAssociatedTokenAddressSync(mintPk, beneficiaryPk).toBase58(), // 8 beneficiary_ata
    ];
    expect(ix.keys.slice(0, 9).map((k) => k.pubkey.toBase58())).toEqual(expected);

    // Y que la novena NO sea ninguna de las otras ocho: sin esto, un adapter que repitiera el mint (o
    // el sender_ata) en el índice 8 podría pasar si alguna derivación colapsara.
    expect(new Set(expected).size).toBe(9);

    // LOS FLAGS, que son la mitad de dinero del asunto. CR-1 acepta cuentas desde el índice 8 sólo si
    // son no-signer y no-writable (wasiai-facilitator/src/methods/solana-sponsor/cr1.ts:284-288 →
    // REMAINING_ACCOUNT_FLAGS_INVALID). Una `beneficiary_ata` writable haría rebotar el 100% de los
    // depósitos patrocinados: cambiaría una rotura por dos.
    const ninth = ix.keys[8];
    if (!ninth) throw new Error("la ix deposit no tiene una 9ª cuenta");
    expect(ninth.isWritable).toBe(false);
    expect(ninth.isSigner).toBe(false);

    // El `reference` (AC-4) sigue DESPUÉS, en el índice 9: la cuenta nueva no lo desplazó fuera ni lo
    // pisó. Comprobado por descarte — es la única key que no está en las 9 del IDL.
    const reference = ix.keys[9];
    if (!reference) throw new Error("la ix deposit perdió el `reference`");
    expect(expected).not.toContain(reference.pubkey.toBase58());
    expect(reference.isWritable).toBe(false);
    expect(reference.isSigner).toBe(false);
  });

  // ── SDD 037 — Guard B: el SEGUNDO prompt de billetera ──────────────────────────────────────────
  //
  // La persona firma la transacción y DESPUÉS un texto que dice qué autoriza. Son dos preguntas
  // distintas: la primera prueba posesión de la llave, la segunda prueba consentimiento sobre este
  // monto, este token y esta red. Sin la segunda, una firma de transacción capturada alcanza para
  // pedirle al facilitator que patrocine cualquier cosa.
  it("★ SDD 037: signMessage se llama UNA vez, con el mensaje canónico EXACTO", async () => {
    const adapter = await connectedAdapter();
    const rid = "rem-037";
    const quote = makeQuote();
    await adapter.authorizePrincipal(quote, rid, escrowDeposit());

    expect(signMessageSpy).toHaveBeenCalledTimes(1);

    // El mensaje esperado se reconstruye acá A MANO, línea por línea, NUNCA llamando al builder
    // (CD-9): un assert contra el builder se movería junto con el mutante y pasaría siempre.
    const signedTx = capturedTx(signSpy);
    const senderSig = signedTx.signatures.find((s) => s.publicKey.equals(SENDER_KP.publicKey))
      ?.signature;
    expect(senderSig).toBeTruthy();
    const expectedMessage =
      "WasiAI Sponsor Request v1\n" +
      `sender: ${SENDER_B58}\n` +
      "network: solana:devnet\n" +
      `remittance: ${rid}\n` +
      `amount: ${String(quote.send.minor)}\n` +
      `mint: ${MINT_B58}\n` +
      `tx: ${bs58.encode(new Uint8Array(senderSig as Uint8Array))}`;

    const sentBytes = signMessageSpy.mock.calls[0]?.[0] as Uint8Array;
    expect(new TextDecoder().decode(sentBytes)).toBe(expectedMessage);
  });

  it("★ SDD 037: el envelope trae popSignature, y es una firma REAL del sender sobre ese mensaje", async () => {
    const adapter = await connectedAdapter();
    const rid = "rem-037-envelope";
    const quote = makeQuote();
    const res = esperarAutorizacionLista(await adapter.authorizePrincipal(quote, rid, escrowDeposit()));

    const popSignature = res.solana?.popSignature;
    expect(typeof popSignature).toBe("string");
    expect(bs58.decode(popSignature as string)).toHaveLength(64);

    // Verificación de punta a punta: la firma que sale del envelope valida contra el pubkey del
    // sender y contra los bytes que efectivamente se le pidió firmar. Es lo que el facilitator hace.
    const sentBytes = signMessageSpy.mock.calls[0]?.[0] as Uint8Array;
    expect(
      nacl.sign.detached.verify(
        sentBytes,
        bs58.decode(popSignature as string),
        SENDER_KP.publicKey.toBytes(),
      ),
    ).toBe(true);
  });

  it("★ SDD 037: si la wallet devuelve la tx SIN firmar, corta fail-loud y NO pide el segundo prompt", async () => {
    // Una wallet que dice "listo" sin firmar no puede producir un patrocinio: seguir armaría un
    // mensaje con la línea `tx` vacía, le pediría a la persona un segundo prompt inútil y el
    // servidor lo rechazaría igual. Mejor cortar acá y decir por qué.
    signSpy.mockImplementation(async (tx: unknown) => tx); // no firma
    const adapter = await connectedAdapter();
    await expect(
      adapter.authorizePrincipal(makeQuote(), "rem-037-nosig", escrowDeposit()),
    ).rejects.toThrow("sender_signature_missing");
    expect(signMessageSpy).not.toHaveBeenCalled();
  });

  it("AC-2/CD-SDD-5: feePayer = facilitator; firma SÓLO la wallet (bridge) 1×", async () => {
    const adapter = await connectedAdapter();
    await adapter.authorizePrincipal(makeQuote(), "rem-ac2", escrowDeposit());

    expect(signSpy).toHaveBeenCalledTimes(1); // partial-sign wallet-only
    const tx = capturedTx(signSpy);
    expect(tx.feePayer?.toBase58()).toBe(FACILITATOR_B58); // facilitator paga el fee
    expect(tx.feePayer?.toBase58()).not.toBe(SENDER_B58); // NUNCA la wallet
    expect(tx.recentBlockhash).toBe(FIXED_BLOCKHASH);
  });

  it("AC-3/CD-SDD-1: NUNCA broadcast; return trae solana.partialSignedTx b64 + reference b58", async () => {
    const adapter = await connectedAdapter();
    const res = esperarAutorizacionLista(await adapter.authorizePrincipal(makeQuote(), "rem-ac3", escrowDeposit()));

    expect(Connection.prototype.sendRawTransaction).not.toHaveBeenCalled();
    expect(Connection.prototype.sendTransaction).not.toHaveBeenCalled();
    expect(res.solana?.vm).toBe("solana");
    expect(res.solana?.partialSignedTx).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64
    expect(res.tx).toBe(res.solana?.partialSignedTx); // shape base del port
    expect(() => new PublicKey(res.solana?.reference ?? "")).not.toThrow(); // reference base58 válido
    // el serializado deserializa a la MISMA ix (deposit)
    const back = Transaction.from(Buffer.from(res.solana?.partialSignedTx ?? "", "base64"));
    expect(depositIx(back).programId.toBase58()).toBe(ESCROW_PROGRAM_ID);
  });

  it("AC-4/CD-SDD-6: reference como remainingAccount no-signer/no-writable, al final del set", async () => {
    const adapter = await connectedAdapter();
    const res = esperarAutorizacionLista(await adapter.authorizePrincipal(makeQuote(), "rem-ac4", escrowDeposit()));

    const ix = depositIx(capturedTx(signSpy));
    const last = ix.keys[ix.keys.length - 1];
    if (!last) throw new Error("no_reference_key");
    expect(last.pubkey.toBase58()).toBe(res.solana?.reference); // reference es el último account
    expect(last.isSigner).toBe(false);
    expect(last.isWritable).toBe(false);
  });

  it("AC-7: sin wallet conectada → throw wallet_not_connected SIN firmar", async () => {
    const adapter = new SolanaWalletAdapter(); // sin connect ⇒ getAddress()→null
    await expect(
      adapter.authorizePrincipal(makeQuote(), "rem-ac7", escrowDeposit()),
    ).rejects.toThrow("wallet_not_connected");
    expect(signSpy).not.toHaveBeenCalled();
  });

  it("CD-SDD-8: sin escrow (beneficiary/authority) → throw escrow_params_missing SIN firmar", async () => {
    const adapter = await connectedAdapter();
    await expect(
      adapter.authorizePrincipal(makeQuote(), "rem-noescrow", { address: "x" }),
    ).rejects.toThrow("escrow_params_missing");
    expect(signSpy).not.toHaveBeenCalled();
  });

  it("AC-8/CD-SDD-3: amount = String(send.minor) (u64), deadline = now + CUSTODY_WINDOW_SECS, sin float", async () => {
    const adapter = await connectedAdapter();
    const quote = makeQuote({ expiresAt: "2099-06-15T12:00:00.000Z" });
    const before = Math.floor(Date.now() / 1000);
    await adapter.authorizePrincipal(quote, "rem-ac8", escrowDeposit());
    const after = Math.floor(Date.now() / 1000);

    const data = depositIx(capturedTx(signSpy)).data;
    // layout borsh: 8 disc + 16 remittance_id + 32 beneficiary + 32 authority + 8 amount(LE) + 8 deadline(LE)
    const amount = data.readBigUInt64LE(8 + 16 + 32 + 32);
    const deadline = data.readBigInt64LE(8 + 16 + 32 + 32 + 8);
    expect(amount).toBe(BigInt(quote.send.minor));
    // Cableado: el deadline es el ahora del cliente más la constante, no otra cosa. Ventana
    // [before, after] porque el reloj corre entre que arranca el test y que se arma la ix.
    expect(deadline).toBeGreaterThanOrEqual(BigInt(before + CUSTODY_WINDOW_SECS));
    expect(deadline).toBeLessThanOrEqual(BigInt(after + CUSTODY_WINDOW_SECS));
  });

  // Este test NO importa la constante a propósito. Los 3600/86400 están escritos a mano porque son
  // los del PROGRAMA (`programs/escrow/src/lib.rs`:111 y :119 en el repo `solana-programs`), y lo
  // que tiene que sostener es que nuestro número cae adentro de los suyos. Un test que comparara
  // contra CUSTODY_WINDOW_SECS probaría el cableado y aplaudiría igual si alguien la pusiera en 600.
  it("el deadline cae dentro de la ventana que el programa acepta: [now+3600, now+86400]", async () => {
    const adapter = await connectedAdapter();
    const before = Math.floor(Date.now() / 1000);
    await adapter.authorizePrincipal(makeQuote(), "rem-ventana", escrowDeposit());
    const after = Math.floor(Date.now() / 1000);

    const data = depositIx(capturedTx(signSpy)).data;
    const deadline = Number(data.readBigInt64LE(8 + 16 + 32 + 32 + 8));

    // Piso: contra el `after`, que es el peor caso del reloj del validador si la tx entra ya mismo.
    expect(deadline - after).toBeGreaterThanOrEqual(3600); // MIN_CUSTODY_SECS → DeadlineTooSoon
    expect(deadline - before).toBeLessThanOrEqual(86_400); // MAX_CUSTODY_SECS → DeadlineTooFar
    // Y con margen real sobre el piso: pedir exactamente 3600 pierde toda tx que tarde en entrar.
    expect(deadline - after).toBeGreaterThanOrEqual(3600 + 900);
  });

  // La regresión concreta: el deadline salía de `quote.expiresAt` y el TTL de la cotización es de
  // 10 minutos, o sea DEBAJO del piso del programa. Con esa versión el programa rechazaba todos los
  // depósitos con DeadlineTooSoon. Una cotización que vence en 10 minutos ya no cambia el deadline.
  it("una cotización que vence en 10 minutos NO acorta el deadline (el bug del DeadlineTooSoon)", async () => {
    const adapter = await connectedAdapter();
    const diezMinutos = new Date(Date.now() + 10 * 60_000).toISOString();
    await adapter.authorizePrincipal(
      makeQuote({ expiresAt: diezMinutos }),
      "rem-ttl-corto",
      escrowDeposit(),
    );
    const after = Math.floor(Date.now() / 1000);

    const data = depositIx(capturedTx(signSpy)).data;
    const deadline = Number(data.readBigInt64LE(8 + 16 + 32 + 32 + 8));

    expect(deadline - after).toBeGreaterThanOrEqual(3600); // habría sido ~600 antes del fix
    // Y explícitamente: el deadline NO es el de la cotización.
    expect(deadline).not.toBe(Math.floor(Date.parse(diezMinutos) / 1000));
  });

  it("AC-8: expiresAt inválido → throw quote_expires_at_invalid", async () => {
    const adapter = await connectedAdapter();
    await expect(
      adapter.authorizePrincipal(makeQuote({ expiresAt: "not-a-date" }), "rem-bad", escrowDeposit()),
    ).rejects.toThrow("quote_expires_at_invalid");
  });

  // ── WKH-321 / SDD 038 — Chaski declara SU presupuesto de cómputo ──────────────────────────────
  //
  // Qué cubren estos tests: QUÉ EMITE Chaski — cuáles instrucciones, en qué orden, con qué valores,
  // y que las tres estaban adentro de lo que la billetera firmó. Qué NO cubren, porque no se puede
  // cubrir desde acá: qué hace después una billetera real con esa transacción. Si Phantom agrega
  // igual las suyas, el facilitator responde otro 422 (TOO_MANY_COMPUTE_BUDGET_IX / DUP_*), no un
  // éxito; eso sólo lo cierra un recorrido manual con una wallet real.
  //
  // Los discriminadores 2 (SetComputeUnitLimit) y 3 (SetComputeUnitPrice) van como literales A MANO:
  // son el layout del programa ComputeBudget, no un detalle de nuestra librería, y derivarlos de la
  // librería haría que el test se moviera junto con ella.
  const CB_SET_LIMIT = 2;
  const CB_SET_PRICE = 3;

  // T1 cubre la mitad ESPACIAL del AC-1 (cuáles ix, en qué posiciones). La mitad TEMPORAL —"antes
  // de firmar"— NO la cubre: mide `capturedTx(signSpy)`, que es el estado FINAL de la tx, y un
  // adapter que agregara las ComputeBudget después de `signTransaction` pasaría este test igual.
  // Esa mitad la cubre T3, y sólo T3. Así fue como el mutante M3 sobrevivió la primera vuelta: el
  // claim temporal repartido entre dos tests, y nadie notó que uno no hacía su mitad. Si algún día
  // se toca T3, esta mitad del AC-1 se queda sin cobertura.
  // 🔴 MIGRADO EN WKH-347, y el número que cambió tiene una razón: con el índice AUSENTE (el default
  // de este describe) la tx lleva CUATRO instrucciones, porque el depósito registra el escrow en el
  // índice del remitente en la MISMA transacción. El 3 de antes era el de una tx de una sola ix de
  // negocio, que ahora es el caso de AC-5/AC-6 y lo cubren sus propios tests. No se debilitó nada:
  // las dos ComputeBudget siguen siendo exactamente dos, siguen primeras y siguen en ese orden.
  it("T1 (AC-1 mitad espacial / AC-5): la tx lleva 4 ix — [SetComputeUnitLimit, SetComputeUnitPrice, deposit, register_escrow], en ese orden — el 'antes de firmar' lo cubre T3", async () => {
    const adapter = await connectedAdapter();
    await adapter.authorizePrincipal(makeQuote(), "rem-cb-orden", escrowDeposit());

    const tx = capturedTx(signSpy);
    expect(tx.instructions).toHaveLength(4);

    const [limitIx, priceIx, depositBiz, registerBiz] = tx.instructions;
    if (!limitIx || !priceIx || !depositBiz || !registerBiz) throw new Error("missing_instruction");

    // Posición 0: el LÍMITE. Posicional a propósito: acá se verifica el ORDEN, no se localiza el deposit.
    expect(limitIx.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(limitIx.data.readUInt8(0)).toBe(CB_SET_LIMIT);
    // Posición 1: el PRECIO.
    expect(priceIx.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(priceIx.data.readUInt8(0)).toBe(CB_SET_PRICE);
    // Posición 2: el negocio, y es el `deposit`. Se asserta el DISCRIMINADOR y no sólo el programId:
    // con dos ix del mismo programa, "es del escrow" ya no distingue cuál de las dos es.
    expect(depositBiz.programId.toBase58()).toBe(ESCROW_PROGRAM_ID);
    expect(Array.from(depositBiz.data.subarray(0, 8))).toEqual(DEPOSIT_DISCRIMINATOR);
    // Posición 3: el `register_escrow`, DESPUÉS. Ver el comentario de `businessIx` para los tres
    // actores que dependen de este orden por posición.
    expect(registerBiz.programId.toBase58()).toBe(ESCROW_PROGRAM_ID);
    expect(Array.from(registerBiz.data.subarray(0, 8))).toEqual(REGISTER_ESCROW_DISCRIMINATOR);
  });

  it("T2 (AC-2): los valores emitidos son 120.000 CU y 10.000 µL/CU", async () => {
    const adapter = await connectedAdapter();
    await adapter.authorizePrincipal(makeQuote(), "rem-cb-valores", escrowDeposit());

    const tx = capturedTx(signSpy);
    const [limitIx, priceIx] = tx.instructions;
    if (!limitIx || !priceIx) throw new Error("missing_instruction");

    // Literales A MANO, NUNCA llamando a los resolvers: un assert contra el resolver se mueve junto
    // con el mutante y pasa siempre (mismo criterio que el test del mensaje canónico de SDD 037).
    // Layout: u8 discriminador + u32 units (limit) / u64 microLamports (price).
    expect(limitIx.data.readUInt32LE(1)).toBe(120_000);
    expect(priceIx.data.readBigUInt64LE(1)).toBe(10_000n);
  });

  it("T3 (AC-1/AC-3, CD-1): las 3 ix ya estaban puestas EN EL MOMENTO en que la billetera firmó", async () => {
    // El spy del beforeEach guarda la REFERENCIA de la tx, y el adapter la sigue teniendo en la mano:
    // cualquier assert sobre `capturedTx(signSpy)` mide el estado FINAL, no el estado al firmar. Un
    // adapter que agregara las ComputeBudget después de `signTransaction` pasaría ese assert igual
    // (comprobado: el mutante M3 lo sobrevivía). Por eso acá se toma una FOTO de la lista de
    // instrucciones dentro del propio callback, antes de firmar.
    let snapshot: Array<{ programId: string; kind: number }> = [];
    const snapshotSpy = vi.fn(async (tx: unknown) => {
      const t = tx as Transaction;
      snapshot = t.instructions.map((i) => ({
        programId: i.programId.toBase58(),
        kind: i.data.readUInt8(0),
      }));
      t.partialSign(SENDER_KP); // el fake sigue firmando de verdad (CD-9)
      return tx;
    });
    solanaWalletBridge.registerSignTransaction(snapshotSpy);

    const adapter = await connectedAdapter();
    await adapter.authorizePrincipal(makeQuote(), "rem-cb-antes", escrowDeposit());

    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    // 🔴 MIGRADO EN WKH-347: 4 y no 3, porque la tx lleva además el `register_escrow`. Y esta foto es
    // justo la que prueba lo que más importa de esa ix nueva: que estaba puesta ANTES de firmar. Si
    // alguien la agregara después de `signTransaction`, la firma ed25519 del sender dejaría de
    // validar sobre el mensaje recompilado y arrastraría al mensaje canónico de SDD 037, que lleva
    // esa firma adentro.
    expect(snapshot).toHaveLength(4);
    expect(snapshot[0]).toEqual({
      programId: ComputeBudgetProgram.programId.toBase58(),
      kind: CB_SET_LIMIT,
    });
    expect(snapshot[1]).toEqual({
      programId: ComputeBudgetProgram.programId.toBase58(),
      kind: CB_SET_PRICE,
    });
    expect(snapshot[2]?.programId).toBe(ESCROW_PROGRAM_ID);
    expect(snapshot[3]?.programId).toBe(ESCROW_PROGRAM_ID);
  });

  it("T4 (AC-3): agregar una ix DESPUÉS de firmar invalida la firma del sender", async () => {
    const adapter = await connectedAdapter();
    await adapter.authorizePrincipal(makeQuote(), "rem-cb-firma", escrowDeposit());

    const tx = capturedTx(signSpy);
    const senderSig = tx.signatures.find((s) => s.publicKey.equals(SENDER_KP.publicKey))?.signature;
    if (!senderSig) throw new Error("sender_signature_missing");

    // 1) Tal como salió: la firma VALIDA sobre el mensaje compilado con las 3 ix.
    expect(
      nacl.sign.detached.verify(
        tx.serializeMessage(),
        new Uint8Array(senderSig),
        SENDER_KP.publicKey.toBytes(),
      ),
    ).toBe(true);

    // 2) Se agrega una ix SIN CUENTAS (otra ComputeBudget). Tiene que ser sin cuentas: si trajera un
    //    firmante nuevo, `_compile()` de web3.js resetea `signatures` a null en silencio y el test
    //    estaría midiendo un null, no una firma inválida.
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 111_111 }));

    // 3) La MISMA firma ya no valida: serializeMessage() recompiló el mensaje y los bytes cambiaron.
    //    Esa es la razón mecánica por la que las dos ComputeBudget van ANTES de signTransaction.
    expect(
      nacl.sign.detached.verify(
        tx.serializeMessage(),
        new Uint8Array(senderSig),
        SENDER_KP.publicKey.toBytes(),
      ),
    ).toBe(false);
  });

  it("T5 (AC-6, no-regresión): la ix deposit se localiza por programId y llega intacta", async () => {
    const adapter = await connectedAdapter();
    const rid = "rem-cb-deposit-intacto";
    await adapter.authorizePrincipal(makeQuote(), rid, escrowDeposit());

    // Localizada por programId, NO por índice: con las ComputeBudget adelante, el `deposit` ya no
    // está en la posición 0 y un lector posicional leería la instrucción equivocada.
    const ix = depositIx(capturedTx(signSpy));
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(DEPOSIT_DISCRIMINATOR);
    expect(ix.keys).toHaveLength(10); // 9 del IDL (WKH-343) + reference

    const programId = new PublicKey(ESCROW_PROGRAM_ID);
    const bytes = remittanceIdBytes16(rid);
    const [escrowStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), SENDER_KP.publicKey.toBuffer(), Buffer.from(bytes)],
      programId,
    );
    const mintPk = new PublicKey(MINT_B58);
    const keyStrs = ix.keys.map((k) => k.pubkey.toBase58());
    expect(keyStrs).toContain(escrowStatePda.toBase58()); // escrow_state PDA
    expect(keyStrs).toContain(getAssociatedTokenAddressSync(mintPk, escrowStatePda, true).toBase58()); // vault
    expect(keyStrs).toContain(getAssociatedTokenAddressSync(mintPk, SENDER_KP.publicKey).toBase58()); // sender_ata
    expect(keyStrs).toContain(SENDER_B58); // sender (signer)
  });

  it("T6 (AC-5): a lo sumo 2 ix ComputeBudget, sin repetidas y sin ninguna fuera de {limit, price}", async () => {
    const adapter = await connectedAdapter();
    await adapter.authorizePrincipal(makeQuote(), "rem-cb-forma", escrowDeposit());

    const cbIx = capturedTx(signSpy).instructions.filter((i) =>
      i.programId.equals(ComputeBudgetProgram.programId),
    );
    expect(cbIx.length).toBeLessThanOrEqual(2); // >2 ⇒ TOO_MANY_COMPUTE_BUDGET_IX del lado del facilitator

    const kinds = cbIx.map((i) => i.data.readUInt8(0));
    // Ninguna RequestUnits (0) ni RequestHeapFrame (1) ni desconocida ⇒ UNSUPPORTED_COMPUTE_BUDGET_IX.
    for (const kind of kinds) expect([CB_SET_LIMIT, CB_SET_PRICE]).toContain(kind);
    // Sin repetidas ⇒ DUP_COMPUTE_UNIT_LIMIT / DUP_COMPUTE_UNIT_PRICE.
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toEqual([CB_SET_LIMIT, CB_SET_PRICE]);
  });

  // T12 — el ÚNICO test que mira el PAYLOAD. T1..T6 assertan sobre `capturedTx(signSpy)`, que es el
  // objeto que Chaski le ENTREGA a la billetera. Lo que producción serializa y postea es lo que la
  // billetera DEVUELVE (`remainingAccounts`, `solana-wallet.ts:637`), y en producción puede ser otro objeto: el
  // adapter serializa `signed`, no `tx`. Si una billetera real agrega sus propias ComputeBudget
  // —el escenario que esta HU declara que NO puede impedir (sdd.md §11.1)—, Chaski postea esa tx
  // sin chistar y ninguno de los seis se entera, porque todos miran el objeto de entrada.
  //
  // Este test cierra ese hueco: deserializa el base64 del envelope, o sea los MISMOS bytes que
  // viajan al facilitator, y verifica ahí las 3 ix con sus valores. Verificado por mutación: con un
  // fake de billetera que devuelve una tx con una ComputeBudget de más (lo que se sospecha que hace
  // Phantom), T12 muere y T1..T6 siguen verdes.
  //
  // Lo que T12 NO prueba: qué hace una Phantom real. Prueba qué postea Chaski dado lo que la
  // billetera devuelve — que es la mitad que sí se puede verificar desde acá.
  it("T12 (AC-5, payload): la tx que se POSTEA trae exactamente [limit 120.000, price 10.000, deposit, register_escrow]", async () => {
    const adapter = await connectedAdapter();
    const res = esperarAutorizacionLista(await adapter.authorizePrincipal(makeQuote(), "rem-cb-payload", escrowDeposit()));

    const posted = Transaction.from(Buffer.from(res.solana?.partialSignedTx ?? "", "base64"));

    // 🔴 MIGRADO EN WKH-347: 4 y no 3, por la 2ª ix de negocio. Lo que este número sigue candeando es
    // lo mismo de antes y no se debilitó: una ix de ComputeBudget de MÁS en el payload ⇒
    // TOO_MANY_COMPUTE_BUDGET_IX / DUP_* del lado del facilitator, que es el 422 que WKH-321 cerró.
    // El assert que lo sostiene es el `cbKinds` de abajo, que cuenta las de ComputeBudget la busque
    // donde la busque, y ése no cambió.
    expect(posted.instructions).toHaveLength(4);
    const [limitIx, priceIx, businessIx] = posted.instructions;
    if (!limitIx || !priceIx || !businessIx) throw new Error("missing_instruction");

    // Los valores van como literales A MANO, igual que en T2: un assert contra los resolvers se
    // movería junto con el mutante y pasaría siempre.
    expect(limitIx.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(limitIx.data.readUInt8(0)).toBe(CB_SET_LIMIT);
    expect(limitIx.data.readUInt32LE(1)).toBe(120_000);
    expect(priceIx.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(priceIx.data.readUInt8(0)).toBe(CB_SET_PRICE);
    expect(priceIx.data.readBigUInt64LE(1)).toBe(10_000n);
    expect(businessIx.programId.toBase58()).toBe(ESCROW_PROGRAM_ID);

    // Y ninguna ComputeBudget de más la busque donde la busque, no sólo en las dos primeras
    // posiciones: una billetera puede APPENDEAR igual que anteponer.
    const cbKinds = posted.instructions
      .filter((i) => i.programId.equals(ComputeBudgetProgram.programId))
      .map((i) => i.data.readUInt8(0));
    expect(cbKinds).toEqual([CB_SET_LIMIT, CB_SET_PRICE]);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // WKH-347 · el depósito registra el escrow en el índice del remitente
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /** La 2ª ix de negocio, por POSICIÓN. Tira si no está: un `?.` acá dejaría pasar en verde el caso
   *  en que la ix nueva no se emitió, que es exactamente lo que estos tests vienen a medir. */
  function registerIx(tx: Transaction) {
    const ix = businessIx(tx)[1];
    if (!ix) throw new Error("register_escrow_ix_not_found");
    return ix;
  }

  it("T-347-1 (AC-1): la 2ª ix de negocio es `register_escrow` — 24 bytes, 4 cuentas posicionales y sus flags", async () => {
    const adapter = await connectedAdapter();
    const rid = "rem-347-forma";
    await adapter.authorizePrincipal(makeQuote(), rid, escrowDeposit());

    const ix = registerIx(capturedTx(signSpy));
    expect(ix.programId.toBase58()).toBe(ESCROW_PROGRAM_ID);
    // 24 = 8 del discriminador + 16 del id16. Un arg de más o de menos lo mueve.
    expect(ix.data.length).toBe(24);
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(REGISTER_ESCROW_DISCRIMINATOR);

    // Las pubkeys se derivan ACÁ, independientes del adapter, y se comparan POSICIONALMENTE. Nunca un
    // total: `keys.length === 4` no distingue un orden invertido de uno correcto.
    const programId = new PublicKey(ESCROW_PROGRAM_ID);
    const [escrowStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), SENDER_KP.publicKey.toBuffer(), Buffer.from(remittanceIdBytes16(rid))],
      programId,
    );
    const esperadas = [
      SENDER_B58,
      escrowStatePda.toBase58(),
      ESCROW_INDEX_PDA.toBase58(),
      SystemProgram.programId.toBase58(),
    ];
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(esperadas);
    expect(new Set(esperadas).size).toBe(4); // dos derivaciones colapsadas no pueden pasar por cuatro
    // Y NINGUNA cuenta de más: un `remainingAccounts` acá cae en SECOND_IX_ACCOUNTS_INVALID del lado
    // del facilitator. El `reference` viaja como remaining del `deposit` y SÓLO de ahí.
    expect(ix.keys).toHaveLength(4);

    const [sender, escrowState, escrowIndex, systemProgram] = ix.keys;
    if (!sender || !escrowState || !escrowIndex || !systemProgram) throw new Error("faltan cuentas");
    expect(sender.isSigner).toBe(true);
    expect(sender.isWritable).toBe(true);
    // `escrow_state` se asserta NO-SIGNER y NO no-writable: en la tx atómica es legítimamente
    // writable por el `deposit`, y los metas de una misma pubkey colapsan a la unión sobre todas las
    // ix. Ver el describe de caracterización de anchor al final de este archivo.
    expect(escrowState.isSigner).toBe(false);
    expect(escrowIndex.isWritable).toBe(true);
    expect(escrowIndex.isSigner).toBe(false);
    expect(systemProgram.isSigner).toBe(false);
    expect(systemProgram.isWritable).toBe(false);
  });

  it("T-347-2 (AC-1): la 2ª ix habla del MISMO escrow que la de posición 0, no de otro", async () => {
    const adapter = await connectedAdapter();
    const rid = "rem-347-binding";
    await adapter.authorizePrincipal(makeQuote(), rid, escrowDeposit());

    const [deposit, register] = businessIx(capturedTx(signSpy));
    if (!deposit || !register) throw new Error("faltan las dos ix de negocio");

    // El binding es lo que impide que las dos ix hablen de escrows distintos, y se mide leyendo los
    // BYTES de las dos, no las variables del adapter.
    // El `remittance_id` está en los 16 bytes que siguen al discriminador, en las DOS.
    const idEnDeposit = Array.from(deposit.data.subarray(8, 24));
    const idEnRegister = Array.from(register.data.subarray(8, 24));
    expect(idEnRegister).toEqual(idEnDeposit);
    expect(idEnRegister).toEqual(Array.from(remittanceIdBytes16(rid)));

    // El `sender` es la cuenta 0 de las dos.
    expect(register.keys[0]?.pubkey.toBase58()).toBe(deposit.keys[0]?.pubkey.toBase58());
    // El `escrow_state`: cuenta 2 del `deposit` (WKH-343) y cuenta 1 del `register_escrow`.
    expect(register.keys[1]?.pubkey.toBase58()).toBe(deposit.keys[2]?.pubkey.toBase58());
  });

  it("T-347-3 (AC-2): la firma del sender cubre la tx de DOS ix de negocio, y es la que viaja en el mensaje canónico", async () => {
    const adapter = await connectedAdapter();
    await adapter.authorizePrincipal(makeQuote(), "rem-347-firma", escrowDeposit());

    const tx = capturedTx(signSpy);
    // La precondición de todo lo demás: efectivamente son DOS. Sin esto el test verificaría una firma
    // sobre una tx de una sola ix y pasaría igual.
    expect(businessIx(tx)).toHaveLength(2);

    const senderSig = tx.signatures.find((s) => s.publicKey.equals(SENDER_KP.publicKey))?.signature;
    if (!senderSig) throw new Error("sender_signature_missing");

    // 🔴 EL INPUT QUE LO PONE EN ROJO: mover el `.add(regIx)` a DESPUÉS de `signTransaction`. Ahí el
    // mensaje se recompila con la ix nueva, los bytes cambian y esta verificación falla.
    expect(
      nacl.sign.detached.verify(
        tx.serializeMessage(),
        new Uint8Array(senderSig),
        SENDER_KP.publicKey.toBytes(),
      ),
    ).toBe(true);

    // Y la firma que el mensaje canónico de SDD 037 lleva adentro es ESA, no otra: si la tx se
    // recompilara después de firmar, la línea `tx:` quedaría hablando de un mensaje que ya no existe.
    const sentBytes = signMessageSpy.mock.calls[0]?.[0] as Uint8Array;
    expect(new TextDecoder().decode(sentBytes)).toContain(
      `tx: ${bs58.encode(new Uint8Array(senderSig))}`,
    );
  });

  it("T-347-4 (AC-5): con el índice LLENO (32 entradas) no sale la 2ª ix, y el depósito igual se firma", async () => {
    mockChain({
      [ESCROW_INDEX_PDA.toBase58()]: encodeEscrowIndex(
        Array.from({ length: 32 }, (_, i) => `ocupado-${i}`),
      ),
    });
    const adapter = await connectedAdapter();
    const res = esperarAutorizacionLista(await adapter.authorizePrincipal(makeQuote(), "rem-347-lleno", escrowDeposit()));

    // UNA sola ix de negocio, y es el `deposit`. Registrar contra un índice lleno devolvería
    // EscrowIndexFull (6005) y, al viajar en la misma tx, REVERTIRÍA EL DEPÓSITO.
    const biz = businessIx(capturedTx(signSpy));
    expect(biz).toHaveLength(1);
    expect(Array.from(biz[0]!.data.subarray(0, 8))).toEqual(DEPOSIT_DISCRIMINATOR);
    // Y lo que NO puede pasar: que un índice lleno impida depositar. La remesa sale igual.
    expect(res.solana?.partialSignedTx).toBeTruthy();
    expect(signSpy).toHaveBeenCalledTimes(1);
  });

  // T-347-5 — los TRES inputs de "no pudimos preguntar". En los tres el desenlace es el MISMO y es
  // DEGRADAR, no abortar: un RPC caído no puede impedirle a alguien mandar plata. Es la asimetría
  // deliberada con `closeEscrow`, donde el mismo `unknown` sí aborta.
  it("T-347-5(a) (AC-6): la sonda LANZA ⇒ una sola ix de negocio y la promesa RESUELVE", async () => {
    mockChain({ [ESCROW_INDEX_PDA.toBase58()]: "throw" });
    const adapter = await connectedAdapter();
    const res = esperarAutorizacionLista(await adapter.authorizePrincipal(makeQuote(), "rem-347-rpc-caido", escrowDeposit()));
    expect(businessIx(capturedTx(signSpy))).toHaveLength(1);
    expect(res.solana?.partialSignedTx).toBeTruthy();
  });

  it("T-347-5(b) (AC-6): la sonda se CUELGA ⇒ vencido el techo de 5 s, una sola ix y la promesa RESUELVE", async () => {
    // Se falsea SÓLO `setTimeout`/`clearTimeout`, y no el juego completo, porque el default de vitest
    // también falsea `nextTick`/`setImmediate` y con eso el camino se cuelga ANTES de llegar a la
    // sonda: medido, `getAccountInfo` no se llegaba a llamar ni una vez y el contador de timers se
    // quedaba en cero. Lo único que este test necesita congelar es el techo de la sonda.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      mockChain({ [ESCROW_INDEX_PDA.toBase58()]: "hang" });
      const adapter = await connectedAdapter();
      const p = adapter.authorizePrincipal(makeQuote(), "rem-347-colgada", escrowDeposit());
      // El techo son 5.000 ms y está declarado como costo. 🚫 Subirlo es PROHIBIDO: son hasta 5 s de
      // la persona mirando la pantalla antes del diálogo de firma.
      //
      // POR QUÉ EL BUCLE Y NO UN `advanceTimersByTimeAsync(5000)` PELADO, medido y no supuesto: entre
      // el arranque de `authorizePrincipal` y el `setTimeout` de la sonda hay cuatro `await import()`,
      // que necesitan turnos REALES del event loop. Avanzando sólo el reloj falso, el adapter no llega
      // nunca a crear el timer (medido: `getAccountInfo` no se llamaba ni una vez y `vi.getTimerCount()`
      // se quedaba en cero) y el test moría por timeout de vitest con la implementación correcta puesta.
      //
      // 🔴 Y POR QUÉ SON DOS FASES Y NO UNA (WKH-347, arreglo de un FLAKE que viajó en el commit de W1).
      // La forma de una sola fase hacía las dos cosas en cada vuelta —un turno real y un avance del
      // reloj— con UN presupuesto compartido de 200 vueltas. Eso ACOPLA el presupuesto de turnos reales
      // al de tiempo falso: mientras los `import()` no terminan, el timer del techo todavía no existe y
      // cada avance del reloj gasta vuelta sin efecto. MEDIDO: en la suite completa (113 archivos en
      // paralelo) los imports tardaban más de 150 vueltas, el bucle se quedaba sin presupuesto con
      // `resuelta === false`, y el `await p` de abajo colgaba hasta el timeout de 30 s de vitest. En
      // aislamiento el mismo test pasaba. Y arrastraba a T-347-6: al abortar por timeout, el `finally`
      // no corre, así que los fake timers quedaban puestos y la llamada abandonada seguía en vuelo.
      //
      // Las dos fases desacoplan los presupuestos: primero turnos REALES hasta que el techo exista, sin
      // tocar el reloj; después el reloj, que ya tiene a quién vencer.
      let resuelta = false;
      void p.then(() => {
        resuelta = true;
      });
      // 🔴 EL PRESUPUESTO DE ESTA FASE SE MIDE EN TIEMPO REAL Y NO EN VUELTAS, y esa distinción es todo
      // el arreglo del flake. Un tope de VUELTAS lo agota la carga de la máquina: los `import()`
      // dinámicos esperan I/O de transformación del módulo, y un `setImmediate` cede el event loop pero
      // NO espera a ese I/O, así que 2000 vueltas pueden pasar volando en milisegundos sin que el módulo
      // termine de resolverse. MEDIDO: con tope de 2000 vueltas la suite completa falló acá en una
      // corrida y pasó en la siguiente sin tocar una línea — o sea que el tope no medía lo que había que
      // esperar. `Date.now()` NO está falseado (sólo `setTimeout`/`clearTimeout`), así que este tope le
      // da a la máquina lenta el tiempo que necesite y sigue cortando si el techo no se arma nunca.
      const t0 = Date.now();
      while (vi.getTimerCount() === 0 && Date.now() - t0 < 10_000) {
        await new Promise((r) => setImmediate(r)); // deja avanzar el event loop REAL (lazy-imports)
      }
      // 🔴 REFUTACIÓN OBLIGATORIA, y es lo que impide que este test sea un falso verde: si el techo NO
      // llegó a armarse, lo que venga después no prueba nada sobre el techo — la promesa podría resolver
      // por cualquier otro camino. Sin este assert, la fase 2 aplaudiría cualquier cosa.
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      // REFUTADO: bajando el presupuesto de ESTA fase a 400 ms de tiempo falso, este test FALLA. O sea
      // que lo que lo pone en verde es el techo venciendo, no otra cosa que resuelva la promesa.
      for (let i = 0; i < 200 && !resuelta; i++) {
        await new Promise((r) => setImmediate(r));
        await vi.advanceTimersByTimeAsync(100);
      }
      // Antes que el `await p`: si no resolvió, este assert lo dice en una línea en vez de colgar 30 s.
      expect(resuelta).toBe(true);
      const res = esperarAutorizacionLista(await p);
      expect(businessIx(capturedTx(signSpy))).toHaveLength(1);
      expect(res.solana?.partialSignedTx).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("T-347-5(c) (AC-6): bytes que NO decodifican como EscrowIndex ⇒ una sola ix y la promesa RESUELVE", async () => {
    // Una cuenta que cayó en esa dirección y no es lo que creemos. Meter una cuenta ESCRIBIBLE que no
    // podemos identificar en una tx del money-path es peor que no mandarla.
    mockChain({ [ESCROW_INDEX_PDA.toBase58()]: Buffer.alloc(64, 7) });
    const adapter = await connectedAdapter();
    const res = esperarAutorizacionLista(await adapter.authorizePrincipal(makeQuote(), "rem-347-basura", escrowDeposit()));
    expect(businessIx(capturedTx(signSpy))).toHaveLength(1);
    expect(res.solana?.partialSignedTx).toBeTruthy();
  });

  it("T-347-7 (CD-14.2): dos depósitos sobre el MISMO adapter sondean el índice DOS veces (prohibido memoizar)", async () => {
    const chainSpy = mockChain({});
    const adapter = await connectedAdapter(); // el adapter es un SINGLETON del container en producción
    await adapter.authorizePrincipal(makeQuote(), "rem-347-memo-1", escrowDeposit());
    await adapter.authorizePrincipal(makeQuote(), "rem-347-memo-2", escrowDeposit());

    // 🔴 EL INPUT QUE LO PONE EN ROJO: guardar el resultado de la sonda en un campo del adapter. La
    // ocupación del índice cambia con cada registro, así que un valor memoizado es un dato viejo
    // decidiendo si se agrega una ix que puede REVERTIR EL DEPÓSITO COMPLETO.
    const sondas = chainSpy.mock.calls.filter((c) =>
      (c[0] as PublicKey).equals(ESCROW_INDEX_PDA),
    ).length;
    expect(sondas).toBe(2);
  });
});

// ── HU-SOL-8 (WKH-211) — signMessage real base58 browser-safe (CD-SDD-3) ────────────────────────────
const POP_MESSAGE =
  "Chaski Proof-of-Possession\naddress: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU\nnetwork: solana:devnet\nnonce: abcdef0123456789abcdef0123456789\nexpires: 4102444800";

describe("SolanaWalletAdapter.signMessage (HU-SOL-8)", () => {
  it("firma vía el bridge y devuelve base58 de 64 bytes; los bytes firmados son TextEncoder(message) (NO Buffer)", async () => {
    const sig = nacl.randomBytes(64); // Uint8Array(64) — lo que devuelve la wallet real
    const signSpy = vi.fn(async (_bytes: Uint8Array) => sig);
    solanaWalletBridge.registerSignMessage(signSpy);
    const adapter = new SolanaWalletAdapter();

    const out = await adapter.signMessage(POP_MESSAGE);
    // Simétrico con verifySolanaPop.signatureBase58: base58 de exactamente 64 bytes.
    expect(bs58.decode(out)).toEqual(sig);
    expect(bs58.decode(out).length).toBe(64);
    // El bridge recibió TextEncoder(message) — browser-safe, NUNCA Buffer node-only (CD-SDD-3).
    const passed = signSpy.mock.calls[0]?.[0];
    if (!passed) throw new Error("signMessage_not_called");
    expect(passed).toBeInstanceOf(Uint8Array);
    expect(passed).toEqual(new TextEncoder().encode(POP_MESSAGE));
  });

  it("normaliza un shape no-Uint8Array de la wallet a Uint8Array (R-2)", async () => {
    const raw = nacl.randomBytes(64);
    const arrayLike = Array.from(raw); // number[] — un adapter que devuelva otro shape
    const signSpy = vi.fn(async (_bytes: Uint8Array) => arrayLike as unknown as Uint8Array);
    solanaWalletBridge.registerSignMessage(signSpy);
    const adapter = new SolanaWalletAdapter();

    const out = await adapter.signMessage(POP_MESSAGE);
    expect(bs58.decode(out)).toEqual(raw); // normalizado correctamente a los 64 bytes
  });

  it("bridge sin handle montado ⇒ throw wallet_sign_not_available (fail-loud)", async () => {
    const adapter = new SolanaWalletAdapter(); // bridge reseteado en afterEach, sin registerSignMessage
    await expect(adapter.signMessage(POP_MESSAGE)).rejects.toThrow("wallet_sign_not_available");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-347-21 · WKH-347/W0.5 — CARACTERIZACIÓN de @coral-xyz/anchor 0.30.1 para `register_escrow`
// ════════════════════════════════════════════════════════════════════════════════════════════════
// Este describe NO prueba producción: prueba la LIBRERÍA, por el MISMO camino que usa producción
// (`new anchor.Program(idl, { connection })` → `.methods.registerEscrow(...)` → `.accounts({...})` →
// `.instruction()`). La `Connection` apunta a 127.0.0.1 y NUNCA se usa: acá no hay llamada de red.
// Mismo criterio y misma forma que el describe de caracterización de `solana-wallet.close.test.ts`.
//
// POR QUÉ VA PRIMERO DE TODA LA HU: el nombre que anchor le da al método —`registerEscrow`, camelCase
// de `register_escrow`— es un DATO de la librería, no una preferencia. Si un bump de anchor lo
// cambiara, hace falta que reviente acá y no en el medio de una transacción a medio armar.
//
// LÍMITE, dicho: esto mide qué BYTES arma el cliente. NO mide qué hace el validador con ellos, ni que
// el facilitator desplegado los acepte. Lo segundo es una precondición que vive en otro repo.
//
// La forma que se fija es exactamente la que el Check 4b de CR-1 acepta (b1..b6): programId, 24 bytes
// de data, discriminador, 4 cuentas exactas, orden posicional y flags.
describe("caracterización de @coral-xyz/anchor 0.30.1: la ix `register_escrow`", () => {
  const SYSTEM_PROGRAM_B58 = "11111111111111111111111111111111";
  const REM_ID = "rem-caracterizacion-register";
  const KP = Keypair.generate();

  function escrowStatePdaOf(id: string): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), KP.publicKey.toBuffer(), Buffer.from(remittanceIdBytes16(id))],
      new PublicKey(ESCROW_PROGRAM_ID),
    )[0];
  }
  const escrowIndexPda = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow-index"), KP.publicKey.toBuffer()],
    new PublicKey(ESCROW_PROGRAM_ID),
  )[0];

  async function buildRegister(): Promise<TransactionInstruction> {
    const connection = new Connection("http://127.0.0.1:8899"); // nunca se usa: no hay llamada de red
    const program = new anchor.Program(escrowIdl as unknown as Idl, { connection } as Provider);
    const methods = program.methods as unknown as {
      registerEscrow: (...args: unknown[]) => {
        accounts: (a: Record<string, PublicKey>) => {
          instruction: () => Promise<TransactionInstruction>;
        };
      };
    };
    // El fail-loud del NOMBRE: si anchor dejara de exponer `registerEscrow`, esto dice qué pasó en vez
    // de reventar con un "no es una función" a diez líneas de distancia.
    expect(typeof methods.registerEscrow).toBe("function");
    return methods
      .registerEscrow(Array.from(remittanceIdBytes16(REM_ID)))
      .accounts({
        sender: KP.publicKey,
        escrowState: escrowStatePdaOf(REM_ID),
        escrowIndex: escrowIndexPda,
      })
      .instruction();
  }

  it("T-347-21: programId, 24 bytes de data y el discriminador de `register_escrow`", async () => {
    const ix = await buildRegister();
    expect(ix.programId.toBase58()).toBe(ESCROW_PROGRAM_ID);
    // 24 = 8 del discriminador + 16 del `remittance_id`. Ni uno más: un arg de más lo mueve.
    expect(ix.data.length).toBe(24);
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(REGISTER_ESCROW_DISCRIMINATOR);
    // Y que los 16 que siguen sean EL id16, no otro: sin esto el discriminador solo no ata nada.
    expect(Array.from(ix.data.subarray(8))).toEqual(Array.from(remittanceIdBytes16(REM_ID)));
  });

  it("T-347-21: exactamente 4 cuentas, en el orden [sender, escrow_state, escrow_index, system_program]", async () => {
    const ix = await buildRegister();
    // Las pubkeys se derivan ACÁ, de forma independiente del builder, y se comparan posicionalmente.
    // Nunca un total: `keys.length === 4` no distingue un orden invertido de uno correcto.
    const esperadas = [
      KP.publicKey.toBase58(),
      escrowStatePdaOf(REM_ID).toBase58(),
      escrowIndexPda.toBase58(),
      SYSTEM_PROGRAM_B58,
    ];
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(esperadas);
    // Que dos derivaciones colapsadas no puedan pasar por cuatro cuentas distintas.
    expect(new Set(esperadas).size).toBe(4);
    // Y NINGUNA cuenta de más: `remainingAccounts` acá cae en SECOND_IX_ACCOUNTS_INVALID del lado del
    // facilitator. El `reference` viaja como remaining del `deposit` y SÓLO de ahí.
    expect(ix.keys).toHaveLength(4);
  });

  it("T-347-21: los flags — sender signer+writable, escrow_index writable, system_program ni una cosa ni la otra", async () => {
    const ix = await buildRegister();
    const [sender, escrowState, escrowIndex, systemProgram] = ix.keys;
    if (!sender || !escrowState || !escrowIndex || !systemProgram) throw new Error("faltan cuentas");

    expect(sender.isSigner).toBe(true);
    expect(sender.isWritable).toBe(true);

    // ⚠️ `escrow_state` se asserta NO-SIGNER y NO se asserta no-writable, y hay que decir por qué:
    // en un mensaje legacy de Solana, signer y writable son propiedades DE LA TRANSACCIÓN, no de la
    // instrucción, y en el round-trip `serialize → Transaction.from` los metas de una misma pubkey
    // COLAPSAN A LA UNIÓN sobre todas las ix. `escrow_state` es legítimamente writable en el
    // `deposit`, así que en la tx atómica SIEMPRE vuelve writable en la 2ª ix. Asertar no-writable
    // acá rechazaría toda transacción legítima.
    expect(escrowState.isSigner).toBe(false);

    expect(escrowIndex.isWritable).toBe(true); // el `init_if_needed` la escribe
    expect(escrowIndex.isSigner).toBe(false); // es una PDA: no puede firmar nunca

    expect(systemProgram.isSigner).toBe(false);
    expect(systemProgram.isWritable).toBe(false);
    expect(systemProgram.pubkey.toBase58()).toBe(SYSTEM_PROGRAM_B58);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-347-6 · WKH-347/AC-9 — la tx de UNA ix de negocio sale BYTE-IDÉNTICA a la de antes de la HU
// ════════════════════════════════════════════════════════════════════════════════════════════════
// CD-10: cuando el índice está lleno (AC-5) no se agrega la 2ª ix, y el camino de UNA sola ix de
// negocio tiene que ejecutar CERO líneas nuevas. Una promesa así no se verifica leyendo el diff: se
// verifica comparando los BYTES que se postean contra un fixture pinneado del árbol PREVIO a la HU.
//
// CÓMO SE GENERÓ EL FIXTURE, que es lo que lo vuelve un pin y no un snapshot que se regenera cuando
// molesta: este mismo `it`, con el mismo setup determinístico, corrido contra el adapter ANTES de
// escribir W1.2 (el árbol de `main`), y el base64 que devolvió se pegó abajo a mano. Si alguien mete
// una línea nueva en el camino de una ix de negocio, este test muere y hay que explicar por qué.
//
// QUÉ HACE DETERMINÍSTICA A UNA TRANSACCIÓN QUE NORMALMENTE NO LO ES, punto por punto:
//   · las llaves salen de semillas fijas, no de `Keypair.generate()`;
//   · el `reference` lo genera el adapter con `Keypair.generate()` ⇒ se espía el ESTÁTICO de la clase
//     (el lazy-import del adapter y el import de este archivo resuelven al MISMO módulo);
//   · el `deadline` es `Date.now()` + la ventana ⇒ reloj congelado con fake timers;
//   · el blockhash está mockeado con una constante;
//   · la firma ed25519 es determinística dada la llave y el mensaje.
//
// LÍMITE, dicho: esto fija los bytes que Chaski POSTEA. No dice nada de qué hace el validador con
// ellos, ni de si el facilitator desplegado los acepta.
describe("T-347-6 (AC-9/CD-10): con el índice LLENO la tx sale byte-idéntica a la previa a WKH-347", () => {
  const seed = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
  const SENDER = seed(1);
  const BENEFICIARY = seed(2);
  const AUTHORITY = seed(3);
  const FACILITATOR = seed(4);
  const MINT = seed(5);
  const REFERENCE = seed(6);
  const BLOCKHASH = seed(7).publicKey.toBase58();
  const REM_ID = "rem-byte-identidad";

  // El fixture. Base64 de la tx partial-firmada, medido contra el árbol previo a W1.2.
  const TX_PRE_HU_B64 =
    "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACPIONNqY9du8/ZeBr0d1YBrSnll34m0+HbROpezmUqlWAoxs5FyXsQB0sJDQVHG2yGeDokOg2CRHeG7NL7Z1gCAgAIDcqTrBcFGHBx1nuDx/8O/oEI6OxFMFdddyaHkzPb2r58iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1xzp9tAq+sB12GutXyYtEYEwdjy27i5qi4aNXeXZ9mE7/dVhQMm17ex0kUrXsrkQ2dZcR1ZbppR0P0oNkV5msH9Cs6ZpqlEaDXudFo6aMEn/gAyTKm/cdDtISlTjknQxOwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE7WKeh1D762A3IZydmsx69uBbZR1+srY3ZUZq/kdCkQbnoc3Smwt4/ROvTFWY/v9O8qlxZuPKby5Pv8zYBQW/GKh1//HrOEUVd6zVr+5AVFZWjdfIngkIY6BVe8evSfF4yXJY9OJInxuz0QKRSODYMLWhOZ2v8QhASOe9jb6fhZAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAC4dwNrBY3TBj07XwcpzMfj1v1vsIXFBrTfZVLWSSyn0Qbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCp6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwDCgAFAsDUAQAKAAkDECcAAAAAAAALCgEHAwQCDAkFBgho8iPGiVLh8rZ861t5bQ0Erap2eqIvXBaQgTl3Dqh9F19Wo1Rmw0x+zMuNipG07jeiXfYPW4/Js5TtSSjGKNHCxurpAziQWZVhKVknOlxj+TY2wUYUrIc30U5hvAAAAAAA39mnaQAAAAA=";

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    solanaWalletBridge.reset();
    vi.restoreAllMocks();
  });

  async function construir(entradasDelIndice: number): Promise<string> {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T05:06:07.000Z"));
    vi.stubEnv("NEXT_PUBLIC_SOLANA_USDC_MINT", MINT.publicKey.toBase58());
    vi.stubEnv("NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY", FACILITATOR.publicKey.toBase58());
    vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1,
    } as Awaited<ReturnType<Connection["getLatestBlockhash"]>>);
    vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("sig-never" as never);
    vi.spyOn(Keypair, "generate").mockReturnValue(REFERENCE);

    // El índice del SENDER de este describe (no el del resto del archivo): otra llave, otra PDA.
    const indexPda = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow-index"), SENDER.publicKey.toBuffer()],
      new PublicKey(ESCROW_PROGRAM_ID),
    )[0];
    const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
    const data = coder.encode("EscrowIndex", {
      sender: SENDER.publicKey,
      version: 1,
      bump: 254,
      entries: Array.from({ length: entradasDelIndice }, (_, i) =>
        Array.from(remittanceIdBytes16(`ocupado-${i}`)),
      ),
    }) as unknown as Buffer;
    vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation((async (k: PublicKey) =>
      k.equals(indexPda)
        ? { data, executable: false, lamports: 1, owner: new PublicKey(ESCROW_PROGRAM_ID), rentEpoch: 0 }
        : null) as never);

    solanaWalletBridge.registerSignTransaction(async (tx: unknown) => {
      (tx as Transaction).partialSign(SENDER);
      return tx as Transaction;
    });
    solanaWalletBridge.registerSignMessage(async (bytes: Uint8Array) =>
      nacl.sign.detached(bytes, SENDER.secretKey),
    );
    solanaWalletBridge.setState({ publicKey: SENDER.publicKey.toBase58(), connected: true });
    const adapter = new SolanaWalletAdapter();
    await adapter.connect();

    const res = esperarAutorizacionLista(await adapter.authorizePrincipal(
      {
        quoteId: "q-byte",
        send: Money.fromMinor(12_345_678, "USDC"),
        receive: Money.fromMinor(4_500_00, "PEN"),
        feeUsd: Money.fromMinor(100_000, "USDC"),
        rate: 3.64,
        etaMinutes: 5,
        expiresAt: "2099-01-01T00:00:00.000Z",
        provenance: "test",
      },
      REM_ID,
      {
        address: "unused-evm-field",
        escrow: {
          beneficiary: BENEFICIARY.publicKey.toBase58(),
          authority: AUTHORITY.publicKey.toBase58(),
        },
      },
    ));
    return res.solana?.partialSignedTx ?? "";
  }

  it("T-347-6: con 32 entradas en el índice, los bytes posteados son EXACTAMENTE los del fixture", async () => {
    const b64 = await construir(32);
    expect(b64).toBe(TX_PRE_HU_B64);
    // Y que efectivamente sea el camino de UNA ix de negocio: si el fixture se hubiera regenerado con
    // dos, esta línea lo dice.
    const posted = Transaction.from(Buffer.from(b64, "base64"));
    expect(businessIx(posted)).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-356 · LA RAMA DE FIRMA POR ENLACE PROFUNDO
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 EL PRIMER CANDADO ES QUE NO EXISTA. Con el colaborador ausente —que es como queda producción al
// cerrar 062— esta rama entera vive adentro de un `if` y no ejecuta NI UNA línea. Eso es CD-1, y lo
// que lo mide no es este describe: son los ~40 `it` de arriba, que siguen verdes SIN QUE SE HAYA
// TOCADO UN SOLO DATO DE EXPECTATIVA.
//
// ⚠️ [NO VERIFICADO] (CD-12) — nada de acá está medido en un teléfono. `localStorage` y `location` son
// objetos de mentira, y la billetera es una función. Que un móvil real vuelva al mismo origen, que
// conserve el disco a través del salto y que devuelva la transacción byte-idéntica son tres
// afirmaciones sobre un runtime que este repo NO ha medido.
//
// ⚠️ CD-15 · LOS 15 MUTANTES DE ESTE BLOQUE SE CORRIERON (2026-08-17, tabla RE-MEDIDA entera en el
// fix-pack 1), no se razonaron: `spawnSync` sin pipes, suite COMPLETA por mutante, aguja contada con
// `== 1`, relectura del disco, restauración verificada byte a byte, y dos mutantes de calibración de
// resultado conocido ANTES de creerle nada a la batería (el que debía morir: exit=1 con 35 rojos —39 tras el FP2, que le agregó `it` al otro archivo—; el
// que debía vivir: exit=0).
//
// | mutante                                                             | exit | `it` rojos |
// |---|---|---|
// | T-062-7     invertir el guard `viaje.direccion !== p.sender`         | 1 | 39 (re-medido en el FP2; eran 35) |
// | T-062-7b    pasarle al motor otro valor en `sender`                  | 1 | 2 |
// | T-062-18(a) comparar sólo la LONGITUD del mensaje devuelto           | 1 | 1 (sólo el CASO B) |
// | T-062-18(b) dejar sólo la PRESENCIA de la firma (sin `nacl.verify`)   | 1 | 2 (el CASO C + citas) |
// | T-062-19    borrar el `isBlockhashValid`                             | 1 | 2 |
// | T-062-20    referenciar `sendRawTransaction` en el método            | 1 | 2 |
// | CD-1        cambiar un campo del envelope del camino INYECTADO       | 1 | 2 |
// | CD-1(b)     agregar `isBlockhashValid` al camino INYECTADO           | 1 | 3 |
// | MNR-CR-7    sacar el `try/catch` de `entornoDeEnlace`                 | 1 | 1 |
// | MNR-CR-2    tragarse el error de `new PublicKey` en getConnectedAddress | 1 | 3 |
// | AR/MNR-1    vaciar `abandonarAutorizacion`                            | 1 | 1 |
// | AR/MNR-3(a) sacar el `withTimeout` de la sonda del blockhash          | 1 | 2 |
// | AR/MNR-3(b) colapsar «no pude preguntar» en «venció»                  | 1 | 1 |
// | AR/MNR-3(c) no limpiar cuando la cadena dijo que el blockhash murió    | 1 | 2 |
// | AR/MNR-3(d) no limpiar en la salida de ÉXITO                          | 1 | 2 |
//
// Que 18(a) mate SÓLO el caso B y 18(b) SÓLO el caso C es lo que prueba que los dos chequeos —bytes del
// mensaje y verificación de la firma— hacen trabajos distintos y ninguno cubre al otro.
//
// ⚠️ VARIOS DE ESTOS MUTANTES AGREGAN O QUITAN LÍNEAS, y eso pone rojo de refilón al candado de citas
// ancladas (`citas-ancladas.test.ts`), porque desplaza destinos. Está contado arriba y va dicho: si no
// se dice, alguien lee «2 rojos» y cree que dos `it` de comportamiento lo cazaron.
describe("SolanaWalletAdapter.authorizePrincipal — rama de enlace profundo (WKH-356)", () => {
  const CLAVE_PREPARADO = "chaski.billetera.preparado.v1";
  const CLAVE_VIAJE = "chaski.billetera.viaje.v1";
  const HREF = "https://chaski.test/enviar?rem=rem-1";
  const REM = "rem-1";

  let disco: Map<string, string>;
  let signSpy: ReturnType<typeof vi.fn>;
  let blockhashValidoSpy: ReturnType<typeof vi.fn>;

  // ── WKH-357 · la cuenta de nonce de estos tests ────────────────────────────────────────────────
  /** El valor guardado en la cuenta de nonce. ⚠️ DISTINTO de `FIXED_BLOCKHASH` A PROPÓSITO: si fueran
   *  iguales, ningún test podría distinguir "la tx usa el valor del nonce" de "la tx usa el blockhash
   *  de la red", que es justo lo que AC-1 afirma. */
  const VALOR_DEL_NONCE = Keypair.generate().publicKey.toBase58();
  /** La dirección derivada del sender. Determinística, así que se calcula una vez. */
  let NONCE_PK_B58: string;
  beforeAll(async () => {
    NONCE_PK_B58 = (await direccionDelNonce(SENDER_KP.publicKey)).toBase58();
  });

  /** Los 80 bytes de una cuenta de nonce inicializada con `valor` adentro. Mismo layout que el
   *  fixture de `nonce-duradero.test.ts`: version u32 + state u32 + authority 32 + nonce 32 + fee 8. */
  function bytesDeCuentaDeNonce(valor: string): Buffer {
    return Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      Buffer.from([1, 0, 0, 0]),
      SENDER_KP.publicKey.toBuffer(),
      new PublicKey(valor).toBuffer(),
      Buffer.alloc(8),
    ]) as unknown as Buffer;
  }

  /**
   * Qué contesta la cadena para la CUENTA DE NONCE, una respuesta por LECTURA.
   *
   * ⚠️ POR QUÉ HACE FALTA UNA LISTA Y NO UN VALOR: en la invocación de la VUELTA hay DOS lecturas de la
   * cuenta —la de antes de armar la tx (que se descarta) y la de la comparación— y los desenlaces que
   * hay que medir se distinguen justamente por cuál de las dos falla. Con un valor único no se puede
   * escribir "la cuenta estaba y dejó de estar", que es el caso en el que YA HAY DOS FIRMAS DADAS.
   * La última respuesta de la lista se repite si hay más lecturas que entradas.
   *
   * Cualquier pubkey que no sea la del nonce contesta `null`, igual que `mockChain({})`: eso es lo que
   * la sonda del índice del escrow necesita (ausente ⇒ registrable).
   */
  function mockNonce(respuestas: Reply[]) {
    let i = 0;
    return vi
      .spyOn(Connection.prototype, "getAccountInfo")
      .mockImplementation((async (k: PublicKey) => {
        if (k.toBase58() !== NONCE_PK_B58) return null;
        const r = respuestas[Math.min(i, respuestas.length - 1)];
        i += 1;
        if (r === "throw") throw new Error("rpc_down");
        if (r === "hang") return new Promise(() => {});
        return r
          ? {
              data: r,
              executable: false,
              lamports: 1_447_680,
              owner: SystemProgram.programId,
              rentEpoch: 0,
            }
          : null;
      }) as never);
  }

  /** `localStorage` y `location` de mentira. El entorno de estos tests es Node: no hay ninguno. */
  function montarEntorno() {
    disco = new Map<string, string>();
    const storage = {
      getItem: (k: string) => disco.get(k) ?? null,
      setItem: (k: string, v: string) => void disco.set(k, v),
      removeItem: (k: string) => void disco.delete(k),
      clear: () => disco.clear(),
      key: () => null,
      length: 0,
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("location", { href: HREF, origin: "https://chaski.test" });
    return { leer: (k: string) => disco.get(k) ?? null };
  }

  /** Motor programable que además REGISTRA el `PedidoDeFirma` que recibió. */
  class MotorProgramable implements FirmaPorEnlace {
    public pedidos: PedidoDeFirma[] = [];
    public responder: (p: PedidoDeFirma) => DesenlaceDeFirma = () => ({
      tipo: "salto",
      irA: "https://phantom.app/ul/v1/signTransaction?x=1",
      esperando: "firma-tx",
    });
    resolver(p: PedidoDeFirma): DesenlaceDeFirma {
      this.pedidos.push(p);
      return this.responder(p);
    }
  }

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_USDC_MINT", MINT_B58);
    vi.stubEnv("NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY", FACILITATOR_B58);
    vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
      blockhash: FIXED_BLOCKHASH,
      lastValidBlockHeight: 1,
    } as Awaited<ReturnType<Connection["getLatestBlockhash"]>>);
    vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("sig-never" as never);
    vi.spyOn(Connection.prototype, "sendTransaction").mockResolvedValue("sig-never" as never);
    // 🔴 WKH-357 — LA CUENTA DE NONCE TIENE QUE ESTAR, o `authorizePrincipal` corta con
    // `deeplink_nonce_ausente` antes de armar la tx y ningún `it` de este describe llega a su propio
    // guard. `mockChain` mapea POR PDA, así que se declara la dirección derivada del sender.
    mockChain({ [NONCE_PK_B58]: bytesDeCuentaDeNonce(VALOR_DEL_NONCE) });
    // 🔴 WKH-357 — SIN ESTE MOCK, 13 `it` DE ESTE DESCRIBE PEGABAN A DEVNET DE VERDAD. No es una
    // hipótesis: `authorizePrincipal` pasó a consultar el saldo del remitente antes de armar la tx y
    // `probeSenderSolBalance` arma su PROPIA `Connection` contra el RPC público. Medido el 2026-08-17:
    // `getBalance` de una pubkey nueva contra `api.devnet.solana.com` devuelve `0`, o sea
    // `{status:"known", lamports:0}`, que está bajo el umbral y cortaba los 13 con
    // `deeplink_saldo_insuficiente` antes de que midieran lo suyo. Un test que depende de que la red
    // conteste 0 no mide lo que dice medir, y encima viola la regla de no pegar a devnet en la suite.
    // El valor va MUY por encima del umbral para que ningún `it` de acá dependa del número exacto; el
    // `it` que mide el guard de saldo lo pisa con el suyo.
    vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(1_000_000_000 as never);
    // La sonda vieja. Se sigue espiando A PROPÓSITO aunque el código ya no la llame: T-19 asserta que
    // recibe CERO llamadas, y sin el spy no habría con qué contarlas.
    blockhashValidoSpy = vi.fn(async () => ({ context: { slot: 1 }, value: true }));
    vi.spyOn(Connection.prototype, "isBlockhashValid").mockImplementation(
      blockhashValidoSpy as never,
    );
    signSpy = vi.fn(async (tx: unknown) => {
      (tx as Transaction).partialSign(SENDER_KP);
      return tx;
    });
    solanaWalletBridge.registerSignTransaction(signSpy);
    solanaWalletBridge.registerSignMessage(
      vi.fn(async (bytes: Uint8Array) => nacl.sign.detached(bytes, SENDER_KP.secretKey)),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const escrowDeposit = () => ({
    address: "unused-evm-field",
    escrow: { beneficiary: BENEFICIARY_B58, authority: AUTHORITY_B58 },
  });

  async function adaptadorConMotor(motor: FirmaPorEnlace): Promise<SolanaWalletAdapter> {
    solanaWalletBridge.setState({ publicKey: SENDER_B58, connected: true });
    // ⚠️ EL 3er PARÁMETRO VA AL FINAL y el 2º se omite: es lo que hace que `container.ts` —que pasa UN
    // solo argumento— y los tests que pasan `confirmTimeoutMs` posicionalmente sigan compilando.
    const adapter = new SolanaWalletAdapter(undefined, undefined, motor);
    await adapter.connect();
    return adapter;
  }

  /** El registro del intento, escrito DIRECTO en el disco.
   *
   * ⚠️ HACE FALTA PORQUE `MotorProgramable` ES UN DOBLE Y NO ESCRIBE NADA: el que escribe el ancla es el
   * motor real, y estos tests reemplazan el motor justamente para poder fabricar el desenlace. Lo que se
   * siembra acá NO es el ancla contra la que el adaptador compara —esa viaja en el desenlace
   * (`mensajeBase64`)— sino sólo el estado de disco cuya limpieza (o su ausencia) se está midiendo. */
  function sembrarPreparado() {
    disco.set(
      CLAVE_PREPARADO,
      JSON.stringify({
        remittanceId: REM,
        sender: SENDER_B58,
        beneficiary: BENEFICIARY_B58,
        authority: AUTHORITY_B58,
        mensajeBase64: "MSG",
        referenceBase58: "REF",
        desde: Date.now(),
      }),
    );
  }

  /** Un viaje ya conectado, escrito DIRECTO en el disco de mentira. */
  function sembrarViaje(direccion: string) {
    const par = nacl.box.keyPair();
    const billetera = nacl.box.keyPair();
    disco.set(
      CLAVE_VIAJE,
      JSON.stringify({
        billetera: "phantom",
        secreta: bs58.encode(par.secretKey),
        publica: bs58.encode(par.publicKey),
        claveBilletera: bs58.encode(billetera.publicKey),
        session: "s",
        direccion,
        paso: "firmar-tx",
        remittanceId: REM,
        pasosConsumidos: ["conectar"],
        desde: Date.now(),
      }),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // T-062-7 (§4.5 / T12 / CD-11) — el viaje sólo puede COINCIDIR con el sender, nunca sustituirlo
  // ──────────────────────────────────────────────────────────────────────────────────────────────
  //
  // 🔴 POR QUÉ ESTE GUARD NO ES REDUNDANTE. Hay tres mecanismos contra la sustitución de depositante y
  // los otros dos tienen agujeros declarados: el guard S3.5 del settle **se apaga con el ledger** (la
  // propia route lo dice), y **no cubre el caso de dos `prepare()`** porque
  // `listPreparedDepositAddresses` devuelve todas las direcciones y hace `includes(...)`. En un
  // deployment sin ledger, ESTE es el único.
  //
  // Se corre contra el motor REAL, no contra un doble: lo que hace falta probar es el CABLEADO.
  describe("T-062-7: `viaje.direccion` distinta del sender ⇒ corte fail-closed", () => {
    // MUTANTE QUE MATA (MEDIDO: exit=1, 39 `it` rojos en dos archivos —eran 35 en el FP1—): invertir la comparación
    // `viaje.direccion !== p.sender` del motor ⇒ el depósito se arma con el `sender` del adaptador y una
    // dirección de viaje AJENA, y el caso positivo de abajo NO lo nota. Por eso hacen falta los dos.
    it("una dirección de viaje ajena corta con deeplink_sender_mismatch", async () => {
      montarEntorno();
      const adapter = await adaptadorConMotor(new FirmaPorEnlaceReal());
      sembrarViaje(Keypair.generate().publicKey.toBase58()); // ← otra cuenta
      await expect(
        adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit()),
      ).rejects.toThrow("deeplink_sender_mismatch");
    });

    it("CASO POSITIVO: con la misma dirección el viaje sigue y sale un salto", async () => {
      montarEntorno();
      const adapter = await adaptadorConMotor(new FirmaPorEnlaceReal());
      sembrarViaje(SENDER_B58);
      const r = await adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit());
      expect(r.estado).toBe("hay-que-salir");
      expect(r.estado === "hay-que-salir" && r.esperando).toBe("firma-tx");
      expect(r.estado === "hay-que-salir" && new URL(r.irA).host).toBe("phantom.app");
    });

    // El `sender` que viaja al motor sale de `this.getAddress()` y está CANONICALIZADO: nunca del canal
    // del enlace.
    // 🔴 ACÁ HABÍA UN «MUTANTE QUE MATA» IMPOSIBLE, y el CR lo midió: decía «pasarle `viaje.direccion` en
    // vez de `sender`», y el adaptador NO TIENE `viaje.direccion` (el viaje lo lee el motor). Peor: el
    // fixture siembra el viaje con la MISMA dirección del sender, así que cualquier mutante que las
    // confunda devuelve lo mismo y este `it` no lo notaría nunca.
    // MUTANTE QUE MATA DE VERDAD (MEDIDO: exit=1, 2 `it` rojos, éste y el caso positivo): pasarle al
    // motor otro valor en `sender` (`deposit.escrow.beneficiary`) ⇒ el motor compara contra algo que no
    // es la cuenta del adaptador.
    it("el `sender` del pedido es el del adaptador, canonicalizado", async () => {
      montarEntorno();
      const motor = new MotorProgramable();
      const adapter = await adaptadorConMotor(motor);
      sembrarViaje(SENDER_B58);
      await adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit());
      expect(motor.pedidos[0]?.sender).toBe(new PublicKey(SENDER_B58).toBase58());
      expect(motor.pedidos[0]?.remittanceId, "se le pasó otra cosa que el 2º argumento (T2)").toBe(REM);
      expect(motor.pedidos[0]?.beneficiary).toBe(BENEFICIARY_B58);
      expect(motor.pedidos[0]?.authority).toBe(AUTHORITY_B58);
      expect(motor.pedidos[0]?.hrefActual, "no se pasó el href COMPLETO (T9)").toBe(HREF);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // MNR-CR-7 / MNR-CR-2 — el entorno hostil, y la limpieza que NO tiene que estar
  // ──────────────────────────────────────────────────────────────────────────────────────────────
  describe("el entorno del navegador, cuando no colabora", () => {
    // 🔴 LO QUE NO ESTABA ENVUELTO ERA LA LECTURA DE LA PROPIEDAD. Todo el resto del código de enlace
    // envuelve las OPERACIONES del disco, pero en el modo privado de algunos navegadores el que tira es
    // el getter, antes de que ninguna costura exista. Sin el `try`, `authorizePrincipal` subía un error
    // FUERA del vocabulario `deeplink_*` y la pantalla no tenía ninguna causa que traducir.
    // MUTANTE QUE MATA (MEDIDO: exit=1, 1 `it` rojo, éste): que el `catch` de `entornoDeEnlace` re-tire
    // en vez de devolver `null` ⇒ este `it` recibe "denegado por política" en vez de
    // `deeplink_sin_memoria`.
    // ⚠️ `[NO VERIFICADO]` (CD-12): que un navegador real lance en ese getter no está medido acá.
    it("un `localStorage` cuyo getter LANZA ⇒ deeplink_sin_memoria (no un error de otro vocabulario)", async () => {
      montarEntorno();
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() {
          throw new Error("denegado por política de almacenamiento");
        },
      });
      const adapter = await adaptadorConMotor(new FirmaPorEnlaceReal());
      await expect(adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit())).rejects.toThrow(
        "deeplink_sin_memoria",
      );
    });

    it("sin `location` ⇒ deeplink_sin_memoria: sin URL no se puede volver del salto", async () => {
      montarEntorno();
      vi.stubGlobal("location", undefined);
      const adapter = await adaptadorConMotor(new FirmaPorEnlaceReal());
      await expect(adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit())).rejects.toThrow(
        "deeplink_sin_memoria",
      );
    });

    // 🔴 EL `catch` DE `canonicalizeAddress` NO ERA "UN SITIO SIN TEST": ERA INALCANZABLE (MNR-CR-2, con
    // una divergencia medida y reportada). Una dirección que no parsea NO llega a la rama de enlace, y
    // no por uno sino por DOS guards que corren antes: `getConnectedAddress` hace `new
    // PublicKey(publicKey)` y devuelve `null` si tira ((`PublicKey`, `solana-wallet.ts:256`)) ⇒
    // `wallet_not_connected` ((`wallet_not_connected`, `solana-wallet.ts:561`)); y si aun así pasara,
    // `new PublicKey(sender)` ((`PublicKey`, `solana-wallet.ts:573`)) tira ~200 líneas antes de la
    // rama. ⚠️ Las tres citas eran correctas pero DESNUDAS (`:256-259`, `:561`, `:573` sin el archivo),
    // o sea que se leían como si apuntaran a ESTE test y el candado no las miraba. Ancladas en el
    // fix-pack del AR: apuntan a producción y ahora `citas-ancladas.test.ts` las verifica. Los dos con
    // exactamente los mismos inputs que `canonicalizeAddress`, que ES esa misma llamada adentro.
    // Por eso la rama se BORRÓ en vez de recibir un test: un test sobre una rama inalcanzable congela una
    // fantasía, y este repo ya lo decidió así (`sesion.ts`, docblock de `LecturaDelViaje`).
    // MUTANTE QUE MATA (MEDIDO: exit=1, 3 `it` rojos, y los otros dos son de HU-SOL-4, o sea que este
    // guard lo sostiene más de un `it`): que `getConnectedAddress` se trague el error de
    // `new PublicKey(...)` ⇒ este `it` deja de recibir `wallet_not_connected` y el motor empieza a
    // recibir pedidos con basura, que es justo lo que los dos guards impiden.
    it("una dirección que no parsea muere ANTES de la rama de enlace: el motor no recibe NADA", async () => {
      montarEntorno();
      const motor = new MotorProgramable();
      // Sin `connect()`: así `getAddress()` no tiene cache y le pregunta al bridge en vivo.
      const adapter = new SolanaWalletAdapter(undefined, undefined, motor);
      solanaWalletBridge.setState({ publicKey: "no-es-base58-válido-###", connected: true });
      sembrarViaje(SENDER_B58);
      disco.set(CLAVE_PREPARADO, JSON.stringify({ basura: true }));
      await expect(adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit())).rejects.toThrow(
        "wallet_not_connected",
      );
      expect(motor.pedidos, "la rama de enlace corrió con una dirección que no parsea").toEqual([]);
      expect(
        disco.has(CLAVE_VIAJE),
        "algo borró el viaje de la persona por una dirección que NUESTRO bridge no supo parsear",
      ).toBe(true);
      expect(disco.has(CLAVE_PREPARADO)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // AR/MNR-1 — `abandonarAutorizacion`: el requisito explícito que 061 le dejó a esta HU
  // ──────────────────────────────────────────────────────────────────────────────────────────────
  describe("abandonarAutorizacion: cuando el envío murió, el rastro se borra", () => {
    // MUTANTE QUE MATA (MEDIDO: exit=1, 1 `it` rojo, éste): vaciar el cuerpo del método. Y el de abajo
    // mide la otra mitad, la que protege CD-1: sin colaborador, el método no toca el disco NI UNA VEZ.
    it("con colaborador de enlace, borra el viaje y el registro", async () => {
      montarEntorno();
      const adapter = await adaptadorConMotor(new FirmaPorEnlaceReal());
      sembrarViaje(SENDER_B58);
      disco.set(CLAVE_PREPARADO, "{}");
      adapter.abandonarAutorizacion();
      expect(
        disco.has(CLAVE_VIAJE),
        "la x25519 privada y la sesión sobrevivieron a la remesa que las produjo (hasta 20 min)",
      ).toBe(false);
      expect(disco.has(CLAVE_PREPARADO)).toBe(false);
    });

    it("SIN colaborador (producción al cerrar 062) no toca el disco: no hay nada que limpiar", async () => {
      montarEntorno();
      solanaWalletBridge.setState({ publicKey: SENDER_B58, connected: true });
      const adapter = new SolanaWalletAdapter(); // el camino de la billetera inyectada
      await adapter.connect();
      sembrarViaje(SENDER_B58);
      disco.set(CLAVE_PREPARADO, "{}");
      adapter.abandonarAutorizacion();
      expect(disco.has(CLAVE_VIAJE), "el camino inyectado borró algo que no escribió (CD-1)").toBe(
        true,
      );
      expect(disco.has(CLAVE_PREPARADO)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // T-062-18 (DT-10) — bytes contra bytes
  // ──────────────────────────────────────────────────────────────────────────────────────────────
  describe("T-062-18: lo que volvió tiene que ser lo que se pidió firmar", () => {
    /** Corre la invocación A (salto) y devuelve el pedido capturado, para poder fabricar la vuelta de
     *  la invocación B con la MISMA transacción que el adaptador armó.
     *
     *  ⚠️ ACÁ SE SEMBRABA EL `Preparado` A MANO, y el CR lo marcó como hueco de método: sembrarlo
     *  hacía que nadie midiera la relación entre lo que el motor persiste y lo que el adaptador
     *  compara en la invocación siguiente — que es exactamente por dónde entró AR/BLQ-MED-1. Ya no
     *  hace falta: el ancla la devuelve el desenlace (`mensajeBase64`), así que el adaptador compara
     *  contra el MISMO registro que el motor validó y no hay dos lecturas que puedan divergir. La
     *  relación motor↔ancla la mide `firma-por-enlace.test.ts` con el motor real y cuatro
     *  invocaciones. */
    async function primeraVuelta(motor: MotorProgramable): Promise<PedidoDeFirma> {
      const adapter = await adaptadorConMotor(motor);
      sembrarViaje(SENDER_B58);
      await adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit());
      const p = motor.pedidos[0];
      if (!p) throw new Error("el motor no recibió ningún pedido");
      return p;
    }

    function serializar(tx: Transaction): string {
      return bs58.encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    }

    it("CASO POSITIVO: la MISMA tx firmada por el sender ⇒ `listo`, con la reference PERSISTIDA", async () => {
      montarEntorno();
      const motor = new MotorProgramable();
      const p = await primeraVuelta(motor);
      const tx = Transaction.from(bs58.decode(p.transaccionBase58));
      tx.partialSign(SENDER_KP);
      motor.responder = () => ({
        tipo: "completo",
        transaccionFirmadaBase58: serializar(tx),
        firmaDePatrocinio: "FIRMA-POP-DEL-VIAJE",
        referenceBase58: p.referenceBase58,
        // El ANCLA, por el mismo camino que la reference (MNR-CR-6): es contra esto que el adaptador
        // compara los bytes devueltos, sin volver a leer el disco con otro reloj.
        mensajeBase64: p.mensajeBase64,
      });
      const adapter = await adaptadorConMotor(motor);
      const r = await adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit());
      expect(r.estado).toBe("listo");
      if (r.estado !== "listo") return;
      expect(r.solana?.vm).toBe("solana");
      expect(r.solana?.popSignature).toBe("FIRMA-POP-DEL-VIAJE");
      // 🔴 LA REFERENCE ES LA DEL INTENTO ORIGINAL, no la del `Keypair.generate()` de esta invocación
      // (que se descartó junto con la tx que la llevaba). Sin esto el envelope declararía una
      // reference que NO está adentro de su propia transacción y la traza del depósito se rompe.
      expect(r.solana?.reference).toBe(p.referenceBase58);
      expect(r.tx).toBe(r.solana?.partialSignedTx);
      // Y los bytes que salen son los que la billetera devolvió, no los de la tx nueva.
      expect(r.tx).toBe(Buffer.from(bs58.decode(serializar(tx))).toString("base64"));
    });

    // MUTANTE QUE MATA (MEDIDO, y por separado): comparar sólo la LONGITUD del mensaje ⇒ exit=1 con 1
    // `it` rojo, el CASO B. Dejar sólo la PRESENCIA de la firma (sin `nacl.verify`) ⇒ exit=1 con el CASO
    // C. Ninguno de los dos mata al otro: por eso se comparan los BYTES DEL MENSAJE **y** se VERIFICA la
    // firma.
    it("CASO A: una ix agregada ⇒ deeplink_tx_alterada", async () => {
      montarEntorno();
      const motor = new MotorProgramable();
      const p = await primeraVuelta(motor);
      const tx = Transaction.from(bs58.decode(p.transaccionBase58));
      tx.add(
        new TransactionInstruction({
          programId: Keypair.generate().publicKey,
          keys: [],
          data: Buffer.from([9, 9]),
        }),
      );
      tx.partialSign(SENDER_KP);
      motor.responder = () => ({
        tipo: "completo",
        transaccionFirmadaBase58: serializar(tx),
        firmaDePatrocinio: "F",
        referenceBase58: p.referenceBase58,
        // El ANCLA, por el mismo camino que la reference (MNR-CR-6): es contra esto que el adaptador
        // compara los bytes devueltos, sin volver a leer el disco con otro reloj.
        mensajeBase64: p.mensajeBase64,
      });
      const adapter = await adaptadorConMotor(motor);
      await expect(
        adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit()),
      ).rejects.toThrow("deeplink_tx_alterada");
    });

    it("CASO B: otro `beneficiary` adentro de la ix ⇒ deeplink_tx_alterada", async () => {
      montarEntorno();
      const motor = new MotorProgramable();
      const p = await primeraVuelta(motor);
      const tx = Transaction.from(bs58.decode(p.transaccionBase58));
      // El `beneficiary` viaja en los ARGS de la ix `deposit` (posición 0 de las de negocio): se
      // pisan 32 bytes de su data. Los bytes del mensaje cambian ⇒ el guard tiene que verlo.
      const deposito = businessIx(tx)[0];
      if (!deposito) throw new Error("sin ix de deposit");
      new PublicKey(Keypair.generate().publicKey.toBase58()).toBuffer().copy(deposito.data, 24);
      tx.partialSign(SENDER_KP);
      motor.responder = () => ({
        tipo: "completo",
        transaccionFirmadaBase58: serializar(tx),
        firmaDePatrocinio: "F",
        referenceBase58: p.referenceBase58,
        // El ANCLA, por el mismo camino que la reference (MNR-CR-6): es contra esto que el adaptador
        // compara los bytes devueltos, sin volver a leer el disco con otro reloj.
        mensajeBase64: p.mensajeBase64,
      });
      const adapter = await adaptadorConMotor(motor);
      await expect(
        adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit()),
      ).rejects.toThrow("deeplink_tx_alterada");
    });

    // 🔴 EL CASO QUE UNA COMPARACIÓN DE BYTES SOLA NO VE. Las firmas NO son parte del mensaje, así que
    // la MISMA transacción con la firma en cero pasa el `serializeMessage()` byte a byte.
    // MUTANTE QUE MATA (MEDIDO: exit=1, este `it` + el candado de citas por el desplazamiento): dejar
    // sólo `if (!firmaDevuelta)` ⇒ este `it` se pone rojo y los otros dos siguen verdes, que es justo lo
    // que lo hace necesario.
    it("CASO C: los MISMOS bytes con una firma que no verifica ⇒ deeplink_tx_alterada", async () => {
      montarEntorno();
      const motor = new MotorProgramable();
      const p = await primeraVuelta(motor);
      const tx = Transaction.from(bs58.decode(p.transaccionBase58));
      const otro = Keypair.generate();
      // Firma de OTRA clave, colocada en la posición del sender: hay firma, tiene 64 bytes, y no
      // verifica.
      const fake = nacl.sign.detached(new Uint8Array(tx.serializeMessage()), otro.secretKey);
      tx.addSignature(SENDER_KP.publicKey, Buffer.from(fake));
      motor.responder = () => ({
        tipo: "completo",
        transaccionFirmadaBase58: serializar(tx),
        firmaDePatrocinio: "F",
        referenceBase58: p.referenceBase58,
        // El ANCLA, por el mismo camino que la reference (MNR-CR-6): es contra esto que el adaptador
        // compara los bytes devueltos, sin volver a leer el disco con otro reloj.
        mensajeBase64: p.mensajeBase64,
      });
      const adapter = await adaptadorConMotor(motor);
      await expect(
        adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit()),
      ).rejects.toThrow("deeplink_tx_alterada");
    });

    // ──────────────────────────────────────────────────────────────────────────────────────────────
    // T-062-19 (DT-9) — el blockhash
    // ──────────────────────────────────────────────────────────────────────────────────────────────
    //
    // 🔴 SIN ESTE CHEQUEO EL DESENLACE ES EL PEOR QUE ESTE REPO TIENE CATALOGADO:
    //   blockhash vencido → `solana_settle_broadcast_failed` → NO está en
    //   SETTLE_REASONS_BEFORE_BROADCAST → `failAfterBroadcast` pregunta a la cadena → la cuenta no
    //   existe → `probeDeposit` contesta "unknown" POR DISEÑO → PRINCIPAL_STATE_UNKNOWN → la pantalla
    //   dice "no sabemos si te cobramos" sobre algo que SÍ sabemos.
    // MUTANTE QUE MATA (MEDIDO: exit=1, 2 `it` rojos, éste y el de la limpieza): neutralizar el
    // `if (!vigente.value)` ⇒ este `it` deja de tirar, `execute()` llega al settle y el desenlace pasa a
    // ser "no sabemos si te cobramos".
    it("T-062-19: con el blockhash vencido corta con deeplink_blockhash_expired y NO devuelve envelope", async () => {
      montarEntorno();
      const motor = new MotorProgramable();
      const p = await primeraVuelta(motor);
      const tx = Transaction.from(bs58.decode(p.transaccionBase58));
      tx.partialSign(SENDER_KP);
      motor.responder = () => ({
        tipo: "completo",
        transaccionFirmadaBase58: serializar(tx),
        firmaDePatrocinio: "F",
        referenceBase58: p.referenceBase58,
        // El ANCLA, por el mismo camino que la reference (MNR-CR-6): es contra esto que el adaptador
        // compara los bytes devueltos, sin volver a leer el disco con otro reloj.
        mensajeBase64: p.mensajeBase64,
      });
      // 🔴 WKH-357 — ACÁ ESTE `it` PONÍA `isBlockhashValid` EN `false`. Ya no hay tal sonda: el valor
      // que la tx lleva es el de la cuenta de nonce, y `isBlockhashValid` contestaría `false` para él
      // SIEMPRE (no está entre los ~150 recientes), o sea que el guard viejo mataba el camino entero y
      // encima borraba las dos firmas. Lo que mata la transacción ahora es que el nonce AVANZÓ: la
      // cuenta guarda un valor distinto del que la tx trae, porque otra tx lo consumió.
      mockNonce([bytesDeCuentaDeNonce(Keypair.generate().publicKey.toBase58())]);
      const adapter = await adaptadorConMotor(motor);
      await expect(
        adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit()),
      ).rejects.toThrow("deeplink_blockhash_expired");
      // 🔴 Y ES POR ESO QUE `execute()` NUNCA LLEGA AL SETTLE: `authorizePrincipal` TIRA, y su único
      // llamador de producción (`confirm-and-send.ts:484`) NO tiene `try/catch` alrededor. No hay
      // ninguna transacción viajando, así que "no se movió nada" es un hecho y no una incógnita.
      expect(Connection.prototype.sendRawTransaction).not.toHaveBeenCalled();
      expect(Connection.prototype.sendTransaction).not.toHaveBeenCalled();
      // ★ T-19 (AC-7) — LA SONDA VIEJA RECIBE CERO LLAMADAS. Es un contador sobre el spy, o sea
      // comportamiento en runtime y no una búsqueda de texto: si alguien reintrodujera
      // `isBlockhashValid` en este camino, el número dejaría de ser 0 aunque el código "se lea bien".
      expect(blockhashValidoSpy).toHaveBeenCalledTimes(0);
    });

    // ── ★ T-18 (AC-7) — la cuenta de nonce NO ESTÁ en la vuelta ─────────────────────────────────
    // El otro camino a "esta tx no entra nunca más". Comparte causa y limpieza con "el nonce avanzó",
    // y por eso se miden los dos: son dos hechos distintos con el mismo desenlace, y un `it` solo no
    // distingue si el código cubre los dos o sólo el que se probó.
    //
    // ⚠️ La lista de respuestas es `[bytes, null]` a propósito: la lectura de IDA encuentra la cuenta
    // (si no, cortaría con `deeplink_nonce_ausente` sin firmar nada, que es otro caso) y la de la
    // VUELTA la encuentra ausente. Ése es el escenario en el que YA HAY DOS FIRMAS dadas.
    it("★ T-18: la cuenta de nonce ausente EN LA VUELTA ⇒ deeplink_blockhash_expired y el disco SÍ se limpia", async () => {
      montarEntorno();
      const motor = new MotorProgramable();
      const p = await primeraVuelta(motor);
      const tx = Transaction.from(bs58.decode(p.transaccionBase58));
      tx.partialSign(SENDER_KP);
      motor.responder = () => ({
        tipo: "completo",
        transaccionFirmadaBase58: serializar(tx),
        firmaDePatrocinio: "F",
        referenceBase58: p.referenceBase58,
        mensajeBase64: p.mensajeBase64,
      });
      sembrarPreparado();
      mockNonce([bytesDeCuentaDeNonce(VALOR_DEL_NONCE), null]);
      const adapter = await adaptadorConMotor(motor);
      await expect(adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit())).rejects.toThrow(
        "deeplink_blockhash_expired",
      );
      expect(disco.has(CLAVE_VIAJE)).toBe(false);
      expect(disco.has(CLAVE_PREPARADO)).toBe(false);
    });

    // ── ★ T-18 (AC-7) — el desenlace VIGENTE, dicho explícitamente ──────────────────────────────
    it("★ T-18: con el valor del nonce INTACTO el flujo sigue y NO se limpia por vigencia", async () => {
      montarEntorno();
      const motor = new MotorProgramable();
      const p = await primeraVuelta(motor);
      const tx = Transaction.from(bs58.decode(p.transaccionBase58));
      tx.partialSign(SENDER_KP);
      motor.responder = () => ({
        tipo: "completo",
        transaccionFirmadaBase58: serializar(tx),
        firmaDePatrocinio: "F",
        referenceBase58: p.referenceBase58,
        mensajeBase64: p.mensajeBase64,
      });
      const adapter = await adaptadorConMotor(motor);
      const r = esperarAutorizacionLista(
        await adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit()),
      );
      // Y la tx que viaja lleva el valor del NONCE, no el blockhash de la red. Los dos mocks tienen
      // valores DISTINTOS, así que esta comparación distingue de verdad (AC-1).
      const viajando = Transaction.from(Buffer.from(String(r.solana?.partialSignedTx), "base64"));
      expect(viajando.recentBlockhash).toBe(VALOR_DEL_NONCE);
      expect(viajando.recentBlockhash).not.toBe(FIXED_BLOCKHASH);
      expect(blockhashValidoSpy).toHaveBeenCalledTimes(0);
    });

    // ──────────────────────────────────────────────────────────────────────────────────────────────
    // AR/MNR-3 — la sonda tiene TECHO, y vencido el techo la causa es OTRA
    // ──────────────────────────────────────────────────────────────────────────────────────────────
    //
    // 🔴 "NO PUDE PREGUNTAR" NO ES "NO PASÓ". Con dos valores nada más, un RPC que acepta la conexión y
    // no contesta terminaba (a) dejando el botón girando PARA SIEMPRE, porque esta llamada era la única
    // sonda del archivo sin techo, y (b) sobre un recorrido cuyas dos firmas la versión anterior ya
    // había borrado, porque la limpieza corría ANTES. Las dos mitades se arreglan juntas.
    // MUTANTE QUE MATA (a): sacar el `withTimeout` ⇒ MEDIDO: exit=1, 2 `it` rojos (éste, que ya no
    //   termina, más el candado de citas por el desplazamiento de líneas).
    // MUTANTE QUE MATA (b): tirar `deeplink_blockhash_expired` en el `catch` ⇒ MEDIDO: exit=1, 1 `it`
    //   rojo, éste, por la causa.
    it("un RPC que acepta y NO contesta vence por el techo ⇒ deeplink_blockhash_desconocido", async () => {
      montarEntorno();
      const motor = new MotorProgramable();
      const p = await primeraVuelta(motor);
      const tx = Transaction.from(bs58.decode(p.transaccionBase58));
      tx.partialSign(SENDER_KP);
      motor.responder = () => ({
        tipo: "completo",
        transaccionFirmadaBase58: serializar(tx),
        firmaDePatrocinio: "F",
        referenceBase58: p.referenceBase58,
        mensajeBase64: p.mensajeBase64,
      });
      sembrarPreparado(); // el doble no escribe el ancla; acá se mide su limpieza
      // Una promesa que NUNCA se resuelve: es el RPC que acepta y se queda callado. La lectura de IDA
      // contesta bien y la de la VUELTA cuelga, que es el caso con las dos firmas ya dadas.
      mockNonce([bytesDeCuentaDeNonce(VALOR_DEL_NONCE), "hang"]);
      const adapter = await adaptadorConMotor(motor);
      // ⚠️ LA FORMA DE ESTE TEST NO ES DECORATIVA: es la misma de T-347-5(b) de este archivo, que costó
      // un flake entero. Se falsea SÓLO `setTimeout`/`clearTimeout` (el juego completo cuelga el camino
      // antes de llegar a la sonda), y son DOS fases con presupuestos separados: primero turnos REALES
      // del event loop hasta que el techo EXISTA —los `await import()` los necesitan—, y sólo después se
      // mueve el reloj falso, que ya tiene a quién vencer.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const corriendo = adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit());
        let causa: string | null = null;
        void corriendo.catch((e: unknown) => {
          causa = e instanceof Error ? e.message : String(e);
        });
        const t0 = Date.now(); // `Date` NO está falseado: este presupuesto se mide en tiempo REAL
        while (vi.getTimerCount() === 0 && Date.now() - t0 < 10_000) {
          await new Promise((r) => setImmediate(r));
        }
        // 🔴 REFUTACIÓN OBLIGATORIA: si no se armó ningún techo, lo que venga después no prueba nada
        // sobre el techo — la promesa podría rechazar por cualquier otro camino.
        expect(vi.getTimerCount(), "no se armó ningún techo: este test no mide nada").toBeGreaterThan(0);
        for (let i = 0; i < 200 && causa === null; i++) {
          await new Promise((r) => setImmediate(r));
          await vi.advanceTimersByTimeAsync(100);
        }
        expect(causa, "la lectura del nonce no venció nunca: el techo no está").toBe(
          "deeplink_blockhash_desconocido",
        );
      } finally {
        vi.useRealTimers();
      }
      // 🔴 Y EL DISCO QUEDA INTACTO: las dos firmas pueden estar perfectas y el que falló fue un RPC
      // nuestro. Borrarlas sería castigar a la persona por nuestra infraestructura.
      expect(disco.has(CLAVE_VIAJE), "un fallo de NUESTRO RPC borró el viaje con las firmas").toBe(
        true,
      );
      expect(disco.has(CLAVE_PREPARADO)).toBe(true);
    }, 30_000);

    // La contracara, y es lo que hace que las dos causas no sean la misma con distinto nombre: cuando la
    // cadena CONTESTÓ que el blockhash murió, esa transacción no entra en ningún bloque nunca más, así
    // que el recorrido se limpia. Sin la limpieza, el próximo intento vuelve a encontrar la misma firma
    // muerta y a cortar igual, durante 20 minutos.
    // MUTANTE QUE MATA (MEDIDO: exit=1, 2 `it` rojos, éste y el candado de citas): borrar el
    // `limpiarRastroDeEnlace` de la rama `!vigente.value`.
    it("con el NONCE YA AVANZADO (la cadena contestó otro valor) el recorrido SÍ se limpia", async () => {
      montarEntorno();
      const motor = new MotorProgramable();
      const p = await primeraVuelta(motor);
      const tx = Transaction.from(bs58.decode(p.transaccionBase58));
      tx.partialSign(SENDER_KP);
      motor.responder = () => ({
        tipo: "completo",
        transaccionFirmadaBase58: serializar(tx),
        firmaDePatrocinio: "F",
        referenceBase58: p.referenceBase58,
        mensajeBase64: p.mensajeBase64,
      });
      sembrarPreparado(); // el doble no escribe el ancla; acá se mide su limpieza
      // La cadena CONTESTÓ, y contestó otro valor: el nonce lo consumió otra transacción. Es el caso de
      // dos dispositivos del mismo remitente, y la tx de este dispositivo está muerta para siempre.
      mockNonce([bytesDeCuentaDeNonce(Keypair.generate().publicKey.toBase58())]);
      const adapter = await adaptadorConMotor(motor);
      await expect(adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit())).rejects.toThrow(
        "deeplink_blockhash_expired",
      );
      expect(disco.has(CLAVE_VIAJE)).toBe(false);
      expect(disco.has(CLAVE_PREPARADO)).toBe(false);
    });

    // 🔴 LA LIMPIEZA DEL CAMINO DE ÉXITO ES DE ACÁ, no del motor (CD-10: leer → usar → limpiar). El
    // motor ya no limpia al devolver `"completo"` justamente para que las dos verificaciones de arriba
    // puedan fallar sin destruir nada; el uso termina cuando el envelope está armado, y ahí se limpia.
    // MUTANTE QUE MATA (MEDIDO: exit=1, 2 `it` rojos, éste y el candado de citas): borrar el
    // `limpiarRastroDeEnlace` de antes del `return` ⇒ la x25519 privada y la sesión sobreviven a un envío
    // que salió BIEN, hasta que la ventana de 20 min las venza.
    it("el camino de ÉXITO deja el disco limpio, DESPUÉS de haber armado el envelope", async () => {
      montarEntorno();
      const motor = new MotorProgramable();
      const p = await primeraVuelta(motor);
      const tx = Transaction.from(bs58.decode(p.transaccionBase58));
      tx.partialSign(SENDER_KP);
      motor.responder = () => ({
        tipo: "completo",
        transaccionFirmadaBase58: serializar(tx),
        firmaDePatrocinio: "FIRMA-POP",
        referenceBase58: p.referenceBase58,
        mensajeBase64: p.mensajeBase64,
      });
      sembrarPreparado(); // el doble no escribe el ancla; acá se mide su limpieza
      const adapter = await adaptadorConMotor(motor);
      const r = await adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit());
      expect(r.estado).toBe("listo");
      expect(r.estado === "listo" && r.solana?.popSignature).toBe("FIRMA-POP"); // el envelope se armó
      expect(disco.has(CLAVE_VIAJE), "la x25519 privada sobrevivió a un envío exitoso").toBe(false);
      expect(disco.has(CLAVE_PREPARADO)).toBe(false);
    });

    // ⛔ Y NO SE AGREGA AL CAMINO INYECTADO: ahí sería una llamada de red de más antes de cada firma, y
    // CD-1 lo prohíbe. MUTANTE QUE MATA (MEDIDO: exit=1, 3 `it` rojos, y el tercero es revelador: muere
    // el T-347-5(b) del techo de la sonda del índice, o sea que una llamada de red de más en este camino
    // se paga en un test que ni sabe de esta HU): agregar `isBlockhashValid` al camino inyectado.
    it("el camino INYECTADO no consulta `isBlockhashValid` ni una vez (CD-1)", async () => {
      montarEntorno();
      solanaWalletBridge.setState({ publicKey: SENDER_B58, connected: true });
      const adapter = new SolanaWalletAdapter(); // ← sin colaborador: el camino de siempre
      await adapter.connect();
      const r = await adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit());
      expect(r.estado).toBe("listo");
      expect(
        blockhashValidoSpy,
        "el camino de la billetera inyectada agregó una llamada de red que antes no hacía (CD-1)",
      ).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // WKH-357 · EL DURABLE NONCE EN LA CONSTRUCCIÓN DE LA TX
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("WKH-357: la nonceAdvance, el umbral y la relectura", () => {
    /** El `PedidoDeFirma` de la PRIMERA vuelta. Gemelo del `primeraVuelta` del describe de T-062-18,
     *  replicado acá porque aquél es local a ese bloque. */
    async function pedidoDeLaPrimeraVuelta(motor: MotorProgramable): Promise<PedidoDeFirma> {
      const adapter = await adaptadorConMotor(motor);
      sembrarViaje(SENDER_B58);
      await adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit());
      const p = motor.pedidos[0];
      if (!p) throw new Error("el motor no recibió ningún pedido");
      return p;
    }

    function serializarTx(tx: Transaction): string {
      return bs58.encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    }

    /** La tx que se le pasa a la billetera para firmar, en la PRIMERA vuelta. */
    async function txDelPedido(): Promise<Transaction> {
      montarEntorno();
      const motor = new MotorProgramable();
      const adapter = await adaptadorConMotor(motor);
      const r = await adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit());
      expect(r.estado).toBe("hay-que-salir");
      const pedido = motor.pedidos[0];
      if (!pedido) throw new Error("el motor no recibió ningún pedido");
      return Transaction.from(bs58.decode(pedido.transaccionBase58));
    }

    // ── ★ T-1 (AC-1) ────────────────────────────────────────────────────────────────────────────
    it("★ T-1: la ix 0 es una nonceAdvance del System Program (data [4,0,0,0], 3 cuentas) y el blockhash es el del NONCE", async () => {
      const tx = await txDelPedido();
      const ix0 = tx.instructions[0];
      expect(ix0?.programId.equals(SystemProgram.programId)).toBe(true);
      expect([...(ix0?.data ?? [])]).toEqual([4, 0, 0, 0]);
      expect(ix0?.keys).toHaveLength(3);
      // La authority (keys[2]) es el SENDER y no el facilitator: si fuera el facilitator, el Check 5
      // del anti-drain rechazaría la tx entera (el fee-payer no puede estar referenciado por ninguna ix).
      expect(ix0?.keys[2]?.pubkey.equals(SENDER_KP.publicKey)).toBe(true);
      expect(ix0?.keys[2]?.isSigner).toBe(true);
      // Y la cuenta de nonce es la DERIVADA, no una cualquiera.
      expect(ix0?.keys[0]?.pubkey.toBase58()).toBe(NONCE_PK_B58);
      // 🔴 EL BLOCKHASH ES EL DEL NONCE. Los dos mocks tienen valores DISTINTOS a propósito: si fueran
      // iguales, esta línea no distinguiría nada.
      expect(tx.recentBlockhash).toBe(VALOR_DEL_NONCE);
      expect(tx.recentBlockhash).not.toBe(FIXED_BLOCKHASH);
    });

    // ── ★ T-2 (AC-1) ────────────────────────────────────────────────────────────────────────────
    it("★ T-2: el `deposit` sigue siendo la ix 0 de las de NEGOCIO después del prepend", async () => {
      const tx = await txDelPedido();
      // El orden ABSOLUTO es [nonceAdvance, limit, price, deposit(, register)].
      expect(tx.instructions[1]?.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
      expect(tx.instructions[2]?.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
      // Y filtrando ComputeBudget **y** System, la posición 0 es el `deposit`: su data arranca con el
      // discriminador del `deposit` (104 bytes), no con los 4 de la nonceAdvance.
      const negocio = businessIx(tx);
      expect(negocio[0]?.programId.equals(new PublicKey(ESCROW_PROGRAM_ID))).toBe(true);
      expect(negocio[0]?.data.length).toBe(104);
      // La posición absoluta del `deposit` pasó de 2 a 3; la RELATIVA entre las de negocio, no cambió.
      expect(tx.instructions.indexOf(negocio[0] as TransactionInstruction)).toBe(3);
    });

    // ── T-6 (AC-2) ──────────────────────────────────────────────────────────────────────────────
    it("T-6: con la cuenta de nonce PRESENTE no se emite ninguna tx de creación ni se transmite nada", async () => {
      const tx = await txDelPedido();
      // La ÚNICA ix del System Program es la nonceAdvance: no hay `createAccountWithSeed` ni
      // `nonceInitialize`. Ésta es la idempotencia de AC-2 — un 2º depósito no vuelve a crear la cuenta,
      // porque la dirección se deriva por semilla fija y la cuenta ya está.
      const delSystem = tx.instructions.filter((i) =>
        i.programId.equals(SystemProgram.programId),
      );
      expect(delSystem).toHaveLength(1);
      expect([...(delSystem[0]?.data ?? [])]).toEqual([4, 0, 0, 0]);
      expect(Connection.prototype.sendRawTransaction).not.toHaveBeenCalled();
      expect(Connection.prototype.sendTransaction).not.toHaveBeenCalled();
    });

    // ── ★ T-26 (AC-2 / §6.6) ────────────────────────────────────────────────────────────────────
    it("★ T-26: la cuenta de nonce AUSENTE ⇒ deeplink_nonce_ausente, sin firmar NADA y sin limpiar el disco", async () => {
      montarEntorno();
      sembrarPreparado();
      const motor = new MotorProgramable();
      // La cuenta no existe: es el caso NORMAL hasta que la ola 4 la cree.
      mockNonce([null]);
      const firmas = vi.fn(async (t: unknown) => {
        (t as Transaction).partialSign(SENDER_KP);
        return t;
      });
      solanaWalletBridge.registerSignTransaction(firmas);
      const adapter = await adaptadorConMotor(motor);
      await expect(adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit())).rejects.toThrow(
        "deeplink_nonce_ausente",
      );
      // 🔴 NO SE PIDIÓ NINGUNA FIRMA: el corte es anterior al diálogo de la billetera.
      expect(firmas).toHaveBeenCalledTimes(0);
      // 🔴 Y NO SE BORRÓ NADA. Es la diferencia con `deeplink_blockhash_expired`, que sí limpia: acá no
      // hay ninguna firma dada que pueda estar muerta, así que borrar sólo destruiría estado útil.
      expect(disco.has(CLAVE_PREPARADO)).toBe(true);
    });

    // ── ★ T-27 (§6.7) — el guard de saldo, con su fail-open ─────────────────────────────────────
    it("★ T-27: saldo `known` UN lamport por debajo del umbral ⇒ corta antes de pedir firma", async () => {
      montarEntorno();
      const motor = new MotorProgramable();
      // ⛔ El umbral NO se escribe como literal acá (CD-12): se importa y se le resta 1.
      vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(
        (SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT - 1) as never,
      );
      const firmas = vi.fn(async (t: unknown) => t);
      solanaWalletBridge.registerSignTransaction(firmas);
      const adapter = await adaptadorConMotor(motor);
      await expect(adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit())).rejects.toThrow(
        "deeplink_saldo_insuficiente",
      );
      expect(firmas).toHaveBeenCalledTimes(0);
    });

    it("★ T-27: saldo EXACTAMENTE en el umbral ⇒ NO corta (la comparación es `<`, no `<=`)", async () => {
      montarEntorno();
      const motor = new MotorProgramable();
      vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(
        SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT as never,
      );
      const adapter = await adaptadorConMotor(motor);
      const r = await adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit());
      expect(r.estado).toBe("hay-que-salir");
    });

    it("★ T-27: saldo `unknown` (el RPC no contesta) ⇒ FAIL-OPEN, el flujo SIGUE", async () => {
      // 🔴 ES LA MITAD QUE UN REVIEW "ARREGLA" AL REVÉS. Este guard no custodia dinero —el runtime de
      // Solana sí—, así que con un RPC caído bloquear convertiría una caída de infraestructura NUESTRA
      // en "no tenés saldo" para TODO el mundo, demo incluida.
      montarEntorno();
      const motor = new MotorProgramable();
      vi.spyOn(Connection.prototype, "getBalance").mockRejectedValue(new Error("rpc_down"));
      const adapter = await adaptadorConMotor(motor);
      const r = await adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit());
      expect(r.estado).toBe("hay-que-salir");
    });

    // ── ★ T-9 (AC-3) — el camino INYECTADO no gana ni una llamada de red ────────────────────────
    it("★ T-9 (AC-3): sin el colaborador `firmaPorEnlace`, las llamadas RPC son las MISMAS que antes de esta HU", async () => {
      // 🔴 ÉSTE ES EL CANDADO DE CD-1 EN RUNTIME, y es complementario del pin de bytes de T-347-6: aquél
      // dice que los BYTES no cambiaron, éste que no se agregó ninguna LECTURA. Un cambio puede dejar los
      // bytes idénticos y colar un `getAccountInfo` de más, y al revés.
      //
      // Los números NO están copiados de ningún documento: son los que produce este camino, y se afirman
      // como igualdad EXACTA para que una lectura nueva no pueda entrar sin ponerse rojo.
      //   getLatestBlockhash → 1  (el blockhash de la tx)
      //   getAccountInfo     → 1  (la sonda de la PDA del índice del escrow, WKH-347)
      //   getBalance         → 0  (el guard de saldo del camino por enlace NO corre acá)
      montarEntorno();
      const latest = vi.spyOn(Connection.prototype, "getLatestBlockhash");
      const accountInfo = mockNonce([bytesDeCuentaDeNonce(VALOR_DEL_NONCE)]);
      const balance = vi.spyOn(Connection.prototype, "getBalance");
      latest.mockClear();
      accountInfo.mockClear();
      balance.mockClear();

      // ⚠️ SIN motor: es exactamente cómo `container.ts` arma el adapter en producción hoy.
      solanaWalletBridge.setState({ publicKey: SENDER_B58, connected: true });
      const adapter = new SolanaWalletAdapter();
      await adapter.connect();
      const r = esperarAutorizacionLista(
        await adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit()),
      );

      expect(latest).toHaveBeenCalledTimes(1);
      expect(accountInfo).toHaveBeenCalledTimes(1);
      expect(balance).toHaveBeenCalledTimes(0);
      // Y que NINGUNA de esas lecturas haya sido la de la cuenta de nonce.
      const lecturasDelNonce = accountInfo.mock.calls.filter(
        (c) => (c[0] as PublicKey).toBase58() === NONCE_PK_B58,
      );
      expect(lecturasDelNonce).toHaveLength(0);
      // Y la tx que sale NO lleva ninguna ix del System Program: cero `nonceAdvance`.
      const tx = Transaction.from(Buffer.from(String(r.solana?.partialSignedTx), "base64"));
      expect(tx.instructions.filter((i) => i.programId.equals(SystemProgram.programId))).toHaveLength(0);
      expect(tx.recentBlockhash).toBe(FIXED_BLOCKHASH);
    });

    // ── ★ T-17 (AC-6) — la RELECTURA, no un valor memoizado ─────────────────────────────────────
    it("★ T-17 (AC-6): la comparación de la vuelta usa el valor RELEÍDO, no el de la primera lectura", async () => {
      // 🔴 CÓMO ESTE TEST DISTINGUE LO QUE DICE DISTINGUIR. En la invocación de la vuelta hay DOS
      // lecturas de la cuenta. Se hace que la 1ª devuelva el valor que la tx TRAE y la 2ª un valor
      // DISTINTO. Si el código memoizara (o reusara la 1ª), la comparación cuadraría y el depósito
      // seguiría; como relee, ve que el nonce avanzó y corta. O sea: el resultado sólo puede ser
      // `expired` si la SEGUNDA lectura es la que decide.
      montarEntorno();
      const motor = new MotorProgramable();
      const p = await pedidoDeLaPrimeraVuelta(motor);
      const tx = Transaction.from(bs58.decode(p.transaccionBase58));
      tx.partialSign(SENDER_KP);
      motor.responder = () => ({
        tipo: "completo",
        transaccionFirmadaBase58: serializarTx(tx),
        firmaDePatrocinio: "F",
        referenceBase58: p.referenceBase58,
        mensajeBase64: p.mensajeBase64,
      });
      const spy = mockNonce([
        bytesDeCuentaDeNonce(VALOR_DEL_NONCE), // la de IDA: coincide con lo que la tx trae
        bytesDeCuentaDeNonce(Keypair.generate().publicKey.toBase58()), // la de la VUELTA: ya avanzó
      ]);
      const adapter = await adaptadorConMotor(motor);
      await expect(adapter.authorizePrincipal(makeQuote(), REM, escrowDeposit())).rejects.toThrow(
        "deeplink_blockhash_expired",
      );
      // Y se leyó la cuenta DOS veces en esta invocación: un valor guardado en un campo del adapter
      // (que es un SINGLETON del container) daría 1.
      const lecturasDelNonce = spy.mock.calls.filter(
        (c) => (c[0] as PublicKey).toBase58() === NONCE_PK_B58,
      );
      expect(lecturasDelNonce.length).toBe(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // T-062-20 (AC-7 / CD-2) — la billetera NUNCA transmite
  // ──────────────────────────────────────────────────────────────────────────────────────────────
  it("T-062-20: NINGUNA rama de `authorizePrincipal` referencia sendRawTransaction/sendTransaction/signAndSendTransaction", () => {
    // Barrido sobre el CÓDIGO, no sobre una corrida: un espía en 0 sólo dice que ESE camino no
    // transmitió. Esto dice que no hay ninguna rama que pueda.
    // MUTANTE QUE MATA (MEDIDO: exit=1, 2 `it` rojos, éste y el candado de citas): referenciar
    // `sendRawTransaction` dentro del método.
    const fuente = readFileSync(
      path.resolve(process.cwd(), "src/infrastructure/solana-wallet.ts"),
      "utf8",
    );
    const desde = fuente.indexOf("async authorizePrincipal(");
    expect(desde, "no se encontró `authorizePrincipal` en el archivo").toBeGreaterThan(0);
    // El método termina donde arranca el docblock de `probeDeposit`, el siguiente miembro.
    const hasta = fuente.indexOf("¿Entró el principal al vault", desde);
    expect(hasta, "no se encontró el final del método").toBeGreaterThan(desde);
    // 🔴 HAY QUE SACAR LOS COMENTARIOS, y el primer intento de este test no lo hacía: el método tiene
    // escrito `// AC-3/CD-SDD-1: NUNCA connection.sendRawTransaction / sendTransaction acá.`, o sea
    // que el barrido crudo daba positivo sobre la línea que PROHÍBE lo que busca. Un guard que se
    // dispara con su propia advertencia es un guard que alguien termina borrando.
    // El `(?<!:)` protege los `https://` de cualquier literal.
    const cuerpo = fuente
      .slice(desde, hasta)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(?<!:)\/\/.*$/gm, "");
    // Y que el barrido no se haya comido el CÓDIGO: si esto falla, el `for` de abajo estaría mirando
    // una cadena vacía y daría verde sin haber mirado nada.
    expect(
      cuerpo.includes("solanaWalletBridge.signTransaction(tx)"),
      "el barrido borró el código además de los comentarios: estaría dando verde sobre la nada",
    ).toBe(true);
    expect(cuerpo.includes("this.firmaPorEnlace")).toBe(true); // y la rama nueva también está adentro
    for (const prohibida of ["sendRawTransaction", "sendTransaction", "signAndSendTransaction"]) {
      expect(
        cuerpo.includes(prohibida),
        `\`authorizePrincipal\` referencia \`${prohibida}\`. El facilitator es el ÚNICO que transmite ` +
          "(AC-7/CD-2): una billetera que broadcastea rompe el modelo de patrocinio entero, porque la " +
          "tx sale sin la firma del feePayer y el rent lo paga quien no debe.",
      ).toBe(false);
    }
  });

  // ── ★ T-8 (AC-3 / CD-11) — todo lo del nonce vive DESPUÉS del primer `if (this.firmaPorEnlace)` ──
  //
  // ⚠️ QUÉ PRUEBA ESTE TEST Y QUÉ NO, dicho antes de que alguien se apoye en su verde. Prueba que
  // ningún identificador del nonce aparece en el cuerpo de `authorizePrincipal` ANTES de la primera
  // rama de enlace. NO prueba que el camino inyectado no los ejecute: para eso haría falta razonar
  // sobre el flujo de control, y un texto no puede hacerlo. Los instrumentos que SÍ lo miden son
  // otros dos, y son de runtime:
  //   · T-9, que cuenta las llamadas RPC del camino inyectado y las clava en 1/1/0;
  //   · T-347-6, que compara los BYTES de la tx del camino inyectado contra un fixture pinneado del
  //     árbol previo a WKH-347 — un pin que esta HU NO regeneró, y que sigue verde.
  // Y el candado más fuerte es el mutante, medido: sacar el bloque del nonce afuera del `if` pone 28
  // `it` en rojo. Este barrido es la red barata que caza el error de EDICIÓN (pegar una línea nueva
  // arriba de la rama por descuido), no una prueba de aislamiento.
  it("★ T-8 (CD-11): ningún identificador del nonce aparece antes de la primera rama `if (this.firmaPorEnlace)`", () => {
    const fuente = readFileSync(
      path.resolve(process.cwd(), "src/infrastructure/solana-wallet.ts"),
      "utf8",
    );
    const desde = fuente.indexOf("async authorizePrincipal(");
    expect(desde, "no se encontró `authorizePrincipal` en el archivo").toBeGreaterThan(0);
    const hasta = fuente.indexOf("¿Entró el principal al vault", desde);
    expect(hasta, "no se encontró el final del método").toBeGreaterThan(desde);
    // CD-11 regla (a): descontar comentarios. Sin esto, el barrido se dispara con los propios
    // comentarios que explican el nonce, que son muchos y están a propósito.
    const cuerpo = fuente
      .slice(desde, hasta)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(?<!:)\/\/.*$/gm, "");
    // CD-11 regla (b): assertar que DESPUÉS de descontarlos todavía queda el código que creemos
    // mirar. Sin esta línea, un regex goloso da verde sobre una cadena vacía.
    expect(
      cuerpo.includes("solanaWalletBridge.signTransaction(tx)"),
      "el barrido borró el código además de los comentarios: estaría dando verde sobre la nada",
    ).toBe(true);
    // 🔴 Y ACÁ ESTÁ LO QUE HACE QUE EL DESCUENTO DE COMENTARIOS SEA LOAD-BEARING, medido: el cuerpo
    // BRUTO tiene 3 ocurrencias de `if (this.firmaPorEnlace)` y el descontado tiene 2 — la tercera es
    // el comentario que explica que todo vive adentro de la rama. Sin este assert, neutralizar el
    // regex de comentarios NO ponía nada en rojo (mutante CORRIDO: sobrevivía), y el guard quedaba
    // debilitado en silencio: `primeraRama` caía en el COMENTARIO, que está más arriba, y una llamada
    // colada entre ese comentario y la rama real habría pasado desapercibida.
    const ramas = (cuerpo.match(/if \(this\.firmaPorEnlace\)/g) ?? []).length;
    expect(
      ramas,
      "el método tiene que tener EXACTAMENTE 2 ramas `if (this.firmaPorEnlace)` en CÓDIGO (la de las " +
        "lecturas del nonce y la grande). Si acá aparecen 3, el barrido está contando un comentario y " +
        "el descuento de comentarios dejó de funcionar.",
    ).toBe(2);
    const primeraRama = cuerpo.indexOf("if (this.firmaPorEnlace)");
    expect(primeraRama, "la rama de enlace no está en el cuerpo: el barrido no mide nada").toBeGreaterThan(0);
    // Y que el código del nonce siga existiendo, o los `toBe(-1)` de abajo pasarían por vacío.
    expect(cuerpo).toContain("direccionDelNonce");
    // ⚠️ SE BARREN LAS TRES LLAMADAS, NO LAS DOS DECLARACIONES, y el motivo es real y no una excusa
    // para que el test pase: `let nonceIx` y `let valorDelNonce` TIENEN que estar declaradas en el
    // scope de afuera, porque el ternario que arma la tx —que corre en los DOS caminos— las lee. Una
    // declaración `let x: T | undefined;` no hace trabajo, no pide red y no cambia un byte: en el
    // camino inyectado las dos valen `undefined` y el ternario toma la rama de siempre. Lo que importa
    // es que no se EJECUTE nada, y eso lo miden T-9 (1/1/0 llamadas RPC) y T-347-6 (los bytes).
    for (const id of ["direccionDelNonce", "leerNonce", "construirNonceAdvance"]) {
      const antes = cuerpo.slice(0, primeraRama);
      expect(
        antes.indexOf(id),
        `\`${id}\` aparece ANTES del primer \`if (this.firmaPorEnlace)\`. Todo lo de WKH-357 vive ` +
          "adentro de esa rama (CD-1): el camino de la billetera inyectada es el del video de M5 y ya " +
          "movió USDC real en cadena.",
      ).toBe(-1);
    }
  });
});
