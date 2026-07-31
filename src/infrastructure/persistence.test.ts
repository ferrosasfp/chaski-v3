import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConcurrentModificationError } from "../application/errors";
import { Money } from "../domain/money";
import { type Quote, Remittance } from "../domain/remittance";
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

const seedQuote: Quote = {
  quoteId: "q",
  send: Money.of(400, "USDC"),
  receive: Money.of(1480, "PEN"),
  feeUsd: Money.of(0.5, "USDC"),
  rate: 3.7,
  etaMinutes: 30,
  expiresAt: "2026-07-11T01:00:00.000Z", // > NOW
  provenance: "fake",
};

function withOwner(id: string, owner: string): Remittance {
  const r = Remittance.create(id, beneficiary(), Money.of(400, "USDC"), NOW);
  r.attachQuote(seedQuote, NOW); // WKH-187: cotiza antes del KYC (created→quoted)
  r.startKyc(NOW, owner); // quoted→kyc_pending, setea ownerAddress
  return r;
}

// WKH-320: estos tests usaban labels `0xAAA`/`0xaaa` como owners y probaban que el scoping por
// wallet era CASE-INSENSITIVE (rama EVM). Esa rama ya no existe: la canonicalización es base58 y
// case-SENSITIVE. Las addresses pasan a ser pubkeys reales; el caso que probaba la
// case-insensibilidad se reemplaza por el que prueba lo contrario (CD-7).
const A = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const Z = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // nunca dueña de nada

describe("LocalRepo.list — scope por wallet (AC-5/7, CD-5)", () => {
  it("AC-5: devuelve SOLO entries del address (scoping por owner)", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("a1", A));
    await repo.save(withOwner("b1", B));

    expect((await repo.list(A)).map((s) => s.id)).toEqual(["a1"]);
    // ningún registro de otra wallet
    expect((await repo.list(B)).map((s) => s.id)).toEqual(["b1"]);
    // WKH-320/CD-7: el scoping es CASE-SENSITIVE. Antes este caso probaba que `list` con la misma
    // address en otro case devolvía lo mismo (rama EVM, lowercase). Ahora una variante con otro case
    // es OTRA address: o no matchea, o ni siquiera canonicaliza. Nunca devuelve lo ajeno.
    const altCase = `${A.slice(0, 1)}${A[1] === A[1]!.toLowerCase() ? A[1]!.toUpperCase() : A[1]!.toLowerCase()}${A.slice(2)}`;
    expect(altCase).not.toBe(A);
    const leaked = await repo.list(altCase).catch(() => []);
    expect(leaked.map((s) => s.id)).toEqual([]);
  });

  it("AC-7: remesa sin owner (created, nunca verificó) queda EXCLUIDA de cualquier list scopeada", async () => {
    const repo = new LocalRepo();
    const abandoned = Remittance.create("x1", beneficiary(), Money.of(400, "USDC"), NOW); // sin startKyc
    await repo.save(abandoned);
    await repo.save(withOwner("a1", A));

    expect(abandoned.snapshot.ownerAddress).toBeNull();
    expect((await repo.list(A)).map((s) => s.id)).toEqual(["a1"]);
    // no aparece bajo ninguna address
    expect((await repo.list(Z)).map((s) => s.id)).toEqual([]);
  });
});

describe("LocalRepo.clearByOwner — purga PII del owner en el reset (WKH-201)", () => {
  it("AC-1: borra las entries del owner → list vacío", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("a1", A));
    await repo.save(withOwner("a2", A));

    await repo.clearByOwner(A);

    expect(await repo.list(A)).toEqual([]);
  });

  it("AC-2: NO toca otros owners ni las entries ownerAddress === null", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("a1", A));
    await repo.save(withOwner("b1", B));
    const abandoned = Remittance.create("x1", beneficiary(), Money.of(400, "USDC"), NOW); // sin startKyc
    await repo.save(abandoned);

    await repo.clearByOwner(A);

    // otro owner intacto
    expect((await repo.list(B)).map((s) => s.id)).toEqual(["b1"]);
    // la entry null persiste
    expect(await repo.get("x1")).not.toBeNull();
    expect((await repo.get("x1"))?.snapshot.ownerAddress).toBeNull();
  });

  it("AC-3: borra del blob real (repo fresco re-lee del storage → list [])", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("a1", A));
    await repo.clearByOwner(A);

    // instancia fresca que re-lee del storage real (no un reset in-memory)
    const fresh = new LocalRepo();
    expect(await fresh.list(A)).toEqual([]);
    // el blob JSON ya no contiene el destination (celular Yape) del owner purgado
    expect(storage.getItem(KEY)).not.toContain(beneficiary().destination);
  });
});

describe("LocalRepo.save — CAS / lock optimista (AC-3/AC-4, CD-4)", () => {
  it("AC-3/AC-4: carrera — dos get() (version V), un save() avanza, el save() stale tira ConcurrentModificationError", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("race-1", A)); // persistido version 1

    // Dos lecturas del MISMO id → ambas rehidratan con version 1 (read-stale de la carrera).
    const r1 = await repo.get("race-1");
    const r2 = await repo.get("race-1");
    if (!r1 || !r2) throw new Error("setup");
    expect(r1.snapshot.version).toBe(1);
    expect(r2.snapshot.version).toBe(1);

    // r1 procede: persiste version 2. r2 sigue stale (version 1) → fail-loud.
    await repo.save(r1);
    await expect(repo.save(r2)).rejects.toBeInstanceOf(ConcurrentModificationError);

    // El estado persistido es el del ganador (r1), NO pisado por r2.
    const persisted = await repo.get("race-1");
    expect(persisted?.snapshot.version).toBe(2);
  });

  it("AC-3: secuencial (get→save×N) NO genera falso conflicto", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("seq-1", A));
    for (let i = 0; i < 3; i++) {
      const r = await repo.get("seq-1");
      if (!r) throw new Error("setup");
      await repo.save(r); // cada get() lee la última version → sin conflicto
    }
    expect((await repo.get("seq-1"))?.snapshot.version).toBe(4);
  });

  it("AC-4: 2 confirm concurrentes sobre la misma instancia rehidratada → 1 procede, 1 tira", async () => {
    const repo = new LocalRepo();
    await repo.save(withOwner("cc-1", A)); // version 1
    // Simula dos ejecuciones que leyeron la MISMA version antes de confirmar.
    const a = await repo.get("cc-1");
    const b = await repo.get("cc-1");
    if (!a || !b) throw new Error("setup");
    const results = await Promise.allSettled([repo.save(a), repo.save(b)]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof ConcurrentModificationError,
    ).length;
    expect(ok).toBe(1);
    expect(failed).toBe(1);
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
    expect(await repo.list(A)).toEqual([]);
  });

  it("AC-4: legacy sin `version` → normaliza a 0 sin crashear (y el próximo save avanza a 1)", async () => {
    storage.setItem(KEY, JSON.stringify(legacy)); // fixture legacy no trae `version`
    const repo = new LocalRepo();
    const r = await repo.get("leg-1");
    expect(r).not.toBeNull();
    expect(r?.snapshot.version).toBe(0);
    if (r) await repo.save(r); // save sobre version 0 → sin falso conflicto
    expect((await repo.get("leg-1"))?.snapshot.version).toBe(1);
  });

  it("T-AC5f: legacy sin `payoutProvenance` → normaliza a null sin crashear (CD-2)", async () => {
    storage.setItem(KEY, JSON.stringify(legacy)); // fixture legacy no trae `payoutProvenance`
    const repo = new LocalRepo();
    const r = await repo.get("leg-1");
    expect(r).not.toBeNull();
    expect(r?.snapshot.payoutProvenance).toBeNull();
  });

  it("raw corrupto no crashea (parse defensivo → mapa vacío)", async () => {
    storage.setItem(KEY, "{not json");
    const repo = new LocalRepo();
    expect(await repo.list(A)).toEqual([]);
    expect(await repo.get("whatever")).toBeNull();
  });
});
