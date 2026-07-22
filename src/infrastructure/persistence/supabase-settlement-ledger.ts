// Infrastructure — SettlementLedger sobre Supabase (WKH-207). SERVER-ONLY (CD-11): usa el cliente
// de supabase-server.ts (SUPABASE_SERVICE_ROLE_KEY / BYPASSRLS). PROHIBIDO importarlo desde el browser.
//
// Persiste SOLO evidencia money-path (txHash/monto/address/quoteId/status) — NUNCA PII (CD-7). El
// guard REAL de ownership es app-layer: `.eq('sender_address', <caller>)` (CD-9), porque el service
// key bypassea RLS. Toda lectura de value_minor (numeric(78,0)) castea `::text` y parsea en JS —
// precisión uint256 (CD-12, WKH-196): PostgREST leería un numeric grande como número JSON y
// JSON.parse redondearía > 2^53.
//
// Factory getSettlementLedger(): null si SETTLEMENT_LEDGER_ENABLED !== "true" O el cliente Supabase
// es null (envs ausentes) ⇒ las rutas skipean el persist ⇒ byte-idéntico (AC-2/AC-10). La env se lee
// DENTRO de la factory en runtime (CD-14).
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  SettlementLedger,
  SettlementLedgerStatus,
  SettlementRecord,
} from "../../application/ports";
import { getSupabaseServerClient } from "./supabase-server";
import { canonicalizeAddress } from "../address";

const TABLE = "remittance_settlements";

// Columnas de la tabla en snake_case. value_minor se selecciona con ::text (CD-12).
const SELECT_COLS =
  "id, remittance_id, quote_id, idempotency_key, tx_hash, chain_id, sender_address, receiver_address, value_minor::text, status, attempts, payout_id, last_error, created_at, updated_at";

// Estados NO-terminales candidatos a varado (AC-4). Mirror del índice parcial de la migración.
const STALE_STATUSES: readonly SettlementLedgerStatus[] = [
  "principal_in",
  "submitted",
  "forward_error",
];

// Shape crudo de una fila leída (value_minor llega como string por el ::text).
interface RawRow {
  id: string;
  remittance_id: string;
  quote_id: string;
  idempotency_key: string;
  tx_hash: string;
  chain_id: number;
  sender_address: string;
  receiver_address: string;
  value_minor: string;
  status: SettlementLedgerStatus;
  attempts: number;
  payout_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(r: RawRow): SettlementRecord {
  return {
    id: r.id,
    remittanceId: r.remittance_id,
    quoteId: r.quote_id,
    idempotencyKey: r.idempotency_key,
    txHash: r.tx_hash,
    chainId: r.chain_id,
    senderAddress: r.sender_address,
    receiverAddress: r.receiver_address,
    valueMinor: Number(r.value_minor), // CD-12: parseado desde el string ::text
    status: r.status,
    attempts: r.attempts,
    payoutId: r.payout_id,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class SupabaseSettlementLedger implements SettlementLedger {
  constructor(private readonly client: SupabaseClient) {}

  async recordOrderPrepared(input: {
    remittanceId: string;
    quoteId: string;
    idempotencyKey: string;
    depositAddress: string;
    chainId: number;
    senderAddress: string;
    payoutId: string;
    vm: "evm" | "solana";
  }): Promise<void> {
    // WKH-211/AC-8: registra la orden TransFi creada en prepare (ANTES del principal_in on-chain), para
    // visibilidad de huérfanas (DT-5). Upsert por idempotency_key (retry de prepare = una sola fila).
    // El depositAddress va en receiver_address (ES el receiver no-custodial, SIN columna nueva). NUNCA
    // PII (CD-7). value_minor no se conoce aún → '0' (el real llega en recordPrincipalIn). tx_hash aún
    // no existe (no hubo settle) → placeholder determinístico por idempotency_key (satisface el NOT NULL
    // y no colisiona con un tx_hash real 0x+64hex).
    // [STORY-GAP]: el índice único uq_remit_settle_idem + tx_hash NOT NULL hace que un recordPrincipalIn
    // posterior (upsert onConflict tx_hash con el TX real) colisione con esta fila por idempotency_key →
    // ese write best-effort falla (se loguea, NUNCA rompe el money-path, CD-17). Efecto: una remesa
    // preparada+settleada puede quedar visible como 'prepared'. Fund-safe (CD-6 se mantiene: 'prepared'
    // JAMÁS pasa a principal_in por esta vía). La reconciliación real (relajar tx_hash / re-keyear el
    // upsert de principal_in por idempotency_key) es follow-up — ver reporte F3.
    const { error } = await this.client.from(TABLE).upsert(
      {
        remittance_id: input.remittanceId,
        quote_id: input.quoteId,
        idempotency_key: input.idempotencyKey,
        tx_hash: `prepared:${input.idempotencyKey}`, // placeholder (NOT NULL); no hay settle aún
        chain_id: input.chainId,
        sender_address: canonicalizeAddress(input.senderAddress, input.vm),
        receiver_address: canonicalizeAddress(input.depositAddress, input.vm), // el depositAddress ES el receiver
        value_minor: "0", // desconocido en prepare; el real llega en recordPrincipalIn
        status: "prepared",
        payout_id: input.payoutId,
      },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );
    if (error) throw new Error(`ledger_record_order_prepared_failed:${error.code ?? "unknown"}`);
  }

  async recordPrincipalIn(input: {
    remittanceId: string;
    quoteId: string;
    idempotencyKey: string;
    txHash: string;
    chainId: number;
    senderAddress: string;
    receiverAddress: string;
    valueMinor: number;
    vm: "evm" | "solana";
  }): Promise<void> {
    // Upsert idempotente por tx_hash (ON CONFLICT DO NOTHING): un settle reintentado a nivel red =
    // una sola fila. addresses lowercased (owner canónico, CD-9). value_minor como string (uint256-safe).
    const { error } = await this.client.from(TABLE).upsert(
      {
        remittance_id: input.remittanceId,
        quote_id: input.quoteId,
        idempotency_key: input.idempotencyKey,
        tx_hash: input.txHash,
        chain_id: input.chainId,
        sender_address: canonicalizeAddress(input.senderAddress, input.vm),
        receiver_address: canonicalizeAddress(input.receiverAddress, input.vm),
        value_minor: String(input.valueMinor),
        status: "principal_in",
      },
      { onConflict: "tx_hash", ignoreDuplicates: true },
    );
    if (error) throw new Error(`ledger_record_principal_in_failed:${error.code ?? "unknown"}`);
  }

  async recordPayoutOutcome(input: {
    idempotencyKey: string;
    senderAddress: string;
    status: SettlementLedgerStatus;
    payoutId?: string | null;
    error?: string | null;
    vm: "evm" | "solana";
  }): Promise<void> {
    // UPDATE owner-scoped (CD-9): un caller SOLO puede mutar su propia fila. El filtro por
    // sender_address es el guard REAL (el service key bypassea RLS).
    const patch: Record<string, unknown> = {
      status: input.status,
      updated_at: new Date().toISOString(),
    };
    if (input.payoutId !== undefined) patch.payout_id = input.payoutId;
    if (input.error !== undefined) patch.last_error = input.error;
    const { error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq("idempotency_key", input.idempotencyKey)
      .eq("sender_address", canonicalizeAddress(input.senderAddress, input.vm));
    if (error) throw new Error(`ledger_record_payout_outcome_failed:${error.code ?? "unknown"}`);
  }

  async listStale(input: { olderThanIso: string; limit: number }): Promise<SettlementRecord[]> {
    // AC-4: no-terminales más viejas que el umbral. Global (admin) — sin owner filter (CD-9 exime al
    // reconcile). CD-12: el select trae value_minor::text.
    const { data, error } = await this.client
      .from(TABLE)
      .select(SELECT_COLS)
      .in("status", STALE_STATUSES as unknown as string[])
      .lt("updated_at", input.olderThanIso)
      .limit(input.limit);
    if (error) throw new Error(`ledger_list_stale_failed:${error.code ?? "unknown"}`);
    const rows = (data ?? []) as unknown as RawRow[];
    return rows.map(mapRow);
  }

  async markOutcome(input: {
    id: string;
    status: SettlementLedgerStatus;
    payoutId?: string | null;
    error?: string | null;
    incrementAttempt: boolean;
  }): Promise<void> {
    // Por id (admin, owner-agnóstico). incrementAttempt ⇒ lee-incrementa-escribe (Supabase JS no
    // expresa `attempts = attempts + 1` sin RPC; el reconcile es de baja concurrencia).
    const patch: Record<string, unknown> = {
      status: input.status,
      updated_at: new Date().toISOString(),
    };
    if (input.payoutId !== undefined) patch.payout_id = input.payoutId;
    if (input.error !== undefined) patch.last_error = input.error;
    if (input.incrementAttempt) {
      const { data, error: readErr } = await this.client
        .from(TABLE)
        .select("attempts")
        .eq("id", input.id)
        .single();
      if (readErr) throw new Error(`ledger_mark_outcome_read_failed:${readErr.code ?? "unknown"}`);
      const current = (data as { attempts?: number } | null)?.attempts ?? 0;
      patch.attempts = current + 1;
    }
    const { error } = await this.client.from(TABLE).update(patch).eq("id", input.id);
    if (error) throw new Error(`ledger_mark_outcome_failed:${error.code ?? "unknown"}`);
  }

  async recordWebhookOutcome(input: {
    payoutId: string;
    status: SettlementLedgerStatus;
    error?: string | null;
  }): Promise<void> {
    // WKH-210: UPDATE por payout_id, NO owner-scoped (el guard es el HMAC del endpoint, CD-12). El
    // filtro .in("status", STALE_STATUSES) = no-terminal set (DT-2b): nunca degrada un estado terminal
    // ni reclasifica manual_review. NO lee columnas ⇒ no aplica el ::text de value_minor (es un UPDATE
    // puro, no un select). last_error es un enum estable, NUNCA PII (CD-3).
    const patch: Record<string, unknown> = {
      status: input.status,
      updated_at: new Date().toISOString(),
    };
    if (input.error !== undefined) patch.last_error = input.error;
    const { error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq("payout_id", input.payoutId)
      .in("status", STALE_STATUSES as unknown as string[]); // no-terminal set (DT-2b)
    if (error) throw new Error(`ledger_record_webhook_outcome_failed:${error.code ?? "unknown"}`);
  }
}

/**
 * Factory del ledger. Devuelve null cuando SETTLEMENT_LEDGER_ENABLED !== "true" (flag OFF, CD-2) O el
 * cliente Supabase es null (envs ausentes) ⇒ las rutas skipean el persist ⇒ byte-idéntico
 * (AC-2/AC-10). La env se lee en runtime (CD-14).
 */
export function getSettlementLedger(): SettlementLedger | null {
  if (process.env.SETTLEMENT_LEDGER_ENABLED !== "true") return null;
  const client = getSupabaseServerClient();
  if (!client) return null;
  return new SupabaseSettlementLedger(client);
}
