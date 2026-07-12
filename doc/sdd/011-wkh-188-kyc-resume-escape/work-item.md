# Work Item — [WKH-188] Escape visible + timeout mas corto en el resume de KYC abandonado

## Resumen
Un usuario que arranca el KYC de Didit y vuelve a Chaski SIN completar el escaneo (ej. dio "atras"
en el navegador) queda atrapado en el overlay "Verificando tu identidad… Estamos confirmando tu
verificacion con Didit. Un segundo." sin ningun boton de salida durante ~100 segundos (40
iteraciones × 2500ms de poll en `flow.tsx`), percibido como que la app se colgo. Beneficiario:
cualquier usuario que abandona una sesion de Didit a mitad de camino (bug reportado por el founder
en movil, 2026-07-12). Mecanismo: (1) exponer una accion de escape visible ANTES del timeout
completo, que limpia el pending (`abandonPendingKyc`, ya existente desde WKH-178) y devuelve al
usuario a un estado usable; (2) acortar el timeout total del poll de ~100s a ~25-30s, porque una
sesion abandonada nunca se vuelve terminal via polling — no tiene sentido esperar 100s para
ofrecer "Reintentar". El gate de compliance (`confirm()`) y la autoridad server-side de payout
(WKH-180) quedan intactos: esto es un fix de UX del resume-loop, no de las invariantes de negocio.

## Sizing
- SDD_MODE: bugfix
- Estimación: S
- Pipeline: QUALITY (con AR obligatorio — case type SECURITY-ADJACENT: el fix toca el flujo de
  resume de KYC, aunque NO el gate en sí; el proyecto usa QUALITY siempre para `chaski-v2`, ver
  historial completo `doc/sdd/_INDEX.md` HUs 178-187)
- Branch sugerido: fix/188-kyc-resume-escape

## F0 — Grounding (código real verificado)

### Root cause confirmado
- `src/presentation/flow.tsx:92-154` (efecto de resume, corre una vez al montar): si hay un KYC
  `pending` (`kyc-pending-store.ts`, `localStorage` key `chaski.kyc.pending.v1`), poletea
  `c.resumeKyc.execute()` en un loop `for (let i = 0; i < 40; i++)` con `await sleep(2500)`
  (L97-113) entre cada intento → **~100 segundos totales** antes de llegar al `else` final
  (L144-149) que recién ahí llama `c.abandonPendingKyc.execute()` + `setTimedOut(true)`.
- `src/application/use-cases/resume-kyc.ts:38-44`: si `this.kyc.decision(...)` responde con
  `dec.terminal === false`, `ResumeKyc.execute()` devuelve `{kind:"processing"}` — la UI interpreta
  esto como "seguir esperando" (L109-112 de `flow.tsx`) y no ofrece salida.
- `src/presentation/flow.tsx:369-378`: el overlay `resuming` (`<Card>` con `Loader2` +
  "Verificando tu identidad…") **no tiene ningún control interactivo** — ni botón ni link. El único
  botón de salida ("Reintentar", L379-387) pertenece al estado `timedOut`, que solo se alcanza
  DESPUÉS de agotar las 40 iteraciones.
- Resultado observado: para una sesión de Didit abandonada (usuario dio "atrás" sin completar), el
  usuario queda ~100s viendo un spinner sin ninguna interacción posible → percibido como colgado.
  Técnicamente NO es infinito (ofrece "Reintentar" a los ~100s), pero la ventana sin escape es el
  bug reportado.

### Hallazgo adicional durante el grounding: `decision.ts` YA mapea "Abandoned"/"Expired" como terminal
- `src/infrastructure/didit/decision.ts:26`: `const TERMINAL = new Set(["Approved", "Declined",
  "Abandoned", "Expired", "Kyc Expired"]);` — el mapeo YA trata estos 3 estados de Didit como
  terminales (`terminal: TERMINAL.has(status)`, L57). Si Didit efectivamente transicionara el
  `status` de la sesión a `"Abandoned"` o `"Expired"` apenas el usuario navega hacia atrás,
  `ResumeKyc.execute()` YA devolvería `{kind:"failed", snapshot}` (v.approved=false) en el primer
  poll — sin loop, sin overlay prolongado.
- **Gap real (no resuelto por el código actual)**: no hay confirmación de que Didit transicione el
  `status` de la sesión de forma SINCRONA cuando el usuario simplemente cierra/retrocede la pestaña
  (comportamiento típico de verificadores hospedados: el estado suele quedar en `"In Progress"` /
  `"Not Started"` hasta que la sesión expira por su propio TTL, que puede ser minutos u horas — NO
  segundos). Esto es lo que explica por qué el usuario ve `"processing"` repetido durante el poll:
  el shape YA soporta "abandonado", pero Didit probablemente no lo reporta así de inmediato. Ver
  Missing Inputs (bloqueante solo para el AC-5 opcional, NO para el fix principal).

### Harness de tests disponible (WKH-185)
- `src/presentation/flow.test.tsx`, bloque `describe("T3 (fake timers aislados, CD-10)")`
  (L309-361): patrón ya establecido — `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(100_000)`
  + `buildTestContainer({ useCases: { resumeKyc: { execute: async () => ({kind:"processing"}) } }
  })` para forzar el loop completo sin esperar tiempo real. El mismo patrón se reusa para testear
  (a) que el botón de escape aparece a los ~6-8s (no antes, no solo al final) y (b) que el timeout
  total bajó a ~25-30s.
- `src/application/use-cases/abandon-pending-kyc.test.ts`: ya cubre `AbandonPendingKyc` de forma
  aislada (AC-7 de WKH-178) — no necesita cambios, se REUSA desde el nuevo handler de escape.

## Acceptance Criteria (EARS)

- AC-1: WHILE el overlay "Verificando tu identidad…" está visible (efecto de resume poleteando),
  the system SHALL exponer una acción de escape visible e interactiva (ej. "Cancelar" / "Empezar de
  nuevo") ANTES de agotar el timeout completo del poll — no solo al final. La acción SHALL
  aparecer dentro de una ventana corta desde que arranca el poll (orden de segundos, no de
  ~100s completos); el valor exacto lo fija el Architect en F2 dentro del rango 6-8s sugerido por
  el founder.
- AC-2: WHEN el usuario activa la acción de escape, the system SHALL llamar
  `abandonPendingKyc.execute()` (limpia el `KycPending` de `localStorage`) ANTES de sacar al
  usuario del estado `resuming` — nunca dejar el pending huérfano tras un escape manual.
- AC-3: WHEN el usuario activa la acción de escape, the system SHALL detener el loop de polling
  inmediatamente (sin más llamadas a `resumeKyc.execute()` para ese pending) y SHALL devolver al
  usuario a un estado utilizable de la UI (ej. paso `verify`, listo para reintentar el KYC desde
  cero) — nunca dejarlo en un estado intermedio sin controles.
- AC-4: IF el usuario cancela vía la acción de escape (AC-2/AC-3), THEN el sistema SHALL NOT crear
  ningún camino que alcance el paso `confirm`/el envío de la remesa sin una decisión de KYC
  aprobada — el gate `confirm_requires_kyc_passed` (`remittance.ts` L219-222, ByteIdéntico) y la
  autoridad server-side de payout (WKH-180, `confirm-and-send.ts`) permanecen intactos y SHALL NOT
  modificarse como parte de este fix.
- AC-5: the system SHALL acortar el timeout total del resume-loop (`flow.tsx` L92-154, hoy
  40 iteraciones × 2500ms ≈ 100s) a un total en el rango ~25-30s (iteraciones/intervalo exactos a
  definir en F2), preservando el comportamiento existente de WKH-178 al agotarse: llamar
  `abandonPendingKyc.execute()` y mostrar el estado `timedOut` con "Reintentar".
- AC-6: WHERE `ResumeKyc.execute()` devuelve `{kind:"failed", snapshot}` (incluyendo el caso donde
  `decision.ts` ya mapea `"Abandoned"`/`"Expired"`/`"Kyc Expired"` como terminal, `decision.ts:26`),
  the system SHALL salir del estado `resuming` inmediatamente en la primera respuesta terminal (sin
  esperar iteraciones adicionales) — este comportamiento YA existe en el código actual
  (`flow.tsx:137-141`) y esta HU SHALL NOT regresionarlo.

## Scope IN
- `src/presentation/flow.tsx` — efecto de resume (L92-154): agregar mecanismo de escape visible
  antes del timeout completo + acortar la constante de timeout total (iteraciones y/o intervalo de
  `sleep`). Overlay `resuming` (L369-378): agregar el control interactivo de escape. Handler nuevo
  que reusa `c.abandonPendingKyc.execute()` (ya existente, sin cambios de firma) y transiciona la
  UI a un estado usable.
- `src/presentation/flow.test.tsx` — tests nuevos/actualizados en el bloque de fake timers (T3):
  (a) el botón de escape aparece dentro de la ventana corta definida en F2, (b) click en escape
  llama `abandonPendingKyc` y detiene el polling (spy/verificación sin más llamadas a
  `resumeKyc.execute` tras el click), (c) el timeout total efectivamente bajó (verificar con
  `vi.advanceTimersByTimeAsync` al nuevo valor, no a 100_000).

## Scope OUT
- `src/domain/remittance.ts` (`confirm()`, `TRANSITIONS`, `applyKyc()`) — sin cambios, el gate de
  compliance no se toca.
- `src/infrastructure/payout/payout-authority-gateway.ts` / `confirm-and-send.ts` (autoridad
  server-side WKH-180) — sin cambios.
- `src/infrastructure/didit/decision.ts` (`mapDiditDecision`, `TERMINAL`) — el mapeo actual YA
  incluye "Abandoned"/"Expired"/"Kyc Expired" como terminal; esta HU NO agrega nuevos estados al
  shape salvo que F2 confirme, con evidencia del sandbox de Didit, que falta un estado adicional
  (ver Missing Inputs — bloqueante SOLO para esa extensión opcional, no para el fix principal).
- `src/application/use-cases/resume-kyc.ts` — sin cambios de lógica/firma; el fix es de la UI que
  lo consume (cuántas veces lo llama y qué hace mientras espera), no del use-case en sí.
- Cualquier archivo fuera de `chaski-v2/` (`wasiai-a2a`, `wasiai-v2`, `wasiai-remittance-agents`,
  el demo `yarvis`/`agentshop-*`).
- El mecanismo exacto de implementación del "grace period" antes de mostrar el botón (nuevo estado
  React vs. contador de iteraciones vs. `setTimeout` separado) — decisión de diseño que cierra el
  Architect en F2; esta HU fija el comportamiento observable (ACs), no el mecanismo.

## Decisiones técnicas (DT-N)
- DT-1: El fix es de UX/timing de la UI (`flow.tsx`), NO de dominio ni de use-cases — reusa
  `AbandonPendingKyc` (ya existente, `abandon-pending-kyc.ts`) sin modificarlo. Mínimo diff, mínimo
  riesgo de regresión sobre el gate de compliance.
- DT-2: `decision.ts` ya mapea `"Abandoned"`/`"Expired"`/`"Kyc Expired"` como terminales
  (L26). Esto significa que AC-6 de esta HU es, en su mayoría, código YA CORRECTO — el trabajo real
  es garantizar que no se regresione, no implementarlo desde cero. La incertidumbre real (¿Didit
  transiciona el status de forma síncrona al abandono, o requiere esperar su propio TTL?) queda
  documentada como [NEEDS CLARIFICATION] para no inventar comportamiento de un tercero sin
  verificarlo contra el sandbox real.
- DT-3: El valor exacto del "grace period" antes de mostrar el escape (sugerido 6-8s por el
  founder) y el nuevo timeout total (sugerido 25-30s) se fijan como RANGO en el work-item; el
  Architect los concreta a un número exacto en F2 (ej. constantes nombradas
  `RESUME_ESCAPE_DELAY_MS` / `RESUME_TIMEOUT_ITERATIONS`), documentando el racional del valor
  elegido.

## Constraint Directives (CD-N)
- CD-1 (COMPLIANCE, CRÍTICA): PROHIBIDO que la acción de escape, directa o indirectamente, permita
  alcanzar el paso `confirm`/`onConfirm` sin que `state.kyc.approved && state.kyc.payoutAllowed`
  sea verdadero. El escape SHALL devolver al usuario a un punto ANTERIOR al gate (ej. `verify`),
  nunca saltarlo.
- CD-2: OBLIGATORIO que el handler de escape llame `abandonPendingKyc.execute()` SIEMPRE antes de
  cualquier cambio de `step`/navegación — igual patrón que el `timedOut` existente (`flow.tsx`
  L146-147) — para que el próximo reload/intento no encuentre un pending huérfano.
- CD-3: PROHIBIDO tocar `remittance.ts` (`confirm()`, `TRANSITIONS`), `confirm-and-send.ts`
  (autoridad server-side WKH-180), o la firma/lógica interna de `resume-kyc.ts` — el fix es
  exclusivamente de cuántas veces/cuánto tiempo la UI poletea y qué controles muestra mientras
  espera.
- CD-4: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/` — no tocar `wasiai-a2a`,
  `wasiai-v2`, `wasiai-remittance-agents`, ni el demo (`yarvis`/`agentshop-*`).
- CD-5: OBLIGATORIO testear con fake timers (patrón `T3`, `flow.test.tsx` L309-361) tanto la
  aparición temprana del botón de escape como el nuevo timeout total acortado — sin depender de
  esperar tiempo real en los tests (CD-10 heredado de WKH-178).
- CD-6: OBLIGATORIO actualizar/agregar tests en la MISMA HU (Scope IN) — no dejar el bloque T3
  validando el timeout viejo (100_000ms) si el código ya cambió a ~25-30s.

## Missing Inputs
- [NEEDS CLARIFICATION] (NO bloqueante para el fix principal — solo para AC-6/extensión opcional
  del punto 4 del objetivo): ¿Didit transiciona el `status` de una sesión hospedada a
  `"Abandoned"`/`"Expired"` de forma SINCRONA cuando el usuario simplemente navega hacia atrás sin
  completar el flujo, o solo tras expirar su propio TTL de sesión (que puede ser mucho mayor a los
  25-30s del nuevo timeout)? Si el sandbox real de Didit confirma que el status NO cambia
  inmediatamente, el fail-fast del punto 4 del objetivo del founder NO es alcanzable con el shape
  actual — el escape button + timeout más corto (AC-1..AC-5) siguen siendo el fix completo y
  suficiente para el bug reportado. No inventar el comportamiento de Didit sin verificarlo.
- [NEEDS CLARIFICATION] Valor exacto del grace period (rango sugerido 6-8s) y del nuevo timeout
  total (rango sugerido 25-30s) — el founder dio rangos, no valores exactos. El Architect propone
  valores concretos en F2; no bloquea F2 (puede proponer y el humano ajusta en el gate).
- [TBD] Copy exacto del botón de escape ("Cancelar" vs "Empezar de nuevo" vs otro) — el founder
  mencionó ambas variantes en el brief. Se define en F2/F3, no cambia las ACs (comportamiento, no
  texto).

## Análisis de paralelismo
- Esta HU trabaja sobre `main` ya consolidado post-WKH-178..187 (según `doc/sdd/_INDEX.md`, todas
  las HUs previas están en estado DONE). No hay HUs en curso en paralelo reportadas sobre
  `chaski-v2` al momento de este F1 — no bloquea ni es bloqueada por ninguna HU abierta.
- Toca `src/presentation/flow.tsx`, el mismo archivo central que WKH-178 (introdujo el resume-loop
  + `timedOut`), WKH-184 (reset explícito), WKH-185 (harness de tests) y WKH-187 (reorden de
  steps). Todas esas HUs están DONE y mergeadas — sin colisión de merge esperada, pero el Architect
  debe leer el estado ACTUAL de `flow.tsx` (post-WKH-187: los steps son
  `send|connect|review|verify|confirm|track|done`, NO el orden pre-187) antes de diseñar el
  mecanismo exacto de escape.
- Es una HU auto-contenida y de bajo riesgo: no bloquea ni depende de WKH-168 (desembolso real,
  value-delivery) ni de ninguna otra HU del roadmap — es un fix acotado de UX en un tramo
  pre-`confirmed` de la FSM.
