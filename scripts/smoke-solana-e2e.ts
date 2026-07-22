// scripts/smoke-solana-e2e.ts — smoke e2e del money-path Solana no-custodial devnet (HU-SOL-11, AC-5/AC-6/AC-8).
//
// Orquesta, contra servicios REALES ya deployados (chaski + facilitator + remit-agents), el ciclo
// completo: prepare → deposit (escrow) → sponsor (broadcast gasless) → verify vault → release → orden
// TransFi → link de Solana Explorer. Ejercita el shape Solana de /api/payout/prepare (H1 de esta HU).
//
// GARANTÍAS (Constraint Directives):
//  - OPT-IN (AC-6/CD-6): sin SMOKE_ALLOW_REAL="true" ABORTA antes de cualquier fetch de dinero. NUNCA
//    corre en F3/CI por accidente — es founder-gated (runbook paso 7).
//  - ENV-DRIVEN 100% (AC-5/CD-4): CERO hardcodes de URLs/keys/cluster/mint. Toda env ausente ⇒ fail-loud
//    (exit≠0) con el NOMBRE de la var, NUNCA su valor. NUNCA imprime secretos (keypair/tokens).
//  - CERO PLATA REAL (CD-6): SOLO devnet; PROHIBIDO cualquier default/fallback a mainnet-beta.
//  - REUSA los building-blocks del repo (CD-7): `escrowIdl` (copia pinneada) + el patrón de construcción
//    de la ix `deposit` de `solana-wallet.ts`. NO reimplementa el discriminator ni "miente" el shape.
//  - Runtime `tsx` (`npm run smoke:solana`). Typecheck aislado vía `tsconfig.scripts.json`. NO se ejecuta
//    en F3: sólo typechea/lintea.
import { createHmac } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha256";
import {
  clusterApiUrl,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import type { Idl, Provider } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { escrowIdl } from "../src/infrastructure/solana/escrow-idl";

const CLUSTER = "devnet" as const; // CD-6: SOLO devnet, jamás mainnet-beta.

// ── Gate opt-in (AC-6) — PRIMER statement, ANTES de cualquier fetch de dinero ──────────────────────
if (process.env.SMOKE_ALLOW_REAL !== "true") {
  console.error("SMOKE aborted: SMOKE_ALLOW_REAL !== 'true' (opt-in founder-gated, ver runbook paso 7)");
  process.exit(1);
}

// ── Validación fail-loud de las envs requeridas (AC-5/CD-4) — nombre explícito, NUNCA el valor ──────
const REQUIRED_ENVS = [
  "SMOKE_CHASKI_URL", // base URL de chaski deployado (expone /api/payout/prepare + /api/settle/solana-sponsor)
  "SMOKE_FACILITATOR_URL", // base URL del wasiai-facilitator (healthcheck)
  "SMOKE_REMIT_URL", // base URL de wasiai-remittance-agents (healthcheck)
  "SMOKE_SENDER_SECRET_KEY", // keypair devnet base58 del sender que firma el deposit (SECRETO — nunca se imprime)
  "SMOKE_KYC_VERIFICATION_ID", // verificationId de sandbox Didit (KYC redirect-interactivo, id pre-obtenido)
  "SMOKE_REMITTANCE_ID", // id de la remesa (ata la PDA escrow_state + la atestación)
  "SMOKE_QUOTE_ID", // id de la cotización
  "SMOKE_AMOUNT_USD", // monto en USD (se convierte a minor units USDC de 6 decimales)
  "SMOKE_SOLANA_USDC_MINT", // mint USDC devnet (base58) — necesario para construir la ix `deposit`
  "SMOKE_SOLANA_FACILITATOR_PUBKEY", // pubkey devnet del facilitator (feePayer gasless) — cofirma server-side
  "SMOKE_SPONSOR_POP_SECRET", // secreto compartido con el facilitator (== SOLANA_SPONSOR_POP_SECRET) para el popProof
] as const;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (typeof v !== "string" || !v.trim()) {
    console.error(`SMOKE aborted: env requerida ausente: ${name}`); // NUNCA el valor (CD-4)
    process.exit(1);
  }
  return v;
}

for (const name of REQUIRED_ENVS) requireEnv(name);

const CHASKI_URL = requireEnv("SMOKE_CHASKI_URL").replace(/\/$/, "");
const FACILITATOR_URL = requireEnv("SMOKE_FACILITATOR_URL").replace(/\/$/, "");
const REMIT_URL = requireEnv("SMOKE_REMIT_URL").replace(/\/$/, "");
const SENDER_SECRET_KEY = requireEnv("SMOKE_SENDER_SECRET_KEY");
const KYC_VERIFICATION_ID = requireEnv("SMOKE_KYC_VERIFICATION_ID");
const REMITTANCE_ID = requireEnv("SMOKE_REMITTANCE_ID");
const QUOTE_ID = requireEnv("SMOKE_QUOTE_ID");
const AMOUNT_USD = requireEnv("SMOKE_AMOUNT_USD");

// Config devnet-only (no-secreta). RPC/mint desde env con default devnet explícito (CD-6: nunca mainnet).
const RPC_URL = process.env.SMOKE_SOLANA_RPC_URL || clusterApiUrl(CLUSTER);
// El mint USDC devnet es necesario para construir la ix `deposit`. Se exige explícito (base58 devnet).
const USDC_MINT = requireEnv("SMOKE_SOLANA_USDC_MINT");
// Pubkey del facilitator (feePayer gasless). Se resuelve UPFRONT (antes de cualquier fetch con side-effect,
// p.ej. /api/payout/prepare que crea una orden TransFi sandbox) para abortar fail-loud sin efectos.
const FACILITATOR_PUBKEY = requireEnv("SMOKE_SOLANA_FACILITATOR_PUBKEY");
// Secreto del popProof del sponsor (== SOLANA_SPONSOR_POP_SECRET del facilitator). SECRETO — nunca se imprime.
const SPONSOR_POP_SECRET = requireEnv("SMOKE_SPONSOR_POP_SECRET");
// Ventana del deadline del escrow (i64 unix seconds). Default 1h; env-overridable. NO es secreto.
const DEADLINE_SECONDS = Number.parseInt(process.env.SMOKE_DEADLINE_SECONDS ?? "3600", 10);

function ok(step: number, msg: string): void {
  console.log(`OK [${step}] ${msg}`);
}
function fail(step: number, reason: string): never {
  console.error(`FAIL [${step}] ${reason}`);
  process.exit(1);
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** [u8;16] DETERMINÍSTICO desde remittanceId: sha256(utf8(remittanceId))[:16] — MISMA derivación que
 *  solana-wallet.ts:61 (reproducible server-side para re-derivar la PDA escrow_state). NUNCA Math.random. */
function remittanceIdToBytes16(remittanceId: string): Uint8Array {
  return Uint8Array.from(sha256(new TextEncoder().encode(remittanceId)).subarray(0, 16));
}

async function main(): Promise<void> {
  // ── Checkpoint 1 — healthcheck de los 3 servicios ────────────────────────────────────────────────
  for (const [label, base] of [
    ["chaski", CHASKI_URL],
    ["facilitator", `${FACILITATOR_URL}/health`], // el facilitator no tiene root route (404); healthcheck vía /health
    ["remit", REMIT_URL],
  ] as const) {
    let res: Response;
    try {
      res = await fetch(base, { method: "GET", signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      return fail(1, `healthcheck ${label} inalcanzable: ${e instanceof Error ? e.name : "error"}`);
    }
    if (!res.ok) return fail(1, `healthcheck ${label} no-2xx (${res.status})`);
  }
  ok(1, "healthcheck chaski/facilitator/remit 2xx");

  // ── Checkpoint 2 — KYC: verificationId de sandbox presente (pre-obtenido, redirect-interactivo) ───
  if (!KYC_VERIFICATION_ID.trim()) return fail(2, "SMOKE_KYC_VERIFICATION_ID vacío");
  ok(2, "KYC verificationId de sandbox presente");

  // ── Checkpoint 3 — POST /api/payout/prepare → shape-check INLINE del 200 Solana (CD-7: NO importa
  //    isValidSolanaPrepareShape del gateway cerrado) ───────────────────────────────────────────────
  const sender = Keypair.fromSecretKey(bs58.decode(SENDER_SECRET_KEY)); // SECRETO — nunca se imprime
  const senderAddr = sender.publicKey.toBase58();
  const idempotencyKey = `${REMITTANCE_ID}:${QUOTE_ID}`;

  // ── PoP (WKH-206/HU-SOL-8): challenge → firma ed25519 del sender. En vm=solana es OBLIGATORIO en
  //    /api/payout/prepare (PR6). El sender firma el popMessage VERBATIM con su key ed25519. ──────────
  let popChallenge: string;
  let popSignature: string;
  try {
    const chRes = await fetch(`${CHASKI_URL}/api/a2a/payout/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: senderAddr }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!chRes.ok) return fail(3, `PoP challenge no-2xx (${chRes.status})`);
    const chBody: unknown = await chRes.json().catch(() => null);
    if (
      !isRecord(chBody) ||
      typeof chBody.popChallenge !== "string" ||
      typeof chBody.popMessage !== "string"
    ) {
      return fail(3, "PoP challenge shape inválido (popChallenge/popMessage)");
    }
    popChallenge = chBody.popChallenge;
    const sig = nacl.sign.detached(new TextEncoder().encode(chBody.popMessage), sender.secretKey);
    popSignature = bs58.encode(sig); // firma ed25519 base58, verbatim al verificador (pop-verify-solana)
  } catch (e) {
    return fail(3, `PoP challenge inalcanzable: ${e instanceof Error ? e.name : "error"}`);
  }
  ok(3, "PoP challenge firmado (ed25519)");

  let prepareRes: Response;
  try {
    prepareRes = await fetch(`${CHASKI_URL}/api/payout/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        remittanceId: REMITTANCE_ID,
        quoteId: QUOTE_ID,
        kycVerificationId: KYC_VERIFICATION_ID,
        address: senderAddr,
        amountUsd: Number(AMOUNT_USD),
        idempotencyKey,
        popChallenge,
        popSignature,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return fail(3, `prepare inalcanzable: ${e instanceof Error ? e.name : "error"}`);
  }
  if (!prepareRes.ok) return fail(3, `prepare no-2xx (${prepareRes.status})`);
  const prepareBody: unknown = await prepareRes.json().catch(() => null);
  if (!isRecord(prepareBody)) return fail(3, "prepare body no es objeto");
  const { beneficiary, authority, attestation, payoutId, provenance } = prepareBody;
  if (
    typeof beneficiary !== "string" || !beneficiary ||
    typeof authority !== "string" || !authority ||
    typeof attestation !== "string" || !attestation ||
    typeof payoutId !== "string" || !payoutId ||
    typeof provenance !== "string"
  ) {
    return fail(3, "prepare shape Solana inválido (beneficiary/authority/attestation/payoutId/provenance)");
  }
  ok(3, "prepare devolvió shape Solana válido (base58)");

  // ── Checkpoint 4 — construir + partial-firmar la ix `deposit` reusando escrowIdl (CD-7) ──────────
  const senderPk = sender.publicKey;
  const beneficiaryPk = new PublicKey(beneficiary);
  const authorityPk = new PublicKey(authority);
  const mintPk = new PublicKey(USDC_MINT);
  const programId = new PublicKey((escrowIdl as { address: string }).address); // BBQ9…79WA (CD-SDD-4)

  const remittanceIdBytes = remittanceIdToBytes16(REMITTANCE_ID); // [u8;16] determinístico
  const amount = new anchor.BN(String(Math.round(Number(AMOUNT_USD) * 1_000_000))); // USDC 6 dec, u64
  const deadline = new anchor.BN(String(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS)); // i64

  const [escrowStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), senderPk.toBuffer(), Buffer.from(remittanceIdBytes)],
    programId,
  );
  const vault = getAssociatedTokenAddressSync(mintPk, escrowStatePda, /*allowOwnerOffCurve*/ true);
  const senderAta = getAssociatedTokenAddressSync(mintPk, senderPk);
  const reference = Keypair.generate().publicKey; // la privada se DESCARTA (nunca firma)

  const connection = new Connection(RPC_URL, "confirmed");
  // feePayer = pubkey del facilitator (gasless): su keypair PRIVADA cofirma en el sponsor server-side.
  // Resuelto/validado UPFRONT (módulo) — acá sólo se parsea a PublicKey (sin fetch previo con side-effect).
  const facilitatorPk = new PublicKey(FACILITATOR_PUBKEY);
  const program = new anchor.Program(escrowIdl as unknown as Idl, { connection } as Provider);
  // `escrowIdl as Idl` es el IDL genérico ⇒ acceso vía shape loose (patrón solana-wallet.ts:117).
  const methods = program.methods as unknown as {
    deposit: (...args: unknown[]) => {
      accounts: (a: Record<string, PublicKey>) => {
        remainingAccounts: (
          r: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>,
        ) => { instruction: () => Promise<TransactionInstruction> };
      };
    };
  };
  const ix = await methods
    .deposit(Array.from(remittanceIdBytes), beneficiaryPk, authorityPk, amount, deadline)
    .accounts({ sender: senderPk, mint: mintPk, escrowState: escrowStatePda, vault, senderAta })
    .remainingAccounts([{ pubkey: reference, isSigner: false, isWritable: false }])
    .instruction();

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction().add(ix);
  tx.feePayer = facilitatorPk; // el facilitator cofirma/paga el fee (gasless) en el sponsor
  tx.recentBlockhash = blockhash;
  tx.partialSign(sender); // partial-sign SÓLO con la wallet del sender (nunca broadcastea acá)
  const partialSignedTx = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
  ok(4, "ix deposit construida + partial-firmada por el sender (escrow escrowIdl)");

  // ── Checkpoint 5 — POST /api/settle/solana-sponsor (broadcast gasless vía facilitator) ───────────
  let sponsorRes: Response;
  try {
    sponsorRes = await fetch(`${CHASKI_URL}/api/settle/solana-sponsor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        partialSignedTx,
        reference: reference.toBase58(),
        sender: senderAddr,
        remittanceId: REMITTANCE_ID,
        // popProof = HMAC-SHA256(sender, SOLANA_SPONSOR_POP_SECRET).hex — verbatim a verifySponsorPop del facilitator.
        popProof: createHmac("sha256", SPONSOR_POP_SECRET).update(senderAddr).digest("hex"),
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return fail(5, `sponsor inalcanzable: ${e instanceof Error ? e.name : "error"}`);
  }
  if (!sponsorRes.ok) return fail(5, `sponsor no-2xx (${sponsorRes.status})`);
  const sponsorBody: unknown = await sponsorRes.json().catch(() => null);
  const signature = isRecord(sponsorBody) && typeof sponsorBody.signature === "string" ? sponsorBody.signature : "";
  if (!signature.trim()) return fail(5, "sponsor no devolvió signature base58");
  ok(5, "deposit broadcasteado (gasless) — signature recibida");

  // ── M5 EVIDENCE ── la tx del deposit YA está on-chain: imprimir el link del Explorer ACÁ (= AC de M5),
  //    ANTES de las patas best-effort (release/TransFi, que requieren KYC Didit real + credenciales TransFi).
  const explorerUrl = `https://explorer.solana.com/tx/${signature}?cluster=${CLUSTER}`;
  console.log("\n============================================================");
  console.log(">>> M5 — TX del deposit no-custodial (verificable en Solana Explorer):");
  console.log(`    ${explorerUrl}`);
  console.log("============================================================\n");

  // ── Checkpoint 6 — verify vault: leer EscrowState on-chain hasta status==Deposited ───────────────
  let deposited = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const info = await connection.getAccountInfo(escrowStatePda);
    if (info) {
      const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
      const state = coder.decode("EscrowState", info.data) as { status: Record<string, unknown> };
      const statusKey = Object.keys(state.status)[0];
      if (statusKey === "Deposited") {
        deposited = true;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  if (!deposited) return fail(6, "escrow no alcanzó status Deposited en la ventana");
  ok(6, "vault on-chain en status Deposited");

  // ── Checkpoints 7-8 (BEST-EFFORT) — release del escrow + orden TransFi ────────────────────────────
  //    Requieren KYC Didit REAL (el `submit` rechaza el `simulated_dev` del preview) + credenciales
  //    TransFi sandbox → DIFERIDOS (decisión del founder: M5 = la tx del deposit on-chain, ya capturada
  //    arriba). Un fallo acá NO invalida M5; sólo se reporta como best-effort. Referencia a `attestation`
  //    y `payoutId` del prepare para el intento.
  try {
    const releaseRes = await fetch(`${CHASKI_URL}/api/a2a/payout/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        remittanceId: REMITTANCE_ID,
        quoteId: QUOTE_ID,
        kycVerificationId: KYC_VERIFICATION_ID,
        address: senderAddr,
        attestation,
        payoutId,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    console.log(
      releaseRes.ok
        ? "OK [7] release/TransFi (pata fiat) disparado"
        : `WARN [7] release/TransFi best-effort no-2xx (${releaseRes.status}) — requiere KYC Didit real + TransFi; NO afecta M5 (deposit ya on-chain)`,
    );
  } catch (e) {
    console.log(
      `WARN [7] release/TransFi best-effort inalcanzable (${e instanceof Error ? e.name : "error"}) — NO afecta M5`,
    );
  }

  // ── Checkpoint 9 — evidencia final de M5 ─────────────────────────────────────────────────────────
  console.log(`\nM5 OK — tx del deposit no-custodial verificable en:\n${explorerUrl}`);
  ok(9, "M5 completado (deposit on-chain); release/TransFi diferidos (best-effort)");
}

main().catch((e) => {
  console.error(`SMOKE aborted (unexpected): ${e instanceof Error ? e.name : "error"}`);
  process.exit(1);
});
