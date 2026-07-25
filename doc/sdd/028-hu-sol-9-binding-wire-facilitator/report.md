# Report — HU-SOL-9 / WKH-208: Binding no-custodial + wire Solana al facilitator

**Status**: DONE
**Fecha**: 2026-07-22
**Branch**: `feat/028-hu-sol-9-binding-wire-facilitator` @ `a177825` (merged a `main` en `f9de773`)

## Resumen ejecutivo

Ramifica por VM la validación/comparación de address (base58 cuando `vm==="solana"`) en `deposit-attestation.ts`, `settle/principal/route.ts` (B6/S12/S13) y `prepare/route.ts` (PR4), reusando `canonicalizeAddress` (HU-SOL-7). Agrega `SolanaDepositAttestation` HMAC (tipos SEPARADOS del EVM, anti-forja/replay cross-cluster), `resolveSolanaReleaseAuthorityPubkey()` env-driven server-side (la consume HU-SOL-13 para firmar `release`), y `verifySolanaSettlement` que arma el envelope x402 `solana:<cluster>` base58 (verify-only, NO broadcast). **EVM byte-idéntico** (648 tests, payload EIP-3009 sin mutar). Fix-pack AR+CR MNR-1: `addressEqualsVm` extraído a `src/infrastructure/address.ts` con tests de ambas ramas (incluye case-sensitivity anti-IDOR base58).

## Addendum — Wave W4 (facilitator schema base58) · 2026-07-22

El chaski-side (arriba) ya estaba mergeado; el net-new de esta iteración fue la **Wave W4** en `wasiai-facilitator`, que cierra el gate HTTP que hasta hoy rechazaba (400 `INVALID_PAYLOAD`) todo request Solana antes del dispatch por namespace. Con el repo `wasiai-facilitator` montado en el workspace, el orquestador levantó CD-4 solo para el schema Zod (CD-4' blinda el resto del facilitator).

**Cambios** (`wasiai-facilitator`):
- `src/methods/eip3009/schemas.ts` — `Base58PubkeySchema` (`new PublicKey` try/catch) + `Base58SignatureSchema` (regex base58 + len 64-120), consistentes con `isBase58Pubkey/Signature` del `solana-adapter` (CD-9).
- `src/core/schemas.ts` — `SolanaAcceptedSchema`/`SolanaPayloadSchema`/`SolanaRequestSchema` (`.strict()`, sin `extra`/`authorization`) agregados como **3ª rama del `z.union`** (última → primera-que-matchea preserva byte-identidad EVM). Desacople runtime(3 ramas)/tipo-estático(`VerifyRequest` EVM-only) vía cast de frontera sancionado `as unknown as z.ZodType<VerifyRequest,…>` (mismo patrón de `core/settle.ts:144`) — así los consumers EVM (`core/settle.ts`, `routes/*`) compilan sin narrowing y un request Solana nunca se lee como EVM (early-return al adapter en `namespace==='solana'`).
- Tests: `core.schemas.solana.test.ts` (TF1-TF3 + 4 negativos del fix-pack CR) + `routes.settle.solana.test.ts` (TF4: body Solana ya NO da 400, alcanza dispatch → 503 `CHAIN_UNAVAILABLE` con adapter OFF).

**Gates W4**: AR APROBADO (5 vectores con repro ejecutable, 0 BLQ) · CR APROBADO (0 BLQ) · F4 APROBADO (`npm run qa` exit 0: typecheck+lint+format:check+test). **997 tests (73 files), 979 EVM byte-idénticos.**

**Branch**: `wasiai-facilitator` @ `feat/m5-escrow-dr5g-address` (contiene también el fix BBQ9→DR5G) — pendiente de merge a `main` + redeploy Railway (founder-gated, junto con HU-SOL-6/13bc HELD).

**Carry-forward → HU-SOL-13**: AR-MNR-2 — `routes/settle.ts:287,339,381` persisten el settle Solana con `method:'eip3009'` hardcodeado (telemetría mislabeleada, no rompe funcionalidad). Fuera de scope acá (CD-4'); a resolver en el wiring del escrow (waves 13b/13c).

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
