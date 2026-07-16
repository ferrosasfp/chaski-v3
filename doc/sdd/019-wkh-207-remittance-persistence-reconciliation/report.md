# Report — [WKH-207] Persistencia server-side + reconciliación de remesas huérfanas

**Status**: DONE (2026-07-16) · **NNN**: 019 · **Branch**: `feat/019-wkh-207-remittance-persistence-reconciliation` · **Metodología**: QUALITY (XL)

## Resumen ejecutivo

WKH-207 cierra el último residual del gate de Fase A (nombrado en código por WKH-168/AC-9): hasta ahora el estado de la remesa vivía SOLO en `localStorage` (cliente). Si el browser se cerraba entre `principal_in` (USDC ya verificado on-chain adentro) y un estado terminal, la remesa quedaba **huérfana, con el dinero realmente adentro y sin forma de reconciliar**. Esta HU construye, sin tocar el guard-order del money-path:

1. **Persistencia server-side** — un ledger en **Postgres propio de chaski-v2** (org Supabase FREE nueva, decisión del founder; standalone, NO la DB de wasiai-a2a). Escrito como side-effect **ADITIVO** en `/api/settle/principal` (post-V9, `recordPrincipalIn` con valores verificados on-chain) y `/api/a2a/payout/submit` (post-forward, `recordPayoutOutcome` owner-scoped).
2. **Reconciliación** — endpoint admin `/api/admin/reconcile-orphans` (auth secreto compartido timing-safe) que detecta remesas varadas (`listStale`) y las marca **`manual_review` con evidencia**. **NO ejecuta retry-forward** (deferido — ver residual R11).

Todo **flag-gated y byte-idéntico OFF**: sin `SETTLEMENT_LEDGER_ENABLED=true` y/o sin la migración aplicada, cada flujo actual responde exactamente igual. La migración se entrega **PENDING-DEPLOY** (la aplica el founder).

## Decisión clave: auto-retry-forward DEFERIDO (money-safe)

El auto-retry del forward quedó **fuera de scope** por doble bloqueo, ambos verificados:
- **PII**: reconstruir el body del forward al agente requiere `beneficiary` (PII), que CD-7 prohíbe persistir y la tabla no guarda.
- **Dedupe**: se verificó (cross-repo, `wasiai-remittance-agents/src/providers/payout.ts`) que el agente NO deduplica por sí mismo (delega en TransFi, hoy no READY).

Resultado: el reconcile **NUNCA llama al forward** → no-doble-pago trivial por construcción (test = spy fetch con 0 llamadas; un mutante que agregue re-forward muere). Toda remesa varada → `manual_review` con evidencia (txHash, monto, address, quoteId, status, intentos) para resolución humana. Esto hace la HU MÁS conservadora, no menos: nunca reintenta = nunca doble-paga.

## Pipeline ejecutado

| Fase | Status | Notas |
|------|--------|-------|
| F0+F1 | ✓ HU_APPROVED | 10 ACs EARS; DT-1 (dónde persiste) escalado al founder → Opción C (Supabase free propio) |
| F2 | ✓ SPEC_APPROVED | Esquema + migración + port + reconcile; verificó cross-repo que el agente no deduplica → auto-retry OFF |
| F2.5 | ✓ | Story File; cazó [SDD-GAP-1] (retry no reconstruible sin PII) → parcheado a manual_review-only |
| F3 | ✓ | 5 waves, ~12 archivos, dep nueva `@supabase/supabase-js`; qa 413→442; 3 mutantes muertos+restaurados |
| AR | ✗ RECHAZADO → ✓ re-AR APROBADO | Cazó **BLQ-MED-1** (fail-open money-path); fix-pack lo cerró; re-AR verificó con el test que mata el mutante |
| CR | ✓ APROBADO | 0 BLQ, 2 MENORes (fix-packeados) |
| Fix-pack | ✓ | BLQ-MED-1 + MNR-1 + MNR-2; qa 442→451 |
| F4 | ✓ APROBADO | 10/10 ACs PASS con evidencia archivo:línea; qa 451/451; migración PENDING-DEPLOY; guard-order intacto |

## El BLOQUEANTE cazado (AR justificó su existencia)

**BLQ-MED-1**: `getSettlementLedger()` → `createClient(url, key)` estaba FUERA del try/catch best-effort. `createClient` (`@supabase/supabase-js`) **lanza sincrónicamente** ante un `SUPABASE_URL` malformado (ej. sin `https://`, typo de deploy típico). Con el flag ON + URL mala → `/api/settle/principal` y `/submit` tiraban **500 crudo tras pasar los guards** → money-path caído (violaba CD-17/AC-10). Es el patrón recurrente "construcción/I-O fuera del try/catch" (WKH-168/206). **Fix**: `createClient` envuelto en try/catch dentro de `getSupabaseServerClient()` → `null` ante throw (degrada a byte-idéntico OFF). El `null` NO se cachea → una config luego arreglada se re-evalúa. Test que lo mata: URL malformada + flag ON → ruta responde 200, nunca 500 (el mutante `catch→throw` mata 3 tests).

## Acceptance Criteria — resultado final (10/10 PASS)

| AC | Requisito | Evidencia |
|----|-----------|-----------|
| AC-1 | recordPrincipalIn post-V9 con valores verificados on-chain, antes de la atestación | `settle/principal/route.ts:211-238`; test `:403-424` (asevera `verified.*`, no body) |
| AC-2/AC-10 | Byte-idéntico OFF (flag ausente O URL inválida → null → skip) | `supabase-settlement-ledger.ts:177-182` + `supabase-server.ts:17-32`; tests flag-OFF + URL-malformada→200 |
| AC-3 | Forward ok/failed/blocked/error → status mapeado | `submit/route.ts:314-325`; tests settled/submitted/forward_error/failed/blocked |
| AC-4 | listStale detecta no-terminales tras umbral | `supabase-settlement-ledger.ts:128-140`; test índice parcial |
| AC-5 | idempotencyKey persistido (contrato futuro); reconcile no ejecuta retry | `route.ts:226`; reconcile re-verifica consistencia, nunca dispara acción |
| AC-6 | manual_review con evidencia; NUNCA reintenta forward | `reconcile-orphans/route.ts:73-96`; test "reconcile NUNCA llama fetch" (mutante muerto) |
| AC-7 | Reconcile auth fail-closed (501/401) timing-safe | `reconcile-orphans/route.ts:24-55`; tests 501/401/200 |
| AC-8 | Migración PENDING-DEPLOY (archivo, no aplicada) | `supabase/migrations/20260716T000000_create_remittance_settlements.sql:1-2` |
| AC-9 | Ownership app-layer `.eq('sender_address')` + RLS deny-all | `supabase-settlement-ledger.ts:120-124` + migración RLS enable sin policy |

## Constraint Directives — cumplimiento

CD-1 (migración solo archivo) · CD-2/AC-2/AC-10 (byte-idéntico OFF, incl. URL inválida→null tras fix) · CD-3/CD-4 (guard-order submit/settle intacto, solo aditivo post-guards) · CD-7 (sin PII — solo evidencia money-path) · CD-9 (ownership app-layer) · CD-11 (Supabase client server-only) · CD-12 (`value_minor::text`, WKH-196) · CD-13 (valores verificados on-chain) · CD-15 (auto-retry OFF/deferido) · CD-17 (persist best-effort en try/catch propio, nunca rompe money-path).

## Migración (PENDING-DEPLOY — la aplica el founder)

`supabase/migrations/20260716T000000_create_remittance_settlements.sql`:
- Tabla `remittance_settlements`: `value_minor numeric(78,0)` (leído con `::text`), FSM de 6 estados, índices únicos (tx_hash, idempotency_key), índice parcial sobre no-terminales (query de reconciliación), índice de ownership (sender_address).
- RLS `enable` sin policy = deny-all (defensa en profundidad; el app usa SERVICE_KEY que bypassa RLS → el guard real es `.eq('sender_address', ...)` app-layer).
- Idempotente (`if not exists`), sin DDL destructivo.

## Métricas de tests

| Hito | Total suite |
|------|-------------|
| Baseline (post-WKH-205) | 413 |
| Post-F3 | 442 |
| Post-fix-pack (+BLQ +2 MNR) | **451/451 verde** (tsc strict 0 errores) |

Nuevos: ledger 8, settle +4, submit +8, reconcile 13. Mutation self-check: 4 mutantes muertos y restaurados (`grep MUTANT`=0).

## Residuales / deuda documentada

- **R11 (nuevo)**: auto-retry del forward DEFERIDO — bloqueado por reconstrucción de beneficiary/PII (CD-7) + dedupe del agente no garantizado (CD-15). Requiere una HU futura que decida la política de manejo de beneficiary para retry (o esperar a que TransFi confirme dedupe en sandbox).
- **R (heredado WKH-168/DT-8)**: clawback on-chain real del principal — sigue imposible sin más infra.
- **Trigger de la reconciliación**: el endpoint se entrega invocable (curl con secreto); automatizar (Vercel Cron / GitHub Actions) es follow-up de ops.
- **Drift menor de contrato**: el response del reconcile ahora incluye `failed` (aditivo, del fix-pack MNR-2); el SDD §9 lo documenta como `{scanned, manualReview}`. Aditivo, endpoint admin sin consumidor externo — benigno.

## Checklist ops antes de encender (va a Task #35)

1. Crear la org Supabase FREE de chaski-v2 + proyecto; aplicar la migración `20260716T000000_...sql`.
2. Setear `SUPABASE_URL` (con `https://`), `SUPABASE_SERVICE_ROLE_KEY`, `SETTLEMENT_LEDGER_ENABLED=true`, `RECONCILE_ADMIN_SECRET`, `RECONCILE_STALE_THRESHOLD_SECONDS`.
3. Free tier: los proyectos free se auto-pausan tras ~7d de inactividad → subir a Pro al encender el money-path real.
4. Programar el trigger del reconcile (cron) o correrlo manualmente con el secreto.
