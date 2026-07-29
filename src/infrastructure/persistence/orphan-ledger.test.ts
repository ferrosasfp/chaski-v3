// Tests — política de órdenes huérfanas 'prepared' (WKH-211 W5, AC-8/CD-6). Una orden creada en
// prepare (sin principal_in on-chain aún) se registra como 'prepared' para visibilidad de reconcile,
// SIN PII (solo IDs/address/chainId). CD-6: una fila 'prepared' NUNCA se re-clasifica a principal_in
// (no está en el stale-set de reconciliación).
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSettlementLedger, T0 } from "../../test-support/fakes";
import { SupabaseSettlementLedger } from "./supabase-settlement-ledger";

const DEPOSIT = "0x4444444444444444444444444444444444444444";
const SENDER = "0x1111111111111111111111111111111111111111";

describe("órdenes huérfanas 'prepared' (WKH-211, in-memory)", () => {
  it("AC-8: recordOrderPrepared guarda status 'prepared' + depositAddress en receiver_address, SIN PII", async () => {
    const ledger = new FakeSettlementLedger(T0);
    await ledger.recordOrderPrepared({
      remittanceId: "rem-1",
      quoteId: "q-400",
      idempotencyKey: "rem-1:q-400",
      depositAddress: DEPOSIT,
      chainId: 84532,
      senderAddress: SENDER,
      payoutId: "transfi-po-1",
      vm: "evm" as const,
    });
    const row = [...ledger.store.values()][0]!;
    expect(row.status).toBe("prepared");
    expect(row.receiverAddress).toBe(DEPOSIT.toLowerCase()); // el depositAddress ES el receiver
    expect(row.senderAddress).toBe(SENDER.toLowerCase());
    expect(row.payoutId).toBe("transfi-po-1");
    expect(row.chainId).toBe(84532);
    // Sólo hechos operativos: ni beneficiary ni documento (la fila no tiene esos campos).
    expect(JSON.stringify(row)).not.toContain("Mamá");
  });

  it("CD-6: una 'prepared' huérfana NUNCA aparece en listStale (no se re-procesa a principal_in)", async () => {
    const ledger = new FakeSettlementLedger("2020-01-01T00:00:00.000Z"); // muy vieja
    await ledger.recordOrderPrepared({
      remittanceId: "rem-1",
      quoteId: "q-400",
      idempotencyKey: "rem-1:q-400",
      depositAddress: DEPOSIT,
      chainId: 84532,
      senderAddress: SENDER,
      payoutId: "transfi-po-1",
      vm: "evm" as const,
    });
    // Aunque sea vieja, 'prepared' NO está en el stale-set (principal_in/submitted/forward_error).
    const stale = await ledger.listStale({ olderThanIso: "2030-01-01T00:00:00.000Z", limit: 10 });
    expect(stale).toHaveLength(0);
  });

  // ── WKH-213 · el DOBLE modela los DOS índices únicos (antes sólo tx_hash) ────────────────────────
  // Estos tests existen para que el doble no vuelva a "demostrar" un flujo imposible: con la
  // deduplicación vieja (sólo por tx_hash), prepare+settle producía DOS filas en memoria mientras la
  // DB real rechazaba la segunda por uq_remit_settle_idem y se quedaba con la 'prepared'.
  it("prepare + settle sobre el doble ⇒ UNA fila principal_in con hash/monto reales y payout_id intacto", async () => {
    const ledger = new FakeSettlementLedger(T0);
    await ledger.recordOrderPrepared({
      remittanceId: "rem-1",
      quoteId: "q-400",
      idempotencyKey: "rem-1:q-400",
      depositAddress: DEPOSIT,
      chainId: 84532,
      senderAddress: SENDER,
      payoutId: "transfi-po-1",
      vm: "evm" as const,
    });
    await ledger.recordPrincipalIn({
      remittanceId: "rem-1",
      quoteId: "q-400",
      idempotencyKey: "rem-1:q-400",
      txHash: "0xTXREAL",
      chainId: 84532,
      senderAddress: SENDER,
      receiverAddress: DEPOSIT,
      valueMinor: 400_000_000,
      vm: "evm" as const,
    });
    expect(ledger.store.size).toBe(1); // con el doble viejo esto daba 2 (la fantasía)
    const row = [...ledger.store.values()][0]!;
    expect(row.status).toBe("principal_in");
    expect(row.txHash).toBe("0xTXREAL");
    expect(row.valueMinor).toBe("400000000");
    expect(row.payoutId).toBe("transfi-po-1"); // el merge no lo pisó con null
  });

  it("el doble MUERDE: dos remesas con el MISMO tx_hash ⇒ 23505 (uq_remit_settle_txhash)", async () => {
    const ledger = new FakeSettlementLedger(T0);
    const base = {
      txHash: "0xMISMOHASH",
      chainId: 84532,
      senderAddress: SENDER,
      receiverAddress: DEPOSIT,
      valueMinor: 1,
      vm: "evm" as const,
    };
    await ledger.recordPrincipalIn({
      ...base,
      remittanceId: "rem-1",
      quoteId: "q-1",
      idempotencyKey: "rem-1:q-1",
    });
    await expect(
      ledger.recordPrincipalIn({
        ...base,
        remittanceId: "rem-2",
        quoteId: "q-2",
        idempotencyKey: "rem-2:q-2",
      }),
    ).rejects.toThrow(/ledger_record_principal_in_failed:23505/);
  });

  it("idempotencia: dos recordOrderPrepared con el mismo idempotency_key = una sola fila", async () => {
    const ledger = new FakeSettlementLedger(T0);
    const input = {
      remittanceId: "rem-1",
      quoteId: "q-400",
      idempotencyKey: "rem-1:q-400",
      depositAddress: DEPOSIT,
      chainId: 84532,
      senderAddress: SENDER,
      payoutId: "transfi-po-1",
      vm: "evm" as const,
    };
    await ledger.recordOrderPrepared(input);
    await ledger.recordOrderPrepared(input);
    expect(ledger.store.size).toBe(1);
  });
});

// Builder Supabase chainable mínimo (mismo molde que supabase-settlement-ledger.test.ts).
function makeClient(result: { data: unknown; error: unknown }): {
  client: SupabaseClient;
  upsertArgs: unknown[][];
} {
  const upsertArgs: unknown[][] = [];
  const client = {
    from: vi.fn(() => {
      const builder: Record<string, unknown> = {};
      builder.upsert = vi.fn((...args: unknown[]) => {
        upsertArgs.push(args);
        return builder;
      });
      // Thenable intencional: replica el query builder de PostgREST/supabase-js, que es awaitable.
      // biome-ignore lint/suspicious/noThenProperty: sin `then` el doble no imita al cliente real.
      builder.then = (resolve: (v: unknown) => void) => resolve(result);
      return builder;
    }),
  };
  return { client: client as unknown as SupabaseClient, upsertArgs };
}

describe("SupabaseSettlementLedger.recordOrderPrepared (WKH-211)", () => {
  it("upsert onConflict idempotency_key con status 'prepared', receiver_address = depositAddress, value_minor '0', SIN PII", async () => {
    const { client, upsertArgs } = makeClient({ data: null, error: null });
    await new SupabaseSettlementLedger(client).recordOrderPrepared({
      remittanceId: "rem-1",
      quoteId: "q-400",
      idempotencyKey: "rem-1:q-400",
      depositAddress: DEPOSIT,
      chainId: 84532,
      senderAddress: SENDER,
      payoutId: "transfi-po-1",
      vm: "evm" as const,
    });
    const [row, opts] = upsertArgs[0]! as [Record<string, unknown>, Record<string, unknown>];
    expect(row.status).toBe("prepared");
    expect(row.receiver_address).toBe(DEPOSIT.toLowerCase());
    expect(row.sender_address).toBe(SENDER.toLowerCase());
    expect(row.value_minor).toBe("0"); // desconocido en prepare
    expect(row.payout_id).toBe("transfi-po-1");
    expect(opts.onConflict).toBe("idempotency_key");
    expect(JSON.stringify(row)).not.toContain("Mamá"); // sin PII
  });

  it("error de la DB ⇒ throw (la route lo captura best-effort, CD-17)", async () => {
    const { client } = makeClient({ data: null, error: { code: "23505" } });
    await expect(
      new SupabaseSettlementLedger(client).recordOrderPrepared({
        remittanceId: "rem-1",
        quoteId: "q-400",
        idempotencyKey: "rem-1:q-400",
        depositAddress: DEPOSIT,
        chainId: 84532,
        senderAddress: SENDER,
        payoutId: "transfi-po-1",
        vm: "evm",
      }),
    ).rejects.toThrow(/ledger_record_order_prepared_failed/);
  });
});
