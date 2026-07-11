# AR — Adversarial Review — WKH-183

**Veredicto**: APROBADO — 0 BLOQUEANTES, 0 MENORES

**Fecha**: 2026-07-11  
**Branch**: `fix/183-higiene-pending-store-money-fx-copy-env` @ `3c37ed5`

## Resumen ejecutivo

Batch de 6 fixes de higiene (V1-V6). **V1 es el único bug real** (huérfano de KYC pendiente si `localStorage.setItem` falla); V2-V6 son robustez/copy/docs. Sin hallazgos que bloqueen o degraden calidad: el fix de reorder + try/catch (V1) cierra el brick sin introducir regresiones; el manejo defensivo de legacy en `persistence.ts`/`kyc-store.ts` (WKH-181) ya cubría mitigaciones; cero cambio de comportamiento observable en demo (CD-2 respetado).

## Hallazgos

**BLOQUEANTES**: 0  
**MENORES**: 0

## Revisión de CDs

- **CD-1** (scope acotado a chaski-v2): ✅ confirmado, 0 archivos fuera de `chaski-v2/`.
- **CD-2** (sin cambio observable): ✅ FX doble redondeo eliminado, monto resultante idéntico en caso común; FallbackKycGateway sigue aprobando siempre.
- **CD-3** (sin tocar dominio): ✅ `RemittanceStatus`/`TRANSITIONS` intactos; V1 fix es reorder + try/catch en aplicación.
- **CD-4** (cap técnico, no regla de negocio): ✅ `Money.of()` cap es `Number.MAX_SAFE_INTEGER`.
- **CD-5** (ordering de `humanError`): ✅ `kyc_pending_unavailable` chequeado **antes** de `code.includes("kyc")` genérico.
- **CD-6** (sin drift de firmas): ✅ `StartKyc` ctor, `Money.of()`, puertos sin cambio.
- **CD-9** (diff acotado en archivos compartidos): ✅ `gateways.ts:53` (doble redondeo) + comentario V3 (63-68); `.env.example` AC-10/AC-11 acotados.

## Verificación del bug de V1

El diagnóstico del huérfano (Work Item §4.1) es exacto: rama redirect de `start-kyc.ts` hacía `repo.save(r)` ANTES de `pending.save()`, dejando la remesa persistida en `kyc_pending` sin `KycPending` correlacionable si el segundo `await` lanzaba. Fix recomendado respeta CD-3 (ningún cambio de dominio): reordenar (PRIMERO `pending.save`, DESPUÉS `repo.save`), envolver con try/catch en `kyc-pending-store.ts`. Test de QA (use-cases.test.ts:176-188) verifica que `repo.get(id).status === "created"` tras el fallo de `pending.save()` — confirma que la remesa **NO queda huérfana en `kyc_pending`**.

## Confirmaciones sin bloques

- V2 (copy de wallet) — no introduce ataque a través de copy confuso (los códigos `no_wallet`, `no_account`, `wallet_not_connected` existen hoy; V2 solo agrega copy explícito, no cambia errores lanzados).
- V3 (documentación `FallbackKycGateway`) — cero cambio de runtime; comportamiento (siempre aprueba) está contenido por gate server-side WKH-180.
- V4 (FX redondeo único) — elimina divergencia latente; mismo monto observable en casos reales (remesas ≤ ~$1M).
- V5 (cap `Money.of()`) — montos de remesa reales holgadamente por debajo de `MAX_SAFE_INTEGER / 1e6 ≈ 9e9`.
- V6 (docs `.env.example`) — cero cambio de runtime.

**AR FINAL: APROBADO. Sin bloques, sin deuda técnica introducida. Listo para CR.**
