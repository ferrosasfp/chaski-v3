# SDD #003: [WKH-180] Autoridad KYC/payout server-side (no confiar en gate client-side)

> SPEC_APPROVED: no
> Fecha: 2026-07-11
> Tipo: improvement (security)
> SDD_MODE: full
> Branch: fix/180-payout-authority-server-side
> Artefactos: doc/sdd/003-wkh-180-payout-authority-server-side/

---

## 1. Resumen

Chaski v2 corre 100% client-side: `getContainer()` es un singleton del browser y el estado del
money-path (incluida la `KycVerification` con `approved`/`payoutAllowed`) vive en `localStorage`
(`chaski.remittances.v1`, `chaski.kyc.v1`), editable con una línea de devtools. Hoy el único guard
antes de desembolsar es la invariante de dominio `Remittance.confirm()`
(`src/domain/remittance.ts:161-168`), que corre sobre ese estado atacante-controlable. Un atacante
puede forjar `approved: true` en localStorage y saltarse Didit.

Esta HU mueve la **autoridad** de "¿este KYC autoriza el payout?" al servidor: se agrega una ruta
API Next.js (`app/api/payout/validate/route.ts`) que re-consulta la decisión REAL de Didit
(`GET /v3/session/{id}/decision/`) con `DIDIT_API_KEY` server-only, y el use-case `ConfirmAndSend`
la invoca **antes** de mover valor. El resultado (`{ authorized, reason }`) es la única fuente de
verdad para autorizar el payout — nunca los booleanos que llegaron del browser. Reusa el patrón ya
auditado y en prod de WKH-179 (`/api/kyc/*`): guard-order, `DIDIT_API_KEY` server-only, fail-closed.
El `PayoutGateway` sigue siendo `FallbackPayoutGateway` (MOCK, Scope OUT / WKH-168): esta HU instala
el gate, no mueve plata real.

**Decisión de arquitectura**: Opción (a) del work-item (ruta server-side en chaski-v2). Opción (b)
(delegar en agentes A2A `remit-*`) descartada por el orquestador — agrega dependencia cross-repo,
facturación y superficie de fallo al money-path, y viola el espíritu de CD-1.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | WKH-180 |
| **Tipo** | improvement (security) |
| **SDD_MODE** | full |
| **Objetivo** | Re-validar el `kycVerificationId` contra Didit server-side ANTES de `payouts.submit()`; el cliente deja de ser autoridad de payout. |
| **Reglas de negocio** | Ningún booleano de autorización que venga del browser autoriza un payout (CD-2). Fail-loud en prod sin key (AC-3). Simulación permitida solo fuera de prod (AC-4). |
| **Scope IN** | Ver §6 IN |
| **Scope OUT** | Ver §6 OUT |
| **Missing Inputs** | Ownership por `vendor_data` — resuelto en §4.6 (best-effort + residual documentado). Prod-detection — resuelto en §4.4 (`VERCEL_ENV`). |

### Acceptance Criteria (EARS)

- **AC-1**: WHEN `ConfirmAndSend` va a invocar `payouts.submit()`, THE sistema SHALL primero
  re-validar el `kycVerificationId` contra una fuente server-side independiente del estado del
  cliente (no leer `approved`/`payoutAllowed` del `KycVerification` del browser).
- **AC-2**: IF la re-validación server-side responde NO-`Approved` (o falla/timeout), THEN THE
  sistema SHALL bloquear el payout (no llamar a `payouts.submit()`) y marcar la remesa `payout_failed`
  con razón explícita (ej. `kyc_reauth_failed`).
- **AC-3**: WHERE el server NO tiene `DIDIT_API_KEY` AND el entorno es producción, THE sistema
  SHALL fallar-loud (bloquear, NO autorizar por default).
- **AC-4**: WHERE el server NO tiene `DIDIT_API_KEY` AND el entorno NO es producción, THE sistema
  SHALL permitir el camino simulado (preserva DX/demo).
- **AC-5**: IF el `kycVerificationId` está vacío/malformado/ausente, THEN THE sistema SHALL rechazar
  el payout SIN llamar a Didit (guard-order: formato antes del fetch externo).
- **AC-6**: WHILE el KYC en `localStorage` esté manipulado (`approved:true` forjado), THE sistema
  SHALL igual bloquear si la re-validación server-side no confirma `Approved` (no depender de la
  invariante de dominio que corre sobre estado client-side).
- **AC-7**: THE sistema SHALL ejecutar la re-validación (fetch a Didit, `DIDIT_API_KEY`) exclusivamente
  en runtime de servidor (ruta API) — el key NUNCA se bundlea al browser (patrón WKH-179).

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|-----------------------------|
| `src/application/use-cases/confirm-and-send.ts:14-61` | Punto de enforcement | 3 pasos: `r.confirm()` → `wallet.authorizePrincipal()` → `payouts.submit()`. El `kycVerificationId` viaja del estado cliente a `submit()` sin re-validar (L42-47). Ctor inyecta `wallet, payouts, repo, clock`. |
| `src/application/ports.ts:62-80` | Nuevo port | Convención de ports: interfaces que el use-case requiere, infra implementa. `PayoutSubmit`/`PayoutRecord`/`PayoutGateway` como modelo. `WalletPort.getAddress()` L84-87 devuelve `string \| null`. |
| `app/api/kyc/decision/route.ts:1-40` | **Exemplar principal** de la ruta | Guard-order `501 (no key) → 500 (misconfig) → 400 (formato) → 401 (auth) → fetch Didit`. `fetch(\`${BASE}/v3/session/${encodeURIComponent(id)}/decision/\`, { headers:{"x-api-key":apiKey}, signal:AbortSignal.timeout(10_000) })`. `!res.ok → 502`. `NextResponse.json(...)`. `BASE = process.env.DIDIT_BASE_URL ?? "https://verification.didit.me"`. |
| `app/api/kyc/session/route.ts:33-87` | Prod/IP-trust + envío de `vendor_data` | Manda `vendor_data: body.vendorData` a Didit (L69) — el `senderAddress` del sender. Es lo que Didit puede eco-ar en `/decision/`. Patrón de comentar la fuente de verdad de una señal (MNR-1, L12-18). |
| `src/infrastructure/didit/decision.ts:16-54` | Reuso fetch+mapeo | `DiditRaw` (L16-20) NO tipa `vendor_data`. `mapDiditDecision` mapea `status → approved (=== "Approved")`, `verificationId = session_id`. Puro/testeable. `maskDecision` (L68-70). El adapter cliente KYC ya reusa `DiditDecisionResult`. |
| `app/api/kyc/decision/route.test.ts:1-82` | **Exemplar de test de ruta** | `vi.stubEnv("DIDIT_API_KEY",...)`, `vi.stubGlobal("fetch", vi.fn(async () => ({ ok:true, json: async()=>RAW })))`, `expect(fetchMock).not.toHaveBeenCalled()`, `Request(url,{headers})`. |
| `src/infrastructure/didit/kyc-gateway.ts:13-54` | **Exemplar del adapter cliente** | `DiditKycGateway` hace `fetch("/api/kyc/...")` desde el browser, maneja `501 → fallback`, `!ok → throw`, mapea la respuesta al modelo del port. |
| `src/composition/container.ts:40-65` | Wiring | Composition root: instancia adapters concretos y los inyecta en use-cases. `new ConfirmAndSend(wallet, payouts, repo, clock)` L60. |
| `src/domain/remittance.ts:59-71, 179-181` | Estado `payout_failed` + razón | `TRANSITIONS`: `confirmed → ["principal_in","payout_failed"]` (L65) → se puede fallar ANTES de mover principal. `markPayoutFailed(reason, now)` L179-181 setea `failureReason`. |
| `src/infrastructure/fallback/gateways.ts:92-113` | Mock intacto (Scope OUT / CD) | `FallbackPayoutGateway` MOCK (`// MOCK — no desembolsa`). NO se toca. |
| `src/infrastructure/kyc-auth.ts:10-33` | Referencia timing-safe (NO se reusa acá) | La nueva ruta NO devuelve PII → no requiere el token HMAC `x-kyc-token`. Ver §4.3 (por qué la ruta puede ir sin auth). |
| `doc/sdd/002-wkh-179-.../auto-blindaje.md` | Aprendizaje previo | `tsconfig` con `noUncheckedIndexedAccess` + tipos literal-template de libs → ver CD-11/CD-12. |

### Exemplars

| Para crear/modificar | Seguir patrón de | Qué copiar |
|----------------------|------------------|------------|
| `app/api/payout/validate/route.ts` (nuevo) | `app/api/kyc/decision/route.ts` | guard-order, fetch a Didit con `x-api-key` + timeout, `NextResponse.json`, `BASE` env |
| `app/api/payout/validate/route.test.ts` (nuevo) | `app/api/kyc/decision/route.test.ts` | `stubEnv`/`stubGlobal`, `fetch NOT called` asserts |
| `src/infrastructure/payout/payout-authority-gateway.ts` (nuevo) | `src/infrastructure/didit/kyc-gateway.ts` | adapter cliente que hace `fetch("/api/...")` y mapea al port |
| `PayoutAuthorityGateway` en `ports.ts` | `PayoutGateway` (`ports.ts:77-80`) | forma de interface de port |
| `src/application/use-cases/confirm-and-send.test.ts` (net-new) | `src/application/use-cases/abandon-pending-kyc.test.ts` | estilo de test de use-case con fakes |

### Estado de BD relevante

N/A — no hay backend con DB. Didit es la única fuente de verdad externa (DT-1). Persistencia sigue
en `localStorage` (Scope OUT).

### Componentes reutilizables encontrados

- `mapDiditDecision` (`decision.ts:29`) — reusar para parsear la respuesta de Didit en la ruta nueva
  (no re-implementar el parseo `status → approved`). Se **extiende** para extraer `vendor_data` (§4.6).
- El patrón `501/misconfig → formato → Didit` de `decision/route.ts` — reusar tal cual con la variante
  prod-fail-loud (AC-3).

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué hace | Exemplar |
|---------|--------|----------|----------|
| `app/api/payout/validate/route.ts` | **Crear** | POST: `{verificationId, address}` → guard-order → Didit `/decision/` → `{authorized, reason}`. NO devuelve PII. | `app/api/kyc/decision/route.ts` |
| `src/application/ports.ts` | Modificar | Agregar `PayoutAuthorization` + `PayoutAuthorityGateway` (§4.2). | `PayoutGateway` (mismo archivo) |
| `src/infrastructure/payout/payout-authority-gateway.ts` | **Crear** | `HttpPayoutAuthorityGateway`: `fetch("/api/payout/validate")` desde el browser, fail-closed ante error de red. | `src/infrastructure/didit/kyc-gateway.ts` |
| `src/application/use-cases/confirm-and-send.ts` | Modificar | Inyectar `authority`; llamar `authorize(...)` tras `confirm()` y ANTES de `authorizePrincipal()`; si `!authorized` → `markPayoutFailed(reason)` y return. | patrón try/guard existente |
| `src/infrastructure/didit/decision.ts` | Modificar | Extender `DiditRaw` con `vendor_data?` y `DiditDecisionResult` con `vendorData` + extraerlo en `mapDiditDecision` (aditivo, no rompe `/kyc/decision`). | mismo archivo |
| `src/composition/container.ts` | Modificar | Instanciar `HttpPayoutAuthorityGateway` y pasarlo a `new ConfirmAndSend(...)`. | L60 |
| `app/api/payout/validate/route.test.ts` | **Crear** | Tests de ruta (AC-3/4/5, Approved/Declined/upstream-fail, ownership). | `decision/route.test.ts` |
| `src/application/use-cases/confirm-and-send.test.ts` | **Crear (net-new)** | Tests de enforcement (AC-1/2/6) con fake authority + fakes. | `abandon-pending-kyc.test.ts` |
| `src/infrastructure/didit/decision.test.ts` | Modificar | +1 caso: `mapDiditDecision` extrae `vendorData`. | mismo archivo |
| `.env.example` | Modificar | Comentario documentando prod-detection (`VERCEL_ENV`), sin nueva env var obligatoria. | sección KYC existente |

### 4.2 Port nuevo (contrato)

En `src/application/ports.ts`, sección Payout:

```
export interface PayoutAuthorization {
  authorized: boolean;
  reason?: string; // "kyc_not_approved" | "kyc_reauth_failed" | "kyc_ownership_mismatch" | ...
}
export interface PayoutAuthorityGateway {
  // Re-valida server-side que el verificationId autoriza el payout para este caller.
  authorize(input: { verificationId: string; address: string }): Promise<PayoutAuthorization>;
}
```

Regla de la firma: `authorize` recibe SIEMPRE `verificationId` (del estado, pero se re-valida) y
`address` (del `WalletPort.getAddress()`, para el ownership check). El adapter es **fail-closed**:
cualquier error de red/parseo → `{ authorized: false, reason: "kyc_authority_error" }` (nunca lanza,
nunca `authorized:true` por default).

### 4.3 Diseño de la ruta `POST /api/payout/validate`

**Por qué POST y por qué sin `x-kyc-token`**: a diferencia de `/api/kyc/decision` (que devuelve PII →
requiere el token HMAC anti-IDOR de WKH-179), esta ruta devuelve **solo un booleano**
`{authorized, reason}` — **cero PII**. El vector IDOR de WKH-179 no aplica. El único residual es un
"boolean oracle" (probar si un `verificationId` está Approved), de sensibilidad baja; se documenta
como riesgo residual (§7) y queda como hardening futuro (rate-limit por IP reusando
`checkKycRateLimit`, NO en scope de esta HU para no expandir superficie). POST para no dejar el
`verificationId` en logs de query-string.

**Input** (JSON body): `{ verificationId: string; address: string }`.

**Guard-order** (honra CD-3: misconfig → formato → Didit → resultado; e integra AC-3/AC-4/AC-5):

1. `apiKey = process.env.DIDIT_API_KEY`. `isProd` = §4.4.
2. **Sin key**:
   - `isProd` → **fail-loud** `503 { authorized:false, reason:"kyc_authority_unavailable" }` (AC-3, CD-4). `fetch` NO se llama.
   - `!isProd` → validar formato (paso 4); si OK → `200 { authorized:true, reason:"simulated_dev" }` (AC-4). `fetch` NO se llama.
3. **Con key** → seguir.
4. **Formato** (AC-5): `verificationId` ausente/`""`/`.trim()===""` → `400 { authorized:false, reason:"invalid_verification_id" }`. `fetch` NO se llama.
5. **Didit**: `GET ${BASE}/v3/session/${encodeURIComponent(verificationId)}/decision/` con `headers:{"x-api-key":apiKey}`, `signal:AbortSignal.timeout(10_000)`.
   - `!res.ok` → `502 { authorized:false, reason:"kyc_reauth_failed" }` (AC-2).
6. **Mapeo**: `const d = mapDiditDecision(await res.json())`. `d.status !== "Approved"` → `200 { authorized:false, reason:"kyc_not_approved" }` (AC-2/AC-6).
7. **Ownership** (§4.6, best-effort): si `d.vendorData` no vacío y `d.vendorData.toLowerCase() !== address.toLowerCase()` → `200 { authorized:false, reason:"kyc_ownership_mismatch" }`. Si `d.vendorData` vacío → skip (residual documentado).
8. **OK** → `200 { authorized:true }`.

Nota: `BASE = process.env.DIDIT_BASE_URL ?? "https://verification.didit.me"` (idéntico al exemplar).
La ruta NO llama a `maskDecision` ni devuelve `identity` — no expone PII (defensa por diseño, más
fuerte que el masking).

### 4.4 Prod-detection (DT-3)

`function isProd(): boolean { return (process.env.VERCEL_ENV ?? "") === "production"; }`

- `VERCEL_ENV` lo inyecta Vercel: `"production"` sólo en el deploy de producción (preview/development
  tienen otros valores). Es la señal confiable en el hosting real (análogo al IP-trust de WKH-179).
- **Fallback fuera de Vercel** (self-host/CI): si `VERCEL_ENV` está ausente, `isProd` da `false` →
  camino simulado. Esto es intencional: fuera de Vercel el operador que quiera comportamiento
  prod debe setear `DIDIT_API_KEY` (con key, la ruta re-valida de verdad y el flag prod es
  irrelevante). El único caso peligroso —"prod sin key"— sólo aparece en Vercel production, que es
  exactamente donde `VERCEL_ENV==="production"` lo detecta. Se documenta el fallback en `.env.example`.

### 4.5 Enforcement en `ConfirmAndSend`

Se inyecta `authority: PayoutAuthorityGateway` en el ctor (5º arg). El check se inserta **tras
`r.confirm()` + `repo.save()` y ANTES de `wallet.authorizePrincipal()`**:

```
// tras paso 1 (confirm), antes de paso 2 (authorizePrincipal):
const address = await this.wallet.getAddress();
const auth = await this.authority.authorize({ verificationId: kyc.verificationId, address: address ?? "" });
if (!auth.authorized) {
  r.markPayoutFailed(auth.reason ?? "kyc_reauth_failed", this.clock.nowIso()); // confirmed → payout_failed (transición válida)
  await this.repo.save(r);
  return r; // NO se mueve principal, NO se submitea el payout
}
// … sigue authorizePrincipal + submit sin cambios …
```

**Por qué antes de `authorizePrincipal`**: `TRANSITIONS` permite `confirmed → payout_failed`
(`remittance.ts:65`), así que se puede fallar sin pull del principal on-chain — evita mover valor del
sender para un KYC no autorizado (no requiere refund). Cumple AC-1/AC-2/AC-6 (el override server-side
gana aunque `kyc.approved===true` en el estado client-side).

### 4.6 Ownership por `vendor_data` (resuelve el NEEDS CLARIFICATION)

**Decisión: SÍ, best-effort.** `/api/kyc/session` ya envía `vendor_data = senderAddress`
(`session/route.ts:69`). Didit eco-a `vendor_data` en la respuesta de `/decision/`. Se extiende:

- `DiditRaw` += `vendor_data?: string`.
- `DiditDecisionResult` += `vendorData: string` (mapeado con el helper `s()` existente,
  defensivo → `""` si ausente).
- El route (paso 7) compara `vendorData` vs `address` del caller (case-insensitive, direcciones EVM).

**Residual explícito (si Didit NO devuelve `vendor_data`)**: `d.vendorData === ""` → se **omite** el
ownership check y se autoriza sólo por `Approved`. En ese caso persiste un residual menor: un
`verificationId` Approved **robado** podría reusarse desde otra wallet. Es **mucho menor** que el
riesgo actual ("forjar `approved:true` sin tocar Didit", que esta HU cierra por completo). Queda como
follow-up (verificar el shape real de `vendor_data` contra el sandbox — mismo caveat de
`decision.ts:26-28`). **NO bloquea la HU.**

Aditividad: agregar `vendorData` a `DiditDecisionResult` NO rompe `/api/kyc/decision` — `maskDecision`
hace spread, y `kyc-gateway.ts` mapea campos nominados (ignora el extra). `vendorData` = wallet
address (dato ya conocido por el cliente, NO PII).

### 4.7 Flujo principal (Happy Path — prod con key + KYC legítimo)

1. Usuario confirma la remesa → `ConfirmAndSend.execute({remittanceId})`.
2. `r.confirm()` OK (invariante dominio) → save.
3. `authority.authorize({verificationId, address})` → `HttpPayoutAuthorityGateway` → `POST /api/payout/validate`.
4. Ruta: key presente → formato OK → Didit `/decision/` → `Approved` → (ownership match si hay vendor_data) → `{authorized:true}`.
5. Use-case sigue: `authorizePrincipal` → `principal_in` → `payouts.submit()` (MOCK) → `submitted`/`settled` → UI "Entregado".

### 4.8 Flujo de error

- **KYC forjado / no Approved** (AC-2/AC-6): ruta `{authorized:false, reason:"kyc_not_approved"}` →
  use-case `markPayoutFailed("kyc_not_approved")` → status `payout_failed`, UI muestra el fallo. Sin `submit`, sin principal.
- **Prod sin key** (AC-3): ruta `503 {authorized:false, reason:"kyc_authority_unavailable"}` → payout bloqueado.
- **verificationId vacío** (AC-5): ruta `400 {authorized:false, reason:"invalid_verification_id"}`, sin fetch → bloqueado.
- **Didit caído/timeout** (AC-2): ruta `502` o el adapter atrapa el throw → `{authorized:false, reason:"kyc_authority_error"}` → bloqueado (fail-closed).
- **Dev sin key** (AC-4): ruta `{authorized:true, reason:"simulated_dev"}` → flujo demo llega a "Entregado" (regresión OK).

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-A1**: Ruta nueva sigue el guard-order de `app/api/kyc/decision/route.ts` — misconfig/env-gate → formato → Didit → resultado. Nunca `fetch` a Didit antes de los guards (hereda CD-3).
- **CD-A2**: `DIDIT_API_KEY` y todo `fetch` a Didit de esta re-validación corren SOLO en la ruta API (server runtime). Cero exposición al bundle cliente (hereda CD-5, AC-7).
- **CD-A3**: La firma `authorize(input: {verificationId, address})` recibe `address` NO-opcional (`string`, no `string | undefined`); el use-case pasa `getAddress() ?? ""`.
- **CD-A4**: El adapter cliente es **fail-closed**: cualquier error de red/parse → `{authorized:false}`. Nunca lanzar sin catch, nunca `authorized:true` por default.
- **CD-A5**: Reusar `mapDiditDecision` para parsear la respuesta de Didit; NO re-implementar el parseo `status → approved`.
- **CD-A6**: `isProd()` deriva de `VERCEL_ENV === "production"` (§4.4). No inventar env var custom nueva.

### PROHIBIDO
- **CD-1 (heredado)**: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/` — ni el demo live (agentshop/cobraya/Chaski v1), ni `wasiai-a2a`, ni agentes `remit-*`.
- **CD-2 (heredado)**: PROHIBIDO tratar `approved`/`payoutAllowed`/`kycVerificationId` que llegue del browser como autoridad final. La autorización se origina SOLO en la respuesta de `/api/payout/validate`.
- **CD-4 (heredado)**: PROHIBIDO que el camino simulación (sin key) autorice payouts en producción de forma silenciosa. Prod sin key = fallo explícito 5xx.
- **CD-A7**: PROHIBIDO modificar `FallbackPayoutGateway` (`fallback/gateways.ts`) ni el comportamiento de `/api/kyc/session|decision` (WKH-179). La extensión de `decision.ts` debe ser ADITIVA (nuevo campo `vendorData`), sin alterar los campos/mapeos existentes.
- **CD-A8**: PROHIBIDO devolver PII (`identity`, `documentNumber`) desde `/api/payout/validate` — sólo `{authorized, reason}`.
- **CD-A9**: PROHIBIDO agregar dependencias nuevas (usar `node:crypto`/`fetch`/`next/server` ya presentes). No JWT libs.
- **CD-A10**: PROHIBIDO mover el punto de enforcement al dominio `Remittance` (DT-2: el dominio queda puro, sin I/O). Vive en el use-case.
- **CD-11** (auto-blindaje WKH-179): PROHIBIDO acceso por índice sin guardia — `tsconfig` tiene `noUncheckedIndexedAccess`. Usar `?.`/`!` deliberado; tipar los `vi.fn` cuyos `.mock.calls` se inspeccionan. Ref: `002-wkh-179/auto-blindaje.md#2`.
- **CD-12** (auto-blindaje WKH-179): PROHIBIDO reconstruir a mano tipos literal-template de libs — derivarlos con `Parameters<>`/`ReturnType<>`. (Aplica sólo si se toca una lib con ese tipo; acá probablemente N/A.) Ref: `002-wkh-179/auto-blindaje.md#1`.

## 6. Scope

**IN:**
- Ruta `app/api/payout/validate/route.ts` (nueva).
- Port `PayoutAuthorityGateway` + `PayoutAuthorization` en `ports.ts`.
- Adapter `src/infrastructure/payout/payout-authority-gateway.ts` (nuevo, fail-closed).
- Enforcement en `ConfirmAndSend` (inyección + check pre-`authorizePrincipal`).
- Extensión aditiva de `decision.ts` (`vendorData`).
- Wiring en `container.ts`.
- Tests: ruta, use-case (net-new), +1 caso en `decision.test.ts`.
- Comentario de prod-detection en `.env.example`.

**OUT:**
- Desembolso real (WKH-168) — `PayoutGateway` sigue MOCK.
- Cualquier repo/servicio fuera de `chaski-v2` (Opción b descartada).
- Cambios a rate-limit/auth de `/api/kyc/*` (WKH-179).
- Persistencia server-side de remesas (`LocalRepo` sigue en localStorage).
- Rate-limit / anti-oracle en `/api/payout/validate` (hardening futuro, §7).
- Cambios de UI más allá de mostrar `payout_failed` (ya soportado por la UI de estado existente).

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Didit NO devuelve `vendor_data` en `/decision/` → ownership no aplica | M | B | Best-effort: si vacío, se autoriza sólo por `Approved` (residual menor documentado §4.6); follow-up verificar shape en sandbox. El bug crítico (forjar `approved`) queda cerrado igual. |
| "Boolean oracle": atacante prueba verificationIds contra `/api/payout/validate` | B | B | Ruta no devuelve PII; sólo `authorized`. Hardening: rate-limit por IP reusando `checkKycRateLimit` (fuera de scope). |
| Regresión: demo dev deja de llegar a "Entregado" | B | M | AC-4: dev sin key → `authorized:true` simulado. Test de regresión en use-case + ruta. |
| `getAddress()` null en confirm (wallet desconectada) | B | B | Se pasa `?? ""`; si hay `vendor_data`, mismatch → bloqueado (fail-closed correcto). |
| Colisión de merge con WKH-181/182/183 (mismos archivos `confirm-and-send.ts`/`ports.ts`/`container.ts`) | M | M | Coordinar orden de merge entre Architects/Devs antes de F3 (nota `_INDEX.md`). |
| `tsc` rompe por `noUncheckedIndexedAccess` en tests | M | B | CD-11 (auto-blindaje WKH-179). |

## 8. Dependencias

- WKH-179 ya en prod (patrón `/api/kyc/*`, `DIDIT_API_KEY` en Vercel) — presente.
- `DIDIT_API_KEY` en Vercel production — ya seteado (per orquestador). En prod la ruta re-valida de verdad.
- Vitest (`npm run qa` = typecheck + test) — presente.
- Bloquea a **WKH-168** (desembolso real): mergear WKH-180 antes.

## 9. Missing Inputs

- Ninguno bloqueante. `vendor_data` shape → resuelto best-effort (§4.6), verificación empírica contra
  sandbox queda como follow-up no-bloqueante.

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| [TBD] | §4.6 | Shape exacto de `vendor_data` en `/decision/` de Didit — resuelto defensivo (`s()` → `""` si ausente); verificar en sandbox | No |

> Sin `[NEEDS CLARIFICATION]` pendientes. Los dos del work-item (arquitectura a/b, ownership) quedan
> resueltos por el orquestador + §4.6.

---

## Plan — Waves de Implementación

### Wave 0 (Serial Gate — contratos/tipos)
- [ ] W0.1: `ports.ts` — agregar `PayoutAuthorization` + `PayoutAuthorityGateway` (§4.2). Exemplar: `PayoutGateway`.
- [ ] W0.2: `decision.ts` — extender `DiditRaw` (`vendor_data?`) + `DiditDecisionResult` (`vendorData`) + mapeo defensivo. **Aditivo** (CD-A7). Exemplar: mismo archivo.
- [ ] Verificación W0: `npm run typecheck`.

### Wave 1 (Parallelizable — ruta + adapter)
- [ ] W1.1: `app/api/payout/validate/route.ts` — guard-order §4.3 + `isProd()` §4.4 + reuso `mapDiditDecision`. Exemplar: `app/api/kyc/decision/route.ts`. Depende de W0.2.
- [ ] W1.2: `src/infrastructure/payout/payout-authority-gateway.ts` — `HttpPayoutAuthorityGateway` fail-closed. Exemplar: `kyc-gateway.ts`. Depende de W0.1.
- [ ] W1.3: `app/api/payout/validate/route.test.ts`. Exemplar: `decision/route.test.ts`.
- [ ] W1.4: `decision.test.ts` — +1 caso `vendorData`.
- [ ] Verificación W1: `npm run qa`.

### Wave 2 (Integración — enforcement)
- [ ] W2.1: `confirm-and-send.ts` — inyectar `authority`, check pre-`authorizePrincipal` (§4.5). Depende de W0.1.
- [ ] W2.2: `container.ts` — instanciar `HttpPayoutAuthorityGateway` + pasar a `ConfirmAndSend`. Depende de W1.2, W2.1.
- [ ] W2.3: `confirm-and-send.test.ts` (net-new) — fakes + fake authority. Depende de W2.1.
- [ ] Verificación W2: `npm run qa`.

### Wave 3 (Final)
- [ ] W3.1: `.env.example` — comentario prod-detection (§4.4).
- [ ] W3.2: `npm run qa` full + verificación manual de regresión (dev sin key → "Entregado"; forjar `approved` en el estado del test → bloqueado).

## Dependencias entre tareas

| Tarea | Depende de | Razón |
|-------|-----------|-------|
| W1.1 | W0.2 | usa `vendorData` de `DiditDecisionResult` |
| W1.2 | W0.1 | implementa `PayoutAuthorityGateway` |
| W2.1 | W0.1 | inyecta el port |
| W2.2 | W1.2, W2.1 | cablea adapter → use-case |

## Test Plan (≥1 por AC)

| Test | AC | Wave | Framework |
|------|----|------|-----------|
| ruta: prod (`VERCEL_ENV=production`) + sin key → 503 `authorized:false`, `fetch` NOT called | AC-3, CD-4 | W1.3 | vitest |
| ruta: dev (sin `VERCEL_ENV`) + sin key → 200 `authorized:true` (`simulated_dev`), `fetch` NOT called | AC-4 | W1.3 | vitest |
| ruta: `verificationId` `""`/ausente (con key) → 400 `invalid_verification_id`, `fetch` NOT called | AC-5 | W1.3 | vitest |
| ruta: key + Didit `Approved` → 200 `authorized:true` | AC-1 | W1.3 | vitest |
| ruta: key + Didit `Declined` → 200 `authorized:false` `kyc_not_approved` | AC-2, AC-6 | W1.3 | vitest |
| ruta: key + Didit `!res.ok` → 502 `authorized:false` `kyc_reauth_failed` | AC-2 | W1.3 | vitest |
| ruta: `vendor_data` mismatch vs address → `authorized:false` `kyc_ownership_mismatch`; match → `true`; ausente → `true` (residual) | AC-1 (ownership) | W1.3 | vitest |
| ruta: `DIDIT_API_KEY` leído sólo server-side (no en respuesta/body) | AC-7 | W1.3 | vitest |
| use-case: fake authority `authorized:false` → `payouts.submit` NOT called, `wallet.authorizePrincipal` NOT called, status `payout_failed` + `failureReason` | AC-1, AC-2, AC-6 | W2.3 | vitest |
| use-case: estado con `kyc.approved:true` forjado PERO authority `authorized:false` → bloqueado (override server-side) | AC-6 | W2.3 | vitest |
| use-case: authority `authorized:true` → flujo completo → `submit` called → `submitted`/`settled` (regresión) | AC-1 | W2.3 | vitest |
| adapter: `fetch` throw/red-caída → `{authorized:false, reason:"kyc_authority_error"}` (fail-closed) | AC-2, CD-A4 | W1.3 | vitest |
| decision: `mapDiditDecision` extrae `vendorData` | — | W1.4 | vitest |

## Verificación Incremental

| Wave | Verificación |
|------|--------------|
| W0 | `npm run typecheck` |
| W1 | `npm run qa` |
| W2 | `npm run qa` |
| W3 | `npm run qa` + regresión manual demo |

## Estimación

- Archivos nuevos: 3 (route, adapter, use-case test) + 1 route test = 4.
- Archivos modificados: 5 (`ports.ts`, `decision.ts`, `confirm-and-send.ts`, `container.ts`, `.env.example`) + `decision.test.ts`.
- Tests nuevos: ~13 casos (2 archivos + 1 caso).
- Líneas estimadas: ~320.

---

## Readiness Check

```
[x] Cada AC (1-7) tiene ≥1 archivo asociado en §4.1 y ≥1 test en el Test Plan
[x] Cada archivo en §4.1 tiene Exemplar verificado con Read/Glob (paths reales confirmados)
[x] No hay [NEEDS CLARIFICATION] pendientes (los 2 del work-item resueltos: arquitectura=Opción a; ownership=best-effort §4.6)
[x] Constraint Directives ≥3 PROHIBIDO (CD-1/2/4 heredados + CD-A7..A10 + CD-11/12)
[x] Context Map ≥2 archivos leídos (11 leídos con archivo:línea)
[x] Scope IN y OUT explícitos y no ambiguos
[x] BD: N/A verificado (no hay backend con DB; Didit = fuente de verdad)
[x] Happy Path completo (§4.7)
[x] Flujo de error definido (§4.8, 5 casos)
[x] Auto-blindaje histórico incorporado (CD-11/12 desde WKH-179)
[x] Regresión del demo verificable (AC-4 + test use-case happy)
```

Todos los checks pasan → SDD listo para GATE SPEC_APPROVED.

---

*SDD generado por NexusAgil — FULL (Architect F2, WKH-180)*
