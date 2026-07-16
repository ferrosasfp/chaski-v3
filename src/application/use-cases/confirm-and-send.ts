import { isAddressEqual } from "viem";
import { type Remittance, isDeliveredWithinReceiveTolerance } from "../../domain/remittance";
import type {
  Clock,
  PayoutAuthorityGateway,
  PayoutGateway,
  PopSigner,
  PrincipalSettlementGateway,
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
    // WKH-168 — 7º param OPCIONAL. `settlement !== undefined` ES el criterio de "modo real": el
    // container solo lo inyecta con NEXT_PUBLIC_EIP3009_ENABLED=true ⇒ AC-5 se preserva POR
    // CONSTRUCCIÓN, sin que el use-case lea ni una env var (CD-14). Undefined = demo byte-idéntico.
    //
    // AR/MNR-4 + CR/MNR-2 — el `receiver` viaja ACOPLADO al gateway, NO como un 8º param opcional:
    //  · Antes, C5 lo resolvía llamando a `resolveReceiverAddress()` (infrastructure/chain) desde
    //    application/ → el PRIMER import application→infrastructure de producción del repo, contra
    //    el invariante de application/errors.ts:1-3. Costo ya materializado: los tests unitarios de
    //    este use-case tuvieron que stubear `process.env`.
    //  · Un `receiver?: string` suelto recrearía el fail-open que el Story File prohíbe para
    //    `remittanceId` (CD-19): si llegara `undefined`, C5 se saltearía EN SILENCIO.
    //  · Acoplado, el tipo hace el trabajo: `settlement !== undefined` ⇔ modo real ⇔ el guard
    //    fail-loud del container (container.ts:60-68) YA probó que el receiver está configurado y
    //    bien formado (resolveReceiverAddress() throwea en construcción). Misma env, mismo
    //    composition root, mismo guard ⇒ C5 queda IDÉNTICO en fuerza, sin opcional y sin fail-open.
    private readonly settlement?: { gateway: PrincipalSettlementGateway; receiver: `0x${string}` },
    // WKH-206 — 8º param OPCIONAL. MISMO criterio que `settlement`: el container solo lo inyecta con
    // NEXT_PUBLIC_PAYOUT_POP_ENABLED=true ⇒ AC-5 se preserva POR CONSTRUCCIÓN, sin que el use-case lea
    // env vars (CD-13). Undefined = demo byte-idéntico (no se adjunta prueba al submit).
    private readonly pop?: PopSigner,
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
    // AC-6/DT-8 (WKH-168): con el principal REALMENTE adentro (settleado y verificado on-chain),
    // LedgerRefundGateway NO revierte nada (ledger-refund-gateway.ts:9 devuelve un refundTx
    // SINTÉTICO). Reusar el reason normal sería una mentira NUEVA y peligrosa: diría "refunded"
    // sobre plata que sigue en el receiver. Marca estable, sin PII (CD-17). El clawback real es
    // IMPOSIBLE con el patrón RefundGateway: revertir un transferWithAuthorization exige la clave
    // del RECEIVER → Scope OUT (DT-8). Resolución MANUAL. Reconciliación → WKH-207.
    // Default false ⇒ en modo demo TODO queda byte-idéntico a pre-HU (AC-5).
    const effective = principalReallyIn ? "principal_settled_refund_manual" : reason;
    r.markPayoutFailed(effective, this.clock.nowIso());
    await this.repo.save(r);
    try {
      const { refundTx } = await this.refund.creditBack({
        remittanceId: r.snapshot.id,
        amountUsd: r.snapshot.sendUsd,
        reason: effective,
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
    const { tx, eip3009 } = await this.wallet.authorizePrincipal(quote, s.id);

    // 3.2 SETTLE REAL (WKH-168). Hasta esta HU, `markPrincipalIn(tx)` marcaba la remesa como
    //     "plata adentro" con una FIRMA: nadie transmitía la autorización, nadie esperaba un
    //     receipt. `principal_in` significaba "el usuario firmó", NO "el USDC llegó" → el payout se
    //     disparaba sobre dinero que podía no existir. Ahora, en modo real, solo se llega a
    //     principal_in con un hash VERIFICADO on-chain.
    //     Modo demo (this.settlement === undefined) ⇒ NINGUNA de estas ramas corre (AC-5).
    let settlementAttestation: string | undefined;
    let principalTxHash = tx;
    if (this.settlement) {
      // C1 — invariante rota: modo real exige el payload EIP-3009 de la wallet. Sin él no hay nada
      // que transmitir ⇒ fail-loud, NUNCA markPrincipalIn (sería la mentira que la HU vino a matar).
      if (!eip3009) {
        await this.failAndRefund(r, "settlement_unverified", false);
        return r;
      }
      let res: Awaited<ReturnType<PrincipalSettlementGateway["settle"]>>;
      try {
        res = await this.settlement.gateway.settle({
          authorization: eip3009.authorization,
          signature: eip3009.signature,
          address: address ?? "", // misma coerción que authority.authorize()
          quoteId: quote.quoteId,
          expectedValueMinor: quote.send.minor,
          remittanceId: s.id, // WKH-207 (CD-5): único arg aditivo — habilita el ledger server-side
        });
      } catch {
        // C3 — CD-12: ninguna excepción escapa. Red caída/bug ⇒ bloquear (el principal NO entró, o
        // no podemos saberlo: fail-closed igual).
        await this.failAndRefund(r, "settlement_unavailable", false);
        return r;
      }
      // C2 — cualquier reason del gateway ⇒ payout_failed con principalTx en null (AC-3).
      if (!res.ok) {
        await this.failAndRefund(r, res.reason, false);
        return r;
      }
      // C4/C5 — detectores de DRIFT cliente↔server. NO son los guards del AC-2 (CR/MNR-1: el
      // comentario anterior decía que sí — la asimetría claim↔realidad del precedente WKH-203).
      // El AC-2 lo cumple el SERVER, contra hechos de la cadena, antes de emitir la atestación:
      //   · monto    → V8 (onchain-verifier.ts:126), contra el value del log Transfer del USDC.
      //   · receiver → V6 (onchain-verifier.ts:120) + settle/principal/route.ts:179, contra la ENV
      //                del server (nunca el `to` del body).
      // Ninguno de los dos checks de acá corre en el server-path: son canarios del cliente.
      //
      // C4 — NO puede fallar en producción: es un ECO, no una comparación. El server devuelve
      // `valueMinor: input.expectedValueMinor` (onchain-verifier.ts:136 — devolver el entero JS ya
      // aseverado contra la cadena en vez de `Number(t.args.value)` es DELIBERADO: un uint256 > 2^53
      // se redondearía, la lección de WKH-196), y ese input es el mismo `quote.send.minor` que le
      // mandamos en L128 ⇒ acá `x !== x`. Se conserva como canario de un refactor que rompa ese
      // contrato (el test que lo cubre inyecta un valueMinor que el server no puede emitir). CERO
      // seguridad: NO contarlo como guard.
      if (res.valueMinor !== quote.send.minor) {
        await this.failAndRefund(r, "settlement_amount_mismatch", false);
        return r;
      }
      // C5 — este SÍ puede dispararse (asimetría con C4): `res.to` es un hecho de la CADENA
      // (onchain-verifier.ts:135 devuelve `t.args.to` del log) y se compara contra el receiver
      // configurado del CLIENTE ⇒ un drift de env cliente↔server lo enciende. Tampoco es el guard
      // del money-path (ese es V6, arriba): es su detector.
      let toOk = false;
      try {
        toOk = isAddressEqual(res.to as `0x${string}`, this.settlement.receiver);
      } catch {
        toOk = false; // address malformada ⇒ fail-closed (CD-12). Sólo `res.to` puede serlo: el
        // receiver inyectado ya pasó isAddress en el container (resolveReceiverAddress()).
      }
      if (!toOk) {
        await this.failAndRefund(r, "settlement_receiver_mismatch", false);
        return r;
      }
      // C6 — AC-4: se persiste el HASH VERIFICADO on-chain, NUNCA la firma cruda.
      principalTxHash = res.txHash;
      settlementAttestation = res.attestation;
    }

    r.markPrincipalIn(principalTxHash, this.clock.nowIso());
    await this.repo.save(r);
    // A partir de acá, en modo real, el USDC está VERIFICADO adentro: cualquier fallo posterior NO
    // se puede refundear automáticamente (DT-8) → marca AC-6. En modo demo queda false ⇒ los
    // reasons de hoy siguen byte-idénticos (AC-5).
    const principalReallyIn = this.settlement !== undefined;

    // 3.5 Segundo re-check de vigencia (MNR-A, cierra el residual de M2): la FIRMA es la ventana
    //     LARGA (minutos con WalletConnect). Un quote válido en el check del paso 2.5 puede VENCER
    //     durante authorizePrincipal y aun así llegar a submit(). Re-chequeamos AQUÍ, ya con el
    //     principal adentro (principal_in → payout_failed es válido → dispara refund) SIN submitear
    //     un payout sobre un quote muerto. CD-2 intacto: CAS → autoridad → expiry → firma → EXPIRY → submit.
    //     WKH-168/C7: en modo real el principal ya está REALMENTE adentro acá → la marca AC-6.
    const nowBeforeSubmit = this.clock.nowIso();
    if (!r.isQuoteStillValid(nowBeforeSubmit)) {
      await this.failAndRefund(r, "quote_expired_before_submit", principalReallyIn);
      return r; // firma ya ocurrida, pero NO se submitea el payout
    }

    // 4. Submit del payout (idempotente por remesa+quote).
    const idempotencyKey = `${s.id}:${quote.quoteId}`;
    try {
      // WKH-206: prueba de posesión. Solo en modo opt-in (this.pop inyectado). En demo queda undefined
      // ⇒ el submit NO recibe estos campos ⇒ byte-idéntico (AC-5). CD-13: la infra viaja inyectada.
      //
      // Fix-pack AR-MNR-1 (patrón WKH-168/202 "nada fuera del try/catch"): el prove() vive DENTRO de
      // este try — el mismo que ya degrada un fallo de submit. Con el principal REALMENTE adentro
      // (markPrincipalIn en L196, principalReallyIn=true en modo real) un throw de prove() JAMÁS escapa
      // execute() ni deja la remesa varada en principal_in: el catch de abajo lo degrada controlado
      // (failAndRefund con principalReallyIn → AC-6). DT-2: prove() → null ⇒ SKIP (mecanismo apagado
      // server-side, 501) ⇒ el submit NO recibe los campos; prove() → throw ⇒ fail-closed controlado.
      let popChallenge: string | undefined;
      let popSignature: string | undefined;
      if (this.pop) {
        const proof = await this.pop.prove(address ?? "");
        if (proof) {
          popChallenge = proof.challenge;
          popSignature = proof.signature;
        }
      }
      const rec = await this.payouts.submit({
        quoteId: quote.quoteId,
        amountUsd: s.sendUsd.major,
        expectedReceivePen: quote.receive, // M3/AC-6: PEN lockeado que el usuario confirmó
        beneficiary: s.beneficiary,
        kycVerificationId: kyc.verificationId,
        address: address ?? "", // WKH-202/DT-2: misma coerción que authority.authorize() (L67)
        idempotencyKey,
        // WKH-168/AC-10: la evidencia firmada de que el principal entró de verdad. En modo demo es
        // undefined (el server la exige solo cuando SETTLE_ATTESTATION_SECRET está configurado).
        settlementAttestation,
        // WKH-206/AC-3: prueba de posesión (challenge + firma). undefined en demo ⇒ no se adjunta.
        popChallenge,
        popSignature,
      });
      r.markPayoutSubmitted(rec.payoutId, this.clock.nowIso(), rec.provenance);
      if (rec.status === "settled") {
        // Reconciliación PRE-markSettled (AC-6/CD-6): el PEN entregado debe caber en la MISMA
        // tolerancia del receive lockeado. Con el fallback (deliveredPen:null) la guarda es falsa →
        // markSettled(null) byte-idéntico a hoy. Mismatch → payout_failed→refunded, NUNCA settled.
        if (rec.deliveredPen && !isDeliveredWithinReceiveTolerance(quote.receive, rec.deliveredPen)) {
          await this.failAndRefund(r, "payout_amount_mismatch", principalReallyIn); // C8
          return r;
        }
        r.markSettled(rec.txRef ?? "", rec.deliveredPen, this.clock.nowIso(), rec.provenance);
      } else if (rec.status === "failed") {
        await this.failAndRefund(r, rec.failureReason ?? "payout_failed", principalReallyIn); // C8
        return r;
      }
    } catch (err) {
      await this.failAndRefund(
        r,
        err instanceof Error ? err.message : "payout_error",
        principalReallyIn, // C8
      );
      return r;
    }
    await this.repo.save(r); // persiste payout_submitted (fallback) o settled (happy real)
    return r;
  }
}
