-- 20260820T000000_kyc_session_tokens_owner_binding_immutable.sql — NO APLICADA (hotfix 2026-08-20 · F-3).
-- ⛔ NO la aplica el agente que escribio este archivo. La aplica el founder (accion gated).
--    Base: BDWV. ⛔ PROHIBIDO caldz: caldz es MAINNET.
--
-- QUE HACE. Vuelve INMUTABLE el `owner_address` de `kyc_session_tokens` una vez que dejo de ser NULL:
--   NULL -> una direccion   ATAR, permitido (es el caso que el hotfix F-3 arregla).
--   A -> A                  no-op, permitido.
--   A -> B                  ⛔ ERROR.
--   A -> NULL               ⛔ ERROR (desatar es reatar en dos pasos).
--
-- POR QUE EXISTE, Y POR QUE ES UN TRIGGER Y NO UNA POLICY NI UN CHECK.
--   · Esa fila es una CREDENCIAL DEL MONEY-PATH: con su `decision_token` se lee el veredicto de KYC
--     de una persona, y ese veredicto gatea el desembolso. Reescribir su `owner_address` es un
--     secuestro de identidad, no un bug de escritura.
--   · La app usa SUPABASE_SERVICE_ROLE_KEY (BYPASSRLS): una POLICY de RLS **no nos frena**, asi que
--     no puede ser el candado. Un trigger si corre para el service role.
--   · Un `CHECK` NO PUEDE VER EL `OLD`: expresa un invariante de la fila, no de la TRANSICION. Por
--     eso no alcanza y no se usa.
--
-- 🔴 QUE PROTEGE DE VERDAD, Y QUE NO — LEER ANTES DE APOYARSE EN ESTO.
--   SI  protege contra CUALQUIER escritor: un `psql` a mano, un script de mantenimiento, otro repo,
--       una version futura de la app que se olvide del guard. Ese es el punto: hoy el invariante lo
--       impone UNICAMENTE `src/infrastructure/persistence/supabase-kyc-session-tokens.ts` (`put`), y
--       ese archivo protege un solo call site.
--   NO  protege NADA mientras esta migracion no se aplique. Y no hay ningun test del repo que se
--       ponga rojo si no se aplica: el doble de `src/test-support/kyc-session-tokens-db.ts` no
--       ejecuta triggers. ⛔ Ningun verde de la suite se puede leer como "el trigger anda".
--   NO  cubre el DELETE + INSERT (borrar la fila y volver a crearla con otro dueño). Se declara y no
--       se cierra acá: hoy NADA en el codigo borra filas de esta tabla, y un trigger de DELETE
--       tendria que decidir que hacer con el borrado legitimo, que no existe todavia.
--   NO  cubre `alter table ... disable trigger`, ni un superusuario que lo saltee.
--
-- ORDEN DE DESPLIEGUE: esta migracion se puede aplicar ANTES o DESPUES del codigo, y es a proposito.
--   · Aplicada ANTES: no rompe nada. El `put` de hoy (el `insert` pelado) nunca hace un UPDATE, asi
--     que el trigger no se dispara jamas.
--   · Aplicada DESPUES: tampoco. El `put` de F-3 solo hace las transiciones PERMITIDAS — su `WHERE`
--     las hace imposibles de violar—, asi que el trigger tampoco se dispara.
--   ⇒ Si algun dia este trigger salta desde la app, NO es "una restriccion molesta": es que el guard
--     app-layer se rompio. Es un canario, no un obstaculo.
--
-- EL ERROR QUE DEVUELVE: SQLSTATE 23514 (`check_violation`), elegido para que el log de
-- `app/api/kyc/session/route.ts` lo emita como `dbCode: '23514'` con su filtro de forma ya existente
-- (5 caracteres [A-Z0-9]). Hoy no hay ningun otro CHECK en esta tabla, asi que un 23514 desde este
-- camino significa exactamente una cosa. ⛔ El mensaje NO incluye ninguna direccion ni el token: un
-- mensaje de driver puede terminar en un log.
create or replace function public.kyc_session_tokens_owner_binding_is_immutable()
returns trigger
language plpgsql
as $$
begin
  if old.owner_address is not null and new.owner_address is distinct from old.owner_address then
    raise exception 'kyc_session_tokens: owner_address is immutable once bound'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_kyc_session_tokens_owner_binding on public.kyc_session_tokens;
create trigger trg_kyc_session_tokens_owner_binding
  before update on public.kyc_session_tokens
  for each row
  execute function public.kyc_session_tokens_owner_binding_is_immutable();
