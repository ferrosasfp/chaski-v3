# Story File — [WKH-180] Autoridad KYC/payout server-side

> Contrato autocontenido para el Dev (F3). Fuente: `sdd.md` (SPEC_APPROVED) + `work-item.md`.
> Branch: `fix/180-payout-authority-server-side` · SDD_MODE: full · Tipo: improvement (security)
> Repo: **`chaski-v2/`** (SOLO este repo — CD-1)

---

## 0. Contexto compacto (qué se construye y por qué)

Chaski v2 corre **100% client-side**: `getContainer()` es un singleton del browser y el estado del
money-path (incluido el `KycVerification` con `approved`/`payoutAllowed`) vive en `localStorage`
(`chaski.remittances.v1`, `chaski.kyc.v1`), **editable con una línea de devtools**. Hoy el único
guard antes de desembolsar es la invariante de dominio `Remittance.confirm()`
(`src/domain/remittance.ts:161-168`), que corre sobre ese estado atacante-controlable. Un atacante
puede forjar `approved:true` en localStorage y saltarse Didit (hallazgo **A1** de la auditoría
2026-07-10).

Esta HU **mueve la autoridad** de "¿este KYC autoriza el payout?" al servidor:

1. Nueva ruta API Next.js `app/api/payout/validate/route.ts` que **re-consulta la decisión REAL de
   Didit** (`GET /v3/session/{id}/decision/`) con `DIDIT_API_KEY` server-only.
2. El use-case `ConfirmAndSend` la invoca (vía un adapter fail-closed) **antes de mover valor**.
3. El resultado `{ authorized, reason }` es la **única** fuente de verdad para autorizar el payout —
   nunca los booleanos que llegaron del browser.

Reusa el patrón ya auditado y en prod de **WKH-179** (`/api/kyc/*`): guard-order,
`DIDIT_API_KEY` server-only, fail-closed. El `PayoutGateway` **sigue siendo `FallbackPayoutGateway`
(MOCK — Scope OUT / WKH-168)**: esta HU **instala el gate, no mueve plata real**.

**CD-1 (heredado, absoluto):** PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/` — ni el demo
live (agentshop/cobraya/Chaski v1), ni `wasiai-a2a`, ni agentes `remit-*`.

---

## 1. Scope IN — lista exhaustiva de archivos a tocar

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `src/application/ports.ts` | Modificar (aditivo): `PayoutAuthorization` + `PayoutAuthorityGateway` | W0 |
| 2 | `src/infrastructure/didit/decision.ts` | Modificar (aditivo): `vendor_data?` en `DiditRaw` + `vendorData` en `DiditDecisionResult` + mapeo | W0 |
| 3 | `app/api/payout/validate/route.ts` | **Crear**: POST, guard-order, Didit `/decision/`, `{authorized,reason}` | W1 |
| 4 | `src/infrastructure/payout/payout-authority-gateway.ts` | **Crear**: `HttpPayoutAuthorityGateway` fail-closed | W1 |
| 5 | `app/api/payout/validate/route.test.ts` | **Crear**: tests de ruta | W1 |
| 6 | `src/infrastructure/didit/decision.test.ts` | Modificar: +1 caso `vendorData` | W1 |
| 7 | `src/application/use-cases/confirm-and-send.ts` | Modificar: inyectar `authority` + check pre-`authorizePrincipal` | W2 |
| 8 | `src/composition/container.ts` | Modificar: instanciar adapter + pasar a `ConfirmAndSend` | W2 |
| 9 | `src/application/use-cases/confirm-and-send.test.ts` | **Crear (net-new)**: tests de enforcement | W2 |
| 10 | `src/test-support/fakes.ts` | Modificar (aditivo): `FakePayoutAuthorityGateway` para los tests | W2 |
| 11 | `.env.example` | Modificar: comentario prod-detection (`VERCEL_ENV`), sin env var nueva obligatoria | W3 |

**Fuera de Scope IN (NO tocar):** `src/infrastructure/fallback/gateways.ts` (mock intacto),
`app/api/kyc/session/route.ts`, `app/api/kyc/decision/route.ts`, `src/infrastructure/kyc-auth.ts`,
`src/domain/remittance.ts` (el enforcement va en el use-case, NO en el dominio — DT-2/CD-A10).

> Nota: el item 10 (`fakes.ts`) no está listado explícitamente en §4.1 del SDD pero se deriva del
> Test Plan (fake authority) y del estilo del repo (`src/test-support/fakes.ts` centraliza los
> doubles). Es aditivo y necesario para los tests de W2.

---

## 2. Anti-Hallucination Checklist (archivo:línea EXACTO — verificado por el Architect)

**NO inventes paths, firmas ni campos. Estos son los anclajes reales:**

### 2.1 `ConfirmAndSend` — punto de enforcement
- Archivo: `src/application/use-cases/confirm-and-send.ts`
- Ctor actual (L15-20): `constructor(private readonly wallet: WalletPort, private readonly payouts: PayoutGateway, private readonly repo: RemittanceRepository, private readonly clock: Clock)`.
- Flujo actual `execute()` (L22-60):
  - L27 `r.confirm(this.clock.nowIso())` → L28 `await this.repo.save(r)` (paso 1)
  - L29-32 `const s = r.snapshot; const quote = s.quote; const kyc = s.kyc;` + guard `!quote || !kyc`
  - **L35** `const { tx } = await this.wallet.authorizePrincipal(quote)` (paso 2) ← **el check `authorize()` va JUSTO ANTES de esta línea**
  - L42-48 `this.payouts.submit({ ... kycVerificationId: kyc.verificationId ... })` (paso 3)
- `markPayoutFailed` disponible: el use-case ya lo usa en L53 y L56 (`r.markPayoutFailed(reason, this.clock.nowIso())`).

### 2.2 Estado / transición `payout_failed`
- Archivo: `src/domain/remittance.ts`
- `TRANSITIONS` (L59-71): **`confirmed: ["principal_in", "payout_failed"]`** (L65) → se puede fallar
  ANTES de mover el principal (por eso el check va tras `confirm()`, antes de `authorizePrincipal()`).
- `markPayoutFailed(reason: string, now: string)` (L179-181): `this.to("payout_failed", now, { failureReason: reason })`.
- `payout_failed` está en `RemittanceStatus` (L56) y transiciona a `["refunded"]` (L69) — NO es terminal.

### 2.3 `ports.ts` — dónde agregar el port
- Archivo: `src/application/ports.ts`
- Sección Payout existente: `PayoutSubmit` (L63-69), `PayoutRecord` (L70-76), `PayoutGateway` (L77-80).
- **Agregar el nuevo port justo después de `PayoutGateway` (tras L80)**, misma sección/estilo.
- `WalletPort.getAddress()` (L85): `getAddress(): Promise<string | null>` → devuelve `string | null`
  (por eso el use-case pasa `?? ""`).

### 2.4 `app/api/kyc/decision/route.ts` — EXEMPLAR principal de la ruta
- Guard-order real (L12-39): `501 (no key)` → `500 (misconfig KYC_SESSION_SECRET)` → `400 (formato)` → `401 (auth token)` → `fetch` a Didit.
- `BASE` (L10): `const BASE = process.env.DIDIT_BASE_URL ?? "https://verification.didit.me";`
- fetch a Didit (L30-33): `fetch(\`${BASE}/v3/session/${encodeURIComponent(sessionId)}/decision/\`, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(10_000) })`.
- `!res.ok` → `502` (L34-36). Respuesta: `NextResponse.json(...)`.
- `mapDiditDecision` importado de `../../../../src/infrastructure/didit/decision` (L7).

### 2.5 `decision.ts` — `DiditRaw` / `mapDiditDecision` (extender ADITIVAMENTE)
- Archivo: `src/infrastructure/didit/decision.ts`
- `DiditDecisionResult` (L5-14): interface actual (`terminal, verificationId, approved, payoutAllowed, riskLevel, provenance, status, identity`). **Agregar `vendorData: string`**.
- `DiditRaw` (L16-20): `{ status?, session_id?, id_verifications? }`. **Agregar `vendor_data?: string`**.
- helper `s = (v: unknown): string => (typeof v === "string" ? v : "")` (L24) — reusar para el mapeo defensivo.
- `mapDiditDecision` (L29-54): agregar `vendorData: s(raw?.vendor_data)` al objeto de retorno (L44-53).
- `maskDecision` (L68-70) hace `{ ...d, ... }` (spread) → NO rompe con el campo nuevo (aditivo).

### 2.6 `app/api/kyc/session/route.ts` — dónde ya se manda `vendor_data`
- Archivo: `app/api/kyc/session/route.ts`, **L68**: `vendor_data: body.vendorData` (= `senderAddress` del sender, ver `kyc-gateway.ts:22` `vendorData: req.senderAddress`).
- Es lo que Didit puede eco-ar en `/decision/` → base del ownership check (§4).

### 2.7 `kyc-gateway.ts` — EXEMPLAR del adapter cliente
- Archivo: `src/infrastructure/didit/kyc-gateway.ts` (L13-54).
- Patrón: `fetch("/api/kyc/...")` desde el browser, maneja `501 → fallback`, `!ok → throw`, mapea al modelo del port. Para el adapter nuevo: **fail-closed** (catch → `{authorized:false}`), no throw.

### 2.8 `container.ts` — wiring
- Archivo: `src/composition/container.ts`.
- `const payouts = new FallbackPayoutGateway();` (L50) — NO tocar el mock.
- `confirmAndSend: new ConfirmAndSend(wallet, payouts, repo, clock)` (**L60**) — agregar el 5º arg `authority`.
- Instanciar `const payoutAuthority = new HttpPayoutAuthorityGateway();` junto a los demás adapters (tras L50).

### 2.9 Exemplar de test de ruta — `app/api/kyc/decision/route.test.ts`
- `vi.stubEnv("DIDIT_API_KEY", "test-key")` (L21), `vi.stubGlobal("fetch", vi.fn(async () => ({ ok:true, json: async()=>RAW })))` (L27), `expect(fetchMock).not.toHaveBeenCalled()` (L43), `new Request(url, { headers })` (L15-16).

### 2.10 Exemplar de test de use-case — `src/application/use-cases/abandon-pending-kyc.test.ts`
- Estilo: `import { FakeKycPendingStore } from "../../test-support/fakes"` (L2). Fakes de `src/test-support/fakes.ts`: `InMemoryRepo`, `FixedClock`, `FakeWallet` (getAddress → `"0xSender"`), `FakePayoutGateway`, `beneficiary()`. **NO existe `FakePayoutAuthorityGateway` → crearlo (item 10).**

---

## 3. Diseño de la ruta `POST /api/payout/validate` (paso a paso)

**Por qué POST y sin `x-kyc-token`:** a diferencia de `/api/kyc/decision` (devuelve PII → token HMAC
anti-IDOR de WKH-179), esta ruta devuelve **solo `{authorized, reason}` — cero PII**. El vector IDOR
no aplica (CD-A8). POST para no dejar el `verificationId` en logs de query-string. El único residual
("boolean oracle") queda documentado como hardening futuro (rate-limit por IP — fuera de scope).

**Input** (JSON body): `{ verificationId: string; address: string }`.
**Output**: SIEMPRE `NextResponse.json({ authorized: boolean, reason?: string }, { status })`. **Nunca `identity`/`documentNumber`.**

**Guard-order (honra CD-A1; integra AC-3/AC-4/AC-5):**

```
BASE  = process.env.DIDIT_BASE_URL ?? "https://verification.didit.me"
apiKey = process.env.DIDIT_API_KEY
isProd = (process.env.VERCEL_ENV ?? "") === "production"

1. Parsear body: const { verificationId, address } = await req.json().catch(() => ({}))

2. SIN key (!apiKey):
   - isProd  → 503 { authorized:false, reason:"kyc_authority_unavailable" }   ← fail-loud (AC-3, CD-4). fetch NO se llama.
   - !isProd → validar formato (paso 4); si OK → 200 { authorized:true, reason:"simulated_dev" } (AC-4). fetch NO se llama.

3. CON key → seguir.

4. FORMATO (AC-5): !verificationId || String(verificationId).trim() === "" →
     400 { authorized:false, reason:"invalid_verification_id" }. fetch NO se llama.

5. DIDIT:
     const res = await fetch(`${BASE}/v3/session/${encodeURIComponent(verificationId)}/decision/`, {
       headers: { "x-api-key": apiKey },
       signal: AbortSignal.timeout(10_000),
     });
     if (!res.ok) → 502 { authorized:false, reason:"kyc_reauth_failed" } (AC-2)

6. MAPEO: const d = mapDiditDecision(await res.json());
     d.status !== "Approved" → 200 { authorized:false, reason:"kyc_not_approved" } (AC-2/AC-6)

7. OWNERSHIP (best-effort, §4):
     if (d.vendorData !== "" && d.vendorData.toLowerCase() !== String(address ?? "").toLowerCase())
        → 200 { authorized:false, reason:"kyc_ownership_mismatch" }
     if (d.vendorData === "") → skip (residual documentado)

8. OK → 200 { authorized:true }
```

> Nota isProd (DT-3, §4.4 SDD): `VERCEL_ENV` lo inyecta Vercel (`"production"` solo en el deploy de
> prod). Fuera de Vercel (self-host/CI) `VERCEL_ENV` está ausente → `isProd=false` → camino simulado.
> Es intencional: el caso peligroso "prod sin key" solo aparece en Vercel production, donde
> `VERCEL_ENV==="production"` lo detecta. Documentado en `.env.example` (W3). **NO inventar env var
> custom** (CD-A6).

---

## 4. Ownership por `vendor_data` (best-effort — resuelve el NEEDS CLARIFICATION)

- `/api/kyc/session` ya envía `vendor_data = senderAddress` (`session/route.ts:68`). Didit lo eco-a en `/decision/`.
- `decision.ts`: `DiditRaw += vendor_data?: string`; `DiditDecisionResult += vendorData: string`
  (mapeado con `s()` → `""` si ausente, defensivo).
- Route paso 7: compara `d.vendorData` vs `address` del caller (case-insensitive, direcciones EVM).
- **Residual explícito** (si Didit NO devuelve `vendor_data` → `d.vendorData === ""`): se **omite** el
  ownership check, se autoriza solo por `Approved`. Persiste un residual menor (un `verificationId`
  Approved robado podría reusarse desde otra wallet) — **mucho menor** que el bug actual (forjar
  `approved:true` sin tocar Didit, que esta HU cierra por completo). Follow-up no-bloqueante:
  verificar el shape real de `vendor_data` contra el sandbox (mismo caveat de `decision.ts:26-28`).
- **Aditividad garantizada** (CD-A7): `maskDecision` hace spread (`decision.ts:69`), `kyc-gateway.ts`
  mapea campos nominados (`kyc-gateway.ts:42-52`, ignora el extra) → `/api/kyc/decision` NO se rompe.

---

## 5. Port + adapter cliente + wiring

### 5.1 Port (`ports.ts`, tras L80)

```ts
export interface PayoutAuthorization {
  authorized: boolean;
  reason?: string; // "kyc_not_approved" | "kyc_reauth_failed" | "kyc_ownership_mismatch" | "kyc_authority_error" | "kyc_authority_unavailable" | ...
}
export interface PayoutAuthorityGateway {
  // Re-valida server-side que el verificationId autoriza el payout para este caller.
  authorize(input: { verificationId: string; address: string }): Promise<PayoutAuthorization>;
}
```

> CD-A3: `address` es NO-opcional (`string`, no `string | undefined`). El use-case pasa `getAddress() ?? ""`.

### 5.2 Adapter cliente (`src/infrastructure/payout/payout-authority-gateway.ts`, NUEVO — fail-closed)

```ts
import type { PayoutAuthority... } from "../../application/ports";

export class HttpPayoutAuthorityGateway implements PayoutAuthorityGateway {
  async authorize(input: { verificationId: string; address: string }): Promise<PayoutAuthorization> {
    try {
      const res = await fetch("/api/payout/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      // el body SIEMPRE trae { authorized, reason } (incluso en 4xx/5xx) → parsear y devolver.
      const data = (await res.json()) as PayoutAuthorization;
      if (typeof data?.authorized !== "boolean") {
        return { authorized: false, reason: "kyc_authority_error" };
      }
      return data;
    } catch {
      return { authorized: false, reason: "kyc_authority_error" }; // fail-closed (CD-A4)
    }
  }
}
```

> CD-A4: cualquier error de red/parse → `{authorized:false}`. NUNCA lanzar sin catch, NUNCA
> `authorized:true` por default. **Modo simulación dev**: la ruta ya devuelve `{authorized:true,
> reason:"simulated_dev"}` cuando `!isProd && !apiKey` → el adapter lo propaga tal cual → el demo
> local sigue llegando a "Entregado" (regresión OK).

### 5.3 Wiring (`container.ts`)

- Import: `import { HttpPayoutAuthorityGateway } from "../infrastructure/payout/payout-authority-gateway";`
- Tras L50: `const payoutAuthority = new HttpPayoutAuthorityGateway();`
- L60: `confirmAndSend: new ConfirmAndSend(wallet, payouts, repo, clock, payoutAuthority),`

---

## 6. Enforcement en `ConfirmAndSend` (snippet objetivo)

- Ctor: agregar 5º arg `private readonly authority: PayoutAuthorityGateway` (importar el tipo de `../ports`).
- Insertar el check **tras L32** (después del guard `!quote || !kyc`) y **ANTES de L35**
  (`this.wallet.authorizePrincipal`):

```ts
// ... tras: const kyc = s.kyc; if (!quote || !kyc) throw new Error(...);

// 2. Autoridad server-side de payout (WKH-180): el override server-side gana SIEMPRE sobre el
//    estado client-side (kyc.approved podría estar forjado en localStorage — CD-2/AC-6).
const address = await this.wallet.getAddress();
const auth = await this.authority.authorize({
  verificationId: kyc.verificationId,
  address: address ?? "",
});
if (!auth.authorized) {
  r.markPayoutFailed(auth.reason ?? "kyc_reauth_failed", this.clock.nowIso()); // confirmed → payout_failed (transición válida, remittance.ts:65)
  await this.repo.save(r);
  return r; // NO se autoriza principal, NO se submitea el payout — sin mover valor
}

// 3. Autorizar el principal on-chain (paso existente, L35 en adelante — sin cambios)
const { tx } = await this.wallet.authorizePrincipal(quote);
// ... resto igual ...
```

> **Por qué ANTES de `authorizePrincipal`**: `TRANSITIONS` permite `confirmed → payout_failed`
> (`remittance.ts:65`) → se puede fallar sin pull del principal on-chain, evitando mover valor del
> sender para un KYC no autorizado (sin refund). Cumple AC-1/AC-2/AC-6.
> **CD-A10**: el enforcement vive en el USE-CASE, nunca en el dominio `Remittance` (queda puro, sin I/O).

---

## 7. Waves (con snippets) + dependencias

### W0 — Serial Gate (contratos/tipos)
- **W0.1** `ports.ts`: agregar `PayoutAuthorization` + `PayoutAuthorityGateway` (§5.1) tras L80.
- **W0.2** `decision.ts`: `DiditRaw += vendor_data?: string` (L16-20); `DiditDecisionResult += vendorData: string` (L5-14); mapear `vendorData: s(raw?.vendor_data)` en el return (L44-53). **Aditivo** (CD-A7).
- Verificación: `npm run typecheck`.

### W1 — Ruta + adapter (paralelizable)
- **W1.1** `app/api/payout/validate/route.ts` (§3). Depende de W0.2 (usa `d.vendorData`, `mapDiditDecision`). Exemplar: `app/api/kyc/decision/route.ts`.
- **W1.2** `src/infrastructure/payout/payout-authority-gateway.ts` (§5.2). Depende de W0.1. Exemplar: `kyc-gateway.ts`.
- **W1.3** `app/api/payout/validate/route.test.ts` (Test Plan §9). Exemplar: `decision/route.test.ts`.
- **W1.4** `decision.test.ts`: +1 caso `mapDiditDecision` extrae `vendorData`.
- Verificación: `npm run qa`.

### W2 — Integración (enforcement)
- **W2.1** `confirm-and-send.ts`: inyectar `authority` + check pre-`authorizePrincipal` (§6). Depende de W0.1.
- **W2.2** `container.ts`: instanciar `HttpPayoutAuthorityGateway` + pasarlo a `ConfirmAndSend` (§5.3). Depende de W1.2, W2.1.
- **W2.3** `fakes.ts` + `confirm-and-send.test.ts` (net-new): `FakePayoutAuthorityGateway` + tests de enforcement. Depende de W2.1.
- Verificación: `npm run qa`.

### W3 — Final
- **W3.1** `.env.example`: comentario prod-detection (§8), sin env var nueva obligatoria.
- **W3.2** `npm run qa` full + `npm run build` + regresión manual (dev sin key → "Entregado"; authority `false` → bloqueado).

**Dependencias:** W1.1←W0.2 · W1.2←W0.1 · W2.1←W0.1 · W2.2←W1.2,W2.1 · W2.3←W2.1.

---

## 8. Env vars (`.env.example`)

- **NO agregar env var obligatoria nueva.** `VERCEL_ENV` ya lo inyecta Vercel (no se documenta como
  clave a completar; es de plataforma).
- Agregar un comentario en la sección KYC documentando el prod-detection:

```
# ── Prod-detection (WKH-180) ──
# VERCEL_ENV lo inyecta Vercel automáticamente ("production" solo en el deploy de prod).
# /api/payout/validate lo usa para fail-loud en prod sin DIDIT_API_KEY (nunca autoriza por default).
# Fuera de Vercel (self-host/CI) VERCEL_ENV está ausente → camino simulado; seteá DIDIT_API_KEY
# para re-validar de verdad. NO requiere env var nueva.
```

---

## 9. Test Plan (13 casos — ≥1 por AC)

| # | Test | AC | Archivo (Wave) |
|---|------|----|----------------|
| 1 | ruta: `VERCEL_ENV=production` + sin key → **503** `authorized:false` `kyc_authority_unavailable`, `fetch` NOT called | AC-3, CD-4 | route.test (W1.3) |
| 2 | ruta: sin `VERCEL_ENV` + sin key → **200** `authorized:true` `simulated_dev`, `fetch` NOT called | AC-4 | route.test (W1.3) |
| 3 | ruta: `verificationId` `""`/ausente (con key) → **400** `invalid_verification_id`, `fetch` NOT called | AC-5 | route.test (W1.3) |
| 4 | ruta: key + Didit `Approved` → **200** `authorized:true` | AC-1 | route.test (W1.3) |
| 5 | ruta: key + Didit `Declined` → **200** `authorized:false` `kyc_not_approved` | AC-2, AC-6 | route.test (W1.3) |
| 6 | ruta: key + Didit `!res.ok` → **502** `authorized:false` `kyc_reauth_failed` | AC-2 | route.test (W1.3) |
| 7 | ruta: `vendor_data` mismatch vs address → `false` `kyc_ownership_mismatch`; match → `true`; ausente → `true` (residual) | AC-1 (ownership) | route.test (W1.3) |
| 8 | ruta: `DIDIT_API_KEY` solo server-side — el body de respuesta nunca contiene el key ni `identity` | AC-7, CD-A8 | route.test (W1.3) |
| 9 | use-case: authority `authorized:false` → `payouts.submit` NOT called, `wallet.authorizePrincipal` NOT called, status `payout_failed` + `failureReason` seteado | AC-1, AC-2, AC-6 | confirm-and-send.test (W2.3) |
| 10 | use-case: estado con `kyc.approved:true` forjado PERO authority `false` → bloqueado (override server-side gana) | AC-6 | confirm-and-send.test (W2.3) |
| 11 | use-case: authority `authorized:true` → flujo completo → `submit` called → `submitted`/`settled` (regresión) | AC-1 | confirm-and-send.test (W2.3) |
| 12 | adapter: `fetch` throw/red-caída → `{authorized:false, reason:"kyc_authority_error"}` (fail-closed) | AC-2, CD-A4 | route.test o adapter test (W1.3) |
| 13 | decision: `mapDiditDecision` extrae `vendorData` (presente → valor; ausente → `""`) | — | decision.test (W1.4) |

> Para el caso 10: construir la remesa hasta `confirmed` con un `KycVerification` `approved:true`
> (estado válido para `confirm()`), y pasar un `FakePayoutAuthorityGateway({authorized:false})` →
> demuestra que el override server-side gana sobre el estado client-side.

---

## 10. Constraint Directives — checklist (heredados + SDD)

**OBLIGATORIO:**
- [ ] CD-A1: ruta sigue guard-order de `kyc/decision/route.ts` (env-gate → formato → Didit). Nunca `fetch` antes de los guards.
- [ ] CD-A2: `DIDIT_API_KEY` y todo `fetch` a Didit corren SOLO en la ruta API (server runtime). Cero exposición al bundle cliente (AC-7).
- [ ] CD-A3: firma `authorize({verificationId, address})` con `address: string` (NO opcional). Use-case pasa `getAddress() ?? ""`.
- [ ] CD-A4: adapter fail-closed — error de red/parse → `{authorized:false}`. Nunca lanzar sin catch, nunca `true` por default.
- [ ] CD-A5: reusar `mapDiditDecision` para parsear la respuesta de Didit. NO re-implementar `status → approved`.
- [ ] CD-A6: `isProd()` = `VERCEL_ENV === "production"`. NO inventar env var custom.

**PROHIBIDO:**
- [ ] CD-1: NO tocar nada fuera de `chaski-v2/` (demo live, `wasiai-a2a`, agentes `remit-*`).
- [ ] CD-2: NO tratar `approved`/`payoutAllowed`/`kycVerificationId` del browser como autoridad final. La autorización se origina SOLO en `/api/payout/validate`.
- [ ] CD-4: NO permitir que el camino simulación (sin key) autorice payouts en prod silenciosamente. Prod sin key = 5xx explícito.
- [ ] CD-A7: NO modificar `FallbackPayoutGateway` ni el comportamiento de `/api/kyc/session|decision` (WKH-179). La extensión de `decision.ts` es ADITIVA (nuevo `vendorData`), sin alterar campos/mapeos existentes.
- [ ] CD-A8: NO devolver PII (`identity`, `documentNumber`) desde `/api/payout/validate` — solo `{authorized, reason}`.
- [ ] CD-A9: NO agregar dependencias nuevas (usar `fetch`/`next/server` ya presentes). No JWT libs.
- [ ] CD-A10: NO mover el enforcement al dominio `Remittance` (queda puro, sin I/O). Vive en el use-case.
- [ ] **CD-11 (auto-blindaje WKH-179):** `tsconfig` tiene `noUncheckedIndexedAccess`. PROHIBIDO acceso por índice sin guardia — usar `?.`/`!` deliberado; **tipar los `vi.fn` cuyos `.mock.calls` se inspeccionan** (ej. `const submit = vi.fn<[PayoutSubmit], Promise<PayoutRecord>>()`). Ref: `002-wkh-179/auto-blindaje.md#2`.
- [ ] **CD-12 (auto-blindaje WKH-179):** PROHIBIDO reconstruir a mano tipos literal-template de libs — derivarlos con `Parameters<>`/`ReturnType<>`. (Probablemente N/A acá.) Ref: `002-wkh-179/auto-blindaje.md#1`.

---

## 11. Nota de coordinación (WKH-181/182/183)

**WKH-181/182/183 (misma auditoría 2026-07-10) tocan potencialmente los MISMOS archivos:**
`confirm-and-send.ts`, `ports.ts`, `container.ts`. Para minimizar colisiones de merge:

- **Mantené el diff lo más acotado posible.** En `confirm-and-send.ts` insertá SOLO el bloque del
  §6 (un `const address` + un `const auth` + un `if`), sin re-ordenar el resto del método.
- En `ports.ts` **appendeá** el nuevo port al final de la sección Payout (tras L80) — no reflow del archivo.
- En `container.ts` agregá **una** línea de instanciación (tras L50) + el 5º arg en L60 — nada más.
- En `fakes.ts` **appendeá** `FakePayoutAuthorityGateway` al final — no toques los doubles existentes.
- Si al empezar F3 detectás que otra de las HUs ya mergeó y cambió estos archivos, **rebasea y
  re-verificá los números de línea de la §2 antes de editar** (pueden haberse corrido).

---

## 12. Done Definition

- [ ] Los 11 archivos del Scope IN (§1) creados/modificados según waves.
- [ ] `npm run typecheck` (tsc `--noEmit`) verde.
- [ ] `npm run test` (`vitest run`) verde — los 13 casos del Test Plan pasan.
- [ ] `npm run build` (`next build`) verde — el key NUNCA se bundlea al cliente (ruta = server runtime).
- [ ] `npm run qa` (typecheck + test) verde de punta a punta.
- [ ] Regresión manual: dev sin `DIDIT_API_KEY` → el demo llega a "Entregado" (`simulated_dev`).
- [ ] Todos los CD del §10 respetados (checklist marcada).
- [ ] Diff acotado (§11) — sin cambios fuera de `chaski-v2/` (CD-1) ni al mock/rutas WKH-179 (CD-A7).

---

*Story File generado por NexusAgil — Architect F2.5 (WKH-180). Todos los exemplars verificados con
Read (paths + líneas reales confirmados). Sin `[NEEDS CLARIFICATION]` pendientes.*
