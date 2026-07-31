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
import { canonicalizeAddress } from "../infrastructure/address";
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
  SolanaEscrowRefundResult,
  SolanaPayoutPrepareGateway,
  SolanaPrincipalAuthorization,
  SolanaSettlementFailureReason,
  SolanaSettlementGateway,
  WalletPort,
} from "../application/ports";

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
  async list(address: string): Promise<RemittanceState[]> {
    const target = canonicalizeAddress(address);
    return [...this.store.values()].filter(
      (s) =>
        s.ownerAddress != null &&
        canonicalizeAddress(s.ownerAddress) === target,
    );
  }
  async clearByOwner(address: string): Promise<void> {
    // Gemelo del filtro de list() sobre this.store (WKH-201/CD-6). this.store ES el store → delete directo.
    const target = canonicalizeAddress(address);
    for (const [id, s] of this.store) {
      if (
        s.ownerAddress != null &&
        canonicalizeAddress(s.ownerAddress) === target
      ) {
        this.store.delete(id);
      }
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
  ): Promise<{ tx: string }> {
    return { tx: "fake-principal" };
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
  async get(address: string): Promise<KycVerification | null> {
    return this.m.get(canonicalizeAddress(address)) ?? null;
  }
  async save(address: string, kyc: KycVerification): Promise<void> {
    this.m.set(canonicalizeAddress(address), kyc);
  }
  async clear(address: string): Promise<void> {
    this.m.delete(canonicalizeAddress(address));
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
//   · "resolve"    — devolvió un comprobante REAL ("refund-fake"): alguien revirtió plata. Es el único
//     caso que autoriza a escribir `refunded`.
//   · "no-receipt" — devolvió null: el adapter NO revirtió nada (es lo que hace el LedgerRefundGateway
//     que corre en producción). Sin este modo, los tests sólo ejercitaban un adapter que no existe.
//   · "reject"     — lanzó: ejercita el best-effort de failAndRefund (queda en payout_failed).
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

/** Conjunto mutable por el webhook (R1) = STALE_STATUSES + 'prepared'. Espeja
 *  WEBHOOK_UPDATABLE_STATUSES del ledger real; DISTINTO del conjunto del reconcile a propósito. */
const WEBHOOK_UPDATABLE_STATUSES: readonly SettlementLedgerStatus[] = [
  ...STALE_STATUSES,
  "prepared",
];

/** Mismo placeholder determinístico que escribe el ledger real en una fila 'prepared'. */
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
      lastError: null,
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
    });
  }

  async recordSolanaPrincipalIn(input: {
    remittanceId: string;
    senderAddress: string;
    signature: string;
  }): Promise<void> {
    // WKH-213/R3 — espeja al ledger real: ancla la signature a la fila 'prepared' MÁS RECIENTE de esta
    // remesa y este sender (owner-scoped). Sin fila preparada: NO-OP (no hay quote_id/value_minor
    // honestos que insertar). El índice único de tx_hash también aplica acá.
    const owner = canonicalizeAddress(input.senderAddress);
    const candidates = [...this.store.values()]
      .filter(
        (r) =>
          r.remittanceId === input.remittanceId &&
          r.senderAddress === owner &&
          r.status === "prepared",
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const row = candidates[0];
    if (!row) return;
    this.assertUnique(
      { txHash: input.signature, idempotencyKey: row.idempotencyKey },
      "ledger_record_solana_principal_in_failed",
      row.id,
    );
    row.txHash = input.signature;
    row.status = "principal_in";
    row.updatedAt = this.nowIso;
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
    error?: string | null;
  }): Promise<void> {
    for (const r of this.store.values()) {
      // NO owner-scoped (CD-12): correlaciona solo por payoutId. Filtro no-terminal = DT-2b: nunca
      // degrada un estado terminal ni reclasifica manual_review. WKH-213/R1: el conjunto incluye
      // 'prepared' (el proveedor puede avisar antes de que el settle aterrice, o sin que aterrice).
      if (r.payoutId === input.payoutId && WEBHOOK_UPDATABLE_STATUSES.includes(r.status)) {
        r.status = input.status;
        if (input.error !== undefined) r.lastError = input.error;
        r.updatedAt = this.nowIso;
      }
    }
  }
}

// ── HU-SOL-13 (WKH-216) — dobles del money-path Solana no-custodial ──────────────────────────────
export const FAKE_SOLANA_BENEFICIARY = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // base58 devnet
export const FAKE_SOLANA_AUTHORITY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // base58 (release-authority)
export const FAKE_SOLANA_SIGNATURE = bs58.encode(new Uint8Array(64).fill(7)); // signature base58 válida (64 bytes)
export const FAKE_SOLANA_REFERENCE = "So11111111111111111111111111111111111111112"; // base58 reference

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
  ): Promise<{ tx: string; solana?: SolanaPrincipalAuthorization }> {
    this.authorizeCalls.push({ remittanceId, deposit });
    return this.solana ? { tx: this.solana.partialSignedTx, solana: this.solana } : { tx: "0xsol" };
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
      result: { beneficiary: string; authority: string; attestation: string; payoutId: string; provenance: string };
    }
  | { ok: false; reason: string };

export class FakeSolanaPayoutPrepareGateway implements SolanaPayoutPrepareGateway {
  public calls: Array<{
    remittanceId: string;
    quoteId: string;
    kycVerificationId: string;
    address: string;
    amountUsd: number;
    beneficiary: unknown;
    idempotencyKey: string;
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
  async prepare(input: {
    remittanceId: string;
    quoteId: string;
    kycVerificationId: string;
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
    popProof?: string;
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
    popProof?: string;
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
  public calls: Array<{ remittanceId: string; sender: string }> = [];
  constructor(
    private readonly refundTx: string = FAKE_SOLANA_SIGNATURE,
    private readonly mode: "resolve" | "reject" = "resolve",
    private readonly confirmation: EscrowRefundConfirmation = "confirmed",
  ) {}
  async refund(input: { remittanceId: string; sender: string }): Promise<SolanaEscrowRefundResult> {
    this.calls.push(input);
    if (this.mode === "reject") throw new Error("solana_refund_boom");
    return { refundTx: this.refundTx, confirmation: this.confirmation };
  }
}

// FakeSolanaEscrowDepositProbe — la respuesta de LA CADENA a "¿entró el principal?". Se construye con
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

export const beneficiary = (method: PayoutMethod = "yape") => ({
  name: "Mamá",
  country: "PE",
  method,
  destination: "999888777",
});
