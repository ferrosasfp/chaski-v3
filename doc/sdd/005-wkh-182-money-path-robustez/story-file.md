# Story File — #005: [WKH-182] Money-path robustez (validación de dominio del quote, lock optimista, chain configurable, monto lockeado al payout)

> SDD: `doc/sdd/005-wkh-182-money-path-robustez/sdd.md`
> Work-item: `doc/sdd/005-wkh-182-money-path-robustez/work-item.md`
> Fecha: 2026-07-11
> Branch: `fix/182-money-path-robustez`
> Repo: `chaski-v2/` (100% este repo — CD-1)
> Base: `main` post WKH-178/179/180/181 (todas DONE, mergeadas, live)

---

## Goal

Endurecer 6 invariantes del **money-path** que hoy son **latentes** (la firma es simbólica —
`signMessage`, no EIP-3009 real— y el payout es `FallbackPayoutGateway` MOCK) pero se vuelven
**reales y explotables** en cuanto WKH-168 (desembolso real) + la firma EIP-3009 real entren en prod:

| # | Hallazgo | AC |
|---|----------|----|
| **A5** | el dominio no valida que `receive` sea consistente con `send`/`feeUsd`/`rate` | AC-1, AC-2 |
| **A6** | `ConfirmAndSend` + `LocalRepo.save()` hacen read-modify-write ciego (doble-confirm/submit en carrera) | AC-3, AC-4 |
| **M1** | chain hardcodeada a Avalanche mainnet (43114) en vez de env | AC-7 |
| **M2** | `expiresAt` no se re-chequea entre `confirm()` y `submit()` (ventana de firma real = minutos) | AC-5 |
| **M3** | `submit()` recibe `amountUsd` (USDC bruto) pero NO el `receive` PEN lockeado que el usuario confirmó | AC-6 |
| **M4** | sin verificación de `chainId` post-connect ni validación de la address antes de firmar | AC-8, AC-9 |

**Contexto crítico que el Dev DEBE tener presente:**
- Todo el trabajo es **`chaski-v2/`** (CD-1). NO tocar el demo live (`yarvis`/`wasiai-v2`/`agentshop-*`), ni `wasiai-a2a`, ni los agentes `remit-*`.
- **NO reabrir WKH-180** (`PayoutAuthorityGateway` / `app/api/payout/validate`) ni **WKH-181** (`kyc-store.ts` / `toPersistedIdentity` / filtrado de `list()`). Esta HU opera **alrededor** de ese código (CD-10).
- El demo debe seguir llegando a **"Entregado"** (settled): `resolveChainId()` default 43114 = lo que firma hoy; el mock ignora `expectedReceivePen`; A5 pasa holgado para el quote real del fallback; el CAS secuencial NO genera falso conflicto. Regresión completa en §Regresión.
- Esta HU **mergea ANTES que WKH-183** y antes que WKH-168. El único overlap con WKH-183 es `.env.example` (vars distintas: 182 agrega `NEXT_PUBLIC_CHAIN_ID`; 183 agrega REOWN + KYC_MODE) → diff acotado, auto-merge. Ver §Coordinación de merge.

---

## Acceptance Criteria (EARS)

> Copiados del work-item aprobado. QA los verifica en F4 con evidencia archivo:línea.

- **AC-1**: WHEN `Remittance.attachQuote()` recibe un `Quote`, el sistema SHALL validar que `quote.receive` es consistente con `quote.send`, `quote.feeUsd` y `quote.rate` (fórmula `receive ≈ (send − feeUsd) × rate`, con tolerancia de redondeo).
- **AC-2**: IF `receive` diverge más allá de la tolerancia, THEN el sistema SHALL rechazar `attachQuote()` (lanzar `quote_receive_mismatch`) y NO transicionar a `quoted`.
- **AC-3**: WHEN `ConfirmAndSend.execute()` persiste vía `RemittanceRepository.save()`, el sistema SHALL usar un token de versión/concurrencia leído al inicio para detectar si el estado persistido cambió desde esa lectura.
- **AC-4**: IF el token de versión no coincide con el persistido al escribir (carrera detectada), THEN el sistema SHALL fallar-loud (NO pisar silenciosamente el estado ajeno) con razón explícita (`concurrent_modification`), sin continuar a firma/`submit()` si se detecta antes de esos pasos.
- **AC-5**: WHILE el flujo está entre `r.confirm()` y `payouts.submit()`, el sistema SHALL re-chequear inmediatamente antes de `submit()` que `quote.expiresAt` no venció, y IF venció THEN marcar la remesa `payout_failed` con razón `quote_expired_before_submit` SIN llamar a `submit()` ni a `authorizePrincipal()`.
- **AC-6**: WHEN `ConfirmAndSend` invoca `payouts.submit()`, el sistema SHALL incluir el `quote.receive` (Money PEN) lockeado como parte del `PayoutSubmit`.
- **AC-7**: el sistema SHALL derivar el chainId de los adapters de `WalletPort` de `NEXT_PUBLIC_CHAIN_ID` (default **43114 Avalanche mainnet**) en vez de un import hardcodeado de `viem/chains`.
- **AC-8**: WHEN una wallet completa `connect()`, el sistema SHALL verificar que el chainId de la sesión coincide con el configurado, y IF no coincide THEN requerir un chain-switch **suave** (`wallet_switchEthereumChain`) antes de permitir `authorizePrincipal()` (si el switch se rechaza → `throw "wrong_chain"`).
- **AC-9**: WHEN `authorizePrincipal()` va a pedir la firma, el sistema SHALL validar que la address es EVM bien formada y no-nula, y IF es nula/malformada THEN abortar (`throw "invalid_address"`) SIN pedir la firma.

---

## ⚠️ Anti-Hallucination Anchors (líneas REALES verificadas con Read sobre `main` — 2026-07-11)

> **Estos anchors son la fuente de verdad.** Si al abrir un archivo la línea no coincide (por merge previo), buscá el CONTENIDO citado — NO confíes ciegamente en el número.

### `src/domain/remittance.ts`
| Símbolo | Línea REAL | Qué anclar |
|---------|-----------|-----------|
| `Quote` interface | **L15-24** | campos `send` L17, `receive` L18, `feeUsd` L19, `rate` L20, `expiresAt` L22 → insumos de A5 |
| `RemittanceState` | **L105-121** | tiene `createdAt` L119 + `updatedAt` L120; **NO tiene `version`** → agregar `version: number` |
| `create()` | **L126-146** | todos los campos inicializados L129-145 → agregar `version: 0` |
| `rehydrate(state)` | **L148-150** | `new Remittance({ ...state })` → preserva `version` automáticamente (spread) |
| `get snapshot` | **L152-154** | devuelve `this.state` (`Readonly<RemittanceState>`) |
| `to(next, now, patch)` | **L162-167** | `{ ...this.state, ...patch, status: next, updatedAt: now }` → **NO** toca `version` (concern de persistencia, no de la FSM) |
| `attachQuote(quote, now)` | **L181-186** | `quote_amount_mismatch` L183 → `quote_expired` L184 → `to("quoted")` L185 → **insertar A5 entre L184 y L185** |
| `confirm(now)` | **L189-196** | invariante KYC + quote no vencido; L194 usa `isQuoteExpired` |
| `markPayoutFailed(reason, now)` | **L207-209** | `this.to("payout_failed", now, { failureReason: reason })` → usado por M2/AC-5 |
| `isQuoteExpired(quote, now)` | **L214-216** (`private`) | `new Date(quote.expiresAt).getTime() <= new Date(now).getTime()` → **reusar** desde el nuevo `isQuoteStillValid` público |
| `TRANSITIONS` | **L85-97** | `confirmed → payout_failed` es transición válida (L91) → AC-5 puede fallar-loud sin romper la FSM |

### `src/application/use-cases/confirm-and-send.ts`
| Símbolo | Línea REAL | Qué anclar |
|---------|-----------|-----------|
| ctor 5-arg | **L15-22** | `(wallet, payouts, repo, clock, authority)` — NO cambia |
| `repo.get()` | **L25** | lectura base → snapshot con `version` V |
| `r.confirm()` + `repo.save(r)` | **L29-30** | **el `save()` de L30 es el GUARD DE CARRERA (CAS/AC-3/4)**; está FUERA del try/catch → propaga ANTES de firma/submit |
| enforcement WKH-180 | **L40-49** | `getAddress()` L40 → `authority.authorize()` L41-44 → fail path L45-48. **INTACTO (CD-10)**. El expiry re-check (M2) va JUSTO DESPUÉS de L49 |
| `authorizePrincipal()` + save | **L53-55** | FIRMA. El re-check de M2 va ANTES de L53 |
| `submit({...})` | **L60-66** | **agregar `expectedReceivePen: quote.receive`** (M3/AC-6). NO reemplazar `amountUsd` L62 |
| `idempotencyKey` | **L58** | `${s.id}:${quote.quoteId}` — cubre el re-submit |
| `save` final | **L76** | dentro del try/catch — también es CAS (conflicto post-submit se propaga, riesgo aceptado §Riesgos) |

### `src/infrastructure/persistence.ts`
| Símbolo | Línea REAL | Qué anclar |
|---------|-----------|-----------|
| `normalizeState(s)` | **L44-48** | `{ ...s, kyc, ownerAddress }` → **agregar default `version`** (`typeof s.version === "number" ? s.version : 0`) para snapshots legacy |
| `read()` | **L69-80** | mapea con `normalizeState` L76 — el default de `version` entra acá |
| `LocalRepo.save(r)` | **L91-95** | **blind RMW actual** → reemplazar por CAS (§Diseño CAS) |
| `get(id)` | **L97-100** | `Remittance.rehydrate(s)` — hereda `version` del snapshot |
| `list(address)` | **L102-109** | **NO TOCAR** (WKH-181, CD-10) |

### `src/infrastructure/wallet.ts`
| Símbolo | Línea REAL | Qué anclar |
|---------|-----------|-----------|
| `import { avalanche }` | **L4** | → reemplazar uso por `resolveChain()` de `./chain` (AC-7/CD-5) |
| `InjectedWallet.connect()` | **L18-26** | `createWalletClient({ chain: avalanche })` L21 → `resolveChain()`; agregar check chainId + switch suave (AC-8) + guard `isAddress` (AC-9) |
| `InjectedWallet.authorizePrincipal()` | **L32-43** | `chain: avalanche` L35 → `resolveChain()`; guard `isAddress(this.address)` ANTES de `signMessage` L38 (AC-9) |
| `WalletConnectWallet.ensureProvider()` | **L77-95** | `chains: [43114]` L83 → `chains: [resolveChainId()]` (AC-7/CD-5) |
| `WalletConnectWallet.connect()` | **L97-104** | tras `provider.accounts?.[0]` L100: check `eth_chainId` + switch suave (AC-8) + guard `isAddress` (AC-9) |
| `WalletConnectWallet.authorizePrincipal()` | **L110-119** | `chain: avalanche` L113 → `resolveChain()`; guard `isAddress` ANTES de `signMessage` L114 (AC-9) |
| `FallbackWallet` | **L47-60** | **NO TOCAR** (demo simulado, address `0xDEMO...` no es EVM válida — no le apliques AC-8/AC-9 o rompés el demo) |
| `pickWallet()` | **L128-133** | **NO TOCAR** — la chain se resuelve dentro de los adapters, no acá |

### `src/application/ports.ts`
| Símbolo | Línea REAL | Qué anclar |
|---------|-----------|-----------|
| `PayoutSubmit` | **L63-69** | **agregar `expectedReceivePen: Money`** (M3/AC-6). `Money` YA está importado (L5). NO tocar `amountUsd` L65 |
| `PayoutRecord` | **L70-76** | `deliveredPen` L73 — NO tocar |
| `WalletPort` | **L96-100** | firma intacta |
| `RemittanceRepository` | **L109-114** | **firma de `save(r)` NO cambia** (L110); el token viaja dentro del snapshot |
| `PayoutAuthorityGateway` | **L90-93** | **NO TOCAR** (WKH-180, CD-10) |

### `src/test-support/fakes.ts`
| Símbolo | Línea REAL | Qué anclar |
|---------|-----------|-----------|
| `T0` / `QUOTE_EXPIRES` | **L32-33** | `"2026-07-09T18:00:00.000Z"` / `"...18:10:00.000Z"` (T0 + 10 min) — insumos de ScriptedClock |
| `FixedClock` | **L35-43** | mismo valor siempre → NO sirve para AC-5; agregar `ScriptedClock` |
| `InMemoryRepo` | **L52-67** | `save()` L54-56 blind → replicar CAS gemelo del `LocalRepo` (import `ConcurrentModificationError`) |
| `FakeQuoteGateway` | **L69-85** | rate 3.7, `receive=(amt−0.5)×3.7` exacto → pasa A5 |
| `FakePayoutGateway.submit(_req)` | **L140-149** | ignora `_req` → aceptar `expectedReceivePen` NO lo rompe (sin cambio de código) |
| `FakeWallet` | **L162-172** | address `"0xSender"` — NO es EVM válida bajo `isAddress`, pero **estos tests NO ejercitan los adapters reales** → no impacta |
| `beneficiary()` | **L195-200** | helper de fixtures |

### Archivos NEW (net-new, todos dentro de `chaski-v2/` — CD-1)
| Archivo | Contenido |
|---------|-----------|
| `src/application/errors.ts` | `class ConcurrentModificationError extends Error` (`reason` + `expected` + `actual`) |
| `src/infrastructure/chain.ts` | `resolveChainId()` + `resolveChain()` |
| `src/infrastructure/chain.test.ts` | tests AC-7 |
| `src/infrastructure/wallet.test.ts` | tests AC-8/AC-9 (stub `globalThis.window` + fake EIP-1193, patrón `persistence.test.ts:34-41`) |

> `src/domain/remittance.test.ts` NO es net-new: **ya existe** (WKH-181) → se EXTIENDE con AC-1/AC-2.

**Verificado además:**
- `viem@^2.21.0` exporta `avalanche` (43114), `avalancheFuji` (43113), `isAddress`, `getAddress`, `toHex` (confirmado). El tipo `Chain` se importa de `viem`.
- `tsconfig.json` tiene `strict` + `noUncheckedIndexedAccess` activos (CD-6).
- `persistence.test.ts` YA existe (WKH-181) → se EXTIENDE con AC-3/AC-4, no se crea.
- `confirm-and-send.test.ts` YA existe (WKH-180, 4 tests) → se EXTIENDE con AC-5/AC-6, no se reemplaza.
- No hay `vitest.config.*` → env de test = `node` (sin `window`). Los tests de wallet/persistence que tocan `localStorage`/`window.ethereum` **inyectan un stub** en `globalThis.window` (jsdom NO está instalado).

---

## Diseño CAS (lock optimista) — LEER ANTES DE CODEAR (AC-3/AC-4, CD-4)

**Regla central:** el token de concurrencia es un `version: number` que viaja **dentro del snapshot**. La firma de `RemittanceRepository.save(r)` **NO cambia** → los otros 5 use-cases obtienen CAS transparente, cero edición.

### Dominio (`remittance.ts`)
```ts
// RemittanceState: agregar el campo
version: number;

// create(): inicializar
version: 0,

// rehydrate(): ya lo preserva por el spread { ...state } — no tocar

// to(): NO tocar version (la versión NO es concern de la FSM, se bumpea al escribir)

// NUEVO método — re-sincroniza la instancia tras un save (repo → agregado)
markSaved(v: number): void {
  this.state = { ...this.state, version: v };
}
```

### Infra (`persistence.ts` — `LocalRepo.save`) y su gemelo (`fakes.ts` — `InMemoryRepo.save`)
```ts
async save(r: Remittance): Promise<void> {
  const map = this.read();                       // LocalRepo: this.read(); InMemoryRepo: this.store
  const existing = map.get(r.snapshot.id);
  if (existing && existing.version !== r.snapshot.version) {
    throw new ConcurrentModificationError(r.snapshot.id, r.snapshot.version, existing.version);
  }
  const next = r.snapshot.version + 1;
  map.set(r.snapshot.id, { ...r.snapshot, version: next });
  this.write(map);                               // InMemoryRepo: no-op (el Map ES el store)
  r.markSaved(next);                             // sincroniza la instancia para el PRÓXIMO save() de la cadena
}
```

**Por qué `markSaved`:** `ConfirmAndSend` hace hasta 4 `save()` sobre la MISMA instancia rehidratada. Sin re-sincronizar la versión, el 2º `save()` chocaría **consigo mismo** (persistido = V+1, instancia = V). `markSaved(next)` iguala instancia y persistido tras cada escritura. Es un acople controlado repo→agregado, análogo a un ORM que devuelve la versión tras el flush.

**Traza de la carrera (AC-3/AC-4):** dos `get()` del mismo id leen version V. `r1.save()` → `existing.version(V)===r1.snapshot.version(V)` OK → persiste V+1, `r1.markSaved(V+1)`. `r2` sigue con snapshot.version V → `r2.save()` → `existing.version(V+1) !== V` → **throw `ConcurrentModificationError`** (fail-loud, NO pisa a r1). El estado persistido queda = el de r1 (el ganador).

**`ConcurrentModificationError` (`src/application/errors.ts`, NEW):**
```ts
export class ConcurrentModificationError extends Error {
  readonly reason = "concurrent_modification" as const;
  constructor(readonly id: string, readonly expected: number, readonly actual: number) {
    super(`concurrent_modification:${id} expected=${expected} actual=${actual}`);
    this.name = "ConcurrentModificationError";
  }
}
```
Vive en `application/` para que la importen tanto `infrastructure/persistence.ts` como `test-support/fakes.ts` sin ciclo (application no depende de infra).

**Ripple:** `repo.save(r)` se llama en `create-remittance`, `lock-quote`, `start-kyc`, `resume-kyc`, `track-remittance` + `confirm-and-send` (×4). Como la firma NO cambia y son todos secuenciales (`await get → mutate → save`), cada `get()` lee la última versión → **cero falso conflicto, cero edición en esos 5 use-cases**. Verificar con `grep -rn '\.save(' src/application/use-cases/` que ninguno construya su propio snapshot fuera del agregado.

---

## Validación de dominio A5 (`attachQuote`) — LEER ANTES DE CODEAR (AC-1/AC-2, CD-3)

Helper **puro** en `remittance.ts` (sin I/O, sin `Date.now()`/`Math.random()`), llamado en `attachQuote()` **DESPUÉS** de `quote_expired` (L184) y **ANTES** de `to("quoted")` (L185):

```ts
const RECEIVE_TOL_ABS_PEN = 0.02; // 2 centavos — absorbe redondeo a 2 decimales de PEN
const RECEIVE_TOL_REL = 0.01;     // 1%

// puro: espeja netUsd = max(0, send − fee) del gateway (fallback/gateways.ts:49)
function assertReceiveConsistent(quote: Quote): void {
  const expected = Math.max(0, quote.send.major - quote.feeUsd.major) * quote.rate;
  const allowedDelta = Math.max(RECEIVE_TOL_ABS_PEN, expected * RECEIVE_TOL_REL);
  if (Math.abs(quote.receive.major - expected) > allowedDelta) {
    throw new Error("quote_receive_mismatch");
  }
}
```
- Comparar en unidades **`major`** (PEN), montos de remesa caben holgados en safe-int.
- Alcance (documentado): A5 valida `receive` contra el `send`/`fee`/`rate` **del propio quote** — NO detecta un `rate` manipulado (otro vector, fuera de scope). Es un límite de sanidad defensivo (caza tampering grueso: `receive` inflado 2×, degradado a la mitad), no una auditoría de precisión.
- **Boundary test obligatorio** (AC-2): justo dentro de la tolerancia pasa; justo afuera falla.

---

## Chain env-driven (`chain.ts`) — AC-7/M1, CD-5

**Única fuente del chainId para AMBOS adapters** (PROHIBIDO hardcode en uno y config en el otro):
```ts
import { avalanche, avalancheFuji } from "viem/chains";
import type { Chain } from "viem";

export function resolveChainId(): number {
  const raw = process.env.NEXT_PUBLIC_CHAIN_ID;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  // solo Avalanche mainnet/Fuji soportados; cualquier otra cosa (unset, "99", basura) → 43114 (prod actual, fail-safe)
  return n === 43113 ? 43113 : 43114;
}
export function resolveChain(): Chain {
  return resolveChainId() === 43113 ? avalancheFuji : avalanche;
}
```
Funciones (no consts congeladas) → testeables re-leyendo `process.env`. Default **43114** (lo que firma el demo hoy). Flipear a Fuji (43113) queda atado a WKH-168/EIP-3009 real (fuera de scope).

---

## Expiry re-check M2 + payload M3 en `ConfirmAndSend` — AC-5/AC-6, CD-2

**Método público nuevo en `remittance.ts`** (reusa el `private isQuoteExpired`, mantiene el dominio puro con `now` inyectado):
```ts
isQuoteStillValid(now: string): boolean {
  return this.state.quote != null && !this.isQuoteExpired(this.state.quote, now);
}
```

**Orden de guards en `execute()` (CD-2 — NUNCA al revés):**
```
1. r = repo.get(id)                                    // version V
2. r.confirm(now); repo.save(r)  ◄── GUARD CARRERA (AC-3/4): CAS, FUERA del try/catch → propaga antes de firma/submit
3. authority.authorize(...)                            // WKH-180 INTACTO (L40-49) — CD-10
   if (!auth.authorized) → markPayoutFailed + save + return
4. if (!r.isQuoteStillValid(now)) ◄── GUARD EXPIRY (AC-5/M2):
       markPayoutFailed("quote_expired_before_submit", now); repo.save(r); return   // SIN authorizePrincipal, SIN submit
5. wallet.authorizePrincipal(quote)                    // FIRMA
   r.markPrincipalIn(tx, now); repo.save(r)
6. payouts.submit({ ..., expectedReceivePen: quote.receive })   // SUBMIT (AC-6/M3)
```
El re-check (paso 4) va **entre** la autoridad (L49) y `authorizePrincipal` (L53). `expectedReceivePen: quote.receive` se agrega al objeto de `submit()` (L60-66) sin quitar `amountUsd`.

---

## `ScriptedClock` para AC-5 (`fakes.ts`)

`FixedClock` devuelve el mismo `now` siempre → no puede simular "válido en confirm, vencido en re-check". Agregar:
```ts
export class ScriptedClock implements Clock {
  private i = 0;
  constructor(private readonly seq: string[]) {}
  nowIso(): string {
    const v = this.seq[Math.min(this.i, this.seq.length - 1)]; // clamp (CD-6: index → T|undefined)
    this.i++;
    return v ?? "";
  }
}
```
AC-5: `new ScriptedClock([T0, "2026-07-09T18:11:00.000Z"])` → 1ª llamada (confirm L29) = T0 válido; llamadas siguientes (re-check + markPayoutFailed) = T posterior a `QUOTE_EXPIRES` (18:10).

---

## Wallet M1/M4 (`wallet.ts`) — AC-7/AC-8/AC-9, CD-5/CD-6/CD-9

- **AC-7 (M1)**: reemplazar los 3 usos de `avalanche` (L21, L35, L113) por `resolveChain()` y `chains: [43114]` (L83) por `chains: [resolveChainId()]`. Import de `./chain`.
- **AC-8 (M4)** — check chainId + switch suave en AMBOS `connect()`:
  - `InjectedWallet.connect()`: tras obtener la address (L23), leer el chainId con `client.getChainId()`; si `!== resolveChainId()` → intentar `client.switchChain({ id: resolveChainId() })`; si el switch rechaza/falla → `throw new Error("wrong_chain")`.
  - `WalletConnectWallet.connect()`: tras `provider.accounts?.[0]` (L100), leer `provider.request({ method: "eth_chainId" })` (hex → `Number.parseInt(hex, 16)`); si difiere → `provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(resolveChainId()) }] })`; si rechaza → `throw new Error("wrong_chain")`. **CD-9**: usar `toHex` de viem para el param, NO reconstruir el literal hex a mano.
- **AC-9 (M4)** — guard de address en AMBOS `authorizePrincipal()` (y refuerzo en `connect()`): `if (!this.address || !isAddress(this.address)) throw new Error("invalid_address")` ANTES de `signMessage` (L38 / L114). Import `isAddress` de `viem`.
- **NO tocar `FallbackWallet`** (L47-60): su address `0xDEMO...` no es EVM válida — aplicarle AC-8/AC-9 rompería el demo.
- **CD-6**: `const [addr] = await client.requestAddresses()` ya maneja `if (!addr)`; `provider.accounts?.[0]` ya usa optional chaining.

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | AC |
|---|---------|--------|-----------|----|
| 1 | `src/application/errors.ts` | **Crear** | `ConcurrentModificationError` (§Diseño CAS) | AC-4 |
| 2 | `src/infrastructure/chain.ts` | **Crear** | `resolveChainId()` + `resolveChain()` | AC-7 |
| 3 | `src/domain/remittance.ts` | Modificar | `version` en `RemittanceState` + `create()` → `0` + `markSaved(v)` + `isQuoteStillValid(now)` + helper A5 en `attachQuote()`. `to()` NO toca `version` | AC-1/2/3/5 |
| 4 | `src/application/ports.ts` | Modificar | `PayoutSubmit.expectedReceivePen: Money` (L63-69). `save()` firma intacta | AC-6 |
| 5 | `src/infrastructure/persistence.ts` | Modificar | `LocalRepo.save()` CAS (L91-95) + `normalizeState` default `version` (L44-48) | AC-3/4 |
| 6 | `src/test-support/fakes.ts` | Modificar | `InMemoryRepo.save()` CAS gemelo (L54-56) + `ScriptedClock` (NEW) | AC-3/4/5 |
| 7 | `src/application/use-cases/confirm-and-send.ts` | Modificar | expiry re-check (§M2, entre L49 y L53) + `expectedReceivePen: quote.receive` en `submit()` (L60-66) | AC-5/6 |
| 8 | `src/infrastructure/wallet.ts` | Modificar | chain env-driven (L21/35/83/113) + switch suave en ambos `connect()` + `isAddress` guard en ambos `authorizePrincipal()` | AC-7/8/9 |
| 9 | `.env.example` | Modificar | documentar `NEXT_PUBLIC_CHAIN_ID` (default 43114) + `NEXT_PUBLIC_REOWN_PROJECT_ID` (gap adyacente) | AC-7 |
| 10 | `src/domain/remittance.test.ts` | Modificar | YA existe (WKH-181) → EXTENDER con tests AC-1/AC-2 (consistente + inflado + boundary), no reemplazar | AC-1/2 |
| 11 | `src/infrastructure/persistence.test.ts` | Modificar | tests AC-3/AC-4 (conflicto stale + secuencial sin falso conflicto + legacy sin `version` → 0) | AC-3/4 |
| 12 | `src/infrastructure/chain.test.ts` | **Crear** | tests AC-7 (unset→43114; "43113"→fuji; "99"/basura→43114) | AC-7 |
| 13 | `src/infrastructure/wallet.test.ts` | **Crear** | tests AC-8 (chain mismatch → switch; rechazo → `wrong_chain`) + AC-9 (address nula/malformada → `invalid_address` sin `signMessage`) | AC-8/9 |
| 14 | `src/application/use-cases/confirm-and-send.test.ts` | Modificar | tests AC-5 (`ScriptedClock`, expiró → `payout_failed`, spies NO llamados) + AC-6 (`submitSpy` recibe `expectedReceivePen`) | AC-5/6 |

**NO tocar (fuera de la tabla):** `persistence.ts:list()`, `kyc-store.ts`, `toPersistedIdentity`, `app/api/payout/validate`, `PayoutAuthorityGateway`, `FallbackWallet`, `pickWallet`, `container.ts`, `fallback/gateways.ts` (M3 es estructural, el mock ignora el campo — **cero edición** ahí), `flow.tsx`, y los otros 5 use-cases (`create-remittance`/`lock-quote`/`start-kyc`/`resume-kyc`/`track-remittance`).

---

## Constraint Directives

### PROHIBIDO
- **CD-1**: tocar cualquier archivo fuera de `chaski-v2/` (demo live `yarvis`/`wasiai-v2`/`agentshop-*`, `wasiai-a2a`, agentes `remit-*`).
- **CD-2**: llamar a `authorizePrincipal()` o `submit()` si el CAS (AC-4) o el expiry re-check (AC-5) ya determinaron abortar. Orden: **CAS/carrera → expiry re-check → firma → submit** (nunca al revés).
- **CD-3**: que A5 dependa de I/O — es función **pura** sobre campos del `Quote` (sin red, sin `Date.now()`/`Math.random()`).
- **CD-4**: CAS silencioso "el último gana" — es **fail-loud** (excepción propagada).
- **CD-5**: hardcodear chainId en un adapter y config en el otro — `NEXT_PUBLIC_CHAIN_ID` (vía `chain.ts`) es la ÚNICA fuente para AMBOS.
- **CD-10**: reabrir WKH-180 (`PayoutAuthorityGateway`, `app/api/payout/validate`) o WKH-181 (`kyc-store.ts`, `toPersistedIdentity`, `list()` filtrado). Operás alrededor, no lo modificás.

### OBLIGATORIO (anti-recurrencia — Auto-Blindaje histórico)
- **CD-6** *(recurrente WKH-179#2 / WKH-181#2)*: `noUncheckedIndexedAccess` + `strict` ACTIVOS. Todo acceso por índice a array/record es `T|undefined` → `?? null` / `!` deliberado / optional chaining. Tipar los `vi.fn(async (a:T)=>...)` cuyos `.mock.calls` se inspeccionan. Sin `any` explícito.
- **CD-7** *(recurrente WKH-180#1 / WKH-181#1)*: agregar un campo a `PayoutSubmit` ripplea a TODOS los call-sites. `grep -rn` obligatorio ANTES/DESPUÉS: `PayoutSubmit`, `new ConfirmAndSend`, `.attachQuote(`, `.save(`. Arreglar los call-sites de test NO listados para mantener la suite verde ES parte del contrato "typecheck+test verde", NO expansión de scope.
- **CD-8** *(WKH-180#2)*: copiar los identificadores EXACTOS de `ports.ts`/`remittance.ts`/`errors.ts` al importar (`PayoutSubmit`, `ConcurrentModificationError`, `RemittanceState`) — no abreviar de memoria.
- **CD-9** *(WKH-179#1)*: al envolver tipos literal-template de `viem` (`Chain`, params de `switchChain`/`wallet_switchEthereumChain`), derivarlos de la lib (tipo `Chain` exportado, `toHex()`) — no reconstruir el literal a mano.

---

## Regresión (el demo sigue llegando a "Entregado") — verificar antes de dar por hecho

- **Demo (dev, chain 43114, mock)**: `resolveChainId()` default 43114 = lo que firma hoy → `pickWallet`/REOWN sin cambio visible. `expectedReceivePen` ignorado por el mock → payout llega a `settled`. A5 pasa (delta « 14.78). CAS secuencial sin falso conflicto.
- **A5 vs fixtures existentes** (verificado): `confirm-and-send.test.ts` quote (send 400, receive **1480**, fee 0.5, rate 3.7 → expected 1478.15, delta 1.85 < 14.78) ✅; `FakeQuoteGateway` (`receive=(amt−0.5)×3.7` exacto) ✅; `use-cases.test.ts` happy path ✅.
- **WKH-180** (4 tests de `confirm-and-send.test.ts`): paso 3 intacto; `submit` ahora lleva `expectedReceivePen` extra — los spies (`submitSpy`, `authorizeSpy`) solo cuentan llamadas → verdes.
- **WKH-181**: `normalizeState` gana default de `version` sin tocar la reducción de identity ni el filtrado de `list()`. Legacy sin `version` → `version:0` → `persistence.test.ts` legacy verde.

---

## Test Expectations (≥1 por AC — QA cita archivo:línea en F4)

| AC | Archivo | Caso |
|----|---------|------|
| AC-1 | `remittance.test.ts` | `attachQuote` con `receive` consistente (dentro de tolerancia) → `status==="quoted"` |
| AC-2 | `remittance.test.ts` | `receive` inflado > tolerancia → throw `quote_receive_mismatch`, `status` NO pasa a `quoted`. **Boundary**: justo dentro pasa / justo afuera falla |
| AC-3 | `persistence.test.ts` | dos `get()` del mismo id (version V); un `save()` avanza a V+1; el `save()` del stale (aún V) → `ConcurrentModificationError`. + secuencial (get→save×N) sin falso conflicto |
| AC-4 | `persistence.test.ts` | el conflicto se propaga (fail-loud); snapshot persistido == el del ganador (NO pisado). + legacy sin `version` → normaliza a 0 sin crashear |
| AC-5 | `confirm-and-send.test.ts` | `ScriptedClock([T0, T>expiry])`, authority true → `status==="payout_failed"`, `failureReason==="quote_expired_before_submit"`, `authorizePrincipal`+`submit` NO llamados (spies) |
| AC-6 | `confirm-and-send.test.ts` | happy path; `submitSpy` recibe `expectedReceivePen` `.toEqual(Money.of(1480,"PEN"))` (== `quote.receive`) |
| AC-7 | `chain.test.ts` | env unset → `resolveChainId()===43114` & `resolveChain().id===43114`; `="43113"` → `avalancheFuji`; `="99"`/basura → 43114 |
| AC-8 | `wallet.test.ts` | provider mock con `eth_chainId` = otra red → `connect()` dispara `wallet_switchEthereumChain`; si el switch rechaza → throw `wrong_chain`; si matchea → connect OK |
| AC-9 | `wallet.test.ts` | provider devuelve address malformada/nula → `authorizePrincipal` throw `invalid_address`, sin `signMessage` |

**Carrera CAS (obligatorio, AC-3/AC-4):** test explícito con **2 confirm concurrentes** sobre el mismo id → 1 procede, 1 tira `ConcurrentModificationError` (simular con dos instancias rehidratadas de la misma versión + saves encadenados; NO hace falta paralelismo real — basta reproducir el read-stale + write).

**Infra de test:** `wallet.test.ts`/`chain.test.ts` en env `node` → stub `globalThis.window` (+ `window.ethereum` fake EIP-1193 para wallet), patrón `persistence.test.ts:34-41`; limpiar en `afterEach`. Para AC-7, `process.env.NEXT_PUBLIC_CHAIN_ID` se setea/borra por caso. Tipar el fake provider explícitamente (CD-6), sin `any`.

**Regresión obligatoria**: `npm run qa` (typecheck + vitest) verde en `use-cases.test.ts`, `flow-vm.test.ts`, `kyc-store.test.ts`, `persistence.test.ts` (WKH-181), y los 4 tests WKH-180 de `confirm-and-send.test.ts`.

---

## Waves

### Wave -1: Environment Gate (verificar antes de tocar código)
```bash
cd /home/ferdev/.openclaw/workspace/chaski-v2
npm install 2>/dev/null || echo "revisar package.json"
npm run typecheck   # baseline verde ANTES de empezar
npm run test        # baseline verde ANTES de empezar
node -e "const v=require('viem/chains'); console.log(!!v.avalanche, !!v.avalancheFuji)"  # true true
ls src/domain/remittance.ts src/application/use-cases/confirm-and-send.ts \
   src/infrastructure/persistence.ts src/infrastructure/wallet.ts \
   src/application/ports.ts src/test-support/fakes.ts .env.example
```
Si algo falla → PARAR y reportar al orquestador.

### W0 — Contratos & tipos (SERIAL, bloquea al resto)
- [ ] W0.1: `src/application/errors.ts` (NEW) → `ConcurrentModificationError` → Archivo #1
- [ ] W0.2: `src/infrastructure/chain.ts` (NEW) → `resolveChainId()` + `resolveChain()` → Archivo #2
- [ ] W0.3: `remittance.ts` → `version` en `RemittanceState` + `create()` `0` + `markSaved(v)` + `isQuoteStillValid(now)` (helper A5 va en W1) → Archivo #3
- [ ] W0.4: `ports.ts` → `PayoutSubmit.expectedReceivePen: Money` → Archivo #4

> Al agregar `expectedReceivePen` requerido a `PayoutSubmit`, el typecheck **rompe** en `confirm-and-send.ts` (call-site real) hasta W4. Esperado. `grep -rn 'PayoutSubmit\|\.submit(' src/` para confirmar que el único productor de `PayoutSubmit` es `confirm-and-send.ts` (los fakes/mocks lo CONSUMEN, no lo construyen).

### W1 — A5 validación de dominio (AC-1/AC-2)
- [ ] W1.1: `remittance.ts` → helper puro `assertReceiveConsistent` en `attachQuote()` (tras L184, antes de L185) → Archivo #3
- [ ] W1.2: `remittance.test.ts` → AC-1/AC-2 + boundary → Archivo #10
- Verificación: tests de dominio verdes.

### W2 — A6 CAS (AC-3/AC-4)
- [ ] W2.1: `persistence.ts` → `LocalRepo.save()` CAS + `normalizeState` default `version` → Archivo #5
- [ ] W2.2: `fakes.ts` → `InMemoryRepo.save()` CAS gemelo (import `ConcurrentModificationError`) → Archivo #6
- [ ] W2.3: `persistence.test.ts` → AC-3/AC-4 (conflicto + secuencial + legacy) → Archivo #11

### W3 — Wallet M1/M4 (AC-7/AC-8/AC-9) — paralelizable tras W0
- [ ] W3.1: `wallet.ts` → chain env-driven + switch suave + `isAddress` guard → Archivo #8
- [ ] W3.2: `chain.test.ts` (NEW) → AC-7 → Archivo #12
- [ ] W3.3: `wallet.test.ts` (NEW) → AC-8/AC-9 → Archivo #13

### W4 — M2 expiry + M3 payload + ScriptedClock (AC-5/AC-6)
- [ ] W4.1: `fakes.ts` → `ScriptedClock` → Archivo #6
- [ ] W4.2: `confirm-and-send.ts` → expiry re-check (§M2) + `expectedReceivePen: quote.receive` → Archivo #7
- [ ] W4.3: `confirm-and-send.test.ts` → AC-5/AC-6 (extiende suite WKH-180) → Archivo #14

### W5 — Docs
- [ ] W5.1: `.env.example` → `NEXT_PUBLIC_CHAIN_ID` (default 43114) + `NEXT_PUBLIC_REOWN_PROJECT_ID` → Archivo #9

### W6 — Verificación final
- [ ] W6.1: `grep -rn 'PayoutSubmit\|new ConfirmAndSend\|\.attachQuote(\|\.save(' src/` → todos los call-sites cubiertos (CD-7)
- [ ] W6.2: `npm run typecheck` (0 errores)
- [ ] W6.3: `npm run test` / `vitest run` (0 regresiones + nuevos verdes)
- [ ] W6.4: `next build` verde

---

## Done Definition (DoD)

- [ ] Los 9 ACs cubiertos con ≥1 test cada uno (evidencia archivo:línea para F4).
- [ ] Test de carrera CAS: 2 confirm concurrentes → 1 procede, 1 tira `ConcurrentModificationError`.
- [ ] A5 puro (sin I/O), en `attachQuote()` antes de `to("quoted")`; boundary test presente.
- [ ] CAS fail-loud (CD-4); firma de `save()` intacta; los otros 5 use-cases SIN editar.
- [ ] `NEXT_PUBLIC_CHAIN_ID` es la ÚNICA fuente del chainId para ambos adapters (CD-5); default 43114.
- [ ] Orden de guards CD-2 respetado (CAS → expiry → firma → submit).
- [ ] `expectedReceivePen: quote.receive` en `submit()`; `amountUsd` preservado.
- [ ] WKH-180 (`PayoutAuthorityGateway`, `app/api/payout/validate`) y WKH-181 (`kyc-store.ts`, `toPersistedIdentity`, `list()`) **intactos** (CD-10).
- [ ] `FallbackWallet`, `pickWallet`, `container.ts`, `fallback/gateways.ts` **sin tocar**.
- [ ] Demo llega a "Entregado" (settled) — regresión verde.
- [ ] `npm run typecheck` → 0 errores · `vitest run` → 0 regresiones · `next build` → verde.
- [ ] Solo archivos de la tabla tocados (branch `fix/182-money-path-robustez`).

---

## Coordinación de merge (WKH-183)

- **WKH-182 mergea ANTES que WKH-183** (y antes que WKH-168).
- **Único overlap con WKH-183**: `.env.example`. Vars **distintas** (182 agrega `NEXT_PUBLIC_CHAIN_ID`; 183 agrega `NEXT_PUBLIC_REOWN_PROJECT_ID` documentado + toca KYC_MODE). Agregá tu bloque de chain como **sección nueva** (ej. `# ── Chain (WKH-182) ──`) al final o junto a la sección de wallet, sin reordenar las secciones KYC/rate-limit existentes → diff acotado, auto-merge.
- `fallback/gateways.ts`: **NO lo tocamos** (M3 estructural) → overlap eliminado con WKH-183 en ese archivo.
- Si WKH-183 ya mergeó antes por algún motivo: re-verificá los anchors de `.env.example` (contenido, no número de línea) antes de editar.

---

## Escalation Rule

> **Si algo no está en este Story File, el Dev PARA y escala al Architect.** No inventar, no asumir, no improvisar.

Escalar si:
- Un anchor de línea no coincide y el CONTENIDO citado tampoco aparece (drift mayor post-merge).
- El typecheck full sigue rojo tras W0-W4 por un productor de `PayoutSubmit` NO listado (esperabas solo `confirm-and-send.ts`).
- El mock de viem en `wallet.test.ts` resulta frágil para AC-8: el core queda cubierto igual (AC-7 puro en `chain.test.ts` + AC-9 address) — documentá el gap y escalá antes de forzar un mock inestable.
- El cambio requiere tocar un archivo fuera de la tabla "Files to Modify/Create".

---

*Story File generado por NexusAgil — F2.5 (Architect). Contrato autocontenido: el Dev implementa SOLO desde este documento.*
</content>
</invoke>
