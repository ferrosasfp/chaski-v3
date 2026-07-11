import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock de Upstash: la unidad bajo test es la lógica de fail-mode/límite, no la red.
// slidingWindowMock captura (max, win) para poder assertar defaults/validación (MNR-2, MNR-3).
const { limitMock, slidingWindowMock } = vi.hoisted(() => ({
  limitMock: vi.fn(),
  slidingWindowMock: vi.fn((max: number, win: string) => ({ max, win })),
}));
vi.mock("@upstash/redis", () => ({ Redis: vi.fn(() => ({})) }));
vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    static slidingWindow = slidingWindowMock;
    limit(key: string) {
      return limitMock(key);
    }
  }
  return { Ratelimit };
});

import { __resetKycRateLimitClient, checkKycRateLimit } from "./rate-limit";

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  limitMock.mockReset();
  slidingWindowMock.mockClear();
  __resetKycRateLimitClient();
});

function withUpstashEnv() {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake.upstash.io");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fake-token");
}

describe("checkKycRateLimit — fail-modes (WKH-179 A2)", () => {
  it("Upstash ausente + Didit configurado → fail-CLOSED { unavailable:true } (503)", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    const res = await checkKycRateLimit({ ip: "1.2.3.4" });
    expect(res.unavailable).toBe(true);
    expect(res.ok).toBe(false);
    expect(limitMock).not.toHaveBeenCalled();
  });

  it("dentro del límite → { ok:true }", async () => {
    withUpstashEnv();
    limitMock.mockResolvedValue({ success: true, reset: Date.now() + 60_000 });
    const res = await checkKycRateLimit({ ip: "1.2.3.4", address: "0xabc" });
    expect(res.ok).toBe(true);
    expect(limitMock).toHaveBeenCalledWith("1.2.3.4");
    expect(limitMock).toHaveBeenCalledWith("0xabc");
  });

  it("límite IP excedido → { ok:false, retryAfter }", async () => {
    withUpstashEnv();
    limitMock.mockResolvedValue({ success: false, reset: Date.now() + 90_000 });
    const res = await checkKycRateLimit({ ip: "1.2.3.4" });
    expect(res.ok).toBe(false);
    expect(res.retryAfter).toBeGreaterThan(0);
    expect(res.retryAfter).toBeLessThanOrEqual(90);
  });

  it("error transitorio de Upstash → fail-OPEN + console.warn", async () => {
    withUpstashEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    limitMock.mockRejectedValue(new Error("ETIMEDOUT"));
    const res = await checkKycRateLimit({ ip: "1.2.3.4" });
    expect(res.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("default IP conservador = 5/10min (MNR-2)", async () => {
    withUpstashEnv();
    limitMock.mockResolvedValue({ success: true, reset: Date.now() + 1000 });
    await checkKycRateLimit({ ip: "1.2.3.4" });
    // getLimiters construye el limiter IP primero → calls[0] = (max, win) del bucket IP.
    const ipArgs = slidingWindowMock.mock.calls[0]!;
    expect(ipArgs[0]).toBe(5); // max conservador (antes 10)
    expect(ipArgs[1]).toBe("10 m");
  });

  it("KYC_RL_IP_WINDOW malformado → cae al default '10 m' (MNR-3, simétrico con num())", async () => {
    withUpstashEnv();
    vi.stubEnv("KYC_RL_IP_WINDOW", "diez minutos"); // no matchea `${number} ${unit}`
    limitMock.mockResolvedValue({ success: true, reset: Date.now() + 1000 });
    await checkKycRateLimit({ ip: "1.2.3.4" });
    const ipArgs = slidingWindowMock.mock.calls[0]!;
    expect(ipArgs[1]).toBe("10 m"); // NO propaga el valor malformado (evita NaN en el sliding window)
  });

  it("KYC_RL_IP_WINDOW válido → se respeta ('30 s', con y sin espacio)", async () => {
    withUpstashEnv();
    vi.stubEnv("KYC_RL_IP_WINDOW", "30 s");
    limitMock.mockResolvedValue({ success: true, reset: Date.now() + 1000 });
    await checkKycRateLimit({ ip: "1.2.3.4" });
    expect(slidingWindowMock.mock.calls[0]![1]).toBe("30 s");
  });
});
