# F4 Validation Report — WKH-185 (Component test harness jsdom+RTL + backfill) — COMPACT

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-11
**Repo/branch**: `chaski-v2/` · `test/185-component-test-harness-rtl`

## Runtime gates (ejecutados por QA, salida real)
- `npx tsc --noEmit` → `TypeScript compilation completed`, exit 0.
- `npx vitest run` (suite completa) → `Test Files 19 passed (19)` / `Tests 172 passed (172)`.
- `npx vitest run --exclude "src/presentation/flow.test.tsx"` (node-only) → `Test Files 18 passed (18)` / `Tests 167 passed (167)` → **piso CD-6 confirmado intacto** (167 = 167, no bajó).
- `npm run build` (`next build --webpack`) → `Compiled successfully` + `Finished TypeScript` + páginas generadas, exit 0. (Warning preexistente de lockfile-root del monorepo, no relacionado a la HU.)

## Seam DI — verificación (CD-2)
`git diff main -- src/presentation/flow.tsx` = **exactamente 2 hunks / 3+3 líneas**:
- L16: `import { createContainer } from ...` → `import { createContainer, type Container } from ...` (import de tipo, cero runtime).
- L46-47: `export function RemittanceFlow()` → `export function RemittanceFlow({ container }: { container?: Container } = {})` + `useMemo(() => container ?? createContainer(), [container])`.
`git diff main -- app/page.tsx` → vacío (0 líneas). Único caller de prod intacto → comportamiento byte-a-byte preservado (AC-3).
`package.json`: `dependencies` sin cambios; `devDependencies` +4 (`jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`), exactamente las versiones de la Story File §2.1.

## ACs
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (suite 0 fallos, piso 167) | ✅ | `npx vitest run` → 172 (167+5), 0 fallos; node-only aislado = 167 |
| AC-2 (jsdom per-file no altera node) | ✅ | `flow.test.tsx:1` `// @vitest-environment jsdom`; los 18 `.test.ts` restantes sin docblock, corren en node (verificado en corrida aislada) |
| AC-3 (sin prop = prod idéntico) | ✅ | `app/page.tsx` diff vacío; `flow.tsx:44` `container ?? createContainer()` con `[container]` estable cuando `undefined` |
| AC-4 (render + recorre con fakes, cero red) | ✅ | `flow.test.tsx:48-67` (T1) recorre send→connect→verify→review vía `buildTestContainer`; `test-container.ts` solo instancia `fakes.ts` (CD-11) |
| AC-5 (Reintentar + retry sin reload) | ✅ | `flow.test.tsx:137-181` (T3): `getByText("Reintentar")` visible tras timeout (fake timers `advanceTimersByTimeAsync(100_000)`), click vuelve a `send`, `reloadSpy` `not.toHaveBeenCalled()` |
| AC-6 (reset limpia estado React) | ✅ | `flow.test.tsx:103-127` (T5): tras `Empezar de nuevo` vuelve a step `send`, badge address desaparece |
| AC-7 (control visible solo con address) | ✅ | `flow.test.tsx:86-100` (T4): `queryByText("¿No sos vos?")` null sin address; visible tras `Conectar wallet` |
| AC-8 (reset limpia PII beneficiario) | ✅ | `flow.test.tsx:121-126` (T5): recipient/destination `""`, amount vuelve a `"400"` |
| AC-9 (review nombre + doc enmascarado, nunca completo) | ✅ | `flow.test.tsx:70-83` (T2): `Test Quispe Mamani` + `••••5678` visibles; `queryByText(/12345678/)` null y `container.textContent` no lo contiene (CD-12) |
| AC-10 (cleanup entre tests) | ✅ | `flow.test.tsx:27` `afterEach(() => cleanup())`; T3 además `vi.useRealTimers()` en su propio `afterEach` (CD-10) |

## Drift
- Scope IN vs `git diff --name-only main...HEAD`: `package.json`, `package-lock.json`, `src/presentation/flow.tsx`, `src/test-support/test-container.ts`, `src/presentation/flow.test.tsx`, `doc/sdd/008-.../*` — coincide 1:1 con Scope IN de la Story File §3. `app/page.tsx`, `vitest.config.ts`, `src/presentation/ui.tsx` no tocados (Scope OUT respetado).
- CD-7 (lista cerrada): exactamente 5 tests (T1-T5), sin ACs adicionales fuera de AC-4..AC-10.
- Auto-blindaje documentado (`auto-blindaje.md`): gotcha de `window.location.reload` no-configurable en jsdom, resuelto reemplazando el objeto `location` completo (T3, `flow.test.tsx:158-179`) — no afecta ningún AC.
- `doc/sdd/_INDEX.md` sigue con fila "in progress (F1)" para WKH-185 — pendiente de actualización en DONE (nexus-docs), no es drift de código.
- Nota de proceso: no se encontraron `ar-report.md`/`cr-report.md` persistidos en disco en esta carpeta; los veredictos AR APROBADO (0 BLQ/0 MENOR) y CR APPROVED (0 BLQ/0 MENOR) fueron reportados por el orquestador. No bloqueante (gates re-verificados directamente por QA arriba), pero se deja constancia para que Docs confirme o genere el artefacto en el cierre.

## Gates
- Confirmados directamente por QA (re-ejecutados porque no había cr-report.md que leer): `tsc`/`vitest`/`build` todos verdes, salida arriba.

**Listo para DONE.**
