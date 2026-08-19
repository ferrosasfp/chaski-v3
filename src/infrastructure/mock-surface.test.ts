// T-MOCK-2 — el gate de la superficie de prueba del KYC, después de la mudanza de WKH-233/DT-9.
//
// ⚠️ ESTE ARCHIVO ES NUEVO PORQUE EL MÓDULO SE MUDÓ Y CAMBIÓ DE SEÑAL. Antes vivía en
// `src/infrastructure/didit/` y derivaba su respuesta del ambiente del PROVEEDOR; ese directorio se
// borró entero con la HU. El candado de las tres superficies (`app/kyc-simulado/kyc-simulado-gate.test.ts`)
// sigue vigilando que las tres deriven del MISMO gate; esto vigila el gate en sí.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_KYC_SURFACE_ENV, mockDiditSurfaceEnabled } from "./mock-surface";

afterEach(() => vi.unstubAllEnvs());

describe("T-MOCK-2 · fail-closed: el ÚNICO encendido es el literal exacto", () => {
  it.each([
    ["ausente", undefined],
    ["cadena vacía", ""],
    ["false", "false"],
    ["un typo", "tru"],
    ["TRUE en mayúsculas", "TRUE"],
    ["True capitalizado", "True"],
    ["1", "1"],
    ["yes", "yes"],
    ["con un espacio delante", " true"],
    ["con un espacio detrás", "true "],
  ])("%s ⇒ false", (_caso, valor) => {
    vi.stubEnv(MOCK_KYC_SURFACE_ENV, valor as string | undefined);
    // 🧬 MUTANTE: `!== "false"` ⇒ ocho de estos diez pasarían a `true` ⇒ ROJO. Y el daño del mutante
    // es preciso: un simulador de verificación de identidad ALCANZABLE en un despliegue que se cree
    // productivo describe un comportamiento que ese despliegue NO tiene.
    // 🧬 MUTANTE 2: `.trim().toLowerCase() === "true"` ⇒ los tres últimos + "TRUE"/"True" pasarían ⇒
    // ROJO. Un typo no puede convertirse en un permiso.
    expect(mockDiditSurfaceEnabled()).toBe(false);
  });

  it("✅ calibración inversa: con el literal exacto `true` ⇒ true (no deniega todo)", () => {
    vi.stubEnv(MOCK_KYC_SURFACE_ENV, "true");
    expect(mockDiditSurfaceEnabled()).toBe(true);
  });

  it("la env se lee en RUNTIME, no al importar: apagarla apaga sin re-deployar", () => {
    vi.stubEnv(MOCK_KYC_SURFACE_ENV, "true");
    expect(mockDiditSurfaceEnabled()).toBe(true);
    vi.stubEnv(MOCK_KYC_SURFACE_ENV, undefined);
    // 🧬 MUTANTE: leer la env a nivel de módulo (`const ON = process.env... === "true"`) ⇒ el segundo
    // assert seguiría dando `true` ⇒ ROJO.
    expect(mockDiditSurfaceEnabled()).toBe(false);
  });

  it("⛔ el nombre de la env es el que `.env.example` documenta, y NO el del proveedor", () => {
    // Que sean DOS envs distintas es la consecuencia de MI-10, y es lo que deja el mock APAGADO hasta
    // que un operador lo encienda. Si alguien "arreglara" eso volviendo a leer la env del proveedor,
    // esto se pone rojo — y el guard de residuo también.
    expect(MOCK_KYC_SURFACE_ENV).toBe("MOCK_KYC_SURFACE_ENABLED");
  });
});
