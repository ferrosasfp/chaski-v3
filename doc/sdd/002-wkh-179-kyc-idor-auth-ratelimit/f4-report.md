# F4 Validation Report — WKH-179 (Cerrar IDOR PII + auth/rate-limit en /api/kyc/*)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-10
**Repo**: chaski-v2/ (branch `fix/179-kyc-idor-auth-ratelimit`, working tree — sin commit aún)

> Nota de proceso: no existen `cr-report.md` / `ar-report.md` en disco para esta HU (el trabajo de
> AR/CR de esta sesión no dejó artefacto persistido). Por eso F4 corrió los 3 gates completos por su
> cuenta en vez de solo confirmarlos, y verificó los 3 MENORs del fix-pack leyendo el código fuente
> directamente (no hay reporte de CR que citar).

---

## 1. Runtime Gates (ejecutados por QA, salida real)

```
$ npx tsc --noEmit
TypeScript compilation completed
TSC_EXIT=0

$ npx vitest run
PASS (79) FAIL (0)
VITEST_EXIT=0

$ npm run build   (next build --webpack)
✓ Compiled successfully in 3.5s
✓ TypeScript OK
✓ Generating static pages (5/5)
Route (app)
┌ ○ /
├ ○ /_not-found
├ ƒ /api/kyc/decision
└ ƒ /api/kyc/session
ƒ  (Dynamic)  server-rendered on demand
BUILD_EXIT=0
```

- `/api/kyc/decision` y `/api/kyc/session` quedan marcadas `ƒ` (dynamic, server-rendered), no `○`
  (static) — corren en runtime Node (default Next 16). `grep -n "runtime" app/api/kyc/**/route.ts` →
  0 resultados → no hay `export const runtime = "edge"` (CD-D confirmado).
- 79 tests verdes coincide con el conteo esperado.

## 2. ACs — evidencia archivo:línea

| AC | Status | Método | Evidencia |
|----|--------|--------|-----------|
| AC-1 (token exigido en GET /decision) | PASS | test+inspección | `app/api/kyc/decision/route.ts:25-28` header `x-kyc-token` + `verifySessionToken`. Test `app/api/kyc/decision/route.test.ts:26-35` "token válido → 200 + decision" |
| AC-2 (401 sin token / inválido, sin fetch) | PASS | test+inspección | `decision/route.ts:26-28` corta antes del `fetch` (L30). Tests `route.test.ts:37-44` (sin token), `:46-53` (token errado), `:55-62` (token de OTRA sesión, IDOR directo) — los 3 assertan `fetchMock` no llamado |
| AC-3 (masking documentNumber) | PASS | test+inspección | `src/infrastructure/didit/decision.ts:60-65` `maskIdentity`; aplicado en `decision/route.ts:39` `maskDecision(mapDiditDecision(...))`. Test `decision/route.test.ts:26-35` → `documentNumber` = `"****6677"`, `firstName`/`dateOfBirth` intactos |
| AC-4 (501 antes de auth/RL, ambas rutas) | PASS | test+inspección | `decision/route.ts:13-14` y `session/route.ts:36-38` — primer check. Tests `decision/route.test.ts:64-68`, `session/route.test.ts:38-46` (rate-limit NO invocado) |
| AC-5 (identidad de caller antes de Didit en /session) | PASS | test+inspección | `session/route.ts:44-56` parse body → `checkKycRateLimit` antes del `fetch` (L63). Test `session/route.test.ts:55-60` |
| AC-6 (429 sin llamar a Didit al exceder límite) | PASS | test+inspección | `session/route.ts:51-56`. Test `session/route.test.ts:90-98` (429+Retry-After, fetch no llamado) + `:100-108` (503 fail-closed) |
| AC-7 (ninguna llamada a Didit si rechazo por auth/RL) | PASS | test | Cubierto transversalmente: `decision/route.test.ts:37-44,46-53,55-62` y `session/route.test.ts:38-46,90-98,100-108` — todos assertan `fetchMock`/`toHaveBeenCalled()` en falso |
| AC-8 (callback ignorado, reconstruido server-side) | PASS | test+inspección | `session/route.ts:60-61,66-70` — nunca usa `body.callback`. Test `session/route.test.ts:110-121` |
| AC-9 (body.callback nunca reenviado) | PASS | test | `session/route.test.ts:110-121` (`toContain("evil")` → false) y `:123-133` (sin `KYC_CALLBACK_BASE_URL` → `undefined`, nunca `body.callback`) |
| AC-10 (simulación intacta, sin DIDIT_API_KEY) | PASS | test | `kyc-gateway.test.ts:27-33,111-119` — `start()` delega en fallback, `decision()` idem, sin exigir token/Upstash |

**10/10 PASS.** Método: 8/10 test-automático + inspección cruzada; AC-4/AC-9 puramente test-automático confirmado por lectura de assertions.

## 3. Fix-pack (3 MENORs) — verificación puntual

- **MNR-1 (IP source no forjable)** — `app/api/kyc/session/route.ts:19-31` `clientIp()`: prioridad
  `x-vercel-forwarded-for` (leftmost) → `x-real-ip` → sólo como último recurso `x-forwarded-for`
  tomando el **rightmost** (`parts[parts.length - 1]`, L28), nunca el leftmost spoofeable. Tests:
  `session/route.test.ts:62-73` (XFF malicioso ignorado cuando hay `x-vercel-forwarded-for`),
  `:75-80` (fallback a `x-real-ip`), `:82-88` (sin headers Vercel, XFF rightmost, no leftmost) — los
  3 en verde.
- **MNR-2 (bucket IP siempre corre + default endurecido)** — `src/infrastructure/rate-limit.ts:90-95`
  `checkKycRateLimit`: el `ipRes = await limiters.ip.limit(input.ip)` es incondicional, no depende de
  `input.address`. Default `KYC_RL_IP_MAX=5` (antes 10), `rate-limit.ts:69`. Test
  `rate-limit.test.ts:71-79` confirma `ipArgs[0] === 5` (no 10).
- **MNR-3 (window malformada no produce NaN)** — `rate-limit.ts:44-51` `win()`: regex
  `WINDOW_RE = /^\d+\s*(ms|s|m|h|d)$/`; si `KYC_RL_*_WINDOW` no matchea → fallback, nunca pasa el
  string crudo a `Ratelimit.slidingWindow`. Test `rate-limit.test.ts:81-88` (`"diez minutos"` → cae a
  `"10 m"`) y `:90-96` (valor válido `"30 s"` se respeta) — ambos en verde.

Los 3 MENORs están fixeados con evidencia archivo:línea + test dedicado. Ningún MENOR quedó parcial.

## 4. Drift detection

- **Scope**: `git status --porcelain` lista exactamente los 17 archivos del Scope IN del Story File
  (§1) + `package-lock.json`/`tsconfig.tsbuildinfo` (artefactos generados por `npm install`/`tsc`, no
  cuentan como drift). Cero archivos fuera de `chaski-v2/`, cero toque a `src/presentation/*`
  (`flow.tsx`/`ui.tsx`), cero toque a `doc/sdd/001-wkh-178-*` (CD-1/CD-6 respetados).
- **Guard-order**: coincide exacto con §5.1/§5.2 del Story File en ambas rutas (501 → 500 →
  RL/auth → Didit → issue/mask), verificado línea por línea arriba.
- **Waves**: no verificable por commits (todo en working tree sin commitear), pero el `auto-blindaje.md`
  (`doc/sdd/002-.../auto-blindaje.md:3,9`) documenta 2 hallazgos cronológicos consistentes con
  W0 (tipo `Duration`) → W1 (`noUncheckedIndexedAccess`), orden correcto.
- **Doc drift menor (no bloqueante)**: `.env.example:24` dice "defaults: 10/'10 m' por IP" pero el
  default real endurecido por MNR-2 es `5`/"10 m" (`rate-limit.ts:69`). El comentario quedó
  desactualizado tras el fix-pack. **No bloqueante** — no afecta comportamiento ni seguridad, solo
  precisión de doc. Recomendado corregir en un fix menor post-DONE.

## 5. Constraint Directives — 15/15

| CD | Estado | Evidencia |
|----|--------|-----------|
| CD-1 (solo chaski-v2, no demo live, no doc/sdd/001-*) | OK | `git status` confirmado §4 |
| CD-2 (401/403/429/503 antes de fetch) | OK | Guard-order ambas rutas, §2 |
| CD-3 (sin secrets hardcodeados) | OK | `grep KYC_SESSION_SECRET=` sin valores hardcodeados en `app/`/`src/`; `.env.example` sin valor real |
| CD-4 (501 preservado, primer check) | OK | `decision/route.ts:13-14`, `session/route.ts:36-38` |
| CD-5 (mismo body/status sin-token vs inválido) | OK | `decision/route.ts:26-28` — un solo branch para ambos casos. Test `decision/route.test.ts:37-44` vs `:46-53` — mismo `{error:"unauthorized"}`/401 |
| CD-6 (no tocar presentación) | OK | `flow.tsx`/`ui.tsx` no aparecen en `git status` |
| CD-7 (500 sin KYC_SESSION_SECRET) | OK | ambas rutas L16-18/L40-42. Tests `session/route.test.ts:48-53`, `decision/route.test.ts:70-75` |
| CD-8 (masking edge cases) | OK | `decision.ts:60-65`. Tests `decision.test.ts:94-101` |
| CD-9 (timingSafeEqual sin throw por longitud) | OK | `kyc-auth.ts:31` compara longitud antes. Test `kyc-auth.test.ts:26-30` |
| CD-10 (sessionToken ≠ authToken) | OK | `session/route.ts:79-85` campos distintos. Test `session/route.test.ts:135-145` (`authToken !== sessionToken`) |
| CD-11 (sin contadores en memoria) | OK | `rate-limit.ts` — único estado module-level es el cliente Upstash memoizado (`cached`), no contadores; los contadores viven en Redis |
| CD-A (node:crypto, no jsonwebtoken/jose) | OK | `kyc-auth.ts:10` import; `grep jsonwebtoken\|jose` → 0 en package.json/kyc-auth.ts |
| CD-B (masking función pura) | OK | `decision.ts:60-65,68-70` sin I/O |
| CD-C (patrón de test vitest) | OK | todos los `*.test.ts` nuevos usan `vi.stubGlobal("fetch")`/`vi.stubEnv`/`afterEach(vi.restoreAllMocks)` |
| CD-D (runtime Node, no edge) | OK | `grep runtime` → 0 resultados; build muestra rutas `ƒ` dynamic sin marca edge |

**15/15 confirmados.**

## 6. Verificación de no-filtrado de PII/secrets en error bodies

Inspeccionados todos los `NextResponse.json({error: ...})` de ambas rutas (`decision/route.ts:14,17,21,27,35`;
`session/route.ts:37,41,49,53,75`) — todos devuelven strings de error genéricos
(`didit_not_configured`, `server_misconfigured`, `missing_session`, `unauthorized`, `rate_limited`,
`rate_limit_unavailable`, `didit_decision_failed`/`didit_session_failed` + `upstream: res.status`
numérico). Ninguno incluye `KYC_SESSION_SECRET`, tokens, ni PII cruda. Confirmado también que el 502
solo expone el status HTTP upstream, no el body de Didit.

## 7. Runtime/env checks fuera de alcance de este repo

chaski-v2 no tiene DB (confirmado en SDD §4.2, N/A). Env vars de prod (`KYC_SESSION_SECRET`,
`UPSTASH_REDIS_REST_URL/TOKEN`) son prerequisito operacional documentado en `.env.example` pero su
seteo en Vercel está fuera del scope de código de esta HU (SDD §8) — **NO VERIFICABLE** desde este
entorno de QA (sin acceso al dashboard/CLI de Vercel de chaski-v2 en esta sesión). No bloquea DONE:
es deploy-time, no code-time.

---

## Resumen ejecutivo

Los 3 gates (tsc, vitest 79/79, build) corren en verde ejecutados directamente por QA. Los 10 ACs
tienen evidencia archivo:línea + test dedicado, sin excepciones. Los 3 MENORs del fix-pack
(IP-spoofing vía XFF, bucket IP condicionado a `vendorData`, window malformada → NaN) están
efectivamente cerrados con tests de regresión propios. Guard-order en ambas rutas coincide exacto con
el Story File (501→500→auth/RL→Didit) — el IDOR (B1), el financial-DoS (A2) y el M6 (callback SSRF)
quedan cerrados. Drift de scope: cero. Los 15 CDs están cumplidos, incluyendo CD-9 (timing-safe sin
throw) y CD-5 (anti-enumeración). Único hallazgo: un comentario desactualizado en `.env.example`
(default documentado 10 vs real 5 tras MNR-2) — cosmético, no bloqueante. **APROBADO PARA DONE.**
