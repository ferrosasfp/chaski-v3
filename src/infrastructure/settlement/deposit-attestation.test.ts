// Tests — atestación HMAC del depositAddress no-custodial (WKH-211 W0.1, AC-2). Fail-closed en cada
// rama. Mirror en forma de attestation.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEPOSIT_ATTESTATION_TTL_SECONDS,
  type DepositAttestation,
  issueDepositAttestation,
  issueSolanaDepositAttestation,
  type SolanaDepositAttestation,
  verifyDepositAttestation,
  verifySolanaDepositAttestation,
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

// ── T1 (HU-SOL-9 / WKH-208, AC-1/AC-5): variante Solana, tipos/funciones SEPARADAS (CD-8) ──────────
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
