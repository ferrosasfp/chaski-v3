-- 20260819T000000_add_kyc_session_tokens.sql — NO APLICADA (WKH-233/W2.5, CD-19..CD-22).
-- ⛔ NO la aplica el agente que escribio este archivo. La aplica el founder (accion gated).
--    Base: BDWV. ⛔ PROHIBIDO caldz: caldz es MAINNET.
-- ⛔ NO RE-APLICAR a ciegas: el DDL usa `create table if not exists`, asi que una segunda corrida NO
--    fallaria: se saltearia en silencio y podria dejar un esquema distinto del que el codigo espera.
--
-- QUE ARREGLA. Desde WKH-233 Chaski deja de hablarle al proveedor de KYC y le habla al agente
-- `remit-kyc-validator`. Ese agente devuelve, al crear la sesion, un `decisionToken` que es la UNICA
-- credencial que despues autoriza a leer la decision de esa sesion (`GET /decision`, cabecera
-- `x-kyc-decision-token`). Ese token hay que guardarlo en algun lado: el navegador NO puede tenerlo
-- (CD-20 — seria una credencial del money-path en manos del cliente, que es exactamente el agujero
-- que WKH-333 cerro con el `kycVerificationId`), y sin guardarlo NADIE puede leer el veredicto de esa
-- sesion, ni la pantalla ni el pago. Esta tabla es ese lugar.
--
-- 🔴 LA CREDENCIAL QUEDA AT-REST EN TEXTO PLANO, Y SE DICE POR QUE. Misma clase de sensibilidad y
-- mismas protecciones que `kyc_verdicts.verification_id`: RLS deny-all + service key + filtro
-- app-layer. NO se cifra porque este repo no tiene KMS ni gestion de claves de datos, y agregar uno
-- seria diseño nuevo dentro de una HU de migracion. Es un residual DECLARADO, no ignorado.
--
-- 🔴 EL TOKEN NO VENCE. NUNCA. Y NO ES UN OLVIDO (CD-21).
--   Es una decision medida y aprobada del OTRO repo (`wasiai-remittance-agents`,
--   `src/auth/decision-token.ts`, bloque "POR QUE EL TOKEN NO VENCE"). Es PEOR que si venciera, y por
--   eso va escrito aca y no descubierto por el proximo:
--     1. Esta tabla NO TIENE columna de vencimiento y NO LA VA A TENER. Un TTL del lado de Chaski
--        seria un corte de desembolso a alguien YA verificado (CD-5).
--     2. Los UNICOS dos caminos que invalidan un token viven en el otro repo: rotar
--        `KYC_DECISION_TOKEN_SECRET`, o subir la version `k1` -> `k2`. Los dos son un CORTE, no un
--        rollback: invalidan TODOS los tokens en vuelo, incluidos los de personas ya verificadas que
--        todavia no cobraron, y NO HAY DONDE RE-EMITIRLOS.
--     3. Camino de fallo en el momento del pago, especificado: si el token fue invalidado el agente
--        contesta 401 ⇒ `resolvePayoutAuthority` NO autoriza y devuelve `kyc_reauth_failed`/502 ⇒
--        `prepare` responde `payout_authority_unavailable`/502 (el `default` fail-closed).
--        La persona NO pierde plata; pierde el pago hasta que se re-verifique.
--        ⛔ PROHIBIDO agregar un camino de respaldo, un reintento con otra credencial, o un `?? true`.
--     4. FOLLOW-UP NOMBRADO, y NO es de esta HU: `decision-token.ts` R6 dice textual que "si
--        `kyc_verdicts` gana una columna de token [...] HAY QUE RECONSIDERARLO". Esta migracion
--        dispara exactamente esa condicion ⇒ companion en `wasiai-remittance-agents`.
--
-- ⚠️ ORDEN DE DESPLIEGUE: **MIGRACION -> ENVS -> CODIGO.** No es una preferencia, y el inverso
--    rompe produccion:
--   1. Aplicar este .sql a BDWV. ⛔ NUNCA a caldz (mainnet). Nadie lo lee todavia: el codigo no esta
--      desplegado.
--   2. Sembrar `KYC_AGENT_BASE_URL` (y `KYC_AGENT_INVOKE_SECRET` si el guard del agente ya esta
--      encendido) EN EL PROVEEDOR, con el codigo todavia sin desplegar. Nadie las lee hasta que un
--      deploy las levante, y el deploy las levanta YA seteadas. Ventana sin roturas.
--   3. Desplegar el codigo.
--   · Codigo -> envs (ROTO): abre una ventana en la que `/api/kyc/session` responde 501 y todo el
--     mundo cae a la SIMULACION. No corta pagos (nadie con veredicto simulado paga), pero SIRVE UN
--     KYC FALSO A GENTE REAL, que es peor.
--   · Codigo -> migracion (ROTO): con las envs puestas y la tabla ausente, la escritura del token da
--     42P01 (`undefined_table`) ⇒ `/api/kyc/session` responde 503 y NADIE PUEDE VERIFICARSE.
--   · 🔴 El rollback NO es rotar `KYC_DECISION_TOKEN_SECRET` (eso es un CORTE, ver arriba). El
--     rollback es QUITAR `KYC_AGENT_BASE_URL` —que solo afecta a las sesiones NUEVAS, porque las
--     lecturas se enrutan por la fila del token y por el `carril` del pendiente, nunca por la env— o
--     re-desplegar el codigo anterior. El `_down` de al lado es lo ULTIMO de todo.
create table if not exists public.kyc_session_tokens (
  id             uuid primary key default gen_random_uuid(),
  session_id     text not null,          -- el `sessionId` que devolvio POST /session del agente. Es
                                         -- tambien, por contrato del agente, el `verificationId` que
                                         -- devuelve GET /decision ("canonico = el PEDIDO"), asi que
                                         -- `kyc_verdicts.verification_id` sigue siendo la llave del
                                         -- money-path SIN migrarla.
  decision_token text not null,          -- 🔴 CREDENCIAL BEARER AT-REST. Misma clase de sensibilidad
                                         -- que `kyc_verdicts.verification_id`. NUNCA sale en una
                                         -- respuesta HTTP ni en un log (CD-20). NO VENCE (CD-21).
  owner_address  text,                   -- NULLABLE A PROPOSITO: la direccion PoP-PROBADA, o NULL si
                                         -- la sesion nacio SIN ATAR (P-4/AC-4: sin prueba de
                                         -- posesion la persona se puede verificar igual).
                                         -- base58 CASE-SENSITIVE. ⛔ NO lowercasear: lowercasear
                                         -- abre una colision entre dos direcciones distintas.
                                         -- 🔴 QUE EL NULL NO DEBILITA EL GUARD, SINO QUE LO REFUERZA:
                                         -- un `.eq('owner_address', X)` NUNCA matchea un NULL ⇒ una
                                         -- sesion sin atar JAMAS puede autorizar un desembolso, por
                                         -- construccion de la query, sin que nadie tenga que
                                         -- acordarse de chequearlo. ⛔ NO lo "arregles" poniendolo
                                         -- NOT NULL: eso dejaria sin verificarse a quien no firma.
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Una fila por sesion. Sirve ademas la UNICA query que existe (lectura por session_id, con o sin el
-- filtro por owner_address encima), asi que NO se agrega un indice sobre `owner_address`: seria un
-- segundo indice sobre la misma consulta. Es el mismo criterio que ya escribio
-- `20260806T000000_create_kyc_verdicts.sql` para no agregar uno redundante.
create unique index if not exists uq_kyc_session_tokens_session on public.kyc_session_tokens (session_id);

-- RLS defensa en profundidad. La app usa SUPABASE_SERVICE_ROLE_KEY (BYPASSRLS) ⇒ el guard REAL es el
-- filtro app-layer `.eq('owner_address', <direccion PoP-verificada>)` de
-- `src/infrastructure/persistence/supabase-kyc-session-tokens.ts` (CD-19). RLS protege ante un
-- cliente con anon-key, no reemplaza al filtro.
alter table public.kyc_session_tokens enable row level security;
-- Sin policy permisiva ⇒ deny-all para roles no-service (fail-closed). El service key opera igual.
