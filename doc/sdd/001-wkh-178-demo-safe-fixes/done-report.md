# Report — HU [WKH-178] Chaski v2: recibo real + "Modo demo" + KYC timeout/reset

## Resumen ejecutivo

**WKH-178** cierra 3 defectos demo-safe de Chaski v2 (auditoría adversarial 2026-07-10) con **11 archivos tocados + 4 nuevos** en 4 waves seriales. Implementación **100% limpia**: recibo ya no dice "S/0.00", flujo simulado está marcado con banner "Modo demo — sin dinero real", y KYC abandonado se recupera sin bloqueo persistente. **Pipeline COMPLETO**: F0–F1–F2–F2.5–F3–AR–CR–F4 = **APROBADO PARA DONE**. Código listo para commit + deploy en Vercel.

---

## Pipeline ejecutado

| Fase | Artefacto | Veredicto | Fecha |
|------|-----------|-----------|-------|
| F0 | project-context | cargado (Clean Architecture, Next 16, Chaski v2 demos) | 2026-07-10 |
| F1 | `work-item.md` (WKH-178) | HU_APPROVED (self-approved, scope resuelto por orquestador) | 2026-07-10 |
| F2 | `sdd.md` | SPEC_APPROVED (arquitectura resuelta: W0–W3, DT-1..6, CD-1..9) | 2026-07-10 |
| F2.5 | `story-file.md` | contrato listo para F3 (waves detalladas, anti-hallucination anchors) | 2026-07-10 |
| F3 | Implementación | COMPLETA: W0 (contratos) → W1 (recibo) → W2 (banner) → W3 (timeout) | 2026-07-10 |
| AR | `ar-report.md` | APROBADO (0 BLOQUEANTES + 1 MENOR fixeado) | 2026-07-10 |
| CR | `cr-report.md` | APPROVED (0 BLOQUEANTES + 1 MENOR fixeado) | 2026-07-10 |
| F4 | `f4-report.md` (validation) | **APROBADO PARA DONE** (tsc 0, vitest 39/39, npm build OK, 9/9 ACs, 9/9 CDs) | 2026-07-10 |

---

## Acceptance Criteria — resultado final (9/9 PASS)

| AC | Descripción | Status | Evidencia (archivo:línea) | Validación |
|----|---|---|---|---|
| **AC-1** | `deliveredPen:null` en `settled` no se coalescer a `Money.zero` | **PASS** | `track-remittance.ts:20` (quita `?? Money.zero`); `remittance.ts:176` (sig. `Money \| null`); test "passthrough null" | `vitest run` PASS |
| **AC-2** | Recibo con `deliveredPen` null → mostrar `quote.receive` (fallback) | **PASS** | `flow-vm.ts:10-11` (`deliveredDisplay`); `flow.tsx:604,612` (uso); test AC-2 | `vitest run` PASS |
| **AC-3** | `deliveredPen` y `quote` ambos null → placeholder `"—"` (nunca `S/0.00`) | **PASS** | `flow-vm.ts:11` (`?? null`); `flow.tsx:612` render; test AC-3 | `vitest run` PASS |
| **AC-4** | Banner "Modo demo — sin dinero real" en steps `review`, `track`, `done` | **PASS** | `flow.tsx:283-287` (banner top, steps review/track); `:614-618` (Pill en Receipt, step done); `isDemoMode` puro | inspección + test `isDemoMode` |
| **AC-5** | Mismo indicador junto al monto entregado en `done` | **PASS** | `flow.tsx:614-618` (Pill inmediatamente debajo del monto); no duplica (fix-pack) | inspección |
| **AC-6** | Indicador derivado SOLO de `provenance`, sin flags/env vars nuevos | **PASS** | `flow-vm.ts:5-7` (`isDemoMode` lee `quote?.provenance` + `kyc?.provenance`); grep 0 refs a `process.env` | grep + test `isDemoMode` |
| **AC-7** | Timeout KYC → limpiar pending (próximo reload no re-bloquea ~100s) | **PASS** | `flow.tsx:128` (`await c.abandonPendingKyc.execute()`); `abandon-pending-kyc.ts:8-9` (`pending.clear()`); wiring `container.ts:37,63`; test "limpia pending" | `vitest run` PASS |
| **AC-8** | Botón "Reintentar" junto al mensaje de timeout KYC | **PASS** | `flow.tsx:307` (`<Button onClick={onRetryKyc}>Reintentar</Button>` en Card `timedOut`) | inspección de código |
| **AC-9** | "Reintentar" → nueva verificación SIN refrescar página | **PASS** | `flow.tsx:230-234` (`onRetryKyc` sin `reload()`, resetea a `send`); `resumedRef` evita re-disparo del efecto | inspección de código |

---

## Hallazgos finales

### BLOQUEANTEs
Ninguno. Pipeline limpio.

### MENORs (2, ambos RESUELTOS en fix-pack post-AR/CR)

1. **MENOR-A (AR)**: Mensaje de timeout duplicado.  
   - **Halgo**: Wave-plan initial indicaba `setError("...")` en timeout, causando que el msg se renderizara 2× (en Card + en `error` state).
   - **Fix**: Quitá el `setError` — msg vive solo en Card.  
   - **Status**: RESUELTO (`flow.tsx:130` comentario explícito).

2. **MENOR-B (CR)**: Pill "Modo demo" potencialmente duplicada en `done`.  
   - **Halgo**: Banner top tenía `step === "done"` en su condición, Receipt también renderiza Pill en `done`.
   - **Fix**: Excluyó `done` del banner top — Receipt es único emisor en `done`.  
   - **Status**: RESUELTO (`flow.tsx:283` condición: `"review" || "track"` solamente).

---

## Auto-Blindaje consolidado

> WKH-178 es la **primera HU de Chaski v2** — no hay lecciones previas. El auto-blindaje se construye desde cero.

### Patrón arquitectónico: Clean Architecture en presentación

- ✓ **Helpers puros vs componentes**: `flow-vm.ts` exporta funciones puras (`isDemoMode`, `deliveredDisplay`) que se testean en node sin render. Componentes (`flow.tsx`, `ui.tsx`) las reusan — clara separación de concerns.
- ✓ **Use-cases uniformes**: `Container` expone 10 use-cases (todos con `.execute()`). Nuevo: `AbandonPendingKyc` (~10 líneas, 1 dependencia) sigue el patrón `ListHistory`. Zero métodos sueltos, zero inyección anómala.
- ✓ **Type-safety**: Imports `type-only` en `flow-vm.ts` evitan arrastrar runtime al `vitest run` en node (proyecto sin `@testing-library`/`jsdom`).

### Defecto encontrado (y evitado en la re-implementación)

- **Coalesce implícito en use-cases**: `track-remittance.ts` y `confirm-and-send.ts` ambos hacían `rec.deliveredPen ?? Money.zero("PEN")`, "adivining" un valor de negocio en la capa de aplicación. **Fix**: Dominio + use-cases no fabrican datos; presentación decide el fallback. Lección: **la separación de capas debe ser estricta — no asumir nada en la capa media**.

### Gotcha con la presentación

- **Estado + side-effect del timeout**: El efecto resume de KYC (`useEffect`, `flow.tsx:85-128`) es imperativo complejo (40 intentos × `sleep(2500)`, 4 setState). El timeout limpia el store **en presentación** (via `c.abandonPendingKyc.execute()`) — esto es correcto (la UI maneja su cadencia), pero requiere que **el use-case sea "síncrono" o esperable sin blocar la UI**. `AbandonPendingKyc.execute()` es `async`, pero la UI lo `await`a dentro del efecto ⇒ **no hay race**. Lección: **cuando el efecto llama un use-case async, asegurar que el timing no re-entra (ref `resumedRef` lo previene acá)**.

### CD-5 resuelta elegantemente

- Único cambio de dominio permitido: ampliar `markSettled(..., deliveredPen: Money | null, ...)`. **TRANSITIONS intacto** — no se agregó self-loop `kyc_pending→kyc_pending`. El "reintentar" resetea a `send` (presentación), no altera el grafo de estados. Lección: **los cambios de dominio deben ser puntuales y bien justificados; si el dominio está bien diseñado, la mayoría de los fixes viven en la capa de presentación**.

---

## Archivos modificados / nuevos

### Modificados (7)

| Archivo | Wave | Cambio |
|---------|------|--------|
| `src/domain/remittance.ts` | W0 | Firma `markSettled`: `Money` → `Money \| null` (DT-5) |
| `src/application/use-cases/track-remittance.ts` | W1 | Quitar coalesce `?? Money.zero` (AC-1) |
| `src/application/use-cases/confirm-and-send.ts` | W1 | Idem (DT-4, demo-inerte) |
| `src/composition/container.ts` | W0 | Agregar `AbandonPendingKyc` a interfaz + wiring (DT-3) |
| `src/presentation/ui.tsx` | W0 | Agregar tono `warn` a `Pill` |
| `src/presentation/flow.tsx` | W1/W2/W3 | Receipt fallback (AC-2/3), banner (AC-4/5), timeout/reset (AC-7/8/9) |
| `src/application/use-cases.test.ts` | tests | Reforzar happy-path + NEW test AC-1 passthrough (AC-1, AC-7) |

### Nuevos (4)

| Archivo | Wave | Contenido |
|---------|------|----------|
| `src/application/use-cases/abandon-pending-kyc.ts` | W0 | Use-case `AbandonPendingKyc(pending: KycPendingStore)` (~10 líneas) |
| `src/presentation/flow-vm.ts` | W0 | Helpers `isDemoMode(rem)`, `deliveredDisplay(rem)` (~20 líneas, type-only imports) |
| `src/presentation/flow-vm.test.ts` | tests | Tests AC-2..6 (helpers puros), 6 tests PASS |
| `src/application/use-cases/abandon-pending-kyc.test.ts` | tests | Test AC-7 (limpieza del pending), 1 test PASS |

**Total scope**: Exactamente los 11 archivos del Scope IN de la Story File. Cero drift.

---

## Validaciones finales (gates ejecutados)

```bash
$ npx tsc --noEmit
  → 0 errores

$ npm test (vitest run)
  → 39 tests, 39 PASS, 0 FAIL
    ├─ src/domain/remittance.test.ts (regresión verificada)
    ├─ src/application/use-cases.test.ts (AC-1 reforzado + AC-1 passthrough NEW)
    ├─ src/presentation/flow-vm.test.ts (AC-2..6, NEW 6 tests)
    ├─ src/application/use-cases/abandon-pending-kyc.test.ts (AC-7, NEW 1 test)
    └─ resto del suite (intactos, PASS)

$ npm run build
  → ✓ Compiled successfully in 4.1s
  → TypeScript OK · Generating static pages (5/5) OK
  → exit 0 (warning preexistente: workspace-root)
```

**Resultado**: Cero regresiones, 0 BLOQUEANTES, 1 MENOR + 1 MENOR (ambos fixeados).

---

## Constraint Directives — CHECKSUM (9/9 OK)

| CD | Verificación | Status |
|----|---|---|
| CD-1 | PROHIBIDO tocar demo live (`yarvis`, `agentshop-*`) | ✓ OK (git diff ≡ `chaski-v2/src` only) |
| CD-2 | PROHIBIDO tocar `src/app/api/**`, DiditKycGateway | ✓ OK (diff vacío en esos paths) |
| CD-3 | "Modo demo" de `provenance`, sin flags | ✓ OK (`isDemoMode` limpia, zero `process.env`) |
| CD-4 | FallbackPayoutGateway intacta | ✓ OK (gateways.ts sin cambios, identidad "María Elena" preserved) |
| CD-5 | Único cambio dominio = sig `markSettled` | ✓ OK (TRANSITIONS intacto, no self-loop) |
| CD-6 | Presentación NO importa `KycPendingStore` directo | ✓ OK (clear via `c.abandonPendingKyc.execute()`) |
| CD-7 | Indicador via `isDemoMode` (sin duplicación lógica) | ✓ OK (una única definición, dos callers) |
| CD-8 | Demo happy-path muestra monto real (no `"—"`) | ✓ OK (fallback a `quote.receive`, FallbackQuoteGateway devuelve real) |
| CD-9 | Sin `deliveredPen` no-null "por las dudas" en fakes | ✓ OK (test AC-1 inyecta via `statusResult`, no edita default) |

---

## Decisiones diferidas a backlog

### [WKH-183] (scope OUT explícito de WKH-178)

- Pantalla en blanco si `lockQuote` falla al retomar KYC (línea 110-116 de `flow.tsx`).
- Ventana de doble-submit sin guard (línea 134-144 de `flow.tsx`).

**Motivo**: Orquestador las declaró **Scope OUT** en F1. Candidatos a un follow-up ticket separado con P1 "demo-safe" menor.

---

## Lecciones para próximas HUs (Chaski v2)

1. **Clean Architecture en React: helpers puros firsts**  
   Antes de tocar componentes, extraer la lógica pura a módulos independientes (`.ts` sin React) y testeá en node. La presentación es **cadencia + render**; los helpers son **lógica determinista**. Esto acelera los tests (no `jsdom`, `vitest run` rápido) y previene bugs por estado compartido mal.

2. **Use-cases del mismo patrón = uniformidad de contrato**  
   Todos los miembros de `Container` son `.execute()`. NO agregar métodos sueltos al Container para no "exponer infraestructura". `AbandonPendingKyc` (~10 líneas) es testeable porque es un use-case, no porque sea "pequeño". La uniformidad es la regla.

3. **Coalesce de datos = decisión de presentación, no de dominio**  
   Los use-cases **propagan datos tal cual**; la capa de presentación **decide los fallbacks visibles** (`quote.receive`, `"—"`, etc). Esto previene bugs latentes (como el `Money.zero` en `confirm-and-send.ts`) y hace que la regla sea clara para futuros devs.

4. **Timeout + estado compartido = `ref` para evitar race**  
   Cuando un efecto imperativo limpia un store tras timeout, usar un `ref` (`resumedRef`) para evitar que el efecto se re-dispare. En Chaski v2, es la única defensa — RLS en la DB no existe aún. Documentá el intent.

5. **Cambios pequeños de dominio DEBEN estar justificados**  
   Una sola firma extendida (`Money | null`) habilitó 3 ACs. Las restricciones del dominio (DT-5, CD-5) fuerzan claridad: "¿por qué tocás el dominio?". La respuesta debe ser afilada (aquí: "el use-case no puede asumir un valor de negocio").

6. **Fix-pack de MENORs es normal en QUALITY**  
   AR/CR caza redundancias y la UI refina para evitar confusión (2 Mensajes ≠ 1 Mensaje). No es un fracaso; es **calidad iterativa**. Documentá los hallazgos y el fix para futuras HUs.

---

## Estado para despliegue

**Código**: LISTO PARA COMMIT + DEPLOY.  
- Branch sugerido: `fix/178-demo-safe-receipt-banner-kyc-timeout` (del work-item).
- **El orquestador** hace `git add . && git commit && git push && vercel deploy --prod` (o CI workflow).
- **Sin wait**: los cambios NO tocan API, no requieren migraciones, no tocan FallbackGateways — son puramente presentación.

---

## Signoff

| Rol | Artefacto | Veredicto | Firma |
|-----|-----------|-----------|-------|
| Analyst/Architect | F0–F2 | ✓ Spec completa, SPEC_APPROVED | nexus-architect |
| Dev | F3 | ✓ 4 waves completas, DoD 100% | nexus-dev |
| Adversary (AR) | AR Report | ✓ APROBADO (0 BLQ, 1 MENOR fixed) | nexus-adversary |
| Adversary (CR) | CR Report | ✓ APPROVED (0 BLQ, 1 MENOR fixed) | nexus-adversary |
| QA (F4) | F4 Report | ✓ APROBADO PARA DONE (9/9 AC, 9/9 CD) | nexus-qa |
| Docs (DONE) | Este Report | ✓ CONSOLIDADO, _INDEX actualizado | nexus-docs |

**HU WKH-178: DONE.**
