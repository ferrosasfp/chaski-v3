import { describe, expect, it } from "vitest";
import { mapDiditDecision } from "./decision";

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
