// Adapter cliente de la autoridad de payout (WKH-180). Llama a /api/payout/validate desde el
// browser y propaga { authorized, reason }. FAIL-CLOSED (CD-A4): cualquier error de red/parse o
// body inesperado → { authorized:false }. NUNCA lanza sin catch, NUNCA authorized:true por default.
// En dev sin key la ruta devuelve { authorized:true, reason:"simulated_dev" } → se propaga tal cual.
//
// Eso significa exactamente una cosa: que ESTE gate no bloquea. Acá decía "el demo local sigue
// llegando a Entregado", y era falso: con el flag de settlement Solana apagado la remesa muere dos
// pasos más adelante, en el tapón DT-8 de ConfirmAndSend (sin `solana` inyectado → failAndRefund
// con `settlement_unavailable` → payout_failed → refunded, confirm-and-send.ts:114-117). Nunca
// llegaba a "Entregado" por este camino, y desde el fix del FallbackPayoutGateway tampoco por el
// otro. Un comentario que promete un final feliz apaga la búsqueda justo donde había que mirar.
// Exemplar: kyc-gateway.ts.
import type { PayoutAuthorityGateway, PayoutAuthorization } from "../../application/ports";

export class HttpPayoutAuthorityGateway implements PayoutAuthorityGateway {
  async authorize(input: { verificationId: string; address: string }): Promise<PayoutAuthorization> {
    try {
      const res = await fetch("/api/payout/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      // El body SIEMPRE trae { authorized, reason } (incluso en 4xx/5xx) → parsear y devolver.
      const data = (await res.json()) as PayoutAuthorization;
      if (typeof data?.authorized !== "boolean") {
        return { authorized: false, reason: "kyc_authority_error" };
      }
      return data;
    } catch {
      return { authorized: false, reason: "kyc_authority_error" }; // fail-closed (CD-A4)
    }
  }
}
