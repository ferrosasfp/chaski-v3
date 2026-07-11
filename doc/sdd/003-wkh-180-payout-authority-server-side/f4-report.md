# F4 Validation Report — WKH-180 (Autoridad KYC/payout server-side)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-11
**QA**: nexus-qa (F4)
**Nota de proceso**: `ar-report.md`/`cr-report.md` no existen en disco en
`doc/sdd/003-wkh-180-payout-authority-server-side/` (a diferencia de 001/002). Ante su ausencia,
QA verificó de forma independiente por lectura de código los 3 MENORs que el orquestador reportó
como fixeados (AR+CR, 0 BLOQUEANTES) — ver §3. Recomendación: `nexus-docs` debe registrar este
gap de trazabilidad en el done-report.

---

## 1. Runtime Gates (ejecutados por QA, salida real)

| Gate | Comando | Resultado |
|------|---------|-----------|
| Typecheck | `npx tsc --noEmit` | ✅ `TypeScript compilation completed`, exit 0 |
| Tests | `npx vitest run` | ✅ `PASS (99) FAIL (0)` |
| Build | `npm run build` (`next build --webpack`) | ✅ `Compiled successfully` + `Finished TypeScript`. Route table confirma `ƒ /api/payout/validate` (dynamic, server-rendered on demand) — sin edge runtime. |

**Bundle/key leak check** (AC-7/CD-A2, evidencia adicional de QA):
`grep -rn "DIDIT_API_KEY" src/ app/` → única ocurrencia de lectura (`process.env.DIDIT_API_KEY`)
está en `app/api/payout/validate/route.ts:15` (server route) y en `app/api/kyc/*` (preexistente,
WKH-179). El adapter cliente `src/infrastructure/payout/payout-authority-gateway.ts` NO referencia
la env var — solo hace `fetch("/api/payout/validate")`. Confirmado: el key nunca llega al bundle
del browser.

---

## 2. ACs — evidencia archivo:línea

| AC | Texto (resumen EARS) | Status | Evidencia |
|----|----------------------|--------|-----------|
| AC-1 | Re-validar `kycVerificationId` server-side antes de `submit()`, no leer `approved`/`payoutAllowed` del cliente | ✅ PASS | `confirm-and-send.ts:40-49` — `authority.authorize({verificationId: kyc.verificationId, address})` corre tras `confirm()`/save y ANTES de `authorizePrincipal()` (L53)/`submit()` (L60). Nunca lee `kyc.approved`/`kyc.payoutAllowed`. Test: `confirm-and-send.test.ts:86-103` (authority=true → `submit` llamado, regresión) + `route.test.ts:70-76` (Didit Approved → `authorized:true`). |
| AC-2 | NO-Approved o fallo/timeout → bloquear (no `submit()`) + `payout_failed` con razón | ✅ PASS | `route.ts:63-68` (`!res.ok`→502 `kyc_reauth_failed`), `route.ts:73-78` (`status!=="Approved"`→200 `kyc_not_approved`), `route.ts:96-101` (catch de fetch/timeout/JSON malformado→502 `kyc_reauth_failed`). Use-case: `confirm-and-send.ts:45-49` (`!auth.authorized` → `r.markPayoutFailed(...)` + return, sin `submit`). Tests: `route.test.ts:78-100` (Declined/`!res.ok`/throw), `confirm-and-send.test.ts:46-65` (`submitSpy` NOT called, `status==="payout_failed"`). |
| AC-3 | Prod sin key → fail-loud (bloquear, no autorizar por default) | ✅ PASS | `route.ts:26-33` — `isProd && !apiKey` → `503 {authorized:false, reason:"kyc_authority_unavailable"}`, `fetch` no se llama. Test: `route.test.ts:27-36` (`VERCEL_ENV=production` + sin key → 503 + `fetchMock` NOT called). |
| AC-4 | Dev sin key → camino simulado (preserva DX/demo) | ✅ PASS | `route.ts:34-41` — `!isProd && !apiKey` → `200 {authorized:true, reason:"simulated_dev"}`, `fetch` no se llama. Test: `route.test.ts:38-47`. Regresión completa: `confirm-and-send.test.ts:86-103` (`FakePayoutAuthorityGateway({authorized:true})` default → flujo completo a `payout_submitted`). |
| AC-5 | `verificationId` vacío/malformado/ausente → rechazar SIN llamar a Didit | ✅ PASS | `route.ts:45-50` (con key) y `route.ts:35-40` (sin key, rama no-prod) → `400 {authorized:false, reason:"invalid_verification_id"}` antes del `fetch`. Tests: `route.test.ts:50-67` (`""` y ausente, con key, `fetchMock` NOT called). Nota: no hay test explícito de la combinación "sin key + no-prod + id vacío", pero la lógica (`route.ts:35-40`) es idéntica al camino con key — cubierto por inspección, gap menor no bloqueante. |
| AC-6 | KYC forjado en localStorage (`approved:true`) → igual bloquea si server no confirma Approved | ✅ PASS | `confirm-and-send.ts:36-49` — el use-case pasa solo `verificationId`/`address` a `authority.authorize()`, nunca `kyc.approved`; el resultado del server manda siempre. Test explícito: `confirm-and-send.test.ts:67-84` — `KycVerification` con `approved:true, payoutAllowed:true` (forjado) + `authority={authorized:false}` → `status==="payout_failed"`, `submitSpy` NOT called. Override server-side confirmado. |
| AC-7 | Key/fetch a Didit exclusivamente en runtime de servidor; key nunca al bundle cliente | ✅ PASS | `route.ts:15,59-61` (única lectura de `DIDIT_API_KEY` + único `fetch` a Didit, dentro de `app/api/payout/validate/route.ts`, server runtime). Adapter cliente (`payout-authority-gateway.ts`) no referencia la key (grep §1). Build confirma ruta como `ƒ` (server-rendered), no static/edge. Test cero-PII: `route.test.ts:128-146` (respuesta nunca contiene `identity`/`documentNumber`/el key literal). |

**7/7 ACs PASS.**

---

## 3. Verificación del fix-pack (3 MENORs reportados por AR+CR)

| MENOR | Descripción | Verificación QA |
|-------|-------------|------------------|
| MNR-A | `fetch` a Didit sin try/catch → throw/timeout escapaba como 500 crudo en vez de 502 fail-closed | ✅ FIXEADO — `route.ts:58-102`: todo el bloque fetch+mapeo+decisión está en `try {...} catch { return 502 kyc_reauth_failed }` (L96-101). Test dedicado: `route.test.ts:94-100` (`fetch` throw simulando timeout → `502 {authorized:false, reason:"kyc_reauth_failed"}`, "NO 500 crudo"). |
| MNR-B | Residual del ownership check (`vendor_data`/`address` ambos caller-controlados en un endpoint sin sesión firmada) | ✅ DOCUMENTADO (no requería fix de código — residual aceptado explícitamente por AR/CR, consistente con §4.6/§7 del SDD) — `route.ts:82-87`: comentario explícito del alcance real del binding (fuerza completa solo con auth de sesión firmada, fuera de scope) + referencia a follow-up. Coincide con el riesgo ya documentado en `sdd.md:288-297` (tabla de Riesgos). |
| MNR-C | Comentarios de pasos en `confirm-and-send.ts` desactualizados tras insertar el nuevo paso de autoridad | ✅ FIXEADO — `confirm-and-send.ts:51-52`: comentario "Autorizar el principal on-chain... (paso renumerado tras insertar la autoridad server-side WKH-180 como paso 2)" — pasos 1-4 correctamente numerados y consistentes con el flujo real (confirm=1, authority=2, principal=3, submit=4). |

---

## 4. Enforcement — orden confirmado por lectura

`confirm-and-send.ts`:
1. L29 `r.confirm(...)` + L30 `repo.save(r)`.
2. L40-49: `authority.authorize({verificationId, address})` → si `!auth.authorized` → `markPayoutFailed` + `repo.save` + `return r` (**sin** tocar `wallet`/`payouts`).
3. L53 `wallet.authorizePrincipal(quote)` (solo si `auth.authorized === true`).
4. L60 `payouts.submit(...)`.

Confirmado: el check de autoridad corre **después** de `confirm()` y **antes** de `authorizePrincipal()`/`submit()`, exactamente como especifica §4.5/§6 del SDD/Story File. `!authorized` nunca mueve el principal.

---

## 5. Drift Detection

- **Scope**: `git diff`/`git status` muestra exactamente los 11 archivos del Scope IN (§1 Story File) + `doc/sdd/_INDEX.md` (housekeeping esperado) + `src/application/use-cases.test.ts` (ripple de la firma del ctor, documentado y justificado en `auto-blindaje.md:3-16` — no es scope creep, es fix obligado para mantener la suite previa verde). `tsconfig.tsbuildinfo` es artefacto de build, no código.
- **Fuera de scope tocado**: NINGUNO. Verificado explícitamente: `src/domain/remittance.ts`, `src/infrastructure/fallback/gateways.ts`, `app/api/kyc/session/route.ts`, `app/api/kyc/decision/route.ts`, `src/infrastructure/kyc-auth.ts`, `package.json` → sin diff.
- **CD-1** (repo-scope): `git rev-parse --show-toplevel` = `chaski-v2/` — el repo es standalone, ningún archivo fuera de él es alcanzable por este diff.
- **Wave order**: commits no aplicados aún (working tree, pre-commit) — el orden W0→W1→W2→W3 se refleja en la estructura de archivos (ports/decision primero, route/adapter después, enforcement al final), consistente con el plan.
- **Test drift**: los 13 casos del Test Plan (§9 Story File) están todos presentes y mapeados 1:1 a sus ACs (`route.test.ts` 12 casos incl. adapter, `confirm-and-send.test.ts` 4 casos, `decision.test.ts` +1 caso `vendorData`).

**Drift: none** (salvo el ripple documentado y justificado de `use-cases.test.ts`).

---

## 6. Constraint Directives — confirmación

| CD | Check | Resultado |
|----|-------|-----------|
| CD-A1 | Guard-order = misconfig/env-gate → formato → Didit → resultado | ✅ `route.ts:26-102` sigue el orden exacto |
| CD-A2 | Key + fetch a Didit solo en la ruta server | ✅ confirmado (§1, grep) |
| CD-A3 | `address: string` no-opcional | ✅ `ports.ts` (`authorize(input:{verificationId:string; address:string})`), `confirm-and-send.ts:43` (`address ?? ""`) |
| CD-A4 | Adapter fail-closed | ✅ `payout-authority-gateway.ts:10-25` try/catch, nunca `authorized:true` por default |
| CD-A5 | Reusa `mapDiditDecision` | ✅ `route.ts:70` |
| CD-A6 | `isProd()` = `VERCEL_ENV==="production"` | ✅ `route.ts:16`, sin env var custom nueva |
| CD-1 | Solo `chaski-v2/` | ✅ (repo-scope) |
| CD-2 | Booleanos del browser no autorizan | ✅ (§4, AC-6) |
| CD-4 | Prod sin key ≠ autorización silenciosa | ✅ (AC-3, 503 explícito) |
| CD-A7 | `FallbackPayoutGateway`/`kyc/session`/`kyc/decision` intactos; `decision.ts` aditivo | ✅ sin diff en esos archivos; `decision.ts` solo agrega `vendorData`/`vendor_data?` |
| CD-A8 | Cero PII en `/api/payout/validate` | ✅ test `route.test.ts:128-146` |
| CD-A9 | Sin deps nuevas | ✅ `package.json` sin diff |
| CD-A10 | Enforcement en use-case, no en dominio | ✅ `remittance.ts` sin diff, check vive en `confirm-and-send.ts` |
| CD-11 | `noUncheckedIndexedAccess` respetado | ✅ `tsc --noEmit` 0 errores |

---

## 7. Regresión (demo dev sin key)

Cubierta por `route.test.ts:38-47` (ruta) + `confirm-and-send.test.ts:86-103` (use-case, `authority={authorized:true}` default → `payout_submitted`) + `confirm-and-send.test.ts:105-117` (`settled`). No hay entorno Vercel real disponible para QA en esta sesión (solo lectura/build local) — la regresión de UI end-to-end ("Entregado" en pantalla) queda como smoke manual post-merge:

```
1. correr `npm run dev` sin DIDIT_API_KEY en .env.local
2. completar flujo de remesa hasta confirmar
3. verificar que llega a estado "Entregado"/"Enviado" (payout_submitted/settled)
4. confirmar en Network tab que POST /api/payout/validate devuelve 200 {authorized:true, reason:"simulated_dev"}
```

---

## 8. Veredicto

**APROBADO PARA DONE.** 7/7 ACs con evidencia archivo:línea, 3 gates runtime verdes (tsc/vitest/build,
salida real pegada arriba), 3/3 MENORs del fix-pack verificados en código (2 fixeados + 1 documentado
como residual aceptado), enforcement server-side confirmado en el orden correcto, drift ninguno
(salvo ripple justificado), 14/14 CDs cumplidos. Único hallazgo de proceso: faltan `ar-report.md`/
`cr-report.md` en disco — no bloquea DONE pero `nexus-docs` debe dejarlo anotado.
