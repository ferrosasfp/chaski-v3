// Infrastructure — SolanaPayoutPrepareGateway sobre NUESTRA ruta server-only /api/payout/prepare
// (HU-SOL-13/AC-1). Corre en el CLIENTE: llama SIEMPRE a /api/payout/prepare y JAMÁS al agente directo
// (REMIT_AGENTS_BASE_URL vive server-side, CD-6). Espeja el prepare EVM (http-payout-prepare-gateway).
//
// Resuelve, SERVER-SIDE (nunca del body del cliente, CD-7): `beneficiary` (deposit-address Solana de la
// orden TransFi) + `authority` (release-authority pubkey = resolveSolanaReleaseAuthorityPubkey(), env
// server-only). El use-case pasa ambos a authorizePrincipal para que la wallet arme la ix `deposit` del
// escrow. Fail-closed: un 200 con shape raro NUNCA se vuelve un escrow firmable.
//
// [NC-1]/[NC-2] (founder-gated, FUERA de F3): la resolución REAL del beneficiary (deposit-address Solana
// de TransFi por orden) y la respuesta Solana-shaped del server (`{beneficiary, authority, ...}` base58)
// son founder-gated — hasta que el agente remit-cashout-payout exponga el destino Solana. El binding/
// atestación queda listo. Este gateway se unit-testea con un mock (FakeSolanaPayoutPrepareGateway).
import type { Beneficiary } from "../../domain/remittance";
import type { SolanaPayoutPrepareGateway } from "../../application/ports";

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
      case "payout_pop_unavailable":
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

/** Shape del 200 Solana. Validado explícitamente (CD-13): beneficiary+authority DEBEN ser strings
 *  no-vacíos (base58; la validación fina de base58 la hace la wallet vía PublicKey). */
function isValidSolanaPrepareShape(
  v: unknown,
): v is { beneficiary: string; authority: string; attestation: string; payoutId: string; provenance: string } {
  if (!isRecord(v)) return false;
  if (typeof v.beneficiary !== "string" || !v.beneficiary) return false;
  if (typeof v.authority !== "string" || !v.authority) return false;
  if (typeof v.attestation !== "string" || !v.attestation) return false;
  if (typeof v.payoutId !== "string" || !v.payoutId) return false;
  if (typeof v.provenance !== "string") return false; // "" (mock) permitido, pero string
  return true;
}

export class HttpSolanaPayoutPrepareGateway implements SolanaPayoutPrepareGateway {
  async prepare(input: {
    remittanceId: string;
    quoteId: string;
    kycVerificationId: string;
    address: string;
    amountUsd: number;
    beneficiary: Beneficiary;
    idempotencyKey: string;
  }): Promise<
    | {
        ok: true;
        result: { beneficiary: string; authority: string; attestation: string; payoutId: string; provenance: string };
      }
    | { ok: false; reason: string }
  > {
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
          idempotencyKey: input.idempotencyKey,
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

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: "prepare_bad_shape" };
    }
    if (!isValidSolanaPrepareShape(body)) return { ok: false, reason: "prepare_bad_shape" };
    return {
      ok: true,
      result: {
        beneficiary: body.beneficiary,
        authority: body.authority,
        attestation: body.attestation,
        payoutId: body.payoutId,
        provenance: body.provenance,
      },
    };
  }
}
