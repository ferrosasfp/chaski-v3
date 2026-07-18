-- 20260718T000000_add_prepared_status.sql — PENDING-DEPLOY (WKH-211/AC-8/CD-1/DT-5).
-- NO aplicar: la aplica el founder (acción gated, classifier). Aditivo, no destructivo.
--
-- Agrega el estado 'prepared' al CHECK de remittance_settlements.status: la orden TransFi ya se creó
-- (depositAddress atestado) pero el principal aún NO entró on-chain. Da visibilidad de órdenes
-- huérfanas (prepare ok + settle falla). El depositAddress se guarda en receiver_address (SIN columna
-- nueva — semánticamente ES el receiver no-custodial). La cancelación real de la orden TransFi es
-- follow-up (necesita la API de cancelación, cross-repo — DT-5).
alter table public.remittance_settlements drop constraint remittance_settlements_status_chk;
alter table public.remittance_settlements add constraint remittance_settlements_status_chk
  check (status in ('prepared','principal_in','submitted','settled','failed','forward_error','manual_review'));

-- NOTA: 'prepared' NO se agrega al índice parcial idx_remit_settle_stale (stale statuses de
-- reconciliación). Una fila 'prepared' es visibilidad de reconcile manual, NO re-procesamiento
-- automático: NUNCA se re-clasifica a principal_in por reconcile (CD-6). La cancelación real de la
-- orden TransFi huérfana es un follow-up separado (DT-5).
