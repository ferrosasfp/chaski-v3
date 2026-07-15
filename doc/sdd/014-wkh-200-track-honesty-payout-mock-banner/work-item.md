# Work Item — [WKH-200] Estados de fallo/reembolso honestos en TrackView + banner "Modo demo" que cubre el payout-mock

## Resumen
Hallazgo C de la auditoría adversarial #2 sobre Chaski v2. `TrackView` muestra "Tu chaski está en
camino…" (con steps grises, sin error) para remesas en `payout_failed`/`refunded` — un pago fallido
o reembolsado se presenta como "en camino" indefinidamente, con polling que nunca se detiene. Además
el banner "Modo demo" (`isDemoMode`) solo mira `quote.provenance`/`kyc.provenance`, nunca la
provenance del **payout**: con el adapter `a2a` + Didit real + el agente `remit-cashout-payout` en
`PAYOUT_ALLOW_MOCK`, el recibo final se ve "Entregado" sin ningún aviso de que el desembolso fue
simulado — riesgo de impresión falsa de producción real ante un jurado/usuario.

## Sizing
- SDD_MODE: full
- Estimación: M
- Branch sugerido: fix/200-track-status-honesty-demo-banner

## Grounding (evidencia archivo:línea, verificado en F0, 2026-07-14)

1. **Estado engañoso en TrackView** — `src/presentation/flow.tsx:722-767` (`TrackView`):
   `order = ["confirmed","principal_in","payout_submitted","settled"]` (L728-733); `idx =
   order.indexOf(rem.status)` (L734) es `-1` para `payout_failed`/`refunded` → todos los `reached`
   son `false` (L743) y el header fijo dice "Tu chaski está en camino…" (L739) sin ninguna rama de
   error. `onConfirm` (L261-267) hace `setStep(r.status === "settled" ? "done" : "track")` — cualquier
   status que no sea `settled` (incluido `payout_failed`/`refunded`) cae en `track` con esta vista
   optimista. El copy de reembolso YA existe en `humanError()` (`src/presentation/flow-vm.ts:33`):
   `"No se pudo entregar. Si te cobramos, te reembolsamos."` pero no se usa en `TrackView`.

2. **Polling infinito** — `src/domain/remittance.ts:99`: `TERMINAL_STATUSES = ["settled",
   "kyc_failed", "refunded"]` — **no incluye `payout_failed`**. `TRANSITIONS.payout_failed =
   ["refunded"]` (`remittance.ts:95`). En `src/application/use-cases/track-remittance.ts:36`, si
   `s.status !== "payout_submitted"` el `execute()` retorna temprano SIN volver a intentar nada; si
   `failAndRefund` (L16-30) logra el refund, el status pasa a `refunded` (terminal) en el MISMO
   `execute()` — pero si el refund falla (catch silencioso, L27-29), la remesa queda **congelada en
   `payout_failed`**, que no es terminal. El `setInterval` de `flow.tsx:325-345` (intervalo 1500ms,
   L328/L340) solo se limpia cuando `r.isTerminal` (`Remittance.isTerminal`, `remittance.ts:187-189`,
   usa `TERMINAL_STATUSES`) es `true` (L332-336) — para `payout_failed` nunca lo es → el loop llama
   `execute()` cada 1.5s para siempre, sin efecto (ya retorna temprano en L36) pero sin detenerse.

3. **Banner demo ciego al payout-mock** — `isDemoMode` (`src/presentation/flow-vm.ts:6-8`):
   `rem.quote?.provenance === "local-fallback" || rem.kyc?.provenance === "local-fallback"`. El
   `PayoutRecord` (`src/application/ports.ts:71-77`) **no tiene campo `provenance`**, aunque el shape
   crudo del agente SÍ lo trae: `RawPayoutResult.provenance` (`src/infrastructure/a2a/gateways.ts:34`)
   se **descarta** en `mapResultToPayoutRecord` (`gateways.ts:83-91`, no copia `result.provenance` al
   objeto devuelto). Ni `ConfirmAndSend` (`confirm-and-send.ts:111`, `markPayoutSubmitted(rec.payoutId,
   ...)`) ni `TrackRemittance` (`track-remittance.ts:52`, `markSettled(rec.txRef ?? "",
   rec.deliveredPen, ...)`) reciben ni persisten esa provenance — `RemittanceState`
   (`remittance.ts:132-149`) no tiene ningún campo de provenance del payout. Con `quote`/`kyc` reales
   (adapter `a2a` real + Didit real, provenance ≠ `"local-fallback"`) y el agente de payout en modo
   mock, `isDemoMode` da `false` → el `Receipt` (`flow.tsx:769-785`, condición `isDemoMode(rem)` en
   L780) NO muestra el Pill "Modo demo (sin dinero real)".
   Confirmado también: `FallbackPayoutGateway` (`src/infrastructure/fallback/gateways.ts:95-116`)
   tampoco emite `provenance` en su `PayoutRecord` — hoy no importa porque el modo `fallback` siempre
   swapea los 3 gateways juntos (quote/kyc ya marcan `"local-fallback"`), pero es la MISMA laguna de
   tipo si algún día se mezclan adapters.

4. **`verify` fuera de la condición del banner** — la condición del banner en `flow.tsx:403`:
   `rem && isDemoMode(rem) && (step === "review" || step === "confirm" || step === "track")` — no
   incluye `step === "verify"` (la simulación de escaneo Didit, `SCAN_STEPS`/`scanStage`, L42-46 y el
   render de `verify` más arriba en el componente). Un usuario en modo demo durante el escaneo
   simulado no ve el banner hasta llegar a `review`... **excepto que post-WKH-187 el orden real es
   `send → connect → review → verify → confirm`** (comentario L21), es decir `review` YA se muestra
   antes de `verify` — el gap real es que, al ENTRAR a `verify` (tras `review`), el banner
   desaparece por 1 paso y reaparece en `confirm`. Confirmado como bug real (parpadeo/gap), aunque de
   impacto menor a los hallazgos 1-3.

## Acceptance Criteria (EARS)

- **AC-1** (Unwanted): IF `rem.status` es `"payout_failed"` OR `"refunded"` WHILE `step === "track"`,
  THEN the system SHALL renderizar una vista de reembolso/fallo (reusando el copy existente de
  `humanError("payout_...")` en `flow-vm.ts:33` o equivalente), NO la vista optimista de
  `TrackView` con steps en progreso.
- **AC-2** (Event-driven): WHEN el polling de `flow.tsx` (`useEffect` de L325-345) recibe una
  respuesta con `rem.status === "payout_failed"`, the system SHALL detener el `setInterval`
  (`clearInterval`) sin depender de que el status esté en `TERMINAL_STATUSES` del dominio.
- **AC-3** (State-driven): WHILE la provenance del payout (submiteado vía `PayoutGateway`) indica un
  desembolso NO real (mock), the system SHALL mostrar el Pill "Modo demo (sin dinero real)" en
  `track`/`done` — incluso si `quote.provenance` y `kyc.provenance` no son `"local-fallback"`
  (caso adapter `a2a` real + `PAYOUT_ALLOW_MOCK`).
- **AC-4** (State-driven): WHILE `step === "verify"` AND `isDemoMode(rem)` es `true`, the system
  SHALL mostrar el Pill "Modo demo (sin dinero real)" (cerrar el gap de `flow.tsx:403`, que hoy
  excluye `"verify"` de la condición).
- **AC-5** (Ubiquitous): the system SHALL propagar la `provenance` del `PayoutRecord` (agentes
  `a2a`/mock) hasta un campo persistido y legible desde la UI (p. ej. `payoutProvenance` en
  `RemittanceState`), sin alterar `TRANSITIONS` ni `TERMINAL_STATUSES` (`remittance.ts:85-99`) ni
  el resto del shape existente de `RemittanceState`.

## Scope IN
- `src/presentation/flow.tsx` — rama/step de `TrackView` para `payout_failed`/`refunded` (AC-1);
  guard de `clearInterval` en el polling (AC-2); condición del banner (AC-3/AC-4).
- `src/presentation/flow-vm.ts` — `isDemoMode()` extendido a considerar la provenance del payout.
- `src/infrastructure/a2a/gateways.ts` — `mapResultToPayoutRecord` propaga `result.provenance`
  (AC-5).
- `src/infrastructure/fallback/gateways.ts` — `FallbackPayoutGateway` emite su `provenance` propia
  (consistencia de tipo, no cambia comportamiento observable hoy).
- `src/application/ports.ts` — `PayoutRecord` gana el campo `provenance: string` (AC-5).
- `src/domain/remittance.ts` — `RemittanceState` gana el campo nuevo de provenance del payout;
  `markPayoutSubmitted`/`markSettled` lo persisten. **NO** tocar `TRANSITIONS` ni
  `TERMINAL_STATUSES` (ver CD-1).
- `src/application/use-cases/confirm-and-send.ts` y `track-remittance.ts` — pasan
  `rec.provenance` al agregado.
- Tests correspondientes: `flow.test.tsx`, `gateways.test.ts` (a2a y fallback si existen),
  `remittance.test.ts`, `confirm-and-send.test.ts`, `track-remittance.test.ts`, `flow-vm.test.ts`
  (si existe) — actualizar en la MISMA HU (regla del proyecto, `project-context.md`).

## Scope OUT
- WKH-202 (enforcement de submit) — no es esta HU.
- Lógica de CUÁNDO se dispara el refund o `failAndRefund`/`markPayoutFailed`/`markRefunded` — solo
  se toca la PRESENTACIÓN de esos estados ya existentes, no el money-path.
- Agregar `payout_failed` a `TERMINAL_STATUSES` (ver CD-1) — la solución es presentacional, no de
  dominio.
- El repo `wasiai-remittance-agents` (agentes `remit-corridor-fx`/`remit-cashout-payout`) — fuera de
  este repo, no se toca.
- El gate `confirm_requires_kyc_passed` y la autoridad server-side de payout (WKH-180) — invariantes
  intocables del proyecto (guardrails de `project-context.md`).
- Cualquier cambio a `PAYOUT_ALLOW_MOCK` o a la lógica del agente real de payout.

## Decisiones técnicas (DT-N)
- **DT-1**: se agrega un campo nuevo (`payoutProvenance: string | null`, nombre final a confirmar
  en F2) a `RemittanceState` en lugar de reutilizar `quote.provenance`/`kyc.provenance`, porque la
  provenance del payout es una dimensión INDEPENDIENTE (se conoce recién después del `submit()`,
  puede ser mock aun con quote/kyc reales — exactamente el caso que reporta la auditoría). Default
  `null` antes del submit; `isDemoMode` solo lo considera cuando no es `null`.
- **DT-2**: `TrackView` resuelve `payout_failed`/`refunded` con un branch temprano (return antes de
  calcular la ladder `order`/`idx`) que reusa el copy de `humanError()` (`flow-vm.ts:33`), en vez de
  agregar esos statuses al array `order` — agregarlos a la ladder de progreso implicaría inventar una
  posición visual de "reembolsado" en una barra de progreso pensada para éxito, lo cual es confuso
  (un reembolso no es "un paso más" del camino feliz).
- **DT-3**: el fix del polling infinito (AC-2) se hace en la UI (condición explícita
  `rem.status === "payout_failed"` en el `useEffect` de `flow.tsx`, además de `r.isTerminal`), **no**
  agregando `payout_failed` a `TERMINAL_STATUSES` del dominio — ese cambio de dominio afectaría a
  TODOS los consumidores de `Remittance.isTerminal` (incluido `TrackRemittance.execute()` mismo,
  `track-remittance.ts:36`, que ya trata cualquier status distinto de `payout_submitted` como
  "nada que hacer"), fuera del scope acotado de esta HU (solo presentación).

## Constraint Directives (CD-N)
- **CD-1**: PROHIBIDO agregar `"payout_failed"` a `TERMINAL_STATUSES` (`remittance.ts:99`) — ver
  DT-3, es un cambio de semántica de dominio compartido, no de presentación.
- **CD-2**: OBLIGATORIO que el nuevo campo de provenance del payout sea `string | null`, nunca
  requerido/no-nulo, y que su ausencia (remesas persistidas en `localStorage` ANTES de esta HU, sin
  el campo) nunca lance una excepción — tratar como legacy con default `null`, mismo patrón defensivo
  ya usado en `persistence.ts`/`kyc-store.ts` para migraciones de schema (WKH-181/WKH-183).
- **CD-3**: PROHIBIDO tocar el gate `confirm_requires_kyc_passed` (`remittance.ts:219-222`) o
  `authority.authorize()` en `confirm-and-send.ts` — invariantes intocables (guardrails del
  proyecto).
- **CD-4**: PROHIBIDO cambiar CUÁNDO se transiciona a `payout_failed`/`refunded` (la lógica de
  `failAndRefund` en `confirm-and-send.ts` y `track-remittance.ts` queda byte-idéntica) — esta HU es
  estrictamente de presentación del estado ya alcanzado, no de money-path.
- **CD-5**: OBLIGATORIO que cualquier copy nuevo en `TrackView` para `payout_failed`/`refunded` sea
  PII-free (mismo principio que `humanError()`/CD-5 de WKH-186) — nunca interpolar
  `beneficiary`/`failureReason` crudo del backend en el render.

## Missing Inputs
- **[NEEDS CLARIFICATION] no bloqueante**: el string exacto de `provenance` que devuelve el agente
  `remit-cashout-payout` (repo externo `wasiai-remittance-agents`) cuando corre bajo
  `PAYOUT_ALLOW_MOCK`. Sin ese valor no se puede fijar el matching exacto de AC-3/AC-5 (¿lista
  explícita `["local-fallback", "mock", ...]` o heurística "cualquier valor ≠ conjunto conocido de
  provenance real"?). El Architect puede resolverlo en F2 leyendo directamente el contrato del agente
  en `wasiai-remittance-agents` (repo hermano, no requiere al humano).
- **[resuelto en F2]**: nombre final del campo nuevo en `RemittanceState`/`PayoutRecord`
  (`payoutProvenance` es la propuesta de DT-1, no bloqueante).

## Análisis de paralelismo
- Corre en paralelo con WKH-198 (hallazgo A, NNN `012`), WKH-199 (hallazgo B, NNN `013`) y
  presumiblemente WKH-201 (hallazgo D) — las 4 son hallazgos DISTINTOS de la misma auditoría
  adversarial #2 (2026-07-14) sobre `chaski-v2`, analizadas por analysts en paralelo. **Colisión de
  NNN detectada DOS VECES**: los analysts en paralelo leyeron `_INDEX.md` casi simultáneamente y
  varios calcularon el mismo "siguiente libre" antes de que las otras filas se registraran. WKH-200
  probó `012` (colisión con WKH-198, ya registrado) → `013` (colisión con WKH-199, registrado
  mientras tanto) → se asentó en `014` (este directorio). `doc/sdd/012-wkh-200-.../` y
  `doc/sdd/013-wkh-200-.../` quedaron como stubs obsoletos que apuntan acá (mismo patrón que la
  colisión histórica WKH-179 `001`→`002`). **Verificar al cerrar F1 de WKH-201 si también colisionó
  y renumerar según corresponda.**
- No bloquea ni es bloqueada por ninguna HU DONE existente (178-188) — trabaja sobre el estado ya
  mergeado de todas ellas (`main`).
- Riesgo de colisión de MERGE (no de NNN) con WKH-198 si ambas tocan `flow.tsx` en simultáneo —
  coordinar orden de merge entre Architects/Devs antes de F3. Sin overlap de archivos detectado con
  WKH-199 (toca `kyc-store.ts`/`resume-kyc.ts`/`start-kyc.ts`, ninguno en el Scope IN de esta HU).
- Complementa (sin bloquear) el trabajo futuro de Fase A de WKH-168/WKH-186 (desembolso real): una
  vez que exista provenance "real" del agente de payout, el campo `payoutProvenance` agregado en
  esta HU ya deja el terreno preparado para que `isDemoMode` distinga mock vs real sin cambios
  adicionales de shape.
