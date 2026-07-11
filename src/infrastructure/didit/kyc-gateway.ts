// Adapter REAL de Didit (KYC de personas) — flujo hospedado con REDIRECT en la misma pestaña
// (suave en móvil): start() crea la sesión server-side y devuelve la URL de Didit para redirigir;
// al volver, decision() consulta el resultado. Server-truth: si el server no tiene key (501),
// delega en el fallback (simulación). El API key vive SOLO en el server.
import type {
  KycDecision,
  KycGateway,
  KycRequest,
  KycStartResult,
} from "../../application/ports";
import { toPersistedIdentity } from "../../domain/remittance";
import type { DiditDecisionResult } from "./decision";

export class DiditKycGateway implements KycGateway {
  constructor(private readonly fallback: KycGateway) {}

  async start(req: KycRequest): Promise<KycStartResult> {
    const sres = await fetch("/api/kyc/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // vendorData = address del sender → rate-limit por address (WKH-179). callback lo IGNORA
      // la ruta (se reconstruye server-side, M6) pero se manda por compat.
      body: JSON.stringify({ callback: req.callbackUrl, vendorData: req.senderAddress }),
    });
    if (sres.status === 501) return this.fallback.start(req); // sin Didit → simulación
    if (!sres.ok) throw new Error("didit_session_failed");
    // authToken = token HMAC NUESTRO (WKH-179) que autoriza el GET /decision.
    const { sessionId, url, authToken } = (await sres.json()) as {
      sessionId: string;
      url: string;
      authToken?: string;
    };
    return { kind: "redirect", url, sessionId, authToken };
  }

  async decision(sessionId: string, authToken?: string): Promise<KycDecision> {
    const dres = await fetch(`/api/kyc/decision?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: authToken ? { "x-kyc-token": authToken } : {},
    });
    if (dres.status === 501) return this.fallback.decision(sessionId);
    if (!dres.ok) throw new Error("didit_decision_failed");
    const d = (await dres.json()) as DiditDecisionResult;
    return {
      terminal: d.terminal,
      verification: {
        verificationId: d.verificationId,
        approved: d.approved,
        payoutAllowed: d.payoutAllowed,
        riskLevel: d.riskLevel,
        provenance: d.provenance,
        identity: d.identity ? toPersistedIdentity(d.identity) : null, // reducir PII aguas arriba (CD-6)
      },
    };
  }
}
