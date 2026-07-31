// Infrastructure — SolanaPayoutPrepareGateway sobre NUESTRA ruta server-only /api/payout/prepare
// (HU-SOL-13/AC-1). Corre en el CLIENTE: llama SIEMPRE a /api/payout/prepare y JAMÁS al agente directo
// (REMIT_AGENTS_BASE_URL vive server-side, CD-6).
//
// Adjunta el proof-of-possession ed25519 (WKH-206) que la route exige en PR6: pide el challenge a
// /api/a2a/payout/challenge vía PopSigner, lo firma con la wallet conectada y lo manda en el mismo
// body. Sin eso la route corta en 403 antes de crear ninguna orden.
//
// Resuelve, SERVER-SIDE (nunca del body del cliente, CD-7): `beneficiary` (deposit-address Solana de la
// orden TransFi) + `authority` (release-authority pubkey = resolveSolanaReleaseAuthorityPubkey(), env
// server-only). El use-case pasa ambos a authorizePrincipal para que la wallet arme la ix `deposit` del
// escrow. Fail-closed: un 200 con shape raro NUNCA se vuelve un escrow firmable.
//
// El `beneficiary` NO se usa hasta que su atestación se verifica (ver `verifyAttestation` más abajo).
// Antes de eso el campo `attestation` llegaba y se descartaba: la firma existía y no la miraba nadie.
//
// ⚠️ ALCANCE, en dos mitades, y las dos hacen falta:
//   · SÍ cubre que el `beneficiary` no se haya ALTERADO entre nuestro servidor y este código.
//   · NO cubre que el `beneficiary` sea LEGÍTIMO. Nuestro servidor firma la dirección que le dio el
//     AGENTE de payout. Si el agente miente, la atestación certifica la mentira sin pestañear.
//     Contra eso no defiende esta capa; defiende de QUÉ agente se trata, que es otra cosa y vive
//     en el piso de reputación / el catálogo. Quien lea sólo la primera mitad va a creer que
//     estamos cubiertos contra el agente y va a dejar de buscar acá.
//
// [NC-1]/[NC-2] (founder-gated, FUERA de F3): la resolución REAL del beneficiary (deposit-address Solana
// de TransFi por orden) y la respuesta Solana-shaped del server (`{beneficiary, authority, ...}` base58)
// son founder-gated — hasta que el agente remit-cashout-payout exponga el destino Solana. El binding/
// atestación queda listo. Este gateway se unit-testea con un mock (FakeSolanaPayoutPrepareGateway).
import type { AgentRef, Beneficiary } from "../../domain/remittance";
import type { PopSigner, SolanaPayoutPrepareGateway } from "../../application/ports";

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
function isValidSolanaPrepareShape(v: unknown): v is {
  beneficiary: string;
  authority: string;
  attestation: string;
  payoutId: string;
  provenance: string;
  agent?: unknown; // trazabilidad: se lee aparte y NO se exige (ausente ⇒ "no sé quién")
} {
  if (!isRecord(v)) return false;
  if (typeof v.beneficiary !== "string" || !v.beneficiary) return false;
  if (typeof v.authority !== "string" || !v.authority) return false;
  if (typeof v.attestation !== "string" || !v.attestation) return false;
  if (typeof v.payoutId !== "string" || !v.payoutId) return false;
  if (typeof v.provenance !== "string") return false; // "" (mock) permitido, pero string
  return true;
}

/**
 * Pide a /api/payout/attestation que verifique el HMAC de la atestación y devuelva el
 * beneficiary+authority que están DENTRO del payload firmado. `null` = no se pudo verificar, por
 * el motivo que sea (red caída, 403, 503, shape raro): TODOS bloquean igual.
 *
 * Vive en el server porque el secreto vive en el server: `DEPOSIT_ATTESTATION_SECRET` no se manda
 * al browser, así que el browser no puede recalcular el HMAC por su cuenta. Decodificar el payload
 * acá sin verificar la firma no serviría de nada — el que puede alterar el beneficiary también
 * puede re-armar un payload que diga lo que quiera.
 *
 * ⚠️ ALCANCE (el largo está en la route). Esto detecta que el beneficiary se haya ALTERADO entre
 * nuestro servidor y este código. NO dice nada sobre si el agente de payout dio una dirección
 * legítima: nuestro servidor firmó lo que el agente le dijo.
 */
async function verifyAttestation(
  attestation: string,
  remittanceId: string,
  quoteId: string,
): Promise<{ beneficiary: string; authority: string } | null> {
  let res: Response;
  try {
    res = await fetch("/api/payout/attestation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attestation, remittanceId, quoteId }),
    });
  } catch {
    return null; // red caída ⇒ no se verificó ⇒ no se usa (fail-closed)
  }
  if (!res.ok) return null;
  let out: unknown;
  try {
    out = await res.json();
  } catch {
    return null;
  }
  if (!isRecord(out)) return null;
  if (typeof out.beneficiary !== "string" || !out.beneficiary) return null;
  if (typeof out.authority !== "string" || !out.authority) return null;
  return { beneficiary: out.beneficiary, authority: out.authority };
}

/** Lee el `agent` que la route agrega al 200 (trazabilidad). Sin `slug` no hay identidad que
 *  afirmar ⇒ `undefined`: la remesa queda diciendo "no sé quién", que es la verdad. NUNCA bloquea
 *  el prepare — saber o no saber quién atendió no cambia la validez del destino, y hacerlo
 *  bloqueante convertiría un dato de auditoría en un modo de falla del money-path. */
function readAgentRef(raw: unknown): AgentRef | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.slug !== "string" || !raw.slug) return undefined;
  return {
    slug: raw.slug,
    registry: typeof raw.registry === "string" ? raw.registry : "",
    ...(typeof raw.capability === "string" ? { capability: raw.capability } : {}),
    ...(typeof raw.trial === "boolean" ? { trial: raw.trial } : {}),
  };
}

export class HttpSolanaPayoutPrepareGateway implements SolanaPayoutPrepareGateway {
  // El PoP NO es opcional acá. La route lo exige (PR6) y responde 403 opaco sin él, así que un
  // gateway sin PopSigner sólo puede producir un rechazo: por eso el signer es un argumento de
  // construcción y no un campo opcional que alguien pueda olvidar de cablear.
  constructor(private readonly pop: PopSigner) {}

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
        result: {
          beneficiary: string;
          authority: string;
          attestation: string;
          payoutId: string;
          provenance: string;
          agent?: AgentRef;
        };
      }
    | { ok: false; reason: string }
  > {
    // PoP (WKH-206/HU-SOL-8) ANTES del POST. La route pide `popChallenge`+`popSignature` (PR6) y sin
    // ellos devuelve 403 `payout_pop_unverified` — un error que la persona veía DESPUÉS de apretar
    // "Confirmar y enviar" y ANTES de que la wallet le pidiera una sola firma. El mecanismo ya existía
    // y ya corría en producción en el camino de refund (http-solana-remittance-id-resolver.ts:19);
    // lo único que faltaba era usarlo también acá.
    //
    // `prove(input.address)` firma para la MISMA address que viaja en el body: P3 de la route compara
    // canonicalizeAddress(challenge.address) contra canonicalizeAddress(body.address).
    let proof: Awaited<ReturnType<PopSigner["prove"]>>;
    try {
      proof = await this.pop.prove(input.address);
    } catch {
      // Red caída / 400 / 5xx del emisor del challenge ⇒ no hay prueba que mandar. Fail-closed con el
      // MISMO enum que la route usa cuando no puede verificar: nunca se postea sin PoP.
      return { ok: false, reason: "payout_pop_unavailable" };
    }
    if (!proof) {
      // `null` = el emisor respondió 501: el server NO tiene PAYOUT_POP_SECRET. La route lee ESA MISMA
      // env y respondería 503 `payout_pop_unavailable` (route.ts:143-145). Cortamos acá con el enum
      // idéntico en vez de gastar un POST y un token de rate-limit en un rechazo ya determinado.
      return { ok: false, reason: "payout_pop_unavailable" };
    }

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
          popChallenge: proof.challenge,
          popSignature: proof.signature,
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

    // ── La atestación se VERIFICA antes de que el beneficiary se use ────────────────────────────
    // Hasta acá este cliente leía `body.beneficiary` y descartaba `body.attestation`, el campo que
    // lo certifica: se emitía una firma que nadie miraba. Fail-closed: si no valida, no hay
    // beneficiary que devolver y la remesa NO llega a la wallet.
    const attested = await verifyAttestation(body.attestation, input.remittanceId, input.quoteId);
    if (!attested) return { ok: false, reason: "prepare_attestation_unverified" };
    // Cinturón: el valor firmado y el entregado tienen que ser el MISMO. Comparación base58
    // case-sensitive (minusculizar reabre el aliasing). Un mismatch acá es exactamente el ataque
    // que la atestación existe para ver, así que se reporta con su propio enum en vez de colapsarlo
    // con "no validó": son diagnósticos distintos y los dos bloquean igual.
    if (attested.beneficiary !== body.beneficiary || attested.authority !== body.authority) {
      return { ok: false, reason: "prepare_attestation_mismatch" };
    }
    const agent = readAgentRef(body.agent);
    return {
      ok: true,
      result: {
        // Los valores ATESTADOS, no los de primer nivel. Ya se comprobó que coinciden; usar el que
        // viene de adentro de la firma hace que el guard no dependa de que nadie invierta el orden.
        beneficiary: attested.beneficiary,
        authority: attested.authority,
        attestation: body.attestation,
        payoutId: body.payoutId,
        provenance: body.provenance,
        ...(agent ? { agent } : {}),
      },
    };
  }
}
