// Persiste el KYC en curso (remittanceId + sessionId + address) antes del redirect a Didit,
// para retomar el flujo al volver. localStorage: sobrevive la navegación de página completa.
import type { KycPending, KycPendingStore } from "../application/ports";

/** La clave del pendiente de KYC. SE EXPORTA (HU-066) porque la puerta del splash necesita saber
 *  si hay un KYC esperando ser retomado, y copiar el literal allá habría creado un segundo sitio
 *  de escritura del mismo string: el día que esta clave cambie de versión, el splash se pintaría
 *  encima del aterrizaje del KYC y nada se pondría rojo. Ver `../presentation/splash-puerta.ts`. */
export const CLAVE_KYC_PENDIENTE = "chaski.kyc.pending.v1";

export class LocalKycPendingStore implements KycPendingStore {
  async save(p: KycPending): Promise<void> {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(CLAVE_KYC_PENDIENTE, JSON.stringify(p));
    } catch {
      throw new Error("kyc_pending_unavailable");
    }
  }
  async get(): Promise<KycPending | null> {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(CLAVE_KYC_PENDIENTE);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as KycPending;
    } catch {
      return null;
    }
  }
  async clear(): Promise<void> {
    try {
      if (typeof localStorage !== "undefined") localStorage.removeItem(CLAVE_KYC_PENDIENTE);
    } catch {
      throw new Error("kyc_pending_unavailable");
    }
  }
}
