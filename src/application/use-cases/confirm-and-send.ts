import type { Remittance } from "../../domain/remittance";
import type {
  Clock,
  PayoutAuthorityGateway,
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
    private readonly authority: PayoutAuthorityGateway,
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
      r.markPayoutFailed(auth.reason ?? "kyc_reauth_failed", this.clock.nowIso());
      await this.repo.save(r);
      return r; // NO se autoriza el principal, NO se submitea el payout
    }

    // 3. Autorizar el principal on-chain (el sender firma; el operador NO fondea).
    //    (paso renumerado tras insertar la autoridad server-side WKH-180 como paso 2)
    const { tx } = await this.wallet.authorizePrincipal(quote);
    r.markPrincipalIn(tx, this.clock.nowIso());
    await this.repo.save(r);

    // 4. Submit del payout (idempotente por remesa+quote).
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
