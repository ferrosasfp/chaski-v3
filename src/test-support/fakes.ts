// Test doubles — implementaciones fake de los ports (para probar use-cases sin infra real).
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
import type {
  Clock,
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
  QuoteGateway,
  QuoteRequest,
  RefundGateway,
  RemittanceRepository,
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
    const target = address.toLowerCase();
    return [...this.store.values()].filter(
      (s) => s.ownerAddress != null && s.ownerAddress.toLowerCase() === target,
    );
  }
  async clearByOwner(address: string): Promise<void> {
    // Gemelo del filtro de list() sobre this.store (WKH-201/CD-6). this.store ES el store → delete directo.
    const target = address.toLowerCase();
    for (const [id, s] of this.store) {
      if (s.ownerAddress != null && s.ownerAddress.toLowerCase() === target) {
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

export class FakeWallet implements WalletPort {
  async connect(): Promise<string> {
    return "0xSender";
  }
  async getAddress(): Promise<string | null> {
    return "0xSender";
  }
  async authorizePrincipal(_quote: Quote): Promise<{ tx: string }> {
    return { tx: "0xprincipal" };
  }
}

export class FakeKycStore implements KycStore {
  private m = new Map<string, KycVerification>();
  async get(address: string): Promise<KycVerification | null> {
    return this.m.get(address.toLowerCase()) ?? null;
  }
  async save(address: string, kyc: KycVerification): Promise<void> {
    this.m.set(address.toLowerCase(), kyc);
  }
  async clear(address: string): Promise<void> {
    this.m.delete(address.toLowerCase());
  }
}

// Doble que SIEMPRE falla en save() (simula localStorage lleno / private-browsing) para el test
// de WKH-199: ResumeKyc/StartKyc deben persistir kyc_passed pese al fallo del cache. get/clear
// funcionan in-memory (paralela a ThrowingClearKycStore, invirtiendo cuál método lanza).
export class ThrowingSaveKycStore implements KycStore {
  private m = new Map<string, KycVerification>();
  async get(address: string): Promise<KycVerification | null> {
    return this.m.get(address.toLowerCase()) ?? null;
  }
  async save(_address: string, _kyc: KycVerification): Promise<void> {
    throw new Error("kyc_store_unavailable");
  }
  async clear(address: string): Promise<void> {
    this.m.delete(address.toLowerCase());
  }
}

// Doble que SIEMPRE falla en clear() (simula localStorage roto) para el test defensivo de WKH-184:
// ForgetKyc debe resolver igual y correr pending.clear() (AC-5/CD-8). get/save funcionan normal.
export class ThrowingClearKycStore implements KycStore {
  private m = new Map<string, KycVerification>();
  async get(address: string): Promise<KycVerification | null> {
    return this.m.get(address.toLowerCase()) ?? null;
  }
  async save(address: string, kyc: KycVerification): Promise<void> {
    this.m.set(address.toLowerCase(), kyc);
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

// Refund fake (WKH-186). Por default resuelve { refundTx:"refund-fake" } (regresión-neutral);
// mode="reject" ejercita el best-effort de failAndRefund (queda en payout_failed si el refund falla).
// Registra los inputs recibidos (molde de FakePayoutAuthorityGateway).
export class FakeRefundGateway implements RefundGateway {
  public calls: Array<{ remittanceId: string; amountUsd: Money; reason: string }> = [];
  constructor(private mode: "resolve" | "reject" = "resolve") {}
  async creditBack(input: {
    remittanceId: string;
    amountUsd: Money;
    reason: string;
  }): Promise<{ refundTx: string }> {
    this.calls.push(input);
    if (this.mode === "reject") throw new Error("refund_unavailable");
    return { refundTx: "refund-fake" };
  }
}

export const beneficiary = (method: PayoutMethod = "yape") => ({
  name: "Mamá",
  country: "PE",
  method,
  destination: "999888777",
});
