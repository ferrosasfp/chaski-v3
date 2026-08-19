// Server-side: consulta la decisión de una sesión de verificación EN EL AGENTE `remit-kyc-validator`
// (WKH-233). Este repo YA NO le habla al proveedor de KYC ni mapea su payload: el mapeo lo hace el
// agente y acá se consume su salida ya juzgada.
//
// Guard-order (P-7, intacto): 501 → 500 → 400 → 401 → el store del token → recién el borde.
// ⛔ NUNCA un viaje al agente sin haber pasado el HMAC. Su candado (T-TOK-5) NO mira el status: cuenta
// llamadas al store y al `fetch`, las dos en CERO.
//
// 🔴 DE DÓNDE SALE LA CREDENCIAL DEL BORDE, Y POR QUÉ NO PUEDE VENIR DEL CALLER. El agente exige un
// `decisionToken` en `x-kyc-decision-token`. El único input del caller acá es el `sessionId` y el
// HMAC de Chaski, así que la credencial sale DEL STORE server-side y de ningún otro lado (CD-20). Que
// el navegador la trajera sería devolverle al cliente una credencial del money-path, o sea el agujero
// exacto que WKH-333 cerró con el `kycVerificationId`.
//
// 🔴 LA LECTURA DEL STORE ES LA ÚNICA EXCEPCIÓN A CD-19 (sin filtro por dueño), y su motivo está
// escrito DENTRO del store, no en `doc/`: este camino POR CONSTRUCCIÓN no tiene dueño al que filtrar
// —una sesión creada sin prueba de posesión no tiene dirección probada— y exigirlo dejaría a esa
// persona sin poder leer su propio veredicto. Su guard equivalente es el HMAC, que corre ANTES.
//
// ⚠️ ESTA ROUTE YA NO DEVUELVE NINGÚN DATO DE IDENTIDAD, porque el agente no devuelve ninguno: ni
// nombre, ni apellidos, ni tipo/número de documento —tampoco sus últimos 4—. Por eso desapareció el
// enmascarado: no hay nada que enmascarar. Y por eso `IdentityBadge` se rediseñó (D-2): tal como
// estaba, la tarjeta se habría borrado de la pantalla sin que nadie lo notara.
import { NextResponse } from "next/server";
import type { KycAgentDecisionOutput } from "../../../../src/infrastructure/kyc/agent-contract";
import { readAgentKycDecision } from "../../../../src/infrastructure/kyc/agent-kyc-client";
import { resolveKycAgentBaseUrl } from "../../../../src/infrastructure/kyc/agent-env";
import { canonicalizeAddress } from "../../../../src/infrastructure/address";
import { getKycVerdictStore } from "../../../../src/infrastructure/persistence/supabase-kyc-verdicts";
import { getKycSessionTokenStore } from "../../../../src/infrastructure/persistence/supabase-kyc-session-tokens";
import { logLedgerAlert } from "../../../../src/infrastructure/persistence/ledger-alert";
import { verifySessionToken } from "../../../../src/infrastructure/kyc-auth";

export async function GET(req: Request): Promise<Response> {
  // 501 = sin host del agente. Mismo status que devolvía el guard de la credencial del proveedor, y
  // por el mismo motivo: es el interruptor de rollback de WKH-233 (D-1).
  try {
    resolveKycAgentBaseUrl();
  } catch {
    return NextResponse.json({ error: "kyc_agent_not_configured" }, { status: 501 });
  }

  if (!process.env.KYC_SESSION_SECRET) {
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "missing_session" }, { status: 400 });

  // Auth (P-5/P-6): MISMO cuerpo y MISMO status para "sin token" y "token inválido"
  // (anti-enumeración). NO se toca el store NI se llama al agente en ninguno de los dos casos.
  const token = req.headers.get("x-kyc-token");
  if (!token || !verifySessionToken(sessionId, token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // La credencial del borde. ⛔ SIN FILA ⇒ 502 CON EL MISMO CÓDIGO que un fallo del agente, y NO se
  // distingue del token inválido: distinguirlos sería un oráculo de "esa sesión existe" (P-6).
  const tokenStore = getKycSessionTokenStore();
  let fila: Awaited<ReturnType<NonNullable<typeof tokenStore>["readForVerifiedSession"]>> = null;
  try {
    fila = tokenStore ? await tokenStore.readForVerifiedSession(sessionId) : null;
  } catch {
    fila = null; // un fallo de la base tampoco se distingue: mismo 502, sin eco del SQLSTATE
  }
  if (!fila) {
    return NextResponse.json({ error: "kyc_decision_failed", upstream: 0 }, { status: 502 });
  }

  // 🔴 `identityClaim` SÓLO SI LA FILA TIENE DUEÑO (D-6). Sin dueño ⇒ la clave NO se manda ⇒ el
  // agente OMITE `identityMatches` ⇒ su `payoutAllowed` es `false` ⇒ NO se escribe fila y la pantalla
  // dice "sin verificar". Es correcto: una sesión sin atar no se puede afirmar como de esa billetera.
  // ⛔ PROHIBIDO rellenar el claim con `body.address`, con la dirección conectada o con cualquier
  // valor que no haya salido de una prueba de posesión: eso reabre R-1.
  const r = await readAgentKycDecision({
    sessionId,
    identityClaim: fila.ownerAddress ?? undefined,
    decisionToken: fila.token,
  });
  if (!r.ok) {
    return NextResponse.json(
      { error: "kyc_decision_failed", upstream: r.upstream },
      { status: 502 },
    );
  }

  const d = r.output;
  // El momento en que ESTE servidor observó el desenlace terminal. Se computa UNA vez y se usa para
  // las dos cosas (la fila y la respuesta), así que la respuesta es idéntica falle o no la escritura.
  const verifiedAt = d.terminal && d.approved ? new Date().toISOString() : null;
  await persistKycVerdict(d, fila.ownerAddress, verifiedAt);
  // ⛔ CD-20: la respuesta NO lleva el `decisionToken`. Lo que sale es la salida del agente tal cual,
  // más el momento observado.
  return NextResponse.json({ ...d, verifiedAt });
}

/**
 * Persiste el veredicto cuando el AGENTE dice que esta verificación habilita un desembolso.
 *
 * 🔴 LA CONDICIÓN ES `payoutAllowed !== true` ⇒ NO SE ESCRIBE, y es ESTRICTAMENTE MÁS ESTRICTA que la
 * anterior (`!vendorData`). Por construcción de `isStatusPayoutAllowed` en el agente, ese booleano
 * exige aprobado ∧ hubo reclamo de identidad ∧ `identityMatches === true` ∧ proveniencia en la
 * allow-list de verificaciones REALES. ⇒ convierte *"existe una fila"* en el invariante
 * **"el agente la juzgó real, aprobada y atada"**, que es lo que después deja borrar el juicio local.
 *
 * ⛔ SIN `?? false` (CD-3). No se normaliza `identityMatches` ni ningún campo del agente: ausente ≠
 * `false` ≠ `true`. La comparación es `!== true` ESTRICTA, nunca truthiness: un `payoutAllowed: "true"`
 * (el STRING) es truthy y abriría el gate — por eso el cliente ya lo rechaza al estrechar, y por eso
 * acá igual se compara contra `true`.
 *
 * BEST-EFFORT y sin PII (P-13):
 *   · La respuesta HTTP es BYTE-IDÉNTICA pase lo que pase con la escritura. Que la evidencia no quede
 *     no puede cambiar el desenlace del KYC de una persona.
 *     ⚠️ NO CONFUNDIR con la escritura del TOKEN en `session/route.ts`, que NO es best-effort a
 *     propósito: sin token nadie puede leer NADA de esa sesión; sin esta fila, la persona igual ve su
 *     resultado y el próximo poll reintenta.
 *   · Un fallo emite UNA alerta por el MISMO canal que el ledger de evidencia y VALUE-FREE.
 *   · IDEMPOTENTE sin mover `verified_at`: esta route se pollea hasta 8 veces por verificación. El
 *     contrato CAS del store devuelve `already_recorded` y NO toca la fecha; si la moviera, quien deje
 *     la pestaña recargando no vencería nunca.
 *
 * `senderAddress` sale del `owner_address` de la FILA DEL TOKEN —o sea de la dirección PoP-probada—,
 * nunca de un eco del borde. Con `payoutAllowed === true` esa dirección existe por construcción (sin
 * claim el agente no puede devolver `true`); el guard de abajo lo deja escrito igual, fail-closed.
 */
async function persistKycVerdict(
  d: KycAgentDecisionOutput,
  ownerAddress: string | null,
  verifiedAt: string | null,
): Promise<void> {
  if (d.payoutAllowed !== true) return; // ⛔ el gate del agente, adoptado TAL CUAL (DT-5')
  if (!d.terminal || !d.approved || verifiedAt === null) return;
  if (!ownerAddress) return; // fail-closed: sin dueño probado no se escribe (no puede pasar acá)
  const store = getKycVerdictStore();
  if (!store) return; // flag OFF o envs ausentes ⇒ byte-idéntico a hoy
  let owner: string;
  try {
    owner = canonicalizeAddress(ownerAddress);
  } catch {
    return; // un dueño que no canonicaliza tampoco es un binding
  }
  try {
    await store.put({
      senderAddress: owner,
      verificationId: d.verificationId, // por contrato del agente, ES el sessionId que se pidió
      approved: true,
      riskLevel: d.riskLevel,
      provenance: d.provenance, // CRUDA: el juicio ya vino hecho, en `payoutAllowed`
      verifiedAt,
    });
  } catch {
    // Value-free por contrato: sólo la etiqueta de la rama. Nada de la fila.
    logLedgerAlert("kyc_verdict_write_failed", { stage: "kyc_decision_route" });
  }
}
