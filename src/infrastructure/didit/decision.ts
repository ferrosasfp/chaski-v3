// Mapeo puro de la decisión de Didit (GET /v3/session/{id}/decision/) → nuestro modelo.
// Compartido entre la route server-side y el adapter cliente. Sin efectos, testeable.
import type { VerifiedIdentity } from "../../domain/remittance";

export interface DiditDecisionResult {
  terminal: boolean; // ¿la sesión llegó a un estado final?
  verificationId: string;
  approved: boolean;
  payoutAllowed: boolean;
  riskLevel: "low" | "medium" | "high";
  provenance: string; // "didit" → tag de verificación REAL (ver kyc-validator del backend)
  status: string;
  identity: VerifiedIdentity | null;
}

interface DiditRaw {
  status?: string;
  session_id?: string;
  id_verifications?: Array<Record<string, unknown>>;
}

// Estados finales de Didit (case-sensitive, según la doc de la API v3).
const TERMINAL = new Set(["Approved", "Declined", "Abandoned", "Expired", "Kyc Expired"]);
const s = (v: unknown): string => (typeof v === "string" ? v : "");

// NOTA: los paths exactos de los campos extraídos (first_name, last_name, el split paterno/materno)
// dependen de la config del workflow en Didit → verificar contra el sandbox cuando llegue el API key.
// El mapeo es defensivo: tolera campos ausentes sin romper.
export function mapDiditDecision(raw: DiditRaw): DiditDecisionResult {
  const status = s(raw?.status) || "In Progress";
  const approved = status === "Approved";
  const idv = raw?.id_verifications?.[0];
  const identity: VerifiedIdentity | null = idv
    ? {
        firstName: s(idv.first_name),
        lastNamePaternal: s(idv.last_name),
        lastNameMaternal: s(idv.last_name_2 ?? idv.second_last_name),
        documentType: s(idv.document_type) || "DNI",
        documentNumber: s(idv.document_number),
        dateOfBirth: s(idv.date_of_birth),
        nationality: s(idv.nationality) || s(idv.issuing_country),
      }
    : null;
  return {
    terminal: TERMINAL.has(status),
    verificationId: s(raw?.session_id),
    approved,
    payoutAllowed: approved,
    riskLevel: approved ? "low" : "high",
    provenance: "didit",
    status,
    identity,
  };
}
