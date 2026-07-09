// Adapter REAL de Didit (KYC de personas). Orquesta el flujo hospedado:
//   1. crea la sesión server-side (el API key vive SOLO en el server, nunca en el browser)
//   2. abre el escaneo de Didit (documento + selfie/liveness + AML) en una ventana
//   3. poll-ea la decisión hasta un estado terminal y la mapea a KycVerification
// Env-gated: se activa con NEXT_PUBLIC_KYC_MODE=didit (composition root). Sin key → fallback.
import type { KycGateway, KycRequest } from "../../application/ports";
import type { KycVerification } from "../../domain/remittance";
import type { DiditDecisionResult } from "./decision";
import { closeKycWindow, navigateKycWindow } from "./popup";

const POLL_MS = 3000;
const TIMEOUT_MS = 5 * 60_000;

export class DiditKycGateway implements KycGateway {
  // Recibe un fallback: si el SERVER no tiene Didit configurado (501), delega en la simulación.
  // La decisión "real vs simulado" vive server-side (env confiable en runtime), NO en el
  // inlineado NEXT_PUBLIC del cliente (que en dev es frágil). Con key → siempre Didit real.
  constructor(private readonly fallback: KycGateway) {}

  async verify(req: KycRequest): Promise<KycVerification> {
    const sres = await fetch("/api/kyc/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (sres.status === 501) {
      // Didit no configurado en el server → simulación (la DApp corre sin key).
      closeKycWindow();
      return this.fallback.verify(req);
    }
    if (!sres.ok) {
      closeKycWindow();
      throw new Error("didit_session_failed");
    }
    const { sessionId, url } = (await sres.json()) as { sessionId: string; url: string };

    // Navega la ventana pre-abierta al click (ver popup.ts) → no la bloquea el navegador.
    const popup = navigateKycWindow(url);

    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const dres = await fetch(`/api/kyc/decision?sessionId=${encodeURIComponent(sessionId)}`);
      if (!dres.ok) continue;
      const d = (await dres.json()) as DiditDecisionResult;
      if (d.terminal) {
        popup?.close();
        return {
          verificationId: d.verificationId,
          approved: d.approved,
          payoutAllowed: d.payoutAllowed,
          riskLevel: d.riskLevel,
          provenance: d.provenance,
          identity: d.identity,
        };
      }
    }
    popup?.close();
    throw new Error("didit_timeout");
  }
}
