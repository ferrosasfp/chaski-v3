// Autoridad de payout server-side, EXTRAÍDA de app/api/payout/validate/route.ts (WKH-180) para que
// /api/payout/validate y /api/a2a/payout/submit compartan UNA sola implementación del guard-order
// (WKH-202/DT-1: dos copias divergirían). Server-only: lee DIDIT_API_KEY y fetchea Didit — PROHIBIDO
// importarlo desde src/presentation/** o cualquier código que llegue al bundle del cliente (CD-17).
//
// Guard-order (CD-A1), idéntico al original:
//   sin key + prod → 503 fail-loud (nunca autoriza por default — CD-4)
//   sin key + no-prod → simulación { authorized:true, simulated_dev } (el demo sigue andando)
//   con key → formato → ambiente (DIDIT_ENV, fail-closed) → Didit → mapeo → ownership (fail-closed:
//     sin vendor_data declarado NO autoriza — ver el bloque largo sobre el bypass medido en prod)
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

    // Ownership FAIL-CLOSED: autorizar EXIGE que Didit eco-e un vendor_data (= senderAddress) y que
    // canonicalice igual que la `address` del caller. La comparación es CASE-SENSITIVE porque la
    // canonicalización es base58 (CD-7): lowercasear acá abriría una colisión.
    //
    // 🔴 vendor_data VACÍO ya NO autoriza. Acá decía que ese caso "se omite (residual documentado)",
    // y eso describía como residual lo que era un bypass completo. Medido contra PRODUCCIÓN el
    // 2026-08-04: crear la sesión es un POST público sin credenciales — `POST /api/kyc/session {}`
    // devuelve 200 con la url trayendo `&vendor=` vacío; a los ~9 s el mock la aprueba; y entonces
    // `POST /api/payout/validate {verificationId, address:X}` respondía {"authorized":true} para
    // CUALQUIER X. Se probaron tres direcciones sin ninguna relación entre sí
    // (11111111111111111111111111111111, So1111…1112, 4AvAjt…Fy7Hg): las tres autorizadas.
    //
    // Cerrarlo no toca el camino de la DApp: kyc-gateway.ts:23 manda SIEMPRE
    // `vendorData: req.senderAddress`, y con vendor_data declarado el guard ya funcionaba — medido
    // en vivo el mismo día: vendor=4AvAjt… + address=4AvAjt… → {"authorized":true}; vendor=4AvAjt…
    // + address=So1111… → {"authorized":false,"reason":"kyc_not_authorized"}. Lo único que se cierra
    // es el caso que ningún caller legítimo produce.
    //
    // El reason es `kyc_ownership_mismatch` y NO uno nuevo, a propósito: los dos consumidores tienen
    // switch cerrado y un reason desconocido cae al `default` de cada uno con la forma equivocada.
    // validate/route.ts:69 lo devolvería tal cual → distinguible de `kyc_not_authorized`, que es
    // exactamente el oráculo que WKH-205 colapsó; prepare/route.ts:129 lo mapearía a 502
    // `payout_authority_unavailable`, que le dice a quien llama "la autoridad se cayó, reintentá"
    // cuando lo cierto es "no estás autorizado". Semánticamente tampoco hace falta distinguirlos:
    // bajo fail-closed, binding ausente y binding que no coincide son el mismo veredicto — no se
    // pudo establecer que esa address sea la dueña de esa verificación.
    //
    // Lo que este check SIGUE sin cubrir (MNR-B, residual VIGENTE): `address` llega desde un endpoint
    // PÚBLICO, así que address y vendor_data son ambos caller-controlados. Un verificationId Approved
    // robado y replayado con address = el vendor_data de esa misma sesión pasa este check. Ya no
    // alcanza con no declarar nada, pero sigue alcanzando con conocer el par. El binding a una sesión
    // firmada / SIWE, que es lo que lo cerraría, sigue siendo follow-up.
    //
    // El orden del `||` importa: con vendorData === "" se corta antes, así canonicalizeAddress("")
    // nunca corre (throwearía → el catch de abajo lo convertiría en un 502 "Didit falló", que sería
    // un diagnóstico falso).
    if (d.vendorData === "" || canonicalizeAddress(d.vendorData) !== canonicalizeAddress(address)) {
      return { authorized: false, reason: "kyc_ownership_mismatch", httpStatus: 200 };
    }

    return { authorized: true, httpStatus: 200 }; // SIN `reason` (preserva {authorized:true})
  } catch (err) {
    // fetch throw (timeout/DNS/reset) o JSON malformado → 502 fail-closed, misma forma que !res.ok.
    //
    // 🔴 POR QUÉ ESTE LOG NO ES OPCIONAL. Este `catch` estaba VACÍO, y eso convirtió un fallo real en
    // uno indiagnosticable: el 2026-08-02 el flujo de un recorrido manual murió acá con 502, no llegó
    // a pedir la firma, y al ir a los logs no había NADA. El mismo paso, repetido minutos después,
    // devolvió 200. Sin rastro no se puede distinguir un timeout de un DNS de un JSON roto, y las
    // tres se arreglan distinto.
    //
    // Value-free por contrato (CD-4/CD-7): SÓLO el `name` del error. Nunca el message (puede traer la
    // URL con el verificationId), nunca el body, nunca la dirección ni el vendor_data.
    console.warn("[payout-authority] kyc_reauth_failed:", {
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return { authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 };
  }
}
