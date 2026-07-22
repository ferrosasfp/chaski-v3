// Server-side: PREPARE del payout no-custodial (WKH-211, AC-1/AC-7). Crea la orden TransFi (invoca al
// agente remit-cashout-payout) y emite la DepositAttestation HMAC que ata el depositAddress a ESTA
// remesa ANTES de que el cliente firme (Opción B, DT-1). El cliente firma `to = depositAddress`; el
// guard de /api/settle/principal re-verifica la atestación (B1-B6) y usa expectedTo = depositAddress.
//
// Compone challenge/route.ts (emisor HMAC) + submit/route.ts (guards autoridad WKH-202 + PoP WKH-206).
// Guard-order fail-closed (envs leídas en runtime, CD-14): 501-BASE → 503-secreto → rate-limit →
// formato → autoridad → PoP → forward → shape+depositAddress → attest → ledger → 200.
//
// TODO defensivo: NUNCA 500 crudo; errores = enums opacos, PII-free; NUNCA ecoa BASE ni el beneficiary
// (CD-5). REMIT_AGENTS_BASE_URL vive SOLO acá (server-only, SIN NEXT_PUBLIC_). El depositAddress real
// (no-null) exige el agente con TRANSFI_ADAPTER_READY=true (cross-repo WKH-212); el mock devuelve null
// → PR8 fail-closed (nunca se atesta sin address confirmada).
import { NextResponse } from "next/server";
import { isAddress, verifyMessage } from "viem";
import {
  buildPopMessage,
  verifyPopChallenge,
  buildSolanaPopMessage,
  verifySolanaPopChallenge,
} from "../../../../src/infrastructure/auth/pop-challenge";
import { verifySolanaPop } from "../../../../src/infrastructure/auth/pop-verify-solana";
import {
  resolveChainId,
  resolveActiveVm,
  resolveSolanaNetworkId,
} from "../../../../src/infrastructure/chain";
import { canonicalizeAddress } from "../../../../src/infrastructure/address";
import { getSettlementLedger } from "../../../../src/infrastructure/persistence/supabase-settlement-ledger";
import { resolvePayoutAuthority } from "../../../../src/infrastructure/payout/authority";
import {
  DEPOSIT_ATTESTATION_TTL_SECONDS,
  issueDepositAttestation,
} from "../../../../src/infrastructure/settlement/deposit-attestation";
import {
  DEPOSIT_PREPARE_RL,
  checkRouteRateLimit,
  clientIp,
} from "../../../../src/infrastructure/rate-limit";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v); // excluye arrays
}

// Shape mínimo del result del agente (mirror del isValidPayoutResult de submit/route.ts). El
// depositAddress se valida aparte en PR8 (exige string no-vacío + isAddress).
function isValidPayoutResult(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const statusOk =
    v.status === "submitted" || v.status === "settled" || v.status === "failed" || v.status === "blocked";
  if (!statusOk) return false;
  if (!(typeof v.payoutId === "string" || v.payoutId === null)) return false;
  if (!(typeof v.deliveredLocal === "number" || v.deliveredLocal === null)) return false;
  if (!(typeof v.txRef === "string" || v.txRef === null)) return false;
  if (!(typeof v.reason === "string" || v.reason === null)) return false;
  if (v.payoutId === null && v.status !== "failed" && v.status !== "blocked") return false;
  return true;
}

export async function POST(req: Request): Promise<Response> {
  // PR1 — sin backend del agente no hay orden que crear. PRIMERO (intacto respecto de submit:66).
  const BASE = process.env.REMIT_AGENTS_BASE_URL; // server-only (CD-9), leído en runtime
  if (!BASE) return NextResponse.json({ error: "prepare_not_configured" }, { status: 501 });

  // PR2 — prepare SOLO existe en el path real: sin el secreto NO puede atestar → 503 fail-closed (NUNCA
  // fail-open). Diferencia DELIBERADA con el submit (que skipea local sin secreto): el demo nunca llama
  // a prepare con los flags OFF (no se cablea) ⇒ AC-5 intacto.
  if (!process.env.DEPOSIT_ATTESTATION_SECRET) {
    return NextResponse.json({ error: "prepare_unavailable" }, { status: 503 });
  }

  // PR3 — rate-limit IP-only, TRAS PR2 y ANTES de parsear/forwardear. Cada prepare crea una orden real
  // → sin esto, spam = órdenes huérfanas masivas (DT-5). IP-only (el body aún no se parsea).
  const rl = await checkRouteRateLimit(DEPOSIT_PREPARE_RL, { ip: clientIp(req) });
  if (rl.unavailable) {
    return NextResponse.json({ error: "prepare_rate_limit_unavailable" }, { status: 503 }); // fail-closed
  }
  if (!rl.ok) {
    return NextResponse.json(
      { error: "prepare_rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } },
    );
  }

  // PR4 — body null-safe (CD-9: req.json() RESUELVE `null` con el body literal `null` → el .catch NO
  // dispara; isRecord cubre null y los no-objeto). Formato: sin evidencia parseable, NINGÚN fetch.
  const parsed: unknown = await req.json().catch(() => null);
  const body: Record<string, unknown> = isRecord(parsed) ? parsed : {};
  const remittanceId = typeof body.remittanceId === "string" ? body.remittanceId : "";
  const quoteId = typeof body.quoteId === "string" ? body.quoteId : "";
  const kycVerificationId = typeof body.kycVerificationId === "string" ? body.kycVerificationId : "";
  const address = typeof body.address === "string" ? body.address : "";
  // HU-SOL-9: validación de `address` VM-discriminada. evm → isAddress (byte-idéntico). solana →
  // canonicalizeAddress base58 (throwea con malformado → try/catch → false, mismo 400 opaco, CD-2).
  let addressOk: boolean;
  if (resolveActiveVm() === "solana") {
    try {
      canonicalizeAddress(address, "solana");
      addressOk = true;
    } catch {
      addressOk = false;
    }
  } else {
    addressOk = isAddress(address);
  }
  if (!remittanceId.trim() || !quoteId.trim() || !kycVerificationId.trim() || !addressOk) {
    return NextResponse.json({ error: "prepare_invalid_request" }, { status: 400 });
  }

  // PR5 — autoridad server-side (WKH-202): re-consulta la decisión REAL de Didit. Nunca confía en los
  // booleanos del caller. Mismo switch fail-closed que submit (98-116).
  const d = await resolvePayoutAuthority({ verificationId: kycVerificationId, address });
  if (d.reason === "simulated_dev" && (process.env.VERCEL_ENV ?? "") !== "") {
    return NextResponse.json({ error: "payout_authority_unavailable" }, { status: 503 });
  }
  if (!d.authorized) {
    switch (d.reason) {
      case "invalid_verification_id":
        return NextResponse.json({ error: "prepare_invalid_request" }, { status: 400 });
      case "kyc_not_approved":
      case "kyc_ownership_mismatch":
        // CD-12 no-oracle: MISMO código para ambos (no ser un oráculo del estado KYC ajeno).
        return NextResponse.json({ error: "payout_not_authorized" }, { status: 403 });
      case "kyc_authority_unavailable":
        return NextResponse.json({ error: "payout_authority_unavailable" }, { status: 503 });
      default:
        // fail-closed: reason ausente/desconocido → RECHAZA (nunca forward).
        return NextResponse.json({ error: "payout_authority_unavailable" }, { status: 502 });
    }
  }

  // PR6 — proof-of-possession (WKH-206). OPT-IN: sin PAYOUT_POP_SECRET, SKIP total. Cualquier fallo
  // cripto → 403 opaco. NO claim-once (P6): el nonce se quema recién en submit/tracking; acá stateless
  // (no quemar el nonce ANTES de la firma real).
  // HU-SOL-8/CD-2: dispatch por VM. En Solana el PoP es OBLIGATORIO (fail-closed 503 sin secreto), SIN
  // claim-once (el nonce se quema recién en submit); en EVM el bloque WKH-206 queda byte-idéntico en el
  // `else if (POP_SECRET)` (opt-in, AC-8).
  const vm = resolveActiveVm();
  const POP_SECRET = process.env.PAYOUT_POP_SECRET; // CD-14: dentro del handler
  if (vm === "solana") {
    // CD-2 / AC-3: OBLIGATORIO. Sin secreto → 503 fail-closed (NUNCA skip).
    if (!POP_SECRET) {
      return NextResponse.json({ error: "payout_pop_unavailable" }, { status: 503 });
    }
    const popChallenge = body.popChallenge;
    const popSignature = body.popSignature;
    // P1 — presencia + tipo → 403 opaco.
    if (
      typeof popChallenge !== "string" ||
      !popChallenge.trim() ||
      typeof popSignature !== "string" ||
      !popSignature.trim()
    ) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
    // P2 — HMAC + exp + tipos colapsan en null → 403 opaco.
    const ch = verifySolanaPopChallenge(popChallenge, Date.now());
    if (!ch) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
    // P3 — address match (CD-8, base58 case-sensitive). canonicalizeAddress throwea → try/catch → 403.
    try {
      if (canonicalizeAddress(ch.address, "solana") !== canonicalizeAddress(address, "solana")) {
        return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
    // P4 — CAIP-2 binding (AC-4/CD-3): network-id del token vs el resuelto server-side, NUNCA del body.
    if (ch.networkId !== resolveSolanaNetworkId()) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
    // P5 — ed25519 (AC-1/AC-2): mensaje reconstruido con la MISMA buildSolanaPopMessage (CD-6). SIN P6
    // claim-once (el nonce se quema recién en submit).
    if (
      !verifySolanaPop({
        addressBase58: ch.address,
        message: buildSolanaPopMessage(ch),
        signatureBase58: popSignature,
      })
    ) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
  } else if (POP_SECRET) {
    const popChallenge = body.popChallenge;
    const popSignature = body.popSignature;
    if (
      typeof popChallenge !== "string" ||
      !popChallenge.trim() ||
      typeof popSignature !== "string" ||
      !popSignature.trim()
    ) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
    const ch = verifyPopChallenge(popChallenge, Date.now());
    if (!ch) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
    if (canonicalizeAddress(ch.address, resolveActiveVm()) !== canonicalizeAddress(address, resolveActiveVm())) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
    if (ch.chainId !== resolveChainId()) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
    let ok = false;
    try {
      ok = await verifyMessage({
        address: ch.address as `0x${string}`,
        message: buildPopMessage(ch),
        signature: popSignature as `0x${string}`,
      });
    } catch {
      ok = false;
    }
    if (!ok) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
  }

  // PR7 — forward al agente (crea la orden TransFi). idempotencyKey intacto (CD-10). Todo en try/catch:
  // timeout/DNS/parse → 502 opaco, NUNCA 500 crudo, NUNCA ecoa el beneficiary.
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/agents/remit-cashout-payout/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body), // idempotencyKey/beneficiary forwardeados tal cual (CD-10/CD-5)
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return NextResponse.json({ error: "prepare_upstream_error" }, { status: 502 });
  }
  if (!res.ok) {
    return NextResponse.json({ error: "prepare_upstream_error" }, { status: 502 });
  }

  let result: unknown;
  try {
    const json = (await res.json()) as { result?: unknown };
    result = json.result;
  } catch {
    return NextResponse.json({ error: "prepare_upstream_error" }, { status: 502 });
  }

  // PR8 — valida el shape + EXIGE depositAddress string no-vacío + isAddress. El mock del agente
  // devuelve depositAddress:null → AQUÍ muere (AC-7 fail-closed): NUNCA se atesta sin address confirmada.
  if (!isValidPayoutResult(result)) {
    return NextResponse.json({ error: "prepare_upstream_error" }, { status: 502 });
  }
  const okResult = result as { payoutId: string | null; provenance?: unknown; depositAddress?: unknown };
  const depositAddress = typeof okResult.depositAddress === "string" ? okResult.depositAddress : "";
  if (!depositAddress.trim() || !isAddress(depositAddress)) {
    return NextResponse.json({ error: "prepare_no_deposit_address" }, { status: 502 });
  }
  // payoutId: en un result válido con depositAddress real, la orden se creó ⇒ payoutId presente. Si
  // fuese null (shape borde), fail-closed: no atestamos una orden sin id trackeable.
  const payoutId = typeof okResult.payoutId === "string" ? okResult.payoutId : "";
  if (!payoutId.trim()) {
    return NextResponse.json({ error: "prepare_no_deposit_address" }, { status: 502 });
  }
  const provenance = typeof okResult.provenance === "string" ? okResult.provenance : "";

  // PR9 — emite la DepositAttestation. chainId de la ENV server-side (CD-9), NUNCA del body.
  const chainId = resolveChainId();
  const attestation = issueDepositAttestation({
    remittanceId,
    quoteId,
    depositAddress,
    chainId,
    exp: Math.floor(Date.now() / 1000) + DEPOSIT_ATTESTATION_TTL_SECONDS,
  });

  // PR10 — ledger best-effort flag-gated (patrón submit:273-294). NUNCA PII (CD-7/AC-8: solo
  // IDs/address/chainId). NUNCA rompe el money-path (CD-17).
  const ledger = getSettlementLedger();
  if (ledger) {
    try {
      await ledger.recordOrderPrepared({
        remittanceId,
        quoteId,
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : `${remittanceId}:${quoteId}`,
        depositAddress,
        chainId,
        senderAddress: address,
        payoutId,
        vm: resolveActiveVm(),
      });
    } catch (e) {
      console.error("[ledger] recordOrderPrepared_failed", e); // best-effort, NUNCA rompe (CD-17)
    }
  }

  // PR11 — 200. NUNCA BASE/PII/beneficiary; sólo hechos operativos.
  return NextResponse.json({ depositAddress, attestation, payoutId, provenance }, { status: 200 });
}
