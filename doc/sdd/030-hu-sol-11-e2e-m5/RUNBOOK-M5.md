# RUNBOOK-M5 — Cierre real de M5: e2e Solana devnet (8 pasos founder-gated)

> **Documentación ejecutable founder-only.** Ninguno de estos 8 pasos se ejecuta en F3 (desarrollador). Son pasos que SOLO el founder puede ejecutar: deploy a producción, generación/fondeo de keypairs devnet reales, obtención de IDs sandbox TransFi, flip de flags en entorno aislado, ejecución del smoke contra servicios deployados en vivo.
>
> **Cero plata real**: todo devnet. **Flags OFF** salvo en el entorno aislado del smoke. **Secretos** desde el panel de cada plataforma (Railway/Vercel), NUNCA versionados en repo.

> ### 📌 Documentos relacionados (leer ANTES de operar)
> - **`ESCROW-DEVNET-RECIPE.md`**: la receta del circuito completo (deposit gasless, release, refund) que **ya corrió y se verificó on-chain el 2026-07-27**, con la autenticación, el formato del attestation y la advertencia de guardar el `remittanceId`. Si vas a mover un escrow a mano, empezá por ahí.
> - **`runbook-skeleton.md`**: snapshot del estado de M5 al 2026-07-22 con las direcciones devnet reales.
>
> ### 🔑 Autenticación del facilitator
> Todos los endpoints del facilitator usan **`Authorization: Bearer <FACILITATOR_API_KEY>`**. **`X-API-Key` devuelve 401** (`wasiai-facilitator/src/middleware/auth.ts:102-106` lee solo el header `authorization` y exige el prefijo `Bearer `). Detalle y de dónde sacar la key: §0 de `ESCROW-DEVNET-RECIPE.md`.
>
> ### 🧾 Corrección 2026-07-27
> Este archivo tenía valores inventados y estados obsoletos que costaron dos intentos de ejecución. Lo barrimos completo contra el código, el IDL y el RPC de devnet. Lo corregido queda marcado con **[corregido 2026-07-27]**.

---

## Tabla A — Envs de `wasiai-facilitator` (Railway) · Solana

**Fuente**: `wasiai-facilitator/src/infra/env.ts` + routes `solana-*.ts` (re-verificado línea por línea el 2026-07-27).

| Var | Rol | Valor (devnet) |
|-----|-----|----------------|
| `FACILITATOR_API_KEY` | Key que exige el Bearer de TODOS los endpoints. **Obligatoria** fuera de `NODE_ENV=test` (`env.ts:351-356`) | Ya seteada. Para llamar desde afuera, sacala del Vercel de Chaski, entorno **preview** (§0 de la receta) |
| `SOLANA_RPC_URL` | RPC devnet (lee vault escrow + broadcast tx) | `https://api.devnet.solana.com` |
| `SOLANA_USDC_MINT` | Mint USDC que acepta el adapter | `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q` **[corregido 2026-07-27]** (era el mint de Circle `4zMMC9…pegg7`, que ni existe en devnet hoy: el circuito corre sobre el mint de PRUEBA nuestro, verificado `decimals=6`) |
| `SOLANA_TOKEN_PROGRAM_ID` | Program id de SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` **[corregido 2026-07-27]** (el valor anterior `TokenkegQfeZyiNwAJsyFbPVww…` NO es un pubkey válido: `new PublicKey()` tira `Invalid public key input`. Real: `src/chains/solana-adapter.ts:45`, `escrow-idl.ts:243`) |
| `SOLANA_ESCROW_PROGRAM_ID` | Program id del escrow Anchor (whitelist de CR-1) | `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`. **Ya es el default del código** (`env.ts:206-210`), igual a `escrowIdl.address` (`chaski-v3/src/infrastructure/solana/escrow-idl.ts:9`). Setearla explícito no molesta |
| `SOLANA_FEE_PAYER_PRIVATE_KEY` | Keypair privada del fee-payer (gasless) | **Array JSON de 64 números** (contenido de `fee-payer.json`, formato Solana CLI, NO base58) |
| `SOLANA_FEE_PAYER_SPONSOR_ENABLED` | Registra `POST /solana/sponsor`. Default `false` ⇒ la ruta **no se registra** y da 404 (`app.ts:405-407`) | `true` (solo en devnet/test) |
| `SOLANA_SPONSOR_POP_SECRET` | Secreto PoP del sponsor (valida prueba de posesión del sender). Fail-closed: sin él se rechaza TODO (`methods/solana-sponsor/pop.ts:36`) | Generado en paso 3 |
| `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` | Keypair privada release-authority | **Array JSON de 64 números** (contenido de `release-authority.json`, NO base58) |
| `SOLANA_ESCROW_RELEASE_ENABLED` | Registra `POST /solana/escrow/release`. Default `false` ⇒ 404 (`app.ts:410-412` + `infra/solana-release-authority.ts:120-130`) | `true` (solo en devnet/test) |
| `SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET` | Clave del HMAC que autoriza el release (`routes/solana-escrow.ts:174`, leída de `process.env` directo) | Hoy se setea con el MISMO valor que `DEPOSIT_ATTESTATION_SECRET` de Chaski, pero **son dos atestaciones distintas** (ver gotcha 4 de la receta). Formato del HMAC: §4 de la receta |

Topes y rate-limit del sponsor (opcionales, **no bloquean M5**). Los valores de abajo son los **defaults reales del código** **[corregido 2026-07-27]** (la tabla anterior daba "ejemplos típicos" inventados, entre ellos `SOLANA_SPONSOR_MAX_FEE_LAMPORTS=5000000`, 50x el default):

| Var | Default real | Cita |
|-----|--------------|------|
| `SOLANA_SPONSOR_MAX_COMPUTE_UNITS` | `300000` | `env.ts:212` |
| `SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS` | `50000` | `env.ts:213` |
| `SOLANA_SPONSOR_MAX_FEE_LAMPORTS` | `100000` (0.0001 SOL) | `env.ts:216` |
| `SOLANA_SPONSOR_RATE_LIMIT_MAX` | `20` | `env.ts:218` |
| `SOLANA_SPONSOR_RATE_LIMIT_WINDOW_SEC` | `60` | `env.ts:219` |
| `SOLANA_SPONSOR_DAILY_MAX_LAMPORTS` | `500000000` (0.5 SOL, tope diario agregado, fail-closed) | `env.ts:223-226` |
| `SOLANA_SPONSOR_MAX_REBROADCASTS` | `3` | `env.ts:228` |

---

## Tabla B — Envs de `wasiai-remittance-agents` (Vercel) · Solana

**Fuente**: grep `wasiai-remittance-agents/src/` (nombres de env re-verificados uno por uno el 2026-07-27: los 14 existen en el código).

> ### ⛔ `TRANSFI_ADAPTER_READY` NO se setea para el smoke devnet **[corregido 2026-07-27]**
> Este runbook mandaba `TRANSFI_ADAPTER_READY=true` (acá y en el troubleshooting del paso 7). **Está mal para devnet** y contradice a `m5-keys/M5-ENV-CHECKLIST.md`, que es más nuevo y es el que manda.
>
> Motivo, en el código: `wasiai-remittance-agents/src/agents/cashout-payout.ts:66-72` considera que hay un provider de payout **REAL** cuando `TRANSFI_USERNAME` + `TRANSFI_PASSWORD` + `TRANSFI_MID` están seteadas **y** `TRANSFI_ADAPTER_READY === "true"`. Ese combo habilita el **desembolso real de plata**. El propio comentario del código (`:74-80`) dice que activarlo en cualquier deploy que no sea el de la etapa real es un **incidente de seguridad money-path**.
>
> Para el smoke devnet (cero plata real) va: `PAYOUT_ALLOW_MOCK=true` (habilita SOLO el `FallbackPayoutProvider`, que no mueve plata) + `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` como escape-hatch, y **sin** `TRANSFI_ADAPTER_READY` ni credenciales TransFi. Si `PAYOUT_ALLOW_MOCK` tampoco está, en producción el agente tira `payout_refused` (fail-safe intacto, `cashout-payout.ts:80-82`).

**Para el smoke devnet (lo único que hay que setear):**

| Var | Rol | Valor |
|-----|-----|-------|
| `TRANSFI_USDC_NETWORK` | Red para corredor Solana | `solana` |
| `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` | Escape-hatch devnet: deposit-address stub | `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` |
| `PAYOUT_ALLOW_MOCK` | Habilita el `FallbackPayoutProvider` (mock, NO mueve plata) | `true` |
| `TRANSFI_ADAPTER_READY` | **NO SETEAR** en devnet (ver caja de arriba) | (ausente) |

**Fase fiat real (founder-gated, cuando haya credenciales sandbox y decisión explícita):**

| Var | Rol | Valor |
|-----|-----|-------|
| `TRANSFI_ADAPTER_READY` | `true` ⇒ el agente resuelve `depositAddress` real y el payout deja de ser mock | `true` (SOLO fase real) |
| `TRANSFI_DEFAULT_NETWORK` | Red default de la orden | `solana` |
| `TRANSFI_USDC_CURRENCY` | Símbolo USDC | `USDC` |
| `TRANSFI_API_KEY` | API key sandbox TransFi | Provisto por TransFi |
| `TRANSFI_BASE_URL` | Base URL de la API | `https://sandbox-api.transfi.com` (es el default del payout, `src/providers/payout.ts:16`). ⚠️ **Ojo**: el provider de FX usa la MISMA env pero su default es **producción**, `https://api.transfi.com` (`src/providers/fx.ts:9`). Si dejás la env sin setear, el payout va a sandbox y el FX a prod |
| `TRANSFI_MID` | Merchant id | Provisto por TransFi |
| `TRANSFI_USERNAME` | Credencial sandbox | Provisto por TransFi |
| `TRANSFI_PASSWORD` | Credencial sandbox | Provisto por TransFi |
| `TRANSFI_USER_ID` | User id de la cuenta | Provisto por TransFi |
| `TRANSFI_PAYMENT_CODE` | Código de método de pago | Provisto por TransFi |
| `TRANSFI_PURPOSE_CODE` | Código de propósito remesa | Provisto por TransFi |
| `TRANSFI_SOURCE_URL` | URL fuente de la orden | URL del cliente Chaski |
| `TRANSFI_SOURCE_WALLET_ADDRESS` | Wallet de origen fondos | Dirección Solana sender |

---

## Los 8 pasos (FOUNDER-ONLY)

### Paso 1: Merge + deploy `wasiai-facilitator` a Railway

> ### ✅ El merge YA ESTÁ HECHO **[corregido 2026-07-27]**
> Este paso decía que el orden de branches `026 → 027 → feat/029bc-hu-sol-13bc-escrow-facilitator` estaba **HELD**. Es falso: están mergeadas a `main` en los dos repos. Verificado con `git log --oneline -1 main` el 2026-07-27:
>
> | Repo | `main` |
> |------|--------|
> | `chaski-v3` | `a79cca2` (`merge: el cliente A2A puede elegir la red donde se cobra el fee del agente`) |
> | `wasiai-facilitator` | `75099ef` (`merge: el health del facilitator dejaba de mentir en rojo permanente`) |
>
> Queda solo la parte de deploy y envs de abajo.

1. Verificar que no quedan flags Solana en ON en el entorno compartido (prod): deben estar OFF por defecto (los dos flags Solana son opt-in-off, ver Tabla A)
2. Deploy a Railway usando el CLI o el panel de Railway:
   ```bash
   railway up
   # o via panel: conectar branch `main` al deployment de producción
   ```
3. Verificar que el deployment está HEALTHY (200 en `/health`, logs sin errores de inicio). El facilitator **no tiene root route**, así que el healthcheck es `/health` (por eso el smoke lo chequea así: `scripts/smoke-solana-e2e.ts:110`)
4. Recordá que setear envs en Railway dispara un redeploy automático: si agregás `SOLANA_*` después del deploy inicial, esperá a que levante el nuevo build antes de probar

**⚠️ BLOQUEADOR**: si Railway falla o las migraciones del paso 2 no se ejecutan, el smoke fallará en los checkpoints de sponsor/release (paso 7).

---

### Paso 2: Aplicar migraciones en bases de datos

**Facilitator** (Supabase de `wasiai-facilitator`):
- `supabase/migrations/004_facilitator_solana_release_dedup.sql` (escrow release dedup). Nombre exacto verificado en el repo el 2026-07-27
- Verificar estado: `supabase migration list` (si está en CD/pipeline) o aplicar manualmente en la consola de Supabase

**Chaski** (Supabase de `chaski-v3`):
- `supabase/migrations/20260721T000000_add_vm_network_id_to_remittance_settlements.sql` **[corregido 2026-07-27]** (antes decía solo "`20260721` (nombre confirmado en momento de deploy)"; el nombre completo está en el repo)
- Aplicar via `supabase migration up` o consola

⚠️ Si una migración falla o no se ejecuta, la persistencia/recuperación de datos fallará después.

---

### Paso 3: Generar + fondear keypairs devnet

> **Al 2026-07-27 este paso ya está hecho**: `m5-keys/{fee-payer,release-authority,sender,beneficiary,gateway-operator}.json` existen y están fondeadas (fee-payer 6.69 SOL, release-authority 5.00 SOL, sender 5.18 SOL, verificado por RPC). El script **no regenera** un archivo que ya existe, así que es seguro re-correrlo. Las pubkeys están en la tabla §2 de `ESCROW-DEVNET-RECIPE.md`.

**Usá el script helper** (hace las 2 keypairs, las fondea y te imprime los valores exactos para cada env):
```bash
cd /ruta/a/chaski-v3
./scripts/gen-devnet-keys.sh
# Genera ./m5-keys/{fee-payer,release-authority}.json (gitignoreados),
# los fondea vía airdrop devnet, e imprime al final el mapeo:
#   RAILWAY: SOLANA_FEE_PAYER_PRIVATE_KEY / SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY
#   VERCEL:  NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY / SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY
```

**⚠️ FORMATO DE LA PRIVATE KEY (crítico — verificado en el código del facilitator):**
El código hace `Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env)))` → el valor de la env es el **array JSON de 64 números** (el contenido literal del `.json`, ej. `[12,34,...,255]`), **NO base58**. Si pegás base58 el deploy falla al iniciar.
- `SOLANA_FEE_PAYER_PRIVATE_KEY` = `cat m5-keys/fee-payer.json` (el array completo)
- `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` = `cat m5-keys/release-authority.json`

**Pubkeys (públicos, base58) → Chaski/Vercel:**
- pubkey del fee-payer → `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY`
- pubkey de release-authority → `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` (server-only, sin `NEXT_PUBLIC_`)

Manual (si preferís sin el script):
```bash
solana-keygen new --no-bip39-passphrase -o m5-keys/fee-payer.json
solana address -k m5-keys/fee-payer.json          # → el pubkey (base58)
solana airdrop 10 <pubkey> --url devnet           # repetir 2-3x (~30 SOL)
cat m5-keys/fee-payer.json                          # → el array JSON = la env PRIVATE_KEY
```

⚠️ Verificá `solana balance <pubkey> --url devnet` > 0 antes de continuar. NUNCA commitees los `.json`.

---

### Paso 4: Obtener IDs sandbox TransFi Solana

> ### ⏭️ Este paso NO es necesario para el smoke devnet **[corregido 2026-07-27]**
> El smoke devnet corre con `PAYOUT_ALLOW_MOCK=true` + el escape-hatch `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` (ver Tabla B). Las credenciales TransFi pertenecen a la **fase fiat real**, que es founder-gated y posterior. Setear estas envs junto con `TRANSFI_ADAPTER_READY=true` habilita desembolso REAL de plata.

Contactar al partner TransFi (o si tienes credenciales sandbox):
1. Confirmar que TRANSFI_USDC_NETWORK = `solana` está activado en el sandbox
2. Obtener:
   - `TRANSFI_MID` (merchant id)
   - `TRANSFI_USER_ID`
   - `TRANSFI_API_KEY`
   - `TRANSFI_USERNAME`, `TRANSFI_PASSWORD`
   - `TRANSFI_PAYMENT_CODE`, `TRANSFI_PURPOSE_CODE`
   - URLs base (`TRANSFI_BASE_URL`)

3. Guardar en un lugar seguro (vault/1password, **nunca versionado**)

⚠️ Sin estos IDs, remit-agents no puede crear órdenes Solana.

---

### Paso 5: Deploy Vercel de Chaski + remit-agents

**`chaski-v3` (Vercel)**: el deploy del smoke es **PREVIEW**, no prod (así el KYC resuelve `simulated_dev` con `VERCEL_ENV=preview` y sin `DIDIT_API_KEY`):
1. Preparar las envs que faltan en el panel de Vercel (lista completa y valores en `m5-keys/M5-ENV-CHECKLIST.md` §2):
   - `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` (pubkey público de la release-authority, paso 3; server-only, sin `NEXT_PUBLIC_`)
   - `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY` (pubkey público del fee-payer, paso 3)
   - `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED=false` (OFF por defecto; se enciende en paso 6 solo en el entorno del smoke)
   - `NEXT_PUBLIC_SOLANA_USDC_MINT`, `NEXT_PUBLIC_SOLANA_RPC_URL`, `SOLANA_DEVNET_RPC_URL`
   - `PAYOUT_POP_SECRET` (el `prepare` Solana lo exige)
   - `DEPOSIT_ATTESTATION_SECRET` (sin él el `prepare` responde 503). **[corregido 2026-07-27]** Antes decía "mismo que facilitator, compartido": hoy se setea con el mismo VALOR que `SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET`, pero son dos atestaciones de formato distinto (ver gotcha 4 de `ESCROW-DEVNET-RECIPE.md`); no asumas que son intercambiables a nivel formato
   - `FACILITATOR_BASE_URL` + `FACILITATOR_API_KEY`: los usa `/api/settle/solana-sponsor` para hablarle al facilitator con el Bearer server-side (`src/infrastructure/settlement/facilitator-client.ts:112`, `:217`)
   - **NO** setear `DIDIT_API_KEY` en preview (así el KYC queda `simulated_dev`)

2. Deploy:
   ```bash
   vercel deploy            # PREVIEW (lo que usa el smoke)
   # vercel deploy --prod   # solo si querés prod, con los flags Solana en OFF
   ```

3. Verificar health: **GET a la raíz del deployment** (`https://<preview-url>/`) debe dar 2xx. **[corregido 2026-07-27]** Antes decía `https://chaski-prod.vercel.app/api/health`: **ese endpoint no existe** en este repo (no hay `app/api/health/`), y ese hostname es inventado. El checkpoint 1 del smoke chequea exactamente la raíz de chaski, `/health` del facilitator y la raíz de remit (`scripts/smoke-solana-e2e.ts:107-121`)

**`wasiai-remittance-agents` (Vercel)**:
1. Preparar envs de Tabla B (para devnet: `TRANSFI_USDC_NETWORK`, `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS`, `PAYOUT_ALLOW_MOCK`. **Sin** `TRANSFI_ADAPTER_READY`)
2. Deploy a Vercel
3. Verificar que la raíz del deployment da 2xx (es lo que chequea el smoke). El agente en sí es `POST /api/agents/remit-cashout-payout/invoke` (existe: `wasiai-remittance-agents/src/app/api/agents/remit-cashout-payout/invoke/route.ts`), pero no responde a un GET suelto

---

### Paso 6: Flip de flags SOLO en el entorno aislado del smoke

**⚠️ CRÍTICO**: estos flags NUNCA se deben encender en un entorno compartido (producción/staging de usuarios reales).

Crear un **entorno de smoke aislado** en Vercel (preview deployment desde una rama `smoke-test` o usar variables de entorno locales):

| Flag | Valor | Entorno |
|------|-------|---------|
| `NEXT_PUBLIC_VM` | `solana` | SOLO smoke |
| `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` | `true` | SOLO smoke |
| `SOLANA_FEE_PAYER_SPONSOR_ENABLED` | `true` | SOLO smoke + facilitator |
| `SOLANA_ESCROW_RELEASE_ENABLED` | `true` | SOLO smoke + facilitator |

**Opción A (recomendada)**: preview deployment desde `smoke-test` branch
```bash
git checkout -b smoke-test
# Editar .env.local o crear preview-env.json con los flags arriba
git push origin smoke-test
# Vercel crea un preview URL automáticamente
```

**Opción B**: Vercel Environment Overrides (panel → Environment → Preview)

⚠️ No mergees `smoke-test` a `main` — úsala SOLO para smoke testing.

---

### Paso 7: Correr `npm run smoke:solana` contra los servicios deployados

> ### 🛑 Los nombres de las `SMOKE_*` de este paso estaban TODOS mal **[corregido 2026-07-27]**
> La versión anterior exportaba `SMOKE_CHASKI_BASE_URL`, `SMOKE_FACILITATOR_BASE_URL`, `SMOKE_REMITTANCE_BASE_URL`, `SMOKE_KYC_PROVIDER_ID` y `SMOKE_TRANSFI_ORDER_ID`: **ninguna de esas 5 existe** en `scripts/smoke-solana-e2e.ts`. De las **11 envs requeridas** solo acertaba 3 (`SMOKE_SENDER_SECRET_KEY`, `SMOKE_SOLANA_USDC_MINT`, `SMOKE_SOLANA_FACILITATOR_PUBKEY`), así que el smoke abortaba fail-loud sin llegar a la primera request. Los ejemplos de valor también eran inventados: el mint de Circle `4zMMC9…` no existe en devnet, y el pubkey `9JxTr1…` no existe como cuenta (los dos chequeados por RPC).
>
> Lista autoritativa: `scripts/smoke-solana-e2e.ts:44-54` (las 11 requeridas) + `SMOKE_ALLOW_REAL` (chequeada aparte, `:37`). Opcionales: `SMOKE_SOLANA_RPC_URL` (default devnet) y `SMOKE_DEADLINE_SECONDS` (default `3600`).

Desde tu máquina local (o CI/CD aislado):

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3

export SMOKE_ALLOW_REAL=true                      # sin esto aborta antes de cualquier request
export SMOKE_CHASKI_URL=<preview url de chaski>
export SMOKE_FACILITATOR_URL=<railway url del facilitator>
export SMOKE_REMIT_URL=<vercel url de remit-agents>
export SMOKE_SENDER_SECRET_KEY=$(cat m5-keys/sender.b58)   # SECRETO, nunca se imprime
export SMOKE_KYC_VERIFICATION_ID=devnet-smoke-kyc          # cualquier string (KYC simulated_dev en preview)
export SMOKE_REMITTANCE_ID=m5-smoke-$(date +%s)            # ⚠️ GUARDALO (ver aviso abajo)
export SMOKE_QUOTE_ID=m5-quote-1
export SMOKE_AMOUNT_USD=10
export SMOKE_SOLANA_USDC_MINT=8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q
export SMOKE_SOLANA_FACILITATOR_PUBKEY=4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH
export SMOKE_SPONSOR_POP_SECRET=...   # el MISMO valor que SOLANA_SPONSOR_POP_SECRET del facilitator
                                      # (está en m5-keys/M5-ENV-CHECKLIST.md, gitignored)

npm run smoke:solana
```

**Output real** (formato `OK [n] …`, no `✓ Checkpoint n:` **[corregido 2026-07-27]**). Los checkpoints son 1-7 y 9: **no existe un checkpoint 8** (el 7 cubre release + TransFi juntos y es best-effort):

```
OK [1] healthcheck chaski/facilitator/remit 2xx
OK [2] KYC verificationId de sandbox presente
OK [3] PoP challenge firmado (ed25519)
OK [3] prepare devolvió shape Solana válido (base58)
OK [4] ix deposit construida + partial-firmada por el sender (escrow escrowIdl)
OK [5] deposit broadcasteado (gasless), signature recibida
>>> M5 — TX del deposit no-custodial (verificable en Solana Explorer):
    https://explorer.solana.com/tx/<signature>?cluster=devnet
OK [6] vault on-chain en status Deposited
OK [7] release/TransFi (pata fiat) disparado        # o WARN [7] … (best-effort, NO invalida M5)
OK [9] M5 completado (deposit on-chain); release/TransFi diferidos (best-effort)
```

> ⚠️ **GUARDÁ el `SMOKE_REMITTANCE_ID`.** Es el argumento que después exigen el release y el refund, y **no se puede recuperar de la cadena** (en la seed de la PDA solo vive `sha256(remittanceId)[:16]`). Si lo perdés, los fondos de ese escrow quedan trabados para siempre. Ya hay un caso real: §6 de `ESCROW-DEVNET-RECIPE.md`.

⚠️ Si algún checkpoint falla:
- **Aborta antes del checkpoint 1**: falta `SMOKE_ALLOW_REAL=true` o falta alguna de las 11 envs requeridas (el script imprime el nombre que falta, nunca el valor)
- **[1]**: alguno de los 3 servicios no está up (chaski y remit se chequean en la RAÍZ, el facilitator en `/health`)
- **[2]**: `SMOKE_KYC_VERIFICATION_ID` vacío
- **[3]**: faltan envs del prepare en chaski (`SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`, `DEPOSIT_ATTESTATION_SECRET`, `PAYOUT_POP_SECRET`) o el payout no está en modo mock
- **[5]**: 404 ⇒ `SOLANA_FEE_PAYER_SPONSOR_ENABLED` OFF (la ruta no se registra). 401 ⇒ `FACILITATOR_API_KEY` mal (¿mandaste `Authorization: Bearer`?). 403 `SPONSOR_POP_INVALID` ⇒ `SOLANA_SPONSOR_POP_SECRET` distinto entre chaski y facilitator. 503 ⇒ fee-payer sin gas o sin `SOLANA_FEE_PAYER_PRIVATE_KEY`
- **[6]**: la tx no confirmó, o la PDA se derivó con otro `remittanceId`/`programId`
- **[7]**: es **best-effort**. Un `WARN [7]` es esperable en devnet sin KYC Didit real ni credenciales TransFi, y NO invalida M5

---

### Paso 8: Capturar el link de Solana Explorer + evidencia de cierre

El checkpoint 9 del smoke imprime:
El link lo imprime el **checkpoint 5** (y lo repite el 9), con esta forma:

```
>>> M5 — TX del deposit no-custodial (verificable en Solana Explorer):
    https://explorer.solana.com/tx/<signature-base58>?cluster=devnet
```

> **[corregido 2026-07-27]** El ejemplo anterior mostraba una signature de fantasía
> (`3hJ8k9Kj7n8S9mV4bX5cD…`) que ni siquiera es base58 válido (tiene `0` y `l`). Un ejemplo REAL, del
> depósito gasless de hoy: `22A61CyncHSGGHHDujNVJUvrgx8wxETSaGzPFdHrE9WMxatsxr4vNTg6JFesBQdBdbycTj6iF3gX2eoRY65JcFnN`.

1. **Copiar el link exacto** (incluyendo `?cluster=devnet`)
2. **Verificar en el explorer**:
   - Abrir el link en navegador
   - Confirmar que la tx está finalized y sin error
   - Verificar que:
     - El **fee payer** de la tx es el fee-payer del facilitator, NO el sender (eso es lo que prueba el gasless)
     - El sender firmó la tx
     - La ix es del programa del escrow `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`
     - El monto es el esperado (USDC SPL, 6 decimales)

3. **Guardar también el estado de la PDA, no solo el link**: el RPC público de devnet **poda historial**
   (el 2026-07-27, `getFirstAvailableBlock` daba `478470331` con slot actual `479366681`, o sea que las tx
   de 5 días antes ya no se podían consultar por signature). Las **cuentas** no se podan, así que anotá:
   `escrowState PDA` + `vault ATA` + `remittanceId`, y verificá con `getAccountInfo` cuando haga falta.

4. **Adjuntar como evidencia de M5**:
   - Crear un documento `M5-CLOSURE-EVIDENCE.md` o similar en `doc/`
   - URL exacta + timestamp + status de la tx (Confirmed/Finalized)
   - `remittanceId`, `escrowState PDA` y `vault ATA` (esto es lo que sobrevive a la poda del RPC)
   - Captura de pantalla (opcional pero recomendado)

5. **Marcar M5 como DONE**:
   - Actualizar el status de M5 en el backlog/roadmap
   - Notificar al equipo que el e2e Solana devnet está verificado

---

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---------|----------------|-----|
| **401 en cualquier endpoint del facilitator** | Mandaste `X-API-Key` (no lo lee nadie) o la `FACILITATOR_API_KEY` es el placeholder | Usar `Authorization: Bearer <key>` (`middleware/auth.ts:102-106`). La key real está en el Vercel de Chaski, entorno **preview** |
| Smoke aborta ANTES de cualquier request | `SMOKE_ALLOW_REAL !== "true"` o falta una de las 12 `SMOKE_*` requeridas | Exportar `SMOKE_ALLOW_REAL=true` + la lista de `scripts/smoke-solana-e2e.ts:43-55` (el script imprime qué env falta) |
| Sponsor falla (404) | `SOLANA_FEE_PAYER_SPONSOR_ENABLED` no es `true`, o la private key no parsea ⇒ la ruta **no se registra** | Setear el flag + `SOLANA_FEE_PAYER_PRIVATE_KEY` como array JSON de 64 números; redeploy (`app.ts:405-407`) |
| Sponsor falla (503) | Fee-payer sin gas, o `SOLANA_FEE_PAYER_PRIVATE_KEY` no seteada | Verificar Railway env + `solana balance <fee-payer> --url devnet`; redeploy si la env se agregó después |
| Sponsor falla (403 `SPONSOR_POP_INVALID`) | `popProof` inválido: `SOLANA_SPONSOR_POP_SECRET` distinto entre quien firma y el facilitator, o sin setear (fail-closed) | Alinear el secreto. Fórmula: `HMAC_SHA256(secret, senderPubkeyBase58)` hex (`methods/solana-sponsor/pop.ts:22-24`, `env.ts:230-231`) |
| Release falla (404) | `SOLANA_ESCROW_RELEASE_ENABLED` no es `true` o la keypair de la authority no parsea ⇒ ruta no registrada | Setear en Railway; redeploy (`app.ts:410-412`) |
| Release falla (400/401 por attestation) | El HMAC se armó con el encoding naive `remittanceId:sender` | El encoding es **inyectivo**: `${remittanceId.length}:${remittanceId}${sender}` (`routes/solana-escrow.ts:86-88`). Ver §4 de `ESCROW-DEVNET-RECIPE.md` |
| Refund revierte | El deadline no venció todavía | El programa tira `DeadlineNotReached` (6003). Es el comportamiento correcto: esperá el deadline |
| Prepare devuelve `prepare_no_deposit_address` | En devnet: falta `TRANSFI_DEVNET_SOLANA_DEPOSIT_ADDRESS` o `PAYOUT_ALLOW_MOCK` | **NO** setear `TRANSFI_ADAPTER_READY=true` para arreglar esto **[corregido 2026-07-27]**: eso habilita el payout REAL (`cashout-payout.ts:66-72`). En devnet va el escape-hatch + mock |
| Explorer link muestra "Transaction not found" | (a) la tx no se broadcasteó o el blockhash expiró, o (b) el RPC público podó el historial | (a) revisar logs del sponsor y `SOLANA_SPONSOR_MAX_REBROADCASTS` (default 3). (b) si la tx es de hace días, es poda: verificá la **cuenta** (PDA) en vez de la signature |

---

## Checklist de verificación pre-smoke

Antes de ejecutar el paso 7, confirmar:

- [x] Paso 1: facilitator mergeado (`main` = `75099ef`). Falta confirmar deploy Railway HEALTHY (`/health` 200)
- [ ] Paso 2: migraciones ejecutadas en ambas DBs (`004_facilitator_solana_release_dedup.sql` + `20260721T000000_add_vm_network_id_to_remittance_settlements.sql`)
- [x] Paso 3: keypairs devnet generadas y fondeadas (balances verificados > 0 el 2026-07-27)
- [ ] Paso 4: **NO aplica al smoke devnet** (solo fase fiat real)
- [ ] Paso 5: chaski (preview) + remit-agents deployados a Vercel, raíz 2xx
- [ ] Paso 6: flags encendidas SOLO en el entorno aislado del smoke (no en main/prod)
- [ ] Paso 7: las 11 `SMOKE_*` requeridas (+ `SMOKE_ALLOW_REAL`) seteadas con los nombres reales de `scripts/smoke-solana-e2e.ts:44-54`
- [ ] `FACILITATOR_API_KEY` a mano y usada como `Authorization: Bearer` (no `X-API-Key`)
- [ ] `remittanceId` persistido ANTES de firmar (si se pierde, los fondos quedan trabados)

---

**Cierre de M5: tx verificable en Solana Explorer + evidencia adjunta = ✓ DONE.**

El circuito completo (deposit gasless, release, refund con las dos mitades del guard del deadline) ya se
ejercitó y verificó on-chain el 2026-07-27: la receta reproducible está en
**`ESCROW-DEVNET-RECIPE.md`**.
