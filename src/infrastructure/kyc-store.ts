// Infrastructure — KycStore. Recuerda la verificación KYC por dirección de wallet (KYC-once).
// localStorage en browser, in-memory en SSR. KycVerification es plano (sin Money) → JSON directo.
import type { KycVerification } from "../domain/remittance";
import type { KycStore } from "../application/ports";

const KEY = "chaski.kyc.v1";
const KYC_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 días — revisión AML periódica; promovible a NEXT_PUBLIC_KYC_TTL_DAYS

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

function ls(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export class LocalKycStore implements KycStore {
  private mem: Record<string, KycEntry> = {};

  private read(): Record<string, unknown> {
    const s = ls();
    if (!s) return this.mem;
    try {
      return JSON.parse(s.getItem(KEY) ?? "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async get(address: string): Promise<KycVerification | null> {
    const entry = this.read()[address.toLowerCase()];
    if (!isEntry(entry)) return null; // ausente o legacy bare (sin savedAt) → null (AC-4 defensivo)
    if (Date.now() - entry.savedAt > KYC_TTL_MS) return null; // expirado → fuerza re-verify
    return entry.v;
  }

  async save(address: string, kyc: KycVerification): Promise<void> {
    const all = this.read();
    all[address.toLowerCase()] = { v: kyc, savedAt: Date.now() };
    const s = ls();
    if (!s) {
      this.mem = all as Record<string, KycEntry>;
      return;
    }
    s.setItem(KEY, JSON.stringify(all));
  }
}
