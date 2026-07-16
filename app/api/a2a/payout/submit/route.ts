// Server-side: proxy al agente remit-cashout-payout (WKH-186). REMIT_AGENTS_BASE_URL vive SOLO acá
// (CD-9, SIN NEXT_PUBLIC_): nunca llega al cliente; la ruta sólo devuelve { result }. Forwarda el
// beneficiary al agente (necesario para el payout) pero NUNCA lo loguea ni lo ecoa en un error
// (CD-5). El idempotencyKey se forwarda TAL CUAL (CD-10, no regenerar). TODO en try/catch: nunca
// 500 crudo. El agente corre en PAYOUT_ALLOW_MOCK (no desembolsa real sin creds TransFi) — 2ª capa
// money-path fuera de esta HU.
//
// WKH-202 (ENFORCEMENT): esta route era un proxy POST PÚBLICO sin autorización. Ahora re-valida
// server-side contra Didit (KYC Approved + ownership del address vs vendor_data) vía la autoridad
// compartida con /api/payout/validate ANTES de forwardear. Guard-order fail-closed (CD-4/CD-13):
//   1. !BASE → 501 (PRIMERO, intacto — sin backend no hay nada que autorizar, CD-11/AC-3)
//   2-3. formato (kycVerificationId + address no-vacíos) → 400, NINGÚN fetch (AC-1)
//   4-6. autoridad → simulated_dev en Vercel → 503 (DT-5); !authorized → switch (default = 502)
//   7. forward (bloque intacto)
// La respuesta sólo lleva enums; NUNCA el reason de la autoridad (CD-12 no-oracle) ni PII (CD-5).
//
// WKH-168 (GATE G3): hasta esta HU, NADIE verificaba que el sender hubiera pagado el principal en
// USDC → un atacante con SU PROPIO KYC aprobado y SU PROPIA address pasaba todos los guards de
// arriba y pedía un payout por un monto ARBITRARIO (el AR de WKH-202 lo probó ejecutando). Ahora se
// exige una ATESTACIÓN de settlement (HMAC emitido por /api/settle/principal tras VERIFICAR el
// receipt on-chain) atada al monto y al pagador, y single-use (anti-replay):
//   8. atestación → A1 skip local / A2 503 en deploy / A3-A7″ 403 opaco / A8 409 / A9 503
// La atestación ata CUATRO cosas al payout: el MONTO (A6), el PAGADOR (A7), el QUOTE/tasa (A7′) y la
// CADENA (A7″: mata el replay cross-entorno si se reusa el SETTLE_ATTESTATION_SECRET).
// Va DESPUÉS de la autoridad (WKH-202) y ANTES del forward: los guards 1-6 quedan intactos (CD-11).
// Residual (NO lo cierra esta HU): kycPayoutAllowed sigue siendo un booleano del caller (WKH-203).
// Residual WKH-207: una atestación quemada + un forward fallido deja la remesa varada (sin
// reconciliación server-side).
import { NextResponse } from "next/server";
import { verifyMessage } from "viem";
import type { SettlementLedgerStatus } from "../../../../../src/application/ports";
import { Money } from "../../../../../src/domain/money";
import { getSettlementLedger } from "../../../../../src/infrastructure/persistence/supabase-settlement-ledger";
import { verifyPopChallenge, buildPopMessage } from "../../../../../src/infrastructure/auth/pop-challenge";
import { claimPopNonceOnce } from "../../../../../src/infrastructure/auth/pop-nonce-store";
import { resolveChainId } from "../../../../../src/infrastructure/chain";
import { resolvePayoutAuthority } from "../../../../../src/infrastructure/payout/authority";
import { verifySettlementAttestation } from "../../../../../src/infrastructure/settlement/attestation";
import { claimAttestationOnce } from "../../../../../src/infrastructure/settlement/attestation-store";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v); // MNR-5: excluye arrays
}

// Shape mínimo esperado del result del agente (validación defensiva, sin any).
function isValidPayoutResult(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const statusOk =
    v.status === "submitted" || v.status === "settled" || v.status === "failed" || v.status === "blocked";
  if (!statusOk) return false;
  if (!(typeof v.payoutId === "string" || v.payoutId === null)) return false;
  if (!(typeof v.deliveredLocal === "number" || v.deliveredLocal === null)) return false;
  if (!(typeof v.txRef === "string" || v.txRef === null)) return false;
  if (!(typeof v.reason === "string" || v.reason === null)) return false;
  // MNR-C: alineado con isValidPayoutShape del gateway (gateways.ts, la autoridad de shape). payoutId
  // null SOLO es válido cuando el payout no se ejecutó (failed/blocked); settled/submitted sin payoutId
  // → shape inválido (no podríamos trackear el payout). La route es tan estricta como el gateway.
  if (v.payoutId === null && v.status !== "failed" && v.status !== "blocked") return false;
  return true;
}

export async function POST(req: Request): Promise<Response> {
  const BASE = process.env.REMIT_AGENTS_BASE_URL; // server-only (CD-9), leído en runtime
  // CD-11/AC-3: PRIMER guard, antes de cualquier llamada a la autoridad. Sin backend configurado no
  // hay nada que autorizar y no se gasta una llamada a Didit para responder 501.
  if (!BASE) return NextResponse.json({ error: "a2a_not_configured" }, { status: 501 });
  // BLQ-BAJO-1: `req.json()` RESUELVE (no rechaza) con `null` cuando el body es el literal JSON
  // `null` → el `.catch()` NO dispara y leer un campo sobre `null` tiraba un TypeError ACÁ, fuera
  // del try (que abre recién en el forward) → 500 crudo. Viola AC-1 ("4xx") y el contrato de la
  // cabecera ("nunca 500 crudo"); `curl -d 'null'` lo disparaba. isRecord() (ya existente) cubre
  // null y los no-objeto por igual → todos caen en el guard de formato de abajo → 400.
  // El body se forwarda TAL CUAL más abajo: la normalización a {} NUNCA llega al forward porque
  // un body no-record no tiene kycVerificationId/address → 400 antes del fetch.
  const parsed: unknown = await req.json().catch(() => null);
  const body: Record<string, unknown> = isRecord(parsed) ? parsed : {};

  // Formato (AC-1): sin evidencia parseable no se llama a NINGÚN fetch (ni Didit ni el agente).
  const kycVerificationId =
    typeof body.kycVerificationId === "string" ? body.kycVerificationId : "";
  const address = typeof body.address === "string" ? body.address : "";
  if (!kycVerificationId.trim() || !address.trim()) {
    return NextResponse.json({ error: "payout_invalid_request" }, { status: 400 });
  }

  // Autoridad server-side compartida con /api/payout/validate (WKH-180/DT-1): re-consulta la
  // decisión REAL de Didit. Nunca confía en los booleanos del caller (kycPayoutAllowed — CD-15).
  const d = await resolvePayoutAuthority({ verificationId: kycVerificationId, address });

  // DT-5/AC-5: la simulación (sin DIDIT_API_KEY, no-prod) autoriza sin consultar a Didit. En
  // cualquier scope de Vercel (preview incluido) eso sería un fail-open real: preview con
  // REMIT_AGENTS_BASE_URL seteada y sin key desembolsaría por simulación. Fuera de Vercel
  // (VERCEL_ENV vacío = local/CI) la simulación SÍ se acepta: el demo local debe seguir andando.
  // Va ANTES del check de !d.authorized porque simulated_dev viene con authorized:true.
  if (d.reason === "simulated_dev" && (process.env.VERCEL_ENV ?? "") !== "") {
    return NextResponse.json({ error: "payout_authority_unavailable" }, { status: 503 });
  }

  if (!d.authorized) {
    switch (d.reason) {
      case "invalid_verification_id":
        // Inalcanzable hoy (el guard de formato ya validó no-vacío). Se mapea defensivamente.
        return NextResponse.json({ error: "payout_invalid_request" }, { status: 400 });
      case "kyc_not_approved":
      case "kyc_ownership_mismatch":
        // CD-12 (no-oracle): MISMO código para ambos. Un caller no autenticado NO debe poder usar
        // este endpoint como oráculo del estado KYC de un verificationId ajeno.
        return NextResponse.json({ error: "payout_not_authorized" }, { status: 403 });
      case "kyc_authority_unavailable":
        return NextResponse.json({ error: "payout_authority_unavailable" }, { status: 503 });
      default:
        // CD-13 fail-closed: kyc_reauth_failed, reason ausente, o un reason NUEVO/desconocido →
        // RECHAZA. Un reason que no conocemos JAMÁS cae en el forward (lección WKH-198: el NaN
        // fail-open).
        return NextResponse.json({ error: "payout_authority_unavailable" }, { status: 502 });
    }
  }

  // ── 7. Proof-of-Possession (WKH-206, AC-2/AC-3/AC-4/AC-6) ──────────────────────────────────────
  // Prueba criptográfica de que el caller controla la private key de `address`: firma un challenge
  // server-emitido (nonce single-use + exp + chainId). Defensa en profundidad OPT-IN: PAYOUT_POP_SECRET
  // ausente ⇒ SKIP TOTAL en TODO entorno (Vercel incluido, DT-4/AC-1) ⇒ submit byte-idéntico a pre-206.
  // Va DESPUÉS de la autoridad (WKH-202) y ANTES de la atestación (WKH-168): los guards 4-6 y 8 quedan
  // intactos (CD-5). Todo fallo cripto/stateless (P2/P3/P4/P5) → el MISMO 403 opaco (CD-4 no-oracle).
  const POP_SECRET = process.env.PAYOUT_POP_SECRET; // CD-14: dentro del handler
  if (POP_SECRET) {
    const popChallenge = body.popChallenge;
    const popSignature = body.popSignature;
    // P1 — presencia + tipo.
    if (
      typeof popChallenge !== "string" ||
      !popChallenge.trim() ||
      typeof popSignature !== "string" ||
      !popSignature.trim()
    ) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
    // P2 — HMAC + exp + tipos colapsan en null → mismo 403 opaco.
    const ch = verifyPopChallenge(popChallenge, Date.now());
    if (!ch) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
    // P3 — el challenge fue emitido para ESTA address (case-insensitive: el casing no es un mismatch).
    if (ch.address.toLowerCase() !== address.toLowerCase()) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
    // P4 — chainId binding (AC-6). Contra la ENV server-side (resolveChainId()), NUNCA un chainId del
    // body: un campo del caller sería el binding FALSO que este guard mata (CD-9).
    if (ch.chainId !== resolveChainId()) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
    // P5 — PRUEBA CRIPTOGRÁFICA: recuperar al firmante del mensaje reconstruido (buildPopMessage=SSOT,
    // CD-10). verifyMessage es async (cubre ERC-1271). Firma/address malformada → fail-closed.
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
    // P6 — single-use atómico, fail-CLOSED (mirror A8/A9). Va al FINAL: los rechazos stateless P1-P5
    // NUNCA queman el nonce.
    const claim = await claimPopNonceOnce(ch.nonce);
    if (!claim.ok) {
      if ("alreadyUsed" in claim) {
        return NextResponse.json({ error: "payout_pop_replayed" }, { status: 409 });
      }
      // Upstash caído/no configurado ⇒ 503 fail-CLOSED. NUNCA forwardea.
      return NextResponse.json({ error: "payout_pop_unavailable" }, { status: 503 });
    }
  }

  // ── 8. Atestación de settlement del principal (WKH-168, AC-10/AC-11) ───────────────────────────
  // ESTE es el gate G3: sin evidencia de que el USDC entró DE VERDAD, no hay payout. Todo error
  // devuelve el MISMO enum (CD-12 no-oracle): el endpoint no es un oráculo de por qué falló.
  const SETTLE_SECRET = process.env.SETTLE_ATTESTATION_SECRET; // CD-14: dentro del handler
  if (!SETTLE_SECRET) {
    // A2 — en un deploy de Vercel, sin secreto NO se puede verificar nada ⇒ 503. Nunca fail-open en
    // un entorno desplegado (mismo patrón que simulated_dev arriba).
    if ((process.env.VERCEL_ENV ?? "") !== "") {
      return NextResponse.json({ error: "payout_settlement_unavailable" }, { status: 503 });
    }
    // A1 — fuera de Vercel (local/CI) sin secreto: skip → el demo local sigue byte-idéntico (AC-5).
  } else {
    // A3 — atestación ausente/no-string/vacía.
    const token = body.settlementAttestation;
    if (typeof token !== "string" || !token.trim()) {
      return NextResponse.json({ error: "payout_principal_unverified" }, { status: 403 });
    }
    // A4/A5 — formato, HMAC (timing-safe) y expiración colapsan en null → mismo 403 opaco.
    const att = verifySettlementAttestation(token, Date.now());
    if (!att) {
      return NextResponse.json({ error: "payout_principal_unverified" }, { status: 403 });
    }
    // A6′ — body.amountUsd viene del caller HOSTIL y Money.of() TIRA con NaN/negativo/>MAX_SAFE_INTEGER.
    // Este bloque corre FUERA del try/catch del forward ⇒ sin este guard, `curl -d '{"amountUsd":"x"}'`
    // daría un 500 crudo (el bug WKH-202/BLQ-BAJO-1 repetido). Guard de tipo ANTES de Money.of, +
    // try/catch por el cap: SIEMPRE 403 opaco, NUNCA 500. PROHIBIDO Money.of(Number(body.amountUsd)).
    if (
      typeof body.amountUsd !== "number" ||
      !Number.isFinite(body.amountUsd) ||
      body.amountUsd <= 0
    ) {
      return NextResponse.json({ error: "payout_principal_unverified" }, { status: 403 });
    }
    let expectedMinor: number;
    try {
      expectedMinor = Money.of(body.amountUsd, "USDC").minor;
    } catch {
      return NextResponse.json({ error: "payout_principal_unverified" }, { status: 403 });
    }
    // A6 — mata el "monto arbitrario": el payout no puede exceder el USDC realmente recibido.
    if (expectedMinor !== att.valueMinor) {
      return NextResponse.json({ error: "payout_principal_unverified" }, { status: 403 });
    }
    // A7 — ata el pagador ON-CHAIN al address ya KYC-validado (WKH-202): no podés cobrar el payout
    // de un principal que pagó otro.
    if (att.from.toLowerCase() !== address.toLowerCase()) {
      return NextResponse.json({ error: "payout_principal_unverified" }, { status: 403 });
    }
    // A7′ — ata la TASA (AR/MNR-1). El quoteId viajaba FIRMADO en la atestación (attestation.ts:21)
    // y NADIE lo comparaba: A6 ataba el monto y A7 el pagador, pero el quoteId del body —el que se
    // forwardea al agente y con el que el partner liquida la TASA— podía ser OTRO. El AR lo probó
    // ejecutando: att.quoteId="cfx-1" + body.quoteId="cfx-OTRO-RATE" ⇒ 200 y forward. Pagar el
    // principal bajo un quote y cobrar bajo otro con mejor tasa para el mismo USD = SOBRE-ENTREGA.
    // (El AC-10 enumeraba solo 3 checks: es omisión del spec, no del enforcement.)
    // Igualdad EXACTA: el quoteId es un ID opaco del partner ⇒ NO se normaliza (a diferencia del
    // address en A7, donde el casing no es un mismatch real).
    // Sin guard de presencia aparte: att.quoteId es no-vacío por construcción (attestation.ts:91 lo
    // rechaza vacío) ⇒ un body.quoteId ausente/no-string colapsa a "" y NUNCA matchea → 403.
    const bodyQuoteId = typeof body.quoteId === "string" ? body.quoteId : "";
    if (bodyQuoteId !== att.quoteId) {
      return NextResponse.json({ error: "payout_principal_unverified" }, { status: 403 });
    }
    // A7″ — ata la CADENA (re-AR). El chainId viaja FIRMADO en la atestación (attestation.ts:17) y
    // NADIE lo comparaba. Dentro de UN deployment es inocuo: settle/principal:65 firma el mismo
    // resolveChainId() que lee esta route, y el caller no puede tocarlo (NEXT_PUBLIC_CHAIN_ID es una
    // env del DEPLOYMENT: no viaja en el body y esta route no lo lee de ahí).
    // El gatillo real NO es "el día que haya dos redes" (ese era el encuadre equivocado del hallazgo
    // original): es REUSAR SETTLE_ATTESTATION_SECRET entre entornos. Preview en Fuji + prod en
    // mainnet con el MISMO secreto ⇒ una atestación emitida en Fuji con USDC de FAUCET (gratis)
    // valida el HMAC en mainnet y ata monto (A6), pagador (A7) y quote (A7′) sin objeción ⇒ payout
    // REAL de $400 por $0. Pasa con UNA SOLA cadena ⇒ es un error de ops, no un ítem de roadmap.
    // CD-9: se compara contra la env SERVER-SIDE. PROHIBIDO un chainId del body: un campo del caller
    // sería exactamente el binding falso que este guard mata.
    // Sin try/catch: resolveChainId() no tira (chain.ts:9-13 hace fallback a 43114), a diferencia de
    // resolveReceiverAddress()/resolveUsdcAddress(), que son fail-loud.
    if (att.chainId !== resolveChainId()) {
      return NextResponse.json({ error: "payout_principal_unverified" }, { status: 403 });
    }
    // A8/A9 — single-use atómico. La atestación es un HMAC stateless ⇒ sin esto es REPLAYABLE.
    const claim = await claimAttestationOnce(att.txHash);
    if (!claim.ok) {
      if ("alreadyUsed" in claim) {
        return NextResponse.json({ error: "payout_already_settled" }, { status: 409 });
      }
      // A9 — Upstash caído/no configurado ⇒ 503 fail-CLOSED. NUNCA forwardea (un fail-open acá le
      // daría al atacante N payouts por un solo principal: tirá Upstash y replayá).
      return NextResponse.json({ error: "payout_settlement_unavailable" }, { status: 503 });
    }
  }
  // ── WKH-207: persistencia del outcome del forward (aditiva, best-effort, owner-scoped). ──────────
  // Flag-gated: getSettlementLedger() null con flag OFF/envs ausentes ⇒ SKIP TOTAL ⇒ response
  // byte-idéntico (AC-2/AC-10). NUNCA toca los guards 1-8 (CD-3) ni cambia la respuesta. En su propio
  // try/catch: la DB no rompe el money-path (CD-17). CD-9: owner = `address` (ya validado). NUNCA
  // persiste PII (solo idempotencyKey + status/enum, CD-7).
  const ledger = getSettlementLedger();
  const persistOutcome = async (
    status: SettlementLedgerStatus,
    payoutId: string | null,
    error: string | null,
  ): Promise<void> => {
    if (!ledger) return; // flag OFF ⇒ byte-idéntico
    try {
      const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
      if (idempotencyKey) {
        await ledger.recordPayoutOutcome({
          idempotencyKey,
          senderAddress: address,
          status,
          payoutId,
          error,
        });
      }
    } catch (e) {
      console.error("[ledger] recordPayoutOutcome_failed", e); // best-effort, NUNCA rompe (CD-17)
    }
  };

  // A10 — todo OK → forward (bloque intacto salvo el side-effect aditivo del ledger antes de cada return).

  try {
    const res = await fetch(`${BASE}/api/agents/remit-cashout-payout/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body), // idempotencyKey/beneficiary forwardeados tal cual (CD-10)
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      await persistOutcome("forward_error", null, "a2a_upstream_error");
      return NextResponse.json({ error: "a2a_upstream_error" }, { status: 502 });
    }
    const { result } = (await res.json()) as { result: unknown };
    if (!isValidPayoutResult(result)) {
      await persistOutcome("forward_error", null, "a2a_bad_shape");
      return NextResponse.json({ error: "a2a_bad_shape" }, { status: 502 });
    }
    // Mapeo forward-result → status del ledger (AC-3, tabla §5). settled/submitted directos;
    // failed/blocked → failed. isValidPayoutResult ya garantizó el shape (status + payoutId).
    const okResult = result as { status: string; payoutId: string | null };
    const mapped: SettlementLedgerStatus =
      okResult.status === "settled"
        ? "settled"
        : okResult.status === "submitted"
          ? "submitted"
          : "failed";
    await persistOutcome(
      mapped,
      okResult.payoutId,
      mapped === "failed" ? `a2a_${okResult.status}` : null,
    );
    return NextResponse.json({ result }, { status: 200 }); // sólo el result (nunca BASE ni PII)
  } catch {
    // timeout/DNS/parse → 502 opaco (nunca 500 crudo, nunca ecoa el beneficiary)
    await persistOutcome("forward_error", null, "a2a_unavailable");
    return NextResponse.json({ error: "a2a_unavailable" }, { status: 502 });
  }
}
