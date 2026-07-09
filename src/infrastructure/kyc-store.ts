// Infrastructure — KycStore. Recuerda la verificación KYC por dirección de wallet (KYC-once).
// localStorage en browser, in-memory en SSR. KycVerification es plano (sin Money) → JSON directo.
import type { KycVerification } from "../domain/remittance";
import type { KycStore } from "../application/ports";

const KEY = "chaski.kyc.v1";

function ls(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export class LocalKycStore implements KycStore {
  private mem: Record<string, KycVerification> = {};

  private read(): Record<string, KycVerification> {
    const s = ls();
    if (!s) return this.mem;
    try {
      return JSON.parse(s.getItem(KEY) ?? "{}") as Record<string, KycVerification>;
    } catch {
      return {};
    }
  }

  async get(address: string): Promise<KycVerification | null> {
    return this.read()[address.toLowerCase()] ?? null;
  }

  async save(address: string, kyc: KycVerification): Promise<void> {
    const all = this.read();
    all[address.toLowerCase()] = kyc;
    const s = ls();
    if (!s) {
      this.mem = all;
      return;
    }
    s.setItem(KEY, JSON.stringify(all));
  }
}
