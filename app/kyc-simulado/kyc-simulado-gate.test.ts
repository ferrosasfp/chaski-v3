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

  // ── COMPORTAMIENTO: la página CORTA. Y esto ya no se lee del fuente ────────────────────────────
  //
  // ⛔ ACÁ VIVÍA `T-GATE-3`, Y ERA UN `toMatch` SOBRE EL TEXTO DEL ARCHIVO (WKH-233 fix-pack · H-12).
  // Sus tres aserciones —`toContain("notFound()")` y
  // `toMatch(/if\s*\(!mockDiditSurfaceEnabled\(\)\)\s*notFound\(\)/)`— verificaban que la LÍNEA
  // estuviera escrita, nunca que hiciera algo. Un `notFound` importado de otro lado, un `if` invertido
  // por un typo en el gate, o la línea entera dentro de un bloque muerto: los tres pasan ese regex.
  // Lo reemplaza esto, que llama a la función y mira qué pasa.
  //
  // 🔴 Y ACÁ VA EL LÍMITE, MEDIDO Y DECLARADO EN VEZ DE PROMETIDO. La cabecera de la página decía que
  // `notFound()` produce *"la misma respuesta observable que la ruta hermana"*, o sea un 404. **Es
  // FALSO en esta app, y no por culpa de esta página.** Medido el 2026-08-20 contra un build local de
  // este árbol, con un centinela que prueba que el servidor servía ESE build:
  //
  //     GET /kyc-simulado          (gate apagado)              ⇒ 200, cuerpo del not-found de Next
  //     GET /ruta-que-no-existe    (control)                   ⇒ 404
  //     POST /api/mock-didit/v3/session (la ruta hermana)      ⇒ 404 {"error":"mock_didit_disabled"}
  //     GET /zz-probe-a  (sonda: `force-dynamic` + `notFound()` y NADA más)  ⇒ 200
  //     GET /zz-probe-b  (sonda: página prerenderizada + `notFound()`)       ⇒ 200
  //
  // Las dos sondas se borraron después de medir. Lo que dicen es que **ninguna página de esta app
  // devuelve 404 desde `notFound()`**, tenga `force-dynamic` o no: el status ya está comprometido
  // cuando el árbol se resuelve. No es algo que esta página pueda arreglar sola, y arreglarlo de
  // verdad (un `middleware.ts`) es infraestructura nueva que este fix-pack no trae. ⇒ Se declara.
  //
  // ⚠️ QUÉ SÍ ESTÁ GARANTIZADO, Y ES LO QUE ESTE `it` MIDE: con el gate apagado la página **no
  // renderiza su contenido** —corta con la señal de 404 del framework antes de leer los parámetros—,
  // así que el simulador no se muestra. Lo que NO está garantizado es el STATUS. Y el 200 importa:
  // un monitor externo que pregunte "¿está apagado?" mirando el código HTTP va a leer que NO.
  // ⛔ PROHIBIDO reescribir esto como "responde 404" mientras no haya una medición que lo sostenga.
  //
  // ⚠️ Y LO QUE ESTA MEDICIÓN NO CUBRE: se hizo con `next start` local. En Vercel la respuesta pasa
  // además por su capa de routing. Al 2026-08-20 prod devuelve lo MISMO (200 con el marcador
  // `BAILOUT_TO_CLIENT_SIDE_RENDERING` y sin el cuerpo del simulador), así que las dos coinciden hoy;
  // eso es una foto de un `curl`, no un invariante, y nada lo vigila.
  it("T-GATE-3': con el gate apagado la página CORTA con la señal de 404 (llamada, no leída)", async () => {
    vi.stubEnv("MOCK_KYC_SURFACE_ENABLED", undefined);
    vi.resetModules();
    const { default: KycSimuladoPage } = await import("./page");
    let err: unknown;
    try {
      await KycSimuladoPage({ searchParams: Promise.resolve({}) });
    } catch (e) {
      err = e;
    }
    // 🧬 MUTANTE: invertir el `if`, o borrar el `notFound()`, ⇒ la llamada RESUELVE ⇒ rojo acá. El
    // regex de antes seguía verde con el `if` invertido, porque la línea seguía escrita igual.
    expect(err, "la página renderizó el simulador con el gate apagado").toBeDefined();
    // Y no cualquier error: la señal de 404 del framework. Sin esto, un `throw` por un import roto
    // pasaría por "el gate funciona".
    expect((err as { digest?: string })?.digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  // 🧪 CONTROL POSITIVO, EN LA MISMA CORRIDA. Sin él, el `it` de arriba pasaría igual si la página
  // tirara SIEMPRE (un import roto, un typo en el gate que lo deje en `false` fijo): estaríamos
  // midiendo "esto explota" y llamándolo "el gate corta".
  it("T-GATE-3'(control): con el gate encendido la página SÍ renderiza", async () => {
    vi.stubEnv("MOCK_KYC_SURFACE_ENABLED", "true");
    vi.resetModules();
    const { default: KycSimuladoPage } = await import("./page");
    const out = await KycSimuladoPage({ searchParams: Promise.resolve({ session: "s-1" }) });
    expect(out, "la página no devolvió un elemento de React con el gate encendido").toBeTruthy();
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
