import type { Remittance } from "../../domain/remittance";
import { isRealRefundReceipt } from "../refund-receipt";
import { SENDER_MIN_LAMPORTS_FOR_DEPOSIT } from "../solana-escrow-rent";
import type {
  Clock,
  PayoutAuthorityGateway,
  PrincipalDepositState,
  RefundGateway,
  RemittanceRepository,
  SolanaEscrowDepositProbe,
  SolanaPayoutPrepareGateway,
  SolanaSenderSolBalance,
  SolanaSenderSolBalanceProbe,
  SolanaSettlementFailureReason,
  SolanaSettlementGateway,
  WalletPort,
} from "../ports";

/** Marca estable (enum, NUNCA PII): el principal está REALMENTE en el vault del escrow y este código
 *  no puede sacarlo. La salida es el refund trustless que firma el propio sender (o la
 *  release-authority, a mano). La UI la usa para no decir "no pudo entregarse" a secas. */
export const PRINCIPAL_SETTLED_REFUND_MANUAL = "principal_settled_refund_manual";

/** Marca estable del TERCER caso, el que antes no existía: perdimos la respuesta del settle y la
 *  cadena tampoco nos contestó, así que NO SABEMOS si el depósito entró. No es un fallo (no probamos
 *  que no entró) ni un éxito. La remesa queda en payout_failed, que es recuperable, y la UI se lo dice
 *  a la persona con esas palabras en vez de inventarle un reembolso. */
export const PRINCIPAL_STATE_UNKNOWN = "principal_state_unknown";

/**
 * Marca estable de una causa LOCAL, trivial y anterior a todo: este cliente no tiene la dirección de
 * la wallet, así que no hay a quién autorizar ni con qué firmar.
 *
 * POR QUÉ TIENE CÓDIGO PROPIO. Sin este guard, `address` viajaba como `""` hasta la autoridad de
 * payout, que canonicaliza base58 y tira con el vacío (`address.ts`:13-19); el catch de
 * `authority.ts`:135 convierte cualquier throw en 502 `kyc_reauth_failed`, o sea "el proveedor de
 * identidad falló". Es un diagnóstico FALSO, y caro: manda a mirar a Didit, o a reintentar el KYC,
 * cuando lo único que hay que hacer es reconectar la wallet. Coincide con el 502 indiagnosticable de
 * un recorrido manual del 2026-08-02.
 *
 * Lo que este código afirma, y nada más: no pudimos leer la address. NO dice que el KYC haya fallado,
 * ni que la autoridad esté caída, ni que se haya movido plata — el guard corta ANTES de la primera
 * llamada de red del money-path, así que "no se movió nada" es un hecho, no una suposición.
 */
export const WALLET_ADDRESS_UNAVAILABLE = "wallet_address_unavailable";

/**
 * Marca estable de otra causa LOCAL y anterior a todo: la wallet del remitente no tiene el SOL que la
 * ix `deposit` necesita para crear las cuentas del escrow.
 *
 * POR QUÉ TIENE CÓDIGO PROPIO, y por qué éste es el peor diagnóstico posible sin él. El depósito NO es
 * gasless para el remitente: el fee de red lo paga el facilitator (feePayer), pero el rent de
 * `escrow_state`, del vault y del `escrow_index` sale de su billetera (`payer = sender` en el contexto
 * `Deposit` del programa). Alguien con USDC de sobra y 0,004 SOL de menos recorría, antes de este
 * guard, TODO el camino: dos prompts de billetera, CR-1 aprobando, el facilitator co-firmando, el
 * preflight del validador rechazando por rent insuficiente, cuatro reintentos, un 502
 * `SPONSOR_BROADCAST_FAILED` que llega como `solana_settle_broadcast_failed` — que NO está en
 * SETTLE_REASONS_BEFORE_BROADCAST, así que va a preguntarle a la cadena — y la cadena no encuentra la
 * cuenta, contesta "unknown", y la pantalla termina diciendo "No sabemos todavía si te cobramos".
 * Nada se movió, y la causa era que faltaban ~0,004 SOL.
 *
 * Lo que este código afirma, y nada más: cuando lo consultamos, el saldo de SOL del remitente estaba
 * por debajo de lo que cuesta crear las cuentas. NO dice que el envío haya fallado, ni que se haya
 * cobrado nada: el guard corta ANTES del prepare y ANTES de la primera firma, así que "no se movió
 * nada" es un hecho.
 */
export const SOLANA_SENDER_SOL_INSUFFICIENT = "solana_sender_sol_insufficient";

/**
 * Marca estable del 503 con el que NUESTRA route corta cuando no puede consultar el registro de
 * direcciones preparadas (bloque S3.5, `app/api/settle/solana-sponsor/route.ts`:126-133).
 *
 * POR QUÉ TIENE CÓDIGO PROPIO, y no alcanzaba con el que ya había. La route emite ese 503 en la
 * rama del `catch` de `listPreparedDepositAddresses`, que está ANTES del `fetch` al facilitator
 * (route.ts:156): no hubo forward, no se gastó rate-limit, no se escribió una fila. La transacción
 * nunca salió, y eso no es una suposición sino el orden del archivo. Pero el gateway HTTP lo
 * colapsaba con `solana_settle_unavailable`, que ADEMÁS cubre el timeout de 15 s de ese mismo
 * fetch, o sea un caso posterior al broadcast. Como no se pueden tratar igual, mandaba a la cadena:
 * el probe no encontraba la cuenta (nunca existió), contestaba "unknown", y la pantalla terminaba
 * en "No sabemos todavía si te cobramos… Puede que tus USDC estén en el escrow o que nunca hayan
 * salido de tu wallet". La app decía no saber algo que sabía, sobre la plata de alguien.
 *
 * ⚠️ EL ARREGLO BARATO ERA PEOR QUE EL BUG. Meter `solana_settle_unavailable` en
 * SETTLE_REASONS_BEFORE_BROADCAST arrastraría el timeout, y ahí la app afirmaría "no se movió nada"
 * sobre una transacción que el facilitator pudo haber broadcasteado y confirmado. Equivocarse hacia
 * "no sabemos" cuesta un diagnóstico pobre; equivocarse hacia "no salió" cuesta que alguien deje de
 * buscar unos USDC que están en el vault.
 *
 * Lo que este código afirma, y nada más: la route cortó antes de reenviar. NO dice que el
 * facilitator esté caído, ni que el destino esté mal, ni que se haya cobrado algo.
 */
export const SOLANA_SETTLE_LEDGER_UNAVAILABLE: SolanaSettlementFailureReason =
  "solana_settle_ledger_unavailable";

/** Reasons del settle que PRUEBAN que el depósito nunca salió hacia la cadena, porque la respuesta
 *  viene de un punto ANTERIOR al broadcast:
 *    · solana_settle_rejected (422): el facilitator se negó a esponsorear (la tx nunca tuvo firma
 *      del feePayer, así que no puede entrar en ningún bloque). También cubre el 400/501 de nuestra
 *      propia route, que corta antes de reenviar.
 *    · solana_settle_rate_limited (429): ni lo procesó.
 *    · solana_settle_beneficiary_mismatch / _unconfirmed: el guard de destino (S3.5) de nuestra route
 *      cortó ANTES del forward. La route no llegó a hacer el fetch al facilitator, así que no hay tx
 *      viajando y "no entró" es un hecho, no una suposición. Que estén acá NO es una optimización:
 *      mandarlos a preguntar a la cadena hace que un probe que conteste otra cosa PISE el reason, y
 *      `beneficiary_mismatch` es el único de todo el catálogo que describe un ataque en curso.
 *      Sobrescribirlo con "no sabemos" o con "resolución manual" vuelve invisible al ataque en la
 *      única superficie donde queda escrito (failureReason de la remesa).
 *    · solana_settle_ledger_unavailable (503): el MISMO guard S3.5, en su rama de "no pude
 *      preguntarle a la DB". Sale del `catch` de route.ts:126-133, que también está antes del
 *      `fetch`. Ver SOLANA_SETTLE_LEDGER_UNAVAILABLE para por qué necesitó reason propio.
 *  TODO LO DEMÁS es indeterminado y NO se puede leer como "no pasó": un timeout de 15 s (503), un 502,
 *  o un 200 con shape raro son compatibles con un depósito perfectamente confirmado del otro lado.
 *  Para esos se va a preguntarle a la cadena, que es la única fuente autoritativa.
 *
 *  ⚠️ REGLA PARA EL PRÓXIMO REASON QUE SE AGREGUE a SolanaSettlementFailureReason: si lo emite
 *  /api/settle/solana-sponsor ANTES de su `fetch` al facilitator, va en esta lista; si puede salir
 *  de después (o de un intermediario), NO va. El default de no estar acá es el seguro (se pregunta),
 *  pero no es gratis: cuesta el reason.
 *
 *  ⚠️ Y EL COROLARIO QUE YA SE COBRÓ UNA VEZ: la regla se aplica a un REASON, no a un status ni a
 *  una frase. `solana_settle_unavailable` NO va acá y no puede ir nunca mientras siga siendo el
 *  reason del timeout de 15 s, por más que uno de los casos que hoy cubre (o que cubrió) se corte
 *  antes del forward. Cuando un reason mezcla los dos lados, lo que hay que agregar es un reason
 *  nuevo, no una entrada más en esta lista. */
const SETTLE_REASONS_BEFORE_BROADCAST: readonly SolanaSettlementFailureReason[] = [
  "solana_settle_rejected",
  "solana_settle_rate_limited",
  "solana_settle_beneficiary_mismatch",
  "solana_settle_beneficiary_unconfirmed",
  SOLANA_SETTLE_LEDGER_UNAVAILABLE,
  // SDD 037 — el 403 del facilitator sale de sus guards de autorización, que corren ANTES de
  // resolver la key del feePayer, antes de reservar cap diario y antes de `cosignAndBroadcast`.
  // La transacción no salió, y eso sí se puede afirmar. Fuera de esta lista, cada firma rechazada
  // dispararía una consulta a la cadena para preguntar por una tx que nunca se transmitió.
  "solana_settle_sender_proof_invalid",
];

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
    // `probe` viaja en el MISMO bundle y es REQUERIDO por la misma razón que prepare y gateway: un
    // `probe?` suelto que quedara undefined haría que el use-case dejara de preguntarle a la cadena EN
    // SILENCIO, y volvería a tratar "no pude preguntar" como "no pasó".
    // `senderBalance` viaja en el MISMO bundle, y es REQUERIDO por una razón distinta a la de los
    // otros tres: no es fail-open lo que evita, es que el chequeo desaparezca sin que nadie lo note.
    // Un `senderBalance?` que quedara undefined haría que el guard de rent no corriera EN SILENCIO y
    // el flujo volvería, sin ruido, al 502 indiagnosticable que este guard vino a matar.
    private readonly solana?: {
      prepare: SolanaPayoutPrepareGateway;
      gateway: SolanaSettlementGateway;
      probe: SolanaEscrowDepositProbe;
      senderBalance: SolanaSenderSolBalanceProbe;
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
    principal: PrincipalDepositState = "not_deposited",
  ): Promise<void> {
    // ⚠️ ACÁ VIVÍA UN BOOLEAN, Y UN BOOLEAN NO PODÍA DECIR LA VERDAD.
    // El parámetro era `principalReallyIn = false` y todos los callers del camino Solana pasaban
    // `false`, incluido el que atrapa una excepción del settle. Pero una excepción ahí incluye el caso
    // en que se cortó la red MIENTRAS esperábamos la respuesta: la tx ya viajó al facilitator y puede
    // haber entrado perfectamente. Lo único que se perdió es la respuesta. Un boolean no tiene dónde
    // poner "no pude preguntar", así que lo escribía como "no pasó".
    // Los tres valores, y ninguno colapsa en otro:
    //   · "deposited":     el principal está en el vault. LedgerRefundGateway no puede sacarlo de ahí
    //     (ni ningún otro código de este repo): la salida es el refund trustless que firma el sender, o
    //     la release-authority a mano. Marca estable, sin PII (CD-17). Reconciliación → WKH-207.
    //   · "unknown":       no pudimos averiguarlo. Reusar el `reason` del gateway acá sería afirmar un
    //     fallo que nadie midió; y afirmarlo importa, porque de eso depende lo que se le dice a la
    //     persona sobre dónde está su plata.
    //   · "not_deposited": sabemos que no entró: el `reason` puntual es la verdad y se conserva.
    // Default "not_deposited" ⇒ vale sólo para los guards que cortan ANTES de que la tx salga; el
    // caller que ya broadcasteó tiene que pasar lo que la cadena le haya contestado.
    const effective =
      principal === "deposited"
        ? PRINCIPAL_SETTLED_REFUND_MANUAL
        : principal === "unknown"
          ? PRINCIPAL_STATE_UNKNOWN
          : reason;
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

  /** El settle no nos dio un sí, pero el depósito YA pudo haber entrado. Antes de escribir nada se le
   *  pregunta a la cadena: es la única que sabe, y es la única fuente que no se puede reemplazar por
   *  otra mejor (a diferencia de cualquier agente). Con la respuesta, `failAndRefund` elige entre los
   *  tres casos, y en dos de ellos la remesa queda en payout_failed, o sea RECUPERABLE: el sender
   *  puede firmar el refund trustless del escrow desde la propia pantalla. */
  private async failAfterBroadcast(
    r: Remittance,
    reason: string,
    remittanceId: string,
    sender: string,
  ): Promise<void> {
    await this.failAndRefund(r, reason, await this.probePrincipal(remittanceId, sender));
  }

  /** Le pregunta a la cadena si el principal está en el vault. Todo lo que no sea una respuesta clara
   *  es "unknown": si el probe se cae, no sabemos, y eso es exactamente lo que hay que decir, no un
   *  "no entró" de consuelo. Sin `solana` inyectado no hay a quién preguntarle (y no hubo broadcast). */
  private async probePrincipal(
    remittanceId: string,
    sender: string,
  ): Promise<PrincipalDepositState> {
    if (!this.solana) return "unknown";
    try {
      return await this.solana.probe.probeDeposit({ remittanceId, sender });
    } catch {
      return "unknown";
    }
  }

  /** Le pregunta a la cadena cuánto SOL tiene el sender. Cualquier tropiezo (RPC caído, timeout,
   *  respuesta ilegible) es "unknown": no pudimos preguntar. Sin `solana` inyectado no hay a quién
   *  preguntarle, y tampoco hay depósito que armar. */
  private async probeSenderSol(sender: string): Promise<SolanaSenderSolBalance> {
    if (!this.solana) return { status: "unknown" };
    try {
      return await this.solana.senderBalance.probeSenderSolBalance({ sender });
    } catch {
      return { status: "unknown" };
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
    // ⚠️ SIN DIRECCIÓN NO SE LLAMA A LA AUTORIDAD. Acá salía `address ?? ""` derecho al gateway, y ese
    // `""` no llegaba a ningún lado bueno: la autoridad lo canonicaliza, revienta, y el fallo vuelve
    // como 502 `kyc_reauth_failed`. Una causa local se presentaba como una caída del proveedor de
    // identidad. Este guard no debilita nada aguas abajo — el ownership check de `authority.ts`:130
    // sigue siendo fail-closed y sigue rechazando lo que rechazaba; lo único que cambia es que un
    // caso que ese guard nunca debió tener que atender ya no llega hasta él.
    if (address == null || address.trim() === "") {
      await this.failAndRefund(r, WALLET_ADDRESS_UNAVAILABLE);
      return r; // NO se consulta la autoridad, NO se prepara el payout, NO se firma nada
    }
    const auth = await this.authority.authorize({
      verificationId: kyc.verificationId,
      address,
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
      await this.failAndRefund(r, "settlement_unavailable", "not_deposited");
      return r;
    }
    // GUARD DE RENT — ¿le alcanza el SOL al remitente para las cuentas que crea el depósito? El fee lo paga
    //     el facilitator, el RENT de `escrow_state` + vault + `escrow_index` NO: sale de la billetera
    //     de quien envía (`payer = sender`). Ver `solana-escrow-rent.ts` para el número y su
    //     derivación, y `SOLANA_SENDER_SOL_INSUFFICIENT` para qué se veía antes en la pantalla.
    //
    //     ⚠️ CORRE ACÁ, ANTES DEL PREPARE, y eso importa: prepare crea una orden de payout real
    //     server-side. Cortar después dejaría una orden huérfana por una causa que ya sabíamos.
    //
    //     ⚠️ "NO PUDE PREGUNTAR" DEJA SEGUIR, Y ES DELIBERADO. Este guard NO custodia dinero: el que
    //     custodia es el runtime de Solana, que rechaza la transacción si el rent no alcanza, y sigue
    //     ahí con este chequeo caído. Lo único que aporta es un diagnóstico temprano y barato. Por eso
    //     su modo de fallo tiene que ser el que menos daño hace: con un RPC caído, bloquear convertiría
    //     una caída de infraestructura en "no tenés saldo" y dejaría a TODO el mundo sin poder enviar
    //     (incluida la demo), acusando a billeteras que están perfectas. Dejar seguir, en cambio,
    //     devuelve exactamente el comportamiento de hoy: se intenta y la cadena decide. El costo de
    //     equivocarse por este lado es un mal diagnóstico ocasional; por el otro, es la caída total del
    //     producto ante un RPC lento.
    //
    //     Fail-open acá NO contradice el fail-closed del resto del money-path: los otros guards son los
    //     únicos que impiden mover valor sin autorizar, éste no impide nada que la cadena no impida ya.
    const senderSol = await this.probeSenderSol(address);
    if (senderSol.status === "known" && senderSol.lamports < SENDER_MIN_LAMPORTS_FOR_DEPOSIT) {
      await this.failAndRefund(r, SOLANA_SENDER_SOL_INSUFFICIENT, "not_deposited");
      return r; // NO se prepara el payout, NO se le pide una sola firma a la wallet
    }
    // 1. PREPARE server-side (análogo a 2.7): resuelve beneficiary+authority SERVER-SIDE (NUNCA del
    //    body; AC-1/CD-7). Fallo ⇒ falla ANTES de firmar: la tx nunca salió, el deposit NO entró.
    let prep: Awaited<ReturnType<SolanaPayoutPrepareGateway["prepare"]>>;
    try {
      prep = await this.solana.prepare.prepare({
        remittanceId: s.id,
        quoteId: quote.quoteId,
        kycVerificationId: kyc.verificationId,
        address, // ya garantizado no vacío por el guard de arriba (era `address ?? ""`)
        amountUsd: s.sendUsd.major,
        beneficiary: s.beneficiary,
        idempotencyKey: `${s.id}:${quote.quoteId}`,
      });
    } catch {
      await this.failAndRefund(r, "prepare_unavailable", "not_deposited");
      return r;
    }
    if (!prep.ok) {
      await this.failAndRefund(r, prep.reason, "not_deposited");
      return r;
    }
    // 2. authorizePrincipal: la wallet arma+partial-firma la ix `deposit` del escrow con el
    //    beneficiary+authority resueltos server-side (HU-SOL-5 ya arma el deposit desde el 3er arg).
    const { solana } = await this.wallet.authorizePrincipal(quote, s.id, {
      address: prep.result.beneficiary,
      escrow: { beneficiary: prep.result.beneficiary, authority: prep.result.authority },
    });
    // Sin el envelope Solana no hay tx que broadcastear ⇒ fail-closed, NUNCA markPrincipalIn (la
    // mentira que la HU vino a matar). Nunca hubo broadcast ⇒ el deposit NO entró, y eso sí lo sabemos.
    if (!solana) {
      await this.failAndRefund(r, "settlement_unverified", "not_deposited");
      return r;
    }
    // 3. BROADCAST del deposit vía el facilitator (/api/settle/solana-sponsor → /solana/sponsor). El
    //    facilitator pone la COMISIÓN DE RED, y sólo eso: acá decía "gasless" a secas, y el ALQUILER
    //    (rent) de las cuentas que crea el deposit sale de la billetera del remitente (`payer =
    //    sender`). Por eso hay un guard de rent más arriba: la palabra que estaba acá era justamente
    //    la que hacía pensar que ese guard no hacía falta.
    //
    //    ⚠️ DESDE ACÁ LA TX YA SALIÓ DE NUESTRAS MANOS. Lo que decía este comentario era: "el deposit no
    //    se confirmó, o no podemos saberlo: fail-closed igual". Las dos mitades no son lo mismo y
    //    tratarlas igual costaba caro: fail-closed está bien para NO avanzar la remesa, pero no autoriza
    //    a AFIRMAR que la plata no se movió. Sobre esa afirmación se escribía un reembolso inexistente.
    //
    //    Una excepción acá (o un timeout de 15 s, que el gateway ya convierte en `solana_settle_unavailable`)
    //    incluye el caso en que se cortó la red mientras esperábamos: el facilitator pudo haber
    //    broadcasteado y confirmado el depósito. Lo único que perdimos es la respuesta. Por eso se le
    //    pregunta a la CADENA, que es la fuente autoritativa, y no a ningún agente.
    let res: Awaited<ReturnType<SolanaSettlementGateway["settle"]>>;
    try {
      res = await this.solana.gateway.settle({
        partialSignedTx: solana.partialSignedTx,
        reference: solana.reference,
        sender: address,
        remittanceId: s.id,
        popSignature: solana.popSignature,
      });
    } catch {
      await this.failAfterBroadcast(r, "solana_settle_unavailable", s.id, address);
      return r;
    }
    if (!res.ok) {
      // Sólo los reasons que prueban un corte ANTERIOR al broadcast pueden afirmar "no entró". El
      // resto va a la cadena: un `reason` no es evidencia de dónde está la plata.
      if (SETTLE_REASONS_BEFORE_BROADCAST.includes(res.reason)) {
        await this.failAndRefund(r, res.reason, "not_deposited");
        return r;
      }
      await this.failAfterBroadcast(r, res.reason, s.id, address);
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
    // `prep.result.agent` = QUIÉN dio el beneficiary que se acaba de depositar. Se guarda con la
    // remesa (sobrevive a la recarga, se puede mostrar en el recibo) porque sin eso una remesa no
    // puede decir de dónde salió la dirección contra la que la persona firmó. Es traza, no lógica:
    // nada de este flujo lo lee para decidir, y `undefined` no pisa lo que ya hubiera.
    r.markPayoutSubmitted(
      prep.result.payoutId,
      this.clock.nowIso(),
      prep.result.provenance,
      prep.result.agent,
    );
    await this.repo.save(r);
    return r;
  }
}
