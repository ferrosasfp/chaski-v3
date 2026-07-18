// Infrastructure — verificación HMAC + mapeo/parseo defensivo del webhook de TransFi (WKH-210).
//
// Crypto: node:crypto (createHmac/timingSafeEqual). El HMAC se calcula sobre el BODY CRUDO (el raw
// string tal cual llega), NO sobre un JSON re-serializado: re-serializar cambiaría spacing/orden y
// rompería la firma (CD-3/DT-4). PROHIBIDO JSON.parse/re-stringify acá.
//
// ⚠️ TransFi usa digest('hex') (spec confirmada), a diferencia de attestation.ts que usa 'base64url'.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SettlementLedgerStatus } from "../../application/ports";

/**
 * verifyTransfiHmac: HMAC-SHA256(raw).digest('hex') con TRANSFI_WEBHOOK_SECRET (leído DENTRO, CD-10).
 * Comparación timing-safe (LONGITUD primero — timingSafeEqual TIRA con buffers de distinto largo —
 * patrón attestation.ts:68-73 / reconcile:22-29). Devuelve false ante secreto ausente, firma ausente
 * o mismatch (fail-closed). NUNCA tira.
 */
export function verifyTransfiHmac(raw: string, signature: string | null): boolean {
  const secret = process.env.TRANSFI_WEBHOOK_SECRET;
  if (!secret || signature == null) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"));
  const received = Buffer.from(signature);
  if (expected.length !== received.length) return false; // longitud primero
  return timingSafeEqual(expected, received);
}

/**
 * mapTransfiStatus: 'asset_deposited'→'submitted', 'fund_settled'→'settled', 'fund_failed'→'failed';
 * CUALQUIER otro (incl. 'initiated'/'expired'/desconocido) → null (AC-7/CD-7). NUNCA inferir terminal.
 */
export function mapTransfiStatus(status: string): SettlementLedgerStatus | null {
  switch (status) {
    case "asset_deposited":
      return "submitted";
    case "fund_settled":
      return "settled";
    case "fund_failed":
      return "failed";
    default:
      return null;
  }
}

/** Primer valor string no-vacío de una lista de campos candidatos del body. */
function firstNonEmptyString(body: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * extractPayoutId: candidatos EN ORDEN orderId→id→transactionId→orderNumber (primer string no-vacío).
 * DT-5.
 */
export function extractPayoutId(body: Record<string, unknown>): string | null {
  // TODO(sandbox): confirmar el campo real del order-id contra un webhook real de TransFi
  return firstNonEmptyString(body, ["orderId", "id", "transactionId", "orderNumber"]);
}

/**
 * extractEventId: candidatos eventId→webhookId→deliveryId (string no-vacío); si ninguno → fallback
 * composite `${payoutId}:${status}`. DT-6.
 */
export function extractEventId(
  body: Record<string, unknown>,
  payoutId: string,
  status: string,
): string {
  // TODO(sandbox): usar el eventId nativo de TransFi si el webhook real lo trae (dedup más preciso)
  const native = firstNonEmptyString(body, ["eventId", "webhookId", "deliveryId"]);
  return native ?? `${payoutId}:${status}`;
}
