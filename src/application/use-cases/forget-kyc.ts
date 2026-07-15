import type { KycStore, KycPendingStore, RemittanceRepository } from "../ports";

/** Reset explícito del KYC-once (WKH-184, Opción D): olvida la verificación recordada para esta
 *  address Y limpia cualquier pending en curso, para forzar re-verificación completa.
 *  WKH-201: además purga la PII persistida del beneficiario (repo) best-effort al desconectar. */
export class ForgetKyc {
  constructor(
    private readonly kycStore: KycStore,
    private readonly pending: KycPendingStore,
    private readonly repo: RemittanceRepository,
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
    try {
      await this.repo.clearByOwner(input.address); // WKH-201/AC-1 — best-effort (CD-2)
    } catch {
      /* AC-4: storage roto no rompe el reset (CD-2) */
    }
  }
}
