import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KycVerification } from "../domain/remittance";
import { LocalKycStore } from "./kyc-store";

const KEY = "chaski.kyc.v1";
const DAY_MS = 24 * 60 * 60 * 1000;

// WKH-320: estos tests usaban labels `0xAAA`/`0xaaa` como addresses y probaban que el scoping era
// CASE-INSENSITIVE (la rama EVM lowercaseaba). Esa rama ya no existe: canonicalizeAddress es base58
// y case-SENSITIVE. Las addresses pasan a ser pubkeys reales y el caso que probaba la
// case-insensibilidad se reemplaza por el que prueba lo contrario, que es el invariante vivo (CD-7).
const A = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const C = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const D = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"; // nunca guardada

// Stub Storage Map-backed (jsdom NO instalado). CD-9: tipado explícito, sin any.
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

// identity YA reducida (PersistedIdentity) — el productor la redujo aguas arriba (CD-6).
const kyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true,
  riskLevel: "low",
  provenance: "didit",
  identity: {
    firstName: "María Elena",
    lastNamePaternal: "Quispe",
    lastNameMaternal: "Mamani",
    documentType: "DNI",
    documentNumberLast4: "6677",
  },
};

let storage: MemStorage;
beforeEach(() => {
  storage = new MemStorage();
  (globalThis as { window?: { localStorage: Storage } }).window = { localStorage: storage };
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.useRealTimers();
});

describe("LocalKycStore — persistencia sin PII cruda (AC-2)", () => {
  it("serializa el wrapper { v, savedAt } y NO escribe documentNumber crudo / dateOfBirth / nationality", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
    const store = new LocalKycStore();
    await store.save(A, kyc);

    const raw = storage.getItem(KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "{}") as Record<string, { v: KycVerification; savedAt: number }>;
    const entry = parsed[A];
    expect(entry?.savedAt).toBe(Date.now());
    expect(entry?.v.identity?.documentNumberLast4).toBe("6677");
    // el string persistido NUNCA contiene PII cruda
    expect(raw).not.toContain("44556677");
    expect(raw).not.toContain("dateOfBirth");
    expect(raw).not.toContain("nationality");
    expect(raw).not.toContain("1990-05-14");
  });

  it("round-trip: get devuelve la verificación guardada", async () => {
    const store = new LocalKycStore();
    await store.save(A, kyc);
    const got = await store.get(A);
    expect(got?.verificationId).toBe("v-1");
    expect(got?.identity?.documentNumberLast4).toBe("6677");
  });
});

// ── W3.2 (HU-SOL-7 / CD-9): la KYC-once usa la pubkey base58 case-preservada como key. Dos pubkeys
//    distintas NUNCA colisionan; una key malformada → throw (fail-loud), NUNCA la entry de la víctima
//    (cierra el IDOR base58). WKH-320: ya no hace falta stubear la VM — es la única. ──
describe("LocalKycStore — IDOR base58 Solana (CD-9)", () => {
  const K = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // víctima (base58 mixed-case)
  const K2 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // otra pubkey válida distinta
  it("AC-4: round-trip íntegro — save(K)+get(K) devuelve la misma entry (case preservado)", async () => {
    const store = new LocalKycStore();
    await store.save(K, kyc);
    const got = await store.get(K);
    expect(got?.verificationId).toBe("v-1");
  });

  it("CD-9: get(K') de otra pubkey Solana válida → null (NO colisiona con la víctima)", async () => {
    const store = new LocalKycStore();
    await store.save(K, kyc);
    expect(await store.get(K2)).toBeNull();
  });

  it("CD-9: una key Solana malformada → throw (fail-loud), NUNCA devuelve la entry de la víctima", async () => {
    const store = new LocalKycStore();
    await store.save(K, kyc);
    await expect(store.get("no-base58-!!!")).rejects.toThrow();
  });
});

describe("LocalKycStore — TTL 180 días", () => {
  it("dentro de 180d → hit; pasados 180d → null (fuerza re-verify)", async () => {
    vi.useFakeTimers();
    const base = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(base);
    const store = new LocalKycStore();
    await store.save(A, kyc);

    vi.setSystemTime(new Date(base.getTime() + 179 * DAY_MS));
    expect((await store.get(A))?.verificationId).toBe("v-1");

    vi.setSystemTime(new Date(base.getTime() + 181 * DAY_MS));
    expect(await store.get(A)).toBeNull();
  });

  // ── T-STORE-1 (WKH-333) — `get()` queda BYTE-IDÉNTICO tras la poda ───────────────────────────
  it("T-STORE-1: a los 181 días `get()` sigue devolviendo null (M-24)", async () => {
    vi.useFakeTimers();
    const base = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(base);
    const store = new LocalKycStore();
    await store.save(A, kyc);
    vi.setSystemTime(new Date(base.getTime() + 181 * DAY_MS));
    expect(
      await store.get(A),
      "`get()` dejó de aplicar el TTL del caché de dispositivo: el flujo saltearía la verificación " +
        "apoyado en un veredicto que el servidor ya considera vencido, y la persona llegaría a pagar " +
        "sin fila utilizable",
    ).toBeNull();
  });

  // ── T-STORE-2 (WKH-333/AC-8) — `peek()` NO aplica el TTL, y ése es todo el punto ─────────────
  it("T-STORE-2: a los 181 días `peek()` SÍ devuelve la entry vencida (M-24b)", async () => {
    vi.useFakeTimers();
    const base = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(base);
    const store = new LocalKycStore();
    await store.save(A, kyc);
    vi.setSystemTime(new Date(base.getTime() + 181 * DAY_MS));
    const peeked = await store.peek(A);
    expect(
      peeked?.verification.verificationId,
      "`peek()` aplicó el TTL: el backfill nunca alcanza a la población que existe para salvar " +
        "—quien se verificó hace más de 180 días— y esa gente llega a `prepare` sin fila teniendo " +
        "el identificador guardado en su propio navegador",
    ).toBe("v-1");
    expect(peeked?.savedAt).toBe(base.getTime());
  });

  it("T-STORE-2b: `peek()` de una address nunca guardada devuelve null", async () => {
    const store = new LocalKycStore();
    expect(await store.peek(D)).toBeNull();
  });
});

describe("LocalKycStore — scrub comprensivo de PII legacy (MNR-1)", () => {
  it("save de una address scrubbea la PII cruda legacy de TODAS las otras addresses", async () => {
    // Address A: entry legacy con identity FULL (shape pre-181: documentNumber crudo / dateOfBirth /
    // nationality en claro) pero con wrapper válido { v, savedAt } → sobreviviría a un save() naïf.
    const legacyFullA = {
      v: {
        verificationId: "v-A",
        approved: true,
        payoutAllowed: true,
        riskLevel: "low",
        provenance: "didit",
        identity: {
          firstName: "Legacy",
          lastNamePaternal: "Uno",
          lastNameMaternal: "Dos",
          documentType: "DNI",
          documentNumber: "44556677",
          dateOfBirth: "1990-05-14",
          nationality: "PE",
        },
      },
      savedAt: Date.now(),
    };
    // Address B: entry ya válido/reducido.
    const validB = { v: kyc, savedAt: Date.now() };
    storage.setItem(KEY, JSON.stringify({ [A]: legacyFullA, [B]: validB }));

    const store = new LocalKycStore();
    await store.save(C, kyc); // save de OTRA address

    const raw = storage.getItem(KEY);
    // el string persistido YA NO contiene la PII cruda de A (scrub comprensivo)
    expect(raw).not.toContain("44556677");
    expect(raw).not.toContain("dateOfBirth");
    expect(raw).not.toContain("nationality");
    expect(raw).not.toContain("1990-05-14");

    // A quedó reducida (últimos 4), B intacta, C agregada
    const parsed = JSON.parse(raw ?? "{}") as Record<string, { v: KycVerification }>;
    expect(parsed[A]?.v.identity?.documentNumberLast4).toBe("6677");
    expect(parsed[B]?.v.verificationId).toBe("v-1");
    expect(parsed[C]?.v.verificationId).toBe("v-1");
  });
});

describe("LocalKycStore — clear scopeado (WKH-184 AC-2/CD-3)", () => {
  it("clear borra SOLO la address pedida, no afecta otras", async () => {
    const store = new LocalKycStore();
    await store.save(A, kyc);
    await store.save(B, kyc);

    await store.clear(A);

    expect(await store.get(A)).toBeNull();
    expect((await store.get(B))?.verificationId).toBe("v-1");
  });

  // WKH-320: este caso probaba que `clear` era CASE-INSENSITIVE (clear('0xaaa') borraba la entry de
  // '0xAAA'), que era el comportamiento de la rama EVM. Esa rama no existe. Lo que se clava ahora es
  // el invariante vivo y opuesto: base58 CASE-SENSITIVE (CD-7, el IDOR que cerró HU-SOL-7).
  it("clear es CASE-SENSITIVE: una variante con otro case NO borra la entry ajena", async () => {
    const store = new LocalKycStore();
    await store.save(A, kyc);

    // Misma pubkey con un carácter en otro case ⇒ otra key (o base58 inválido ⇒ throw). En los dos
    // casos NO puede borrar la entry de la víctima.
    const altCase = `${A.slice(0, 1)}${A[1] === A[1]!.toLowerCase() ? A[1]!.toUpperCase() : A[1]!.toLowerCase()}${A.slice(2)}`;
    expect(altCase).not.toBe(A);
    await store.clear(altCase).catch(() => undefined);

    expect((await store.get(A))?.verificationId).toBe("v-1");
  });

  it("AC-5: clear NO propaga la excepción si setItem lanza (quota/private-browsing)", async () => {
    // MemStorage cuyo setItem tira SIEMPRE (simula storage lleno).
    const throwing = new (class extends MemStorage {
      override setItem(): void {
        throw new Error("QuotaExceededError");
      }
    })();
    (globalThis as { window?: { localStorage: Storage } }).window = { localStorage: throwing };
    const store = new LocalKycStore();

    await expect(store.clear(A)).resolves.toBeUndefined();
  });

  it("AC-1: save NO propaga la excepción si setItem lanza (quota/private-browsing)", async () => {
    // MemStorage cuyo setItem tira SIEMPRE (simula storage lleno) — mismo patrón que AC-5 (clear).
    const throwing = new (class extends MemStorage {
      override setItem(): void {
        throw new Error("QuotaExceededError");
      }
    })();
    (globalThis as { window?: { localStorage: Storage } }).window = { localStorage: throwing };
    const store = new LocalKycStore();

    await expect(store.save(A, kyc)).resolves.toBeUndefined();
  });
});

describe("LocalKycStore — read defensivo AC-4", () => {
  it("entry legacy bare (KycVerification sin savedAt) → get null (non-crashing)", async () => {
    // shape viejo: address → KycVerification plano, sin wrapper.
    storage.setItem(KEY, JSON.stringify({ [A]: kyc }));
    const store = new LocalKycStore();
    expect(await store.get(A)).toBeNull();
  });

  it("address ausente → null", async () => {
    const store = new LocalKycStore();
    expect(await store.get(D)).toBeNull();
  });

  it("raw corrupto → null (parse defensivo)", async () => {
    storage.setItem(KEY, "{broken");
    const store = new LocalKycStore();
    expect(await store.get(A)).toBeNull();
  });
});
