// Candado de la superficie de prueba de Didit: las TRES puertas se apagan juntas, con el MISMO gate.
//
// ── EL DEFECTO, medido el 2026-08-11 ─────────────────────────────────────────────────────────────
//
// `app/api/mock-didit/v3/session/route.ts` lleva escrito en su cabecera el principio: *"un mock
// alcanzable en un entorno que se cree productivo es peor que no tenerlo, porque el 404 es lo que hace
// verificable que está apagado"*. Esa ruta lo cumplía, la ruta de la decisión también — cada una con su
// PROPIA copia privada de `mockEnabled()` — y `app/kyc-simulado/page.tsx`, la única de las tres que una
// persona ve, **no tenía ningún gate**: cero apariciones de `DIDIT_ENV`, `process.env` o `notFound`.
// Respondía con cualquier configuración, incluida la que habla con el Didit real.
//
// El comentario de la página se amparaba en la protección de su hermana: *"la ruta que emite el link ni
// siquiera responde, así que nadie llega hasta acá"*. La premisa es cierta y la conclusión no se sigue:
// una página se abre escribiendo su URL.
//
// ── QUÉ VIGILA ESTE ARCHIVO, y qué no ───────────────────────────────────────────────────────────
//
// Vigila que las tres superficies deriven del mismo gate y que la página falle CERRADO. Lo hace en dos
// registros a propósito: comportamiento (la página tira `notFound` con env ausente, live y basura) y
// forma (ninguna de las tres reimplementa el gate). Sin el segundo, alguien vuelve a copiar la función
// y el candado sigue verde porque el COMPORTAMIENTO coincide — es la misma trampa que un guard que
// compara dos valores que se mueven juntos.
//
// ⚠️ NO vigila que no aparezca una CUARTA superficie con su propio gate. Los tres sitios están
// nombrados abajo a mano; un cuarto hay que agregarlo acá.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const leer = (rel: string): string => readFileSync(join(RAIZ, rel), "utf8");

const SUPERFICIES = [
  "app/kyc-simulado/page.tsx",
  "app/api/mock-didit/v3/session/route.ts",
  "app/api/mock-didit/v3/session/[sessionId]/decision/route.ts",
] as const;

describe("candado · la superficie de prueba de Didit se apaga entera y desde un solo lugar", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // ── Comportamiento: la página falla CERRADO en los tres inputs que no son "mock" ───────────────
  // Los tres se prueban por separado y no con un `||`: "ausente", "live" y "typo" son entradas
  // distintas y una implementación puede acertar en dos y errar en la tercera. Un `it.each` mantiene
  // separado el motivo de cada rojo.
  // 🔴 WKH-233/DT-9 — CAMBIAN EL PATH DEL IMPORT Y LA ENV STUBBEADA, Y NADA MÁS. El módulo se mudó a
  // `src/infrastructure/mock-surface.ts` (el directorio del proveedor se borró entero) y dejó de
  // colgar del ambiente del proveedor: ahora lee su PROPIA env. Las cuatro aserciones TEXTUALES de
  // más abajo son el candado y NO se tocan: siguen valiendo exactamente igual.
  //
  // ⚠️ Y LA LISTA DE INPUTS SE AMPLÍA, porque la env nueva tiene formas de fallar que la vieja no
  // tenía: `"TRUE"`, `"1"` y `" true"` con espacio. Los tres apagan. El único encendido es el literal
  // exacto — ⛔ un `!== "false"` los encendería a los tres y es el mutante que esto mata.
  it.each([
    ["ausente", undefined],
    ["false", "false"],
    ["un typo", "tru"],
    ["TRUE en mayúsculas", "TRUE"],
    ["1", "1"],
    ["true con un espacio delante", " true"],
  ])("T-GATE-1/T-MOCK-2: con MOCK_KYC_SURFACE_ENABLED %s la página NO existe", async (_caso, valor) => {
    vi.stubEnv("MOCK_KYC_SURFACE_ENABLED", valor as string);
    vi.resetModules();
    const { mockDiditSurfaceEnabled } = await import("../../src/infrastructure/mock-surface");
    expect(mockDiditSurfaceEnabled()).toBe(false);
  });

  it("T-GATE-2: con MOCK_KYC_SURFACE_ENABLED=true (el literal exacto) la superficie SÍ está encendida", async () => {
    vi.stubEnv("MOCK_KYC_SURFACE_ENABLED", "true");
    vi.resetModules();
    const { mockDiditSurfaceEnabled } = await import("../../src/infrastructure/mock-surface");
    expect(mockDiditSurfaceEnabled()).toBe(true);
  });

  // ── Forma: la página realmente CONSULTA el gate y corta antes de renderizar ────────────────────
  it("T-GATE-3: la página llama al gate y hace notFound()", () => {
    const src = leer("app/kyc-simulado/page.tsx");
    expect(src).toContain("mockDiditSurfaceEnabled");
    expect(src).toContain("notFound()");
    expect(src).toMatch(/if\s*\(!mockDiditSurfaceEnabled\(\)\)\s*notFound\(\)/);
  });

  // ── Forma: el gate se evalúa POR REQUEST y no al compilar ─────────────────────────────────────
  // Sin `force-dynamic`, `npm run build` marcaba esta ruta `○ (Static)`: el gate corría con el
  // `DIDIT_ENV` del build y quedaba horneado. Un operador que pasa la env a `live` no cerraría la
  // página hasta rebuildear, o sea que apagarla no la apagaría. Esto es sobre el TEXTO porque el
  // comportamiento sólo se distingue construyendo, y construir no es algo que un test unitario haga.
  it("T-GATE-5: la página es dinámica, así el gate corre en cada request", () => {
    const src = leer("app/kyc-simulado/page.tsx");
    expect(src).toMatch(/export const dynamic\s*=\s*["']force-dynamic["']/);
  });

  // ── Forma: nadie reimplementa el gate ─────────────────────────────────────────────────────────
  it.each(SUPERFICIES)("T-GATE-4: %s deriva el gate, no lo reimplementa", (rel) => {
    const src = leer(rel);
    expect(src).toContain("mockDiditSurfaceEnabled");
    // Una copia privada de la función es el estado del que venimos: tres implementaciones y una
    // superficie sin ninguna.
    expect(src).not.toMatch(/function\s+mockEnabled\s*\(/);
    // Y nadie compara el ambiente a mano por su lado, que es la otra forma de la misma copia.
    expect(src).not.toMatch(/resolveDiditEnvironment\(\)\s*===\s*["']mock["']/);
  });
});
