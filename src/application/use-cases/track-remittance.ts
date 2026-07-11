import type { Remittance } from "../../domain/remittance";
import type { Clock, PayoutGateway, RemittanceRepository } from "../ports";

/** Polling del estado del payout → actualiza el agregado (settled / failed). Idempotente. */
export class TrackRemittance {
  constructor(
    private readonly payouts: PayoutGateway,
    private readonly repo: RemittanceRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: { remittanceId: string }): Promise<Remittance> {
    const r = await this.repo.get(input.remittanceId);
    if (!r) throw new Error("remittance_not_found");
    const s = r.snapshot;
    if (r.isTerminal || !s.payoutId || s.status !== "payout_submitted") return r;

    const rec = await this.payouts.status(s.payoutId);
    if (rec.status === "settled") {
      r.markSettled(rec.txRef ?? "", rec.deliveredPen, this.clock.nowIso());
      await this.repo.save(r);
    } else if (rec.status === "failed") {
      r.markPayoutFailed(rec.failureReason ?? "payout_failed", this.clock.nowIso());
      await this.repo.save(r);
    }
    return r;
  }
}
