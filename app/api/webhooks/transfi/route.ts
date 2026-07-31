// Server-side: receptor del webhook de estado de TransFi (WKH-210). Cierra la mitad "recibir
// confirmación" del loop async: TransFi liquida el fiat fuera de banda (asset_deposited → fund_settled)
// y notifica acá; el endpoint verifica el HMAC (fail-closed), MUTA el ledger idempotentemente
// correlacionando por payoutId y recién DESPUÉS marca el evento como visto (claim best-effort).
//
// NO es el reorder no-custodial (beneficiary atestado) → eso es WKH-211 (otro ticket).
//
// Auth fail-closed (CD-2): sin TRANSFI_WEBHOOK_SECRET ⇒ 501 ANTES de leer el body; firma
// ausente/inválida ⇒ 401 ANTES de parsear. HMAC sobre el body CRUDO (CD-9/DT-4). No-PII (CD-3): NUNCA
// se loguea/persiste el raw ni el beneficiario; la respuesta jamás ecoa el payload.
//
// Idempotencia AT-LEAST-ONCE (FIX AR MNR-1, antes era at-most-once/claim-before-mutate): la mutación va
// PRIMERO y el claim DESPUÉS de que la mutación tenga éxito. `recordWebhookOutcome` es idempotente por
// construcción — filtra por STALE_STATUSES (principal_in/submitted/forward_error), así que aplicar la
// misma transición N veces = 1 vez (la 2ª+ es un no-op: la fila ya salió del set no-terminal) y NUNCA
// degrada un estado terminal. Consecuencia: si el ledger tira (DB down) devolvemos 503 SIN quemar la
// key ⇒ el retry de TransFi re-entrega el MISMO evento y lo re-muta idempotentemente, sin perder la
// transición. El claim quedó como dedup best-effort (evita trabajo redundante); ya NO gatea la mutación.
import { NextResponse } from "next/server";
import { getSettlementLedger } from "../../../../src/infrastructure/persistence/supabase-settlement-ledger";
import { claimWebhookEventOnce } from "../../../../src/infrastructure/webhooks/webhook-event-store";
import {
  extractEventId,
  extractPayoutId,
  mapTransfiStatus,
  verifyTransfiHmac,
} from "../../../../src/infrastructure/webhooks/transfi-hmac";

export async function POST(req: Request): Promise<Response> {
  // 1. Secreto configurado (fail-closed, ANTES de leer el body — CD-2/AC-1). Todo env en runtime.
  const secret = process.env.TRANSFI_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "webhook_not_configured" }, { status: 501 });
  }

  // 2. Body crudo — UNA sola vez (CD-9/DT-4). El HMAC se verifica sobre ESTE string exacto.
  const raw = await req.text();

  // 3. HMAC sobre el raw (CD-2/AC-2, sin parsear). Ausente/mismatch ⇒ 401.
  const sig = req.headers.get("x-transfi-hmac-hash");
  if (!verifyTransfiHmac(raw, sig)) {
    return NextResponse.json({ error: "webhook_unauthorized" }, { status: 401 });
  }

  // 4. Ledger. Con flag OFF/envs ausentes no hay nada que actualizar ⇒ 501 (DT-3/AC-10).
  const ledger = getSettlementLedger();
  if (!ledger) {
    return NextResponse.json({ error: "webhook_not_enabled" }, { status: 501 });
  }

  // 5. Parse del raw DENTRO de try/catch (firma válida NO garantiza JSON bien formado).
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not_an_object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "webhook_bad_request" }, { status: 400 });
  }

  // 6. Correlación por payoutId + status del payload.
  const payoutId = extractPayoutId(body);
  const status = typeof body.status === "string" ? body.status : "";
  if (!payoutId) {
    return NextResponse.json({ ok: true, ignored: "no_payout_id" }, { status: 200 }); // AC-8b
  }

  // 7. Mapeo de estado. Desconocido ⇒ 200 ACK SIN claim, SIN mutar (AC-7/CD-7).
  const mapped = mapTransfiStatus(status);
  if (mapped === null) {
    return NextResponse.json({ ok: true, ignored: "unmapped_status" }, { status: 200 });
  }

  // 8. Mutación del ledger PRIMERO (at-least-once idempotente — FIX AR MNR-1). recordWebhookOutcome
  //    filtra por STALE_STATUSES ⇒ aplicar N veces = 1 vez (la 2ª+ es no-op) y jamás degrada un estado
  //    terminal. last_error es un enum estable, NUNCA el reason crudo (DT-8/CD-3). Un DB-throw ⇒ 503
  //    (NUNCA 500) SIN quemar la key: el retry de TransFi re-muta el MISMO evento sin perder la
  //    transición (esto es lo que el orden claim-antes-de-mutar rompía).
  try {
    await ledger.recordWebhookOutcome({
      payoutId,
      status: mapped,
      error: mapped === "failed" ? "transfi_fund_failed" : undefined,
    });
  } catch {
    return NextResponse.json({ error: "webhook_unavailable" }, { status: 503 });
  }

  // 9. Claim best-effort DESPUÉS del éxito de la mutación (CD-4 re-encuadrado). Solo dedup/telemetría:
  //    marca el evento como visto para evitar trabajo redundante en un re-delivery. Ya NO gatea la
  //    mutación (el reorder mató el lost-update), así que su resultado es indiferente: Upstash caído
  //    o key ya quemada ⇒ igual 200, porque la mutación ya se aplicó y es idempotente.
  const eventKey = extractEventId(body, payoutId, status);
  await claimWebhookEventOnce(eventKey);

  // 10. ACK. La respuesta jamás ecoa el payload (CD-3).
  return NextResponse.json({ ok: true }, { status: 200 });
}
