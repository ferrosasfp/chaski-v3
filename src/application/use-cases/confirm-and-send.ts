import type { Remittance } from "../../domain/remittance";
import { isRealRefundReceipt } from "../refund-receipt";
import type {
  Clock,
  PayoutAuthorityGateway,
  RefundGateway,
  RemittanceRepository,
  SolanaPayoutPrepareGateway,
  SolanaSettlementGateway,
  WalletPort,
} from "../ports";

/**
 * Confirmación + envío. El corazón del money-path (value-delivery orquestado en el cliente):
 * confirm (invariante DURA) → autoridad server-side → re-check de vigencia → prepare server-side →
 * depósito en el escrow (wallet) → broadcast vía facilitator → principal_in → payout_submitted.
 * Cada paso persiste (idempotencia/recuperación). Un fallo de payout → payout_failed (→ refund).
 */
export class ConfirmAndSend {
  constructor(
    private readonly wallet: WalletPort,
    private readonly repo: RemittanceRepository,
    private readonly clock: Clock,
    private readonly authority: PayoutAuthorityGateway,
    private readonly refund: RefundGateway,
    // HU-SOL-13 (WKH-216) — 6º param OPCIONAL `solana`. Gateway+prepare viajan ACOPLADOS:
    // `solana !== undefined ⇔ modo real` (invariante anti-fail-open: un `prepare?` suelto que quede
    // undefined saltearía el binding EN SILENCIO). El container lo inyecta SOLO con el flag de
    // settlement ON y los envs validados. El use-case NUNCA lee process.env (CD-14).
    //
    // Su ausencia NO cae a un modo alternativo: cae al vacío. Por eso hay un tapón fail-closed
    // explícito al entrar al bloque (DT-8); sin él, `execute()` llegaría al final y devolvería la
    // remesa 'confirmed' SIN haber movido nada.
    private readonly solana?: {
      prepare: SolanaPayoutPrepareGateway;
      gateway: SolanaSettlementGateway;
    },
  ) {}

  /** Refund-on-failure (WKH-186/AC-7, CD-7): marca payout_failed y acto seguido intenta el credit-back
   * en el MISMO execute() (ninguna remesa queda huérfana en payout_failed). El refund es best-effort:
   * si falla, la remesa queda en payout_failed (el mock nunca falla). `reason` = enum estable, NUNCA
   * PII (CD-5). Nota Fase A: en modo real el refund del auth-gate/expiry pre-firma (principal nunca
   * pulleado) debería condicionarse a principalTx != null; hoy es NO-OP ledger (DT-3) → refundear
   * uniformemente cierra el gap (AC-7 = "por cualquier razón"). La condicionalidad real = follow-up. */
  private async failAndRefund(
    r: Remittance,
    reason: string,
    principalReallyIn = false,
  ): Promise<void> {
    // AC-6/DT-8 (WKH-168): con el principal REALMENTE adentro (depositado y confirmado on-chain),
    // LedgerRefundGateway NO revierte nada (ledger-refund-gateway.ts:9 devuelve un refundTx
    // SINTÉTICO). Reusar el reason normal sería una mentira NUEVA y peligrosa: diría "refunded"
    // sobre plata que sigue adentro. Marca estable, sin PII (CD-17). El clawback real NO es de este
    // patrón: el vault del escrow se recupera por refund trustless post-deadline (SolanaEscrowRefund-
    // Gateway) o por la release-authority. Resolución MANUAL. Reconciliación → WKH-207.
    // Default false ⇒ el caller lo pasa explícito cuando el depósito ya está adentro.
    const effective = principalReallyIn ? "principal_settled_refund_manual" : reason;
    r.markPayoutFailed(effective, this.clock.nowIso());
    await this.repo.save(r);
    try {
      const { refundTx } = await this.refund.creditBack({
        remittanceId: r.snapshot.id,
        amountUsd: r.snapshot.sendUsd,
        reason: effective,
      });
      // ⚠️ Sin comprobante REAL no se escribe `refunded`. Antes se escribía siempre, con el string
      // fabricado del adapter ledger-only adentro, y `refunded` es TERMINAL: la remesa quedaba con una
      // referencia de reembolso inventada y sin ninguna salida (el botón de recuperar exige
      // refundTx == null y el use-case de recuperación corta con refund_not_available). Quedarse en
      // payout_failed no es un estado peor: es el único desde el que la persona puede sacar su plata.
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
    //     (firma real en la wallet). Si el quote venció ENTRE confirm y firma → payout_failed SIN
    //     authorizePrincipal ni settle (orden de guards: CAS → autoridad → expiry → prepare → firma).
    const nowRecheck = this.clock.nowIso();
    if (!r.isQuoteStillValid(nowRecheck)) {
      await this.failAndRefund(r, "quote_expired_before_submit");
      return r;
    }

    // 2.6 Settlement no-custodial contra el escrow (HU-SOL-13/AC-1). Es el CAMINO ÚNICO: su ausencia
    //     no cae a un modo alternativo, cae al vacío.
    // DT-8 — tapón fail-closed. Sin `solana` inyectado (flag apagado / envs faltantes) el
    // use-case llegaría al final y devolvería la remesa 'confirmed' SIN haber movido nada: un no-op
    // silencioso en el money-path. Reusa el reason estable `settlement_unavailable` y failAndRefund,
    // sin enums nuevos y sin leer una sola env (CD-13/CD-14 intactos).
    if (!this.solana) {
      await this.failAndRefund(r, "settlement_unavailable", false);
      return r;
    }
    // 1. PREPARE server-side (análogo a 2.7): resuelve beneficiary+authority SERVER-SIDE (NUNCA del
    //    body — AC-1/CD-7). Fallo ⇒ falla ANTES de firmar (el deposit NO entró, principalReallyIn=false).
    let prep: Awaited<ReturnType<SolanaPayoutPrepareGateway["prepare"]>>;
    try {
      prep = await this.solana.prepare.prepare({
        remittanceId: s.id,
        quoteId: quote.quoteId,
        kycVerificationId: kyc.verificationId,
        address: address ?? "", // misma coerción que authority.authorize()
        amountUsd: s.sendUsd.major,
        beneficiary: s.beneficiary,
        idempotencyKey: `${s.id}:${quote.quoteId}`,
      });
    } catch {
      await this.failAndRefund(r, "prepare_unavailable", false);
      return r;
    }
    if (!prep.ok) {
      await this.failAndRefund(r, prep.reason, false);
      return r;
    }
    // 2. authorizePrincipal: la wallet arma+partial-firma la ix `deposit` del escrow con el
    //    beneficiary+authority resueltos server-side (HU-SOL-5 ya arma el deposit desde el 3er arg).
    const { solana } = await this.wallet.authorizePrincipal(quote, s.id, {
      address: prep.result.beneficiary,
      escrow: { beneficiary: prep.result.beneficiary, authority: prep.result.authority },
    });
    // Sin el envelope Solana no hay tx que broadcastear ⇒ fail-closed, NUNCA markPrincipalIn (la
    // mentira que la HU vino a matar). El deposit NO entró ⇒ principalReallyIn=false.
    if (!solana) {
      await this.failAndRefund(r, "settlement_unverified", false);
      return r;
    }
    // 3. BROADCAST del deposit vía el facilitator (gasless, /api/settle/solana-sponsor → /solana/sponsor).
    //    Excepción (red/bug) ⇒ fail-closed (patrón C3); reason del gateway ⇒ payout_failed. Ambos con
    //    principalReallyIn=false (el deposit no se confirmó, o no podemos saberlo: fail-closed igual).
    let res: Awaited<ReturnType<SolanaSettlementGateway["settle"]>>;
    try {
      res = await this.solana.gateway.settle({
        partialSignedTx: solana.partialSignedTx,
        reference: solana.reference,
        sender: address ?? "",
        remittanceId: s.id,
      });
    } catch {
      await this.failAndRefund(r, "solana_settle_unavailable", false);
      return r;
    }
    if (!res.ok) {
      await this.failAndRefund(r, res.reason, false);
      return r;
    }
    // 4. markPrincipalIn con la signature base58 VERIFICADA on-chain por /solana/sponsor. Luego
    //    payout_submitted con el payoutId de prepare (la orden de desembolso ya se creó).
    //
    //    ⚠️ ACÁ TERMINA EL FLUJO AUTOMÁTICO, y esto decía lo contrario. Decía que "la RELEASE del
    //    vault la dispara el facilitator (13c) async, NO chaski". La segunda mitad es cierta: chaski
    //    no la dispara (cero referencias a `escrow/release` en este repo). La primera es FALSA: no
    //    hay nada async. El facilitator expone POST /solana/escrow/release y sólo responde cuando
    //    alguien se lo pide; no existe hoy, en ninguno de los tres repos, un componente que decida
    //    llamarlo. Hoy ese release lo ejecuta una PERSONA a mano.
    //
    //    Consecuencia para quien lea esto: la remesa queda en payout_submitted con el dinero todavía
    //    en el vault del escrow. Que llegue a "entregado" en el camino Solana es un hueco de
    //    producto abierto, no un paso que ocurre solo más tarde.
    r.markPrincipalIn(res.signature, this.clock.nowIso());
    await this.repo.save(r);
    r.markPayoutSubmitted(prep.result.payoutId, this.clock.nowIso(), prep.result.provenance);
    await this.repo.save(r);
    return r;
  }
}
