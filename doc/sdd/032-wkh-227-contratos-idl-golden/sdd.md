# SDD #032: [WKH-227 / HU-SOL-24] Contratos A2A tipados + IDL versionado + golden EVM tests

> SPEC_APPROVED: no
> Fecha: 2026-07-22
> Tipo: improvement (testing / red de seguridad cross-repo)
> SDD_MODE: full
> Branch: feat/032-wkh-227-contratos-idl-golden
> Artefactos: doc/sdd/032-wkh-227-contratos-idl-golden/
> Repos afectados: `chaski-v3` (consumer), `wasiai-remittance-agents` (provider), `wasiai-facilitator` (provider). `solana-programs` = solo lectura (fuente de verdad del IDL).

---

## 1. Resumen

Esta HU cierra dos deudas de testing cross-repo (T-3 contratos HTTP, T-9 "EVM byte-idéntico") de forma **100% aditiva**: agrega fixtures, hashes y golden tests. NO cambia ni una línea de comportamiento runtime, ni un schema Zod, ni el IDL, ni una función de infraestructura. El resultado es una red de seguridad de tres piezas: (1) **contract tests** que replayan un fixture vendoreado del provider contra el validador manual del consumer y se ponen en ROJO ante un drift de shape; (2) **hash SHA-256 del IDL** vendoreado (auto-consistencia + comparación best-effort contra `solana-programs`); (3) **golden tests** que congelan la serialización EXACTA de 4 payloads EVM capturando el estado actual (2026-07-22) como fuente de verdad.

Grounding clave verificado en F2: los tres IDL (`solana-programs/target/idl/escrow.json`, `chaski-v3/src/infrastructure/solana/escrow-idl.ts`, `wasiai-facilitator/src/chains/escrow-idl.ts`) **canonicalizan al MISMO SHA-256** hoy → `aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71` (todos con `address` DR5G). Esta HU pone el test que garantiza esa paridad ANTES del primer drift.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 032 (WKH-227 / HU-SOL-24) |
| **Tipo** | improvement (testing aditivo cross-repo) |
| **SDD_MODE** | full |
| **Objetivo** | Detectar drift de contratos HTTP (rename/add/remove de campos), drift del IDL vendoreado, y cambios byte-a-byte en la serialización de 4 payloads EVM — todo vía tests, sin tocar producción. |
| **Reglas de negocio** | CERO cambio runtime (CD-1). Golden capturan el estado ACTUAL (CD-4). No monorepo/npm compartido (CD-3). No PII en fixtures (CD-7). |
| **Scope IN** | `chaski-v3/contracts/` (fixtures vendoreados + contract tests + golden EVM + hash IDL). `wasiai-remittance-agents/contracts/` (fixtures provider + anchor tests). `wasiai-facilitator/contracts/` + `src/chains/` (fixture /settle + anchor + hash IDL). `CONTRACT-VERSIONS.md`. |
| **Scope OUT** | No tocar schemas/validadores existentes. No congelar el payload Solana base58. No tocar `solana-programs/`. No resolver WKH-208 (bug base58 EVM). No CI cross-repo real. |
| **Missing Inputs** | #1 (drift-detection semi-manual) y #2 (¿1 o N Story Files) — resueltos en §9. |

### Acceptance Criteria (EARS) — heredados del work-item

1. **AC-1**: WHEN un campo de un schema Zod del PROVIDER cambia de nombre y el fixture vendoreado del CONSUMER se actualiza, THEN el validador manual del consumer (`isValidQuoteResult` / `isValidQuoteShape` / `isValidPayoutShape` / el body que arma `broadcastSettle`) SHALL rechazar/no-matchear el fixture → el contract test SHALL fallar (rojo), no pasar en silencio.
2. **AC-2**: THE system SHALL exponer, por cada IDL vendoreado, un test que compute el SHA-256 canónico de la copia local y lo compare contra una constante pinneada en el mismo commit; IF el archivo se edita a mano sin actualizar la constante, THEN el test SHALL fallar.
3. **AC-3**: WHERE los 4 repos están montados en el workspace, THE system SHALL proveer un test best-effort que compare el hash del IDL vendoreado contra `solana-programs/target/idl/escrow.json` por path sibling, y SHALL saltarse (skip) limpiamente cuando ese path no exista.
4. **AC-4**: WHEN cualquiera de los 4 payloads EVM (EIP-712 typed-data input, `eip3009.authorization` serializado, body `/settle` EIP-3009, string de `issueDepositAttestation`) cambia un byte de su serialización para un input FIJO, THEN el golden test correspondiente SHALL fallar.
5. **AC-5**: THE system SHALL usar `string`/`bigint` (minor-units) para todo campo de contrato NUEVO on-chain (uint256/u64); los montos FIAT existentes (`amountUsd`, `feeUsd`, `rate`, `netDeliveredLocal`) SHALL permanecer `z.number()`. Esta HU NO convierte ninguno.
6. **AC-6**: WHILE corre la suite existente de los 3 repos, THE system SHALL mantener el 100% de los tests previos en verde.
7. **AC-7**: IF un fixture se vendorea PROVIDER→CONSUMER, THEN el archivo SHALL llevar header con repo/archivo de origen + fecha de sync (patrón "COPIA PINNEADA, NO SE EDITA").

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `chaski-v3/app/api/a2a/quote/route.ts:13-25,27-48` | Validador consumer `isValidQuoteResult` + handler `POST` | El validador es función **NO exportada** del route (Next). El `POST` fetchea el agente y devuelve 200/502 según `isValidQuoteResult(result)`. |
| `chaski-v3/src/infrastructure/a2a/gateways.ts:19-77,103-157` | 2º validador consumer: `isValidQuoteShape` (quote) + `isValidPayoutShape` (payout), usados por las clases exportadas `A2aQuoteGateway`/`A2aPayoutGateway` | Guards módulo-privados; se ejercitan vía las clases con `fetch` mockeado (`{ result }`). `throw a2a_*_bad_shape` ante shape inválido. |
| `chaski-v3/src/infrastructure/wallet.ts:15-24,84-151` | Golden #1 (EIP-712 types+domain+message) y #2 (`eip3009.authorization`) | `signTypedData({domain,types,message})` con bigints; el retorno de `authorizePrincipal()` serializa bigint→string decimal (`value`/`validAfter`/`validBefore`), `nonce` hex determinístico `keccak256(remittanceId:quoteId)`. |
| `chaski-v3/src/infrastructure/settlement/facilitator-client.ts:82-143` | Golden #3 + contract /settle: `broadcastSettle()` arma `payload` (x402Version:2 literal, `accepted` con `maxTimeoutSeconds:60`, `extra{assetTransferMethod,name,version}`) y hace `JSON.stringify(payload)` en el body del POST. | Todos los objetos del facilitator son `.strict()`. Env leída DENTRO de la función (`vi.stubEnv`). |
| `chaski-v3/src/infrastructure/settlement/deposit-attestation.ts:62-65` | Golden #4: `issueDepositAttestation(p)` → `${b64url(JSON)}.${b64url(hmac)}`. `exp` viene del payload (no `Date.now()`). Secret vía `DEPOSIT_ATTESTATION_SECRET`. | Determinístico dado payload+secret fijos. |
| `chaski-v3/src/infrastructure/wallet.test.ts:1-60` | Harness reutilizable `makeProvider()` que captura `calls[]` (incl. `eth_signTypedData_v4` con `params`) y mockea `@walletconnect`. | viem serializa el typed-data a JSON en `params[1]` del `eth_signTypedData_v4` → captura byte-exacta del golden #1. |
| `chaski-v3/src/infrastructure/settlement/deposit-attestation.test.ts:30-50` | Patrón de test HMAC (`vi.stubEnv` secret, `toEqual`) | Exemplar para el golden #4 (secret fijo + round-trip). |
| `wasiai-facilitator/src/core/schemas.ts:39-207` | Anchor provider /settle: `AcceptedSchema`/`PayloadSchema`/`Eip3009RequestSchema`/`VerifyRequestSchema`/`SettleRequestSchema` — todos `.strict()`. | El body EVM matchea `Eip3009RequestSchema` (rama 1 del union). `.strict()` rechaza campo extra. `Uint256StringSchema` para `amount`/`value`. |
| `wasiai-facilitator/src/__tests__/unit/core.schemas.solana.test.ts:19-45` | Exemplar de test de schema (`VerifyRequestSchema.parse`, fixtures literales, ubicación `src/__tests__/unit/`). | Patrón de anchor test provider-side. |
| `wasiai-remittance-agents/src/agents/corridor-fx.ts:13-42` + `.test.ts` | Provider FX: `CorridorFxInputSchema` (Zod) + `CorridorFxOutput` (interface TS, **sin Zod de salida**). Test usa input `{amountUsd:100}`, fetch mockeado `rates:{PEN:3.8}`. | Input tiene Zod → anchor real; Output es interface → anchor por shape-assertion. DT-5: reusar fixtures de los tests. |
| `wasiai-remittance-agents/src/agents/kyc-validator.ts:16-96` + `.test.ts` | Provider KYC: `KycInputSchema` (Zod) + `KycAgentOutput` (interface, sin PII). Input canónico `validInput` (Alice/Bob, legalId "12345678"). | AC-7/CD-7: el output NO lleva `travelRuleData`/`legalId`. |
| `wasiai-remittance-agents/src/agents/cashout-payout.ts:18-60` + `.test.ts:8-18` | Provider payout: `CashoutPayoutInputSchema` (Zod) + `CashoutPayoutOutput` (interface). `validInput` con `quoteId:"q1"`, `beneficiary`, `idempotencyKey:"idem-1"`. | Output tiene `depositAddress:string|null` (WKH-212). |
| `wasiai-remittance-agents/src/providers/types.ts:82-123` | `FxQuote`/`PayoutResult`: definen los tipos de salida reales. `rate`/`feeUsd`/`netDeliveredLocal` = `number` (FIAT). | AC-5: FIAT queda number. |
| `chaski-v3/src/infrastructure/a2a/gateways.ts:19-40` | `RawQuoteResult`/`RawPayoutResult`: espejo consumer del shape del agente (SOLO lectura del contrato). | Es el shape exacto que el fixture vendoreado debe cumplir. |
| IDL x3 (`solana-programs/target/idl/escrow.json`, `chaski-v3/.../escrow-idl.ts`, `wasiai-facilitator/.../escrow-idl.ts`) | Hash canónico | **Verificado en F2**: los 3 canonicalizan al MISMO SHA-256 `aa53c03f…fb71`. Los `.ts` terminan en `} as const;` y difieren solo en comillas simples/dobles (irrelevante tras `JSON.parse`/canonicalize). |

### Exemplars

| Para crear | Seguir patrón de | Razón |
|-----------|------------------|-------|
| `chaski-v3/contracts/**/*.test.ts` (contract + golden + hash) | `chaski-v3/src/infrastructure/settlement/deposit-attestation.test.ts` + `wallet.test.ts` (`makeProvider`) | vitest + `vi.stubEnv` + captura de `params`/body de fetch. |
| `wasiai-remittance-agents/contracts/*.test.ts` | `src/agents/corridor-fx.test.ts` | vitest, mock de fetch, reuso de `validInput` (DT-5). |
| `wasiai-facilitator/contracts/*.test.ts` | `src/__tests__/unit/core.schemas.solana.test.ts` | `VerifyRequestSchema.parse`/`safeParse` con fixtures literales. |
| Header de fixture vendoreado (AC-7) | Header "COPIA PINNEADA, NO SE EDITA" de `escrow-idl.ts` | Mismo patrón de trazabilidad. |

### Estado de BD / componentes reutilizables

- N/A BD (esta HU no toca persistencia).
- Reutilizables: `makeProvider()` de `wallet.test.ts` (golden #1); `validInput` de cada `*.test.ts` de agentes (DT-5); `VerifyRequestSchema` para el anchor provider /settle.

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

> **TODOS los archivos productivos existentes se tocan SOLO en modo lectura (import) o NO se tocan.** Los únicos archivos nuevos son tests + fixtures + un helper de hash test-scope + docs. Cero edición de producción.

#### Repo `wasiai-remittance-agents` (PROVIDER) — Wave W1

| Archivo | Acción | Descripción | Exemplar | AC |
|---------|--------|-------------|----------|----|
| `contracts/corridor-fx.output.fixture.ts` | Crear | Fixture del OUTPUT de `runCorridorFx` capturado del test existente (input `{amountUsd:100}`, rate 3.8). Tipado `: CorridorFxOutput`. | `corridor-fx.test.ts` | AC-1, DT-5 |
| `contracts/kyc-validator.output.fixture.ts` | Crear | Fixture del OUTPUT de `runKycValidator` (fallback), tipado `: KycAgentOutput`. SIN `travelRuleData`/`legalId` (CD-7). | `kyc-validator.test.ts` | AC-1, CD-7 |
| `contracts/cashout-payout.output.fixture.ts` | Crear | Fixture del OUTPUT de `runCashoutPayout` (rama blocked o mock), tipado `: CashoutPayoutOutput`. | `cashout-payout.test.ts` | AC-1, DT-5 |
| `contracts/inputs.fixture.ts` | Crear | Los 3 INPUT canónicos (reusa `validInput` de cada test). | tests de agentes | AC-1, DT-5 |
| `contracts/contracts.provider.test.ts` | Crear | (a) cada INPUT pasa su `*InputSchema.parse()`; (b) cada OUTPUT fixture shape-matchea lo que `run*()` devuelve HOY (assert de keys + `typeof` por campo). Ancla la fuente de verdad. | `core.schemas.solana.test.ts` | AC-1 |

#### Repo `wasiai-facilitator` (PROVIDER) — Wave W2

| Archivo | Acción | Descripción | Exemplar | AC |
|---------|--------|-------------|----------|----|
| `contracts/settle-eip3009.body.fixture.ts` | Crear | Body `/settle` EIP-3009 completo y VÁLIDO (matchea `Eip3009RequestSchema`). Amounts como decimal STRING (AC-5). | `core.schemas.solana.test.ts` (SOLANA_BODY) | AC-1 |
| `contracts/contracts.provider.test.ts` | Crear | (a) `VerifyRequestSchema.parse(fixture)` OK; (b) fixture con campo extra / campo renombrado → `.safeParse().success === false` (prueba que `.strict()` caza el drift). | `core.schemas.discriminated.test.ts` | AC-1 |
| `src/chains/escrow-idl.hash.test.ts` | Crear | AC-2 (hash local vs pinned) + AC-3 (best-effort vs sibling). Importa `escrowIdl` de `src/chains/escrow-idl.ts` (lectura). | (nuevo, ver §4.3) | AC-2, AC-3 |
| `contracts/canonical-hash.ts` | Crear | Helper test-scope: `canonicalJson(obj)` (sort recursivo de keys) + `canonicalSha256(obj)`. | (nuevo, algoritmo en §4.3) | AC-2 |

#### Repo `chaski-v3` (CONSUMER) — Wave W3

| Archivo | Acción | Descripción | Exemplar | AC |
|---------|--------|-------------|----------|----|
| `contracts/vendored/corridor-fx.output.fixture.ts` | Crear | COPIA del fixture provider de FX + header AC-7 (origen `wasiai-remittance-agents/contracts/corridor-fx.output.fixture.ts`, fecha). | header IDL | AC-7 |
| `contracts/vendored/kyc-validator.output.fixture.ts` | Crear | COPIA fixture KYC + header. | header IDL | AC-7 |
| `contracts/vendored/cashout-payout.output.fixture.ts` | Crear | COPIA fixture payout + header. | header IDL | AC-7 |
| `contracts/vendored/settle-eip3009.body.fixture.ts` | Crear | COPIA fixture /settle del facilitator + header. | header IDL | AC-7 |
| `contracts/contracts.quote.test.ts` | Crear | Replay del fixture FX vendoreado contra (a) el handler `POST` de `quote/route.ts` (fetch global mockeado → upstream `{result:fixture}`, assert 200) y (b) `A2aQuoteGateway.requestQuote()` (assert no-throw). Un fixture con campo renombrado → 502 / throw (drift rojo). | `wallet.test.ts` | AC-1 |
| `contracts/contracts.payout.test.ts` | Crear | Replay del fixture payout vendoreado contra `A2aPayoutGateway.submit()` (assert no-throw). Drift → throw. | `gateways` | AC-1 |
| `contracts/contracts.kyc.test.ts` | Crear | KYC no tiene consumer en chaski-v3 (§9). Replay del fixture vendoreado contra un shape-guard test-only que espeja `KycAgentOutput`. Forward-looking; documentado. | — | AC-1 |
| `contracts/contracts.settle.test.ts` | Crear | Captura el body de `broadcastSettle(fixedInput)` (fetch mockeado) y lo compara con el fixture /settle vendoreado (`toEqual`). Drift del facilitator → mismatch rojo. | `facilitator-client.test.ts` | AC-1 |
| `contracts/golden/golden-evm.test.ts` | Crear | Los 4 golden EVM (ver §4.4). | `wallet.test.ts` + `deposit-attestation.test.ts` | AC-4 |
| `contracts/golden/eip712-transfer-with-authorization.golden.json` | Crear | Golden #1 (typed-data serializado por viem). Generado por el test (UPDATE_GOLDEN). | — | AC-4, CD-4 |
| `contracts/golden/eip3009-authorization.golden.json` | Crear | Golden #2. | — | AC-4, CD-4 |
| `contracts/golden/settle-eip3009-body.golden.json` | Crear | Golden #3 (== body que arma `broadcastSettle`). | — | AC-4, CD-4 |
| `contracts/golden/deposit-attestation.golden.txt` | Crear | Golden #4 (string `b64url.b64url`). | — | AC-4, CD-4 |
| `contracts/golden/README.md` | Crear | Documenta que los golden se GENERAN del código (`UPDATE_GOLDEN=1 npm test`), nunca a mano (CD-4). | — | CD-4 |
| `contracts/idl/canonical-hash.ts` | Crear | Igual que el helper del facilitator (duplicado por repo, DT-1). | (§4.3) | AC-2 |
| `contracts/idl/escrow-idl.hash.test.ts` | Crear | AC-2 + AC-3 para `src/infrastructure/solana/escrow-idl.ts`. | (§4.3) | AC-2, AC-3 |
| `contracts/CONTRACT-VERSIONS.md` | Crear | Tabla: por cada fixture vendoreado → repo/archivo/commit/fecha de origen (DT-1) + nota de deuda técnica (Missing Input #1). | — | DT-1, AC-7 |

### 4.2 Modelo de datos

N/A — esta HU no toca BD.

### 4.3 Mecanismo del hash del IDL (AC-2/AC-3) — **verificado en F2**

**Algoritmo canónico (idéntico en ambos repos, duplicado por DT-1):**

```
canonicalJson(v):
  - array  → "[" + join(map(canonicalJson), ",") + "]"
  - object → "{" + join(sort(keys).map(k => JSON.stringify(k)+":"+canonicalJson(v[k])), ",") + "}"
  - else   → JSON.stringify(v)
canonicalSha256(obj) = sha256_hex( utf8( canonicalJson(obj) ) )
```

**Constante pinneada (computada y verificada en F2 sobre los 3 archivos reales):**

```
ESCROW_IDL_SHA256 = "aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71"
```

- **AC-2 (Nivel 1, siempre corre)**: `canonicalSha256(escrowIdl) === ESCROW_IDL_SHA256`. `escrowIdl` se importa de la copia productiva (`src/infrastructure/solana/escrow-idl.ts` en chaski; `src/chains/escrow-idl.ts` en facilitator). Si alguien edita el objeto a mano sin re-pinnear → falla.
- **AC-3 (Nivel 2, best-effort)**: resolver el path sibling `path.resolve(process.cwd(), "../solana-programs/target/idl/escrow.json")`. `if (!existsSync(p)) it.skip(...)`. Si existe: `canonicalSha256(JSON.parse(readFileSync(p))) === ESCROW_IDL_SHA256`. Es la ÚNICA detección real de drift contra la fuente de verdad; documentar naturaleza best-effort (CI de cada repo desplegado por separado NO tiene el sibling → skip limpio).
- La constante `ESCROW_IDL_SHA256` se pinnea en AMBOS repos con el MISMO valor (los 3 archivos canonicalizan igual hoy). Si en el futuro divergen intencionalmente, se re-pinnea con un SDD explícito (no drift silencioso).
- **CD-2**: `solana-programs/target/idl/escrow.json` se LEE, jamás se escribe.

### 4.4 Golden EVM (AC-4) — 4 payloads, input FIJO determinístico

**Determinismo garantizado**: cada golden usa un input FIJO (sin `Date.now()`, sin `random`), envs stubeadas a valores fijos, y el nonce/validBefore se derivan determinísticamente. Se captura la serialización REAL del código actual (CD-4: nunca se escribe el valor esperado a mano — se genera con `UPDATE_GOLDEN=1` y se congela).

**Fixture determinístico compartido (constantes del test):**

```
REMITTANCE_ID = "rmt_fixed_0001"
QUOTE_ID      = "q_fixed_0001"
FROM          = 0xf39fd6e51aad88f6f4ce6ab8827279cffFb92266   (hardhat acct#0, checksum viem)
DEPOSIT_ADDR  = 0x1111111111111111111111111111111111111111
SEND_MINOR    = "400000000"        (400 USDC, 6 decimales — STRING, AC-5)
EXPIRES_AT    = "2030-01-01T00:00:00.000Z"  (ISO fijo, futuro → validBefore estable)
CHAIN         = default 84532 (Base Sepolia): net.eip712 = {name:"USDC",version:"2"}, usdc = resolveUsdcAddress()
DEPOSIT_SECRET = "golden-fixed-secret"
EXP            = 1893456000        (epoch seg fijo, NO Date.now())
```

| # | Payload | Cómo se captura | Golden file |
|---|---------|-----------------|-------------|
| 1 | **EIP-712 typed-data input** (domain+types+message de `signTypedData`) | Conectar `InjectedWallet` con `makeProvider()` (harness de `wallet.test.ts`); `vi.stubEnv("NEXT_PUBLIC_EIP3009_ENABLED","true")` + envs de chain fijas; `authorizePrincipal(quote, REMITTANCE_ID, {address:DEPOSIT_ADDR})`; el mock captura la call `eth_signTypedData_v4` → `params[1]` = JSON del typed-data (viem serializa bigints→decimal string). | `eip712-transfer-with-authorization.golden.json` |
| 2 | **`eip3009.authorization` serializado** | Del retorno de `authorizePrincipal()`: `result.eip3009.authorization` (objeto de strings: `value`/`validAfter`/`validBefore` decimal, `nonce` hex determinístico, `from`/`to`). `JSON.stringify`. | `eip3009-authorization.golden.json` |
| 3 | **Body `/settle` EIP-3009** | `broadcastSettle(fixedSettleInput)` con `global.fetch` mockeado que captura el `body`; el `SettleBroadcastInput` fijo usa la `authorization` del golden #2. Se compara el body parseado. **Doble uso**: este golden ES el mismo objeto que valida el contract test AC-1 /settle (§4.1 `contracts.settle.test.ts`) contra el fixture vendoreado del facilitator. | `settle-eip3009-body.golden.json` |
| 4 | **`issueDepositAttestation`** | `vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", DEPOSIT_SECRET)`; `issueDepositAttestation({remittanceId,quoteId,depositAddress,chainId,exp:EXP})` → string `b64url.b64url`. | `deposit-attestation.golden.txt` |

- **Scope OUT (DT-3)**: el envelope Solana base58 de `verifySolanaSettlement` (`facilitator-client.ts:194-209`) NO se congela (T-9 es EVM-only). El `signMessage` demo (`wallet.ts:146-149`) tampoco (no es contrato cross-repo).
- **Mecanismo de regeneración**: cada golden test, si `process.env.UPDATE_GOLDEN` está seteado, `writeFileSync` del valor generado; si no, `readFileSync` + `toEqual`/`toBe`. Primera generación: `UPDATE_GOLDEN=1 npm test`. Documentado en `golden/README.md`. (Alternativa `toMatchSnapshot` considerada y descartada: los golden explícitos bajo `contracts/` son artefactos de contrato revisables en el diff del PR — ver DT-6.)

### 4.5 Flujo AC-1 (drift detection) — happy vs drift

**Happy path (hoy, verde):**
1. Provider commitea fixture que pasa su propio `schema.parse()` / shape-assertion.
2. Dev vendorea (copia) el fixture al consumer con header AC-7.
3. Consumer replaya el fixture contra su validador → válido → test verde.

**Flujo de drift (AC-1, rojo):**
1. Provider renombra `feeUsd` → `feeUsd2` y actualiza su fixture (su shape-assertion lo FUERZA a actualizarlo).
2. Dev copia el fixture actualizado al consumer (mismo PR, DT-1).
3. `isValidQuoteResult`/`isValidQuoteShape` siguen exigiendo `feeUsd` (typeof number) → devuelven `false` sobre el fixture con `feeUsd2` → el contract test (que espera válido) **FALLA ROJO** → obliga a actualizar el consumer.
   - Para /settle: el facilitator agrega un campo requerido y actualiza su fixture; el body que arma `broadcastSettle` NO lo incluye → `toEqual` mismatch → rojo.

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-1**: CERO cambio de comportamiento runtime. Solo tests, fixtures, hashes, comentarios, docs. Ningún schema Zod, IDL o función de infra cambia lógica o shape de salida.
- **CD-4**: Los golden CAPTURAN el estado actual (2026-07-22) — se generan del código (`UPDATE_GOLDEN=1`), NUNCA se escribe el valor esperado a mano ni se ajusta el código para matchear un valor imaginado.
- **CD-6**: Todo fixture vendoreado lleva header con origen (repo/path) + fecha de sync (patrón IDL "COPIA PINNEADA, NO SE EDITA").
- **CD-8 (heredado auto-blindaje WKH-208)**: PROHIBIDO exportar un helper desde un `route.ts` de Next.js — rompe `tsc --noEmit` sobre `.next/types` (el export extra debe ser `never`). El contract test de `quote/route.ts` ejercita el validador **a través del handler `POST` exportado** (fetch global mockeado), NUNCA exportando `isValidQuoteResult`.
- **CD-9 (heredado WKH-196)**: el gate estático es `npx tsc --noEmit` COMPLETO (incluye `.next/types`) + `npm test`, NO solo `npm run build`. Los tests nuevos deben ser strict-typed (sin `any`).
- **CD-10 (heredado WKH-216)**: si algún fixture usara base58 (no debería: T-9 es EVM-only), generarlo con `bs58.encode`/`Keypair`, NUNCA a mano (el alfabeto base58 excluye `0 O I l`). Los golden EVM usan 0x-hex + decimal strings.
- **CD-11 (heredado WKH-216)**: en tests que necesiten el caso "ausente" de un param con default, usar `null` explícito, NUNCA `undefined` (usa el default).
- **CD-12**: bigint→JSON lo hace viem (typed-data) o `String()` (wallet.ts); el golden captura esa serialización. PROHIBIDO `JSON.stringify` directo sobre un bigint (TypeError).
- **AC-5**: campos on-chain nuevos → `string`/`bigint` minor-units; FIAT existente → `number` sin conversión.

### PROHIBIDO
- **CD-2**: editar `solana-programs/target/idl/escrow.json` (fuente de verdad, solo lectura).
- **CD-3**: crear paquete npm publicado o monorepo/workspace cross-repo.
- **CD-5**: tocar `chaski-v3/app/api/a2a/quote/route.ts` más allá de testear su validador vía el handler (no reescribir, no importar el Zod del agente).
- **CD-7**: incluir PII real (DNI, nombres reales) en cualquier fixture — reusar los patrones ya sanitizados de los tests existentes (Alice/Bob, legalId "12345678", sin `travelRuleData`/`legalId` en outputs).
- NO modificar ningún schema/validador/serialización existente.
- NO agregar dependencias nuevas (todo se hace con vitest + node:crypto + viem ya presentes). Excepción: si un repo provider no tiene `bs58` y un fixture lo necesitara → NO aplica (EVM-only).
- NO congelar el payload Solana base58 en golden (T-9 EVM-only).

## 6. Scope

**IN:** (ver §4.1 tabla completa) fixtures provider + vendoreados, contract tests, hash IDL (2 repos), 4 golden EVM, `CONTRACT-VERSIONS.md`, `golden/README.md`, helpers de hash test-scope.

**OUT:** cambios de producción, payload Solana golden, CI cross-repo real, fix de WKH-208, tocar `solana-programs/`, npm/monorepo compartido.

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Exportar el validador desde `route.ts` rompe `tsc` (.next/types) | M | A | CD-8: testear vía el handler `POST`, sin exportar. Verificado como error recurrente (WKH-208). |
| Golden no determinístico (usa fecha/random real) | B | A | §4.4 fija TODOS los inputs (EXP, EXPIRES_AT, nonce derivado, envs stubeadas). Sin `Date.now()`. |
| El fixture provider y el vendoreado divergen en distinto PR (drift silencioso) | M | M | DT-1 + `CONTRACT-VERSIONS.md` + deuda técnica explícita (Missing Input #1, §9). Limitación conocida, no bloqueante. |
| viem cambia la serialización del typed-data en un bump → golden #1 falla | B | B | Es EXACTAMENTE lo que el golden debe cazar; se re-pinnea con revisión consciente (`UPDATE_GOLDEN`). |
| El hash canónico difiere entre repos por implementación distinta del helper | B | M | Algoritmo pinneado byte-a-byte en §4.3 (mismo código duplicado); constante verificada en F2 sobre los 3 archivos reales. |
| KYC sin consumer real en chaski-v3 → contract test poco significativo | B | B | §9: anchor provider-side + shape-guard test-only forward-looking, documentado. |

## 8. Dependencias

- Vitest ya instalado en los 3 repos (verificado). `node:crypto`, `viem`, `zod` ya presentes.
- Los valores de fixture provienen de los tests existentes (DT-5) — sin datos inventados.
- W3 (chaski, vendoreados) consume los VALORES de W1/W2; el SDD provee esos valores canónicos → W1/W2/W3 pueden correr en paralelo (ver §11).

## 9. Missing Inputs — resueltos en F2

| # | Tema | Resolución (F2) |
|---|------|-----------------|
| #1 | Drift-detection semi-manual (sin CI cross-repo) | **Se documenta como deuda técnica explícita.** Crear ticket follow-up `WKH-TBD: CI cross-repo drift trigger` (GitHub Action `repository_dispatch` provider→consumers, o paquete npm privado). Se registra en `contracts/CONTRACT-VERSIONS.md` como limitación conocida. NO se implementa aquí (CD-3, fuera de scope/timeline). |
| #2 | ¿1 Story File monolítico o N por repo? | **3 Story Files paralelos**, uno por repo (`wasiai-remittance-agents` W1, `wasiai-facilitator` W2, `chaski-v3` W3), compartiendo este SDD. Son deploys independientes sin archivos en común → paralelismo natural de Dev. El SDD provee los valores canónicos de fixture (§4.4, §4.3, DT-5) para que W3 no bloquee esperando a W1/W2. |
| — | KYC sin consumer en chaski-v3 | Verificado en F2: `remit-kyc-validator` NO se invoca desde `chaski-v3` (el KYC va por Didit `/api/kyc/*`). Resolución: anchor **provider-side** (fixture + shape-assert en `wasiai-remittance-agents`) + fixture vendoreado en chaski con un **shape-guard test-only** (espeja `KycAgentOutput`), marcado forward-looking en `CONTRACT-VERSIONS.md`. Se mantiene simetría con los otros 2 contratos sin inventar un consumer productivo. |

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| (ninguno) | — | Todos los TBD/NEEDS-CLARIFICATION del work-item resueltos en §9 y §4. | No |

> No hay `[NEEDS CLARIFICATION]` pendientes. El SDD está listo para SPEC_APPROVED.

## 11. Waves de Implementación

### Wave 0 (Serial Gate — compartido, lo consume el Story File de cada repo)
- [ ] W0.1: Fijar el algoritmo canónico de hash (§4.3) y la constante `ESCROW_IDL_SHA256 = aa53c03f…fb71` (ya verificada en F2).
- [ ] W0.2: Fijar el fixture determinístico compartido de los golden (§4.4) y los INPUT canónicos de agentes (DT-5, de los tests existentes).

### Wave 1 (Paralelizable — repo `wasiai-remittance-agents`, PROVIDER)
- [ ] W1.1: `contracts/*.output.fixture.ts` + `inputs.fixture.ts` (reusar `validInput` de cada test) → Exemplar: `corridor-fx.test.ts`.
- [ ] W1.2: `contracts/contracts.provider.test.ts` (input `parse()` OK + output shape-assert) → Exemplar: `core.schemas.solana.test.ts`.

### Wave 2 (Paralelizable — repo `wasiai-facilitator`, PROVIDER)
- [ ] W2.1: `contracts/settle-eip3009.body.fixture.ts` + `contracts/contracts.provider.test.ts` (`VerifyRequestSchema.parse` OK + drift `.safeParse` false).
- [ ] W2.2: `contracts/canonical-hash.ts` + `src/chains/escrow-idl.hash.test.ts` (AC-2 + AC-3 best-effort).

### Wave 3 (Paralelizable — repo `chaski-v3`, CONSUMER; usa valores de W0/W1/W2)
- [ ] W3.1: `contracts/vendored/*.fixture.ts` (copias con header AC-7) + `CONTRACT-VERSIONS.md`.
- [ ] W3.2: `contracts.quote.test.ts` / `contracts.payout.test.ts` / `contracts.kyc.test.ts` / `contracts.settle.test.ts` (replay AC-1) → Exemplar: `wallet.test.ts`, `gateways`, `facilitator-client.test.ts`.
- [ ] W3.3: `contracts/golden/golden-evm.test.ts` + 4 golden files + `golden/README.md` (AC-4). Generar con `UPDATE_GOLDEN=1`.
- [ ] W3.4: `contracts/idl/canonical-hash.ts` + `escrow-idl.hash.test.ts` (AC-2 + AC-3 para la copia de chaski).

### Dependencias
| Tarea | Depende de | Razón |
|-------|-----------|-------|
| W3.1 | W1.1, W2.1 (valores) | Los vendoreados copian los fixtures provider; los valores están en el SDD → soft-dep, no bloquea. |
| W3.2 | W3.1 | Los replay tests consumen los fixtures vendoreados. |
| Todas | W0 | Constante de hash + fixture determinístico compartido. |

> W1, W2, W3 son repos distintos sin archivos compartidos → **fully parallel** (3 Story Files).

## 12. Test Plan

| Test | AC | Wave | Framework | Repo |
|------|----|----|-----------|------|
| `contracts.provider.test.ts` (input parse + output shape) | AC-1 | W1.2 | vitest | remittance-agents |
| `contracts.provider.test.ts` (schema accept + drift reject) | AC-1 | W2.1 | vitest | facilitator |
| `escrow-idl.hash.test.ts` | AC-2, AC-3 | W2.2 | vitest + node:crypto | facilitator |
| `contracts.quote.test.ts` (POST handler + gateway replay) | AC-1 | W3.2 | vitest | chaski-v3 |
| `contracts.payout.test.ts` | AC-1 | W3.2 | vitest | chaski-v3 |
| `contracts.kyc.test.ts` (shape-guard forward-looking) | AC-1 | W3.2 | vitest | chaski-v3 |
| `contracts.settle.test.ts` (broadcastSettle body vs fixture) | AC-1 | W3.2 | vitest | chaski-v3 |
| `golden-evm.test.ts` (4 payloads) | AC-4 | W3.3 | vitest | chaski-v3 |
| `escrow-idl.hash.test.ts` (chaski) | AC-2, AC-3 | W3.4 | vitest + node:crypto | chaski-v3 |
| Suite existente completa de los 3 repos | AC-6 | todas | vitest | 3 repos |

> Verificación por wave: `npx tsc --noEmit` COMPLETO (CD-9) + `npm test` (suite completa, AC-6 en verde) en cada repo.

## 13. Verificación Incremental

| Wave | Verificación al completar |
|------|---------------------------|
| W0 | Algoritmo + constante fijados (ya verificado en F2). |
| W1 | `tsc --noEmit` + `npm test` (remittance-agents) verde. |
| W2 | `tsc --noEmit` + `npm test` (facilitator) verde; hash test corre AC-2, skip/pass AC-3. |
| W3 | `tsc --noEmit` COMPLETO (con `.next/types`) + `npm test` (chaski) verde; golden generados y congelados; AC-6 100% previo en verde. |

## 14. Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene al menos 1 archivo asociado en tabla 4.1 (AC-1→contract tests; AC-2/3→hash tests; AC-4→golden; AC-5→fixtures tipados; AC-6→suite; AC-7→headers)
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read/Glob (wallet.test.ts, deposit-attestation.test.ts, core.schemas.solana.test.ts, corridor-fx.test.ts, header IDL)
[x] No hay [NEEDS CLARIFICATION] pendientes (§10)
[x] Constraint Directives incluyen >3 PROHIBIDO (CD-2,3,5,7 + lista)
[x] Context Map tiene >2 archivos leídos (14 archivos reales + 3 IDL)
[x] Scope IN y OUT explícitos y no ambiguos
[x] BD: N/A (no toca persistencia) — declarado
[x] Flujo principal (AC-1 happy) completo (§4.5)
[x] Flujo de error (AC-1 drift → rojo) definido (§4.5)
[x] Hash IDL verificado en F2: los 3 archivos canonicalizan a aa53c03f…fb71
[x] Golden determinísticos: todos los inputs fijos (§4.4), sin Date.now/random
```

## 15. Decisiones técnicas (heredadas + F2)

- **DT-1** (heredado): `contracts/` DUPLICADO por repo (fixtures vendoreados), NO paquete npm. Drift-detection dentro de una sesión de cambio (AC-1); limitación cross-sesión → Missing Input #1.
- **DT-2** (heredado): hash IDL en 2 niveles (local vs pinned = AC-2 siempre; sibling = AC-3 best-effort).
- **DT-3** (heredado): 4 payloads EVM golden, ni más ni menos (Solana base58 y `signMessage` demo excluidos).
- **DT-4** (heredado): FIAT (`amountUsd`/`feeUsd`/`rate`/`netDeliveredLocal`) queda `number`; on-chain (uint256/u64) queda `string`. WKH-196 no aplica a FIAT. Esta HU no reabre la discusión ni convierte nada.
- **DT-5** (heredado): fixtures de agentes generados de los inputs REALES de los tests existentes (`validInput` de cada `*.test.ts`), no inventados.
- **DT-6** (F2): golden como archivos explícitos bajo `contracts/golden/` + regeneración `UPDATE_GOLDEN=1`, en vez de `toMatchSnapshot`. Razón: los golden son artefactos de CONTRATO revisables en el diff del PR (bajo `contracts/`), no snapshots ocultos en `__snapshots__/`; y el repo no tiene infra de snapshots hoy.
- **DT-7** (F2): el output de los agentes NO tiene schema Zod (solo interface TS `CorridorFxOutput`/`KycAgentOutput`/`CashoutPayoutOutput`) → el anchor provider-side del OUTPUT es una **shape-assertion** (keys + `typeof` por campo) contra lo que `run*()` devuelve HOY, no un `schema.parse()`. Los INPUT sí tienen Zod → `*InputSchema.parse()`.
- **DT-8** (F2): el contract test de `quote/route.ts` ejercita `isValidQuoteResult` **a través del handler `POST`** (fetch global mockeado), nunca exportándolo (CD-8, evita romper `tsc` sobre `.next/types`).

---

*SDD generado por NexusAgil — FULL — WKH-227 / HU-SOL-24*
