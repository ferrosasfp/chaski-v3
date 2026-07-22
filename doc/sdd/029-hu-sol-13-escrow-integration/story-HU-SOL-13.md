# Story File — #029: [WKH-216 / HU-SOL-13] Integración del escrow (chaski deposita real + facilitator verifica-vault + release + refund)

> SDD: `doc/sdd/029-hu-sol-13-escrow-integration/sdd.md` (SPEC_APPROVED)
> Work Item: `doc/sdd/029-hu-sol-13-escrow-integration/work-item.md`
> Fecha: 2026-07-22
> Sizing: **XL cross-repo** — 3 waves de negocio, 2 repos.
> Branch chaski-v3: `feat/029-hu-sol-13-escrow-integration`
> Branch wasiai-facilitator (companion, 13b/13c): stacked sobre `feat/027-wkh-217-solana-feepayer-sponsorship` (que está sobre `feat/026`). Nombre/NNN → lo asigna el orquestador ([NC-5]).
> Repos: `/home/ferdev/.openclaw/workspace/chaski-v3` + `/home/ferdev/.openclaw/workspace/wasiai-facilitator`

> **Dev lee SOLO este documento.** Todo lo necesario está acá: contratos verificados con archivo:línea sobre el código MERGEADO/real, archivos exactos por wave, prohibiciones y el gate de cada wave. Si algo NO está acá → **PARÁ y escalá al Architect** (ver §Escalation). No inventes, no asumas, no improvises.

---

## ⛔ MAPA DE REPOS Y WAVES — LEÉ ESTO PRIMERO

Esta HU se codea en **DOS repos, DOS branches distintos**. NO mezcles.

| Wave | Repo | Branch | Riesgo | Depende de |
|------|------|--------|--------|-----------|
| **13a** | `chaski-v3` | `feat/029-…` | Medio-Alto (toca `confirm-and-send.ts`) | HU-SOL-9 (merged en main), HU-SOL-14 (`/solana/sponsor`, reachability founder-gated) |
| **13b** | `wasiai-facilitator` | branch companion | **BAJO** (read-only, cero keypair) | — (paralelizable con 13a) |
| **13c** | `wasiai-facilitator` | branch companion | **ALTO** (firma release) | HU-SOL-14 mergeada (`cosignAndBroadcast`) + Wave 13b |

**Orden de merge del facilitator (lo maneja el orquestador, todo HELD/founder-gated):** `feat/026` → `feat/027` (HU-SOL-14) → companion 13b/13c. NO mergees nada vos.

**Regla de aislamiento:** el código de 13a NO importa nada de `wasiai-facilitator` y viceversa. El único contrato compartido es HTTP (`POST /solana/sponsor` de HU-SOL-14 para el deposit, y `POST /solana/escrow/release` nuevo de 13c). Cada wave se unit-testea con mocks — NO se requiere el otro repo corriendo.

---

## REGLA DE ORO (leé esto antes de tocar una línea)

> **CD-2 es la restricción dura de TODA la HU: el path EVM queda BYTE-IDÉNTICO en AMBOS repos.**
>
> 1. **chaski:** la rama Solana es un **9º parámetro opcional NUEVO `solana?`** de `ConfirmAndSend`, mutuamente excluyente con `settlement?` (EVM). PROHIBIDO widenizar `settlement` a unión discriminada (rompería la inyección del container/tests EVM — lección WKH-211). `wallet.ts`, `http-settlement-gateway.ts`, la rama `if (this.settlement)` y todos los tests EVM quedan **byte-idénticos**.
> 2. **facilitator:** TODOS los archivos nuevos de 13b/13c viven en dirs/archivos NUEVOS (`src/chains/solana-escrow.ts`, `src/methods/solana-escrow/*`, `src/infra/solana-release-authority.ts`, `src/routes/solana-escrow.ts`). Ninguna suite EVM re-assertiona. La ruta se registra SOLO opt-in-off (release-authority configurada).
> 3. **Si un `expect(...)` de un test EVM cambia para pasar → PARÁ y escalá.** Cambiar una assertion EVM = violación de proceso, no un fix.
> 4. **El release firma SÓLO tras leer+verificar `EscrowState.status==Deposited` on-chain en la MISMA invocación** (CD-3). El `beneficiary` del release SIEMPRE sale de `escrow_state.beneficiary` on-chain, NUNCA del body (CD-4).
> 5. **El refund es 100% sender-signed + sender-broadcast, sin facilitator** (CD-10). PROHIBIDO que la release-authority intervenga en el refund.
> 6. **NO se toca `solana-programs`** (CD-1). El IDL/programa Anchor devnet es inmutable — sólo se COPIA su IDL.

---

## Goal

Cablear el escrow Anchor (`solana-programs`, DONE/devnet, program id `BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA`) al money-path Solana no-custodial de Chaski, dark detrás de flags OFF:

- **13a (chaski):** rama `vm==="solana"` en `confirm-and-send.ts` que resuelve `SolanaEscrowDeposit {beneficiary, authority}` SERVER-SIDE (beneficiary del prepare TransFi; authority de `resolveSolanaReleaseAuthorityPubkey()` — YA existe merged), pasa el 3er arg de `authorizePrincipal` (HU-SOL-5 ya arma el `deposit`) y broadcastea el deposit real vía el puerto NUEVO `SolanaSettlementGateway` → `/api/settle/solana-sponsor` (chaski server) → `POST /solana/sponsor` (HU-SOL-14). Más la acción **refund** en la UI de tracking (sender-signs, post-deadline, sin facilitator).
- **13b (facilitator, read-only):** `readEscrowState` vía IDL Anchor pinneado + `verifyVault` (`status==Deposited`, `mint==USDC`, `vault.amount==state.amount`) ANTES de cualquier release.
- **13c (facilitator, high-risk):** `validateReleaseForSponsor` (CR-1 del release) + orquestación KYC+orden-TransFi + reuso de `cosignAndBroadcast` de HU-SOL-14 (release-authority keypair = `feePayerKeypair`) + dedup fail-closed anti-replay.

---

## Anti-Hallucination Checklist (verificado por el Architect en F2 — NO re-investigar)

Todo lo de abajo YA fue confirmado con Read sobre el código MERGEADO/real. Usá estos hechos tal cual:

### chaski-v3 (13a)

| # | Hecho verificado | Fuente (archivo:línea) |
|---|------------------|------------------------|
| AH-1 | `ConfirmAndSend` tiene HOY **8 params** en el constructor: `wallet, payouts, repo, clock, authority, refund, settlement?, pop?`. La rama Solana es el **9º param OPCIONAL `solana?`** (NUEVO). NO se toca la firma de los 8 existentes. | `src/application/use-cases/confirm-and-send.ts:20-57` |
| AH-2 | El bloque EVM real es `if (this.settlement) { … }` (settle EIP-3009, guards C1-C6). La rama Solana es un `if (this.solana) { … return r; }` **hermano**, insertado de forma que cuando `this.solana===undefined` el path EVM/demo queda byte-idéntico. `failAndRefund(r, reason, principalReallyIn=false)`. | `confirm-and-send.ts:65-91, 192-259` |
| AH-3 | `authorizePrincipal` se consume así: `const { tx, eip3009 } = await this.wallet.authorizePrincipal(quote, s.id, deposit)`. El return YA incluye `solana?: SolanaPrincipalAuthorization` (aditivo HU-SOL-5). La rama Solana destructura `const { solana } = await this.wallet.authorizePrincipal(quote, s.id, { address: beneficiary, escrow: { beneficiary, authority } })`. | `confirm-and-send.ts:182`; `ports.ts:239-247` |
| AH-4 | El prepare EVM no-custodial (patrón a espejar) está en `confirm-and-send.ts:137-176`: `this.settlement.prepare.prepare({...})` → `{ depositAddress, attestation, payoutId, provenance }`; si `!prep.ok` ⇒ `failAndRefund(prep.reason, false)` ANTES de firmar. | `confirm-and-send.ts:137-176` |
| AH-5 | `SolanaEscrowDeposit {beneficiary, authority, mint?}` YA existe. `SolanaPrincipalAuthorization {vm:"solana"; partialSignedTx(base64); reference(base58)}` YA existe. Los NUEVOS puertos (`SolanaSettlementGateway`, etc.) se agregan **aditivos** a `ports.ts` — NO se toca ningún tipo EVM. | `ports.ts:163-174` |
| AH-6 | **`resolveSolanaReleaseAuthorityPubkey()` YA EXISTE MERGED** (HU-SOL-9/WKH-208): env `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`, valida `new PublicKey(raw)`, fail-loud `solana_release_authority_not_configured`. **13a lo CONSUME, NO lo crea.** (El SDD §4.1 lo listaba como "crear si HU-SOL-9 no mergeó" — ya mergeó, así que solo se importa.) | `src/infrastructure/chain.ts:178-187` |
| AH-7 | Exemplar del gateway HTTP client-side: `HttpSettlementGateway` → `fetch("/api/settle/principal")`; `isRecord`/`isValidSettleShape` type-guards explícitos; `mapErrorStatus` fail-closed (409/503/504⇒unavailable, desconocido⇒rejected); red caída ⇒ reason que BLOQUEA. **Modelo directo del `HttpSolanaSettlementGateway`** (pero su `isValidSettleShape` valida `txHash` `^0x…{64}$` → NO reusar esa regex: la respuesta Solana es signature **base58**). | `src/infrastructure/settlement/http-settlement-gateway.ts:1-132` |
| AH-8 | Composition root: `wallet = resolveActiveVm()==="solana" ? new SolanaWalletAdapter() : pickWallet()` (L83-84). `settlement` se inyecta SOLO con `NEXT_PUBLIC_EIP3009_ENABLED==="true"` (L100-103). `ConfirmAndSend(...)` se construye con 8 args (L117-126). El guard fail-loud EVM está en L63-71. El nuevo `solana` se inyecta SOLO con `resolveActiveVm()==="solana"` + flag Solana ON. | `src/composition/container.ts:63-126` |
| AH-9 | `SolanaWalletAdapter.authorizePrincipal` (HU-SOL-5) YA arma el `deposit`. `remittanceIdToBytes16 = sha256(TextEncoder().encode(id))[:16]` con `@noble/hashes` (browser-safe, NO Buffer node). Deriva PDA `[Buffer.from("escrow"), senderPk.toBuffer(), Buffer.from(remittanceIdBytes)]`. Reusa TODO esto en `refundEscrow`. | `src/infrastructure/solana-wallet.ts:56-151` |
| AH-10 | IDL `refund`: discriminator `[2, 96, 183, 251, 63, 208, 46, 46]`; args `remittance_id: [u8;16]`; accounts EN ORDEN: `sender`(signer,writable), `mint`, `escrow_state`(writable,pda), `vault`(writable), `sender_ata`(writable), `token_program`(`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`), `associated_token_program`(`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`). **El sender es Signer + feePayer.** | `src/infrastructure/solana/escrow-idl.ts:168-256` |
| AH-11 | IDL `release`: discriminator `[253, 249, 15, 206, 28, 127, 193, 241]`; args `remittance_id: [u8;16]`; accounts EN ORDEN: `authority`(signer), `sender`, `beneficiary`, `mint`, `escrow_state`(writable,pda), `vault`(writable), `beneficiary_ata`(writable), `token_program`, `associated_token_program`. **`has_one authority/sender/beneficiary/mint` (declarativo).** El `authority` es el ÚNICO signer y también feePayer en 13c. | `src/infrastructure/solana/escrow-idl.ts:257-357` |
| AH-12 | IDL `EscrowState`: discriminator `[19,90,148,111,55,130,229,108]`; layout: `sender`/`beneficiary`/`authority`/`mint` (32 bytes c/u), `amount`(u64), `deadline`(i64), `status`(enum Deposited/Released/Refunded), `bump`(u8). PDA `["escrow", sender, sha256(remittanceId)[:16]]`. | `src/infrastructure/solana/escrow-idl.ts:359-395` |
| AH-13 | `TrackView` (`flow.tsx:730`) tiene una rama temprana honesta si `rem.status==="payout_failed" \|\| "refunded"` (L734-743) que ya muestra `rem.refundTx`. **Ese es el punto de inserción de la acción refund** (AC-6/AC-7). El polling en `step==="track"` frena en terminal. | `src/presentation/flow.tsx:730-744` |
| AH-14 | `RemittanceState` **NO persiste `deadline`**. El `deadlineSec` on-chain = `floor(Date.parse(quote.expiresAt)/1000)` (lo fijó HU-SOL-5). El `refundEscrow` debe leer `EscrowState.status`/`deadline` on-chain (autoritativo) antes de habilitar/broadcastear. | `solana-wallet.ts:95-96`; SDD §4.5 [NC-3] |
| AH-15 | El gate de cada wave chaski = `npm run qa` (= `tsc --noEmit` COMPLETO incluyendo tests + `vitest run`), **NUNCA** `next build` (excluye tests — lección WKH-196/210). | SDD §7 / CD-18 |

### wasiai-facilitator (13b/13c) — todos verificados sobre el branch `feat/027`

| # | Hecho verificado | Fuente (archivo:línea) |
|---|------------------|------------------------|
| AH-20 | **`cosignAndBroadcast(txBase64, opts)`** es GENÉRICO (no conoce el deposit). Firma SÓLO si el `opts.validate` inyectado ⇒ `{ok:true}`. `opts = { feePayerKeypair, validate, rpcUrl, maxFeeLamports, maxRebroadcasts, onFeeEstimated?, onFeeReleased? }`. Serialización FIFO `runExclusive(FEE_PAYER_SENTINEL_ID, …)`. NUNCA throw ⇒ `CosignResult = {ok:true; signature} \| {ok:false; code; reason}`. **13c lo REUSA TAL CUAL** pasando `feePayerKeypair = release-authority` y `validate = validateReleaseForSponsor(state)`. | `src/methods/solana-sponsor/broadcast.ts:57-218` |
| AH-21 | `type SponsorTxValidator = (tx: Transaction, feePayerPubkey: PublicKey) => {ok:true; feeUpperBoundLamports:bigint} \| {ok:false; reason:string}`. **STABLE — no cambiar.** `validateReleaseForSponsor` DEBE devolver este shape. | `broadcast.ts:57-60` |
| AH-22 | Exemplar CR-1: `validateDepositForSponsor(tx, feePayerPubkey, cfg): Cr1Result`, raw parse con `@solana/web3.js` (discriminator por bytes, `Buffer.equals`), fail-closed, top-level `try/catch` ⇒ reject. **CD-12: NUNCA anchor para validar la TX.** ⚠️ **NO copies verbatim la "Check 5" (`FEE_PAYER_REFERENCED_IN_INSTRUCTION`)**: en el `deposit` el feePayer NO debe aparecer en ninguna ix; en el `release` el feePayer (=authority) **SÍ debe** aparecer como el account `authority` (índice 0, signer). Ver §Wave 13c. | `src/methods/solana-sponsor/cr1.ts:62-201` |
| AH-23 | Exemplar de las constantes pinneadas: `deposit-shape.ts` (`ESCROW_PROGRAM_ID_DEFAULT`, `DEPOSIT_DISCRIMINATOR`, `TOKEN_PROGRAM_ID`, `ASSOCIATED_TOKEN_PROGRAM_ID`, `SYSTEM_PROGRAM_ID`, `DEPOSIT_POSITIONAL_ACCOUNTS`, `DEPOSIT_ACCOUNT_INDEX`), cada base58 con `eslint-disable no-secrets` justificado (pubkey público, no secreto). **`release-shape.ts` lo espeja** con la discr/accounts del `release` (AH-11). | `src/methods/solana-sponsor/deposit-shape.ts:1-64` |
| AH-24 | Exemplar de la keypair singleton: `solana-fee-payer.ts` — `getFeePayerKeypair()` lazy+cached desde `SOLANA_FEE_PAYER_PRIVATE_KEY` (JSON byte-array len 64, `Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env)))`), `FeePayerKeyError` con el **nombre** de la env (nunca el valor), `isSponsorEnabled()` (flag + key parseable, NUNCA throw), `resetFeePayerForTesting()`. **`solana-release-authority.ts` lo espeja** con env `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY`. | `src/infra/solana-fee-payer.ts:1-128` |
| AH-25 | Exemplar de dedup fail-CLOSED: `solana-dedup.ts` — `UNIQUE(signature)`; `{ok:false}` en no-client/error ⇒ el caller DEBE rechazar; `insert` (NO upsert-ignore) para que 23505 emerja como `inserted:false`; `amount` como decimal string (`::text`, WKH-196). **El dedup del release lo espeja** con `UNIQUE(escrow_pda)` o `(sender, remittance_id)`. | `src/infra/solana-dedup.ts:1-161` |
| AH-26 | Exemplar de migración: `003_facilitator_solana_dedup.sql` — `CREATE TABLE IF NOT EXISTS` idempotente, `NUMERIC(78,0)` para atomic u64 (leer con `::text`), sin PII, comentarios. La migración del dedup del release lo espeja (PENDING-DEPLOY, founder-gated). | `supabase/migrations/003_facilitator_solana_dedup.sql:1-32` |
| AH-27 | Exemplar de ruta: `solana-sponsor.ts` — `requireFacilitatorKey` preHandler, `z.object` route-local (NO reusa SettleRequestSchema), `fail(code, http, msg)` que loguea SOLO code/keyId (nunca body/tx), map error-code→HTTP fail-closed, `{ error: { code, message, http } }`. Registrada en `app.ts:400-401` SOLO `if (isSponsorEnabled())`. **La ruta `/solana/escrow/release` lo espeja.** | `src/routes/solana-sponsor.ts:1-203`; `src/app.ts:400-401` |
| AH-28 | El facilitator tiene HOY SOLO `@solana/web3.js ^1.98.4`. **NO** `@coral-xyz/anchor`/`borsh`. Wave 13b agrega `@coral-xyz/anchor` PINNEADO SOLO para `BorshAccountsCoder(escrowIdl).decode("EscrowState", data)` (read de cuenta, DT-4b). CD-12 NO se viola: 13b decodifica una *cuenta*, 13c parsea la *tx release* raw por bytes. NO confundir. | SDD §4.7 / `package.json` facilitator |

---

## Acceptance Criteria (EARS — copiados del SDD, QA los valida en F4)

- **AC-1** (deposit cableado, 13a): WHEN el sender confirma una remesa Solana con KYC aprobado y quote vigente, THE system SHALL invocar `authorizePrincipal(quote, remittanceId, { escrow: { beneficiary, authority } })` con `beneficiary`/`authority` resueltos SERVER-SIDE, de forma que la wallet arme+partial-firme la ix `deposit` del escrow (no una transferencia directa a TransFi).
- **AC-2** (verify vault, 13b): WHILE el facilitator procesa un `release`, THE system SHALL leer on-chain `EscrowState` (PDA `["escrow", sender, remittance_id]`) + el balance del vault ATA, y verificar `status==Deposited`, `mint==USDC configurado`, `vault.amount==escrow_state.amount` ANTES de construir/firmar cualquier `release`.
- **AC-3** (release autorizado, 13c): WHEN llega un `release` con KYC confirmado, orden TransFi completada, y destino == `escrow_state.beneficiary` (AC-2), THE system SHALL firmar el `release` con la keypair de la `authority` y broadcastearlo (vault→beneficiary_ata).
- **AC-4** (release NO autorizado, 13c): IF llega un `release` sin KYC / sin TransFi / beneficiary≠on-chain / `status≠Deposited`, THEN THE system SHALL rechazar ANTES de construir/firmar, sin transferir.
- **AC-5** (release no-replayable, 13c): IF llega un 2º `release` con `status==Released` (on-chain, AC-2) o ya procesado (dedup local), THEN THE system SHALL rechazar sin re-firmar/re-broadcastear.
- **AC-6** (refund trustless post-deadline, 13a): WHEN el sender dispara refund desde la UI con `Clock>=deadline` Y `status==Deposited`, THE system SHALL construir + permitir que el **sender** firme el `refund` (vault→sender_ata), SIN firma/aprobación de authority/facilitator.
- **AC-7** (refund rechazado pre-deadline, 13a): IF el sender intenta refund ANTES del deadline, THEN THE system SHALL bloquear/ocultar la acción en la UI (defensa en profundidad; el programa ya rechaza `DeadlineNotReached`).

---

## ═══════════════════════════════════════════════
## WAVE 13a — chaski-v3 (`feat/029-…`)
## ═══════════════════════════════════════════════

### Environment Gate (13a — verificar antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
# 1) HU-SOL-9 mergeada: el resolver de la authority existe (AH-6)
grep -q 'resolveSolanaReleaseAuthorityPubkey' src/infrastructure/chain.ts && echo "authority resolver OK" || echo "FALTA HU-SOL-9 → PARAR"
# 2) HU-SOL-5 mergeada: authorizePrincipal arma el deposit + remittanceIdToBytes16 (AH-9)
grep -q 'remittanceIdToBytes16' src/infrastructure/solana-wallet.ts && echo "deposit builder OK" || echo "FALTA HU-SOL-5 → PARAR"
# 3) IDL pinneado con release+refund (AH-10/AH-11)
grep -q '253, 249, 15, 206' src/infrastructure/solana/escrow-idl.ts && echo "release idl OK" || echo "FALTA release en IDL → PARAR"
# 4) Baseline verde ANTES de tocar nada
npm run qa   # DEBE ser exit 0. Si no → PARAR y reportar.
```

### Files to Modify/Create (13a)

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/application/ports.ts` | Modificar (ADITIVO) | +`SolanaSettlementFailureReason`, +`SolanaSettlementGateway`, +`SolanaPayoutPrepareGateway`, +`SolanaEscrowRefundGateway`. NO tocar ningún tipo EVM. | `PrincipalSettlementGateway`/`PayoutPrepareGateway`/`RefundGateway` (`ports.ts:102-104,184-228`) |
| 2 | `src/infrastructure/settlement/http-solana-settlement-gateway.ts` | **Crear** | `HttpSolanaSettlementGateway.settle({partialSignedTx, reference, sender, remittanceId, popProof?})` → `fetch("/api/settle/solana-sponsor")` → `{ok:true; signature}` \| `{ok:false; reason}`. Type-guards explícitos; signature **base58** (NO `^0x…{64}$`); fail-closed. | `http-settlement-gateway.ts` (AH-7) |
| 3 | `src/infrastructure/settlement/http-solana-prepare-gateway.ts` | **Crear** | `SolanaPayoutPrepareGateway.prepare(...)`: crea/consulta la orden TransFi, resuelve `beneficiary` (deposit-address Solana de la orden) + `authority`=`resolveSolanaReleaseAuthorityPubkey()`, emite el binding. Espeja el prepare EVM. | `http-payout-prepare-gateway.ts` (buscar en `src/infrastructure/settlement/`) |
| 4 | `app/api/settle/solana-sponsor/route.ts` | **Crear** | Ruta server-only: recibe `{partialSignedTx, reference, sender, remittanceId, popProof}`, añade `Authorization: Bearer {FACILITATOR_API_KEY}` server-side, reenvía a `POST {FACILITATOR_BASE_URL}/solana/sponsor`, devuelve `{signature}`. El browser NUNCA llama al facilitator directo (CD-6). | `app/api/settle/principal/route.ts` (server-forward pattern) |
| 5 | `src/infrastructure/solana-wallet.ts` | Modificar (ADITIVO) | +`refundEscrow(remittanceId, sender?)`: arma la ix `refund` (AH-10), **sender firma + sender broadcastea** (`bridge.signTransaction` + `connection.sendRawTransaction`). Lee `EscrowState` on-chain y aborta si `status≠Deposited` o `now<deadline`. Reusa `remittanceIdToBytes16` + derivación PDA. `connect/getAddress/signMessage/authorizePrincipal` NO se tocan. | `authorizePrincipal` (mismo archivo, AH-9) |
| 6 | `src/infrastructure/refund/solana-escrow-refund-gateway.ts` | **Crear** | `SolanaEscrowRefundGateway.refund({remittanceId, sender})` → delega en `wallet.refundEscrow` → `{refundTx: signature}`. | `src/infrastructure/refund/ledger-refund-gateway.ts` |
| 7 | `src/application/use-cases/confirm-and-send.ts` | Modificar | 9º param `solana?` + rama `if (this.solana) { … return r; }` hermana del bloque EVM (§13a.W2). EVM byte-idéntico. | patrón `settlement?` (mismo archivo, AH-1/AH-2) |
| 8 | `src/composition/container.ts` | Modificar | Inyecta `solana` (prepare+gateway) SOLO con `resolveActiveVm()==="solana"` + flag Solana ON; guard fail-loud análogo. EVM intacto. `ConfirmAndSend(...)` pasa a 9 args (el 9º undefined en EVM/demo). | `container.ts:63-126` (AH-8) |
| 9 | `src/presentation/flow.tsx` | Modificar | Acción "Recuperar fondos" en `TrackView` (AC-6/AC-7): visible SOLO si `vm==="solana"` + estado refundeable + `now>=deadline`; llama al refund gateway; **oculta** pre-deadline. | `TrackView` (`flow.tsx:730-744`, AH-13) |
| 10 | Tests (§Test Expectations) | Crear/mod | T1-T7. Regresión EVM byte-idéntica. | tests existentes |

**NO se toca (byte-idéntico):** `wallet.ts`, `http-settlement-gateway.ts`, la rama `if (this.settlement)` de `confirm-and-send.ts`, `pickWallet()`, ni ningún test EVM. **NO se crea** nada fuera de esta tabla. `chain.ts` **NO** se toca (el resolver de la authority ya existe, AH-6).

### Contrato de los puertos NUEVOS (13a.W0 — copiar tal cual)

```ts
// ── ports.ts (ADITIVO — NO tocar tipos EVM) ──
export type SolanaSettlementFailureReason =
  | "solana_settle_unavailable"       // red caída / facilitator no configurado
  | "solana_settle_rejected"          // CR-1 del deposit rechazó (422 SPONSOR_REJECTED)
  | "solana_settle_rate_limited"      // 429
  | "solana_settle_broadcast_failed"  // 409/502 (blockhash expirado / broadcast falló)
  | "solana_settle_unverified";       // shape de respuesta inválido

export interface SolanaSettlementGateway {
  settle(input: {
    partialSignedTx: string;  // base64 (= SolanaPrincipalAuthorization.partialSignedTx)
    reference: string;        // base58 (= SolanaPrincipalAuthorization.reference)
    sender: string;           // base58 wallet del depositor
    remittanceId: string;     // server-only, trazabilidad
    popProof?: string;        // PoP (HU-SOL-8) — ver Nota de wire-format
  }): Promise<
    | { ok: true; signature: string }   // base58 tx signature YA broadcasteada+confirmada
    | { ok: false; reason: SolanaSettlementFailureReason }
  >;
}

export interface SolanaPayoutPrepareGateway {
  prepare(input: {
    remittanceId: string; quoteId: string; kycVerificationId: string;
    address: string; amountUsd: number; beneficiary: Beneficiary; idempotencyKey: string;
  }): Promise<
    | { ok: true; result: { beneficiary: string; authority: string; attestation: string; payoutId: string; provenance: string } }
    | { ok: false; reason: string }
  >;
}

export interface SolanaEscrowRefundGateway {
  refund(input: { remittanceId: string; sender: string }): Promise<{ refundTx: string }>;
}
```

> **Nota de wire-format (coordinación con HU-SOL-14, [NC-2]):** el `/solana/sponsor` de HU-SOL-14 exige `popProof: z.string().min(1)` en su body (`solana-sponsor.ts:55-60`). El `HttpSolanaSettlementGateway` + la ruta `/api/settle/solana-sponsor` deben forwardear un `popProof`. En unit-test se mockea. La provisión real del PoP (HU-SOL-8) y la reachability e2e son **founder-gated** — NO las implementes acá, solo dejá el campo en el contrato y documentá el gap. El companion WF de HU-SOL-9 (Zod del facilitator) sigue pendiente; **NO asumas** un wire-format del release request — coordiná y documentá.

### Waves internas de 13a

- **13a.W0 (serial, contratos/tipos):** puertos NUEVOS en `ports.ts` (arriba). Tests T4 (consumo del resolver `resolveSolanaReleaseAuthorityPubkey` ya existente). Gate `npm run qa`, EVM byte-idéntico.
- **13a.W1 (paralelizable tras W0):** `http-solana-settlement-gateway.ts` + `http-solana-prepare-gateway.ts` + `app/api/settle/solana-sponsor/route.ts` + `solana-wallet.refundEscrow` + `solana-escrow-refund-gateway.ts`. Tests T5, T6.
- **13a.W2 (ALTO riesgo — nadie más toca `confirm-and-send.ts`):** rama `solana?` en `confirm-and-send.ts` + wiring `container.ts` (guard fail-loud) + acción refund en `flow.tsx`. Tests T1, T2, T7.
- **13a.W3 (gate + regresión):** `npm run qa` COMPLETO + suite entera verde, cero assertion EVM cambiada (T3). Mutation self-check (ver abajo).

### Rama Solana en `confirm-and-send.ts` (13a.W2 — forma exacta)

Insertá, como HERMANO del bloque EVM (nunca se atraviesan juntos):

```ts
// 9º param OPCIONAL (NUEVO). Gateway+prepare viajan ACOPLADOS: solana !== undefined ⇔ modo real Solana.
// El container lo inyecta SOLO con resolveActiveVm()==="solana" && flag Solana ON. Undefined ⇒ EVM/demo byte-idéntico.
private readonly solana?: {
  prepare: SolanaPayoutPrepareGateway;
  gateway: SolanaSettlementGateway;
},
```

En `execute()`, tras los guards comunes (confirm, authority server-side, expiry — pasos 1/2/2.5), la rama Solana:
1. **prepare** (análogo a AH-4): `const prep = await this.solana.prepare.prepare({...})`. `!prep.ok` ⇒ `await this.failAndRefund(r, prep.reason, false); return r;` (deposit NO entró).
2. **authorizePrincipal:** `const { solana } = await this.wallet.authorizePrincipal(quote, s.id, { address: prep.result.beneficiary, escrow: { beneficiary: prep.result.beneficiary, authority: prep.result.authority } })`. Si `!solana` ⇒ `failAndRefund("settlement_unverified", false)`.
3. **broadcast:** `const res = await this.solana.gateway.settle({ partialSignedTx: solana.partialSignedTx, reference: solana.reference, sender: address ?? "", remittanceId: s.id })`. Excepción ⇒ `failAndRefund("solana_settle_unavailable", false)` (patrón try/catch C3); `!res.ok` ⇒ `failAndRefund(res.reason, false)`. Ambos `principalReallyIn=false`.
4. **markPrincipalIn:** `r.markPrincipalIn(res.signature, this.clock.nowIso())` (signature base58 verificada on-chain por `/solana/sponsor`), luego `r.markPayoutSubmitted(prep.result.payoutId, this.clock.nowIso(), prep.result.provenance)` y `return r`. La release del vault la dispara el facilitator (13c) async — NO chaski.

> El bloque EVM `if (this.settlement)` (AH-2) queda **byte-idéntico**. Un container correcto NUNCA inyecta `settlement` y `solana` a la vez (el guard fail-loud lo garantiza).

### `refundEscrow` (13a.W1 — AC-6/AC-7, sin facilitator)

En `solana-wallet.ts`, método aditivo. Arma la ix `refund` (AH-10) con el sender como `sender`(signer,writable) + feePayer, reusa `remittanceIdToBytes16` + derivación PDA de `authorizePrincipal`. **Antes de firmar/broadcastear:** lee `EscrowState` on-chain (via `resolveSolanaRpcUrlPublic`/Connection) y aborta client-side si `status≠Deposited` o `now<deadline` (evita una tx que revertiría). Firma con `solanaWalletBridge.signTransaction` + `connection.sendRawTransaction`. Devuelve la signature base58. **PROHIBIDO** que la release-authority o el facilitator intervengan (CD-10). **CD-15:** libs isomórficas (`@noble/hashes`, `TextEncoder`), NUNCA builtins de Node — el test-env `node` enmascara la falla, validá el path browser.

---

## ═══════════════════════════════════════════════
## WAVE 13b — wasiai-facilitator (companion, BAJO riesgo, read-only)
## ═══════════════════════════════════════════════

> Branch companion, stacked sobre `feat/027`. **Sin dependencia dura con 13a** — puede ir en paralelo.

### Files to Modify/Create (13b)

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `package.json` | Modificar | +`@coral-xyz/anchor` PINNEADO (mismo pin que chaski, `0.30.1`) — coder IDL para decodificar `EscrowState`. SOLO para READ de cuenta (DT-4b), NUNCA para CR-1 de tx (CD-12). | — |
| 2 | `src/infrastructure/solana/escrow-idl.ts` (o `src/chains/escrow-idl.ts`) | **Crear** | Copia PINNEADA del `escrowIdl` (misma fuente inmutable que chaski, CD-1). | `chaski-v3/src/infrastructure/solana/escrow-idl.ts` |
| 3 | `src/chains/solana-escrow.ts` | **Crear** | `readEscrowState({sender, remittanceId, connection})`: deriva PDA `["escrow", sender, sha256(remittanceId)[:16]]`, `getAccountInfo`, `BorshAccountsCoder(escrowIdl).decode("EscrowState", data)`; lee vault ATA balance (`getTokenAccountBalance`). `verifyVault(state, vaultAmount)`: `status==Deposited`, `mint==SOLANA_USDC_MINT`, `vaultAmount==state.amount`. **NUNCA throw ⇒ `AdapterResult`-like fail-closed.** | `src/chains/solana-adapter.ts` (_verifyCore fail-closed) |
| 4 | Tests (§Test Expectations) | Crear | TF1, TF2. | tests HU-SOL-6/14 |

> **Paridad PDA cross-repo (CD-crítico):** la derivación de la PDA en 13b DEBE dar el MISMO resultado que chaski (`sha256(TextEncoder().encode(remittanceId)).subarray(0,16)`, AH-9). TF1 asserta esa paridad. `amount` on-chain es u64 — trátalo como **decimal string / BigInt**, NUNCA `Number()` (WKH-196/CD-18).

---

## ═══════════════════════════════════════════════
## WAVE 13c — wasiai-facilitator (companion, ALTO riesgo)
## ═══════════════════════════════════════════════

> **Depende de:** HU-SOL-14 mergeada (`cosignAndBroadcast`) + Wave 13b (read/verify). El corazón de seguridad de la HU.

### Files to Modify/Create (13c)

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/methods/solana-escrow/release-shape.ts` | **Crear** | Constantes pinneadas: escrow programId, `RELEASE_DISCRIMINATOR = [253,249,15,206,28,127,193,241]`, orden esperado de accounts (AH-11), program-ids de sistema. Cada base58 con `eslint-disable no-secrets`. | `deposit-shape.ts` (AH-23) |
| 2 | `src/infra/solana-release-authority.ts` | **Crear** | `getReleaseAuthorityKeypair(): Keypair` singleton lazy opt-in-off desde `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` (JSON byte-array len 64) + `getReleaseAuthorityPubkey()` + `isReleaseEnabled()` + `resetForTesting()`. NUNCA loguea la key; throw con el **nombre** de la env (CD-6). | `solana-fee-payer.ts` (AH-24) |
| 3 | `src/methods/solana-escrow/build-release.ts` | **Crear** | Arma la tx `release` server-side desde datos **on-chain** de `EscrowState` (beneficiary/mint/sender de `state`), `feePayer=release-authority`, `recentBlockhash` fresco; serializa base64 para `cosignAndBroadcast`. La tx tiene UN solo signer (authority), que lo pone `cosignAndBroadcast`. | `chaski solana-wallet.ts` build ix (AH-9) |
| 4 | `src/methods/solana-escrow/cr1-release.ts` | **Crear** | `validateReleaseForSponsor(state): SponsorTxValidator` — factory que captura el `EscrowState` on-chain y devuelve el validador estructural fail-closed. Ver §CR-1 del release. | `cr1.ts` (AH-22) |
| 5 | `src/infra/solana-escrow-release-dedup.ts` | **Crear** | Anti-replay del release (AC-5/CD-9): `UNIQUE(escrow_pda)` o `(sender, remittance_id)` fail-CLOSED. `{ok:false}` en no-client/error ⇒ reject. Claim mutar-primero. | `solana-dedup.ts` (AH-25) |
| 6 | `supabase/migrations/00N_facilitator_solana_release_dedup.sql` | **Crear** | Tabla/UNIQUE para el dedup del release (idempotente, sin PII, PENDING-DEPLOY founder-gated). | `003_facilitator_solana_dedup.sql` (AH-26) |
| 7 | `src/routes/solana-escrow.ts` | **Crear** | `POST /solana/escrow/release`: `requireFacilitatorKey` → orquestación (KYC+orden-TransFi) → `readEscrowState`+`verifyVault` (13b, MISMA invocación) → dedup claim → `build-release` → `cosignAndBroadcast(tx, {feePayerKeypair: getReleaseAuthorityKeypair(), validate: validateReleaseForSponsor(state), rpcUrl, maxFeeLamports, maxRebroadcasts})` → `{signature}`. Opt-in-off. | `solana-sponsor.ts` (AH-27) |
| 8 | `src/app.ts` | Modificar | Registrar `/solana/escrow/release` SOLO `if (isReleaseEnabled())` (opt-in-off). EVM intacto. | `app.ts:400-401` (AH-27) |
| 9 | Tests (§Test Expectations) | Crear | TF3-TF8. | tests HU-SOL-14 |

### Orquestación de `POST /solana/escrow/release` (ANTES de firmar — todo fail-closed)

1. `requireFacilitatorKey` (caller = chaski server).
2. KYC/PoP confirmado + **orden TransFi completada/confirmada** ([NC-2]: atestación server-firmada pasada por chaski, o query del facilitator — decisión de F3, **documentala, no la asumas hecha**). Fallo ⇒ `422 RELEASE_REJECTED` sin firmar.
3. `readEscrowState`+`verifyVault` (13b, **en esta MISMA invocación**, CD-3): `status==Deposited`, `mint==USDC`, `vault.amount==state.amount`. Cualquier fallo ⇒ reject SIN firmar.
4. **Dedup claim** (AC-5/CD-9): `UNIQUE(escrow_pda)` fail-CLOSED (mutar-primero/claim-después). Ya reclamado o store caído ⇒ `409 RELEASE_REPLAY` / reject sin firmar.
5. `build-release` desde datos **on-chain**: `beneficiary = state.beneficiary` (CD-4, NUNCA del body), `beneficiary_ata`=ATA(mint, beneficiary), `sender`=`state.sender`, `authority`=`getReleaseAuthorityPubkey()`, PDAs derivados; `feePayer`=release-authority.
6. `cosignAndBroadcast(releaseTxBase64, { feePayerKeypair: getReleaseAuthorityKeypair(), validate: validateReleaseForSponsor(state), rpcUrl, maxFeeLamports, maxRebroadcasts })` ⇒ `{signature}`.

Errores: sin echo del `EscrowState` ni del tx. Release-authority no configurada ⇒ ruta no registrada (opt-in-off) / `501`.

### CR-1 del release — `validateReleaseForSponsor(state): SponsorTxValidator`

Estructural, raw parse (`@solana/web3.js`, **NUNCA anchor** — CD-12; discriminator por bytes, patrón `cr1.ts`). Checks fail-closed (top-level `try/catch` ⇒ reject):

- `tx.feePayer` === `getReleaseAuthorityPubkey()` (la authority firma y paga).
- **exactamente 1** ix de negocio (filtrando ComputeBudget); `programId` === escrow whitelisteado.
- discriminator === `RELEASE_DISCRIMINATOR` `[253,249,15,206,28,127,193,241]`.
- account `authority` (índice 0 de la ix, AH-11) === release-authority pubkey **y es signer**; account `beneficiary` (índice 2) === `state.beneficiary` (on-chain); account `mint` (índice 3) === `state.mint`; account `sender` (índice 1) === `state.sender`. Desviación ⇒ reject (AC-3/AC-4).
- ComputeBudget acotado (heredado de `cr1.ts` checks 3).
- Devuelve `{ok:true, feeUpperBoundLamports}` o `{ok:false, reason}` (stable, PII-free, sin echo).

> ⚠️ **NO copies la Check-5 de `validateDepositForSponsor` (`FEE_PAYER_REFERENCED_IN_INSTRUCTION`).** En el `deposit` el feePayer NO puede aparecer en ninguna ix. En el `release` el feePayer (=authority) **SÍ debe** aparecer como el account `authority` (índice 0, signer) — es legítimo y requerido. La defensa anti-drain equivalente para el release es: la release-authority puede aparecer ÚNICAMENTE como el account `authority` (índice 0) de la única ix `release` whitelisteada, y en NINGÚN OTRO lado (ninguna ix inyectada la usa como source/authority de Transfer/Close/SetAuthority). Verificalo explícitamente. La garantía money-path final la dan además la orquestación (paso 3, on-chain) + el programa Anchor (`has_one authority/beneficiary/sender/mint`, CEI `status=Released` antes del CPI). Doble red.

---

## Constraint Directives (heredados del work-item + SDD — todos vigentes)

### OBLIGATORIO
- **CD-2** EVM byte-idéntico en AMBOS repos; ningún test EVM cambia assertion.
- **CD-3** El facilitator firma/broadcastea `release` SÓLO tras leer+verificar `EscrowState.status==Deposited` on-chain en la MISMA invocación (nunca cacheado, nunca del body).
- **CD-4** El `beneficiary`/destino del release SIEMPRE de `escrow_state.beneficiary` on-chain — NUNCA del body.
- **CD-5** Devnet + flags OFF — cero plata real, ningún deploy a mainnet. NO deployés ni apliqués migraciones.
- **CD-6** PROHIBIDO loguear/serializar/exponer la release-authority secret key (throw con el NOMBRE de la env, nunca el valor); el browser NUNCA llama al facilitator directo (creds server-side, `/api/settle/solana-sponsor` añade el Bearer).
- **CD-7** Reusar `canonicalizeAddress` (HU-SOL-7) para comparaciones de pubkey base58 en la capa de aplicación de chaski (NO `lowercase`, NO `isAddress` de viem — el riesgo es la COLISIÓN, no el throw, CD-17).
- **CD-8** Ownership Guard (WKH-53): toda query nueva sobre tablas con `owner_ref` (ledger/dedup) filtra por `owner_ref` además del `id`.
- **CD-9** Idempotencia/anti-replay del `release` (evitar doble-firma/broadcast), análogo al `UNIQUE(signature)` de `solana-dedup.ts`.
- **CD-11** Reusar `cosignAndBroadcast` + `SponsorTxValidator` de HU-SOL-14 SIN reimplementar la primitiva; escribir SOLO `validateReleaseForSponsor` + `build-release` + la orquestación.
- **CD-15 (Auto-Blindaje SOL-5)** En todo adapter/util client-side (`refundEscrow`): NUNCA builtins de Node (`node:crypto`, `Buffer`-solo-node); libs isomórficas (`@noble/hashes`, `TextEncoder`). El test-env `node` enmascara la falla — validar el path browser.
- **CD-16 (Auto-Blindaje SOL-5)** Al lazy-importar una lib y usar sus tipos: separar `import type {…}` estático del `await import(...)` de valor; IDL `as const` ⇒ `as unknown as Idl`; `program.methods.X` con IDL genérico ⇒ tipar el fluent chain a mano.
- **CD-18 (Auto-Blindaje SOL-7/WKH-196)** Al extender un port cuyo impl/fake usa object-literals inline: actualizar port **y** impl **y** fake **y** los inputs de los tests. El gate de tipos es `npx tsc --noEmit` COMPLETO (incluye tests), no solo `next build`. `amount`/`nonce` u64/uint256 → decimal string / `::text`, NUNCA `Number()`.

### PROHIBIDO
- **CD-1** Modificar `solana-programs` (programa Anchor devnet = verdad inmutable). Sólo se COPIA el IDL.
- **CD-10** Que el `refund` permita a alguien ≠ `sender` disparar/firmar; el refund es 100% sender-signed + sender-broadcast, sin facilitator.
- **CD-12** Parsear la tx `release` (CR-1) con anchor. Usar `@solana/web3.js` raw (discriminator por bytes). El IDL/anchor SOLO decodifica la *cuenta* `EscrowState` (13b), NUNCA valida la tx.
- **CD-13** Reusar/ensuciar `PrincipalSettlementGateway` (EIP-3009) ni su regex `^0x…{64}$` — la respuesta Solana es signature base58.
- **CD-14** Widenizar `settlement` a unión (rompería la inyección EVM). La rama Solana es inyección opcional NUEVA `solana?`. El use-case NUNCA lee `process.env`.

---

## Test Expectations

### chaski-v3 (13a — vitest env `node`; PDA NO bajo jsdom)

| # | Test (archivo) | Cubre | Aserto clave |
|---|----------------|-------|--------------|
| T1 | `confirm-and-send.solana.test.ts` — happy | **AC-1** | prepare resuelve `{beneficiary, authority}` server-side; `authorizePrincipal` recibe `escrow`; `gateway.settle` ⇒ signature; `markPrincipalIn(signature)`; `payout_submitted` con `payoutId` de prepare. |
| T2 | `confirm-and-send.solana.test.ts` — fallos | AC-1/AC-4 | prepare `!ok` / gateway `!ok` / gateway throw ⇒ `failAndRefund(_, false)`, NUNCA `markPrincipalIn`; `beneficiary`/`authority` jamás del body. |
| T3 | `confirm-and-send.demo.test.ts` + EVM suite — **regresión** | **CD-2/CD-14** | `solana===undefined` + `settlement` EVM ⇒ byte-idéntico, ninguna assertion cambia. |
| T4 | `chain.solana.test.ts` (extender el existente) | AC-1/AC-3 | consumo de `resolveSolanaReleaseAuthorityPubkey` (ya existe): base58 ⇒ devuelve; ausente/malformado ⇒ throw. |
| T5 | `http-solana-settlement-gateway.test.ts` — mock `fetch` | AC-1 | 200 `{signature}` base58 ⇒ `{ok:true}`; 422/429/409/502/red-caída ⇒ reason fail-closed; shape 0x/raro ⇒ `solana_settle_unverified`. |
| T6 | `solana-wallet.refund.test.ts` | **AC-6/AC-7/CD-10** | arma ix `refund` (discr `[2,96,183,251,63,208,46,46]`, accounts en orden AH-10, sender=signer+feePayer); `status≠Deposited` o `now<deadline` ⇒ aborta client-side sin broadcastear; NUNCA usa la release-authority. |
| T7 | `flow.test.tsx` (jsdom, sin PDA) | **AC-7** | `TrackView`: acción refund visible SOLO con `vm=solana`+refundeable+`now>=deadline`; **oculta** pre-deadline; dispara el gateway. EVM UI intacta. |

**Mutation self-check (13a.W3, OBLIGATORIO — patrón HU-SOL-5):** montá mutantes uno a uno (backup en scratchpad, NO `git checkout`) y confirmá que ≥1 test MUERE por cada uno: (a) `refundEscrow` sin el guard `status≠Deposited`/deadline → muere T6; (b) rama Solana que llama `markPrincipalIn` cuando `!res.ok` → muere T2; (c) acción refund visible pre-deadline en `flow.tsx` → muere T7. `grep -rn MUTANT src app` = 0 al cerrar.

### wasiai-facilitator (13b/13c — vitest, Connection/broadcast mockeados, cero red)

| # | Test | Cubre | Aserto clave |
|---|------|-------|--------------|
| TF1 | `solana-escrow.read.test.ts` | AC-2 | `readEscrowState` decodifica `EscrowState` (IDL) byte-correcto; PDA derivada == la de chaski (paridad cross-repo, AH-9). |
| TF2 | `solana-escrow.verify.test.ts` | **AC-2** | `verifyVault`: `Deposited`✔; `Released`⇒reject; `mint≠USDC`⇒reject; `vault.amount≠state.amount`⇒reject. |
| TF3 | `cr1-release.test.ts` — happy | AC-3 | tx release estructuralmente correcta + `state` ⇒ `{ok:true}`. |
| TF4 | `cr1-release.test.ts` — beneficiary inyectado | **AC-4/CD-4** | account `beneficiary` ≠ `state.beneficiary` ⇒ `{ok:false}`, NO firma. |
| TF5 | `cr1-release.test.ts` — anti-drain | AC-3/AC-4 | authority equivocada / discriminator≠release / ix extra que usa la release-authority como source de Transfer/Close/SetAuthority ⇒ reject. |
| TF6 | `route.release.test.ts` — orquestación | **AC-4/CD-3** | sin KYC / sin TransFi / `status≠Deposited` (on-chain, misma invocación) ⇒ `422` ANTES de `cosignAndBroadcast` (spy: primitiva NO invocada). |
| TF7 | `route.release.test.ts` — no-replayable | **AC-5/CD-9** | 2ª solicitud con `status==Released` O dedup ya reclamado ⇒ `409` sin re-firmar (spy: `cosignAndBroadcast` no re-invocado). Store dedup caído ⇒ fail-closed. |
| TF8 | `route.release.optin.test.ts` | CD-2/CD-5 | sin `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` ⇒ ruta no registrada; suite EVM byte-idéntica. |

---

## Gate de cada wave

| Wave | Repo | Gate |
|------|------|------|
| 13a.W0-W3 | chaski-v3 | `npm run qa` (= `tsc --noEmit` COMPLETO + `vitest run`) verde; EVM 0-diff; mutation self-check |
| 13b | facilitator | el gate de tipos+tests del facilitator (equivalente a `npm run qa` — confirmar el script real del repo antes de correr); EVM byte-idéntico |
| 13c | facilitator | idem 13b + TF3-TF8 verdes |

> **CD-18:** el gate es SIEMPRE el typecheck COMPLETO (incluye tests), NUNCA solo el build de producción (excluye tests — lección WKH-196/210).

---

## Coordinación de merge y frontera (reflejar, no ejecutar)

- **13a** corre en `chaski-v3/feat/029-…` (main ya trae HU-SOL-5 + HU-SOL-9). **13b/13c** corren en el facilitator, branch companion stacked sobre `feat/027` (HU-SOL-14) sobre `feat/026`. El orquestador maneja el orden de merge del facilitator (`026→027→13c`) — TODO HELD/founder-gated.
- **Orden recomendado:** HU-SOL-14 mergeada → 13c. 13a/13b se codean/unit-testean con mocks sin HU-SOL-14 mergeada (reachability e2e founder-gated).
- **`confirm-and-send.ts`** es el archivo de MÁS alto riesgo del repo (WKH-210/211). NINGUNA otra HU debe tocarlo en la misma ventana.
- **Founder-gated (FUERA de F3):** deploy del facilitator con la release-authority; fondeo de keypairs con SOL devnet; activación de flags Solana; wiring del deposit-address Solana real de TransFi ([NC-1]); aplicación de la migración del dedup del release; provisión real del PoP (HU-SOL-8) y el wire-format del release request ([NC-2]).

## Uncertainty Markers (NO bloqueantes de F3 — decisiones de F3/founder, documentá lo que elijas)
- **[NC-1]** Resolución REAL del `beneficiary` (deposit-address Solana de TransFi por orden): stub el prepare Solana devolviendo un beneficiary devnet de prueba hasta que el agente `remit-cashout-payout` exponga el destino Solana; el binding/atestación queda listo.
- **[NC-2]** Fuente del "orden TransFi confirmada" que gatea el release + wire-format del release request: (a) atestación server-firmada pasada por chaski (recomendado) o (b) query del facilitator. El companion WF de HU-SOL-9 (Zod del facilitator) sigue pendiente — **coordiná, documentá, NO asumas hecho**.
- **[NC-3]** El `deadline` on-chain = `quote.expiresAt` (fijado por HU-SOL-5, Scope OUT). `refundEscrow` lee `EscrowState.deadline`/`status` on-chain (autoritativo) antes de habilitar.
- **[NC-4]** Coder de deserialización en el facilitator: `@coral-xyz/anchor` (`BorshAccountsCoder`, recomendado, mismo pin que chaski) vs `@coral-xyz/borsh` (más liviano). Ambos cumplen DT-4.
- **[NC-5]** Nombre/NNN del companion ticket + branch en `wasiai-facilitator`: lo asigna el orquestador/founder.

---

## Out of Scope (NO tocar bajo ninguna circunstancia)
- El armado base del `deposit` (`solana-wallet.ts:authorizePrincipal`) → HU-SOL-5 (se consume).
- El broadcast gasless base + la primitiva `cosignAndBroadcast` → HU-SOL-14 (se reusa, NO se reimplementa).
- `close` (housekeeping del vault) — el programa lo soporta, no es parte de esta HU.
- El valor del `deadline` (fijado por HU-SOL-5).
- Deploy/fondeo/flags/migraciones (founder-gated).
- `solana-programs` (repo externo inmutable, CD-1) — sólo se COPIA el IDL.
- El path EVM (Base, EIP-3009) en ambos repos — byte-idéntico.
- NO "mejorar" código adyacente. NO agregar deps fuera de `@coral-xyz/anchor` (facilitator, 13b).

---

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala al Architect.** No inventar, no asumir, no improvisar.

Situaciones de escalation:
- HU-SOL-9 (`resolveSolanaReleaseAuthorityPubkey`) NO está en main de chaski → PARAR (pre-req duro de 13a).
- HU-SOL-5 (`authorizePrincipal` deposit + `remittanceIdToBytes16`) NO está en main → PARAR.
- El IDL de chaski difiere de AH-10/AH-11/AH-12 (el programa cambió) → PARAR.
- Un test EVM cambia de expectativa para pasar (cualquier repo) → PARAR (violación CD-2).
- 13c: HU-SOL-14 (`cosignAndBroadcast` + `SponsorTxValidator`) NO está en el branch base del facilitator → PARAR.
- La PDA derivada en 13b NO coincide con la de chaski (TF1 falla) → PARAR (paridad cross-repo rota).
- El wire-format del release request / la fuente del "TransFi confirmado" no está resuelto y bloquea el unit-test → documentar el stub elegido y seguir; si bloquea de verdad → escalar.
- El cambio requiere tocar archivos fuera de las tablas "Files to Modify/Create" → escalar.

---

*Story File generado por NexusAgil — F2.5 — HU-SOL-13 / WKH-216 (Solana LATAM Labs) — cross-repo chaski-v3 + wasiai-facilitator*
</content>
</invoke>
