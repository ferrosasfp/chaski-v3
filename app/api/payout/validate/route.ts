// Server-side: AUTORIDAD del payout (WKH-180). Re-consulta la decisión REAL de Didit
// (GET /v3/session/{id}/decision/, x-api-key server-only) y devuelve SOLO { authorized, reason }
// — cero PII (CD-A8). Es la única fuente de verdad para autorizar: nunca los booleanos del browser
// (approved/payoutAllowed en localStorage son forjables — CD-2).
// WKH-202/DT-1: el guard-order vive ahora en src/infrastructure/payout/authority.ts, compartido con
// /api/a2a/payout/submit (dos copias divergirían). Esta route es un wrapper delgado: parsea el body
// (el parseo se queda ACÁ) y traduce la decisión a HTTP.
import { NextResponse } from "next/server";
import { resolvePayoutAuthority } from "../../../../src/infrastructure/payout/authority";

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    verificationId?: unknown;
    address?: unknown;
  };
  const verificationId = typeof body.verificationId === "string" ? body.verificationId : "";
  const address = typeof body.address === "string" ? body.address : "";

  // rest-spread (NO un objeto literal): la rama Approved+ownership-ok devuelve { authorized:true }
  // SIN la clave `reason`. Un literal la reintroduciría como `reason: undefined` → rompería el
  // toEqual del test (CD-10: comportamiento observable byte-idéntico).
  const { httpStatus, ...rest } = await resolvePayoutAuthority({ verificationId, address });
  return NextResponse.json(rest, { status: httpStatus });
}
