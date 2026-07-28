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

// ── VmAuthorization (WKH-206 / HU-SOL-1) — andamiaje de TIPOS multi-VM ────────────
// El discriminador `vm` vive a nivel ENVELOPE { authorization, signature }, NO dentro del payload
// EIP-3009 (Eip3009Authorization se mantiene byte-idéntico: se firma EIP-712 y se serializa cruda al
// POST /api/settle/principal — meterle un campo cambiaría ese body → violación money-path CD-3/CD-SDD-7).
// Estructuralmente `EvmAuthorization` (menos el tag `vm`) == el `eip3009?:` de authorizePrincipal (L203),
// que NO se re-tipa en esta HU para preservar byte-identidad (AC-5). El wiring runtime es HU-SOL-2/SOL-4.

// Variante EVM del envelope (envuelve el payload EIP-3009 INTACTO).
export interface EvmAuthorization {
  vm: "evm";
  authorization: Eip3009Authorization;
  signature: string;
}

// Variante Solana — PLACEHOLDER DE TIPOS (DT-3). Sin lógica de firma/verificación (Scope OUT).
// Los campos pueden ajustarse en HU-SOL-2 (legacy Transaction vs VersionedTransaction). [TBD HU-SOL-2]
export interface SolanaAuthorization {
  vm: "solana";
  from: string; // base58 (PublicKey del pagador)              [TBD HU-SOL-2]
  to: string; // base58 (ATA / owner del receiver)             [TBD HU-SOL-2]
  amount: string; // base units del SPL token (uint64 decimal string, sin floats)
  recentBlockhash: string; // equivalente Solana de validAfter/validBefore [TBD HU-SOL-2]
  signature: string; // firma base58                            [TBD HU-SOL-2]
}

export type VmAuthorization = EvmAuthorization | SolanaAuthorization;

// ── HU-SOL-5 (WKH-207*) — widening ADITIVO del WalletPort para el path Solana ──────
/** Datos del escrow que el CALLER (HU-SOL-13) resuelve y pasa a la wallet Solana. base58. */
export interface SolanaEscrowDeposit {
  beneficiary: string; // Pubkey base58 — destino de la remesa (release). Resuelto por HU-SOL-13.
  authority: string; // Pubkey base58 — quien puede release/refund. Resuelto por HU-SOL-13.
  mint?: string; // opcional: override del mint; default resolveSolanaUsdcMint() (CD-SDD-4).
}

/** Variante Solana del retorno de authorizePrincipal (envelope, alineada con SolanaAuthorization). */
export interface SolanaPrincipalAuthorization {
  vm: "solana";
  partialSignedTx: string; // tx legacy serializada base64, partial-signed (feePayer=facilitator, firma wallet-only)
  reference: string; // Pubkey base58 de la reference (trazabilidad)
}

// ── HU-SOL-13 (WKH-216) — puertos del money-path Solana no-custodial (escrow Anchor) ──────────────
// ADITIVOS: NO tocan ningún tipo EVM (CD-2/CD-14). El use-case recibe `solana` como 9º param OPCIONAL
// (mutuamente excluyente con `settlement?` EVM). Cuando el container NO inyecta `solana` (EVM/demo),
// estas interfaces no participan ⇒ el path EVM queda byte-idéntico POR CONSTRUCCIÓN.
export type SolanaSettlementFailureReason =
  | "solana_settle_unavailable" // red caída / facilitator no configurado
  | "solana_settle_rejected" // CR-1 del deposit rechazó (422 SPONSOR_REJECTED)
  | "solana_settle_rate_limited" // 429
  | "solana_settle_broadcast_failed" // 409/502 (blockhash expirado / broadcast falló)
  | "solana_settle_unverified"; // shape de respuesta inválido

// Broadcast del `deposit` Solana vía la ruta server-only /api/settle/solana-sponsor → facilitator
// (HU-SOL-14). NUNCA reusa PrincipalSettlementGateway (EIP-3009-shaped) ni su regex 0x… (CD-13): la
// signature de respuesta es base58. Corre en el CLIENTE (el browser jamás llama al facilitator directo).
export interface SolanaSettlementGateway {
  settle(input: {
    partialSignedTx: string; // base64 (= SolanaPrincipalAuthorization.partialSignedTx)
    reference: string; // base58 (= SolanaPrincipalAuthorization.reference)
    sender: string; // base58 wallet del depositor
    remittanceId: string; // server-only, trazabilidad
    popProof?: string; // PoP (HU-SOL-8) — wire-format founder-gated ([NC-2]); mockeado en unit-test
  }): Promise<
    | { ok: true; signature: string } // base58 tx signature YA broadcasteada+confirmada
    | { ok: false; reason: SolanaSettlementFailureReason }
  >;
}

// Prepare del payout Solana no-custodial: crea/consulta la orden TransFi y resuelve, SERVER-SIDE
// (NUNCA del body del cliente, CD-7): `beneficiary` (deposit-address Solana de la orden) + `authority`
// (release-authority pubkey, resolveSolanaReleaseAuthorityPubkey). El use-case pasa ambos a
// authorizePrincipal para que la wallet arme la ix `deposit` del escrow (no una transferencia directa).
export interface SolanaPayoutPrepareGateway {
  prepare(input: {
    remittanceId: string;
    quoteId: string;
    kycVerificationId: string;
    address: string;
    amountUsd: number;
    beneficiary: Beneficiary;
    idempotencyKey: string;
  }): Promise<
    | {
        ok: true;
        result: {
          beneficiary: string; // base58 — destino del release (server-side)
          authority: string; // base58 — release-authority (server-side)
          attestation: string;
          payoutId: string;
          provenance: string;
        };
      }
    | { ok: false; reason: string }
  >;
}

// Refund trustless post-deadline (AC-6/CD-10): delega en wallet.refundEscrow (sender firma + sender
// broadcastea, SIN facilitator ni release-authority). Devuelve la signature base58 del refund.
export interface SolanaEscrowRefundGateway {
  refund(input: { remittanceId: string; sender: string }): Promise<{ refundTx: string }>;
}

// HU-SOL-20/AC-2: resuelve los remittanceId del sender desde el store durable server-side cuando el
// cliente los perdió (localStorage vacío / otro dispositivo). Devuelve [] si el mecanismo está
// apagado o no verificado — NUNCA lanza por "no hay nada".
export interface SolanaRemittanceIdResolver {
  listBySender(sender: string): Promise<string[]>;
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
    // WKH-211 (aditivo): binding HMAC del depositAddress no-custodial. El server lo usa SOLO en modo
    // deposit-flow (DEPOSIT_ATTESTATION_SECRET presente); en el path estático se ignora. Opcional a
    // propósito: en modo estático NO existe atestación (el guard estático es byte-idéntico, AC-5/AC-6).
    depositAttestation?: string;
  }): Promise<
    | { ok: true; txHash: string; valueMinor: number; to: string; from: string; attestation: string }
    | { ok: false; reason: SettlementFailureReason }
  >;
}

// ── Prepare del payout no-custodial (WKH-211) ────────────────────────────────
// Crea la orden TransFi (invoca al agente) y emite la DepositAttestation HMAC que ata el
// depositAddress a esta remesa, ANTES de que el cliente firme (Opción B, DT-1). El use-case firma
// `to = depositAddress` del result. Flag-gated: sólo se inyecta con NEXT_PUBLIC_EIP3009_ENABLED=true
// (acoplado a `settlement` — ver ConfirmAndSend). En demo NO existe ⇒ byte-idéntico (AC-5).
export interface PayoutPrepareResult {
  depositAddress: string; // 0x + 40 hex — el `to` no-custodial atestado
  attestation: string; // DepositAttestation HMAC (b64url.b64url)
  payoutId: string; // id de la orden TransFi creada
  provenance: string; // proveniencia (transfi / mock) — propagada al snapshot
}
export interface PayoutPrepareGateway {
  prepare(input: {
    remittanceId: string;
    quoteId: string;
    kycVerificationId: string;
    address: string;
    amountUsd: number;
    beneficiary: Beneficiary;
    idempotencyKey: string;
    popChallenge?: string;
    popSignature?: string;
  }): Promise<
    | { ok: true; result: PayoutPrepareResult }
    | { ok: false; reason: string }
  >;
}

// ── Wallet (DApp: el sender CONECTA su wallet = login, y firma la autorización EIP-3009) ──
// WKH-168 — remittanceId es REQUERIDO (CD-19: el nonce determinístico es la garantía anti-doble-pago
// a nivel CONTRATO; un remittanceId opcional permitiría caer en silencio al nonce random).
export interface WalletPort {
  connect(): Promise<string>; // conecta y devuelve la address (el "login")
  getAddress(): Promise<string | null>;
  // WKH-211 — 3er arg OPCIONAL `deposit`. En modo real (eip3009Enabled()) el `to` de la firma es el
  // `deposit.address` ATESTADO server-side (NUNCA el receiver estático): sin él, fail-loud (throw), NO
  // fail-open. Opcional en el tipo SOLO para preservar la firma demo (que lo ignora, AC-5).
  authorizePrincipal(
    quote: Quote,
    remittanceId: string,
    deposit?: { address: string; escrow?: SolanaEscrowDeposit }, // escrow? = ADITIVO (Solana, HU-SOL-5)
  ): Promise<{
    tx: string; // demo: firma simbólica (AC-5)
    eip3009?: { authorization: Eip3009Authorization; signature: string }; // SOLO en modo real
    solana?: SolanaPrincipalAuthorization; // ADITIVO (Solana, HU-SOL-5)
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
  | 'prepared'   // WKH-211: orden TransFi creada (depositAddress atestado), aún sin principal_in on-chain
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
  // NULL en las filas Solana: su identidad de red vive en network_id (CAIP-2), no en un chainId
  // numérico (CHECK remittance_settlements_vm_netid_chk, migración 20260721). Tiparlo `number` a secas
  // era una mentira en cuanto el ledger empezó a escribir chain_id NULL para Solana.
  chainId: number | null;
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

// HU-SOL-20/AC-2: proyección MÍNIMA de una fila del ledger para la recuperación del remittanceId. NO
// lleva PII, NO lleva value_minor, NO lleva address (el caller ya probó posesión de la suya).
export interface SenderRemittanceRef {
  remittanceId: string;
  status: SettlementLedgerStatus;
  createdAt: string;
}

export interface SettlementLedger {
  // prepare route (WKH-211/AC-8): registra la orden TransFi creada ANTES del principal_in, para dar
  // visibilidad de órdenes huérfanas (prepare ok + settle falla). El depositAddress va en
  // receiver_address (semánticamente ES el receiver no-custodial — SIN columna nueva). NUNCA PII (CD-7).
  // Una fila 'prepared' NUNCA es principal_in (CD-6): la cancelación real de TransFi es follow-up (DT-5).
  recordOrderPrepared(input: {
    remittanceId: string;
    quoteId: string;
    idempotencyKey: string;
    depositAddress: string; // → columna receiver_address (NO columna nueva)
    // chainId EVM. Con vm:'solana' el ledger lo IGNORA y escribe network_id (CAIP-2) + chain_id NULL:
    // Solana no tiene chainId numérico y el CHECK de la DB lo prohíbe (ver vmNetworkColumns).
    chainId: number;
    senderAddress: string;
    payoutId: string;
    vm: "evm" | "solana";
  }): Promise<void>;
  // settle route (AC-1): upsert por tx_hash (ON CONFLICT DO NOTHING), status principal_in.
  recordPrincipalIn(input: {
    remittanceId: string;
    quoteId: string;
    idempotencyKey: string;
    txHash: string;
    chainId: number; // EVM. Con vm:'solana' se ignora ⇒ network_id + chain_id NULL (ver arriba).
    senderAddress: string;
    receiverAddress: string;
    valueMinor: number;
    vm: "evm" | "solana";
  }): Promise<void>;
  // submit route (AC-3): UPDATE owner-scoped por (idempotencyKey, senderAddress).
  recordPayoutOutcome(input: {
    idempotencyKey: string;
    senderAddress: string;
    status: SettlementLedgerStatus;
    payoutId?: string | null;
    error?: string | null;
    vm: "evm" | "solana";
  }): Promise<void>;
  // reconcile (AC-4): no-terminales más viejas que olderThanIso. Global (admin) — sin owner filter.
  listStale(input: { olderThanIso: string; limit: number }): Promise<SettlementRecord[]>;
  // HU-SOL-20/AC-2: lectura OWNER-SCOPED para recuperar los remittanceId de un sender cuando el
  // cliente los perdió. El filtro .eq('sender_address', ...) es el guard REAL (el service key
  // bypassea RLS). NUNCA devuelve PII ni value_minor. NO filtra por `vm` — y sigue siendo correcto
  // después del fix de escritura: las filas escritas ANTES de ese fix dicen vm='evm' aunque sean
  // Solana, y son justo las que hay que recuperar ⇒ filtrar por vm devolvería CERO. Tampoco filtra por
  // status (las filas que interesan nacen 'prepared', que NO está en STALE_STATUSES).
  listRemittanceIdsBySender(input: {
    senderAddress: string;
    vm: "evm" | "solana";
    limit: number;
  }): Promise<SenderRemittanceRef[]>;
  // reconcile (AC-6): incrementa attempts + set status/last_error. Por id.
  markOutcome(input: {
    id: string;
    status: SettlementLedgerStatus;
    payoutId?: string | null;
    error?: string | null;
    incrementAttempt: boolean;
  }): Promise<void>;
  // webhook TransFi (WKH-210): UPDATE por payout_id, NO owner-scoped (el guard es el HMAC del endpoint,
  // CD-12). Solo aplica a filas NO-terminales (principal_in|submitted|forward_error): nunca reclasifica
  // manual_review ni degrada un estado terminal (DT-2b). 0-match ⇒ no-op sin error (AC-8).
  recordWebhookOutcome(input: {
    payoutId: string;
    status: SettlementLedgerStatus; // solo 'submitted' | 'settled' | 'failed' (post-mapeo)
    error?: string | null;          // enum estable, NUNCA el motivo crudo (DT-8/CD-3)
  }): Promise<void>;
}

// ── Utilidades inyectables (nada de Date.now/Math.random en el dominio) ──────
export interface Clock {
  nowIso(): string;
}
export interface IdGenerator {
  newId(): string;
}
