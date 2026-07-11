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

export class SeqIds implements IdGenerator {
  private n = 0;
  newId(): string {
    return `rem-${++this.n}`;
  }
}

export class InMemoryRepo implements RemittanceRepository {
  private store = new Map<string, RemittanceState>();
  async save(r: Remittance): Promise<void> {
    this.store.set(r.snapshot.id, r.snapshot);
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
      ...this.submitResult,
    };
  }
  async status(payoutId: string): Promise<PayoutRecord> {
    return {
      payoutId,
      status: "settled",
      deliveredPen: Money.of(368, "PEN"),
      txRef: "0xdelivered",
      failureReason: null,
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

export const beneficiary = (method: PayoutMethod = "yape") => ({
  name: "Mamá",
  country: "PE",
  method,
  destination: "999888777",
});
