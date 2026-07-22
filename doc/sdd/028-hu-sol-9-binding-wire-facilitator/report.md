# Report — HU-SOL-9 / WKH-208: Binding no-custodial + wire Solana al facilitator

**Status**: DONE
**Fecha**: 2026-07-22
**Branch**: `feat/028-hu-sol-9-binding-wire-facilitator` @ `a177825` (merged a `main` en `f9de773`)

## Resumen ejecutivo

Ramifica por VM la validación/comparación de address (base58 cuando `vm==="solana"`) en `deposit-attestation.ts`, `settle/principal/route.ts` (B6/S12/S13) y `prepare/route.ts` (PR4), reusando `canonicalizeAddress` (HU-SOL-7). Agrega `SolanaDepositAttestation` HMAC (tipos SEPARADOS del EVM, anti-forja/replay cross-cluster), `resolveSolanaReleaseAuthorityPubkey()` env-driven server-side (la consume HU-SOL-13 para firmar `release`), y `verifySolanaSettlement` que arma el envelope x402 `solana:<cluster>` base58 (verify-only, NO broadcast). **EVM byte-idéntico** (648 tests, payload EIP-3009 sin mutar). Fix-pack AR+CR MNR-1: `addressEqualsVm` extraído a `src/infrastructure/address.ts` con tests de ambas ramas (incluye case-sensitivity anti-IDOR base58).

## Cadena de gates
- F3: 642 → fix-pack → **648 tests**, tsc 0 completo.
- AR: APROBADO — 7 vectores (atestación forja/replay HMAC, release-authority server-side, envelope discriminado EIP-3009 intacto, IDOR base58, no-broadcast, EVM byte-idéntico, cobertura), 0 BLOQUEANTEs, 1 MENOR (resuelto).
- CR: APROBADO — 0 BLOQUEANTEs, 1 MENOR (mismo, resuelto en fix-pack).
- F4 QA: APROBADO PARA DONE — 6/6 ACs PASS con evidencia archivo:línea, EVM byte-idéntico (0 diff en route tests principales), drift NONE.

## Acceptance Criteria (6/6 PASS — evidencia en validation.md)
| AC | Evidencia |
|----|-----------|
| AC-1 VM-branch base58 en 3 sitios | `deposit-attestation.ts`, `settle/principal/route.ts` (B6/S12/S13 vía `addressEqualsVm`), `prepare/route.ts` (PR4) |
| AC-2 EVM byte-idéntico | `settle/principal/route.test.ts`/`route.static.test.ts` 0 diff; payload EIP-3009 `toEqual` byte-idéntico |
| AC-3 payload Solana representable | `facilitator-client.ts` (`network:"solana:devnet"`, asset/payTo/signature/reference base58, SIN authorization) |
| AC-4 release-authority + `to`==beneficiary | `chain.ts::resolveSolanaReleaseAuthorityPubkey` env-driven fail-loud; binding definido (resolución runtime = HU-SOL-13) |
| AC-5 anti-replay fail-closed no-oracle | `deposit-attestation.ts` HMAC-primero, colapsa a `null` en cada paso, sin eco de motivo |
| AC-6 refund trustless no bloqueado | nunca hardcodea `beneficiary`, solo atesta/compara |

## Diseño clave
- **DT-2**: `SolanaDepositAttestation` + funciones SEPARADAS (no tocar el tipo EVM) → EVM byte-idéntico por construcción.
- **DT-4**: `verifySolanaSettlement` verify-only (NO broadcast) — el broadcast es HU-SOL-14.
- **DT-3**: la resolución runtime del `beneficiary`/depositAddress Solana se difiere a HU-SOL-13 por diseño.
- Fix-pack: `addressEqualsVm(a,b,vm)` en `address.ts` (evm=`isAddressEqual`, solana=`canonicalizeAddress` case-sensitive fail-closed).

## Archivos
Modificados: `chain.ts`, `settlement/deposit-attestation.ts`, `settlement/facilitator-client.ts`, `infrastructure/address.ts`, `app/api/settle/principal/route.ts`, `app/api/payout/prepare/route.ts` + tests. Creado: `settlement/facilitator-client.test.ts`.

## Follow-ups para el founder
1. **Companion WF (schema Zod del facilitator)** — DIFERIDO: `AcceptedSchema` del facilitator rechaza base58 en `asset`/`payTo`; sin él, el código chaski es correcto+unit-testeado pero NO HTTP-reachable e2e. Diseñado en `sdd.md §4.5` (3ª rama `SolanaRequestSchema` al `z.union`, sin tocar EVM). Candidato a agrupar con HU-SOL-13 o sub-HU del facilitator (prod, founder-gated).
2. **PR8/depositAddress + resolución real de `beneficiary`** — diferido a HU-SOL-13 (DT-3).
3. **Release-authority pubkey** — `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`; el founder setea el env; la consume HU-SOL-13.
