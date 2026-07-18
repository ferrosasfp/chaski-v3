# Auto-Blindaje — WKH-211 (Dev / F3)

Registro de errores cometidos y corregidos durante la implementación wave-por-wave.
Formato: fecha · wave · error · causa raíz · fix · dónde más aplicar.

---

### [2026-07-18] Wave 1 — `Beneficiary` importado desde `ports` (no exportado)
- **Error**: `http-payout-prepare-gateway.ts` y `fallback/gateways.ts` importaban `Beneficiary` de `../../application/ports` → TS2459 "declares 'Beneficiary' locally, but it is not exported".
- **Causa raíz**: `ports.ts` importa `Beneficiary` de `domain/remittance` pero NO lo re-exporta; asumí que un tipo usado en una firma de `ports` estaba disponible desde `ports`.
- **Fix**: importar `Beneficiary` directo de `../../domain/remittance` (su fuente real).
- **Aplicar en**: cualquier adapter/gateway nuevo que use tipos de dominio — importarlos del módulo de dominio, no de `ports` (ports NO los re-exporta).

### [2026-07-18] Wave 2 — tests de wallet real-mode rotos por el 3er arg obligatorio
- **Error**: 8 tests EIP-3009 real-mode de `wallet.test.ts` fallaron: llamaban `authorizePrincipal(quote, id)` sin `deposit` → nuevo `throw deposit_address_missing` (antes firmaban con `resolveReceiverAddress()`).
- **Causa raíz**: en modo real el `to` dejó de ser un env estático y pasó a exigir el `deposit` atestado (fail-loud). Los tests existentes no lo pasaban.
- **Fix**: pasar `{ address: DEPOSIT }` como 3er arg en todos los tests real-mode y actualizar los asserts `to === RECEIVER` → `to === DEPOSIT`. El guard de `deposit` va ANTES del de `expiresAt` → los tests WKH-198 también necesitaron el 3er arg para alcanzar su rama.
- **Aplicar en**: al volver obligatorio un binding (deposit/attestation), revisar el ORDEN de los guards fail-loud — un guard nuevo insertado antes de otro cambia qué error dispara un test viejo.

### [2026-07-18] Wave 4 — tests de flujo real rotos por DT-7 (submit no se llama en real)
- **Error**: 3 tests de `confirm-and-send.test.ts` fallaron: (a) AC-10 "atestación forwardeada al submit", (b) C8 "payout falla en real → marca manual", (c) "pop.prove() TIRA en real → refund manual".
- **Causa raíz**: el reorder mueve la creación de la orden a `prepare` y NO llama `payouts.submit` en modo real (DT-7). El PoP ahora se prueba en `prepare` (ANTES de la firma), no en el submit. Los asserts de esos 3 tests describían el flujo pre-HU.
- **Fix**: reescribir los 3 tests al flujo nuevo: (a) el `depositAttestation` viaja al SETTLE + submit NO llamado; (b) un payout gateway que "fallaría" es irrelevante (submit ni se llama) → payout_submitted; (c) prove() throw en real cae ANTES de la firma → reason `prepare_unavailable`, principal nunca entra (AC-7), NO la marca manual AC-6.
- **Aplicar en**: cuando un reorder mueve un side-effect de una fase a otra, buscar TODO test que asserte el punto de invocación viejo (spies sobre submit/prove) — no basta con que compile.

### [2026-07-18] Wave 0/5 — [STORY-GAP] persistencia: `tx_hash NOT NULL` + único `idempotency_key` colisionan con la fila 'prepared'
- **Error**: la tabla `remittance_settlements` tiene `tx_hash text NOT NULL` + índice único `uq_remit_settle_idem` sobre `idempotency_key`. Una fila `'prepared'` (creada en prepare, sin settle aún) no tiene tx_hash, y un `recordPrincipalIn` posterior (upsert `onConflict tx_hash` con el TX real) INSERTA una 2ª fila con el mismo `idempotency_key` → viola el único → ese write best-effort falla.
- **Causa raíz**: el modelo no-custodial crea la orden (prepare) ANTES del settle; el esquema WKH-207 fue diseñado para `principal_in` (que siempre tiene tx_hash). La migración de esta HU (por Story) SOLO agrega `'prepared'` al CHECK — no relaja `tx_hash` ni re-keyea el upsert de `recordPrincipalIn`.
- **Fix (mínimo viable, fund-safe)**: `recordOrderPrepared` usa un placeholder determinístico `prepared:${idempotencyKey}` para el NOT NULL y `value_minor='0'`; upsert `onConflict idempotency_key ignoreDuplicates`. El write es best-effort (la route lo captura, CD-17) → NUNCA rompe el money-path. CD-6 se mantiene: una fila 'prepared' JAMÁS pasa a principal_in por esta vía.
- **[STORY-GAP] marcado en el código** (`supabase-settlement-ledger.ts:recordOrderPrepared`): la reconciliación real (relajar `tx_hash` a NULL-able + re-keyear el upsert de `recordPrincipalIn` por `idempotency_key`) queda como **follow-up**. NO afecta la seguridad de fondos; sólo la visibilidad de reconcile de una remesa preparada+settleada (puede quedar visible como 'prepared'). Escalado al orquestador en el reporte F3.

### [2026-07-18] Wave 6 — Mutation self-checks (OBLIGATORIO) del vector AC-3 + AC-7
- **B6 mutado** (`if(false)` = acepta cualquier `to`) → murió el vector (a) `settle_receiver_mismatch` de `route.binding.test.ts` (PASS 7 / FAIL 1). Restaurado.
- **B3 mutado** (no compara `att.remittanceId`) → murió el vector (b). **B5 mutado** (no compara chainId) → murió el vector (d). (PASS 6 / FAIL 2 con ambos). Restaurado byte-a-byte desde backup en scratchpad.
- **AC-7 fail-loud mutado** en `confirm-and-send.ts` (el `!prep.ok` cae a firmar en vez de cortar) → murió el test "AC-7: prepare !ok ⇒ SIN authorizePrincipal" de `confirm-and-send.reorder.test.ts` (PASS 4 / FAIL 1). Restaurado desde backup.
- **Resultado**: cada guard del binding (B3/B5/B6) y el fail-before-sign (AC-7) están PROTEGIDOS por ≥1 test que muere al mutarlos. `grep -rn MUTANT src app` = 0 tras restaurar. Backups en scratchpad (NO `git checkout`).
