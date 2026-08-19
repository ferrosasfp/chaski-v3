// Mock de Didit — decisión de una sesión. Calca `GET {base}/v3/session/{id}/decision/`.
//
// Devuelve el shape crudo que `mapDiditDecision` sabe leer. NO devuelve nuestro modelo ya mapeado:
// el mock tiene que hablar el idioma del proveedor, o dejaría sin ejercitar justo el mapeo, que es
// donde vivirían los bugs de forma.
//
// ⏱️ POR QUÉ NO APRUEBA AL INSTANTE. El estado vive en el `session_id` (la ruta corre sin memoria
// compartida entre invocaciones), y la aprobación se decide por tiempo transcurrido desde que la
// sesión se creó. Podría devolver `Approved` en la primera llamada y sería más simple, pero
// entonces el bucle de reintento de la app (`RESUME_MAX_POLLS`, `RESUME_POLL_INTERVAL_MS`, el botón
// de escape a los 5 s) NUNCA se ejercitaría al recorrer el flujo: es código de producción real y la
// única forma de verlo funcionar es que el proveedor tarde. Acá tarda, a propósito.
//
// 🔴 La decisión que sale de acá se etiqueta `didit-mock` aguas arriba, porque `mapDiditDecision`
// toma el ambiente con el que se resolvió el host. No hay ninguna forma de que esta ruta se
// etiquete como verificación real: no elige su etiqueta.
import { NextResponse } from "next/server";
// Mismo gate que las otras dos superficies del mock, desde el MISMO lugar. Había TRES copias privadas
// de esta función y una de las tres superficies —`app/kyc-simulado/page.tsx`— no tenía ninguna.
import { mockDiditSurfaceEnabled } from "../../../../../../../src/infrastructure/mock-surface";

/** Cuánto "tarda" la verificación simulada. Corto, pero suficiente para ver el bucle de espera. */
const MOCK_VERIFICATION_MS = 6_000;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  if (!mockDiditSurfaceEnabled()) {
    return NextResponse.json({ error: "mock_didit_disabled" }, { status: 404 });
  }
  if (!req.headers.get("x-api-key")) {
    return NextResponse.json({ error: "missing_api_key" }, { status: 401 });
  }

  const { sessionId } = await ctx.params;
  // Todo lo que este endpoint sabe viene del id: la app llama sin query params ni body. Formato
  // emitido por `POST /v3/session/`: `mock.<epoch_ms>.<base64url(vendor_data)>.<random>`.
  const parts = sessionId.split(".");
  // Sólo se responde por sesiones que este mock pudo haber emitido. Un id cualquiera no obtiene una
  // aprobación: si la sesión no es nuestra, no sabemos nada de ella y eso se dice.
  if (parts[0] !== "mock" || parts.length < 4) {
    return NextResponse.json({ error: "unknown_session" }, { status: 404 });
  }

  const createdAt = Number(parts[1]);
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    // Un id con el prefijo correcto pero el instante ilegible NO se aprueba por las dudas. Si no
    // podemos fechar la sesión, no podemos decir que terminó.
    return NextResponse.json({ error: "unknown_session" }, { status: 404 });
  }
  let vendorData = "";
  try {
    vendorData = Buffer.from(parts[2] ?? "", "base64url").toString("utf8");
  } catch {
    vendorData = "";
  }

  if (Date.now() - createdAt < MOCK_VERIFICATION_MS) {
    // Estado NO terminal, igual que el real mientras procesa. La app reintenta.
    return NextResponse.json({ status: "In Progress", session_id: sessionId, vendor_data: vendorData });
  }

  return NextResponse.json({
    status: "Approved",
    session_id: sessionId,
    vendor_data: vendorData,
    risk_level: "low",
    id_verifications: [
      {
        // Datos evidentemente simulados. Nada acá se parece a una persona real, y el número de
        // documento son ceros: si esto termina en una pantalla o un log, se lee que es de prueba.
        first_name: "VERIFICACION",
        last_name: "SIMULADA",
        last_name_2: "NO REAL",
        document_type: "DNI",
        document_number: "00000000",
        date_of_birth: "1990-01-01",
      },
    ],
  });
}
