// Tests — SupabaseSettlementLedger + getSettlementLedger (WKH-207 W1). Mockea el query-builder de
// Supabase (chainable): cero red, cero DB. Cubre AC-4 (listStale), AC-9 (owner-scope), CD-12
// (value_minor::text) y AC-10 (factory null-safe).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseSettlementLedger, getSettlementLedger } from "./supabase-settlement-ledger";
import { __resetSupabaseClient, getSupabaseServerClient } from "./supabase-server";

// Registra cada método del builder + resuelve un resultado por cada from() (queue). El builder es
// thenable ⇒ `await builder` resuelve el resultado asignado a ese from().
interface Calls {
  from: unknown[];
  select: unknown[][];
  upsert: unknown[][];
  update: unknown[][];
  eq: unknown[][];
  in: unknown[][];
  lt: unknown[][];
  limit: unknown[][];
  single: unknown[][];
}
function makeClient(results: Array<{ data: unknown; error: unknown }>): {
  client: SupabaseClient;
  calls: Calls;
} {
  const calls: Calls = {
    from: [],
    select: [],
    upsert: [],
    update: [],
    eq: [],
    in: [],
    lt: [],
    limit: [],
    single: [],
  };
  let i = 0;
  const client = {
    from: vi.fn((table: string) => {
      calls.from.push(table);
      const result = results[i++] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      const chain = (name: keyof Calls) =>
        vi.fn((...args: unknown[]) => {
          (calls[name] as unknown[][]).push(args);
          return builder;
        });
      builder.select = chain("select");
      builder.upsert = chain("upsert");
      builder.update = chain("update");
      builder.eq = chain("eq");
      builder.in = chain("in");
      builder.lt = chain("lt");
      builder.limit = chain("limit");
      builder.single = chain("single");
      // thenable: awaitar cualquier terminal resuelve el resultado de este from().
      builder.then = (resolve: (v: unknown) => void) => resolve(result);
      return builder;
    }),
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const SENDER = "0xAbCabcABCabcABCabcABCabcABCabcABCabcABC11";

describe("SupabaseSettlementLedger (WKH-207)", () => {
  it("AC-4/CD-12: listStale selecciona value_minor::text, filtra por status no-terminal + updated_at < umbral, y parsea el monto uint256-safe", async () => {
    const raw = {
      id: "id-1",
      remittance_id: "rem-1",
      quote_id: "q-1",
      idempotency_key: "rem-1:q-1",
      tx_hash: "0xtx",
      chain_id: 43113,
      sender_address: "0xsender",
      receiver_address: "0xreceiver",
      // > 2^53: un JSON.parse crudo lo redondearía (WKH-196). Llega como STRING por el ::text.
      value_minor: "90071992547409910",
      status: "principal_in",
      attempts: 0,
      payout_id: null,
      last_error: null,
      created_at: "2026-07-16T00:00:00.000Z",
      updated_at: "2026-07-16T00:00:00.000Z",
    };
    const { client, calls } = makeClient([{ data: [raw], error: null }]);
    const ledger = new SupabaseSettlementLedger(client);
    const out = await ledger.listStale({ olderThanIso: "2026-07-16T01:00:00.000Z", limit: 50 });

    // CD-12: el select DEBE contener value_minor::text.
    expect(String(calls.select[0]?.[0])).toContain("value_minor::text");
    // AC-4: filtro por status no-terminal + updated_at < umbral.
    expect(calls.in[0]?.[0]).toBe("status");
    expect(calls.in[0]?.[1]).toEqual(["principal_in", "submitted", "forward_error"]);
    expect(calls.lt[0]).toEqual(["updated_at", "2026-07-16T01:00:00.000Z"]);
    expect(calls.limit[0]).toEqual([50]);
    // El monto se parsea a number desde el string ::text.
    expect(out[0]?.valueMinor).toBe(90071992547409910);
    expect(out[0]?.remittanceId).toBe("rem-1");
  });

  it("AC-9/CD-9: recordPayoutOutcome es owner-scoped — filtra por idempotency_key Y sender_address (lowercased)", async () => {
    const { client, calls } = makeClient([{ data: null, error: null }]);
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordPayoutOutcome({
      idempotencyKey: "rem-1:q-1",
      senderAddress: SENDER,
      status: "settled",
      payoutId: "p-1",
    });
    // El UPDATE cruza AMBOS filtros: sin el sender_address, otro owner podría mutar esta fila (IDOR).
    expect(calls.eq).toContainEqual(["idempotency_key", "rem-1:q-1"]);
    expect(calls.eq).toContainEqual(["sender_address", SENDER.toLowerCase()]);
    // El patch lleva el status mapeado.
    expect((calls.update[0]?.[0] as Record<string, unknown>).status).toBe("settled");
  });

  it("recordPrincipalIn: upsert idempotente por tx_hash (ignoreDuplicates) con addresses lowercased y value_minor string", async () => {
    const { client, calls } = makeClient([{ data: null, error: null }]);
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordPrincipalIn({
      remittanceId: "rem-1",
      quoteId: "q-1",
      idempotencyKey: "rem-1:q-1",
      txHash: "0xTX",
      chainId: 43113,
      senderAddress: SENDER,
      receiverAddress: "0xREceiverAddr2222222222222222222222222222",
      valueMinor: 400_000_000,
    });
    const row = calls.upsert[0]?.[0] as Record<string, unknown>;
    const opts = calls.upsert[0]?.[1] as Record<string, unknown>;
    expect(row.status).toBe("principal_in");
    expect(row.sender_address).toBe(SENDER.toLowerCase());
    expect(row.receiver_address).toBe("0xreceiveraddr2222222222222222222222222222");
    expect(row.value_minor).toBe("400000000"); // string (uint256-safe)
    expect(opts).toEqual({ onConflict: "tx_hash", ignoreDuplicates: true });
  });

  it("markOutcome con incrementAttempt: lee attempts y escribe attempts+1 + status", async () => {
    // 1º from() = select attempts (single); 2º from() = update.
    const { client, calls } = makeClient([
      { data: { attempts: 2 }, error: null },
      { data: null, error: null },
    ]);
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.markOutcome({ id: "id-1", status: "manual_review", incrementAttempt: true });
    const patch = calls.update[0]?.[0] as Record<string, unknown>;
    expect(patch.attempts).toBe(3);
    expect(patch.status).toBe("manual_review");
    expect(calls.eq).toContainEqual(["id", "id-1"]);
  });

  it("propaga error de Supabase como throw (best-effort lo captura la ruta)", async () => {
    const { client } = makeClient([{ data: null, error: { code: "PGRST000" } }]);
    const ledger = new SupabaseSettlementLedger(client);
    await expect(
      ledger.recordPayoutOutcome({
        idempotencyKey: "k",
        senderAddress: SENDER,
        status: "settled",
      }),
    ).rejects.toThrow();
  });
});

describe("getSettlementLedger factory (WKH-207 AC-10/CD-14)", () => {
  beforeEach(() => {
    __resetSupabaseClient();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetSupabaseClient();
  });

  it("flag OFF ⇒ null (byte-idéntico, aunque las envs estén)", () => {
    vi.stubEnv("SETTLEMENT_LEDGER_ENABLED", "");
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc");
    expect(getSettlementLedger()).toBeNull();
  });

  it("flag ON pero envs de Supabase ausentes ⇒ null (degrada con gracia)", () => {
    vi.stubEnv("SETTLEMENT_LEDGER_ENABLED", "true");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(getSettlementLedger()).toBeNull();
  });

  it("flag ON + envs presentes ⇒ instancia del ledger", () => {
    vi.stubEnv("SETTLEMENT_LEDGER_ENABLED", "true");
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc");
    expect(getSettlementLedger()).toBeInstanceOf(SupabaseSettlementLedger);
  });

  // BLQ-MED-1 (AR): createClient() LANZA sincrónicamente ante una URL malformada. Como se construye
  // fuera del try/catch best-effort de las rutas, sin este guard sería un 500 crudo que tumba el
  // money-path. Con el guard, degrada a null (byte-idéntico OFF) igual que envs ausentes.
  it("flag ON + SUPABASE_URL malformada (sin scheme) ⇒ null (NO lanza, degrada como OFF)", () => {
    vi.stubEnv("SETTLEMENT_LEDGER_ENABLED", "true");
    vi.stubEnv("SUPABASE_URL", "abc.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc");
    expect(getSettlementLedger()).toBeNull();
  });
});

describe("getSupabaseServerClient (WKH-207 BLQ-MED-1 — null-safe ante URL inválida)", () => {
  beforeEach(() => {
    __resetSupabaseClient();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetSupabaseClient();
  });

  it("SUPABASE_URL malformada (sin scheme) ⇒ null, NO lanza", () => {
    vi.stubEnv("SUPABASE_URL", "abc.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc");
    expect(() => getSupabaseServerClient()).not.toThrow();
    expect(getSupabaseServerClient()).toBeNull();
  });

  it("envs ausentes ⇒ null", () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(getSupabaseServerClient()).toBeNull();
  });

  it("SUPABASE_URL válida + key ⇒ cliente Supabase (no null)", () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc");
    const client = getSupabaseServerClient();
    expect(client).not.toBeNull();
    expect(client?.from).toBeTypeOf("function");
  });
});
