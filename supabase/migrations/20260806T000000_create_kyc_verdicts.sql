-- 20260806T000000_create_kyc_verdicts.sql — APLICADA (WKH-333/AC-1, CD-11).
-- ✅ APLICADA A BDWV EL 2026-08-07, autorizada por el founder, y VERIFICADA leyendo el post-estado de
--    la base (no asumido): las 6 columnas de negocio NOT NULL, indice unico uq_kyc_verdicts_sender,
--    RLS habilitada y CERO policies ⇒ deny-all para roles no-service. Base: bdwv. PROHIBIDO caldz.
-- ⛔ NO RE-APLICAR: el DDL usa `create table if not exists`, asi que una segunda corrida NO fallaria:
--    se saltearia en silencio y podria dejar un esquema distinto del que el codigo espera.
--
-- QUE ARREGLA. El veredicto de KYC vive hoy en localStorage (`chaski.kyc.v1`,
-- src/infrastructure/kyc-store.ts:7): por dispositivo y por navegador. La misma persona en el
-- telefono y en la computadora gasta DOS cupos del tier gratuito de Didit, y el `verification_id`
-- —que es lo que el backend le presenta a Didit para autorizar un desembolso— viaja en cada request
-- del cliente como un token al portador. Esta tabla es la fila durable que permite que el backend
-- saque ese identificador de SU PROPIA fila, con la direccion PoP-verificada como llave.
--
-- ⚠️ ORDEN DE DESPLIEGUE: **MIGRACION → FLAG ON → CODIGO.** No es una preferencia.
--   · Migracion → flag → codigo (CORRECTO, y es el que se ejecuto el 2026-08-07): la tabla existe;
--     setear KYC_VERDICT_STORE_ENABLED en el proveedor no lo lee NADIE hasta que un deploy la
--     levante, y el deploy la levanta ya encendida. Ventana sin roturas.
--   · Codigo → migracion (ROTO): con el flag ON y la tabla ausente, cada lectura da 42P01
--     (`undefined_table`) ⇒ el endpoint de veredicto responde 502 y `prepare` corta por falta de
--     fila ⇒ NADIE PUEDE PAGAR.
--   · 🔴 ACA DECIA: "con el flag OFF no pasa nada, y por eso el flag es lo ULTIMO que se enciende".
--     ES FALSO, y esta medido (AR/BLQ-ALTO-1; el candado es
--     `app/api/payout/prepare/route.flag-off.test.ts`, que NO mockea la autoridad). Era cierto
--     mientras el flag OFF significaba "comportate como hoy", y dejo de serlo cuando CD-26 prohibio
--     aceptar el `kycVerificationId` del cliente "ni gateado por env, ni transitorio": sin store,
--     `prepare` no tiene de donde sacar el identificador y responde 503 a TODO pagador. O sea que
--     desplegar el codigo con el flag todavia apagado abre una ventana de CORTE TOTAL. El flag va
--     ANTES del deploy, no despues.
--   · Y el rollback NO es apagar el flag: es re-desplegar el codigo anterior. El orden seguro esta
--     en el `_down.sql` de al lado, que si lo tiene bien.
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
