# SDD — [WKH-202] [GATE Fase A] Hardening del enforcement de `/api/a2a/payout/submit`

> NexusAgil F2 · modo QUALITY · SDD_MODE: full
> Autor: nexus-architect · Fecha: 2026-07-15
> Input: `doc/sdd/015-wkh-202-payout-submit-hardening/work-item.md` (HU_APPROVED 2026-07-15)
> Repo: `chaski-v2` (standalone — NO es `wasiai-a2a`)

---

## 1. Resumen

`app/api/a2a/payout/submit/route.ts` es hoy un proxy POST **público sin autorización** que
forwardea `amountUsd`/`beneficiary`/`kycVerificationId` verbatim al agente `remit-cashout-payout`.
Sólo es inofensivo porque `REMIT_AGENTS_BASE_URL` no está seteada (guard 501 fail-closed).

Este SDD diseña el enforcement server-side: la route **re-valida contra Didit** (KYC `Approved` +
ownership del `address`) **antes** de forwardear, reusando —vía extracción a un módulo compartido—
la misma lógica que ya es autoridad en `app/api/payout/validate/route.ts` (WKH-180). Sin nueva
superficie de auth, sin nuevos secretos, sin persistencia server-side nueva.

**Decisiones cerradas en este SDD**: DT-4 → **opción (a)**, re-validación inline (§4.3);
Missing Input #3 → **400/403/502/503** según clase de fallo (§4.5); DT-1 → extracción a
`src/infrastructure/payout/authority.ts` con `/api/payout/validate` preservado byte-idéntico (§4.2).

**Riesgo residual explícito (§8)**: cerrar WKH-202 **NO** habilita por sí solo la Fase A. El gate
son **3 huecos**; esta HU cierra **1** (G1). G2 = **WKH-203** (`kycPayoutAllowed` confiado del
caller, repo `wasiai-remittance-agents`), G3 = **WKH-168** (nadie verifica el principal en USDC).

---

## 2. Work Item — resolución de los Missing Inputs

| # | Missing Input | Estado | Resolución |
|---|---------------|--------|-----------|
| 1 | **BLOQUEANTE (DT-3)** — ¿integridad de `amountUsd`/`beneficiary` contra quote persistido? | **RESUELTO — decisión del humano (Fernando, 2026-07-15), VINCULANTE** | Alcance = **KYC `Approved` + ownership del `address`**. NO se construye persistencia server-side de quotes/remesas (nada de quote-registry Upstash, nada de infra de estado nueva). La integridad monto/beneficiario **NO es responsabilidad de esta HU** → es **WKH-168** (quote-lock → principal-in → payout → reconcile → refund), ya trackeada y diferida. Riesgo residual documentado en §8 (obligatorio también en el done-report). |
| 2 | NO bloqueante (DT-4) — mecanismo del guard | **RESUELTO por el Architect** | Opción **(a)**: re-validación inline contra Didit vía módulo compartido. Justificación + descarte de (b) en §4.3. |
| 3 | NO bloqueante — código HTTP de "no autorizado" | **RESUELTO por el Architect** | Criterio *advisory vs. action* → **400** `payout_invalid_request`, **403** `payout_not_authorized`, **502/503** `payout_authority_unavailable`. Tabla y justificación en §4.5. |
| 4 | `[SIN PRODUCT CONTEXT]` | Heredado, sin impacto | No existe `product-context.md` en `chaski-v2`. Se usa `project-context.md` + el contexto de negocio del work-item. No bloquea el diseño. |

### Acceptance Criteria (heredados del work-item, sin cambios)

AC-1 (4xx + fetch NUNCA invocado sin autorización) · AC-2 (`authorized:false` → sin forward) ·
AC-3 (501 `a2a_not_configured` intacto) · AC-4 (autorizado → forward preservando CD-5/CD-9/CD-10) ·
AC-5 (fallo técnico → fail-closed) · AC-6 (**los 7 tests existentes en verde, sagrado**) ·
AC-7 (502 `a2a_bad_shape` sin cambios).

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos — verificados con Read/Grep (líneas reales al 2026-07-15)

| Archivo | Por qué | Qué extraje |
|---------|---------|-------------|
| `app/api/a2a/payout/submit/route.ts` (51 L) | Objetivo de la HU | Confirmado: **cero autorización**. Guard único `if (!BASE) → 501` (L31-32). Body forwardeado verbatim (L38). `isValidPayoutResult` (L14-28) sólo valida shape de la **respuesta**. `catch` global → 502 `a2a_unavailable` (L47-50). |
| `app/api/a2a/payout/submit/route.test.ts` (121 L) | **AC-6 sagrado** | 7 tests. Fixture compartido `validPayload` (L14-21) — **no incluye `address`**. Ningún test stubea `DIDIT_API_KEY`/`VERCEL_ENV` (→ riesgo de no-determinismo, §4.7). Los asserts son por-campo, no `toEqual` del body forwardeado. |
| `app/api/payout/validate/route.ts` (103 L) | **Exemplar principal** (DT-1) | Guard-order exacto: no-key+prod → **503** `kyc_authority_unavailable` (L26-33) → no-key+no-prod → 400 si vid vacío, si no **200** `{authorized:true, reason:"simulated_dev"}` (L35-41) → formato → **400** (L45-50) → Didit fetch (L59-62) → `!res.ok` → **502** `kyc_reauth_failed` (L63-68) → `status!=="Approved"` → **200** `kyc_not_approved` (L73-78) → ownership `vendorData` vs `address` → **200** `kyc_ownership_mismatch` (L88-93) → **200** `{authorized:true}` (L95, **sin `reason`**) → `catch` → **502** `kyc_reauth_failed` (L96-102). |
| `app/api/payout/validate/route.test.ts` | Contrato a NO romper | Asserts `toEqual` **exactos** por rama, incl. `{authorized:true}` **sin la clave `reason`** (L74-76). Patrón: `vi.stubEnv` + `vi.stubGlobal("fetch", ...)`, sin module-mocks. Helper `diditOk(raw)`. |
| `src/infrastructure/kyc-auth.ts` (33 L) | Exemplar de DT-4 opción (b) | HMAC `node:crypto`, timing-safe. **L7: "NO prueba posesión de wallet. Si el token se filtra es replayable. SIWE deferred"**. Además: el HMAC es **sólo sobre `sessionId`** → **token sin TTL, válido para siempre** (input clave para descartar (b), §4.3). |
| `src/application/ports.ts` (138 L) | Contrato DT-2 | `PayoutSubmit` (L63-70): `quoteId`, `amountUsd`, `expectedReceivePen`, `beneficiary`, `kycVerificationId`, `idempotencyKey` — **sin `address`**. `PayoutAuthorization` (L97-100) + `PayoutAuthorityGateway.authorize({verificationId, address})` (L101-104), `address` NO-opcional (CD-A3). |
| `src/infrastructure/a2a/gateways.ts` (158 L) | Propagación DT-2 | `A2aPayoutGateway.submit()` (L119-138) postea `kycPayoutAllowed: true` **hardcodeado** (L127, "DT-5: sintetizado") y **nunca `address`**. `if (!res.ok) throw new Error("a2a_payout_unavailable")` (L132) ← **toda respuesta 4xx/5xx nueva desemboca acá**. |
| `src/application/use-cases/confirm-and-send.ts` (132 L) | Causa raíz + DT-2 | `authority.authorize()` (L65-68) corre **antes** del `payouts.submit()` (L103-110), pero **toda la orquestación es client-side** → saltarse el use-case saltea el chequeo. `const address = await this.wallet.getAddress()` **ya existe en L64** → propagar es trivial. `catch` (L125-128) → `failAndRefund`. |
| `src/infrastructure/payout/payout-authority-gateway.ts` (25 L) | Fail-closed de referencia (CD-A4) | Cliente de `/api/payout/validate`; cualquier error → `{authorized:false}`. **No se toca en esta HU.** |
| `src/infrastructure/didit/decision.ts` (L1-67) | Mapeo reusado | `mapDiditDecision(raw)` → `{status, approved, vendorData, ...}`. `vendorData = s(raw.vendor_data)` (`""` si ausente). Se reusa tal cual (CD-A5). |
| `src/infrastructure/a2a/gateways.test.ts` | **Breaker de tsc (§6)** | **L20: `const payoutReq: PayoutSubmit = {...}` — literal TIPADO sin `address`** → romperá `tsc` apenas `address` sea requerido. Los asserts del body son por-campo (L83-87) → agregar `address` **no** rompe asserts. |
| `src/application/use-cases/confirm-and-send.test.ts` | Exemplar del test de DT-2 | L187-204: `vi.spyOn(payouts, "submit")` + `submitSpy.mock.calls[0]?.[0]` — patrón exacto para asertar `address`. `FakeWallet.getAddress()` → `"0xSender"` (`fakes.ts:247-249`). |
| `src/test-support/test-container.ts` (89 L) | **Precedente WKH-201** | **Verificado: NO construye ningún literal `PayoutSubmit` y NO cambia la firma de `ConfirmAndSend`** → **no se rompe** con DT-2. Ver §6 (por qué esta vez no aplica el precedente). |
| `src/test-support/fakes.ts` | Idem | `FakePayoutGateway.submit(_req: PayoutSubmit)` (L216) = **consumidor**, ignora el arg → agregar un campo a la interfaz **no lo rompe**. `vi.spyOn` cubre el test de DT-2 → **`fakes.ts` NO entra en Scope IN**. |
| `tsconfig.json` (L34-45) | Gate de verificación | `include: ["src/**/*.ts", "app/**/*.ts", ...]`, `exclude: ["node_modules"]`. **No existe `tsconfig.build.json` en `chaski-v2`** → `tsc --noEmit` **SÍ** typechequea los `*.test.ts` (corrección al gotcha del orquestador, §9). |
| `package.json` (L9-15) | Gate | `typecheck: tsc --noEmit` · `test: vitest run` · **`qa: npm run typecheck && npm run test`** ← gate de cada wave. |
| `.env.example` (L7-16, 25-26, 60) | Env | `DIDIT_API_KEY`, `DIDIT_BASE_URL`, `KYC_SESSION_SECRET`, `REMIT_AGENTS_BASE_URL` ya documentadas. L14-16 documenta `VERCEL_ENV`. **No hay env de "payout auth"** → con la opción (a), **no se agrega ninguna** (§4.3). |
| `project-context.md` (L33-35, 112-118) | Stack + guardrails | Confirmado: sin DB relacional, persistencia `localStorage`-only → base fáctica de DT-3. Autoridad de payout SIEMPRE server-side (WKH-180). |
| `doc/sdd/_INDEX.md` (tail) | Numeración | `015` pre-asignado a WKH-202, sin colisión. |

### 3.2 Exemplars verificados (paths confirmados en disco)

| Para... | Exemplar | Verificado |
|---------|----------|-----------|
| Guard-order Didit + fail-closed | `app/api/payout/validate/route.ts` | Sí (leído completo) |
| Tests de route con env + fetch stubs (sin module-mocks) | `app/api/payout/validate/route.test.ts` | Sí |
| Mapeo puro de Didit | `src/infrastructure/didit/decision.ts` (`mapDiditDecision`) | Sí |
| Capturar el arg de `payouts.submit()` en un test de use-case | `src/application/use-cases/confirm-and-send.test.ts:187-204` (`vi.spyOn`) | Sí |
| Fail-closed en adapter | `src/infrastructure/payout/payout-authority-gateway.ts` | Sí |
| Import desde `app/api/**/route.ts` hacia `src/` | `app/api/payout/validate/route.ts:10` → `"../../../../src/infrastructure/didit/decision"` (**relativo**) | Sí |

### 3.3 Auto-Blindaje histórico (últimas HUs DONE) → CD-7/CD-8/CD-9

Leídos: `014-wkh-201/auto-blindaje.md`, `014-wkh-200/auto-blindaje.md`, `012-wkh-198/auto-blindaje.md`
(+ `MEMORY.md` de WKH-196).

**Patrón recurrente detectado (≥2 ocurrencias): "el gate de verificación no cubría todo lo que el
cambio rompía".**

| HU | Error | Aplicación a WKH-202 |
|----|-------|---------------------|
| **WKH-198** | El alias `@/` en un `route.ts` pasó `typecheck` + `next build` pero **reventó vitest** (no hay `vitest.config.*` ni `vite-tsconfig-paths`). | → **CD-7**: el import nuevo en `submit/route.ts` va **relativo**. |
| **WKH-201** | Cambiar una firma rompió `test-container.ts`, **archivo fuera del Scope IN** → tsc rojo. | → **CD-8**: enumerar **todos** los consumidores antes de cerrar scope. Instancia concreta acá: `gateways.test.ts:20` (§6). |
| **WKH-196** (`wasiai-a2a`, `MEMORY.md`) | CR aprobó con tsc roto en tests porque el build excluía `*.test.ts`. | → **CD-9**: el gate es **`npm run qa`** (typecheck **+** test), nunca `npm run build` solo. |

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `src/infrastructure/payout/authority.ts` | **CREAR** — `resolvePayoutAuthority()` + `PayoutAuthorityDecision` (lógica extraída de `validate/route.ts`) | W0 |
| 2 | `app/api/payout/validate/route.ts` | MOD — pasa a wrapper delgado del módulo (**comportamiento byte-idéntico**) | W0 |
| 3 | `src/application/ports.ts` | MOD — `PayoutSubmit.address: string` (DT-2) | W0 |
| 4 | `src/application/use-cases/confirm-and-send.ts` | MOD — propaga `address` al `submit()` | W0 |
| 5 | `src/infrastructure/a2a/gateways.ts` | MOD — forwardea `address` + comentario → WKH-203 | W0 |
| 6 | `src/infrastructure/a2a/gateways.test.ts` | MOD — **literal tipado L20 + 1 assert** (breaker de tsc, §6) | W0 |
| 7 | `app/api/a2a/payout/submit/route.ts` | MOD — **el guard de autorización** (corazón de la HU) | W1 |
| 8 | `app/api/a2a/payout/submit/route.test.ts` | MOD — **+6 tests; los 7 existentes intactos** (AC-6) | W1 |
| 9 | `src/application/use-cases/confirm-and-send.test.ts` | MOD — +1 test (`submit` recibe `address`) | W2 |
| 10 | `.env.example` | MOD — regla de acoplamiento de deploy `REMIT_AGENTS_BASE_URL` ↔ `DIDIT_API_KEY` (§4.6) | W2 |

**NO se tocan (verificado)**: `src/test-support/test-container.ts`, `src/test-support/fakes.ts`,
`src/infrastructure/fallback/gateways.ts`, `src/infrastructure/payout/payout-authority-gateway.ts`,
`src/domain/remittance.ts`, `src/presentation/*`, `app/api/a2a/quote/route.ts`.

### 4.2 DT-1 — Extracción del módulo compartido (anti-divergencia)

**Decisión: función async exportada + wrapper delgado.** Descartado "llamar por HTTP al propio
endpoint desde la route" (self-fetch: agrega un hop de red, requiere conocer la URL absoluta en
runtime — frágil en Vercel — y un fallo del hop se confundiría con un fallo de Didit).

**Archivo nuevo**: `src/infrastructure/payout/authority.ts` (server-only: lee `DIDIT_API_KEY` y
fetchea Didit; **nunca** debe importarse desde `src/presentation/**`).

```ts
// Firma (contrato de W0)
export interface PayoutAuthorityDecision {
  authorized: boolean;
  reason?: string;      // ausente cuando authorized:true por Didit real (preserva {authorized:true})
  httpStatus: number;   // 200 | 400 | 502 | 503 — el status que /api/payout/validate YA devuelve hoy
}
export async function resolvePayoutAuthority(
  input: { verificationId: string; address: string },
): Promise<PayoutAuthorityDecision>;
```

**Regla de preservación (CD-10, crítica)**: el cuerpo de `resolvePayoutAuthority` es un
**move mecánico** de `validate/route.ts:16-102` — mismo orden de guards, mismos `reason`, mismos
status, mismo `try/catch` envolviendo fetch+mapeo+decisión. `httpStatus` transporta el status que
la route ya devolvía en cada rama. **Cero cambio de comportamiento.**

`app/api/payout/validate/route.ts` queda:

```ts
const { httpStatus, ...body } = await resolvePayoutAuthority({ verificationId, address });
return NextResponse.json(body, { status: httpStatus });
```

> **Por qué `{...rest}` y no `NextResponse.json({authorized, reason})`**: la rama de éxito real
> devuelve hoy `{authorized:true}` **sin la clave `reason`**, y `validate/route.test.ts` lo asserta
> con `toEqual`. El rest-spread preserva la ausencia de la clave; el objeto literal la reintroduciría
> como `undefined`. El parseo del body (`req.json().catch(() => ({}))` + coerción a `""`) **queda en
> la route** (la función recibe strings ya normalizados). Esto preserva el caso live verificado
> **body vacío → 400 `invalid_verification_id`**.

### 4.3 DT-4 — RESUELTO: opción (a), re-validación inline contra Didit

**Decisión: (a).** El submit re-valida contra Didit vía `resolvePayoutAuthority` (§4.2). **Sin token
nuevo, sin secreto nuevo, sin env var nueva.**

**Trade-off aceptado**: 2º roundtrip a Didit por submit (≤10s worst-case, `AbortSignal.timeout`).
**Aceptable**: el submit es human-paced (~1 por remesa), no es hot-path; la misma llamada ya ocurre
~1 vez por remesa en `confirm-and-send.ts:65` → duplicamos una llamada rara, no un loop.
Rate-limit/quota de Didit: no material a este volumen.

**Por qué (a) gana:**
1. **Frescura**: la decisión se toma **en el instante en que se mueve la plata**. Un KYC revocado/
   expirado entre validate y submit se caza. (b) autoriza con una foto vieja.
2. **DT-1 sale gratis**: (a) *es* el reuso del guard-order; una sola implementación, un solo lugar donde equivocarse.
3. **Cero superficie nueva**: sin secreto, sin env var, sin máquina de tokens, sin TTL que diseñar.

**Por qué se descarta (b) — token HMAC `x-payout-token` (con honestidad sobre lo que NO mitiga):**
- **No sube el techo de seguridad.** `/api/payout/validate` es hoy un endpoint **público sin auth**:
  quien pueda obtener `{authorized:true}` para minar el token es exactamente quien pasaría el guard
  de (a). (b) agrega una credencial bearer **sin** cerrar ningún vector que (a) deje abierto.
- **No prueba posesión de wallet y es replayable si se filtra** — limitación **documentada en el
  propio `kyc-auth.ts:7`**. Copiar el patrón heredaría el límite tal cual (sin SIWE, Scope OUT).
- **Sin TTL**: `kyc-auth.ts:20-22` firma **sólo** el `sessionId` → el token **no expira nunca**. Un
  `x-payout-token` con ese patrón sería una **autorización de desembolso permanente**. Arreglarlo
  exige diseñar timestamp+TTL+skew dentro del HMAC = **cripto nueva** en el money-path, justo la
  clase de superficie que esta HU debería reducir.
- **Nueva env var en el money-path**: `PAYOUT_SESSION_SECRET` sin setear en Vercel ⇒ (fail-closed)
  **todos** los payouts caen 5xx. Es un modo de fallo de deploy nuevo, precisamente en la Fase A.
- **Autorización stale**: valida en T, desembolsa en T+n.

**Lo que (a) NO mitiga** (sin sobre-prometer, ver §8): que un atacante con **su propio** KYC
`Approved` + **su propia** `address` invoque un payout con `amountUsd`/`beneficiary` arbitrarios.
Eso NO lo cierra ningún mecanismo de auth: requiere atar el submit a un quote/principal
server-side = **WKH-168**. (a) y (b) tienen **idéntico** techo ante ese vector → se elige la simple.

### 4.4 Guard-order de `/api/a2a/payout/submit` (fail-closed en cada rama)

```
1. BASE = env.REMIT_AGENTS_BASE_URL
   if (!BASE) → 501 a2a_not_configured                      ← PRIMERO, INTACTO (AC-3, CD-11)
2. body = await req.json().catch(() => ({}))                 ← igual que hoy
3. Formato: kycVerificationId: string no-vacío
            address:           string no-vacío
   else → 400 payout_invalid_request                         ← AC-1 (fetch NUNCA llamado)
4. d = await resolvePayoutAuthority({ verificationId: body.kycVerificationId,
                                      address: body.address })
5. Anti-simulación en Vercel: if (d.reason === "simulated_dev" && VERCEL_ENV !== "")
       → 503 payout_authority_unavailable                    ← DT-5 (§4.6), AC-5
6. if (!d.authorized || d.reason === "simulated_dev"...) → map(d) → 4xx/5xx  ← AC-2/AC-5
7. FORWARD al agente  ← bloque actual L34-50 SIN CAMBIOS (AC-4/AC-7, CD-5/CD-9/CD-10)
```

**Por qué el `!BASE → 501` va PRIMERO** (no es cosmético):
- **AC-3** lo exige explícito ("independiente del resultado del guard nuevo").
- El test existente `"sin REMIT_AGENTS_BASE_URL → 501 ..., fetch NOT called"` assertea
  `expect(fetchMock).not.toHaveBeenCalled()`. Si la autoridad corriera primero **con** key, haría
  un fetch a Didit → **AC-6 violado**. El orden no es negociable → **CD-11**.
- Semánticamente correcto: sin backend configurado no hay nada que autorizar; y **no** se gasta una
  llamada a Didit para responder 501.

**Nota de seguridad (no-oracle, CD-12)**: la respuesta lleva **sólo** `{ error: <code> }`. **Nunca**
se ecoa el `reason` de la autoridad. `kyc_not_approved` y `kyc_ownership_mismatch` colapsan al
**mismo** `403 payout_not_authorized` → un caller no autenticado no puede usar el endpoint como
oráculo del estado KYC de un `verificationId` ajeno. (CD-5: `beneficiary`/PII nunca se loguean ni
ecoan — el código nuevo sólo emite enums.)

### 4.5 Missing Input #3 — RESUELTO: código HTTP

**Criterio fijado (resuelve la inconsistencia aparente del repo): _advisory_ vs _action_.**
- `/api/payout/validate` es **advisory**: su trabajo es *computar y devolver un veredicto* para un
  adapter cliente que **parsea el body** (`payout-authority-gateway.ts:16-21`). `200 + {authorized:false}`
  significa "computé la respuesta con éxito, y la respuesta es no". Correcto para su rol.
- `/api/kyc/decision` usa **401** porque **falta una credencial** (`x-kyc-token`) — hay un esquema
  de auth que desafiar. Con la opción (a) **no existe tal credencial** → 401 sería semánticamente
  incorrecto (RFC 9110 pide `WWW-Authenticate`, y no hay nada que challengear).
- `/api/a2a/payout/submit` es **action**: ejecuta un efecto (desembolso). Un `200` sobre una acción
  rechazada sería una mentira de protocolo y **violaría AC-1** ("4xx"). El rechazo es sobre el
  **estado/recurso**, no sobre la identidad → **403**.

| Situación | HTTP | `error` | AC |
|-----------|------|---------|-----|
| `REMIT_AGENTS_BASE_URL` sin setear | **501** | `a2a_not_configured` *(intacto)* | AC-3 |
| `kycVerificationId`/`address` ausente/vacío/no-string | **400** | `payout_invalid_request` | AC-1 |
| Autoridad → `invalid_verification_id` | **400** | `payout_invalid_request` | AC-1 |
| Autoridad → `kyc_not_approved` | **403** | `payout_not_authorized` | AC-2 |
| Autoridad → `kyc_ownership_mismatch` | **403** | `payout_not_authorized` | AC-2 |
| Autoridad → `kyc_authority_unavailable` (prod sin key) | **503** | `payout_authority_unavailable` | AC-5 |
| Autoridad → `simulated_dev` **con** `VERCEL_ENV` no vacío | **503** | `payout_authority_unavailable` | AC-5 |
| Autoridad → `kyc_reauth_failed` / throw / reason desconocido | **502** | `payout_authority_unavailable` | AC-5 |
| Autorizado + agente ok / !ok / bad shape / throw | **200 / 502 / 502 / 502** | *(intacto)* | AC-4/AC-7 |

**Regla de mapeo (CD-13, fail-closed por default)**: `switch` sobre `d.reason` con **`default` →
502 `payout_authority_unavailable`**. Un `reason` nuevo/desconocido **rechaza**; jamás cae en el
forward. (Esta es la lección de WKH-198: el `NaN` fail-open.)

**Impacto en el cliente (verificado, sin trabajo de UI)**: `A2aPayoutGateway.submit()` hace
`if (!res.ok) throw new Error("a2a_payout_unavailable")` (`gateways.ts:132`) → cualquier 4xx/5xx
nuevo entra al `catch` de `confirm-and-send.ts:125` → `failAndRefund` → `payout_failed` → refund.
**Path ya existente y testeado. Cero cambios en `src/presentation/**`.**

### 4.5.b DT-2 — `PayoutSubmit.address`

`address: string` **requerido** (no `string | undefined`), espejando `PayoutAuthorityGateway.authorize()`
(`ports.ts:102-103`, "address es NO-opcional, CD-A3"). `confirm-and-send.ts` pasa `address ?? ""`
(el `const address` **ya existe** en L64) — misma coerción que ya usa para `authority.authorize()`.

> **Consecuencia conocida y aceptada** (fail-closed, no bug): si `getAddress()` → `null` (wallet
> desconectada), el submit manda `address: ""` → guard de formato → **400** → `a2a_payout_unavailable`
> → `payout_failed` + refund. Hoy ese caso ya moriría antes, en `authority.authorize()`, salvo en la
> rama simulada. Sólo aplica con `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER="a2a"`; el `FallbackPayoutGateway`
> ignora `address`. **Nunca autoriza de más.**

### 4.6 DT-5 — Cierre del hueco de PREVIEW (fail-closed, AC-5)

**Hallazgo del diseño**: `resolvePayoutAuthority` hereda de `validate/route.ts:16` el chequeo
`isProd = VERCEL_ENV === "production"`. La rama **sin key + no-prod** devuelve
`{authorized:true, reason:"simulated_dev"}`. En un deploy de **preview** de Vercel
(`VERCEL_ENV === "preview"`) con `REMIT_AGENTS_BASE_URL` seteada y sin `DIDIT_API_KEY`, eso
**autorizaría un payout real por simulación** — un fail-open introducido por el reuso.

**Mitigación (paso 5 del guard-order)**: la route de submit rechaza `simulated_dev` cuando
`VERCEL_ENV` **no está vacía** (= corre en Vercel: preview o production) → **503**. Fuera de Vercel
(local/CI, `VERCEL_ENV` ausente) la simulación se acepta → **el demo local con el adapter a2a sigue
andando y los 7 tests existentes quedan en verde**.

- La regla vive **sólo** en `submit/route.ts` (es una decisión del money-path): `resolvePayoutAuthority`
  y `/api/payout/validate` quedan byte-idénticos → **CD-10 intacto**.
- Refuerzo documental en `.env.example`: *"`REMIT_AGENTS_BASE_URL` NO debe setearse en ningún scope
  de Vercel donde `DIDIT_API_KEY` esté ausente"*. **Sin env var nueva.**

### 4.7 Determinismo de env en los tests (habilitador de AC-6)

Los 7 tests existentes **no** stubean `DIDIT_API_KEY`/`VERCEL_ENV`. Con el guard nuevo, su resultado
pasaría a depender del **shell ambiente** (no hay `vitest.config.*` → vitest **no** carga `.env.local`,
pero un `DIDIT_API_KEY` exportado en la shell/CI haría fetchear Didit → rojo intermitente).

**Fix (setup, no asserts)**: `beforeEach` con `vi.stubEnv("DIDIT_API_KEY", "")` +
`vi.stubEnv("VERCEL_ENV", "")` → rama simulada, **sin fetch a Didit** → el único fetch que ven los
mocks existentes sigue siendo el del agente. `afterEach` suma `vi.unstubAllEnvs()`
(`vi.restoreAllMocks()` **no** deshace `stubEnv`). Mismo patrón que `validate/route.test.ts`.

---

## 5. Waves de implementación

**Gate de CADA wave: `npm run qa`** (= `tsc --noEmit` **+** `vitest run`) — **CD-9**. Baseline a
preservar: **275/275 verde**.

### W0 — Contratos + extracción (SERIAL, sin cambio de comportamiento)
> Objetivo: dejar el contrato y el módulo compartido listos **sin** tocar aún el guard. Al cerrar
> W0 la suite debe seguir **275/275** (cero tests nuevos, cero comportamiento nuevo).

| Paso | Archivo | Cambio |
|------|---------|--------|
| W0.1 | `src/infrastructure/payout/authority.ts` **(nuevo)** | Move mecánico de `validate/route.ts:16-102` → `resolvePayoutAuthority` + `PayoutAuthorityDecision` (§4.2). Import de `mapDiditDecision` por ruta **relativa** (`../didit/decision`). |
| W0.2 | `app/api/payout/validate/route.ts` | Wrapper delgado (`{httpStatus, ...body}`). **Verificación: `validate/route.test.ts` 100% verde SIN tocar un solo assert** — si un assert se rompe, la extracción se desvió (CD-10). |
| W0.3 | `src/application/ports.ts` | `PayoutSubmit.address: string` + comentario de por qué (DT-2/WKH-202). |
| W0.4 | `src/application/use-cases/confirm-and-send.ts` | `address: address ?? ""` en el objeto del `payouts.submit()` (L103-110). **CD-3: no se toca `authority.authorize()` ni el orden de guards.** |
| W0.5 | `src/infrastructure/a2a/gateways.ts` | `address: req.address` en el body (L123-130) + comentario en `kycPayoutAllowed: true` → **"el agente NO debe confiar en este booleano del caller; se re-deriva server-side en WKH-203 (repo `wasiai-remittance-agents`). NO removerlo acá: contrato cross-repo (CD-14)."** |
| W0.6 | `src/infrastructure/a2a/gateways.test.ts` | **L20**: agregar `address: "0xSender"` al literal tipado (**breaker de tsc, §6**) + 1 assert `expect(sent.address).toBe("0xSender")` en el test AC-4. |

**Salida de W0**: `npm run qa` verde, 275/275. `git diff` sin cambios de comportamiento observable.

### W1 — El guard (depende de W0) — ∥ con W2
| Paso | Archivo | Cambio |
|------|---------|--------|
| W1.1 | `app/api/a2a/payout/submit/route.ts` | Guard-order §4.4 + `switch` de mapeo §4.5 (`default` → 502). Import **relativo** (`../../../../src/infrastructure/payout/authority`) — **CD-7**. Bloque de forward L34-50 **sin tocar**. Actualizar el comentario de cabecera. |
| W1.2 | `app/api/a2a/payout/submit/route.test.ts` | `beforeEach`/`afterEach` de env (§4.7) + `address` en `validPayload` + **6 tests nuevos** (§7). **Los 7 asserts existentes NO se tocan (AC-6/CD-6).** |

### W2 — Contrato client-side + docs (depende de W0) — ∥ con W1
| Paso | Archivo | Cambio |
|------|---------|--------|
| W2.1 | `src/application/use-cases/confirm-and-send.test.ts` | +1 test: `submit` recibe `address: "0xSender"` (patrón `vi.spyOn`, exemplar L187-204). |
| W2.2 | `.env.example` | Nota junto a `REMIT_AGENTS_BASE_URL` (L60): gate WKH-202 + acoplamiento con `DIDIT_API_KEY` (§4.6) + puntero a WKH-203/WKH-168 como pendientes del gate de Fase A. |

### W3 — Cierre (serial)
`npm run qa` completo → **282/282 esperados** (275 + 6 W1 + 1 W2). Verificación manual del §8
(riesgo residual) para el done-report.

---

## 6. Anticipación del precedente WKH-201 (consumidores fuera del Scope IN)

WKH-201 rompió tsc en `test-container.ts`, archivo no listado. **Grep exhaustivo de consumidores de
`PayoutSubmit` hecho en F2** (`grep -rn "PayoutSubmit|payouts.submit|\.submit(" src app`):

| Consumidor | ¿Rompe con `address` requerido? | Por qué |
|-----------|--------------------------------|---------|
| `src/application/use-cases/confirm-and-send.ts:103` | **SÍ** — construye el literal | En Scope IN (W0.4) |
| **`src/infrastructure/a2a/gateways.test.ts:20`** | **SÍ — `const payoutReq: PayoutSubmit = {...}` (literal TIPADO)** | **En Scope IN (W0.6). Éste es el "test-container.ts" de esta HU.** |
| `src/infrastructure/a2a/gateways.ts:119` | No | Firma `submit(req: PayoutSubmit)` = consumidor |
| `src/infrastructure/fallback/gateways.ts:98` | No | Idem consumidor |
| `src/test-support/fakes.ts:216` | No | `submit(_req: PayoutSubmit)` ignora el arg |
| **`src/test-support/test-container.ts`** | **No — verificado** | **No construye ningún `PayoutSubmit` y la firma de `ConfirmAndSend` NO cambia** (el precedente WKH-201 era un cambio de **constructor**; éste es un campo de **interfaz**). Queda igual en watch-list del `tsc`. |
| `src/presentation/**` | No | No construye `PayoutSubmit` |

> **Al dev**: si aparece un tsc rojo en un archivo **no** listado acá → **es una desviación
> reportable** (no la arregles en silencio): significa que este survey falló.

---

## 7. Plan de tests (≥1 por AC)

Baseline **275/275**. Nuevos: **7** (6 en W1 + 1 en W2) → **282/282**.

**Patrón (exemplar `validate/route.test.ts`)**: `vi.stubEnv` + `vi.stubGlobal("fetch", ...)`,
**sin module-mocks** → los tests ejercitan la integración **real** con `resolvePayoutAuthority`
(mayor fidelidad; un `vi.mock` del módulo podría ocultar un guard mal cableado).

**Helper nuevo** en `submit/route.test.ts` — `fetchRouter`: despacha por URL (Didit vs. agente) y
**registra las llamadas al agente por separado**, para que `expect(agentCalls).toHaveLength(0)`
pruebe literalmente "fetch al agente NUNCA invocado" (AC-1) aun cuando Didit sí se llamó.

| AC | Test | Setup | Espera |
|----|------|-------|--------|
| **AC-1** | *(nuevo)* `sin address → 400 payout_invalid_request; NINGÚN fetch` | BASE seteada, `validPayload` sin `address` | `400`, `{error:"payout_invalid_request"}`, `fetchMock` **not called** (ni Didit ni agente) |
| **AC-1** | *(nuevo)* `sin kycVerificationId → 400; NINGÚN fetch` | BASE seteada, sin `kycVerificationId` | idem |
| **AC-2** | *(nuevo)* `Didit Declined → 403 payout_not_authorized; agente NO invocado` | `DIDIT_API_KEY="test-key"`, `fetchRouter` → `{status:"Declined", session_id:"v-1"}` | `403`, `{error:"payout_not_authorized"}`, `agentCalls` = **0** |
| **AC-2** | *(nuevo)* `ownership mismatch (vendor_data ≠ address) → 403; agente NO invocado` | key + `{status:"Approved", session_id:"v-1", vendor_data:"0xOtherWallet"}`, `address:"0xSender"` | `403` (**mismo code que Declined → no-oracle, CD-12**), `agentCalls` = 0 |
| **AC-5** | *(nuevo)* `fetch a Didit throws (timeout) → 502 payout_authority_unavailable; agente NO invocado` | key + fetch de Didit `throw` | `502`, `{error:"payout_authority_unavailable"}`, `agentCalls` = 0 |
| **AC-5** | *(nuevo)* `VERCEL_ENV="preview" + sin DIDIT_API_KEY → 503; agente NO invocado` (DT-5) | `DIDIT_API_KEY=""`, `VERCEL_ENV="preview"`, BASE seteada | `503`, `{error:"payout_authority_unavailable"}`, `agentCalls` = 0 |
| **AC-3** | *(existente, intacto)* `sin REMIT_AGENTS_BASE_URL → 501, fetch NOT called` | — | Verde **sin tocar asserts**; prueba que el 501 va primero (CD-11) |
| **AC-4** | *(existente, intacto)* `con base + agente ok → 200 {result}` | env stubs → rama `simulated_dev` (local) → autorizado | Verde; sigue asertando `not.toContain("999888777")` (CD-5) + `idempotencyKey` (CD-10) |
| **AC-6** | *(los 7)* `npm run test app/api/a2a/payout/submit/route.test.ts` | — | **7/7 verdes, asserts byte-idénticos** |
| **AC-7** | *(existentes, intactos)* `bad_shape` + 2× MNR-C | — | Verdes (el guard corre **antes**, no altera el shape-check) |
| **DT-2** | *(nuevo, W2)* `submit recibe address` en `confirm-and-send.test.ts` | `vi.spyOn(payouts,"submit")`, `FakeWallet` → `"0xSender"` | `submitSpy.mock.calls[0]?.[0]?.address === "0xSender"` |
| **DT-1** | *(existentes, intactos)* `validate/route.test.ts` completo | — | **100% verde sin tocar asserts** = prueba de que la extracción no divergió (CD-10) |

**Regresión global**: `npm run qa` (incluye `flow.test.tsx`, `gateways.test.ts`, dominio).

---

## 8. Riesgo residual — qué cierra WKH-202 y qué NO (OBLIGATORIO en el done-report)

> **Cerrar WKH-202 NO habilita por sí solo la Fase A.** El gate de Fase A son **3 huecos
> independientes**; esta HU cierra **1**.

### Cierra (G1 — esta HU)
- `/api/a2a/payout/submit` deja de ser un proxy público sin auth: exige `kycVerificationId` +
  `address`, re-valida **server-side contra Didit** (`Approved` + ownership vía `vendor_data`) y
  **fail-closed** en cada rama (formato, autoridad caída, reason desconocido, simulación en Vercel).
- Vector cerrado: *"cualquiera en internet dispara un desembolso con **un `kycVerificationId`
  cualquiera** / sin KYC / con el KYC de otro"*.

### NO cierra (queda vivo tras el merge)
| # | Hueco | Dueño | Qué significa |
|---|-------|-------|---------------|
| **G2** | **`kycPayoutAllowed` sigue siendo un booleano del CALLER**: `remit-cashout-payout` confía en `input.kycPayoutAllowed` (`src/agents/cashout-payout.ts:82`) y `A2aPayoutGateway.submit()` lo manda **hardcodeado `true`** (`gateways.ts:127`). Quien llame **al agente directo** (no vía chaski-v2) se saltea TODO lo de esta HU. | **WKH-203** — repo `wasiai-remittance-agents`, **Scope OUT (CD-1/CD-15)** | El agente debe re-derivar el payout-allowed contra Didit server-side. **Este SDD NO diseña nada que dependa de que `kycPayoutAllowed` sea confiable**; el campo se conserva en el body (contrato cross-repo) con un comentario-puntero (W0.5). |
| **G3** | **Nadie verifica que el sender pagó el principal en USDC**, ni que `amountUsd`/`beneficiary` correspondan a una remesa cotizada real. Un atacante con **su propio KYC `Approved`** y **su propia `address`** pasa el guard de esta HU y pide un payout con **monto/beneficiario arbitrarios**. | **WKH-168** — value-delivery (quote-lock → principal-in → payout → reconcile → refund) | Consecuencia directa de DT-3 (sin persistencia server-side de quotes, `project-context.md:33-35`). **Decisión del humano (2026-07-15): fuera de esta HU.** Ningún mecanismo de *auth* lo cierra — ni (a) ni (b) de DT-4. |
| **R1** | El ownership es **best-effort**: si Didit no eco-a `vendor_data` (`d.vendorData === ""`), el check se **omite** (`validate/route.ts:88`, MNR-B de WKH-180). Además `address` es caller-controlado (sin SIWE) → un `verificationId` `Approved` robado + su `vendor_data` (dato conocido) pasa. | SIWE — deferred, `kyc-auth.ts:7`, **Scope OUT** | Heredado de WKH-180, **no lo agrava** esta HU. |
| **R2** | **Replay**: `idempotencyKey` se forwardea intacto (CD-10) sin unicidad-por-caller server-side. | WKH-168 / follow-up | Sin cambios respecto de hoy. |

**Recomendación al humano (no vinculante)**: `REMIT_AGENTS_BASE_URL` **no** debería setearse en prod
hasta que **G2 (WKH-203)** también esté DONE; hasta entonces la única protección real de un
desembolso es `PAYOUT_ALLOW_MOCK` del lado del agente. **G3 (WKH-168)** define si la Fase A puede
desembolsar **dinero real** o sólo mock.

---

## 9. Constraint Directives (CD-N)

**Heredados del work-item (VIGENTES, sin cambios):**
- **CD-1**: PROHIBIDO tocar `chaski-ai.vercel.app`, `wasiai-agentshop`, el gateway a2a, o código de `yarvis`/`agentshop-*`.
- **CD-2**: PROHIBIDO arrastrar los MENORes de la auditoría adversarial #2 (PII over-transmission en `didit/decision.ts:73-83`, TTL AML client-only, over-refund parcial, CAS cross-tab TOCTOU). **Aplica también a WKH-203 y WKH-168: se documentan (§8), NO se implementan acá.**
- **CD-3**: PROHIBIDO debilitar/saltear/flaggear `confirm_requires_kyc_passed` (`remittance.ts:227-234`) ni remover/condicionar `authority.authorize()` de `confirm-and-send.ts`.
- **CD-4**: OBLIGATORIO fail-closed en TODOS los guards nuevos; ante duda/error/timeout → rechazar, NUNCA autorizar por default.
- **CD-5**: PROHIBIDO loguear o ecoar `beneficiary`/PII en cualquier código nuevo.
- **CD-6**: OBLIGATORIO preservar los 7 tests de `submit/route.test.ts` en verde; los nuevos se AGREGAN.

**Nuevos de este SDD:**
- **CD-7** *(auto-blindaje WKH-198)*: el import nuevo en `app/api/a2a/payout/submit/route.ts` va por **ruta RELATIVA** (`../../../../src/infrastructure/payout/authority`). **PROHIBIDO `@/`** — vitest no resuelve el alias.
- **CD-8** *(auto-blindaje WKH-201)*: PROHIBIDO cerrar una wave con `tsc` rojo en un archivo no listado en §4.1/§6. Si aparece → reportar como desviación.
- **CD-9** *(MEMORY WKH-196)*: el gate de verificación es **`npm run qa`** (`tsc --noEmit` **+** `vitest run`). **PROHIBIDO validar sólo con `npm run build`.**
- **CD-10**: PROHIBIDO cambiar el comportamiento observable de `/api/payout/validate` (está live y verificado: body vacío → 400 `invalid_verification_id`). La extracción es un **move mecánico**; sus tests deben pasar **sin tocar un solo assert**. Los `reason` y status de cada rama se preservan **literalmente**, incluida la **ausencia** de la clave `reason` en `{authorized:true}`.
- **CD-11**: OBLIGATORIO que `if (!BASE) → 501` siga siendo el **PRIMER** guard, antes de cualquier llamada a la autoridad (AC-3 + el test existente assertea `fetch` not-called).
- **CD-12** *(no-oracle)*: PROHIBIDO ecoar el `reason` de la autoridad en la respuesta de submit. `kyc_not_approved` y `kyc_ownership_mismatch` deben devolver el **mismo** `403 payout_not_authorized`.
- **CD-13** *(anti fail-open, lección WKH-198)*: el `switch` de mapeo lleva **`default` → 502 fail-closed**. PROHIBIDO un `default` que forwardee. PROHIBIDO `authorized = true` como valor inicial/por-default de cualquier variable del guard.
- **CD-14** *(cross-repo)*: PROHIBIDO **remover** `kycPayoutAllowed` del body de `gateways.ts:127` — es contrato cross-repo, su arreglo es **WKH-203**. Sólo se agrega el comentario-puntero. PROHIBIDO tocar el repo `wasiai-remittance-agents`.
- **CD-15**: PROHIBIDO diseñar/implementar cualquier cosa que **dependa** de que `kycPayoutAllowed` sea un campo confiable del body (WKH-203 lo vuelve no-autoritativo).
- **CD-16**: PROHIBIDO crear persistencia server-side de quotes/remesas (quote-registry Upstash o equivalente) y PROHIBIDO agregar env vars/secretos nuevos. Decisión del humano 2026-07-15 (§2, Missing Input #1) + consecuencia de DT-4(a).
- **CD-17**: `src/infrastructure/payout/authority.ts` es **server-only** (lee `DIDIT_API_KEY`). PROHIBIDO importarlo desde `src/presentation/**` o cualquier código que llegue al bundle del cliente.

> **Corrección a un gotcha del input** *(para el dev)*: `chaski-v2` **NO tiene `tsconfig.build.json`**
> (eso es de `wasiai-a2a`). Acá `tsconfig.json` incluye `src/**/*.ts` y `app/**/*.ts` → **`npx tsc --noEmit`
> (= `npm run typecheck`) SÍ cubre los `*.test.ts`**. `npm run qa` es typecheck + test. La lección de
> WKH-196 igual aplica (CD-9): no aprobar con sólo `build`.

---

## 10. Readiness Check

| # | Item | Estado |
|---|------|--------|
| 1 | Work item leído completo, ACs mapeados a diseño | ✅ 7/7 ACs con diseño + test |
| 2 | `project-context.md` leído; sin drift con el código | ✅ Confirmado `localStorage`-only (base de DT-3) |
| 3 | Exemplars verificados en disco (Read/Grep) | ✅ 6/6 (§3.2) |
| 4 | Missing Input #1 (BLOQUEANTE) resuelto | ✅ Decisión del humano 2026-07-15 → KYC+ownership; WKH-168 fuera (§2) |
| 5 | Missing Input #2 (DT-4) resuelto + trade-off justificado + descarte documentado | ✅ Opción (a) (§4.3), con lo que **no** mitiga |
| 6 | Missing Input #3 (HTTP) resuelto con criterio | ✅ advisory/action → 400/403/502/503 (§4.5) |
| 7 | DT-1 (anti-divergencia) con refactor exacto + no rompe `/api/payout/validate` | ✅ §4.2 + CD-10 |
| 8 | DT-2 blast radius: **todos** los consumidores enumerados vía grep | ✅ §6 — breaker real = `gateways.test.ts:20`; `test-container.ts` verificado NO afectado |
| 9 | Precedente WKH-201 anticipado explícitamente | ✅ §6 |
| 10 | Auto-Blindaje histórico leído (3 HUs) → CDs preventivos | ✅ CD-7/CD-8/CD-9 |
| 11 | Waves con W0 serial de contratos y orden lógico | ✅ §5 (W0 → W1 ∥ W2 → W3) |
| 12 | CDs del work-item heredados (6/6) + nuevos (11) | ✅ §9 |
| 13 | Riesgo residual explícito nombrando G2/WKH-203 y G3/WKH-168 | ✅ §8 |
| 14 | Test plan ≥1 por AC; AC-6 preservado (7 asserts intactos) | ✅ §7 — 275 → 282 |
| 15 | Sin `[NEEDS CLARIFICATION]` abiertos | ✅ Ninguno |
| 16 | Comando de verificación fijado | ✅ `npm run qa` (CD-9) |
| 17 | Scope IN sin arrastre (CD-2/CD-14/CD-16) | ✅ Sin persistencia nueva, sin env nueva, sin cross-repo |

### Puntos de atención para el gate SPEC_APPROVED (visibilidad, no bloqueantes)

1. **AC-6 — juicio del Architect (el único punto opinable)**: el guard exige `address`, que
   `validPayload` (fixture compartido, `route.test.ts:14-21`) **no** tiene. El diseño agrega
   `address` al **fixture** y un `beforeEach` de env (§4.7) — **setup**, no asserts. Los 7 tests
   conservan sus asserts y su comportamiento esperado **byte-idénticos** (lectura literal de AC-6:
   *"sin modificar sus asserts"*). La alternativa —hacer `address` opcional— sería un **fail-open**
   (el atacante lo omite y se saltea ownership) → prohibido por CD-4.
2. **DT-5 (§4.6) es un pequeño agregado más allá del work-item literal**: rechazar `simulated_dev`
   en Vercel. Es un fail-open **real** que aparece al reusar la rama de simulación en el money-path
   (preview + BASE seteada + sin key → payout autorizado por simulación). Se justifica bajo AC-5
   ("falta una env var requerida por el guard → fail-closed"), cuesta 3 líneas y **no** agrega env
   vars. Si el humano prefiere scope literal, se puede cortar sin tocar el resto del diseño.
3. **§8 debe viajar al done-report**: cerrar WKH-202 **no** habilita la Fase A (faltan WKH-203 y
   WKH-168).

---

*Generado por nexus-architect — NexusAgil F2. Próximo paso: gate **SPEC_APPROVED** (texto exacto).
El Story File (F2.5) se genera DESPUÉS del gate, nunca antes.*
