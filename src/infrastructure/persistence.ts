// Infrastructure — RemittanceRepository. localStorage en el browser (fixea el gap del demo:
// SIN persistencia/historial), in-memory en SSR. Serializa Money como { __m:[minor,currency] }.
import { Money } from "../domain/money";
import {
  type AgentRef,
  type PersistedIdentity,
  Remittance,
  type RemittanceState,
  toPersistedIdentity,
} from "../domain/remittance";
import { ConcurrentModificationError } from "../application/errors";
import type { RemittanceRepository } from "../application/ports";
import { canonicalizeAddress, isOwnedBy } from "./address"; // WKH-348: el predicado, importado

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
/** Read defensivo del AgentRef persistido. Sin `slug` no hay identidad que afirmar ⇒ null (decir
 *  "no sé" es correcto; inventar un slug vacío no lo es). Los campos opcionales sólo se conservan
 *  si vienen con el tipo correcto. */
function normalizeAgentRef(raw: unknown): AgentRef | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.slug !== "string" || !o.slug) return null;
  return {
    slug: o.slug,
    // Ausente ⟹ ausente. `str(...)` devolvía "" para lo que no fuera string, y un snapshot viejo sin
    // registry pasaba a AFIRMAR un catálogo vacío al releerse (ver AgentRef en el dominio).
    ...(typeof o.registry === "string" && o.registry ? { registry: o.registry } : {}),
    ...(typeof o.capability === "string" ? { capability: o.capability } : {}),
    ...(typeof o.trial === "boolean" ? { trial: o.trial } : {}),
  };
}
function normalizeState(s: RemittanceState): RemittanceState {
  const kyc = s.kyc ? { ...s.kyc, identity: normalizeIdentity(s.kyc.identity) } : null;
  const ownerAddress = typeof s.ownerAddress === "string" ? s.ownerAddress : null;
  // Snapshot legacy sin version (pre-WKH-182) → default 0 (CAS/AC-3/4).
  const version = typeof s.version === "number" ? s.version : 0;
  // Snapshot legacy sin payoutProvenance (pre-WKH-200) → default null (CD-2, nunca lanza).
  const payoutProvenance = typeof s.payoutProvenance === "string" ? s.payoutProvenance : null;
  // Snapshot legacy sin payoutAgent → null, que es exactamente lo que significa: de esa remesa NO
  // sabemos qué agente la atendió. Un objeto vacío en su lugar afirmaría que sí y no diría quién.
  const payoutAgent = normalizeAgentRef(s.payoutAgent);
  return { ...s, kyc, ownerAddress, version, payoutProvenance, payoutAgent };
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
  // 🔴 OJO: un elemento ilegible del blob deja este read() en un Map VACÍO. Residual completo abajo, en clearByOwner.
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
    // Scope por wallet (AC-5/7): SOLO entries cuyo ownerAddress matchea, CASE-SENSITIVE (CD-1); sin
    // owner o que no canonicaliza → EXCLUIDA, deja de tapar a las demás; el target, fail-closed (AC-3).
    const target = canonicalizeAddress(address);
    return [...this.read().values()]
      .filter((s) => isOwnedBy(s, target)) // WKH-348: el predicado es UNO y tolera la entrada mala
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async clearByOwner(address: string): Promise<void> {
    // Reset (WKH-201): borra del blob real toda entry del owner conectado — mismo predicado que
    // list() (CD-1). Reusa read()/write() (CD-8: sin try/catch interno; el error de storage lo
    // absorbe ForgetKyc). Preserva otros owners y las entries ownerAddress === null.
    // WKH-348/CD-18: la entrada que no se puede atribuir NO se borra. Borrar lo que no se puede
    // atribuir ES atribuirlo a quien pidió el reset, y destruye el único dato con el que algún día se
    // podría atribuir. Residual declarado: si esa entrada tiene PII de un beneficiario, el reset no
    // la puede purgar. Purgarla exigiría atribuirla, que es exactamente lo que AC-5 prohíbe.
    //
    // 🔴 Y el residual GEMELO, que es de read() y no de este filtro, escrito acá para que quede al lado
    // del de arriba y no en un documento que no viaja con el repo: un elemento de este blob que NO sea
    // un objeto (o un JSON válido que no sea un array) hace que read() devuelva un Map VACÍO, porque
    // normalizeState tira al leer `s.kyc` y el catch de read() se lo come. Eso tapa el historial
    // ENTERO, y el write() de acá abajo persiste ese vacío como "[]", así que esa remesa SE PIERDE.
    // Input medido: `[<entrada válida>, null]`. NO es regresión (medido idéntico antes de WKH-348) y no
    // tiene productor confirmado: write() nunca escribe `null`. Por eso lo que cambia WKH-348 vale SÓLO
    // para la familia "ownerAddress que no canonicaliza"; esta otra familia sigue tapando todo.
    // Cerrarla sería descartar el elemento ilegible y conservar los demás, que es la disciplina de
    // `isEntry` en kyc-store, y es otra HU.
    const target = canonicalizeAddress(address);
    const map = this.read();
    for (const [id, s] of map) {
      if (isOwnedBy(s, target)) map.delete(id);
    }
    this.write(map);
  }
}
