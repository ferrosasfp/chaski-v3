import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KycVerification } from "../domain/remittance";
import { LocalKycStore } from "./kyc-store";

const KEY = "chaski.kyc.v1";
const DAY_MS = 24 * 60 * 60 * 1000;

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
    await store.save("0xAAA", kyc);

    const raw = storage.getItem(KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "{}") as Record<string, { v: KycVerification; savedAt: number }>;
    const entry = parsed["0xaaa"];
    expect(entry?.savedAt).toBe(Date.now());
    expect(entry?.v.identity?.documentNumberLast4).toBe("6677");
    // el string persistido NUNCA contiene PII cruda
    expect(raw).not.toContain("44556677");
    expect(raw).not.toContain("dateOfBirth");
    expect(raw).not.toContain("nationality");
    expect(raw).not.toContain("1990-05-14");
  });

  it("round-trip: get devuelve la verificación guardada (case-insensitive en address)", async () => {
    const store = new LocalKycStore();
    await store.save("0xAAA", kyc);
    const got = await store.get("0xaaa");
    expect(got?.verificationId).toBe("v-1");
    expect(got?.identity?.documentNumberLast4).toBe("6677");
  });
});

describe("LocalKycStore — TTL 180 días", () => {
  it("dentro de 180d → hit; pasados 180d → null (fuerza re-verify)", async () => {
    vi.useFakeTimers();
    const base = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(base);
    const store = new LocalKycStore();
    await store.save("0xAAA", kyc);

    vi.setSystemTime(new Date(base.getTime() + 179 * DAY_MS));
    expect((await store.get("0xAAA"))?.verificationId).toBe("v-1");

    vi.setSystemTime(new Date(base.getTime() + 181 * DAY_MS));
    expect(await store.get("0xAAA")).toBeNull();
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
    storage.setItem(KEY, JSON.stringify({ "0xa": legacyFullA, "0xb": validB }));

    const store = new LocalKycStore();
    await store.save("0xC", kyc); // save de OTRA address

    const raw = storage.getItem(KEY);
    // el string persistido YA NO contiene la PII cruda de A (scrub comprensivo)
    expect(raw).not.toContain("44556677");
    expect(raw).not.toContain("dateOfBirth");
    expect(raw).not.toContain("nationality");
    expect(raw).not.toContain("1990-05-14");

    // A quedó reducida (últimos 4), B intacta, C agregada
    const parsed = JSON.parse(raw ?? "{}") as Record<string, { v: KycVerification }>;
    expect(parsed["0xa"]?.v.identity?.documentNumberLast4).toBe("6677");
    expect(parsed["0xb"]?.v.verificationId).toBe("v-1");
    expect(parsed["0xc"]?.v.verificationId).toBe("v-1");
  });
});

describe("LocalKycStore — read defensivo AC-4", () => {
  it("entry legacy bare (KycVerification sin savedAt) → get null (non-crashing)", async () => {
    // shape viejo: address → KycVerification plano, sin wrapper.
    storage.setItem(KEY, JSON.stringify({ "0xaaa": kyc }));
    const store = new LocalKycStore();
    expect(await store.get("0xAAA")).toBeNull();
  });

  it("address ausente → null", async () => {
    const store = new LocalKycStore();
    expect(await store.get("0xNOPE")).toBeNull();
  });

  it("raw corrupto → null (parse defensivo)", async () => {
    storage.setItem(KEY, "{broken");
    const store = new LocalKycStore();
    expect(await store.get("0xAAA")).toBeNull();
  });
});
