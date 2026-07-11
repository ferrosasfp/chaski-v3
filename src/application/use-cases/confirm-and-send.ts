import type { Remittance } from "../../domain/remittance";
import type {
  Clock,
  PayoutGateway,
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
  ) {}

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

    // 2. Autorizar el principal on-chain (el sender firma; el operador NO fondea).
    const { tx } = await this.wallet.authorizePrincipal(quote);
    r.markPrincipalIn(tx, this.clock.nowIso());
    await this.repo.save(r);

    // 3. Submit del payout (idempotente por remesa+quote).
    const idempotencyKey = `${s.id}:${quote.quoteId}`;
    try {
      const rec = await this.payouts.submit({
        quoteId: quote.quoteId,
        amountUsd: s.sendUsd.major,
        beneficiary: s.beneficiary,
        kycVerificationId: kyc.verificationId,
        idempotencyKey,
      });
      r.markPayoutSubmitted(rec.payoutId, this.clock.nowIso());
      if (rec.status === "settled") {
        r.markSettled(rec.txRef ?? "", rec.deliveredPen, this.clock.nowIso());
      } else if (rec.status === "failed") {
        r.markPayoutFailed(rec.failureReason ?? "payout_failed", this.clock.nowIso());
      }
    } catch (err) {
      r.markPayoutFailed(err instanceof Error ? err.message : "payout_error", this.clock.nowIso());
    }
    await this.repo.save(r);
    return r;
  }
}
