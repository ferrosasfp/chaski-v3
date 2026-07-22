# RUNBOOK-M5 — Cierre real de M5: e2e Solana devnet (8 pasos founder-gated)

> **Documentación ejecutable founder-only.** Ninguno de estos 8 pasos se ejecuta en F3 (desarrollador). Son pasos que SOLO el founder puede ejecutar: deploy a producción, generación/fondeo de keypairs devnet reales, obtención de IDs sandbox TransFi, flip de flags en entorno aislado, ejecución del smoke contra servicios deployados en vivo.
>
> **Cero plata real** — todo devnet. **Flags OFF** salvo en el entorno aislado del smoke. **Secretos** desde el panel de cada plataforma (Railway/Vercel), NUNCA versionados en repo.

---

## Tabla A — Envs de `wasiai-facilitator` (Railway) · Solana

**Fuente**: `wasiai-facilitator/src/infra/env.ts` + routes `solana-*.ts` (verificadas por grep en HU-SOL-13a report).

| Var | Rol | Valor ejemplo (devnet) |
|-----|-----|------------------------|
| `SOLANA_RPC_URL` | RPC devnet (lee vault escrow + broadcast tx) | `https://api.devnet.solana.com` |
| `SOLANA_USDC_MINT` | Mint USDC devnet (pin de referencia del adapter) | `4zMMC9srt5Ri5X14GAgipK2c61N56M5Qo4czJC7pegg7` |
| `SOLANA_TOKEN_PROGRAM_ID` | Program id de SPL Token | `TokenkegQfeZyiNwAJsyFbPVwwQQfHub7s6SVm3x5LevB` |
| `SOLANA_ESCROW_PROGRAM_ID` | Program id del escrow Anchor | Obtenido de `escrowIdl.address` de chaski |
| `SOLANA_FEE_PAYER_PRIVATE_KEY` | Keypair privada del fee-payer (gasless) | Base58 privada (45-chars) |
| `SOLANA_FEE_PAYER_SPONSOR_ENABLED` | Registra `POST /solana/sponsor` | `true` (solo en devnet/test) |
| `SOLANA_SPONSOR_POP_SECRET` | Secreto PoP del sponsor (valida prueba de posesión sender) | Generado en paso 3 |
| `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` | Keypair privada release-authority | Base58 privada (45-chars) |
| `SOLANA_ESCROW_RELEASE_ENABLED` | Registra `POST /solana/escrow/release` | `true` (solo en devnet/test) |
| `SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET` | Secreto atestación (KYC+TransFi autoriza release) | Mismo que chaski `DEPOSIT_ATTESTATION_SECRET` |
| `SOLANA_SPONSOR_MAX_COMPUTE_UNITS` | Tope compute units tx sponsoreada | `200000` (típico) |
| `SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS` | Tope priority fee | `1000` (típico devnet) |
| `SOLANA_SPONSOR_MAX_FEE_LAMPORTS` | Tope fee total por tx | `5000000` (típico) |
| `SOLANA_SPONSOR_RATE_LIMIT_MAX` | Máx sponsors por ventana | `100` (devnet) |
| `SOLANA_SPONSOR_RATE_LIMIT_WINDOW_SEC` | Ventana rate-limit | `60` (segundos) |

---

## Tabla B — Envs de `wasiai-remittance-agents` (Vercel) · Solana

**Fuente**: grep `wasiai-remittance-agents/src/` (verificadas por HU-SOL-13a report).

| Var | Rol | Valor ejemplo |
|-----|-----|---------------|
| `TRANSFI_USDC_NETWORK` | Red para corredor Solana | `solana` |
| `TRANSFI_ADAPTER_READY` | `true` ⇒ agente devuelve `depositAddress` real; sin él, mock ⇒ prepare fail-closed | `true` |
| `TRANSFI_DEFAULT_NETWORK` | Red default de la orden | `solana` |
| `TRANSFI_USDC_CURRENCY` | Símbolo USDC | `USDC` |
| `TRANSFI_API_KEY` | API key sandbox TransFi | Provisto por TransFi |
| `TRANSFI_BASE_URL` | Base URL de la API | `https://sandbox-api.transfi.com` |
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

**Orden de branches**: `026 → 027 → feat/029bc-hu-sol-13bc-escrow-facilitator` (status hoy: HELD)

1. En el repo `wasiai-facilitator`, hacer merge de las 3 branches en orden (coordinación con git para evitar conflictos)
2. Verificar que no quedan flags Solana en ON en el entorno compartido (prod) — deben estar OFF por defecto
3. Deploy a Railway usando el CLI o el panel de Railway:
   ```bash
   railway up
   # o via panel: conectar branch `main` al deployment de producción
   ```
4. Verificar que el deployment está HEALTHY (200 en `/health`, logs sin errores de inicio)

**⚠️ BLOQUEADOR**: si Railway falla o las migraciones del paso 2 no se ejecutan, el smoke fallará en los checkpoints de sponsor/release (pasos 7).

---

### Paso 2: Aplicar migraciones en bases de datos

**Facilitator** (Supabase de `wasiai-facilitator`):
- Migración `004`: escrow release dedup (cita: HU-SOL-13a report)
- Verificar estado: `supabase migration list` (si está en CD/pipeline) o aplicar manualmente en Supabase console

**Chaski** (Supabase de `chaski-v3`):
- Migración `20260721` (nombre confirmado en momento de deploy; referencia: HU-SOL-13a SDD §Tabla de migraciones)
- Aplicar via `supabase migration up` o console

⚠️ Si una migración falla o no se ejecuta, la persistencia/recuperación de datos fallará después.

---

### Paso 3: Generar + fondear keypairs devnet

**Fee-payer** (facilitator):
```bash
# Generar nueva keypair para fee-payer
solana-keygen new -o /tmp/fee-payer.json --no-bip39-passphrase

# Obtener el pubkey (copiá exacto)
solana address -k /tmp/fee-payer.json
# Ejemplo output: 9JxTr1cxYuVS3hmqvnqBCJZWqL9yXvLGKNF6X9T4yM4K

# Fondear desde el devnet faucet (10 SOL por request, ~500M lamports)
solana airdrop 10 9JxTr1cxYuVS3hmqvnqBCJZWqL9yXvLGKNF6X9T4yM4K --url devnet
# Repetir 2-3 veces para acumular ~30 SOL (cubre gas de múltiples txs)

# Guardar la privada base58
cat /tmp/fee-payer.json | jq -r '.[] | @base64d' | tail -c 32 | base64 -w 0
# Copiar output → `SOLANA_FEE_PAYER_PRIVATE_KEY` en Railway/facilitator
```

**Release-authority** (facilitator):
```bash
# Generar release-authority keypair
solana-keygen new -o /tmp/release-authority.json --no-bip39-passphrase

# Obtener pubkey
solana address -k /tmp/release-authority.json
# Ejemplo output: 7kVJ9z8HhPZnL4q1v8S9mJ8kKw3xV5tY2bX1cD6eF9g

# Fondear (~2-5 SOL para sign+broadcast del release)
solana airdrop 5 7kVJ9z8HhPZnL4q1v8S9mJ8kKw3xV5tY2bX1cD6eF9g --url devnet

# Guardar privada
cat /tmp/release-authority.json | jq -r '.[] | @base64d' | tail -c 32 | base64 -w 0
# Copiar output → `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` en Railway/facilitator
```

**Copiar pubkeys a Chaski**:
```bash
# El pubkey de fee-payer → `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY` en Vercel/chaski
# El pubkey de release-authority → `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` en Vercel/chaski (server-only, no NEXT_PUBLIC_)
```

⚠️ Verificar que los balance `solana balance <pubkey> --url devnet` confirman fondeo antes de continuar.

---

### Paso 4: Obtener IDs sandbox TransFi Solana

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

**`chaski-v3` (Vercel)**:
1. Preparar las envs que falta en el panel de Vercel:
   - De Tabla A del facilitator: `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` (el pubkey público, paso 3)
   - `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY` (el pubkey público fee-payer, paso 3)
   - `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED=false` (OFF por defecto; se enciende en paso 6 solo en el entorno del smoke)
   - `DEPOSIT_ATTESTATION_SECRET` (mismo que facilitator, compartido)
   - Cualquier otra env faltante de `.env.example` relativa a Solana

2. Deploy:
   ```bash
   vercel deploy --prod
   # o via git: merge a main, Vercel se desplega automáticamente
   ```

3. Verificar health: `https://chaski-prod.vercel.app/api/health` → 200

**`wasiai-remittance-agents` (Vercel)**:
1. Preparar envs de Tabla B (TransFi sandbox IDs, paso 4)
2. Deploy a Vercel
3. Verificar que `/api/agents/remit-cashout-payout/invoke` responde

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

Desde tu máquina local (o CI/CD aislado):

```bash
# Entrar al repo chaski-v3
cd /ruta/a/chaski-v3

# Setear las envs de smoke (tabla de abajo)
export SMOKE_ALLOW_REAL="true"
export SMOKE_CHASKI_BASE_URL="https://chaski-smoke-preview.vercel.app"  # preview deployment
export SMOKE_FACILITATOR_BASE_URL="https://facilitator-prod.railway.app"  # prod (flags ON localmente)
export SMOKE_REMITTANCE_BASE_URL="https://remit-agents-prod.vercel.app"
export SMOKE_SOLANA_USDC_MINT="4zMMC9srt5Ri5X14GAgipK2c61N56M5Qo4czJC7pegg7"
export SMOKE_SOLANA_FACILITATOR_PUBKEY="9JxTr1cxYuVS3hmqvnqBCJZWqL9yXvLGKNF6X9T4yM4K"  # step 3
export SMOKE_SENDER_SECRET_KEY="base58_privkey_de_una_wallet_devnet"  # generada ad-hoc para test
export SMOKE_KYC_PROVIDER_ID="didit"  # o mock, según config del agente
export SMOKE_TRANSFI_ORDER_ID="sandbox_order_id"  # de TransFi (step 4)

# Correr el smoke
npm run smoke:solana

# Output esperado:
# ✓ Checkpoint 1: Healthcheck
# ✓ Checkpoint 2: KYC
# ✓ Checkpoint 3: Prepare
# ✓ Checkpoint 4: Deposit instruction
# ✓ Checkpoint 5: Sponsor
# ✓ Checkpoint 6: Verify vault
# ✓ Checkpoint 7: Release
# ✓ Checkpoint 8: TransFi order
# ✓ Checkpoint 9: Explorer link
# Link: https://explorer.solana.com/tx/...?cluster=devnet
```

⚠️ Si algún checkpoint falla:
- **Checkpoint 1/2**: servicios no están up o flags OFF
- **Checkpoint 3**: envs de prepare faltante (authority pubkey, attestation secret)
- **Checkpoint 5/7**: facilitator no tiene gas (fee-payer) o flags OFF en facilitator
- **Checkpoint 8**: TransFi IDs incorrectos o adapter no ready
- **Checkpoint 9**: tx no se broadcasteó (verifica blockchain)

---

### Paso 8: Capturar el link de Solana Explorer + evidencia de cierre

El checkpoint 9 del smoke imprime:
```
✓ Checkpoint 9: Explorer link
Link: https://explorer.solana.com/tx/3hJ8k9Kj7n8S9mV4bX5cD6eF7gH8iJ9kL0mN1oP2qR3sTuVwXyZ4aB5cDeFgHiJkL?cluster=devnet
```

1. **Copiar el link exacto** (incluyendo `?cluster=devnet`)
2. **Verificar en el explorer**:
   - Abrir el link en navegador
   - Confirmar que la tx está finalized
   - Verificar que:
     - El sender es el pubkey usado en el smoke
     - El receptor (`deposit instruction`) es el escrow
     - Monto es correcto (USDC SPL token)
     - Timestamp es reciente

3. **Adjuntar como evidencia de M5**:
   - Crear un documento `M5-CLOSURE-EVIDENCE.md` o similar en `doc/`
   - Copiar URL exacta
   - Timestamp del explorer
   - Capture de pantalla (opcional pero recomendado)
   - Status de la tx (Confirmed/Finalized)

4. **Marcar M5 como DONE**:
   - Actualizar el status de M5 en el backlog/roadmap
   - Notificar al equipo que el e2e Solana devnet está verificado

---

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---------|----------------|-----|
| Smoke aborta ANTES de cualquier request | `SMOKE_ALLOW_REAL !== "true"` | Exportar env correctamente: `export SMOKE_ALLOW_REAL="true"` |
| Sponsor falla (503) | `SOLANA_FEE_PAYER_PRIVATE_KEY` no seteada en facilitator | Verificar Railway env; redeploy si fue agregada después del deploy inicial |
| Release falla (404) | `SOLANA_ESCROW_RELEASE_ENABLED=false` en facilitator | Setear en Railway; redeploy |
| Prepare devuelve `prepare_no_deposit_address` | `TRANSFI_ADAPTER_READY` no está `true` o agente devuelve null | Confirmar TransFi sandbox está ready; probar agente manualmente |
| Explorer link muestra "Transaction not found" | Tx no se broadcasteó o blockhash expiró | Verificar que el sponsor en facilitator está cacheando correctamente; aumentar `SOLANA_SPONSOR_MAX_REBROADCASTS` |

---

## Checklist de verificación pre-smoke

Antes de ejecutar el paso 7, confirmar:

- [ ] Paso 1: facilitator mergeado y deployado a Railway (HEALTHY)
- [ ] Paso 2: migraciones ejecutadas en ambas DBs
- [ ] Paso 3: keypairs devnet generados y fondeadas; balances > 0
- [ ] Paso 4: IDs TransFi sandbox confirmados y guardados
- [ ] Paso 5: chaski + remit-agents deployados a Vercel (HEALTHY)
- [ ] Paso 6: flags encendidas SOLO en el entorno aislado del smoke (no en main/prod)
- [ ] Paso 7: envs de smoke seteadas correctamente (SMOKE_ALLOW_REAL, URLs, pubkeys, secretos)

---

**Cierre de M5: tx verificable en Solana Explorer + evidencia adjunta = ✓ DONE.**
