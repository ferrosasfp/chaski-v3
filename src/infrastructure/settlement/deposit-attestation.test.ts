// Tests — atestación HMAC del depositAddress no-custodial (WKH-211 W0.1, AC-2). Fail-closed en cada
// rama. Mirror en forma de attestation.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  issueSolanaDepositAttestation,
  type SolanaDepositAttestation,
  verifySolanaDepositAttestation,
} from "./deposit-attestation";

const NOW_MS = Date.parse("2026-07-18T12:00:00.000Z");
// ── T1 (HU-SOL-9 / WKH-208, AC-1/AC-5): atestación de depósito.
const BENEFICIARY = "So11111111111111111111111111111111111111112"; // base58 pubkey válida
const AUTHORITY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // base58 pubkey válida

function solPayload(over: Partial<SolanaDepositAttestation> = {}): SolanaDepositAttestation {
  return {
    remittanceId: "rem-1",
    quoteId: "q-400",
    beneficiary: BENEFICIARY,
    authority: AUTHORITY,
    cluster: "devnet",
    exp: Math.floor(NOW_MS / 1000) + 600,
    ...over,
  };
}

describe("Solana deposit attestation (HU-SOL-9)", () => {
  beforeEach(() => {
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "test-deposit-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trip: beneficiary/authority/cluster base58 verifican íntegros (case-sensitive)", () => {
    const token = issueSolanaDepositAttestation(solPayload());
    expect(verifySolanaDepositAttestation(token, NOW_MS)).toEqual(solPayload());
  });

  it("HMAC forjado: cambiar beneficiary reusando el MAC original ⇒ null (no se inyecta otro destino)", () => {
    const token = issueSolanaDepositAttestation(solPayload());
    const [, mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify(solPayload({ beneficiary: AUTHORITY })),
      "utf8",
    ).toString("base64url");
    expect(verifySolanaDepositAttestation(`${forged}.${mac}`, NOW_MS)).toBeNull();
  });

  it('cluster !== "devnet" ⇒ null (anti-replay cross-cluster, AC-5)', () => {
    const token = issueSolanaDepositAttestation(
      solPayload({ cluster: "mainnet" as unknown as "devnet" }),
    );
    expect(verifySolanaDepositAttestation(token, NOW_MS)).toBeNull();
  });

  it("beneficiary/authority base58 deforme ⇒ null (NO throw, fail-closed; NUNCA isAddress)", () => {
    const cases: Partial<SolanaDepositAttestation>[] = [
      { beneficiary: "0xNOT_BASE58" },
      { beneficiary: "" },
      { authority: "not base58 !!!" },
      { authority: "" },
    ];
    for (const over of cases) {
      const token = issueSolanaDepositAttestation({ ...solPayload(), ...over });
      expect(() => verifySolanaDepositAttestation(token, NOW_MS)).not.toThrow();
      expect(verifySolanaDepositAttestation(token, NOW_MS)).toBeNull();
    }
  });

  it("remittanceId/quoteId deforme ⇒ null", () => {
    for (const over of [{ remittanceId: "" }, { quoteId: "" }] as Partial<SolanaDepositAttestation>[]) {
      const token = issueSolanaDepositAttestation({ ...solPayload(), ...over });
      expect(verifySolanaDepositAttestation(token, NOW_MS)).toBeNull();
    }
  });

  it("expiración: vencida ⇒ null; vigente por 1s más ⇒ verifica (frontera exp)", () => {
    const dead = issueSolanaDepositAttestation(solPayload({ exp: Math.floor(NOW_MS / 1000) - 1 }));
    expect(verifySolanaDepositAttestation(dead, NOW_MS)).toBeNull();
    const live = issueSolanaDepositAttestation(solPayload({ exp: Math.floor(NOW_MS / 1000) + 1 }));
    expect(verifySolanaDepositAttestation(live, NOW_MS)).not.toBeNull();
  });

  it("fail-closed: otro secreto NO verifica; sin secreto ⇒ null (nunca throw)", () => {
    const token = issueSolanaDepositAttestation(solPayload());
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "otro-secreto");
    expect(verifySolanaDepositAttestation(token, NOW_MS)).toBeNull();
    const [p] = token.split(".");
    expect(() => verifySolanaDepositAttestation(`${p}.short`, NOW_MS)).not.toThrow();
    expect(verifySolanaDepositAttestation(`${p}.short`, NOW_MS)).toBeNull();
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "");
    expect(() => verifySolanaDepositAttestation(token, NOW_MS)).not.toThrow();
    expect(verifySolanaDepositAttestation(token, NOW_MS)).toBeNull();
  });

  it("formato inválido (sin punto, partes vacías, no-string, 3 partes) ⇒ null", () => {
    expect(verifySolanaDepositAttestation("sin-punto", NOW_MS)).toBeNull();
    expect(verifySolanaDepositAttestation(".", NOW_MS)).toBeNull();
    expect(verifySolanaDepositAttestation("a.b.c", NOW_MS)).toBeNull();
    expect(verifySolanaDepositAttestation("", NOW_MS)).toBeNull();
    expect(verifySolanaDepositAttestation(123 as unknown as string, NOW_MS)).toBeNull();
  });
});
