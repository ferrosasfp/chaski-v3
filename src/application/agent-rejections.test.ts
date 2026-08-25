// Tests — la POLÍTICA de qué rechazo del agente sale al browser y cuál queda colapsado.
//
// Estos tests no prueban una ruta: prueban la decisión. Existen porque el criterio de las dos listas
// se puede erosionar de a un reason por vez, y cada erosión se ve razonable de a una ("total, ya
// pasó el guard de autoridad"). El candado del oráculo es el único de este archivo que protege algo
// que no es diagnóstico: `kyc_gate_not_passed` es un VEREDICTO sobre una verificación de identidad,
// que es la familia exacta que WKH-205 colapsó en /api/payout/validate.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  LOGGABLE_PREPARE_REJECTIONS,
  NO_AGENT_REASONS_MEANING_NOBODY,
  PREPARE_REJECTED,
  PREPARE_REJECTION_ENUMS,
  QUOTE_NO_AGENT_FOR_CAPABILITY,
  QUOTE_REJECTED,
  RELAYABLE_PREPARE_REJECTIONS,
  PREPARE_UNREACHABLE_ENUMS,
  isPrepareRejection,
  isPrepareUnreachable,
  noAgentMeansNobodyFits,
  prepareRejectionEnum,
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

  // ⚠️ LA MITAD DE FX DE ESTE `it.each` SE FUE EN WKH-332/W4. Comprobaba
  // `relayableRejection(QUOTE_REJECTED, raw, RELAYABLE_QUOTE_REJECTIONS)`, y las dos cosas —el helper y
  // la lista— se borraron con el canal que las alimentaba: el `reason` del agente de FX llegaba en el
  // body de error del carril punto a punto, que W3 borró. Lo que se conserva es la mitad del payout,
  // cuyo `reason` sí llega dentro del 200 de `/compose`.
  it.each([null, undefined, 42, {}, "", "reason_inventado", "KYC_GATE_NOT_PASSED"])(
    "un reason no relayable (%s) NUNCA sale crudo: cae al enum de familia",
    (raw) => {
      expect(prepareRejectionEnum(raw)).toBe(PREPARE_REJECTED);
    },
  );

  // 🔴 `it` INVERTIDO, no borrado: era "los relayables del quote se propagan tal cual (son el enum del
  // agente, sin traducir)", y clavaba que `RELAYABLE_QUOTE_REJECTIONS` fuera exactamente
  // `["fx_amount_below_minimum", "fx_amount_above_maximum"]` y que esos valores viajaran CRUDOS al
  // browser. Esa es la propiedad que AC-5 prohíbe. Lo que queda es el enum de FAMILIA y el candado de
  // que sea una palabra NUESTRA: si alguien lo cambia por el vocabulario del agente, esto se pone rojo.
  it("AC-5: el enum de familia del quote es una palabra NUESTRA, no el vocabulario del agente", () => {
    expect(QUOTE_REJECTED).toBe("a2a_quote_rejected");
    // `fx_` es el prefijo privado del agente de FX. Un enum nuestro no puede llevarlo, porque el que
    // atienda la capacidad mañana puede usar otro prefijo o ninguno.
    expect(QUOTE_REJECTED).not.toContain("fx_");
    // Y ninguno de los dos enums que la app emite hoy por ese leg lo lleva tampoco.
    expect(QUOTE_NO_AGENT_FOR_CAPABILITY).not.toContain("fx_");
  });

  // T-335-AR-1 (CD-1) — WKH-335 le devolvió PRODUCTOR a `QUOTE_REJECTED`: ahora lo emite
  // `app/api/a2a/quote/route.ts` cuando el gateway manda `agentFailure: "INPUT_REJECTED"`.
  //
  // 🔴 POR QUÉ ESTE CANDADO IMPORTA MÁS AHORA QUE ANTES. Mientras el enum no tenía productor, que
  // llevara o no el vocabulario del agente era teórico: no salía a ninguna pantalla. Con productor
  // vivo, este string VIAJA al browser en el body de un 422. Si alguien "mejorara" el enum
  // pegándole el `reason` del agente, estaríamos publicando el vocabulario privado de un tercero —
  // y el que atienda la capacidad mañana puede usar otro prefijo o ninguno.
  //
  // Lo que llega del gateway es una CLASE de dos valores, NO un motivo: por eso el enum no puede
  // ni debe volverse más específico.
  it("T-335-AR-1: con productor vivo, el enum del quote SIGUE sin el vocabulario del agente", () => {
    expect(QUOTE_REJECTED).toBe("a2a_quote_rejected");
    expect(QUOTE_REJECTED).not.toContain("fx_");
    // Tampoco puede filtrarse el vocabulario del CONTRATO nuevo: `agentFailure` es un detalle de
    // transporte entre gateway y route, no algo que la pantalla deba leer.
    expect(QUOTE_REJECTED).not.toContain("INPUT_REJECTED");
    expect(QUOTE_REJECTED).not.toContain("AGENT_ERROR");
    expect(QUOTE_REJECTED).not.toContain("step_failed");
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

// ── CR/BLQ-MED-2 — LOS TRES VALORES DE LA ALLOWLIST, NO UNO ──────────────────────────────────────
//
// 🔴 QUÉ AGUJERO CIERRA, MEDIDO. Los tests de las dos routes sólo ejercitaban `no_candidates`.
// Borrando `"excluded_by_scope"` y `"excluded_by_reputation"` de `NO_AGENT_REASONS_MEANING_NOBODY`,
// `tsc` daba exit 0 y la suite COMPLETA 1587/1587 verde. Con esa mutación puesta, un rechazo por
// piso de reputación —el 422 MÁS probable en producción con los pisos en 2— vuelve a salir 502 y la
// pantalla dice "Algo salió mal" para un caso que SÍ es "no hay quién": la misma regresión de
// precisión que esta HU vino a cerrar, en el sentido contrario.
//
// 🔴 POR QUÉ HAY DOS `it.each` Y NO UNO. Un `it.each(NO_AGENT_REASONS_MEANING_NOBODY)` recorre la
// constante, que es lo que hace falta para que agregar un valor lo ponga a prueba solo — pero NO
// mata el borrado: al sacar un valor, su caso deja de correrse y el `each` sigue verde aplaudiéndose.
// Lo que mata el borrado es recorrer el UNIVERSO del otro lado con el veredicto esperado por fila:
// ahí el valor borrado tiene una fila que espera `true` y recibe `false`.
//
// El universo es exhaustivo por TIPO (`Record<Reason, boolean>` sobre una unión), así que un `reason`
// nuevo del gateway sin fila acá es `tsc` rojo y no un caso que alguien se olvidó — misma técnica que
// (`CABLEADO`, `../composition/container.test.ts:135`).
describe("noAgentMeansNobodyFits — el 422 son CUATRO desenlaces y sólo tres dicen 'no hay quién'", () => {
  // Los cuatro `reason` que el gateway puede mandar en un 422, MEDIDOS en
  // `wasiai-a2a/src/services/capability-resolver.ts:69-80`. Esto NO es una copia de la constante que
  // se prueba: es el contrato del OTRO repo, que es contra lo único que la allowlist se puede medir.
  type ReasonDelGateway =
    | "no_candidates"
    | "excluded_by_scope"
    | "excluded_by_reputation"
    | "reputation_unavailable";
  const DICE_QUE_NO_HAY_NADIE: Record<ReasonDelGateway, boolean> = {
    no_candidates: true, // no hay ninguna capacidad de ese nombre en el catálogo
    excluded_by_scope: true, // las hay, y nuestra credencial no las alcanza
    excluded_by_reputation: true, // las hay, y ninguna llega al piso
    // 🔴 El que NO es un hecho sobre el catálogo: el gateway no pudo leer el historial. Para éste las
    // dos mitades del copy de AC-13 son falsas, y la segunda desaconseja el reintento que sí sirve.
    reputation_unavailable: false,
  };

  it.each(Object.entries(DICE_QUE_NO_HAY_NADIE))(
    "reason '%s' del gateway ⇒ noAgentMeansNobodyFits = %s",
    (reason, esperado) => {
      expect(noAgentMeansNobodyFits(reason)).toBe(esperado);
    },
  );

  // La otra mitad: la allowlist no puede crecer con un reason que el gateway no emite. Sin esto,
  // agregarle "sarasa" la dejaría verde (ninguna fila de arriba la mira).
  it("la allowlist es un SUBCONJUNTO del universo medido: no inventa reasons", () => {
    for (const r of NO_AGENT_REASONS_MEANING_NOBODY) {
      expect(Object.keys(DICE_QUE_NO_HAY_NADIE)).toContain(r);
    }
  });

  it.each(NO_AGENT_REASONS_MEANING_NOBODY)(
    "todo lo que está en la allowlist habilita la afirmación fuerte (%s)",
    (reason) => {
      expect(noAgentMeansNobodyFits(reason)).toBe(true);
    },
  );

  // 🔴 LA DIRECCIÓN DEL DEFAULT, que es la decisión: sólo la allowlist habilita "no hay proveedor".
  // Un 422 sin `reason` (un proxy, un middleware, una versión del gateway que no lo mande) o con uno
  // desconocido NO la habilita y sale por el enum de caída, que es vago y CIERTO.
  it.each([undefined, null, "", 42, {}, "sarasa_inventada", "NO_CANDIDATES", "no_candidates "])(
    "un reason ausente o desconocido (%s) NO habilita la afirmación fuerte",
    (raw) => {
      expect(noAgentMeansNobodyFits(raw)).toBe(false);
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-358 (fix-pack · AR/BLQ-MED-2) — "NO LLEGAMOS A PREGUNTAR" TIENE SU PROPIA FAMILIA
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ PROTEGE, Y NO ES LA FUNCIÓN. `isPrepareUnreachable` es un `includes` sobre dos strings: un `it`
// que le pase esos dos strings y verifique `true` se compara consigo mismo. Lo que hace falta custodiar es
// que esos dos strings SEAN los que los productores emiten, porque la lista está escrita por segunda vez
// en `agent-rejections.ts` (es la "segunda lista" que WKH-332/AR-BLQ-ALTO-2 midió como bug, y acá no se
// puede cerrar por construcción sin mover enums que esta HU no toca). Así que se cierra por MEDICIÓN:
// los enums se DERIVAN del texto de sus dos productores con un regex.
//
// ⚠️ QUÉ NO CIERRA: que la route del server siga contestando esos mismos enums. Eso vive en otro repo de
// este mismo árbol (`app/api/payout/prepare/route.ts`) y no lo mira este barrido.
describe("WKH-358 — `isPrepareUnreachable`: la familia de 'no hubo respuesta de nadie'", () => {
  const GATEWAY = path.resolve(process.cwd(), "src/infrastructure/settlement/http-solana-prepare-gateway.ts");
  const USE_CASE = path.resolve(process.cwd(), "src/application/use-cases/confirm-and-send.ts");
  /** Los enums que los productores DEVUELVEN o PERSISTEN, derivados del archivo y no de una lista. */
  const DEL_GATEWAY = [
    ...new Set(
      [...readFileSync(GATEWAY, "utf8").matchAll(/reason: "(prepare_unavailable|payout_pop_unavailable)"/g)].map(
        (m) => m[1] as string,
      ),
    ),
  ];
  const DEL_USE_CASE = [
    ...new Set(
      [...readFileSync(USE_CASE, "utf8").matchAll(/failAndRefund\(r, "(\w+)", "not_deposited"\)/g)].map(
        (m) => m[1] as string,
      ),
    ),
  ];

  // Refutación del instrumento, primero: sin esto un regex que dejara de matchear pondría todo en verde
  // sobre listas vacías, que es como un candado deja de existir sin que nadie lo note.
  it("los enums se derivaron de verdad, de sus DOS productores", () => {
    expect(DEL_GATEWAY, "el barrido del gateway no encontró ningún `reason:` de esta familia").toHaveLength(2);
    expect(DEL_USE_CASE, "el barrido del use-case no encontró ningún `failAndRefund(..., not_deposited)`").toContain(
      "prepare_unavailable",
    );
  });

  it("todo enum derivado de un productor es reconocido por `isPrepareUnreachable`", () => {
    for (const e of DEL_GATEWAY) {
      expect(
        isPrepareUnreachable(e),
        `el gateway emite \`${e}\` y la pantalla no lo reconoce: cae en el \`else\` del dispatch de ` +
          `\`track\` y la persona lee "si tus USDC entraron al escrow, los sacás vos firmando" sobre una ` +
          "remesa con `principal: not_deposited`.",
      ).toBe(true);
    }
  });

  it("y NO se solapa con la familia de rechazos del agente: son diagnósticos distintos", () => {
    for (const e of PREPARE_UNREACHABLE_ENUMS) {
      expect(isPrepareRejection(e), `\`${e}\` entró a la familia de rechazos: su copy afirma que un agente rechazó`).toBe(false);
      expect(PREPARE_REJECTION_ENUMS).not.toContain(e);
    }
    for (const e of PREPARE_REJECTION_ENUMS) expect(isPrepareUnreachable(e)).toBe(false);
  });

  it.each([undefined, null, "", "prepare_agent_rejected", "payout_failed", "PREPARE_UNAVAILABLE", "prepare_unavailable "])(
    "un reason ausente, de otra familia o con la caja/espacios distintos (%s) NO entra",
    (raw) => {
      expect(isPrepareUnreachable(raw)).toBe(false);
    },
  );
});
