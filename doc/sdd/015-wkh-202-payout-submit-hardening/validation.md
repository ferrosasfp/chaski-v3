# Validation Report — HU WKH-202 (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-15

## Runtime checks
- `npm run qa` (propia ejecución, no declarada): `tsc --noEmit` limpio + **287/287** tests, 25 archivos.
  `app/api/a2a/payout/submit/route.test.ts (19 tests)` = 8 preexistentes (WKH-186) + 5 `it()` + 1 `it.each`(4) nuevos (WKH-202).
- DB/migraciones: N/A — `chaski-v2` es `localStorage`-only (`project-context.md:33-35`), sin persistencia server-side.
- Env parity (CD-16, cero env vars nuevas): `git diff .env.example` → solo comentarios agregados (10 líneas, todas `#`), cero líneas `VAR=` nuevas. `grep 'process.env\.' git diff` → único uso: vars ya existentes (`REMIT_AGENTS_BASE_URL`, `VERCEL_ENV`, `DIDIT_API_KEY`, `DIDIT_BASE_URL`). ✅
- Import server-only (CD-17): `src/infrastructure/payout/authority.ts` — cero referencias desde `src/presentation/**` (`grep -rn` sin resultados). Import relativo, no `@/` (CD-7): `route.ts:19`. ✅

## ACs
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | ✅ | `route.ts:57-63` (guard formato, 400 antes de cualquier fetch) + `route.test.ts:152-160,162-170,176-189` (`it.each` 4 bodies no-record → 400, `fetchMock` never called) |
| AC-2 | ✅ | `route.ts:78-96` (switch `!d.authorized`, ninguna rama llega a `fetch` L99) + `route.test.ts:208-217` (Declined → 403, `agentCalls: 0`) + `:219-231` (ownership mismatch → 403, `agentCalls: 0`) |
| AC-3 | ✅ | `route.ts:44-46` (guard `!BASE` sigue siendo el PRIMERO, intacto) + `route.test.ts:63-71` (test preexistente sin cambios de assert, sigue 501 `a2a_not_configured`) |
| AC-4 | ✅ | `route.ts:96-110` (forward block sin cambios) + `route.test.ts:73-89` (idempotencyKey intacto CD-10, respuesta PII-free CD-5, vía autorización local `simulated_dev`) + `route.test.ts:195-206` (MNR-4: autorización REAL vía Didit → forward, `agentCalls.length === 1`) |
| AC-5 | ✅ | `authority.ts:56-91` (try/catch Didit → fail-closed `kyc_reauth_failed`) + `route.test.ts:233-242` (fetch throw → 502, `agentCalls: 0`) + `route.test.ts:244-255` (DT-5: `VERCEL_ENV=preview` sin key → 503, `agentCalls: 0`) |
| AC-6 | ✅ | `auto-blindaje.md:3-30` documenta la desviación 7-vs-8 del artefacto (confirmado `grep -c '  it('` = 8 en `HEAD`, no 7). `git diff -U0 route.test.ts` verificado por mí: el bloque de los 8 tests preexistentes (L63-148 actual) tiene **cero cambios de `expect(...)`** — únicos diffs son setup (import `beforeEach`, fixture `address: "0xSender"` L18, `beforeEach`/`afterEach` con `stubEnv` L38-45). `npm run qa`: 287/287 verde |
| AC-7 | ✅ | `route.ts:26-40` (`isValidPayoutResult`, lógica sin cambios) + `route.test.ts:99-105` (shape inválido → 502) + `:107-118`,`:120-129` (MNR-C payoutId-null → 502) + `:131-138` (failed+payoutId-null → 200), los 4 dentro del bloque preexistente byte-idéntico |

## Drift
- Scope: `git status --porcelain` → 10 archivos modificados + 1 nuevo (`src/infrastructure/payout/authority.ts`), todos dentro de Scope IN del work-item (`route.ts`/`route.test.ts`/`validate/route.ts`/`ports.ts`/`gateways.ts`(+test)/`confirm-and-send.ts`(+test)/`.env.example`). `doc/sdd/_INDEX.md` es bookkeeping normal, no código.
- Wave order: N/A — cambios sin commitear (unstaged en `main`), no hay historial de commits que auditar; AR (re-aprobado 0 BLOQUEANTES) y CR ya revisaron el diff completo.
- SDD §8 (riesgo residual): confirmado reflejado en runtime — `route.ts:8-17` (cabecera) y `.env.example` (comentario nuevo, líneas +58-67) nombran explícitamente **G2/WKH-203** (`kycPayoutAllowed` sigue siendo booleano del caller) y **G3/WKH-168** (nadie verifica pago del principal), y declaran que cerrar WKH-202 **no habilita la Fase A**. Coincide literal con `sdd.md:395-418`.
- Ports/contrato: `PayoutSubmit.address` agregado como **no-opcional** (`ports.ts` diff, +3 líneas) — evita fail-open por campo opcional (CD-4), consistente con DT-2.
- TODOs huérfanos: ninguno (los 2 matches de "TODO" en el diff son prosa española — "TODO en try/catch" = "todo dentro del try/catch" — no marcadores de trabajo pendiente sin ticket).
- `kycPayoutAllowed` hardcodeado (`gateways.ts:127`): preservado intencionalmente (CD-14, contrato cross-repo con WKH-203), con comentario-puntero nuevo — no es drift, es lo que exige el SDD.

## Gates (confirmado con ejecución propia)
- typecheck: ✅ `tsc --noEmit` limpio (salida propia)
- tests: ✅ 287/287, 25 archivos (salida propia)
- lint: preexistentemente roto (`next lint` con arg mal formado) — no es hallazgo de esta HU, confirmado por CR
- build: no re-ejecutado (cubierto por CR; `tsc --noEmit` ya cubre `*.test.ts` en este repo, sin `tsconfig.build.json`)

## AR/CR follow-up
- AR: 1 BLQ-BAJO (body `null` → 500 crudo) resuelto en fix-pack (`route.ts:47-55`, `auto-blindaje.md:32-67`) → re-AR **0 BLOQUEANTES**.
- CR: 5 MNR (incluye MNR-4, cubierto por `route.test.ts:195-206`) — aceptados como TD / ya incorporados donde aplicaba.
- Riesgos residuales R1/R2/G2/G3 documentados explícitamente en `sdd.md §8` y reflejados en runtime (`route.ts` header, `.env.example`) — no bloqueantes para esta HU, requieren WKH-203/WKH-168 como follow-up.

**Listo para DONE.**
