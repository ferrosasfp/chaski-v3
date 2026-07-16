# SDD — [WKH-205] Cierre de deuda técnica: oráculo KYC de `/api/payout/validate`, body-null, rate-limit de `/validate` + `/challenge`

> **Fase**: F2 (SDD) · **Modo**: full (QUALITY) · **NNN**: `018` · **Branch**: `feat/018-wkh-205-payout-validate-oracle-hardening`
> **Gate previo**: HU_APPROVED ✓ · **Input**: `work-item.md` (9 ACs EARS, 6 CDs) + `project-context.md` + `_INDEX.md`

---

## 0. Contexto

`/api/payout/validate` es hoy un **oráculo público sin auth** del estado KYC de un tercero: ecoa `reason`
verbatim (`kyc_not_approved` vs `kyc_ownership_mismatch` vs `invalid_verification_id`), exactamente lo
que su ruta hermana `/api/a2a/payout/submit` niega vía CD-12 (no-oracle). Además arrastra el bug body-null
→ 500 (idéntico al BLQ-BAJO-1 que WKH-202 cerró en `submit`, pero live en `validate`) y no tiene rate-limit
(financial-DoS: cada POST re-consulta Didit, que Chaski paga). `/api/a2a/payout/challenge` tampoco tiene
rate-limit (residual R2 de WKH-206, CPU-DoS de HMAC).

Esta HU cierra los 4+1 ítems con foco quirúrgico y **cero cambios en `authority.ts` (compartido con
`submit`) ni en el guard-order de `submit`**. El hallazgo clave de F0 que hace esto seguro: `humanError()`
(`flow-vm.ts:47`) YA colapsa TODO código con `"kyc"` al mismo mensaje de UI → el cliente legítimo no
distingue hoy los `reason` granulares, así que colapsarlos en el wrapper `validate/route.ts` no rompe
ningún comportamiento observable (AC-7).

---

## 1. Context Map (archivos leídos — verificados con Read)

| Archivo:línea | Por qué | Patrón / hecho extraído |
|---|---|---|
| `app/api/payout/validate/route.ts:1-24` | Ruta a endurecer | Wrapper delgado: `req.json().catch(()=>({}))` (bug body-null, L12), rest-spread `{httpStatus, ...rest}` → `NextResponse.json(rest, {status})` (L22-23). Ecoa `reason` verbatim de la autoridad → **oráculo**. |
| `app/api/payout/validate/route.test.ts:1-171` | Tests a reescribir | 15 `it`. Los que assertean reason **subject** granular: L50-58 (`invalid_verification_id` 400), L60-67 (id ausente 400), L78-84 (`kyc_not_approved` 200), L103-109 (`kyc_ownership_mismatch` 200) → **4 tests cambian** (no 2, ver DT-1/§Nota-conteo). Los técnicos (L27-36 503, L86-100 502) y authorized:true (L38-47, L70-76, L111-146) **NO cambian**. |
| `src/infrastructure/payout/authority.ts:22-92` | Módulo compartido (NO tocar, CD-3) | `resolvePayoutAuthority()` devuelve `{authorized, reason?, httpStatus}`. Reasons subject: `kyc_not_approved`(200), `kyc_ownership_mismatch`(200), `invalid_verification_id`(400). Técnicos: `kyc_authority_unavailable`(503), `kyc_reauth_failed`(502). `simulated_dev`(200, authorized:true) + authorized:true sin reason. |
| `app/api/a2a/payout/submit/route.ts:39-41,96-114` | Exemplar del switch no-oracle + `isRecord` a fixear (MNR-5) | Switch L96-114 colapsa `kyc_not_approved`+`kyc_ownership_mismatch` → `{error:"payout_not_authorized"}`(403); `invalid_verification_id` → 400; técnicos preservados. `isRecord` L39-41 NO excluye arrays. **Guard-order intocable salvo L39-41 (CD-6).** |
| `app/api/a2a/payout/submit/route.test.ts:210-227` | Exemplar it.each body-null + target MNR-6 | `it.each([["null",null],["array",[]],["number",123],["string","str"]])("... (%s)", async (_label, payload)=>...)` en L214-227. **`isValidRecord` NO existe en el repo** → la referencia del work-item (L176-180, `isValidRecord`) es **STALE**. Target real MNR-6 = tipar los params del it.each. |
| `app/api/a2a/payout/challenge/route.ts:1-48` | Ruta a endurecer (rate-limit + MNR-5) | Guard-order: `!POP_SECRET`→501 (PRIMERO), `isRecord` L18-20 (sin exclusión arrays), body→400, `issuePopChallenge` (HMAC). Sin rate-limit. |
| `app/api/a2a/payout/challenge/route.test.ts:1-71` | Tests a extender | 4 `it`. Ya cubre body no-record `[null,[],123,"str"]`→400 (L63-70). |
| `src/infrastructure/rate-limit.ts:1-111` | Helper a generalizar (W0) | `checkKycRateLimit({ip,address?})`. Memo `cached: Limiters|null`. `getLimiters()` lee `KYC_RL_*` env, prefix `kyc:rl:*`, defaults 5/"10 m" IP + 3/"10 m" addr. Fail-CLOSED si sin Upstash `{ok:false,unavailable:true}`; fail-OPEN en throw transitorio. Helpers `num()`/`win()` + `WINDOW_RE`. `__resetKycRateLimitClient()`. `type Duration = Parameters<typeof Ratelimit.slidingWindow>[1]`. |
| `src/infrastructure/rate-limit.test.ts:1-97` | Tests a preservar/extender | 7 `it` (fail-closed, dentro/fuera de límite, fail-open, defaults, window malformado). Mockea `@upstash/*` vía `vi.hoisted`. Usa `__resetKycRateLimitClient` en `beforeEach`. |
| `app/api/kyc/session/route.ts:12-56` | Exemplar consumidor de rate-limit + `clientIp()` | `clientIp(req)` (trusted-IP: `x-vercel-forwarded-for`/`x-real-ip`, XFF rightmost). Orden: `!key`→501 ANTES del rate-limit. Rate-limit: `unavailable`→503, `!ok`→429 + `Retry-After`. **Fuera de Scope IN → NO tocar.** |
| `src/infrastructure/payout/payout-authority-gateway.ts:9-25` | Cliente legítimo (AC-7) | Hace `res.json()` en CUALQUIER status, valida `typeof data.authorized==="boolean"`, propaga `{authorized,reason?}`. **NO ramifica por `res.status`** → cambiar 400→200 en el colapso NO afecta al cliente. |
| `src/presentation/flow-vm.ts:37-49` | Traductor de reason → UI (AC-7) | `humanError()`: L47 `code.includes("kyc")` → "No pudimos verificar tu identidad." Cualquier código con "kyc" (excepto `kyc_pending_unavailable`, L41) cae acá. `kyc_not_authorized`.includes("kyc")=true → mismo mensaje que `kyc_not_approved`/`kyc_ownership_mismatch`. `invalid_verification_id` NO tiene "kyc" → hoy cae al default; irrelevante (inalcanzable en el flujo legítimo). |
| `src/presentation/flow-vm.test.ts:115-138` | Test humanError (AC-7) | L133-134: `humanError("kyc_rejected")==="No pudimos verificar tu identidad."` → prueba que cualquier "kyc" mapea ahí. AC-7 se cierra con 1 assert acá. |
| `.env.example:30-44` | Documentar env nuevas | Sección rate-limit KYC existente (`KYC_RL_*`). Agregar bloque `PAYOUT_VALIDATE_RL_*` + `PAYOUT_CHALLENGE_RL_*`. |
| `doc/sdd/015-.../auto-blindaje.md` | Lecciones recurrentes | (1) contar artefactos leyendo ≠ ejecutando (WKH-198/201/202); (2) body-null → 500 (parsear a `unknown`+`isRecord`, nunca `as {...}`); (3) I/O fuera del try. |
| `doc/sdd/017-.../auto-blindaje.md` | Lecciones recurrentes | (4) I/O antes del try del use-case (WKH-168/202/206); (5) `mock.calls[i]` sin tipar → TS2352; (6) `npm run qa` (tsc completo) caza lo que `npm run build` no. |

---

## 2. Decisiones técnicas (DT-N — cerradas)

### DT-1 — Nombre + status del reason colapsado: `kyc_not_authorized`, HTTP **200 fijo**
Los 3 reasons **subject** (`kyc_not_approved`, `kyc_ownership_mismatch`, `invalid_verification_id`) colapsan
a un único `{authorized:false, reason:"kyc_not_authorized"}` con status **200 fijo** (no el `httpStatus`
original de la autoridad).

- **Por qué `kyc_not_authorized` (con "kyc")**: AC-7 exige comportamiento de UI byte-idéntico. `humanError()`
  mapea todo "kyc" → "No pudimos verificar tu identidad." (flow-vm.ts:47). `kyc_not_approved` y
  `kyc_ownership_mismatch` ya caen ahí. Un código SIN "kyc" (p.ej. reusar `payout_not_authorized` de
  `submit`) caería en `code.includes("payout")` (L48) → **mensaje distinto** → rompe AC-7. → **CD-7**.
- **Por qué status 200 FIJO**: AC-1 exige indistinguibilidad total. Si preservara el `httpStatus` original,
  `invalid_verification_id`(400) seguiría distinguible de `kyc_not_approved`(200) → oráculo residual. 200
  es además la convención YA vigente de esta ruta para una decisión KYC negativa (not_approved/ownership
  ya son 200; el 400 de invalid_verification_id era el outlier). El cliente legítimo **no ve el status**
  (gateway hace `res.json()` sin ramificar por `res.status`, verificado `payout-authority-gateway.ts:16-21`)
  → cambiar 400→200 es invisible para él. → **CD-8**.
- **Reasons TÉCNICOS preservados byte-idénticos**: `kyc_authority_unavailable`(503) y `kyc_reauth_failed`(502)
  pasan tal cual (rest-spread + httpStatus original). Son estados operativos (reintentar vs no), no oráculo
  de KYC ajeno (AC-2).
- **authorized:true preservado byte-idéntico**: `{authorized:true}` (sin `reason`) y `{authorized:true,
  reason:"simulated_dev"}` salen por el rest-spread intacto (CD-2). El colapso SOLO toca la rama
  `authorized:false` de reasons subject.

### DT-2 — Colapso INLINE en `validate/route.ts`, sin helper compartido con `submit`
Se **descarta** extraer `mapAuthorityReasonToPublicCode()` compartido. Razones:
- Los mapeos **divergen**: `submit` → `{error:"payout_not_authorized"}`(403) para un endpoint ACTION;
  `validate` → `{authorized:false, reason:"kyc_not_authorized"}`(200) para un endpoint ADVISORY que debe
  preservar el contrato `humanError`. Distinto shape, distinto status, distinto código. Un helper tendría
  que devolver dos cosas diferentes → abstracción falsa.
- Extraer forzaría **tocar el switch de `submit`** (L96-114), que es parte del guard-order intocable
  (CD-6). Blast radius ALTO (7 ACs PASS de WKH-202 dependen de él) por beneficio BAJO.
- **Decisión**: añadir el switch de colapso INLINE solo en `validate/route.ts`. Se acepta la duplicación
  del *conjunto* de reasons subject como **deuda documentada explícita** (comentario cross-ref a
  `submit/route.ts:101-105`). Es la recomendación del analyst y el camino de menor riesgo AR.

### DT-3 — Generalizar `rate-limit.ts` sin romper `checkKycRateLimit`
Refactor aditivo (W0):
- Nueva firma genérica `checkRouteRateLimit(config: RouteRateLimitConfig, input: RateLimitInput)` con la
  MISMA lógica de fail-mode (fail-closed sin Upstash → `{ok:false,unavailable:true}`; fail-open en throw).
- Memo pasa de `cached: Limiters|null` a `const cache = new Map<string, Limiters>()` keyed por
  `config.bucketPrefix` (aísla los buckets kyc/validate/challenge). `__resetKycRateLimitClient()` →
  `cache.clear()` (nombre EXACTO preservado: el test lo importa).
- `config.addr` **opcional**: si ausente (challenge, IP-only) se salta el bucket address.
- `checkKycRateLimit(input)` = wrapper de 1 línea → `checkRouteRateLimit(KYC_RL, input)`. **Firma,
  comportamiento y los 7 tests existentes quedan byte-idénticos** (CD-10).
- `clientIp(req)` se **extrae** a `rate-limit.ts` (export) — co-locado con el limiter que keyea sobre él.
  `validate` y `challenge` lo importan. `kyc/session/route.ts` **NO se toca** (out of scope): su copia
  inline queda como duplicación pre-existente documentada (migrable en HU futura). Net: 2 copias (era 1;
  evita 4). → **CD-11**.

### DT-4 — Umbrales de rate-limit (defaults conservadores, env-override)
| Ruta | Ejes | Default | Env vars | Prefix bucket |
|---|---|---|---|---|
| `/api/payout/validate` | IP + address | IP 5/"10 m", addr 3/"10 m" | `PAYOUT_VALIDATE_RL_IP_MAX`/`_IP_WINDOW`/`_ADDR_MAX`/`_ADDR_WINDOW` | `payout:validate:rl:ip` / `:addr` |
| `/api/a2a/payout/challenge` | IP **solo** (AC-5) | IP 10/"10 m" | `PAYOUT_CHALLENGE_RL_IP_MAX`/`_IP_WINDOW` | `payout:challenge:rl:ip` |

- validate = mismos defaults que KYC (flujo legítimo llama 1× por confirmación; 5 deja margen de reintento
  sin abaratar el costo Didit). challenge más laxo (10) porque el costo es CPU (no $) y no hay costo por
  llamada; igual capea el flood. Ambos override por env.

### DT-5 — Rate-limit corre SOLO en entorno "vivo" (fail-closed correcto, demo local intacto)
- **validate**: el rate-limit se evalúa **solo si `DIDIT_API_KEY` está presente** (prod-like). Sin key
  (dev/sim) la autoridad devuelve `simulated_dev` sin tocar Didit → no hay costo que limitar y el demo
  local debe seguir andando (mismo criterio que `kyc/session`, que corta con 501 ANTES del rate-limit
  cuando no hay key). Va **antes** de `resolvePayoutAuthority` (AC-4: 429 antes de re-consultar Didit).
- **challenge**: el rate-limit va **después** del guard `!POP_SECRET`→501 (mecanismo apagado por default →
  ni se evalúa) y **antes** de `issuePopChallenge` (AC-5). Con `POP_SECRET` presente el mecanismo es un
  opt-in "vivo" → fail-closed correcto.
- Fail-closed (AC-6): Upstash ausente + entorno vivo → `unavailable` → 503. Es el comportamiento genérico
  heredado de `checkKycRateLimit` (getLimiters null → `{unavailable:true}`). → **CD-4**.

### DT-6 — MNR-5 / MNR-6 cerrados en esta HU (no diferidos)
- **MNR-5/AC-8**: `submit/route.ts:39-41` → añadir `&& !Array.isArray(v)` a `isRecord` (**1 línea**, sin
  cambio observable: `isRecord([])` pasa de true→false, pero `[]` ya caía en 400 igual). Mismo fix inline
  en `challenge/route.ts:18-20` y en el `isRecord` NUEVO de `validate` (CD-5). **NO** se extrae a util
  compartido: extraer forzaría cambiar el import de `submit` (>1 línea) → violaría el mandato "1 línea"
  de CD-6 y aumentaría el conflicto de merge con WKH-207. 3 copias inline con exclusión, deuda documentada.
- **MNR-6/AC-9**: la referencia `isValidRecord L176-180` del work-item es **STALE** (`isValidRecord` NO
  existe en el repo, verificado por grep). El target real es tipar los params del `it.each` de
  `submit/route.test.ts:214-227` a `[string, unknown]` (label + payload). Fix de tipos, verificado por
  `npm run qa` (tsc), sin cambio runtime.

---

## 3. Constraint Directives (CD-N)

**Heredadas del work-item (CD-1..CD-6) — vigentes tal cual:**
- **CD-1**: el contrato observable de `/api/payout/validate` **SÍ cambia**. Los tests que assertean reason
  subject granular DEBEN reescribirse. Un CR que los encuentre sin tocar → BLOQUEANTE.
- **CD-2**: preservar shape `{authorized:boolean, reason?:string}` con `reason` AUSENTE en authorized:true
  (rest-spread `validate/route.ts:22`, PROHIBIDO reemplazar por objeto literal en la rama authorized:true).
- **CD-3**: PROHIBIDO tocar `src/infrastructure/payout/authority.ts` (compartido con `submit`).
- **CD-4**: fail-closed OBLIGATORIO en toda rama nueva de rate-limit.
- **CD-5**: todo `isRecord()` nuevo o tocado excluye `Array.isArray`.
- **CD-6**: PROHIBIDO cambiar el guard-order de `submit/route.ts`; único diff permitido = L39-41 (MNR-5).
  Cualquier otro diff en ese archivo → BLOQUEANTE en AR.

**Nuevas (SDD-específicas):**
- **CD-7**: el reason colapsado DEBE contener `"kyc"` (`kyc_not_authorized`). PROHIBIDO `payout_not_authorized`
  u otro sin "kyc" → cambiaría el copy de `humanError()` (rompe AC-7).
- **CD-8**: los 3 reasons subject colapsan a **status 200 fijo** (no propagar el `httpStatus` original) →
  indistinguibles (AC-1). Los técnicos (502/503) preservan su status.
- **CD-9**: rate-limit corre SOLO en entorno vivo (validate: `DIDIT_API_KEY` presente; challenge: tras el
  501 de `POP_SECRET`). En dev/sim NO se evalúa (demo local + patrón kyc/session intactos).
- **CD-10**: `checkKycRateLimit` conserva firma + comportamiento byte-idéntico. Sus 7 tests existentes
  quedan verdes SIN modificar asserts.
- **CD-11**: PROHIBIDO tocar `flow-vm.ts`, `authority.ts`, `kyc/session/route.ts`, `confirm-and-send.ts`.
  `clientIp` se extrae a `rate-limit.ts`; la copia inline de `kyc/session` queda como dup documentada.
- **CD-12** (auto-blindaje WKH-202): parsear `req.json()` a `unknown` + `isRecord` narrow. PROHIBIDO el
  cast `as {...}` sobre el retorno de `req.json()` (apaga tsc justo donde el input es hostil).
- **CD-13** (auto-blindaje WKH-168/202/206): ninguna I/O nueva (el `await checkRouteRateLimit`) fuera de un
  path que maneje su error. `checkRouteRateLimit` maneja sus errores internamente (fail-open/closed) → no
  puede escapar un throw crudo; verificarlo.
- **CD-14** (auto-blindaje recurrente): todo número de artefactos ("N tests") se verifica con
  `grep -c`/output de vitest, NUNCA a ojo. La discrepancia "2 vs 4 tests reescritos" (§Nota-conteo) es
  ejemplo vivo: documentarla, no propagar el conteo del work-item sin re-verificar.

---

## 4. Contratos exactos

### 4.1 `validate/route.ts` — nuevo cuerpo (contrato)
```ts
import { NextResponse } from "next/server";
import { resolvePayoutAuthority } from "../../../../src/infrastructure/payout/authority";
import {
  PAYOUT_VALIDATE_RL,
  checkRouteRateLimit,
  clientIp,
} from "../../../../src/infrastructure/rate-limit";

// CD-5/MNR-5: excluye arrays (nuevo isRecord con exclusión desde el inicio).
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function POST(req: Request): Promise<Response> {
  // CD-12: parsear a `unknown` + narrow (NUNCA `as {...}`). isRecord cubre null/array/no-objeto → {}.
  const parsed: unknown = await req.json().catch(() => null);
  const body: Record<string, unknown> = isRecord(parsed) ? parsed : {};
  const verificationId = typeof body.verificationId === "string" ? body.verificationId : "";
  const address = typeof body.address === "string" ? body.address : "";

  // AC-4/DT-5: rate-limit ANTES de la autoridad, SOLO con key (prod-like). Sin key → dev/sim, no hay
  // costo Didit que limitar y el demo local sigue andando (mismo criterio que kyc/session).
  if (process.env.DIDIT_API_KEY) {
    const rl = await checkRouteRateLimit(PAYOUT_VALIDATE_RL, {
      ip: clientIp(req),
      address: address || undefined,
    });
    if (rl.unavailable) {
      // AC-6 fail-closed: Upstash ausente en entorno vivo → 503 (reason técnico, retryable).
      return NextResponse.json(
        { authorized: false, reason: "kyc_authority_unavailable" },
        { status: 503 },
      );
    }
    if (!rl.ok) {
      return NextResponse.json(
        { authorized: false, reason: "kyc_rate_limited" },
        { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } },
      );
    }
  }

  const { httpStatus, ...rest } = await resolvePayoutAuthority({ verificationId, address });

  // AC-1/AC-2/DT-1: colapso no-oracle SOLO de los reasons subject → 1 código + status 200 fijo,
  // indistinguibles. Técnicos (502/503) y authorized:true pasan por el rest-spread intacto (CD-2).
  // Duplicación deliberada del set de submit/route.ts:101-105 (DT-2, deuda documentada, NO helper).
  if (!rest.authorized) {
    switch (rest.reason) {
      case "kyc_not_approved":
      case "kyc_ownership_mismatch":
      case "invalid_verification_id":
        // CD-7/CD-8: mismo reason (con "kyc" → humanError L47) + mismo 200 → oráculo cerrado.
        return NextResponse.json({ authorized: false, reason: "kyc_not_authorized" }, { status: 200 });
      // técnicos (kyc_authority_unavailable 503, kyc_reauth_failed 502) + cualquier reason nuevo:
      default:
        return NextResponse.json(rest, { status: httpStatus });
    }
  }
  return NextResponse.json(rest, { status: httpStatus }); // authorized:true byte-idéntico (CD-2)
}
```
> **Nota rate_limited reason**: `kyc_rate_limited` contiene "kyc" → `humanError` L47 (consistente con el
> resto de fallos de esta ruta). No es oráculo: el 429 es señal de volumen, no de estado KYC ajeno.

### 4.2 `rate-limit.ts` — API generalizada (contrato)
```ts
export interface RateLimitInput { ip: string; address?: string; }
export interface RateLimitResult { ok: boolean; retryAfter?: number; unavailable?: boolean; }

export interface RouteRateLimitConfig {
  bucketPrefix: string;                 // "kyc:rl" | "payout:validate:rl" | "payout:challenge:rl"
  ip: { envMax: string; defMax: number; envWindow: string; defWindow: Duration };
  addr?: { envMax: string; defMax: number; envWindow: string; defWindow: Duration }; // opcional
}

export const KYC_RL: RouteRateLimitConfig = { /* KYC_RL_IP_*/ADDR_*, defaults 5/"10 m", 3/"10 m" */ };
export const PAYOUT_VALIDATE_RL: RouteRateLimitConfig = { /* PAYOUT_VALIDATE_RL_*, 5/"10 m" + 3/"10 m" */ };
export const PAYOUT_CHALLENGE_RL: RouteRateLimitConfig = { /* PAYOUT_CHALLENGE_RL_IP_*, 10/"10 m", sin addr */ };

export function clientIp(req: Request): string { /* extraído de kyc/session, byte-idéntico */ }
export async function checkRouteRateLimit(cfg: RouteRateLimitConfig, input: RateLimitInput): Promise<RateLimitResult>;
export async function checkKycRateLimit(input: RateLimitInput): Promise<RateLimitResult>; // = wrapper(KYC_RL)
export function __resetKycRateLimitClient(): void; // cache.clear() — nombre EXACTO preservado
```
- Memo `new Map<string, Limiters>()` keyed por `bucketPrefix`; sin Upstash → no cachea, devuelve
  `{ok:false,unavailable:true}`. `num()`/`win()`/`WINDOW_RE`/`Duration` reutilizados tal cual.

### 4.3 `challenge/route.ts` — inserción (contrato)
```ts
// tras `if (!POP_SECRET) return 501;` y ANTES de parsear body / issuePopChallenge:
const rl = await checkRouteRateLimit(PAYOUT_CHALLENGE_RL, { ip: clientIp(req) }); // IP-only (AC-5)
if (rl.unavailable) return NextResponse.json({ error: "pop_rate_limit_unavailable" }, { status: 503 }); // AC-6
if (!rl.ok) {
  return NextResponse.json(
    { error: "pop_rate_limited" },
    { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } },
  );
}
// + isRecord L18-20: añadir `&& !Array.isArray(v)` (CD-5/MNR-5)
```

### 4.4 `submit/route.ts:39-41` — fix MNR-5 (1 línea, CD-6)
```ts
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v); // MNR-5: solo se agrega `&& !Array.isArray(v)`
}
```

---

## 5. Waves de implementación

- **W0 (serial — contratos/tipos)**: `src/infrastructure/rate-limit.ts` — generalizar (`RouteRateLimitConfig`,
  `checkRouteRateLimit`, memo Map, configs `KYC_RL`/`PAYOUT_VALIDATE_RL`/`PAYOUT_CHALLENGE_RL`, export
  `clientIp`, wrapper `checkKycRateLimit`). Actualizar `rate-limit.test.ts` (7 existentes verdes + nuevos
  de la API genérica). Bloquea W1/W2. `.env.example` (bloque nuevo de env vars).
- **W1 (paralelizable)**: `validate/route.ts` — isRecord (AC-3) + colapso reason (AC-1/AC-2/AC-7) +
  rate-limit (AC-4/AC-6). Reescribir `validate/route.test.ts` (4 tests colapsados + AC-3/AC-4/AC-6 nuevos +
  AC-7 preservación). +1 assert en `flow-vm.test.ts` (AC-7: `humanError("kyc_not_authorized")`).
- **W2 (paralelizable)**: `challenge/route.ts` — rate-limit IP-only (AC-5/AC-6) + isRecord array exclusion.
  Extender `challenge/route.test.ts`.
- **W3 (paralelizable — coordinar merge con WKH-207)**: `submit/route.ts:39-41` (MNR-5/AC-8, 1 línea) +
  `submit/route.test.ts:214-227` (MNR-6/AC-9, tipado it.each).

**Coordinación WKH-207 (019)**: WKH-207 corre F2 en paralelo y toca `submit/route.ts` de forma ADITIVA
(wiring post-forward) + `settle/principal`. **F3 será SERIAL: WKH-205 mergea PRIMERO, WKH-207 después.**
El cambio de WKH-205 a `submit` es **quirúrgico (1 línea, L39-41)** para minimizar el conflicto de merge —
lejos del bloque de forward/reconciliación (L265-284) que tocará WKH-207. Sin overlap de lógica.

---

## 6. Exemplars verificados (paths confirmados con Read)

| Patrón | Exemplar (verificado) |
|---|---|
| Switch no-oracle de colapso de reason | `app/api/a2a/payout/submit/route.ts:96-114` |
| Parseo body-null fail-safe (`unknown`+`isRecord`) | `app/api/a2a/payout/submit/route.ts:72-73` · `challenge/route.ts:31-32` |
| Consumo de rate-limit (unavailable→503, !ok→429+Retry-After) | `app/api/kyc/session/route.ts:47-56` |
| `clientIp()` trusted-IP | `app/api/kyc/session/route.ts:19-31` |
| Fail-closed del limiter | `src/infrastructure/rate-limit.ts:85-106` |
| it.each body-no-record | `app/api/a2a/payout/submit/route.test.ts:214-227` |
| Mock @upstash en tests de rate-limit | `src/infrastructure/rate-limit.test.ts:5-27` |
| Test humanError (AC-7) | `src/presentation/flow-vm.test.ts:133-134` |

---

## 7. Plan de tests (≥1 por AC)

| AC | Archivo | Test |
|---|---|---|
| **AC-1** | `validate/route.test.ts` | Declined → `{authorized:false, reason:"kyc_not_authorized"}` 200 (REESCRITO de L78-84). Ownership mismatch → mismo body+status (REESCRITO de L103-109). `verificationId:""` → mismo body+status 200 (REESCRITO de L50-58, era 400/invalid_verification_id). + assert de **indistinguibilidad**: los 3 producen body+status byte-idénticos. |
| **AC-2** | `validate/route.test.ts` | `!res.ok` → 502 `kyc_reauth_failed` (PRESERVADO, L86-92 sin cambios). prod+sin-key → 503 `kyc_authority_unavailable` (PRESERVADO, L27-36). Assert explícito: NO colapsados. |
| **AC-3** | `validate/route.test.ts` | `it.each([null,[],123,"str"])` → 4xx (nunca 500), fetch NOT called (NUEVO, patrón submit L214-227). |
| **AC-4** | `validate/route.test.ts` | rate-limit `!ok` (mock) + `DIDIT_API_KEY` set → 429 y `resolvePayoutAuthority`/fetch Didit NOT called (NUEVO). |
| **AC-5** | `challenge/route.test.ts` | rate-limit `!ok` (mock) + `POP_SECRET` set → 429 y `issuePopChallenge`/HMAC NOT emitido (NUEVO). |
| **AC-6** | `validate/route.test.ts` + `challenge/route.test.ts` | Upstash ausente + entorno vivo → 503 fail-closed (ambas rutas, NUEVO). |
| **AC-7** | `validate/route.test.ts` + `flow-vm.test.ts` | authorized:true → `{authorized:true}` SIN key `reason` (PRESERVADO). simulated_dev preservado. + `flow-vm.test.ts`: `humanError("kyc_not_authorized") === "No pudimos verificar tu identidad."` (== `humanError("kyc_not_approved")`) → cliente observable intacto. |
| **AC-8** | `submit/route.test.ts` + `challenge/route.test.ts` | `[]` → 400 sigue verde (comportamiento intacto; el cambio es `!Array.isArray` + comentario preciso). No requiere test nuevo runtime (behavior unchanged); cubierto por it.each existente `["array",[]]`. |
| **AC-9** | `submit/route.test.ts` | it.each tipado `[string, unknown]`; gate = `npm run qa` (tsc). Sin assert runtime. |
| **W0 helper** | `rate-limit.test.ts` | 7 existentes de `checkKycRateLimit` VERDES sin tocar asserts (CD-10). + `checkRouteRateLimit`: fail-closed unavailable, dentro/fuera de límite, fail-open transitorio, **aislamiento de buckets** (dos prefixes no comparten contador), config IP-only salta bucket address. |

**Verificación de conteo (CD-14)**: antes de F3/F4, re-contar tests con `grep -cE "^\s*(it|it\.each)\("`
y el output de vitest. Baseline actual: validate 15, challenge 4, submit 41, rate-limit 7.

### Nota-conteo (CD-1 vs AC-1 — desviación del work-item, documentada)
El work-item CD-1 dice "**2** tests" reescritos (`route.test.ts:83,108`). Pero AC-1 + DT-1 colapsan **3**
reasons (incluye `invalid_verification_id`), que en el archivo real tocan **4** tests: L50-58, L60-67,
L78-84, L103-109. **Se sigue AC-1/DT-1 (spec explícito): 4 tests reescritos, no 2.** Los tests técnicos
(L27-36, L86-100) y authorized:true (L38-47, L70-76, L111-146) NO cambian. Es exactamente el patrón de
error "contar leyendo ≠ ejecutando" de los auto-blindajes WKH-198/201/202 → documentado, no propagado.

---

## 8. Readiness Check

- [x] Work-item leído completo (9 ACs, 6 CDs, Scope IN/OUT, DT-N).
- [x] `project-context.md` — stack Next.js/TS strict, sin `any`, JSON-RPC/REST, sin hardcodes. Consistente.
- [x] Todos los exemplars verificados con Read (paths reales, §6).
- [x] `rate-limit.ts` + `checkKycRateLimit` existen; firma confirmada (§1). Generalización no rompe la firma (DT-3/CD-10).
- [x] `humanError()` colapsa "kyc" → L47 confirmado (`flow-vm.ts:47` + test L133-134). AC-7 cerrable con 1 assert.
- [x] `payout-authority-gateway.ts` NO ramifica por status → cambio 400→200 invisible al cliente (verificado L16-21).
- [x] Anti-alucinación: `isValidRecord` NO existe → MNR-6 stale, target real = it.each `(_label,payload)` L214-227. **Resuelto/documentado** (DT-6).
- [x] Desviación CD-1 vs AC-1 (2 vs 4 tests) resuelta a favor del spec y documentada (§Nota-conteo).
- [x] Scope OUT respetado: `authority.ts` (CD-3), guard-order `submit` (CD-6), `flow-vm.ts`/`kyc/session`/`confirm-and-send` (CD-11), ningún flag encendido.
- [x] Coordinación WKH-207: cambio a `submit` = 1 línea; F3 serial (205 antes que 207) explícito (§5).
- [x] Fail-closed en toda rama de rate-limit (CD-4/AC-6).
- [x] Sin `[NEEDS CLARIFICATION]` abiertos — los 4 del work-item resueltos en F2 (DT-1 nombre+status, DT-2 no-helper, DT-4 umbrales, DT-6 no-extraer isRecord).

**Estado: READY (verde) para SPEC_APPROVED.**
