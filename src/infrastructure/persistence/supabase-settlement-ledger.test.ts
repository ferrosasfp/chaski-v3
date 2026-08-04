// Tests — SupabaseSettlementLedger + getSettlementLedger (WKH-207 W1). Mockea el query-builder de
// Supabase (chainable): cero red, cero DB. Cubre AC-4 (listStale), AC-9 (owner-scope), CD-12
// (value_minor::text) y AC-10 (factory null-safe).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PublicKey } from "@solana/web3.js";
import {
  CHAIN_ID_NOT_APPLICABLE,
  SupabaseSettlementLedger,
  getSettlementLedger,
} from "./supabase-settlement-ledger";
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
  maybeSingle: unknown[][]; // WKH-213: recordPrincipalIn pregunta si la fila ya existe
  order: unknown[][]; // HU-SOL-20: listRemittanceIdsBySender ordena por created_at desc
}
function makeClient(
  // `count` sólo lo usa listPreparedOrphans (select con { count: "exact" }).
  results: Array<{ data: unknown; error: unknown; count?: number }>,
): {
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
    maybeSingle: [],
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
      builder.maybeSingle = chain("maybeSingle");
      builder.order = chain("order");
      // thenable: awaitar cualquier terminal resuelve el resultado de este from().
      // biome-ignore lint/suspicious/noThenProperty: thenable intencional, replica PostgREST/supabase-js.
      builder.then = (resolve: (v: unknown) => void) => resolve(result);
      return builder;
    }),
  };
  return { client: client as unknown as SupabaseClient, calls };
}

// WKH-320: era una address EVM mixed-case, elegida para que `.toLowerCase()` fuera observable. La
// canonicalización dejó de tener rama `evm`, así que pasa a ser una pubkey base58 y los asserts que
// esperaban lowercase pasan a esperar el valor CASE-PRESERVADO, que es el invariante vivo (CD-7).
const SENDER = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// Monto del incidente WKH-196: 2^53 < valor < 2^54. Se declara COMO STRING y nunca como literal
// numérico — escribirlo `90071992547409910` en JS produce 90071992547409900 (el motor lo redondea al
// parsear el fuente), que es justo la corrupción que estos tests tienen que cazar.
const VALUE_MINOR_OVER_2_53 = "90071992547409910";

/** Fila cruda del ledger tal como la devuelve PostgREST (value_minor ya casteado a ::text). */
function rawRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "id-1",
    remittance_id: "rem-1",
    quote_id: "q-1",
    idempotency_key: "rem-1:q-1",
    tx_hash: "0xtx",
    chain_id: 84532,
    sender_address: "0xsender",
    receiver_address: "0xreceiver",
    // > 2^53: un JSON.parse crudo lo redondearía (WKH-196). Llega como STRING por el ::text.
    value_minor: VALUE_MINOR_OVER_2_53,
    status: "principal_in",
    attempts: 0,
    payout_id: null,
    last_error: null,
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z",
    ...over,
  };
}

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
  // La deposit-address registrada al preparar. La lee listPreparedDepositAddresses, que es el lado B
  // del chequeo de destino del settle; sin esta columna en el doble, un `.eq('receiver_address', …)`
  // mal escrito o un select equivocado no se verían.
  receiver_address: string;
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
      // biome-ignore lint/suspicious/noThenProperty: thenable intencional, replica PostgREST/supabase-js.
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
// ── WKH-213 · TABLA EN MEMORIA que aplica TODAS las restricciones de la migración ───────────────────
// El doble anterior (`makeConstraintClient`) sólo entendía `upsert` y sólo aplicaba el CHECK de
// identidad de red: no modelaba los DOS índices únicos ni el UPDATE, así que no podía ver el bug que
// esta HU arregla (el INSERT del settle chocando con la fila 'prepared' por idempotency_key) ni medir
// el ESTADO FINAL de la fila, que es lo único que importa acá.
// Lo que aplica, tal cual la DB (migraciones 20260716 / 20260718 / 20260721):
//   · uq_remit_settle_txhash + uq_remit_settle_idem  → 23505 (y `ON CONFLICT` sólo perdona SU índice)
//   · remittance_settlements_vm_netid_chk / _vm_chk  → 23514
//   · NOT NULL de las columnas obligatorias          → 23502
//   · defaults de columna (vm='evm', attempts=0, …)
// Verbos soportados: upsert(onConflict/ignoreDuplicates), update(+select devolviendo las filas
// mutadas), select(+count exact), eq, in, lt, order, limit, maybeSingle, single.
const NOT_NULL_COLUMNS = [
  "remittance_id",
  "quote_id",
  "idempotency_key",
  "tx_hash",
  "sender_address",
  "receiver_address",
  "value_minor",
  "status",
];
const COLUMN_DEFAULTS: Record<string, unknown> = {
  vm: "evm",
  chain_id: null,
  network_id: null,
  status: "principal_in",
  attempts: 0,
  payout_id: null,
  last_error: null,
  created_at: "2026-07-28T00:00:00.000Z",
  updated_at: "2026-07-28T00:00:00.000Z",
};
/** Violación de integridad de una fila candidata (CHECK + NOT NULL). El unique se chequea aparte
 *  porque necesita ver el resto de la tabla. */
function rowViolation(row: Record<string, unknown>): DbViolation | null {
  const netId = vmNetIdViolation(row);
  if (netId) return netId;
  for (const col of NOT_NULL_COLUMNS) {
    if (row[col] === null || row[col] === undefined) {
      return { code: "23502", constraint: `${col}_not_null`, message: `null value in ${col}` };
    }
  }
  return null;
}
function makeTableClient(seed: Record<string, unknown>[] = []): {
  client: SupabaseClient;
  rows: Record<string, unknown>[];
  rejected: DbViolation[];
} {
  const rows: Record<string, unknown>[] = seed.map((r, i) => ({
    id: `seed-${i + 1}`,
    ...COLUMN_DEFAULTS,
    ...r,
  }));
  const rejected: DbViolation[] = [];
  let seq = 0;
  const uniqueViolation = (
    candidate: Record<string, unknown>,
    selfId: unknown,
  ): DbViolation | null => {
    for (const r of rows) {
      if (r.id === selfId) continue;
      if (r.tx_hash === candidate.tx_hash) {
        return { code: "23505", constraint: "uq_remit_settle_txhash", message: "duplicate tx_hash" };
      }
      if (r.idempotency_key === candidate.idempotency_key) {
        return { code: "23505", constraint: "uq_remit_settle_idem", message: "duplicate idem" };
      }
    }
    return null;
  };
  const client = {
    from: vi.fn(() => {
      type Filter = (r: Record<string, unknown>) => boolean;
      const filters: Filter[] = [];
      let mode: "read" | "insert" | "update" = "read";
      let pending: Record<string, unknown> | null = null;
      let onConflict = "";
      let ignoreDuplicates = false;
      let selectCols: string | null = null;
      let wantCount = false;
      let orderBy: { col: string; asc: boolean } | null = null;
      let limitN: number | null = null;
      let terminal: "many" | "maybeSingle" | "single" = "many";
      const builder: Record<string, unknown> = {};
      builder.select = vi.fn((cols?: string, opts?: { count?: string }) => {
        selectCols = cols ?? "*";
        if (opts?.count === "exact") wantCount = true;
        return builder;
      });
      builder.upsert = vi.fn((row: Record<string, unknown>, opts?: Record<string, unknown>) => {
        mode = "insert";
        pending = row;
        onConflict = typeof opts?.onConflict === "string" ? opts.onConflict : "";
        ignoreDuplicates = opts?.ignoreDuplicates === true;
        return builder;
      });
      builder.update = vi.fn((patch: Record<string, unknown>) => {
        mode = "update";
        pending = patch;
        return builder;
      });
      builder.eq = vi.fn((col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return builder;
      });
      builder.in = vi.fn((col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      });
      builder.lt = vi.fn((col: string, val: unknown) => {
        filters.push((r) => String(r[col]) < String(val));
        return builder;
      });
      builder.order = vi.fn((col: string, opts?: { ascending?: boolean }) => {
        orderBy = { col, asc: opts?.ascending !== false };
        return builder;
      });
      builder.limit = vi.fn((n: number) => {
        limitN = n;
        return builder;
      });
      builder.maybeSingle = vi.fn(() => {
        terminal = "maybeSingle";
        return builder;
      });
      builder.single = vi.fn(() => {
        terminal = "single";
        return builder;
      });
      const project = (r: Record<string, unknown>): Record<string, unknown> => {
        if (!selectCols || selectCols === "*") return { ...r };
        const out: Record<string, unknown> = {};
        for (const raw of selectCols.split(",")) {
          const col = raw.trim().replace("::text", "");
          out[col] = r[col];
        }
        return out;
      };
      // biome-ignore lint/suspicious/noThenProperty: thenable intencional, replica PostgREST/supabase-js.
      builder.then = (resolve: (v: unknown) => void) => {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (mode === "insert" && pending) {
          const candidate: Record<string, unknown> = {
            ...COLUMN_DEFAULTS,
            ...pending,
            id: `row-${++seq}`,
          };
          const conflicting = onConflict
            ? rows.find((r) => r[onConflict] === candidate[onConflict])
            : undefined;
          if (conflicting && ignoreDuplicates) return resolve({ data: null, error: null }); // DO NOTHING
          const violation = rowViolation(candidate) ?? uniqueViolation(candidate, null);
          if (violation) {
            rejected.push(violation);
            return resolve({ data: null, error: violation }); // PostgREST propaga error.code
          }
          rows.push(candidate);
          return resolve({ data: null, error: null });
        }
        if (mode === "update" && pending) {
          const updated: Record<string, unknown>[] = [];
          for (const r of matched) {
            const next = { ...r, ...pending };
            const violation = rowViolation(next) ?? uniqueViolation(next, r.id);
            if (violation) {
              rejected.push(violation);
              return resolve({ data: null, error: violation });
            }
            Object.assign(r, pending);
            updated.push(r);
          }
          // PostgREST devuelve las filas mutadas SOLO si se encadenó .select().
          return resolve({ data: selectCols ? updated.map(project) : null, error: null });
        }
        let out = [...matched];
        if (orderBy) {
          const { col, asc } = orderBy;
          out.sort((a, b) => {
            const av = String(a[col]);
            const bv = String(b[col]);
            return av < bv ? (asc ? -1 : 1) : av > bv ? (asc ? 1 : -1) : 0;
          });
        }
        const total = out.length; // count exact: ANTES del limit (como Content-Range de PostgREST)
        if (limitN !== null) out = out.slice(0, limitN);
        const data =
          terminal === "many" ? out.map(project) : out.length > 0 ? project(out[0]!) : null;
        return resolve(wantCount ? { data, error: null, count: total } : { data, error: null });
      };
      return builder;
    }),
  };
  return { client: client as unknown as SupabaseClient, rows, rejected };
}
// Direcciones de depósito distintas por fila: si la lectura devolviera la de otra fila (o la de otro
// sender), el valor devuelto lo delata en vez de coincidir por casualidad.
const DEPOSIT_A_OLD = "So11111111111111111111111111111111111111112";
const DEPOSIT_A_NEW = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const DEPOSIT_B1 = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
function solRows(): FakeLedgerRow[] {
  return [
    { remittance_id: "rem-A-old", status: "prepared", created_at: "2026-07-20T00:00:00.000Z", sender_address: SOL_A, vm: "evm", value_minor: "0", receiver_address: DEPOSIT_A_OLD },
    { remittance_id: "rem-B1", status: "prepared", created_at: "2026-07-26T00:00:00.000Z", sender_address: SOL_B, vm: "evm", value_minor: "0", receiver_address: DEPOSIT_B1 },
    { remittance_id: "rem-A-new", status: "settled", created_at: "2026-07-27T00:00:00.000Z", sender_address: SOL_A, vm: "evm", value_minor: "0", receiver_address: DEPOSIT_A_NEW },
  ];
}

describe("SupabaseSettlementLedger (WKH-207)", () => {
  it("AC-4/CD-12: listStale selecciona value_minor::text, filtra por status no-terminal + updated_at < umbral, y parsea el monto uint256-safe", async () => {
    const { client, calls } = makeClient([{ data: [rawRow()], error: null }]);
    const ledger = new SupabaseSettlementLedger(client);
    const out = await ledger.listStale({ olderThanIso: "2026-07-16T01:00:00.000Z", limit: 50 });

    // CD-12: el select DEBE contener value_minor::text.
    expect(String(calls.select[0]?.[0])).toContain("value_minor::text");
    // AC-4: filtro por status no-terminal + updated_at < umbral.
    expect(calls.in[0]?.[0]).toBe("status");
    expect(calls.in[0]?.[1]).toEqual(["principal_in", "submitted", "forward_error"]);
    expect(calls.lt[0]).toEqual(["updated_at", "2026-07-16T01:00:00.000Z"]);
    expect(calls.limit[0]).toEqual([50]);
    // El monto sale COMO STRING, con los mismos dígitos que entraron. La afirmación es contra el
    // string y NUNCA contra un literal numérico: `90071992547409910` escrito como número en JS YA
    // vale 90071992547409900 (supera 2^53-1), así que un assert numérico sufre la misma corrupción
    // que debería detectar y pasa verde con el bug puesto. Esa era la deuda que escondía este test.
    expect(out[0]?.valueMinor).toBe(VALUE_MINOR_OVER_2_53);
    expect(typeof out[0]?.valueMinor).toBe("string"); // un Number() acá lo volvería "number" ⇒ rojo
    expect(out[0]?.remittanceId).toBe("rem-1");
  });

  // ── CD-12/WKH-196 · el round-trip que el test viejo no podía hacer ────────────────────────────────
  // Lo que entra por el fixture tiene que salir IDÉNTICO carácter por carácter. Se prueban los dos
  // extremos del rango real de la columna numeric(78,0): el primer entero que `number` ya no
  // representa (2^53+1) y el uint256 máximo (2^256-1, 78 dígitos).
  it.each([
    ["2^53+1 (primer entero que `number` no representa)", "9007199254740993"],
    ["> 2^53 (el caso del incidente WKH-196)", VALUE_MINOR_OVER_2_53],
    ["uint256 máximo (2^256-1, 78 dígitos)", "115792089237316195423570985008687907853269984665640564039457584007913129639935"],
    ["monto real de una remesa (dentro de rango, no debe cambiar)", "400000000"],
    ["cero (fila 'prepared', monto aún desconocido)", "0"],
  ])("CD-12 round-trip: %s sale idéntico carácter por carácter", async (_label, digits) => {
    const { client } = makeClient([{ data: [rawRow({ value_minor: digits })], error: null }]);
    const out = await new SupabaseSettlementLedger(client).listStale({
      olderThanIso: "2030-01-01T00:00:00.000Z",
      limit: 50,
    });
    const got = out[0]?.valueMinor;
    expect(got).toBe(digits); // identidad exacta, sin normalizar
    expect(typeof got).toBe("string");
    // Comparación adicional a nivel numérico EXACTO: BigInt no pierde dígitos (Number sí). Si alguien
    // reintrodujera un Number() intermedio, este assert también se pone rojo.
    expect(BigInt(String(got))).toBe(BigInt(digits));
    expect(String(got).length).toBe(digits.length); // sin notación científica ("9e+15") ni truncado
  });

  // El guard es la contraparte en runtime del `::text`: si alguien borra el cast del select, PostgREST
  // devuelve el numeric como número JSON YA redondeado. Preferimos romper el reconcile (503, cero
  // dinero en juego) antes que escribir evidencia con un monto mentiroso.
  it("CD-12: si value_minor NO llega como texto (::text borrado del select) ⇒ TIRA, no redondea", async () => {
    // Lo que devolvería PostgREST sin el cast: un número JSON YA corrompido por JSON.parse. Se
    // construye con Number(<string>) y NO con un literal numérico a propósito — escribir
    // `90071992547409910` en el fuente es un error de lint (noPrecisionLoss) porque el motor ya lo
    // redondea al parsear: el linter mismo confirma por qué este campo no puede ser `number`.
    const corrupted = Number(VALUE_MINOR_OVER_2_53);
    expect(String(corrupted)).not.toBe(VALUE_MINOR_OVER_2_53); // la pérdida, demostrada
    const { client } = makeClient([
      { data: [rawRow({ value_minor: corrupted })], error: null },
    ]);
    await expect(
      new SupabaseSettlementLedger(client).listStale({
        olderThanIso: "2030-01-01T00:00:00.000Z",
        limit: 50,
      }),
    ).rejects.toThrow("ledger_value_minor_not_text");
  });

  it.each([["notación científica", "9.007199254740993e+15"], ["vacío", ""], ["negativo", "-1"], ["basura", "abc"]])(
    "CD-12: value_minor con %s ⇒ TIRA (nunca un monto silenciosamente inventado)",
    async (_label, bad) => {
      const { client } = makeClient([{ data: [rawRow({ value_minor: bad })], error: null }]);
      await expect(
        new SupabaseSettlementLedger(client).listStale({
          olderThanIso: "2030-01-01T00:00:00.000Z",
          limit: 50,
        }),
      ).rejects.toThrow("ledger_value_minor_not_text");
    },
  );

  it("AC-9/CD-9: recordPayoutOutcome es owner-scoped — filtra por idempotency_key Y sender_address", async () => {
    const { client, calls } = makeClient([{ data: null, error: null }]);
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordPayoutOutcome({
      idempotencyKey: "rem-1:q-1",
      senderAddress: SENDER,
      status: "settled",
      payoutId: "p-1",
      vm: "solana",
    });
    // El UPDATE cruza AMBOS filtros: sin el sender_address, otro owner podría mutar esta fila (IDOR).
    expect(calls.eq).toContainEqual(["idempotency_key", "rem-1:q-1"]);
    expect(calls.eq).toContainEqual(["sender_address", SENDER]);
    // El patch lleva el status mapeado.
    expect((calls.update[0]?.[0] as Record<string, unknown> | undefined)?.status).toBe("settled");
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

  // WKH-320: acá vivía "byte-id EVM: recordPayoutOutcome vm:'evm' sigue produciendo
  // senderAddress.toLowerCase()". Probaba que una fila vm='evm' escrita desde una address 0x
  // conservara la semántica de lowercase — camino que ningún caller post-poda puede producir.

  // WKH-213/R2 — el UPDATE va PRIMERO y está keyeado por idempotency_key (NO por tx_hash), es
  // owner-scoped y sólo asciende desde 'prepared'. Este test mira los ARGUMENTOS (el estado final de
  // la fila lo miden los tests con la tabla en memoria, más abajo).
  it("recordPrincipalIn: UPDATE por idempotency_key + sender_address + status='prepared' (CAS), con las addresses canónicas y value_minor string", async () => {
    // 1er from() = el UPDATE de ascenso; devuelve una fila ⇒ la función corta ahí.
    const { client, calls } = makeClient([{ data: [{ id: "row-1" }], error: null }]);
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordPrincipalIn({
      remittanceId: "rem-1",
      quoteId: "q-1",
      idempotencyKey: "rem-1:q-1",
      txHash: "0xTX",
      chainId: CHAIN_ID_NOT_APPLICABLE,
      senderAddress: SENDER,
      receiverAddress: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      valueMinor: 400_000_000,
      vm: "solana",
    });
    const patch = calls.update[0]?.[0] as Record<string, unknown>;
    expect(patch.status).toBe("principal_in");
    expect(patch.tx_hash).toBe("0xTX");
    expect(patch.sender_address).toBe(SENDER);
    expect(patch.receiver_address).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"); // base58 sin lowercase (CD-7)
    expect(patch.value_minor).toBe("400000000"); // string (uint256-safe)
    // payout_id NO viaja en el patch: escribirlo (null) borraría el id de la orden que puso prepare.
    expect(Object.keys(patch)).not.toContain("payout_id");
    // La clave del write es idempotency_key: con onConflict:'tx_hash' el INSERT moría contra el OTRO
    // índice único y la fila jamás llegaba a principal_in.
    expect(calls.eq).toContainEqual(["idempotency_key", "rem-1:q-1"]);
    expect(calls.eq).toContainEqual(["sender_address", SENDER]); // ownership (CD-9)
    expect(calls.eq).toContainEqual(["status", "prepared"]); // CAS: nunca degrada un estado avanzado
    // Matcheó ⇒ NO hay segundo write (ni relleno de evidencia, ni INSERT).
    expect(calls.upsert.length).toBe(0);
    expect(calls.update.length).toBe(1);
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
        vm: "solana",
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
    // Filtro NO-TERMINAL (DT-2b): nunca degrada un estado terminal ni reclasifica manual_review.
    // WKH-213/R1: 'prepared' ESTÁ en el conjunto — sin él, el aviso del proveedor sobre una orden cuyo
    // settle nunca aterrizó se perdía y la fila quedaba congelada para siempre.
    expect(calls.in[0]?.[0]).toBe("status");
    expect(calls.in[0]?.[1]).toEqual(["principal_in", "submitted", "forward_error", "prepared"]);
    // Y NO degrada: los terminales siguen afuera.
    const updatable = calls.in[0]?.[1] as string[];
    expect(updatable).not.toContain("settled");
    expect(updatable).not.toContain("failed");
    expect(updatable).not.toContain("manual_review");
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
    // WKH-320: antes este sub-caso probaba que el case IMPORTA pasando `vm:"evm"` para forzar el
    // lowercase del canonicalizador. Esa rama ya no existe. Se prueba lo mismo de forma DIRECTA, que
    // además es más honesta: una pubkey lowercaseada a mano o NO canonicaliza (throw) o es OTRA
    // address; en ninguno de los dos casos devuelve las filas de SOL_A.
    const loweredRaw = SOL_A.toLowerCase();
    expect(loweredRaw).not.toBe(SOL_A);
    const lowered = await ledger
      .listRemittanceIdsBySender({ senderAddress: loweredRaw, vm: "solana", limit: 20 })
      .catch(() => []);
    expect(lowered).toEqual([]);
    expect(selects.length).toBeGreaterThanOrEqual(2);
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

  // ── listPreparedDepositAddresses · el lado B del chequeo de destino del settle ────────────────────
  // Lo que devuelve esta lectura es contra lo que el settle compara el beneficiary que va DENTRO de la
  // tx firmada. Dos formas de romperla en silencio, y las dos se prueban con el doble de
  // COMPORTAMIENTO (un espía no las caza):
  //   · sin `.eq('sender_address', …)` ⇒ la dirección de OTRO sender entra en la lista de válidas
  //   · sin `.eq('remittance_id', …)`  ⇒ una dirección de OTRA remesa del mismo sender entra igual
  // En los dos casos el guard del settle seguiría "pasando", pero ya no compararía lo que dice comparar.
  it("devuelve SOLO la deposit-address de ESA remesa y ESE sender", async () => {
    const { client } = makeBehaviorClient(solRows());
    const out = await new SupabaseSettlementLedger(client).listPreparedDepositAddresses({
      remittanceId: "rem-A-old",
      senderAddress: SOL_A,
    });
    expect(out).toEqual([DEPOSIT_A_OLD]);
    expect(out).not.toContain(DEPOSIT_A_NEW); // otra remesa del MISMO sender: no es válida acá
    expect(out).not.toContain(DEPOSIT_B1); // otro sender: el guard de ownership
  });

  it("la remesa de OTRO sender no aporta ninguna dirección (IDOR: el filtro es el sender)", async () => {
    const { client } = makeBehaviorClient(solRows());
    const out = await new SupabaseSettlementLedger(client).listPreparedDepositAddresses({
      remittanceId: "rem-B1", // existe, pero es de SOL_B
      senderAddress: SOL_A,
    });
    expect(out).toEqual([]); // ⇒ el settle responde 'unregistered', NO 'mismatch'
  });

  it("NO filtra por status: una fila ya avanzada (settled) sigue aportando su dirección", async () => {
    // Un settle reintentado encuentra su fila fuera de 'prepared'. Con un `.eq('status','prepared')`
    // esto devolvería [] y el retry legítimo se leería como "no registrada".
    const { client } = makeBehaviorClient(solRows());
    const out = await new SupabaseSettlementLedger(client).listPreparedDepositAddresses({
      remittanceId: "rem-A-new", // status 'settled'
      senderAddress: SOL_A,
    });
    expect(out).toEqual([DEPOSIT_A_NEW]);
  });

  it("fail-loud: error del builder ⇒ throw, NUNCA [] (una lista vacía se leería como 'no hay ninguna')", async () => {
    const { client } = makeClient([{ data: null, error: { code: "PGRST301" } }]);
    await expect(
      new SupabaseSettlementLedger(client).listPreparedDepositAddresses({
        remittanceId: "rem-1",
        senderAddress: SOL_A,
      }),
    ).rejects.toThrow(/ledger_list_prepared_addresses_failed:PGRST301/);
  });

  it("filtra por remittance_id Y sender_address canonicalizado (recorder: los argumentos exactos)", async () => {
    const { client, calls } = makeClient([{ data: [], error: null }]);
    await new SupabaseSettlementLedger(client).listPreparedDepositAddresses({
      remittanceId: "rem-1",
      senderAddress: SOL_A,
    });
    expect(calls.eq).toContainEqual(["remittance_id", "rem-1"]);
    expect(calls.eq).toContainEqual(["sender_address", new PublicKey(SOL_A).toBase58()]);
    expect(calls.eq.map((c) => c[0])).not.toContain("status"); // ver el test de arriba
    expect(String(calls.select[0]?.[0])).not.toContain("value_minor"); // no se lee ⇒ sin ::text
  });

  // ── R0 tras el fix de escritura: filas LEGACY (vm='evm') + filas nuevas (vm='solana') convivien ──
  it("R0 sigue igual DESPUÉS del fix: recupera las filas legacy (vm='evm') Y las nuevas (vm='solana') del mismo sender", async () => {
    // La tabla real va a tener las dos cosas: lo escrito antes del fix (mislabel 'evm') y lo escrito
    // después ('solana'). La lectura de HU-SOL-20 NO discrimina por vm ⇒ devuelve ambas. Si alguien
    // agregara `.eq('vm','solana')`, la fila legacy desaparecería y el refund de una remesa vieja se
    // quedaría sin remittanceId (la plata atrapada en el escrow, que es el caso que R0 cubre).
    const mixed: FakeLedgerRow[] = [
      { remittance_id: "rem-legacy", status: "prepared", created_at: "2026-07-20T00:00:00.000Z", sender_address: SOL_A, vm: "evm", value_minor: "0", receiver_address: DEPOSIT_A_OLD },
      { remittance_id: "rem-nueva", status: "prepared", created_at: "2026-07-28T00:00:00.000Z", sender_address: SOL_A, vm: "solana", value_minor: "0", receiver_address: DEPOSIT_A_NEW },
      { remittance_id: "rem-otro-sender", status: "prepared", created_at: "2026-07-28T00:00:00.000Z", sender_address: SOL_B, vm: "solana", value_minor: "0", receiver_address: DEPOSIT_B1 },
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
// El bug: el upsert escribía SÓLO chain_id (el id numérico de red configurado) y descartaba el `vm`
// en silencio ⇒ toda fila quedaba con el discriminador y el id de red heredados aunque su address
// fuera base58, y cualquier query que filtrara .eq('vm','solana') devolvía CERO filas SIEMPRE.
// Las dos mitades del arreglo (escribir `vm` y anular `chain_id`) van juntas o el CHECK de la DB
// rechaza el insert — y ese rechazo lo traga el catch best-effort de la ruta (CD-17), o sea que se
// pierde la evidencia durable con un log como única señal. Por eso se prueba con un doble que APLICA
// el CHECK, no con un espía.
const CHAIN_ID_EVM = 84532; // id numérico de red de una versión anterior de este servicio
const CHAIN_ID_MISLABEL = 43113; // el id numérico que se escribía, mal, en las filas de este servicio

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
    const { client, rows, rejected } = makeTableClient();
    await new SupabaseSettlementLedger(client).recordOrderPrepared({
      remittanceId: "rem-1",
      quoteId: "q-1",
      idempotencyKey: "rem-1:q-1",
      depositAddress: SOL_B,
      chainId: CHAIN_ID_MISLABEL, // el caller sigue pasando un chainId EVM: el ledger lo IGNORA
      senderAddress: SOL_A,
      payoutId: "p-1",
      payoutProvenance: "transfi",
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

  // WKH-320: acá vivía "recordOrderPrepared vm:'evm' ⇒ byte-idéntico (chain_id numérico,
  // network_id NULL)". Probaba escribir una fila vm='evm' desde una address 0x, camino que ningún
  // caller post-poda puede producir. La otra mitad del invariante —que la escritura con vm:'solana'
  // pone network_id CAIP-2 y chain_id NULL— se sigue probando justo abajo, y ES la que corre en prod.

  it("recordPrincipalIn vm:'solana' ⇒ mismas dos mitades (el escritor del principal tenía el MISMO bug)", async () => {
    const { client, rows, rejected } = makeTableClient();
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

  // WKH-320: ídem para recordPrincipalIn vm:'evm'.

  it("invariante de los DOS escritores × las DOS VMs: exactamente UNA columna de red no-nula, coherente con vm", async () => {
    // Barrido: si un escritor futuro (o un refactor) desacopla las mitades en cualquiera de los cuatro
    // combos, esto se pone rojo — el CHECK del doble rechaza y `rejected` deja de estar vacío.
    // WKH-213: prepare + settle de la MISMA remesa son UNA sola fila (el settle completa la preparada),
    // así que el barrido también fija que el merge no rompe la identidad de red.
    for (const vm of ["evm", "solana"] as const) {
      const sender = vm === "solana" ? SOL_A : SENDER;
      const receiver = vm === "solana" ? SOL_B : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
      const { client, rows, rejected } = makeTableClient();
      const ledger = new SupabaseSettlementLedger(client);
      await ledger.recordOrderPrepared({
        remittanceId: "rem-x",
        quoteId: "q-x",
        idempotencyKey: "rem-x:q-x",
        depositAddress: receiver,
        chainId: CHAIN_ID_EVM,
        senderAddress: sender,
        payoutId: "p-x",
        payoutProvenance: "transfi",
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
      expect(rows.length).toBe(1); // una remesa = UNA fila (el settle aterriza sobre la preparada)
      expect(rows[0]?.status).toBe("principal_in");
      expect(rows[0]?.tx_hash).toBe("0xTXX");
      expect(rows[0]?.payout_id).toBe("p-x"); // el merge NO pisó el payout_id de prepare
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

// ── WKH-213 · el settle ATERRIZA sobre la fila preparada (R2) ────────────────────────────────────────
// Todo lo de acá mide el ESTADO FINAL DE LA FILA contra la tabla en memoria que aplica los DOS índices
// únicos + el CHECK + los NOT NULL. Un espía de `upsert` no sirve: el bug original era precisamente
// que la llamada se hacía "bien" y la DB la rechazaba.
// WKH-320: estas fixtures eran EVM (address 0x + vm:'evm' + chainId numérico). El SUJETO de este
// bloque no es la VM: es el write-path del ledger (idempotencia, el CAS por sender, los dos índices
// únicos, la precedencia del webhook). Ese camino vive, así que la fixture se convierte a Solana en
// vez de borrarse — borrarla habría tirado 13 invariantes del money-path que no son EVM-específicos.
const SENDER_SOL = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEPOSIT_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECEIVER_SOL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function prepareInput(over: Record<string, unknown> = {}) {
  return {
    remittanceId: "rem-1",
    quoteId: "q-1",
    idempotencyKey: "rem-1:q-1",
    depositAddress: DEPOSIT_SOL,
    chainId: CHAIN_ID_NOT_APPLICABLE,
    senderAddress: SENDER_SOL,
    payoutId: "transfi-po-1",
    payoutProvenance: "transfi", // orden REAL por default; los tests de proveniencia lo sobreescriben
    vm: "solana" as const,
    ...over,
  };
}
function settleInput(over: Record<string, unknown> = {}) {
  return {
    remittanceId: "rem-1",
    quoteId: "q-1",
    idempotencyKey: "rem-1:q-1",
    txHash: "0xTXREAL",
    chainId: CHAIN_ID_NOT_APPLICABLE,
    senderAddress: SENDER_SOL,
    receiverAddress: DEPOSIT_SOL, // el destino VERIFICADO on-chain ES el atestado en prepare
    valueMinor: 400_000_000,
    vm: "solana" as const,
    ...over,
  };
}

describe("WKH-213/R2 — el settle completa la fila 'prepared' (estado final de la fila)", () => {
  it("prepare + settle ⇒ UNA fila en principal_in, con el hash y el monto REALES y el payout_id INTACTO", async () => {
    const { client, rows, rejected } = makeTableClient();
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(prepareInput());
    await ledger.recordPrincipalIn(settleInput());

    expect(rejected).toEqual([]); // con onConflict:'tx_hash' acá había un 23505 (uq_remit_settle_idem)
    expect(rows.length).toBe(1); // la MISMA fila, no una nueva
    const row = rows[0]!;
    expect(row.status).toBe("principal_in"); // ← lo que en prod NUNCA pasaba
    expect(row.tx_hash).toBe("0xTXREAL"); // el placeholder 'prepared:…' quedó reemplazado
    expect(row.value_minor).toBe("400000000"); // monto real (venía '0' de prepare)
    expect(row.payout_id).toBe("transfi-po-1"); // ← el merge NO pisó con null lo que prepare dejó bien
    expect(row.sender_address).toBe(SENDER_SOL); // base58 sin lowercase (CD-7)
    expect(row.receiver_address).toBe(DEPOSIT_SOL);
    expect(row.idempotency_key).toBe("rem-1:q-1");
    expect(row.created_at).toBe(COLUMN_DEFAULTS.created_at); // es la fila de prepare, no una recién nacida
  });

  it("idempotencia REAL: el settle repetido 3 veces deja la fila idéntica y NO lanza", async () => {
    const { client, rows, rejected } = makeTableClient();
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(prepareInput());
    await ledger.recordPrincipalIn(settleInput());
    const after1 = { ...rows[0]! };
    await expect(ledger.recordPrincipalIn(settleInput())).resolves.toBeUndefined();
    await expect(ledger.recordPrincipalIn(settleInput())).resolves.toBeUndefined();
    expect(rejected).toEqual([]); // un retry benigno NO puede disparar un falso [ALERT] 23505
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual(after1); // byte-idéntica: reintentar es inocuo
  });

  it("settle SIN prepare (modo estático WKH-168/209 o ledger apagado al preparar) ⇒ INSERT normal", async () => {
    const { client, rows, rejected } = makeTableClient();
    await new SupabaseSettlementLedger(client).recordPrincipalIn(
      settleInput({ receiverAddress: RECEIVER_SOL }),
    );
    expect(rejected).toEqual([]);
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("principal_in");
    expect(rows[0]?.tx_hash).toBe("0xTXREAL");
    expect(rows[0]?.payout_id).toBeNull(); // no hubo prepare: no hay orden que preservar
  });

  it("CD-9: un settle de OTRO sender NO se lleva puesta la fila preparada (sigue 'prepared', sin fila nueva)", async () => {
    const OTRO = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    const { client, rows, rejected } = makeTableClient();
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(prepareInput());
    await ledger.recordPrincipalIn(settleInput({ senderAddress: OTRO, txHash: "0xATACANTE" }));
    expect(rejected).toEqual([]);
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("prepared"); // intacta
    expect(rows[0]?.sender_address).toBe(SENDER_SOL); // NO se reescribió con el ajeno
    expect(rows[0]?.tx_hash).toBe("prepared:rem-1:q-1"); // ni su evidencia
  });

  it("la protección del índice de tx_hash SIGUE viva: dos remesas distintas con el MISMO hash ⇒ TIRA 23505", async () => {
    const { client, rows } = makeTableClient();
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(prepareInput());
    await ledger.recordPrincipalIn(settleInput()); // rem-1 se queda con 0xTXREAL
    await ledger.recordOrderPrepared(
      prepareInput({ remittanceId: "rem-2", quoteId: "q-2", idempotencyKey: "rem-2:q-2" }),
    );
    // rem-2 intenta reclamar el MISMO hash on-chain: la DB lo rechaza y el ledger NO se lo come.
    await expect(
      ledger.recordPrincipalIn(
        settleInput({ remittanceId: "rem-2", quoteId: "q-2", idempotencyKey: "rem-2:q-2" }),
      ),
    ).rejects.toThrow(/ledger_record_principal_in_failed:23505/);
    expect(rows.find((r) => r.remittance_id === "rem-2")?.status).toBe("prepared"); // no se corrompió
  });

  // ── EL ORDEN INVERSO: el webhook del proveedor llega ANTES que el settle ──────────────────────────
  it("webhook ANTES que el settle: el settle NO degrada el estado terminal, pero SÍ completa la evidencia", async () => {
    const { client, rows, rejected } = makeTableClient();
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(prepareInput());
    // R1: el proveedor avisa "pagado" sobre la fila 'prepared' (antes esto no mutaba NADA).
    await ledger.recordWebhookOutcome({ payoutId: "transfi-po-1", status: "settled" });
    expect(rows[0]?.status).toBe("settled");
    // Y ahora sí llega el settle, tarde.
    await ledger.recordPrincipalIn(settleInput());
    expect(rejected).toEqual([]);
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("settled"); // ← NO vuelve a principal_in (sería un retroceso de estado)
    expect(rows[0]?.tx_hash).toBe("0xTXREAL"); // ← pero el hash verificado on-chain NO se pierde
    expect(rows[0]?.value_minor).toBe("400000000");
    expect(rows[0]?.payout_id).toBe("transfi-po-1");
  });

  it("webhook ANTES que el settle: la fila terminal NO vuelve a la cola de varadas (listStale la ignora)", async () => {
    const { client } = makeTableClient();
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(prepareInput());
    await ledger.recordWebhookOutcome({ payoutId: "transfi-po-1", status: "settled" });
    await ledger.recordPrincipalIn(settleInput());
    const stale = await ledger.listStale({ olderThanIso: "2030-01-01T00:00:00.000Z", limit: 50 });
    expect(stale).toEqual([]); // si el settle hubiera degradado el status, acá aparecería
  });

  it("el settle NO pisa una evidencia real ya escrita, ni siquiera con otro hash (fila ya avanzada)", async () => {
    const { client, rows } = makeTableClient();
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(prepareInput());
    await ledger.recordPrincipalIn(settleInput());
    await ledger.recordPayoutOutcome({
      idempotencyKey: "rem-1:q-1",
      senderAddress: SENDER,
      status: "submitted",
      payoutId: "transfi-po-1",
      vm: "evm",
    });
    await ledger.recordPrincipalIn(settleInput({ txHash: "0xOTROHASH" }));
    expect(rows[0]?.status).toBe("submitted"); // no degrada
    expect(rows[0]?.tx_hash).toBe("0xTXREAL"); // no reescribe la evidencia original
  });

  // ── La otra dirección: la huérfana de verdad SIGUE siendo huérfana ────────────────────────────────
  it("prepare SIN settle ⇒ la fila sigue 'prepared' y aparece como huérfana (nadie la asciende sola)", async () => {
    const { client, rows } = makeTableClient([]);
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(prepareInput());
    expect(rows[0]?.status).toBe("prepared");
    // No está en la cola de varadas (su principal NUNCA entró: no se re-procesa — CD-6).
    expect(await ledger.listStale({ olderThanIso: "2030-01-01T00:00:00.000Z", limit: 50 })).toEqual(
      [],
    );
    // Pero SÍ está en la superficie de huérfanas.
    const orphans = await ledger.listPreparedOrphans({
      olderThanIso: "2030-01-01T00:00:00.000Z",
      limit: 50,
    });
    expect(orphans.total).toBe(1);
    expect(orphans.records[0]?.remittanceId).toBe("rem-1");
    expect(orphans.records[0]?.payoutId).toBe("transfi-po-1"); // el id que el operador cancela
  });
});

describe("WKH-213/R1 — el webhook puede sacar una fila de 'prepared'", () => {
  it("'prepared' + webhook 'settled' ⇒ la fila queda settled (antes se quedaba en prepared para siempre)", async () => {
    const { client, rows } = makeTableClient();
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(prepareInput());
    await ledger.recordWebhookOutcome({ payoutId: "transfi-po-1", status: "settled" });
    expect(rows[0]?.status).toBe("settled");
  });

  it("'prepared' + webhook 'failed' ⇒ failed con last_error enum estable (NUNCA el motivo crudo)", async () => {
    const { client, rows } = makeTableClient();
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(prepareInput());
    await ledger.recordWebhookOutcome({
      payoutId: "transfi-po-1",
      status: "failed",
      error: "transfi_fund_failed",
    });
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.last_error).toBe("transfi_fund_failed");
  });

  it.each([
    ["settled", "settled"],
    ["failed", "failed"],
    ["manual_review", "manual_review"],
  ])("DT-2b intacto: una fila '%s' NO la degrada el webhook", async (initial, expected) => {
    const { client, rows } = makeTableClient([
      {
        remittance_id: "rem-9",
        quote_id: "q-9",
        idempotency_key: "rem-9:q-9",
        tx_hash: "0xtx9",
        chain_id: CHAIN_ID_EVM,
        sender_address: SENDER,
        receiver_address: DEPOSIT_SOL.toLowerCase(),
        value_minor: "400000000",
        status: initial,
        payout_id: "transfi-po-9",
      },
    ]);
    await new SupabaseSettlementLedger(client).recordWebhookOutcome({
      payoutId: "transfi-po-9",
      status: "submitted",
    });
    expect(rows[0]?.status).toBe(expected); // sin cambios
  });
});

describe("WKH-213/R3 — el settle escribe al ledger", () => {
  const SOL_SIGNATURE = "5".repeat(64); // base58 (dígitos válidos en el alfabeto)
  function solPrepared() {
    return {
      remittanceId: "rem-sol",
      quoteId: "q-sol",
      idempotencyKey: "rem-sol:q-sol",
      depositAddress: SOL_B,
      chainId: CHAIN_ID_MISLABEL, // el caller pasa un chainId EVM: el ledger lo IGNORA en Solana
      senderAddress: SOL_A,
      payoutId: "transfi-po-sol",
      payoutProvenance: "transfi",
      vm: "solana" as const,
    };
  }

  it("prepared Solana + signature ⇒ principal_in con la firma como tx_hash, identidad de red INTACTA", async () => {
    const { client, rows, rejected } = makeTableClient();
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(solPrepared());
    await ledger.recordSolanaPrincipalIn({
      remittanceId: "rem-sol",
      senderAddress: SOL_A,
      signature: SOL_SIGNATURE,
    });
    expect(rejected).toEqual([]);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.status).toBe("principal_in"); // ← antes: 'prepared' para siempre
    expect(row.tx_hash).toBe(SOL_SIGNATURE); // la firma ES el identificador de tx en Solana
    expect(row.vm).toBe("solana"); // marcada como Solana, NO como EVM
    expect(row.network_id).toBe(resolveSolanaNetworkId());
    expect(row.chain_id).toBeNull();
    expect(row.payout_id).toBe("transfi-po-sol"); // intacto
    expect(row.sender_address).toBe(new PublicKey(SOL_A).toBase58()); // base58 case-preservado (CD-10)
  });

  it("sin fila 'prepared' ⇒ NO-OP: jamás inventa una fila (no hay quote_id/value_minor honestos)", async () => {
    const { client, rows, rejected } = makeTableClient();
    await new SupabaseSettlementLedger(client).recordSolanaPrincipalIn({
      remittanceId: "rem-inexistente",
      senderAddress: SOL_A,
      signature: SOL_SIGNATURE,
    });
    expect(rows).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it("CD-9: la signature de OTRO sender no toca la fila (sigue 'prepared')", async () => {
    const { client, rows } = makeTableClient();
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(solPrepared());
    await ledger.recordSolanaPrincipalIn({
      remittanceId: "rem-sol",
      senderAddress: SOL_B, // otro sender
      signature: SOL_SIGNATURE,
    });
    expect(rows[0]?.status).toBe("prepared");
    expect(rows[0]?.tx_hash).toBe("prepared:rem-sol:q-sol");
  });

  // El CAS del UPDATE (`.eq("status","prepared")`) NO es redundante con el filtro del SELECT: protege
  // la ventana ENTRE los dos round-trips. Un doble secuencial no puede expresar esa carrera, así que
  // se inyecta el interleaving a mano — sin este test, borrar el CAS no rompe nada y el guard muere.
  function withRaceBeforeNthFrom(
    inner: SupabaseClient,
    nth: number,
    effect: () => void,
  ): SupabaseClient {
    let n = 0;
    const from = (table: string): unknown => {
      n += 1;
      if (n === nth) effect();
      return (inner as unknown as { from: (t: string) => unknown }).from(table);
    };
    return { from } as unknown as SupabaseClient;
  }

  it("CARRERA: si el webhook mueve la fila ENTRE el select y el update, el CAS evita la degradación", async () => {
    const { client, rows } = makeTableClient();
    await new SupabaseSettlementLedger(client).recordOrderPrepared(solPrepared());
    // 1er from() = el SELECT de la fila 'prepared'; 2º from() = el UPDATE. El webhook se cuela justo
    // antes del UPDATE y la deja en terminal.
    const raced = withRaceBeforeNthFrom(client, 2, () => {
      rows[0]!.status = "settled";
    });
    await new SupabaseSettlementLedger(raced).recordSolanaPrincipalIn({
      remittanceId: "rem-sol",
      senderAddress: SOL_A,
      signature: SOL_SIGNATURE,
    });
    expect(rows[0]?.status).toBe("settled"); // el UPDATE no encontró 'prepared' ⇒ no degradó
    expect(rows[0]?.tx_hash).toBe("prepared:rem-sol:q-sol"); // tampoco escribió sobre una fila cerrada
  });

  it("CAS: si el webhook ya la movió a terminal, la signature NO degrada el estado", async () => {
    const { client, rows } = makeTableClient();
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(solPrepared());
    await ledger.recordWebhookOutcome({ payoutId: "transfi-po-sol", status: "settled" });
    await ledger.recordSolanaPrincipalIn({
      remittanceId: "rem-sol",
      senderAddress: SOL_A,
      signature: SOL_SIGNATURE,
    });
    expect(rows[0]?.status).toBe("settled");
  });
});

describe("WKH-213 — listPreparedOrphans (superficie del operador)", () => {
  function preparedRow(i: number, createdAt: string): Record<string, unknown> {
    return {
      remittance_id: `rem-${i}`,
      quote_id: `q-${i}`,
      idempotency_key: `rem-${i}:q-${i}`,
      tx_hash: `prepared:rem-${i}:q-${i}`,
      chain_id: CHAIN_ID_EVM,
      sender_address: SENDER,
      receiver_address: DEPOSIT_SOL.toLowerCase(),
      value_minor: "0",
      status: "prepared",
      payout_id: `po-${i}`,
      created_at: createdAt,
      updated_at: createdAt,
    };
  }

  it("total es el conteo EXACTO de coincidencias, NO el tamaño de la página", async () => {
    const seed = Array.from({ length: 7 }, (_, i) =>
      preparedRow(i, `2026-07-20T00:00:0${i}.000Z`),
    );
    const { client } = makeTableClient(seed);
    const out = await new SupabaseSettlementLedger(client).listPreparedOrphans({
      olderThanIso: "2026-07-21T00:00:00.000Z",
      limit: 3,
    });
    expect(out.records.length).toBe(3); // la página
    expect(out.total).toBe(7); // la verdad
    expect(out.records[0]?.remittanceId).toBe("rem-0"); // las más viejas primero
  });

  it("filtra por created_at (NO updated_at) y sólo status 'prepared'", async () => {
    const { client } = makeTableClient([
      preparedRow(1, "2026-07-20T00:00:00.000Z"), // vieja ⇒ huérfana
      preparedRow(2, "2026-07-28T00:00:00.000Z"), // recién creada ⇒ todavía no
      { ...preparedRow(3, "2026-07-20T00:00:00.000Z"), status: "principal_in", tx_hash: "0xreal" },
    ]);
    const out = await new SupabaseSettlementLedger(client).listPreparedOrphans({
      olderThanIso: "2026-07-21T00:00:00.000Z",
      limit: 50,
    });
    expect(out.total).toBe(1);
    expect(out.records.map((r) => r.remittanceId)).toEqual(["rem-1"]);
  });

  it("fail-loud: error de la consulta ⇒ TIRA (NUNCA una lista vacía, que se leería como 'no hay nada')", async () => {
    const { client } = makeClient([{ data: null, error: { code: "PGRST301" } }]);
    await expect(
      new SupabaseSettlementLedger(client).listPreparedOrphans({
        olderThanIso: "2030-01-01T00:00:00.000Z",
        limit: 50,
      }),
    ).rejects.toThrow(/ledger_list_prepared_failed:PGRST301/);
  });

  it("fail-loud: si PostgREST no devuelve el count exacto ⇒ TIRA (no degrada a records.length)", async () => {
    // Sin `count`, reportar total=1 sobre una página de 1 sería inventar el tamaño del problema.
    const { client } = makeClient([{ data: [rawRow({ status: "prepared" })], error: null }]);
    await expect(
      new SupabaseSettlementLedger(client).listPreparedOrphans({
        olderThanIso: "2030-01-01T00:00:00.000Z",
        limit: 50,
      }),
    ).rejects.toThrow("ledger_list_prepared_count_missing");
  });

  it("CD-12: el select trae value_minor::text y pide count exact", async () => {
    const { client, calls } = makeClient([{ data: [], error: null, count: 0 }]);
    await new SupabaseSettlementLedger(client).listPreparedOrphans({
      olderThanIso: "2030-01-01T00:00:00.000Z",
      limit: 50,
    });
    expect(String(calls.select[0]?.[0])).toContain("value_minor::text");
    expect(calls.select[0]?.[1]).toEqual({ count: "exact" });
    expect(calls.eq).toContainEqual(["status", "prepared"]);
    expect(calls.lt[0]).toEqual(["created_at", "2030-01-01T00:00:00.000Z"]); // created_at, NO updated_at
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
