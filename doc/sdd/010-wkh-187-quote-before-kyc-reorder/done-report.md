# Report — WKH-187: Reordenar el flujo — mostrar el quote antes del KYC

**Status**: DONE  
**Fecha**: 2026-07-12  
**Repo**: `chaski-v2` · branch `feat/187-quote-before-kyc-reorder` · commit `e5155e2`  

---

## Resumen ejecutivo

Chaski v2 reordena el flujo de remesas: el usuario ve el quote lockeado (cuánto recibe su familia) **apenas conecta la wallet**, sin ver el KYC aún. El KYC se dispara recién cuando el usuario tapea "Continuar" en la revisión pre-KYC. El gate de compliance (`confirm()` exige `state.kyc` aprobado) y la autoridad server-side (WKH-180) quedan **byte-idénticos** — reordenamos la secuencia de UI y las transiciones FSM, no las invariantes de money-path. **9/9 ACs PASS**, tsc/vitest/build verde, 235/235 tests, cero BLOQUEANTES de AR/CR.

---

## Pipeline ejecutado

| Fase | Estado | Nota |
|------|--------|------|
| **F0** | COMPLETADA | Grounding: `chaski-v2` main post-WKH-186, líneas reales de `remittance.ts` (L85-97) y `flow.tsx` (L20-137/L548-596) verificadas. Context map exhaustivo (11 archivos, 40 línea-anchors). |
| **F1** | HU_APPROVED | Work-item (L1-241) con EARS completo, resolución de 3 `[NEEDS CLARIFICATION]` + 1 `[TBD]`. Decisiones del founder (auto re-cotizar si vence durante KYC) integradas. |
| **F2** | SPEC_APPROVED | SDD (29.5K) cierra 2 gaps del work-item: DT-1b (transición `quoted→confirmed` para evitar dead-end en AC-5) + DT-3 (resume sin re-lock incondicional). Hallazgo crítico (dead-end) cazado y arreglado. |
| **F2.5** | COMPLETADA | Story File (25.8K): anti-hallucination anchors (37 línea-referencias exactas), Scope IN/OUT exhaustivos, 3 Waves (W0=dominio, W1=use-cases, W2/W3=UI+tests). |
| **F3** | IMPLEMENTADA | Commit `e5155e2`: 9 archivos, 1 hunk per archivo, reorden único. Dominio: `TRANSITIONS` reescrito con razones de negocio inline (CD-4). UI: `Step`/`STEP_LABELS`, `onConnect` (lockQuote movido), `onContinue` (nuevo, navegación pura), resume auto-requote. Tests: 235/235 verdes. |
| **AR** | APROBADO | `ar-report.md`: 0 BLQ/0 MENOR. Foco compliance: gate `confirm()` intacto, enumeración de 3 paths peligrosos verificada con T-COMPLIANCE, transiciones nuevas documentadas. |
| **CR** | APROBADO | `cr-report.md`: 0 BLQ/0 MENOR. No-tocar confirmado (diff vacío en `confirm-and-send.ts`). Orden crítico `lockQuote` antes de `startKyc` verificado. Auto-requote reutiliza método público existente. |
| **F4** | APROBADO | `f4-report.md` (EXISTENTE): PASS 235/235 tests, tsc 0 errores, build OK. **9/9 ACs verificadas con evidencia archivo:línea.** |

---

## Acceptance Criteria — resultado final

| AC | Texto (resumen) | Status | Evidencia |
|----|---|---|---|
| **AC-1** | Al conectar wallet, cotizar ANTES de cualquier KYC y mostrar el monto lockeado | ✅ PASS | `flow.tsx:186-189` (`lockQuote` en `onConnect` antes de `startKyc`); test T-AC1 `flow.test.tsx:190-202` |
| **AC-2** | Paso pre-KYC con CTA explícita que dispara el KYC (no auto-inicio) | ✅ PASS | `flow.tsx:200` `onContinue = () => setStep("verify")` (navegación pura); test T-AC2 `flow.test.tsx:205-215` |
| **AC-3** | `confirm()` L219-222 byte-idéntico, rechaza sin KYC en el nuevo orden | ✅ PASS | Diff vacío en cuerpo de `confirm()`; test T-COMPLIANCE `remittance.test.ts:115-137` (3 sub-casos) |
| **AC-4** | KYC-once salta `verify`, va directo a confirmación, preserva quote | ✅ PASS | `flow.tsx:190-198` (branch `rememberedKyc` → `lockQuote` + `startKyc` → `setStep("confirm")`); test T-AC4 `flow.test.tsx:218-233` |
| **AC-5** | Quote vencido entre `attachQuote()` y `confirm()` bloquea confirm y ofrece recuperación sin re-KYC | ✅ PASS | Dominio: `remittance.test.ts:140-148` T-AC5a + `:169-182` T-REQUOTE; UI: `flow.test.tsx:247-267` T-AC5b (`onRelock` re-cotiza); resume auto-requote L126-145 |
| **AC-6** | Resume `passed` navega a confirmación usando el quote del snapshot, sin re-cotizar si vigente | ✅ PASS | `flow.tsx:126-145` (`Remittance.rehydrate(snapshot).isQuoteStillValid(now)`, CD-11); test T-AC6 `flow.test.tsx:270-285` (`lockSpy` no llamado) |
| **AC-7** | Autoridad server-side WKH-180 sin cambio de comportamiento | ✅ PASS | `confirm-and-send.ts` diff vacío; tests `confirm-and-send.test.ts:48` "authority false → payout_failed" + `:72` "server-side override" intactos |
| **AC-8** | Paso de confirmación final muestra badge de identidad junto al quote | ✅ PASS | `flow.tsx:628-640` (`rem.kyc?.identity` en paso `confirm` junto a breakdown L610-627); test T-AC8 `flow.test.tsx:236-244` |
| **AC-9** | Resto de la FSM post-`confirmed` sin cambios de comportamiento | ✅ PASS | `TRANSITIONS` diff: `confirmed`/`principal_in`/`payout_submitted`/`settled`/`payout_failed`/`refunded` idénticos; test T-AC9 `remittance.test.ts:185-195` |

---

## Decisiones técnicas del pipeline (citadas en reportes)

| DT | Título | Verificación |
|----|--------|---|
| **DT-1** | Reorden `TRANSITIONS` con gate en campo `kyc`, no FSM | ✅ AR verificó enumeración de paths |
| **DT-1b** | Transición `quoted→confirmed` para evitar dead-end en re-quote (hallazgo F2) | ✅ T-COMPLIANCE: `quoted + kyc=null` → `confirm()` rechaza antes de intentar transición |
| **DT-2** | Re-quote post-KYC reutiliza `LockQuote` sin cambios; KYC aprobado sobrevive el patch shallow-merge | ✅ Test T-AC5b |
| **DT-3** | Resume sin re-lock incondicional; chequea vigencia vía `isQuoteStillValid()` + auto-requote si vencido | ✅ `flow.tsx:126-145`, test T-AC6 |
| **DT-12** | Orden crítico en `onConnect`: `lockQuote` ANTES de `startKyc` | ✅ CR verificó código |

---

## Constraint Directives cumplidas (CD-1..CD-13)

| CD | Descripción | Status |
|----|---|---|
| **CD-1** | Sin archivos fuera de `chaski-v2/` | ✅ Scope IN limitado a 9 archivos, todos en `chaski-v2` |
| **CD-2/CD-13** | `confirm()` y cuerpo de `remittance.ts` byte-idénticos | ✅ AR + CR verificaron; diff único es `TRANSITIONS` L83-99 |
| **CD-3** | `confirm-and-send.ts` sin tocar | ✅ Diff vacío, F4 re-ejecutó tests; suite 12/12 verde con seeding reordenado |
| **CD-4** | Razones de negocio inline para cada transición nueva | ✅ `remittance.ts:83-99` anotado con comentarios de WKH-187 |
| **CD-5** | Demo + KYC-once funcionando | ✅ F4 regresión: T1 (demo verde), T-AC4 (KYC-once verde) |
| **CD-6** | Tests rojos arreglados en la misma HU (CD-6 de work-item) | ✅ 235/235 verdes; no hay tests validando orden viejo sin soporte de código |
| **CD-11** | Resume usa `Remittance.rehydrate(snapshot).isQuoteStillValid(now)`, no recalcula en UI | ✅ `flow.tsx:128` y test T-AC6 |
| **CD-12** | `onConnect` hace `lockQuote` SIEMPRE antes de `startKyc`, incluido KYC-once | ✅ Código: L186-189 (antes de `startKyc`), L190-198 (KYC-once path igual) |

---

## Hallazgos y resoluciones

### Durante F2 (hallazgo crítico)

**Problema**: El `TRANSITIONS` propuesto en el work-item (`quoted: ["quoted","kyc_pending"]`, `kyc_passed: ["quoted","confirmed"]`) **no permitía transición `quoted→confirmed`**, creando un dead-end en AC-5 (re-cotizar sin dead-end).

**Resolución (DT-1b)**: Agregar `"confirmed"` como destino desde `quoted`. Es seguro porque el gate real está en el campo `kyc` (verificado por T-COMPLIANCE: sin KYC, `confirm()` lanza `confirm_requires_kyc_passed` ANTES de intentar la transición).

---

## Auto-Blindaje consolidado (lecciones para próximas HUs)

### [2026-07-12] Wave 1 — Tests rotos por cambio de invariante FSM

**Lección**: Al reordenar `TRANSITIONS`, grepear TODOS los tests que ejercitan la transición eliminada, no confiar solo en line-anchors del Story File. Correr suite completa como red de seguridad.

**Aplicación**: Si reordenás una FSM → buscar `grep "startKyc"` + estado viejo, revisar seeding en TODOS los fixtures (no solo los explícitamente listados).

---

### [2026-07-12] Wave 1 — Error observado cambia con precondición de estado

**Lección**: El orden relativo entre guard de FSM y side-effect I/O determina QUÉ error ves: `to()` corre antes que `repo.save()`, así que cambiar el estado previo requerido cambia cuál gate se activa primero.

**Aplicación**: En tests de fallo de I/O que dependen del orden, verificar que la precondición de estado sigue habilitando el path que querés probar. Actualizar asserts de estado esperado post-fallo.

---

### [2026-07-12] Wave 3 — Tiempo real vs. clock inyectado en RTL

**Lección**: Si el efecto lee `new Date()` en lugar del `FixedClock` del container, los snapshots de test deben usar fechas relativas al reloj REAL, no a T0.

**Aplicación**: Para tests de expiry en RTL → usar `expiresAt: "2099-01-01"` (vigente en tiempo real) y `QUOTE_EXPIRES` (vencido en tiempo real).

---

## Archivos modificados (9 en total)

### Dominio (W0)
- `src/domain/remittance.ts` — `TRANSITIONS` L83-99 reescrito (3 transiciones nuevas: `created→quoted`, `quoted→kyc_pending`, `kyc_passed→quoted`, `quoted→confirmed`)

### Tests de dominio (W0)
- `src/domain/remittance.test.ts` — seeding `ready()` reordenado, `canTransition` actualizado, T-COMPLIANCE agregado

### Use-cases + Tests (W1)
- `src/application/use-cases/start-kyc.ts` — comentario L59-61 ("created" → "quoted")
- `src/application/use-cases/confirm-and-send.test.ts` — `seedQuoted()` reordenado
- `src/application/use-cases/track-remittance.test.ts` — setup reordenado
- `src/application/use-cases.test.ts` — V1 orphan: assert `status=="quoted"`, seeding actualizado
- `src/infrastructure/persistence.test.ts` — seed quote antes de `startKyc`

### Presentación + Tests RTL (W2/W3)
- `src/presentation/flow.tsx` — 8 cambios: `Step`/`STEP_LABELS`/`STEP_INDEX`, `onConnect` (lockQuote movido), `onContinue` (nuevo), `onVerify` (lockQuote quitado), resume auto-requote, banner demo, paso `review` (pre-KYC), paso `confirm` (post-KYC)
- `src/presentation/flow.test.tsx` — `goToReview()` renombrado/ajustado, T-COMPLIANCE/T-AC1..T-AC9 agregados (235/235 verdes)

---

## Decisiones diferidas a backlog

Ninguna. El scope de WKH-187 es cerrado y auto-contenido. No bloquea WKH-168 (desembolso real) — el scaffolding de value-delivery (WKH-186) sigue intacto aguas abajo de `confirmed`.

---

## Lecciones para próximas HUs

1. **FSM reorder → grep exhaustivo**: No confiar solo en Story File anchors. Correr suite completa antes de dar por cerrada la wave.

2. **Precondición de estado afecta orden de errores**: Tests que esperan error de I/O deben re-verificar que la precondición de estado (nueva) sigue habilitando el path.

3. **Tiempo real en RTL**: Lógica que lee `new Date()` en el navegador necesita snapshots con fechas "en futuro real", no relativas a T0.

4. **Gate en campo vs. FSM**: Separar la lógica de verificación (campo de estado) de la topología de estados (FSM) permite reordenar transiciones sin debilitar invariantes.

5. **Shallow-merge en `to()`**: Patrones que cuentan con que el patch de `to()` no limpia campos existentes (como `quote`, `kyc`) son más resilientes a reordenes de estado.

---

## Créditos de construcción

- **F0/F1**: Analyst/Architect identificaron el dead-end de AC-5 en F2 y ajustaron DT-1b.
- **F3**: Dev implementó todas las Waves respetando el order crítico `lockQuote` antes de `startKyc`.
- **AR/CR**: Verification completa de enumeración de paths + no-tocar + arquitectura.
- **F4**: QA executó 235/235 tests, tsc, build; verificó 9/9 ACs con evidencia archivo:línea.

---

## Listo para merge

- ✅ Todos los gates pasados: tsc/vitest/build verde.
- ✅ Compliance intacta: `confirm()` byte-idéntico, enumeración de paths cubierta.
- ✅ Auto-blindaje documentado: 3 lecciones para reordenes de FSM.
- ✅ Branch `feat/187-quote-before-kyc-reorder` listo para merge a `main`.
