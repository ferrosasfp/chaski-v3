// Tests — emisor del challenge PoP (WKH-206 W1.1, AC-2). El verificador corre REAL (HMAC de verdad):
// el popChallenge devuelto DEBE verificar con verifyPopChallenge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPopMessage,
  verifyPopChallenge,
} from "../../../../../src/infrastructure/auth/pop-challenge";
import { POST } from "./route";

const ADDR = "0x1111111111111111111111111111111111111111";

function req(payload: unknown): Request {
  return new Request("http://localhost/api/a2a/payout/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/a2a/payout/challenge (WKH-206)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "43113");
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

  it("AC-2: address válida → 200 { popChallenge, popMessage, exp } y el challenge VERIFICA (HMAC real)", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "test-secret");
    const res = await POST(req({ address: ADDR }));
    expect(res.status).toBe(200);
    const { popChallenge, popMessage, exp } = (await res.json()) as {
      popChallenge: string;
      popMessage: string;
      exp: number;
    };
    // El challenge emitido verifica con el mismo secreto (round-trip real).
    const ch = verifyPopChallenge(popChallenge, Date.now());
    expect(ch).not.toBeNull();
    expect(ch?.address).toBe(ADDR.toLowerCase()); // normalizado a lowercase
    expect(ch?.chainId).toBe(43113); // CD-9: de la ENV, no del body
    expect(ch?.exp).toBe(exp);
    // El popMessage es EXACTAMENTE buildPopMessage(ch) (CD-10: única fuente del formato).
    expect(popMessage).toBe(buildPopMessage(ch!));
  });

  it("robustez: address malformada → 400, nunca 500", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "test-secret");
    for (const address of ["", "no-es-address", "0x123", undefined, 123]) {
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
});
