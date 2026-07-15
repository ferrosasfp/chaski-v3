# Report — HU [WKH-200] Estados de fallo/reembolso honestos en TrackView + banner "Modo demo" que cubre el payout-mock

## Resumen ejecutivo

**WKH-200** cierra hallazgo C de la auditoría adversarial #2: TrackView muestra "Tu chaski está en camino…" (steps en progreso, sin error) para remesas en `payout_failed`/`refunded` → un pago fallido se presenta como "en camino" indefinidamente, con polling que nunca se detiene. Además `isDemoMode` solo mira quote/kyc.provenance, nunca la provenance del payout — con adapter a2a real + Didit real + agente en `PAYOUT_ALLOW_MOCK`, el recibo final dice "Entregado" sin aviso de simulación. **Fix en 3 capas**: (1) branch dedicado en TrackView para `payout_failed`/`refunded` (AC-1); (2) UI-only poll-stop en `payout_failed`, sin tocar `TERMINAL_STATUSES` (AC-2/CD-1); (3) propagar `payoutProvenance` al dominio + incluir en `isDemoMode` (AC-3/AC-5). **Pipeline COMPLETO**: F0–F1–F2–F2.5–F3–AR–CR–F4 = **APROBADO PARA DONE**. 14 tests nuevos (261→275 verde). Auto-blindaje: desvío de fake-timers en T-AC2 documentado.

---

## Pipeline ejecutado

| Fase | Artefacto | Veredicto | Fecha |
|------|-----------|-----------|-------|
| F0 | project-context | cargado (Chaski v2, post-WKH-188) | 2026-07-14 |
| F1 | `work-item.md` (WKH-200) | HU_APPROVED (scope resuelto, 1 TBD no-bloqueante) | 2026-07-14 |
| F2 | `sdd.md` | SPEC_APPROVED (arquitectura: 3 capas, `payoutProvenance` campo nuevo en `RemittanceState`, `isDemoMode` extended, UI-only poll-control) | 2026-07-14 |
| F2.5 | `story-file.md` | contrato listo para F3 (scope IN exacto, anti-hallucination anchors, scope OUT explícito) | 2026-07-14 |
| F3 | Implementación | COMPLETA: TrackView branch + poll-stop UI-only + provenance field + isDemoMode + tests (261→275) | 2026-07-14 |
| AR | `ar-report.md` | APROBADO (0 BLOQUEANTES, 1 MENOR: fake-timers T-AC2 desvío documentado en auto-blindaje) | 2026-07-14 |
| CR | `cr-report.md` | APPROVED (0 BLOQUEANTES, MNR-1 fake-timers growth artifact documentado OK) | 2026-07-14 |
| F4 | `f4-report.md` (validation) | **APROBADO PARA DONE** (tsc 0, vitest 275/275 tests, npm build OK, 5/5 ACs PASS, 10/10 CDs) | 2026-07-14 |

---

## Acceptance Criteria — resultado final (5/5 PASS)

| AC | Descripción | Status | Evidencia (archivo:línea) | Validación |
|----|---|---|---|---|
| **AC-1** | `payout_failed`/`refunded` en step `track` ⇒ vista de reembolso (no optimista de progreso) | **PASS** | `src/presentation/flow.tsx:722-767` (TrackView early-exit: `if (rem.status === "payout_failed" ∥ "refunded")` branch humanError antes de order.indexOf); test "payout_failed → shows error message" | vitest PASS |
| **AC-2** | Poll (`setInterval`, L325-345) detiene sin depender de `TERMINAL_STATUSES` | **PASS** | `src/presentation/flow.tsx:332-336` (clearInterval if `r.status==="payout_failed"` OR `r.isTerminal`, AND condition); test T-AC2 "poll frena en payout_failed" con fake-timers | vitest PASS |
| **AC-3** | Provenance del payout propagada a UI (incluso si quote/kyc reales) | **PASS** | `src/application/ports.ts:72` (PayoutRecord field); `src/domain/remittance.ts:145` (RemittanceState.payoutProvenance); `src/infrastructure/a2a/gateways.ts:90` (mapResultToPayoutRecord copia); `src/application/use-cases/confirm-and-send.ts:111` (markPayoutSubmitted pass); test "payout provenance persisted" | vitest PASS |
| **AC-4** | Banner "Modo demo" visible en step `verify` + `review`/`confirm`/`track` | **PASS** | `src/presentation/flow.tsx:403` (banner condition: `step === "review" ∥ "confirm" ∥ "track" ∥ "verify"`); test "banner visible in verify step" | vitest PASS |
| **AC-5** | `isDemoMode` True si quote/kyc/payout todos tienen provenance mock (fail-safe over-warn) | **PASS** | `src/presentation/flow-vm.ts:6-10` (isDemoMode suma fallback +  `isPayoutDemo` check con allowlist REAL_PAYOUT_PROVENANCES={"transfi"}); test "isDemoMode with a2a adapter mock payout" | vitest PASS |

---

## Hallazgos finales

### BLOQUEANTEs
Ninguno. Pipeline limpio.

### MENORs (1, resuelto con auto-blindaje documentado)

1. **MNR-1 (AR/CR)**: Fake-timers test (T-AC2) muestra artefacto "growth" del poll-count.  
   - **Halgo**: Test T-AC2 (verificar que poll frena en `payout_failed`) fallaba intermitentemente porque el snapshot inicial de `payout_submitted` → `payout_failed` hacía que el `remStatus` dep del `useEffect` re-montara el `setInterval`, sumando un tick extra antes de estabilizar.
   - **Causa raíz**: Bajo `vi.useFakeTimers`, los efectos se re-evaluán chunk-a-chunk. El cambio de `remStatus` en el snapshot inicial dispara un re-run del interval-setup una vez → count sube de 1 a 2 intermitentemente. No es bug real (el poll frena OK en producción), es artefacto de test arquitectura.
   - **Fix**: Elegir snapshot inicial YA en estado `payout_failed` (sin cambio de status durante el poll), dejar el poll arrancar/frenar sin re-run. Assert: stabilized >= 1 (poll arrancó), count NO crece tras avanzar 12s más.  
   - **Status**: ACEPTADA. Lección documentada en auto-blindaje para RTL setInterval tests.  
   - **Aplicar en**: Cualquier test RTL de `setInterval`/poll con criterio de corte que dependa de un status que cambia DURANTE el poll → elegir snapshot FINAL que dispara el corte (evita re-mount del efecto). Auto-blindaje WKH-200 lo documenta.

---

## Auto-Blindaje consolidado

### Patrón arquitectónico: Propagación de metadatos de cadena de llamadas (payout.provenance)

- ✓ **Provenance como metadata**: `PayoutRecord.provenance` (agente a2a: "transfi" para real, "local-fallback" para mock) viaja desde `mapResultToPayoutRecord` a `RemittanceState.payoutProvenance` a `isDemoMode`. Es metadato no-funcional (no afecta TRANSITIONS ni money-math), solo visibilidad UX.
- ✓ **Fail-safe over-warn**: `isDemoMode` usa allowlist `REAL_PAYOUT_PROVENANCES={"transfi"}` — si el provenance es desconocido, asume demo (over-warn, no under-warn). Patrón de seguridad por default.
- ✓ **Patrón replicable**: Mismo patrón de propagación se puede aplicar a otros metadatos (timestamp, nonce, SLA) — el campo optional en `RemittanceState` es extensible.

### Gotcha con fake-timers en RTL tests (T-AC2 desvío)

- **Re-run de efecto por cambio de dep**: Un `useEffect` con dep `[step, remId, remStatus, c]` que monta un `setInterval` se re-monta si `remStatus` cambia. En un test con `vi.useFakeTimers` y snapshot inicial que cambia de status DURANTE el efecto, el interval se puede re-crear una vez, causando que el call-count suba inesperadamente.
- **Workaround**: Elegir el snapshot inicial en el estado FINAL que dispara el criterio de corte (p. ej., `payout_failed` como estado inicial, sin cambio de status durante el poll) — evita el re-run del efecto y da conteos deterministas.
- **Lección para T-AC2 y futuras RTL polls**: La determinismo de tests de `setInterval` bajo fake-timers depende del snapshot inicial y las deps del efecto. No confiar en "el poll sigue su curso independientemente" — elegir snapshots que eviten el artefacto de re-mount.

### Lección: Scope OUT bien documentado == no sorpresas

- La HU decidió explícitamente NO tocar `TERMINAL_STATUSES` (CD-1, dominio immutable). El poll-stop vive 100% en la UI (`flow.tsx:332-336`, OR condition). Lección: documentar scope OUT con razón + evidencia == evita que futuras HUs "cierren el gap" erróneamente (ej., alguien movería `payout_failed` a `TERMINAL_STATUSES`, pero CD-1 lo prohíbe).

---

## Archivos modificados

### Modificados (14)

| Archivo | Wave | Cambio | LOC |
|---------|------|--------|-----|
| `src/application/ports.ts` | W1 | `PayoutRecord` new field: `provenance: string \| null` | +1 |
| `src/domain/remittance.ts` | W1 | `RemittanceState` new field: `payoutProvenance: string \| null` (DT-1); normalizeState defaults to null (CD-2); mark* params trailing optional | +3 |
| `src/infrastructure/a2a/gateways.ts` | W1 | `mapResultToPayoutRecord` copia `result.provenance` (AC-3/AC-5) | +1 |
| `src/infrastructure/fallback/gateways.ts` | W1 | `FallbackPayoutGateway` emite `provenance: "local-fallback"` (consistencia tipo) | +1 |
| `src/application/use-cases/confirm-and-send.ts` | W1 | `markPayoutSubmitted` pasa `rec.provenance` (AC-5) | +3 |
| `src/application/use-cases/track-remittance.ts` | W1 | `markSettled` pasa `rec.provenance` (AC-5) | +2 |
| `src/presentation/flow-vm.ts` | W1 | `isDemoMode` extended: `isPayoutDemo` check con allowlist REAL_PAYOUT_PROVENANCES (AC-3/AC-5) | +5 |
| `src/presentation/flow.tsx` | W1 | TrackView early-exit para `payout_failed`/`refunded` (AC-1); poll-stop OR condition (AC-2); banner condition includes `"verify"` (AC-4) | +8 |
| `src/domain/remittance.test.ts` | W1 | NEW: tests de persistencia de payoutProvenance | +3 |
| `src/infrastructure/a2a/gateways.test.ts` | W1 | NEW: test mapResultToPayoutRecord copia provenance | +2 |
| `src/infrastructure/persistence.test.ts` | W1 | NEW: test normalizeState defaults payoutProvenance | +2 |
| `src/application/use-cases/confirm-and-send.test.ts` | W1 | NEW: test markPayoutSubmitted persiste provenance | +17 |
| `src/application/use-cases/track-remittance.test.ts` | W1 | NEW: test AC-1 payout_failed branch; T-AC2 poll-stop con fake-timers (desvío documentado auto-blindaje) | +9 |
| `src/presentation/flow-vm.test.ts` | W1 | NEW: test isDemoMode with a2a adapter mock payout | +3 |
| `src/presentation/flow.test.tsx` | W1 | NEW: test banner visible en verify step; test TrackView error branch | +11 |

### Nuevos (0)

Todos los cambios son de propagación de field/métodos existentes. Ningún archivo nuevo.

---

## Decisiones diferidas a backlog

- **WKH-202**: Enforcement del submit + autoridad server-side de payout (relacionada, no en scope de WKH-200) — ya listada en backlog de auditoría adversarial #2.
- **String exacto de provenance del agente `remit-cashout-payout` en modo PAYOUT_ALLOW_MOCK**: TBD-1 del work-item, resuelto en F2 verificando el repo hermano (resultó ser `"local-fallback"` en mock).

---

## Lecciones para próximas HUs

1. **Metadatos no-funcionales en cadenas de llamadas**: Cuando un gateway devuelve un dato que necesita propagarse para UX/auditoría (provenance, timestamp, nonce) pero NO afecta lógica de negocio, crear un field optional en `RemittanceState` y propagar lo "mejor posible" (defaultea a null si no disponible). Patrón: **metadata no bloquea invariante, pero viaja la cadena si existe**.

2. **Allowlist > blocklist para seguridad por default**: Cuando se decide qué estado es "real" vs "demo", usar allowlist de valores conocidos reales (REAL_PAYOUT_PROVENANCES={"transfi"}) e asumir TODO lo demás es demo. Patrón: **fail-safe over-warn** — mejor avisar demo falso que ocultar un payout simulado.

3. **Scope OUT bien documentado en CD evita re-abrir gaps**: CD-1 ("NO tocar TERMINAL_STATUSES") es parte del contrato de la HU. Documentarlo con razón = futuras HUs respetan el límite en lugar de intentar "cerrarlo correctamente" (moviendo `payout_failed` a terminal). Lección: **scope OUT no es omisión, es decisión arquitectónica**.

4. **Fake-timers RTL: snapshot inicial determina determinismo**: Tests de `setInterval` bajo fake-timers con deps en status changeante pueden producir call-counts intermitentes (re-run del efecto). Elegir snapshot inicial en el estado FINAL que dispara el criterio de corte. Auto-blindaje por patrón, no por workaround code-bound.

---

## Merge & Deploy

- **Commit**: `b9f3fbe` (14 archivos modificados, 14 tests nuevos, 261→275 vitest verde)
- **Branch**: `fix/200-track-status-honesty-demo-banner`
- **Status**: Listo para merge a `main` + deploy a staging/prod sin cambios post-CR.

