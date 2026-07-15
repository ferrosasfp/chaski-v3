# Report — HU [WKH-202] [GATE Fase A] Hardening del enforcement de `/api/a2a/payout/submit`

## Resumen ejecutivo

**WKH-202** cierra el vector de **broken authorization / IDOR** en `/api/a2a/payout/submit`: el endpoint dejó de ser un proxy POST público sin auth que forwardeaba `amountUsd`/`beneficiary`/`kycVerificationId` verbatim al agente `remit-cashout-payout`. Ahora exige **verificación server-side** de KYC (`Approved` + ownership del `address` contra Didit) y es **fail-closed en cada rama** (formato, autoridad caída, reason desconocido, simulación en Vercel). El enforcement reutiliza sin divergencias la lógica de `app/api/payout/validate/route.ts` (WKH-180, live, verificada) extraída a un módulo compartido (`resolvePayoutAuthority`). **Veredicto final**: F0–F1–F2–SPEC_APPROVED–F2.5–F3–AR(1 BLQ)→fix-pack→re-AR(0 BLQ)–CR(5 MNR)–F4–**APROBADO PARA DONE**. Código listo para merge.

---

## Pipeline ejecutado

| Fase | Artefacto | Veredicto | Fecha |
|------|-----------|-----------|-------|
| F0 | project-context | cargado (`chaski-v2` standalone, post-WKH-201) | 2026-07-15 |
| F1 | `work-item.md` (WKH-202) | HU_APPROVED (2 Missing Inputs BLOQUEANTES, ambos resueltos en F2/humano) | 2026-07-15 |
| F2 | `sdd.md` | SPEC_APPROVED (resoluciones: DT-3 = KYC+ownership sin persistencia; DT-4 = opción (a), re-validación inline; Missing #3 → HTTP 400/403/502/503; 17 CDs preventivos, incl. CD-7/8/9 anti-auto-blindaje) | 2026-07-15 |
| F2.5 | `story-WKH-202.md` | contrato listo para F3 (waves definidas, gates, exemplars de ref verificados) | 2026-07-15 |
| F3 | Implementación | COMPLETA: W0 (contratos + módulo `resolvePayoutAuthority`) + W1 (guard + tests) + W2 (propagación client-side). 11 archivos (1 nuevo, 10 modificados). +12 tests. 287/287 verde. | 2026-07-15 |
| AR | `ar-report.md` | **1 BLOQUEANTE-BAJO**: body JSON `null` → 500 crudo (AC-1 exige 4xx, contrato del archivo lo prohíbe). Fail-closed (no forwardeaba), pero violaba contrato. 0 MENOREs AR. | 2026-07-15 |
| fix-pack | 1 commit | Body parseo: `unknown` + `isRecord()` (§ 9 de auto-blindaje). +4 tests (`it.each` de bodies no-record). 282→287 verde. | 2026-07-15 |
| re-AR | `ar-report.md` revisado | **0 BLOQUEANTES**. fix-pack validado. | 2026-07-15 |
| CR | `cr-report.md` | APPROVED (0 BLOQUEANTES, 5 MENOREs: MNR-4 "forward path live sin test" — cubierto en fix-pack; MNR-2/3 sobre `/api/payout/validate` live, CD-10 los preserva; MNR-5/6 sobre deuda técnica de imports/booleanos, aceptados). | 2026-07-15 |
| F4 | `validation.md` (QA) | **APROBADO PARA DONE** (287/287 tests, tsc limpio, CD-7/CD-9/CD-17 verificados, §8 riesgo residual documentado en runtime). | 2026-07-15 |

---

## Acceptance Criteria — resultado final (7/7 PASS)

| AC | Descripción | Status | Evidencia (archivo:línea) | Validación |
|----|---|---|---|---|
| **AC-1** | POST sin credencial de auth → 4xx + `fetch` NO invocado | **PASS** | `route.ts:57-63` guard formato; `route.test.ts:152-160,162-170,176-189` (`it.each` 4 bodies no-record → 400, fetchMock never called) | vitest 287/287 |
| **AC-2** | `authorized:false` (any reason) → sin forward al agente | **PASS** | `route.ts:78-96` switch `!d.authorized`; `route.test.ts:208-217` (Declined → 403); `:219-231` (ownership mismatch → 403); ambos `agentCalls: 0` | vitest PASS |
| **AC-3** | 501 `a2a_not_configured` intacto (guard `!BASE` primero, independiente del guard nuevo) | **PASS** | `route.ts:44-46` sin cambios; `route.test.ts:63-71` test preexistente byte-idéntico | vitest PASS |
| **AC-4** | Autorizado + agente ok → forward preservando PII-free + idempotencyKey (CD-5/CD-9/CD-10) | **PASS** | `route.ts:96-110` forward block sin cambios; `route.test.ts:73-89` (idempotencyKey intacto, PII-free); `route.test.ts:195-206` (MNR-4: forward real vía Didit simul. → 200) | vitest PASS |
| **AC-5** | Fallo técnico (timeout/DNS/missing env) → fail-closed (rechazar, NUNCA autorizar default) | **PASS** | `authority.ts:56-91` try/catch Didit → `kyc_reauth_failed`; `route.test.ts:233-242` (throw → 502); `:244-255` (DT-5 Vercel preview sin key → 503); ambos agente nunca invocado | vitest PASS |
| **AC-6** | Los **8** tests preexistentes **byte-idénticos en asserts** (setup: `beforeEach`/`stubEnv` + `address: "0xSender"` en fixture, permitidos) | **PASS** | `route.test.ts:63-148` (8 tests, asserts sin cambios per `git diff -U0`); verificado por AR/CR/re-AR independiente | vitest 8/8 preexist. PASS |
| **AC-7** | `isValidPayoutResult` (shape del agente) rechaza invalid → 502 sin cambios | **PASS** | `route.ts:26-40` sin cambios; `route.test.ts:99-105` (bad_shape → 502); `:107-118`, `:120-129` (MNR-C payoutId-null); `:131-138` todos byte-idénticos | vitest PASS |

---

## Hallazgos finales

### BLOQUEANTEs
Ninguno post-fix-pack. (1 BLQ-BAJO-1 del AR → resuelto en fix-pack por dev + re-AR 0 BLQ).

### MENOREs (5, aceptados / bajo seguimiento)

1. **MNR-4 (CR)**: Forward path (vía Didit simulado) estaba **live en producción sin test**. El `beforeEach` de route.test.ts fijaba `DIDIT_API_KEY=""` → **rama simulada**, test mock del agente OK. El caso **real** (con key, fetch a Didit, forward) quedaba sin cobertura. **Fix**: `route.test.ts:195-206` agrega test explícito del forward con Didit simulado (status `Approved`, ownership OK) → autorizado → forward → 200. Verificado en fix-pack.

2. **MNR-2 (AR, re-AR)**: CD-12 ("no-oracle") es **decorativo a nivel repo** — `/api/payout/validate` es **público sin auth, sin rate-limit**, y ecoa el `reason` verbatim en la respuesta (líneas 73-93 de `validate/route.ts`, no tocadas por CD-10). El oráculo de estado KYC que CD-12 niega en `submit` ya está servido en el endpoint de al lado. **Estado**: documentado en `route.ts:8-14` (cabecera) como riesgo residual §8, **no bloqueante para WKH-202** (WKH-180 fue quien lo introdujo). **Follow-up**: WKH-205.

3. **MNR-3 (CR/re-AR)**: El **mismo bug de body `null` → 500** sigue **live** en `/api/payout/validate:12-16` (heredado de WKH-180). CD-10 prohíbe cambiar el comportamiento observable de esa ruta (está verificada, en prod, 3 HUs confiando en ella). **Estado**: preservado intencionalmente, no tocado. **Follow-up**: WKH-205.

4. **MNR-5 (CR)**: `isRecord()` no excluye arrays (`isRecord([])` devuelve `true` porque son Object). **Impacto**: con `curl -d '[]'`, el guard pasa el `isRecord()` → acceso a `body.kycVerificationId` → `undefined` → guard de formato → 400. **No explotable**, path ya 4xx. Comentario impreciso en `route.ts:21-23` ("record-like" debería ser "object non-array"). **Aceptado como TD** (MNR, no bloquea DONE).

5. **MNR-6 (CR)**: `it.each` en `route.test.ts:176-180` faltan tipado `boolean` (los 4 casos son todos true, pero el parámetro `isValidRecord` desaparece del type check). **Aceptado como deuda**, cubierto por el test mismo (no rompe el verde).

---

## Riesgo residual explícito — qué cierra WKH-202 y qué NO

> **CRÍTICO: Cerrar WKH-202 NO habilita por sí solo la Fase A.** El gate de Fase A son **4 huecos independientes**; esta HU cierra **G1**.

### Cierra (G1 — esta HU)
- `/api/a2a/payout/submit` deja de ser un proxy público sin auth: exige `kycVerificationId` + `address`, re-valida **server-side contra Didit** (`Approved` + ownership vía `vendor_data`) y es **fail-closed** en cada rama (formato, autoridad caída, reason desconocido, simulación en Vercel).
- **Vector cerrado**: *"cualquiera en internet dispara un desembolso con **un `kycVerificationId` cualquiera** / sin KYC / con el KYC de otro"* ← **ESTA HU LO CIERRA**. Pero no es suficiente para habilitar la Fase A.

### NO cierra (queda vivo tras el merge) — OBLIGATORIO en el done-report per §8 del SDD

| # | Hueco | Dueño | Qué significa |
|---|-------|-------|---------------|
| **G2** | **`kycPayoutAllowed` sigue siendo un booleano del CALLER**: `remit-cashout-payout` confía en `input.kycPayoutAllowed` y `A2aPayoutGateway.submit()` lo manda **hardcodeado `true`** (`gateways.ts:127`). Quien llame **al agente directo** (no vía chaski-v2) se saltea TODO lo de esta HU. | **WKH-203** — repo `wasiai-remittance-agents`, **Scope OUT (CD-14/CD-15)** | El agente debe re-derivar el payout-allowed contra Didit server-side. Comentario-puntero en `gateways.ts:127` nombra WKH-203. |
| **G3** | **Nadie verifica que el sender pagó el principal en USDC**, ni que `amountUsd`/`beneficiary` correspondan a una remesa cotizada real. Un atacante con **su propio KYC `Approved`** y **su propia `address`** pasa el guard de esta HU y pide un payout con **monto/beneficiario arbitrarios**. | **WKH-168** — value-delivery (quote-lock → principal-in → payout → reconcile → refund) | Consecuencia de DT-3 (sin persistencia server-side de quotes, `project-context.md:33-35`). **Decisión del humano (2026-07-15)**: fuera de esta HU. Ningún mecanismo de *auth* lo cierra. |
| **R1** | El ownership es **best-effort**: si Didit no ecoa `vendor_data` (`d.vendorData === ""`), el check se **omite**. Además `address` es caller-controlado (sin SIWE) → un `verificationId` `Approved` robado + su `vendor_data` pasa. | SIWE — deferred, `kyc-auth.ts:7`, **Scope OUT** | Heredado de WKH-180. Esta HU no lo agrava. |
| **R2** | **Replay**: `idempotencyKey` se forwardea intacto (CD-10) sin unicidad-por-caller server-side. | WKH-168 / follow-up | Sin cambios respecto de hoy. |

**Regla operativa — NO setear `REMIT_AGENTS_BASE_URL` en prod hasta:**
- **WKH-203** esté DONE (cierra G2)
- **WKH-168** esté DONE (cierra G3)
- Ambas en `main` y deploycadas

---

## Auto-Blindaje consolidado

### Hallazgo de proceso: desviación de artefacto sobre recuento (7-vs-8 tests)

*Ver `auto-blindaje.md:3-30` — lección aplicable a futuras HUs: verificar números de artefactos con `grep -c` o salida del runner ANTES de escribir, no a ojo.*

### Hallazgo de implementación: Body JSON `null` → 500 crudo (BLQ-BAJO-1)

*Ver `auto-blindaje.md:32-67` — **bug real**: `req.json()` sobre `null` **resuelve** con `null` (JSON válido, no error de parse). El cast `as {...}` enmascaró el problema. Fix: tipar como `unknown` + `isRecord()` antes de acceder a campos. Aplica a TODO `app/api/**/route.ts`.*

### Lecciones nuevas (esta HU, WKH-202)

#### [2026-07-15] F3 — Trampa del `git stash` en una HU unstaged + falta de tests del path live
- **Error**: durante el fix-pack, dos agentes se atraparon revirtiendo a `HEAD` con `git stash` en un repo sin commits (cambios unstaged). El resultado: revertía a la versión pre-HU, no a "la HU menos el fix". No hay forma de reproducir un estado "pre-fix, post-F3 original" con `git show` cuando todo está unstaged. Solución: revertir **sólo la línea específica** o aislar la semántica en un script standalone de prueba.

#### [2026-07-15] F3 — `git diff` de un archivo untracked retorna vacío (no es evidencia de "cero cambios")
- **Error**: al verificar que `/api/payout/validate/route.ts` estaba **intacto** (CD-10), un agente hizo `git diff app/api/payout/validate/route.ts` — resultado: vacío (el archivo NO estaba staged ni es untracked, pero el diff-sin-contexto no captura que se invocó con cambios unstaged en otro archivo). Solución aplicada por re-AR: diff **solo las líneas ejecutables** contra `git show HEAD:app/api/payout/validate/route.ts` (la fuente real).

#### [2026-07-15] Patrón recurrente: 3 artefactos contaron mal (F2 + F2.5 propagación)
- **Observación**: WKH-202 replicó WKH-201/198 en que los artefactos contaron incorrectamente (5→7 imports, 4→5 niveles, 7→8 tests). Los agentes que **verificaron ejecutando** (`npm run test`, `grep -c`, `git diff -U0 | grep expect`) acertaron siempre. Los que contaron **leyendo** manualmente, fallaron. **Regla**: números en ACs = ejecuta un comando, nunca manual.

---

## Archivos modificados

| Archivo | Wave | Cambio | LOC |
|---------|------|--------|-----|
| `src/infrastructure/payout/authority.ts` | W0 | **NUEVO** — `resolvePayoutAuthority()` + `PayoutAuthorityDecision` (move de `validate/route.ts:16-102`, lógica idéntica, servidor-only) | +95 |
| `app/api/payout/validate/route.ts` | W0 | MOD — wrapper delgado (comportamiento byte-idéntico, CD-10 verificado por CR) | -80, +8 |
| `src/application/ports.ts` | W0 | MOD — `PayoutSubmit.address: string` (requerido, DT-2) | +3 |
| `src/application/use-cases/confirm-and-send.ts` | W0 | MOD — propaga `address` al `payouts.submit()` (L105) | +1 |
| `src/infrastructure/a2a/gateways.ts` | W0 | MOD — forwardea `address` + comentario → WKH-203 (CD-14) | +3 |
| `src/infrastructure/a2a/gateways.test.ts` | W0 | MOD — literal tipado + 1 assert (breaker de tsc, §6 del SDD) | +2 |
| `app/api/a2a/payout/submit/route.ts` | W1 | MOD — **el guard de autorización** + no-oracle (CD-12) + DT-5 (Vercel preview) | +54 |
| `app/api/a2a/payout/submit/route.test.ts` | W1+fix | MOD — `beforeEach`/`afterEach` env stubs + `address` fixture + **8 tests nuevos** (AC-1/2/5 + MNR-4 + BLQ-BAJO-1 x4) | +137 |
| `src/application/use-cases/confirm-and-send.test.ts` | W2 | MOD — +1 test (`submit` recibe `address`) | +8 |
| `.env.example` | W2 | MOD — notas: gate WKH-202, acoplamiento `DIDIT_API_KEY`, puntero WKH-203/WKH-168 | +10 |
| `tsconfig.tsbuildinfo` | build artifact | (sin cambio de fuentes) | — |

### Nuevos (1)
- `src/infrastructure/payout/authority.ts` — módulo compartido de re-validación Didit.

---

## Decisiones diferidas a backlog

- **WKH-203**: re-derivar `kycPayoutAllowed` en el agente `remit-cashout-payout` server-side (cierra G2).
- **WKH-168**: value-delivery real (quote-lock, principal-in, payout, reconcile, refund; cierra G3).
- **WKH-205**: follow-up MENOREs — MNR-2/3 (CD-12 decorativo, `/api/payout/validate` live sigue asertando reason).

---

## Lecciones para próximas HUs

1. **Fail-closed por defecto en cada rama**: El patrón WKH-202 (y WKH-198) demostró que **cada decisión del flujo debe tener una rama explícita para "rechazar"**. No hay valor por defecto. El `switch` tiene `default → 502` fail-closed. Los guards están ordenados (§4.4 del SDD) de forma que el PRIMER error mata el flujo antes de tocar I/O. **Anti-patrón**: un `if (authorized)` sin `else` que deja continuar.

2. **Reutilización estricta sin divergencia (CD-1 anti-pattern)**: Cuando una lógica crítica vive en múltiples sitios, extraerla a un módulo exportado y reusar **por construcción**. No hay refactor "futuro". WKH-202 aprendió de WKH-180/181 que "luego unificamos" → nunca ocurre. `resolvePayoutAuthority` es **una implementación, un lugar donde equivocarse**.

3. **Verificación de artefactos: números requieren comandos**: Frases como "los 7 tests", "las 4 rutas" NO se escriben a ojo. `grep -c`, `npm run test --`, `git diff --stat` — cada número se verifica antes de ponerlo en AC. Si en F3 el número real difiere: no ocultar, documentar en auto-blindaje de inmediato (referencia para F4/retro).

4. **Body parsing en rutas: `unknown` + type-guard antes de acceder**: `req.json()` devuelve `unknown`. El `.catch()` NO cubre `null`. El cast `as {...}` es mentira. La regla: `const parsed: unknown = await req.json().catch(() => null); const body = isRecord(parsed) ? parsed : {}` — tipado correcto + estrecho obligatorio, antes de cualquier acceso. Buscar en CR: `as Record<...>` sobre retorno de `req.json()`.

5. **Orden de guards es semántica, no cosmética**: CD-11 del SDD explica por qué `!BASE → 501` va **primero**: AC-3 lo exige, y el test existente assertea "no fetch". Si alguien la reordena, rompe AC-6 silenciosamente. **Regla**: los guards de "configuración defecto" van primero (antes de I/O), luego formatos, luego llamadas externas. Documentar el orden en un comentario.

6. **Productos multi-repo y cross-repo contracts**: WKH-202 toca `chaski-v2` pero su éxito depende de WKH-203 en `wasiai-remittance-agents`. Ninguna rama de error debe asumir cambios en otro repo. El campo `kycPayoutAllowed` se preserva "temporalmente" (comentario-puntero) porque sacarlo acá no cierra G2 — de hecho, lo abre. **Regla**: un "TODO en X" en la prosa del code es una **deuda; un "TODO en WKH-NN"** es una **dependencia**. Las dependencias van explícitas en el SDD §8.

---

## Merge & Deploy

- **Código listo**: 11 archivos, 287/287 verde, tsc limpio, CD-7/CD-9/CD-17 verificados.
- **Status**: Unstaged en `main`. El orquestador maneja el commit.
- **Next**: Merge a `main` sin rebase (respeta el cherry-pick que ya ocurrió en F3). Deploy a staging → validación manual de los 6 endpoints touchados (quote, submit, validate, fallback, la ruta de confirm-and-send). **CRÍTICO**: no setear `REMIT_AGENTS_BASE_URL` en prod hasta WKH-203 + WKH-168 DONE.

---

*Generado por nexus-docs — NexusAgil DONE. Próximo paso: orquestador presenta el reporte al humano y cierra la HU.*
