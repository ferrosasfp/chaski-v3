# SDD #200: [Hallazgo C] Estados de fallo/reembolso honestos en TrackView + banner "Modo demo" que cubre el payout-mock

> SPEC_APPROVED: no
> Fecha: 2026-07-14
> Tipo: bugfix (presentación + propagación de shape)
> SDD_MODE: full
> Estimación: M
> Branch: fix/200-track-status-honesty-demo-banner
> Artefactos: doc/sdd/014-wkh-200-track-honesty-payout-mock-banner/
> Work Item: doc/sdd/014-wkh-200-track-honesty-payout-mock-banner/work-item.md
> Orden de merge: **ÚLTIMO** del batch 198/199/200/201 (diseñado asumiendo 198+201 ya en `main`).

---

## 1. Resumen

Tres bugs de honestidad de estado + demo en `chaski-v2` (Hallazgo C de la auditoría adversarial #2),
más un cuarto menor. Todos **de presentación / propagación de shape**, ninguno de money-path:

1. **TrackView miente en fallo/reembolso (AC-1)** — `TrackView` (`flow.tsx:722-767`) usa
   `order.indexOf(rem.status)`, que es `-1` para `payout_failed`/`refunded` → renderiza "Tu chaski
   está en camino…" con los steps grises, sin ninguna rama de error, para siempre.
2. **Polling infinito en `payout_failed` (AC-2)** — `payout_failed` NO está en `TERMINAL_STATUSES`
   (`remittance.ts:99`); el `setInterval` de `flow.tsx:328-345` sólo se corta con `r.isTerminal`
   → si el refund automático falla y la remesa queda congelada en `payout_failed`, el poll llama
   `trackRemittance.execute()` cada 1.5 s indefinidamente (sin efecto pero sin parar).
3. **Banner demo ciego al payout-mock (AC-3/AC-5)** — `isDemoMode` (`flow-vm.ts:6-8`) sólo mira
   `quote.provenance`/`kyc.provenance`. `PayoutRecord` (`ports.ts:71-77`) **no tiene** campo
   `provenance`; el shape crudo del agente sí lo trae (`RawPayoutResult.provenance`,
   `gateways.ts:34`) y se **descarta** en `mapResultToPayoutRecord` (`gateways.ts:83-91`). Con
   adapter `a2a` real + Didit real + el agente `remit-cashout-payout` en `PAYOUT_ALLOW_MOCK`, el
   recibo final ("Entregado") no muestra el Pill "Modo demo" → falsa impresión de producción real.
4. **`verify` fuera de la condición del banner (AC-4)** — `flow.tsx:403` incluye
   `review|confirm|track` pero no `verify`; en modo demo el banner desaparece 1 paso al entrar a
   `verify` y reaparece en `confirm` (parpadeo).

El fix propaga la `provenance` del payout hasta un campo nuevo `payoutProvenance: string | null` en
`RemittanceState`, lo incluye en `isDemoMode` (fail-safe), agrega un branch de reembolso en
`TrackView`, y detiene el polling en `payout_failed` **desde la UI** (sin tocar el dominio).

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 200 (WKH-200) |
| **Tipo** | bugfix (presentación + propagación de shape) |
| **SDD_MODE** | full |
| **Objetivo** | TrackView honesto en `payout_failed`/`refunded`, polling que se detiene, y el banner "Modo demo" que refleja también un payout mock — sin tocar `TRANSITIONS`/`TERMINAL_STATUSES` ni el money-path. |
| **Reglas de negocio** | `confirm_requires_kyc_passed` (`remittance.ts:219-222`), la autoridad server-side WKH-180 y la lógica de CUÁNDO se transiciona a `payout_failed`/`refunded` (`failAndRefund`) quedan byte-idénticas. Sólo cambia la PRESENTACIÓN del estado ya alcanzado + la propagación de un campo nuevo. |
| **Scope IN** | Ver §6.1 (8 archivos de producción + 6 de test). |
| **Scope OUT** | WKH-202 (enforcement del submit); la lógica de CUÁNDO se refunda; `PAYOUT_ALLOW_MOCK` y la lógica del agente real; el repo `wasiai-remittance-agents`; `TERMINAL_STATUSES`/`TRANSITIONS`. |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1** (Unwanted): IF `rem.status ∈ {payout_failed, refunded}` WHILE `step === "track"`, THEN el
  sistema SHALL renderizar una vista de reembolso/fallo (reusando el copy de
  `humanError("payout_...")`, `flow-vm.ts:33`), NO la vista optimista con steps en progreso.
- **AC-2** (Event-driven): WHEN el polling (`flow.tsx:325-345`) recibe `rem.status === "payout_failed"`,
  el sistema SHALL `clearInterval` sin depender de `TERMINAL_STATUSES` del dominio.
- **AC-3** (State-driven): WHILE la provenance del payout indica un desembolso NO real (mock), el
  sistema SHALL mostrar el Pill "Modo demo (sin dinero real)" en `track`/`done` — aun con
  `quote.provenance`/`kyc.provenance` reales.
- **AC-4** (State-driven): WHILE `step === "verify"` AND `isDemoMode(rem)` es `true`, el sistema
  SHALL mostrar el Pill "Modo demo" (cerrar el gap de `flow.tsx:403`).
- **AC-5** (Ubiquitous): el sistema SHALL propagar la `provenance` del `PayoutRecord` hasta un campo
  persistido y legible desde la UI (`payoutProvenance` en `RemittanceState`), sin alterar
  `TRANSITIONS` ni `TERMINAL_STATUSES` ni el resto del shape existente.

---

## 3. Resolución del [NEEDS CLARIFICATION] (contrato del agente)

**Pregunta (work-item §Missing Inputs):** ¿qué string de `provenance` devuelve `remit-cashout-payout`
bajo `PAYOUT_ALLOW_MOCK`, y el matching es lista explícita de mocks o heurística "≠ conjunto real"?

**Resuelto leyendo el repo hermano `wasiai-remittance-agents` (verificado archivo:línea):**

| Modo del agente | Provider | `provenance` devuelto | Evidencia |
|-----------------|----------|-----------------------|-----------|
| `PAYOUT_ALLOW_MOCK=true` (prod etapa 1) / dev fallback | `FallbackPayoutProvider` | `"local-fallback"` | `src/providers/payout.ts:76`, `:86` |
| Real (TransFi key + `TRANSFI_ADAPTER_READY`) | `TransFiPayoutProvider` | `"transfi"` | `src/providers/payout.ts:40`, `:58` |
| KYC-gate bloqueado (`kycPayoutAllowed:false`) | — (no ejecuta) | `"n/a"` | `src/agents/cashout-payout.ts:91` |

El fail-safe del agente (`cashout-payout.ts:48-72`) garantiza que `PAYOUT_ALLOW_MOCK` habilita
**sólo** el `FallbackPayoutProvider` (mock, nunca mueve plata) — jamás un path real. Es decir: bajo
`PAYOUT_ALLOW_MOCK`, la `provenance` que llega a chaski-v2 es **siempre** `"local-fallback"`.

**Decisión de matching (DT-4): heurística fail-safe con allowlist de proveniencias REALES**, NO lista
de mocks. Se define `REAL_PAYOUT_PROVENANCES = new Set(["transfi"])`; un payout es "demo" cuando su
`payoutProvenance` es **no-null y NO está** en ese set. Exemplar directo:
`REAL_KYC_PROVENANCES = new Set(["didit"])` en `wasiai-remittance-agents/src/agents/kyc-validator.ts:54`
(comentario MNR-3: *"allowlist explícita de proveniencias REALES (fail-safe en el eje provenance) —
un typo futuro en un provider NO debe leerse como 'real'"*).

Por qué allowlist de REAL y no de mock: es una app de dinero; el riesgo reportado es **ocultar un
mock como real** (falsa impresión ante el jurado/usuario). Con allowlist de REAL, cualquier valor
desconocido/nuevo/typo (`"local-fallback"`, `"n/a"`, un provider futuro no whitelisteado) cae del
lado seguro → **muestra** el banner demo (over-warn), nunca lo esconde. Con una lista de mocks, un
provider nuevo mock que no esté en la lista se leería como "real" y ocultaría el aviso — inaceptable.

> Nota de mantenimiento (hereda de kyc-validator MNR-3): cuando exista un partner de payout REAL
> distinto de TransFi, se agrega su `provenance` a `REAL_PAYOUT_PROVENANCES` — mismo criterio que el
> allowlist de KYC. Sin esa entrada, un payout real nuevo se mostraría (conservadoramente) como demo.

**Asimetría con `quote`/`kyc` (justificada):** `isDemoMode` hoy usa match exacto `=== "local-fallback"`
para quote/kyc. NO se cambia esa semántica (fuera de scope). El eje `payout` es la dimensión nueva
donde vive el riesgo reportado, y ahí se usa el fail-safe inverso (allowlist de real). La asimetría
es deliberada y documentada, no un descuido.

---

## 4. Context Map (Codebase Grounding)

### Archivos leídos (chaski-v2)

| Archivo | Por qué | Hallazgo / patrón extraído |
|---------|---------|----------------------------|
| `src/presentation/flow.tsx` | Ubicación de AC-1/2/4 | `TrackView` (L722-767) `order.indexOf`→`-1` para failed/refunded; poll `setInterval` con guard `r.isTerminal` (L332-336); banner condicional (L403) sin `verify`; `Receipt` usa `isDemoMode` (L780). `humanError`, `isDemoMode` importados (L18). `resetTo`, `methodLabel` helpers de módulo. `<Pill tone="warn">` para banners. |
| `src/presentation/flow-vm.ts` | AC-3/AC-5 | `isDemoMode` (L6-8) = match exacto `"local-fallback"` sobre quote/kyc; `humanError("payout")` → `"No se pudo entregar. Si te cobramos, te reembolsamos."` (L33). Funciones puras, sin deps de UI. |
| `src/domain/remittance.ts` | AC-5 (campo nuevo) | `RemittanceState` (L132-149); `Remittance.create` (L154-175) inicializa todos los campos; `to()` spreadea `patch` (L195) → un campo seteado en un `mark*` persiste en transiciones siguientes; `markPayoutSubmitted` (L231), `markSettled` (L234); `TERMINAL_STATUSES` (L99, NO tocar), `TRANSITIONS` (L85-97, NO tocar). |
| `src/application/ports.ts` | AC-5 (shape) | `PayoutRecord` (L71-77) sin `provenance`; `RemittanceRepository` (L120-125) — WKH-201 le agrega `clearByOwner` (interface distinta, sin conflicto). |
| `src/infrastructure/a2a/gateways.ts` | AC-5 (propagación) | `RawPayoutResult.provenance` (L34); `mapResultToPayoutRecord` (L83-91) descarta `result.provenance`; `isValidPayoutShape` (L55-67) ya valida `typeof provenance === "string"`; `A2aPayoutGateway.status` cache-miss fabrica un `PayoutRecord` (L146-152) que necesitará el campo nuevo. |
| `src/infrastructure/fallback/gateways.ts` | AC-5 (consistencia de tipo) | `FallbackPayoutGateway.submit/status` (L95-116) devuelven `PayoutRecord` sin `provenance`. |
| `src/application/use-cases/confirm-and-send.ts` | AC-5 (persistir) | `markPayoutSubmitted(rec.payoutId, now)` (L111); `markSettled(rec.txRef ?? "", rec.deliveredPen, now)` (L120). `failAndRefund` (L32-46) — NO tocar (CD-4). |
| `src/application/use-cases/track-remittance.ts` | AC-5 (persistir) | `markSettled(...)` (L52); guard `s.status !== "payout_submitted"` → return temprano (L36). `failAndRefund` (L16-30) — NO tocar (CD-4). |
| `src/infrastructure/persistence.ts` | CD-2 (legacy safe) | `normalizeState` (L45-51) exemplar de default defensivo para campos ausentes en snapshots legacy (`ownerAddress`, `version`). |
| `src/test-support/fakes.ts` | AC-5 tests | `FakePayoutGateway` (L186-214) submit/status sin `provenance`; `FakeQuoteGateway.provenance="fake"`. `InMemoryRepo` CAS. |
| `src/test-support/test-container.ts` | tests RTL | `buildTestContainer({payouts, useCases, ...})`; overrides a nivel gateway y use-case. |
| `src/presentation/flow.test.tsx` | tests RTL | Harness jsdom+RTL (WKH-185); mock `framer-motion` pass-through (L66-76); `passedSnapshot(...)` builder; fake timers; `T0`/`QUOTE_EXPIRES`. |
| `src/infrastructure/a2a/gateways.test.ts` | AC-5 tests | `okJson({result})`; `expect(rec).toEqual({...})` (L83) — aserción de `PayoutRecord` mapeado (deberá incluir `provenance`). |

### Contrato del agente (wasiai-remittance-agents — SOLO lectura)

| Archivo | Hallazgo |
|---------|----------|
| `src/providers/payout.ts` | mock → `"local-fallback"` (L76/86); real → `"transfi"` (L40/58). |
| `src/agents/cashout-payout.ts` | `PAYOUT_ALLOW_MOCK` sólo habilita el fallback (L48-72); blocked → `"n/a"` (L91). |
| `src/agents/kyc-validator.ts` | **Exemplar del matching**: `REAL_KYC_PROVENANCES = new Set(["didit"])` (L54), fail-safe (L52-68). |
| `src/providers/types.ts` | `Provenance = string`; `PayoutResult.provenance` (L81). |

### Aprendizaje histórico (Auto-Blindaje de las 3 últimas DONE)

| Fuente | Lección aplicada a este SDD |
|--------|-----------------------------|
| WKH-187 auto-blindaje #1/#2 | **Cambiar un shape compartido / la FSM rompe MÁS tests que los anchoreados.** Al agregar `payoutProvenance` a `RemittanceState` y `provenance` a `PayoutRecord`, grepear TODOS los productores/aserciones inline y correr la suite completa. → CD-6, CD-7. |
| WKH-186 auto-blindaje #2 | **Fixture de fake de payout inconsistente dispara reconciliación.** El campo nuevo debe agregarse a `FakePayoutGateway` sin alterar `deliveredPen` (que debe seguir consistente con el `receive` del quote fake). → CD-7. |
| WKH-188 auto-blindaje #1 | **Fake timers: anclar el `setTimeout`/`setInterval` con un `advanceTimersByTimeAsync(1)` primero.** Aplica al test de AC-2 (polling). → §9 nota. |
| WKH-187 auto-blindaje #3 | **`isQuoteStillValid` lee tiempo REAL en RTL, no el clock del container.** Los snapshots de test que necesiten quote vigente usan `expiresAt` futuro real. Aplica a los renders RTL de esta HU. → §9 nota. |

### Estado de BD relevante
N/A — sin BD relacional. Única persistencia: `localStorage` (`chaski.remittances.v1`), vía `LocalRepo`.
El campo nuevo `payoutProvenance` se serializa como `string`/`null` normal (no es `Money`, no toca el
`replacer`/`reviver`). Legacy sin el campo → `normalizeState` lo defaultea a `null` (CD-2).

---

## 5. Decisiones técnicas (DT-N)

- **DT-1 (heredada del work-item)**: campo nuevo `payoutProvenance: string | null` en
  `RemittanceState`, **independiente** de `quote.provenance`/`kyc.provenance` (se conoce recién tras
  el `submit()`; puede ser mock con quote/kyc reales). Default `null` en `create`; `isDemoMode` sólo
  lo considera cuando es no-null.
- **DT-2 (heredada)**: `TrackView` resuelve `payout_failed`/`refunded` con un **branch temprano**
  (return ANTES de calcular `order`/`idx`), reusando el copy de `humanError`. NO se agregan esos
  statuses al array `order` (un reembolso no es "un paso más" del camino feliz).
- **DT-3 (heredada)**: el stop del polling (AC-2) se hace en la UI — condición explícita
  `rem.status === "payout_failed"` en el `useEffect`, **no** agregando `payout_failed` a
  `TERMINAL_STATUSES` (eso afectaría a todos los consumidores de `isTerminal`, incl.
  `TrackRemittance.execute` mismo). Ver CD-1.
- **DT-4 (nueva, resuelve el [NEEDS CLARIFICATION])**: matching de demo por **allowlist fail-safe de
  proveniencias reales** (`REAL_PAYOUT_PROVENANCES = new Set(["transfi"])`); demo ⇔ `payoutProvenance`
  no-null y ∉ allowlist. Justificación completa en §3.
- **DT-5 (nueva, mecanismo de propagación)**: `payoutProvenance` se setea en `markPayoutSubmitted`
  (el punto más temprano donde se conoce, con `rec.provenance` del submit) y se **re-persiste
  opcionalmente** en `markSettled` (backfill). Ambos reciben la provenance como **parámetro trailing
  opcional después de `now`** (`markPayoutSubmitted(payoutId, now, payoutProvenance?)`,
  `markSettled(payoutTx, deliveredPen, now, payoutProvenance?)`) y **sólo la escriben cuando se
  provee** (si no, `to()` conserva el valor previo). Esto: (a) mantiene la convención `now`-último de
  la familia `mark*`; (b) **no rompe** las llamadas existentes de `remittance.test.ts`/
  `track-remittance.test.ts` (siguen compilando y comportándose igual); (c) da semántica de backfill
  para una remesa legacy que quedó en `payout_submitted` pre-HU y settlea post-HU (el `markSettled`
  de `TrackRemittance` la rellena desde el `status` rec). El campo `provenance` en `PayoutRecord` sí
  es **requerido** (`string`) — fuerza a todo productor a declararlo (money-app safe); esto rompe los
  literales inline de `PayoutRecord`, enumerados en §6.1/CD-7.
- **DT-6 (nueva, copy AC-1)**: el branch de fallo/reembolso de `TrackView` muestra el copy PII-free de
  `humanError("payout_failed")` en un `<Card>`. Se distingue tono `refunded` ("te reembolsamos, listo")
  vs `payout_failed` (mismo copy; el refund puede estar pendiente) SÓLO por un subtítulo fijo, sin
  interpolar `failureReason` ni ningún dato del backend (CD-5). Opcionalmente muestra `rem.refundTx`
  (referencia sintética, NO PII) si existe.

---

## 6. Diseño técnico

### 6.1 Archivos a crear/modificar

**Producción (8):**

| Archivo | Acción | Cambio | Exemplar |
|---------|--------|--------|----------|
| `src/application/ports.ts` | Modificar | `PayoutRecord` gana `provenance: string` (requerido). | shape existente |
| `src/domain/remittance.ts` | Modificar | (a) `RemittanceState` gana `payoutProvenance: string \| null`. (b) `create()` lo inicializa en `null`. (c) `markPayoutSubmitted(payoutId, now, payoutProvenance?)` y `markSettled(payoutTx, deliveredPen, now, payoutProvenance?)` — set condicional (`patch` sólo incluye el campo si `payoutProvenance !== undefined`). **NO tocar** `TRANSITIONS`/`TERMINAL_STATUSES`/`confirm`. | `to()` (L191-196), campos de `create` |
| `src/infrastructure/a2a/gateways.ts` | Modificar | (a) `mapResultToPayoutRecord` copia `provenance: result.provenance`. (b) `A2aPayoutGateway.status` cache-miss (L146-152) agrega `provenance: ""` (record fabricado no-real; nunca settlea → cosmético). | mapeo existente |
| `src/infrastructure/fallback/gateways.ts` | Modificar | `FallbackPayoutGateway.submit` y `status` agregan `provenance: "local-fallback"` (mock — coherente con el agente real). | provenance del `FallbackQuoteGateway` (L58) |
| `src/application/use-cases/confirm-and-send.ts` | Modificar | L111 `markPayoutSubmitted(rec.payoutId, now, rec.provenance)`; L120 `markSettled(rec.txRef ?? "", rec.deliveredPen, now, rec.provenance)`. **NO tocar** `failAndRefund`, `confirm`, autoridad. | llamadas existentes |
| `src/application/use-cases/track-remittance.ts` | Modificar | L52 `markSettled(rec.txRef ?? "", rec.deliveredPen, now, rec.provenance)`. **NO tocar** `failAndRefund` ni el guard L36. | llamada existente |
| `src/presentation/flow-vm.ts` | Modificar | `REAL_PAYOUT_PROVENANCES = new Set(["transfi"])` + helper `isPayoutDemo(p)`; `isDemoMode` suma `\|\| isPayoutDemo(rem.payoutProvenance)`. | `REAL_KYC_PROVENANCES` (agente) |
| `src/presentation/flow.tsx` | Modificar | (AC-1) branch temprano en `TrackView` para `payout_failed`/`refunded`. (AC-2) poll: `if (r.isTerminal \|\| r.status === "payout_failed")` → `clearInterval`. (AC-4) banner L403: sumar `\|\| step === "verify"`. | `TrackView`, `useEffect` poll, `<Pill tone="warn">` |

**Persistencia legacy (1, dentro de Scope IN por CD-2):**

| Archivo | Acción | Cambio |
|---------|--------|--------|
| `src/infrastructure/persistence.ts` | Modificar | `normalizeState` (L45-51) defaultea `payoutProvenance: typeof s.payoutProvenance === "string" ? s.payoutProvenance : null` (mismo patrón que `ownerAddress`/`version`). |

**Tests (6):** `remittance.test.ts`, `a2a/gateways.test.ts`, `confirm-and-send.test.ts`,
`track-remittance.test.ts`, `flow-vm.test.ts`, `flow.test.tsx`, `persistence.test.ts` (legacy). Ver §9.

> `test-support/fakes.ts` NO es Scope-IN de producción pero **debe** actualizarse: `FakePayoutGateway`
> (submit + status) agrega `provenance` (default `"fake"`), sin cambiar `deliveredPen` (CD-7 /
> auto-blindaje WKH-186). Es archivo de test-support.

### 6.2 Modelo de datos

`RemittanceState` gana un único campo escalar:

```
payoutProvenance: string | null   // null antes del submit / legacy; "local-fallback" (mock),
                                   // "transfi" (real), "n/a" (blocked), etc. tras el submit
```

`PayoutRecord` gana `provenance: string` (requerido). Sin cambios de `Money`, sin migración de
serialización (string/null nativo). `TRANSITIONS`/`TERMINAL_STATUSES` intactos.

### 6.3 Componentes / Servicios
Sin componentes nuevos. En `flow.tsx`: un branch condicional al tope de `TrackView`, un `||` en el
guard del poll, un `||` en la condición del banner. En `flow-vm.ts`: 1 `const` set + 1 helper puro +
1 `||`.

### 6.4 Flujo principal (Happy Path del fix)
1. Adapter `a2a` real + Didit real + agente en `PAYOUT_ALLOW_MOCK` → `submit()` devuelve
   `provenance: "local-fallback"`.
2. `ConfirmAndSend` → `markPayoutSubmitted(payoutId, now, "local-fallback")` → `payoutProvenance`
   persistido en el estado; se conserva al `markSettled`.
3. UI en `track`/`done` → `isDemoMode(rem)` = `true` (por `isPayoutDemo("local-fallback")`, aun con
   quote/kyc `"didit"`) → Pill "Modo demo (sin dinero real)" visible en el banner y en el `Receipt`.

### 6.5 Flujo de fallo / borde
- **`payout_failed` congelado** (refund automático falló): `onConfirm` deja `step==="track"`;
  `TrackView` renderiza el branch de reembolso (AC-1, DT-6); el poll ve `payout_failed` y hace
  `clearInterval` (AC-2) — no más `trackRemittance.execute()`.
- **`refunded`**: `refunded` ES terminal (`isTerminal`), el poll ya se corta hoy; `TrackView`
  muestra el branch de reembolso.
- **Legacy sin `payoutProvenance`** (localStorage pre-HU): `normalizeState` → `null`;
  `isPayoutDemo(null)` = `false` (no crash, no banner espurio). CD-2.
- **`payoutProvenance` desconocida/typo** (p. ej. provider futuro): `isPayoutDemo` = `true`
  (over-warn, fail-safe). DT-4.
- **Real `"transfi"`**: `isPayoutDemo("transfi")` = `false` → sin banner (correcto).

### 6.6 Microcopy

| Elemento | Texto exacto | Contexto |
|----------|--------------|----------|
| Banner demo (existente) | "Modo demo (sin dinero real)" | Sin cambios; ahora también dispara por payout mock y en `verify`. |
| TrackView — fallo/reembolso (título) | "No pudo entregarse" | Header del branch AC-1 (reemplaza "Tu chaski está en camino…" para failed/refunded). |
| TrackView — fallo/reembolso (cuerpo) | `humanError("payout_failed")` → "No se pudo entregar. Si te cobramos, te reembolsamos." | Copy PII-free reusado (CD-5). |

> [TBD no-bloqueante] el título exacto ("No pudo entregarse" vs "Hubo un problema con el envío") es
> cosmético y no cambia ninguna AC; se ajusta en F3/gate. El cuerpo (de `humanError`) es fijo.

---

## 7. Constraint Directives (Anti-Alucinación)

### Heredados del work-item
- **CD-1 (CRÍTICA)**: PROHIBIDO agregar `"payout_failed"` a `TERMINAL_STATUSES` (`remittance.ts:99`).
  El stop del polling es UI-only (DT-3).
- **CD-2**: OBLIGATORIO que `payoutProvenance` sea `string | null` con default `null`; una remesa
  legacy sin el campo NUNCA lanza — `normalizeState` la defaultea (patrón `ownerAddress`/`version`) y
  `isPayoutDemo` usa `p != null` (cubre `undefined`).
- **CD-3**: PROHIBIDO tocar `confirm_requires_kyc_passed` (`remittance.ts:219-222`) o
  `authority.authorize()` en `confirm-and-send.ts`.
- **CD-4**: PROHIBIDO cambiar CUÁNDO se transiciona a `payout_failed`/`refunded` — `failAndRefund`
  (en `confirm-and-send.ts` y `track-remittance.ts`) queda byte-idéntico; sólo se agregan args de
  provenance a `markSettled`/`markPayoutSubmitted` en el path de éxito.
- **CD-5**: OBLIGATORIO que el copy nuevo de `TrackView` sea PII-free — NUNCA interpolar
  `beneficiary`/`failureReason` crudo; usar `humanError()` (enum→copy fijo).

### Nuevos de este SDD
- **CD-6 (de auto-blindaje WKH-187)**: OBLIGATORIO correr la suite COMPLETA al cerrar cada wave. Al
  agregar `payoutProvenance`/`provenance` (shape compartido), grepear TODOS los sitios:
  `grep -rn "markPayoutSubmitted\|markSettled" src`, `grep -rn "status: \"submitted\"\|status: \"settled\"" src/**/*.test.ts`,
  `grep -rn "toEqual({ payoutId" src`. No confiar sólo en los line-anchors de este SDD.
- **CD-7 (de auto-blindaje WKH-186)**: al tocar `FakePayoutGateway`/literales de `PayoutRecord`,
  agregar `provenance` SIN alterar `deliveredPen` (debe seguir consistente con el `receive` del quote
  fake, o la reconciliación de WKH-186 refundeará y romperá el happy-path). Sitios de `PayoutRecord`
  inline a actualizar: `fakes.ts` (`FakePayoutGateway` x2), `a2a/gateways.ts` (`status` cache-miss),
  `a2a/gateways.test.ts` (`expect(rec).toEqual({...})` L83), y cualquier `PayoutRecord` construido en
  `confirm-and-send.test.ts`/`track-remittance.test.ts`/`use-cases.test.ts`.
- **CD-8 (matching)**: el eje demo del payout usa `REAL_PAYOUT_PROVENANCES = new Set(["transfi"])`
  (allowlist de REAL, fail-safe). PROHIBIDO invertirlo a una lista de mocks. NO cambiar el match
  exacto `=== "local-fallback"` de quote/kyc (fuera de scope).
- **CD-9 (scope)**: PROHIBIDO tocar archivos fuera de `chaski-v2/` (`wasiai-remittance-agents` es
  SOLO lectura de contrato), y fuera de los archivos de §6.1. No refactorizar código adyacente.
- **CD-10 (coordinación de merge)**: este SDD asume `main` **post-WKH-198 y post-WKH-201**. WKH-198
  toca `remittance.ts` (guard NaN en `isQuoteExpired`) y `a2a/gateways.ts` (`isValidQuoteShape`) —
  funciones DISTINTAS de las de esta HU (sin conflicto lógico, posible conflicto textual). WKH-201
  toca `ports.ts` (`clearByOwner`) y `persistence.ts` (`clearByOwner`) — miembros DISTINTOS de los de
  esta HU. Merge de WKH-200 **último**; re-basar sobre el estado final antes de F3.

### PROHIBIDO (resumen)
- Agregar `payout_failed` a `TERMINAL_STATUSES` (CD-1).
- Tocar `TRANSITIONS`, `confirm()`, `failAndRefund`, la autoridad WKH-180 (CD-3/CD-4).
- Interpolar PII en el copy (CD-5).
- Invertir el matching a allowlist de mocks (CD-8).
- Tocar archivos fuera de §6.1 / fuera de `chaski-v2/` (CD-9).

---

## 8. Waves de implementación

### Wave 0 (Serial Gate — contratos/shape + tests que fallan primero)
- [ ] **W0.1**: `ports.ts` — `PayoutRecord.provenance: string`. `remittance.ts` — `RemittanceState.payoutProvenance: string | null` + `create()` `null` + firmas de `markPayoutSubmitted`/`markSettled` (trailing optional). Verificación: `typecheck` (romperá los literales de `PayoutRecord` → esperado, se arreglan en W1).
- [ ] **W0.2**: escribir/ajustar tests (§9) que fijan el comportamiento observable de cada AC. Rojo esperado pre-impl.

### Wave 1 (Implementación — depende de W0; paralelizable por archivo)
- [ ] **W1.1** (infra shape): `a2a/gateways.ts` (`mapResultToPayoutRecord` + status cache-miss) + `fallback/gateways.ts` + `fakes.ts` (`FakePayoutGateway`). CD-7.
- [ ] **W1.2** (persistencia): `persistence.ts` `normalizeState` default `null`. CD-2.
- [ ] **W1.3** (use-cases): `confirm-and-send.ts` (L111/L120) + `track-remittance.ts` (L52) pasan `rec.provenance`. CD-4 (sólo el path de éxito).
- [ ] **W1.4** (vm): `flow-vm.ts` `REAL_PAYOUT_PROVENANCES` + `isPayoutDemo` + `isDemoMode`. CD-8.
- [ ] **W1.5** (UI): `flow.tsx` — branch AC-1 en `TrackView`, `||` AC-2 en el poll, `||` AC-4 en el banner.

### Wave 2 (Verificación final)
- [ ] **W2.1**: `npm run qa` (typecheck + suite COMPLETA). CD-6: cero rojos, cero tests validando el shape viejo. Re-basar sobre `main` post-198/201 antes de mergear (CD-10).

---

## 9. Test Plan (≥1 test por AC)

> Notas de auto-blindaje: (a) tests RTL de esta HU no dependen de expiry, pero si un snapshot necesita
> quote vigente, usar `expiresAt` futuro REAL, no `QUOTE_EXPIRES` (WKH-187#3). (b) El test de polling
> (AC-2) usa fake timers: anclar con `await act(async () => { await vi.advanceTimersByTimeAsync(1); })`
> antes del gran avance (WKH-188#1).

| Test | AC | Archivo | Descripción | Aserciones clave |
|------|-----|---------|-------------|------------------|
| `T-AC1a: payout_failed → branch de reembolso, no "en camino"` | AC-1 | `flow.test.tsx` | Render `RemittanceFlow` con container cuyo `trackRemittance`/`confirmAndSend` deja la remesa en `payout_failed`, `step==="track"`. | `getByText(/No se pudo entregar/)` visible; `queryByText(/Tu chaski está en camino/)` es `null`; sin steps de progreso. |
| `T-AC1b: refunded → branch de reembolso` | AC-1 | `flow.test.tsx` | Ídem con `refunded`. | mismo branch visible; `queryByText(/en camino/)` `null`. |
| `T-AC2: poll se detiene en payout_failed sin tocar TERMINAL_STATUSES` | AC-2 | `flow.test.tsx` | `buildTestContainer({useCases:{trackRemittance:{execute: spy → snapshot payout_failed (isTerminal=false)}}})`, `step==="track"`, fake timers. Avanzar 1 ms (anclar), capturar call-count, avanzar 6000 ms. | tras el 1er tick, `clearInterval` → `trackRemittance.execute` call-count NO crece en avances posteriores; el branch AC-1 queda visible. |
| `T-AC3a: isDemoMode true por payoutProvenance mock aun con quote/kyc reales` | AC-3/AC-5 | `flow-vm.test.ts` | `rem = {quote:{provenance:"didit"}, kyc:{provenance:"didit"}, payoutProvenance:"local-fallback"}`. | `isDemoMode(rem)` === `true`. |
| `T-AC3b: transfi → false; null (legacy) → false` | AC-3/AC-5 | `flow-vm.test.ts` | `payoutProvenance:"transfi"` con quote/kyc reales → `false`; `payoutProvenance:null` → `false`; `payoutProvenance` ausente (undefined) → `false`. | 3 asserts. |
| `T-AC3c: banner "Modo demo" visible en track/done con payout mock` | AC-3 | `flow.test.tsx` | Render con remesa `settled`/`track`, quote/kyc `"didit"`, `payoutProvenance:"local-fallback"`. | `getByText(/Modo demo/)` visible en `track` y en el `Receipt` (`done`). |
| `T-AC4: banner visible en step verify si isDemoMode` | AC-4 | `flow.test.tsx` | Llevar el flujo a `verify` con una remesa demo (quote fallback). | `getByText(/Modo demo/)` visible mientras `step==="verify"`. |
| `T-AC5a: markPayoutSubmitted persiste payoutProvenance y se conserva al settled` | AC-5 | `remittance.test.ts` | `r.markPayoutSubmitted("p1", T0, "local-fallback")` → snapshot; `r.markSettled("0x", Money.of(1480,"PEN"), T0)` (sin provenance). | `snapshot.payoutProvenance === "local-fallback"` tras submit Y tras settled (conservado por `to()`). |
| `T-AC5b: markSettled backfillea payoutProvenance cuando se provee` | AC-5 | `remittance.test.ts` | Remesa en `payout_submitted` sin provenance → `markSettled(..., T0, "local-fallback")`. | `snapshot.payoutProvenance === "local-fallback"`. |
| `T-AC5c: mapResultToPayoutRecord propaga provenance` | AC-5 | `a2a/gateways.test.ts` | Actualizar `expect(rec).toEqual({...})` (L83) para incluir `provenance:"remit-cashout-payout"`; nuevo assert `rec.provenance` en el caso settled. | `rec.provenance` presente y correcto. |
| `T-AC5d: confirm-and-send propaga rec.provenance al estado` | AC-5 | `confirm-and-send.test.ts` | `FakePayoutGateway({}, {provenance:"local-fallback"})` en el happy-path. | `snapshot.payoutProvenance === "local-fallback"`. |
| `T-AC5e: track-remittance propaga rec.provenance al settled` | AC-5 | `track-remittance.test.ts` | Remesa en `payout_submitted`; `status()` devuelve `provenance:"local-fallback"`. | `snapshot.payoutProvenance === "local-fallback"`. |
| `T-AC5f: legacy sin payoutProvenance normaliza a null (no crash)` | AC-5/CD-2 | `persistence.test.ts` | Persistir un snapshot legacy sin `payoutProvenance`; `get()`. | `snapshot.payoutProvenance === null`; sin throw. |

> Fallback gateway: `src/infrastructure/fallback/gateways.ts` no tiene test dedicado hoy; su
> `provenance:"local-fallback"` queda cubierto por el tipo (compile) y por `FakePayoutGateway`. No se
> crea un test-file nuevo (no-bloqueante).

---

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| [RESUELTO] | §3 | String de `provenance` bajo `PAYOUT_ALLOW_MOCK` = `"local-fallback"`; matching = allowlist fail-safe de reales (`{"transfi"}`). Resuelto leyendo `wasiai-remittance-agents`. | — |
| [RESUELTO] | §5/DT-1 | Nombre del campo: `payoutProvenance`. | — |
| [TBD] | §6.6 | Título cosmético del branch de fallo ("No pudo entregarse"). No cambia ACs. | No |

> Gate: ningún marker bloqueante. Listo para SPEC_APPROVED.

---

## 11. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Agregar `provenance` requerido a `PayoutRecord` rompe literales inline no anchoreados | A | M | CD-6/CD-7: grep exhaustivo + suite completa. §6.1 enumera los sitios conocidos. |
| Fake de payout con provenance rompe la reconciliación (deliveredPen inconsistente) | B | M | CD-7: no alterar `deliveredPen` al agregar `provenance` (auto-blindaje WKH-186). |
| Conflicto textual de merge con WKH-198 en `remittance.ts`/`a2a/gateways.ts` | M | B | CD-10: merge último, re-basar; funciones distintas (isQuoteExpired vs mark*; isValidQuoteShape vs mapResultToPayoutRecord). |
| Test de polling flakea por anclaje de fake timers | M | B | §9 nota: `advanceTimersByTimeAsync(1)` primero (auto-blindaje WKH-188#1). |
| Banner demo espurio en remesa real por typo de allowlist | B | B | DT-4 es fail-safe hacia over-warn (nunca hacia ocultar); `"transfi"` verificado en el contrato. |
| Regresión del gate de compliance / money-path | B | A | CD-1/CD-3/CD-4: sólo presentación + args de provenance en el path de éxito; `failAndRefund`/`confirm`/`TRANSITIONS` intactos. |

---

## 12. Dependencias
- `main` post-WKH-178..188 (todas DONE) + **post-WKH-198 y WKH-201** (mismo batch, mergean antes).
- Harness de tests WKH-185 (`buildTestContainer`, fake timers, jsdom) — disponible.
- Contrato de `remit-cashout-payout` (`wasiai-remittance-agents`) — SOLO lectura, ya verificado (§3).

---

## 13. Readiness Check

```
READINESS CHECK — SDD #200:
[x] Cada AC (1..5) tiene ≥1 test asociado (§9: T-AC1a..T-AC5f) y archivo asociado (§6.1)
[x] Cada archivo en §6.1 tiene Exemplar verificado (paths confirmados con Read)
[x] [NEEDS CLARIFICATION] del work-item RESUELTO leyendo el contrato del agente (§3) — no bloqueante restante
[x] Constraint Directives incluyen ≥3 PROHIBIDO (CD-1, CD-3, CD-4, CD-8, CD-9)
[x] Context Map tiene ≥2 archivos leídos (13 chaski-v2 + 4 agente + 4 auto-blindaje)
[x] Scope IN y OUT explícitos y no ambiguos (§2 + §6.1)
[x] BD: N/A declarado (solo localStorage; campo string/null sin migración de serialización)
[x] Happy Path completo (§6.4) + Flujo de fallo/borde (§6.5: legacy, typo, transfi, payout_failed congelado)
[x] Matching de provenance decidido con valor concreto (REAL_PAYOUT_PROVENANCES = {"transfi"}, §3/DT-4/CD-8)
[x] Aprendizaje histórico incorporado como CD (CD-6 WKH-187, CD-7 WKH-186; §9 notas WKH-188/187)
[x] Coordinación de merge documentada (CD-10: último, post-198/201)
```

READY FOR SPEC_APPROVED — sin TBDs bloqueantes.

---

*SDD generado por NexusAgil — F2 (full). Architect: nexus-architect.*
