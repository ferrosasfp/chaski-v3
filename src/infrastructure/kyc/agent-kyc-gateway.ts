// Adapter del KYC del lado del NAVEGADOR (WKH-233/W1). Reemplaza al adapter del proveedor.
//
// Le habla a las rutas de ESTE repo (`/api/kyc/session`, `/api/kyc/decision`), NUNCA al agente: la
// credencial del agente, su host y su token de decisión son server-only y no pueden llegar acá
// (CD-10). Quien le habla al agente es `agent-kyc-client.ts`, que este módulo NO importa a propósito.
//
// Flujo hospedado con REDIRECT en la misma pestaña (suave en móvil): `start()` crea la sesión
// server-side y devuelve la URL a la que redirigir; al volver, `decision()` consulta el resultado.
import type {
  KycDecision,
  KycGateway,
  KycRequest,
  KycStartResult,
} from "../../application/ports";
import type { KycAgentDecisionOutput } from "./agent-contract";

/** Lo que devuelve `GET /api/kyc/decision`: la salida del agente MÁS el momento en que este servidor
 *  observó el desenlace. ⛔ Sin `decisionToken` (CD-20): esa credencial no sale del servidor. */
type DecisionResponse = KycAgentDecisionOutput & { verifiedAt: string | null };

export class AgentKycGateway implements KycGateway {
  constructor(private readonly fallback: KycGateway) {}

  async start(req: KycRequest): Promise<KycStartResult> {
    const sres = await fetch("/api/kyc/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // `vendorData` sigue viajando SÓLO como hint del rate-limit por address (WKH-179), que corre
        // ANTES del bloque cripto y donde un valor forjable ya era forjable. ⛔ La ruta NO lo usa como
        // binding: el binding sale de la dirección del challenge PoP-verificado.
        vendorData: req.senderAddress,
        // ⛔ `callback` YA NO SE MANDA (DT-11). La ruta lo ignoraba desde M6 y ahora ni existe: el
        // agente valida el `callbackUrl` contra una allowlist de orígenes que nace vacía, y el retomar
        // del flujo de Chaski no depende del callback sino del pendiente en `localStorage`.
        popChallenge: req.popChallenge,
        popSignature: req.popSignature,
      }),
    });
    // 501 = el host del agente no está configurado ⇒ simulación. Es el interruptor de rollback de
    // esta HU (D-1): sin `KYC_AGENT_BASE_URL` el demo queda byte-idéntico a como estaba.
    if (sres.status === 501) return this.fallback.start(req);
    if (!sres.ok) throw new Error("kyc_session_failed");
    // `authToken` = el HMAC NUESTRO (WKH-179) que autoriza el GET /decision de la route de Chaski.
    // ⛔ La respuesta YA NO trae el `sessionToken` del proveedor ni el `decisionToken` del agente.
    const { sessionId, url, authToken } = (await sres.json()) as {
      sessionId: string;
      url: string;
      authToken?: string;
    };
    return { kind: "redirect", url, sessionId, authToken };
  }

  /**
   * 🔴 ACÁ UN 501 **LANZA** Y NO DELEGA EN EL FALLBACK, Y ES UN CAMBIO DELIBERADO RESPECTO DEL
   * ADAPTER ANTERIOR, QUE SÍ DELEGABA (WKH-233/D-4).
   *
   * Es la línea que impide el peor modo de falla de esta HU. Si `KYC_AGENT_BASE_URL` desapareciera
   * con gente EN VUELO, delegar acá haría que `FallbackKycGateway.decision` devolviera
   * `approved: true, payoutAllowed: true` ⇒ **le fabricaría un veredicto aprobado a una verificación
   * REAL**, y `ResumeKyc` lo persistiría. Un default que degrada a simulación no falla: MIENTE.
   *
   * Lanzar es lo correcto: `ResumeKyc` lo convierte en `"processing"`, que es reintentable, que es
   * exactamente lo que corresponde ante una misconfig transitoria.
   *
   * `start()` SÍ delega, y la asimetría no es un olvido: allá la simulación ES el demo y no hay
   * ninguna verificación real a la que traicionar.
   */
  async decision(sessionId: string, authToken?: string): Promise<KycDecision> {
    const dres = await fetch(`/api/kyc/decision?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: authToken ? { "x-kyc-token": authToken } : {},
    });
    if (!dres.ok) throw new Error("kyc_decision_failed"); // ⛔ incluye el 501: ver el docblock
    const d = (await dres.json()) as DecisionResponse;
    return {
      terminal: d.terminal,
      verification: {
        verificationId: d.verificationId,
        approved: d.approved,
        // ⚠️ DESDE `approved`, NO desde el `payoutAllowed` del agente (D-3). Es byte-idéntico a lo que
        // hacía el mapeo anterior (`payoutAllowed: approved`), y meterle acá el del agente rompería la
        // demo en la PANTALLA de identidad —el flujo no llegaría ni a `kyc_passed`—, que no es lo que
        // decidió DT-5'. El juicio del agente va abajo, en `realVerified`.
        payoutAllowed: d.approved,
        // 🔴 EL JUICIO DEL AGENTE, TAL CUAL. ⛔ Sin `?? false`, sin recomponerlo con
        // `approved && identityMatches`: eso sería re-implementar el juicio de KYC.
        realVerified: d.payoutAllowed,
        riskLevel: d.riskLevel,
        provenance: d.provenance,
        verifiedAt: d.verifiedAt,
        // El agente NO devuelve ningún dato de identidad (ni nombre, ni documento, ni sus últimos 4),
        // así que por este camino esto es SIEMPRE `null`. Es lo que obligó a rediseñar `IdentityBadge`
        // (D-2): tal como estaba, la tarjeta desaparecía sin que nadie lo notara.
        identity: null,
      },
    };
  }
}
