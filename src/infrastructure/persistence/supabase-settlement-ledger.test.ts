// Tests — SupabaseSettlementLedger + getSettlementLedger (WKH-207 W1). Mockea el query-builder de
// Supabase (chainable): cero red, cero DB. Cubre AC-4 (listStale), AC-9 (owner-scope), CD-12
// (value_minor::text) y AC-10 (factory null-safe).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PublicKey } from "@solana/web3.js";
import {
  CHAIN_ID_NOT_APPLICABLE,
  SupabaseSettlementLedger,
  WEBHOOK_UPDATABLE_STATUSES,
  getSettlementLedger,
} from "./supabase-settlement-ledger";
import { __resetSupabaseClient, getSupabaseServerClient } from "./supabase-server";
import { resolveSolanaNetworkId } from "../chain";
import {
  TRANSFI_FUND_FAILED_NO_PRINCIPAL,
  TRANSFI_FUND_FAILED_PRINCIPAL_IN_ESCROW,
  TRANSFI_FUND_FAILED_PRINCIPAL_RELEASED,
  WEBHOOK_FAILURE_CLASSES,
} from "./webhook-failure-classes";

// Registra cada método del builder + resuelve un resultado por cada from() (queue). El builder es
// thenable ⇒ `await builder` resuelve el resultado asignado a ese from().
interface Calls {
  from: unknown[];
  select: unknown[][];
  upsert: unknown[][];
  update: unknown[][];
  eq: unknown[][];
  in: unknown[][];
  like: unknown[][]; // WKH-325: P3 de recordSolanaPrincipalIn filtra por el prefijo del placeholder
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
    like: [],
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
      builder.like = chain("like");
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
//   · atomicidad del UPDATE multi-fila            → o se escriben TODAS las filas que matchean, o
//     ninguna (WKH-325/MNR-5: modelarlo fila-por-fila dejaba la primera escrita cuando la segunda
//     violaba la unique, que es un estado que Postgres nunca deja ver).
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
  // Migración 20260804: nullable, SIN default ⇒ la fila que nadie escribe nace NULL ("no consta").
  payout_provenance: null,
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
  /** Unicidad evaluada sobre la imagen POSTERIOR del statement completo (todas las filas que el
   *  UPDATE matchea, ya aplicadas). Postgres chequea el índice único al cierre del statement, así que
   *  dos filas del MISMO UPDATE que aterrizan en el mismo tx_hash colisionan ENTRE SÍ. El modelo
   *  fila-por-fila sólo veía esa colisión de rebote (porque ya había escrito la primera), y por eso
   *  no podía distinguirse de un statement que escribe la primera y aborta en la segunda. */
  const uniqueViolationIn = (
    image: Record<string, unknown>[],
    selfIdx: number,
    next: Record<string, unknown>,
  ): DbViolation | null => {
    for (const [j, other] of image.entries()) {
      if (j === selfIdx) continue;
      if (other.tx_hash === next.tx_hash) {
        return { code: "23505", constraint: "uq_remit_settle_txhash", message: "duplicate tx_hash" };
      }
      if (other.idempotency_key === next.idempotency_key) {
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
      builder.like = vi.fn((col: string, pattern: string) => {
        // CD-17 — este doble implementa SÓLO el patrón `prefijo%`. Ante cualquier otra forma TIRA, en
        // vez de fingir que la modela: "un doble que no modela una restricción de la DB prueba la
        // fantasía que el doble implementa" (fakes.ts).
        if (!/^[^%_]+%$/.test(pattern)) throw new Error(`fake_like_unsupported_pattern:${pattern}`);
        const prefix = pattern.slice(0, -1);
        filters.push((r) => typeof r[col] === "string" && (r[col] as string).startsWith(prefix));
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
          // ATÓMICO. Un UPDATE multi-fila es UN solo statement: si CUALQUIERA de las filas que
          // matchea viola una restricción, el statement entero se revierte y NINGUNA queda escrita.
          // El modelo anterior asignaba fila por fila y abortaba a mitad, o sea que dejaba la primera
          // mutada — un estado que la DB real nunca produce, y sobre el que un test podía afirmar.
          // Se valida TODA la imagen posterior antes de tocar una sola fila.
          const matchedIds = new Set(matched.map((r) => r.id));
          const image = rows.map((r) => (matchedIds.has(r.id) ? { ...r, ...pending } : { ...r }));
          for (const [i, next] of image.entries()) {
            if (!matchedIds.has(next.id)) continue;
            const violation = rowViolation(next) ?? uniqueViolationIn(image, i, next);
            if (violation) {
              rejected.push(violation);
              return resolve({ data: null, error: violation }); // cero mutaciones
            }
          }
          for (const r of matched) Object.assign(r, pending);
          // PostgREST devuelve las filas mutadas SOLO si se encadenó .select().
          return resolve({ data: selectCols ? matched.map(project) : null, error: null });
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
/** Envuelve un cliente para que `effect()` corra JUSTO ANTES del n-ésimo `from()`, o sea EN MEDIO de
 *  dos round-trips de un mismo método. Es la única forma de expresar una carrera contra un doble
 *  secuencial: sin esto, los guards que protegen la ventana entre dos queries (el CAS del paso 2, el
 *  `.in(status)` del paso 3) no tienen ningún test que pueda ponerse rojo si se borran. */
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

  // T-5a (AC-5) — LA FORMA DE LAS TRES QUERIES de la rama 'failed'. Convertido del test WKH-210/DT-8:
  // antes afirmaba que el `last_error` que llegaba por parámetro se persistía tal cual; ahora el caller
  // ya no puede pasarlo (el parámetro se eliminó del port) y lo que hay que fijar es que los TRES
  // UPDATEs salen con SU conjunto de estados previos en el WHERE.
  it("T-5a (AC-5/CD-2): la rama 'failed' hace TRES updates disjuntos, cada uno con su .in(status) y su last_error, y NINGÚN select precede al primer update", async () => {
    const { client, calls } = makeClient([
      { data: [{ id: "a" }], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ]);
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordWebhookOutcome({ payoutId: "p-2", status: "failed" });

    expect(calls.update.length).toBe(3);
    expect(calls.in.map((c) => c[1])).toEqual([
      ["prepared"],
      ["principal_in", "forward_error"],
      ["submitted"],
    ]);
    expect(calls.update.map((c) => (c[0] as Record<string, unknown>).last_error)).toEqual([
      "transfi_fund_failed_no_principal",
      "transfi_fund_failed_principal_in_escrow",
      "transfi_fund_failed_principal_released",
    ]);
    // Los tres escriben 'failed' y correlacionan por payout_id, jamás por sender_address (CD-12).
    for (const c of calls.update) expect((c[0] as Record<string, unknown>).status).toBe("failed");
    expect(calls.eq.every((c) => c[0] === "payout_id")).toBe(true);
    // CD-2 — el `.select("id")` existe para saber SI matcheó, no para leer estado: pide "id" y nada
    // más, y va DESPUÉS del update. Un select previo al primer update sería la lectura prohibida.
    expect(calls.select).toEqual([["id"], ["id"], ["id"]]);
    // Y son EXACTAMENTE 3 round-trips: 3 from(), 3 update, 3 select. No hay lugar para un cuarto
    // viaje que lea el estado previo antes de escribir — un `select` previo haría este número 4.
    expect(calls.from.length).toBe(3);
  });

  // T-5b (CD-2, transversal) — la forma OPERATIVA de "el estado previo no se lee": ninguna lista de
  // columnas de NINGÚN select de estos dos métodos puede contener la subcadena "status".
  it("T-5b (CD-2): ni recordWebhookOutcome ni recordSolanaPrincipalIn seleccionan JAMÁS la columna status", async () => {
    const webhook = makeClient([
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ]);
    await new SupabaseSettlementLedger(webhook.client).recordWebhookOutcome({
      payoutId: "p-5b",
      status: "failed",
    });
    const solana = makeClient([
      { data: [], error: null }, // P1: sin fila 'prepared'
      { data: [], error: null }, // P3: 0 filas
      { data: [], error: null }, // P4: no es nuestra firma
      { data: [], error: null }, // P5: no hay fila
    ]);
    await new SupabaseSettlementLedger(solana.client).recordSolanaPrincipalIn({
      remittanceId: "rem-5b",
      senderAddress: SOL_A,
      signature: "5".repeat(64),
    });
    // Presencia ANTES que ausencia (CD-13): si no hubiera select alguno, el assert de abajo mediría
    // cero y pasaría en verde sin decir nada.
    expect(webhook.calls.select.length).toBeGreaterThan(0);
    expect(solana.calls.select.length).toBeGreaterThan(0);
    for (const call of [...webhook.calls.select, ...solana.calls.select]) {
      expect(String(call[0])).not.toContain("status");
    }
  });

  it("WKH-210/AC-8: 0-match (payoutId inexistente) no lanza (Supabase no reporta error en UPDATE 0-row)", async () => {
    const { client } = makeClient([{ data: null, error: null }]);
    const ledger = new SupabaseSettlementLedger(client);
    await expect(
      ledger.recordWebhookOutcome({ payoutId: "no-existe", status: "settled" }),
    ).resolves.toEqual({ classified: false });
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

  // ══ WKH-330 · AC-5 ═══════════════════════════════════════════════════════════════════════════════
  // Que esta query NO filtre por `status` es lo único que hace recuperable el remittanceId de un
  // depósito REAL cuyo registro falló. Ese es el caso entero de esta HU: el settle Solana broadcastea,
  // la signature queda verificada on-chain, el write 'prepared' → 'principal_in' falla por infra
  // (SQLSTATE clase 08) y la fila se queda en 'prepared'. Si esta lista dejara de devolver las
  // 'prepared', la persona pierde el ÚNICO argumento con el que pide el refund trustless de su
  // escrow — un depósito real se vuelve irrecuperable por una caída de DB de treinta segundos.
  //
  // ⚠️ FIXTURE LOCAL, NO solRows(). Medido sobre el commit base: cambiando los literales "prepared"
  // de solRows() y del fixture de la ruta, y borrando el camino de recuperación al mismo tiempo, la
  // suite ENTERA quedaba verde. O sea que el candado existía por accidente, no porque alguien lo
  // afirmara. Un fixture local con su propia fila 'prepared' es lo que lo vuelve intencional.
  // Refutación de que sirva: poner `.eq("status", "principal_in")` en la cadena de
  // listRemittanceIdsBySender y ver este test rojo con ESTE mensaje, no con uno que hable de IDOR.
  it("T-330-5a (AC-5): un depósito REAL cuyo write falló queda en 'prepared' y su remittanceId DEBE seguir siendo recuperable (sin él no hay refund)", async () => {
    const SENDER_LOCAL = SOL_A;
    // La fila del depósito real cuyo registro falló: el settle broadcasteó, la firma existe, y el
    // write que la movía a 'principal_in' tiró 08006. Sigue en 'prepared'.
    const DEPOSITO_REAL_SIN_REGISTRAR = "rem-330-write-fallido";
    const filasLocales: FakeLedgerRow[] = [
      {
        remittance_id: DEPOSITO_REAL_SIN_REGISTRAR,
        status: "prepared",
        created_at: "2026-08-06T10:00:00.000Z",
        sender_address: SENDER_LOCAL,
        vm: "solana",
        value_minor: "0",
        receiver_address: DEPOSIT_A_OLD,
      },
      {
        remittance_id: "rem-330-ok",
        status: "settled",
        created_at: "2026-08-06T09:00:00.000Z",
        sender_address: SENDER_LOCAL,
        vm: "solana",
        value_minor: "0",
        receiver_address: DEPOSIT_A_NEW,
      },
    ];
    const { client } = makeBehaviorClient(filasLocales);
    const out = await new SupabaseSettlementLedger(client).listRemittanceIdsBySender({
      senderAddress: SENDER_LOCAL,
      vm: "solana",
      limit: 20,
    });
    const ids = out.map((r) => r.remittanceId);
    expect(
      ids,
      "la lista dejó de devolver la fila 'prepared': el remittanceId de un depósito real cuyo write falló se volvió irrecuperable y la persona no puede pedir el refund",
    ).toContain(DEPOSITO_REAL_SIN_REGISTRAR);
    // El status viaja: quien consume decide. Filtrar acá sería decidir por él, y decidir mal.
    expect(out.find((r) => r.remittanceId === DEPOSITO_REAL_SIN_REGISTRAR)?.status).toBe("prepared");
    // El caso no es vacuo: la fila terminal del mismo sender también está, así que un `toContain`
    // que pasara por devolver todo no se distingue de uno que pasa por devolver lo correcto.
    expect(ids).toEqual([DEPOSITO_REAL_SIN_REGISTRAR, "rem-330-ok"]); // created_at DESC
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
    // No está en la cola de varadas (una 'prepared' no se re-procesa — CD-6; su registro, no el mundo).
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

  // T-2a (AC-2) — convertido: antes el caller pasaba `error:"transfi_fund_failed"` y el test afirmaba
  // que se persistía tal cual. Ahora el caller no puede pasarlo y el literal lo DERIVA el ledger del
  // estado previo. Una fila 'prepared' significa que el ledger NO registró un depósito nuestro — NO
  // que no lo haya habido (residuo #5 del auto-blindaje: un write best-effort que falla de forma
  // transitoria deja la fila acá). Lo que este test fija es la clasificación, que es state-based.
  it("T-2a (AC-2): 'prepared' + webhook 'failed' ⇒ transfi_fund_failed_no_principal (sin depósito REGISTRADO)", async () => {
    const { client, rows } = makeTableClient();
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(prepareInput());
    const out = await ledger.recordWebhookOutcome({ payoutId: "transfi-po-1", status: "failed" });
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.last_error).toBe("transfi_fund_failed_no_principal");
    expect(out).toEqual({ classified: true, failures: ["no_principal"] });
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

// ── WKH-325 · un `fund_failed` tapa TRES situaciones, y el estado previo de la fila las separa ──────
// Todo lo de acá mide el ESTADO FINAL DE LA FILA contra la tabla en memoria: lo que un operador lee
// para decidir si escalar es la columna `last_error`, no la forma de la query.
describe("WKH-325 — los tres desenlaces del fund_failed (AC-1/2/3/5/6)", () => {
  /** Una fila del ledger en el estado previo pedido, correlacionada por el MISMO payout_id.
   *  `n` da tx_hash/idempotency_key distintos para no chocar con los índices únicos. */
  function rowInStatus(status: string, n = 1, payoutId = "ord-1"): Record<string, unknown> {
    return {
      remittance_id: `rem-${n}`,
      quote_id: `q-${n}`,
      idempotency_key: `rem-${n}:q-${n}`,
      tx_hash: `prepared:rem-${n}:q-${n}`,
      chain_id: CHAIN_ID_EVM,
      sender_address: SENDER_SOL,
      receiver_address: DEPOSIT_SOL,
      value_minor: "400000000",
      status,
      payout_id: payoutId,
    };
  }
  /** El MISMO body de webhook para todos los casos: lo único que cambia entre ellos es el estado
   *  previo de la fila. Si el literal dependiera del body, esto no podría distinguir nada. */
  const FUND_FAILED = { payoutId: "ord-1", status: "failed" as const };

  it("T-1a (AC-1): una fila 'submitted' (el proveedor confirmó asset_deposited) ⇒ transfi_fund_failed_principal_released", async () => {
    const { client, rows } = makeTableClient([rowInStatus("submitted")]);
    await new SupabaseSettlementLedger(client).recordWebhookOutcome(FUND_FAILED);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.last_error).toBe("transfi_fund_failed_principal_released");
  });

  it("T-1b (AC-1): esa MISMA llamada devuelve {classified:true, failures:['principal_released']}", async () => {
    const { client } = makeTableClient([rowInStatus("submitted")]);
    const out = await new SupabaseSettlementLedger(client).recordWebhookOutcome(FUND_FAILED);
    expect(out).toEqual({ classified: true, failures: ["principal_released"] });
  });

  // T-2b — golden de literales. EXCEPCIÓN ÚNICA Y DECLARADA de la regla "los tres literales viven en
  // webhook-failure-classes.ts y ningún otro archivo los escribe a mano": acá se escriben literalmente
  // UNA vez, para que renombrar un enum sea una decisión visible en un diff en vez de un drift mudo.
  it("T-2b (AC-2): los tres literales exportados son exactamente los esperados", () => {
    expect(TRANSFI_FUND_FAILED_NO_PRINCIPAL).toBe("transfi_fund_failed_no_principal");
    expect(TRANSFI_FUND_FAILED_PRINCIPAL_IN_ESCROW).toBe("transfi_fund_failed_principal_in_escrow");
    expect(TRANSFI_FUND_FAILED_PRINCIPAL_RELEASED).toBe("transfi_fund_failed_principal_released");
  });

  it("T-3a (AC-3): tres filas ('submitted','prepared','principal_in') y EL MISMO body ⇒ TRES last_error DISTINTOS", async () => {
    const { client, rows } = makeTableClient([
      rowInStatus("submitted", 1),
      rowInStatus("prepared", 2),
      rowInStatus("principal_in", 3),
    ]);
    await new SupabaseSettlementLedger(client).recordWebhookOutcome(FUND_FAILED);
    const errors = rows.map((r) => r.last_error);
    // Presencia antes que distinción: si ninguna fila se hubiera clasificado, el Set tendría un solo
    // elemento (null) y el size !== 3 lo delataría igual, pero esto lo dice de frente.
    expect(errors.every((e) => typeof e === "string")).toBe(true);
    expect(new Set(errors).size).toBe(3);
  });

  it("T-3b (AC-3): 'forward_error' produce el MISMO literal que 'principal_in' (los dos son plata en el escrow) ⇒ 4 filas, 3 valores", async () => {
    const { client, rows } = makeTableClient([
      rowInStatus("submitted", 1),
      rowInStatus("prepared", 2),
      rowInStatus("principal_in", 3),
      rowInStatus("forward_error", 4),
    ]);
    await new SupabaseSettlementLedger(client).recordWebhookOutcome(FUND_FAILED);
    const byStatus = (n: number) => rows.find((r) => r.remittance_id === `rem-${n}`)?.last_error;
    expect(byStatus(4)).toBe(byStatus(3)); // forward_error ≡ principal_in
    expect(byStatus(4)).not.toBe(byStatus(1));
    expect(byStatus(4)).not.toBe(byStatus(2));
    expect(new Set(rows.map((r) => r.last_error)).size).toBe(3);
  });

  it.each(["settled", "failed", "manual_review"])(
    "T-6a (AC-6/CD-3): una fila '%s' (terminal) NO cambia de status NI de last_error, y no se clasifica",
    async (terminal) => {
      const { client, rows } = makeTableClient([rowInStatus(terminal)]);
      const before = { ...rows[0] };
      const out = await new SupabaseSettlementLedger(client).recordWebhookOutcome(FUND_FAILED);
      expect(rows[0]?.status).toBe(terminal);
      expect(rows[0]?.last_error).toBe(before.last_error); // null si era null
      expect(out).toEqual({ classified: true, failures: [] });
    },
  );

  it("T-6b (DT-6): DOS filas del mismo payout_id en estados previos distintos ⇒ DOS last_error distintos y DOS clases en una sola llamada", async () => {
    const { client, rows } = makeTableClient([
      rowInStatus("prepared", 1),
      rowInStatus("submitted", 2),
    ]);
    const out = await new SupabaseSettlementLedger(client).recordWebhookOutcome(FUND_FAILED);
    expect(rows[0]?.last_error).toBe("transfi_fund_failed_no_principal");
    expect(rows[1]?.last_error).toBe("transfi_fund_failed_principal_released");
    expect(out).toEqual({
      classified: true,
      failures: ["no_principal", "principal_released"],
    });
  });

  it("T-6c (fallo parcial): si el 2º UPDATE tira, la clasificación del 1º QUEDA y el retry completa el resto sin pisarla", async () => {
    const { client, rows } = makeTableClient([
      rowInStatus("prepared", 1),
      rowInStatus("principal_in", 2),
      rowInStatus("submitted", 3),
    ]);
    // Falla SOLO el 2º from() de la primera pasada (el UPDATE de la clase principal_in_escrow).
    let n = 0;
    const flaky = {
      from: (t: string) => {
        n += 1;
        if (n === 2) throw new Error("boom:08006");
        return (client as unknown as { from: (t: string) => unknown }).from(t);
      },
    } as unknown as SupabaseClient;
    await expect(
      new SupabaseSettlementLedger(flaky).recordWebhookOutcome(FUND_FAILED),
    ).rejects.toThrow(/boom/);
    // U1 ya aplicó: esa fila quedó final y correcta.
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.last_error).toBe("transfi_fund_failed_no_principal");
    expect(rows[1]?.status).toBe("principal_in"); // U2 no llegó a correr
    // El retry (lo que hace TransFi ante el 503) completa el resto SIN re-escribir la primera.
    const out = await new SupabaseSettlementLedger(client).recordWebhookOutcome(FUND_FAILED);
    expect(out).toEqual({
      classified: true,
      failures: ["principal_in_escrow", "principal_released"],
    });
    expect(rows[0]?.last_error).toBe("transfi_fund_failed_no_principal"); // intacta
    expect(rows[1]?.last_error).toBe("transfi_fund_failed_principal_in_escrow");
    expect(rows[2]?.last_error).toBe("transfi_fund_failed_principal_released");
  });

  // T-INV (DT-2) — los invariantes de los que depende que el orden no importe. (b) y (d) se comparan
  // contra fuentes INDEPENDIENTES a propósito: un invariante que sólo se compara contra su propia
  // fuente aplaude cualquier cosa.
  it("T-INV (DT-2): los tres conjuntos son disjuntos, su unión es exactamente el set mutable por el webhook, y ninguno contiene un terminal", () => {
    const sets = WEBHOOK_FAILURE_CLASSES.map((s) => s.previousStatuses);
    const union = sets.flatMap((s) => [...s]);
    // (a) disjunción: si dos conjuntos compartieran un status, el Set sería más chico que la suma.
    expect(union.length).toBe(new Set(union).size);
    // (b) la unión es el set mutable por el webhook — escrito acá a mano como fuente INDEPENDIENTE
    //     (es el mismo valor que el test WKH-210/CD-12 lee de la query real de la rama no-failed).
    expect([...union].sort()).toEqual(
      ["forward_error", "prepared", "principal_in", "submitted"].sort(),
    );
    // (b2) …y contra la constante REAL, importada de su módulo (WKH-325/MNR-2). El comentario de
    //      webhook-failure-classes.ts decía que (b) ataba esta constante, y era falso: (b) es un
    //      literal a mano y WEBHOOK_UPDATABLE_STATUSES ni siquiera estaba exportada, así que un dev
    //      que la cambiara y greppeara "T-INV" llegaba a un test que se quedaba verde. Los dos
    //      asserts se necesitan: (b) caza que la unión driftee, (b2) caza que driftee la constante.
    expect([...union].sort()).toEqual([...WEBHOOK_UPDATABLE_STATUSES].sort());
    // (c) ningún terminal adentro ⇒ AC-6/CD-3 se cumplen por construcción, no por un chequeo extra.
    for (const t of ["failed", "settled", "manual_review"]) expect(union).not.toContain(t);
    // (d) golden literal de los tres arrays, escrito a mano.
    expect(sets).toEqual([["prepared"], ["principal_in", "forward_error"], ["submitted"]]);
  });

  it("T-ORD (DT-2): aplicar los tres UPDATEs en orden INVERSO produce el MISMO estado final", async () => {
    const seed = () => [
      rowInStatus("prepared", 1),
      rowInStatus("principal_in", 2),
      rowInStatus("forward_error", 3),
      rowInStatus("submitted", 4),
    ];
    const shape = (rs: Record<string, unknown>[]) =>
      rs.map((r) => ({ rid: r.remittance_id, status: r.status, lastError: r.last_error }));

    // (1) La implementación real (orden declarado).
    const real = makeTableClient(seed());
    await new SupabaseSettlementLedger(real.client).recordWebhookOutcome(FUND_FAILED);

    /** Los mismos tres UPDATEs, en el orden que se le pase. Se prueba contra la implementación real
     *  ANTES de usarlo para el orden inverso: si este helper no reprodujera exactamente lo que hace el
     *  ledger, la comparación de abajo no diría nada del código de producción. */
    async function applyInOrder(
      specs: readonly (typeof WEBHOOK_FAILURE_CLASSES)[number][],
    ): Promise<Record<string, unknown>[]> {
      const { client, rows } = makeTableClient(seed());
      for (const spec of specs) {
        const q = (client as unknown as { from: (t: string) => Record<string, unknown> }).from(
          "remittance_settlements",
        );
        const upd = (q.update as (p: unknown) => Record<string, unknown>)({
          status: "failed",
          last_error: spec.lastError,
          updated_at: "2026-08-05T00:00:00.000Z",
        });
        const byPayout = (upd.eq as (c: string, v: unknown) => Record<string, unknown>)(
          "payout_id",
          "ord-1",
        );
        const byStatus = (byPayout.in as (c: string, v: unknown[]) => Record<string, unknown>)(
          "status",
          [...spec.previousStatuses],
        );
        await (byStatus.select as (c: string) => Promise<unknown>)("id");
      }
      return rows;
    }

    // (2) El helper en el orden DECLARADO tiene que dar lo mismo que la implementación real.
    expect(shape(await applyInOrder(WEBHOOK_FAILURE_CLASSES))).toEqual(shape(real.rows));
    // (3) Y en el orden INVERSO, también: ningún conjunto contiene 'failed', así que una fila mutada
    //     por un UPDATE sale de todos los demás y el orden no puede cambiar el resultado.
    expect(shape(await applyInOrder([...WEBHOOK_FAILURE_CLASSES].reverse()))).toEqual(
      shape(real.rows),
    );
    // Y no es vacuo: el estado final tiene los TRES literales presentes.
    expect(new Set(real.rows.map((r) => r.last_error)).size).toBe(3);
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
  // se inyecta el interleaving a mano (withRaceBeforeNthFrom, arriba) — sin este test, borrar el CAS
  // no rompe nada y el guard muere.
  it("CARRERA: si el webhook mueve la fila ENTRE el select y el update, el CAS evita la degradación", async () => {
    const { client, rows } = makeTableClient();
    await new SupabaseSettlementLedger(client).recordOrderPrepared(solPrepared());
    // 1er from() = el SELECT de la fila 'prepared'; 2º from() = el UPDATE. El webhook se cuela justo
    // antes del UPDATE y la deja en terminal.
    const raced = withRaceBeforeNthFrom(client, 2, () => {
      rows[0]!.status = "settled";
    });
    const out = await new SupabaseSettlementLedger(raced).recordSolanaPrincipalIn({
      remittanceId: "rem-sol",
      senderAddress: SOL_A,
      signature: SOL_SIGNATURE,
    });
    expect(rows[0]?.status).toBe("settled"); // el UPDATE no encontró 'prepared' ⇒ no degradó
    // WKH-325 — CONVERTIDO. Antes esto afirmaba que el tx_hash seguía siendo el placeholder, o sea que
    // la signature del depósito se PERDÍA por haber perdido la carrera. El status sigue sin degradarse
    // (eso es lo que el CAS protege y no cambió), pero la evidencia ahora es ADITIVA: el paso 3
    // completa el tx_hash porque seguía siendo un placeholder de prepare, sin tocar el status.
    expect(rows[0]?.tx_hash).toBe(SOL_SIGNATURE);
    expect(out).toBe("evidence_filled");
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

// ── WKH-325 · el `return` mudo se convierte en CINCO desenlaces, y tres de ellos gritan ─────────────
// El remittanceId es el único argumento con el que se pide un refund on-chain y no vive en ninguna
// cuenta de la cadena. Antes, "no había fila 'prepared'" era un `return` sin señal, indistinguible de
// un éxito. Acá se cuentan las alertas con el MISMO helper sobre el MISMO spy en cada test, para que
// un `toBe(0)` no pueda pasar midiendo una captura vacía (CD-13).
describe("WKH-325 — los cinco desenlaces de recordSolanaPrincipalIn (AC-8/AC-9)", () => {
  const SIG = "5".repeat(64); // base58 (dígitos válidos en el alfabeto)
  const OTHER_SIG = "6".repeat(64);
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });
  /** Alertas del ledger emitidas hasta acá. Es la MISMA función para los casos de 1 y los de 0. */
  const ledgerAlerts = (): string[] =>
    errSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("[ledger][ALERT]"));

  function solRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      remittance_id: "rem-1",
      quote_id: "q-1",
      idempotency_key: "rem-1:q-1",
      tx_hash: "prepared:rem-1:q-1",
      chain_id: null,
      network_id: resolveSolanaNetworkId(),
      vm: "solana",
      sender_address: SOL_A,
      receiver_address: SOL_B,
      value_minor: "400000000",
      status: "prepared",
      payout_id: "transfi-po-1",
      ...over,
    };
  }
  /** Una fila de (remesa, sender) ARBITRARIOS, con su propio placeholder de prepare y su propia
   *  idempotency_key. Existe porque `solRow()` describe UNA sola remesa de UN solo sender, y con un
   *  solo actor en la tabla ningún filtro por actor puede fallar: los mutantes que borran
   *  `.eq("remittance_id", …)` o `.eq("sender_address", …)` de los pasos 3/4/5 sobreviven no porque
   *  el código esté bien, sino porque el fixture no tiene con qué refutarlos (WKH-325/BLQ-1). */
  function solRowOf(
    remittanceId: string,
    sender: string,
    quoteId: string,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return solRow({
      remittance_id: remittanceId,
      sender_address: sender,
      quote_id: quoteId,
      idempotency_key: `${remittanceId}:${quoteId}`,
      tx_hash: `prepared:${remittanceId}:${quoteId}`,
      payout_id: `transfi-po-${remittanceId}-${quoteId}`,
      ...over,
    });
  }
  const record = (client: SupabaseClient, signature = SIG) =>
    new SupabaseSettlementLedger(client).recordSolanaPrincipalIn({
      remittanceId: "rem-1",
      senderAddress: SOL_A,
      signature,
    });

  it("T-8a (AC-8): fila 'failed' con el placeholder intacto ⇒ 1 alerta, el status SIGUE 'failed', desenlace evidence_filled", async () => {
    const { client, rows } = makeTableClient([solRow({ status: "failed" })]);
    const out = await record(client);
    expect(out).toBe("evidence_filled");
    expect(rows[0]?.status).toBe("failed"); // NO se degrada un terminal (CD-3)
    expect(rows[0]?.tx_hash).toBe(SIG); // la evidencia SÍ se completa
    expect(ledgerAlerts().length).toBe(1);
    expect(ledgerAlerts()[0]).toContain("solana_principal_in_late_evidence");
  });

  it("T-8b (AC-8): SIN ninguna fila de (remittanceId, sender) ⇒ 1 alerta solana_principal_in_no_row y CERO escrituras", async () => {
    const { client, rows, rejected } = makeTableClient();
    const out = await record(client);
    expect(out).toBe("unrecorded_no_row");
    expect(rows).toEqual([]); // jamás inventa una fila (quote_id/value_minor son NOT NULL)
    expect(rejected).toEqual([]);
    expect(ledgerAlerts().length).toBe(1);
    expect(ledgerAlerts()[0]).toContain("solana_principal_in_no_row");
  });

  // T-8c — CD-13: el par presencia/ausencia en el MISMO `it`, con el MISMO spy y el MISMO helper. El
  // `0` no puede pasar por una captura vacía, porque el mismo contador produce el `1` dos líneas abajo.
  it("T-8c (CD-13): el camino feliz ('prepared' ⇒ ascenso) NO alerta; el caso 'failed' SÍ", async () => {
    const feliz = makeTableClient([solRow()]);
    const out = await record(feliz.client);
    expect(out).toBe("ascended");
    expect(feliz.rows[0]?.status).toBe("principal_in");
    expect(ledgerAlerts().length).toBe(0);

    const roto = makeTableClient([solRow({ status: "failed" })]);
    expect(await record(roto.client)).toBe("evidence_filled");
    expect(ledgerAlerts().length).toBe(1);
  });

  it("T-9a (AC-9): fila 'submitted' con placeholder ⇒ tx_hash completado, status intacto y updated_at avanzado", async () => {
    const { client, rows } = makeTableClient([
      solRow({ status: "submitted", updated_at: "2020-01-01T00:00:00.000Z" }),
    ]);
    expect(await record(client)).toBe("evidence_filled");
    expect(rows[0]?.tx_hash).toBe(SIG);
    expect(rows[0]?.status).toBe("submitted"); // el patch de P3 NO contiene `status`
    expect(String(rows[0]?.updated_at) > "2020-01-01T00:00:00.000Z").toBe(true);
  });

  it("T-9b (AC-9): con evidencia REAL ya escrita, NO se pisa — sin alerta si la firma es la nuestra, CON alerta si es otra", async () => {
    // (a) NUESTRA firma ya persistida: retry benigno del sponsor ⇒ NO-OP y CERO alertas.
    const mine = makeTableClient([solRow({ status: "submitted", tx_hash: SIG })]);
    expect(await record(mine.client)).toBe("already_recorded");
    expect(mine.rows[0]?.tx_hash).toBe(SIG);
    expect(ledgerAlerts().length).toBe(0);

    // (b) la fila tiene evidencia de OTRA cosa: NO se pisa (el .like del paso 3 no matchea) y grita.
    const other = makeTableClient([solRow({ status: "submitted", tx_hash: OTHER_SIG })]);
    expect(await record(other.client)).toBe("unrecorded_conflict");
    expect(other.rows[0]?.tx_hash).toBe(OTHER_SIG); // evidencia verificada on-chain, INTACTA
    expect(ledgerAlerts().length).toBe(1);
    expect(ledgerAlerts()[0]).toContain("solana_principal_in_evidence_conflict");
  });

  // T-9c — RESIDUO DECLARADO, no un caso resuelto. Una remesa recotizada puede tener DOS filas fuera
  // de 'prepared' con el placeholder intacto: el paso 3 matchea las dos, el índice único
  // uq_remit_settle_txhash rechaza y la función TIRA. No se silencia y no rompe el money-path (el
  // try/catch del sponsor lo traga y lo grita). No se "arregla" acá porque arreglarlo pide elegir a
  // cuál de las dos filas pertenece el depósito, y esa elección no tiene fuente verificada.
  it("T-9c (residuo declarado): dos filas de la misma remesa con placeholder ⇒ tira 23505 SIN escribir ninguna de las dos", async () => {
    const { client, rows } = makeTableClient([
      solRowOf("rem-1", SOL_A, "q-1", { status: "submitted" }),
      solRowOf("rem-1", SOL_A, "q-2", { status: "forward_error" }),
    ]);
    await expect(record(client)).rejects.toThrow(
      /ledger_record_solana_principal_in_failed:23505/,
    );
    // "en vez de escribir a ciegas" es la afirmación del nombre, y ahora se verifica: el UPDATE
    // multi-fila es UN statement, así que la primera fila NO queda con la signature y la segunda
    // rechazada. Este assert sólo es honesto porque el doble modela esa atomicidad (ver makeTableClient).
    expect(rows.map((r) => r.tx_hash)).toEqual(["prepared:rem-1:q-1", "prepared:rem-1:q-2"]);
  });

  // ── Scoping de los pasos 3/4/5: DOS remesas y DOS senders ───────────────────────────────────────
  // Los cinco tests de arriba usan una tabla con un solo actor, y con un solo actor un filtro por
  // actor no puede fallar: borrar `.eq("sender_address")` o `.eq("remittance_id")` de los pasos que
  // esta HU crea dejaba la suite ENTERA en verde (WKH-325/BLQ-1). Acá la tabla tiene siempre una fila
  // que NO es la del caller, y cada test fija que la escritura toca EXACTAMENTE una fila: la suya.
  describe("BLQ-1 — cada paso escribe/lee SÓLO la fila de (esta remesa, este sender)", () => {
    it("T-SCOPE-a: con una fila ajena por remesa y otra por sender, el paso 3 completa UNA sola", async () => {
      const { client, rows } = makeTableClient([
        solRowOf("rem-1", SOL_A, "q-1", { status: "submitted" }), // la del caller
        solRowOf("rem-1", SOL_B, "q-B", { status: "submitted" }), // MISMA remesa, OTRO sender
        solRowOf("rem-2", SOL_A, "q-2", { status: "submitted" }), // MISMO sender, OTRA remesa
      ]);
      expect(await record(client)).toBe("evidence_filled");
      expect(rows[0]?.tx_hash).toBe(SIG); // la suya SÍ
      expect(rows[1]?.tx_hash).toBe("prepared:rem-1:q-B"); // la del otro sender, intacta
      expect(rows[2]?.tx_hash).toBe("prepared:rem-2:q-2"); // la de la otra remesa, intacta
      expect(ledgerAlerts().length).toBe(1);
    });

    it("T-SCOPE-b (CD-9/IDOR): sin fila propia, la fila de OTRO sender en la MISMA remesa no se toca ni se cuenta", async () => {
      const { client, rows } = makeTableClient([
        solRowOf("rem-1", SOL_B, "q-B", { status: "submitted" }),
      ]);
      // El caller es SOL_A y no tiene fila: el desenlace honesto es "no hay NINGÚN registro mío".
      // Si el paso 3 perdiera su owner-filter, la signature de A caería sobre la fila de B; si lo
      // perdiera el paso 5, el desenlace pasaría a 'unrecorded_conflict' por evidencia ajena.
      expect(await record(client)).toBe("unrecorded_no_row");
      expect(rows[0]?.tx_hash).toBe("prepared:rem-1:q-B");
      expect(rows[0]?.status).toBe("submitted");
      expect(ledgerAlerts().length).toBe(1);
      expect(ledgerAlerts()[0]).toContain("solana_principal_in_no_row");
    });

    it("T-SCOPE-c: sin fila propia, la fila del MISMO sender en OTRA remesa no recibe esta signature", async () => {
      const { client, rows } = makeTableClient([
        solRowOf("rem-2", SOL_A, "q-2", { status: "submitted" }),
      ]);
      // Sin el `.eq("remittance_id")` del paso 3 esto no es un tema de permisos: es evidencia
      // CRUZADA. La signature del settle de rem-1 quedaría escrita como el tx_hash de rem-2, en
      // silencio y pasando la unique, porque hay exactamente una fila candidata.
      expect(await record(client)).toBe("unrecorded_no_row");
      expect(rows[0]?.tx_hash).toBe("prepared:rem-2:q-2");
      expect(ledgerAlerts().length).toBe(1);
      expect(ledgerAlerts()[0]).toContain("solana_principal_in_no_row");
    });

    it("T-SCOPE-d: la firma persistida en la fila de OTRO sender NO cuenta como 'ya registrada'", async () => {
      const { client } = makeTableClient([
        solRowOf("rem-1", SOL_B, "q-B", { status: "submitted", tx_hash: SIG }),
      ]);
      // El paso 4 ('already_recorded') es el único desenlace SIN alerta. Si leyera filas ajenas, un
      // depósito sin registro propio se reportaría como registrado y el remittanceId se perdería en
      // silencio — exactamente el defecto que esta HU vino a cerrar.
      expect(await record(client)).toBe("unrecorded_no_row");
      expect(ledgerAlerts().length).toBe(1);
      expect(ledgerAlerts()[0]).toContain("solana_principal_in_no_row");
    });

    // MUT-H — el `.in("status", NON_PREPARED_STATUSES)` del paso 3 sólo se distingue de su ausencia
    // bajo una carrera: un `prepare` que aterriza ENTRE el paso 1 y el paso 3. Sin la carrera el
    // filtro es equivalente a nada (si el paso 1 no encontró una 'prepared', tampoco la encuentra el
    // paso 3), y por eso ningún test secuencial puede matarlo.
    it("T-SCOPE-e (MUT-H): un prepare que aterriza a mitad NO recibe la signature de este settle", async () => {
      const { client, rows } = makeTableClient([
        solRowOf("rem-1", SOL_A, "q-1", { status: "prepared" }),
      ]);
      // from() #1 = SELECT del paso 1 (encuentra la 'prepared'); #2 = UPDATE del paso 2. Justo antes
      // del #2 el webhook mueve la fila a 'submitted' (el CAS falla ⇒ 0 filas) y una recotización
      // inserta una fila 'prepared' NUEVA. El paso 3 tiene que completar la vieja y NO tocar la nueva:
      // su placeholder es lo que permite que un settle posterior la ascienda.
      const raced = withRaceBeforeNthFrom(client, 2, () => {
        for (const r of rows) r.status = "submitted"; // hay exactamente una fila en este punto
        rows.push({
          id: "seed-late",
          ...COLUMN_DEFAULTS,
          ...solRowOf("rem-1", SOL_A, "q-late", { status: "prepared" }),
        });
      });
      const out = await new SupabaseSettlementLedger(raced).recordSolanaPrincipalIn({
        remittanceId: "rem-1",
        senderAddress: SOL_A,
        signature: SIG,
      });
      expect(out).toBe("evidence_filled");
      expect(rows[0]?.tx_hash).toBe(SIG); // la que perdió la carrera SÍ recibe la evidencia
      expect(rows[0]?.status).toBe("submitted"); // el paso 3 no lleva `status` en el patch
      expect(rows[1]?.tx_hash).toBe("prepared:rem-1:q-late"); // la nueva conserva su placeholder
      expect(rows[1]?.status).toBe("prepared");
    });
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

// ── La evidencia tiene que poder contestar "¿esto movió plata?" ───────────────────────────────────
// Antes de la columna payout_provenance, una orden SIMULADA y una REAL escribían filas idénticas en
// forma: mismo status 'prepared', misma clase de receiver_address (base58 válida), mismo payout_id
// presente, mismo network_id CAIP-2, mismo tx_hash placeholder, mismo value_minor '0'. Lo único que
// las separaba era el prefijo del payoutId (`fb-`, src/infrastructure/fallback/gateways.ts:115), que
// es una convención INCIDENTAL del proveedor simulado: nadie se comprometió a mantenerla, ningún
// lector la declara, y el día que cambie la evidencia deja de distinguir sin que nada se ponga rojo.
describe("payout_provenance — una orden simulada y una real dejan filas DISTINGUIBLES", () => {
  /** Columnas que identifican a la fila (tienen que diferir sí o sí: dos órdenes son dos órdenes) o
   *  que la DB genera. NO participan de "¿esta fila movió plata?". */
  const IDENTITY_COLS = ["id", "remittance_id", "quote_id", "idempotency_key", "tx_hash", "payout_id"];
  const shapeOf = (row: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(row).filter(([k]) => !IDENTITY_COLS.includes(k)));

  /** Dos órdenes preparadas en la MISMA tabla: una real y una simulada. Los payoutId se eligen SIN
   *  ningún marcador (`po-a` / `po-b`): si el test se apoyara en un prefijo, estaría clavando la
   *  convención que este cambio vino a reemplazar. */
  async function twoOrders(realProvenance: string, simulatedProvenance: string) {
    const { client, rows, rejected } = makeTableClient();
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(
      prepareInput({
        remittanceId: "rem-real",
        quoteId: "q-real",
        idempotencyKey: "rem-real:q-real",
        payoutId: "po-a",
        payoutProvenance: realProvenance,
      }),
    );
    await ledger.recordOrderPrepared(
      prepareInput({
        remittanceId: "rem-sim",
        quoteId: "q-sim",
        idempotencyKey: "rem-sim:q-sim",
        payoutId: "po-b",
        payoutProvenance: simulatedProvenance,
      }),
    );
    expect(rejected).toEqual([]);
    expect(rows.length).toBe(2);
    return { real: rows[0]!, simulated: rows[1]! };
  }

  it("la fila simulada y la real difieren en payout_provenance, y en NADA MÁS que no sea su identidad", async () => {
    const { real, simulated } = await twoOrders("transfi", "devnet-stub");

    // 1. El campo DECLARADO separa las dos filas, y guarda la cadena TAL CUAL (no un booleano: el dato
    //    tiene más de dos valores y colapsarlo perdería QUIÉN desembolsó).
    expect(real.payout_provenance).toBe("transfi");
    expect(simulated.payout_provenance).toBe("devnet-stub");

    // 2. Y esta es la mitad que prueba que hacía falta: SIN ese campo, las dos filas son la MISMA cosa.
    //    Si alguien "arregla" esto guardando un booleano derivado o dejando de escribir la columna,
    //    los dos shapes vuelven a ser iguales y el expect de abajo se pone rojo.
    const { payout_provenance: _r, ...realShape } = shapeOf(real);
    const { payout_provenance: _s, ...simShape } = shapeOf(simulated);
    expect(
      simShape,
      "sacando la proveniencia, una orden simulada y una real son indistinguibles: por eso la columna existe",
    ).toEqual(realShape);
    expect(shapeOf(simulated)).not.toEqual(shapeOf(real)); // con ella, ya no
  });

  it("el discriminador NO es el prefijo del payoutId: con ids sin marcador, la fila sigue diciendo cuál es cuál", async () => {
    const { real, simulated } = await twoOrders("transfi", "local-fallback");
    // Ningún payout_id lleva `fb-` ni ninguna otra pista, y aun así la evidencia contesta.
    expect(String(real.payout_id)).not.toContain("fb-");
    expect(String(simulated.payout_id)).not.toContain("fb-");
    expect(real.payout_provenance).not.toBe(simulated.payout_provenance);
  });

  it("el agente NO declaró proveniencia ⇒ NULL ('no consta'), NUNCA '' ni un default fabricado", async () => {
    const { client, rows } = makeTableClient();
    // "" es EXACTAMENTE lo que produce la ruta cuando el result del agente no trae `provenance`.
    await new SupabaseSettlementLedger(client).recordOrderPrepared(
      prepareInput({ payoutProvenance: "" }),
    );
    expect(rows[0]?.payout_provenance).toBeNull(); // no consta ≠ una proveniencia llamada ""
    expect(rows[0]?.payout_provenance).not.toBe("");
    expect(rows[0]?.payout_provenance).not.toBe("transfi"); // jamás rellenar un default: sería inventar evidencia
  });

  it("whitespace es tan poco declarativo como el vacío ⇒ NULL", async () => {
    const { client, rows } = makeTableClient();
    await new SupabaseSettlementLedger(client).recordOrderPrepared(
      prepareInput({ payoutProvenance: "   " }),
    );
    expect(rows[0]?.payout_provenance).toBeNull();
  });

  it("no-regresión: el resto de la fila 'prepared' queda EXACTAMENTE igual que antes de la columna", async () => {
    const { client, rows, rejected } = makeTableClient();
    await new SupabaseSettlementLedger(client).recordOrderPrepared(prepareInput());
    expect(rejected).toEqual([]);
    const row = rows[0]!;
    expect(row.status).toBe("prepared");
    expect(row.tx_hash).toBe("prepared:rem-1:q-1"); // placeholder determinístico intacto
    expect(row.value_minor).toBe("0"); // el monto sigue siendo desconocido en prepare
    expect(row.payout_id).toBe("transfi-po-1");
    expect(row.receiver_address).toBe(DEPOSIT_SOL);
    expect(row.sender_address).toBe(SENDER_SOL);
    expect(row.vm).toBe("solana");
    expect(row.network_id).toBe(resolveSolanaNetworkId());
    expect(row.chain_id).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.last_error).toBeNull();
  });

  it("la lectura DEVUELVE la proveniencia: sin esto la evidencia se escribe y nadie puede consultarla", async () => {
    const { client } = makeTableClient();
    const ledger = new SupabaseSettlementLedger(client);
    await ledger.recordOrderPrepared(prepareInput({ payoutProvenance: "devnet-stub" }));
    const { records } = await ledger.listPreparedOrphans({
      olderThanIso: "2030-01-01T00:00:00.000Z",
      limit: 10,
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.payoutProvenance).toBe("devnet-stub");
  });

  it("una fila ANTERIOR a la migración se lee como null ('no consta'), NO como undefined ni como real", async () => {
    // Fila vieja: la columna existe en el esquema pero nadie la escribió (y antes de la migración
    // PostgREST ni siquiera la devolvería). Los dos casos tienen que llegar al mismo `null` explícito:
    // un `undefined` DESAPARECE en JSON.stringify y la respuesta admin quedaría sin el campo.
    const { client } = makeTableClient([
      { remittance_id: "rem-old", quote_id: "q-old", idempotency_key: "rem-old:q-old", tx_hash: "prepared:rem-old:q-old", chain_id: null, network_id: "solana:devnet", vm: "solana", sender_address: SENDER_SOL, receiver_address: DEPOSIT_SOL, value_minor: "0", status: "prepared" },
    ]);
    const { records } = await new SupabaseSettlementLedger(client).listPreparedOrphans({
      olderThanIso: "2030-01-01T00:00:00.000Z",
      limit: 10,
    });
    expect(records[0]?.payoutProvenance).toBeNull();
    expect(records[0]).toHaveProperty("payoutProvenance"); // presente y explícito, no ausente
    expect(JSON.parse(JSON.stringify(records[0])).payoutProvenance).toBeNull(); // sobrevive al JSON
  });
});
