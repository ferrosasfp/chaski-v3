import type { KycVerification, Remittance } from "../../domain/remittance";
import type { Clock, KycGateway, KycStore, RemittanceRepository } from "../ports";

/**
 * Corre la verificación de identidad (Didit) y la aplica al agregado.
 * KYC-once: si la wallet ya tiene una verificación aprobada recordada, la REUSA (no re-verifica).
 */
export class RunKyc {
  constructor(
    private readonly kyc: KycGateway,
    private readonly store: KycStore,
    private readonly repo: RemittanceRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    remittanceId: string;
    address: string;
    purpose?: string;
  }): Promise<Remittance> {
    const r = await this.repo.get(input.remittanceId);
    if (!r) throw new Error("remittance_not_found");
    const s = r.snapshot;

    r.startKyc(this.clock.nowIso());

    // Reusar la verificación recordada para esta wallet si ya pasó; si no, correr la sesión Didit
    // (escanear documento + selfie → Didit extrae la identidad) y guardarla.
    let verification: KycVerification | null = await this.store.get(input.address);
    if (!verification || !(verification.approved && verification.payoutAllowed)) {
      verification = await this.kyc.verify({
        amountUsd: s.sendUsd.major,
        beneficiary: s.beneficiary,
        purpose: input.purpose ?? "family support",
      });
      if (verification.approved && verification.payoutAllowed) {
        await this.store.save(input.address, verification);
      }
    }

    r.applyKyc(verification, this.clock.nowIso());
    await this.repo.save(r);
    return r;
  }
}
