import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Money } from "../domain/money";
import { Remittance } from "../domain/remittance";
import { beneficiary } from "../test-support/fakes";
import { LocalRepo } from "./persistence";

const KEY = "chaski.remittances.v1";
const NOW = "2026-07-11T00:00:00.000Z";

// Stub Storage Map-backed (jsdom NO instalado — env de test = node, sin window). CD-9: tipado
// explícito, sin any. Se limpia en afterEach.
class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(key: string): string | null {
    return this.m.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.m.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  setItem(key: string, value: string): void {
    this.m.set(key, value);
  }
}

let storage: MemStorage;
beforeEach(() => {
  storage = new MemStorage();
  (globalThis as { window?: { localStorage: Storage } }).window = { localStorage: storage };
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

function withOwner(id: string, owner: string): Remittance {
  const r = Remittance.create(id, beneficiary(), Money.of(400, "USDC"), NOW);
  r.startKyc(NOW, owner); // setea ownerAddress
  return r;
}

describe("LocalRepo.list — scope por wallet (AC-5/7, CD-5)", () => {
  it("AC-5: devuelve SOLO entries del address, case-insensitive", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("a1", "0xAAA"));
    await repo.save(withOwner("b1", "0xBBB"));

    const lower = await repo.list("0xaaa");
    expect(lower.map((s) => s.id)).toEqual(["a1"]);
    const upper = await repo.list("0xAAA");
    expect(upper.map((s) => s.id)).toEqual(["a1"]);
    // ningún registro de otra wallet
    expect((await repo.list("0xbbb")).map((s) => s.id)).toEqual(["b1"]);
  });

  it("AC-7: remesa sin owner (created, nunca verificó) queda EXCLUIDA de cualquier list scopeada", async () => {
    const repo = new LocalRepo();
    const abandoned = Remittance.create("x1", beneficiary(), Money.of(400, "USDC"), NOW); // sin startKyc
    await repo.save(abandoned);
    await repo.save(withOwner("a1", "0xAAA"));

    expect(abandoned.snapshot.ownerAddress).toBeNull();
    expect((await repo.list("0xAAA")).map((s) => s.id)).toEqual(["a1"]);
    // no aparece bajo ninguna address
    expect((await repo.list("0xZZZ")).map((s) => s.id)).toEqual([]);
  });
});

describe("LocalRepo.read — defensivo AC-4 (snapshot legacy con PII cruda)", () => {
  // Snapshot escrito ANTES del fix: identity FULL (documentNumber crudo + dateOfBirth + nationality),
  // SIN ownerAddress. El read no debe crashear y debe normalizar al shape reducido.
  const legacy = [
    {
      id: "leg-1",
      status: "kyc_passed",
      beneficiary: beneficiary(),
      sendUsd: { __m: [40000, "USDC"] },
      quote: null,
      kyc: {
        verificationId: "v",
        approved: true,
        payoutAllowed: true,
        riskLevel: "low",
        provenance: "didit",
        identity: {
          firstName: "María Elena",
          lastNamePaternal: "Quispe",
          lastNameMaternal: "Mamani",
          documentType: "DNI",
          documentNumber: "44556677",
          dateOfBirth: "1990-05-14",
          nationality: "PE",
        },
      },
      payoutId: null,
      principalTx: null,
      payoutTx: null,
      refundTx: null,
      deliveredPen: null,
      failureReason: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];

  it("no crashea al leer y normaliza identity al shape reducido (dropea PII cruda)", async () => {
    storage.setItem(KEY, JSON.stringify(legacy));
    const repo = new LocalRepo();
    const r = await repo.get("leg-1");
    expect(r).not.toBeNull();
    const id = r?.snapshot.kyc?.identity;
    expect(id?.firstName).toBe("María Elena");
    expect(id?.documentNumberLast4).toBe("6677");
    // PII cruda ausente del shape reducido
    expect(id && "documentNumber" in id).toBe(false);
    expect(id && "dateOfBirth" in id).toBe(false);
    expect(id && "nationality" in id).toBe(false);
  });

  it("legacy sin ownerAddress → normaliza a null → excluido del list scopeado (AC-4 + AC-7)", async () => {
    storage.setItem(KEY, JSON.stringify(legacy));
    const repo = new LocalRepo();
    expect((await repo.get("leg-1"))?.snapshot.ownerAddress).toBeNull();
    expect(await repo.list("0xAAA")).toEqual([]);
  });

  it("raw corrupto no crashea (parse defensivo → mapa vacío)", async () => {
    storage.setItem(KEY, "{not json");
    const repo = new LocalRepo();
    expect(await repo.list("0xAAA")).toEqual([]);
    expect(await repo.get("whatever")).toBeNull();
  });
});
