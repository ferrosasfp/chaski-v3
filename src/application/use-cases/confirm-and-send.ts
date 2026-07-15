import { type Remittance, isDeliveredWithinReceiveTolerance } from "../../domain/remittance";
import type {
  Clock,
  PayoutAuthorityGateway,
  PayoutGateway,
  RefundGateway,
  RemittanceRepository,
  WalletPort,
} from "../ports";

/**
 * Confirmación + envío. El corazón del money-path (value-delivery orquestado en el cliente):
 * confirm (invariante DURA) → autorizar principal (wallet) → principal_in → submit payout → estado.
 * Cada paso persiste (idempotencia/recuperación). Un fallo de payout → payout_failed (→ refund).
 */
export class ConfirmAndSend {
  constructor(
    private readonly wallet: WalletPort,
    private readonly payouts: PayoutGateway,
    private readonly repo: RemittanceRepository,
    private readonly clock: Clock,
    private readonly authority: PayoutAuthorityGateway,
    private readonly refund: RefundGateway,
  ) {}

  /** Refund-on-failure (WKH-186/AC-7, CD-7): marca payout_failed y acto seguido intenta el credit-back
   * en el MISMO execute() (ninguna remesa queda huérfana en payout_failed). El refund es best-effort:
   * si falla, la remesa queda en payout_failed (el mock nunca falla). `reason` = enum estable, NUNCA
   * PII (CD-5). Nota Fase A: en modo real el refund del auth-gate/expiry pre-firma (principal nunca
   * pulleado) debería condicionarse a principalTx != null; hoy es NO-OP ledger (DT-3) → refundear
   * uniformemente cierra el gap (AC-7 = "por cualquier razón"). La condicionalidad real = follow-up. */
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

    // 1. Confirmar: la invariante del dominio exige KYC pasado + quote válido no vencido.
    r.confirm(this.clock.nowIso());
    await this.repo.save(r);
    const s = r.snapshot;
    const quote = s.quote;
    const kyc = s.kyc;
    if (!quote || !kyc) throw new Error("invariant_violation_missing_quote_or_kyc");

    // 2. Autoridad server-side de payout (WKH-180): re-valida contra Didit ANTES de mover valor.
    //    El override server-side gana SIEMPRE sobre el estado client-side (kyc.approved podría estar
    //    forjado en localStorage — CD-2/AC-6). confirmed → payout_failed es transición válida
    //    (remittance.ts:65) → se falla sin pull del principal on-chain, sin mover plata del sender.
    const address = await this.wallet.getAddress();
    const auth = await this.authority.authorize({
      verificationId: kyc.verificationId,
      address: address ?? "",
    });
    if (!auth.authorized) {
      await this.failAndRefund(r, auth.reason ?? "kyc_reauth_failed");
      return r; // NO se autoriza el principal, NO se submitea el payout
    }

    // 2.5 Re-check de vigencia del quote (M2/AC-5, CD-2): la ventana confirm→firma es de minutos
    //     (firma EIP-3009 real). Si el quote venció ENTRE confirm y submit → payout_failed SIN
    //     authorizePrincipal ni submit (orden de guards: CAS → autoridad → expiry → firma → submit).
    const nowRecheck = this.clock.nowIso();
    if (!r.isQuoteStillValid(nowRecheck)) {
      await this.failAndRefund(r, "quote_expired_before_submit");
      return r;
    }

    // 3. Autorizar el principal on-chain (el sender firma; el operador NO fondea).
    //    (paso renumerado tras insertar la autoridad server-side WKH-180 como paso 2)
    const { tx } = await this.wallet.authorizePrincipal(quote);
    r.markPrincipalIn(tx, this.clock.nowIso());
    await this.repo.save(r);

    // 3.5 Segundo re-check de vigencia (MNR-A, cierra el residual de M2): la FIRMA es la ventana
    //     LARGA (minutos con WalletConnect). Un quote válido en el check del paso 2.5 puede VENCER
    //     durante authorizePrincipal y aun así llegar a submit(). Re-chequeamos AQUÍ, ya con el
    //     principal adentro (principal_in → payout_failed es válido → dispara refund) SIN submitear
    //     un payout sobre un quote muerto. CD-2 intacto: CAS → autoridad → expiry → firma → EXPIRY → submit.
    const nowBeforeSubmit = this.clock.nowIso();
    if (!r.isQuoteStillValid(nowBeforeSubmit)) {
      await this.failAndRefund(r, "quote_expired_before_submit");
      return r; // firma ya ocurrida, pero NO se submitea el payout
    }

    // 4. Submit del payout (idempotente por remesa+quote).
    const idempotencyKey = `${s.id}:${quote.quoteId}`;
    try {
      const rec = await this.payouts.submit({
        quoteId: quote.quoteId,
        amountUsd: s.sendUsd.major,
        expectedReceivePen: quote.receive, // M3/AC-6: PEN lockeado que el usuario confirmó
        beneficiary: s.beneficiary,
        kycVerificationId: kyc.verificationId,
        idempotencyKey,
      });
      r.markPayoutSubmitted(rec.payoutId, this.clock.nowIso(), rec.provenance);
      if (rec.status === "settled") {
        // Reconciliación PRE-markSettled (AC-6/CD-6): el PEN entregado debe caber en la MISMA
        // tolerancia del receive lockeado. Con el fallback (deliveredPen:null) la guarda es falsa →
        // markSettled(null) byte-idéntico a hoy. Mismatch → payout_failed→refunded, NUNCA settled.
        if (rec.deliveredPen && !isDeliveredWithinReceiveTolerance(quote.receive, rec.deliveredPen)) {
          await this.failAndRefund(r, "payout_amount_mismatch");
          return r;
        }
        r.markSettled(rec.txRef ?? "", rec.deliveredPen, this.clock.nowIso(), rec.provenance);
      } else if (rec.status === "failed") {
        await this.failAndRefund(r, rec.failureReason ?? "payout_failed");
        return r;
      }
    } catch (err) {
      await this.failAndRefund(r, err instanceof Error ? err.message : "payout_error");
      return r;
    }
    await this.repo.save(r); // persiste payout_submitted (fallback) o settled (happy real)
    return r;
  }
}
