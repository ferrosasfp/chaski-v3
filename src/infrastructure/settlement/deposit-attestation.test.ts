// Tests — atestación HMAC del depositAddress no-custodial (WKH-211 W0.1, AC-2). Fail-closed en cada
// rama. Mirror en forma de attestation.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEPOSIT_ATTESTATION_TTL_SECONDS,
  type DepositAttestation,
  issueDepositAttestation,
  verifyDepositAttestation,
} from "./deposit-attestation";

const NOW_MS = Date.parse("2026-07-18T12:00:00.000Z");
const DEPOSIT = "0x4444444444444444444444444444444444444444";

function payload(over: Partial<DepositAttestation> = {}): DepositAttestation {
  return {
    remittanceId: "rem-1",
    quoteId: "q-400",
    depositAddress: DEPOSIT,
    chainId: 84532,
    exp: Math.floor(NOW_MS / 1000) + 600,
    ...over,
  };
}

describe("deposit attestation (WKH-211)", () => {
  beforeEach(() => {
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "test-deposit-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("AC-2: TTL === 10 min (< 15 min del settlement, DT-4/DT-5)", () => {
    expect(DEPOSIT_ATTESTATION_TTL_SECONDS).toBe(10 * 60);
  });

  it("round-trip: una atestación emitida verifica y devuelve el payload íntegro", () => {
    const token = issueDepositAttestation(payload());
    expect(verifyDepositAttestation(token, NOW_MS)).toEqual(payload());
  });

  it("HMAC forjado (payload alterado, firma vieja) ⇒ null (no se puede inyectar otro depositAddress)", () => {
    const token = issueDepositAttestation(payload());
    const [, mac] = token.split(".");
    // El atacante cambia el depositAddress al suyo y reusa el MAC original.
    const forged = Buffer.from(
      JSON.stringify(payload({ depositAddress: "0x9999999999999999999999999999999999999999" })),
      "utf8",
    ).toString("base64url");
    expect(verifyDepositAttestation(`${forged}.${mac}`, NOW_MS)).toBeNull();
  });

  it("formato inválido (sin punto, partes vacías, no-string, 3 partes) ⇒ null", () => {
    expect(verifyDepositAttestation("sin-punto", NOW_MS)).toBeNull();
    expect(verifyDepositAttestation(".", NOW_MS)).toBeNull();
    expect(verifyDepositAttestation("a.b.c", NOW_MS)).toBeNull();
    expect(verifyDepositAttestation("", NOW_MS)).toBeNull();
    expect(verifyDepositAttestation(123 as unknown as string, NOW_MS)).toBeNull();
  });

  it("atestación vencida ⇒ null; vigente por 1s más ⇒ verifica (frontera exp)", () => {
    const dead = issueDepositAttestation(payload({ exp: Math.floor(NOW_MS / 1000) - 1 }));
    expect(verifyDepositAttestation(dead, NOW_MS)).toBeNull();
    const live = issueDepositAttestation(payload({ exp: Math.floor(NOW_MS / 1000) + 1 }));
    expect(verifyDepositAttestation(live, NOW_MS)).not.toBeNull();
  });

  it("cada campo deforme ⇒ null (un HMAC válido sobre un payload deforme sigue siendo deforme)", () => {
    const cases: Record<string, unknown>[] = [
      { remittanceId: "" }, // vacío
      { remittanceId: 123 }, // no-string
      { quoteId: "" },
      { quoteId: null },
      { depositAddress: "0xNOT_AN_ADDRESS" }, // isAddress falla
      { depositAddress: "" },
      { chainId: 84532.5 }, // no entero
      { chainId: "84532" }, // no-number
      { exp: Number.NaN }, // no finito
      { exp: "soon" },
    ];
    for (const over of cases) {
      // Forjamos un token cuyo HMAC es VÁLIDO pero el payload tiene un campo deforme: firmamos el
      // payload deforme con el secreto (issue no valida los tipos, verify sí).
      const token = issueDepositAttestation({ ...payload(), ...(over as Partial<DepositAttestation>) });
      expect(verifyDepositAttestation(token, NOW_MS)).toBeNull();
    }
  });

  it("fail-closed: otro secreto NO verifica; sin secreto ⇒ null (nunca throw), timing-safe longitud-primero", () => {
    const token = issueDepositAttestation(payload());
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "otro-secreto");
    expect(verifyDepositAttestation(token, NOW_MS)).toBeNull();
    // longitud distinta del MAC (timingSafeEqual TIRA con distinta longitud) ⇒ null, no throw.
    const [p] = token.split(".");
    expect(() => verifyDepositAttestation(`${p}.short`, NOW_MS)).not.toThrow();
    expect(verifyDepositAttestation(`${p}.short`, NOW_MS)).toBeNull();
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "");
    expect(() => verifyDepositAttestation(token, NOW_MS)).not.toThrow();
    expect(verifyDepositAttestation(token, NOW_MS)).toBeNull();
  });
});
