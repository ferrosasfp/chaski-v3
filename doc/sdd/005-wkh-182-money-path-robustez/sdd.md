# SDD — [WKH-182] Money-path robustez

> F2 (SDD full) · Chaski v2 · modo QUALITY · sobre `main` post WKH-178/179/180/181
> Input: `work-item.md` (9 ACs, 5 CDs, DT-1..5) + decisiones del orquestador (cierran los 3 `[NEEDS CLARIFICATION]`).
> Arquitectura: Clean/hexagonal (domain puro → application/ports → infrastructure/adapters).

---

## 0. Resolución de los `[NEEDS CLARIFICATION]` (decisiones del orquestador)

| # | Ambigüedad | Resolución aplicada |
|---|-----------|---------------------|
| NC-1 (BLOQUEANTE) | chainId default (43114 vs 43113) | **43114 (Avalanche mainnet)**, env-driven vía `NEXT_PUBLIC_CHAIN_ID`, única fuente para AMBOS wallets (CD-5). AC-8 usa **switch suave** (`wallet_switchEthereumChain`), no hard-reject. Flipear a Fuji (43113) queda atado a WKH-168/EIP-3009 real (fuera de scope). |
| NC-2 | tolerancia AC-1/AC-2 | **`max(0.02 PEN absoluto, 1% relativo)`** sobre `expected = max(0, send.major − feeUsd.major) × rate`. Función PURA sobre campos del Quote (CD-3). Justificación en DT-1 abajo. |
| NC-3 | forma del contrato de CAS | **Excepción tipada `ConcurrentModificationError`** + campo `version:number` en `RemittanceState` (incremental, controlado por la infra en `save()`). Firma de `RemittanceRepository.save()` **NO cambia** (el token viaja dentro del snapshot). Ripple mínimo. Ver DT-2. |

---

## 1. Context Map (archivos leídos — grounding archivo:línea, verificado 2026-07-11)

| Archivo | Líneas clave leídas | Qué extraje / por qué |
|---------|--------------------|-----------------------|
| `src/domain/remittance.ts` | `RemittanceState` 105-121; `create()` 126-146; `rehydrate()` 148-150; `to()` 162-167; `attachQuote()` 181-186; `confirm()` 189-196; `isQuoteExpired()` **private** 214-216; `Quote` 15-24; TRANSITIONS 85-97 | Punto de inserción de A5 (validación receive), M2 (`isQuoteStillValid`), A6 (`version` + `markSaved`). `confirmed→payout_failed` es transición válida (91) → AC-5 puede fallar-loud sin romper la FSM. `to()` NO debe tocar `version` (es concern de persistencia). |
| `src/application/use-cases/confirm-and-send.ts` | ctor 5-arg 16-22; `get()` 25; `confirm()`+`save()` 29-30; autoridad 180 40-49; `authorizePrincipal`+`save` 53-55; `submit()` 60-66; `save` final 76; `idempotencyKey` 58 | 4 `save()` sin token (A6). Autoridad 180 vive entre confirm y firma (M2 se inserta justo después, antes de firma — CD-2). `submit()` no manda `receive` (M3). El 1er `save()` (30) es el guard de carrera (fuera del try/catch del submit). |
| `src/infrastructure/persistence.ts` | `LocalRepo.save()` blind RMW 91-95; `normalizeState()` 44-48; `read()`/`reviver` 69-80; `list()` 102-109 | Sitio del CAS (A6). `normalizeState` debe defaultear `version` para snapshots legacy. Money serializa como `{__m:[minor,currency]}` (50-56) — `version` es number plano, viaja sin reviver especial. |
| `src/infrastructure/wallet.ts` | import `avalanche` 4; `InjectedWallet.connect()` 18-26; `authorizePrincipal` 32-43; `WalletConnectWallet.ensureProvider` `chains:[43114]` 81-92; `connect()` 97-104; `authorizePrincipal` 110-119; `pickWallet` 128-133 | 3 usos hardcodeados de `avalanche` + `[43114]` (M1/CD-5). `connect()` no valida chainId (M4/AC-8) ni address (M4/AC-9). `getAddress()` devuelve `string|null`. |
| `src/application/ports.ts` | `PayoutSubmit` 63-69; `PayoutRecord` 70-76 (`deliveredPen`); `RemittanceRepository` 109-114; `WalletPort` 96-100; `PayoutAuthorityGateway` 90-93 | `PayoutSubmit` gana `expectedReceivePen:Money` (M3/AC-6) sin tocar `deliveredPen`. `save(r)` firma intacta. |
| `src/infrastructure/fallback/gateways.ts` | `FallbackQuoteGateway.requestQuote` 45-60 (fórmula `receive=round((amount−0.5)×rate,2)`); `FallbackPayoutGateway.submit` 92-103 | Fórmula-fuente de A5 (DT-1). El mock `submit(req)` NO desestructura todos los campos → aceptar `expectedReceivePen` es estructural, **sin cambio de código**. |
| `src/test-support/fakes.ts` | `InMemoryRepo` 52-67; `FakePayoutGateway.submit(_req)` 140-149; `FakeWallet` 162-172; `FixedClock` 35-43; `FakeQuoteGateway` 69-85 | `InMemoryRepo.save` debe replicar el CAS. `FixedClock` no sirve para AC-5 (mismo valor siempre) → agregar `ScriptedClock`. `FakePayoutGateway` ignora `_req` → AC-6 no lo rompe. |
| `src/domain/money.ts` | `Money.of` 16-22 (round a minor); `major` 35-37; `minus` 43-48 | Comparo A5 en unidades `major` (PEN), amounts chicos caben en safe-int. `Money.of` valida `>=0` y finito. |
| `src/application/use-cases/{create,lock-quote,start-kyc,resume-kyc,track-remittance}.ts` | grep `repo.get`/`repo.save` (todos get→mutate→save secuencial) | Ripple del CAS: al viajar `version` en el snapshot y NO cambiar la firma de `save()`, **todos** obtienen CAS transparente. Ninguno necesita edición (ver §3.2). |
| `src/application/use-cases.test.ts` | 26-48 `setup()` construye `new ConfirmAndSend(...,FakePayoutAuthorityGateway())`; happy path 57-70 (create→kyc→lock→confirm→track) | **Call-site NO listado en Scope IN** que ejercita CAS secuencial. Debe quedar verde (CD-7). Quote de `FakeQuoteGateway` (rate 3.7) pasa A5 (§5). |
| `src/infrastructure/persistence.test.ts` | `MemStorage implements Storage` 12-32; `window` stub 34-41; legacy snapshot sin `version` 79-111 | Patrón para wallet.test/chain.test (jsdom NO instalado → stub `globalThis.window`). Legacy sin `version` → `normalizeState` default 0 (no rompe). Extiendo acá AC-3/AC-4. |
| `src/presentation/flow-vm.test.ts` | fixtures `receive: Money.of(1490,"PEN")` (no pasan por `attachQuote`) | Regresión: construye snapshots directos, A5 no dispara. Watch-point de `npm run qa`. |
| `src/composition/container.ts` | `wallet = pickWallet()` 53; `confirmAndSend` 62 | La chain vive en los adapters (`wallet.ts`), NO en el container → **container NO se toca** (chain env resuelto adentro de `wallet.ts`). |
| `.env.example` | secciones KYC/rate-limit (sin ninguna var de chain) | Agregar `NEXT_PUBLIC_CHAIN_ID` (+ documentar `NEXT_PUBLIC_REOWN_PROJECT_ID`, gap adyacente). |

**Exemplars verificados con Bash/Read (no inventados):**
- `viem@^2.21.0` exporta `avalanche` (43114), `avalancheFuji` (43113), `isAddress`, `getAddress` — confirmado por `node -e`.
- `noUncheckedIndexedAccess` + `strict` activos en `tsconfig.json` — confirmado.
- `persistence.test.ts` ya existe (se EXTIENDE, no se crea). `chain.test.ts` / `wallet.test.ts` son net-new.

---

## 2. Decisiones técnicas (DT-N)

**DT-1 — Tolerancia de A5 (AC-1/AC-2).**
Función pura en el dominio:
```
expected = max(0, send.major − feeUsd.major) × rate      // espeja netUsd=max(0,...) del gateway (gateways.ts:49)
allowedDelta = max(RECEIVE_TOL_ABS_PEN, expected × RECEIVE_TOL_REL)
mismatch ⟺ |receive.major − expected| > allowedDelta
```
Constantes: `RECEIVE_TOL_ABS_PEN = 0.02` (2 centavos, absorbe redondeo a 2 decimales de PEN), `RECEIVE_TOL_REL = 0.01` (1%). Justificación: para $400 @ 3.7 → `expected ≈ 1478.15`, `allowedDelta ≈ 14.78`. Es un **límite de sanidad defensivo** (caza tampering grueso: `receive` inflado 2×, degradado a la mitad, o inconsistente con `send/fee/rate` del propio quote), **no** una auditoría de precisión: un `remit-corridor-fx` remoto que redondee distinto (o WKH-183 que quita el doble-redondeo del fallback) cae holgado dentro de la tolerancia. Limitación documentada: A5 valida `receive` contra el `rate`/`fee` **del propio quote** — NO detecta un `rate` manipulado (ese es otro vector). Error: `quote_receive_mismatch`. Se ejecuta en `attachQuote()` ANTES del `to("quoted")` → AC-2 (no transiciona si falla).

**DT-2 — Lock optimista / CAS (AC-3/AC-4).** Campo `version:number` en `RemittanceState`.
- `create()` → `version: 0`. `rehydrate(state)` → preserva `state.version`. `to()` **NO** toca `version` (la versión es concern de persistencia, no de la FSM — se bumpea al escribir, no al mutar el estado de negocio).
- El CAS vive en la **infra** (`LocalRepo.save`) + su gemelo de test (`InMemoryRepo.save`), NO en el dominio (mismo principio Clean de WKH-180 DT-2: la I/O no entra al dominio puro). Regla de `save(r)`:
  ```
  existing = read().get(id)
  if (existing && existing.version !== r.snapshot.version) throw ConcurrentModificationError(id, r.snapshot.version, existing.version)
  next = r.snapshot.version + 1
  write({ ...r.snapshot, version: next })
  r.markSaved(next)   // sincroniza la instancia para el PRÓXIMO save() de la misma cadena
  ```
- `Remittance.markSaved(v:number)`: setea `state.version = v`. Necesario porque `ConfirmAndSend` hace 4 `save()` sobre la MISMA instancia; sin re-sincronizar la versión, el 2º `save()` chocaría consigo mismo. Es un acople controlado repo→agregado (análogo a un ORM que devuelve la versión tras el flush).
- `ConcurrentModificationError` vive en **`src/application/errors.ts`** (net-new) para que la importen tanto `infrastructure/persistence.ts` como `test-support/fakes.ts` sin ciclo (application no depende de infra). `class ConcurrentModificationError extends Error` con `readonly reason = "concurrent_modification"` + `expected`/`actual`.
- **Fail-loud (CD-4)**: el error se propaga; NO se pisa el estado ajeno. En `ConfirmAndSend`, el 1er `save()` (post-`confirm`, línea 30) está FUERA del try/catch del submit → propaga ANTES de firma/submit (CD-2). Ver §3.1.

**DT-3 — Re-check de expiry (AC-5/M2).** Nuevo método público `Remittance.isQuoteStillValid(now:string): boolean` = `quote != null && !isQuoteExpired(quote, now)` (reusa el `private` existente, mantiene el dominio puro: recibe `now` inyectado, sin `Date.now()`). `ConfirmAndSend` lo llama tras la autoridad 180 y ANTES de `authorizePrincipal` → si expiró: `markPayoutFailed("quote_expired_before_submit")` + `save()` + `return`, sin firma ni submit.

**DT-4 — Chain env-driven (AC-7/M1, CD-5).** Nuevo módulo `src/infrastructure/chain.ts`:
```
resolveChainId(): number   // parseInt(process.env.NEXT_PUBLIC_CHAIN_ID) || 43114
resolveChain(): Chain      // 43114→avalanche | 43113→avalancheFuji | otro→avalanche (fail-safe a prod actual)
```
Funciones (no consts congeladas) para testeabilidad. `InjectedWallet` y `WalletConnectWallet` importan de acá — **única fuente** del chainId (CD-5): `WalletConnectWallet` init `chains: [resolveChainId()]` en vez de `[43114]` hardcodeado.

**DT-5 — `expectedReceivePen` (AC-6/M3).** `PayoutSubmit` gana `expectedReceivePen: Money` (se AGREGA, no reemplaza `amountUsd`). `ConfirmAndSend.submit(...)` pasa `quote.receive`. El mock `FallbackPayoutGateway`/`FakePayoutGateway` lo ignora estructuralmente → **cero cambio de comportamiento del mock, cero edición de `fallback/gateways.ts`** (esto además elimina el overlap de merge con WKH-183 sobre ese archivo — ver §7).

---

## 3. Diseño por hallazgo

### 3.1 Orden de guards en `ConfirmAndSend.execute()` (CD-2) — POST cambio

```
1. r = repo.get(id)                                   // lectura base → version V
2. r.confirm(now)                                     // FSM: quoted→confirmed (valida kyc+quote no-vencido)
   repo.save(r)   ◄── GUARD CARRERA (AC-3/4): CAS. Si otra ejecución escribió → throw
                       ConcurrentModificationError (fuera del try/catch → propaga ANTES de firma/submit)
3. auth = authority.authorize({verificationId, address})   // WKH-180 (INTACTO, entre confirm y firma)
   if (!auth.authorized) → markPayoutFailed(reason) + save + return
4. if (!r.isQuoteStillValid(now)) ◄── GUARD EXPIRY (AC-5/M2): markPayoutFailed("quote_expired_before_submit")
                       + save + return  ── SIN authorizePrincipal, SIN submit
5. {tx} = wallet.authorizePrincipal(quote)            // FIRMA
   r.markPrincipalIn(tx, now); repo.save(r)
6. payouts.submit({..., expectedReceivePen: quote.receive})   // SUBMIT (AC-6/M3)
   r.markPayoutSubmitted(...); repo.save(r)           // (dentro del try/catch existente)
```
Orden CD-2 respetado: **CAS/carrera (2) → expiry re-check (4) → firma (5) → submit (6)**. Convive con la autoridad WKH-180 (3), que NO se reabre (Scope OUT). Nota: el `save()` final tras submit (6) también es CAS; un conflicto post-submit es post-hoc (la plata ya se movería en la versión real) — se propaga; la `idempotencyKey` (`${id}:${quoteId}`) cubre el re-submit. Riesgo aceptado y documentado (§8).

### 3.2 Ripple del CAS sobre los otros use-cases (grep confirmado)
`repo.save(r)` se llama en: `create-remittance`, `lock-quote`, `start-kyc` (×3), `resume-kyc`, `track-remittance`, `confirm-and-send` (×4). Como **la firma de `save()` no cambia** y `version` viaja dentro del snapshot, **los 6 use-cases obtienen CAS gratis y transparente** — cero edición en ellos. Todos son secuenciales (`await get → mutate → save`), así que en un flujo normal cada `get()` lee la última versión persistida → no hay falso conflicto. Trace happy-path (`use-cases.test.ts:57`): `create`(→v1) → `startKyc`(get v1→v2) → `lock`(get v2→v3) → `confirm`(get v3→v4→v5→v6) → `track`(get v6→v7). Verde. El hot-path real de doble-submit es **solo** `ConfirmAndSend`; los demás heredan la defensa sin costo.

### 3.3 Validación A5 en `attachQuote` (AC-1/AC-2)
Helper puro (mismo archivo `remittance.ts`, junto a la FSM). Se llama DESPUÉS de `quote_amount_mismatch` (183) y `quote_expired` (184), ANTES de `to("quoted")` (185). No I/O (CD-3).

### 3.4 Wallet M1/M4 (AC-7/8/9)
- **AC-7 (M1)**: los 3 `avalanche` + el `[43114]` → `resolveChain()`/`resolveChainId()` (CD-5).
- **AC-8 (M4)**: en `connect()` de AMBOS adapters, tras obtener la address, comparar chainId de la sesión vs `resolveChainId()`; si difiere → intentar `walletClient.switchChain({id})` / `wallet_switchEthereumChain` (switch **suave**); si el switch falla/rechaza → `throw new Error("wrong_chain")` (recién ahí se bloquea). WalletConnect: leer `provider.request({method:"eth_chainId"})` post-connect y hacer lo mismo.
- **AC-9 (M4)**: en `authorizePrincipal()` de ambos adapters, `if (!this.address || !isAddress(this.address)) throw new Error("invalid_address")` ANTES de `signMessage`. Guard adicional en `connect()` (rechazo temprano de address malformada).
- `noUncheckedIndexedAccess` (CD-6): `requestAddresses()` destructura `const [addr]` (ya manejado con `if(!addr)`); `provider.accounts?.[0]` (optional chaining ya presente).

---

## 4. Constraint Directives (CD-N)

**Heredados del work-item (inmutables):**
- **CD-1**: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/` (ni demo live, ni `wasiai-a2a`, ni agentes `remit-*`).
- **CD-2**: orden de guards `CAS/carrera → expiry re-check → firma → submit` — nunca al revés (§3.1).
- **CD-3**: la validación A5 (AC-1/AC-2) es función **pura** sobre campos del `Quote` — sin I/O, sin `Date.now()`/`Math.random()`.
- **CD-4**: el CAS es **fail-loud** (excepción propagada) — PROHIBIDO "el último gana" silencioso.
- **CD-5**: `NEXT_PUBLIC_CHAIN_ID` (vía `chain.ts`) es la ÚNICA fuente del chainId para AMBOS adapters — PROHIBIDO hardcode en uno y config en el otro.

**Nuevos (heredados del Auto-Blindaje histórico — previenen errores recurrentes ≥2 HUs):**
- **CD-6**: `noUncheckedIndexedAccess` + `strict` ACTIVOS. Todo acceso por índice a array/record es `T|undefined` → usar `?? null` / `!` deliberado / optional chaining; tipar los `vi.fn(async (a:T,b:U)=>...)` cuyos `.mock.calls` se inspeccionan. *(recurrente: WKH-179#2, WKH-181#2)*
- **CD-7**: cambiar la firma de `PayoutSubmit` (nuevo campo requerido) ripplea a TODOS los call-sites, no solo los del Scope IN. `grep -rn` obligatorio ANTES/DESPUÉS: `PayoutSubmit`, `new ConfirmAndSend`, `.attachQuote(`, `.save(`. Arreglar call-sites de test NO listados (`use-cases.test.ts`, `flow-vm.test.ts`, `persistence.test.ts`) para mantener la suite verde ES parte del contrato "typecheck+test verde", NO expansión de scope. *(recurrente: WKH-180#1, WKH-181#1)*
- **CD-8**: copiar los identificadores de tipo EXACTOS de `ports.ts`/`remittance.ts`/`errors.ts` al importar (`PayoutSubmit`, `ConcurrentModificationError`, `RemittanceState`) — no abreviar de memoria. *(WKH-180#2)*
- **CD-9**: al envolver tipos literal-template de `viem` (ej. `Chain`, params de `switchChain`), derivarlos de la lib (`Parameters<>`/`ReturnType<>` o el tipo exportado `Chain`) — no reconstruir el literal a mano. *(WKH-179#1)*
- **CD-10**: PROHIBIDO reabrir WKH-180 (`PayoutAuthorityGateway` / `app/api/payout/validate`) y WKH-181 (`kyc-store.ts` / `toPersistedIdentity` / filtrado de `list()`). Esta HU opera ALREDEDOR de ese código, no lo modifica.

---

## 5. Regresión (el demo sigue llegando a "Entregado")

- **Demo (dev, chain 43114, mock)**: `resolveChainId()` default 43114 = lo que firma hoy → `pickWallet`/REOWN sin cambios visibles. `expectedReceivePen` es ignorado por el mock → payout llega a `settled`. A5 pasa para el quote real del fallback (delta ≤ 0.005 « 14.78). CAS secuencial no genera falso conflicto (§3.2). **Flujo llega a Entregado intacto.**
- **A5 vs fixtures existentes** (verificado): `confirm-and-send.test.ts` quote (send 400, receive 1480, fee 0.5, rate 3.7 → expected 1478.15, delta 1.85 < 14.78) ✅; `remittance.test.ts` `quote()` idem ✅; `use-cases.test.ts` `FakeQuoteGateway` (receive=(amt−0.5)×3.7 exacto) ✅; `flow-vm.test.ts` fixtures NO pasan por `attachQuote` (no dispara A5) ✅.
- **WKH-180 (gate autoridad)**: paso 3 intacto, sus 4 tests de `confirm-and-send.test.ts` verdes (submit ahora lleva `expectedReceivePen` extra — el spy solo cuenta llamadas). **CD-10.**
- **WKH-181 (PII + historial por-wallet)**: `normalizeState` gana default de `version` sin tocar la reducción de identity ni el filtrado de `list()`. Legacy snapshots (sin `version`) → `version:0` → no crashean (`persistence.test.ts` legacy verde). **CD-10.**

---

## 6. Waves de implementación

> W0 serial (contratos/tipos que todos importan). W1..W4 dependen de W0; W3 es independiente de W1/W2 (paralelizable tras W0). Orden recomendado: W0 → W1 → W2 → W3 → W4 → W5.

### W0 — Contratos & tipos (SERIAL, bloquea al resto)
| Archivo | Cambio |
|---------|--------|
| `src/domain/remittance.ts` | `version:number` en `RemittanceState`; `create()` → `version:0`; `rehydrate` preserva; `to()` **no** toca `version`; nuevos métodos `markSaved(v)` y `isQuoteStillValid(now)`. |
| `src/application/errors.ts` **(NEW)** | `class ConcurrentModificationError extends Error` (`reason`, `expected`, `actual`). |
| `src/application/ports.ts` | `PayoutSubmit.expectedReceivePen: Money`. |
| `src/infrastructure/chain.ts` **(NEW)** | `resolveChainId()` + `resolveChain()` (default 43114; 43113→fuji). |

### W1 — A5 validación de dominio (AC-1/AC-2)
| Archivo | Cambio |
|---------|--------|
| `src/domain/remittance.ts` | helper puro de consistencia `receive` en `attachQuote()` (tras amount+expiry, antes de `to`). |
| `src/domain/remittance.test.ts` | tests AC-1/AC-2 (§ Test plan). |

### W2 — A6 CAS (AC-3/AC-4)
| Archivo | Cambio |
|---------|--------|
| `src/infrastructure/persistence.ts` | `LocalRepo.save()` CAS + `markSaved`; `normalizeState()` default `version:0`. |
| `src/test-support/fakes.ts` | `InMemoryRepo.save()` replica el CAS + `markSaved` (import `ConcurrentModificationError`). |
| `src/infrastructure/persistence.test.ts` | tests AC-3/AC-4 (conflicto stale + secuencial sin falso conflicto + legacy sin version). |

### W3 — Wallet M1/M4 (AC-7/AC-8/AC-9) — paralelizable tras W0
| Archivo | Cambio |
|---------|--------|
| `src/infrastructure/wallet.ts` | chain env-driven (3 sitios + WC init); chainId check+switch suave en ambos `connect()`; `isAddress` guard en ambos `authorizePrincipal()` (+`connect()`). |
| `src/infrastructure/chain.test.ts` **(NEW)** | tests AC-7. |
| `src/infrastructure/wallet.test.ts` **(NEW)** | tests AC-8/AC-9 (fake EIP-1193 provider vía stub `globalThis.window`). |

### W4 — M2 expiry + M3 payload + CAS-handling en ConfirmAndSend (AC-5/AC-6)
| Archivo | Cambio |
|---------|--------|
| `src/application/use-cases/confirm-and-send.ts` | expiry re-check (§3.1 paso 4); `expectedReceivePen: quote.receive` en `submit()`. |
| `src/test-support/fakes.ts` | `ScriptedClock` (secuencia de `now` para AC-5). |
| `src/application/use-cases/confirm-and-send.test.ts` | tests AC-5/AC-6 (extiende suite WKH-180). |

### W5 — Docs
| Archivo | Cambio |
|---------|--------|
| `.env.example` | documentar `NEXT_PUBLIC_CHAIN_ID` (default 43114) + `NEXT_PUBLIC_REOWN_PROJECT_ID` (gap adyacente). |

---

## 7. Test plan (≥1 por AC — QA cita archivo:línea)

| AC | Archivo de test | Caso |
|----|-----------------|------|
| AC-1 | `remittance.test.ts` (NEW) | `attachQuote` con `receive` consistente (dentro de tolerancia) → `status==="quoted"`. |
| AC-2 | `remittance.test.ts` (NEW) | `receive` inflado > tolerancia → throw `quote_receive_mismatch`, `status` NO pasa a `quoted`. **Boundary**: justo dentro pasa / justo afuera falla. |
| AC-3 | `persistence.test.ts` (NEW) | dos `get()` del mismo id (versión V); un `save()` avanza persistido a V+1; el `save()` del stale (aún V) → `ConcurrentModificationError`. + secuencial (get→save×N) sin falso conflicto. |
| AC-4 | `persistence.test.ts` / `fakes` | el conflicto se propaga (fail-loud), NO pisa el estado ganador (verificar snapshot persistido = el del ganador). |
| AC-5 | `confirm-and-send.test.ts` (NEW) | `ScriptedClock` = [T0 (confirm válido), T>expiry (re-check)]; authority true → `status==="payout_failed"`, `failureReason==="quote_expired_before_submit"`, `authorizePrincipal`+`submit` **NO** llamados (spies). |
| AC-6 | `confirm-and-send.test.ts` (NEW) | happy path; `submitSpy` recibe `expectedReceivePen` `.toEqual(Money.of(1480,"PEN"))` (== `quote.receive`). |
| AC-7 | `chain.test.ts` (NEW) | env unset → `resolveChainId()===43114` & `resolveChain().id===43114`; `="43113"` → fuji; `="99"`/basura → default 43114. |
| AC-8 | `wallet.test.ts` (NEW) | provider mock con `getChainId`/`eth_chainId` = otra red → `connect()` dispara `wallet_switchEthereumChain`; si el switch rechaza → throw `wrong_chain`; si matchea → connect OK. |
| AC-9 | `wallet.test.ts` (NEW) | provider devuelve address malformada/nula → `authorizePrincipal` throw `invalid_address`, sin `signMessage`. |

**Regresión obligatoria**: `npm run qa` (typecheck + vitest) — verde en `use-cases.test.ts`, `flow-vm.test.ts`, `kyc-store.test.ts`, `abandon-pending-kyc.test.ts` y los 4 tests WKH-180 de `confirm-and-send.test.ts`.

---

## 8. Riesgos & mitigaciones

| Riesgo | Mitigación |
|--------|-----------|
| `save()` final post-submit lanza CAS (conflicto post-hoc, plata ya movida en la versión real) | La `idempotencyKey` cubre el re-submit; el 1er `save()` (guard de carrera) ya bloqueó a los perdedores antes de firma/submit. Documentado, aceptado para esta HU (mock). |
| A5 no detecta `rate` manipulado (solo `receive` vs `send/fee/rate` del propio quote) | Alcance explícito de AC-1; el `rate` manipulado es otro vector (fuera de scope). Tolerancia 1% caza el tampering grueso. |
| Overlap de merge con WKH-183 en `fallback/gateways.ts` | **Eliminado**: esta HU decide NO tocar `fallback/gateways.ts` (`expectedReceivePen` es estructural). Sin colisión en ese archivo. Otros archivos compartidos: coordinar orden de merge (WKH-182 antes que WKH-168). |
| `wallet.test.ts` sin jsdom | Stub `globalThis.window`/`window.ethereum` con fake EIP-1193 (patrón de `persistence.test.ts:34-41`). Si el mock de viem resulta frágil, el core (AC-7 puro en `chain.test.ts` + AC-9 address) queda cubierto igual. |
| `switchChain` de viem con tipos literal-template | CD-9: usar el tipo `Chain`/params exportados por viem, no reconstruir (`toHex(chainId)` de viem para el param). |

---

## 9. Readiness Check

- [x] Los 3 `[NEEDS CLARIFICATION]` resueltos (chain 43114 env-driven / tolerancia max(0.02, 1%) / CAS excepción tipada + version). **Sin TBD abierto.**
- [x] Todos los exemplars verificados (Read/Bash): `viem` exports, `tsconfig` flags, `persistence.test.ts` existe, líneas de grounding confirmadas post-180/181.
- [x] Scope IN cubierto + 4 archivos net-new justificados (`errors.ts`, `chain.ts`, `chain.test.ts`, `wallet.test.ts`), todos dentro de `chaski-v2/` (CD-1).
- [x] CDs heredados (1-5) + nuevos anti-recurrencia (6-10) del Auto-Blindaje.
- [x] Orden de guards CD-2 documentado (§3.1); convive con WKH-180 sin reabrirlo (CD-10).
- [x] ≥1 test por AC (§7) + regresión demo + WKH-180/181 verde.
- [x] Ripple de `save()` analizado (§3.2): firma intacta → cero edición en los otros 5 use-cases.

**Veredicto: LISTO para SPEC_APPROVED.** No hay ambigüedad residual; el Dev puede implementar wave por wave desde el Story File (F2.5).
</content>
</invoke>
