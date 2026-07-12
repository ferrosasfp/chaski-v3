# SDD #188: [BUG] Escape visible + timeout estándar en el resume de KYC abandonado

> SPEC_APPROVED: no
> Fecha: 2026-07-12
> Tipo: bugfix
> SDD_MODE: bugfix
> Branch: fix/188-kyc-resume-escape
> Artefactos: doc/sdd/011-wkh-188-kyc-resume-escape/
> Work Item: doc/sdd/011-wkh-188-kyc-resume-escape/work-item.md

---

## 1. Resumen del bug

Un usuario que arranca el KYC de Didit y vuelve a Chaski SIN completar el escaneo (típicamente dio
"atrás" en el navegador móvil) queda atrapado en el overlay `resuming` ("Verificando tu
identidad…") **sin ningún control interactivo durante ~100 segundos** (40 iteraciones × 2500 ms de
poll en `flow.tsx:97-113`). Recién al agotar las 40 iteraciones aparece "Reintentar"
(`flow.tsx:379-388`, estado `timedOut`). Como una sesión de Didit abandonada nunca se vuelve
terminal vía polling, el usuario percibe la app como colgada.

El fix es **de UX/timing en la capa de presentación** (`flow.tsx`), sin tocar el dominio, los
use-cases ni el gate de compliance:

1. **Escape temprano**: exponer una acción de escape en el overlay `resuming` a los **5 s** (no al
   final del poll), que limpia el pending (`abandonPendingKyc.execute()`, ya existente) y devuelve
   al usuario a un estado usable.
2. **Timeout más corto**: bajar el total del poll de ~100 s a **20 s** (8 iteraciones × 2500 ms),
   preservando el comportamiento de WKH-178 al agotarse (abandon + estado `timedOut`).

Ambos valores se justifican contra el **estándar de UX de espera** (Nielsen Norman Group + patrones
de verificadores de identidad hospedados), no contra números arbitrarios (ver §5.1 / DT-1).

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 188 (WKH-188) |
| **Tipo** | bugfix |
| **SDD_MODE** | bugfix |
| **Objetivo** | Que el resume-loop de KYC ofrezca una vía de escape visible ~5 s tras arrancar y agote su timeout total en ~20 s, sin percepción de "colgado" y sin tocar el gate de compliance. |
| **Reglas de negocio** | El gate `confirm_requires_kyc_passed` (`remittance.ts`) y la autoridad server-side de payout (WKH-180, `confirm-and-send.ts`) permanecen ByteIdénticos. El escape nunca crea un camino a `confirm`/envío sin KYC aprobado. |
| **Scope IN** | `src/presentation/flow.tsx` (efecto de resume + overlay `resuming`) · `src/presentation/flow.test.tsx` (tests fake-timers). |
| **Scope OUT** | `remittance.ts`, `confirm-and-send.ts`, `payout-authority-gateway.ts`, `decision.ts`, `resume-kyc.ts`, `abandon-pending-kyc.ts` (se REUSAN sin cambios). Cualquier archivo fuera de `chaski-v2/`. |
| **Missing Inputs** | [NEEDS CLARIFICATION] no-bloqueante sobre el timing de transición de estado de Didit (ver §10). Copy exacto del botón (TBD, ver §4.6). |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1**: WHILE el overlay `resuming` está visible, THE system SHALL exponer una acción de escape
  visible e interactiva ANTES de agotar el timeout total del poll. La acción SHALL aparecer a los
  **5 s** (`RESUME_ESCAPE_DELAY_MS`, ver DT-1) — no al final.
- **AC-2**: WHEN el usuario activa la acción de escape, THE system SHALL llamar
  `abandonPendingKyc.execute()` (limpia el `KycPending` de `localStorage`) ANTES de sacar al usuario
  del estado `resuming`.
- **AC-3**: WHEN el usuario activa la acción de escape, THE system SHALL detener el loop de polling
  inmediatamente (sin más llamadas a `resumeKyc.execute()` para ese pending) y SHALL devolver al
  usuario a un estado utilizable de la UI (paso `send`, ver DT-2).
- **AC-4**: IF el usuario cancela vía escape, THEN THE system SHALL NOT crear ningún camino que
  alcance el paso `confirm`/el envío sin una decisión de KYC aprobada; el gate
  `confirm_requires_kyc_passed` y `confirm-and-send.ts` permanecen intactos.
- **AC-5**: THE system SHALL acortar el timeout total del resume-loop de 40×2500 ms (~100 s) a
  **8×2500 ms (20 s)** (`RESUME_MAX_POLLS`, ver DT-1), preservando el comportamiento de WKH-178 al
  agotarse (llamar `abandonPendingKyc.execute()` + mostrar `timedOut` con "Reintentar").
- **AC-6**: WHERE `ResumeKyc.execute()` devuelve `{kind:"failed", snapshot}` (incl. el caso en que
  `decision.ts:26` mapea `"Abandoned"`/`"Expired"`/`"Kyc Expired"` como terminal), THE system SHALL
  salir de `resuming` en la primera respuesta terminal (comportamiento YA existente en
  `flow.tsx:137-141`) y esta HU SHALL NOT regresionarlo.

---

## 3. Reproducción

### Repro steps
1. Iniciar una remesa hasta el paso `verify` y tocar "Escanear DNI + selfie" con `NEXT_PUBLIC_KYC_MODE=didit` → redirect same-tab a Didit (`flow.tsx:217-221`).
2. En Didit, dar "atrás" (o cerrar y reabrir) SIN completar el escaneo → volver a Chaski (`/?kyc=return`).
3. El efecto de resume (`flow.tsx:92-154`) encuentra el `KycPending`, poletea `resumeKyc.execute()`.

### Actual
Didit reporta `status` no-terminal (típico `"In Progress"`), `resumeKyc` devuelve `{kind:"processing"}`
(`resume-kyc.ts:44`), la UI queda en el overlay `resuming` **sin ningún botón** durante ~100 s
(40 × 2500 ms) hasta llegar al `else` final (`flow.tsx:144-149`) que recién ahí muestra "Reintentar".

### Expected
- A los **5 s** aparece una acción de escape en el overlay `resuming`.
- Al activarla: `abandonPendingKyc.execute()` limpia el pending y la UI vuelve a `send` (estado
  usable), sin más polls.
- Si el usuario no escapa, el loop agota su timeout total en **20 s** (no 100 s) → `abandonPendingKyc`
  + `timedOut` "Reintentar" (comportamiento WKH-178 preservado).

---

## 4. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Hallazgo |
|---------|---------|----------|
| `src/presentation/flow.tsx` | Ubicación del bug (efecto de resume + overlay) | Loop `for (i<40)` con `sleep(2500)` (L97-113); overlay `resuming` **sin controles** (L369-378); estado `timedOut` con "Reintentar" (L379-388); patrón de abandon-al-agotar (L144-149); refs `resumedRef`/`alive` para one-shot y cleanup (L91-95, 151-153); `resetTo(setStep,setRem,setPreview)` → `send` (L755-763); `onRetryKyc` reusa `resetTo` (L252-256). |
| `src/application/use-cases/resume-kyc.ts` | Contrato del use-case que la UI consume | `execute()` devuelve `none|processing|passed|failed`; `processing` cuando `!dec.terminal` (L44). Firma y lógica NO se tocan (CD-3). |
| `src/application/use-cases/abandon-pending-kyc.ts` | El escape lo reusa | `execute()` = `pending.clear()`. Sin cambios de firma; se llama tal cual (ya usado en L146). |
| `src/infrastructure/kyc-pending-store.ts` | Qué limpia el abandon | `clear()` → `localStorage.removeItem("chaski.kyc.pending.v1")`. |
| `src/infrastructure/didit/decision.ts` | AC-6: verificar el mapeo terminal | L26: `TERMINAL = {Approved,Declined,Abandoned,Expired,Kyc Expired}`; `terminal: TERMINAL.has(status)` (L57). Confirma que el shape YA soporta abandono terminal → AC-6 es "no regresionar", no implementar. Scope OUT. |
| `src/presentation/flow.test.tsx` | Harness de tests (WKH-185) | Bloque `describe("T3 (fake timers aislados, CD-10)")` (L309-361): `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(100_000)` + `buildTestContainer({useCases:{resumeKyc:{execute:async()=>({kind:"processing"})}}})`. Mock pass-through de `framer-motion` (L65-76). Spy de `window.location.reload` reemplazando el objeto `location` entero (L337-359). `act(...)` para clicks tras fake timers. |
| `doc/sdd/010-.../auto-blindaje.md` (WKH-187) | Aprendizaje histórico | Correr la suite completa al tocar timing/FSM; `isQuoteStillValid` usa `new Date()` real, no el clock del container. |
| `doc/sdd/008-.../auto-blindaje.md` (WKH-185) | Aprendizaje histórico | `window.location.reload` no es redefinible en jsdom → reemplazar `location` entero. |

### Exemplar para el fix

| Fix en | Seguir patrón de | Razón |
|--------|------------------|-------|
| Escape handler + reset a estado usable (`flow.tsx`) | `onRetryKyc` (`flow.tsx:252-256`) + `resetTo` (L755-763) | Ya define "volver a estado usable" tras un timeout de KYC: `abandonPendingKyc` (implícito, ya corrido al llegar a `timedOut`) + `resetTo` → `send`. El escape hace lo mismo, pero disparado manualmente + con abandon explícito en el handler. |
| Constantes de timing + polling (`flow.tsx`) | Loop existente L97-113 + `sleep` (L47) | Se reemplaza el `40` mágico por constantes nombradas; el intervalo `2500` se preserva. |
| Tests fake-timers (`flow.test.tsx`) | Bloque `T3` (L309-361) | `useFakeTimers` + `advanceTimersByTimeAsync` + `buildTestContainer({useCases:{resumeKyc:...}})` + `act` para clicks. |

### Componentes reutilizables encontrados
- `Card`, `Button` (`src/presentation/ui.tsx`) — ya usados en el overlay `resuming`/`timedOut`; el botón de escape reusa `<Button>`.
- `abandonPendingKyc` (container) — reusar, NO crear un use-case nuevo.
- `resetTo(...)` (`flow.tsx`) — reusar como destino "usable" del escape (→ `send`).

### Estado de BD relevante
N/A — sin BD relacional. La única persistencia tocada indirectamente es `localStorage`
(`chaski.kyc.pending.v1`), limpiada vía `abandonPendingKyc` (sin cambios).

---

## 5. Análisis de causa raíz

### Dónde está el bug

| Archivo | Línea/zona | Qué está mal |
|---------|-----------|-------------|
| `src/presentation/flow.tsx` | L97 (`for (let i = 0; i < 40; i++)`) | 40 iteraciones × 2500 ms = ~100 s de espera antes de ofrecer cualquier salida. Excede por 10× el estándar de atención de UX. |
| `src/presentation/flow.tsx` | L369-378 (overlay `resuming`) | El `<Card>` no tiene ningún control interactivo; el único escape ("Reintentar") vive en `timedOut`, alcanzable solo tras las 40 iteraciones. |

### Causa raíz
El diseño original (WKH-178) sólo contempló el path "Didit todavía procesa un escaneo completado"
(donde esperar tiene sentido) y no el path "el usuario abandonó" (donde el estado nunca se vuelve
terminal vía polling). Sin un escape temprano ni un límite de tiempo alineado al estándar, el caso
abandonado degrada a "app colgada".

### Fix propuesto (sin código)
1. **Escape temprano (AC-1/2/3)**: un flag de estado `showResumeEscape` que se pone `true` a los
   `RESUME_ESCAPE_DELAY_MS` (5 s) desde que `resuming` es `true` (efecto separado con `setTimeout`,
   time-based, no atado al conteo de iteraciones — decisión de mecanismo, ver §5.1/DT-2). Cuando es
   `true`, el overlay `resuming` renderiza un `<Button>` de escape. Su handler `onCancelResume`:
   (a) marca un ref `cancelledRef.current = true` para que el loop no vuelva a llamar `resumeKyc`;
   (b) `await c.abandonPendingKyc.execute()` (CD-2, ANTES de navegar); (c) `setResuming(false)` +
   `resetTo(...)` → `send`.
2. **Loop consciente del cancel (AC-3)**: el loop verifica `cancelledRef.current` al inicio de cada
   iteración y tras cada `await sleep(...)`, y retorna sin más llamadas a `resumeKyc.execute()`.
3. **Timeout total (AC-5)**: reemplazar `40` por `RESUME_MAX_POLLS = 8` (8 × 2500 = 20 s). El
   comportamiento del `else` final (abandon + `timedOut`) se preserva idéntico.
4. **AC-6 (no regresión)**: no tocar el ramal `res.kind === "failed"` (L137-141) — sigue saliendo a
   `verify` en la primera respuesta terminal.

### 5.1 Justificación del estándar de timing (DT-1) — números NO arbitrarios

> Directiva explícita del founder (2026-07-12): *"el timeout usa lo que las grandes App usan para
> este tipo de espera, el estándar."* Este SDD **reemplaza** el "~6-8 s" sugerido originalmente en
> AC-1 del work-item y el "~25-30 s" del brief inicial por valores derivados del estándar de UX.

**Fuente A — Nielsen Norman Group, "Response Times: The 3 Important Limits"** (Jakob Nielsen, basado
en Miller 1968 / Card et al. 1991):
- **0.1 s**: percepción de instantaneidad.
- **1.0 s**: se mantiene el flujo de pensamiento sin fricción.
- **10 s**: **límite para mantener la atención del usuario en el diálogo.** Pasados ~10 s sin que el
  usuario pueda hacer algo, se pierde la atención y se necesita feedback + una acción/salida.

**Fuente B — patrones de verificadores de identidad hospedados** (Stripe Identity, Persona, Onfido,
Plaid Identity): el auto-poll del resultado tras volver de un redirect resuelve en pocos segundos si
el usuario completó; para una sesión abandonada nunca resuelve. El estándar de esas apps es un
auto-poll **corto** (orden de 15-30 s) con feedback y una acción de escape temprana, no una espera
de ~100 s.

**Decisiones concretas (contra el estándar):**

| Constante | Valor | Justificación contra el estándar |
|-----------|-------|----------------------------------|
| `RESUME_ESCAPE_DELAY_MS` | **5000 ms (5 s)** | La acción de escape debe ser alcanzable **bien antes** del límite de atención de 10 s de NN/g (Fuente A). Objetivo del founder ~5 s, tope ~10 s. 5 s da margen para que el path legítimo (Didit terminó de procesar en 1-2 polls) resuelva solo sin mostrar el botón innecesariamente, y a la vez ofrece salida antes de perder la atención. |
| `RESUME_POLL_INTERVAL_MS` | **2500 ms** (sin cambio) | Intervalo de poll razonable para el tiempo de procesamiento de Didit; se preserva el valor original de WKH-178 (no es el bug). |
| `RESUME_MAX_POLLS` | **8** → total **20 s** | 8 × 2500 = 20 s, dentro del rango estándar 15-30 s de auto-poll de resultado post-redirect (Fuente B). Una sesión abandonada nunca se vuelve terminal, así que esperar más no aporta; 20 s tolera la latencia real de un escaneo recién completado sin degradar a "colgado". El escape a los 5 s cubre la ventana previa. |

Resultado observable: escape a **5 s**, timeout total **20 s** — ambos alineados al estándar y a la
directiva del founder; ninguno arbitrario.

---

## 6. Diseño técnico

### 6.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `src/presentation/flow.tsx` | Modificar | (1) Constantes `RESUME_ESCAPE_DELAY_MS=5000`, `RESUME_POLL_INTERVAL_MS=2500`, `RESUME_MAX_POLLS=8`. (2) Estado `showResumeEscape` + ref `cancelledRef`. (3) Efecto separado que pone `showResumeEscape=true` a los 5 s mientras `resuming`. (4) Loop: usar constantes + chequear `cancelledRef` (top de iteración y tras `sleep`). (5) Handler `onCancelResume` (abandon→reset). (6) Overlay `resuming`: render condicional del `<Button>` de escape cuando `showResumeEscape`. | `onRetryKyc`+`resetTo` (mismo archivo); loop L97-113 |
| `src/presentation/flow.test.tsx` | Modificar | Tests fake-timers nuevos (§9) + actualizar T3 al nuevo timeout (20_000 en vez de 100_000). | Bloque `T3` L309-361 |

### 6.2 Modelo de datos
N/A — sin cambios de dominio ni BD.

### 6.3 Componentes / Servicios
Sin componentes nuevos. Se agregan: 2 constantes de módulo, 1 `useState<boolean>`, 1 `useRef<boolean>`,
1 `useEffect` (timer del escape), 1 handler (`onCancelResume`), 1 `<Button>` condicional. Todo dentro
de `RemittanceFlow`.

### 6.4 Flujo principal (Happy Path del fix)
1. Usuario vuelve de Didit sin completar → efecto de resume monta, `resumeKyc` → `processing` →
   `setResuming(true)`.
2. Efecto del escape arranca un `setTimeout(5000)`.
3. A los 5 s → `showResumeEscape = true` → aparece el `<Button>` de escape en el overlay.
4. Usuario lo activa → `onCancelResume`: `cancelledRef=true` → `await abandonPendingKyc.execute()`
   (pending limpio) → `setResuming(false)` + `resetTo` → paso `send`.
5. El loop, al resolver su `sleep` en curso, ve `cancelledRef` y retorna sin más `resumeKyc`.
6. Resultado: usuario en `send` (estado usable), sin pending huérfano, sin haber tocado el gate.

### 6.5 Flujo de error / borde
- **Usuario no escapa**: el loop agota `RESUME_MAX_POLLS` (20 s) → `abandonPendingKyc.execute()` +
  `setTimedOut(true)` → card "Reintentar" (WKH-178 intacto).
- **Didit devuelve terminal antes de 5 s** (`passed`/`failed`): el loop sale por su ramal existente
  (L114-142) ANTES de mostrar el escape; `resuming` pasa a `false` → el efecto del escape limpia su
  timer (cleanup) → el botón nunca aparece. AC-6 preservado.
- **`abandonPendingKyc.execute()` lanza** (localStorage no disponible): el handler debe tolerarlo sin
  romper la UI (patrón `try/catch` como en `forgetAndDisconnect` L260-279); igual navega a `send`
  (el reset del estado React corre siempre). El próximo mount reintentará el resume, pero el escape
  vuelve a estar disponible → no se re-crea el bug de "colgado".

### 6.6 Microcopy

| Elemento | Texto exacto (default) | Contexto |
|----------|------------------------|----------|
| Texto de ayuda (sobre el botón) | "¿Está tardando?" | Aparece en el overlay `resuming` junto con el botón, a los 5 s. |
| Botón de escape | "Empezar de nuevo" | Acción primaria del escape. Reusa la etiqueta ya presente en el reset del header (L332) para consistencia. [TBD] el founder mencionó también "Cancelar"; el copy no cambia las ACs (comportamiento), se puede ajustar en F3/gate. |

---

## 7. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-STD (NUEVO, del founder 2026-07-12)**: los valores de timing SON los del estándar justificado
  en §5.1: `RESUME_ESCAPE_DELAY_MS=5000` (escape < límite de atención 10 s de NN/g) y
  `RESUME_MAX_POLLS=8` → 20 s total (rango estándar 15-30 s de auto-poll post-redirect). PROHIBIDO
  usar un número arbitrario o reinstaurar el "6-8 s"/"25-30 s"/"~100 s". Las constantes van NOMBRADAS
  (no mágicas inline).
- **CD-2 (heredado)**: el handler de escape SIEMPRE llama `abandonPendingKyc.execute()` ANTES de
  cualquier cambio de `step`/navegación — igual patrón que el `timedOut` existente (L146-147).
- **CD-5 (heredado)**: testear con fake timers (patrón `T3`) tanto la aparición del escape a los 5 s
  como el nuevo timeout total de 20 s, sin depender de tiempo real.
- **CD-6 (heredado)**: actualizar el bloque `T3` para que valide el nuevo timeout (20_000 ms), no el
  viejo (100_000 ms). Cero tests rojos, cero tests validando el timing viejo.
- Reusar `abandonPendingKyc`, `resetTo`, `<Button>`, `<Card>` existentes; no crear use-cases nuevos.
- El loop debe dejar de llamar `resumeKyc.execute()` tras el cancel (AC-3): chequear `cancelledRef`
  al inicio de cada iteración y tras cada `await sleep(...)`.

### PROHIBIDO
- **CD-1 (COMPLIANCE, CRÍTICA)**: PROHIBIDO que el escape, directa o indirectamente, permita alcanzar
  `confirm`/`onConfirm`/envío sin `state.kyc.approved && state.kyc.payoutAllowed`. El escape devuelve
  a `send` (anterior al gate), NUNCA lo saltea.
- **CD-3 (heredado)**: PROHIBIDO tocar `remittance.ts` (`confirm()`, `TRANSITIONS`, `applyKyc`),
  `confirm-and-send.ts`/`payout-authority-gateway.ts` (WKH-180), `decision.ts`, o la firma/lógica de
  `resume-kyc.ts` / `abandon-pending-kyc.ts`.
- **CD-4 (heredado)**: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/` (`wasiai-a2a`,
  `wasiai-v2`, `wasiai-remittance-agents`, demo `yarvis`/`agentshop-*`).
- **CD-JSDOM (de auto-blindaje WKH-185)**: el escape NO usa `window.location` (no reload/redirect);
  es puro cambio de estado React. Si un test necesita espiar `window.location`, reemplazar el objeto
  `location` entero y restaurarlo (no `defineProperty` sobre la property).
- NO refactorizar código adyacente ni "mejorar" nada fuera del fix.
- NO cambiar el intervalo de poll (2500 ms) — no es parte del bug.
- NO regresionar AC-6: no tocar el ramal `res.kind === "failed"` (L137-141).

---

## 8. Waves de implementación

### Wave 0 (Serial Gate — contratos/constantes + tests que fallan primero)
- [ ] W0.1: Declarar constantes nombradas en `flow.tsx`: `RESUME_ESCAPE_DELAY_MS = 5000`,
  `RESUME_POLL_INTERVAL_MS = 2500`, `RESUME_MAX_POLLS = 8`. Verificación: `typecheck`.
- [ ] W0.2: Escribir/ajustar tests fake-timers (§9) que fijan el comportamiento observable
  (aparición del escape a 5 s, timeout a 20 s, cancel detiene el loop, no bypass del gate,
  no-regresión AC-6). Verificación: los tests nuevos fallan (rojo esperado pre-impl); T2/T-AC* verdes.

### Wave 1 (Implementación — depende de W0)
- [ ] W1.1: Estado `showResumeEscape` + ref `cancelledRef` + efecto `setTimeout(RESUME_ESCAPE_DELAY_MS)`
  gated en `resuming` (setea `showResumeEscape`, limpia timer en cleanup / cuando `resuming` cae).
- [ ] W1.2: Loop de resume: reemplazar `40` por `RESUME_MAX_POLLS`, `2500` por
  `RESUME_POLL_INTERVAL_MS`, y chequear `cancelledRef` (top + tras `sleep`). No tocar los ramales
  `passed`/`failed`/`none` ni el `else` de timeout.
- [ ] W1.3: Handler `onCancelResume` (abandon con `try/catch` → `setResuming(false)` + `resetTo`).
- [ ] W1.4: Overlay `resuming` (L369-378): render condicional del `<Button>` de escape + copy (§6.6)
  cuando `showResumeEscape`.

### Wave 2 (Verificación final)
- [ ] W2.1: `npm run qa` (typecheck + toda la suite). Correr la suite COMPLETA (auto-blindaje
  WKH-187): cualquier test que ejerza el resume-loop/timing no debe quedar rojo ni validando el
  timeout viejo.

---

## 9. Test Plan (≥1 test por AC)

Todos en `src/presentation/flow.test.tsx`, en/junto al bloque `describe("T3 ...")` (fake timers).
Patrón: `buildTestContainer({ useCases: { resumeKyc: {...}, abandonPendingKyc: {...} } })`,
`vi.useFakeTimers()`, `vi.advanceTimersByTimeAsync(...)`, `act(...)` para los clicks async.

| Test | AC | Descripción | Aserciones clave |
|------|-----|-------------|------------------|
| `T-ESC1: el escape aparece a los 5 s, no antes` | AC-1 | `resumeKyc` siempre `processing`. Montar. Avanzar 4000 ms → escape ausente. Avanzar hasta 5000 ms → escape presente. | `queryByRole("button",{name:/Empezar de nuevo/})` es `null` a 4 s; `toBeInTheDocument()` a 5 s; el overlay "Verificando tu identidad…" sigue visible. |
| `T-ESC2: cancelar limpia el pending, detiene el loop y vuelve a un estado usable` | AC-2, AC-3 | `resumeKyc` = spy que devuelve `processing`; `abandonPendingKyc` = spy. Avanzar 5000, click escape (en `act`). Capturar `resumeKyc` call-count al click, avanzar 20000 más. | `abandonPendingKyc.execute` llamado 1×; tras el click `getByLabelText("Monto en dólares")` visible (paso `send`) y overlay `resuming` ausente; `resumeKyc` call-count NO aumenta tras el click (loop detenido). |
| `T-ESC4: el escape NO crea camino a confirm sin KYC aprobado` | AC-4 | Continuación del escape: tras cancelar, verificar que no hay ruta al envío. | `queryByRole("button",{name:/Confirmar y enviar/})` es `null`; `queryByText(/Identidad verificada/)` es `null`; el usuario está en `send`. |
| `T-ESC5: el timeout total es 20 s (no 100 s) y preserva timedOut` (actualiza T3) | AC-5 | `resumeKyc` siempre `processing`; `abandonPendingKyc` spy. Avanzar exactamente 20_000 ms. | A 20_000 ms aparece "Reintentar" (estado `timedOut`); `abandonPendingKyc.execute` llamado; el retry NO recarga la página (spy de `window.location.reload` reemplazando `location`, patrón WKH-185). Actualizar el `advanceTimersByTimeAsync(100_000)` original a `20_000` (CD-6). |
| `T-ESC6: respuesta terminal (failed) sale de resuming en el primer poll` | AC-6 | `resumeKyc` devuelve `{kind:"failed", snapshot}` (usa `passedSnapshot` mutado a no-aprobado, o el snapshot `failed` mínimo). Montar. | Aterriza en paso `verify` (botón "Escanear DNI + selfie" visible) con el error "La verificación no pasó"; sin necesidad de avanzar timers (salida inmediata); el escape nunca aparece. |

> Nota de auto-blindaje (WKH-187): los tests que dependan de expiry usan fechas relativas al reloj
> REAL, no a `T0`. Los tests de esta HU no dependen de expiry (usan `processing`/`failed`), pero el
> snapshot de `failed` debe construirse consistente (ver `passedSnapshot`).

---

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| [NEEDS CLARIFICATION] | §5/AC-6 | ¿Didit transiciona el `status` de una sesión hospedada a `"Abandoned"`/`"Expired"` de forma **síncrona** al navegar atrás, o sólo tras expirar su propio TTL (min/horas)? El shape (`decision.ts:26`) YA lo soporta, pero no hay confirmación del sandbox de que el status cambie en segundos. | **NO** — el escape (5 s) + timeout corto (20 s) resuelven el bug reportado con independencia del comportamiento de Didit. El fail-fast del punto 4 del founder queda cubierto por el escape manual; el fail-fast automático sólo mejoraría si Didit reportara "Abandoned" rápido, lo cual NO se puede verificar sin el sandbox. No inventar el comportamiento del tercero. |
| [TBD] | §6.6 | Copy exacto del botón: "Empezar de nuevo" (default) vs "Cancelar". | No — no cambia las ACs (comportamiento), se ajusta en F3/gate. |

> Gate: ningún [NEEDS CLARIFICATION] es bloqueante para SPEC_APPROVED — están acotados a la extensión
> opcional (fail-fast automático), no al fix principal (AC-1..AC-5).

---

## 11. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| El chequeo `cancelledRef` post-`sleep` deja pasar 1 poll extra tras el click | B | B | Chequear `cancelledRef` DOS veces: al inicio de cada iteración Y justo tras `await sleep(...)`. Test T-ESC2 verifica que el call-count de `resumeKyc` no aumenta tras el click. |
| El efecto del escape no limpia su `setTimeout` cuando `resuming` cae por un terminal temprano → botón aparece indebido | B | B | El efecto retorna `clearTimeout` en cleanup y depende de `[resuming]`; al pasar `resuming` a `false`, se limpia. Test T-ESC6 verifica que el escape nunca aparece en el path terminal. |
| Cambiar el timeout rompe/deja rojo el T3 existente (valida 100_000 ms) | M | M | CD-6: T3 se actualiza a 20_000 ms en la MISMA HU (W0.2). W2.1 corre la suite completa (auto-blindaje WKH-187). |
| `abandonPendingKyc` lanza (localStorage) y rompe el escape | B | M | `try/catch` en el handler (patrón `forgetAndDisconnect`); el reset de estado React corre igual. |
| Regresión del gate de compliance | B | A | CD-1/CD-3: el escape sólo navega a `send`; no se toca `remittance.ts`/`confirm-and-send.ts`. Test T-ESC4 prueba ausencia de camino a `confirm`. |

---

## 12. Dependencias
- `main` consolidado post-WKH-178..187 (todas DONE según `doc/sdd/_INDEX.md`). Sin HUs en paralelo
  sobre `flow.tsx`.
- Harness de tests WKH-185 (`buildTestContainer`, fake timers) — ya disponible.
- `abandonPendingKyc` en el container — ya existente (WKH-178).

---

## 13. Readiness Check

```
READINESS CHECK — SDD #188:
[x] Cada AC (1..6) tiene ≥1 test asociado (§9: T-ESC1..T-ESC6) y archivo asociado (§6.1)
[x] Cada archivo en §6.1 tiene Exemplar verificado (flow.tsx: onRetryKyc/resetTo/loop; flow.test.tsx: T3)
[x] No hay [NEEDS CLARIFICATION] BLOQUEANTE (el único es no-bloqueante, acotado al fail-fast opcional)
[x] Constraint Directives incluyen ≥3 PROHIBIDO (CD-1, CD-3, CD-4, CD-JSDOM, +otros)
[x] Context Map tiene ≥2 archivos leídos (8 archivos + 2 auto-blindaje)
[x] Scope IN y OUT explícitos y no ambiguos (§2)
[x] Sin BD: N/A declarado
[x] Happy Path completo (§6.4)
[x] Flujo de error definido (§6.5: no-escape, terminal temprano, abandon lanza)
[x] Timing justificado contra el estándar (§5.1/DT-1), no arbitrario — directiva del founder incorporada como CD-STD
[x] Valores concretos fijados: RESUME_ESCAPE_DELAY_MS=5000, RESUME_POLL_INTERVAL_MS=2500, RESUME_MAX_POLLS=8 (20 s total)
```

READY FOR SPEC_APPROVED — sin TBDs bloqueantes.

---

*SDD generado por NexusAgil — BUGFIX (F2). Architect: nexus-architect.*
