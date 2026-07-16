// Tests — single-use de la atestación (WKH-168 W6.2, AC-11). FAIL-CLOSED: el contraste con
// rate-limit.ts (fail-open) es intencional y es lo que estos tests protegen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setMock } = vi.hoisted(() => ({ setMock: vi.fn() }));
vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(() => ({ set: setMock })),
}));

import { __resetAttestationStore, claimAttestationOnce } from "./attestation-store";

const TX = "0xaaaa000000000000000000000000000000000000000000000000000000000001";

describe("attestation-store (WKH-168) — single-use fail-CLOSED", () => {
  beforeEach(() => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token-123");
    setMock.mockReset();
    __resetAttestationStore(); // sin esto el cliente memoizado ignora los stubs de env
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetAttestationStore();
  });

  it("A8: primer uso ⇒ ok; SET con NX + TTL sobre la key del txHash (CD-8: solo un flag, cero PII)", async () => {
    setMock.mockResolvedValue("OK");
    expect(await claimAttestationOnce(TX)).toEqual({ ok: true });
    expect(setMock).toHaveBeenCalledWith(`settle:att:${TX}`, "1", { nx: true, ex: 86_400 });
    // CD-8: el valor guardado es "1", NUNCA el estado de la remesa / beneficiario / monto.
    const [, value] = setMock.mock.calls[0] as [string, string, unknown];
    expect(value).toBe("1");
  });

  it("A8/AC-11: segunda presentación de la MISMA atestación (SET NX → null) ⇒ alreadyUsed (anti-replay)", async () => {
    setMock.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    expect(await claimAttestationOnce(TX)).toEqual({ ok: true });
    expect(await claimAttestationOnce(TX)).toEqual({ ok: false, alreadyUsed: true });
  });

  it("A9: sin env de Upstash ⇒ unavailable SIN tocar Redis (fail-closed, nunca ok:true)", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    __resetAttestationStore();
    expect(await claimAttestationOnce(TX)).toEqual({ ok: false, unavailable: true });
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    __resetAttestationStore();
    expect(await claimAttestationOnce(TX)).toEqual({ ok: false, unavailable: true });
    expect(setMock).not.toHaveBeenCalled();
  });

  it("A9/CD-12: Upstash THROW ⇒ unavailable, NUNCA ok:true — NO copia el fail-open de rate-limit.ts", async () => {
    // Este es el test estrella: con fail-open, un atacante que tira Upstash replaya la atestación N
    // veces → N payouts sobre un solo principal.
    setMock.mockRejectedValue(new Error("ETIMEDOUT"));
    const r = await claimAttestationOnce(TX);
    expect(r).toEqual({ ok: false, unavailable: true });
    expect(r.ok).toBe(false);
  });
});
