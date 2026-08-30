import { describe, expect, it, vi } from "vitest"; import { WALLET_SIGN_MESSAGE_ERROR, laBilleteraFueTocada } from "./solana/wallet-error-code"; import { readFileSync } from "node:fs"; import path from "node:path"; import { CAUSAS_CON_COPY } from "./flow-vm"; import { SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT } from "../application/solana-escrow-rent"; // WKH-358/AC-8 agregó los cuatro EN ESTA LÍNEA y ANTES de este comentario, por lo mismo. WKH-339/CR: EN ESTA LÍNEA — `http-pop-signer.ts:33` (NO-TOUCH) cita `flow-vm.test.ts:520` por número
import { Money } from "../domain/money";
import type { RemittanceState, RemittanceStatus } from "../domain/remittance"; import { Remittance } from "../domain/remittance"; // WKH-352: EN ESTA LÍNEA, no en una nueva — `http-pop-signer.ts:33` (NO-TOUCH) cita `flow-vm.test.ts:520` por número, y `:1743`/`:1902` los citan otros dos tests sin ancla
import {
  PRINCIPAL_SETTLED_REFUND_MANUAL,
  PRINCIPAL_STATE_UNKNOWN,
} from "../application/use-cases/confirm-and-send";
import { ESCROW_REFUNDED_BY_SENDER } from "../application/use-cases/recover-escrow-funds";
import {
  PREPARE_NO_AGENT_FOR_CAPABILITY,
  QUOTE_NO_AGENT_FOR_CAPABILITY,
} from "../application/agent-rejections";
import {
  SENDER_MIN_LAMPORTS_FOR_DEPOSIT,
  formatLamportsAsSol,
} from "../application/solana-escrow-rent";
import {
  deliveredDisplay,
  escrowFundsAtRisk,
  escrowFundsKnowledge,
  escrowKnowledgeCopy, escrowOutcome, escrowOutcomeDisplay, type EscrowChainAnswer, type EscrowKnowledge, type EscrowOutcome, historyGroupFor, HISTORY_GROUP_ORDER, HISTORY_GROUP_HEADING, type HistoryGroup, // WKH-349: EN ESTA LÍNEA, no en cinco nuevas — `http-pop-signer.ts:33` (NO-TOUCH) cita `flow-vm.test.ts:520` por número y está debajo de acá
  escrowRefundError,
  escrowRentDiscoveryError,
  humanError,
  lostEscrowRecoveryError,
  shortErrorCode,
  isDemoMode,
  // ⛔ acá estaba `isKycDemo`: WKH-233 lo borró (el juicio es del agente). Línea-neutro a propósito.
  kycOriginNotice,
  // ⛔ acá estaba `REAL_KYC_PROVENANCES`: misma HU, mismo motivo. Ver la lápida en `flow-vm.ts`.
  esVentanaSinAbiertos, sinAbiertosCopy, sinIndiceCopy, indiceIlegibleCopy, statusDisplay, lecturaSeguimiento, gestoDespuesDeProve, REVISION_MECANISMO_APAGADO, REVISION_NO_SE_PUDO_PEDIR, REVISION_SIN_FIRMA, REVISION_TECHO_ALCANZADO, // WKH-339/CR: las otras 4 constantes YA NO se importan por nombre — el loop las DERIVA del módulo, que es el arreglo de BLQ-BAJO-1. Si vuelven acá por nombre, el loop volvió a ser una lista a mano. // WKH-339: EN ESTA LÍNEA, no en líneas nuevas — `http-pop-signer.ts:33` (NO-TOUCH) cita `flow-vm.test.ts:520` por número
} from "./flow-vm"; import { COPY_RESUME_SIN_RESPUESTA_TITULO, COPY_RESUME_SIN_RESPUESTA_CUERPO, COPY_RESUME_INTERRUMPIDO_TITULO, COPY_RESUME_INTERRUMPIDO_CUERPO, COPY_RESUME_NO_PODEMOS_SEGUIR, COPY_RESUME_NO_PODEMOS_SEGUIR_AVISO, COPY_VERIFY_PIDE_UNA_NUEVA, LABEL_VOLVER_A_EMPEZAR_EL_ENVIO, DESENLACES_DEL_RESUME, copyDelFinDelResume } from "./flow-vm"; import { readFileSync as leerFuente } from "node:fs"; import { join as unirRuta } from "node:path"; import { COPY_FALLO_SIN_DEPOSITO, copyDeEntregaFallida } from "./flow-vm"; import { cruceDeCuenta, seVerificoLaCuenta } from "./flow-vm"; import * as MODULO_FLOW_VM from "./flow-vm"; // WKH-339/CR-BLQ-BAJO-1: el namespace entero, para DERIVAR la lista de copies en vez de escribirla. En esta línea, ⛔ no en una nueva: este archivo recibe citas por número más abajo y una línea de import de más las corre a todas (CR/BLQ-BAJO-3: el número que había acá era una cita suelta que no miraba nadie)
// WKH-233 — los dos literales del proveedor se escriben ACÁ, en un test. El módulo que los exportaba
// se borró con la HU; los tests SÍ pueden nombrarlo (el candado de residuo salta los `*.test.*`).
const KYC_PROVENANCE_LIVE = "didit";
const KYC_PROVENANCE_MOCK = "didit-mock";
// El número que el copy dice sale de la MISMA constante que el refund sondea, nunca de un literal
// escrito acá: así el test no puede quedar afirmando un número que el código dejó de usar.
import { MAX_RECOVERY_CANDIDATES } from "../infrastructure/solana-wallet";

// WKH-320: acá abajo vivía el describe de isFallbackWalletAddress (WKH-184 AC-7/AC-9), que probaba
// que la UI detectara la wallet demo por su address y, entre otras cosas, que la detección fuera
// CASE-INSENSITIVE. Se fue con la función, y va declarado como PÉRDIDA DE UN CONTROL YA MUERTO
// (R-4): bajo Solana su try/catch devolvía false SIEMPRE (la constante era una address 0x y
// canonicalizeAddress tiraba), o sea que en producción ese control no señalaba nada. isDemoMode(),
// que decide por provenance, sí funciona y cubre la necesidad de la UI — y se sigue probando acá.

// Los 3 tests de acá abajo se REESCRIBIERON (no se borraron): siguen probando qué número se muestra,
// que era su intención original. Lo que cambió es que ahora también se prueba lo que faltaba y era la
// causa de la mentira del recibo — que el llamador SEPA si ese número es el entregado o el cotizado.
// La firma vieja devolvía un Money pelado y los dos casos volvían indistinguibles, así que la
// pantalla podía escribir "recibió" sobre una cifra que nadie confirmó, y lo hacía.
describe("flow-vm — deliveredDisplay", () => {
  it("AC-2: deliveredPen null → usa quote.receive, PERO marcado como NO confirmado", () => {
    const rem = {
      deliveredPen: null,
      quote: { receive: Money.of(1490, "PEN") },
    } as RemittanceState;
    expect(deliveredDisplay(rem)).toEqual({ amount: Money.of(1490, "PEN"), confirmed: false });
  });

  it("prioriza deliveredPen real sobre quote.receive, y ESE sí es confirmado", () => {
    const rem = {
      deliveredPen: Money.of(368, "PEN"),
      quote: { receive: Money.of(1490, "PEN") },
    } as RemittanceState;
    expect(deliveredDisplay(rem)).toEqual({ amount: Money.of(368, "PEN"), confirmed: true });
  });

  it("AC-3: deliveredPen y quote null → amount null (UI muestra '—')", () => {
    const rem = { deliveredPen: null, quote: null } as RemittanceState;
    expect(deliveredDisplay(rem)).toEqual({ amount: null, confirmed: false });
  });
});

describe("flow-vm — statusDisplay", () => {
  // "Entregado" es la ÚNICA etiqueta que puede afirmar una entrega, y sólo la produce `settled`.
  it("sólo `settled` produce 'Entregado'", () => {
    expect(statusDisplay("settled")).toEqual({ label: "Entregado", tone: "ok" });
    const otros: RemittanceStatus[] = [
      "created",
      "quoted",
      "kyc_pending",
      "kyc_passed",
      "kyc_failed",
      "confirmed",
      "principal_in",
      "payout_submitted",
      "payout_failed",
      "refunded",
    ];
    for (const s of otros) expect(statusDisplay(s).label).not.toBe("Entregado");
  });

  it("payout_submitted NO dice entregado: el pago está en curso", () => {
    expect(statusDisplay("payout_submitted")).toEqual({ label: "Pago en curso", tone: "active" });
  });

  it("el fallo y el reembolso se nombran, no se disfrazan", () => {
    expect(statusDisplay("payout_failed").tone).toBe("bad");
    expect(statusDisplay("refunded").label).toBe("Reembolsado");
  });
});

// El historial muestra remesas viejas, y la tentación de toda pantalla de historial es contar el
// final. De casi todas estas remesas no tenemos el final. Estos tests fijan qué se puede afirmar y,
// sobre todo, los tres datos que PARECEN prueba de que la plata se movió y no lo son.
describe("flow-vm — escrowFundsKnowledge", () => {
  const rem = (s: Partial<RemittanceState>): RemittanceState =>
    ({ status: "created", principalTx: null, refundTx: null, failureReason: null, ...s }) as RemittanceState;

  it("sin depósito autorizado no hay plata en juego", () => {
    for (const s of ["created", "quoted", "kyc_pending", "kyc_passed", "kyc_failed"] as RemittanceStatus[]) {
      expect(escrowFundsKnowledge(rem({ status: s }))).toBe("no-deposit");
    }
  });

  it("un depósito que entró y nadie volvió a mirar es 'unverified', NUNCA 'no-deposit'", () => {
    for (const s of ["principal_in", "payout_submitted", "payout_failed"] as RemittanceStatus[]) {
      expect(escrowFundsKnowledge(rem({ status: s, principalTx: "sig" }))).toBe("unverified");
    }
  });

  // El caso que se pierde si se mira sólo `principalTx`: la persona firmó, el browser murió antes de
  // que volviera la respuesta, y los USDC pueden haber salido igual.
  it("`confirmed` sin principalTx también es 'unverified': se autorizó y no sabemos el desenlace", () => {
    expect(escrowFundsKnowledge(rem({ status: "confirmed" }))).toBe("unverified");
  });

  it("sólo el marcador que se escribe tras confirmar la tx afirma que los USDC volvieron", () => {
    const state = rem({
      status: "refunded",
      principalTx: "sig",
      refundTx: "5xReal",
      failureReason: ESCROW_REFUNDED_BY_SENDER,
    });
    expect(escrowFundsKnowledge(state)).toBe("returned");
  });

  // ── Lo que la CADENA contestó, y quedó escrito ─────────────────────────────────────────────────
  // Los dos enums que trajo el fix del reembolso fabricado. Sin estos dos casos, una remesa cuyo
  // depósito la cadena CONFIRMÓ caía en `no-deposit` ("no llegaste a depositar") y perdía el botón de
  // recuperar: la pantalla del historial le escondía a la persona la plata que sí está en el vault.
  it("`principal_settled_refund_manual` = la cadena vio el depósito: 'in-escrow', jamás 'no-deposit'", () => {
    const state = rem({ status: "payout_failed", failureReason: PRINCIPAL_SETTLED_REFUND_MANUAL });
    expect(escrowFundsKnowledge(state)).toBe("in-escrow");
  });

  it("`principal_state_unknown` = no pudimos preguntar: 'unverified', jamás 'no-deposit'", () => {
    const state = rem({ status: "payout_failed", failureReason: PRINCIPAL_STATE_UNKNOWN });
    expect(escrowFundsKnowledge(state)).toBe("unverified");
  });

  // El único reason del catálogo que describe un ATAQUE en curso. El guard de destino corta ANTES del
  // broadcast (SETTLE_REASONS_BEFORE_BROADCAST), así que el depósito NO salió: si esto dijera que sus
  // USDC podrían estar en el escrow, mandaría a la persona a buscar plata que nunca se movió.
  it("`solana_settle_beneficiary_mismatch` = probado que no entró: 'no-deposit'", () => {
    for (const reason of [
      "solana_settle_beneficiary_mismatch",
      "solana_settle_beneficiary_unconfirmed",
      "solana_settle_rejected",
      "solana_settle_rate_limited",
    ]) {
      expect(escrowFundsKnowledge(rem({ status: "payout_failed", failureReason: reason }))).toBe(
        "no-deposit",
      );
    }
  });

  // ── Las tres trampas ───────────────────────────────────────────────────────────────────────────
  // TRAMPA 1: `refundTx` es un campo, no una prueba. Hoy el adapter default devuelve null y `refunded`
  // exige comprobante real, pero esa regla vive en OTRO archivo (refund-receipt.ts): si alguien vuelve
  // a fabricar un identificador, una remesa con los USDC intactos en el vault se anunciaría como
  // devuelta y nadie iría a buscarlos. Acá se mira el marcador del sender, no el campo.
  it("un refundTx del ledger NO cuenta como devuelto: es un string sintético, no una tx", () => {
    const state = rem({
      status: "refunded",
      principalTx: "sig",
      refundTx: "refund-ledger-abc123", // lo que produce LedgerRefundGateway
      failureReason: "payout_amount_mismatch", // el credit-back, no la recuperación del sender
    });
    expect(escrowFundsKnowledge(state)).not.toBe("returned");
    expect(escrowFundsKnowledge(state)).toBe("unverified");
  });

  // TRAMPA 2: `settled` dice que el partner entregó los PEN. La release del vault la dispara una
  // persona a mano y este repo no la llama nunca. Es una AUSENCIA, así que se refuta con un
  // comando y no con un `archivo:línea`:
  // `command grep -rn "release(\|releaseEscrow\|buildRelease\|releaseIx" src/ app/ --include=*.ts --include=*.tsx`
  // devuelve CERO líneas (exit 1). Son dos hechos
  // distintos y sólo tenemos el primero.
  it("`settled` NO afirma que el vault se liberó: sigue siendo 'unverified'", () => {
    expect(escrowFundsKnowledge(rem({ status: "settled", principalTx: "sig" }))).toBe("unverified");
  });

  // TRAMPA 3: un marcador de DEPÓSITO deja de valer cuando la remesa ya está `refunded`. Es el caso
  // que trajo el merge: RecoverEscrowFunds conserva el failureReason viejo si la remesa ya venía de
  // payout_failed (recover-escrow-funds.ts:76), así que una persona que YA recuperó su plata queda
  // con `principal_settled_refund_manual` escrito. Leer el marcador sin mirar el status le diría que
  // sus USDC siguen en el escrow cuando los tiene en la wallet.
  it("un marcador de depósito NO sobrevive al refunded: no puede decir 'in-escrow'", () => {
    const state = rem({
      status: "refunded",
      refundTx: "5xRealSignature",
      failureReason: PRINCIPAL_SETTLED_REFUND_MANUAL,
    });
    expect(escrowFundsKnowledge(state)).not.toBe("in-escrow");
    expect(escrowFundsKnowledge(state)).toBe("unverified");
  });

  it("escrowFundsAtRisk separa lo que la cadena confirmó de lo que nadie miró", () => {
    const items = [
      rem({ status: "principal_in", principalTx: "sig" }), // unverified
      rem({ status: "confirmed" }), // unverified
      rem({ status: "quoted" }), // no-deposit
      rem({ status: "payout_failed", failureReason: PRINCIPAL_SETTLED_REFUND_MANUAL }), // in-escrow
      rem({ status: "payout_failed", failureReason: PRINCIPAL_STATE_UNKNOWN }), // unverified
      rem({ status: "payout_failed", failureReason: "solana_settle_beneficiary_mismatch" }), // no-deposit
      rem({
        status: "refunded",
        principalTx: "sig",
        refundTx: "5xReal",
        failureReason: ESCROW_REFUNDED_BY_SENDER,
      }), // returned
    ];
    expect(escrowFundsAtRisk(items)).toEqual({ inEscrow: 1, unverified: 3 });
    expect(escrowFundsAtRisk([])).toEqual({ inEscrow: 0, unverified: 0 });
  });

  it("ninguna frase promete un estado del vault salvo las de los dos casos medidos", () => {
    expect(escrowKnowledgeCopy("unverified")).toBe("No comprobamos si tus USDC siguen en el escrow.");
    expect(escrowKnowledgeCopy("returned")).toBe("Tus USDC volvieron a tu wallet.");
    expect(escrowKnowledgeCopy("in-escrow")).toBe("Tus USDC quedaron en el escrow, a tu nombre.");
    expect(escrowKnowledgeCopy("no-deposit")).toBe("No llegaste a depositar.");
  });

  // Los cuatro valores son ALCANZABLES desde un snapshot que el money-path puede escribir. Un valor
  // que ningún estado real produce es peor que no tenerlo: da la sensación de estar cubierto.
  it("los cuatro valores son alcanzables", () => {
    const reached = new Set([
      escrowFundsKnowledge(rem({ status: "quoted" })),
      escrowFundsKnowledge(rem({ status: "payout_failed", failureReason: PRINCIPAL_SETTLED_REFUND_MANUAL })),
      escrowFundsKnowledge(rem({ status: "principal_in", principalTx: "sig" })),
      escrowFundsKnowledge(
        rem({ status: "refunded", refundTx: "5xReal", failureReason: ESCROW_REFUNDED_BY_SENDER }),
      ),
    ]);
    expect(reached).toEqual(new Set(["no-deposit", "in-escrow", "unverified", "returned"]));
  });
});

describe("flow-vm — isDemoMode", () => {
  it("AC-4: quote.provenance local-fallback → true", () => {
    const rem = {
      quote: { provenance: "local-fallback" },
      kyc: null,
    } as RemittanceState;
    expect(isDemoMode(rem)).toBe(true);
  });

  it("AC-4: kyc.provenance local-fallback → true", () => {
    const rem = {
      quote: null,
      kyc: { provenance: "local-fallback" },
    } as RemittanceState;
    expect(isDemoMode(rem)).toBe(true);
  });

  it("AC-5: estado done demo (deliveredPen null + quote local-fallback) → true", () => {
    const rem = {
      status: "settled",
      deliveredPen: null,
      quote: { provenance: "local-fallback", receive: Money.of(1490, "PEN") },
      kyc: null,
    } as RemittanceState;
    expect(isDemoMode(rem)).toBe(true);
  });

  it("AC-6: ambos provenance didit → false (deriva de provenance, no de flag)", () => {
    const rem = {
      quote: { provenance: "didit" },
      kyc: { provenance: "didit", realVerified: true },
    } as RemittanceState;
    expect(isDemoMode(rem)).toBe(false);
  });

  it("T-AC3a (AC-3/5): quote/kyc reales pero payout mock (local-fallback) → true", () => {
    const rem = {
      quote: { provenance: "didit" },
      kyc: { provenance: "didit", realVerified: true },
      payoutProvenance: "local-fallback",
    } as RemittanceState;
    expect(isDemoMode(rem)).toBe(true);
  });

  // 🔴 EL CASO QUE FALTABA. `didit-mock` es lo que produce `mapDiditDecision` con `DIDIT_ENV=mock`
  // (decision.ts:91), o sea la configuración con la que se recorre la demo, y la condición vieja
  // (`=== "local-fallback"`) lo leía como una verificación REAL. En `confirm` todavía no hay
  // `payoutProvenance`, así que nada prendía el sello y la pantalla afirmaba una identidad verificada.
  // El literal se IMPORTA de donde se produce: si alguien renombra la etiqueta, este test no queda
  // probando un valor que ya nadie emite.
  it("kyc.provenance didit-mock (DIDIT_ENV=mock) → true, sin payout todavía", () => {
    const rem = {
      quote: { provenance: "didit" },
      kyc: { provenance: KYC_PROVENANCE_MOCK, realVerified: false },
    } as RemittanceState;
    expect(isDemoMode(rem)).toBe(true);
  });

  // La dirección: allowlist, no denylist. Lo desconocido sobre-avisa.
  it("una proveniencia de KYC desconocida → true (lo que no está en la allowlist no es real)", () => {
    const rem = {
      quote: { provenance: "didit" },
      kyc: { provenance: "verificador-nuevo-2027", realVerified: false },
    } as RemittanceState;
    expect(isDemoMode(rem)).toBe(true);
  });

  // Ausencia de dato NO es prueba de que sea real, y acá es lo contrario que en el payout: un KYC que
  // existe y no declara origen ya está siendo mostrado en pantalla como la identidad de la persona.
  it("kyc presente con provenance ausente o vacía → true", () => {
    const ausente = {
      quote: { provenance: "didit" },
      kyc: {},
    } as RemittanceState;
    expect(isDemoMode(ausente)).toBe(true);

    const vacia = {
      quote: { provenance: "didit" },
      kyc: { provenance: "", realVerified: false },
    } as RemittanceState;
    expect(isDemoMode(vacia)).toBe(true);
  });

  // El contraste con el caso de arriba: SIN kyc no hay ninguna identidad que la pantalla pueda estar
  // afirmando de más. Es lo que impide que el sello se prenda en `send`/`connect`/`review` por un dato
  // que todavía no existe.
  it("rem sin kyc (null/ausente) y con el resto real → false", () => {
    expect(isDemoMode({ quote: { provenance: "didit" }, kyc: null } as RemittanceState)).toBe(false);
    expect(isDemoMode({ quote: { provenance: "didit" } } as RemittanceState)).toBe(false);
  });

  it("T-AC3b (AC-3/5): payout real transfi / null / ausente (quote/kyc reales) → false", () => {
    const real = {
      quote: { provenance: "didit" },
      kyc: { provenance: "didit", realVerified: true },
      payoutProvenance: "transfi",
    } as RemittanceState;
    expect(isDemoMode(real)).toBe(false);

    const noPayout = {
      quote: { provenance: "didit" },
      kyc: { provenance: "didit", realVerified: true },
      payoutProvenance: null,
    } as RemittanceState;
    expect(isDemoMode(noPayout)).toBe(false);

    const absent = {
      quote: { provenance: "didit" },
      kyc: { provenance: "didit", realVerified: true },
    } as RemittanceState; // payoutProvenance undefined (legacy) → false
    expect(isDemoMode(absent)).toBe(false);
  });
});

describe("T-VM-1 · el juicio de la pantalla es del AGENTE, no de una allow-list local (WKH-233/D-3)", () => {
  // ⚠️ REEMPLAZA a los dos `it` que medían `REAL_KYC_PROVENANCES` e `isKycDemo`, borrados con la HU: una lista local con el nombre del proveedor adentro es lo primero que habría que cambiar al cambiar de proveedor, y el criterio de cierre es que NO haga falta cambiar nada. Lo que la reemplaza —`realVerified`, poblado desde el `payoutAllowed` del agente— exige MÁS: aprobado ∧ hubo reclamo de identidad ∧ la identidad COINCIDE ∧ proveniencia en SU allow-list de verificaciones reales.
  // ⛔ Δ0 EN LÍNEAS, Y NO ES ESTILO: `http-pop-signer.ts:33` cita `flow-vm.test.ts:520` por número y
  // esa línea está DEBAJO de acá, así que agregar o quitar una línea en este bloque la corre. El
  // propio `http-pop-signer.ts` documenta que su bloque no se mueve por la razón simétrica.
  const remCon = (provenance: string, realVerified?: boolean) =>
    ({ quote: { provenance: "didit" }, kyc: { provenance, realVerified } }) as RemittanceState;

  it("T-VM-1: mira `realVerified` y NO la proveniencia — `false` es demo con CUALQUIER proveniencia", () => {
    // 🧬 MUTANTE: volver a mirar `provenance` (o reponer `isKycDemo`) ⇒ ROJO por el primer caso, que es proveniencia REAL del proveedor + `realVerified:false`: con la lógica vieja daba `false` y la pantalla habría afirmado "Identidad verificada" sobre algo que el agente NO declaró real.
    for (const p of [KYC_PROVENANCE_LIVE, KYC_PROVENANCE_MOCK, "local-fallback", "", "raro"]) {
      expect(isDemoMode(remCon(p, false)), `con provenance="${p}"`).toBe(true);
    }
    // Ausencia de dato NO es prueba de que sea real: una rehidratación vieja (el spread de `kyc-store.ts` / `persistence.ts`) vuelve con `undefined`, y eso sobre-avisa: es el error gratis.
    expect(isDemoMode(remCon(KYC_PROVENANCE_LIVE, undefined))).toBe(true);
  });

  it("✅ calibración inversa: `realVerified:true` ⇒ false, INCLUSO con una proveniencia desconocida", () => {
    // La mitad que distingue este guard de uno que deniega todo. Y la proveniencia rara no es un descuido: si el agente dijo que sí, la etiqueta cruda ya no vota. Eso ES el criterio de cierre hecho test.
    for (const p of [KYC_PROVENANCE_LIVE, "verificador-nuevo-2027"]) {
      expect(isDemoMode(remCon(p, true)), `con provenance="${p}"`).toBe(false);
    }
  });

  it("kycOriginNotice: dice el origen crudo cuando existe, y nombra la ausencia cuando no", () => {
    expect(kycOriginNotice(KYC_PROVENANCE_MOCK)).toBe(
      'Estos datos salieron de "didit-mock", que no está en la lista de verificadores reales.',
    );
    // Ni ausente ni vacío ni sólo-espacios fabrican un origen entre comillas.
    const sinOrigen =
      "Estos datos no dicen de qué verificador salieron, así que no podemos llamarlos verificados.";
    expect(kycOriginNotice(undefined)).toBe(sinOrigen);
    expect(kycOriginNotice(null)).toBe(sinOrigen);
    expect(kycOriginNotice("")).toBe(sinOrigen);
    expect(kycOriginNotice("   ")).toBe(sinOrigen);
    // Y no afirma que los datos sean falsos ni que nadie los haya mirado.
    for (const p of [KYC_PROVENANCE_MOCK, "", "raro"]) {
      expect(kycOriginNotice(p)).not.toMatch(/falso|inventad|nadie/i);
    }
  });
});

describe("flow-vm: escrowRefundError", () => {
  // La distinción que importa: "no encontramos tu depósito" es probablemente una buena noticia (nunca
  // salió de tu wallet). Decirla como "no pudimos recuperar tus fondos" deja a la persona creyendo
  // que su plata está atrapada.
  it("escrow_not_found NO se dice como un fracaso de recuperación", () => {
    const copy = escrowRefundError("escrow_not_found");
    expect(copy).toContain("No encontramos un depósito tuyo en el escrow");
    expect(copy).not.toBe("No pudimos recuperar los fondos. Intentá de nuevo.");
    // Y no afirma que no exista: puede estar en vuelo.
    expect(copy).toContain("probá de nuevo en un rato");
  });

  it("escrow_not_deposited dice que ya no está ahí, sin inventar a dónde fue", () => {
    expect(escrowRefundError("escrow_not_deposited")).toContain("ya no está en el escrow");
  });

  it("refund_before_deadline explica la condición, no un fallo", () => {
    expect(escrowRefundError("refund_before_deadline")).toContain("después del vencimiento");
  });

  it("wallet desconectada → reconectar; desconocido → el genérico de siempre", () => {
    expect(escrowRefundError("wallet_not_connected")).toContain("Reconectá");
    expect(escrowRefundError("cualquier_otra_cosa")).toBe(
      "No pudimos recuperar los fondos. Intentá de nuevo.",
    );
  });
});

// Los TRES literales van escritos a mano, uno por uno, y no salen de la regexp ni de ninguna de las
// dos funciones que este bloque vigila (CD-12). Un guard que deriva sus inputs de lo que vigila se
// aplaude a sí mismo: cualquier cambio en la regexp cambiaría también los inputs y el test seguiría
// verde. "User rejected the request." es el texto que escribe Phantom; los otros dos son los códigos
// que emite nuestro propio bridge (`solana-wallet-bridge.ts`).
const LITERALES_DE_FIRMA_NO_COMPLETADA = [
  "User rejected the request.",
  "wallet_connect_cancelled",
  "wallet_sign_not_available",
] as const;

describe("flow-vm: lostEscrowRecoveryError — la firma no completada no es un fracaso (WKH-331/AC-5)", () => {
  // Hasta WKH-331 estos tres códigos no matcheaban ninguna rama y caían al default heredado de
  // `escrowRefundError`: "No pudimos recuperar los fondos. Intentá de nuevo.". O sea que a alguien que
  // cerró el popup de la firma se le decía que la recuperación de sus fondos había fracasado, cuando
  // lo único que pasó es que no se llegó a preguntarle nada al registro.
  for (const literal of LITERALES_DE_FIRMA_NO_COMPLETADA) {
    it(`"${literal}" se dice como "no llegamos a preguntar", NO como un fracaso`, () => {
      const copy = lostEscrowRecoveryError(literal, MAX_RECOVERY_CANDIDATES);
      expect(copy).toContain("no llegamos a preguntar");
      expect(copy).toContain("aceptá la firma");
      expect(copy).not.toBe("No pudimos recuperar los fondos. Intentá de nuevo.");
    });
  }

  // La OTRA firma de esta puerta (AR/BLQ-BAJO-1). El código lo etiqueta `refundEscrow` y es lo único
  // que distingue la fase, porque la billetera escribe el mismo texto para las dos. Acá se fija que la
  // rama de la posesión no se lo lleve puesto; que el código salga DE VERDAD del adapter cuando la
  // firma de la orden se rechaza lo mide `refund-perdido-junta.test.ts` con el adapter real.
  it("escrow_refund_signature_incomplete NO se dice como la firma de posesión", () => {
    const copy = lostEscrowRecoveryError(
      "escrow_refund_signature_incomplete",
      MAX_RECOVERY_CANDIDATES,
    );
    expect(copy).toContain("segunda firma");
    expect(copy).not.toContain("no llegamos a preguntar");
    expect(copy).not.toBe("No pudimos recuperar los fondos. Intentá de nuevo.");
  });

  // 🔴 EL CONTROL DE ORDEN DE RAMAS. La rama de AC-5 se insertó PRIMERA, delante de la de
  // `escrow_not_found`. Una regexp un poco más ancha le robaría casos a la rama de abajo sin romper
  // ningún otro test: la pantalla pasaría a decir "no llegamos a preguntar" también cuando el servidor
  // SÍ contestó, que es la sobre-corrección exacta que esta HU tiene que no cometer. Este test es lo
  // que la hace visible al nivel del copy (su gemelo de integración es el caso E).
  it("escrow_not_found SIGUE saliendo por su texto, que la rama nueva no le roba", () => {
    const copy = lostEscrowRecoveryError("escrow_not_found", MAX_RECOVERY_CANDIDATES);
    expect(copy).toContain("No encontramos escrows abiertos");
    expect(copy).toContain(`los últimos ${MAX_RECOVERY_CANDIDATES} envíos`);
    expect(copy).not.toContain("aceptá la firma"); expect(copy).toContain("índice"); // WKH-347: EN ESTA LÍNEA, no en una nueva — `http-pop-signer.ts:33` (NO-TOUCH) cita `flow-vm.test.ts:520` por número y ese archivo está fuera del Scope IN. Ahora el copy nombra la SEGUNDA fuente: afirmar "no encontramos" habiendo mirado una sola de las dos sería afirmar de más sobre la otra
  });

  // 🔴 EL CONTROL DE ARRIBA PROTEGÍA UN SOLO CÓDIGO, Y NO ALCANZA (AR/MNR-1). Medido: ensanchando la
  // regexp a `/rejected|cancelled|wallet_sign_not_available/i` la suite COMPLETA quedaba verde
  // (89 archivos, 1354 tests). Con esa regexp `escrow_recovery_unavailable:pop_rejected` —el 403, o sea
  // la prueba de posesión que el servidor no verificó— cae en la rama de la firma, y la pantalla pasa
  // de "No pudimos consultar el registro" a "aceptá la firma", que manda a la persona a re-firmar algo
  // que sí firmó. `escrow_not_found` no lo detectaba porque no contiene "rejected" ni "cancelled".
  //
  // Los códigos van escritos a mano, uno por uno, y no salen de ninguna de las funciones vigiladas
  // (mismo criterio que `LITERALES_DE_FIRMA_NO_COMPLETADA`). Son los que emite `refundEscrow`
  // (`solana-wallet.ts`, `resolveRemittanceIdFromLedger`) con el motivo pegado.
  const CODIGOS_DEL_REGISTRO_MUDO = [
    "escrow_recovery_unavailable:pop_disabled",
    "escrow_recovery_unavailable:registry_disabled",
    "escrow_recovery_unavailable:pop_rejected", // ⚠️ contiene "rejected": el que se colaba
    "escrow_id_unavailable",
  ] as const;

  for (const code of CODIGOS_DEL_REGISTRO_MUDO) {
    it(`"${code}" sale por el texto del registro, NO por el de la firma`, () => {
      const copy = lostEscrowRecoveryError(code, MAX_RECOVERY_CANDIDATES);
      // La aserción positiva es la que distingue: las DOS copias contienen "no llegamos a preguntar",
      // así que pedir esa subcadena no separa nada. "el registro de envíos" está sólo en ésta.
      expect(copy).toContain("No pudimos consultar el registro de envíos");
      expect(copy).not.toContain("aceptá la firma");
      expect(copy).not.toContain("segunda firma");
    });
  }
});

// 🔴 LA RED DE SEGURIDAD DE ESTA FUNCIÓN, QUE NO EXISTÍA (AR/MNR-3). Los códigos que el guard no
// reconoce caían a `escrowRefundError`, cuyo default dice "No pudimos recuperar los fondos. Intentá de
// nuevo." Medido: por ahí salían TRES desenlaces que son "no llegamos a preguntar", no "fracasamos":
//   · `pop_challenge_unavailable` — el 429 del rate-limit del challenge (dos clicks seguidos en
//     "Buscar" alcanzan) y el 503 fail-closed, los dos desde `http-pop-signer.ts:23`;
//   · `Failed to fetch` — el navegador sin red, que es el mensaje que escribe `fetch`.
// La asimetría que lo delata: `escrowRentDiscoveryError` DECLARA su red de seguridad ("si algún día no
// matchea, cae al default de abajo, que TAMBIÉN dice no llegamos a preguntar"). Acá esa red no existía
// y el comentario copiado no lo advertía.
describe("flow-vm: el default de lostEscrowRecoveryError no llama fracaso a un 'no preguntamos' (AR/MNR-3)", () => {
  const NO_LLEGAMOS_A_PREGUNTAR = [
    "pop_challenge_unavailable", // 429 del rate-limit del challenge / 503 fail-closed
    "Failed to fetch", // el navegador sin red (lo escribe fetch, no nosotros)
    "un_codigo_que_todavia_no_existe", // el que venga mañana: la red atrapa lo desconocido
  ] as const;

  for (const code of NO_LLEGAMOS_A_PREGUNTAR) {
    it(`"${code}" no se dice como un fracaso de la recuperación`, () => {
      const copy = lostEscrowRecoveryError(code, MAX_RECOVERY_CANDIDATES);
      expect(copy).not.toBe("No pudimos recuperar los fondos. Intentá de nuevo.");
      expect(copy).toContain("no es una respuesta sobre tus fondos");
      // Y tampoco puede irse al otro extremo afirmando que miramos algo.
      expect(copy).not.toContain(`los últimos ${MAX_RECOVERY_CANDIDATES} envíos`);
    });
  }

  // ⚠️ EL CONTRAPESO, sin el cual lo de arriba es la sobre-corrección simétrica. `refund_tx_failed` NO
  // es un "no preguntamos": `confirmRefund` sólo lo tira cuando MIDIÓ que la tx entró en un bloque y
  // revirtió, y que el escrow no quedó Refunded. Ahí "no pudimos recuperar los fondos" es cierto, y
  // decirle a esa persona "no llegamos a preguntar" sería el mismo error en el otro sentido.
  it("refund_tx_failed SÍ se dice como un fracaso: es un 'no' medido en la cadena", () => {
    expect(lostEscrowRecoveryError("refund_tx_failed", MAX_RECOVERY_CANDIDATES)).toBe(
      "No pudimos recuperar los fondos. Intentá de nuevo.",
    );
  });

  // Los otros tres que siguen saliendo por `escrowRefundError` porque SÍ son respuestas sobre el
  // dinero: el escrow ya no está depositado, todavía no venció, o la wallet se desconectó.
  it("los códigos que SÍ responden sobre los fondos conservan su copy", () => {
    expect(lostEscrowRecoveryError("escrow_not_deposited", MAX_RECOVERY_CANDIDATES)).toContain(
      "ya no está en el escrow",
    );
    expect(lostEscrowRecoveryError("refund_before_deadline", MAX_RECOVERY_CANDIDATES)).toContain(
      "después del vencimiento",
    );
    expect(lostEscrowRecoveryError("wallet_not_connected", MAX_RECOVERY_CANDIDATES)).toContain(
      "Reconectá",
    );
  });
});

// 🔴 LA FASE DE LA CONEXIÓN, que decía "no sabemos" sabiendo (AR/MNR-9). Medido con probe: estos
// códigos salían por la red de seguridad ("Algo se cortó antes de terminar. No sabemos hasta dónde
// llegamos"), y para ellos eso es tan falso como el defecto que la HU cierra, sólo que en el otro
// sentido: los cinco los tira el adapter de la wallet (`connect`, `solana-wallet.ts:188`), que corre
// ANTES de que exista una address con la que preguntarle nada al registro. No se abrió la billetera,
// no se firmó, no se preguntó. Es preexistente: antes de WKH-331 decían "No pudimos recuperar los
// fondos", que era peor.
describe("flow-vm: los códigos de la fase de conexión dicen que no se preguntó (AR/MNR-9)", () => {
  // Escritos a mano, uno por uno, y no derivados de la regexp que vigilan.
  const CÓDIGOS_DE_LA_CONEXIÓN = [
    "wallet_bridge_not_mounted", // el árbol de providers no montó: `openModal` ni se pudo llamar
    "wallet_connect_timeout", // la espera venció (lib o bridge)
    "wallet_window_closed", // se cerró la ventana de la wallet sin conectar
    "wallet_window_blocked", // el navegador bloqueó el popup
    "invalid_address", // la wallet devolvió algo que no es base58
  ] as const;

  for (const code of CÓDIGOS_DE_LA_CONEXIÓN) {
    it(`"${code}" se dice como "no llegamos a preguntar", no como "no sabemos"`, () => {
      const copy = lostEscrowRecoveryError(code, MAX_RECOVERY_CANDIDATES);
      expect(copy).toContain("no llegamos a preguntar");
      expect(copy).toContain("no es una respuesta sobre tus fondos");
      expect(copy).not.toContain("No sabemos hasta dónde llegamos");
      expect(copy).not.toBe("No pudimos recuperar los fondos. Intentá de nuevo.");
      // Y no se van al otro extremo: no afirman haber mirado nada ni mandan a re-firmar.
      expect(copy).not.toContain(`los últimos ${MAX_RECOVERY_CANDIDATES} envíos`);
      expect(copy).not.toContain("aceptá la firma");
      expect(copy).not.toContain("segunda firma");
    });
  }

  // ⚠️ EL POPUP BLOQUEADO, aparte. Su acción no puede ser "probá de nuevo en un rato": con el
  // bloqueador puesto el reintento falla siempre. Este test es lo que pone en rojo meterlo en la rama
  // genérica de arriba.
  it("wallet_window_blocked dice qué destraba, y no manda a esperar", () => {
    const copy = lostEscrowRecoveryError("wallet_window_blocked", MAX_RECOVERY_CANDIDATES);
    expect(copy).toContain("ventanas emergentes");
    expect(copy).not.toContain("Probá de nuevo en un rato");
  });

  // 🔴 EL CONTROL, sin el cual la rama nueva podría habérselas llevado todas. Un error de la librería
  // que no sabemos nombrar NO se rutea acá: para ése la red de seguridad dice lo cierto. Y
  // `wallet_not_connected`, que sale del mismo `connect()`, conserva su copy accionable de siempre.
  it("un wallet_error desconocido sigue cayendo en la red de seguridad", () => {
    expect(lostEscrowRecoveryError("wallet_error:AlgoQueLaLibNoTenía", MAX_RECOVERY_CANDIDATES)).toBe(
      "Algo se cortó antes de terminar. No sabemos hasta dónde llegamos, así que esto no es una respuesta sobre tus fondos. Probá de nuevo en un rato.",
    );
  });
});

describe("flow-vm: las DOS funciones responden igual a la firma no completada (WKH-331/CD-12)", () => {
  // 🔴 POR QUÉ ESTE GUARD EXISTE. La regexp está escrita DOS veces a propósito: extraerla a una
  // constante compartida obligaría a editar `escrowRentDiscoveryError`, que CD-2 prohíbe tocar. El
  // precio de duplicar es que las dos pueden divergir en silencio, y esto es lo que se pone rojo
  // cuando lo hacen, sin tocar la función protegida.
  //
  // ⚠️ La segunda subcadena NO es decorativa. El default de `escrowRentDiscoveryError` también dice
  // "no llegamos a preguntar", así que con esa sola aserción este test pasaría aunque la rama de la
  // firma no existiera en ninguna de las dos. "aceptá la firma" aparece SÓLO en esa rama.
  for (const literal of LITERALES_DE_FIRMA_NO_COMPLETADA) {
    it(`"${literal}": el refund perdido y el descubrimiento de cerrables dicen lo mismo`, () => {
      const refund = lostEscrowRecoveryError(literal, MAX_RECOVERY_CANDIDATES);
      const descubrimiento = escrowRentDiscoveryError(literal);
      for (const copy of [refund, descubrimiento]) {
        expect(copy).toContain("no llegamos a preguntar");
        expect(copy).toContain("aceptá la firma");
      }
    });
  }
});

describe("flow-vm — humanError", () => {
  // Este test reemplaza al que exigía `humanError("no_wallet")).toContain("wallet instalada")`.
  // Aquel copy se borró: afirmaba sobre lo instalado en el dispositivo (que el navegador no puede
  // saber) y encima no tenía productor. Lo que se fija ahora es que NINGÚN mensaje de este traductor
  // vuelva a hablar de lo que hay instalado, porque el próximo que lo escriba va a estar cometiendo
  // el mismo error con otras palabras.
  it("ningún mensaje afirma qué wallet hay instalada en el dispositivo", () => {
    const codigos = [
      "no_wallet",
      "no_account",
      "wallet_not_connected",
      "wallet_connect_cancelled",
      "wallet_connect_timeout",
      "wallet_window_closed",
      "wallet_window_blocked",
      "wallet_connect_failed",
      "wallet_bridge_not_mounted",
      "wallet_error:WalletNotReadyError",
      "cualquier_otra_cosa",
    ];
    for (const c of codigos) {
      expect(humanError(c)).not.toMatch(/instalad/i);
      expect(humanError(c)).not.toMatch(/no ten[ée]s/i);
    }
  });

  // Y la contraparte: borrada la rama, el código huérfano cae al genérico. Se assertea el literal
  // exacto para que reintroducir cualquier copy propio de `no_wallet` ponga esto en rojo y obligue a
  // volver a justificar por qué existe una frase que nadie puede leer.
  it("no_wallet quedó sin rama propia: cae al genérico", () => {
    expect(humanError("no_wallet")).toBe("Algo salió mal. Intentá de nuevo.");
  });

  it("AC-6: no_account / wallet_not_connected → reconectar", () => {
    expect(humanError("no_account")).toContain("Reconectá");
    expect(humanError("wallet_not_connected")).toContain("Reconectá");
  });

  it("CD-5: kyc_pending_unavailable se evalúa ANTES de includes('kyc')", () => {
    expect(humanError("kyc_pending_unavailable")).toBe(
      "No pudimos preparar la verificación. Probá de nuevo.",
    );
    expect(humanError("kyc_pending_unavailable")).not.toBe("No pudimos verificar tu identidad.");
  });

  // La causa más barata de todas tenía el mensaje más caro: sin dirección de wallet, la autoridad de
  // payout devolvía kyc_reauth_failed y la pantalla decía "No pudimos verificar tu identidad". Manda a
  // rehacer el KYC a alguien que sólo tiene que reconectar la wallet.
  it("wallet_address_unavailable: nombra la wallet, no la identidad, y no cae al genérico", () => {
    const copy = humanError("wallet_address_unavailable");
    expect(copy).toContain("dirección de tu wallet");
    expect(copy).toContain("Reconectala");
    expect(copy).toContain("no se movió ningún USDC"); // lo único afirmable sobre el dinero
    expect(copy).not.toBe("Algo salió mal. Intentá de nuevo.");
    expect(copy).not.toBe(humanError("kyc_reauth_failed")); // ya no comparte mensaje con el disfraz
  });

  // La otra causa barata con el mensaje más caro: sin SOL para el rent de las cuentas del escrow, el
  // camino largo terminaba en "No sabemos todavía si te cobramos" (PRINCIPAL_STATE_UNKNOWN), o sea el
  // mensaje que la pantalla reserva para cuando el dinero PUEDE estar en el escrow. Faltaban centavos.
  it("solana_sender_sol_insufficient: nombra el faltante en SOL y no se confunde con un fallo de entrega", () => {
    const copy = humanError("solana_sender_sol_insufficient");
    expect(copy).toContain("SOL");
    // El número sale de la MISMA constante que compara el guard, así que el copy no puede quedar
    // diciendo un valor distinto del que el guard exige.
    // 🔴 ESTA LÍNEA DECÍA TAMBIÉN "si alguien escribe el número a mano en el copy, esto se pone rojo", Y
    // ES FALSO (era PRE-EXISTENTE a WKH-347; lo cazó el fix-pack, CR/BLQ-4). Con el umbral real, la
    // interpolación y un `0,0089` escrito a mano producen la MISMA cadena y este `toContain` pasa igual.
    // Lo que sí caza el hardcode es T-347-14, que evalúa el copy con OTRO umbral.
    expect(copy).toContain(formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEPOSIT));
    expect(copy).toContain("no se movió ningún USDC"); // lo único afirmable sobre el dinero
    expect(copy).not.toBe("Algo salió mal. Intentá de nuevo.");
    // No comparte mensaje con "no pudo entregarse": la persona no tiene que esperar ningún reembolso.
    expect(copy).not.toBe(humanError("payout_failed"));
    // El umbral ahora incluye la comisión del refund, que la paga el SENDER (`refundEscrow` fija
    // `tx.feePayer = senderPk`). "La comisión de red la pagamos nosotros" a secas pasó a ser falso:
    // el texto tiene que decir cuál de las dos comisiones es cuál, o le está pidiendo a la persona
    // que cargue un costo que la misma frase le dice que no paga.
    expect(copy).toContain("comisión de red del depósito la pagamos nosotros");
    expect(copy).toContain("la comisión de la transacción con la que podrías recuperar tus USDC");
  });

  // 🔴 TRES `it` DEL HALLAZGO #75 MURIERON EN WKH-332/W4, Y ES LA MITAD VISIBLE DE LA REGRESIÓN DE
  // AC-4. Eran:
  //   · "mínimo, techo y rechazo genérico tienen copy PROPIO y DISTINTO entre sí"
  //   · "el copy del mínimo sale de MIN_SEND_USD, no de un número escrito a mano"
  //   · "el copy del techo no publica un número que no tenemos"
  // Los tres asertaban el copy de `fx_amount_below_minimum` / `fx_amount_above_maximum`, que es el
  // vocabulario PRIVADO de un agente. Llegaba a la app porque el carril punto a punto leía el body de
  // error del agente; borrado el carril, ningún productor puede emitirlos (`/compose` manda el step
  // fallado sin `code` y sin `reason`). Un test que siguiera exigiendo ese copy estaría exigiendo una
  // frase para un input que no puede ocurrir, y el copy correspondiente haría que la pantalla parezca
  // capaz de nombrar la causa. No se portan: se declaran, y su declaración ejecutable es T-4.1'
  // (al final de este archivo), que asserta que el copy del corte NO promete distinguir la causa.
  //
  // Lo que SÍ sobrevive es el enum de FAMILIA, que es una palabra nuestra y no del agente, y el
  // candado que lo separa de la caída. Los dos `it` de abajo son eso.
  it("#75: el rechazo genérico de cotización NO comparte copy con la caída ni con el default", () => {
    const generico = humanError("a2a_quote_rejected");
    expect(generico).not.toBe("Algo salió mal. Intentá de nuevo.");
    expect(generico).not.toBe(humanError("a2a_quote_unavailable"));
    // Y no promete la causa que ya no llega: no nombra el mínimo ni el máximo ni un número.
    expect(generico).not.toContain("mínimo");
    expect(generico).not.toContain("máximo");
    expect(generico).not.toMatch(/\d/);
  });

  // 🔴 EL CANDADO DE AC-5: el vocabulario privado del agente no vuelve al mapa de copy por la puerta
  // de atrás. Si alguien reintroduce una rama `fx_*`, estos dos códigos dejan de caer en el default y
  // esto se pone rojo. Input concreto que lo pone en rojo: volver a agregar
  // `if (code.includes("fx_amount_below_minimum")) return "…"`.
  it("AC-5: `fx_*` (vocabulario privado del agente) NO tiene copy propio: cae en el default", () => {
    for (const code of ["fx_amount_below_minimum", "fx_amount_above_maximum"]) {
      expect(humanError(code), code).toBe("Algo salió mal. Intentá de nuevo.");
    }
  });

  it("CANDADO #75: a2a_quote_unavailable (agente caído) NO se lleva el copy de un rechazo", () => {
    expect(humanError("a2a_quote_unavailable")).toBe("Algo salió mal. Intentá de nuevo.");
  });

  // ── El reembolso que no existe ────────────────────────────────────────────────────────────────
  // El copy de `payout` decía "Si te cobramos, te reembolsamos" y es el ÚLTIMO recurso de TrackView
  // para cualquier payout_failed cuyo reason no reconozca: el caso en que menos se sabe dónde está la
  // plata es justo donde se prometía devolverla. En este repo nada devuelve nada solo: el adapter de
  // refund por defecto responde `refundTx: null` (LedgerRefundGateway) y el use-case no escribe
  // `refunded` sin comprobante real. La salida es que la persona firme el refund del escrow.
  //
  // El test es específico a propósito. Los tests que ya existían para las ramas propias del fallo
  // (settle-reason-on-screen / flow) sólo comprueban `queryByText(/te reembolsamos/) === null`, o sea
  // que quedaron verdes con sólo borrar la promesa de ACÁ, sin comprobar que el reemplazo diga algo.
  it("el copy de payout no promete un reembolso automático, y sí nombra la salida que existe", () => {
    const copy = humanError("payout_failed");
    expect(copy).toBe(
      "No se pudo entregar. No hay un reembolso automático: si tus USDC entraron al escrow, los sacás vos firmando desde tu wallet.",
    );
    expect(copy).not.toMatch(/te reembolsamos/i);
    // Sin em dashes en el copy que ve la persona.
    expect(copy).not.toContain("—");
  });

  // Toda la tabla de una: ninguna frase de este traductor puede prometer que alguien devuelve plata.
  // Escrito sobre `humanError` entero y no sobre un código, porque el riesgo no es que vuelva a esta
  // rama, es que aparezca en la próxima que alguien agregue.
  it("ninguna frase de humanError promete que nosotros devolvemos la plata", () => {
    const codigos = [
      "payout_failed",
      "payout_rejected",
      "kyc_rejected",
      "quote_expired",
      "solana_settle_ledger_unavailable",
      "solana_sender_sol_insufficient",
      "wallet_address_unavailable",
      "otra_cosa",
    ];
    for (const c of codigos) {
      expect(humanError(c)).not.toMatch(/te (reembolsamos|devolvemos)/i);
    }
  });

  it("kyc genérico y payout siguen mapeando a su copy", () => {
    expect(humanError("kyc_rejected")).toBe("No pudimos verificar tu identidad.");
    expect(humanError("payout_failed")).toContain("No se pudo entregar");
    expect(humanError("otra_cosa")).toBe("Algo salió mal. Intentá de nuevo.");
  });

  it("WKH-205 AC-7: kyc_not_authorized (colapsado) mapea igual que kyc_not_approved → cliente observable byte-idéntico", () => {
    expect(humanError("kyc_not_authorized")).toBe("No pudimos verificar tu identidad.");
    // == humanError("kyc_not_approved"): el colapso del oráculo es invisible al cliente legítimo.
    expect(humanError("kyc_not_authorized")).toBe(humanError("kyc_not_approved"));
  });

  // Todos estos códigos EXISTEN en el bridge y en el traductor de WalletError desde antes, y sin
  // embargo caían al default. Un reporte desde un celular llegaba como "Algo salió mal" y no había
  // forma de saber cuál de los seis había sido.
  const GENERICO = "Algo salió mal. Intentá de nuevo.";
  it.each([
    ["wallet_connect_cancelled", "selector de wallet"],
    ["wallet_connect_timeout", "no se completó a tiempo"],
    ["wallet_window_closed", "ventana de la wallet"],
    ["wallet_window_blocked", "ventanas emergentes"],
    ["wallet_connect_failed", "no llegó a conectarse"],
    ["wallet_bridge_not_mounted", "todavía no está lista"],
    ["wallet_sign_not_available", "todavía no está lista"],
    ["wallet_error:WalletFuturoError", "no reconocemos"],
  ])("familia wallet_*: %s ya no cae al genérico", (code, fragmento) => {
    expect(humanError(code)).toContain(fragmento);
    expect(humanError(code)).not.toBe(GENERICO);
  });

  it("los códigos de wallet NO se pisan entre sí: seis causas, seis mensajes distintos", () => {
    // Sin esto, un `includes("wallet")` temprano pasaría los ocho tests de arriba colapsándolos.
    const mensajes = [
      "wallet_connect_cancelled",
      "wallet_connect_timeout",
      "wallet_window_closed",
      "wallet_window_blocked",
      "wallet_connect_failed",
      "wallet_bridge_not_mounted",
    ].map(humanError);
    expect(new Set(mensajes).size).toBe(mensajes.length);
  });

  it("wallet_not_connected conserva su copy previo (no lo pisó la familia nueva)", () => {
    expect(humanError("wallet_not_connected")).toContain("Reconectá");
  });

  // El timeout tiene DOS productores y sólo uno de ellos habló con una wallet: el otro es el reloj del
  // propio bridge, que salta con el selector abierto y ninguna wallet elegida. Echarle la culpa a "la
  // wallet" es inventar un actor.
  it("el timeout de conexión no le atribuye la demora a una wallet que quizá nadie eligió", () => {
    const msg = humanError("wallet_connect_timeout");
    expect(msg).toBe("La conexión no se completó a tiempo. Probá de nuevo.");
    expect(msg).not.toMatch(/la wallet (tard|no respond)/i);
  });
});

describe("flow-vm — shortErrorCode", () => {
  it("devuelve el código tal cual para un código normal del dominio", () => {
    expect(shortErrorCode("wallet_connect_cancelled")).toBe("wallet_connect_cancelled");
  });

  it("un mensaje vacío o en blanco no produce un renglón vacío en pantalla", () => {
    expect(shortErrorCode("")).toBeUndefined();
    expect(shortErrorCode("   ")).toBeUndefined();
  });

  it("acota un mensaje largo en vez de volcarlo entero en la UI", () => {
    const largo = "x".repeat(500);
    const out = shortErrorCode(largo);
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThanOrEqual(81); // 80 + el carácter de elisión
    expect(out!.endsWith("…")).toBe(true);
  });
});

// ── WKH-333 · T-COPY-1/2 — el copy de los dos cortes nuevos del money-path (M-35) ────────────────
//
// `humanError` matchea POR SUBSTRING y gana el primero que coincide. Los dos códigos de abajo caían
// en catch-alls que decían cosas falsas sobre la plata de la persona.
describe("humanError — los cortes de KYC del prepare no prometen USDC en el escrow (WKH-333)", () => {
  // ── T-COPY-1 ───────────────────────────────────────────────────────────────────────────────────
  it("T-COPY-1: `prepare_kyc_verdict_missing` tiene copy propio y NO habla de USDC en el escrow (M-35)", () => {
    const msg = humanError("prepare_kyc_verdict_missing");
    // El corte es ANTES del prepare y ANTES de la primera firma: no se movió nada, y eso es un hecho
    // del orden de la ruta, no un consuelo.
    expect(
      msg,
      "el mensaje manda a la persona a sacar del escrow unos USDC que nunca salieron de su " +
        "billetera: el corte ocurre antes de que se le pida una sola firma",
    ).not.toContain("escrow");
    expect(msg).toContain("No se movió ningún USDC");
    // Y NO cae en el catch-all genérico de `kyc`, que es cierto pero no dice la acción.
    expect(msg).not.toBe(humanError("kyc_algo_generico"));
    // 🔴 Y LA ACCIÓN ES LA QUE ARREGLA EL CASO MÁS FRECUENTE (AR/BLQ-MED-1). Quien ve este mensaje
    // suele ser alguien YA verificado cuya fila no se rellenó porque no hubo firma al conectar. Para
    // esa persona, "verificá tu identidad otra vez" es un consejo caro y equivocado: reconectar y
    // firmar dispara el backfill, que escribe la fila sin gastar otra verificación. Si el copy vuelve
    // a mandar primero al escaneo, esto se pone rojo.
    expect(
      msg,
      "el copy manda a re-verificar la identidad sin nombrar antes la acción barata que arregla el " +
        "caso típico: reconectar la billetera y aceptar la firma (ahí corre el backfill)",
    ).toContain("aceptá la firma");
    expect(msg.indexOf("firma")).toBeLessThan(msg.indexOf("verificar tu identidad"));
    // 🔴 Y LA PROMESA ES UNA CONDICIÓN, NO UNA ESTADÍSTICA (CR/MNR-1). Decía "con eso alcanza en casi
    // todos los casos": una afirmación sobre la POBLACIÓN de quienes leen el mensaje, que nada mide y
    // que decae sola cuando cambia la mezcla de gente. Ahora dice CUÁNDO alcanza, y esa condición es
    // exactamente la que hace funcionar al backfill (sin verificación previa ATADA a esta dirección,
    // la autoridad devuelve `kyc_ownership_mismatch` y no hay fila que rescatar).
    expect(
      msg,
      "el copy volvió a prometer un resultado por frecuencia ('casi todos los casos') en vez de " +
        "nombrar la condición que la persona puede evaluar sobre sí misma",
    ).not.toContain("casi todos");
    expect(msg).toContain("si ya te verificaste antes desde esta billetera");
  });

  // ── T-COPY-2 ───────────────────────────────────────────────────────────────────────────────────
  it("T-COPY-2: `payout_not_authorized` tiene copy propio y NO promete USDC en el escrow (M-35)", () => {
    const msg = humanError("payout_not_authorized");
    expect(
      msg,
      "el defecto preexistente sigue: `payout_not_authorized` no contiene 'kyc', así que caía en el " +
        "catch-all de `payout` y le decía a la persona 'si tus USDC entraron al escrow, los sacás " +
        "vos firmando' — hablando de plata en el escrow cuando el corte es anterior a la firma",
    ).not.toContain("escrow");
    expect(msg).toContain("No se movió ningún USDC");
    expect(msg).not.toBe(humanError("payout_algo_generico"));
  });

  it("T-COPY-3: 'no pude comprobar' NO se confunde con 'no estás verificado'", () => {
    // Mandar a re-verificarse a alguien porque NUESTRA base se cayó es un consejo equivocado.
    const caida = humanError("prepare_kyc_verdict_unavailable");
    const sinFila = humanError("prepare_kyc_verdict_missing");
    expect(caida).not.toBe(sinFila);
    expect(caida).toContain("No se movió ningún USDC");
    expect(caida).not.toContain("escrow");
  });

  it("T-COPY-4: los catch-alls que ya existían NO cambiaron", () => {
    expect(humanError("kyc_algo_generico")).toBe("No pudimos verificar tu identidad.");
    expect(humanError("payout_algo_generico")).toBe(
      "No se pudo entregar. No hay un reembolso automático: si tus USDC entraron al escrow, los sacás vos firmando desde tu wallet.",
    );
  });
});

// ── T-13.3 / T-4.1' (WKH-332) ────────────────────────────────────────────────────────────────────
//
// CD-17: este `describe` no depende de ningún `beforeEach`. `humanError` es una función pura de un
// string, y por eso se puede afirmar cada frase con un input concreto y nada más.
describe("T-13.3 / AC-13: 'no hay quién' no se dice con las palabras de una caída", () => {
  // Los tres textos comparados ENTRE SÍ y no cada uno contra un literal: lo que AC-13 pide no es que
  // exista una frase nueva, es que tres desenlaces distintos dejen de leerse igual. Un mutante que
  // los mapee al mismo copy muere acá y no en un `toBe` suelto.
  it("T-13.3: el copy de 'no hay agente' ≠ el de una caída ≠ el genérico de último recurso", () => {
    const sinAgente = humanError("prepare_no_agent_for_capability");
    const caida = humanError("prepare_upstream_error");
    const generico = humanError("un_codigo_que_nadie_mapeo");

    expect(generico).toBe("Algo salió mal. Intentá de nuevo."); // el default, clavado
    expect(sinAgente).not.toBe(caida);
    expect(sinAgente).not.toBe(generico);
    expect(caida).toBe(generico); // `prepare_upstream_error` sigue cayendo al default: NO se tocó
  });

  it("T-13.3: y afirma que no se movió ningún USDC, que es un HECHO del orden de la ruta", () => {
    // No es un consuelo: el prepare corre ANTES de `authorizePrincipal` en `confirm-and-send.ts`,
    // o sea antes de la primera firma de la billetera. Se lee del orden del use-case.
    expect(humanError("prepare_no_agent_for_capability")).toContain("No se movió ningún USDC");
    expect(humanError("a2a_no_agent_for_capability")).toContain("No se movió ningún USDC");
  });

  it("T-13.3: y NO invita a reintentar igual — reintentar no crea un agente", () => {
    for (const code of ["prepare_no_agent_for_capability", "a2a_no_agent_for_capability"]) {
      const copy = humanError(code);
      expect(copy, code).toContain("no cambia el resultado");
      // El copy genérico de este archivo es "Intentá de nuevo." (sin condición). Acá esa frase no
      // puede aparecer suelta: es el consejo activamente equivocado para este desenlace.
      expect(copy, code).not.toContain("Intentá de nuevo.");
    }
  });

  it("T-13.3: los dos legs no comparten copy — cortan en momentos distintos del flujo", () => {
    expect(humanError("prepare_no_agent_for_capability")).not.toBe(
      humanError("a2a_no_agent_for_capability"),
    );
    expect(humanError("prepare_no_agent_for_capability")).toContain("entregar");
    expect(humanError("a2a_no_agent_for_capability")).toContain("cotizar");
  });

  // 🔴 LA PROPIEDAD QUE HACE QUE LA POSICIÓN EN LA CASCADA NO IMPORTE, Y POR ESO SE TESTEA ELLA Y NO
  // EL ORDEN. `humanError` decide por `code.includes(...)` en cascada, con dos catch-all al final
  // (`kyc` y `payout`). Un enum que contuviera cualquiera de esas dos subcadenas quedaría tragado por
  // el copy equivocado si alguien moviera su rama hacia abajo. Los enums elegidos no las contienen —
  // `prepare_no_agent_for_capability` empieza con "prepare", no con "payout"— y eso es lo que un
  // input concreto puede romper: renombrarlo a `payout_no_agent_for_capability` pone esto en rojo.
  it("T-13.3: ninguno de los dos enums contiene 'kyc' ni 'payout' (o el catch-all se los comería)", () => {
    for (const code of [PREPARE_NO_AGENT_FOR_CAPABILITY, QUOTE_NO_AGENT_FOR_CAPABILITY]) {
      expect(code, code).not.toContain("kyc");
      expect(code, code).not.toContain("payout");
    }
    // Y la consecuencia observable de esa propiedad: ninguno se lleva el copy de los catch-all.
    expect(humanError(PREPARE_NO_AGENT_FOR_CAPABILITY)).not.toBe(
      "No pudimos verificar tu identidad.",
    );
    expect(humanError(PREPARE_NO_AGENT_FOR_CAPABILITY)).not.toBe(humanError("payout_failed"));
  });
});

// ── T-4.1' — LA REGRESIÓN DE AC-4 SE CERRÓ EN WKH-335, Y ESTE CANDADO SIGUE VÁLIDO ──────────────
//
// ✅ QUÉ CAMBIÓ. Este bloque declaraba AC-4 NO CUMPLIDO: por el carril del gateway, un rechazo del
// agente de FX (por ejemplo un monto fuera del rango del corredor) se leía en pantalla como una
// caída del sistema. WKH-335 lo cerró AGREGANDO un campo, sin levantar ninguna prohibición:
//
//   · `/compose` ahora manda `agentFailure` — `INPUT_REJECTED` | `AGENT_ERROR` — al lado del
//     `message`. Es un enum de vocabulario cerrado, no el `reason` del agente.
//   · `readFailureFields` lo copia con guard de VALOR, y `app/api/a2a/quote/route.ts` mapea
//     `code === "step_failed" && agentFailure === "INPUT_REJECTED"` a **422 `a2a_quote_rejected`**.
//   · Parsear el `message` SIGUE PROHIBIDO (`gateway-client.ts`) y ecoarlo al browser también
//     (CD-8/CD-9). Nada de eso se tocó: el dato nuevo llega estructural o no llega.
//
// ⛔ Y AUN ASÍ EL `expect` DE ABAJO NO SE DA VUELTA. La versión anterior de este comentario decía
// *"si algún día WKH-335 aterriza, ESTE `expect` es el que hay que dar vuelta"*, y está MEDIDO que
// no: después del mapeo, el cliente **nunca recibe `step_failed` como `error` del body** — la route
// lo traduce ANTES. `humanError("step_failed")` sigue —correctamente— dando el copy genérico,
// porque `step_failed` sigue siendo el bucket de lo que NO se pudo clasificar (`AGENT_ERROR`,
// campo ausente, gateway sin desplegar). Darlo vuelta rompería un candado que sigue diciendo la
// verdad.
//
// ⚠️ LO QUE SIGUE SIENDO CIERTO: el copy no nombra CUÁL campo del pedido estaba mal. `agentFailure`
// es una CLASE, no un motivo; el vocabulario `fx_*` del agente sigue sin llegar. Lo que la pantalla
// gana es distinguir "el corredor rechazó tu pedido" de "algo se cayó", que era el defecto.
describe("T-4.1': el copy genérico sigue siendo el bucket de lo NO clasificado (WKH-335)", () => {
  it("un `step_failed` del gateway cae en el copy genérico, y ese copy no nombra ninguna causa", () => {
    const copy = humanError("step_failed");
    // La regresión, medida: es el default de último recurso. No dice "monto", no dice "mínimo", no
    // dice "máximo", no dice "el agente rechazó". No puede: no le llegó el dato.
    expect(copy).toBe("Algo salió mal. Intentá de nuevo.");
    expect(copy).not.toContain("mínimo");
    expect(copy).not.toContain("máximo");
    expect(copy).not.toContain("monto");
    expect(copy).not.toContain("rechaz");
  });

  // La asimetría con AC-13, que es lo que hace que esto sea una decisión y no una omisión: el otro
  // desenlace SÍ llega estructural (422 ⇒ `no_agent_match`), y por eso SÍ tiene copy propio. La
  // diferencia no es de esfuerzo: es de qué dato existe del otro lado del cable.
  it("y la asimetría con AC-13 es la que explica por qué uno se pudo y el otro no", () => {
    // Este llega con un code estructural del gateway ⇒ copy propio.
    expect(humanError("a2a_no_agent_for_capability")).not.toBe("Algo salió mal. Intentá de nuevo.");
    // ⛔ ESTE `expect` NO SE DA VUELTA, y WKH-335 es justamente lo que lo confirma: después del
    // mapeo de la route, `step_failed` sólo llega al cliente cuando NO se pudo clasificar, y para
    // eso el copy genérico es lo correcto. Ver el docblock de este `describe`.
    expect(humanError("step_failed")).toBe("Algo salió mal. Intentá de nuevo.");
  });

  // T-335-VM-1 — la cadena NUEVA, de punta a punta del lado del cliente, y comparada contra la
  // vieja EN EL MISMO `it`. Sin la comparación, un mutante que mapeara los dos al mismo copy
  // pasaría: es exactamente el defecto que esta HU arregla, escrito al revés.
  it("T-335-VM-1: a2a_quote_rejected tiene copy PROPIO, y step_failed SIGUE siendo el genérico", () => {
    const GENERICO = "Algo salió mal. Intentá de nuevo.";
    const rechazado = humanError("a2a_quote_rejected");

    // (a) el desenlace NUEVO no es el genérico y nombra el rechazo, no una caída.
    expect(rechazado).not.toBe(GENERICO);
    expect(rechazado).toBe(
      "No pudimos cotizar este envío: el corredor lo rechazó. Probá con otro monto.",
    );
    // (b) el bucket de lo no clasificado NO se movió.
    expect(humanError("step_failed")).toBe(GENERICO);
    // (c) la comparación explícita: se DISTINGUEN.
    expect(rechazado).not.toBe(humanError("step_failed"));
    // (d) CD-1 — el copy sigue sin ecoar el vocabulario privado del agente: `agentFailure` es una
    // CLASE, no el `reason`, así que ningún `fx_*` puede aparecer en pantalla.
    expect(rechazado).not.toContain("fx_");
    expect(rechazado).not.toContain("INPUT_REJECTED");
  });
});

// ── WKH-339 · T-339.1 (AC-4) — la derivación da EXACTAMENTE uno de los cuatro estados ───────────────
//
// 🔴 QUÉ MATA, caso por caso, y por eso es un `it.each` de los CUATRO y no de tres:
//  · colapsar `"sin-billetera"` en `"sin-prueba"` ⇒ la pantalla ofrecería firmar sin tener a quién
//    pedirle la firma. La fila 4 lo caza.
//  · un default `"mirando"` ⇒ la pantalla afirmaría que vigila justo cuando dejó de vigilar. La fila 3.
//  · leer el reloj adentro ⇒ la función dejaría de ser pura y el mismo input daría dos respuestas. Lo
//    caza el `it` de idempotencia de más abajo, no el `it.each`.
//
// ⚠️ El `switch` exhaustivo que la consume vive en `flow.tsx`; lo que este archivo mide es la unión. Si
// mañana aparece un quinto valor, `tsc` obliga a cubrirlo allá (estructural) y este `it.each` queda
// corto (enumerativo) — por eso hay TAMBIÉN un aserto sobre el CONJUNTO de valores posibles.
describe("WKH-339/AC-4 — lecturaSeguimiento: exactamente uno, y ninguno colapsa en otro", () => {
  const SENDER = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const CASOS: Array<[string, Parameters<typeof lecturaSeguimiento>[0], string]> = [
    [
      "cualquier estado que no sea payout_submitted ⇒ no-aplica (no hay desenlace que leer)",
      { status: "settled", sender: SENDER, ventana: "sin-prueba" },
      "no-aplica",
    ],
    [
      "payout_submitted + ventana vigente ⇒ mirando (la lectura corre, no hay nada nuevo que decir)",
      { status: "payout_submitted", sender: SENDER, ventana: "vigente" },
      "mirando",
    ],
    [
      "payout_submitted + ventana apagada ⇒ sin-prueba (se ofrece el gesto)",
      { status: "payout_submitted", sender: SENDER, ventana: "sin-prueba" },
      "sin-prueba",
    ],
    [
      "payout_submitted SIN billetera ⇒ sin-billetera, aunque la ventana esté apagada",
      { status: "payout_submitted", sender: null, ventana: "sin-prueba" },
      "sin-billetera",
    ],
  ];

  it.each(CASOS)("%s", (_n, de, esperado) => {
    expect(lecturaSeguimiento(de)).toBe(esperado);
  });

  // 🔴 LA FILA 4 OTRA VEZ, PERO CON LA VENTANA VIGENTE, que es lo que prueba que el ORDEN de las ramas
  // es la decisión y no una casualidad del caso elegido: sin billetera NUNCA hay gesto, ni siquiera
  // cuando la ventana está encendida.
  it("sin billetera gana sobre la ventana: el `sender` se resuelve ANTES de mirar el estado", () => {
    expect(lecturaSeguimiento({ status: "payout_submitted", sender: null, ventana: "vigente" })).toBe(
      "sin-billetera",
    );
  });

  // Pureza: mismo input, misma respuesta, sin importar cuándo se pregunte. Es lo que permite llamarla
  // desde un render sin efectos secundarios — a diferencia de `estado()`, que sí los tiene.
  it("es PURA: el mismo input da el mismo valor dos veces (no lee el reloj ni el almacén)", () => {
    const de = { status: "payout_submitted" as const, sender: SENDER, ventana: "sin-prueba" as const };
    expect(lecturaSeguimiento(de)).toBe(lecturaSeguimiento(de));
  });

  // El copy, y las dos reglas que no se negocian. Se afirma la PROPIEDAD, no la frase: así reescribir el
  // texto está permitido y romper la regla no lo está.
  //
  // 🔴 LA LISTA SE DERIVA DEL MÓDULO, NO SE ESCRIBE — y las dos versiones anteriores muestran por qué.
  //
  // v1 (F3): el loop tenía 3 de 8 constantes. Mutar `REVISION_FIRMANDO` para romper las DOS
  //          prohibiciones de §5 dejaba la suite VERDE, y el regex no matcheaba `"volver a revisar"`,
  //          que es una de las tres frases prohibidas y que yo mismo había escrito.
  // v2 (fix-pack AR): el loop pasó a 7 de 8 **y le puse un `toHaveLength(7)`**, o sea que
  //          **CONGELÉ la omisión**: faltaba `REVISION_NO_SE_PUDO_PEDIR`, y medido por el CR, la misma
  //          frase prohibida que mata a `REVISION_FIRMANDO` **sobrevivía la suite completa** en ella.
  //          Un conteo literal contra una lista escrita a mano no detecta lo que se olvidó: lo fija.
  //
  // ⇒ v3: se DERIVA. El criterio —**toda exportación de `flow-vm` cuyo nombre empieza con `REVISION_`**—
  // es lo único normativo, y es el mismo patrón que `deriveTables()` en el guardián de ownership de
  // wasiai-a2a: estructural, no enumerativo. Una copy nueva entra al loop **sola**, y si alguien exporta
  // un `REVISION_*` que no es un string, el `it` de abajo lo dice en vez de saltearlo.
  const COPIES_DE_LA_VENTANA = Object.entries(MODULO_FLOW_VM)
    .filter(([k]) => k.startsWith("REVISION_"))
    .map(([k, v]) => [k, v] as const);

  it("la lista de copies se DERIVA del módulo, y todas son strings no vacíos", () => {
    // El número NO es el control (por eso es un piso y no una igualdad): el control es que la lista
    // salga del módulo. Se asienta un piso para que borrar todas las copies no deje el loop vacío y
    // verde, que es el otro modo de fallo de un loop derivado.
    expect(COPIES_DE_LA_VENTANA.length).toBeGreaterThanOrEqual(8);
    for (const [k, v] of COPIES_DE_LA_VENTANA) {
      expect(typeof v, `${k} no es un string: el loop de abajo no lo estaría midiendo`).toBe("string");
      expect((v as string).length, `${k} está vacío`).toBeGreaterThan(0);
    }
    // Y las 8 que la pantalla renderiza hoy están adentro, nombradas: es lo que hace falta para que un
    // rename no las saque del loop en silencio.
    const nombres = COPIES_DE_LA_VENTANA.map(([k]) => k);
    for (const n of [
      "REVISION_APAGADA",
      "REVISION_GESTO",
      "REVISION_FIRMANDO",
      "REVISION_SIN_BILLETERA",
      "REVISION_NO_SE_PUDO_PEDIR",
      "REVISION_MECANISMO_APAGADO",
      "REVISION_SIN_FIRMA",
      "REVISION_TECHO_ALCANZADO",
    ]) {
      expect(nombres, `${n} dejó de exportarse o se renombró`).toContain(n);
    }
  });

  it("ninguna copy de la ventana usa un verbo en pasado sobre haber revisado, ni dice 'venció'", () => {
    for (const [nombre, frase] of COPIES_DE_LA_VENTANA) {
      expect(
        frase,
        `${nombre} ("${String(frase)}") afirma un pasado que el sistema no puede distinguir`,
      ).not.toMatch(/venci|revisábamos|revisamos|dejamos de|estábamos|volver a revisar|volvé a revisar/i);
    }
  });

  it("ninguna copy del fallo culpa a la persona: los TRES casos de 'no pudimos pedir' no la nombran", () => {
    // Estados 6 y 6b: con 501, con 429 y con un fallo de red NUNCA se abrió un popup ⇒ ninguna de las dos
    // puede decir que la firma no se completó ni que se rechazó.
    for (const frase of [REVISION_NO_SE_PUDO_PEDIR, REVISION_MECANISMO_APAGADO]) {
      expect(frase).not.toMatch(/rechaz|no complet|no firmaste/i);
      expect(frase, `"${frase}" no dice de qué lado está el problema`).toMatch(/de nuestro lado/i);
    }
    // Y la que separa 6b de 6: con el mecanismo apagado, reintentar NO sirve, y la copy no puede
    // insinuar que más tarde sí.
    expect(
      REVISION_MECANISMO_APAGADO,
      "el estado 6b no dice que reintentar no cambia nada: insinúa que más tarde funciona, y no es cierto",
    ).toMatch(/no cambia el resultado/i);
    // Estado 7: hubo popup, y aun así no dice "la rechazaste" — la billetera no distingue rechazo de fallo.
    expect(REVISION_SIN_FIRMA).not.toMatch(/rechaz/i);
    // El techo: no culpa a nadie y no promete un automatismo.
    expect(REVISION_TECHO_ALCANZADO).not.toMatch(/rechaz|no complet|no firmaste|tu culpa/i);
  });

  // ── 🔴 LOS CUATRO DESENLACES DE `prove()`, con los inputs que el `else` viejo clasificaba mal ───────
  //
  // Este `describe` es el candado de AR/BLQ-MED-1. Antes, TODO `throw` que no fuera
  // `pop_challenge_unavailable` iba a `"sin-firma"` (*"La firma no se completó"*), y los tres inputs de
  // abajo —los tres MEDIDOS en el árbol— caían ahí sin que ningún test lo viera.
  describe("WKH-339/AR-BLQ-MED-1 — gestoDespuesDeProve: el default NO acusa a la persona", () => {
    it("una prueba ⇒ idle (y es el único desenlace que re-lee la ventana)", () => {
      expect(gestoDespuesDeProve({ tipo: "prueba" })).toBe("idle");
    });

    it("`null` (501, el default documentado) ⇒ mecanismo-apagado, NO 'no-se-pudo-pedir'", () => {
      // MNR-2: reintentar nunca sirve acá, así que no puede compartir estado con el 429.
      expect(gestoDespuesDeProve({ tipo: "null" })).toBe("mecanismo-apagado");
    });

    it("`pop_challenge_unavailable` (400/5xx/429 del cupo) ⇒ no-se-pudo-pedir", () => {
      expect(
        gestoDespuesDeProve({ tipo: "error", error: new Error("pop_challenge_unavailable") }),
      ).toBe("no-se-pudo-pedir");
    });

    // 🔴 LOS TRES INPUTS DEL BLOQUEANTE. Los tres decían "La firma no se completó."
    it.each([
      [
        "TypeError('Failed to fetch') — sin conexión, server caído o CORS. `http-pop-signer.ts:8` declara que fetch rechaza y LANZA",
        new TypeError("Failed to fetch"),
      ],
      [
        "Error('wallet_sign_not_available') — el bridge lo tira ANTES de cualquier popup (`solana-wallet-bridge.ts:127`)",
        new Error("wallet_sign_not_available"),
      ],
      ["un throw que no es Error ⇒ no hay ni `message` ni `name` que mirar", "boom"],
    ])("%s ⇒ no-se-pudo-pedir (nunca hubo popup)", (_n, error) => {
      expect(
        gestoDespuesDeProve({ tipo: "error", error }),
        "la pantalla le achaca a la persona una firma que nunca le pedimos",
      ).toBe("no-se-pudo-pedir");
    });

    // El único camino a `"sin-firma"`: que la billetera DECLARE el error como suyo. El `name` no es una
    // invención — MEDIDO en `node_modules/@solana/wallet-adapter-base/lib/cjs/errors.js:99`.
    it("un WalletSignMessageError (la librería lo etiqueta en `name`) ⇒ sin-firma", () => {
      const e = new Error("User rejected the request.");
      e.name = "WalletSignMessageError";
      expect(gestoDespuesDeProve({ tipo: "error", error: e })).toBe("sin-firma");
    });

    // ── 🔴 CR/BLQ-MED-1 · LA FAMILIA `Wallet…Error` COMPLETA, y NINGUNA acusa salvo una ──────────────
    //
    // El discriminante era `/^Wallet[A-Za-z]*Error$/` menos 5 excepciones escritas a mano, o sea una
    // DENYLIST. MEDIDO con esa forma: **7 de estos 10 nombres daban `"sin-firma"`** sin que se hubiera
    // abierto ningún popup. Los dos que más importan:
    //   · `WalletAccountError` — el standard adapter lo tira en `adapter.js:400`, DOS líneas ANTES de
    //     llamar a `signMessage` (`:402`). Y este repo YA lo clasificaba como fallo de conexión en
    //     `KNOWN_CODES` (`./solana/wallet-error-code.ts`), o sea que dos módulos se contradecían.
    //   · `WalletWindowBlockedError` — el popup lo bloqueó el NAVEGADOR: nunca se abrió.
    // Y el que prueba que la dirección estaba invertida para toda la familia, no para una lista:
    //   · `WalletFuturoError` — un nombre que la librería no tiene. Daba `"sin-firma"`, con el docblock
    //     afirmando literalmente que "un nombre nuevo cae del lado que no culpa a nadie".
    //
    // ⇒ este `it.each` recorre la familia ENTERA de `errors.js` más un nombre inventado. La condición es
    // positiva y de un solo nombre, así que el `it` de abajo no necesita mantenerse cuando la librería
    // agregue errores: los nuevos ya caen del lado seguro por construcción.
    it.each([
      ["WalletAccountError", "el standard adapter lo tira en `adapter.js:400`, ANTES de firmar"],
      ["WalletWindowBlockedError", "el popup lo bloqueó el navegador: nunca se abrió"],
      ["WalletWindowClosedError", "la ventana se cerró; la librería no dice que hubo firma"],
      ["WalletTimeoutError", "venció esperando, sin que la billetera confirme haber sido tocada"],
      ["WalletConnectionError", "fallo de conexión"],
      ["WalletPublicKeyError", "no se pudo leer la clave"],
      ["WalletDisconnectionError", "fallo al desconectar"],
      ["WalletNotConnectedError", "no había billetera conectada"],
      ["WalletDisconnectedError", "se desconectó"],
      ["WalletNotReadyError", "la wallet no estaba lista"],
      ["WalletLoadError", "no cargó"],
      ["WalletConfigError", "configuración"],
      ["WalletSendTransactionError", "es de enviar una tx, no de firmar un mensaje"],
      ["WalletSignTransactionError", "ídem: tx, no mensaje"],
      ["WalletSignInError", "sign-in, que esta app no usa"],
      ["WalletKeypairError", "keypair"],
      ["WalletError", "la clase base, sin fase"],
      ["WalletFuturoError", "🔴 UN NOMBRE QUE LA LIBRERÍA NO TIENE: el input que prueba la dirección"],
    ])("%s ⇒ no-se-pudo-pedir (%s)", (name, _porQue) => {
      const e = new Error("x");
      e.name = name;
      expect(
        gestoDespuesDeProve({ tipo: "error", error: e }),
        `${name} acusa a la persona de no completar una firma que la librería NO declara como suya`,
      ).toBe("no-se-pudo-pedir");
    });

    // 🔴 Y EL CONTROL SIN EL CUAL EL `it.each` DE ARRIBA NO PRUEBA NADA: si el clasificador devolviera
    // `"no-se-pudo-pedir"` SIEMPRE, las 18 filas pasarían igual. Éste exige que el único nombre de la
    // allowlist SÍ llegue a `"sin-firma"`.
    it("CONTROL: el único nombre de la allowlist sigue llegando a `sin-firma`", () => {
      const e = new Error("User rejected the request.");
      e.name = "WalletSignMessageError";
      expect(gestoDespuesDeProve({ tipo: "error", error: e })).toBe("sin-firma");
    });

    // Y el nombre se lee de UN solo lugar: `wallet-error-code.ts`, que ya era dueño de la tabla. Un
    // segundo literal `"WalletSignMessageError"` en otro archivo es el defecto que el CR nombró.
    it("el nombre de la allowlist NO está escrito a mano acá: se importa del módulo que lo mide", () => {
      expect(WALLET_SIGN_MESSAGE_ERROR).toBe("WalletSignMessageError");
      const e = new Error("x");
      e.name = WALLET_SIGN_MESSAGE_ERROR;
      expect(laBilleteraFueTocada(e)).toBe(true);
      expect(laBilleteraFueTocada(new TypeError("Failed to fetch"))).toBe(false);
      expect(laBilleteraFueTocada("boom")).toBe(false);
    });
  });
});

// ── T-346-19 (fix-pack AR/BLQ-BAJO-1): `esVentanaSinAbiertos`, el clasificador ÚNICO ─────────────
//
// 🔴 POR QUÉ ESTE PREDICADO DELEGA EN VEZ DE RE-CLASIFICAR. La alternativa obvia era
// `code.includes("escrow_not_found")` dentro de `flow.tsx`, y este archivo ya tiene escrita la
// advertencia contra exactamente esa duplicación en `:312-318`: una segunda copia de un clasificador
// necesita un guard que alguien mantenga. Delegando, la PRECEDENCIA DE RAMAS de
// `lostEscrowRecoveryError` vale para las dos respuestas sin ningún guard.
//
// ⛔ Y LO QUE ESTE TEST PROTEGE, que es el tri-estado: "no pude preguntar" NO es "no hay". Si esto
// devolviera `true` para `escrow_recovery_unavailable`, la pantalla diría "ya no queda ninguno abierto"
// después de una consulta que NUNCA llegó a mirar la cadena.
describe("flow-vm — esVentanaSinAbiertos (WKH-346 fix-pack)", () => {
  it("es true SÓLO para el código que dice que la ventana no tiene ninguno abierto", () => {
    expect(esVentanaSinAbiertos("escrow_not_found", MAX_RECOVERY_CANDIDATES)).toBe(true);
  });

  // Los cinco productores de este código (`:323-332`) no afirman NADA sobre la ventana.
  it.each([
    ["escrow_recovery_unavailable"],
    ["escrow_id_unavailable"],
    ["user rejected the request"],
    ["wallet_connect_cancelled"],
    ["wallet_sign_not_available"],
    ["escrow_refund_signature_incomplete"],
    ["solana_refund_boom"],
    [""],
  ])("es false para %s", (code) => {
    expect(esVentanaSinAbiertos(code, MAX_RECOVERY_CANDIDATES)).toBe(false);
  });

  // 🔴 EL CASO QUE UN `includes` POR SU CUENTA CONTRADICE. Un código que trae DOS subcadenas: la
  // precedencia de `lostEscrowRecoveryError` hace ganar a la firma incompleta (`:310`) y al rechazo de
  // la billetera (`:319`) ANTES que a `escrow_not_found` (`:321`). Delegando, el predicado no puede
  // decir "la ventana está vacía" sobre un caso en que el copy dice otra cosa. Reimplementarlo con
  // `includes("escrow_not_found")` pone estos dos asserts en rojo.
  it("respeta la precedencia cuando un código trae DOS subcadenas", () => {
    for (const code of [
      "escrow_refund_signature_incomplete: escrow_not_found",
      "user rejected — escrow_not_found",
    ]) {
      expect(esVentanaSinAbiertos(code, MAX_RECOVERY_CANDIDATES)).toBe(false);
      // Y la prueba de que es la MISMA decisión: el copy tampoco es el de "no hay abiertos".
      expect(lostEscrowRecoveryError(code, MAX_RECOVERY_CANDIDATES)).not.toBe(
        sinAbiertosCopy(MAX_RECOVERY_CANDIDATES),
      );
    }
  });

  // La extracción del texto fue PURA: `sinAbiertosCopy` es exactamente lo que la función devolvía.
  it("sinAbiertosCopy ES el texto que lostEscrowRecoveryError devuelve para escrow_not_found", () => {
    expect(lostEscrowRecoveryError("escrow_not_found", MAX_RECOVERY_CANDIDATES)).toBe(
      sinAbiertosCopy(MAX_RECOVERY_CANDIDATES),
    );
    // Y el número sale del parámetro, no de un literal: llamado con otro valor, el texto lo refleja.
    expect(sinAbiertosCopy(7)).toContain("los últimos 7 envíos");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-347-14 / T-347-16 / T-347-17 · WKH-347 — LOS DOS CÓDIGOS NUEVOS DEL ÍNDICE ON-CHAIN
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ⛔ ESTE BLOQUE VA AL FINAL DEL ARCHIVO, y no es prolijidad. `http-pop-signer.ts:33` está marcado
// NO-TOUCH y cita `flow-vm.test.ts:520` POR NÚMERO, y ese archivo está fuera del Scope IN de esta HU.
// Cualquier inserción aguas arriba de esa línea la rompe, y ningún guard la mira porque es prosa. MEDIDO
// en esta misma HU: la primera versión de este bloque estaba arriba y desplazó `:520` a `:595`.
// ⛔ Antes de insertar acá arriba, buscá quién cita este archivo por número de línea.
describe("flow-vm — los desenlaces del índice on-chain (WKH-347)", () => {
  // Los códigos van escritos A MANO, igual que `CODIGOS_DEL_REGISTRO_MUDO`: si salieran de la función
  // vigilada, el test se aplaudiría a sí mismo.
  const CODIGOS_DEL_INDICE = ["escrow_index_absent", "escrow_index_unreadable"] as const;

  // 🔴 T-347-16 — EL CONTROL DE ORDEN DE RAMAS PARA LAS DOS RAMAS NUEVAS. Se insertaron DELANTE de
  // `escrow_not_found`, y el argumento de que eso es seguro es que ninguno de los dos literales contiene
  // esa subcadena. Eso NO se supone: se asserta acá, porque es lo único que impide que un rename futuro
  // (digamos `escrow_not_found_in_index`) le robe los casos a la rama de abajo en silencio.
  it("T-347-16 (AC-11): los códigos del índice NO contienen escrow_not_found y no le roban casos", () => {
    for (const code of CODIGOS_DEL_INDICE) {
      expect(code).not.toContain("escrow_not_found");
      // Y el desenlace real: cada uno sale por SU texto, no por el de la ventana vacía.
      const copy = lostEscrowRecoveryError(code, MAX_RECOVERY_CANDIDATES);
      expect(copy).not.toBe(sinAbiertosCopy(MAX_RECOVERY_CANDIDATES));
      expect(copy).not.toContain("No encontramos escrows abiertos");
      expect(copy).not.toContain("aceptá la firma");
    }
    // Los dos textos son DISTINTOS entre sí: colapsarlos diría lo mismo sobre "la cadena contestó que no
    // hay índice" y "no pudimos leer el índice", que autorizan afirmaciones distintas.
    const [ausente, ilegible] = CODIGOS_DEL_INDICE.map((c) =>
      lostEscrowRecoveryError(c, MAX_RECOVERY_CANDIDATES),
    );
    expect(ausente).not.toBe(ilegible);
    // Y ninguno de los dos cae en la red de seguridad, que es lo que pasaría si la rama no existiera.
    // Sin este assert, los `not.toBe` de arriba los satisface el texto genérico de "algo se cortó".
    expect(ausente).not.toContain("Algo se cortó antes de terminar");
    expect(ilegible).not.toContain("Algo se cortó antes de terminar");
  });

  // 🔴 T-347-16 (segunda mitad) — LOS DOS CÓDIGOS SE SEPARAN ACÁ, y hasta el fix-pack los dos daban
  // `false`. Eso era un defecto medido (AR/BLQ-1): al desplegar, ninguna billetera existente tiene
  // índice, así que `escrow_index_absent` es lo que contesta TODA búsqueda posterior a una recuperación
  // exitosa ⇒ la tarjeta de cierre de ventana de WKH-346 no se prendía para nadie, y el final exitoso
  // del camino se pintaba con el color del error. Antes de esta HU ese mismo click daba
  // `escrow_not_found` y sí la prendía.
  //
  // La línea es el TRI-ESTADO, no la comodidad: `absent` es una RESPUESTA de la cadena (y a ese código
  // se llega con la ventana del servidor ya recorrida y sin ninguno abierto), `unreadable` es no haber
  // podido preguntarle. El primero autoriza la tarjeta; el segundo no autoriza nada.
  it("T-347-16 (AC-11/fix-pack): el índice AUSENTE prende el cierre de ventana; el ILEGIBLE no", () => {
    expect(esVentanaSinAbiertos("escrow_index_absent", MAX_RECOVERY_CANDIDATES)).toBe(true);
    expect(esVentanaSinAbiertos("escrow_index_unreadable", MAX_RECOVERY_CANDIDATES)).toBe(false);
    // Control positivo y control negativo, sin los cuales lo de arriba lo daría media función: el código
    // que SÍ es "la ventana no tiene ninguno abierto" sigue dando `true`, y "no llegamos a preguntar"
    // sigue dando `false`.
    expect(esVentanaSinAbiertos("escrow_not_found", MAX_RECOVERY_CANDIDATES)).toBe(true);
    expect(esVentanaSinAbiertos("escrow_recovery_unavailable:pop_disabled", MAX_RECOVERY_CANDIDATES)).toBe(
      false,
    );
    // Y que sigue DELEGANDO en vez de re-clasificar: el predicado es cierto exactamente cuando el copy es
    // una de las DOS copias que significan "se miró y no hay ninguno abierto". Con un
    // `code.includes(...)` propio esta igualdad se puede violar sin que nada más se ponga rojo.
    expect(lostEscrowRecoveryError("escrow_index_absent", MAX_RECOVERY_CANDIDATES)).toBe(
      sinIndiceCopy(MAX_RECOVERY_CANDIDATES),
    );
  });

  // 🔴 T-347-17 (AC-8/CD-8) — LO QUE ESTOS TEXTOS NO PUEDEN DECIR. Las tres frases prohibidas son las
  // tres formas de afirmar de más que esta HU tiene enfrente: negar los fondos de la persona, negar que
  // haya envíos, y prometer que el problema ya no puede pasar. La tercera es la que más tienta al
  // escribir el copy de una HU que "arregla" algo: esta HU NO vuelve imposible el depósito huérfano, lo
  // vuelve ENCONTRABLE, y el copy no puede insinuar lo primero.
  it("T-347-17 (AC-8/CD-8): los textos del índice no afirman sobre los fondos ni prometen imposibles", () => {
    for (const code of CODIGOS_DEL_INDICE) {
      const copy = lostEscrowRecoveryError(code, MAX_RECOVERY_CANDIDATES);
      expect(copy).not.toContain("no tenés");
      expect(copy).not.toContain("no hay envíos");
      expect(copy).not.toContain("ya no puede pasar");
      // Y la propiedad POSITIVA, sin la cual las tres negaciones las satisface un texto vacío: los dos
      // dicen explícitamente que esto no responde sobre los fondos. La regexp es case-insensitive porque
      // los dos textos lo dicen en posiciones distintas de la oración ("No es..." al empezar una frase en
      // uno, "Esto no es..." en el otro), y lo que importa es la afirmación, no la mayúscula.
      expect(copy).toMatch(/no es una respuesta sobre tus fondos/i);
    }
  });

  // 🔴 LA CLÁUSULA QUE CIERRA LA OBJECIÓN DEL GATE, y tiene test propio porque es la primera que se cae
  // al "pulir" el copy. `escrow_index_absent` es compatible con TRES historias, y una es que el depósito
  // ocurrió y NOSOTROS no pudimos registrarlo (índice lleno, o sonda ilegible). Sin esa cláusula el texto
  // le echaría la culpa a la persona por algo que hicimos nosotros.
  it("T-347-17: el texto de índice ausente nombra las TRES historias, incluida la culpa nuestra", () => {
    const copy = lostEscrowRecoveryError("escrow_index_absent", MAX_RECOVERY_CANDIDATES);
    expect(copy).toContain("nunca depositaste");
    expect(copy).toContain("antes de que empezáramos a registrar");
    expect(copy).toContain("no pudimos registrarlo"); // 🔑 la que cierra la objeción del gate
  });

  // 🔴 FIX-PACK AR/BLQ-1 — LA MITAD DEL LEDGER NO SE PUEDE PERDER. El texto de índice ausente arrancaba
  // con "Eso pasa si nunca depositaste", y hay un input pinneado (`solana-wallet.refund.test.ts`: el
  // registro contesta `answered` con dos remesas `Released`) en que el navegador tiene, en ese mismo
  // instante, el dato que matiza esa historia. La frase no era falsa por sí sola; lo falso era ofrecerla
  // PRIMERA descartando lo que ya sabíamos.
  //
  // 🔴 EL MUTANTE QUE ESTO CAZA, y es el texto anterior tal cual: "En la cadena no hay un índice de
  // envíos para esta billetera. Eso pasa si nunca depositaste, y también si...". Con él, los tres
  // asserts de abajo se caen (no nombra la ventana del servidor, no nombra el número, y pone la historia
  // refutable adelante). Sin ellos, T-347-17 lo dejaba pasar entero.
  it("T-347-17 (fix-pack): el texto de índice ausente dice PRIMERO lo que el ledger contestó", () => {
    const copy = sinIndiceCopy(MAX_RECOVERY_CANDIDATES);
    // (1) La mitad del ledger está, y es una AFIRMACIÓN sobre lo que se recorrió, no una hipótesis.
    expect(copy).toContain(`los últimos ${MAX_RECOVERY_CANDIDATES} envíos`);
    expect(copy).toMatch(/ninguno está abierto/);
    // (2) Va PRIMERO que la del índice. El orden es lo que la HU rompió y lo que este assert fija.
    expect(copy.indexOf(`los últimos ${MAX_RECOVERY_CANDIDATES} envíos`)).toBeLessThan(
      copy.indexOf("no hay un índice"),
    );
    // (3) Y la historia que nuestro propio dato puede refutar NO va primera de las tres.
    expect(copy.indexOf("nunca depositaste")).toBeGreaterThan(copy.indexOf("no pudimos registrarlo"));
    // (4) El número sale del PARÁMETRO y no de un literal (CD-17): con otro valor, otro texto.
    expect(sinIndiceCopy(7)).toContain("los últimos 7 envíos");
    expect(sinIndiceCopy(7)).not.toContain(`los últimos ${MAX_RECOVERY_CANDIDATES} envíos`);
  });

  // 🔴 FIX-PACK AR/BLQ-2 — "PREGUNTÉ UNA DE LAS DOS Y ME CONTESTÓ" NO ES "NO LLEGAMOS A PREGUNTAR". El
  // texto decía literalmente "así que no llegamos a preguntar" en un input en que el registro durable
  // había contestado: convertía una respuesta PARCIAL en una no-respuesta total. Es la recíproca de la
  // regla que este repo ya tiene escrita, y se rompe igual de fácil.
  //
  // 🔴 EL MUTANTE QUE ESTO CAZA: volver al texto anterior ("No pudimos leer tu índice de envíos en la
  // cadena, así que no llegamos a preguntar. ..."). Pone en rojo los asserts (1) y (2).
  it("T-347-17 (fix-pack): el texto de índice ilegible NO niega haber preguntado, y dice cuál fuente falló", () => {
    const copy = indiceIlegibleCopy();
    // (1) No niega la pregunta que SÍ se hizo.
    expect(copy).not.toContain("no llegamos a preguntar");
    // (2) Nombra la fuente que contestó y la que no. Las dos mitades, no una.
    expect(copy).toMatch(/registro de envíos guardados/);
    expect(copy).toMatch(/no pudimos leer/i);
    expect(copy).toMatch(/quedó sin revisar/);
    // (3) Y lo que no puede perder: sigue sin afirmar sobre los fondos y sigue ofreciendo reintentar, que
    // es lo único accionable cuando la falla es de lectura.
    expect(copy).toMatch(/no es una respuesta sobre tus fondos/i);
    expect(copy).toContain("probá de nuevo en un rato");
    // (4) Y NO nombra el número de la ventana: acá la búsqueda no terminó, y "ninguno de los últimos N"
    // al lado de un índice ilegible se lee como si la pregunta estuviera cerrada. El mismo control, de
    // punta a punta, está en el caso E de `refund-perdido-registro-mudo.test.tsx`.
    expect(copy).not.toContain(`los últimos ${MAX_RECOVERY_CANDIDATES} envíos`);
    // (5) Es el copy que sale por el código, no uno paralelo que nadie usa.
    expect(lostEscrowRecoveryError("escrow_index_unreadable", MAX_RECOVERY_CANDIDATES)).toBe(copy);
  });

  // 🔴 T-347-14 (CD-17) — EL NÚMERO DEL COPY SALE DE LA CONSTANTE, NO DE UN LITERAL.
  //
  // 🔴 ESTE TEST DECLARABA CAZAR UN MUTANTE QUE SOBREVIVÍA (fix-pack CR/BLQ-4). Sus tres asserts
  // ejercitaban el FORMATEADOR (`formatLamportsAsSol` contra dos números) y no al productor del copy: no
  // llamaban a `humanError` ni renderizaban nada. MEDIDO: reemplazando la interpolación de
  // `solana_sender_sol_insufficient` por el literal `0,0089`, este test pasaba, el guard hermano de más
  // arriba ("nombra el faltante en SOL y no se confunde con un fallo de entrega") pasaba, y la suite
  // COMPLETA quedaba verde. Ningún test del repo cazaba el hardcode.
  //
  // ⚠️ Y EL ARREGLO OBVIO TAMPOCO ALCANZA, que es lo que hace falta escribir para que nadie lo "simplifique":
  // `expect(humanError(...)).toContain(formatLamportsAsSol(SENDER_MIN))` es exactamente el guard de arriba
  // y sobrevive igual, porque con el umbral REAL la interpolación y el literal producen la MISMA cadena.
  // Un literal sólo se distingue de una derivación evaluando el copy con OTRO umbral, y eso pide
  // re-importar el módulo con la constante cambiada. Es lo que hace la segunda mitad de este test.
  it("T-347-14 (AC-7/CD-17): el copy del umbral SIGUE a la constante, y un literal escrito a mano lo pone en rojo", async () => {
    // Primera mitad: hoy el copy dice el número que el guard compara.
    expect(humanError("solana_sender_sol_insufficient")).toContain(
      formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEPOSIT),
    );
    expect(formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEPOSIT)).toBe("0,0089"); // el valor de hoy, para que el diff lo muestre

    // Segunda mitad: el MISMO copy, con OTRO umbral. El valor es arbitrario y da una cadena que no
    // colisiona con ninguna de las que este flujo muestra; el esperado NO se escribe a mano, se formatea
    // con la función real (que sigue siendo la de verdad: el mock cambia sólo la constante).
    const OTRO_UMBRAL = 12_345_678;
    vi.resetModules();
    vi.doMock("../application/solana-escrow-rent", async (original) => ({
      ...(await original<typeof import("../application/solana-escrow-rent")>()),
      SENDER_MIN_LAMPORTS_FOR_DEPOSIT: OTRO_UMBRAL,
    }));
    try {
      const { humanError: humanErrorConOtroUmbral } = await import("./flow-vm");
      const copy = humanErrorConOtroUmbral("solana_sender_sol_insufficient");
      expect(copy).toContain(formatLamportsAsSol(OTRO_UMBRAL));
      // 🔴 EL ASSERT QUE MATA AL MUTANTE: con el número escrito a mano, el copy sigue diciendo "0,0089"
      // aunque el umbral sea otro, y esta línea se pone roja.
      expect(copy).not.toContain(formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEPOSIT));
    } finally {
      vi.doUnmock("../application/solana-escrow-rent");
      vi.resetModules();
    }
  });
});

// WKH-349 — la segunda capa de conocimiento del historial: qué dice una fila cuando el snapshot local
// no puede afirmar nada y la CADENA sí contestó.
//
// 🔴 REGLA DE ESTE BLOQUE (CD-12): cada test nombra, en su propio comentario, la edición plausible que
// lo pone en rojo. Un test que no puede nombrar su mutante no es cobertura, es decorado.
describe("WKH-349 · escrowOutcome / escrowOutcomeDisplay", () => {
  const rem = (s: Partial<RemittanceState>): RemittanceState =>
    ({ status: "created", principalTx: null, refundTx: null, failureReason: null, ...s }) as RemittanceState;

  // Una remesa por cada valor de EscrowKnowledge, construida con el MISMO input que la produce en
  // producción (marcadores reales, no un cast al valor deseado): si `escrowFundsKnowledge` cambiara de
  // criterio, estos fixtures dejan de representar lo que dicen y el bloque entero se cae.
  const FIXTURES: Record<EscrowKnowledge, RemittanceState> = {
    "no-deposit": rem({ status: "created" }),
    "in-escrow": rem({ status: "payout_failed", failureReason: PRINCIPAL_SETTLED_REFUND_MANUAL }),
    returned: rem({ status: "refunded", failureReason: ESCROW_REFUNDED_BY_SENDER }),
    unverified: rem({ status: "principal_in", principalTx: "sig" }),
  };
  const KNOWLEDGES = Object.keys(FIXTURES) as EscrowKnowledge[];

  // Todos los valores de EscrowChainAnswer: los que la cadena puede contestar más los dos que hablan
  // de la PREGUNTA. 🔴 SE DERIVA DE UN `Record` EXHAUSTIVO, igual que KNOWLEDGES cinco líneas más
  // arriba, y por el motivo medido en esta misma HU: cuando esto era un array escrito a mano, agregar
  // un valor al tipo dejaba a T-V6 verde mirando un valor menos — el candado de totalidad dejaba de
  // mirar justo el valor nuevo. Con la anotación, el que falte es un error de `tsc`.
  const ANSWER_SET: Record<EscrowChainAnswer, true> = {
    "deposited-window-open": true,
    "deposited-window-closed": true,
    released: true,
    refunded: true,
    absent: true,
    unknown: true,
    pending: true,
    "not-asked": true,
  };
  const ANSWERS = Object.keys(ANSWER_SET) as EscrowChainAnswer[];

  // Ídem para los desenlaces de pantalla: los 4 locales + los de cadena. Es lo que hace que T-V7
  // recorra TODAS las frases que la HU puede producir sin que nadie tenga que contarlas.
  const OUTCOME_SET: Record<EscrowOutcome, true> = {
    "no-deposit": true,
    "in-escrow": true,
    returned: true,
    unverified: true,
    "chain-deposited-window-open": true,
    "chain-deposited-window-closed": true,
    "chain-released": true,
    "chain-refunded": true,
    "chain-absent": true, "chain-absent-after-deposit": true,
    "chain-unknown": true,
    "chain-pending": true,
  };
  const OUTCOMES = Object.keys(OUTCOME_SET) as EscrowOutcome[];

  // 🔴 T-V1 (AC-6, AC-8) — EL CORTE VA PRIMERO.
  // MUTANTE: mover `if (k !== "unverified") return k` DEBAJO del mapeo. Una respuesta de cadena
  // pisaría un marcador local ya escrito — el caso concreto: `returned` (el refund se confirmó y se
  // anotó) con la PDA todavía en `Deposited`, porque `refund` no cierra la cuenta.
  it("T-V1: un desenlace que el snapshot local ya resolvió NO lo pisa ninguna respuesta de cadena", () => {
    for (const k of ["no-deposit", "in-escrow", "returned"] as EscrowKnowledge[]) {
      for (const a of ANSWERS) {
        expect(escrowOutcome(FIXTURES[k], a)).toBe(k);
      }
    }
    // Y el cuarto valor local: `unverified` sin pregunta emitida sigue siendo `unverified`, no un
    // desenlace de cadena inventado.
    expect(escrowOutcome(FIXTURES.unverified, "not-asked")).toBe("unverified");
  });

  // 🔴 T-V2 (AC-2/3/4) — EL MAPEO ES 1:1 Y NO ESTÁ CRUZADO.
  // MUTANTE: `released → chain-refunded` (o cualquier permutación). Cada respuesta se assertea contra
  // SU desenlace, así que un cruce pone en rojo dos líneas a la vez.
  it("T-V2: sobre una fila `unverified`, las cuatro respuestas con cuenta mapean cada una a su desenlace", () => {
    expect(escrowOutcome(FIXTURES.unverified, "deposited-window-open")).toBe(
      "chain-deposited-window-open",
    );
    expect(escrowOutcome(FIXTURES.unverified, "deposited-window-closed")).toBe(
      "chain-deposited-window-closed",
    );
    expect(escrowOutcome(FIXTURES.unverified, "released")).toBe("chain-released");
    expect(escrowOutcome(FIXTURES.unverified, "refunded")).toBe("chain-refunded");
  });

  // 🔴 T-V3 (AC-5) — "NO PUDIMOS PREGUNTAR" NO SE COLAPSA CON NINGUNA RESPUESTA.
  // MUTANTE: mapear `unknown` a `chain-absent`, a `no-deposit` o dejarlo caer en el copy de
  // `unverified`. Se assertea DESIGUALDAD DE CADENAS, no el texto lindo: el test no opina sobre cómo
  // está redactada la frase, sólo sobre que no sea la misma que la de otro desenlace.
  it("T-V3: `unknown` es su propio desenlace y su copy no es el de absent, no-deposit ni unverified", () => {
    expect(escrowOutcome(FIXTURES.unverified, "unknown")).toBe("chain-unknown");
    const desconocido = escrowOutcomeDisplay("chain-unknown").copy;
    expect(desconocido).not.toBe(escrowOutcomeDisplay("chain-absent").copy);
    expect(desconocido).not.toBe(escrowKnowledgeCopy("no-deposit"));
    expect(desconocido).not.toBe(escrowKnowledgeCopy("unverified"));
  });

  // 🔴 T-V4 (CD-2) — "LA CADENA CONTESTÓ QUE NO HAY CUENTA" TAMPOCO ES UNA CONCLUSIÓN SOBRE LA PLATA.
  // MUTANTE: `absent → chain-released` ("ya se cerró, seguro fue una entrega"), la conclusión tentadora y no medida.
  // WKH-352: el fixture va SIN `principalTx` a propósito — con la prueba del depósito la rama es otra (T-W1).
  it("T-V4: `absent` es su propio desenlace y su copy no es el de unknown, released ni refunded", () => {
    expect(escrowOutcome(rem({ status: "confirmed" }), "absent")).toBe("chain-absent");
    const ausente = escrowOutcomeDisplay("chain-absent").copy;
    expect(ausente).not.toBe(escrowOutcomeDisplay("chain-unknown").copy);
    expect(ausente).not.toBe(escrowOutcomeDisplay("chain-released").copy);
    expect(ausente).not.toBe(escrowOutcomeDisplay("chain-refunded").copy);
  });

  // 🔴 T-V5 (AC-2) — LA MITAD VISUAL DEL DESENLACE.
  // MUTANTE (a): devolver `"normal"` para todos. El texto seguiría estando y AC-2 perdería su mitad:
  // la fila que TIENE plata adentro se leería con el mismo peso que aquélla de la que no sabemos nada.
  // MUTANTE (b): darle `"normal"` al vencido, que lo dibujaría gris al lado del abierto en negrita
  // — y las dos tienen plata adentro. El peso separa "hay plata" de "no hay nada que hacer", no
  // "urgente" de "no urgente".
  // El conjunto se recorre ENTERO (OUTCOMES sale del `Record` exhaustivo), así que un `strong` de más
  // en cualquier otro desenlace también cae acá.
  it("T-V5: los `strong` son EXACTAMENTE los dos `chain-deposited-*`; todo el resto es `normal`", () => {
    const fuertes = OUTCOMES.filter((o) => escrowOutcomeDisplay(o).emphasis === "strong").sort();
    expect(fuertes).toEqual(["chain-deposited-window-closed", "chain-deposited-window-open"]);
  });

  // 🔴 T-V6 (AC-1, totalidad) — NINGÚN HUECO EN EL PRODUCTO.
  // MUTANTE: un `switch` sin `default` (o una cadena de `if` sin retorno final) que caiga por un hueco
  // y devuelva `undefined`. La fila lo dibujaría como una tarjeta sin frase.
  // ⚠️ EL `expect(pares)` DEL FINAL NO ES UN CANDADO, Y ACÁ ANTES SE LO PRESENTABA COMO SI LO FUERA:
  // `pares` se incrementa UNA VEZ POR ITERACIÓN del mismo producto que después se compara, así que no
  // puede fallar nunca. Se deja porque documenta la forma del recorrido, pero no prueba nada.
  // EL CANDADO REAL de que el recorrido cubra TODOS los valores del tipo es `ANSWER_SET`
  // (`ANSWER_SET`, `:1601`), un `Record<EscrowChainAnswer, true>`: un valor nuevo en el tipo y sin
  // entrada ahí es un error de `tsc`, no un test verde mirando un valor menos. Lo mismo `FIXTURES`
  // para `KNOWLEDGES`. Un `toBe(28)` clavado acá tampoco servía: esta misma HU le agregó un valor al
  // tipo y el número correcto pasó de 28 a 32 — habría envejecido igual que una cita.
  // Los asserts que SÍ miden están ADENTRO del loop: `toBeDefined` y el copy no vacío.
  it("T-V6: el producto de conocimientos × respuestas no tiene ningún hueco, y ninguno es undefined", () => {
    let pares = 0;
    for (const k of KNOWLEDGES) {
      for (const a of ANSWERS) {
        const o = escrowOutcome(FIXTURES[k], a);
        expect(o).toBeDefined();
        // Y su display también es total: un desenlace sin copy es una fila muda.
        expect(typeof escrowOutcomeDisplay(o).copy).toBe("string");
        expect(escrowOutcomeDisplay(o).copy.length).toBeGreaterThan(0);
        pares += 1;
      }
    }
    expect(pares).toBe(KNOWLEDGES.length * ANSWERS.length);
  });

  // 🔴 T-V7 (AC-9, CD-1) — LA PANTALLA DICE EL ESTADO, NO PROMETE UNA OPERACIÓN.
  // MUTANTE: reescribir un copy como "Te devolvimos tus USDC" o "Recuperamos tus USDC".
  // ⚠️ LO QUE ESTE TEST CUBRE, EXACTO: esos SIETE verbos, no "toda promesa de acción". Una frase como
  // "Vamos a sacar tus USDC" pasa este candado. Si alguien quiere la afirmación amplia, tiene que
  // escribir el candado amplio (CD-12): declarar acá que cubre más de lo que cubre sería el defecto.
  it("T-V7: ninguna frase producible por esta capa usa uno de los siete verbos de acción sobre el dinero", () => {
    const VERBOS = /\b(recuperamos|liberamos|devolvimos|entregamos|depositamos|movimos|sacamos)\b/i;
    // Se recorren TODOS los desenlaces del tipo (OUTCOMES sale del `Record` exhaustivo), así que un
    // valor nuevo entra a este candado sin que nadie se acuerde de agregarlo a una lista.
    const todas = OUTCOMES.map((o) => escrowOutcomeDisplay(o).copy);
    expect(todas).toHaveLength(OUTCOMES.length);
    for (const frase of todas) expect(frase).not.toMatch(VERBOS);
    // El control del candado: los siete verbos SÍ se detectan cuando están. Sin esto, una regex rota
    // (o una que no matchea nada) dejaría este test verde sobre cualquier copy.
    expect("Recuperamos tus USDC").toMatch(VERBOS);
  });

  // 🔴 T-V8 (AC-9) — "ENTREGADO" ES DE OTRA COSA, Y DESDE WKH-351 TAMBIÉN DE OTRA PANTALLA.
  // MUTANTE: escribir el copy de `chain-released` como "Ya entregado". Colisionaría con el Pill de
  // `statusDisplay("settled")`, que dice "Entregado" sobre OTRO hecho: que el partner de payout
  // reportó haber entregado los PEN, no que el vault salió del escrow. Ese Pill hoy vive en el recibo.
  it("T-V8: el copy de `chain-released` no dice 'entregado', que es la palabra del Pill", () => {
    const copy = escrowOutcomeDisplay("chain-released").copy;
    expect(copy).not.toContain("Entregado");
    expect(copy).not.toContain("entregado");
    // El control del test: la palabra SÍ existe en la tarjeta, y sale de la otra función. Sin esto,
    // el assert de arriba pasaría igual en un repo donde "Entregado" no se usara en ningún lado.
    expect(statusDisplay("settled").label).toBe("Entregado");
  });

  // 🔴 T-V9 — LOS 4 COPIES LOCALES SE DELEGAN, NO SE COPIAN.
  //
  // ⚠️ ESTE TEST NO ESTÁ EN §11 DEL STORY FILE (que enumera T-V1..T-V8): es UNO DE MÁS, y va declarado
  // como tal en vez de ajustar el conteo de la HU. Existe porque §4.3 exige delegar en
  // `escrowKnowledgeCopy` y no dejaba candado para esa exigencia.
  // MUTANTE: pegar las cuatro frases dentro de `escrowOutcomeDisplay`. Da verde el día del copy&paste
  // y queda diciendo una frase vieja el día que `escrowKnowledgeCopy` cambie la suya. Este assert
  // compara BYTE A BYTE contra el productor de siempre, así que la divergencia lo pone en rojo.
  it("T-V9 (extra, fuera de §11): los desenlaces locales devuelven exactamente la frase de escrowKnowledgeCopy", () => {
    for (const k of KNOWLEDGES) {
      expect(escrowOutcomeDisplay(k)).toEqual({ copy: escrowKnowledgeCopy(k), emphasis: "normal" });
    }
  });

  // 🔴 T-V10 (AC-11, AC-2) — LA VENTANA VENCIDA ES SU PROPIO DESENLACE, NO UN `Deposited` MÁS.
  // MUTANTE (a): mapear los dos `deposited-*` a UNA RAMA COMÚN ("total, en las dos hay plata"). Es la
  // edición tentadora y borra toda la ampliación: la fila con la ventana vencida volvería a decir sólo
  // que sus USDC siguen adentro, sin decir que la única puerta que le queda es la devolución.
  // MUTANTE (b): darle `emphasis: "normal"` al vencido, que lo dibujaría gris al lado del abierto en
  // negrita — y las dos filas tienen plata adentro.
  it("T-V10: `deposited-window-closed` tiene desenlace, copy y peso propios, y sigue pesando strong", () => {
    expect(escrowOutcome(FIXTURES.unverified, "deposited-window-closed")).toBe(
      "chain-deposited-window-closed",
    );

    const vencida = escrowOutcomeDisplay("chain-deposited-window-closed");
    const abierta = escrowOutcomeDisplay("chain-deposited-window-open");

    // El copy es OTRO — es lo único que separa las dos filas en la pantalla.
    expect(vencida.copy).not.toBe(abierta.copy);
    // Y tampoco es ninguno de los otros cinco desenlaces de cadena: si el VM no ramificara el valor
    // nuevo, caería en el `return "chain-unknown"` final y diría "no pudimos preguntar" sobre una fila
    // que SÍ contestó.
    for (const otro of [
      "chain-released",
      "chain-refunded",
      "chain-absent",
      "chain-unknown",
      "chain-pending",
    ] as const) {
      expect(vencida.copy).not.toBe(escrowOutcomeDisplay(otro).copy);
    }
    // Las dos pesan igual: el peso dice "hay plata", no "es urgente".
    expect(vencida.emphasis).toBe("strong");
    expect(abierta.emphasis).toBe("strong");
  });
});

/**
 * WKH-350 · LA AGRUPACIÓN DEL HISTORIAL, DEL LADO PURO.
 *
 * Estos tres tests fijan el par (texto del encabezado, conjunto de miembros) en LAS DOS MITADES: los
 * cuatro literales están escritos a mano acá y los cuatro conjuntos también. Cambiar una sola mitad en
 * producción los pone rojos.
 *
 * ⚠️ HASTA DÓNDE LLEGA ESTE CANDADO, dicho para que nadie lo sobreestime: NO puede juzgar si un par
 * NUEVO es honesto. Si alguien cambia las dos mitades a la vez y de forma coherente, o sea un
 * encabezado mentiroso con miembros que le calzan, ESTOS TESTS SE PONEN VERDES. Lo único que eliminan
 * es el drift de una mitad respecto de la otra, que es como esto se rompe en la práctica. CD-10 sigue
 * necesitando un humano en la revisión.
 *
 * 🔴 REGLA DEL ARCHIVO: cada test nombra la edición plausible que lo pone en rojo.
 */
describe("WKH-350 · agrupación del historial", () => {
  // 🔴 T-H1 (AC-4, AC-5) — LOS 4 ENCABEZADOS Y SU ORDEN, COMO LITERALES ESCRITOS ACÁ.
  // No se derivan del módulo a propósito: un test que le pregunta al código qué texto produce y
  // después verifica que produjo ese texto es un guard que se compara consigo mismo.
  // MUTANTE: cambiar cualquiera de los 4 textos en producción. Por ejemplo el tercero a "Resueltos",
  // que es justo el encabezado que la revisión sacó por afirmar un final que sus miembros no tienen.
  // Otro mutante que mata: reordenar HISTORY_GROUP_ORDER, alfabético o invertido.
  it("T-H1: los 4 encabezados y el orden de render son exactamente los acordados", () => {
    expect(HISTORY_GROUP_HEADING.firma).toBe("Necesitan tu firma");
    expect(HISTORY_GROUP_HEADING["con-plata"]).toBe("Con plata en el escrow");
    expect(HISTORY_GROUP_HEADING["sin-plata"]).toBe("Sin plata en el escrow");
    expect(HISTORY_GROUP_HEADING["sin-respuesta"]).toBe("Sin respuesta sobre tu plata");
    expect(HISTORY_GROUP_ORDER).toEqual(["firma", "con-plata", "sin-plata", "sin-respuesta"]);
  });

  // 🔴 T-H2 (CD-10, mitad temporal) — UNA RED CONTRA EL VOCABULARIO TEMPORAL, NO UNA PRUEBA.
  // Ninguna de las filas que caen en estos grupos sostiene una afirmación sobre el tiempo: a
  // `in-escrow` no se le pregunta a la cadena, así que no se sabe si está en plazo, y la frase por
  // fila de `chain-deposited-window-open` calla el plazo a propósito.
  //
  // ⚠️ LA LISTA NO ES EXHAUSTIVA Y NO PUEDE SERLO, y por eso el test se llama como se llama. Lo que
  // verifica es "ninguno de los 4 encabezados contiene una de ESTAS cadenas", no "ningún encabezado
  // habla del tiempo": el castellano tiene más formas de decirlo que las que a alguien se le
  // ocurrieron un martes. Un encabezado temporal escrito con una palabra que no está acá pasa VERDE.
  // Leer su verde como "CD-10 está cerrado" es el error que esta advertencia existe para frenar; CD-10
  // se cierra en la revisión humana, esto sólo abarata las reincidencias.
  //
  // ⚠️ Y LA LISTA ARRANCÓ SIN LA PALABRA DEL PROPIO DOMINIO. Medido en la revisión de esta HU: con
  // `"con-plata": "Con plata en el escrow, ventana abierta"` —o sea el vocabulario literal del código,
  // `deposited-window-open` / `deposited-window-closed`, que es la redacción MÁS probable de la
  // recaída— este test daba verde. Por eso están ahora `ventana`, `ahora`, `hoy`, `día`, `ya` y
  // `reciente`: no porque completen nada, sino porque eran los agujeros más transitados.
  // MUTANTE: reintroducir el encabezado que la revisión sacó, "Con plata en el escrow, todavía en
  // plazo". Rojo por "todavía" y por "plazo". O el de arriba, con "ventana".
  it("T-H2: ningún encabezado contiene ninguna de estas palabras temporales (lista NO exhaustiva)", () => {
    const PROHIBIDAS = [
      "plazo",
      "vence",
      "venci",
      "venció",
      "todavía",
      "todavia",
      "aún",
      "aun ",
      "a tiempo",
      "deadline",
      "expira",
      "caduca",
      "tiempo",
      "pronto",
      // Agregadas en el fix-pack: el vocabulario del propio dominio y los adverbios de todos los días.
      // `ya` y `aun` van con espacio a un lado porque son subcadenas de palabras enteras (`playa`,
      // `aunque`); el costo es que un encabezado que TERMINE en "ya" sin espacio detrás se escapa.
      "ventana",
      "ahora",
      "hoy",
      "día",
      "dia ",
      " ya",
      "ya ",
      "reciente",
      "mientras",
    ];
    const encontradas: string[] = [];
    for (const g of HISTORY_GROUP_ORDER) {
      const texto = HISTORY_GROUP_HEADING[g].toLowerCase();
      for (const p of PROHIBIDAS) if (texto.includes(p)) encontradas.push(`${g}: «${p}»`);
    }
    expect(encontradas).toEqual([]);
  });

  // 🔴 T-H3 (CD-10, mitad de pertenencia) — QUÉ DESENLACES VAN A CADA GRUPO, ESCRITO A MANO.
  // Los 4 conjuntos suman los 12 EscrowOutcome, sin solapamiento y sin sobrantes. El `Record`
  // exhaustivo de abajo es lo que hace que "sin sobrantes" lo verifique `tsc` y no mi memoria: si el
  // tipo gana un valor y nadie lo agrega acá, este archivo deja de compilar.
  // MUTANTES, cualquiera de los tres pone rojo: mover `chain-released` a "con-plata" (haría que "Con
  // plata en el escrow" mienta sobre una fila cuya plata ya salió); mover `unverified` a "con-plata"
  // ("probablemente tenga plata" es justo la invención que AC-7 prohíbe); mover `no-deposit` a
  // "sin-respuesta" (sí hubo respuesta: nunca se depositó).
  it("T-H3: cada uno de los 12 desenlaces cae en su grupo, sin solapamiento y sin sobrantes", () => {
    const ESPERADO: Record<HistoryGroup, EscrowOutcome[]> = {
      firma: ["chain-deposited-window-closed"],
      "con-plata": ["in-escrow", "chain-deposited-window-open"],
      "sin-plata": ["returned", "chain-refunded", "chain-released", "no-deposit"],
      "sin-respuesta": ["unverified", "chain-pending", "chain-absent", "chain-absent-after-deposit", "chain-unknown"],
    };
    // El universo, exhaustivo por `tsc`: los 4 locales + los 8 de cadena.
    const TODOS: Record<EscrowOutcome, true> = {
      "no-deposit": true,
      "in-escrow": true,
      returned: true,
      unverified: true,
      "chain-deposited-window-open": true,
      "chain-deposited-window-closed": true,
      "chain-released": true,
      "chain-refunded": true,
      "chain-absent": true, "chain-absent-after-deposit": true,
      "chain-unknown": true,
      "chain-pending": true,
    };
    // Cada miembro escrito a mano cae donde se dijo.
    for (const g of HISTORY_GROUP_ORDER) {
      for (const o of ESPERADO[g]) expect(historyGroupFor(o)).toBe(g);
    }
    // Sin solapamiento y sin sobrantes: los 4 conjuntos particionan los 12 valores del tipo.
    const escritos = HISTORY_GROUP_ORDER.flatMap((g) => ESPERADO[g]);
    expect(escritos).toHaveLength(12);
    expect(new Set(escritos).size).toBe(12);
    expect([...escritos].sort()).toEqual((Object.keys(TODOS) as EscrowOutcome[]).sort());
  });
});

/**
 * WKH-352 · LA FILA QUE YA TIENE LA PRUEBA DEL DEPÓSITO DEJA DE COMPARTIR LA FRASE AMBIGUA.
 *
 * 🔴 ACÁ VIVÍA UNA REGLA DE EDICIÓN EN PROSA, Y ERA FALSA EN SUS DOS MITADES (CR · MNR-2). Decía que
 * "SEIS citas `flow-vm.test.ts:NN` sin ancla" apuntaban a este bloque, y que "todo lo que se le agregue
 * va DEBAJO de la 1911". Medido con
 * `grep -rEon 'flow-vm\.test\.ts:[0-9]+(-[0-9]+)?' src app scripts contracts`: las citas externas eran
 * OCHO, con UNA sola anclada (la de `flow-vm.ts:1010` a `:481`), o sea SIETE sin ancla, no seis. Y la
 * séptima, escrita por esta misma HU, fijaba la 1935, que está DEBAJO de la 1911: el CR insertó una
 * línea en la 1920, que es exactamente lo que esa regla autorizaba, y el contenido citado se corrió de
 * 1935 a 1936 SIN UN SOLO ROJO, con `citas-ancladas.test.ts` en verde.
 *
 * EL ARREGLO NO FUE CORREGIR EL NÚMERO, FUE ANCLAR. Las cuatro citas externas que apuntan a CÓDIGO de
 * este archivo hoy llevan símbolo, así que las mira `citas-ancladas.test.ts` y un desplazamiento se
 * pone ROJO en vez de mentir: (`statusDisplay`, `:76-101`) y (`TODOS`, `:1902`) desde
 * `history-grupos.test.tsx`, y (`VERBOS`, `:1733-1736`) y (`escrowOutcomeDisplay`, `:1744`) desde
 * `history-onchain.test.tsx`. Las otras dos eran BOOKKEEPING de esta misma disciplina: una apuntaba a la
 * PROSA de este párrafo y la otra, desde `history-onchain.test.tsx`, listaba en qué líneas de acá vivían
 * las citas que la nombraban. Las dos se borraron de raíz, porque con las citas ancladas ese inventario
 * a mano no hace falta y era el que envejecía solo: de las tres afirmaciones que hacía el de
 * `history-onchain.test.tsx`, DOS eran falsas cuando se midieron. Cada una de las cuatro citas nuevas se
 * movió una línea y se comprobó el rojo; no es una atribución deducida.
 *
 * ⚠️ UN PUNTO CIEGO DEL CANDADO, ENCONTRADO ESCRIBIENDO ESTE ARREGLO: la cita anclada tiene que entrar
 * ENTERA EN UN RENGLÓN. `citas-ancladas.test.ts` matchea línea por línea, así que una cita partida en
 * dos no existe para él. Pasó acá mismo, en el docblock de `principal-tx-single-writer.static.test.ts`:
 * el símbolo quedó al final de un renglón y el archivo con su número al principio del siguiente, y el
 * candado la ignoró EN VERDE. Eso no figura en la lista de "lo que no cierra" de ese archivo, y no se
 * agregó ahí porque `wallet-error-code.ts` cita su línea 61 SIN ancla y un renglón de más arriba la
 * rompería en silencio, que es el mismo error que este párrafo documenta. Queda como deuda escrita.
 *
 * ⚠️ LA QUE NO SE PUDO ANCLAR, Y QUÉ QUEDÓ EN SU LUGAR. `http-pop-signer.ts:33` cita `:520` por número,
 * y ese archivo está fuera del Scope IN (NO-TOUCH): la cita no se puede reescribir desde acá. En su
 * lugar va un CANARIO anclado a esa misma línea, (`Buscar`, `:520`), donde `Buscar` es el label del
 * botón que esa línea nombra, porque ahí no hay ningún identificador y lo que el candado necesita es una
 * palabra que esté en LA línea y no en las de al lado. Si la 520 se mueve, el candado se pone rojo y hay
 * que ir a corregir la cita de allá. ⚠️ LO QUE EL CANARIO NO HACE: no lee `http-pop-signer.ts`, así que
 * no prueba que esa cita diga la verdad; prueba que la línea 520 de acá no se movió. Las SEIS auto-citas
 * de este archivo a `:520` (`:1`, `:3`, `:21`, `:31`, `:484` y `:1387`) quedan cubiertas por el mismo
 * canario, porque todas apuntan a esa línea.
 *
 * 🔴 REGLA DE ESTE BLOQUE (CD-12/CD-14): cada test nombra la edición plausible que lo pone en rojo, Y
 * declara qué NO cubre. Toda atribución "el mutante X lo mata" de acá abajo fue APLICADA Y MEDIDA
 * corriendo el test por nombre, no deducida por simetría.
 */
describe("WKH-352 · `absent` con prueba local del depósito", () => {
  const rem = (s: Partial<RemittanceState>): RemittanceState =>
    ({ status: "created", principalTx: null, refundTx: null, failureReason: null, ...s }) as RemittanceState;

  const T = "2026-01-01T00:00:00.000Z";

  // El copy VIEJO de `chain-absent`, ESCRITO A MANO (AC-2 / CD-8). ⛔ PROHIBIDO derivarlo del módulo:
  // un test que le pregunta al código qué copy produce y después verifica que produjo ese copy es un
  // guard que se compara consigo mismo (`escrowOutcomeDisplay`, `history-onchain.test.tsx:41-45`).
  const COPY_VIEJO_ABSENT =
    "En el contrato no hay ninguna cuenta para este envío: o el depósito nunca entró, o ya se cerró después de resolverse. Desde acá no podemos decir cuál de las dos.";

  // El universo de desenlaces, exhaustivo por `tsc`: si el tipo gana un valor y nadie lo agrega acá,
  // este archivo deja de compilar. Es lo que hace que T-W2 compare contra TODOS los otros copies sin
  // que nadie tenga que mantener una lista a mano.
  const OUTCOME_SET_352: Record<EscrowOutcome, true> = {
    "no-deposit": true,
    "in-escrow": true,
    returned: true,
    unverified: true,
    "chain-deposited-window-open": true,
    "chain-deposited-window-closed": true,
    "chain-released": true,
    "chain-refunded": true,
    "chain-absent": true,
    "chain-absent-after-deposit": true,
    "chain-unknown": true,
    "chain-pending": true,
  };
  const OUTCOMES_352 = Object.keys(OUTCOME_SET_352) as EscrowOutcome[];

  // 🔴 T-W1 (AC-1) — LA FILA CON PRUEBA DEL DEPÓSITO RECIBE SU PROPIO DESENLACE.
  // MUTANTE MEDIDO: borrar el ternario de `flow-vm.ts:1213` y volver a `return "chain-absent";`.
  // Aplicado y medido: T-W1 se pone rojo ("expected 'chain-absent' to be 'chain-absent-after-deposit'").
  // QUÉ NO CUBRE: no mide que la frase sea comprensible para quien la lee. Eso no lo puede medir un test.
  it("T-W1: `absent` + `principalTx` ⇒ `chain-absent-after-deposit`, y su copy ya no dice la disyunción", () => {
    const conPrueba = rem({ status: "principal_in", principalTx: "sig" });
    expect(escrowOutcome(conPrueba, "absent")).toBe("chain-absent-after-deposit");
    const copy = escrowOutcomeDisplay("chain-absent-after-deposit").copy;
    expect(copy).toContain("Tu depósito entró");
    expect(copy).not.toContain("no podemos decir cuál de las dos");
  });

  // 🔴 T-W2 (AC-1, AC-5, CD-2) — LA FRASE NUEVA ES SUYA, Y NO AFIRMA CÓMO TERMINÓ.
  // DOS MUTANTES, MEDIDOS POR SEPARADO PORQUE EL TEST CORTA EN EL PRIMER ASSERT QUE FALLA (decirlo así
  // es el punto: "cae por (a) y por (b)" con UNA sola corrida es una afirmación que nadie midió):
  //   (a) copiar el copy de `chain-released` ⇒ rojo en la comparación contra los otros 11
  //       ("expected 'El contrato dice que tus USDC ya sali…' not to be" el mismo string).
  //   (b) un copy ÚNICO pero que sí afirma ("Tu depósito entró y tus USDC ya salieron hacia el pago…")
  //       ⇒ pasa (a) y cae en la regex de afirmación de desenlace. Sin este segundo mutante, la mitad
  //       (b) de este test nunca se habría ejercitado.
  // QUÉ NO CUBRE: la regex cubre LAS FORMAS QUE ENUMERA, no "toda afirmación de desenlace". Una frase
  // como "seguro fue una entrega" pasa este candado. Quien quiera la afirmación amplia tiene que
  // escribir el candado amplio, no declarar acá que cubre más de lo que cubre.
  it("T-W2: el copy nuevo no se repite con ningún otro, nombra las dos salidas y no afirma ninguna", () => {
    const nuevo = escrowOutcomeDisplay("chain-absent-after-deposit").copy;
    // (a) DERIVADO del `Record` exhaustivo, no de una lista a mano: los otros 11 son "todos menos éste".
    const otros = OUTCOMES_352.filter((o) => o !== "chain-absent-after-deposit").map(
      (o) => escrowOutcomeDisplay(o).copy,
    );
    expect(otros).toHaveLength(11);
    for (const otro of otros) expect(nuevo).not.toBe(otro);
    // (b) Nombra las DOS salidas y dice explícitamente que no puede elegir entre ellas.
    expect(nuevo).toContain("un pago");
    expect(nuevo).toContain("una devolución");
    expect(nuevo).toContain("no podemos decir");
    // ⚠️ SIN `\b` AL FINAL, Y NO ES ESTILO. Esta regex se escribió como `\b(...)\b` y así DOS de sus
    // tres formas estaban MUERTAS: `\b` es un borde de palabra ASCII, y `pagó`/`devolvió` terminan en
    // una letra que NO es `\w`, así que después de la `ó` nunca hay borde y el alternante no matchea
    // jamás. Medido con `node -e`: `/\b(...|se\s+(pagó|devolvió))\b/i.test("se pagó al beneficiario")`
    // ⇒ `false`. El control de abajo sólo plantaba "ya salieron", que termina en `n` y sí matcheaba,
    // así que el agujero era invisible a su propio control. Los `\b` de apertura quedan.
    const AFIRMA_DESENLACE = /(\bya\s+(salieron|volvieron)|\bfue\s+(un pago|una devolución)|\bse\s+(pagó|devolvió))/i;
    expect(nuevo).not.toMatch(AFIRMA_DESENLACE);
    // EL ASSERT DE CONTROL: la regex SÍ matchea sobre una frase plantada que sí afirma. Sin esto, una
    // regex rota dejaría el assert de arriba verde sobre cualquier copy, incluido uno que afirme. Van
    // LAS TRES formas, una por alternante, justamente para que ninguna pueda morir en silencio: las
    // dos de abajo daban ROJO con la versión anterior de la regex, y ése es el hallazgo que las trajo.
    expect("Tus USDC ya salieron hacia el pago").toMatch(AFIRMA_DESENLACE);
    expect("Al final se pagó al beneficiario").toMatch(AFIRMA_DESENLACE);
    expect("Al final se devolvió a tu wallet").toMatch(AFIRMA_DESENLACE);
    // (c) El peso visual: `normal`. `strong` son EXACTAMENTE los dos `chain-deposited-*` (T-V5).
    expect(escrowOutcomeDisplay("chain-absent-after-deposit").emphasis).toBe("normal");
  });

  // 🔴 T-W3 (AC-2) — EL CANDADO: LA FRASE NUEVA NO SE DERRAMA SOBRE QUIEN NO TIENE LA PRUEBA.
  // MUTANTE MEDIDO: predicar por el CAMINO en vez de por la evidencia, o sea
  // `return k === "unverified" ? "chain-absent-after-deposit" : "chain-absent";` en `flow-vm.ts:1213`.
  // Ese predicado es SIEMPRE verdadero ahí (`escrowOutcome` ya cortó en `:1203` con
  // `if (k !== "unverified") return k`), así que le daría la frase "tu depósito entró" a filas que no
  // tienen NINGUNA prueba de que entró. Aplicado y medido: T-W3 se pone rojo ("expected
  // 'chain-absent-after-deposit' to be 'chain-absent'") y NINGÚN otro test de este bloque cae, lo cual
  // es el punto: este candado es el único que cubre esa edición. El loop corta en el PRIMER fixture, así
  // que lo medido es que el mutante lo mata, no que los tres asserts se ejecuten y fallen.
  // SEGUNDO MUTANTE MEDIDO: retocar la frase vieja de `flow-vm.ts:1277` (CD-8) ⇒ T-W3 rojo por el `toBe`.
  // QUÉ NO CUBRE: no mide el copy NUEVO (eso es T-W1/T-W2), ni cubre un cuarto camino a `unverified`
  // que alguien agregue después a `escrowFundsKnowledge`.
  it("T-W3: sin `principalTx`, `absent` sigue dando `chain-absent` con su frase BYTE-IDÉNTICA", () => {
    // Los tres construidos con MARCADORES REALES, uno por cada camino a `unverified` que existe hoy:
    // la rama de `refunded` sin el marcador del sender (`flow-vm.ts:211-212`), la de
    // `PRINCIPAL_STATE_UNKNOWN` (`:216`) y la de `confirmed` (`:219`). Ninguno tiene `principalTx`.
    const sinPrueba: RemittanceState[] = [
      rem({ status: "refunded", failureReason: "payout_amount_mismatch" }),
      rem({ status: "payout_failed", failureReason: PRINCIPAL_STATE_UNKNOWN }),
      rem({ status: "confirmed" }),
    ];
    for (const fixture of sinPrueba) {
      expect(escrowFundsKnowledge(fixture)).toBe("unverified");
      expect(escrowOutcome(fixture, "absent")).toBe("chain-absent");
    }
    // Byte a byte contra el literal escrito a mano arriba, con `toBe`. No `toContain`, no `toMatch`.
    expect(escrowOutcomeDisplay("chain-absent").copy).toBe(COPY_VIEJO_ABSENT);
  });

  // 🔴 T-W4 (AC-1, DT-1) — LA FILA DEL SOLAPE RECIBE LA FRASE NUEVA POR DECISIÓN, NO POR ACCIDENTE.
  //
  // ⚠️ EN EL AR ESTA FILA SE VA A LEER COMO UN BUG. No lo es: está decidida en DT-1 y argumentada en
  // §2.4 del SDD de WKH-352. Los tres caminos de `escrowFundsKnowledge` NO particionan por evidencia,
  // se SOLAPAN: una remesa `refunded` sin `ESCROW_REFUNDED_BY_SENDER` sale por `flow-vm.ts:211-212`
  // sin llegar nunca a `:219`, y aun así puede traer `principalTx`. Ese `principalTx` lo escribió el
  // settle tras un `ok:true`, o sea que el depósito entró de verdad. La evidencia gana al camino.
  //
  // EL FIXTURE VA CONSTRUIDO POR EL CAMINO REAL, no a mano: se rehidrata en `confirmed` y de ahí en
  // adelante son las transiciones de producción, cada una pasando por el guard `canTransition`
  // (`remittance.ts:319`). `principalTx` lo escribe `markPrincipalIn`, que es el ÚNICO escritor del
  // campo en todo `src/` (candado: `principal-tx-single-writer.static.test.ts`).
  // MUTANTE MEDIDO: reintroducir el predicado por camino (`k === "unverified"`) NO lo mata, porque esta
  // fila ES `unverified` — lo mata el mutante de NO ramificar (volver a `return "chain-absent";`), y así
  // se midió: el segundo assert se pone rojo. Lo de arriba es exactamente el tipo de atribución que
  // WKH-351 escribió mal por simetría, así que acá va la medida y no la suposición.
  // QUÉ NO CUBRE: no mide el copy, ni cubre la colisión teórica de un `PayoutGateway` que devuelva
  // `"principal_state_unknown"` (declarada en §2.3 del SDD y NO cerrada en esta HU).
  it("T-W4: `refunded` sin el marcador del sender pero CON depósito confirmado recibe la frase nueva", () => {
    const r = Remittance.rehydrate(rem({ status: "confirmed" }));
    r.markPrincipalIn("solana-sig-principal", T); // confirm-and-send.ts:553, tras el `ok:true` del settle
    r.markPayoutSubmitted("transfi-po-1", T, "transfi"); // confirm-and-send.ts:559
    r.markPayoutFailed("payout_amount_mismatch", T); // track-remittance.ts:23, vía failAndRefund (:64/74)
    r.markRefunded("solana-refund-sig", T); // track-remittance.ts:33-34, con recibo real
    const fixture = r.snapshot as RemittanceState;
    expect(fixture.status).toBe("refunded");
    expect(fixture.principalTx).not.toBeNull();
    expect(fixture.failureReason).not.toBe(ESCROW_REFUNDED_BY_SENDER);

    // (1) Es `unverified` POR LA RAMA DE `refunded` (`flow-vm.ts:211-212`), no por la de `:219`. Se
    // demuestra con el input: el mismo status SIN `principalTx` ya da `unverified` por sí solo, así que
    // `:219` no es lo que decide acá.
    expect(escrowFundsKnowledge(fixture)).toBe("unverified");
    expect(escrowFundsKnowledge(rem({ status: "refunded", failureReason: "payout_amount_mismatch" }))).toBe(
      "unverified",
    );
    // (2) Y recibe la frase nueva, por decisión: el depósito entró y de eso quedó la firma.
    expect(escrowOutcome(fixture, "absent")).toBe("chain-absent-after-deposit");
  });

  // 🔴 T-W5 (AC-1) — LA RAMA NUEVA ES DE `absent` Y DE NINGUNA OTRA RESPUESTA.
  // MUTANTE MEDIDO: ramificar sobre `principalTx` ANTES del `switch` de respuestas, o sea poner
  // `if (rem.principalTx != null) return "chain-absent-after-deposit";` arriba de `flow-vm.ts:1205`.
  // "No pudimos preguntar" pasaría a decirle a la persona que la cuenta se cerró. Aplicado y medido:
  // T-W5 se pone rojo. QUÉ NO CUBRE: mide el DESENLACE, no el copy de cada uno.
  it("T-W5: con `principalTx`, SÓLO `absent` produce el valor nuevo; las otras 7 respuestas no se mueven", () => {
    const conPrueba = rem({ status: "principal_in", principalTx: "sig" });
    // Exhaustivo por `tsc`: si `EscrowChainAnswer` gana un valor y nadie lo mapea acá, no compila. Es
    // el mismo motivo por el que `ANSWER_SET` (`:1601`) existe: una lista a mano deja de mirar el valor
    // nuevo justo el día que se agrega.
    const ESPERADO_352: Record<EscrowChainAnswer, EscrowOutcome> = {
      "deposited-window-open": "chain-deposited-window-open",
      "deposited-window-closed": "chain-deposited-window-closed",
      released: "chain-released",
      refunded: "chain-refunded",
      absent: "chain-absent-after-deposit",
      unknown: "chain-unknown",
      pending: "chain-pending",
      "not-asked": "unverified",
    };
    const respuestas = Object.keys(ESPERADO_352) as EscrowChainAnswer[];
    expect(respuestas).toHaveLength(8);
    for (const a of respuestas) expect(escrowOutcome(conPrueba, a)).toBe(ESPERADO_352[a]);
    // Y el valor nuevo sale de UNA sola respuesta, no de varias.
    const producen = respuestas.filter(
      (a) => escrowOutcome(conPrueba, a) === "chain-absent-after-deposit",
    );
    expect(producen).toEqual(["absent"]);
  });

  // 🔴 T-W10 (AR · BLQ-MED-1) — LA FRASE NUEVA DICE LO MEDIDO, NO LO DEDUCIDO.
  //
  // POR QUÉ EXISTE, que es la parte que no se puede omitir. La primera versión de este copy decía
  // "...y en el contrato ya no hay ninguna cuenta para este envío, ASÍ QUE ESA CUENTA SE CERRÓ DESPUÉS
  // DE RESOLVERSE". Esa segunda mitad no la sostiene esta fila. Concluir "se cerró" exige saber que la
  // dirección que consultamos HOY es la misma que creó aquel depósito, y esa dirección sale de tres
  // cosas de las que el snapshot NO guarda las dos que importan: el program address es un literal del
  // código (`address`, `../infrastructure/solana/escrow-idl.ts:16`), el endpoint lo elige
  // (`resolveSolanaRpcUrlPublic`, `../infrastructure/chain.ts:190`) leyendo `NEXT_PUBLIC_SOLANA_RPC_URL`,
  // y (`RemittanceState`, `../domain/remittance.ts:250`) no tiene ni `programId` ni cluster. Lo ÚNICO
  // medido cuando la cadena contesta `absent` es "en la dirección que derivamos hoy no hay cuenta".
  //
  // EL DAÑO DE DECIR MÁS, que es por qué esto es un candado y no una preferencia de redacción: un
  // cambio de program address (ya pasó acá, commit `89628d8`), el cutover a mainnet, o una
  // `NEXT_PUBLIC_SOLANA_RPC_URL` mal apuntada harían que la pantalla le dijera a alguien que no hay
  // nada que recuperar sobre una fila donde SÍ lo hay, apagándole (`LostEscrowRecovery`,
  // `flow.tsx:1203`), que es la puerta que le queda. Argumento largo en el docblock de
  // (`escrowOutcomeDisplay`, `flow-vm.ts:1260`).
  //
  // MUTANTE MEDIDO: reponer esa media frase en `flow-vm.ts:1276`. Aplicado y medido: T-W10 se pone
  // rojo por el primer assert, y de este bloque no cae ningún otro.
  // SEGUNDO MUTANTE MEDIDO: borrar el "ni descartar que la cuenta siga abierta..." final (o sea sacar
  // el "se cerró" y no poner nada en su lugar, que deja la misma puerta cerrada por omisión) ⇒ T-W10
  // rojo por el assert `toContain("siga abierta")`, y T-W2 verde. Sin ese assert el mutante pasaba.
  // ⚠️ Re-medido en el fix-pack r2, porque el copy cambió (BLQ-BAJO-1) y una atribución sobre un texto
  // que ya no existe es exactamente la clase de prosa que envejece sola: con el copy de hoy y ese
  // recorte, `2 failed | 170 passed`: T-W10 por `siga abierta` y T-W11 por su propio assert del escape
  // (o sea que ese mutante ya NO lo caza sólo este test), con T-W2 verde. Se nombra el ASSERT y no su
  // ordinal: los tres controles nuevos de acá abajo corrieron los números y la frase habría mentido.
  //
  // ⚠️ QUÉ NO CUBRE (CD-14): la regex cubre LAS FORMAS DE CIERRE QUE ENUMERA, no toda afirmación sobre
  // el pasado de la cuenta. "Ese envío ya está resuelto" pasa este candado. Y no mide nada sobre la
  // dirección real: no compara programa ni cluster contra nada, porque el snapshot no los tiene. Lo
  // que hace es impedir que el COPY afirme lo que el dato no sostiene.
  it("T-W10: el copy nuevo no afirma que la cuenta se haya cerrado, y deja abierta la tercera posibilidad", () => {
    const nuevo = escrowOutcomeDisplay("chain-absent-after-deposit").copy;
    // Sin `\b` de cierre a propósito: `cerró` termina en una letra que no es `\w` y el borde ASCII
    // nunca matchea después de la `ó`. Es el mismo defecto que este commit corrigió en T-W2.
    const AFIRMA_CIERRE = /(se\s+cerr[óo]|qued[óo]\s+cerrada|fue\s+cerrada|ya\s+no\s+existe)/i;
    expect(nuevo).not.toMatch(AFIRMA_CIERRE);
    // EL ASSERT DE CONTROL: la regex SÍ matchea la media frase que el AR rechazó, TEXTUAL. Sin esto,
    // una regex rota dejaría el assert de arriba verde sobre cualquier copy, incluido el rechazado.
    expect("así que esa cuenta se cerró después de resolverse").toMatch(AFIRMA_CIERRE);
    // 🔴 UN CONTROL POR ALTERNANTE (AR r2 · MNR-2). Acá había UN solo control y la regex tiene CUATRO
    // formas: los otros tres alternantes no los ejercitaba nadie, así que uno roto (un `\b` de más, un
    // acento mal escrito) habría quedado muerto en silencio, que es EXACTAMENTE el defecto que T-W2
    // documenta dos bloques más arriba y que este archivo ya pagó una vez. LA REGLA, ESCRITA ACÁ Y NO CITADA (AR r3 · MNR-1): SI LA REGEX TIENE N ALTERNANTES, EL CONTROL NECESITA N. Acá decía "la regla, escrita en `auto-blindaje.md:139`", y esa cita no la podía seguir nadie: `doc/` está gitignoreado (`.gitignore:36`) y `git ls-files doc` da 0, así que desde un clone limpio ese archivo NO EXISTE; encima el número estaba corrido (la frase vive en la línea 140, no en la 139). Una regla que el
    // lector no puede leer no es una regla: por eso ahora vive en el test. Medido como
    // DIAGONAL y no "los cuatro matchean": se sacó cada alternante uno por uno y se corrieron los
    // cuatro controles ⇒ `0111`, `1011`, `1101`, `1110`. Cada control muere con SU alternante y con
    // ninguno más; cuatro controles que matchean por el MISMO alternante no habrían probado nada.
    expect("y quedó cerrada esa misma noche").toMatch(AFIRMA_CIERRE);
    expect("la cuenta fue cerrada por el programa").toMatch(AFIRMA_CIERRE);
    expect("esa cuenta ya no existe en la cadena").toMatch(AFIRMA_CIERRE);
    // La tercera posibilidad, nombrada: que la cuenta siga abierta donde no estamos mirando.
    expect(nuevo).toContain("siga abierta");
    // Y lo que el copy SÍ sostiene se queda: el depósito entró, con su firma confirmada.
    expect(nuevo).toContain("Tu depósito entró");
    // ⚠️ LA REGEX NO SE LE APLICA A `chain-absent`, Y NO ES UN OLVIDO: esa frase menciona el cierre
    // como UNA de dos posibilidades ("o ya se cerró"), no como un hecho. Este assert deja escrito que
    // sigue diciéndolo y que CD-8 no se rompió al arreglar la frase nueva.
    expect(escrowOutcomeDisplay("chain-absent").copy).toContain("o ya se cerró después de resolverse");
    expect(escrowOutcomeDisplay("chain-absent").copy).toBe(COPY_VIEJO_ABSENT);
  });

  // 🔴 T-W11 (AR r2 · BLQ-BAJO-1) — EL COPY NO GENERALIZA DE UNA DIRECCIÓN A TODO EL CONTRATO, Y SU
  // ESCAPE APUNTA DONDE LA CUENTA PUEDE ESTAR DE VERDAD.
  //
  // POR QUÉ EXISTE, y son dos afirmaciones distintas que el copy hacía de más:
  //   (1) decía "en EL CONTRATO que estamos consultando no figura ninguna cuenta para este envío". Lo
  //       que se lee es UNA dirección: la que (`deriveEscrowStateFromId16`, `../infrastructure/solana-wallet.ts:294`)
  //       deriva de "escrow" + sender + id16, no el programa entero.
  //       El docblock de (`escrowOutcomeDisplay`, `flow-vm.ts:1260`) ya decía que lo ÚNICO medido es
  //       "en la dirección que derivamos HOY no hay cuenta": el copy afirmaba más que su propio
  //       docblock, y ese par (prosa que afirma / docblock que acota) es el que nadie vuelve a leer.
  //   (2) la tercera posibilidad decía "siga abierta en un contrato que no estamos mirando", y ése es
  //       justo el lugar donde el más plausible de los cuatro disparadores NO la pone: si el depósito
  //       lo firmó otra cuenta de la wallet, la cuenta vive en ESTE MISMO programa con otro sender, y
  //       (`LostEscrowRecovery`, `flow.tsx:2340`) la encuentra porque resuelve por sender. Mandar a un
  //       "otro contrato" es mandar a la persona al único lugar donde no hay nada que buscar.
  //
  // MUTANTE MEDIDO: reponer en `flow-vm.ts:1276` la frase vieja ("Y en el contrato que estamos
  // consultando no figura ninguna cuenta para este envío... siga abierta en un contrato que no estamos
  // mirando"). Aplicado y medido: T-W11 rojo por el primer assert, y de ESTE bloque no cae ningún otro
  // (T-W10 sigue verde: la frase vieja tampoco decía "se cerró"). Fuera de este archivo caen TRES, los
  // que comparan el literal byte a byte: T-W8 en `history-grupos.test.tsx`, y T-W6 y T-W7 en
  // `history-onchain.test.tsx`. Corrida completa del mutante: `4 failed | 191 passed`.
  // SEGUNDO MUTANTE MEDIDO: dejar la primera mitad corregida y volver SÓLO el escape a "esa cuenta siga
  // abierta en un contrato que no estamos mirando" ⇒ T-W11 rojo, `1 failed | 171 passed`, y el rojo cae
  // en `toContain("siga abierta en otra dirección")`, no en el `not.toContain` del final (el test corta
  // en el primer assert que falla, así que del `not.toContain` lo único medido es que existe). El
  // primer assert queda VERDE con este mutante, que es exactamente por qué la mitad (2) necesita
  // asserts propios y no alcanzaba con la regex.
  //
  // ⚠️ QUÉ NO CUBRE (CD-14). La regex cubre LAS DOS FORMAS QUE ENUMERA, no toda generalización: "no
  // encontramos la cuenta en el escrow" pasa este candado. No mide que la persona entienda la
  // distinción entre una dirección y el programa, que ningún test puede medir. Y no mide nada de la
  // dirección real: sigue sin haber `programId` ni cluster en el snapshot.
  //
  // ⚠️ LA MISMA GENERALIZACIÓN VIVE EN LA FRASE CONGELADA DE `chain-absent` ("En el contrato no hay
  // ninguna cuenta para este envío"), y ACÁ NO SE ARREGLA: CD-8 la declara byte-idéntica en esta HU.
  // Queda dicho, no disfrazado, y es lo que el control de abajo usa como espécimen real.
  it("T-W11: el copy nuevo habla de la dirección de este envío, no del contrato entero", () => {
    const nuevo = escrowOutcomeDisplay("chain-absent-after-deposit").copy;
    const GENERALIZA = /(en el contrato\s+(que estamos consultando\s+)?no\s+(hay|figura)|el contrato\s+no\s+(tiene|registra))/i;
    expect(nuevo).not.toMatch(GENERALIZA);
    // UN CONTROL POR ALTERNANTE (la regla de MNR-2, aplicada también acá), y MEDIDO como diagonal: se
    // sacó cada alternante uno por uno y se corrieron los cuatro controles. Resultado, en el orden en
    // que están escritos: `0111`, `1011`, `1101`, `1110`. O sea que cada control muere con SU
    // alternante y con ninguno más, que es lo que un control tiene que probar. El primero no es una
    // frase inventada: es la frase congelada de `chain-absent`, el espécimen que motivó el hallazgo.
    expect(COPY_VIEJO_ABSENT).toMatch(GENERALIZA);
    expect("Y en el contrato que estamos consultando no figura ninguna cuenta").toMatch(GENERALIZA);
    expect("el contrato no tiene ninguna cuenta para este envío").toMatch(GENERALIZA);
    expect("el contrato no registra ninguna cuenta para este envío").toMatch(GENERALIZA);
    // Y lo que el copy SÍ dice: el alcance de la lectura, explícito.
    expect(nuevo).toContain("la dirección que le corresponde a este envío");
    expect(nuevo).toContain("no el contrato entero");
    // El escape apunta a OTRA DIRECCIÓN y a la wallet, no a otro contrato.
    expect(nuevo).toContain("siga abierta en otra dirección");
    expect(nuevo).toContain("wallet conectada");
    expect(nuevo).not.toContain("un contrato que no estamos mirando");
  });
});

// ═══ WKH-354 · AC-3 y AC-7 — los dos copys que esta HU toca ══════════════════════════════════════
describe("WKH-354 · el copy de la cuenta cambiada y la cola reescrita de chain-absent", () => {
  /** El literal EXACTO, escrito a mano acá y no derivado de `humanError`: un test que le pregunta al
   *  código qué copy produce y después verifica que produjo ese copy se compara consigo mismo. */
  const COPY_AC3 =
    "Estás conectado con otra cuenta, distinta de la que verificamos para este envío. Cambiá en tu billetera a la cuenta con la que empezaste y tocá \"Recotizar tasa\", o usá el aviso de arriba para pasarte a la que tenés conectada ahora y empezar un envío nuevo.";

  it("T-354-3f: `wallet_account_changed` tiene copy propio, byte a byte, y NO promete que la app cambie la cuenta", () => {
    expect(humanError("wallet_account_changed")).toBe(COPY_AC3);
    // No cae al genérico: si la rama no fuera alcanzable (por ejemplo, si alguna rama anterior
    // hiciera `includes` de un substring suyo), acá saldría "Algo salió mal".
    expect(humanError("wallet_account_changed")).not.toBe("Algo salió mal. Intentá de nuevo.");
    // 🔴 LO QUE LA APP NO PUEDE HACER Y POR LO TANTO NO PROMETE: `WalletContextState` expone
    // `select(walletName)`, `connect()` y `disconnect()`, y NINGUNA API para elegir la CUENTA dentro
    // de una wallet — eso pasa adentro de Phantom. Un copy que dijera "te cambiamos la cuenta"
    // prometería una acción que esta app no puede ejecutar.
    expect(COPY_AC3).not.toMatch(/te cambiamos|cambiamos tu cuenta/i);
    // Sin em dashes (ni raya ni semirraya).
    expect(COPY_AC3).not.toMatch(/[—–]/);
    // Las DOS instrucciones accionables están, y cada una tiene su test que la EJECUTA en
    // `flow.test.tsx` (T-354-3b la primera, T-354-3c la segunda). Un texto no se mide a sí mismo.
    //
    // ⚠️ ESTO DECÍA MENOS DE LO QUE PARECÍA, y el AR (r4 · BLQ-BAJO-1) lo cazó: 3b y 3c ejecutan las
    // dos instrucciones desde un recorrido que pasó por `onConnect`, o sea con la sesión ya puesta.
    // El camino principal en móvil NO pasa por ahí: al volver de Didit la página se RECARGA y el
    // resume aterrizaba en `confirm` sin sesión, con lo cual la segunda instrucción mandaba a un
    // aviso que en esa pantalla no existía. O sea que "cada una tiene su test que la ejecuta" era
    // cierto para UN camino y falso para el otro. Lo cubre T-354-3g (el estado post-resume) más
    // T-354-3h, que mide que sin billetera conectada este copy directamente no es alcanzable.
    expect(COPY_AC3).toContain("Cambiá en tu billetera a la cuenta con la que empezaste");
    expect(COPY_AC3).toContain("usá el aviso de arriba");
    // Y la primera NOMBRA el control que la persona va a encontrar en pantalla. Que ese control
    // exista de verdad, con ese nombre accesible, lo ejecuta T-354-3b: acá sólo se fija que la
    // frase siga nombrando alguno, porque una instrucción sin gesto es la que dio el hallazgo.
    expect(COPY_AC3).toMatch(/tocá "[^"]+"/);
  });

  it("T-354-7a: la cola de `chain-absent-after-deposit` ya no manda a reabrir la app, y lo de antes de la cola no se movió", () => {
    const copy = escrowOutcomeDisplay("chain-absent-after-deposit").copy;
    // La cola nueva.
    expect(copy).toContain("cambiá a esa cuenta en tu billetera y abrí la pestaña Recuperar de la barra de abajo: ahí está la opción de recuperar un envío perdido.");
    // Y la vieja no está: es el assert que caza la reposición del consejo que exigía reabrir.
    expect(copy).not.toContain("volvé a abrir Chaski");
    expect(copy).not.toContain("en la pantalla de inicio, está la opción");
    // TODO LO ANTERIOR A "cambiá a esa cuenta" queda byte-idéntico: es lo que T-W10 y T-W11 vigilan y
    // esta HU no tiene nada que decir sobre eso. Si esto se rompe, el cambio se pasó de largo.
    expect(copy.split("cambiá a esa cuenta")[0]).toBe(
      "Tu depósito entró: de eso quedó la firma de la transacción, confirmada en la cadena. Y en la dirección que le corresponde a este envío no hay ninguna cuenta: miramos esa dirección sola, no el contrato entero, y eso es todo lo que medimos. Desde acá no podemos decir si terminó en un pago o en una devolución, ni descartar que la cuenta siga abierta en otra dirección: la que miramos se calcula con la wallet conectada, así que si depositaste con otra, ",
    );
  });

  it("T-354-7b: la cola nueva no tiene em dashes y no promete ningún reload", () => {
    const copy = escrowOutcomeDisplay("chain-absent-after-deposit").copy;
    const cola = copy.slice(copy.indexOf("cambiá a esa cuenta"));
    expect(cola).not.toMatch(/[—–]/);
    // Ninguna de las formas de "volvé a abrir / recargá / reiniciá la app".
    expect(cola).not.toMatch(/reabr|volv[ée] a abrir|recarg|reinici|refresc/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-358/AC-8 · T-065-COPY-3 / COPY-4 y AC-7 · T-065-18 — el copy de las causas del enlace
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-065-COPY-3 / COPY-4 / T-065-18 · el copy del recorrido por enlace", () => {
  // ⛔ LA LISTA NO SE ESCRIBE A MANO: se deriva del propio `Record`. Una lista a mano acá haría que
  // agregar una causa sin copy dejara este bloque en verde, que es justo lo que tiene que cazar.
  const CAUSAS = CAUSAS_CON_COPY;

  it("son las que el `Record` tiene, y ninguna cae en el default de `humanError`", () => {
    // ⚠️ EL NÚMERO ESTÁ ESCRITO A MANO A PROPÓSITO y es la SEGUNDA fuente: la lista se deriva del
    // `Record` con `Object.keys`, así que sin este número agregar una causa sin copy no movería nada acá.
    // Eran ONCE al cerrar la ola 4; el fix-pack sumó dos del paso de la cuenta de nonce y el re-AR it2 la tercera.
    // WKH-359 sumó las TRES de la prueba de posesión por enlace (`deeplink_pop_sin_firma`,
    // `deeplink_pop_vencido`, `deeplink_pop_alterado`) ⇒ 17. Este `it` se puso ROJO al agregarlas y ésa
    // es la prueba de que la segunda fuente sirve: el `Record` ya las tenía y el número no.
    expect(CAUSAS, "el `Record` dejó de tener la cantidad de causas que este `it` fija como segunda fuente").toHaveLength(20); // WKH-075 sumó las DOS de la vuelta que no se pudo resolver (`deeplink_disponibilidad_sin_resolver`, `deeplink_marca_sin_consumidor`) ⇒ 19, y el addendum del reloj sumó `deeplink_reloj_inconsistente` ⇒ 20. Este `it` se puso ROJO al agregarlas, igual que con las tres de WKH-359: es la prueba de que la segunda fuente sigue sirviendo.
    for (const c of CAUSAS) {
      expect(humanError(c), `\`${c}\` cae en el default: la persona lee la frase genérica`).not.toBe(
        "Algo salió mal. Intentá de nuevo.",
      );
    }
    // Y las causas del `Record` son textos con contenido, no cadenas de relleno.
    for (const c of CAUSAS) expect(humanError(c).length).toBeGreaterThan(40);
  });

  // MUTANTE QUE MATA: meter "se debitó" en cualquiera de los textos del `Record`. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`.)
  // ⚠️ MIDE LA MENCIÓN, NO LA AFIRMACIÓN, y hay que decirlo porque parece lo mismo: un copy que dijera
  // «NO se movió ningún USDC» —que es VERDADERO y es lo que otras ramas de `humanError` dicen— también lo
  // pone rojo. Se deja así a propósito: ensancharlo para que entienda negaciones sería recodificar acá la
  // gramática que vigila, o sea un guard que se compara consigo mismo. El costo real es que el copy de
  // este `Record` no puede usar ese verbo ni en negativo, y eso ya se pagó una vez en el fix-pack.
  it("T-065-COPY-3: NINGÚN copy afirma que se movió plata, y ninguno tiene em dashes", () => {
    // 🔴 LAS CAUSAS DEL `Record` CORTAN ANTES DEL BROADCAST DEL DEPÓSITO. Decir "se debitó" ahí es falso, y manda
    // a la persona a buscar plata donde no hay ninguna. ⚠️ Tres de ellas (las del paso del nonce) SÍ son
    // post-broadcast de OTRA transacción, la que crea la cuenta: ahí lo que puede haberse debitado es el
    // alquiler en SOL, nunca USDC, y ninguno de los tres copys afirma lo contrario.
    const MOVIO_PLATA = /se debit|se cobr|te cobramos|se movi|se transfir|se descont|salieron de tu/i;
    for (const c of CAUSAS) {
      const t = humanError(c);
      expect(MOVIO_PLATA.test(t), `\`${c}\` afirma que se movió plata: «${t}»`).toBe(false);
      expect(t.includes("—"), `\`${c}\` tiene un em dash (CD-16)`).toBe(false);
    }
    // Refutación del instrumento: el regex SÍ encuentra la frase prohibida cuando está.
    expect(MOVIO_PLATA.test("ya se debitó de tu billetera")).toBe(true);
  });

  // MUTANTE QUE MATA: mover el lookup del `Record` al FINAL de `humanError`, después del último
  // `includes` y antes del `return` del default. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`, que trae exit, `it` rojos y el árbol de los 54, y se re-corre con `node scripts/mutacion/bateria-065.mjs`.)
  //
  // ⚠️ POR QUÉ ESTE `it` ES TEXTUAL Y NO DE COMPORTAMIENTO, dicho porque un review lo va a preguntar:
  // HOY ninguna causa del `Record` contiene ninguno de los needles de la cadena, así que **no existe ningún
  // input que distinga los dos órdenes**. Un `it` de comportamiento sería verde con el lookup en
  // cualquier lado. Lo que DT-8 fija es una propiedad del CÓDIGO, y por eso se mide sobre el código.
  it("T-065-COPY-4: el lookup exacto corre ANTES de la cadena de `includes`", () => {
    const fuente = readFileSync(path.resolve(process.cwd(), "src/presentation/flow-vm.ts"), "utf8");
    const desde = fuente.indexOf("export function humanError(code: string): string {");
    expect(desde, "no se encontró `humanError` en el archivo").toBeGreaterThan(0);
    const hasta = fuente.indexOf('return "Algo salió mal. Intentá de nuevo.";', desde);
    expect(hasta, "no se encontró el default de `humanError`").toBeGreaterThan(desde);
    // (a) se descuentan los comentarios: el bloque de arriba NOMBRA `copyDeEnlace` e `includes` en
    // prosa, y sin descontarlos este barrido mediría dónde está el comentario.
    const bruto = fuente.slice(desde, hasta);
    const cuerpo = bruto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
    // (b) el descuento no se comió el código que este barrido cree mirar.
    expect(cuerpo, "el descuento se llevó el lookup").toContain("copyDeEnlace(code)");
    expect(cuerpo, "el descuento se llevó la cadena de `includes`").toContain("code.includes(");
    // (c) el descuento CAMBIA una cantidad medida: `includes` aparece más veces en bruto que en el
    // código. Sin esta afirmación, un `sinComentarios` roto pasaría igual.
    const enBruto = (bruto.match(/includes/g) ?? []).length;
    const enCuerpo = (cuerpo.match(/includes/g) ?? []).length;
    expect(
      enBruto,
      "`includes` no aparece en los comentarios ⇒ descontarlos no cambia nada y el barrido es decorativo",
    ).toBeGreaterThan(enCuerpo);
    // y el barrido: el lookup está ANTES del primer `includes`.
    expect(
      cuerpo.indexOf("copyDeEnlace(code)"),
      "el lookup exacto quedó DESPUÉS de la cadena de `includes`: un needle nuevo que sea subcadena " +
        "de una de las causas del `Record` se las roba en silencio (DT-8)",
    ).toBeLessThan(cuerpo.indexOf("code.includes("));
  });

  // ── T-065-18 (AC-7) ─────────────────────────────────────────────────────────────────────────────
  // MUTANTE QUE MATA: escribir `"0,0105"` a mano en el copy de `deeplink_saldo_insuficiente` en vez de
  // derivarlo de la constante. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`; el `it` textual de más abajo es el que lo caza.)
  it("T-065-18: el copy de saldo insuficiente muestra la cifra DERIVADA y no dice que se movió plata", () => {
    const t = humanError("deeplink_saldo_insuficiente");
    expect(t).toContain(`${formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT)} SOL`);
    // La segunda fuente: la cadena escrita A MANO. Con una sola, mover el umbral movería los dos lados.
    expect(formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT)).toBe("0,0105");
    expect(/se debit|se cobr|se movi/i.test(t)).toBe(false);
    expect(t).toContain("No se pidió ninguna firma");
  });

  it("T-065-18: y esa cifra se DERIVA en el código: no hay ningún literal de SOL en el `Record`", () => {
    const fuente = readFileSync(path.resolve(process.cwd(), "src/presentation/flow-vm.ts"), "utf8");
    const desde = fuente.indexOf("const COPY_DE_ENLACE: Record<CausaDeEnlaceEnPantalla, string> = {");
    expect(desde).toBeGreaterThan(0);
    const hasta = fuente.indexOf("export function copyDeEnlace(", desde);
    const cuerpo = fuente
      .slice(desde, hasta)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(?<!:)\/\/.*$/gm, "");
    expect(cuerpo, "el descuento se llevó el `Record`").toContain("deeplink_rechazado:");
    expect(
      cuerpo.match(/\d,\d{4}/g) ?? [],
      "hay una cifra de SOL escrita a mano en el `Record`: AC-7 exige que se DERIVE de la constante",
    ).toEqual([]);
    expect(cuerpo).toContain("formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT)");
  });

  // ── WKH-075 · ADDENDUM DEL RELOJ · testigo H ────────────────────────────────────────────────────
  //
  // ⛔ LOS LITERALES PROHIBIDOS VIVEN ACÁ, EN EL TEST, Y NO SE DERIVAN DEL COPY. Si este `it` buscara
  // una subcadena del propio copy sería un control que se lee a sí mismo: nunca podría fallar. Y por
  // eso además lleva REFUTACIÓN DEL INSTRUMENTO — el mismo regex se corre contra las tres causas que SÍ
  // dicen cada frase, así que un regex roto (o vacío) se pone rojo en vez de aplaudir.
  //
  // 🔴 POR QUÉ CADA PROHIBICIÓN, que es lo que hace que esto no sea estilo:
  //   · «no se firmó nada»          → puede haber una `transaccionFirmada` en el disco.
  //   · «empezá el envío de nuevo»  → empujaría a descartar lo que el arreglo acaba de salvar.
  //   · «pasó demasiado tiempo»     → es literalmente lo contrario de lo que ocurrió.
  //   · «cancelaste»                → nadie canceló nada; eso es `deeplink_rechazado`.
  //   · modo privado / no se puede guardar → eso es `deeplink_sin_memoria`; acá el disco funciona.
  //   · cualquier duración          → NO sabemos cuánto retrocedió el reloj. Afirmarlo es inventar.
  //   · em dashes                   → convención de copy público (CD-16).
  // MUTANTE QUE MATA: reusar el copy de `deeplink_viaje_vencido` para esta causa ⇒ rojo en el primer
  //   `expect` con el motivo literal «dice una frase prohibida», y también en el `not.toBe` del final.
  it("T-075-RELOJ-COPY: el copy del reloj no dice ninguna de las SIETE cosas prohibidas", () => {
    const t = humanError("deeplink_reloj_inconsistente");
    // (0) control del instrumento: la causa existe en el `Record` y no cayó en el default.
    expect(t, "la causa nueva cae en el default de `humanError`").not.toBe("Algo salió mal. Intentá de nuevo.");
    const PROHIBIDO = /no se firmó nada|empezá el envío de nuevo|pasó demasiado tiempo|cancelaste|modo privado|no puede guardar/i;
    expect(PROHIBIDO.test(t), `el copy del reloj dice una frase prohibida: «${t}»`).toBe(false);
    // (1) REFUTACIÓN DEL INSTRUMENTO: el mismo regex SÍ las encuentra donde de verdad están.
    expect(PROHIBIDO.test(humanError("deeplink_viaje_vencido")), "el regex no ve «no se firmó nada»").toBe(true);
    expect(PROHIBIDO.test(humanError("deeplink_rechazado")), "el regex no ve «cancelaste»").toBe(true);
    expect(PROHIBIDO.test(humanError("deeplink_sin_memoria")), "el regex no ve «modo privado»").toBe(true);
    // (2) ninguna duración, ni en cifras ni en palabras: no sabemos cuánto retrocedió el reloj.
    expect(/\d/.test(t), "el copy del reloj nombra una cifra").toBe(false);
    expect(/en un momento|en unos segundos|en unos minutos|en un rato/i.test(t), "el copy del reloj promete un plazo").toBe(false);
    // (3) em dashes.
    expect(t.includes("—"), "el copy del reloj tiene un em dash (CD-16)").toBe(false);
    // (4) y lo que SÍ tiene que decir, porque es la mitad que el arreglo compró: que no se perdió nada.
    expect(t, "el copy del reloj no le dice a la persona que lo suyo sigue guardado").toContain("sigue guardado");
    // (5) y que NO es el copy del vecino, que es exactamente el error que esta causa vino a no repetir.
    expect(t).not.toBe(humanError("deeplink_viaje_vencido"));
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-359 · T-067-10 (AC-6) — EL CRUCE DE `flow.tsx:507` TIENE TRES ESTADOS, NO UN `if` MUDO
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// ⛔ EL RESIDUAL, SIN SUAVIZAR ([NC-1] de la HU): esto mide que el tri-estado EXISTE y que el caso
// `null` NO se reporta como verificado. **NO es un evento observable en producción** y esta HU no
// inventa uno: no hay ningún `console.*` ni sink de telemetría en el camino de `flow.tsx:506-519`
// (medido), y agregar infraestructura de observabilidad no pedida a un archivo de [[CENSO src/presentation/flow.tsx lineas=4421]] líneas con [[CENSO src/presentation/flow.tsx entrantes=132]]
// citas ANCLADAS entrantes sería expandir el scope para "cumplir" un AC. ⚠️ ACÁ DECÍA «4268 líneas con 83 citas» Y LO VOLVIÓ FALSO EL COMMIT `7338c37` DE ESTA MISMA HU, sin que nadie editara la frase (F4/F4-2). Por eso hoy son MARCADORES que verifica `citas-ancladas.test.ts` contra el árbol en cada `npm test`, no cifras escritas a mano. ⚠️ Y «ANCLADAS» no es un adorno: el marcador cuenta SÓLO las citas con símbolo delante — las sueltas (`flow.tsx:4009`) se rompen igual y siguen sin que las mire nadie. **Si el founder quería un evento que
// se pueda ver en producción, esto no lo entrega.**
describe("T-067-10 (WKH-359/AC-6): el cruce de cuenta distingue NO COMPARADO de COMPARADO", () => {
  const A = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const B = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  // 🔴 MUTANTE QUE MATA (el del Story File): colapsar el tri-estado en un booleano —por ejemplo hacer
  // que `cruceDeCuenta` devuelva sólo `"comparado" | "no-comparado-sin-billetera"`, o que
  // `seVerificoLaCuenta` conteste `true` para alguno de los dos "no comparado"—. Con el booleano, el
  // caso `ownerAddress == null` se vuelve indistinguible de "se comparó y coincidió", que es
  // exactamente lo que AC-6 prohíbe presentar.
  it("`rem.ownerAddress == null` ⇒ `no-comparado-sin-owner`, y NO cuenta como verificado", () => {
    expect(cruceDeCuenta(A, null)).toBe("no-comparado-sin-owner");
    expect(
      seVerificoLaCuenta(cruceDeCuenta(A, null)),
      "el caso sin dueño se está reportando como verificado: eso es afirmar que se comparó una " +
        "identidad contra nada",
    ).toBe(false);
  });

  it("sin billetera conectada ⇒ `no-comparado-sin-billetera`, y tampoco cuenta como verificado", () => {
    expect(cruceDeCuenta(null, A)).toBe("no-comparado-sin-billetera");
    expect(seVerificoLaCuenta(cruceDeCuenta(null, A))).toBe(false);
    // ⚠️ Y con las DOS ausentes gana "sin billetera": describe al dispositivo (el árbol todavía sin
    // montar) y no a la remesa. Al revés le echaría la culpa a la remesa por el estado del arranque.
    expect(cruceDeCuenta(null, null)).toBe("no-comparado-sin-billetera");
  });

  // Refutación del instrumento: con las dos presentes SÍ cuenta como comparado. Sin esto, un
  // `seVerificoLaCuenta` que devolviera `false` siempre daría verde arriba sin vigilar nada.
  it("con las dos presentes ⇒ `comparado`, y SÍ cuenta como verificado (sean iguales o distintas)", () => {
    expect(cruceDeCuenta(A, A)).toBe("comparado");
    expect(seVerificoLaCuenta(cruceDeCuenta(A, A))).toBe(true);
    // ⚠️ `comparado` dice que el cruce SE EJECUTÓ, no que haya coincidido: quién decide sobre la
    // igualdad es `canonicalizeAddress` en `flow.tsx`, y este valor no habla de eso.
    expect(cruceDeCuenta(A, B)).toBe("comparado");
  });

  // ⛔ LO QUE ESTE TRI-ESTADO **NO** HACE, y va escrito para que nadie lo lea al revés: no corta.
  // El fail-closed que hace falta ya existe y es más fuerte — vive server-side, en
  // `app/api/payout/prepare/route.ts`, que exige el PoP y la fila del veredicto SIN respaldo.
  it("los tres valores son DISTINTOS entre sí: colapsar dos pierde la distinción que AC-6 pide", () => {
    const todos = [cruceDeCuenta(A, A), cruceDeCuenta(A, null), cruceDeCuenta(null, A)];
    expect(new Set(todos).size, "dos de los tres estados colapsaron en el mismo valor").toBe(3);
  });
});

// ── T-COPY-5 (WKH-233 fix-pack · H-1) — el tercer enum del prepare tampoco promete USDC en el escrow ──
//
// 🔴 QUÉ DEFECTO CIERRA, Y POR QUÉ NADIE LO VIO. `confirm-and-send.ts` declaraba que los TRES enums que
// puede devolver `/api/payout/prepare` tenían copy propio en `flow-vm.ts` "para que ninguno prometa USDC
// en el escrow". Eran DOS. `payout_authority_unavailable` no tenía rama y caía en el catch-all
// `code.includes("payout")`, cuyo texto manda a la persona a sacar del escrow unos USDC que nunca
// salieron de su billetera: los tres emisores del enum (`app/api/payout/prepare/route.ts:334`, `:345`,
// `:348`) cortan antes del forward al agente y antes de `authorizePrincipal`.
//
//
// 🔴 QUÉ MIDE ESTE `describe` Y QUÉ NO, ESCRITO PORQUE LA DIFERENCIA YA COSTÓ UNA ITERACIÓN (re-AR it2 ·
// BLQ-ALTO-1). Mide **la FUNCIÓN `humanError`**: que el enum tenga rama propia y que el catch-all siga
// vivo. **NO mide la PANTALLA.** Con estos `it` en verde, `TrackView` estuvo igual de roto que antes
// durante toda la 1ª iteración del fix-pack, porque su `else` estaba hardcodeado a
// `humanError("payout_failed")` y el `failureReason` real no llegaba nunca hasta acá. Lo que la persona
// LEE lo mide `src/presentation/copy-de-prepare-en-pantalla.test.tsx`, que renderiza la vista y barre
// TODOS los enums que emite la route. Los dos hacen falta: éste clava el copy, aquél clava el camino.
// ⛔ ESTE `describe` VA AL FINAL DEL ARCHIVO A PROPÓSITO, y no es prolijidad: `:481`, `:520`, `:76-101`,
// `:1733-1736` y `:1902` de este archivo los cita otro por NÚMERO (`http-pop-signer.ts:33`,
// `flow-vm.ts:1010`, `history-grupos.test.tsx:405`/`:532`, `history-onchain.test.tsx:255`/`:473`).
// Un `it` insertado en el medio los rota en silencio; appendear al final no mueve ninguno.
describe("T-COPY-5: `payout_authority_unavailable` tiene copy propio (WKH-233/H-1)", () => {
  const CATCH_ALL_PAYOUT =
    "No se pudo entregar. No hay un reembolso automático: si tus USDC entraron al escrow, los sacás vos firmando desde tu wallet.";

  // 🧪 CONTROL POSITIVO, EN LA MISMA CORRIDA. Sin esto, las aserciones de abajo pasarían igual si
  // alguien borrara el catch-all entero o le cambiara el texto: estarían midiendo contra una constante
  // que ya no existe en el código. Este `it` prueba que el catch-all SIGUE VIVO y SIGUE tragándose lo
  // que le corresponde — o sea que el barrido de abajo puede encontrar algo.
  it("control positivo: un código de payout desconocido SÍ cae en el catch-all, y su texto es ese", () => {
    expect(humanError("payout_algo_que_nadie_mapeó")).toBe(CATCH_ALL_PAYOUT);
    expect(humanError("payout_failed")).toBe(CATCH_ALL_PAYOUT);
  });

  it("NO cae en el catch-all de `payout`", () => {
    const msg = humanError("payout_authority_unavailable");
    expect(
      msg,
      "`payout_authority_unavailable` volvió a caer en el catch-all de `payout`: la persona lee que " +
        "sus USDC pueden estar en el escrow cuando el corte de `prepare` es anterior a `authorizePrincipal`",
    ).not.toBe(CATCH_ALL_PAYOUT);
  });

  it("y su copy no promete USDC en el escrow ni un reembolso", () => {
    const msg = humanError("payout_authority_unavailable");
    expect(msg).not.toContain("escrow");
    expect(msg).not.toMatch(/te (reembolsamos|devolvemos)/i);
    expect(msg).toContain("No se movió ningún USDC");
    // Sin em dashes en el copy que ve la persona (misma regla que el resto de la tabla).
    expect(msg).not.toContain("—");
  });

  // ⚠️ NO dice "no se pidió ninguna firma", que sería FALSO: para llegar a este guard el PoP ya se
  // verificó ((`POP_SECRET`, `../../app/api/payout/prepare/route.ts:214`) en adelante), o sea que la billetera SÍ firmó un mensaje. Lo
  // cierto es que ese mensaje no mueve valor. Si alguien "simplifica" el copy negando la firma, rojo.
  it("no niega la firma que sí ocurrió (el PoP), la explica", () => {
    const msg = humanError("payout_authority_unavailable");
    expect(msg).not.toMatch(/no se (te )?pidió ninguna firma/i);
    expect(msg).toContain("probar que la billetera es tuya");
  });

  // Y no colapsa con sus dos hermanos: tres cortes distintos, tres frases distintas.
  it("los TRES enums de `prepare` dan tres mensajes DISTINTOS entre sí", () => {
    const tres = [
      "payout_not_authorized",
      "prepare_kyc_verdict_missing",
      "payout_authority_unavailable",
    ].map(humanError);
    expect(new Set(tres).size, "dos de los tres colapsaron en el mismo copy").toBe(3);
    for (const msg of tres) expect(msg).not.toBe(CATCH_ALL_PAYOUT);
  });
});


// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-COPY-SD — `COPY_FALLO_SIN_DEPOSITO`: la frase que leen los 8 enums SIN copy propio (re-AR it3 · MNR-4)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ DEFECTO CIERRA. La frase decía «Podés empezar de nuevo con una cotización fresca» y esa acción
// no le sirve a 2 de sus 8 enums: con `prepare_rate_limited`, hacerlo INMEDIATAMENTE vuelve a chocar con
// el mismo límite; con `prepare_not_configured` —una misconfiguración nuestra— no funciona NUNCA. No era
// falsa: era una acción inútil para dos casos, y por eso el AR la dejó en MENOR. Además callaba la firma
// del PoP que su copy hermano, escrito en el mismo commit, sí nombra a propósito.
//
// ⛔ Y ESTA CONSTANTE NO TENÍA NI UN TEST. Se podía reescribir entera —o volver a la versión que este
// MENOR corrige— sin que nada cambiara de color. Lo único que la miraba era `T-PANT-2`, y sólo por lo
// que NO dice (que no promete el escrow).
//
// ⚠️ SE MIDEN PROPIEDADES, NO EL LITERAL. Un `toBe("…")` con la frase copiada acá sería un guard que se
// compara consigo mismo y que hay que editar cada vez que se toca una coma. Lo que estos `it` clavan es
// lo que la vuelve correcta o incorrecta para sus 8 casos.
describe("T-COPY-SD: la frase del fallo sin depósito le sirve a sus OCHO enums", () => {
  const remesa = (s: Partial<RemittanceState>): RemittanceState =>
    ({ status: "created", principalTx: null, refundTx: null, failureReason: null, ...s }) as RemittanceState;

  /** Un corte del `prepare`: `payout_failed` y `principalTx === null` ⇒ `escrowFundsKnowledge` = "no-deposit". */
  const sinDeposito = (reason: string): RemittanceState =>
    remesa({ status: "payout_failed", failureReason: reason });

  // 🧪 CONTROL POSITIVO, MISMA CORRIDA: sin esto, los `it` de abajo podrían estar midiendo una frase que
  // la pantalla no usa. Acá se prueba que ESTOS enums llegan de verdad a la constante, por el mecanismo
  // real (`copyDeEntregaFallida`), y que el revés —con el depósito en vuelo— NO la usa.
  it("T-COPY-SD-0: los dos enums del hallazgo llegan a esta frase, y con depósito en vuelo NO", () => {
    for (const e of ["prepare_rate_limited", "prepare_not_configured"]) {
      expect(copyDeEntregaFallida(sinDeposito(e)), e).toBe(COPY_FALLO_SIN_DEPOSITO);
    }
    const conDeposito = remesa({ status: "payout_failed", failureReason: "prepare_rate_limited", principalTx: "sig" });
    expect(copyDeEntregaFallida(conDeposito)).not.toBe(COPY_FALLO_SIN_DEPOSITO);
  });

  // EL HALLAZGO. `prepare_rate_limited` se arregla ESPERANDO y `prepare_not_configured` no se arregla
  // desde el lado de la persona. Una acción que no admita el paso del tiempo no le sirve a ninguno de los
  // dos. MUTANTE que lo mata: volver la frase a «Podés empezar de nuevo con una cotización fresca» a secas.
  it("T-COPY-SD-1: la acción admite el paso del tiempo y no promete que reintentar alcance", () => {
    expect(COPY_FALLO_SIN_DEPOSITO, "sin el 'en un rato', el rate-limit vuelve a chocar").toContain("en un rato");
    expect(
      COPY_FALLO_SIN_DEPOSITO,
      "sin esto, `prepare_not_configured` deja a la persona reintentando algo que no puede funcionar",
    ).toMatch(/el problema es nuestro/);
    // Y NO da la orden opuesta: nada de "volvé a intentar AHORA".
    expect(COPY_FALLO_SIN_DEPOSITO).not.toMatch(/(intentá|probá) de nuevo ahora/i);
  });

  // LA CONSISTENCIA CON EL HERMANO, que es la mitad que el AR marcó aparte. Los dos salen de cortes en
  // los que la billetera YA firmó el PoP; uno lo nombraba y el otro lo callaba.
  it("T-COPY-SD-2: nombra la firma del PoP igual que `payout_authority_unavailable`, y ninguno la niega", () => {
    const hermano = humanError("payout_authority_unavailable");
    expect(hermano, "control: el hermano sigue nombrándola").toContain("probar que la billetera es tuya");
    expect(COPY_FALLO_SIN_DEPOSITO).toContain("probar que la billetera es tuya");
    for (const frase of [COPY_FALLO_SIN_DEPOSITO, hermano]) {
      expect(frase, "negar la firma sería FALSO: el PoP se firma antes del POST").not.toMatch(
        /no se (te )?pidió ninguna firma/i,
      );
    }
  });

  // LO QUE NO PUEDE PERDER AL ARREGLARSE: la certeza que la vuelve usable. Si alguien la suaviza a
  // "puede que no se haya movido nada", vuelve la duda que esta HU sacó de la pantalla.
  it("T-COPY-SD-3: sigue afirmando en categórico que no salió nada y que no hay nada que reclamar", () => {
    expect(COPY_FALLO_SIN_DEPOSITO).toContain("no llegó a salir ningún USDC de tu wallet");
    expect(COPY_FALLO_SIN_DEPOSITO).toContain("no hay ningún reembolso pendiente ni nada que reclamar");
    expect(COPY_FALLO_SIN_DEPOSITO, "el escrow es justo lo que NO hay que prometer acá").not.toMatch(/escrow/i);
  });
});


// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-COPY-SD-DERIVA — LAS DOS MITADES DE `sinRamaPropia`, CON ENUMS SINTÉTICOS (re-AR it3 · §4.6)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 EL BORDE QUE EL AR DEJÓ SIN SONDA, Y NO ES UN HALLAZGO DE HOY: (`copyDeEntregaFallida`,
// `flow-vm.ts:1602`) decide "este enum no tiene copy propio" comparando contra DOS genéricos —el
// catch-all de `payout` y el `default` final—. De los 14 enums que emite la route, **la mitad `payout`
// la ejercitaba UNO SOLO** (`payout_pop_unverified`); los otros siete genéricos caen en el `default`.
// ⇒ el día que alguien le escriba copy propio a ese enum, esa mitad de la derivación se queda sin
// ningún test que la toque y **nada se pone rojo**. El mutante "borrarle la comparación contra el
// catch-all de `payout`" pasaría en verde.
//
// ⇒ ESTOS `it` NO DEPENDEN DE QUÉ ENUM EXISTA. Usan códigos SINTÉTICOS elegidos por la propiedad que
// los mete en cada mitad, así que sobreviven a que la route agregue, borre o renombre enums, y a que
// `payout_pop_unverified` reciba copy propio mañana.
//
// ⚠️ LO QUE NO CUBREN, dicho para que nadie se apoye de más: no miden que la route emita estos códigos
// (no los emite: son de mentira), ni el salto `HTTP status ⇒ enum`, ni qué lee la persona en pantalla
// —eso es `copy-de-prepare-en-pantalla.test.tsx`—. Cubren el MECANISMO de la derivación, que es
// justamente lo que se quedaba sin sonda.
describe("T-COPY-SD-DERIVA: las dos mitades de `sinRamaPropia`, sin depender de ningún enum real", () => {
  const sinDeposito = (reason: string): RemittanceState =>
    ({
      status: "payout_failed",
      principalTx: null,
      refundTx: null,
      failureReason: reason,
    }) as RemittanceState;

  // 🧪 LA PRECONDICIÓN, Y SIN ELLA TODO ESTE BLOQUE SERÍA VACUO. Si los dos genéricos devolvieran la
  // MISMA frase, una sola comparación cubriría a las dos y los `it` de abajo no podrían distinguir el
  // código con las dos mitades del código con una. Acá se mide que son frases DISTINTAS.
  it("T-DERIVA-0: los dos genéricos NO son la misma frase (las dos comparaciones hacen falta)", () => {
    expect(humanError("payout_failed")).not.toBe(humanError(""));
    expect(humanError("payout_failed"), "control: la mitad `payout` es la que promete el escrow").toMatch(/escrow/i);
    expect(humanError(""), "control: el `default` final no habla de ningún escrow").not.toMatch(/escrow/i);
  });

  // LA MITAD `payout`. Un código sintético que contiene "payout" y no tiene rama propia cae en el
  // catch-all —el único `return` que manda a sacar USDC del escrow— y la derivación TIENE que verlo
  // como "sin copy propio" y reemplazarlo. MUTANTE: borrar `propio === humanError("payout_failed")`
  // de `copyDeEntregaFallida` ⇒ este `it` se pone rojo con la promesa del escrow en la mano.
  it("T-DERIVA-1: un enum `payout_*` SIN rama propia no lee la promesa del escrow", () => {
    const copy = copyDeEntregaFallida(sinDeposito("payout_sintetico_que_nadie_mapea"));
    expect(copy, "cayó en el catch-all de `payout`: manda a un escrow que está vacío").toBe(
      COPY_FALLO_SIN_DEPOSITO,
    );
    expect(copy).not.toBe(humanError("payout_failed"));
  });

  // LA OTRA MITAD. Un código sin ninguna subcadena reconocida cae en el `default` final, y también
  // tiene que ser reemplazado. MUTANTE: borrar `propio === humanError("")` ⇒ rojo.
  it("T-DERIVA-2: un enum sin NINGUNA rama tampoco se queda con el genérico final", () => {
    const copy = copyDeEntregaFallida(sinDeposito("zzz_sintetico_sin_ninguna_rama"));
    expect(copy).toBe(COPY_FALLO_SIN_DEPOSITO);
    expect(copy).not.toBe(humanError(""));
  });

  // 🧪 EL CONTROL NEGATIVO, y es el que impide "arreglar" esto devolviendo la constante SIEMPRE: un
  // código CON copy propio tiene que conservarlo. Sin este `it`, un `return COPY_FALLO_SIN_DEPOSITO`
  // incondicional pondría verdes a los dos de arriba y borraría todos los copys propios de la pantalla.
  it("T-DERIVA-3: un enum CON copy propio conserva el suyo (la derivación no arrasa)", () => {
    const propio = humanError("payout_authority_unavailable");
    expect(propio, "control: el enum elegido sigue teniendo rama propia").not.toBe(humanError("payout_failed"));
    expect(copyDeEntregaFallida(sinDeposito("payout_authority_unavailable"))).toBe(propio);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// HU 073 · T-073-COPY-* y T-073-CENSO — el copy del resume de KYC, sin React
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// ⛔ NINGUNA de estas frases se escribe como literal acá: todo va contra el SÍMBOLO importado. Un test
// que copia la frase deja de ser una segunda fuente; es la misma frase escrita dos veces.

describe("HU 073 · D-2 (el techo del bucle) no afirma que el sistema estuvo lento", () => {
  it("T-073-COPY-1: el título no dice «tardando»", () => {
    expect(
      COPY_RESUME_SIN_RESPUESTA_TITULO,
      "«tardando» le atribuye la causa a una lentitud que nadie midió: el bucle también termina acá " +
        "cuando el verificador contestó ocho veces sin ser final, que no es lentitud sino ausencia de veredicto",
    ).not.toContain("tardando");
    expect(COPY_RESUME_SIN_RESPUESTA_TITULO).not.toMatch(/a tiempo|demora|lent/i);
  });

  it("T-073-COPY-1b: el título no dice «todavía»", () => {
    expect(
      COPY_RESUME_SIN_RESPUESTA_TITULO,
      "«todavía» promete un futuro en el que ese resultado llega, y en el camino normal `flow.tsx` " +
        "corre `abandonPendingKyc` ANTES de pintar esta card: el pendiente ya no está, nadie va a volver a preguntar",
    ).not.toMatch(/todav[ií]a/i);
  });

  it("T-073-COPY-1c: el cuerpo no enumera causas (canda la PROPIEDAD, no una lista)", () => {
    // ⛔ El candado NO exige una enumeración: exige que NO la haya. Un candado que EXIGE una lista de
    // causas impide corregirla, que es el modo de fallo del guard que se compara consigo mismo.
    expect(
      COPY_RESUME_SIN_RESPUESTA_CUERPO,
      "el cuerpo elige una causa entre las dos que `processing` colapsa (contestaron sin ser final / " +
        "la consulta falló): el tipo no las distingue, así que la pantalla tampoco puede",
    ).not.toMatch(/sin terminar|sigue en curso|ya no sirve|no sabemos si/i);
  });

  it("T-073-COPY-1d: «varias veces» es falsable — se lee `RESUME_MAX_POLLS` del fuente de flow.tsx", () => {
    expect(COPY_RESUME_SIN_RESPUESTA_CUERPO).toContain("varias veces");
    // ⚠️ Se LEE y no se importa: `RESUME_MAX_POLLS` no está exportada, y exportarla obligaría a editar
    // una línea Δ0 que termina en `//`.
    const fuente = leerFuente(unirRuta(process.cwd(), "src/presentation/flow.tsx"), "utf8");
    const m = /RESUME_MAX_POLLS = (\d+)/.exec(fuente);
    // ANTI-VACUIDAD: sin esto, borrar la constante deja el `it` verde por no encontrar nada que medir.
    expect(m, "no encontré `RESUME_MAX_POLLS` en flow.tsx: este candado dejó de mirar").not.toBeNull();
    expect(
      Number((m as RegExpExecArray)[1]),
      "el bucle intenta menos de tres veces: «varias veces» dejó de ser cierto",
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("HU 073 · D-3 (el intento se cortó) tiene texto propio y no toma partido", () => {
  it("T-073-COPY-2a: el título de D-3 NO es el de D-2", () => {
    expect(
      COPY_RESUME_INTERRUMPIDO_TITULO,
      "D-2 y D-3 volvieron a la misma card: son dos finales que no comparten un solo hecho",
    ).not.toBe(COPY_RESUME_SIN_RESPUESTA_TITULO);
    expect(COPY_RESUME_INTERRUMPIDO_CUERPO).not.toBe(COPY_RESUME_SIN_RESPUESTA_CUERPO);
  });

  it("T-073-COPY-2b: D-3 no usa ninguna palabra de duración", () => {
    for (const frase of [COPY_RESUME_INTERRUMPIDO_TITULO, COPY_RESUME_INTERRUMPIDO_CUERPO]) {
      expect(
        frase,
        "D-3 habla de tiempo, y acá no se midió ningún tiempo: el bucle ni siquiera llegó a su techo",
      ).not.toMatch(/tardando|a tiempo|demora|segundo|minuto/i);
    }
  });

  it("T-073-COPY-2c: D-3 no promete que la verificación quedó intacta", () => {
    // Trivial, y se conserva ADEMÁS de T-073-2d (el candado de comportamiento), no en vez de él: el
    // throw puede venir DESPUÉS de que `repo.save` ya escribió, así que «no cambió por esto» sería falsa.
    for (const frase of [COPY_RESUME_INTERRUMPIDO_TITULO, COPY_RESUME_INTERRUMPIDO_CUERPO]) {
      expect(frase).not.toContain("Tu verificación no cambió por esto");
    }
  });

  it("T-073-COPY-2d: D-3 no vuelve a tomar partido sobre si se preguntó (canda la PROPIEDAD)", () => {
    for (const frase of [COPY_RESUME_INTERRUMPIDO_TITULO, COPY_RESUME_INTERRUMPIDO_CUERPO]) {
      expect(
        frase,
        "la frase afirma si la consulta salió o no, y eso es lo que esta HU vino a sacar: el `catch` " +
          "de flow.tsx no mira el error, así que desde la pantalla los dos casos son indistinguibles",
      ).not.toMatch(/no llegamos a preguntar|la consulta no sali[óo]|preguntamos/i);
    }
  });

  it("T-073-COPY-2e: el cuerpo de D-3 arranca con el antecedente condicional", () => {
    expect(
      COPY_RESUME_INTERRUMPIDO_CUERPO,
      "sin el «Si estabas volviendo» se le afirma una verificación a quien nunca empezó ninguna: el " +
        "`get` del disco está FUERA del `try` del store, así que un disco ilegible aterriza en este mismo desenlace",
    ).toMatch(/^Si estabas volviendo/);
  });

  // T-073-COPY-2f · AR/MNR-1 — LA PROPIEDAD QUE LA FRASE NUEVA SE PUSO A SÍ MISMA.
  //
  // 🔴 QUÉ FRASE MATA Y POR QUÉ NINGUNA DE LAS ANTERIORES PODÍA. `T-073-COPY-2d` prohíbe tomar partido
  // sobre si la consulta SALIÓ; el residual que el AR encontró es del otro lado: la frase vieja decía
  // «no sabemos en qué estado quedó», o sea afirmaba nuestra IGNORANCIA del veredicto. Es falso en la
  // rama medida: con el throw en (`kycStore.save`, `resume-kyc.ts:49`) o en (`pending.clear`, `resume-kyc.ts:50`),
  // (`applyKyc`, `resume-kyc.ts:47`) y (`repo.save`, `resume-kyc.ts:48`) YA
  // corrieron y el veredicto está aplicado y guardado ⇒ la app sí lo sabe.
  //
  // ⚠️ EL PEOR ESTADO NO SE CONSTRUYE ACÁ PORQUE YA ESTÁ CONSTRUIDO Y VERDE, y es anterior a esta HU:
  // (`ResumeKyc`, `use-cases.test.ts:244`) corre `rejects` y `status === "kyc_passed"` en la MISMA
  // corrida, que es exactamente la contradicción. Duplicarlo sería un segundo escritor del mismo hecho.
  // Lo que falta y va acá es el candado de la PROPIEDAD del copy, en el formato de las otras siete.
  it("T-073-COPY-2f: D-3 no afirma nada sobre el ESTADO de la verificación, ni siquiera que lo ignoramos", () => {
    const AFIRMA_SOBRE_EL_ESTADO = /sabemos|saber|se desconoce|estado qued/i;
    // CONTROL POSITIVO (CD-24): un regex que no matchea nada dejaría el `not` de abajo verde para
    // siempre. Acá se planta la frase EXACTA que el AR marcó como falsa y se comprueba que cae.
    expect(
      "Si estabas volviendo de una verificación, no sabemos en qué estado quedó, ni si la consulta llegó a salir.",
      "el criterio dejó de cazar la frase que el AR midió falsa: este candado es decorativo",
    ).toMatch(AFIRMA_SOBRE_EL_ESTADO);
    for (const frase of [COPY_RESUME_INTERRUMPIDO_TITULO, COPY_RESUME_INTERRUMPIDO_CUERPO]) {
      expect(
        frase,
        "D-3 volvió a enunciar sobre el estado de la verificación, y en esta rama ese estado puede " +
          "estar ya aplicado y persistido: lo único que la pantalla puede afirmar es lo que ELLA hizo",
      ).not.toMatch(AFIRMA_SOBRE_EL_ESTADO);
    }
  });
});

describe("HU 073 · D-4 no emite un veredicto sobre la persona", () => {
  it("T-073-COPY-3: el banner no dice «no pasó» ni habla de rechazo", () => {
    expect(
      COPY_RESUME_NO_PODEMOS_SEGUIR,
      "«no pasó» es un veredicto, y uno de los dos sub-casos que llegan acá ni siquiera consultó al " +
        "verificador (resume-kyc.ts:37 corta con `decision` en CERO llamadas)",
    ).not.toContain("no pasó");
    expect(COPY_RESUME_NO_PODEMOS_SEGUIR).not.toMatch(/rechaz/i);
  });

  it("T-073-COPY-3b: el banner no emite NINGÚN veredicto sobre la verificación (canda la PROPIEDAD)", () => {
    expect(COPY_RESUME_NO_PODEMOS_SEGUIR).not.toMatch(/no qued[óo] lista|no est[áa] lista|no sirvi[óo]|fue rechaz/i);
  });

  it("T-073-COPY-3c: el aviso tampoco lo emite", () => {
    expect(
      COPY_RESUME_NO_PODEMOS_SEGUIR_AVISO,
      "«necesita otro intento» afirma que la verificación está incompleta, y acá puede estar aprobada " +
        "del otro lado: lo único medido es que NOSOTROS no podemos retomarla",
    ).not.toMatch(/necesita otro intento/i);
    expect(COPY_RESUME_NO_PODEMOS_SEGUIR_AVISO).not.toMatch(/rechaz|no pas[óo]/i);
  });
});

describe("HU 073 · el aviso de la pantalla verify (AC-4)", () => {
  it("T-073-COPY-4a: es CONDICIONAL, no categórico", () => {
    expect(
      COPY_VERIFY_PIDE_UNA_NUEVA,
      "el aviso afirma sin condición que el botón pide una verificación, y con un veredicto usable " +
        "en la billetera el botón ni llega a llamar al verificador",
    ).toMatch(/^Si esta billetera todav[ií]a no tiene una verificaci[óo]n aprobada/);
  });

  it("T-073-COPY-4b: dice «pide», no «abre»", () => {
    expect(
      COPY_VERIFY_PIDE_UNA_NUEVA,
      "«abre» describe una sesión hospedada que sin agente configurado NO existe (el fallback resuelve " +
        "sin redirect); «pide» describe la llamada, que ocurre en las dos configuraciones",
    ).not.toMatch(/abre una verificaci[óo]n/i);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 🔴 T-073-COPY-4c CAMBIÓ DE PROPIEDAD, Y EL HECHO QUE LO OBLIGA ESTÁ MEDIDO CONTRA EL PROVEEDOR
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // ANTES exigía que la frase NOMBRARA el cupo (`.toMatch(/cupo/i)`), y con eso CONGELABA la oración
  // «El cupo de verificaciones no es ilimitado». Esa oración es FALSA en el único estado en el que se
  // muestra: tocar el botón CREA una sesión, y crear no consume nada. La cita textual del proveedor y
  // su fecha viven UNA sola vez, en `app/api/kyc/session/route.ts`, bloque «CUÁNDO SE CONSUME LA
  // CUOTA»: la cuota se consume al COMPLETAR, y las sesiones `Not Started`/`Abandoned` no cuentan.
  // ⇒ el candado estaba defendiendo la frase falsa. Era un candado de la HU que existe para eliminar
  // frases falsas, sosteniendo una propia.
  //
  // ⛔ NO SE BORRA, SE CORRIGE, y la propiedad nueva es la que sí sobrevive a la medición:
  //     el aviso enuncia LA ACCIÓN del botón, y ⛔ no le atribuye ningún costo.
  // Las dos mitades hacen falta. Sólo la negativa (`not.toMatch`) quedaría verde con la frase vaciada
  // o reescrita a cualquier cosa que no hable de plata; la positiva la ancla a lo que el botón HACE.
  // (`T-073-COPY-4a` ancla el antecedente condicional, ⛔ no el consecuente: sin la mitad positiva de
  // acá, «…, este botón no hace nada» pasaba 4a, 4b y 4c a la vez.)
  //
  // 🚧 POR QUÉ NO SE REUBICÓ EL COSTO A DONDE OCURRE, en vez de sacarlo. Una segunda oración del tipo
  // «el cupo se consume recién al completarla» es CIERTA con el agente configurado y FALSA sin él: el
  // fallback no consume nunca, y el navegador no puede distinguir las dos configuraciones (la env que
  // lo decide es de servidor). O sea que reubicarla cambia una frase falsa-en-un-estado por otra
  // falsa-en-una-configuración, que es el mismo defecto. QUÉ SE PIERDE, dicho y no escondido: la
  // pantalla deja de señalar que las verificaciones son un recurso finito. Ese aviso era del OPERADOR
  // (la cuota la paga Chaski, no quien la lee) y ningún freno del repo depende de él: los frenos son
  // `checkKycRateLimit` y el atajo KYC-once de `StartKyc`, y los dos siguen intactos.
  it("T-073-COPY-4c: dice QUÉ hace el botón y ⛔ no le atribuye ningún costo (tocarlo no consume cuota)", () => {
    const ATRIBUYE_UN_COSTO = /cupo|cuota|ilimitad|consum|gast|cuesta|l[ií]mite|pag[ao]/i;
    // CONTROL POSITIVO (CD-24): sin esto, un criterio que no matchea nada dejaría el `not` de abajo
    // verde para siempre. Se planta la frase EXACTA que esta corrección sacó, y tiene que caer.
    expect(
      "Si esta billetera todavía no tiene una verificación aprobada, este botón pide una verificación " +
        "nueva. El cupo de verificaciones no es ilimitado.",
      "el criterio dejó de cazar la frase que se midió falsa contra el proveedor: este candado es decorativo",
    ).toMatch(ATRIBUYE_UN_COSTO);
    // Y la variante REUBICADA también cae: no es que «cupo» esté prohibido por la palabra, es que esta
    // pantalla no puede sostener NINGUNA afirmación de costo (ver el 🚧 de arriba).
    expect(
      "Si esta billetera todavía no tiene una verificación aprobada, este botón pide una verificación " +
        "nueva. El cupo se consume recién al completarla.",
      "el criterio no caza la variante que reubica el costo: la decisión de arriba quedaría sin candado",
    ).toMatch(ATRIBUYE_UN_COSTO);

    expect(
      COPY_VERIFY_PIDE_UNA_NUEVA,
      "el aviso volvió a advertir de un costo. Tocar este botón CREA una sesión, y crear no consume " +
        "cuota (`app/api/kyc/session/route.ts`, bloque «CUÁNDO SE CONSUME LA CUOTA»): la advertencia " +
        "sería falsa en el único estado en el que la pantalla la muestra",
    ).not.toMatch(ATRIBUYE_UN_COSTO);
    expect(
      COPY_VERIFY_PIDE_UNA_NUEVA,
      "el aviso dejó de decir QUÉ hace el botón. Sacar la oración del cupo no autoriza a dejar la " +
        "pantalla muda sobre la acción: eso es lo único que el aviso puede afirmar y sostener",
    ).toMatch(/pide una verificaci[óo]n nueva/i);
  });
});

describe("HU 073 · el label del control de la card", () => {
  it("T-073-COPY-5: no es «Reintentar» ni colisiona con el escape de los 5 s", () => {
    expect(LABEL_VOLVER_A_EMPEZAR_EL_ENVIO).not.toMatch(/^Reintentar$/);
    // ⛔ SUBCADENA, no `^…$`: `getByRole({name:/…/})` matchea por subcadena, así que un ancla dejaría
    // pasar «Empezar de nuevo el envío», que es exactamente la colisión que hay que evitar.
    expect(
      LABEL_VOLVER_A_EMPEZAR_EL_ENVIO,
      "colisiona con el escape de los 5 s, que LIMPIA el pendiente; este control no lo limpia",
    ).not.toMatch(/Empezar de nuevo/i);
  });

  it("T-073-COPY-6: ninguna frase nueva usa em dash (⛔ CD-23)", () => {
    for (const frase of [
      COPY_RESUME_SIN_RESPUESTA_TITULO,
      COPY_RESUME_SIN_RESPUESTA_CUERPO,
      COPY_RESUME_INTERRUMPIDO_TITULO,
      COPY_RESUME_INTERRUMPIDO_CUERPO,
      COPY_RESUME_NO_PODEMOS_SEGUIR,
      COPY_RESUME_NO_PODEMOS_SEGUIR_AVISO,
      COPY_VERIFY_PIDE_UNA_NUEVA,
      LABEL_VOLVER_A_EMPEZAR_EL_ENVIO,
    ]) {
      expect(frase, `«${frase}» tiene un em dash`).not.toContain("—");
    }
  });

  it("T-073-COPY-7: `copyDelFinDelResume` resuelve los DOS finales, y a cards distintas", () => {
    const techo = copyDelFinDelResume("sin-respuesta-en-el-techo");
    const cortado = copyDelFinDelResume("no-pudimos-preguntar");
    expect(techo.titulo).toBe(COPY_RESUME_SIN_RESPUESTA_TITULO);
    expect(techo.cuerpo).toBe(COPY_RESUME_SIN_RESPUESTA_CUERPO);
    expect(cortado.titulo).toBe(COPY_RESUME_INTERRUMPIDO_TITULO);
    expect(cortado.cuerpo).toBe(COPY_RESUME_INTERRUMPIDO_CUERPO);
    // ⛔ CD-26: ningún valor del tipo puede ser falsy, o la rama `) : finDelResume ? (` de flow.tsx no
    // pinta la card y ningún candado lo ve (es comparación de strings en runtime, `tsc` no la mira).
    for (const v of ["sin-respuesta-en-el-techo", "no-pudimos-preguntar"] as const) {
      expect(Boolean(v), `el valor «${v}» de FinDelResume es falsy: la card no se pintaría`).toBe(true);
    }
  });
});

// ── T-073-CENSO (AC-7) ────────────────────────────────────────────────────────────────────────────
//
// 🔴 LAS CLAVES NO SE COPIAN A MANO: se DERIVAN del fuente de `resume-kyc.ts`. Una lista escrita acá
// no se pone roja cuando nace un desenlace nuevo — se queda vieja en silencio, que es el modo de fallo
// que este repo ya midió tres veces. El quinto desenlace (`D3_throw`) NO tiene `kind` porque es el que
// ocurre cuando `execute()` TIRA, y ésa es exactamente la razón por la que la card vieja no lo veía.
const FUENTE_RESUME_KYC = leerFuente(
  unirRuta(process.cwd(), "src/application/use-cases/resume-kyc.ts"),
  "utf8",
);
const KINDS_DEL_RESUME = [...FUENTE_RESUME_KYC.matchAll(/\|\s*\{\s*kind:\s*"(\w+)"/g)].map(
  (m) => m[1] as string,
);

/** Palabras de contenido: 4 letras o más, sin acentos ni puntuación. El umbral de 4 saca los nexos
 *  («con», «que», «una», «por») sin necesidad de una lista de stopwords escrita a mano. */
function palabrasDeContenido(frase: string): Set<string> {
  return new Set(
    frase
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );
}

/** Cuánto se solapan dos frases, como fracción de la MÁS CORTA. 1 = una dice lo mismo que la otra. */
function solapamiento(a: string, b: string): number {
  const pa = palabrasDeContenido(a);
  const pb = palabrasDeContenido(b);
  if (pa.size === 0 || pb.size === 0) return 0;
  let comunes = 0;
  for (const w of pa) if (pb.has(w)) comunes++;
  return comunes / Math.min(pa.size, pb.size);
}

/** Calibrado, no elegido: con el copy de hoy el par más alto que NO es intencional da 0.500 (el cuerpo
 *  de D-2 contra el aviso de D-4), y el par intencional de D-4 da 1.000. 0.6 los separa.
 *
 *  🔴 Y LO QUE FALTABA ES EL TAMAÑO DE ESE MARGEN, QUE ES UNA SOLA PALABRA (F4/MNR-6 — hasta hoy esto
 *  vivía sólo en un `doc/` gitignoreado, o sea que no viajaba con el repo). `solapamiento` normaliza
 *  por la frase MÁS CORTA del par, y en el par que marca el máximo la más corta es el aviso de D-4
 *  («Con esta verificación no podemos seguir»): 4 palabras de contenido —`esta`, `verificacion`,
 *  `podemos`, `seguir`, porque `palabrasDeContenido` tira las de menos de 4 letras—. ⇒ contra ese
 *  texto la métrica sólo puede valer MÚLTIPLOS de 1/4 = 0.25, y entre el máximo no intencional (0.500)
 *  y el umbral (0.6) NO ENTRA NI UN ESCALÓN: UNA palabra castellana común compartida de más lo cruza
 *  (0.500 ⇒ 0.750). Y el texto más corto del censo es todavía más corto (el título de D-2, 3 palabras
 *  de contenido), así que ahí el escalón es aún más grueso: 1/3.
 *
 *  ⛔ LA DIRECTIVA, QUE ES LO ÚNICO QUE HAY QUE OBEDECER ACÁ: si este barrido se pone ROJO con un copy
 *  CORTO, el sospechoso es la MÉTRICA, ⛔ NO el copy y ⛔ NO esta constante. Subirla no arregla el
 *  falso positivo —la métrica sigue dando exactamente lo mismo— y APAGA la detección real, que es la
 *  deuda declarada. El arreglo es rediseñar la métrica (Jaccard, o un piso de palabras), y eso NO es
 *  un ajuste de constante. Tres rojos falsos REPRODUCIDOS contra el aviso de D-4, no imaginados:
 *  «Podemos seguir con esta compra» da 0.750 diciendo LO CONTRARIO y encima de otro tema; «Con esta
 *  verificación podés seguir» da 0.750 siendo la NEGACIÓN del texto real; y «Seguir con esta
 *  verificación» da 1.000 siendo el fragmento SIN el «no», o sea el permiso en vez del corte.
 *  ⇒ la métrica mide VOCABULARIO, no sentido.
 *
 *  ⚠️ Y NINGUNO DE ESOS NÚMEROS ES PROSA: los re-deriva `T-073-CENSO-MARGEN` —el último `it` de este
 *  describe— contra el copy del árbol en cada `npm test`. Si alguno envejece se pone rojo ese `it`, no
 *  este párrafo, que es lo que hace falta cuando al número lo mueve el mismo commit que lo escribe. */
const SOLAPAMIENTO_QUE_HAY_QUE_DECLARAR = 0.6;

describe("T-073-CENSO (AC-7): los cinco desenlaces del resume tienen texto declarado y justificado", () => {
  it("el censo no está vacío y los `kind` se derivaron de verdad del fuente", () => {
    // ANTI-VACUIDAD del derivador: si el regex deja de matchear, todos los `it` de abajo pasarían por
    // recorrer una lista vacía.
    expect(
      KINDS_DEL_RESUME.length,
      "el regex dejó de encontrar los `kind` de `ResumeKycResult`: este censo dejó de mirar",
    ).toBeGreaterThanOrEqual(4);
    expect(KINDS_DEL_RESUME).toContain("none");
    expect(KINDS_DEL_RESUME).toContain("processing");
    expect(Object.keys(DESENLACES_DEL_RESUME).length).toBeGreaterThanOrEqual(5);
  });

  it("cada `kind` de `ResumeKycResult` tiene su fila en el censo", () => {
    const claves = Object.keys(DESENLACES_DEL_RESUME);
    for (const kind of KINDS_DEL_RESUME) {
      expect(
        claves.some((k) => k.endsWith(`_${kind}`)),
        `el desenlace \`${kind}\` no tiene fila en DESENLACES_DEL_RESUME: nació un final del resume y ` +
          "nadie decidió qué lee la persona cuando cae ahí",
      ).toBe(true);
    }
  });

  it("el desenlace del THROW existe y no depende de ningún `kind` (nadie lo nombra en el tipo)", () => {
    expect(
      Object.keys(DESENLACES_DEL_RESUME),
      "se borró la fila del throw: es el desenlace que no tiene `kind`, y por eso era el que la card " +
        "vieja pintaba con la explicación de otro",
    ).toContain("D3_throw");
  });

  it.each(Object.keys(DESENLACES_DEL_RESUME))("la fila `%s` justifica con una cita archivo:línea", (clave) => {
    const fila = DESENLACES_DEL_RESUME[clave as keyof typeof DESENLACES_DEL_RESUME];
    expect(fila, `${clave} no tiene fila`).toBeDefined();
    expect(fila.porQue.length, `${clave} tiene un \`porQue\` vacío`).toBeGreaterThan(0);
    expect(
      fila.porQue,
      `${clave} razona en vez de citar: una justificación sin \`archivo:línea\` es una opinión, y una ` +
        "opinión no se puede volver a verificar cuando el código de abajo cambie",
    ).toMatch(/[\w.-]+\.tsx?:\d+/);
  });

  it("dos textos que se solapan tienen que declararlo con `mismoTextoQue`", () => {
    // CONTROL POSITIVO del instrumento: la métrica tiene que poder dispararse. Sin esto, un
    // `solapamiento` roto (que devolviera siempre 0) dejaría el barrido de abajo verde para siempre.
    expect(
      solapamiento("No podemos seguir con esta verificación", "Con esta verificación no podemos seguir"),
      "la métrica de solapamiento dejó de ver dos frases que dicen lo mismo: el barrido es decorativo",
    ).toBeGreaterThanOrEqual(SOLAPAMIENTO_QUE_HAY_QUE_DECLARAR);

    const filas = Object.entries(DESENLACES_DEL_RESUME);
    const sinDeclarar: string[] = [];
    for (let i = 0; i < filas.length; i++) {
      for (let j = i; j < filas.length; j++) {
        const [ka, fa] = filas[i] as [string, (typeof filas)[number][1]];
        const [kb, fb] = filas[j] as [string, (typeof filas)[number][1]];
        for (const ta of fa.copy) {
          for (const tb of fb.copy) {
            if (ta === tb && ka === kb) continue;
            if (solapamiento(ta, tb) < SOLAPAMIENTO_QUE_HAY_QUE_DECLARAR) continue;
            // ⛔ NO alcanza con que la fila TENGA un `mismoTextoQue`: tiene que NOMBRAR a la otra.
            // Medido: con la versión que sólo miraba si el campo existía, el mutante «devolver D-2 y
            // D-3 a la misma card» daba `225 passed` — sobrevivía entero.
            const declarado = fa.mismoTextoQue?.con === kb || fb.mismoTextoQue?.con === ka;
            if (!declarado) sinDeclarar.push(`${ka} ↔ ${kb}: «${ta}» / «${tb}»`);
          }
        }
      }
    }
    expect(
      sinDeclarar,
      "dos desenlaces distintos leen casi igual y nadie declaró que fuera a propósito: o comparten " +
        "sentido de verdad (y hay que decirlo con `mismoTextoQue`) o se volvieron a colapsar en una card",
    ).toEqual([]);
  });

  it("la fila que lleva DOS textos que dicen lo mismo lo declara (D-4, las dos ramas de `yaInteractuoRef`)", () => {
    expect(DESENLACES_DEL_RESUME.D4_failed.copy).toHaveLength(2);
    expect(
      DESENLACES_DEL_RESUME.D4_failed.mismoTextoQue?.con,
      "D-4 tiene el banner y el aviso sin declarar que son el MISMO desenlace visto desde dos ramas",
    ).toBe("D4_failed");
  });

  // 🔴 T-073-CENSO-MARGEN (F4/MNR-6) — EL INSTRUMENTO QUE RE-DERIVA LOS NÚMEROS DEL DOCBLOCK DE
  // `SOLAPAMIENTO_QUE_HAY_QUE_DECLARAR`, para que ninguno de ellos pueda envejecer en prosa. Existe
  // porque la deuda estaba escrita SÓLO en un `doc/` gitignoreado: quien clonaba el repo leía
  // «calibrado» y nada más, y el arreglo «natural» ante un rojo falso es SUBIR la constante — que es
  // exactamente lo que la deuda dice que no se puede hacer. Acá el que sube la constante se come un
  // rojo con la explicación adentro.
  it("T-073-CENSO-MARGEN: entre el máximo NO intencional y el umbral no entra ni UNA palabra", () => {
    const filas = Object.entries(DESENLACES_DEL_RESUME);
    let peor = { valor: 0, paso: 1, par: "ninguno" };
    for (let i = 0; i < filas.length; i++) {
      for (let j = i; j < filas.length; j++) {
        const [ka, fa] = filas[i] as [string, (typeof filas)[number][1]];
        const [kb, fb] = filas[j] as [string, (typeof filas)[number][1]];
        // El par INTENCIONAL (D-4 con sí mismo) queda afuera: el margen se mide contra los OTROS.
        if (fa.mismoTextoQue?.con === kb || fb.mismoTextoQue?.con === ka) continue;
        for (const ta of fa.copy) {
          for (const tb of fb.copy) {
            if (ta === tb && ka === kb) continue;
            const s = solapamiento(ta, tb);
            if (s <= peor.valor) continue;
            peor = {
              valor: s,
              paso: 1 / Math.min(palabrasDeContenido(ta).size, palabrasDeContenido(tb).size),
              par: `${ka} ↔ ${kb}`,
            };
          }
        }
      }
    }
    // ANTI-VACUIDAD: sin esto, un censo que dejara de comparar pares dejaría todo lo de abajo midiendo
    // el vacío y este `it` sería decorativo, que es el defecto que este mismo archivo ya documenta.
    expect(peor.par, "no se comparó NINGÚN par no intencional: este `it` está midiendo el vacío").not.toBe("ninguno");
    expect(
      peor.valor,
      "el máximo no intencional ya cruza el umbral; eso lo tiene que cazar el `it` del barrido, no éste",
    ).toBeLessThan(SOLAPAMIENTO_QUE_HAY_QUE_DECLARAR);

    // EL MARGEN: menor que un escalón de la métrica ⇒ una sola palabra compartida de más lo cruza.
    expect(
      SOLAPAMIENTO_QUE_HAY_QUE_DECLARAR - peor.valor,
      `el margen del umbral dejó de ser de MENOS de una palabra (par ${peor.par}: ${peor.valor.toFixed(3)}, ` +
        `escalón ${peor.paso.toFixed(3)}, umbral ${SOLAPAMIENTO_QUE_HAY_QUE_DECLARAR}). ⛔ Si llegaste acá porque ` +
        "SUBISTE la constante: no arreglaste ningún falso positivo (la métrica sigue dando lo mismo) y apagaste " +
        "la detección real. Leé el docblock de `SOLAPAMIENTO_QUE_HAY_QUE_DECLARAR`: el arreglo es rediseñar la " +
        "métrica (Jaccard, o un piso de palabras), no mover este número.",
    ).toBeLessThan(peor.paso);

    // Y el texto más corto del censo es aún más corto que la más corta de ESE par ⇒ escalón más grueso.
    const masCortaDelCenso = Math.min(
      ...filas.flatMap(([, f]) => f.copy.map((t) => palabrasDeContenido(t).size)),
    );
    expect(
      masCortaDelCenso,
      "cambió el texto más corto del censo: el escalón de la métrica ya no es el que dice el docblock",
    ).toBe(3);
    expect(1 / masCortaDelCenso, "el escalón del texto más corto dejó de ser el más grueso").toBeGreaterThan(peor.paso);

    // 🔴 LOS TRES ROJOS FALSOS, REPRODUCIDOS Y NO IMAGINADOS. Ninguno dice lo que dice el copy real
    // contra el que se lo mide —dos dicen LO CONTRARIO— y la métrica igual los marca como «casi igual».
    const ROJOS_FALSOS = [
      { sintetico: "Podemos seguir con esta compra", da: 0.75, porQue: "dice LO CONTRARIO («podemos» vs «no podemos») y encima habla de otro tema" },
      { sintetico: "Con esta verificación podés seguir", da: 0.75, porQue: "es la NEGACIÓN del texto real" },
      { sintetico: "Seguir con esta verificación", da: 1, porQue: "es el fragmento SIN el «no»: el permiso en vez del corte" },
    ] as const;
    for (const { sintetico, da, porQue } of ROJOS_FALSOS) {
      const medido = solapamiento(sintetico, COPY_RESUME_NO_PODEMOS_SEGUIR_AVISO);
      expect(
        medido,
        `cambió la métrica o el copy: «${sintetico}» ya no da ${da} contra el aviso de D-4. Este renglón es la ` +
          "EVIDENCIA de que la métrica mide vocabulario y no sentido; si cambió, re-medí y actualizá el docblock",
      ).toBeCloseTo(da, 3);
      expect(
        medido,
        `«${sintetico}» dejó de cruzar el umbral. ⛔ Si es porque SUBISTE la constante: no arreglaste nada ` +
          `—la métrica le sigue dando ${da}— y apagaste la detección real (${porQue})`,
      ).toBeGreaterThanOrEqual(SOLAPAMIENTO_QUE_HAY_QUE_DECLARAR);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-075 · T-075-COPY (AC-3) — las dos causas nuevas dicen algo PROPIO
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 🔴 POR QUÉ ESTE BLOQUE EXISTE SI YA ESTÁ `T-065-COPY-1`. Ese candado exige que la causa **no caiga en
// el default**, y eso NO alcanza para AC-3: el AC pide que la persona pueda distinguir esto de un
// selector que se cerró. Dos causas con copy propio pero IDÉNTICO entre sí, o idéntico al de
// `wallet_connect_cancelled`, pasarían `T-065-COPY-1` enteras y dejarían a la persona leyendo que
// «cerró el selector» justo cuando no tocó nada. Eso es el defecto que esta HU vino a sacar, una capa
// más arriba.
describe("T-075-COPY (WKH-075/AC-3): la vuelta que no se pudo resolver no se confunde con un selector cerrado", () => {
  const SIN_RESOLVER = humanError("deeplink_disponibilidad_sin_resolver");
  const SIN_CONSUMIDOR = humanError("deeplink_marca_sin_consumidor");
  const CANCELADO = humanError("wallet_connect_cancelled");

  it("las tres frases se leyeron de verdad (si alguna viniera vacía, todo lo de abajo sería vacuo)", () => {
    // 🔴 CONTROL POSITIVO PRIMERO: tres `not.toBe` entre cadenas vacías pasan siempre.
    for (const [nombre, t] of [["sin-resolver", SIN_RESOLVER], ["sin-consumidor", SIN_CONSUMIDOR], ["cancelado", CANCELADO]] as const) {
      expect(t.length, `el copy de \`${nombre}\` vino vacío o casi`).toBeGreaterThan(40);
    }
    // Y la de `wallet_connect_cancelled` sigue siendo la que esta HU NO quiere que la persona lea por
    // una vuelta buena. Si este `expect` se rompe, el resto del bloque está comparando contra otra cosa.
    expect(CANCELADO).toContain("Se cerró el selector de wallet sin conectar");
  });

  it("ninguna de las dos es el default de `humanError`", () => {
    expect(SIN_RESOLVER).not.toBe("Algo salió mal. Intentá de nuevo.");
    expect(SIN_CONSUMIDOR).not.toBe("Algo salió mal. Intentá de nuevo.");
  });

  it("ninguna de las dos dice lo que dice `wallet_connect_cancelled`, y son distintas ENTRE SÍ", () => {
    expect(SIN_RESOLVER, "la vuelta sin resolver le atribuye a la persona haber cerrado el selector").not.toBe(CANCELADO);
    expect(SIN_CONSUMIDOR, "la marca sin consumidor le atribuye a la persona haber cerrado el selector").not.toBe(CANCELADO);
    expect(SIN_RESOLVER, "las dos causas colapsaron en el mismo texto: nombran silencios distintos y piden acciones distintas").not.toBe(SIN_CONSUMIDOR);
    // ⛔ Y ninguna de las dos le atribuye a la persona un gesto que no hizo. Es la batalla de
    // `wallet-error-code.ts:216-218`, y acá cuesta más caro: la persona YA firmó.
    for (const t of [SIN_RESOLVER, SIN_CONSUMIDOR]) expect(t).not.toMatch(/cerraste|cancelaste|se cerró el selector/i);
  });

  // 🔴 ESTE `it` SE LLAMABA «las dos afirman que la vuelta LLEGÓ» Y ESA ERA LA AFIRMACIÓN NO MEDIDA
  // (fix-pack · CR/BLQ-1). Lo que el sistema sabe cuando emite `deeplink_disponibilidad_sin_resolver`
  // es que hay una marca CONOCIDA en la barra —o sea que esta pantalla mandó a esa persona a su
  // billetera y volvió—, y ⛔ NADA sobre la respuesta: `flow.tsx:4005` corre ANTES de `completar()`.
  // ⇒ Se afloja a lo que sí está medido (que la persona VOLVIÓ) y se le agrega el guard que impide
  // reintroducir lo otro. ⚠️ El `toMatch(/Volviste de tu billetera/)` se queda: esa mitad es cierta y
  // es lo que la HU agrega contra el precedente —la persona gastó un viaje redondo y el copy tiene que
  // reconocerlo antes de pedirle nada—; lo que se va es «la vuelta llegó bien».
  it("las dos reconocen que la persona VOLVIÓ y que no se envió nada, ⛔ ninguna afirma que la vuelta se haya VALIDADO, y ⛔ no tienen em dashes", () => {
    const AFIRMA_QUE_LA_VUELTA_SIRVIÓ = /llegó bien|volvió bien|salió bien|vino bien|la recibimos bien/i;
    // 🔴 REFUTACIÓN DEL INSTRUMENTO PRIMERO: sin esto, un regex que dejó de matchear daría dos
    // `not.toMatch` vacuos y el guard se caería solo sin que nadie lo note.
    expect(
      AFIRMA_QUE_LA_VUELTA_SIRVIÓ.test("Volviste de tu billetera y la vuelta llegó bien."),
      "el regex no encuentra la frase prohibida ni en el texto que la contiene: los dos `not.toMatch` de abajo son vacuos",
    ).toBe(true);
    for (const t of [SIN_RESOLVER, SIN_CONSUMIDOR]) {
      expect(t, "el copy no reconoce que la persona volvió de su billetera").toMatch(/Volviste de tu billetera/);
      expect(t, "el copy no dice qué quedó del envío").toMatch(/no se envió nada|No se envió nada/);
      expect(t, "em dash en copy público").not.toMatch(/[—–]/);
      expect(
        t,
        "el copy afirma que la vuelta llegó BIEN, y en el punto donde se emite no corrió nada que mire la respuesta",
      ).not.toMatch(AFIRMA_QUE_LA_VUELTA_SIRVIÓ);
    }
  });
});
