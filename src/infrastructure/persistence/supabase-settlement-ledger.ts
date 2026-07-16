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

  async recordPrincipalIn(input: {
    remittanceId: string;
    quoteId: string;
    idempotencyKey: string;
    txHash: string;
    chainId: number;
    senderAddress: string;
    receiverAddress: string;
    valueMinor: number;
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
        sender_address: input.senderAddress.toLowerCase(),
        receiver_address: input.receiverAddress.toLowerCase(),
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
      .eq("sender_address", input.senderAddress.toLowerCase());
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
