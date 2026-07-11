import { describe, expect, it } from "vitest";
import {
  FakeKycPendingStore,
  FakeKycStore,
  ThrowingClearKycStore,
} from "../../test-support/fakes";
import { toPersistedIdentity, type KycVerification } from "../../domain/remittance";
import { ForgetKyc } from "./forget-kyc";

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

    await new ForgetKyc(kycStore, pending).execute({ address: "0xSender" });

    expect(await kycStore.get("0xSender")).toBeNull();
  });

  it("AC-3: limpia el pending en curso", async () => {
    const kycStore = new FakeKycStore();
    const pending = new FakeKycPendingStore();
    await pending.save({ remittanceId: "r-1", sessionId: "s-1", address: "0xSender" });
    expect(await pending.get()).not.toBeNull();

    await new ForgetKyc(kycStore, pending).execute({ address: "0xSender" });

    expect(await pending.get()).toBeNull();
  });

  it("AC-5 defensivo: si kycStore.clear rechaza, execute resuelve igual y pending.clear corre", async () => {
    const kycStore = new ThrowingClearKycStore();
    const pending = new FakeKycPendingStore();
    await pending.save({ remittanceId: "r-1", sessionId: "s-1", address: "0xSender" });

    await expect(
      new ForgetKyc(kycStore, pending).execute({ address: "0xSender" }),
    ).resolves.toBeUndefined();

    expect(await pending.get()).toBeNull(); // el pending igual se limpió (CD-8)
  });
});
