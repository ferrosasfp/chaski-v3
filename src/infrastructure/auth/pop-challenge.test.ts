// Tests — challenge proof-of-possession HMAC (WKH-206 W0.1). Fail-closed en cada rama.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PopChallenge,
  type SolanaPopChallenge,
  buildPopMessage,
  buildSolanaPopMessage,
  issuePopChallenge,
  issueSolanaPopChallenge,
  verifyPopChallenge,
  verifySolanaPopChallenge,
} from "./pop-challenge";

const NOW_MS = Date.parse("2026-07-15T12:00:00.000Z");
const ADDR = "0x1111111111111111111111111111111111111111";

function payload(over: Partial<PopChallenge> = {}): PopChallenge {
  return {
    address: ADDR,
    chainId: 84532,
    nonce: "abcdef0123456789abcdef0123456789",
    exp: Math.floor(NOW_MS / 1000) + 300,
    ...over,
  };
}

describe("pop-challenge (WKH-206)", () => {
  beforeEach(() => {
    vi.stubEnv("PAYOUT_POP_SECRET", "test-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("AC-2: round-trip — un challenge emitido verifica y devuelve el payload íntegro", () => {
    const token = issuePopChallenge(payload());
    const got = verifyPopChallenge(token, NOW_MS);
    expect(got).toEqual(payload());
  });

  it("AC-3: HMAC forjado (payload alterado, firma vieja) ⇒ null", () => {
    const token = issuePopChallenge(payload());
    const [, mac] = token.split(".");
    // El atacante cambia la address del challenge y reusa el MAC original.
    const forged = Buffer.from(
      JSON.stringify(payload({ address: "0x9999999999999999999999999999999999999999" })),
      "utf8",
    ).toString("base64url");
    expect(verifyPopChallenge(`${forged}.${mac}`, NOW_MS)).toBeNull();
  });

  it("AC-3: firmado con OTRO secreto ⇒ null (nunca throw)", () => {
    const token = issuePopChallenge(payload());
    vi.stubEnv("PAYOUT_POP_SECRET", "otro-secreto");
    expect(verifyPopChallenge(token, NOW_MS)).toBeNull();
    vi.stubEnv("PAYOUT_POP_SECRET", "");
    expect(() => verifyPopChallenge(token, NOW_MS)).not.toThrow();
    expect(verifyPopChallenge(token, NOW_MS)).toBeNull();
  });

  it("AC-3: formato inválido (sin punto, partes vacías, no-string) ⇒ null", () => {
    expect(verifyPopChallenge("sin-punto", NOW_MS)).toBeNull();
    expect(verifyPopChallenge(".", NOW_MS)).toBeNull();
    expect(verifyPopChallenge("a.b.c", NOW_MS)).toBeNull();
    expect(verifyPopChallenge("", NOW_MS)).toBeNull();
    expect(verifyPopChallenge(123 as unknown as string, NOW_MS)).toBeNull();
  });

  it("AC-4: challenge vencido ⇒ null (mismo null que el HMAC malo: 403 opaco, CD-4)", () => {
    const expired = issuePopChallenge(payload({ exp: Math.floor(NOW_MS / 1000) - 1 }));
    expect(verifyPopChallenge(expired, NOW_MS)).toBeNull();
    // Vigente por 1s más ⇒ sí verifica (frontera).
    const live = issuePopChallenge(payload({ exp: Math.floor(NOW_MS / 1000) + 1 }));
    expect(verifyPopChallenge(live, NOW_MS)).not.toBeNull();
  });

  it("AC-6: tipos deformes (address/chainId/nonce) sobre un HMAC válido ⇒ null", () => {
    // Cada payload deforme se firma con el secreto REAL (HMAC válido) para probar que la validación
    // de tipos corta igual — un HMAC bueno sobre un payload malo sigue siendo malo.
    const deformes: Record<string, unknown>[] = [
      { address: "no-es-address", chainId: 84532, nonce: "abcdef0123456789abcdef0123456789", exp: Math.floor(NOW_MS / 1000) + 300 },
      { address: ADDR, chainId: 84532.5, nonce: "abcdef0123456789abcdef0123456789", exp: Math.floor(NOW_MS / 1000) + 300 },
      { address: ADDR, chainId: "84532", nonce: "abcdef0123456789abcdef0123456789", exp: Math.floor(NOW_MS / 1000) + 300 },
      { address: ADDR, chainId: 84532, nonce: "SHORT", exp: Math.floor(NOW_MS / 1000) + 300 },
      { address: ADDR, chainId: 84532, nonce: "ABCDEF0123456789ABCDEF0123456789", exp: Math.floor(NOW_MS / 1000) + 300 }, // uppercase → no matchea /^[0-9a-f]{32}$/
      { address: ADDR, chainId: 84532, nonce: 12345, exp: Math.floor(NOW_MS / 1000) + 300 },
      { address: ADDR, chainId: 84532, nonce: "abcdef0123456789abcdef0123456789", exp: "later" },
    ];
    for (const deforme of deformes) {
      const payloadB64 = Buffer.from(JSON.stringify(deforme), "utf8").toString("base64url");
      const mac = createHmac("sha256", "test-secret").update(payloadB64).digest("base64url");
      expect(verifyPopChallenge(`${payloadB64}.${mac}`, NOW_MS)).toBeNull();
    }
  });

  it("AC-6/DT-3: buildPopMessage — formato exacto, 5 líneas, SIN newline final", () => {
    const p = payload();
    const msg = buildPopMessage(p);
    expect(msg).toBe(
      `Chaski Proof-of-Possession\naddress: ${p.address}\nchainId: ${p.chainId}\nnonce: ${p.nonce}\nexpires: ${p.exp}`,
    );
    // Contiene los 4 campos atados.
    expect(msg).toContain(p.address);
    expect(msg).toContain(String(p.chainId));
    expect(msg).toContain(p.nonce);
    expect(msg).toContain(String(p.exp));
    // 5 líneas, sin \n final.
    expect(msg.split("\n")).toHaveLength(5);
    expect(msg.endsWith("\n")).toBe(false);
  });
});

// ── HU-SOL-8 (WKH-211) — hermanas Solana del challenge PoP ed25519 (AC-6). EVM intactos arriba. ──
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
