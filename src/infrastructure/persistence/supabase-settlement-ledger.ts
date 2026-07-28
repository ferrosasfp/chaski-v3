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
  SenderRemittanceRef,
  SettlementLedger,
  SettlementLedgerStatus,
  SettlementRecord,
} from "../../application/ports";
import { getSupabaseServerClient } from "./supabase-server";
import { canonicalizeAddress } from "../address";
import { resolveSolanaNetworkId } from "../chain";

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

/** Columnas de IDENTIDAD DE RED de un INSERT, coherentes por construcción con el CHECK
 *  `remittance_settlements_vm_netid_chk` (migración 20260721, YA aplicada):
 *      vm='evm'    ⇒ chain_id NOT NULL  Y  network_id NULL
 *      vm='solana' ⇒ network_id NOT NULL Y  chain_id NULL
 *  Las DOS mitades (el `vm` y su columna de red) salen de ACÁ y de ningún otro lado: es imposible que
 *  un escritor ponga `vm='solana'` y se olvide de anular `chain_id` (o al revés) — esa desincronización
 *  es exactamente el bug que arregla este cambio. Una violación del CHECK no rompe el money-path
 *  (CD-17: la ruta captura y sigue) ⇒ la fila simplemente NO se escribe, así que el acoplamiento tiene
 *  que ser estructural, no una convención entre call-sites.
 *  `network_id` sale de resolveSolanaNetworkId() (CAIP-2, la MISMA fuente server-side que ata el PoP
 *  ed25519, el envelope x402 `solana:<cluster>` y el binding P4 de /solana/escrow/remittance-ids) —
 *  NUNCA del body, NUNCA un literal nuevo. `chainId` es un chainId EVM: en la rama Solana NO se
 *  escribe (no existe chainId numérico en Solana; escribirlo era el mislabel: filas base58 con el
 *  chainId de Avalanche). */
function vmNetworkColumns(
  vm: "evm" | "solana",
  chainId: number,
): { vm: "evm" | "solana"; chain_id: number | null; network_id: string | null } {
  switch (vm) {
    case "evm":
      return { vm: "evm", chain_id: chainId, network_id: null };
    case "solana":
      return { vm: "solana", chain_id: null, network_id: resolveSolanaNetworkId() };
    default:
      throw new Error("ledger_unsupported_vm"); // fail-loud (vm fuera del union, defensa runtime)
  }
}

// Shape crudo de una fila leída (value_minor llega como string por el ::text).
interface RawRow {
  id: string;
  remittance_id: string;
  quote_id: string;
  idempotency_key: string;
  tx_hash: string;
  // NULLABLE desde la migración 20260721: las filas Solana NO tienen chainId numérico (su identidad de
  // red vive en network_id). Tiparlo `number` sería mentir en un read del money-path.
  chain_id: number | null;
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
        // vm + (chain_id | network_id) en un solo lugar: acopladas por el CHECK de la DB (ver
        // vmNetworkColumns). Antes esto era `chain_id: input.chainId` a secas ⇒ TODA fila de una remesa
        // Solana quedaba vm='evm' con un chainId de Avalanche y una address base58.
        ...vmNetworkColumns(input.vm, input.chainId),
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
        ...vmNetworkColumns(input.vm, input.chainId), // MISMA fuente que recordOrderPrepared (CHECK 20260721)
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
    // NO toca vm/chain_id/network_id (ni las necesita): el patch no incluye esas columnas ⇒ el CHECK
    // vm_netid se re-evalúa sobre la fila resultante, que las conserva ⇒ pasa si la fila ya era
    // coherente. Y NO filtra por `vm` a propósito: las filas pre-fix de una remesa Solana dicen
    // vm='evm', así que agregar .eq("vm", ...) dejaría de mutarlas (una remesa vieja no llegaría nunca
    // a estado terminal). El input.vm se usa SOLO para canonicalizar la address del guard.
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

  async listRemittanceIdsBySender(input: {
    senderAddress: string;
    vm: "evm" | "solana";
    limit: number;
  }): Promise<SenderRemittanceRef[]> {
    // HU-SOL-20/AC-2: recuperación del remittanceId cuando el cliente lo perdió. OWNER-SCOPED: el
    // `.eq("sender_address", ...)` es el ÚNICO guard real (el service key bypassea RLS) ⇒ borrarlo es
    // un IDOR que expone las remesas de terceros.
    // NO filtra por `vm`, A PROPÓSITO y sigue siendo correcto DESPUÉS del fix de escritura: las filas
    // escritas ANTES de este fix (o sea TODAS las remesas Solana ya existentes) dicen vm='evm', y son
    // precisamente las que este fallback tiene que poder recuperar ⇒ un .eq("vm","solana") las perdería
    // y devolvería CERO. La address ya discrimina la VM sin ayuda de la columna (base58 case-sensitive
    // vs 0x+40hex lowercased — ver canonicalizeAddress). El test T-R0-1 (§4.2) se pone ROJO si alguien
    // agrega ese filtro.
    // NO filtra por status: las filas que interesan nacen 'prepared' (recordOrderPrepared), que NO está
    // en STALE_STATUSES; el status viaja en la respuesta y decide el consumidor.
    // NUNCA selecciona value_minor (no se lee ⇒ el ::text de CD-12 no aplica) ni PII (CD-7).
    const { data, error } = await this.client
      .from(TABLE)
      .select("remittance_id, status, created_at")
      .eq("sender_address", canonicalizeAddress(input.senderAddress, input.vm)) // ← EL GUARD
      .order("created_at", { ascending: false })
      .limit(input.limit);
    if (error) throw new Error(`ledger_list_by_sender_failed:${error.code ?? "unknown"}`);
    const rows = (data ?? []) as unknown as Array<{
      remittance_id: string;
      status: SettlementLedgerStatus;
      created_at: string;
    }>;
    return rows.map((r) => ({
      remittanceId: r.remittance_id,
      status: r.status,
      createdAt: r.created_at,
    }));
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
    // UPDATE de status/attempts/last_error: NO toca vm/chain_id/network_id ⇒ nada que acoplar al CHECK
    // vm_netid (la fila conserva su identidad de red).
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
    // NO toca vm/chain_id/network_id (UPDATE parcial) ⇒ nada que acoplar al CHECK vm_netid. Tampoco
    // discrimina por VM: correlaciona por payout_id, que es VM-agnóstico.
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
