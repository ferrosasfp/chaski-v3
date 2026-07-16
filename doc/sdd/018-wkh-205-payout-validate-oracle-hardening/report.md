# Report — [WKH-205] Cierre de deuda técnica: oráculo KYC de `/api/payout/validate`, bug body-null, rate-limit `/validate`+`/challenge`, higiene MNR-5/6

**Status**: DONE (2026-07-16) · **NNN**: 018 · **Branch**: `feat/018-wkh-205-payout-validate-oracle-hardening` · **Metodología**: QUALITY

## Resumen ejecutivo

WKH-205 cierra los follow-ups de deuda técnica de WKH-202 (AR/CR) + el residual R2 de WKH-206, sin tocar `authority.ts` (compartido) ni el guard-order de `submit`:

1. **Cerró el oráculo público de `/api/payout/validate`** — colapsa los 3 reasons *subject* (`kyc_not_approved` / `kyc_ownership_mismatch` / `invalid_verification_id`) a UN único `{authorized:false, reason:"kyc_not_authorized"}` con **status 200 fijo** (indistinguibles). Los reasons técnicos (`kyc_authority_unavailable` 503, `kyc_reauth_failed` 502) y `authorized:true` se preservan byte-idénticos vía rest-spread. El cliente legítimo es invisible al cambio: `humanError()` ya colapsaba todo código con "kyc" al mismo mensaje.
2. **Fix body-`null` → 500** en `/validate` — parseo a `unknown` + `isRecord()` (nunca `as {...}`).
3. **Rate-limit** en `/validate` (IP+address, financial-DoS: cada llamada re-consulta Didit) y `/challenge` (IP-only, residual R2 de WKH-206: flood de CPU HMAC), fail-CLOSED cuando Upstash está ausente en entorno vivo.
4. **Generalizó `rate-limit.ts`** — `checkRouteRateLimit(config, input)` + memo `Map` por `bucketPrefix` + `clientIp` exportado; `checkKycRateLimit` queda como wrapper byte-idéntico (7 tests intactos).
5. **Higiene**: MNR-5 (`isRecord` excluye arrays en las 3 copias) + MNR-6 (tipado `it.each<[string, unknown]>`).

## Pipeline ejecutado

| Fase | Status | Notas |
|------|--------|-------|
| F0+F1 | ✓ HU_APPROVED | 9 ACs EARS + 6 CDs; 4 [NEEDS CLARIFICATION] no-bloqueantes resueltos en F2 |
| F2 | ✓ SPEC_APPROVED | DT-1..6 cerradas; CD-1..14; Readiness verde; cazó 2 desviaciones del work-item (MNR-6 `isValidRecord` stale; CD-1 "2 tests" vs AC-1 "4 tests") |
| F2.5 | ✓ | Story File, 4 waves, sin [SDD-GAP] |
| F3 | ✓ | 4 waves; `npm run qa` verde 413/413. Mutation self-check (2 mutantes muertos y restaurados). El crash por límite de sesión dejó un mutante dangling → restaurado al reanudar. |
| AR | ✓ APROBADO | 0 BLQ / 0 MENOR — 8 vectores de ataque ejecutados y fallidos; mutante restaurado, su test lo mata |
| CR | ✓ APROBADO | 0 BLQ / 1 MENOR trivial (cross-ref de comentario sin números de línea) |
| F4 | ✓ APROBADO | 9/9 ACs PASS con evidencia archivo:línea; qa 413/413 re-ejecutado por QA |

## Acceptance Criteria — resultado final (9/9 PASS)

| AC | Requisito | Evidencia |
|----|-----------|-----------|
| AC-1 | Colapsar 3 reasons subject a 1 código no-revelador, indistinguible | `validate/route.ts` switch → `kyc_not_authorized`/200 fijo; test cruza-compara los 3 outputs (body+status `toEqual`) |
| AC-2 | Preservar reasons técnicos (502/503) sin colapsar | `default` branch pasa `rest`+`httpStatus` intactos; tests 502/503 sin cambio |
| AC-3 | Body no-record → 4xx nunca 500 (validate + challenge) | `isRecord` + `!Array.isArray`; it.each null/[]/123/"str" |
| AC-4 | Rate-limit `/validate` antes de Didit | rate-limit antes de `resolvePayoutAuthority`; 429 con fetch NOT called |
| AC-5 | Rate-limit `/challenge` IP-only antes de HMAC | tras el 501 de POP_SECRET, antes de `issuePopChallenge`; 429 sin HMAC |
| AC-6 | Fail-closed 503 si Upstash ausente + entorno vivo | `unavailable`→503 antes de `!ok`→429; tests en ambas rutas + rate-limit.test |
| AC-7 | Cliente legítimo observa byte-idéntico | gateway no ramifica por status; `humanError("kyc_not_authorized")===humanError("kyc_not_approved")`; authorized:true sin key `reason` |
| AC-8 | `isRecord` excluye arrays en las 3 copias | validate/challenge/submit con `!Array.isArray(v)` |
| AC-9 | Tipar `it.each` | `submit/route.test.ts` it.each `<[string, unknown]>` |

## Constraint Directives — cumplimiento

- **CD-3**: `authority.ts` intacto (`git diff main` vacío).
- **CD-6**: `submit/route.ts` = exactamente 1 hunk (L39-41, `!Array.isArray`).
- **CD-7**: reason colapsado contiene "kyc" (`payout_not_authorized` = 0 en validate).
- **CD-10**: `checkKycRateLimit` firma + comportamiento byte-idénticos; 7 tests verdes sin tocar asserts.
- **CD-11**: `flow-vm.ts` / `kyc/session/route.ts` / `confirm-and-send.ts` intactos.
- **CD-12**: parse a `unknown` + `isRecord`, sin `as {...}` real.

## Métricas de tests (vitest, conteo ejecutado — CD-14)

| Archivo | Baseline | Final |
|---------|----------|-------|
| `validate/route.test.ts` | 15 | 22 |
| `challenge/route.test.ts` | 4 | 6 |
| `submit/route.test.ts` | 41 | 44 |
| `rate-limit.test.ts` | 7 | 13 |
| `flow-vm.test.ts` | — | +1 (AC-7) |
| **Total suite** | — | **413/413 verde** (tsc strict 0 errores) |

## Hallazgo MENOR no-fixeado (con motivo)

**CR-MNR-1** (`validate/route.ts`, comentario del switch de colapso): el cross-ref a `submit/route.ts` quedó sin números de línea. **Decisión: NO fixear** — el propio CR lo calificó de funcionalmente nulo y "defendible" (los números de línea driftean con futuros refactors). No es deuda técnica accionable; agregar refs propensas a drift no es una mejora clara.

## Auto-Blindaje (lecciones)

1. **Mutante dangling por crash de sesión**: un `grep -rn MUTANT app/ src/` == 0 es obligatorio antes de cerrar F3. Si se usa mutation testing manual, backup en scratchpad + verificar restauración tras cualquier reanudación (el crash de esta HU dejó un mutante fail-open sin restaurar; el gate `npm run qa` lo cazó — el test AC-6 murió — y el dev reanudado lo restauró).
2. **Rate-limit fail-closed rompe tests de autoridad**: cuando el guard fail-closed corre ANTES de la autoridad y los tests de autoridad setean `DIDIT_API_KEY` sin Upstash, hay que mockear `checkRouteRateLimit` a `{ok:true}` por default y overridear solo en los tests de AC-4/AC-6.

## Residuales / deuda documentada (aceptada, no accionable)

- Duplicación deliberada del set de reasons entre `validate` y `submit` (DT-2: NO helper compartido, evita tocar el guard-order de submit — CD-6). Documentada con cross-ref.
- `clientIp` extraído a `rate-limit.ts`; la copia inline de `kyc/session` queda como dup pre-existente (migrable en HU futura).
- 3 copias inline de `isRecord` con exclusión de arrays (documentadas).

## Coordinación con WKH-207 (paralelo)

WKH-207 (019, persistencia/reconciliación) toca `submit/route.ts` post-forward (L265+). El toque de WKH-205 es quirúrgico (1 línea, L39-41). **F3 serial: WKH-205 mergea PRIMERO**; WKH-207 re-basea sobre el submit ya con el fix de 205.
