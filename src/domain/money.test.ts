import { describe, it, expect } from "vitest";
import { Money } from "./money";

describe("Money", () => {
  it("USDC roundtrip (6 decimales)", () => {
    const m = Money.of(400, "USDC");
    expect(m.minor).toBe(400_000_000);
    expect(m.major).toBe(400);
  });

  it("PEN (2 decimales)", () => {
    expect(Money.of(1480.5, "PEN").minor).toBe(148050);
  });

  it("rechaza negativo / NaN", () => {
    expect(() => Money.of(-1, "USDC")).toThrow(/invalid_money/);
    expect(() => Money.of(NaN, "PEN")).toThrow(/invalid_money/);
  });

  it("format localizado (cripto-invisible en la UI)", () => {
    expect(Money.of(400, "USDC").format()).toContain("$");
    expect(Money.of(1480.5, "PEN").format()).toContain("S/");
  });

  it("minus: no negativo + no cruza monedas", () => {
    expect(() => Money.of(1, "USDC").minus(Money.of(2, "USDC"))).toThrow(/money_negative/);
    expect(() => Money.of(1, "USDC").minus(Money.fromMinor(100, "PEN"))).toThrow(
      /currency_mismatch/,
    );
  });
});
