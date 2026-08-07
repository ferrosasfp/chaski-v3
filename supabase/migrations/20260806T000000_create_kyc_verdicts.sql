-- 20260806T000000_create_kyc_verdicts.sql — PENDING-DEPLOY (WKH-333/AC-1, CD-11).
-- NO aplicar: la aplica el founder (accion gated, classifier). Base: bdwv. PROHIBIDO caldz (mainnet).
--
-- QUE ARREGLA. El veredicto de KYC vive hoy en localStorage (`chaski.kyc.v1`,
-- src/infrastructure/kyc-store.ts:7): por dispositivo y por navegador. La misma persona en el
-- telefono y en la computadora gasta DOS cupos del tier gratuito de Didit, y el `verification_id`
-- —que es lo que el backend le presenta a Didit para autorizar un desembolso— viaja en cada request
-- del cliente como un token al portador. Esta tabla es la fila durable que permite que el backend
-- saque ese identificador de SU PROPIA fila, con la direccion PoP-verificada como llave.
--
-- ⚠️ ORDEN DE DESPLIEGUE: **ESTA MIGRACION PRIMERO, EL CODIGO DESPUES.** No es una preferencia.
--   · Migracion → codigo (CORRECTO): la tabla existe y el flag KYC_VERDICT_STORE_ENABLED sigue OFF
--     ⇒ nadie la lee ni la escribe. Ventana sin roturas, de duracion indefinida.
--   · Codigo → migracion (ROTO): con el flag ON y la tabla ausente, cada lectura da 42P01
--     (`undefined_table`) ⇒ el endpoint de veredicto responde 502 y `prepare` corta por falta de
--     fila ⇒ NADIE PUEDE PAGAR. Con el flag OFF no pasa nada, y por eso el flag es lo ULTIMO que se
--     enciende (CD-30: migracion aplicada + backfill de ConnectWallet desplegado, en ese orden).
--   · El insert de una columna inexistente daria PGRST204 y se perderia la fila ENTERA, igual que la
--     leccion ya escrita en 20260804T000000_add_payout_provenance_...sql:12-22.
create table if not exists public.kyc_verdicts (
  id              uuid primary key default gen_random_uuid(),
  sender_address  text not null,          -- base58 CASE-SENSITIVE (src/infrastructure/address.ts:13).
                                          -- ⚠️ NO lowercasear. La columna homonima de
                                          -- remittance_settlements dice "lowercased" en su comentario:
                                          -- eso es herencia EVM y NO aplica aca (CD-10).
  verification_id text not null,          -- CREDENCIAL del money-path: es lo que el backend le
                                          -- presenta a Didit al pagar. NUNCA sale en una respuesta
                                          -- HTTP (AC-6) ni en un log (CD-13). Sensibilidad =
                                          -- remittance_settlements.
  approved        boolean not null,
  risk_level      text not null,
  provenance      text not null,          -- CRUDA. Sin CHECK a proposito: la allow-list vive en el
                                          -- LECTOR (src/presentation/flow-vm.ts, isKycDemo). Un CHECK
                                          -- aca haria fallar la escritura ante una proveniencia nueva
                                          -- del proveedor, y el fail-safe correcto es persistirla y
                                          -- tratarla como simulada al leer (AC-11).
  verified_at     timestamptz not null,   -- EL HECHO: cuando se verifico. PROHIBIDA toda columna de
                                          -- vencimiento calculada (AC-2/CD-7): el TTL se aplica AL
                                          -- LEER, asi cambiar KYC_VERDICT_TTL_DAYS no exige un
                                          -- backfill ni deja dos verdades sobre la misma fila.
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Una fila por direccion. Sirve ademas la unica query que existe (lectura por sender_address), asi
-- que NO se agrega un indice extra: seria un segundo indice sobre la misma columna.
create unique index if not exists uq_kyc_verdicts_sender on public.kyc_verdicts (sender_address);

-- RLS defensa en profundidad. La app usa SUPABASE_SERVICE_ROLE_KEY (BYPASSRLS) ⇒ el guard REAL es el
-- filtro app-layer `.eq('sender_address', <direccion PoP-verificada>)` (CD-5). RLS protege ante un
-- cliente con anon-key.
alter table public.kyc_verdicts enable row level security;
-- Sin policy permisiva ⇒ deny-all para roles no-service (fail-closed). El service key opera igual.
