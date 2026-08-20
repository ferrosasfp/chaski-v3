// Server-side: consulta (y backfill) del VEREDICTO de KYC de una dirección (WKH-333/AC-5..AC-13).
//
// Devuelve si la persona tiene una verificación de identidad vigente y utilizable, SIN devolver nunca
// el `verification_id` — ni en el 200, ni en ningún error, ni al dueño PoP-verificado (AC-6/CD-9).
// Ese identificador es una CREDENCIAL del money-path: es lo que el backend le presenta a la autoridad
// de KYC al pagar.
//
// ⚠️ ACÁ DECÍA que "lo único que WKH-333 cambia de fondo es que deja de viajar por la red", y es
// medible y falso (AR/MNR-4): sigue viajando en los dos sentidos, servidor→navegador en el
// `GET /api/kyc/decision` y navegador→servidor como `candidateVerificationId` de ESTE endpoint. Lo
// cierto, y es otra cosa: deja de ATRAVESAR UN CONTROL DEL MONEY-PATH. Ya no es un token al portador
// que autoriza un desembolso por el solo hecho de presentarlo; el que autoriza sale de la fila del
// dueño PoP-verificado. Que además viaje menos sería una consecuencia deseable, y no es la que se
// consiguió.
//
// Guard-order fail-closed (envs en runtime, CD-14): V1 secreto PoP → V2 rate-limit → V3 body →
// V4 PoP P1..P5 → V5 store → V6 TTL → V7 lectura owner-scoped → V8 backfill → V9 juicio →
// V9.5 credencial del money-path (WKH-233/H-2a) → 200.
// Exemplar: (`POST`, `../../solana/escrow/remittance-ids/route.ts:46`) y su cadena de guards hasta el
// final del archivo (`:145`). ⚠️ ACÁ DECÍA `:39-137`, y los DOS extremos eran falsos: `:39` es
// `const MAX_IDS = …` (el handler arranca en `:46`) y `:137` cae en medio de la última lectura. Se
// ancla al símbolo para que el candado lo vigile, en vez de a un rango que nada verifica.
//
// 🔴 V5 Y V6 VAN DESPUÉS DEL PoP, y no es cosmético. Si el chequeo del flag fuese antes, un caller
// ANÓNIMO distinguiría "la tabla no está encendida" (501) de "está encendida y no sos vos" (403), y
// eso ya es medio oráculo. Es exactamente lo que el exemplar resolvió en su R5:
// (`getSettlementLedger`, `../../solana/escrow/remittance-ids/route.ts:125`), con su 501 en `:127`.
// ⚠️ ACÁ DECÍA `117-121`: LA PROSA ERA CORRECTA Y LOS NÚMEROS NO — en `:117-121` vive el bloque P5
// del PoP (la verificación ed25519), no el orden flag-vs-PoP que la frase describe.
//
// 🔴 V7 CONSULTA CON `ch.address`, NUNCA CON `body.sender`. `body.sender` sólo existe para poder
// rechazar temprano lo malformado; el valor que toca la base es el del challenge PoP-verificado
// (CD-18). Comparar un valor consigo mismo es el bloqueante que 041 documentó dos veces.
//
// TODO defensivo: NUNCA 500 crudo, NUNCA eco del `error.code` de Postgres, NUNCA PII.
import { NextResponse } from "next/server";
import type { KycVerdictRecord, KycVerdictStore } from "../../../../src/application/ports";
import {
  buildSolanaPopMessage,
  verifySolanaPopChallenge,
} from "../../../../src/infrastructure/auth/pop-challenge";
import { verifySolanaPop } from "../../../../src/infrastructure/auth/pop-verify-solana";
import { resolveSolanaNetworkId } from "../../../../src/infrastructure/chain";
import { canonicalizeAddress } from "../../../../src/infrastructure/address";
import { getKycVerdictStore } from "../../../../src/infrastructure/persistence/supabase-kyc-verdicts";
import { getKycSessionTokenStore } from "../../../../src/infrastructure/persistence/supabase-kyc-session-tokens";
import { resolveKycVerdictTtlDays } from "../../../../src/infrastructure/kyc-verdict-ttl-env";
import { isVerdictExpired } from "../../../../src/infrastructure/kyc-verdict-ttl";
import { resolvePayoutAuthority } from "../../../../src/infrastructure/payout/authority";
import {
  KYC_VERDICT_RL,
  checkRouteRateLimit,
  clientIp,
} from "../../../../src/infrastructure/rate-limit";
// 🔴 WKH-233 — ACÁ ESTABA LA ÚNICA IMPORTACIÓN DE `src/presentation/**` DESDE UNA ROUTE DE ESTE
// REPO (`isKycDemo`), y se fue con la allow-list local que consultaba. La arista capa-a-capa que
// justificaba ("una sola fuente del juicio") dejó de existir porque el juicio dejó de estar acá.

// Excluye arrays (mirror de prepare/route.ts).
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// `no-store` en TODA respuesta: el veredicto de identidad de una persona no se cachea en ningún
// intermediario, ni el 200 ni el 403.
function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

export async function POST(req: Request): Promise<Response> {
  // V1 — sin secreto no se puede verificar NINGÚN PoP ⇒ 503 fail-closed. Sin esto el endpoint
  // degradaría a IDOR abierto sobre el estado de verificación de identidad de cualquiera.
  const POP_SECRET = process.env.PAYOUT_POP_SECRET; // CD-14: dentro del handler
  if (!POP_SECRET) {
    return json({ error: "kyc_verdict_unavailable" }, 503);
  }

  // V2 — rate-limit IP-only, TRAS V1 y ANTES de parsear/verificar: el bloque de abajo hace HMAC +
  // ed25519, o sea CPU, y sin límite eso es un DoS barato. IP-only porque el body todavía no existe.
  const rl = await checkRouteRateLimit(KYC_VERDICT_RL, { ip: clientIp(req) });
  if (rl.unavailable) {
    return json({ error: "kyc_verdict_unavailable" }, 503); // fail-closed
  }
  if (!rl.ok) {
    return json({ error: "kyc_verdict_rate_limited" }, 429, {
      "Retry-After": String(rl.retryAfter ?? 60),
    });
  }

  // V3 — body null-safe: `req.json()` RESUELVE `null` para el body literal `null` (el .catch NO
  // dispara); isRecord cubre null y los no-objeto por igual.
  const parsed: unknown = await req.json().catch(() => null);
  const body: Record<string, unknown> = isRecord(parsed) ? parsed : {};
  const rawSender = typeof body.sender === "string" ? body.sender : "";
  let sender: string;
  try {
    sender = canonicalizeAddress(rawSender);
  } catch {
    return json({ error: "kyc_verdict_invalid_request" }, 400);
  }

  // V4 — proof-of-possession Solana OBLIGATORIO. Copiado del bloque P1..P5 del money-path
  // (prepare/route.ts). CUALQUIERA de los cinco fallos colapsa en el MISMO 403, con el MISMO cuerpo:
  // distinguirlos convertiría este endpoint en un oráculo del motivo (no-oracle).
  const popChallenge = body.popChallenge;
  const popSignature = body.popSignature;
  // P1 — presencia + tipo.
  if (
    typeof popChallenge !== "string" ||
    !popChallenge.trim() ||
    typeof popSignature !== "string" ||
    !popSignature.trim()
  ) {
    return json({ error: "kyc_verdict_unverified" }, 403);
  }
  // P2 — HMAC + exp + tipos colapsan en null.
  const ch = verifySolanaPopChallenge(popChallenge, Date.now());
  if (!ch) {
    return json({ error: "kyc_verdict_unverified" }, 403);
  }
  // P3 — address match (base58 case-sensitive): el challenge tiene que ser DE ESTE sender. Sin esto,
  // un caller presentaría el challenge+firma de la wallet A y pediría el veredicto de la wallet B.
  try {
    if (canonicalizeAddress(ch.address) !== sender) {
      return json({ error: "kyc_verdict_unverified" }, 403);
    }
  } catch {
    return json({ error: "kyc_verdict_unverified" }, 403);
  }
  // P4 — binding CAIP-2: el network-id del token vs el resuelto server-side, NUNCA del body.
  if (ch.networkId !== resolveSolanaNetworkId()) {
    return json({ error: "kyc_verdict_unverified" }, 403);
  }
  // P5 — ed25519 sobre el mensaje reconstruido con la MISMA buildSolanaPopMessage.
  if (
    !verifySolanaPop({
      addressBase58: ch.address,
      message: buildSolanaPopMessage(ch),
      signatureBase58: popSignature,
    })
  ) {
    return json({ error: "kyc_verdict_unverified" }, 403);
  }

  // Desde acá, y sólo desde acá, el caller probó que la billetera es suya. Todo lo que sigue habla
  // exclusivamente de SU propia situación, así que ya no hay oráculo posible.
  const owner = canonicalizeAddress(ch.address); // ← la PoP-verificada, NUNCA body.sender (CD-18)

  // V5 — el store DESPUÉS del PoP (ver la cabecera).
  const store = getKycVerdictStore();
  if (!store) {
    return json({ error: "kyc_verdict_not_enabled" }, 501);
  }

  // V6 — el TTL DESPUÉS del PoP, por la misma razón que V5. Fail-loud: una configuración de
  // vencimiento inválida NO degrada a un default (AC-4/CD-8), corta.
  let ttlDays: ReturnType<typeof resolveKycVerdictTtlDays>;
  try {
    ttlDays = resolveKycVerdictTtlDays();
  } catch {
    // El mensaje del throw nombra la env y el valor; NO se filtra al cliente.
    return json({ error: "kyc_verdict_misconfigured" }, 503);
  }

  // V7 — lectura OWNER-SCOPED con la dirección PoP-verificada.
  let record: Awaited<ReturnType<typeof store.get>>;
  try {
    record = await store.get(owner);
  } catch {
    // NUNCA 500 crudo, NUNCA eco del error.code de Postgres.
    return json({ error: "kyc_verdict_unavailable" }, 502);
  }

  // V8 — BACKFILL, sólo si no hay fila. El navegador aporta una PISTA (`candidateVerificationId`) y
  // nada más: por dónde preguntar. NO se le cree — el propio `ports.ts` dice que los booleanos del
  // localStorage son atacante-controlables. Se re-consulta a la autoridad con la dirección
  // PoP-VERIFICADA, y la autoridad compara el `vendor_data` que Didit ecoa contra esa dirección.
  if (!record) {
    const candidate =
      typeof body.candidateVerificationId === "string" ? body.candidateVerificationId.trim() : "";
    if (candidate) {
      record = await backfill(store, candidate, owner);
    }
  }

  // V9 — 200 con el juicio aplicado. SIN `verificationId` en ninguna rama (AC-6).
  if (!record) return json({ verdict: null, reason: "absent" }, 200);
  // Orden del juicio: primero lo que dijo la autoridad (`approved`), después de dónde salió
  // (`provenance`), y al final la vigencia. Los tres viajan sólo detrás del PoP, o sea sólo al dueño,
  // y existen para que la pantalla pueda decir "tu verificación venció" sin inventarlo.
  if (!record.approved) return json({ verdict: null, reason: "not_approved" }, 200);
  // 🔴 WKH-233 — ACÁ ESTABA `if (isKycDemo(record.provenance)) return … reason:"simulated"`, y YA NO
  // HACE FALTA: desde esta HU `app/api/kyc/decision/route.ts` escribe la fila SÓLO cuando el agente
  // devuelve `payoutAllowed === true`, y ese booleano ya exige que la proveniencia esté en su
  // allow-list de verificaciones REALES. ⇒ POR INVARIANTE, una fila que existe es real.
  //
  // ⚠️ CONSECUENCIA DECLARADA, no escondida: una verificación simulada deja de producir fila, así que
  // este endpoint responde `absent` donde antes respondía `simulated`. **Se pierde poder decir
  // "preguntamos y era una demo"**; se conserva la distinción que sostiene el tipo
  // (`usable`/`absent`/`not_asked`), que es la que impide usar `usable` como default de "no pude
  // preguntar". El miembro `"simulated"` se borró de `KycVerdictAbsentReason` en vez de dejarlo "por
  // las dudas": un valor que NINGÚN código puede producir es superficie muerta en un borde de
  // confianza, y el próximo que lo lea va a creer que pasa.
  if (isVerdictExpired(record.verifiedAt, ttlDays, Date.now())) {
    return json({ verdict: null, reason: "expired" }, 200);
  }

  // V9.5 — LA CREDENCIAL DEL MONEY-PATH: LA MISMA PREGUNTA QUE HACE EL PAGO, HECHA ACÁ (WKH-233 fix-pack · H-2a).
  //
  // 🔴 QUÉ CALLEJÓN SIN SALIDA CIERRA. Hasta acá esta ruta contestaba `usable` mirando SÓLO la fila de
  // `kyc_verdicts`. El pago mira otra cosa: `resolvePayoutAuthority` exige la fila de
  // `kyc_session_tokens` para el par (sesión, dueño) —(`getForOwner`, `../../../../src/infrastructure/payout/authority.ts:150`)— y sin ella corta con
  // `kyc_ownership_mismatch` ⇒ `payout_not_authorized`/403. La consecuencia medida: `usable` mandaba a
  // la persona de `connect` derecho a `confirm` **sin mostrar nunca la pantalla de verificación**, y
  // ahí moría en el prepare, sin camino de vuelta. Preguntar lo mismo que pregunta el pago es lo que
  // vuelve `usable` una afirmación sobre el pago y no sobre una tabla.
  //
  // ⛔ VA DESPUÉS DEL TTL Y NO ANTES: si la fila ya venció, `expired` es lo cierto y es más informativo
  // que "no hay credencial". Un `absent` genérico se comería ese motivo.
  //
  // 🔴 Y LOS DOS FALLOS DE LECTURA **NO** SALEN POR `absent`, QUE ES LA PARTE QUE IMPORTA. `absent`
  // prende `servidorDiceQueNoHayFila` en `../../../../src/application/use-cases/start-kyc.ts:109`, que
  // apaga el atajo KYC-once ⇒ la persona vuelve a escanear el documento y se quema un cupo del tier
  // gratuito (500/día). Mandar ahí a alguien que SÍ está verificado, porque la base se cayó, es el
  // "no pude preguntar" leído como "no hay" que la doctrina de
  // `../../../../src/infrastructure/kyc/http-kyc-verdict-gateway.ts:19-24` prohíbe explícitamente. Por
  // eso salen por el 502 que esta ruta YA tiene: el gateway lo LANZA, `ConnectWallet` lo degrada a
  // "seguimos como hoy" y el atajo local sigue vivo.
  //
  // ⚠️ LA RAMA `!tokenStore` ES INALCANZABLE HOY, Y SE ESCRIBE IGUAL: V5 ya devolvió 501 si no hay
  // cliente de Supabase, y las DOS fábricas salen del MISMO `getSupabaseServerClient()`
  // (`../../../../src/infrastructure/persistence/supabase-kyc-session-tokens.ts:145`). O sea que hoy
  // no se puede llegar acá con `store` presente y `tokenStore` ausente. Es un acoplamiento entre dos
  // fábricas que nada vigila, así que el `if` fail-closed se queda: el día que una de las dos cambie
  // de condición, esto corta en vez de contestar `usable` sin haber podido mirar la credencial.
  const tokenStore = getKycSessionTokenStore();
  if (!tokenStore) return json({ error: "kyc_verdict_unavailable" }, 502);
  let credencial: string | null;
  try {
    credencial = await tokenStore.getForOwner(record.verificationId, owner);
  } catch {
    // NUNCA 500 crudo, NUNCA eco del SQLSTATE. Y NUNCA `absent`: ver arriba.
    return json({ error: "kyc_verdict_unavailable" }, 502);
  }
  // ⚠️ ACÁ NO SE DEVUELVE UN MOTIVO NUEVO. `absent` es la forma que esta ruta YA emite en `:182` y que
  // el cliente ya sabe leer (`ABSENT_REASONS`); un motivo nuevo cae en el `readAbsentReason` del
  // gateway y se lee como `absent` de todos modos, pero además ensancha un borde de confianza para no
  // decir nada nuevo. Lo cierto es lo mismo que dice `absent`: no hay veredicto UTILIZABLE.
  if (credencial === null) return json({ verdict: null, reason: "absent" }, 200);

  return json(
    {
      verdict: {
        riskLevel: record.riskLevel,
        provenance: record.provenance,
        verifiedAt: record.verifiedAt,
      },
    },
    200,
  );
}

/**
 * Backfill (AC-8): re-consulta la autoridad con la pista del navegador y persiste **sólo si vuelve
 * autorizada**. Devuelve la fila recién escrita, o `null` si no hubo nada que escribir.
 *
 * 🔴 PROHIBIDO persistir a partir del booleano del navegador (AC-8) y PROHIBIDO persistir cuando la
 * autorización vino de la rama `simulated_dev` de `authority.ts` (CD-24): esa rama autoriza SIN
 * consultar a Didit — existe para que el demo local ande — y una fila escrita desde ahí sería, con
 * el flag encendido, fuente de autoridad de un pago real.
 *
 * `verifiedAt` es **el momento en que la autoridad confirmó la verificación**, que es lo único que
 * este código midió. NO es la fecha del escaneo original: ese dato no viaja por `resolvePayoutAuthority`.
 * Consecuencia declarada, y no es gratis: para quien se verificó hace mucho, el backfill reinicia el
 * reloj del vencimiento. Se acepta porque la autoridad —que es quien sabe, y que tiene su propio
 * estado terminal `Kyc Expired`— acaba de decir que sí, ahora.
 *
 * 🔴 CUÁNTO ES "REINICIAR EL RELOJ", CON NÚMEROS (AR/MNR-6). El tiempo efectivo entre el escaneo real
 * y el vencimiento server-side es **Δ + TTL**, donde Δ es la antigüedad de la verificación cuando
 * corre este backfill. Con el TTL por defecto de 365 días y una pista de 300 días de antigüedad, son
 * **~665 días** desde que la persona mostró el documento. ⛔ Y ese Δ **no tiene techo en NUESTRO
 * código**: `LocalKycStore.peek()` no aplica TTL a propósito, así que una pista de cualquier edad
 * dispara el backfill. El único techo lo pone la autoridad, el día que deje de contestar `Approved`
 * para esa sesión. Quien fije la política de vencimiento tiene que fijarla sabiendo esto: el número
 * que le importa a un auditor no es el TTL, es Δ + TTL.
 *
 * Best-effort: si la escritura falla, se sigue como si no hubiera fila. Nunca rompe la respuesta.
 */
async function backfill(
  store: KycVerdictStore,
  candidateVerificationId: string,
  owner: string,
): Promise<KycVerdictRecord | null> {
  let decision: Awaited<ReturnType<typeof resolvePayoutAuthority>>;
  try {
    decision = await resolvePayoutAuthority({
      verificationId: candidateVerificationId,
      address: owner, // la PoP-verificada: la autoridad compara el vendor_data ecoado contra ESTA
    });
  } catch {
    return null; // la autoridad no contestó ⇒ no se escribe nada
  }
  // Las tres condiciones son conjuntas y ninguna es redundante:
  //   · authorized      — la autoridad dijo que sí.
  //   · reason ausente  — `simulated_dev` también viene con authorized:true (CD-24).
  //   · provenance      — sin proveniencia declarada no hay qué persistir sin inventarlo.
  if (!decision.authorized) return null;
  if (decision.reason === "simulated_dev") return null;
  if (!decision.provenance || !decision.riskLevel) return null;

  const record: KycVerdictRecord = {
    senderAddress: owner,
    verificationId: candidateVerificationId,
    approved: true,
    riskLevel: decision.riskLevel,
    provenance: decision.provenance,
    verifiedAt: new Date().toISOString(), // ver el docblock: es cuándo la autoridad lo confirmó
  };
  try {
    await store.put(record);
  } catch {
    // La fila no quedó, pero la respuesta de esta llamada es la misma que si hubiera quedado: el
    // caller ya tiene el veredicto en la mano y el próximo `ensure` reintenta.
    return record;
  }
  return record;
}
