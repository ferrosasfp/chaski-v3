# Report — [WKH-210] Receptor de webhooks de TransFi

**Status**: DONE (2026-07-17) · **NNN**: 021 · **Branch**: `feat/021-wkh-210-transfi-deposit-flow-webhook` · **Metodología**: QUALITY (L)

## Resumen ejecutivo

Cierra el eslabón de **confirmación async** del payout TransFi: un endpoint `/api/webhooks/transfi` que recibe los webhooks de TransFi (`asset_deposited → fund_settled / fund_failed`), verifica la firma HMAC, y actualiza el ledger server-side (WKH-207) al estado terminal. Bounded, sigue patrones ya probados en el repo. Todo sandbox/testnet, flags OFF, byte-idéntico OFF.

**Split**: esta HU es SOLO el webhook receiver. El reorder no-custodial (`to=depositAddress`, el value-delivery real) es WKH-211 (ticket separado, cambio de modelo de seguridad con su propio AR).

## Qué se construyó (3 módulos nuevos + wiring)

- **`app/api/webhooks/transfi/route.ts`** (nuevo) — orden de guards: 501 sin `TRANSFI_WEBHOOK_SECRET` (antes de leer body) → 401 firma HMAC inválida → 501 ledger-null → 400 body no-JSON → 200 payoutId inexistente/status desconocido (ACK sin mutar) → **muta el ledger (idempotente)** → **claim-once best-effort** → 200.
- **`src/infrastructure/webhooks/transfi-hmac.ts`** (nuevo) — `verifyTransfiHmac` (HMAC-SHA256 hex sobre el body CRUDO, timing-safe length-first, patrón `attestation.ts`); `mapTransfiStatus` (asset_deposited→submitted, fund_settled→settled, fund_failed→failed, desconocido→null); `extractPayoutId`/`extractEventId` (parseo defensivo + fallback composite `${payoutId}:${status}` + `TODO(sandbox)` para el nombre exacto del campo/header, a confirmar en el smoke).
- **`src/infrastructure/webhooks/webhook-event-store.ts`** (nuevo) — `claimWebhookEventOnce` (dedup best-effort, `SET NX EX` sobre Upstash, clon de `pop-nonce-store.ts`, namespace `transfi:evt:`).
- **`SettlementLedger.recordWebhookOutcome({payoutId, status, error?})`** (port + Supabase impl + FakeSettlementLedger) — UPDATE por `payout_id` filtrado por `STALE_STATUSES` (`principal_in/submitted/forward_error`): idempotente por construcción (aplicar N veces = 1), nunca degrada terminal ni `manual_review`, 0-match = no-op. `last_error` = enum estable (nunca el motivo crudo de TransFi). NO owner-scoped (el guard es el HMAC).

## Pipeline

| Fase | Resultado |
|------|-----------|
| F0+F1 | HU_APPROVED (11 ACs). Split aceptado (webhook ahora, reorder=WKH-211). WKH-208 confirmado. |
| F2 | SPEC_APPROVED. recordWebhookOutcome, los 3 módulos, ledger-OFF→501, header confirmado. |
| F2.5 | Story File, 3 waves, MNR-1 (comentario) incluido, sin [SDD-GAP]. |
| F3 | 498 tests (460→498), 3/3 mutantes muertos+restaurados, guard-order/wallet/confirm-and-send intactos. |
| AR | APROBADO 0 BLQ — mutante HMAC-crudo muerto en vivo. 1 MENOR (lost-update por claim-before-mutate). |
| CR | APROBADO 0 BLQ — fiel a exemplars, TS strict. 1 MENOR (ref de línea en comentario). |
| Fix-pack | AR-MNR-1 (reorder mutate-first/claim-after → at-least-once idempotente) + CR-MNR-1 (comentario). 501 tests. |
| F4 | APROBADO — 11/11 ACs con evidencia archivo:línea, 501/501, 0 drift. |

## El MENOR de integridad que el AR cazó (fix-packeado)

**AR-MNR-1**: el claim-once quemaba la key ANTES de mutar → si el ledger tiraba (DB down) → 503 para retry, pero el retry del mismo evento → dedup → 200 sin re-mutar → **lost-update** (fund_settled se perdía, la fila quedaba no-terminal hasta reconcile manual). **Fix**: reordenar a **mutar-primero / claim-después best-effort**. Es seguro porque la mutación YA es idempotente (filtro STALE_STATUSES): aplicar la misma transición N veces = 1, terminal no se degrada. Ahora un DB-throw → 503 SIN quemar la key → el retry re-muta idempotente. At-least-once correcto. Test bug-killer + mutación verificados.

## ACs — 11/11 PASS
AC-1 501 sin secreto (antes de leer body) · AC-2 HMAC body crudo timing-safe → 401 · AC-3 idempotencia (reorder at-least-once) · AC-4/5/6 mapeo de estados · AC-7 status desconocido→200 sin mutar · AC-8 payoutId inexistente→200 · AC-9 no-PII (last_error enum) · AC-10 byte-idéntico OFF · AC-11 sandbox/testnet only.

## Residuales / notas
- **2 comentarios/doc stale del fix-pack** (webhook-event-store.ts + story row 503-a describían el 503-fail-closed pre-reorder) → **barridos** en el cierre (comentario/doc, cero lógica).
- **MNR-1 heredado de WKH-209** (comentario Fuji/43114 en submit/route.ts:244-252) → **barrido** en esta HU (solo comentario, terminología Base + ref de línea corregida).

## ⛔ Pendiente para cierre live (founder, gateado): SMOKE WEBHOOK
El webhook con un POST firmado real (sandbox de TransFi) es gateado. Checklist para el founder:
1. Setear `TRANSFI_WEBHOOK_SECRET` (el que regeneraste en el panel) en Vercel/`.env.local`.
2. Configurar la URL del webhook en el panel de TransFi apuntando a `https://chaski-v2.vercel.app/api/webhooks/transfi`.
3. Disparar una orden de prueba en sandbox y confirmar que llegan los eventos (`asset_deposited`→`fund_settled`) y el ledger pasa a `settled`.
4. Confirmar el nombre EXACTO del campo del order-id y del eventId en el payload real (los `TODO(sandbox)`).
