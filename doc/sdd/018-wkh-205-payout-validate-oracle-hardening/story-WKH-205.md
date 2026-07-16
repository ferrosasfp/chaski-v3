# Story File — [WKH-205] Cierre de deuda: oráculo KYC de `/validate`, body-null, rate-limit `/validate`+`/challenge`, higiene MNR-5/6

> **Fase**: F3 (contrato para el Dev) · **NNN**: `018` · **Branch**: `feat/018-wkh-205-payout-validate-oracle-hardening`
> **Gate previo**: SPEC_APPROVED ✓ · **Fuente**: `sdd.md` (DT-1..6, CD-1..14, contratos §4, waves §5, tests §7).
> **Este archivo es autocontenido.** No necesitás reabrir el SDD para codear. Si algo acá contradice al SDD, **el SDD manda** y marcá `[SDD-GAP]`.

---

## 1. Contexto mínimo (qué construís y por qué)

Cerrás 4+1 ítems de deuda técnica, todos quirúrgicos, **cero cambios de dominio**:

1. **Oráculo KYC** (el más serio): `app/api/payout/validate/route.ts` hoy ecoa el `reason` verbatim
   (`kyc_not_approved` vs `kyc_ownership_mismatch` vs `invalid_verification_id`) a un caller no
   autenticado → filtra el estado KYC de terceros. Lo colapsás a **1 código no-revelador
   `kyc_not_authorized` con status 200 fijo** (mismo criterio no-oracle que `submit/route.ts:96-114`).
2. **Body-null → 500**: `validate` arrastra el bug que WKH-202 ya cerró en `submit`. Parseás a
   `unknown` + `isRecord` (nunca `as {...}`).
3. **Rate-limit `/validate`** (financial-DoS: cada POST re-consulta Didit, que Chaski paga) y
   **`/challenge`** (CPU-DoS de HMAC, residual R2 de WKH-206).
4. **Higiene MNR-5/MNR-6**: `isRecord` que no excluye arrays (3 copias inline) + tipado del `it.each`
   de `submit/route.test.ts`.

**Hecho clave que hace esto seguro (F0)**: `humanError()` (`flow-vm.ts:47`) YA colapsa TODO código con
`"kyc"` al mismo mensaje de UI. El cliente legítimo (`payout-authority-gateway.ts`) hace `res.json()`
sin ramificar por `res.status`. Por eso colapsar reason + cambiar 400→200 es **invisible** al cliente
real (AC-7).

---

## 2. Scope IN — archivos exactos a tocar (7 código/test + 1 doc)

| # | Archivo | Wave | Tipo de cambio |
|---|---|---|---|
| 1 | `src/infrastructure/rate-limit.ts` | W0 | Generalizar (aditivo, no rompe `checkKycRateLimit`) |
| 2 | `src/infrastructure/rate-limit.test.ts` | W0 | 7 existentes VERDES sin tocar asserts + nuevos de la API genérica |
| 3 | `.env.example` | W0 | Bloque nuevo `PAYOUT_VALIDATE_RL_*` + `PAYOUT_CHALLENGE_RL_*` |
| 4 | `app/api/payout/validate/route.ts` | W1 | Reescribir cuerpo (isRecord + colapso + rate-limit) |
| 5 | `app/api/payout/validate/route.test.ts` | W1 | **4** tests reescritos + nuevos (AC-3/AC-4/AC-6) |
| 6 | `src/presentation/flow-vm.test.ts` | W1 | +1 assert AC-7 |
| 7 | `app/api/a2a/payout/challenge/route.ts` | W2 | rate-limit IP-only + isRecord array-exclusion |
| 8 | `app/api/a2a/payout/challenge/route.test.ts` | W2 | tests nuevos de rate-limit |
| 9 | `app/api/a2a/payout/submit/route.ts` | W3 | **SOLO L39-41** (1 línea, `&& !Array.isArray(v)`) |
| 10 | `app/api/a2a/payout/submit/route.test.ts` | W3 | **SOLO L214-227** (tipar `it.each` a `[string, unknown]`) |

## Scope OUT — PROHIBIDO tocar (BLOQUEANTE en AR si aparece en el diff)

- `src/infrastructure/payout/authority.ts` (CD-3, compartido con `submit`).
- Cualquier línea de `submit/route.ts` **fuera de L39-41** (CD-6, guard-order intocable).
- `src/presentation/flow-vm.ts`, `app/api/kyc/session/route.ts`, `confirm-and-send.ts` (CD-11 — solo se
  edita `flow-vm.test.ts`, NO `flow-vm.ts`).
- Encender cualquier flag (`NEXT_PUBLIC_*`, `PAYOUT_POP_SECRET`, `SETTLE_ATTESTATION_SECRET`).
- SIWE / binding real de `address` (deferred, residual R1).

---

## 3. Anti-Hallucination Checklist (verificado por el Architect, NO re-inventar)

- [x] `src/infrastructure/rate-limit.ts` existe. Firma actual: `checkKycRateLimit({ip, address?})`, memo
      `let cached: Limiters|null`, `__resetKycRateLimitClient()`, `type Duration`, helpers `num()`/`win()`/`WINDOW_RE`.
- [x] `clientIp(req)` existe **inline en `app/api/kyc/session/route.ts:19-31`** (NO en rate-limit.ts todavía).
      Lo **extraés** a `rate-limit.ts` (export) byte-idéntico. La copia de `kyc/session` **NO se toca** (dup documentada).
- [x] `humanError()` — `flow-vm.ts:47` `if (code.includes("kyc")) return "No pudimos verificar tu identidad."`.
      `kyc_not_authorized` y `kyc_rate_limited` contienen "kyc" → caen ahí. `kyc_pending_unavailable` se
      intercepta ANTES (L41) pero ninguno de tus códigos nuevos coincide con ese patrón.
- [x] `payout-authority-gateway.ts` hace `res.json()` sin ramificar por status → 400→200 invisible al cliente.
- [x] `submit/route.ts:39-41` = `isRecord` SIN `!Array.isArray(v)` (target del fix 1-línea, verificado).
- [x] `challenge/route.ts:18-20` = `isRecord` SIN `!Array.isArray(v)`; guard-order: `!POP_SECRET`→501 (L24-27)
      ANTES del body-parse (L31-32). El rate-limit va **entre** L27 y L29.
- [x] Paths de import: `validate/route.ts` sube 4 niveles (`../../../../src/...`); `challenge/route.ts` sube
      5 (`../../../../../src/...`). Confirmado contra los imports existentes.

### ⚠️ 2 TRAMPAS del work-item — NO caigas (verificadas ejecutando grep)

- **TRAMPA A (MNR-6)**: el work-item AC-9 dice "tipar `isValidRecord: boolean` en `submit/route.test.ts:176-180`".
  **`isValidRecord` NO EXISTE en el repo** (`grep -rn isValidRecord` → NONE) y las líneas reales son **L214-227**.
  El target real: el `it.each([...])(... , async (_label, payload) => ...)` de `submit/route.test.ts:214-227`
  tiene params inferidos. **Tipás el array del `it.each` a `[string, unknown][]`** (label + payload) para que
  tsc no infiera `any`/tipo estrecho. Fix de tipos, sin cambio runtime. Verificás con `npm run qa` (tsc).
- **TRAMPA B (conteo 2 vs 4)**: work-item CD-1 dice "**2** tests" (`route.test.ts:83,108`). El SDD (DT-1/AC-1)
  colapsa **3** reasons subject (incluye `invalid_verification_id`), que tocan **4** tests reales:
  **L50-58, L60-67, L78-84, L103-109**. **Seguí AC-1/DT-1 (el spec): 4 tests reescritos, no 2.** No propagues
  el conteo del work-item. **Contá tests EJECUTANDO** (`grep -cE "^\s*(it|it\.each)\("` o el output de vitest),
  nunca a ojo (CD-14).

---

## 4. Constraint Directives — reglas verificables (grep/checks concretos)

| CD | Regla | Cómo se verifica |
|---|---|---|
| **CD-1** | Contrato de `/validate` SÍ cambia; los tests de reason subject SE reescriben. | `grep -n "kyc_not_approved\|kyc_ownership_mismatch\|invalid_verification_id" app/api/payout/validate/route.test.ts` → NINGUNO debe seguir siendo el **body esperado** de un test con status. Todos colapsan a `kyc_not_authorized`/200. |
| **CD-2** | `authorized:true` sale SIN clave `reason` (rest-spread, no objeto literal). | La rama final `return NextResponse.json(rest, {status: httpStatus})` intacta. `grep` que la rama true NO construye `{authorized:true, reason: ...}`. Test `toEqual({authorized:true})` verde. |
| **CD-3** | PROHIBIDO tocar `authority.ts`. | `git diff --name-only` NO incluye `src/infrastructure/payout/authority.ts`. |
| **CD-4** | fail-closed en toda rama nueva de rate-limit. | Cada consumo: `if (rl.unavailable) return 503`. Nunca autorizar/emitir por default ante Upstash ausente en entorno vivo. |
| **CD-5** | Todo `isRecord` nuevo/tocado excluye arrays. | `grep -n "typeof v === \"object\"" app/api/payout/validate/route.ts app/api/a2a/payout/challenge/route.ts app/api/a2a/payout/submit/route.ts` → las 3 líneas deben incluir `&& !Array.isArray(v)`. |
| **CD-6** | `submit/route.ts` diff = SOLO L39-41. | `git diff app/api/a2a/payout/submit/route.ts` → único hunk en la función `isRecord`. Cualquier otro hunk = BLOQUEANTE. |
| **CD-7** | Reason colapsado contiene `"kyc"` → `kyc_not_authorized`. PROHIBIDO `payout_not_authorized`. | `grep -n "payout_not_authorized" app/api/payout/validate/route.ts` → 0 matches. El código colapsado literal es `"kyc_not_authorized"`. |
| **CD-8** | Los 3 reasons subject → status **200 fijo** (no propagar `httpStatus`). Técnicos (502/503) preservan status. | El `return` del case colapsado usa `{ status: 200 }` literal, NO `httpStatus`. |
| **CD-9** | Rate-limit corre SOLO en entorno vivo. validate: dentro de `if (process.env.DIDIT_API_KEY)`. challenge: DESPUÉS del `501` de `POP_SECRET`. | En dev/sim el rate-limit ni se evalúa; el demo local sigue andando. |
| **CD-10** | `checkKycRateLimit` firma + comportamiento byte-idéntico. Sus 7 tests verdes SIN tocar asserts. | `git diff src/infrastructure/rate-limit.test.ts` → los 7 `it` existentes NO cambian sus `expect`. Solo se AGREGAN tests. |
| **CD-11** | PROHIBIDO tocar `flow-vm.ts`/`authority.ts`/`kyc/session/route.ts`/`confirm-and-send.ts`. `clientIp` se extrae a `rate-limit.ts`; la copia de kyc/session queda. | `git diff --name-only` NO incluye esos 4. Sí incluye `flow-vm.test.ts` (solo el test). |
| **CD-12** | Parsear `req.json()` a `unknown` + `isRecord`. PROHIBIDO `as {...}`. | `grep -n "as {" app/api/payout/validate/route.ts` → 0. El parseo es `const parsed: unknown = await req.json().catch(() => null)`. |
| **CD-13** | Ninguna I/O nueva fuera de un path que maneje su error. | `checkRouteRateLimit` maneja fail-open/closed internamente → no escapa throw crudo. Verificar que no hay `await` de red fuera de esa función. |
| **CD-14** | Todo conteo de tests se verifica con grep/vitest, NUNCA a ojo. | Antes de cerrar W1/W2: `grep -cE "^\s*(it|it\.each)\("` en cada test file + output de `npm run qa`. |

---

## 5. Waves

> **Orden serial obligatorio**: W0 bloquea W1/W2 (exporta la API). W1/W2/W3 son independientes entre sí
> pero corré en orden para simplicidad. Gate de cada wave: `npm run qa` (tsc completo + vitest) VERDE.

---

### W0 — `rate-limit.ts` generalizado (serial, bloquea W1/W2)

**Archivos**: `src/infrastructure/rate-limit.ts`, `src/infrastructure/rate-limit.test.ts`, `.env.example`.

**Contrato de la API generalizada** (§4.2 del SDD):

```ts
export interface RateLimitInput { ip: string; address?: string; }
export interface RateLimitResult { ok: boolean; retryAfter?: number; unavailable?: boolean; }

export interface RouteRateLimitConfig {
  bucketPrefix: string;                 // "kyc:rl" | "payout:validate:rl" | "payout:challenge:rl"
  ip: { envMax: string; defMax: number; envWindow: string; defWindow: Duration };
  addr?: { envMax: string; defMax: number; envWindow: string; defWindow: Duration }; // opcional
}

export const KYC_RL: RouteRateLimitConfig = { /* KYC_RL_IP_*/ADDR_*, defaults 5/"10 m", 3/"10 m", prefix "kyc:rl" */ };
export const PAYOUT_VALIDATE_RL: RouteRateLimitConfig = { /* PAYOUT_VALIDATE_RL_*, 5/"10 m" + 3/"10 m", prefix "payout:validate:rl" */ };
export const PAYOUT_CHALLENGE_RL: RouteRateLimitConfig = { /* PAYOUT_CHALLENGE_RL_IP_*, 10/"10 m", SIN addr, prefix "payout:challenge:rl" */ };

export function clientIp(req: Request): string { /* extraído de kyc/session:19-31, byte-idéntico */ }
export async function checkRouteRateLimit(cfg: RouteRateLimitConfig, input: RateLimitInput): Promise<RateLimitResult>;
export async function checkKycRateLimit(input: RateLimitInput): Promise<RateLimitResult>; // = checkRouteRateLimit(KYC_RL, input)
export function __resetKycRateLimitClient(): void; // cache.clear() — NOMBRE EXACTO preservado (el test lo importa)
```

**Reglas de implementación**:
- Memo: `let cached: Limiters|null` → `const cache = new Map<string, Limiters>()` keyed por `cfg.bucketPrefix`
  (aísla buckets kyc/validate/challenge). `__resetKycRateLimitClient()` → `cache.clear()`.
- `getLimiters(cfg)` lee env por-config, construye `ip` (siempre) + `address` (solo si `cfg.addr`).
  Prefijos: `${cfg.bucketPrefix}:ip` / `${cfg.bucketPrefix}:addr`.
- Sin Upstash → NO cachea, devuelve `{ok:false, unavailable:true}` (fail-closed, CD-4).
- Throw transitorio dentro del `try` → fail-open + `console.warn` → `{ok:true}` (comportamiento heredado).
- `cfg.addr` ausente → se salta el bucket address (challenge IP-only).
- `checkKycRateLimit(input)` = wrapper de 1 línea: `return checkRouteRateLimit(KYC_RL, input)`.
- Reutilizá `num()`/`win()`/`WINDOW_RE`/`type Duration`/`retryAfterFrom` tal cual.
- **Defaults exactos (DT-4)**: KYC IP 5/"10 m" addr 3/"10 m" | VALIDATE IP 5/"10 m" addr 3/"10 m" |
  CHALLENGE IP 10/"10 m" (sin addr).
- **Env vars nuevas**: `PAYOUT_VALIDATE_RL_IP_MAX`/`_IP_WINDOW`/`_ADDR_MAX`/`_ADDR_WINDOW` y
  `PAYOUT_CHALLENGE_RL_IP_MAX`/`_IP_WINDOW`. Documentalas en `.env.example` (junto al bloque `KYC_RL_*` existente).

**Tests W0** (§7 del SDD, tabla "W0 helper"):
- Los **7** `it` existentes de `checkKycRateLimit` quedan VERDES sin tocar asserts (CD-10). Si el
  `beforeEach` usa `__resetKycRateLimitClient()`, sigue funcionando (ahora hace `cache.clear()`).
- Nuevos para `checkRouteRateLimit`: fail-closed unavailable (sin Upstash), dentro/fuera de límite,
  fail-open transitorio, **aislamiento de buckets** (dos `bucketPrefix` distintos NO comparten contador),
  config IP-only (sin `addr`) salta el bucket address.

**Gate W0**: `npm run qa` VERDE. `grep -cE "^\s*(it|it\.each)\(" src/infrastructure/rate-limit.test.ts` ≥ 7 (7 + nuevos).

**DoD W0**: API genérica exportada + configs + `clientIp` exportado; `checkKycRateLimit` byte-idéntico;
7 tests viejos verdes; `.env.example` actualizado.

---

### W1 — `validate/route.ts` (isRecord + colapso + rate-limit)

**Archivos**: `app/api/payout/validate/route.ts`, `app/api/payout/validate/route.test.ts`, `src/presentation/flow-vm.test.ts`.

**Cuerpo nuevo COMPLETO de `validate/route.ts`** (§4.1 del SDD — este es el contrato, no lo reinventes):

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

  // AC-4/DT-5/CD-9: rate-limit ANTES de la autoridad, SOLO con key (prod-like). Sin key → dev/sim,
  // no hay costo Didit que limitar y el demo local sigue andando (mismo criterio que kyc/session).
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

> **Nota**: `kyc_rate_limited` contiene "kyc" → cae en `humanError` L47 (consistente). No es oráculo: el
> 429 es señal de volumen, no de estado KYC ajeno.

**Tests `validate/route.test.ts` — los 4 REESCRITOS** (TRAMPA B; contá ejecutando):

| Línea actual | Test actual (viejo contrato) | Nuevo esperado |
|---|---|---|
| L50-58 | `verificationId '' (con key)` → 400 `invalid_verification_id` | → **200** `{authorized:false, reason:"kyc_not_authorized"}` |
| L60-67 | `verificationId ausente (con key)` → 400 `invalid_verification_id` | → **200** `{authorized:false, reason:"kyc_not_authorized"}` |
| L78-84 | `Didit Declined` → 200 `kyc_not_approved` | → 200 `{authorized:false, reason:"kyc_not_authorized"}` |
| L103-109 | `ownership mismatch` → 200 `kyc_ownership_mismatch` | → 200 `{authorized:false, reason:"kyc_not_authorized"}` |

- **AC-1 indistinguibilidad**: agregá un assert de que los 3 caminos (Declined / ownership mismatch /
  verificationId inválido) producen **body + status byte-idénticos**.
- **Tests que NO cambian** (PRESERVADOS byte-idénticos): L27-36 (503 técnico), L38-47 (simulated_dev true),
  L70-76 (Approved true), L86-92 (502 `kyc_reauth_failed`), L94-100 (timeout 502), L111-117/L119-125
  (ownership true), L128-146 (PII). El bloque `HttpPayoutAuthorityGateway` (L149-170) NO cambia.
  - **AC-2**: en los tests técnicos (L86-92 502, L27-36 503) agregá assert explícito de que NO colapsan
    (siguen con su reason técnico y su status original).

**Tests NUEVOS en `validate/route.test.ts`**:
- **AC-3**: `it.each([["null",null],["array",[]],["number",123],["string","str"]])` con `DIDIT_API_KEY` set
  → status 4xx (nunca 500) + `fetch`/`resolvePayoutAuthority` NOT called. Patrón exacto de
  `submit/route.test.ts:214-227` (y tipá el array a `[string, unknown][]`, mismo criterio que TRAMPA A).
  Nota: con body no-record, `verificationId`/`address` quedan `""` → cae en `invalid_verification_id` →
  colapsa a `kyc_not_authorized` 200 SIN llamar a Didit (guard de formato en `resolvePayoutAuthority`).
  Verificá el status real ejecutando; el contrato es "nunca 500", el status concreto lo fija la autoridad.
- **AC-4**: rate-limit `!ok` (mockeá `checkRouteRateLimit` o el `@upstash/*` para devolver no-ok) +
  `DIDIT_API_KEY` set → **429** y `resolvePayoutAuthority`/fetch Didit NOT called.
- **AC-6**: Upstash ausente + `DIDIT_API_KEY` set → **503** fail-closed (`kyc_authority_unavailable`).

**+1 assert AC-7 en `flow-vm.test.ts`** (alrededor de L133, junto al `humanError("kyc_rejected")`):
```ts
expect(humanError("kyc_not_authorized")).toBe("No pudimos verificar tu identidad.");
// == humanError("kyc_not_approved") → cliente observable byte-idéntico
```

**Gate W1**: `npm run qa` VERDE. `grep -cE "^\s*(it|it\.each)\(" app/api/payout/validate/route.test.ts` →
baseline 15 + los nuevos (AC-3/AC-4/AC-6). **Verificá que los 4 reescritos ya no contienen los reasons viejos**:
`grep -n "kyc_not_approved\|kyc_ownership_mismatch\|invalid_verification_id" app/api/payout/validate/route.test.ts`.

**DoD W1**: oráculo colapsado (3 reasons subject → `kyc_not_authorized`/200), técnicos preservados,
body-null → 4xx, rate-limit fail-closed, AC-7 verde.

---

### W2 — `challenge/route.ts` (rate-limit IP-only + isRecord)

**Archivos**: `app/api/a2a/payout/challenge/route.ts`, `app/api/a2a/payout/challenge/route.test.ts`.

**Cambio 1 — isRecord L18-20** (CD-5/MNR-5):
```ts
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v); // + `&& !Array.isArray(v)`
}
```

**Cambio 2 — inserción del rate-limit** (§4.3 del SDD). Va **tras** el `if (!POP_SECRET) return 501`
(L24-27) y **ANTES** de parsear el body (L29-32):
```ts
// AC-5/AC-6/CD-9: rate-limit IP-only, tras el 501 de POP_SECRET y antes de issuePopChallenge.
const rl = await checkRouteRateLimit(PAYOUT_CHALLENGE_RL, { ip: clientIp(req) }); // IP-only (AC-5)
if (rl.unavailable) return NextResponse.json({ error: "pop_rate_limit_unavailable" }, { status: 503 }); // AC-6
if (!rl.ok) {
  return NextResponse.json(
    { error: "pop_rate_limited" },
    { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } },
  );
}
```
**Imports nuevos** (sube 5 niveles): `checkRouteRateLimit, PAYOUT_CHALLENGE_RL, clientIp` desde
`../../../../../src/infrastructure/rate-limit`.

**Tests NUEVOS en `challenge/route.test.ts`** (baseline 4 `it`, ya cubre body no-record → 400 en L63-70):
- **AC-5**: rate-limit `!ok` (mock) + `POP_SECRET` set → **429** y `issuePopChallenge`/HMAC NOT emitido.
- **AC-6**: Upstash ausente + `POP_SECRET` set → **503** fail-closed.
- **AC-8**: el test existente `["array",[]]` → 400 sigue verde (behavior unchanged; solo cambia el comentario/precisión).

**Gate W2**: `npm run qa` VERDE. `grep -cE "^\s*(it|it\.each)\(" .../challenge/route.test.ts` → 4 + nuevos.

**DoD W2**: challenge con rate-limit IP-only fail-closed antes del HMAC + isRecord excluye arrays.

---

### W3 — MNR-5/MNR-6 en `submit` (quirúrgico — coordinar merge con WKH-207)

**Archivos**: `app/api/a2a/payout/submit/route.ts` (SOLO L39-41), `app/api/a2a/payout/submit/route.test.ts` (SOLO L214-227).

**MNR-5 — `submit/route.ts:39-41`** (§4.4, CD-6: **exactamente 1 línea de diff**):
```ts
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v); // MNR-5: solo se agrega `&& !Array.isArray(v)`
}
```
**NO toques nada más de este archivo.** `git diff app/api/a2a/payout/submit/route.ts` debe mostrar un
único hunk en la función `isRecord`. Cualquier otro hunk = BLOQUEANTE en AR (CD-6).

**MNR-6 — `submit/route.test.ts:214-227`** (TRAMPA A). Tipá el array del `it.each` a `[string, unknown][]`:
```ts
it.each<[string, unknown]>([
  ["null", null],
  ["array", []],
  ["number", 123],
  ["string", "str"],
])("body no-record (%s) → 400 payout_invalid_request; NINGÚN fetch (AC-1)", async (_label, payload) => {
  // ...cuerpo intacto...
});
```
Sin cambio runtime; el gate es tsc (`npm run qa`). **NO** existe `isValidRecord` — no lo busques ni lo crees.

**Gate W3**: `npm run qa` VERDE. `git diff app/api/a2a/payout/submit/route.ts` = 1 hunk. Los 41 tests de
`submit/route.test.ts` verdes.

**DoD W3**: `isRecord` de submit excluye arrays (1 línea); `it.each` tipado; sin cambio observable.

---

## 6. Verificación de conteo (CD-14 — OBLIGATORIA antes de cerrar)

Baseline actual (verificado ejecutando): **validate 15, challenge 4, submit 41, rate-limit 7**.
Antes de reportar F3 done:
```bash
for f in app/api/payout/validate/route.test.ts app/api/a2a/payout/challenge/route.test.ts \
         app/api/a2a/payout/submit/route.test.ts src/infrastructure/rate-limit.test.ts; do
  printf "%s: " "$f"; grep -cE "^[[:space:]]*(it|it\.each)\b" "$f"; done
npm run qa   # tsc completo + vitest — NO uses `npm run build` solo (excluye tests)
```
- validate ≥ 15 (los 4 reescritos NO suman; los AC-3/AC-4/AC-6 nuevos sí).
- submit sigue en 41 (MNR-6 no agrega tests). challenge ≥ 4. rate-limit ≥ 7.

---

## 7. Coordinación WKH-207 (NNN 019)

- WKH-207 corre F2 en paralelo y toca `submit/route.ts` de forma ADITIVA (wiring de forward/reconciliación,
  bloque L265-284) + `settle/principal`. **F3 es SERIAL: WKH-205 mergea PRIMERO, WKH-207 después.**
- El toque de WKH-205 a `submit/route.ts` es **1 línea (L39-41)**, lejos del bloque de forward → conflicto
  de merge mínimo (de línea, no de lógica). No hay overlap.

---

## 8. Done Definition (F3 termina cuando)

- [ ] W0→W3 implementadas en los 10 archivos del Scope IN, nada fuera de él (`git diff --name-only`).
- [ ] `npm run qa` VERDE (tsc strict sin `any` + vitest, todos los tests).
- [ ] Los 4 tests de `validate` reescritos; `grep` NO encuentra reasons subject viejos como body esperado (CD-1).
- [ ] `checkKycRateLimit`: 7 tests viejos verdes sin tocar asserts (CD-10).
- [ ] `git diff submit/route.ts` = 1 hunk (L39-41) (CD-6). `authority.ts`/`flow-vm.ts`/`kyc/session`/`confirm-and-send` intocados (CD-3/CD-11).
- [ ] Las 3 copias de `isRecord` (validate/challenge/submit) incluyen `!Array.isArray(v)` (CD-5).
- [ ] Colapso literal `"kyc_not_authorized"` + status `200` fijo; sin `payout_not_authorized` en validate (CD-7/CD-8).
- [ ] Rate-limit fail-closed (503) en validate y challenge cuando Upstash ausente + entorno vivo (CD-4/AC-6).
- [ ] `.env.example` con `PAYOUT_VALIDATE_RL_*` + `PAYOUT_CHALLENGE_RL_*`.
- [ ] Conteo de tests re-verificado ejecutando (CD-14), no a ojo.

**Todos los ACs (AC-1..AC-9) tienen ≥1 test** — mapa en §7 del SDD, replicado por wave arriba.
