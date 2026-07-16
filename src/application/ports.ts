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
  // WKH-202/DT-2: el server re-valida ownership (vendor_data de Didit) — NO-opcional (CD-4): un
  // address opcional sería fail-open.
  address: string;
  idempotencyKey: string;
  // WKH-168: atestación HMAC del settlement del principal, emitida por /api/settle/principal tras
  // verificar el receipt on-chain. OPCIONAL a propósito: en modo demo NO existe atestación (AC-5) y
  // el demo debe seguir byte-idéntico. NO es fail-open: el enforcement vive en el SERVER
  // (/api/a2a/payout/submit, rama A3 → 403), no en el tipo. Omitirla no ayuda al atacante.
  settlementAttestation?: string;
  // WKH-206: prueba de posesión (challenge server-emitido + firma de la wallet). MISMO criterio que
  // settlementAttestation: OPCIONAL a propósito (demo byte-idéntico, AC-5); el enforcement es
  // server-side (guard 7 → 403), NO fail-open. Omitirlos no ayuda al atacante.
  popChallenge?: string;
  popSignature?: string;
}
export interface PayoutRecord {
  payoutId: string;
  status: "submitted" | "settled" | "failed";
  deliveredPen: Money | null;
  txRef: string | null;
  failureReason: string | null;
  provenance: string; // proveniencia del desembolso (real vs mock) — propagada a RemittanceState (WKH-200)
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

// ── Settlement del principal (WKH-168) ───────────────────────────────────────
// AC-9 (residual NO cerrado por esta HU): si el browser se cierra entre el settle on-chain y el
// estado terminal, la remesa queda HUÉRFANA con el principal REALMENTE adentro. Esta HU EMPEORA la
// consecuencia (antes no había plata; ahora sí) sin cerrar el gap: no hay persistencia server-side
// ni reconciliación. → WKH-207. El single-use pre-forward de la atestación agrega un 2º caso de
// varado (atestación quemada + forward fallido) → misma HU.
export interface Eip3009Authorization {
  from: string; // 0x + 40 hex
  to: string; // 0x + 40 hex
  value: string; // uint256 decimal CANÓNICO (/^(0|[1-9]\d*)$/) — NUNCA bigint (CD-16)
  validAfter: string; // idem
  validBefore: string; // idem
  nonce: string; // 0x + 64 hex (bytes32)
}

export type SettlementFailureReason =
  | "settlement_unavailable"
  | "settlement_rejected"
  | "settlement_amount_mismatch"
  | "settlement_receiver_mismatch"
  | "settlement_reverted"
  | "settlement_unverified";

export interface PrincipalSettlementGateway {
  settle(input: {
    authorization: Eip3009Authorization;
    signature: string;
    address: string;
    quoteId: string;
    expectedValueMinor: number; // quote.send.minor
    remittanceId: string; // WKH-207 (aditivo): el cliente ya tiene s.id — habilita el ledger server-side
  }): Promise<
    | { ok: true; txHash: string; valueMinor: number; to: string; from: string; attestation: string }
    | { ok: false; reason: SettlementFailureReason }
  >;
}

// ── Wallet (DApp: el sender CONECTA su wallet = login, y firma la autorización EIP-3009) ──
// WKH-168 — remittanceId es REQUERIDO (CD-19: el nonce determinístico es la garantía anti-doble-pago
// a nivel CONTRATO; un remittanceId opcional permitiría caer en silencio al nonce random).
export interface WalletPort {
  connect(): Promise<string>; // conecta y devuelve la address (el "login")
  getAddress(): Promise<string | null>;
  authorizePrincipal(
    quote: Quote,
    remittanceId: string,
  ): Promise<{
    tx: string; // demo: firma simbólica (AC-5)
    eip3009?: { authorization: Eip3009Authorization; signature: string }; // SOLO en modo real
  }>;
  // WKH-206: firma un mensaje arbitrario (personal_sign) con la key de la wallet conectada. Lo usa el
  // PopSigner para probar posesión de `address`. En demo devuelve una firma simbólica (AC-5).
  signMessage(message: string): Promise<string>;
}

// ── Proof-of-Possession (WKH-206) ────────────────────────────────────────────
// Obtiene un challenge server-emitido para `address` y lo firma con la wallet. El use-case adjunta el
// { challenge, signature } al submit; el server (guard 7) recupera al firmante y exige == address.
// OPT-IN: sólo se inyecta cuando NEXT_PUBLIC_PAYOUT_POP_ENABLED === "true" (demo byte-idéntico si no).
// WKH-206/DT-2 (fix-pack AR-MNR-1): `prove` distingue DOS resultados no-felices:
//   · `null` ⇒ SKIP: el mecanismo está apagado server-side (501 `pop_not_configured`). El use-case NO
//     adjunta popChallenge/popSignature ⇒ byte-idéntico al demo (el server sin secreto también skipea).
//   · throw ⇒ fail-closed CONTROLADO: cualquier otro error (red / 400 / 5xx en un deployment ON). El
//     use-case lo degrada por su camino de error existente (failAndRefund), NUNCA deja la remesa varada.
export interface PopSigner {
  prove(address: string): Promise<{ challenge: string; signature: string } | null>;
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

// ── Ledger de settlements server-side (WKH-207) ──────────────────────────────
// Persiste la EVIDENCIA money-path del settle del principal (txHash/monto/address/quoteId/status)
// para cerrar el residual de remesas huérfanas de WKH-168: si el browser se cierra entre principal_in
// y un estado terminal, este ledger es la ÚNICA fuente server-side para reconciliar. NUNCA persiste
// PII (beneficiary/documento) — CD-7. Flag-gated: la factory devuelve null con el flag OFF/envs
// ausentes ⇒ las rutas skipean el persist ⇒ byte-idéntico (AC-2/AC-10).
export type SettlementLedgerStatus =
  | 'principal_in'
  | 'submitted'
  | 'settled'
  | 'failed'
  | 'forward_error'
  | 'manual_review';

export interface SettlementRecord {
  id: string;
  remittanceId: string;
  quoteId: string;
  idempotencyKey: string;
  txHash: string;
  chainId: number;
  senderAddress: string;
  receiverAddress: string;
  valueMinor: number; // parseado desde value_minor::text (CD-12, WKH-196)
  status: SettlementLedgerStatus;
  attempts: number;
  payoutId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SettlementLedger {
  // settle route (AC-1): upsert por tx_hash (ON CONFLICT DO NOTHING), status principal_in.
  recordPrincipalIn(input: {
    remittanceId: string;
    quoteId: string;
    idempotencyKey: string;
    txHash: string;
    chainId: number;
    senderAddress: string;
    receiverAddress: string;
    valueMinor: number;
  }): Promise<void>;
  // submit route (AC-3): UPDATE owner-scoped por (idempotencyKey, senderAddress).
  recordPayoutOutcome(input: {
    idempotencyKey: string;
    senderAddress: string;
    status: SettlementLedgerStatus;
    payoutId?: string | null;
    error?: string | null;
  }): Promise<void>;
  // reconcile (AC-4): no-terminales más viejas que olderThanIso. Global (admin) — sin owner filter.
  listStale(input: { olderThanIso: string; limit: number }): Promise<SettlementRecord[]>;
  // reconcile (AC-6): incrementa attempts + set status/last_error. Por id.
  markOutcome(input: {
    id: string;
    status: SettlementLedgerStatus;
    payoutId?: string | null;
    error?: string | null;
    incrementAttempt: boolean;
  }): Promise<void>;
}

// ── Utilidades inyectables (nada de Date.now/Math.random en el dominio) ──────
export interface Clock {
  nowIso(): string;
}
export interface IdGenerator {
  newId(): string;
}
