# AR Report — WKH-188: Escape visible + timeout 20 s en el resume de KYC

> Adversary Review (F3 → AR) · nexus-adversary · 2026-07-12
> Input: story-HU-188.md + sdd.md + `git diff` (src/presentation/flow.tsx, flow.test.tsx)
> Estado verificado por mí: `tsc --noEmit` verde · `vitest run` 240/240 verde (25 files)

---

## Veredicto global

**RECHAZADO — 1 BLOQUEANTE (BLQ-MED-1).**

El fix cumple AC-1, AC-2 (en el caso testeado), AC-4, AC-5 y AC-6, no toca el gate de
compliance ni la autoridad server-side, respeta CD-1/CD-3/CD-4. Pero AC-3 ("detener el
loop inmediatamente y devolver a un estado utilizable") tiene una ventana de carrera no
cubierta: el escape sólo es consciente del cancel en 2 de los 3 puntos de suspensión async
del loop. Falta el check tras `await c.resumeKyc.execute()`.

---

## BLQ-MED-1 — Race: escape durante un `resumeKyc.execute()` en vuelo re-cuelga el overlay

- **Categoría**: Data Integrity (race condition) / Error Handling
- **Archivo:línea**: `src/presentation/flow.tsx:106-124` (falta guard entre L110 y L120)
- **AC afectado**: AC-3 (y por extensión el objetivo central de la HU: no quedar "colgado")

### Qué está mal
El loop chequea `cancelledRef.current` en 2 puntos: al tope de la iteración (L107) y justo
tras `await sleep(...)` (L122). Pero **NO** lo chequea inmediatamente después de que
`res = await c.resumeKyc.execute()` (L110) resuelve. Ese `await` es un tercer punto de
suspensión donde el usuario puede clickear el escape mientras el fetch está en vuelo.

CD-CANCEL (story §4 / SDD §7) sólo especificó "al inicio de cada iteración Y tras cada
`await sleep(...)`" — omitió el `await` de `resumeKyc.execute()`. El Dev siguió la spec al
pie de la letra; el hueco es de la spec, pero el bug es real y observable.

### Reproducción (escenario de ataque concreto)
Contexto: sesión de Didit abandonada → `resumeKyc.execute()` siempre devuelve `processing`.
El botón de escape aparece a los 5 s. El loop alterna `execute()` (~200-1500 ms en móvil) y
`sleep(2500)`. La fracción de tiempo en `execute()` es ~X/(X+2500) ≈ 15-25% por poll.

1. Usuario abandona Didit, vuelve → overlay `resuming`, loop poletea.
2. A los 5 s aparece "Empezar de nuevo".
3. Usuario clickea el escape **mientras `c.resumeKyc.execute()` está en vuelo** (no durante
   el `sleep`).
4. `onCancelResume` corre: `cancelledRef=true`, `abandonPendingKyc`, `setResuming(false)`,
   `resetTo → step="send"`. La UI muestra "send" por un instante.
5. `resumeKyc.execute()` resuelve `{kind:"processing"}`. `alive` sigue `true` (resetTo NO
   desmonta el componente). Se entra a la rama `processing` (L119):
   - **`setResuming(true)`** (L120) → el overlay "Verificando tu identidad…" **re-aparece
     encima de "send"**.
   - `await sleep(2500)` (L121).
   - L122: `cancelledRef` es `true` → `return`. El loop termina **sin** volver a llamar
     `setResuming(false)`.
6. **Estado final: `resuming = true`, `step = "send"` → overlay STUCK.** Nada más resetea
   `resuming`. Es exactamente el bug que la HU vino a matar, reintroducido en la ventana de
   carrera.

Variante `failed`: si `execute()` resuelve `{kind:"failed"}` tras el cancel, corre L148-152
(`setStep("verify")` + `setError`) → yankea al usuario a `verify` en vez de a `send`
(override silencioso del escape; menos grave porque `verify` sí es usable).

Variante `passed`: si resuelve `passed`, va a `confirm` con un snapshot KYC-aprobado real →
NO es bypass del gate (KYC pasó de verdad), es comportamiento legítimo. Sin hallazgo acá.

### Output esperado vs real
- **Esperado (AC-3)**: tras el escape, el usuario queda en `send`, loop detenido, sin overlay.
- **Real (ventana ~15-25% por poll)**: el overlay `resuming` re-aparece y queda **permanente**;
  el usuario debe esperar otros 5 s a que reaparezca el botón y clickear **una segunda vez**
  para escapar de verdad.

### Por qué los tests no lo cazan
En `flow.test.tsx` el mock `resumeKyc.execute = async () => ({kind:"processing"})` resuelve en
un microtask: bajo fake timers el loop siempre está parkeado en `sleep(2500)` cuando llega el
click de T-ESC2/T-ESC3, nunca en `execute()`. La carrera es invisible al harness → falso
"verde". (Test Coverage: falta un test con `execute` que quede pendiente cruzando el click.)

### Impacto
Reintroduce el "app colgada" que motivó la HU, en el escenario real de móvil con red lenta
(la más propensa al abandono). Recuperable con un 2º click a los 5 s, pero rompe la promesa de
AC-3 ("estado utilizable inmediato"). No hay data loss ni bypass de compliance.

### Sugerencia (no implementar — para el Dev)
Agregar un tercer check de cancel inmediatamente después de que `execute()` resuelve, antes
de tocar `resuming`/navegar. Conceptualmente, tras L110/L114:
`if (cancelledRef.current) return;` (antes de las ramas `none/processing/passed/failed`).
Actualizar CD-CANCEL para incluir "tras cada `await`" (no sólo tras `sleep`). Agregar un test
donde `resumeKyc` devuelva una promesa controlada que resuelva DESPUÉS del click del escape,
y assertear que `resuming` queda `false` y el usuario en `send`.

---

## Categorías — resumen

| # | Categoría | Resultado |
|---|-----------|-----------|
| 1 | Security | OK — sin injection/secrets/authz nuevos. El escape es puro estado React (CD-JSDOM: no toca `window.location`). |
| 2 | Error Handling | **BLQ-MED-1** (race deja overlay stuck) + `abandonPendingKyc` en try/catch correcto (CD-2). |
| 3 | Data Integrity | **BLQ-MED-1** (cancelledRef no cubre el `await execute()`). Pending se limpia antes de navegar; sin remesa huérfana persistente (resumedRef evita re-loop en el mismo mount). |
| 4 | Performance | OK — timeout total baja 100 s→20 s; sin N+1 ni leaks. Timer del escape con `clearTimeout` en cleanup (L176). |
| 5 | Integration | OK — WKH-178 (`timedOut`/Reintentar) preservado (T-ESC5 verde 20 s). `remittance.ts`/`confirm-and-send.ts`/`decision.ts` byte-idénticos (fuera del diff). |
| 6 | Type Safety | OK — `as unknown as ResumeKyc` sólo en tests (stubs de use-case, patrón existente). `tsc --noEmit` verde. Sin `any` en prod. |
| 7 | Test Coverage | MENOR — 6 tests T-ESC1..6 verdes, pero NINGUNO ejercita el `execute()` en vuelo cruzando el click (raíz de BLQ-MED-1). Ver MNR-1. |
| 8 | Scope Drift | OK — Dev tocó sólo `flow.tsx` + `flow.test.tsx`. `_INDEX.md`/`project-context.md` son artefactos F0/F1 del analyst, `tsconfig.tsbuildinfo` es build output. CD-4 respetado. |
| 9 | Destructive Migrations | N/A — sin SQL/schema; sólo `localStorage` vía `abandonPendingKyc` (sin cambios). |
| 10 | RPC SECURITY DEFINER | N/A — sin funciones postgres/RPC en el diff. |
| 11 | Cache Invalidation | N/A — sin capa de cache nueva (React Query/SWR/Redis) tocada. `showResumeEscape` es estado UI efímero, no cache de datos. |

---

## MENORES

### MNR-1 — Test coverage: falta el test de la carrera execute-en-vuelo
- **Categoría**: Test Coverage
- **Archivo:línea**: `src/presentation/flow.test.tsx:317-403` (T-ESC2/T-ESC3)
- Los stubs resuelven en microtask → el loop nunca está en `execute()` al click. La suite da
  verde pese a BLQ-MED-1. Sugerencia: test con promesa diferida (resolver `processing` tras el
  click) asserteando `resuming=false` + `send`. (Se resuelve junto con el fix de BLQ-MED-1.)

### MNR-2 — `cancelledRef` nunca se resetea a `false`
- **Categoría**: Data Integrity (menor)
- **Archivo:línea**: `src/presentation/flow.tsx:78`, `276`
- `onCancelResume` deja `cancelledRef.current=true` para siempre. Hoy inocuo: `resumedRef`
  (L100-103) impide que el resume-loop vuelva a correr en el mismo mount, y un reload real crea
  refs frescos. Pero es un footgun latente si algún día el loop pudiera re-armarse en el mismo
  mount. No bloquea. NO cambia comportamiento actual.

---

## Vectores atacados y descartados (sin hallazgo)

- **Bypass del gate KYC (crítico)**: `resetTo` pone `rem=null`+`step="send"` (anterior al gate).
  `onConfirm`/`confirmAndSend` y la autoridad server-side WKH-180 quedan intactos (fuera del
  diff). La variante `passed`-tras-cancel navega a `confirm` **con KYC realmente aprobado** → no
  es bypass. **OK.**
- **Remesa huérfana**: `abandonPendingKyc.execute()` SIEMPRE corre antes de navegar (CD-2), en
  try/catch (CD-2). Si lanza, el reset corre igual y `resumedRef` evita re-loop → sin colgado
  persistente. **OK.**
- **Timer leak / StrictMode**: efecto del escape con `clearTimeout` en cleanup, dep `[resuming]`.
  El one-shot `resumedRef` (pre-existente WKH-178) evita doble-run del resume. **OK.**
- **Path feliz <5 s**: si `resumeKyc` resuelve terminal antes de 5 s, `resuming→false` dispara el
  cleanup del efecto y el botón nunca aparece (T-ESC6 lo prueba con `failed`). **OK.**
- **Timeout 20 s corta un KYC legítimo lento**: riesgo real acotado — si Didit sigue procesando a
  los 20 s, se llama `abandonPendingKyc` + `timedOut`/Reintentar; el KYC aprobado (si ya se guardó
  en kycStore) se recupera vía `passed` antes del timeout. Es una decisión de diseño DOCUMENTADA
  (CD-STD / DT-1, directiva del founder, rango estándar 15-30 s). Por regla de calibración #5
  (respetar decisiones documentadas) **no es finding**. Riesgo residual: un scan completado que
  Didit tarda >20 s en resolver fuerza re-scan; aceptado por diseño. **OK.**

---

## Orden de fix sugerido para el Dev
1. **BLQ-MED-1** (único bloqueante) — check de `cancelledRef` tras `await c.resumeKyc.execute()`.
2. MNR-1 — test de la carrera (validar el fix de BLQ-MED-1).
3. MNR-2 (opcional) — resetear `cancelledRef=false` en `resetTo`/`onRetryKyc` o documentar.

*AR generado por NexusAgil — nexus-adversary.*

---

# RE-AR (post fix-pack) — 2026-07-12

> 2ª pasada tras la corrección del Dev sobre BLQ-MED-1.
> Verificado por mí: `tsc --noEmit` verde · `vitest run` **241/241** verde (25 files; +1 = T-ESC7).

## Veredicto del re-AR: **APROBADO — 0 BLOQUEANTES**

### BLQ-MED-1 — RESUELTO ✅
- **Fix**: `src/presentation/flow.tsx:114-117`. Tras `res = await c.resumeKyc.execute()` (L110) y el
  `if (!alive) return;` (L114), se agregó `if (cancelledRef.current) return;` (L117) **antes** de
  mirar `res.kind`. El return corre sin tocar `setResuming`/navegar → el overlay no puede re-colgarse.
- **Cobertura de las 3 ventanas async del loop confirmada**:
  1. L107 — tope de iteración (antes de `execute()`).
  2. **L117 — tras `await execute()` (NUEVO, cierra BLQ-MED-1).**
  3. L125 — tras `await sleep(...)`.
- **Sin 2do vector de la misma race**:
  - El bloque de timeout final (L158-163) sólo se alcanza completando las 8 iteraciones sin return;
    cualquier cancel retorna temprano en L107/L117/L125. Entre L125 y L158 **no hay `await`** (código
    síncrono) → el click no puede interleavear → el timeout **no puede** correr tras un cancel.
  - La ventana `await c.lockQuote.execute()` (L138, rama `passed`) sólo se alcanza si NO hubo cancel
    en L117 y con KYC realmente aprobado; `resuming` ya es `false` (L128) → sin overlay stuck ni
    bypass del gate. Benigno, no rompe AC-3. No es finding.

### MNR-1 — RESUELTO ✅
- **T-ESC7** (`flow.test.tsx:505-569`): guardián genuino, NO tautológico. Usa promesas diferidas
  (`pendingResolvers`) para mantener `execute()` en vuelo cruzando el click; assertea
  `pendingResolvers.length===2` (el 2do execute está genuinamente sin resolver al momento del click);
  resuelve ese execute como `processing` DESPUÉS del cancel y verifica que el overlay
  ("Verificando tu identidad…") NO reaparece y que sigue en `send`. Sin el guard L117, esa resolución
  tardía dispararía `setResuming(true)` → RED. Confirmado el fallo-sin-guard por diseño del test.

### MNR-2 — sigue MENOR (no bloqueante)
- `cancelledRef` no se resetea a `false` en `resetTo`/`onRetryKyc` (`flow.tsx:78`, `276`). Inocuo hoy
  por el guard `resumedRef` (el loop no re-arma en el mismo mount) y refs frescos en reload real.
  Footgun latente. No bloquea DONE.

### Regresiones
- Ninguna. Suite completa 241/241 verde, tsc limpio. Los 17 tests previos siguen verdes; el path
  WKH-178 (`timedOut`/Reintentar a 20 s, T-ESC5) y AC-6 (`failed`, T-ESC6) intactos.

## Conclusión
Todas las categorías OK. **APROBADO para avanzar a CR/F4.** Queda MNR-2 como deuda menor opcional.

*Re-AR generado por NexusAgil — nexus-adversary.*
