// Infrastructure — RemittanceRepository. localStorage en el browser (fixea el gap del demo:
// SIN persistencia/historial), in-memory en SSR. Serializa Money como { __m:[minor,currency] }.
import { Money } from "../domain/money";
import {
  type PersistedIdentity,
  Remittance,
  type RemittanceState,
  toPersistedIdentity,
} from "../domain/remittance";
import { ConcurrentModificationError } from "../application/errors";
import type { RemittanceRepository } from "../application/ports";

const KEY = "chaski.remittances.v1";

// Read defensivo (AC-4): un snapshot legacy puede traer identity FULL (documentNumber crudo,
// dateOfBirth, nationality) o carecer de ownerAddress. Normaliza al shape reducido SIN crashear;
// el próximo save() persiste ya saneado. La reducción de PII pasa por el helper único (CD-2).
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
  // legacy FULL → reducir con el helper único
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
function normalizeState(s: RemittanceState): RemittanceState {
  const kyc = s.kyc ? { ...s.kyc, identity: normalizeIdentity(s.kyc.identity) } : null;
  const ownerAddress = typeof s.ownerAddress === "string" ? s.ownerAddress : null;
  // Snapshot legacy sin version (pre-WKH-182) → default 0 (CAS/AC-3/4).
  const version = typeof s.version === "number" ? s.version : 0;
  // Snapshot legacy sin payoutProvenance (pre-WKH-200) → default null (CD-2, nunca lanza).
  const payoutProvenance = typeof s.payoutProvenance === "string" ? s.payoutProvenance : null;
  return { ...s, kyc, ownerAddress, version, payoutProvenance };
}

function replacer(_k: string, v: unknown): unknown {
  return v instanceof Money ? { __m: [v.minor, v.currency] } : v;
}
// biome-ignore lint/suspicious/noExplicitAny: reviver de JSON.parse
function reviver(_k: string, v: any): unknown {
  return v && typeof v === "object" && Array.isArray(v.__m) ? Money.fromMinor(v.__m[0], v.__m[1]) : v;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export class LocalRepo implements RemittanceRepository {
  private mem = new Map<string, RemittanceState>();

  private read(): Map<string, RemittanceState> {
    const ls = safeLocalStorage();
    if (!ls) return this.mem;
    const raw = ls.getItem(KEY);
    if (!raw) return new Map();
    try {
      const arr = JSON.parse(raw, reviver) as RemittanceState[];
      return new Map(arr.map((s) => [s.id, normalizeState(s)]));
    } catch {
      return new Map();
    }
  }

  private write(map: Map<string, RemittanceState>): void {
    const ls = safeLocalStorage();
    if (!ls) {
      this.mem = map;
      return;
    }
    ls.setItem(KEY, JSON.stringify([...map.values()], replacer));
  }

  async save(r: Remittance): Promise<void> {
    // CAS / lock optimista (AC-3/AC-4, CD-4): si el persistido cambió desde la lectura base
    // (version distinta), fail-loud — NO pisar el estado ajeno. El token viaja en el snapshot,
    // por eso la firma de save() NO cambia (los otros use-cases obtienen CAS transparente).
    const map = this.read();
    const existing = map.get(r.snapshot.id);
    if (existing && existing.version !== r.snapshot.version) {
      throw new ConcurrentModificationError(r.snapshot.id, r.snapshot.version, existing.version);
    }
    const next = r.snapshot.version + 1;
    map.set(r.snapshot.id, { ...r.snapshot, version: next });
    this.write(map);
    r.markSaved(next); // sincroniza la instancia para el PRÓXIMO save() de la cadena
  }

  async get(id: string): Promise<Remittance | null> {
    const s = this.read().get(id);
    return s ? Remittance.rehydrate(s) : null;
  }

  async list(address: string): Promise<RemittanceState[]> {
    // Scope por wallet (AC-5/7): SOLO entries cuyo ownerAddress matchea (case-insensitive, CD-5);
    // owner null (remesa abandonada sin verificar) → EXCLUIDO.
    const target = address.toLowerCase();
    return [...this.read().values()]
      .filter((s) => s.ownerAddress != null && s.ownerAddress.toLowerCase() === target)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async clearByOwner(address: string): Promise<void> {
    // Reset (WKH-201): borra del blob real toda entry del owner conectado — mismo predicado que
    // list() (CD-1). Reusa read()/write() (CD-8: sin try/catch interno; el error de storage lo
    // absorbe ForgetKyc). Preserva otros owners y las entries ownerAddress === null.
    const target = address.toLowerCase();
    const map = this.read();
    for (const [id, s] of map) {
      if (s.ownerAddress != null && s.ownerAddress.toLowerCase() === target) {
        map.delete(id);
      }
    }
    this.write(map);
  }
}
