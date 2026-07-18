# Report — [WKH-211] Value-delivery no-custodial: el USDC va directo al depositAddress de TransFi

**Status**: DONE (2026-07-18) · **NNN**: 022 · **Branch**: `feat/022-wkh-211-non-custodial-deposit-flow` · **Metodología**: QUALITY (XL) — la HU de seguridad más crítica del proyecto

## Resumen ejecutivo

Cierra el value-delivery real de la remesa **de forma no-custodial**: el USDC del sender va **directo al `depositAddress` que TransFi asigna por orden** (EIP-3009 `transferWithAuthorization` con `to=depositAddress`), sin que la plataforma custodie los fondos en el medio. Es un **cambio de modelo de seguridad**: el `to` pasa de un receiver de plataforma ESTÁTICO a uno DINÁMICO por remesa, atado criptográficamente (HMAC) para que nadie pueda inyectar una dirección ajena y desviar el USDC. Todo flag-gated OFF (código muerto), Base Sepolia testnet, cero plata real.

**Enfoque (Opción B, decidido por el founder):** endpoint nuevo `/api/payout/prepare` que crea la orden TransFi + emite una **DepositAddress Attestation** HMAC, ANTES del settle; el guard de `/api/settle/principal` valida esa atestación.

## Qué se construyó (7 waves, 14 archivos nuevos + wiring)

- **`src/infrastructure/settlement/deposit-attestation.ts`** (nuevo) — `DepositAttestation {remittanceId, quoteId, depositAddress, chainId, exp}`, HMAC-SHA256, secreto **nuevo separado** `DEPOSIT_ATTESTATION_SECRET`, TTL 10 min, verify HMAC-first timing-safe null-ante-todo (mirror byte-a-byte de `attestation.ts`). Sin claim-once (el nonce EIP-3009 determinístico hace el doble-settle contract-imposible).
- **`app/api/payout/prepare/route.ts`** (nuevo) — guard-order PR1-PR11 fail-closed: base 501 → secreto 503 → rate-limit → formato → **autoridad KYC WKH-202 (403)** → **PoP WKH-206 (403)** → forward al agente → exige depositAddress real (mock null → 502) → **atesta** → ledger best-effort → 200. Un caller no autorizado NUNCA obtiene atestación. NO-PII.
- **`wallet.ts:100,259`** (ambas wallets) — en modo real, `to=deposit.address` fail-loud (`throw deposit_address_missing`, sin fallback). OFF → `to=resolveReceiverAddress()` byte-idéntico.
- **`settle/principal/route.ts`** — guard doble-modo: estático (secreto ausente) byte-idéntico a WKH-209; deposit-flow B1-B6 (verifica HMAC + remittanceId/quoteId/chainId/exp + `to`≡`att.depositAddress`). **V1-V9 on-chain INTACTA** — solo cambia el VALOR de `expectedTo` (siempre server-controlado, nunca el `to` del body). AC-3: `to` no-atestado → rechazo PRE-broadcast.
- **`confirm-and-send.ts`** — reorder prepare→firmar→settle; `prepare` acoplado dentro de `settlement: {gateway, prepare}` (anti-fail-open). AC-7: prepare falla → NO firma.
- **Migración** `20260718T000000_add_prepared_status.sql` (PENDING-DEPLOY) — agrega `'prepared'` al CHECK constraint. Política de huérfanas (registro `'prepared'`).

## Pipeline

| Fase | Resultado |
|------|-----------|
| F0+F1 | HU_APPROVED (8 ACs). Binding=B (founder), cross-repo=WKH-212 done. |
| F2 | SPEC_APPROVED. DepositAttestation, guard reescrito tan fuerte (DT-3), guard 8 intacto (DT-2), huérfanas (DT-5). |
| F2.5 | Story, 7 waves, [SDD-GAP] acople resuelto. |
| F3 | 553 tests (501→553), guard 8 md5 idéntico, V1-V9 intacta, mutation self-checks AC-3+AC-7, grep MUTANT=0. |
| AR | **APROBADO 0 BLQ** — vector de desvío de fondos cerrado en profundidad (7 sub-ataques rechazan PRE-broadcast). El intento de mutar el guard fue bloqueado por el classifier; source verificado íntegro. 2 MENORes (reconcile/migración). |
| CR | APROBADO 0 BLQ — alta calidad, mirror fiel de attestation.ts, acople anti-fail-open. 2 MENORes. |
| F4 | APROBADO — 8/8 ACs con evidencia archivo:línea; guard 8 byte-idéntico re-verificado; guard B6 íntegro; 553/553. |

## ACs — 8/8 PASS
AC-1 to=depositAddress atestado · AC-2 atestación no-falsificable (HMAC, TTL 10, secreto separado) · AC-3 los 7 vectores de inyección rechazan pre-broadcast · AC-4 sandbox/testnet only · AC-5 byte-idéntico OFF · AC-6 WKH-168/202/206/207/209/210 no debilitados (guard 8 md5 idéntico, V1-V9 intacta) · AC-7 prepare falla → no firma · AC-8 no-PII.

## Residuales → WKH-213 (task #40, fund-safe)
- **MNR-1**: la fila de ledger `'prepared'` queda permanente (webhook filtra por STALE_STATUSES que no la incluye) → visibilidad de reconcile, no fondos. Fix de diseño: relajar `tx_hash` nullable + re-keyear el upsert por `idempotency_key`.
- **MNR-2**: migración `DROP CONSTRAINT` sin `IF EXISTS` → idempotencia de re-run.
Ambos fund-safe (CD-6 intacto: `'prepared'` nunca pasa a `principal_in`), no bloquean el e2e.

## ⛔ Antes de encender (founder + orquestador con el token de Vercel)
Todo OFF por default. Para el e2e sandbox: `NEXT_PUBLIC_EIP3009_ENABLED=true` + `DEPOSIT_ATTESTATION_SECRET` + `SETTLE_ATTESTATION_SECRET` + `PAYOUT_POP_SECRET` (chaski-v2 Vercel) + `TRANSFI_ADAPTER_READY=true` + creds (remit-agents Vercel) + aplicar la migración `add_prepared_status.sql` + el checklist de Task #35. Cero plata real (Base Sepolia testnet + sandbox TransFi).
