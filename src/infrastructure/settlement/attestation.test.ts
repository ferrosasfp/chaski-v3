// Tests — atestación HMAC del settlement (WKH-168 W0.2). Fail-closed en cada rama.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SettlementAttestation,
  issueSettlementAttestation,
  verifySettlementAttestation,
} from "./attestation";

const NOW_MS = Date.parse("2026-07-15T12:00:00.000Z");
const TX = "0x1111111111111111111111111111111111111111111111111111111111111111";
const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";

function payload(over: Partial<SettlementAttestation> = {}): SettlementAttestation {
  return {
    txHash: TX,
    chainId: 43113,
    valueMinor: 400_000_000,
    from: FROM,
    to: TO,
    quoteId: "q-400",
    exp: Math.floor(NOW_MS / 1000) + 900,
    ...over,
  };
}

describe("settlement attestation (WKH-168)", () => {
  beforeEach(() => {
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", "test-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trip: una atestación emitida verifica y devuelve el payload íntegro", () => {
    const token = issueSettlementAttestation(payload());
    const got = verifySettlementAttestation(token, NOW_MS);
    expect(got).toEqual(payload());
  });

  it("A4: HMAC forjado (payload alterado, firma vieja) ⇒ null", () => {
    const token = issueSettlementAttestation(payload());
    const [, mac] = token.split(".");
    // El atacante infla el monto y reusa el MAC original.
    const forged = Buffer.from(JSON.stringify(payload({ valueMinor: 999_999_999 })), "utf8").toString(
      "base64url",
    );
    expect(verifySettlementAttestation(`${forged}.${mac}`, NOW_MS)).toBeNull();
  });

  it("A4: formato inválido (sin punto, partes vacías, no-string) ⇒ null", () => {
    expect(verifySettlementAttestation("sin-punto", NOW_MS)).toBeNull();
    expect(verifySettlementAttestation(".", NOW_MS)).toBeNull();
    expect(verifySettlementAttestation("a.b.c", NOW_MS)).toBeNull();
    expect(verifySettlementAttestation("", NOW_MS)).toBeNull();
    expect(verifySettlementAttestation(123 as unknown as string, NOW_MS)).toBeNull();
  });

  it("A5: atestación vencida ⇒ null (mismo null que el HMAC malo: 403 opaco, CD-12)", () => {
    const exp = Math.floor(NOW_MS / 1000) - 1;
    const token = issueSettlementAttestation(payload({ exp }));
    expect(verifySettlementAttestation(token, NOW_MS)).toBeNull();
    // Vigente por 1s más ⇒ sí verifica (frontera).
    const live = issueSettlementAttestation(payload({ exp: Math.floor(NOW_MS / 1000) + 1 }));
    expect(verifySettlementAttestation(live, NOW_MS)).not.toBeNull();
  });

  it("fail-closed: otro secreto NO verifica, y sin secreto ⇒ null (nunca throw)", () => {
    const token = issueSettlementAttestation(payload());
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", "otro-secreto");
    expect(verifySettlementAttestation(token, NOW_MS)).toBeNull();
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", "");
    expect(() => verifySettlementAttestation(token, NOW_MS)).not.toThrow();
    expect(verifySettlementAttestation(token, NOW_MS)).toBeNull();
  });
});
