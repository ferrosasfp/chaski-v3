import { sha256 } from "@noble/hashes/sha256";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Money } from "../domain/money";
import type { Quote } from "../domain/remittance";
import { SolanaWalletAdapter } from "./solana-wallet";
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
function firstIx(tx: Transaction) {
  const ix = tx.instructions[0];
  if (!ix) throw new Error("no_instruction");
  return ix;
}

describe("SolanaWalletAdapter.authorizePrincipal (HU-SOL-5)", () => {
  let signSpy: ReturnType<typeof vi.fn>;

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
    signSpy = vi.fn(async (tx: unknown) => tx);
    solanaWalletBridge.registerSignTransaction(signSpy);
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

    const ix = firstIx(capturedTx(signSpy));
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
    expect(firstIx(back).programId.toBase58()).toBe(ESCROW_PROGRAM_ID);
  });

  it("AC-4/CD-SDD-6: reference como remainingAccount no-signer/no-writable, al final del set", async () => {
    const adapter = await connectedAdapter();
    const res = await adapter.authorizePrincipal(makeQuote(), "rem-ac4", escrowDeposit());

    const ix = firstIx(capturedTx(signSpy));
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

  it("AC-8/CD-SDD-3: amount = String(send.minor) (u64), deadline = floor(expiresAt/1000), sin float", async () => {
    const adapter = await connectedAdapter();
    const quote = makeQuote({ expiresAt: "2099-06-15T12:00:00.000Z" });
    await adapter.authorizePrincipal(quote, "rem-ac8", escrowDeposit());

    const data = firstIx(capturedTx(signSpy)).data;
    // layout borsh: 8 disc + 16 remittance_id + 32 beneficiary + 32 authority + 8 amount(LE) + 8 deadline(LE)
    const amount = data.readBigUInt64LE(8 + 16 + 32 + 32);
    const deadline = data.readBigInt64LE(8 + 16 + 32 + 32 + 8);
    expect(amount).toBe(BigInt(quote.send.minor));
    expect(deadline).toBe(BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000)));
  });

  it("AC-8: expiresAt inválido → throw quote_expires_at_invalid", async () => {
    const adapter = await connectedAdapter();
    await expect(
      adapter.authorizePrincipal(makeQuote({ expiresAt: "not-a-date" }), "rem-bad", escrowDeposit()),
    ).rejects.toThrow("quote_expires_at_invalid");
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
