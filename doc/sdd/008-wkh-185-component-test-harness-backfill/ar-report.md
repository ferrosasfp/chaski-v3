# AR Report — WKH-185 (Component test harness jsdom+RTL + backfill) — COMPACT

**Veredicto**: APROBADO SIN HALLAZGOS  
**Fecha**: 2026-07-11  
**Repo/branch**: `chaski-v2/` · `test/185-component-test-harness-rtl`

---

## Resumen

Adversarial Review completado. HU de deuda técnica test-only: agrega harness de tests de componente (jsdom + React Testing Library) + un seam mínimo de inyección de dependencias (prop opcional `container` en `RemittanceFlow`). El único cambio de runtime de producción preserva comportamiento byte-a-byte cuando no se inyecta el prop (único caller en `app/page.tsx` no lo pasa).

---

## Hallazgos

| Categoría | Cantidad | Detalle |
|-----------|----------|---------|
| **BLOQUEANTES** | 0 | — |
| **MENORES** | 0 | — |

---

## Verificaciones críticas (CD-2, CD-6)

1. **Seam DI (`flow.tsx`)**: Inspección de diff confirma exactamente 2 hunks / 3+3 líneas:
   - L16: import de tipo `Container` (cero runtime, borrado en build).
   - L46-47: prop opcional `container` con default `container ?? createContainer()`.
   - Ninguna otra línea de `flow.tsx` modificada ✅
   - `app/page.tsx` diff vacío (único caller no afectado) ✅

2. **Constraint CD-6 (piso de tests node)**: Verificado post-merge:
   - `npx vitest run --exclude "src/presentation/flow.test.tsx"` → Tests 167 passed (167) — piso intacto ✅
   - El suite completo: Tests 172 passed (172) — los 5 nuevos tests de componente bajo jsdom, ejecutados con éxito ✅

3. **Scope IN vs OUT**:
   - Archivos tocados coinciden 1:1 con Scope IN del SDD ✅
   - `vitest.config.ts` no se creó (estrategia per-file respetada) ✅
   - `ui.tsx`, `page.tsx` no tocados ✅
   - Cero cambios fuera de `chaski-v2/` (CD-1) ✅

---

## ACs de adversaria

| Patrón | Veredicto | Notas |
|--------|-----------|-------|
| **Inyección mínima** (prop único cambio) | ✅ PASS | Cero otras líneas del flujo afectadas. |
| **Piso de cobertura preexistente** (167 tests node) | ✅ PASS | Aislados, ejecutados, piso conservado. |
| **Confines del backfill** (AC-5..AC-10, lista cerrada) | ✅ PASS | Exactamente 5 tests, sin expansión a otros ACs; CD-7 respetado. |
| **Hermetismo de jsdom** (per-file, no global) | ✅ PASS | Docblock `// @vitest-environment jsdom` en `flow.test.tsx:1` únicamente. |
| **Sin red / solo fakes** (CD-5) | ✅ PASS | `buildTestContainer()` ensambla `fakes.ts` sin tocar `DiditKycGateway`, `HttpPayoutAuthorityGateway`, RPC real. |

---

## Auto-Blindaje validado

- **Gotcha framer-motion mock**: documentado en `auto-blindaje.md` (DT-7). Sin este mock, los steps animados no montan bajo jsdom (exit animation no completa). Verificado que el mock `pass-through` de `framer-motion` está en `flow.test.tsx` — ✅ correcto.
- **Gotcha `window.location.reload` non-configurable en jsdom**: documentado en `auto-blindaje.md`. Fix aplicado en T3 (test de AC-5): reemplaza el objeto `location` completo, no `defineProperty` sobre la property individual. ✅ Correcto.

---

## Cierre

**Veredicto final**: APROBADO. Cero bloqueantes. Cero menores. La HU está lista para marcar DONE — el backfill es completo, hermético y regresivo (0 riesgo sobre los tests preexistentes).

