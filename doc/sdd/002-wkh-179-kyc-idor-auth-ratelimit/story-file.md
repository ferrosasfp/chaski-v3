# Story File — [WKH-179] Cerrar IDOR PII + auth/rate-limit en /api/kyc/*

> Fase: F2.5 (contrato autocontenido para el Dev)
> SPEC_APPROVED: sí
> Branch: `fix/179-kyc-idor-auth-ratelimit`
> Repo: `chaski-v2/`
> Fuente: `doc/sdd/002-wkh-179-kyc-idor-auth-ratelimit/sdd.md` + `work-item.md`
> **El Dev SOLO lee este archivo.** Si algo no está acá, no se hace.

---

## 0. Contexto (qué se construye y por qué)

`app/api/kyc/decision/route.ts` devuelve la **identidad completa** (DNI, fecha de nacimiento,
nombres) de **cualquier** sesión KYC a **cualquier** caller que conozca/adivine el `sessionId`
(IDOR / fuga de PII — hallazgo **B1**). `app/api/kyc/session/route.ts` no tiene auth ni rate-limit:
cada `POST` dispara una verificación que Chaski **paga** en Didit (financial-DoS — **A2**). Además el
`callback` del body se reenvía crudo a Didit (**M6**, SSRF/open-redirect).

Esta HU cierra los tres huecos **solo** en `chaski-v2/app/api/kyc/*` y sus helpers de
infra/aplicación directos. **NO** toca presentación (`flow.tsx`/`ui.tsx`) ni el demo live
(`yarvis`/`wasiai-v2`/`agentshop-*`). Diseño:

1. **Binding sesión↔caller (B1)** — token HMAC stateless emitido en `POST /session`, exigido en
   `GET /decision` (verificación timing-safe). Sin SIWE.
2. **Rate-limit (A2)** — `@upstash/ratelimit` + `@upstash/redis`, sliding window, IP + address,
   evaluado **antes** de llamar a Didit.
3. **Callback (M6)** — se ignora `body.callback`, se reconstruye server-side desde env allow-listed.
4. **Masking (defensa en profundidad)** — `documentNumber` enmascarado (últimos 4) en el límite HTTP.

Todo preservando el `501` en modo simulación (sin `DIDIT_API_KEY`).

**CD-1 (crítico): esta HU es exclusivamente `chaski-v2/`.** Prohibido tocar cualquier archivo fuera
del repo `chaski-v2`, el demo live, o `doc/sdd/001-wkh-178-*`.

---

## 1. Scope IN — lista EXHAUSTIVA de archivos a tocar

| # | Archivo | Acción |
|---|---------|--------|
| 1 | `src/infrastructure/kyc-auth.ts` | **CREAR** — `issueSessionToken` / `verifySessionToken` (HMAC + timing-safe) |
| 2 | `src/infrastructure/rate-limit.ts` | **CREAR** — `checkKycRateLimit({ip, address})` + cliente Upstash lazy + fail-mode |
| 3 | `src/infrastructure/didit/decision.ts` | Modificar — agregar `maskIdentity` + `maskDecision` (puras) |
| 4 | `src/application/ports.ts` | Modificar — extender tipos (§Waves W0.5) |
| 5 | `.env.example` | Modificar — documentar env vars nuevas |
| 6 | `package.json` | Modificar — agregar `@upstash/ratelimit` + `@upstash/redis` |
| 7 | `app/api/kyc/decision/route.ts` | Modificar — guards (501→500→token verify→Didit→mask) |
| 8 | `app/api/kyc/session/route.ts` | Modificar — guards (501→500→RL→callback server-side→Didit→issue token) |
| 9 | `src/infrastructure/didit/kyc-gateway.ts` | Modificar — leer `authToken`, enviar `x-kyc-token` + `senderAddress` |
| 10 | `src/application/use-cases/start-kyc.ts` | Modificar — persistir `sessionToken` + pasar `senderAddress` |
| 11 | `src/application/use-cases/resume-kyc.ts` | Modificar — reenviar `p.sessionToken` a `decision()` |
| 12 | `src/infrastructure/kyc-auth.test.ts` | **CREAR** — unit tests HMAC |
| 13 | `src/infrastructure/rate-limit.test.ts` | **CREAR** — unit tests fail-mode + límite |
| 14 | `src/infrastructure/didit/decision.test.ts` | **CREAR** — unit tests `maskIdentity` |
| 15 | `app/api/kyc/session/route.test.ts` | **CREAR** — tests ruta (501/500/RL/callback/token) |
| 16 | `app/api/kyc/decision/route.test.ts` | **CREAR** — tests ruta (501/500/IDOR/mask) |
| 17 | `src/infrastructure/didit/kyc-gateway.test.ts` | Modificar — extender: token viaja start→decision |

**NO tocar** (Scope OUT, confirmado): `src/presentation/*` (flow.tsx, ui.tsx), `kyc-pending-store.ts`
(serializa el campo nuevo solo, vía `JSON.stringify`), `FallbackKycGateway`/`gateways.ts`,
`container.ts`, cualquier `app/api/*` fuera de `kyc/*`, `doc/sdd/001-*`, el demo live.

---

## 2. Anti-Hallucination Anchors (archivo:línea EXACTO — verificado con Read el 2026-07-10)

> Todo lo de abajo fue leído en disco. NO inventar firmas ni paths. Si algo difiere al codear, PARÁ.

### 2.1 Rutas a modificar

**`app/api/kyc/session/route.ts`** (33 líneas):
- L1-3: comentario + `import { NextResponse } from "next/server"`.
- L5: `const BASE = process.env.DIDIT_BASE_URL ?? "https://verification.didit.me";`
- L7: `export async function POST(req: Request): Promise<Response>`.
- L8-12: guard config — `const apiKey = process.env.DIDIT_API_KEY; const workflowId = process.env.DIDIT_WORKFLOW_ID;` → si falta cualquiera, `501 { error: "didit_not_configured" }`. **PRESERVAR.**
- L14: `const body = (await req.json().catch(() => ({}))) as { vendorData?: string; callback?: string };`
- L16-25: `fetch(\`${BASE}/v3/session/\`, ...)` con header `x-api-key: apiKey`, body `{ workflow_id, vendor_data: body.vendorData, callback: body.callback }`, timeout `AbortSignal.timeout(10_000)`.
  - **L22: `callback: body.callback` ← ESTE es el M6 a matar.** Reemplazar por callback server-side.
- L27-29: si `!res.ok` → `502 { error: "didit_session_failed", upstream: res.status }`.
- L31: `const d = (await res.json()) as { session_id: string; url: string; session_token?: string };`
- **L32: `return NextResponse.json({ sessionId: d.session_id, url: d.url, sessionToken: d.session_token });`**
  - **`sessionToken` es de Didit (`d.session_token`), NO el nuestro.** El nuestro se llama `authToken` (CD-10). Agregar `authToken` como campo NUEVO, sin tocar `sessionToken`.

**`app/api/kyc/decision/route.ts`** (25 líneas):
- L3-4: `import { NextResponse } from "next/server"` + `import { mapDiditDecision } from "../../../../src/infrastructure/didit/decision";`
- L6: `const BASE = ...` (idéntico).
- L8: `export async function GET(req: Request): Promise<Response>`.
- L9-10: guard config — `const apiKey = process.env.DIDIT_API_KEY; if (!apiKey) return ... 501 { error: "didit_not_configured" }`. **PRESERVAR.**
- L12-13: `const sessionId = new URL(req.url).searchParams.get("sessionId"); if (!sessionId) return ... 400 { error: "missing_session" };` **PRESERVAR el 400.**
- L15-18: `fetch(\`${BASE}/v3/session/${encodeURIComponent(sessionId)}/decision/\`, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(10_000) })` — **hoy SIN header de auth del caller.**
- L19-21: si `!res.ok` → `502 { error: "didit_decision_failed", upstream: res.status }`.
- L23-24: `const decision = await res.json(); return NextResponse.json(mapDiditDecision(decision));`
  - **L24 devuelve el mapper CRUDO con `identity` completa ← ESTE es el IDOR + PII leak.** Reemplazar por `maskDecision(mapDiditDecision(decision))`.

### 2.2 Mapper puro (donde va el masking)

**`src/infrastructure/didit/decision.ts`** (54 líneas):
- L3: `import type { VerifiedIdentity } from "../../domain/remittance";`
- L5-14: `interface DiditDecisionResult { terminal; verificationId; approved; payoutAllowed; riskLevel; provenance; status; identity: VerifiedIdentity | null; }`
- L24: helper `const s = (v: unknown): string => (typeof v === "string" ? v : "");` — **mismo estilo para tu masking**.
- L29-54: `export function mapDiditDecision(raw: DiditRaw): DiditDecisionResult` — puro, sin I/O. **NO cambiar su lógica.**
- L33-43: arma `identity` con `firstName` (L35), `lastNamePaternal` (L36), `lastNameMaternal` (L37), `documentType` (L38), **`documentNumber: s(idv.document_number)` (L39)**, `dateOfBirth` (L40), `nationality` (L41).
- `VerifiedIdentity` tiene: `firstName, lastNamePaternal, lastNameMaternal, documentType, documentNumber, dateOfBirth, nationality` (todos `string`).

### 2.3 Adapter cliente (transporte del token)

**`src/infrastructure/didit/kyc-gateway.ts`** (45 líneas):
- L5-11: importa `KycDecision, KycGateway, KycRequest, KycStartResult` de `"../../application/ports"` + `DiditDecisionResult` de `"./decision"`.
- L13-14: `export class DiditKycGateway implements KycGateway { constructor(private readonly fallback: KycGateway) {} }`.
- L16-26: **`async start(req: KycRequest): Promise<KycStartResult>`**:
  - L17-21: `fetch("/api/kyc/session", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ callback: req.callbackUrl }) })` — **hoy NO manda `vendorData`/address.**
  - L22: `if (sres.status === 501) return this.fallback.start(req);`
  - L23: `if (!sres.ok) throw new Error("didit_session_failed");`
  - L24: `const { sessionId, url } = (await sres.json()) as { sessionId: string; url: string };` — **hoy NO lee `authToken`.**
  - L25: `return { kind: "redirect", url, sessionId };`
- L28-44: **`async decision(sessionId: string): Promise<KycDecision>`**:
  - L29: `fetch(\`/api/kyc/decision?sessionId=${encodeURIComponent(sessionId)}\`)` — **hoy SIN header `x-kyc-token`.**
  - L30: `if (dres.status === 501) return this.fallback.decision(sessionId);`
  - L31: `if (!dres.ok) throw new Error("didit_decision_failed");`
  - L32-43: mapea `DiditDecisionResult` → `KycDecision`.

### 2.4 Pending store (persistencia del token — NO se toca, serializa solo)

**`src/infrastructure/kyc-pending-store.ts`** (24 líneas):
- L5: `const KEY = "chaski.kyc.pending.v1";`
- L7: `export class LocalKycPendingStore implements KycPendingStore`.
- L8-10: **`async save(p: KycPending)` → `localStorage.setItem(KEY, JSON.stringify(p))`** — **serializa cualquier campo nuevo del tipo sin cambio de código.** Por eso NO se toca.
- L11-20: `async get()` → `JSON.parse(raw) as KycPending`.
- L21-23: `async clear()` → `localStorage.removeItem(KEY)`.

### 2.5 Use-cases (dónde viaja el token)

**`src/application/use-cases/start-kyc.ts`** (67 líneas):
- L23-28: firma `execute(input: { remittanceId; address; callbackUrl?; purpose? })`.
- L43-48: `const res = await this.kyc.start({ amountUsd, beneficiary, purpose, callbackUrl });`
  - **Acá agregar `senderAddress: input.address`** (requiere extender `KycRequest`, W0.5).
- L50-56: rama `res.kind === "completed"` (simulación) — no toca token.
- **L60-64: `await this.pending.save({ remittanceId: input.remittanceId, sessionId: res.sessionId, address: input.address });`**
  - **Acá agregar `sessionToken: res.authToken`** (requiere `res` tipado con `authToken?`, W0.5).

**`src/application/use-cases/resume-kyc.ts`** (53 líneas):
- L23-25: `const p = await this.pending.get(); if (!p) return { kind: "none" };`
- L38-43: `let dec; try { dec = await this.kyc.decision(p.sessionId); } catch { return { kind: "processing" }; }`
  - **L40: `dec = await this.kyc.decision(p.sessionId);` → cambiar a `this.kyc.decision(p.sessionId, p.sessionToken);`**
  - **L41-42: el `catch` ya trata el error como `processing` (reintentable)** → una sesión legacy sin token responderá 401, caerá acá, y degradará al mensaje existente (fail-closed OK, sin migración).

### 2.6 Ports (extensión de tipos)

**`src/application/ports.ts`** (106 líneas):
- L27-32: `interface KycRequest { amountUsd; beneficiary; purpose; callbackUrl?; }` → **agregar `senderAddress?: string`**.
- L34-36: `type KycStartResult = { kind:"completed"; verification } | { kind:"redirect"; url; sessionId }` → **variante redirect: agregar `authToken?: string`**.
- L42-45: `interface KycGateway { start(req); decision(sessionId: string): Promise<KycDecision>; }` → **`decision(sessionId: string, authToken?: string)`**.
- L48-52: `interface KycPending { remittanceId; sessionId; address; }` → **agregar `sessionToken?: string`**.

### 2.7 Helpers de referencia (exemplars) y presentación (NO tocar)

- **`src/infrastructure/system.ts:12`** → `const c = globalThis.crypto;` — filosofía crypto a imitar. **NO hay helper HMAC** → creás `kyc-auth.ts` con `node:crypto`.
- **`src/infrastructure/fallback/gateways.ts:63-90`** → `FallbackKycGateway`. **L69: `async decision(_sessionId: string)`** — firma con menos params **sigue siendo asignable** a `decision(sessionId, authToken?)`. **NO se toca.** L79-87: identidad simulada, `documentNumber: "44556677"` (L84).
- **`src/presentation/flow.tsx:186-187`** → `const callbackUrl = ... \`${window.location.origin}/?kyc=return\`` — la UI sigue mandando `callbackUrl`; el gateway lo pone en `body.callback`; **la ruta lo IGNORA** (M6). No hay que tocar flow.tsx.
- **`src/presentation/flow.tsx:519`** → `· {rem.kyc.identity.documentType} ••••{rem.kyc.identity.documentNumber.slice(-4)}` — **la UI ya hace `.slice(-4)`**. Con masking `"44556677"→"****6677"`, `"****6677".slice(-4) === "6677"` → **la UI sigue mostrando `••••6677` sin cambio.** (⚠️ el SDD citó `flow.tsx:492`; la línea real verificada es **519**.)
- **`src/infrastructure/didit/kyc-gateway.test.ts`** → EXEMPLAR de test: `vi.stubGlobal("fetch", vi.fn(async () => ({...})))` + `afterEach(() => vi.restoreAllMocks())`. Copiá este patrón para los tests de rutas/helpers.

### 2.8 Env y deps

- **`.env.example:4-16`** → convención: comentario + `VAR=` sin valor. Vars actuales: `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID`, `DIDIT_BASE_URL`, `NEXT_PUBLIC_KYC_MODE`.
- **`package.json`** → `"type": "module"`, test runner `vitest` (`"test": "vitest run"` L13, `"qa": "npm run typecheck && npm run test"` L15). Deps: sin `@upstash/*`. Sin `vitest.config` (usa defaults).

---

## 3. Diseño del token HMAC (B1) — paso a paso

### 3.1 Helper `src/infrastructure/kyc-auth.ts` (NEW)

Módulo infra puro, sin estado, con `node:crypto` (CD-A). Exporta dos funciones:

```
import { createHmac, timingSafeEqual } from "node:crypto";

// Emisión: determinístico sobre session_id → stateless, sin storage server-side.
issueSessionToken(sessionId: string): string
  = base64url( HMAC-SHA256( KYC_SESSION_SECRET, sessionId ) )
  // createHmac("sha256", secret).update(sessionId).digest("base64url")

// Verificación timing-safe:
verifySessionToken(sessionId: string, token: string): boolean
  1. expected = issueSessionToken(sessionId)   // string base64url
  2. const a = Buffer.from(expected);  const b = Buffer.from(token);
  3. if (a.length !== b.length) return false;   // CD-9: comparar longitud PRIMERO, sin throw
  4. return timingSafeEqual(a, b);
```

- `KYC_SESSION_SECRET` se lee de `process.env` DENTRO de la función (no en top-level, para que
  `vi.stubEnv` funcione en tests). Si el secreto falta, la función NO se debe llamar (la ruta corta
  antes con 500, CD-7); aun así, defendé: si `!secret` en `issue`/`verify`, lanzá error claro o
  devolvé `false` — la ruta ya garantiza el guard 500 antes.
- **NO** agregar `jsonwebtoken`/`jose` (CD-A).

### 3.2 Viaje end-to-end del token

```
POST /session (server)
  Didit devuelve { session_id }
  → authToken = issueSessionToken(session_id)
  → responde { sessionId, url, sessionToken (de Didit), authToken (NUESTRO) }

DiditKycGateway.start() (cliente)
  → lee { sessionId, url, authToken } del JSON
  → return { kind:"redirect", url, sessionId, authToken }

StartKyc.execute()
  → pending.save({ remittanceId, sessionId, address, sessionToken: res.authToken })
  → LocalKycPendingStore serializa a localStorage (JSON.stringify)

[ redirect a Didit + vuelta a la DApp ]

ResumeKyc.execute()
  → p = pending.get()  → tiene p.sessionToken
  → kyc.decision(p.sessionId, p.sessionToken)

DiditKycGateway.decision(sessionId, authToken)
  → fetch("/api/kyc/decision?sessionId=...", { headers: authToken ? { "x-kyc-token": authToken } : {} })

GET /decision (server)
  → verifySessionToken(sessionId, header "x-kyc-token")  → 401 si mismatch/missing
```

### 3.3 Header y comparación

- Header: **`x-kyc-token`** (lowercase; `req.headers.get("x-kyc-token")`).
- Missing token → `401` genérico (mismo body/status que mismatch, CD-5).
- Mismatch → `401` genérico. **Sin `fetch` a Didit en ninguno de los dos casos** (CD-2, AC-2, AC-7).

### 3.4 Compat sesiones legacy (sin token)

Un `KycPending` viejo en localStorage (creado antes del deploy) NO tiene `sessionToken` →
`decision()` no manda header → server responde `401` → `ResumeKyc` cae en el `catch` (L41-42) →
`{ kind: "processing" }` → tras reintentos la UI muestra el mensaje existente. **Fail-closed,
sin migración.** Es un caso raro (mismo browser, KYC a mitad, justo en el deploy).

### 3.5 Garantía y límite (documentar en comentario del helper)

Cierra el IDOR: un atacante con solo `sessionId` no puede forjar el token sin el secreto. **NO**
prueba posesión de wallet: si el token se filtra (logs/XSS/history) es replayable. Aceptado para
hackathon/prod-inicial. SIWE queda deferred (Scope OUT).

---

## 4. Diseño del rate-limit (A2) — paso a paso

### 4.1 Helper `src/infrastructure/rate-limit.ts` (NEW)

Librerías: `@upstash/ratelimit` + `@upstash/redis` (REST, corre en runtime Node de Vercel).

```
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Cliente lazy: se construye UNA vez desde env. Sliding window.
// UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN

export interface KycRateLimitInput { ip: string; address?: string; }
export interface KycRateLimitResult { ok: boolean; retryAfter?: number; unavailable?: boolean; }

checkKycRateLimit(input): Promise<KycRateLimitResult>
```

### 4.2 Configuración

- **Cliente lazy**: memoizá el `Redis`/`Ratelimit` a nivel módulo; construilo la primera vez que
  hay env vars. Dos limiters:
  - IP: `Ratelimit.slidingWindow(KYC_RL_IP_MAX, KYC_RL_IP_WINDOW)` (default `10`, `"10 m"`).
  - Address: `Ratelimit.slidingWindow(KYC_RL_ADDR_MAX, KYC_RL_ADDR_WINDOW)` (default `3`, `"10 m"`).
- **Keys Redis**: `kyc:rl:ip:<ip>` y `kyc:rl:addr:<address>`. TTL corto, **sin PII** (address es
  pública, no es PII de documento).
- **Evaluación**: se chequean **ambas** keys (IP siempre; address solo si `input.address`
  presente). Si **cualquiera** excede → `{ ok:false, retryAfter }` con `retryAfter` en segundos.
- **Env-overridable** (no son secretos): `KYC_RL_IP_MAX`, `KYC_RL_IP_WINDOW`, `KYC_RL_ADDR_MAX`,
  `KYC_RL_ADDR_WINDOW`. Parseá defaults si ausentes.
- **NO contadores en memoria** (Vercel serverless efímero, CD-11). Solo Upstash.

### 4.3 IP source (en la ruta, se pasa al helper)

```
const ip = (req.headers.get("x-forwarded-for")?.split(",")[0].trim())
        ?? req.headers.get("x-real-ip")
        ?? "unknown";   // Vercel siempre setea x-forwarded-for
```

### 4.4 Fail-mode (decisión documentada)

| Escenario | Comportamiento | Cómo lo señala el helper |
|-----------|----------------|--------------------------|
| Upstash **no configurado** (env ausentes) — la ruta llegó acá porque Didit SÍ está configurado (prod-like) | **fail-CLOSED** → la ruta responde `503 rate_limit_unavailable`, NO llama a Didit | `checkKycRateLimit` devuelve `{ ok:false, unavailable:true }` |
| Modo simulación (sin `DIDIT_API_KEY`) | **rate-limit NUNCA se invoca** (el guard 501 corre PRIMERO en la ruta) | — (la ruta ni llama al helper) |
| Upstash configurado pero **error transitorio** (red/timeout en runtime) | **fail-OPEN** con `console.warn`, permite la request | `try/catch` → `console.warn(...)` → `{ ok:true }` |

Consecuencia: **en local/simulación NO se necesita Upstash** (el 501 corta antes). Solo con
`DIDIT_API_KEY` seteado (prod real) Upstash pasa a ser requerido.

---

## 5. Guard-order EXACTO por ruta

### 5.1 `POST /api/kyc/session`

```
1. Config Didit:  if (!DIDIT_API_KEY || !DIDIT_WORKFLOW_ID) → 501 { error:"didit_not_configured" }   [AC-4, CD-4] (PRESERVAR L8-12)
2. Config secret: if (!KYC_SESSION_SECRET)                   → 500 { error:"server_misconfigured" }   [CD-7]
3. Parse body (catch → {})   // { vendorData?, callback? }
4. Rate-limit:    const rl = await checkKycRateLimit({ ip, address: body.vendorData })
     if (rl.unavailable)  → 503 { error:"rate_limit_unavailable" }   [AC-6 fail-closed]
     if (!rl.ok)          → 429 { error:"rate_limited" } + header "Retry-After": String(rl.retryAfter)   [AC-6, AC-7]
     // ← SIN fetch a Didit hasta acá (CD-2)
5. Callback server-side: const callback = KYC_CALLBACK_BASE_URL ? `${KYC_CALLBACK_BASE_URL}/kyc/callback` : undefined
     // IGNORAR body.callback por completo  [AC-8, AC-9, M6]
6. fetch Didit POST /v3/session/  con { workflow_id, vendor_data: body.vendorData, callback }   // callback = server-side, NUNCA body.callback
     if (!res.ok) → 502 { error:"didit_session_failed", upstream: res.status }   (PRESERVAR)
7. const authToken = issueSessionToken(d.session_id)
8. return { sessionId: d.session_id, url: d.url, sessionToken: d.session_token, authToken }
     // sessionToken = de Didit (NO tocar). authToken = NUESTRO (nuevo). CD-10.
```

### 5.2 `GET /api/kyc/decision`

```
1. Config Didit:  if (!DIDIT_API_KEY) → 501 { error:"didit_not_configured" }   [AC-4, CD-4] (PRESERVAR L9-10)
2. Config secret: if (!KYC_SESSION_SECRET) → 500 { error:"server_misconfigured" }   [CD-7]
3. sessionId = URL query "sessionId";  if (!sessionId) → 400 { error:"missing_session" }   (PRESERVAR L12-13)
4. token = req.headers.get("x-kyc-token");
     if (!token) → 401 { error:"unauthorized" }   [AC-2, CD-5]  (SIN fetch)
5. if (!verifySessionToken(sessionId, token)) → 401 { error:"unauthorized" }   [AC-2, CD-5, CD-9]  (SIN fetch)
     // ← mismo body/status para "sin token" y "token inválido" (anti-enumeración, CD-5)
6. fetch Didit GET /v3/session/{id}/decision/   (PRESERVAR headers/timeout)
     if (!res.ok) → 502 { error:"didit_decision_failed", upstream: res.status }   (PRESERVAR)
7. return maskDecision(mapDiditDecision(await res.json()))   [AC-3]
```

### 5.3 Masking en el límite HTTP (`decision.ts`)

`maskIdentity(identity: VerifiedIdentity): VerifiedIdentity` — pura, estilo `mapDiditDecision`:

```
documentNumber → "*".repeat(Math.max(0, len - 4)) + last4
  "44556677"  → "****6677"
  len <= 4     → "*".repeat(len)   // nunca exponer <4 dígitos en claro   [CD-8]
  ""           → ""                // identity nula ya se filtra en mapDiditDecision   [CD-8]
Resto de campos (firstName, apellidos, dateOfBirth, nationality, documentType) → INTACTOS
  (siguen protegidos por el auth check de AC-1; masking = defensa en profundidad solo sobre el número)

maskDecision(d: DiditDecisionResult): DiditDecisionResult
  = { ...d, identity: d.identity ? maskIdentity(d.identity) : null }
```

`mapDiditDecision` se deja **sin cambios** (raw). El masking se compone en la ruta. La UI
(`flow.tsx:519`) ya hace `.slice(-4)` → sigue mostrando `••••6677`.

---

## 6. Callback M6 — reconstrucción server-side

- **Ignorar** `body.callback` completamente (no se valida, no se allow-lista paths — se descarta).
- Construir server-side: `KYC_CALLBACK_BASE_URL ? \`${KYC_CALLBACK_BASE_URL}/kyc/callback\` : undefined`.
- Si `KYC_CALLBACK_BASE_URL` ausente → sesión **sin callback** (Didit muestra su pantalla default;
  el resume funciona igual por localStorage — verificado: `ResumeKyc` lee el pending store en cada
  mount, no depende del query param).
- El body `body.callback="http://evil"` **NUNCA** debe aparecer en el payload a Didit (AC-9, test).

---

## 7. Fail-modes (resumen operativo)

| Condición | Respuesta HTTP | AC |
|-----------|----------------|-----|
| Sin `DIDIT_API_KEY` (sim) | `501` (fallback) — rate-limit NO se invoca | AC-4 / AC-10 |
| `DIDIT_API_KEY` sin `KYC_SESSION_SECRET` | `500 server_misconfigured` | CD-7 |
| `/decision` sin token o token inválido | `401 unauthorized` (body genérico) | AC-1 / AC-2 / CD-5 |
| Rate-limit excedido | `429 rate_limited` + `Retry-After` | AC-6 |
| Upstash ausente en prod (Didit configurado) | `503 rate_limit_unavailable` (fail-closed) | AC-6 |
| Upstash error transitorio | `console.warn` + fail-OPEN (permite) | §4.4 |
| Body con `callback` | ignorado (nunca reenviado) | AC-8 / AC-9 |
| Didit responde no-2xx | `502` (preservado) | — |

---

## 8. Waves — con snippets objetivo por archivo

### Wave 0 (Serial Gate — scaffolding puro, NO toca rutas)

- **W0.1 `package.json`** — agregar a `dependencies`: `@upstash/ratelimit` + `@upstash/redis`.
  Correr `npm install` para poblar el lockfile.
- **W0.2 `src/infrastructure/kyc-auth.ts`** (NEW) — `issueSessionToken` + `verifySessionToken`
  (§3.1). `node:crypto`, `timingSafeEqual`, comparar longitud primero (CD-9). Exemplar: `system.ts`.
- **W0.3 `src/infrastructure/rate-limit.ts`** (NEW) — `checkKycRateLimit` + cliente lazy + IP source
  helper + fail-mode (§4). Exemplar: patrón Upstash.
- **W0.4 `src/infrastructure/didit/decision.ts`** — agregar `maskIdentity` + `maskDecision` (§5.3,
  CD-8). NO tocar `mapDiditDecision`.
- **W0.5 `src/application/ports.ts`** — extender 4 tipos (§2.6): `KycRequest.senderAddress?`,
  `KycStartResult` redirect `.authToken?`, `KycGateway.decision(sessionId, authToken?)`,
  `KycPending.sessionToken?`. Todos **opcionales** (preserva simulación).
- **W0.6 `.env.example`** — env vars nuevas (§9).
- **Verificación W0**: `npm run typecheck` + tests de W0 (kyc-auth, rate-limit, decision).

### Wave 1 (Parallelizable — depende de W0)

- **W1.1 `app/api/kyc/decision/route.ts`** — guard-order §5.2. Import `verifySessionToken` +
  `maskDecision`. Depende W0.2/W0.4.
- **W1.2 `app/api/kyc/session/route.ts`** — guard-order §5.1. Import `issueSessionToken` +
  `checkKycRateLimit`. Depende W0.2/W0.3.

### Wave 2 (Integración — depende de W1)

- **W2.1 `src/infrastructure/didit/kyc-gateway.ts`** — `start()`: leer `authToken` del JSON,
  incluirlo en el `return { kind:"redirect", url, sessionId, authToken }`, y mandar
  `vendorData: req.senderAddress` en el body del POST. `decision(sessionId, authToken?)`: mandar
  header `x-kyc-token` si `authToken` presente. Depende W0.5, W1.1, W1.2.
- **W2.2 `src/application/use-cases/start-kyc.ts`** — pasar `senderAddress: input.address` a
  `kyc.start(...)` (L43-48) + `sessionToken: res.authToken` a `pending.save(...)` (L60-64).
- **W2.3 `src/application/use-cases/resume-kyc.ts`** — `this.kyc.decision(p.sessionId, p.sessionToken)` (L40).
- **W2.4 `src/infrastructure/didit/kyc-gateway.test.ts`** — extender: token viaja start→decision;
  sim mode (501) sigue verde.

### Wave 3 (Final)

- **W3.1** `npm run qa` (typecheck + todos los tests) + `npm run build`. Readiness (§12).

---

## 9. Env vars nuevas (para `.env.example`)

Documentar SIN valor real (CD-3), con la convención `.env.example:4-16`:

```
# ── KYC — auth de sesión (WKH-179) ──
# Secreto HMAC para firmar el token de sesión (x-kyc-token). Obligatorio cuando DIDIT_API_KEY está seteado.
KYC_SESSION_SECRET=
# Base URL server-side para el callback a Didit (M6). Si vacío → sesión sin callback (Didit default; el resume anda por localStorage).
KYC_CALLBACK_BASE_URL=

# ── Rate-limit (Upstash Redis, WKH-179) ── Obligatorias cuando DIDIT_API_KEY está seteado (prod).
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
# Overrides opcionales (defaults: 10/"10 m" por IP, 3/"10 m" por address).
KYC_RL_IP_MAX=
KYC_RL_IP_WINDOW=
KYC_RL_ADDR_MAX=
KYC_RL_ADDR_WINDOW=
```

---

## 10. Test Plan (16 tests — ≥1 por AC)

| # | Test | Archivo | Cubre | Wave |
|---|------|---------|-------|------|
| 1 | token válido → 200 + decision | `app/api/kyc/decision/route.test.ts` | AC-1 | W1 |
| 2 | sin `x-kyc-token` → 401, `fetch` NO llamado | `decision/route.test.ts` | AC-2, AC-7 | W1 |
| 3 | token errado → 401 genérico (mismo body que "sin token"), `fetch` NO llamado | `decision/route.test.ts` | AC-2, CD-5, AC-7 | W1 |
| 4 | respuesta enmascara `documentNumber` (`****6677`) y conserva `firstName`/`dateOfBirth` | `decision/route.test.ts` + `decision.test.ts` | AC-3 | W0/W1 |
| 5 | masking edge: len≤4 → `****`; vacío → `""` | `decision.test.ts` | AC-3, CD-8 | W0 |
| 6 | sin `DIDIT_API_KEY` → 501 (ambas rutas), sin exigir token | `decision/route.test.ts`, `session/route.test.ts` | AC-4 | W1 |
| 7 | 501 → `start` delega en fallback (existente sigue verde) | `kyc-gateway.test.ts` | AC-4, AC-10 | W2 |
| 8 | `POST /session`: rate-limit consultado antes de `fetch` | `session/route.test.ts` | AC-5 | W1 |
| 9 | limiter `ok:false` → 429 + `Retry-After`, `fetch` NO llamado | `session/route.test.ts` + `rate-limit.test.ts` | AC-6, AC-7 | W0/W1 |
| 10 | Upstash ausente + Didit configurado → 503 fail-closed | `rate-limit.test.ts` | AC-6 | W0 |
| 11 | Upstash error transitorio → fail-open + `console.warn` | `rate-limit.test.ts` | §4.4 | W0 |
| 12 | `callback` del body ignorado; a Didit va el server-side | `session/route.test.ts` | AC-8 | W1 |
| 13 | `body.callback="http://evil"` NUNCA en el payload a Didit | `session/route.test.ts` | AC-9 | W1 |
| 14 | modo simulación end-to-end sin token/Upstash (501 path) | `kyc-gateway.test.ts` | AC-10 | W2 |
| 15 | `issue`/`verify` HMAC determinístico + timing-safe + mismatch de longitud sin throw | `kyc-auth.test.ts` | AC-1/AC-2, CD-9 | W0 |
| 16 | token viaja start()→pending→decision() (integración) | `kyc-gateway.test.ts` | AC-1 | W2 |

**Patrón obligatorio (CD-C)**: `vitest` + `vi.stubGlobal("fetch", vi.fn(async () => ({...})))` +
`vi.stubEnv("DIDIT_API_KEY", ...)` + `afterEach(() => vi.restoreAllMocks())`. Exemplar:
`kyc-gateway.test.ts`. Para tests de rutas, importá `POST`/`GET` del route module y construí
`new Request(url, { method, headers, body })`.

---

## 11. Constraint Directives (checklist — el Dev marca cada una)

- [ ] **CD-1** — Solo `chaski-v2/`. NO tocar demo live (`yarvis`/`wasiai-v2`/`agentshop-*`), NO `doc/sdd/001-*`.
- [ ] **CD-2** — 401/403/429/503 SIEMPRE **antes** de cualquier `fetch()` a Didit (guard es el primer bloque tras 501/500).
- [ ] **CD-3** — Sin secrets hardcodeados. `KYC_SESSION_SECRET` + tokens Upstash SOLO por env, en `.env.example` sin valor.
- [ ] **CD-4** — Preservar `501` cuando falta `DIDIT_API_KEY`/`DIDIT_WORKFLOW_ID` (primer check).
- [ ] **CD-5** — Mismo cuerpo/status genérico para "sin token" y "token inválido" (anti-enumeración).
- [ ] **CD-6** — NO tocar `src/presentation/*` (flow.tsx, ui.tsx). El token viaja por application/infra.
- [ ] **CD-7** — `DIDIT_API_KEY` presente pero `KYC_SESSION_SECRET` ausente → `500` fail-closed (ambas rutas).
- [ ] **CD-8** — Nunca exponer `documentNumber` con <4 dígitos en claro; vacío→`""`; len≤4→todo `"*"`.
- [ ] **CD-9** — NO `timingSafeEqual` con buffers de distinta longitud (throws). Comparar longitud primero.
- [ ] **CD-10** — NO confundir `sessionToken` (de Didit, `session/route.ts:32`) con `authToken` (nuestro HMAC).
- [ ] **CD-11** — NO contadores de rate-limit en memoria. Solo Upstash.
- [ ] **CD-A** — `node:crypto` (`createHmac`, `timingSafeEqual`). NO `jsonwebtoken`/`jose`.
- [ ] **CD-B** — Masking como función pura en `decision.ts`, testeable sin I/O.
- [ ] **CD-C** — Tests con `vitest` + `vi.stubGlobal("fetch")` + `vi.stubEnv` + `afterEach(restoreAllMocks)`.
- [ ] **CD-D** — Rutas en runtime Node (default Next 16). NO agregar `export const runtime = "edge"`.

---

## 12. Anti-Hallucination Checklist (verificar antes de empezar F3)

- [x] `app/api/kyc/session/route.ts` — firma `POST(req: Request): Promise<Response>`, `callback` en L22, return L32 con `sessionToken` de Didit — VERIFICADO.
- [x] `app/api/kyc/decision/route.ts` — firma `GET(req: Request): Promise<Response>`, `mapDiditDecision` en L24, 400 missing_session en L13 — VERIFICADO.
- [x] `mapDiditDecision` puro en `decision.ts:29-54`, `documentNumber` L39 — VERIFICADO.
- [x] `DiditKycGateway.start` L16-26 (no manda vendorData) / `.decision` L28-44 (sin header auth) — VERIFICADO.
- [x] `LocalKycPendingStore.save` serializa vía `JSON.stringify` (L9) → campo nuevo sin cambio de código — VERIFICADO.
- [x] `start-kyc.ts` L43-48 `kyc.start`, L60-64 `pending.save` — VERIFICADO.
- [x] `resume-kyc.ts` L40 `decision(p.sessionId)`, catch reintentable L41-42 — VERIFICADO.
- [x] `ports.ts` L27-32 `KycRequest`, L34-36 `KycStartResult`, L42-45 `KycGateway`, L48-52 `KycPending` — VERIFICADO.
- [x] `system.ts:12` `globalThis.crypto` (no hay helper HMAC) — VERIFICADO.
- [x] `FallbackKycGateway.decision(_sessionId)` `gateways.ts:69` sigue asignable — VERIFICADO.
- [x] `flow.tsx:519` (NO 492) hace `documentNumber.slice(-4)` → tolera `****6677` — VERIFICADO/CORREGIDO.
- [x] `flow.tsx:186-187` sigue mandando `callbackUrl` (la ruta lo ignora) — VERIFICADO.
- [x] `package.json` sin `@upstash/*`, test runner `vitest`, `"qa"` script existe — VERIFICADO.
- [x] `kyc-gateway.test.ts` exemplar `vi.stubGlobal("fetch")` + `afterEach(restoreAllMocks)` — VERIFICADO.
- [x] `.env.example:4-16` convención `VAR=` sin valor — VERIFICADO.

---

## 13. Done Definition

- [ ] Los 17 archivos del Scope IN modificados/creados según Waves (nada fuera del scope, CD-1).
- [ ] Los 15 Constraint Directives (§11) cumplidos.
- [ ] Los 16 tests (§10) escritos y en verde; ≥1 test por AC (AC-1..AC-10).
- [ ] `npm run typecheck` (== `tsc --noEmit`) → 0 errores.
- [ ] `npm test` (== `vitest run`) → todo verde.
- [ ] `npm run build` (`next build --webpack`) → OK.
- [ ] `.env.example` documenta las 8 env vars nuevas sin valor real.
- [ ] Sin `export const runtime = "edge"` en las rutas (CD-D).
- [ ] `mapDiditDecision` sin cambios (masking compuesto en la ruta, CD-B).

---

*Story File generado por NexusAgil — nexus-architect F2.5 — a partir del SDD #002 (SPEC_APPROVED).*
