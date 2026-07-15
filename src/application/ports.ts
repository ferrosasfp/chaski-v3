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

// ── KYC (Didit hosted, redirect same-tab: suave en móvil) ────────────────────
// El request lleva el CONTEXTO de la operación (no la identidad — esa la extrae Didit del documento).
export interface KycRequest {
  amountUsd: number;
  beneficiary: Beneficiary;
  purpose: string;
  callbackUrl?: string; // a dónde vuelve Didit tras el escaneo (misma pestaña)
  senderAddress?: string; // wallet del sender → rate-limit por address (WKH-179)
}
// start() puede resolver directo (simulación) o pedir un redirect (Didit real).
// authToken (WKH-179): token HMAC NUESTRO que ata la sesión al caller (NO el sessionToken de Didit).
export type KycStartResult =
  | { kind: "completed"; verification: KycVerification }
  | { kind: "redirect"; url: string; sessionId: string; authToken?: string };
// decision() se consulta al volver del redirect; terminal=false ⇒ Didit aún procesa.
export interface KycDecision {
  terminal: boolean;
  verification: KycVerification;
}
export interface KycGateway {
  start(req: KycRequest): Promise<KycStartResult>;
  decision(sessionId: string, authToken?: string): Promise<KycDecision>;
}

// KYC pendiente: se persiste antes del redirect para retomar el flujo al volver de Didit.
export interface KycPending {
  remittanceId: string;
  sessionId: string;
  address: string;
  sessionToken?: string; // authToken HMAC persistido para autorizar el GET /decision (WKH-179)
}
export interface KycPendingStore {
  save(p: KycPending): Promise<void>;
  get(): Promise<KycPending | null>;
  clear(): Promise<void>;
}

// ── Payout / value-delivery (agente remit-cashout-payout + partner) ──────────
export interface PayoutSubmit {
  quoteId: string;
  amountUsd: number;
  expectedReceivePen: Money; // PEN lockeado que el usuario confirmó (M3/AC-6); NO reemplaza amountUsd
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

// ── Refund-on-failure (WKH-186) ──────────────────────────────────────────────
// Se dispara tras CADA markPayoutFailed (cierra el gap de remesas huérfanas en payout_failed).
// El adapter default (LedgerRefundGateway) es LEDGER-ONLY: produce un refundTx sintético, NO
// revierte ningún movimiento on-chain real (el clawback real es follow-up de Fase A). El `reason`
// es un enum estable de la FSM — NUNCA PII (CD-5).
export interface RefundGateway {
  creditBack(input: { remittanceId: string; amountUsd: Money; reason: string }): Promise<{ refundTx: string }>;
}

// ── Autoridad de payout server-side (WKH-180) ────────────────────────────────
// Re-valida en el SERVIDOR (contra Didit) que el KYC autoriza el payout para este caller.
// Es la ÚNICA fuente de verdad para autorizar: NUNCA los booleanos que llegan del browser
// (approved/payoutAllowed/kycVerificationId en localStorage son atacante-controlables — CD-2).
export interface PayoutAuthorization {
  authorized: boolean;
  reason?: string; // "kyc_not_approved" | "kyc_reauth_failed" | "kyc_ownership_mismatch" | "kyc_authority_error" | "kyc_authority_unavailable" | ...
}
export interface PayoutAuthorityGateway {
  // address es NO-opcional (CD-A3); el use-case pasa getAddress() ?? "".
  authorize(input: { verificationId: string; address: string }): Promise<PayoutAuthorization>;
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
  clear(address: string): Promise<void>; // reset explícito del KYC-once de esa address (WKH-184)
}

// ── Persistencia (historial/estado — aislado del demo) ───────────────────────
export interface RemittanceRepository {
  save(r: Remittance): Promise<void>;
  get(id: string): Promise<Remittance | null>;
  // list scopeada por wallet: SOLO entries cuyo ownerAddress matchea (case-insensitive). WKH-181.
  list(address: string): Promise<RemittanceState[]>;
  // Purga TODA entry cuyo ownerAddress matchee address (mismo scoping case-insensitive que list()).
  // Best-effort desde el reset (WKH-201): borra la PII persistida del beneficiario al desconectar.
  clearByOwner(address: string): Promise<void>;
}

// ── Utilidades inyectables (nada de Date.now/Math.random en el dominio) ──────
export interface Clock {
  nowIso(): string;
}
export interface IdGenerator {
  newId(): string;
}
