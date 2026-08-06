// Tests — POST /api/admin/reconcile-orphans (WKH-207 W3). Auth fail-closed (501/401/200), toda
// varada ⇒ manual_review con evidencia, y el NO-DOBLE-PAGO trivial: el reconcile NUNCA llama a fetch
// (spy con 0 llamadas — el mutante que agregue un re-forward MUERE).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WKH-207: mock del ledger — getLedgerMock apunta a la instancia fake que cada test prepara.
const { getLedgerMock } = vi.hoisted(() => ({ getLedgerMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/persistence/supabase-settlement-ledger", () => ({
  getSettlementLedger: getLedgerMock,
}));

import { FakeSettlementLedger } from "../../../../src/test-support/fakes";
import { POST } from "./route";

const SECRET = "admin-secret-xyz";
const OLD = "2026-07-01T00:00:00.000Z"; // muy anterior a Date.now() (2026-07-16) ⇒ siempre varada

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/admin/reconcile-orphans", { method: "POST", headers });
}
function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

// Crea un ledger fake con N settlements varados (status principal_in, updatedAt viejo).
function ledgerWithStale(n: number): FakeSettlementLedger {
  const ledger = new FakeSettlementLedger(OLD);
  for (let i = 0; i < n; i++) {
    const remittanceId = `rem-${i}`;
    const quoteId = `q-${i}`;
    ledger.store.set(`id-${i}`, {
      id: `id-${i}`,
      remittanceId,
      quoteId,
      idempotencyKey: `${remittanceId}:${quoteId}`,
      txHash: `0xtx${i}`,
      chainId: 84532,
      senderAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      receiverAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      valueMinor: "400000000", // string exacto (uint256-safe), como lo devuelve el ::text
      status: "principal_in",
      attempts: 0,
      payoutId: null,
      payoutProvenance: null, // fila varada de otra época: la proveniencia NO consta
      lastError: null,
      createdAt: OLD,
      updatedAt: OLD,
    });
  }
  return ledger;
}

let fetchSpy: ReturnType<typeof vi.fn>;

describe("POST /api/admin/reconcile-orphans (WKH-207)", () => {
  beforeEach(() => {
    getLedgerMock.mockReset();
    getLedgerMock.mockReturnValue(null);
    // Spy de fetch: el reconcile NUNCA debe llamarlo (no-doble-pago por construcción).
    fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ── Auth fail-closed (AC-7/CD-8) ───────────────────────────────────────────
  it("AC-7/CD-8: sin RECONCILE_ADMIN_SECRET configurado ⇒ 501", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", "");
    const res = await POST(req(bearer("cualquiera")));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "reconcile_not_configured" });
  });

  it("AC-7/CD-8: secreto inválido ⇒ 401", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    const res = await POST(req(bearer("secreto-equivocado")));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "reconcile_unauthorized" });
  });

  it("AC-7/CD-8: sin header de auth ⇒ 401", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    const res = await POST(req());
    expect(res.status).toBe(401);
  });

  it("AC-7: secreto válido ⇒ 200 (aunque scanned=0)", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    getLedgerMock.mockReturnValue(ledgerWithStale(0));
    const res = await POST(req(bearer(SECRET)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ scanned: 0, manualReview: 0, failed: 0 });
  });

  it("AC-7: acepta el secreto vía x-reconcile-secret además de Bearer", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    getLedgerMock.mockReturnValue(ledgerWithStale(0));
    const res = await POST(req({ "x-reconcile-secret": SECRET }));
    expect(res.status).toBe(200);
  });

  it("AC-10: flag OFF (ledger null) aun con auth OK ⇒ 501 (degrada con gracia)", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    getLedgerMock.mockReturnValue(null);
    const res = await POST(req(bearer(SECRET)));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "reconcile_not_enabled" });
  });

  // ── Resolución = manual_review, SIEMPRE (AC-6/CD-6) ────────────────────────
  it("AC-6/CD-6: cada varada ⇒ manual_review con incrementAttempt; response = conteos", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    const ledger = ledgerWithStale(3);
    getLedgerMock.mockReturnValue(ledger);
    const res = await POST(req(bearer(SECRET)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ scanned: 3, manualReview: 3, failed: 0 });
    // Todas las filas quedaron en manual_review, con attempts incrementado (evidencia preservada).
    for (const rec of ledger.store.values()) {
      expect(rec.status).toBe("manual_review");
      expect(rec.attempts).toBe(1);
      expect(rec.txHash).toBeTruthy(); // la evidencia money-path sigue ahí
    }
  });

  it("AC-5: reconcile deriva el idempotencyKey del registro y lo asevera === record.idempotencyKey (consistente ⇒ last_error null)", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    const ledger = ledgerWithStale(1);
    // Invariante: el idempotencyKey persistido = `${remittanceId}:${quoteId}`.
    const rec = [...ledger.store.values()][0]!;
    expect(rec.idempotencyKey).toBe(`${rec.remittanceId}:${rec.quoteId}`);
    getLedgerMock.mockReturnValue(ledger);
    await POST(req(bearer(SECRET)));
    // Consistente ⇒ el reconcile NO marca inconsistencia.
    expect([...ledger.store.values()][0]!.lastError).toBeNull();
  });

  it("AC-5: idempotencyKey persistido que NO reproduce (remittanceId,quoteId) ⇒ last_error=idem_inconsistent (nunca se regenera)", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    const ledger = ledgerWithStale(1);
    const rec = [...ledger.store.values()][0]!;
    rec.idempotencyKey = "corrupto:no-matchea"; // dato inconsistente
    getLedgerMock.mockReturnValue(ledger);
    await POST(req(bearer(SECRET)));
    expect([...ledger.store.values()][0]!.status).toBe("manual_review");
    expect([...ledger.store.values()][0]!.lastError).toBe("idem_inconsistent");
  });

  // ── No-doble-pago trivial por construcción (R1/CD-6/CD-18) ─────────────────
  it("R1/CD-6: el reconcile NUNCA llama a fetch — el mutante que agregue un re-forward MUERE (spy 0 llamadas)", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    getLedgerMock.mockReturnValue(ledgerWithStale(5));
    const res = await POST(req(bearer(SECRET)));
    expect(res.status).toBe(200);
    // Ni una sola llamada al agente: el 2º desembolso es imposible por construcción.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── MNR-2 (CR): markOutcome por-fila en try/catch ⇒ batch parcial, NUNCA 500 ────────────────────
  it("MNR-2: markOutcome que rechaza en la 2ª fila ⇒ 200 con conteo parcial (1 marcada, 1 fallida), NO 500", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    const ledger = ledgerWithStale(2);
    let calls = 0;
    vi.spyOn(ledger, "markOutcome").mockImplementation(async () => {
      calls++;
      if (calls === 2) throw new Error("db transient");
      // 1ª fila: éxito (no muta el store — el conteo es lo que se asevera).
    });
    getLedgerMock.mockReturnValue(ledger);
    const res = await POST(req(bearer(SECRET)));
    expect(res.status).toBe(200); // batch parcial NO revienta el endpoint
    expect(await res.json()).toMatchObject({ scanned: 2, manualReview: 1, failed: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("CD-17: si listStale falla ⇒ 503, sin fetch (nada quedó doble-pagado)", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    const ledger = ledgerWithStale(1);
    vi.spyOn(ledger, "listStale").mockRejectedValue(new Error("db down"));
    getLedgerMock.mockReturnValue(ledger);
    const res = await POST(req(bearer(SECRET)));
    expect(res.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── WKH-213 · las 'prepared' huérfanas viajan DENTRO de esta misma respuesta ─────────────────────
  // No hay cola nueva: el operador ya consulta este endpoint. Las 'prepared' son visibilidad pura
  // (cero mutación: no hay depósito REGISTRADO — que no es lo mismo que sin depósito, WKH-330).
  /** Ledger con N órdenes 'prepared' nacidas `ageSeconds` atrás (reloj = created_at, no updated_at). */
  async function ledgerWithPrepared(n: number, ageSeconds: number): Promise<FakeSettlementLedger> {
    const born = new Date(Date.now() - ageSeconds * 1000).toISOString();
    const ledger = new FakeSettlementLedger(born);
    for (let i = 0; i < n; i++) {
      await ledger.recordOrderPrepared({
        remittanceId: `rem-p${i}`,
        quoteId: `q-p${i}`,
        idempotencyKey: `rem-p${i}:q-p${i}`,
        depositAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        chainId: 84532,
        senderAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        payoutId: `transfi-po-${i}`,
        payoutProvenance: "transfi",
        vm: "evm",
      });
    }
    return ledger;
  }

  it("una 'prepared' vencida aparece en preparedOrphans con su payoutId, y NO se muta ni entra en scanned", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    const ledger = await ledgerWithPrepared(2, 3600); // 1 hora: muy por encima del TTL de la atestación
    getLedgerMock.mockReturnValue(ledger);
    const res = await POST(req(bearer(SECRET)));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.scanned).toBe(0); // una 'prepared' NO se re-procesa (CD-6)
    expect(json.preparedOrphans.total).toBe(2);
    expect(json.preparedOrphans.truncated).toBe(false);
    expect(json.preparedOrphans.items.map((i: { payoutId: string }) => i.payoutId)).toEqual([
      "transfi-po-0",
      "transfi-po-1",
    ]);
    // Visibilidad, NO mutación: las filas siguen exactamente donde estaban.
    for (const rec of ledger.store.values()) {
      expect(rec.status).toBe("prepared");
      expect(rec.attempts).toBe(0);
    }
    // CD-7: la superficie no expone addresses ni montos.
    const raw = JSON.stringify(json);
    expect(raw).not.toContain("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    expect(raw).not.toContain("valueMinor");
  });

  it("el umbral de las 'prepared' es el TTL de la atestación de depósito, NO el de las varadas", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    // 11 min: YA venció la atestación de depósito (10 min) pero NO el umbral de varadas (15 min).
    // Si alguien reusara DEFAULT_STALE_SECONDS para las 'prepared', esta huérfana quedaría invisible.
    const ledger = await ledgerWithPrepared(1, 11 * 60);
    getLedgerMock.mockReturnValue(ledger);
    const json = await (await POST(req(bearer(SECRET)))).json();
    expect(json.preparedOrphans.total).toBe(1);
  });

  it("una 'prepared' recién nacida NO es huérfana todavía (la remesa aún puede completarse)", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    const ledger = await ledgerWithPrepared(1, 30); // 30 s
    getLedgerMock.mockReturnValue(ledger);
    const json = await (await POST(req(bearer(SECRET)))).json();
    expect(json.preparedOrphans.total).toBe(0);
    expect(json.preparedOrphans.items).toEqual([]);
  });

  it("truncamiento: total dice la verdad aunque la página esté capada en 100", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    const ledger = await ledgerWithPrepared(105, 3600);
    getLedgerMock.mockReturnValue(ledger);
    const json = await (await POST(req(bearer(SECRET)))).json();
    expect(json.preparedOrphans.items.length).toBe(100); // MAX_LIMIT
    expect(json.preparedOrphans.total).toBe(105); // el tamaño REAL del problema
    expect(json.preparedOrphans.truncated).toBe(true);
  });

  it("fail-loud: si la consulta de 'prepared' falla ⇒ 503 y NADA se mutó (nunca una lista vacía mentirosa)", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    const ledger = ledgerWithStale(2);
    vi.spyOn(ledger, "listPreparedOrphans").mockRejectedValue(new Error("db down"));
    const markSpy = vi.spyOn(ledger, "markOutcome");
    getLedgerMock.mockReturnValue(ledger);
    const res = await POST(req(bearer(SECRET)));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "reconcile_unavailable" });
    // Corta ANTES de mutar: el reintento del operador re-corre el endpoint entero sin efectos a medias.
    expect(markSpy).not.toHaveBeenCalled();
    for (const rec of ledger.store.values()) expect(rec.status).toBe("principal_in");
  });

  // ── La cola de varadas vuelve a tener contenido (era estructuralmente vacía) ─────────────────────
  it("una remesa preparada + settleada y varada SÍ aparece en scanned ⇒ manual_review", async () => {
    vi.stubEnv("RECONCILE_ADMIN_SECRET", SECRET);
    const ledger = new FakeSettlementLedger(OLD); // updatedAt viejo ⇒ varada
    await ledger.recordOrderPrepared({
      remittanceId: "rem-x",
      quoteId: "q-x",
      idempotencyKey: "rem-x:q-x",
      depositAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      chainId: 84532,
      senderAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      payoutId: "transfi-po-x",
      payoutProvenance: "transfi",
      vm: "evm",
    });
    await ledger.recordPrincipalIn({
      remittanceId: "rem-x",
      quoteId: "q-x",
      idempotencyKey: "rem-x:q-x",
      txHash: "0xTXREAL",
      chainId: 84532,
      senderAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      receiverAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      valueMinor: 400_000_000,
      vm: "evm",
    });
    getLedgerMock.mockReturnValue(ledger);
    const json = await (await POST(req(bearer(SECRET)))).json();
    // ANTES de WKH-213 esto era 0: el settle nunca aterrizaba, la fila quedaba 'prepared' y listStale
    // escaneaba un conjunto estructuralmente vacío.
    expect(json.scanned).toBe(1);
    expect(json.manualReview).toBe(1);
    expect(json.preparedOrphans.total).toBe(0); // ya no es 'prepared': se completó
    const rec = [...ledger.store.values()][0]!;
    expect(rec.status).toBe("manual_review");
    expect(rec.txHash).toBe("0xTXREAL"); // la evidencia del principal, preservada
    expect(rec.payoutId).toBe("transfi-po-x");
  });
});
