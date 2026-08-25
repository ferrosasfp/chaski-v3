// Application — PORTS. Las interfaces que los use-cases REQUIEREN. La regla de dependencia
// apunta hacia adentro: los use-cases dependen de estos ports; la infra los IMPLEMENTA.
// Reemplazar fallback ↔ real (o gateway a2a ↔ otro) = cambiar el adapter, no el use-case.

import type { Money } from "../domain/money";
import type {
  AgentRef,
  Beneficiary,
  KycVerification,
  PayoutMethod,
  Quote,
  Remittance,
  RemittanceState,
} from "../domain/remittance";

// ── Quote (capacidad `remittance-fx-quote`) ──────────────────────────────────
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
  // WKH-333/R-1 — prueba de posesión de la billetera. OPCIONALES EN EL TIPO **Y** EN LA ROUTE, y eso
  // último es un arreglo, no una concesión: acá decía "OBLIGATORIAS EN LA ROUTE … bloque S5 → 403", y
  // ese 403 dejaba a quien rechazaba la firma SIN PODER INICIAR EL KYC, contra CD-15/AC-13
  // (AR/BLQ-ALTO-2). Lo que la prueba decide no es SI se crea la sesión, sino si la sesión queda
  // ATADA a una dirección: sin prueba se crea sin atar, y una sesión sin atar no produce fila del
  // veredicto (`persistKycVerdict` corta con `d.payoutAllowed !== true`). NO es fail-open: omitirlas
  // no le da al atacante ninguna capacidad —lo que el atacante querría es atar la sesión a la
  // dirección de otro, y eso exige la firma de esa billetera—, y el demo (sin DIDIT_API_KEY) sale con
  // 501 antes de todo esto y sigue byte-idéntico.
  //
  // 🔴 POR QUÉ EXISTEN. Sin esto, `vendor_data` salía del BODY: cualquiera podía crear una sesión de
  // verificación atada a la dirección de OTRA persona y aprobarla con su propio documento. Didit
  // ecoa esa dirección, y `app/api/kyc/decision/route.ts` escribía la fila del veredicto A NOMBRE DE
  // LA VÍCTIMA. Con el veredicto server-side esa fila ES la fuente de autoridad del pago, así que la
  // víctima pasaría a pagar bajo la identidad de otro sin forma de notarlo.
  //
  // Es la MISMA prueba que `ConnectWallet` ya obtuvo para leer el veredicto (viaja en
  // `KycVerdictEnsureResult.proof`) ⇒ CERO prompts de billetera nuevos.
  popChallenge?: string;
  popSignature?: string;
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
  sessionToken?: string; carril: "agente" | "directo"; // LOS DOS EN ESTA LÍNEA: insertar líneas acá corre las 28 citas `archivo:línea` que apuntan a este archivo (candado `citas-ancladas.test.ts`). `sessionToken` = authToken HMAC persistido para autorizar el GET /decision (WKH-179). 🔴 `carril` (WKH-233/DT-3a) = CONTRA QUIÉN se creó la sesión: `"agente"` (el agente de KYC, el camino de hoy en adelante) o `"directo"` (el proveedor, como nacieron todos los pendientes anteriores a la HU). La lectura al volver del redirect se enruta por ESTE valor y NUNCA por el valor actual de una env: un pendiente en vuelo tiene que resolverse por el camino con el que nació, o quitar `KYC_AGENT_BASE_URL` (que es el rollback de la HU) cortaría a quien está a mitad del flujo. Ver `ResumeKyc`. ⛔ REQUERIDO, NO OPCIONAL: con un `?`, borrarlo en un call site COMPILA, que es la lección ya escrita de `container.ts` —un colaborador que desaparece sin que nada se ponga rojo—. Un pendiente leído de `localStorage` sin el campo (los de antes de la HU) lo normaliza el store a `"directo"`, que es el lado fail-closed: se dice "no puedo retomar esto" en vez de fabricar un veredicto sobre esa persona
}
export interface KycPendingStore {
  save(p: KycPending): Promise<void>;
  get(): Promise<KycPending | null>;
  clear(): Promise<void>;
}

// ── Payout / value-delivery (capacidad `remittance-payout` + partner) ────────
export interface PayoutSubmit {
  quoteId: string;
  amountUsd: number;
  expectedReceivePen: Money; // PEN lockeado que el usuario confirmó (M3/AC-6); NO reemplaza amountUsd
  beneficiary: Beneficiary;
  // 🔴 WKH-333 — `kycVerificationId` SE ELIMINÓ de acá también. MEDIDO: `PayoutSubmit` no tiene un
  // solo call-site de producción (`command grep -rn "\.submit(" src/ app/` sólo devuelve tests) y
  // `app/api/a2a/payout/submit/route.ts` no existe. Se saca igual, y no por prolijidad: mientras el
  // campo esté declarado, el día que alguien reviva este puerto lo va a rellenar desde el cliente
  // —que es exactamente el token al portador que esta HU sacó de la red— y `tsc` no va a decir nada.
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

// ── Lectura del desenlace de un payout (WKH-337) ──────────────────────────────
// CUATRO valores, y son cuatro a propósito: misma familia que `RemittanceIdLookup`, `:467` y
// `SolanaPrincipalInOutcome`, `:721`. "No pude preguntar" NO es "no pasó", y ninguno de los cuatro
// colapsa en otro sin perder la información que decide si se puede afirmar un desenlace.
export type PayoutOutcomeUnknownReason =
  | "no_row" // no hay fila para (payout_id, sender): el ledger estaba apagado al preparar,
  //   o la escritura best-effort de recordOrderPrepared falló (residuo WKH-330)
  | "not_terminal" // la fila existe y su status NO es settled/failed: el proveedor no avisó todavía
  | "provenance_not_real" // la fila existe, pero su payout_provenance NO está en REAL_PAYOUT_PROVENANCES
  //   (INCLUYE `null` = NO CONSTA, que es el caso de toda fila vieja)
  | "conflicting_rows"; // 2+ filas del mismo payout_id con desenlaces distintos ⇒ no sabemos cuál vale

export type PayoutOutcomeLookup =
  | { readonly outcome: "known"; readonly status: "settled" | "failed"; readonly provenance: string }
  | { readonly outcome: "unknown"; readonly reason: PayoutOutcomeUnknownReason };

// ── Prueba de posesión OBSERVADA (WKH-337) ───────────────────────────────────
// 🔴 `PopProofReader` NO TIENE `prove`, Y ESO ES EL PUNTO. El gateway de tracking corre dentro de un
// setInterval de 1,5 s (`src/presentation/flow.tsx:661`): si pudiera pedir una firma, pediría un popup
// de billetera cada 1,5 s (600 s ÷ 1,5 s = 400 firmas por sesión de 10 min). Que no pueda no depende de
// que nadie lo llame — depende de que el método NO EXISTA en el tipo, así que `tsc` lo impide. Es el
// mismo patrón estructural que el campo `garantia` obligatorio de WKH-338: el invariante como forma del
// tipo, no como disciplina del que escribe.
// ⛔ PROHIBIDO agregarle `prove` a esta interfaz "para simplificar": eso reintroduce el defecto entero.
export interface PopProof {
  readonly challenge: string;
  readonly signature: string;
}
export interface PopProofReader {
  peek(address: string): PopProof | null; // null si no hay, o si la que hay VENCIÓ
}
export interface PopProofRecorder {
  record(address: string, proof: PopProof): void;
}

// ── Refund-on-failure (WKH-186) ──────────────────────────────────────────────
// Se dispara tras CADA markPayoutFailed (cierra el gap de remesas huérfanas en payout_failed).
// El `reason` es un enum estable de la FSM, NUNCA PII (CD-5).
//
// ⚠️ `refundTx: string | null`: el null NO es un detalle de tipos, es la corrección del bug más caro
// de este archivo. El adapter default (LedgerRefundGateway) es LEDGER-ONLY: no revierte ningún
// movimiento on-chain. Antes devolvía igual un string SINTÉTICO (`refund-ledger-…`), el use-case lo
// escribía como `refundTx` y la remesa saltaba a `refunded`, que es TERMINAL. Resultado: la persona
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
  // address es NO-opcional (CD-A3). El use-case pasaba `getAddress() ?? ""`, y ese `""` terminaba
  // reventando la canonicalización del otro lado y volviendo como 502 "el KYC falló". Ahora corta
  // antes con `wallet_address_unavailable` (confirm-and-send.ts) y acá SIEMPRE llega una address real.
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
  // SDD 037 — firma ed25519 (base58, 64 bytes) del mensaje canónico de patrocinio. Es el SEGUNDO
  // prompt de billetera: la persona firma un texto legible que dice qué autoriza, y el facilitator
  // reconstruye ese texto desde la transacción. Obligatorio: sin él el facilitator responde 403.
  popSignature: string;
}

// ── HU-SOL-13 (WKH-216) — puertos del money-path Solana no-custodial (escrow Anchor) ──────────────
// El use-case recibe `solana` como parámetro OPCIONAL: el container lo inyecta SOLO con el flag de
// settlement encendido y los envs validados. Sin inyección (modo demo) estas interfaces no participan
// y el use-case fail-closea explícitamente (DT-8) en vez de seguir de largo.
export type SolanaSettlementFailureReason =
  // Bucket INDETERMINADO. Cubre la red caída del cliente, el facilitator no configurado, cualquier
  // 5xx que no sepamos ubicar Y el timeout de 15 s del `fetch` al facilitator
  // (app/api/settle/solana-sponsor/route.ts:156-163). Ese último es el que le fija el significado a
  // todo el enum: es POSTERIOR al broadcast, así que de acá NO se puede afirmar que la plata no se
  // movió. Se le pregunta a la cadena.
  | "solana_settle_unavailable"
  // Nuestra propia route no pudo CONSULTAR el registro de direcciones preparadas y cortó ahí mismo
  // (503 del bloque S3.5, route.ts:126-133). Reason PROPIO, y no `unavailable`, aunque las dos
  // frases humanas empiecen igual ("el servicio no está"): lo que los separa no es la causa, es
  // DÓNDE se cortó. Éste sale ANTES del `fetch` al facilitator, en una rama que no forwardea, no
  // gasta rate-limit y no escribe una fila; o sea que "la transacción no se transmitió" se lee del
  // orden de la route, no se supone. `unavailable` incluye el timeout de ESE MISMO fetch, que es
  // posterior y donde el depósito pudo haber entrado perfectamente.
  //
  // ⚠️ POR ESO NO PUEDEN COMPARTIR ENUM. Con uno solo hay que elegir un único trato para los dos, y
  // las dos elecciones son malas: tratarlos como indeterminados hace que la app diga "no sabemos si
  // te cobramos" de algo que sí sabe, y tratarlos como probados hace que afirme "no se movió nada"
  // sobre una transacción que pudo haber salido. La segunda es la peligrosa, y es la que un enum
  // compartido metido en SETTLE_REASONS_BEFORE_BROADCAST produciría.
  | "solana_settle_ledger_unavailable"
  | "solana_settle_rejected" // CR-1 del deposit rechazó (422 SPONSOR_REJECTED)
  | "solana_settle_rate_limited" // 429
  | "solana_settle_broadcast_failed" // 409/502 (blockhash expirado / broadcast falló)
  // El servidor cortó el depósito porque la tx paga a una dirección que NO registró al preparar
  // (S3.5 del settle). Reason PROPIO y no "rejected": el facilitador no la rechazó, no llegó a verla.
  // Es el único desenlace de esta lista que describe un ataque en curso y no una falla de infra.
  | "solana_settle_beneficiary_mismatch"
  // El servidor no pudo COMPARAR el destino: no hay dirección registrada para esta remesa/sender, o
  // de la tx no se puede leer ninguna. No afirma que el destino esté mal, afirma que no se comprobó.
  | "solana_settle_beneficiary_unconfirmed"
  // SDD 037 — el facilitator NO reconoció a quien firma como el dueño de la transacción, o el
  // mensaje que la persona firmó no describe esta transacción (403). Es un RECHAZO, no una
  // indisponibilidad: reintentar con la misma tx da lo mismo MIENTRAS LA CONFIGURACIÓN DEL
  // FACILITATOR NO CAMBIE. Por eso no cae en `unavailable`: el input que separa a los dos es una
  // red caída (reintentar puede andar) contra una firma que no autoriza.
  //
  // ⚠️ EL "NO CAMBIE" NO ES UN ADORNO, y hay una rama concreta que lo falsea (AR MNR-2): el
  // facilitator devuelve ESTE MISMO 403 y ESTE MISMO enum cuando le falta la env
  // `SOLANA_SPONSOR_NETWORK_ID` (marcador `NETWORK_ID_UNSET` en su log). Esa env es una acción del
  // founder que puede llegar DESPUÉS del deploy, y en esa ventana reintentar más tarde SÍ anda. O
  // sea: un 403 acá no prueba que la billetera de la persona esté mal, puede ser el servidor mal
  // configurado. Del lado del cliente los dos casos son indistinguibles A PROPÓSITO (CD-12,
  // no-oracle); quien los separa es el marcador `guard` del log del facilitator. Antes de buscar el
  // bug en la wallet de alguien, mirar ese log.
  | "solana_settle_sender_proof_invalid"
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
    // SDD 037 — OBLIGATORIO, y el `string` sin `?` es la barrera del compilador: quitar este campo
    // de un `settle()` no compila. Reemplaza a la prueba HMAC anterior, que era opcional y cuyo secreto
    // compartido permitía fabricar una prueba válida para cualquier billetera.
    popSignature: string;
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
  // 🔴 WKH-333 — `kycVerificationId` SE ELIMINÓ de este input, y no quedó opcional. El backend saca
  // ese identificador de SU PROPIA fila, indexada por la dirección PoP-verificada (AC-16/CD-26), así
  // que un cliente que lo mande no está aportando un dato: está proponiendo con qué verificación de
  // identidad se lo autoriza. Dejarlo opcional permitiría que un call-site futuro lo reintrodujera
  // sin que nada se pusiera rojo; sacarlo lo convierte en un ERROR DE COMPILACIÓN.
  //
  // ⚠️ LO QUE `tsc` NO CAZA, medido: borrar el campo de esta interfaz produce TS2353 en los
  // call-sites con literal de objeto, pero NO produce error en una clase que lo implementa
  // declarando el campo extra en su parámetro (bivarianza de métodos en TypeScript). El cierre real
  // son DOS comandos: `tsc --noEmit` **y**
  // `command grep -rn "kycVerificationId" src/ app/ --include=*.ts --include=*.tsx`.
  prepare(input: {
    remittanceId: string;
    quoteId: string;
    address: string;
    amountUsd: number;
    beneficiary: Beneficiary;
    idempotencyKey: string; proof?: WalletPossessionProof; // WKH-359/AC-2 — PEGADO A `idempotencyKey`, EN LA LÍNEA QUE EXISTE: este archivo recibe 17 citas ancladas de acá para abajo a 12 destinos (medido en `723ca3c` con la receta del candado) y una línea de más las corre a todas. 🔴 QUÉ ES: la prueba de posesión YA OBTENIDA, que el camino por enlace consigue con su propio salto. Cuando viene, (`prepare`, `../infrastructure/settlement/http-solana-prepare-gateway.ts:193`) la usa y NO llama a `pop.prove()`; cuando falta, ese gateway corre byte-idéntico a como corría antes de esta HU. ⛔ NO la vuelve opcional en el sentido de CD-2: el que decide si el PoP es exigible sigue siendo el SERVIDOR ((`POP_SECRET`, `../../app/api/payout/prepare/route.ts:214`)), que contesta 403 sin él. Esto sólo dice QUIÉN la consiguió.
  }): Promise<
    | {
        ok: true;
        result: {
          beneficiary: string; // base58, destino del release (server-side), YA VERIFICADO contra la atestación
          authority: string; // base58, release-authority (server-side), YA VERIFICADA contra la atestación
          attestation: string;
          payoutId: string;
          provenance: string;
          /** QUIÉN dio este `beneficiary`. Ausente ⟹ el gateway no lo dijo de forma legible. */
          agent?: AgentRef;
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
  /**
   * `remittanceId` OPCIONAL, y no es un detalle de tipos: es la puerta de la recuperación DURABLE.
   *
   * El adapter ya lo soportaba (HU-SOL-20/AC-2): sin id lo resuelve contra el store server-side
   * (`POST /api/solana/escrow/remittance-ids`, PoP obligatorio) y sondea hasta
   * MAX_RECOVERY_CANDIDATES PDAs on-chain (`resolveRemittanceIdFromLedger`, `solana-wallet.ts:353`). Este puerto lo declaraba
   * REQUERIDO, así que ningún consumidor tipado podía usar ese camino: la única forma de llegar al
   * refund desde la interfaz era `RecoverEscrowFunds`, que arranca con `repo.get(remittanceId)` y
   * tira `remittance_not_found` (`recover-escrow-funds.ts`:49-50). O sea que quien borró los datos
   * del navegador, o entra desde otro dispositivo, no tenía ningún camino.
   */
  refund(input: { remittanceId?: string; sender: string }): Promise<SolanaEscrowRefundResult>;
}

// WKH-327 — CERRAR las cuentas del escrow y recuperar el alquiler que el remitente pagó al depositar.
//
// Reusa `EscrowRefundConfirmation` con la palabra "refund" adentro del nombre, y es deliberado: ese
// tipo describe un CONTRATO (tres valores, "no pudimos preguntar" separado de "todavía no"), no un
// caso de uso. El nombre habla de su primer uso. Renombrarlo a algo neutro tocaría los imports de
// `recover-escrow-funds.ts`, `solana-wallet.ts`, `refund/solana-escrow-refund-gateway.ts` y
// `flow.tsx`, o sea que metería esta HU en el diff del camino de refund — que es exactamente lo que
// AC-9 exige dejar sin un solo cambio de comportamiento. Un alias crearía dos nombres para el mismo
// contrato, que es como se empieza a divergir.
export interface SolanaEscrowCloseResult {
  closeTx: string; // base58 — la tx que el RPC aceptó (existe incluso sin confirmar)
  // CD-7: TRES valores, nunca un boolean. "confirmed" acá significa una cosa muy acotada: leímos que
  // `escrow_state` YA NO EXISTE en cadena, o sea que las dos cuentas se cerraron. NO dice a dónde fue
  // la plata (la ausencia no prueba eso) y por eso el copy del éxito no menciona los USDC.
  confirmation: EscrowRefundConfirmation;
}
export interface SolanaEscrowCloseGateway {
  /**
   * `remittanceId` es REQUERIDO, al revés que en `refund`, y no es una asimetría por descuido.
   *
   * El refund sin id elige UNO entre N candidatos porque "recuperar mis USDC" tiene un objetivo
   * natural: el escrow que todavía tiene plata adentro. Para `close` no existe ese "el" — todos los
   * escrows terminales son igual de cerrables — así que elegir uno en silencio le cerraría a la
   * persona una cuenta que no eligió. El descubrimiento (`SolanaCloseableEscrowLister`) devuelve la
   * LISTA y la elección es de ella.
   */
  close(input: { remittanceId: string; sender: string }): Promise<SolanaEscrowCloseResult>;
}

// Un escrow que la CADENA dice que está terminal, o sea con sus dos cuentas todavía abiertas y su
// alquiler todavía inmovilizado. AC-8: la lista se arma cruzando los ids que el servidor tiene
// guardados con una sonda on-chain, así que incluye envíos que NO están en el `localStorage` de este
// navegador — que es justamente la gente que hoy no tiene ningún camino.
export interface CloseableEscrow {
  remittanceId: string;
  status: "released" | "refunded";
}
export interface SolanaCloseableEscrowLister {
  /**
   * 🚫 NUNCA devuelve `[]` para decir "no pudimos preguntar": si el RPC o el resolver fallan, TIRA.
   * Una lista vacía significa una sola cosa — la cadena contestó y no hay nada cerrable. Colapsar las
   * dos es el error que `lostEscrowRecoveryError` ya tuvo que documentar en el copy: "no llegamos a
   * preguntar" no es "no tenés nada".
   */
  listCloseable(input: { sender: string }): Promise<readonly CloseableEscrow[]>;
}

// El MISMO criterio de tres valores que EscrowRefundConfirmation, aplicado a la otra punta del
// money-path: ¿el principal del sender entró al vault del escrow? Es la pregunta que el use-case se
// hacía con un boolean, y con un boolean sólo podía contestar "no" cuando la verdad era "no pude
// preguntar", y sobre ese "no" escribía un reembolso que nunca ocurrió.
//   · "deposited":     la cadena muestra la cuenta del escrow. La plata está adentro: es recuperable.
//   · "not_deposited": sabemos que NO entró (el intento murió ANTES del broadcast, o la cadena probó
//     que la tx ya no puede entrar). No hay nada que recuperar ni que reembolsar.
//   · "unknown":       no pudimos averiguarlo. NO se colapsa en ninguno de los otros dos: la remesa
//     queda recuperable y a la persona se le dice, con esas palabras, que todavía no sabemos.
export type PrincipalDepositState = "deposited" | "not_deposited" | "unknown";

// Le pregunta A LA CADENA (no a un agente) si el depósito del principal está en el vault del escrow.
// La verdad sobre el dinero vive en la cadena; los agentes son reemplazables y no pueden ser fuente de
// esta respuesta. Deriva la PDA `escrow_state` de (sender, remittanceId): sin dependencias de ningún
// slug, URL ni contrato de agente.
export interface SolanaEscrowDepositProbe {
  probeDeposit(input: { remittanceId: string; sender: string }): Promise<PrincipalDepositState>;
}

// El saldo de SOL del sender, con los MISMOS tres valores que el resto del money-path y por la misma
// razón: preguntarle a un RPC es una medición, y una medición puede no ocurrir.
//   · { status: "known", lamports } — pudimos preguntar y esto es lo que contestó la cadena.
//   · { status: "unknown" }         — NO pudimos preguntar (RPC caído, timeout, respuesta ilegible).
//     No dice que el saldo sea cero ni que sea suficiente: dice que no lo sabemos. Colapsarlo en
//     "insuficiente" convertiría una caída de infraestructura en una acusación a la billetera de la
//     persona, que es exactamente el error que este repo ya cometió dos veces.
// No es un `number | null` a propósito: un `null` obliga a cada llamador a acordarse de qué significa,
// y ya vimos qué pasa cuando alguien lo lee como "0".
export type SolanaSenderSolBalance = { status: "known"; lamports: number } | { status: "unknown" };

// Le pregunta a la cadena cuánto SOL tiene el sender. Existe porque el depósito NO es gasless para él:
// el fee de red lo paga el facilitator, pero el rent de las cuentas que crea la ix `deposit`
// (`payer = sender`) sale de su billetera. Ver `solana-escrow-rent.ts` para el número y su derivación.
// `lamports` va como `number` (es lo que devuelve `connection.getBalance`); el saldo de una billetera
// individual está órdenes de magnitud por debajo de Number.MAX_SAFE_INTEGER.
export interface SolanaSenderSolBalanceProbe {
  probeSenderSolBalance(input: { sender: string }): Promise<SolanaSenderSolBalance>;
}

/**
 * Preguntarle al registro durable por los envíos de una billetera tiene TRES desenlaces, no dos
 * (WKH-327, 2º fix-pack — AR/BLQ-MED-2). `string[]` sólo puede expresar dos: "esta lista" y "ninguno".
 * El tercero —"no llegamos a preguntar"— entraba disfrazado del segundo.
 *
 * · `answered`   — el servidor contestó. `remittanceIds` puede estar vacío, y ESO SÍ es una respuesta
 *                  sobre la billetera: es el único caso en que se puede afirmar algo sobre ella.
 * · `not_asked`  — no hubo consulta que contestara. `reason` dice cuál de las tres:
 *      - `pop_disabled`      el mecanismo de prueba de posesión está apagado server-side (501 en el
 *                            challenge) ⇒ nunca se llegó ni a pedir los ids;
 *      - `registry_disabled` el registro durable está apagado o sin envs (501 en el endpoint de ids);
 *      - `pop_rejected`      la prueba de posesión no verificó (403): challenge vencido, skew, nonce.
 *
 * Las tres las dispara una BANDERA DE CONFIGURACIÓN y no una caída de red, así que son más probables
 * que un fallo, no menos: con el registro apagado le pasan a todo el mundo en todas las búsquedas.
 */
export type RemittanceIdLookupBlocked = "pop_disabled" | "registry_disabled" | "pop_rejected";
export type RemittanceIdLookup =
  | { readonly outcome: "answered"; readonly remittanceIds: readonly string[] }
  | { readonly outcome: "not_asked"; readonly reason: RemittanceIdLookupBlocked };

// HU-SOL-20/AC-2: resuelve los remittanceId del sender desde el store durable server-side cuando el
// cliente los perdió (localStorage vacío / otro dispositivo).
export interface SolanaRemittanceIdResolver {
  /**
   * UN SOLO MÉTODO, y ése es el punto (WKH-331). La interfaz tenía dos: éste y un `listBySender` que
   * devolvía `string[]`. Un `string[]` no tiene forma de expresar el tercer desenlace: "no llegamos a
   * preguntar" tenía que viajar disfrazado de lista vacía, y los dos consumidores heredaban esa
   * confusión sin que nada en el tipo la señalara. Mientras el método existió, escribir un doble ciego
   * era gratis (`{ listBySender: async () => [] }` compilaba) y escribir uno honesto era imposible.
   *
   * El tipo que separa los tres es (`RemittanceIdLookup`, `:467`), acá arriba, y su docblock dice
   * cuáles son y por qué las tres degradaciones son más probables que un fallo de red.
   *
   * Lo verificable hoy: en esta interfaz no quedó ningún método capaz de expresar el colapso, así que
   * un doble que quiera representar "no pude preguntar" está obligado a escribir el `outcome`. Eso es
   * una propiedad del tipo, no una promesa sobre el futuro del código que lo consume.
   */
  lookupBySender(sender: string): Promise<RemittanceIdLookup>;
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
  ): Promise<AutorizacionDelPrincipal>;
  // El retorno son TRES desenlaces y no dos (WKH-356). El `Promise<{ tx, solana? }>` que había acá
  // sólo sabía escribir "resolvió con esto" y "tiró"; el porqué del tercero —y por qué no es `null`
  // ni un `boolean`— está en (`AutorizacionDelPrincipal`, `:1185`).
  // WKH-206: firma un mensaje arbitrario con la key de la wallet conectada. Lo usa el PopSigner para
  // probar posesión de `address`. En demo devuelve una firma simbólica (AC-5).
  signMessage(message: string): Promise<string>;
  /** WKH-356/AR-MNR-1 — el envío TERMINÓ (bien o mal) y lo que quedaba guardado para completar una firma ya no sirve. OPCIONAL a propósito: es la única forma de agregarlo sin tocar los cuatro dobles de `WalletPort`, y una billetera que no guarda nada entre invocaciones no tiene nada que abandonar. Existe porque 061 lo dejó como requisito explícito de esta HU: `terminarViaje` no la llama ningún camino de éxito, así que sin esto la x25519 privada, la sesión y una transacción firmada sobreviven a la remesa que las produjo (hasta 20 min). El porqué de cada línea está en la implementación (`SolanaWalletAdapter.abandonarAutorizacion`), incluido por qué ACÁ sí se borra una firma ya dada y en un corte del motor no. ⛔ SÍNCRONO y sin retorno: es limpieza, y el que la llama no tiene ninguna decisión mejor que seguir. Y va EN ESTA LÍNEA, no en una nueva, porque `ports.ts` recibe 10 citas por número cuyo destino está debajo de este bloque. */ abandonarAutorizacion?(): void;
}

// ── Quién está conectado AHORA (WKH-327, fix-pack AR/BLQ-BAJO-1) ─────────────
/**
 * La billetera VIVA, no una copia.
 *
 * 🔴 POR QUÉ ES UN PUERTO PROPIO Y NO `Pick<WalletPort, "getAddress">`. Son preguntas distintas:
 * `getAddress()` contesta "quién es el sender de este flujo" y para eso devuelve primero lo que
 * cacheó `connect()` (`solana-wallet.ts`, el `if (this.address)`), que es lo correcto para firmar el
 * depósito de una remesa que ya empezó. Esto de acá contesta "quién está conectado en este
 * instante", que es la única pregunta que sirve para decidir si la firma que estamos por pedir puede
 * prosperar — y para eso un cache es exactamente la respuesta equivocada.
 *
 * 🔴 POR QUÉ EXISTE. El guard de AC-7 recibía la dirección contra la que comparar DESDE EL LLAMADOR,
 * y el único llamador de producción le pasaba la misma variable que estaba validando
 * (`connectedAddress: sender`): `x === x`, una rama falsa inalcanzable y 4 tests que probaban el
 * doble. Que el dato entre por el puerto y no por el argumento saca esa forma del alcance del
 * LLAMADOR.
 *
 * ⚠️ Y LA DEJA AL ALCANCE DEL CABLEADO, que es adónde se mudó el riesgo (AR/MNR-5). Esta interfaz
 * tiene UN método, así que `{ getConnectedAddress: () => wallet.getAddress() }` la satisface y
 * devuelve el CACHE de `connect()` — la respuesta equivocada, escrita en una línea del composition
 * root, compilando. Medido: con esa línea puesta, la suite entera daba verde. La red que lo detecta
 * es un test sobre el container (`container.test.ts`, el describe de AC-7), no sobre esta interfaz.
 *
 * `null` significa "no hay ninguna billetera conectada", NUNCA "no pudimos preguntar": leer esto no
 * toca la red ni abre ningún diálogo, es leer un objeto en memoria que el árbol de React mantiene al
 * día.
 */
export interface ConnectedWalletProbe {
  getConnectedAddress(): Promise<string | null>;
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
  // WKH-333/AC-8 — la entry CRUDA, sin aplicar el TTL. SÓLO la usa el backfill: `get()` devuelve
  // null a los 181 días, así que el verificationId de una entry vencida (justo la población que el
  // backfill salva) es inalcanzable por ahí. No autoriza nada: es una pista de por dónde preguntarle
  // a la autoridad. Ver el docblock de `LocalKycStore.peek`.
  peek(address: string): Promise<{ verification: KycVerification; savedAt: number } | null>;
}

// ── Veredicto de KYC persistido server-side (WKH-333) ────────────────────────
// Mueve el veredicto de `localStorage` (por dispositivo, por navegador) a una fila durable, y hace
// que el backend saque el `verification_id` de SU PROPIA fila en vez de aceptarlo del cliente.

/** La fila, tal cual se persiste. SIN PII (CD-2): ni nombre, ni tipo/número de documento (ni sus
 *  últimos 4), ni fecha de nacimiento, ni nacionalidad. Y SIN columna de vencimiento (CD-7): viaja
 *  `verifiedAt`, que es el HECHO, y el vencimiento se computa al leer (AC-2). */
export interface KycVerdictRecord {
  /** Dirección base58 CASE-SENSITIVE, ya canonicalizada. Es la llave y el guard de ownership. */
  senderAddress: string;
  /** 🔴 CREDENCIAL del money-path: es lo que el backend le presenta a la autoridad de KYC al pagar.
   *  PROHIBIDO devolverlo en cualquier respuesta HTTP, a nadie, ni siquiera al dueño PoP-verificado
   *  (AC-6/CD-9), y PROHIBIDO loguearlo (CD-13). */
  verificationId: string;
  approved: boolean;
  riskLevel: "low" | "medium" | "high";
  /** CRUDA, como la declaró el proveedor. NO se colapsa en un booleano `isSimulated`: el dato tiene
   *  más de dos valores y la allow-list vive en el LECTOR (AC-11). */
  provenance: string;
  /** ISO-8601. El HECHO: cuándo se verificó. */
  verifiedAt: string;
}

/** Desenlace de la escritura. TRES valores y no un booleano, porque el del medio es el que sostiene
 *  CD-25: re-escribir el MISMO `verification_id` (la route de decisión se pollea hasta 8 veces) NO
 *  puede mover `verified_at`, o el veredicto no vencería nunca mientras alguien recargue la página.
 *    · 'inserted'         — no había fila para esta dirección.
 *    · 'replaced'         — había una con OTRO verification_id: es OTRA verificación ⇒ `verified_at`
 *                           se mueve, porque el hecho es nuevo.
 *    · 'already_recorded' — misma dirección, MISMO verification_id ⇒ NO-OP, `verified_at` intacto. */
export type KycVerdictWriteOutcome = "inserted" | "replaced" | "already_recorded";

/** Repositorio server-only del veredicto. Toda operación es OWNER-SCOPED por `senderAddress`
 *  (CD-5): el cliente Supabase usa el service key y BYPASSEA RLS, así que ese filtro es el guard
 *  REAL, no una optimización. */
export interface KycVerdictStore {
  /** La fila de ESTA dirección, o `null` si no hay. Devuelve el `verificationId` porque el consumidor
   *  server-side lo necesita para hablar con la autoridad — NUNCA para responderlo. */
  get(senderAddress: string): Promise<KycVerdictRecord | null>;
  /** Escritura CAS, sin lectura previa (mismo contrato que el ledger de evidencia). */
  put(record: KycVerdictRecord): Promise<KycVerdictWriteOutcome>;
}

/**
 * Lo que el CLIENTE obtiene al preguntar por su veredicto. **TRES desenlaces, y ninguno es un
 * `boolean`** (CD-16).
 *
 * La distinción que sostiene el tipo es la que un booleano no puede expresar:
 *   · `usable`    — hay veredicto vigente, aprobado y de proveniencia real. Se puede saltear la
 *                   sesión de Didit (AC-7').
 *   · `absent`    — SE PREGUNTÓ y la respuesta fue que no sirve, con el motivo. Que la fila esté
 *                   vencida es una respuesta, no un silencio.
 *   · `not_asked` — NO SE LLEGÓ A PREGUNTAR. El mecanismo de prueba de posesión está apagado, la
 *                   persona no firmó, la tabla está apagada, o la prueba no verificó. Las cuatro las
 *                   dispara una BANDERA o una decisión de la persona, así que son MÁS probables que
 *                   un fallo de red, no menos.
 *
 * 🔴 Colapsar `not_asked` en `absent` (M-19) no rompe nada visible: los dos terminan creando la
 * sesión de Didit. Lo que rompe es saber POR QUÉ se la mandó a escanear otra vez (⚠️ acá decía "por qué se gastó el cupo", y CREAR no gasta: sólo COMPLETAR — `app/api/kyc/session/route.ts`), y en el momento en
 * que alguien use `usable` como default de "no pude preguntar", la persona se queda sin verificación
 * y sin poder pagar. Los tres se escriben.
 *
 * ⚠️ `verificationId` NO está acá y no puede estar (AC-6): este tipo cruza la red hacia el navegador.
 */
export type KycVerdictAbsentReason = "absent" | "expired" | "not_approved"; // ⚠️ WKH-233 — `"simulated"` SE ELIMINÓ de esta unión, y la consecuencia va dicha, no escondida. Desde esta HU la fila del veredicto se escribe SÓLO cuando el agente devuelve `payoutAllowed: true`, y ese booleano ya exige que la proveniencia esté en la allow-list de verificaciones REALES del agente ⇒ una fila que existe es, por invariante, real: no queda ningún código capaz de producir este motivo. Lo que se pierde, dicho: una verificación simulada ya no produce fila, así que `/api/kyc/verdict` responde `absent` donde antes respondía `simulated`. Se pierde poder decir "preguntamos y era una demo"; se conserva la distinción que sostiene el tipo (`usable`/`absent`/`not_asked`). ⛔ PROHIBIDO dejarlo "por las dudas": un valor que NINGÚN código puede producir es superficie muerta en un borde de confianza, y el próximo que lo lea va a creer que pasa
export type KycVerdictNotAskedReason =
  | "pop_disabled"
  | "pop_rejected"
  | "pop_declined"
  | "store_disabled";
export type KycVerdictLookup =
  | {
      readonly outcome: "usable";
      readonly verdict: {
        readonly riskLevel: "low" | "medium" | "high";
        readonly provenance: string;
        readonly verifiedAt: string;
      };
    }
  | { readonly outcome: "absent"; readonly reason: KycVerdictAbsentReason }
  | { readonly outcome: "not_asked"; readonly reason: KycVerdictNotAskedReason };

/** Prueba de posesión ya obtenida: challenge server-emitido + firma de la billetera. Existe como tipo
 *  propio porque VIAJA: la misma prueba que autoriza la lectura del veredicto autoriza después la
 *  creación de la sesión de KYC, y ése es todo el punto — una sola firma por sesión. */
export interface WalletPossessionProof {
  readonly challenge: string;
  readonly signature: string;
}

/** Lo que devuelve `ensure`: el veredicto Y la prueba que se usó para obtenerlo.
 *
 *  🔴 LA PRUEBA VIAJA A PROPÓSITO (WKH-333/R-1). `/api/kyc/session` también la exige, y si el
 *  gateway de la sesión firmara por su cuenta, la persona vería DOS prompts de billetera en el mismo
 *  flujo por el mismo motivo. El nonce del challenge no se quema en este repo (residual R-3
 *  documentado en `prepare/route.ts`), así que el mismo par sirve dentro de su TTL. `undefined`
 *  cuando no se llegó a firmar (mecanismo apagado, o la persona dijo que no). */
export interface KycVerdictEnsureResult {
  readonly lookup: KycVerdictLookup;
  readonly proof?: WalletPossessionProof;
}

/** Adapter CLIENTE del veredicto. `ensure` = leer y, si falta, backfillear en el mismo viaje.
 *  `candidateVerificationId` es la PISTA del navegador (de `KycStore.peek`): el servidor NUNCA le
 *  cree, la re-consulta contra la autoridad y persiste sólo si vuelve autorizada (AC-8). */
export interface KycVerdictGateway {
  ensure(address: string, candidateVerificationId?: string, yaConseguida?: WalletPossessionProof): Promise<KycVerdictEnsureResult>; // WKH-359/AC-3 — el 3er argumento EN ESTA LÍNEA. La prueba YA CONSEGUIDA por el camino por enlace, que no tiene bridge al que pedírsela. Sin esto la sesión de Didit se crea SIN ATAR y `prepare` contesta 403 a toda billetera que no tenga ya fila del veredicto — y ⛔ eso NO se ve en la corrida de quien ya se verificó
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

// Las tres situaciones que se esconden hoy detrás de UN solo `fund_failed` del proveedor. La clase la
// determina el ESTADO PREVIO de la fila (que viaja en el WHERE del UPDATE, nunca se lee antes), y cada
// una pide una acción distinta de una persona. La tabla que las define vive en
// infrastructure/persistence/webhook-failure-classes.ts.
export type WebhookFailureClass = "no_principal" | "principal_in_escrow" | "principal_released";

// Desenlace de recordWebhookOutcome. `classified:false` = el evento no era un `failed` (el camino
// submitted/settled no clasifica nada). `failures` puede traer MÁS DE UNA clase: un payout_id
// correlaciona con una fila por quoteId, y dos filas en estados previos distintos se clasifican cada
// una por el suyo. Vacío = ninguna fila cambió (re-delivery: ya están todas en 'failed').
export type WebhookOutcome =
  | { readonly classified: false }
  | { readonly classified: true; readonly failures: readonly WebhookFailureClass[] };

// Los CINCO desenlaces de recordSolanaPrincipalIn. Antes eran dos (escribió / `return` mudo), y el
// mudo era indistinguible de un éxito.
export type SolanaPrincipalInOutcome =
  | "ascended" // la fila 'prepared' subió a principal_in con la signature
  | "evidence_filled" // la fila ya no estaba en 'prepared'; se completó el tx_hash sin tocar status
  | "already_recorded" // NUESTRA signature ya estaba persistida (retry benigno) ⇒ NO-OP, sin alerta
  | "unrecorded_conflict" // existe fila pero tiene evidencia de OTRA cosa: la nuestra se pierde
  | "unrecorded_no_row"; // no hay fila: el depósito NO tiene registro durable

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
  // Proveniencia del desembolso DECLARADA por el agente en el prepare, tal cual la dijo
  // ('transfi' | 'devnet-stub' | 'local-fallback' | …). Es lo que permite preguntarle a una fila si
  // movió plata SIN mirarle el prefijo del payoutId, que es una convención incidental del proveedor
  // simulado (`fb-`) y no un dato declarado.
  // `null` = NO CONSTA: fila anterior a la migración 20260804 (no se puede backfillear: el dato no se
  // guardó en ningún lado) o el agente no la declaró. NO se lee como "real" — la única afirmación que
  // habilita esta columna es la positiva, y sólo con un valor de la allow-list de proveniencias reales
  // (hoy `REAL_PAYOUT_PROVENANCES` = {"transfi"}, src/presentation/flow-vm.ts). Todo lo demás, `null`
  // incluido, es "no probado".
  payoutProvenance: string | null;
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
    // OBLIGATORIO, y `string` sin `?` A PROPÓSITO: es el candado de compilación. La proveniencia que
    // devuelve el agente estaba a UNA LÍNEA de este call-site (prepare/route.ts la leía, la mandaba en
    // el 200 y no se la pasaba al ledger), y por eso toda fila simulada quedó indistinguible de una
    // real. Con el campo opcional, borrar el pase volvería a compilar y el bug volvería igual.
    // Pasar `""` es legítimo y significa "el agente no la declaró" ⇒ el ledger persiste NULL (no
    // consta). Lo que NO es legítimo es fabricar un valor: esta columna es evidencia, no una etiqueta.
    payoutProvenance: string;
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
  //
  // WKH-325 — CINCO desenlaces, y tres de ellos ALERTAN. El `remittanceId` es el único argumento con
  // el que se pide un refund on-chain y no vive en ninguna cuenta de la cadena: su única copia durable
  // la escribe el prepare (best-effort), y el depósito es el segundo momento natural para volver a
  // escribirla. Antes esto tenía un `return` mudo cuando no había fila 'prepared', y ese no-escribir
  // era INDISTINGUIBLE de un éxito. Contrato, en orden:
  //   1. 'ascended'            — la fila 'prepared' de este owner subió a 'principal_in' con la
  //                              signature (CAS: sólo desde 'prepared', jamás degrada un terminal).
  //   2. 'evidence_filled'     — la fila ya salió de 'prepared' (el webhook llegó primero). La
  //                              evidencia es ADITIVA: se completa el tx_hash SÓLO si sigue siendo el
  //                              placeholder del prepare, y el `status` NO se toca. ALERTA.
  //   3. 'already_recorded'    — NUESTRA signature ya está persistida (retry del sponsor). NO-OP y
  //                              SIN alerta: la evidencia SÍ está.
  //   4. 'unrecorded_conflict' — hay fila de esta remesa y este sender, pero con evidencia de otra
  //                              cosa: la nuestra no queda escrita. ALERTA.
  //   5. 'unrecorded_no_row'   — no hay ninguna fila: el depósito no tiene registro durable. ALERTA.
  // Las alertas las emite la implementación (no el caller): la ruta del sponsor responde 200 en los
  // cinco casos, así que un valor de retorno que nadie ramifica no puede ser el que sostenga la señal.
  // El desenlace igual se devuelve tipado porque es lo que los tests asertan sin espiar la consola.
  // NINGÚN paso lee la columna `status`: todo estado previo que importa viaja en el WHERE.
  recordSolanaPrincipalIn(input: {
    remittanceId: string;
    senderAddress: string; // base58 del depositor (canonicalizeAddress(...,'solana'))
    signature: string; // base58 — el equivalente Solana del txHash
  }): Promise<SolanaPrincipalInOutcome>;
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
  // settle Solana: las deposit-address que ESTE servidor registró al preparar `remittanceId` para
  // `senderAddress` (columna receiver_address, escrita por recordOrderPrepared con el depositAddress
  // que resolvió el server). Es la fuente contra la que el settle compara el beneficiary que viaja
  // DENTRO de la tx firmada: el único lado de esa comparación que ni el navegador ni el canal pueden
  // tocar. Si esto se alimentara de algo del request, el guard se estaría comparando consigo mismo.
  //
  // TRES resultados, y son tres a propósito (lección WKH-308: "no pude preguntar" NO es "no"):
  //   · array con 1+ direcciones ⇒ hay contra qué comparar.
  //   · array VACÍO ⇒ la consulta corrió y no hay ninguna registrada. NO es "no coincide".
  //   · TIRA ⇒ no se pudo leer. NO es "no hay ninguna" y NO es "no coincide". El caller lo trata
  //     como su propio desenlace (503 reintentable), NUNCA como un rechazo.
  // Devuelve varias porque una remesa puede tener más de un prepare (una fila por quote:
  // idempotency_key = `${remittanceId}:${quoteId}`), y CADA una de esas direcciones la emitió este
  // servidor para esta remesa. OWNER-SCOPED por sender_address (CD-9: el service key bypassea RLS).
  // NO filtra por status: una fila que ya avanzó a 'principal_in' (settle reintentado) conserva su
  // receiver_address, y filtrarla convertiría un retry legítimo en un rechazo.
  listPreparedDepositAddresses(input: {
    remittanceId: string;
    senderAddress: string;
  }): Promise<string[]>;
  // WKH-337 — el desenlace del payout que el webhook de TransFi YA escribió acá
  // (`recordWebhookOutcome`, abajo) y que hasta ahora no leía nadie. Es la fuente de verdad del
  // seguimiento: las dos implementaciones de `PayoutGateway` son ciegas y lo declaran en su propio
  // comentario, así que no hay ningún gateway "correcto" al que preguntarle.
  //
  // `senderAddress` es OBLIGATORIO y `string` SIN `?` (CD-14): el cliente Supabase usa el service key
  // y BYPASSEA RLS, así que el `.eq('sender_address', …)` es el ÚNICO guard de ownership. Un opcional
  // sería fail-open — y con un `payoutId` ajeno, un IDOR.
  //
  // 🔴 TIRA ante un error de query; NO devuelve `unknown`. Mismo criterio, y por el mismo motivo, que
  // `listPreparedDepositAddresses` de acá arriba: un "no sé" producido por un fallo de infraestructura
  // es INDISTINGUIBLE de un "no sé" real, y son dos desenlaces distintos para el caller. La conversión
  // a 502 la hace la ruta, nunca esta capa.
  lookupPayoutOutcome(input: {
    payoutId: string;
    senderAddress: string;
  }): Promise<PayoutOutcomeLookup>;
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
  //
  // WKH-325 — el `last_error` YA NO lo pasa el caller. El parámetro `error` se ELIMINÓ a propósito y
  // no quedó opcional: dejarlo permitía que un call-site re-introdujera el enum plano
  // ("transfi_fund_failed" para los tres desenlaces) sin que nada se pusiera rojo; sacarlo lo convierte
  // en un error de compilación. Ahora el literal lo deriva la implementación del ESTADO PREVIO de cada
  // fila, que viaja en el WHERE de tres UPDATEs disjuntos (CAS, sin lectura previa).
  // El desenlace se devuelve porque el caller SÍ ramifica sobre él: la única alerta del endpoint se
  // emite exactamente cuando aparece la clase 'principal_released'.
  recordWebhookOutcome(input: {
    payoutId: string;
    status: SettlementLedgerStatus; // solo 'submitted' | 'settled' | 'failed' (post-mapeo)
  }): Promise<WebhookOutcome>;
}

// ── Utilidades inyectables (nada de Date.now/Math.random en el dominio) ──────
export interface Clock {
  nowIso(): string;
}
export interface IdGenerator {
  newId(): string;
}

// ── WKH-347 · el índice on-chain de escrows del remitente ────────────────────────────────────────
//
// Se agregan ACÁ ABAJO, al final del archivo, y no al lado de sus parientes temáticos, por una razón
// medida: hay citas ancladas que apuntan a líneas de este archivo por número (`Clock`, `:975` entre
// ellas), y una inserción aguas arriba las desplaza a todas en silencio.

/**
 * Los 16 bytes que la CADENA consume para identificar un escrow, en hexadecimal minúscula de
 * exactamente 32 caracteres.
 *
 * QUÉ ES: la seed de la PDA `["escrow", sender, id16]` y el argumento de `refund` y de `close`. Sale
 * de `sha256(utf8(remittanceId))[0..16]`, que es una función de UN SOLO SENTIDO: del `id16` NO se
 * vuelve al `remittanceId`. Por eso existe como tipo propio y no como "el id".
 *
 * ⛔ PROHIBIDO llamarlo `remittanceId` en una firma, un campo, una variable o un copy (CD-16). Un
 * nombre de campo no es su semántica: un `id16` bautizado `remittanceId` invita a interpolarlo en una
 * pantalla, mandarlo al registro durable o compararlo con el del `localStorage`, y las tres son
 * falsas. Este alias NO lo impide por sí solo —es un `string`—; lo que lo impide en el camino que
 * importa es que el resolver devuelva una unión DISCRIMINADA donde hay que nombrar el caso, en vez de
 * una cadena pelada. Ver el retorno de `resolveRemittanceIdFromLedger` en `solana-wallet.ts`.
 *
 * POR QUÉ HEX Y NO `Uint8Array`, con las tres razones refutables:
 *   1. Se compara con `===` y sirve de `key` de un `.map()` de React. Un `Uint8Array` no.
 *   2. No lo puede mutar un consumidor. Un `Uint8Array` que viaja por un puerto sí.
 *   3. Un doble de test lo escribe a mano sin importar `Buffer`.
 * La conversión hex ↔ bytes vive en UN solo lugar, junto a la derivación de la PDA.
 */
export type EscrowId16 = string;

/* ⛔ ACÁ VIVÍA `EscrowIndexLookup`, Y SE BORRÓ EN EL FIX-PACK DE WKH-347 (CR/MNR-1). Va dicho en vez de
 * desaparecer sin rastro, porque el Story File (§7.3) pedía los cuatro desenlaces y hay que decir dónde
 * quedaron. Los TRES motivos, cada uno medido:
 *
 *   1. CERO consumidores en todo el árbol, ni de producción ni de tests. Un `grep -rn EscrowIndexLookup`
 *      devolvía sólo su propia declaración.
 *   2. Su vocabulario NO era el que producción emite. Declaraba `no_index | unreadable | empty |
 *      candidates`, y los códigos que viajan de verdad son `escrow_index_absent |
 *      escrow_index_unreadable | escrow_not_found`. O sea que documentaba un idioma que ningún código
 *      habla, que es peor que no documentar nada.
 *   3. Lo contradecía este mismo repo, quince líneas más arriba de donde se escribió: "un puerto
 *      ensanchado que nadie usa es superficie muerta en el money-path".
 *
 * DÓNDE ESTÁN AHORA LOS CUATRO DESENLACES, que es lo que §7.3 exigía de verdad (que EXISTAN y estén
 * DISCRIMINADOS, no que haya un `type` en este archivo): en `resolveFromEscrowIndex` /
 * `escrowIndexCandidate` de `src/infrastructure/solana-wallet.ts`, con los tres primeros como códigos de
 * `Error` distintos y el cuarto siguiendo al sondeo on-chain. `EscrowId16` se QUEDA: tiene consumidores
 * de producción. */

/**
 * WKH-349 — QUÉ CONTESTÓ LA CADENA sobre la PDA `escrow_state` de un envío del historial.
 *
 * SEIS valores, y ninguno colapsa en otro. Es el mismo criterio que ya tienen
 * `EscrowRefundConfirmation` (`:339`) y `PrincipalDepositState` (`:420`) en este archivo: "no pudimos
 * preguntar" no es "no hay nada". Un bullet por valor, con lo que prueba y lo que NO prueba:
 *
 *  · `"deposited-window-open"`   — la cuenta existe, su `status` decodifica `{ Deposited: {} }`, y su
 *      `deadline` es POSTERIOR a nuestro reloj (`nowSec < deadlineSec`). NO prueba que el pago se vaya
 *      a liberar, ni que la ventana siga abierta cuando la persona actúe: el `deadline` puede caer
 *      entre que se lee esta cuenta y que se firma cualquier cosa sobre ella. El input que lo
 *      refutaría: releer la misma PDA un segundo después del `deadline`.
 *  · `"deposited-window-closed"` — lo mismo, con el `deadline` YA PASADO según nuestro reloj
 *      (`nowSec >= deadlineSec`), que es la negación EXACTA del guard con el que el refund de esta app
 *      rechaza por deadline (`refund_before_deadline`, `../infrastructure/solana-wallet.ts:1387`). NO
 *      prueba que el `refund` vaya a entrar: prueba que ESTA app ya no lo rechazaría por deadline.
 *      Que el programa on-chain acepte exactamente lo mismo NO se leyó desde este repo. Y NO dice que
 *      exista un botón para firmar esa devolución: esta capa lee, no abre ninguna puerta.
 *      ⚠️ Estos dos son los ÚNICOS valores del tipo que dependen de algo que la cadena no contestó:
 *      ver R-4, acá abajo.
 *  · `"released"`  — la cuenta existe y su `status` es `{ Released: {} }`. Prueba que el vault SALIÓ
 *      del escrow. NO prueba que la familia haya recibido los PEN: ese hecho lo reporta el partner de
 *      payout y es el que muestra (`statusDisplay`, `../presentation/flow-vm.ts:133`). Son dos hechos
 *      distintos sobre la misma remesa.
 *  · `"refunded"`  — la cuenta existe y su `status` es `{ Refunded: {} }`. NO prueba que la cuenta se
 *      haya cerrado: la ix `refund` no cierra nada, el cierre es otra instrucción
 *      (`refund`, `../infrastructure/solana-wallet.ts:1481`).
 *  · `"absent"`    — LA CADENA CONTESTÓ, y en esa PDA no hay cuenta. Es exactamente lo que significa
 *      hoy un `!acc` en los dos bucles que ya batchean cuentas del escrow
 *      (`resolveRemittanceIdFromLedger`, `../infrastructure/solana-wallet.ts:353`) y
 *      (`listCloseable`, `../infrastructure/solana-wallet.ts:1861`). NO dice a dónde fue la plata y NO
 *      distingue "nunca existió" de "ya se cerró después de resolverse". Ver R-1, acá abajo.
 *  · `"unknown"`   — NO PUDIMOS PREGUNTAR: el RPC falló, venció el techo de tiempo, o la respuesta no
 *      decodifica. No dice absolutamente nada sobre los fondos. NUNCA se colapsa con `"absent"`: uno
 *      habla de la cadena y el otro de nosotros.
 *
 * ── R-1 · LA CUENTA AUSENTE SIGUE SIN DECIR A DÓNDE FUE LA PLATA ─────────────────────────────────
 *
 * Esta capa cambia "no comprobamos si tus USDC siguen en el escrow" por "la cadena contestó que ahí no
 * hay cuenta, y eso significa una de dos cosas". Lo que se ELIMINÓ es el camino de decir "no
 * comprobamos" cuando sí comprobamos. Lo que QUEDA VIVO: comprobamos, y la respuesta no distingue una
 * devolución de una entrega. Se ACOTÓ; no se cerró.
 *
 * QUE SEAN DOS Y NO TRES está verificado, no supuesto: la cuenta sólo desaparece por la ix `close`, y
 * el programa la rechaza si el escrow no está en estado terminal
 * (`EscrowNotTerminal`, `../infrastructure/solana/escrow-idl.ts:1412`). O sea que una PDA ausente que
 * alguna vez existió se resolvió antes de cerrarse; no hay un tercer camino por el que un escrow CON
 * PLATA ADENTRO deje de tener cuenta. Lo que la ausencia NO dice es cuál de los dos desenlaces fue.
 *
 * POR QUÉ NO SE DESAMBIGUA CON EL `EscrowIndex` DE WKH-347, que es la idea que va a tener el próximo
 * que lea esto: el IDL declara que `close` "saca de `entries` el `remittance_id` que está cerrando"
 * (`close`, `../infrastructure/solana/escrow-idl.ts:290`), o sea que el índice es un registro de
 * escrows ABIERTOS y no un archivo histórico — justo las cerradas son las que no están. Y
 * `register_escrow` recién empezó a emitirse en el merge de WKH-347, así que la ausencia de un `id16`
 * tampoco distingue "nunca existió" de "es anterior a esa HU".
 *
 * EL ÚNICO CAMINO CONOCIDO QUE SÍ DESAMBIGUARÍA es `getSignaturesForAddress` sobre la PDA: es UNA
 * llamada por fila (no se batchea), y devuelve firmas que después hay que resolver a transacciones
 * para leer qué instrucción corrió. Rompe el "en el menor número de llamadas" que esta capa promete.
 * Es otra HU.
 *
 * ── R-4 · DE QUÉ LADO DEL `deadline` ESTAMOS LO DICE NUESTRO RELOJ, NO LA CADENA ─────────────────
 *
 * `"deposited-window-open"` y `"deposited-window-closed"` son los ÚNICOS DOS valores de un tipo que se
 * llama "qué contestó la cadena" que dependen de algo que la cadena NO contestó. El `status` y el
 * `deadline` los dijo ella; de qué lado del `deadline` caemos lo dice el `Date.now()` del dispositivo,
 * leído dentro de `readEscrowStates`. Esa comparación está escrita DOS VECES en el adapter —ahí y en el
 * guard (`refund_before_deadline`, `../infrastructure/solana-wallet.ts:1387`)—, así que PUEDEN DIVERGIR:
 * lo único que las obliga a decir lo mismo es T-A16, el test que corre LAS DOS sobre el mismo borde.
 *
 * LOS INPUTS QUE LO DEMUESTRAN, y son dos porque el primero que se escribió acá no se sostenía: decía
 * "un dispositivo con el reloj tres días atrasado", y ESE dispositivo no puede haber creado el escrow
 * —el `deadline` se escribe con el MISMO `Date.now()` sesgado (`deadline`, `../infrastructure/solana-wallet.ts:592`)
 * y el programa lo compara contra el reloj del VALIDADOR, como dice el docblock de
 * (`CUSTODY_WINDOW_SECS`, `../infrastructure/solana-wallet.ts:100`): ese depósito se rechaza en el
 * momento, con `DeadlineTooSoon`—. Los dos inputs que sí pasan hoy:
 *  · El reloj del dispositivo CAMBIÓ entre el depósito y esta lectura (viaje, ajuste manual, drift).
 *  · El escrow se creó desde OTRO dispositivo, y el `deadline` lo escribió el reloj de aquél.
 *
 * QUÉ PASA CUANDO PASA: contestamos `"deposited-window-open"` sobre un escrow que el programa ya sólo
 * deja refundear. La fila NO le dice "todavía hay tiempo" —CP-1 no habla del plazo, y ese silencio es
 * lo que AC-10 pide—: lo que hace es CALLAR que la única puerta que queda es la devolución, o sea no
 * mostrar CP-8 ni su camino al refund. NO hay ningún camino en esta capa que lo detecte.
 *
 * Lo que se ELIMINÓ: el camino de no decir nada del `deadline` cuando el `deadline` venía en la misma
 * cuenta que ya estábamos leyendo. Lo que QUEDA VIVO: lo sabemos con NUESTRO reloj, y ese reloj puede
 * estar mal. Se ACOTÓ; no se cerró, igual que R-1.
 *
 * CÓMO SE CERRARÍA, Y POR QUÉ NO ACÁ: leyendo el `Clock` del cluster, que es una llamada RPC MÁS por
 * chunk encima de las que esta capa ya hace; o mostrando la FECHA del `deadline` para que
 * la persona pueda refutarlo sola, que necesita que el `deadline` llegue hasta la pantalla y por lo
 * tanto cambia el tipo que este puerto devuelve.
 */
export type EscrowChainState =
  | "deposited-window-open"
  | "deposited-window-closed"
  | "released"
  | "refunded"
  | "absent"
  | "unknown";

/**
 * WKH-349 — el estado on-chain de VARIOS escrows del mismo remitente, en el menor número de llamadas.
 *
 * Lo consume la pantalla de historial para las filas cuyo desenlace el snapshot local no puede
 * afirmar. NUNCA firma: ni prueba de posesión, ni `signMessage`, ni una transacción. Abrir "Ver mis
 * envíos" no puede abrir un diálogo de firma.
 *
 * EL CONTRATO ES TOTAL: la implementación devuelve UNA ENTRADA POR CADA `remittanceId` pedido, sin
 * excepción — incluidos los que fallaron (`"unknown"`) y los que no tienen cuenta (`"absent"`). Un
 * `Map` no puede expresar esa totalidad en el tipo, así que el consumidor TAMPOCO la asume: una clave
 * faltante se lee como `"unknown"`. Dos capas, dos candados (T-A5 en el adapter, T-V6 en el
 * view-model).
 *
 * POR QUÉ UN `ReadonlyMap` Y NO UN `Array<{ remittanceId, state }>`, a diferencia de `CloseableEscrow`
 * (`:397`): el consumidor es un `.map()` de React que necesita el estado de UNA fila. Un array obliga
 * a cada consumidor a construir su índice, y el día que alguien resuelva eso con un `.find()` adentro
 * del render, el costo es O(n²) sobre el camino que decide si la persona ve su plata.
 *
 * POR QUÉ ESTE PUERTO NO TIRA ANTE UN RPC CAÍDO, y por qué eso NO contradice a
 * `SolanaCloseableEscrowLister` (`:401`), que tiene escrito lo contrario: allá `[]` es AMBIGUO (no se
 * distingue de "la cadena contestó y no hay nada"), así que la única forma de decir "no pudimos
 * preguntar" es tirar. Acá `"unknown"` es un valor explícito que significa exactamente eso, así que no
 * hay ambigüedad que evitar — y hace falta, porque con troceo un chunk puede fallar mientras otro
 * contesta, y una excepción global tiraría la respuesta buena. La disciplina se conserva donde sí
 * aplica: si el adapter no puede ni EMPEZAR (sender inválido, imports que fallan), TIRA.
 */
export interface SolanaEscrowChainStateReader {
  readEscrowStates(input: {
    sender: string;
    remittanceIds: readonly string[];
  }): Promise<ReadonlyMap<string, EscrowChainState>>;
}

/**
 * El desenlace de `authorizePrincipal` (`WalletPort`, `:494`) tiene TRES formas, no dos.
 *
 * El tipo que había acá era `Promise<{ tx, solana? }>`: sólo sabía escribir dos cosas, "resolvió
 * con esto" y "tiró". Firmar por enlace profundo en un celular agrega una tercera que ninguna de
 * las dos alcanza: para pedir la firma, la pestaña tiene que NAVEGAR a la app de la billetera, y
 * este proceso de JavaScript deja de existir antes de que la promesa resuelva. Con el tipo viejo
 * la única forma de escribirla era una promesa que nunca resuelve, o sea no escribirla.
 *
 * POR QUÉ NO ES `null`, NI UN `boolean`, NI UN CAMPO OPCIONAL QUE "SIGNIFIQUE" LA VARIANTE. Las
 * tres colapsan el tercer desenlace en la AUSENCIA de algo, y una ausencia no lleva carga: la
 * suspensión necesita decir A DÓNDE hay que ir (`irA`) y QUÉ firma se está esperando
 * (`esperando`), y quien la reciba tiene que quedar obligado por el compilador a mirar las dos.
 * Mismo criterio, y por la misma razón, que (`RemittanceIdLookup`, `:467`) y
 * (`SolanaSenderSolBalance`, `:439`).
 *
 * `irA` es la URL SALIENTE ya armada por el protocolo de la billetera. Quien la recibe SÓLO
 * navega: no la parsea, no la reescribe, no le agrega parámetros. `esperando` tiene exactamente
 * dos valores y NO incluye `"conectar"`: el connect es del `WalletPort.connect()`, que no
 * suspende dentro de este método.
 */
export type AutorizacionDelPrincipal =
  | { estado: "listo"; tx: string; solana?: SolanaPrincipalAuthorization }
  | { estado: "hay-que-salir"; irA: string; esperando: "firma-tx" | "firma-patrocinio" };

/**
 * WKH-359 — CÓMO SE CONSIGUE UNA PRUEBA DE POSESIÓN CUANDO NO HAY EXTENSIÓN DE BILLETERA.
 *
 * 🔴 POR QUÉ ES UN PUERTO NUEVO Y NO UN `PopSigner` MÁS. (`PopSigner`, `:554`) tiene UN método que
 * devuelve la prueba o `null`, y ese tipo no puede escribir el desenlace que define este camino: para
 * conseguir la firma hay que NAVEGAR a la app de la billetera, y este proceso de JavaScript deja de
 * existir antes de que la promesa resuelva. Es exactamente el argumento que este archivo ya escribió
 * para (`AutorizacionDelPrincipal`, `:1185`), y la conclusión es la misma: la suspensión sube por el
 * TIPO, obligando al compilador a que quien la reciba mire `irA`.
 *
 * LOS CUATRO DESENLACES, y ninguno se puede colapsar en la ausencia de otro:
 *   · `no-corresponde` — no estamos en el camino por enlace (o el gate está apagado). ⛔ ES EL QUE
 *     SOSTIENE AC-8: quien lo recibe sigue por su camino de siempre, byte-idéntico. No es un error.
 *   · `listo`          — hay una prueba anclada utilizable. Se entrega UNA vez: el ancla se borra al
 *     entregarla (CD-15, un solo uso y un solo propósito).
 *   · `hay-que-salir`  — falta la prueba y hay a dónde ir a buscarla. `irA` es la URL SALIENTE ya
 *     armada por el protocolo de la billetera: quien la recibe SÓLO navega.
 *   · `no-se-puede`    — no hay forma de conseguirla y NO se salta a ninguna billetera. Es el
 *     desenlace del 501 (`PAYOUT_POP_SECRET` ausente server-side), y su `causa` es la marca ESTABLE
 *     que ese caso ya producía antes de esta HU (AC-5). ⛔ Sin `irA`, y eso es lo medible: con el
 *     emisor apagado, el camino por enlace no puede producir ninguna navegación a la billetera.
 *
 * ⛔ EL TECHO (CD-6 de WKH-359, y no se suaviza): esto prueba posesión de la clave que EL CANAL
 * declara, NO que esa sea la billetera de la persona. No cierra la falsificación del paso 1.
 */
export type PruebaPorEnlace =
  | { estado: "no-corresponde" }
  | { estado: "listo"; proof: WalletPossessionProof }
  | { estado: "hay-que-salir"; irA: string }
  | { estado: "no-se-puede"; causa: string };

/**
 * ⚠️ EL `proposito` NO ES DECORATIVO Y NO TIENE DEFAULT (CD-15). Un ancla sacada para el payout no
 * satisface un pedido del KYC ni al revés: son dos desafíos distintos del servidor y reusar uno para
 * el otro sería exactamente el "reuso de una prueba guardada para saltearse un prompt del money-path"
 * que prohíbe la CD-6 de (`prove`, `../infrastructure/auth/http-pop-signer.ts:16`). Lo mide `T-067-17`.
 *
 * Los dos literales se escriben ACÁ y no se importan del módulo del enlace, por la misma razón que
 * (`enlaceDeVuelta`, `../infrastructure/solana/deeplink/sesion.ts:495`) escribe `"crear-nonce"` a
 * mano: importar invertiría la dependencia (la capa de aplicación no sabe de deeplinks). Quien los
 * ata es `tsc`, porque del otro lado son `const` de estos mismos literales y pasarlos no compilaría
 * si divergieran.
 */
export interface PruebaDePosesionPorEnlace {
  pedir(input: { proposito: "pop-payout" | "pop-kyc"; direccion: string }): Promise<PruebaPorEnlace>;
}
