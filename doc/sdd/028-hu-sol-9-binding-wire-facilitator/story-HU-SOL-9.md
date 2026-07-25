# Story File — HU-SOL-9 / WKH-208 · Wave W4 (facilitator schema Zod)

> NexusAgil QUALITY · F2.5 · derivado de `sdd.md` (SPEC_APPROVED, regenerado 2026-07-22 — CD-4 levantada)
> **Único trabajo ejecutable en F3 = Wave W4** en el repo `wasiai-facilitator`.
> El lado **chaski-v3 YA ESTÁ MERGEADO** (commit `a177825`) — es **contrato/exemplar de referencia, NO se re-implementa.**
> Repo de trabajo: `/home/ferdev/.openclaw/workspace/wasiai-facilitator`

---

## 0. Contexto mínimo (leer antes de tocar nada)

El money-path Solana no-custodial de Chaski construye un envelope x402 `solana:<cluster>` en **base58** (no
`0x`-hex) y lo manda al **mismo** `POST /settle` del facilitator que ya usa EVM. Ese código chaski
(`facilitator-client.ts::verifySolanaSettlement`, ya mergeado y unit-tested con mocks) **NO es HTTP-reachable
e2e** porque el gate Zod del facilitator lo rechaza con `400 INVALID_PAYLOAD` **antes** de llegar al dispatch por
namespace.

**Por qué se rechaza (mecanismo confirmado end-to-end):**

```
routes/settle.ts → SettleRequestSchema.safeParse(body)
  → SettleRequestSchema === VerifyRequestSchema (alias, core/schemas.ts:157)
  → z.union([Eip3009RequestSchema, NonEip3009RequestSchema])
  → AMBAS ramas exigen accepted.asset / accepted.payTo = AddressHexSchema  (/^0x…{40}$/)
  → un body base58 falla el gate → 400 INVALID_PAYLOAD
  → core/settle.ts (dispatch namespace==='solana', :43) es INALCANZABLE
```

El adaptador Solana (`src/chains/solana-adapter.ts`) está completo y unit-tested pero **nunca recibe el
request** hasta que el schema lo deje pasar.

**Qué es el `z.union` HOY** (`src/core/schemas.ts:143`):

```ts
export const VerifyRequestSchema = z.union([Eip3009RequestSchema, NonEip3009RequestSchema]);
export const SettleRequestSchema = VerifyRequestSchema; // alias (L157)
```

Ambas ramas heredan `accepted.asset`/`accepted.payTo` = `AddressHexSchema` desde `AcceptedSchema`
(`core/schemas.ts:60-70`). Los primitivos (`AddressHexSchema`, `Uint256StringSchema`, etc.) viven en
`src/methods/eip3009/schemas.ts` (boundary OWNERS explícito, comentado en `core/schemas.ts:13-15`).

**El trabajo de W4:** agregar una **TERCERA rama** al `z.union` (`SolanaRequestSchema`) que representa el request
Solana base58 **sin tocar ni un byte de las 2 ramas EVM**. `z.union` prueba ramas en orden y devuelve la primera
que matchea → un body EVM sigue matcheando rama 1/2 **exactamente como hoy**; agregar una 3ª rama al final nunca
cambia el `.success` de un input que ya matcheaba ni de uno que fallaba las 2 primeras.

**Nota anti-confusión (crítica):** existe OTRO `AcceptedSchema` en `src/methods/eip3009/schemas.ts:73-80`
(`.passthrough()`, method-local, hot-path). **ESE NO es el gate HTTP.** El gate HTTP es el `AcceptedSchema` de
`src/core/schemas.ts:60`. No confundir ni tocar el method-local.

---

## 1. Scope IN — archivos a tocar (exhaustivo)

| # | Archivo (en `wasiai-facilitator/`) | Acción |
|---|-----------------------------------|--------|
| 1 | `src/methods/eip3009/schemas.ts` | **+2 primitivos** `Base58PubkeySchema` + `Base58SignatureSchema` (aditivo puro; nada existente se modifica) |
| 2 | `src/core/schemas.ts` | **+3 schemas** `SolanaAcceptedSchema` + `SolanaPayloadSchema` + `SolanaRequestSchema`; agregar 3ª rama al `z.union`. Las 2 ramas EVM y `AcceptedSchema`/`PayloadSchema` **sin tocar**. `SettleRequestSchema` hereda por alias (no se edita) |
| 3 | `src/__tests__/unit/core.schemas.solana.test.ts` (NUEVO) | Tests TF1-TF3 (suite Solana wire + regresión unit) |
| 4 | `src/__tests__/unit/routes.settle.solana.test.ts` (NUEVO) | Test TF4 (integración: el body Solana ya no da 400, alcanza `settleCore`) |

**Ubicación de tests confirmada:** los tests del facilitator viven en `src/__tests__/unit/` (ej.
`core.schemas.discriminated.test.ts`, `routes.settle.test.ts`). Seguí esa convención de naming/carpeta.

---

## 2. ⛔ Scope OUT / PROHIBIDO (CD-4' — resto del facilitator INTOCABLE)

**NO tocar ningún otro archivo del facilitator.** En particular PROHIBIDO editar:
- `src/chains/solana-adapter.ts` (y cualquier `src/chains/*`)
- `src/core/settle.ts`, `src/core/verify.ts`
- `src/routes/*` (settle.ts, verify.ts, etc.)
- `src/infra/*`; `src/methods/*` salvo los 2 primitivos aditivos de `eip3009/schemas.ts`
- registry, migraciones (`003_facilitator_solana_dedup.sql`), config, env
- Las 2 ramas EVM del union, `AcceptedSchema`/`PayloadSchema` de `core/schemas.ts`, y el `AcceptedSchema`
  method-local de `eip3009/schemas.ts`

**NO** re-implementar nada del lado chaski-v3 (ya mergeado en `a177825`). **NO** encender flags ni registrar el
adapter Solana. **NO** implementar broadcast/release/PoP (HU-SOL-13/14/8, fuera de scope).

---

## 3. Anti-Hallucination Checklist (verificá con Read/Glob antes de codear)

- [ ] `src/core/schemas.ts:143` — el `z.union([Eip3009RequestSchema, NonEip3009RequestSchema])` existe tal cual.
- [ ] `src/core/schemas.ts:60-70` — `AcceptedSchema` con `asset`/`payTo` = `AddressHexSchema`, `.strict()`.
- [ ] `src/core/schemas.ts:157` — `SettleRequestSchema = VerifyRequestSchema` (alias). NO editar esta línea.
- [ ] `src/core/schemas.ts:38` — `ResourceSchema` exportado (lo reusás en `SolanaRequestSchema`).
- [ ] `src/methods/eip3009/schemas.ts` — existen `AddressHexSchema`, `Uint256StringSchema`,
      `Eip3009AuthorizationSchema`. **NO** existe ningún `Base58*Schema` (lo agregás vos).
- [ ] `src/chains/solana-adapter.ts:48` — `BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/`.
- [ ] `src/chains/solana-adapter.ts:93-107` — `isBase58Pubkey` (`new PublicKey` try/catch) e
      `isBase58Signature` (`BASE58_RE.test && len ∈ [64,120]`). Tu Zod debe usar EL MISMO criterio (CD-9).
- [ ] `src/chains/solana-adapter.ts:142-196` — `_parseSolanaInput` lee exactamente
      `accepted.{network,asset,payTo,amount}` + `payload.{signature,reference?}`. **NO** lee `extra`.
- [ ] `@solana/web3.js` ya es dependencia de `package.json` (importable: `import { PublicKey } from '@solana/web3.js'`).
- [ ] Tests en `src/__tests__/unit/` — mirá `core.schemas.discriminated.test.ts` como plantilla de estilo/imports
      (fixture `EIP3009_BODY`, `import { VerifyRequestSchema, SettleRequestSchema } from '../../core/schemas.js'`).

---

## 4. Shape base58 EXACTO que espera `_parseSolanaInput` (el contrato de la 3ª rama)

Copiado del SDD §4.4 (confirmado leyendo `solana-adapter.ts:142-196`). El schema nuevo debe representar
EXACTAMENTE esto — ni más estricto, ni más laxo — y matchea 1:1 lo que `verifySolanaSettlement` (chaski) ya envía:

| Campo | Validación del adapter | Primitivo Zod a usar |
|-------|------------------------|----------------------|
| `accepted.scheme` | (no leído; chaski envía `"exact"`) | `z.literal('exact')` |
| `accepted.network` | `string` (core valida `/^solana:(devnet\|mainnet)$/` después) | `z.string().regex(/^solana:(devnet\|mainnet)$/u)` |
| `accepted.amount` | `BigInt(...)` parseable | `Uint256StringSchema` (u64 ⊂ uint256 — reusar el primitivo existente) |
| `accepted.asset` (mint) | `isBase58Pubkey` (`new PublicKey`) | `Base58PubkeySchema` |
| `accepted.payTo` | `isBase58Pubkey` | `Base58PubkeySchema` |
| `accepted.maxTimeoutSeconds` | (no leído; chaski envía `60`) | `z.number().int().positive()` |
| `payload.signature` | `isBase58Signature` (`BASE58_RE` + len 64-120) | `Base58SignatureSchema` |
| `payload.reference` | opcional; si string no-vacío ⇒ `isBase58Pubkey` | `Base58PubkeySchema.optional()` |

**NO hay `extra` en el request Solana** — el dispatch solana hace early-return antes del check
`assetTransferMethod` y chaski no lo envía. El `SolanaAcceptedSchema` NO exige `extra` y con `.strict()` lo
rechaza si aparece (correcto).

---

## 5. Implementación — orden EXACTO

### W4.1 — Primitivos base58 (`src/methods/eip3009/schemas.ts`, aditivo puro)

Agregar al final del archivo (respeta el boundary OWNERS "primitivos acá, no duplicar en core"):

```ts
import { PublicKey } from '@solana/web3.js';

/** base58 pubkey (32-byte) — MISMO criterio que solana-adapter.ts::isBase58Pubkey. */
export const Base58PubkeySchema = z
  .string()
  .refine((s) => {
    try { new PublicKey(s); return true; } catch { return false; }
  }, 'must be a base58 pubkey');

/** base58 tx signature — MISMO criterio que solana-adapter.ts::isBase58Signature. */
export const Base58SignatureSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/u, 'base58')
  .refine((s) => s.length >= 64 && s.length <= 120, 'solana signature length');
```

> Nota `[NO bloqueante · F3]`: el SDD recomienda `eip3009/schemas.ts` (mínimo cambio, sin archivo nuevo). Si
> aparece un conflicto de naming/lint, se permite `src/methods/solana/schemas.ts` — decisión menor, ambas
> respetan CD-4'. Preferí la ubicación recomendada.

### W4.2 — 3ª rama del union (`src/core/schemas.ts`, las 2 ramas EVM SIN TOCAR)

Extender el import existente y agregar los 3 schemas + la 3ª rama:

```ts
import {
  AddressHexSchema,
  Uint256StringSchema,
  Eip3009AuthorizationSchema,
  Base58PubkeySchema,        // + nuevo
  Base58SignatureSchema,     // + nuevo
} from '../methods/eip3009/schemas.js';

const SolanaAcceptedSchema = z.object({
  scheme: z.literal('exact'),
  network: z.string().regex(/^solana:(devnet|mainnet)$/u, 'network must be solana:<devnet|mainnet>'),
  amount: Uint256StringSchema,            // u64 ⊂ uint256 — reusa el primitivo existente
  asset: Base58PubkeySchema,              // mint base58 (NO 0x-hex)
  payTo: Base58PubkeySchema,              // beneficiary base58 (NO 0x-hex)
  maxTimeoutSeconds: z.number().int().positive(),
}).strict();                              // sin `extra`: el adapter no lo lee y chaski no lo envía

const SolanaPayloadSchema = z.object({
  signature: Base58SignatureSchema,       // tx sig finalizada (NO 0x-hex, NO objeto authorization)
  reference: Base58PubkeySchema.optional(),
}).strict();

const SolanaRequestSchema = z.object({
  x402Version: z.literal(2),
  resource: ResourceSchema,
  accepted: SolanaAcceptedSchema,
  payload: SolanaPayloadSchema,
}).strict();
```

Y cambiar SOLO la línea del union (agregar la 3ª rama **al final**, después de las 2 EVM — orden crítico para
byte-identidad):

```ts
export const VerifyRequestSchema = z.union([
  Eip3009RequestSchema,
  NonEip3009RequestSchema,
  SolanaRequestSchema,        // + 3ª rama (última — no altera el match de bodies EVM)
]);
// SettleRequestSchema = VerifyRequestSchema (alias existente L157) — NO editar; hereda la 3ª rama.
```

**Por qué es EVM byte-idéntico (CD-1):** `z.union` devuelve la primera rama que matchea; un body EVM matchea
rama 1/2 igual que hoy. Las definiciones de `Eip3009RequestSchema`/`NonEip3009RequestSchema`/`AcceptedSchema`/
`PayloadSchema` NO se editan. La 3ª rama va **última**.

**Watch de mensaje de error (§4.5 SDD):** un body que hoy falla con un issue específico de rama EVM podría
cambiar el TEXTO agregado del error del `z.union` (no el `.success`). Esto solo importa si algún test EVM assertea
el string exacto de `safeParse().error`. TF2 debe revisar esos asserts. El contrato HTTP observable
(`400 INVALID_PAYLOAD` opaco) no cambia porque `routes/settle.ts` mapea cualquier fallo Zod al mismo error.

---

## 6. Tests requeridos (TF1-TF4)

### `src/__tests__/unit/core.schemas.solana.test.ts` (NUEVO)

**Fixture:** copiá como base el objeto literal que `verifySolanaSettlement` construye (contrato T4 chaski):
`{ x402Version:2, resource:{url,...}, accepted:{ scheme:'exact', network:'solana:devnet', amount:'<u64>',
asset:'<base58 mint>', payTo:'<base58>', maxTimeoutSeconds:60 }, payload:{ signature:'<base58 sig 64-120>',
reference?:'<base58>' } }`. Usá pubkeys base58 **reales/válidas** (32-byte) — p.ej. generá con `PublicKey` o usá
el mint USDC devnet conocido; la signature: un base58 de longitud ∈ [64,120].

- **TF1 (AC-3, e2e-reachability):** un body Solana (base58 `asset`/`payTo`, `payload.signature` base58) **PASA**
  `SettleRequestSchema.safeParse` y matchea `SolanaRequestSchema`. Cubrí **con y sin** `reference`. Verificá tanto
  `VerifyRequestSchema` como el alias `SettleRequestSchema`.
- **TF2 (AC-2 cross-repo, regresión):** un body EVM (`EIP3009_BODY`, reusá el de
  `core.schemas.discriminated.test.ts`) sigue matcheando rama 1; un body permit2 sigue matcheando rama 2; un body
  con `asset`/`payTo` base58 dentro de una rama EVM sigue **rechazado**. Si algún test EVM existente assertea el
  string exacto del error de `safeParse`, verificá que no cambió (§5 watch).
- **TF3 (fail-closed, negativos Solana):** cada uno debe FALLAR el parse:
  - `network: 'solana:mainnet-beta'` y `network: 'eip155:2368'` → falla el regex
  - `asset: '0x' + '11'.repeat(20)` (hex) y `asset: 'Il0O'` (chars fuera del alfabeto base58) → falla
  - `signature` de longitud < 64 → falla
  - `extra: {...}` presente en `accepted` → `.strict()` falla
  - `x402Version: '2'` (string) → `z.literal(2)` falla

### `src/__tests__/unit/routes.settle.solana.test.ts` (NUEVO)

- **TF4 (AC-3, integración):** POST al route `/settle` con el body Solana **YA NO** devuelve `400
  INVALID_PAYLOAD`; alcanza `settleCore` con dispatch `namespace==='solana'` → con el adapter Solana
  **no-registrado** (default: `SOLANA_RPC_URL`/`SOLANA_USDC_MINT` ausentes) responde `CHAIN_UNAVAILABLE`. Esto
  prueba que el gate Zod se pasó **sin encender el adapter** (CD-6). Mirá `routes.settle.test.ts` como plantilla
  de cómo montar el route de test (Fastify inject).

> El adapter Solana NO debe registrarse en el test. `CHAIN_UNAVAILABLE` (no `400`) es exactamente la evidencia de
> que el Zod dejó pasar el body y el dispatch por namespace se ejecutó.

---

## 7. Comandos de verificación (Done Definition)

Ejecutar en `wasiai-facilitator/`:

```bash
npx tsc --noEmit        # o `npm run typecheck` — COMPLETO, incluye tests (CD-12)
npm test                # vitest run — suite COMPLETA
```

**Criterios de PASS:**
- `npx tsc --noEmit` COMPLETO en verde (CD-12: el gate es el typecheck completo, NO solo `npm run build`).
- `npm test`: **todos los tests EVM preexistentes siguen verdes con las MISMAS assertions**. Corré `npm test`
  ANTES de empezar para registrar el número verde exacto de baseline y compararlo después (SDD lo cita como ~979
  casos EVM byte-idénticos; el número real es el que reporte tu baseline — ninguno debe romperse).
- Los tests nuevos TF1-TF4 pasan.
- `git diff` acotado a los 4 archivos (2 schema + 2 test nuevos), cero cambios fuera de scope (CD-4').

---

## 8. Constraint Directives aplicables

- **CD-1** — EVM byte-idéntico sobre el facilitator: **ningún test EVM cambia su assertion**; los ~979 tests EVM
  quedan verdes. Las 2 ramas EVM del union y `AcceptedSchema`/`PayloadSchema` no se editan.
- **CD-4 [enmendada]** — el facilitator entra en scope **SOLO** para `src/core/schemas.ts` +
  `src/methods/eip3009/schemas.ts` (primitivos base58) + sus tests.
- **CD-4'** — PROHIBIDO tocar cualquier OTRO archivo del facilitator (adapter, core dispatch, routes, infra,
  registry, migraciones). Fix aditivo, cero cambios a las 2 ramas EVM.
- **CD-6** — PROHIBIDO encender flags (`SOLANA_RPC_URL`/`SOLANA_USDC_MINT` del facilitator, `NEXT_PUBLIC_*`).
  Relajar el schema NO enciende el adapter (queda `null`/no-registrado ⇒ `CHAIN_UNAVAILABLE`). Todo dark/aditivo.
- **CD-9** — `Base58PubkeySchema`/`Base58SignatureSchema` usan el MISMO criterio que `_parseSolanaInput`
  (`new PublicKey` / `BASE58_RE` + len 64-120): lo que pasa el Zod pasa el parse del adapter (sin doble-estándar).
- **CD-10 (Auto-Blindaje SOL-7)** — identidad Solana sobre forma canónica case-sensitive; NUNCA
  `.toLowerCase()`/normalización ad-hoc sobre base58 (aplica al criterio de los primitivos: no lowercasear).
- **CD-12 (Auto-Blindaje SOL-5 / WKH-196)** — el gate de tipos es `npx tsc --noEmit` / `npm run typecheck`
  COMPLETO (incluye tests), no solo `npm run build`. Correr también `npm test` completo.

---

## 9. Done Definition (W4)

- [ ] `Base58PubkeySchema` + `Base58SignatureSchema` agregados en `eip3009/schemas.ts` (aditivo puro).
- [ ] `SolanaAcceptedSchema` + `SolanaPayloadSchema` + `SolanaRequestSchema` agregados en `core/schemas.ts`.
- [ ] 3ª rama en el `z.union` **al final**; 2 ramas EVM y `AcceptedSchema`/`PayloadSchema` sin tocar;
      `SettleRequestSchema` alias sin editar.
- [ ] TF1-TF4 escritos en `core.schemas.solana.test.ts` + `routes.settle.solana.test.ts`.
- [ ] `npx tsc --noEmit` COMPLETO verde.
- [ ] `npm test` verde: EVM byte-idénticos (mismo count baseline, mismas assertions) + TF nuevos en verde.
- [ ] `git diff` limitado a 4 archivos. Cero cambios fuera de scope (CD-4').

---

## 10. Fuera de F3-dev (documentado, NO ejecutar)

- **W4.4 (founder-gated):** merge a `main` del facilitator + deploy Railway + registrar adapter Solana
  (`SOLANA_RPC_URL`/`SOLANA_USDC_MINT`) + migración `003` — junto con el merge de HU-SOL-6 HELD. La
  e2e-reachability real depende de esto; W4.1-W4.3 (schema + tests) son válidos y verdes sin ese deploy.
- **chaski-v3 (Waves W0-W3):** YA MERGEADO en `a177825`. NO se re-implementa. Documentado en `sdd.md` §7 como
  contrato/exemplar verificado (`deposit-attestation.ts`, `facilitator-client.ts::verifySolanaSettlement`,
  `address.ts::addressEqualsVm`, routes VM-branch + sus tests T1-T7).
