# CR Report — WKH-188: Escape visible + timeout 20 s en el resume de KYC

> Rol: nexus-adversary (Code Review — calidad/patrones).
> Fecha: 2026-07-12 · Branch: main (diff sin commitear) · Reviewer: nexus-adversary
> Input: story-HU-188.md + sdd.md + `git diff` (flow.tsx + flow.test.tsx)

## Resultado de la suite (corrida propia)
- `npm run qa` (typecheck + vitest): **VERDE**.
- `tsc --noEmit`: sin errores.
- Vitest: **240 tests / 240 passed**, 25 files. `flow.test.tsx`: **17 tests** (incluye T-ESC1..T-ESC6).
- Sin residuos del timing viejo: `grep 100_000|100000` en tests = 0 hits; `grep 40|2500|100000` en flow.tsx = solo las constantes nombradas (L53-54). CD-SUITE / CD-6 cumplidos.

---

## 1. Fidelidad al SDD / Story File — OK
- Constantes exactas y nombradas a nivel módulo (`flow.tsx:52-54`): `RESUME_ESCAPE_DELAY_MS=5000`, `RESUME_POLL_INTERVAL_MS=2500`, `RESUME_MAX_POLLS=8`. Cero magic numbers inline en el loop (CD-STD OK).
- Mecanismo idéntico al diseñado: `setTimeout(RESUME_ESCAPE_DELAY_MS) → setShowResumeEscape(true)` gated en `[resuming]` (`flow.tsx:170-177`); `cancelledRef` (`flow.tsx:76`) chequeado al top de iteración (`flow.tsx:107`) y post-sleep (`flow.tsx:122`); handler `onCancelResume` con abandon-antes-de-navegar (`flow.tsx:276-286`).
- Loop: `for (i < RESUME_MAX_POLLS)` (`flow.tsx:106`), `await sleep(RESUME_POLL_INTERVAL_MS)` (`flow.tsx:121`). Ramas `none/passed/failed` y bloque de timeout intactos.
- Scope: solo `flow.tsx` + `flow.test.tsx` como source. Domain/gate/use-cases NO tocados (verificado por `git diff --name-only`). CD-1/CD-3/CD-4/CD-NOREG OK.

## 2. Calidad de los tests — OK (con 2 MENOR)
- **T-ESC1** (AC-1): brackets genuinos del umbral — a ~4 s botón `null` + overlay visible; a ~7 s botón presente. Sensible al valor: si el delay fuera 50 s, a 7 s seguiría `null` → falla. No tautológico.
- **T-ESC2** (AC-2): `abandonSpy` 1× + aterriza en `send` (`getByLabelText("Monto en dólares")`) + overlay ausente. Sólido.
- **T-ESC3** (AC-3): captura `n` de `resumeSpy`, click, avanza 20 s, `toBe(n)`. Verifica de verdad que el loop se detiene. Sólido.
- **T-ESC4** (AC-4): ausencia de `/Confirmar y enviar/` y `/Identidad verificada/` + `send`. Verifica ausencia de camino al gate en el estado post-escape. Adecuado.
- **T-ESC5** (AC-5): avanza exactamente 20_000 ms → `Reintentar` + `abandonSpy` llamado + retry no recarga. Guarda contra reinstaurar `40` (a 20 s con 40 polls no habría timedOut → getByText tira). Ver MENOR-1.
- **T-ESC6** (AC-6): `failed` inmediato → `verify` + "La verificación no pasó"; escape nunca aparece tras +6 s. Sólido, no-regresión real.
- El patrón `advanceTimersByTimeAsync(1)` (anclaje) NO es tautológico: las aserciones dependen del comportamiento real del componente, no del setup. Ver MENOR-2 por fragilidad.

## 3. Legibilidad / mantenibilidad — OK
- Nombres claros; comentarios citan AC/CD. Copy sin em dashes, rioplatense: `¿No completaste la verificación?` + `Empezar de nuevo` (`flow.tsx:417-419`), coincide con el Story File §5 (el Dev siguió su contrato; la variante de microcopy del SDD §6.6 era ajustable en gate).
- `variant="outline"` del botón de escape es consistente con usos existentes (`flow.tsx:687`, `flow.tsx:790`); variante válida en `ui.tsx:33`.
- Sin dead code ni magic numbers residuales.

## 4. Manejo de errores — OK
- `onCancelResume` envuelve `abandonPendingKyc.execute()` en `try/catch` best-effort (`flow.tsx:278-282`), patrón idéntico a `forgetAndDisconnect`; el reset de estado corre igual si lanza (CD-2 OK).
- Cleanup del timer del escape vía `clearTimeout` en el return del effect (`flow.tsx:176`); al caer `resuming` se resetea `showResumeEscape` (`flow.tsx:171-173`) → el botón nunca queda stale.

## 5. Consistencia con el resto de flow.tsx — OK
- Overlay reusa `<Card>`/`<Button>` existentes; el escape sigue el estilo del bloque `resuming`/`timedOut`. `onCancelResume` reusa `resetTo(setStep,setRem,setPreview)` igual que `onRetryKyc` (`flow.tsx:288-293`).

## 6. Regresiones sutiles — OK
- Los dos effects no colisionan: el de resume corre una vez (`resumedRef`), el de escape depende de `[resuming]`. Cuando `resuming` cae (terminal/timeout/cancel), el effect limpia timer + flag.
- `cancelledRef` no se resetea a `false`, pero el loop de resume corre una sola vez por mount (`resumedRef`) y el retorno de Didit es un reload same-tab (remonta → refs frescos). No hay re-entrada del loop en el mismo mount → no es bug. (No finding.)
- StrictMode dev-only: doble timer manejado por cleanup; suite verde.

---

## Hallazgos

### MENOR-1 — [Test Coverage] T-ESC5 acota el timeout de forma unilateral
- **Archivo:línea**: `flow.test.tsx:435-440`.
- **Descripción**: el test avanza 20_000 ms y exige `Reintentar` visible. Guarda contra un timeout MÁS largo (p.ej. reinstaurar 40 polls), pero NO contra uno más corto: con `RESUME_MAX_POLLS=4` (10 s) el test también pasaría (a 20 s ya estaría `timedOut`). No hay aserción de "aún NO timedOut" antes de los 20 s.
- **Impacto**: bajo. Un cambio accidental a un timeout más corto no sería detectado por este test (sí por CD-STD y el nombre de la constante).
- **Sugerencia**: agregar una aserción intermedia (p.ej. a ~19_000 ms: `queryByText("Reintentar")` es `null`) para fijar el borde inferior. No bloquea DONE.

### MENOR-2 — [Test Coverage] `armEscape` acoplado al flush interno de fake-timers de React
- **Archivo:línea**: `flow.test.tsx:336-343` (helper `armEscape`, anclaje `advanceTimersByTimeAsync(1)` + `6999`).
- **Descripción**: el patrón depende de que el flush del passive effect se ancle al final del primer chunk de `advanceTimersByTimeAsync` (documentado en el auto-blindaje). Es correcto y determinista hoy (suite verde), pero es frágil ante cambios de versión de React/vitest o del scheduler.
- **Impacto**: bajo. Riesgo de mantenibilidad, no de correctitud. Ya está documentado en comentarios.
- **Sugerencia**: dejar el comentario (ya está) y, si en el futuro se toca timing, re-verificar el anclaje. No bloquea DONE.

### MENOR-3 — [Scope Drift menor] `tsconfig.tsbuildinfo` staged
- **Archivo:línea**: `tsconfig.tsbuildinfo` (git status M).
- **Descripción**: artefacto generado por `tsc` incluido en el diff. Story §2 limita Scope IN a `flow.tsx` + `flow.test.tsx`. No es código fuente; es cache de build.
- **Impacto**: nulo funcional; ruido en el commit.
- **Sugerencia**: no stagear el `.tsbuildinfo` (o gitignorearlo). No bloquea DONE.

---

## Veredicto global: **APROBADO con MENORes**

- BLOQUEANTES: **0**.
- MENORes: **3** (MENOR-1 test unilateral, MENOR-2 fragilidad de fake-timers, MENOR-3 tsbuildinfo staged) — ninguno bloquea DONE; se documentan para backlog/decisión.
- Fidelidad al SDD/Story File: total. CD-STD / CD-1 / CD-2 / CD-3 / CD-4 / CD-NOREG / CD-CANCEL / CD-JSDOM / CD-SUITE: cumplidos.
- Suite propia: 240/240 verde, typecheck verde.

*CR generado por nexus-adversary — WKH-188.*
