# Auto-Blindaje — WKH-210 (receptor de webhooks TransFi)

Sesión F3 (Dev). Baseline al abrir: 36 files / 460 tests, tsc 0. Al cerrar: 39 files / 498 tests, tsc 0.

## Mutation self-check (3 mutantes montados, cada uno mató ≥1 test, todos revertidos)

### [2026-07-17] W2 — Mutante (a): HMAC sobre body re-serializado en vez del crudo
- **Montaje**: en `route.ts` cambié `verifyTransfiHmac(raw, sig)` por
  `verifyTransfiHmac(JSON.stringify(JSON.parse(raw)), sig)`.
- **Resultado**: FAIL en `AC-2 (crudo/DT-4)` — un body con otro spacing que parsea al mismo objeto
  pasaba a validar (401 esperado → 200). Mató el test. (También reventó el test 400 por el `JSON.parse`
  sin guard, kill colateral.)
- **Revertido**: sí (restauré desde backup en scratchpad).
- **Aplicar en**: cualquier verificación de firma sobre payloads — SIEMPRE firmar el string crudo
  recibido, jamás un re-serializado.

### [2026-07-17] W2 — Mutante (b): fail-closed sin secreto (501 → 401)
- **Montaje**: el `if (!secret)` devolvía `401 webhook_unauthorized` en vez de `501 webhook_not_configured`.
- **Resultado**: FAIL en `AC-1/CD-2` por código exacto (CD-13: la aserción es `toBe(501)`, no "≠200").
  Un fail-open parcial 501→401 se hubiera colado con "no-200".
- **Revertido**: sí.
- **Aplicar en**: toda cascada fail-closed — asertar el código HTTP EXACTO en cada rama.

### [2026-07-17] W2 — Mutante (c): idempotencia — dejar pasar el 2º delivery
- **Montaje**: en la rama `alreadyUsed` quité el `return` (comenté el early-return) → el flujo caía a
  `recordWebhookOutcome` re-mutando el ledger.
- **Resultado**: FAIL en `AC-3/CD-4` — `recordWebhookOutcome` llamado en un delivery ya reclamado.
- **Revertido**: sí (restauré `route.ts` byte-idéntico desde backup).
- **Aplicar en**: claim-once atómico DEBE cortar ANTES de mutar; el test cubre el 2º delivery.

## Notas de implementación (lecciones heredadas aplicadas)
- **Mock supabase = thenable builder** (WKH-207#2): reusé el `makeClient` thenable existente en
  `supabase-settlement-ledger.test.ts` (no `mockResolvedValue` sobre el builder chainable).
- **Request-like minimal en route.test.ts**: la route solo usa `req.headers.get()` + `req.text()`; usé
  `{ headers: new Headers(), text: vi.fn() }` para poder espiar `req.text` confiablemente y asertar
  (AC-1) que NO se llama antes del 501.
- **`npx tsc --noEmit` completo** (WKH-196): el gate es `npm run qa` (typecheck + vitest), no `build`.
- **`grep -rn MUTANT app/ src/` = 0** al cerrar (verificado, exit 1 = sin matches).
- **route.ts restaurado desde backup** (no `git checkout`, era archivo no-commiteado) tras los mutantes.

## Confirmaciones de scope
- Flags `NEXT_PUBLIC_EIP3009_ENABLED` / `TRANSFI_ADAPTER_READY` NO tocados (CD-1, `git diff` limpio).
- `wallet.ts` / `confirm-and-send.ts` / guard-order de `settle`/`submit` NO tocados (CD-5). El único
  cambio en `submit/route.ts` es el comentario MNR-1 (terminología Fuji/43114 → Base Sepolia 84532 /
  mainnet 8453); el guard `if (att.chainId !== resolveChainId())` intacto. `chain.ts:42-46` confirmado:
  fallback real es 84532 (Base Sepolia).
- No hubo `[STORY-GAP]` ni `[SDD-GAP]`.

---

# FIX-PACK post-AR/CR (2026-07-17, Dev). Baseline al abrir: 498 tests, tsc 0. Al cerrar: 501 tests, tsc 0.

## FIX-A (AR MNR-1) — lost-update por claim-before-mutate

### [2026-07-17] Reorder claim↔mutate en el webhook (at-most-once → at-least-once idempotente)
- **Error de diseño (AR MNR-1)**: `route.ts` hacía `claimWebhookEventOnce` (SET NX, quema la key) ANTES
  de `recordWebhookOutcome`. Si el ledger tiraba (DB down) ⇒ 503 (para inducir retry de TransFi), pero
  la key YA estaba quemada ⇒ el retry del MISMO evento veía `alreadyUsed` ⇒ 200 dedupeado SIN re-mutar
  ⇒ la transición (ej. `fund_settled→settled`) se PERDÍA; la fila quedaba no-terminal para siempre.
- **Causa raíz**: at-most-once (claim gatea la mutación) sobre una mutación NO-atómica con el claim. El
  claim se consumía aunque la mutación fallara.
- **Fix**: reordené a mutate-first / claim-after (`route.ts:77-97`). La mutación es idempotente por
  construcción — `recordWebhookOutcome` filtra por `STALE_STATUSES` (principal_in/submitted/forward_error),
  así que aplicar la misma transición N veces = 1 vez (2ª+ = no-op) y nunca degrada un terminal. Un
  DB-throw ⇒ 503 SIN quemar la key ⇒ el retry re-muta idempotentemente. El claim quedó best-effort
  (dedup/telemetría); su resultado se ignora (alreadyUsed | unavailable | ok → igual 200).
- **Verificación de la premisa**: confirmé el STALE filter en el ledger real
  (`supabase-settlement-ledger.ts:189`, `.in("status", STALE_STATUSES)`) y en el fake
  (`fakes.ts:495-504`) ANTES de confiar en el reorder.
- **Tests nuevos (+3)**: bug-killer (DB-throw 1er delivery → 503 sin quemar key + claim NO llamado; retry
  → re-muta → settled, 200); doble delivery normal (2º no-op idempotente, settled 1 vez); concurrencia
  conceptual (2 deliveries en Promise.all → settled 1 vez). Reescribí AC-3 (alreadyUsed ⇒ mutación YA
  aplicada, `{ok:true}` sin flag deduped) y 503-a (claim unavailable post-mutación ⇒ 200 best-effort, ya
  NO 503). Reforcé 503-b (DB-throw ⇒ claim NO llamado). Archivo: 18 → 21 tests.
- **Mutation self-check**: monté el MUTANT (claim-before-mutate, el orden buggy) → el bug-killer MURIÓ
  (`expected 503 to be 200` + claim quemado; 4 fails en total). Restauré desde backup en scratchpad (no
  `git checkout`). `grep -rn MUTANT app/ src/` = 0 (exit 1).
- **Docs corregidas**: `story-WKH-210.md` (flujo pasos 8-10 + AC-3), `sdd.md` (DT-9, flujo §6.3, AC-3
  §6.5) — el patrón estaba documentado como at-most-once/claim-antes-de-mutar intencional; corregido a
  at-least-once idempotente.
- **Aplicar en**: cualquier endpoint con dedup por token single-use (SET NX) + mutación externa que
  pueda fallar → el token se quema DESPUÉS de la mutación exitosa, nunca antes; o la mutación debe ser
  idempotente y el token best-effort. Mismo patrón vive en `attestation-store` / `pop-nonce-store`
  (ahí el claim gatea una firma stateless, sin mutación posterior que perder ⇒ no aplica el bug).

## FIX-B (CR MNR-1) — comentario con ref de línea stale
- **Error**: `submit/route.ts:252` decía `chain.ts:9-13 hace fallback a 84532`; las líneas 9-13 son
  imports/tipos. El fallback real vive en `resolveChainId()` (`chain.ts:42-45`).
- **Fix**: `chain.ts:9-13` → `chain.ts:42-45`. SOLO comentario, cero cambio de lógica.
