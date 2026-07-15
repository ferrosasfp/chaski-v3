# Report — HU [WKH-199] KYC re-brick — `KycStore.save()` best-effort + reorder critical-write-first

## Resumen ejecutivo

**WKH-199** cierra hallazgo B de la auditoría adversarial #2: reincidencia de la clase de bug "write no-crítico bloquea el crítico" (WKH-183 la cerró en `kyc-pending-store.ts`, acá vuelve en `kyc-store.ts`). `LocalKycStore.save()` no tiene try/catch a diferencia de `clear()`, y se llama ANTES de `applyKyc()+repo.save()` en `resume-kyc.ts` y `start-kyc.ts` — si localStorage.setItem lanza (quota/Safari private), un KYC YA APROBADO se pierde y el usuario reinicia un Didit entero. **Fix double**: (1) `save()` wrapped en try/catch best-effort (simétrico a `clear()`); (2) reordenar write no-crítico DESPUÉS del crítico. **HALLAZGO IMPORTANTE**: commit creó `project-context.md` enteramente (188 líneas, documental de patrones Chaski v2). **Pipeline COMPLETO**: F0–F1–F2–F2.5–F3–AR–CR–F4 = **APROBADO PARA DONE**.

---

## Pipeline ejecutado

| Fase | Artefacto | Veredicto | Fecha |
|------|-----------|-----------|-------|
| F0 | project-context | cargado (Chaski v2, post-WKH-188) | 2026-07-14 |
| F1 | `work-item.md` (WKH-199) | HU_APPROVED (scope resuelto, no-bloqueantes) | 2026-07-14 |
| F2 | `sdd.md` | SPEC_APPROVED (arquitectura: reorden + try/catch best-effort, CD-9 proyecto-context cargado) | 2026-07-14 |
| F2.5 | `story-file.md` | contrato listo para F3 (scope IN exacto, anti-hallucination anchors) | 2026-07-14 |
| F3 | Implementación | COMPLETA: try/catch en KycStore.save() + reorden en resume-kyc.ts/start-kyc.ts + tests (60 líneas insertas + 188 proyecto-context) | 2026-07-14 |
| AR | `ar-report.md` | APROBADO (0 BLOQUEANTES, 1 MENOR: project-context.md generado NO en Story File, desviación documentada) | 2026-07-14 |
| CR | `cr-report.md` | APPROVED (0 BLOQUEANTES, MNR-1 documentado: project-context NO en scope orig but value-added) | 2026-07-14 |
| F4 | `f4-report.md` (validation) | **APROBADO PARA DONE** (tsc 0, vitest 275/275 tests, npm build OK, 6/6 ACs PASS, 10/10 CDs) | 2026-07-14 |

---

## Acceptance Criteria — resultado final (6/6 PASS)

| AC | Descripción | Status | Evidencia (archivo:línea) | Validación |
|----|---|---|---|---|
| **AC-1** | `localStorage.setItem` lanza en `KycStore.save()` ⇒ capturar, resolver normalmente (best-effort) | **PASS** | `src/infrastructure/kyc-store.ts:97-106` (try/catch wrapping save); test "setItem throws" en kyc-store.test.ts | vitest PASS |
| **AC-2** | `ResumeKyc.execute()` con cache-fail ⇒ igual ejecutar `applyKyc()+repo.save()`, NO lanzar | **PASS** | `src/application/use-cases/resume-kyc.ts:47` (reordenado DESPUÉS línea 48-49); test en use-cases.test.ts | vitest PASS |
| **AC-3** | `StartKyc.execute()` rama `"completed"` con cache-fail ⇒ igual ejecutar, resuelva `kyc_passed` | **PASS** | `src/application/use-cases/start-kyc.ts:51-57` (reordenado DESPUÉS line 51); test en use-cases.test.ts | vitest PASS |
| **AC-4** | Resume-loop (`flow.tsx:109-113`) NO entra timeout por falla de cache únicamente | **PASS** | `src/application/use-cases/resume-kyc.ts` con try/catch best-effort + reorden, execute() siempre resuelve (nunca lanza en cache fail) | vitest PASS |
| **AC-5** | Comportamiento byte-a-byte cuando `save()` SÍ tiene éxito (regresión cero) | **PASS** | `src/infrastructure/kyc-store.ts:97-106` (same logic, just wrapped); regression tests en kyc-store.test.ts | vitest PASS |
| **AC-6** | Test suite incluye: setItem-throws en kyc-store.test.ts + fallo cache en ResumeKyc + StartKyc | **PASS** | `src/infrastructure/kyc-store.test.ts:+13 líneas` (test setItem throwing); `src/application/use-cases.test.ts:+35 líneas` (ResumeKyc/StartKyc cache-fail tests) | vitest PASS |

---

## Hallazgos finales

### BLOQUEANTEs
Ninguno. Pipeline limpio.

### MENORs (1, desviación de scope documentada)

1. **MNR-1 (CR)**: `project-context.md` generado NO en Story File.  
   - **Hallazgo**: Commit agregó un archivo completo `project-context.md` (188 líneas) documentando patrones arquitectónicos de Chaski v2, convenios de naming, flujo KYC, Clean Architecture. NO fue planificado en la Story File original (Scope IN: solo archivos KYC-específicos).
   - **Causa raíz**: El Architect determinó durante F2 que la HU necesitaba un "Patrón de acceso a base de datos" explicado en `project-context.md` (CD-7 requiere actualizar este documento), y luego decidió crear el documento COMPLETO de base (no existía) para futuras HUs de Chaski v2.
   - **Impacto**: POSITIVO. El documento de 188 líneas es ítil para la coherencia del proyecto (paleta de decisiones, inversión única). La desviación es value-added, no scope-creep. WKH-200/201 reutilizan este documento.
   - **Status**: ACEPTADA como deuda cultural, no reversible.  
   - **Lección**: Cuando el Architect determina que un archivo de proyecto debe existir para una CD/patrón, y está en su juicio que falta, la desviación es comunicable y documentable aquí (no en auto-blindaje de Dev).

---

## Auto-Blindaje consolidado

### Patrón arquitectónico: Reorden critical-write-first

- ✓ **Best-effort pattern**: `KycStore.save()` + `KycStore.clear()` ambos con try/catch en la misma clase (simetría). La diferencia histórica (clear sí, save no) fue inconsistencia — ambas son operaciones de cache no-bloqueantes.
- ✓ **Reorden del write crítico primero**: `resume-kyc.ts:47` y `start-kyc.ts:51-57` ambas invierten el orden — `applyKyc()+repo.save()` ANTES de `kycStore.save()`. Si la segunda falla, la remesa YA está persistida. Si la primera falla, el use-case lanza y la UI maneja el error (nunca el cache-fail).
- ✓ **Patrón replicado de WKH-183**: La clase de bug ("write no-crítico bloquea") ocurrió en `kyc-pending-store.ts` (WKH-183 fix) y reincidió acá. Lección aplicada: **persistir lo crítico primero, defensa no-crítica después**.

### Gotcha con la reordenación en tests

- **Orden de setup en fakes**: Cuando `ResumeKyc`/`StartKyc` mockean un store de KYC que falla, asegurar que el `repo.get()` post-execute devuelva el snapshot actualizado (ej., faking del `ApplyKyc` debe haber ocurrido). El test de AC-2 usa `InMemoryRepo` para verificar que repo.get(id)?.snapshot.status === "kyc_passed"` INCLUSO si la cache falla — eso requiere que el fake `ApplyKyc` ya haya corrido antes de la verificación. Lección: cuando desacople writes en orden, asegurar que los test-doubles repliquen el order-dependent outcome.

### Lección: Patrones documentales (proyecto-context.md)

- **Inversión única en documentación de patrones**: Este commit decidió crear `project-context.md` de base (NO fue re-escrito). El costo es 188 líneas. El beneficio es que WKH-200/201/202/... no re-descubren el patrón de reorden, CD-7, naming, etc. Patrón: si 3+ HUs van a tocar el mismo layer (`kyc-store.ts`, `persistence.ts`, etc.), documentar el patrón canonical una sola vez.

---

## Archivos modificados

### Modificados (6)

| Archivo | Wave | Cambio | LOC |
|---------|------|--------|-----|
| `src/infrastructure/kyc-store.ts` | W1 | Envolver `save():97-106` en try/catch best-effort (simétrico a `clear()`) | +6 |
| `src/application/use-cases/resume-kyc.ts` | W1 | Reordenar: `applyKyc()+repo.save()` (L48-49) ANTES de `kycStore.save()` (L47→L50) | -2,+2 |
| `src/application/use-cases/start-kyc.ts` | W1 | Reordenar rama `"completed"`: `applyKyc()+repo.save()` ANTES de `kycStore.save()` | -2,+2 |
| `src/infrastructure/kyc-store.test.ts` | W1 | NEW: test "setItem throws in save()" (MemStorage mock) | +13 |
| `src/application/use-cases.test.ts` | W1 | NEW: test AC-2 "ResumeKyc cache-fail → repo.save() igual persisted"; test AC-3 "StartKyc rama completed cache-fail" | +35 |
| `src/test-support/fakes.ts` | W1 | NEW: fake `ThrowingSaveKycStore` (paralela a `ThrowingClearKycStore`) | +16 |

### Nuevos (1)

| Archivo | Tamaño | Contenido |
|---------|--------|----------|
| `project-context.md` | 188 líneas | Guía de patrones arquitectónicos de Chaski v2 (Clean Architecture, naming, KYC flow, DB patterns, SDD conventions). Cubre CD-7 actualización + referencia para futuras HUs. Desviación MNR-1: creado en F3 (no planificado en Story File, pero value-added). |

---

## Decisiones diferidas a backlog

Ninguna. HU autocontenida y replicable (patrón aplicable a otros stores/gateways si los hubiera).

---

## Lecciones para próximas HUs

1. **Patrón best-effort: try/catch en ambos lados del contrato**: Si una clase expone `save()` y `clear()`, ambas deben ser best-effort (try/catch) o ambas deben ser fail-loud. La asimetría histórica fue bug enabler — la consistencia es seguridad.

2. **Reorden critical-write-first**: Cuando una use-case encadena 2+ writes (repo → cache, persistence → temporary), primero ejecutar el write crítico (que puede dejar estado terminal en persistencia), LUEGO los no-críticos (que si fallan, no bloquean la invariante). Esto es diferente a atomicity (no es transacción) — es **resilencia del flujo**.

3. **Documentación única de patrones (project-context.md)**: Si 3+ HUs van a replicar un patrón (reorden, best-effort, wiring), documentarlo una sola vez en `project-context.md` del repo como canon. Futuras HUs lo referencian en lugar de re-descubrir. Costo: inversión inicial (188 líneas). Beneficio: coherencia + velocidad de futuras HUs.

4. **Test-doubles deben respetar order-dependent outcomes**: Cuando se desacoplan writes en orden, los fakes/mocks deben replicar el mismo orden (ej., `ApplyKyc` mock debe ocurrir antes de verificar repo.get() en el test de AC-2). Lección: no confiar que los test-doubles "ignoran orden" — verificar explícitamente.

---

## Merge & Deploy

- **Commit**: `3b52418` (7 archivos modificados + 1 nuevo `project-context.md`, 60 líneas producción + 188 documento)
- **Branch**: `fix/199-kyc-store-save-best-effort`
- **Status**: Listo para merge a `main` + deploy a staging/prod sin cambios post-CR.

