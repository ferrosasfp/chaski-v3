// Server-side: PREPARE del payout no-custodial (WKH-211 / HU-SOL-11, AC-1/AC-7). Crea la orden TransFi
// (invoca al agente remit-cashout-payout) y emite la SolanaDepositAttestation HMAC que ata el
// beneficiary (deposit-address) y la release-authority a ESTA remesa ANTES de que el cliente firme
// (Opción B, DT-1). La wallet arma la ix `deposit` del escrow contra ese beneficiary atestado.
//
// Compone challenge/route.ts (emisor HMAC del PoP) + los guards de autoridad WKH-202 y PoP WKH-206.
// Guard-order fail-closed (envs leídas en runtime, CD-14): 501-BASE → 503-secreto → rate-limit →
// formato → autoridad → PoP → forward → shape+depositAddress → attest → ledger → 200.
//
// TODO defensivo: NUNCA 500 crudo; errores = enums opacos, PII-free; NUNCA ecoa BASE ni el beneficiary
// (CD-5). REMIT_AGENTS_BASE_URL vive SOLO acá (server-only, SIN NEXT_PUBLIC_). El depositAddress real
// (no-null) exige el agente con TRANSFI_ADAPTER_READY=true (cross-repo WKH-212); el mock devuelve null
// → PR8 fail-closed (nunca se atesta sin address confirmada).
import { NextResponse } from "next/server";
import {
  buildSolanaPopMessage,
  verifySolanaPopChallenge,
} from "../../../../src/infrastructure/auth/pop-challenge";
import { verifySolanaPop } from "../../../../src/infrastructure/auth/pop-verify-solana";
import {
  resolveSolanaNetworkId,
  resolveSolanaReleaseAuthorityPubkey,
  resolveSolanaNetworkConfig,
} from "../../../../src/infrastructure/chain";
import { canonicalizeAddress } from "../../../../src/infrastructure/address";
import {
  PAYOUT_CAPABILITY,
  PAYOUT_MIN_REPUTATION,
  logGatewayFailure,
  runViaGateway,
} from "../../../../src/infrastructure/a2a/gateway-client";
import {
  CHAIN_ID_NOT_APPLICABLE,
  getSettlementLedger,
} from "../../../../src/infrastructure/persistence/supabase-settlement-ledger";
import { logLedgerWriteFailure } from "../../../../src/infrastructure/persistence/ledger-write-failure";
import { resolvePayoutAuthority } from "../../../../src/infrastructure/payout/authority";
import {
  DEPOSIT_ATTESTATION_TTL_SECONDS,
  issueSolanaDepositAttestation,
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
// depositAddress se valida aparte en PR8 (exige string no-vacío + base58 canónico).
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
  // HU-SOL-9: `address` es base58. canonicalizeAddress throwea con malformado → try/catch → false →
  // el mismo 400 opaco (CD-2).
  let addressOk: boolean;
  try {
    canonicalizeAddress(address);
    addressOk = true;
  } catch {
    addressOk = false;
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

  // PR6 — proof-of-possession (WKH-206/HU-SOL-8). OBLIGATORIO: sin PAYOUT_POP_SECRET → 503 fail-closed
  // (NUNCA skip), nunca opt-in. Stateless a propósito: el nonce NO se quema en este repo, así que el
  // anti-replay del PoP dentro de su TTL (10 min, pop-challenge.ts) es responsabilidad del
  // facilitator, que es quien exige y verifica el popProof. Chaski NO tiene ese control.
  // Residual R-3: restituir el single-use acá = HU aparte.
  // Cualquier fallo cripto → 403 opaco (CD-4, no-oracle).
  const POP_SECRET = process.env.PAYOUT_POP_SECRET; // CD-14: dentro del handler
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
    if (canonicalizeAddress(ch.address) !== canonicalizeAddress(address)) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
  }
  // P4 — CAIP-2 binding (AC-4/CD-3): network-id del token vs el resuelto server-side, NUNCA del body.
  if (ch.networkId !== resolveSolanaNetworkId()) {
    return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
  }
  // P5 — ed25519 (AC-1/AC-2): mensaje reconstruido con la MISMA buildSolanaPopMessage (CD-6). SIN
  // claim-once del nonce: ver la nota de arriba (residual R-3).
  if (
    !verifySolanaPop({
      addressBase58: ch.address,
      message: buildSolanaPopMessage(ch),
      signatureBase58: popSignature,
    })
  ) {
    return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
  }

  // PR7 — forward al agente (crea la orden TransFi). Transporte según adapter (WKH-304, DT-3/CD-3).
  // El adapter se lee ACÁ y no antes: PR1-PR6 corren SIEMPRE e idénticos con el flag prendido o
  // apagado (CD-3) — el cambio de transporte no puede mover un solo guard de lugar.
  // Este es el ÚNICO leg del money-path que cambia de transporte: el `result` que sale de acá va al
  // MISMO PR8 (validador del depositAddress) y al MISMO PR9 (emisor de la atestación) que ya existían.
  // El transporte NO participa de ninguno de los dos (CD-10): el piso de reputación sube el piso, no
  // reemplaza esas dos capas, que son independientes de QUÉ agente respondió.
  let result: unknown;
  // QUIÉN dio el depositAddress. `undefined` = no lo sabemos (rama punto-a-punto: ahí el agente lo
  // fija la URL, no lo elige nadie). Viaja al 200 para que la remesa pueda decir de dónde salió la
  // dirección contra la que la persona firmó. NO participa de ningún guard.
  let resolvedAgent: Record<string, unknown> | undefined;
  if (process.env.NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER === "a2a-gateway") {
    const r = await runViaGateway({
      steps: [
        {
          capability: process.env.WASIAI_A2A_PAYOUT_CAPABILITY ?? PAYOUT_CAPABILITY,
          constraints: { min_reputation: PAYOUT_MIN_REPUTATION }, // CD-5: NUNCA omitir
          input: body, // ya es Record<string, unknown> (PR4); idempotencyKey/beneficiary tal cual
        },
      ],
    });
    if (!r.ok) {
      logGatewayFailure("payout-prepare", r);
      // CD-1: JAMÁS cae al fetch punto-a-punto de abajo. No hay orden, no hay atestación, no hay
      // ledger. Un fallback silencioso acá crearía la orden con OTRO agente y atestaría SU dirección.
      return NextResponse.json(
        { error: r.code === "not_configured" ? "prepare_not_configured" : "prepare_upstream_error" },
        { status: r.code === "not_configured" ? 501 : 502 },
      );
    }
    result = r.outputs[0];
    // El gateway SÍ dice a quién eligió (`steps[i].agent`); hasta acá se descartaba. Si no lo dijo
    // de forma legible queda undefined y la remesa lo va a decir así, sin rellenar.
    const chosen = r.agents[0];
    if (chosen) resolvedAgent = { ...chosen };
  } else {
    // ── rama punto-a-punto EXISTENTE, sin cambios de lógica (CD-15) ──
    // idempotencyKey intacto (CD-10). Todo en try/catch: timeout/DNS/parse → 502 opaco, NUNCA 500
    // crudo, NUNCA ecoa el beneficiary.
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

    try {
      const json = (await res.json()) as { result?: unknown };
      result = json.result;
    } catch {
      return NextResponse.json({ error: "prepare_upstream_error" }, { status: 502 });
    }
  }

  // PR8 — valida el shape + EXIGE depositAddress string no-vacío + base58 canónico. El mock del agente
  // devuelve depositAddress:null → AQUÍ muere (AC-7 fail-closed): NUNCA se atesta sin address confirmada.
  if (!isValidPayoutResult(result)) {
    return NextResponse.json({ error: "prepare_upstream_error" }, { status: 502 });
  }
  const okResult = result as { payoutId: string | null; provenance?: unknown; depositAddress?: unknown };
  const depositAddress = typeof okResult.depositAddress === "string" ? okResult.depositAddress : "";

  // PR8-PR11 — bloque de respuesta.
  // 1. beneficiary = MISMO depositAddress del agente (DT-1). Vacío → enum opaco.
  if (!depositAddress.trim()) {
    return NextResponse.json({ error: "prepare_no_deposit_address" }, { status: 502 });
  }
  // base58 válido (AC-3, no-oráculo: MISMO enum que el caso vacío, no distinguir motivo).
  try {
    canonicalizeAddress(depositAddress);
  } catch {
    return NextResponse.json({ error: "prepare_no_deposit_address" }, { status: 502 });
  }
  // 2. payoutId presente (fail-closed: no atestar una orden sin id trackeable).
  const payoutIdSol = typeof okResult.payoutId === "string" ? okResult.payoutId : "";
  if (!payoutIdSol.trim()) {
    return NextResponse.json({ error: "prepare_no_deposit_address" }, { status: 502 });
  }
  const provenanceSol = typeof okResult.provenance === "string" ? okResult.provenance : "";
  // 3. authority (DESPUÉS de validar beneficiary, DT-2). Ausente/malformada → 503 enum NUEVO opaco.
  let authoritySol: string;
  try {
    authoritySol = resolveSolanaReleaseAuthorityPubkey();
  } catch {
    return NextResponse.json({ error: "prepare_solana_authority_unavailable" }, { status: 503 });
  }
  // 4. cluster ("devnet").
  const clusterSol = resolveSolanaNetworkConfig().cluster;
  // 5. atestación Solana (beneficiary/authority/cluster; mismo TTL/secret).
  const attestationSol = issueSolanaDepositAttestation({
    remittanceId,
    quoteId,
    beneficiary: depositAddress,
    authority: authoritySol,
    cluster: clusterSol,
    exp: Math.floor(Date.now() / 1000) + DEPOSIT_ATTESTATION_TTL_SECONDS,
  });
  // 6. ledger best-effort (vm:"solana" es el discriminante; el ledger IGNORA el chainId en esta rama y
  //    escribe network_id CAIP-2 + chain_id NULL — ver vmNetworkColumns). NUNCA rompe (CD-17).
  const ledgerSol = getSettlementLedger();
  if (ledgerSol) {
    try {
      await ledgerSol.recordOrderPrepared({
        remittanceId,
        quoteId,
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : `${remittanceId}:${quoteId}`,
        depositAddress,
        chainId: CHAIN_ID_NOT_APPLICABLE, // no hay chainId numérico en Solana; vmNetworkColumns lo descarta
        senderAddress: address,
        payoutId: payoutIdSol,
        vm: "solana",
      });
    } catch (e) {
      // MISMO control de flujo (se traga la excepción, CD-17); cambia SOLO la señal: una violación de
      // integridad (SQLSTATE 23xxx = bug nuestro, la fila NO se escribió) grita en error+[ALERT], un
      // fallo de infra transitorio va a warn, y lo NO mapeado grita por default.
      logLedgerWriteFailure("recordOrderPrepared", e);
    }
  }
  // 7. 200 — matchea EXACTO isValidSolanaPrepareShape del gateway.
  return NextResponse.json(
    {
      beneficiary: depositAddress,
      authority: authoritySol,
      attestation: attestationSol,
      payoutId: payoutIdSol,
      provenance: provenanceSol,
      // Aditivo y opcional: el cliente lo lee aparte y su ausencia no invalida nada. NO va dentro
      // de la atestación a propósito: la atestación ata el DESTINO, y meterle un campo que no
      // participa del binding sólo agranda lo que hay que firmar sin proteger nada más.
      ...(resolvedAgent ? { agent: resolvedAgent } : {}),
    },
    { status: 200 },
  );
}
