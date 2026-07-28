// Fail-closed del ambiente de Didit. El test que importa: SIN `DIDIT_ENV` el repo NO puede producir
// un host de Didit — o sea, no puede crear verificaciones reales con PII de nadie por accidente.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIDIT_LIVE_BASE_URL,
  resolveDiditBaseUrl,
  resolveDiditEnvironment,
} from "./didit-env";

afterEach(() => vi.unstubAllEnvs());

// `vi.stubEnv(k, undefined)` BORRA la key (no la deja como el string "undefined"), que es lo que
// hace falta para simular "el operador no seteó nada".
function unsetAll(): void {
  vi.stubEnv("DIDIT_ENV", undefined);
  vi.stubEnv("DIDIT_BASE_URL", undefined);
  vi.stubEnv("VERCEL_ENV", undefined);
}

describe("resolveDiditEnvironment — fail-closed (sin default productivo)", () => {
  it("SIN DIDIT_ENV → THROW didit_env_unset (nunca asume el host de Didit)", () => {
    unsetAll();
    expect(() => resolveDiditEnvironment()).toThrow(/didit_env_unset/);
    // El punto del fix: tampoco se puede obtener una URL. Este es el assert anti-regresión.
    expect(() => resolveDiditBaseUrl()).toThrow(/didit_env_unset/);
  });

  it('DIDIT_ENV="" (seteada pero vacía) → THROW igual que ausente', () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", "   ");
    expect(() => resolveDiditBaseUrl()).toThrow(/didit_env_unset/);
  });

  it('DIDIT_ENV="sandbox" → THROW: Didit NO publica un host de sandbox (se separa por key/workflow)', () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", "sandbox");
    expect(() => resolveDiditBaseUrl()).toThrow(/didit_env_invalid:sandbox/);
  });

  it("DIDIT_ENV inválida → THROW con el valor ecoado (config de conjunto cerrado, no es secreto)", () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", "produccion");
    expect(() => resolveDiditEnvironment()).toThrow(/didit_env_invalid:produccion/);
  });

  it("case/espacios se normalizan (LIVE, ' live ' → live)", () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", " LIVE ");
    expect(resolveDiditEnvironment()).toBe("live");
  });
});

describe("resolveDiditBaseUrl — mock exige URL propia", () => {
  it("DIDIT_ENV=mock + DIDIT_BASE_URL de localhost → apunta al mock (http permitido en localhost)", () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", "mock");
    vi.stubEnv("DIDIT_BASE_URL", "http://localhost:9999/didit");
    expect(resolveDiditBaseUrl()).toBe("http://localhost:9999/didit");
  });

  it("DIDIT_ENV=mock SIN DIDIT_BASE_URL → THROW (no hay host de mock canónico que asumir)", () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", "mock");
    expect(() => resolveDiditBaseUrl()).toThrow(/didit_base_url_required_for_mock/);
  });

  it("DIDIT_ENV=mock apuntando al Didit REAL → THROW env_conflict (el incidente, invertido)", () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", "mock");
    vi.stubEnv("DIDIT_BASE_URL", DIDIT_LIVE_BASE_URL);
    expect(() => resolveDiditBaseUrl()).toThrow(/didit_base_url_env_conflict/);
  });

  it("http fuera de localhost → THROW (la api-key y la PII no viajan en claro)", () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", "mock");
    vi.stubEnv("DIDIT_BASE_URL", "http://mock.interno.example/didit");
    expect(() => resolveDiditBaseUrl()).toThrow(/didit_base_url_insecure_scheme:http/);
  });

  it("DIDIT_BASE_URL no absoluta → THROW", () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", "mock");
    vi.stubEnv("DIDIT_BASE_URL", "/api/mock");
    expect(() => resolveDiditBaseUrl()).toThrow(/didit_base_url_invalid/);
  });

  it("trailing slash normalizado (los call sites concatenan /v3/session/)", () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", "mock");
    vi.stubEnv("DIDIT_BASE_URL", "http://localhost:9999/didit///");
    expect(resolveDiditBaseUrl()).toBe("http://localhost:9999/didit");
  });
});

describe("resolveDiditBaseUrl — live", () => {
  it("DIDIT_ENV=live (sin override, sin VERCEL_ENV) → host canónico de Didit", () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", "live");
    // Local/CI con el free tier contra el host real es un flujo legítimo y documentado.
    expect(resolveDiditBaseUrl()).toBe(DIDIT_LIVE_BASE_URL);
  });

  it("DIDIT_ENV=live + VERCEL_ENV=production → host canónico (el único combo de prod)", () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", "live");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(resolveDiditBaseUrl()).toBe(DIDIT_LIVE_BASE_URL);
  });

  it("DIDIT_ENV=live + VERCEL_ENV=preview → THROW (preview hereda las envs de prod: el vector real)", () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", "live");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(() => resolveDiditBaseUrl()).toThrow(/didit_env_live_outside_vercel_production/);
  });

  it("DIDIT_ENV=live + VERCEL_ENV=development → THROW", () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", "live");
    vi.stubEnv("VERCEL_ENV", "development");
    expect(() => resolveDiditBaseUrl()).toThrow(/didit_env_live_outside_vercel_production/);
  });

  it("DIDIT_ENV=live + host NO-Didit → THROW (un mock que responda Approved bypassea compliance)", () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", "live");
    vi.stubEnv("DIDIT_BASE_URL", "https://mock.example.com");
    expect(() => resolveDiditBaseUrl()).toThrow(/didit_base_url_non_didit_host_in_live/);
  });

  it("DIDIT_ENV=live + subdominio de didit.me → permitido (override legítimo)", () => {
    unsetAll();
    vi.stubEnv("DIDIT_ENV", "live");
    vi.stubEnv("DIDIT_BASE_URL", "https://apx.didit.me");
    expect(resolveDiditBaseUrl()).toBe("https://apx.didit.me");
  });
});

describe("única fuente de verdad (anti-regresión del literal duplicado)", () => {
  it("el host productivo NO aparece hardcodeado en ningún otro archivo del repo", async () => {
    // Este es el canario del fix: el bug original era ESTE literal repetido en 3 lugares. Si
    // reaparece en código, el fix se perdió aunque todo lo demás siga verde.
    const { execFileSync } = await import("node:child_process");
    // `git grep` respeta .gitignore (no barre node_modules/.next) y corre desde la raíz del repo.
    // `--untracked` es OBLIGATORIO: sin él, un archivo nuevo todavía sin `git add` sería invisible
    // y el canario pasaría en falso justo cuando más importa (el commit que reintroduce el literal).
    const hits = execFileSync(
      "git",
      ["grep", "--untracked", "-l", "-F", "verification.didit.me", "--", "*.ts", "*.tsx"],
      { cwd: process.cwd(), encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    // Solo el módulo dueño del literal y este test pueden mencionarlo.
    expect(hits.sort()).toEqual([
      "src/infrastructure/didit/didit-env.test.ts",
      "src/infrastructure/didit/didit-env.ts",
    ]);
  });
});
