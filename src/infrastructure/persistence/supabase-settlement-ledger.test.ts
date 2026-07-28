// Tests — SupabaseSettlementLedger + getSettlementLedger (WKH-207 W1). Mockea el query-builder de
// Supabase (chainable): cero red, cero DB. Cubre AC-4 (listStale), AC-9 (owner-scope), CD-12
// (value_minor::text) y AC-10 (factory null-safe).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PublicKey } from "@solana/web3.js";
import { SupabaseSettlementLedger, getSettlementLedger } from "./supabase-settlement-ledger";
import { __resetSupabaseClient, getSupabaseServerClient } from "./supabase-server";
import { resolveSolanaNetworkId } from "../chain";

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
  order: unknown[][]; // HU-SOL-20: listRemittanceIdsBySender ordena por created_at desc
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
    order: [],
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
      builder.order = chain("order");
      // thenable: awaitar cualquier terminal resuelve el resultado de este from().
      builder.then = (resolve: (v: unknown) => void) => resolve(result);
      return builder;
    }),
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const SENDER = "0xAbCabcABCabcABCabcABCabcABCabcABCabcABC11";

// ── HU-SOL-20 · doble de COMPORTAMIENTO (no un recorder) ────────────────────────────────────────────
// `makeClient` de arriba es un recorder: devuelve el resultado encolado SIN aplicar los filtros, así
// que un test de aislamiento pasaría igual con y sin `.eq('sender_address', …)` (test vacuo). Para el
// guard de ownership de HU-SOL-20 hace falta una tabla en memoria que aplique SOLO los filtros que el
// código pide, con DOS senders distintos adentro:
//   · borrar el `.eq('sender_address', …)`   ⇒ devuelve filas del OTRO sender  → rojo
//   · escribir mal el nombre de la columna    ⇒ `unknown_column` (lo que haría Postgres, 42703) → rojo
//   · agregar `.eq('vm','solana')` (§4.2)     ⇒ 0 filas (las filas LEGACY dicen 'evm')          → rojo
// Un espía `toHaveBeenCalledWith` NO caza los dos últimos casos.
interface FakeLedgerRow {
  remittance_id: string;
  status: string;
  created_at: string;
  sender_address: string;
  // 'evm' en TODAS las filas de este fixture a propósito: son filas LEGACY, escritas antes del fix de
  // identidad de red (el escritor no seteaba `vm`, así que toda remesa Solana quedó etiquetada 'evm').
  // Son EXACTAMENTE las filas que este fallback tiene que poder recuperar ⇒ la lectura no puede
  // filtrar por `vm` ni antes ni después del fix.
  vm: string;
  value_minor: string;
}
function makeBehaviorClient(table: FakeLedgerRow[]): {
  client: SupabaseClient;
  selects: string[];
} {
  const selects: string[] = [];
  const client = {
    from: vi.fn(() => {
      let rows = [...table];
      let cols: string[] = [];
      const builder: Record<string, unknown> = {};
      builder.select = vi.fn((c: string) => {
        selects.push(c);
        cols = c.split(",").map((s) => s.trim());
        return builder;
      });
      builder.eq = vi.fn((col: string, val: unknown) => {
        // Una columna inexistente en Postgres es un ERROR (42703), no un filtro que se ignora. Si el
        // doble lo ignorara, un `sender_adress` mal escrito pasaría el test y en prod el dueño no vería
        // lo suyo. Acá explota.
        if (!(col in (table[0] ?? {}))) throw new Error(`unknown_column:${col}`);
        rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[col] === val);
        return builder;
      });
      builder.order = vi.fn((col: string, opts?: { ascending?: boolean }) => {
        if (!(col in (table[0] ?? {}))) throw new Error(`unknown_column:${col}`);
        const dir = opts?.ascending === false ? -1 : 1;
        rows = [...rows].sort((a, b) => {
          const av = String((a as unknown as Record<string, unknown>)[col]);
          const bv = String((b as unknown as Record<string, unknown>)[col]);
          return av < bv ? -dir : av > bv ? dir : 0;
        });
        return builder;
      });
      builder.limit = vi.fn((n: number) => {
        rows = rows.slice(0, n);
        return builder;
      });
      // Proyecta SOLO las columnas pedidas: si el código seleccionara value_minor, aparecería acá.
      builder.then = (resolve: (v: unknown) => void) =>
        resolve({
          data: rows.map((r) => {
            const out: Record<string, unknown> = {};
            for (const c of cols) out[c] = (r as unknown as Record<string, unknown>)[c];
            return out;
          }),
          error: null,
        });
      return builder;
    }),
  };
  return { client: client as unknown as SupabaseClient, selects };
}

const SOL_A = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // base58 canónico válido
const SOL_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // otro sender distinto

// ── Doble de DB que APLICA las restricciones reales (migración 20260721, YA aplicada) ───────────────
// `makeClient` acepta CUALQUIER upsert ⇒ un test que sólo espía la fila pasaría igual si el escritor
// pusiera vm='solana' SIN anular chain_id, que es exactamente la combinación que Postgres RECHAZA
// (23514 / remittance_settlements_vm_netid_chk). Sin un doble que aplique el CHECK, el test es vacuo:
// en prod el write se cae, la ruta se lo traga (CD-17) y la evidencia durable no existe.
// Reproduce lo medido contra la base real:
//   · chain_id numérico, `vm` ausente (default 'evm'), network_id ausente → ACEPTA  (el estado pre-fix)
//   · chain_id NULL sin escribir `vm`                                      → 23514
//   · vm='solana' + chain_id NULL + network_id presente                    → ACEPTA
// Alcance del doble: SOLO el CHECK de identidad de red (vm/chain_id/network_id) + el default de la
// columna `vm`. NO modela los NOT NULL ni los índices únicos (los cubren otros tests).
interface DbViolation {
  code: string;
  constraint: string;
  message: string;
}
/** El CHECK real, como función pura (para poder probar que el doble MUERDE). */
function vmNetIdViolation(row: Record<string, unknown>): DbViolation | null {
  const vm = "vm" in row && row.vm !== undefined ? row.vm : "evm"; // columna: not null default 'evm'
  const chainId = row.chain_id ?? null;
  const networkId = row.network_id ?? null;
  if (vm !== "evm" && vm !== "solana") {
    return { code: "23514", constraint: "remittance_settlements_vm_chk", message: "vm out of enum" };
  }
  const coherent =
    (vm === "evm" && chainId !== null && networkId === null) ||
    (vm === "solana" && networkId !== null && chainId === null);
  if (!coherent) {
    return {
      code: "23514",
      constraint: "remittance_settlements_vm_netid_chk",
      message: "vm/network identity incoherent",
    };
  }
  return null;
}
function makeConstraintClient(): {
  client: SupabaseClient;
  rows: Record<string, unknown>[];
  rejected: DbViolation[];
} {
  const rows: Record<string, unknown>[] = [];
  const rejected: DbViolation[] = [];
  const client = {
    from: vi.fn(() => {
      let pending: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {};
      builder.upsert = vi.fn((row: Record<string, unknown>) => {
        pending = row;
        return builder;
      });
      builder.then = (resolve: (v: unknown) => void) => {
        if (pending === null) return resolve({ data: null, error: null });
        const violation = vmNetIdViolation(pending);
        if (violation) {
          rejected.push(violation);
          return resolve({ data: null, error: violation }); // PostgREST propaga error.code
        }
        // Fila efectiva = defaults de la columna + lo escrito (así se ve lo que quedaría en la tabla).
        rows.push({ vm: "evm", chain_id: null, network_id: null, ...pending });
        return resolve({ data: null, error: null });
      };
      return builder;
    }),
  };
  return { client: client as unknown as SupabaseClient, rows, rejected };
}
function solRows(): FakeLedgerRow[] {
  return [
    { remittance_id: "rem-A-old", status: "prepared", created_at: "2026-07-20T00:00:00.000Z", sender_address: SOL_A, vm: "evm", value_minor: "0" },
    { remittance_id: "rem-B1", status: "prepared", created_at: "2026-07-26T00:00:00.000Z", sender_address: SOL_B, vm: "evm", value_minor: "0" },
    { remittance_id: "rem-A-new", status: "settled", created_at: "2026-07-27T00:00:00.000Z", sender_address: SOL_A, vm: "evm", value_minor: "0" },
  ];
}

describe("SupabaseSettlementLedger (WKH-207)", () => {
  it("AC-4/CD-12: listStale selecciona value_minor::text, filtra por status no-terminal + updated_at < umbral, y parsea el monto uint256-safe", async () => {
    const raw = {
      id: "id-1",
      remittance_id: "rem-1",
      quote_id: "q-1",
      idempotency_key: "rem-1:q-1",
      tx_hash: "0xtx",
      chain_id: 84532,
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
      vm: "evm",
    });
    // El UPDATE cruza AMBOS filtros: sin el sender_address, otro owner podría mutar esta fila (IDOR).
    expect(calls.eq).toContainEqual(["idempotency_key", "rem-1:q-1"]);
    expect(calls.eq).toContainEqual(["sender_address", SENDER.toLowerCase()]);
    // El patch lleva el status mapeado.
    expect((calls.update[0]?.[0] as Record<string, unknown>).status).toBe("settled");
  });

  // ── W3.1 (HU-SOL-7 / CD-9): el guard `.eq('sender_address', ...)` canonicaliza VM-aware ANTES del
  //    filtro. Con vm:'solana' NUNCA lowercasea la pubkey (cierra la colisión IDOR base58, CR-2). ──
  it("CD-9 IDOR: recordPayoutOutcome vm:'solana' filtra por la pubkey base58 case-preservada (no lowercase)", async () => {
    const K = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // base58 mixed-case válida
    const { client, calls } = makeClient([{ data: null, error: null }]);
    await new SupabaseSettlementLedger(client).recordPayoutOutcome({
      idempotencyKey: "rem-1:q-1",
      senderAddress: K,
      status: "settled",
      vm: "solana",
    });
    expect(calls.eq).toContainEqual(["sender_address", new PublicKey(K).toBase58()]); // case preservado
    expect(calls.eq).not.toContainEqual(["sender_address", K.toLowerCase()]); // NUNCA colapsa a lowercase
  });

  it("CD-9 IDOR: dos senders Solana case-distintos ⇒ filtros distintos (sin cross-mutación)", async () => {
    const K1 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    const K2 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const { client, calls } = makeClient([
      { data: null, error: null },
      { data: null, error: null },
    ]);
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordPayoutOutcome({ idempotencyKey: "k", senderAddress: K1, status: "settled", vm: "solana" });
    await ledger.recordPayoutOutcome({ idempotencyKey: "k", senderAddress: K2, status: "settled", vm: "solana" });
    const senderFilters = calls.eq.filter((a) => a[0] === "sender_address").map((a) => a[1]);
    expect(senderFilters).toContain(new PublicKey(K1).toBase58());
    expect(senderFilters).toContain(new PublicKey(K2).toBase58());
    expect(new PublicKey(K1).toBase58()).not.toBe(new PublicKey(K2).toBase58());
  });

  it("byte-id EVM: recordPayoutOutcome vm:'evm' sigue produciendo senderAddress.toLowerCase()", async () => {
    const { client, calls } = makeClient([{ data: null, error: null }]);
    await new SupabaseSettlementLedger(client).recordPayoutOutcome({
      idempotencyKey: "k",
      senderAddress: SENDER,
      status: "settled",
      vm: "evm",
    });
    expect(calls.eq).toContainEqual(["sender_address", SENDER.toLowerCase()]);
  });

  it("recordPrincipalIn: upsert idempotente por tx_hash (ignoreDuplicates) con addresses lowercased y value_minor string", async () => {
    const { client, calls } = makeClient([{ data: null, error: null }]);
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordPrincipalIn({
      remittanceId: "rem-1",
      quoteId: "q-1",
      idempotencyKey: "rem-1:q-1",
      txHash: "0xTX",
      chainId: 84532,
      senderAddress: SENDER,
      receiverAddress: "0xREceiverAddr2222222222222222222222222222",
      valueMinor: 400_000_000,
      vm: "evm",
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
        vm: "evm",
      }),
    ).rejects.toThrow();
  });

  // ── recordWebhookOutcome (WKH-210): UPDATE por payout_id, filtro NON_TERMINAL, NO owner-scoped ──
  it("WKH-210/CD-12: recordWebhookOutcome hace UPDATE por payout_id + filtro .in(status, NON_TERMINAL), sin sender_address", async () => {
    const { client, calls } = makeClient([{ data: null, error: null }]);
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordWebhookOutcome({ payoutId: "p-1", status: "settled" });
    const patch = calls.update[0]?.[0] as Record<string, unknown>;
    expect(patch.status).toBe("settled");
    expect(patch.updated_at).toBeTypeOf("string");
    expect(calls.eq).toContainEqual(["payout_id", "p-1"]);
    // NO owner-scoped: el guard es el HMAC, jamás filtra por sender_address (CD-12).
    expect(calls.eq.some((c) => c[0] === "sender_address")).toBe(false);
    // Filtro NON_TERMINAL (DT-2b): nunca degrada un estado terminal ni reclasifica manual_review.
    expect(calls.in[0]?.[0]).toBe("status");
    expect(calls.in[0]?.[1]).toEqual(["principal_in", "submitted", "forward_error"]);
  });

  it("WKH-210/DT-8: status failed persiste last_error enum estable (transfi_fund_failed), nunca el reason crudo", async () => {
    const { client, calls } = makeClient([{ data: null, error: null }]);
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordWebhookOutcome({
      payoutId: "p-2",
      status: "failed",
      error: "transfi_fund_failed",
    });
    const patch = calls.update[0]?.[0] as Record<string, unknown>;
    expect(patch.last_error).toBe("transfi_fund_failed");
  });

  it("WKH-210/AC-8: 0-match (payoutId inexistente) no lanza (Supabase no reporta error en UPDATE 0-row)", async () => {
    const { client } = makeClient([{ data: null, error: null }]);
    const ledger = new SupabaseSettlementLedger(client);
    await expect(
      ledger.recordWebhookOutcome({ payoutId: "no-existe", status: "settled" }),
    ).resolves.toBeUndefined();
  });

  it("WKH-210: error de Supabase ⇒ throw ledger_record_webhook_outcome_failed:*", async () => {
    const { client } = makeClient([{ data: null, error: { code: "PGRST000" } }]);
    const ledger = new SupabaseSettlementLedger(client);
    await expect(
      ledger.recordWebhookOutcome({ payoutId: "p-3", status: "settled" }),
    ).rejects.toThrow(/ledger_record_webhook_outcome_failed:PGRST000/);
  });

  // ── HU-SOL-20/AC-2 · listRemittanceIdsBySender (T-R0-1/2/3) ──────────────────────────────────────
  // El `.eq('sender_address', …)` es el ÚNICO guard de ownership (el service key BYPASSEA RLS):
  // borrarlo expone los remittanceId de terceros, o sea la PDA de su escrow. Se prueba con el doble de
  // COMPORTAMIENTO, no con un espía.
  it("T-R0-1 (AC-2/IDOR): devuelve SOLO las filas del sender pedido — el otro sender NUNCA aparece", async () => {
    const { client } = makeBehaviorClient(solRows());
    const out = await new SupabaseSettlementLedger(client).listRemittanceIdsBySender({
      senderAddress: SOL_A,
      vm: "solana",
      limit: 20,
    });
    const ids = out.map((r) => r.remittanceId);
    expect(ids).toEqual(["rem-A-new", "rem-A-old"]); // created_at DESC
    // Sin el filtro por sender_address, rem-B1 estaría acá: es el IDOR que el guard cierra.
    expect(ids).not.toContain("rem-B1");
    expect(JSON.stringify(out)).not.toContain("rem-B1");
  });

  it("T-R0-1 (§4.2): NO filtra por la columna `vm` — las filas LEGACY Solana dicen 'evm'", async () => {
    // Las filas del doble llevan vm:'evm' (fiel a las filas ya escritas: el escritor no seteaba `vm`).
    // Si la query agregara `.eq('vm','solana')`, esto devolvería [] y el fallback de AC-2 no protegería nada.
    const { client } = makeBehaviorClient(solRows());
    const out = await new SupabaseSettlementLedger(client).listRemittanceIdsBySender({
      senderAddress: SOL_A,
      vm: "solana",
      limit: 20,
    });
    expect(out.length).toBe(2); // > 0 ⇒ no se filtró por vm
  });

  it("T-R0-1 (IDOR base58): la pubkey se canonicaliza SIN lowercase — un sender no ve lo del otro", async () => {
    const { client, selects } = makeBehaviorClient(solRows());
    const ledger = new SupabaseSettlementLedger(client);
    const a = await ledger.listRemittanceIdsBySender({ senderAddress: SOL_A, vm: "solana", limit: 20 });
    const b = await ledger.listRemittanceIdsBySender({ senderAddress: SOL_B, vm: "solana", limit: 20 });
    expect(a.map((r) => r.remittanceId)).toEqual(["rem-A-new", "rem-A-old"]);
    expect(b.map((r) => r.remittanceId)).toEqual(["rem-B1"]);
    // Un lowercase de la base58 no matchearía ninguna fila (la columna guarda el case canónico).
    const lowered = await ledger.listRemittanceIdsBySender({
      senderAddress: new PublicKey(SOL_A).toBase58(),
      vm: "evm", // canonicaliza a lowercase ⇒ 0 filas: prueba que el case IMPORTA
      limit: 20,
    });
    expect(lowered).toEqual([]);
    expect(selects.length).toBe(3);
  });

  it("T-R0-2 (CD-12/CD-7): el select trae remittance_id/status/created_at y NUNCA value_minor ni PII", async () => {
    const { client, selects } = makeBehaviorClient(solRows());
    const out = await new SupabaseSettlementLedger(client).listRemittanceIdsBySender({
      senderAddress: SOL_A,
      vm: "solana",
      limit: 20,
    });
    const cols = String(selects[0]);
    expect(cols).toContain("remittance_id");
    expect(cols).toContain("status");
    expect(cols).toContain("created_at");
    expect(cols).not.toContain("value_minor"); // no se lee ⇒ el ::text de CD-12 no aplica
    expect(cols).not.toContain("receiver_address");
    // La proyección del doble solo devuelve lo pedido ⇒ el shape de salida no puede filtrar montos.
    expect(Object.keys(out[0] ?? {}).sort()).toEqual(["createdAt", "remittanceId", "status"]);
    expect(out[0]?.status).toBe("settled");
    expect(out[0]?.createdAt).toBe("2026-07-27T00:00:00.000Z");
  });

  it("T-R0-2: ordena created_at DESC y aplica el limit (recorder: verifica los argumentos exactos)", async () => {
    const { client, calls } = makeClient([{ data: [], error: null }]);
    await new SupabaseSettlementLedger(client).listRemittanceIdsBySender({
      senderAddress: SOL_A,
      vm: "solana",
      limit: 7,
    });
    expect(calls.eq).toContainEqual(["sender_address", new PublicKey(SOL_A).toBase58()]);
    expect(calls.eq.map((c) => c[0])).not.toContain("vm"); // §4.2
    expect(calls.in.length).toBe(0); // §4.3: NO filtra por STALE_STATUSES (perdería las 'prepared')
    expect(calls.order[0]).toEqual(["created_at", { ascending: false }]);
    expect(calls.limit[0]).toEqual([7]);
  });

  it("T-R0-2: limit recorta (el tope duro lo aplica el endpoint)", async () => {
    const { client } = makeBehaviorClient(solRows());
    const out = await new SupabaseSettlementLedger(client).listRemittanceIdsBySender({
      senderAddress: SOL_A,
      vm: "solana",
      limit: 1,
    });
    expect(out.map((r) => r.remittanceId)).toEqual(["rem-A-new"]); // el más reciente
  });

  it("T-R0-3 (fail-loud): error del builder ⇒ throw ledger_list_by_sender_failed:<code>, NUNCA [] silencioso", async () => {
    const { client } = makeClient([{ data: null, error: { code: "PGRST301" } }]);
    await expect(
      new SupabaseSettlementLedger(client).listRemittanceIdsBySender({
        senderAddress: SOL_A,
        vm: "solana",
        limit: 20,
      }),
    ).rejects.toThrow(/ledger_list_by_sender_failed:PGRST301/);
  });

  // ── R0 tras el fix de escritura: filas LEGACY (vm='evm') + filas nuevas (vm='solana') convivien ──
  it("R0 sigue igual DESPUÉS del fix: recupera las filas legacy (vm='evm') Y las nuevas (vm='solana') del mismo sender", async () => {
    // La tabla real va a tener las dos cosas: lo escrito antes del fix (mislabel 'evm') y lo escrito
    // después ('solana'). La lectura de HU-SOL-20 NO discrimina por vm ⇒ devuelve ambas. Si alguien
    // agregara `.eq('vm','solana')`, la fila legacy desaparecería y el refund de una remesa vieja se
    // quedaría sin remittanceId (la plata atrapada en el escrow, que es el caso que R0 cubre).
    const mixed: FakeLedgerRow[] = [
      { remittance_id: "rem-legacy", status: "prepared", created_at: "2026-07-20T00:00:00.000Z", sender_address: SOL_A, vm: "evm", value_minor: "0" },
      { remittance_id: "rem-nueva", status: "prepared", created_at: "2026-07-28T00:00:00.000Z", sender_address: SOL_A, vm: "solana", value_minor: "0" },
      { remittance_id: "rem-otro-sender", status: "prepared", created_at: "2026-07-28T00:00:00.000Z", sender_address: SOL_B, vm: "solana", value_minor: "0" },
    ];
    const { client } = makeBehaviorClient(mixed);
    const out = await new SupabaseSettlementLedger(client).listRemittanceIdsBySender({
      senderAddress: SOL_A,
      vm: "solana",
      limit: 20,
    });
    expect(out.map((r) => r.remittanceId)).toEqual(["rem-nueva", "rem-legacy"]); // created_at DESC
    expect(out.map((r) => r.remittanceId)).not.toContain("rem-otro-sender"); // el guard sigue siendo el sender
  });

  it("T-R0-3: address base58 malformada ⇒ throw de canonicalizeAddress, NUNCA una query sin filtro", async () => {
    const { client } = makeBehaviorClient(solRows());
    await expect(
      new SupabaseSettlementLedger(client).listRemittanceIdsBySender({
        senderAddress: "0OIl-no-es-base58",
        vm: "solana",
        limit: 20,
      }),
    ).rejects.toThrow("address_canonicalization_failed");
  });
});

// ── Identidad de red del INSERT: vm + (chain_id | network_id) ────────────────────────────────────────
// El bug: el upsert escribía SÓLO chain_id (el chainId EVM configurado) y descartaba el `vm` en
// silencio ⇒ toda fila de una remesa Solana quedaba vm='evm' + chainId de Avalanche con addresses
// base58, y cualquier query que filtrara .eq('vm','solana') devolvía CERO filas SIEMPRE.
// Las dos mitades del arreglo (escribir `vm` y anular `chain_id`) van juntas o el CHECK de la DB
// rechaza el insert — y ese rechazo lo traga el catch best-effort de la ruta (CD-17), o sea que se
// pierde la evidencia durable con un log como única señal. Por eso se prueba con un doble que APLICA
// el CHECK, no con un espía.
const CHAIN_ID_EVM = 84532; // Base Sepolia (rama EVM)
const CHAIN_ID_MISLABEL = 43113; // el chainId EVM que se escribía en las filas Solana (Avalanche Fuji)

describe("identidad de red del ledger — vm + chain_id/network_id (CHECK 20260721)", () => {
  it("el doble APLICA el CHECK: reproduce los tres inserts medidos y RECHAZA las dos mitades desacopladas", () => {
    // Medido contra la base real (si el doble no rechazara, los tests de abajo serían vacuos):
    expect(vmNetIdViolation({ chain_id: CHAIN_ID_MISLABEL })).toBeNull(); // pre-fix: ACEPTA (mal etiquetado)
    expect(vmNetIdViolation({ chain_id: null })?.constraint).toBe("remittance_settlements_vm_netid_chk"); // anular sin `vm` ⇒ 23514
    expect(
      vmNetIdViolation({ vm: "solana", chain_id: null, network_id: "solana:devnet" }),
    ).toBeNull(); // el arreglo completo: ACEPTA
    // Mitad A — escribir `vm='solana'` y OLVIDARSE de anular chain_id:
    const halfA = vmNetIdViolation({ vm: "solana", chain_id: CHAIN_ID_MISLABEL, network_id: "solana:devnet" });
    expect(halfA?.code).toBe("23514");
    // Mitad B — anular chain_id sin escribir `vm` (default 'evm'):
    const halfB = vmNetIdViolation({ chain_id: null, network_id: "solana:devnet" });
    expect(halfB?.code).toBe("23514");
    // Y un `vm` fuera del enum también revienta (remittance_settlements_vm_chk).
    expect(vmNetIdViolation({ vm: "sui", chain_id: null })?.constraint).toBe("remittance_settlements_vm_chk");
  });

  it("recordOrderPrepared vm:'solana' ⇒ la DB ACEPTA la fila: vm='solana', network_id CAIP-2, chain_id NULL", async () => {
    const { client, rows, rejected } = makeConstraintClient();
    await new SupabaseSettlementLedger(client).recordOrderPrepared({
      remittanceId: "rem-1",
      quoteId: "q-1",
      idempotencyKey: "rem-1:q-1",
      depositAddress: SOL_B,
      chainId: CHAIN_ID_MISLABEL, // el caller sigue pasando un chainId EVM: el ledger lo IGNORA
      senderAddress: SOL_A,
      payoutId: "p-1",
      vm: "solana",
    });
    expect(rejected).toEqual([]); // si el write violara el CHECK, la fila NO existiría en prod
    const row = rows[0] ?? {};
    expect(row.vm).toBe("solana"); // ← mitad 1: el discriminante YA no se descarta
    expect(row.network_id).toBe(resolveSolanaNetworkId()); // fuente canónica, no un literal nuevo
    expect(row.network_id).toBe("solana:devnet");
    expect(row.chain_id).toBeNull(); // ← mitad 2: NUNCA el chainId EVM en una fila Solana
    expect(row.chain_id).not.toBe(CHAIN_ID_MISLABEL);
    // La fila queda consultable por VM: `.eq('vm','solana')` ya no da cero.
    expect(rows.filter((r) => r.vm === "solana").length).toBe(1);
    // El resto de la fila, intacto (address base58 case-preservada, sin PII).
    expect(row.sender_address).toBe(new PublicKey(SOL_A).toBase58());
    expect(row.receiver_address).toBe(new PublicKey(SOL_B).toBase58());
    expect(row.status).toBe("prepared");
  });

  it("recordOrderPrepared vm:'evm' ⇒ byte-idéntico: vm='evm', chain_id numérico, network_id NULL", async () => {
    const { client, rows, rejected } = makeConstraintClient();
    await new SupabaseSettlementLedger(client).recordOrderPrepared({
      remittanceId: "rem-2",
      quoteId: "q-2",
      idempotencyKey: "rem-2:q-2",
      depositAddress: "0xREceiverAddr2222222222222222222222222222",
      chainId: CHAIN_ID_EVM,
      senderAddress: SENDER,
      payoutId: "p-2",
      vm: "evm",
    });
    expect(rejected).toEqual([]);
    const row = rows[0] ?? {};
    expect(row.vm).toBe("evm");
    expect(row.chain_id).toBe(CHAIN_ID_EVM); // la rama EVM NO cambia de dato
    expect(row.network_id).toBeNull();
    expect(row.sender_address).toBe(SENDER.toLowerCase());
  });

  it("recordPrincipalIn vm:'solana' ⇒ mismas dos mitades (el escritor del principal tenía el MISMO bug)", async () => {
    const { client, rows, rejected } = makeConstraintClient();
    await new SupabaseSettlementLedger(client).recordPrincipalIn({
      remittanceId: "rem-3",
      quoteId: "q-3",
      idempotencyKey: "rem-3:q-3",
      txHash: "5x".repeat(10),
      chainId: CHAIN_ID_MISLABEL,
      senderAddress: SOL_A,
      receiverAddress: SOL_B,
      valueMinor: 400_000_000,
      vm: "solana",
    });
    expect(rejected).toEqual([]);
    const row = rows[0] ?? {};
    expect(row.vm).toBe("solana");
    expect(row.network_id).toBe(resolveSolanaNetworkId());
    expect(row.chain_id).toBeNull();
    expect(row.value_minor).toBe("400000000"); // uint256-safe intacto (CD-12)
    expect(row.status).toBe("principal_in");
  });

  it("recordPrincipalIn vm:'evm' ⇒ byte-idéntico (chain_id numérico, network_id NULL)", async () => {
    const { client, rows, rejected } = makeConstraintClient();
    await new SupabaseSettlementLedger(client).recordPrincipalIn({
      remittanceId: "rem-4",
      quoteId: "q-4",
      idempotencyKey: "rem-4:q-4",
      txHash: "0xTX",
      chainId: CHAIN_ID_EVM,
      senderAddress: SENDER,
      receiverAddress: "0xREceiverAddr2222222222222222222222222222",
      valueMinor: 1,
      vm: "evm",
    });
    expect(rejected).toEqual([]);
    const row = rows[0] ?? {};
    expect(row.vm).toBe("evm");
    expect(row.chain_id).toBe(CHAIN_ID_EVM);
    expect(row.network_id).toBeNull();
  });

  it("invariante de los DOS escritores × las DOS VMs: exactamente UNA columna de red no-nula, coherente con vm", async () => {
    // Barrido: si un escritor futuro (o un refactor) desacopla las mitades en cualquiera de los cuatro
    // combos, esto se pone rojo — el CHECK del doble rechaza y `rejected` deja de estar vacío.
    for (const vm of ["evm", "solana"] as const) {
      const sender = vm === "solana" ? SOL_A : SENDER;
      const receiver = vm === "solana" ? SOL_B : "0xREceiverAddr2222222222222222222222222222";
      const { client, rows, rejected } = makeConstraintClient();
      const ledger = new SupabaseSettlementLedger(client);
      await ledger.recordOrderPrepared({
        remittanceId: "rem-x",
        quoteId: "q-x",
        idempotencyKey: "rem-x:q-x",
        depositAddress: receiver,
        chainId: CHAIN_ID_EVM,
        senderAddress: sender,
        payoutId: "p-x",
        vm,
      });
      await ledger.recordPrincipalIn({
        remittanceId: "rem-x",
        quoteId: "q-x",
        idempotencyKey: "rem-x:q-x",
        txHash: "0xTXX",
        chainId: CHAIN_ID_EVM,
        senderAddress: sender,
        receiverAddress: receiver,
        valueMinor: 7,
        vm,
      });
      expect(rejected).toEqual([]);
      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect(row.vm).toBe(vm);
        const hasChain = row.chain_id !== null;
        const hasNetwork = row.network_id !== null;
        expect(hasChain).toBe(vm === "evm");
        expect(hasNetwork).toBe(vm === "solana");
        expect(hasChain === hasNetwork).toBe(false); // XOR: nunca las dos, nunca ninguna
      }
    }
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
