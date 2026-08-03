// Infrastructure — SolanaSettlementGateway sobre NUESTRA ruta server-only /api/settle/solana-sponsor
// (HU-SOL-13/AC-1). Corre en el CLIENTE: por eso llama SIEMPRE a /api/settle/solana-sponsor y JAMÁS a
// la URL del facilitador — el Bearer del facilitador vive server-side y nunca se expone al browser
// (CD-6). Este archivo no conoce ninguna env del facilitador.
//
// ⚠️ CD-13: la respuesta es una signature BASE58 — validarla con una regex hexadecimal la rechazaría
// siempre. Fail-closed: un 200 con shape raro NUNCA se vuelve un principal_in. Type-guards explícitos
// y mapErrorStatus sin default permisivo.
import type {
  SolanaSettlementFailureReason,
  SolanaSettlementGateway,
} from "../../application/ports";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// base58 (alfabeto Bitcoin/Solana): sin 0, O, I, l. Una signature de Solana es base58 (~87-88 chars);
// validamos el ALFABETO + longitud mínima, NO 0x-hex (CD-13). Sin default permisivo.
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{43,90}$/;

/** Mapa status/enum → reason estable. Fail-closed (CD-12): cualquier status/enum desconocido ⇒ un
 *  reason que BLOQUEA. Sin default permisivo (lección WKH-198). El enum de la route es nuestro.
 *
 *  ⚠️ El default era `solana_settle_rejected`, y eso decía DE MÁS. Bloquear está bien; el problema es
 *  que "rejected" significa "se cortó ANTES de broadcastear", y aguas arriba el use-case usa esa
 *  distinción para decidir si hace falta ir a mirar la cadena. Un status que este mapa no conoce no
 *  dice dónde se originó: puede venir de un intermediario (proxy/CDN/página de error de Next) que se
 *  metió DESPUÉS de que la route ya reenvió al facilitator y el depósito ya entró. Etiquetarlo
 *  "rejected" hacía que nadie fuera a preguntar, y la plata quedaba adentro con la remesa diciendo
 *  que no había entrado. Ahora lo desconocido cae en el bucket INDETERMINADO: bloquea igual, y no
 *  afirma lo que no sabe. Lo que SÍ se puede afirmar tiene su rama explícita (400/501/422/429). */
function mapErrorReason(status: number, error: unknown): SolanaSettlementFailureReason {
  if (typeof error === "string") {
    switch (error) {
      case "solana_settle_rejected":
      case "sponsor_rejected":
        return "solana_settle_rejected";
      case "solana_settle_rate_limited":
        return "solana_settle_rate_limited";
      case "solana_settle_broadcast_failed":
        return "solana_settle_broadcast_failed";
      case "solana_settle_unavailable":
      // "no pude preguntarle al ledger" (503 de S3.5): reintentable, y NO se traduce a un rechazo.
      // LÍMITE CONOCIDO, y es del lado seguro: este caso se corta ANTES del forward (la route no
      // llegó al fetch), o sea que "no entró" es un hecho; pero comparte reason con el 503 del
      // timeout, que SÍ es posterior al broadcast. Aguas arriba, entonces, se lo trata como
      // indeterminado: se le pregunta a la cadena. El costo máximo es una consulta de más y, si esa
      // consulta también se cae, decirle a la persona "todavía no sabemos" cuando podríamos decirle
      // "no salió". Nunca al revés: de acá no sale un cobro ni un comprobante de reembolso.
      // Separarlos pide un reason propio en SolanaSettlementFailureReason; queda anotado, no hecho.
      case "solana_settle_ledger_unavailable":
        return "solana_settle_unavailable";
      // S3.5 del settle: el destino se comparó contra lo que el servidor registró al preparar y NO
      // coincide. Se mapea a un reason propio en vez de caer al 409 → broadcast_failed de abajo, que
      // diría "no se pudo transmitir" sobre una tx que nunca se intentó transmitir.
      case "solana_settle_beneficiary_mismatch":
        return "solana_settle_beneficiary_mismatch";
      // El servidor no pudo comparar (nada registrado / tx ilegible). Bloquea igual, pero el
      // diagnóstico es "no se comprobó", no "no coincide": son cosas distintas y se cuentan distinto.
      case "solana_settle_beneficiary_unregistered":
      case "solana_settle_deposit_unreadable":
        return "solana_settle_beneficiary_unconfirmed";
      // SDD 037 — el facilitator no reconoció la firma como autorización de esta tx. Reason PROPIO
      // y NO `unavailable`: un rechazo no es una indisponibilidad. Reintentar con la misma tx da
      // siempre lo mismo, así que tratarlo como "el servicio no está" mandaría a la persona a
      // esperar por algo que no va a cambiar solo.
      case "solana_settle_sender_proof_invalid":
        return "solana_settle_sender_proof_invalid";
      // enum NUEVO / desconocido cae abajo: bloquea igual.
      default:
        break;
    }
  }
  // SDD 037 — el 403 sale de los guards del facilitator, que corren antes de firmar y antes de
  // reservar cap. Va ANTES del `unavailable` del final a propósito: sin esta rama, un 403 sin enum
  // reconocible caería al bucket indeterminado y dispararía una consulta a la cadena por una tx que
  // nunca se transmitió.
  if (status === 403) return "solana_settle_sender_proof_invalid";
  if (status === 422) return "solana_settle_rejected"; // CR-1 del deposit rechazó
  if (status === 429) return "solana_settle_rate_limited";
  // 400/501: nuestra propia route cortó ANTES de reenviar (request inválido / settlement apagado).
  // La tx no salió, y eso sí se puede afirmar.
  if (status === 400 || status === 501) return "solana_settle_rejected";
  if (status === 409 || status === 502) return "solana_settle_broadcast_failed"; // blockhash/broadcast
  if (status === 503 || status === 504) return "solana_settle_unavailable";
  return "solana_settle_unavailable"; // desconocido ⇒ bloquea, y NO afirma que el deposit no salió
}

/** Shape del 200. Validado explícitamente (CD-13): un 200 con shape raro NO puede volverse un
 *  principal_in. La signature es base58 (NO 0x-hex). */
function isValidSolanaSettleShape(v: unknown): v is { signature: string } {
  if (!isRecord(v)) return false;
  if (typeof v.signature !== "string" || !BASE58_SIGNATURE.test(v.signature)) return false;
  return true;
}

export class HttpSolanaSettlementGateway implements SolanaSettlementGateway {
  async settle(input: {
    partialSignedTx: string;
    reference: string;
    sender: string;
    remittanceId: string;
    popSignature: string;
  }): Promise<
    | { ok: true; signature: string }
    | { ok: false; reason: SolanaSettlementFailureReason }
  > {
    let res: Response;
    try {
      res = await fetch("/api/settle/solana-sponsor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          partialSignedTx: input.partialSignedTx,
          reference: input.reference,
          sender: input.sender,
          remittanceId: input.remittanceId, // server-only, trazabilidad
          // SDD 037 — va SIEMPRE, ya no condicional: es la firma del mensaje que la persona leyó y
          // aprobó. Si falta, la route corta con 400 y el facilitator con 403.
          popSignature: input.popSignature,
        }),
      });
    } catch {
      return { ok: false, reason: "solana_settle_unavailable" }; // red caída ⇒ fail-closed
    }

    if (!res.ok) {
      let error: unknown;
      try {
        const body: unknown = await res.json();
        error = isRecord(body) ? body.error : undefined;
      } catch {
        error = undefined;
      }
      return { ok: false, reason: mapErrorReason(res.status, error) };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: "solana_settle_unverified" };
    }
    if (!isValidSolanaSettleShape(body)) return { ok: false, reason: "solana_settle_unverified" };
    return { ok: true, signature: body.signature };
  }
}
