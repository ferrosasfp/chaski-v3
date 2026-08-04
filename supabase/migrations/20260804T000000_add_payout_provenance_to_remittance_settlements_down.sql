-- 20260804T000000_add_payout_provenance_to_remittance_settlements_down.sql — ROLLBACK.
-- NO aplicar: la aplica el founder (accion gated, classifier).
--
-- ⚠️ ORDEN DE ROLLBACK, INVERSO AL DEL DESPLIEGUE: **EL CÓDIGO PRIMERO, ESTA MIGRACIÓN DESPUÉS.**
-- Con el código nuevo todavía vivo, dropear la columna deja al ledger nombrando una columna que ya no
-- existe: los writes de recordOrderPrepared tiran PGRST204 y, por ser best-effort (CD-17), se pierde
-- la fila ENTERA de evidencia de cada orden preparada sin que el prepare falle a la vista de nadie; y
-- las lecturas admin (listStale / listPreparedOrphans) tiran ⇒ /api/admin/reconcile-orphans 503.
-- Es el mismo agujero que describe el _up, con el mismo silencio.
--
-- ⚠️ ESTE ROLLBACK ES DESTRUCTIVO Y NO TIENE VUELTA. Borra la proveniencia de TODAS las filas escritas
-- desde que se aplicó el _up. Re-aplicar el _up después NO la recupera: el dato sólo existía acá.
-- Si lo único que se busca es dejar de escribirla, alcanza con revertir el código y DEJAR la columna
-- (una columna nullable que nadie escribe no molesta a nada, y conserva lo ya registrado).
-- Antes de correr esto, si la evidencia importa:
--     create table public.remittance_settlements_provenance_bak as
--       select id, payout_provenance from public.remittance_settlements where payout_provenance is not null;
alter table public.remittance_settlements
  drop column if exists payout_provenance;
