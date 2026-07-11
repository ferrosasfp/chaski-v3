import { describe, expect, it } from "vitest";
import { FakeKycPendingStore } from "../../test-support/fakes";
import { AbandonPendingKyc } from "./abandon-pending-kyc";

describe("AbandonPendingKyc", () => {
  it("AC-7: limpia el pending (próximo resume ya no re-bloquea)", async () => {
    const pending = new FakeKycPendingStore();
    await pending.save({ remittanceId: "r-1", sessionId: "s-1", address: "0xSender" });
    expect(await pending.get()).not.toBeNull();

    await new AbandonPendingKyc(pending).execute();

    expect(await pending.get()).toBeNull();
  });
});
