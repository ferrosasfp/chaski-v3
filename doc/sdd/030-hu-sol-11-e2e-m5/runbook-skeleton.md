# Runbook (founder-gated) — Cierre real de M5: e2e Solana devnet

> **Documentación, NO código.** No es parte de los Quality Gates de F3/AR/CR. Los pasos que quedan
> pendientes son founder-gated (merge de branches HELD, flip de flags de release, migraciones, IDs
> TransFi sandbox, corrida final del smoke con la pata fiat). **Actualizado 2026-07-22 con valores
> REALES** leídos de los repos montados (`wasiai-facilitator`, `wasiai-remittance-agents`) y de
> `m5-keys/M5-ENV-CHECKLIST.md` (gitignored).
>
> **Cero plata real** — todo devnet. **Flags OFF** salvo en el entorno aislado del smoke. **Secretos**
> (HMAC / private keys) viven SOLO en `m5-keys/*` (gitignored) y se cargan desde el panel de cada
> plataforma (Railway/Vercel) — **NUNCA** en este archivo versionado (CD-4). Acá solo van valores
> PÚBLICOS (pubkeys, addresses, program id, mint, tx signatures).

---

## 0. Estado real de M5 (2026-07-22) — qué YA está hecho

> **M5 CUMPLIDO en su núcleo**: el deposit no-custodial ya ocurrió on-chain en devnet, dos veces.

| Hecho | Evidencia |
|-------|-----------|
| ✅ Escrow Anchor **deployado** en devnet | Program id **`DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`** (`declare_id=DR5G`, upgrade-authority = fee-payer). El `BBQ9…` viejo NUNCA se deployó (keypair perdida) → DR5G es el canónico; código actualizado en los 3 repos (`escrow-idl.ts:9` en chaski). |
| ✅ Deposit no-custodial **directo** on-chain | tx `3y6qK6uUpYBRxGbZqbUnav4fVhMbYyyaTD8AGL3KgrvdzkeGBBqRxgE7S9LPac7HVAeBVbZkqgdcUByBtVN3bAMs` ([explorer](https://explorer.solana.com/tx/3y6qK6uUpYBRxGbZqbUnav4fVhMbYyyaTD8AGL3KgrvdzkeGBBqRxgE7S9LPac7HVAeBVbZkqgdcUByBtVN3bAMs?cluster=devnet)) |
| ✅ Deposit **gasless** vía facilitator `/solana/sponsor` | tx `2PcvKgsZFeBo4xHgKZTnSHLREyAyZHRkw57pVev3j7JV2JdPJ4FgYcyyg5ToLgGoTUE3v52FA6NGBke32mDVPZV2` ([explorer](https://explorer.solana.com/tx/2PcvKgsZFeBo4xHgKZTnSHLREyAyZHRkw57pVev3j7JV2JdPJ4FgYcyyg5ToLgGoTUE3v52FA6NGBke32mDVPZV2?cluster=devnet)) |
| ✅ Vault del escrow fondeado | escrowState PDA `GXY2todK6pJPdT8h1EcRNZgFX7cZXEnDN7L3XSHCHY2J` (owner=DR5G); vault ATA `Hc2h5FS1hpgGEFLSd7wrrr6f3JVvgq5jzXsGA4yEKWhF` = **10 USDC** confirmados on-chain |
| ✅ Facilitator con `/solana/sponsor` registrado + `SOLANA_ESCROW_PROGRAM_ID=DR5G` seteado en Railway | HU-SOL-9 (wire facilitator) DONE hoy; sponsor probado (tx gasless de arriba) |
| ✅ Código chaski de esta HU **mergeado** | rama Solana de `prepare/route.ts` + `scripts/smoke-solana-e2e.ts` + `.env.example` — commits `64ec019` (código) + `89628d8` (BBQ9→DR5G + rework smoke) en branch `feat/m5-escrow-dr5g-address` |

### Qué QUEDA (founder-gated)

1. **Merge de branches HELD**: `feat/m5-escrow-dr5g-address` (chaski) + HU-SOL-6 (`feat/026-wkh-205-solana-adapter`) + `feat/029bc-hu-sol-13bc-escrow-facilitator` (facilitator).
2. **Habilitar la pata de release** en Railway (facilitator): `SOLANA_ESCROW_RELEASE_ENABLED=true` + `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` + `SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET` (secretos en `m5-keys/`).
3. **Migraciones**: `004` (facilitator, escrow release dedup) + la de chaski (verificar nombre exacto en `supabase/` en el deploy).
4. **IDs sandbox TransFi** para el corredor Solana (`TRANSFI_USDC_NETWORK=solana`) en `remit-agents`.
5. **Flip de flags** SOLO en el entorno aislado del smoke (nunca compartido).
6. **Corrida final del smoke** con la pata fiat (release + orden TransFi). Hoy los checkpoints 1-6 (hasta vault Deposited) pasan; los checkpoints 7-8 (release/TransFi) son best-effort diferidos (requieren KYC Didit real + credenciales TransFi sandbox).

---

## Direcciones públicas (devnet) — seguras de versionar

| Rol | Pubkey / Address |
|-----|------------------|
| Escrow program (deployado) | `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x` |
| Fee-payer (facilitator, gasless) → `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY` de chaski | `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH` |
| Release-authority → `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` de chaski | `9rphjeRUekSbVpDZhzN9roQQmn6yndodRVfiBvyEAGAV` |
| Beneficiary (deposit-address stub del escrow) | `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` |
| Sender (firma el deposit) | `8tJVcM2JehYkyPLHUZ3rxNvhfADaQdHx7xaJw6kS6ux8` |
| USDC devnet mint (test, 6 dec) | `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q` |
| RPC devnet | `https://api.devnet.solana.com` |

> **Secretos** (PAYOUT_POP_SECRET, SOLANA_SPONSOR_POP_SECRET, DEPOSIT_ATTESTATION_SECRET, private keys
> `fee-payer.json` / `release-authority.json` / `sender.json` / `sender.b58`): en `m5-keys/`
> (gitignored). **NUNCA** copiar a este archivo. Los valores concretos están en
> `m5-keys/M5-ENV-CHECKLIST.md`.

---

## Tabla A — `wasiai-facilitator` (Railway) · envs Solana

Fuente: `wasiai-facilitator/src/infra/env.ts` + `routes/solana-sponsor.ts` + `routes/solana-escrow.ts` (grep verificado, repo montado).

| Var | Valor / Rol | Estado |
|-----|-------------|--------|
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` — lee el vault + broadcastea | ✅ set |
| `SOLANA_USDC_MINT` | `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q` | ✅ set |
| `SOLANA_ESCROW_PROGRAM_ID` | `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x` — CR-1 del sponsor valida contra esto | ✅ set (Railway) |
| `SOLANA_FEE_PAYER_PRIVATE_KEY` | `m5-keys/fee-payer.json` (array JSON 64 nums) — su pubkey = `4wPhH4d…54jH` | ✅ set |
| `SOLANA_FEE_PAYER_SPONSOR_ENABLED` | `true` → registra `POST /solana/sponsor` (default OFF ⇒ 404) | ✅ set + probado |
| `SOLANA_SPONSOR_POP_SECRET` | secreto PoP del sponsor (`m5-keys/M5-ENV-CHECKLIST.md`) | ✅ set |
| `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` | `m5-keys/release-authority.json` — su pubkey = `9rphjeR…AGAV` | ⏳ pendiente (pata release) |
| `SOLANA_ESCROW_RELEASE_ENABLED` | `true` → registra `POST /solana/escrow/release` (default OFF ⇒ 404) | ⏳ pendiente |
| `SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET` | secreto de la atestación KYC+TransFi que autoriza el release | ⏳ pendiente |

> Envs de topes/rate-limit del sponsor (`SOLANA_SPONSOR_MAX_*`, `SOLANA_SPONSOR_RATE_LIMIT_*`,
> `SOLANA_SPONSOR_DAILY_MAX_LAMPORTS`, `SOLANA_SPONSOR_MAX_REBROADCASTS`): opcionales, usan defaults
> del facilitator. No bloquean M5.

---

## Tabla B — `wasiai-remittance-agents` (Vercel) · envs corredor Solana

Fuente: grep `wasiai-remittance-agents/src/` (repo montado) + `m5-keys/M5-ENV-CHECKLIST.md`.

| Var | Valor / Rol | Estado |
|-----|-------------|--------|
| `TRANSFI_USDC_NETWORK` | `solana` — activa el corredor Solana | ⏳ pendiente |
| `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` | `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` — escape-hatch devnet (deposit-address stub) | ⏳ pendiente |
| `PAYOUT_ALLOW_MOCK` | `true` — usa `FallbackPayoutProvider` + escape-hatch devnet | ⏳ pendiente |
| `TRANSFI_ADAPTER_READY` / `TRANSFI_API_KEY` / `TRANSFI_MID` / `TRANSFI_USER_ID` / credenciales | **NO setear** para el smoke devnet → mock + escape-hatch (evita depender del sandbox TransFi real) | ⏳ founder (fase fiat real) |

> Para el smoke M5 devnet se usa `PAYOUT_ALLOW_MOCK=true` + el deposit-address stub: el objetivo de M5
> es la **tx del deposit on-chain**, no la orden fiat real. La pata TransFi real (adapter ready +
> credenciales sandbox) es fase posterior, founder-gated.

---

## Tabla C — `chaski-v3` (Vercel, deploy PREVIEW) · envs Solana

Fuente: `.env.example` (AC-7) + `m5-keys/M5-ENV-CHECKLIST.md`. Deploy **preview** para que el KYC sea
`simulated_dev` (`VERCEL_ENV=preview`, sin `DIDIT_API_KEY`).

| Var | Valor | Nota |
|-----|-------|------|
| `NEXT_PUBLIC_VM` | `solana` | flip SOLO en preview del smoke (CD-5) |
| `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` | `true` | idem |
| `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY` | `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH` | fee-payer pubkey |
| `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` | `9rphjeRUekSbVpDZhzN9roQQmn6yndodRVfiBvyEAGAV` | server-only; `prepare` Solana la exige |
| `NEXT_PUBLIC_SOLANA_USDC_MINT` | `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q` | |
| `NEXT_PUBLIC_SOLANA_RPC_URL` / `SOLANA_DEVNET_RPC_URL` | `https://api.devnet.solana.com` | |
| `PAYOUT_POP_SECRET` | `m5-keys/` (gitignored) | PoP Solana OBLIGATORIO en `prepare` |
| `DEPOSIT_ATTESTATION_SECRET` | `m5-keys/` (gitignored) | habilita `prepare` (503 sin él) |
| `FACILITATOR_BASE_URL` / `FACILITATOR_API_KEY` | URL Railway del facilitator + API key | para `/api/settle/solana-sponsor` |
| `DIDIT_API_KEY` | **NO setear** en preview | ⇒ KYC `simulated_dev` |

---

## Los pasos founder-gated restantes (NO F3)

1. **Merge branches HELD**: `feat/m5-escrow-dr5g-address` (chaski) + `feat/026-wkh-205-solana-adapter`
   (HU-SOL-6, facilitator) + `feat/029bc-hu-sol-13bc-escrow-facilitator` (facilitator) → deploy Railway.
2. **Migraciones**: `004` (facilitator, escrow release dedup) + la de chaski (verificar nombre exacto en
   `supabase/` en el deploy; no bloquea el código de F3).
3. **Habilitar release** (Tabla A, filas ⏳): `SOLANA_ESCROW_RELEASE_ENABLED=true` + secret key +
   attestation secret en Railway.
4. **Setear remit** (Tabla B): `TRANSFI_USDC_NETWORK=solana` + `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` +
   `PAYOUT_ALLOW_MOCK=true` en Vercel.
5. **Deploy chaski preview** (Tabla C) con las envs seteadas.
6. **Flip de flags** SOLO en el entorno aislado del smoke (`NEXT_PUBLIC_VM=solana`,
   `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED=true`, `SOLANA_FEE_PAYER_SPONSOR_ENABLED=true` ya on,
   `SOLANA_ESCROW_RELEASE_ENABLED=true`). ⚠️ NUNCA en un entorno compartido (CD-5).
7. **Correr el smoke** (`npm run smoke:solana`) con las `SMOKE_*` armadas desde `m5-keys/` + las URLs
   deployadas. Los `SMOKE_*` se documentan en el header de `scripts/smoke-solana-e2e.ts` + §4 de
   `m5-keys/M5-ENV-CHECKLIST.md`:
   ```
   export SMOKE_ALLOW_REAL=true
   export SMOKE_CHASKI_URL=<preview url chaski>
   export SMOKE_FACILITATOR_URL=<railway url facilitator>
   export SMOKE_REMIT_URL=<vercel url remit>
   export SMOKE_SENDER_SECRET_KEY=$(cat m5-keys/sender.b58)
   export SMOKE_KYC_VERIFICATION_ID=devnet-smoke-kyc        # cualquier string (simulated_dev)
   export SMOKE_REMITTANCE_ID=m5-smoke-$(date +%s)
   export SMOKE_QUOTE_ID=m5-quote-1
   export SMOKE_AMOUNT_USD=10
   export SMOKE_SOLANA_USDC_MINT=8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q
   export SMOKE_SOLANA_FACILITATOR_PUBKEY=4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH
   export SMOKE_SPONSOR_POP_SECRET=<m5-keys/M5-ENV-CHECKLIST.md>
   cd /home/ferdev/.openclaw/workspace/chaski-v3 && npm run smoke:solana
   ```
   El smoke aborta fail-loud si falta `SMOKE_ALLOW_REAL=true` (AC-6) o cualquier env requerida (AC-5).
8. **Capturar el link de Solana Explorer** que imprime el checkpoint 5/9
   (`https://explorer.solana.com/tx/<sig>?cluster=devnet`) y adjuntarlo como evidencia de cierre de M5.
   Los checkpoints 7-8 (release/TransFi, best-effort) se cierran cuando estén las creds fiat reales.
