// Tests — POST /api/webhooks/transfi (WKH-210). Auth HMAC fail-closed (501/401), idempotencia
// AT-LEAST-ONCE (FIX AR MNR-1): mutación PRIMERO, claim best-effort DESPUÉS (CD-4), mapeo de estado,
// no-PII (CD-3). Todos los códigos HTTP se asertan EXACTOS (CD-13): un fail-open parcial (501→cae a
// 401) pasaría desapercibido con "no-200".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

// Mock del ledger factory + del claim-once. transfi-hmac NO se mockea: corre crypto real contra la env.
const { getLedgerMock, claimMock } = vi.hoisted(() => ({
  getLedgerMock: vi.fn(),
  claimMock: vi.fn(),
}));
vi.mock("../../../../src/infrastructure/persistence/supabase-settlement-ledger", () => ({
  getSettlementLedger: getLedgerMock,
}));
vi.mock("../../../../src/infrastructure/webhooks/webhook-event-store", () => ({
  claimWebhookEventOnce: claimMock,
}));

import { FakeSettlementLedger } from "../../../../src/test-support/fakes";
import type { SettlementLedgerStatus } from "../../../../src/application/ports";
import { POST } from "./route";

const SECRET = "whsec_test_xyz";
const T0 = "2026-07-16T00:00:00.000Z";

function sign(raw: string): string {
  return createHmac("sha256", SECRET).update(raw).digest("hex");
}

// Request-like minimal: la route solo usa req.headers.get() y req.text(). Nos deja espiar req.text.
function makeReq(raw: string, sig: string | null): { req: Request; textSpy: ReturnType<typeof vi.fn> } {
  const headers = new Headers();
  if (sig !== null) headers.set("x-transfi-hmac-hash", sig);
  const textSpy = vi.fn(async () => raw);
  const req = { headers, text: textSpy } as unknown as Request;
  return { req, textSpy };
}

// Ledger fake con una fila (payoutId + status). recordWebhookOutcome correlaciona por payoutId.
function ledgerWith(payoutId: string, status: SettlementLedgerStatus): FakeSettlementLedger {
  const ledger = new FakeSettlementLedger(T0);
  ledger.store.set("id-1", {
    id: "id-1",
    remittanceId: "rem-1",
    quoteId: "q-1",
    idempotencyKey: "rem-1:q-1",
    txHash: "0xtx1",
    chainId: 84532, // sandbox / Base Sepolia (AC-11)
    senderAddress: "0xsender",
    receiverAddress: "0xreceiver",
    valueMinor: 400_000_000,
    status,
    attempts: 0,
    payoutId,
    lastError: null,
    createdAt: T0,
    updatedAt: T0,
  });
  return ledger;
}

let fetchSpy: ReturnType<typeof vi.fn>;

describe("POST /api/webhooks/transfi (WKH-210)", () => {
  beforeEach(() => {
    vi.stubEnv("TRANSFI_WEBHOOK_SECRET", SECRET);
    getLedgerMock.mockReset();
    claimMock.mockReset();
    claimMock.mockResolvedValue({ ok: true }); // por defecto el evento es nuevo
    // AC-11: ninguna llamada de red real; si la route intentara fetch, este spy lo cazaría.
    fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── AC-1: fail-closed sin secreto (ANTES de leer el body) ──────────────────
  it("AC-1/CD-2: sin TRANSFI_WEBHOOK_SECRET ⇒ 501 webhook_not_configured, sin leer el body", async () => {
    vi.stubEnv("TRANSFI_WEBHOOK_SECRET", "");
    const raw = JSON.stringify({ orderId: "p-1", status: "fund_settled" });
    const { req, textSpy } = makeReq(raw, sign(raw));
    const res = await POST(req);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "webhook_not_configured" });
    expect(textSpy).not.toHaveBeenCalled(); // CD-2: 501 ANTES de leer el body
  });

  // ── AC-2: fail-closed firma ausente / mismatch ─────────────────────────────
  it("AC-2/CD-2: firma ausente ⇒ 401 webhook_unauthorized, ledger NO consultado ni mutado", async () => {
    const ledger = ledgerWith("p-1", "submitted");
    const spy = vi.spyOn(ledger, "recordWebhookOutcome");
    getLedgerMock.mockReturnValue(ledger);
    const raw = JSON.stringify({ orderId: "p-1", status: "fund_settled" });
    const { req } = makeReq(raw, null);
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "webhook_unauthorized" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("AC-2/CD-2: firma que no matchea ⇒ 401", async () => {
    getLedgerMock.mockReturnValue(ledgerWith("p-1", "submitted"));
    const raw = JSON.stringify({ orderId: "p-1", status: "fund_settled" });
    const { req } = makeReq(raw, sign("otro-body-distinto"));
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("AC-2 (crudo/DT-4): firma válida sobre el RAW exacto pasa; el mismo objeto re-serializado con otro spacing ⇒ 401", async () => {
    getLedgerMock.mockReturnValue(ledgerWith("p-1", "submitted"));
    const raw = '{"orderId":"p-1","status":"fund_settled"}';
    const sig = sign(raw);
    const ok = makeReq(raw, sig);
    expect((await POST(ok.req)).status).toBe(200);
    // Mismo objeto, otro string (con espacios): la firma del raw NO valida ⇒ prueba que NO se re-serializa.
    const rawSpaced = '{ "orderId": "p-1", "status": "fund_settled" }';
    const bad = makeReq(rawSpaced, sig);
    expect((await POST(bad.req)).status).toBe(401);
  });

  // ── AC-3: idempotencia at-least-once — la mutación va PRIMERO, el claim es best-effort ──────
  it("AC-3/CD-4: claim alreadyUsed ⇒ 200; la mutación YA se aplicó (idempotente por STALE filter)", async () => {
    const ledger = ledgerWith("p-1", "submitted");
    const spy = vi.spyOn(ledger, "recordWebhookOutcome");
    getLedgerMock.mockReturnValue(ledger);
    claimMock.mockResolvedValue({ ok: false, alreadyUsed: true });
    const raw = JSON.stringify({ orderId: "p-1", status: "fund_settled" });
    const { req } = makeReq(raw, sign(raw));
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true }); // sin flag deduped: el claim ya no gatea la mutación
    // FIX AR MNR-1: con mutate-before-claim, un claim alreadyUsed NO impide la mutación. Es SEGURO
    // porque recordWebhookOutcome es idempotente (STALE filter) ⇒ jamás hay double-mutation dañina.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ledger.store.get("id-1")?.status).toBe("settled");
  });

  // ── AC-4/5/6: mapeo de estado ──────────────────────────────────────────────
  it("AC-4: fund_settled + payoutId existente ⇒ status settled", async () => {
    const ledger = ledgerWith("p-1", "submitted");
    getLedgerMock.mockReturnValue(ledger);
    const raw = JSON.stringify({ orderId: "p-1", status: "fund_settled" });
    const res = await POST(makeReq(raw, sign(raw)).req);
    expect(res.status).toBe(200);
    expect(ledger.store.get("id-1")?.status).toBe("settled");
  });

  it("AC-5/CD-3: fund_failed ⇒ status failed + lastError enum estable; el reason crudo NUNCA llega al ledger", async () => {
    const ledger = ledgerWith("p-1", "submitted");
    getLedgerMock.mockReturnValue(ledger);
    const raw = JSON.stringify({
      orderId: "p-1",
      status: "fund_failed",
      reason: "beneficiario Juan Perez rechazado por el banco 1234", // PII cruda del payload
    });
    const res = await POST(makeReq(raw, sign(raw)).req);
    expect(res.status).toBe(200);
    const row = ledger.store.get("id-1");
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("transfi_fund_failed"); // enum estable, no el reason
    expect(row?.lastError).not.toContain("Juan"); // el reason crudo jamás persiste
  });

  it("AC-6: asset_deposited ⇒ status submitted", async () => {
    const ledger = ledgerWith("p-1", "principal_in");
    getLedgerMock.mockReturnValue(ledger);
    const raw = JSON.stringify({ orderId: "p-1", status: "asset_deposited" });
    const res = await POST(makeReq(raw, sign(raw)).req);
    expect(res.status).toBe(200);
    expect(ledger.store.get("id-1")?.status).toBe("submitted");
  });

  // ── AC-7: status desconocido ⇒ 200 ACK sin claim, sin mutar ────────────────
  it("AC-7/CD-7: status desconocido ⇒ 200 unmapped_status, claim NO llamado, ledger NO mutado", async () => {
    const ledger = ledgerWith("p-1", "submitted");
    const spy = vi.spyOn(ledger, "recordWebhookOutcome");
    getLedgerMock.mockReturnValue(ledger);
    const raw = JSON.stringify({ orderId: "p-1", status: "expired" });
    const res = await POST(makeReq(raw, sign(raw)).req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "unmapped_status" });
    expect(claimMock).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(ledger.store.get("id-1")?.status).toBe("submitted");
  });

  // ── AC-8: payoutId inexistente ⇒ 200 sin crear fila ────────────────────────
  it("AC-8: payoutId inexistente ⇒ 200, sin crear ni mutar filas (store.size intacto)", async () => {
    const ledger = ledgerWith("p-1", "submitted");
    getLedgerMock.mockReturnValue(ledger);
    const before = ledger.store.size;
    const raw = JSON.stringify({ orderId: "p-999", status: "fund_settled" });
    const res = await POST(makeReq(raw, sign(raw)).req);
    expect(res.status).toBe(200);
    expect(ledger.store.size).toBe(before);
    expect(ledger.store.get("id-1")?.status).toBe("submitted"); // la fila ajena no se tocó
  });

  it("AC-8b: body sin candidato de payoutId ⇒ 200 no_payout_id, recordWebhookOutcome NO llamado", async () => {
    const ledger = ledgerWith("p-1", "submitted");
    const spy = vi.spyOn(ledger, "recordWebhookOutcome");
    getLedgerMock.mockReturnValue(ledger);
    const raw = JSON.stringify({ status: "fund_settled", foo: "bar" });
    const res = await POST(makeReq(raw, sign(raw)).req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "no_payout_id" });
    expect(spy).not.toHaveBeenCalled();
  });

  // ── AC-9: no-PII transversal ───────────────────────────────────────────────
  it("AC-9/CD-3: la respuesta OK no ecoa el payload; el ledger solo lleva payoutId/status/lastError-enum", async () => {
    const ledger = ledgerWith("p-1", "submitted");
    getLedgerMock.mockReturnValue(ledger);
    const raw = JSON.stringify({
      orderId: "p-1",
      status: "fund_settled",
      beneficiary: "Maria Gomez DNI 87654321",
    });
    const res = await POST(makeReq(raw, sign(raw)).req);
    expect(await res.json()).toEqual({ ok: true }); // sin ecos del payload
    const row = ledger.store.get("id-1");
    expect(row?.status).toBe("settled");
    expect(JSON.stringify(row)).not.toContain("Maria"); // ninguna PII del payload persistió
  });

  // ── AC-10: flag OFF (ledger null) ──────────────────────────────────────────
  it("AC-10/DT-3: getSettlementLedger()===null (flag OFF) + firma válida ⇒ 501 webhook_not_enabled", async () => {
    getLedgerMock.mockReturnValue(null);
    const raw = JSON.stringify({ orderId: "p-1", status: "fund_settled" });
    const res = await POST(makeReq(raw, sign(raw)).req);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "webhook_not_enabled" });
  });

  // ── AC-11: sandbox / cero red real ─────────────────────────────────────────
  it("AC-11: procesamiento 100% mock, ningún fetch de red real", async () => {
    getLedgerMock.mockReturnValue(ledgerWith("p-1", "submitted"));
    const raw = JSON.stringify({ orderId: "p-1", status: "fund_settled" });
    await POST(makeReq(raw, sign(raw)).req);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── DT-2b: no degradar un estado terminal ──────────────────────────────────
  it("DT-2b: asset_deposited tardío sobre una fila ya settled ⇒ NO baja el status (sigue settled)", async () => {
    const ledger = ledgerWith("p-1", "settled");
    getLedgerMock.mockReturnValue(ledger);
    const raw = JSON.stringify({ orderId: "p-1", status: "asset_deposited" });
    const res = await POST(makeReq(raw, sign(raw)).req);
    expect(res.status).toBe(200);
    expect(ledger.store.get("id-1")?.status).toBe("settled");
  });

  // ── claim best-effort: NO revierte una mutación ya exitosa ──────────────────
  it("503-a→200: claim unavailable (Upstash caído) DESPUÉS de mutar ⇒ 200 best-effort, mutación aplicada", async () => {
    // FIX AR MNR-1: el claim pasó a best-effort (post-mutación). Un Upstash caído YA NO produce 503:
    // la mutación (idempotente) es la fuente de verdad; el claim solo dedupea trabajo redundante.
    const ledger = ledgerWith("p-1", "submitted");
    const spy = vi.spyOn(ledger, "recordWebhookOutcome");
    getLedgerMock.mockReturnValue(ledger);
    claimMock.mockResolvedValue({ ok: false, unavailable: true });
    const raw = JSON.stringify({ orderId: "p-1", status: "fund_settled" });
    const res = await POST(makeReq(raw, sign(raw)).req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ledger.store.get("id-1")?.status).toBe("settled");
  });

  // ── 503: fail-closed cuando la MUTACIÓN falla (la key NO se quema) ──────────
  it("503-b: recordWebhookOutcome rechaza (DB throw) ⇒ 503 NUNCA 500, y claim NO llamado (key intacta)", async () => {
    const ledger = ledgerWith("p-1", "submitted");
    vi.spyOn(ledger, "recordWebhookOutcome").mockRejectedValue(new Error("db down"));
    getLedgerMock.mockReturnValue(ledger);
    const raw = JSON.stringify({ orderId: "p-1", status: "fund_settled" });
    const res = await POST(makeReq(raw, sign(raw)).req);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "webhook_unavailable" });
    // FIX AR MNR-1: la mutación va PRIMERO ⇒ si tira, se corta ANTES del claim. La key queda SIN quemar
    // ⇒ el retry de TransFi re-entrega el evento y lo re-muta (cubierto por el test bug-killer de abajo).
    expect(claimMock).not.toHaveBeenCalled();
  });

  // ── FIX AR MNR-1: bug-killer del lost-update por claim-before-mutate ────────
  it("FIX AR MNR-1: DB-throw en el 1er delivery ⇒ 503 SIN quemar la key; el retry re-muta ⇒ settled, 200", async () => {
    const ledger = ledgerWith("p-1", "submitted");
    // 1er delivery: el ledger tira (DB down). Tras consumir el `once`, cae a la impl real del fake.
    const spy = vi.spyOn(ledger, "recordWebhookOutcome").mockRejectedValueOnce(new Error("db down"));
    getLedgerMock.mockReturnValue(ledger);
    const raw = JSON.stringify({ orderId: "p-1", status: "fund_settled" });

    const res1 = await POST(makeReq(raw, sign(raw)).req);
    expect(res1.status).toBe(503);
    expect(claimMock).not.toHaveBeenCalled(); // la key NO se quemó (mutación PRIMERO)
    expect(ledger.store.get("id-1")?.status).toBe("submitted"); // sin transición todavía

    // 2º delivery = retry del MISMO evento. El ledger ya responde OK ⇒ re-muta idempotente.
    const res2 = await POST(makeReq(raw, sign(raw)).req);
    expect(res2.status).toBe(200);
    expect(ledger.store.get("id-1")?.status).toBe("settled"); // la transición NO se perdió
    expect(spy).toHaveBeenCalledTimes(2);
    expect(claimMock).toHaveBeenCalledTimes(1); // claim recién ahora, tras el éxito de la mutación
  });

  it("FIX AR MNR-1: doble delivery normal ⇒ 2º es no-op idempotente (STALE filter), fila settled una vez, 200", async () => {
    const ledger = ledgerWith("p-1", "submitted");
    const spy = vi.spyOn(ledger, "recordWebhookOutcome");
    getLedgerMock.mockReturnValue(ledger);
    const raw = JSON.stringify({ orderId: "p-1", status: "fund_settled" });

    const res1 = await POST(makeReq(raw, sign(raw)).req);
    expect(res1.status).toBe(200);
    expect(ledger.store.get("id-1")?.status).toBe("settled");

    // 2º delivery (retry): la mutación se INTENTA otra vez pero la fila ya salió del set STALE ⇒ no-op.
    const res2 = await POST(makeReq(raw, sign(raw)).req);
    expect(res2.status).toBe(200);
    expect(ledger.store.get("id-1")?.status).toBe("settled"); // sin double-mutation dañina
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("FIX AR MNR-1: 2 deliveries concurrentes del mismo evento mutando antes del claim ⇒ idempotente (settled)", async () => {
    const ledger = ledgerWith("p-1", "submitted");
    getLedgerMock.mockReturnValue(ledger);
    const raw = JSON.stringify({ orderId: "p-1", status: "fund_settled" });
    const [r1, r2] = await Promise.all([
      POST(makeReq(raw, sign(raw)).req),
      POST(makeReq(raw, sign(raw)).req),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(ledger.store.get("id-1")?.status).toBe("settled"); // settled una sola vez, sin degradar
  });

  // ── 400: body no-JSON ──────────────────────────────────────────────────────
  it("400: firma válida + body no-JSON ⇒ 400 webhook_bad_request", async () => {
    getLedgerMock.mockReturnValue(ledgerWith("p-1", "submitted"));
    const raw = "esto no es json {";
    const res = await POST(makeReq(raw, sign(raw)).req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "webhook_bad_request" });
  });
});
