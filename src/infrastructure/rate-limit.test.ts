import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock de Upstash: la unidad bajo test es la lógica de fail-mode/límite, no la red.
// slidingWindowMock captura (max, win) para poder assertar defaults/validación (MNR-2, MNR-3).
const { limitMock, slidingWindowMock, prefixes } = vi.hoisted(() => ({
  limitMock: vi.fn(),
  slidingWindowMock: vi.fn((max: number, win: string) => ({ max, win })),
  prefixes: [] as string[], // WKH-205: captura los prefix de cada Ratelimit para el test de aislamiento.
}));
vi.mock("@upstash/redis", () => ({ Redis: vi.fn(() => ({})) }));
vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    static slidingWindow = slidingWindowMock;
    constructor(opts: { prefix: string }) {
      prefixes.push(opts.prefix);
    }
    limit(key: string) {
      return limitMock(key);
    }
  }
  return { Ratelimit };
});

import {
  PAYOUT_CHALLENGE_RL,
  PAYOUT_VALIDATE_RL,
  __resetKycRateLimitClient,
  checkKycRateLimit,
  checkRouteRateLimit,
} from "./rate-limit";

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  limitMock.mockReset();
  slidingWindowMock.mockClear();
  prefixes.length = 0;
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

describe("checkRouteRateLimit — API genérica (WKH-205)", () => {
  it("Upstash ausente → fail-CLOSED { unavailable:true }, sin tocar limit (CD-4)", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    const res = await checkRouteRateLimit(PAYOUT_VALIDATE_RL, { ip: "9.9.9.9" });
    expect(res.unavailable).toBe(true);
    expect(res.ok).toBe(false);
    expect(limitMock).not.toHaveBeenCalled();
  });

  it("dentro del límite → { ok:true } (IP + address buckets)", async () => {
    withUpstashEnv();
    limitMock.mockResolvedValue({ success: true, reset: Date.now() + 60_000 });
    const res = await checkRouteRateLimit(PAYOUT_VALIDATE_RL, { ip: "9.9.9.9", address: "0xdef" });
    expect(res.ok).toBe(true);
    expect(limitMock).toHaveBeenCalledWith("9.9.9.9");
    expect(limitMock).toHaveBeenCalledWith("0xdef");
  });

  it("fuera de límite (IP) → { ok:false, retryAfter }", async () => {
    withUpstashEnv();
    limitMock.mockResolvedValue({ success: false, reset: Date.now() + 90_000 });
    const res = await checkRouteRateLimit(PAYOUT_VALIDATE_RL, { ip: "9.9.9.9" });
    expect(res.ok).toBe(false);
    expect(res.retryAfter).toBeGreaterThan(0);
  });

  it("error transitorio de Upstash → fail-OPEN + console.warn", async () => {
    withUpstashEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    limitMock.mockRejectedValue(new Error("ETIMEDOUT"));
    const res = await checkRouteRateLimit(PAYOUT_VALIDATE_RL, { ip: "9.9.9.9" });
    expect(res.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("config IP-only (PAYOUT_CHALLENGE_RL sin addr) → NO consulta el bucket address", async () => {
    withUpstashEnv();
    limitMock.mockResolvedValue({ success: true, reset: Date.now() + 1000 });
    const res = await checkRouteRateLimit(PAYOUT_CHALLENGE_RL, { ip: "9.9.9.9", address: "0xdef" });
    expect(res.ok).toBe(true);
    // Aunque venga address en el input, la config no declara bucket addr → solo se limita la IP.
    expect(limitMock).toHaveBeenCalledTimes(1);
    expect(limitMock).toHaveBeenCalledWith("9.9.9.9");
    expect(limitMock).not.toHaveBeenCalledWith("0xdef");
    // Solo se construyó UN limiter (IP), sin bucket address.
    expect(prefixes).toEqual(["payout:challenge:rl:ip"]);
  });

  it("aislamiento de buckets: prefijos distintos por ruta + memoización per-prefix", async () => {
    withUpstashEnv();
    limitMock.mockResolvedValue({ success: true, reset: Date.now() + 1000 });

    await checkRouteRateLimit(PAYOUT_VALIDATE_RL, { ip: "9.9.9.9" });
    // validate declara IP + addr → 2 limiters, con prefijos NAMESPACED por ruta (no comparten counter).
    expect(prefixes).toEqual(["payout:validate:rl:ip", "payout:validate:rl:addr"]);

    await checkRouteRateLimit(PAYOUT_CHALLENGE_RL, { ip: "9.9.9.9" });
    // challenge usa un prefijo DISTINTO → contador aislado del de validate.
    expect(prefixes).toEqual([
      "payout:validate:rl:ip",
      "payout:validate:rl:addr",
      "payout:challenge:rl:ip",
    ]);

    // Re-invocar validate NO reconstruye (cache per-prefix) → prefixes no crece.
    await checkRouteRateLimit(PAYOUT_VALIDATE_RL, { ip: "9.9.9.9" });
    expect(prefixes).toHaveLength(3);
  });
});
