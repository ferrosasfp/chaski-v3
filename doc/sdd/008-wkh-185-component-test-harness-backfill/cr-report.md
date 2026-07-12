# CR Report — WKH-185 (Component test harness jsdom+RTL + backfill) — COMPACT

**Veredicto**: APPROVED SIN HALLAZGOS  
**Fecha**: 2026-07-11  
**Repo/branch**: `chaski-v2/` · `test/185-component-test-harness-rtl`

---

## Resumen

Code Review completado. HU de deuda técnica **test-only**: el único cambio de código de producción es un seam de inyección de dependencias en `flow.tsx` (prop `container?` opcional, cero cambio observable en prod cuando no se pasa). Todos los tests nuevos (`flow.test.tsx`) son harness de componente con RTL, cero cambio de lógica de dominio ni infraestructura.

---

## Hallazgos

| Categoría | Cantidad | Detalle |
|-----------|----------|---------|
| **BLOQUEANTES** | 0 | — |
| **MENORES** | 0 | — |

---

## Puntos de auditoría clave

### 1. `src/presentation/flow.tsx` (único cambio de producción)

**L16** — Import de tipo:
```tsx
// Antes:
import { createContainer } from "../composition/container";

// Después:
import { createContainer, type Container } from "../composition/container";
```
✅ **`type Container`** es import puro de tipos (borrado en build, cero runtime overhead).

**L46-47** — Firma + useMemo:
```tsx
// Antes:
export function RemittanceFlow() {
  const c = useMemo(() => createContainer(), []);

// Después:
export function RemittanceFlow({ container }: { container?: Container } = {}) {
  const c = useMemo(() => container ?? createContainer(), [container]);
```
✅ **Prop opcional** (`?: Container = {}`): cuando `undefined` (prod, caso de `app/page.tsx`), el comportamiento es **byte-a-byte idéntico** — `container ?? createContainer()` = `createContainer()` en la rama real.  
✅ **Dependencia estable**: `[container]` vs `[]` — cuando `undefined`, `[undefined]` es igual a `[]` en términos de re-renders (prop nunca cambia en prod, sender no existe).

---

### 2. Nuevos archivos (test-only — cero impacto producción)

| Archivo | Naturaleza | Riesgo |
|---------|-----------|---------|
| `src/test-support/test-container.ts` | Helper DI para tests | TEST-ONLY; en `.testSupportPath` (excluido de build) |
| `src/presentation/flow.test.tsx` | Harness RTL | TEST-ONLY; 5 tests, vitest runner, `jsdom` per-file |
| `package.json` | +4 devDeps | `jsdom`, `@testing-library/{react,user-event,jest-dom}` — todas devDeps estándar, cero impacto bundle |

---

### 3. Calidad del código de tests

**Anti-hallucinations** (archivo:línea exacto desde Story File):
- ✅ Badge address `{address.slice(0,6)}…{address.slice(-4)}` — rendered from flow.tsx L299 ✓
- ✅ Botones "¿No sos vos?" / "Empezar de nuevo" — flow.tsx L304-324 ✓
- ✅ Botón "Reintentar" (card timedOut) — flow.tsx L357-366 ✓
- ✅ Review muestra nombre + doc enmascarado — flow.tsx L568-580 + dominio L52-61 ✓

**Mocks necesarios** (documentados en Auto-Blindaje):
- ✅ `framer-motion` mock pass-through (DT-7) — sin esto, `AnimatePresence` no completa exits, tests cuelgan.
- ✅ `window.location.replace()` en T3 — reemplazado el objeto `location` completo (workaround jsdom non-configurable) ✓

**Cleanup y determinismo** (CD-4, CD-10):
- ✅ `afterEach(() => cleanup())` en flow.test.tsx:27 — aislamiento entre tests ✓
- ✅ T3 (fake timers) restaura timers reales en su propio `afterEach` — no contamina T4/T5 ✓

---

### 4. Conformidad con Constraints

| CD | Verificación | Resultado |
|----|--------------|-----------|
| CD-1 (solo chaski-v2) | Diff limitado a chaski-v2/ | ✅ PASS |
| CD-2 (único cambio runtime = prop) | Inspección flow.tsx monoizada | ✅ PASS (2 hunks, 3+3 líneas) |
| CD-3 (no vitest.config.ts global) | Docblock per-file en flow.test.tsx:1 | ✅ PASS |
| CD-4 (cleanup obligatorio) | afterEach(cleanup) presente | ✅ PASS |
| CD-5 (sin red, solo fakes) | buildTestContainer() usa fakes.ts 1:1 | ✅ PASS |
| CD-6 (piso 167 preexistentes) | `vitest run --exclude flow.test.tsx` = 167 | ✅ PASS |
| CD-7 (lista cerrada AC-5..AC-10) | 5 tests exactos, sin expansión | ✅ PASS |
| CD-8 (mock framer-motion) | Presente en flow.test.tsx | ✅ PASS |
| CD-9 (jest-dom per-file) | `import "@testing-library/jest-dom/vitest"` | ✅ PASS |

---

## Decisiones técnicas validadas

- **DT-1 (jsdom per-file)**: Vitest lo soporta nativamente; cero fricción. ✅
- **DT-2 (prop opcional)**: Default preserva prod, backward-compatible. ✅
- **DT-3 (`buildTestContainer`)**: Patrón builder standard, compartición de `repo`/`clock`, override sobrecargado bien. ✅
- **DT-4 (jest-dom per-file `/vitest`)**: Registro limpio sin globals, consistente con repo. ✅
- **DT-5 (fake timers solo T3)**: Confinado a un test, no contamina suite. ✅
- **DT-6 (FallbackQuoteGateway real)**: Infra pura (sin red) con provenance correcto. ✅
- **DT-7 (mock framer-motion)**: Necesario, implementado, documentado. ✅

---

## Cierre

**Veredicto final**: APPROVED. Cero hallazgos. Cero riesgos. El backfill es **hermético, regresivo y determinista**. Listo para DONE.

