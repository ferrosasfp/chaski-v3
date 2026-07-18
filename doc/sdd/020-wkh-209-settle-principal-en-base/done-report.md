# Report — [WKH-209] Mover el settlement del principal de Chaski de Avalanche a Base

**Status**: DONE (2026-07-17) · **NNN**: 020 · **Branch**: `feat/020-wkh-209-settle-principal-en-base` · **Metodología**: QUALITY (M)

## Resumen ejecutivo

Por la decisión del founder de usar **Base** como red del corredor (TransFi no soporta USDC en Avalanche pero sí en Base — WKH-208), esta HU mueve el settlement del principal (EIP-3009 de WKH-168) de Avalanche a **Base**, parametrizado por red. Todo sandbox/testnet (Base Sepolia), cero plata real, flag `NEXT_PUBLIC_EIP3009_ENABLED` OFF por default (demo byte-idéntico).

**Hallazgo crítico resuelto:** el USDC de **Base Sepolia** firma EIP-712 con `domain.name="USDC"`, mientras el de **Base mainnet** usa `"USD Coin"` (ambos version "2"). El código hardcodeaba `"USD Coin"` para ambos wallets → en Base Sepolia el `DOMAIN_SEPARATOR` no habría coincidido con el contrato y la firma sería inválida. Ahora el domain se resuelve por red desde una tabla única.

## Qué cambió

- **`src/infrastructure/chain.ts`** — tabla `NETWORKS` keyed por chainId + tipo `NetworkConfig{chainId, viemChain, canonicalUsdc, eip712{name,version}, rpcEnvVar}`. 2 entradas:
  - Base Sepolia (84532): USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, name `"USDC"`, RPC `BASE_SEPOLIA_RPC_URL`.
  - Base mainnet (8453): USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, name `"USD Coin"`, RPC `BASE_MAINNET_RPC_URL`.
  - Resolvers: `resolveChainId` (default fail-safe = **84532**, nunca Avalanche), `resolveNetworkConfig`, `resolveChain`, `resolveRpcUrl` (switch sobre unión literal, type-safe), `resolveUsdcAddress` (env-driven fail-loud). Avalanche ELIMINADO (viem `base`/`baseSepolia`).
- **`src/infrastructure/wallet.ts:104,258`** — domain EIP-712 (name/version/chainId/verifyingContract) por red desde `resolveNetworkConfig()`. Rama flag-OFF (personal_sign) byte-idéntica.
- **`src/infrastructure/settlement/onchain-verifier.ts:59`** — RPC de Base vía `resolveRpcUrl()`, nunca `AVALANCHE_RPC_URL`; V1 fail-closed si falta.
- **`src/presentation/flow.tsx:537`** — label UI data-driven `en {resolveChain().name}` (antes "en Avalanche" hardcodeado). Client-safe (solo lee `NEXT_PUBLIC_CHAIN_ID`).
- **`.env.example`** — bloques Chain/USDC/RPC → Base (Sepolia/mainnet), sin residuos de Avalanche, nota del split name-por-red.
- **11 tests migrados** — incluye el replay cross-env de `payout/submit` preservando 2 chainIds distintos (deployment 84532 / foránea 8453 — semántica A7″ de WKH-168 intacta).

## Pipeline

| Fase | Resultado |
|------|-----------|
| F0+F1 | HU_APPROVED (11 ACs EARS). DT-1 (swap vs multi-red) resuelto = swap a Base parametrizado. |
| F2 | SPEC_APPROVED. Tabla NETWORKS, RPC env BASE_*, default Base Sepolia, blast-radius ampliado. |
| F2.5 | Story File, 6 waves, label fix incluido, sin [SDD-GAP]. |
| F3 | 460 tests (451→460), 3/3 mutantes muertos+restaurados, grep MUTANT=0, guard-order intacto. |
| AR | APROBADO 0 BLQ — mutante del domain-name muerto EN VIVO (corazón de la firma atado). 1 MENOR (MNR-1). |
| CR | APROBADO 0 BLQ — parametrización limpia, Avalanche eliminado, type-safe. 1 MENOR (MNR-1). |
| F4 | APROBADO — 11/11 ACs con evidencia archivo:línea, 460/460, 0 drift, flag OFF. |

## ACs — 11/11 PASS (evidencia en validation/F4)
AC-1/2 resolveChainId→84532/8453 · AC-3 default Base Sepolia · **AC-4 name="USDC" Sepolia** · **AC-5 name="USD Coin" mainnet** · AC-6 RPC de Base fail-closed (killer test) · AC-7 USDC canónico por red fail-loud · AC-8 byte-idéntico OFF · AC-9 solo Base Sepolia testnet (tests 8453 = unit puros) · AC-10 coherencia red principal-in/payout · AC-11 fail-loud si falta env.

## Residual (MNR-1, diferido por recomendación de AR+CR)
`app/api/a2a/payout/submit/route.ts:245-246,251` — comentarios stale que referencian Fuji/43114/`chain.ts:9-13` (el fallback ahora es 84532). **Cero impacto runtime** (la afirmación funcional "resolveChainId no tira" sigue siendo verdadera). No se tocó porque CD-2 prohíbe modificar ese `route.ts` en esta HU. **A barrer en la próxima HU que toque `submit/route.ts`** (candidata: la HU de envío on-chain + webhook receiver).

## Prerequisitos ops (founder, para el settle real en testnet — gateado)
1. `wasiai-facilitator` (deploy que consume Chaski) con `BASE_SEPOLIA_ENABLED=true` + `BASE_SEPOLIA_RPC_URL`.
2. En chaski-v2: `NEXT_PUBLIC_CHAIN_ID=84532`, `BASE_SEPOLIA_RPC_URL`, USDC address canónica de Base Sepolia, y (cuando se valide el e2e) `NEXT_PUBLIC_EIP3009_ENABLED=true` — SOLO testnet, cero plata real.
