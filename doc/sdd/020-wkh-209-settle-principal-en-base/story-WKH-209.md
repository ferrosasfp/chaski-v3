# Story File — #020: [WKH-209] Mover el settlement del principal de Chaski de Avalanche a Base

> SDD: doc/sdd/020-wkh-209-settle-principal-en-base/sdd.md
> Work Item: doc/sdd/020-wkh-209-settle-principal-en-base/work-item.md
> Fecha: 2026-07-17
> Branch: feat/020-settle-principal-base
> Gate del repo: `npm run qa` (= `tsc --noEmit` + `vitest run`). Baseline actual: **36 test files, 451 tests verdes**.

---

## Goal

Swap del settlement del **principal** (EIP-3009, WKH-168) de **Avalanche → Base**, parametrizado por red
(Base Sepolia 84532 testnet / Base mainnet 8453). El founder decidió Base porque TransFi (payout, WKH-208)
liquida USDC en Base, no en Avalanche. Es un cambio de **config/parametrización**, NO de lógica de dominio:
guard-order, atestación, PoP y ledger quedan intactos. La firma real sigue **OFF** por default
(`NEXT_PUBLIC_EIP3009_ENABLED` no se toca): esta HU **construye la config correcta**, no enciende el settle.

**El corazón de la HU** (bug latente que se corrige): el domain EIP-712 está hardcodeado `name:"USD Coin"`
en `wallet.ts:97,242` para AMBAS redes. El USDC de **Base Sepolia** usa `name="USDC"` (verificado on-chain,
`wasiai-facilitator/src/chains/base.ts:46-53`); solo Base mainnet usa `"USD Coin"`. Si el `name` no matchea
el `DOMAIN_SEPARATOR` del contrato, la firma es inválida → el facilitator rechaza el settle. Por eso el
`name`/`version` del domain se parametriza por red, igual que la USDC.

**Todo se valida contra Base Sepolia testnet — CERO plata real, JAMÁS mainnet (CD-1/AC-9).**

---

## Acceptance Criteria (EARS) — copiados del SDD aprobado

- **AC-1**: `NEXT_PUBLIC_CHAIN_ID="84532"` → `resolveChainId()===84532`, `resolveChain().id===84532` (`baseSepolia`).
- **AC-2**: `="8453"` → `resolveChainId()===8453`, `resolveChain().id===8453` (`base`).
- **AC-3**: ausente / no reconocido (`"99"`, `"abc"`, `"43113"`, `"43114"`) → default fail-safe **84532** (Base Sepolia). NUNCA Avalanche, NUNCA 8453.
- **AC-4**: firma (flag ON) contra Base Sepolia → `domain.name==="USDC"`, `version==="2"`, `domain.chainId===84532`.
- **AC-5**: firma contra Base mainnet → `domain.name==="USD Coin"`, `version==="2"`, `domain.chainId===8453`.
- **AC-6**: `onchain-verifier` lee el receipt vía un RPC de **Base** (`resolveRpcUrl()`), NUNCA `AVALANCHE_RPC_URL`.
- **AC-7**: `NETWORKS[84532].canonicalUsdc` y `NETWORKS[8453].canonicalUsdc` matchean el facilitator; `resolveUsdcAddress()` sigue env-driven fail-loud.
- **AC-8**: con `NEXT_PUBLIC_EIP3009_ENABLED` OFF → **byte-idéntico a hoy** (demo intacto, `personal_sign`).
- **AC-9**: settle real e2e SOLO contra Base Sepolia (84532); PROHIBIDO mainnet / fondos reales.
- **AC-10**: principal-in y payout (WKH-208 USDCBASE) en la MISMA red (Base) por construcción (`domain.chainId === resolveChainId()`).
- **AC-11**: env de Base faltante/malformada → fail-closed (RPC ausente → `settle_unverified`; USDC/receiver malformado → throw).

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Wave |
|---|---------|--------|-----------|------|
| 1 | `src/infrastructure/chain.ts` | Modificar | Núcleo del swap: tabla `NetworkConfig`/`NETWORKS` + `resolveChainId`/`resolveNetworkConfig`/`resolveChain`/`resolveRpcUrl`. Ver §Contrato exacto. | W0 |
| 2 | `src/infrastructure/chain.test.ts` | Modificar (reescribir) | Contrato de `chain.ts` a Base (AC-1/2/3/7/11). MISMA wave que #1 (CD-12). | W0 |
| 3 | `src/infrastructure/wallet.ts` | Modificar | Domain por red en `:97` y `:242` (`resolveNetworkConfig().eip712`). Comentario "Avalanche" en `:184` → "Base". Rama OFF (`:126-131`, `:270-275`) NO se toca. | W1.1 |
| 4 | `src/infrastructure/wallet.test.ts` | Modificar | AC-4/AC-5/AC-8/AC-10. `CHAIN_MAINNET_HEX` → hex de Base 8453 (`0x2105`). | W1.1 |
| 5 | `src/infrastructure/settlement/onchain-verifier.ts` | Modificar | Solo `:59`: `process.env.AVALANCHE_RPC_URL` → `resolveRpcUrl()` (import de `../chain`). Rama `if (!rpc)` V1 sin cambio. | W1.2 |
| 6 | `src/infrastructure/settlement/onchain-verifier.test.ts` | Modificar | AC-6 (incl. killer test) + AC-11. Stub `BASE_SEPOLIA_RPC_URL` + chainId "84532" + USDC Sepolia. | W1.2 |
| 7 | `.env.example` | Modificar | Bloques Chain (`:51-56`), USDC (`:90-97`), Settlement RPC (`:117`) → Base (ids 84532/8453, USDC canónicas, `BASE_SEPOLIA_RPC_URL`/`BASE_MAINNET_RPC_URL`, default 84532). | W1.3 |
| 8 | `src/presentation/flow.tsx` | Modificar | `:536` label `"en Avalanche"` → data-driven de la red configurada (ver §Wave W1.5). | W1.5 |
| 9 | `app/api/settle/principal/route.test.ts` | Modificar | Blast-radius (rompe). Ver §Blast-radius. | W1.4 |
| 10 | `app/api/a2a/payout/submit/route.test.ts` | Modificar | Blast-radius (rompe, cross-env replay). Ver §Blast-radius. | W1.4 |
| 11 | `app/api/a2a/payout/challenge/route.test.ts` | Modificar | Blast-radius (rompe). Ver §Blast-radius. | W1.4 |
| 12 | `src/infrastructure/auth/pop-challenge.test.ts` | Modificar (consistencia) | Data-only 43113→84532. NO rompe; grep-clean. | W1.4 |
| 13 | `src/infrastructure/settlement/attestation.test.ts` | Modificar (consistencia) | Data-only 43113→84532. NO rompe; grep-clean. | W1.4 |
| 14 | `src/infrastructure/persistence/supabase-settlement-ledger.test.ts` | Modificar (consistencia) | Data-only 43113→84532. NO rompe; grep-clean. | W1.4 |
| 15 | `app/api/admin/reconcile-orphans/route.test.ts` | Modificar (consistencia) | Data-only 43113→84532. NO rompe; grep-clean. | W1.4 |

**NADA de código fuera de esta tabla.** Si necesitás tocar algo más → PARAR y escalar al Architect.

---

## Contrato exacto — `chain.ts` (W0)

> Valores **VERBATIM y normativos** (verificados contra `wasiai-facilitator/src/chains/base.ts`). El Dev
> sigue el estilo tsc-strict del repo; el shape y los literales son obligatorios. `Chain` e `isAddress`
> ya se importan de `viem`. Reemplazar el import `{ avalanche, avalancheFuji }` por `{ base, baseSepolia }`.

```ts
import { type Chain, isAddress } from "viem";
import { base, baseSepolia } from "viem/chains";

const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_MAINNET_CHAIN_ID = 8453;

/** Config estable por red (NO secreta, NO env-editable para name/version — DT-3). El `eip712`
 *  coincide con el DOMAIN_SEPARATOR on-chain real (verificado, wasiai-facilitator/chains/base.ts). */
export type NetworkConfig = {
  chainId: number;
  viemChain: Chain;
  /** USDC canónico de Circle en esta red — REFERENCIA documentada (DT-4). El verifyingContract real
   *  de la firma sigue saliendo de resolveUsdcAddress() (env-driven). Usado en tests de consistencia. */
  canonicalUsdc: `0x${string}`;
  /** Domain EIP-712: DEBE matchear el contrato on-chain (CD-4). Sepolia="USDC", mainnet="USD Coin". */
  eip712: { name: string; version: string };
  rpcEnvVar: "BASE_SEPOLIA_RPC_URL" | "BASE_MAINNET_RPC_URL";
};

const NETWORKS: Record<typeof BASE_SEPOLIA_CHAIN_ID | typeof BASE_MAINNET_CHAIN_ID, NetworkConfig> = {
  [BASE_SEPOLIA_CHAIN_ID]: {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    viemChain: baseSepolia,
    canonicalUsdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    eip712: { name: "USDC", version: "2" },       // ← Hallazgo F0: testnet usa "USDC", NO "USD Coin"
    rpcEnvVar: "BASE_SEPOLIA_RPC_URL",
  },
  [BASE_MAINNET_CHAIN_ID]: {
    chainId: BASE_MAINNET_CHAIN_ID,
    viemChain: base,
    canonicalUsdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    eip712: { name: "USD Coin", version: "2" },
    rpcEnvVar: "BASE_MAINNET_RPC_URL",
  },
};

/** Deriva el chainId de NEXT_PUBLIC_CHAIN_ID. Solo Base mainnet (8453) / Sepolia (84532); unset o
 *  cualquier otra cosa → 84532 (Base Sepolia, fail-safe testnet — DT-5: jamás mainnet real). */
export function resolveChainId(): number {
  const raw = process.env.NEXT_PUBLIC_CHAIN_ID;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return n === BASE_MAINNET_CHAIN_ID ? BASE_MAINNET_CHAIN_ID : BASE_SEPOLIA_CHAIN_ID;
}

/** NetworkConfig de la red activa (acceso por clave literal — CD-7, sin object-injection). */
export function resolveNetworkConfig(): NetworkConfig {
  return resolveChainId() === BASE_MAINNET_CHAIN_ID
    ? NETWORKS[BASE_MAINNET_CHAIN_ID]
    : NETWORKS[BASE_SEPOLIA_CHAIN_ID];
}

/** El objeto Chain de viem de la red activa (CD-9: derivado de la lib). */
export function resolveChain(): Chain {
  return resolveNetworkConfig().viemChain;
}

/** RPC READ-ONLY de la red activa (server-only). `switch` sobre la unión literal (patrón
 *  wasiai-facilitator readRpcUrl — CD-7). undefined si la env no está → el caller fail-closea (V1). */
export function resolveRpcUrl(): string | undefined {
  switch (resolveNetworkConfig().rpcEnvVar) {
    case "BASE_SEPOLIA_RPC_URL":
      return process.env.BASE_SEPOLIA_RPC_URL;
    case "BASE_MAINNET_RPC_URL":
      return process.env.BASE_MAINNET_RPC_URL;
  }
}

// resolveUsdcAddress() y resolveReceiverAddress() → SIN CAMBIOS (DT-4/CD-8). NO tocar su firma ni su lectura de env.
```

### `wallet.ts` — domain por red (`:97` y `:242`)

Reemplazar EXACTAMENTE los dos literales hardcodeados. Hoy (ambas líneas):
```ts
domain: { name: "USD Coin", version: "2", chainId: resolveChainId(), verifyingContract: usdc },
```
Debe quedar (en cada uno de los dos sitios; `resolveNetworkConfig` se importa de `./chain`):
```ts
const net = resolveNetworkConfig();
// ...
domain: { name: net.eip712.name, version: net.eip712.version, chainId: net.chainId, verifyingContract: usdc },
```
`net.chainId === resolveChainId()`: fuente única, sin drift (AC-10). **La rama DEMO/OFF (`:126-131`, `:270-275`)
NO se toca (CD-9/AC-8).** Comentario en `:184` `// Avalanche (...)` → `// Base (...)`.

### `onchain-verifier.ts` (`:59`)

Hoy:
```ts
const rpc = process.env.AVALANCHE_RPC_URL; // CD-14: env leída dentro de la función
```
Debe quedar (importar `resolveRpcUrl` de `../chain`; ya se importan `resolveChain`, `resolveUsdcAddress`):
```ts
const rpc = resolveRpcUrl(); // CD-14: env (indirecta) leída dentro de la función
```
La línea `if (!rpc) return { ok: false, reason: "settle_unverified" };` (V1 fail-closed) **sin cambio**.

---

## Blast-radius de tests (§6.1 del SDD — CD-12) — líneas EXACTAS a migrar

> Grep verificado en el repo. Los **6 breakers** rompen `npm run qa` si no se migran. Los **4 data-only**
> no rompen (43113 sigue siendo entero válido) pero se migran a `84532` por consistencia (grep-clean).

### Breakers (OBLIGATORIO — sin esto el gate queda ROJO)

| Archivo | Líneas | Cambio |
|---------|--------|--------|
| `src/infrastructure/chain.test.ts` | (reescritura completa, W0) | Base 84532/8453, default 84532, canonicalUsdc verbatim. |
| `src/infrastructure/wallet.test.ts` | `:26-30`, `:108-138`, `:269-311` | `CHAIN_MAINNET_HEX="0xa86a"` (43114) → `"0x2105"` (8453). `domain.name` assert `"USD Coin"` → `"USDC"` para Sepolia / `"USD Coin"` para mainnet según el chainId stubeado. |
| `src/infrastructure/settlement/onchain-verifier.test.ts` | `:47-49`, `:68-69` | Stub `AVALANCHE_RPC_URL` → `BASE_SEPOLIA_RPC_URL`; `NEXT_PUBLIC_CHAIN_ID "43113"` → `"84532"`; USDC Fuji → USDC Base Sepolia. |
| `app/api/settle/principal/route.test.ts` | `:97` (`"43113"`→`"84532"`), `:152` (`"eip155:43113"`→`"eip155:84532"`), `:159` (`AVALANCHE_RPC_URL`→`BASE_SEPOLIA_RPC_URL`), `:426` (`43113`→`84532`) | Migrar a Base Sepolia. |
| `app/api/a2a/payout/submit/route.test.ts` | `:334`, `:352-353` (comentario), `:355`, `:499`, `:500`, `:505`, `:506`, `:514`, `:515`, `:594`, `:607-608`, `:659`, `:759`, `:761-762`, `:774`, `:776`, `:779-781`, `:792`, `:798` | Ver **regla cross-env replay** abajo. |
| `app/api/a2a/payout/challenge/route.test.ts` | `:33` (`"43113"`→`"84532"`), `:61` (`toBe(43113)`→`toBe(84532)`) | Migrar a Base Sepolia. |

**Regla cross-env replay (`payout/submit/route.test.ts`) — CRÍTICA, no colapsar:** este test valida que el
guard rechaza una attestation/PoP firmada para una cadena distinta a la del deployment. Usa DOS chainIds
distintos: `43113` (deployment Fuji) y `43114` (cadena "foránea" del replay). Al migrar hay que **preservar
la distinción de dos ids**, mapeando:
- `43113` (deployment / red activa stubeada en `NEXT_PUBLIC_CHAIN_ID`) → **`84532`** (Base Sepolia).
- `43114` (la cadena foránea, valor DATA dentro de attestations/PoPs firmados) → **`8453`** (Base mainnet).

Ej: `:499` `vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "43114")` (deployment mainnet) → `"8453"`; `:500` `attFor({ chainId: 43113 })`
(attestation de otra red) → `{ chainId: 84532 }`. Si colapsás ambos a un solo id, el test de replay pierde
sus dientes (un mutante body-sourced pasaría). **Los stubs con `8453` acá son unit puros (assert sobre el
guard, provider/attestation mockeados, cero red/broadcast) — CD-1 respetado (ver nota CD-1).**

### Data-only (consistencia — NO rompen, migrar 43113→84532 para grep-clean)

| Archivo | Líneas |
|---------|--------|
| `src/infrastructure/auth/pop-challenge.test.ts` | `:17`, `:78-84` (todas las apariciones de `43113`; `43113.5` y `"43113"` son casos de validación de tipo → cambiar a `84532.5` / `"84532"` manteniendo la intención) |
| `src/infrastructure/settlement/attestation.test.ts` | `:17` |
| `src/infrastructure/persistence/supabase-settlement-ledger.test.ts` | `:74`, `:126` |
| `app/api/admin/reconcile-orphans/route.test.ts` | `:37` |

---

## Constraint Directives

### OBLIGATORIO
- **CD-4**: el domain EIP-712 (`name`/`version`) DEBE matchear el `DOMAIN_SEPARATOR` on-chain de la red activa.
  Sepolia = `{name:"USDC", version:"2"}`, mainnet = `{name:"USD Coin", version:"2"}`. Derivado del chainId vía la tabla, NO env editable.
- **CD-7**: acceso a `NETWORKS` por clave literal o `switch` sobre unión literal (patrón facilitator). NUNCA `NETWORKS[dynamicKey]` ni `process.env[dynamicVar]` (object-injection).
- **CD-8**: `resolveUsdcAddress()`/`resolveReceiverAddress()` quedan **byte-idénticas** (firma + lectura de env sin cambio).
- **CD-10 / AC-11**: fail-closed money-path — RPC de Base ausente → `settle_unverified` (V1); USDC/receiver malformado → throw. El único fail-**safe** a un valor es el default de `resolveChainId()` (84532), jamás credenciales de un settle real.
- **CD-11**: el gate es `npm run qa` (typecheck + vitest), NUNCA solo `npm run build` (excluye tests). Todo el blast-radius verde.
- **CD-12**: `chain.ts` y su `chain.test.ts` se cierran en la MISMA wave (W0). Los 6 breakers migrados antes del gate final.
- Seguir el patrón `switch` sobre unión literal de `wasiai-facilitator/src/chains/base.ts:74-88` (`readRpcUrl`) para `resolveRpcUrl()`.
- Tests: asertar valores **EXACTOS** (no "no-fallback"). `mockImplementation`, NO `mockResolvedValue` donde el mock deba inspeccionar args (recurrente).

### PROHIBIDO
- **CD-1**: PROHIBIDO ejecutar/validar contra Base **mainnet** (8453) o mover fondos reales. Todo Base Sepolia testnet. (Los stubs con `8453` en unit tests son assert-only sobre typed-data/guards, sin red — permitido.)
- **CD-2**: PROHIBIDO tocar el guard-order de `/api/settle/principal` (S1-V9), `/api/a2a/payout/submit`, ni la atestación/PoP/ledger de WKH-202/168/206/207. Solo config de red (y solo los TESTS de esas rutas, no su código).
- **CD-3**: PROHIBIDO encender `NEXT_PUBLIC_EIP3009_ENABLED=true` en cualquier entorno compartido. Sigue OFF por default. Esta HU CONSTRUYE, NO ENCIENDE.
- **CD-5**: PROHIBIDO tocar `wasiai-facilitator` (repo externo, auditado).
- **CD-6**: PROHIBIDO dejar CUALQUIER referencia a Avalanche en el path de settlement: `avalanche`/`avalancheFuji` (imports viem), literales `43113`/`43114`, `AVALANCHE_RPC_URL`. Grep-clean obligatorio en `src/infrastructure/` y `app/api/` al cerrar (excepto comentarios históricos explícitos).
- **CD-9 / AC-8**: PROHIBIDO alterar la rama DEMO/OFF de `wallet.ts` (`:126-131`, `:270-275`) → byte-idéntico a hoy.
- NO agregar dependencias nuevas (ninguna). NO tocar código fuera de la tabla "Files to Modify/Create". NO "mejorar" código adyacente.
- NO tocar `route.ts` (código) de settle/principal, payout/submit, payout/challenge, ni `confirm-and-send.ts`, `facilitator-client.ts`, `attestation.ts`, `container.ts`.

---

## Test Expectations

| Test | ACs | Aserción clave |
|------|-----|----------------|
| `chain.test.ts` | AC-1, AC-2, AC-3, AC-7, AC-11 | `"84532"`→84532/baseSepolia; `"8453"`→8453/base; unset/`"99"`/`"abc"`/`"43113"`/`"43114"`→84532 (y `!==43114 && !==43113`); `NETWORKS[84532].canonicalUsdc==="0x036CbD53842c5426634e7929541eC2318f3dCF7e"`, `NETWORKS[8453].canonicalUsdc==="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"`; `resolveUsdcAddress()` con env malformada → throw. |
| `wallet.test.ts` | AC-4, AC-5, AC-8, AC-10 | flag ON + `"84532"` → `domain.name==="USDC"`, `version==="2"`, `chainId===84532`. flag ON + `"8453"` → `domain.name==="USD Coin"`, `chainId===8453` (unit puro). flag OFF → `personal_sign` llamado, `signTypedData` NO, `tx==="0xsignature"` (byte-idéntico). `domain.chainId===resolveChainId()`. |
| `onchain-verifier.test.ts` | AC-6, AC-11 | (a) `BASE_SEPOLIA_RPC_URL` + `"84532"` + USDC Sepolia → V9 ok. (b) **KILLER**: `AVALANCHE_RPC_URL` seteado PERO `BASE_SEPOLIA_RPC_URL` vacío → `settle_unverified` sin leer la cadena (prueba que NO lee el env viejo). `resolveRpcUrl()` undefined → `settle_unverified`. |
| `settle/principal/route.test.ts` | (blast-radius) | `accepted.network==="eip155:84532"`, `arg.chainId===84532`, stub `BASE_SEPOLIA_RPC_URL`. |
| `payout/submit/route.test.ts` | (blast-radius) | cross-env replay reescrito (deployment 84532 / foránea 8453), guard rechaza siempre. |
| `payout/challenge/route.test.ts` | (blast-radius) | `ch.chainId===84532`. |

**AC-9** (proceso, no unit): ningún test hace I/O de red / broadcast con chainId 8453 (todos assert-only sobre typed-data/guard).
**Criterio test-first**: `chain.ts`/`wallet.ts`/`onchain-verifier.ts` son config → el test se actualiza junto al cambio en su wave (no test-first estricto, pero el gate de la wave DEBE quedar verde).

---

## Waves

### Wave -1: Environment Gate (verificar antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v2
npm install 2>/dev/null || echo "revisar package.json"
# Baseline de tests (debe dar 36 files / 451 tests verdes ANTES de empezar):
npx vitest run 2>&1 | grep -iE 'Test Files|Tests '
# Archivos base del Scope IN existen:
ls src/infrastructure/chain.ts src/infrastructure/wallet.ts \
   src/infrastructure/settlement/onchain-verifier.ts src/presentation/flow.tsx .env.example 2>/dev/null \
   || echo "FALTA archivo base"
```
Si algo falla → PARAR y reportar al orquestador.

### Wave 0 (Serial — contrato/tipos; cierra su propio gate)
- [ ] **W0.1** `chain.ts`: tabla `NetworkConfig`/`NETWORKS` + `resolveChainId`/`resolveNetworkConfig`/`resolveChain`/`resolveRpcUrl` (§Contrato exacto). Swap imports viem. `resolveUsdcAddress`/`resolveReceiverAddress` intactas.
- [ ] **W0.2** `chain.test.ts`: reescribir a Base (AC-1/2/3/7/11). MISMA wave (CD-12).
- **Gate W0**: `npx vitest run src/infrastructure/chain.test.ts` verde + `npm run typecheck` verde. (Otros tests que importan `chain.ts` pueden quedar rojos hasta W1.)

### Wave 1 (tras W0 — sub-waves independientes entre sí)
- [ ] **W1.1** `wallet.ts` (domain por red `:97`/`:242` + comentario `:184`) + `wallet.test.ts` (AC-4/5/8/10, `CHAIN_MAINNET_HEX="0x2105"`).
- [ ] **W1.2** `onchain-verifier.ts` (`resolveRpcUrl()` en `:59`) + `onchain-verifier.test.ts` (AC-6 incl. killer + AC-11).
- [ ] **W1.3** `.env.example` (bloques Chain/USDC/RPC → Base, default 84532). Sin tests.
- [ ] **W1.4** Blast-radius: los 3 route tests breakers a ids Base (regla cross-env replay en submit) + los 4 data-only a 84532.
- [ ] **W1.5** `flow.tsx:536` label fix (ver abajo).
- **Gate W1 / final**: `npm run qa` verde en TODO el repo (≥451 tests, ver §Auto-blindaje) + grep-clean CD-6.

### Wave W1.5 — Fix de label UI (`flow.tsx:536`)

Hoy la UI muestra `<span className="text-sm font-medium">en Avalanche</span>` — factualmente incorrecto tras
el swap. Cambiar a que refleje la red configurada. **Opción preferida (data-driven):** derivar el nombre de la
red de la config activa en vez de un literal. Verificá qué expone `resolveNetworkConfig()`/`resolveChain()` en
el cliente: `resolveChain().name` de viem da `"Base Sepolia"` / `"Base"`. Si `flow.tsx` es client-side y ya
importa de `../infrastructure/chain` o similar, usar `resolveChain().name`; si introducir ese import agrega
complejidad de bundle (server-only env en cliente), el fallback aceptable es el literal `"en Base"`.
- **Preferido**: `<span className="text-sm font-medium">en {resolveChain().name}</span>` (o helper equivalente).
- **Fallback mínimo**: `<span className="text-sm font-medium">en Base</span>`.

Es correctness user-facing (código profesional), NO money-path → NO viola AC-8 (AC-8 es sobre el path de firma).
Si optás por data-driven y `flow.tsx` tiene tests de presentación, agregá/ajustá el assert de la label; si es
copy puro sin test previo, no es obligatorio test-first (criterio "cambio de copy → No"). Antes de importar
`chain.ts` en un componente client, confirmá que no arrastra `process.env` server-only al bundle: si
`resolveChain()` solo lee `NEXT_PUBLIC_CHAIN_ID` (público) es seguro. Si hay duda → usar el fallback literal.

### Verificación incremental

| Wave | Verificación |
|------|--------------|
| W0 | `chain.test.ts` verde + typecheck |
| W1 | `npm run qa` full verde |
| final | `npm run qa` + grep-clean + auto-blindaje |

---

## Auto-Blindaje (ejecutar ANTES de entregar — recurrente WKH-206/207)

1. **`grep -rn 'MUTANT' src app` = 0** (baseline actual = 0; no dejar marcadores).
2. **Contar tests EJECUTANDO**: `npx vitest run 2>&1 | grep -iE 'Test Files|Tests '`. Debe dar **≥ 451 tests
   verdes** (36 files). Si baja el número, algún test dejó de ejecutar (skip/typo de `describe`) → investigar. Reportar el número final.
3. **`npm run qa` verde** (typecheck + tests). NUNCA validar solo con `npm run build` (excluye tests — MEMORY uint256).
4. **Grep-clean CD-6**: `grep -rn 'avalanche\|avalancheFuji\|43113\|43114\|AVALANCHE_RPC_URL' src/infrastructure app/api`
   → 0 hits (salvo comentarios históricos explícitos). Incluí los tests data-only.
5. **Mutation self-check** (mutar, correr, confirmar que el test MUERE, revertir):
   - (a) **domain name por red**: en `NETWORKS[84532].eip712.name` cambiar `"USDC"` → `"USD Coin"` → el test AC-4 de `wallet.test.ts` DEBE fallar. Si pasa, el test no ata el name a la red.
   - (b) **RPC de Base**: en `resolveRpcUrl()` case `BASE_SEPOLIA_RPC_URL` devolver `process.env.AVALANCHE_RPC_URL` → el killer test de `onchain-verifier.test.ts` (AC-6b) DEBE fallar.
   - (c) **fail-loud si falta env**: comentar el `if (!rpc) return settle_unverified` → el test AC-11 DEBE fallar.
   - Los 3 se revierten tras confirmar. Documentar el resultado en el reporte.

---

## Out of Scope (NO tocar bajo ninguna circunstancia)

- Código de `app/api/settle/principal/route.ts`, `app/api/a2a/payout/submit/route.ts`, `.../challenge/route.ts` (solo sus TESTS).
- `confirm-and-send.ts`, `facilitator-client.ts`, `attestation.ts`, `attestation-store.ts`, `pop-nonce-store.ts`, `supabase-settlement-ledger.ts` (solo el TEST del ledger, data-only).
- `src/composition/container.ts` (guard EIP-3009 usa solo `resolveReceiverAddress()`, sin cambio).
- Firma de `resolveUsdcAddress`/`resolveReceiverAddress` (DT-4/CD-8, byte-idénticas).
- Rama DEMO/OFF de `wallet.ts` (`:126-131`, `:270-275`).
- `wasiai-facilitator`, demo live `chaski-ai`, `wasiai-a2a`, `wasiai-v2`.
- Encender `NEXT_PUBLIC_EIP3009_ENABLED`. Ejecutar contra Base mainnet o fondos reales.
- NO refactors no solicitados. NO agregar funcionalidad no listada.

---

## Escalation Rule

Si algo NO está en este Story File, Dev **PARA** y escala al Architect. No inventar, no asumir, no improvisar.

Situaciones de escalation:
- El import `resolveChain`/`resolveRpcUrl` no está disponible donde se necesita.
- Importar `chain.ts` en `flow.tsx` arrastra `process.env` server-only al bundle cliente → usar fallback literal `"en Base"` y anotarlo (NO forzar).
- El cross-env replay de `payout/submit/route.test.ts` no se puede preservar con dos ids distintos sin tocar el código de la ruta → PARAR (no tocar el route.ts).
- Un test data-only cambia de resultado al migrar 43113→84532 (no debería) → PARAR.
- Nota ops (no bloquea el código): validar un settle real e2e requiere `BASE_SEPOLIA_ENABLED=true` + `BASE_SEPOLIA_RPC_URL` en el deploy del facilitator (`FACILITATOR_BASE_URL`). Es coordinación ops (CD-5), fuera del `npm run qa`.

---

*Story File generado por NexusAgil — F2.5 (Architect). SDD #020 SPEC_APPROVED.*
