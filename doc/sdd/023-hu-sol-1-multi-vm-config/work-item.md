# Work Item — [WKH-206][HU-SOL-1] Config de red multi-VM (EVM + Solana) — fundación del port a Solana

## Resumen
Chaski v2 corre 100% sobre EVM (Base Sepolia/mainnet, EIP-3009). Vamos al Solana LATAM Labs y
necesitamos portar el settlement no-custodial a Solana **sin romper el path EVM vivo**. Esta HU es
la fundación: generalizar la capa de configuración de red (`chain.ts`) y el contrato de datos de
autorización (`ports.ts`) de "EVM-only" a "multi-VM" (discriminador `vm: 'evm' | 'solana'`), con una
entrada Solana configurable/resolvible. NO agrega wallet Solana, firma SPL, binding no-custodial ni
settle Solana — eso queda para HU-SOL-2 (wallet+firma) y HU-SOL-4 (binding/settle), fuera de scope
de esta HU.

## Sizing
- SDD_MODE: full
- Estimación: M
- Branch sugerido: feat/023-hu-sol-1-multi-vm-config

## Grounding (F0 — archivo:línea verificado)
- `src/infrastructure/chain.ts:12-21` — `NetworkConfig` es 100% viem-shaped: `viemChain: Chain`
  (objeto de la lib viem), `canonicalUsdc: \`0x${string}\`` (address EVM 20 bytes, checksummed),
  `eip712: {name, version}` (concepto exclusivo de EIP-712/Ethereum), `rpcEnvVar` tipado como unión
  literal de 2 valores EVM (`"BASE_SEPOLIA_RPC_URL" | "BASE_MAINNET_RPC_URL"`).
- `chain.ts:23-38` — `NETWORKS` es un `Record` keyed por `chainId: number` (84532/8453). Solana no
  tiene un "chainId" numérico equivalente — se identifica por cluster (`mainnet-beta`/`devnet`) o
  genesis hash; forzar un `number` sintético sería una mentira de tipos.
- `chain.ts:56-58, 75-79, 86-90` — `resolveChain()`, `resolveUsdcAddress()`, `resolveReceiverAddress()`
  validan con `isAddress` de viem (formato `0x` + 40 hex). El mint USDC de Solana es una `PublicKey`
  base58 (32 bytes) — `isAddress` de viem SIEMPRE rechazaría un address Solana válido; el resolver
  Solana necesita su propio validador (`new PublicKey(raw)` de `@solana/web3.js`, catch → fail-loud).
- `src/application/ports.ts:125-132` — `Eip3009Authorization` (from/to `0x`+40hex, value/validAfter/
  validBefore uint256 decimal string, nonce `0x`+64hex bytes32) es el contrato de datos que atraviesa
  `WalletPort.authorizePrincipal` (`ports.ts:197-204`) → `PrincipalSettlementGateway.settle`
  (`ports.ts:142-158`, campo `authorization: Eip3009Authorization`). Es 100% forma EIP-3009/EVM;
  Solana no tiene `from/to` en hex, `nonce` bytes32 ni "authorization" firmada offline con este shape
  (usa `Transaction`/`VersionedTransaction` + `signature` base58, o SPL `TransferChecked` con
  `blockhash` en vez de `validAfter/validBefore`).
- `ports.ts:191-208` — `WalletPort.authorizePrincipal` retorna `{ tx: string; eip3009?: {...} }`;
  el campo `eip3009` es OPCIONAL a propósito para preservar el path demo (AC-5 de HUs previas). El
  patrón "campo opcional por VM" es el precedente que esta HU debe generalizar a un tipo discriminado
  en vez de seguir apilando campos opcionales sueltos.
- `chain.ts:1-3` — comentario existente ya documenta la regla "ÚNICA fuente del chainId para AMBOS
  adapters de WalletPort" y "PROHIBIDO hardcodear el chainId en un adapter y config en el otro" — el
  mismo principio aplica al agregar Solana: una sola fuente de verdad para `vm` activo.
- `package.json:17-33` — NO existe hoy ninguna dependencia `@solana/web3.js` (ni en `dependencies` ni
  `devDependencies`). El único rastro de `@solana/*` en `node_modules` (`@solana/rpc-transport-http`)
  es una dependencia TRANSITIVA de otro paquete, no instalada explícitamente — no se puede asumir que
  vaya a persistir en un `npm install` limpio. Esta HU necesita agregar `@solana/web3.js` como
  dependencia real.
- `src/infrastructure/chain.test.ts` (98 líneas, 13 tests) — cubre `resolveChainId/resolveChain/
  resolveNetworkConfig/resolveUsdcAddress` con fixtures EVM puros (chainId 84532/8453, addresses
  `0x...`). Ninguno de estos tests debe cambiar su expectativa (AC central de esta HU).
- `doc/sdd/_INDEX.md` (WKH-209, línea ~215-241) — precedente directo: la última vez que se tocó
  `chain.ts` para agregar una red (Base, reemplazando Avalanche) fue un swap DIRECTO que ELIMINÓ el
  soporte anterior. Esta HU es DISTINTA: agrega Solana EN PARALELO sin eliminar EVM (multi-VM, no
  swap) — mismo archivo, patrón opuesto.
- No existe `src/infrastructure/solana/` ni ningún import de `@solana/web3.js` en `src/` (grounding
  negativo confirmado vía Glob).

## Acceptance Criteria (EARS)

- **AC-1 (byte-idéntico, CENTRAL):** WHILE la config de red activa resuelve a una entrada `vm: 'evm'`
  (Base Sepolia/mainnet), the system SHALL producir el mismo comportamiento observable que hoy en
  `resolveChainId`, `resolveChain`, `resolveNetworkConfig`, `resolveUsdcAddress` y
  `resolveReceiverAddress` — la suite de tests existente (`chain.test.ts`, 13 tests, y cualquier otro
  test que consuma estos exports o `Eip3009Authorization`) SHALL pasar SIN cambios de expectativa
  (fixtures, asserts, valores esperados idénticos).

- **AC-2 (config Solana resolvible):** WHEN `NEXT_PUBLIC_CHAIN_ID` (o el mecanismo de selección que
  el Architect defina en F2 para no romper AC-1) identifica la red activa como Solana, the system
  SHALL resolver una `NetworkConfig` cuya variante `vm: 'solana'` incluya el mint USDC en formato
  base58 y el cluster/RPC correspondiente, SIN usar el campo `viemChain` (irrelevante para Solana).

- **AC-3 (validación de address Solana):** WHEN se resuelve el mint USDC o cualquier address Solana
  de la config, the system SHALL validarlo instanciando `PublicKey` de `@solana/web3.js` (catch →
  fail-loud, mismo patrón que `resolveUsdcAddress` hoy con `isAddress`), NUNCA con `isAddress` de
  viem (que rechaza SIEMPRE un address base58 válido).

- **AC-4 (VmAuthorization discriminado):** the system SHALL generalizar `Eip3009Authorization` a un
  tipo discriminado `VmAuthorization` (unión con tag `vm: 'evm' | 'solana'`) donde la variante `evm`
  preserva EXACTAMENTE los mismos campos que `Eip3009Authorization` hoy (`from/to/value/validAfter/
  validBefore/nonce`, mismos formatos/regex, CD-16 uint256-decimal intacto) y la variante `solana` es
  un placeholder de tipos coherente con el formato nativo de Solana (sin implementar firma real —
  Scope OUT).

- **AC-5 (WalletPort sin romper el contrato real):** WHERE ningún adapter de `WalletPort` implementa
  todavía el path Solana (Scope OUT de esta HU), the system SHALL mantener `authorizePrincipal` y
  `PrincipalSettlementGateway.settle` operando EXCLUSIVAMENTE con la variante `evm` de
  `VmAuthorization` — ningún adapter, use-case ni ruta existente cambia su comportamiento runtime.

- **AC-6 (unwanted — VM no soportada):** IF se solicita resolver la config de una VM que no es `evm`
  ni `solana`, THEN the system SHALL fallar de forma fail-loud (throw), NUNCA devolver una config
  parcial o `undefined` silencioso (mismo criterio fail-loud que `resolveUsdcAddress`/
  `resolveReceiverAddress` hoy).

- **AC-7 (typecheck/build íntegros):** the system SHALL pasar `npm run typecheck` (`tsc --noEmit`,
  no solo `npm run build` — lección de WKH-196, `build` excluye tests) y `npm run build` sin errores
  tras el cambio de tipos, incluyendo cualquier archivo que consuma `Eip3009Authorization`
  directamente y deba migrar a la variante `evm` de `VmAuthorization` (o a un alias de compatibilidad
  que el Architect decida en F2).

## Scope IN
- `src/infrastructure/chain.ts` — generalizar `NetworkConfig`/`NETWORKS` a multi-VM, agregar entrada
  Solana (config únicamente: mint base58, cluster, RPC env var), nuevo resolver de address Solana
  (`PublicKey`-based).
- `src/application/ports.ts:125-132` — generalizar `Eip3009Authorization` → `VmAuthorization`
  (discriminado por `vm`), y los sitios que lo referencian como TIPO (`WalletPort.authorizePrincipal`
  L197-204, `PrincipalSettlementGateway.settle` L142-158) para que sigan tipando correctamente contra
  la variante `evm` sin cambiar su comportamiento.
- `package.json` — agregar `@solana/web3.js` como dependencia real (hoy ausente, ver grounding).
- `src/infrastructure/chain.test.ts` — agregar tests NUEVOS para la rama Solana (config + validación
  de address); los tests EVM existentes NO se modifican (AC-1).
- `.env.example` (si existe) — documentar las env vars nuevas de Solana (RPC, mint) como comentario,
  mismo patrón que las env vars EVM existentes.

## Scope OUT (explícito)
- **Wallet Solana / conexión / firma SPL** — HU-SOL-2. Ningún adapter nuevo de `WalletPort` para
  Solana en esta HU.
- **Binding no-custodial / settle Solana / verificación on-chain en Solana** — HU-SOL-4. Ningún
  `PrincipalSettlementGateway` ni `onchain-verifier` para Solana en esta HU.
- **El verifier de settlement** (`src/infrastructure/settlement/onchain-verifier.ts`) — no se toca.
- **Cualquier cambio al path EVM real** (`wallet.ts`, `confirm-and-send.ts`, rutas
  `/api/settle/principal`, `/api/a2a/payout/submit`) — CERO cambios de comportamiento, solo el tipo
  que consumen (variante `evm` idéntica).
- **Selección de red en la UI** (toggle EVM/Solana visible al usuario) — fuera de esta HU; el
  mecanismo de selección server/env-side que el Architect defina en F2 es interno, no UX.
- **Flags de activación de Solana en ningún ambiente compartido** — esta HU es config+tipos, sin
  wiring que dispare comportamiento nuevo observable.

## Decisiones técnicas (DT-N)
- **DT-1**: la entrada Solana en `NETWORKS` (o estructura equivalente que el Architect decida) NO usa
  `chainId: number` como key — Solana se identifica por cluster/genesis, no por chainId EVM. El
  Architect en F2 decide la estructura de indexación exacta (¿union discriminada por `vm` con dos
  Records separados? ¿un Record único keyed por string?) manteniendo AC-1 intacto.
- **DT-2**: `VmAuthorization` es una unión discriminada (`{ vm: 'evm', ...Eip3009Authorization }` |
  `{ vm: 'solana', ... }`), NO una intersección de campos opcionales — evita repetir el patrón
  "campo opcional por VM" que ya generó `eip3009?:` en `WalletPort.authorizePrincipal`
  (`ports.ts:203`). El Architect en F2 decide si `Eip3009Authorization` se mantiene como alias
  exportado (compatibilidad) o se elimina en favor de la variante `evm` de `VmAuthorization`.
- **DT-3**: el shape exacto de la variante `solana` de `VmAuthorization` es un placeholder de TIPOS
  (campos mínimos coherentes con Solana: p.ej. `from/to` base58, `amount`, `blockhash`/`nonce`
  equivalente) — NO se implementa la lógica real de firma/verificación en esta HU (HU-SOL-2/SOL-4).
  El Architect en F2 puede marcar estos campos como `[TBD]` si el shape final depende de decisiones
  de HU-SOL-2 (ej. legacy `Transaction` vs `VersionedTransaction`).
- **DT-4**: se agrega `@solana/web3.js` (no `@solana/kit`/`web3.js v2`) como dependencia — es la lib
  estable/battle-tested para `PublicKey`, coherente con el patrón "derivado de la lib" (CD-9 de
  `chain.ts:56`) que ya usa viem del lado EVM.

## Constraint Directives (CD-N)
- **CD-1 (OBLIGATORIO, la más crítica de esta HU)**: EVM byte-idéntico — CERO cambios de
  comportamiento en el path EIP-3009 / Base Sepolia / Base mainnet. Toda la suite de tests existente
  (`chain.test.ts` y cualquier otro test que importe `Eip3009Authorization` o los resolvers de
  `chain.ts`) DEBE pasar sin tocar un solo `expect(...)`. Si un test EVM necesita cambiar su
  expectativa para que esta HU compile, es una señal de que la abstracción está mal diseñada — parar
  y escalar, no forzar el cambio.
- **CD-2 (OBLIGATORIO)**: PROHIBIDO usar `isAddress` de viem para validar un address Solana (rechaza
  SIEMPRE formato base58) — el validador Solana usa `PublicKey` de `@solana/web3.js`. Y viceversa:
  PROHIBIDO usar `PublicKey` para validar un address EVM.
- **CD-3**: PROHIBIDO tocar `wallet.ts`, `confirm-and-send.ts`, `settle/principal/route.ts`,
  `submit/route.ts` en esta HU — son el path EVM real de money-path (WKH-168/202/206/207/209/211) y
  están fuera de scope. Si el cambio de tipo de `Eip3009Authorization` → `VmAuthorization` obliga a
  tocar una firma de función en esos archivos, debe ser el MÍNIMO cambio sintáctico (ej. anotar el
  tipo explícito de la variante `evm`) sin alterar lógica ni guard-order.
- **CD-4**: OBLIGATORIO `npm run typecheck` completo (no solo `npm run build`) antes de considerar la
  HU lista — lección explícita de WKH-196 (precision-loss uint256 solo visible con `tsc --noEmit`
  sobre tests).
- **CD-5**: PROHIBIDO introducir ningún flag ni env var que active comportamiento Solana runtime en
  un ambiente compartido (dev/staging/prod) — esta HU es config+tipos estáticos, sin wiring que un
  deploy pueda accidentalmente encender.
- **CD-6**: PROHIBIDO hardcodear el mint USDC de Solana o cualquier address — mismo patrón que
  `resolveUsdcAddress`/`resolveReceiverAddress` hoy (env-driven, fail-loud si falta/malformado,
  `.env.example` documenta el valor canónico solo como comentario).

## Missing Inputs
- `[NEEDS CLARIFICATION]` — mecanismo exacto de selección de VM activa: ¿una env var nueva
  (`NEXT_PUBLIC_VM`) separada de `NEXT_PUBLIC_CHAIN_ID`, o `NEXT_PUBLIC_CHAIN_ID` se generaliza a
  aceptar un identificador Solana (string, no number)? Impacta directamente el shape de `NETWORKS`
  (DT-1). NO bloqueante para F2 — el Architect puede proponer la opción técnica y el founder confirma
  en el gate `SPEC_APPROVED`.
- `[NEEDS CLARIFICATION]` — cluster Solana objetivo para esta fundación: `devnet` (recomendado, mismo
  criterio fail-safe testnet-first que Base Sepolia hoy, DT-5 de `chain.ts:41`) vs `mainnet-beta`.
  Recomendación del Analyst: `devnet` únicamente en esta HU (HU-SOL-2/SOL-4 deciden mainnet). NO
  bloqueante — default sugerido devnet si no hay respuesta explícita.
- `[resuelto en F2]` shape exacto de la variante `solana` de `VmAuthorization` (DT-3) — placeholder de
  tipos, el Architect lo cierra en F2 con margen para ajustarse en HU-SOL-2.

## Análisis de paralelismo
- Esta HU es la **fundación** del port a Solana — HU-SOL-2 (wallet+firma) y HU-SOL-4 (binding/settle)
  están BLOQUEADAS por esta HU (necesitan `VmAuthorization` discriminado y la config `NetworkConfig`
  multi-VM ya en `main`). No hay margen de paralelismo real con esas dos.
- NO tiene overlap de archivos con ninguna HU en curso conocida sobre `chaski-v2` (`chain.ts` y
  `ports.ts` no fueron tocados por WKH-210/211, las últimas HUs mergeadas). Puede correr en paralelo
  con cualquier HU futura que NO toque `chain.ts`/`ports.ts`.
- Riesgo de colisión BAJO pero real con cualquier HU futura de money-path EVM (ej. un WKH-2XX que
  agregue un campo a `Eip3009Authorization`) — si se lanza en paralelo, coordinar orden de merge
  porque ambas tocarían `ports.ts:125-132`.
