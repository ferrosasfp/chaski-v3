# SDD — [WKH-168] GATE Fase A / G3 — Principal-in real

- **Fase**: F2 (diseño). Gate previo: `HU_APPROVED` (2026-07-15).
- **Input**: `work-item.md` (9 ACs, 8 CDs, DT-1/2/3), `project-context.md`, `_INDEX.md`, done-report WKH-186.
- **Baseline verificado ejecutando**: `npx vitest run` → **PASS (287) FAIL (0)**, `main @ bda96ba`.
- **Gate de la HU**: `npm run qa` (= `npm run typecheck` + `npm run test`, `package.json:15`).

---

## 1. Context Map — qué leí y qué extraje

| Archivo (verificado) | Por qué | Patrón / evidencia extraída |
|---|---|---|
| `src/application/use-cases/confirm-and-send.ts` (133 L, post-WKH-202) | El bug vive acá | `:85-86` `const { tx } = await this.wallet.authorizePrincipal(quote); r.markPrincipalIn(tx, ...)`. Orden de guards actual: CAS → autoridad (`:65`) → expiry (`:78`) → firma (`:85`) → expiry (`:95`) → submit (`:103`). `failAndRefund` en `:32-46`. |
| `src/infrastructure/wallet.ts` (229 L) | Qué se firma hoy | `:78-91` (`InjectedWallet`) y `:193-206` (`WalletConnectWallet`): `signTypedData` EIP-712 → `return { tx: sig }`. **El `nonce` (`:75`, `:190`) se genera y se DESCARTA.** Domain: `{name:"USD Coin", version:"2", chainId, verifyingContract: usdc}`. `value = BigInt(quote.send.minor)`, `validBefore = quote.expiresAt` en segundos. |
| `src/application/ports.ts` (141 L) | Contratos | `WalletPort.authorizePrincipal(quote): Promise<{tx:string}>` (`:113`). `PayoutSubmit.address: string` NO-opcional (`:71`, WKH-202). `RefundGateway` (`:92-94`). |
| `src/domain/remittance.ts` (280 L) | FSM | `TRANSITIONS` (`:85-97`): `confirmed:["principal_in","payout_failed"]`, `principal_in:["payout_submitted","payout_failed"]`. `markPrincipalIn(tx, now)` (`:236-238`). **Re-confirmar desde `confirmed` es `invalid_transition`** → protege re-entrada. |
| `src/domain/money.ts` (67 L) | Unidades | `DECIMALS = {USDC: 6, PEN: 2}` (`:6`) → `Money.minor` de USDC = **micro-USDC = base units EIP-3009**. `wallet.ts:86` es correcto. |
| `src/composition/container.ts` (98 L) | Guard sagrado | `:59-67` guard fail-loud (CD-2/AC-8). `:85` construcción de `ConfirmAndSend`. |
| `src/infrastructure/chain.ts` (39 L) | Env truth | `resolveChainId()` → 43113 | 43114 (default) (`:9-13`); `resolveUsdcAddress()` (`:24-28`) y `resolveReceiverAddress()` (`:35-39`) fail-loud con `isAddress`. |
| `app/api/a2a/payout/submit/route.ts` (115 L) | Exemplar + el gate real | `:16-17` **el propio código nombra a WKH-168**: *"Residual (NO lo cierra esta HU): ... nadie verifica que el sender pagó el principal en USDC (WKH-168)"*. Guard-order fail-closed `:46-96`. `:54-55` parseo `unknown` + `isRecord`. |
| `src/infrastructure/kyc-auth.ts` (33 L) | Exemplar HMAC | `createHmac("sha256", secret).update(x).digest("base64url")` + `timingSafeEqual` con check de longitud primero (`:31`). Secreto leído **dentro** de la función (`:12-17`) para `vi.stubEnv`. |
| `src/infrastructure/rate-limit.ts` | Upstash cableado | `import { Redis } from "@upstash/redis"` — dep `^1.38.0` en `package.json:20`. Hoy solo rate-limit. |
| `src/infrastructure/refund/ledger-refund-gateway.ts` (11 L) | Refund sintético | `return { refundTx: \`refund-ledger-${Date.now().toString(36)}\` }` — NO revierte nada. |
| `src/test-support/fakes.ts` / `test-container.ts` | Fakes | `FakeWallet.authorizePrincipal(_quote)` (`fakes.ts:250`) → `{tx:"0xprincipal"}`. `TestContainerOverrides` como patrón de inyección. |
| **facilitator** `src/chains/base-adapter.ts` (825 L) | Mecánica real | `:572-653` re-verify; `:750-822` `runExclusive` → simulate → `writeContract` (`:764`) → `waitForTransactionReceipt` (`:779`) → `receipt.status === 'reverted'` (`:800`) → success. |
| **facilitator** `src/chains/avalanche.ts` (~160 L) | Cableado por cadena | Thin wrapper: `avalancheFujiAdapter` (43113, `AVALANCHE_FUJI_RPC_URL`) / `avalancheMainnetAdapter` (43114, `AVALANCHE_MAINNET_ENABLED=true` + RPC). USDC canónico **hardcodeado** (Fuji `0x5425890298aed601595a70AB815c96711a31Bc65`, mainnet `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`). |
| **facilitator** `src/routes/settle.ts` | Endpoint | `preHandler: requireFacilitatorKey`; payTo allowlist → 403; idempotencia + in-flight lock (409 CONFLICT); cap diario (429/503); respuesta 200 de 7 campos. |
| **facilitator** `src/core/schemas.ts` (114 L) | Contrato exacto | `SettleRequestSchema = VerifyRequestSchema` (`:112`), `.strict()`. |
| **facilitator** `src/core/settle.ts` | Routing | `EIP155_RE = /^eip155:([1-9]\d*)$/` → `network` = `eip155:43113`. |
| **facilitator** `src/core/idempotency.ts:325-329` | Idempotencia | `buildSettleIdempotencyKey = sha256(canonicalStringify(body))` → **body idéntico ⇒ misma key ⇒ respuesta cacheada sin 2º adapter call**. |
| **facilitator** `src/middleware/auth.ts:102-106` | Auth | `Authorization: Bearer <FACILITATOR_API_KEY>`. ⚠️ `:100` `if (configured.length === 0) return;` → sin keys configuradas la auth se **saltea**. |
| `doc/sdd/015-.../auto-blindaje.md`, `009-.../auto-blindaje.md` | Errores recurrentes | Ver §2.5 → CD-13/CD-14/CD-15. |

### 1.1 Corrección al work-item (DT-1) — verificada por mí

El work-item (`:121-123`) dice que el path live es `src/chains/avalanche.ts`. **Matiz**: `settle.ts` (methods/eip3009) **sí** es dead code, pero la **mecánica** vive en `src/chains/base-adapter.ts` (`BaseEip3009Adapter`); `avalanche.ts` es un *thin wrapper* que lee env, elige la chain de viem y el token, y llama `super()` (su propio header lo dice: *"the full EIP-3009 flow now lives in `BaseEip3009Adapter`. This file is a thin wrapper"*). Sin efecto sobre el veredicto de DT-1 (reusar), sí sobre **qué archivo citar** como evidencia.

---

## 2. Hallazgos de grounding — los 4 que cambian el diseño

### H1 (CRÍTICO) — La respuesta del facilitador es un ECO de nuestro input, no una lectura de la cadena

`base-adapter.ts:811` lo dice literal:

```
// 7. Success (AC-7, AC-9). Fields from input params, NOT re-read from chain.
return { ok:true, settled:true, transactionHash: hash, blockNumber: Number(receipt.blockNumber),
         amount: params.accepted.amount,   // :817  ← NUESTRO input
         from: authorization.from,          // :818  ← NUESTRO input
         to: authorization.to,              // :819  ← NUESTRO input
         asset: token.address };            // :820
```

**Consecuencia**: el plan de tests del work-item (AC-2: *"fake gateway devuelve `{ok:true, to:"0xOTRO", amount:"400000000"}` (mismatch)"*) describe algo que **el facilitador real nunca puede devolver**: `to` siempre será el `authorization.to` que nosotros mandamos. Chequear `response.to === resolveReceiverAddress()` es **verificar nuestro propio input** — una tautología que da falsa sensación de verificación (R2 exactamente). Es el mismo olor que el ecosistema ya cazó dos veces (fail-open silencioso).

**Lo que SÍ prueba la respuesta del facilitador**: que hubo `simulateContract` → `writeContract` → `waitForTransactionReceipt` → `receipt.status !== 'reverted'` (`base-adapter.ts:750-809`) sobre una `authorization` que él cruzó contra `accepted` (`:586` asset, `:609` value, `:621` payTo, `:632`/`:644` validez temporal). Es evidencia **atestiguada por el facilitador**, no verificada por nosotros.

→ Deriva **DT-4** (binding server-side pre-broadcast) y **DT-5** (verificación on-chain independiente).

### H2 (ALTO) — El facilitador acepta sobre-pago y sub-reporta el monto real

`base-adapter.ts:609`: `if (BigInt(authorization.value) < acceptedAmount)` → `INVALID_AMOUNT`. Es un **`>=`**, no una igualdad: `value > accepted.amount` **se settlea**. Y lo que se transfiere on-chain es `authorization.value` (`:471-472`), mientras la respuesta reporta `accepted.amount` (`:817`). Un settle honesto puede mover **más** de lo que reporta. → **DT-4**: pinneamos la igualdad nosotros (`value === quote.send.minor`), stricter que el facilitador.

### H3 (CRÍTICO — decide el alcance real del gate) — `ConfirmAndSend` corre en el CLIENTE: los 9 ACs no cierran G3

`ConfirmAndSend.execute()` se invoca desde `presentation/flow.tsx` (client-side; DT-2 del work-item lo confirma). **Todo chequeo que viva ahí es opcional para el atacante: simplemente no lo ejecuta.**

El ataque que motiva la HU es: *"un atacante con su propio KYC aprobado y su propia address pasa todos los otros gates y pide un payout con monto arbitrario"* — es decir, **hace `POST /api/a2a/payout/submit` directo**, sin pasar por el browser. Los 9 ACs del work-item están todos formulados alrededor de `ConfirmAndSend`/`wallet.ts` → hacen **honesto el camino honesto**, pero **no bloquean el ataque**.

Evidencia independiente de que esto es lo que se espera de WKH-168 — el propio código lo dejó escrito, `app/api/a2a/payout/submit/route.ts:16-17`:

> *"Residual (NO lo cierra esta HU): kycPayoutAllowed sigue siendo un booleano del caller (WKH-203) y **nadie verifica que el sender pagó el principal en USDC (WKH-168)**."*

→ Deriva **DT-7** (atestación server-side + enforcement en `/submit`) y los **AC-10/AC-11 propuestos** (§4). **Es una ampliación de alcance sobre la letra de los ACs → DECISIÓN REQUERIDA en el gate (§10).**

### H4 (MEDIO) — El servidor NO puede validar el monto contra el quote (no tiene el quote)

El estado vive en `localStorage` (WKH-207). No hay lookup de quote por id: `A2aQuoteGateway.requestQuote` (`gateways.ts:97-111`) es un POST que **crea** un quote. Entonces `/api/settle/principal` **no puede** verificar por sí mismo que `value === quote.send.minor` — el cliente es la única fuente del quote.

**Resolución (DT-7)**: no hace falta. Lo que el servidor **sí** puede atar sin estado es lo que importa para el dinero:
- `payTo`, `asset`, `network` → **env server-side** (nunca del body).
- `value` → se **atestigua** (lo que realmente se movió, leído de la cadena) y el `/submit` ata el **payout** a ese valor atestiguado. Así el atacante no puede pedir "monto arbitrario": el monto del payout queda acotado por el USDC que efectivamente entró.
- `value === quote.send.minor` (AC-2) se chequea **client-side** — es corrección del camino honesto, **no** frontera de seguridad. Se documenta como tal.

### 2.5 Auto-Blindaje histórico aplicado (leído: WKH-202, WKH-186)

| Patrón recurrente (≥2 HUs) | Se convierte en |
|---|---|
| Contar artefactos **leyendo** en vez de **ejecutando** (WKH-198: 4 vs 5; WKH-201/202: 8 vs 7) | **CD-13**. Ya cazado 2 veces en esta HU: (a) el work-item (plan de tests, AC-8) dice *"los 6 tests existentes de `container.test.ts`"* — **son 8**; (b) ver §2.6: el `grep -c` que el propio auto-blindaje recomienda **es ambiguo** y casi me hace propagar un número mal. |

### 2.6 Refinamiento del CD-13 (hallazgo nuevo de esta HU) — `grep -c` NO es autoridad

El auto-blindaje de WKH-202 prescribe verificar conteos con `grep -c "^\s*it("`. **Ese comando es ambiguo cuando hay `it.each`**: cuenta el bloque como **1**, pero el runner ejecuta **N** casos. Verificado ejecutando:

| Archivo | `grep -cE '^\s*it(\.each)?\('` | `vitest run` (autoridad) | Coinciden |
|---|---|---|---|
| `src/composition/container.test.ts` | 8 | **8** | sí |
| `src/application/use-cases/confirm-and-send.test.ts` | 14 | **14** | sí |
| `app/api/a2a/payout/submit/route.test.ts` | 16 | **19** | **NO** (el `it.each` de 4 casos de WKH-202/BLQ-BAJO-1 cuenta 1 en grep) |

Los "19" del auto-blindaje de WKH-202 y estos "16" son **ambos correctos, en unidades distintas**. → **CD-13 se endurece**: la autoridad de cualquier conteo de tests es **el output del runner** (`npx vitest run <archivo>` → `PASS (N)`), nunca `grep`. Todo número de tests en este SDD viene del runner.
| Env leído en top-level rompe `vi.stubEnv` (WKH-186) | **CD-14** |
| `req.json()` → `unknown`; `.catch(() => ({}))` no cubre `null` (WKH-202 BLQ-BAJO-1) | **CD-15** |
| Fail-open silencioso (`NaN` WKH-198, `String()`/`z.string().min(1)` sin trim) | **CD-7** heredado + enumeración exhaustiva de ramas (§5) |

---

## 3. Decisiones técnicas

### DT-1 — Broadcast: REUSAR `wasiai-facilitator` `POST /settle`. **RATIFICADO.**

No pude refutar el veredicto del work-item; lo confirmé en disco. La mecánica completa (simulate → write → wait → status → revert-check, con `runExclusive` por cadena) ya existe y está auditada en `base-adapter.ts:750-822`; `avalanche.ts` cubre **43113/43114**, exactamente las 2 cadenas de `resolveChainId()`. Escribir un segundo relayer en el money-path sería duplicar superficie de ataque (CD-5). **chaski-v2 NO hace ningún `writeContract`/`sendTransaction`/`sendRawTransaction`.**

**Contrato exacto** (`SettleRequestSchema` = `VerifyRequestSchema`, `.strict()` — campo extra ⇒ 400):

```jsonc
POST {FACILITATOR_BASE_URL}/settle
Authorization: Bearer {FACILITATOR_API_KEY}          // auth.ts:102-106
content-type: application/json
{
  "x402Version": 2,                                   // z.literal(2)
  "resource": { "url": "<https url>" },               // z.string().url()
  "accepted": {
    "scheme": "exact",
    "network": "eip155:43113",                        // `eip155:${resolveChainId()}`
    "amount": "<uint256 canónico>",                   // String(quote.send.minor) — sin ceros a la izq.
    "asset": "0x…",                                   // resolveUsdcAddress()  (SERVER env)
    "payTo": "0x…",                                   // resolveReceiverAddress() (SERVER env)
    "maxTimeoutSeconds": 60,                          // int positivo
    "extra": { "assetTransferMethod": "eip3009", "name": "USD Coin", "version": "2" }
  },
  "payload": {
    "signature": "0x…",                               // /^0x[0-9a-fA-F]+$/
    "authorization": { "from","to","value","validAfter","validBefore","nonce" }  // uint256 como STRING; nonce bytes32
  }
}
```

Respuesta 200: `{settled, transactionHash, blockNumber, amount, from, to, asset}`. Errores: 400 `INVALID_PAYLOAD`/`INVALID_AMOUNT`/`INVALID_RECEIVER`/`NETWORK_MISMATCH`/`EXPIRED_AUTHORIZATION`, 401 `UNAUTHORIZED`, 403 `FORBIDDEN` (payTo allowlist), 409 `CONFLICT` (in-flight), 429 `RATE_LIMITED` (cap diario), 500 `TRANSACTION_FAILED`, 503 `SERVICE_UNAVAILABLE`/`CHAIN_UNAVAILABLE`/`OPERATOR_FUNDING_LOW`.

**Conversión de tipos (CD-16)**: `wallet.ts` firma con `BigInt`/`0x…`; el schema exige **strings decimales canónicos** (`Uint256StringSchema` rechaza ceros a la izquierda, negativos, notación científica). La serialización `bigint → string` se hace en `wallet.ts` (donde se firma), NUNCA con `JSON.stringify` sobre bigint (tira `TypeError`).

### DT-2 — Persistencia de la remesa: **NO se toca** (CD-8 intacto)

`RemittanceRepository` sigue en `localStorage`. No se decide DT-2 del work-item. **WKH-207** queda como está.

### DT-3 — Estado server-side: **necesito el mínimo — Opción (A) Upstash, NO la (B)**

**Declarado explícitamente** (como pidió el orquestador). El diseño necesita **una** cosa server-side, y no es el estado de la remesa:

- **Qué**: un flag de **single-use** por atestación → `SET NX settle:att:<txHash>` en Upstash (`@upstash/redis` ya es dependencia, `package.json:20`; ya cableado en `rate-limit.ts`).
- **Por qué**: sin él, la atestación (HMAC stateless) es **replayable** → una entrada de principal ⇒ N payouts (§5, rama A8).
- **Por qué NO es CD-8**: no persiste `RemittanceState`, no hay reconciliación, no hay queries por estado/fecha. Es replay-protection efímera — el mismo uso que WKH-179 ya le da a Upstash. La orfandad (R4) sigue **sin cerrar** (AC-9).
- **Opción (B) — Supabase de `wasiai-a2a`: NO elegida** (choca con el guardrail "standalone"; requeriría confirmación humana). No hace falta: (A) alcanza.
- **Fail-closed**: Upstash no configurado / caído → `/api/a2a/payout/submit` responde **503**, NUNCA forwardea (CD-12). Precedente: `rate-limit.ts` ya es fail-closed (`unavailable`).

### DT-4 — Binding server-side PRE-broadcast (deriva de H1/H2)

`/api/settle/principal` construye `accepted` **desde env del servidor** y **jamás** desde el body:

| Campo | Fuente | Nunca |
|---|---|---|
| `payTo` | `resolveReceiverAddress()` | ~~body~~ |
| `asset` | `resolveUsdcAddress()` | ~~body~~ |
| `network` | `eip155:${resolveChainId()}` | ~~body~~ |
| `amount` | `String(authorization.value)` tras pinnear igualdad (abajo) | — |

Y **pinnea, stricter que el facilitador** (H2), antes de forwardear:
- `authorization.to === resolveReceiverAddress()` (igualdad, case-insensitive vía `isAddressEqual`)
- `authorization.value === accepted.amount` (**igualdad exacta**, no `>=`)
- `authorization.from === body.address` (el que firma es el caller declarado)

`NEXT_PUBLIC_*` leído en el servidor **sí es server-truth**: lo setea el operador en el entorno; el prefijo solo significa "además se inlinea en el bundle", no "el cliente lo controla en runtime".

### DT-5 — Verificación on-chain INDEPENDIENTE (read-only) — cumple AC-2 literal

Tras el 200 del facilitador, `/api/settle/principal` **lee la cadena por su cuenta** con un `publicClient` de viem (`AVALANCHE_RPC_URL`, server-only):

1. `getTransactionReceipt({hash})` → `status === "success"` (si no: fail-closed).
2. Buscar el log `Transfer(address,address,uint256)` **emitido por `resolveUsdcAddress()`** dentro de ese receipt.
3. Assert: `from === authorization.from`, `to === resolveReceiverAddress()`, `value === String(quote.send.minor)` (el `value` pinneado).

**Por qué no viola CD-5**: CD-5 prohíbe *"implementar un relayer/broadcast on-chain propio"*. Esto es **read-only** — no hay wallet, no hay clave privada, no hay `writeContract`/`sendTransaction`. El broadcast lo sigue haciendo 100% el facilitador (DT-1). Es la diferencia entre *"el facilitador me dijo"* y *"lo verifiqué"* — exactamente lo que pide R2 (*"no confiar ciegamente en `{settled:true}`"*) y la letra de AC-2 (*"el `to` **on-chain**"*), que **no es satisfacible** con el eco (H1).

**Descopable** (si el humano quiere cortar): sin DT-5, AC-2 baja a "atestiguado por el facilitador" y R2 queda parcialmente abierto (dependemos de que el facilitador sea honesto y no tenga bugs). Costo de mantenerlo: 1 env + ~50 líneas read-only + fakes. **Recomiendo mantenerlo**: es el único punto del diseño donde chaski-v2 *verifica* en vez de *confiar*, y esta HU se llama "que `principal_in` signifique que el USDC llegó".

### DT-6 — Idempotencia: nonce EIP-3009 **determinístico** (defensa en 3 capas)

Hoy `wallet.ts:75`/`:190` hace `toHex(crypto.getRandomValues(new Uint8Array(32)))` → **cada firma es una autorización nueva**. Con random: si el settle devuelve un error ambiguo (timeout) y el usuario reintenta, se firma un nonce nuevo → **el usuario paga dos veces**.

**Decisión**: `nonce = keccak256(toBytes(\`${remittanceId}:${quoteId}\`))` (bytes32, determinístico). Requiere pasar `remittanceId` a `authorizePrincipal` (§6, W0).

Capas resultantes:
1. **On-chain (dura)**: el contrato USDC marca `authorizationState[from][nonce]` → un 2º settle de la MISMA autorización **revierte**. Con nonce determinístico, *cualquier* reintento de la misma remesa+quote colapsa a la misma autorización ⇒ **doble-pago imposible a nivel contrato**.
2. **Facilitador**: `buildSettleIdempotencyKey = sha256(canonicalStringify(body))` (`idempotency.ts:325-329`) → body idéntico ⇒ respuesta cacheada, sin 2º adapter call; concurrente ⇒ 409 `CONFLICT`.
3. **FSM**: re-`execute()` desde `confirmed` → `r.confirm()` → `invalid_transition` (`remittance.ts:91,200-202`); desde `principal_in` idem. Ya existente, verificado.

El nonce no es secreto (EIP-3009 solo exige unicidad por `(from, nonce)`); sin la firma es inútil para un tercero. `remittanceId` es único (`CryptoIds`).

### DT-7 — El enforcement real de G3: atestación HMAC + `/api/a2a/payout/submit` (deriva de H3/H4)

**Sin esto, esta HU NO cierra G3** (solo hace honesto el camino honesto).

1. `/api/settle/principal`, tras DT-5, **emite una atestación**: HMAC-SHA256 (patrón `kyc-auth.ts:20-33`, `SETTLE_ATTESTATION_SECRET`) sobre un payload canónico:
   `{ txHash, chainId, valueMinor, from, to, quoteId, exp }` → `base64url(payload) + "." + base64url(hmac)`.
2. El cliente la lleva en el `PayoutSubmit` y `A2aPayoutGateway.submit` la manda a `/api/a2a/payout/submit`.
3. **`/api/a2a/payout/submit` la exige** (nuevo guard, ANTES del forward y DESPUÉS de la autoridad WKH-202) y verifica:
   - HMAC válido (timing-safe, longitud primero) — si no: **403**
   - `exp` no vencido — si no: **403**
   - `Money.of(body.amountUsd,"USDC").minor === att.valueMinor` → **ata el payout al USDC realmente recibido** (mata "monto arbitrario") — si no: **403**
   - `att.from` ≡ `body.address` (case-insensitive) → **ata el pagador on-chain al address ya KYC-validado por WKH-202** — si no: **403**
   - **single-use**: `SET NX settle:att:<txHash>` (DT-3) — ya usada: **409**; Upstash caído/no configurado: **503**
4. **Fail-closed por default**: si `SETTLE_ATTESTATION_SECRET` **no** está seteado, la exigencia **no aplica** (comportamiento pre-HU byte-idéntico → AC-5/CD-1: la HU construye, no enciende) — salvo en Vercel, donde replica el patrón `simulated_dev` de `submit/route.ts:74-76`: con `VERCEL_ENV !== ""` y sin secreto ⇒ **503**, nunca fail-open en un entorno desplegado.

**Trade-off del single-use (documentado, no resuelto)**: se consume **ANTES** del forward. Si el forward falla (502/timeout), la atestación queda quemada → la remesa queda varada con el principal **realmente adentro** → requiere la reconciliación de **WKH-207**. Es deliberado: en el money-path preferimos **varado** antes que **pagado dos veces**. La alternativa (in-flight lock con release en error, como `setInflightSettleLock`/`releaseInflightSettleLock` del facilitador) reabre la ventana de doble-payout cuando la respuesta del agente se pierde.

### DT-8 — Refund real: **NO entra en esta HU**. Solo la marca de AC-6.

**Justificación**: revertir un `transferWithAuthorization` ya settleado es **imposible** por diseño — el USDC ya es del receiver; devolverlo es una **transferencia inversa** que requiere la autoridad del *receiver* (su clave privada), no del sender. Eso significa: (a) una wallet operadora con fondos y firma server-side, (b) un relayer de salida, (c) política de quién autoriza. Es un money-path **nuevo y de sentido contrario**, con su propio modelo de amenazas — no cabe en la HU que apenas está haciendo que el principal exista. El work-item ya lo declara Scope OUT (`:104-106`).

**Lo que sí entra (AC-6)**: `failAndRefund` recibe un flag y, cuando el principal está realmente adentro (`principalTx != null` **y** modo real), marca un `reason` distinguible y estable: **`principal_settled_refund_manual`** (enum, sin PII — CD-5 de WKH-186). Sin esto, `LedgerRefundGateway` seguiría devolviendo `refund-ledger-<ts>` sintético (`ledger-refund-gateway.ts:9`) como si hubiera revertido algo — mentira nueva y peligrosa ahora que hay plata real (R5).

### DT-9 — Shape del port (resuelve DT-3 del work-item)

```ts
// ports.ts — port NUEVO, separado de WalletPort
export interface Eip3009Authorization {
  from: string; to: string; value: string;            // uint256 decimal canónico (string)
  validAfter: string; validBefore: string; nonce: string; // nonce: 0x + 64 hex
}
export interface PrincipalSettlementGateway {
  settle(input: {
    authorization: Eip3009Authorization;
    signature: string;
    address: string;
    quoteId: string;
    expectedValueMinor: number;   // quote.send.minor — AC-2 (camino honesto, §H4)
  }): Promise<
    | { ok: true; txHash: string; valueMinor: number; to: string; from: string; attestation: string }
    | { ok: false; reason: SettlementFailureReason }
  >;
}
export type SettlementFailureReason =
  | "settlement_unavailable" | "settlement_rejected" | "settlement_amount_mismatch"
  | "settlement_receiver_mismatch" | "settlement_reverted" | "settlement_unverified";
```

`WalletPort.authorizePrincipal` cambia a:
```ts
authorizePrincipal(quote: Quote, remittanceId: string): Promise<{
  tx: string;                                  // demo: firma simbólica (AC-5 byte-idéntico)
  eip3009?: { authorization: Eip3009Authorization; signature: string };  // SOLO en modo real
}>;
```
`eip3009` opcional ⇒ `FallbackWallet` (`wallet.ts:114-116`) y `FakeWallet` (`fakes.ts:250`) siguen devolviendo `{tx}` sin tocar sus asserts (AC-5). El gateway **no se instancia** cuando `NEXT_PUBLIC_EIP3009_ENABLED !== "true"` (`container.ts`), preservando AC-5 por construcción.

---

## 4. ACs — heredados + propuestos

Heredo **AC-1 … AC-9** del work-item, con dos **correcciones de grounding**:

- **AC-2 (reinterpretado, H1)**: "verificar el `to`/`value` on-chain" se cumple con **DT-5** (lectura independiente del receipt + log `Transfer`), **no** chequeando la respuesta del facilitador (que es un eco de nuestro input — `base-adapter.ts:811`). El plan de tests del work-item para AC-2 (fake devolviendo `to:"0xOTRO"`) describe un caso que el facilitador real no puede producir; se re-formula en §7 sobre el **verificador on-chain**.
- **AC-8 (número corregido, CD-13)**: son **8** tests en `container.test.ts`, no 6. Verificable: `grep -cE '^\s*it(\.each)?\(' src/composition/container.test.ts` → `8`.

**Propuestos (nuevos, requieren aprobación en el gate — §10):**

- **AC-10**: WHEN `SETTLE_ATTESTATION_SECRET` está configurado, `POST /api/a2a/payout/submit` SHALL rechazar (403) toda request sin una atestación de settlement válida (HMAC vigente, `valueMinor` == `amountUsd` del body, `from` ≡ `address` del body), ANTES de forwardear al agente — cerrando el residual que el propio `route.ts:16-17` nombra.
- **AC-11**: WHEN una atestación válida ya fue consumida, `POST /api/a2a/payout/submit` SHALL rechazarla (409) sin forwardear; IF Upstash no está disponible o `UPSTASH_*` no está configurado, THEN SHALL responder 503 (fail-closed), NUNCA forwardear.

---

## 5. Enumeración exhaustiva de ramas (todas fail-closed)

### S — `POST /api/settle/principal` (nueva ruta server-only)

Orden **obligatorio** (fail-closed, espeja `submit/route.ts:46-96`):

| # | Condición | Resultado | Nota |
|---|---|---|---|
| S1 | `NEXT_PUBLIC_EIP3009_ENABLED !== "true"` | **501** `settle_not_enabled` | PRIMER guard. CD-1: la HU construye, no enciende. |
| S2 | `!FACILITATOR_BASE_URL` o `!FACILITATOR_API_KEY` | **501** `settle_not_configured` | Sin backend no hay nada que settlear. Ningún fetch. |
| S3 | `resolveReceiverAddress()` / `resolveUsdcAddress()` throw | **500** `settle_misconfigured` (capturado, nunca crudo) | Inalcanzable si el guard de `container.ts:59-67` corrió; defensivo (la ruta es un proceso server distinto). |
| S4 | body no-record (`null`, `[]`, `123`, `"s"`) | **400** `settle_invalid_request` | **CD-15**: `req.json().catch(() => null)` + `isRecord`. Ningún fetch. |
| S5 | `authorization` ausente/no-record, o falta cualquiera de los 6 campos, o no son `string` | **400** `settle_invalid_request` | Sin coerción: `typeof x === "string"` (nunca `String(x)` — WKH-204). |
| S6 | `signature` no matchea `/^0x[0-9a-fA-F]+$/` | **400** | |
| S7 | `nonce` no matchea `/^0x[0-9a-fA-F]{64}$/` | **400** | bytes32 exacto. |
| S8 | `value`/`validAfter`/`validBefore` no son uint256 decimal canónico (`/^(0|[1-9]\d*)$/`) | **400** | Rechaza `"01"`, `"-1"`, `"1e2"`, `""`, `" 1 "`. **Sin trim** (`z.string().min(1)` no trimea — lección WKH-204). |
| S9 | `address` (caller) vacío/no-string/`!isAddress` | **400** | |
| S10 | `expectedValueMinor` no es entero ≥ 1 | **400** | `Number.isInteger` (NO `Number()` suelto — lección `NaN` WKH-198). |
| S11 | `authorization.value !== String(expectedValueMinor)` | **400** `settle_amount_mismatch` | **DT-4**: igualdad exacta (stricter que el `>=` del facilitador, H2). |
| S12 | `!isAddressEqual(authorization.to, resolveReceiverAddress())` | **400** `settle_receiver_mismatch` | **DT-4/CD-7**. |
| S13 | `!isAddressEqual(authorization.from, body.address)` | **400** `settle_sender_mismatch` | Ata la firma al caller declarado. |
| S14 | Facilitador → 401/403 | **502** `settle_rejected` | Config del operador (allowlist/key). Nunca ecoa el motivo (no-oracle, CD-12 de WKH-202). |
| S15 | Facilitador → 400 (`INVALID_*`/`NETWORK_MISMATCH`/`EXPIRED_AUTHORIZATION`) | **502** `settle_rejected` | |
| S16 | Facilitador → 409 `CONFLICT` (in-flight) | **409** `settle_in_flight` | El cliente NO debe re-firmar (DT-6). |
| S17 | Facilitador → 429 / 503 (`RATE_LIMITED`, `CHAIN_UNAVAILABLE`, `OPERATOR_FUNDING_LOW`, `SERVICE_UNAVAILABLE`) | **503** `settle_unavailable` | AC-3. |
| S18 | Facilitador → 500 `TRANSACTION_FAILED` (incluye revert on-chain, `base-adapter.ts:800`) | **502** `settle_reverted` | AC-3. |
| S19 | Timeout / DNS / fetch throw | **504** `settle_unavailable` | `AbortSignal.timeout(45_000)` — el receipt puede tardar (el facilitador espera `RECEIPT_TIMEOUT_MS`). **Ambiguo**: la tx pudo minarse. Fail-closed → `payout_failed`; el reintento con el MISMO nonce (DT-6) es seguro. |
| S20 | 200 pero JSON no parsea / `settled !== true` / `transactionHash` no `/^0x[0-9a-fA-F]{64}$/` | **502** `settle_unverified` | **Nunca** asumir éxito por HTTP 200. |
| S21 | 200 y shape OK | → **rama V** | El 200 **no** es suficiente (H1). |

### V — Verificación on-chain independiente (DT-5)

| # | Condición | Resultado |
|---|---|---|
| V1 | `!AVALANCHE_RPC_URL` | **503** `settle_unverified` — **fail-closed**: sin poder verificar, NO se atestigua. |
| V2 | `getTransactionReceipt` throw/timeout | **503** `settle_unverified` |
| V3 | `receipt.status !== "success"` | **502** `settle_reverted` |
| V4 | Ningún log `Transfer` emitido por `resolveUsdcAddress()` en el receipt | **502** `settle_unverified` |
| V5 | ≥2 logs `Transfer` de USDC hacia `resolveReceiverAddress()` | **502** `settle_unverified` — ambigüedad ⇒ bloquear (no elegir "el primero"). |
| V6 | `log.args.to !== resolveReceiverAddress()` | **502** `settle_receiver_mismatch` — **AC-2** |
| V7 | `log.args.from !== authorization.from` | **502** `settle_sender_mismatch` |
| V8 | `log.args.value !== BigInt(authorization.value)` | **502** `settle_amount_mismatch` — **AC-2** (cierra H2: lo que se movió de verdad) |
| V9 | Todo OK | **200** `{ txHash, valueMinor, from, to, attestation }` — recién acá se emite la atestación (DT-7) |

### A — Atestación en `POST /api/a2a/payout/submit` (DT-7)

Se inserta **después** del guard de autoridad WKH-202 (`route.ts:78-96`) y **antes** del forward (`:98`). Los guards 1-6 existentes quedan **byte-idénticos** (CD-11).

| # | Condición | Resultado |
|---|---|---|
| A1 | `!SETTLE_ATTESTATION_SECRET` **y** `VERCEL_ENV === ""` | **skip** — comportamiento pre-HU byte-idéntico (AC-5/CD-1; demo local intacto). |
| A2 | `!SETTLE_ATTESTATION_SECRET` **y** `VERCEL_ENV !== ""` | **503** `payout_settlement_unavailable` — nunca fail-open en un deploy (patrón `simulated_dev`, `route.ts:74-76`). |
| A3 | `settlementAttestation` ausente/no-string/vacío | **403** `payout_principal_unverified` |
| A4 | Formato inválido (no `<b64>.<b64>`) o HMAC no matchea (timing-safe, longitud primero — `kyc-auth.ts:31`) | **403** `payout_principal_unverified` |
| A5 | `exp` ausente/no-number/vencido (`Number.isFinite` + `<= now`) | **403** `payout_principal_unverified` |
| A6 | `att.valueMinor !== Money.of(body.amountUsd,"USDC").minor` | **403** `payout_principal_unverified` — **mata "monto arbitrario"** |
| A7 | `att.from.toLowerCase() !== body.address.toLowerCase()` | **403** `payout_principal_unverified` — ata el pagador on-chain al address KYC-validado (WKH-202) |
| A8 | `SET NX settle:att:<txHash>` → ya existía | **409** `payout_already_settled` — single-use (anti-replay) |
| A9 | Upstash no configurado / throw | **503** `payout_settlement_unavailable` — **fail-closed**, NUNCA forwardea |
| A10 | Todo OK | → forward (bloque `:98-114` intacto) |

**CD-12 (no-oracle)**: A3-A7 devuelven **el mismo** `error` — el endpoint no debe ser un oráculo de *por qué* falló.

### C — `ConfirmAndSend` (rama real; `NEXT_PUBLIC_EIP3009_ENABLED !== "true"` ⇒ ninguna corre — AC-5)

Se inserta entre `:85` (firma) y `:86` (`markPrincipalIn`). El re-check de expiry `3.5` (`:94-98`) queda **después** del settle: si el quote venció durante el settle, el principal **ya está adentro** → `principal_in → payout_failed` (transición válida, `remittance.ts:92`) → refund con la marca de DT-8.

| # | Condición | Resultado |
|---|---|---|
| C1 | Modo real y `res.eip3009 === undefined` | `payout_failed("settlement_unverified")`, **NO** `markPrincipalIn` — invariante rota, fail-loud. |
| C2 | `settle()` → `{ok:false, reason}` (cualquiera) | `failAndRefund(reason)`, `principalTx` sigue `null` (**AC-3**) |
| C3 | `settle()` **throw** (red/bug) | `failAndRefund("settlement_unavailable")` — **CD-7**: envuelto en try/catch, ninguna excepción escapa. |
| C4 | `{ok:true}` pero `valueMinor !== quote.send.minor` | `failAndRefund("settlement_amount_mismatch")`, **NO** `markPrincipalIn` (**AC-2**, camino honesto) |
| C5 | `{ok:true}` pero `!isAddressEqual(to, resolveReceiverAddress())` | `failAndRefund("settlement_receiver_mismatch")`, **NO** `markPrincipalIn` (**AC-2**) |
| C6 | `{ok:true}` + monto + receiver OK | `markPrincipalIn(txHash)` — **AC-4**: el **hash verificado**, nunca la firma. Se guarda la atestación en memoria para el submit. |
| C7 | Tras `principal_in`, quote vencido (`:95`) | `failAndRefund("quote_expired_before_submit")` + marca DT-8 (**principal real adentro**) |
| C8 | Tras `principal_in`, el payout falla | `failAndRefund(reason)` + marca DT-8 (**AC-6**) |

---

## 6. Waves

**W0 — Contratos y tipos (SERIAL, bloquea todo)**
- `src/application/ports.ts`: `Eip3009Authorization`, `PrincipalSettlementGateway`, `SettlementFailureReason`; `WalletPort.authorizePrincipal(quote, remittanceId)` → `{tx, eip3009?}`.
- `src/infrastructure/settlement/attestation.ts`: `issueSettlementAttestation` / `verifySettlementAttestation` (HMAC, patrón `kyc-auth.ts`; secreto **dentro** de la función — CD-14).
- `src/test-support/fakes.ts`: `FakeSettlementGateway` (scriptable ok/fail); `FakeWallet` gana `eip3009` opcional. `test-container.ts`: override `settlement?`.

**W1 — Wallet: payload completo + nonce determinístico** (dep: W0)
- `src/infrastructure/wallet.ts`: `InjectedWallet` (`:65-100`) y `WalletConnectWallet` (`:181-215`) devuelven `{tx: sig, eip3009: {authorization, signature}}` en rama real; nonce `keccak256` determinístico (DT-6); serialización `bigint → string` canónica (CD-16). Ramas demo (`:94-99`, `:209-214`) y `FallbackWallet` (`:114-116`) **intactas** (AC-5).

**W2 — Ruta de settle + cliente del facilitador** (dep: W0; ‖ W3)
- `app/api/settle/principal/route.ts` — ramas **S1-S21**. Imports **relativos** (`../../../../src/...` — 4 niveles desde `app/api/settle/principal/`; **contar ejecutando**, CD-13). Env **dentro** del handler (CD-14).

**W3 — Verificador on-chain** (dep: W0; ‖ W2)
- `src/infrastructure/settlement/onchain-verifier.ts` — ramas **V1-V9**. viem `createPublicClient` read-only + `parseEventLogs`/`decodeEventLog` del `Transfer` de USDC. **Cero** `writeContract`/`sendTransaction` (CD-5).

**W4 — Gateway cliente + cableado** (dep: W1, W2, W3)
- `src/infrastructure/settlement/http-settlement-gateway.ts` (llama a `/api/settle/principal`; patrón `gateways.ts:97-111` + type-guards explícitos, sin `any` — CD-15 de WKH-186).
- `src/composition/container.ts`: instanciar **solo** si `NEXT_PUBLIC_EIP3009_ENABLED === "true"` (AC-5) y pasar a `ConfirmAndSend` (`:85`). **Guard `:59-67` intacto** (AC-8/CD-2).

**W5 — `ConfirmAndSend`** (dep: W4)
- Ramas **C1-C8** entre `:85` y `:86`; marca DT-8 en `failAndRefund` (AC-6); comentario inline de AC-9 (orfandad no cerrada → WKH-207).

**W6 — Enforcement del gate (AC-10/AC-11)** (dep: W0, W5) — *descopable, ver §10*
- `src/infrastructure/settlement/attestation-store.ts` (Upstash `SET NX`, DT-3).
- `app/api/a2a/payout/submit/route.ts`: guards **A1-A10** (guards 1-6 existentes byte-idénticos, CD-11).
- `src/application/ports.ts` (`PayoutSubmit.settlementAttestation?: string`) + `gateways.ts:119-142` + `confirm-and-send.ts:103-111`.

**W7 — Env, docs, regresión** (dep: todas)
- `.env.example`: `FACILITATOR_BASE_URL`, `FACILITATOR_API_KEY`, `AVALANCHE_RPC_URL`, `SETTLE_ATTESTATION_SECRET` — **todas server-only, ningún `NEXT_PUBLIC_`** (CD-4). Documentar que los flags siguen **off** (CD-1).
- Regresión: `npm run qa` → **287 pre-existentes verdes sin tocar asserts** + los nuevos.

---

## 7. Plan de tests (≥1 por AC)

**Cómo se testea un settle on-chain sin cadena real** — 3 niveles, **sin anvil** (ningún test de este repo levanta una cadena; el ecosistema ya validó Fuji real en WFAC-52 del lado del facilitador, y CD-6 prohíbe tocar ese repo):

1. **Use-case**: `FakeSettlementGateway` inyectado vía `test-container` (patrón `FakePayoutGateway`/`FakeRefundGateway`) → controla `{ok:true/false}` y los valores. **No** toca HTTP ni cadena.
2. **Rutas `app/api/**`**: `vi.stubGlobal("fetch", vi.fn())` (patrón ya usado en `app/api/a2a/*/route.test.ts`) + `vi.stubEnv`. Imports **relativos** (el alias `@/` no resuelve en vitest).
3. **Verificador on-chain**: `vi.mock` del `publicClient` de viem → `getTransactionReceipt` devuelve receipts sintéticos (status/logs fabricados). Es la única forma de cubrir V3-V8 de forma determinística y rápida.

| AC | Test |
|---|---|
| AC-1 | `confirm-and-send.test.ts`: EIP-3009 on + fake ⇒ `settle()` invocado **con la authorization completa** (no solo la firma); spy sobre el arg. |
| AC-2 | (a) `onchain-verifier.test.ts`: receipt con `Transfer.to = 0xOTRO` ⇒ `settle_receiver_mismatch`; `value` distinto ⇒ `settle_amount_mismatch`; sin log ⇒ `settle_unverified`; 2 logs ⇒ `settle_unverified` (V4-V8). (b) `confirm-and-send.test.ts`: C4/C5 ⇒ `markPrincipalIn` **nunca** llamado + `payout_failed`. (c) Positivo: valores correctos ⇒ `markPrincipalIn(txHash)`. |
| AC-3 | `confirm-and-send.test.ts`: `{ok:false}` para cada `SettlementFailureReason` + throw (C2/C3) ⇒ `payout_failed`, `principalTx === null`, `creditBack` invocado. `route.test.ts`: S14-S20 (401/403/400/409/429/503/500/timeout/200-basura) ⇒ código esperado, **nunca** 200. |
| AC-4 | `confirm-and-send.test.ts`: `snapshot.principalTx === "0x<64hex>"` (el hash del fake) **y `!== signature`** del input. |
| AC-5 | Regresión: los **14** tests de `confirm-and-send.test.ts` (autoridad: `npx vitest run src/application/use-cases/confirm-and-send.test.ts` → `PASS (14)`) verdes **sin tocar asserts**; `NEXT_PUBLIC_EIP3009_ENABLED` unset ⇒ spy sobre la factory del gateway **nunca** invocada; `FallbackWallet.authorizePrincipal` sigue devolviendo `{tx}` sin `eip3009`. |
| AC-6 | `confirm-and-send.test.ts`: seed `principal_in` en modo real → forzar `payout_failed` ⇒ `failureReason === "principal_settled_refund_manual"` (string estable). Contraste: modo demo ⇒ el `reason` de hoy, intacto. |
| AC-7 | `app/api/settle/principal/route.test.ts`: assert que el `fetch` mockeado recibió `Authorization: Bearer <key>` **y** que la respuesta al cliente **no** contiene `FACILITATOR_API_KEY`/`FACILITATOR_BASE_URL`/`AVALANCHE_RPC_URL` (assert sobre el JSON serializado). Unit del gateway: llama a `/api/settle/principal`, **nunca** a la URL del facilitador. |
| AC-8 | Regresión: los **8** tests de `container.test.ts` (autoridad: `npx vitest run src/composition/container.test.ts` → `PASS (8)`) verdes **sin modificar aserciones**. El work-item decía 6 (CD-13). |
| AC-9 | CR/documental: comentario inline en el nuevo port/gateway citando la orfandad no cerrada + **WKH-207**. Sin test automatizado. |
| AC-10 | `app/api/a2a/payout/submit/route.test.ts`: A3-A7 (sin atestación / HMAC forjado / vencida / `valueMinor` != `amountUsd` / `from` != `address`) ⇒ **403** y `fetch` al agente **nunca** invocado. A1 (sin secreto, `VERCEL_ENV` vacío) ⇒ los **19** tests actuales del archivo (autoridad: `npx vitest run app/api/a2a/payout/submit/route.test.ts` → `PASS (19)`; ⚠️ `grep` diría 16 — §2.6) verdes sin tocar asserts. A2 (sin secreto + `VERCEL_ENV="production"`) ⇒ **503**. |
| AC-11 | Mismo archivo: 2ª presentación de la misma atestación ⇒ **409**, forward no invocado; Upstash unset/throw ⇒ **503**, forward no invocado. |

---

## 8. Exemplars verificados (paths confirmados con Glob/Read)

| Para | Exemplar | Qué copiar |
|---|---|---|
| Ruta API server-only fail-closed | `app/api/a2a/payout/submit/route.ts` | Guard-order, `isRecord` sobre `req.json()`, errores opacos, `AbortSignal.timeout`, `VERCEL_ENV` |
| HMAC stateless | `src/infrastructure/kyc-auth.ts` | `createHmac`+`timingSafeEqual`, longitud primero, secreto dentro de la función |
| Upstash | `src/infrastructure/rate-limit.ts` | `new Redis({url, token})`, lazy + fail-closed |
| Gateway cliente → ruta propia | `src/infrastructure/a2a/gateways.ts:96-142` | `fetch` a `/api/...`, type-guards explícitos, errores PII-free |
| Fakes | `src/test-support/fakes.ts` + `test-container.ts` | `FakePayoutGateway`, `TestContainerOverrides` |
| Chain/env fail-loud | `src/infrastructure/chain.ts` | `isAddress` + throw |

---

## 9. Qué cierra / Qué NO cierra

**Cierra**
- `principal_in` deja de significar "el usuario firmó" y pasa a significar **"hay un receipt on-chain, verificado por nosotros contra el log `Transfer` del USDC, con el monto y el receiver correctos"** (con el flag ON).
- Con W6: el ataque que motiva la HU (KYC propio + address propia + `POST /api/a2a/payout/submit` directo con monto arbitrario) queda **bloqueado**: el payout exige atestación server-side, y su monto queda **atado al USDC realmente recibido** y su pagador **atado al address KYC-validado** (WKH-202).
- Doble-pago del principal: **imposible a nivel contrato** para una misma (remesa, quote) — nonce determinístico (DT-6).
- Reuso de infra auditada; **cero** broadcast propio (CD-5).

**NO cierra**
- ⚠️ **Cerrar G3 NO habilita la Fase A.** Siguen bloqueando: **G5/WKH-206** (posesión criptográfica — hoy nada prueba que el caller controla la wallet), la **mitad B** del payout (USDC→PEN→Yape, bloqueada por el sandbox de TransFi), y **partners/legal** (founder). Los flags siguen **off por default** (CD-1): esta HU **construye, no enciende**.
- **Remesas huérfanas** (pestaña cerrada entre `principal_in` y el estado terminal, con el principal **realmente adentro**) → **WKH-207**. Esta HU **empeora la consecuencia** (antes no había plata; ahora sí) sin cerrar el gap — AC-9. El single-use pre-forward (DT-7) crea un caso nuevo de varado: atestación quemada + forward fallido ⇒ reconciliación manual, también **WKH-207**.
- **Clawback real**: imposible con el patrón `RefundGateway` (DT-8). `payout_failed` con principal adentro = **dinero real atrapado**, marcado `principal_settled_refund_manual` — resolución **manual**.
- **Persistencia** del estado de la remesa (`localStorage`) → WKH-207 (CD-8 intacto).
- **WKH-203** (`kycPayoutAllowed` sigue siendo un booleano del caller) — ortogonal.

---

## 10. Riesgos, decisiones abiertas y `[NEEDS CLARIFICATION]`

- **[DECISIÓN REQUERIDA — gate SPEC_APPROVED]** **W6 (AC-10/AC-11) es una ampliación sobre la letra de los 9 ACs.** Sin W6, esta HU hace honesto el camino honesto pero **NO cierra G3**: el atacante sigue llamando `/api/a2a/payout/submit` directo (H3), y el residual que `route.ts:16-17` le adjudica a WKH-168 **queda abierto** — el AR lo va a volver a probar ejecutando. Con W6 el tamaño real pasa de **L** a **XL**. Recomiendo **incluirlo**: un gate que no detiene al atacante no es un gate. Si se descopa: registrar HU de seguimiento y **decirlo explícitamente** en el done-report (no declarar G3 cerrado).
- **[DECISIÓN, descopable]** **DT-5** (verificación on-chain independiente). Si se corta, AC-2 baja a "atestiguado por el facilitador" (H1: la respuesta es un eco) y R2 queda parcialmente abierto. Recomiendo mantenerlo.
- **[NEEDS CLARIFICATION — no bloquea F2.5, bloquea el e2e en testnet]** ¿El deploy de `wasiai-facilitator` tiene `AVALANCHE_FUJI_RPC_URL` seteada y el relayer **fondeado en AVAX Fuji**? Precedente de memoria: el gas del relayer se drenó en Kite/Base. Sin esto: `OPERATOR_FUNDING_LOW` (503) → S17 → `payout_failed`. **Los tests con fakes/mocks no dependen de esto.**
- **[NEEDS CLARIFICATION — operador]** `payTo` allowlist: `FACILITATOR_PAYTO_ALLOWLIST` debe incluir `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS`, o **todo** settle da **403** (`settle.ts`, `isPayToAllowed`). ¿Key propia para chaski-v2 o compartida? (impacta cap diario y rate-limit por key).
- **[RIESGO CONFIG — fail-closed, documentar en el runbook]** El facilitador **hardcodea** el USDC canónico por cadena (`avalanche.ts`: Fuji `0x5425890298aed601595a70AB815c96711a31Bc65`, mainnet `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`) y rechaza si `accepted.asset` no coincide (`base-adapter.ts:586` → 400). Si `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS` difiere ⇒ **todo settle falla 400**. Es fail-closed (no pierde plata), pero es un config-drift silencioso — precedente WKH-162.
- **[RIESGO — ecosistema]** `auth.ts:100`: `if (configured.length === 0) return;` — un facilitador **sin** `FACILITATOR_API_KEY`/`FACILITATOR_API_KEYS` **no autentica**. No es nuestro código (CD-6), pero nuestra seguridad depende de esa config. Verificar antes de encender.
- **[RIESGO — aceptado]** `AVALANCHE_RPC_URL` es un RPC público → rate-limit/latencia pueden dar V2 ⇒ 503 ⇒ `payout_failed` con el principal **adentro** (varado). Mitigación mínima: RPC dedicado y timeout generoso. La reconciliación real es WKH-207.

---

## 11. Constraint Directives

**Heredados del work-item (intactos)**: **CD-1** (prohibido encender flags por default — la HU construye, no enciende) · **CD-2** (prohibido debilitar el guard `container.ts:59-67`) · **CD-3** (no tocar el demo del jurado) · **CD-4** (credenciales del facilitador SIEMPRE server-side, jamás `NEXT_PUBLIC_`) · **CD-5** (prohibido relayer/broadcast propio) · **CD-6** (`wasiai-facilitator`/`wasiai-a2a` solo como servicios HTTP; jamás importar su código ni modificarlos) · **CD-7** (toda transición a `principal_in` precedida por verificación de monto Y receiver) · **CD-8** (prohibido decidir/implementar persistencia o reconciliación de huérfanos).

**Nuevos (de este SDD)**:

- **CD-9**: PROHIBIDO tomar `payTo`, `asset` o `network` del body de la request. **Siempre** de env server-side (`resolveReceiverAddress()`/`resolveUsdcAddress()`/`resolveChainId()`) — DT-4.
- **CD-10**: PROHIBIDO tratar la respuesta del facilitador como verificación on-chain. Es un **eco** de nuestro input (`base-adapter.ts:811,817-819`). `{settled:true}` + HTTP 200 **nunca** bastan para `markPrincipalIn` (R2/H1).
- **CD-11**: PROHIBIDO alterar los guards 1-6 existentes de `app/api/a2a/payout/submit/route.ts:46-96` ni los asserts de sus **19** tests (runtime; §2.6). La atestación se **agrega** después de la autoridad y antes del forward.
- **CD-12**: OBLIGATORIO fail-closed en **toda** rama nueva. Ante error, timeout, ambigüedad, `reason` desconocido o dependencia caída → **bloquear**, nunca `markPrincipalIn`, nunca forwardear. Sin `default:` permisivo (lección WKH-198).
- **CD-13**: PROHIBIDO escribir números de artefactos ("los N tests") sin el comando que los verifica, y **PROHIBIDO usar `grep -c` como autoridad de conteo de tests** (§2.6: cuenta un `it.each` de 4 casos como 1). La **única** autoridad es el runner: `npx vitest run <archivo>` → `PASS (N)`. Verificado en F2 ejecutando: `container.test.ts` = **8** (el work-item decía 6), `confirm-and-send.test.ts` = **14**, `app/api/a2a/payout/submit/route.test.ts` = **19** (grep diría 16), suite = **287**. *(recurrente: WKH-198/201/202)*
- **CD-14**: OBLIGATORIO leer env **dentro** del handler/función, nunca en el top-level del módulo (rompe `vi.stubEnv`). *(recurrente: WKH-186; exemplars: `submit/route.ts:43`, `kyc-auth.ts:12-17`)*
- **CD-15**: OBLIGATORIO `const parsed: unknown = await req.json().catch(() => null)` + `isRecord()` antes de leer campos. PROHIBIDO `as {...}` sobre `req.json()` y `.catch(() => ({}))`. *(recurrente: WKH-202 BLQ-BAJO-1)*
- **CD-16**: PROHIBIDO `JSON.stringify` sobre `bigint` (`TypeError`). La conversión a uint256 decimal canónico se hace en `wallet.ts`. PROHIBIDO `String(x)`/`Number(x)` sobre input hostil sin `typeof`/`Number.isInteger` (lecciones WKH-204/WKH-198: `String(123) === "123"`, `Number("") === 0`).
- **CD-17**: PROHIBIDO loguear o ecoar `signature`, `FACILITATOR_API_KEY`, `AVALANCHE_RPC_URL`, `SETTLE_ATTESTATION_SECRET` o PII del beneficiario. `txHash`/`blockNumber` **sí** son públicos.
- **CD-18**: OBLIGATORIO — `chaski-v2` **jamás** ejecuta `writeContract`/`sendTransaction`/`sendRawTransaction`/`prepareTransactionRequest`. El único cliente viem nuevo es un `publicClient` **read-only** (DT-5). Verificable: `grep -rn "writeContract\|sendTransaction\|sendRawTransaction" src app` → **0**.
- **CD-19**: PROHIBIDO reusar el nonce aleatorio. El nonce EIP-3009 es determinístico por `(remittanceId, quoteId)` (DT-6) — es la garantía anti-doble-pago a nivel contrato.

---

## 12. Readiness Check

| # | Check | Estado |
|---|---|---|
| 1 | Work-item leído entero (9 ACs, 8 CDs, DT-1/2/3) | ✅ |
| 2 | Todos los archivos de Scope IN leídos en su estado actual (`main @ bda96ba`, post-WKH-202) | ✅ `confirm-and-send.ts` leído entero incluida la línea `:109` de WKH-202 |
| 3 | Exemplars verificados con Read (paths reales, no inventados) | ✅ §8 |
| 4 | DT-1 verificado por mí en `wasiai-facilitator` (no citado de segunda mano) | ✅ §1.1 — corregido el matiz `avalanche.ts` vs `base-adapter.ts` |
| 5 | Contrato del facilitador confirmado campo a campo contra el Zod real | ✅ §DT-1 (`schemas.ts:60-98,112`) |
| 6 | Baseline verificado **ejecutando** | ✅ `npx vitest run` → PASS (287) FAIL (0) |
| 7 | Números de artefactos verificados **con el runner**, no con grep (CD-13) | ✅ 8 / 14 / 19 / 287 — **corregido el "6" del work-item**; además §2.6 endurece el CD-13 heredado (`grep -c` cuenta un `it.each` de 4 como 1 → casi propago "16" por "19") |
| 8 | Todas las ramas enumeradas con su resultado, todas fail-closed | ✅ S1-S21, V1-V9, A1-A10, C1-C8 |
| 9 | Idempotencia resuelta (3 capas) | ✅ DT-6 |
| 10 | Refund real: decidido y justificado | ✅ DT-8 — **NO entra**; solo la marca AC-6 |
| 11 | Estado server-side: declarado explícitamente, opción (B) NO elegida | ✅ DT-3 — Opción (A) Upstash, mínima, replay-only |
| 12 | Cómo se testea el settle sin cadena real: decidido y justificado | ✅ §7 — 3 niveles, sin anvil |
| 13 | CD-1/CD-2 (flags off + guard fail-loud) preservados por diseño | ✅ AC-5/AC-8, W4 |
| 14 | Auto-Blindaje histórico incorporado a los CDs | ✅ CD-13/14/15/16 |
| 15 | "Qué cierra / Qué NO cierra" nombra G5/WKH-206, mitad B, partners y WKH-207 | ✅ §9 |
| 16 | Sin `[NEEDS CLARIFICATION]` **bloqueantes** para F2.5 | ✅ los 2 abiertos bloquean el **e2e en testnet real**, no el diseño ni los tests con fakes |
| 17 | **Decisión humana pendiente antes de F2.5** | ⚠️ **§10 — alcance de W6 (AC-10/AC-11)**: sin W6, G3 **no** se cierra; con W6, la HU es **XL** |

**Veredicto**: el SDD está **listo para SPEC_APPROVED** salvo por **una** decisión de alcance (Readiness #17): incluir o no **W6**. Todo lo demás está resuelto y verificado en disco.
