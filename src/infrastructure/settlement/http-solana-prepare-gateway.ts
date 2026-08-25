// Infrastructure — SolanaPayoutPrepareGateway sobre NUESTRA ruta server-only /api/payout/prepare
// (HU-SOL-13/AC-1). Corre en el CLIENTE: llama SIEMPRE a /api/payout/prepare y JAMÁS al agente directo
// (no conoce ninguna URL de agente ni de gateway: la capacidad la resuelve el server, CD-6).
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
// ⚠️ ALCANCE (el largo está en app/api/payout/attestation/route.ts; acá va lo mínimo para no
// leer de más en esta capa):
//   · SÍ detecta la adulteración AISLADA del 200 de prepare, el REPLAY de una atestación de otra
//     remesa (binding remittanceId+quoteId) y bugs nuestros de orden o de campo.
//   · NO detecta al intermediario que reescribe LAS DOS rutas. `verifyAttestation` no verifica
//     ninguna firma: le pide el veredicto al server por el MISMO canal y le cree. Quien reescribe
//     una respuesta reescribe la otra, y la comparación de abajo termina comparando dos valores
//     del atacante.
//   · NO detecta que el `beneficiary` sea LEGÍTIMO: nuestro servidor firma lo que dijo el AGENTE
//     de payout. Si el agente miente, la atestación certifica la mentira sin pestañear.
//   La defensa que sí alcanza al intermediario corre SERVER-SIDE en el settle: compara el
//   beneficiary de los bytes de la tx firmada contra la deposit-address que el servidor persistió
//   al preparar (app/api/settle/solana-sponsor/route.ts). Esta capa corta antes de que la persona
//   firme, que es su valor real, pero no es la que decide.
//
// [NC-1]/[NC-2] (founder-gated, FUERA de F3): la resolución REAL del beneficiary (deposit-address Solana
// de TransFi por orden) y la respuesta Solana-shaped del server (`{beneficiary, authority, ...}` base58)
// son founder-gated — hasta que el agente que resuelva `remittance-payout` exponga el destino Solana.
// (Cuál agente sea no lo elige este repo: lo resuelve el gateway al ejecutar.) El binding/
// atestación queda listo. Este gateway se unit-testea con un mock (FakeSolanaPayoutPrepareGateway).
import {
  PREPARE_NO_AGENT_FOR_CAPABILITY,
  PREPARE_REJECTION_ENUMS,
} from "../../application/agent-rejections";
import type { AgentRef, Beneficiary } from "../../domain/remittance";
import type { PopSigner, SolanaPayoutPrepareGateway, WalletPossessionProof } from "../../application/ports";

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
      // WKH-332/AC-13 — 422 "ninguna capacidad resolvió". Va acá y NO en PREPARE_REJECTION_ENUMS a
      // propósito: esa constante habilita el copy "El agente de pagos rechazó esta remesa", y acá no
      // hubo agente que rechazara nada. Sin este `case` caería en el `prepare_rejected` de abajo —el
      // default de "4xx que no reconozco"— y el enum nuevo no lo vería nadie: existiría en la route
      // y la pantalla seguiría diciendo "Algo salió mal".
      case PREPARE_NO_AGENT_FOR_CAPABILITY:
        return error; // enum estable de la route → se propaga 1:1
      default:
        break;
    }
    // Familia rechazo-del-agente (422). Se propagan 1:1 igual que los de arriba, pero se listan
    // aparte y desde la constante compartida en vez de a mano: son el enum que la route deriva del
    // `reason` del agente, y escribirlos otra vez acá es cómo se desincronizan las dos puntas.
    // Sin este bloque caerían en el `prepare_rejected` de abajo, que es el default de "4xx que no
    // reconozco" — o sea, exactamente el aplanamiento que este arreglo vino a deshacer.
    if (PREPARE_REJECTION_ENUMS.includes(error)) return error;
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

/** Cuánto se espera al verificador antes de darlo por caído. Sin timeout, un fetch colgado deja la
 *  pantalla esperando para siempre después de "Confirmar y enviar" y antes de que la wallet pida una
 *  sola firma: la persona no ve ni un error ni un avance. Con timeout, el resultado es `unavailable`
 *  (que bloquea) y la persona recibe un fallo en vez de un cuelgue. 10s: es un POST same-origin. */
const ATTESTATION_TIMEOUT_MS = 10_000;

/**
 * Pide a /api/payout/attestation que verifique el HMAC de la atestación y devuelva el
 * beneficiary+authority que están DENTRO del payload firmado.
 *
 * TRES desenlaces, no dos (lección WKH-308: "no pude preguntar" NO es "no"):
 *   · `verified`    ⇒ el server verificó la firma y devolvió lo que hay ADENTRO del payload firmado.
 *   · `unverified`  ⇒ el server dijo que NO valida (403). Es una respuesta, y es negativa.
 *   · `unavailable` ⇒ no hubo respuesta que leer (red caída, timeout, 503, un 200 ilegible). No dice
 *     nada sobre la atestación. Bloquea igual, pero se reporta con su propio enum: colapsarlo con
 *     `unverified` haría que un hipo de red se registre como "la firma no valida", que es una
 *     acusación sobre algo que no se comprobó.
 *
 * Vive en el server porque el secreto vive en el server: `DEPOSIT_ATTESTATION_SECRET` no se manda
 * al browser, así que el browser no puede recalcular el HMAC por su cuenta. Decodificar el payload
 * acá sin verificar la firma no serviría de nada: el que puede alterar el beneficiary también
 * puede re-armar un payload que diga lo que quiera.
 *
 * ⚠️ ACÁ NO SE VERIFICA NINGUNA FIRMA. Esta función hace un POST y le cree al 200: `res.ok` más dos
 * `typeof === "string"`. El veredicto sobre el HMAC lo emite el server. Por eso NO cubre a un
 * intermediario capaz de reescribir las dos respuestas (le basta poner su dirección en las dos);
 * sí cubre al que sólo toca la de prepare, al replay de otra remesa y a los bugs propios. El
 * detalle completo, con el repro, está en app/api/payout/attestation/route.ts.
 */
async function verifyAttestation(
  attestation: string,
  remittanceId: string,
  quoteId: string,
): Promise<
  | { state: "verified"; beneficiary: string; authority: string }
  | { state: "unverified" }
  | { state: "unavailable" }
> {
  let res: Response;
  try {
    res = await fetch("/api/payout/attestation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attestation, remittanceId, quoteId }),
      // Un cuelgue del verificador NO puede colgar el flujo: sin esto, un fetch que nunca resuelve
      // deja a la persona esperando sin error y sin firma que aprobar.
      signal: AbortSignal.timeout(ATTESTATION_TIMEOUT_MS),
    });
  } catch {
    return { state: "unavailable" }; // red caída / timeout ⇒ no se preguntó, no se acusa
  }
  // 403 es LA respuesta negativa de la route (attestation_unverified). Cualquier otro no-ok
  // (503 sin secreto, 5xx, 429) es la ruta diciendo que no pudo, no que no valida.
  if (res.status === 403) return { state: "unverified" };
  if (!res.ok) return { state: "unavailable" };
  let out: unknown;
  try {
    out = await res.json();
  } catch {
    return { state: "unavailable" }; // 200 ilegible ⇒ no hay veredicto que leer
  }
  if (!isRecord(out)) return { state: "unavailable" };
  if (typeof out.beneficiary !== "string" || !out.beneficiary) return { state: "unavailable" };
  if (typeof out.authority !== "string" || !out.authority) return { state: "unavailable" };
  return { state: "verified", beneficiary: out.beneficiary, authority: out.authority };
}

/** Lee el `agent` que la route agrega al 200 (trazabilidad). Sin `slug` no hay identidad que
 *  afirmar ⇒ `undefined`: la remesa queda diciendo "no sé quién", que es la verdad. NUNCA bloquea
 *  el prepare: saber o no saber quién atendió no cambia la validez del destino, y hacerlo
 *  bloqueante convertiría un dato de auditoría en un modo de falla del money-path. */
function readAgentRef(raw: unknown): AgentRef | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.slug !== "string" || !raw.slug) return undefined;
  return {
    slug: raw.slug,
    // Ausente ⟹ ausente. Un "" de relleno afirmaría un catálogo vacío (ver AgentRef en el dominio).
    ...(typeof raw.registry === "string" && raw.registry ? { registry: raw.registry } : {}),
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
    address: string;
    amountUsd: number;
    beneficiary: Beneficiary;
    idempotencyKey: string; proof?: WalletPossessionProof; // WKH-359/AC-2 — PEGADO a `idempotencyKey`, en la línea que existe, igual que en (`prepare`, `../../application/ports.ts:310`)
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
    // y ya corría en producción en el camino de refund (`pop.prove`, `http-solana-remittance-id-resolver.ts:30`);
    // lo único que faltaba era usarlo también acá.
    //
    // `prove(input.address)` firma para la MISMA address que viaja en el body: P3 de la route compara
    // canonicalizeAddress(challenge.address) contra canonicalizeAddress(body.address).
    //
    // 🔴 WKH-359/AC-2 — LA INYECCIÓN, Y POR QUÉ NO ES "ESTRECHAR EL CATCH". En el camino por enlace no
    // hay bridge, así que `this.pop.prove()` tira `wallet_sign_not_available` y el `catch` de abajo
    // lo convierte —correctamente— en `payout_pop_unavailable`: la remesa muere ahí. La alternativa
    // que el F1 dejó escrita era estrechar ese `catch`, y su costo es dejar pasar un tipo de excepción
    // a través de un guard fail-closed del money-path que existe porque *"nunca se postea sin PoP"*.
    // ⛔ Este camino NO TOCA EL GUARD (CD-17): cuando la prueba YA viene conseguida, no se le pide
    // nada a nadie y no hay excepción que atravesar. Es más barato **y** más seguro.
    //
    // ⛔ Y NO VIOLA CD-5 (reusar una prueba para saltearse un prompt del money-path). Las TRES
    // propiedades que lo sostienen están medidas con tests, no con prosa:
    //   (a) la prueba se pide UNA vez por `prepare`, y **el salto ES el popup**: la persona firma
    //       conscientemente, sólo que en otra app en vez de en una extensión;
    //   (b) el ancla es de UN SOLO USO (`consumido` + borrado al entregar) y de UN SOLO PROPÓSITO
    //       (`pop-payout` no sirve para `pop-kyc` ni al revés) — lo mide `T-067-17`;
    //   (c) su ventana la fija el `exp` del SERVIDOR, no el cliente — lo mide `T-067-18`.
    //
    // ⚠️ SIN `input.proof` ESTO CORRE BYTE-IDÉNTICO a como corría antes de esta HU. Lo mide `T-067-4`.
    let proof: Awaited<ReturnType<PopSigner["prove"]>>;
    if (input.proof) {
      proof = input.proof;
    } else {
      try {
        proof = await this.pop.prove(input.address);
      } catch {
        // Red caída / 400 / 5xx del emisor del challenge ⇒ no hay prueba que mandar. Fail-closed con el
        // MISMO enum que la route usa cuando no puede verificar: nunca se postea sin PoP.
        return { ok: false, reason: "payout_pop_unavailable" };
      }
    }
    if (!proof) {
      // `null` = el emisor respondió 501: el server NO tiene PAYOUT_POP_SECRET. La route lee ESA MISMA
      // env y respondería 503 `payout_pop_unavailable` (`POP_SECRET`, `../../../app/api/payout/prepare/route.ts:216`). Cortamos acá con el enum
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
          // 🔴 SIN `kycVerificationId` (WKH-333/AC-14'). La route lo resuelve desde su propia fila,
          // indexada por la dirección que el PoP de acá abajo prueba. Un cliente que lo mandara no
          // aportaría un dato: propondría con qué verificación de identidad se lo autoriza — y la
          // route lo pisa igual (AC-16), así que mandarlo sólo sería ruido en la red.
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
    // Los dos bloquean; el enum los separa. "No pude preguntar" (red, timeout, 503) no se registra
    // como "la firma no valida": la remesa fallada guarda el reason y ahí la diferencia importa.
    if (attested.state === "unavailable") {
      return { ok: false, reason: "prepare_attestation_unavailable" };
    }
    if (attested.state !== "verified") return { ok: false, reason: "prepare_attestation_unverified" };
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
