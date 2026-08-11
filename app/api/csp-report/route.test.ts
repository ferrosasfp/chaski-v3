// Candado del receptor de reportes de CSP.
//
// Lo que vigila: que se acepten LOS DOS formatos que mandan los navegadores. Aceptar sólo uno no da
// un error visible — da MENOS REPORTES, y menos reportes se leen como "no hubo violaciones". Ese es
// el modo de falla que importa acá: un endpoint que parece funcionar y que hace la medición mentir.
//
// Y que el endpoint, que es público y sin autenticar por diseño (el navegador lo llama sin
// credenciales), no se pueda usar para nada: siempre 204, cuerpos acotados, y nada de lo que llega
// alimenta una decisión.
import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";
// Los helpers NO pueden vivir en el `route.ts`: Next valida los exports de una ruta EN EL BUILD y
// cualquier export extra lo deja en ERROR. Medido el 2026-08-11: la suite y `tsc` en verde, el
// despliegue caído. Viven en su propio módulo, que además es testeable.
import {
  extraerViolaciones,
  resumirViolacion,
} from "../../../src/infrastructure/security/csp-report-parse";

/** Acceso al primer elemento sin `!`: con `noUncheckedIndexedAccess` el índice puede ser undefined,
 *  y un `!` acá esconde el caso en que `extraerViolaciones` devuelve vacío — que es justo el bug que
 *  estos tests buscan. Fallar con un mensaje claro es mejor que fallar con "cannot read of undefined". */
function primera<T>(xs: readonly T[]): T {
  if (xs.length === 0) throw new Error("se esperaba al menos un elemento y la lista vino vacía");
  return xs[0] as T;
}

const post = (cuerpo: unknown): Request =>
  new Request("https://ejemplo.test/api/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report" },
    body: JSON.stringify(cuerpo),
  });

describe("candado · receptor de reportes de CSP", () => {
  // ── Los dos formatos ─────────────────────────────────────────────────────────────────────────
  it("T-RPT-1: formato clásico `report-uri` — { 'csp-report': {...} }", () => {
    const v = extraerViolaciones({
      "csp-report": { "violated-directive": "connect-src", "blocked-uri": "wss://api.devnet.solana.com" },
    });
    expect(v).toHaveLength(1);
    expect(resumirViolacion(primera(v))).toMatchObject({
      directiva: "connect-src",
      bloqueado: "wss://api.devnet.solana.com",
    });
  });

  it("T-RPT-2: formato Reporting API — un array de { type, body }", () => {
    const v = extraerViolaciones([
      { type: "csp-violation", body: { effectiveDirective: "script-src", blockedURL: "inline" } },
    ]);
    expect(v).toHaveLength(1);
    expect(resumirViolacion(primera(v))).toMatchObject({ directiva: "script-src", bloqueado: "inline" });
  });

  it("T-RPT-3: en el array se descartan los reportes que NO son de CSP", () => {
    const v = extraerViolaciones([
      { type: "deprecation", body: { id: "x" } },
      { type: "csp-violation", body: { effectiveDirective: "img-src" } },
    ]);
    expect(v).toHaveLength(1);
    expect(resumirViolacion(primera(v)).directiva).toBe("img-src");
  });

  it("T-RPT-4: un cuerpo pelado (sin envoltorio) también se acepta", () => {
    expect(extraerViolaciones({ "violated-directive": "font-src" })).toHaveLength(1);
  });

  it.each([
    ["null", null],
    ["un número", 7],
    ["un objeto sin nada útil", { hola: "mundo" }],
    ["un array vacío", []],
  ])("T-RPT-5: %s no produce violaciones", (_caso, cuerpo) => {
    expect(extraerViolaciones(cuerpo)).toEqual([]);
  });

  // ── Acotado: es un endpoint público ──────────────────────────────────────────────────────────
  it("T-RPT-6: un array gigante se procesa acotado, no entero", () => {
    const muchos = Array.from({ length: 5000 }, () => ({
      type: "csp-violation",
      body: { effectiveDirective: "img-src" },
    }));
    expect(extraerViolaciones(muchos).length).toBeLessThanOrEqual(20);
  });

  it("T-RPT-7: un campo enorme se trunca antes de loguearlo", () => {
    const largo = `data:image/png;base64,${"A".repeat(50_000)}`;
    const r = resumirViolacion({ "blocked-uri": largo, "violated-directive": "img-src" });
    const bloqueado = r.bloqueado ?? "";
    expect(bloqueado.length).toBeGreaterThan(0);
    expect(bloqueado.length).toBeLessThan(400);
    expect(bloqueado.endsWith("…")).toBe(true);
  });

  // ── Siempre 204, incluso con basura ──────────────────────────────────────────────────────────
  it("T-RPT-8: un cuerpo válido responde 204 sin cuerpo", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(post({ "csp-report": { "violated-directive": "connect-src" } }));
    expect(res.status).toBe(204);
    expect(spy).toHaveBeenCalledOnce();
    expect(primera(primera(spy.mock.calls))).toContain("[csp-report]");
    spy.mockRestore();
  });

  it("T-RPT-9: un JSON ilegible responde 204 y NO 4xx — un 4xx haría reintentar al navegador", async () => {
    const req = new Request("https://ejemplo.test/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: "{{{ esto no es json",
    });
    const res = await POST(req);
    expect(res.status).toBe(204);
  });

  // ── El gate corre por request ────────────────────────────────────────────────────────────────
  // Sin `force-dynamic` Next puede prerenderizar la ruta y el endpoint deja de recibir de verdad.
  it("T-RPT-10: la ruta es dinámica", async () => {
    const mod = await import("./route");
    expect((mod as { dynamic?: string }).dynamic).toBe("force-dynamic");
  });

  // ── Forma: la ruta NO exporta nada que Next rechace ─────────────────────────────────────────
  // Este candado existe porque el defecto que rompió el despliegue del 2026-08-11 era invisible para
  // la suite Y para `tsc`: sólo lo caza `next build`. Acá se vigila la CONDICIÓN (qué exporta el
  // módulo) en vez de esperar el build, que tarda minutos y corre en otra máquina.
  it("T-RPT-11: la ruta sólo exporta handlers y config — un export extra rompe el BUILD", async () => {
    const mod = await import("./route");
    const PERMITIDOS = new Set([
      "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
      "dynamic", "dynamicParams", "revalidate", "fetchCache", "runtime",
      "preferredRegion", "maxDuration", "generateStaticParams",
    ]);
    const extras = Object.keys(mod).filter((k) => !PERMITIDOS.has(k));
    expect(extras).toEqual([]);
  });
});
