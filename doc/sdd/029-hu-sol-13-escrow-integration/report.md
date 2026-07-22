# Report — HU-SOL-13 / WKH-216: Integración del escrow (deposit + verify vault + release + refund)

**Status**: DONE
**Fecha**: 2026-07-22
**Cross-repo, 3 waves**:
- chaski-v3 (13a): branch `feat/029a-hu-sol-13a-escrow-chaski` @ `e9f494a` — 676 tests, tsc 0.
- wasiai-facilitator (13b+13c): branch `feat/029bc-hu-sol-13bc-escrow-facilitator` @ `d0ae09d` (HELD) — 979 tests, tsc 0.

## Resumen ejecutivo

Cablea el escrow Anchor (solana-programs, devnet) al money-path no-custodial de Chaski. El sender deposita USDC al **vault del escrow** (no directo a TransFi); el facilitator lee el estado on-chain, verifica (`status==Deposited`, `mint==USDC`, `vault.amount>=state.amount`) y —tras KYC+orden TransFi— firma+broadcastea el `release` a beneficiary; el sender recupera fondos vía `refund` trustless post-deadline si el off-ramp falla. Flag OFF, devnet, cero plata real. **7/7 ACs PASS. EVM byte-idéntico ambos repos (0 assertion EVM cambiada).**

## Cadena de gates
| Fase | 13a (chaski) | 13bc (facilitator) |
|------|--------------|--------------------|
| F3 | 666→676 tests | 973→979 tests |
| AR | RECHAZADO (BLQ-MED-1 flow-vm) → fix-pack → CERRADO | APROBADO (10 vectores, 0 BLQ, 2 MENOR) |
| CR | APROBADO (0 BLQ, 1 MENOR resuelto) | APROBADO (0/0, primitiva de 14 intacta) |
| F4 | APROBADO PARA DONE | APROBADO (tras fix higiene git del test) |

**El AR cazó un BLOQUEANTE que 666 tests verdes ocultaban**: `flow-vm.isFallbackWalletAddress` canonicalizaba el FALLBACK EVM `0xDEMO…` bajo `vm=solana` → throw → el `RemittanceFlow` completo crasheaba → el money-path Solana **no se podía ni renderizar**. Fix: try/catch fail-safe (patrón ya usado en `addressEqualsVm`); test T8 prueba el render full-flow bajo vm=solana.

## Acceptance Criteria (7/7 PASS)
| AC | Wave | Evidencia |
|----|------|-----------|
| AC-1 deposit cableado server-side | 13a | `confirm-and-send.ts:137-176` + T1 |
| AC-2 verify vault on-chain misma invocación | 13b | `solana-escrow.ts:210-221` + TF1/TF2 |
| AC-3 release autorizado | 13c | `routes/solana-escrow.ts:238-270` + `build-release.ts:52-57` (beneficiary de state) |
| AC-4 release NO autorizado rechazado | 13c | TF4/TF6: attestation inválida/status≠Deposited/vault mismatch → 422 sin firmar |
| AC-5 release no-replayable | 13c | `solana-escrow-release-dedup.ts` UNIQUE(escrow_pda) claim-first → 409; TF7 |
| AC-6 refund trustless post-deadline sender-signed | 13a | `solana-wallet.ts:156-227` + T6 |
| AC-7 refund bloqueado/oculto pre-deadline | 13a | `flow.tsx:816-820` + T7 |

## Diseño clave
- **13a**: rama `vm=solana` en `confirm-and-send.ts` (9º param opcional `solana`, mutuamente excluyente con `settlement?` EVM → byte-idéntico por construcción); `SolanaSettlementGateway` (puerto nuevo); route forward server-only con Bearer; `refundEscrow` sender-signed. Flag `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` OFF default.
- **13b**: `readEscrowState` vía `BorshAccountsCoder` (IDL Anchor pinneado; decodifica CUENTA, no tx) + `verifyVault` (BigInt, `>=` tras fix MNR-2 que cierra el griefing DoS del dust).
- **13c**: `validateReleaseForSponsor` (CR-1 del release: release-authority solo en idx0, beneficiary/sender/mint on-chain, discriminator) + **reuso de `cosignAndBroadcast` de HU-SOL-14 sin modificarla** (release-authority como `feePayerKeypair`) + dedup fail-closed. Migración `004` PENDING-DEPLOY.

## Follow-ups para el founder / HU-SOL-11 (CRÍTICOS para el e2e)
1. **[H1 — BLOQUEANTE del e2e real]** `/api/payout/prepare` NO devuelve `{beneficiary, authority}` para Solana ni invoca `resolveSolanaReleaseAuthorityPubkey()` — hoy el prepare Solana real fallaría fail-closed (seguro, pero el money-path NO funciona e2e). **DEBE extenderse antes de flipear el flag** (parte de HU-SOL-11).
2. **[NC-2] wire-format**: el companion Zod del facilitator (de HU-SOL-9) + la atestación KYC+TransFi real siguen founder-gated.
3. **[NC-1] deposit-address / beneficiary real de TransFi Solana**: hasta que el agente de payout exponga pubkey Solana, el prepare usa beneficiary devnet.
4. **Facilitator HELD**: merge (orden `026→027→13bc`) + deploy Railway + migración `004` + release-authority keypair (`SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY`) + attestation secret = prod, founder-gated.
5. **[H2]** guards de `container.ts` (mutua exclusión) sin test dedicado — TD menor.

## CDs respetados
CD-1..CD-18 verificados (solana-programs intacto, EVM byte-idéntico, release solo tras read on-chain, beneficiary de state, dedup fail-closed, refund sender-only, reuso de la primitiva sin reimplementar, browser-safety, etc.).
