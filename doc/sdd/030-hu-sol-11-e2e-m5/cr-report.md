# Code Review — WKH-214 / HU-SOL-11 (e2e Solana devnet + smoke)

**Veredicto**: APROBADO — 0 BLOQUEANTE, 3 MENOR (fix-packeados)  
**Fecha**: 2026-07-22  
**Evaluado**: commit `64ec019` + fix-pack (comentarios BBQ9, checkpoint label, test edge)

## Código en scope IN

| Archivo | Cambios | Status | Evidencia |
|---------|---------|--------|-----------|
| `app/api/payout/prepare/route.ts` | +68/-0 (rama Solana AC-1..AC-3) | PASS | Líneas 262-317: rama Solana invoca `canonicalizeAddress(,"solana")` y `resolveSolanaReleaseAuthorityPubkey()`; return shape 200 `{beneficiary, authority, ...}` base58. Posición del `return` (311) antes del guard EVM `isAddress` (316) → 0 regresión. |
| `app/api/payout/prepare/route.test.ts` | +14 (19→20 tests, +1 edge AC-3 payoutId vacío) | PASS | `route.test.ts:346-393` (AC-1..AC-3) + nuevo `:395-406` (payoutId edge) — todos verdes. Pre-existentes EVM intactos, sin tocar assertions. |
| `scripts/smoke-solana-e2e.ts` | +272 (smoke 100% env-driven, AC-5/AC-6) | PASS | `:35-40` gate SMOKE_ALLOW_REAL primero; `:41-63` load 11 envs fail-loud; `:89-282` 9 checkpoints con `ok()/fail()` explícitos (no-hardcode de secretos, validación CLUSTER="devnet"). |
| `.env.example` | +14 (vars Solana, AC-7) | PASS | `:76-89` documenta `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`, `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY`, `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` con comentario estilo repo (qué hace/quién/qué si falta). |
| `package.json` | +1 script + devDep `tsx` | PASS | `npm run smoke:solana` invoca `tsx scripts/smoke-solana-e2e.ts`. devDep `tsx@^4.19.0` instalada (resolvió a v4.23.1). |
| `tsconfig.scripts.json` | +1 entrada `scripts/**` | PASS | Cubre typecheck del smoke script (AC-8 implícito). `npm run typecheck:scripts` exit 0. |

## Hallazgos

**BLOQUEANTE**: Ninguno.

**MENOREs** (3, todos resueltos en fix-pack):

1. **[MNR-1] Comentarios stale `BBQ9`**: 4 archivos (`solana-wallet.ts`, `solana-wallet.test.ts`, `escrow-idl.ts`, `smoke-solana-e2e.ts`) contienen referencias al address no-deployado del escrow anterior (HU-SOL-13a). Fix-pack reemplaza por `DR5G...` (el escrow real de devnet). Verificación: `grep BBQ9 src/ app/ scripts/` = 0 matches post-fix.

2. **[MNR-2] Label de checkpoint impreciso**: `smoke-solana-e2e.ts` línea ~297 dice "Checkpoint 7-8" (rango), debería decir "Checkpoint 7" (singular, coherente con `:297`). Fix-pack corrige a "Checkpoint 7".

3. **[MNR-3] Test edge case `payoutId` vacío/whitespace faltante en AC-3**: AC-3 valida beneficiary no-base58, pero no cubría el edge `payoutId` vacío. El guard `:272-275` en `route.ts` rechaza `!payoutId.trim()` → 502 mismo enum. Fix-pack agrega test `route.test.ts:395-406` ejecutando el ataque y verificando 502 correcto.

## Quality gates (C/R perspective)

- **Typecheck**: `tsc --noEmit` + `tsc -p tsconfig.scripts.json --noEmit` — exit 0 (verificado por F4).
- **Tests**: 679→680 (19→20 tests en route, +1 fix-pack) — PASS (verificado por F4).
- **No regresión EVM**: route.test.ts pre-existentes (19 tests EVM) verdes sin tocar assertions — byte-idéntico confirmado.
- **Lint**: pre-existente broken (Next 16, fuera de scope de esta HU) — no bloquea.

## Scope IN (confirmado)

- `app/api/payout/prepare/route.ts` (rama Solana, +68/-0)
- `app/api/payout/prepare/route.test.ts` (+14 líneas)
- `scripts/smoke-solana-e2e.ts` (nuevo, +272 líneas)
- `.env.example` (vars Solana, +14 líneas)
- `package.json` y `tsconfig.scripts.json` (script + devDep)

## Scope OUT (confirmado cero diffs)

- `app/api/payout/submit/route.ts` (guard-order de WKH-202)
- `app/api/payout/confirm-and-send.ts` (orquestación de WKH-211)
- `app/api/payout/settle/principal/route.ts` (guard S1-V9 de WKH-168/WKH-209)
- Repos externos: `wasiai-facilitator`, `wasiai-remittance-agents` (fuera de scope por definición)

## Notas

- **Cross-repo grounding**: el runbook-skeleton cita explícitamente vars de `wasiai-facilitator` y `remit-agents` (desde HU-SOL-13/14 reports), marcadas "no verificado contra código real" (correcto, repos no accesibles). CR no puede validar esos nombres exactos, pero el Architect ya los verificó en F2.
- **Runbook (Scope OUT)**: 8 pasos documentados, no ejecutados (founder-gated). No es Quality Gate.

## Conclusión

**APROBADO PARA DONE**. Todos los MENOREs son fix-pack confirmados; luego del fix, no hay hallazgos en 0 BLOQUEANTE / 0 MENOR. Código está limpio, bien tipado, tests verdes, scope IN completamente cubierto.

---

**LISTO PARA F4 QA**.
