# Story File W3 — WKH-227 / HU-SOL-24 · repo `chaski-v3` (CONSUMER)

> Contrato autocontenido para el Dev. Deriva de `chaski-v3/doc/sdd/032-wkh-227-contratos-idl-golden/sdd.md` (SPEC_APPROVED). El Dev SOLO lee este archivo.
>
> **Repo de trabajo:** `/home/ferdev/.openclaw/workspace/chaski-v3`
> **Wave:** W3 (paralelizable con W1 y W2; los valores canónicos de fixture están en este archivo — no hay que esperar a los otros repos)
> **Naturaleza:** 100% ADITIVO. Fixtures vendoreados + replay contract tests + 4 golden EVM + hash IDL + docs. CERO edición de código de producción.

---

## 1. Contexto mínimo

`chaski-v3` es el CONSUMER. Valida los outputs de los agentes remit-* (via `isValidQuoteResult` en `app/api/a2a/quote/route.ts`, `isValidQuoteShape`/`isValidPayoutShape` en `src/infrastructure/a2a/gateways.ts`) y arma el body `/settle` (en `src/infrastructure/settlement/facilitator-client.ts::broadcastSettle`). Esta HU agrega una red de seguridad de 3 piezas, **sin tocar una línea de runtime**:

1. **Contract tests (AC-1):** vendorea (copia) los fixtures de output del provider y los REPLAYA contra los validadores del consumer. Si el provider cambia el shape y se re-vendorea, el validador del consumer deja de matchear → ROJO.
2. **4 golden EVM (AC-4):** congelan la serialización EXACTA de 4 payloads EVM para un input FIJO determinístico. Un byte que cambie → ROJO.
3. **Hash IDL (AC-2/AC-3):** SHA-256 canónico de `src/infrastructure/solana/escrow-idl.ts` vs constante pinneada + best-effort vs `solana-programs`.

---

## 2. Scope IN — archivos EXACTOS a crear (todos bajo `contracts/` en la raíz del repo)

| # | Archivo (path absoluto) | Acción |
|---|-------------------------|--------|
| 1 | `.../chaski-v3/contracts/vendored/corridor-fx.output.fixture.ts` | Crear (COPIA de W1 + header AC-7) |
| 2 | `.../chaski-v3/contracts/vendored/kyc-validator.output.fixture.ts` | Crear (COPIA de W1 + header) |
| 3 | `.../chaski-v3/contracts/vendored/cashout-payout.output.fixture.ts` | Crear (COPIA de W1 + header) |
| 4 | `.../chaski-v3/contracts/vendored/settle-eip3009.body.fixture.ts` | Crear (COPIA de W2 + header) |
| 5 | `.../chaski-v3/contracts/contracts.quote.test.ts` | Crear (AC-1) |
| 6 | `.../chaski-v3/contracts/contracts.payout.test.ts` | Crear (AC-1) |
| 7 | `.../chaski-v3/contracts/contracts.kyc.test.ts` | Crear (AC-1, shape-guard forward-looking) |
| 8 | `.../chaski-v3/contracts/contracts.settle.test.ts` | Crear (AC-1) |
| 9 | `.../chaski-v3/contracts/golden/golden-evm.test.ts` | Crear (AC-4, los 4 golden) |
| 10 | `.../chaski-v3/contracts/golden/eip712-transfer-with-authorization.golden.json` | Generar (UPDATE_GOLDEN) |
| 11 | `.../chaski-v3/contracts/golden/eip3009-authorization.golden.json` | Generar |
| 12 | `.../chaski-v3/contracts/golden/settle-eip3009-body.golden.json` | Generar |
| 13 | `.../chaski-v3/contracts/golden/deposit-attestation.golden.txt` | Generar |
| 14 | `.../chaski-v3/contracts/golden/README.md` | Crear |
| 15 | `.../chaski-v3/contracts/idl/canonical-hash.ts` | Crear (helper, DT-1) |
| 16 | `.../chaski-v3/contracts/idl/escrow-idl.hash.test.ts` | Crear (AC-2 + AC-3) |
| 17 | `.../chaski-v3/contracts/CONTRACT-VERSIONS.md` | Crear |

> Paths absolutos: prefijo `/home/ferdev/.openclaw/workspace/`.

### 2.1 Un cambio de config permitido (NO es runtime)

Para que el gate CD-9 (`tsc --noEmit` COMPLETO) cubra los archivos nuevos, agregar `"contracts/**/*.ts"` al array `include` de `/home/ferdev/.openclaw/workspace/chaski-v3/tsconfig.json` (hoy: `src/**/*.ts`, `app/**/*.ts`, `.next/types/**/*.ts`, ...).

**Grounding verificado:**
- `vitest` en chaski NO tiene config file → glob default → `contracts/**/*.test.ts` en la raíz **SÍ se ejecuta** con `npm test`. ✓ (no requiere cambio para correr los tests).
- `tsconfig.json` include NO cubre `contracts/` hoy → sin el cambio, `tsc --noEmit` **no** los checkea (gap CD-9). Con `"contracts/**/*.ts"` agregado, los checkea. ✓
- **Precedente:** los tests existentes viven bajo `src/` (ej. `src/infrastructure/wallet.test.ts`), YA están en el include y `next build` los compila hoy sin problema (vitest types disponibles). Agregar `contracts/` es análogo → bajo riesgo.
- **Verificar AC-6 tras el cambio:** `npm run build` (`next build`) debe seguir verde. Si `next build` fallara por los test files bajo `contracts/`, alternativa: crear `contracts/tsconfig.json` que extienda el base e incluya `contracts/**/*.ts`, y correr `tsc -p contracts/tsconfig.json --noEmit` como gate adicional (patrón `tsconfig.scripts.json` ya existente en el repo — ver `npm run typecheck:scripts`). Elegí la opción que mantenga `next build` verde; documentá cuál usaste.

Este es el ÚNICO archivo NO-`contracts/` que se toca, y es config, no runtime (CD-1 se refiere a comportamiento runtime; el include de tsconfig no cambia ejecución).

---

## 3. Anti-Hallucination Checklist (verificar ANTES de escribir)

- [ ] `broadcastSettle` + `SettleBroadcastInput` se exportan en `src/infrastructure/settlement/facilitator-client.ts` (líneas 34-44, 82). Env leída DENTRO de la función → usar `vi.stubEnv("FACILITATOR_BASE_URL", ...)` y `("FACILITATOR_API_KEY", ...)`.
- [ ] `issueDepositAttestation` + tipo `DepositAttestation` se exportan en `src/infrastructure/settlement/deposit-attestation.ts` (líneas 20-26, 62). Secret via `vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", ...)`. `exp` viene del payload (NO `Date.now()`).
- [ ] `InjectedWallet`/`pickWallet` + `authorizePrincipal(quote, remittanceId, deposit?)` en `src/infrastructure/wallet.ts` (línea 84). El modo real EIP-3009 se activa con `eip3009Enabled()` → `vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED", "true")`.
- [ ] El harness `makeProvider()` que captura `calls[]` (incl. `eth_signTypedData_v4` con `params`) está en `src/infrastructure/wallet.test.ts:42-60` — **copialo/adaptalo** dentro del golden test (o importá si se exporta; NO se exporta hoy → replicá el patrón). Para chain 84532 usá `chainIdHex: "0x14a34"` (evita el switch).
- [ ] `A2aQuoteGateway`/`A2aPayoutGateway` se exportan en `src/infrastructure/a2a/gateways.ts` (103, 121). `requestQuote` fetchea `/api/a2a/quote`; `submit` fetchea `/api/a2a/payout/submit`. Mockear `global.fetch` para devolver `{ result: <fixture> }`.
- [ ] El handler `POST` de `app/api/a2a/quote/route.ts` (línea 27) se ejercita mockeando `global.fetch` (upstream) + `vi.stubEnv("REMIT_AGENTS_BASE_URL", "https://x")`. **PROHIBIDO importar/exportar `isValidQuoteResult`** (CD-8, ver §7).
- [ ] El IDL: `escrowIdl` se exporta en `src/infrastructure/solana/escrow-idl.ts` (`address: "DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x"`). Se LEE, jamás se edita (CD-2/CD-5).
- [ ] `RawQuoteResult`/`RawPayoutResult` (gateways.ts:19-40) son el shape que el fixture vendoreado debe cumplir.
- [ ] `Quote`/`Money` domain: `src/domain/remittance.ts:15-24` (`quoteId`, `send: Money`, `expiresAt: string`, ...). `Eip3009Authorization`: `src/application/ports.ts:125-132`.
- [ ] `node:crypto` (`createHash`), `viem`, `zod`, `vitest` ya presentes. NO agregar deps.
- [ ] Extensiones de import: chaski usa `moduleResolution: bundler` → imports SIN extensión (ej. `import { escrowIdl } from "../../src/infrastructure/solana/escrow-idl"`). NO poner `.js`.
- [ ] NO `any`. Strict-typed (CD-9).

---

## 4. Fixtures vendoreados (#1-#4) — header AC-7 obligatorio

Cada uno es una **COPIA** del fixture del provider (W1 para #1-#3, W2 para #4), con este header (patrón "COPIA PINNEADA, NO SE EDITA" del IDL — CD-6):

```ts
// COPIA PINNEADA, NO SE EDITA — WKH-227 / HU-SOL-24.
// Origen: <repo>/<archivo del provider>. Sync: 2026-07-22.
// Fixture vendoreado del CONTRATO del provider. Se sincroniza MANUALMENTE en el mismo PR que cambie
// el provider (DT-1 — ver CONTRACT-VERSIONS.md). El contract test de este repo lo replaya contra el
// validador del consumer: si el provider driftea y se re-vendorea, el validador falla → ROJO (AC-1).
```

- #1 origen: `wasiai-remittance-agents/contracts/corridor-fx.output.fixture.ts`
- #2 origen: `wasiai-remittance-agents/contracts/kyc-validator.output.fixture.ts`
- #3 origen: `wasiai-remittance-agents/contracts/cashout-payout.output.fixture.ts`
- #4 origen: `wasiai-facilitator/src/contracts/settle-eip3009.body.fixture.ts`

Tipar los vendoreados con tipos LOCALES del consumer o `as const` (NO importar tipos del otro repo — no hay dep cross-repo, CD-3). Para #1 el shape debe cumplir `RawQuoteResult` (gateways.ts:19-27): `{ quoteId, rate, feeUsd, netDeliveredLocal, etaMinutes, expiresAt, provenance }`. Nota: el output del agente FX incluye además `slug`/`localCurrency`; el validador del consumer solo exige el subconjunto `RawQuoteResult` — el fixture vendoreado puede incluir los campos extra (el validador los ignora), pero para el replay del handler `POST` (que valida `isValidQuoteResult`) alcanza con el subconjunto. Mantené el objeto tal como lo emite el provider y confiá en que el validador consumer matchea su subconjunto.

**Valores canónicos** (de W1/W2; si difieren de la salida real generada por W1, gana la salida real y se re-sincroniza el vendoreado + CONTRACT-VERSIONS.md):
- FX: `{ quoteId, rate:<number>, feeUsd:<number>, netDeliveredLocal:<number>, etaMinutes:<number>, expiresAt:"<ISO>", provenance:"<...>" }` — los números son FIAT `number` (AC-5).
- KYC: `{ slug:"remit-kyc-validator", approved:true, riskLevel:<...>, reasons:[...], verificationId:"<...>", provenance:"local-fallback", payoutAllowed:false }` — SIN `travelRuleData`/`legalId` (CD-7).
- payout: `{ slug:"remit-cashout-payout", executed:false, status:"blocked", payoutId:null, deliveredLocal:null, txRef:null, reason:"kyc_gate_not_passed", provenance:"n/a", depositAddress:null }`.
- /settle: el objeto de §4 de W2 (idéntico al golden #3, ver §6).

---

## 5. Contract tests replay (AC-1) — #5-#8

Exemplars: `src/infrastructure/wallet.test.ts` (mock provider/fetch), `src/infrastructure/settlement/facilitator-client.test.ts`, `gateways`.

**#5 `contracts.quote.test.ts`:**
- (a) **Handler `POST`:** `vi.stubEnv("REMIT_AGENTS_BASE_URL","https://agent.test")`; mockear `global.fetch` → `new Response(JSON.stringify({ result: corridorFxVendoredFixture }), { status: 200 })`. Importar `POST` de `app/api/a2a/quote/route`. `const res = await POST(new Request("http://x", {method:"POST", body: JSON.stringify({amountUsd:100})}))`; assert `res.status === 200`.
  - **Drift (rojo):** un fixture con `feeUsd` renombrado a `feeUsd2` → `isValidQuoteResult` devuelve false → `res.status === 502`. Incluir un test que assertee que el fixture CANÓNICO da 200 (verde hoy). (El caso drift es documentado como comentario/test opcional que muta el fixture in-memory, no un 2º fixture en disco.)
- (b) **Gateway:** `A2aQuoteGateway.requestQuote(req)` con `global.fetch` mockeado devolviendo `{ result: fixture }`. Assert que NO throwea (mapea a `Quote`). Un fixture drift → `throw a2a_quote_bad_shape`.
  - `requestQuote` fetchea la ruta relativa `/api/a2a/quote` → mockear `global.fetch` para esa URL.

**#6 `contracts.payout.test.ts`:**
- `A2aPayoutGateway.submit(req)` con `global.fetch` → `{ result: cashoutPayoutVendoredFixture }`. Assert no-throw. Drift → `throw a2a_payout_bad_shape`. `submit` fetchea `/api/a2a/payout/submit`.
- `PayoutSubmit` req: usar campos mínimos válidos (ver `application/ports` `PayoutSubmit`: `quoteId`, `amountUsd`, `kycVerificationId`, `address`, `beneficiary`, `idempotencyKey`, opcionales attestations). Confirmá la firma real en `ports.ts` antes de armar el req.

**#7 `contracts.kyc.test.ts` (forward-looking):**
- KYC NO tiene consumer productivo en chaski (el KYC va por Didit `/api/kyc/*`). Definir un **shape-guard test-only** que espeje `KycAgentOutput` (keys + typeof) y validá el fixture vendoreado contra él. Documentar en el propio test y en `CONTRACT-VERSIONS.md` que es forward-looking (mantiene simetría con los otros 2 contratos sin inventar un consumer). Assert además que el fixture NO contiene `"travelRuleData"` ni el legalId (CD-7).

**#8 `contracts.settle.test.ts`:**
- `vi.stubEnv("FACILITATOR_BASE_URL","https://fac.test")` + `("FACILITATOR_API_KEY","k")`.
- Mockear `global.fetch` para capturar el `body` del POST a `${BASE}/settle` y devolver un 200 con `{ settled:true, transactionHash:"0x"+"11".repeat(32) }` (para que `broadcastSettle` retorne ok; lo que importa es capturar el body).
- Llamar `broadcastSettle(fixedSettleInput)` con el INPUT FIJO (§6.3). Parsear `JSON.parse(capturedBody)` y `expect(...).toEqual(settleVendoredFixture)`.
- **Drift (rojo):** si el facilitator agrega un campo requerido y se re-vendorea el fixture, el body que arma `broadcastSettle` no lo incluye → `toEqual` mismatch → ROJO.
- **Doble uso:** este body capturado ES el golden #3 (§6.3). Reusá el mismo `fixedSettleInput`.

---

## 6. Golden EVM (AC-4) — #9-#13

### 6.1 Fixture determinístico compartido (constantes del test — §4.4 del SDD, copiar verbatim)

```
REMITTANCE_ID  = "rmt_fixed_0001"
QUOTE_ID       = "q_fixed_0001"
FROM           = 0xf39fd6e51aad88f6f4ce6ab8827279cffFb92266   // hardhat acct#0 (viem checksumea)
DEPOSIT_ADDR   = 0x1111111111111111111111111111111111111111
SEND_MINOR     = "400000000"        // 400 USDC (6 dec) — STRING (AC-5)
EXPIRES_AT     = "2030-01-01T00:00:00.000Z"   // ISO fijo futuro → validBefore estable
CHAIN          = 84532 (Base Sepolia, default). NEXT_PUBLIC_CHAIN_ID unset → resolveChainId()=84532.
                 net.eip712 = { name:"USDC", version:"2" }; usdc = resolveUsdcAddress() para 84532.
                 provider mock: chainIdHex "0x14a34" (=84532) para evitar wallet_switchEthereumChain.
DEPOSIT_SECRET = "golden-fixed-secret"
EXP            = 1893456000          // epoch SEG fijo (NO Date.now())
```

- `validBefore` del golden = `BigInt(Math.floor(Date.parse(EXPIRES_AT)/1000))` → determinístico por `EXPIRES_AT`.
- `nonce` = `deterministicNonce(REMITTANCE_ID, QUOTE_ID)` (keccak256, en wallet.ts) → determinístico. NO random.
- Construir un `Quote` fijo con `quoteId:QUOTE_ID`, `send: Money` = 400 USDC (minor "400000000"), `expiresAt: EXPIRES_AT`. Verificá el constructor de `Money` en `src/domain/money.ts` para instanciar 400 USDC correctamente.

### 6.2 Mecanismo de generación/verificación (CD-4 — NUNCA a mano)

Cada golden test: si `process.env.UPDATE_GOLDEN` está seteado → `writeFileSync` del valor GENERADO por el código; si no → `readFileSync` + `toEqual`/`toBe`. Primera generación:
```bash
UPDATE_GOLDEN=1 npm test -- contracts/golden/golden-evm.test.ts
```
Los `.golden.json`/`.golden.txt` se GENERAN del código y se congelan. PROHIBIDO escribir el valor esperado a mano ni ajustar el código para matchear un valor imaginado (CD-4).

### 6.3 Los 4 golden (copiar el detalle del SDD §4.4)

| # | Payload | Cómo se captura | Golden file |
|---|---------|-----------------|-------------|
| 1 | **EIP-712 typed-data** (domain+types+message de `signTypedData`) | Conectar `InjectedWallet` con `makeProvider({accounts:[FROM], chainIdHex:"0x14a34"})`; `vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED","true")`; `authorizePrincipal(quote, REMITTANCE_ID, {address:DEPOSIT_ADDR})`; el mock captura la call `eth_signTypedData_v4` → `params[1]` = JSON del typed-data (viem serializa bigints→decimal string). Parsear ese JSON y comparar con el golden. | `eip712-transfer-with-authorization.golden.json` |
| 2 | **`eip3009.authorization` serializado** | Del retorno de `authorizePrincipal()`: `result.eip3009.authorization` (objeto de strings: `value`/`validAfter`/`validBefore` decimal, `nonce` hex determinístico, `from`/`to`). Comparar el objeto. | `eip3009-authorization.golden.json` |
| 3 | **Body `/settle` EIP-3009** | `broadcastSettle(fixedSettleInput)` con `global.fetch` mockeado que captura el `body`; el `SettleBroadcastInput` fijo usa la `authorization` del golden #2 + `payTo:DEPOSIT_ADDR`, `asset:resolveUsdcAddress()`, `chainId:84532`, `amountMinor:"400000000"`, `resourceUrl` fijo. Comparar el body parseado. **Es el MISMO objeto que valida el contract test #8** contra el fixture vendoreado del facilitator. | `settle-eip3009-body.golden.json` |
| 4 | **`issueDepositAttestation`** | `vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", DEPOSIT_SECRET)`; `issueDepositAttestation({remittanceId:REMITTANCE_ID, quoteId:QUOTE_ID, depositAddress:DEPOSIT_ADDR, chainId:84532, exp:EXP})` → string `b64url.b64url`. Comparar con `toBe` (string exacto). | `deposit-attestation.golden.txt` |

- **Scope OUT (DT-3):** NO congelar el envelope Solana base58 de `verifySolanaSettlement` (T-9 es EVM-only). NO congelar el `signMessage` demo de `wallet.ts:146-149`.
- **CD-12:** el golden #1/#2 captura la serialización bigint→string que hace viem/`String()`. PROHIBIDO `JSON.stringify` directo sobre un bigint (TypeError).

### 6.4 `golden/README.md` (#14)

Documenta: los golden se GENERAN del código (`UPDATE_GOLDEN=1 npm test -- contracts/golden/golden-evm.test.ts`), NUNCA se editan a mano (CD-4). Un cambio en cualquier golden en el diff del PR = cambio de serialización EVM a revisar conscientemente. Explica el fixture determinístico (§6.1) y por qué es reproducible (sin Date.now/random).

---

## 7. `CD-8` (WKH-208, auto-blindaje heredado) — CRÍTICO para #5

**PROHIBIDO exportar un helper (`isValidQuoteResult`) desde `app/api/a2a/quote/route.ts`.** Un `route.ts` de Next.js solo puede exportar handlers HTTP; un export extra rompe `tsc --noEmit` sobre `.next/types` (el tipo generado exige que el export extra sea `never`). El contract test de `quote/route.ts` ejercita el validador **a través del handler `POST` exportado** (con `global.fetch` mockeado), NUNCA importando/exportando `isValidQuoteResult`. Verificado como error recurrente en WKH-208.

Referencias de auto-blindaje heredadas (recurrentes ≥2 HUs — ya en CDs del SDD):
- **CD-9 (WKH-196):** el gate es `npx tsc --noEmit` COMPLETO (incluye `.next/types`), NO solo `npm run build`. Corré ambos.
- **CD-11 (WKH-216):** en el caso "param ausente con default", usar `null` explícito, nunca `undefined`.
- **CD-10 (WKH-216):** N/A acá (EVM-only, sin base58 a mano).

---

## 8. Hash IDL (AC-2 + AC-3) — #15, #16

### 8.1 `contracts/idl/canonical-hash.ts` (#15) — algoritmo EXACTO (idéntico a W2)

```ts
import { createHash } from "node:crypto";

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v !== null && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

export function canonicalSha256(obj: unknown): string {
  return createHash("sha256").update(canonicalJson(obj), "utf8").digest("hex");
}
```

### 8.2 `contracts/idl/escrow-idl.hash.test.ts` (#16)

```ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { escrowIdl } from "../../src/infrastructure/solana/escrow-idl";  // SIN extensión (bundler)
import { canonicalSha256 } from "./canonical-hash";

// Pinneada y verificada en F2 sobre los 3 IDL reales (todos canonicalizan igual, address DR5G).
const ESCROW_IDL_SHA256 = "aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71";
```

- **AC-2 (siempre corre):** `expect(canonicalSha256(escrowIdl)).toBe(ESCROW_IDL_SHA256)`. Si alguien edita `escrow-idl.ts` a mano sin re-pinnear → ROJO.
- **AC-3 (best-effort, skip limpio):**
  ```ts
  const SIBLING = path.resolve(process.cwd(), "../solana-programs/target/idl/escrow.json");
  (existsSync(SIBLING) ? it : it.skip)("AC-3: coincide con solana-programs", () => {
    expect(canonicalSha256(JSON.parse(readFileSync(SIBLING, "utf8")))).toBe(ESCROW_IDL_SHA256);
  });
  ```
  El sibling EXISTE hoy en el workspace (verificado F2.5). `solana-programs` se LEE, jamás se escribe (CD-2). `src/infrastructure/solana/escrow-idl.ts` NO se edita (CD-5).

---

## 9. `contracts/CONTRACT-VERSIONS.md` (#17)

Tabla: por cada fixture vendoreado → repo/archivo/fecha de origen (sync 2026-07-22) + commit si aplica (DT-1). Incluir:
- Nota de deuda técnica explícita (Missing Input #1): NO hay CI cross-repo real; la sincronización provider→consumer es MANUAL dentro del mismo PR. Ticket follow-up sugerido: `WKH-TBD: CI cross-repo drift trigger` (GitHub Action `repository_dispatch` provider→consumers). NO se implementa acá (CD-3).
- Nota de que el contrato KYC es **forward-looking** (no hay consumer productivo en chaski; el KYC va por Didit `/api/kyc/*`).
- La constante `ESCROW_IDL_SHA256` y su significado (los 3 IDL canonicalizan igual; re-pinneo solo con SDD explícito, nunca drift silencioso).

---

## 10. Constraint Directives que aplican a W3

- **CD-1**: CERO cambio runtime. Solo `contracts/` + el `include` de tsconfig (config, no runtime). Ningún validador/serialización/schema/IDL de producción se edita.
- **CD-2 / CD-5**: `solana-programs/...escrow.json` y `src/infrastructure/solana/escrow-idl.ts` se LEEN, jamás se editan.
- **CD-4**: los golden se GENERAN (`UPDATE_GOLDEN=1`), nunca a mano; nunca ajustar código para matchear un valor imaginado.
- **CD-6/AC-7**: cada fixture vendoreado con header "COPIA PINNEADA, NO SE EDITA" + origen + sync 2026-07-22.
- **CD-7**: PROHIBIDO PII. El fixture KYC sin `travelRuleData`/`legalId`; assert que `JSON.stringify` no contiene el legalId.
- **CD-8 (WKH-208)**: NO exportar helper de `route.ts`; testear vía el handler `POST`.
- **CD-9 (WKH-196)**: gate = `npx tsc --noEmit` COMPLETO (con `.next/types`) + `npm test`. `npm run build` verde (AC-6). Strict-typed, sin `any`.
- **CD-12**: bigint→JSON lo hace viem/`String()`; el golden captura eso. Nunca `JSON.stringify` sobre bigint.
- **AC-5**: `amountMinor`/`value`/`SEND_MINOR` = decimal STRING. FIAT (`rate`/`feeUsd`/`netDeliveredLocal`) queda `number`, sin convertir.

---

## 11. Tests requeridos

| Test | AC | Verifica |
|------|----|----------|
| `contracts.quote.test.ts` | AC-1 | fixture FX vendoreado vs handler `POST` (200) + `A2aQuoteGateway` (no-throw); drift → 502/throw |
| `contracts.payout.test.ts` | AC-1 | fixture payout vs `A2aPayoutGateway.submit` (no-throw); drift → throw |
| `contracts.kyc.test.ts` | AC-1 | fixture KYC vs shape-guard forward-looking; sin PII |
| `contracts.settle.test.ts` | AC-1 | body de `broadcastSettle(fixedInput)` == fixture /settle vendoreado (toEqual) |
| `golden-evm.test.ts` (4) | AC-4 | 4 payloads EVM byte-idénticos vs golden congelados |
| `idl/escrow-idl.hash.test.ts` | AC-2, AC-3 | hash local == pinned; best-effort vs sibling |
| Suite existente completa | AC-6 | 100% verde (`npm test`) |

---

## 12. Done Definition (W3)

- [ ] Los 17 archivos creados bajo `contracts/` (+ el include de tsconfig ajustado).
- [ ] 4 golden generados con `UPDATE_GOLDEN=1` y congelados (no editados a mano).
- [ ] `cd /home/ferdev/.openclaw/workspace/chaski-v3 && npx tsc --noEmit` → 0 errores (COMPLETO, con `.next/types` — CD-9).
- [ ] `npm test` → suite previa 100% verde + todos los tests nuevos verdes (AC-6). AC-3 corre (sibling existe).
- [ ] `npm run build` (`next build`) verde tras el cambio de tsconfig include (AC-6).
- [ ] `contracts.settle.test.ts` `toEqual` verde ⇔ golden #3 == fixture /settle vendoreado (doble uso consistente).
- [ ] `ESCROW_IDL_SHA256 = aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71` pinneada tal cual.
- [ ] Fixtures vendoreados con header AC-7; KYC sin PII (CD-7).
- [ ] NINGÚN archivo de producción editado (route.ts, gateways.ts, wallet.ts, facilitator-client.ts, deposit-attestation.ts, escrow-idl.ts, schemas — solo lectura/import).
- [ ] `CONTRACT-VERSIONS.md` + `golden/README.md` escritos con la deuda técnica documentada.

---

## 13. Comando de verificación

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
UPDATE_GOLDEN=1 npm test -- contracts/golden/golden-evm.test.ts   # primera generación de golden
npx tsc --noEmit           # CD-9: gate estático COMPLETO (incluye .next/types)
npm test                   # AC-6: suite previa verde + todos los nuevos (golden ya congelados)
npm run build              # AC-6: next build verde tras el include de contracts/
```
