// Server-side: AUTORIDAD del payout (WKH-180). Re-consulta la decisión REAL de Didit
// (GET /v3/session/{id}/decision/, x-api-key server-only) y devuelve SOLO { authorized, reason }
// — cero PII (CD-A8). Es la única fuente de verdad para autorizar: nunca los booleanos del browser
// (approved/payoutAllowed en localStorage son forjables — CD-2).
// WKH-202/DT-1: el guard-order vive en src/infrastructure/payout/authority.ts, compartido con
// /api/a2a/payout/submit (dos copias divergirían). Esta route es un wrapper delgado: parsea el body
// (el parseo se queda ACÁ) y traduce la decisión a HTTP.
// WKH-205 (cierre de deuda): (1) oráculo KYC cerrado — los 3 reasons subject (kyc_not_approved /
// kyc_ownership_mismatch / invalid_verification_id) colapsan a UN código no-revelador
// kyc_not_authorized con status 200 fijo (indistinguibles a un caller no autenticado, mismo criterio
// no-oracle que submit/route.ts). (2) body-null → 4xx (isRecord, nunca `as {...}`). (3) rate-limit
// financial-DoS: cada POST re-consulta Didit (costo Chaski) → limitado por IP+address SOLO en entorno
// vivo (DIDIT_API_KEY presente), fail-closed si Upstash ausente.
import { NextResponse } from "next/server";
import { resolvePayoutAuthority } from "../../../../src/infrastructure/payout/authority";
import {
  PAYOUT_VALIDATE_RL,
  checkRouteRateLimit,
  clientIp,
} from "../../../../src/infrastructure/rate-limit";

// CD-5/MNR-5: excluye arrays (isRecord con exclusión desde el inicio).
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function POST(req: Request): Promise<Response> {
  // CD-12: parsear a `unknown` + narrow (NUNCA `as {...}`). isRecord cubre null/array/no-objeto → {}.
  const parsed: unknown = await req.json().catch(() => null);
  const body: Record<string, unknown> = isRecord(parsed) ? parsed : {};
  const verificationId = typeof body.verificationId === "string" ? body.verificationId : "";
  const address = typeof body.address === "string" ? body.address : "";

  // AC-4/DT-5/CD-9: rate-limit ANTES de la autoridad, SOLO en entorno vivo (prod-like). Sin el
  // host del agente → dev/sim, no hay costo de cuota que limitar y el demo local sigue andando
  // (mismo criterio que kyc/session).
  if (process.env.KYC_AGENT_BASE_URL) { // WKH-233: MISMA semántica (¿demo o vivo?) sin la env del proveedor, que ya no existe en este repo. Residual R-6 heredado: este gate mira "hay entorno vivo", no "esta llamada cuesta plata", y eso NO se rediseña acá — se arrastra tal cual para que el cambio sea sólo el de la cañería
    const rl = await checkRouteRateLimit(PAYOUT_VALIDATE_RL, {
      ip: clientIp(req),
      address: address || undefined,
    });
    if (rl.unavailable) {
      // AC-6 fail-closed: Upstash ausente en entorno vivo → 503 (reason técnico, retryable).
      return NextResponse.json(
        { authorized: false, reason: "kyc_authority_unavailable" },
        { status: 503 },
      );
    }
    if (!rl.ok) {
      return NextResponse.json(
        { authorized: false, reason: "kyc_rate_limited" },
        { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } },
      );
    }
  }

  // 🔴 `provenance` y `riskLevel` SE DESCARTAN ACÁ, y no es prolijidad. WKH-333 los agregó a
  // `PayoutAuthorityDecision` para el backfill del veredicto (server-side, CD-24), y este `...rest`
  // los habría publicado tal cual: esta route es un POST PÚBLICO, así que cualquiera que presentara
  // un par (verificationId, address) válido se llevaría además la clasificación de riesgo de esa
  // persona y si su verificación fue real o simulada — dos datos que nunca salieron de acá.
  // MEDIDO: el test "respuesta nunca contiene identity/documentNumber ni el API key (AC-7, CD-A8)"
  // se puso rojo con `{authorized:true, provenance:"didit-mock", riskLevel:"low"}` antes de este
  // descarte. Sacar los campos de la decisión no era opción: el backfill los necesita y duplicar el
  // guard-order en una segunda función sería la divergencia que WKH-202/DT-1 prohíbe.
  const { httpStatus, provenance: _p, riskLevel: _r, ...rest } = await resolvePayoutAuthority({
    verificationId,
    address,
  });

  // AC-1/AC-2/DT-1: colapso no-oracle SOLO de los reasons subject → 1 código + status 200 fijo,
  // indistinguibles. Técnicos (502/503) y authorized:true pasan por el rest-spread intacto (CD-2).
  // Duplicación deliberada del set de submit/route.ts (DT-2, deuda documentada, NO helper).
  if (!rest.authorized) {
    switch (rest.reason) {
      case "kyc_not_approved":
      case "kyc_ownership_mismatch":
      case "invalid_verification_id":
        // CD-7/CD-8: mismo reason (con "kyc" → humanError L47) + mismo 200 → oráculo cerrado.
        return NextResponse.json({ authorized: false, reason: "kyc_not_authorized" }, { status: 200 });
      // técnicos (kyc_authority_unavailable 503, kyc_reauth_failed 502) + cualquier reason nuevo:
      default:
        return NextResponse.json(rest, { status: httpStatus });
    }
  }
  return NextResponse.json(rest, { status: httpStatus }); // authorized:true byte-idéntico (CD-2)
}
