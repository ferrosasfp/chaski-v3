# SDD #002: [WKH-179] Cerrar IDOR PII + auth/rate-limit en /api/kyc/*

> SPEC_APPROVED: no
> Fecha: 2026-07-10
> Tipo: improvement (seguridad)
> SDD_MODE: full
> Branch: fix/179-kyc-idor-auth-ratelimit
> Artefactos: doc/sdd/002-wkh-179-kyc-idor-auth-ratelimit/

---

## 1. Resumen

`app/api/kyc/decision/route.ts` devuelve la identidad completa (DNI, fecha de nacimiento, nombres)
de **cualquier** sesión KYC a **cualquier** caller que conozca (o adivine) el `sessionId` — IDOR /
fuga de PII (hallazgo B1). `app/api/kyc/session/route.ts` no tiene auth ni rate-limit: cada POST
dispara una verificación que Chaski paga en Didit (financial-DoS, A2). Además el `callback` del body
se reenvía tal cual a Didit sin sanitizar (M6, riesgo SSRF/open-redirect).

Esta HU cierra los tres huecos **solo** en `chaski-v2/app/api/kyc/*` y sus helpers de
infraestructura/aplicación directos, sin tocar la presentación (`flow.tsx`/`ui.tsx`) ni el demo live
(`yarvis`/`wasiai-v2`). El diseño:

1. **Binding sesión↔caller (B1)** — token HMAC stateless emitido en `POST /session` y exigido en
   `GET /decision` (verificación timing-safe). Sin SIWE (descartado por fricción UX).
2. **Rate-limit (A2)** — `@upstash/ratelimit` + `@upstash/redis` por IP (primario) + address
   (secundario), evaluado **antes** de llamar a Didit.
3. **Callback (M6)** — se ignora `body.callback` y se reconstruye server-side desde env.
4. **Masking (defensa en profundidad)** — `documentNumber` enmascarado (últimos 4) en la respuesta
   HTTP, aún con token válido.

Todo preservando el comportamiento `501` en modo simulación (sin `DIDIT_API_KEY`).

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 002 (WKH-179) |
| **Tipo** | improvement / seguridad |
| **SDD_MODE** | full |
| **Objetivo** | Cerrar IDOR de PII (B1), agregar auth + rate-limit (A2) y sanitizar callback (M6) en `/api/kyc/*` |
| **Reglas de negocio** | KYC-once por wallet; el KYC lo hace Didit (hosted). Free tier 500 verif/mes → cada `POST /session` cuesta cuota real |
| **Scope IN** | Ver §6 IN |
| **Scope OUT** | Ver §6 OUT |
| **Missing Inputs** | Ninguno bloqueante — los 3 `[NEEDS CLARIFICATION]` del work-item quedan RESUELTOS por decisión del humano (§10) |

### Acceptance Criteria (EARS)

Heredados del work-item sin cambios semánticos (referencia rápida; la fuente es `work-item.md:46-87`):

- **AC-1** — WHEN `GET /api/kyc/decision?sessionId=<x>`, THE system SHALL devolver el payload solo si
  el caller presenta un **token HMAC válido** asociado al `sessionId` (mecanismo: §4.3.1 / DT-1).
- **AC-2** — IF el token es missing/malformed/no-coincide, THEN THE system SHALL responder `401`
  SIN llamar a Didit y SIN filtrar si el `sessionId` existe.
- **AC-3** — WHEN se devuelve una decisión, THE system SHALL NO incluir el `documentNumber` crudo
  (enmascarado a últimos 4); `dateOfBirth`/nombres quedan sujetos al auth check de AC-1.
- **AC-4** — WHERE `DIDIT_API_KEY` ausente, THE system SHALL responder `501` como hoy, evaluado
  ANTES del auth/rate-limit check (preserva el fallback/simulación).
- **AC-5** — WHEN `POST /api/kyc/session`, THE system SHALL exigir identidad de caller
  (IP + address opcional) ANTES de invocar Didit.
- **AC-6** — WHILE un caller excede el umbral de rate-limit en la ventana configurada, THE system
  SHALL rechazar con `429` SIN llamar a Didit.
- **AC-7** — IF una request es rechazada por auth (AC-2/AC-5) o rate-limit (AC-6), THEN THE system
  SHALL NO hacer ninguna llamada saliente a Didit.
- **AC-8** — WHEN se construye el `callback` a Didit, THE system SHALL ignorar cualquier `callback`
  del body y construirlo server-side desde env allow-listed.
- **AC-9** — IF el body trae `callback`, THEN THE system SHALL NO reenviar ese valor crudo a Didit.
- **AC-10** — WHILE modo simulación/fallback (sin `DIDIT_API_KEY`), THE system SHALL preservar el
  flujo existente sin cambios en la UI/presentación.

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón / hallazgo (archivo:línea) |
|---------|---------|-----------------------------------|
| `app/api/kyc/session/route.ts` | Ruta a proteger (A2, M6) | `POST` sin auth/RL. `route.ts:11` → 501 si no hay key. `route.ts:14` parsea `{vendorData?, callback?}`. `route.ts:16-25` `fetch` a Didit reenviando `callback: body.callback` crudo (M6). `route.ts:32` devuelve `{sessionId, url, sessionToken}` (el `sessionToken` es de Didit, no nuestro) |
| `app/api/kyc/decision/route.ts` | Ruta a proteger (B1) | `decision/route.ts:10` → 501 si no hay key. `decision/route.ts:12-13` lee `sessionId` de la query, sin binding al caller. `decision/route.ts:23-24` devuelve `mapDiditDecision(decision)` COMPLETO (incluye `identity`) — IDOR |
| `src/infrastructure/didit/decision.ts` | Mapper puro compartido; donde va el masking (DT-4) | `decision.ts:29-54` `mapDiditDecision(raw)` → `DiditDecisionResult`. `decision.ts:33-43` arma `identity` con `documentNumber` (l.39), `dateOfBirth` (l.40), nombres sin máscara. Es puro y testeable (patrón a seguir para `maskIdentity`) |
| `src/infrastructure/didit/kyc-gateway.ts` | Adapter cliente; debe transportar el token start→decision | `kyc-gateway.ts:16-26` `start()` hace `POST /api/kyc/session` (solo `callback`, NO `vendorData`). `kyc-gateway.ts:22` cae al fallback si status 501. `kyc-gateway.ts:28-44` `decision()` hace `GET /api/kyc/decision?sessionId=` **sin header de auth**. l.30 fallback si 501 |
| `src/infrastructure/kyc-pending-store.ts` | Persiste el pendiente client-side (localStorage) — debe cargar el token | `kyc-pending-store.ts:8-9` `save(p)` hace `JSON.stringify(p)` → **serializa cualquier campo nuevo del tipo sin cambio de código**. l.16 `JSON.parse` |
| `src/application/use-cases/start-kyc.ts` | Orquesta el `pending.save` tras el redirect (donde persiste el token) | `start-kyc.ts:43-48` llama `kyc.start(...)`. `start-kyc.ts:60-64` `pending.save({remittanceId, sessionId, address})` — acá se agrega el `sessionToken` |
| `src/application/use-cases/resume-kyc.ts` | Lee el pendiente y llama `decision()` al volver (donde se reenvía el token) | `resume-kyc.ts:24-25` lee `pending.get()`. `resume-kyc.ts:40` `this.kyc.decision(p.sessionId)` — acá se agrega `p.sessionToken` |
| `src/presentation/flow.tsx` | Confirmar que NO hay que tocar presentación | Resume corre en `flow.tsx:85-132` **sin depender del query param** (lee el pending store en cada mount) → el callback server-side no afecta el resume. `flow.tsx:492` muestra `••••{documentNumber.slice(-4)}` → tolera un `documentNumber` ya enmascarado (`****5678`.slice(-4)==="5678"): **masking no rompe la UI** |
| `src/application/ports.ts` | Donde se extienden los tipos del contrato | `ports.ts:34-36` `KycStartResult` (variante `redirect`). `ports.ts:42-45` `KycGateway` (`decision(sessionId)`). `ports.ts:48-52` `KycPending`. `ports.ts:27-32` `KycRequest` |
| `src/infrastructure/fallback/gateways.ts` | Verificar que el fallback sobrevive al cambio de firma | `gateways.ts:69` `FallbackKycGateway.decision(_sessionId: string)` — firma con menos params **es asignable** a `decision(sessionId, token?)`; **no requiere cambio**. `gateways.ts:82-88` identidad simulada (documentNumber `44556677`) |
| `src/composition/container.ts` | Wiring; confirmar que no cambia | `container.ts:47` cablea `new DiditKycGateway(new FallbackKycGateway())`. No cambia (el token viaja por tipos, no por wiring) |
| `src/infrastructure/system.ts` | Buscar helper crypto existente | `system.ts:12` usa `globalThis.crypto.randomUUID()`. **No hay helper de HMAC** → se crea `kyc-auth.ts` con `node:crypto` |
| `.env.example` | Convención de env vars (CD-3) | `.env.example:7-16` `DIDIT_API_KEY`/`DIDIT_WORKFLOW_ID`/`DIDIT_BASE_URL`/`NEXT_PUBLIC_KYC_MODE`, todas sin valor real |
| `package.json` | Confirmar deps ausentes | `package.json:17-30` sin `@upstash/*`, sin `siwe`, sin `ioredis`. Test runner: `vitest` (l.39). Sin vitest.config (usa defaults) |
| `src/infrastructure/didit/kyc-gateway.test.ts` | Exemplar de test (mock fetch con vitest) | Patrón `vi.stubGlobal("fetch", vi.fn(async () => ({...})))` + `vi.restoreAllMocks()` en `afterEach`. Exemplar directo para los tests de rutas |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/infrastructure/kyc-auth.ts` (NEW) | `src/infrastructure/system.ts` | módulo infra puro sin estado, funciones exportadas; usa `node:crypto` como `system.ts` usa `globalThis.crypto` |
| `src/infrastructure/rate-limit.ts` (NEW) | patrón Upstash del ecosistema (`wasiai-facilitator`, ver §4.3.2) | `@upstash/ratelimit` + `@upstash/redis`, sliding window |
| `maskIdentity` en `decision.ts` | `mapDiditDecision` (`decision.ts:29`) | función pura, sin efectos, testeable — mismo estilo `s(v)` helper |
| tests de rutas/helpers | `kyc-gateway.test.ts` | `vi.stubGlobal("fetch", …)`, `vi.stubEnv`, `afterEach(restoreAllMocks)` |

### Estado de BD relevante

| Tabla | Existe | Notas |
|-------|--------|-------|
| — | N/A | chaski-v2 **no tiene DB** (todo localStorage). Esta HU **no** introduce una. El único store server-side nuevo es Upstash Redis (solo contadores de rate-limit, sin PII) |

### Componentes reutilizables encontrados

- `mapDiditDecision` (`decision.ts:29`) — se **reusa**; el masking se compone encima (`maskIdentity`), no se reescribe.
- `LocalKycPendingStore` (`kyc-pending-store.ts`) — **no se toca**: serializa el campo nuevo `sessionToken` automáticamente vía `JSON.stringify`.
- `FallbackKycGateway` (`gateways.ts:63`) — **no se toca**: su firma `decision(_sessionId)` sigue siendo válida.
- Patrón de test con `vi.stubGlobal("fetch")` — se reusa para las rutas.

### Auto-Blindaje histórico

No hay HUs en estado DONE en `doc/sdd/_INDEX.md` (WKH-178 y WKH-179 están ambas en F1). No existe
ningún `auto-blindaje.md`. Paso salteado (no bloqueante). Se agregan CDs defensivas propias (§5) para
los edge-cases clásicos (strings vacíos en masking, timing-safe compare, orden de guards).

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué hace | Exemplar |
|---------|--------|----------|----------|
| `src/infrastructure/kyc-auth.ts` | **Crear** | `issueSessionToken(sessionId)` + `verifySessionToken(sessionId, token)` con HMAC-SHA256 + `timingSafeEqual` | `system.ts` |
| `src/infrastructure/rate-limit.ts` | **Crear** | `checkKycRateLimit({ip, address})` → `{ ok, retryAfter? }`; cliente Upstash lazy; fail-mode | patrón Upstash |
| `app/api/kyc/session/route.ts` | Modificar | orden guards (501 → RL → build callback server-side → Didit → issue token → responder `authToken`) | — |
| `app/api/kyc/decision/route.ts` | Modificar | orden guards (501 → verificar token → Didit → mask → responder) | — |
| `src/infrastructure/didit/decision.ts` | Modificar | agregar `maskIdentity(identity)` puro (últimos 4 de `documentNumber`) | `mapDiditDecision` |
| `src/infrastructure/didit/kyc-gateway.ts` | Modificar | leer `authToken` de `/session`; devolverlo en `KycStartResult`; enviar `x-kyc-token` en `decision()`; enviar `senderAddress` como `vendorData` | — |
| `src/application/ports.ts` | Modificar | extender tipos (§4.3.4) | — |
| `src/application/use-cases/start-kyc.ts` | Modificar | persistir `sessionToken` en `pending.save` + pasar `senderAddress` a `kyc.start` | — |
| `src/application/use-cases/resume-kyc.ts` | Modificar | pasar `p.sessionToken` a `kyc.decision(...)` | — |
| `.env.example` | Modificar | documentar env vars nuevas (§4.4) | `.env.example:7-16` |
| `package.json` | Modificar | agregar `@upstash/ratelimit` + `@upstash/redis` | — |
| `src/infrastructure/kyc-auth.test.ts` | **Crear** | unit tests del helper HMAC | `kyc-gateway.test.ts` |
| `src/infrastructure/rate-limit.test.ts` | **Crear** | unit tests fail-mode + límite | `kyc-gateway.test.ts` |
| `src/infrastructure/didit/decision.test.ts` | **Crear** | unit tests de `maskIdentity` | `kyc-gateway.test.ts` |
| `app/api/kyc/session/route.test.ts` | **Crear** | tests de la ruta (501/RL/callback/token) | `kyc-gateway.test.ts` |
| `app/api/kyc/decision/route.test.ts` | **Crear** | tests de la ruta (501/IDOR/mask) | `kyc-gateway.test.ts` |
| `src/infrastructure/didit/kyc-gateway.test.ts` | Modificar | extender: token viaja start→decision | (self) |

### 4.2 Modelo de datos

N/A — sin DB. Único estado server nuevo: contadores efímeros de rate-limit en Upstash Redis (keys
`kyc:rl:ip:<ip>` y `kyc:rl:addr:<address>`, TTL corto, **sin PII**).

### 4.3 Componentes / Servicios

#### 4.3.1 Token HMAC de sesión (B1 — DT-1)

**Emisión** (en `POST /session`, después de que Didit devuelve `session_id`):

```
authToken = base64url( HMAC-SHA256( KYC_SESSION_SECRET, session_id ) )
```

- Determinístico sobre `session_id` → stateless, no requiere almacenamiento server-side.
- Se devuelve **una sola vez** en la respuesta de `/session` como campo `authToken`
  (distinto del `sessionToken` de Didit, que ya existe en la respuesta — **NO confundir nombres**).
- El secreto vive SOLO en env (`KYC_SESSION_SECRET`, CD-3), nunca se expone al browser.

**Persistencia client-side**: `DiditKycGateway.start()` lee `authToken` del JSON → lo propaga en
`KycStartResult.redirect.authToken` → `StartKyc.execute` lo guarda en el pending
(`pending.save({..., sessionToken: authToken})`) → `LocalKycPendingStore` lo serializa a localStorage.

**Verificación** (en `GET /decision`, header `x-kyc-token`):

1. Leer `sessionId` (query) y `x-kyc-token` (header).
2. Si falta alguno → `401` genérico (sin llamar a Didit, CD-5).
3. Recalcular `expected = HMAC(secret, sessionId)`.
4. Comparar `expected` vs `token` con `crypto.timingSafeEqual` (buffers de igual longitud; si difieren
   en longitud → tratar como mismatch **sin** throw, ver CD-9).
5. Mismatch → `401` con el **mismo cuerpo/status** que "falta token" (CD-5, anti-enumeración).
6. Match → recién ahí `fetch` a Didit.

**Garantía y límite (documentado)**: cierra el IDOR — un atacante con solo el `sessionId` no puede
forjar el token sin el secreto. **NO** prueba criptográficamente posesión de la wallet: si el token se
filtra (logs/XSS/history) es replayable. Aceptado para hackathon/prod-inicial por decisión del humano
(§10). SIWE queda deferred (Scope OUT).

**Compat legacy (sesiones en vuelo sin token)**: un `KycPending` viejo en localStorage (creado antes
del deploy) no tiene `sessionToken` → `decision()` no manda header → server responde `401`. Decisión:
**fail-closed** — la sesión legacy en vuelo se rompe y el usuario reinicia el KYC. Es un caso raro
(mismo browser, KYC a mitad, justo durante el deploy) y la opción segura. `ResumeKyc` ya trata el
error de `decision()` como reintentable/`processing` (`resume-kyc.ts:41-42`); tras agotar reintentos
la UI muestra el mensaje existente. No se agrega migración.

#### 4.3.2 Rate-limit Upstash (A2 — DT-2)

Librerías nuevas: `@upstash/ratelimit` + `@upstash/redis` (REST, sirve en runtime Node de Vercel).

- **Cliente lazy**: se construye una sola vez desde `UPSTASH_REDIS_REST_URL` +
  `UPSTASH_REDIS_REST_TOKEN`. Sliding window.
- **Keys**:
  - IP (primario, siempre): `Ratelimit.slidingWindow(KYC_RL_IP_MAX, KYC_RL_IP_WINDOW)`.
  - Address (secundario, solo si `body.vendorData`/senderAddress presente): límite más estricto.
- **IP source**: `req.headers.get("x-forwarded-for")` (primer IP, leftmost) con fallback
  `x-real-ip`; si ninguno → `"unknown"` (Vercel siempre setea `x-forwarded-for`).
- **Orden**: se evalúa **antes** del `fetch` a Didit (CD-2). Se chequean ambas keys; si **cualquiera**
  excede → `429` con header `Retry-After`, sin llamar a Didit (AC-6/AC-7).
- **Valores por defecto** (env-overridable, no son secretos):
  - `KYC_RL_IP_MAX = 10`, `KYC_RL_IP_WINDOW = "10 m"` (10 sesiones / 10 min por IP).
  - `KYC_RL_ADDR_MAX = 3`, `KYC_RL_ADDR_WINDOW = "10 m"` (3 / 10 min por address).
  - Rationale: KYC-once → un usuario legítimo hace ~1 verificación; los límites dejan margen para
    reintentos genuinos pero cortan el abuso automatizado antes de quemar cuota de Didit.

**Fail-mode** (decisión documentada):

| Escenario | Comportamiento | Rationale |
|-----------|----------------|-----------|
| Upstash **no configurado** (env vars ausentes) **y** Didit configurado (prod-like) | **fail-CLOSED** → `503 rate_limit_unavailable`, NO llama a Didit | proteger el costo es el objetivo; un limiter mal configurado no debe exponer a financial-DoS. Fuerza config correcta en prod |
| Modo simulación (sin `DIDIT_API_KEY`) | rate-limit **nunca se invoca** (el guard 501 corre primero) | dev/local sin Upstash sigue funcionando; no hay costo que proteger |
| Upstash configurado pero **error transitorio** en runtime (red/timeout) | **fail-OPEN** con `console.warn`, permite la request | disponibilidad: un blip de Redis no debe tumbar el KYC; ventana de exposición mínima |

Consecuencia clave: **en local/simulación no se necesita Upstash** (el 501 corta antes). Solo cuando
`DIDIT_API_KEY` está seteado (prod real) Upstash pasa a ser requerido.

#### 4.3.3 Masking de identidad (DT-4)

`maskIdentity(identity: VerifiedIdentity): VerifiedIdentity` — pura, en `decision.ts`:

- `documentNumber` → `"*".repeat(max(0, len-4)) + last4`. Ej. `"44556677"` → `"****6677"`.
- Edge cases (CD-8): `len <= 4` → todo `"*"` (nunca exponer <4 dígitos en claro);
  string vacío → `""` (identity nula ya se filtra por `mapDiditDecision`).
- Resto de campos (`firstName`, apellidos, `dateOfBirth`, `nationality`, `documentType`) **intactos**
  (siguen protegidos por el auth check de AC-1; el masking es defensa en profundidad solo sobre el
  número, per §10 punto 4).

Aplicación: **en la ruta `/decision`**, componiendo sobre el mapper —
`maskDecision(mapDiditDecision(raw))` donde `maskDecision` aplica `maskIdentity` si `identity != null`.
`mapDiditDecision` se deja sin cambios (raw) para un futuro gate server-only; el **límite HTTP siempre
enmascara**. La UI (`flow.tsx:492`) ya hace `.slice(-4)` → sigue mostrando `••••6677`, sin cambio.

#### 4.3.4 Extensión de tipos (`ports.ts`)

- `KycStartResult` variante `redirect`: agregar `authToken?: string`
  (`{ kind: "redirect"; url: string; sessionId: string; authToken?: string }`).
- `KycPending`: agregar `sessionToken?: string`.
- `KycGateway.decision`: cambiar firma a `decision(sessionId: string, authToken?: string)`.
  Retrocompatible: `FallbackKycGateway.decision(_sessionId)` sigue siendo asignable (menos params OK).
- `KycRequest`: agregar `senderAddress?: string` (para rate-limit secundario + `vendor_data` de Didit).

`opcional` en todos: preserva el path de simulación (`FallbackKycGateway` no setea `authToken` → en
modo simulación no hay token que verificar porque el 501 corta antes en la ruta).

### 4.4 Env vars nuevas (`.env.example`)

| Var | Obligatoria cuando | Descripción |
|-----|--------------------|-------------|
| `KYC_SESSION_SECRET` | `DIDIT_API_KEY` presente | secreto HMAC para firmar el token de sesión. Sin valor real en el repo (CD-3) |
| `KYC_CALLBACK_BASE_URL` | opcional | base URL server-side para el callback a Didit (M6). Si ausente → sesión sin callback (Didit muestra su pantalla default; el resume funciona igual por localStorage) |
| `UPSTASH_REDIS_REST_URL` | `DIDIT_API_KEY` presente (prod) | endpoint REST de Upstash Redis |
| `UPSTASH_REDIS_REST_TOKEN` | `DIDIT_API_KEY` presente (prod) | token REST de Upstash |
| `KYC_RL_IP_MAX` | opcional (default 10) | máx sesiones por IP en la ventana |
| `KYC_RL_IP_WINDOW` | opcional (default `"10 m"`) | ventana sliding por IP |
| `KYC_RL_ADDR_MAX` | opcional (default 3) | máx sesiones por address |
| `KYC_RL_ADDR_WINDOW` | opcional (default `"10 m"`) | ventana sliding por address |

**Config-guard** (CD-7): si `DIDIT_API_KEY` está presente pero falta `KYC_SESSION_SECRET`, ambas
rutas responden `500 server_misconfigured` sin llamar a Didit (fail-closed: no se debe emitir/verificar
tokens sin secreto ni exponer PII por accidente).

### 4.5 Flujo principal (Happy Path)

**`POST /api/kyc/session`** (orden exacto de guards — CD-2/CD-4/CD-7):

1. Config: si falta `DIDIT_API_KEY`/`DIDIT_WORKFLOW_ID` → `501 didit_not_configured` (AC-4).
2. Config-guard: si falta `KYC_SESSION_SECRET` → `500 server_misconfigured` (CD-7).
3. Rate-limit: `checkKycRateLimit({ip, address})` → si excede → `429` + `Retry-After`, **sin fetch**
   (AC-5/AC-6/AC-7). Fail-closed si Upstash ausente en prod (§4.3.2).
4. Callback: construir server-side desde `KYC_CALLBACK_BASE_URL` (o omitir). **Ignorar** `body.callback`
   (AC-8/AC-9).
5. `fetch` a Didit `POST /v3/session/` con `vendor_data: senderAddress`, `callback` server-side.
6. Emitir `authToken = HMAC(secret, session_id)`.
7. Responder `{ sessionId, url, authToken }`.

**`GET /api/kyc/decision`** (orden exacto):

1. Config: si falta `DIDIT_API_KEY` → `501` (AC-4).
2. Config-guard: si falta `KYC_SESSION_SECRET` → `500` (CD-7).
3. Leer `sessionId` (query) + `x-kyc-token` (header). Falta `sessionId` → `400 missing_session`
   (se mantiene el comportamiento actual). Falta token → `401` (AC-2), **sin fetch**.
4. `verifySessionToken(sessionId, token)` timing-safe. Mismatch → `401` genérico (CD-5), **sin fetch**.
5. `fetch` a Didit `GET /v3/session/{id}/decision/`.
6. `maskDecision(mapDiditDecision(json))` → responder (AC-3).

**Client (transporte del token)**:

`StartKyc` → `gateway.start()` → `POST /session` → `{authToken}` → `pending.save({sessionToken})`
→ (redirect a Didit + vuelta) → `ResumeKyc` → `gateway.decision(sessionId, pending.sessionToken)`
→ `GET /decision` con `x-kyc-token`.

### 4.6 Flujo de error

| Condición | Respuesta | AC |
|-----------|-----------|-----|
| Sin `DIDIT_API_KEY` | `501` (fallback simulación) | AC-4/AC-10 |
| `DIDIT_API_KEY` sin `KYC_SESSION_SECRET` | `500 server_misconfigured` | CD-7 |
| `/decision` sin token o token inválido | `401` (cuerpo genérico) | AC-1/AC-2/AC-5 |
| Rate-limit excedido | `429` + `Retry-After` | AC-6 |
| Upstash ausente en prod | `503 rate_limit_unavailable` | AC-6 (fail-closed) |
| Body con `callback` | se ignora (nunca reenviado) | AC-8/AC-9 |
| Didit responde no-2xx | `502` (comportamiento actual preservado) | — |

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir

- **CD-A**: usar `node:crypto` (`createHmac`, `timingSafeEqual`) para el token — igual filosofía que
  `system.ts:12` (`globalThis.crypto`). NO agregar `jsonwebtoken` ni `jose`.
- **CD-B**: masking como función **pura** en `decision.ts`, estilo `mapDiditDecision`
  (`decision.ts:29`) — testeable sin I/O.
- **CD-C**: tests con `vitest` + `vi.stubGlobal("fetch",…)` + `vi.stubEnv` + `afterEach(restoreAllMocks)`,
  patrón de `kyc-gateway.test.ts`.
- **CD-D**: las rutas corren en **runtime Node** (default de Next 16). NO agregar
  `export const runtime = "edge"` (rompería `node:crypto`).

### Heredadas del work-item (siguen vigentes)

- **CD-1**: PROHIBIDO tocar archivos fuera de `chaski-v2/`. PROHIBIDO tocar el demo live
  (`yarvis`, `wasiai-v2`, `agentshop-*`). PROHIBIDO tocar `doc/sdd/001-wkh-178-*`.
- **CD-2**: OBLIGATORIO devolver 401/403/429/503 **antes** de cualquier `fetch()` a Didit — el guard
  es el PRIMER bloque de cada handler (tras el 501/500 de config).
- **CD-3**: PROHIBIDO secrets hardcodeados. `KYC_SESSION_SECRET` y tokens Upstash SOLO por env,
  documentados en `.env.example` sin valor real.
- **CD-4**: OBLIGATORIO preservar el `501` cuando falta `DIDIT_API_KEY`/`DIDIT_WORKFLOW_ID`; el guard
  de config es el PRIMER check, antes de auth/rate-limit.
- **CD-5**: PROHIBIDO revelar si un `sessionId` existe a un caller no autorizado — mismo cuerpo/status
  genérico para "sin token" y "token inválido".

### PROHIBIDO (específico de esta HU)

- **CD-6**: NO tocar `src/presentation/*` (`flow.tsx`, `ui.tsx`), ni el demo live. El token viaja por
  la capa application/infra; la UI no cambia (verificado: `flow.tsx:85-132`, `flow.tsx:492`).
- **CD-7**: NO permitir operar sin `KYC_SESSION_SECRET` cuando Didit está configurado → `500`
  fail-closed (nunca emitir/verificar tokens sin secreto).
- **CD-8**: NO exponer `documentNumber` con `< 4` dígitos en claro; string vacío → `""`; `len<=4` →
  todo `"*"`. (edge-case masking).
- **CD-9**: NO llamar `timingSafeEqual` con buffers de distinta longitud (throws) — comparar longitud
  primero y tratar el mismatch de longitud como token inválido, sin throw.
- **CD-10**: NO renombrar/confundir el `sessionToken` de Didit (ya en `session/route.ts:32`) con
  nuestro `authToken` HMAC — son campos distintos.
- **CD-11**: NO introducir contadores de rate-limit **en memoria** (Vercel serverless efímero) — solo
  Upstash (DT-2 / `work-item.md:138`).

## 6. Scope

**IN:**

- `app/api/kyc/session/route.ts`, `app/api/kyc/decision/route.ts` — guards + masking + callback.
- `src/infrastructure/kyc-auth.ts` (NEW), `src/infrastructure/rate-limit.ts` (NEW).
- `src/infrastructure/didit/decision.ts` — `maskIdentity`/`maskDecision`.
- `src/infrastructure/didit/kyc-gateway.ts` — transporte del token + `senderAddress`.
- `src/application/ports.ts` — extensión de tipos.
- `src/application/use-cases/start-kyc.ts`, `src/application/use-cases/resume-kyc.ts` — persistir y
  reenviar el token. **[Extensión de scope respecto al work-item]** — imprescindible para que AC-1
  funcione end-to-end (el pending store lo orquestan estos use-cases; son capa de aplicación, NO
  presentación). Ver Riesgo R-4.
- `.env.example`, `package.json`.
- Tests: los 5 archivos nuevos + extender `kyc-gateway.test.ts`.

**OUT:**

- SIWE / verificación criptográfica de posesión de wallet (deferred, DT-1).
- `src/presentation/*` (flow.tsx, ui.tsx) — CD-6.
- `LocalKycPendingStore` (`kyc-pending-store.ts`) — no cambia (serializa el campo nuevo solo).
- `FallbackKycGateway` / `container.ts` — no cambian.
- `mapDiditDecision` interno (se deja raw; el masking se compone en la ruta).
- Cualquier `app/api/*` fuera de `kyc/*`; DB/RLS; demo live; `doc/sdd/001-*`.

## 7. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| R-1: acoplar disponibilidad de KYC a Upstash (fail-closed) | M | M | fail-closed solo con Didit configurado; sim/local sin Upstash sigue OK (501 corta antes) |
| R-2: token replayable si se filtra (no prueba posesión de wallet) | M | M | residual aceptado (§10); SIWE deferred. Token corto de vida efectiva (KYC es de un solo uso), no persiste server-side |
| R-3: sesiones legacy en vuelo se rompen tras deploy | B | B | fail-closed + `ResumeKyc` ya reintenta y degrada al mensaje existente; caso raro |
| R-4: solape con WKH-178 en `resume-kyc.ts` (`work-item.md:190-197`) | M | M | WKH-178 lee `resume-kyc.ts:50` y **NO** toca `kyc-gateway.ts` (`001-wkh-178/work-item.md:70`). Coordinar orden de merge; el cambio de esta HU en resume-kyc es 1 línea (pasar `p.sessionToken`) → bajo conflicto |
| R-5: `timingSafeEqual` throw por longitudes distintas | B | M | CD-9: comparar longitud antes |
| R-6: masking rompe la UI | B | B | verificado `flow.tsx:492` tolera `****6677` |
| R-7: `runtime edge` accidental rompe `node:crypto` | B | A | CD-D |

## 8. Dependencias

- Nuevas deps npm: `@upstash/ratelimit`, `@upstash/redis` (Scope OUT del work-item las declaraba
  "decisión de Architect" → **RESUELTO: se agregan**, §10).
- Env de prod: `KYC_SESSION_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (setear en
  Vercel antes de habilitar Didit en prod — fuera del scope de código de esta HU, pero prerequisito
  operacional documentado).

## 9. Plan de Implementación (Waves) + Test Plan

### Wave 0 (Serial Gate — scaffolding puro, sin tocar rutas)

- **W0.1** `package.json` — agregar `@upstash/ratelimit` + `@upstash/redis`.
- **W0.2** `src/infrastructure/kyc-auth.ts` — `issueSessionToken` / `verifySessionToken` (HMAC +
  timing-safe, CD-9). Exemplar: `system.ts`.
- **W0.3** `src/infrastructure/rate-limit.ts` — `checkKycRateLimit` + IP source + fail-mode (§4.3.2).
- **W0.4** `src/infrastructure/didit/decision.ts` — `maskIdentity` + `maskDecision` (CD-8).
- **W0.5** `src/application/ports.ts` — extender tipos (§4.3.4).
- **W0.6** `.env.example` — env vars nuevas (§4.4).
- Verificación W0: `npm run typecheck` + tests unitarios de W0.

### Wave 1 (Parallelizable — depende de W0)

- **W1.1** `app/api/kyc/decision/route.ts` — guards (501→500→token verify→mask). Depende W0.2/W0.4.
- **W1.2** `app/api/kyc/session/route.ts` — guards (501→500→RL→callback→issue token). Depende W0.2/W0.3.

### Wave 2 (Integración — depende de W1)

- **W2.1** `src/infrastructure/didit/kyc-gateway.ts` — leer `authToken`, enviar `x-kyc-token` +
  `senderAddress`. Depende W0.5, W1.1, W1.2.
- **W2.2** `src/application/use-cases/start-kyc.ts` — persistir `sessionToken`, pasar `senderAddress`.
- **W2.3** `src/application/use-cases/resume-kyc.ts` — reenviar `p.sessionToken`.
- **W2.4** extender `kyc-gateway.test.ts` (token viaja start→decision).

### Wave 3 (Final)

- **W3.1** `npm run qa` (typecheck + todos los tests). Readiness (§11).

### Test Plan (≥1 por AC)

| Test | Archivo | Cubre | Wave |
|------|---------|-------|------|
| token válido → 200 + decision | `app/api/kyc/decision/route.test.ts` | AC-1 | W1 |
| sin `x-kyc-token` → 401, `fetch` NO llamado | `decision/route.test.ts` | AC-2, AC-7 | W1 |
| token errado → 401 genérico, `fetch` NO llamado, mismo body que "sin token" | `decision/route.test.ts` | AC-2, CD-5, AC-7 | W1 |
| respuesta enmascara `documentNumber` (`****6677`) y conserva `firstName`/`dateOfBirth` | `decision/route.test.ts` + `decision.test.ts` (`maskIdentity`) | AC-3 | W0/W1 |
| masking edge: len≤4 → `****`; vacío → `""` | `decision.test.ts` | AC-3, CD-8 | W0 |
| sin `DIDIT_API_KEY` → 501 (ambas rutas), sin exigir token | `decision/route.test.ts`, `session/route.test.ts` | AC-4 | W1 |
| 501 → `start` delega en fallback (existente sigue verde) | `kyc-gateway.test.ts` | AC-4, AC-10 | W2 |
| `POST /session`: rate-limit consultado antes de `fetch` | `session/route.test.ts` | AC-5 | W1 |
| limiter `success:false` → 429, `fetch` NO llamado | `session/route.test.ts` + `rate-limit.test.ts` | AC-6, AC-7 | W0/W1 |
| Upstash ausente + Didit configurado → 503 fail-closed | `rate-limit.test.ts` | AC-6 (fail-mode) | W0 |
| Upstash error transitorio → fail-open + warn | `rate-limit.test.ts` | §4.3.2 | W0 |
| `callback` del body ignorado; a Didit va el server-side | `session/route.test.ts` | AC-8 | W1 |
| `body.callback="http://evil"` NUNCA en el payload a Didit | `session/route.test.ts` | AC-9 | W1 |
| modo simulación end-to-end sin token/Upstash (501 path) | `kyc-gateway.test.ts` | AC-10 | W2 |
| `issue`/`verify` HMAC determinístico + timing-safe + mismatch de longitud sin throw | `kyc-auth.test.ts` | AC-1/AC-2, CD-9 | W0 |
| token viaja start()→pending→decision() (integración) | `kyc-gateway.test.ts` | AC-1 | W2 |

## 10. Uncertainty Markers — RESUELTOS

| Marker (work-item) | Resolución (decisión del humano) | Bloqueante? |
|--------------------|----------------------------------|-------------|
| DT-1 binding sesión↔caller | **Token HMAC stateless** (`HMAC(KYC_SESSION_SECRET, sessionId)`), header `x-kyc-token`, verificación timing-safe. **NO SIWE** (fricción UX). §4.3.1 | No (resuelto) |
| DT-2 infra rate-limit | **Upstash Redis** (`@upstash/ratelimit` + `@upstash/redis`), sliding window IP+address, reject antes de Didit, fail-closed en prod si no configurado. §4.3.2 | No (resuelto) |
| Valores rate-limit | IP 10/10min, address 3/10min (env-overridable). §4.3.2 | No (resuelto) |
| kyc-gateway.ts en scope | **SÍ** — es infra-adapter, no presentación; imprescindible para el transporte del token. Confirmado por el humano. §6 IN | No (resuelto) |
| Masking (punto 4 de la tarea) | `documentNumber` últimos-4 en la respuesta HTTP; nombres/DOB intactos bajo auth check; PII cruda nunca sale de la ruta. §4.3.3 | No (resuelto) |

> **No quedan `[NEEDS CLARIFICATION]` pendientes.** El SDD está listo para SPEC_APPROVED.

## 11. Readiness Check

```
READINESS CHECK:
[x] Cada AC (1-10) tiene ≥1 archivo asociado en tabla 4.1 y ≥1 test en §9
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read (paths reales, archivo:línea citado)
[x] No hay [NEEDS CLARIFICATION] pendientes (§10 todos resueltos)
[x] Constraint Directives: 4 nuevas (CD-A..D) + 5 heredadas + 6 específicas (CD-6..11) — >3 PROHIBIDO
[x] Context Map: 14 archivos leídos con hallazgos archivo:línea
[x] Scope IN/OUT explícitos y no ambiguos (§6)
[x] BD: N/A confirmado (chaski-v2 sin DB; Upstash solo contadores, sin PII)
[x] Happy Path completo (§4.5, orden exacto de guards en ambas rutas)
[x] Flujo de error definido (§4.6, 7 casos)
[x] Fail-mode de rate-limit documentado (§4.3.2)
[x] No-regresión de simulación documentada (501 primero; sim sin Upstash/token)
[x] Compat legacy documentada (fail-closed, §4.3.1)
```

Todos los checks pasan. **SDD listo para GATE 2 (SPEC_APPROVED).**

---

*SDD generado por NexusAgil — FULL — nexus-architect F2*
