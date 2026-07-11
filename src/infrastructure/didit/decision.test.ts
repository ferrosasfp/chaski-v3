import { describe, expect, it } from "vitest";
import type { VerifiedIdentity } from "../../domain/remittance";
import { maskDecision, maskIdentity, mapDiditDecision } from "./decision";

describe("mapDiditDecision — Didit decision → modelo Chaski", () => {
  it("Approved con identidad → aprobado, payoutAllowed, terminal, identidad extraída (apellidos separados)", () => {
    const raw = {
      status: "Approved",
      session_id: "sess-123",
      id_verifications: [
        {
          first_name: "MARIA ELENA",
          last_name: "QUISPE",
          second_last_name: "MAMANI",
          document_type: "DNI",
          document_number: "44556677",
          date_of_birth: "1990-05-14",
          nationality: "PE",
        },
      ],
    };
    const r = mapDiditDecision(raw);
    expect(r.approved).toBe(true);
    expect(r.payoutAllowed).toBe(true);
    expect(r.terminal).toBe(true);
    expect(r.provenance).toBe("didit");
    expect(r.riskLevel).toBe("low");
    expect(r.verificationId).toBe("sess-123");
    expect(r.identity).not.toBeNull();
    expect(r.identity?.firstName).toBe("MARIA ELENA");
    expect(r.identity?.lastNamePaternal).toBe("QUISPE");
    expect(r.identity?.lastNameMaternal).toBe("MAMANI");
    expect(r.identity?.documentNumber).toBe("44556677");
    expect(r.identity?.dateOfBirth).toBe("1990-05-14");
  });

  it("Declined → no aprobado, no payoutAllowed, terminal, riesgo alto", () => {
    const r = mapDiditDecision({ status: "Declined", session_id: "s2", id_verifications: [] });
    expect(r.approved).toBe(false);
    expect(r.payoutAllowed).toBe(false);
    expect(r.terminal).toBe(true);
    expect(r.riskLevel).toBe("high");
    expect(r.identity).toBeNull();
  });

  it("In Progress → NO terminal (la DApp sigue poll-eando)", () => {
    const r = mapDiditDecision({ status: "In Progress", session_id: "s3" });
    expect(r.terminal).toBe(false);
    expect(r.approved).toBe(false);
  });

  it("defensivo: payload vacío / campos ausentes no rompen", () => {
    const r = mapDiditDecision({});
    expect(r.status).toBe("In Progress");
    expect(r.terminal).toBe(false);
    expect(r.identity).toBeNull();
    expect(r.provenance).toBe("didit");
  });

  it("extrae vendorData (presente → valor; ausente → '') — base del ownership check (WKH-180)", () => {
    const withVendor = mapDiditDecision({
      status: "Approved",
      session_id: "s6",
      vendor_data: "0xSender",
    });
    expect(withVendor.vendorData).toBe("0xSender");
    const withoutVendor = mapDiditDecision({ status: "Approved", session_id: "s7" });
    expect(withoutVendor.vendorData).toBe("");
  });

  it("tolera nombre de campo alternativo para el 2º apellido (last_name_2)", () => {
    const r = mapDiditDecision({
      status: "Approved",
      session_id: "s5",
      id_verifications: [{ first_name: "JUAN", last_name: "PEREZ", last_name_2: "GOMEZ" }],
    });
    expect(r.identity?.lastNameMaternal).toBe("GOMEZ");
    expect(r.identity?.documentType).toBe("DNI"); // default cuando falta
  });
});

const fullIdentity: VerifiedIdentity = {
  firstName: "María Elena",
  lastNamePaternal: "Quispe",
  lastNameMaternal: "Mamani",
  documentType: "DNI",
  documentNumber: "44556677",
  dateOfBirth: "1990-05-14",
  nationality: "PE",
};

describe("maskIdentity — defensa en profundidad (WKH-179 AC-3, CD-8)", () => {
  it("enmascara documentNumber dejando los últimos 4 (44556677 → ****6677)", () => {
    expect(maskIdentity(fullIdentity).documentNumber).toBe("****6677");
  });

  it("conserva el resto de campos intactos", () => {
    const m = maskIdentity(fullIdentity);
    expect(m.firstName).toBe("María Elena");
    expect(m.dateOfBirth).toBe("1990-05-14");
    expect(m.lastNamePaternal).toBe("Quispe");
    expect(m.nationality).toBe("PE");
  });

  it("edge: len ≤ 4 → todo '*' (nunca <4 dígitos en claro)", () => {
    expect(maskIdentity({ ...fullIdentity, documentNumber: "1234" }).documentNumber).toBe("****");
    expect(maskIdentity({ ...fullIdentity, documentNumber: "12" }).documentNumber).toBe("**");
  });

  it("edge: documentNumber vacío → ''", () => {
    expect(maskIdentity({ ...fullIdentity, documentNumber: "" }).documentNumber).toBe("");
  });
});

describe("maskDecision — compone sobre la decisión", () => {
  it("identity nula → null (no rompe)", () => {
    const raw = mapDiditDecision({ status: "In Progress" });
    expect(maskDecision(raw).identity).toBeNull();
  });

  it("identity presente → documentNumber enmascarado, resto intacto", () => {
    const raw = mapDiditDecision({
      status: "Approved",
      id_verifications: [{ document_number: "44556677", first_name: "Ana" }],
    });
    const masked = maskDecision(raw);
    expect(masked.identity?.documentNumber).toBe("****6677");
    expect(masked.identity?.firstName).toBe("Ana");
  });
});
