-- 20260716T000000_create_remittance_settlements.sql — PENDING-DEPLOY (WKH-207/AC-8/CD-1).
-- NO aplicar: la aplica el founder (acción gated, classifier).
create table if not exists public.remittance_settlements (
  id                uuid primary key default gen_random_uuid(),
  remittance_id     text not null,                       -- aggregate id del cliente (s.id)
  quote_id          text not null,
  idempotency_key   text not null,                       -- `${remittance_id}:${quote_id}` (AC-5, retry)
  tx_hash           text not null,                       -- settle del principal VERIFICADO on-chain
  chain_id          integer not null,
  sender_address    text not null,                       -- payer on-chain (from), lowercased — OWNER (AC-9)
  receiver_address  text not null,                       -- receiver de plataforma (to, de ENV)
  value_minor       numeric(78,0) not null,              -- uint256-safe; leer SIEMPRE con ::text (CD-12, WKH-196)
  status            text not null default 'principal_in',-- ver enum abajo
  attempts          integer not null default 0,          -- contador de reintentos de reconciliación (AC-6)
  payout_id         text,                                -- del result del agente cuando se conoce
  last_error        text,                                -- enum estable de fallo, NUNCA PII (CD-7)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint remittance_settlements_status_chk check (status in
    ('principal_in','submitted','settled','failed','forward_error','manual_review'))
);

-- Idempotencia de inserción: un settle = una fila (settle podría reintentarse a nivel red).
create unique index if not exists uq_remit_settle_txhash on public.remittance_settlements (tx_hash);
create unique index if not exists uq_remit_settle_idem   on public.remittance_settlements (idempotency_key);
-- Query de reconciliación (AC-4): no-terminales más viejas que el umbral. Índice parcial.
create index if not exists idx_remit_settle_stale on public.remittance_settlements (updated_at)
  where status in ('principal_in','submitted','forward_error');
-- Ownership lookups / RLS (AC-9).
create index if not exists idx_remit_settle_owner on public.remittance_settlements (sender_address);

-- RLS defensa en profundidad (AC-9/CD-9). La app usa SUPABASE_SERVICE_KEY (BYPASSRLS) ⇒ el guard
-- REAL es el filtro app-layer `.eq('sender_address', <caller>)`. RLS protege ante un client anon-key.
alter table public.remittance_settlements enable row level security;
-- Sin policy permisiva ⇒ deny-all para roles no-service (fail-closed). El service key opera igual.
