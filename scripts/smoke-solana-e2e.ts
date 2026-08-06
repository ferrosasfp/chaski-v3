// scripts/smoke-solana-e2e.ts: smoke e2e del money-path Solana no-custodial devnet (HU-SOL-11, AC-5/AC-6/AC-8).
//
// Orquesta, contra servicios REALES ya deployados (chaski + facilitator + remit-agents), el ciclo
// ON-CHAIN completo: prepare, deposit en el escrow, broadcast gasless, verificación del vault,
// release contra el facilitator y verificación de que el escrow quedó liberado y el vault en cero.
//
// ⚠️ ALCANCE, y hay que leerlo antes de interpretar cualquier resultado de este script:
// el ciclo que cierra acá es el ON-CHAIN. La pata FIAT (KYC real + orden de desembolso completada)
// NO se ejercita y NO se finge: queda declarada fuera de alcance, y el paso 7 lo dice por pantalla.
// Ver el bloque `printDisclaimerRelease()` y el comentario del checkpoint 7.
//
// GARANTÍAS (Constraint Directives):
//  - OPT-IN (AC-6/CD-6): sin SMOKE_ALLOW_REAL="true" ABORTA antes de cualquier fetch de dinero. NUNCA
//    corre en F3/CI por accidente, es founder-gated (runbook paso 7).
//  - ENV-DRIVEN 100% (AC-5/CD-4): CERO hardcodes de URLs/keys/cluster/mint. Toda env ausente produce
//    fail-loud (exit≠0) con el NOMBRE de la var, NUNCA su valor. NUNCA imprime secretos.
//  - CERO PLATA REAL (CD-6): SOLO devnet; PROHIBIDO cualquier default/fallback a mainnet-beta. Y el
//    checkpoint 3 SIGUE sólo si el `provenance` del prepare es una de las proveniencias no-reales
//    conocidas (allowlist en `smoke-helpers.ts`): real, desconocida o ausente ABORTAN (ver ahí).
//  - REUSA los building-blocks del repo (CD-7): `escrowIdl` (copia pinneada) + el patrón de construcción
//    de la ix `deposit` de `solana-wallet.ts`. NO reimplementa el discriminator ni "miente" el shape.
//  - Runtime `tsx` (`npm run smoke:solana`). Typecheck aislado vía `tsconfig.scripts.json`. NO se ejecuta
//    en F3: sólo typechea/lintea. Sus piezas puras viven en `smoke-helpers.ts` y SÍ tienen tests.
import bs58 from "bs58";
import nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha256";
import {
  clusterApiUrl,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import type { Idl, Provider } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildSponsorPopMessage } from "../src/infrastructure/auth/sponsor-pop-message";
import {
  resolveSolanaComputeUnitLimit,
  resolveSolanaComputeUnitPriceMicroLamports,
  resolveSolanaNetworkId,
} from "../src/infrastructure/chain";
import { escrowIdl } from "../src/infrastructure/solana/escrow-idl";
import { CUSTODY_WINDOW_SECS } from "../src/infrastructure/solana-wallet";
import {
  classifyPayoutProvenance,
  computeReleaseAttestation,
  isBase58Signature,
  parseNumericEnv,
  resolveAnchorBn,
  usdToUsdcMinorUnits,
} from "./smoke-helpers";

const CLUSTER = "devnet" as const; // CD-6: SOLO devnet, jamás mainnet-beta.

// ── Gate opt-in (AC-6), PRIMER statement, ANTES de cualquier fetch de dinero ──────────────────────
if (process.env.SMOKE_ALLOW_REAL !== "true") {
  console.error("SMOKE aborted: SMOKE_ALLOW_REAL !== 'true' (opt-in founder-gated, ver runbook paso 7)");
  process.exit(1);
}

// ── Validación fail-loud de las envs requeridas (AC-5/CD-4): nombre explícito, NUNCA el valor ──────
const REQUIRED_ENVS = [
  "SMOKE_CHASKI_URL", // base URL de chaski deployado (expone /api/payout/prepare + /api/settle/solana-sponsor)
  "SMOKE_FACILITATOR_URL", // base URL del wasiai-facilitator (healthcheck + POST /solana/escrow/release)
  "SMOKE_REMIT_URL", // base URL de wasiai-remittance-agents (healthcheck)
  "SMOKE_SENDER_SECRET_KEY", // keypair devnet base58 del sender que firma el deposit (SECRETO, nunca se imprime)
  "SMOKE_KYC_VERIFICATION_ID", // verificationId de Didit (lo VERIFICA el prepare server-side, ver checkpoint 3)
  "SMOKE_REMITTANCE_ID", // id de la remesa (ata la PDA escrow_state + la atestación)
  "SMOKE_QUOTE_ID", // id de la cotización
  "SMOKE_AMOUNT_USD", // monto en USD (se convierte a minor units USDC de 6 decimales)
  "SMOKE_SOLANA_USDC_MINT", // mint USDC devnet (base58), necesario para construir la ix `deposit`
  "SMOKE_SOLANA_FACILITATOR_PUBKEY", // pubkey devnet del facilitator (feePayer gasless), cofirma server-side
  "SMOKE_FACILITATOR_API_KEY", // Bearer del facilitator (== su FACILITATOR_API_KEY) para POST /solana/escrow/release
  "SMOKE_ESCROW_RELEASE_ATTESTATION_SECRET", // secreto del HMAC del release (== SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET)
] as const;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (typeof v !== "string" || !v.trim()) {
    console.error(`SMOKE aborted: env requerida ausente: ${name}`); // NUNCA el valor (CD-4)
    process.exit(1);
  }
  return v;
}

/** Lee una env numérica con `parseNumericEnv` (testeado). Un valor no numérico ya NO se convierte en
 *  un NaN silencioso que revienta tres pasos después sin decir qué env estaba mal. */
function requireNumericEnv(
  name: string,
  raw: string | undefined,
  opts: { readonly integer?: boolean; readonly min?: number; readonly max?: number } = {},
): number {
  const r = parseNumericEnv(name, raw, opts);
  if (!r.ok) {
    console.error(`SMOKE aborted: ${r.reason}`); // el reason nombra la env y NUNCA su valor
    process.exit(1);
  }
  return r.value;
}

for (const name of REQUIRED_ENVS) requireEnv(name);

const CHASKI_URL = requireEnv("SMOKE_CHASKI_URL").replace(/\/$/, "");
const FACILITATOR_URL = requireEnv("SMOKE_FACILITATOR_URL").replace(/\/$/, "");
const REMIT_URL = requireEnv("SMOKE_REMIT_URL").replace(/\/$/, "");
const SENDER_SECRET_KEY = requireEnv("SMOKE_SENDER_SECRET_KEY");
const KYC_VERIFICATION_ID = requireEnv("SMOKE_KYC_VERIFICATION_ID");
const REMITTANCE_ID = requireEnv("SMOKE_REMITTANCE_ID");
const QUOTE_ID = requireEnv("SMOKE_QUOTE_ID");
// Monto en USD: numérico y > 0. Antes era un string que se pasaba por `Number()` sin chequear.
const AMOUNT_USD = requireNumericEnv("SMOKE_AMOUNT_USD", process.env.SMOKE_AMOUNT_USD, { min: 0.000001 });

// Config devnet-only (no-secreta). RPC/mint desde env con default devnet explícito (CD-6: nunca mainnet).
const RPC_URL = process.env.SMOKE_SOLANA_RPC_URL || clusterApiUrl(CLUSTER);
// El mint USDC devnet es necesario para construir la ix `deposit`. Se exige explícito (base58 devnet).
const USDC_MINT = requireEnv("SMOKE_SOLANA_USDC_MINT");
// Pubkey del facilitator (feePayer gasless). Se resuelve UPFRONT (antes de cualquier fetch con side-effect,
// p.ej. /api/payout/prepare que crea una orden de desembolso) para abortar fail-loud sin efectos.
const FACILITATOR_PUBKEY = requireEnv("SMOKE_SOLANA_FACILITATOR_PUBKEY");
// Bearer del facilitator (== FACILITATOR_API_KEY). SECRETO, nunca se imprime.
const FACILITATOR_API_KEY = requireEnv("SMOKE_FACILITATOR_API_KEY");
// Secreto del HMAC del release (== SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET del facilitator). SECRETO.
// Ver el checkpoint 7: tenerlo es EXACTAMENTE lo que hace que la atestación de este script no pruebe
// nada de la pata fiat.
const ESCROW_RELEASE_ATTESTATION_SECRET = requireEnv("SMOKE_ESCROW_RELEASE_ATTESTATION_SECRET");
// Rieles exteriores del deadline, tal como los exige el programa desplegado:
// `deadline >= now + MIN_CUSTODY_SECS` y `deadline <= now + MAX_CUSTODY_SECS`
// (`solana-programs/programs/escrow/src/lib.rs:121` y `:129`, `require!` en `:156` y `:160`).
// Escritos a mano y no importados A PROPÓSITO: viven en otro repo, y una copia que se pueda comparar
// contra el original es lo que permite notar que el original se movió.
const PROGRAM_MIN_CUSTODY_SECS = 3600;
const PROGRAM_MAX_CUSTODY_SECS = 86400;

// Ventana del deadline del escrow (i64 unix seconds). NO es secreto.
//
// El default era `3600`, o sea EXACTAMENTE el piso del programa, y con ese valor el depósito no podía
// entrar nunca: el `now` que el programa compara es el del VALIDADOR al ejecutar, no el del cliente al
// firmar, así que `now_cliente + 3600` ya está por debajo de `now_validador + 3600` apenas pasa un
// segundo, y la ix muere con `DeadlineTooSoon`. Es la misma carrera que el commit 8c8527b arregló en
// producción; el default del smoke se quedó atrás.
//
// Ahora el default ES el de producción (`CUSTODY_WINDOW_SECS`, 2 h), importado y no copiado, por el
// mismo motivo que las ix de ComputeBudget del checkpoint 4: un smoke que manda un valor distinto al
// de la DApp valida una transacción que la DApp no emite.
//
// El `min`/`max` no son decoración: sin ellos un override fuera de rango se descubre como un rechazo
// opaco del programa en el checkpoint 5, en vez de como un fail-loud local que nombra la env. Ojo:
// `min` es el piso del programa, y pedir exactamente el piso PIERDE la carrera de arriba — pasa la
// validación local y falla on-chain. Por eso el default está muy por encima.
const DEADLINE_SECONDS = requireNumericEnv(
  "SMOKE_DEADLINE_SECONDS",
  process.env.SMOKE_DEADLINE_SECONDS ?? String(CUSTODY_WINDOW_SECS),
  { integer: true, min: PROGRAM_MIN_CUSTODY_SECS, max: PROGRAM_MAX_CUSTODY_SECS },
);

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
/** Código de error opaco de una respuesta del facilitator (`{ error: { code } }`). No es secreto y
 *  es lo único útil para diagnosticar un rechazo. */
function errorCodeOf(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.error)) return "sin-codigo";
  return typeof body.error.code === "string" ? body.error.code : "sin-codigo";
}

/** [u8;16] DETERMINÍSTICO desde remittanceId: sha256(utf8(remittanceId))[:16], MISMA derivación que
 *  solana-wallet.ts:61 (reproducible server-side para re-derivar la PDA escrow_state). NUNCA Math.random. */
function remittanceIdToBytes16(remittanceId: string): Uint8Array {
  return Uint8Array.from(sha256(new TextEncoder().encode(remittanceId)).subarray(0, 16));
}

interface DecodedEscrowState {
  sender: PublicKey;
  beneficiary: PublicKey;
  authority: PublicKey;
  mint: PublicKey;
  amount: { toString(): string };
  deadline: { toString(): string };
  status: Record<string, unknown>;
}

/** Decodifica la cuenta EscrowState, o null si la cuenta todavía no existe. */
async function readEscrowState(
  connection: Connection,
  pda: PublicKey,
): Promise<DecodedEscrowState | null> {
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  const coder = new anchor.BorshAccountsCoder(escrowIdl as unknown as Idl);
  return coder.decode("EscrowState", info.data) as DecodedEscrowState;
}

function statusOf(state: DecodedEscrowState): string {
  return Object.keys(state.status)[0] ?? "desconocido";
}

/**
 * Balance del vault (ATA del PDA) en unidades menores, o `null` si NO SE PUDO LEER.
 *
 * `null` NO es cero. Son tres valores, no dos: "tiene X", "tiene 0" y "no pude preguntar". Colapsar
 * el tercero en "0" es exactamente cómo un smoke declara verde un vault que nunca miró.
 */
async function readVaultAmount(connection: Connection, vault: PublicKey): Promise<bigint | null> {
  try {
    const bal = await connection.getTokenAccountBalance(vault);
    return BigInt(bal.value.amount);
  } catch {
    return null;
  }
}

/**
 * LO QUE ESTE SMOKE PRUEBA Y LO QUE NO. Se imprime dos veces (antes del release y en el cierre) y a
 * propósito no se puede desactivar: si dentro de seis meses alguien lee esta salida, tiene que
 * entender qué quedó probado sin tener que leer el código.
 */
function printDisclaimerRelease(): void {
  console.log("============================================================");
  console.log("LEER ANTES DE INTERPRETAR EL RESULTADO DE ESTA CORRIDA");
  console.log("");
  console.log("1. LA ATESTACIÓN DEL RELEASE ES AUTO EMITIDA. La calcula este");
  console.log("   mismo script con el secreto compartido. En el diseño del");
  console.log("   sistema esa atestación certifica dos hechos: que el KYC se");
  console.log("   aprobó y que la orden fiat se completó. Este script no");
  console.log("   verificó ninguno de los dos: sólo demostró que tiene el");
  console.log("   secreto. LA PATA FIAT NO QUEDA VERIFICADA POR ESTA CORRIDA.");
  console.log("");
  console.log("2. NINGÚN COMPONENTE DE PRODUCCIÓN DISPARA ESTE PASO. No existe");
  console.log("   hoy, ni en chaski ni en el facilitator ni en los agentes,");
  console.log("   nada que decida llamar al release. En el sistema real ese");
  console.log("   release lo ejecuta una persona a mano, y acá lo está");
  console.log("   ejecutando el smoke: está sustituyendo a un actor AUSENTE.");
  console.log("");
  console.log("Lo que esta corrida prueba: que las piezas on-chain funcionan");
  console.log("cuando alguien las llama en orden.");
  console.log("Lo que NO prueba: que el sistema las llame solo, ni que se haya");
  console.log("pagado un centavo de fiat.");
  console.log("============================================================");
}

async function main(): Promise<void> {
  // ── Checkpoint 1: healthcheck de los 3 servicios ────────────────────────────────────────────────
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

  // ── Checkpoint 2: PoP (WKH-206/HU-SOL-8): challenge + firma ed25519 del sender ───────────────────
  //    DOS causas distintas, DOS reportes distintos: el fetch del challenge es un problema de RED y la
  //    firma es un problema de la CLAVE. Envolver las dos en un solo try/catch hacía que una secret key
  //    inválida se reportara como "challenge inalcanzable", y se buscaba el bug en el lugar equivocado.
  //
  //    Nota sobre el KYC: NO hay checkpoint local que valide `SMOKE_KYC_VERIFICATION_ID`. `requireEnv`
  //    ya garantizó que no está vacía, y nada más se puede afirmar desde acá: quien la verifica de
  //    verdad es el prepare server-side (guard PR5, `resolvePayoutAuthority` contra Didit), y un id
  //    inválido muere ahí con 400/403. Un checkpoint local sería un OK regalado.
  let sender: Keypair;
  try {
    sender = Keypair.fromSecretKey(bs58.decode(SENDER_SECRET_KEY)); // SECRETO, nunca se imprime
  } catch {
    return fail(2, "SMOKE_SENDER_SECRET_KEY no es una keypair base58 válida (no es un problema de red)");
  }
  const senderAddr = sender.publicKey.toBase58();
  const idempotencyKey = `${REMITTANCE_ID}:${QUOTE_ID}`;

  // 2a. challenge: falla de RED / servicio.
  let chRes: Response;
  try {
    chRes = await fetch(`${CHASKI_URL}/api/a2a/payout/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: senderAddr }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return fail(2, `PoP challenge inalcanzable (red): ${e instanceof Error ? e.name : "error"}`);
  }
  if (!chRes.ok) return fail(2, `PoP challenge no-2xx (${chRes.status})`);
  const chBody: unknown = await chRes.json().catch(() => null);
  if (
    !isRecord(chBody) ||
    typeof chBody.popChallenge !== "string" ||
    typeof chBody.popMessage !== "string"
  ) {
    return fail(2, "PoP challenge shape inválido (popChallenge/popMessage)");
  }
  const popChallenge = chBody.popChallenge;
  const popMessage = chBody.popMessage;

  // 2b. firma: falla LOCAL de cripto (la clave), nunca de red.
  let popSignature: string;
  try {
    const sig = nacl.sign.detached(new TextEncoder().encode(popMessage), sender.secretKey);
    popSignature = bs58.encode(sig); // firma ed25519 base58, verbatim al verificador (pop-verify-solana)
  } catch (e) {
    return fail(
      2,
      `no se pudo firmar el PoP con la keypair del sender (problema de CLAVE, no de red): ${e instanceof Error ? e.name : "error"}`,
    );
  }
  ok(2, "PoP challenge obtenido y firmado (ed25519)");

  // ── Checkpoint 3: POST /api/payout/prepare → shape-check INLINE del 200 Solana (CD-7: NO importa
  //    isValidSolanaPrepareShape del gateway cerrado) + LECTURA DE LA PROVENANCE ────────────────────
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
        amountUsd: AMOUNT_USD,
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
  const { beneficiary, authority, payoutId, provenance } = prepareBody;
  // `attestation` es la atestación del DEPÓSITO (distinta de la del release). Se valida su presencia
  // pero NO se liga a una variable ni se imprime: es un token HMAC.
  if (typeof prepareBody.attestation !== "string" || !prepareBody.attestation.trim()) {
    return fail(3, "prepare no devolvió attestation del depósito");
  }
  if (
    typeof beneficiary !== "string" || !beneficiary ||
    typeof authority !== "string" || !authority ||
    typeof payoutId !== "string" || !payoutId ||
    typeof provenance !== "string" || !provenance.trim()
  ) {
    return fail(3, "prepare shape Solana inválido (beneficiary/authority/attestation/payoutId/provenance)");
  }
  ok(3, "prepare devolvió shape Solana válido (base58)");

  // La PROVENANCE es el único dato del ciclo que dice algo sobre si la pata fiat es real o mock. No es
  // una advertencia al pasar: es parte del resultado, y se imprime como tal.
  //
  // El veredicto lo da `classifyPayoutProvenance` (smoke-helpers.ts, con tests), que compara contra la
  // MISMA allowlist que producción (`REAL_PAYOUT_PROVENANCES`, src/presentation/flow-vm.ts:26) y contra
  // la lista de proveniencias no-reales conocidas. Fail-closed: cualquier `kind` que no sea "no-real"
  // aborta, así que un valor nuevo o con otra capitalización corta la corrida en vez de colarse.
  //
  // ⚠️ Este guard llega TARDE y hay que decirlo: la orden de payout ya fue creada por el agente en el
  // prepare de arriba. Abortar acá no la impide; decide si la corrida sigue y si el operador se entera.
  console.log("------------------------------------------------------------");
  console.log(`>>> PATA FIAT: provenance del payout = "${provenance}"  (payoutId: ${payoutId})`);
  const provenanceVerdict = classifyPayoutProvenance(provenance);
  if (provenanceVerdict.kind !== "no-real") {
    return fail(
      3,
      `${provenanceVerdict.reason}. La orden ya fue creada del lado del agente (payoutId: ${payoutId}): revisala a mano`,
    );
  }
  console.log(`    ${provenanceVerdict.reason}.`);
  console.log("------------------------------------------------------------");

  // ── Checkpoint 4: construir + partial-firmar la ix `deposit` reusando escrowIdl (CD-7) ──────────
  const senderPk = sender.publicKey;
  const beneficiaryPk = new PublicKey(beneficiary);
  const authorityPk = new PublicKey(authority);
  const mintPk = new PublicKey(USDC_MINT);
  const programId = new PublicKey((escrowIdl as { address: string }).address); // DR5G…SE4x (CD-SDD-4)

  const remittanceIdBytes = remittanceIdToBytes16(REMITTANCE_ID); // [u8;16] determinístico
  const amountMinorUnits = usdToUsdcMinorUnits(AMOUNT_USD); // USDC 6 dec (helper testeado)
  // `anchor.BN` NO se puede usar directo: bajo `tsx` (Node ESM cargando el CJS de anchor 0.30.1) ese
  // export nombrado es `undefined` y el smoke moría acá con `TypeError: anchor.BN is not a
  // constructor`, sin pasar nunca del checkpoint 3. `resolveAnchorBn` mira las dos formas del módulo.
  const BN = resolveAnchorBn(anchor);
  const amount = new BN(amountMinorUnits.toString()); // u64
  const deadline = new BN(String(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS)); // i64

  const [escrowStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), senderPk.toBuffer(), Buffer.from(remittanceIdBytes)],
    programId,
  );
  const vault = getAssociatedTokenAddressSync(mintPk, escrowStatePda, /*allowOwnerOffCurve*/ true);
  const senderAta = getAssociatedTokenAddressSync(mintPk, senderPk);
  const reference = Keypair.generate().publicKey; // la privada se DESCARTA (nunca firma)

  const connection = new Connection(RPC_URL, "confirmed");
  // feePayer = pubkey del facilitator (gasless): su keypair PRIVADA cofirma en el sponsor server-side.
  // Resuelto/validado UPFRONT (módulo): acá sólo se parsea a PublicKey (sin fetch previo con side-effect).
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

  // ── ComputeBudget (WKH-321 / SDD 038) — la MISMA forma que emite producción ────────────────────
  // Los valores salen de los MISMOS resolvers que usa `solana-wallet.ts`, nunca de literales
  // copiados: si acá se duplicaran los números, el contract test cubriría un valor y el smoke
  // mandaría otro, que es el bug de fondo de esta HU en miniatura. Este script postea al MISMO
  // endpoint que producción (`POST /api/settle/solana-sponsor`), así que un smoke desalineado
  // validaría una transacción que la DApp ya no emite.
  const limitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: resolveSolanaComputeUnitLimit() });
  const priceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: resolveSolanaComputeUnitPriceMicroLamports(),
  });

  const { blockhash } = await connection.getLatestBlockhash();
  // CD-1: las dos van ANTES del partialSign de abajo. Agregar una ix después de firmar recompila el
  // mensaje y la firma del sender deja de validar (y arrastra al mensaje canónico de SDD 037).
  const tx = new Transaction().add(limitIx, priceIx, ix); // MISMA forma que solana-wallet.ts:305
  tx.feePayer = facilitatorPk; // el facilitator cofirma/paga el fee (gasless) en el sponsor
  tx.recentBlockhash = blockhash;
  tx.partialSign(sender); // partial-sign SÓLO con la wallet del sender (nunca broadcastea acá)
  const partialSignedTx = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");

  // ── SDD 037 — Guard B: el mensaje canónico que el facilitator va a reconstruir ────────────────
  // Se arma con el MISMO builder que usa la wallet en producción (CD-7: un solo lugar por repo).
  // La línea `tx` lleva la firma que `tx.partialSign(sender)` acaba de dejar puesta: eso ata esta
  // autorización a ESTA transacción y a ninguna otra.
  const senderTxSig = tx.signatures.find((s) => s.publicKey.equals(senderPk))?.signature;
  if (!senderTxSig) return fail(4, "la tx quedó sin la firma del sender (partialSign no firmó)");
  // Nombre distinto del `popMessage` del leg de payout (checkpoint 2) A PROPÓSITO: son dos
  // mecanismos con dominios de mensaje distintos, y confundirlos es exactamente lo que el separador
  // de dominio `WasiAI Sponsor Request v1` viene a impedir.
  const sponsorPopMessage = buildSponsorPopMessage({
    sender: senderAddr,
    networkId: resolveSolanaNetworkId(),
    remittanceId: REMITTANCE_ID,
    amountMinor: amountMinorUnits.toString(),
    mint: USDC_MINT,
    txSignatureB58: bs58.encode(new Uint8Array(senderTxSig)),
  });
  const sponsorPopSignature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(sponsorPopMessage), sender.secretKey),
  );

  ok(4, "ix deposit construida + partial-firmada por el sender (escrow escrowIdl) + mensaje canónico firmado");

  // ── Checkpoint 5: POST /api/settle/solana-sponsor (broadcast gasless vía facilitator) ───────────
  //    DEPENDE del checkpoint 3, y ahora de verdad: con el ledger encendido, el settle compara el
  //    beneficiary que va dentro de esta tx contra la deposit-address que el servidor registró al
  //    preparar ESTE remittanceId para ESTE sender (S3.5 de la route). Como el beneficiary sale del
  //    200 del checkpoint 3 y el sender es el mismo, coincide. Si alguien corre el 5 con un
  //    remittanceId que no pasó por el 3, la respuesta es 409 `solana_settle_beneficiary_unregistered`
  //    y NO es un fallo del facilitador.
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
        // SDD 037 — firma ed25519 REAL del mensaje canónico, con la MISMA keypair que firmó la tx.
        // Ya no hay ningún secreto compartido con el facilitator: lo que autoriza es la posesión de
        // la billetera, y este smoke la tiene de verdad. Si esto diera 403, la hipótesis #1 es que
        // los builders de los dos repos difieren en un byte, no que el facilitator esté roto.
        popSignature: sponsorPopSignature,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return fail(5, `sponsor inalcanzable: ${e instanceof Error ? e.name : "error"}`);
  }
  if (!sponsorRes.ok) return fail(5, `sponsor no-2xx (${sponsorRes.status})`);
  const sponsorBody: unknown = await sponsorRes.json().catch(() => null);
  const signature = isRecord(sponsorBody) ? sponsorBody.signature : undefined;
  // Base58 de verdad, el MISMO validador que aplica el proxy (solana-sponsor/route.ts:102). Un
  // `typeof === "string"` dejaba pasar cualquier string no vacío, incluido un mensaje de error.
  if (!isBase58Signature(signature)) {
    return fail(5, "sponsor no devolvió una signature base58 válida");
  }
  ok(5, "deposit broadcasteado (gasless), signature base58 válida");

  // ── Checkpoint 6: verify vault de verdad: status Deposited + BALANCE del vault + beneficiary ────
  //    El nombre del checkpoint decía "verify vault" y el código sólo decodificaba el enum `status`.
  //    Un escrow con status Deposited y el vault en cero pasaba. Ahora se comprueban las tres cosas
  //    que hacen que el depósito signifique algo: el estado, el DINERO y a quién está prometido.
  let state: DecodedEscrowState | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const s = await readEscrowState(connection, escrowStatePda);
    if (s && statusOf(s) === "Deposited") {
      state = s;
      break;
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  if (!state) return fail(6, "el escrow no alcanzó status Deposited en la ventana");
  if (state.beneficiary.toBase58() !== beneficiary) {
    return fail(6, "el beneficiary on-chain NO es el que atestó el prepare");
  }
  if (state.authority.toBase58() !== authority) {
    return fail(6, "la authority on-chain NO es la que atestó el prepare");
  }
  if (state.mint.toBase58() !== USDC_MINT) {
    return fail(6, "el mint on-chain NO es el de SMOKE_SOLANA_USDC_MINT");
  }
  if (BigInt(state.amount.toString()) !== amountMinorUnits) {
    return fail(6, "el amount del escrow NO coincide con el monto que se depositó");
  }
  const vaultAfterDeposit = await readVaultAmount(connection, vault);
  if (vaultAfterDeposit === null) {
    return fail(6, "no se pudo LEER el vault: el monto queda DESCONOCIDO (que no es lo mismo que cero)");
  }
  if (vaultAfterDeposit !== amountMinorUnits) {
    return fail(
      6,
      `el vault NO tiene el monto depositado (tiene ${vaultAfterDeposit}, se esperaban ${amountMinorUnits} unidades menores)`,
    );
  }
  ok(
    6,
    `escrow Deposited con ${vaultAfterDeposit} unidades menores en el vault y beneficiary == el atestado`,
  );

  // ── M5 EVIDENCE ── recién ACÁ, después de que el checkpoint 6 respaldó el depósito. Antes este
  //    bloque se imprimía ANTES del 6: si el 6 fallaba, el link de éxito ya había salido por pantalla.
  const explorerUrl = `https://explorer.solana.com/tx/${signature}?cluster=${CLUSTER}`;
  console.log("\n============================================================");
  console.log(">>> M5 (evidencia): TX del deposit no-custodial, verificable en Solana Explorer:");
  console.log(`    ${explorerUrl}`);
  console.log(`    escrowState PDA: ${escrowStatePda.toBase58()}`);
  console.log(`    vault ATA:       ${vault.toBase58()}`);
  console.log("============================================================\n");

  // ── Checkpoint 7: RELEASE real contra el facilitator ────────────────────────────────────────────
  //    Antes este paso posteaba a `${CHASKI_URL}/api/a2a/payout/submit`, una ruta BORRADA por WKH-320
  //    (su ausencia está asertada en src/composition/no-evm-surface.test.ts:124). Siempre 404, siempre
  //    WARN: un paso que no podía pasar nunca, disfrazado de best-effort.
  //
  //    Quien ejecuta el release es el facilitator, que es el que tiene la llave de la release-authority:
  //    POST {FACILITATOR_URL}/solana/escrow/release, auth `Authorization: Bearer <FACILITATOR_API_KEY>`,
  //    body { remittanceId, sender, attestation }. El beneficiario NO viaja en el body: el facilitator
  //    lo lee del EscrowState on-chain.
  //
  //    ⚠️ LAS DOS COSAS QUE ESTE PASO NO PRUEBA, y que `printDisclaimerRelease()` grita por pantalla:
  //
  //    (1) La atestación es AUTO EMITIDA. En el diseño, ese HMAC es el certificado de que el KYC se
  //        aprobó y la orden fiat se completó; el facilitator firma porque confía en que quien lo emitió
  //        verificó esas dos cosas. Este script no verificó ninguna: sólo tiene el secreto. La pata
  //        on-chain queda probada, la pata FIAT NO queda probada en absoluto. Es aceptable porque el
  //        alcance declarado es devnet y la pata fiat está fuera de alcance, pero no se disimula.
  //
  //    (2) Ningún componente de producción dispara este paso. No existe hoy, en ninguno de los tres
  //        repos, un componente que decida llamar al release: chaski no lo llama (cero referencias a
  //        `escrow/release` en el repo), los agentes no lo llaman, y el facilitator sólo responde. Hoy
  //        ese release lo ejecuta una PERSONA a mano. Este smoke está sustituyendo a ese actor ausente,
  //        no ejercitando un camino que corre solo. La lectura peligrosa que hay que evitar es "el
  //        smoke cierra el ciclo, entonces el producto cierra el ciclo": el producto NO lo cierra.
  printDisclaimerRelease();
  const releaseAttestation = computeReleaseAttestation(
    REMITTANCE_ID,
    senderAddr,
    ESCROW_RELEASE_ATTESTATION_SECRET,
  );
  let releaseRes: Response;
  try {
    releaseRes = await fetch(`${FACILITATOR_URL}/solana/escrow/release`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${FACILITATOR_API_KEY}`, // el facilitator NO lee X-API-Key
      },
      body: JSON.stringify({
        remittanceId: REMITTANCE_ID,
        sender: senderAddr,
        attestation: releaseAttestation, // NUNCA se imprime
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return fail(7, `release inalcanzable: ${e instanceof Error ? e.name : "error"}`);
  }
  const releaseBody: unknown = await releaseRes.json().catch(() => null);
  if (!releaseRes.ok) {
    return fail(7, `release no-2xx (${releaseRes.status}, code=${errorCodeOf(releaseBody)})`);
  }
  const releaseSignature = isRecord(releaseBody) ? releaseBody.signature : undefined;
  if (!isBase58Signature(releaseSignature)) {
    return fail(7, "el release respondió 2xx pero sin una signature base58 válida");
  }
  ok(7, "release aceptado por el facilitator (atestación AUTO EMITIDA: la pata fiat NO está verificada)");

  // ── Checkpoint 8: el efecto del release, leído de la cadena ─────────────────────────────────────
  //    Un 2xx del paso 7 dice que el facilitator aceptó y broadcasteó, NO que el escrow quedó liberado.
  //    Este checkpoint es el que convierte el 2xx en evidencia: el status tiene que ser Released y el
  //    vault tiene que quedar en CERO. Sin esto, el paso 7 repetiría el error que este arreglo vino a
  //    corregir (dar por bueno un resultado que nadie miró).
  let released: DecodedEscrowState | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const s = await readEscrowState(connection, escrowStatePda);
    if (s && statusOf(s) === "Released") {
      released = s;
      break;
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  if (!released) return fail(8, "el escrow no alcanzó status Released en la ventana");
  const vaultAfterRelease = await readVaultAmount(connection, vault);
  if (vaultAfterRelease === null) {
    return fail(8, "no se pudo LEER el vault después del release: queda DESCONOCIDO (no es cero)");
  }
  if (vaultAfterRelease !== 0n) {
    return fail(8, `el vault NO quedó en cero después del release (tiene ${vaultAfterRelease})`);
  }
  ok(8, "escrow Released y vault en cero, leído de la cadena");

  // ── Checkpoint 9: evidencia final ───────────────────────────────────────────────────────────────
  const releaseExplorerUrl = `https://explorer.solana.com/tx/${releaseSignature}?cluster=${CLUSTER}`;
  console.log("\n============================================================");
  console.log(">>> CICLO ON-CHAIN COMPLETO (devnet)");
  console.log(`    deposit:  ${explorerUrl}`);
  console.log(`    release:  ${releaseExplorerUrl}`);
  console.log(`    escrowState PDA: ${escrowStatePda.toBase58()}`);
  console.log(`    vault ATA:       ${vault.toBase58()}`);
  console.log(`    remittanceId: ${REMITTANCE_ID}  (GUARDALO: no se recupera de la cadena)`);
  console.log(`    provenance del payout: "${provenance}" (mock, no es un desembolso real)`);
  console.log("============================================================");
  printDisclaimerRelease();
  ok(9, "ciclo on-chain devnet cerrado (deposit, vault, release). Pata fiat: FUERA DE ALCANCE, no verificada");
}

/**
 * Marcos de pila del error, recortados a los que apuntan a ESTE repo.
 *
 * Por qué esto y no `e.message`: CD-4 prohíbe imprimir valores, y el mensaje de una excepción de
 * librería puede arrastrar el dato que la causó (una clave mal decodificada, por ejemplo). Un marco
 * de pila es `función (archivo:línea:columna)`: nombra el LUGAR y nunca un valor.
 *
 * Por qué hacía falta: la única salida ante un error inesperado era `SMOKE aborted (unexpected):
 * TypeError`. Eso no nombra ni el archivo ni la línea ni el checkpoint, y es parte de por qué el fallo
 * del checkpoint 4 sobrevivió sin diagnosticar.
 */
function ownStackFrames(e: unknown, max = 3): string[] {
  if (!(e instanceof Error) || typeof e.stack !== "string") return [];
  return e.stack
    .split("\n")
    .filter((l) => l.trimStart().startsWith("at "))
    .filter((l) => l.includes("/scripts/") || l.includes("/src/"))
    .slice(0, max)
    .map((l) => l.trim());
}

main().catch((e) => {
  console.error(`SMOKE aborted (unexpected): ${e instanceof Error ? e.name : "error"}`);
  const frames = ownStackFrames(e);
  if (frames.length === 0) {
    console.error("  (sin marcos de pila propios; el mensaje se omite a propósito, ver CD-4)");
  }
  for (const f of frames) console.error(`  ${f}`);
  process.exit(1);
});
