// Persiste el KYC en curso (remittanceId + sessionId + address) antes del redirect a Didit,
// para retomar el flujo al volver. localStorage: sobrevive la navegación de página completa.
import type { KycPending, KycPendingStore } from "../application/ports";

const KEY = "chaski.kyc.pending.v1";

export class LocalKycPendingStore implements KycPendingStore {
  async save(p: KycPending): Promise<void> {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(p));
  }
  async get(): Promise<KycPending | null> {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as KycPending;
    } catch {
      return null;
    }
  }
  async clear(): Promise<void> {
    if (typeof localStorage !== "undefined") localStorage.removeItem(KEY);
  }
}
