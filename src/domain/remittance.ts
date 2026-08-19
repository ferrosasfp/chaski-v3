// Domain — el agregado Remittance + su máquina de estados. Money-path: las invariantes de
// negocio viven ACÁ (no en la UI, no en el gateway). Puro, sin deps salvo Money.

import type { Money } from "./money";

/**
 * Todo método de desembolso que este sistema sabe LEER y transportar. No es la lista de lo que la
 * interfaz ofrece: eso es `OFFERED_PAYOUT_METHODS`, y hoy es más chico.
 *
 * ⚠️ `"yape"` y `"plin"` NO se sacan de acá aunque la primera pantalla ya no los ofrezca, y no es
 * por prolijidad: el estado de cada persona vive en el localStorage de su navegador, así que hay
 * remesas ya guardadas con `method: "yape"`. Borrar el valor del tipo no borra esos datos, sólo
 * deja de tipar la lectura, y el historial y el recibo pasan a nombrar mal una remesa que ya
 * ocurrió. El transporte (gateway A2A, `/api/payout/prepare`, el agente de desembolso) sigue
 * siendo agnóstico del método y por eso tampoco hay nada que desmantelar ahí.
 */
export type PayoutMethod = "yape" | "plin" | "bank_cci";

/**
 * Lo que la interfaz OFRECE hoy. Una sola entrada, y esa es la afirmación: Chaski deposita a
 * cuenta bancaria peruana (CCI) y no manda a Yape ni a Plin, porque no hay forma de pagar por
 * esos carriles. El día que exista, se agrega acá y la pantalla lo ofrece sin tocar nada más.
 *
 * Está separado de `PayoutMethod` para que las dos preguntas no compartan respuesta: "¿qué puedo
 * leer?" (todo lo que se guardó alguna vez) no es "¿qué puedo prometer?" (sólo lo que se entrega).
 */
export const OFFERED_PAYOUT_METHODS = ["bank_cci"] as const;
export type OfferedPayoutMethod = (typeof OFFERED_PAYOUT_METHODS)[number];

/** Dígitos de un CCI peruano: 3 de banco + 3 de oficina + 12 de cuenta + 2 de control. */
export const CCI_DIGITS = 20;

/** Los dígitos de un CCI tal como se escribió: el papel del banco lo imprime con espacios y
 *  guiones, y ninguno de los dos es parte del número. Fuente única del "qué es un CCI" junto con
 *  `isValidCci` (mismo rol que `isParseableIso` para las fechas: predicado puro, sin I/O). */
export function cciDigits(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** ¿`raw` es un CCI peruano? Chequea LARGO, no existencia: un CCI de 20 dígitos inventado pasa
 *  este control, y el banco lo rechaza después. Lo que sí ataja es lo que la pantalla vieja
 *  aceptaba sin chistar por ofrecer también Yape: un celular de 9 dígitos como destino de un
 *  depósito bancario. */
export function isValidCci(raw: string): boolean {
  return cciDigits(raw).length === CCI_DIGITS;
}

export interface Beneficiary {
  name: string;
  country: string; // "PE"
  method: PayoutMethod;
  /** CCI de 20 dígitos para `bank_cci`. Las remesas guardadas con `yape`/`plin` traen un celular. */
  destination: string;
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
  /**
   * De qué catálogo salió (display name del gateway). OPCIONAL: ausente ⟹ el gateway NO lo dijo.
   * Antes se rellenaba con `""` cuando faltaba, y eso afirmaba otra cosa: "el catálogo es vacío".
   * Un consumidor que muestre el campo escribiría un espacio en blanco como si fuera un dato, y uno
   * que compare contra "" trataría dos catálogos desconocidos como el mismo. La ausencia es el
   * único valor que dice la verdad, y es lo que promete el párrafo de arriba.
   */
  registry?: string;
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
  /** Quién cotizó (leg de FX). Ausente ⟹ el gateway no dijo a quién eligió de forma legible. */
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
  /** `null` ⇒ el veredicto vive en el SERVIDOR y este navegador no lo tiene (WKH-333). Es un estado
   *  normal desde que el identificador dejó de viajar por la red: quien saltea la verificación por
   *  una fila server-side nunca lo ve. Después de WKH-333 no queda ningún lector de producción — lo
   *  usaban `confirm-and-send.ts` (pre-check de autoridad y payload del prepare) y los dos se
   *  eliminaron. PROHIBIDO fabricar un valor para rellenarlo, por el mismo criterio que
   *  `provenanceColumn` en el ledger: un dato inventado por el que ESCRIBE la evidencia no es
   *  evidencia. Si hace falta el identificador, se lo pide el servidor a su propia fila. */
  verificationId: string | null;
  approved: boolean;
  payoutAllowed: boolean; realVerified: boolean; verifiedAt: string | null; // 🔴 LOS TRES EN ESTA LÍNEA, y no es estilo: insertar líneas acá corre las 22 citas `archivo:línea` que apuntan a este archivo (candado `citas-ancladas.test.ts`). ⚠️ WKH-233 — `payoutAllowed` NO ES EL `payoutAllowed` DEL AGENTE DE KYC, Y CONFUNDIRLOS ROMPE LA PANTALLA, NO EL PAGO (D-3, el footgun más caro de esa HU): acá vale LO MISMO QUE `approved` (antes `mapDiditDecision` hacía `payoutAllowed: approved`) y lo consumen el dominio (`applyKyc`, `canConfirm`), `ResumeKyc`, `StartKyc` y el fallback; meterle el del agente haría que con KYC simulado valiera `false` y el flujo no llegara ni a `kyc_passed`, o sea que la demo se rompería en la pantalla de identidad, lejos de donde se causó, y eso NO es lo que decidió DT-5'. · `realVerified` ES el juicio del agente ADOPTADO TAL CUAL (DT-5'): se puebla ÚNICAMENTE desde el `payoutAllowed` de su `GET /decision`, que por construcción significa aprobado ∧ hubo reclamo de identidad ∧ la identidad COINCIDE ∧ la proveniencia está en la allow-list de verificaciones REALES del agente. Reemplaza a la allow-list LOCAL que vivía en `flow-vm.ts` (`REAL_KYC_PROVENANCES`/`isKycDemo`), borrada a propósito: una lista local con el nombre del proveedor es exactamente lo que hay que cambiar al cambiar de proveedor. ⛔ PROHIBIDO derivarlo de `provenance`, de `approved` o de cualquier cosa que Chaski calcule: el agente decide, Chaski pregunta. · `verifiedAt` = cuándo ESTE servidor observó el desenlace terminal; `null` = no lo sabemos (una simulación no verificó nada y la rama que la pinta no muestra fecha). ⚠️ IMPRECISIÓN DECLARADA: `app/api/kyc/decision/route.ts` se pollea hasta 8 veces por verificación, así que dos polls devuelven dos valores; la FILA no se mueve (el CAS devuelve `already_recorded` y no toca `verified_at`), lo que varía dentro de esos ~20 s es lo que se muestra. Aceptable para una etiqueta de pantalla; ⛔ NO es evidencia y no se persiste como tal
  riskLevel: "low" | "medium" | "high";
  provenance: string;
  identity: PersistedIdentity | null; // reducida (sin PII cruda); por el camino del agente es SIEMPRE null (el agente no devuelve ningún dato de identidad)
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
 * ⚠️ LA AUTORIDAD ES EL AGENTE QUE RESUELVA LA CAPACIDAD DE FX, no este número. Cuál agente es no
 * lo decide este repo: se pide `remittance-fx-quote` y el gateway resuelve al ejecutar. Allá el mínimo es
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
   * firmó el principal. `null` = no lo sabemos (el gateway no dijo a quién eligió de forma legible).
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
