// Domain — el agregado Remittance + su máquina de estados. Money-path: las invariantes de
// negocio viven ACÁ (no en la UI, no en el gateway). Puro, sin deps salvo Money.

import type { Money } from "./money";

export type PayoutMethod = "yape" | "plin" | "bank_cci";

export interface Beneficiary {
  name: string;
  country: string; // "PE"
  method: PayoutMethod;
  destination: string; // celular (Yape/Plin) o CCI (banco)
}

/**
 * QUIÉN atendió un leg de la remesa. Dato de TRAZABILIDAD, no de negocio: nada del flujo lo lee
 * para decidir, y ninguna invariante depende de él. Existe porque el gateway elige el agente y
 * hasta ahora Chaski tiraba esa elección: una remesa no podía decir quién la cotizó ni quién dio
 * la dirección de depósito contra la que la persona firmó.
 *
 * Vive en el agregado (y no en un log del server) por dos razones concretas: se persiste con el
 * resto del snapshot, así que SOBREVIVE a una recarga; y está donde la UI ya lee, así que el
 * recibo puede mostrarlo sin una consulta nueva.
 *
 * Todo campo es lo que el gateway DIJO. Ninguno se rellena por defecto ni se deduce: si el
 * gateway no lo mandó, el campo queda ausente y el consumidor tiene que poder decir "no sé".
 */
export interface AgentRef {
  slug: string; // el slug CANÓNICO del agente que ejecutó el step
  registry: string; // de qué catálogo salió (display name del gateway)
  /** La capacidad por la que el GATEWAY lo eligió. Ausente ⟹ el llamador lo nombró. */
  capability?: string;
  /**
   * WKH-313: entró bajo el piso de reputación por el CARRIL DE ESTRENO, o sea SIN historial
   * liquidado. `true` es una afirmación del gateway, no una inferencia nuestra; ausente
   * significa "el gateway no lo marcó", que no es lo mismo que "tiene historial".
   */
  trial?: boolean;
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
  /** Quién cotizó (leg de FX). Ausente cuando el transporte no lo informa (rama punto-a-punto). */
  agent?: AgentRef;
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
  created: ["quoted"], // WKH-187: cotiza PRIMERO (quote antes del KYC)
  quoted: ["quoted", "kyc_pending", "confirmed"], // re-quote | iniciar KYC | confirmar (gate por state.kyc, DT-1b)
  kyc_pending: ["kyc_passed", "kyc_failed"], // (sin cambios)
  kyc_passed: ["quoted", "confirmed"], // WKH-187: re-quote post-KYC (conserva kyc) | confirmar
  kyc_failed: [], // (sin cambios)
  confirmed: ["principal_in", "payout_failed"], // (sin cambios)
  principal_in: ["payout_submitted", "payout_failed"], // (sin cambios)
  payout_submitted: ["settled", "payout_failed"], // (sin cambios)
  settled: [], // (sin cambios)
  payout_failed: ["refunded"], // (sin cambios)
  refunded: [], // (sin cambios)
};

export const TERMINAL_STATUSES: readonly RemittanceStatus[] = ["settled", "kyc_failed", "refunded"];

export function canTransition(from: RemittanceStatus, to: RemittanceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** ¿`value` parsea a un instante válido? Fuente ÚNICA del chequeo de parseabilidad de fechas
 *  (WKH-198, CD-5): dominio, validadores de shape (gateways/route) y wallet.ts lo reusan. */
export function isParseableIso(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * WKH-314 — monto mínimo enviable, en USD. Es EXPERIENCIA DE USO, no la protección.
 *
 * ⚠️ LA AUTORIDAD ES EL AGENTE (`remit-corridor-fx`), no este número. Allá el mínimo es
 * configurable (`FX_MIN_SEND_USD`) y está atado a la comisión, de modo que no pueda existir
 * una comisión que lo anule. Acá vive una copia para que la interfaz no habilite un envío que
 * el agente va a rechazar: sin esto, la persona escribía 40 centavos, leía "tu familia recibe
 * S/ 0.00" y el botón la dejaba seguir hasta depositar dólares reales a cambio de nada.
 *
 * Si los dos números divergen, gana el agente y la degradación es benigna: la interfaz deja
 * pasar, el agente corta con `fx_amount_below_minimum` y la persona ve un error en vez de una
 * promesa de cero. Nunca al revés — por eso la copia es aceptable y no hay que "sincronizarla"
 * leyendo config del agente desde el browser.
 */
export const MIN_SEND_USD = 5;

// A5 (AC-1/AC-2): tolerancias de consistencia de `receive` vs (send − fee) × rate.
const RECEIVE_TOL_ABS_PEN = 0.02; // 2 centavos — absorbe redondeo a 2 decimales de PEN
const RECEIVE_TOL_REL = 0.01; // 1%

/** Invariante money-path PURA (CD-3, sin I/O): `receive` debe ser consistente con el propio
 * `send`/`feeUsd`/`rate` del quote. Espeja netUsd = max(0, send − fee) del gateway. Es un límite
 * de sanidad defensivo (caza tampering grueso: receive inflado 2× / degradado a la mitad), NO una
 * auditoría de precisión ni detecta un `rate` manipulado (otro vector, fuera de scope).
 *
 * ⚠️ WKH-314 — NO INTENTES QUE ESTO ATAJE UNA COTIZACIÓN QUE ENTREGA CERO. No puede, y no por
 * estar mal escrito: REPLICA la fórmula que vigila, `max(0, ...)` incluido. Para un envío de 40
 * centavos con una comisión de 0.50, su `expected` también da cero y COINCIDE con el `receive`
 * de cero — el guard no falla, está de acuerdo. Un control que reimplementa la operación que
 * vigila sólo detecta discrepancias de TRANSPORTE (que alguien haya tocado el número en el
 * medio), nunca un error que está DENTRO de la fórmula.
 *
 * El mínimo es una regla de POLÍTICA independiente (`MIN_SEND_USD` acá, `FX_MIN_SEND_USD` en el
 * agente) justamente para no meter el número en los dos lados de esta comparación, donde
 * divergiría al primer cambio. Si "arreglás" esta función para que atrape el cero, vas a estar
 * escribiendo la política dos veces. */
function assertReceiveConsistent(quote: Quote): void {
  const expected = Math.max(0, quote.send.major - quote.feeUsd.major) * quote.rate;
  const allowedDelta = Math.max(RECEIVE_TOL_ABS_PEN, expected * RECEIVE_TOL_REL);
  if (Math.abs(quote.receive.major - expected) > allowedDelta) {
    throw new Error("quote_receive_mismatch");
  }
}

/** Reconciliación money-path PURA (WKH-186/AC-6, CD-6): valida que el PEN ENTREGADO por el partner
 * (`delivered`) es consistente con el `receive` lockeado del quote (`expected`), dentro de la MISMA
 * tolerancia que `assertReceiveConsistent` (sin tolerancia nueva). Se aplica ANTES de `markSettled`:
 * mismatch → payout_failed razón `payout_amount_mismatch`. Currency distinta = error de programación. */
export function isDeliveredWithinReceiveTolerance(expected: Money, delivered: Money): boolean {
  if (expected.currency !== delivered.currency) throw new Error("reconcile_currency_mismatch");
  const e = expected.major;
  const allowedDelta = Math.max(RECEIVE_TOL_ABS_PEN, e * RECEIVE_TOL_REL); // MISMAS constantes (CD-6)
  return Math.abs(delivered.major - e) <= allowedDelta;
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
  payoutProvenance: string | null; // proveniencia del payout (real vs mock) — propagada desde PayoutRecord (WKH-200)
  /**
   * Quién atendió el leg de PAYOUT, o sea quién dio el `depositAddress` contra el que la persona
   * firmó el principal. `null` = no lo sabemos (rama punto-a-punto, o el gateway no lo informó).
   * NUNCA se rellena con un valor plausible: no saberlo es un estado legítimo y se dice así.
   */
  payoutAgent: AgentRef | null;
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
      payoutProvenance: null,
      payoutAgent: null,
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
  markPayoutSubmitted(
    payoutId: string,
    now: string,
    payoutProvenance?: string,
    payoutAgent?: AgentRef,
  ): void {
    // patch condicional (WKH-200): el campo SOLO aparece cuando el arg no es undefined → un backfill
    // parcial no pisa el valor previo. Un payoutProvenance seteado acá persiste al markSettled vía to().
    // `payoutAgent` sigue la MISMA regla y por el mismo motivo: `undefined` (el caller no sabe quién
    // atendió) no puede borrar una identidad ya registrada.
    const patch: Partial<RemittanceState> = {
      payoutId,
      ...(payoutProvenance !== undefined ? { payoutProvenance } : {}),
      ...(payoutAgent !== undefined ? { payoutAgent } : {}),
    };
    this.to("payout_submitted", now, patch);
  }
  markSettled(payoutTx: string, deliveredPen: Money | null, now: string, payoutProvenance?: string): void {
    const patch: Partial<RemittanceState> = {
      payoutTx,
      deliveredPen,
      ...(payoutProvenance !== undefined ? { payoutProvenance } : {}),
    };
    this.to("settled", now, patch);
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
    if (!isParseableIso(quote.expiresAt) || !isParseableIso(nowIso)) return true; // fail-closed (CD-1)
    return new Date(quote.expiresAt).getTime() <= new Date(nowIso).getTime();
  }
}
