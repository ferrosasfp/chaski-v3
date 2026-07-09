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
import type { DiditDecisionResult } from "./decision";

export class DiditKycGateway implements KycGateway {
  constructor(private readonly fallback: KycGateway) {}

  async start(req: KycRequest): Promise<KycStartResult> {
    const sres = await fetch("/api/kyc/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback: req.callbackUrl }),
    });
    if (sres.status === 501) return this.fallback.start(req); // sin Didit → simulación
    if (!sres.ok) throw new Error("didit_session_failed");
    const { sessionId, url } = (await sres.json()) as { sessionId: string; url: string };
    return { kind: "redirect", url, sessionId };
  }

  async decision(sessionId: string): Promise<KycDecision> {
    const dres = await fetch(`/api/kyc/decision?sessionId=${encodeURIComponent(sessionId)}`);
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
        identity: d.identity,
      },
    };
  }
}
