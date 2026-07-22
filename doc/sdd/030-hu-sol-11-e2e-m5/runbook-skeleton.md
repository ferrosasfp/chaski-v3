# Runbook (esqueleto founder-gated) — Cierre real de M5: e2e Solana devnet

> **Documentación, NO código.** No es parte de los Quality Gates de F3/AR/CR. Ninguno de estos 8 pasos
> se ejecuta en F3: son founder-gated (deploy, keypairs devnet reales, IDs TransFi sandbox, flip de
> flags, ejecución real del smoke y captura de la tx en el explorer). `nexus-docs` materializa el
> runbook completo en DONE; este es el esqueleto autoritativo con las envs cross-repo verificadas
> contra el código real de los repos montados en `/home/ferdev/.openclaw/workspace/`.
>
> **Cero plata real** — todo devnet. **Flags OFF** salvo en el entorno aislado del smoke. **Secretos**
> desde el panel de cada plataforma (Railway/Vercel), NUNCA en el repo.

---

## Tabla A — `wasiai-facilitator` (Railway) · envs Solana

Fuente: `wasiai-facilitator/src/infra/env.ts` + `routes/solana-*.ts` (verificadas por grep).

| Var | Rol |
|-----|-----|
| `SOLANA_RPC_URL` | RPC devnet (lee el vault del escrow + broadcastea las tx). |
| `SOLANA_USDC_MINT` | Mint USDC devnet (pin de referencia del adapter). |
| `SOLANA_TOKEN_PROGRAM_ID` | Program id del SPL Token program. |
| `SOLANA_ESCROW_PROGRAM_ID` | Program id del escrow Anchor (== `escrowIdl.address` de chaski). |
| `SOLANA_FEE_PAYER_PRIVATE_KEY` | Keypair del fee-payer (gasless). **Su pubkey = `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY` de chaski.** |
| `SOLANA_FEE_PAYER_SPONSOR_ENABLED` | Registra `POST /solana/sponsor`. Default OFF ⇒ 404. |
| `SOLANA_SPONSOR_POP_SECRET` | Secreto PoP del sponsor (valida la prueba de posesión del sender). |
| `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` | Keypair PRIVADA de la release-authority. **Su pubkey = `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` de chaski.** |
| `SOLANA_ESCROW_RELEASE_ENABLED` | Registra `POST /solana/escrow/release`. Default OFF ⇒ 404. |
| `SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET` | Secreto de la atestación (KYC+TransFi) que autoriza el release. |
| `SOLANA_SPONSOR_MAX_COMPUTE_UNITS` | Tope de compute units de la tx sponsoreada. |
| `SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS` | Tope del priority fee (microlamports). |
| `SOLANA_SPONSOR_MAX_FEE_LAMPORTS` | Tope del fee total (lamports) por tx. |
| `SOLANA_SPONSOR_RATE_LIMIT_MAX` | Máx. de sponsors por ventana. |
| `SOLANA_SPONSOR_RATE_LIMIT_WINDOW_SEC` | Ventana del rate-limit (segundos). |
| `SOLANA_SPONSOR_DAILY_MAX_LAMPORTS` | Tope diario de gasto en lamports del fee-payer. |
| `SOLANA_SPONSOR_MAX_REBROADCASTS` | Máx. de rebroadcasts ante blockhash expirado. |

---

## Tabla B — `wasiai-remittance-agents` (Vercel) · envs corredor Solana

Fuente: grep `wasiai-remittance-agents/src/` (verificadas).

| Var | Rol |
|-----|-----|
| `TRANSFI_USDC_NETWORK` | `solana` para el corredor Solana. |
| `TRANSFI_ADAPTER_READY` | `true` ⇒ el agente expone `depositAddress` real (no-null); sin él, mock ⇒ `prepare` fail-closed. |
| `TRANSFI_DEFAULT_NETWORK` | Red por defecto de la orden TransFi. |
| `TRANSFI_USDC_CURRENCY` | Moneda/símbolo USDC de la orden. |
| `TRANSFI_API_KEY` | API key del sandbox TransFi. |
| `TRANSFI_BASE` / `TRANSFI_BASE_URL` | Base(s) de la API TransFi. |
| `TRANSFI_MID` | Merchant id. |
| `TRANSFI_USERNAME` / `TRANSFI_PASSWORD` | Credenciales del sandbox. |
| `TRANSFI_USER_ID` | User id de la cuenta sandbox. |
| `TRANSFI_PAYMENT_CODE` | Código de método de pago. |
| `TRANSFI_PURPOSE_CODE` | Código de propósito de la remesa. |
| `TRANSFI_SOURCE_URL` | URL fuente de la orden. |
| `TRANSFI_SOURCE_WALLET_ADDRESS` | Wallet de origen de los fondos. |

> Los IDs concretos del sandbox (`TRANSFI_MID`, `TRANSFI_USER_ID`, credenciales) los provee el founder;
> NUNCA se versionan.

---

## Los 8 pasos (founder + equipo en el deploy — NO F3)

1. **Merge + deploy `wasiai-facilitator`** a Railway (orden `026 → 027 → 13bc`, hoy HELD).
2. **Migraciones**: `004` (facilitator — escrow release dedup) + la de chaski. El **nombre exacto** de
   la migración de chaski se verifica en `supabase/` en el momento del deploy (uncertainty founder-only,
   NO bloquea F3).
3. **Generar + fondear keypairs devnet** (`solana-keygen` + faucet devnet):
   - fee-payer → `SOLANA_FEE_PAYER_PRIVATE_KEY` (facilitator); su pubkey → `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY` (chaski).
   - release-authority → `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` (facilitator); su pubkey → `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` (chaski).
4. **IDs sandbox TransFi Solana**: `TRANSFI_USDC_NETWORK=solana` + `TRANSFI_ADAPTER_READY=true` + IDs de orden/credenciales (Tabla B).
5. **Deploy Vercel** de `chaski-v3` y `remit-agents` con las envs de §4.7 (`.env.example`) + Tablas A/B seteadas.
6. **Flip de flags SOLO en el entorno aislado del smoke**:
   `NEXT_PUBLIC_VM=solana`, `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED=true`,
   `SOLANA_FEE_PAYER_SPONSOR_ENABLED=true`, `SOLANA_ESCROW_RELEASE_ENABLED=true`.
   ⚠️ NUNCA en un entorno compartido (CD-5).
7. **Correr `npm run smoke:solana`** con las `SMOKE_*` apuntando a los servicios deployados
   (`SMOKE_ALLOW_REAL=true` + las 8 requeridas + `SMOKE_SOLANA_USDC_MINT` + `SMOKE_SOLANA_FACILITATOR_PUBKEY`;
   ver el header de `scripts/smoke-solana-e2e.ts`). El smoke aborta fail-loud si falta cualquiera.
8. **Capturar el link de Solana Explorer** (`https://explorer.solana.com/tx/<sig>?cluster=devnet`) que
   imprime el checkpoint 9 y adjuntarlo como evidencia de cierre de M5.
