// Adapter cliente de la autoridad de payout (WKH-180). Llama a /api/payout/validate desde el
// browser y propaga { authorized, reason }. FAIL-CLOSED (CD-A4): cualquier error de red/parse o
// body inesperado → { authorized:false }. NUNCA lanza sin catch, NUNCA authorized:true por default.
// En dev sin key la ruta devuelve { authorized:true, reason:"simulated_dev" } → se propaga tal cual
// (el demo local sigue llegando a "Entregado"). Exemplar: kyc-gateway.ts.
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
