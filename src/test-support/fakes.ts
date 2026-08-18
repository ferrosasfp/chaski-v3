// Test doubles — implementaciones fake de los ports (para probar use-cases sin infra real).
import bs58 from "bs58";
import { Money } from "../domain/money";
import {
  type KycVerification,
  type PayoutMethod,
  type Quote,
  Remittance,
  type RemittanceState,
  toPersistedIdentity,
} from "../domain/remittance";
import { ConcurrentModificationError } from "../application/errors";
import { canonicalizeAddress, isOwnedBy } from "../infrastructure/address"; // WKH-348: importado
// WKH-337: la allowlist de proveniencias REALES se IMPORTA (no se copia). El docblock de la constante
// dice por qué: "un segundo Set con los mismos valores es exactamente cómo se desincronizan las dos
// capas". Precedente de import fuera de `presentation/`: `scripts/smoke-helpers.ts`.
import { REAL_PAYOUT_PROVENANCES } from "../domain/payout-provenance"; import type { PreparacionPorEnlace } from "../infrastructure/solana/preparacion-por-enlace"; import type { BilleteraDeeplink } from "../infrastructure/solana/deeplink/protocol"; // WKH-358: los dos EN ESTA LÍNEA, misma disciplina que el resto del bloque. CR/MNR-4: capas
import type {
  Clock,
  EscrowRefundConfirmation,
  IdGenerator,
  KycDecision,
  KycGateway,
  KycPending,
  KycPendingStore,
  KycRequest,
  KycStartResult,
  KycStore,
  PayoutAuthorityGateway,
  PayoutAuthorization,
  PayoutGateway,
  PayoutOutcomeLookup,
  PayoutRecord,
  PayoutSubmit,
  PopSigner,
  PrincipalDepositState,
  QuoteGateway,
  QuoteRequest,
  RefundGateway,
  RemittanceRepository,
  SenderRemittanceRef,
  SettlementLedger,
  SettlementLedgerStatus,
  SettlementRecord,
  SolanaEscrowDepositProbe,
  SolanaEscrowRefundGateway,
  SolanaEscrowCloseGateway,
  SolanaEscrowCloseResult,
  SolanaCloseableEscrowLister, EscrowChainState, SolanaEscrowChainStateReader, AutorizacionDelPrincipal, // WKH-349: EN ESTA LÍNEA, no en dos nuevas. `fakes.ts:835` (FAKE_SOLANA_SIGNATURE) lo citan CINCO archivos por número (`chain.ts`, `desenlaces.ts`, `flow.test.tsx`, `lost-escrow-recovery.test.tsx`, `tx-proof.test.tsx`) y el destino está DEBAJO de acá: dos líneas de más los rotan en silencio. WKH-356 suma `AutorizacionDelPrincipal` por lo mismo. ⚠️ Acá decía CUATRO, y el quinto lo agregó el mismo commit que editó esta línea (MNR-CR-5): el número se deriva con `grep -rln 'fakes\.ts:835' src app` menos este archivo, no se recuerda
  ConnectedWalletProbe,
  CloseableEscrow,
  SolanaEscrowRefundResult,
  SolanaPayoutPrepareGateway,
  SolanaPrincipalAuthorization,
  SolanaSenderSolBalance,
  SolanaSenderSolBalanceProbe,
  PruebaDePosesionPorEnlace,
  PruebaPorEnlace,
  WalletPossessionProof,
  SolanaSettlementFailureReason,
  SolanaPrincipalInOutcome,
  SolanaSettlementGateway,
  WalletPort,
  WebhookFailureClass,
  WebhookOutcome,
} from "../application/ports";
import { WEBHOOK_FAILURE_CLASSES } from "../infrastructure/persistence/webhook-failure-classes";

export const T0 = "2026-07-09T18:00:00.000Z";
export const QUOTE_EXPIRES = "2026-07-09T18:10:00.000Z"; // T0 + 10 min

export class FixedClock implements Clock {
  constructor(private t: string = T0) {}
  set(iso: string): void {
    this.t = iso;
  }
  nowIso(): string {
    return this.t;
  }
}

// Reloj con secuencia programada (AC-5): FixedClock devuelve el mismo `now` siempre → no puede
// simular "válido en confirm, vencido en re-check". Clampa al último valor (CD-6: index → T|undefined).
export class ScriptedClock implements Clock {
  private i = 0;
  constructor(private readonly seq: string[]) {}
  nowIso(): string {
    const v = this.seq[Math.min(this.i, this.seq.length - 1)];
    this.i++;
    return v ?? "";
  }
}

export class SeqIds implements IdGenerator {
  private n = 0;
  newId(): string {
    return `rem-${++this.n}`;
  }
}

export class InMemoryRepo implements RemittanceRepository {
  private store = new Map<string, RemittanceState>();
  async save(r: Remittance): Promise<void> {
    // CAS gemelo del LocalRepo (AC-3/AC-4, CD-4). El Map ES el store → write es el set directo.
    const existing = this.store.get(r.snapshot.id);
    if (existing && existing.version !== r.snapshot.version) {
      throw new ConcurrentModificationError(r.snapshot.id, r.snapshot.version, existing.version);
    }
    const next = r.snapshot.version + 1;
    this.store.set(r.snapshot.id, { ...r.snapshot, version: next });
    r.markSaved(next);
  }
  async get(id: string): Promise<Remittance | null> {
    const s = this.store.get(id);
    return s ? Remittance.rehydrate(s) : null;
  }
  // WKH-348/AC-6/CD-5: el predicado de ownership NO se copia acá, se IMPORTA. Este doble tenía el
  // filtro escrito a mano y con el mismo defecto que LocalRepo: canonicalizaba el ownerAddress de cada
  // entrada DENTRO del predicado de un .filter(), así que una entrada que no se puede atribuir hacía
  // tirar al propio doble ⇒ ningún test de la capa de aplicación podía sembrar veneno. Es el mismo
  // criterio que este archivo ya aplica a REAL_PAYOUT_PROVENANCES (ver el import de arriba): un
  // segundo texto con el mismo criterio es exactamente cómo se desincronizan las dos capas. El
  // contrato de remittance-owner-scope.contract.test.ts se pone rojo si una de las dos vuelve a irse.
  async list(address: string): Promise<RemittanceState[]> {
    const target = canonicalizeAddress(address); // el target sigue fail-closed (AC-3)
    return [...this.store.values()].filter((s) => isOwnedBy(s, target));
  }
  async clearByOwner(address: string): Promise<void> {
    // Gemelo del de list() porque es EL MISMO predicado (WKH-201/CD-5). this.store ES el store →
    // delete directo. CD-18: la entrada que no se puede atribuir NO se borra, porque borrar lo que no
    // se puede atribuir es atribuirlo a quien pidió el reset.
    const target = canonicalizeAddress(address);
    for (const [id, s] of this.store) {
      if (isOwnedBy(s, target)) this.store.delete(id);
    }
  }
}

// Doble que SIEMPRE falla en clearByOwner (simula localStorage roto) para el test defensivo de
// WKH-201/AC-4: ForgetKyc debe resolver igual y correr las otras limpiezas (CD-2/CD-7). save/get/list
// mínimos operativos (molde de ThrowingClearKycStore, invirtiendo cuál método lanza).
export class ThrowingClearByOwnerRepo implements RemittanceRepository {
  async save(_r: Remittance): Promise<void> {}
  async get(_id: string): Promise<Remittance | null> {
    return null;
  }
  async list(_address: string): Promise<RemittanceState[]> {
    return [];
  }
  async clearByOwner(_address: string): Promise<void> {
    throw new Error("remittance_repo_unavailable");
  }
}

export class FakeQuoteGateway implements QuoteGateway {
  constructor(private expiresAt: string = QUOTE_EXPIRES) {}
  async requestQuote(req: QuoteRequest): Promise<Quote> {
    const rate = 3.7;
    const net = Math.max(0, req.amountUsd - 0.5) * rate;
    return {
      quoteId: `q-${req.amountUsd}`,
      send: Money.of(req.amountUsd, "USDC"),
      receive: Money.of(Number(net.toFixed(2)), "PEN"),
      feeUsd: Money.of(0.5, "USDC"),
      rate,
      etaMinutes: 30,
      expiresAt: this.expiresAt,
      provenance: "fake",
    };
  }
}

export class FakeKycGateway implements KycGateway {
  // redirect=true → start() pide redirect (para probar el flujo Didit/resume).
  constructor(
    private overrides: Partial<KycVerification> = {},
    private redirect = false,
  ) {}
  private v(): KycVerification {
    return {
      verificationId: "v-1",
      approved: true,
      payoutAllowed: true,
      riskLevel: "low",
      provenance: "fake",
      identity: toPersistedIdentity({
        firstName: "Test",
        lastNamePaternal: "Quispe",
        lastNameMaternal: "Mamani",
        documentType: "DNI",
        documentNumber: "12345678",
        dateOfBirth: "1990-01-01",
        nationality: "PE",
      }),
      ...this.overrides,
    };
  }
  async start(_req: KycRequest): Promise<KycStartResult> {
    return this.redirect
      ? { kind: "redirect", url: "https://verify.didit.me/session/fake", sessionId: "sess-fake" }
      : { kind: "completed", verification: this.v() };
  }
  async decision(_sessionId: string): Promise<KycDecision> {
    return { terminal: true, verification: this.v() };
  }
}

export class FakeKycPendingStore implements KycPendingStore {
  private p: KycPending | null = null;
  async save(p: KycPending): Promise<void> {
    this.p = p;
  }
  async get(): Promise<KycPending | null> {
    return this.p;
  }
  async clear(): Promise<void> {
    this.p = null;
  }
}

// Doble que SIEMPRE falla en save() (simula localStorage lleno / private-browsing) para el
// test estrella de V1 (WKH-183): re-lanza el mismo Error que LocalKycPendingStore.
export class ThrowingKycPendingStore implements KycPendingStore {
  private p: KycPending | null = null;
  async save(_p: KycPending): Promise<void> {
    throw new Error("kyc_pending_unavailable");
  }
  async get(): Promise<KycPending | null> {
    return this.p;
  }
  async clear(): Promise<void> {
    this.p = null;
  }
}

// Doble que SIEMPRE falla en clear() (simula localStorage roto) para el test defensivo de WKH-184:
// ForgetKyc debe resolver igual aunque pending.clear() re-lance (CD-8). save/get funcionan normal.
export class ThrowingClearKycPendingStore implements KycPendingStore {
  private p: KycPending | null = null;
  async save(p: KycPending): Promise<void> {
    this.p = p;
  }
  async get(): Promise<KycPending | null> {
    return this.p;
  }
  async clear(): Promise<void> {
    throw new Error("kyc_pending_unavailable");
  }
}

export class FakePayoutGateway implements PayoutGateway {
  constructor(
    private submitResult: Partial<PayoutRecord> = {},
    private statusResult: Partial<PayoutRecord> = {},
  ) {}
  async submit(_req: PayoutSubmit): Promise<PayoutRecord> {
    return {
      payoutId: "p-1",
      status: "submitted",
      deliveredPen: null,
      txRef: null,
      failureReason: null,
      provenance: "fake", // WKH-200/CD-7: default sin alterar deliveredPen
      ...this.submitResult,
    };
  }
  async status(payoutId: string): Promise<PayoutRecord> {
    return {
      payoutId,
      // deliveredPen CONSISTENTE con el receive del FakeQuoteGateway canónico (400 USDC → ~1478.15
      // PEN): tras la reconciliación de WKH-186 (AC-6) un delivered fuera de tolerancia refundea en
      // vez de settlear. El happy-path por default debe caer DENTRO de tolerancia → settled.
      status: "settled",
      deliveredPen: Money.of(1478.15, "PEN"),
      txRef: "0xdelivered",
      failureReason: null,
      provenance: "fake", // WKH-200/CD-7: default sin alterar deliveredPen
      ...this.statusResult,
    };
  }
}

// FakeWallet — wallet mínima que devuelve { tx } y nada más. Para el camino real Solana está
// FakeSolanaWallet, más abajo.
export const FAKE_WALLET_ADDRESS = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // base58 válida

export class FakeWallet implements WalletPort {
  async connect(): Promise<string> {
    return FAKE_WALLET_ADDRESS;
  }
  async getAddress(): Promise<string | null> {
    return FAKE_WALLET_ADDRESS;
  }
  async authorizePrincipal(
    _quote: Quote,
    _remittanceId?: string,
    _deposit?: { address: string }, // WKH-211: 3er arg (to = depositAddress). El fake lo ignora; los
    // tests spyean authorizePrincipal para inspeccionar que recibió el depositAddress de prepare.
  ): Promise<AutorizacionDelPrincipal> {
    return { estado: "listo", tx: "fake-principal" }; // WKH-356: el envoltorio, mismo dato de siempre
  }
  // WKH-206: firma fake (no toca red).
  async signMessage(_message: string): Promise<string> {
    return "fakesig";
  }
}

// WKH-206: PopSigner fake — devuelve un { challenge, signature } sintético para probar que el
// use-case adjunta la prueba al submit cuando el modo PoP está inyectado (AC-3).
export class FakePopSigner implements PopSigner {
  async prove(_address: string): Promise<{ challenge: string; signature: string } | null> {
    return { challenge: "pop-ch", signature: "0xfakesig" };
  }
}

export class FakeKycStore implements KycStore {
  private m = new Map<string, KycVerification>();
  private saved = new Map<string, number>();
  async get(address: string): Promise<KycVerification | null> {
    return this.m.get(canonicalizeAddress(address)) ?? null;
  }
  async save(address: string, kyc: KycVerification): Promise<void> {
    this.m.set(canonicalizeAddress(address), kyc);
    this.saved.set(canonicalizeAddress(address), Date.now());
  }
  async clear(address: string): Promise<void> {
    this.m.delete(canonicalizeAddress(address));
    this.saved.delete(canonicalizeAddress(address));
  }
  // WKH-333/AC-8. Este doble NO aplica TTL en `get()` (nunca lo aplicó), así que acá no puede
  // reproducir la diferencia get/peek: ésa se mide contra LocalKycStore (T-STORE-1/2). Lo que sí
  // aporta es la PISTA que el backfill consume.
  async peek(address: string): Promise<{ verification: KycVerification; savedAt: number } | null> {
    const v = this.m.get(canonicalizeAddress(address));
    if (!v) return null;
    return { verification: v, savedAt: this.saved.get(canonicalizeAddress(address)) ?? 0 };
  }
}

// Doble que SIEMPRE falla en save() (simula localStorage lleno / private-browsing) para el test
// de WKH-199: ResumeKyc/StartKyc deben persistir kyc_passed pese al fallo del cache. get/clear
// funcionan in-memory (paralela a ThrowingClearKycStore, invirtiendo cuál método lanza).
export class ThrowingSaveKycStore implements KycStore {
  private m = new Map<string, KycVerification>();
  async get(address: string): Promise<KycVerification | null> {
    return this.m.get(canonicalizeAddress(address)) ?? null;
  }
  async save(_address: string, _kyc: KycVerification): Promise<void> {
    throw new Error("kyc_store_unavailable");
  }
  async clear(address: string): Promise<void> {
    this.m.delete(canonicalizeAddress(address));
  }
  async peek(address: string): Promise<{ verification: KycVerification; savedAt: number } | null> {
    const v = this.m.get(canonicalizeAddress(address));
    return v ? { verification: v, savedAt: 0 } : null;
  }
}

// Doble que SIEMPRE falla en clear() (simula localStorage roto) para el test defensivo de WKH-184:
// ForgetKyc debe resolver igual y correr pending.clear() (AC-5/CD-8). get/save funcionan normal.
export class ThrowingClearKycStore implements KycStore {
  private m = new Map<string, KycVerification>();
  async get(address: string): Promise<KycVerification | null> {
    return this.m.get(canonicalizeAddress(address)) ?? null;
  }
  async save(address: string, kyc: KycVerification): Promise<void> {
    this.m.set(canonicalizeAddress(address), kyc);
  }
  async clear(_address: string): Promise<void> {
    throw new Error("kyc_store_unavailable");
  }
  async peek(address: string): Promise<{ verification: KycVerification; savedAt: number } | null> {
    const v = this.m.get(canonicalizeAddress(address));
    return v ? { verification: v, savedAt: 0 } : null;
  }
}

// Autoridad de payout fake (WKH-180). Por default authorized:true (regresión demo); pasá
// { authorized:false, reason } para probar el enforcement. Registra los inputs recibidos.
export class FakePayoutAuthorityGateway implements PayoutAuthorityGateway {
  public calls: Array<{ verificationId: string; address: string }> = [];
  constructor(private result: PayoutAuthorization = { authorized: true }) {}
  async authorize(input: { verificationId: string; address: string }): Promise<PayoutAuthorization> {
    this.calls.push(input);
    return this.result;
  }
}

// Refund fake (WKH-186). Tres modos, uno por cada cosa que puede pasar de verdad:
//   · "resolve":    devolvió un comprobante REAL ("refund-fake"): alguien revirtió plata. Es el único
//     caso que autoriza a escribir `refunded`.
//   · "no-receipt": devolvió null: el adapter NO revirtió nada (es lo que hace el LedgerRefundGateway
//     que corre en producción). Sin este modo, los tests sólo ejercitaban un adapter que no existe.
//   · "reject":     lanzó: ejercita el best-effort de failAndRefund (queda en payout_failed).
// Registra los inputs recibidos (molde de FakePayoutAuthorityGateway).
export class FakeRefundGateway implements RefundGateway {
  public calls: Array<{ remittanceId: string; amountUsd: Money; reason: string }> = [];
  constructor(private mode: "resolve" | "reject" | "no-receipt" = "resolve") {}
  async creditBack(input: {
    remittanceId: string;
    amountUsd: Money;
    reason: string;
  }): Promise<{ refundTx: string | null }> {
    this.calls.push(input);
    if (this.mode === "reject") throw new Error("refund_unavailable");
    if (this.mode === "no-receipt") return { refundTx: null };
    return { refundTx: "refund-fake" };
  }
}

// Ledger de settlements fake (WKH-207). In-memory (molde de InMemoryRepo). recordPayoutOutcome muta
// owner-scoped por (idempotencyKey, senderAddress); listStale filtra no-terminales < olderThanIso;
// markOutcome muta por id.
//
// ⚠️ WKH-213 — POR QUÉ ESTE DOBLE MODELA LOS *DOS* ÍNDICES ÚNICOS DE LA TABLA.
// Hasta acá, recordPrincipalIn deduplicaba SÓLO por tx_hash. La tabla real tiene DOS índices únicos
// (migración 20260716:24-25): uq_remit_settle_txhash Y uq_remit_settle_idem. Modelar uno solo hacía
// que los tests "demostraran" un flujo IMPOSIBLE en producción: en la DB real el INSERT del settle
// chocaba contra la fila 'prepared' por idempotency_key (23505) y el error se perdía en el
// best-effort de la route, así que NINGUNA fila llegaba nunca a 'principal_in' — mientras el doble
// mostraba, feliz, dos filas. Un doble que no modela una restricción de la DB no prueba nada del
// money-path: prueba la fantasía que el doble implementa.
// REGLA: toda restricción de integridad que la DB aplica sobre esta tabla se modela ACÁ (assertUnique).
const STALE_STATUSES: readonly SettlementLedgerStatus[] = [
  "principal_in",
  "submitted",
  "forward_error",
];

/** Conjunto mutable por el webhook (R1) = la UNIÓN de los tres conjuntos de clasificación del ledger
 *  real (WKH-325). Se DERIVA de WEBHOOK_FAILURE_CLASSES en vez de re-declararse: si un conjunto del
 *  ledger cambia y el fake no, los tests dejan de decir la verdad sobre producción.
 *  ⚠️ STALE_STATUSES de arriba SIGUE siendo propio: lo usa listStale y es otro conjunto a propósito. */
const WEBHOOK_UPDATABLE_STATUSES: readonly SettlementLedgerStatus[] = WEBHOOK_FAILURE_CLASSES.flatMap(
  (s) => [...s.previousStatuses],
);

/** Mismo placeholder determinístico que escribe el ledger real en una fila 'prepared'. NO se importa
 *  la constante del ledger real a propósito: arrastraría @supabase/supabase-js y el cliente server-only
 *  adentro de los dobles, que existen para probar SIN infra. */
function preparedPlaceholderTxHash(idempotencyKey: string): string {
  return `prepared:${idempotencyKey}`;
}

export class FakeSettlementLedger implements SettlementLedger {
  public store = new Map<string, SettlementRecord>();
  private seq = 0;
  constructor(private nowIso: string = T0) {}

  /** Emula los DOS índices únicos de la tabla. `selfId` es la fila que se está actualizando (una fila
   *  no choca consigo misma). Tira con el MISMO texto que el ledger real ante un 23505, para que un
   *  test no pueda distinguir el doble de la DB por el mensaje. */
  private assertUnique(
    candidate: { txHash: string; idempotencyKey: string },
    failPrefix: string,
    selfId?: string,
  ): void {
    for (const [id, r] of this.store) {
      if (id === selfId) continue;
      if (r.txHash === candidate.txHash) throw new Error(`${failPrefix}:23505`); // uq_remit_settle_txhash
      if (r.idempotencyKey === candidate.idempotencyKey) throw new Error(`${failPrefix}:23505`); // uq_remit_settle_idem
    }
  }

  /** La fila de una idempotency_key (el índice único garantiza 0 ó 1). */
  private byIdempotencyKey(key: string): SettlementRecord | undefined {
    for (const r of this.store.values()) if (r.idempotencyKey === key) return r;
    return undefined;
  }

  async recordOrderPrepared(input: {
    remittanceId: string;
    quoteId: string;
    idempotencyKey: string;
    depositAddress: string;
    chainId: number;
    senderAddress: string;
    payoutId: string;
    payoutProvenance: string;
    vm: "evm" | "solana";
  }): Promise<void> {
    // WKH-211: registra la orden preparada. Upsert por idempotency_key (retry = una sola fila). El
    // depositAddress va en receiver_address (ES el receiver no-custodial). value_minor '0' (aún no se
    // conoce); tx_hash placeholder (no hubo settle). status 'prepared' — el settle la COMPLETA a
    // principal_in sobre ESTA MISMA fila (CD-6 reescrito, WKH-213).
    if (this.byIdempotencyKey(input.idempotencyKey)) return; // ON CONFLICT (idempotency_key) DO NOTHING
    const txHash = preparedPlaceholderTxHash(input.idempotencyKey);
    this.assertUnique({ txHash, idempotencyKey: input.idempotencyKey }, "ledger_record_order_prepared_failed");
    const id = `prep-${++this.seq}`;
    this.store.set(id, {
      id,
      remittanceId: input.remittanceId,
      quoteId: input.quoteId,
      idempotencyKey: input.idempotencyKey,
      txHash,
      chainId: input.chainId,
      senderAddress: canonicalizeAddress(input.senderAddress),
      receiverAddress: canonicalizeAddress(input.depositAddress),
      valueMinor: "0", // string, como la columna ::text (aún no se conoce el monto)
      status: "prepared",
      attempts: 0,
      payoutId: input.payoutId,
      // Espeja provenanceColumn() del ledger real: la cadena TAL CUAL, y vacío/whitespace ⇒ null
      // ("no consta"). Si el doble guardara `''` donde la DB guarda NULL, un test podría "probar" una
      // distinción que en producción no existe.
      payoutProvenance: input.payoutProvenance.trim() ? input.payoutProvenance : null,
      lastError: null,
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
    });
  }

  async recordPrincipalIn(input: {
    remittanceId: string;
    quoteId: string;
    idempotencyKey: string;
    txHash: string;
    chainId: number;
    senderAddress: string;
    receiverAddress: string;
    valueMinor: number;
    vm: "evm" | "solana";
  }): Promise<void> {
    // WKH-213/R2 — MISMO algoritmo de 4 pasos que SupabaseSettlementLedger.recordPrincipalIn (si uno
    // cambia y el otro no, los tests dejan de decir la verdad sobre producción):
    //   1. UPDATE owner-scoped de la fila 'prepared' → principal_in con la evidencia real.
    //   2. La fila ya avanzó (webhook primero) ⇒ se rellena SÓLO la evidencia sobre el placeholder,
    //      sin degradar el status.
    //   3. La fila existe con evidencia real / de otro owner ⇒ NO-OP (retry inocuo).
    //   4. No existe ⇒ INSERT.
    const owner = canonicalizeAddress(input.senderAddress);
    // Espeja al ledger real: la ESCRITURA recibe un number y lo persiste como texto
    // (`value_minor: String(input.valueMinor)`), y la LECTURA devuelve ese texto sin re-parsear.
    const valueMinor = String(input.valueMinor);
    const existing = this.byIdempotencyKey(input.idempotencyKey);

    if (existing && existing.senderAddress === owner && existing.status === "prepared") {
      // El índice de tx_hash SIGUE aplicando sobre un UPDATE (otra fila con ese hash ⇒ 23505).
      this.assertUnique(
        { txHash: input.txHash, idempotencyKey: input.idempotencyKey },
        "ledger_record_principal_in_failed",
        existing.id,
      );
      existing.remittanceId = input.remittanceId;
      existing.quoteId = input.quoteId;
      existing.txHash = input.txHash;
      existing.chainId = input.chainId;
      existing.senderAddress = owner;
      existing.receiverAddress = canonicalizeAddress(input.receiverAddress);
      existing.valueMinor = valueMinor;
      existing.status = "principal_in";
      existing.updatedAt = this.nowIso;
      // payoutId NO se toca: lo escribió prepare y un merge con null lo borraría.
      return;
    }
    if (
      existing &&
      existing.senderAddress === owner &&
      existing.txHash === preparedPlaceholderTxHash(input.idempotencyKey)
    ) {
      // Webhook llegó primero: status intacto (terminal), evidencia completada.
      this.assertUnique(
        { txHash: input.txHash, idempotencyKey: input.idempotencyKey },
        "ledger_record_principal_in_failed",
        existing.id,
      );
      existing.txHash = input.txHash;
      existing.valueMinor = valueMinor;
      existing.updatedAt = this.nowIso;
      return;
    }
    if (existing) return; // evidencia real ya escrita / otro owner ⇒ NO-OP

    this.assertUnique(
      { txHash: input.txHash, idempotencyKey: input.idempotencyKey },
      "ledger_record_principal_in_failed",
    );
    const id = `settle-${++this.seq}`;
    this.store.set(id, {
      id,
      remittanceId: input.remittanceId,
      quoteId: input.quoteId,
      idempotencyKey: input.idempotencyKey,
      txHash: input.txHash,
      chainId: input.chainId,
      senderAddress: owner,
      receiverAddress: canonicalizeAddress(input.receiverAddress),
      valueMinor,
      status: "principal_in",
      attempts: 0,
      payoutId: null,
      // Paso 4 (no hubo prepare): el settle NO conoce la proveniencia del desembolso — nadie se la
      // dijo. null = no consta, igual que en la DB (el INSERT del ledger real tampoco nombra la
      // columna). Fabricar un valor acá sería evidencia inventada.
      payoutProvenance: null,
      lastError: null,
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
    });
  }

  async recordSolanaPrincipalIn(input: {
    remittanceId: string;
    senderAddress: string;
    signature: string;
  }): Promise<SolanaPrincipalInOutcome> {
    // WKH-213/R3 + WKH-325 — espeja los CINCO pasos del ledger real, en el mismo orden. Antes había
    // un solo desenlace escrito y un NO-OP mudo; el mudo era indistinguible de un éxito.
    // Lo que este doble NO modela: las tres ALERTAS. Las emite el ledger real (logLedgerAlert) y los
    // tests que las cuentan corren contra el ledger real sobre la tabla en memoria, no contra este
    // doble — acá el desenlace tipado ES la señal, y asertarlo no pide espiar la consola.
    // El índice único de tx_hash sigue aplicando en las dos escrituras.
    const owner = canonicalizeAddress(input.senderAddress);
    const mine = (r: SettlementRecord): boolean =>
      r.remittanceId === input.remittanceId && r.senderAddress === owner;

    // P1/P2 — ascenso de la fila 'prepared' MÁS RECIENTE (CAS: sólo desde 'prepared').
    const prepared = [...this.store.values()]
      .filter((r) => mine(r) && r.status === "prepared")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
    if (prepared) {
      this.assertUnique(
        { txHash: input.signature, idempotencyKey: prepared.idempotencyKey },
        "ledger_record_solana_principal_in_failed",
        prepared.id,
      );
      prepared.txHash = input.signature;
      prepared.status = "principal_in";
      prepared.updatedAt = this.nowIso;
      return "ascended";
    }

    // P3 — evidencia ADITIVA sobre filas que ya salieron de 'prepared': se completa el tx_hash SÓLO
    //      si sigue siendo el placeholder del prepare, y el `status` NO se toca.
    const stale = [...this.store.values()].filter(
      (r) => mine(r) && r.status !== "prepared" && r.txHash.startsWith("prepared:"),
    );
    if (stale.length > 0) {
      for (const r of stale) {
        this.assertUnique(
          { txHash: input.signature, idempotencyKey: r.idempotencyKey },
          "ledger_record_solana_principal_in_failed",
          r.id,
        );
        r.txHash = input.signature;
        r.updatedAt = this.nowIso;
      }
      return "evidence_filled";
    }

    // P4 — ¿NUESTRA firma ya está persistida? Retry benigno ⇒ NO-OP sin señal de alarma.
    if ([...this.store.values()].some((r) => mine(r) && r.txHash === input.signature)) {
      return "already_recorded";
    }
    // P5 — hay fila con evidencia de OTRA cosa, o no hay fila en absoluto.
    if ([...this.store.values()].some(mine)) return "unrecorded_conflict";
    return "unrecorded_no_row";
  }

  async recordPayoutOutcome(input: {
    idempotencyKey: string;
    senderAddress: string;
    status: SettlementLedgerStatus;
    payoutId?: string | null;
    error?: string | null;
    vm: "evm" | "solana";
  }): Promise<void> {
    const owner = canonicalizeAddress(input.senderAddress);
    for (const r of this.store.values()) {
      // CD-9: owner-scoped — otro sender NO puede mutar esta fila.
      if (r.idempotencyKey === input.idempotencyKey && r.senderAddress === owner) {
        r.status = input.status;
        if (input.payoutId !== undefined) r.payoutId = input.payoutId;
        if (input.error !== undefined) r.lastError = input.error;
        r.updatedAt = this.nowIso;
      }
    }
  }

  async listStale(input: { olderThanIso: string; limit: number }): Promise<SettlementRecord[]> {
    return [...this.store.values()]
      .filter((r) => STALE_STATUSES.includes(r.status) && r.updatedAt < input.olderThanIso)
      .slice(0, input.limit)
      .map((r) => ({ ...r }));
  }

  async listPreparedOrphans(input: {
    olderThanIso: string;
    limit: number;
  }): Promise<{ total: number; records: SettlementRecord[] }> {
    // WKH-213: 'prepared' más viejas que el umbral, por created_at (updated_at NO envejece en una fila
    // que nadie vuelve a tocar). `total` es el conteo EXACTO de coincidencias, NO el de la página.
    const matches = [...this.store.values()]
      .filter((r) => r.status === "prepared" && r.createdAt < input.olderThanIso)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return {
      total: matches.length,
      records: matches.slice(0, input.limit).map((r) => ({ ...r })),
    };
  }

  // HU-SOL-20/AC-2: lectura owner-scoped por sender_address canonicalizado, created_at desc, sin
  // filtro por `vm` (las filas pre-fix dicen 'evm' aunque sean Solana: son las que hay que recuperar)
  // ni por status (las filas que interesan son 'prepared').
  async listRemittanceIdsBySender(input: {
    senderAddress: string;
    vm: "evm" | "solana";
    limit: number;
  }): Promise<SenderRemittanceRef[]> {
    const owner = canonicalizeAddress(input.senderAddress);
    return [...this.store.values()]
      .filter((r) => r.senderAddress === owner)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, input.limit)
      .map((r) => ({ remittanceId: r.remittanceId, status: r.status, createdAt: r.createdAt }));
  }

  /** MISMO criterio que SupabaseSettlementLedger.listPreparedDepositAddresses: owner-scoped por
   *  sender_address, SIN filtro de status (un settle reintentado ve su fila ya en 'principal_in').
   *  El caso "no se pudo leer" no se emula acá: se prueba con un spy que rechaza, que es lo que hace
   *  la DB real, y así el test no puede confundirlo con la lista vacía. */
  async listPreparedDepositAddresses(input: {
    remittanceId: string;
    senderAddress: string;
  }): Promise<string[]> {
    const owner = canonicalizeAddress(input.senderAddress);
    return [...this.store.values()]
      .filter((r) => r.remittanceId === input.remittanceId && r.senderAddress === owner)
      .map((r) => r.receiverAddress)
      .filter((a) => typeof a === "string" && a.length > 0);
  }

  /** WKH-337 — MISMA clasificación que SupabaseSettlementLedger.lookupPayoutOutcome, en el mismo
   *  orden, y owner-scoped por sender_address (el `.eq(...)` es el único guard: el service key
   *  bypassea RLS). El doble FILTRA DE VERDAD a propósito: con un `mockResolvedValue` los tests de
   *  aislamiento pasarían igual con el guard borrado, o sea aprobarían desde arriba sin mirar los
   *  argumentos.
   *
   *  La membresía es POSITIVA (`REAL_PAYOUT_PROVENANCES.has(p ?? "")`) y la constante se IMPORTA de
   *  `flow-vm.ts`: un segundo Set con los mismos valores es exactamente cómo se desincronizan las dos
   *  capas. ⛔ PROHIBIDO `!isPayoutDemo(p)`: `isPayoutDemo(null)` es `false`, así que su negación
   *  leería `null` (= NO CONSTA) como REAL, que es el inverso exacto del criterio.
   *
   *  El caso "no se pudo leer" NO se emula acá (igual que en listPreparedDepositAddresses): se prueba
   *  con un spy que rechaza, que es lo que hace la DB real, y así el test no puede confundirlo con
   *  ninguno de los cuatro `unknown`. */
  async lookupPayoutOutcome(input: {
    payoutId: string;
    senderAddress: string;
  }): Promise<PayoutOutcomeLookup> {
    const owner = canonicalizeAddress(input.senderAddress);
    const rows = [...this.store.values()].filter(
      (r) => r.payoutId === input.payoutId && r.senderAddress === owner,
    );
    if (rows.length === 0) return { outcome: "unknown", reason: "no_row" };
    // MISMA forma que el ledger real (un solo recorrido, sin índices): si las dos divergieran, el doble
    // dejaría de ser un espejo y los tests aprobarían un comportamiento que producción no tiene.
    let hayTerminal = false;
    let desenlace: "settled" | "failed" | null = null;
    let provenance = "";
    let discordan = false;
    for (const r of rows) {
      const st = r.status === "settled" ? "settled" : r.status === "failed" ? "failed" : null;
      if (st === null) continue;
      hayTerminal = true;
      const p = r.payoutProvenance ?? "";
      if (!REAL_PAYOUT_PROVENANCES.has(p)) continue;
      if (desenlace !== null && desenlace !== st) discordan = true;
      desenlace = st;
      provenance = p;
    }
    if (desenlace === null) {
      // Las DOS causas se distinguen: hay terminal pero sin proveniencia real, vs. nada terminal.
      return { outcome: "unknown", reason: hayTerminal ? "provenance_not_real" : "not_terminal" };
    }
    if (discordan) return { outcome: "unknown", reason: "conflicting_rows" };
    return { outcome: "known", status: desenlace, provenance };
  }

  async markOutcome(input: {
    id: string;
    status: SettlementLedgerStatus;
    payoutId?: string | null;
    error?: string | null;
    incrementAttempt: boolean;
  }): Promise<void> {
    const r = this.store.get(input.id);
    if (!r) return;
    r.status = input.status;
    if (input.payoutId !== undefined) r.payoutId = input.payoutId;
    if (input.error !== undefined) r.lastError = input.error;
    if (input.incrementAttempt) r.attempts += 1;
    r.updatedAt = this.nowIso;
  }

  async recordWebhookOutcome(input: {
    payoutId: string;
    status: SettlementLedgerStatus;
  }): Promise<WebhookOutcome> {
    // NO owner-scoped (CD-12): correlaciona solo por payoutId. Filtro no-terminal = DT-2b: nunca
    // degrada un estado terminal ni reclasifica manual_review. WKH-213/R1: el conjunto incluye
    // 'prepared' (el proveedor puede avisar antes de que el settle aterrice, o sin que aterrice).
    //
    // WKH-325 — la rama NO-failed es la de siempre (patch {status, updated_at}, sin last_error). La
    // rama 'failed' clasifica CADA fila por SU estado previo, igual que los tres UPDATEs disjuntos del
    // ledger real, y ACUMULA las clases: dos filas del mismo payoutId en estados previos distintos
    // producen dos last_error distintos y dos clases.
    if (input.status !== "failed") {
      for (const r of this.store.values()) {
        if (r.payoutId === input.payoutId && WEBHOOK_UPDATABLE_STATUSES.includes(r.status)) {
          r.status = input.status;
          r.updatedAt = this.nowIso;
        }
      }
      return { classified: false };
    }
    const failures: WebhookFailureClass[] = [];
    for (const spec of WEBHOOK_FAILURE_CLASSES) {
      let matched = false;
      for (const r of this.store.values()) {
        if (r.payoutId === input.payoutId && spec.previousStatuses.includes(r.status)) {
          r.status = "failed";
          r.lastError = spec.lastError;
          r.updatedAt = this.nowIso;
          matched = true;
        }
      }
      if (matched) failures.push(spec.failureClass);
    }
    return { classified: true, failures };
  }
}

// ── HU-SOL-13 (WKH-216) — dobles del money-path Solana no-custodial ──────────────────────────────
export const FAKE_SOLANA_BENEFICIARY = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // base58 devnet
export const FAKE_SOLANA_AUTHORITY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // base58 (release-authority)
export const FAKE_SOLANA_SIGNATURE = bs58.encode(new Uint8Array(64).fill(7)); // signature base58 válida (64 bytes)
export const FAKE_SOLANA_REFERENCE = "So11111111111111111111111111111111111111112"; // base58 reference
// SDD 037 — popSignature sintético: base58 de 64 bytes, el largo REAL de una firma ed25519. Se usa el
// mismo criterio que FAKE_SOLANA_SIGNATURE (bs58 de 64 bytes) y no un string corto, porque la ruta
// valida el largo (86-88 chars) y un fake más corto haría pasar tests contra un 400 imposible en prod.
export const FAKE_SOLANA_POP_SIGNATURE = bs58.encode(new Uint8Array(64).fill(9));

// FakeSolanaWallet — WalletPort cuya authorizePrincipal devuelve el envelope `solana` (HU-SOL-5), para
// probar el money-path de ConfirmAndSend sin @solana/web3.js. Registra el 3er arg `deposit` recibido:
// los tests verifican que el escrow (beneficiary/authority) llegó SERVER-SIDE desde prepare (nunca del body).
export class FakeSolanaWallet implements WalletPort {
  public authorizeCalls: Array<{
    remittanceId?: string;
    deposit?: { address: string; escrow?: { beneficiary: string; authority: string; mint?: string } };
  }> = [];
  // Pasá `null` para simular una wallet que NO arma el deposit (return sin envelope solana). `undefined`
  // (omitido) usa el default OK — por eso el "no-envelope" es `null` explícito (no `undefined`).
  private readonly solana: SolanaPrincipalAuthorization | null;
  constructor(solana: SolanaPrincipalAuthorization | null = {
    vm: "solana",
    partialSignedTx: "AQID", // base64 sintético
    reference: FAKE_SOLANA_REFERENCE,
    popSignature: FAKE_SOLANA_POP_SIGNATURE,
  }) {
    this.solana = solana;
  }
  async connect(): Promise<string> {
    return FAKE_SOLANA_BENEFICIARY;
  }
  async getAddress(): Promise<string | null> {
    return FAKE_SOLANA_BENEFICIARY;
  }
  async authorizePrincipal(
    _quote: Quote,
    remittanceId?: string,
    deposit?: { address: string; escrow?: { beneficiary: string; authority: string; mint?: string } },
  ): Promise<AutorizacionDelPrincipal> {
    this.authorizeCalls.push({ remittanceId, deposit });
    // WKH-356: el envoltorio `estado`, y NADA más. Este doble NUNCA suspende: la variante
    // "hay-que-salir" la produce sólo la rama de enlace del adaptador real, y quien quiera probarla
    // escribe un doble propio que la devuelva explícitamente (que es lo que hace T-062-22).
    return this.solana
      ? { estado: "listo", tx: this.solana.partialSignedTx, solana: this.solana }
      : { estado: "listo", tx: "0xsol" };
  }
  async signMessage(_message: string): Promise<string> {
    return "solana-fakesig";
  }
}

// FakeSolanaPayoutPrepareGateway — resuelve beneficiary+authority server-side (por default OK). Pasá
// { ok:false, reason } o mode="reject" para ejercitar el fail-closed pre-firma (AC-1). Registra los inputs.
export type FakeSolanaPrepareResult =
  | {
      ok: true;
      result: {
        beneficiary: string;
        authority: string;
        attestation: string;
        payoutId: string;
        provenance: string;
        agent?: import("../domain/remittance").AgentRef;
      };
    }
  | { ok: false; reason: string };

export class FakeSolanaPayoutPrepareGateway implements SolanaPayoutPrepareGateway {
  public calls: Array<{
    remittanceId: string;
    quoteId: string;
    address: string;
    amountUsd: number;
    beneficiary: unknown;
    idempotencyKey: string;
    proof?: WalletPossessionProof; // WKH-359: el doble registra la prueba INYECTADA. Sin esto, un `prepare` que la ignorara daría verde: el fake no tendría dónde mostrarla.
  }> = [];
  constructor(
    private readonly result: FakeSolanaPrepareResult = {
      ok: true,
      result: {
        beneficiary: FAKE_SOLANA_BENEFICIARY,
        authority: FAKE_SOLANA_AUTHORITY,
        attestation: "solana-deposit-att-fake",
        payoutId: "transfi-sol-po-1",
        provenance: "transfi",
      },
    },
    private readonly mode: "resolve" | "reject" = "resolve",
  ) {}
  // ⚠️ ESTE DOBLE NO LO CAZA `tsc`, y está medido: borrar un campo de la interfaz produce TS2353 en
  // los call-sites con literal de objeto, pero NO produce error en una clase que lo implementa
  // declarando el campo extra en su parámetro (bivarianza de métodos). O sea que dejar acá un
  // `kycVerificationId: string` compilaría, y el doble seguiría afirmando una forma que el puerto ya
  // no tiene. Se saca a mano; el cierre es el `grep`, no el typechecker (CD-27).
  async prepare(input: {
    remittanceId: string;
    quoteId: string;
    address: string;
    amountUsd: number;
    beneficiary: import("../domain/remittance").Beneficiary;
    idempotencyKey: string;
  }): Promise<FakeSolanaPrepareResult> {
    this.calls.push(input);
    if (this.mode === "reject") throw new Error("solana_prepare_boom");
    return this.result;
  }
}

// FakeSolanaSettlementGateway — broadcast del deposit (por default OK con signature base58). Pasá
// { ok:false, reason } o mode="reject" para ejercitar el fail-closed (C3). Registra los inputs.
export type FakeSolanaSettleResult =
  | { ok: true; signature: string }
  | { ok: false; reason: SolanaSettlementFailureReason };

export class FakeSolanaSettlementGateway implements SolanaSettlementGateway {
  public calls: Array<{
    partialSignedTx: string;
    reference: string;
    sender: string;
    remittanceId: string;
    popSignature: string;
  }> = [];
  constructor(
    private readonly result: FakeSolanaSettleResult = { ok: true, signature: FAKE_SOLANA_SIGNATURE },
    private readonly mode: "resolve" | "reject" = "resolve",
  ) {}
  async settle(input: {
    partialSignedTx: string;
    reference: string;
    sender: string;
    remittanceId: string;
    popSignature: string;
  }): Promise<FakeSolanaSettleResult> {
    this.calls.push(input);
    if (this.mode === "reject") throw new Error("solana_settle_boom");
    return this.result;
  }
}

// FakeSolanaEscrowRefundGateway — refund trustless (AC-6). Registra los inputs; por default devuelve
// una signature base58 sintética CONFIRMADA. mode="reject" ejercita el error path de la UI, y
// `confirmation` los dos casos en que la cadena no confirmó (pending/unknown): sin ese tercer valor no
// se puede testear que la app deje de afirmar que la plata volvió.
export class FakeSolanaEscrowRefundGateway implements SolanaEscrowRefundGateway {
  // `remittanceId` OPCIONAL: es lo que hace testeable la recuperación DURABLE (sin id, el adapter lo
  // resuelve contra el store server-side). Un test que quiera probar esa puerta tiene que poder
  // afirmar que la llamada salió SIN id, y con el tipo viejo no podía ni construirla.
  public calls: Array<{ remittanceId?: string; sender: string }> = [];
  constructor(
    private readonly refundTx: string = FAKE_SOLANA_SIGNATURE,
    private readonly mode: "resolve" | "reject" = "resolve",
    private readonly confirmation: EscrowRefundConfirmation = "confirmed",
    // El error que tira en modo "reject". Default = el de siempre, así que los tests que ya existían
    // quedan byte-idénticos; los códigos reales del camino sin id (`escrow_not_found`,
    // `escrow_recovery_unavailable`) se inyectan acá.
    private readonly rejectWith: string = "solana_refund_boom",
  ) {}
  async refund(input: { remittanceId?: string; sender: string }): Promise<SolanaEscrowRefundResult> {
    this.calls.push(input);
    if (this.mode === "reject") throw new Error(this.rejectWith);
    return { refundTx: this.refundTx, confirmation: this.confirmation };
  }
}

// FakeSolanaEscrowCloseGateway — WKH-327. Mismo shape que su hermano de refund, y `calls` existe por
// la misma razón que allá: hay guards cuyo único síntoma observable es que el gateway NO se llamó.
// Un test que sólo mire el mensaje de error da verde con un mutante que llame al gateway y DESPUÉS
// tire — o sea que firma una tx que no debía existir y recién ahí se queja.
export class FakeSolanaEscrowCloseGateway implements SolanaEscrowCloseGateway {
  public calls: Array<{ remittanceId: string; sender: string }> = [];
  constructor(
    private readonly closeTx: string = FAKE_SOLANA_SIGNATURE,
    private readonly mode: "resolve" | "reject" = "resolve",
    private readonly confirmation: EscrowRefundConfirmation = "confirmed",
    private readonly rejectWith: string = "close_tx_failed",
  ) {}
  async close(input: { remittanceId: string; sender: string }): Promise<SolanaEscrowCloseResult> {
    this.calls.push(input);
    if (this.mode === "reject") throw new Error(this.rejectWith);
    return { closeTx: this.closeTx, confirmation: this.confirmation };
  }
}

// FakeConnectedWallet — WKH-327 (fix-pack AR/BLQ-BAJO-1). Quién está conectado AHORA.
//
// ⚠️ ESTE DOBLE NO PRUEBA EL CABLEADO Y NO PUEDE HACERLO. Sirve para los tests UNITARIOS del guard,
// donde lo que se ejercita es la comparación. Que el use-case reciba de verdad la billetera VIVA en
// producción lo prueba OTRO test, que monta el árbol real contra el `solanaWalletBridge`
// (`escrow-rent-recovery.test.tsx`, el describe del cambio de billetera). Si algún día ese test
// desaparece, este doble vuelve a aplaudirse solo.
export class FakeConnectedWallet implements ConnectedWalletProbe {
  public calls = 0;
  constructor(private address: string | null) {}
  /** Cambia la billetera conectada, como cambiar de cuenta en Phantom sin recargar. */
  switchTo(address: string | null): void {
    this.address = address;
  }
  async getConnectedAddress(): Promise<string | null> {
    this.calls++;
    return this.address;
  }
}

/**
 * WKH-358 — el doble de la elección de billetera por enlace. **Nadie eligió nada.**
 *
 * 🔴 ES UN OBJETO NULO, NO UN STUB VACÍO, y la diferencia importa: `eleccion()` devuelve `null`, que es
 * el estado REAL de un test que no montó ningún selector, y `elegir()` **TIRA** en vez de contestar una
 * URL de mentira. Un doble que devolviera un `irA` inventado dejaría pasar un test que cree haber
 * saltado a la billetera sin que nada lo haya hecho — el perfil exacto de
 * `tests-que-registran-el-doble-no-prueban-el-cableado`. El test que quiera medir el salto tiene que
 * pasar su propio doble, y así queda escrito en el test que lo hace.
 */
export class RecorridoPorEnlaceNulo implements PreparacionPorEnlace {
  public olvidos = 0;
  eleccion(): BilleteraDeeplink | null {
    return null;
  }
  elegir(): { irA: string } {
    throw new Error("eleccion_de_enlace_no_cableada_en_este_test");
  }
  olvidar(): void {
    this.olvidos++;
  }
  /** `null` = "no hay ningún viaje por enlace abierto", que es el estado real de un test que no montó
   *  ningún selector. Y es lo que hace que el productor de montaje de la pantalla **no llame** a
   *  `completar()` en los ~100 `it` que montan el flujo sin tener nada que ver con esta HU. */
  remesaEnCurso(): string | null {
    return null;
  }
  /** ⚠️ TIRA, por la misma razón que `elegir()`: ningún test puede creer que volvió de un salto sin que
   *  nada lo haya hecho. Es inalcanzable mientras `remesaEnCurso()` conteste `null`, y si algún día se
   *  alcanza, que se vea. ⛔ No devuelve `{estado:"nada"}`: ése es un desenlace REAL del recorrido y un
   *  doble que lo imite escondería el cableado que falta. */
  async completar(): Promise<never> {
    throw new Error("vuelta_de_enlace_no_cableada_en_este_test");
  }
  /** ⚠️ TIRA, por lo mismo. ⛔ Y NO devuelve `"falta"` ni `"no-pudimos-preguntar"`: los dos son
   *  desenlaces REALES de preguntarle a la cadena, y un doble que imite uno esconde el cableado que
   *  falta. Un test que necesite un estado concreto pasa SU propio doble, y así queda escrito ahí. */
  async estadoDeLaCuentaDeNonce(): Promise<never> {
    throw new Error("preparacion_por_enlace_no_cableada_en_este_test");
  }
  async crearCuentaDeNonce(): Promise<never> {
    throw new Error("preparacion_por_enlace_no_cableada_en_este_test");
  }
  /** WKH-359 — ⚠️ TIRA, por la MISMA razón que `completar()`: ningún test puede creer que volvió del
   *  salto del permiso sin que nada lo haya hecho. Es inalcanzable mientras la barra no traiga una marca
   *  del PoP, que es un gate MÁS fuerte que el de `completar()` (aquél se gatea con `remesaEnCurso()`).
   *  ⛔ No devuelve `{estado:"nada"}`: ése es un desenlace REAL y un doble que lo imite esconde el
   *  cableado que falta. */
  async completarPop(): Promise<never> {
    throw new Error("vuelta_del_pop_no_cableada_en_este_test");
  }
}

// FakeSolanaCloseableEscrowLister — WKH-327/AC-8. `mode="reject"` NO es un adorno: es el único modo
// que distingue "la cadena contestó y no hay nada" de "no llegamos a preguntar", y esa distinción es
// justamente la que el copy tiene que respetar. Una lista vacía es una respuesta; una excepción no.
export class FakeSolanaCloseableEscrowLister implements SolanaCloseableEscrowLister {
  public calls: Array<{ sender: string }> = [];
  constructor(
    private readonly result: readonly CloseableEscrow[] = [],
    private readonly mode: "resolve" | "reject" = "resolve",
    private readonly rejectWith: string = "escrow_recovery_unavailable",
  ) {}
  async listCloseable(input: { sender: string }): Promise<readonly CloseableEscrow[]> {
    this.calls.push(input);
    if (this.mode === "reject") throw new Error(this.rejectWith);
    return this.result;
  }
}

// FakeSolanaEscrowDepositProbe: la respuesta de LA CADENA a "¿entró el principal?". Se construye con
// el valor que se quiere probar; mode="reject" ejercita que un probe caído se lea como "unknown" (no
// pudimos preguntar) y NUNCA como "no entró".
export class FakeSolanaEscrowDepositProbe implements SolanaEscrowDepositProbe {
  public calls: Array<{ remittanceId: string; sender: string }> = [];
  constructor(
    private readonly state: PrincipalDepositState = "not_deposited",
    private readonly mode: "resolve" | "reject" = "resolve",
  ) {}
  async probeDeposit(input: { remittanceId: string; sender: string }): Promise<PrincipalDepositState> {
    this.calls.push(input);
    if (this.mode === "reject") throw new Error("escrow_probe_boom");
    return this.state;
  }
}

// FakeSolanaSenderSolBalanceProbe: la respuesta de LA CADENA a "¿cuánto SOL tiene el remitente?".
// Default = MUY por encima del umbral de rent, para que todos los tests que no van sobre este guard
// sigan recorriendo el camino completo sin cambiar una línea. Los tres modos que hacen falta:
//   · new FakeSolanaSenderSolBalanceProbe(0)          ⇒ saldo medido e insuficiente
//   · new FakeSolanaSenderSolBalanceProbe(u, "unknown") ⇒ pudimos preguntar y no supimos (RPC raro)
//   · new FakeSolanaSenderSolBalanceProbe(u, "reject")  ⇒ NO pudimos preguntar (el probe tira)
export class FakeSolanaSenderSolBalanceProbe implements SolanaSenderSolBalanceProbe {
  public calls: Array<{ sender: string }> = [];
  constructor(
    private readonly lamports: number = 1_000_000_000, // 1 SOL: de sobra para el rent
    private readonly mode: "resolve" | "unknown" | "reject" = "resolve",
  ) {}
  async probeSenderSolBalance(input: { sender: string }): Promise<SolanaSenderSolBalance> {
    this.calls.push(input);
    if (this.mode === "reject") throw new Error("sol_balance_probe_boom");
    if (this.mode === "unknown") return { status: "unknown" };
    return { status: "known", lamports: this.lamports };
  }
}

/** Un CCI peruano válido (20 dígitos) para llenar el formulario en los tests de UI. Uno solo para
 *  todos los archivos: eran seis literales `"999888777"` sueltos, y un celular ya no pasa el gate. */
export const TEST_CCI = "00219300445566778899";

/**
 * El beneficiario por defecto es el que la app CREA hoy: depósito a cuenta bancaria con un CCI de
 * 20 dígitos. Era `"yape"` con un celular, y eso dejó de representar cualquier remesa nueva cuando
 * la primera pantalla dejó de ofrecer Yape.
 *
 * El parámetro se queda, y con destino coherente por método: `beneficiary("yape")` es cómo se
 * construye una remesa VIEJA, guardada antes del cambio, para probar que el historial y el recibo
 * la siguen leyendo. Sin él no habría forma de escribir ese test.
 */
export const beneficiary = (method: PayoutMethod = "bank_cci") => ({
  name: "Mamá",
  country: "PE",
  method,
  destination: method === "bank_cci" ? TEST_CCI : "999888777",
});

// FakeSolanaEscrowChainStateReader — WKH-349. La respuesta de LA CADENA a "¿en qué estado está la PDA
// `escrow_state` de estos envíos?", para la pantalla de historial.
//
// Misma forma que `FakeSolanaCloseableEscrowLister` de arriba, y por la misma razón: `mode="reject"`
// no es un adorno, es el único modo que ejercita "NO llegamos a preguntar". Acá hay una diferencia con
// aquél que conviene tener presente: el puerto real NO tira ante un RPC caído fila por fila —devuelve
// `"unknown"`—, así que el `reject` de este doble representa el caso en que el adapter no puede ni
// EMPEZAR (sender inválido, imports que fallan) y la pantalla tiene que armar su propio mapa de
// `"unknown"`.
//
// El `Map` que se le pasa puede ser PARCIAL a propósito: una clave faltante es exactamente el input
// que prueba que el consumidor lee la ausencia como `"unknown"` y nunca como "no hay plata".
export class FakeSolanaEscrowChainStateReader implements SolanaEscrowChainStateReader {
  public calls: Array<{ sender: string; remittanceIds: readonly string[] }> = [];
  constructor(
    private readonly states: ReadonlyMap<string, EscrowChainState> = new Map(),
    private readonly mode: "resolve" | "reject" = "resolve",
  ) {}
  async readEscrowStates(input: {
    sender: string;
    remittanceIds: readonly string[];
  }): Promise<ReadonlyMap<string, EscrowChainState>> {
    this.calls.push({ sender: input.sender, remittanceIds: [...input.remittanceIds] });
    if (this.mode === "reject") throw new Error("escrow_states_boom");
    return this.states;
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-359 — EL DOBLE DE `PruebaDePosesionPorEnlace`
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 SU DEFAULT ES `no-corresponde`, Y ESO NO ES PEREZA: ES LA EVIDENCIA DE AC-8. `no-corresponde` es
// lo que contesta el adaptador real en el camino INYECTADO (gate apagado, o sin elección persistida),
// que es el camino de toda la suite preexistente. Con este default, los ~40 `it` de `ConfirmAndSend`
// que ya existían siguen midiendo EXACTAMENTE lo que medían: si el paso nuevo tocara una línea del
// camino inyectado, se pondrían rojos ellos, sin que haya que escribir un `it` nuevo para notarlo.
//
// ⛔ POR QUÉ EL PUERTO ES REQUERIDO EN EL BUNDLE Y NO `pop?`, aunque eso obligue a tocar 5 archivos de
// test: un `pop?` suelto que quedara undefined haría que el paso desapareciera EN SILENCIO y el camino
// por enlace volvería, sin ruido, al `payout_pop_unavailable` que esta HU vino a matar. Es el MISMO
// argumento que `confirm-and-send.ts` ya tenía escrito para `probe` y `senderBalance`, y el costo de
// tocar 5 archivos es exactamente el precio de que borrar el cableado no compile.
export class FakePruebaDePosesionPorEnlace implements PruebaDePosesionPorEnlace {
  /** Cada llamada con su `proposito`: es lo que permite afirmar que se pidió UNA vez y para QUÉ. */
  readonly llamadas: { proposito: string; direccion: string }[] = [];

  constructor(private readonly respuesta: PruebaPorEnlace = { estado: "no-corresponde" }) {}

  pedir(input: { proposito: "pop-payout" | "pop-kyc"; direccion: string }): Promise<PruebaPorEnlace> {
    this.llamadas.push({ proposito: input.proposito, direccion: input.direccion });
    return Promise.resolve(this.respuesta);
  }
}
