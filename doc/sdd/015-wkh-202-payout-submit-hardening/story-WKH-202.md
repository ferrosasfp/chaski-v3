# Story File — #015: [WKH-202] Hardening del enforcement de `/api/a2a/payout/submit`

> SDD: `doc/sdd/015-wkh-202-payout-submit-hardening/sdd.md` (SPEC_APPROVED 2026-07-15)
> Fecha: 2026-07-15
> Branch: `feat/015-wkh-202-payout-submit-hardening`
> SDD_MODE: full · hardening de seguridad money-path (gate Fase A)

---

## Goal

`app/api/a2a/payout/submit/route.ts` es hoy un **proxy POST público sin ninguna autorización**: forwardea
`amountUsd`/`beneficiary`/`kycVerificationId` verbatim al agente `remit-cashout-payout`. Sólo es inofensivo
porque `REMIT_AGENTS_BASE_URL` no está seteada (guard 501 fail-closed). El día que la Fase A setee esa env
var, cualquiera en internet dispara un desembolso.

Esta HU construye el enforcement server-side: la route **re-valida contra Didit** (KYC `Approved` + ownership
del `address`) **antes** de forwardear, reusando —vía extracción a un módulo compartido— la misma lógica que
ya es autoridad en `app/api/payout/validate/route.ts` (WKH-180).

**Sin auth nueva, sin secretos nuevos, sin env vars nuevas, sin persistencia server-side nueva.**

> **Lo que esta HU NO cierra** (riesgo residual, va al done-report): `kycPayoutAllowed` sigue siendo un
> booleano del caller (**WKH-203**, otro repo) y nadie verifica que el sender pagó el principal en USDC
> (**WKH-168**). Cerrar WKH-202 **NO** habilita por sí solo la Fase A. No intentes arreglarlos acá.

## Acceptance Criteria (EARS)

> Copiados del SDD aprobado. QA los verifica en F4.

1. **AC-1**: IF `POST /api/a2a/payout/submit` recibe un request sin evidencia server-side verificable de
   autorización (KYC `Approved` + pertenece al caller), THEN el sistema SHALL responder 4xx y SHALL NOT
   invocar `fetch` hacia `REMIT_AGENTS_BASE_URL`.
2. **AC-2**: WHEN el enforcement re-valida y el resultado es `authorized:false` (cualquier `reason`:
   `kyc_not_approved`/`kyc_reauth_failed`/`kyc_ownership_mismatch`/…), el sistema SHALL responder **sin
   forwardear** el submit al agente.
3. **AC-3**: WHILE `REMIT_AGENTS_BASE_URL` no está seteada, el sistema SHALL seguir respondiendo 501
   `a2a_not_configured` — intacto, **independiente del resultado del guard nuevo**.
4. **AC-4**: WHEN el request está autorizado Y `REMIT_AGENTS_BASE_URL` configurada, el sistema SHALL
   forwardear al agente preservando el comportamiento existente (nunca loguea `beneficiary`/PII, nunca ecoa
   `BASE`, `idempotencyKey` intacto).
5. **AC-5**: IF la re-validación falla por causa técnica (timeout/DNS/parse del fetch a Didit, o falta una env
   var requerida por el guard), THEN el sistema SHALL **fail-closed** (rechazar; NUNCA autorizar por default).
6. **AC-6**: el sistema SHALL preservar en verde los **7 tests existentes** de `submit/route.test.ts` **sin
   modificar su comportamiento esperado**.
7. **AC-7**: IF el request pasa la autorización pero el shape de la respuesta del agente es inválido, THEN
   SHALL seguir respondiendo 502 `a2a_bad_shape` exactamente como hoy.

### Resoluciones vinculantes del gate SPEC_APPROVED (no re-litigar)

- **AC-6 / fixture `validPayload`**: agregar `address` al fixture compartido (`route.test.ts:14-21`) y el
  `beforeEach` de env **son setup, no asserts**. Los 7 tests conservan **asserts y comportamiento esperado
  byte-idénticos** → AC-6 se cumple en su lectura literal ("sin modificar sus asserts"). La alternativa
  (hacer `address` opcional) es **fail-open** —el atacante lo omite y se saltea ownership— y está
  **prohibida por CD-4**. Decisión cerrada en el gate: **no la reabras**.
- **DT-5 (rechazar `simulated_dev` en Vercel)**: **APROBADO, va adentro** (W1.1 paso 5, AC-5). Es un
  fail-open real (preview + `REMIT_AGENTS_BASE_URL` seteada + sin `DIDIT_API_KEY` → payout autorizado por
  simulación). **NO lo cortes.** 3 líneas, sin env vars nuevas.

## Files to Modify/Create

> **10 archivos.** 1 nuevo, 9 modificaciones. Cualquier archivo fuera de esta tabla → **PARAR y escalar**
> (CD-8).

| # | Archivo | Acción | Qué hacer | Wave |
|---|---------|--------|-----------|------|
| 1 | `src/infrastructure/payout/authority.ts` | **CREAR** | `resolvePayoutAuthority()` + `PayoutAuthorityDecision` — **move mecánico** de `validate/route.ts:16-102` | W0.1 |
| 2 | `app/api/payout/validate/route.ts` | Modificar | Pasa a wrapper delgado. **Comportamiento byte-idéntico** (CD-10) | W0.2 |
| 3 | `src/application/ports.ts` | Modificar | `PayoutSubmit.address: string` (requerido) | W0.3 |
| 4 | `src/application/use-cases/confirm-and-send.ts` | Modificar | `address: address ?? ""` en el objeto del `payouts.submit()` | W0.4 |
| 5 | `src/infrastructure/a2a/gateways.ts` | Modificar | `address: req.address` en el body + comentario-puntero a WKH-203 | W0.5 |
| 6 | `src/infrastructure/a2a/gateways.test.ts` | Modificar | **L20**: `address` en el literal tipado (**breaker de tsc**) + 1 assert | W0.6 |
| 7 | `app/api/a2a/payout/submit/route.ts` | Modificar | **El guard de autorización** (corazón de la HU) | W1.1 |
| 8 | `app/api/a2a/payout/submit/route.test.ts` | Modificar | `beforeEach`/`afterEach` de env + `address` en fixture + **6 tests nuevos**. Los 7 asserts existentes **NO se tocan** | W1.2 |
| 9 | `src/application/use-cases/confirm-and-send.test.ts` | Modificar | +1 test (`submit` recibe `address`) | W2.1 |
| 10 | `.env.example` | Modificar | Nota de acoplamiento `REMIT_AGENTS_BASE_URL` ↔ `DIDIT_API_KEY` | W2.2 |

**NO se tocan (verificado en F2 por grep exhaustivo)**: `src/test-support/test-container.ts`,
`src/test-support/fakes.ts`, `src/infrastructure/fallback/gateways.ts`,
`src/infrastructure/payout/payout-authority-gateway.ts`, `src/domain/remittance.ts`, `src/presentation/**`,
`app/api/a2a/quote/route.ts`.

> **`test-container.ts`: verificado NO afectado — NO lo toques "por las dudas".** El precedente WKH-201 era
> un cambio de **constructor**; éste es un campo de **interfaz**, y `test-container.ts` no construye ningún
> literal `PayoutSubmit` ni cambia la firma de `ConfirmAndSend`. Idem `fakes.ts:216`
> (`submit(_req: PayoutSubmit)` = consumidor, ignora el arg → agregar un campo no lo rompe).

## Blast radius de `PayoutSubmit.address` (§6 del SDD — grep exhaustivo ya hecho)

| Consumidor | ¿Rompe tsc? | Por qué |
|-----------|-------------|---------|
| `src/application/use-cases/confirm-and-send.ts:103` | **SÍ** — construye el literal | En Scope IN (W0.4) |
| **`src/infrastructure/a2a/gateways.test.ts:20`** | **SÍ** — `const payoutReq: PayoutSubmit = {…}` **literal TIPADO** | **En Scope IN (W0.6). Éste es el "test-container.ts" de esta HU: el breaker real.** |
| `src/infrastructure/a2a/gateways.ts:119` | No | `submit(req: PayoutSubmit)` = consumidor |
| `src/infrastructure/fallback/gateways.ts:98` | No | Consumidor |
| `src/test-support/fakes.ts:216` | No | Ignora el arg |
| `src/test-support/test-container.ts` | **No — verificado** | No construye `PayoutSubmit`; firma de `ConfirmAndSend` no cambia |
| `src/presentation/**` | No | No construye `PayoutSubmit` |

> **Al dev**: si aparece un **tsc rojo en un archivo NO listado acá** → **desviación reportable**. No lo
> arregles en silencio: significa que este survey falló. PARAR y escalar.

## Contrato exacto de `resolvePayoutAuthority()` (NO inventar)

**Archivo #1** — `src/infrastructure/payout/authority.ts`:

```ts
// Autoridad de payout server-side, EXTRAÍDA de app/api/payout/validate/route.ts (WKH-180) para que
// /api/payout/validate y /api/a2a/payout/submit compartan UNA sola implementación del guard-order
// (WKH-202/DT-1: dos copias divergirían). Server-only: lee DIDIT_API_KEY y fetchea Didit — PROHIBIDO
// importarlo desde src/presentation/** o cualquier código que llegue al bundle del cliente (CD-17).
import { mapDiditDecision } from "../didit/decision";

const BASE = process.env.DIDIT_BASE_URL ?? "https://verification.didit.me";

export interface PayoutAuthorityDecision {
  authorized: boolean;
  reason?: string;    // AUSENTE cuando authorized:true por Didit real (preserva {authorized:true})
  httpStatus: number; // 200 | 400 | 502 | 503 — el status que /api/payout/validate YA devuelve hoy
}

export async function resolvePayoutAuthority(
  input: { verificationId: string; address: string },
): Promise<PayoutAuthorityDecision>;
```

**Reglas del contrato:**
- Recibe strings **ya normalizados** (el parseo del body y la coerción a `""` **quedan en cada route**).
- `httpStatus` transporta el status que la route ya devolvía **en cada rama**.
- La rama de éxito real devuelve `{ authorized: true, httpStatus: 200 }` — **sin la clave `reason`**.
- `BASE` va a **module scope** (igual que hoy en `validate/route.ts:12`). No lo muevas adentro de la
  función: eso cambiaría cuándo se lee la env var. Ningún test stubea `DIDIT_BASE_URL`; no empieces.

### Tabla de ramas — move mecánico de `validate/route.ts:16-102` (CD-10)

> Orden **exacto**, `reason` **exactos**, status **exactos**. Es un move, no un rediseño.

| # | Condición (idéntica a hoy) | Retorno |
|---|---------------------------|---------|
| 1 | `!apiKey` + `isProd` (`VERCEL_ENV === "production"`) | `{ authorized:false, reason:"kyc_authority_unavailable", httpStatus:503 }` — fetch NO se llama |
| 2 | `!apiKey` + no-prod + `!verificationId.trim()` | `{ authorized:false, reason:"invalid_verification_id", httpStatus:400 }` |
| 3 | `!apiKey` + no-prod + vid ok | `{ authorized:true, reason:"simulated_dev", httpStatus:200 }` |
| 4 | key + `!verificationId.trim()` | `{ authorized:false, reason:"invalid_verification_id", httpStatus:400 }` — fetch NO se llama |
| 5 | key + fetch Didit `!res.ok` | `{ authorized:false, reason:"kyc_reauth_failed", httpStatus:502 }` |
| 6 | key + `mapDiditDecision(...).status !== "Approved"` | `{ authorized:false, reason:"kyc_not_approved", httpStatus:200 }` |
| 7 | key + Approved + `d.vendorData !== "" && d.vendorData.toLowerCase() !== address.toLowerCase()` | `{ authorized:false, reason:"kyc_ownership_mismatch", httpStatus:200 }` |
| 8 | key + Approved + ownership ok (o `vendorData === ""`) | `{ authorized:true, httpStatus:200 }` ← **SIN `reason`** |
| 9 | `catch` del bloque fetch+mapeo+decisión | `{ authorized:false, reason:"kyc_reauth_failed", httpStatus:502 }` |

- El `try/catch` envuelve **fetch + mapeo + decisión** (igual que hoy, `validate/route.ts:58-102`).
- El fetch conserva `{ headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(10_000) }` y la URL
  `` `${BASE}/v3/session/${encodeURIComponent(verificationId)}/decision/` ``.
- **Conservá los comentarios existentes** (MNR-A fail-closed, MNR-B ownership best-effort, CD-A5): documentan
  residuales vigentes. Mudalos con el código.

### Wrapper de `/api/payout/validate` (Archivo #2)

```ts
import { resolvePayoutAuthority } from "../../../../src/infrastructure/payout/authority";
// ...
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { verificationId?: unknown; address?: unknown };
  const verificationId = typeof body.verificationId === "string" ? body.verificationId : "";
  const address = typeof body.address === "string" ? body.address : "";

  const { httpStatus, ...rest } = await resolvePayoutAuthority({ verificationId, address });
  return NextResponse.json(rest, { status: httpStatus });
}
```

- **`{ httpStatus, ...rest }` (rest-spread), NUNCA `NextResponse.json({ authorized, reason })`.** La rama 8
  devuelve hoy `{authorized:true}` **sin la clave `reason`** y `validate/route.test.ts:75` lo assertea con
  `toEqual`. El rest-spread **preserva la ausencia** de la clave; un objeto literal la reintroduciría como
  `reason: undefined` → **`toEqual` rojo**. Éste es el punto exacto donde la extracción se rompe.
- El parseo del body **se queda en la route** → preserva el caso live verificado **body vacío → 400
  `invalid_verification_id`**.
- `mapDiditDecision` y el `const BASE` se van del archivo (ya no se usan). **Borrá esos imports/consts** o
  tsc/lint se quejan.

**Criterio de cierre de la extracción (CD-10, no negociable):** `app/api/payout/validate/route.test.ts` pasa
**100% verde SIN tocar un solo assert**. Si un assert se rompe → la extracción se desvió. **NO ajustes el
test para que pase**: arreglá el módulo.

## Guard-order de `/api/a2a/payout/submit` (Archivo #7)

> Orden **exacto**. Cada paso es fail-closed.

```
1. const BASE = process.env.REMIT_AGENTS_BASE_URL
   if (!BASE) → 501 { error: "a2a_not_configured" }        ← PRIMERO, INTACTO (AC-3, CD-11)
2. const body = await req.json().catch(() => ({}))          ← igual que hoy
3. Formato: kycVerificationId: string no-vacío (.trim())
            address:           string no-vacío (.trim())
   else → 400 { error: "payout_invalid_request" }           ← AC-1 (NINGÚN fetch, ni Didit ni agente)
4. const d = await resolvePayoutAuthority({
       verificationId: <kycVerificationId del body>,
       address:        <address del body>,
   })
5. if (d.reason === "simulated_dev" && (process.env.VERCEL_ENV ?? "") !== "")
       → 503 { error: "payout_authority_unavailable" }      ← DT-5, AC-5
6. if (!d.authorized) → switch(d.reason) → 400/403/502/503  ← AC-2/AC-5
7. FORWARD al agente  ← bloque actual L34-50 SIN TOCAR      ← AC-4/AC-7 (CD-5/CD-9/CD-10)
```

### Por qué el `!BASE → 501` va PRIMERO (CD-11, no es cosmético)

- **AC-3** lo exige explícito ("independiente del resultado del guard nuevo").
- El test existente `"sin REMIT_AGENTS_BASE_URL → 501 …, fetch NOT called"` assertea
  `expect(fetchMock).not.toHaveBeenCalled()`. Si la autoridad corriera primero **con** key, haría un fetch a
  Didit → **AC-6 violado**.
- Semánticamente: sin backend configurado no hay nada que autorizar, y no se gasta una llamada a Didit para
  responder 501.

### Paso 5 vs paso 6 — ojo con el orden

`simulated_dev` viene con **`authorized: true`**. Si no lo cazás en el paso 5, el paso 6 lo deja pasar y
**forwardea**. Por eso el paso 5 va **antes** del check de `!d.authorized`.

> **El paso 6 es exactamente `if (!d.authorized)` — nada más.** NO agregues `|| d.reason === "simulated_dev"`:
> fuera de Vercel (`VERCEL_ENV` vacío = local/CI) la simulación **debe** autorizar, o el demo local con
> adapter a2a se rompe y **los 7 tests existentes se caen (AC-6)**. Ver "Corrección al SDD" abajo.

### Switch de mapeo (§4.5 + CD-12 + CD-13)

```ts
switch (d.reason) {
  case "invalid_verification_id":
    return NextResponse.json({ error: "payout_invalid_request" }, { status: 400 });
  case "kyc_not_approved":
  case "kyc_ownership_mismatch":
    // CD-12 (no-oracle): MISMO código para ambos. Un caller no autenticado NO debe poder usar este
    // endpoint como oráculo del estado KYC de un verificationId ajeno.
    return NextResponse.json({ error: "payout_not_authorized" }, { status: 403 });
  case "kyc_authority_unavailable":
    return NextResponse.json({ error: "payout_authority_unavailable" }, { status: 503 });
  default:
    // CD-13 fail-closed: kyc_reauth_failed, reason ausente, o un reason NUEVO/desconocido → RECHAZA.
    // Un reason que no conocemos JAMÁS cae en el forward (lección WKH-198: el NaN fail-open).
    return NextResponse.json({ error: "payout_authority_unavailable" }, { status: 502 });
}
```

- `invalid_verification_id` es **inalcanzable** desde la autoridad (el paso 3 ya validó no-vacío). Se mapea
  igual, **defensivamente**. NO lo borres "porque no se alcanza".
- **La respuesta lleva SÓLO `{ error: <code> }`.** PROHIBIDO ecoar `d.reason` (CD-12). El código nuevo sólo
  emite enums — nunca `beneficiary`/PII (CD-5).

### Tabla completa de códigos HTTP

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

### El import (CD-7) — ⚠️ corrección al SDD, leer

```ts
import { resolvePayoutAuthority } from "../../../../../src/infrastructure/payout/authority";
```

**CINCO niveles (`../../../../../`), no cuatro.** `app/api/a2a/payout/submit/route.ts` está un nivel más
profundo que `app/api/a2a/quote/route.ts` (que sí usa 4). Verificado con `os.path.relpath`. El SDD §5/W1.1 y
CD-7 escriben 4 niveles — **es un typo del SDD, ya reportado**; usá 5.

**PROHIBIDO `@/`** (CD-7, lección WKH-198): no hay `vitest.config.*` ni `vite-tsconfig-paths` en este repo →
el alias pasa `typecheck` + `next build` pero **revienta vitest**. Ruta relativa, siempre.

## Exemplars

### Exemplar 1: Guard-order Didit + fail-closed (fuente del move mecánico)
**Archivo**: `app/api/payout/validate/route.ts:14-103` · **Usar para**: Archivos #1, #2
Es **el código que se muda**. Leelo entero antes de escribir `authority.ts`. Cada `return NextResponse.json(x,
{status: n})` se vuelve `return { ...x, httpStatus: n }`. Nada más cambia.

### Exemplar 2: Tests de route con env + fetch stubs (sin module-mocks)
**Archivo**: `app/api/payout/validate/route.test.ts:16-58` · **Usar para**: Archivo #8
- Helper `diditOk(raw)` (L16-21): `vi.fn(async (_url, _init) => ({ ok: true, json: async () => raw }))`.
- Patrón: `vi.stubEnv(...)` + `vi.stubGlobal("fetch", fetchMock)`, **sin `vi.mock`**.
- `function req(payload: unknown): Request` (L8-14) — ya existe en `submit/route.test.ts:6-12`, reusalo.

### Exemplar 3: Capturar el arg de `payouts.submit()` en un test de use-case
**Archivo**: `src/application/use-cases/confirm-and-send.test.ts:187-203` · **Usar para**: Archivo #9
```ts
const payouts = new FakePayoutGateway();
const submitSpy = vi.spyOn(payouts, "submit");
// ... await new ConfirmAndSend(wallet, payouts, repo, new FixedClock(), authority, new FakeRefundGateway())
//           .execute({ remittanceId: id });
expect(submitSpy).toHaveBeenCalledTimes(1);
const arg = submitSpy.mock.calls[0]?.[0];
expect(arg?.address).toBe("0xSender");
```
- `FakeWallet.getAddress()` → `"0xSender"` (`fakes.ts:247-249`). Copiá el molde del test L187-203 (mismo
  `seedQuoted(repo)`, mismo `FakePayoutAuthorityGateway({ authorized: true })`).

### Exemplar 4: El literal tipado que rompe tsc
**Archivo**: `src/infrastructure/a2a/gateways.test.ts:20-27` · **Usar para**: Archivo #6
```ts
const payoutReq: PayoutSubmit = {
  quoteId: "cfx-1",
  amountUsd: 400,
  expectedReceivePen: Money.of(1478.15, "PEN"),
  beneficiary: { name: "Mamá", country: "PE", method: "yape", destination: "999888777" },
  kycVerificationId: "v-1",
  address: "0xSender",        // ← WKH-202/DT-2: agregar. Sin esto tsc rompe apenas ports.ts cambie.
  idempotencyKey: "r-1:cfx-1",
};
```
- Los asserts del body son **por-campo** (L83-87) → agregar `address` **no rompe** ningún assert existente.
- Sumá **1 assert** en el test AC-4 (L74-89), junto a los que ya están:
  `expect(sent.address).toBe("0xSender");`

### Exemplar 5: Body del forward al agente
**Archivo**: `src/infrastructure/a2a/gateways.ts:119-138` · **Usar para**: Archivo #5
```ts
body: JSON.stringify({
  quoteId: req.quoteId,
  amountUsd: req.amountUsd,
  kycVerificationId: req.kycVerificationId,
  address: req.address, // WKH-202: la route lo re-valida server-side (ownership vs vendor_data de Didit)
  // DT-5: sintetizado (la autoridad WKH-180 ya se validó en ConfirmAndSend). WKH-202: el agente NO debe
  // confiar en este booleano del caller; se re-deriva server-side en WKH-203 (repo
  // wasiai-remittance-agents). NO removerlo acá: es contrato cross-repo (CD-14).
  kycPayoutAllowed: true,
  beneficiary: req.beneficiary, // viaja al server; NUNCA se loguea (CD-5)
  idempotencyKey: req.idempotencyKey, // INTACTO (CD-10)
}),
```

### Exemplar 6: Propagación del `address` en el use-case
**Archivo**: `src/application/use-cases/confirm-and-send.ts:64` + `:103-110` · **Usar para**: Archivo #4
- `const address = await this.wallet.getAddress();` **ya existe en L64** (lo usa `authority.authorize()` en
  L65-68). **NO lo dupliques, NO muevas la llamada, NO toques el paso 2** (CD-3).
- En el objeto del `submit()` (L103-110) agregá: `address: address ?? "",` — **misma coerción** que ya usa
  `authority.authorize()` en L67.

## Constraint Directives — 17 (6 heredados + 11 nuevos)

> Checkealos **uno por uno** antes de cerrar la última wave. AR los va a auditar.

### Heredados del work-item

- [ ] **CD-1**: PROHIBIDO tocar `chaski-ai.vercel.app`, `wasiai-agentshop`, el gateway a2a, o código de
      `yarvis`/`agentshop-*` (demo del jurado del grant Team1 corre en paralelo).
- [ ] **CD-2**: PROHIBIDO arrastrar los MENORes de la auditoría adversarial #2 (PII over-transmission en
      `didit/decision.ts:73-83`, TTL AML client-only, over-refund parcial, CAS cross-tab TOCTOU). Se
      documentan, NO se implementan acá.
- [ ] **CD-3**: PROHIBIDO debilitar/saltear/flaggear `confirm_requires_kyc_passed`
      (`remittance.ts:227-234`) ni remover/condicionar `authority.authorize()` de `confirm-and-send.ts`.
      El orden de guards del use-case (CAS → autoridad → expiry → firma → EXPIRY → submit) es **intocable**.
- [ ] **CD-4**: OBLIGATORIO fail-closed en TODOS los guards nuevos. Ante duda/error/timeout → **rechazar**,
      NUNCA autorizar por default.
- [ ] **CD-5**: PROHIBIDO loguear o ecoar `beneficiary`/PII en cualquier código nuevo. Sólo enums.
- [ ] **CD-6**: OBLIGATORIO preservar los **7 tests** de `submit/route.test.ts` en verde; los nuevos se
      **AGREGAN**. PROHIBIDO borrar, renombrar o reescribir los asserts de los 7.

### Nuevos de este SDD

- [ ] **CD-7** *(auto-blindaje WKH-198)*: el import nuevo en `submit/route.ts` va por **ruta RELATIVA** —
      `"../../../../../src/infrastructure/payout/authority"` (**5 niveles**). **PROHIBIDO `@/`**: vitest no
      resuelve el alias en este repo.
- [ ] **CD-8** *(auto-blindaje WKH-201)*: PROHIBIDO cerrar una wave con tsc rojo en un archivo **no listado**
      en "Files to Modify/Create" / "Blast radius". Si aparece → **reportar como desviación**, no arreglarlo
      en silencio.
- [ ] **CD-9** *(MEMORY WKH-196)*: el gate de verificación es **`npm run qa`** (`tsc --noEmit` **+**
      `vitest run`). **PROHIBIDO validar sólo con `npm run build`.**
- [ ] **CD-10**: PROHIBIDO cambiar el comportamiento observable de `/api/payout/validate` (está **live y
      verificado**: body vacío → 400 `invalid_verification_id`). La extracción es un **move mecánico**: sus
      tests pasan **sin tocar un solo assert**. `reason` y status de cada rama **literales**, incluida la
      **ausencia** de la clave `reason` en `{authorized:true}`.
- [ ] **CD-11**: OBLIGATORIO que `if (!BASE) → 501` siga siendo el **PRIMER** guard, antes de cualquier
      llamada a la autoridad.
- [ ] **CD-12** *(no-oracle)*: PROHIBIDO ecoar el `reason` de la autoridad en la respuesta del submit.
      `kyc_not_approved` y `kyc_ownership_mismatch` devuelven el **mismo** `403 payout_not_authorized`.
- [ ] **CD-13** *(anti fail-open, lección WKH-198)*: el `switch` lleva **`default` → 502 fail-closed**.
      PROHIBIDO un `default` que forwardee. **PROHIBIDO `authorized = true` como valor inicial/por-default**
      de cualquier variable del guard.
- [ ] **CD-14** *(cross-repo)*: PROHIBIDO **remover** `kycPayoutAllowed` del body de `gateways.ts:127` — es
      contrato cross-repo, su arreglo es **WKH-203**. Sólo se agrega el comentario-puntero. **PROHIBIDO
      tocar el repo `wasiai-remittance-agents`.**
- [ ] **CD-15**: PROHIBIDO diseñar/implementar cualquier cosa que **dependa** de que `kycPayoutAllowed` sea
      un campo confiable del body.
- [ ] **CD-16**: PROHIBIDO crear persistencia server-side de quotes/remesas (quote-registry Upstash o
      equivalente) y PROHIBIDO agregar **env vars/secretos nuevos**. Decisión del humano 2026-07-15.
- [ ] **CD-17**: `src/infrastructure/payout/authority.ts` es **server-only** (lee `DIDIT_API_KEY`).
      PROHIBIDO importarlo desde `src/presentation/**` o cualquier código que llegue al bundle del cliente.

## Test Expectations

**Baseline: 275/275 verde (verificado 2026-07-15). Objetivo final: 282/282** (275 + 6 en W1 + 1 en W2).

### Helper nuevo en `submit/route.test.ts` — `fetchRouter`

Los tests nuevos necesitan distinguir "fetch a Didit" de "fetch al agente": AC-1/AC-2/AC-5 exigen probar que
**el agente NUNCA fue invocado**, aun cuando Didit sí se llamó. Un `expect(fetchMock).not.toHaveBeenCalled()`
global **no sirve** para esos casos.

```ts
// Despacha por URL y registra las llamadas AL AGENTE por separado, para que
// expect(agentCalls).toHaveLength(0) pruebe literalmente "el agente NUNCA fue invocado" (AC-1/2/5).
function fetchRouter(opts: { didit?: () => unknown; diditThrows?: boolean }) {
  const agentCalls: string[] = [];
  const fn = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("/v3/session/")) {
      if (opts.diditThrows) throw new Error("The operation was aborted due to timeout");
      return { ok: true, json: async () => opts.didit?.() ?? {} };
    }
    agentCalls.push(url);
    return { ok: true, json: async () => ({ result: validResult }) };
  });
  return { fn, agentCalls };
}
```
> Tipá los params explícitamente (`url: string`, `_init?: RequestInit`) — **tsc strict, cero `any`**. Esta es
> exactamente la clase de error que rompió tsc en WKH-196 (mock sin tipar en un test).

### Setup de env (§4.7 — habilitador de AC-6, es SETUP no asserts)

Los 7 tests existentes **no** stubean `DIDIT_API_KEY`/`VERCEL_ENV`. Con el guard nuevo, su resultado pasaría a
depender del **shell ambiente**: no hay `vitest.config.*` (vitest no carga `.env.local`), pero un
`DIDIT_API_KEY` exportado en la shell/CI haría fetchear Didit → **rojo intermitente**.

```ts
beforeEach(() => {
  vi.stubEnv("DIDIT_API_KEY", "");  // → rama simulated_dev, sin fetch a Didit
  vi.stubEnv("VERCEL_ENV", "");     // → no-prod y no-Vercel: la simulación se acepta (DT-5 no dispara)
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();               // restoreAllMocks NO deshace stubEnv
});
```
- Importá `beforeEach` en la línea 1 (hoy: `import { afterEach, describe, expect, it, vi } from "vitest";`).
- El `afterEach(() => vi.restoreAllMocks())` de L32 **se reemplaza** por el de arriba (agrega
  `unstubAllEnvs`). Los tests que quieren key/prod la re-stubean adentro (gana el stub más reciente).
- Con este setup los 7 existentes caen en `simulated_dev` + `VERCEL_ENV=""` → **autorizado** → el único fetch
  que ven sus mocks sigue siendo el del agente → **asserts intactos**.

### Fixture `validPayload` (resolución del gate)

```ts
const validPayload = {
  quoteId: "cfx-1",
  amountUsd: 400,
  kycVerificationId: "v-1",
  address: "0xSender",   // ← WKH-202: el guard lo exige. SETUP del fixture, no un assert (AC-6 intacto).
  kycPayoutAllowed: true,
  beneficiary: { name: "Mamá", country: "PE", method: "yape", destination: "999888777" },
  idempotencyKey: "r-1:cfx-1",
};
```

### Tests nuevos (7)

| # | Wave | Archivo › test | AC | Setup | Espera |
|---|------|----------------|-----|-------|--------|
| 1 | W1.2 | `submit/route.test.ts` › `sin address → 400 payout_invalid_request; NINGÚN fetch` | AC-1 | BASE seteada, `{...validPayload, address: undefined}` | `400`, `{error:"payout_invalid_request"}`, `fetchMock` **not called** (ni Didit ni agente) |
| 2 | W1.2 | › `sin kycVerificationId → 400; NINGÚN fetch` | AC-1 | BASE seteada, sin `kycVerificationId` | idem |
| 3 | W1.2 | › `Didit Declined → 403 payout_not_authorized; agente NO invocado` | AC-2 | `DIDIT_API_KEY="test-key"`, `fetchRouter({didit: () => ({status:"Declined", session_id:"v-1"})})` | `403`, `{error:"payout_not_authorized"}`, `agentCalls` **= 0** |
| 4 | W1.2 | › `ownership mismatch (vendor_data ≠ address) → 403; agente NO invocado` | AC-2 | key + `{status:"Approved", session_id:"v-1", vendor_data:"0xOtherWallet"}`, `address:"0xSender"` | `403` — **mismo code que Declined (no-oracle, CD-12)**, `agentCalls` = 0 |
| 5 | W1.2 | › `fetch a Didit throws (timeout) → 502 payout_authority_unavailable; agente NO invocado` | AC-5 | key + `fetchRouter({diditThrows:true})` | `502`, `{error:"payout_authority_unavailable"}`, `agentCalls` = 0 |
| 6 | W1.2 | › `VERCEL_ENV=preview + sin DIDIT_API_KEY → 503; agente NO invocado` (DT-5) | AC-5 | `DIDIT_API_KEY=""`, `VERCEL_ENV="preview"`, BASE seteada | `503`, `{error:"payout_authority_unavailable"}`, `agentCalls` = 0 |
| 7 | W2.1 | `confirm-and-send.test.ts` › `WKH-202/DT-2: submit recibe address` | DT-2 | `vi.spyOn(payouts,"submit")`, `FakeWallet` → `"0xSender"` | `submitSpy.mock.calls[0]?.[0]?.address === "0xSender"` |

### Tests existentes que deben seguir verdes (NO tocar asserts)

| Test | AC | Nota |
|------|-----|------|
| `submit/route.test.ts` › los **7** de WKH-186 | AC-3/AC-4/AC-6/AC-7 | 7/7 verdes, **asserts byte-idénticos**. El de 501 prueba CD-11 (fetch not called). El happy-path sigue asertando `not.toContain("999888777")` (CD-5) + `idempotencyKey` (CD-10) |
| `validate/route.test.ts` › **completo** | DT-1/CD-10 | **100% verde sin tocar un assert** = prueba de que la extracción no divergió |
| `gateways.test.ts` › `A2aPayoutGateway` | DT-2 | Asserts por-campo → agregar `address` no los rompe; se **suma** 1 assert |

### Criterio Test-First
Guard de seguridad money-path → **sí, test-first** en W1 (o al menos código + test verdes al cerrar la wave).

## Waves

### Wave -1: Environment Gate (verificar ANTES de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v2
npm install 2>/dev/null || echo "revisar package.json"
ls app/api/a2a/payout/submit/route.ts app/api/a2a/payout/submit/route.test.ts \
   app/api/payout/validate/route.ts app/api/payout/validate/route.test.ts \
   src/application/ports.ts src/application/use-cases/confirm-and-send.ts \
   src/application/use-cases/confirm-and-send.test.ts \
   src/infrastructure/a2a/gateways.ts src/infrastructure/a2a/gateways.test.ts \
   src/infrastructure/didit/decision.ts .env.example \
   2>/dev/null || echo "FALTA archivo base — PARAR"
npm run qa 2>&1 | tail -8   # baseline esperado: 275/275 verde + tsc limpio
```
**Si algo falla en Wave -1: PARAR y reportar.** No implementar sobre un entorno roto.

### Wave 0 — Contratos + extracción (SERIAL, **sin cambio de comportamiento**)

> Objetivo: dejar el contrato y el módulo compartido listos **sin tocar aún el guard**. Al cerrar W0 la suite
> sigue en **275/275** (cero tests nuevos, cero comportamiento nuevo).

- [ ] **W0.1** `src/infrastructure/payout/authority.ts` **(nuevo)** — `resolvePayoutAuthority` +
      `PayoutAuthorityDecision`. Move mecánico de `validate/route.ts:16-102` (tabla de 9 ramas arriba).
      Import `mapDiditDecision` desde `"../didit/decision"`. → Archivo #1 / Exemplar 1
- [ ] **W0.2** `app/api/payout/validate/route.ts` — wrapper delgado (`{httpStatus, ...rest}`). Borrar el
      `const BASE` y el import de `mapDiditDecision` (ya no se usan). → Archivo #2
- [ ] **W0.3** `src/application/ports.ts` — `address: string;` en `PayoutSubmit` (L63-70), requerido, con
      comentario (`// WKH-202/DT-2: el server re-valida ownership (vendor_data de Didit) — NO-opcional
      (CD-4): un address opcional sería fail-open.`). → Archivo #3
- [ ] **W0.4** `src/application/use-cases/confirm-and-send.ts` — `address: address ?? "",` en el objeto del
      `payouts.submit()` (L103-110). **NO tocar el paso 2 ni el orden de guards** (CD-3). → Archivo #4 /
      Exemplar 6
- [ ] **W0.5** `src/infrastructure/a2a/gateways.ts` — `address: req.address` en el body (L123-130) +
      comentario-puntero WKH-203 en `kycPayoutAllowed` (CD-14: **no removerlo**). → Archivo #5 / Exemplar 5
- [ ] **W0.6** `src/infrastructure/a2a/gateways.test.ts` — **L20** `address: "0xSender"` en el literal tipado
      (**breaker de tsc**) + 1 assert `expect(sent.address).toBe("0xSender")` en el test AC-4. → Archivo #6 /
      Exemplar 4

**Gate W0 (criterio de cierre verificable):**
```bash
npm run qa    # tsc --noEmit limpio + 275/275 verde
```
- ✅ **275/275** (no 276: W0 no agrega tests).
- ✅ `validate/route.test.ts` verde **sin un solo assert tocado** (CD-10) — si no, la extracción se desvió.
- ✅ tsc limpio **sin** haber tocado ningún archivo fuera de la tabla (CD-8). Si `test-container.ts` o
  `fakes.ts` salen rojos → **PARAR y escalar** (el survey de §6 falló).
- ✅ `git diff` sin cambios de comportamiento observable.

### Wave 1 — El guard (depende de W0) — ∥ con W2

- [ ] **W1.1** `app/api/a2a/payout/submit/route.ts` — guard-order (7 pasos) + `switch` de mapeo
      (`default` → 502). Import **relativo de 5 niveles** (CD-7). **El bloque de forward L34-50 NO se toca.**
      Actualizar el comentario de cabecera (L1-6) mencionando el enforcement WKH-202. → Archivo #7
- [ ] **W1.2** `app/api/a2a/payout/submit/route.test.ts` — `beforeEach`/`afterEach` de env + `address` en
      `validPayload` + helper `fetchRouter` + **6 tests nuevos**. **Los 7 existentes: asserts intactos**
      (AC-6/CD-6). → Archivo #8 / Exemplar 2

**Gate W1:**
```bash
npx vitest run app/api/a2a/payout/submit/route.test.ts   # 13/13 (7 existentes + 6 nuevos)
npm run qa                                               # tsc limpio + 281/281
```
- ✅ Los 7 originales verdes **con sus asserts byte-idénticos** (`git diff` del test: sólo el fixture, el
  setup de env, el helper y los 6 `it()` nuevos).
- ✅ En los 6 nuevos, `agentCalls` = 0 en los 4 que lo aplican (AC-1×2 usan `not.toHaveBeenCalled()` global).

### Wave 2 — Contrato client-side + docs (depende de W0) — ∥ con W1

- [ ] **W2.1** `src/application/use-cases/confirm-and-send.test.ts` — +1 test: `submit` recibe
      `address: "0xSender"` (patrón `vi.spyOn`). → Archivo #9 / Exemplar 3
- [ ] **W2.2** `.env.example` — nota junto a `REMIT_AGENTS_BASE_URL` (L60). **Sin env vars nuevas** (CD-16).
      Contenido a cubrir:
      - Gate WKH-202: la route re-valida KYC/ownership server-side contra Didit antes de forwardear.
      - **`REMIT_AGENTS_BASE_URL` NO debe setearse en ningún scope de Vercel donde `DIDIT_API_KEY` esté
        ausente** (sin key + preview → la autoridad simula; el submit lo rechaza con 503, así que el payout
        NO funciona: setealas **juntas**).
      - Puntero: el gate de Fase A todavía necesita **WKH-203** (`kycPayoutAllowed` server-side en el agente)
        y **WKH-168** (verificación del principal). → Archivo #10

**Gate W2:** `npm run qa` → tsc limpio + `confirm-and-send.test.ts` verde con el test nuevo.

### Wave 3 — Cierre (serial)

- [ ] **W3.1** `npm run qa` completo → **282/282 verde + tsc limpio**.
- [ ] **W3.2** Checklist de los **17 CDs** uno por uno (arriba).
- [ ] **W3.3** Verificar que el `git diff --stat` toca **exactamente los 10 archivos** de la tabla — ni uno
      más (CD-8).
- [ ] **W3.4** Confirmar para el done-report: el riesgo residual (**G2 = WKH-203**, **G3 = WKH-168**, **R1**
      ownership best-effort sin SIWE, **R2** replay del `idempotencyKey`) queda documentado. **Cerrar WKH-202
      NO habilita la Fase A por sí solo.**

### Verificación Incremental

| Wave | Comando | Criterio de cierre |
|------|---------|--------------------|
| W-1 | `npm run qa` | Baseline **275/275** + tsc limpio |
| W0 | `npm run qa` | **275/275** + tsc limpio + `validate/route.test.ts` sin asserts tocados |
| W1 | `npm run qa` | **281/281** + los 7 originales con asserts intactos |
| W2 | `npm run qa` | tsc limpio + test DT-2 verde |
| W3 | `npm run qa` | **282/282** + tsc limpio + 17 CDs + 10 archivos exactos |

> **PROHIBIDO cerrar una wave validando sólo con `npm run build`** (CD-9, lección WKH-196: un CR aprobó con
> tsc roto en tests porque el build los excluía). En **este** repo **no existe `tsconfig.build.json`** — el
> `tsconfig.json` incluye `src/**/*.ts` y `app/**/*.ts`, así que `npm run typecheck` **sí** cubre los
> `*.test.ts`. El gate es **`npm run qa`** = `tsc --noEmit` + `vitest run`.

## Out of Scope

- **Repo `wasiai-remittance-agents`** y el flag `PAYOUT_ALLOW_MOCK` → **WKH-203**. NO tocar (CD-14).
- **Verificar el principal en USDC / atar el submit a un quote real** → **WKH-168**. Un atacante con **su
  propio** KYC `Approved` + **su propia** `address` sigue pudiendo pedir un payout con monto/beneficiario
  arbitrarios: **ningún mecanismo de auth cierra eso**. NO intentes cerrarlo acá.
- **Persistencia server-side de quotes/remesas** (quote-registry Upstash o similar) → prohibido (CD-16).
- **Env vars/secretos nuevos** (`x-payout-token`, `PAYOUT_SESSION_SECRET`) → la opción (b) del DT-4 fue
  **descartada** en F2. No la reintroduzcas.
- **SIWE / prueba criptográfica de posesión de wallet** → deferred (`kyc-auth.ts:7`).
- `app/api/a2a/quote/route.ts` — el guard 501 se mantiene sin cambios.
- MENORes de la auditoría adversarial #2 (CD-2). Cambios en `src/presentation/**` (el path de error ya existe
  y está testeado: 4xx/5xx → `a2a_payout_unavailable` → `failAndRefund` → refund).
- NO "mejorar" código adyacente. NO agregar funcionalidad no listada.

## Corrección al SDD detectada en F2.5 (aplicar la del Story File)

1. **Import de 5 niveles, no 4.** El SDD (§5/W1.1 y CD-7) escribe
   `"../../../../src/infrastructure/payout/authority"` para `submit/route.ts`. Ese path es correcto para
   `validate/route.ts` (4 niveles) pero **`submit/route.ts` está un nivel más profundo → necesita 5**:
   `"../../../../../src/infrastructure/payout/authority"`. Verificado con `os.path.relpath`. **Usá 5.**
2. **Paso 6 del guard-order = `if (!d.authorized)`, nada más.** El §4.4 del SDD lo escribe como
   `if (!d.authorized || d.reason === "simulated_dev"...)`. Leído literalmente eso rechazaría `simulated_dev`
   **siempre**, contradiciendo §4.6 ("fuera de Vercel la simulación se acepta → los 7 tests existentes quedan
   en verde") y la fila AC-4 de §7 ("rama `simulated_dev` (local) → autorizado"). El rechazo de la simulación
   vive **sólo** en el paso 5, gateado por `VERCEL_ENV !== ""`. **Prevalecen §4.6 + AC-6** (normativos y
   test-backed).

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect.** No inventar, no asumir.

Situaciones de escalation:
- Un exemplar (path/línea) ya no coincide con lo descrito.
- **tsc rojo en un archivo fuera de "Files to Modify/Create" / "Blast radius"** (CD-8) — especialmente
  `test-container.ts` o `fakes.ts`: el survey de §6 dice que NO deben romperse.
- Un assert de `validate/route.test.ts` se rompe tras la extracción (CD-10) — la extracción se desvió;
  **PROHIBIDO ajustar el test para que pase**.
- Un assert de los 7 tests de `submit/route.test.ts` se rompe (AC-6/CD-6).
- El cierre de una wave exige tocar un archivo fuera de la tabla.
- Cualquier situación donde la única salida aparente sea **debilitar un guard** o **autorizar por default**
  (CD-4/CD-13) → **PARAR SIEMPRE**. Es el money-path.

---

*Story File generado por NexusAgil — F2.5 (FULL, hardening de seguridad money-path). Baseline verificado
275/275 el 2026-07-15. Objetivo: 282/282.*
