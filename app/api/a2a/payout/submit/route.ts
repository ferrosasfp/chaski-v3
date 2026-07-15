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
// Residual (NO lo cierra esta HU): kycPayoutAllowed sigue siendo un booleano del caller (WKH-203) y
// nadie verifica que el sender pagó el principal en USDC (WKH-168).
import { NextResponse } from "next/server";
import { resolvePayoutAuthority } from "../../../../../src/infrastructure/payout/authority";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
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

  try {
    const res = await fetch(`${BASE}/api/agents/remit-cashout-payout/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body), // idempotencyKey/beneficiary forwardeados tal cual (CD-10)
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return NextResponse.json({ error: "a2a_upstream_error" }, { status: 502 });
    const { result } = (await res.json()) as { result: unknown };
    if (!isValidPayoutResult(result)) {
      return NextResponse.json({ error: "a2a_bad_shape" }, { status: 502 });
    }
    return NextResponse.json({ result }, { status: 200 }); // sólo el result (nunca BASE ni PII)
  } catch {
    // timeout/DNS/parse → 502 opaco (nunca 500 crudo, nunca ecoa el beneficiary)
    return NextResponse.json({ error: "a2a_unavailable" }, { status: 502 });
  }
}
