// Domain — el agregado Remittance + su máquina de estados. Money-path: las invariantes de
// negocio viven ACÁ (no en la UI, no en el gateway). Puro, sin deps salvo Money.

import { Money } from "./money";

export type PayoutMethod = "yape" | "plin" | "bank_cci";

export interface Beneficiary {
  name: string;
  country: string; // "PE"
  method: PayoutMethod;
  destination: string; // celular (Yape/Plin) o CCI (banco)
}

export interface Quote {
  quoteId: string;
  send: Money; // USDC que sale del sender
  receive: Money; // PEN que recibe el beneficiario
  feeUsd: Money;
  rate: number; // USDC→PEN efectivo
  etaMinutes: number;
  expiresAt: string; // ISO
  provenance: string;
}

/** Datos de identidad EXTRAÍDOS del documento por el verificador (Didit) — no se tipean. */
export interface VerifiedIdentity {
  firstName: string; // nombre(s)
  lastNamePaternal: string; // apellido paterno
  lastNameMaternal: string; // apellido materno (Perú/LATAM: 2 apellidos)
  documentType: string; // "DNI" | "CE" | "PASSPORT"
  documentNumber: string;
  dateOfBirth: string; // ISO date
  nationality: string; // ISO country (ej. "PE")
}

export interface KycVerification {
  verificationId: string;
  approved: boolean;
  payoutAllowed: boolean;
  riskLevel: "low" | "medium" | "high";
  provenance: string;
  identity: VerifiedIdentity | null; // lo que Didit extrae del documento (no lo tipea el usuario)
}

export type RemittanceStatus =
  | "created"
  | "kyc_pending"
  | "kyc_passed"
  | "kyc_failed"
  | "quoted"
  | "confirmed"
  | "principal_in"
  | "payout_submitted"
  | "settled"
  | "payout_failed"
  | "refunded";

const TRANSITIONS: Record<RemittanceStatus, readonly RemittanceStatus[]> = {
  created: ["kyc_pending"],
  kyc_pending: ["kyc_passed", "kyc_failed"],
  kyc_passed: ["quoted"],
  kyc_failed: [],
  quoted: ["quoted", "confirmed"], // re-quote permitido
  confirmed: ["principal_in", "payout_failed"],
  principal_in: ["payout_submitted", "payout_failed"],
  payout_submitted: ["settled", "payout_failed"],
  settled: [],
  payout_failed: ["refunded"],
  refunded: [],
};

export const TERMINAL_STATUSES: readonly RemittanceStatus[] = ["settled", "kyc_failed", "refunded"];

export function canTransition(from: RemittanceStatus, to: RemittanceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface RemittanceState {
  id: string;
  status: RemittanceStatus;
  beneficiary: Beneficiary;
  sendUsd: Money;
  quote: Quote | null;
  kyc: KycVerification | null;
  payoutId: string | null;
  principalTx: string | null;
  payoutTx: string | null;
  refundTx: string | null;
  deliveredPen: Money | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export class Remittance {
  private constructor(private state: RemittanceState) {}

  static create(id: string, beneficiary: Beneficiary, sendUsd: Money, now: string): Remittance {
    if (sendUsd.currency !== "USDC") throw new Error("send_must_be_usdc");
    if (sendUsd.isZero()) throw new Error("send_amount_zero");
    return new Remittance({
      id,
      status: "created",
      beneficiary,
      sendUsd,
      quote: null,
      kyc: null,
      payoutId: null,
      principalTx: null,
      payoutTx: null,
      refundTx: null,
      deliveredPen: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static rehydrate(state: RemittanceState): Remittance {
    return new Remittance({ ...state });
  }

  get snapshot(): Readonly<RemittanceState> {
    return this.state;
  }
  get status(): RemittanceStatus {
    return this.state.status;
  }
  get isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this.state.status);
  }

  private to(next: RemittanceStatus, now: string, patch: Partial<RemittanceState> = {}): void {
    if (!canTransition(this.state.status, next)) {
      throw new Error(`invalid_transition:${this.state.status}->${next}`);
    }
    this.state = { ...this.state, ...patch, status: next, updatedAt: now };
  }

  startKyc(now: string): void {
    this.to("kyc_pending", now);
  }

  applyKyc(kyc: KycVerification, now: string): void {
    const passed = kyc.approved && kyc.payoutAllowed;
    this.to(passed ? "kyc_passed" : "kyc_failed", now, {
      kyc,
      failureReason: passed ? null : "kyc_not_passed",
    });
  }

  attachQuote(quote: Quote, now: string): void {
    // Invariante money-path: el quote debe cotizar EXACTAMENTE el monto a enviar.
    if (quote.send.minor !== this.state.sendUsd.minor) throw new Error("quote_amount_mismatch");
    if (this.isQuoteExpired(quote, now)) throw new Error("quote_expired");
    this.to("quoted", now, { quote });
  }

  /** Confirmación del usuario. Invariante DURA: KYC pasado + quote válido y no vencido. */
  confirm(now: string): void {
    if (!this.state.kyc || !(this.state.kyc.approved && this.state.kyc.payoutAllowed)) {
      throw new Error("confirm_requires_kyc_passed");
    }
    if (!this.state.quote) throw new Error("confirm_requires_quote");
    if (this.isQuoteExpired(this.state.quote, now)) throw new Error("confirm_quote_expired");
    this.to("confirmed", now);
  }

  markPrincipalIn(tx: string, now: string): void {
    this.to("principal_in", now, { principalTx: tx });
  }
  markPayoutSubmitted(payoutId: string, now: string): void {
    this.to("payout_submitted", now, { payoutId });
  }
  markSettled(payoutTx: string, deliveredPen: Money, now: string): void {
    this.to("settled", now, { payoutTx, deliveredPen });
  }
  markPayoutFailed(reason: string, now: string): void {
    this.to("payout_failed", now, { failureReason: reason });
  }
  markRefunded(refundTx: string, now: string): void {
    this.to("refunded", now, { refundTx });
  }

  private isQuoteExpired(quote: Quote, nowIso: string): boolean {
    return new Date(quote.expiresAt).getTime() <= new Date(nowIso).getTime();
  }
}
