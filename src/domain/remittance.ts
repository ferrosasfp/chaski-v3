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

/** Datos de identidad EXTRAÍDOS del documento por el verificador (Didit) — no se tipean.
 * Tipo de FRONTERA Didit: contiene PII cruda. NUNCA entra al estado del cliente ni a
 * localStorage — se reduce a PersistedIdentity vía toPersistedIdentity aguas arriba (CD-6). */
export interface VerifiedIdentity {
  firstName: string; // nombre(s)
  lastNamePaternal: string; // apellido paterno
  lastNameMaternal: string; // apellido materno (Perú/LATAM: 2 apellidos)
  documentType: string; // "DNI" | "CE" | "PASSPORT"
  documentNumber: string;
  dateOfBirth: string; // ISO date
  nationality: string; // ISO country (ej. "PE")
}

/** Identidad REDUCIDA que se persiste (localStorage) y llega al Review. Sin PII cruda:
 * nunca `documentNumber` completo / `dateOfBirth` / `nationality`. Es lo único que habla
 * el estado del cliente, el KycStore y la UI (CD-6). */
export interface PersistedIdentity {
  firstName: string;
  lastNamePaternal: string;
  lastNameMaternal: string;
  documentType: string;
  documentNumberLast4: string; // últimos ≤4; nunca el número completo
}

/** Reductor ÚNICO de PII (CD-2). Los 3 productores de identity lo embudan (kyc-gateway,
 * fallback/gateways, fakes). Puro, sin I/O — estilo maskIdentity (decision.ts). */
export function toPersistedIdentity(id: VerifiedIdentity): PersistedIdentity {
  const dn = id.documentNumber ?? "";
  return {
    firstName: id.firstName,
    lastNamePaternal: id.lastNamePaternal,
    lastNameMaternal: id.lastNameMaternal,
    documentType: id.documentType,
    documentNumberLast4: dn.slice(-4), // "44556677"→"6677"; ""→""; "12"→"12"
  };
}

export interface KycVerification {
  verificationId: string;
  approved: boolean;
  payoutAllowed: boolean;
  riskLevel: "low" | "medium" | "high";
  provenance: string;
  identity: PersistedIdentity | null; // reducida (sin PII cruda) — lo que Didit extrae, ya reducido
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

// A5 (AC-1/AC-2): tolerancias de consistencia de `receive` vs (send − fee) × rate.
const RECEIVE_TOL_ABS_PEN = 0.02; // 2 centavos — absorbe redondeo a 2 decimales de PEN
const RECEIVE_TOL_REL = 0.01; // 1%

/** Invariante money-path PURA (CD-3, sin I/O): `receive` debe ser consistente con el propio
 * `send`/`feeUsd`/`rate` del quote. Espeja netUsd = max(0, send − fee) del gateway. Es un límite
 * de sanidad defensivo (caza tampering grueso: receive inflado 2× / degradado a la mitad), NO una
 * auditoría de precisión ni detecta un `rate` manipulado (otro vector, fuera de scope). */
function assertReceiveConsistent(quote: Quote): void {
  const expected = Math.max(0, quote.send.major - quote.feeUsd.major) * quote.rate;
  const allowedDelta = Math.max(RECEIVE_TOL_ABS_PEN, expected * RECEIVE_TOL_REL);
  if (Math.abs(quote.receive.major - expected) > allowedDelta) {
    throw new Error("quote_receive_mismatch");
  }
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
  ownerAddress: string | null; // wallet dueña del estado (seteada al verificar identidad); scope del historial
  createdAt: string;
  updatedAt: string;
  version: number; // token de concurrencia (CAS/AC-3/4). Bumpeado por el repo al escribir, NO por la FSM.
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
      ownerAddress: null,
      createdAt: now,
      updatedAt: now,
      version: 0,
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

  startKyc(now: string, ownerAddress: string): void {
    this.to("kyc_pending", now, { ownerAddress });
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
    assertReceiveConsistent(quote); // A5 (AC-1/AC-2): receive ≈ (send − fee) × rate, antes de transicionar
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
  markSettled(payoutTx: string, deliveredPen: Money | null, now: string): void {
    this.to("settled", now, { payoutTx, deliveredPen });
  }
  markPayoutFailed(reason: string, now: string): void {
    this.to("payout_failed", now, { failureReason: reason });
  }
  markRefunded(refundTx: string, now: string): void {
    this.to("refunded", now, { refundTx });
  }

  /** Re-sincroniza la versión de la instancia tras un save() (repo → agregado). Necesario porque
   * ConfirmAndSend hace hasta 4 save() sobre la MISMA instancia: sin esto el 2º save() chocaría
   * consigo mismo. Acople controlado repo→agregado, análogo a un ORM que devuelve la versión tras flush. */
  markSaved(v: number): void {
    this.state = { ...this.state, version: v };
  }

  /** Re-check público de vigencia del quote (M2/AC-5). Reusa el guard privado; el dominio sigue
   * puro con `now` inyectado (sin Date.now()). */
  isQuoteStillValid(now: string): boolean {
    return this.state.quote != null && !this.isQuoteExpired(this.state.quote, now);
  }

  private isQuoteExpired(quote: Quote, nowIso: string): boolean {
    return new Date(quote.expiresAt).getTime() <= new Date(nowIso).getTime();
  }
}
