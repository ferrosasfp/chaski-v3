import { describe, expect, it, vi } from "vitest"; import { WALLET_SIGN_MESSAGE_ERROR, laBilleteraFueTocada } from "./solana/wallet-error-code"; // WKH-339/CR: EN ESTA LÍNEA — `http-pop-signer.ts:33` (NO-TOUCH) cita `flow-vm.test.ts:520` por número
import { Money } from "../domain/money";
import type { RemittanceState, RemittanceStatus } from "../domain/remittance";
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
  escrowKnowledgeCopy,
  escrowRefundError,
  escrowRentDiscoveryError,
  humanError,
  lostEscrowRecoveryError,
  shortErrorCode,
  isDemoMode,
  isKycDemo,
  kycOriginNotice,
  REAL_KYC_PROVENANCES,
  esVentanaSinAbiertos, sinAbiertosCopy, sinIndiceCopy, indiceIlegibleCopy, statusDisplay, lecturaSeguimiento, gestoDespuesDeProve, REVISION_MECANISMO_APAGADO, REVISION_NO_SE_PUDO_PEDIR, REVISION_SIN_FIRMA, REVISION_TECHO_ALCANZADO, // WKH-339/CR: las otras 4 constantes YA NO se importan por nombre — el loop las DERIVA del módulo, que es el arreglo de BLQ-BAJO-1. Si vuelven acá por nombre, el loop volvió a ser una lista a mano. // WKH-339: EN ESTA LÍNEA, no en líneas nuevas — `http-pop-signer.ts:33` (NO-TOUCH) cita `flow-vm.test.ts:520` por número
} from "./flow-vm"; import * as MODULO_FLOW_VM from "./flow-vm"; // WKH-339/CR-BLQ-BAJO-1: el namespace entero, para DERIVAR la lista de copies en vez de escribirla. En esta línea para no desplazar `:520`
import {
  KYC_PROVENANCE_LIVE,
  KYC_PROVENANCE_MOCK,
} from "../infrastructure/didit/decision";
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

// ── T-4.1' — AC-4 QUEDA NO CUMPLIDO, Y ACÁ ESTÁ ESCRITO ──────────────────────────────────────────
//
// 🔴 ESTE TEST NO CUMPLE AC-4: LO DECLARA. AC-4 pedía distinguir en pantalla un RECHAZO del agente de
// FX (por ejemplo, un monto por debajo del mínimo del corredor) de una CAÍDA del agente. Por el
// carril del gateway eso es inalcanzable hoy, y no por falta de ganas:
//
//   · `/compose` devuelve el step fallado SIN `code` y SIN `reason`; el único portador de la causa es
//     el `message`, que es TEXTO LIBRE.
//   · Parsear ese texto está prohibido (`gateway-client.ts`), y ecoarlo al browser también: es
//     server-only por CD-8/CD-9.
//   · `mapErrorStatus` colapsa "el agente negó el pedido" y "el agente se cayó" en `step_failed`.
//
// Lo que este test asserta es que el copy resultante NO PROMETE distinguir la causa. Una frase que
// dijera "el monto está fuera de rango" sobre un `step_failed` sería una afirmación que el código no
// puede sostener, y sería peor que la regresión. La salida estructural está anotada como WKH-335 en
// `wasiai-a2a` (otro repo, Scope OUT de esta HU).
//
// ⚠️ ESTO ES UNA REGRESIÓN DECLARADA, NO UN AC CUBIERTO. Por el carril del gateway, un envío por
// debajo del mínimo del corredor vuelve a leerse en pantalla como una caída del sistema.
describe("T-4.1': AC-4 NO CUMPLIDO — el corte por rechazo del agente de FX no promete distinguir la causa", () => {
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
    // Este no ⇒ default. Si algún día WKH-335 aterriza, ESTE `expect` es el que hay que dar vuelta.
    expect(humanError("step_failed")).toBe("Algo salió mal. Intentá de nuevo.");
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
