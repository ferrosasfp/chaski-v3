-- 20260721T000000_add_vm_network_id_to_remittance_settlements.sql — PENDING-DEPLOY (HU-SOL-7/AC-8/CD-6).
-- NO aplicar: la aplica el founder (acción gated, mismo patrón que 20260716T000000_*).
-- Aditiva (Opción A, DT-3): NO cambia el TIPO de chain_id (sigue integer → mapRow() y los guards
-- money-path que comparan chainId:number quedan byte-idénticos). Agrega identidad de red Solana.

alter table public.remittance_settlements
  add column if not exists vm         text not null default 'evm',
  add column if not exists network_id text;   -- cluster/CAIP-2 Solana; NULL en EVM

-- Solana no tiene chainId numérico ⇒ chain_id pasa a NULLABLE. Es una RELAJACIÓN (drop not null),
-- NO un ALTER COLUMN ... TYPE destructivo (CD-6): las filas EVM existentes conservan su valor.
alter table public.remittance_settlements
  alter column chain_id drop not null;

-- Coherencia VM ↔ identidad de red (fail-closed a nivel DB):
--   evm    ⇒ chain_id NOT NULL  Y  network_id NULL
--   solana ⇒ network_id NOT NULL Y chain_id NULL
alter table public.remittance_settlements
  add constraint remittance_settlements_vm_chk       check (vm in ('evm','solana')),
  add constraint remittance_settlements_vm_netid_chk check (
    (vm = 'evm'    and chain_id is not null and network_id is null) or
    (vm = 'solana' and network_id is not null and chain_id is null)
  );
