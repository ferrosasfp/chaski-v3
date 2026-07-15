import { describe, expect, it } from "vitest";
import {
  beneficiary,
  FakeKycPendingStore,
  FakeKycStore,
  InMemoryRepo,
  ThrowingClearByOwnerRepo,
  ThrowingClearKycPendingStore,
  ThrowingClearKycStore,
} from "../../test-support/fakes";
import { Money } from "../../domain/money";
import {
  type Quote,
  Remittance,
  toPersistedIdentity,
  type KycVerification,
} from "../../domain/remittance";
import { ForgetKyc } from "./forget-kyc";

const NOW = "2026-07-11T00:00:00.000Z";
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
// Seedea el repo con una remesa del owner (mismo recipe que withOwner de persistence.test).
async function seedOwned(repo: InMemoryRepo, id: string, address: string): Promise<void> {
  const r = Remittance.create(id, beneficiary(), Money.of(400, "USDC"), NOW);
  r.attachQuote(seedQuote, NOW);
  r.startKyc(NOW, address);
  await repo.save(r);
}

const kyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true,
  riskLevel: "low",
  provenance: "didit",
  identity: toPersistedIdentity({
    firstName: "María Elena",
    lastNamePaternal: "Quispe",
    lastNameMaternal: "Mamani",
    documentType: "DNI",
    documentNumber: "12345678",
    dateOfBirth: "1990-01-01",
    nationality: "PE",
  }),
};

describe("ForgetKyc", () => {
  it("AC-1: olvida el KYC-once de la address (fuerza re-verify: get → null)", async () => {
    const kycStore = new FakeKycStore();
    const pending = new FakeKycPendingStore();
    await kycStore.save("0xSender", kyc);
    expect(await kycStore.get("0xSender")).not.toBeNull();

    await new ForgetKyc(kycStore, pending, new InMemoryRepo()).execute({ address: "0xSender" });

    expect(await kycStore.get("0xSender")).toBeNull();
  });

  it("AC-3: limpia el pending en curso", async () => {
    const kycStore = new FakeKycStore();
    const pending = new FakeKycPendingStore();
    await pending.save({ remittanceId: "r-1", sessionId: "s-1", address: "0xSender" });
    expect(await pending.get()).not.toBeNull();

    await new ForgetKyc(kycStore, pending, new InMemoryRepo()).execute({ address: "0xSender" });

    expect(await pending.get()).toBeNull();
  });

  it("AC-5 defensivo: si kycStore.clear rechaza, execute resuelve igual y pending.clear corre", async () => {
    const kycStore = new ThrowingClearKycStore();
    const pending = new FakeKycPendingStore();
    await pending.save({ remittanceId: "r-1", sessionId: "s-1", address: "0xSender" });

    await expect(
      new ForgetKyc(kycStore, pending, new InMemoryRepo()).execute({ address: "0xSender" }),
    ).resolves.toBeUndefined();

    expect(await pending.get()).toBeNull(); // el pending igual se limpió (CD-8)
  });

  it("CD-8: si pending.clear rechaza (storage roto), execute resuelve igual y NO rechaza", async () => {
    const kycStore = new FakeKycStore();
    const pending = new ThrowingClearKycPendingStore();

    await expect(
      new ForgetKyc(kycStore, pending, new InMemoryRepo()).execute({ address: "0xSender" }),
    ).resolves.toBeUndefined();
  });

  it("AC-1: forget purga el repo del owner (list → []) — WKH-201", async () => {
    const kycStore = new FakeKycStore();
    const pending = new FakeKycPendingStore();
    const repo = new InMemoryRepo();
    await seedOwned(repo, "rem-1", "0xSender");
    expect((await repo.list("0xSender")).map((s) => s.id)).toEqual(["rem-1"]);

    await new ForgetKyc(kycStore, pending, repo).execute({ address: "0xSender" });

    expect(await repo.list("0xSender")).toEqual([]);
  });

  it("AC-4: si clearByOwner rechaza, execute resuelve y kyc/pending igual se limpian", async () => {
    const kycStore = new FakeKycStore();
    const pending = new FakeKycPendingStore();
    const repo = new ThrowingClearByOwnerRepo(); // clearByOwner re-lanza (CD-7)
    await kycStore.save("0xSender", kyc);
    await pending.save({ remittanceId: "r-1", sessionId: "s-1", address: "0xSender" });

    await expect(
      new ForgetKyc(kycStore, pending, repo).execute({ address: "0xSender" }),
    ).resolves.toBeUndefined();

    // el fallo del repo NO impidió las otras limpiezas (CD-2)
    expect(await kycStore.get("0xSender")).toBeNull();
    expect(await pending.get()).toBeNull();
  });

  it("AC-5: aditivo — kycStore.clear y pending.clear siguen corriendo con repo OK", async () => {
    const kycStore = new FakeKycStore();
    const pending = new FakeKycPendingStore();
    const repo = new InMemoryRepo();
    await kycStore.save("0xSender", kyc);
    await pending.save({ remittanceId: "r-1", sessionId: "s-1", address: "0xSender" });
    await seedOwned(repo, "rem-1", "0xSender");

    await new ForgetKyc(kycStore, pending, repo).execute({ address: "0xSender" });

    // las tres limpiezas corrieron
    expect(await kycStore.get("0xSender")).toBeNull();
    expect(await pending.get()).toBeNull();
    expect(await repo.list("0xSender")).toEqual([]);
  });
});
