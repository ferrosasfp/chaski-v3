import { describe, it, expect } from "vitest";
import { Money } from "./money";
import {
  canTransition,
  isParseableIso,
  type KycVerification,
  MIN_SEND_USD,
  type Quote,
  Remittance,
  toPersistedIdentity,
  type VerifiedIdentity,
} from "./remittance";
import { beneficiary, QUOTE_EXPIRES, T0 } from "../test-support/fakes";

const OWNER = "0xSender";

const passKyc: KycVerification = {
  verificationId: "v",
  approved: true,
  payoutAllowed: true, realVerified: true, verifiedAt: null,
  riskLevel: "low",
  provenance: "didit",
  identity: null,
};
const quote = (send = 400): Quote => ({
  quoteId: "q1",
  send: Money.of(send, "USDC"),
  receive: Money.of(1480, "PEN"),
  feeUsd: Money.of(0.5, "USDC"),
  rate: 3.7,
  etaMinutes: 30,
  expiresAt: QUOTE_EXPIRES,
  provenance: "fake",
});

function ready(): Remittance {
  // WKH-187: cotiza PRIMERO (created→quoted), luego el KYC. Queda kyc_passed CON quote.
  const r = Remittance.create("r", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote(), T0); // created → quoted
  r.startKyc(T0, OWNER); // quoted → kyc_pending
  r.applyKyc(passKyc, T0); // kyc_pending → kyc_passed (quote sobrevive por shallow-merge)
  return r; // kyc_passed con quote
}

// ── WKH-314 — el mínimo de la interfaz, y por qué NO se verifica con assertReceiveConsistent ──
describe("WKH-314 — monto mínimo enviable", () => {
  // Assert contra el LITERAL, no contra la constante importada comparada consigo misma: este
  // número es una decisión del founder ($5, que con la comisión por defecto de $0.50 deja la
  // comisión en el 10% del piso). Si alguien lo mueve, este test tiene que obligar a decidirlo.
  it("T-314-DOM-1: el mínimo es 5 dólares", () => {
    expect(MIN_SEND_USD).toBe(5);
  });

  // CONTRATO CROSS-REPO, sin import posible: la autoridad es `FX_MIN_SEND_USD` del agente
  // `remit-corridor-fx`, cuyo default es el MISMO 5. Este de acá es la copia para la interfaz.
  // Si divergen, tiene que ganar el agente y la degradación es benigna (la interfaz deja pasar,
  // el agente corta con `fx_amount_below_minimum` y la persona ve un error, no un cero). Lo que
  // NO puede pasar es que la interfaz sea MÁS permisiva de lo que este número declara.
  it("T-314-DOM-2: el mínimo es positivo y mayor que la comisión por defecto del agente (0.50)", () => {
    expect(MIN_SEND_USD).toBeGreaterThan(0.5);
  });

  // Fija POR QUÉ hizo falta un guard nuevo en vez de endurecer el invariante que ya existía.
  // `assertReceiveConsistent` recalcula `max(0, send − fee) × rate`: para 40 centavos con
  // comisión 0.50 su esperado da CERO, igual que el `receive` de cero, así que COINCIDE. Este
  // test deja la coincidencia escrita para que nadie "arregle" esa función y termine con la
  // política escrita en dos lados.
  it("T-314-DOM-3: un quote que entrega cero es CONSISTENTE para el invariante — por eso no puede atajarlo", () => {
    const quoteQueEntregaCero: Quote = {
      quoteId: "q-cero",
      send: Money.of(0.4, "USDC"),
      receive: Money.of(0, "PEN"), // max(0, 0.40 − 0.50) × 3.315 = 0
      feeUsd: Money.of(0.5, "USDC"),
      rate: 3.315,
      etaMinutes: 30,
      expiresAt: QUOTE_EXPIRES,
      provenance: "fx-mid-live",
    };
    const r = Remittance.create("r-cero", beneficiary(), Money.of(0.4, "USDC"), T0);
    // NO lanza: el invariante está de acuerdo con la cotización que entrega cero.
    expect(() => r.attachQuote(quoteQueEntregaCero, T0)).not.toThrow();
    expect(r.status).toBe("quoted"); // y la remesa AVANZA de estado con la promesa de cero
  });
});

describe("Remittance — máquina de estados", () => {
  it("happy path completo", () => {
    const r = ready();
    expect(r.status).toBe("kyc_passed");
    r.attachQuote(quote(), T0);
    expect(r.status).toBe("quoted");
    r.confirm(T0);
    expect(r.status).toBe("confirmed");
    r.markPrincipalIn("0x1", T0);
    r.markPayoutSubmitted("p1", T0);
    r.markSettled("0x2", Money.of(1480, "PEN"), T0);
    expect(r.status).toBe("settled");
    expect(r.isTerminal).toBe(true);
  });

  it("KYC no pasa → kyc_failed terminal", () => {
    const r = Remittance.create("r", beneficiary(), Money.of(400, "USDC"), T0);
    r.attachQuote(quote(), T0); // WKH-187: cotiza antes del KYC
    r.startKyc(T0, OWNER);
    r.applyKyc({ ...passKyc, approved: false, payoutAllowed: false }, T0);
    expect(r.status).toBe("kyc_failed");
    expect(r.isTerminal).toBe(true);
  });

  it("no confirma sin KYC pasado", () => {
    const r = Remittance.create("r", beneficiary(), Money.of(400, "USDC"), T0);
    expect(() => r.confirm(T0)).toThrow(/confirm_requires_kyc_passed/);
  });

  it("attachQuote rechaza monto que no matchea (invariante money-path)", () => {
    expect(() => ready().attachQuote(quote(999), T0)).toThrow(/quote_amount_mismatch/);
  });

  it("attachQuote rechaza quote vencido", () => {
    expect(() => ready().attachQuote({ ...quote(), expiresAt: T0 }, T0)).toThrow(/quote_expired/);
  });

  it("confirm con quote vencido lanza", () => {
    const r = ready();
    r.attachQuote(quote(), T0);
    expect(() => r.confirm("2026-07-09T18:20:00.000Z")).toThrow(/confirm_quote_expired/);
  });

  it("transición inválida lanza", () => {
    const r = Remittance.create("r", beneficiary(), Money.of(400, "USDC"), T0);
    expect(() => r.markSettled("x", Money.of(1, "PEN"), T0)).toThrow(/invalid_transition/);
  });

  it("canTransition", () => {
    expect(canTransition("created", "quoted")).toBe(true); // WKH-187: cotiza primero
    expect(canTransition("created", "kyc_pending")).toBe(false); // WKH-187: el KYC ya no arranca sin cotizar
    expect(canTransition("created", "settled")).toBe(false);
    expect(canTransition("payout_failed", "refunded")).toBe(true);
  });

  it("startKyc setea ownerAddress en el estado (AC-6)", () => {
    const r = Remittance.create("r", beneficiary(), Money.of(400, "USDC"), T0);
    expect(r.snapshot.ownerAddress).toBeNull();
    r.attachQuote(quote(), T0); // WKH-187: cotiza antes del KYC
    r.startKyc(T0, OWNER);
    expect(r.snapshot.ownerAddress).toBe(OWNER);
  });

  it("create inicializa ownerAddress en null (remesa abandonada sin owner)", () => {
    const r = Remittance.create("r", beneficiary(), Money.of(400, "USDC"), T0);
    expect(r.snapshot.ownerAddress).toBeNull();
  });
});

describe("WKH-187 — reorden quote-antes-del-KYC (money-path INVIOLABLE)", () => {
  // T-COMPLIANCE (AC-3): el gate confirm() NO se debilitó con el reorden. Lee el campo `kyc`,
  // no la posición en la FSM: sin KYC pasado, confirm() rechaza en cualquier estado alcanzable.
  it("T-COMPLIANCE: confirm() sin KYC lanza confirm_requires_kyc_passed en el NUEVO orden", () => {
    // desde `quoted` (created→quoted, kyc=null): el path pre-KYC más peligroso (DT-1b abre quoted→confirmed)
    const q = Remittance.create("r", beneficiary(), Money.of(400, "USDC"), T0);
    q.attachQuote(quote(), T0);
    expect(q.status).toBe("quoted");
    expect(q.snapshot.kyc).toBeNull();
    expect(() => q.confirm(T0)).toThrow(/confirm_requires_kyc_passed/); // gate ANTES de to("confirmed")
    expect(q.status).toBe("quoted"); // NO transicionó a confirmed

    // desde `kyc_pending` (quoted→kyc_pending, KYC aún no resuelto)
    const p = Remittance.create("r", beneficiary(), Money.of(400, "USDC"), T0);
    p.attachQuote(quote(), T0);
    p.startKyc(T0, OWNER);
    expect(p.status).toBe("kyc_pending");
    expect(() => p.confirm(T0)).toThrow(/confirm_requires_kyc_passed/);

    // KYC rechazado tampoco confirma
    const f = Remittance.create("r", beneficiary(), Money.of(400, "USDC"), T0);
    f.attachQuote(quote(), T0);
    f.startKyc(T0, OWNER);
    f.applyKyc({ ...passKyc, approved: false, payoutAllowed: false }, T0);
    expect(() => f.confirm(T0)).toThrow(/confirm_requires_kyc_passed/);
  });

  // T-AC5a (AC-5): re-quote kyc_passed→quoted CONSERVA state.kyc (shallow-merge), luego confirm OK.
  it("T-AC5a: re-quote post-KYC conserva state.kyc y permite confirm quoted→confirmed", () => {
    const r = ready(); // kyc_passed con quote y kyc set
    expect(r.snapshot.kyc).not.toBeNull();
    r.attachQuote(quote(), T0); // kyc_passed → quoted (re-quote)
    expect(r.status).toBe("quoted");
    expect(r.snapshot.kyc).not.toBeNull(); // el KYC NO se perdió (no se re-escanea DNI)
    r.confirm(T0); // quoted → confirmed (DT-1b) con kyc pasado
    expect(r.status).toBe("confirmed");
  });

  // T-REORDER (AC-1/DT-1b): la trayectoria pre-KYC-quote es válida; created→kyc_pending ya no existe.
  it("T-REORDER: created→quoted→kyc_pending→kyc_passed→confirmed válida; created→kyc_pending inválida", () => {
    expect(canTransition("created", "quoted")).toBe(true);
    expect(canTransition("created", "kyc_pending")).toBe(false);
    const r = Remittance.create("r", beneficiary(), Money.of(400, "USDC"), T0);
    r.attachQuote(quote(), T0);
    expect(r.status).toBe("quoted"); // quote visible ANTES del KYC
    r.startKyc(T0, OWNER);
    expect(r.status).toBe("kyc_pending");
    r.applyKyc(passKyc, T0);
    expect(r.status).toBe("kyc_passed");
    r.confirm(T0);
    expect(r.status).toBe("confirmed");
    // el arranque directo al KYC ya no es alcanzable
    const bad = Remittance.create("r", beneficiary(), Money.of(400, "USDC"), T0);
    expect(() => bad.startKyc(T0, OWNER)).toThrow(/invalid_transition:created->kyc_pending/);
  });

  // T-REQUOTE (AC-5/DT-1b): quote expira DURANTE el KYC → re-quote (monto nuevo) → confirm, sin dead-end.
  it("T-REQUOTE: expiry durante KYC → re-cotiza con monto nuevo y confirma (quoted→confirmed)", () => {
    const LATER = "2026-07-09T18:20:00.000Z"; // > QUOTE_EXPIRES
    const r = ready(); // kyc_passed con quote (expira en QUOTE_EXPIRES)
    const oldReceive = r.snapshot.quote!.receive.minor;
    expect(r.isQuoteStillValid(LATER)).toBe(false); // el quote venció durante el KYC
    // auto re-quote con monto nuevo (tasa mejor): kyc_passed → quoted, kyc intacto
    const fresh: Quote = { ...quote(), receive: Money.of(1500, "PEN"), rate: 3.75, expiresAt: "2026-07-09T18:25:00.000Z" };
    r.attachQuote(fresh, LATER);
    expect(r.status).toBe("quoted");
    expect(r.snapshot.quote!.receive.minor).not.toBe(oldReceive); // monto nuevo
    expect(r.snapshot.kyc).not.toBeNull(); // NO se re-escanea DNI
    r.confirm(LATER);
    expect(r.status).toBe("confirmed"); // sin dead-end
  });

  // T-AC9 (AC-9): el tramo post-confirmed (WKH-186) sigue intacto: confirmed→…→settled.
  it("T-AC9: happy path a settled intacto tras el reorden", () => {
    const r = ready();
    r.confirm(T0); // kyc_passed → confirmed
    r.markPrincipalIn("0x1", T0);
    expect(r.status).toBe("principal_in");
    r.markPayoutSubmitted("p1", T0);
    expect(r.status).toBe("payout_submitted");
    r.markSettled("0x2", Money.of(1480, "PEN"), T0);
    expect(r.status).toBe("settled");
    expect(r.isTerminal).toBe(true);
  });
});

describe("WKH-198 — expiry fail-closed (guard NaN, money-path CD-1)", () => {
  it("AC-1a: attachQuote con expiresAt 'not-a-date' (no-parseable) → EXPIRADO", () => {
    expect(() => ready().attachQuote({ ...quote(), expiresAt: "not-a-date" }, T0)).toThrow(
      /quote_expired/,
    );
  });

  it("AC-1b: attachQuote con expiresAt '' (string vacío, CD-6) → EXPIRADO", () => {
    expect(() => ready().attachQuote({ ...quote(), expiresAt: "" }, T0)).toThrow(/quote_expired/);
  });

  it("AC-1c: confirm con nowIso malformado (quote válido) → confirm_quote_expired (guard sobre nowIso)", () => {
    const r = ready();
    r.attachQuote(quote(), T0); // kyc_passed → quoted con quote válido, KYC intacto
    expect(() => r.confirm("not-a-date")).toThrow(/confirm_quote_expired/);
  });

  it("AC-1d: isQuoteStillValid con nowIso malformado (quote válido) → false (fail-closed)", () => {
    const r = ready(); // tiene quote válido
    expect(r.isQuoteStillValid("not-a-date")).toBe(false);
  });

  it("AC-2 no-regresión: expiresAt válido == now (<=) → EXPIRADO", () => {
    expect(() => ready().attachQuote({ ...quote(), expiresAt: T0 }, T0)).toThrow(/quote_expired/);
  });

  it("AC-3 no-regresión: expiresAt futuro (QUOTE_EXPIRES), now T0 → NO expira", () => {
    const r = ready();
    r.attachQuote({ ...quote(), expiresAt: QUOTE_EXPIRES }, T0);
    expect(r.status).toBe("quoted");
    expect(r.isQuoteStillValid(T0)).toBe(true);
  });

  it("isParseableIso: ISO válido → true; 'not-a-date' y '' → false", () => {
    expect(isParseableIso("2026-07-09T18:00:00.000Z")).toBe(true);
    expect(isParseableIso("not-a-date")).toBe(false);
    expect(isParseableIso("")).toBe(false);
  });
});

describe("Remittance.attachQuote — A5 consistencia receive vs send/fee/rate (AC-1/AC-2)", () => {
  // expected = (400 − 0.5) × 3.7 = 1478.15 ; allowedDelta = max(0.02, 1478.15 × 1%) = 14.7815
  it("AC-1: receive consistente (dentro de tolerancia) → status quoted", () => {
    const r = ready();
    r.attachQuote(quote(), T0); // receive 1480, delta 1.85 « 14.78
    expect(r.status).toBe("quoted");
    expect(r.snapshot.quote?.receive.major).toBe(1480);
  });

  it("AC-2: receive inflado (2×) > tolerancia → throw quote_receive_mismatch, NO pasa a quoted", () => {
    const r = ready();
    expect(() => r.attachQuote({ ...quote(), receive: Money.of(2960, "PEN") }, T0)).toThrow(
      /quote_receive_mismatch/,
    );
    expect(r.status).toBe("kyc_passed"); // no transicionó
  });

  it("AC-2: receive degradado a la mitad > tolerancia → throw quote_receive_mismatch", () => {
    const r = ready();
    expect(() => r.attachQuote({ ...quote(), receive: Money.of(740, "PEN") }, T0)).toThrow(
      /quote_receive_mismatch/,
    );
    expect(r.status).toBe("kyc_passed");
  });

  it("AC-2 boundary: justo DENTRO de la tolerancia pasa (delta 14.75 < 14.7815)", () => {
    const r = ready();
    r.attachQuote({ ...quote(), receive: Money.of(1492.9, "PEN") }, T0); // delta 14.75
    expect(r.status).toBe("quoted");
  });

  it("AC-2 boundary: justo AFUERA de la tolerancia falla (delta 14.85 > 14.7815)", () => {
    const r = ready();
    expect(() => r.attachQuote({ ...quote(), receive: Money.of(1493, "PEN") }, T0)).toThrow(
      /quote_receive_mismatch/,
    );
    expect(r.status).toBe("kyc_passed");
  });
});

describe("toPersistedIdentity — reductor único de PII (AC-1, CD-2)", () => {
  const full: VerifiedIdentity = {
    firstName: "María Elena",
    lastNamePaternal: "Quispe",
    lastNameMaternal: "Mamani",
    documentType: "DNI",
    documentNumber: "44556677",
    dateOfBirth: "1990-05-14",
    nationality: "PE",
  };

  it("conserva nombres + documentType; documentNumber → últimos 4 (documentNumberLast4)", () => {
    const p = toPersistedIdentity(full);
    expect(p.firstName).toBe("María Elena");
    expect(p.lastNamePaternal).toBe("Quispe");
    expect(p.lastNameMaternal).toBe("Mamani");
    expect(p.documentType).toBe("DNI");
    expect(p.documentNumberLast4).toBe("6677");
  });

  it("DROPEA documentNumber completo / dateOfBirth / nationality (no aparecen en el shape reducido)", () => {
    const p = toPersistedIdentity(full);
    expect(Object.keys(p).sort()).toEqual(
      ["documentNumberLast4", "documentType", "firstName", "lastNameMaternal", "lastNamePaternal"].sort(),
    );
    expect("documentNumber" in p).toBe(false);
    expect("dateOfBirth" in p).toBe(false);
    expect("nationality" in p).toBe(false);
  });

  it("edge documentNumber: '' → '' ; '12' → '12' (nunca más de 4)", () => {
    expect(toPersistedIdentity({ ...full, documentNumber: "" }).documentNumberLast4).toBe("");
    expect(toPersistedIdentity({ ...full, documentNumber: "12" }).documentNumberLast4).toBe("12");
    expect(toPersistedIdentity({ ...full, documentNumber: "1234" }).documentNumberLast4).toBe("1234");
    expect(toPersistedIdentity({ ...full, documentNumber: "12345" }).documentNumberLast4).toBe("2345");
  });
});

describe("WKH-200 — payoutProvenance propagado por mark* (AC-5)", () => {
  it("T-AC5a: markPayoutSubmitted lo setea y sobrevive a markSettled sin arg (to() lo conserva)", () => {
    const r = ready();
    r.confirm(T0);
    r.markPrincipalIn("0x1", T0);
    r.markPayoutSubmitted("p1", T0, "local-fallback");
    expect(r.snapshot.payoutProvenance).toBe("local-fallback");
    r.markSettled("0x", Money.of(1480, "PEN"), T0); // sin provenance → conservado
    expect(r.status).toBe("settled");
    expect(r.snapshot.payoutProvenance).toBe("local-fallback");
  });

  it("T-AC5b: markSettled con provenance backfillea una remesa que llegó a payout_submitted sin él", () => {
    const r = ready();
    r.confirm(T0);
    r.markPrincipalIn("0x1", T0);
    r.markPayoutSubmitted("p1", T0); // sin provenance → null
    expect(r.snapshot.payoutProvenance).toBeNull();
    r.markSettled("0x", Money.of(1480, "PEN"), T0, "local-fallback");
    expect(r.snapshot.payoutProvenance).toBe("local-fallback");
  });

  it("create() inicializa payoutProvenance en null", () => {
    const r = Remittance.create("r", beneficiary(), Money.of(400, "USDC"), T0);
    expect(r.snapshot.payoutProvenance).toBeNull();
  });
});
