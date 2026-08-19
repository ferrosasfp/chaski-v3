// Mock de Didit — creación de sesión. Calca `POST {base}/v3/session/` del host real.
//
// ⚠️ QUÉ ES Y QUÉ NO ES. Esto NO verifica la identidad de nadie: acepta lo que le mandan y devuelve
// una sesión que siempre termina aprobada. Existe para que se pueda recorrer la app de punta a punta
// sin que una persona real escanee un documento real. Didit **no publica un host de sandbox** (ver
// `src/infrastructure/didit/didit-env.ts`), así que el único modo de prueba que no consume cuota ni
// PII es un endpoint nuestro, y este es ese endpoint.
//
// 🔴 POR QUÉ NO PUEDE HACERSE PASAR POR REAL. La decisión que sale de acá se etiqueta
// `didit-mock` (`mapDiditDecision` toma el ambiente declarado), y `didit-mock` NO está en
// `REAL_KYC_PROVENANCES` del agente de desembolso, que es la única rama que abre un payout real.
// La etiqueta no la elige esta ruta: la elige el ambiente con el que se resolvió el host, así que no
// hay forma de que el host sea el mock y la etiqueta diga otra cosa.
//
// SE APAGA SOLO. Sin `DIDIT_ENV=mock` esta ruta responde 404: no queda colgando en un despliegue que
// habla con el Didit real. Un mock alcanzable en un entorno que se cree productivo es peor que no
// tenerlo, porque el 404 es lo que hace verificable que está apagado.
import { NextResponse } from "next/server";
// El gate vive en UN solo lugar y lo comparten esta ruta y `app/kyc-simulado/page.tsx`. Cuando estaba
// acá adentro como función privada, la página no lo tenía y respondía con cualquier `DIDIT_ENV`: el
// principio de esta cabecera se cumplía a medias sin que nada lo notara.
import { mockDiditSurfaceEnabled } from "../../../../../src/infrastructure/mock-surface";

export async function POST(req: Request): Promise<Response> {
  if (!mockDiditSurfaceEnabled()) {
    return NextResponse.json({ error: "mock_didit_disabled" }, { status: 404 });
  }

  // El host real exige `x-api-key`. Se exige acá también, no por seguridad (el valor no se compara
  // contra nada) sino para que el mock falle donde fallaría el real: un cliente que se olvide del
  // header tiene que romperse en el mock, no descubrirlo recién en producción.
  if (!req.headers.get("x-api-key")) {
    return NextResponse.json({ error: "missing_api_key" }, { status: 401 });
  }

  const body: unknown = await req.json().catch(() => ({}));
  const vendorData =
    typeof body === "object" && body !== null && typeof (body as { vendor_data?: unknown }).vendor_data === "string"
      ? (body as { vendor_data: string }).vendor_data
      : "";

  // 🔴 EL ESTADO VIAJA DENTRO DEL ID, y no es capricho: la ruta de decisión de la app llama a
  // `{base}/v3/session/{id}/decision/` SIN query params ni body, así que el id es literalmente lo
  // único que el mock va a recibir. Si el instante de creación y el `vendor_data` no viajan ahí, la
  // decisión no puede saber cuánto pasó ni a quién pertenece la verificación, y el ownership check
  // (WKH-180) se quedaría sin su insumo.
  //
  // Formato: `mock.<epoch_ms>.<base64url(vendor_data)>.<random>`. Los puntos y base64url son seguros
  // en un segmento de path. El prefijo `mock` va primero para que cualquier log, tabla o pantalla en
  // la que aparezca se lea como simulada sin cruzarla con ninguna config.
  const vendorB64 = Buffer.from(vendorData, "utf8").toString("base64url");
  const sessionId = `mock.${Date.now()}.${vendorB64}.${crypto.randomUUID().slice(0, 8)}`;

  // `url` es la página que en el flujo real abre Didit para escanear. Acá abre la nuestra, que
  // dice en pantalla que es simulada. `vendor_data` viaja para que la decisión pueda ecoarlo: es la
  // dirección del sender y es la base del ownership check (WKH-180).
  const origin = new URL(req.url).origin;
  const url = `${origin}/kyc-simulado?session=${encodeURIComponent(sessionId)}&vendor=${encodeURIComponent(vendorData)}`;

  return NextResponse.json({ session_id: sessionId, url });
}
