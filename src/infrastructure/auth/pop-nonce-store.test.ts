// Tests — single-use del nonce PoP (WKH-206 W0.2, AC-4). FAIL-CLOSED: el contraste con rate-limit.ts
// (fail-open) es intencional y es lo que estos tests protegen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setMock } = vi.hoisted(() => ({ setMock: vi.fn() }));
vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(() => ({ set: setMock })),
}));

import { __resetPopNonceStore, claimPopNonceOnce } from "./pop-nonce-store";

const NONCE = "abcdef0123456789abcdef0123456789";

describe("pop-nonce-store (WKH-206) — single-use fail-CLOSED", () => {
  beforeEach(() => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token-123");
    setMock.mockReset();
    __resetPopNonceStore(); // sin esto el cliente memoizado ignora los stubs de env
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetPopNonceStore();
  });

  it("primer uso ⇒ ok; SET con NX + TTL sobre la key del nonce (namespace pop:nonce:, solo un flag)", async () => {
    setMock.mockResolvedValue("OK");
    expect(await claimPopNonceOnce(NONCE)).toEqual({ ok: true });
    expect(setMock).toHaveBeenCalledWith(`pop:nonce:${NONCE}`, "1", { nx: true, ex: 86_400 });
    const [, value] = setMock.mock.calls[0] as [string, string, unknown];
    expect(value).toBe("1");
  });

  it("AC-4: segunda presentación del MISMO nonce (SET NX → null) ⇒ alreadyUsed (anti-replay)", async () => {
    setMock.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    expect(await claimPopNonceOnce(NONCE)).toEqual({ ok: true });
    expect(await claimPopNonceOnce(NONCE)).toEqual({ ok: false, alreadyUsed: true });
  });

  it("AC-4: sin env de Upstash ⇒ unavailable SIN tocar Redis (fail-closed, nunca ok:true)", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    __resetPopNonceStore();
    expect(await claimPopNonceOnce(NONCE)).toEqual({ ok: false, unavailable: true });
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    __resetPopNonceStore();
    expect(await claimPopNonceOnce(NONCE)).toEqual({ ok: false, unavailable: true });
    expect(setMock).not.toHaveBeenCalled();
  });

  it("CD-3: Upstash THROW ⇒ unavailable, NUNCA ok:true — NO copia el fail-open de rate-limit.ts", async () => {
    setMock.mockRejectedValue(new Error("ETIMEDOUT"));
    const r = await claimPopNonceOnce(NONCE);
    expect(r).toEqual({ ok: false, unavailable: true });
    expect(r.ok).toBe(false);
  });
});
