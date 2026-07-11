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
  vendorData: string; // eco de vendor_data (= senderAddress) → base del ownership check (WKH-180); "" si ausente
}

interface DiditRaw {
  status?: string;
  session_id?: string;
  id_verifications?: Array<Record<string, unknown>>;
  vendor_data?: string; // lo que /api/kyc/session mandó (= senderAddress); Didit lo eco-a en /decision/ (WKH-180)
  risk_level?: string; // TBD placeholder AML (WKH-22/Fase A); UN candidato documentado, no inventar más
}

// Estados finales de Didit (case-sensitive, según la doc de la API v3).
const TERMINAL = new Set(["Approved", "Declined", "Abandoned", "Expired", "Kyc Expired"]);
const s = (v: unknown): string => (typeof v === "string" ? v : "");

// Mapeo defensivo del riesgo AML (WKH-181). Si el payload trae una señal fina reconocida
// ("low"|"medium"|"high") se preserva (AC-9); si no, fallback binario approved?low:high (AC-10,
// CD-3: sin 4to valor). Puro (AC-11).
function resolveRiskLevel(raw: DiditRaw, approved: boolean): "low" | "medium" | "high" {
  const c = raw?.risk_level; // UN candidato documentado; NO inventar múltiples nombres
  if (c === "low" || c === "medium" || c === "high") return c;
  return approved ? "low" : "high";
}

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
    riskLevel: resolveRiskLevel(raw, approved),
    provenance: "didit",
    status,
    identity,
    vendorData: s(raw?.vendor_data),
  };
}

// ── Masking (WKH-179, defensa en profundidad) ────────────────────────────────
// Enmascara el documentNumber en el límite HTTP (últimos 4). Puro, testeable sin I/O (CD-B).
// El resto de campos queda intacto — siguen protegidos por el auth check (AC-1); el masking
// es defensa en profundidad SOLO sobre el número. CD-8: nunca exponer <4 dígitos en claro.
export function maskIdentity(identity: VerifiedIdentity): VerifiedIdentity {
  const dn = identity.documentNumber;
  const masked =
    dn.length <= 4 ? "*".repeat(dn.length) : "*".repeat(dn.length - 4) + dn.slice(-4);
  return { ...identity, documentNumber: masked };
}

// Compone el masking sobre la decisión completa. identity nula → null (ya se filtra en mapDiditDecision).
export function maskDecision(d: DiditDecisionResult): DiditDecisionResult {
  return { ...d, identity: d.identity ? maskIdentity(d.identity) : null };
}
