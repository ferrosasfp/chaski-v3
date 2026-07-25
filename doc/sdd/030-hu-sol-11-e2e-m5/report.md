# Report — HU-SOL-11 [WKH-214] e2e Solana devnet + smoke + envs (entrega de código de M5)

## Resumen ejecutivo

**Status**: DONE (parte código; cierre real de M5 founder-gated)  
**Fecha de cierre**: 2026-07-22  
**Branch**: `feat/030-hu-sol-11-e2e-m5` · commit `64ec019`

Todos los 7 ACs código (AC-1..AC-7) PASS con evidencia archivo:línea. H1 de prepare Solana cerrado: rama que produce `{beneficiary, authority, attestation, payoutId, provenance}` base58 byte-idéntica con el consumer `HttpSolanaPayoutPrepareGateway`. Smoke script parametrizable 100% por env con gate opt-in SMOKE_ALLOW_REAL. `.env.example` documentadas todas las vars Solana faltantes. Runbook-skeleton (8 pasos founder-gated) materializado. EVM byte-idéntico, 0 regresión.

---

## Pipeline ejecutado

| Fase | Entrada | Veredicto | Salida |
|------|---------|-----------|--------|
| **F0** | `work-item.md` (grounding, AC-1..AC-7, DT-N, CD-N) | hallazgo H1 confirmado en código: `prepare/route.ts:252` `isAddress()` rechaza base58; cliente (`HttpSolanaPayoutPrepareGateway`) listo desde HU-SOL-13a pero server nunca produce shape correcto | `work-item.md` |
| **F1** | `sdd.md` (SDD_MODE: full) + `story-HU-SOL-11.md` (Story File) | Spec + anti-hallucination checklist + waves (W0/W1/W2) validados contra código real; 7 Missing Inputs resueltos en §10 del SDD | `sdd.md`, `story-HU-SOL-11.md` |
| **F3 (Dev)** | `story-HU-SOL-11.md` | ✓ 679/679 tests PASS (incluye rama Solana nueva + 0 regresión EVM); `tsc --noEmit` + `tsc -p tsconfig.scripts.json --noEmit` = exit 0 | commit `64ec019` |
| **AR** | Código F3 + auto-blindaje | APROBADO — 7 vectores atacados, 0 BLOQUEANTE, 1 MENOR (comentarios BBQ9, fix-packeado). Auto-blindaje: 3 lecciones (feePayer, tsx install, lint pre-existente). | `ar-report.md` |
| **CR** | Código F3 | APROBADO — 0 BLOQUEANTE, 3 MENOR (comentarios BBQ9, checkpoint label, test edge payoutId, todos fix-packeados). Shape Solana correcto, EVM byte-idéntico +68/-0. | `cr-report.md` |
| **F4 (QA)** | Código F3 + AC-1..AC-7 | APROBADO PARA DONE — 7/7 ACs PASS, evidencia archivo:línea | `validation.md` |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|-----|--------|-----------|
| **AC-1** (shape Solana 200) | PASS | `app/api/payout/prepare/route.ts:307-311`; test `route.test.ts:346-369` matchea `isValidSolanaPrepareShape` |
| **AC-2** (authority ausente → 503 opaco) | PASS | `route.ts:277-281` try/catch → `prepare_solana_authority_unavailable`; test `route.test.ts:371-382` |
| **AC-3** (beneficiary no-base58 → 502 EVM enum) | PASS | `route.ts:262-267` `canonicalizeAddress` try/catch → `prepare_no_deposit_address`; test `route.test.ts:384-393` |
| **AC-4** (EVM byte-idéntico) | PASS | `git diff main...HEAD -- app/api/payout/prepare/route.ts` = **+68/-0**; 19/19 EVM tests sin cambios |
| **AC-5** (smoke 100% env-driven) | PASS | `scripts/smoke-solana-e2e.ts:41-52` REQUIRED_ENVS (10 vars, 0 hardcode); 9 checkpoints logueados |
| **AC-6** (opt-in SMOKE_ALLOW_REAL) | PASS | `smoke-solana-e2e.ts:35-38` — gate primero, antes de cualquier fetch |
| **AC-7** (.env.example vars Solana) | PASS | `.env.example` +14 líneas: `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`, `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY`, `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` |

---

## Hallazgos finales

**BLOQUEANTEs**: Ninguno — completamente resueltos.  
**MENOREs**: 4 resueltos en fix-pack:
- Comentarios stale `BBQ9` (4 archivos): reemplazados por `DR5G...` (escrow real).
- Checkpoint label impreciso ("7-8" → "7").
- Test edge case `payoutId` vacío/whitespace: agregado a AC-3.
- Envs late validation (smoke-solana-e2e.ts): moved upfront antes de cualquier fetch.

---

## Auto-Blindaje consolidado

3 lecciones críticas para próximas HUs Solana:

1. **Tipado de roles**: tx gasless tienen 3 pubkeys DISTINTOS (fee-payer, release-authority, sender) — NUNCA intercambiar
2. **Build Harness Verification**: toda devDep nueva requiere verificación de `node_modules/.bin/<tool>` antes de F3
3. **Condition Pre-Existente**: documentar hallazgos pre-HU explícitamente para evitar bloqueos sin culpa

---

## Archivos modificados

**Scope IN**: route.ts, route.test.ts, smoke-solana-e2e.ts, tsconfig.scripts.json, package.json, .env.example, docs SDD  
**Scope OUT** (confirmado cero diffs): submit/route.ts, confirm-and-send.ts, settle/principal/route.ts, facilitator y remittance-agents repos

---

## Decisiones diferidas a backlog

Ninguna — el cierre REAL de M5 (deploy, keypairs devnet, IDs TransFi sandbox, flip flags, tx Solana Explorer) está en el runbook founder-gated. Ver `doc/sdd/030-hu-sol-11-e2e-m5/RUNBOOK-M5.md`.

---

## Lecciones para próximas HUs

1. Tipado de roles financieros en Solana (fee-payer ≠ release-authority ≠ sender) — comment explícitos
2. Build Harness Verification: verificar devDeps nuevas post-declaración antes de dar OK a F3
3. Fail-closed enum diversificación: crear enums NUEVOS y OPACOS por rama de error, nunca reusar
4. Cross-repo grounding: citar explícitamente envs de repos externos, marcar "no verificado contra código real"

---

**Listo para DONE (parte código). Runbook-M5 materializado en `RUNBOOK-M5.md`.**
