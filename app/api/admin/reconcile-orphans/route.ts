// Server-side: reconciliación de remesas huérfanas (WKH-207, AC-4/AC-6/AC-7). Endpoint ADMIN
// protegido por secreto compartido: detecta settlements varados (settle verificado on-chain sin
// estado terminal tras un umbral) y los marca SIEMPRE para `manual_review` con evidencia.
//
// ⚠️ NO reintenta el forward (retry DEFERIDO, §8/CD-6/CD-15): el reconcile NUNCA llama a `fetch` ni
// re-forwardea al agente ⇒ el doble-pago es IMPOSIBLE por construcción. Reconstruir el forward
// exigiría el `beneficiary` (PII) que CD-7 prohíbe persistir. Toda varada ⇒ manual_review; un humano
// resuelve fuera de banda.
//
// Auth fail-closed (CD-8): RECONCILE_ADMIN_SECRET ausente ⇒ 501 (no configurado); secreto
// ausente/inválido en el header ⇒ 401. Comparación timing-safe (patrón attestation.ts:68-73).
// La respuesta lleva conteos agregados + IDs operativos — NUNCA PII, montos ni addresses (CD-7).
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSettlementLedger } from "../../../../src/infrastructure/persistence/supabase-settlement-ledger";
import { DEPOSIT_ATTESTATION_TTL_SECONDS } from "../../../../src/infrastructure/settlement/deposit-attestation";

// Umbral por default: 15 min (una remesa sana llega a estado terminal en segundos).
const DEFAULT_STALE_SECONDS = 900;
// Cota dura del batch: el reconcile es de baja concurrencia; evita un scan ilimitado.
const MAX_LIMIT = 100;
// WKH-213 — umbral de las 'prepared'. NO es el de arriba, y no puede serlo: aquel reloj mide
// updated_at, que en una fila 'prepared' no se mueve nunca (nadie la vuelve a tocar). La cota con
// sentido es el vencimiento de la atestación de depósito: pasado ese punto la orden YA NO puede
// completarse por el camino normal (el settle exigiría una atestación vencida ⇒ 400), así que la
// huérfana es definitiva. Se deriva de la MISMA constante que emite la atestación (nunca un literal
// paralelo: si el TTL cambia, este umbral cambia con él).
const PREPARED_ORPHAN_SECONDS = DEPOSIT_ATTESTATION_TTL_SECONDS;

/** Comparación timing-safe: longitud primero (timingSafeEqual TIRA con buffers de distinta longitud),
 *  luego comparación constante. Patrón attestation.ts:68-73. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Extrae el secreto presentado: `authorization: Bearer <secret>` o `x-reconcile-secret: <secret>`. */
function presentedSecret(req: Request): string {
  const authz = req.headers.get("authorization");
  if (authz && authz.startsWith("Bearer ")) return authz.slice("Bearer ".length).trim();
  return req.headers.get("x-reconcile-secret")?.trim() ?? "";
}

function staleThresholdSeconds(): number {
  const raw = process.env.RECONCILE_STALE_THRESHOLD_SECONDS;
  if (!raw) return DEFAULT_STALE_SECONDS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_SECONDS;
}

export async function POST(req: Request): Promise<Response> {
  // 1. Auth (AC-7/CD-8). Todo leído en runtime (CD-14).
  const secret = process.env.RECONCILE_ADMIN_SECRET;
  if (!secret) {
    // Sin secreto configurado el endpoint NO es operable (fail-closed, NUNCA público).
    return NextResponse.json({ error: "reconcile_not_configured" }, { status: 501 });
  }
  const presented = presentedSecret(req);
  if (!presented || !safeEqual(presented, secret)) {
    return NextResponse.json({ error: "reconcile_unauthorized" }, { status: 401 });
  }

  // 2. Ledger. Con flag OFF/envs ausentes no hay nada que reconciliar ⇒ 501 (degrada con gracia, AC-10).
  const ledger = getSettlementLedger();
  if (!ledger) {
    return NextResponse.json({ error: "reconcile_not_enabled" }, { status: 501 });
  }

  // 3. listStale (AC-4): no-terminales más viejas que el umbral.
  // WKH-213 — órdenes 'prepared' huérfanas. Va ANTES del barrido de varadas a propósito: es una
  // lectura pura, así que si falla se corta en 503 SIN haber mutado nada (el reintento del operador
  // re-corre el endpoint entero). Y falla FUERTE: devolver `{ total: 0 }` porque la consulta se cayó
  // se lee idéntico a "no hay huérfanas", que es la peor mentira que puede decir esta superficie.
  const preparedOlderThanIso = new Date(Date.now() - PREPARED_ORPHAN_SECONDS * 1000).toISOString();
  let prepared: Awaited<ReturnType<typeof ledger.listPreparedOrphans>>;
  try {
    prepared = await ledger.listPreparedOrphans({
      olderThanIso: preparedOlderThanIso,
      limit: MAX_LIMIT,
    });
  } catch {
    return NextResponse.json({ error: "reconcile_unavailable" }, { status: 503 });
  }

  const olderThanIso = new Date(Date.now() - staleThresholdSeconds() * 1000).toISOString();
  let stale: Awaited<ReturnType<typeof ledger.listStale>>;
  try {
    stale = await ledger.listStale({ olderThanIso, limit: MAX_LIMIT });
  } catch {
    // La DB cae ⇒ NO reventamos el endpoint; nada quedó doble-pagado (no hay forward). 503 opaco.
    return NextResponse.json({ error: "reconcile_unavailable" }, { status: 503 });
  }

  // 4. Resolución = SOLO manual_review (AC-6/CD-6/CD-15). NUNCA fetch, NUNCA re-forward.
  let manualReview = 0;
  let failed = 0;
  for (const rec of stale) {
    // AC-5 (invariante de dato): el idempotencyKey persistido DEBE reproducirse desde
    // (remittanceId, quoteId). NUNCA se regenera para un retry (deferido, §8). Es SOLO una
    // verificación de consistencia — no dispara ninguna acción de forward.
    const derivedIdem = `${rec.remittanceId}:${rec.quoteId}`;
    const idemConsistent = derivedIdem === rec.idempotencyKey;
    // markOutcome con la evidencia YA persistida (txHash, monto, address, quoteId, status, attempts).
    // last_error es un enum estable, NUNCA PII (CD-7). Por-fila en try/catch: un DB-throw transitorio
    // en la fila N NO aborta el batch (evita 500 con batch parcial); se cuenta aparte y seguimos.
    try {
      await ledger.markOutcome({
        id: rec.id,
        status: "manual_review",
        error: idemConsistent ? null : "idem_inconsistent",
        incrementAttempt: true,
      });
      manualReview++;
    } catch {
      failed++;
    }
  }

  // 5. Solo conteos agregados (CD-7): NUNCA PII/montos/addresses de terceros. `failed` = filas cuyo
  //    markOutcome tiró (batch parcial → 200, NUNCA 500).
  // `preparedOrphans`: sólo VISIBILIDAD, cero mutación — una 'prepared' no se re-procesa (su principal
  // nunca entró; cancelar la orden del proveedor es DT-5, fuera de este endpoint).
  //   · total     = conteo EXACTO de coincidencias, NO items.length (que está capado por MAX_LIMIT).
  //   · truncated = hay más de las que entran en la página ⇒ el operador sabe que está viendo un corte.
  //   · items     = IDs operativos para actuar (payoutId es lo que se cancela del lado del proveedor).
  //     NUNCA addresses ni montos: el operador no los necesita y esta respuesta va a logs (CD-7).
  return NextResponse.json(
    {
      scanned: stale.length,
      manualReview,
      failed,
      preparedOrphans: {
        total: prepared.total,
        truncated: prepared.total > prepared.records.length,
        olderThan: preparedOlderThanIso,
        items: prepared.records.map((r) => ({
          id: r.id,
          remittanceId: r.remittanceId,
          quoteId: r.quoteId,
          payoutId: r.payoutId,
          // Qué proveedor dijo el agente que iba a desembolsar. Es lo que separa una orden que hay que
          // ir a cancelar del lado del proveedor de una simulada que no existe en ningún lado, sin
          // tener que adivinarlo por el prefijo del payoutId. `null` = no consta (fila previa a la
          // migración 20260804, o el agente no la declaró): NO se lee como real.
          payoutProvenance: r.payoutProvenance,
          createdAt: r.createdAt,
        })),
      },
    },
    { status: 200 },
  );
}
