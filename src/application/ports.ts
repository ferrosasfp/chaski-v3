// Application — PORTS. Las interfaces que los use-cases REQUIEREN. La regla de dependencia
// apunta hacia adentro: los use-cases dependen de estos ports; la infra los IMPLEMENTA.
// Reemplazar fallback ↔ real (o gateway a2a ↔ otro) = cambiar el adapter, no el use-case.

import type { Money } from "../domain/money";
import type {
  Beneficiary,
  KycVerification,
  PayoutMethod,
  Quote,
  Remittance,
  RemittanceState,
} from "../domain/remittance";

// ── Quote (agente remit-corridor-fx) ─────────────────────────────────────────
export interface QuoteRequest {
  amountUsd: number;
  method: PayoutMethod;
  destCountry: string;
}
export interface QuoteGateway {
  requestQuote(req: QuoteRequest): Promise<Quote>;
}

// ── KYC (Didit: escanear DNI + selfie; los datos los EXTRAE Didit, no se tipean) ──
// El request lleva solo el CONTEXTO de la operación (no la identidad — esa la devuelve Didit).
export interface KycRequest {
  amountUsd: number;
  beneficiary: Beneficiary;
  purpose: string;
}
export interface KycGateway {
  // En real: crea una sesión Didit (redirect/widget) y devuelve el resultado con la identidad extraída.
  verify(req: KycRequest): Promise<KycVerification>;
}

// ── Payout / value-delivery (agente remit-cashout-payout + partner) ──────────
export interface PayoutSubmit {
  quoteId: string;
  amountUsd: number;
  beneficiary: Beneficiary;
  kycVerificationId: string;
  idempotencyKey: string;
}
export interface PayoutRecord {
  payoutId: string;
  status: "submitted" | "settled" | "failed";
  deliveredPen: Money | null;
  txRef: string | null;
  failureReason: string | null;
}
export interface PayoutGateway {
  submit(req: PayoutSubmit): Promise<PayoutRecord>;
  status(payoutId: string): Promise<PayoutRecord>;
}

// ── Wallet (DApp: el sender CONECTA su wallet = login, y firma la autorización EIP-3009) ──
export interface WalletPort {
  connect(): Promise<string>; // conecta y devuelve la address (el "login")
  getAddress(): Promise<string | null>;
  authorizePrincipal(quote: Quote): Promise<{ tx: string }>;
}

// ── KYC recordado por dirección (KYC-once: se verifica una vez por wallet) ────
export interface KycStore {
  get(address: string): Promise<KycVerification | null>;
  save(address: string, kyc: KycVerification): Promise<void>;
}

// ── Persistencia (historial/estado — aislado del demo) ───────────────────────
export interface RemittanceRepository {
  save(r: Remittance): Promise<void>;
  get(id: string): Promise<Remittance | null>;
  list(): Promise<RemittanceState[]>;
}

// ── Utilidades inyectables (nada de Date.now/Math.random en el dominio) ──────
export interface Clock {
  nowIso(): string;
}
export interface IdGenerator {
  newId(): string;
}
