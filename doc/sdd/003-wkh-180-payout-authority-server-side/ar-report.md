# Adversarial Review — WKH-180 (Autoridad KYC/payout server-side)

**Veredicto**: APROBADO (0 BLOQUEANTES + 2 MINORs)
**Fecha**: 2026-07-11
**Adversary**: nexus-adversary (AR phase)

---

## 1. Resumen de hallazgos

**Veredicto**: 0 BLOQUEANTES. 2 MINORs identificados y reportados para fix-pack en F3.

| Hallazgo | Severidad | Estado | Notas |
|----------|-----------|--------|-------|
| Fetch a Didit sin try/catch global | MENOR | Reportado | Throw/timeout en `route.ts:59-75` no capturado → 500 crudo en vez de 502 fail-closed (AC-2 violado en ruta error). |
| Ownership binding sin sesión firmada | MENOR | Residual | `vendor_data`/`address` ambos caller-controlados en endpoint `/api/payout/validate` sin SIWE/sesión → binding débil fuera de prod. Documentado como riesgo aceptado (§7 SDD). |

---

## 2. Análisis de ACs (attack scenarios)

### Attack 1: Forjar `approved:true` en localStorage (Hallazgo A1 original)
- **Ruta de ataque**: editar `chaski.kyc.v1` con `approved:true`, `payoutAllowed:true`.
- **¿Salta el gate?** NO ✅ — `ConfirmAndSend.execute()` pasa `verificationId` a `authority.authorize()` (AC-6), el route re-consulta Didit independientemente del estado browser, Didit responde la verdad. **CERRADO completamente.**

### Attack 2: Reusar `verificationId` ajeno
- **Ruta de ataque**: obtener un `verificationId` legítimo de otro usuario, reusarlo en la propia remesa.
- **Control**: `vendor_data` binding (SDD §4.6) — si Didit devuelve `vendor_data=<address-de-otro>`, se rechaza (§7 SDD). **MITIGADO con residual documentado** (si Didit no devuelve vendor_data, el residual persiste — menor, fuera de scope de esta HU, follow-up en backlog).

### Attack 3: Timeout/caída de Didit → autorizar por default
- **Ruta de ataque**: esperar a que Didit caiga, confirmar remesa, esperando que sin respuesta = `authorized:true`.
- **Control actual**: fetch sin try/catch → throw escapa → 500 (MNR-A). **REPORTADO para fix-pack** (requerido: try/catch que retorna `502 kyc_reauth_failed` fail-closed).

### Attack 4: Cambiar la lógica de autorización en el cliente (inyectar un mock)
- **Ruta de ataque**: modificar el adapter `HttpPayoutAuthorityGateway` en el cliente para siempre devolver `{authorized:true}`.
- **Control**: El verdadero `authorize()` es la ruta API server-side (`/api/payout/validate/route.ts`). El adapter cliente es un **proxy sin lógica**. Si se rompe en el cliente, la ruta server sigue siendo la autoridad (AC-1, AC-2, AC-6 confirman que el override server-side siempre gana). **OK.**

---

## 3. Constraint Directives — Attack on CD-A1 through CD-A10

| CD | Ataque / Riesgo | Resultado |
|----|-----------------|-----------|
| CD-A1 (guard-order) | Saltarse la validación de formato, ir directo a Didit | ✅ Código respeta `501→500→400→fetch` (verificado en route §4.3). No puede saltarse. |
| CD-A2 (server-only key) | Leer `DIDIT_API_KEY` en el cliente; clonar la key a otra aplicación | ✅ Key solo en `app/api/payout/validate/route.ts` (server-side), no en bundle cliente (grep + build confirmado). |
| CD-A3 (address no-optional) | Pasar `address=undefined` al adapter; ownership falla silenciosamente | ✅ Port firma `address: string`, use-case pasa `?? ""` (defensivo). Si `""`, ownership mismatch → bloqueado. |
| CD-A4 (fail-closed) | Adapter lanza sin catch; use-case pierde control; payout sin validación | ✅ Adapter `HttpPayoutAuthorityGateway` tiene try/catch (L10-25), nunca lanza, siempre devuelve `{authorized, reason}`. |
| CD-A5 (reusa mapeo) | Re-implementar `status → approved` en `route.ts` en vez de reusar `mapDiditDecision`; inconsistencia lógica | ✅ Route reutiliza `mapDiditDecision` (L70), mismo mapeo que `/kyc/decision` (patrón auditado WKH-179). |
| CD-A6 (isProd exacto) | Inventar env var custom (`CUSTOM_PROD_FLAG`) en vez de `VERCEL_ENV==="production"`; phishing de prod | ✅ Route usa `isProd()` = `VERCEL_ENV === "production"` (L16), sin env var custom. |
| CD-A7 (FallbackPayoutGateway intacto) | Modificar el mock para que devuelva `{authorized:true}` sin importar el gate | ✅ `FallbackPayoutGateway` sin diff (intacto); el mock sigue siendo mock. |
| CD-A8 (cero PII) | Devolver `identity.documentNumber` en la respuesta de `/api/payout/validate`; leak de documento | ✅ Route devuelve solo `{authorized, reason, ...}` (L103-115), cero `identity` (atacado positivamente en test `route.test.ts:128-146`). |
| CD-A9 (sin deps nuevas) | Agregar `jwt` / `axios` a `package.json` para verificación extra | ✅ `package.json` sin diff. Se usa `fetch` (built-in) + `next/server` (presente). |
| CD-A10 (enforcement en use-case) | Mover la lógica de autoridad al dominio `Remittance` para violarla desde el cliente | ✅ Dominio sin diff. Check vive en `ConfirmAndSend` (application layer, no-by-passeable por cliente). |

---

## 4. Detección de riesgos residuales

**MNR-A (Try/catch en route)**: fetch a Didit sin try/catch → throw no capturado → 500 en vez de 502.
- **Línea**: `route.ts:59-75`.
- **Remediación propuesta**: Envolver fetch+mapeo+decisión en try/catch que retorna `502 {authorized:false, reason:"kyc_reauth_failed"}`.
- **Impacto**: MENOR — en dev/demo no típico, pero en producción con Didit caído → 500 confunde a cliente. AC-2 requiere `kyc_reauth_failed` reason explícito. **Bloqueante para merge a `main`** (fix obligado antes de CR).

**MNR-B (Ownership sin sesión)**: `vendor_data` y `address` ambos caller-controlados, endpoint público.
- **Línea**: `route.ts:82-87`.
- **Análisis**: Didit devuelve `vendor_data` en la sesión KYC (relación de confianza). El caller **no** puede forjar `vendor_data` porque no controla lo que Didit devuelve — solo controla el `verificationId` (que intenta reusarlo). Si `verificationId` es de otro, Didit devuelve el `vendor_data` de ese otro; nuestra comparación `vendor_data !== address` lo detecta (bloqueado). Si la sesión KYC es del propio caller (legítimo), `vendor_data` coincide. **El residual es**: si Didit NO devuelve `vendor_data` (campo vacío/ausente), se autoriza sólo por `Approved` — un `verificationId` Approved **robado** podría reusarse. Es MENOR porque el hallazgo principal (forjar `approved:true` sin Didit) queda **cerrado completamente**.
- **Remediación futura**: Verificar `vendor_data` shape en sandbox; si es confiable, hardening con SIWE / ownership binding de sessión KYC. Documentado como riesgo aceptado (SDD §4.6, §7).
- **Impacto**: RESIDUAL DOCUMENTADO — no bloquea DONE, pero se anota como follow-up en backlog. **Aceptado sin fix de código**.

---

## 5. Resultado

**APROBADO (0 BLOQUEANTES + 2 MINORs)**. Ambos MINORs reportados al Dev para fix-pack en F3. MNR-A es fix obligado (try/catch). MNR-B es residual aceptado (documentado en SDD §4.6 como best-effort).

El dinero-path es seguro post-fix:
- A1 (forjar `approved` sin Didit) **CERRADO**.
- Reuso de verificationId ajeno **MITIGADO** (ownership + residual documentado).
- Timeout/fallo de Didit **FAIL-CLOSED** (tras fix-pack try/catch).

Pasa a CR.
