import type { RemittanceState } from "../../domain/remittance";
import type { Clock, KycGateway, KycPendingStore, KycStore, RemittanceRepository } from "../ports";

/**
 * Retoma el KYC al volver del redirect a Didit. Lee el pendiente (sessionId), consulta la
 * decisión y la aplica. Si Didit aún procesa (no terminal) → "processing" (la UI reintenta).
 */
export type ResumeKycResult =
  | { kind: "none" }
  | { kind: "processing" }
  | { kind: "passed"; snapshot: Readonly<RemittanceState> }
  | { kind: "failed"; snapshot: Readonly<RemittanceState> };

export class ResumeKyc {
  constructor(
    private readonly kyc: KycGateway,
    private readonly kycStore: KycStore,
    private readonly pending: KycPendingStore,
    private readonly repo: RemittanceRepository,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<ResumeKycResult> {
    const p = await this.pending.get();
    if (!p) return { kind: "none" };

    const r = await this.repo.get(p.remittanceId);
    if (!r) {
      await this.pending.clear();
      return { kind: "none" };
    }
    // Si la remesa ya salió de kyc_pending (retomada antes), no reaplicar.
    if (r.snapshot.status !== "kyc_pending") {
      await this.pending.clear();
      return { kind: "none" };
    }

    let dec: Awaited<ReturnType<KycGateway["decision"]>>;
    try {
      dec = await this.kyc.decision(p.sessionId, p.sessionToken);
    } catch {
      return { kind: "processing" }; // reintentable
    }
    if (!dec.terminal) return { kind: "processing" };

    const v = dec.verification;
    if (v.approved && v.payoutAllowed) await this.kycStore.save(p.address, v);
    r.applyKyc(v, this.clock.nowIso());
    await this.repo.save(r);
    await this.pending.clear();
    return { kind: r.status === "kyc_passed" ? "passed" : "failed", snapshot: r.snapshot };
  }
}
