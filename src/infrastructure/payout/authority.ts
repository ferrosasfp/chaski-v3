// Autoridad de payout server-side, EXTRAÍDA de app/api/payout/validate/route.ts (WKH-180) para que
// /api/payout/validate y /api/a2a/payout/submit compartan UNA sola implementación del guard-order
// (WKH-202/DT-1: dos copias divergirían). Server-only: lee DIDIT_API_KEY y fetchea Didit — PROHIBIDO
// importarlo desde src/presentation/** o cualquier código que llegue al bundle del cliente (CD-17).
//
// Guard-order (CD-A1), idéntico al original:
//   sin key + prod → 503 fail-loud (nunca autoriza por default — CD-4)
//   sin key + no-prod → simulación { authorized:true, simulated_dev } (el demo sigue andando)
//   con key → formato → ambiente (DIDIT_ENV, fail-closed) → Didit → mapeo → ownership
// Nunca fetch a Didit antes de pasar los guards.
import { mapDiditDecision } from "../didit/decision";
import {
  resolveDiditBaseUrl,
  resolveDiditEnvironment,
  type DiditEnvironment,
} from "../didit/didit-env";
import { canonicalizeAddress } from "../address";

export interface PayoutAuthorityDecision {
  authorized: boolean;
  reason?: string; // AUSENTE cuando authorized:true por Didit real (preserva {authorized:true})
  httpStatus: number; // 200 | 400 | 502 | 503 — el status que /api/payout/validate YA devuelve hoy
}

/** Recibe strings YA normalizados (el parseo del body y la coerción a "" quedan en cada route). */
export async function resolvePayoutAuthority(
  input: { verificationId: string; address: string },
): Promise<PayoutAuthorityDecision> {
  const { verificationId, address } = input;
  const apiKey = process.env.DIDIT_API_KEY;
  const isProd = (process.env.VERCEL_ENV ?? "") === "production";

  // Guard 1: SIN key.
  if (!apiKey) {
    if (isProd) {
      // fail-loud (WKH-180/AC-3, CD-4): prod sin key NUNCA autoriza silenciosamente. fetch NO se llama.
      return { authorized: false, reason: "kyc_authority_unavailable", httpStatus: 503 };
    }
    // no-prod: simulación (WKH-180/AC-4). fetch NO se llama. Este guard AUTORIZA, y nada más: acá
    // decía "el demo local llega a Entregado" y no es cierto — la remesa muere después, en el tapón
    // DT-8 de ConfirmAndSend (sin `solana` inyectado ⇒ settlement_unavailable ⇒ payout_failed).
    // OJO: autoriza sin consultar a Didit → para el money-path NO alcanza. El caller `submit`
    // rechaza este `simulated_dev` en todo scope de Vercel (WKH-202/DT-5); acá se conserva porque
    // /api/payout/validate (advisory) y el demo local dependen de él.
    if (!verificationId.trim()) {
      return { authorized: false, reason: "invalid_verification_id", httpStatus: 400 };
    }
    return { authorized: true, reason: "simulated_dev", httpStatus: 200 };
  }

  // Guard 2: FORMATO (WKH-180/AC-5). fetch NO se llama con id vacío/malformado.
  if (!verificationId.trim()) {
    return { authorized: false, reason: "invalid_verification_id", httpStatus: 400 };
  }

  // Guard 3: AMBIENTE de Didit (fail-closed, LAZY). Va FUERA del try/catch de abajo A PROPÓSITO:
  // adentro se confundiría con `kyc_reauth_failed` (502), que significa "la autoridad falló/está
  // caída" y manda a ops a mirar a Didit. Esto es MISCONFIG NUESTRA → 503 con su propio reason.
  // Fail-closed igual: nunca autoriza (CD-4).
  let base: string;
  let environment: DiditEnvironment;
  try {
    environment = resolveDiditEnvironment();
    base = resolveDiditBaseUrl();
  } catch {
    return { authorized: false, reason: "kyc_authority_misconfigured", httpStatus: 503 };
  }

  // Didit: re-consulta la decisión REAL (CD-A2: key + fetch solo acá, server runtime).
  // fail-closed EXPLÍCITO (MNR-A): un throw del fetch (timeout de AbortSignal, DNS, connection
  // reset) o un JSON malformado NUNCA debe escapar como 500 crudo — el adapter asume que el body
  // SIEMPRE trae { authorized, reason } incluso en 5xx. Todo el bloque fetch+mapeo+decisión va en
  // try/catch → en el catch devolvemos 502 { authorized:false, kyc_reauth_failed } (mismo reason
  // que !res.ok). Nunca autoriza ante un fallo de la autoridad (CD-4).
  try {
    const res = await fetch(
      `${base}/v3/session/${encodeURIComponent(verificationId)}/decision/`,
      { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      return { authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 };
    }

    // El ambiente sale de la MISMA resolución que eligió el host de arriba: si se consultó al mock,
    // la decisión queda etiquetada `didit-mock` y el agente de desembolso la trata como simulada.
    const d = mapDiditDecision(await res.json(), environment);

    // Solo "Approved" autoriza (CD-A5: reusa mapDiditDecision, no re-implementa status → approved).
    if (d.status !== "Approved") {
      return { authorized: false, reason: "kyc_not_approved", httpStatus: 200 };
    }

    // Ownership best-effort: vendor_data (= senderAddress) vs address del caller. La comparación es
    // CASE-SENSITIVE porque la canonicalización es base58 (CD-7): lowercasear acá abriría una colisión.
    // Si Didit NO eco-a vendor_data (d.vendorData === "") → se omite (residual documentado).
    // MNR-B: este binding ownership solo tiene FUERZA REAL cuando `address` proviene de un caller
    // AUTENTICADO (sesión firmada / SIWE) — no de un endpoint público, donde `address` y
    // `vendor_data` son ambos caller-controlados, así que un replay de un verificationId Approved
    // robado con address=vendorData (dato conocido) pasaría este check. Este módulo YA NO sirve
    // sólo al endpoint advisory /api/payout/validate: desde WKH-202 también alimenta el endpoint
    // ACTION /api/a2a/payout/submit, que es PÚBLICO → el residual SOBREVIVE al money-path
    // (SDD §8/R1) y el riesgo ya NO es nulo. Hoy lo acota que el payout corre en PAYOUT_ALLOW_MOCK
    // (no desembolsa real). El check queda como defensa best-effort; el hardening completo
    // (binding a sesión firmada / SIWE) = follow-up.
    if (d.vendorData !== "" && canonicalizeAddress(d.vendorData) !== canonicalizeAddress(address)) {
      return { authorized: false, reason: "kyc_ownership_mismatch", httpStatus: 200 };
    }

    return { authorized: true, httpStatus: 200 }; // SIN `reason` (preserva {authorized:true})
  } catch {
    // fetch throw (timeout/DNS/reset) o JSON malformado → 502 fail-closed, misma forma que !res.ok.
    return { authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 };
  }
}
