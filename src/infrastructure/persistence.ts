// Infrastructure — RemittanceRepository. localStorage en el browser (fixea el gap del demo:
// SIN persistencia/historial), in-memory en SSR. Serializa Money como { __m:[minor,currency] }.
import { Money } from "../domain/money";
import { Remittance, type RemittanceState } from "../domain/remittance";
import type { RemittanceRepository } from "../application/ports";

const KEY = "chaski.remittances.v1";

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
      return new Map(arr.map((s) => [s.id, s]));
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
    const map = this.read();
    map.set(r.snapshot.id, r.snapshot);
    this.write(map);
  }

  async get(id: string): Promise<Remittance | null> {
    const s = this.read().get(id);
    return s ? Remittance.rehydrate(s) : null;
  }

  async list(): Promise<RemittanceState[]> {
    return [...this.read().values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
