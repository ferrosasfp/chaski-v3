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
    const r = mapDiditDecision(raw, "live");
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
    const r = mapDiditDecision({ status: "Declined", session_id: "s2", id_verifications: [] }, "live");
    expect(r.approved).toBe(false);
    expect(r.payoutAllowed).toBe(false);
    expect(r.terminal).toBe(true);
    expect(r.riskLevel).toBe("high");
    expect(r.identity).toBeNull();
  });

  it("In Progress → NO terminal (la DApp sigue poll-eando)", () => {
    const r = mapDiditDecision({ status: "In Progress", session_id: "s3" }, "live");
    expect(r.terminal).toBe(false);
    expect(r.approved).toBe(false);
  });

  it("defensivo: payload vacío / campos ausentes no rompen", () => {
    const r = mapDiditDecision({}, "live");
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
    }, "live");
    expect(withVendor.vendorData).toBe("0xSender");
    const withoutVendor = mapDiditDecision({ status: "Approved", session_id: "s7" }, "live");
    expect(withoutVendor.vendorData).toBe("");
  });

  it("tolera nombre de campo alternativo para el 2º apellido (last_name_2)", () => {
    const r = mapDiditDecision({
      status: "Approved",
      session_id: "s5",
      id_verifications: [{ first_name: "JUAN", last_name: "PEREZ", last_name_2: "GOMEZ" }],
    }, "live");
    expect(r.identity?.lastNameMaternal).toBe("GOMEZ");
    expect(r.identity?.documentType).toBe("DNI"); // default cuando falta
  });
});

describe("resolveRiskLevel (vía mapDiditDecision) — señal AML defensiva (AC-9/10/11, CD-3)", () => {
  it("AC-9: risk_level fino reconocido ('medium') se PRESERVA en vez de colapsar a binario", () => {
    const r = mapDiditDecision({ status: "Approved", session_id: "s", risk_level: "medium" }, "live");
    expect(r.riskLevel).toBe("medium");
  });

  it("AC-9: 'high' explícito en un Approved gana sobre el 'low' binario", () => {
    const r = mapDiditDecision({ status: "Approved", session_id: "s", risk_level: "high" }, "live");
    expect(r.riskLevel).toBe("high");
  });

  it("AC-10: sin campo risk_level → fallback binario (Approved→low, Declined→high), sin regresión", () => {
    expect(mapDiditDecision({ status: "Approved", session_id: "s" }, "live").riskLevel).toBe("low");
    expect(mapDiditDecision({ status: "Declined", session_id: "s" }, "live").riskLevel).toBe("high");
  });

  it("AC-11: valor no reconocido ('extreme') → fallback binario, NUNCA un 4to valor (CD-3)", () => {
    const approved = mapDiditDecision({ status: "Approved", session_id: "s", risk_level: "extreme" }, "live");
    expect(approved.riskLevel).toBe("low"); // cae al binario, no propaga "extreme"
    const declined = mapDiditDecision({ status: "Declined", session_id: "s", risk_level: "extreme" }, "live");
    expect(declined.riskLevel).toBe("high");
    expect(["low", "medium", "high"]).toContain(approved.riskLevel);
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
    const raw = mapDiditDecision({ status: "In Progress" }, "live");
    expect(maskDecision(raw).identity).toBeNull();
  });

  it("identity presente → documentNumber enmascarado, resto intacto", () => {
    const raw = mapDiditDecision({
      status: "Approved",
      id_verifications: [{ document_number: "44556677", first_name: "Ana" }],
    }, "live");
    const masked = maskDecision(raw);
    expect(masked.identity?.documentNumber).toBe("****6677");
    expect(masked.identity?.firstName).toBe("Ana");
  });
});

// ── El origen de la etiqueta (KYC simulado vs real) ──────────────────────────────────────────────
// Estos tests NO son sobre un string. Son sobre el único eje que impide que una verificación que
// nadie hizo desbloquee un desembolso real: el consumidor autoritativo es `REAL_KYC_PROVENANCES` en
// wasiai-remittance-agents, que contiene SÓLO "didit". Si esta etiqueta se derivara mal, el agente
// de payout no tendría forma de notarlo.
describe("provenance — sale del ambiente declarado, nunca de un literal", () => {
  const approved = { status: "Approved", session_id: "s-prov", vendor_data: "wallet-1" };

  it("live ⇒ didit (la etiqueta que la allowlist del agente acepta)", () => {
    expect(mapDiditDecision(approved, "live").provenance).toBe("didit");
  });

  it("mock ⇒ didit-mock, y NO es la etiqueta real", () => {
    const p = mapDiditDecision(approved, "mock").provenance;
    expect(p).toBe("didit-mock");
    // La aserción que importa: distinta de la real. Escrita como desigualdad a propósito, para que
    // un futuro `provenance: "didit"` en la rama mock rompa acá aunque el literal de arriba cambie.
    expect(p).not.toBe(mapDiditDecision(approved, "live").provenance);
  });

  it("el ambiente NO cambia nada más de la decisión: sólo la etiqueta de origen", () => {
    const live = mapDiditDecision(approved, "live");
    const mock = mapDiditDecision(approved, "mock");
    // Si el mock también moviera `approved` o `payoutAllowed`, el gate se estaría abriendo por dos
    // ejes a la vez y la etiqueta dejaría de ser la única cosa que los separa.
    expect({ ...live, provenance: "" }).toEqual({ ...mock, provenance: "" });
    expect(mock.approved).toBe(true);
    expect(mock.payoutAllowed).toBe(true);
  });
});
