# Report — HU [WKH-179] Cerrar IDOR PII + auth/rate-limit en /api/kyc/*

**Status**: DONE (2026-07-10)
**Repo**: `chaski-v2/`
**Branch**: `fix/179-kyc-idor-auth-ratelimit`

---

## Resumen ejecutivo

WKH-179 cierra tres vulnerabilidades de seguridad en las rutas de KYC Didit (`/api/kyc/session/*`, `/api/kyc/decision/*`):

1. **B1 — IDOR de PII**: `GET /decision` devolvía identidad completa (DNI, fecha nacimiento, nombres) sin autenticación. **Cerrado**: token HMAC stateless emitido en `/session`, exigido en `/decision` con verificación timing-safe. Garantía: un atacante sin el secreto no puede forjar el token.
2. **A2 — Financial-DoS**: `POST /session` sin rate-limit disparaba verificación Didit (cuota pagada). **Cerrado**: Upstash Redis rate-limit (IP + address, sliding window) evaluado **antes** de Didit; fail-closed si Upstash no configurado en prod.
3. **M6 — SSRF/open-redirect**: `callback` del body se reenviaba crudo a Didit. **Cerrado**: callback ignorado, reconstruido server-side desde env allow-listed.

**Adicionales**: Masking de `documentNumber` (últimos 4 en claro) como defensa en profundidad. Anti-enumeración: mismo status/body para "sin token" vs "token inválido".

**Entregables**:
- 17 archivos (helpers + rutas + use-cases + tests + env): `src/infrastructure/{kyc-auth,rate-limit}.ts` (NEW), `app/api/kyc/{session,decision}/route.ts` (modificadas), 5 archivos de test (NEW), tipos + ports extendidos, env vars documentadas.
- 79/79 tests en verde (tsc 0 errores, vitest 79 PASS, build OK).
- Auto-Blindaje consolidado: 2 hallazgos de tipo-checking + 3 MENORs de seguridad (todos fixeados).

---

## Pipeline ejecutado

| Fase | Status | Gate | Artefactos |
|------|--------|------|-----------|
| **F0** | ✅ DONE | — | `work-item.md` (grounding F0, líneas exactas codebase) |
| **F1** | ✅ DONE | HU_APPROVED | `work-item.md` completado; 10 ACs EARS definidas |
| **F2** | ✅ DONE | SPEC_APPROVED | `sdd.md` (diseño completo, §10 sin `[NEEDS CLARIFICATION]` pendientes) |
| **F2.5** | ✅ DONE | — | `story-file.md` (contrato Dev, waves W0–W3, 17 archivos scope IN) |
| **F3 (W0)** | ✅ DONE | — | Scaffolding: `kyc-auth.ts`, `rate-limit.ts`, tipos ports, helpers masking, `.env.example` |
| **F3 (W1)** | ✅ DONE | — | Rutas guards (501→500→auth/RL→Didit→issue/mask en ambas) |
| **F3 (W2)** | ✅ DONE | — | Integración cliente: `kyc-gateway.ts`, use-cases (`start-kyc`, `resume-kyc`), tests end-to-end |
| **F3 (W3)** | ✅ DONE | — | QA final: `npm run qa`, `npm run build` |
| **AR** | ✅ APROBADO | — | `ar-report.md`: 0 BLOQUEANTES, 2 MENOR (IP-spoofing vía XFF, bucket address) → fixeados |
| **CR** | ✅ APPROVED | — | `cr-report.md`: 0 BLOQUEANTES, 1 MENOR (window validation) → fixeado |
| **F4 (QA)** | ✅ APROBADO PARA DONE | — | `f4-report.md`: 10/10 ACs PASS (método test+inspección), 79/79 tests, 15/15 CDs cumplidos |

**Pipeline status**: VERDE SIN BLOQUEOS. Cero BLOQUEANTES finales. 3 MENORs con deuda técnica cerrada (todos en fix-pack con tests de regresión propios).

---

## Acceptance Criteria — resultado final

| AC | Status | Método | Evidencia |
|----|--------|--------|-----------|
| **AC-1** | PASS | Test + inspección | Token HMAC exigido en `GET /decision` con header `x-kyc-token`. Test `decision/route.test.ts:26-35` verifica auth válido → 200. Implementación: `kyc-auth.ts:issueSessionToken`, `decision/route.ts:25-28`. |
| **AC-2** | PASS | Test + inspección | Sin token o token inválido → `401` SIN fetch a Didit. Tests `decision/route.test.ts:37-44` (sin token), `:46-53` (token errado), `:55-62` (IDOR directo) — todos assertan `fetchMock` no-invocado. Mismo status/body para ambos casos (anti-enum, CD-5). |
| **AC-3** | PASS | Test + inspección | `documentNumber` enmascarado a últimos-4 (`****6677`); `firstName`/`dateOfBirth`/nombres intactos. Mapeo puro: `decision.ts:60-65` `maskIdentity`. Ruta aplica: `decision/route.ts:39` `maskDecision(mapDiditDecision(...))`. Test `decision/route.test.ts:26-35`. |
| **AC-4** | PASS | Test + inspección | `501 didit_not_configured` cuando falta `DIDIT_API_KEY`/`DIDIT_WORKFLOW_ID`, evaluado PRIMERO (antes de auth/rate-limit). Aplicado en ambas rutas L13-14/L36-38. Tests `decision/route.test.ts:64-68`, `session/route.test.ts:38-46` — rate-limit NO invocado. |
| **AC-5** | PASS | Test + inspección | `POST /session` requiere identidad de caller (IP → extraída de `x-vercel-forwarded-for`/`x-real-ip`) ANTES de invocar Didit. Guardado en rate-limit helper. Test `session/route.test.ts:55-60`. |
| **AC-6** | PASS | Test + inspección | Rate-limit excedido → `429 rate_limited` + header `Retry-After` SIN fetch a Didit. Tests `session/route.test.ts:90-98` (429), `:100-108` (503 fail-closed si Upstash ausente). |
| **AC-7** | PASS | Test | Ninguna llamada a Didit si rechazada por auth (AC-2/AC-5) o rate-limit (AC-6). Verificado transversalmente: tests `decision/route.test.ts:37-44,46-53,55-62` y `session/route.test.ts:38-46,90-98,100-108` — todos assertan `!fetchMock.toHaveBeenCalled()`. |
| **AC-8** | PASS | Test + inspección | `callback` del body ignorado; reconstruido server-side desde `KYC_CALLBACK_BASE_URL` env. Implementación `session/route.ts:60-61,66-70`. Test `session/route.test.ts:110-121`. |
| **AC-9** | PASS | Test | `body.callback="http://evil"` **NUNCA** reenviado a Didit. Test `session/route.test.ts:110-121` assertan body Didit `!toContain("evil")`, y `:123-133` verifica ausencia callback si env vacío. |
| **AC-10** | PASS | Test | Modo simulación intacto (sin `DIDIT_API_KEY` → fallback). Tests `kyc-gateway.test.ts:27-33,111-119` — `start()` delega en `FallbackKycGateway`, sin exigir token/Upstash. |

**10/10 ACs PASS — cero excepciones. Método: 79/79 tests automáticos + inspección cruzada archivo:línea de artefactos generados.**

---

## Hallazgos finales

### Bloqueantes
**NINGUNO.** El pipeline completó sin rechazos en AR/CR/F4.

### Menores (3 — todos fixeados, con regresión cerrada)

| # | Hallazgo | Impacto | Fix | Test |
|---|----------|--------|-----|------|
| **MNR-1** | IP source `x-forwarded-for` left-to-right spoofeable en Vercel | Rate-limit bypass | Prioridad `x-vercel-forwarded-for` → `x-real-ip` → XFF **right-most** (no left) | `session/route.test.ts:62-88` (3 casos) |
| **MNR-2** | Bucket IP condicionado a `vendorData` → attacker sin `vendorData` sin rate-limit | Incremento DoS opportunity | IP siempre se chequea (incondicional); default endurecido `KYC_RL_IP_MAX=5` | `rate-limit.test.ts:71-79` |
| **MNR-3** | `KYC_RL_IP_WINDOW` malformada (ej. `"diez minutos"`) pasa sin validar a Upstash | Potencial NaN/error runtime | Helper `win()` valida regex; fallback a `"10 m"` | `rate-limit.test.ts:81-88` |

**Deuda técnica**: Ninguno diferido a backlog. Los 3 MENORs fueron cerrados en el mismo ciclo F3.

---

## Auto-Blindaje consolidado

### Lecciones de tipo-checking

| Lección | Contexto | Aplicar en |
|---------|----------|-----------|
| **Derivar tipos de librerías, no inventarlos** | `Duration` type en Upstash: error TS2345 por alias manual incorrecto. Fix: `type Duration = Parameters<typeof Ratelimit.slidingWindow>[1]` | Cualquier wrapper de lib con tipos template-literal. Usar `Parameters<>`, `ReturnType<>` en vez de reimplementar. |
| **`noUncheckedIndexedAccess` exige optional chaining / non-null** | Array access `calls[0][1]` falló TS2532 porque vitest infiere `calls: []`. Además `.split(",")[0].trim()` exige `[0]?.trim()` o `[0]!.trim()`. | Tipá los `vi.fn(...)` con firma explícita (`(_url: string, init: RequestInit) => ...`). En prod, usa optional chaining o `!` deliberado. |

### Lecciones de seguridad (documentadas en CDs)

- **Token stateless HMAC válido para IDOR pero no para wallet-proof**: El token cierra la vulnerabilidad (atacante sin secreto no puede forjarlo) pero es replayable si se filtra. SIWE queda deferred. Aceptado para hackathon/prod-inicial. — **Aplicar**: documentar el límite en `kyc-auth.ts` docstring.
- **Fail-closed de rate-limit en prod**: Upstash ausente con Didit configurado → `503`. En simulación (sin Didit), nunca se invoca. **Aplicar**: prerequisito operacional en deploy (env vars Upstash en Vercel, confirmado en `.env.example`).
- **Guard-order crítico**: Orden exacto (501 → 500 → auth/rate-limit → Didit) previene exposición a costo/enumeración. **Aplicar**: plantilla para futuros endpoints KYC/sensibles a costo.
- **Timing-safe compare sin throw**: `timingSafeEqual(a, b)` throws si longitudes distintas. Comparar `.length` primero. — **Aplicar**: patrón en cualquier función que verifique credenciales/tokens.

---

## Archivos modificados

**17 archivos en scope (Waves W0–W3)**:

### Helpers (NEW)
- `src/infrastructure/kyc-auth.ts` — HMAC-SHA256 `issueSessionToken` / `verifySessionToken` + timing-safe
- `src/infrastructure/rate-limit.ts` — Upstash Redis client lazy + sliding window IP/address + fail-mode

### Rutas (MODIFIED)
- `app/api/kyc/session/route.ts` — guards (501→500→RL→callback server-side→issue token)
- `app/api/kyc/decision/route.ts` — guards (501→500→token verify→mask)

### Infraestructura (MODIFIED)
- `src/infrastructure/didit/decision.ts` — `maskIdentity` + `maskDecision` (funciones puras)
- `src/infrastructure/didit/kyc-gateway.ts` — transporte token + `senderAddress` en `start()` / `decision()`
- `src/application/ports.ts` — extensión tipos: `KycRequest.senderAddress?`, `KycStartResult.authToken?`, `KycGateway.decision(sessionId, authToken?)`, `KycPending.sessionToken?`

### Use-cases (MODIFIED)
- `src/application/use-cases/start-kyc.ts` — persistir `sessionToken` + pasar `senderAddress`
- `src/application/use-cases/resume-kyc.ts` — reenviar `sessionToken` a `decision()`

### Config (MODIFIED)
- `.env.example` — 8 env vars nuevas (KYC_SESSION_SECRET, KYC_CALLBACK_BASE_URL, 4 Upstash, 3 rate-limit overrides)
- `package.json` — `@upstash/ratelimit` + `@upstash/redis` agregadas

### Tests (NEW)
- `src/infrastructure/kyc-auth.test.ts` — unit tests HMAC (issue/verify, timing-safe, edge-cases)
- `src/infrastructure/rate-limit.test.ts` — unit tests fail-mode (Upstash ausente, window malformada, IP/address)
- `src/infrastructure/didit/decision.test.ts` — unit tests `maskIdentity` (edge cases: len≤4, vacío)
- `app/api/kyc/session/route.test.ts` — tests ruta (501/500/RL/callback/token + 3 MENORs)
- `app/api/kyc/decision/route.test.ts` — tests ruta (501/500/IDOR/mask/anti-enum)
- `src/infrastructure/didit/kyc-gateway.test.ts` — MODIFIED (extender: token viaja start→decision)

**Git diff**: 17 files, ~1,200 LOC (helpers + guards + tests + env), cero drift fuera de `chaski-v2/`. Scope IN 100% cubierto.

---

## Deploy Runbook — env vars para Vercel

**CRÍTICO**: Sin estas env vars en Vercel, en prod las rutas fallan-closed (503/500) intencionalmente.

### Obligatorias (cuando `DIDIT_API_KEY` presente en prod)

```bash
# 1. Secret HMAC para token de sesión (generar: 32 bytes random base64)
#    Ej: openssl rand -base64 32
KYC_SESSION_SECRET="<generar random 32 bytes>"

# 2. Upstash Redis (obtener del dashboard Upstash)
UPSTASH_REDIS_REST_URL="https://eu-stable-cow-xxxxx.upstash.io"
UPSTASH_REDIS_REST_TOKEN="<token REST>"

# 3. Base URL para callback a Didit (opcional, default: sin callback)
#    Ej: "https://chaski-v2.vercel.app" (reemplazar por el dominio real)
KYC_CALLBACK_BASE_URL="https://chaski-v2.vercel.app"
```

### Opcionales (rate-limit overrides, defaults OK para hackathon)

```bash
# Defaults: 5 sesiones/10min por IP (endurecido post-MNR-2), 3/10min por address
KYC_RL_IP_MAX="5"
KYC_RL_IP_WINDOW="10 m"
KYC_RL_ADDR_MAX="3"
KYC_RL_ADDR_WINDOW="10 m"
```

### Ya existentes (no modificar)

```bash
DIDIT_API_KEY="<key real desde Didit>"
DIDIT_WORKFLOW_ID="<workflow desde console Didit>"
DIDIT_BASE_URL="https://verification.didit.me"  # default OK
NEXT_PUBLIC_KYC_MODE="didit"  # activar cuando keys presentes
```

### Checklist deploy

- [ ] `KYC_SESSION_SECRET`: generar con `openssl rand -base64 32`, setear en Vercel
- [ ] Upstash Redis: crear instancia (Upstash console), copiar REST_URL + TOKEN a Vercel
- [ ] `KYC_CALLBACK_BASE_URL`: setear al dominio real (ej. `https://chaski-v2.vercel.app`)
- [ ] Redeploy: `vercel deploy --prod` después de setear env vars (el redeploy asegura que las rutas cargen las env vars nuevas)
- [ ] Testear: `curl -X POST https://chaski-v2.vercel.app/api/kyc/session -H "Content-Type: application/json" -d '{}'` → debe devolver `429` (rate-limit) o `200` (success), NO `500`/`503`

**Sin las env vars → fail-closed intencional (protege el costo en prod). En local/simulación (`DIDIT_API_KEY` ausente), todo funciona sin Upstash.**

---

## Decisiones diferidas a backlog

**NINGUNA.** Esta HU es punto final de la auditoría adversarial 2026-07-10 (junto a WKH-178). No genera spinoffs.

---

## Notas de coordinación

- **WKH-178 paralela**: Ambas HUs tocan `chaski-v2/src/infrastructure/didit/*` y el flujo KYC. Merge-order: WKH-179 (esta) primero, luego WKH-178. Bajo riesgo de conflicto (`kyc-gateway.ts` no toca presentación, `resume-kyc.ts` = 1 línea de cambio).
- **Cadena de precedencias**: F0 → F1 (HU_APPROVED) → F2 (SPEC_APPROVED) → F2.5 → F3 (W0–W3) → AR → CR → F4 (APROBADO) → DONE (este reporte). Nada deferido.

---

## Done Definition — Checklist Final

- [x] Los 17 archivos del Scope IN modificados/creados según Waves
- [x] Los 15 Constraint Directives (CD-1…CD-11, CD-A…CD-D) cumplidos
- [x] Los 16 tests (§10 story-file) escritos y en verde; ≥1 test por AC (10 ACs cubiertas)
- [x] `npm run typecheck` → 0 errores
- [x] `npm test` (vitest run) → 79/79 PASS
- [x] `npm run build` → OK (Next build éxito)
- [x] `.env.example` documenta 8 env vars sin valor real
- [x] Sin `export const runtime = "edge"` en rutas (runtime Node default)
- [x] `mapDiditDecision` sin cambios (masking compuesto en ruta)
- [x] Auto-Blindaje: 2 lecciones tipo-checking + 3 MENORs fixeados (todos con test de regresión)
- [x] Reportes AR/CR/F4 generados; 0 BLOQUEANTES finales
- [x] Runbook deploy completado (env vars, checklist, fail-closed explicado)

**HU WKH-179 READY PARA MERGE A MAIN.**

---

*Done Report generado por NexusAgil — nexus-docs — cierre de pipeline WKH-179.*
*Generado: 2026-07-10 | Orquestador: el presente reporte es el artefacto de salida; la siguiente acción es que el humano/CI mergee a main.*
