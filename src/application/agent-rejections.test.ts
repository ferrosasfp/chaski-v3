// Tests — la POLÍTICA de qué rechazo del agente sale al browser y cuál queda colapsado.
//
// Estos tests no prueban una ruta: prueban la decisión. Existen porque el criterio de las dos listas
// se puede erosionar de a un reason por vez, y cada erosión se ve razonable de a una ("total, ya
// pasó el guard de autoridad"). El candado del oráculo es el único de este archivo que protege algo
// que no es diagnóstico: `kyc_gate_not_passed` es un VEREDICTO sobre una verificación de identidad,
// que es la familia exacta que WKH-205 colapsó en /api/payout/validate.
import { describe, expect, it } from "vitest";
import {
  LOGGABLE_PREPARE_REJECTIONS,
  PREPARE_REJECTED,
  PREPARE_REJECTION_ENUMS,
  QUOTE_REJECTED,
  RELAYABLE_PREPARE_REJECTIONS,
  RELAYABLE_QUOTE_REJECTIONS,
  isPrepareRejection,
  prepareRejectionEnum,
  relayableRejection,
} from "./agent-rejections";

describe("agent-rejections — la allow-list decide, no el agente", () => {
  it("CANDADO NO-ORÁCULO: kyc_gate_not_passed NO es relayable (WKH-205)", () => {
    expect(RELAYABLE_PREPARE_REJECTIONS).not.toContain("kyc_gate_not_passed");
    expect(prepareRejectionEnum("kyc_gate_not_passed")).toBe(PREPARE_REJECTED);
  });

  it("...pero SÍ es loggable: colapsado para el browser, visible para el operador", () => {
    expect(LOGGABLE_PREPARE_REJECTIONS).toContain("kyc_gate_not_passed");
  });

  // La invariante que hace que las dos listas no se contradigan: todo lo que se devuelve se puede
  // loguear. Al revés no (loggable ⊋ relayable), y esa asimetría es el punto del diseño.
  it("relayable ⊆ loggable, y loggable es estrictamente más grande", () => {
    for (const r of RELAYABLE_PREPARE_REJECTIONS) expect(LOGGABLE_PREPARE_REJECTIONS).toContain(r);
    expect(LOGGABLE_PREPARE_REJECTIONS.length).toBeGreaterThan(
      RELAYABLE_PREPARE_REJECTIONS.length,
    );
  });

  it.each([null, undefined, 42, {}, "", "reason_inventado", "KYC_GATE_NOT_PASSED"])(
    "un reason no relayable (%s) NUNCA sale crudo: cae al enum de familia",
    (raw) => {
      expect(prepareRejectionEnum(raw)).toBe(PREPARE_REJECTED);
      expect(relayableRejection(QUOTE_REJECTED, raw, RELAYABLE_QUOTE_REJECTIONS)).toBe(
        QUOTE_REJECTED,
      );
    },
  );

  it("los relayables del quote se propagan tal cual (son el enum del agente, sin traducir)", () => {
    for (const r of RELAYABLE_QUOTE_REJECTIONS) {
      expect(relayableRejection(QUOTE_REJECTED, r, RELAYABLE_QUOTE_REJECTIONS)).toBe(r);
    }
    expect(RELAYABLE_QUOTE_REJECTIONS).toEqual([
      "fx_amount_below_minimum",
      "fx_amount_above_maximum",
    ]);
  });

  it("los relayables del payout salen prefijados y todos entran en PREPARE_REJECTION_ENUMS", () => {
    for (const r of RELAYABLE_PREPARE_REJECTIONS) {
      const enumo = prepareRejectionEnum(r);
      expect(enumo).toBe(`prepare_${r}`);
      expect(PREPARE_REJECTION_ENUMS).toContain(enumo);
    }
    expect(PREPARE_REJECTION_ENUMS).toContain(PREPARE_REJECTED);
  });

  // isPrepareRejection es lo que la UI usa para no decir "si te cobramos, te reembolsamos". Un falso
  // positivo acá haría que un fallo POSTERIOR a la firma se anuncie como "no se movió nada", que es
  // la mentira más cara de este flujo. Por eso la lista es cerrada y estos reasons quedan afuera.
  it.each([
    "prepare_no_deposit_address",
    "prepare_upstream_error",
    "prepare_unavailable",
    "prepare_rejected",
    "solana_settle_rejected",
    "principal_state_unknown",
    "quote_amount_mismatch", // el reason CRUDO del agente, sin prefijo: no es un enum nuestro
    null,
    undefined,
  ])("isPrepareRejection(%s) es false: no habilita la frase 'no se movió nada'", (reason) => {
    expect(isPrepareRejection(reason)).toBe(false);
  });

  it.each(PREPARE_REJECTION_ENUMS)("isPrepareRejection(%s) es true", (reason) => {
    expect(isPrepareRejection(reason)).toBe(true);
  });
});
