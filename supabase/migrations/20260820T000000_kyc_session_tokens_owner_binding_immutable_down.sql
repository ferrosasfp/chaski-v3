-- ROLLBACK de 20260820T000000_kyc_session_tokens_owner_binding_immutable.sql.
--
-- ⚠️ QUE SIGNIFICA CORRER ESTO: la base vuelve a aceptar que el `owner_address` de una sesion ya
-- atada se reescriba a otra direccion. El unico guard que queda es el app-layer (`put` en
-- `src/infrastructure/persistence/supabase-kyc-session-tokens.ts`), que protege UN call site.
-- No corta ningun flujo: la app no depende del trigger para funcionar.
drop trigger if exists trg_kyc_session_tokens_owner_binding on public.kyc_session_tokens;
drop function if exists public.kyc_session_tokens_owner_binding_is_immutable();
