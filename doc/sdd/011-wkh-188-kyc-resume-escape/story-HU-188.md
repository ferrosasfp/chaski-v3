# Story File — HU WKH-188: Escape visible + timeout de 20 s en el resume de KYC abandonado

> Contrato autocontenido para el Dev (F3). El Dev SOLO lee este archivo.
> Fuente: `sdd.md` (SPEC_APPROVED) + `work-item.md` en `doc/sdd/011-wkh-188-kyc-resume-escape/`.
> Tipo: bugfix (UX/timing en presentación) · Branch: `fix/188-kyc-resume-escape`

---

## 1. Contexto compacto (qué se construye y por qué)

Un usuario que arranca el KYC de Didit y vuelve a Chaski SIN completar el escaneo (dio "atrás"
en el navegador móvil) queda atrapado en el overlay `resuming` ("Verificando tu identidad…")
**sin ningún control interactivo durante ~100 s** (40 iteraciones × 2500 ms de poll). Una sesión
de Didit abandonada nunca se vuelve terminal vía polling, así que el usuario percibe la app como
colgada.

**El fix es puramente de UX/timing en `src/presentation/flow.tsx`** (más sus tests). NO se toca el
dominio, los use-cases, ni el gate de compliance. Dos cambios observables:

1. **Escape temprano**: a los **5 s** desde que `resuming` es `true`, aparece un botón de escape en
   el overlay. Al activarlo: limpia el pending (`abandonPendingKyc.execute()`), detiene el loop, y
   devuelve al usuario al paso `send` (estado usable).
2. **Timeout más corto**: el poll total baja de ~100 s (40×2500) a **20 s** (8×2500), preservando
   el comportamiento de WKH-178 al agotarse (abandon + estado `timedOut` con "Reintentar").

Los valores de timing NO son arbitrarios: están justificados contra el estándar de UX (NN/g límite
de atención 10 s; auto-poll post-redirect de verificadores hospedados 15–30 s). Ver CD-STD.

---

## 2. Scope IN (lista exhaustiva de archivos a tocar)

| Archivo | Acción |
|---------|--------|
| `src/presentation/flow.tsx` | Constantes de timing + estado `showResumeEscape` + ref `cancelledRef` + efecto del timer de escape + loop consciente del cancel + handler `onCancelResume` + botón condicional en el overlay `resuming`. |
| `src/presentation/flow.test.tsx` | 6 tests fake-timers (T-ESC1..T-ESC6). T-ESC5 **actualiza el bloque `T3` existente** (100_000 → 20_000). |

**PROHIBIDO tocar cualquier otro archivo.** En particular (Scope OUT, reusar sin cambios):
`src/domain/remittance.ts`, `src/application/use-cases/resume-kyc.ts`,
`src/application/use-cases/abandon-pending-kyc.ts`, `src/infrastructure/didit/decision.ts`,
`src/infrastructure/payout/*`, `confirm-and-send.ts`. Nada fuera de `chaski-v2/`.

---

## 3. Anti-Hallucination Checklist (verificá antes de codear)

- [ ] `sleep`, constantes de módulo y `SCAN_STEPS` viven cerca de `flow.tsx:40-47`. La nueva
      constante va ahí (nivel módulo), NO inline.
- [ ] El estado del flujo se declara en `flow.tsx:51-69` (`resuming` en L66, `timedOut` en L67).
- [ ] El efecto de resume es `flow.tsx:89-154`. El loop `for (let i = 0; i < 40; i++)` está en
      **L97**; la rama `processing` con `await sleep(2500)` en **L109-113** (sleep en L111); la rama
      `passed` en L115-136; la rama terminal `else`/`failed` en **L137-141** (NO tocar); el bloque de
      timeout (`setResuming(false)` + `abandonPendingKyc.execute()` + `setTimedOut(true)`) en
      **L144-149**; el cleanup `alive = false` en L151-153.
- [ ] `onRetryKyc` (exemplar de "volver a estado usable") está en **L252-256**; usa
      `resetTo(setStep, setRem, setPreview)`.
- [ ] `forgetAndDisconnect` (exemplar de `try/catch` best-effort sobre un use-case) está en
      **L260-279**.
- [ ] El overlay `resuming` (`<Card>` sin controles) está en **L369-378**; el estado `timedOut` con
      `<Button>Reintentar</Button>` en **L379-388**.
- [ ] `resetTo(...)` está definido en **L755-763** y navega a `send`.
- [ ] `<Button>`, `<Card>` se importan de `./ui` (ya en L19). Reusar; NO crear componentes.
- [ ] Ya existe un botón "Empezar de nuevo" en el header (`flow.tsx:331`, `forgetAndDisconnect`),
      pero SOLO se renderiza cuando `address && confirmReset`. Durante el resume `address` es `null`
      → NO hay colisión de `getByRole("button", {name:/Empezar de nuevo/})`.
- [ ] `buildTestContainer` (`src/test-support/test-container.ts:57-84`) acepta overrides a nivel
      use-case vía `useCases: Partial<Container>` — soporta `resumeKyc` y `abandonPendingKyc`.
- [ ] El bloque `T3` de tests fake-timers está en `flow.test.tsx:308-361`
      (`vi.useFakeTimers()` en L310, `advanceTimersByTimeAsync(100_000)` en L329, spy de
      `window.location.reload` reemplazando el objeto `location` entero en L337-359).
- [ ] `abandonPendingKyc.execute()` = `pending.clear()` (sin firma nueva, sin `ownerId`).
      `resumeKyc.execute()` devuelve `none|processing|passed|failed`.

---

## 4. Constraint Directives (inline — INVIOLABLES)

- **CD-STD**: los valores de timing SON los del estándar (§5.1 del SDD), como constantes NOMBRADAS:
  `RESUME_ESCAPE_DELAY_MS = 5000`, `RESUME_POLL_INTERVAL_MS = 2500`, `RESUME_MAX_POLLS = 8`
  (8×2500 = 20 s total). PROHIBIDO usar números mágicos inline o reinstaurar `40`/`100_000`/`6-8s`/
  `25-30s`.
- **CD-1 (COMPLIANCE, CRÍTICA)**: PROHIBIDO que el escape, directa o indirectamente, permita alcanzar
  `confirm`/`onConfirm`/envío sin `state.kyc.approved && state.kyc.payoutAllowed`. El escape devuelve
  a `send` (paso anterior al gate), NUNCA lo saltea.
- **CD-2**: el handler de escape SIEMPRE llama `abandonPendingKyc.execute()` **ANTES** de cambiar
  `step`/navegar (mismo patrón que el `timedOut` de L146). Envolver el `execute()` en `try/catch`
  (patrón `forgetAndDisconnect`, L260-266): si lanza, el reset de estado corre igual.
- **CD-3**: PROHIBIDO tocar `remittance.ts`, `confirm-and-send.ts`/`payout-authority-gateway.ts`,
  `decision.ts`, o la firma/lógica de `resume-kyc.ts` / `abandon-pending-kyc.ts`.
- **CD-4**: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/`.
- **CD-CANCEL (AC-3)**: el loop debe dejar de llamar `resumeKyc.execute()` tras el cancel: chequear
  `cancelledRef.current` **al inicio de cada iteración** Y **justo tras cada `await sleep(...)`**.
- **CD-JSDOM (auto-blindaje WKH-185)**: el escape NO usa `window.location` (es puro cambio de estado
  React). Si un test espía `window.location.reload`, reemplazar el objeto `location` entero y
  restaurarlo (NO `defineProperty` sobre la property) — ver el patrón de T3 en L337-359.
- **CD-NOREG (AC-6)**: NO tocar la rama `else`/`res.kind === "failed"` (L137-141). Sigue saliendo a
  `verify` en la primera respuesta terminal.
- **CD-SUITE (auto-blindaje WKH-187)**: al tocar timing/FSM, correr la suite COMPLETA (`npm run qa`).
  Cero tests rojos, cero tests validando el timeout viejo (100_000).
- NO refactorizar código adyacente ni "mejorar" nada fuera del fix. NO cambiar el intervalo de poll
  (2500 ms).

---

## 5. Waves con archivos exactos por wave

### Wave 0 (Serial Gate — constantes + tests que fallan primero)

**W0.1 — Constantes nombradas** · `src/presentation/flow.tsx`
Justo después de `const sleep = ...` (**L47**), agregar:

```ts
// WKH-188: timing del resume-loop de KYC, alineado al estándar de UX (SDD §5.1).
// Escape < límite de atención 10 s (NN/g); poll total 20 s dentro del rango 15-30 s de
// auto-poll post-redirect de verificadores hospedados.
const RESUME_ESCAPE_DELAY_MS = 5000;   // el escape aparece a los 5 s
const RESUME_POLL_INTERVAL_MS = 2500;  // intervalo de poll (sin cambio vs WKH-178)
const RESUME_MAX_POLLS = 8;            // 8 × 2500 ms = 20 s total (antes 40 = ~100 s)
```

Verificación: `npm run typecheck` (o `npx tsc --noEmit`) verde.

**W0.2 — Tests fake-timers (§7)** · `src/presentation/flow.test.tsx`
Escribir T-ESC1, T-ESC2, T-ESC3, T-ESC4, T-ESC6 nuevos + **actualizar** el bloque `T3` a T-ESC5.
Verificación: los tests nuevos FALLAN (rojo esperado pre-impl); T1/T2/T4/T5/T-AC* siguen verdes.

### Wave 1 (Implementación — depende de W0)

**W1.1 — Estado + ref** · `flow.tsx` (junto al bloque de estado, ~L66-69)

```ts
const [showResumeEscape, setShowResumeEscape] = useState(false); // WKH-188: botón de escape a los 5 s
const cancelledRef = useRef(false); // WKH-188: corta el resume-loop tras el escape
```

**W1.2 — Efecto del timer de escape** · `flow.tsx` (nuevo `useEffect`, inmediatamente DESPUÉS del
efecto de resume, ~tras L154)

```ts
// WKH-188: mientras el overlay `resuming` está visible, ofrecer un escape a los 5 s (AC-1).
// Time-based (no atado al conteo de iteraciones). Al caer `resuming` (terminal temprano o timeout),
// limpia el timer y resetea el flag → el botón nunca aparece indebido (AC-6).
useEffect(() => {
  if (!resuming) {
    setShowResumeEscape(false);
    return;
  }
  const t = setTimeout(() => setShowResumeEscape(true), RESUME_ESCAPE_DELAY_MS);
  return () => clearTimeout(t);
}, [resuming]);
```

**W1.3 — Loop consciente del cancel + constantes** · `flow.tsx:97-113`

- Cambiar `for (let i = 0; i < 40; i++)` → `for (let i = 0; i < RESUME_MAX_POLLS; i++)`.
- **Al inicio del cuerpo del loop** (antes del `try` que llama `resumeKyc.execute()`):
  `if (cancelledRef.current) return;`
- En la rama `processing`: cambiar `await sleep(2500)` → `await sleep(RESUME_POLL_INTERVAL_MS)` y,
  **justo después del sleep** (antes del `continue`): `if (cancelledRef.current) return;`

Resultado de la rama `processing`:
```ts
if (res.kind === "processing") {
  setResuming(true);
  await sleep(RESUME_POLL_INTERVAL_MS);
  if (cancelledRef.current) return; // CD-CANCEL: no dispara otra iteración tras el escape
  continue;
}
```
NO tocar las ramas `none`/`passed`/`failed` ni el bloque de timeout (L144-149), salvo que ya usan
las constantes por venir del mismo loop.

**W1.4 — Handler `onCancelResume`** · `flow.tsx` (junto a `onRetryKyc`, ~L252-256)

```ts
// WKH-188 (AC-2/AC-3): escape manual del overlay `resuming`. Detiene el loop, limpia el pending
// ANTES de navegar (CD-2), y vuelve a `send` (estado usable, anterior al gate — CD-1).
const onCancelResume = async () => {
  cancelledRef.current = true; // síncrono: el loop lo ve tras su sleep en curso
  try {
    await c.abandonPendingKyc.execute(); // CD-2: abandon ANTES de navegar
  } catch {
    /* best-effort — el reset de estado corre igual (patrón forgetAndDisconnect) */
  }
  setShowResumeEscape(false);
  setResuming(false);
  resetTo(setStep, setRem, setPreview); // → paso `send`
};
```

**W1.5 — Botón condicional en el overlay `resuming`** · `flow.tsx:369-378`
Dentro del `<Card>` del estado `resuming`, DESPUÉS del `<div>` con "Verificando tu identidad…",
renderizar el escape cuando `showResumeEscape`:

```tsx
{showResumeEscape ? (
  <div className="space-y-2">
    <p className="text-sm text-stone">¿No completaste la verificación?</p>
    <Button variant="outline" onClick={onCancelResume}>
      Empezar de nuevo
    </Button>
  </div>
) : null}
```

> **Copy (literal, español rioplatense, sin em dashes)**: texto de ayuda
> `¿No completaste la verificación?` + botón `Empezar de nuevo`. El label del botón DEBE contener
> "Empezar de nuevo" (los tests lo matchean por `/Empezar de nuevo/`). El texto de ayuda es
> ajustable en el gate humano; alternativa mencionada por el founder para el botón: "Cancelar" (si
> se cambia, actualizar el regex de T-ESC1/T-ESC2/T-ESC3 en el mismo commit).

### Wave 2 (Verificación final)

**W2.1** · `npm run qa` (typecheck + suite completa). CD-SUITE: correr TODO. Cero rojos, ningún test
validando el timeout viejo.

---

## 6. Patrones a seguir (exemplars verificados)

| Necesitás | Seguí | Ubicación real |
|-----------|-------|----------------|
| Volver a un estado usable tras KYC | `onRetryKyc` → `resetTo` | `flow.tsx:252-256` + `flow.tsx:755-763` |
| `try/catch` best-effort sobre un use-case | `forgetAndDisconnect` | `flow.tsx:260-279` |
| Abandon antes de navegar | bloque de timeout | `flow.tsx:144-149` |
| Loop de poll + `sleep` | loop de resume | `flow.tsx:97-113` |
| Overlay `resuming` (Card) | estado `resuming` | `flow.tsx:369-378` |
| Tests fake-timers (`useFakeTimers` + `advanceTimersByTimeAsync` + `act` para clicks + `useCases` stub) | bloque `T3` | `flow.test.tsx:308-361` |
| Spy de `window.location.reload` (reemplazar `location` entero) | dentro de T3 | `flow.test.tsx:337-359` |

---

## 7. Tests requeridos (6 tests, todos con fake timers)

Todos en `src/presentation/flow.test.tsx`, dentro de un `describe` con
`beforeEach(() => vi.useFakeTimers())` / `afterEach(() => { vi.useRealTimers(); cleanup(); })`
(reusar/extender el bloque `T3`, L308-361). Patrón por test:
`buildTestContainer({ useCases: { resumeKyc: {...}, abandonPendingKyc: {...} } })`,
`vi.advanceTimersByTimeAsync(...)`, y `act(...)` para los clicks async.

Imports a agregar arriba del archivo (si faltan):
`import { AbandonPendingKyc } from "../application/use-cases/abandon-pending-kyc";`
(`ResumeKyc` ya está importado en L9).

Setup común para los tests de escape (resumeKyc siempre `processing`):
```ts
const resumeSpy = vi.fn(async () => ({ kind: "processing" as const }));
const abandonSpy = vi.fn(async () => {});
const container = buildTestContainer({
  useCases: {
    resumeKyc: { execute: resumeSpy } as unknown as ResumeKyc,
    abandonPendingKyc: { execute: abandonSpy } as unknown as AbandonPendingKyc,
  },
});
render(<RemittanceFlow container={container} />);
```

| Test | AC | Setup | Pasos | Aserciones clave |
|------|-----|-------|-------|------------------|
| **T-ESC1** — el escape aparece a los 5 s, no antes | AC-1 | resumeKyc `processing` | `advanceTimersByTimeAsync(4000)` → check ausente; luego `advanceTimersByTimeAsync(1000)` (total 5000) → check presente | A 4 s: `screen.queryByRole("button", {name:/Empezar de nuevo/})` es `null` **y** el overlay "Verificando tu identidad…" está visible. A 5 s: ese botón `toBeInTheDocument()`. |
| **T-ESC2** — cancelar limpia el pending y vuelve a `send` | AC-2 | `resumeSpy` + `abandonSpy` | `advanceTimersByTimeAsync(5000)`; `await act(async () => { fireEvent.click(screen.getByRole("button",{name:/Empezar de nuevo/})); })` | `abandonSpy` llamado 1× (**antes** de navegar); tras el click `screen.getByLabelText("Monto en dólares")` visible (paso `send`); overlay "Verificando tu identidad…" ausente (`queryByText` null). |
| **T-ESC3** — cancelar detiene el loop (sin más `resumeKyc`) | AC-3 | `resumeSpy` + `abandonSpy` | `advanceTimersByTimeAsync(5000)`; capturar `const n = resumeSpy.mock.calls.length`; click escape en `act`; `await act(async () => vi.advanceTimersByTimeAsync(20000))` | `resumeSpy.mock.calls.length === n` tras avanzar 20 s (el loop no volvió a poletear); sigue en `send`. |
| **T-ESC4** — el escape NO abre camino a `confirm` sin KYC | AC-4 | continuación del escape (como T-ESC2) | tras cancelar | `screen.queryByRole("button",{name:/Confirmar y enviar/})` es `null`; `screen.queryByText(/Identidad verificada/)` es `null`; el usuario está en `send` (`getByLabelText("Monto en dólares")`). |
| **T-ESC5** — timeout total 20 s (no 100 s) + `timedOut` (actualiza T3) | AC-5 | resumeKyc `processing` + `abandonSpy` | **Editar el T3 existente**: cambiar el comentario "40× sleep(2500) … 100 s" → "8× sleep(2500) = 20 s"; `advanceTimersByTimeAsync(100_000)` → `20_000` | A 20_000 ms: "Reintentar" visible (`timedOut`); `abandonSpy` llamado; el retry NO recarga (mantener el spy de `window.location.reload` reemplazando `location`, patrón WKH-185 / CD-JSDOM). |
| **T-ESC6** — respuesta terminal `failed` sale de `resuming` al primer poll | AC-6 | `resumeKyc` devuelve `{kind:"failed", snapshot}` (ver helper abajo) | montar; SIN avanzar timers | Aterriza en `verify` (`getByRole("button",{name:/Escanear DNI \+ selfie/})` visible) con el error "La verificación no pasó"; el escape NUNCA aparece (`queryByRole("button",{name:/Empezar de nuevo/})` null incluso tras `advanceTimersByTimeAsync(6000)`). |

Helper para el snapshot de T-ESC6 (la rama `failed` solo hace `setRem` + `setStep("verify")`, no
inspecciona el KYC — cualquier `RemittanceState` válido sirve). Reusar los fakes ya importados
(`Remittance`, `Money`, `beneficiary`, `T0` en L20/L12):
```ts
const failedSnapshot = Remittance.create("rem-1", beneficiary(), Money.of(400, "USDC"), T0).snapshot;
// resumeKyc: { execute: async () => ({ kind: "failed" as const, snapshot: failedSnapshot }) }
```

> Nota (auto-blindaje WKH-187): estos tests NO dependen de expiry (usan `processing`/`failed`), así
> que no hace falta alinear con el reloj real. No introducir dependencias de `QUOTE_EXPIRES`.

---

## 8. Done Definition

- [ ] `RESUME_ESCAPE_DELAY_MS=5000`, `RESUME_POLL_INTERVAL_MS=2500`, `RESUME_MAX_POLLS=8` declaradas
      como constantes nombradas de módulo; cero números mágicos inline en el loop.
- [ ] El botón de escape aparece a los 5 s dentro del overlay `resuming` (no antes, no solo al final).
- [ ] `onCancelResume` llama `abandonPendingKyc.execute()` (en `try/catch`) ANTES de `resetTo` → `send`.
- [ ] El loop chequea `cancelledRef` al inicio de cada iteración y tras cada `sleep`; tras el cancel
      no vuelve a llamar `resumeKyc.execute()`.
- [ ] El timeout total es 20 s (8×2500); al agotarse: `abandonPendingKyc` + `timedOut` "Reintentar"
      (WKH-178 intacto).
- [ ] La rama `failed` (L137-141) y el gate de compliance quedan ByteIdénticos (CD-1/CD-3/CD-NOREG).
- [ ] 6 tests T-ESC1..T-ESC6 verdes; el bloque `T3` ya NO valida 100_000 (CD-SUITE).
- [ ] `npm run qa` verde (typecheck + suite completa).
- [ ] Ningún archivo fuera de `src/presentation/flow.tsx` + `src/presentation/flow.test.tsx` modificado.

---

## 9. Readiness Check (F2.5)

```
[x] Cada wave lista archivos exactos + líneas ancla verificadas contra el código ACTUAL (post-WKH-187)
[x] Anchors re-verificados: loop L97, sleep L111, failed L137-141, timeout L144-149,
    overlay resuming L369-378, onRetryKyc L252-256, resetTo L755-763, T3 L308-361
[x] Valores de timing fijos y nombrados: 5000 / 2500 / 8 (=20 s)
[x] Mecanismo exacto especificado: setTimeout(5000)→showResumeEscape; cancelledRef top+post-sleep;
    handler abandon→resetTo('send')
[x] Copy literal provisto (sin em dashes, rioplatense); nota de colisión "Empezar de nuevo" resuelta
[x] 6 tests con setup fake-timers y aserciones concretas; helper de snapshot failed provisto
[x] Constraint Directives inline (≥3 PROHIBIDO: CD-1, CD-3, CD-4, CD-NOREG, CD-JSDOM)
[x] buildTestContainer confirmado: soporta overrides resumeKyc + abandonPendingKyc vía useCases
[x] Sin [NEEDS CLARIFICATION] bloqueante (el de Didit es no-bloqueante, fuera de scope del fix)
```

READY FOR F3.

---

*Story File generado por NexusAgil — BUGFIX (F2.5). Architect: nexus-architect.*
