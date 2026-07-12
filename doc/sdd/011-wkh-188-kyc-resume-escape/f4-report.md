# F4 Report — WKH-188: Escape visible + timeout 20 s en el resume de KYC

> Rol: nexus-qa (F4 — Drift Detection + AC Verification con evidencia).
> Fecha: 2026-07-12 · Branch: working tree sobre `main` (sin commitear aún) · QA: nexus-qa
> Input: work-item.md + sdd.md + story-HU-188.md + ar-report.md (RE-AR APROBADO, 0 BLQ) +
> cr-report.md (APROBADO, 3 MENORes) + `git diff` (flow.tsx + flow.test.tsx)

## Veredicto global: **APROBADO PARA DONE**

Corrí yo mismo (no confié en reportes previos) `npx tsc --noEmit`, `npm run test` (vitest) y
`npm run build`. Los 6 ACs del work-item + el AC-6 (no-regresión) están PASS con evidencia
archivo:línea. El NEEDS CLARIFICATION de Didit queda correctamente DEFERIDO (fuera de scope,
documentado). Drift: 1 hallazgo MENOR (ya señalado por CR, no bloqueante) — `tsconfig.tsbuildinfo`
modificado en el working tree, fuera del Scope IN de la Story File.

---

## 1. Gates (ejecutados por mí, no solo leídos)

| Gate | Comando | Resultado |
|------|---------|-----------|
| Typecheck | `npx tsc --noEmit` | ✅ exit 0, "TypeScript compilation completed" |
| Test suite | `npm run test` (vitest run) | ✅ **241/241 passed**, 25 files. `flow.test.tsx`: 18 tests (incluye T-ESC1..T-ESC7) |
| Build | `npm run build` (next build --webpack) | ✅ "Compiled successfully", TypeScript del build OK, 8 páginas generadas, sin errores |

Coincide exactamente con lo reportado por AR (re-AR: 241/241) y CR (240/240 pre-fix-pack + 1 =
241 post T-ESC7). Confirmado de forma independiente, no solo leído.

---

## 2. AC Verification (con evidencia archivo:línea)

| AC | Texto (resumen EARS) | Status | Evidencia |
|----|----|--------|-----------|
| **AC-1** | Escape visible ANTES del timeout completo, ventana corta (segundos) | ✅ PASS | Constante `RESUME_ESCAPE_DELAY_MS = 5000` en `src/presentation/flow.tsx:52`. Render condicional del botón: `{showResumeEscape ? (...) : null}` dentro del overlay `resuming`, `flow.tsx:417-423` (botón `Empezar de nuevo` en L419). Timer que arma el flag: `useEffect` en `flow.tsx:173-180` (`setTimeout(() => setShowResumeEscape(true), RESUME_ESCAPE_DELAY_MS)`, L178). Test: `flow.test.tsx:346-367` (`T-ESC1`) — a ~4 s botón `null` (L359) + overlay visible (L360); a ~7 s botón presente (L366). Corrí la suite yo mismo: PASS. |
| **AC-2** | Escape llama `abandonPendingKyc.execute()` y devuelve a estado usable (`send`) | ✅ PASS | Handler `onCancelResume`, `flow.tsx:279-289`: `await c.abandonPendingKyc.execute()` en L282 (try/catch best-effort, L281-285) **antes** de `resetTo(setStep, setRem, setPreview)` en L288 (→ `send`, CD-2 cumplido). Test: `flow.test.tsx:370-384` (`T-ESC2`) — `abandonSpy` llamado 1× (L380) + `getByLabelText("Monto en dólares")` visible (L382, paso `send`) + overlay ausente (L383). |
| **AC-3** | Escape detiene el loop inmediatamente (sin más `resumeKyc.execute()`) y no re-cuelga en ningún punto de suspensión | ✅ PASS | Las 3 ventanas async del loop cubiertas por `cancelledRef`: (a) tope de iteración `flow.tsx:107`, (b) tras `await c.resumeKyc.execute()` **`flow.tsx:117`** (fix del BLQ-MED-1 del AR — el guard que faltaba en la 1ª pasada), (c) tras `await sleep(...)` **`flow.tsx:125`**. Tests: `T-ESC3` (`flow.test.tsx:387-403`) — `resumeSpy.mock.calls.length` no cambia tras 20 s post-click (L401); `T-ESC7` (`flow.test.tsx:510-569`) — regresión específica del race BLQ-MED-1: `execute()` en vuelo con promesa diferida que resuelve DESPUÉS del click (L534/556), assertea que el overlay NO reaparece (L566) ni queda el botón stale (L567), y que sigue en `send` (L568). Este test queda ROJO sin el guard de L117 (confirmado por el diseño documentado en `ar-report.md:184-190` y `auto-blindaje.md:23-41`) — es un guardián real, no tautológico. |
| **AC-4** | El escape NO abre camino a `confirm`/envío sin KYC aprobado — gate de compliance intacto | ✅ PASS | Diff confirma que `src/domain/remittance.ts`, `src/application/use-cases/resume-kyc.ts`, `src/application/use-cases/abandon-pending-kyc.ts`, `src/infrastructure/didit/decision.ts`, `src/infrastructure/payout/*` y `confirm-and-send.ts` **NO aparecen** en `git diff --name-only HEAD` (verificado por mí: comando devuelve solo `doc/sdd/_INDEX.md`, `src/presentation/flow.test.tsx`, `src/presentation/flow.tsx`, `tsconfig.tsbuildinfo`). `onCancelResume` navega a `send` (`resetTo`, `flow.tsx:288`), paso ANTERIOR al gate `confirm` — nunca lo saltea (CD-1). Test: `T-ESC4` (`flow.test.tsx:406-418`) — `queryByRole("button",{name:/Confirmar y enviar/})` null (L415), `queryByText(/Identidad verificada/)` null (L416), sigue en `send` (L417). |
| **AC-5** | Timeout total acortado a ~20-30s (fijado en 20s por Story File), preservando el comportamiento `timedOut`/"Reintentar" de WKH-178 | ✅ PASS | Constantes `RESUME_POLL_INTERVAL_MS = 2500` (`flow.tsx:53`) y `RESUME_MAX_POLLS = 8` (`flow.tsx:54`) → 8×2500 = 20 000 ms exactos. Loop usa las constantes, no números mágicos: `for (let i = 0; i < RESUME_MAX_POLLS; i++)` (`flow.tsx:106`), `await sleep(RESUME_POLL_INTERVAL_MS)` (`flow.tsx:124`). Bloque de timeout preservado: `abandonPendingKyc.execute()` + `setTimedOut(true)` en `flow.tsx:158-163`. Test: `T-ESC5` (`flow.test.tsx:421-476`) — **incluye la aserción de borde inferior del MENOR-1 del CR**: a los 15 s `queryByText("Reintentar")` es `null` (L437-440, "MENOR-1 (CR): borde inferior — ANTES de los 20 s el timeout NO debe dispararse"), a los 20 s "Reintentar" visible + `abandonSpy` llamado (L448-449), y el retry NO recarga la página (spy de `window.location.reload`, L453-475). Confirmé con `grep` que no quedan residuos de `40`/`100_000`/`100000` fuera de las constantes nombradas. |
| **AC-6** (no-regresión, rama `failed`) | `ResumeKyc` devuelve `{kind:"failed"}` (incl. Abandoned/Expired ya terminales en `decision.ts:26`) → sale de `resuming` en el primer poll, sin regresión | ✅ PASS | Rama `else`/`failed` intacta en `flow.tsx:151-155` (`setRem`, `setStep("verify")`, `setError(...)`) — NO tocada por el diff (fuera de las líneas modificadas del loop). Test: `T-ESC6` (`flow.test.tsx:479-503`) — con `resumeKyc` devolviendo `failed` en el primer poll, aterriza en `verify` sin sleep (L493-496) y el botón de escape NUNCA aparece incluso tras +6 s (`queryByRole` null, L502). |
| **Fail-fast Didit (NEEDS CLARIFICATION, work-item.md:44-57, 165-172)** | ¿Debe el fix hacer fail-fast si Didit marca `Abandoned`/`Expired` sincrónicamente? | ⚪ DEFERIDO por diseño (no bloqueante) | `src/infrastructure/didit/decision.ts:26` ya trata `"Abandoned"`, `"Expired"`, `"Kyc Expired"` como terminales (`TERMINAL` set) — si Didit alguna vez reporta esos estados sincrónicamente, el sistema YA sale por la rama `failed` cubierta por AC-6/T-ESC6, sin cambios necesarios en esta HU. El work-item (L165-172) documenta explícitamente que la confirmación de si Didit transiciona el `status` de forma síncrona es [NEEDS CLARIFICATION] NO bloqueante, y que "el escape button + timeout más corto (AC-1..AC-5) siguen siendo el fix completo y suficiente para el bug reportado". Story File (§9 Readiness Check, L310) confirma "Sin [NEEDS CLARIFICATION] bloqueante". Correctamente fuera de Scope IN (work-item.md:116-119, CD-3/Story File). Marco esto **PASS por diseño / DEFERIDO** — no es un AC formal de esta HU, es un hallazgo de F0 correctamente acotado. |

**6/6 ACs formales: PASS. 0 FAIL. 0 NO VERIFICABLE.**

---

## 3. Drift Detection

- **Scope IN vs archivos tocados**: Story File §2 limita a `src/presentation/flow.tsx` +
  `src/presentation/flow.test.tsx`. `git diff --name-only HEAD` (corrido por mí) devuelve:
  `doc/sdd/_INDEX.md` (esperado, artefacto de pipeline docs — no código), `src/presentation/flow.tsx`,
  `src/presentation/flow.test.tsx` (ambos en Scope IN), y **`tsconfig.tsbuildinfo`** (fuera de Scope
  IN — ya señalado por CR como **MENOR-3**, artefacto de build cache, impacto funcional nulo, no
  bloquea DONE; recomiendo no stagearlo / gitignorearlo antes del commit final).
- **Scope OUT respetado**: confirmé con `git diff --name-only HEAD -- <archivos de Scope OUT>` que
  `remittance.ts`, `resume-kyc.ts`, `abandon-pending-kyc.ts`, `decision.ts`,
  `src/infrastructure/payout/` devuelven diff vacío — byte-idénticos, CD-1/CD-3 cumplidos.
- **Wave order**: commits del Dev no están aún separados (working tree único), pero el diff es
  consistente con W0 (constantes L52-54) → W1 (estado/ref L77-78, efecto timer L170-180, loop
  L106-125, handler L279-289, botón L417-423) → W2 (suite verde) tal como especifica la Story File
  §5. Sin violación de orden observable.
- **Spec drift (spot-check)**: el mecanismo implementado (`setTimeout` en `useEffect([resuming])` +
  `cancelledRef` chequeado en 3 puntos + `onCancelResume` con abandon-antes-de-navegar) coincide
  exactamente con W1.2/W1.3/W1.4 de la Story File (L136-189). Único desvío respecto a la Story File
  original (L153-169, que solo especificaba 2 checks de `cancelledRef`) es el fix-pack post-AR que
  agregó el 3er check en `flow.tsx:117` — desvío DOCUMENTADO (AR BLQ-MED-1 + `auto-blindaje.md:23-41`),
  no es drift no documentado.
- **Test drift**: los 7 tests (T-ESC1..T-ESC7) mapean 1:1 a los ACs correspondientes (tabla §2). El
  bloque T3 original (100_000ms) fue correctamente reemplazado por T-ESC5 (20_000ms) — confirmé con
  `grep -n "100_000\|100000"` sobre `flow.test.tsx` y `flow.tsx`: 0 hits fuera de comentarios
  explicativos.
- **Auto-blindaje documentado**: `doc/sdd/011-wkh-188-kyc-resume-escape/auto-blindaje.md` presente y
  cubre 3 hallazgos: (1) anclaje del timer bajo fake-timers (patrón `armEscape`, `flow.test.tsx:336-343`),
  (2) el fix del BLQ-MED-1 (3er punto de suspensión), (3) footguns latentes documentados (MNR-2 AR,
  MENOR-2 CR) — no bugs hoy. Verificado presente y consistente con el código real.

**Drift: 1 hallazgo menor (tsconfig.tsbuildinfo fuera de scope, no bloqueante), resto limpio.**

---

## 4. Gate Confirmation (AR/CR, leído — no re-ejecutado salvo lo indicado en §1)

- AR (1ª pasada): RECHAZADO — 1 BLOQUEANTE (BLQ-MED-1, race en el 3er punto de suspensión del loop).
- Fix-pack del Dev: agregado el guard en `flow.tsx:117` + test de regresión T-ESC7.
- Re-AR: **APROBADO — 0 BLOQUEANTES**. `tsc --noEmit` verde, `vitest run` 241/241 (confirmado por mí
  de forma independiente en §1, mismo número exacto).
- CR: **APROBADO con 3 MENORes** (MENOR-1 test-coverage borde inferior de T-ESC5 — **ya resuelto**,
  la aserción a los 15s está presente en `flow.test.tsx:436-440`, confirmé el código real; MENOR-2
  fragilidad de `armEscape` — documentada, aceptada como TD; MENOR-3 `tsconfig.tsbuildinfo` — ver
  Drift §3, no bloquea).
- **0 BLQ pendientes. Los 3 MENORes son aceptados como deuda técnica documentada, ninguno bloquea DONE.**

---

## 5. Runtime/Integration checks

Esta HU es puramente de UI/timing en React (`flow.tsx`), sin DB, sin env vars nuevas, sin
migrations, sin deployment target tocado. No aplica DB State Verification / Env Vars Parity /
Migration Apply Verification (N/A por naturaleza de la HU — confirmado revisando Scope IN/OUT del
work-item, no hay tocado a `supabase/`, `.env*`, ni servicios externos más allá del `abandonPendingKyc`
ya existente sobre `localStorage`).

### Smoke manual (para el operador, opcional, HU user-facing)
```
1. Iniciar un KYC de Didit desde Chaski en un dispositivo móvil.
2. Dar "atrás" en el navegador ANTES de completar el escaneo (simula abandono).
3. Volver a la pestaña de Chaski (redirect same-tab).
4. Confirmar que el overlay "Verificando tu identidad…" aparece.
5. Esperar ~5 s → confirmar que aparece el botón "Empezar de nuevo".
6. Clickear el botón → confirmar que la app vuelve al paso "Enviar" (monto en dólares editable),
   sin overlay colgado.
7. (Alternativo) NO clickear nada → esperar 20 s → confirmar que aparece "Reintentar" en vez de
   quedar colgado indefinidamente.
```

---

## 6. Conclusión

APROBADO PARA DONE. 6/6 ACs con evidencia archivo:línea + tests que corrí yo mismo (241/241),
typecheck limpio, build OK. AR (0 BLQ post fix-pack) y CR (0 BLQ, 3 MENORes documentados) sin
pendientes bloqueantes. Único hallazgo de drift (`tsconfig.tsbuildinfo` fuera de scope) es
cosmético — recomiendo excluirlo del commit final pero no bloquea el pipeline.

*F4 Report generado por NexusAgil — nexus-qa.*
