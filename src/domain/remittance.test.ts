import { describe, it, expect } from "vitest";
import { Money } from "./money";
import {
  canTransition,
  type KycVerification,
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
  payoutAllowed: true,
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
  const r = Remittance.create("r", beneficiary(), Money.of(400, "USDC"), T0);
  r.startKyc(T0, OWNER);
  r.applyKyc(passKyc, T0);
  return r; // kyc_passed
}

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
    expect(canTransition("created", "kyc_pending")).toBe(true);
    expect(canTransition("created", "settled")).toBe(false);
    expect(canTransition("payout_failed", "refunded")).toBe(true);
  });

  it("startKyc setea ownerAddress en el estado (AC-6)", () => {
    const r = Remittance.create("r", beneficiary(), Money.of(400, "USDC"), T0);
    expect(r.snapshot.ownerAddress).toBeNull();
    r.startKyc(T0, OWNER);
    expect(r.snapshot.ownerAddress).toBe(OWNER);
  });

  it("create inicializa ownerAddress en null (remesa abandonada sin owner)", () => {
    const r = Remittance.create("r", beneficiary(), Money.of(400, "USDC"), T0);
    expect(r.snapshot.ownerAddress).toBeNull();
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
