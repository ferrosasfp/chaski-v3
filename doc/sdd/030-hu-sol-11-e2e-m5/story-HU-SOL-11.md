# Story File — HU-SOL-11 (WKH-214) · e2e Solana devnet + smoke + envs (entrega de código de M5)

> Contrato autocontenido para el Dev (F3). Derivado de `sdd.md` (SPEC_APPROVED).
> **El Dev SOLO lee este archivo.** Si algo no está acá, no se hace.
> Branch: `feat/030-hu-sol-11-e2e-m5`.

---

## 0. Contexto compacto (qué se construye y por qué)

`app/api/payout/prepare/route.ts` es hoy **EVM-only en su respuesta 200**: siempre arma
`{depositAddress, attestation, payoutId, provenance}` y valida el `depositAddress` con `isAddress`
(viem, L252), que **siempre rechaza un pubkey base58 de Solana**. Con `NEXT_PUBLIC_VM=solana` el
money-path no-custodial muere en `502 prepare_no_deposit_address`. El cliente ya está listo:
`HttpSolanaPayoutPrepareGateway` consume `{beneficiary, authority, attestation, payoutId, provenance}`
base58 (`isValidSolanaPrepareShape`), pero el server nunca produce ese shape.

Esta HU entrega **solo la porción de código/artefactos** testeable con mocks/CI:
1. **W0** — la rama Solana faltante en el bloque de respuesta de `prepare/route.ts` + tests.
2. **W1** — `scripts/smoke-solana-e2e.ts` (env-driven, opt-in, fail-loud) + `tsconfig.scripts.json` + `package.json`.
3. **W2** — `.env.example` (3 vars Solana faltantes) + `runbook-skeleton.md` founder-gated.

El cierre real de M5 (deploy, keypairs devnet, IDs TransFi, flip de flags, tx en explorer) es
**founder-gated**, documentado en el runbook. **NO es entregable de F3.**

---

## 1. Scope IN (lista exhaustiva de archivos a tocar)

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `app/api/payout/prepare/route.ts` | Modificar (rama Solana en el bloque de respuesta) | W0 |
| 2 | `app/api/payout/prepare/route.test.ts` | Modificar (+tests AC-1/AC-2/AC-3; 0 cambio EVM) | W0 |
| 3 | `scripts/smoke-solana-e2e.ts` | Crear | W1 |
| 4 | `tsconfig.scripts.json` | Crear | W1 |
| 5 | `package.json` | Modificar (devDep `tsx` + scripts) | W1 |
| 6 | `.env.example` | Modificar (bloque Solana escrow/facilitator) | W2 |
| 7 | `doc/sdd/030-hu-sol-11-e2e-m5/runbook-skeleton.md` | Crear | W2 |

**NADA fuera de esta lista.** Cualquier otro archivo = STOP.

---

## 2. Anti-Hallucination Checklist (específico de esta HU)

Antes de escribir código, confirmá contra el código real (todos verificados por el Architect):

- [ ] `resolveActiveVm(): "evm" | "solana"` existe en `src/infrastructure/chain.ts:121`. Ya está **importado** en `route.ts:25`.
- [ ] `resolveSolanaReleaseAuthorityPubkey(): string` existe en `chain.ts:178` — **fail-loud** (`throw new Error("solana_release_authority_not_configured")`) si `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` falta o no es base58. **NO está importado aún** en `route.ts`.
- [ ] `resolveSolanaNetworkConfig(): SolanaNetworkConfig` existe en `chain.ts:129`; `.cluster === "devnet"` (literal, `chain.ts:101/113`). **NO está importado aún** en `route.ts`.
- [ ] `issueSolanaDepositAttestation(p: SolanaDepositAttestation): string` existe en `deposit-attestation.ts:117`. Firma del payload: `{remittanceId, quoteId, beneficiary, authority, cluster: "devnet", exp}` (`deposit-attestation.ts:33-40`). **NO está importado aún** en `route.ts` (sí lo está el EVM `issueDepositAttestation`, L33).
- [ ] `verifySolanaDepositAttestation(token, nowMs): SolanaDepositAttestation | null` existe en `deposit-attestation.ts:129` — para el test AC-1.
- [ ] `canonicalizeAddress(address, "solana")` existe en `src/infrastructure/address.ts:13`; **throwea** con base58 deforme. Ya está **importado** en `route.ts:28`.
- [ ] `DEPOSIT_ATTESTATION_TTL_SECONDS = 10*60` en `deposit-attestation.ts:44`. Ya **importado** en `route.ts:32`.
- [ ] `isValidSolanaPrepareShape` (`http-solana-prepare-gateway.ts:48`) exige: `beneficiary`, `authority`, `attestation`, `payoutId` = string **no-vacío**; `provenance` = string (`""` permitido). **El shape 200 de la rama Solana DEBE matchear esto exacto.**
- [ ] `mapErrorReason` (`http-solana-prepare-gateway.ts:23`) NO conoce `prepare_solana_authority_unavailable` → un 503 con ese enum lo colapsa a `prepare_unavailable` (fail-closed, esperado — **NO tocar el gateway**, CD-7).
- [ ] Enum del 503 authority: **`prepare_solana_authority_unavailable`** (nombre nuevo, fijado en SDD §10). **PROHIBIDO** reusar `payout_authority_unavailable` (significa "Didit no disponible", DT-3/CD).
- [ ] Exemplar de PoP Solana firmado real (para AC-1): `app/api/a2a/payout/submit/route.test.ts:983-1000` (`signedSolanaPop`). Usa `nacl.sign.keyPair()` + `issueSolanaPopChallenge` + `buildSolanaPopMessage` + `bs58.encode`.
- [ ] `bs58` (`6.0.0`) y `tweetnacl` (`1.0.3`) YA son deps de `package.json` (L30/L38) — usables en tests sin agregar nada.
- [ ] `tsconfig.json` `include` NO incluye `scripts/` (L34-42) → por eso hace falta `tsconfig.scripts.json`.
- [ ] Vars Solana ya consumidas por código (grep `process.env`): `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`, `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY`, `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` **NO están en `.env.example`** (confirmado). Las otras 3 (`NEXT_PUBLIC_VM`, `NEXT_PUBLIC_SOLANA_USDC_MINT`, `SOLANA_DEVNET_RPC_URL`, `NEXT_PUBLIC_SOLANA_RPC_URL`) SÍ están (`.env.example:63/67/70/75`) — **no tocar**.
- [ ] `escrowIdl` se exporta de `src/infrastructure/solana/escrow-idl.ts:8`; `SolanaWalletAdapter` de `src/infrastructure/solana-wallet.ts:31` — building-blocks a REUSAR en el smoke, **no reimplementar** la ix `deposit`.

---

## 3. Constraint Directives (heredados del SDD — INVIOLABLES)

| CD | Regla |
|----|-------|
| **CD-1** | Guard-order PR1-PR7 de `prepare/route.ts` **INTACTO**. Único cambio = bloque de respuesta (PR8-PR11), ramificado por `resolveActiveVm()`. |
| **CD-2** | **EVM BYTE-IDÉNTICO**: rama `vm==="evm"` = mismo shape 200, mismos enums de error, **0 assertion EVM cambiada** en `route.test.ts`. |
| **CD-3** | Fail-loud/fail-closed: toda env Solana ausente/malformada ⇒ error opaco/abort. NUNCA 200 parcial ni fallback silencioso. |
| **CD-4** | PROHIBIDO hardcodear secretos (authority, fee-payer, attestation secret, tokens, keypair del sender). Todo desde env. NUNCA impreso en stdout/logs. `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` es SERVER-ONLY (sin `NEXT_PUBLIC_`). |
| **CD-5** | Flags OFF por default en ambiente compartido. Esta HU **CONSTRUYE, NO ENCIENDE**. |
| **CD-6** | Cero plata real. Smoke SOLO devnet. PROHIBIDO cualquier default/fallback a mainnet-beta. |
| **CD-7** | PROHIBIDO tocar archivos cerrados en HU-SOL-13a: `http-solana-prepare-gateway.ts`, `deposit-attestation.ts`, `submit/route.ts`, `settle/principal/route.ts`, `confirm-and-send.ts`, `solana-wallet.ts`, `chain.ts`, `container.ts`. Se **INVOCAN/importan**, no se modifican. |
| **CD-8** | PROHIBIDO escribir/modificar `wasiai-facilitator`/`wasiai-remittance-agents`. Solo se LEEN para documentar sus envs. |
| **CD-9** | **PROHIBIDO exportar helpers nuevos desde `route.ts`** (Next valida los exports de `route.ts` contra el set de handlers HTTP; `tsc --noEmit` con `.next/types` rompe). Lógica nueva **inline** o vía funciones ya importadas. |
| **CD-10** | En tests/smoke, generar literales base58 con `bs58.encode`/`Keypair`/`nacl` (NUNCA a mano; el alfabeto base58 excluye `0 O I l`). |
| **CD-11** | Default-param footgun: pasar `undefined` USA el default; usar `null` sentinel para "ausente" en fakes. |

---

## 4. Waves

### Wave 0 (Serial Gate) — rama Solana de `prepare` + tests

**Objetivo**: el bloque de respuesta ramifica por VM; EVM byte-idéntico; Solana produce el shape del gateway.

#### W0.1 — `app/api/payout/prepare/route.ts`

**Imports a agregar** (bloque `chain` L23-27 y `deposit-attestation` L31-34):
- de `../../../../src/infrastructure/chain`: `resolveSolanaReleaseAuthorityPubkey`, `resolveSolanaNetworkConfig`.
- de `../../../../src/infrastructure/settlement/deposit-attestation`: `issueSolanaDepositAttestation`.

**Punto de branch**: en `route.ts` el `depositAddress` compartido se calcula en **L251**
(`const depositAddress = typeof okResult.depositAddress === "string" ? okResult.depositAddress : "";`).
Ramificar **inmediatamente después de L251** (antes del check EVM `isAddress` de L252):

```
const vmOut = resolveActiveVm();
if (vmOut === "solana") {
  // ── RAMA SOLANA (nueva) ──
  // 1. beneficiary = MISMO depositAddress del agente (DT-1). Vacío → mismo enum opaco que EVM.
  if (!depositAddress.trim()) {
    return NextResponse.json({ error: "prepare_no_deposit_address" }, { status: 502 });
  }
  // base58 válido (AC-3, no-oráculo: MISMO enum que EVM, no distinguir motivo).
  try {
    canonicalizeAddress(depositAddress, "solana");
  } catch {
    return NextResponse.json({ error: "prepare_no_deposit_address" }, { status: 502 });
  }
  // 2. payoutId presente (fail-closed: no atestar una orden sin id trackeable).
  const payoutIdSol = typeof okResult.payoutId === "string" ? okResult.payoutId : "";
  if (!payoutIdSol.trim()) {
    return NextResponse.json({ error: "prepare_no_deposit_address" }, { status: 502 });
  }
  const provenanceSol = typeof okResult.provenance === "string" ? okResult.provenance : "";
  // 3. authority (DESPUÉS de validar beneficiary, DT-2). Ausente/malformada → 503 enum NUEVO opaco.
  let authoritySol: string;
  try {
    authoritySol = resolveSolanaReleaseAuthorityPubkey();
  } catch {
    return NextResponse.json({ error: "prepare_solana_authority_unavailable" }, { status: 503 });
  }
  // 4. cluster ("devnet").
  const clusterSol = resolveSolanaNetworkConfig().cluster;
  // 5. atestación Solana (beneficiary/authority/cluster; mismo TTL/secret).
  const attestationSol = issueSolanaDepositAttestation({
    remittanceId,
    quoteId,
    beneficiary: depositAddress,
    authority: authoritySol,
    cluster: clusterSol,
    exp: Math.floor(Date.now() / 1000) + DEPOSIT_ATTESTATION_TTL_SECONDS,
  });
  // 6. ledger best-effort (vm:"solana" es el discriminante; chainId es telemetría). NUNCA rompe (CD-17).
  const ledgerSol = getSettlementLedger();
  if (ledgerSol) {
    try {
      await ledgerSol.recordOrderPrepared({
        remittanceId,
        quoteId,
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : `${remittanceId}:${quoteId}`,
        depositAddress,
        chainId: resolveChainId(),
        senderAddress: address,
        payoutId: payoutIdSol,
        vm: "solana",
      });
    } catch (e) {
      console.error("[ledger] recordOrderPrepared_failed", e);
    }
  }
  // 7. 200 — matchea EXACTO isValidSolanaPrepareShape del gateway.
  return NextResponse.json(
    { beneficiary: depositAddress, authority: authoritySol, attestation: attestationSol, payoutId: payoutIdSol, provenance: provenanceSol },
    { status: 200 },
  );
}
// ── RAMA EVM (default) — TODO L252-294 SIN CAMBIOS (byte-idéntico, CD-2) ──
```

**Reglas de la implementación**:
- El bloque EVM existente (L252-294) queda **exactamente como está**. La rama Solana `return`ea antes de llegar a L252, así que el EVM nunca corre `isAddress` sobre base58.
- NO exportar nada nuevo del `route.ts` (CD-9): todo inline.
- NO renombrar variables EVM existentes (`depositAddress`, `payoutId`, `provenance`, `chainId`, `attestation`, `ledger`) — para evitar diffs innecesarios en la rama EVM, usá nombres nuevos (`payoutIdSol`, etc.) en la rama Solana.
- El `attestation` Solana usa `beneficiary: depositAddress` (mismo campo upstream, DT-1). `cluster` viene del resolver, NUNCA hardcodeado.

#### W0.2 — `app/api/payout/prepare/route.test.ts`

**Imports a agregar** (junto a L29):
- `import bs58 from "bs58";`
- `import nacl from "tweetnacl";`
- `import { issueSolanaPopChallenge, buildSolanaPopMessage } from "../../../../src/infrastructure/auth/pop-challenge";`
- `import { verifySolanaDepositAttestation } from "../../../../src/infrastructure/settlement/deposit-attestation";`

**Helper de PoP Solana firmado** (portar el patrón de `submit/route.test.ts:983-1000`):

```
function signedSolanaPop(keypair: nacl.SignKeyPair, addr: string) {
  const ch = { address: addr, networkId: "solana:devnet", nonce: "abcdef0123456789abcdef0123456789", exp: Math.floor(Date.now() / 1000) + 300 };
  const popChallenge = issueSolanaPopChallenge(ch);
  const popSignature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(buildSolanaPopMessage(ch)), keypair.secretKey));
  return { popChallenge, popSignature };
}
```

**Nuevo `describe("rama Solana de respuesta (HU-SOL-11)")`** con `beforeEach` que setea:
`vi.stubEnv("NEXT_PUBLIC_VM", "solana")` + `vi.stubEnv("PAYOUT_POP_SECRET", "pop-secret")`
(OBLIGATORIO en Solana para pasar PR6) + `vi.stubEnv("SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY", <base58>)`.
Generar keypair y address del caller con `nacl.sign.keyPair()` + `bs58.encode(kp.publicKey)`.
El `depositAddress` del agente (beneficiary) = un base58 válido (p.ej. `SOL_ADDR` = `"So11111111111111111111111111111111111111112"`, ya usado en L279).
La authority env = `bs58.encode(nacl.sign.keyPair().publicKey)` (CD-10, NUNCA a mano).
El body del request incluye `address: <caller base58>` + `...signedSolanaPop(kp, callerAddr)`.

> Nota: para pasar PR6 Solana el `address` del caller debe ser el pubkey del keypair que firma el PoP.
> El `depositAddress`/beneficiary es del agente (mockeado con `agentResponds`/`agentResult`).

Ver **§5 Test Expectations** para las 4 aserciones exactas por AC.

**Verificación W0**: `npm run qa` (typecheck + test) verde. Los tests EVM existentes (L112-274) y el
`describe("PR6 rama Solana")` (L280-300) corren **sin cambio de assertion** (AC-4).

---

### Wave 1 (depende de W0) — smoke script + config

#### W1.1 — `tsconfig.scripts.json` (crear)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["scripts/**/*.ts"]
}
```
- **NO** incluir `.next/types/**` (CD-9: evita la validación de exports de routes; el smoke no toca routes).
- `include` propio (en TS `extends` NO hereda `include`). Hereda `compilerOptions`/`paths` del base.

#### W1.2 — `package.json` (modificar)

- `devDependencies`: agregar `"tsx": "^4.19.0"` (única dep nueva permitida, SDD §5).
- `scripts`: agregar
  - `"typecheck:scripts": "tsc -p tsconfig.scripts.json --noEmit"`
  - `"smoke:solana": "tsx scripts/smoke-solana-e2e.ts"`
  - `"qa": "npm run typecheck && npm run typecheck:scripts && npm run test"` (incluir `typecheck:scripts`).
- NO tocar ninguna dep existente ni otros scripts.

#### W1.3 — `scripts/smoke-solana-e2e.ts` (crear)

Orquestador **env-driven 100%**, **fail-loud**, **opt-in**. Estructura (SDD §4.6):

- **Gate opt-in PRIMERO** (AC-6): `if (process.env.SMOKE_ALLOW_REAL !== "true") { console.error("SMOKE aborted: SMOKE_ALLOW_REAL !== 'true'"); process.exit(1); }` **ANTES de cualquier fetch de dinero**.
- **Validación de envs requeridas** (fail-loud, exit≠0): `SMOKE_CHASKI_URL`, `SMOKE_FACILITATOR_URL`, `SMOKE_REMIT_URL`, `SMOKE_SENDER_SECRET_KEY`, `SMOKE_KYC_VERIFICATION_ID`, `SMOKE_REMITTANCE_ID`, `SMOKE_QUOTE_ID`, `SMOKE_AMOUNT_USD`. Cualquiera ausente → abort con mensaje explícito del nombre (NUNCA imprimir el valor).
- **9 checkpoints** (cada uno `console.log("OK [N] <paso>")` o `console.error("FAIL [N] <motivo>"); process.exit(1)`):
  1. Healthcheck GET de chaski/facilitator/remit (no-2xx ⇒ abort).
  2. KYC: valida `SMOKE_KYC_VERIFICATION_ID` presente (sandbox pre-obtenido).
  3. `POST {chaski}/api/payout/prepare` → **shape-check INLINE** (NO importar del gateway, CD-7): assert `beneficiary`/`authority`/`attestation`/`payoutId` string no-vacío + `provenance` string.
  4. Construir + partial-firmar la ix `deposit` reusando `escrowIdl` (`src/infrastructure/solana/escrow-idl.ts`) y los building-blocks de `solana-wallet.ts`, con `Keypair.fromSecretKey(bs58.decode(SMOKE_SENDER_SECRET_KEY))`.
  5. `POST {chaski}/api/settle/solana-sponsor` (broadcast gasless) → assert `signature` base58.
  6. Verify vault: leer estado del escrow on-chain (RPC devnet) hasta `Deposited`.
  7. Release (submit) → assert tx de release.
  8. Orden TransFi sandbox → assert `payoutId`/estado.
  9. `console.log("https://explorer.solana.com/tx/" + sig + "?cluster=devnet")`.
- **Cero plata real** (CD-6): SOLO devnet; PROHIBIDO default/fallback a mainnet-beta. NUNCA imprime secretos (CD-4).
- Runtime `tsx`. Debe pasar `npm run typecheck:scripts` y `next lint`. **NO se ejecuta en F3.**

**Verificación W1**: `npm run typecheck:scripts` verde + `npm run lint` sin errores sobre el smoke.

---

### Wave 2 (paralelizable con W1) — envs + runbook

#### W2.1 — `.env.example` (modificar)

Agregar, en el bloque Solana (después de `NEXT_PUBLIC_SOLANA_RPC_URL`, L75), con el **mismo formato**
de comentario del archivo ("qué hace / quién la lee / qué pasa si falta"), las **3 vars faltantes**
(confirmadas por grep de `process.env`):

| Var | Formato del comentario |
|-----|------------------------|
| `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` | Pubkey base58 de la release-authority del escrow (server-only, SIN `NEXT_PUBLIC_`). La keypair PRIVADA vive SOLO en el facilitator, nunca en chaski. La lee `chain.ts:179`; `prepare` Solana la exige → ausente/malformada ⇒ `503 prepare_solana_authority_unavailable` (fail-loud). |
| `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY` | Pubkey base58 del fee-payer del facilitator (gasless). Client-safe (`NEXT_PUBLIC_`). La lee `chain.ts:162`; con `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED=true` el guard del container la exige fail-loud. |
| `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` | `"true"` enciende el path Solana settle (deposit+sponsor). La leen `container.ts:102` / `solana-sponsor/route.ts:22`. Default OFF ⇒ byte-idéntico. **NO encender en entorno compartido** (CD-5). |

- **NO tocar** las vars Solana ya documentadas (L63/67/70/75). NO agregar valores (mantener `VAR=` vacío como el resto).

#### W2.2 — `doc/sdd/030-hu-sol-11-e2e-m5/runbook-skeleton.md` (crear)

Esqueleto founder-gated con los **8 pasos** (SDD §7.3) + las **2 tablas de envs cross-repo verificadas
contra código real** (repos montados en `/home/ferdev/.openclaw/workspace/`):

**Facilitator (`wasiai-facilitator`, Railway) — fuente `src/infra/env.ts` + `routes/solana-*.ts`**:
`SOLANA_RPC_URL`, `SOLANA_USDC_MINT`, `SOLANA_TOKEN_PROGRAM_ID`, `SOLANA_ESCROW_PROGRAM_ID`,
`SOLANA_FEE_PAYER_PRIVATE_KEY` (su pubkey = `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY` de chaski),
`SOLANA_FEE_PAYER_SPONSOR_ENABLED` (default OFF ⇒ `/solana/sponsor` 404),
`SOLANA_SPONSOR_POP_SECRET`, `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` (su pubkey =
`SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` de chaski), `SOLANA_ESCROW_RELEASE_ENABLED`
(default OFF ⇒ `/solana/escrow/release` 404), `SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET`,
`SOLANA_SPONSOR_MAX_COMPUTE_UNITS`, `SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS`,
`SOLANA_SPONSOR_MAX_FEE_LAMPORTS`, `SOLANA_SPONSOR_RATE_LIMIT_MAX`,
`SOLANA_SPONSOR_RATE_LIMIT_WINDOW_SEC`, `SOLANA_SPONSOR_DAILY_MAX_LAMPORTS`,
`SOLANA_SPONSOR_MAX_REBROADCASTS`.

**Remit-agents (`wasiai-remittance-agents`, Vercel) — fuente grep `src/`**:
`TRANSFI_USDC_NETWORK` (=`solana`), `TRANSFI_ADAPTER_READY` (=`true` ⇒ agente expone `depositAddress`
real; sin él ⇒ mock ⇒ `prepare` fail-closed), `TRANSFI_DEFAULT_NETWORK`, `TRANSFI_USDC_CURRENCY`,
`TRANSFI_API_KEY`, `TRANSFI_BASE`, `TRANSFI_BASE_URL`, `TRANSFI_MID`, `TRANSFI_USERNAME`,
`TRANSFI_PASSWORD`, `TRANSFI_USER_ID`, `TRANSFI_PAYMENT_CODE`, `TRANSFI_PURPOSE_CODE`,
`TRANSFI_SOURCE_URL`, `TRANSFI_SOURCE_WALLET_ADDRESS`.

Los 8 pasos: (1) merge+deploy facilitator (orden `026→027→13bc`, HELD); (2) migraciones `004`
(facilitator) + la de chaski (nombre exacto a verificar en `supabase/` en el deploy — no bloquea F3);
(3) generar+fondear keypairs devnet (fee-payer + release-authority); (4) IDs sandbox TransFi Solana;
(5) deploy Vercel chaski + remit-agents con envs seteadas; (6) flip de flags SOLO en el entorno del
smoke; (7) correr `npm run smoke:solana`; (8) capturar link de Solana Explorer como evidencia de M5.

> El runbook es **documentación**, NO código, NO parte de los Quality Gates de F3/AR/CR.

**Verificación W2**: `.env.example` lista las 3 vars con formato del archivo; runbook completo con las 2 tablas.

---

## 5. Test Expectations (≥1 por AC de código)

| AC | Test | Setup | Assertion |
|----|------|-------|-----------|
| **AC-1** | `rama Solana: vm=solana + PoP válido + depositAddress base58 → 200 shape Solana` | `NEXT_PUBLIC_VM=solana`, `PAYOUT_POP_SECRET=pop-secret`, `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY=<base58 de nacl>`; caller `address=bs58(kp.publicKey)`; body con `...signedSolanaPop(kp, addr)`; `agentResponds(200, agentResult({ depositAddress: SOL_ADDR }))` | `res.status === 200`; `json.beneficiary === SOL_ADDR`; `json.authority === <authorityPubkey>`; `json.payoutId === "transfi-po-1"`; `typeof json.provenance === "string"`; `verifySolanaDepositAttestation(json.attestation, Date.now())` ≠ null con `.beneficiary===SOL_ADDR`, `.authority===<authorityPubkey>`, `.cluster==="devnet"`; el body NO contiene `"Mamá"`/`"999888777"`/`"agents.test"` (CD-5) |
| **AC-2** | `vm=solana + authority env ausente → 503 prepare_solana_authority_unavailable` | igual a AC-1 pero `vi.stubEnv("SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY", "")` (y variante malformada `"0xNOT"`) | `res.status === 503`; `await res.json()` = `{ error: "prepare_solana_authority_unavailable" }` (NUNCA `payout_authority_unavailable`, NUNCA 200 parcial, NO ecoa el env) |
| **AC-3** | `vm=solana + depositAddress null / no-base58 → 502 prepare_no_deposit_address` | igual a AC-1 (PoP válido) pero `agentResponds(200, agentResult({ depositAddress: null }))` y variante `agentResult({ depositAddress: "0xNOT_BASE58" })` | ambas: `res.status === 502`; `{ error: "prepare_no_deposit_address" }` (mismo enum opaco que EVM, no-oráculo) |
| **AC-4** | `EVM byte-idéntico` | los tests EVM existentes (L112-274) corren sin tocar assertions; el `describe("PR6 rama Solana")` (L280-300) intacto | 100% verde; **0 assertion EVM modificada** |
| **AC-5/AC-8** | `smoke typechea` | `npm run typecheck:scripts` sobre `scripts/smoke-solana-e2e.ts` (vía `tsconfig.scripts.json`) + `npm run lint` | `tsc -p tsconfig.scripts.json --noEmit` sale 0; `next lint` sin errores |
| **AC-6** | `smoke aborta sin SMOKE_ALLOW_REAL` | code review del smoke: primer statement es el gate opt-in; segundo la validación de envs | el gate `SMOKE_ALLOW_REAL !== "true"` está ANTES de todo fetch; env faltante ⇒ `process.exit(1)` con mensaje. (No se ejecuta; revisión manual) |
| **AC-7** | `.env.example` documenta las 3 vars` | code review de `.env.example` | contiene `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`, `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY`, `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` con comentario formato del archivo |

> **CD-10/CD-11 en tests**: `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` y el `address` del caller se
> generan con `bs58.encode`/`nacl.sign.keyPair()`, NUNCA a mano. `SOL_ADDR` (`"So1111...112"`, L279)
> es un base58 válido reusable como beneficiary. Para "env ausente" usar `""` (no `undefined`).

---

## 6. Patrones a seguir (exemplars verificados)

| Para | Seguir | Path:línea |
|------|--------|-----------|
| VM-dispatch fail-closed opaco | PR4/PR6 de `prepare/route.ts` (ya ramifican por `resolveActiveVm()`) | `route.ts:96-105`, `:138-218` |
| Shape 200 Solana esperado | `isValidSolanaPrepareShape` | `http-solana-prepare-gateway.ts:48-58` |
| Atestación Solana | `issueSolanaDepositAttestation` + tipo `SolanaDepositAttestation` | `deposit-attestation.ts:117`, `:33-40` |
| PoP Solana firmado real en test | `signedSolanaPop` | `submit/route.test.ts:983-1000` |
| Harness del test de la route | `beforeEach` + `agentResponds`/`agentResult`/`bodyOf` | `route.test.ts:87-109`, `:65-85`, `:36-47` |
| Building-blocks del smoke (deposit ix) | `escrowIdl` + `SolanaWalletAdapter.authorizePrincipal` | `solana/escrow-idl.ts:8`, `solana-wallet.ts:31` |
| Forward server-side con Bearer (smoke paso 5) | `POST /api/settle/solana-sponsor` | `settle/solana-sponsor/route.ts:20-104` |
| Formato de comentario `.env.example` | bloque VM/mint/RPC existente | `.env.example:59-75` |

---

## 7. Done Definition

- [ ] `route.ts`: rama Solana produce `{beneficiary, authority, attestation, payoutId, provenance}` base58 que matchea `isValidSolanaPrepareShape`; EVM byte-idéntico (L252-294 sin cambios).
- [ ] `route.test.ts`: AC-1/AC-2/AC-3 nuevos (verde); tests EVM + `PR6 rama Solana` intactos (AC-4).
- [ ] `503 prepare_solana_authority_unavailable` (enum nuevo, NO reusa `payout_authority_unavailable`).
- [ ] `scripts/smoke-solana-e2e.ts`: env-driven, opt-in `SMOKE_ALLOW_REAL`, fail-loud, 9 checkpoints, link Explorer devnet, cero hardcodes/secretos.
- [ ] `tsconfig.scripts.json` + `package.json` (`tsx`, `smoke:solana`, `typecheck:scripts`, `qa` incluye `typecheck:scripts`).
- [ ] `.env.example`: 3 vars Solana faltantes con formato del archivo (AC-7).
- [ ] `runbook-skeleton.md`: 8 pasos + 2 tablas de envs cross-repo verificadas.
- [ ] `npm run qa` verde (typecheck + typecheck:scripts + test). `npm run lint` sin errores.
- [ ] NADA fuera del Scope IN (§1). NO exports nuevos en `route.ts` (CD-9). Flags OFF default (CD-5). Cero plata real (CD-6).

---

*Story File generado por NexusAgil — Architect F2.5. EVM byte-idéntico. Fail-closed. Flags OFF. Cero plata real.*
