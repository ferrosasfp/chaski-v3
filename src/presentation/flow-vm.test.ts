import { describe, expect, it } from "vitest";
import { Money } from "../domain/money";
import { MIN_SEND_USD } from "../domain/remittance";
import type { RemittanceState, RemittanceStatus } from "../domain/remittance";
import {
  PRINCIPAL_SETTLED_REFUND_MANUAL,
  PRINCIPAL_STATE_UNKNOWN,
} from "../application/use-cases/confirm-and-send";
import { ESCROW_REFUNDED_BY_SENDER } from "../application/use-cases/recover-escrow-funds";
import {
  SENDER_MIN_LAMPORTS_FOR_DEPOSIT,
  formatLamportsAsSol,
} from "../application/solana-escrow-rent";
import {
  deliveredDisplay,
  escrowFundsAtRisk,
  escrowFundsKnowledge,
  escrowKnowledgeCopy,
  escrowRefundError,
  humanError,
  shortErrorCode,
  isDemoMode,
  isKycDemo,
  kycOriginNotice,
  REAL_KYC_PROVENANCES,
  statusDisplay,
} from "./flow-vm";
import {
  KYC_PROVENANCE_LIVE,
  KYC_PROVENANCE_MOCK,
} from "../infrastructure/didit/decision";

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

  // 🔴 EL CASO QUE FALTABA. `didit-mock` es lo que produce `mapDiditDecision` con `DIDIT_ENV=mock`
  // (decision.ts:91), o sea la configuración con la que se recorre la demo, y la condición vieja
  // (`=== "local-fallback"`) lo leía como una verificación REAL. En `confirm` todavía no hay
  // `payoutProvenance`, así que nada prendía el sello y la pantalla afirmaba una identidad verificada.
  // El literal se IMPORTA de donde se produce: si alguien renombra la etiqueta, este test no queda
  // probando un valor que ya nadie emite.
  it("kyc.provenance didit-mock (DIDIT_ENV=mock) → true, sin payout todavía", () => {
    const rem = {
      quote: { provenance: "didit" },
      kyc: { provenance: KYC_PROVENANCE_MOCK },
    } as RemittanceState;
    expect(isDemoMode(rem)).toBe(true);
  });

  // La dirección: allowlist, no denylist. Lo desconocido sobre-avisa.
  it("una proveniencia de KYC desconocida → true (lo que no está en la allowlist no es real)", () => {
    const rem = {
      quote: { provenance: "didit" },
      kyc: { provenance: "verificador-nuevo-2027" },
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
      kyc: { provenance: "" },
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

describe("flow-vm — la allowlist del KYC (dirección de seguridad)", () => {
  // El conjunto NO se compara contra un literal escrito acá: se compara contra la constante que
  // PRODUCE la etiqueta. Es lo que prueba el cableado en vez de repetir el valor (un segundo Set con
  // los mismos strings es exactamente cómo se desincronizan las dos capas).
  it("la allowlist contiene la etiqueta que produce mapDiditDecision para `live`, y sólo esa", () => {
    expect(REAL_KYC_PROVENANCES.has(KYC_PROVENANCE_LIVE)).toBe(true);
    expect([...REAL_KYC_PROVENANCES]).toEqual([KYC_PROVENANCE_LIVE]);
    // Y la etiqueta del mock NO está: es la propiedad de la que cuelga todo el arreglo.
    expect(REAL_KYC_PROVENANCES.has(KYC_PROVENANCE_MOCK)).toBe(false);
  });

  it("isKycDemo: sólo la allowlist es real; comparación EXACTA (un espacio de más ya no lo es)", () => {
    expect(isKycDemo(KYC_PROVENANCE_LIVE)).toBe(false);
    expect(isKycDemo(KYC_PROVENANCE_MOCK)).toBe(true);
    expect(isKycDemo("local-fallback")).toBe(true);
    expect(isKycDemo("fake")).toBe(true);
    expect(isKycDemo("lo-que-sea")).toBe(true);
    expect(isKycDemo(" didit")).toBe(true); // exacta, como en REAL_PAYOUT_PROVENANCES
    expect(isKycDemo("Didit")).toBe(true);
    expect(isKycDemo("")).toBe(true);
    expect(isKycDemo(null)).toBe(true);
    expect(isKycDemo(undefined)).toBe(true);
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
    // El número sale de la MISMA constante que compara el guard: si alguien cambia el umbral y no el
    // copy, esto sigue verde; si alguien escribe el número a mano en el copy, esto se pone rojo.
    expect(copy).toContain(formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEPOSIT));
    expect(copy).toContain("no se movió ningún USDC"); // lo único afirmable sobre el dinero
    expect(copy).not.toBe("Algo salió mal. Intentá de nuevo.");
    // No comparte mensaje con "no pudo entregarse": la persona no tiene que esperar ningún reembolso.
    expect(copy).not.toBe(humanError("payout_failed"));
  });

  // Hallazgo #75 — las tres causas de rechazo de cotización caían en "Algo salió mal. Intentá de
  // nuevo", que para un monto fuera de rango es un consejo activamente equivocado: intentar de nuevo
  // con el mismo monto vuelve a fallar exactamente igual.
  it("#75: mínimo, techo y rechazo genérico tienen copy PROPIO y DISTINTO entre sí", () => {
    const bajo = humanError("fx_amount_below_minimum");
    const alto = humanError("fx_amount_above_maximum");
    const generico = humanError("a2a_quote_rejected");
    for (const copy of [bajo, alto, generico]) {
      expect(copy).not.toBe("Algo salió mal. Intentá de nuevo.");
      // Tampoco comparten mensaje con la caída real, que es lo que decían antes de esto.
      expect(copy).not.toBe(humanError("a2a_quote_unavailable"));
    }
    expect(new Set([bajo, alto, generico]).size).toBe(3);
  });

  it("#75: el copy del mínimo sale de MIN_SEND_USD, no de un número escrito a mano", () => {
    // Si alguien cambia la constante y no el copy, esto sigue verde; si alguien escribe el 5 a mano,
    // se pone rojo el día que la política cambie. Mismo criterio que el copy del rent en SOL.
    expect(humanError("fx_amount_below_minimum")).toContain(String(MIN_SEND_USD));
  });

  // Del techo NO tenemos copia local del número (la autoridad es el agente), así que el copy no
  // puede inventarlo. Lo que sí tiene que hacer es no prometer uno.
  it("#75: el copy del techo no publica un número que no tenemos", () => {
    const copy = humanError("fx_amount_above_maximum");
    expect(copy).toContain("máximo");
    expect(copy).not.toMatch(/\d/);
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
