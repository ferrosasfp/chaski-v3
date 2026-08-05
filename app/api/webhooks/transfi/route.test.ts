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
    chainId: 84532, // id numérico heredado de una fila vieja del ledger (AC-11)
    senderAddress: "0xsender",
    receiverAddress: "0xreceiver",
    valueMinor: "400000000", // string exacto (uint256-safe), como lo devuelve el ::text
    status,
    attempts: 0,
    payoutId,
    payoutProvenance: null, // fila vieja del ledger: la proveniencia NO consta
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

  // T-4a/T-4b del lado del estado de la fila — CONVERTIDO (WKH-325). Antes afirmaba el enum PLANO
  // `transfi_fund_failed`, que era el mismo para los tres desenlaces. Ahora la fila venía en
  // 'submitted' (el proveedor confirmó asset_deposited ⇒ el release ya entró), que es el ÚNICO caso
  // con pérdida del principal, y el literal lo dice.
  it("AC-5/CD-3: fund_failed sobre 'submitted' ⇒ failed + el literal del desenlace con pérdida; el reason crudo NUNCA llega al ledger", async () => {
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
    expect(row?.lastError).toBe("transfi_fund_failed_principal_released"); // enum estable, no el reason
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

  // ── WKH-213/R1: el aviso del proveedor SÍ mueve una fila 'prepared' ────────
  // Antes, el filtro no-terminal era exactamente STALE_STATUSES (sin 'prepared'), así que si el settle
  // nunca aterrizaba el proveedor podía avisar "pagado" y la fila se quedaba idéntica: el aviso se
  // perdía y la remesa quedaba congelada en 'prepared' para siempre.
  it("R1: fund_settled sobre una fila 'prepared' ⇒ la fila pasa a settled (el aviso ya no se pierde)", async () => {
    const ledger = ledgerWith("p-1", "prepared");
    getLedgerMock.mockReturnValue(ledger);
    const raw = JSON.stringify({ orderId: "p-1", status: "fund_settled" });
    const res = await POST(makeReq(raw, sign(raw)).req);
    expect(res.status).toBe(200);
    expect(ledger.store.get("id-1")?.status).toBe("settled");
  });

  // CONVERTIDO (WKH-325): una fila 'prepared' significa que el settle NO dejó registro ⇒ el ledger no
  // sabe de ningún depósito nuestro. NO prueba que no lo haya habido: un write best-effort que falla de
  // forma transitoria deja la fila acá y sólo emite un console.warn (residuo #5 del auto-blindaje). La
  // clasificación es state-based y por eso lleva su propio literal en vez del enum plano que compartía
  // con los otros dos.
  it("R1/T-2a: fund_failed sobre una fila 'prepared' ⇒ failed con transfi_fund_failed_no_principal", async () => {
    const ledger = ledgerWith("p-1", "prepared");
    getLedgerMock.mockReturnValue(ledger);
    const raw = JSON.stringify({ orderId: "p-1", status: "fund_failed" });
    await POST(makeReq(raw, sign(raw)).req);
    expect(ledger.store.get("id-1")?.status).toBe("failed");
    expect(ledger.store.get("id-1")?.lastError).toBe("transfi_fund_failed_no_principal");
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

// ── WKH-325 · la alerta del desenlace con pérdida del principal (AC-4) + el golden de AC-7 ──────────
describe("POST /api/webhooks/transfi — alerta de principal liberado (WKH-325)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("TRANSFI_WEBHOOK_SECRET", SECRET);
    getLedgerMock.mockReset();
    claimMock.mockReset();
    claimMock.mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Cuenta las alertas del ledger emitidas hasta acá. LA MISMA función se usa para los casos que
   *  deben dar 1 y para los que deben dar 0: un `toBe(0)` sobre un spy que nunca capturó nada mediría
   *  cero y pasaría en verde sin decir nada (CD-13). */
  const alertCount = (): number =>
    errSpy.mock.calls.filter((c) => String(c[0]).includes("[ledger][ALERT]")).length;

  /** Segunda fila con el MISMO payout_id: una remesa recotizada genera una fila por quoteId. */
  function addRow(
    ledger: FakeSettlementLedger,
    id: string,
    payoutId: string,
    status: SettlementLedgerStatus,
  ): void {
    ledger.store.set(id, {
      id,
      remittanceId: "rem-1",
      quoteId: `q-${id}`,
      idempotencyKey: `rem-1:q-${id}`,
      txHash: `0xtx-${id}`,
      chainId: null,
      senderAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      receiverAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      valueMinor: "400000000",
      status,
      attempts: 0,
      payoutId,
      payoutProvenance: null,
      lastError: null,
      createdAt: T0,
      updatedAt: T0,
    });
  }

  const fundFailed = (payoutId = "ord-1") =>
    JSON.stringify({ orderId: payoutId, status: "fund_failed" });

  // T-4a — CD-13: los TRES casos en el MISMO `it`, con el MISMO spy y el MISMO contador. El `0` no
  // puede pasar por una captura vacía porque el mismo contador produce el `1` cinco líneas antes.
  it("T-4a (AC-4/CD-13): 'submitted' ⇒ 1 alerta; 'prepared' ⇒ 0; 'principal_in' ⇒ 0", async () => {
    getLedgerMock.mockReturnValue(ledgerWith("ord-1", "submitted"));
    await POST(makeReq(fundFailed(), sign(fundFailed())).req);
    expect(alertCount()).toBe(1);

    errSpy.mockClear();
    getLedgerMock.mockReturnValue(ledgerWith("ord-1", "prepared"));
    await POST(makeReq(fundFailed(), sign(fundFailed())).req);
    expect(alertCount()).toBe(0);

    errSpy.mockClear();
    getLedgerMock.mockReturnValue(ledgerWith("ord-1", "principal_in"));
    await POST(makeReq(fundFailed(), sign(fundFailed())).req);
    expect(alertCount()).toBe(0);
  });

  it("T-4b (AC-4/CD-7): el evento se llama transfi_fund_failed_principal_released y el 2º argumento es EXACTAMENTE {payoutId}", async () => {
    getLedgerMock.mockReturnValue(ledgerWith("ord-1", "submitted"));
    await POST(makeReq(fundFailed(), sign(fundFailed())).req);
    const call = errSpy.mock.calls.find((c) => String(c[0]).includes("[ledger][ALERT]"));
    expect(call).toBeDefined();
    expect(String(call?.[0])).toContain("transfi_fund_failed_principal_released");
    // Ni montos, ni addresses, ni el status previo, ni conteos de filas: SÓLO el identificador de
    // correlación. Un `toEqual` sobre el objeto entero es lo que caza una clave de más.
    expect(call?.[1]).toEqual({ payoutId: "ord-1" });
  });

  it("T-4c (AC-4): el MISMO body entregado DOS veces ⇒ 1 alerta EN TOTAL (la 2ª no reclasifica nada)", async () => {
    getLedgerMock.mockReturnValue(ledgerWith("ord-1", "submitted"));
    await POST(makeReq(fundFailed(), sign(fundFailed())).req);
    await POST(makeReq(fundFailed(), sign(fundFailed())).req);
    expect(alertCount()).toBe(1);
  });

  it("T-4d (DT-6): DOS filas del mismo payoutId ('prepared' + 'submitted') ⇒ dos last_error distintos y UNA sola alerta", async () => {
    const ledger = ledgerWith("ord-1", "prepared"); // id-1
    addRow(ledger, "id-2", "ord-1", "submitted");
    getLedgerMock.mockReturnValue(ledger);
    await POST(makeReq(fundFailed(), sign(fundFailed())).req);
    expect(ledger.store.get("id-1")?.lastError).toBe("transfi_fund_failed_no_principal");
    expect(ledger.store.get("id-2")?.lastError).toBe("transfi_fund_failed_principal_released");
    expect(alertCount()).toBe(1); // por EVENTO, no por fila
  });

  it("T-7a (AC-7): la rama no-failed conserva su patch de HOY — un solo update con EXACTAMENTE {status, updated_at}", async () => {
    for (const provider of ["asset_deposited", "fund_settled"]) {
      const ledger = ledgerWith("ord-1", "principal_in");
      const spy = vi.spyOn(ledger, "recordWebhookOutcome");
      getLedgerMock.mockReturnValue(ledger);
      const raw = JSON.stringify({ orderId: "ord-1", status: provider });
      const res = await POST(makeReq(raw, sign(raw)).req);
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      // El caller ya NO puede pasar last_error: el parámetro no existe en el port (candado de
      // compilación). Lo que este test fija es que tampoco aparece por otro lado.
      expect(Object.keys(spy.mock.calls[0]?.[0] ?? {}).sort()).toEqual(["payoutId", "status"]);
      expect(ledger.store.get("id-1")?.lastError).toBeNull();
      expect(await spy.mock.results[0]?.value).toEqual({ classified: false });
    }
  });

  // T-7b — GOLDEN de los OCHO caminos de respuesta, con status Y cuerpo exactos. Son ocho, no seis:
  // el #3 (501 webhook_not_enabled, ledger apagado) es el que quedaba sin vigilar en un golden, y es
  // justo el que un fail-open parcial convertiría en otra cosa sin que nadie lo viera.
  it("T-7b (AC-7): los OCHO caminos de respuesta responden [501,401,501,400,200,200,503,200] con sus cuerpos exactos", async () => {
    const withLedger = (status: SettlementLedgerStatus = "submitted") => {
      getLedgerMock.mockReturnValue(ledgerWith("ord-1", status));
    };
    const body = (o: Record<string, unknown>) => JSON.stringify(o);

    const cases: Array<{
      name: string;
      setup: () => void;
      raw: string;
      sig: (raw: string) => string | null;
      status: number;
      json: unknown;
    }> = [
      {
        name: "1 · sin TRANSFI_WEBHOOK_SECRET",
        setup: () => {
          vi.stubEnv("TRANSFI_WEBHOOK_SECRET", "");
          withLedger();
        },
        raw: body({ orderId: "ord-1", status: "fund_settled" }),
        sig: sign,
        status: 501,
        json: { error: "webhook_not_configured" },
      },
      {
        name: "2 · HMAC ausente",
        setup: withLedger,
        raw: body({ orderId: "ord-1", status: "fund_settled" }),
        sig: () => null,
        status: 401,
        json: { error: "webhook_unauthorized" },
      },
      {
        name: "3 · ledger apagado (getSettlementLedger ⇒ null)",
        setup: () => getLedgerMock.mockReturnValue(null),
        raw: body({ orderId: "ord-1", status: "fund_settled" }),
        sig: sign,
        status: 501,
        json: { error: "webhook_not_enabled" },
      },
      {
        name: "4 · JSON roto",
        setup: withLedger,
        raw: "no soy json {",
        sig: sign,
        status: 400,
        json: { error: "webhook_bad_request" },
      },
      {
        name: "5 · sin candidato de payoutId",
        setup: withLedger,
        raw: body({ status: "fund_settled" }),
        sig: sign,
        status: 200,
        json: { ok: true, ignored: "no_payout_id" },
      },
      {
        name: "6 · status no mapeado",
        setup: withLedger,
        raw: body({ orderId: "ord-1", status: "expired" }),
        sig: sign,
        status: 200,
        json: { ok: true, ignored: "unmapped_status" },
      },
      {
        name: "7 · el ledger tira",
        setup: () => {
          const ledger = ledgerWith("ord-1", "submitted");
          vi.spyOn(ledger, "recordWebhookOutcome").mockRejectedValue(new Error("db down"));
          getLedgerMock.mockReturnValue(ledger);
        },
        raw: body({ orderId: "ord-1", status: "fund_settled" }),
        sig: sign,
        status: 503,
        json: { error: "webhook_unavailable" },
      },
      {
        name: "8 · camino feliz",
        setup: withLedger,
        raw: body({ orderId: "ord-1", status: "fund_settled" }),
        sig: sign,
        status: 200,
        json: { ok: true },
      },
    ];

    const got: number[] = [];
    for (const c of cases) {
      vi.stubEnv("TRANSFI_WEBHOOK_SECRET", SECRET);
      getLedgerMock.mockReset();
      c.setup();
      const res = await POST(makeReq(c.raw, c.sig(c.raw)).req);
      expect({ name: c.name, status: res.status, json: await res.json() }).toEqual({
        name: c.name,
        status: c.status,
        json: c.json,
      });
      got.push(res.status);
    }
    expect(got).toEqual([501, 401, 501, 400, 200, 200, 503, 200]);
  });

  it("T-11a (AC-11): recordWebhookOutcome rechaza ⇒ 503 webhook_unavailable y el claim NO se llama (la key no se quema)", async () => {
    const ledger = ledgerWith("ord-1", "submitted");
    vi.spyOn(ledger, "recordWebhookOutcome").mockRejectedValue(new Error("db down"));
    getLedgerMock.mockReturnValue(ledger);
    const raw = fundFailed();
    const res = await POST(makeReq(raw, sign(raw)).req);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "webhook_unavailable" });
    expect(claimMock).not.toHaveBeenCalled();
    // Y no alerta: sin desenlace clasificado no hay nada que afirmar.
    expect(alertCount()).toBe(0);
  });
});
