# SDD — [HU-SOL-1 / WKH-206] Config de red multi-VM (EVM + Solana) — fundación del port a Solana

> Fase F2 (NexusAgil QUALITY). Input: `work-item.md` (aprobado, HU_APPROVED). Repo:
> `/home/ferdev/.openclaw/workspace/chaski-v3` (Next.js, arquitectura hexagonal).
> SDD_MODE: full. Estimación: M. Branch sugerido: `feat/023-hu-sol-1-multi-vm-config`.

---

## 0. Resolución de los 2 `[NEEDS CLARIFICATION]` del work-item (CERRADOS en F2)

| # | Pregunta abierta | **Decisión F2 (firme)** | Justificación |
|---|------------------|--------------------------|---------------|
| 1 | Mecanismo de selección de VM activa: env nueva vs generalizar `NEXT_PUBLIC_CHAIN_ID` | **Env NUEVA y ORTOGONAL `NEXT_PUBLIC_VM` (`'evm' \| 'solana'`, default `'evm'`).** `NEXT_PUBLIC_CHAIN_ID` conserva su semántica EVM 100% intacta (sigue eligiendo Base Sepolia/mainnet, nunca ve un identificador Solana). Ver **DT-SDD-1**. | Es la única opción que garantiza AC-1 byte-idéntico: los 13 tests EVM leen SOLO `NEXT_PUBLIC_CHAIN_ID` y NUNCA setean `NEXT_PUBLIC_VM` → caen siempre en la rama `'evm'` con comportamiento idéntico. Solana es una rama nueva, no un reemplazo. |
| 2 | Cluster Solana objetivo: `devnet` vs `mainnet-beta` | **`devnet` únicamente en esta HU.** No se define `mainnet-beta` (lo deciden HU-SOL-2/SOL-4). | Decisión firme del founder para todo el programa Solana LATAM Labs (devnet + sandbox, cero plata real). Mismo criterio fail-safe testnet-first que Base Sepolia (DT-5 de `chain.ts:41`). |

Cero `[NEEDS CLARIFICATION]` quedan abiertos. Ver §8 Readiness Check.

---

## 1. Context Map (archivos leídos + patrón extraído)

Baseline verificado: `npm install` (741 paquetes, lockfile presente) → `npm run typecheck` = **0 errores** → `npm run test` = **553 tests / 48 files, todos PASS**. El SDD parte de un árbol verde.

| Archivo (verificado con Read) | Por qué | Patrón extraído |
|-------------------------------|---------|-----------------|
| `src/infrastructure/chain.ts:1-90` | Objetivo primario. `NetworkConfig` viem-shaped + `NETWORKS` keyed-by-chainId + resolvers env-driven fail-loud. | (a) `resolveChainId()` parsea `NEXT_PUBLIC_CHAIN_ID`, default fail-safe 84532; (b) `resolveNetworkConfig()` accede por clave literal (CD-7, sin object-injection); (c) `resolveUsdcAddress()`/`resolveReceiverAddress()` = env-driven + `isAddress` viem + `throw` fail-loud (nunca hardcode); (d) `resolveRpcUrl()` = `switch` sobre unión literal. |
| `src/application/ports.ts:125-158, 191-208` | Objetivo primario. `Eip3009Authorization` (contrato de datos EIP-3009) + sus dos referencias como tipo (`PrincipalSettlementGateway.settle`, `WalletPort.authorizePrincipal`). | El precedente "campo opcional por VM": `eip3009?: { authorization; signature }` (L203) es una envoltura `{ authorization, signature }` — el nivel natural donde vive el discriminador `vm`. |
| `src/infrastructure/chain.test.ts:1-98` (13 tests) | Guardián de AC-1/CD-1. Fixtures EVM puros. | Los tests asertan campos ESPECÍFICOS (`cfg.chainId`, `cfg.canonicalUsdc`, `cfg.eip712.name`, `cfg.rpcEnvVar`) — NUNCA `toEqual(objetoEntero)`. → agregar un campo discriminante `vm:'evm'` a la config NO rompe ningún assert. `afterEach` limpia solo `NEXT_PUBLIC_CHAIN_ID` y `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS`. |
| `src/infrastructure/wallet.ts:1-331` | Consumidor #1 de `Eip3009Authorization` + money-path EVM. **CD-3: PROHIBIDO tocar.** | La `authorization` (from/to/value/validAfter/validBefore/nonce) se construye ACÁ y se firma EIP-712 (`signTypedData`). El shape es el payload on-chain — NO puede cambiar un byte. |
| `src/infrastructure/settlement/http-settlement-gateway.ts:11-15, 69-99` | Consumidor #2 de `Eip3009Authorization`. | `JSON.stringify({ authorization: input.authorization, ... })` → serializa la authorization TAL CUAL al POST `/api/settle/principal` (money-path, Scope OUT). **Insight crítico: agregar un campo `vm` DENTRO de la authorization cambiaría el body de la ruta de settle → violación CD-3.** El `vm` debe vivir FUERA del payload EIP-3009. |
| `src/infrastructure/settlement/facilitator-client.ts:19, 35` | **Consumidor #3 (NO nombrado en el brief).** Importa `Eip3009Authorization` como tipo en `SettleBroadcastInput`. | 4º sitio real (el brief nombró 3; este es adicional). Mismo criterio: el shape se serializa al facilitador → no se toca. Confirma que la decisión de mantener `Eip3009Authorization` byte-idéntico protege también este consumidor sin churn. |
| `src/test-support/fakes.ts:12-40, 253-402` | Consumidor #4/#5 de `Eip3009Authorization` (`FakeWallet`, `FakeSettlementGateway`). | Fixtures de test que construyen `authorization` con el shape EIP-3009 puro. Si el tipo exigiera `vm`, estos fixtures romperían → violación CD-1. |
| `package.json:7-47` | DT-4 (agregar `@solana/web3.js`) + gate CD-4. | Scripts: `typecheck` = `tsc --noEmit`; `test` = `vitest run`; `qa` = `typecheck && test`. **`@solana/web3.js` AUSENTE hoy** (ni deps ni devDeps; `node_modules/@solana/` vacío tras install limpio → la transitiva NO persiste, confirma el grounding). |
| `.env.example:55-124` | CD-6 (documentar envs nuevas como comentario). | Bloque EVM chain/RPC/USDC: `NEXT_PUBLIC_CHAIN_ID`, `BASE_SEPOLIA_RPC_URL`, `BASE_MAINNET_RPC_URL`, `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS`. Patrón: comentario documenta el valor canónico, la env queda vacía. |
| `doc/sdd/020…/auto-blindaje.md`, `022…/auto-blindaje.md` | Aprendizaje histórico (últimas HUs DONE). | Ver §2.1 (CD heredados de errores recurrentes). |

**Grep de cobertura total de consumidores de `Eip3009Authorization`** (verificado): `ports.ts` (def + 2 refs), `wallet.ts` (2), `http-settlement-gateway.ts` (1), `facilitator-client.ts` (1), `fakes.ts` (3) + tests (`confirm-and-send.test.ts`, `confirm-and-send.reorder.test.ts`, `http-settlement-gateway.test.ts`). **Total: 4 archivos de producción + 3 de test.** Ninguno debe cambiar (ver DT-SDD-2).

---

## 2. Decisiones técnicas (DT-SDD-N) — mapeo a DT-1..4 del work-item

### DT-SDD-1 — Selección de VM: env ortogonal `NEXT_PUBLIC_VM` (resuelve DT-1, `[NC#1]`, AC-1/AC-2/AC-6)
Nueva función `resolveActiveVm(): 'evm' | 'solana'` que lee `NEXT_PUBLIC_VM`:
- unset / `""` → `'evm'` (**fail-safe default**, byte-idéntico: los tests EVM nunca la setean).
- `"evm"` → `'evm'`; `"solana"` → `'solana'`.
- cualquier otro valor explícito (ej. `"aptos"`) → **`throw new Error("unsupported_vm")`** (fail-loud AC-6).

`NEXT_PUBLIC_CHAIN_ID` **NO se toca ni se re-interpreta**: sigue siendo EVM-only (solo 8453/84532). Esto es lo que preserva AC-1: `resolveChainId()`, `resolveChain()`, `resolveNetworkConfig()`, `resolveUsdcAddress()`, `resolveReceiverAddress()` **conservan firma y cuerpo idénticos** — no reciben un branch de VM adentro. La conmutación de VM vive en un dispatcher NUEVO y separado (DT-SDD-3).

Justifica la diferencia de política fail-safe vs fail-loud: dentro de EVM, un `CHAIN_ID` basura cae a testnet (seguro). Pero un `NEXT_PUBLIC_VM` explícito e inválido es un intento de seleccionar una VM inexistente → correr EVM en silencio sería sorprendente y peligroso → AC-6 exige fail-loud.

### DT-SDD-2 — `VmAuthorization` discrimina a nivel ENVELOPE, no a nivel campo EIP-3009 (resuelve DT-2/DT-3, `[resuelto en F2]`, AC-4/AC-5, CD-1/CD-3)
`Eip3009Authorization` (from/to/value/validAfter/validBefore/nonce) **se mantiene EXACTAMENTE como hoy** — es el payload que se firma EIP-712 y se serializa al `/api/settle/principal` y al facilitador. **Se conserva como interface exportada (compat alias, opción "mantener" de DT-2).**

`VmAuthorization` es una **unión discriminada NUEVA a nivel de la envoltura** `{ authorization, signature }` (el mismo nivel del campo `eip3009?:` de `WalletPort.authorizePrincipal:203`):

```ts
// El payload EIP-3009 — INTACTO (wire shape, se firma y se serializa a la ruta de settle).
export interface Eip3009Authorization {
  from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string;
}

// Variante EVM del envelope de autorización (envuelve el payload intacto).
export interface EvmAuthorization {
  vm: 'evm';
  authorization: Eip3009Authorization;
  signature: string;
}

// Variante Solana — PLACEHOLDER DE TIPOS (DT-3). Sin lógica de firma/verificación (Scope OUT).
// Shape mínimo coherente con Solana; los campos pueden ajustarse en HU-SOL-2 (legacy Transaction vs
// VersionedTransaction). Marcado [TBD HU-SOL-2] en comentario.
export interface SolanaAuthorization {
  vm: 'solana';
  from: string;      // base58 (PublicKey del pagador)   [TBD HU-SOL-2]
  to: string;        // base58 (ATA / owner del receiver) [TBD HU-SOL-2]
  amount: string;    // base units del SPL token (uint64 decimal string, sin floats)
  recentBlockhash: string; // equivalente Solana de validAfter/validBefore [TBD HU-SOL-2]
  signature: string; // firma base58 [TBD HU-SOL-2]
}

export type VmAuthorization = EvmAuthorization | SolanaAuthorization;
```

**Por qué envelope y NO `{ vm:'evm' } & Eip3009Authorization`:** el insight de `http-settlement-gateway.ts:89` — la authorization se `JSON.stringify`ea cruda al body de `/api/settle/principal`. Meter `vm` DENTRO de `Eip3009Authorization` cambiaría ese JSON y podría hacer que la ruta (money-path, Scope OUT/CD-3) valide distinto → violación CD-3 de runtime. El discriminador `vm` en la envoltura NO toca el payload firmado.

**AC-5 (WalletPort intacto):** `VmAuthorization` es andamiaje de TIPOS puro en esta HU. NINGÚN adapter, use-case ni ruta lo consume en runtime. `WalletPort.authorizePrincipal` sigue retornando `eip3009?: { authorization: Eip3009Authorization; signature: string }` **sin cambios** (su shape es idéntico a `EvmAuthorization` menos el tag, y NO se re-tipa para preservar byte-identidad; la equivalencia estructural queda documentada en comentario). HU-SOL-2/SOL-4 harán el wiring real.

### DT-SDD-3 — Estructura de config multi-VM: resolvers EVM intactos + rama Solana paralela (resuelve DT-1, AC-1/AC-2)
`NetworkConfig` gana un discriminante `vm: 'evm'` (renombrado conceptualmente `EvmNetworkConfig`, **se exporta `NetworkConfig` como alias de compat**). Las 2 entradas de `NETWORKS` agregan `vm: 'evm'` (los 13 tests no asertan sobre `vm` → siguen verdes, patrón extraído en §1).

Config Solana NUEVA y SEPARADA (no se fuerza un `chainId: number` sintético — DT-1):
```ts
export interface SolanaNetworkConfig {
  vm: 'solana';
  cluster: 'devnet';                    // única entrada en esta HU (DT-2 §0)
  canonicalUsdcMint: string;            // REFERENCIA base58 documentada (análogo a canonicalUsdc EVM);
                                        // el mint REAL sale de env (resolveSolanaUsdcMint), NO se hardcodea
  usdcMintEnvVar: 'NEXT_PUBLIC_SOLANA_USDC_MINT';
  rpcEnvVar: 'SOLANA_DEVNET_RPC_URL';
}
export type VmNetworkConfig = EvmNetworkConfig | SolanaNetworkConfig;
```

Resolvers (los EVM NO cambian firma ni cuerpo):
- `resolveNetworkConfig(): NetworkConfig` → **INTACTO** (EVM-only, byte-idéntico; sigue leyendo `resolveChainId()`).
- `resolveSolanaNetworkConfig(): SolanaNetworkConfig` → NUEVO (devnet, la única entrada).
- `resolveSolanaUsdcMint(): string` → NUEVO. Lee `process.env.NEXT_PUBLIC_SOLANA_USDC_MINT`; valida con `new PublicKey(raw)` en try/catch → `throw new Error("solana_usdc_mint_not_configured")` fail-loud (AC-3/CD-2/CD-6). NUNCA `isAddress` de viem.
- `resolveActiveNetworkConfig(): VmNetworkConfig` → NUEVO **dispatcher** (AC-2/AC-6): `switch (resolveActiveVm())` → `'evm'` reusa `resolveNetworkConfig()`; `'solana'` → `resolveSolanaNetworkConfig()`; `default` inalcanzable pero incluye `throw new Error("unsupported_vm")` (defensa AC-6, coherente con el fail-loud de `resolveActiveVm`).
- `resolveSolanaRpcUrl(): string | undefined` → NUEVO (paralelo a `resolveRpcUrl`; lee `SOLANA_DEVNET_RPC_URL`).

### DT-SDD-4 — `@solana/web3.js` como dependencia real (resuelve DT-4, AC-3, CD-2)
Se agrega `@solana/web3.js` (v1, battle-tested; **NO `@solana/kit`/web3.js v2**) a `dependencies` de `package.json`. Se usa SOLO para `PublicKey` (validación base58, análogo a viem del lado EVM — patrón "derivado de la lib", CD-9). API confirmada: `new PublicKey(base58)` lanza `TypeError` con input inválido → try/catch → fail-loud. El Dev corre `npm install @solana/web3.js` (queda en el lockfile). El toolchain solana-cli (3.1.10) NO es dependencia de build — irrelevante para esta HU.

### 2.1 CD heredados de errores recurrentes (Auto-Blindaje histórico)
Leídos `020…/auto-blindaje.md` (WKH-209) y `022…/auto-blindaje.md` (WKH-211), últimas HUs DONE. Patrones aplicables incorporados como CD-SDD (abajo):
- **WKH-211 W1**: tipos de dominio NO se re-exportan desde `ports.ts` → importarlos de `domain/*`. → **CD-SDD-11**. (Relevante: el placeholder Solana usa `string`, no tipos de dominio, así que el riesgo es bajo, pero se documenta.)
- **WKH-209 / WKH-211 W6**: `npm run qa` COMPLETO (typecheck+test, 553) + mutation self-check, no solo `build`. → refuerza CD-4 (ya en work-item) y **CD-SDD-9**.
- **WKH-209 W1.3**: `old_string` verbatim del Read inmediato antes de un `Edit` sobre prosa (`.env.example`). → **CD-SDD-10** (aplica al Edit de `.env.example`).
- **WKH-211 W2**: volver obligatorio un binding rompe tests viejos por orden de guards. → aquí el imperativo es el INVERSO: **NADA nuevo puede volverse obligatorio en el path EVM** (CD-1). Se cita como anti-patrón a NO repetir.

---

## 3. Constraint Directives (CD-SDD-N) — heredados del work-item + específicos F2

Heredados del work-item (VINCULANTES, sin cambios): **CD-1** (EVM byte-idéntico — la más crítica), **CD-2** (validador por VM: `PublicKey` para Solana, `isAddress` para EVM, nunca cruzados), **CD-3** (PROHIBIDO tocar `wallet.ts`/`confirm-and-send.ts`/`settle/principal/route.ts`/`submit/route.ts` — money-path), **CD-4** (`npm run typecheck` completo, no solo build), **CD-5** (sin flag/env que active runtime Solana en ambiente compartido), **CD-6** (sin hardcode de mint/address; env-driven fail-loud, `.env.example` documenta canónico como comentario).

Específicos del SDD:
- **CD-SDD-7 (crítico, refuerza CD-1/CD-3):** el payload `Eip3009Authorization` (from/to/value/validAfter/validBefore/nonce) es **inmutable**. PROHIBIDO agregarle campos, incluido `vm`. El discriminador vive en la envoltura `VmAuthorization`. Cualquier PR que agregue un campo a `Eip3009Authorization` cambia el body serializado a `/api/settle/principal` → BLOQUEANTE.
- **CD-SDD-8:** PROHIBIDO cambiar la firma o el cuerpo de `resolveChainId`, `resolveChain`, `resolveNetworkConfig`, `resolveRpcUrl`, `resolveUsdcAddress`, `resolveReceiverAddress`. Sólo se AGREGAN símbolos nuevos (Solana + dispatcher). El único cambio tolerado en las estructuras existentes es AGREGAR el campo `vm: 'evm'` a `NetworkConfig` y a las 2 entradas de `NETWORKS` (aditivo, verificado no-breaking para los 13 tests).
- **CD-SDD-9:** gate de cierre = `npm run qa` (typecheck + los 553 tests EXISTENTES verdes SIN tocar un `expect`) + los tests Solana NUEVOS. Si un test EVM necesita cambiar una expectativa para compilar → **parar y escalar** (señal de abstracción mal diseñada, CD-1).
- **CD-SDD-10:** al editar `.env.example`, copiar el `old_string` verbatim del Read inmediato (lección WKH-209 W1.3). Las envs nuevas se AGREGAN al final del bloque chain, sin reordenar el existente.
- **CD-SDD-11:** el placeholder Solana usa tipos primitivos (`string`); si en el futuro usa un tipo de dominio, importarlo de `domain/*`, NUNCA de `ports.ts` (no re-exporta — lección WKH-211 W1).
- **CD-SDD-12:** `resolveActiveVm()` con `NEXT_PUBLIC_VM` unset DEBE devolver `'evm'` (default fail-safe). Un test debe blindar esto (mutación: default → 'solana' debe matar un test). Esto garantiza que ningún deploy existente cambie de VM por omisión (refuerza CD-5).

---

## 4. Waves de implementación

Cada wave es verificable de forma independiente (`npm run typecheck` verde al cierre de cada una; W3 agrega tests).

### W0 (serial — contratos/tipos, no rompe compilación) — `package.json` + `ports.ts`
1. `npm install @solana/web3.js` (DT-SDD-4) → queda en `dependencies` + lockfile.
2. En `ports.ts`: agregar `EvmAuthorization`, `SolanaAuthorization` (placeholder `[TBD HU-SOL-2]`), `VmAuthorization` (DT-SDD-2). **`Eip3009Authorization` se mantiene tal cual** (CD-SDD-7). NO se re-tipa `WalletPort.authorizePrincipal` ni `PrincipalSettlementGateway.settle` (AC-5, byte-idéntico). Comentario que documenta la equivalencia estructural evm-variant ↔ `eip3009?`.
- **Verificación W0:** `npm run typecheck` = 0 errores (nada consume la unión en runtime; es andamiaje de tipos). `npm run test` = 553 PASS sin cambios.

### W1 (config multi-VM) — `chain.ts`
1. Agregar `import { PublicKey } from "@solana/web3.js"` (mantener el `import { type Chain, isAddress } from "viem"` intacto).
2. Agregar `vm: 'evm'` a `NetworkConfig` (+ export alias) y a las 2 entradas `NETWORKS` (CD-SDD-8, aditivo).
3. Definir `SolanaNetworkConfig`, `VmNetworkConfig`, la constante de config devnet (con `canonicalUsdcMint` como REFERENCIA comentada, valor real por env).
4. `resolveActiveVm()` (DT-SDD-1, fail-safe 'evm' / fail-loud AC-6), `resolveSolanaNetworkConfig()`, `resolveSolanaUsdcMint()` (`PublicKey`, fail-loud, CD-2/CD-6), `resolveSolanaRpcUrl()`, `resolveActiveNetworkConfig()` dispatcher (AC-2/AC-6).
5. **NO tocar** los 6 resolvers EVM existentes (CD-SDD-8).
- **Verificación W1:** `npm run typecheck` = 0 errores. `npm run test` = 553 PASS (chain.test.ts intacto).

### W2 (integridad de consumidores + compat) — verificación, sin churn de money-path
1. Confirmar que los **4 consumidores de producción** de `Eip3009Authorization` (`wallet.ts`, `http-settlement-gateway.ts`, `facilitator-client.ts`, + las refs en `ports.ts`) y los 3 de test (`fakes.ts`, `confirm-and-send*.test.ts`, `http-settlement-gateway.test.ts`) **compilan sin cambios** gracias a que `Eip3009Authorization` se preservó (DT-SDD-2, opción compat de DT-2).
2. NO se migra ningún import ni se anota `EvmAuthorization` en el money-path (hacerlo cambiaría runtime/serialización → CD-3/CD-SDD-7). `Eip3009Authorization` QUEDA como alias exportado — es la decisión explícita de DT-2.
- **Verificación W2:** `grep -rn "Eip3009Authorization" src app` muestra los mismos consumidores intactos; `npm run typecheck` = 0; los tests de money-path (`confirm-and-send*`, `http-settlement-gateway.test`) PASS sin edición.
> Nota: W2 es intencionalmente "no-op de producción". El brief sugería "migrar los 3 imports a la variante evm"; el análisis F2 demostró que migrarlos VIOLARÍA CD-3 (serialización a la ruta de settle). La decisión limpia que preserva AC-1 es NO migrarlos y mantener `Eip3009Authorization`. Se documenta explícitamente para el clinical review.

### W3 (tests de la rama Solana) — `chain.test.ts` (+ opcional `ports` type-test)
Agregar tests NUEVOS (los 13 EVM NO se tocan — CD-1). Ver §5. Cierre con `npm run qa`.
- **Verificación W3:** `npm run qa` = typecheck 0 + (553 + nuevos) PASS. Mutation self-check de los guards nuevos (CD-SDD-9/12).

**Orden:** W0 → W1 → W2 → W3 (serial; W1 depende de la dep de W0; W3 depende de W1). Sin paralelismo interno (una sola HU fundacional).

---

## 5. Plan de tests (≥1 por AC)

Archivo de tests nuevos: `src/infrastructure/chain.test.ts` (agregar `describe` bloques Solana; los existentes intactos). Opcional: un type-level test en `chain.test.ts` para `VmAuthorization`.

| AC | Cobertura de test | Nuevo / Existente |
|----|-------------------|-------------------|
| **AC-1** (byte-idéntico, CENTRAL) | Los **13 tests EVM de `chain.test.ts` corren SIN cambio de expectativa** + los tests de money-path que consumen `Eip3009Authorization` (`confirm-and-send.test.ts`, `confirm-and-send.reorder.test.ts`, `http-settlement-gateway.test.ts`, `wallet.test.ts`) siguen verdes. **Gate: `npm run test` = 553 PASS sin editar un `expect`.** | Existentes (NO se tocan) |
| **AC-2** (config Solana resolvible) | `NEXT_PUBLIC_VM='solana'` → `resolveActiveNetworkConfig()` retorna variante `vm:'solana'` con `cluster:'devnet'`, `usdcMintEnvVar`, `rpcEnvVar`, SIN campo `viemChain`. `resolveSolanaUsdcMint()` con env válida (mint base58 devnet) devuelve el mint exacto. | Nuevo |
| **AC-3** (validación address Solana) | `resolveSolanaUsdcMint()`: env base58 válida → OK; env ausente → `throw solana_usdc_mint_not_configured`; env malformada (ej. `"0xNOT"` o base58 inválido) → `throw` (via `PublicKey`, NO `isAddress`). Test extra: un address EVM `0x...` es RECHAZADO por el validador Solana (CD-2 cruce prohibido). | Nuevo |
| **AC-4** (`VmAuthorization` discriminado) | Type-level: un valor `{ vm:'evm', authorization:{...}, signature }` asigna a `VmAuthorization` y estrecha por `vm`; la variante `evm` contiene un `Eip3009Authorization` con los MISMOS 6 campos/formatos. (Test de compilación + assert trivial sobre el tag.) | Nuevo |
| **AC-5** (WalletPort intacto) | Cubierto por AC-1: `wallet.test.ts` (24 tests) + `confirm-and-send*` PASS sin cambios → ningún adapter cambia runtime. Assert explícito: `resolveActiveVm()` default = `'evm'`. | Existentes + 1 nuevo |
| **AC-6** (VM no soportada → fail-loud) | `NEXT_PUBLIC_VM='aptos'` → `resolveActiveVm()` **throws** `unsupported_vm`; `resolveActiveNetworkConfig()` propaga el throw (NUNCA devuelve config parcial/undefined). | Nuevo |
| **AC-7** (typecheck/build íntegros) | Gate CI: `npm run typecheck` (`tsc --noEmit`, incluye tests — lección WKH-196) = 0 errores + `npm run build` sin errores. | Comando (no test unit) |

**Mutation self-check obligatorio (CD-SDD-9/12):** ≥3 mutaciones que deben matar ≥1 test cada una, luego revertidas:
1. `resolveActiveVm()` default `'evm'` → `'solana'` → mata el test AC-5/CD-SDD-12.
2. `resolveSolanaUsdcMint()` quitar el `throw` fail-loud (env ausente devuelve `""`) → mata AC-3.
3. dispatcher AC-6: quitar el `throw unsupported_vm` (default cae a evm) → mata AC-6.

`.env.example`: documentar `NEXT_PUBLIC_VM` (default `evm`), `NEXT_PUBLIC_SOLANA_USDC_MINT` (con el mint devnet canónico de Circle como comentario, valor vacío), `SOLANA_DEVNET_RPC_URL` (comentario: `https://api.devnet.solana.com` por default público). Sin activar nada (CD-5).

---

## 6. Exemplars verificados (paths confirmados con Read/Glob)

| Patrón a seguir | Exemplar (verificado) |
|-----------------|-----------------------|
| Resolver env-driven + validación de lib + `throw` fail-loud | `src/infrastructure/chain.ts:75-90` (`resolveUsdcAddress`/`resolveReceiverAddress` con `isAddress` viem) → el resolver Solana lo replica con `PublicKey`. |
| `switch` sobre unión literal para RPC | `src/infrastructure/chain.ts:62-69` (`resolveRpcUrl`) → molde de `resolveSolanaRpcUrl` y del dispatcher. |
| Unión discriminada como generalización de un campo opcional | `src/application/ports.ts:203` (`eip3009?: { authorization; signature }`) → nivel exacto del envelope `VmAuthorization`. |
| Tests de config env-driven (set/`afterEach` cleanup, asserts por campo) | `src/infrastructure/chain.test.ts:8-11, 61-98` → molde de los `describe` Solana nuevos. |
| Documentar env nueva como comentario + valor canónico | `.env.example:91-100, 120-123` (bloque USDC/RPC EVM) → molde del bloque Solana. |
| Config keyed sin object-injection (acceso literal) | `src/infrastructure/chain.ts:48-53` (CD-7) → el dispatcher usa `switch`, no index dinámico. |

Todos los paths existen (verificados en esta sesión con Read). `src/infrastructure/solana/` NO existe (grounding negativo confirmado) — esta HU NO crea esa carpeta (config vive en `chain.ts`, tipos en `ports.ts`).

---

## 7. Cobertura DT/CD del work-item → decisiones SDD

| Work-item | Resuelto en |
|-----------|-------------|
| DT-1 (indexación Solana sin chainId numérico) | DT-SDD-3 (config Solana separada keyed por cluster; `NETWORKS` EVM intacto) |
| DT-2 (`VmAuthorization` unión; ¿alias o no?) | DT-SDD-2 (unión a nivel envelope; **`Eip3009Authorization` se MANTIENE como alias compat**) |
| DT-3 (shape placeholder Solana, `[TBD]` ok) | DT-SDD-2 (`SolanaAuthorization` con campos `[TBD HU-SOL-2]`) |
| DT-4 (`@solana/web3.js` v1) | DT-SDD-4 |
| CD-1 (EVM byte-idéntico) | DT-SDD-1/2/3 + CD-SDD-7/8/9; resolvers EVM y payload EIP-3009 intactos; 13 tests + 540 restantes sin tocar |
| CD-2 (validador por VM, no cruzado) | DT-SDD-3/4 (`PublicKey` Solana / `isAddress` EVM); test AC-3 cubre el cruce prohibido |
| CD-3 (no tocar money-path) | CD-SDD-7 (payload inmutable) + W2 no-op; `wallet.ts`/`confirm-and-send.ts`/rutas NO se tocan |
| CD-4 (typecheck completo) | CD-SDD-9 (`npm run qa`) + AC-7 |
| CD-5 (sin flag runtime Solana) | DT-SDD-1 default `'evm'` + CD-SDD-12; envs Solana quedan vacías/inertes |
| CD-6 (sin hardcode) | DT-SDD-3 (`resolveSolanaUsdcMint` env-driven, canónico solo comentario) |

---

## 8. Readiness Check (F2)

- [x] Work-item leído completo (7 ACs, DT-1..4, CD-1..6, Scope IN/OUT, grounding).
- [x] Baseline verificado en verde: `npm install` OK, `npm run typecheck` = 0 errores, `npm run test` = 553 PASS / 48 files.
- [x] Todos los exemplars verificados con Read (paths reales, §6).
- [x] Los 4 consumidores de producción de `Eip3009Authorization` mapeados (incluye `facilitator-client.ts`, NO nombrado en el brief) + 3 de test.
- [x] Mecanismo de selección de VM decidido y justificado (DT-SDD-1, `NEXT_PUBLIC_VM` ortogonal) — preserva AC-1.
- [x] Cluster objetivo cerrado: `devnet` únicamente.
- [x] `VmAuthorization`: nivel envelope decidido con justificación anti-CD-3 (payload EIP-3009 inmutable).
- [x] Waves W0-W3 con verificación independiente por wave.
- [x] Test plan ≥1 por AC (AC-1..7) + mutation self-check + gate `npm run qa`.
- [x] CD del work-item (CD-1..6) heredados + 6 CD-SDD específicos (incluye lecciones de auto-blindaje WKH-209/211).
- [x] **Cero `[NEEDS CLARIFICATION]` abiertos** (los 2 cerrados en §0).

### No blockers
No hay TBDs bloqueantes. El único `[TBD]` remanente es el shape fino de la variante `solana` de `VmAuthorization` (DT-SDD-2), que es **intencionalmente diferido a HU-SOL-2** por el propio work-item (DT-3) — es un placeholder de tipos sin impacto runtime, no un bloqueante de esta HU. **SDD listo para SPEC_APPROVED → F2.5 (Story File) → F3.**
