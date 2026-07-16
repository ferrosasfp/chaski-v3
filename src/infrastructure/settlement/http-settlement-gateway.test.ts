// Tests — HttpSettlementGateway (WKH-168 W4.2). Corre en el CLIENTE: jamás debe tocar la URL del
// facilitador ni ver una credencial (CD-4/AC-7).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Eip3009Authorization } from "../../application/ports";
import { HttpSettlementGateway } from "./http-settlement-gateway";

const TX = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
const SENDER = "0x1111111111111111111111111111111111111111";
const RECEIVER = "0x2222222222222222222222222222222222222222";
const VALUE = 400_000_000;

const authorization: Eip3009Authorization = {
  from: SENDER,
  to: RECEIVER,
  value: String(VALUE),
  validAfter: "0",
  validBefore: "1783036800",
  nonce: "0xbbbb000000000000000000000000000000000000000000000000000000000002",
};
const input = {
  authorization,
  signature: "0xdeadbeef",
  address: SENDER,
  quoteId: "q-400",
  expectedValueMinor: VALUE,
};

let fetchMock: ReturnType<typeof vi.fn>;
function responds(status: number, payload: unknown): void {
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify(payload), { status }), // Response NUEVA por llamada
  );
}

describe("HttpSettlementGateway (WKH-168)", () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("AC-7: llama a /api/settle/principal (NUNCA al facilitador) con el payload canónico serializable", async () => {
    responds(200, { txHash: TX, valueMinor: VALUE, to: RECEIVER, from: SENDER, attestation: "att" });
    const r = await new HttpSettlementGateway().settle(input);
    expect(r).toEqual({
      ok: true,
      txHash: TX,
      valueMinor: VALUE,
      to: RECEIVER,
      from: SENDER,
      attestation: "att",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/settle/principal");
    expect(url).not.toContain("facilitator");
    const sent = JSON.parse(init.body as string);
    expect(sent.authorization).toEqual(authorization);
    expect(sent.expectedValueMinor).toBe(VALUE);
    // CD-16: todo string canónico ⇒ JSON.stringify no puede tirar TypeError por un bigint.
    expect(typeof sent.authorization.value).toBe("string");
  });

  it("mapea cada enum de error de la ruta a su SettlementFailureReason", async () => {
    const cases: Array<[number, string, string]> = [
      [400, "settle_amount_mismatch", "settlement_amount_mismatch"],
      [400, "settle_receiver_mismatch", "settlement_receiver_mismatch"],
      [502, "settle_reverted", "settlement_reverted"],
      [503, "settle_unverified", "settlement_unverified"],
      [502, "settle_rejected", "settlement_rejected"],
      [400, "settle_sender_mismatch", "settlement_rejected"],
      [503, "settle_unavailable", "settlement_unavailable"],
      [409, "settle_in_flight", "settlement_unavailable"],
    ];
    for (const [status, error, reason] of cases) {
      responds(status, { error });
      const r = await new HttpSettlementGateway().settle(input);
      expect(r).toEqual({ ok: false, reason });
    }
  });

  it("fail-closed: enum desconocido / body no-JSON / status raro ⇒ bloquea, nunca ok:true (CD-12)", async () => {
    responds(501, { error: "settle_not_enabled" });
    expect(await new HttpSettlementGateway().settle(input)).toEqual({
      ok: false,
      reason: "settlement_rejected",
    });
    // Enum NUEVO que este cliente no conoce ⇒ bloquea igual (lección WKH-198).
    responds(500, { error: "un_enum_que_no_existe_todavia" });
    expect(await new HttpSettlementGateway().settle(input)).toEqual({
      ok: false,
      reason: "settlement_rejected",
    });
    // Error sin body JSON.
    fetchMock.mockImplementation(async () => new Response("<html>", { status: 503 }));
    expect(await new HttpSettlementGateway().settle(input)).toEqual({
      ok: false,
      reason: "settlement_unavailable",
    });
  });

  it("CD-10: 200 con shape inválido ⇒ settlement_unverified (un 200 NO es un principal_in)", async () => {
    const bad: unknown[] = [
      {},
      null,
      { txHash: "0x123", valueMinor: VALUE, to: RECEIVER, from: SENDER, attestation: "att" },
      { txHash: TX, valueMinor: "400", to: RECEIVER, from: SENDER, attestation: "att" },
      { txHash: TX, valueMinor: VALUE, to: RECEIVER, from: SENDER, attestation: "" },
      { txHash: TX, valueMinor: 0, to: RECEIVER, from: SENDER, attestation: "att" },
    ];
    for (const b of bad) {
      responds(200, b);
      expect(await new HttpSettlementGateway().settle(input)).toEqual({
        ok: false,
        reason: "settlement_unverified",
      });
    }
    fetchMock.mockImplementation(async () => new Response("no-json", { status: 200 }));
    expect(await new HttpSettlementGateway().settle(input)).toEqual({
      ok: false,
      reason: "settlement_unverified",
    });
  });

  it("fetch throw (red caída) ⇒ settlement_unavailable, sin propagar la excepción", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(new HttpSettlementGateway().settle(input)).resolves.toEqual({
      ok: false,
      reason: "settlement_unavailable",
    });
  });
});
