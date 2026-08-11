// Recibe los reportes de violación de Content-Security-Policy que manda el navegador.
//
// ── QUÉ HACE Y QUÉ NO ───────────────────────────────────────────────────────────────────────────
//
// Escribe una línea por violación en el log del servidor y responde 204. NO guarda en base, NO
// devuelve nada al cliente y NO decide nada: existe para que la política definitiva se arme con lo
// que el navegador dice que habría bloqueado, en vez de con una lista de dominios escrita a mano.
//
// ⚠️ ES UN ENDPOINT PÚBLICO Y SIN AUTENTICAR, porque el navegador lo llama sin credenciales — así
// funciona `report-uri`. O sea que CUALQUIERA puede postearle basura. Por eso: se acota cuántos
// reportes se procesan por request, se truncan los campos antes de loguearlos, y NADA de lo que
// llega acá alimenta una decisión. Un atacante puede ensuciar el log; no puede mover la política.
//
// El navegador manda dos formatos distintos y hay que aceptar los dos, o se pierden los reportes de
// la mitad de los navegadores:
//   · `application/csp-report`   → { "csp-report": { ... } }        (el clásico, `report-uri`)
//   · `application/reports+json` → [ { "type": "csp-violation", "body": { ... } }, ... ]  (Reporting API)
import { NextResponse } from "next/server";

// El gate corre por request, no al compilar.
export const dynamic = "force-dynamic";

// Techo de reportes procesados por request. Un `reports+json` legítimo trae unos pocos; un cuerpo
// con miles es abuso, y recorrerlo entero es regalarle CPU.
const MAX_REPORTES = 20;
// Techo por campo. Las URLs de violación pueden ser enormes (data: URIs completas) y no aportan
// nada después de los primeros caracteres.
const MAX_CAMPO = 300;

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
    // Reporting API: se filtran los que no son de CSP (el mismo endpoint podría recibir otros tipos).
    return cuerpo
      .slice(0, MAX_REPORTES)
      .filter(isRecord)
      .filter((r) => r.type === undefined || r.type === "csp-violation")
      .map((r) => (isRecord(r.body) ? r.body : r));
  }
  if (isRecord(cuerpo)) {
    const clasico = cuerpo["csp-report"];
    if (isRecord(clasico)) return [clasico];
    // Algunos navegadores postean el cuerpo pelado.
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

export async function POST(request: Request): Promise<NextResponse> {
  let cuerpo: unknown;
  try {
    cuerpo = await request.json();
  } catch {
    // Un cuerpo ilegible no es un error del que reporta: se acepta en silencio. Devolver 4xx acá
    // haría que el navegador reintente y ensucie más.
    return new NextResponse(null, { status: 204 });
  }

  for (const v of extraerViolaciones(cuerpo)) {
    const r = resumirViolacion(v);
    // Una línea por violación, con prefijo estable para poder filtrarla en el log del proveedor.
    console.warn(
      `[csp-report] directiva=${r.directiva ?? "?"} bloqueado=${r.bloqueado ?? "?"} documento=${r.documento ?? "?"} disposicion=${r.disposicion ?? "?"}`,
    );
  }

  // 204 siempre: el navegador no espera cuerpo y no hay nada que contarle a quien reporta.
  return new NextResponse(null, { status: 204 });
}
