# Story File — #200: Estados de fallo/reembolso honestos en TrackView + banner "Modo demo" que cubre el payout-mock

> SDD: doc/sdd/014-wkh-200-track-honesty-payout-mock-banner/sdd.md
> Work Item: doc/sdd/014-wkh-200-track-honesty-payout-mock-banner/work-item.md
> Fecha: 2026-07-14
> Branch: fix/200-track-status-honesty-demo-banner
> Repo: `chaski-v2` (NO tocar `wasiai-remittance-agents` — es solo lectura de contrato)
> **Orden de merge: ÚLTIMO** del batch 198/199/200/201. Este Story File asume `main` **post-WKH-198 y post-WKH-201 ya mergeados**. Antes de F3: `git rebase` sobre el `main` final (ver Wave -1).

---

## Goal

Cuatro sub-fixes de honestidad de estado/demo en `chaski-v2`, todos de **presentación y propagación de shape**, ninguno de money-path:

1. **AC-1** — `TrackView` muestra "Tu chaski está en camino…" (steps grises, sin rama de error) para remesas en `payout_failed`/`refunded` porque `order.indexOf(status)` es `-1`. Fix: branch temprano de reembolso.
2. **AC-2** — el polling de `flow.tsx` solo se corta con `r.isTerminal`; `payout_failed` NO es terminal → loop infinito de 1.5s. Fix: `clearInterval` también en `payout_failed`, **UI-only** (sin tocar `TERMINAL_STATUSES`).
3. **AC-3/AC-5** — `isDemoMode` solo mira `quote`/`kyc`; con adapter `a2a` real + Didit real + agente de payout en `PAYOUT_ALLOW_MOCK`, el recibo se ve "Entregado" sin aviso de mock. Fix: propagar la `provenance` del payout hasta un campo `payoutProvenance` en `RemittanceState` e incluirlo en `isDemoMode` (allowlist fail-safe de proveniencias REALES).
4. **AC-4** — el banner excluye `step === "verify"` → parpadea 1 paso. Fix: agregar `|| step === "verify"`.

**Regla dorada del batch:** `TRANSITIONS`, `TERMINAL_STATUSES`, `confirm()`, `failAndRefund`, la autoridad WKH-180 y `deliveredPen` quedan **byte-idénticos**. Solo cambia la PRESENTACIÓN del estado ya alcanzado + la propagación de un campo nuevo.

---

## Acceptance Criteria (EARS)

> Copiados del SDD aprobado. QA los verifica en F4.

- **AC-1** (Unwanted): IF `rem.status ∈ {payout_failed, refunded}` WHILE `step === "track"`, THEN el sistema SHALL renderizar una vista de reembolso/fallo (reusando el copy de `humanError("payout_failed")`, PII-free), NO la vista optimista con steps en progreso.
- **AC-2** (Event-driven): WHEN el polling recibe `rem.status === "payout_failed"`, el sistema SHALL `clearInterval` sin depender de `TERMINAL_STATUSES` del dominio.
- **AC-3** (State-driven): WHILE la provenance del payout indica un desembolso NO real (mock), el sistema SHALL mostrar el Pill "Modo demo (sin dinero real)" en `track`/`done` — aun con `quote.provenance`/`kyc.provenance` reales.
- **AC-4** (State-driven): WHILE `step === "verify"` AND `isDemoMode(rem)` es `true`, el sistema SHALL mostrar el Pill "Modo demo".
- **AC-5** (Ubiquitous): el sistema SHALL propagar la `provenance` del `PayoutRecord` hasta un campo persistido y legible desde la UI (`payoutProvenance` en `RemittanceState`), sin alterar `TRANSITIONS`/`TERMINAL_STATUSES` ni el resto del shape existente.

---

## Contrato de shape del agente (payout provenance) — resuelto, SOLO lectura

> Verificado en `wasiai-remittance-agents` (repo hermano, NO se toca). Fija los valores concretos del matching.

| Modo del agente `remit-cashout-payout` | `provenance` que llega a chaski-v2 |
|----------------------------------------|-----------------------------------|
| `PAYOUT_ALLOW_MOCK=true` / dev fallback (`FallbackPayoutProvider`) | `"local-fallback"` |
| Real (`TransFiPayoutProvider`) | `"transfi"` |
| KYC-gate bloqueado (no ejecuta) | `"n/a"` |

**Matching (DT-4, CD-8):** demo ⇔ `payoutProvenance` **no-null y NO ∈ `REAL_PAYOUT_PROVENANCES`**.
`REAL_PAYOUT_PROVENANCES = new Set(["transfi"])`. Es allowlist de REALES (fail-safe): cualquier valor
desconocido/typo cae del lado seguro → **muestra** el banner (over-warn), nunca lo oculta. Exemplar del
patrón: `REAL_KYC_PROVENANCES = new Set(["didit"])` en el agente KYC. El raw shape `RawPayoutResult.provenance`
(`a2a/gateways.ts:34`) ya existe y `isValidPayoutShape` ya lo valida como `string` en producción real.

---

## Files to Modify/Create

> **CD-9**: PROHIBIDO tocar cualquier archivo fuera de esta tabla o fuera de `chaski-v2/`. No refactorizar código adyacente.
> **Las líneas son referencia post-estado-actual**; tras el rebase 198/201 pueden desplazarse. Localizá por símbolo, no por número de línea. Grep obligatorio (CD-6) antes de asumir que la lista está completa.

**Producción (8):**

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/application/ports.ts` | Modificar | `PayoutRecord` gana `provenance: string` (**requerido**, no opcional). Va tras `failureReason`. | shape `PayoutRecord` existente (L71-77) |
| 2 | `src/domain/remittance.ts` | Modificar | (a) `RemittanceState` gana `payoutProvenance: string \| null`. (b) `create()` lo inicializa en `null`. (c) `markPayoutSubmitted(payoutId, now, payoutProvenance?)` y `markSettled(payoutTx, deliveredPen, now, payoutProvenance?)` — param **trailing opcional tras `now`**, escrito en el `patch` **solo si `!== undefined`**. **NO tocar** `TRANSITIONS`/`TERMINAL_STATUSES`/`confirm`/`markPayoutFailed`/`markRefunded`. | Exemplar 1 (`to()`, `create`, `mark*`) |
| 3 | `src/infrastructure/a2a/gateways.ts` | Modificar | (a) `mapResultToPayoutRecord` copia `provenance: result.provenance`. (b) `A2aPayoutGateway.status` cache-miss (record fabricado, L146-152) agrega `provenance: ""` (nunca settlea → cosmético). | Exemplar 3 (mapeo existente) |
| 4 | `src/infrastructure/fallback/gateways.ts` | Modificar | `FallbackPayoutGateway.submit` **y** `status` agregan `provenance: "local-fallback"`. | `FallbackQuoteGateway` provenance (L58) |
| 5 | `src/application/use-cases/confirm-and-send.ts` | Modificar | `markPayoutSubmitted(rec.payoutId, this.clock.nowIso(), rec.provenance)` (L111) y `markSettled(rec.txRef ?? "", rec.deliveredPen, this.clock.nowIso(), rec.provenance)` (L120). **NO tocar** `failAndRefund`, `confirm`, `authorize`, la reconciliación. | llamadas existentes |
| 6 | `src/application/use-cases/track-remittance.ts` | Modificar | `markSettled(rec.txRef ?? "", rec.deliveredPen, this.clock.nowIso(), rec.provenance)` (L52). **NO tocar** `failAndRefund` ni el guard L36. | llamada existente |
| 7 | `src/presentation/flow-vm.ts` | Modificar | Agregar `const REAL_PAYOUT_PROVENANCES = new Set(["transfi"])` + helper `isPayoutDemo(p: string \| null \| undefined): boolean` (`p != null && !REAL_PAYOUT_PROVENANCES.has(p)`); `isDemoMode` suma `|| isPayoutDemo(rem.payoutProvenance)`. **NO cambiar** el match exacto `=== "local-fallback"` de quote/kyc (CD-8). | Exemplar 2 (`isDemoMode`) |
| 8 | `src/presentation/flow.tsx` | Modificar | (AC-1) branch temprano en `TrackView`; (AC-2) `if (r.isTerminal || r.status === "payout_failed")` en el poll (L332); (AC-4) banner L403 suma `|| step === "verify"`. | Exemplar 4 |

**Persistencia legacy (1, dentro de Scope IN por CD-2):**

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 9 | `src/infrastructure/persistence.ts` | Modificar | `normalizeState` (L45-51) defaultea `payoutProvenance: typeof s.payoutProvenance === "string" ? s.payoutProvenance : null`. | patrón `ownerAddress`/`version` (L47-49) |

**Test-support (1, NO es producción pero DEBE actualizarse):**

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 10 | `src/test-support/fakes.ts` | Modificar | `FakePayoutGateway.submit` **y** `status` agregan `provenance: "fake"` (default), SIN alterar `deliveredPen` (debe seguir `Money.of(1478.15,"PEN")` en `status`). CD-7. | `FakePayoutGateway` (L186-214) |

**Tests (7):**

| # | Archivo | Acción | Qué hacer |
|---|---------|--------|-----------|
| 11 | `src/domain/remittance.test.ts` | Modificar | T-AC5a, T-AC5b (ver Test Expectations). |
| 12 | `src/infrastructure/a2a/gateways.test.ts` | Modificar | T-AC5c: actualizar `expect(rec).toEqual({...})` (L83) para incluir `provenance:"remit-cashout-payout"`; assert `rec.provenance` en el caso settled. |
| 13 | `src/application/use-cases/confirm-and-send.test.ts` | Modificar | T-AC5d + actualizar cualquier `PayoutRecord` inline (grep CD-6). |
| 14 | `src/application/use-cases/track-remittance.test.ts` | Modificar | T-AC5e + actualizar `PayoutRecord` inline (grep). |
| 15 | `src/presentation/flow-vm.test.ts` | Modificar | T-AC3a, T-AC3b. |
| 16 | `src/presentation/flow.test.tsx` | Modificar | T-AC1a, T-AC1b, T-AC2, T-AC3c, T-AC4. |
| 17 | `src/infrastructure/persistence.test.ts` | Modificar | T-AC5f (legacy sin `payoutProvenance` → `null`). |

---

## Exemplars

### Exemplar 1: dominio — `to()`, `create`, familia `mark*`
**Archivo**: `src/domain/remittance.ts`
**Usar para**: Archivo #2.
**Patrón clave**:
- `to(next, now, patch = {})` hace `this.state = { ...this.state, ...patch, status: next, updatedAt: now }` (L191-196). Un campo puesto en un `patch` **persiste** en transiciones siguientes → por eso `payoutProvenance` seteado en `markPayoutSubmitted` sobrevive al `markSettled`.
- Firmas actuales: `markPayoutSubmitted(payoutId: string, now: string)` (L231), `markSettled(payoutTx: string, deliveredPen: Money | null, now: string)` (L234). El nuevo param va **al final** (`now`-último se mantiene como último-de-los-obligatorios; el opcional trailing es la convención pedida).
- Set condicional obligatorio: construir el `patch` de forma que el campo **solo** aparezca cuando el arg no es `undefined` (para no pisar el valor previo en un backfill parcial). Ej: `const patch = { payoutId, ...(payoutProvenance !== undefined ? { payoutProvenance } : {}) }`.
- `create()` (L157-174) inicializa TODOS los campos explícitamente → agregar `payoutProvenance: null` ahí.

### Exemplar 2: VM — `isDemoMode`
**Archivo**: `src/presentation/flow-vm.ts` (L6-8)
**Usar para**: Archivo #7.
```ts
export function isDemoMode(rem: RemittanceState): boolean {
  return rem.quote?.provenance === "local-fallback" || rem.kyc?.provenance === "local-fallback";
}
```
**Patrón clave**: funciones puras, sin deps de UI. Match exacto para quote/kyc — **NO cambiarlo**. El eje payout usa el helper fail-safe nuevo. Mantener el tipado sin `any`.

### Exemplar 3: infra — `mapResultToPayoutRecord`
**Archivo**: `src/infrastructure/a2a/gateways.ts` (L83-91)
**Usar para**: Archivo #3.
- `RawPayoutResult.provenance: string` ya existe (L34) y `isValidPayoutShape` ya lo garantiza en el path real. El mapeo hoy lo descarta; hay que copiarlo: `provenance: result.provenance`.
- El `status` cache-miss (L146-152) construye un `PayoutRecord` literal a mano → agregarle `provenance: ""` para que compile con el shape requerido.

### Exemplar 4: UI — `TrackView`, poll, banner
**Archivo**: `src/presentation/flow.tsx`
**Usar para**: Archivo #8.
- **Poll (L328-345)**: hoy `if (r.isTerminal) { clearInterval(iv); pollRef.current = false; if (r.status === "settled") setStep("done"); }`. Cambiar el guard a `if (r.isTerminal || r.status === "payout_failed")`. El `setStep("done")` sigue gateado solo por `settled` (NO agregar navegación nueva). CD-1: **no** tocar `TERMINAL_STATUSES`.
- **Banner (L403)**: `rem && isDemoMode(rem) && (step === "review" || step === "confirm" || step === "track")` → agregar `|| step === "verify"`.
- **`TrackView` (L727-767)**: hoy calcula `order`/`idx` y renderiza el header fijo "Tu chaski está en camino…" (L739) + la `<ol>` de `TRACK_STEPS`. Agregar **al tope del componente, antes de calcular `order`/`idx`**, un branch: si `rem.status === "payout_failed" || rem.status === "refunded"`, `return` una `<Card>` con:
  - Título fijo: `"No pudo entregarse"` (cosmético; ver TBD).
  - Cuerpo: `humanError("payout_failed")` → `"No se pudo entregar. Si te cobramos, te reembolsamos."` (PII-free, CD-5).
  - Opcional: mostrar `rem.refundTx` si existe (referencia sintética, NO PII). NUNCA interpolar `failureReason`/`beneficiary`.
  - Usar los mismos primitivos del archivo (`<Card>`, tipografía tailwind existente). `humanError` ya está importado (L18).

---

## Constraint Directives

### OBLIGATORIO
- **CD-2**: `payoutProvenance` es `string | null`, default `null`. Legacy sin el campo NUNCA lanza — `normalizeState` lo defaultea; `isPayoutDemo` usa `p != null` (cubre `undefined`).
- **CD-5**: el copy nuevo de `TrackView` es PII-free — usar `humanError()` (enum→copy fijo), nunca `beneficiary`/`failureReason` crudo.
- **CD-6**: correr la suite COMPLETA (`npm run test`) al cerrar cada wave. `provenance`/`payoutProvenance` son shape compartido → **grep exhaustivo** antes de dar por completa la lista:
  ```bash
  grep -rn "markPayoutSubmitted\|markSettled" src
  grep -rn "PayoutRecord" src
  grep -rn "status: \"submitted\"\|status: \"settled\"\|status: \"failed\"" src
  grep -rn "toEqual({ payoutId" src
  ```
  Todo literal de `PayoutRecord` construido inline necesita `provenance` (es requerido). No confiar solo en los line-anchors de este archivo.
- **CD-7**: al tocar `FakePayoutGateway` / literales de `PayoutRecord`, agregar `provenance` SIN alterar `deliveredPen` (el `status` fake debe seguir en tolerancia con el `receive` del quote fake, o la reconciliación de WKH-186 refundea y rompe el happy-path).
- **CD-8**: matching por `REAL_PAYOUT_PROVENANCES = new Set(["transfi"])` (allowlist de REALES). Quote/kyc siguen con match exacto `=== "local-fallback"`.
- **CD-10**: rebasar sobre `main` **post-198/201** antes de F3 (ver Wave -1). Las funciones que toca 198 (`isQuoteExpired`, `isValidQuoteShape`) y 201 (`clearByOwner`) son DISTINTAS de las de esta HU: sin conflicto lógico, posible conflicto textual → resolver conservando ambos.

### PROHIBIDO
- **CD-1 (CRÍTICA)**: agregar `"payout_failed"` a `TERMINAL_STATUSES` (`remittance.ts:99`). El stop del poll es UI-only.
- **CD-3**: tocar `confirm_requires_kyc_passed` (`remittance.ts:220-222`) o `authority.authorize()` en `confirm-and-send.ts`.
- **CD-4**: cambiar CUÁNDO se transiciona a `payout_failed`/`refunded` — `failAndRefund` byte-idéntico en ambos use-cases. Solo se agregan args de provenance en el **path de éxito** (`markPayoutSubmitted`/`markSettled`).
- **CD-7 (deliveredPen)**: NO alterar `deliveredPen` en ningún fake/literal.
- **CD-8 (inversión)**: NO invertir el matching a una lista de mocks.
- **CD-9 (scope)**: NO tocar archivos fuera de la tabla ni fuera de `chaski-v2/`. `wasiai-remittance-agents` es SOLO lectura.
- NO agregar dependencias nuevas (ninguna es necesaria).
- NO tocar `TRANSITIONS`, `markPayoutFailed`, `markRefunded`, `confirm`.

---

## Test Expectations

> Framework: **Vitest + React Testing Library** (jsdom). Harness `buildTestContainer` (WKH-185). `framer-motion` mockeado pass-through en `flow.test.tsx`.
> Test-first (lógica/condicional/VM): SÍ. Los cambios de copy del título son cosméticos (no test-first del string exacto).

| Test | ACs | Archivo | Descripción | Aserción clave |
|------|-----|---------|-------------|----------------|
| T-AC1a | AC-1 | `flow.test.tsx` | Container deja la remesa en `payout_failed`, `step==="track"`. | `getByText(/No se pudo entregar/)` visible; `queryByText(/Tu chaski está en camino/)` es `null`. |
| T-AC1b | AC-1 | `flow.test.tsx` | Ídem con `refunded`. | mismo branch visible; `queryByText(/en camino/)` `null`. |
| T-AC2 | AC-2 | `flow.test.tsx` | `trackRemittance.execute` → snapshot `payout_failed` (`isTerminal=false`), `step==="track"`, fake timers. Anclar con `await act(async () => { await vi.advanceTimersByTimeAsync(1); })`, capturar call-count, avanzar 6000 ms. | tras el 1er tick el call-count NO crece (clearInterval); branch AC-1 visible. |
| T-AC3a | AC-3/5 | `flow-vm.test.ts` | `{quote:{provenance:"didit"}, kyc:{provenance:"didit"}, payoutProvenance:"local-fallback"}`. | `isDemoMode(rem) === true`. |
| T-AC3b | AC-3/5 | `flow-vm.test.ts` | `payoutProvenance:"transfi"` (quote/kyc reales) → `false`; `null` → `false`; ausente (`undefined`) → `false`. | 3 asserts. |
| T-AC3c | AC-3 | `flow.test.tsx` | Remesa `settled`/`track`, quote/kyc `"didit"`, `payoutProvenance:"local-fallback"`. | `getByText(/Modo demo/)` visible en `track` y en el `Receipt`. |
| T-AC4 | AC-4 | `flow.test.tsx` | Flujo en `step==="verify"` con remesa demo (quote fallback). | `getByText(/Modo demo/)` visible mientras `verify`. |
| T-AC5a | AC-5 | `remittance.test.ts` | `markPayoutSubmitted("p1", T0, "local-fallback")` → `markSettled("0x", Money.of(1480,"PEN"), T0)` (sin provenance). | `payoutProvenance === "local-fallback"` tras submit Y tras settled (conservado por `to()`). |
| T-AC5b | AC-5 | `remittance.test.ts` | Remesa en `payout_submitted` sin provenance → `markSettled(..., T0, "local-fallback")`. | `payoutProvenance === "local-fallback"` (backfill). |
| T-AC5c | AC-5 | `a2a/gateways.test.ts` | Actualizar `toEqual` (L83) con `provenance:"remit-cashout-payout"`; assert en el caso settled. | `rec.provenance` presente y correcto. |
| T-AC5d | AC-5 | `confirm-and-send.test.ts` | `FakePayoutGateway({}, {provenance:"local-fallback"})` en el happy-path. | `snapshot.payoutProvenance === "local-fallback"`. |
| T-AC5e | AC-5 | `track-remittance.test.ts` | Remesa en `payout_submitted`; `status()` devuelve `provenance:"local-fallback"`. | `snapshot.payoutProvenance === "local-fallback"`. |
| T-AC5f | AC-5/CD-2 | `persistence.test.ts` | Persistir snapshot legacy sin `payoutProvenance`; `get()`. | `snapshot.payoutProvenance === null`; sin throw. |

### Notas de fake-timers y RTL (auto-blindaje histórico)
- **AC-2 (poll)**: fake timers requieren anclar el `setInterval` con `await act(async () => { await vi.advanceTimersByTimeAsync(1); })` ANTES del gran avance, o el 1er tick no dispara (WKH-188#1).
- **RTL + expiry**: si un snapshot necesita quote vigente, usar un `expiresAt` **futuro REAL** (`new Date(Date.now()+...)`), NO el clock del container — `isQuoteStillValid` lee tiempo real en RTL (WKH-187#3). Los renders de esta HU (failed/refunded/settled) no dependen de expiry, pero el flujo hasta `verify` (T-AC4) sí puede.

---

## Waves

### Wave -1: Environment Gate (verificar ANTES de tocar código)
```bash
cd /home/ferdev/.openclaw/workspace/chaski-v2
git status                       # working tree limpio antes de rebase
npm install 2>/dev/null || echo "sin package.json"
# CD-10: rebasar sobre main POST-198/201 (este SDD asume ambas mergeadas)
git log --oneline -15 | grep -iE "WKH-198|WKH-201" || echo "REVISAR: 198/201 deben estar en la base antes de F3"
# archivos base del Scope IN existen
ls src/presentation/flow.tsx src/presentation/flow-vm.ts src/domain/remittance.ts \
   src/application/ports.ts src/infrastructure/a2a/gateways.ts \
   src/infrastructure/fallback/gateways.ts src/application/use-cases/confirm-and-send.ts \
   src/application/use-cases/track-remittance.ts src/infrastructure/persistence.ts \
   src/test-support/fakes.ts 2>/dev/null || echo "FALTA archivo base"
npm run typecheck                # baseline verde antes de empezar
```
**Si algo falla:** PARAR y escalar al orquestador. No implementar sobre una base sin 198/201 ni sobre un typecheck rojo previo.

### Wave 0 (Serial Gate — contratos/shape + tests rojos)
- [ ] W0.1: `ports.ts` (#1) `PayoutRecord.provenance: string`; `remittance.ts` (#2) `RemittanceState.payoutProvenance` + `create()` `null` + firmas `mark*` con trailing opcional. → `typecheck` romperá los literales de `PayoutRecord` (esperado, se arreglan en W1).
- [ ] W0.2: escribir/ajustar los tests de Test Expectations que fijan el comportamiento observable de cada AC (rojo esperado pre-impl).

### Wave 1 (Implementación — paralelizable por archivo, depende de W0)
- [ ] W1.1 (infra shape): `a2a/gateways.ts` (#3) + `fallback/gateways.ts` (#4) + `fakes.ts` (#10). CD-7.
- [ ] W1.2 (persistencia): `persistence.ts` (#9) default `null`. CD-2.
- [ ] W1.3 (use-cases): `confirm-and-send.ts` (#5) + `track-remittance.ts` (#6) pasan `rec.provenance`. CD-4 (solo path de éxito).
- [ ] W1.4 (vm): `flow-vm.ts` (#7) `REAL_PAYOUT_PROVENANCES` + `isPayoutDemo` + `isDemoMode`. CD-8.
- [ ] W1.5 (UI): `flow.tsx` (#8) branch AC-1, `||` AC-2 en poll, `||` AC-4 en banner. CD-1/CD-5.

### Wave 2 (Verificación final)
- [ ] W2.1: `npm run typecheck && npm run test` (suite COMPLETA). CD-6: cero rojos, cero tests validando el shape viejo. Confirmar rebase 198/201 aplicado (CD-10).

### Verificación incremental
| Wave | Verificación |
|------|-------------|
| W0 | `typecheck` (rojo esperado en literales `PayoutRecord`) + tests nuevos rojos |
| W1 | `typecheck` limpio + tests pasando incrementalmente |
| W2 | `npm run typecheck && npm run test` (QA completo) verde |

---

## Out of Scope

- `TERMINAL_STATUSES`, `TRANSITIONS`, `confirm()`, `failAndRefund`, `markPayoutFailed`, `markRefunded`, autoridad WKH-180 — intactos.
- `deliveredPen` en cualquier fake/literal — no tocar (CD-7).
- El match exacto `=== "local-fallback"` de quote/kyc en `isDemoMode` — no cambiar (CD-8).
- WKH-202 (enforcement del submit); `PAYOUT_ALLOW_MOCK` y la lógica del agente real; el repo `wasiai-remittance-agents`.
- NO "mejorar" código adyacente; NO agregar navegación/steps nuevos en el poll; NO refactors no solicitados.

---

## Escalation Rule

> Si algo no está en este Story File, Dev PARA y escala a Architect. No inventar, no asumir.

Escalar si:
- El rebase 198/201 genera un conflicto lógico (no meramente textual) en `remittance.ts`/`a2a/gateways.ts`/`ports.ts`/`persistence.ts`.
- El grep de CD-6 revela un productor de `PayoutRecord` no listado en la tabla y agregarle `provenance` implicaría cambiar comportamiento (`deliveredPen`, status, etc.).
- Un exemplar ya no existe tras el rebase, o una firma cambió.
- El título del branch de fallo (TBD cosmético "No pudo entregarse") necesita decisión: usar ese por default; NO bloquea ningún AC.

---

*Story File generado por NexusAgil — F2.5. Architect: nexus-architect.*
