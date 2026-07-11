# F4 — Validation Report — WKH-178 (Chaski v2 demo-safe fixes)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-10
**Repo**: `chaski-v2/` (working tree, cambios NO commiteados aún — AR+CR ya aprobaron sobre este mismo working tree, sin BLOQUEANTES, fix-pack de 2 MENORs aplicado)

## Runtime gates (ejecutados yo mismo — CR no tenía commit para citar, working tree sin commitear)

```
$ npx tsc --noEmit
TypeScript compilation completed  → exit 0, 0 errores

$ npx vitest run --reporter=verbose
39 tests, 39 pass, 0 fail (todos los archivos .test.ts del repo)

$ npm run build
✓ Compiled successfully in 4.1s
✓ TypeScript OK · Generating static pages (5/5) OK
→ exit 0 (único warning: workspace-root inferido por lockfiles duplicados, no bloqueante, preexistente)
```

## ACs (9/9 PASS)

| AC | Descripción | Status | Evidencia | Método |
|----|---|---|---|---|
| AC-1 | `settled` con `deliveredPen:null` no se coalescer a `Money.zero` | PASS | `src/application/use-cases/track-remittance.ts:20` (`r.markSettled(rec.txRef ?? "", rec.deliveredPen, ...)`, sin `?? Money.zero`); firma habilitante `src/domain/remittance.ts:176` (`deliveredPen: Money \| null`); test `src/application/use-cases.test.ts` → *"payout settled con deliveredPen null → settled preserva null (AC-1, no coalesce a S/0)"* PASS + happy-path reforzado a `toEqual(Money.of(368,"PEN"))` | test automático |
| AC-2 | `deliveredPen` null ⇒ mostrar `quote.receive` | PASS | `src/presentation/flow-vm.ts:10-11` (`deliveredDisplay`); uso en `flow.tsx:604` (`Receipt`); test `flow-vm.test.ts` → *"AC-2: deliveredPen null → usa quote.receive"* PASS | test automático |
| AC-3 | ambos null ⇒ `"—"` (nunca `S/0.00`) | PASS | `flow-vm.ts:11` (`?? null`) + render `flow.tsx:612` (`{delivered ? delivered.format() : "—"}`); test *"AC-3: deliveredPen y quote null → null"* PASS | test automático |
| AC-4 | Banner "Modo demo" en `review`/`track`/`done` | PASS | Banner de tope `flow.tsx:283-287` (gated `step === "review" \|\| step === "track"`) + Receipt `flow.tsx:614-618` (gated `isDemoMode(rem)`, cubre `done`) — entre ambos, los 3 steps quedan cubiertos, sin duplicar en `done`; tests *"AC-4: quote.provenance local-fallback → true"* y *"AC-4: kyc.provenance local-fallback → true"* PASS | test automático (lógica) + inspección (render gating) |
| AC-5 | Mismo indicador junto al monto en `done` | PASS | `flow.tsx:611-618` (Receipt: monto en `:612`, Pill "Modo demo" inmediatamente debajo en `:614-618`); test *"AC-5: estado done demo → isDemoMode true"* PASS | test automático + inspección |
| AC-6 | Indicador derivado SOLO de `provenance`, sin flags | PASS | `flow-vm.ts:5-7` (`isDemoMode` lee únicamente `rem.quote?.provenance`/`rem.kyc?.provenance`, sin env var ni flag); grep confirmó cero referencias a `process.env`/flags en `flow-vm.ts`; test *"AC-6: ambos provenance didit → false"* PASS | test automático + grep |
| AC-7 | Timeout KYC ⇒ limpiar pending (sin re-bloqueo en reload) | PASS | `flow.tsx:126-131` (branch timeout: `await c.abandonPendingKyc.execute()` ANTES de `setTimedOut(true)`); `abandon-pending-kyc.ts:8-9` (`pending.clear()`); wiring `container.ts:37,63` (`abandonPendingKyc: new AbandonPendingKyc(kycPending)`, reusa la instancia); test `abandon-pending-kyc.test.ts` → *"AC-7: limpia el pending (próximo resume ya no re-bloquea)"* PASS | test automático (unidad) + inspección (call-site en el timeout real) |
| AC-8 | Botón "Reintentar" junto al mensaje de timeout | PASS | `flow.tsx:299-308` (branch `timedOut`: Card con mensaje + `<Button onClick={onRetryKyc}>Reintentar</Button>` en `:307`) | inspección de código (sin harness de componente — documentado en SDD §6, sin `@testing-library`/jsdom en el repo) |
| AC-9 | "Reintentar" ⇒ nueva verificación sin refrescar | PASS | `flow.tsx:230-234` (`onRetryKyc`: `setTimedOut(false); setError(null); resetTo(setStep, setRem, setPreview)` — sin `window.location.reload()` ni navegación); `resumedRef` (`:86-89`) sigue en `true` tras el mount inicial ⇒ el efecto de resume NO se re-dispara al volver a `send`; `resetTo` reusado tal cual (`flow.tsx:` def. existente, misma que usa `onNew` del Receipt) | inspección de código |

## Invariante del fix-pack (verificada explícitamente)

- **"Modo demo" en `done` sin duplicar**: banner de tope (`flow.tsx:283`) excluye `"done"` de su condición (`step === "review" || step === "track"` — nota: ya NO incluye `"done"`, a diferencia del wave plan original); el Receipt (`flow.tsx:614-618`) es el único emisor del indicador en `done`. Un solo Pill "Modo demo" visible en la pantalla final. Confirmado por lectura directa, no hay dos Pills simultáneos en el mismo step.
- **Mensaje de timeout no duplicado**: `flow.tsx:130` — comentario explícito `// La card de timedOut ya comunica el mensaje; no seteamos error para no duplicarlo (MENOR-A)`; el branch de timeout (`:126-131`) NO llama `setError(...)` (a diferencia del wave-plan original del SDD que sí lo hacía) — el mensaje vive solo en la Card `timedOut` (`:300-306`). Confirmado: cero llamada a `setError` en ese branch.

## CDs (9/9 respetadas)

| CD | Check | Resultado |
|---|---|---|
| CD-1 (solo chaski-v2) | `git status` — todos los archivos modificados/nuevos están bajo `chaski-v2/src` o `chaski-v2/doc`; ningún otro repo tocado | OK |
| CD-2 (no `api/**`/DiditKycGateway) | `git diff --name-only` no incluye `src/app/api/**` ni `src/infrastructure/didit/kyc-gateway.ts` | OK |
| CD-3 (provenance, sin flags) | `isDemoMode` lee solo `provenance` (ver AC-6) | OK |
| CD-4 (gateways.ts intacto) | `git diff --stat src/infrastructure/fallback/gateways.ts` → sin cambios; `FallbackPayoutGateway.status()` sigue devolviendo `deliveredPen:null` (leído en `gateways.ts:104-111`) | OK |
| CD-5 (único cambio de dominio = `markSettled`) | `git diff src/domain/remittance.ts` → único hunk es el tipo del parámetro en `:176`; `TRANSITIONS` intacto (no se agregó `kyc_pending→kyc_pending`) | OK |
| CD-6 (clear vía `abandonPendingKyc`, sin import directo de store en presentación) | `grep -n "LocalKycPendingStore\|KycPendingStore" src/presentation/flow.tsx` → sin matches; único punto de clear es `c.abandonPendingKyc.execute()` | OK |
| CD-7 (indicador solo vía `isDemoMode`) | Confirmado en AC-4/5/6 — sin duplicación de lógica de detección en `flow.tsx` | OK |
| CD-8 (happy-path del demo sigue mostrando monto real, no "—") | `FallbackQuoteGateway.requestQuote()` (`gateways.ts:44-56`) siempre devuelve `receive: Money.of(...)` real (no cero); `deliveredDisplay` cae a `quote.receive` cuando `deliveredPen` es null (comportamiento del demo) ⇒ Receipt del demo muestra el monto cotizado, nunca "—" | OK |
| CD-9 (sin `deliveredPen` no-null "por las dudas" en fakes) | `FakePayoutGateway` default sin editar (`test-support/fakes.ts`); el test AC-1(b) inyecta `deliveredPen:null` vía `statusResult`, no toca el default | OK |

## Drift detection

- **Scope**: `git status --porcelain -uall` — modificados: `use-cases.test.ts`, `confirm-and-send.ts`, `track-remittance.ts`, `container.ts`, `remittance.ts`, `flow.tsx`, `ui.tsx` (+ `tsconfig.tsbuildinfo`, artefacto de build, no código). Nuevos: `abandon-pending-kyc.ts`, `abandon-pending-kyc.test.ts`, `flow-vm.ts`, `flow-vm.test.ts`. **Exactamente** el Scope IN de la Story File (§2, filas 1-10). Cero archivos fuera de scope.
- **Spec drift**: 2 divergencias menores respecto al wave-plan original del SDD, ambas del fix-pack post-AR/CR (MENORs resueltos), documentadas arriba en "Invariante del fix-pack": (1) banner de tope ya no incluye `step==="done"` (evita duplicar con el Pill del Receipt); (2) branch de timeout ya no llama `setError` (evita duplicar el mensaje con la Card `timedOut`). Ambas mejoran la UX sin tocar ningún AC — no son regresiones.
- **Test drift**: los tests de `flow-vm.test.ts` y `use-cases.test.ts`/`abandon-pending-kyc.test.ts` mapean 1:1 con los ACs del §7 de la Story File. Ninguno fue modificado para "hacerlo pasar" — corresponden al plan original.

## Gates — no re-ejecutados por CR (sin cr-report.md en disco; corridos por QA directamente, ver arriba)

- typecheck/tests/build: PASS (ejecutados por mí, salida real arriba)

## AR/CR follow-up

- Task indica AR+CR aprobados con 0 BLOQUEANTES + fix-pack de 2 MENORs aplicado. No hay `ar-report.md`/`cr-report.md` en disco (`doc/sdd/001-wkh-178-demo-safe-fixes/` solo contiene `sdd.md`/`story-file.md`/`work-item.md`); el fix-pack se verificó por inspección directa del código (ver "Invariante del fix-pack" arriba) — ambos MENORs están efectivamente resueltos en el working tree actual.

**Listo para DONE.**
