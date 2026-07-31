// Tests — challenge proof-of-possession HMAC (WKH-206 W0.1). Fail-closed en cada rama.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SolanaPopChallenge,
  buildSolanaPopMessage,
  issueSolanaPopChallenge,
  verifySolanaPopChallenge,
} from "./pop-challenge";

const NOW_MS = Date.parse("2026-07-15T12:00:00.000Z");
// ── HU-SOL-8 (WKH-211) — challenge PoP ed25519 (AC-6).
// WKH-320: acá arriba vivía el describe del challenge EVM (PopChallenge con chainId numérico,
// issuePopChallenge/verifyPopChallenge/buildPopMessage). Probaba el round-trip HMAC, el forjado, el
// vencimiento y los tipos deformes de un challenge que ataba un chainId EVM. Se fue con la VM.
const SOL_ADDR = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // base58 canónico (case-sensitive)

function solPayload(over: Partial<SolanaPopChallenge> = {}): SolanaPopChallenge {
  return {
    address: SOL_ADDR,
    networkId: "solana:devnet",
    nonce: "abcdef0123456789abcdef0123456789",
    exp: Math.floor(NOW_MS / 1000) + 300,
    ...over,
  };
}

describe("pop-challenge Solana (HU-SOL-8)", () => {
  beforeEach(() => {
    vi.stubEnv("PAYOUT_POP_SECRET", "test-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("AC-6: buildSolanaPopMessage — formato exacto, 5 líneas con `network:`, SIN newline final", () => {
    const p = solPayload();
    const msg = buildSolanaPopMessage(p);
    expect(msg).toBe(
      `Chaski Proof-of-Possession\naddress: ${p.address}\nnetwork: ${p.networkId}\nnonce: ${p.nonce}\nexpires: ${p.exp}`,
    );
    expect(msg).toContain(`network: ${p.networkId}`);
    expect(msg).not.toContain("chainId:"); // ata network-id CAIP-2, NO chainId numérico
    expect(msg.split("\n")).toHaveLength(5);
    expect(msg.endsWith("\n")).toBe(false);
  });

  it("AC-6: round-trip — issueSolanaPopChallenge → verifySolanaPopChallenge reconstruye idéntico", () => {
    const token = issueSolanaPopChallenge(solPayload());
    const got = verifySolanaPopChallenge(token, NOW_MS);
    expect(got).toEqual(solPayload());
  });

  it("AC-6: networkId fuera de /^solana:(devnet|mainnet)$/ (con HMAC válido) ⇒ null", () => {
    for (const networkId of ["solana:testnet", "eip155:1", "solana:", "devnet", "SOLANA:DEVNET", ""]) {
      const payloadB64 = Buffer.from(
        JSON.stringify(solPayload({ networkId })),
        "utf8",
      ).toString("base64url");
      const mac = createHmac("sha256", "test-secret").update(payloadB64).digest("base64url");
      expect(verifySolanaPopChallenge(`${payloadB64}.${mac}`, NOW_MS)).toBeNull();
    }
    // mainnet SÍ es válido (frontera del regex).
    expect(verifySolanaPopChallenge(issueSolanaPopChallenge(solPayload({ networkId: "solana:mainnet" })), NOW_MS)).not.toBeNull();
  });

  it("AC-6: HMAC forjado / otro secreto / vencido ⇒ null (fail-closed, 403 opaco)", () => {
    // Firmado con otro secreto.
    const token = issueSolanaPopChallenge(solPayload());
    vi.stubEnv("PAYOUT_POP_SECRET", "otro-secreto");
    expect(verifySolanaPopChallenge(token, NOW_MS)).toBeNull();
    vi.stubEnv("PAYOUT_POP_SECRET", "test-secret");
    // Vencido.
    const expired = issueSolanaPopChallenge(solPayload({ exp: Math.floor(NOW_MS / 1000) - 1 }));
    expect(verifySolanaPopChallenge(expired, NOW_MS)).toBeNull();
    // Formato inválido.
    expect(verifySolanaPopChallenge("sin-punto", NOW_MS)).toBeNull();
  });
});
