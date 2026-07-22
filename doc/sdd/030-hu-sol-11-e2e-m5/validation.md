# Validation Report — WKH-214 / HU-SOL-11 (COMPACT)

**Veredicto**: APROBADO PARA DONE (parte código — el cierre real de M5 es founder-gated, ver nota abajo)
**Fecha**: 2026-07-22
**Branch**: `feat/030-hu-sol-11-e2e-m5` · commit `64ec019`

## Runtime checks (gates propios, ejecutados por mí — no re-uso lo de CR)
- `npm run typecheck` (`tsc --noEmit`): exit 0
- `npm run typecheck:scripts` (`tsc -p tsconfig.scripts.json --noEmit`): exit 0
- `npm run test` (vitest): **679/679 tests, 57/57 archivos, PASS** (`npm run qa` completo, corrida fresca)
- `app/api/payout/prepare/route.test.ts` aislado: **19/19 PASS** (confirma 0 regresión EVM + rama Solana nueva)

## ACs — código (Scope IN, evidencia archivo:línea)

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (shape Solana 200) | PASS | `app/api/payout/prepare/route.ts:307-311` (return 200 shape); test `route.test.ts:346-369` ("AC-1..."); shape matchea EXACTO `http-solana-prepare-gateway.ts:48-58` (`isValidSolanaPrepareShape`) |
| AC-2 (authority ausente/malformada → 5xx opaco) | PASS | `route.ts:277-281` (`resolveSolanaReleaseAuthorityPubkey()` en try/catch → 503 `prepare_solana_authority_unavailable`); test `route.test.ts:371-382` (`""` y `"0xNOT"` → 503, body `{error:"prepare_solana_authority_unavailable"}` exacto, no ecoa env) |
| AC-3 (beneficiary no-base58/null → mismo enum que EVM) | PASS | `route.ts:262-267` (`canonicalizeAddress(depositAddress,"solana")` en try/catch → 502 `prepare_no_deposit_address`, MISMO código que la rama EVM); test `route.test.ts:384-393` (`null` y `"0xNOT_BASE58"` → 502, mismo enum) |
| AC-4 (EVM byte-idéntico, 0 regresión) | PASS | `git diff main...HEAD -- app/api/payout/prepare/route.ts` = **+68/-0** (cero deleciones); rama Solana `return`ea en `route.ts:311` antes del check `isAddress` EVM (`route.ts:316`); los 19 tests de `route.test.ts` (incl. TODOS los pre-existentes EVM) pasan sin tocar ninguna assertion vieja |
| AC-5 (smoke 100% env-driven, checkpoints logueados) | PASS | `scripts/smoke-solana-e2e.ts:41-52` (`REQUIRED_ENVS`, 10 vars, cero hardcode de URL/keys/mint/pubkey); 9 checkpoints con `ok()/fail()` explícitos (L102-282: healthcheck→KYC→prepare→deposit ix→sponsor→verify vault→release→TransFi→explorer link) |
| AC-6 (opt-in SMOKE_ALLOW_REAL, aborta antes de $ real) | PASS | `smoke-solana-e2e.ts:35-38` — gate `SMOKE_ALLOW_REAL !== "true"` es el PRIMER statement ejecutable del módulo, antes de cualquier `requireEnv`/fetch; mensaje explícito de motivo de abort |
| AC-7 (.env.example documenta envs Solana) | PASS | `.env.example` diff +14 líneas: `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`, `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY`, `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` — mismo formato de comentario (qué hace/quién la lee/qué pasa si falta) que el resto del archivo |
| Sección (B) runbook-skeleton | Founder-gated / runbook | `doc/sdd/030-hu-sol-11-e2e-m5/runbook-skeleton.md` — 8 pasos + Tabla A (facilitator, 15 envs) + Tabla B (remit-agents, 13 envs), documentado no ejecutado — NO es Quality Gate de F3/AR/CR (correcto per work-item) |

## Verificaciones críticas (pedidas explícitamente)
- **H1 cerrado**: confirmado — `route.ts:307-311` devuelve exactamente el shape que consume `HttpSolanaPayoutPrepareGateway.isValidSolanaPrepareShape` (`http-solana-prepare-gateway.ts:48-58`), cerrando el gap descrito en el grounding del work-item.
- **fail-closed authority**: confirmado con test negativo real (`""` y pubkey malformado `"0xNOT"` → 503, nunca 200 parcial, nunca `payout_authority_unavailable` reusado — código nuevo y distinto, `route.test.ts:378-380`).
- **EVM byte-idéntico**: confirmado por diff (+68/-0) y por la posición del `return` de la rama Solana (antes del guard EVM `isAddress`), más 19/19 tests EVM+Solana verdes sin tocar assertions previas.
- **smoke safety**: gate opt-in primero (L35-38) → validación fail-loud de las 10 envs requeridas ANTES de cualquier fetch con side-effect (L41-63, incluye `SMOKE_SOLANA_FACILITATOR_PUBKEY` resuelto upfront per fix-pack MNR-1) → `CLUSTER="devnet"` const hardcodeado sin fallback a mainnet-beta (L32, L75 usa `clusterApiUrl(CLUSTER)`) → `SMOKE_SENDER_SECRET_KEY` (grep confirma: nunca aparece en ningún `console.log`) → runtime `tsx` vía `npm run smoke:solana` (`package.json`), NO se invoca en ningún gate de F3.

## Drift
- `git diff --name-only main...HEAD`: 12 archivos, TODOS dentro de Scope IN (route.ts, route.test.ts, .env.example, scripts/smoke-solana-e2e.ts, tsconfig.scripts.json, package.json/-lock.json, docs de la HU).
- CD-7 confirmado: `submit/route.ts`, `confirm-and-send.ts`, `settle/principal/route.ts` — cero diffs (`git diff --name-only` no los lista).
- Sin wave violations (F3 fue un único commit de feature + fix-pack ya squasheado según contexto).

## Gates (confirmados con corrida propia, no solo leídos de CR)
- typecheck / typecheck:scripts / vitest (679 tests): PASS — ver Runtime checks arriba.
- lint: roto pre-existente (Next 16), no de esta HU — no bloquea, consistente con nota del orquestador.

## AR/CR follow-up
- AR: APROBADO, 0 findings (7 vectores revisados) — sin pendientes.
- CR: APROBADO, 0 BLQ, 1 MNR (smoke envs late) — resuelto en fix-pack (verificado: gate opt-in + validación de envs corren upfront, `smoke-solana-e2e.ts:34-63`, antes de cualquier fetch).

## Nota de cierre de M5
El cierre REAL de M5 (deploy de los 3 servicios, keypairs devnet fondeadas, IDs sandbox TransFi,
flip de flags, tx verificable en Solana Explorer) es **founder-gated** — Scope OUT explícito de esta
HU. El runbook de 8 pasos está listo en `doc/sdd/030-hu-sol-11-e2e-m5/runbook-skeleton.md` para que
el founder lo ejecute. Esta HU entrega SOLO la porción de código que el equipo puede construir y
testear con mocks/CI (AC-1..AC-7), y esa porción está 100% verificada con evidencia arriba.

**Listo para DONE (parte código).**
