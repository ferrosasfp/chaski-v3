# Work Item — [WKH-183] Higiene menor: pending-store huérfano, copy de errores, FX/Money, drift env

## Resumen
Backlog de higiene P3 de la auditoría adversarial 2026-07-10 sobre `chaski-v2` (post
WKH-178/179/180/181, todas ya en `main`). De los 8 hallazgos originales del ticket, el F0 de esta
HU confirma que **2 ya están resueltos** (por WKH-178 y WKH-181, sin relación directa con esta HU)
y **6 siguen vivos**: un bug real (KYC pendiente que puede quedar huérfano/bricked si
`localStorage` falla al escribir), 2 mejoras de robustez en `Money`/FX (cap de safe-int, doble
redondeo), 1 mejora de copy (errores de wallet caen a mensaje genérico), 1 documentación explícita
de un comportamiento intencional (`FallbackKycGateway` siempre aprueba), y 2 correcciones de drift
en `.env.example` (una var muerta documentada como viva, una var viva sin documentar).

## Sizing
- Modo de proceso: QUALITY (chaski-v2 sigue el pipeline completo NexusAgil, mismo criterio que
  WKH-178/179/180/181)
- SDD_MODE: mini (6 fixes acotados y en su mayoría independientes; toca 1 archivo de dominio
  puro (`money.ts`, sin I/O), 2 archivos de infra (`kyc-pending-store.ts`, `fallback/gateways.ts`),
  1 use-case (`start-kyc.ts`, reorder sin cambiar la máquina de estados), 1 archivo de presentación
  (`flow.tsx`, solo `humanError()`) y 1 archivo de docs (`.env.example`). Sin cambios de dominio
  (`RemittanceStatus`/`TRANSITIONS` no se tocan — ver CD-3), sin nuevos ports, sin nueva UI.
- Estimación: S
- Branch sugerido: `fix/183-higiene-pending-store-money-fx-copy-env`

## Contexto verificado (F0 grounding, líneas reales al 2026-07-11, sobre `main` post WKH-178/179/180/181)

### Ítems DESCARTADOS (ya resueltos por HUs previas — verificado, no se reabren)

1. **"Schema migration / `.slice` crash en `flow.tsx`" → RESUELTO por WKH-181.**
   - `chaski-v2/src/domain/remittance.ts:39-61` — WKH-181 introdujo `PersistedIdentity` (con
     `documentNumberLast4` ya reducido) + el reductor único `toPersistedIdentity()`.
   - `chaski-v2/src/presentation/flow.tsx:519` — el Review renderiza
     `rem.kyc.identity.documentNumberLast4` **directo** (campo ya-reducido), no hace
     `documentNumber.slice(-4)` sobre un valor potencialmente `undefined`. No hay crash posible por
     ese patrón.
   - `chaski-v2/src/infrastructure/persistence.ts:14-48` (`normalizeState`/`normalizeIdentity`) y
     `chaski-v2/src/infrastructure/kyc-store.ts:25-55` (mismo patrón) — YA manejan de forma
     defensiva cualquier snapshot legacy (pre-WKH-181) con `identity` en forma FULL
     (`documentNumber`/`dateOfBirth` crudos): detectan si `documentNumberLast4` está presente: si
     no, reducen con el mismo helper `toPersistedIdentity`. Lectura de un shape viejo NUNCA
     crashea. Confirmado con los tests existentes de `persistence.test.ts`/`kyc-store.test.ts`
     (AC-4 de WKH-181).
   - Conclusión: no queda ningún gap de "schema migration" ni de `.slice` sobre `undefined`
     pendiente. Se descarta de esta HU.

2. **"Test fake miente" → RESUELTO por WKH-178/181 (test ya alineado).**
   - `chaski-v2/src/application/use-cases.test.ts:184-206` (`"AC-12: flujo fallback... queda verde
     con identity REDUCIDA presente"`) — el test usa `FallbackKycGateway` REAL (no un doble) y
     asserta exactamente el shape actual: `firstName === "María Elena"` (fixture del fallback),
     `documentNumberLast4 === "6677"`, y `"documentNumber" in idn === false` (confirma que NO hay
     PII cruda). Este test refleja el comportamiento real de
     `chaski-v2/src/infrastructure/fallback/gateways.ts:72-89` byte a byte — no hay mentira ni
     drift entre el test y el código.
   - No se encontró ningún otro test bajo `src/**/*.test.ts` que asserte contra un comportamiento
     ya removido (grep de los 12 archivos `*.test.ts` existentes, ver lista completa abajo).
   - Conclusión: se descarta de esta HU.

### Ítems VIVOS (confirmados, en scope de esta HU)

#### V1 — `KycPendingStore` sin try/catch → KYC puede quedar HUÉRFANO/bricked (BLOQUEANTE, único bug real)
- `chaski-v2/src/infrastructure/kyc-pending-store.ts:8-10,21-23` — `save()` y `clear()` llaman
  `localStorage.setItem`/`removeItem` **sin try/catch** (a diferencia de `get()`, línea 11-20, que
  sí envuelve el `JSON.parse`). Si `setItem` lanza (quota excedida, Safari private-browsing con
  storage deshabilitado, extensiones que bloquean storage), la excepción escapa sin normalizar.
- `chaski-v2/src/application/use-cases/start-kyc.ts:59-67` — en la rama de `redirect` (Didit real),
  el ORDEN actual es: `await this.repo.save(r)` (línea 60, YA persiste la remesa en estado
  `kyc_pending`) **y DESPUÉS** `await this.pending.save({...})` (línea 61). Si el segundo `await`
  lanza (V1), la excepción se propaga y `execute()` rechaza — pero el `repo.save(r)` de la línea
  60 **ya corrió y ya persistió** `status: "kyc_pending"` en `localStorage["chaski.remittances.v1"]`.
- `chaski-v2/src/domain/remittance.ts:85-97` (`TRANSITIONS`) — `kyc_pending: ["kyc_passed",
  "kyc_failed"]` **NO incluye `"kyc_pending"` como destino válido**. Por lo tanto, si el usuario
  reintenta (click de nuevo en "Escanear DNI + selfie", `flow.tsx:478-486` → `onVerify` →
  `c.startKyc.execute(...)`), `StartKyc.execute()` vuelve a llamar `r.startKyc(...)`
  (`start-kyc.ts:33`), que internamente hace `this.to("kyc_pending", ...)`
  (`remittance.ts:169-171`) — y `canTransition("kyc_pending", "kyc_pending")` es `false`
  (`remittance.ts:101-103`) → **`throw new Error("invalid_transition:kyc_pending->kyc_pending")`**.
  **La remesa queda bloqueada para siempre**: ningún reintento del mismo flujo puede avanzar, y no
  hay ningún `KycPending` guardado para que `ResumeKyc` (`resume-kyc.ts:23-36`) la retome tampoco
  (porque `pending.get()` devuelve `null` — nunca se guardó). Este es el "huérfano" real: ni el
  camino forward (retry) ni el camino de resume funcionan.
- Confirmado que esto NO está cubierto por ningún test existente: `use-cases.test.ts` y
  `confirm-and-send.test.ts` no ejercitan un `KycPendingStore.save()` que falle.

#### V2 — Errores de wallet caen a copy genérico (MENOR, presentación)
- `chaski-v2/src/presentation/flow.tsx:637-643` (`humanError`) — solo mapea 3 familias de código
  (`quote_expired`/`QUOTE_STALE`, `kyc`, `payout`); cualquier otro código (incluidos los que lanza
  `wallet.ts`) cae al `return "Algo salió mal. Intentá de nuevo."` genérico.
- `chaski-v2/src/infrastructure/wallet.ts:20,23,34,101` — códigos específicos que hoy NO tienen
  copy dedicado: `"no_wallet"` (no hay provider inyectado), `"no_account"` (la wallet no devolvió
  cuentas), `"wallet_not_connected"` (se intentó firmar sin `connect()` previo). Los 3 son errores
  de usuario recuperables con una acción clara (instalar/desbloquear/reconectar la wallet), pero
  hoy el usuario solo ve "Algo salió mal. Intentá de nuevo." — sin pista de qué hacer.

#### V3 — `FallbackKycGateway` siempre aprueba (documentar, sin cambio de comportamiento)
- `chaski-v2/src/infrastructure/fallback/gateways.ts:63-90` — `FallbackKycGateway.simulated()`
  devuelve **siempre** `approved: true, payoutAllowed: true` (línea 75-76). El comentario de la
  clase (línea 64-65) explica QUÉ simula pero no deja explícito que **nunca rechaza**, lo cual es
  fácil de mal-interpretar como "simula ambos casos" al leer el código rápido. El comportamiento
  en sí es intencional y ya está contenido en producción por el gate server-side de WKH-180
  (`app/api/payout/validate/route.ts:26-42`: sin `DIDIT_API_KEY` + prod → 503 fail-loud, nunca
  autoriza por default) — esta HU NO cambia el comportamiento, solo lo documenta explícitamente
  para que quede imposible de mal-leer.

#### V4 — FX en float + doble redondeo (MENOR, robustez numérica)
- `chaski-v2/src/infrastructure/fallback/gateways.ts:45-60` (`FallbackQuoteGateway.requestQuote`)
  — línea 53: `receive: Money.of(Number((netUsd * rate).toFixed(2)), "PEN")`. Esto redondea DOS
  veces: (1) `.toFixed(2)` redondea `netUsd * rate` a 2 decimales como string, `Number(...)` lo
  reconvierte a float; (2) `Money.of()` (`money.ts:16-22`) hace `Math.round(major * factor)` con
  `factor = 100` para PEN — un segundo redondeo sobre un valor que HipotÉticamente ya debería estar
  "limpio" tras el paso 1, pero que en la práctica de floats (ej. `0.145` no es exactamente
  representable) puede no coincidir exactamente con lo que produciría un único redondeo directo de
  `netUsd * rate`. Es redundante y una fuente latente de divergencia de 1 centavo en casos límite.
  `Money.of()` ya es la única fuente de verdad de redondeo del dominio — el redondeo previo en el
  adapter es innecesario y debe eliminarse (dejar que `Money.of` reciba el float crudo).

#### V5 — `Money.of` sin safe-int cap (MENOR, robustez numérica)
- `chaski-v2/src/domain/money.ts:16-22` — `static of(major, currency)` valida `Number.isFinite` y
  `>= 0`, pero NO valida un techo. `Math.round(major * factor)` puede superar
  `Number.MAX_SAFE_INTEGER` (9007199254740991) para un `major` suficientemente grande (ej.
  `1e10` en USDC ya supera el safe-int tras `* 1e6`), y en ese caso el `minor` resultante pierde
  precisión SILENCIOSAMENTE (no lanza, el resultado es simplemente inexacto). El comentario del
  archivo (línea 2) asume "los montos de remesa caben holgados en Number safe-int" pero no hay
  ninguna guarda que lo haga cumplir — es una asunción no verificada en runtime.

#### V6 — Drift en `.env.example` (MENOR, documentación)
- `chaski-v2/.env.example:19-22` — documenta `NEXT_PUBLIC_KYC_MODE` como si controlara el flujo
  ("Activa el KYC REAL de Didit... Es NEXT_PUBLIC porque el composition root (cliente) decide qué
  adapter cablear"). **Esto ya no es cierto**: `chaski-v2/src/composition/container.ts:48-50`
  cablea `DiditKycGateway` incondicionalmente (con `FallbackKycGateway` como fallback interno del
  propio adapter, no del composition root) — el comentario en esa línea dice explícitamente
  *"Server-truth... No depende del inlineado NEXT_PUBLIC del cliente"*. Grep confirmado: cero
  matches de `NEXT_PUBLIC_KYC_MODE` en todo `src/**/*.ts(x)` — es una variable MUERTA que
  `.env.example` sigue documentando como si tuviera efecto (WKH-180 la dejó obsoleta sin
  actualizar el doc).
  - `chaski-v2/src/infrastructure/wallet.ts:130` — `pickWallet()` lee
    `process.env.NEXT_PUBLIC_REOWN_PROJECT_ID` (usada de verdad, gatea `WalletConnectWallet` vs
    `FallbackWallet` cuando no hay wallet inyectada) — **NO está documentada en
    `.env.example`** en absoluto. Drift inverso: variable VIVA sin documentar.

### Archivos revisados sin cambios necesarios (confirmado)
- `chaski-v2/src/application/ports.ts:56-60` — `KycPendingStore` ya tiene la firma correcta
  (`save`/`get`/`clear` retornan `Promise<void>`/`Promise<T|null>`); el fix de V1 no requiere
  cambiar el port, solo la implementación (`kyc-pending-store.ts`) y el orden de llamadas en
  `start-kyc.ts`.
- `chaski-v2/src/domain/remittance.ts` — TRANSITIONS/`RemittanceStatus` NO se tocan (ver CD-3): el
  fix de V1 se resuelve reordenando writes en la capa de aplicación, no ampliando la máquina de
  estados del dominio.
- `chaski-v2/src/infrastructure/persistence.ts` / `kyc-store.ts` — su manejo defensivo de legacy ya
  cubre el ítem descartado #1; no requieren cambios para esta HU.
- Lista completa de `*.test.ts` bajo `src/` revisada para el ítem descartado #2: `money.test.ts`,
  `flow-vm.test.ts`, `abandon-pending-kyc.test.ts`, `kyc-gateway.test.ts`, `rate-limit.test.ts`,
  `kyc-auth.test.ts`, `remittance.test.ts`, `confirm-and-send.test.ts`, `use-cases.test.ts`,
  `kyc-store.test.ts`, `persistence.test.ts`, `decision.test.ts` — ninguno asserta contra
  comportamiento ya removido.

## Acceptance Criteria (EARS)

### V1 — pending-store huérfano (BLOQUEANTE)
- **AC-1**: WHEN `LocalKycPendingStore.save()` or `.clear()` fails to write to `localStorage`
  (quota exceeded, storage disabled/private-browsing), the system SHALL catch the failure inside
  the adapter instead of letting an unnormalized exception propagate from `StartKyc.execute()`.
- **AC-2**: WHEN `StartKyc.execute()` takes the Didit-redirect path, the system SHALL persist the
  `KycPending` record (`pending.save()`) BEFORE persisting the remittance in `kyc_pending` status
  (`repo.save(r)`) — de forma que, si `pending.save()` falla, la remesa NO quede persistida en
  `kyc_pending` sin un `KycPending` correlacionable (evita el estado huérfano descrito en V1).
- **AC-3**: IF the redirect to Didit could not be prepared because the pending record failed to
  persist (AC-1/AC-2), THEN the system SHALL NOT navigate the user to Didit (`window.location.href`)
  — el flujo debe fallar de forma visible (error mostrado en la UI vía `guard()`) en vez de mandar
  al usuario a verificar una identidad que la app no podrá correlacionar al volver.
- **AC-4**: WHEN a user retries `StartKyc.execute()` for a remittance that failed to enter
  `kyc_pending` cleanly on a previous attempt (AC-2 guarantees the remittance was NOT left
  persisted in `kyc_pending` in that case), the system SHALL be able to start KYC again from its
  last valid persisted status without throwing `invalid_transition` — no regresión sobre el flujo
  feliz (`created → kyc_pending → kyc_passed/kyc_failed`).

### V2 — copy de errores de wallet (MENOR)
- **AC-5**: WHEN `guard()` (`flow.tsx`) catches an error whose message contains `"no_wallet"`, the
  system SHALL display copy specific to "no se detectó una wallet instalada" (en vez del genérico
  "Algo salió mal").
- **AC-6**: WHEN `guard()` catches an error whose message contains `"no_account"` or
  `"wallet_not_connected"`, the system SHALL display copy specific a reconectar/desbloquear la
  wallet (en vez del genérico).

### V3 — fallback siempre aprueba (documentar, sin cambio de comportamiento)
- **AC-7**: the system SHALL document explicitly, in a code comment adjacent to
  `FallbackKycGateway.simulated()` (`fallback/gateways.ts`), that this simulation ALWAYS approves
  (`approved: true, payoutAllowed: true`) and NEVER represents a rejection path — y que su alcance
  en producción está contenido por el gate server-side de WKH-180 (`/api/payout/validate`).
  Ningún comportamiento runtime cambia (AC de documentación pura).

### V4 — FX doble redondeo (MENOR)
- **AC-8**: WHEN `FallbackQuoteGateway.requestQuote()` computes the PEN amount to receive, the
  system SHALL apply rounding EXACTLY ONCE — vía `Money.of()` (la única fuente de verdad de
  redondeo del dominio) — sin un redondeo previo (`.toFixed(2)` + `Number(...)`) en el adapter.

### V5 — Money safe-int cap (MENOR)
- **AC-9**: IF `Money.of(major, currency)` would produce a `minor` value that exceeds
  `Number.MAX_SAFE_INTEGER`, THEN the system SHALL throw `invalid_money_amount:${major}` (mismo
  patrón de error que la validación existente de `Number.isFinite`/`>= 0`) en vez de devolver un
  `Money` con precisión silenciosamente degradada.

### V6 — drift `.env.example` (MENOR)
- **AC-10**: the system SHALL document `NEXT_PUBLIC_REOWN_PROJECT_ID` in `.env.example` (usada en
  `wallet.ts:130`, hoy sin documentar).
- **AC-11**: the system SHALL annotate `NEXT_PUBLIC_KYC_MODE` in `.env.example` as deprecated/no-op
  (ya no se lee en ningún lugar de `src/`, el server decide vía WKH-180) — en vez de describirla
  como si aún controlara el adapter cableado.

## Scope IN
- `chaski-v2/src/infrastructure/kyc-pending-store.ts` — try/catch en `save()`/`clear()` (AC-1).
- `chaski-v2/src/application/use-cases/start-kyc.ts` — reordenar `pending.save()` antes de
  `repo.save(r)` en la rama de redirect (AC-2/AC-3/AC-4).
- `chaski-v2/src/presentation/flow.tsx` — extender `humanError()` con los 3 códigos de wallet
  (AC-5/AC-6).
- `chaski-v2/src/infrastructure/fallback/gateways.ts` — comentario explícito en
  `FallbackKycGateway` (AC-7) + eliminar el redondeo previo en `FallbackQuoteGateway.requestQuote`
  (AC-8).
- `chaski-v2/src/domain/money.ts` — cap de safe-int en `Money.of()` (AC-9).
- `chaski-v2/.env.example` — agregar `NEXT_PUBLIC_REOWN_PROJECT_ID` (AC-10), anotar
  `NEXT_PUBLIC_KYC_MODE` como deprecated (AC-11).
- Tests: `chaski-v2/src/domain/money.test.ts` (cap, AC-9), test nuevo o extendido para
  `start-kyc.ts`/`kyc-pending-store.ts` (AC-1 a AC-4 — hoy sin `start-kyc.test.ts` dedicado; el
  Architect decide en F2 si se crea o se extiende `use-cases.test.ts`), extensión de
  `flow-vm.test.ts` o test nuevo de presentación si aplica a `humanError()` (AC-5/AC-6 — hoy
  `humanError` no está exportado ni testeado por separado; a confirmar en F2 si se exporta para
  testear en aislamiento, siguiendo el patrón de `flow-vm.ts`/`flow-vm.test.ts` ya existente).

## Scope OUT
- Los 2 ítems descartados (schema migration/`.slice` crash, test fake) — confirmados resueltos por
  WKH-181/WKH-178, no se reabren (ver Contexto verificado).
- Cambiar el comportamiento de `FallbackKycGateway` (ej. simular también un caso de rechazo) — V3
  es documentación pura, no lógica nueva. Si se decide en el futuro que el fallback debe simular
  también un caso "declined" para testing/demo, es una HU aparte (cambio de comportamiento, no
  higiene).
- Cifrado/hardening adicional de `localStorage` (ya fuera de scope en WKH-181, mismo criterio
  aplica acá).
- Cualquier cambio a `RemittanceStatus`/`TRANSITIONS` del dominio — ver CD-3 (el fix de V1 es
  puramente de orden de I/O en la capa de aplicación).
- El demo live (`yarvis`/`wasiai-v2`, fuera de `chaski-v2/`) — NO SE TOCA (CD-1).
- Cambios a `app/api/kyc/*` o `app/api/payout/validate` (ya cerrados en WKH-179/180) — esta HU no
  toca rutas server-side.
- Un cap de `Money` basado en una regla de negocio de remesas (ej. "$50,000 máximo") — el cap de
  AC-9 es puramente técnico (`Number.MAX_SAFE_INTEGER`), no una regla de producto (ver CD-4).

## Decisiones técnicas (DT-N)
- **DT-1 (fix de V1 sin tocar el dominio)**: el fix recomendado es un REORDER de 2 líneas en
  `start-kyc.ts` (`pending.save()` antes de `repo.save(r)` en la rama de redirect) + try/catch en
  `kyc-pending-store.ts` — evita ampliar `TRANSITIONS` con `kyc_pending → kyc_pending` (que sería
  una superficie nueva de la máquina de estados, más difícil de razonar) y evita cualquier lógica
  de "compensación"/rollback. Es el fix mínimo que cierra el huérfano: si `pending.save()` falla,
  el `repo.save(r)` correspondiente nunca corre, así que la remesa nunca queda persistida en
  `kyc_pending` sin un `KycPending` correlacionable — el siguiente intento del usuario arranca
  desde el último estado persistido válido (ej. `created`), que SÍ permite `startKyc()` de nuevo.
- **DT-2 (V1 — error tipado)**: se recomienda que el catch de `kyc-pending-store.ts` normalice y
  re-lance un error con código reconocible (ej. `Error("kyc_pending_unavailable")`) en vez de
  swallow-silencioso — así `humanError()` (`flow.tsx`) puede, en un futuro incremento, mapear ese
  código a un mensaje específico ("No pudimos preparar la verificación. Probá de nuevo."). Esta HU
  NO exige que `humanError()` tenga esa rama nueva (no está en los ACs V1) — solo que el error no
  sea un `TypeError`/`DOMException` crudo sin normalizar; el Architect decide en F2 si agrega el
  copy específico como parte de V1 o lo deja al fallback genérico existente (que YA es aceptable
  como mensaje de error, distinto del problema de fondo de V1 que es el ESTADO BRICKED, no el
  copy).
- **DT-3 (V4 — un solo lugar de redondeo)**: eliminar `.toFixed(2)`/`Number(...)` de
  `FallbackQuoteGateway.requestQuote` y pasar el float crudo (`netUsd * rate`) a `Money.of()`. Sin
  cambio de comportamiento observable en el caso común (mismo resultado redondeado a 2 decimales);
  el beneficio es eliminar la fuente de divergencia latente en floats límite, no corregir un bug
  reproducido hoy.
- **DT-4 (V5 — umbral del cap)**: usar `Number.MAX_SAFE_INTEGER` como techo genérico del dominio
  `Money` (no un número de negocio específico de remesas) — `Money` es un value object compartido
  por USDC y PEN sin conocimiento de reglas de remesas; cualquier techo de negocio (ej. límite
  regulatorio de remesa) es una validación de aplicación/dominio de `Remittance`, no de `Money`
  (ver CD-4).

## Constraint Directives (CD-N)
- **CD-1**: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/`. PROHIBIDO tocar el demo live
  (`yarvis`, `wasiai-v2`, cualquier ruta bajo `agentshop-*`). Esta HU es exclusivamente
  `chaski-v2/src/{domain,application,infrastructure,presentation}/*` + `chaski-v2/.env.example`
  según Scope IN.
- **CD-2**: PROHIBIDO cambiar el comportamiento observable del demo actual — `FallbackKycGateway`
  sigue aprobando siempre (V3 es documentación, no lógica nueva); el resultado numérico del FX en
  el caso común (V4) debe seguir siendo el mismo monto redondeado a 2 decimales que hoy ve el
  usuario en el demo (el fix elimina redundancia, no cambia el output esperado).
- **CD-3**: PROHIBIDO ampliar `RemittanceStatus`/`TRANSITIONS` (`domain/remittance.ts`) para
  resolver V1 — el fix vive 100% en la capa de aplicación (orden de I/O en `start-kyc.ts`) según
  DT-1. Abrir una transición nueva `kyc_pending → kyc_pending` sin decisión explícita del Architect
  está prohibido en esta HU.
- **CD-4**: PROHIBIDO que el cap de `Money.of()` (AC-9) use un número de negocio de remesas (ej.
  "$50,000 máximo enviable") sin decisión explícita y confirmada del humano — el cap de esta HU es
  estrictamente técnico (`Number.MAX_SAFE_INTEGER`, ver DT-4). Cualquier límite de negocio es una
  HU aparte.

## Missing Inputs
- `[no bloqueante, resolver en F2]` DT-2: ¿se agrega copy específico para `"kyc_pending_unavailable"`
  en `humanError()` como parte de esta HU, o queda el mensaje genérico existente (que ya cubre el
  caso, distinto del bug de fondo que es el estado bricked, no el copy)? No bloqueante — AC-1 a
  AC-4 no dependen de esta decisión.
- `[no bloqueante, resolver en F2]` Scope IN — tests: si `humanError()` se exporta de `flow.tsx`
  para testear en aislamiento (patrón `flow-vm.ts`) o si se cubre vía un test de integración de
  `guard()`/`onVerify` — el Architect decide la estrategia de test concreta para AC-5/AC-6.
- `[no bloqueante, resolver en F2]` V6/AC-11: ¿se anota `NEXT_PUBLIC_KYC_MODE` como deprecated en
  el comentario, o se elimina la línea directamente de `.env.example`? Se recomienda anotar (menos
  destructivo, documenta la decisión de WKH-180 para quien lea el historial), pero no es
  bloqueante.

## Análisis de paralelismo
- No depende de WKH-182 (analyst en paralelo, mismo repo `chaski-v2`, NNN `005` según coordinación
  del orquestador) salvo por el `_INDEX.md` compartido (mismo archivo, coordinar el merge del
  índice, no del código). Sin overlap de archivos conocido con WKH-182 salvo que WKH-182 también
  toque `flow.tsx`/`gateways.ts`/`money.ts` — a confirmar contra el work-item de WKH-182 antes de
  F3.
- No bloquea ninguna HU conocida del backlog (178-182 ya DONE o en paralelo; no hay HU futura
  identificada que dependa de estos 6 fixes de higiene).
- Depende del estado ya mergeado de WKH-178 (fixes demo-safe), WKH-179 (auth/rate-limit KYC),
  WKH-180 (autoridad payout server-side) y WKH-181 (reducción PII + `documentNumberLast4`/
  `toPersistedIdentity`) — las 4 YA en `main`; esta HU descarta explícitamente 2 de sus 8 ítems
  originales porque esas HUs ya los resolvieron como efecto colateral.
- Internamente: V1 (bloqueante) es independiente de V2/V3/V4/V5/V6 — puede implementarse y
  mergearse solo si se prioriza. V2 depende conceptualmente de V1 en DT-2 (copy del código de
  error nuevo) pero NO es un blocker técnico (V2 puede implementarse con los 3 códigos de wallet
  existentes sin esperar V1). V4/V5 (Money/FX) son completamente independientes entre sí y del
  resto. V6 (env docs) es 100% independiente y de menor riesgo de todo el batch.

## Waves sugeridas (para F3, referencia — el Architect define las definitivas en F2.5)
- **Wave 1** (dominio/infra puros, sin I/O nuevo, bajo riesgo): `money.ts` (AC-9, cap safe-int) +
  `fallback/gateways.ts` (AC-7 comentario + AC-8 doble redondeo) — 3 fixes independientes entre sí,
  testeables en aislamiento.
- **Wave 2** (el bug real, money-path): `kyc-pending-store.ts` (AC-1) + `start-kyc.ts` (AC-2/AC-3/
  AC-4) — requiere test nuevo o extendido que ejercite el fallo de `pending.save()` y confirme que
  la remesa NO queda persistida en `kyc_pending` sin `KycPending` correlacionable.
- **Wave 3** (presentación, depende de Wave 2 solo si se decide DT-2): `flow.tsx` `humanError()`
  (AC-5/AC-6) — independiente en el caso base (los 3 códigos de wallet ya existen hoy), opcional
  extender con el código de V1 si el Architect confirma DT-2 en F2.
- **Wave 4** (docs, 100% independiente, puede ir en cualquier momento/paralelo): `.env.example`
  (AC-10/AC-11).
