import { type Remittance, isDeliveredWithinReceiveTolerance } from "../../domain/remittance";
import type { Clock, PayoutGateway, RefundGateway, RemittanceRepository } from "../ports";

/** Polling del estado del payout → actualiza el agregado (settled / failed). Idempotente. */
export class TrackRemittance {
  constructor(
    private readonly payouts: PayoutGateway,
    private readonly repo: RemittanceRepository,
    private readonly clock: Clock,
    private readonly refund: RefundGateway,
  ) {}

  /** Refund-on-failure (WKH-186/AC-7, CD-7): idéntico a ConfirmAndSend — marca payout_failed y
   * acto seguido intenta el credit-back en el MISMO execute(). Best-effort: si el refund falla,
   * queda en payout_failed (el mock nunca falla). `reason` = enum estable, NUNCA PII (CD-5). */
  private async failAndRefund(r: Remittance, reason: string): Promise<void> {
    r.markPayoutFailed(reason, this.clock.nowIso());
    await this.repo.save(r);
    try {
      const { refundTx } = await this.refund.creditBack({
        remittanceId: r.snapshot.id,
        amountUsd: r.snapshot.sendUsd,
        reason,
      });
      r.markRefunded(refundTx, this.clock.nowIso());
      await this.repo.save(r);
    } catch {
      // refund falló → queda en payout_failed (best-effort). El mock nunca falla.
    }
  }

  async execute(input: { remittanceId: string }): Promise<Remittance> {
    const r = await this.repo.get(input.remittanceId);
    if (!r) throw new Error("remittance_not_found");
    const s = r.snapshot;
    if (r.isTerminal || !s.payoutId || s.status !== "payout_submitted") return r;

    const rec = await this.payouts.status(s.payoutId);
    if (rec.status === "settled") {
      // MNR-D: la reconciliación va DENTRO de un try/catch — simétrico con ConfirmAndSend. Si
      // isDeliveredWithinReceiveTolerance lanzara (ej. reconcile_currency_mismatch por monedas
      // divergentes), la rejection NO debe escapar cruda de execute(): se degrada a failAndRefund
      // con razón estable. Money-path uniformemente fail-safe (nunca una promesa rechazada al UI).
      try {
        // Reconciliación PRE-markSettled (AC-6/CD-6): reusa el receive lockeado del quote persistido.
        // Con el fallback (deliveredPen:null) la guarda es falsa → markSettled(null) byte-idéntico.
        const expected = s.quote?.receive ?? null;
        if (expected && rec.deliveredPen && !isDeliveredWithinReceiveTolerance(expected, rec.deliveredPen)) {
          await this.failAndRefund(r, "payout_amount_mismatch");
          return r;
        }
        r.markSettled(rec.txRef ?? "", rec.deliveredPen, this.clock.nowIso(), rec.provenance);
        await this.repo.save(r);
      } catch (err) {
        await this.failAndRefund(r, err instanceof Error ? err.message : "reconcile_error");
        return r;
      }
    } else if (rec.status === "failed") {
      await this.failAndRefund(r, rec.failureReason ?? "payout_failed");
    }
    return r;
  }
}
