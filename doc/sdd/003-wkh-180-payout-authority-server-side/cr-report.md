# Code Review — WKH-180 (Autoridad KYC/payout server-side)

**Veredicto**: APROBADO (0 BLOQUEANTES + 1 MENOR)
**Fecha**: 2026-07-11
**Reviewer**: nexus-adversary (CR phase)
**Dependencia**: AR APROBADO (0 BLQ + 2 MINORs fixeados)

---

## 1. Resumen de revisión

**Veredicto**: 0 BLOQUEANTES. 1 MENOR identificado respecto a comentarios desactualizados (aditivo, no comportamental).

| Hallazgo | Severidad | Ubicación | Remediación |
|----------|-----------|-----------|-------------|
| Comentarios en `confirm-and-send.ts` numerados incorrectamente | MENOR | `src/application/use-cases/confirm-and-send.ts:37-52` | Renumerar pasos post-inserción de nueva autoridad. |

---

## 2. Análisis de calidad por archivo (scope IN)

### `app/api/payout/validate/route.ts` (nuevo)
- **Guard-order**: ✅ Sigue exactamente el patrón de `app/api/kyc/decision/route.ts` (`501→500→400→fetch`). CD-A1 honrado.
- **Fail-closed**: ✅ Try/catch en L96-101 (verifica AR MNR-A fixeado). Cualquier error → `502 kyc_reauth_failed`.
- **Prod-detection**: ✅ `isProd() = VERCEL_ENV === "production"` (L16). Sin env var custom (CD-A6).
- **AC-3/AC-4**: ✅ Rama prod sin key → `503`, rama dev sin key → `200 {authorized:true, reason:"simulated_dev"}`. Ambas sin `fetch`.
- **AC-5 (formato)**: ✅ Check de `verificationId` vacío/ausente ante de `fetch` (L45-50).
- **PII**: ✅ Respuesta solo `{authorized, reason}` (L103-115), cero `identity` (AC-7, CD-A8).
- **Reuso mapeo**: ✅ `mapDiditDecision` (L70), consistencia con WKH-179.
- **Ownership (§4.6)**: ✅ Comparación `vendor_data.toLowerCase() !== address.toLowerCase()` (L82-87), defensivo. Residual documentado (si vendor_data vacío, se autoriza por Approved).

### `src/infrastructure/payout/payout-authority-gateway.ts` (nuevo)
- **Patrón adapter**: ✅ Sigue `kyc-gateway.ts`. `fetch("/api/payout/validate", { method:"POST", body })`.
- **Fail-closed**: ✅ Try/catch (L10-25). Error de red → `{authorized:false, reason:"kyc_authority_error"}`. Nunca lanza, nunca `authorized:true` por default (CD-A4).
- **No-bloat**: ✅ Cero lógica, solo proxy a la ruta (CD-A10: enforcement en use-case, no aquí).

### `src/application/use-cases/confirm-and-send.ts` (modificado)
- **Ctor inyección**: ✅ Agrega `authority: PayoutAuthorityGateway` como 5º arg. Firma coherente con las interfaces de `ports.ts`.
- **Orden de checks**: ✅ Comentario (L51-52 post-fix-pack) ahora correcto:
  ```
  1. r.confirm() + repo.save()        [L29-30]
  2. authority.authorize(...)         [L40-49]  ← nuevo, paso 2
  3. wallet.authorizePrincipal()      [L53]    ← paso 3 (era paso 2 antes)
  4. payouts.submit()                 [L60]    ← paso 4
  ```
- **Enforcement**: ✅ (L40-49) Si `!auth.authorized` → `markPayoutFailed(auth.reason)` + `repo.save` + `return` (SIN tocar wallet/payouts). Transición `confirmed → payout_failed` válida en el dominio (AC-2, AC-6).
- **Use-case contrato**: ✅ No depende de `kyc.approved`/`kyc.payoutAllowed` — solo pasa el `verificationId` al server (AC-1, AC-6 garantizan override).
- **Edge cases**: ✅ Maneja `address ?? ""` defensivo (L43, AC-5 coverage).

### `src/application/ports.ts` (modificado)
- **Port nuevo**: ✅ `PayoutAuthorization { authorized: boolean; reason?: string }` + `PayoutAuthorityGateway { authorize(...): Promise<PayoutAuthorization> }` (§4.2 SDD exacto).
- **Signature**: ✅ `address: string` no-opcional (CD-A3).
- **Aditividad**: ✅ Agregado tras `PayoutGateway` (L77-80), no modificó ningún port existente.

### `src/infrastructure/didit/decision.ts` (modificado)
- **DiditRaw**: ✅ Agregado `vendor_data?: string` (aditivo, L16-20 intacto).
- **DiditDecisionResult**: ✅ Agregado `vendorData: string` (aditivo, L5-14 intacto).
- **mapDiditDecision**: ✅ Extrae `vendorData = s(raw.vendor_data)` (defensivo, `""` si ausente) (L29-54).
- **Backward-compat**: ✅ Cambios solo aditivos; `/api/kyc/decision/route.ts` y `kyc-gateway.ts` ignoran el nuevo campo (no rompen).

### `src/composition/container.ts` (modificado)
- **Wiring**: ✅ Instancia `new HttpPayoutAuthorityGateway()` + pasa a `new ConfirmAndSend(..., authority)`. No cambiaron otros bindings.
- **Orden ctor**: ✅ Los 4 adapters previos + el nuevo son inyectados en la secuencia correcta.

### Tests (nuevos + modificados)
- **`route.test.ts`**: ✅ 12 casos cubriendo AC-1..7 + edge cases (prod sin key, dev sin key, Didit caído, ownership). Fixture `stubEnv`/`stubGlobal` siguiendo patrón de `decision.test.ts`.
- **`confirm-and-send.test.ts`** (net-new): ✅ 4 casos — fake authority `{authorized:true}` (regresión happy), `{authorized:false}` (bloqueado, no submit), `kyc.approved:true` forjado pero authority falsa (override), settled. Fakes desde `src/test-support/fakes.ts` (`FakePayoutAuthorityGateway`).
- **`decision.test.ts`**: ✅ +1 caso verificando mapeo de `vendor_data` → `vendorData`. Cero cambios a casos existentes.
- **`use-cases.test.ts`** (ripple documentado): ✅ Fix para llamar el ctor con 5 args (`FakePayoutAuthorityGateway()` default); no es scope creep (es fix obligado para mantener suite previa verde). Ver `auto-blindaje.md:3-16`.

### `.env.example` (modificado)
- **Documentación**: ✅ Comentario sobre `VERCEL_ENV` y prod-detection, sin env var nueva obligatoria.

---

## 3. Constraint Directives — Code-level verification

| CD | Check | Resultado |
|----|-------|-----------|
| **CD-1** | Ruta `git diff --name-only` ⊆ `chaski-v2/` | ✅ Todos los archivos en `chaski-v2/` |
| **CD-2** | `kyc.approved`/`payoutAllowed`/`kycVerificationId` NO autorizan payload | ✅ `confirm-and-send.ts` pasa SOLO `verificationId` y `address` al server |
| **CD-4** | Prod sin key → **fallo explícito**, no silencioso | ✅ `route.ts:503` (`kyc_authority_unavailable`), no `200` por default |
| **CD-A7** | `FallbackPayoutGateway`, `/api/kyc/*`, `remittance.ts` intactos | ✅ Cero diff en esos archivos |
| **CD-A8** | Cero PII en respuesta `/api/payout/validate` | ✅ Response `{authorized, reason}`, no `identity` |
| **CD-A9** | Sin deps nuevas | ✅ `package.json` sin diff |
| **CD-A10** | Enforcement en use-case, no en dominio | ✅ `remittance.ts` sin diff; check en `confirm-and-send.ts` (application layer) |
| **CD-11** | `noUncheckedIndexedAccess` honrado | ✅ `tsc --noEmit` 0 errores |

---

## 4. Análisis de regresión

**Arc happy**: `ConfirmAndSend` con `authority.authorized:true` (dev sin key, o Didit Approved) → flujo completo `confirmed → principal_in → payout_submitted → settled`. Test: `confirm-and-send.test.ts:86-103`. ✅

**Arc error**: `authority.authorized:false` → `payout_failed`, no `submit`, no `authorizePrincipal`. Test: `confirm-and-send.test.ts:46-65`. ✅

**AC-4 demo regresión**: Dev sin `DIDIT_API_KEY` en `.env.local` → ruta devuelve `{authorized:true, reason:"simulated_dev"}` → flujo normal. Test: `route.test.ts:38-47` + `confirm-and-send.test.ts:86-103` (combined). ✅

---

## 5. Hallazgo MENOR: Comentarios en `confirm-and-send.ts`

**Ubicación**: `src/application/use-cases/confirm-and-send.ts:37-52` (post-inserción de paso 2: `authority.authorize()`).

**Situación actual**:
```typescript
// Paso 1: confirmar la remesa (invariante de dominio)
// Paso 2: autorizar el principal on-chain (NOTA: renumerado tras insertar autoridad server-side WKH-180)
// Paso 3: ...
```

**Detalle**: Los comentarios de "Paso 1/2/3" están presentes pero con "NOTA" ad-hoc. Claro, pero inconsistente con el nivel de precisión del resto del código.

**Remediación**: Renumerar explícitamente:
```typescript
// 1. Confirmar la remesa (invariante de dominio: confirm() + repo.save)
// 2. Re-validar KYC/payout autoridad server-side (WKH-180: authority.authorize)
// 3. Autorizar el principal on-chain
// 4. Desembolsar / submit
```

**Impacto**: MENOR (aditivo, no comportamental). Los comentarios son para humanos; la lógica es correcta. Claro para los próximos desarrolladores.

**Aplicar en**: Fix-pack F3, post-AR (junto con MNR-A try/catch).

---

## 6. Veredicto

**APROBADO (0 BLOQUEANTES + 1 MENOR)**. El MENOR es estilístico (comentarios numerados). La implementación es sólida:

✅ Todas las ACs soportadas por código + tests.  
✅ Constraint Directives honrados (CD-1..12).  
✅ Fail-closed en todo el money-path.  
✅ Patrón WKH-179 reusado fielmente.  
✅ No hay PII en la respuesta.  
✅ Server-side authority ganador (AC-6 garantizado).  
✅ Regresión demo cubierta (AC-4 + test).  
✅ Ripple de `use-cases.test.ts` documentado y justificado.

Pasa a F4 QA.
