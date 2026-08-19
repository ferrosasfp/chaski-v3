// Fail-closed del host del agente de KYC (WKH-233). El test que importa: SIN `KYC_AGENT_BASE_URL`
// este repo NO puede producir una URL del agente — o sea, no le habla a un host adivinado sobre la
// identidad de una persona.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { kycAgentUrl, resolveKycAgentBaseUrl } from "./agent-env";

afterEach(() => vi.unstubAllEnvs());

// `vi.stubEnv(k, undefined)` BORRA la key (no la deja como el string "undefined"), que es lo que hace
// falta para simular "el operador no seteó nada".
function unset(): void {
  vi.stubEnv("KYC_AGENT_BASE_URL", undefined);
}

describe("T-ENV-1 · resolveKycAgentBaseUrl — fail-closed, sin default", () => {
  it("SIN KYC_AGENT_BASE_URL → THROW kyc_agent_base_url_unset (nunca asume un host)", () => {
    unset();
    // 🧬 MUTANTE: `?? "https://algo"` en `resolveKycAgentBaseUrl` ⇒ esto deja de tirar ⇒ ROJO.
    expect(() => resolveKycAgentBaseUrl()).toThrow(/kyc_agent_base_url_unset/);
  });

  it("✅ calibración inversa: CON la env, devuelve el host y compone las dos rutas", () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
    const base = resolveKycAgentBaseUrl();
    expect(String(base)).toBe("https://agentes.test");
    // Un guard que tirara SIEMPRE también mataría al mutante de arriba: esta mitad es la que lo
    // distingue de "deniega todo".
    expect(kycAgentUrl(base, "session")).toMatch(/^https:\/\/agentes\.test\/api\/agents\/[^/]+\/session$/);
    expect(kycAgentUrl(base, "decision")).toMatch(/^https:\/\/agentes\.test\/api\/agents\/[^/]+\/decision$/);
  });

  it("la barra final se normaliza (los call sites concatenan una ruta que ya empieza con `/`)", () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test///");
    expect(kycAgentUrl(resolveKycAgentBaseUrl(), "session")).not.toContain("///api");
  });
});

describe("T-ENV-2 · lo que NO es un host válido", () => {
  it.each([
    ["cadena vacía", ""],
    ["sólo espacios", "   "],
  ])("%s → THROW _unset (una env presente y vacía es lo mismo que ausente)", (_caso, valor) => {
    vi.stubEnv("KYC_AGENT_BASE_URL", valor);
    expect(() => resolveKycAgentBaseUrl()).toThrow(/kyc_agent_base_url_unset/);
  });

  it.each([
    ["no es URL", "agentes.test"],
    ["ruta relativa", "/api/agents"],
    ["esquema no HTTP", "ftp://agentes.test"],
  ])("%s → THROW _invalid, y el error NO ecoa el valor", (_caso, valor) => {
    vi.stubEnv("KYC_AGENT_BASE_URL", valor);
    // 🧬 MUTANTE: aceptar cualquier string no vacío (borrar el `new URL(...)`) ⇒ ROJO.
    expect(() => resolveKycAgentBaseUrl()).toThrow(/kyc_agent_base_url_invalid/);
    let mensaje = "";
    try {
      resolveKycAgentBaseUrl();
    } catch (err) {
      mensaje = err instanceof Error ? err.message : String(err);
    }
    expect(mensaje).not.toContain(valor);
  });

  it("✅ calibración inversa: una URL válida con puerto y path pasa (no deniega todo)", () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", "http://localhost:3000/base");
    expect(kycAgentUrl(resolveKycAgentBaseUrl(), "decision")).toBe(
      "http://localhost:3000/base/api/agents/remit-kyc-validator/decision",
    );
  });
});

describe("T-ENV-3 · CD-2 — el nombre del agente aparece UNA sola vez en el módulo", () => {
  // ⚠️ Este test lee OTRO archivo (`agent-env.ts`), nunca a sí mismo: un `expect(self.includes(x))`
  // no puede fallar jamás, porque el literal está en la línea que lo busca. Este repo ya pagó tres
  // controles vacuos por ese error.
  const MODULO = path.resolve(__dirname, "agent-env.ts");
  const SLUG = "remit-kyc-validator";

  it("exactamente 1 aparición textual en `agent-env.ts` (ni en prosa, ni duplicada)", () => {
    const src = readFileSync(MODULO, "utf8");
    const apariciones = src.split(SLUG).length - 1;
    // 🧬 MUTANTE: duplicar el slug en una constante "para el preview" ⇒ 2 ⇒ ROJO.
    // ✅ Calibración: el archivo REAL de hoy da 1, así que el assert no es vacuo por ausencia.
    expect(apariciones, `el nombre del agente aparece ${apariciones} veces en agent-env.ts`).toBe(1);
  });

  it("control positivo: el barrido SÍ ve el archivo y SÍ encuentra el slug", () => {
    const src = readFileSync(MODULO, "utf8");
    expect(src.length).toBeGreaterThan(500);
    expect(src).toContain(SLUG);
  });
});
