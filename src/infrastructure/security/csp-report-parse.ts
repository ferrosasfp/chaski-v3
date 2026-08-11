// Normaliza los reportes de violación de CSP que manda el navegador.
//
// ── POR QUÉ VIVE ACÁ Y NO EN LA `route.ts` ──────────────────────────────────────────────────────
//
// Un archivo `route.ts` de Next SÓLO puede exportar handlers (`GET`, `POST`, …) y su config
// (`dynamic`, `revalidate`, …). Exportar cualquier otra cosa **rompe el build**, no el runtime:
//   Type error: "extraerViolaciones" is not a valid Route export field
//
// Medido el 2026-08-11 de la peor manera: la primera versión tenía los helpers exportados desde la
// ruta, la suite y `tsc` pasaron en verde, y el despliegue quedó en ERROR. `npm run qa` NO corre
// `next build`, así que el verde local no cubría la validación que sí falla. Si se quieren testear
// las funciones puras —y hay que testearlas, porque aceptar un solo formato de reporte se lee como
// "no hubo violaciones"— tienen que vivir en un módulo aparte.
//
// ── LOS DOS FORMATOS ────────────────────────────────────────────────────────────────────────────
//   · `application/csp-report`   → { "csp-report": { ... } }                (el clásico, `report-uri`)
//   · `application/reports+json` → [ { "type": "csp-violation", "body": {...} }, … ]  (Reporting API)
// Aceptar uno solo pierde los reportes de la mitad de los navegadores, y menos reportes se leen como
// ausencia de violaciones: una medición que miente en vez de faltar.

// Techo de reportes procesados por request. El endpoint es público y sin autenticar (así funciona
// `report-uri`: el navegador llama sin credenciales), así que un cuerpo con miles es abuso y
// recorrerlo entero es regalarle CPU. Un `reports+json` legítimo trae unos pocos.
export const MAX_REPORTES = 20;
// Techo por campo. Las URLs de violación pueden ser enormes (una `data:` URI completa) y no aportan
// nada después de los primeros caracteres.
export const MAX_CAMPO = 300;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function recortar(v: unknown): string | undefined {
  if (typeof v !== "string" || v === "") return undefined;
  return v.length > MAX_CAMPO ? `${v.slice(0, MAX_CAMPO)}…` : v;
}

/** Normaliza los dos formatos a una lista plana de cuerpos de violación. */
export function extraerViolaciones(cuerpo: unknown): Record<string, unknown>[] {
  if (Array.isArray(cuerpo)) {
    // El mismo endpoint podría recibir otros tipos de reporte (deprecation, intervention…).
    return cuerpo
      .slice(0, MAX_REPORTES)
      .filter(isRecord)
      .filter((r) => r.type === undefined || r.type === "csp-violation")
      .map((r) => (isRecord(r.body) ? r.body : r));
  }
  if (isRecord(cuerpo)) {
    const clasico = cuerpo["csp-report"];
    if (isRecord(clasico)) return [clasico];
    // Algunos navegadores postean el cuerpo pelado, sin envoltorio.
    if (cuerpo["violated-directive"] !== undefined || cuerpo.effectiveDirective !== undefined) {
      return [cuerpo];
    }
  }
  return [];
}

/** Los dos formatos nombran los mismos campos distinto. Esto los unifica para el log. */
export function resumirViolacion(v: Record<string, unknown>): Record<string, string | undefined> {
  return {
    directiva: recortar(v["effective-directive"] ?? v.effectiveDirective ?? v["violated-directive"]),
    bloqueado: recortar(v["blocked-uri"] ?? v.blockedURL ?? v.blockedURI),
    documento: recortar(v["document-uri"] ?? v.documentURL),
    disposicion: recortar(v.disposition),
  };
}

/** La línea que va al log. Prefijo estable para poder filtrarla en el proveedor. */
export function lineaDeLog(v: Record<string, unknown>): string {
  const r = resumirViolacion(v);
  return `[csp-report] directiva=${r.directiva ?? "?"} bloqueado=${r.bloqueado ?? "?"} documento=${r.documento ?? "?"} disposicion=${r.disposicion ?? "?"}`;
}
