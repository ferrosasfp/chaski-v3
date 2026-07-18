# Validation Report — WKH-210 (receptor de webhooks TransFi) — DENSE

**Veredicto**: **F4 APROBADO** (2 hallazgos de drift documental, MENOR, no bloqueantes)
**Fecha**: 2026-07-17
**Branch**: `feat/021-wkh-210-transfi-deposit-flow-webhook` (cambios sin commitear, working tree sobre `8a6032d`/`main`)

## 1. Runtime checks (ejecutados por mí, no re-uso de reportes ajenos)

| Check | Resultado | Evidencia |
|---|---|---|
| `npm run qa` (`tsc --noEmit` + `vitest run`) | ✅ tsc 0 errores; **501/501 tests verdes, 39 test files** | output completo de la corrida; matchea el 460→501 declarado post fix-pack |
| `grep -rn MUTANT src/ app/` | ✅ 0 matches (exit 1) | comando ejecutado directo |
| `grep -rn console\. app/api/webhooks src/infrastructure/webhooks` | ✅ 0 matches (exit 1) | no-PII/no-log confirmado |
| `NEXT_PUBLIC_EIP3009_ENABLED` | ✅ vacío en `.env.example:87` (default OFF), no seteado en process env | `grep` |
| `TRANSFI_ADAPTER_READY` | ✅ NO existe en `chaski-v2` (vive solo en repo externo `wasiai-remittance-agents`, confirmado por grounding F0 en work-item.md:104-108); nada que apagar acá | `grep -rn` en todo el repo (excl. node_modules/.next) |
| Webhook en vivo / POST real | ✅ NO ejecutado — solo `vitest run` contra mocks/fakes | — |
| `git diff --stat` sobre `wallet.ts`, `confirm-and-send.ts`, `settle/principal/route.ts` | ✅ vacío — CERO cambios (CD-5/CD-6 respetados) | comando ejecutado, sin output |

## 2. AC-por-AC (evidencia archivo:línea, impl + test)

| AC | Status | Evidencia impl | Evidencia test |
|---|---|---|---|
| AC-1 (501 sin secret, sin leer body) | ✅ PASS | `route.ts:12-15` (`if (!secret) return 501`), `req.text()` recién en `route.ts:17` | `route.test.ts:73-81` — `textSpy` NO llamado |
| AC-2 (HMAC crudo timing-safe, 401 sin mutar) | ✅ PASS | `route.ts:19-22`; `transfi-hmac.ts:10-17` (`timingSafeEqual`, chequeo de longitud primero, sobre el `raw` string) | `route.test.ts:83-93` (ausente→401, ledger no tocado), `:95-101` (mismatch→401), `:103-112` (raw vs re-serializado→401); `transfi-hmac.test.ts:19-45` |
| AC-3 (idempotencia, reorder mutate-first/claim-after) | ✅ PASS | `route.ts:44-62` (mutación en try/catch→503; claim recién después, resultado ignorado); filtro STALE en `supabase-settlement-ledger.ts:158-163` (`.in("status", STALE_STATUSES)`) y `fakes.ts:490-504` (mismo set `NON_TERMINAL`) | `route.test.ts:114-126` (alreadyUsed→200, mutación ya aplicada), `:260-276` (**bug-killer del fix**: DB-throw 1er delivery→503 SIN quemar key, retry re-muta→settled), `:278-292` (doble delivery normal, 2º no-op), `:294-305` (concurrencia) |
| AC-4 (fund_settled→settled) | ✅ PASS | `transfi-hmac.ts:23-30` | `route.test.ts:128-135` |
| AC-5 (fund_failed→failed, lastError enum) | ✅ PASS | `route.ts:53-57` (`error: mapped==="failed" ? "transfi_fund_failed" : undefined`) | `route.test.ts:137-151` (payload con "Juan Perez" en `reason`, `lastError` nunca lo contiene) |
| AC-6 (asset_deposited→submitted) | ✅ PASS | `transfi-hmac.ts:25-26` | `route.test.ts:153-160` |
| AC-7 (status desconocido→200 ACK sin mutar) | ✅ PASS | `route.ts:47-49` (`mapped===null`→200 antes de tocar el ledger) | `route.test.ts:162-173` — `claimMock`/`recordWebhookOutcome` spy NO llamados |
| AC-8 (payoutId inexistente→200 sin crear fila) | ✅ PASS | `recordWebhookOutcome` es un `UPDATE ... WHERE payout_id=X` (0-match, sin error); mismo comportamiento en `fakes.ts:497-503` (loop sin match = no-op) | `route.test.ts:175-184` (`store.size` intacto, fila ajena no tocada), `:186-195` (AC-8b, sin candidato de payoutId→200 `no_payout_id`, `recordWebhookOutcome` NO llamado) |
| AC-9 (no-PII, lastError enum) | ✅ PASS | `route.ts` solo pasa `payoutId/status(mapeado)/error-enum` a `ledger.recordWebhookOutcome`; `ports.ts:270-274` documenta CD-3/DT-8 | `route.test.ts:197-210` — payload con "Maria Gomez DNI..." nunca en `JSON.stringify(row)` ni en la respuesta |
| AC-10 (byte-idéntico OFF) | ✅ PASS | `git diff --stat` vacío en `wallet.ts`/`confirm-and-send.ts`/`settle/principal/route.ts`; único cambio en `submit/route.ts` es comentario (`git diff` mostrado abajo, línea de guard `if (att.chainId !== resolveChainId())` intacta) | `route.test.ts:212-218` (flag ledger OFF→501) |
| AC-11 (sandbox/testnet only) | ✅ PASS | `chain.ts:42-45` fallback fail-safe a 84532 (Base Sepolia) | `route.test.ts:42` (fixtures `chainId: 84532`), `:220-225` (AC-11, ningún `fetch` real) |

**11/11 ACs PASS con evidencia archivo:línea.**

## 3. Drift Detection

**Scope**: 8 archivos modificados + 3 nuevos, todos dentro de Scope IN del work-item (`app/api/webhooks/transfi/`, `src/infrastructure/webhooks/`, `src/application/ports.ts`, `src/infrastructure/persistence/supabase-settlement-ledger.ts(.test.ts)`, `src/test-support/fakes.ts`, `.env.example`, `submit/route.ts` comment-only, `doc/sdd/_INDEX.md`). Sin scope creep.

**2 hallazgos MENOR (documentales, no funcionales, no bloqueantes)**:

1. `doc/sdd/021-wkh-210-transfi-deposit-flow-webhook/story-WKH-210.md:308` — la fila de la matriz
   tests⇄ACs sigue diciendo `"503-a | claim unavailable (Upstash caído) → 503, ledger NO mutado"`.
   Eso describe el comportamiento **PRE-fix-pack**. Post-reorder (AR MNR-1), el test real se llama
   `"503-a→200"` (`route.test.ts:236-247`) y confirma que ese escenario hoy responde **200** con la
   mutación YA aplicada (el claim es best-effort, su resultado se ignora). `auto-blindaje.md:78-80`
   dice que se corrigieron "flujo pasos 8-10 + AC-3" en este archivo pero esta fila puntual quedó
   sin actualizar.
2. `src/infrastructure/webhooks/webhook-event-store.ts:29` — el comentario `// → 503, NUNCA muta
   (fail-closed)` sobre el caso `unavailable` describe una semántica que ya no aplica: `route.ts`
   ignora el resultado del claim tras la mutación (best-effort), así que un `unavailable` de Redis
   NUNCA produce un 503 en la práctica actual (el 503 solo sale de `recordWebhookOutcome` fallando,
   `route.ts:53-58`). El valor de retorno de la función sigue siendo correcto; es el comentario el
   que quedó desalineado con el nuevo caller.

Ninguno de los dos afecta código, tests, ni seguridad — son inconsistencias de comentario/documentación
que sobrevivieron al fix-pack de AR/CR. Recomiendo un barrido de 2 líneas en el próximo touch de este
archivo (no amerita reabrir el ciclo).

**Wave order**: respetado según `auto-blindaje.md` (W2 mutation self-check + fix-pack post-AR/CR
documentados en orden). Sin commits aún (working tree), no aplica verificación de orden de commits.

## 4. Gates (confirmados por mí, ejecución directa — no había cr-report.md/ar-report.md en disco;
el resumen AR/CR + fix-pack vive en `auto-blindaje.md`, que cité arriba)

- `npm run qa`: ✅ PASS (ejecutado en este F4, ver §1)
- Mutation self-check (3 mutantes W2 + 1 mutante del reorder, según `auto-blindaje.md`): documentado
  con revert confirmado; no re-ejecutado (evidencia de proceso, no gate de CI)

## 5. Veredicto

**F4 APROBADO.** 11/11 ACs PASS con evidencia archivo:línea + test. Runtime checks limpios (0 MUTANT,
0 console.*, flags OFF, sin webhook en vivo). CD-5/CD-6 verificados por `git diff` vacío en los archivos
protegidos. El reorder claim-after-mutate (fix del AR MNR-1) quedó verificado end-to-end con el
bug-killer test (`route.test.ts:260-276`) y el filtro STALE_STATUSES confirmado en ambas
implementaciones (real + fake). Los 2 hallazgos de drift documental no bloquean DONE — quedan
anotados para un barrido futuro de bajo costo.

**Listo para DONE.**
