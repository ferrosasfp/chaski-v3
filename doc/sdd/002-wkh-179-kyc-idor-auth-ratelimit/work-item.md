# Work Item — [WKH-179] Cerrar IDOR PII + auth/rate-limit en /api/kyc/*

## Resumen
`app/api/kyc/decision/route.ts` expone identidad completa (DNI, fecha de nacimiento, nombre) de
CUALQUIER sesión KYC de Didit a CUALQUIER caller sin autenticación (IDOR — hallazgo B1, auditoría
adversarial 2026-07-10). `app/api/kyc/session/route.ts` no tiene auth ni rate-limit, por lo que cada
POST dispara una llamada a Didit que Chaski paga (financial-DoS — A2). El `callback` del body se
reenvía tal cual a Didit sin sanitizar (M6). Se cierra el gap de seguridad SOLO en `app/api/kyc/*`
y sus helpers de infraestructura, sin tocar el demo live (`yarvis`) ni la UI de presentación.

## Sizing
- SDD_MODE: full
- Estimación: M
- Branch sugerido: fix/179-kyc-idor-auth-ratelimit

## Contexto verificado (F0 grounding, líneas reales al 2026-07-10)

- `chaski-v2/app/api/kyc/session/route.ts:7-33` — `POST` sin auth ni rate-limit. Body:
  `{ vendorData?, callback? }`. Línea 22: `callback: body.callback` se reenvía TAL CUAL a Didit
  (`${BASE}/v3/session/`).
- `chaski-v2/app/api/kyc/decision/route.ts:8-25` — `GET ?sessionId=<x>` sin auth ni binding al
  caller. Línea 23-24: devuelve `mapDiditDecision(decision)` completo, incluyendo `identity`.
- `chaski-v2/src/infrastructure/didit/decision.ts:33-43` — `identity` incluye `documentNumber`,
  `dateOfBirth`, `firstName`, `lastNamePaternal`, `lastNameMaternal`, `nationality` sin máscara.
- `chaski-v2/src/infrastructure/didit/kyc-gateway.ts:16-44` — adapter cliente (`DiditKycGateway`):
  `start()` hace `POST /api/kyc/session` (línea 17-21, solo manda `callback`, NO manda `vendorData`
  con la address pese a que el tipo lo permite); `decision()` hace `GET /api/kyc/decision?sessionId=`
  (línea 29) sin ningún header de auth.
- **No existe hoy NINGÚN mecanismo de sesión/auth server-side en chaski-v2**: no hay cookies, no hay
  JWT, no hay verificación de firma de wallet (SIWE), no hay KV/Redis. `WalletPort.connect()`
  (`src/application/ports.ts:80-84`) solo devuelve la address client-side; nunca se verifica
  server-side. El único "recuerdo" de identidad es `LocalKycStore`
  (`src/infrastructure/kyc-store.ts`) en `localStorage` del browser — inservible para auth server.
- `package.json` — sin dependencias de Redis/KV ni de rate-limiting (`@upstash/*`, `ioredis`, etc.
  ausentes). App corre en Next 16 sobre Vercel (serverless, instancias efímeras) → contadores
  en memoria NO son confiables entre invocaciones.
- Orden de wallet en el flujo (`src/presentation/flow.tsx:19-28`, step machine): `connect` precede a
  `verify` → la address del sender YA está disponible client-side antes de iniciar el KYC, por lo
  que SÍ se puede propagar como binding (aunque sin prueba criptográfica de posesión salvo que se
  agregue firma SIWE).
- `.env.example` — no existe hoy una var de app base URL (`NEXT_PUBLIC_APP_BASE_URL` o similar) para
  construir el `callback` server-side de forma segura (M6); habrá que introducirla.
- `chaski-v2/doc/sdd/` ya existía al momento de escribir este work item — WKH-178 (analyst en
  paralelo, misma auditoría) tomó el NNN `001`. Esta HU usa `002` para evitar colisión.

## Acceptance Criteria (EARS)

### B1 — IDOR / exposición de PII (BLOQUEANTE)
- **AC-1**: WHEN a client calls `GET /api/kyc/decision?sessionId=<x>`, the system SHALL only return
  the decision payload if the caller presents a valid credential proving it is associated with the
  same session created via the corresponding `POST /api/kyc/session` call (mecanismo exacto: ver
  DT-1, `[NEEDS CLARIFICATION]` en F2).
- **AC-2**: IF the caller cannot present a valid session credential (missing, malformed, or not
  matching `sessionId`), THEN the system SHALL respond `401` (or `403`) WITHOUT calling Didit and
  WITHOUT leaking whether `sessionId` exists.
- **AC-3**: WHEN the system returns a KYC decision to any caller (including the legitimate owner),
  the system SHALL NOT include the raw `documentNumber` in the JSON body — it SHALL be masked (ej.
  solo últimos 4 dígitos) or omitted; `dateOfBirth`/nombres quedan sujetos a la misma auth check de
  AC-1 (no se exponen a callers no autorizados).
- **AC-4**: WHERE Didit is not configured (`DIDIT_API_KEY` ausente), the system SHALL continue to
  respond `501` as hoy, evaluado ANTES o de forma independiente del auth check, para no romper el
  flujo de fallback/simulación local (`DiditKycGateway.start()` solo cae a fallback si
  `status === 501`).

### A2 — Financial-DoS por falta de auth/rate-limit
- **AC-5**: WHEN a client calls `POST /api/kyc/session`, the system SHALL require a caller identity
  (address y/o IP, según DT-1/DT-2) BEFORE invoking the Didit upstream API.
- **AC-6**: WHILE a given caller identity has exceeded the configured rate-limit threshold within
  the configured rolling window `[NEEDS CLARIFICATION: valores exactos — ej. N=3/hora por address,
  M=10/hora por IP — a definir en F2]`, the system SHALL reject additional `POST /api/kyc/session`
  requests with `429` WITHOUT calling Didit upstream.
- **AC-7**: IF a request to either route is rejected by the auth check (AC-2, AC-5) or the
  rate-limit check (AC-6), THEN the system SHALL NOT make any outbound call to Didit's API (protege
  el costo por verificación).

### M6 — Callback no saneado
- **AC-8**: WHEN building the `callback` value sent to Didit in `POST /api/kyc/session`, the system
  SHALL ignore any `callback` field supplied in the request body and SHALL construct it server-side
  from an allow-listed/env-controlled base URL.
- **AC-9**: IF the client-supplied request body contains a `callback` field, THEN the system SHALL
  NOT forward that raw value to Didit under any circumstance (previene SSRF/open-redirect vía el
  hosted flow de Didit).

### Regresión / no-daño
- **AC-10**: WHILE `NEXT_PUBLIC_KYC_MODE` no está en `"didit"` (modo simulación/fallback), the
  system SHALL preserve el flujo de fallback existente sin requerir cambios en la UI/presentación
  para que la demo siga funcionando en local sin key de Didit.

## Scope IN
- `chaski-v2/app/api/kyc/session/route.ts` — agregar auth check + rate-limit + callback allow-list.
- `chaski-v2/app/api/kyc/decision/route.ts` — agregar auth/ownership check + masking de
  `documentNumber`.
- `chaski-v2/src/infrastructure/didit/decision.ts` — mapeo de masking (`mapDiditDecision` o un
  wrapper nuevo).
- Helper(s) nuevos de infraestructura (ubicación a definir en F2, ej.
  `chaski-v2/src/infrastructure/kyc-auth.ts`, `chaski-v2/src/infrastructure/rate-limit.ts`) —
  emisión/verificación de credencial de sesión + rate-limiting.
- `chaski-v2/src/infrastructure/didit/kyc-gateway.ts` — cambio MÍNIMO para propagar la credencial
  emitida en `start()` hacia `decision()` (imprescindible para que AC-1 funcione end-to-end; este
  archivo es adapter de infraestructura, NO gate client-side ni presentación — confirmar
  interpretación en F2, ver Missing Inputs).
- `chaski-v2/src/application/ports.ts` — si el binding requiere un campo nuevo en `KycStartResult`
  / `KycPending` (ej. `sessionToken`), extender la interfaz mínimamente.
- `chaski-v2/.env.example` — documentar nuevas env vars (secret de firma, base URL de callback,
  config de rate-limit).
- Tests: `chaski-v2/src/infrastructure/didit/kyc-gateway.test.ts` (extender) + tests nuevos para las
  rutas y helpers.

## Scope OUT
- Verificación criptográfica real de posesión de wallet (SIWE / firma EIP-4361) — deferred, ver
  DT-1 y `[NEEDS CLARIFICATION]`.
- Introducir Upstash Redis (u otro KV externo) como infraestructura nueva — decisión de Architect,
  ver DT-2.
- `chaski-v2/src/presentation/*` (flow.tsx, ui.tsx) — pantallas del flujo/gate KYC no se tocan.
- Cambios en el workflow de Didit (config en su consola) o en el mapeo de campos identity
  (`first_name`/`last_name_2`, etc. — eso es harness pendiente de sandbox real, no seguridad).
- `app/api/*` fuera de `kyc/*` (quote, payout, etc.) — fuera de alcance de esta HU.
- El demo live (`yarvis` / `wasiai-v2`) — NO SE TOCA bajo ninguna circunstancia (ver CD-1).
- Flujo de payout/settlement — no modificado.
- RLS/DB — chaski-v2 no tiene DB hoy (todo localStorage); esta HU no introduce una.
- Cualquier archivo dentro de `chaski-v2/doc/sdd/001-wkh-178-*` (pertenece a WKH-178, HU hermana en
  paralelo) — no tocar.

## Decisiones técnicas (DT-N)

- **DT-1 (binding sesión↔caller para B1)**: se recomienda un token opaco stateless:
  `token = HMAC-SHA256(KYC_SESSION_SECRET, sessionId)` generado server-side en `POST /session` y
  devuelto una sola vez al caller; requerido como header (ej. `x-kyc-token`) en
  `GET /api/kyc/decision`; el server lo recalcula y compara en tiempo constante. Ventaja: cierra el
  IDOR (un atacante que solo tiene/adivina `sessionId` no puede forjar el token) sin requerir firma
  de wallet (SIWE) ni infraestructura de sesión nueva (Redis/DB) — encaja con la arquitectura actual
  100% stateless/localStorage. Desventaja: NO prueba criptográficamente que el caller es el dueño de
  la wallet — si el token se filtra (logs, XSS, browser history) es replayable. `[NEEDS
  CLARIFICATION — Architect F2]`: ¿esta garantía es suficiente para el hackathon/producción inicial,
  o se exige SIWE real? Impacta esfuerzo (SIWE requiere UX de firma adicional + verificación
  `viem`/`siwe` lib nueva).

- **DT-2 (rate-limit A2)**: contadores en memoria del proceso NO son confiables en Vercel serverless
  (instancias efímeras, múltiples). Recomendado: Upstash Redis (patrón ya usado en el ecosistema
  WasiAI — ver `wasiai-facilitator`), sliding-window por address + IP. `[NEEDS CLARIFICATION —
  Architect F2]`: ¿se introduce Upstash Redis como dependencia nueva en chaski-v2 en esta HU, o se
  acepta un best-effort en memoria (mitigación parcial, con Redis como follow-up trackeado)? Afecta
  el DoR de F2 y si se agrega `@upstash/ratelimit` a `package.json`.

- **DT-3 (callback allow-list M6)**: construir el callback server-side desde una env var nueva (ej.
  `KYC_CALLBACK_BASE_URL` o `NEXT_PUBLIC_APP_BASE_URL` + path fijo `/kyc/callback`); NO existe hoy
  ninguna var de base URL en `.env.example` — se agrega en esta HU. El campo `callback` del body se
  ignora por completo (no se usa ni para validación ni allow-list de paths — se descarta).

- **DT-4 (masking documentNumber)**: aplicar masking en el mapeo (`decision.ts` o wrapper), NO en la
  ruta, para mantenerlo testeable de forma pura (mismo patrón que `mapDiditDecision` ya usa). Formato
  sugerido: últimos 4 caracteres visibles, resto `*` (ej. `****5678`).

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/`. PROHIBIDO tocar el demo live
  (`yarvis`, `wasiai-v2`, cualquier ruta bajo `agentshop-*`). Esta HU es exclusivamente
  `chaski-v2/app/api/kyc/*` + sus helpers de infraestructura directos (ver Scope IN).
- **CD-2**: OBLIGATORIO que toda respuesta de error por auth/rate-limit (401/403/429) se devuelva
  ANTES de invocar `fetch()` hacia Didit — ninguna llamada rechazada debe generar costo upstream
  (AC-7). El Architect debe diseñar el guard como el PRIMER check en cada handler, no al final.
- **CD-3**: PROHIBIDO introducir secrets nuevos hardcodeados — cualquier secret nuevo (ej.
  `KYC_SESSION_SECRET`) va SOLO por env var, documentado en `.env.example` sin valor real, igual que
  `DIDIT_API_KEY` hoy.
- **CD-4**: OBLIGATORIO preservar el comportamiento `501` cuando `DIDIT_API_KEY`/`DIDIT_WORKFLOW_ID`
  no están configurados (AC-4, AC-10) — el fallback/simulación local NO debe romperse; el Architect
  debe especificar el orden exacto de checks (config vs auth vs rate-limit) en el SDD.
- **CD-5**: PROHIBIDO devolver mensajes de error que confirmen o nieguen la existencia de un
  `sessionId` a un caller no autorizado (evita enumeración) — usar el mismo cuerpo/status genérico
  para "no autorizado" y "no existe".

## Missing Inputs

- `[NEEDS CLARIFICATION — bloqueante para F2]` Mecanismo exacto de binding sesión↔caller (DT-1):
  token HMAC stateless vs. SIWE real vs. otra alternativa. Impacta si se toca
  `src/infrastructure/didit/kyc-gateway.ts` (adapter cliente) y si se necesita nueva lib (`siwe`).
- `[NEEDS CLARIFICATION — bloqueante para F2]` Infraestructura de rate-limit (DT-2): Upstash Redis
  nuevo vs. best-effort en memoria vs. otro servicio ya disponible en el ecosistema (Vercel KV,
  Edge Config). Impacta `package.json` y variables de entorno nuevas.
- `[NEEDS CLARIFICATION — no bloqueante, resolver en F2]` Valores exactos de rate-limit (AC-6):
  umbral por address, umbral por IP, ventana temporal.
- `[NEEDS CLARIFICATION — no bloqueante, resolver en F2]` ¿`kyc-gateway.ts` (adapter infra) se
  considera dentro del scope permitido, o el orquestador/humano lo excluye explícitamente al leer
  "NO tocar el gate client-side ni presentación"? Sin tocarlo, AC-1 no puede implementarse
  end-to-end (el cliente necesita reenviar la credencial). Se documenta la interpretación (infra ≠
  presentación) en Scope IN; requiere confirmación del gate humano si se prefiere lo contrario.
- `[resuelto en F0]` No existe mecanismo de auth/sesión previo en chaski-v2 — confirmado por
  grounding, no es ambigüedad, es estado real del código.

## Análisis de paralelismo
- Corre en paralelo con **WKH-178** (mismo repo `chaski-v2`, NNN `001` en
  `doc/sdd/001-wkh-178-demo-safe-fixes/`) — ambas HUs salen de la misma auditoría adversarial
  2026-07-10. WKH-178 toca "recibo S/0.00 + banner modo demo + KYC timeout/reset" — probablemente
  toca `src/presentation/flow.tsx` y quizás el flujo de KYC pending/timeout
  (`kyc-pending-store.ts`), lo cual puede solapar con Wave 3 de esta HU (`kyc-gateway.ts`). Coordinar
  con el Architect/Dev de WKH-178 antes de F3 para decidir orden de merge o si comparten helpers de
  KYC.
- No bloquea otras HUs del backlog conocidas; es puramente de seguridad, aislada a `kyc/*`.
- Dentro de esta HU, B1 (auth binding) es prerequisito de facto para que AC-1/AC-2/AC-3 tengan
  sentido; A2 (rate-limit) y M6 (callback) son independientes entre sí y pueden implementarse en
  paralelo una vez decidido DT-1/DT-2.

## Waves sugeridas (para F3, referencia — el Architect define las definitivas en F2.5)
- **Wave 1**: helpers nuevos (auth token issue/verify, rate-limit) + `.env.example` — sin tocar
  las rutas todavía, testeables de forma aislada (unit tests).
- **Wave 2**: `session/route.ts` (auth + rate-limit + callback allow-list, AC-5 a AC-9) +
  `decision/route.ts` (auth check + masking, AC-1 a AC-4).
- **Wave 3**: `kyc-gateway.ts` (propagar credencial) + `ports.ts` (extender tipos si aplica) +
  tests de integración end-to-end del flujo `start()` → `decision()`.
