import { afterEach, describe, expect, it } from "vitest";
import { resolveChain, resolveChainId } from "./chain";

// AC-7: NEXT_PUBLIC_CHAIN_ID es la única fuente del chainId; default 43114 (Avalanche mainnet).
const ENV = "NEXT_PUBLIC_CHAIN_ID";

afterEach(() => {
  delete process.env[ENV];
});

describe("resolveChainId / resolveChain — chain env-driven (AC-7, CD-5)", () => {
  it("unset → 43114 (Avalanche mainnet, fail-safe = lo que firma el demo hoy)", () => {
    delete process.env[ENV];
    expect(resolveChainId()).toBe(43114);
    expect(resolveChain().id).toBe(43114);
  });

  it('"43113" → Fuji', () => {
    process.env[ENV] = "43113";
    expect(resolveChainId()).toBe(43113);
    expect(resolveChain().id).toBe(43113);
  });

  it('"43114" → Avalanche mainnet', () => {
    process.env[ENV] = "43114";
    expect(resolveChainId()).toBe(43114);
    expect(resolveChain().id).toBe(43114);
  });

  it('"99" (red no soportada) → 43114 (fail-safe)', () => {
    process.env[ENV] = "99";
    expect(resolveChainId()).toBe(43114);
    expect(resolveChain().id).toBe(43114);
  });

  it('basura ("abc") → 43114 (fail-safe)', () => {
    process.env[ENV] = "abc";
    expect(resolveChainId()).toBe(43114);
    expect(resolveChain().id).toBe(43114);
  });
});
