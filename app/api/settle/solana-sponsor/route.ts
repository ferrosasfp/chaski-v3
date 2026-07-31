// Server-side: broadcast del `deposit` Solana no-custodial (HU-SOL-13/AC-1, CD-6). Reenvía la tx
// partial-firmada por la wallet al facilitator (POST {FACILITATOR_BASE_URL}/solana/sponsor de
// HU-SOL-14), que la cofirma con el feePayer y la broadcastea (gasless). El browser NUNCA llama al
// facilitator directo: el Authorization Bearer se añade ACÁ, server-side (CD-6).
//
// TODO en guards fail-closed: nunca 500 crudo, nunca se ecoa el motivo del facilitador (CD-12
// no-oracle), nunca se expone la API key / base URL al cliente (CD-6). Guard-order: flag → config →
// body → formato → forward → map.
import { NextResponse } from "next/server";
import { getSettlementLedger } from "../../../../src/infrastructure/persistence/supabase-settlement-ledger";
import { logLedgerWriteFailure } from "../../../../src/infrastructure/persistence/ledger-write-failure";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// base58 (alfabeto Solana): sin 0, O, I, l. sender/reference son pubkeys base58 (32 bytes ⇒ 43-44 chars).
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;
// base64 estándar (partialSignedTx serializada).
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export async function POST(req: Request): Promise<Response> {
  // S1 — PRIMER guard. CD-5: la HU construye, NO enciende. Flag OFF ⇒ 501 (ningún forward).
  if (process.env.NEXT_PUBLIC_SOLANA_SETTLE_ENABLED !== "true") {
    return NextResponse.json({ error: "solana_settle_not_enabled" }, { status: 501 });
  }
  // S2 — sin backend del facilitador no hay a quién reenviar. Las creds viven SOLO acá (CD-6),
  // leídas en runtime; nunca se ecoan.
  const BASE = process.env.FACILITATOR_BASE_URL;
  const KEY = process.env.FACILITATOR_API_KEY;
  if (!BASE || !KEY) {
    return NextResponse.json({ error: "solana_settle_not_configured" }, { status: 501 });
  }

  // S3 — body null-safe (req.json() RESUELVE `null` con el body literal `null` → el .catch NO dispara).
  const parsed: unknown = await req.json().catch(() => null);
  if (!isRecord(parsed)) {
    return NextResponse.json({ error: "solana_settle_invalid_request" }, { status: 400 });
  }
  const { partialSignedTx, reference, sender, remittanceId, popProof } = parsed;
  if (
    typeof partialSignedTx !== "string" ||
    !BASE64.test(partialSignedTx) ||
    typeof reference !== "string" ||
    !BASE58.test(reference) ||
    typeof sender !== "string" ||
    !BASE58.test(sender) ||
    typeof remittanceId !== "string" ||
    !remittanceId.trim()
  ) {
    return NextResponse.json({ error: "solana_settle_invalid_request" }, { status: 400 });
  }
  // popProof: el /solana/sponsor de HU-SOL-14 lo exige (z.string().min(1)). La provisión real (HU-SOL-8)
  // y su wire-format son founder-gated ([NC-2]); acá se forwardea tal cual (fail-closed en el facilitator
  // si falta). Sólo se envía si vino como string.
  const forwardBody: Record<string, unknown> = { partialSignedTx, reference, sender, remittanceId };
  if (typeof popProof === "string" && popProof.trim()) forwardBody.popProof = popProof;

  // S4 — FORWARD. El Bearer se añade ACÁ (CD-6). try/catch: timeout/DNS/parse ⇒ 502 opaco, NUNCA 500
  // crudo, NUNCA ecoa BASE/KEY ni el motivo del facilitador.
  let res: Response;
  try {
    res = await fetch(`${BASE}/solana/sponsor`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(forwardBody),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return NextResponse.json({ error: "solana_settle_unavailable" }, { status: 503 });
  }

  if (!res.ok) {
    // Map fail-closed sin ecoar el cuerpo del facilitador (CD-12 no-oracle).
    const status =
      res.status === 422
        ? 422 // SPONSOR_REJECTED (CR-1 del deposit)
        : res.status === 429
          ? 429
          : res.status === 409 || res.status === 502
            ? 502 // blockhash expirado / broadcast falló
            : 503; // 5xx/otro ⇒ unavailable
    const error =
      status === 422
        ? "solana_settle_rejected"
        : status === 429
          ? "solana_settle_rate_limited"
          : status === 502
            ? "solana_settle_broadcast_failed"
            : "solana_settle_unavailable";
    return NextResponse.json({ error }, { status });
  }

  // S5 — 200: extrae SÓLO la signature base58 (hecho público). NUNCA la key/base URL/tx cruda.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return NextResponse.json({ error: "solana_settle_broadcast_failed" }, { status: 502 });
  }
  const signature = isRecord(body) && typeof body.signature === "string" ? body.signature : "";
  if (!BASE58.test(signature)) {
    return NextResponse.json({ error: "solana_settle_broadcast_failed" }, { status: 502 });
  }

  // ── WKH-213/R3: persistencia server-side ADITIVA (best-effort), espeja settle/principal:252-288. ──
  // Sin esto el settle NUNCA escribía al ledger: la remesa nacía 'prepared' en /api/payout/prepare y
  // moría 'prepared' (ninguna otra escritura la tocaba), así que la signature verificada on-chain no
  // llegaba a ninguna superficie.
  // Flag-gated: getSettlementLedger() es null con el flag OFF/envs ausentes ⇒ SKIP TOTAL ⇒ respuesta
  // byte-idéntica. En su PROPIO try/catch: la DB NUNCA rompe el money-path (CD-17). Va DESPUÉS de
  // validar la signature: sólo se persiste evidencia que ya pasó el shape-check (CD-13).
  const ledger = getSettlementLedger();
  if (ledger) {
    try {
      await ledger.recordSolanaPrincipalIn({ remittanceId, senderAddress: sender, signature });
    } catch (e) {
      // best-effort, NUNCA rompe (CD-17) — control de flujo INTACTO, sólo cambia la señal.
      logLedgerWriteFailure("recordSolanaPrincipalIn", e);
    }
  }

  return NextResponse.json({ signature }, { status: 200 });
}
