# SDD — [WKH-183] Higiene menor: pending-store huérfano, copy errores, FX/Money, drift env

- **SDD_MODE**: mini
- **Estimación**: S
- **Branch sugerido**: `fix/183-higiene-pending-store-money-fx-copy-env`
- **Base**: `main` @ `7838f33` (post WKH-178/179/180/181). **Coordinación**: WKH-182 mergea PRIMERO
  (ver §7). El Dev re-verifica líneas contra `main` post-merge de 182 antes de F3.
- **Gate previo**: HU_APPROVED otorgado.

---

## 1. Context Map (archivos leídos + patrón extraído)

Todas las líneas verificadas al 2026-07-11 sobre `main` @ `7838f33`.

| Archivo | Líneas leídas | Qué extraje / por qué |
|---------|--------------|-----------------------|
| `src/infrastructure/kyc-pending-store.ts` | 1-24 | `save()` (8-10) y `clear()` (21-23) llaman `setItem`/`removeItem` **sin try/catch**; `get()` (11-20) SÍ envuelve el `JSON.parse`. Todos guardan el `typeof localStorage !== "undefined"`. **Objetivo V1 (AC-1).** |
| `src/application/use-cases/start-kyc.ts` | 1-69 | Rama redirect (59-67): orden actual `repo.save(r)` (60) → `pending.save({...})` (61-66) → `return {kind:"redirect"}` (67). `r.startKyc()` (33) muta en memoria a `kyc_pending` pero **no persiste hasta `repo.save`**. **Objetivo V1 (AC-2/3/4): invertir a pending.save→repo.save.** Ramas `done` (37-41, 51-57) NO tocan `pending`. |
| `src/domain/remittance.ts` | 80-190 | `TRANSITIONS` (85-97): `kyc_pending: ["kyc_passed","kyc_failed"]` (87) — NO incluye `kyc_pending`. `to()` (162-167) lanza `invalid_transition` si no permitido. `startKyc()` (169-171) → `to("kyc_pending")`. **CD-3: NO se toca.** Confirma el brick descrito en V1 (retry de `created`→`kyc_pending` SÍ es válido: línea 86). |
| `src/presentation/flow.tsx` | 130-204, 620-652 | `guard()` (138-148): captura, `setError(humanError(e.message))`. `onVerify()` (182-204): `await c.startKyc.execute(...)` → **si `res.kind==="redirect"` recién ahí `window.location.href = res.url` (196)**. `humanError()` (637-643): mapea `quote_expired`/`QUOTE_STALE`, `kyc`, `payout`; resto → genérico. **Objetivos V2/DT-2 (AC-5/6) + confirma AC-3.** |
| `src/presentation/flow-vm.ts` | 1-13 | Módulo VM PURO (sin React/JSX). Exporta `isDemoMode`, `deliveredDisplay`. flow.tsx ya importa de acá (línea 17). **Destino de `humanError` para testearlo en aislamiento (ver DT-6).** |
| `src/presentation/flow-vm.test.ts` | 1-63 | Patrón de test VM puro: `import { ... } from "./flow-vm"` + `describe/it/expect` de vitest. **Exemplar para el test de `humanError`.** |
| `src/domain/money.ts` | 1-63 | `of()` (16-22): valida `Number.isFinite` + `>= 0`, calcula `Math.round(major*factor)`; **sin techo**. Error existente `invalid_money_amount:${major}`. **Objetivo V5 (AC-9).** |
| `src/domain/money.test.ts` | 1-31 | Patrón `Money.of(...).minor`, `.toThrow(/invalid_money/)`. **Exemplar para el test del cap.** |
| `src/infrastructure/fallback/gateways.ts` | 1-113 | `FallbackQuoteGateway.requestQuote` (45-60): línea 53 `receive: Money.of(Number((netUsd*rate).toFixed(2)),"PEN")` = **doble redondeo** (V4/AC-8). `FallbackKycGateway` (63-90): `simulated()` (72-89) siempre `approved:true, payoutAllowed:true` (75-76); comentario (64-65) no dice "nunca rechaza" (V3/AC-7). **Archivo COMPARTIDO con WKH-182 (línea 53).** |
| `src/infrastructure/wallet.ts` | 20,23,34,101,112,130 | Códigos: `no_wallet` (20), `no_account` (23,101), `wallet_not_connected` (34,112). `NEXT_PUBLIC_REOWN_PROJECT_ID` leído en 130. **Objetivos V2 (AC-5/6) + V6 (AC-10).** |
| `.env.example` | 1-38 | `NEXT_PUBLIC_KYC_MODE` (19-22) documentada como viva (drift, V6/AC-11). `NEXT_PUBLIC_REOWN_PROJECT_ID` NO documentada (AC-10). **Archivo COMPARTIDO con WKH-182** (182 agrega `NEXT_PUBLIC_CHAIN_ID`). |
| `src/application/use-cases.test.ts` | 25-84, 155-207 | `setup()` (26-48) cablea `StartKyc(kycGw, kycStore, pending, repo, clock)`. Test redirect (158-167) usa `new FakeKycGateway({}, true)` + `resumeKyc`. **Exemplar para el test de V1.** |
| `src/test-support/fakes.ts` | 1-201 | `FakeKycPendingStore` (122-133): `save`/`get`/`clear` in-memory, **sin modo de fallo**. `InMemoryRepo` (52-67). **Necesito un doble que falle en `save()` para el test de AC-2/3.** |
| `src/application/use-cases/resume-kyc.ts` | 1-53 | `execute()` (23-52) lee `pending.get()` (24) y `repo.get()` (27). Si status ≠ `kyc_pending` → clear+none (33-36). **Verificación de no-regresión del reorder (ver §4).** |
| `src/application/use-cases/abandon-pending-kyc.test.ts` | 1-15 | Patrón mínimo de test de use-case con `FakeKycPendingStore`. Exemplar. |
| `src/application/ports.ts` (via work-item) | 56-60 | `KycPendingStore` firma `save/get/clear` → `Promise<void>`/`Promise<T\|null>`. **NO se toca (fix es de impl, no de port).** |

---

## 2. Decisiones técnicas (DT-N)

- **DT-1 (V1 sin tocar el dominio)** — heredada del work-item. Fix = **reorder** en `start-kyc.ts`
  (`pending.save()` ANTES de `repo.save(r)` en la rama redirect) + **try/catch** en
  `kyc-pending-store.ts`. NO se amplía `TRANSITIONS` (CD-3). Racional: si `pending.save()` falla, el
  `repo.save(r)` correspondiente **nunca corre**, la mutación in-memory de `r.startKyc()` (línea 33)
  se descarta, y el estado persistido de la remesa sigue en `created` → el retry arranca desde un
  estado que SÍ permite `startKyc()` (`TRANSITIONS.created = ["kyc_pending"]`, línea 86). Cierra el
  huérfano sin rollback/compensación.

- **DT-2 (V1 — error tipado + copy)** — decisión del orquestador APLICADA: el catch de
  `kyc-pending-store.ts` normaliza y **re-lanza `new Error("kyc_pending_unavailable")`** (NO swallow,
  NO `TypeError`/`DOMException` crudo). **Y** se agrega el copy para `kyc_pending_unavailable` en
  `humanError()` (V2 ya toca ese módulo; costo marginal cero).
  - **⚠️ Ordering en `humanError`**: el código `kyc_pending_unavailable` **contiene el substring
    `"kyc"`** → si se evalúa la rama genérica `code.includes("kyc")` primero, matchea el mensaje
    equivocado ("No pudimos verificar tu identidad"). El chequeo de `kyc_pending_unavailable`
    (o `pending_unavailable`) DEBE ir **ANTES** de `code.includes("kyc")`. Copy sugerido:
    *"No pudimos preparar la verificación. Probá de nuevo."* (el Dev fija el texto exacto en F3).

- **DT-3 (V4 — un solo redondeo)** — heredada. Eliminar `.toFixed(2)` + `Number(...)` de
  `gateways.ts:53`; pasar `netUsd * rate` (float crudo) a `Money.of(..., "PEN")` (única fuente de
  redondeo del dominio). Sin cambio observable en el caso común (mismo monto a 2 decimales) — CD-2.

- **DT-4 (V5 — techo técnico)** — heredada. Cap = `Number.MAX_SAFE_INTEGER` en `Money.of()`. Reusa
  el patrón de error existente: `throw new Error(\`invalid_money_amount:${major}\`)` cuando
  `Math.round(major * factor) > Number.MAX_SAFE_INTEGER`. **CD-4**: cap estrictamente técnico, NO
  regla de negocio.

- **DT-5 (V6 — anotar, no borrar)** — decisión del orquestador APLICADA: `NEXT_PUBLIC_KYC_MODE` se
  **anota como deprecated/no-op** en `.env.example` (NO se borra la línea) — documenta la decisión de
  WKH-180 para el historial. Y se **agrega** `NEXT_PUBLIC_REOWN_PROJECT_ID` (AC-10).

- **DT-6 (estrategia de test de `humanError`, AC-5/6)** — decisión del orquestador APLICADA (opción
  más limpia): **MOVER `humanError` a `flow-vm.ts`** (módulo VM puro, sin `"use client"`/JSX),
  exportarlo, e importarlo en `flow.tsx` (agregándolo al import existente de línea 17). Se testea en
  `flow-vm.test.ts` en aislamiento — **evita importar el componente `"use client"` con JSX en un
  test de vitest** (el patrón `flow-vm.ts`/`flow-vm.test.ts` ya está establecido). `flow.tsx` pasa de
  definir `humanError` local (637-643) a importarlo; `guard()` (144) sigue llamándolo idéntico.

- **DT-7 (doble de test que falla en `save()`)** — para AC-1/AC-2/AC-3 hace falta un `KycPendingStore`
  que **lance en `save()`**. Se agrega un doble dedicado a `src/test-support/fakes.ts` (ej.
  `ThrowingKycPendingStore` que hace `throw new Error("kyc_pending_unavailable")` en `save()`, y
  delega `get`/`clear` a memoria). NO se modifica la firma del port ni de `FakeKycPendingStore`
  existente (evita el footgun de firmas — ver CD-6).

---

## 3. Constraint Directives (CD-N)

**Heredados del work-item** (INVIOLABLES):
- **CD-1**: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/`. PROHIBIDO tocar el demo live
  (`yarvis`, `wasiai-v2`, `agentshop-*`). Scope = `chaski-v2/src/{domain,application,infrastructure,presentation}/*`
  + `chaski-v2/.env.example`.
- **CD-2**: PROHIBIDO cambiar el comportamiento observable del demo. `FallbackKycGateway` sigue
  aprobando siempre (V3 = doc). El FX (V4) devuelve el mismo monto a 2 decimales en el caso común.
- **CD-3**: PROHIBIDO ampliar `RemittanceStatus`/`TRANSITIONS` (`domain/remittance.ts`). El fix de V1
  vive 100% en la capa de aplicación (orden de I/O).
- **CD-4**: PROHIBIDO que el cap de `Money.of()` use un número de negocio de remesas. Cap estrictamente
  técnico (`Number.MAX_SAFE_INTEGER`).

**Agregados en F2** (SDD-específicos + Auto-Blindaje histórico):
- **CD-5 (ordering `humanError`)**: el chequeo de `kyc_pending_unavailable` DEBE preceder al
  `code.includes("kyc")` genérico (el string contiene `"kyc"`). Ver DT-2.
- **CD-6 (sin drift de firmas — Auto-Blindaje WKH-180#Wave2, WKH-181#Wave1)**: PROHIBIDO cambiar
  firmas de ctor/función. El ctor de `StartKyc`, la firma de `Money.of(major, currency)`, el port
  `KycPendingStore` y `FakeKycPendingStore` existente NO cambian. En ≥2 HUs previas agregar un
  param/arg requerido rompió `tsc` en callers **fuera del Scope IN** (`confirm-and-send.test.ts`).
  El fix de V1 es reorder + try/catch, cero cambio de firma. Nuevos dobles de test se **agregan**,
  no mutan los existentes.
- **CD-7 (`noUncheckedIndexedAccess` — Auto-Blindaje WKH-179#Wave1, WKH-181#Wave2)**: el `tsconfig`
  tiene `noUncheckedIndexedAccess`; cualquier acceso por índice (`arr[0]`, `calls[0][1]`) es
  `T | undefined`. En los tests nuevos (V1) evitar index-access crudo o guardarlo. Aplica al doble
  de test y a cualquier assert que indexe.
- **CD-8 (sin símbolos inexistentes — Auto-Blindaje WKH-180#Wave2)**: PROHIBIDO importar tipos/símbolos
  no verificados de `ports.ts`/`remittance.ts`. Todo import se confirma con Read antes de usar
  (`KycPending`, `KycPendingStore` ya verificados en `ports.ts:56-60`).
- **CD-9 (diff acotado en archivos compartidos con 182)**: en `gateways.ts` y `.env.example` (ambos
  compartidos con WKH-182) el diff se limita ESTRICTAMENTE a las hunks de esta HU (línea 53 + comentario
  63-65 en gateways; anotación KYC_MODE + línea REOWN nueva en env). NO reformatear ni tocar hunks
  ajenos. El Dev re-verifica líneas post-merge de 182 (ver §7).

---

## 4. Diseño por ítem (V1-V6)

### V1 — pending-store huérfano (BLOQUEANTE, único bug real) — AC-1/2/3/4

**Causa raíz (verificada `start-kyc.ts:59-67`):** en la rama redirect, `repo.save(r)` (línea 60)
persiste `status:"kyc_pending"` ANTES de `pending.save()` (61-66). Si `pending.save()` lanza (quota /
private-browsing), la remesa queda persistida en `kyc_pending` **sin** `KycPending` correlacionable:
- el retry (`onVerify` → `startKyc.execute` → `r.startKyc()` → `to("kyc_pending")`) lanza
  `invalid_transition:kyc_pending->kyc_pending` (`remittance.ts:87,163-164` — `kyc_pending` no es
  destino válido);
- `ResumeKyc` (`resume-kyc.ts:24`) hace `pending.get()` → `null` → `{kind:"none"}`.
- **Brick permanente.**

**Fix (2 cambios de aplicación/infra, cero dominio):**

1. **`kyc-pending-store.ts` (AC-1)** — envolver `setItem` (save) y `removeItem` (clear) en try/catch
   que re-lanza `new Error("kyc_pending_unavailable")` (DT-2). El `get()` no cambia (ya defensivo).

2. **`start-kyc.ts` rama redirect (AC-2/3/4)** — **invertir el orden**: `pending.save({...})` PRIMERO,
   `repo.save(r)` DESPUÉS, luego `return {kind:"redirect", url}`. Racional del cierre del huérfano:
   si `pending.save()` lanza → `repo.save(r)` no corre → la remesa NO se persiste en `kyc_pending`
   (sigue en su último estado persistido, `created`) → el retry hace `created→kyc_pending` (válido,
   `TRANSITIONS.created`, línea 86). El error `kyc_pending_unavailable` se propaga desde
   `execute()`.

**AC-3 (no navegar a Didit si el pending falló):** **ya satisfecho sin tocar `flow.tsx`.** En
`onVerify` (flow.tsx:188-197) el `window.location.href = res.url` (196) está DESPUÉS del
`await c.startKyc.execute(...)` (188) y DENTRO del `if (res.kind === "redirect")`. Si `pending.save()`
falla, `execute()` **rechaza** → `guard()` (138-148) captura, `humanError()` setea el error visible,
y el flujo **nunca llega a la línea 196**. El único cambio en flow.tsx para V1 es el **copy**
(DT-2/CD-5), no el control de navegación. Confirmado: el orden actual del `window.location.href`
(post-`pending.save` exitoso, vía el `return {kind:"redirect"}`) es correcto — no requiere reorder en
flow.tsx.

**No-regresión del reorder (AC-4):**
- **Flujo feliz (fallback/completed):** NO entra a la rama redirect (usa 37-41 o 51-57) → inalterado.
- **Redirect exitoso:** ambos writes ocurren (pending PRIMERO, luego repo). `ResumeKyc` lee
  `pending.get()` (24) y `repo.get()` (27) — ambos presentes y consistentes → `passed`/`failed` igual
  que hoy. El test existente `use-cases.test.ts:158-167` ("Didit redirect → resume aplica...") debe
  **seguir verde sin cambios** (verificación de no-regresión).
- **`ResumeKyc` intacto:** la lógica de `resume-kyc.ts` no depende del ORDEN de escritura previo,
  solo de que ambos existan cuando el redirect fue exitoso. Con el reorder eso se mantiene.

### V2 — copy de errores de wallet (MENOR) — AC-5/6

En `humanError` (movido a `flow-vm.ts`, DT-6) agregar ramas:
- `no_wallet` → copy "no se detectó una wallet instalada" (instalar/desbloquear).
- `no_account` / `wallet_not_connected` → copy "reconectá/desbloqueá tu wallet".
Ninguno contiene `"kyc"`/`"quote"`/`"payout"` → hoy caen al genérico; el orden entre ellos es
indiferente. Solo `kyc_pending_unavailable` tiene la restricción de orden de CD-5.

### V3 — `FallbackKycGateway` siempre aprueba (documentar) — AC-7

Comentario explícito adyacente a `simulated()` (`gateways.ts:63-90`): esta simulación **SIEMPRE**
aprueba (`approved:true, payoutAllowed:true`) y NUNCA representa un rechazo; su alcance en prod está
contenido por el gate server-side de WKH-180 (`app/api/payout/validate`: sin `DIDIT_API_KEY` + prod →
503 fail-loud). **Cero cambio de runtime** (CD-2). Solo comentario.

### V4 — FX doble redondeo (MENOR) — AC-8

`gateways.ts:53`: `receive: Money.of(Number((netUsd*rate).toFixed(2)), "PEN")` →
`receive: Money.of(netUsd * rate, "PEN")`. `Money.of` (money.ts:20-21) hace el único
`Math.round(major * 100)`. **Sin cambio observable** en el caso común (CD-2); elimina la divergencia
latente de 1 centavo en floats límite. Nota: `FakeQuoteGateway` en `fakes.ts:77` tiene el mismo patrón
pero **NO está en Scope IN** (es doble de test, no afecta al demo) — NO se toca (evita drift de fixtures
de otros tests).

### V5 — Money safe-int cap (MENOR) — AC-9

`money.ts:16-22`: tras `const minor = Math.round(major * factor)`, si `minor > Number.MAX_SAFE_INTEGER`
→ `throw new Error(\`invalid_money_amount:${major}\`)`. Mismo patrón/prefijo de error que la validación
existente. `fromMinor` y `zero` NO cambian (fuera de scope del AC).

### V6 — drift `.env.example` (MENOR) — AC-10/11

- **AC-10**: agregar bloque para `NEXT_PUBLIC_REOWN_PROJECT_ID` (usada en `wallet.ts:130`, gatea
  `WalletConnectWallet` vs `FallbackWallet`).
- **AC-11**: anotar `NEXT_PUBLIC_KYC_MODE` (líneas 19-22) como **deprecated/no-op** (WKH-180 la dejó
  muerta; el server decide el adapter). NO borrar la línea (DT-5).

---

## 5. Waves de implementación

Orden de menor→mayor riesgo. W1-W4 son en su mayoría independientes; W2 es el bloqueante.

| Wave | Archivos | ACs | Serial? |
|------|----------|-----|---------|
| **W1** — dominio/infra puros (sin I/O nuevo) | `src/domain/money.ts` (cap) · `src/infrastructure/fallback/gateways.ts` (comentario V3 + reorder-de-redondeo V4) | AC-7, AC-8, AC-9 | Paralelizable entre sí; independientes del resto |
| **W2** — el bug real (V1) | `src/infrastructure/kyc-pending-store.ts` (try/catch) · `src/application/use-cases/start-kyc.ts` (reorder) · `src/test-support/fakes.ts` (doble `ThrowingKycPendingStore`, DT-7) | AC-1, AC-2, AC-3, AC-4 | Serial dentro del wave (store→start-kyc→test) |
| **W3** — presentación | `src/presentation/flow-vm.ts` (mover+exportar `humanError` + ramas wallet + `kyc_pending_unavailable`) · `src/presentation/flow.tsx` (importar `humanError` de flow-vm en vez de definirlo local) | AC-5, AC-6, DT-2 copy | Depende de W2 solo para el copy `kyc_pending_unavailable`; las ramas wallet son independientes |
| **W4** — docs (100% independiente) | `chaski-v2/.env.example` | AC-10, AC-11 | En cualquier momento |

**Nota de coordinación (§7):** W1 (`gateways.ts`) y W4 (`.env.example`) comparten archivo con WKH-182
→ el Dev re-verifica líneas post-merge de 182 antes de aplicar estos dos hunks.

---

## 6. Plan de tests (≥1 por AC)

Todos en vitest, patrón existente. `tsc` strict + `noUncheckedIndexedAccess` (CD-7).

| AC | Test (archivo) | Qué verifica |
|----|----------------|--------------|
| **AC-1** | `use-cases.test.ts` (nuevo caso) o `kyc-pending-store` unit | Con un `ThrowingKycPendingStore`, `startKyc.execute()` (rama redirect) rechaza con `Error("kyc_pending_unavailable")` — NO un `TypeError`/`DOMException` crudo. |
| **AC-2** (crítico) | `use-cases.test.ts` (nuevo caso) | Setup con `FakeKycGateway({}, true)` (redirect) + `ThrowingKycPendingStore` + `InMemoryRepo`. Tras el `execute()` que rechaza: `await repo.get(id)` → status sigue en `"created"` (NO `"kyc_pending"`) → **la remesa NO queda huérfana en `kyc_pending` sin `KycPending`**. Este es el test estrella de V1. |
| **AC-3** | Cubierto por AC-2 a nivel use-case (el `execute()` rechaza ANTES de retornar `{kind:"redirect"}`, así que flow.tsx nunca llega al `window.location.href`). Opcional: assert de que el resultado es un throw, no `{kind:"redirect"}`. |
| **AC-4** | `use-cases.test.ts` (nuevo caso) | Tras el fallo de AC-2, un **segundo** `startKyc.execute()` con un `FakeKycPendingStore` sano (o el mismo repo con status `created`) **NO lanza `invalid_transition`** y avanza (`created→kyc_pending`, o `done` con fallback). No-regresión del brick. |
| **AC-4 (no-regresión)** | `use-cases.test.ts:158-167` (existente) | El test "Didit redirect → resume aplica..." **sigue verde** tras el reorder (redirect exitoso: pending+repo ambos guardados, resume `passed`). |
| **AC-5** | `flow-vm.test.ts` (nuevo) | `humanError("no_wallet")` → copy de wallet no instalada (≠ genérico). |
| **AC-6** | `flow-vm.test.ts` (nuevo) | `humanError("no_account")` y `humanError("wallet_not_connected")` → copy de reconectar (≠ genérico). |
| **DT-2/CD-5** | `flow-vm.test.ts` (nuevo) | `humanError("kyc_pending_unavailable")` → copy de "no pudimos preparar la verificación" (**≠** "No pudimos verificar tu identidad" — prueba el ordering de CD-5). |
| **AC-7** | (documentación pura) | Sin test de runtime. El test existente `use-cases.test.ts:184-206` (AC-12 fallback) ya cubre que el comportamiento no cambió. |
| **AC-8** | `use-cases.test.ts` o test de `FallbackQuoteGateway` | `requestQuote({amountUsd})` con un `rate` fijo produce el MISMO `receive.minor` que hoy (mismo monto a 2 decimales). Opcional: un caso float-límite que hoy divergiría 1 centavo. |
| **AC-9** | `money.test.ts` (nuevo caso) | `Money.of(1e12, "USDC")` (→ `1e18` minor, supera MAX_SAFE_INTEGER) `.toThrow(/invalid_money_amount/)`. Y un caso holgado (`Money.of(1_000_000, "USDC")`) que **sí** pasa (no falso-positivo). |
| **AC-10/AC-11** | (docs) | Sin test automatizado. QA verifica el diff de `.env.example` en F4. |

**Doble de test nuevo (DT-7):** `ThrowingKycPendingStore` en `fakes.ts` — `save()` lanza
`Error("kyc_pending_unavailable")`, `get()`/`clear()` in-memory. No muta `FakeKycPendingStore` (CD-6).

---

## 7. Coordinación con WKH-182

WKH-182 (money-path robustez, NNN `005`) mergea **PRIMERO** (más grande, más avanzado). Overlap de
archivos:

| Archivo | WKH-182 toca | WKH-183 toca | Riesgo de conflicto |
|---------|-------------|-------------|---------------------|
| `src/infrastructure/fallback/gateways.ts` | `requestQuote` (46-60) — SOLO si el Architect de 182 decide cambiar la validación del quote; línea 53 referenciada en su grounding | línea 53 (quitar doble redondeo, V4) + comentario `FallbackKycGateway` (63-65, V3) | **Medio.** Ambas HUs miran la línea 53. Si 182 ya reescribe esa línea, el hunk de V4 puede quedar **ya aplicado o desplazado**. |
| `.env.example` | agrega `NEXT_PUBLIC_CHAIN_ID` (nueva) | agrega `NEXT_PUBLIC_REOWN_PROJECT_ID` (AC-10) + anota `NEXT_PUBLIC_KYC_MODE` (AC-11) | **Bajo.** Vars distintas; append/anotación en secciones distintas. Merge de texto trivial. |
| `_INDEX.md` | fila 182 | fila 183 | **Bajo.** Coordinar el merge del índice (no del código). |

**Directiva para el Dev (F3):**
1. Confirmar que WKH-182 ya está en `main` antes de arrancar (`git log`).
2. **Re-verificar `gateways.ts:53`** post-merge de 182: si 182 ya eliminó el doble redondeo en esa
   línea, AC-8 puede estar **ya satisfecho** → marcar V4 como no-op y documentarlo (no re-aplicar).
   Si sigue con `.toFixed(2)`, aplicar el hunk de V4. El comentario de V3 (63-65) es independiente de
   lo que haga 182.
3. `.env.example`: aplicar los hunks de AC-10/AC-11 respetando las secciones que 182 haya agregado
   (diff acotado, CD-9).
4. Ningún otro archivo de 183 (money.ts, kyc-pending-store.ts, start-kyc.ts, flow.tsx, flow-vm.ts,
   fakes.ts) tiene overlap conocido con 182 → sin re-verificación necesaria más allá del re-check de
   líneas de rutina.

---

## 8. Análisis de regresión (CD-2)

- **Demo FX (V4):** el monto que ve el usuario en el demo es el mismo (mismo redondeo a 2 decimales
  vía `Money.of`). El único caso donde diverge es un float-límite de 1 centavo que hoy es **latente**
  (no un bug reproducido). Sin cambio observable esperado.
- **Fallback KYC (V3):** cero cambio de runtime, solo comentario. `AC-12` (use-cases.test.ts:184-206)
  garantiza que el fallback sigue aprobando con identity reducida.
- **Flujo feliz KYC:** no entra a la rama redirect; el reorder de V1 no lo alcanza. El happy path
  (`use-cases.test.ts:57-70`) debe seguir verde.
- **Redirect exitoso:** ambos writes ocurren; `ResumeKyc` inalterado; test 158-167 verde.
- **`humanError` movido a flow-vm:** `guard()` (flow.tsx:144) lo llama idéntico; los códigos ya
  mapeados (`quote_expired`/`kyc`/`payout`) mantienen su copy. Solo se AGREGAN ramas.
- **`Money.of` cap:** los montos de remesa reales (≤ ~$1M) están holgadamente por debajo de
  `MAX_SAFE_INTEGER / 1e6 ≈ 9e9` → cero impacto en el demo; solo lanza en montos absurdos.

---

## 9. Readiness Check

- [x] Work-item leído completo (11 ACs, 4 CDs, DT-1..4, V1-V6, 2 descartados).
- [x] Todos los exemplars verificados con Read (paths + líneas reales post-181): `kyc-pending-store.ts`,
      `start-kyc.ts`, `remittance.ts`, `flow.tsx`, `flow-vm.ts`, `gateways.ts`, `money.ts`, `wallet.ts`
      (grep), `.env.example`, `fakes.ts`, `use-cases.test.ts`, `resume-kyc.ts`, `money.test.ts`,
      `flow-vm.test.ts`, `abandon-pending-kyc.test.ts`.
- [x] Missing Inputs del work-item resueltos por el orquestador: DT-2 (copy sí), estrategia de test
      (DT-6, mover a flow-vm), AC-11 (anotar, no borrar).
- [x] CD-3 respetado: `TRANSITIONS`/`RemittanceStatus` NO se tocan; fix de V1 es reorder + try/catch.
- [x] CD-4 respetado: cap = `Number.MAX_SAFE_INTEGER` (técnico).
- [x] Auto-Blindaje histórico incorporado: CD-6 (drift de firmas, WKH-180/181), CD-7
      (`noUncheckedIndexedAccess`, WKH-179/181), CD-8 (símbolos inexistentes, WKH-180).
- [x] Coordinación con WKH-182 diseñada (§7): 182 mergea primero; Dev re-verifica `gateways.ts:53` y
      `.env.example`.
- [x] Plan de tests ≥1 por AC, incluido el test estrella de V1 (AC-2: remesa NO huérfana).
- [x] Sin `[NEEDS CLARIFICATION]` pendientes.

**SDD LISTO para SPEC_APPROVED.**
