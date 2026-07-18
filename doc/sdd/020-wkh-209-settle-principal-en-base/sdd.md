# SDD #020: [WKH-209] Mover el settlement del principal de Chaski de Avalanche a Base

> SPEC_APPROVED: no
> Fecha: 2026-07-17
> Tipo: config/parametrización (money-path, sin lógica de dominio nueva)
> SDD_MODE: full
> Branch: feat/020-settle-principal-base
> Artefactos: doc/sdd/020-wkh-209-settle-principal-en-base/

---

## 1. Resumen

El corredor de remesa usa **Base** (decisión del founder, 2026-07-17): TransFi liquida USDC en Base,
no en Avalanche. Hoy TODO el settlement real del principal (WKH-168, EIP-3009) apunta a Avalanche
(Fuji 43113 / mainnet 43114): el `chainId`, la `viem chain`, el `domain` EIP-712 hardcodeado y el RPC
de verificación (`AVALANCHE_RPC_URL`). Esta HU **reconfigura** ese camino a Base (Sepolia 84532 /
mainnet 8453), reusando la infraestructura de `wasiai-facilitator` que YA settlea Base Sepolia en prod.

Es un cambio de **config/parametrización**, no de lógica: el guard-order, la atestación, la
verificación read-only y el ledger de WKH-168/202/206/207 quedan intactos. La firma EIP-712 real
sigue **OFF por default** (`NEXT_PUBLIC_EIP3009_ENABLED` no se toca — CD-3): esta HU **construye la
config correcta**, no enciende el settle real.

**Decisión maestra (DT-1, cerrada en HU_APPROVED):** SWAP directo a Base — se elimina Avalanche del
código de settlement. Pero se hace **profesional**: una **tabla `NetworkConfig` keyed por chainId**
(Base Sepolia + Base mainnet) es la única fuente de la `viem chain`, el `eip712 {name, version}`, la
env de RPC y la dirección USDC canónica de referencia. Nada de literales `"USD Coin"`/`"USDC"` sueltos
sin condicionar por red.

**El corazón de la HU (Hallazgo crítico F0):** el USDC de **Base Sepolia** usa `eip712 name="USDC"`
(version `"2"`); el de **Base mainnet** usa `name="USD Coin"` (version `"2"`). Hoy `wallet.ts:97,242`
hardcodea `"USD Coin"` para AMBOS. Si la firma `transferWithAuthorization` usa el `name` equivocado, el
`DOMAIN_SEPARATOR` no coincide con el del contrato → la firma es inválida → el facilitator rechaza el
settle. Verificado contra el contrato on-chain en `wasiai-facilitator/src/chains/base.ts:46-66`
(cast, 2026-05-19). Por eso el `name`/`version` del domain se parametriza por red, igual que la USDC.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 020 / WKH-209 |
| **Tipo** | config/parametrización (money-path) |
| **SDD_MODE** | full |
| **Objetivo** | Reapuntar el settlement del principal de Avalanche → Base (Sepolia/mainnet), parametrizado por red, corrigiendo el domain EIP-712 hardcodeado. Sin encender el settle real. |
| **Reglas de negocio** | Cero deuda técnica; byte-idéntico con el flag OFF; solo Base Sepolia en dev/validación (jamás mainnet ni fondos reales); fail-closed en envs money-path. |
| **Scope IN** | Ver §6 IN (ampliado vs work-item — ver §6.1 Blast-radius) |
| **Scope OUT** | Ver §6 OUT |
| **Missing Inputs** | DT-1 resuelto (swap, founder / HU_APPROVED). DT-2 (RPC env), AC-3 (default) → resueltos en §4. Un residual operativo + una nota de presentación en §11. |

### Acceptance Criteria (EARS) — heredados literales del work-item

Ver `work-item.md` §Acceptance Criteria (AC-1..AC-11). Resumen de cobertura en §9 (≥1 test por AC):

- **AC-1**: `NEXT_PUBLIC_CHAIN_ID=84532` → `resolveChainId()/resolveChain()` = Base Sepolia (`baseSepolia`).
- **AC-2**: `=8453` → Base mainnet (`base`).
- **AC-3**: ausente/no reconocido → default fail-safe **explícito y documentado**, NUNCA Avalanche.
- **AC-4**: firma contra Base Sepolia → `domain.name="USDC"`, `version="2"` (NUNCA el `"USD Coin"` hardcodeado).
- **AC-5**: firma contra Base mainnet → `domain.name="USD Coin"`, `version="2"`.
- **AC-6**: `onchain-verifier` lee el receipt vía un RPC de **Base**, NUNCA `AVALANCHE_RPC_URL`.
- **AC-7**: `resolveUsdcAddress()` resuelve al USDC canónico de la red Base activa (env-driven, fail-loud).
- **AC-8**: con `NEXT_PUBLIC_EIP3009_ENABLED` OFF → byte-idéntico a hoy (demo intacto).
- **AC-9**: settle real e2e SOLO contra Base Sepolia (84532); PROHIBIDO mainnet / fondos reales.
- **AC-10**: principal-in y payout (TransFi, WKH-208) en la MISMA red (Base) — sin mezclar cadenas.
- **AC-11**: env requerida de Base faltante/malformada → fail-closed (mismo patrón existente).

---

## 3. Context Map (archivos leídos + patrón extraído)

| Archivo | Líneas clave | Qué extraje / por qué |
|---------|-------------|-----------------------|
| `src/infrastructure/chain.ts` | 4-18 | `resolveChainId()` (`43113?43113:43114`), `resolveChain()` (`avalancheFuji`/`avalanche`), `resolveUsdcAddress()`/`resolveReceiverAddress()` (env-driven fail-loud `isAddress`). Estilo: ternario sobre chainId, imports de `viem/chains`. **Fuente única del swap.** |
| `src/infrastructure/wallet.ts` | 95-108, 240-253 | `signTypedData` con `domain: { name: "USD Coin", version: "2", chainId: resolveChainId(), verifyingContract: usdc }` **hardcodeado** en InjectedWallet:97 y WalletConnectWallet:242. `resolveChain()`/`resolveChainId()` ya son la fuente env. Line 184: `chains: [resolveChainId()]` (WC init). |
| `src/infrastructure/settlement/onchain-verifier.ts` | 57-72 | `const rpc = process.env.AVALANCHE_RPC_URL` (:59) leída dentro de la función; `if (!rpc) return settle_unverified` (V1, fail-closed). `resolveChain()`/`resolveUsdcAddress()` ya derivadas. Read-only puro (CD-18). |
| `wasiai-facilitator/src/chains/base.ts` | 35-66, 72-88 | **Valores canónicos verificados on-chain (2026-05-19):** Sepolia USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` → `eip712Name="USDC"`, `version="2"`. Mainnet USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` → `eip712Name="USD Coin"`, `version="2"`. Patrón `switch` sobre unión literal de env-names (`BASE_SEPOLIA_RPC_URL`/`BASE_MAINNET_RPC_URL`) para evitar object-injection. **Exemplar de la tabla de red.** NO se toca (CD-5). |
| `.env.example` | 51-56, 90-97, 99-117 | Bloque Chain (`NEXT_PUBLIC_CHAIN_ID`, "Solo Avalanche… soportados"), USDC (direcciones Avalanche canónicas como comentario), Settlement (`AVALANCHE_RPC_URL` server-only). Docs a actualizar. |
| `src/composition/container.ts` | 55-97 | Guard fail-loud EIP-3009 (adapter=a2a + receiver + usdc). Solo usa `resolveReceiverAddress()` (sin cambio). **NO en scope de código.** |
| `src/infrastructure/chain.test.ts` | 4-41 | Tests del contrato de `chain.ts` (default 43114, "43113"→Fuji). **Se reescribe en W0.** |
| `src/infrastructure/wallet.test.ts` | 26-30, 108-138, 269-311 | `CHAIN_MAINNET_HEX="0xa86a"` (43114), `typedDataOf()` extrae `domain.name`, assert `domain.name === "USD Coin"`. Mock provider (`eth_signTypedData_v4`→"0xtypedsig", sin red real). **Se actualiza en W1.1.** |
| `src/infrastructure/settlement/onchain-verifier.test.ts` | 47-49, 68-69 | Stub `AVALANCHE_RPC_URL` + `NEXT_PUBLIC_CHAIN_ID="43113"` + USDC Fuji. Mock de `createPublicClient`, `parseEventLogs` real. **Se actualiza en W1.2.** |
| `app/api/settle/principal/route.test.ts` | 97, 152, 159, 426 | Stub `"43113"` + `AVALANCHE_RPC_URL` + assert `accepted.network === "eip155:43113"` + `arg.chainId === 43113`. **BLAST-RADIUS: se rompe con el swap → se actualiza (§6.1).** |
| `app/api/a2a/payout/submit/route.test.ts` | 334, 355, 499-517, 594, 759-798 | Stub extensivo `"43113"`/`"43114"` asumiendo `resolveChainId()` los devuelve (cross-env replay 43113 vs 43114). **BLAST-RADIUS: se rompe → se actualiza (§6.1).** |
| `app/api/a2a/payout/challenge/route.test.ts` | 33, 61 | Stub `"43113"` + assert `ch.chainId === 43113`. **BLAST-RADIUS: se rompe → se actualiza (§6.1).** |
| `src/infrastructure/auth/pop-challenge.test.ts`, `settlement/attestation.test.ts`, `persistence/supabase-settlement-ledger.test.ts`, `app/api/admin/reconcile-orphans/route.test.ts` | varias | Usan `chainId: 43113` como **DATA literal** (no llaman `resolveChainId()`). **NO se rompen** (43113 sigue siendo un entero válido); actualización de consistencia opcional (§6.1). |
| `src/presentation/flow.tsx` | 536 | Label UI hardcodeada `"en Avalanche"`. Presentación; factualmente incorrecta tras el swap. Ver §11 nota. |

**Auto-Blindaje histórico consultado** (últimas 3 HUs DONE: WKH-207/205/206). Patrones recurrentes
incorporados a los CD (§5): (a) extender un contrato fuerza a TODOS sus callers en la MISMA wave
(WKH-207 W0) → §6.1 blast-radius; (b) `npm run qa` (tsc + tests), NUNCA solo `npm run build` que
excluye tests (WKH-206, MEMORY uint256) → CD-11; (c) byte-identidad del path preservado se verifica,
no se asume (WKH-206) → CD-9/AC-8; (d) los tests de estado/código asertan el valor EXACTO, no
"no-fallback" (WKH-207 W3) → §9.

---

## 4. Decisiones técnicas (DT-N)

### DT-1 — SWAP directo a Base, parametrizado por tabla `NetworkConfig` (CERRADA en HU_APPROVED)
Se elimina Avalanche del código de settlement. `43113`/`43114` dejan de ser válidos. Pero **no** es un
find-replace: se introduce una tabla `NetworkConfig` keyed por chainId con las 2 entradas de Base,
única fuente de: `viemChain`, `eip712 {name, version}`, `rpcEnvVar` y `canonicalUsdc` (referencia).
Justificación: menos superficie money-path + fuente única audita­ble = menos riesgo; el domain, la RPC
env y la chain dejan de estar dispersos. NO se reabre.

### DT-2 — Env de RPC: convención testnet/mainnet explícita (RESUELTA, no bloqueante)
Se adopta `BASE_SEPOLIA_RPC_URL` (84532) y `BASE_MAINNET_RPC_URL` (8453), **idéntico** a
`wasiai-facilitator/src/chains/base.ts:72` (que ya usa esos nombres). La env activa se selecciona por
`NetworkConfig.rpcEnvVar` vía un helper `resolveRpcUrl()` con `switch` sobre la unión literal (patrón
`readRpcUrl` del facilitator, evita object-injection y drift de nombre). Se descarta el nombre único
`BASE_RPC_URL` genérico: la convención explícita por red hace imposible confundir el RPC de Sepolia con
el de mainnet en un deploy, y espeja al servicio que consumimos. `AVALANCHE_RPC_URL` se elimina.

### DT-3 — Domain EIP-712 derivado del chainId, NO env nueva (CERRADA)
`{name, version}` NO es una env: es una constante pública/estable por chainId (un typo de operador
rompería la firma). Vive en la tabla `NetworkConfig` de `chain.ts` (ubicación elegida: centralizar en
`chain.ts` junto al resto de la resolución de red; `wallet.ts` la consume vía `resolveNetworkConfig()`).
Valores (verificados §3): `84532 → {name:"USDC", version:"2"}`, `8453 → {name:"USD Coin", version:"2"}`.

### DT-4 — La dirección USDC del `verifyingContract` sigue env-driven (CERRADA)
`resolveUsdcAddress()` sigue leyendo `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS` (fail-loud `isAddress`) —
**sin cambio de comportamiento**. La tabla `NetworkConfig` incluye `canonicalUsdc` SOLO como referencia
documentada/verificable (usada en tests de consistencia §9 y en el comentario de `.env.example`), NO
como fuente del `verifyingContract` en la firma. Motivo: hardcodear la USDC haría imposible testear
contra un USDC mock sin redeploy (fuera de scope). Se mantiene la asimetría con el facilitator (que sí
la hardcodea) a propósito.

### DT-5 — Default fail-safe de `resolveChainId()` = **Base Sepolia (84532)** (RESUELVE AC-3)
Cuando `NEXT_PUBLIC_CHAIN_ID` falta o no es reconocido → **84532** (Base Sepolia, testnet), documentado
en `.env.example` y en el JSDoc de la función. **Justificación (cambia el criterio "mainnet-like" del
Analyst a propósito):** con Avalanche eliminado, el viejo fail-safe "default = mainnet = lo que firma el
demo hoy" ya no aplica. Ahora mainnet (8453) mueve dinero real, y CD-1/AC-9 PROHIBEN tocar mainnet en
todo el ciclo F3→F4. Defaultear a testnet significa que un env mal seteado/ausente **jamás** puede
producir accidentalmente una firma contra la red de dinero real: el fail-safe money-path correcto es
"fallar hacia la red donde un error no cuesta nada". El path demo (flag OFF) es byte-idéntico sin
importar el chainId (AC-8), así que el chainId solo importa con el flag ON — que en esta fase solo
ocurre en dev/testnet. Esto NO es fail-open: las envs de un settle REAL (RPC, USDC) siguen fail-closed
(AC-11); el default de chainId es un fail-**safe** documentado, distinto del fail-closed de envs money-path.

### DT-6 — `resolveChain()` y `chains:[...]` derivan de la tabla (CERRADA)
`resolveChain()` devuelve `resolveNetworkConfig().viemChain`. `wallet.ts:184` (`chains:[resolveChainId()]`)
queda igual (resolveChainId ahora devuelve ids de Base). El comentario "Avalanche" en :184 se corrige a "Base".

---

## 5. Constraint Directives (CD-N)

Heredados del work-item (CD-1..CD-5) + específicos del SDD (CD-6..CD-12):

- **CD-1** (heredado): PROHIBIDO ejecutar/validar cualquier parte contra Base **mainnet** (8453) o mover
  fondos con valor real — únicamente Base Sepolia testnet (AC-9). Los tests que fijan `NEXT_PUBLIC_CHAIN_ID=8453`
  son **unit puros** (assert sobre el typed-data construido con provider mockeado, cero red/broadcast).
- **CD-2** (heredado): PROHIBIDO tocar el guard-order de `/api/settle/principal` (S1-V9), `/api/a2a/payout/submit`,
  ni la atestación/PoP/ledger de WKH-202/168/206/207. Solo config de red.
- **CD-3** (heredado): PROHIBIDO encender `NEXT_PUBLIC_EIP3009_ENABLED=true` en cualquier entorno compartido.
  Sigue OFF por default. Esta HU CONSTRUYE, NO ENCIENDE.
- **CD-4** (heredado): OBLIGATORIO que el domain EIP-712 (`name`/`version`) coincida EXACTAMENTE con el
  `DOMAIN_SEPARATOR` on-chain de la red activa (Hallazgo F0). Derivado del chainId (DT-3), NO env editable.
- **CD-5** (heredado): PROHIBIDO tocar `wasiai-facilitator` (repo externo, auditado) — solo coordinar sus
  flags ops `BASE_SEPOLIA_ENABLED`/`BASE_SEPOLIA_RPC_URL` (§11).
- **CD-6**: PROHIBIDO dejar CUALQUIER referencia a Avalanche en el path de settlement: `avalanche`/`avalancheFuji`
  (imports viem), literales `43113`/`43114`, `AVALANCHE_RPC_URL`. Grep-clean obligatorio en `src/infrastructure/`
  y `app/api/` al cerrar (excepto comentarios históricos explícitos y los tests data-only de §6.1 que se
  actualizan por consistencia).
- **CD-7**: OBLIGATORIO acceso a la tabla `NetworkConfig` por clave literal o `switch` sobre unión literal
  (patrón facilitator) — NUNCA `process.env[dynamicVar]` ni `NETWORKS[dynamicKey]` con clave no-narrowed
  (evita object-injection y mantiene el estilo del repo).
- **CD-8**: OBLIGATORIO `resolveUsdcAddress()`/`resolveReceiverAddress()` quedan BYTE-IDÉNTICAS (DT-4). No
  se toca su firma ni su lectura de env.
- **CD-9** (byte-identidad): OBLIGATORIO que el path demo (flag OFF) quede byte-idéntico (AC-8). Verificar
  que ningún test de "flag OFF → personal_sign, sin signTypedData" cambie de resultado. La rama OFF de
  `wallet.ts` (:126-131, :270-275) NO se toca.
- **CD-10**: OBLIGATORIO fail-closed money-path (AC-11): RPC de Base ausente → `settle_unverified` (V1);
  USDC/receiver malformado → throw (patrón existente). El default de chainId (DT-5) es lo ÚNICO que
  fail-safea a un valor; jamás las credenciales de un settle real.
- **CD-11** (recurrente WKH-206/MEMORY): el gate es `npm run qa` (`tsc --noEmit` + `vitest run`), NUNCA
  solo `npm run build` (que excluye los tests). Todo el blast-radius de §6.1 debe estar verde.
- **CD-12** (recurrente WKH-207): extender/cambiar el contrato de `chain.ts` (nuevos returns de
  `resolveChainId`/`resolveChain`, nuevos exports `resolveNetworkConfig`/`resolveRpcUrl`) fuerza a
  actualizar TODOS los callers/tests que asumen los valores viejos en la MISMA wave que rompe (§6.1),
  o el gate de esa wave nunca cierra.

---

## 6. Scope

### IN (código)
1. **`src/infrastructure/chain.ts`** — W0. Núcleo del swap:
   - Reemplazar imports `{ avalanche, avalancheFuji }` → `{ base, baseSepolia }` de `viem/chains`.
   - Agregar `type NetworkConfig` + tabla `NETWORKS` (Base Sepolia + Base mainnet) — §7.
   - Reescribir `resolveChainId()` (ids Base, default 84532 — DT-5), `resolveChain()` (`= resolveNetworkConfig().viemChain`).
   - Agregar `resolveNetworkConfig(): NetworkConfig` y `resolveRpcUrl(): string | undefined` (§7).
   - `resolveUsdcAddress()`/`resolveReceiverAddress()` **sin cambios** (DT-4/CD-8).
2. **`src/infrastructure/wallet.ts`** — W1.1. Domain por red en :97 y :242 (`resolveNetworkConfig().eip712`).
   Comentario "Avalanche" en :184 → "Base". Nada más (rama OFF intacta — CD-9).
3. **`src/infrastructure/settlement/onchain-verifier.ts`** — W1.2. `:59` `process.env.AVALANCHE_RPC_URL`
   → `resolveRpcUrl()` (importado de `../chain`). `if (!rpc)` V1 sin cambio.
4. **`.env.example`** — W1.3. Bloque Chain (:51-56), USDC (:90-97), Settlement RPC (:117): documentar
   Base (ids 84532/8453, USDC canónicas de Circle en Base, `BASE_SEPOLIA_RPC_URL`/`BASE_MAINNET_RPC_URL`,
   default 84532).

### IN (tests — ver §6.1 para el detalle del blast-radius)
5. `src/infrastructure/chain.test.ts` — W0 (contrato).
6. `src/infrastructure/wallet.test.ts` — W1.1.
7. `src/infrastructure/settlement/onchain-verifier.test.ts` — W1.2.
8. `app/api/settle/principal/route.test.ts` — W1.4 (**blast-radius, rompe**).
9. `app/api/a2a/payout/submit/route.test.ts` — W1.4 (**blast-radius, rompe**).
10. `app/api/a2a/payout/challenge/route.test.ts` — W1.4 (**blast-radius, rompe**).

### 6.1 Blast-radius de tests (AMPLIACIÓN sobre el work-item — recurrente WKH-207/CD-12)

El work-item nombra solo 3 test files. El grep real (`43113|43114|AVALANCHE_RPC_URL` en `src`+`app`)
revela más. Clasificación:

| Test file | ¿Rompe? | Por qué | Acción |
|-----------|---------|---------|--------|
| `chain.test.ts` | SÍ | Asserta `resolveChainId()===43114`/Fuji | Reescribir (W0) |
| `wallet.test.ts` | SÍ | `CHAIN_MAINNET_HEX=0xa86a`, `domain.name==="USD Coin"` | Actualizar (W1.1) |
| `settlement/onchain-verifier.test.ts` | SÍ | Stub `AVALANCHE_RPC_URL`, chainId "43113" | Actualizar (W1.2) |
| `app/api/settle/principal/route.test.ts` | **SÍ** | Stub "43113" → `resolveChainId()` ahora da 84532; assert `eip155:43113` + `AVALANCHE_RPC_URL` | Actualizar (W1.4) |
| `app/api/a2a/payout/submit/route.test.ts` | **SÍ** | Stubs "43113"/"43114" asumen `resolveChainId()` los devuelve (cross-env replay) → ahora ambos → 84532 | Actualizar (W1.4) |
| `app/api/a2a/payout/challenge/route.test.ts` | **SÍ** | Stub "43113" + assert `ch.chainId===43113` | Actualizar (W1.4) |
| `auth/pop-challenge.test.ts` | NO | `43113` es DATA literal (valida "entero positivo"), no llama `resolveChainId()` | Consistencia opcional → 84532 |
| `settlement/attestation.test.ts` | NO | `chainId:43113` DATA | Consistencia opcional |
| `persistence/supabase-settlement-ledger.test.ts` | NO | `chain_id:43113` DATA | Consistencia opcional |
| `app/api/admin/reconcile-orphans/route.test.ts` | NO | `chainId:43113` DATA | Consistencia opcional |

**Regla Dev (CD-12):** los 6 que rompen se actualizan a ids de Base en las waves indicadas — sin eso
`npm run qa` queda ROJO. Los 4 data-only se actualizan a `84532` por consistencia (no bloquean el gate,
pero dejan grep-clean de `43113` en el repo de tests). Sugerencia: hacerlo, pero si el timing aprieta,
priorizar los 6 breakers.

### OUT
- **NO** tocar código de `app/api/settle/principal/route.ts`, `app/api/a2a/payout/submit/route.ts`,
  `.../challenge/route.ts`, `confirm-and-send.ts`, `facilitator-client.ts`, `attestation.ts`,
  `attestation-store.ts`, `pop-nonce-store.ts`, `supabase-settlement-ledger.ts` — todos derivan de
  `resolveChainId()`/`resolveUsdcAddress()`/`resolveReceiverAddress()` sin cambio (solo sus TESTS de
  route se actualizan, §6.1). El guard-order (CD-2) queda intacto.
- **NO** tocar `src/composition/container.ts` (guard EIP-3009 usa solo `resolveReceiverAddress()`, sin cambio).
- **NO** encender `NEXT_PUBLIC_EIP3009_ENABLED` (CD-3).
- **NO** tocar `wasiai-facilitator` (CD-5) ni el demo live `chaski-ai`, ni `wasiai-a2a`/`wasiai-v2`.
- **NO** ejecutar/validar contra Base mainnet ni mover fondos reales (CD-1/AC-9).
- **NO** cambiar `resolveUsdcAddress`/`resolveReceiverAddress` (DT-4/CD-8).
- Label UI `flow.tsx:536` "en Avalanche" → ver §11 (nota, decisión del founder — no bloquea Readiness).

---

## 7. Contratos exactos (a implementar en `chain.ts` — W0)

> Estructura de referencia (el Dev sigue el estilo/tsc-strict del repo; los valores y el shape son
> normativos). `Chain` e `isAddress` ya se importan de `viem`.

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

// resolveUsdcAddress() y resolveReceiverAddress() → SIN CAMBIOS (DT-4/CD-8).
```

**`wallet.ts` (:97 y :242) — domain por red:**
```ts
const net = resolveNetworkConfig();
// ...
domain: { name: net.eip712.name, version: net.eip712.version, chainId: net.chainId, verifyingContract: usdc },
```
(`net.chainId === resolveChainId()`: fuente única, sin drift. La rama OFF NO se toca — CD-9.)

**`onchain-verifier.ts` (:59):**
```ts
import { resolveChain, resolveRpcUrl, resolveUsdcAddress } from "../chain";
// ...
const rpc = resolveRpcUrl(); // CD-14 patrón preservado: env leída (indirecta) dentro de la función
if (!rpc) return { ok: false, reason: "settle_unverified" }; // V1 fail-closed, sin cambio
```

---

## 8. Waves de implementación

### W0 (serial — contrato/tipos; cierra su propio gate `npm run qa`)
- **W0.1** `chain.ts`: tabla `NetworkConfig`/`NETWORKS`, `resolveChainId` (Base + default 84532),
  `resolveChain`, `resolveNetworkConfig`, `resolveRpcUrl`. Imports viem swap. `resolveUsdcAddress`/
  `resolveReceiverAddress` intactas.
- **W0.2** `chain.test.ts`: reescribir a Base (§9 AC-1/2/3/7-tabla). Es el contrato → misma wave (CD-12).
- **Gate W0**: `npm run qa` verde para `chain.ts` + `chain.test.ts`. (Los otros tests que importan
  `chain.ts` pueden quedar rojos hasta W1 — se cierran en W1; W0 valida el núcleo.)

### W1 (paralelizable tras W0 — cada sub-wave es independiente entre sí)
- **W1.1** `wallet.ts` (domain por red :97/:242 + comentario :184) + `wallet.test.ts` (AC-4/AC-5/AC-8/AC-10).
- **W1.2** `onchain-verifier.ts` (`resolveRpcUrl()` :59) + `onchain-verifier.test.ts` (AC-6/AC-11 + killer test).
- **W1.3** `.env.example` (bloques Chain/USDC/RPC → Base, default 84532). Docs, sin tests.
- **W1.4** Route tests blast-radius (§6.1): `settle/principal/route.test.ts`, `payout/submit/route.test.ts`,
  `payout/challenge/route.test.ts` → ids Base (84532/8453) + `BASE_SEPOLIA_RPC_URL`. + los 4 data-only
  a `84532` por consistencia (grep-clean).
- **Gate W1 / final**: `npm run qa` verde en TODO el repo (CD-11) + grep-clean de `avalanche|43113|43114|AVALANCHE_RPC_URL` en `src/infrastructure` y `app/api` (excepto comentarios históricos) (CD-6).

---

## 9. Test Plan (≥1 por AC-1..AC-11)

Mocks existentes reusados: `wallet.test.ts` mockea el provider EIP-1193 (`eth_signTypedData_v4`→"0xtypedsig",
sin red real); `onchain-verifier.test.ts` mockea `createPublicClient` (`parseEventLogs` real). Asertar
valores EXACTOS (recurrente WKH-207).

| AC | Test (archivo) | Aserción |
|----|----------------|----------|
| **AC-1** | `chain.test.ts` | `NEXT_PUBLIC_CHAIN_ID="84532"` → `resolveChainId()===84532` y `resolveChain().id===84532` (baseSepolia). |
| **AC-2** | `chain.test.ts` | `="8453"` → `84532`… **no**: `===8453` y `resolveChain().id===8453` (base). |
| **AC-3** | `chain.test.ts` | unset → `84532`; `"99"` → `84532`; `"abc"` → `84532`; `"43114"`/`"43113"` (Avalanche viejo) → `84532`. Assert `resolveChainId() !== 43114 && !== 43113` (Avalanche eliminado). |
| **AC-4** | `wallet.test.ts` (Injected + WC) | flag ON + `NEXT_PUBLIC_CHAIN_ID="84532"` → `typedDataOf().domain.name === "USDC"`, `version === "2"`, `domain.chainId === 84532`. |
| **AC-5** | `wallet.test.ts` (Injected + WC) | flag ON + `="8453"` → `domain.name === "USD Coin"`, `version === "2"`, `domain.chainId === 8453`. **Unit puro** (provider mock, sin red/broadcast — CD-1 respetado: no es un settle real). |
| **AC-6** | `onchain-verifier.test.ts` | (a) stub `BASE_SEPOLIA_RPC_URL` + chainId "84532" + USDC Sepolia → V9 ok. (b) **KILLER**: `AVALANCHE_RPC_URL` seteado PERO `BASE_SEPOLIA_RPC_URL` vacío → `settle_unverified` sin leer la cadena (prueba que ya NO lee el env viejo). |
| **AC-7** | `chain.test.ts` | `NETWORKS[84532].canonicalUsdc === "0x036CbD53842c5426634e7929541eC2318f3dCF7e"` y `NETWORKS[8453].canonicalUsdc === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"` (match facilitator). + `resolveUsdcAddress()` sigue env-driven fail-loud (test existente preservado). |
| **AC-8** | `wallet.test.ts` (Injected + WC) | flag OFF (default) + chainId "84532" y default → `personal_sign` llamado, `eth_signTypedData_v4` NO → `tx === "0xsignature"` (byte-idéntico). |
| **AC-9** | proceso/CD (no unit) | NINGÚN test hace I/O de red con chainId 8453 (los tests 8453 son assert-only sobre el typed-data). Validación e2e real gated a 84532 (checklist §11). Grep de review: no `getTransactionReceipt`/broadcast real con 8453. |
| **AC-10** | `wallet.test.ts` | `domain.chainId === resolveNetworkConfig().chainId === resolveChainId()` (fuente única) → principal-in y payout (WKH-208 USDCBASE) en la misma red por construcción, sin mezclar cadenas. |
| **AC-11** | `onchain-verifier.test.ts` + `chain.test.ts` | `resolveRpcUrl()` undefined (env ausente) → `settle_unverified` (V1). `resolveUsdcAddress()` con env malformada → throw (test existente). Fail-closed, no default silencioso a otra red. |

**Tests de blast-radius (W1.4, no mapean a AC nuevos pero deben quedar verdes — CD-11/CD-12):**
`settle/principal/route.test.ts` (`eip155:84532`, `BASE_SEPOLIA_RPC_URL`), `payout/submit/route.test.ts`
(cross-env replay reescrito a 84532/8453), `payout/challenge/route.test.ts` (`ch.chainId===84532`).

**Regresión byte-identidad (CD-9):** la suite completa de `wallet.test.ts` "flag OFF" y los tests de
`connect()`/switch-suave (con `CHAIN_MAINNET_HEX` actualizado al hex de Base) siguen verdes.

---

## 10. Tabla de riesgo (heredada + refinada)

| Riesgo | Sev | Mitigación en este SDD |
|--------|-----|------------------------|
| Domain `name` incorrecto para Base Sepolia (`"USD Coin"` en vez de `"USDC"`) → firma inválida | ALTA | DT-3 tabla por chainId + AC-4/AC-5 tests + CD-4. Valores verificados §3. |
| `AVALANCHE_RPC_URL` sigue leyéndose → verifica la cadena equivocada | ALTA | `resolveRpcUrl()` (DT-2) + AC-6 killer test + CD-6 grep-clean. |
| Blast-radius de tests bajo-estimado (work-item nombra 3, real son 6+) → `npm run qa` rojo sorpresa | ALTA | §6.1 tabla explícita + CD-12 (recurrente WKH-207) + gate W1 en TODO el repo. |
| Confundir 84532 (Sepolia) con 8453 (mainnet) en un env → firma real contra mainnet | ALTA | CD-1 + AC-9 + default fail-safe testnet (DT-5) + checklist deploy manual (§11). |
| `wasiai-facilitator` sin `BASE_SEPOLIA_ENABLED` → settle 400/404 | MEDIA | §11 nota ops (checklist antes de F3/validación). |

---

## 11. Missing Inputs / Residuales

- **[RESUELTO]** DT-1 (swap) — cerrado en HU_APPROVED.
- **[RESUELTO §4]** DT-2 (env RPC = `BASE_SEPOLIA_RPC_URL`/`BASE_MAINNET_RPC_URL`) y AC-3/DT-5 (default = 84532).
- **[NEEDS CLARIFICATION — no bloqueante, operativo]** Confirmar que el deploy de `wasiai-facilitator`
  usado por chaski-v2 (`FACILITATOR_BASE_URL`) ya tiene `BASE_SEPOLIA_ENABLED=true` + `BASE_SEPOLIA_RPC_URL`
  seteados ANTES de que F3/F4 valide un settle real e2e. Es ops (fuera del código de esta HU, CD-5). NO
  bloquea la implementación ni el `npm run qa` (que no toca red); bloquea SOLO la validación e2e opcional.
- **[NOTA no bloqueante — decisión de presentación]** `src/presentation/flow.tsx:536` muestra la label
  hardcodeada `"en Avalanche"`, factualmente incorrecta tras el swap. Es presentación pura (no money-path).
  **Recomendación del Architect:** actualizar a `"en Base"` (1 línea) para no mentir en la UI del demo —
  no viola AC-8 (AC-8 es sobre el path de firma, no el copy). Queda FUERA del Scope IN de código por
  decisión conservadora (el work-item no la lista); si el founder lo aprueba, es un 1-liner trivial en
  W1.3. NO bloquea Readiness (es cosmético y no afecta el settlement).

---

## 12. Readiness Check

| Ítem | Estado |
|------|--------|
| DT-1 (swap) cerrado y NO reabierto | ✅ |
| DT-2 (env RPC) resuelto — `BASE_SEPOLIA_RPC_URL`/`BASE_MAINNET_RPC_URL` (patrón facilitator) | ✅ |
| DT-5 / AC-3 (default fail-safe) resuelto — **84532 Base Sepolia**, justificado (money-path) | ✅ |
| Valores canónicos verificados contra `wasiai-facilitator/src/chains/base.ts` (addresses + eip712 name/version) | ✅ |
| Shape real de `chain.ts`/`wallet.ts`/`onchain-verifier.ts` verificado con Read (líneas citadas) | ✅ |
| Contrato exacto de la tabla `NetworkConfig` + los 3 helpers definido (§7) | ✅ |
| Blast-radius de tests enumerado (grep real) — 6 breakers + 4 data-only (§6.1) | ✅ |
| Test Plan ≥1 por AC-1..AC-11 (§9), incl. domain "USDC"/"USD Coin", killer RPC, byte-idéntico OFF, fail-closed, PROHIBIDO mainnet real | ✅ |
| CDs heredados (CD-1..5) + específicos (CD-6..12, incl. patrones recurrentes de Auto-Blindaje) | ✅ |
| Waves ordenadas (W0 contrato serial → W1 paralelo) con gates `npm run qa` | ✅ |
| `[NEEDS CLARIFICATION]` restantes son NO bloqueantes (ops facilitator + label UI) | ✅ |
| DT-4/CD-8: `resolveUsdcAddress`/`resolveReceiverAddress` byte-idénticas; guard-order intacto (CD-2); flag no se enciende (CD-3) | ✅ |

**Veredicto: READY para SPEC_APPROVED.** No hay TBDs bloqueantes. Los 2 residuales (activación ops del
facilitator, label `flow.tsx`) son no bloqueantes y quedan documentados para el gate humano.
