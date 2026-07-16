// Tests — POST /api/settle/principal (WKH-168 W2.3, ramas S1-S21 + composición).
// vi.mock del onchain-verifier (Exemplar 6) + fetch stubeado para las ramas del facilitador: cero
// RPC, cero cadena, cero HTTP real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { verifyMock } = vi.hoisted(() => ({ verifyMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/settlement/onchain-verifier", () => ({
  verifySettlementOnChain: verifyMock,
}));

import { verifySettlementAttestation } from "../../../../src/infrastructure/settlement/attestation";
import { POST } from "./route";

const RECEIVER = "0x2222222222222222222222222222222222222222";
const SENDER = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x3333333333333333333333333333333333333333";
const USDC = "0x5425890298aed601595a70ab815c96711a31bc65";
const TX = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
const NONCE = "0xbbbb000000000000000000000000000000000000000000000000000000000002";
const VALUE = 400_000_000;

function authorization(over: Record<string, unknown> = {}) {
  return {
    from: SENDER,
    to: RECEIVER,
    value: String(VALUE),
    validAfter: "0",
    validBefore: "1783036800",
    nonce: NONCE,
    ...over,
  };
}
function body(over: Record<string, unknown> = {}) {
  return {
    authorization: authorization(),
    signature: "0xdeadbeef",
    address: SENDER,
    quoteId: "q-400",
    expectedValueMinor: VALUE,
    ...over,
  };
}
function req(payload: unknown): Request {
  return new Request("https://chaski.test/api/settle/principal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
/** Body crudo (para el literal `null`, que JSON.stringify no distingue de "sin body"). */
function rawReq(raw: string): Request {
  return new Request("https://chaski.test/api/settle/principal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/** mockImplementation (NO mockResolvedValue): el body de un Response se consume en la primera
 *  lectura → reusar la MISMA instancia en varios POST hace que el 2º res.json() tire y la ruta caiga
 *  en settle_unverified/502 por la razón EQUIVOCADA (falso verde). Cada llamada → Response nueva. */
function facilitatorResponds(status: number, payload: unknown = {}): void {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("POST /api/settle/principal (WKH-168)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true");
    vi.stubEnv("FACILITATOR_BASE_URL", "https://facilitator.test");
    vi.stubEnv("FACILITATOR_API_KEY", "secret-key-123");
    vi.stubEnv("NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS", RECEIVER);
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS", USDC);
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "43113");
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", "att-secret");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    verifyMock.mockReset();
    verifyMock.mockResolvedValue({
      ok: true,
      txHash: TX,
      from: SENDER,
      to: RECEIVER,
      valueMinor: VALUE,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ── Happy path + composición ───────────────────────────────────────────────
  it("S21+V9: broadcast OK + verificación OK ⇒ 200 con atestación VERIFICABLE y el txHash verificado", async () => {
    facilitatorResponds(200, { settled: true, transactionHash: TX });
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.txHash).toBe(TX);
    expect(json.valueMinor).toBe(VALUE);

    // La atestación es real: verifica con el secreto y ata txHash/valor/sender.
    const att = verifySettlementAttestation(json.attestation, Date.now());
    expect(att).not.toBeNull();
    expect(att?.txHash).toBe(TX);
    expect(att?.valueMinor).toBe(VALUE);
    expect(att?.from.toLowerCase()).toBe(SENDER);
    expect(att?.quoteId).toBe("q-400");
  });

  it("AC-7: el fetch al facilitador lleva Bearer y el contrato exacto (accepted de ENV, no del body)", async () => {
    facilitatorResponds(200, { settled: true, transactionHash: TX });
    // El atacante intenta redirigir el payTo/asset por el body: se IGNORA (CD-9).
    await POST(req(body({ payTo: ATTACKER, asset: ATTACKER, network: "eip155:1" })));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://facilitator.test/settle");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-key-123");
    const sent = JSON.parse(init.body as string);
    expect(sent.x402Version).toBe(2); // el NÚMERO 2 (z.literal(2)), no "2"
    expect(sent.accepted.payTo.toLowerCase()).toBe(RECEIVER); // env, NO el body
    expect(sent.accepted.asset.toLowerCase()).toBe(USDC); // env, NO el body
    expect(sent.accepted.network).toBe("eip155:43113"); // env, NO el body
    expect(sent.accepted.amount).toBe(String(VALUE));
    expect(sent.accepted.extra.assetTransferMethod).toBe("eip3009");
    expect(sent.payload.authorization.nonce).toBe(NONCE);
  });

  it("AC-7/CD-17: la respuesta al cliente NUNCA contiene la API key, la base URL ni el RPC", async () => {
    vi.stubEnv("AVALANCHE_RPC_URL", "https://secret-rpc.example/KEY123");
    facilitatorResponds(200, { settled: true, transactionHash: TX });
    const res = await POST(req(body()));
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain("secret-key-123");
    expect(raw).not.toContain("facilitator.test");
    expect(raw).not.toContain("secret-rpc.example");
    expect(raw).not.toContain("0xdeadbeef"); // ni la signature
  });

  // ── S1/S2/S3 — config ──────────────────────────────────────────────────────
  it("S1: flag OFF (default) ⇒ 501 settle_not_enabled y NINGÚN fetch (CD-1: construye, no enciende)", async () => {
    vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "");
    const res = await POST(req(body()));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "settle_not_enabled" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("S2: sin FACILITATOR_BASE_URL/API_KEY ⇒ 501 settle_not_configured, NINGÚN fetch", async () => {
    vi.stubEnv("FACILITATOR_BASE_URL", "");
    expect((await POST(req(body()))).status).toBe(501);
    vi.stubEnv("FACILITATOR_BASE_URL", "https://facilitator.test");
    vi.stubEnv("FACILITATOR_API_KEY", "");
    const res = await POST(req(body()));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "settle_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S3: receiver/usdc malformados ⇒ 500 settle_misconfigured CAPTURADO (nunca un 500 crudo)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS", "0xNOT_AN_ADDRESS");
    const res = await POST(req(body()));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "settle_misconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── S4-S10 — formato (CD-15/CD-16) ─────────────────────────────────────────
  it("S4: body no-record (null literal, array, número, string) ⇒ 400, NINGÚN fetch", async () => {
    for (const raw of ["null", "[]", "123", '"s"', "not-json"]) {
      const res = await POST(rawReq(raw));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "settle_invalid_request" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S5: authorization ausente/no-record, o un campo faltante/no-string ⇒ 400 (PROHIBIDO String(x))", async () => {
    const cases: unknown[] = [
      body({ authorization: undefined }),
      body({ authorization: "x" }),
      body({ authorization: [] }),
      body({ authorization: authorization({ from: undefined }) }),
      body({ authorization: authorization({ value: 400000000 }) }), // number, NO string → 400
      body({ authorization: authorization({ nonce: null }) }),
    ];
    for (const c of cases) {
      expect((await POST(req(c))).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S6: signature no-hex ⇒ 400, NINGÚN fetch", async () => {
    for (const sig of ["", "deadbeef", "0xZZ", 123]) {
      expect((await POST(req(body({ signature: sig })))).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S7: nonce que no es bytes32 exacto ⇒ 400", async () => {
    for (const n of ["0x1234", `${NONCE}ff`, "0xZZZ", ""]) {
      expect((await POST(req(body({ authorization: authorization({ nonce: n }) })))).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S8: uint256 no canónico ('01', '-1', '1e2', '', ' 1 ') ⇒ 400 — SIN trim (WKH-204)", async () => {
    for (const v of ["01", "-1", "1e2", "", " 1 ", "0x10", "1.5"]) {
      expect((await POST(req(body({ authorization: authorization({ value: v }) })))).status).toBe(400);
      expect(
        (await POST(req(body({ authorization: authorization({ validBefore: v }) })))).status,
      ).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S9: address ausente/vacía/malformada ⇒ 400", async () => {
    for (const a of [undefined, "", "   ", "0xNOPE", 42]) {
      expect((await POST(req(body({ address: a })))).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S10: expectedValueMinor no entero >= 1 ('400', 0, -1, 1.5, NaN, null) ⇒ 400 (PROHIBIDO Number(x))", async () => {
    for (const v of ["400000000", 0, -1, 1.5, Number.NaN, null, undefined]) {
      const res = await POST(req(body({ expectedValueMinor: v })));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "settle_invalid_request" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── S11-S13 — binding (el corazón del anti-tampering pre-broadcast) ─────────
  it("S11: value ≠ expectedValueMinor (incl. SOBRE-pago) ⇒ 400 settle_amount_mismatch, NINGÚN fetch", async () => {
    // Igualdad EXACTA: más estrictos que el >= del facilitador (base-adapter.ts:609).
    const over = await POST(req(body({ authorization: authorization({ value: String(VALUE + 1) }) })));
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({ error: "settle_amount_mismatch" });
    const under = await POST(req(body({ authorization: authorization({ value: "1" }) })));
    expect(under.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S12: authorization.to ≠ receiver de ENV ⇒ 400 settle_receiver_mismatch, NINGÚN fetch (CD-9)", async () => {
    const res = await POST(req(body({ authorization: authorization({ to: ATTACKER }) })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "settle_receiver_mismatch" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S13: authorization.from ≠ address declarada ⇒ 400 settle_sender_mismatch, NINGÚN fetch", async () => {
    const res = await POST(req(body({ authorization: authorization({ from: ATTACKER }) })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "settle_sender_mismatch" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── S14-S20 — mapa de errores del facilitador (CD-12 no-oracle) ─────────────
  it("S14/S15: 401/403/400 del facilitador ⇒ 502 settle_rejected, sin ecoar su motivo (CD-12)", async () => {
    for (const st of [401, 403, 400]) {
      facilitatorResponds(st, { code: "FORBIDDEN", message: "payTo not permitted" });
      const res = await POST(req(body()));
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json).toEqual({ error: "settle_rejected" });
      expect(JSON.stringify(json)).not.toContain("payTo not permitted"); // no-oracle
    }
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("S16: 409 CONFLICT ⇒ 409 settle_in_flight (el cliente NO debe re-firmar, DT-6)", async () => {
    facilitatorResponds(409, { code: "CONFLICT" });
    const res = await POST(req(body()));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "settle_in_flight" });
  });

  it("S17: 429/503 (RATE_LIMITED, CHAIN_UNAVAILABLE, OPERATOR_FUNDING_LOW) ⇒ 503 settle_unavailable (AC-3)", async () => {
    for (const st of [429, 503]) {
      facilitatorResponds(st, { code: "OPERATOR_FUNDING_LOW" });
      const res = await POST(req(body()));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "settle_unavailable" });
    }
  });

  it("S18/S19: 500 TRANSACTION_FAILED ⇒ 502 settle_reverted; fetch throw/timeout ⇒ 503, nunca 200", async () => {
    facilitatorResponds(500, { code: "TRANSACTION_FAILED" });
    const rev = await POST(req(body()));
    expect(rev.status).toBe(502);
    expect(await rev.json()).toEqual({ error: "settle_reverted" });

    // S19 — ambiguo (la tx PUDO minarse) ⇒ fail-closed. El reintento con el MISMO nonce es seguro.
    fetchMock.mockRejectedValue(new Error("timeout"));
    const to = await POST(req(body()));
    expect(to.status).toBe(503);
    expect(await to.json()).toEqual({ error: "settle_unavailable" });
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("S20: 200 con shape malo (settled≠true, txHash inválido, no-JSON) ⇒ 502 settle_unverified — el 200 NO basta", async () => {
    const cases: unknown[] = [
      { settled: false, transactionHash: TX },
      { settled: true },
      { settled: true, transactionHash: "0x123" },
      { settled: "true", transactionHash: TX },
      {},
    ];
    for (const c of cases) {
      facilitatorResponds(200, c);
      const res = await POST(req(body()));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "settle_unverified" });
    }
    // 200 con body no-JSON.
    fetchMock.mockImplementation(async () => new Response("<html>", { status: 200 }));
    expect((await POST(req(body()))).status).toBe(502);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  // ── V — la verificación manda sobre el 200 del facilitador (CD-10) ──────────
  it("CD-10: 200 {settled:true} del facilitador pero la CADENA dice otra cosa ⇒ NO hay atestación", async () => {
    facilitatorResponds(200, { settled: true, transactionHash: TX });
    // El facilitador jura que settleó; el log on-chain dice que el USDC fue a otro lado.
    verifyMock.mockResolvedValue({ ok: false, reason: "settle_receiver_mismatch" });
    const mism = await POST(req(body()));
    expect(mism.status).toBe(502);
    expect(await mism.json()).toEqual({ error: "settle_receiver_mismatch" });

    verifyMock.mockResolvedValue({ ok: false, reason: "settle_amount_mismatch" });
    expect((await POST(req(body()))).status).toBe(502);

    verifyMock.mockResolvedValue({ ok: false, reason: "settle_reverted" });
    expect((await POST(req(body()))).status).toBe(502);

    // No verificable (sin RPC / RPC caído) ⇒ 503: sin poder verificar, NO se atestigua.
    verifyMock.mockResolvedValue({ ok: false, reason: "settle_unverified" });
    const unv = await POST(req(body()));
    expect(unv.status).toBe(503);
    expect(await unv.json()).toEqual({ error: "settle_unverified" });
  });

  it("CD-21: el verificador recibe el txHash + el receiver de ENV (no el del body) y no sabe quién broadcasteó", async () => {
    facilitatorResponds(200, { settled: true, transactionHash: TX });
    await POST(req(body()));
    expect(verifyMock).toHaveBeenCalledWith({
      txHash: TX,
      expectedFrom: SENDER,
      expectedTo: RECEIVER, // de env
      expectedValueMinor: VALUE,
    });
    const arg = verifyMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(
      ["expectedFrom", "expectedTo", "expectedValueMinor", "txHash"].sort(),
    );
  });

  it("fail-closed: sin SETTLE_ATTESTATION_SECRET no se inventa atestación ⇒ 500 settle_misconfigured", async () => {
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", "");
    facilitatorResponds(200, { settled: true, transactionHash: TX });
    const res = await POST(req(body()));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "settle_misconfigured" });
  });
});
