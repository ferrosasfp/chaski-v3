// Infrastructure — PrincipalSettlementGateway sobre NUESTRA ruta server-only (WKH-168, AC-7).
//
// Corre en el CLIENTE. Por eso llama SIEMPRE a /api/settle/principal y JAMÁS a la URL del
// facilitador: las credenciales del broadcaster viven server-side y nunca se exponen al browser
// (CD-4). Este archivo no conoce ninguna env de settlement.
//
// ⚠️ Lo que este gateway devuelve NO autoriza nada por sí solo: el `attestation` es la evidencia
// firmada por el server (tras verificar la cadena) que el submit va a re-verificar server-side. Un
// atacante que corra este código en su browser no puede fabricar una atestación válida.
// Exemplar: a2a/gateways.ts (type-guards explícitos, errores estables PII-free, sin `any`).
import type {
  Eip3009Authorization,
  PrincipalSettlementGateway,
  SettlementFailureReason,
} from "../../application/ports";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Mapa status → reason. Fail-closed (CD-12): cualquier status/enum desconocido ⇒ un reason que
 *  BLOQUEA. Sin default permisivo (lección WKH-198). */
function mapErrorStatus(status: number, error: unknown): SettlementFailureReason {
  // El enum de la ruta es nuestro (no del facilitador) → se puede mapear 1:1 cuando viene bien.
  if (typeof error === "string") {
    switch (error) {
      case "settle_amount_mismatch":
        return "settlement_amount_mismatch";
      case "settle_receiver_mismatch":
        return "settlement_receiver_mismatch";
      case "settle_reverted":
        return "settlement_reverted";
      case "settle_unverified":
        return "settlement_unverified";
      case "settle_rejected":
      case "settle_sender_mismatch":
      case "settle_invalid_request":
        return "settlement_rejected";
      case "settle_unavailable":
      case "settle_in_flight":
        return "settlement_unavailable";
      // settle_not_enabled / settle_not_configured / settle_misconfigured y cualquier enum NUEVO
      // caen abajo: bloquean igual.
      default:
        break;
    }
  }
  if (status === 409) return "settlement_unavailable"; // in-flight: NO re-firmar (DT-6)
  if (status === 503 || status === 504) return "settlement_unavailable";
  return "settlement_rejected"; // 4xx/5xx desconocido ⇒ bloquear
}

/** Shape del 200 de /api/settle/principal. Validado explícitamente: un 200 con shape raro NO puede
 *  volverse un `principal_in` (CD-10: nunca asumir éxito por el status). */
function isValidSettleShape(
  v: unknown,
): v is { txHash: string; valueMinor: number; to: string; from: string; attestation: string } {
  if (!isRecord(v)) return false;
  if (typeof v.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v.txHash)) return false;
  if (typeof v.valueMinor !== "number" || !Number.isInteger(v.valueMinor) || v.valueMinor < 1) {
    return false;
  }
  if (typeof v.to !== "string" || !v.to) return false;
  if (typeof v.from !== "string" || !v.from) return false;
  if (typeof v.attestation !== "string" || !v.attestation) return false;
  return true;
}

export class HttpSettlementGateway implements PrincipalSettlementGateway {
  async settle(input: {
    authorization: Eip3009Authorization;
    signature: string;
    address: string;
    quoteId: string;
    expectedValueMinor: number;
  }): Promise<
    | { ok: true; txHash: string; valueMinor: number; to: string; from: string; attestation: string }
    | { ok: false; reason: SettlementFailureReason }
  > {
    let res: Response;
    try {
      res = await fetch("/api/settle/principal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // La authorization ya viene en strings canónicos desde wallet.ts (CD-16): JSON.stringify
        // sobre un bigint tiraría TypeError.
        body: JSON.stringify({
          authorization: input.authorization,
          signature: input.signature,
          address: input.address,
          quoteId: input.quoteId,
          expectedValueMinor: input.expectedValueMinor,
        }),
      });
    } catch {
      return { ok: false, reason: "settlement_unavailable" }; // red caída ⇒ fail-closed
    }

    if (!res.ok) {
      let error: unknown;
      try {
        const body: unknown = await res.json();
        error = isRecord(body) ? body.error : undefined;
      } catch {
        error = undefined;
      }
      return { ok: false, reason: mapErrorStatus(res.status, error) };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: "settlement_unverified" };
    }
    if (!isValidSettleShape(body)) return { ok: false, reason: "settlement_unverified" };
    return {
      ok: true,
      txHash: body.txHash,
      valueMinor: body.valueMinor,
      to: body.to,
      from: body.from,
      attestation: body.attestation,
    };
  }
}
