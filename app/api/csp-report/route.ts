// Recibe los reportes de violación de Content-Security-Policy que manda el navegador.
//
// Escribe una línea por violación en el log del servidor y responde 204. NO guarda en base, NO
// devuelve nada al cliente y NO decide nada: existe para que la política definitiva se arme con lo
// que el navegador dice que habría bloqueado, en vez de con una lista de dominios escrita a mano.
//
// ⚠️ ES PÚBLICO Y SIN AUTENTICAR, porque el navegador lo llama sin credenciales — así funciona
// `report-uri`. O sea que cualquiera puede postearle basura. Por eso: se acota cuántos reportes se
// procesan, se truncan los campos, y NADA de lo que llega acá alimenta una decisión. Un atacante
// puede ensuciar el log; no puede mover la política.
//
// ⚠️ ESTE ARCHIVO SÓLO PUEDE EXPORTAR `POST` Y LA CONFIG. Next valida los exports de un `route.ts`
// EN EL BUILD, no en runtime: exportar un helper da `"X" is not a valid Route export field` y el
// despliegue queda en ERROR. Por eso el parseo vive en
// `src/infrastructure/security/csp-report-parse.ts`, donde además se puede testear.
import { NextResponse } from "next/server";
import { extraerViolaciones, lineaDeLog } from "../../../src/infrastructure/security/csp-report-parse";

// El endpoint tiene que recibir de verdad en cada request; sin esto Next puede prerenderizarlo.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let cuerpo: unknown;
  try {
    cuerpo = await request.json();
  } catch {
    // Un cuerpo ilegible se acepta en silencio: devolver 4xx haría que el navegador reintente y
    // ensucie más. 204 corta el ciclo.
    return new NextResponse(null, { status: 204 });
  }

  for (const v of extraerViolaciones(cuerpo)) {
    console.warn(lineaDeLog(v));
  }

  // 204 siempre: el navegador no espera cuerpo y no hay nada que contarle a quien reporta.
  return new NextResponse(null, { status: 204 });
}
