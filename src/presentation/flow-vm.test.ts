import { describe, expect, it } from "vitest";
import { Money } from "../domain/money";
import type { RemittanceState, RemittanceStatus } from "../domain/remittance";
import {
  PRINCIPAL_SETTLED_REFUND_MANUAL,
  PRINCIPAL_STATE_UNKNOWN,
} from "../application/use-cases/confirm-and-send";
import { ESCROW_REFUNDED_BY_SENDER } from "../application/use-cases/recover-escrow-funds";
import {
  deliveredDisplay,
  escrowFundsAtRisk,
  escrowFundsKnowledge,
  escrowKnowledgeCopy,
  escrowRefundError,
  humanError,
  shortErrorCode,
  isDemoMode,
  statusDisplay,
} from "./flow-vm";

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
  // persona a mano y este repo no la llama nunca (confirm-and-send.ts:283-292): son dos hechos
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
      kyc: { provenance: "didit" },
    } as RemittanceState;
    expect(isDemoMode(rem)).toBe(false);
  });

  it("T-AC3a (AC-3/5): quote/kyc reales pero payout mock (local-fallback) → true", () => {
    const rem = {
      quote: { provenance: "didit" },
      kyc: { provenance: "didit" },
      payoutProvenance: "local-fallback",
    } as RemittanceState;
    expect(isDemoMode(rem)).toBe(true);
  });

  it("T-AC3b (AC-3/5): payout real transfi / null / ausente (quote/kyc reales) → false", () => {
    const real = {
      quote: { provenance: "didit" },
      kyc: { provenance: "didit" },
      payoutProvenance: "transfi",
    } as RemittanceState;
    expect(isDemoMode(real)).toBe(false);

    const noPayout = {
      quote: { provenance: "didit" },
      kyc: { provenance: "didit" },
      payoutProvenance: null,
    } as RemittanceState;
    expect(isDemoMode(noPayout)).toBe(false);

    const absent = {
      quote: { provenance: "didit" },
      kyc: { provenance: "didit" },
    } as RemittanceState; // payoutProvenance undefined (legacy) → false
    expect(isDemoMode(absent)).toBe(false);
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

describe("flow-vm — humanError", () => {
  it("AC-5: no_wallet → copy específico (≠ genérico)", () => {
    expect(humanError("no_wallet")).toContain("wallet instalada");
    expect(humanError("no_wallet")).not.toBe("Algo salió mal. Intentá de nuevo.");
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

  it("kyc genérico y payout siguen mapeando a su copy", () => {
    expect(humanError("kyc_rejected")).toBe("No pudimos verificar tu identidad.");
    expect(humanError("payout_failed")).toContain("reembolsamos");
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
    ["wallet_connect_timeout", "tardó demasiado"],
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

  it("no_wallet y wallet_not_connected conservan su copy previo (no los pisó la familia nueva)", () => {
    expect(humanError("no_wallet")).toContain("wallet instalada");
    expect(humanError("wallet_not_connected")).toContain("Reconectá");
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
