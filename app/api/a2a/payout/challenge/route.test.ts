// Tests — emisor del challenge PoP (WKH-206 W1.1, AC-2). El verificador corre REAL (HMAC de verdad):
// el popChallenge devuelto DEBE verificar con verifyPopChallenge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSolanaPopMessage,
  verifySolanaPopChallenge,
} from "../../../../../src/infrastructure/auth/pop-challenge";

// WKH-205: el rate-limit IP-only corre tras el 501 de POP_SECRET. Los tests no fijan Upstash env
// (fail-closed → 503) → mockeamos checkRouteRateLimit a { ok:true } por default y lo overrideamos en
// AC-5 (!ok → 429) / AC-6 (unavailable → 503). clientIp/PAYOUT_CHALLENGE_RL se conservan reales.
const { checkRouteRateLimitMock } = vi.hoisted(() => ({ checkRouteRateLimitMock: vi.fn() }));
vi.mock("../../../../../src/infrastructure/rate-limit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../../src/infrastructure/rate-limit")>();
  return { ...actual, checkRouteRateLimit: checkRouteRateLimitMock };
});

import { POST } from "./route";

// WKH-320: la address del caller es base58. Este archivo probaba además la EMISIÓN EVM del challenge
// (address normalizada a lowercase + `chainId: 84532` de la ENV) — se fue con la VM que la ataba.
const ADDR = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function req(payload: unknown): Request {
  return new Request("http://localhost/api/a2a/payout/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/a2a/payout/challenge (WKH-206)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "84532");
    checkRouteRateLimitMock.mockReset();
    checkRouteRateLimitMock.mockResolvedValue({ ok: true }); // default: rate-limit permite el paso
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("AC-1: sin PAYOUT_POP_SECRET → 501 pop_not_configured", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "");
    const res = await POST(req({ address: ADDR }));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "pop_not_configured" });
  });

  // WKH-320: acá había un round-trip del challenge EVM (address lowercaseada + chainId 84532 de la
  // ENV). El round-trip del challenge que SÍ se emite hoy —ed25519 con network-id CAIP-2— se prueba
  // en el describe de abajo, contra la misma ruta.

  it("robustez: address malformada → 400, nunca 500", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "test-secret");
    for (const address of ["", "no-es-address", "0x123", "0OIl-not-base58", undefined, 123]) {
      const res = await POST(req({ address }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "pop_invalid_request" });
    }
  });

  it("robustez: body null / no-record → 400, nunca 500", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "test-secret");
    for (const payload of [null, [], 123, "str"]) {
      const res = await POST(req(payload));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "pop_invalid_request" });
    }
  });

  it("WKH-205 AC-5: rate-limit !ok (con POP_SECRET) → 429, NINGÚN challenge/HMAC emitido", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "test-secret");
    checkRouteRateLimitMock.mockResolvedValue({ ok: false, retryAfter: 45 });
    const res = await POST(req({ address: ADDR }));
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "pop_rate_limited" });
    // No se emitió challenge: la respuesta no contiene popChallenge/popMessage.
    expect(body.popChallenge).toBeUndefined();
    expect(res.headers.get("Retry-After")).toBe("45");
  });

  it("WKH-205 AC-6: Upstash ausente (con POP_SECRET) → 503 fail-closed, NINGÚN challenge emitido", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "test-secret");
    checkRouteRateLimitMock.mockResolvedValue({ ok: false, unavailable: true });
    const res = await POST(req({ address: ADDR }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "pop_rate_limit_unavailable" });
    expect(body.popChallenge).toBeUndefined();
  });
});

// ── HU-SOL-8 (WKH-211) — emisión del challenge, hoy la única ──────────────────────────────────────
const SOL_ADDR = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // base58 canónico válido

describe("POST /api/a2a/payout/challenge — challenge ed25519 (HU-SOL-8)", () => {
  beforeEach(() => {
    checkRouteRateLimitMock.mockReset();
    checkRouteRateLimitMock.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("address base58 válida → 200 { popChallenge, popMessage, exp }; popMessage lleva `network: solana:devnet` y round-trippea", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "test-secret");
    const res = await POST(req({ address: SOL_ADDR }));
    expect(res.status).toBe(200);
    const { popChallenge, popMessage, exp } = (await res.json()) as {
      popChallenge: string;
      popMessage: string;
      exp: number;
    };
    expect(popMessage).toContain("network: solana:devnet");
    expect(popMessage).not.toContain("chainId:"); // CAIP-2, NO chainId numérico
    // El challenge emitido verifica con el mismo secreto (round-trip real) y ata el network-id server-side.
    const ch = verifySolanaPopChallenge(popChallenge, Date.now());
    expect(ch).not.toBeNull();
    expect(ch?.address).toBe(SOL_ADDR); // base58 case-sensitive (CD-8)
    expect(ch?.networkId).toBe("solana:devnet"); // CD-3: de la ENV, no del body
    expect(ch?.exp).toBe(exp);
    // El popMessage es EXACTAMENTE buildSolanaPopMessage(ch) (CD-6: única fuente del formato).
    expect(popMessage).toBe(buildSolanaPopMessage(ch!));
  });

  it("vm=solana + address base58 inválida → 400 pop_invalid_request, NUNCA 500", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "test-secret");
    for (const address of ["", "0OIl-not-base58", "0x1111111111111111111111111111111111111111", undefined, 123]) {
      const res = await POST(req({ address }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "pop_invalid_request" });
    }
  });

  it("vm=solana + sin PAYOUT_POP_SECRET → 501 pop_not_configured (ANTES de la rama VM, intacto)", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "");
    const res = await POST(req({ address: SOL_ADDR }));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "pop_not_configured" });
  });
});
