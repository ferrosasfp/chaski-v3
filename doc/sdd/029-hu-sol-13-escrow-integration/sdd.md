# SDD #029: [WKH-216 / HU-SOL-13] Integración del escrow — chaski deposita real + facilitator verifica-vault + release + refund

> NexusAgil QUALITY · F2 (SDD) · 2026-07-22
> SDD_MODE: full · Sizing XL · Cross-repo: **chaski-v3** (Wave 13a) + **wasiai-facilitator** (Waves 13b/13c, companion — DISEÑADO aquí, codeado en su propio branch)
> Input: `doc/sdd/029-hu-sol-13-escrow-integration/work-item.md` (7 ACs EARS · 5 DT · 10 CD · 2 bloqueantes)
> Contratos CONSUMIDOS (leídos): HU-SOL-9 `doc/sdd/028-hu-sol-9-binding-wire-facilitator/sdd.md`; HU-SOL-14 `wasiai-facilitator/doc/sdd/027-hu-sol-14-gasless-feepayer/sdd.md`; programa escrow `solana-programs/programs/escrow/src/lib.rs` (inmutable).
> Branch chaski: `feat/029-hu-sol-13-escrow-integration`. Branch facilitator (companion): a asignar por el orquestador (candidato `feat/0NN-wfac-solana-escrow-release`, convención WFAC).

---

## 1. Resumen

Cablea el escrow Anchor (`solana-programs`, DONE/devnet, `BBQ9…79WA`) al money-path Solana no-custodial de Chaski. Tres waves, dos repos, todo **dark detrás de flags OFF** (devnet, cero plata real):

- **Wave 13a (chaski-v3, código)**: rama `vm==="solana"` en `confirm-and-send.ts` — el archivo de MÁS alto riesgo del repo (WKH-210/211) — que resuelve `SolanaEscrowDeposit {beneficiary, authority}` **server-side** (patrón atestación HMAC WKH-211 + `resolveSolanaReleaseAuthorityPubkey()` de HU-SOL-9), pasa el 3er arg de `authorizePrincipal` (HU-SOL-5 ya arma el `deposit`), y cablea el broadcast real vía el **puerto NUEVO `SolanaSettlementGateway`** (NO reusa `PrincipalSettlementGateway`, EIP-3009-shaped) que reenvía `partialSignedTx`+`reference` al `POST /solana/sponsor` de HU-SOL-14 y persiste el `principal_in` con la **signature verificada on-chain**. Más la **acción de refund** en la UI de tracking (post-deadline, sender-signs, sin facilitator).
- **Wave 13b (wasiai-facilitator, BAJO riesgo, read-only)**: lee+deserializa `EscrowState` (PDA `["escrow", sender, remittance_id]`) vía **IDL Anchor pinneado** (NUNCA offsets ad-hoc, DT-4) + el balance del vault ATA, y verifica `status==Deposited`, `mint==USDC`, `vault.amount==escrow_state.amount` ANTES de cualquier release. Cero keypair, cero firma.
- **Wave 13c (wasiai-facilitator, ALTO riesgo)**: firma+broadcast del `release` (`has_one authority`). **Reusa** la primitiva `cosignAndBroadcast` + el contrato `SponsorTxValidator` de HU-SOL-14 (NO se reimplementa). Se escribe SOLO `validateReleaseForSponsor` (CR-1 del release) + la orquestación KYC+orden-TransFi + la re-lectura on-chain (13b) en la MISMA invocación antes de firmar.

**Frontera dura**: no se toca `solana-programs` (CD-1). El path EVM (Base, EIP-3009) queda **byte-idéntico** — ningún test EVM cambia assertion (CD-2). No hay deploy, ni fondeo de keypairs, ni activación de flags (founder-gated, CD-5).

**Dependencias cross-HU (ver §10, riesgo primario)**: 13a consume `resolveSolanaReleaseAuthorityPubkey()` (**HU-SOL-9**, hoy F2/SDD escrito, NO merged) y el `/solana/sponsor` (**HU-SOL-14**, hoy F2/`SPEC_APPROVED:no`, NO merged); 13c consume la primitiva `cosignAndBroadcast` (**HU-SOL-14**). El código de cada wave es correcto y unit-testeable con mocks sin esas HUs mergeadas; la reachability e2e es founder-gated (documentada, no ambigua).

---

## 2. Acceptance Criteria (EARS, heredados) → mapeo a waves

| AC | Enunciado (resumen) | Wave |
|----|---------------------|------|
| **AC-1** | deposit cableado: `authorizePrincipal(quote, remittanceId, {escrow:{beneficiary,authority}})` con ambos resueltos SERVER-SIDE; la wallet arma+partial-firma el `deposit` (no transfer directo a TransFi). | 13a |
| **AC-2** | verify vault: leer `EscrowState` (PDA) + balance vault ATA; verificar `status==Deposited`, `mint==USDC`, `vault.amount==escrow_state.amount` ANTES de construir/firmar el release. | 13b |
| **AC-3** | release autorizado: con KYC confirmado + orden TransFi completada + destino == `escrow_state.beneficiary` (AC-2), firmar `release` con la keypair de la `authority` y broadcastear (vault→beneficiary_ata). | 13c |
| **AC-4** | release NO autorizado rechazado: sin KYC / sin TransFi / beneficiary≠on-chain / `status≠Deposited` ⇒ rechazar ANTES de construir/firmar, sin transferir. | 13c |
| **AC-5** | release no-replayable: 2ª solicitud con `status==Released` (on-chain, AC-2) o ya procesada (dedup local) ⇒ rechazar sin re-firmar/re-broadcastear. | 13c |
| **AC-6** | refund trustless post-deadline: sender dispara refund con `Clock>=deadline` Y `status==Deposited` ⇒ construir + sender firma `refund` (vault→sender_ata), SIN firma/aprobación de authority/facilitator. | 13a |
| **AC-7** | refund rechazado pre-deadline: sender intenta antes de `deadline` ⇒ UI bloquea/oculta (defensa en profundidad; el programa YA rechaza `DeadlineNotReached`). | 13a |

---

## 3. Context Map (Codebase Grounding)

### 3.1 chaski-v3 — verificados con Read

| Archivo | Qué extraje / patrón |
|---------|----------------------|
| `src/application/use-cases/confirm-and-send.ts` (L1-352) | Orquestador money-path. 100% EVM hoy: `import { isAddressEqual } from "viem"` (L1); inyección opcional flag-gated `settlement?` (L49-52, gateway+prepare ACOPLADOS) = criterio "modo real"; `pop?` (L56). Rama real: 2.7 prepare (L137-176) → 3 `authorizePrincipal(quote, s.id, deposit)` (L182) → 3.2 settle EIP-3009 (L192-259, guards C1-C6) → `markPrincipalIn(principalTxHash)` (L261). **NO hay rama `vm==="solana"`.** `failAndRefund(r, reason, principalReallyIn)` (L65-91). Demo (`settlement===undefined`) byte-idéntico. |
| `src/application/ports.ts` (L119-264) | `SolanaEscrowDeposit {beneficiary, authority, mint?}` (L163-167, "Resuelto por HU-SOL-13"). `SolanaPrincipalAuthorization {vm, partialSignedTx(base64), reference(base58)}` (L170-174). `WalletPort.authorizePrincipal(quote, remittanceId, deposit?: {address; escrow?})` retorna `{tx; eip3009?; solana?}` (L239-247). `PrincipalSettlementGateway.settle` es EIP-3009-shaped (L184-200). `PayoutPrepareGateway.prepare` → `{depositAddress, attestation, payoutId, provenance}` (L207-228). `RefundGateway.creditBack` (L102-104). |
| `src/infrastructure/solana-wallet.ts` (L1-155) | `authorizePrincipal` (HU-SOL-5): guards fail-loud `escrow_params_missing` si falta beneficiary/authority (L74-75); deriva PDA `["escrow", sender, remittanceIdBytes16]` (L98-101), vault ATA off-curve (L103), sender_ata (L104), reference `Keypair.generate()` (L107); `deadline = floor(Date.parse(quote.expiresAt)/1000)` (L95); `feePayer=facilitator` (L137); partial-sign SOLO wallet, serializa base64; **NUNCA broadcastea** (L144). `remittanceIdToBytes16 = sha256(utf8(id))[:16]` con `@noble/hashes` (L60-62, browser-safe). Corre CLIENT-SIDE. |
| `src/infrastructure/solana/escrow-idl.ts` (L1-397) | IDL pinneado `as const`. `deposit` discr `[242,35,198,137,82,225,242,182]`. **`release` discr `[253,249,15,206,28,127,193,241]`** (L263), accounts en orden: authority(signer)/sender/beneficiary/mint/escrow_state(pda)/vault/beneficiary_ata/token_program/associated_token_program (L264-349). **`refund` discr `[2,96,183,251,63,208,46,46]`** (L170), accounts: sender(signer,mut)/mint/escrow_state/vault/sender_ata/token_program/associated_token_program (L171-249). `EscrowState` account discr `[19,90,148,111,55,130,229,108]` (L362); layout struct (L372-395): sender/beneficiary/authority/mint (32c/u), amount(u64), deadline(i64), status(enum Deposited/Released/Refunded), bump(u8). |
| `src/infrastructure/chain.ts` (L98-186) | Resolvers Solana devnet: `resolveActiveVm()` (L121, unset⇒"evm", inválido⇒throw), `resolveSolanaUsdcMint()` (L135), `resolveSolanaFacilitatorPubkey()` (L148), `resolveSolanaRpcUrlPublic(cluster)` (L171, client-safe fallback). **Patrón exacto** para el nuevo `resolveSolanaReleaseAuthorityPubkey()` — que **HU-SOL-9 ya especifica** (SDD 028 §4.4). |
| `src/infrastructure/settlement/http-settlement-gateway.ts` (L1-132) | Exemplar gateway CLIENT-SIDE → `fetch("/api/settle/principal")`; `isRecord`/`isValidSettleShape` type-guards explícitos; `mapErrorStatus` fail-closed (409/503/504⇒unavailable, desconocido⇒rejected); red caída⇒`settlement_unavailable`. **Modelo directo** del `HttpSolanaSettlementGateway` (13a). |
| `src/composition/container.ts` (L60-139) | Composition root. `settlement` se inyecta SOLO con `NEXT_PUBLIC_EIP3009_ENABLED==="true"` (L100-103, gateway+prepare acoplados). `wallet = resolveActiveVm()==="solana" ? new SolanaWalletAdapter() : pickWallet()` (L86). Guard fail-loud EIP-3009 (L68-79). `refund = new LedgerRefundGateway()`. `ConfirmAndSend(...)` con 8 args (L117-126). |
| `src/application/use-cases/track-remittance.ts` (L1-63) | `failAndRefund` idéntico a ConfirmAndSend; polling `payouts.status`. Reusa `RefundGateway`. |
| `src/infrastructure/refund/ledger-refund-gateway.ts` | `LedgerRefundGateway.creditBack` ⇒ refundTx SINTÉTICO (ledger-only, NO on-chain). Exemplar de contrato de refund. |
| `src/presentation/flow.tsx` (L322-344, L725-744) | Polling en `step==="track"` (L327), frena en `isTerminal`/`payout_failed` (L335). `TrackView` (L730): rama temprana honesta si `payout_failed`/`refunded` (L734-743), muestra `rem.refundTx`. **Punto de inserción de la acción refund** (AC-6/AC-7). |
| `src/domain/remittance.ts` (L82-260) | Estados + transiciones: `payout_failed→refunded` (L95). `markPayoutFailed`/`markRefunded` (L256-260). `RemittanceState` (L138-156): **NO tiene campo `deadline`** — el deadline on-chain = `floor(Date.parse(quote.expiresAt)/1000)` (ver §7.4/[NC-3]). `TERMINAL_STATUSES` (L99). |
| `doc/sdd/025…/auto-blindaje.md`, `026…/auto-blindaje.md` | Errores recurrentes Solana/Anchor → CD-13..CD-18 (§5). |

### 3.2 wasiai-facilitator — solo LECTURA (companion 13b/13c DISEÑADO, no codeado)

| Archivo | Qué extraje |
|---------|-------------|
| `src/chains/solana-adapter.ts` (L1-431) | `SolanaAdapter` verify-only (HU-SOL-6/WKH-205, HELD). `BASE58_RE` (L48), `isBase58Pubkey`=`new PublicKey` try/catch (L93), `isBase58Signature` (L104). Opt-in-off factory (L419-430, null sin `SOLANA_RPC_URL`+`SOLANA_USDC_MINT`). `commitment:'finalized'` explícito (CD-5). `_verifyCore` NUNCA throw ⇒ `AdapterResult`. **NO conoce el programa escrow** — no lee PDAs, no deserializa `EscrowState`. Modelo de fail-closed + parse-boundary para 13b. |
| `src/infra/solana-dedup.ts` (leído vía SDD 027 §3) | Dedup fail-CLOSED `UNIQUE(signature)`; `{ok:false}` en no-client/error ⇒ reject; `::text` cast precisión (WKH-196). Base del anti-replay del release (AC-5/CD-9). |
| `src/infra/wallet.ts` (2.6K, vía SDD 027 §3) | `getOperatorAccount()` singleton lazy + regex validación + throw con **nombre** de env (nunca valor). Exemplar de `getReleaseAuthorityKeypair()` (DT-5). |
| `wasiai-facilitator/doc/sdd/027-hu-sol-14-gasless-feepayer/sdd.md` (COMPLETO) | Contrato de HU-SOL-14: **primitiva `cosignAndBroadcast(txBase64, {feePayerKeypair, validate, estimateFeeLamports, rpcUrl, maxFeeLamports})`** (§4.3), reusable, firma SÓLO si `validate` ⇒ `{ok:true}`. **`type SponsorTxValidator = (tx: Transaction, feePayerPubkey: PublicKey) => {ok:true; feeUpperBoundLamports:bigint} | {ok:false; reason:string}`** (§4.3/§10). CR-1 raw parse (CD-12: `@solana/web3.js`, NUNCA anchor, discriminator por bytes). Serialización FIFO `runExclusive` (§4.5). Ruta `POST /solana/sponsor` (§4.7) → `{signature}`. Env `SOLANA_ESCROW_PROGRAM_ID` default `BBQ9…79WA` (§4.6). **§10 punto de extensión: HU-SOL-13 reusa la primitiva pasando `validateReleaseForSponsor`.** |
| `package.json` (verificado) | SOLO `@solana/web3.js ^1.98.4`. **NO** `@coral-xyz/anchor`, `@coral-xyz/borsh`, `bs58`. ⇒ decisión DT-4b (§4.7): 13b debe añadir un coder IDL. |
| `src/methods/`, `src/routes/`, `src/infra/` (listados) | Solo `eip3009/` en methods; rutas `settle/verify/health/…`. Los archivos nuevos de 13b/13c viven en dirs nuevos (`src/methods/solana-escrow/`, `src/chains/solana-escrow.ts`, `src/routes/solana-escrow.ts`) — aditivos, EVM byte-idéntico. |

### 3.3 Estado de flags/config (todo OFF por default)
- chaski: `NEXT_PUBLIC_VM` unset⇒evm; `NEXT_PUBLIC_EIP3009_ENABLED` (gate settle EVM); flag Solana nuevo (§4.2, DT-2). `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` (server, HU-SOL-9).
- facilitator: adaptador Solana opt-in-off; `SOLANA_FEE_PAYER_PRIVATE_KEY`/`SOLANA_FEE_PAYER_SPONSOR_ENABLED` (HU-SOL-14); **nuevo** `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` (13c, DT-5, founder-gated). Migración dedup PENDING-DEPLOY.

### 3.4 Componentes reutilizables (NO reinventar)
`authorizePrincipal` con escrow (HU-SOL-5), `resolveSolana*` + `resolveSolanaRpcUrlPublic` (chain.ts), esqueleto HMAC de `deposit-attestation.ts` + `PayoutPrepareGateway` (WKH-211), `HttpSettlementGateway` (forma+fail-closed), `escrowIdl` pinneado (discriminators + `EscrowState` layout), **`cosignAndBroadcast`+`SponsorTxValidator`+`getFeePayerKeypair`+`solana-dedup`+`getOperatorAccount`** (HU-SOL-14/facilitator).

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

**chaski-v3 (Wave 13a — código de esta HU):**

| Archivo | Acción | Descripción | Exemplar | Wave |
|---------|--------|-------------|----------|------|
| `src/infrastructure/chain.ts` | Modificar | +`resolveSolanaReleaseAuthorityPubkey()` (env `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`, base58 fail-loud). **Idéntico a HU-SOL-9 §4.4** — si HU-SOL-9 mergea primero, NO se duplica (ver §8). | `resolveSolanaFacilitatorPubkey` (L148) | W0 |
| `src/application/ports.ts` | Modificar (aditivo) | +`SolanaSettlementGateway`, +`SolanaPayoutPrepareGateway` (resuelve `{beneficiary, authority}` server-side), +`SolanaEscrowRefundGateway`, +`SolanaSettlementFailureReason`. NO se toca ningún tipo EVM. | `PrincipalSettlementGateway`/`PayoutPrepareGateway` | W0 |
| `src/infrastructure/settlement/http-solana-settlement-gateway.ts` | Crear | `settle({partialSignedTx, reference, sender, remittanceId, popProof?})` → `fetch("/api/settle/solana-sponsor")` (ruta server-only chaski que reenvía a `POST {FACILITATOR}/solana/sponsor`) → `{ok:true; signature}` \| `{ok:false; reason}`. Fail-closed. | `http-settlement-gateway.ts` | W1 |
| `src/infrastructure/settlement/http-solana-prepare-gateway.ts` | Crear | Rama Solana del prepare: crea/consulta la orden TransFi, resuelve `beneficiary` (deposit-address Solana de la orden) + `authority`=`resolveSolanaReleaseAuthorityPubkey()`, emite el binding (atestación, reusa esqueleto HMAC). Espeja `HttpPayoutPrepareGateway`. | `http-payout-prepare-gateway.ts` | W1 |
| `src/infrastructure/solana-wallet.ts` | Modificar (aditivo) | +`refundEscrow(remittanceId, sender, deadlineSec?)`: arma la ix `refund` (discr `[2,96,183,251,63,208,46,46]`), **sender firma + sender broadcastea** (NO facilitator, AC-6). Reusa `remittanceIdToBytes16` + derivación PDA existente. Guard client-side de deadline (defensa, [NC-3]). | `authorizePrincipal` (mismo archivo) | W1 |
| `src/infrastructure/refund/solana-escrow-refund-gateway.ts` | Crear | `SolanaEscrowRefundGateway.refund({remittanceId, sender})` → delega en `wallet.refundEscrow` → `{refundTx: signature}`. | `ledger-refund-gateway.ts` | W1 |
| `app/api/settle/solana-sponsor/route.ts` | Crear | Ruta server-only: recibe `{partialSignedTx, reference, sender, remittanceId, popProof?}`, añade `Authorization: Bearer {FACILITATOR_API_KEY}` server-side, reenvía a `POST {FACILITATOR_BASE_URL}/solana/sponsor` (contrato HU-SOL-14 §11), devuelve `{signature}`. El browser NUNCA llama al facilitator directo (CD-6). | `app/api/settle/principal/route.ts` (server-forward pattern) | W1 |
| `src/application/use-cases/confirm-and-send.ts` | Modificar | **Rama `vm==="solana"`** (inyección opcional flag-gated NUEVA `solana?`, §4.3). EVM byte-idéntico. | patrón `settlement?` (mismo archivo) | W2 |
| `src/composition/container.ts` | Modificar | Inyecta `solana` (prepare+gateway+refund) SOLO con `resolveActiveVm()==="solana"` + flag Solana ON; guard fail-loud análogo. EVM path intacto. | L86-108 mismo archivo | W2 |
| `src/presentation/flow.tsx` | Modificar | Acción "Recuperar fondos" en `TrackView` (AC-6/AC-7): visible SOLO si `vm==="solana"` + estado refundeable + `now>=deadline`; llama al refund gateway; oculta pre-deadline. | `TrackView` (L730) | W2 |
| Tests (§6) | Crear/mod | 13a: T1-T7. EVM regresión byte-idéntica. | tests existentes | W3 |

**wasiai-facilitator (Waves 13b/13c — companion DISEÑADO, codeado en branch propio):**

| Archivo | Acción | Descripción | Exemplar | Wave |
|---------|--------|-------------|----------|------|
| `package.json` | Modificar | +`@coral-xyz/anchor` (o `@coral-xyz/borsh`) pinneado — coder IDL para deserializar `EscrowState` (DT-4b). SOLO para READ de cuenta, NUNCA para CR-1 de tx (CD-12 HU-SOL-14). | — | 13b |
| `src/chains/solana-escrow.ts` | Crear | `readEscrowState({sender, remittanceId, connection})`: deriva PDA `["escrow", sender, sha256(remittanceId)[:16]]`, `getAccountInfo`, `BorshAccountsCoder(escrowIdl).decode("EscrowState", data)`; lee vault ATA balance (`getTokenAccountBalance`). `verifyVault(state)`: `status==Deposited`, `mint==SOLANA_USDC_MINT`, `vault.amount==state.amount`. NUNCA throw ⇒ `AdapterResult`. IDL pinneado copiado (análogo a chaski). | `solana-adapter.ts` (_verifyCore, fail-closed) | 13b |
| `src/methods/solana-escrow/release-shape.ts` | Crear | Constantes pinneadas: escrow programId, discriminator `release` `[253,249,15,206,28,127,193,241]`, orden esperado de cuentas, IDs de programas de sistema. | chaski `escrow-idl.ts` | 13c |
| `src/methods/solana-escrow/cr1-release.ts` | Crear | `validateReleaseForSponsor(state): SponsorTxValidator` — factory que captura el `EscrowState` on-chain (13b) y devuelve el validador estructural fail-closed (AC-3/AC-4). Ver §4.6. | `cr1.ts` (HU-SOL-14) | 13c |
| `src/methods/solana-escrow/build-release.ts` | Crear | Arma la tx `release` server-side desde datos **on-chain** (beneficiary/mint/amount/bump de `EscrowState`), `feePayer=release-authority`; serializa base64 para `cosignAndBroadcast`. | `solana-wallet.ts` build ix (chaski) | 13c |
| `src/infra/solana-release-authority.ts` | Crear | `getReleaseAuthorityKeypair(): Keypair` singleton lazy opt-in-off desde `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` (JSON 64-byte array, patrón HU-SOL-14) + `getReleaseAuthorityPubkey()` + `resetForTesting()`. Nunca logueada (CD-6). | `src/infra/wallet.ts` / `solana-fee-payer.ts` | 13c |
| `src/infra/solana-escrow-release-dedup.ts` | Crear | Anti-replay del release (AC-5/CD-9): `UNIQUE(escrow_pda)` o `(sender, remittance_id)` fail-CLOSED, análogo a `solana-dedup.ts`. | `solana-dedup.ts` | 13c |
| `src/routes/solana-escrow.ts` | Crear | `POST /solana/escrow/release`: auth caller → orquestación KYC+orden-TransFi confirmadas → `readEscrowState`+`verifyVault` (13b) → dedup claim → `build-release` → `cosignAndBroadcast(tx, {feePayerKeypair: getReleaseAuthorityKeypair(), validate: validateReleaseForSponsor(state), …})` → `{signature}`. Opt-in-off. | `routes/settle.ts` + `solana-sponsor.ts` (HU-SOL-14) | 13c |
| `src/app.ts` | Modificar | Registrar `/solana/escrow/release` SOLO si la release-authority está configurada (opt-in-off). EVM intacto. | patrón registro rutas | 13c |
| Migración dedup release | Crear | Tabla/UNIQUE para el dedup del release (PENDING-DEPLOY, founder-gated). | `003_facilitator_solana_dedup.sql` | 13c |
| Tests companion (§6) | Crear | TF1-TF8 (13b/13c) + regresión EVM byte-idéntica. | tests HU-SOL-14 | 13b/13c |

> **EVM byte-idéntico (CD-2)**: en chaski, ningún archivo EVM (`wallet.ts`, `http-settlement-gateway.ts`, rama `settlement?` de `confirm-and-send.ts`) cambia; la rama `solana?` es un branch nuevo aislado. En el facilitator, todos los archivos nuevos viven en dirs nuevos (`solana-escrow*`); ninguna suite EVM re-assertiona.

### 4.2 DT-2 [RESUELTO] — rama Solana en `confirm-and-send.ts` sin romper byte-identidad EVM

**Decisión**: **parámetro opcional NUEVO `solana?` separado del `settlement?` EVM**, mutuamente excluyente por VM. NO se widienza `settlement` a una unión discriminada (tocaría el shape que el container y los tests EVM inyectan hoy ⇒ riesgo de re-assertion).

```ts
// 9º param OPCIONAL. MISMO criterio anti-fail-open que `settlement`: el container lo inyecta SOLO con
// resolveActiveVm()==="solana" && flag Solana ON. Gateway/prepare/refund viajan ACOPLADOS (WKH-211 SDD-GAP#1):
// solana !== undefined ⇔ modo real Solana ⇔ los tres presentes juntos. Undefined ⇒ EVM/demo byte-idéntico.
private readonly solana?: {
  prepare: SolanaPayoutPrepareGateway;
  gateway: SolanaSettlementGateway;
};
```

En `execute()`, la rama Solana es un `if (this.solana) { … return r; }` **hermano** del bloque EVM (`if (this.settlement)`), insertado de forma que el path EVM y el path demo queden **byte-idénticos por construcción** (nunca se atraviesan cuando `this.solana===undefined`). Un container correcto NUNCA inyecta `settlement` y `solana` a la vez (un VM es EVM o Solana; el guard del container lo garantiza fail-loud). La rama Solana:
1. **prepare Solana** (análogo a 2.7): `this.solana.prepare.prepare(...)` ⇒ `{beneficiary, authority, attestation, payoutId, provenance}` (server-side, AC-1/DT-3). Falla ⇒ `failAndRefund(prep.reason, false)` ANTES de firmar.
2. **authorizePrincipal** (paso 3): `authorizePrincipal(quote, s.id, { address: beneficiary, escrow: { beneficiary, authority } })` ⇒ `{ solana }`. Si `!solana` ⇒ `failAndRefund("settlement_unverified", false)` (C1 análogo).
3. **broadcast real** (paso 3.2): `this.solana.gateway.settle({ partialSignedTx: solana.partialSignedTx, reference: solana.reference, sender: address, remittanceId: s.id })` ⇒ `{ok:true; signature}` \| `{ok:false; reason}`. Excepción ⇒ `settlement_unavailable`; `!ok` ⇒ `res.reason`; ambos `principalReallyIn=false` (el deposit NO entró).
4. `markPrincipalIn(signature)` SOLO con la signature verificada (la base58 de la tx broadcasteada por `/solana/sponsor`), `principalReallyIn=true`. El resto (submit) sigue el modelo no-custodial WKH-211: la orden TransFi ya se creó en prepare; se marca `payout_submitted` con `preparedPayoutId`. **La release del vault la dispara el facilitator (13c) async**, no chaski.

> El refund Solana (AC-6/AC-7) NO vive en el `execute()` de ConfirmAndSend — es una acción disparada desde la UI de tracking sobre un estado ya terminal-de-fallo (§4.5).

### 4.3 DT-1 [RESUELTO] — `SolanaSettlementGateway` (puerto NUEVO, NO `PrincipalSettlementGateway`)

```ts
export type SolanaSettlementFailureReason =
  | "solana_settle_unavailable"   // red caída / facilitator no configurado
  | "solana_settle_rejected"      // CR-1 del deposit rechazó (422 SPONSOR_REJECTED)
  | "solana_settle_rate_limited"  // 429
  | "solana_settle_broadcast_failed" // 409/502
  | "solana_settle_unverified";   // shape de respuesta inválido

export interface SolanaSettlementGateway {
  settle(input: {
    partialSignedTx: string;  // base64 (= SolanaPrincipalAuthorization.partialSignedTx)
    reference: string;        // base58 (= SolanaPrincipalAuthorization.reference)
    sender: string;           // base58 wallet del depositor (para PoP + AC-8 del sponsor)
    remittanceId: string;     // server-only, trazabilidad/ledger
    popProof?: string;        // KYC/PoP (HU-SOL-8/14, opt-in)
  }): Promise<
    | { ok: true; signature: string }        // base58 tx signature YA broadcasteada+confirmada
    | { ok: false; reason: SolanaSettlementFailureReason }
  >;
}
```

Rationale: `PrincipalSettlementGateway` es 100% EIP-3009 (`authorization: Eip3009Authorization; signature`) + su respuesta valida `txHash` `^0x…{64}$` (rechazaría una signature base58, `http-settlement-gateway.ts:59`). El gateway Solana consume el contrato HTTP de HU-SOL-14 §11 (`POST /solana/sponsor` → `{signature}`; errores `403 SPONSOR_POP_INVALID`/`422 SPONSOR_REJECTED`/`429`/`409`/`501`/`502`). El `HttpSolanaSettlementGateway` mapea esos status a `SolanaSettlementFailureReason` fail-closed (patrón `mapErrorStatus`).

### 4.4 DT-3 [RESUELTO] — resolución SERVER-SIDE de `beneficiary`/`authority` (AC-1 vs AC-6)

- **`authority`** = `resolveSolanaReleaseAuthorityPubkey()` (env `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`, base58 fail-loud). Es el árbitro de release del escrow no-custodial (valor de plataforma, **env-driven, NO hardcodeado**). Contrato definido por HU-SOL-9 §4.4 y CONSUMIDO acá. La keypair PRIVADA correspondiente vive SOLO en el facilitator (13c/DT-5), NUNCA en chaski.
- **`beneficiary`** = el deposit-address Solana que TransFi asigna por orden (destino real del dinero), resuelto por `SolanaPayoutPrepareGateway.prepare` server-side (mismo espíritu no-custodial que `depositAddress` de WKH-211). **NUNCA** se toma del body/browser (CD-4). El binding (atestación HMAC) ata `beneficiary`+`authority`+`remittanceId` para que el settle no pueda inyectar otro destino (patrón `DepositAttestation` / HU-SOL-9 §4.2 `SolanaDepositAttestation`).
- **AC-6 preservado**: chaski NUNCA captura el `beneficiary` a un valor de plataforma que bloquee el refund. El `refund` es sender-signed y sender-broadcast (vault→`sender_ata`), independiente de `beneficiary`/`authority`/facilitator (§4.5). El programa ya exige `sender: Signer` + `status==Deposited` + `Clock>=deadline`.

> **Nota de frontera (AC-1 e2e)**: la resolución REAL del `beneficiary` (deposit-address Solana de TransFi) depende de que la orden TransFi exponga un destino Solana. La orquestación exacta (agente `remit-cashout-payout` que devuelve el address Solana) es análoga al gap cross-repo que WKH-211 ya trató del lado EVM. En esta HU se cablea el seam (`SolanaPayoutPrepareGateway`) y se testea con mock; el wiring del address real de TransFi es founder/partner-gated (ver [NC-1]).

### 4.5 Refund trustless (AC-6/AC-7) — sender-signs, sin facilitator

- **Gateway**: `SolanaEscrowRefundGateway.refund({remittanceId, sender})` → `wallet.refundEscrow(...)`. El `SolanaWalletAdapter.refundEscrow` arma la ix `refund` (discr `[2,96,183,251,63,208,46,46]`; accounts: `sender`(signer,mut)/`mint`/`escrow_state`(PDA)/`vault`/`sender_ata`/`token_program`/`associated_token_program`), **el sender es feePayer + Signer**, firma+broadcastea con su wallet (`solanaWalletBridge.signTransaction` + `connection.sendRawTransaction`). Devuelve la signature base58 → `markRefunded(signature)`.
- **Sin facilitator (CD-10)**: el refund NO pasa por `/solana/sponsor` ni por la release-authority. Es la vía de recuperación trustless: aunque el facilitator desaparezca, el sender recupera post-deadline.
- **UI (AC-7)**: la acción "Recuperar fondos" en `TrackView` se muestra SOLO si `vm==="solana"` + estado refundeable (ej. `payout_failed`, o un estado que refleje "off-ramp no completado") + `now >= deadlineSec`. Pre-deadline: la acción se **oculta** (no solo se deshabilita) y el copy explica que aún está en proceso. Defensa en profundidad: el programa igual rechaza `DeadlineNotReached` (6003) si se fuerza.
- **Deadline en la UI** ([NC-3]): el `deadlineSec` on-chain = `floor(Date.parse(quote.expiresAt)/1000)` (lo fijó HU-SOL-5). `RemittanceState` no persiste `deadline`; la UI lo re-deriva de `quote.expiresAt` (defensa) y/o el gateway lee `EscrowState.deadline`/`status` on-chain antes de habilitar (autoritativo). **Recomendación**: el `refundEscrow` lee `EscrowState` on-chain (via `resolveSolanaRpcUrlPublic`) y aborta client-side si `status≠Deposited` o `Clock<deadline` (evita una tx que revertiría). NO se toca el valor del deadline (eso está en HU-SOL-5, Scope OUT).

### 4.6 Wave 13c — `validateReleaseForSponsor` + orquestación (el corazón de seguridad)

**Reuso de HU-SOL-14 (CD-11 heredado)**: se usa `cosignAndBroadcast` + el contrato `SponsorTxValidator` TAL CUAL. La release-authority keypair se pasa como `feePayerKeypair` de la primitiva (para la tx `release`, el `authority` ES el único signer requerido y también paga el fee ⇒ una sola firma cubre ambos roles). **NO se reimplementa** sign+broadcast, serialización FIFO, rebroadcast ni rate/daily-cap.

**Orquestación de la ruta `POST /solana/escrow/release` (ANTES de firmar, todo fail-closed):**
1. `requireFacilitatorKey` (caller = chaski server).
2. KYC/PoP confirmado + **orden TransFi completada/confirmada** (AC-3/AC-4). Fuente exacta del "TransFi confirmado" = [NC-2] (attestation pasada por chaski vs query del facilitator).
3. `readEscrowState({sender, remittanceId})` + `verifyVault` (Wave 13b, **en esta MISMA invocación**, CD-3): `status==Deposited` (AC-2/AC-4/AC-5), `mint==USDC`, `vault.amount==state.amount`. Cualquier fallo ⇒ reject SIN firmar.
4. **Dedup claim** (AC-5/CD-9): `UNIQUE(escrow_pda)` fail-CLOSED (mutar-primero/claim-después, patrón WKH-210 AR-MNR-1). Si ya reclamado ⇒ reject sin firmar.
5. `build-release` construye la tx `release` desde datos **on-chain** de `EscrowState`: `beneficiary` = `state.beneficiary` (CD-4, NUNCA del body), `beneficiary_ata`=ATA(mint, beneficiary), `sender`=`state.sender`, `authority`=release-authority pubkey, `escrow_state`/`vault` derivados. `feePayer`=release-authority.
6. `cosignAndBroadcast(releaseTxBase64, { feePayerKeypair: getReleaseAuthorityKeypair(), validate: validateReleaseForSponsor(state), estimateFeeLamports, rpcUrl, maxFeeLamports })` ⇒ `{signature}`.

**`validateReleaseForSponsor(state): SponsorTxValidator`** — estructural, raw parse (`@solana/web3.js`, NUNCA anchor — CD-12 HU-SOL-14; discriminator por bytes):
- fee-payer (`accountKeys[0]`) === `getReleaseAuthorityPubkey()` (la authority firma).
- **exactamente 1** ix de negocio (filtrando ComputeBudget), `programId` === escrow whitelisteado.
- discriminator === `release` `[253,249,15,206,28,127,193,241]`.
- cuenta `authority` (índice 0 de la ix) === release-authority pubkey; cuenta `beneficiary` === `state.beneficiary` (on-chain); cuenta `mint` === `state.mint`; cuenta `sender` === `state.sender`. Desviación ⇒ reject (AC-3/AC-4).
- ninguna ix inyectada usa la release-authority como source/authority de Transfer/Close/SetAuthority (defensa anti-drain heredada de CR-1/AC-3 HU-SOL-14).
- ComputeBudget acotado (heredado). Devuelve `{ok:true, feeUpperBoundLamports}` o `{ok:false, reason}`.

> El validador es estructural; la garantía money-path (status/beneficiary reales) la da la orquestación (paso 3, on-chain, misma invocación) + el propio programa Anchor (`has_one authority/beneficiary/sender/mint`, CEI `status=Released` antes del CPI). Doble red: app-layer + on-chain.

### 4.7 DT-4 / DT-4b [RESUELTO] — deserialización de `EscrowState` (IDL, no offsets)

DT-4 exige IDL Anchor pinneado. El facilitator hoy NO tiene `@coral-xyz/anchor`/`borsh`. **Decisión (DT-4b)**: añadir `@coral-xyz/anchor` (pinneado) al `package.json` del facilitator SOLO para `BorshAccountsCoder(escrowIdl).decode("EscrowState", accountData)` en Wave 13b. Se copia el `escrowIdl` pinneado (misma fuente inmutable que chaski, CD-1). **Esto NO contradice CD-12 de HU-SOL-14** (que prohíbe anchor para el CR-1 del *tx* del deposit): son concerns distintos — 13b decodifica una *cuenta on-chain* por su layout IDL (uso legítimo de DT-4); 13c parsea la *tx release* raw por bytes (CD-12). El Dev NO debe confundirlos. Alternativa más liviana: `@coral-xyz/borsh` + layout derivado del IDL (mismo efecto, menos superficie) — decisión de F3 documentada en [NC-4].

### 4.8 Flujo de error (fail-closed, no-oracle)
- chaski: prepare/broadcast falla ⇒ `failAndRefund(reason, false)` (deposit NO entró). Excepciones nunca escapan (patrón C3). `reason` = enum estable PII-free.
- facilitator: cualquier check de la orquestación (KYC/TransFi/on-chain/dedup) o del `validate` ⇒ `422 RELEASE_REJECTED`/`409 RELEASE_REPLAY` **sin firmar ni transmitir**, sin echo del `EscrowState` ni del tx. Store dedup caído ⇒ fail-CLOSED. Release-authority no configurada ⇒ ruta no registrada (opt-in-off) / `501`.

---

## 5. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (CD-1..CD-10) — vigentes
- **CD-1** PROHIBIDO modificar `solana-programs` (programa Anchor devnet = verdad inmutable).
- **CD-2** OBLIGATORIO EVM byte-idéntico en AMBOS repos; ningún test EVM cambia assertion.
- **CD-3** PROHIBIDO firmar/broadcastear `release` sin leer+verificar `EscrowState.status==Deposited` on-chain en la MISMA invocación (nunca cacheado, nunca del body).
- **CD-4** PROHIBIDO derivar el `beneficiary`/destino del release del body — SIEMPRE `escrow_state.beneficiary` on-chain.
- **CD-5** OBLIGATORIO devnet + flags OFF — cero plata real, ningún deploy a mainnet.
- **CD-6** PROHIBIDO loguear/serializar/exponer la release-authority secret key (invariante `OPERATOR_PRIVATE_KEY`); el browser NUNCA llama al facilitator directo (creds server-side).
- **CD-7** OBLIGATORIO reusar `canonicalizeAddress` (HU-SOL-7) para comparaciones de pubkey base58 en la capa de aplicación chaski.
- **CD-8** OBLIGATORIO Ownership Guard (WKH-53): toda query nueva sobre tablas con `owner_ref` (ledger del release, dedup) filtra por `owner_ref` además del `id`.
- **CD-9** OBLIGATORIO idempotencia/anti-replay del `release` (evitar doble-firma/broadcast), análogo al `UNIQUE(signature)` de `solana-dedup.ts`.
- **CD-10** PROHIBIDO que el `refund` de la UI permita a alguien ≠ `sender` disparar/firmar; el refund es 100% sender-signed + sender-broadcast, sin facilitator.

### Nuevos del SDD (CD-11..CD-18)
- **CD-11** OBLIGATORIO reusar `cosignAndBroadcast` + `SponsorTxValidator` de HU-SOL-14 SIN reimplementar la primitiva sign+broadcast; escribir SOLO `validateReleaseForSponsor` + `build-release` + la orquestación. La primitiva firma SÓLO si el validador ⇒ `{ok:true}`.
- **CD-12** OBLIGATORIO parsear la tx `release` (CR-1) con `@solana/web3.js` raw (discriminator por bytes), NUNCA anchor (hereda CD-12 HU-SOL-14). El IDL/anchor SOLO se usa para decodificar la *cuenta* `EscrowState` (13b), NUNCA para validar la tx.
- **CD-13** OBLIGATORIO `SolanaSettlementGateway` es puerto NUEVO; PROHIBIDO reusar/ensuciar `PrincipalSettlementGateway` (EIP-3009) ni su regex de respuesta `^0x…{64}$` — la respuesta Solana transporta signature base58.
- **CD-14** OBLIGATORIO la rama Solana de `confirm-and-send.ts` es inyección opcional NUEVA (`solana?`) mutuamente excluyente con `settlement?`; PROHIBIDO widenizar `settlement` a unión (rompería la inyección EVM del container/tests). El use-case NUNCA lee `process.env`.
- **CD-15 (Auto-Blindaje SOL-5)** OBLIGATORIO en TODO adapter/util client-side (`"use client"` chain, ej. `refundEscrow`): NUNCA builtins de Node (`node:crypto`, `Buffer`-solo-node); usar libs isomórficas (`@noble/hashes`, `TextEncoder`). El test-env `node` enmascara la falla — validar el path browser. Referencia: SOL-5 BLQ-MED-1.
- **CD-16 (Auto-Blindaje SOL-5)** OBLIGATORIO al lazy-importar una lib y usar sus tipos: separar `import type { … }` estático del `await import(...)` de valor; IDL `as const` ⇒ `as unknown as Idl`; `program.methods.X` con IDL genérico ⇒ tipar el fluent chain a mano. Referencia: SOL-5 Wave 1.
- **CD-17 (Auto-Blindaje SOL-7)** OBLIGATORIO en comparación de identidad Solana: NUNCA asumir que `lowercase(pubkey)` es inválido (el riesgo IDOR es la COLISIÓN, no el throw); comparar sobre forma canónica case-sensitive (`canonicalizeAddress`). Referencia: SOL-7 Wave 3.
- **CD-18 (Auto-Blindaje SOL-7 / WKH-196)** OBLIGATORIO al extender un port cuyo impl/fake usa object-literals inline (`SettlementLedger`/dedup del facilitator): actualizar port **y** impl **y** fake **y** los inputs literales de los tests (la bivarianza oculta el campo faltante en `tsc`). El gate de tipos es `npx tsc --noEmit` COMPLETO (incluye tests), no solo `next build`. Referencia: SOL-7 Wave 1 / WKH-196.

---

## 6. Plan de Tests (≥1 por AC)

**chaski-v3 (vitest, env `node` — CD-15: tests con PDA NO bajo jsdom; patrón `solana-wallet.test.ts`/`confirm-and-send.test.ts`):**

| # | Test (archivo) | Cubre | Vector estrella |
|---|----------------|-------|-----------------|
| T1 | `confirm-and-send.solana.test.ts` — happy Solana: `resolveActiveVm=solana` + `solana` inyectado ⇒ prepare resuelve `{beneficiary, authority}` server-side, `authorizePrincipal` recibe `escrow`, gateway.settle ⇒ signature, `markPrincipalIn(signature)`, `payout_submitted`. | **AC-1** | deposit→broadcast→principal_in con signature real |
| T2 | `confirm-and-send.solana.test.ts` — prepare falla / gateway `!ok` / gateway throw ⇒ `failAndRefund(_, false)`, NUNCA markPrincipalIn; `beneficiary`/`authority` jamás del body. | AC-1/AC-4 | deposit NO entra si el destino no se resolvió server-side |
| T3 | `confirm-and-send.demo.test.ts` + `.reorder.test.ts` + EVM suite — regresión: `solana===undefined` y `settlement` EVM ⇒ **byte-idéntico** (ninguna assertion cambia). | **AC-2 (byte-id)** / CD-2/CD-14 | ★ EVM byte-idéntico |
| T4 | `chain.solana.test.ts` — `resolveSolanaReleaseAuthorityPubkey`: base58 válido ⇒ devuelve; ausente/malformado ⇒ throw; jamás del body. | AC-1/AC-3 | — |
| T5 | `http-solana-settlement-gateway.test.ts` — mock `fetch`: 200 `{signature}` base58 ⇒ `{ok:true}`; 422/429/409/502/red-caída ⇒ reason fail-closed correcto; shape 0x/raro ⇒ `solana_settle_unverified`. | AC-1 | — |
| T6 | `solana-wallet.refund.test.ts` — `refundEscrow`: arma ix `refund` (discr correcto, accounts en orden, sender=signer+feePayer); con `status≠Deposited` o `now<deadline` ⇒ aborta client-side sin broadcastear; NUNCA usa la release-authority. | **AC-6/AC-7/CD-10** | ★ refund sin facilitator |
| T7 | `flow.test.tsx` (jsdom, sin PDA) — `TrackView`: acción refund visible SOLO con `vm=solana`+refundeable+`now>=deadline`; **oculta** pre-deadline; dispara el gateway. EVM UI intacta. | **AC-7** | ★ pre-deadline oculto |

**wasiai-facilitator (companion — especificado para el orquestador; vitest, Connection/broadcast mockeados, cero red):**

| # | Test | Cubre | Vector estrella |
|---|------|-------|-----------------|
| TF1 | `solana-escrow.read.test.ts` — `readEscrowState` decodifica `EscrowState` (IDL) byte-correcto (sender/beneficiary/authority/mint/amount/deadline/status/bump); PDA derivada de `["escrow", sender, sha256(remittanceId)[:16]]` == la de chaski. | AC-2 | paridad PDA cross-repo |
| TF2 | `solana-escrow.verify.test.ts` — `verifyVault`: `status==Deposited` ✔; `status==Released` ⇒ reject; `mint≠USDC` ⇒ reject; `vault.amount≠state.amount` ⇒ reject. | **AC-2** | — |
| TF3 | `cr1-release.test.ts` — happy: tx release estructuralmente correcta + `state` ⇒ `{ok:true}`. | AC-3 | — |
| TF4 | `cr1-release.test.ts` — **beneficiary inyectado**: cuenta `beneficiary` de la tx ≠ `state.beneficiary` ⇒ `{ok:false}`, NO firma. | **AC-4/CD-4** | ★ inyección de destino |
| TF5 | `cr1-release.test.ts` — authority equivocada / discriminator≠release / ix extra con release-authority como source ⇒ reject (anti-drain). | AC-3/AC-4 | — |
| TF6 | `route.release.test.ts` — orquestación: sin KYC / sin orden TransFi / `status≠Deposited` (on-chain, misma invocación) ⇒ `422` ANTES de `cosignAndBroadcast` (spy: primitiva NO invocada). | **AC-4/CD-3** | ★ reject pre-firma |
| TF7 | `route.release.test.ts` — **no-replayable**: 2ª solicitud con `status==Released` (on-chain) O dedup ya reclamado ⇒ `409` sin re-firmar (spy: `cosignAndBroadcast` no re-invocado). Store dedup caído ⇒ fail-closed. | **AC-5/CD-9** | ★ anti-replay |
| TF8 | `route.release.optin.test.ts` — opt-in-off: sin `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` ⇒ ruta no registrada; suite EVM completa byte-idéntica. | CD-2/CD-5 | ★ EVM byte-idéntico |

---

## 7. Waves de Implementación

### Wave 13a — chaski-v3 (`feat/029-hu-sol-13-escrow-integration`)
- **W0 (serial, contratos/tipos)**: `resolveSolanaReleaseAuthorityPubkey()` (chain.ts); puertos `SolanaSettlementGateway`/`SolanaPayoutPrepareGateway`/`SolanaEscrowRefundGateway` + reasons (ports.ts). Tests T4.
- **W1 (paralelizable tras W0)**: `http-solana-settlement-gateway.ts` + `http-solana-prepare-gateway.ts` + `app/api/settle/solana-sponsor/route.ts` + `solana-wallet.refundEscrow` + `solana-escrow-refund-gateway.ts`. Tests T5, T6.
- **W2 (rama `vm==="solana"`, ALTO riesgo — coordinar, nadie más toca `confirm-and-send.ts`)**: branch `solana?` en `confirm-and-send.ts` + wiring en `container.ts` (guard fail-loud) + acción refund en `flow.tsx`. Tests T1, T2, T7.
- **W3 (gate de tipos + regresión)**: `npx tsc --noEmit` COMPLETO (CD-18) + suite entera verde, cero assertion EVM cambiada (T3).

### Wave 13b — wasiai-facilitator (companion, branch propio, BAJO riesgo, read-only)
- +dep coder IDL (DT-4b) + `src/chains/solana-escrow.ts` (`readEscrowState`/`verifyVault`) + `escrowIdl` pinneado copiado. Tests TF1, TF2. **Sin dependencia dura con 13a** (puede ir en paralelo).

### Wave 13c — wasiai-facilitator (companion, branch propio, ALTO riesgo)
- `solana-release-authority.ts` (keypair singleton) + `release-shape.ts` + `cr1-release.ts` + `build-release.ts` + `solana-escrow-release-dedup.ts` + migración + `routes/solana-escrow.ts` + registro condicional en `app.ts`. Tests TF3-TF8. **Depende de**: HU-SOL-14 mergeada (primitiva `cosignAndBroadcast`) + Wave 13b (read/verify).

### Founder-gated (fuera de F3)
Deploy del facilitator con la release-authority; fondeo de keypairs con SOL devnet; activación de flags Solana; wiring del deposit-address Solana real de TransFi ([NC-1]); migración dedup del release.

---

## 8. Frontera de Scope y coordinación de merge

- **HU-SOL-9** (SDD 028, `resolveSolanaReleaseAuthorityPubkey` + `SolanaDepositAttestation` + rama Solana de prepare/settle): si mergea ANTES, esta HU **NO duplica** `resolveSolanaReleaseAuthorityPubkey` (lo consume) y reusa el esqueleto de atestación Solana. Si NO ha mergeado, W0 de 13a lo crea con el MISMO contrato (§4.4) — coordinar para evitar colisión de definición. Orden recomendado: **HU-SOL-9 → HU-SOL-13a**.
- **HU-SOL-14** (SDD 027, `cosignAndBroadcast` + `/solana/sponsor`): 13a consume `/solana/sponsor` para el broadcast del deposit; 13c consume la primitiva. Orden recomendado: **HU-SOL-14 → HU-SOL-13c**. 13a/13b pueden codearse/unit-testearse con mocks sin HU-SOL-14 mergeada (reachability e2e founder-gated).
- **`confirm-and-send.ts`**: archivo de MÁS alto riesgo del repo (WKH-210/211). NINGUNA otra HU debe tocarlo en la misma ventana. A la fecha no hay otra HU activa sobre él además de HU-SOL-9 (que toca `settle/principal/route.ts`/`prepare/route.ts`, NO el use-case) — coordinar orden de merge si ambas están abiertas.
- **Scope OUT**: armado del `deposit` (HU-SOL-5), broadcast gasless base (HU-SOL-14), `close` housekeeping, deploy/fondeo/flags, cambios a `solana-programs`, el valor del `deadline` (fijado por HU-SOL-5).

---

## 9. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|-----------|
| R-1: release firma sobre estado stale/inyectado (drain / doble-pago) | M | **Crítico** | CD-3/CD-4: read on-chain en la MISMA invocación + `beneficiary` de `state`; `validateReleaseForSponsor` estructural; dedup fail-closed (AC-5); doble red con `has_one` Anchor + CEI. Tests TF4/TF6/TF7. AR obligatorio ataca vectores. |
| R-2: tocar el path EVM al insertar la rama Solana | M | A | CD-14: `solana?` inyección NUEVA aislada, mutuamente excluyente; T3 asserta byte-identidad; tsc COMPLETO. |
| R-3: HU-SOL-9/HU-SOL-14 no mergeadas ⇒ 13a/13c no e2e | A | M | Código correcto + unit-tested con mocks; reachability founder-gated (§8). NO bloquea el merge unitario de cada wave. |
| R-4: `refundEscrow` client-side usa builtin Node ⇒ roto en browser | M | A | CD-15 (lección SOL-5 BLQ-MED-1): libs isomórficas; test browser-path. |
| R-5: coder IDL no disponible en el facilitator | B | M | DT-4b: añadir `@coral-xyz/anchor`/`borsh` pinneado (13b), SOLO para read de cuenta. |
| R-6: release-authority secret leak | B | **Crítico** | CD-6 + singleton throw-nombre-no-valor + redaction + opt-in-off. |
| R-7: refund con sender sin SOL devnet | B | B | devnet airdrop; refund es sender-feePayer por diseño (AC-6 excluye facilitator). Documentado [NC-3]. |

---

## 10. Uncertainty Markers

- **[NC-1 — NO bloqueante F3, founder/partner-gated]** Resolución REAL del `beneficiary` (deposit-address Solana de TransFi por orden): el agente `remit-cashout-payout` debe exponer un destino Solana (análogo al gap EVM de WKH-211). Esta HU cablea el seam (`SolanaPayoutPrepareGateway`) + mock; el address real es founder/partner. **Recomendación**: stub el prepare Solana devolviendo un beneficiary devnet de prueba hasta que el agente lo exponga; el binding/atestación ya queda listo.
- **[NC-2 — NO bloqueante F3]** Fuente del "orden TransFi completada/confirmada" que gatea el release (paso 2 de §4.6): (a) chaski pasa una atestación de orden confirmada al `/solana/escrow/release`, o (b) el facilitator consulta TransFi. **Recomendación**: (a) atestación server-firmada (mismo patrón que el settlement-attestation EVM), decisión final en F3 del companion.
- **[NC-3 — NO bloqueante F3]** El `deadline` on-chain = `quote.expiresAt` (minutos, fijado por HU-SOL-5) puede ser corto para un refund de "off-ramp falló". Esta HU NO lo cambia (Scope OUT). **Recomendación**: `refundEscrow` lee `EscrowState.deadline`/`status` on-chain (autoritativo) antes de habilitar; lengthening del deadline = follow-up sobre HU-SOL-5.
- **[NC-4 — NO bloqueante F3]** Coder de deserialización en el facilitator: `@coral-xyz/anchor` (`BorshAccountsCoder`) vs `@coral-xyz/borsh` (más liviano). Ambos cumplen DT-4. **Recomendación**: `@coral-xyz/anchor` (ya battle-tested chaski-side, misma pin).
- **[NC-5 — NO bloqueante F3]** Nombre/NNN del companion ticket + branch en `wasiai-facilitator` (candidato `WFAC-solana-escrow-release`): lo asigna el orquestador/founder.

**No hay `[NEEDS CLARIFICATION]` BLOQUEANTE en F2.** Los 2 bloqueantes del work-item quedan RESUELTOS por diseño: (#1 límite cablear↔broadcast) 13a consume el `/solana/sponsor` de HU-SOL-14 para el broadcast real, con el gateway unit-testeable por mock si esa HU no mergeó; (#2 authority de HU-SOL-9) el `resolveSolanaReleaseAuthorityPubkey` env-driven queda definido con contrato explícito (§4.4), consumido o creado idénticamente según el orden de merge (§8). Los 5 markers restantes son NO-bloqueantes (founder/partner o decisiones de F3).

---

## 11. Readiness Check

- [x] Los 7 ACs mapeados a waves (§2) con ≥1 archivo (§4.1) y ≥1 test (§6) cada uno.
- [x] Cada archivo nuevo tiene exemplar verificado con Read/Glob (§3 tablas + §4.1).
- [x] Programa escrow leído directamente (`lib.rs`): discriminators, `has_one`, CEI, guards refund/release confirmados contra el IDL pinneado (`escrow-idl.ts`).
- [x] Contratos consumidos leídos COMPLETOS: HU-SOL-9 (`resolveSolanaReleaseAuthorityPubkey`, `SolanaDepositAttestation`, rama prepare Solana) y HU-SOL-14 (`cosignAndBroadcast`, `SponsorTxValidator`, `/solana/sponsor`, `getFeePayerKeypair`, dedup, opt-in-off).
- [x] DT-1 (puerto nuevo), DT-2 (rama `solana?` mutuamente excluyente), DT-3 (beneficiary/authority server-side vs refund), DT-4/DT-4b (IDL coder), DT-5 (keypair singleton) RESUELTOS con justificación.
- [x] AC-3/AC-4/AC-5 (release seguro): read on-chain misma invocación (CD-3), beneficiary de `state` (CD-4), dedup fail-closed (CD-9), `validateReleaseForSponsor` + reuso `cosignAndBroadcast` (CD-11) — sin reimplementar la primitiva.
- [x] AC-6/AC-7 (refund): sender-signs+sender-broadcast, sin facilitator (CD-10); UI oculta pre-deadline; on-chain `DeadlineNotReached` como red final.
- [x] EVM byte-idéntico (CD-2/CD-14): rama Solana aislada en ambos repos; T3/TF8; tsc COMPLETO (CD-18).
- [x] Auto-Blindaje histórico incorporado: CD-15/CD-16 (SOL-5), CD-17/CD-18 (SOL-7/WKH-196).
- [x] Plan de tests incluye TODOS los vectores pedidos: deposit→verify-vault→release autorizado (T1+TF1-3), release NO autorizado / beneficiary inyectado / status≠Deposited → rechazado ANTES de firmar (TF4/TF6), release no-replayable (TF7), refund post-deadline ✔ / pre-deadline bloqueado (T6/T7), EVM byte-idéntico (T3/TF8).
- [x] Waves separan chaski (13a: W0-W3) de facilitator companion (13b read-only, 13c high-risk); dependencias cross-HU y orden de merge documentados (§8, §10).
- [x] Cero `[NEEDS CLARIFICATION]` BLOQUEANTE; 5 markers NO-bloqueantes (founder/partner o F3).

**Veredicto: LISTO PARA SPEC_APPROVED.**

---

*SDD generado por NexusAgil — FULL (F2). Autor: nexus-architect. Cross-repo chaski-v3 + wasiai-facilitator.*
