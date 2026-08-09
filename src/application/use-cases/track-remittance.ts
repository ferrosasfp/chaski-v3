import { type Remittance, isDeliveredWithinReceiveTolerance } from "../../domain/remittance";
import { isRealRefundReceipt } from "../refund-receipt";
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
   * queda en payout_failed (el mock nunca falla). `reason` = enum estable, NUNCA PII (CD-5).
   *
   * ⚠️ Este era el peor caso del comprobante fabricado, porque acá el principal está SEGURO adentro:
   * se llega desde payout_submitted, o sea con el deposit ya confirmado on-chain en el vault. El
   * payout falló, se escribía un `refund-ledger-…` inventado, la remesa quedaba en `refunded`
   * (terminal) y el botón de recuperar desaparecía para siempre, con la plata en el escrow. */
  private async failAndRefund(r: Remittance, reason: string): Promise<void> {
    r.markPayoutFailed(reason, this.clock.nowIso());
    await this.repo.save(r);
    try {
      const { refundTx } = await this.refund.creditBack({
        remittanceId: r.snapshot.id,
        amountUsd: r.snapshot.sendUsd,
        reason,
      });
      // Sin comprobante real NO hay estado terminal: la remesa se queda en payout_failed, que es
      // desde donde el sender todavía puede recuperar sus fondos del escrow.
      if (!isRealRefundReceipt(refundTx)) return;
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
    // 🔴 DEFENSA EN PROFUNDIDAD (CR, autorizado). El record TIENE que hablar del payout que se pidió.
    // Este use-case confiaba en eso, y WKH-337/AR-BLQ-ALTO-1 fue exactamente su violación: un caché sin
    // clave en el gateway devolvía el desenlace de OTRA remesa, y como `settled` no está en
    // `RECOVERABLE` el remitente perdía su único camino a sus USDC. Eso se arregló en el gateway; esta
    // línea hace que NINGÚN gateway futuro pueda volver a producir ese daño desde acá.
    if (rec.payoutId !== s.payoutId) return r;
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
