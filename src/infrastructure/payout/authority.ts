// Autoridad de payout server-side. Es la que decide, EN EL MOMENTO DEL DINERO, si un par
// (verificación, dirección) puede cobrar. Server-only: lee el store del `decisionToken` y le habla al
// agente de KYC — ⛔ PROHIBIDO importarla desde `src/presentation/**` ni desde nada que llegue al
// bundle del cliente (CD-10).
//
// 🔴 WKH-233 — ESTA FUNCIÓN YA NO LE HABLA AL PROVEEDOR DE KYC NI MAPEA SU PAYLOAD. Le pregunta al
// AGENTE DE KYC (su nombre vive UNA sola vez, en `agent-env.ts`, CD-2) y ADOPTA SU VEREDICTO TAL
// CUAL. El gate es UNA comparación:
//     body.payoutAllowed === true
//
// ⛔ Y NADA MÁS. Chaski NO recompone el criterio con `approved && identityMatches`: eso sería
// RE-IMPLEMENTAR EL JUICIO DE KYC, que es exactamente el pecado que WKH-233 existe para borrar. Por
// construcción de `isStatusPayoutAllowed` en el agente, ese booleano ya significa aprobado ∧ hubo
// reclamo de identidad ∧ la identidad COINCIDE ∧ la proveniencia está en su allow-list de
// verificaciones REALES. Es MÁS de lo que este archivo verificaba solo. **El agente decide; Chaski
// pregunta.**
//
// 🔴 CONSECUENCIA DECLARADA, Y ES UNA DECISIÓN DEL FOUNDER, NO UN BUG: **con KYC SIMULADO NO SE
// PAGA.** La proveniencia del mock no está en la allow-list del agente, a propósito, y en cualquier
// deploy de Vercel su rama de opt-in no-prod es inalcanzable. ⇒ `prepare` responde
// `payout_not_authorized`. ⛔ PROHIBIDO relajar esto acá: ni un `?? true`, ni una allow-list local,
// ni una env que saltee el gate, ni una excepción "sólo mientras dure el Demo Day". La única perilla
// legítima vive en el otro repo y es Scope OUT.
//
// 🔴 DE DÓNDE SALE LA CREDENCIAL, Y POR QUÉ ESTA FUNCIÓN NO CAMBIÓ DE FIRMA. El agente exige un
// `decisionToken` en cabecera. Esta función ya recibía la dirección PoP-VERIFICADA y el
// `verificationId` DE LA FILA DEL DUEÑO, que es exactamente el par `(sessionId, ownerAddress)` que la
// lectura owner-scoped necesita ⇒ **la autoridad lee su propia credencial, owner-scoped, sin que
// `prepare` tenga que cambiar una sola línea.**
//
// 🔴 CD-19 — SE USA `getForOwner`, JAMÁS `readForVerifiedSession`. La segunda NO filtra por dueño (es
// la excepción declarada del camino de PANTALLA, donde el HMAC corre antes). Traerla acá sería la
// lectura sin filtro entrando al money-path, o sea un IDOR sobre la credencial del desembolso.
// Candado mecánico: G-5 en `src/composition/kyc-provider-residue.static.test.ts`.
//
// 🔴 CD-21 — EL `decisionToken` NO VENCE, NUNCA, y el camino de fallo está especificado: si alguien
// lo invalidara (rotando `KYC_DECISION_TOKEN_SECRET` en el agente o subiendo su versión `k1`→`k2` —
// los dos son un CORTE, no un rollback), el agente contesta **401** ⇒ acá `kyc_reauth_failed`/502 ⇒
// `prepare` responde `payout_authority_unavailable`/502. **La persona no pierde plata; pierde el pago
// hasta que se re-verifique.** ⛔ PROHIBIDO agregar un reintento con otra credencial, un camino de
// respaldo, o un `?? true`.
//
// ⚠️ CONSUMIDORES, MEDIDO Y NO SUPUESTO (2026-08-19): **uno vivo** — `app/api/payout/prepare/route.ts`,
// el money-path real— y **uno advisory sin consumidor de producción** — `app/api/payout/validate`,
// que es un POST público que nadie del flujo llama—. La cabecera anterior nombraba además
// `/api/a2a/payout/submit`, que **NO EXISTE en este repo** (`ls -R app/api/a2a/`: sólo `plan`,
// `quote` y `payout/challenge`). ⛔ Y NO se crea para que la cita sea cierta: se corrige la cita.
//
// Guard-order (fail-closed en las cinco ramas; nunca un fetch antes de pasar los guards):
//   1. host del agente ausente + prod   → 503 fail-loud (nunca autoriza por default)
//   2. host ausente + no-prod           → simulación `simulated_dev` (el demo local sigue andando)
//   3. formato del verificationId       → 400
//   4. el token, OWNER-SCOPED           → 503 (misconfig) / 502 (lectura rota) / 200 sin fila
//   5. el agente                        → 502 (!ok, throw, JSON roto) / 200 con su veredicto
import { canonicalizeAddress } from "../address";
import { readAgentKycDecision } from "../kyc/agent-kyc-client";
import { resolveKycAgentBaseUrl } from "../kyc/agent-env";
import { getKycSessionTokenStore } from "../persistence/supabase-kyc-session-tokens";

export interface PayoutAuthorityDecision {
  authorized: boolean;
  reason?: string; // AUSENTE cuando authorized:true por una verificación REAL (preserva {authorized:true})
  httpStatus: number; // 200 | 400 | 502 | 503 — el status que /api/payout/validate YA devuelve hoy
  // ADITIVOS y OPCIONALES. Se pueblan ÚNICAMENTE en la rama de autorización real (el `return` del
  // final del try). Que sean opcionales es lo que hace representable "la rama que autorizó no declaró
  // proveniencia" — y esa rama NO escribe fila. Un `provenance: string` obligatorio habría obligado a
  // rellenar un default en las otras cuatro ramas, que es justamente inventar el dato a verificar.
  provenance?: string;
  riskLevel?: "low" | "medium" | "high";
}

/** Recibe strings YA normalizados (el parseo del body y la coerción a "" quedan en cada route). */
export async function resolvePayoutAuthority(
  input: { verificationId: string; address: string },
): Promise<PayoutAuthorityDecision> {
  const { verificationId, address } = input;
  const isProd = (process.env.VERCEL_ENV ?? "") === "production";

  // Guard 1 — HOST DEL AGENTE. Fail-closed y LAZY, y FUERA del try/catch de abajo A PROPÓSITO:
  // adentro se confundiría con `kyc_reauth_failed` (502), que significa "la autoridad falló" y manda
  // a ops a mirar al agente. Esto es MISCONFIG NUESTRA.
  let hayAgente = true;
  try {
    resolveKycAgentBaseUrl();
  } catch {
    hayAgente = false;
  }
  if (!hayAgente) {
    if (isProd) {
      // fail-loud: prod sin host NUNCA autoriza silenciosamente. No se llama a nadie.
      return { authorized: false, reason: "kyc_authority_unavailable", httpStatus: 503 };
    }
    // no-prod: simulación. Este guard AUTORIZA, y nada más — la remesa muere después, en el tapón de
    // `ConfirmAndSend`. OJO: autoriza SIN consultar al agente ⇒ para el money-path NO alcanza, y
    // `prepare` rechaza este `simulated_dev` en todo scope de Vercel. Se conserva porque
    // /api/payout/validate (advisory) y el demo local dependen de él.
    if (!verificationId.trim()) {
      return { authorized: false, reason: "invalid_verification_id", httpStatus: 400 };
    }
    return { authorized: true, reason: "simulated_dev", httpStatus: 200 };
  }

  // Guard 2 — FORMATO. Nunca se consulta nada con un id vacío/malformado.
  if (!verificationId.trim()) {
    return { authorized: false, reason: "invalid_verification_id", httpStatus: 400 };
  }

  // Guard 3 — LA CREDENCIAL, OWNER-SCOPED (CD-19). Va ANTES del viaje al agente (P-7): un par ajeno
  // no gasta ni una consulta, y —lo que importa— NI SIQUIERA OBTIENE EL TOKEN.
  const tokenStore = getKycSessionTokenStore();
  if (!tokenStore) {
    // Misconfig NUESTRA (envs de Supabase ausentes), no una caída del agente ⇒ su propio reason.
    return { authorized: false, reason: "kyc_authority_unavailable", httpStatus: 503 };
  }
  let decisionToken: string | null;
  try {
    decisionToken = await tokenStore.getForOwner(verificationId, canonicalizeAddress(address));
  } catch {
    // Lectura rota (base caída, tabla ausente) o dirección malformada. Fail-closed: nunca autoriza.
    // ⚠️ La dirección malformada cae acá y sale como "la autoridad falló", que es lo MISMO que hacía
    // el código anterior (su `canonicalizeAddress(address)` vivía dentro del try y caía en su catch).
    // Se conserva a propósito: cambiarlo sería un `reason` nuevo, y CD-16 no lo permite.
    return { authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 };
  }
  if (decisionToken === null) {
    // 🔴 POR QUÉ ESTO ES `kyc_ownership_mismatch` Y NO UN CÓDIGO NUEVO. No poder establecer que ESA
    // dirección es la dueña de ESA verificación es exactamente lo que ese `reason` significa, y
    // `prepare` ya lo mapea a `payout_not_authorized`/403 COMPARTIENDO código con `kyc_not_approved`
    // — que es el no-oracle que se colapsó a propósito. Un `reason` nuevo caería al `default` del
    // `switch` y saldría como "la autoridad se cayó, reintentá", que sería un DIAGNÓSTICO FALSO.
    // ⇒ el conjunto de errores observables de `prepare` no cambia (CD-16).
    //
    // Cubre los dos casos, y los dos son el mismo veredicto bajo fail-closed: no hay fila para esa
    // sesión, o la hay y es de OTRO dueño (o de NINGUNO — una sesión sin atar tiene `owner_address`
    // NULL, y un `.eq` nunca matchea un NULL).
    return { authorized: false, reason: "kyc_ownership_mismatch", httpStatus: 200 };
  }

  // Guard 4/5 — EL AGENTE. fail-closed EXPLÍCITO: un throw del fetch (timeout, DNS, connection reset)
  // o un JSON malformado NUNCA debe escapar como 500 crudo — el adapter asume que el body SIEMPRE
  // trae { authorized, reason } incluso en 5xx.
  try {
    const r = await readAgentKycDecision({
      sessionId: verificationId,
      identityClaim: address, // la dirección PoP-VERIFICADA que llega desde `prepare`
      decisionToken,
    });
    if (!r.ok) {
      // Incluye el 401 de CD-21 (token invalidado por una rotación del secreto del agente).
      // ⛔ Sin reintento y sin credencial de respaldo.
      return { authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 };
    }

    // 🔴 EL GATE, Y NADA MÁS (DT-5'). ⛔ PROHIBIDO agregarle un `|| esDemo()`, un `?? true`, o una
    // recomposición con `approved && identityMatches`. La comparación es `=== true` ESTRICTA, nunca
    // truthiness: un `payoutAllowed: "true"` (el STRING) es truthy y abriría el gate.
    if (r.output.payoutAllowed !== true) {
      return { authorized: false, reason: "kyc_not_approved", httpStatus: 200 };
    }

    // SIN `reason` (preserva {authorized:true}). `provenance`/`riskLevel` son ADITIVOS y salen de la
    // MISMA respuesta, no de un recálculo: es la única rama donde el agente declaró algo verificado.
    return {
      authorized: true,
      httpStatus: 200,
      provenance: r.output.provenance,
      riskLevel: r.output.riskLevel,
    };
  } catch (err) {
    // 🔴 POR QUÉ ESTE LOG NO ES OPCIONAL. Este `catch` estuvo VACÍO, y eso convirtió un fallo real en
    // uno indiagnosticable: un recorrido manual murió acá con 502, no llegó a pedir la firma, y en
    // los logs no había NADA. El mismo paso, minutos después, devolvió 200. Sin rastro no se puede
    // distinguir un timeout de un DNS de un JSON roto, y las tres se arreglan distinto.
    //
    // Value-free por contrato (P-14/CD-15): SÓLO el `name` del error. Nunca el message (puede traer
    // la URL con el sessionId), nunca el body, nunca la dirección, nunca el token.
    console.warn("[payout-authority] kyc_reauth_failed:", {
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return { authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 };
  }
}
