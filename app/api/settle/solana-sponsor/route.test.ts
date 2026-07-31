// Tests — POST /api/settle/solana-sponsor (HU-SOL-13/AC-1, MNR-1). Cubre la lógica security-relevant
// del route server-only: flag OFF/config faltante → 501; body inválido (no base58/base64) → 400; y el
// contrato del forward al facilitador (el `Authorization: Bearer` se inyecta SERVER-SIDE y el secreto
// NUNCA se ecoa al cliente). Espeja el patrón del test EVM app/api/settle/principal/route.test.ts:
// fetch stubeado, cero HTTP real, cero red, cero cadena.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// WKH-213/R3: el route ahora persiste la signature en el ledger (best-effort). getLedgerMock devuelve
// null por default ⇒ TODOS los tests previos quedan byte-idénticos (flag OFF = skip total).
const { getLedgerMock } = vi.hoisted(() => ({ getLedgerMock: vi.fn(() => null as unknown) }));
vi.mock("../../../../src/infrastructure/persistence/supabase-settlement-ledger", () => ({
  getSettlementLedger: getLedgerMock,
}));
import { FakeSettlementLedger, FAKE_SOLANA_BENEFICIARY, FAKE_SOLANA_REFERENCE, FAKE_SOLANA_SIGNATURE } from "../../../../src/test-support/fakes";
import { POST } from "./route";

const SENDER = FAKE_SOLANA_BENEFICIARY; // base58 devnet (44 chars)
const REFERENCE = FAKE_SOLANA_REFERENCE; // base58 (43 chars)
const PARTIAL_TX = "AQIDBAUGBwg="; // base64 estándar (partialSignedTx serializada)
const API_KEY = "sol-secret-key-123";
const BASE = "https://facilitator.test";

function body(over: Record<string, unknown> = {}) {
  return {
    partialSignedTx: PARTIAL_TX,
    reference: REFERENCE,
    sender: SENDER,
    remittanceId: "rem-sol-1",
    ...over,
  };
}
function req(payload: unknown): Request {
  return new Request("https://chaski.test/api/settle/solana-sponsor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
/** Body crudo (para el literal `null`, que JSON.stringify no distingue de "sin body"). */
function rawReq(raw: string): Request {
  return new Request("https://chaski.test/api/settle/solana-sponsor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/** mockImplementation (NO mockResolvedValue): el body de un Response se consume en la primera lectura;
 *  cada llamada → Response nueva (mismo criterio que el test EVM). */
function facilitatorResponds(status: number, payload: unknown = {}): void {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("POST /api/settle/solana-sponsor (HU-SOL-13)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_SETTLE_ENABLED", "true");
    vi.stubEnv("FACILITATOR_BASE_URL", BASE);
    vi.stubEnv("FACILITATOR_API_KEY", API_KEY);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    getLedgerMock.mockReset();
    getLedgerMock.mockReturnValue(null); // sin ledger: comportamiento previo, byte-idéntico
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ── (a) flag OFF ────────────────────────────────────────────────────────────
  it("S1: flag OFF (default) ⇒ 501 solana_settle_not_enabled y NINGÚN fetch (CD-5: construye, no enciende)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_SETTLE_ENABLED", "");
    const res = await POST(req(body()));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "solana_settle_not_enabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── (b) config faltante ──────────────────────────────────────────────────────
  it("S2: sin FACILITATOR_BASE_URL/API_KEY ⇒ 501 solana_settle_not_configured, NINGÚN fetch (CD-6)", async () => {
    vi.stubEnv("FACILITATOR_BASE_URL", "");
    expect((await POST(req(body()))).status).toBe(501);
    vi.stubEnv("FACILITATOR_BASE_URL", BASE);
    vi.stubEnv("FACILITATOR_API_KEY", "");
    const res = await POST(req(body()));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "solana_settle_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── (c) body inválido (no base58/base64) ─────────────────────────────────────
  it("S3: body no-record (null literal, array, número, string, no-json) ⇒ 400, NINGÚN fetch", async () => {
    for (const raw of ["null", "[]", "123", '"s"', "not-json"]) {
      const res = await POST(rawReq(raw));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "solana_settle_invalid_request" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S3: partialSignedTx no-base64, reference/sender no-base58, remittanceId vacío ⇒ 400, NINGÚN fetch", async () => {
    const cases: Record<string, unknown>[] = [
      { partialSignedTx: "no base64 !!" }, // espacio + '!' fuera del alfabeto base64
      { partialSignedTx: 123 }, // no-string
      { reference: "0OIl_not_base58" }, // 0,O,I,l no están en el alfabeto base58
      { reference: "abc" }, // muy corto (< 32)
      { sender: "0xNOTb58" }, // '0' no base58 + longitud
      { sender: null },
      { remittanceId: "" },
      { remittanceId: "   " },
      { remittanceId: 42 },
    ];
    for (const over of cases) {
      const res = await POST(req(body(over)));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "solana_settle_invalid_request" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── (d) el Bearer se inyecta SERVER-SIDE; el secreto NUNCA se expone al cliente ──
  it("AC-1/CD-6: el forward al facilitador lleva Authorization Bearer (server-side) al endpoint /solana/sponsor", async () => {
    facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
    await POST(req(body({ popProof: "pop-proof-xyz" })));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/solana/sponsor`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    const sent = JSON.parse(init.body as string);
    expect(sent.partialSignedTx).toBe(PARTIAL_TX);
    expect(sent.reference).toBe(REFERENCE);
    expect(sent.sender).toBe(SENDER);
    expect(sent.remittanceId).toBe("rem-sol-1");
    expect(sent.popProof).toBe("pop-proof-xyz");
  });

  it("CD-6/CD-12: 200 OK ⇒ devuelve SOLO la signature; la API key y la base URL NUNCA se ecoan al cliente", async () => {
    facilitatorResponds(200, {
      signature: FAKE_SOLANA_SIGNATURE,
      secret: API_KEY, // el facilitador podría filtrar de más — el route NO lo reenvía
    });
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ signature: FAKE_SOLANA_SIGNATURE });
    const raw = JSON.stringify(json);
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain("facilitator.test");
  });

  it("CD-12 no-oracle: error del facilitador (422/429/409/5xx) ⇒ map opaco sin ecoar su motivo", async () => {
    const map: Array<[number, number, string]> = [
      [422, 422, "solana_settle_rejected"],
      [429, 429, "solana_settle_rate_limited"],
      [409, 502, "solana_settle_broadcast_failed"],
      [502, 502, "solana_settle_broadcast_failed"],
      [500, 503, "solana_settle_unavailable"],
    ];
    for (const [upstream, expected, error] of map) {
      facilitatorResponds(upstream, { message: "internal facilitator detail LEAK" });
      const res = await POST(req(body()));
      expect(res.status).toBe(expected);
      const json = await res.json();
      expect(json).toEqual({ error });
      expect(JSON.stringify(json)).not.toContain("LEAK");
    }
  });

  it("fail-closed: fetch throw/timeout ⇒ 503 solana_settle_unavailable (nunca un 500 crudo)", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));
    const res = await POST(req(body()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "solana_settle_unavailable" });
  });

  it("S5: 200 con signature ausente/no-base58 ⇒ 502 solana_settle_broadcast_failed (el 200 NO basta)", async () => {
    for (const sig of [undefined, "", "0OIl", 123]) {
      facilitatorResponds(200, { signature: sig });
      const res = await POST(req(body()));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "solana_settle_broadcast_failed" });
    }
  });

  // ── WKH-213/R3 · la remesa YA NO muere 'prepared' ────────────────────────────────────────────────
  // Antes de esto, el settle no escribía NADA al ledger: la fila nacía 'prepared' en
  // /api/payout/prepare y se quedaba ahí para siempre, así que ninguna superficie podía decir nada de
  // la remesa. Se mide el ESTADO FINAL de la fila, no que se llamó a una función.
  async function ledgerWithPreparedSolana(): Promise<FakeSettlementLedger> {
    const ledger = new FakeSettlementLedger("2026-07-28T00:00:00.000Z");
    await ledger.recordOrderPrepared({
      remittanceId: "rem-sol-1", // el MISMO remittanceId que manda el body()
      quoteId: "q-sol",
      idempotencyKey: "rem-sol-1:q-sol",
      depositAddress: FAKE_SOLANA_REFERENCE,
      chainId: 43113,
      senderAddress: SENDER,
      payoutId: "transfi-po-sol",
      vm: "solana",
    });
    return ledger;
  }

  it("R3: 200 del sponsor ⇒ la fila 'prepared' de esa remesa queda en principal_in con la signature", async () => {
    const ledger = await ledgerWithPreparedSolana();
    getLedgerMock.mockReturnValue(ledger);
    facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signature: FAKE_SOLANA_SIGNATURE });
    const row = [...ledger.store.values()][0]!;
    expect(row.status).toBe("principal_in"); // ← antes: 'prepared', siempre
    expect(row.txHash).toBe(FAKE_SOLANA_SIGNATURE); // la firma verificada on-chain, en el ledger
    expect(row.payoutId).toBe("transfi-po-sol"); // intacto
  });

  it("R3: una respuesta NO-ok del sponsor no escribe nada (la fila sigue 'prepared')", async () => {
    const ledger = await ledgerWithPreparedSolana();
    getLedgerMock.mockReturnValue(ledger);
    facilitatorResponds(422, { error: "SPONSOR_REJECTED" });
    const res = await POST(req(body()));
    expect(res.status).toBe(422);
    expect([...ledger.store.values()][0]!.status).toBe("prepared"); // sin broadcast no hay evidencia
  });

  it("CD-17: si el ledger TIRA, el money-path responde IGUAL (200 con la signature)", async () => {
    const ledger = await ledgerWithPreparedSolana();
    vi.spyOn(ledger, "recordSolanaPrincipalIn").mockRejectedValue(new Error("db down"));
    getLedgerMock.mockReturnValue(ledger);
    vi.spyOn(console, "error").mockImplementation(() => {});
    facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signature: FAKE_SOLANA_SIGNATURE });
  });

  it("flag OFF (ledger null) ⇒ respuesta byte-idéntica, sin tocar la DB", async () => {
    getLedgerMock.mockReturnValue(null);
    facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signature: FAKE_SOLANA_SIGNATURE });
  });
});
