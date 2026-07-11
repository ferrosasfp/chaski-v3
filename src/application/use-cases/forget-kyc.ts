import type { KycStore, KycPendingStore } from "../ports";

/** Reset explícito del KYC-once (WKH-184, Opción D): olvida la verificación recordada para esta
 *  address Y limpia cualquier pending en curso, para forzar re-verificación completa. */
export class ForgetKyc {
  constructor(
    private readonly kycStore: KycStore,
    private readonly pending: KycPendingStore,
  ) {}

  async execute(input: { address: string }): Promise<void> {
    try {
      await this.kycStore.clear(input.address); // AC-1/2 — best-effort (CD-8)
    } catch {
      /* storage roto: no rompe el reset (AC-5/CD-8) */
    }
    try {
      await this.pending.clear(); // AC-3 — limpia el pending
    } catch {
      /* storage roto: execute() NUNCA rechaza por storage (CD-8) */
    }
  }
}
