// Infrastructure — KycStore. CACHÉ DE DISPOSITIVO del veredicto (era la fuente de verdad; ver `peek`).
import { type KycVerification, type PersistedIdentity, toPersistedIdentity } from "../domain/remittance";
import type { KycStore } from "../application/ports";
import { canonicalizeAddress } from "./address";
import { KYC_CLIENT_HINT_TTL_DAYS } from "./kyc-verdict-ttl";

const KEY = "chaski.kyc.v1";
const KYC_TTL_MS = KYC_CLIENT_HINT_TTL_DAYS * 24 * 60 * 60 * 1000; // CD-23: el número vive allá, no acá

// Shape persistido: Record<address, { v: KycVerification; savedAt: number }>. El wrapper agrega
// el timestamp para el TTL. Snapshots legacy (bare KycVerification sin savedAt) se tratan como
// inválidos → re-verify (defensivo AC-4, non-crashing). identity ya viene reducida (PersistedIdentity).
interface KycEntry {
  v: KycVerification;
  savedAt: number;
}
function isEntry(x: unknown): x is KycEntry {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as Record<string, unknown>).savedAt === "number" &&
    "v" in x
  );
}

// Read defensivo (MNR-1, simétrico con persistence.ts): un entry legacy de OTRA address puede traer
// identity FULL (documentNumber crudo / dateOfBirth / nationality). Normaliza al shape reducido SIN
// crashear; el próximo save() reescribe el mapa YA saneado (scrub comprensivo de todas las addresses,
// no solo la actual). La reducción de PII pasa por el helper único (CD-2).
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function normalizeIdentity(raw: unknown): PersistedIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  // ya reducida (persistida post-fix)
  if (typeof o.documentNumberLast4 === "string") {
    return {
      firstName: str(o.firstName),
      lastNamePaternal: str(o.lastNamePaternal),
      lastNameMaternal: str(o.lastNameMaternal),
      documentType: str(o.documentType),
      documentNumberLast4: o.documentNumberLast4,
    };
  }
  // legacy FULL → reducir con el helper único (CD-2)
  return toPersistedIdentity({
    firstName: str(o.firstName),
    lastNamePaternal: str(o.lastNamePaternal),
    lastNameMaternal: str(o.lastNameMaternal),
    documentType: str(o.documentType),
    documentNumber: str(o.documentNumber),
    dateOfBirth: str(o.dateOfBirth),
    nationality: str(o.nationality),
  });
}

function ls(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export class LocalKycStore implements KycStore {
  private mem: Record<string, KycEntry> = {};

  private rawObject(): Record<string, unknown> {
    const s = ls();
    if (!s) return this.mem;
    try {
      return JSON.parse(s.getItem(KEY) ?? "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  // Devuelve el mapa YA saneado: entries legacy bare (sin savedAt) descartados (AC-4: get→null) y
  // el identity de cada entry válido reducido a PersistedIdentity. Así el próximo save() persiste
  // el objeto completo sin PII cruda de ninguna address.
  private read(): Record<string, KycEntry> {
    const out: Record<string, KycEntry> = {};
    for (const [addr, val] of Object.entries(this.rawObject())) {
      if (!isEntry(val)) continue; // legacy bare → descartado (scrub en el próximo save)
      out[addr] = { v: { ...val.v, identity: normalizeIdentity(val.v.identity) }, savedAt: val.savedAt };
    }
    return out;
  }

  async get(address: string): Promise<KycVerification | null> {
    const entry = this.read()[canonicalizeAddress(address)];
    if (!entry) return null; // ausente o legacy bare descartado → null (AC-4 defensivo)
    if (Date.now() - entry.savedAt > KYC_TTL_MS) return null; // expirado → fuerza re-verify
    return entry.v;
  }

  /**
   * La entry cruda de esta dirección, SIN aplicar el TTL. **Sólo la usa el backfill** (WKH-333/AC-8).
   *
   * 🔴 POR QUÉ NO ALCANZABA CON `get()`, medido en el código de arriba: `get()` devuelve `null` a los
   * 181 días, así que el `verificationId` de una entry vencida es HOY inalcanzable — y esa entry es
   * EXACTAMENTE la población que el backfill salva. Con `get()`, quien se verificó hace 200 días
   * llegaría a `prepare` sin fila y se cortaría (AC-17) teniendo un identificador perfectamente
   * re-consultable guardado en su propio navegador.
   *
   * ⚠️ Esto NO relaja ninguna política de vencimiento y no puede autorizar nada por sí solo. Lo único
   * que devuelve es una PISTA de por dónde preguntarle a la autoridad de KYC (`ports.ts` lo dice sin
   * vueltas: los booleanos del localStorage son atacante-controlables). Quien lo consume re-consulta
   * a Didit y persiste **sólo si vuelve autorizada** (AC-8/CD-24). El `savedAt` viaja para que el
   * consumidor pueda decidir, no porque acá se decida algo.
   *
   * `get()` queda byte-idéntico a propósito: el caché de dispositivo sigue venciendo a los
   * KYC_CLIENT_HINT_TTL_DAYS días para todos los demás caminos (T-STORE-1).
   */
  async peek(address: string): Promise<{ verification: KycVerification; savedAt: number } | null> {
    const entry = this.read()[canonicalizeAddress(address)];
    if (!entry) return null;
    return { verification: entry.v, savedAt: entry.savedAt }; // SIN chequeo de TTL: ver arriba
  }

  async save(address: string, kyc: KycVerification): Promise<void> {
    const all = this.read(); // ya saneado: PII legacy de otras addresses reducida/descartada
    all[canonicalizeAddress(address)] = { v: kyc, savedAt: Date.now() };
    const s = ls();
    if (!s) {
      this.mem = all;
      return;
    }
    try {
      s.setItem(KEY, JSON.stringify(all));
    } catch {
      /* quota / private-browsing: best-effort — no throw (AC-1/CD-3) */
    }
  }

  // Reset explícito (WKH-184): olvida SOLO la entry de esta address (CD-3, scopeado + case-insensitive),
  // NUNCA el mapa completo ni otras entries. Best-effort: si el storage falla no lanza (AC-5/CD-5).
  async clear(address: string): Promise<void> {
    const all = this.read(); // mapa saneado (mismo que save)
    delete all[canonicalizeAddress(address)]; // SOLO la key pedida (CD-3, case-insensitive)
    const s = ls();
    if (!s) {
      this.mem = all;
      return;
    }
    try {
      s.setItem(KEY, JSON.stringify(all));
    } catch {
      /* quota / private-browsing: best-effort — no throw (AC-5/CD-5) */
    }
  }
}
