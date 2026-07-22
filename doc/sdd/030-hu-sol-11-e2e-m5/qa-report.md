# QA Report (F4) — WKH-214 / HU-SOL-11 — e2e Solana devnet (parte código)

**Veredicto**: APROBADO PARA DONE (Sección A — código/artefactos)
**Fecha**: 2026-07-22
**Base evaluada**: `main` (contiene `64ec019`) + branch `feat/m5-escrow-dr5g-address` (`89628d8`) +
fix-pack en working tree sin commitear (comentarios `BBQ9→DR5G` en `solana-wallet.ts`/`solana-wallet.test.ts`/
`escrow-idl.ts`/`smoke-solana-e2e.ts`, label de checkpoint 7-8→7, test nuevo AC-3 payoutId vacío/whitespace
en `route.test.ts:395-406`).

## Runtime checks (corridos por mí, no re-uso de CR)
- `npm run qa` (`tsc --noEmit` + `tsc -p tsconfig.scripts.json --noEmit` + `vitest`): **exit 0**.
  - `npm run typecheck`: 0 errores.
  - `npm run typecheck:scripts`: 0 errores (cubre `scripts/smoke-solana-e2e.ts`, AC-8).
  - `vitest`: **680/680 tests, 57/57 archivos, PASS** (número esperado confirmado).
  - `app/api/payout/prepare/route.test.ts` aislado: **20/20 PASS** (19 previos + 1 test nuevo del fix-pack).
- `grep -rn BBQ9 src/ app/ scripts/`: **0 matches** (exit 1 de grep = sin coincidencias) — confirma el
  fix-pack de comentarios está completo, cero rastro del address viejo no-deployado.

## ACs — Sección (A) código, evidencia archivo:línea

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (200 shape Solana, `authority = resolveSolanaReleaseAuthorityPubkey()`) | PASS | `app/api/payout/prepare/route.ts:277-282` (resuelve authority en try/catch) + `:313-317` (return 200 `{beneficiary, authority, attestation, payoutId, provenance}`); test `route.test.ts:346-369` ("AC-1...") — verifica `json.authority === authorityPubkey` y que `verifySolanaDepositAttestation` valida beneficiary/authority/cluster="devnet" |
| AC-2 (authority ausente/malformada → 5xx opaco, sin 200 parcial) | PASS | `route.ts:278-283` (`try { resolveSolanaReleaseAuthorityPubkey() } catch { return 503 prepare_solana_authority_unavailable }`); test `route.test.ts:371-382` — `""` y `"0xNOT"` → 503, body exacto `{error:"prepare_solana_authority_unavailable"}`, nunca ecoa el env, nunca reusa `payout_authority_unavailable` |
| AC-3 (depositAddress/beneficiary null/no-base58 → mismo enum opaco que EVM) | PASS | `route.ts:262-269` (`!depositAddress.trim()` y `canonicalizeAddress(depositAddress,"solana")` try/catch, ambos → `502 prepare_no_deposit_address`); test `route.test.ts:384-393` (`null` y `"0xNOT_BASE58"` → 502 mismo enum). Edge adicional del fix-pack: `route.test.ts:395-406` — `depositAddress` base58 válido pero `payoutId` vacío/whitespace → mismo 502 (guard `route.ts:272-275`) |
| AC-4 (EVM byte-idéntico, 0 regresión) | PASS | `git diff 64ec019^..64ec019 -- app/api/payout/prepare/route.ts` = **+68/-0** (cero deleciones, cero líneas EVM tocadas); rama Solana `return`ea en `route.ts:313-317` ANTES del guard EVM `isAddress` (`route.ts:320`); rama EVM completa intacta `route.ts:319-362`; 20/20 tests de `route.test.ts` (incl. TODOS los EVM pre-existentes) verdes sin cambio de assertion |
| AC-5 (smoke 100% env-driven, checkpoints logueados) | PASS | `scripts/smoke-solana-e2e.ts:43-55` (`REQUIRED_ENVS`, 11 vars, cero hardcode de URL/keys/mint/pubkey — `CLUSTER="devnet"` es el único literal, intencional por CD-6); helpers de checkpoint `ok()/fail()` en `:89-95` (`OK [N] <msg>` / `FAIL [N] <reason>`, exit≠0) |
| AC-6 (opt-in `SMOKE_ALLOW_REAL`, aborta antes de $ real) | PASS | `smoke-solana-e2e.ts:37-40` — el gate `SMOKE_ALLOW_REAL !== "true"` es el PRIMER statement ejecutable del módulo (antes de `REQUIRED_ENVS`/`requireEnv`/cualquier fetch), `process.exit(1)` con mensaje explícito del motivo |
| AC-7 (.env.example documenta envs Solana) | PASS | `.env.example:76-89` — `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` (:81), `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY` (:85), `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` (:89), cada una con comentario "qué hace / quién la lee / qué pasa si falta", mismo formato que el resto del archivo |
| AC-8 (smoke typecheck limpio) | PASS | `npm run typecheck:scripts` exit 0 (arriba) — `tsconfig.scripts.json` incluye `scripts/**/*.ts` |
| Sección (B) runbook-skeleton | Founder-gated / doc | `doc/sdd/030-hu-sol-11-e2e-m5/runbook-skeleton.md` — 8 pasos + tablas de envs cross-repo (facilitator/remit-agents); NO es Quality Gate de F3/AR/CR (correcto per work-item). Refleja el estado real: M5 on-chain cumplido (deposit devnet 2×, vault 10 USDC), pendiente founder-gated documentado explícitamente (release path, migraciones, IDs TransFi, flip de flags) |

## Drift detection
- `git diff --name-only main...HEAD`: `scripts/smoke-solana-e2e.ts`, `solana-wallet.ts`/`.test.ts`/`.refund.test.ts`, `escrow-idl.ts` — todos dentro de Scope IN de la HU (código Solana / smoke).
- Fix-pack sin commitear: `route.test.ts` (+1 test), comentarios `BBQ9→DR5G` (4 archivos), label checkpoint — todo dentro de Scope IN, coincide con lo reportado por CR (MENOR resuelto).
- CD-7 confirmado: `submit/route.ts`, `confirm-and-send.ts`, `settle/principal/route.ts` — 0 diffs.
- **Hallazgo menor, no bloqueante**: el working tree tiene además cambios sin commitear en `doc/sdd/028-hu-sol-9-.../*` y `doc/sdd/_INDEX.md` y `tsconfig.tsbuildinfo` — **fuera del Scope IN de HU-SOL-11** (pertenecen a HU-SOL-9/028, un artefacto de sesión previa). No afectan código de esta HU ni sus tests; se documentan para que el orquestador decida si commitear por separado o descartar antes del push. No bloquea el veredicto de F4 de esta HU.
- Sin wave violations: W0 (rama Solana + tests) → W1 (smoke) → W2 (envs/runbook), commits `64ec019`→`89628d8`→fix-pack, orden consistente con el SDD.

## Gates (confirmados con corrida propia)
- `typecheck` / `typecheck:scripts` / `vitest` (680 tests): **PASS**, corrida fresca (ver Runtime checks).
- `lint`: no re-ejecutado — orquestador reporta AR/CR ya APROBADO (0 BLQ) con el mismo estado pre-existente de Next 16 no atribuible a esta HU; no bloquea.

## AR/CR follow-up
- AR: APROBADO (según orquestador) — sin findings pendientes verificables en el diff actual.
- CR: APROBADO, 0 BLOQUEANTE, MENORs resueltos en fix-pack — verificado en código: comentarios `BBQ9→DR5G` (0 rastros, grep confirmado), label de checkpoint corregido (`smoke-solana-e2e.ts:297` dice "Checkpoint 7" no "7-8"), test de edge case `payoutId` vacío agregado (`route.test.ts:395-406`).

## Nota de cierre M5
El cierre real de M5 (deploy, keypairs fondeadas, IDs TransFi, flip de flags, tx verificable en Explorer)
es founder-gated (Scope OUT de esta HU) y ya está narrado con evidencia on-chain real en
`doc/sdd/030-hu-sol-11-e2e-m5/runbook-skeleton.md` §0 (deposit devnet 2×, vault 10 USDC, escrow DR5G).
Esta HU entrega y verifica SOLO la porción de código (AC-1..AC-8), 100% con evidencia arriba.

**Listo para DONE (parte código).**
