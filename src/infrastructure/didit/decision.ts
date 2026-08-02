// Mapeo puro de la decisión de Didit (GET /v3/session/{id}/decision/) → nuestro modelo.
// Compartido entre la route server-side y el adapter cliente. Sin efectos, testeable.
import type { VerifiedIdentity } from "../../domain/remittance";
import type { DiditEnvironment } from "./didit-env";

/**
 * Etiquetas de origen. El consumidor autoritativo es `REAL_KYC_PROVENANCES` en
 * `wasiai-remittance-agents/src/providers/kyc.ts`, que contiene SÓLO `"didit"` y es la única rama
 * que abre el desembolso en producción (`cashout-payout.ts`, `isKycGatePassed`).
 *
 * 🔴 POR QUÉ SON DOS Y NO UNA. Hasta acá `provenance` era el literal `"didit"` hardcodeado, de modo
 * que CUALQUIER decisión que pasara por este mapeo salía etiquetada como verificación real. Mientras
 * el único origen posible era el host real de Didit eso era cierto por construcción. En el momento en
 * que existe un mock (que es lo que habilita recorrer la app sin escanear un documento), deja de
 * serlo: una verificación simulada quedaría indistinguible de una real y abriría el desembolso.
 *
 * La etiqueta ahora sale del ambiente DECLARADO, no de un literal. `didit-mock` no está en la
 * allowlist, así que un KYC simulado no puede desbloquear un desembolso real: no hace falta que
 * nadie se acuerde de chequearlo, no hay ninguna rama que lo acepte.
 */
export const KYC_PROVENANCE_LIVE = "didit";
export const KYC_PROVENANCE_MOCK = "didit-mock";

export interface DiditDecisionResult {
  terminal: boolean; // ¿la sesión llegó a un estado final?
  verificationId: string;
  approved: boolean;
  payoutAllowed: boolean;
  riskLevel: "low" | "medium" | "high";
  /** Origen de la decisión: `didit` (host real) o `didit-mock` (endpoint nuestro). Ver arriba. */
  provenance: string;
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
/**
 * @param environment ambiente DECLARADO del que salió `raw`. Es un parámetro OBLIGATORIO y no tiene
 *   default a propósito: un default (cualquiera) devuelve el bug que este cambio viene a cerrar, un
 *   call site que se olvida y termina etiquetando como real algo que no lo es. El compilador obliga
 *   a que cada llamador diga contra qué habló.
 */
export function mapDiditDecision(
  raw: DiditRaw,
  environment: DiditEnvironment,
): DiditDecisionResult {
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
    provenance: environment === "live" ? KYC_PROVENANCE_LIVE : KYC_PROVENANCE_MOCK,
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
