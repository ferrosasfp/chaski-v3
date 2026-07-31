// Tests de las piezas puras del smoke (`scripts/smoke-helpers.ts`). El smoke en sí NO se testea acá:
// toca la red y exige credenciales. Lo que sí se puede clavar es lo que se puede equivocar en
// silencio: el formato del HMAC del release, la validación de una env numérica y la de una signature.
import { describe, expect, it } from "vitest";
import {
  computeReleaseAttestation,
  encodeReleaseAttestationMessage,
  isBase58Signature,
  parseNumericEnv,
  usdToUsdcMinorUnits,
} from "./smoke-helpers";

describe("atestación de release (espejo del facilitator)", () => {
  it("el mensaje lleva el largo del remittanceId adelante (encoding del facilitator)", () => {
    expect(encodeReleaseAttestationMessage("m5-smoke-1", "SENDER")).toBe("10:m5-smoke-1SENDER");
  });

  it("el encoding es INYECTIVO: el corte naive por ':' colisiona y este no", () => {
    // Con `${remittanceId}:${sender}` los dos casos dan "a:b:c" y una atestación sería replayable
    // cruzando escrows. Con el largo adelante son mensajes distintos.
    expect(encodeReleaseAttestationMessage("a:b", "c")).not.toBe(
      encodeReleaseAttestationMessage("a", "b:c"),
    );
  });

  it("vector fijo: si alguien cambia el encoding o el algoritmo, esto se pone rojo", () => {
    // Valor calculado con la MISMA fórmula que wasiai-facilitator/src/routes/solana-escrow.ts:97-105.
    // Si el facilitator cambia su encoding, el smoke empieza a mandar atestaciones que el facilitator
    // rechaza con 422, y este test es lo único del lado de chaski que puede avisarlo antes.
    expect(
      computeReleaseAttestation(
        "m5-smoke-1",
        "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        "secreto-de-prueba",
      ),
    ).toBe("ce1baa8bd9ee4c7a5c385b032026c1fe1483b0c54f6430faea9c4948b8cc30a1");
  });

  it("cambiar el sender cambia la atestación (está atada a las dos partes)", () => {
    const a = computeReleaseAttestation("r-1", "SENDER-A", "s");
    const b = computeReleaseAttestation("r-1", "SENDER-B", "s");
    expect(a).not.toBe(b);
  });
});

describe("validación base58 de una signature", () => {
  it("acepta una signature real de devnet", () => {
    expect(
      isBase58Signature(
        "22A61CyncHSGGHHDujNVJUvrgx8wxETSaGzPFdHrE9WMxatsxr4vNTg6JFesBQdBdbycTj6iF3gX2eoRY65JcFnN",
      ),
    ).toBe(true);
  });

  it("rechaza lo que un `typeof === string` dejaba pasar", () => {
    for (const bad of ["", "   ", "no-base58-porque-tiene-0-y-l: 0l", "corta"]) {
      expect(isBase58Signature(bad)).toBe(false);
    }
    expect(isBase58Signature(null)).toBe(false);
    expect(isBase58Signature(123)).toBe(false);
  });

  it("rechaza los caracteres que base58 excluye a propósito (0, O, I, l)", () => {
    const base = "22A61CyncHSGGHHDujNVJUvrgx8wxETSaGzPFdHrE9WMxatsxr4vNTg6JFesBQdBdbycTj6iF3gX2eoRY65JcFnN";
    for (const ch of ["0", "O", "I", "l"]) {
      expect(isBase58Signature(base.slice(1) + ch)).toBe(false);
    }
  });
});

describe("parseNumericEnv", () => {
  it("parsea un valor válido", () => {
    expect(parseNumericEnv("SMOKE_AMOUNT_USD", "10")).toEqual({ ok: true, value: 10 });
    expect(parseNumericEnv("SMOKE_AMOUNT_USD", " 2.5 ")).toEqual({ ok: true, value: 2.5 });
  });

  it("un valor no numérico NO devuelve NaN: devuelve un error que NOMBRA la env", () => {
    const r = parseNumericEnv("SMOKE_DEADLINE_SECONDS", "una hora");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("SMOKE_DEADLINE_SECONDS");
  });

  it("el motivo NUNCA incluye el valor de la env", () => {
    const r = parseNumericEnv("SMOKE_AMOUNT_USD", "valor-secreto-que-no-debe-salir");
    expect(r.ok === false && r.reason).not.toContain("valor-secreto-que-no-debe-salir");
  });

  it("ausente o vacía es error (no cae a un default silencioso)", () => {
    expect(parseNumericEnv("X", undefined).ok).toBe(false);
    expect(parseNumericEnv("X", "").ok).toBe(false);
    expect(parseNumericEnv("X", "   ").ok).toBe(false);
  });

  it("Infinity y NaN explícitos son error", () => {
    expect(parseNumericEnv("X", "Infinity").ok).toBe(false);
    expect(parseNumericEnv("X", "NaN").ok).toBe(false);
  });

  it("aplica integer y min", () => {
    expect(parseNumericEnv("X", "3.5", { integer: true }).ok).toBe(false);
    expect(parseNumericEnv("X", "0", { min: 1 }).ok).toBe(false);
    expect(parseNumericEnv("X", "1", { integer: true, min: 1 })).toEqual({ ok: true, value: 1 });
  });
});

describe("usdToUsdcMinorUnits", () => {
  it("convierte a 6 decimales", () => {
    expect(usdToUsdcMinorUnits(10)).toBe(10_000_000n);
    expect(usdToUsdcMinorUnits(0.5)).toBe(500_000n);
  });
});
