// Tests — HttpSolanaSettlementGateway (HU-SOL-13/AC-1). Corre en el CLIENTE: jamás toca la URL del
// facilitador ni ve una credencial (CD-6). Signature base58 (NUNCA 0x-hex, CD-13); fail-closed.
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpSolanaSettlementGateway } from "./http-solana-settlement-gateway";

const SIGNATURE = bs58.encode(new Uint8Array(64).fill(7)); // signature base58 válida (64 bytes)
const input = {
  partialSignedTx: "AQIDBAU=", // base64
  reference: "So11111111111111111111111111111111111111112", // base58
  sender: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // base58
  remittanceId: "rem-1",
};

let fetchMock: ReturnType<typeof vi.fn>;
function responds(status: number, payload: unknown): void {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(payload), { status }));
}

describe("HttpSolanaSettlementGateway (HU-SOL-13)", () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("AC-1: llama a /api/settle/solana-sponsor (NUNCA al facilitador) con el payload; 200 {signature} base58 ⇒ ok", async () => {
    responds(200, { signature: SIGNATURE });
    const r = await new HttpSolanaSettlementGateway().settle(input);
    expect(r).toEqual({ ok: true, signature: SIGNATURE });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/settle/solana-sponsor");
    expect(url).not.toContain("facilitator");
    const sent = JSON.parse(init.body as string);
    expect(sent.partialSignedTx).toBe(input.partialSignedTx);
    expect(sent.reference).toBe(input.reference);
    expect(sent.remittanceId).toBe("rem-1");
  });

  it("mapea 422/429/409/502/503 a su SolanaSettlementFailureReason (fail-closed)", async () => {
    const cases: Array<[number, string | undefined, string]> = [
      [422, "solana_settle_rejected", "solana_settle_rejected"],
      [429, "solana_settle_rate_limited", "solana_settle_rate_limited"],
      [409, "solana_settle_broadcast_failed", "solana_settle_broadcast_failed"],
      [502, undefined, "solana_settle_broadcast_failed"],
      [503, undefined, "solana_settle_unavailable"],
    ];
    for (const [status, error, reason] of cases) {
      responds(status, error ? { error } : {});
      expect(await new HttpSolanaSettlementGateway().settle(input)).toEqual({ ok: false, reason });
    }
  });

  // S3.5 del settle: los tres desenlaces del chequeo de destino llegan con enums DISTINTOS y se
  // mapean a reasons distintos. Si los tres colapsaran en uno, la remesa fallada no podría decir si
  // el destino estaba mal o si no se pudo comprobar, que es justo lo que hay que poder distinguir.
  it("mapea los enums del chequeo de destino sin colapsarlos entre sí", async () => {
    const cases: Array<[number, string, string]> = [
      [409, "solana_settle_beneficiary_mismatch", "solana_settle_beneficiary_mismatch"],
      [409, "solana_settle_beneficiary_unregistered", "solana_settle_beneficiary_unconfirmed"],
      [400, "solana_settle_deposit_unreadable", "solana_settle_beneficiary_unconfirmed"],
      [503, "solana_settle_ledger_unavailable", "solana_settle_unavailable"],
    ];
    for (const [status, error, reason] of cases) {
      responds(status, { error });
      expect(await new HttpSolanaSettlementGateway().settle(input)).toEqual({ ok: false, reason });
    }
  });

  // 400/501 los emite NUESTRA route antes de reenviar nada: ahí sí se puede afirmar que la tx no salió.
  it("400/501 (la route cortó antes de reenviar) ⇒ rejected: el deposit nunca salió", async () => {
    for (const status of [400, 501]) {
      responds(status, { error: "solana_settle_invalid_request" });
      expect(await new HttpSolanaSettlementGateway().settle(input)).toEqual({
        ok: false,
        reason: "solana_settle_rejected",
      });
    }
  });

  // Antes esto esperaba "solana_settle_rejected", que le dice al use-case "se cortó ANTES de
  // broadcastear", o sea, "no hace falta ir a mirar la cadena". Pero un status que el mapa no conoce
  // no dice dónde se originó: puede haberlo puesto un intermediario después de que la route ya
  // reenvió, con el depósito ya confirmado. Bloquear se mantiene; afirmar de más, no.
  it("fail-closed: enum desconocido / status raro / body no-JSON ⇒ bloquea, y NO afirma que no salió (CD-12)", async () => {
    responds(500, { error: "un_enum_que_no_existe" });
    expect(await new HttpSolanaSettlementGateway().settle(input)).toEqual({
      ok: false,
      reason: "solana_settle_unavailable", // indeterminado: aguas arriba se le pregunta a la cadena
    });
    fetchMock.mockImplementation(async () => new Response("<html>", { status: 503 }));
    expect(await new HttpSolanaSettlementGateway().settle(input)).toEqual({
      ok: false,
      reason: "solana_settle_unavailable",
    });
  });

  it("CD-13: 200 con shape inválido / signature 0x-hex ⇒ solana_settle_unverified (un 200 NO es principal_in)", async () => {
    const bad: unknown[] = [
      {},
      null,
      { signature: 123 },
      { signature: "" },
      // 0x-hex NO es base58 válido (contiene 'x' fuera del alfabeto y es corto) ⇒ rechazado.
      { signature: "0xabc0000000000000000000000000000000000000000000000000000000000001" },
    ];
    for (const b of bad) {
      responds(200, b);
      expect(await new HttpSolanaSettlementGateway().settle(input)).toEqual({
        ok: false,
        reason: "solana_settle_unverified",
      });
    }
    fetchMock.mockImplementation(async () => new Response("no-json", { status: 200 }));
    expect(await new HttpSolanaSettlementGateway().settle(input)).toEqual({
      ok: false,
      reason: "solana_settle_unverified",
    });
  });

  it("fetch throw (red caída) ⇒ solana_settle_unavailable, sin propagar la excepción", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(new HttpSolanaSettlementGateway().settle(input)).resolves.toEqual({
      ok: false,
      reason: "solana_settle_unavailable",
    });
  });
});
