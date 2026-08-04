-- 20260804T000000_add_payout_provenance_to_remittance_settlements.sql — PENDING-DEPLOY.
-- NO aplicar: la aplica el founder (accion gated, classifier).
--
-- QUÉ ARREGLA. La fila de una orden SIMULADA quedaba indistinguible de una REAL: status 'prepared',
-- receiver_address base58 válida, payout_id, network_id CAIP-2 — misma forma, mismos tipos. El único
-- discriminador era el prefijo `fb-` del payout_id (src/infrastructure/fallback/gateways.ts:115), que
-- es una convención INCIDENTAL del proveedor simulado, no un dato declarado: el día que ese proveedor
-- cambie el formato del id, la evidencia deja de distinguir y nadie se entera. Esta columna guarda la
-- proveniencia que el agente YA declara en el prepare (app/api/payout/prepare/route.ts) y que hasta
-- hoy viajaba al browser sin persistirse.
--
-- ⚠️ ORDEN DE DESPLIEGUE: **ESTA MIGRACIÓN PRIMERO, EL CÓDIGO DESPUÉS.** No es una preferencia.
--   · Migración → código (CORRECTO): la columna existe y nadie la escribe todavía ⇒ toda fila nueva
--     nace NULL, que es EXACTAMENTE el estado de hoy. Ventana sin roturas, de duración indefinida.
--   · Código → migración (ROTO, y roto en silencio para quien usa la app): el upsert de
--     recordOrderPrepared nombra una columna inexistente ⇒ PostgREST PGRST204 ⇒ la función TIRA. El
--     prepare NO devuelve error (el write es best-effort, CD-17: route.ts lo captura y responde 200
--     igual), así que la persona no ve nada. Lo que se pierde es la fila ENTERA de evidencia — no sólo
--     la proveniencia — de CADA orden preparada durante esa ventana. Se ve en el log como
--     `[ledger][ALERT] recordOrderPrepared_failed` (PGRST* cae en el default "high" de
--     classifyLedgerWriteFailure). Y como la columna también está en el SELECT del ledger, las lecturas
--     admin (listStale / listPreparedOrphans) tiran ⇒ /api/admin/reconcile-orphans responde 503.
--
-- ⚠️ FILAS VIEJAS: quedan en NULL y NO se pueden rellenar. La proveniencia declarada por el agente no
-- se guardó en ningún lado, y el único rastro que sobrevive es justamente el prefijo `fb-` que esta
-- columna existe para dejar de usar: backfillear desde ahí sería consagrar la convención incidental
-- como dato. Por eso NULL se lee "no consta", NUNCA "real".
--
-- CÓMO SE LEE (fail-safe, misma dirección que REAL_PAYOUT_PROVENANCES en src/presentation/flow-vm.ts):
-- la pregunta "¿esta fila movió plata?" se contesta que SÍ únicamente cuando payout_provenance está en
-- la allow-list de proveniencias reales ('transfi' hoy). NULL, '' y cualquier otro valor
-- ('devnet-stub', 'local-fallback', 'n/a', …) ⇒ NO probado. Ejemplo:
--     select count(*) from public.remittance_settlements where payout_provenance is distinct from 'transfi';
alter table public.remittance_settlements
  add column if not exists payout_provenance text;

-- SIN check de allow-list, a propósito. La proveniencia la elige el agente, y un proveedor real nuevo
-- traería un valor que este archivo no puede conocer. Con un CHECK, ese INSERT violaría la restricción
-- (23514) y, por ser un write best-effort (CD-17), se perdería la fila COMPLETA en vez de guardar una
-- etiqueta inesperada. La allow-list vive del lado del LECTOR, donde equivocarse sólo sobre-advierte.

comment on column public.remittance_settlements.payout_provenance is
  'Proveniencia del desembolso DECLARADA por el agente de payout en el prepare, tal cual (transfi | devnet-stub | local-fallback | ...). NULL = no consta (fila anterior a esta migración, o el agente no la declaró): NO se lee como real. Sólo la allow-list de proveniencias reales (hoy: transfi) autoriza a afirmar que la fila movió plata.';
