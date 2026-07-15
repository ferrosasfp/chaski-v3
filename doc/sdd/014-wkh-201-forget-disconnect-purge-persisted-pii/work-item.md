# Work Item — [WKH-201] `forgetAndDisconnect` purga la PII persistida del beneficiario (completar el reset de WKH-184)

## Resumen
Hallazgo D de la auditoría adversarial #2. WKH-184 (commit `6633fad`) afirmó que el reset
"¿No sos vos? / Empezar de nuevo" borra la PII del beneficiario en un dispositivo compartido, pero
solo limpia el KYC-once (`KycStore`) + el pending + el estado React in-memory. El repositorio
persistido `chaski.remittances.v1` (`LocalRepo`, `src/infrastructure/persistence.ts`) **no se toca**:
retiene `beneficiary.name`, `beneficiary.destination` (celular Yape/CCI) y la identity reducida del
sender de la Persona A. `LocalRepo.list()` ya filtra por `ownerAddress` (mitigante parcial: la
Persona B no lo ve en la UI del historial), pero la PII sigue legible en `localStorage` en ese mismo
origen/dispositivo (devtools, XSS, otra app). Esta HU cierra el gap: el reset debe purgar de verdad
las remesas del owner en el repo persistido, no solo limpiar la copia visible en memoria.

## Sizing
- Modo de proceso: QUALITY (chaski-v2 sigue el pipeline completo NexusAgil)
- SDD_MODE: mini (1 método nuevo en 1 port + 1 impl en `LocalRepo` reusando `read()`/`write()`, 1
  parámetro nuevo en el constructor de `ForgetKyc` + 1 llamada best-effort adicional, wiring de 1
  línea en `container.ts`. Sin cambios de dominio, sin nuevas pantallas — `flow.tsx` no necesita
  cambios de lógica, solo sigue llamando al `ForgetKyc` ya extendido)
- Estimación: S
- Branch sugerido: `feat/201-forget-disconnect-purge-persisted-pii`

## Contexto verificado (F0 grounding, líneas reales al 2026-07-14, sobre `main` post WKH-178..188)

### El gap confirmado
- `src/application/use-cases/forget-kyc.ts:11-22` — `ForgetKyc.execute()` SOLO llama
  `this.kycStore.clear(input.address)` (línea 13) y `this.pending.clear()` (línea 18). No recibe ni
  conoce ningún `RemittanceRepository`.
- `src/presentation/flow.tsx:300-319` — `forgetAndDisconnect()` llama `c.forgetKyc.execute({address})`
  (línea 303) y luego solo resetea estado React local (`setAddress`, `setRem`, `setPreview`,
  `setRecipient`, `setDestination`, líneas 307-313). El comentario en línea 310-311 afirma
  explícitamente la intención ("Limpia la PII del beneficiario de la persona anterior... la persona B
  no debe aterrizar con el nombre/celular de A") pero solo limpia el `useState` del formulario, NO el
  repo persistido.
- `src/infrastructure/persistence.ts:1-13` — `LocalRepo` persiste en `localStorage["chaski.remittances.v1"]`
  (`KEY`, línea 13) el `RemittanceState` completo, incluyendo `beneficiary` (name/destination sin
  reducir — a diferencia de la identity del sender, que sí pasa por `toPersistedIdentity`) y la
  identity reducida (`kyc.identity`, ya sin documentNumber crudo desde WKH-181).
- `src/infrastructure/persistence.ts:114-121` — `list(address)` SÍ filtra por `ownerAddress`
  case-insensitive (mitigante de UI, no de storage). Es el ÚNICO método de lectura/borrado scopeado
  por owner que existe hoy en `LocalRepo`; NO hay ningún método de borrado (`clear`/`delete`/`purge`)
  en toda la clase.
- `src/application/ports.ts:120-125` — `RemittanceRepository` expone únicamente `save`, `get`,
  `list`. Ningún método de borrado en la interfaz — confirmado por lectura completa del archivo.

### Wiring existente (referencia para F2)
- `src/composition/container.ts:49` — `const repo = new LocalRepo();` ya instanciado una sola vez,
  reusado por `createRemittance`, `startKyc`, `resumeKyc`, `lockQuote`, `confirmAndSend`,
  `trackRemittance`, `listHistory` (líneas 80-89). El mismo `repo` es inyectable directo a `ForgetKyc`
  sin instanciar nada nuevo.
- `src/composition/container.ts:89` — `forgetKyc: new ForgetKyc(kycStore, pending)` — el punto exacto
  a extender con un tercer argumento `repo`.
- `src/test-support/fakes.ts:66-88` — `InMemoryRepo implements RemittanceRepository` (usado en tests
  de otros use-cases) tampoco tiene método de borrado — necesita el mismo método nuevo para que los
  tests de `ForgetKyc` puedan usar un fake real de repo.
- `src/application/use-cases/forget-kyc.test.ts:1-71` — el test suite actual solo cubre AC-1/2/3/5 de
  WKH-184 (KYC-once + pending); no hay ningún assert sobre el repo — confirma que el gap nunca fue
  ejercitado por tests.

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `forgetAndDisconnect` executes for a connected `address`, the system SHALL remove
  from the persisted remittance store (`chaski.remittances.v1`) every entry whose `ownerAddress`
  matches that `address` (case-insensitive, same normalization as `list()`), so that a subsequent
  `repo.list(address)` call for that same address returns an empty array.
- **AC-2**: WHEN the purge for `address` completes, the system SHALL NOT delete, modify, or read-leak
  any entry whose `ownerAddress` belongs to a DIFFERENT address — the purge SHALL be scoped
  exclusively to the currently connected wallet, mirroring the same scoping guarantee `list()`
  already provides (CD-5 of WKH-181).
- **AC-3**: WHEN the purge completes, no beneficiary PII (`beneficiary.name`, `beneficiary.destination`)
  nor sender identity belonging to entries owned by that `address` SHALL remain readable under the
  `chaski.remittances.v1` key in `localStorage` for that owner (i.e., the purge is a real delete of
  the persisted JSON blob, not just an in-memory/React state reset).
- **AC-4**: IF the repository purge fails (e.g., `localStorage` unavailable/quota exceeded — private
  browsing), THEN `ForgetKyc.execute()` SHALL NOT throw and the rest of the reset (KYC-once clear,
  pending clear) SHALL still run to completion — same best-effort/degrade-without-breaking pattern
  already used for `kycStore.clear` (AC-5 of WKH-184) and `pending.clear` (CD-8 of WKH-184).
- **AC-5**: WHEN `forgetAndDisconnect` executes with no storage failure, the existing happy-path
  behavior for KYC-once and pending SHALL remain unchanged (`kycStore.clear(address)` and
  `pending.clear()` SHALL still execute exactly as before this HU) — this fix is additive, not a
  replacement of the existing reset logic.

## Scope IN
- `src/application/ports.ts` — extender `RemittanceRepository` (líneas 120-125) con un método nuevo
  de borrado scopeado por owner (ej. `clearByOwner(address: string): Promise<void>`).
- `src/infrastructure/persistence.ts` — implementar el método nuevo en `LocalRepo`, reusando el
  patrón existente `read()`/`write()` (filtrar el `Map` excluyendo las entries cuyo `ownerAddress`
  matchea `address.toLowerCase()`, igual criterio que `list()` líneas 114-121).
- `src/application/use-cases/forget-kyc.ts` — agregar el repo como dependencia del constructor y
  llamar `clearByOwner(address)` en su propio `try/catch` best-effort (AC-4), sin alterar el orden ni
  el comportamiento de las dos llamadas existentes (AC-5).
- `src/composition/container.ts` — pasar el `repo` ya instanciado (línea 49) como tercer argumento a
  `new ForgetKyc(kycStore, pending, repo)` (línea 89).
- `src/test-support/fakes.ts` — agregar `clearByOwner` a `InMemoryRepo` (y, si el Architect lo decide
  en F2, un doble que falle en `clearByOwner` para el test defensivo de AC-4, análogo a
  `ThrowingClearKycStore`/`ThrowingClearKycPendingStore`).
- Tests: `src/application/use-cases/forget-kyc.test.ts` (nuevos casos AC-1/2/3/4), posiblemente
  `src/infrastructure/persistence.test.ts` si existe cobertura directa de `LocalRepo` (a confirmar en
  F2/F0 del Architect).

## Scope OUT
- El KYC-once (`KycStore`) y el pending (`KycPendingStore`) — WKH-184 ya los limpia correctamente, no
  se reabren.
- El filtrado owner-scoped de `list()` (`persistence.ts:114-121`) — se mantiene intacto, no se
  reemplaza ni se le agrega lógica.
- Cualquier otra clave de `localStorage` (`chaski.kyc.v1`, `chaski.kyc.pending`, etc.) — fuera de
  scope, ya cubiertas por WKH-184.
- Entries con `ownerAddress === null` (remesas abandonadas antes de conectar wallet/verificar) — NO
  se purgan por esta HU; no pertenecen a ningún owner conectado, mismo criterio de exclusión que
  `list()` ya aplica.
- Cifrado o hashing del contenido de `localStorage` — fuera de esta HU (mismo scope-out que
  WKH-181/WKH-184 sobre cifrado real sin key-management).
- Cualquier UI nueva (banner, confirmación, copy) — el control de reset ya existe (WKH-184); esta HU
  no cambia la UX, solo completa lo que el reset borra por debajo.
- El demo live (`yarvis`/`wasiai-v2`, fuera de `chaski-v2/`) — NO SE TOCA.

## Decisiones técnicas (DT-N)
- **DT-1 (forma del método nuevo)**: se recomienda `clearByOwner(address: string): Promise<void>` en
  `RemittanceRepository` (nombre simétrico a `list(address)`), implementado en `LocalRepo` reusando
  `read()`/`write()` — leer el `Map`, filtrar OUT las entries cuyo `ownerAddress` matchea, reescribir
  el resto. Evita instanciar un método de borrado por-id (más frágil, requiere que `ForgetKyc` conozca
  los ids de antemano); operar por owner es la forma correcta dado que el objetivo es "purgar TODO lo
  de esta wallet en este dispositivo".
- **DT-2 (inyección en `ForgetKyc`)**: se recomienda agregar el `repo` como TERCER argumento del
  constructor existente (`ForgetKyc(kycStore, pending, repo)`) en lugar de crear un use-case separado
  — el reset es conceptualmente una sola operación ("olvidar todo de esta address en este
  dispositivo"), y `container.ts` ya tiene el `repo` singleton disponible sin costo de wiring
  adicional. Cada limpieza (`kycStore`, `pending`, `repo`) debe seguir en su propio `try/catch`
  independiente (no un solo `try` envolviendo las tres) para que un fallo de storage en una NO impida
  que las otras dos corran — mismo patrón defensivo ya establecido en el archivo.
- **DT-3 (entries sin owner)**: `clearByOwner` NO debe tocar entries con `ownerAddress === null` —
  scoping estricto por match exacto de address, igual que `list()`. El Architect confirma este
  default en F2 si no hay objeción (ver Missing Inputs).

## Constraint Directives (CD-N)
- **CD-1**: OBLIGATORIO que `clearByOwner(address)` esté scopeado EXCLUSIVAMENTE a esa `address`
  (case-insensitive) — PROHIBIDO cualquier implementación que borre el `Map` completo, entries de
  otro owner, o entries con `ownerAddress === null` (AC-2). Mismo criterio de scoping que CD-5 de
  WKH-181 y CD-3 de WKH-184.
- **CD-2**: OBLIGATORIO que la purga del repo sea best-effort — si `clearByOwner` rechaza (storage
  roto), `ForgetKyc.execute()` NO debe rechazar ni impedir que `kycStore.clear`/`pending.clear` (o el
  reset de estado React en `flow.tsx`) sigan corriendo (AC-4). PROHIBIDO envolver las tres llamadas en
  un único `try` que aborte las siguientes ante el primer fallo.
- **CD-3**: PROHIBIDO tocar el filtrado owner-scoped de `list()` (`persistence.ts:114-121`) — se
  mantiene sin cambios (scope OUT).
- **CD-4**: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/`. PROHIBIDO tocar el demo live
  (`yarvis`, `wasiai-v2`, cualquier ruta bajo `agentshop-*`).
- **CD-5**: PROHIBIDO cambiar la firma o el comportamiento de `save`/`get`/`list` en
  `RemittanceRepository` — esta HU es estrictamente aditiva (un método nuevo), no debe introducir
  ninguna regresión en los use-cases existentes que ya dependen del repo (`createRemittance`,
  `startKyc`, `resumeKyc`, `lockQuote`, `confirmAndSend`, `trackRemittance`, `listHistory`).

## Missing Inputs
- `[NEEDS CLARIFICATION — no bloqueante, resolver en F2]` DT-3: confirmar que las entries con
  `ownerAddress === null` (remesa iniciada pero abandonada antes de conectar wallet) quedan
  explícitamente FUERA del purge — no tienen owner al que atribuirlas, y no son el vector de PII que
  reporta el hallazgo D (que es específicamente sobre remesas YA asociadas a la wallet de la Persona
  A). Default recomendado: no tocarlas.
- `[NEEDS CLARIFICATION — no bloqueante, resolver en F2]` si existe o no hoy un
  `persistence.test.ts` directo sobre `LocalRepo` (no confirmado en este F0) — si no existe, el
  Architect decide si esta HU lo crea o si la cobertura vive solo en `forget-kyc.test.ts` vía
  `InMemoryRepo`.

## Análisis de paralelismo
- Depende del estado ya mergeado de **WKH-178..188** (`main`), en particular WKH-184 (el reset que
  esta HU completa) y WKH-181/WKH-182 (últimas HUs que tocaron `persistence.ts`/`ports.ts` antes de
  esto). No reabre ningún gap ya cerrado por esas HUs — es puramente aditiva.
- Toca `src/application/ports.ts`, `src/infrastructure/persistence.ts`,
  `src/application/use-cases/forget-kyc.ts`, `src/composition/container.ts` y
  `src/test-support/fakes.ts`. Es una de 4 HUs de analyst paralelo del mismo backlog de auditoría
  adversarial #2 (WKH-198/199/200/201), cada una tocando archivos distintos hasta donde se pudo
  verificar en este F0: WKH-198 → `remittance.ts`/`wallet.ts`/`gateways.ts`/`quote/route.ts`;
  WKH-199 → `kyc-store.ts`/`resume-kyc.ts`/`start-kyc.ts`; WKH-200 → no verificado en este F0 (ver su
  propio work-item). Sin overlap directo detectado con WKH-198/199 sobre los archivos de esta HU;
  coordinar orden de merge con el Architect si eso cambia en F2.
- No bloquea ninguna otra HU conocida del backlog. Cierra formalmente el hallazgo D de la auditoría
  adversarial #2 sobre el reset de WKH-184.
- **Doble colisión de NNN detectada en F1** (carrera de 4 analysts paralelos sobre el mismo repo):
  primer intento `012` (tomado por WKH-198), segundo intento `013` (tomado por WKH-199 y WKH-200 en
  simultáneo) — esta HU se renumeró finalmente a `014`. Stubs obsoletos dejados en
  `doc/sdd/012-wkh-201-.../work-item.md` y `doc/sdd/013-wkh-201-.../work-item.md`, ambos apuntando
  acá.
- Branch: `feat/201-forget-disconnect-purge-persisted-pii` desde `main`.

## Waves sugeridas (para F3, referencia — el Architect define las definitivas en F2.5)
- **Wave 1**: `ports.ts` (`RemittanceRepository.clearByOwner`) + `persistence.ts`
  (`LocalRepo.clearByOwner` impl) + `fakes.ts` (`InMemoryRepo.clearByOwner`) + tests directos del
  método.
- **Wave 2**: `forget-kyc.ts` (tercer argumento `repo`, llamada best-effort) + `container.ts` (wiring)
  — depende de Wave 1.
- **Wave 3**: tests de integración de `ForgetKyc` (AC-1/2/3/4/5 completos, incluyendo el caso
  defensivo de storage roto en el repo) — depende de Wave 1 y 2.

## Evidencia de verificación F0

| Afirmación HU | Archivo:línea | Estado |
|---------------|---------------|--------|
| `ForgetKyc.execute()` solo llama `kycStore.clear`/`pending.clear`, no conoce el repo | `src/application/use-cases/forget-kyc.ts:11-22` | CONFIRMADO |
| `forgetAndDisconnect` solo resetea estado React, no purga el repo | `src/presentation/flow.tsx:300-319` | CONFIRMADO |
| `LocalRepo` persiste `beneficiary`/identity completos bajo `chaski.remittances.v1` | `src/infrastructure/persistence.ts:1-13,94-107` | CONFIRMADO |
| `list()` filtra por `ownerAddress` (mitigante de UI, no de storage) | `src/infrastructure/persistence.ts:114-121` | CONFIRMADO |
| `RemittanceRepository` no tiene ningún método de borrado | `src/application/ports.ts:120-125` | CONFIRMADO |
| `container.ts` ya tiene `repo` singleton inyectable directo a `ForgetKyc` | `src/composition/container.ts:49,89` | CONFIRMADO |
| `InMemoryRepo` (fake de test) tampoco tiene método de borrado | `src/test-support/fakes.ts:66-88` | CONFIRMADO |
| El test suite actual de `ForgetKyc` no ejercita el repo | `src/application/use-cases/forget-kyc.test.ts:1-71` | CONFIRMADO |
