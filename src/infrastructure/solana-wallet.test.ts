import { sha256 } from "@noble/hashes/sha256";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Money } from "../domain/money";
import type { Quote } from "../domain/remittance";
import { CUSTODY_WINDOW_SECS, SolanaWalletAdapter } from "./solana-wallet";
import { solanaWalletBridge } from "./solana-wallet-bridge";

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
/** Localiza la ix `deposit` por programId, NUNCA por índice. Copia del patrón del lector de
 *  producción (settlement/solana-deposit-beneficiary.ts:47). Un test que la busca por índice
 *  codifica "el deposit es la primera instrucción" como si fuera un invariante, y no lo es:
 *  WKH-321 antepuso dos ComputeBudget y la billetera puede anteponer más. */
function depositIx(tx: Transaction) {
  const ix = tx.instructions.find((i) => i.programId.equals(new PublicKey(ESCROW_PROGRAM_ID)));
  if (!ix) throw new Error("deposit_ix_not_found");
  return ix;
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

    // accounts del IDL (8) + reference (1) = 9, sin alterar el set del IDL.
    expect(ix.keys).toHaveLength(9);
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
    const res = await adapter.authorizePrincipal(quote, rid, escrowDeposit());

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
    const res = await adapter.authorizePrincipal(makeQuote(), "rem-ac3", escrowDeposit());

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
    const res = await adapter.authorizePrincipal(makeQuote(), "rem-ac4", escrowDeposit());

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
  it("T1 (AC-1 mitad espacial / AC-5): la tx lleva 3 ix — [SetComputeUnitLimit, SetComputeUnitPrice, deposit], en ese orden — el 'antes de firmar' lo cubre T3", async () => {
    const adapter = await connectedAdapter();
    await adapter.authorizePrincipal(makeQuote(), "rem-cb-orden", escrowDeposit());

    const tx = capturedTx(signSpy);
    expect(tx.instructions).toHaveLength(3);

    const [limitIx, priceIx, businessIx] = tx.instructions;
    if (!limitIx || !priceIx || !businessIx) throw new Error("missing_instruction");

    // Posición 0: el LÍMITE. Posicional a propósito: acá se verifica el ORDEN, no se localiza el deposit.
    expect(limitIx.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(limitIx.data.readUInt8(0)).toBe(CB_SET_LIMIT);
    // Posición 1: el PRECIO.
    expect(priceIx.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(priceIx.data.readUInt8(0)).toBe(CB_SET_PRICE);
    // Posición 2: el negocio.
    expect(businessIx.programId.toBase58()).toBe(ESCROW_PROGRAM_ID);
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
    expect(snapshot).toHaveLength(3);
    expect(snapshot[0]).toEqual({
      programId: ComputeBudgetProgram.programId.toBase58(),
      kind: CB_SET_LIMIT,
    });
    expect(snapshot[1]).toEqual({
      programId: ComputeBudgetProgram.programId.toBase58(),
      kind: CB_SET_PRICE,
    });
    expect(snapshot[2]?.programId).toBe(ESCROW_PROGRAM_ID);
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
    expect(ix.keys).toHaveLength(9); // 8 del IDL + reference

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
  // billetera DEVUELVE (`remainingAccounts`, `solana-wallet.ts:375`), y en producción puede ser otro objeto: el
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
  it("T12 (AC-5, payload): la tx que se POSTEA trae exactamente [limit 120.000, price 10.000, deposit]", async () => {
    const adapter = await connectedAdapter();
    const res = await adapter.authorizePrincipal(makeQuote(), "rem-cb-payload", escrowDeposit());

    const posted = Transaction.from(Buffer.from(res.solana?.partialSignedTx ?? "", "base64"));

    // 3, ni una más: una cuarta ix de ComputeBudget en el payload ⇒ TOO_MANY_COMPUTE_BUDGET_IX /
    // DUP_* del lado del facilitator (cr1.ts:131-156), que es el 422 que esta HU vino a cerrar.
    expect(posted.instructions).toHaveLength(3);
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
