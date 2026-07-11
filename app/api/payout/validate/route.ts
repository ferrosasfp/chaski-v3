// Server-side: AUTORIDAD del payout (WKH-180). Re-consulta la decisión REAL de Didit
// (GET /v3/session/{id}/decision/, x-api-key server-only) y devuelve SOLO { authorized, reason }
// — cero PII (CD-A8). Es la única fuente de verdad para autorizar: nunca los booleanos del browser
// (approved/payoutAllowed en localStorage son forjables — CD-2). Guard-order (CD-A1):
//   sin key + prod → 503 fail-loud (nunca autoriza por default — CD-4)
//   sin key + no-prod → simulación { authorized:true } (el demo sigue andando)
//   con key → formato → Didit → mapeo → ownership (vendor_data vs address)
// Nunca fetch a Didit antes de pasar los guards.
import { NextResponse } from "next/server";
import { mapDiditDecision } from "../../../../src/infrastructure/didit/decision";

const BASE = process.env.DIDIT_BASE_URL ?? "https://verification.didit.me";

export async function POST(req: Request): Promise<Response> {
  const apiKey = process.env.DIDIT_API_KEY;
  const isProd = (process.env.VERCEL_ENV ?? "") === "production";

  const body = (await req.json().catch(() => ({}))) as {
    verificationId?: unknown;
    address?: unknown;
  };
  const verificationId = typeof body.verificationId === "string" ? body.verificationId : "";
  const address = typeof body.address === "string" ? body.address : "";

  // Guard 1: SIN key.
  if (!apiKey) {
    if (isProd) {
      // fail-loud (AC-3, CD-4): prod sin key NUNCA autoriza silenciosamente. fetch NO se llama.
      return NextResponse.json(
        { authorized: false, reason: "kyc_authority_unavailable" },
        { status: 503 },
      );
    }
    // no-prod: simulación (AC-4). fetch NO se llama. El demo local llega a "Entregado".
    if (!verificationId.trim()) {
      return NextResponse.json(
        { authorized: false, reason: "invalid_verification_id" },
        { status: 400 },
      );
    }
    return NextResponse.json({ authorized: true, reason: "simulated_dev" }, { status: 200 });
  }

  // Guard 2: FORMATO (AC-5). fetch NO se llama con id vacío/malformado.
  if (!verificationId.trim()) {
    return NextResponse.json(
      { authorized: false, reason: "invalid_verification_id" },
      { status: 400 },
    );
  }

  // Didit: re-consulta la decisión REAL (CD-A2: key + fetch solo acá, server runtime).
  // fail-closed EXPLÍCITO (MNR-A): un throw del fetch (timeout de AbortSignal, DNS, connection
  // reset) o un JSON malformado NUNCA debe escapar como 500 crudo — el adapter asume que el body
  // SIEMPRE trae { authorized, reason } incluso en 5xx. Todo el bloque fetch+mapeo+decisión va en
  // try/catch → en el catch devolvemos 502 { authorized:false, kyc_reauth_failed } (mismo reason
  // que !res.ok). Nunca autoriza ante un fallo de la autoridad (CD-4).
  try {
    const res = await fetch(
      `${BASE}/v3/session/${encodeURIComponent(verificationId)}/decision/`,
      { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      return NextResponse.json(
        { authorized: false, reason: "kyc_reauth_failed" },
        { status: 502 },
      );
    }

    const d = mapDiditDecision(await res.json());

    // Solo "Approved" autoriza (CD-A5: reusa mapDiditDecision, no re-implementa status → approved).
    if (d.status !== "Approved") {
      return NextResponse.json(
        { authorized: false, reason: "kyc_not_approved" },
        { status: 200 },
      );
    }

    // Ownership best-effort: vendor_data (= senderAddress) vs address del caller (case-insensitive,
    // direcciones EVM). Si Didit NO eco-a vendor_data (d.vendorData === "") → se omite (residual documentado).
    // MNR-B: este binding ownership solo tiene FUERZA REAL cuando `address` proviene de un caller
    // AUTENTICADO (sesión firmada / SIWE) — no de este endpoint público, donde `address` y
    // `vendor_data` son ambos caller-controlados, así que un replay de un verificationId Approved
    // robado con address=vendorData (dato conocido) pasaría este check. En el money-path real el
    // address viene del wallet conectado, así que el riesgo hoy es nulo (+ payout mock). El check
    // queda como defensa best-effort; el hardening completo (binding a sesión firmada) = follow-up.
    if (d.vendorData !== "" && d.vendorData.toLowerCase() !== address.toLowerCase()) {
      return NextResponse.json(
        { authorized: false, reason: "kyc_ownership_mismatch" },
        { status: 200 },
      );
    }

    return NextResponse.json({ authorized: true }, { status: 200 });
  } catch {
    // fetch throw (timeout/DNS/reset) o JSON malformado → 502 fail-closed, misma forma que !res.ok.
    return NextResponse.json(
      { authorized: false, reason: "kyc_reauth_failed" },
      { status: 502 },
    );
  }
}
