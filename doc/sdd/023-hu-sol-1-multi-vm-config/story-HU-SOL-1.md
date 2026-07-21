# Story File — #023: [WKH-206 / HU-SOL-1] Config de red multi-VM (EVM + Solana)

> SDD: `/home/ferdev/.openclaw/workspace/chaski-v3/doc/sdd/023-hu-sol-1-multi-vm-config/sdd.md`
> Work Item: `/home/ferdev/.openclaw/workspace/chaski-v3/doc/sdd/023-hu-sol-1-multi-vm-config/work-item.md`
> Fecha: 2026-07-21
> Branch: `feat/023-hu-sol-1-multi-vm-config`
> Repo: `/home/ferdev/.openclaw/workspace/chaski-v3`

---

## Goal

Generalizar la capa de config de red (`chain.ts`) y el contrato de autorización (`ports.ts`) de
"EVM-only" a "multi-VM" (`vm: 'evm' | 'solana'`), agregando una entrada Solana **devnet** configurable
por env, **sin tocar un solo byte del path EVM vivo** (EIP-3009 / Base Sepolia / Base mainnet). Esta HU
es SOLO config + tipos + tests: NO agrega wallet Solana, ni firma SPL, ni settle Solana (eso es
HU-SOL-2 / HU-SOL-4). El discriminador `vm` se selecciona por una env **nueva y ortogonal**
`NEXT_PUBLIC_VM` (default `'evm'`) — `NEXT_PUBLIC_CHAIN_ID` conserva su semántica EVM 100% intacta.

---

## 🛑 Anti-Hallucination Header (LEER ANTES DE TOCAR CÓDIGO)

### Rutas absolutas exactas (Scope IN — SOLO estos 5 archivos)
| # | Path absoluto | Acción |
|---|---------------|--------|
| 1 | `/home/ferdev/.openclaw/workspace/chaski-v3/package.json` | Modificar (agregar 1 dep) |
| 2 | `/home/ferdev/.openclaw/workspace/chaski-v3/src/application/ports.ts` | Modificar (agregar tipos, NO tocar `Eip3009Authorization`) |
| 3 | `/home/ferdev/.openclaw/workspace/chaski-v3/src/infrastructure/chain.ts` | Modificar (agregar símbolos Solana + dispatcher) |
| 4 | `/home/ferdev/.openclaw/workspace/chaski-v3/src/infrastructure/chain.test.ts` | Modificar (AGREGAR describe Solana; NO tocar los 13 existentes) |
| 5 | `/home/ferdev/.openclaw/workspace/chaski-v3/.env.example` | Modificar (agregar 3 comentarios de env) |

`package-lock.json` cambia automáticamente al correr `npm install @solana/web3.js` — es esperado.

### Baseline VERDE obligatorio (correr ANTES de empezar W0)
```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
npm install
npm run qa
```
**Debe dar: `tsc --noEmit` = 0 errores + `vitest run` = 553 tests PASS / 48 files.**
Si el baseline NO está verde → PARAR y escalar. No se implementa sobre un árbol rojo.

### ⚖️ REGLA DE ORO (CD-1 / CD-SDD-9) — la más importante de esta HU
> Si en cualquier momento un **test EVM existente** (`chain.test.ts` 13 tests, `wallet.test.ts`,
> `confirm-and-send.test.ts`, `confirm-and-send.reorder.test.ts`, `http-settlement-gateway.test.ts`, o
> CUALQUIER otro de los 553) **cambia su expectativa** (`expect(...)`, fixture, valor esperado) para
> que la HU compile o pase → **PARAR Y ESCALAR AL ARQUITECTO**. Eso es señal de abstracción mal
> diseñada. NUNCA editar un `expect` existente para "arreglar" la compilación.

### Los 5 símbolos NUEVOS que vas a crear (nombres exactos — no inventar otros)
En `ports.ts`: `EvmAuthorization`, `SolanaAuthorization`, `VmAuthorization`.
En `chain.ts`: `SolanaNetworkConfig`, `VmNetworkConfig`, `EvmNetworkConfig` (alias), `resolveActiveVm`,
`resolveSolanaNetworkConfig`, `resolveSolanaUsdcMint`, `resolveSolanaRpcUrl`, `resolveActiveNetworkConfig`.

### Lo que está PROHIBIDO en TODA la HU (CD-3 / CD-SDD-7 / CD-SDD-8)
- ❌ NO tocar `src/infrastructure/wallet.ts` (money-path, consumidor #1).
- ❌ NO tocar `src/infrastructure/settlement/http-settlement-gateway.ts` (money-path, consumidor #2).
- ❌ NO tocar `src/infrastructure/settlement/facilitator-client.ts` (money-path, consumidor #3).
- ❌ NO tocar `src/application/use-cases/confirm-and-send.ts` ni las rutas `app/api/settle/principal/route.ts`, `app/api/a2a/payout/submit/route.ts`.
- ❌ NO tocar `src/test-support/fakes.ts`.
- ❌ NO agregar NINGÚN campo a `Eip3009Authorization` (ni `vm`, ni nada). El discriminador vive en la envoltura.
- ❌ NO cambiar firma NI cuerpo de: `resolveChainId`, `resolveChain`, `resolveNetworkConfig`, `resolveRpcUrl`, `resolveUsdcAddress`, `resolveReceiverAddress`.
- ❌ NO usar `isAddress` de viem para validar addresses Solana (CD-2). NO usar `PublicKey` para EVM.
- ❌ NO setear/encender ninguna env Solana con valor real en `.env.example` (quedan vacías — CD-5).
- ❌ NO crear la carpeta `src/infrastructure/solana/` (no existe, no se crea en esta HU).

---

## Acceptance Criteria (EARS — copiados del SDD/work-item aprobados)

- **AC-1 (byte-idéntico, CENTRAL):** WHILE la config activa resuelve a `vm:'evm'`, el sistema produce
  el mismo comportamiento observable de hoy en `resolveChainId/resolveChain/resolveNetworkConfig/
  resolveUsdcAddress/resolveReceiverAddress` — los 13 tests de `chain.test.ts` y todo test que consuma
  `Eip3009Authorization` pasan SIN cambio de expectativa.
- **AC-2 (config Solana resolvible):** WHEN `NEXT_PUBLIC_VM='solana'`, el sistema resuelve una config
  con variante `vm:'solana'` (cluster devnet + mint base58 + RPC env var), SIN campo `viemChain`.
- **AC-3 (validación address Solana):** el mint USDC Solana se valida con `new PublicKey(raw)` de
  `@solana/web3.js` (catch → fail-loud), NUNCA con `isAddress` de viem.
- **AC-4 (`VmAuthorization` discriminado):** `VmAuthorization` es unión con tag `vm`; la variante `evm`
  preserva EXACTAMENTE los 6 campos de `Eip3009Authorization`; la variante `solana` es placeholder de tipos.
- **AC-5 (WalletPort intacto):** ningún adapter/use-case/ruta cambia comportamiento runtime;
  `authorizePrincipal` y `PrincipalSettlementGateway.settle` operan exclusivamente con la forma EVM.
- **AC-6 (VM no soportada → fail-loud):** IF se pide resolver una VM que no es `evm` ni `solana`, THEN
  el sistema hace `throw` (nunca config parcial ni `undefined`).
- **AC-7 (typecheck/build íntegros):** `npm run typecheck` (`tsc --noEmit`, incluye tests) = 0 + `npm run build` OK.

---

## Files to Modify — resumen

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `package.json` | Modificar | `npm install @solana/web3.js` (queda en `dependencies` + lock) | (deps EVM existentes: `viem`) |
| 2 | `src/application/ports.ts` | Modificar | Agregar `EvmAuthorization`/`SolanaAuthorization`/`VmAuthorization` DESPUÉS de `Eip3009Authorization` (L132). NO tocar `Eip3009Authorization` ni sus refs. | `ports.ts:203` (`eip3009?: { authorization; signature }`) |
| 3 | `src/infrastructure/chain.ts` | Modificar | `vm:'evm'` aditivo + config Solana + 5 resolvers nuevos | `chain.ts:75-90` (resolver fail-loud), `chain.ts:62-69` (switch RPC) |
| 4 | `src/infrastructure/chain.test.ts` | Modificar | AGREGAR `describe` Solana (§ Tests). Los 13 EVM intactos. | `chain.test.ts:61-98` (asserts por campo + `afterEach`) |
| 5 | `.env.example` | Modificar | AGREGAR 3 envs Solana como comentario+valor vacío, al final del bloque chain | `.env.example:91-100` (bloque USDC EVM) |

---

## Waves (ejecutar SERIAL W0 → W1 → W2 → W3)

### Wave -1: Environment Gate (verificar antes de tocar código)
```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
npm install && npm run qa   # DEBE: typecheck 0 + 553 PASS
ls src/infrastructure/chain.ts src/infrastructure/chain.test.ts \
   src/application/ports.ts .env.example package.json   # los 5 archivos base existen
```
**Si algo falla → PARAR y reportar al orquestador. No implementar sobre entorno roto.**

---

### Wave 0 (serial — dependencia + tipos, no rompe compilación) — `package.json` + `ports.ts`

**W0.1 — Instalar la dependencia (DT-SDD-4):**
```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
npm install @solana/web3.js
```
Debe usarse `@solana/web3.js` (v1, battle-tested) — **NO** `@solana/kit` ni web3.js v2. Verificar que
queda en `dependencies` de `package.json` (no en devDeps) y que aparece en `package-lock.json`.

**W0.2 — Agregar los 3 tipos nuevos en `ports.ts`** inmediatamente DESPUÉS del cierre de
`Eip3009Authorization` (línea 132, el `}` de la interface). `Eip3009Authorization` queda **exactamente
igual** (CD-SDD-7). Bloque a insertar (tomado del SDD §2, DT-SDD-2):

```ts
// ── VmAuthorization (WKH-206 / HU-SOL-1) — andamiaje de TIPOS multi-VM ────────────
// El discriminador `vm` vive a nivel ENVELOPE { authorization, signature }, NO dentro del payload
// EIP-3009 (Eip3009Authorization se mantiene byte-idéntico: se firma EIP-712 y se serializa cruda al
// POST /api/settle/principal — meterle un campo cambiaría ese body → violación money-path CD-3/CD-SDD-7).
// Estructuralmente `EvmAuthorization` (menos el tag `vm`) == el `eip3009?:` de authorizePrincipal (L203),
// que NO se re-tipa en esta HU para preservar byte-identidad (AC-5). El wiring runtime es HU-SOL-2/SOL-4.

// Variante EVM del envelope (envuelve el payload EIP-3009 INTACTO).
export interface EvmAuthorization {
  vm: "evm";
  authorization: Eip3009Authorization;
  signature: string;
}

// Variante Solana — PLACEHOLDER DE TIPOS (DT-3). Sin lógica de firma/verificación (Scope OUT).
// Los campos pueden ajustarse en HU-SOL-2 (legacy Transaction vs VersionedTransaction). [TBD HU-SOL-2]
export interface SolanaAuthorization {
  vm: "solana";
  from: string; // base58 (PublicKey del pagador)              [TBD HU-SOL-2]
  to: string; // base58 (ATA / owner del receiver)             [TBD HU-SOL-2]
  amount: string; // base units del SPL token (uint64 decimal string, sin floats)
  recentBlockhash: string; // equivalente Solana de validAfter/validBefore [TBD HU-SOL-2]
  signature: string; // firma base58                            [TBD HU-SOL-2]
}

export type VmAuthorization = EvmAuthorization | SolanaAuthorization;
```

**PROHIBIDO en W0:** re-tipar `WalletPort.authorizePrincipal` (L197-204) o
`PrincipalSettlementGateway.settle` (L142-158). Siguen usando `Eip3009Authorization`. NO importar
`VmAuthorization` en ningún archivo runtime.

**Verificación W0:**
```bash
npm run typecheck   # 0 errores (los tipos son andamiaje, nadie los consume en runtime)
npm run test        # 553 PASS sin cambios
```

---

### Wave 1 (config multi-VM) — `chain.ts`

**W1.1 — Agregar el import de `PublicKey`** (mantener el import de viem existente L4 intacto):
```ts
import { PublicKey } from "@solana/web3.js";
```

**W1.2 — Agregar `vm: "evm"` (aditivo) a `NetworkConfig` + exportar alias `EvmNetworkConfig`**
(CD-SDD-8, solo se AGREGA el campo). En la definición de `NetworkConfig` (L12-21) agregar la línea
`vm: "evm";` (recomendado como primer campo). Luego exportar el alias:
```ts
export type EvmNetworkConfig = NetworkConfig;  // alias de compat (discriminante vm:"evm")
```

**W1.3 — Agregar `vm: "evm"` a las 2 entradas de `NETWORKS`** (L24-30 y L31-37). Ejemplo para Sepolia:
```ts
  [BASE_SEPOLIA_CHAIN_ID]: {
    vm: "evm",
    chainId: BASE_SEPOLIA_CHAIN_ID,
    // ...resto IGUAL...
  },
```
(Los 13 tests NO asertan sobre `vm` → siguen verdes. Confirmá: `chain.test.ts` nunca lee `cfg.vm`.)

**W1.4 — Definir la config Solana (SEPARADA, NO en `NETWORKS`)** (SDD §DT-SDD-3). El mint canónico es
REFERENCIA comentada; el valor real sale de env (CD-6, nunca hardcode en el resolver):
```ts
// ── Solana (WKH-206 / HU-SOL-1) — config devnet paralela, NO reemplaza EVM ────────
export interface SolanaNetworkConfig {
  vm: "solana";
  cluster: "devnet"; // única entrada en esta HU (mainnet-beta → HU-SOL-2/SOL-4)
  /** USDC devnet de Circle — REFERENCIA documentada (análogo a canonicalUsdc EVM). El mint REAL sale
   *  de resolveSolanaUsdcMint() (env-driven, CD-6). NO se hardcodea en el resolver. */
  canonicalUsdcMint: string;
  usdcMintEnvVar: "NEXT_PUBLIC_SOLANA_USDC_MINT";
  rpcEnvVar: "SOLANA_DEVNET_RPC_URL";
}
export type VmNetworkConfig = EvmNetworkConfig | SolanaNetworkConfig;

const SOLANA_DEVNET: SolanaNetworkConfig = {
  vm: "solana",
  cluster: "devnet",
  canonicalUsdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // Circle USDC devnet (REFERENCIA)
  usdcMintEnvVar: "NEXT_PUBLIC_SOLANA_USDC_MINT",
  rpcEnvVar: "SOLANA_DEVNET_RPC_URL",
};
```

**W1.5 — Agregar los 5 resolvers NUEVOS** (SDD §DT-SDD-1/3). Molde: `resolveUsdcAddress` (L75-79) para
el fail-loud, `resolveRpcUrl` (L62-69) para el switch:
```ts
/** VM activa. Env ORTOGONAL a NEXT_PUBLIC_CHAIN_ID (que sigue siendo EVM-only). unset/"" → "evm"
 *  (fail-safe default, CD-SDD-12: ningún deploy existente cambia de VM por omisión). Un valor
 *  explícito inválido → throw (fail-loud, AC-6). */
export function resolveActiveVm(): "evm" | "solana" {
  const raw = process.env.NEXT_PUBLIC_VM;
  if (!raw || raw === "evm") return "evm";
  if (raw === "solana") return "solana";
  throw new Error("unsupported_vm"); // fail-loud (AC-6)
}

/** Config de la red Solana activa (devnet, única entrada en esta HU). */
export function resolveSolanaNetworkConfig(): SolanaNetworkConfig {
  return SOLANA_DEVNET;
}

/** Mint USDC Solana — ÚNICA fuente (env NEXT_PUBLIC_SOLANA_USDC_MINT); fail-loud si falta/malformado.
 *  Valida con PublicKey de @solana/web3.js (base58), NUNCA con isAddress de viem (CD-2/CD-6). */
export function resolveSolanaUsdcMint(): string {
  const raw = process.env.NEXT_PUBLIC_SOLANA_USDC_MINT;
  if (!raw) throw new Error("solana_usdc_mint_not_configured"); // fail-loud
  try {
    new PublicKey(raw); // lanza TypeError si no es base58 válido
  } catch {
    throw new Error("solana_usdc_mint_not_configured"); // fail-loud
  }
  return raw;
}

/** RPC READ-ONLY de Solana devnet (server-only). Paralelo a resolveRpcUrl. undefined si la env no está. */
export function resolveSolanaRpcUrl(): string | undefined {
  switch (resolveSolanaNetworkConfig().rpcEnvVar) {
    case "SOLANA_DEVNET_RPC_URL":
      return process.env.SOLANA_DEVNET_RPC_URL;
  }
}

/** Dispatcher multi-VM (AC-2/AC-6). switch sobre resolveActiveVm() — sin object-injection (CD-7). */
export function resolveActiveNetworkConfig(): VmNetworkConfig {
  switch (resolveActiveVm()) {
    case "evm":
      return resolveNetworkConfig(); // reusa el resolver EVM INTACTO
    case "solana":
      return resolveSolanaNetworkConfig();
    default:
      throw new Error("unsupported_vm"); // inalcanzable (resolveActiveVm ya throwea), defensa AC-6
  }
}
```

**PROHIBIDO en W1:** tocar el cuerpo/firma de los 6 resolvers EVM (`resolveChainId`, `resolveChain`,
`resolveNetworkConfig`, `resolveRpcUrl`, `resolveUsdcAddress`, `resolveReceiverAddress`). El único
cambio a estructura existente permitido es AGREGAR `vm:"evm"` a `NetworkConfig` y a las 2 entradas.

**Verificación W1:**
```bash
npm run typecheck   # 0 errores
npm run test        # 553 PASS (chain.test.ts intacto — los 13 EVM sin tocar)
```

---

### Wave 2 (integridad de consumidores + compat) — VERIFICACIÓN, sin churn de money-path

W2 es intencionalmente **no-op de producción**. NO se edita ningún archivo. Solo se verifica que la
decisión de preservar `Eip3009Authorization` (DT-SDD-2) mantiene a los 4 consumidores de producción
y 3 de test compilando sin cambios.

**W2.1 — Confirmar consumidores intactos:**
```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
grep -rn "Eip3009Authorization" src app | grep -v "\.test\."
# Esperado (SIN cambios respecto al baseline): ports.ts (def L125 + refs L144, L203),
# wallet.ts (L4, L88, L248), http-settlement-gateway.ts (L12, L71),
# facilitator-client.ts (L19, L35), fakes.ts (L14, L255, L268, L370, L390).
```
Los 3 tests de money-path que lo consumen (`confirm-and-send.test.ts`,
`confirm-and-send.reorder.test.ts`, `http-settlement-gateway.test.ts`) deben pasar sin edición.

**PROHIBIDO en W2:** migrar cualquier import a `EvmAuthorization`, ni anotar la variante evm en el
money-path. Hacerlo cambiaría runtime/serialización → CD-3/CD-SDD-7. La decisión limpia (DT-2, opción
"mantener") es NO migrar. Si el análisis sugiere migrar → es un anti-patrón, NO hacerlo.

**Verificación W2:**
```bash
npm run typecheck   # 0
npm run test        # 553 PASS (money-path tests sin editar)
```

---

### Wave 3 (tests de la rama Solana) — `chain.test.ts`

Agregar bloques `describe` NUEVOS al final de `chain.test.ts`. **Los 13 tests EVM existentes NO se
tocan (CD-1).** Actualizar el import de la línea 2 para incluir los nuevos resolvers (agregar símbolos,
sin quitar los existentes) y agregar la limpieza de las envs Solana en el `afterEach`. Ver § Tests.

**Verificación W3 (gate de cierre):**
```bash
npm run qa      # typecheck 0 + (553 + nuevos) PASS
npm run build   # OK (AC-7)
```
Luego el **mutation self-check** (§ Mutation self-check) — obligatorio.

---

## Tests a escribir (W3) — mapeo 1:1 al plan §5 del SDD

Archivo: `src/infrastructure/chain.test.ts`. Los 13 tests EVM quedan intactos. Agregar:

**Ajuste del import (L2) y del `afterEach` (L8-11):**
```ts
import {
  resolveActiveNetworkConfig,
  resolveActiveVm,
  resolveChain,
  resolveChainId,
  resolveNetworkConfig,
  resolveSolanaUsdcMint,
  resolveUsdcAddress,
} from "./chain";
```
En `afterEach` agregar (sin quitar los deletes existentes):
```ts
  delete process.env.NEXT_PUBLIC_VM;
  delete process.env.NEXT_PUBLIC_SOLANA_USDC_MINT;
```

| AC | Test nuevo (describe/it) | Qué asserta |
|----|--------------------------|-------------|
| **AC-2** | `resolveActiveNetworkConfig — rama Solana` | Con `NEXT_PUBLIC_VM="solana"`: retorna `cfg.vm === "solana"`, `cfg.cluster === "devnet"`, `cfg.usdcMintEnvVar === "NEXT_PUBLIC_SOLANA_USDC_MINT"`, `cfg.rpcEnvVar === "SOLANA_DEVNET_RPC_URL"`, y `("viemChain" in cfg) === false`. |
| **AC-3** | `resolveSolanaUsdcMint — env-driven fail-loud` | (a) mint base58 válido (`"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"`) → devuelve el mint EXACTO; (b) env ausente → `toThrow("solana_usdc_mint_not_configured")`; (c) malformado (`"0xNOT"`) → throw; (d) address EVM `"0x036CbD53842c5426634e7929541eC2318f3dCF7e"` → RECHAZADO por el validador Solana (cruce prohibido CD-2). |
| **AC-4** | `VmAuthorization — discriminado por vm` | Type-level + assert trivial: un valor `{ vm:"evm", authorization:{from,to,value,validAfter,validBefore,nonce}, signature }` asigna a `VmAuthorization`; estrechar por `if (a.vm === "evm")` da acceso a `a.authorization.from`; assert `a.vm === "evm"`. (Importar `VmAuthorization` como `type` desde `../application/ports`.) |
| **AC-5** | `resolveActiveVm — default fail-safe` | Con `NEXT_PUBLIC_VM` unset → `resolveActiveVm() === "evm"`. (El resto de AC-5 lo cubren los tests EVM existentes que quedan verdes.) |
| **AC-6** | `resolveActiveVm / dispatcher — VM no soportada` | Con `NEXT_PUBLIC_VM="aptos"`: `resolveActiveVm()` → `toThrow("unsupported_vm")`; `resolveActiveNetworkConfig()` → `toThrow("unsupported_vm")` (propaga, nunca devuelve parcial/undefined). |

AC-1 y AC-5(runtime) = tests EXISTENTES verdes (no se escriben). AC-7 = comando (`npm run typecheck` + `npm run build`).

### Mutation self-check obligatorio (CD-SDD-9/12) — 3 mutaciones que DEBEN matar tests, luego revertir
1. En `resolveActiveVm`, cambiar el default `return "evm"` → `return "solana"` → **debe fallar** el
   test AC-5 (`resolveActiveVm — default fail-safe`). Revertir.
2. En `resolveSolanaUsdcMint`, quitar el `throw` de env ausente (que devuelva `""` en su lugar) →
   **debe fallar** el test AC-3 (env ausente). Revertir.
3. En `resolveActiveNetworkConfig`, quitar el `throw new Error("unsupported_vm")` del default (que caiga
   a `resolveNetworkConfig()`) — y en `resolveActiveVm` que un valor desconocido no throwee → **debe
   fallar** el test AC-6. Revertir.

Correr `npm run test` tras cada mutación para confirmar el rojo; revertir y confirmar verde antes de la siguiente.

---

## `.env.example` — 3 envs nuevas (CD-SDD-10: `old_string` verbatim del Read inmediato)

**Regla CD-SDD-10:** antes del `Edit`, hacer `Read` del bloque a editar y copiar el `old_string`
VERBATIM (incluida la última línea del bloque chain EVM). Las envs Solana se AGREGAN al final del
bloque chain existente, **sin reordenar** lo existente. NO setear valores reales (quedan vacías, CD-5).

Punto de inserción sugerido: después de `NEXT_PUBLIC_CHAIN_ID=` (línea 57, cierre del bloque `# ── Chain`).
Bloque a agregar:
```bash
# ── VM activa (WKH-206 / HU-SOL-1) ───────────────────────────────────────────
# Selecciona la máquina virtual de settlement. ORTOGONAL a NEXT_PUBLIC_CHAIN_ID (que sigue EVM-only).
# unset/"evm" (default fail-safe) → path EVM byte-idéntico. "solana" → rama Solana devnet (config+tipos,
# SIN wiring runtime en esta HU — HU-SOL-2/SOL-4). Cualquier otro valor → fail-loud (throw unsupported_vm).
NEXT_PUBLIC_VM=
# Mint USDC de Solana (base58). ÚNICA fuente (no se hardcodea). Canónico devnet de Circle:
# 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU. Se valida con PublicKey de @solana/web3.js; sin él →
# resolveSolanaUsdcMint() lanza solana_usdc_mint_not_configured. Es NEXT_PUBLIC (lo lee el cliente).
NEXT_PUBLIC_SOLANA_USDC_MINT=
# RPC READ-ONLY de Solana devnet (server-only, SIN NEXT_PUBLIC_). Default público sugerido:
# https://api.devnet.solana.com. Sin él → resolveSolanaRpcUrl() devuelve undefined (el caller fail-closea).
SOLANA_DEVNET_RPC_URL=
```

---

## Constraint Directives (copiados del SDD §3 — NO se relajan)

### OBLIGATORIO
- Resolver Solana replica el patrón fail-loud de `chain.ts:75-79` (`resolveUsdcAddress`), con `PublicKey` en vez de `isAddress`.
- `resolveSolanaRpcUrl` / dispatcher usan `switch` sobre unión literal (patrón `chain.ts:62-69`), NUNCA index dinámico (CD-7).
- `resolveActiveVm()` unset → `"evm"` (default fail-safe, CD-SDD-12).
- `npm run qa` COMPLETO como gate (typecheck + 553 + nuevos), no solo `build` (CD-4/CD-SDD-9).
- `old_string` verbatim del Read inmediato antes del `Edit` de `.env.example` (CD-SDD-10).
- Solo se AGREGAN símbolos; el único cambio a estructura existente = `vm:"evm"` aditivo (CD-SDD-8).

### PROHIBIDO
- Dependencia nueva: SOLO `@solana/web3.js` (v1). Ninguna otra.
- Tocar money-path: `wallet.ts`, `http-settlement-gateway.ts`, `facilitator-client.ts`, `confirm-and-send.ts`, rutas, `fakes.ts` (CD-3).
- Agregar campos a `Eip3009Authorization` (CD-SDD-7). Cambiar firma/cuerpo de los 6 resolvers EVM (CD-SDD-8).
- Cruzar validadores: `isAddress` para Solana o `PublicKey` para EVM (CD-2).
- Editar un `expect` de un test existente para compilar/pasar (CD-1 → PARAR y escalar).
- Hardcodear el mint en el resolver; encender cualquier env Solana en ambiente compartido (CD-5/CD-6).
- Crear `src/infrastructure/solana/`. Re-tipar `authorizePrincipal`/`settle` (AC-5).

---

## Definition of Done

- [ ] `npm run qa` VERDE = `tsc --noEmit` 0 errores + los 553 tests existentes PASS **sin tocar un `expect`** + los tests Solana nuevos (AC-2/AC-3/AC-4/AC-5/AC-6) PASS.
- [ ] `npm run build` OK (AC-7).
- [ ] Mutation self-check: las 3 mutaciones matan ≥1 test cada una; todas revertidas; árbol vuelve a verde.
- [ ] Los 4 consumidores de producción de `Eip3009Authorization` (`ports.ts`, `wallet.ts`, `http-settlement-gateway.ts`, `facilitator-client.ts`) + `fakes.ts` intactos (grep W2.1 idéntico al baseline).
- [ ] `@solana/web3.js` en `dependencies` de `package.json` + `package-lock.json`.
- [ ] `.env.example`: 3 envs Solana documentadas como comentario, valores vacíos (CD-5).
- [ ] Ningún archivo fuera de los 5 del Scope IN fue modificado.

---

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala al Arquitecto.** No inventar, no asumir.

Escalar SÍ o SÍ si:
- Un test EVM existente necesita cambiar su expectativa para compilar/pasar (REGLA DE ORO — CD-1).
- El baseline no arranca en verde (553 PASS / typecheck 0).
- `new PublicKey(...)` de `@solana/web3.js` no lanza con input inválido como se esperaba.
- El cambio requiere tocar un archivo fuera de los 5 del Scope IN (especialmente money-path).
- El typecheck exige re-tipar `authorizePrincipal` o `settle` (violaría AC-5).

---

*Story File generado por NexusAgil — F2.5 (Architect). WKH-206 / HU-SOL-1.*
