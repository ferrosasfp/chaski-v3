# CR Report — WKH-178 (Chaski v2 demo-safe fixes)

**Veredicto**: APPROVED (0 BLOQUEANTES + 1 MENOR)  
**Fecha**: 2026-07-10  
**Reviewer**: nexus-adversary (Code Review post-AR)  
**Branch**: Working tree (cambios sin commitear)

---

## Resumen ejecutivo

WKH-178 cierra 3 defectos demo-safe con cambios quirúrgicos (100% presentación + 1 firma de dominio). El código es **legible, testeable, y respeta todas las invariantes arquitectónicas** del repo. Una redundancia visual fue resuelta en el fix-pack. **APPROVED** — listo para QA.

---

## Hallazgos: 1 MENOR

### MENOR-B · Pill "Modo demo" potencialmente duplicada en step `done`

**Ubicación**: `src/presentation/flow.tsx:283-287` (banner top) vs `:614-618` (Pill en Receipt)  
**Riesgo inicial**: El banner del top (`:283`) tenía condición `step === "review" || step === "track" || step === "done"`, y el Pill del Receipt también renderiza en `done`, causando **dos Pills "Modo demo" simultáneos** en la pantalla final.  
**Fix**: El Dev ajustó la condición del banner top a `step === "review" || step === "track"` (excluyó `"done"`), dejando el Receipt como único emisor en `done`. **Confirmado** en l.283-287: la condición actual NO incluye `"done"`.  
**Estado**: RESUELTO en el fix-pack.

---

## Code Quality Checks

| Aspecto | Veredicto |
|---------|-----------|
| **Imports**: type-safety | OK — imports `type-only` en `flow-vm.ts` para no arrastrar runtime |
| **Naming**: claridad | OK — `isDemoMode`, `deliveredDisplay`, `AbandonPendingKyc` son descriptivos |
| **Anti-pattern**: inyección de deps | OK — `Container` expone solo use-cases (10, uniformes); no hay métodos sueltos |
| **Backward-compat**: regresión dominio | OK — parámetro `deliveredPen` es `Money | null` (compatible con callers que pasan `Money`) |
| **Testing**: cobertura/strategy | OK — helpers puros testados en node (`vitest`), sin render. AC-8/9 (navegación) validadas por inspección + QA manual |
| **Bundle**: sin bloat | OK — `flow-vm.ts` es ~20 líneas, `abandon-pending-kyc.ts` ~10 líneas, cero dependencias nuevas |

---

## Mapa AC → Implementación

| AC | Archivo:Línea | Cambio | Veredicto |
|----|---|---|---|
| AC-1 | `track-remittance.ts:20` | Quitar `?? Money.zero` | ✓ Preciso |
| AC-1 | `confirm-and-send.ts:52` | Idem (demo-inerte) | ✓ Justificado |
| AC-1 | `remittance.ts:176` | Ampliar sig `Money → Money \| null` | ✓ Única línea |
| AC-2/3 | `flow-vm.ts:10-11` | `deliveredDisplay` helper | ✓ Puro, testeable |
| AC-2/3 | `flow.tsx:604,612` | Usar helper + fallback render | ✓ Correcto |
| AC-4/5 | `flow.tsx:283-287,614-618` | Banner top + Pill en Receipt | ✓ No duplica (fix-pack) |
| AC-6 | `flow-vm.ts:5-7` | `isDemoMode` — solo lee `provenance` | ✓ Cumple CD-3 |
| AC-7 | `flow.tsx:128` | `await c.abandonPendingKyc.execute()` en timeout | ✓ Call-site correcto |
| AC-7 | `abandon-pending-kyc.ts:8-9` | `pending.clear()` | ✓ Implementación mínima |
| AC-8 | `flow.tsx:307` | Botón "Reintentar" en Card `timedOut` | ✓ Presente |
| AC-9 | `flow.tsx:230-234` | Handler `onRetryKyc` → resetea a `send` | ✓ Sin reload |

---

## Constraint Directives (CD-1..9)

| CD | Verificación | Status |
|----|---|---|
| CD-1 | Solo `chaski-v2/**` modificado | ✓ OK (git diff) |
| CD-2 | No tocar `src/app/api/**` ni DiditKycGateway | ✓ OK (diff vacío en esos paths) |
| CD-3 | "Modo demo" de `provenance`, sin flags | ✓ OK — `flow-vm.ts` limpia |
| CD-4 | FallbackPayoutGateway intacta (identidad "María Elena", `deliveredPen:null`) | ✓ OK — gateways.ts sin cambios |
| CD-5 | Único change de dominio = sig `markSettled` | ✓ OK — TRANSITIONS intacto, no self-loop `kyc_pending→kyc_pending` |
| CD-6 | Presentación no importa `KycPendingStore` directo | ✓ OK — clear via `c.abandonPendingKyc.execute()` |
| CD-7 | Indicador via `isDemoMode` (sin duplicación lógica) | ✓ OK — una única definición |
| CD-8 | Demo happy-path muestra monto real (no `"—"`) | ✓ OK — `deliveredDisplay` cae a `quote.receive` (FallbackQuoteGateway devuelve real) |
| CD-9 | Sin `deliveredPen` no-null en fakes (inyección solamente) | ✓ OK — test AC-1(b) usa `statusResult`, no toca default |

---

## Integration Testing (sin harness de render)

- **`use-cases.test.ts`**: AC-1 reforzado (`toEqual(Money.of(368,"PEN"))` happy-path + NEW "null passthrough"); regresión en `remittance.test.ts` cero (callers pasan `Money`).
- **`flow-vm.test.ts` (NEW)**: AC-2..6 covertura completa (helpers puros, `vitest run` en node, 6 tests PASS).
- **`abandon-pending-kyc.test.ts` (NEW)**: AC-7 unitario (`pending.clear()`, 1 test PASS).
- **AC-8/9** (navegación/render): validadas por inspección de código (botón presente, handler sin reload, estado limpio) + QA manual con evidencia visual.

---

## Style / Patterns

- ✓ Usa `Pill tone="warn"` existente (nuevo tono agregado, paleta coherente: `bg-sand text-ink`).
- ✓ Módulo `flow-vm.ts` puro, exporta solo funciones helpers (sin clases, sin side-effects).
- ✓ `AbandonPendingKyc` es un use-case mini (~10 líneas), patrón homogéneo con `ListHistory`.
- ✓ Zero `console.log`, zero `any`, zero hardcodes.

---

## Conclusion

**APPROVED PARA QA (F4).** El único hallazgo MENOR fue la duplicación de Pill "Modo demo" en `done` (el Dev lo fixeó excluyendo `done` de la condición del banner top). Código limpio, CDs 9/9 respetadas, tests 1:1 con ACs. Listo para F4 Validation.
