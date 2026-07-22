# SDD #030: [WKH-214 / HU-SOL-11] e2e Solana devnet + smoke + envs (entrega de código de M5)

> SPEC_APPROVED: no
> Fecha: 2026-07-22
> Tipo: feature (money-path, cross-repo doc)
> SDD_MODE: full
> Branch: `feat/030-hu-sol-11-e2e-m5`
> Artefactos: `doc/sdd/030-hu-sol-11-e2e-m5/`

---

## 1. Resumen

`/api/payout/prepare` (chaski-v3) es hoy **EVM-only en su respuesta 200**: siempre arma el shape
`{depositAddress, attestation, payoutId, provenance}` y valida el `depositAddress` con `isAddress`
(viem), que **siempre rechaza un pubkey base58 de Solana**. Con `NEXT_PUBLIC_VM=solana` un
`depositAddress` real del agente muere fail-closed en `502 prepare_no_deposit_address`
(`prepare/route.ts:252`) — el money-path Solana no-custodial **no puede completarse e2e**. El cliente
ya está listo: `HttpSolanaPayoutPrepareGateway` (mergeado en HU-SOL-13a) consume
`{beneficiary, authority, attestation, payoutId, provenance}` base58 (`isValidSolanaPrepareShape`),
pero el server nunca produce ese shape.

Esta HU entrega **solo la porción de código/artefactos** que el equipo puede construir y testear con
mocks/CI:

1. **W0** — la rama Solana faltante en `prepare/route.ts` (dispatch por `resolveActiveVm()`),
   reusando `resolveSolanaReleaseAuthorityPubkey()` (chain.ts) + `issueSolanaDepositAttestation()`
   (deposit-attestation.ts), con la rama **EVM byte-idéntica**.
2. **W1** — un smoke script `scripts/smoke-solana-e2e.ts` parametrizable 100% por env, fail-loud,
   que ejercita el flujo devnet paso a paso e imprime el link del Solana Explorer.
3. **W2** — `.env.example` de chaski con TODAS las vars Solana ya consumidas por código, y el
   `runbook-skeleton.md` founder-gated (incluye la doc de envs de `wasiai-facilitator` y
   `wasiai-remittance-agents`, verificada contra el código real de esos repos).

El cierre real de M5 (deploy Vercel/Railway, keypairs devnet, IDs TransFi sandbox, flip de flags, tx
verificable en el explorer) es **founder-gated**, documentado en el runbook, **NO** entregable de F3.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 030 (WKH-214 / HU-SOL-11) |
| **Tipo** | feature (money-path Solana + tooling + docs) |
| **SDD_MODE** | full |
| **Objetivo** | Cerrar el gap de código H1 (rama Solana de `prepare`) + smoke script + envs documentadas, para que el runbook founder-gated pueda cerrar M5. |
| **Reglas de negocio** | Non-custodial Solana devnet. Fail-closed en toda env Solana ausente/malformada. Flags OFF default. Cero plata real. Secretos solo desde env. EVM byte-idéntico. |
| **Scope IN** | `app/api/payout/prepare/route.ts` (rama Solana), su test, `scripts/smoke-solana-e2e.ts` (nuevo), `.env.example`, `tsconfig.scripts.json` (nuevo) + `package.json` (script + devDep `tsx`), `doc/sdd/030-.../runbook-skeleton.md`. |
| **Scope OUT** | Deploy, keypairs/fondeo devnet reales, IDs TransFi sandbox, migraciones en prod, flip de flags en entorno compartido, ejecución del smoke contra servicios deployados, cualquier cambio en `wasiai-facilitator`/`wasiai-remittance-agents`, el companion Zod NC-2, el beneficiary REAL de TransFi Solana (NC-1). |
| **Missing Inputs** | Los 3 `[NEEDS CLARIFICATION]` del work-item quedan **resueltos en §10**. |

### Acceptance Criteria (EARS)

1. **AC-1** — WHEN `POST /api/payout/prepare` se invoca con `resolveActiveVm()==="solana"` y el
   upstream devuelve un `depositAddress` base58 válido, THE system SHALL responder `200` con
   `{beneficiary, authority, attestation, payoutId, provenance}` (base58), donde
   `authority === resolveSolanaReleaseAuthorityPubkey()` y `attestation` verifica con
   `verifySolanaDepositAttestation` (beneficiary/authority/cluster="devnet").
2. **AC-2** — IF `resolveSolanaReleaseAuthorityPubkey()` lanza (env `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`
   ausente o malformada), THEN THE system SHALL responder `503 prepare_solana_authority_unavailable`
   (enum estable, opaco, sin ecoar el env, nunca 200 parcial).
3. **AC-3** — IF el `depositAddress`/`beneficiary` del agente no es base58 válido (falla
   `canonicalizeAddress(x,"solana")`) o es `null`/vacío, THEN THE system SHALL responder el **mismo**
   error opaco que la rama EVM (`502 prepare_no_deposit_address`), sin distinguir el motivo en el body.
4. **AC-4** — WHILE `resolveActiveVm()==="evm"`, THE system SHALL mantener guard-order (PR1-PR11) y
   shape de respuesta byte-idénticos a hoy — 0 regresión en los tests EVM existentes de
   `prepare/route.test.ts`.
5. **AC-5** — THE system SHALL proveer `scripts/smoke-solana-e2e.ts` parametrizable 100% por env (URLs
   de los 3 servicios, keys/tokens, sin ningún valor hardcodeado) que ejercite, con checkpoints
   logueados, la secuencia healthcheck → KYC → prepare → deposit → sponsor → verify vault → release →
   orden TransFi → link de Solana Explorer.
6. **AC-6** — IF el smoke corre sin `SMOKE_ALLOW_REAL === "true"`, THEN THE script SHALL abortar
   ANTES de cualquier request de dinero real, con exit-code ≠ 0 y un mensaje explícito del motivo.
7. **AC-7** — THE system SHALL documentar en `.env.example` de chaski TODAS las vars Solana ya
   consumidas por `src/`/`app/` pero no documentadas hoy (`SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`,
   `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY`), con el formato de comentario del resto del archivo.
8. **AC-8** (smoke lint/typecheck) — THE system SHALL garantizar que `scripts/smoke-solana-e2e.ts`
   pasa `tsc --noEmit` (vía `tsconfig.scripts.json`) y `next lint` sin errores.

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `app/api/payout/prepare/route.ts` | El archivo a extender (H1) | Guard-order PR1-PR11; PR8 (`isAddress(depositAddress)` L252), PR9 (`issueDepositAttestation` L263-271), PR10 (ledger vm-aware L275-291), PR11 (shape 200 L294). PR4/PR6 YA ramifican por `resolveActiveVm()`. |
| `app/api/payout/prepare/route.test.ts` | Exemplar del test de la ruta | `vi.hoisted` + `vi.mock` de rate-limit/authority/ledger; `vi.stubEnv`; `agentResponds(status,result)` mockea `fetch`; ya existe `describe("PR6 rama Solana")` con `NEXT_PUBLIC_VM=solana` + `SOL_ADDR` base58. |
| `src/infrastructure/chain.ts` | Resolvers Solana a invocar | `resolveActiveVm()` (L121), `resolveSolanaReleaseAuthorityPubkey()` (L178, fail-loud), `resolveSolanaNetworkConfig().cluster` ("devnet", L129), `resolveSolanaFacilitatorPubkey()` (L161). |
| `src/infrastructure/settlement/deposit-attestation.ts` | Emisor de la atestación Solana | `issueSolanaDepositAttestation({remittanceId,quoteId,beneficiary,authority,cluster,exp})` (L117) + `verifySolanaDepositAttestation` (L129) — mismo secreto `DEPOSIT_ATTESTATION_SECRET`. `DEPOSIT_ATTESTATION_TTL_SECONDS` (L44). |
| `src/infrastructure/settlement/http-solana-prepare-gateway.ts` | Contrato exacto que el server DEBE producir | `isValidSolanaPrepareShape` (L48): `beneficiary`/`authority`/`attestation`/`payoutId` string no-vacío + `provenance` string. `mapErrorReason` (L23): un 503 con enum desconocido → `prepare_unavailable` (fail-closed sin tocar el gateway). |
| `src/infrastructure/address.ts` | Validación base58 | `canonicalizeAddress(address, vm)` (L13) throwea con base58 deforme; `addressEqualsVm` (L37) fail-safe try/catch. |
| `src/composition/container.ts` | Flags Solana | `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` (L102) gatea el path; guard mutua-exclusión con EIP-3009. |
| `app/api/settle/solana-sponsor/route.ts` | Endpoint que el smoke ejercita | `POST /api/settle/solana-sponsor` → `{FACILITATOR_BASE_URL}/solana/sponsor` (Bearer server-side); gated por `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED`. |
| `src/infrastructure/solana/escrow-idl.ts` + `src/infrastructure/solana-wallet.ts` | Reuso para el smoke | IDL Anchor pinneado + construcción de la ix `deposit`/partial-sign (el smoke reusa estos building-blocks con un `Keypair` devnet, NO reimplementa). |
| `tsconfig.json` | Alcance del typecheck | `include` = `src/**`,`app/**`,`.next/types/**` — **`scripts/` NO está incluido** → necesita `tsconfig.scripts.json` para que AC-8 tenga efecto. |
| `doc/sdd/029-hu-sol-13-escrow-integration/report.md` | Cross-repo (facilitator) | Endpoints `/solana/sponsor` (HU-SOL-14) + `/solana/escrow/release` (13c); facilitator HELD orden `026→027→13bc`; migración `004` PENDING-DEPLOY. |
| `wasiai-facilitator/src/infra/env.ts` + `routes/solana-sponsor.ts` + `routes/solana-escrow.ts` | Envs reales del facilitator (repo montado) | Vars Solana verificadas contra código (ver §7). |
| `wasiai-remittance-agents/src` (grep) | Envs reales del agente (repo montado) | `TRANSFI_USDC_NETWORK`, `TRANSFI_ADAPTER_READY`, credenciales TransFi (ver §7). |

### Exemplars (verificados con Glob/Read)

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| Rama Solana de `prepare/route.ts` | `prepare/route.ts:93-105` (PR4 VM-dispatch) + `:245-294` (PR8-PR11 EVM) | Mismo estilo VM-branch + fail-closed opaco. |
| Test de la rama Solana | `prepare/route.test.ts` `describe("PR6 rama Solana")` (L280) | Mismo harness (`vi.stubEnv("NEXT_PUBLIC_VM","solana")`, `SOL_ADDR`, `agentResponds`). |
| Atestación Solana | `deposit-attestation.ts:117` `issueSolanaDepositAttestation` | Ya existe; se invoca tal cual (cluster de `resolveSolanaNetworkConfig()`). |
| `scripts/smoke-solana-e2e.ts` | `app/api/settle/solana-sponsor/route.ts` (secuencia de forward) + `escrow-idl.ts`/`solana-wallet.ts` (deposit ix) | Reusar building-blocks Solana del repo, no reimplementar. |
| `.env.example` (bloque Solana) | `.env.example:59-75` (bloque VM/mint/RPC ya existente) | Mismo formato "qué hace / quién la lee / qué pasa si falta". |

### Estado de BD relevante

| Tabla | Existe | Notas |
|-------|--------|-------|
| `settlement_ledger` (Supabase propio de chaski) | Sí (WKH-207) | `recordOrderPrepared` es vm-aware (`vm:"evm"\|"solana"`, `ports.ts:383`) + best-effort (CD-17). **No** se crea/altera tabla en esta HU. |

### Componentes reutilizables

- `resolveSolanaReleaseAuthorityPubkey()`, `resolveSolanaNetworkConfig()` — reusar (no crear).
- `issueSolanaDepositAttestation()`, `canonicalizeAddress(x,"solana")` — reusar.
- `HttpSolanaPayoutPrepareGateway` — **NO tocar** (cerrado en HU-SOL-13a); ya consume el shape correcto.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué cambia | Exemplar |
|---------|--------|-----------|----------|
| `app/api/payout/prepare/route.ts` | Modificar | Rama Solana en el bloque de respuesta (PR8-PR11) por `resolveActiveVm()`. EVM byte-idéntico. Nuevos imports: `resolveSolanaReleaseAuthorityPubkey`, `resolveSolanaNetworkConfig` (chain), `issueSolanaDepositAttestation` (deposit-attestation). | `prepare/route.ts:93-105` |
| `app/api/payout/prepare/route.test.ts` | Modificar | +tests rama Solana (AC-1/AC-2/AC-3) sin tocar assertions de los tests EVM (AC-4). | `route.test.ts:280-300` |
| `scripts/smoke-solana-e2e.ts` | Crear | Smoke orquestador, env-driven, fail-loud, opt-in. | `solana-sponsor/route.ts` |
| `tsconfig.scripts.json` | Crear | `extends ./tsconfig.json`, `include: ["scripts/**/*.ts"]`, sin `.next/types` → typecheck aislado del smoke (AC-8). | `tsconfig.json` |
| `package.json` | Modificar | +devDep `tsx`; +scripts `smoke:solana` y `typecheck:scripts`; `qa` incluye `typecheck:scripts`. | `package.json:7-16` |
| `.env.example` | Modificar | Bloque Solana escrow/facilitator (AC-7) + doc de flags de deploy. | `.env.example:59-75` |
| `doc/sdd/030-hu-sol-11-e2e-m5/runbook-skeleton.md` | Crear (esqueleto en este SDD, materializado por docs) | 8 pasos founder-gated + doc de envs cross-repo. | `report.md` §Follow-ups |

### 4.2 Modelo de datos

N/A — sin cambios de schema. El `recordOrderPrepared` (best-effort) ya soporta `vm:"solana"`.

### 4.3 Diseño de la rama Solana de `prepare/route.ts`

**Invariante EVM byte-idéntico (CD-2/AC-4)**: PR1-PR7 son **compartidos e intactos** (config,
rate-limit, formato — que ya VM-branchea en PR4, autoridad, PoP — que ya VM-branchea en PR6, forward).
El único punto de extensión es el bloque de respuesta (hoy L245-294).

**Punto de branch** — tras `isValidPayoutResult(result)` (compartido) y el cómputo de
`depositAddress`/`payoutId`/`provenance` (compartido, L250-261), ramificar por `resolveActiveVm()`:

**Rama `evm` (default) — BYTE-IDÉNTICA a hoy**:
- valida `!depositAddress.trim() || !isAddress(depositAddress)` → `502 prepare_no_deposit_address`.
- `chainId = resolveChainId()`; `attestation = issueDepositAttestation({...})`.
- ledger `recordOrderPrepared({...chainId..., vm:"evm"})` best-effort.
- `200 {depositAddress, attestation, payoutId, provenance}`.

**Rama `solana` (nueva)**, en orden (DT-2 = validar beneficiary ANTES de tocar la env de authority):
1. **beneficiary** = el MISMO `depositAddress` del agente (DT-1). Si vacío → `502
   prepare_no_deposit_address`. Validar base58: `try { canonicalizeAddress(depositAddress,"solana") }
   catch { return 502 prepare_no_deposit_address }` (AC-3, mismo enum opaco que EVM, no-oráculo).
2. **payoutId** presente (compartido) → si vacío `502 prepare_no_deposit_address`.
3. **authority**: `try { authority = resolveSolanaReleaseAuthorityPubkey() } catch { return 503
   prepare_solana_authority_unavailable }` (AC-2, DT-3, enum NUEVO opaco — NUNCA reusa
   `payout_authority_unavailable` que significa "Didit no disponible").
4. **cluster** = `resolveSolanaNetworkConfig().cluster` ("devnet").
5. **attestation** = `issueSolanaDepositAttestation({remittanceId, quoteId, beneficiary:
   depositAddress, authority, cluster, exp: now + DEPOSIT_ATTESTATION_TTL_SECONDS})`.
6. **ledger** `recordOrderPrepared({..., depositAddress, chainId: resolveChainId(), senderAddress:
   address, payoutId, vm:"solana"})` best-effort (DT-6: `chainId` es telemetría; `vm:"solana"` es el
   discriminante real). NUNCA PII, NUNCA rompe (CD-17).
7. `200 {beneficiary: depositAddress, authority, attestation, payoutId, provenance}` — matchea EXACTO
   `isValidSolanaPrepareShape` del gateway.

**Nota anti-alucinación (Auto-Blindaje HU-SOL-9)**: PROHIBIDO exportar cualquier helper nuevo desde
`route.ts` — Next.js valida los exports de `route.ts` contra el set cerrado de handlers HTTP y
`tsc --noEmit` (que incluye `.next/types/**`) rompe. Toda la lógica nueva es inline o vía funciones ya
importadas.

### 4.4 Flujo principal (Happy Path — rama Solana, AC-1)

1. Cliente (`HttpSolanaPayoutPrepareGateway`) → `POST /api/payout/prepare` con `NEXT_PUBLIC_VM=solana`.
2. PR1-PR7 pasan (config OK, PoP Solana OBLIGATORIO verificado, forward al agente).
3. Agente devuelve `depositAddress` base58 (real solo con `TRANSFI_ADAPTER_READY=true`; devnet MVP).
4. Rama Solana: valida base58 → resuelve authority → emite `SolanaDepositAttestation` → 200 shape Solana.
5. Resultado: el gateway valida el shape, el use-case pasa `beneficiary`+`authority` a
   `authorizePrincipal` → la wallet arma la ix `deposit` del escrow.

### 4.5 Flujo de error

| Condición | Respuesta | AC |
|-----------|-----------|-----|
| `depositAddress` null (mock del agente) / no-base58 | `502 prepare_no_deposit_address` | AC-3 |
| `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` ausente/malformada | `503 prepare_solana_authority_unavailable` | AC-2 |
| VM=solana + `PAYOUT_POP_SECRET` ausente (PR6, ya existe) | `503 payout_pop_unavailable` | — |
| Smoke sin `SMOKE_ALLOW_REAL=true` | abort exit≠0, mensaje explícito | AC-6 |
| Smoke con env faltante (URL/keypair/token) | fail-loud exit≠0 antes de cualquier request de dinero | AC-5/AC-6 |

### 4.6 Diseño del smoke script (`scripts/smoke-solana-e2e.ts`, AC-5/AC-6/AC-8)

- **Runtime**: `tsx` (devDep nueva). Invocación: `npm run smoke:solana`. TS para reusar los libs
  Solana del repo (`@solana/web3.js`, `@coral-xyz/anchor`, `bs58`) y no "mentir" sobre el shape.
- **Env-driven 100%** (AC-5, sin hardcodes — CD-4): `SMOKE_CHASKI_URL`, `SMOKE_FACILITATOR_URL`,
  `SMOKE_REMIT_URL` (healthchecks), `SMOKE_SENDER_SECRET_KEY` (keypair devnet base58/JSON del sender
  que firma el deposit), `SMOKE_KYC_VERIFICATION_ID` (verificationId de sandbox Didit — el KYC de
  Didit es redirect-interactivo, el smoke consume un id pre-obtenido), `SMOKE_REMITTANCE_ID`,
  `SMOKE_QUOTE_ID`, `SMOKE_AMOUNT_USD`, `SMOKE_ALLOW_REAL` (opt-in). Todo faltante ⇒ fail-loud.
- **Gate opt-in (AC-6)**: PRIMER check `if (process.env.SMOKE_ALLOW_REAL !== "true") { abort }` ANTES
  de cualquier fetch de dinero. Segundo: validar que las envs requeridas existen (fail-loud).
- **Checkpoints logueados** (cada paso imprime `OK [N] <paso>` o aborta con `FAIL [N] <motivo>`):
  1. Healthcheck GET de los 3 servicios (chaski/facilitator/remit) — no-2xx ⇒ abort.
  2. KYC: valida `SMOKE_KYC_VERIFICATION_ID` presente (sandbox); opcional POST
     `/api/payout/validate` para confirmar autoridad.
  3. `POST {chaski}/api/payout/prepare` → assert shape Solana `{beneficiary,authority,attestation,
     payoutId,provenance}` base58 (guard inline, NO importa del gateway cerrado — CD-7).
  4. Construir + partial-firmar la ix `deposit` del escrow reusando `escrow-idl.ts`/los building-blocks
     de `solana-wallet.ts` con el `Keypair` de `SMOKE_SENDER_SECRET_KEY`.
  5. `POST {chaski}/api/settle/solana-sponsor` (broadcast gasless vía facilitator) → assert signature.
  6. Verify vault: leer el estado del escrow on-chain (RPC devnet) hasta `status==Deposited`.
  7. Release: disparar el path de release (submit) → assert la tx de release.
  8. Orden TransFi sandbox: assert `payoutId`/estado.
  9. **Imprimir** `https://explorer.solana.com/tx/<sig>?cluster=devnet`.
- **Cero plata real (CD-6)**: SOLO devnet; PROHIBIDO cualquier default a mainnet-beta. Nunca imprime
  secretos (CD-4).
- **No importa desde archivos cerrados en HU-SOL-13a** (CD-7): el shape-check del paso 3 es inline.

### 4.7 `.env.example` — vars Solana a agregar (AC-7)

Ya documentadas (no tocar): `NEXT_PUBLIC_VM`, `NEXT_PUBLIC_SOLANA_USDC_MINT`, `SOLANA_DEVNET_RPC_URL`,
`NEXT_PUBLIC_SOLANA_RPC_URL`. **Faltantes a agregar** (consumidas por `chain.ts`/`container.ts`):

| Var | Lee | Qué hace / qué pasa si falta |
|-----|-----|------------------------------|
| `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` | `chain.ts:179` (server-only) | Pubkey base58 de la release-authority del escrow (su keypair PRIVADA vive en el facilitator). `prepare` Solana la exige: ausente/malformada ⇒ `503 prepare_solana_authority_unavailable` (fail-loud). |
| `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY` | `chain.ts:162` (client-safe) | Pubkey base58 del fee-payer del facilitator (gasless). Con `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED=true` el guard del container la exige fail-loud. |
| `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` | `container.ts:102` / `solana-sponsor/route.ts:22` | `"true"` enciende el path Solana settle (deposit+sponsor). Default OFF ⇒ byte-idéntico. **NO** encender en entorno compartido (CD-5). |

> Regla: `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` es SERVER-ONLY (SIN `NEXT_PUBLIC_`, CD-4) — la
> keypair privada correspondiente NUNCA vive en chaski, solo el pubkey.

### 4.8 Runbook founder-gated (esqueleto — §7 + `runbook-skeleton.md`)

8 pasos, ninguno ejecutable en F3 (ver §7 la tabla de envs cross-repo con nombres reales).

---

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-1**: Guard-order PR1-PR7 de `prepare/route.ts` INTACTO; el único cambio es el bloque de
  respuesta (PR8-PR11) ramificado por `resolveActiveVm()`.
- **CD-2 (heredado, crítico)**: rama `vm==="evm"` **byte-idéntica** — mismo shape 200, mismos códigos
  de error, **0 assertion EVM cambiada** en `prepare/route.test.ts`.
- **CD-3**: fail-loud/fail-closed — toda env Solana ausente/malformada (authority pubkey, secretos del
  smoke) ⇒ error opaco/abort, NUNCA 200 parcial ni fallback silencioso.
- **CD-4**: PROHIBIDO hardcodear secretos (release-authority, fee-payer, attestation secret, tokens,
  keypair del sender) en el smoke o cualquier archivo versionado — todo desde env, nunca impreso.
- **CD-5**: flags OFF por default en todo ambiente compartido (`NEXT_PUBLIC_SOLANA_SETTLE_ENABLED`,
  `NEXT_PUBLIC_VM`) — esta HU CONSTRUYE, NO ENCIENDE.
- **CD-6**: cero plata real — smoke SOLO devnet; PROHIBIDO cualquier default/fallback a mainnet-beta.
- **CD-7**: PROHIBIDO tocar archivos cerrados en HU-SOL-13a/anteriores:
  `http-solana-prepare-gateway.ts`, `deposit-attestation.ts` (solo se INVOCAN),
  `submit/route.ts`, `settle/principal/route.ts`, `confirm-and-send.ts`, `solana-wallet.ts`,
  `chain.ts`, `container.ts`. El smoke los REUSA (import type / building-blocks) sin modificarlos.
- **CD-8**: PROHIBIDO escribir/modificar código en `wasiai-facilitator`/`wasiai-remittance-agents` —
  solo se LEEN para documentar sus envs en el runbook.
- **CD-9 (Auto-Blindaje HU-SOL-9)**: PROHIBIDO exportar helpers desde `route.ts` (rompe `tsc --noEmit`
  vía `.next/types`). Lógica nueva inline o vía funciones ya importadas.
- **CD-10 (Auto-Blindaje HU-SOL-13)**: en tests/smoke, generar literales base58 con `bs58.encode`/
  `Keypair` (NUNCA inventarlos a mano; el alfabeto base58 excluye `0 O I l`).
- **CD-11 (Auto-Blindaje HU-SOL-13)**: default-param footgun — pasar `undefined` USA el default; usar
  `null` sentinel para el caso "ausente" en fakes.

### PROHIBIDO
- NO agregar dependencias nuevas salvo `tsx` (devDep, especificada en este SDD para el smoke).
- NO crear patrones distintos a los existentes (fail-closed opaco, VM-dispatch).
- NO modificar archivos fuera del Scope IN (§2).
- NO hardcodear chainId/cluster/URLs/keys.
- NO reusar `payout_authority_unavailable` para el fallo de authority Solana (DT-3).

---

## 6. Scope

**IN**: rama Solana de `prepare/route.ts` + su test; `scripts/smoke-solana-e2e.ts`;
`tsconfig.scripts.json`; `package.json` (tsx + scripts); `.env.example` (vars Solana); `runbook-skeleton.md`.

**OUT**: deploy, keypairs/fondeo devnet, IDs TransFi sandbox, migraciones en prod, flip de flags,
ejecución real del smoke, cambios en facilitator/remit-agents, NC-1 (beneficiary real TransFi Solana),
NC-2 (companion Zod), cualquier cambio a archivos cerrados en HU-SOL-13a.

---

## 7. Runbook founder-gated — envs cross-repo (verificadas contra código real de los repos montados)

> Los repos `wasiai-facilitator` y `wasiai-remittance-agents` **SÍ están montados** en este workspace;
> los nombres de variables de abajo se leyeron del código real (no de citas). El runbook completo lo
> materializa `nexus-docs` en DONE; este es el esqueleto autoritativo.

### 7.1 `wasiai-facilitator` (Railway) — envs Solana (fuente: `src/infra/env.ts`, `routes/solana-*.ts`)

| Var | Rol |
|-----|-----|
| `SOLANA_RPC_URL` | RPC devnet (lee vault + broadcastea). |
| `SOLANA_USDC_MINT` | Mint USDC devnet (pin de referencia del adapter). |
| `SOLANA_FEE_PAYER_PRIVATE_KEY` | Keypair del fee-payer (gasless). Su pubkey = `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY` de chaski. |
| `SOLANA_FEE_PAYER_SPONSOR_ENABLED` | Registra `POST /solana/sponsor` (default OFF ⇒ 404). |
| `SOLANA_SPONSOR_POP_SECRET` | Secreto PoP del sponsor. |
| `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` | Keypair PRIVADA de la release-authority. Su pubkey = `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` de chaski. |
| `SOLANA_ESCROW_RELEASE_ENABLED` | Registra `POST /solana/escrow/release` (default OFF ⇒ 404). |
| `SOLANA_ESCROW_RELEASE_ATTESTATION_SECRET` | Secreto de la atestación KYC+TransFi que autoriza el release. |

### 7.2 `wasiai-remittance-agents` (Vercel) — envs corredor Solana (fuente: grep `src/`)

| Var | Rol |
|-----|-----|
| `TRANSFI_USDC_NETWORK` | `solana` para el corredor Solana. |
| `TRANSFI_ADAPTER_READY` | `true` ⇒ el agente expone `depositAddress` real (no-null); sin él, mock ⇒ `prepare` fail-closed. |
| `TRANSFI_API_KEY` / `TRANSFI_BASE_URL` / `TRANSFI_MID` / `TRANSFI_USERNAME` / `TRANSFI_PASSWORD` / `TRANSFI_USER_ID` / `TRANSFI_PAYMENT_CODE` / `TRANSFI_PURPOSE_CODE` / `TRANSFI_SOURCE_URL` / `TRANSFI_SOURCE_WALLET_ADDRESS` | Credenciales/config del sandbox TransFi (IDs de sandbox = founder). |

### 7.3 Los 8 pasos (founder + equipo en el deploy — NO F3)

1. **Merge + deploy `wasiai-facilitator`** a Railway (orden `026→027→13bc`, hoy HELD).
2. **Migraciones**: `004` (facilitator, escrow release dedup) + la de chaski (verificar nombre exacto
   en `supabase/` — ver §10 NC resuelto).
3. **Generar + fondear keypairs devnet**: fee-payer (`SOLANA_FEE_PAYER_PRIVATE_KEY`) y release-authority
   (`SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY`); sus pubkeys van en las envs de chaski.
4. **IDs sandbox TransFi Solana** (`TRANSFI_USDC_NETWORK=solana` + IDs de orden).
5. **Deploy Vercel** de `chaski-v3` y `remit-agents` con las envs de §4.7/§7.1/§7.2 seteadas.
6. **Flip de flags** (`NEXT_PUBLIC_VM=solana`, `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED=true`,
   `SOLANA_FEE_PAYER_SPONSOR_ENABLED`, `SOLANA_ESCROW_RELEASE_ENABLED`) — SOLO en el entorno del smoke.
7. **Correr `npm run smoke:solana`** con las `SMOKE_*` apuntando a los servicios deployados.
8. **Capturar el link de Solana Explorer** de la tx real y adjuntarlo como evidencia de cierre de M5.

---

## 8. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Regresión EVM en `prepare` | B | A | CD-2 byte-idéntico; los tests EVM existentes corren sin cambio de assertion; branch solo en el bloque de respuesta. |
| El smoke reimplementa la ix deposit y "miente" | M | M | Reusar `escrow-idl.ts`/`solana-wallet.ts` (CD-7 vía building-blocks); shape-check inline explícito. |
| `tsc` no cubre `scripts/` | M | M | `tsconfig.scripts.json` + `typecheck:scripts` en `qa` (AC-8). |
| Enum authority Solana colisiona semántica | B | M | DT-3: enum NUEVO `prepare_solana_authority_unavailable`. |
| Secreto filtrado en logs del smoke | B | A | CD-4: nunca imprimir secretos; solo IDs/sig/pubkeys. |
| Ledger `chainId` sin sentido en Solana | B | B | DT-6: `chainId` telemetría best-effort; `vm:"solana"` es el discriminante; nunca rompe (CD-17). |

---

## 9. Dependencias

- HU-SOL-4/5/6/7/8/9/13/14 — todas DONE (`_INDEX.md`).
- `resolveSolanaReleaseAuthorityPubkey()`, `issueSolanaDepositAttestation()`, `HttpSolanaPayoutPrepareGateway`
  ya mergeados. Facilitator HELD (deploy es founder-gated, Scope OUT).

---

## 10. Uncertainty Markers — los 3 `[NEEDS CLARIFICATION]` del work-item, RESUELTOS

| Marker (work-item) | Resolución | Bloqueante? |
|--------------------|------------|-------------|
| Nombre del código de error del 503 de authority Solana | **`prepare_solana_authority_unavailable`** (status 503). El gateway `mapErrorReason` lo colapsa a `prepare_unavailable` para 503 sin tocarlo (fail-closed, CD-7). | No — resuelto |
| Runtime del smoke (`tsx`/`ts-node`/compilado) + invocación | **`tsx`** (devDep nueva), archivo `scripts/smoke-solana-e2e.ts`, invocación `npm run smoke:solana`; typecheck vía `tsconfig.scripts.json` + `npm run typecheck:scripts`. | No — resuelto |
| Repos facilitator/remit-agents no accesibles | **Están montados** en `/home/ferdev/.openclaw/workspace/` — envs verificadas contra código real (§7). Doc del runbook precisa, sin "no verificado". | No — resuelto |

> Uno pendiente para el founder (NO bloqueante de F3, Scope OUT): el nombre EXACTO de la migración de
> chaski a aplicar (runbook paso 2) — verificar en `supabase/` en el deploy; no afecta el código de F3.

**Gate**: 0 `[NEEDS CLARIFICATION]` bloqueantes abiertos.

---

## 11. Waves de implementación

### Wave 0 (Serial Gate) — rama Solana de `prepare` + tests
- W0.1: agregar imports (`resolveSolanaReleaseAuthorityPubkey`, `resolveSolanaNetworkConfig`,
  `issueSolanaDepositAttestation`) y la rama Solana en el bloque de respuesta (§4.3). EVM byte-idéntico.
- W0.2: tests rama Solana en `prepare/route.test.ts` (AC-1/AC-2/AC-3), sin tocar assertions EVM (AC-4).
- Verificación: `npm run qa` (typecheck + test) verde; los tests EVM y `PR6 rama Solana` intactos.

### Wave 1 (depende de W0) — smoke script
- W1.1: `tsconfig.scripts.json` + `package.json` (tsx devDep + `smoke:solana` + `typecheck:scripts`).
- W1.2: `scripts/smoke-solana-e2e.ts` (§4.6), env-driven, opt-in, fail-loud, reusando building-blocks.
- Verificación: `npm run typecheck:scripts` verde + `next lint` sin errores (AC-8). NO se ejecuta.

### Wave 2 (paralelizable con W1) — envs + runbook
- W2.1: `.env.example` bloque Solana escrow/facilitator (§4.7, AC-7).
- W2.2: `doc/sdd/030-.../runbook-skeleton.md` (§7).
- Verificación: revisión de completitud (todas las vars grepeadas presentes).

### Test Plan

| Test | AC | Wave | Framework |
|------|-----|------|-----------|
| `prepare.test` AC-1: vm=solana + PoP ok + depositAddress base58 → 200 `{beneficiary,authority,attestation,payoutId,provenance}`; `verifySolanaDepositAttestation` verifica (authority==pubkey, cluster="devnet") | AC-1 | W0.2 | vitest |
| `prepare.test` AC-2: vm=solana + `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` unset/malformada → `503 prepare_solana_authority_unavailable` | AC-2 | W0.2 | vitest |
| `prepare.test` AC-3: vm=solana + agente `depositAddress:null` y `depositAddress:"0xNOT"` (no-base58) → `502 prepare_no_deposit_address` | AC-3 | W0.2 | vitest |
| `prepare.test` AC-4: los tests EVM existentes (happy path + PR1-PR10) corren sin cambio de assertion | AC-4 | W0.2 | vitest |
| `npm run typecheck:scripts` + `next lint` sobre `scripts/smoke-solana-e2e.ts` | AC-5/AC-8 | W1 | tsc/eslint |
| Revisión manual: smoke aborta sin `SMOKE_ALLOW_REAL` y con env faltante (no ejecuta requests) | AC-6 | W1 | code review |
| Revisión: `.env.example` lista las 3 vars faltantes con formato de comentario | AC-7 | W2 | code review |

> Nota tests (CD-10/CD-11): generar `SMOKE_SENDER`/beneficiary base58 con `bs58.encode`/`Keypair`; el
> `SOL_ADDR = "So1111...112"` ya usado en `route.test.ts:279` sirve como beneficiary/address válido.

---

## 12. Readiness Check

```
[x] Cada AC tiene ≥1 archivo asociado en tabla 4.1
[x] Cada archivo en 4.1 tiene Exemplar válido (verificado con Glob/Read)
[x] No hay [NEEDS CLARIFICATION] bloqueantes (los 3 resueltos en §10)
[x] Constraint Directives incluyen ≥3 PROHIBIDO (11 CD + bloque PROHIBIDO)
[x] Context Map tiene ≥2 archivos leídos (13 archivos, incl. 2 repos cross-repo)
[x] Scope IN y OUT explícitos y no ambiguos (§2/§6)
[x] BD: `settlement_ledger` verificada (vm-aware, sin cambio de schema)
[x] Happy Path completo (§4.4)
[x] Flujo de error definido (§4.5, ≥5 casos)
[x] EVM byte-idéntico documentado como invariante (CD-2/AC-4)
```

Sin checks fallidos.

---

*SDD generado por NexusAgil — FULL. Architect F2. EVM byte-idéntico. Flags OFF. Cero plata real.*
