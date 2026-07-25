# Story File — [WKH-218] Chaski corre SOBRE los rieles A2A (no punto-a-punto)

> **Contrato ejecutable F3. Este archivo es lo ÚNICO que necesitás leer para implementar.**
> Repo: `chaski-v3`. Derivado de `sdd.md` (SPEC_APPROVED). NO releas el SDD.
> Gateway `wasiai-a2a`: **SOLO LECTURA** (CD-1). Todo el código a cambiar es de `chaski-v3`.

---

## 1. Contexto mínimo

Chaski enruta hoy quote (FX) y payout **punto-a-punto**: las routes server-only
`app/api/a2a/{quote,payout/submit}/route.ts` hacen `fetch(REMIT_AGENTS_BASE_URL + "/api/agents/<slug-literal>/invoke")`.
Esta HU agrega un **3er modo de transporte** `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER="a2a-gateway"` que
resuelve el agente vía `POST /discover` y lo invoca vía `POST /compose` (single-step) contra el gateway
`wasiai-a2a`, autenticando con una **Agent Key propia server-only** (`x-a2a-key`).

**Invariantes rectores (memorizalos):**
- **Guards 1-8 de payout INTOCABLES** (CD-2): `submit/route.ts` L73-333 byte-idénticos. Solo cambia el forward final (L363-401).
- **Flag OFF byte-idéntico** (CD-6/AC-6): cualquier valor ≠ `"a2a-gateway"` (unset, `"fallback"`, `"a2a"`) deja el comportamiento actual **byte-idéntico**. Esta HU **construye, no enciende**.
- **Fail-closed SIN fallback punto-a-punto** (CD-5/AC-4): si el gateway está ON y falla, se corta con 502/501 opaco. CERO fallback silencioso al `fetch` directo.
- **Creds/PII nunca en logs** (CD-3/CD-4): `WASIAI_A2A_*` sin `NEXT_PUBLIC_`; jamás loguear `beneficiary`/PII ni la Agent Key.

---

## 2. Scope IN — archivos exactos

| # | Archivo | Estado | Wave |
|---|---------|--------|------|
| 1 | `src/infrastructure/a2a/gateway-client.ts` | **NUEVO** | W0 |
| 2 | `src/infrastructure/a2a/gateway-client.test.ts` | **NUEVO** (co-located) | W0 |
| 3 | `src/composition/container.ts` | MODIFICAR (2 líneas) | W0 |
| 4 | `.env.example` | MODIFICAR (agregar bloque) | W0 |
| 5 | `app/api/a2a/quote/route.ts` | MODIFICAR (rama al tope) | W1 |
| 6 | `app/api/a2a/quote/route.test.ts` | MODIFICAR (casos gateway) | W1 |
| 7 | `app/api/a2a/payout/submit/route.ts` | MODIFICAR (SOLO forward L363-401) | W2 |
| 8 | `app/api/a2a/payout/submit/route.test.ts` | MODIFICAR / CREAR (casos gateway) | W2 |
| 9 | `app/api/a2a/payout/guard8-intact.test.ts` | MODIFICAR (caso flag gateway ON) | W2/W3 |

**PROHIBIDO tocar cualquier otro archivo.** En particular: `src/infrastructure/a2a/gateways.ts`
(contrato client-side hacia el dominio, NO cambia), `wasiai-a2a/**` (otro repo, solo lectura).

---

## 3. Anti-Hallucination Checklist (verificado en F2, no reverifiques — usá tal cual)

- Slugs reales confirmados: `remit-corridor-fx` (FX) / `remit-cashout-payout` (payout).
- Endpoints gateway confirmados: `POST /discover` (SIN auth) + `POST /compose` (auth `x-a2a-key`, máx 5 steps).
- **Unwrap gateway (DT-A2A-6):** el gateway hace `output = data.result ?? data` → `steps[0].output` **YA es el objeto crudo** del agente (`{quoteId,...}` / `{status,payoutId,...}`). `gateway-client` devuelve `steps[0].output` **sin re-desenvolver**. NO hagas doble-unwrap.
- Los strings exactos de `capability` NO son confirmables desde código → **se parametrizan por env** con defaults documentados. NUNCA los hardcodees en el módulo.
- Type-guards sin `any`: espejo de `src/infrastructure/a2a/gateways.ts:42-77` (`isRecord` + `Array.isArray`). Responses tipadas `unknown`.
- `gateway-client.ts` es **server-only**: lo importan SOLO las routes `app/api/a2a/*`. NUNCA `container.ts` ni un `"use client"`.
- Gate estático del repo = `npx tsc --noEmit` + `npx vitest run`. **NO** `next lint` (roto en Next 16, CD-A2A-9).

---

## 4. Waves — checklist ejecutable

### W0 — Serial (contratos/tipos/wiring). BLOQUEA W1 y W2. Hacé W0 completo antes de W1/W2.

#### 4.0.1 — `src/infrastructure/a2a/gateway-client.ts` (NUEVO, server-only)

Reproducí LITERAL este diseño (tipos narrow + `runViaGateway`). Firma pública exacta:

```ts
export type GatewayFailCode = "not_configured" | "no_agent" | "unavailable";
export type GatewayResult =
  | { ok: true; result: unknown }
  | { ok: false; code: GatewayFailCode };

export async function runViaGateway(params: {
  capability: string;              // WASIAI_A2A_FX_CAPABILITY | WASIAI_A2A_PAYOUT_CAPABILITY
  expectedSlug?: string;           // WASIAI_A2A_FX_SLUG | WASIAI_A2A_PAYOUT_SLUG (desambigua el pick)
  input: Record<string, unknown>;  // el body TAL CUAL (idempotencyKey/beneficiary intactos, CD-8)
}): Promise<GatewayResult>;
```

**Tipos narrow del gateway (reproducí local, NO importés de `wasiai-a2a`):**

```ts
interface GatewayAgent {
  slug: string;        // → ComposeStep.agent
  registry: string;    // → ComposeStep.registry
  capabilities: string[];
  status: "active" | "inactive" | "unreachable";
  // (id/name/description/priceUsdc/verified/... presentes en el gateway pero NO consumidos)
}
interface GatewayDiscoveryResult {
  agents: GatewayAgent[];
  total: number;
  registries: string[];
}
interface GatewayStepResult { output: unknown; /* + agent/costUsdc/latencyMs ignorados */ }
interface GatewayComposeResult {
  success: boolean;
  steps: GatewayStepResult[];
  output?: unknown;
  error?: string;
  errorCode?: string;
}
```

**Config server-only (leída en runtime dentro de la fn, patrón `!BASE`):**

```ts
function readGatewayConfig(): { url: string; key: string } | null {
  const url = process.env.WASIAI_A2A_GATEWAY_URL;
  const key = process.env.WASIAI_A2A_AGENT_KEY;
  if (!url || !key) return null; // ausente/vacío ⇒ not_configured
  return { url, key };
}
```

**Type-guard helper (espejo `gateways.ts:42`):**

```ts
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
```

**Algoritmo de `runViaGateway` (fail-closed exhaustivo):**

1. `cfg = readGatewayConfig()` → si `null` ⇒ `return { ok: false, code: "not_configured" }` (NO fetch).
2. **`POST {url}/discover`** — headers `{ "content-type": "application/json" }` (SIN auth), body
   `{ capabilities: [capability], includeInactive: false }`, `signal: AbortSignal.timeout(10_000)`.
   Todo dentro de `try/catch`. Cualquier throw / `!res.ok` / JSON no parseable / shape inválido
   (`!isRecord(body)` o `!Array.isArray(body.agents)`) ⇒ `return { ok: false, code: "unavailable" }`.
3. **Pick del agente:** `const agents = body.agents as GatewayAgent[];`
   `const pick = expectedSlug ? agents.find(a => a.slug === expectedSlug) ?? agents[0] : agents[0];`
   Si `agents.length === 0` **o** `pick == null` ⇒ `return { ok: false, code: "no_agent" }`.
   **NUNCA** te caés al slug hardcodeado del punto-a-punto (CD-5).
4. **`POST {url}/compose`** — headers `{ "content-type": "application/json", "x-a2a-key": cfg.key }`,
   body `{ steps: [{ agent: pick.slug, registry: pick.registry, input }] }` (single-step, `input` TAL CUAL),
   `signal: AbortSignal.timeout(10_000)`. Todo dentro de `try/catch`. Cualquier throw / `!res.ok` ⇒ `"unavailable"`.
5. **Validación de la respuesta:** parseá `unknown`. Si `!isRecord(body)` o `body.success !== true` ⇒ `"unavailable"`.
   `const steps = body.steps;` si `!Array.isArray(steps)` o `steps.length === 0` ⇒ `"unavailable"`.
   `const output = (steps[0] as { output?: unknown }).output;` si `!isRecord(output)` ⇒ `"unavailable"`
   (guard defensivo; la route revalida el shape final con su propio `isValid*Result`).
6. **Happy path:** `return { ok: true, result: output };` (`steps[0].output` **sin re-desenvolver**, DT-A2A-6).

**Reglas del módulo (INVIOLABLES):**
- **Un solo `try/catch` por fetch.** Cualquier throw ⇒ `unavailable`. **NUNCA propaga** (nunca 500 crudo).
- **Cero PII / cero secreto en logs.** No loguear `input` (contiene `beneficiary`), ni la Agent Key, ni la URL. Si hacés telemetría, solo `code` + `capability`.
- **Sin `any` / sin `as unknown`.** Responses tipadas `unknown` y estrechadas con `isRecord` + `Array.isArray`.
- Chaski **NO** firma x402 (AC-5): el header es solo `x-a2a-key`; el body NO lleva challenge/firma.

#### 4.0.2 — `src/infrastructure/a2a/gateway-client.test.ts` (NUEVO, co-located)

Unit tests con gateway mockeado (`vi.stubEnv` + `vi.stubGlobal("fetch", vi.fn(...))`). Cubre AC-3/AC-4/AC-5/AC-7 (ver §5).

#### 4.0.3 — `src/composition/container.ts` (2 cambios mínimos, ambos inertes con default)

**Cambio (a) — L84**, `useA2a` incluye el nuevo valor:

```ts
// ANTES:
const useA2a = adapter === "a2a";
// DESPUÉS:
const useA2a = adapter === "a2a" || adapter === "a2a-gateway";
```

**Cambio (b) — L76**, guard fail-loud EIP-3009 acepta ambos adapters reales:

```ts
// ANTES:
    if (adapter !== "a2a") throw new Error("eip3009_requires_a2a_adapter"); // CD-3
// DESPUÉS:
    if (adapter !== "a2a" && adapter !== "a2a-gateway") throw new Error("eip3009_requires_a2a_adapter"); // CD-3
```

**NO tocar nada más de `container.ts`** (Solana/pop/settlement/refund intactos). Con EIP-3009 OFF (default de esta HU) el bloque de (b) nunca se entra ⇒ AC-6 byte-idéntico.

#### 4.0.4 — `.env.example` (agregar bloque, junto al bloque `REMIT_AGENTS_BASE_URL`)

Documentá (server-only, SIN `NEXT_PUBLIC_` salvo el flag):

```
# --- A2A Gateway (WKH-218) — modo de transporte "a2a-gateway" (default OFF: construye, no enciende) ---
# Server-only (SIN NEXT_PUBLIC_): nunca llegan al bundle browser (CD-3/AC-7).
# WASIAI_A2A_GATEWAY_URL=https://<gateway>            # base del gateway wasiai-a2a (POST /discover + /compose)
# WASIAI_A2A_AGENT_KEY=<agent-key>                    # Agent Key prepaga propia de Chaski (header x-a2a-key)
# WASIAI_A2A_FX_CAPABILITY=fx-quote                   # capability del remit-corridor-fx (ajustar al AgentCard real)
# WASIAI_A2A_PAYOUT_CAPABILITY=cashout-payout         # capability del remit-cashout-payout (ajustar al AgentCard real)
# WASIAI_A2A_FX_SLUG=remit-corridor-fx                # opcional: desambigua el pick del discover
# WASIAI_A2A_PAYOUT_SLUG=remit-cashout-payout         # opcional: desambigua el pick del discover
# NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=a2a-gateway      # 3er valor (además de "fallback"|"a2a")
# NOTA (DT-A2A-9): en modo gateway el payout SIGUE exigiendo REMIT_AGENTS_BASE_URL seteada
#   (guard 1 byte-idéntico), aunque el forward ya no la use para el transporte. Setéalas juntas.
```

**Fin W0.** Verificá `npx tsc --noEmit` + `npx vitest run` verdes antes de seguir.

---

### W1 — Quote (menor riesgo). Paralelizable con W2 tras W0.

#### 4.1.1 — `app/api/a2a/quote/route.ts`

Agregá una **rama al TOPE del handler** (después de leer el `adapter`), dejando el cuerpo punto-a-punto **byte-idéntico debajo**. Referencia del estado actual (L27-48): lee `BASE`, `!BASE→501`, `fetch(...remit-corridor-fx/invoke)`, `isValidQuoteResult`, `{ result }`/opaco.

Estructura objetivo:

```ts
import { runViaGateway } from "../../../../src/infrastructure/a2a/gateway-client";
// ...
export async function POST(req: Request): Promise<Response> {
  const adapter = process.env.NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER;
  const body = await req.json().catch(() => ({}));

  if (adapter === "a2a-gateway") {
    const r = await runViaGateway({
      capability: process.env.WASIAI_A2A_FX_CAPABILITY ?? "fx-quote",
      expectedSlug: process.env.WASIAI_A2A_FX_SLUG ?? "remit-corridor-fx",
      input: body as Record<string, unknown>,
    });
    if (!r.ok) {
      if (r.code === "not_configured")
        return NextResponse.json({ error: "a2a_not_configured" }, { status: 501 });
      return NextResponse.json({ error: "a2a_unavailable" }, { status: 502 }); // no_agent | unavailable
    }
    if (!isValidQuoteResult(r.result))
      return NextResponse.json({ error: "a2a_bad_shape" }, { status: 502 });
    return NextResponse.json({ result: r.result }, { status: 200 });
  }

  // --- rama punto-a-punto / mock: BYTE-IDÉNTICA al actual (BASE, fetch, isValidQuoteResult) ---
  const BASE = process.env.REMIT_AGENTS_BASE_URL;
  if (!BASE) return NextResponse.json({ error: "a2a_not_configured" }, { status: 501 });
  // ... (resto intacto tal cual L31-47)
}
```

**Detalles:** el `body` se lee una sola vez arriba y se pasa a ambas ramas (el actual lo lee dentro; movelo arriba SIN cambiar el shape del parse `.catch(() => ({}))`). NUNCA ecoar `BASE` ni el body en errores (CD-4/CD-5).

#### 4.1.2 — `app/api/a2a/quote/route.test.ts`
Agregá casos gateway (ver §5, AC-1/AC-4/AC-6). Mantené verdes los casos punto-a-punto existentes.

---

### W2 — Payout (SOLO el bloque de forward final). Paralelizable con W1 tras W0.

#### 4.2.1 — `app/api/a2a/payout/submit/route.ts`

**Guards 1-8 (L73-333) byte-idénticos — NO los toques (CD-2).** SOLO se ramifica el bloque de forward
final (L363-401), post guard 8. La resolución del `adapter` se lee **al inicio del forward** (post guard 8), NUNCA antes.

Estado actual del forward (L363-401, referencia byte-exacta):

```ts
  // A10 — todo OK → forward (bloque intacto salvo el side-effect aditivo del ledger antes de cada return).
  try {
    const res = await fetch(`${BASE}/api/agents/remit-cashout-payout/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body), // idempotencyKey/beneficiary forwardeados tal cual (CD-10)
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) { await persistOutcome("forward_error", null, "a2a_upstream_error"); return NextResponse.json({ error: "a2a_upstream_error" }, { status: 502 }); }
    const { result } = (await res.json()) as { result: unknown };
    if (!isValidPayoutResult(result)) { await persistOutcome("forward_error", null, "a2a_bad_shape"); return NextResponse.json({ error: "a2a_bad_shape" }, { status: 502 }); }
    // ... mapeo mapped + persistOutcome + return { result } 200 ...
  } catch { await persistOutcome("forward_error", null, "a2a_unavailable"); return NextResponse.json({ error: "a2a_unavailable" }, { status: 502 }); }
```

**Cambio objetivo:** justo antes del `try`, resolver `const result = await composePayoutViaGateway(body)` cuando
`adapter === "a2a-gateway"`, preservando `persistOutcome(...)` idéntico antes de cada `return`. La forma más
limpia y segura (mínimo diff, mantiene el mapeo/ledger idéntico): obtener el `result` crudo por una u otra vía y
reusar la MISMA lógica de validación + mapeo + `persistOutcome` + `return`:

```ts
  const adapter = process.env.NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER;

  if (adapter === "a2a-gateway") {
    const r = await runViaGateway({
      capability: process.env.WASIAI_A2A_PAYOUT_CAPABILITY ?? "cashout-payout",
      expectedSlug: process.env.WASIAI_A2A_PAYOUT_SLUG ?? "remit-cashout-payout",
      input: body as Record<string, unknown>, // idempotencyKey/beneficiary intactos (CD-8)
    });
    if (!r.ok) {
      // not_configured no debería llegar (guard 1 !BASE→501 ya corrió, DT-A2A-9); igual mapear opaco.
      await persistOutcome("forward_error", null, "a2a_unavailable");
      return NextResponse.json({ error: "a2a_unavailable" }, { status: 502 }); // no_agent | unavailable | not_configured
    }
    if (!isValidPayoutResult(r.result)) {
      await persistOutcome("forward_error", null, "a2a_bad_shape");
      return NextResponse.json({ error: "a2a_bad_shape" }, { status: 502 });
    }
    const okResult = r.result as { status: string; payoutId: string | null };
    const mapped: SettlementLedgerStatus =
      okResult.status === "settled" ? "settled" : okResult.status === "submitted" ? "submitted" : "failed";
    await persistOutcome(mapped, okResult.payoutId, mapped === "failed" ? `a2a_${okResult.status}` : null);
    return NextResponse.json({ result: r.result }, { status: 200 });
  }

  // --- rama punto-a-punto: el bloque try/fetch(...remit-cashout-payout/invoke) EXISTENTE, INTACTO ---
  try { /* ... L365-400 byte-idéntico ... */ }
```

**Reglas:** `persistOutcome(...)` corre antes de CADA `return` en ambas ramas (idéntico). El `input` del step
es `body` TAL CUAL (`idempotencyKey`/`beneficiary` sin regenerar, CD-8/AC-8). NUNCA loguear/ecoar `beneficiary`
en errores (CD-4/AC-8). Importá `runViaGateway` desde `../../../../../src/infrastructure/a2a/gateway-client`
(ajustá el nivel de `../` según la profundidad real de la route).

#### 4.2.2 — `app/api/a2a/payout/submit/route.test.ts`
Casos gateway + idempotencyKey + PII-free (ver §5, AC-2/AC-4/AC-8).

#### 4.2.3 — `app/api/a2a/payout/guard8-intact.test.ts`
Se mantiene VERDE sin cambios de comportamiento. **Agregá** un caso: con `adapter="a2a-gateway"` seteado
**y** `SETTLE_ATTESTATION_SECRET` seteado pero SIN `settlementAttestation` → sigue 403 SIN forward, y
`runViaGateway` (spy) `not.toHaveBeenCalled()` (los guards cortan antes de leer el `adapter`).

---

### W3 — Kill-switch AC-4 + verificación byte-idéntica. Tras W1/W2.

Tests dedicados de fail-closed (gateway inalcanzable + `/discover` vacío) en `gateway-client`, `quote/route` y
`payout/submit/route`, y el test explícito de que flag OFF (`adapter="a2a"`) sigue punto-a-punto (AC-6). Ver §5.

**Orden global: W0 → (W1 ∥ W2) → W3.** W1 y W2 tocan archivos disjuntos.

---

## 5. Tests por wave (mapeo AC → test, ≥1 por AC)

Runner: **vitest** (glob default recoge co-located; no hay `vitest.config`). Mock: `vi.stubEnv` +
`vi.stubGlobal("fetch", vi.fn(...))` (exemplar: `app/api/a2a/quote/route.test.ts`).

| AC | Wave | Archivo de test | Qué prueba |
|----|------|-----------------|------------|
| **AC-1** quote vía compose | W1 | `quote/route.test.ts` | `adapter="a2a-gateway"` → fetch va a `{URL}/discover` y `{URL}/compose` (NO a `{BASE}/api/agents/remit-corridor-fx/invoke`); 200 `{ result }`. |
| **AC-2** payout vía compose (post-guards) | W2 | `payout/submit/route.test.ts` | payload que pasa guards 1-8 + `adapter="a2a-gateway"` → invoca `{URL}/compose` con el payout agent; NO fetch directo al agente. |
| **AC-3** discover antes de compose | W0 | `gateway-client.test.ts` | `runViaGateway` llama `/discover` (body `capabilities:[cap]`) ANTES de `/compose`; el step usa `slug`/`registry` del agente resuelto, no un slug hardcodeado. |
| **AC-4** fail-closed (ESTRELLA) | W3 | `gateway-client.test.ts` + `quote/route.test.ts` + `payout/submit/route.test.ts` | (i) `/discover` throw/timeout → `unavailable` → 502; (ii) `/discover` `agents:[]` → `no_agent` → 502; (iii) `/compose` `!ok` → 502. En las routes con gateway inalcanzable + `/discover` vacío: **`expect(directFetch).not.toHaveBeenCalled()`** (jamás fetch al `{BASE}/api/agents/.../invoke`). |
| **AC-5** gateway resuelve precio/x402 | W0 | `gateway-client.test.ts` | el request a `/compose` lleva header `x-a2a-key`; el body NO contiene payload x402/firma; Chaski no arma challenge. |
| **AC-6** flag OFF byte-idéntico | W1+W2 | `quote/route.test.ts`, `payout/submit/route.test.ts`, `guard8-intact.test.ts` | con `adapter="a2a"` (o unset) los tests punto-a-punto existentes siguen VERDES; fetch va al `{BASE}/api/agents/.../invoke` de siempre. guard8-intact verde. |
| **AC-7** creds server-only, no logueadas | W0 | `gateway-client.test.ts` | falta `WASIAI_A2A_GATEWAY_URL`/`AGENT_KEY` → `not_configured` (sin fetch); en errores el texto NUNCA contiene la URL ni la key (`expect(msg).not.toContain(KEY)`). |
| **AC-8** idempotencyKey intacto + PII-free | W2 | `payout/submit/route.test.ts` | el `input` del compose step es el body con `idempotencyKey` sin regenerar; la respuesta de error NUNCA contiene `beneficiary` (`expect(raw).not.toContain("<beneficiary-fixture>")`). |

**Test guards byte-idénticos (CD-2, explícito):** en `guard8-intact.test.ts`, con `adapter="a2a-gateway"` +
secreto seteado y sin `settlementAttestation` → 403 SIN forward, y `expect(gatewaySpy).not.toHaveBeenCalled()`.

---

## 6. Guardrails / PROHIBIDO (Constraint Directives — INVIOLABLES)

- **CD-1**: PROHIBIDO tocar `wasiai-a2a` (solo lectura). Ningún archivo del gateway en Scope IN.
- **CD-2**: PROHIBIDO remover/reordenar/debilitar los guards 1-8 de `submit/route.ts` (L73-333 byte-idénticos). Solo el forward final cambia.
- **CD-3**: `WASIAI_A2A_GATEWAY_URL`/`WASIAI_A2A_AGENT_KEY`/`WASIAI_A2A_*_CAPABILITY`/`_SLUG` SOLO server-side (SIN `NEXT_PUBLIC_`). Solo el flag `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` es público.
- **CD-4**: PROHIBIDO loguear/ecoar `beneficiary`/PII o la Agent Key en cualquier response de error (incluido `gateway-client.ts`).
- **CD-5**: OBLIGATORIO fail-closed (502/501 opaco) ante cualquier error del gateway (timeout, DNS, 5xx, `/discover` vacío). CERO fallback silencioso al punto-a-punto cuando el flag gateway está ON.
- **CD-6**: default del flag (≠ `"a2a-gateway"`) SHALL dejar el comportamiento byte-idéntico.
- **CD-7**: PROHIBIDO usar `/orchestrate` (LLM). Usar `/compose` single-step.
- **CD-8**: `idempotencyKey` viaja INTACTO dentro del `input` del compose step, nunca regenerado.
- **CD-A2A-9**: gate estático = `npx tsc --noEmit` + `npx vitest run`. **NO** `next lint` (roto en Next 16). Verificá que el conteo de test-files **subió** (nuevos tests recogidos), no solo que "pasó".
- **CD-A2A-10**: `gateway-client.ts` es **server-only** — NO importarlo desde `"use client"` ni desde `container.ts`.
- **CD-A2A-11**: sin `any` / sin `as unknown`; toda response del gateway se estrecha con `isRecord`/`Array.isArray`.

---

## 7. Definition of Done + Gate

**Los 8 ACs mapeados (§5):** AC-1..AC-8 cada uno con ≥1 test verde; AC-4 (fail-closed) con
`expect(directFetch).not.toHaveBeenCalled()` en quote y payout con gateway inalcanzable + `/discover` vacío.

**Gate estático (bloqueante):**
- `npx tsc --noEmit` → VERDE (sin `any`, sin errores de tipo). NO usar `next lint`.
- `npx vitest run` → VERDE. El conteo de test-files subió (nuevos: `gateway-client.test.ts`; casos nuevos en quote/payout/guard8).
- `guard8-intact.test.ts` VERDE, incluido el caso nuevo con `adapter="a2a-gateway"` (403 sin forward, gateway spy not called).

**Byte-identidad (bloqueante):**
- Con `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` unset / `"fallback"` / `"a2a"`: quote y payout se comportan byte-idénticos al actual (fetch al `{BASE}/api/agents/.../invoke`, mismos status/errores).
- `container.ts`: los 2 cambios son inertes con default (EIP-3009 OFF → guard (b) no se entra; `useA2a` con default `fallback` → Fallback mock intacto).

**Done cuando:** los 9 archivos del Scope IN están implementados, los 8 ACs tienen test verde, el gate estático
pasa, y la byte-identidad con flag OFF está confirmada por los tests existentes que siguen verdes.

---

## 8. Exemplars (paths reales, para copiar patrón — NO reinventar)

| Para... | Exemplar |
|---------|----------|
| Route server-only fail-closed opaco + timeout | `app/api/a2a/quote/route.ts` (L27-48) |
| Forward block a ramificar | `app/api/a2a/payout/submit/route.ts` (L363-401) |
| Type-guards sin `any` | `src/infrastructure/a2a/gateways.ts:42-77` |
| Wiring del flag | `src/composition/container.ts` (L71,76,84-85,89) |
| Test de route (stubEnv + stubGlobal fetch) | `app/api/a2a/quote/route.test.ts` |
| Test de guard byte-idéntico | `app/api/a2a/payout/guard8-intact.test.ts` |
| Doc env server-only | `.env.example` (bloque `REMIT_AGENTS_BASE_URL`) |
