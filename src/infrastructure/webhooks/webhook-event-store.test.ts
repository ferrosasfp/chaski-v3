// Tests — claim-once del webhook de TransFi (WKH-210, CD-4). FAIL-CLOSED: Upstash caído ⇒ unavailable,
// NUNCA ok:true (sería la puerta al doble-procesamiento del evento).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setMock } = vi.hoisted(() => ({ setMock: vi.fn() }));
vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(() => ({ set: setMock })),
}));

import { __resetWebhookEventStore, claimWebhookEventOnce } from "./webhook-event-store";

const KEY = "evt-abc-123";

describe("webhook-event-store (WKH-210) — claim-once fail-CLOSED", () => {
  beforeEach(() => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token-123");
    setMock.mockReset();
    __resetWebhookEventStore();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetWebhookEventStore();
  });

  it("primer uso ⇒ ok; SET con NX + TTL sobre transfi:evt:<key>", async () => {
    setMock.mockResolvedValue("OK");
    expect(await claimWebhookEventOnce(KEY)).toEqual({ ok: true });
    expect(setMock).toHaveBeenCalledWith(`transfi:evt:${KEY}`, "1", { nx: true, ex: 86_400 });
  });

  it("re-delivery del MISMO evento (SET NX → null) ⇒ alreadyUsed", async () => {
    setMock.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    expect(await claimWebhookEventOnce(KEY)).toEqual({ ok: true });
    expect(await claimWebhookEventOnce(KEY)).toEqual({ ok: false, alreadyUsed: true });
  });

  it("sin env de Upstash ⇒ unavailable SIN tocar Redis (fail-closed)", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    __resetWebhookEventStore();
    expect(await claimWebhookEventOnce(KEY)).toEqual({ ok: false, unavailable: true });
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    __resetWebhookEventStore();
    expect(await claimWebhookEventOnce(KEY)).toEqual({ ok: false, unavailable: true });
    expect(setMock).not.toHaveBeenCalled();
  });

  it("Upstash THROW ⇒ unavailable, NUNCA ok:true", async () => {
    setMock.mockRejectedValue(new Error("ETIMEDOUT"));
    const r = await claimWebhookEventOnce(KEY);
    expect(r).toEqual({ ok: false, unavailable: true });
    expect(r.ok).toBe(false);
  });
});
