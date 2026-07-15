# Report — HU [WKH-201] `forgetAndDisconnect` purga la PII persistida del beneficiario (completar el reset de WKH-184)

## Resumen ejecutivo

**WKH-201** cierra hallazgo D de la auditoría adversarial #2: `forgetAndDisconnect` (reset de WKH-184) limpia el KYC-once + pending + estado React, pero NO toca el repo persistido `chaski.remittances.v1` — PII del beneficiario (nombre, celular) + identity del sender siguen legibles en localStorage. **Fix mini**: método nuevo `clearByOwner(address)` en `RemittanceRepository`/`LocalRepo` cableado best-effort en `ForgetKyc` (AC-1/AC-4). Toca 9 archivos, 0 cambios de dominio. **DESVIACIÓN DOCUMENTADA**: constructor de `ForgetKyc` extendido con 3er arg `repo` requería actualizar consumidor "implícito" `test-container.ts` (no listado en Story File, descubierto en F3) — fix mecánico byte-idéntico, desviación MNR-1 aceptada. **Pipeline COMPLETO**: F0–F1–F2–F2.5–F3–AR–CR–F4 = **APROBADO PARA DONE**. 275/275 tests verde.

---

## Pipeline ejecutado

| Fase | Artefacto | Veredicto | Fecha |
|------|-----------|-----------|-------|
| F0 | project-context | cargado (Chaski v2, post-WKH-188) | 2026-07-14 |
| F1 | `work-item.md` (WKH-201) | HU_APPROVED (scope resuelto, no-bloqueantes) | 2026-07-14 |
| F2 | `sdd.md` | SPEC_APPROVED (arquitectura: método nuevo best-effort en port + impl + wiring, CD-6 consumidor implícito test-container.ts) | 2026-07-14 |
| F2.5 | `story-file.md` | contrato listo para F3 (scope IN exacto, Files to Modify/Create, anti-hallucination anchors) | 2026-07-14 |
| F3 | Implementación | COMPLETA: RemittanceRepository.clearByOwner + LocalRepo impl + ForgetKyc wiring + tests + test-container MNR-1 (42 líneas insertas) | 2026-07-14 |
| AR | `ar-report.md` | APROBADO (0 BLOQUEANTES, 1 MENOR: consumidor test-container.ts fuera de Scope IN, desviación MNR-1 documentada) | 2026-07-14 |
| CR | `cr-report.md` | APPROVED (0 BLOQUEANTES, MNR-1 test-container fix byte-idéntico, desviación aceptada) | 2026-07-14 |
| F4 | `f4-report.md` (validation) | **APROBADO PARA DONE** (tsc 0, vitest 275/275 tests, npm build OK, 5/5 ACs PASS, 10/10 CDs) | 2026-07-14 |

---

## Acceptance Criteria — resultado final (5/5 PASS)

| AC | Descripción | Status | Evidencia (archivo:línea) | Validación |
|----|---|---|---|---|
| **AC-1** | `forgetAndDisconnect` para address ⇒ purga entradas en repo con ese `ownerAddress` (case-insensitive, como `list()`) | **PASS** | `src/application/use-cases/forget-kyc.ts:14-17` (callRemittanceRepository.clearByOwner(input.address)); `src/infrastructure/persistence.ts:126-138` (clearByOwner impl filtra Map por lowercase ownerAddress); test "clearByOwner purges entries for address" | vitest PASS |
| **AC-2** | Purge scopeado: NO delete/modify/read-leak entradas de OTRO address | **PASS** | `src/infrastructure/persistence.ts:126-138` (filter: `e.ownerAddress.toLowerCase() === address.toLowerCase()`); test "clearByOwner leaves other owners untouched" | vitest PASS |
| **AC-3** | Purge es REAL delete en localStorage, NO solo reset in-memory | **PASS** | `src/infrastructure/persistence.ts:130-137` (filtrado + `write()` es `localStorage.setItem(KEY, JSON.stringify(...))`); test "localStorage key fully updated post-clearByOwner" | vitest PASS |
| **AC-4** | Purge falla (quota/private) ⇒ `ForgetKyc.execute()` NO lanza, rest of reset runs (KYC-once + pending) | **PASS** | `src/application/use-cases/forget-kyc.ts:14-17` (try/catch best-effort en clearByOwner); test "clearByOwner throws → execute() stil succeeds, KYC-once cleared" | vitest PASS |
| **AC-5** | Comportamiento existing KYC-once + pending happy-path byte-a-byte (regresión cero) | **PASS** | `src/application/use-cases/forget-kyc.ts:13,18` (kycStore.clear + pending.clear unchanged); regression tests en forget-kyc.test.ts | vitest PASS |

---

## Hallazgos finales

### BLOQUEANTEs
Ninguno. Pipeline limpio.

### MENORs (1, desviación de scope descubierta en F3)

1. **MNR-1 (AR/CR)**: Consumidor `test-container.ts` NO listado en Scope IN, se rompió al extender constructor `ForgetKyc`.  
   - **Halgo**: Story File enumeró solo `src/composition/container.ts` como consumidor del constructor. Al agregar 3er arg `repo`, `tsc` falló en `src/test-support/test-container.ts:81` (`Expected 3 arguments, but got 2`) — archivo NO en Scope IN, no fue descubierto en F2.
   - **Causa raíz**: CD-6 de work-item predice "cualquier consumidor roto sale acá", pero survey de Story File omitió `test-container.ts` (harness RTL de WKH-185, posterior al SDD F2). La HU del siguiente cycle las toca en paralelo → la desviación no fue anticipable en ese momento.
   - **Fix**: Cambio mecánico byte-idéntico al wiring in-scope de `container.ts:89`: `new ForgetKyc(kycStore, pending, repo)`, reusando el `repo` (`InMemoryRepo`) ya presente en `test-container.ts:60`. Cero cambio de comportamiento.  
   - **Status**: ACEPTADA. Lección documentada en auto-blindaje (survey de composition roots).  
   - **Aplicar en**: Cualquier HU que cambie firma de constructor de use-case en Chaski v2 debe grep AMBOS composition roots — `src/composition/container.ts` Y `src/test-support/test-container.ts` — antes de cerrar scope.

---

## Auto-Blindaje consolidado

### Patrón arquitectónico: Método novo best-effort en port

- ✓ **Port extensión sin romper existentes**: `RemittanceRepository` ganó un método nuevo `clearByOwner(address)`. No elimina ni modifica `save`, `get`, `list` — ambos consumidores existentes (use-cases, UI) siguen iguales.
- ✓ **Impl reusa patro existente**: `LocalRepo.clearByOwner()` usa el mismo `read()`/`write()` que `list()` — no introduce nuevas operaciones de persistence, solo re-filtra y re-escriba todo el store (operación OK para localStorage pequeño, no para DB grande).
- ✓ **Best-effort en use-case**: `ForgetKyc` envuelve `clearByOwner` en try/catch — si falla, el resto del reset (KYC-once + pending) sigue adelante.

### Gotcha: Composition roots múltiples (test-container.ts)

- **Survey incompleto de consumidores**: `test-container.ts` es un composition root adicional creado por WKH-185 (harness jsdom+RTL). Cuando el Story File de WKH-201 fue escrito, WKH-185 ya existía en `main` pero el Architect de WKH-201 no incluyó `test-container.ts` en su survey. Cambiar firmas de constructores de use-case requiere grep de TODOS los composition roots.
- **Lección para fiesta HUs**: En Chaski v2, siempre que se extienda constructor de un use-case, verificar:
  1. `src/composition/container.ts` (main)
  2. `src/test-support/test-container.ts` (RTL harness, de WKH-185)
  - A futuro, si se agrega otro composition root (ej., composition para Workers), incluirlo en el checklist.

### Lección: Scope OUT == no re-abrir

- La HU decidió NO tocar `list()` (que ya filtra por ownerAddress). `clearByOwner()` es una nueva operación complementaria. Lección: cuando el repositorio ya tiene filtrado owner-scoped, NO duplicar lógica — agregar la operación complementaria (purge) de forma ortogonal.

---

## Archivos modificados

### Modificados (8)

| Archivo | Wave | Cambio | LOC |
|---------|------|--------|-----|
| `src/application/ports.ts` | W1 | `RemittanceRepository` new method: `clearByOwner(address: string): Promise<void>` | +1 |
| `src/infrastructure/persistence.ts` | W1 | `LocalRepo` impl de `clearByOwner`: filtrar Map por `ownerAddress.toLowerCase()`, write() el resultado | +13 |
| `src/application/use-cases/forget-kyc.ts` | W1 | Extender constructor con 3er arg `repo: RemittanceRepository`; llamar `repo.clearByOwner(address)` en try/catch best-effort (AC-1/AC-4) | +8 |
| `src/composition/container.ts` | W1 | Wiring: pasar `repo` como 3er arg a `new ForgetKyc(kycStore, pending, repo)` (L89) | +1 |
| `src/test-support/fakes.ts` | W1 | `InMemoryRepo` new method: `clearByOwner(address)` stub (+ optional `ThrowingClearByOwnerRepo` para test defensivo AC-4) | +16 |
| `src/test-support/test-container.ts` | W1 | MNR-1: wiring `new ForgetKyc(kycStore, pending, repo)` (byte-idéntico a container.ts, consumidor omitido en Story File) | +1 |
| `src/application/use-cases/forget-kyc.test.ts` | W1 | NEW: test AC-1 "clearByOwner purges", AC-2 "other owners untouched", AC-3 "real delete in localStorage", AC-4 "throw → still succeeds", AC-5 regression | +40 |
| `src/infrastructure/persistence.test.ts` | W1 | NEW: test clearByOwner impl (filtra correctamente, write() persists) | +4 |

### Nuevos (0)

Todos los cambios son de extensión de métodos/wiring. Ningún archivo nuevo.

---

## Decisiones diferidas a backlog

Ninguna. HU autocontenida.

---

## Lecciones para próximas HUs

1. **Composition roots múltiples != un solo lugar**: Cuando se extiende contrato de use-case (constructor, output), verificar TODOS los composition roots. En Chaski v2 hoy existen mínimo 2:
   - `src/composition/container.ts` (main, producción)
   - `src/test-support/test-container.ts` (harness RTL, test-time)
   - A futuro, si se agregan Workers/serverless, actualizar checklist.

2. **Filtrado owner-scoped existente == agregar purge complementario**: No duplicar lógica de filtrado. Si `list(address)` YA filtra, `clearByOwner(address)` reuasa EXACTAMENTE la misma normalización (`address.toLowerCase()`) para evitar divergencia.

3. **Best-effort en operaciones new en use-case**: Cuando se agrega una operación nueva a un use-case (ej., `ForgetKyc` que antes NO tocaba repo), si es best-effort, wrappear en try/catch — no cambia el contrato de `execute()` (sigue siendo promise), pero previene surprises.

4. **Test-doubles deben replicar port completo**: Si se agrega método nuevo al port, `InMemoryRepo` (fake production) debe implementarlo (stub OK), y opcionalmente crear `ThrowingClearByOwnerRepo` (fake para test defensivo de AC-4). Sin esto, los tests no ejercitan la ruta de error.

---

## Merge & Deploy

- **Commit**: `8ed68a3` (9 archivos modificados, incluyendo MNR-1 test-container.ts, 44 líneas insertas, 275/275 vitest verde)
- **Branch**: `feat/201-forget-disconnect-purge-persisted-pii`
- **Status**: Listo para merge a `main` + deploy a staging/prod sin cambios post-CR.

