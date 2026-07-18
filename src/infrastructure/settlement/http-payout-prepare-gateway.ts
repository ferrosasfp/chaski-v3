// Infrastructure — PayoutPrepareGateway sobre NUESTRA ruta server-only /api/payout/prepare (WKH-211).
//
// Corre en el CLIENTE. Por eso llama SIEMPRE a /api/payout/prepare y JAMÁS al agente directo: el
// REMIT_AGENTS_BASE_URL y el DEPOSIT_ATTESTATION_SECRET viven server-side (CD-9/CD-4). Este archivo no
// conoce ninguna env de settlement.
//
// ⚠️ Lo que devuelve NO autoriza nada por sí solo: el `attestation` es la evidencia firmada por el
// server (tras crear la orden) que el guard de /api/settle/principal re-verifica server-side (B1-B6).
// Un atacante que corra este código en su browser no puede fabricar una atestación válida.
// Exemplar: http-settlement-gateway.ts (type-guards explícitos, mapErrorStatus fail-closed sin default
// permisivo, red-caída fail-closed).
import type { Beneficiary } from "../../domain/remittance";
import type { PayoutPrepareGateway, PayoutPrepareResult } from "../../application/ports";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Mapa status/enum → reason estable. Fail-closed (CD-12): cualquier enum/status desconocido ⇒ un
 *  reason que BLOQUEA. Sin default permisivo (lección WKH-198). El enum de la route es nuestro. */
function mapErrorReason(status: number, error: unknown): string {
  if (typeof error === "string") {
    switch (error) {
      case "prepare_not_configured":
      case "prepare_unavailable":
      case "prepare_rate_limit_unavailable":
      case "prepare_rate_limited":
      case "prepare_invalid_request":
      case "payout_not_authorized":
      case "payout_authority_unavailable":
      case "payout_pop_unverified":
      case "prepare_upstream_error":
      case "prepare_no_deposit_address":
        return error; // enum estable de la route → se propaga 1:1
      default:
        break;
    }
  }
  if (status === 429 || status === 503 || status === 504) return "prepare_unavailable";
  return "prepare_rejected"; // 4xx/5xx desconocido ⇒ bloquear
}

/** Shape del 200 de /api/payout/prepare. Validado explícitamente (CD-10): un 200 con shape raro NO
 *  puede volverse un depositAddress firmable. */
function isValidPrepareShape(v: unknown): v is PayoutPrepareResult {
  if (!isRecord(v)) return false;
  if (typeof v.depositAddress !== "string" || !v.depositAddress) return false;
  if (typeof v.attestation !== "string" || !v.attestation) return false;
  if (typeof v.payoutId !== "string" || !v.payoutId) return false;
  if (typeof v.provenance !== "string") return false; // provenance puede ser "" (mock), pero string
  return true;
}

export class HttpPayoutPrepareGateway implements PayoutPrepareGateway {
  async prepare(input: {
    remittanceId: string;
    quoteId: string;
    kycVerificationId: string;
    address: string;
    amountUsd: number;
    beneficiary: Beneficiary;
    idempotencyKey: string;
    popChallenge?: string;
    popSignature?: string;
  }): Promise<{ ok: true; result: PayoutPrepareResult } | { ok: false; reason: string }> {
    let res: Response;
    try {
      res = await fetch("/api/payout/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          remittanceId: input.remittanceId,
          quoteId: input.quoteId,
          kycVerificationId: input.kycVerificationId,
          address: input.address,
          amountUsd: input.amountUsd,
          beneficiary: input.beneficiary, // viaja al server; NUNCA se loguea (CD-5)
          idempotencyKey: input.idempotencyKey, // INTACTO (CD-10)
          popChallenge: input.popChallenge, // undefined ⇒ JSON.stringify lo omite (demo byte-idéntico)
          popSignature: input.popSignature,
        }),
      });
    } catch {
      return { ok: false, reason: "prepare_unavailable" }; // red caída ⇒ fail-closed
    }

    if (!res.ok) {
      let error: unknown;
      try {
        const eb: unknown = await res.json();
        error = isRecord(eb) ? eb.error : undefined;
      } catch {
        error = undefined;
      }
      return { ok: false, reason: mapErrorReason(res.status, error) };
    }

    let bodyResp: unknown;
    try {
      bodyResp = await res.json();
    } catch {
      return { ok: false, reason: "prepare_bad_shape" };
    }
    if (!isValidPrepareShape(bodyResp)) return { ok: false, reason: "prepare_bad_shape" };
    return {
      ok: true,
      result: {
        depositAddress: bodyResp.depositAddress,
        attestation: bodyResp.attestation,
        payoutId: bodyResp.payoutId,
        provenance: bodyResp.provenance,
      },
    };
  }
}
