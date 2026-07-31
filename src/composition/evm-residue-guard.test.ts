// Tests — assertNoEvmResidue (WKH-320 / AC-3.3). Chaski ya no tiene interruptor de VM en el código,
// pero las envs EVM viven FUERA del código (panel de Vercel) y ahí quedan huérfanas sin que nadie
// avise. Este guard es la ÚNICA pieza de la HU que no se resuelve por construcción.
//
// ⚠️ Este archivo NO alcanza solo. Un guard escrito como `for (const k of NAMES) process.env[k]`
// pasa TODOS estos tests (en Node `process.env` es un objeto real) y aun así no puede fallar nunca
// en el bundle del cliente, que es exactamente donde tiene que fallar. Eso lo clava
// evm-residue-guard.static.test.ts, y esa asimetría es deliberada: ver M4 en el Story File.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNoEvmResidue } from "./evm-residue-guard";

// Las 6 que el guard vigila. Se listan ACÁ (en el test) para que sacar una del guard ponga esto rojo.
const EVM_ENVS = [
  "NEXT_PUBLIC_VM",
  "NEXT_PUBLIC_EIP3009_ENABLED",
  "NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS",
  "NEXT_PUBLIC_USDC_CONTRACT_ADDRESS",
  "NEXT_PUBLIC_CHAIN_ID",
  "NEXT_PUBLIC_REOWN_PROJECT_ID",
] as const;

// Valores DISTINGUIBLES entre sí y del nombre de su variable: si el guard ecoara el valor, el assert
// de "el mensaje no contiene ningún valor" lo cazaría.
const VALUES: Record<(typeof EVM_ENVS)[number], string> = {
  NEXT_PUBLIC_VM: "solana",
  NEXT_PUBLIC_EIP3009_ENABLED: "true",
  NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS: "0x2222222222222222222222222222222222222222",
  NEXT_PUBLIC_USDC_CONTRACT_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  NEXT_PUBLIC_CHAIN_ID: "84532",
  NEXT_PUBLIC_REOWN_PROJECT_ID: "reown-project-id-secreto",
};

beforeEach(() => {
  // Punto de partida limpio: el proceso que corre la suite puede tener alguna seteada.
  for (const k of EVM_ENVS) vi.stubEnv(k, undefined as unknown as string);
});
afterEach(() => vi.unstubAllEnvs());

describe("assertNoEvmResidue — AC-3.3 (WKH-320)", () => {
  it("las 6 ausentes ⇒ NO throw (el caso feliz del deploy ya limpio)", () => {
    expect(() => assertNoEvmResidue()).not.toThrow();
  });

  // Una por una: si alguien saca UNA de la lista del guard, sólo su caso se pone rojo y lo dice por
  // nombre. Un `expect(...).toThrow()` genérico dejaría pasar esa mutación (M5).
  for (const name of EVM_ENVS) {
    it(`${name} con valor ⇒ throw evm_config_residue nombrándola`, () => {
      vi.stubEnv(name, VALUES[name]);
      expect(() => assertNoEvmResidue()).toThrow("evm_config_residue");
      expect(() => assertNoEvmResidue()).toThrow(name);
    });
  }

  it("el mensaje lleva NOMBRES, JAMÁS valores (no filtra config en un log)", () => {
    for (const k of EVM_ENVS) vi.stubEnv(k, VALUES[k]);
    let message = "";
    try {
      assertNoEvmResidue();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("evm_config_residue");
    for (const k of EVM_ENVS) expect(message).toContain(k); // los 6 nombres
    for (const k of EVM_ENVS) expect(message).not.toContain(VALUES[k]); // ningún valor
  });

  it("string vacío NO cuenta como residuo (una env borrada en Vercel llega como '')", () => {
    for (const k of EVM_ENVS) vi.stubEnv(k, "");
    expect(() => assertNoEvmResidue()).not.toThrow();
  });
});
