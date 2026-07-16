# Validation Report — WKH-206 (G5 gate Fase A: proof-of-possession del payout)

**Veredicto**: **F4 APROBADO**
**Fecha**: 2026-07-16
**Branch**: `feat/017-wkh-206-payout-proof-of-possession` (sin commitear al momento de F4)

---

## 1. Runtime / Integration checks (ejecutados por QA, no leídos del Dev)

| Check | Resultado |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | ✅ 0 errores, exit limpio |
| `npm run test` (`vitest run`) | ✅ **34 test files, 397/397 tests PASS** (ejecución propia, `Duration 3.34s`) — confirma el número reportado por el Dev (394 baseline + 3 del fix-pack) |
| `grep -icE "\"siwe\"|\"ethers\"" package.json` | ✅ `0` (AC-7/CD-1) |
| `PAYOUT_POP_SECRET` en `.env.local` | ✅ ausente (no aparece ni como línea vacía) |
| `NEXT_PUBLIC_PAYOUT_POP_ENABLED` en `.env.local` | ✅ ausente |
| Ambos flags en `.env.example` | ✅ presentes pero **vacíos** (`PAYOUT_POP_SECRET=`, `NEXT_PUBLIC_PAYOUT_POP_ENABLED=`), solo documentados con comentarios extensos (doble-flag, acoplamiento ops) |
| Vercel env vars (prod/preview) | ⚠️ **NO VERIFICABLE** — `vercel env ls` sin credenciales locales (`Error: No existing credentials found`). No bloqueante: la branch no está commiteada/deployada; verificación pre-merge recomendada al operador antes del primer deploy con estos flags. |
| Byte-identidad del bloque WKH-168 (`md5sum`, NO `git diff`) | ✅ `git show HEAD:app/api/a2a/payout/submit/route.ts` líneas 113-201 vs. working tree líneas 176-264 → **mismo md5 `1bf51c6e72dff0a150c4cc7408acc59c`**. Confirma CD-5/AC-5 con evidencia binaria, no solo lectura. |
| Scope drift (`git diff --name-only main`) | ✅ 12 archivos modificados + 8 nuevos (`app/api/a2a/payout/challenge/{route.ts,route.test.ts}`, `src/infrastructure/auth/{pop-challenge,pop-nonce-store,http-pop-signer}.ts` + 3 tests) — **100% dentro de Scope IN** del work-item/SDD |
| Archivos prohibidos (CD-12/Scope OUT: `authority.ts`, `attestation.ts`, `attestation-store.ts`, `payout/validate/route.ts`, Didit) | ✅ **NINGUNO tocado** (grep sobre el diff da 0 matches) |

---

## 2. AC Verification (evidencia archivo:línea)

| AC | Status | Evidencia impl. | Evidencia test |
|----|--------|------------------|-----------------|
| **AC-1** (byte-idéntico OFF, Vercel incl.) | ✅ PASS | `app/api/a2a/payout/submit/route.ts:122-123` (`POP_SECRET` gate, skip total) | `app/api/a2a/payout/submit/route.test.ts:593` ("AC-1: PAYOUT_POP_SECRET ausente ⇒ SKIP total... popClaimMock NUNCA llamado") + `:604` ("AC-1/DT-4: secreto ausente EN VERCEL... SKIP igual, NO 503") |
| **AC-2** (nonce single-use, exp, atómico) | ✅ PASS | `app/api/a2a/payout/challenge/route.ts:39-47` (emisión nonce+exp+chainId); `src/infrastructure/auth/pop-nonce-store.ts:42-58` (`claimPopNonceOnce`, `SET NX EX`) | `app/api/a2a/payout/challenge/route.test.ts:35` (200 + HMAC verificable); `src/infrastructure/auth/pop-nonce-store.test.ts:26` (primer uso), `:34` (2º uso → alreadyUsed) |
| **AC-3** (recuperación cripto + rechazo opaco) | ✅ PASS | `app/api/a2a/payout/submit/route.ts:140-143` (P3 address match) + `:149-163` (P5 `verifyMessage`) | `.../submit/route.test.ts:622` (happy — firma real recupera address), `:634` (firma de OTRA key → 403 opaco, suplantación), `:656` (P1 campos ausentes → 403), `:680` (P3 challenge de otra address → 403) |
| **AC-4** (replay/expirado/store-caído fail-closed) | ✅ PASS | `.../submit/route.ts:164-173` (P6 claim, 409/503, `NUNCA forward`) | `.../submit/route.test.ts:696` (replay → 409), `:711` (expirado → 403), `:724` (store down → 503, `unavailable`) |
| **AC-5** (no debilita WKH-202/168) | ✅ PASS | Guard 7 insertado entre guard-6 (autoridad, `:96-114`) y guard-8 (atestación, `:176`); bloque WKH-168 **byte-idéntico** (md5 §1) | `.../submit/route.test.ts:796` (ownership mismatch → 403 `payout_not_authorized` ANTES del guard 7); 44/44 tests de `submit/route.test.ts` verdes incl. los preexistentes de WKH-168/WKH-202; `confirm-and-send.test.ts:626` (`pop` undefined ⇒ submit sin campos, byte-idéntico) |
| **AC-6** (chainId + exp en el mensaje firmado) | ✅ PASS | `src/infrastructure/auth/pop-challenge.ts:53-55` (`buildPopMessage` incluye `chainId`+`expires`); `.../submit/route.ts:144-148` (P4 contra `resolveChainId()`, NUNCA el body) | `.../submit/route.test.ts:737` (challenge de otra cadena → 403), `:752` (mutante body-sourced chainId con 4 valores hostiles → 403 igual, CD-9) |
| **AC-7** (solo viem, cero deps nuevas) | ✅ PASS | `.../submit/route.ts:30` (`import { verifyMessage } from "viem"`); `pop-challenge.ts:14-15` (`node:crypto` + `viem.isAddress`) | Runtime check §1: `grep -c "siwe\|ethers" package.json → 0` |

**7/7 AC PASS.**

---

## 3. Drift detection

- **Scope drift**: NINGUNO — todos los archivos tocados están en Scope IN (§2 SDD/work-item); ninguno de los archivos protegidos por CD-12 (autoridad, atestación, Didit, `validate/route.ts`) fue tocado.
- **Wave drift**: los commits/artefactos siguen el orden documentado en `auto-blindaje.md` (W0 módulo puro → W1 server enforcement → W2 client wiring → fix-pack post-CR). Sin violaciones de orden observables en el working tree.
- **Spec drift (spot-check contra SDD §5.1-§5.5)**: `pop-challenge.ts` (mirror `attestation.ts`), `pop-nonce-store.ts` (mirror `attestation-store.ts`), `challenge/route.ts` (§5.3), guard 7 en `submit/route.ts` (§5.4) — **los 4 coinciden literal** con el contrato del SDD, incluyendo el orden exacto P1→P6 y los status codes 403/409/503.
- **Fix-pack post-CR (2 MENORes) consistente con DT-2**: verificado en código, no solo leído del auto-blindaje —
  - `src/application/ports.ts:182-184` — `PopSigner.prove` tipado `{ challenge; signature } | null`.
  - `src/infrastructure/auth/http-pop-signer.ts:22-23` — `res.status===501 → null` (skip) ANTES de `!res.ok → throw`.
  - `src/application/use-cases/confirm-and-send.ts:229-230` — `this.pop.prove(...)` se invoca **DENTRO** del `try` que abre en `:217` y cuyo `catch` (`:265-272`) degrada vía `failAndRefund(principalReallyIn)` — confirmado que un throw de `prove()` NUNCA escapa `execute()`.
  - CD-15 (2 composition roots + fakes): `container.ts:96-97/114`, `test-container.ts:62/95`, `fakes.ts:249-277` (`FakeWallet.signMessage` + `FakePopSigner`) — los 3 consistentes con la nueva firma de 8 params.
  - Test de la degradación controlada: `confirm-and-send.test.ts:644` (501→null, SKIP, remesa avanza normal) y `:670` (prove() throw en modo real → degrada, NO escapa, NO queda varada en `principal_in`).

**Drift: ninguno bloqueante.**

---

## 4. Gate confirmation

CR/AR reportados por el orquestador como APROBADOS (0 BLQ, 2 MENORes resueltos en fix-pack) — **no existen `cr-report.md`/`ar-report.md` en disco** en este SDD folder (solo `auto-blindaje.md`, que documenta el fix-pack con causa raíz + verificación). QA re-ejecutó igualmente `npm run qa` completo (no solo confió en el reporte verbal) por tratarse de la única fuente disponible de confirmación de gates:

- `tsc --noEmit`: ✅ limpio (ejecución propia)
- `vitest run`: ✅ 397/397 (ejecución propia)

---

## 5. Residuales heredados del SDD (no bloqueantes, ya documentados)

- **R1**: `/api/payout/validate` NO se protegió con PoP en esta HU (decisión DT-9 explícita).
- **R2**: `/challenge` sin rate-limit (solo quema CPU HMAC, no toca el store).
- **R3**: reconciliación server-side de remesa varada = WKH-207 (fuera de scope).

Ninguno de los 3 es un AC de WKH-206; quedan correctamente fuera del veredicto.

---

## Veredicto final

**F4 APROBADO.** 7/7 AC con evidencia archivo:línea + test citado, gates verdes (ejecución propia, no delegada), byte-identidad del bloque WKH-168 confirmada por md5 (no por `git diff`), fix-pack post-CR verificado en código (no solo leído), cero drift de scope, cero archivos prohibidos tocados. Único hallazgo no-bloqueante: verificación de Vercel env vars NO VERIFICABLE por falta de credenciales locales (la branch no está commiteada ni deployada — recomendado confirmar manualmente antes del primer deploy con `PAYOUT_POP_SECRET`/`NEXT_PUBLIC_PAYOUT_POP_ENABLED` en juego).

**Listo para DONE.**
