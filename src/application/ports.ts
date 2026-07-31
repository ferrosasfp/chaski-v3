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
// El `reason` es un enum estable de la FSM — NUNCA PII (CD-5).
//
// ⚠️ `refundTx: string | null` — el null NO es un detalle de tipos, es la corrección del bug más caro
// de este archivo. El adapter default (LedgerRefundGateway) es LEDGER-ONLY: no revierte ningún
// movimiento on-chain. Antes devolvía igual un string SINTÉTICO (`refund-ledger-…`), el use-case lo
// escribía como `refundTx` y la remesa saltaba a `refunded` — que es TERMINAL. Resultado: la persona
// leía una "referencia de reembolso" inventada mientras sus USDC seguían en el vault del escrow, y el
// botón de recuperar (que exige refundTx == null) no aparecía nunca más.
//   null  ⇒ NO se revirtió nada: no hay comprobante que mostrar y la remesa NO puede ir a `refunded`.
//   string ⇒ un movimiento REAL con su tx. Sólo entonces se escribe el estado terminal.
// Un adapter que devuelva un identificador fabricado vuelve a instalar la mentira: no lo hagas.
export interface RefundGateway {
  creditBack(input: {
    remittanceId: string;
    amountUsd: Money;
    reason: string;
  }): Promise<{ refundTx: string | null }>;
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

// ── Settlement del principal ─────────────────────────────────────────────────
// Residual NO cerrado por esta HU: si el browser se cierra entre el settle on-chain y el estado
// terminal, la remesa queda HUÉRFANA con el principal REALMENTE adentro. No hay reconciliación
// automática; la evidencia server-side para reconciliar a mano vive en el SettlementLedger (WKH-207).

// ── HU-SOL-5 (WKH-207*) — WalletPort: el envelope que firma para el escrow ──────
/** Datos del escrow que el CALLER (HU-SOL-13) resuelve y pasa a la wallet Solana. base58. */
export interface SolanaEscrowDeposit {
  beneficiary: string; // Pubkey base58 — destino de la remesa (release). Resuelto por HU-SOL-13.
  authority: string; // Pubkey base58 — quien puede release/refund. Resuelto por HU-SOL-13.
  mint?: string; // opcional: override del mint; default resolveSolanaUsdcMint() (CD-SDD-4).
}

/** Retorno de authorizePrincipal para el depósito en el escrow Anchor (envelope Solana). */
export interface SolanaPrincipalAuthorization {
  vm: "solana";
  partialSignedTx: string; // tx legacy serializada base64, partial-signed (feePayer=facilitator, firma wallet-only)
  reference: string; // Pubkey base58 de la reference (trazabilidad)
}

// ── HU-SOL-13 (WKH-216) — puertos del money-path Solana no-custodial (escrow Anchor) ──────────────
// El use-case recibe `solana` como parámetro OPCIONAL: el container lo inyecta SOLO con el flag de
// settlement encendido y los envs validados. Sin inyección (modo demo) estas interfaces no participan
// y el use-case fail-closea explícitamente (DT-8) en vez de seguir de largo.
export type SolanaSettlementFailureReason =
  | "solana_settle_unavailable" // red caída / facilitator no configurado
  | "solana_settle_rejected" // CR-1 del deposit rechazó (422 SPONSOR_REJECTED)
  | "solana_settle_rate_limited" // 429
  | "solana_settle_broadcast_failed" // 409/502 (blockhash expirado / broadcast falló)
  | "solana_settle_unverified"; // shape de respuesta inválido

// Broadcast del `deposit` Solana vía la ruta server-only /api/settle/solana-sponsor → facilitator
// (HU-SOL-14). La signature de respuesta es base58: validarla con una regex hexadecimal la rechazaría
// siempre (CD-13). Corre en el CLIENTE (el browser jamás llama al facilitator directo).
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

// Respuesta de PREGUNTARLE a la cadena si el refund entró. TRES valores, no dos, y a propósito:
// "el RPC aceptó la transacción" no es "los USDC volvieron". Entre que la persona aprieta el botón y
// que la tx entra en un bloque hay una firma en la wallet que puede tardar un minuto, y un blockhash
// que puede vencer antes. Un boolean se comería justamente el valor del medio.
//   · "confirmed" — la cadena dice que el escrow quedó Refunded. Es lo ÚNICO que autoriza a afirmar
//     que la plata volvió, y lo único que puede escribir el estado terminal.
//   · "pending"   — pudimos preguntar y la respuesta es "todavía no". Ni sí ni no: la tx puede entrar
//     en el próximo bloque o puede no entrar nunca. La persona tiene que poder reintentar.
//   · "unknown"   — NO pudimos preguntar (RPC caído, timeout, cuenta ilegible). Indeterminación de
//     medición: no dice nada sobre dónde está la plata, sólo sobre nosotros.
// Un fracaso MEDIDO (la tx entró y el programa revirtió) NO es ninguno de estos tres: es un throw.
export type EscrowRefundConfirmation = "confirmed" | "pending" | "unknown";

// Refund trustless post-deadline (AC-6/CD-10): delega en wallet.refundEscrow (sender firma + sender
// broadcastea, SIN facilitator ni release-authority). Devuelve la signature base58 del refund JUNTO
// con qué sabemos de ella: la signature sola era una afirmación de que la plata volvió que nadie
// había verificado.
export interface SolanaEscrowRefundResult {
  refundTx: string; // base58 — la tx que el RPC aceptó (existe incluso sin confirmar)
  confirmation: EscrowRefundConfirmation;
}
export interface SolanaEscrowRefundGateway {
  refund(input: { remittanceId: string; sender: string }): Promise<SolanaEscrowRefundResult>;
}

// El MISMO criterio de tres valores que EscrowRefundConfirmation, aplicado a la otra punta del
// money-path: ¿el principal del sender entró al vault del escrow? Es la pregunta que el use-case se
// hacía con un boolean, y con un boolean sólo podía contestar "no" cuando la verdad era "no pude
// preguntar" — y sobre ese "no" escribía un reembolso que nunca ocurrió.
//   · "deposited"     — la cadena muestra la cuenta del escrow. La plata está adentro: es recuperable.
//   · "not_deposited" — sabemos que NO entró (el intento murió ANTES del broadcast, o la cadena probó
//     que la tx ya no puede entrar). No hay nada que recuperar ni que reembolsar.
//   · "unknown"       — no pudimos averiguarlo. NO se colapsa en ninguno de los otros dos: la remesa
//     queda recuperable y a la persona se le dice, con esas palabras, que todavía no sabemos.
export type PrincipalDepositState = "deposited" | "not_deposited" | "unknown";

// Le pregunta A LA CADENA (no a un agente) si el depósito del principal está en el vault del escrow.
// La verdad sobre el dinero vive en la cadena; los agentes son reemplazables y no pueden ser fuente de
// esta respuesta. Deriva la PDA `escrow_state` de (sender, remittanceId): sin dependencias de ningún
// slug, URL ni contrato de agente.
export interface SolanaEscrowDepositProbe {
  probeDeposit(input: { remittanceId: string; sender: string }): Promise<PrincipalDepositState>;
}

// HU-SOL-20/AC-2: resuelve los remittanceId del sender desde el store durable server-side cuando el
// cliente los perdió (localStorage vacío / otro dispositivo). Devuelve [] si el mecanismo está
// apagado o no verificado — NUNCA lanza por "no hay nada".
export interface SolanaRemittanceIdResolver {
  listBySender(sender: string): Promise<string[]>;
}

// ── Wallet (DApp: el sender CONECTA su wallet = login, y firma el depósito en el escrow) ──
// remittanceId es REQUERIDO (CD-19: es lo que ata la firma a ESTA remesa; opcional permitiría caer
// en silencio a un identificador random y perder la garantía anti-doble-pago).
export interface WalletPort {
  connect(): Promise<string>; // conecta y devuelve la address (el "login")
  getAddress(): Promise<string | null>;
  // WKH-211 — 3er arg OPCIONAL `deposit`. En modo real el destino de la firma es el `deposit.address`
  // ATESTADO server-side (NUNCA un receiver estático): sin él, fail-loud (throw), NO fail-open.
  // Opcional en el tipo SOLO para preservar la firma demo (que lo ignora, AC-5).
  authorizePrincipal(
    quote: Quote,
    remittanceId: string,
    deposit?: { address: string; escrow?: SolanaEscrowDeposit }, // escrow? = ADITIVO (Solana, HU-SOL-5)
  ): Promise<{
    tx: string; // demo: firma simbólica (AC-5)
    solana?: SolanaPrincipalAuthorization; // el envelope real (HU-SOL-5)
  }>;
  // WKH-206: firma un mensaje arbitrario con la key de la wallet conectada. Lo usa el PopSigner para
  // probar posesión de `address`. En demo devuelve una firma simbólica (AC-5).
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
  // STRING, no `number`: es un uint256 (numeric(78,0)) y `number` sólo representa enteros exactos
  // hasta 2^53-1. El `::text` del SELECT (CD-12, WKH-196) existe para que los dígitos crucen el
  // transporte intactos; tiparlo `number` obligaba a un `Number(...)` que volvía a redondear justo
  // lo que el cast había salvado ("90071992547409910" → 90071992547409900).
  // Por qué `string` y no `bigint`:
  //   · NINGÚN consumidor hace aritmética con este campo (es evidencia del money-path: se persiste,
  //     se lee y se muestra). Sin sitio de conversión no hay dónde recolar la pérdida.
  //   · `bigint` revienta en JSON.stringify (TypeError) y este record vive en rutas admin que
  //     serializan/loguean; `string` es JSON-safe y ya es la representación que se ESCRIBE
  //     (value_minor: String(...)), así que el round-trip es comparable carácter por carácter.
  // REGLA: si algún día hace falta operar con él, usar `BigInt(rec.valueMinor)` — exacto y que tira
  // ante basura. PROHIBIDO `Number(rec.valueMinor)`: ese es exactamente el bug de WKH-196.
  valueMinor: string; // dígitos decimales exactos desde value_minor::text (CD-12, WKH-196)
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
  //
  // CD-6 — REGLA NUEVA (WKH-213, invierte la anterior). Antes decía: "una fila 'prepared' NUNCA es
  // principal_in". Hoy dice: **una fila 'prepared' es la MISMA fila que el settle completa a
  // 'principal_in'** (mismo idempotency_key, mismo sender). El upsert de recordPrincipalIn se re-keyeó
  // a idempotency_key con MERGE (antes: onConflict tx_hash + ignoreDuplicates).
  // Por qué cambió: la tabla tiene DOS índices únicos (tx_hash e idempotency_key) y `ON CONFLICT` sólo
  // resuelve el que se declara. Con la fila 'prepared' ya ocupando la MISMA idempotency_key
  // (`${remittanceId}:${quoteId}` en las dos escrituras), el INSERT del settle violaba el OTRO índice →
  // 23505 → excepción tragada por el best-effort de la route ⇒ en modo real NINGUNA fila llegaba nunca
  // a 'principal_in', y listStale (que sólo escanea principal_in|submitted|forward_error) escaneaba un
  // conjunto estructuralmente VACÍO. La regla vieja no era una salvaguarda: era el bug.
  // Lo que la regla vieja protegía sigue protegido, y de forma MÁS fuerte: el ascenso a 'principal_in'
  // NO lo hace el reconcile ni una inferencia — lo hace SÓLO el settle con evidencia VERIFICADA
  // on-chain (CD-13), owner-scoped, y únicamente desde 'prepared' (jamás degrada un estado ya avanzado).
  // La cancelación real de la orden TransFi huérfana sigue siendo follow-up (DT-5).
  recordOrderPrepared(input: {
    remittanceId: string;
    quoteId: string;
    idempotencyKey: string;
    depositAddress: string; // → columna receiver_address (NO columna nueva)
    // chainId numérico, heredado del schema. Con vm:'solana' el ledger lo IGNORA y escribe network_id (CAIP-2) + chain_id NULL:
    // Solana no tiene chainId numérico y el CHECK de la DB lo prohíbe (ver vmNetworkColumns).
    chainId: number;
    senderAddress: string;
    payoutId: string;
    vm: "evm" | "solana";
  }): Promise<void>;
  // settle route (AC-1): COMPLETA la fila 'prepared' de esta remesa a 'principal_in' con la evidencia
  // verificada on-chain (tx_hash + value_minor reales). Clave: idempotency_key (NO tx_hash — ver CD-6
  // arriba). Contrato exacto (WKH-213), en orden:
  //   1. UPDATE owner-scoped de la fila (idempotency_key, sender_address) que está en 'prepared'
  //      ⇒ status='principal_in' + hash/monto reales. payout_id NO se toca (el patch no lo incluye) ⇒
  //      el id de la orden TransFi escrito por prepare sobrevive.
  //   2. Si ya avanzó (el webhook del proveedor llegó ANTES que el settle): NO se degrada el status;
  //      se rellena SÓLO la evidencia (hash/monto) si el tx_hash sigue siendo el placeholder de prepare.
  //   3. Si la fila ya tiene evidencia real (settle reintentado) o es de otro owner: NO-OP.
  //   4. Si no existe fila (ledger apagado durante prepare / modo estático sin prepare): INSERT.
  // Idempotente: re-ejecutarlo es inocuo. El índice único de tx_hash NO se relaja: dos remesas
  // distintas con el mismo hash violan uq_remit_settle_txhash y esta función TIRA (best-effort en la
  // route ⇒ log [ALERT], no rompe el money-path).
  recordPrincipalIn(input: {
    remittanceId: string;
    quoteId: string;
    idempotencyKey: string;
    txHash: string;
    chainId: number; // heredado del schema. Con vm:'solana' se ignora ⇒ network_id + chain_id NULL (ver arriba).
    senderAddress: string;
    receiverAddress: string;
    valueMinor: number;
    vm: "evm" | "solana";
  }): Promise<void>;
  // settle Solana (WKH-213/R3): ata la signature base58 VERIFICADA on-chain por el facilitator a la
  // fila 'prepared' de esta remesa ⇒ 'principal_in'. Método PROPIO (no recordPrincipalIn) porque el
  // settle tiene OTROS datos verificados disponibles: /solana/sponsor devuelve la signature y
  // NADA MÁS — no hay monto ni receiver verificados server-side (no existe verificador on-chain Solana
  // en este repo). Escribir el monto que declara el cliente violaría CD-13, así que value_minor
  // conserva el de la fila 'prepared'; el resto (quote_id, receiver, payout_id) ya está ahí.
  // OWNER-SCOPED por sender_address (base58 canónico, CD-9/CD-10). NO inserta si no hay fila
  // preparada: sin ella no hay quote_id/value_minor honestos para las columnas NOT NULL.
  recordSolanaPrincipalIn(input: {
    remittanceId: string;
    senderAddress: string; // base58 del depositor (canonicalizeAddress(...,'solana'))
    signature: string; // base58 — el equivalente Solana del txHash
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
  // reconcile (WKH-213): órdenes que quedaron en 'prepared' (la orden del proveedor se creó y el
  // settle NUNCA aterrizó). Global (admin). `total` es el conteo EXACTO de coincidencias — NO
  // records.length: el consumidor necesita distinguir "no hay nada" de "hay más de los que entran en
  // la página" (records está capado por `limit`). El umbral se mide contra created_at, NO updated_at:
  // una fila 'prepared' no vuelve a tocarse nunca, así que updated_at nunca envejece respecto de ella.
  // TIRA ante cualquier fallo de la consulta (incluido un count ausente): devolver una lista vacía
  // por error se lee igual que "no hay huérfanas", que es la peor mentira posible.
  listPreparedOrphans(input: {
    olderThanIso: string;
    limit: number;
  }): Promise<{ total: number; records: SettlementRecord[] }>;
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
  // CD-12). Solo aplica a filas NO-terminales: nunca reclasifica manual_review ni degrada un estado
  // terminal (DT-2b). 0-match ⇒ no-op sin error (AC-8).
  // WKH-213/R1: el conjunto no-terminal INCLUYE 'prepared'. Antes era exactamente STALE_STATUSES
  // (principal_in|submitted|forward_error), así que el proveedor podía avisar "pagado" sobre una orden
  // cuyo settle nunca aterrizó y la fila se quedaba en 'prepared' para siempre. 'prepared' es
  // no-terminal por definición ⇒ pertenece al conjunto. NO se agrega a STALE_STATUSES (ese conjunto es
  // el del reconcile/listStale: una 'prepared' no se re-procesa ni existe en el índice parcial de la DB).
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
