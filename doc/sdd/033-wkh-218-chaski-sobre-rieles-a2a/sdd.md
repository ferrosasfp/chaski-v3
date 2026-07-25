# SDD — [WKH-218] Chaski corre SOBRE los rieles A2A (no punto-a-punto)

> Fase F2 (QUALITY, full). Autor: nexus-architect. Repo: `chaski-v3`.
> Gateway `wasiai-a2a`: SOLO LECTURA (CD-1) — todo el código a cambiar es de `chaski-v3`.
> Input: `work-item.md` (8 AC, 5 DT, 8 CD, 4 Missing Inputs) + `project-context.md`.

---

## 0. Resumen ejecutivo

Chaski enruta hoy quote (FX) y payout **punto-a-punto**: las routes server-only
`app/api/a2a/{quote,payout/submit}/route.ts` hacen
`fetch(REMIT_AGENTS_BASE_URL + "/api/agents/<slug-literal>/invoke")`. Esta HU agrega un
**3er modo de transporte** `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER="a2a-gateway"` que resuelve
el agente vía `POST /discover` y lo invoca vía `POST /compose` (single-step, DT-1) contra el
gateway `wasiai-a2a`, autenticando con una **Agent Key propia server-only** (`x-a2a-key`).
Default OFF: "construye, no enciende" (mismo patrón WKH-186/209/211/216).

El cambio es **aditivo y flag-gated**: cuando el flag NO es `"a2a-gateway"` (unset, `"fallback"`,
`"a2a"`) el comportamiento es **byte-idéntico** al actual (AC-6/CD-6). En payout, los 8 guards de
autorización quedan **byte-idénticos** (CD-2/DT-5): solo cambia el bloque de forward final
(post guard 8).

---

## 1. Context Map — archivos leídos y patrón extraído

### chaski-v3 (código a cambiar)
| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `app/api/a2a/quote/route.ts` (48 líneas) | rama que agrega `a2a-gateway` | BASE server-only → `fetch(.../remit-corridor-fx/invoke)` → `isValidQuoteResult` → `{ result }`. Errores opacos: `501 a2a_not_configured` / `502 a2a_upstream_error` / `502 a2a_bad_shape` / `502 a2a_unavailable`. `AbortSignal.timeout(10_000)`. Nunca ecoa BASE ni body (CD-9/CD-5). |
| `app/api/a2a/payout/submit/route.ts` (401 líneas) | SOLO el bloque de forward final (`L363-401`) | **Guards 1-8 fail-closed** (`L73-333`): (1) `!BASE→501`; (2-3) formato→400; (4-6) autoridad Didit→400/403/502/503; (7) PoP ed25519/EVM→403/409/503; (8) atestación settlement→403/409/503. Forward `L365-400`: `fetch(.../remit-cashout-payout/invoke)` con `persistOutcome(...)` (ledger best-effort, flag-gated) antes de cada `return`. Body forwardeado TAL CUAL (idempotencyKey/beneficiary, CD-10/CD-5). |
| `src/composition/container.ts` (`L71,84-85,89`) | cablear el 3er valor del flag | `adapter = process.env.NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`; `useA2a = adapter === "a2a"`; `quotes/payouts` cableados JUNTOS (DT-4 anti-mixto). Guard fail-loud EIP-3009: `if (adapter !== "a2a") throw`. |
| `src/infrastructure/a2a/gateways.ts` (178 líneas) | contrato hacia el dominio (NO cambia) | `A2aQuoteGateway`/`A2aPayoutGateway` client-side hacen `fetch("/api/a2a/quote"|"/api/a2a/payout/submit")`. Type-guards explícitos `isValidQuoteShape`/`isValidPayoutShape` (CD-15 sin any). El body del submit que arma (`L130-149`) es el que llega a la route → el que se forwardea. |
| `app/api/a2a/quote/route.test.ts` | exemplar de test de route | `vi.stubEnv` + `vi.stubGlobal("fetch", vi.fn(...))`; asserts de status + `expect(raw).not.toContain(BASE)`; `expect(fetchMock).not.toHaveBeenCalled()`. |
| `app/api/a2a/payout/guard8-intact.test.ts` | exemplar de test de guard byte-idéntico | Con `SETTLE_ATTESTATION_SECRET` seteado y SIN `settlementAttestation` → 403 + `fetch NOT called`. |
| `contracts/vendored/{corridor-fx,cashout-payout}.output.fixture.ts` | shape REAL del result de cada agente | `RawQuoteResult` `{quoteId,rate,feeUsd,netDeliveredLocal,etaMinutes,expiresAt,provenance}`; `RawPayoutResult` `{status,payoutId,deliveredLocal,txRef,reason,provenance,depositAddress}`. Slugs reales: `remit-corridor-fx` / `remit-cashout-payout`. |
| `project-context.md` | stack/guardrails | Next.js 16 (webpack) + TS strict + vitest. Gate estático = `tsc --noEmit` (ver §9 CD-A2A-9). NUNCA tocar `wasiai-a2a`. |

### wasiai-a2a (SOLO LECTURA — contrato del gateway, verificado)
| Archivo | Contrato confirmado |
|---------|---------------------|
| `src/routes/discover.ts:61-108` | `POST /` body `{ capabilities?: string\|string[], q?, maxPrice?, minReputation?, limit?, registry?, verified?, includeInactive? }` → `reply.send(DiscoveryResult)`. **SIN auth** (no `requirePaymentOrA2AKey`). |
| `src/types/index.ts:193-225` | `Agent` shape (ver §3.1). |
| `src/types/index.ts:280-295` | `DiscoveryResult { agents: Agent[]; total: number; registries: string[] }`. |
| `src/routes/compose.ts:337-356` | `POST /` body `{ steps: ComposeStep[]; maxBudget? }`. Requiere `requirePaymentOrA2AKey` (`x-a2a-key` prepaga O x402). Máx 5 steps (`L373`), cada step con `agent` string obligatorio (`L390-399`). |
| `src/types/index.ts:321-332` | `ComposeStep { agent: string; registry?: string; input: Record<string,unknown>; passOutput?; acceptanceCriteria? }`. |
| `src/types/index.ts:380-424` | `ComposeResult { success; output; steps: StepResult[]; totalCostUsdc; totalLatencyMs; error?; errorCode? }`; `StepResult { agent: Agent; output: unknown; costUsdc; latencyMs; ... }`. |
| `src/services/compose.ts:939-940` | **CLAVE**: `const data = await response.json(); const output = data.result ?? data;`. El gateway **desenvuelve** el `{ result }` del agente → `steps[0].output` es el objeto crudo del agente (`{quoteId,...}` / `{status,...}`), NO `{ result }`. |
| `src/services/compose.ts:827-828` | El `x-a2a-key` se propaga aguas abajo SOLO a registries system-trusted; el pago/fee-split x402 lo liquida el gateway (AC-5: Chaski no firma nada). |
| `src/services/discovery.ts:372-378` | Filtro de capability: `a.capabilities.some(...) OR a.description.includes(cap)` (case-insensitive). Confirma que el match NO es 1:1 al slug (DT-2). |

**No verificable desde código** (Missing Input #2): los strings exactos de `capabilities` con los que
`remit-corridor-fx`/`remit-cashout-payout` están **registrados** (self-published, dato de DB vía
publish-API, no fuente en ningún repo montado). Grep en `wasiai-a2a/src` NO devuelve los slugs ni sus
capabilities → **NO se hardcodean; se parametrizan por env** (DT-A2A-2, ver §3.2).

---

## 2. Arquitectura de la solución

```
                     NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER
                     ┌─────────┬──────────┬──────────────┐
   container.ts      │ unset/  │  "a2a"   │ "a2a-gateway"│  ← DT-4: 1 flag, quote+payout JUNTOS
   (composition)     │fallback │          │   (NUEVO)    │
                     ▼         ▼          ▼
                  Fallback   A2a*Gateway (client) → fetch("/api/a2a/*")  ← useA2a incluye ambos reales
                  (mock)          │
                                  ▼  (server-only routes deciden transporte por el MISMO flag)
   ┌──────────────────────────────────────────────────────────────────────────────────────┐
   │ app/api/a2a/quote/route.ts                                                             │
   │   adapter==="a2a-gateway" ─► quoteViaGateway(body)  [NUEVA RAMA]                       │
   │   else ─► fetch(`${BASE}/api/agents/remit-corridor-fx/invoke`)  [INTACTA, byte-idént.] │
   ├──────────────────────────────────────────────────────────────────────────────────────┤
   │ app/api/a2a/payout/submit/route.ts                                                     │
   │   guards 1-8 (autoridad/PoP/atestación)  ── BYTE-IDÉNTICOS (CD-2/DT-5) ──              │
   │   forward final:                                                                       │
   │     adapter==="a2a-gateway" ─► composePayoutViaGateway(body)  [BLOQUE QUE CAMBIA]      │
   │     else ─► fetch(`${BASE}/api/agents/remit-cashout-payout/invoke`)  [INTACTO]         │
   │   persistOutcome(...) idéntico en ambas ramas                                          │
   └──────────────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  src/infrastructure/a2a/gateway-client.ts  (NUEVO, server-only)
   ┌──────────────────────────────────────────────────────────────────────────────────────┐
   │  runViaGateway({ capability, expectedSlug?, input }):                                  │
   │   1. cfg = readGatewayConfig()   → falta URL/KEY ⇒ { ok:false, code:'not_configured' } │
   │   2. POST {URL}/discover  { capabilities:[capability], includeInactive:false }         │
   │        timeout 10s · sin auth · fail-closed ⇒ 'unavailable'                            │
   │   3. agents==[] (o ninguno matchea expectedSlug) ⇒ { ok:false, code:'no_agent' }       │
   │   4. pick = agents[0] (o el de slug===expectedSlug)                                     │
   │   5. POST {URL}/compose  { steps:[{ agent:pick.slug, registry:pick.registry, input }] } │
   │        header x-a2a-key:KEY · timeout 10s · !res.ok o body.success!==true ⇒ 'unavailable'│
   │   6. output = body.steps[0].output  (ya desenvuelto por el gateway, compose.ts:940)    │
   │        ⇒ { ok:true, result: output }                                                    │
   └──────────────────────────────────────────────────────────────────────────────────────┘
```

**Invariante anti-mixto (DT-4 preservado):** un solo flag cablea quote+payout. En `container.ts`,
`useA2a = adapter === "a2a" || adapter === "a2a-gateway"` selecciona los `A2a*Gateway` (que pegan a
las routes server-only) para AMBOS modos reales; el modo mock (`fallback`/unset) sigue seleccionando
ambos Fallback. **Imposible** quote-gateway + payout-mock: el flag es único y gobierna los dos.

---

## 3. Tipos y contrato del gateway (confirmados, sin `any` — CD-15 / Missing #3)

### 3.1 `Agent` (subconjunto que consume el discover) — `wasiai-a2a/src/types/index.ts:193`
Campos que usa `gateway-client.ts` (el resto se ignora, pass-through):
```ts
// Reproducción NARROW local en gateway-client.ts (no se importa de wasiai-a2a: otro repo).
interface GatewayAgent {
  slug: string;        // → ComposeStep.agent
  registry: string;    // display name → ComposeStep.registry (opcional pero lo pasamos)
  capabilities: string[];
  status: "active" | "inactive" | "unreachable";
  // (id/name/description/priceUsdc/verified/registry_id/invokeUrl/metadata/payment: presentes,
  //  NO consumidos por Chaski — AC-5: el precio/pago los resuelve el gateway)
}
interface GatewayDiscoveryResult {
  agents: GatewayAgent[];
  total: number;
  registries: string[];
}
```

### 3.2 Request/response de `/discover` y `/compose`
```ts
// POST /discover (sin auth)
// req:  { capabilities: string[]; includeInactive?: false; limit?: number }
// res:  GatewayDiscoveryResult

// POST /compose (auth: header x-a2a-key)
// req:  { steps: [{ agent: string; registry?: string; input: Record<string,unknown> }] }  // 1 step
// res 2xx: GatewayComposeResult
interface GatewayStepResult { output: unknown; /* + agent/costUsdc/latencyMs ignorados */ }
interface GatewayComposeResult {
  success: boolean;
  steps: GatewayStepResult[];
  output?: unknown;         // top-level = último step output (igual a steps[0].output en single-step)
  error?: string;
  errorCode?: string;
}
```
**Extracción del result (DT-A2A-6):** el agente devuelve `{ result: {...} }`; el gateway hace
`output = data.result ?? data` (`compose.ts:940`) ⇒ `steps[0].output` **YA es el objeto crudo**
(`{quoteId,...}` para FX, `{status,payoutId,...}` para payout). `gateway-client` devuelve
`steps[0].output` **sin re-desenvolver**. La route lo valida con el `isValidQuoteResult` /
`isValidPayoutResult` **ya existente** y responde `{ result: output }` (contrato hacia
`A2a*Gateway` intacto).

**Capability query parametrizable (DT-A2A-2, resuelve Missing #2):** los strings de capability no son
confirmables desde código. Se leen de env con placeholder documentado y se puede afinar el pick con
un slug esperado (defensa, opcional):
```
WASIAI_A2A_FX_CAPABILITY      (default: "fx-quote")        // capability del remit-corridor-fx
WASIAI_A2A_PAYOUT_CAPABILITY  (default: "cashout-payout")  // capability del remit-cashout-payout
WASIAI_A2A_FX_SLUG            (opcional, default: "remit-corridor-fx")     // desambigua el pick
WASIAI_A2A_PAYOUT_SLUG        (opcional, default: "remit-cashout-payout")  // desambigua el pick
```
El pick es: `agents.find(a => a.slug === expectedSlug) ?? agents[0]` (con `expectedSlug` = el `*_SLUG`
env). Si `agents == []` ⇒ `no_agent` (fail-closed, AC-4). **NUNCA** se cae al slug hardcodeado del
punto-a-punto (CD-5). El operador ajusta los 2 `*_CAPABILITY` cuando confirme los strings reales
contra el AgentCard (verificación e2e posterior, Missing #1).

---

## 4. Diseño de `src/infrastructure/a2a/gateway-client.ts` (NUEVO, server-only)

**Ubicación:** `src/infrastructure/a2a/gateway-client.ts` (junto a `gateways.ts`). Server-only:
importado SOLO por las routes server (`app/api/a2a/*`), NUNCA por un componente cliente (CD-A2A-10;
`WASIAI_A2A_*` sin prefijo `NEXT_PUBLIC_` ⇒ jamás llegan al bundle browser — AC-7/CD-3).

**Interfaz pública:**
```ts
export type GatewayFailCode = "not_configured" | "no_agent" | "unavailable";
export type GatewayResult =
  | { ok: true; result: unknown }
  | { ok: false; code: GatewayFailCode };

/**
 * Resuelve un agente por `capability` vía POST /discover y lo invoca vía POST /compose
 * (single-step) contra WASIAI_A2A_GATEWAY_URL con la Agent Key server-only (x-a2a-key).
 * Fail-closed: NUNCA lanza, NUNCA hace fallback punto-a-punto, NUNCA loguea input/creds.
 */
export async function runViaGateway(params: {
  capability: string;         // WASIAI_A2A_FX_CAPABILITY | WASIAI_A2A_PAYOUT_CAPABILITY
  expectedSlug?: string;      // WASIAI_A2A_FX_SLUG | WASIAI_A2A_PAYOUT_SLUG (desambigua el pick)
  input: Record<string, unknown>;  // el body TAL CUAL (idempotencyKey/beneficiary intactos, CD-8)
}): Promise<GatewayResult>;
```

**Manejo fail-closed / timeout (mismo patrón `AbortSignal.timeout(10_000)` del repo):**
| Situación | `code` | Cómo lo detecta |
|-----------|--------|-----------------|
| `WASIAI_A2A_GATEWAY_URL` o `WASIAI_A2A_AGENT_KEY` ausente/vacío | `not_configured` | `readGatewayConfig()` retorna null (leído en runtime, dentro de la fn — patrón `!BASE`) |
| `/discover` timeout/DNS/`!res.ok`/JSON no parseable/shape inválido | `unavailable` | try/catch + `isRecord`/`Array.isArray(body.agents)` guard |
| `/discover` devuelve `agents: []` (o ninguno matchea) | `no_agent` | tras el pick |
| `/compose` timeout/DNS/`!res.ok` | `unavailable` | try/catch |
| `/compose` 2xx pero `body.success !== true` | `unavailable` | guard sobre `body.success` |
| `/compose` 2xx, `success:true`, pero `steps[0].output` ausente/no-record | `unavailable` | guard defensivo (mismo criterio que `isValidQuoteResult` — la route revalida el shape final) |
| happy path | — | `{ ok:true, result: steps[0].output }` |

- **Un solo try/catch por fetch**; cualquier throw ⇒ `unavailable` (nunca propaga → nunca 500 crudo).
- **Cero PII / cero secreto en logs**: no se loguea `input` (contiene `beneficiary`), ni la Agent Key,
  ni la URL en mensajes de error (AC-7/AC-8/CD-4). Si se necesita telemetría, solo `code` + `capability`.
- **Sin `any`** (CD-15): responses tipadas como `unknown` y estrechadas con `isRecord` +
  `Array.isArray` (espejo de `gateways.ts:42-77`).
- **Headers**: discover `{ "content-type": "application/json" }`; compose además
  `{ "x-a2a-key": KEY }`. Chaski **NO** firma x402 (AC-5): el gateway resuelve precio y liquida el
  fee-split aguas abajo.

**Mapeo `code` → respuesta HTTP opaca de la route** (parity con los enums vigentes, AC-4/CD-5):
| `code` | quote/route.ts | payout/submit/route.ts |
|--------|----------------|------------------------|
| `not_configured` | `501 { error:"a2a_not_configured" }` | `501 { error:"a2a_not_configured" }` (nota: en payout el guard 1 `!BASE→501` corre ANTES, ver DT-A2A-9) |
| `no_agent` | `502 { error:"a2a_unavailable" }` | `502 { error:"a2a_unavailable" }` (+ `persistOutcome("forward_error",null,"a2a_unavailable")`) |
| `unavailable` | `502 { error:"a2a_unavailable" }` | `502 { error:"a2a_unavailable" }` (+ `persistOutcome(...)`) |
| ok pero shape inválido | `502 { error:"a2a_bad_shape" }` (via `isValidQuoteResult`) | `502 { error:"a2a_bad_shape" }` (via `isValidPayoutResult` + `persistOutcome`) |
| ok + shape válido | `200 { result }` | `200 { result }` + `persistOutcome(mapped,...)` |

Todos son 502 opacos (fail-closed): **apagar el gateway rompe el flujo, CERO fallback silencioso**
(AC-4 estrella).

---

## 5. Cableado del flag en `container.ts` (DT-4 preservado)

Dos cambios mínimos, ambos **inertes con el default** (byte-idéntico, AC-6):

**(a) `useA2a` incluye el nuevo valor** (`L84`) — para que los `A2a*Gateway` (que pegan a las routes
server, donde vive el switch de transporte) se seleccionen también en modo gateway:
```ts
// antes:  const useA2a = adapter === "a2a";
// después: const useA2a = adapter === "a2a" || adapter === "a2a-gateway";
```
Efecto: `"fallback"/unset` → Fallback (mock) INTACTO; `"a2a"` → A2a*Gateway INTACTO; `"a2a-gateway"`
→ A2a*Gateway (nuevo) → las routes deciden gateway. quote+payout siguen cableados JUNTOS (DT-4).

**(b) Guard fail-loud EIP-3009 acepta ambos adapters reales** (`L76`) — simetría (inerte: solo corre
con `NEXT_PUBLIC_EIP3009_ENABLED==="true"`, OFF por default):
```ts
// antes:  if (adapter !== "a2a") throw new Error("eip3009_requires_a2a_adapter");
// después: if (adapter !== "a2a" && adapter !== "a2a-gateway") throw new Error("eip3009_requires_a2a_adapter");
```
Justificación: `a2a-gateway` ES un modo de value-delivery real; bloquear EIP-3009 sobre él sería
incoherente. Con EIP-3009 OFF (default de esta HU) el bloque NUNCA se entra ⇒ AC-6 byte-idéntico.

**NO se toca** nada más de `container.ts` (Solana/pop/settlement/refund intactos).

---

## 6. Waves de implementación

### W0 — Serial (contratos/tipos/wiring compartido). BLOQUEA W1/W2.
- `src/infrastructure/a2a/gateway-client.ts` (NUEVO) — tipos narrow §3 + `runViaGateway` §4 (discover
  + compose + extracción + fail-closed/timeout).
- `src/infrastructure/a2a/gateway-client.test.ts` (NUEVO, co-located) — unit test con gateway mockeado
  (cubre AC-3/AC-4/AC-5/AC-7; ver §7).
- `src/composition/container.ts` — cambios (a) y (b) de §5.
- `.env.example` — documentar `WASIAI_A2A_GATEWAY_URL`, `WASIAI_A2A_AGENT_KEY` (server-only),
  `WASIAI_A2A_{FX,PAYOUT}_CAPABILITY`, `WASIAI_A2A_{FX,PAYOUT}_SLUG`, 3er valor `"a2a-gateway"`.

### W1 — Quote (menor riesgo). Paralelizable con W2 tras W0.
- `app/api/a2a/quote/route.ts` — nueva rama al TOPE: `if (adapter==="a2a-gateway") return quoteViaGateway(req)`.
  El cuerpo existente (BASE + fetch punto-a-punto) queda **byte-idéntico** debajo (rama `a2a`/mock
  intacta). `quoteViaGateway` llama `runViaGateway({ capability: env FX, expectedSlug: env FX_SLUG,
  input: body })` → valida con `isValidQuoteResult` → `{ result }` / opaco.
- `app/api/a2a/quote/route.test.ts` — casos gateway (ver §7).

### W2 — Payout (solo el bloque de forward final). Paralelizable con W1 tras W0.
- `app/api/a2a/payout/submit/route.ts` — **guards 1-8 (`L73-333`) byte-idénticos** (CD-2). SOLO el
  bloque de forward `L363-401` se ramifica: `if (adapter==="a2a-gateway")` →
  `composePayoutViaGateway(body)` (via `runViaGateway`), preservando `persistOutcome(...)` idéntico
  antes de cada `return`; `else` → el `fetch` punto-a-punto **intacto**. La resolución del `adapter`
  se lee al inicio del forward (post guard 8), NUNCA antes.
- `app/api/a2a/payout/submit/route.test.ts` — casos gateway + idempotencyKey (ver §7).
- `app/api/a2a/payout/guard8-intact.test.ts` — se mantiene VERDE sin cambios (regresión CD-2).

### W3 — Kill-switch AC-4 + verificación byte-idéntica. Tras W1/W2.
- Tests dedicados de fail-closed (gateway inalcanzable + `/discover` vacío) en quote, payout y
  gateway-client, y test explícito de que flag OFF (`adapter="a2a"`) sigue punto-a-punto (AC-6).

Orden: **W0 → (W1 ∥ W2) → W3**. W1 y W2 tocan archivos distintos (sin overlap) → paralelizables.

---

## 7. Plan de tests (mapeo AC → wave → test, ≥1 por AC)

Runner: **vitest** (chaski-v3 no tiene `vitest.config` → glob default recoge tests co-located; el
nuevo `gateway-client.test.ts` va junto al módulo — sin cambios de config). Patrón de mock:
`vi.stubEnv` + `vi.stubGlobal("fetch", vi.fn(...))` (exemplar `quote/route.test.ts`).

| AC | Wave | Archivo de test | Qué prueba |
|----|------|-----------------|------------|
| **AC-1** quote vía compose | W1 | `quote/route.test.ts` | `adapter="a2a-gateway"` → el fetch va a `{URL}/discover` y `{URL}/compose` (NO a `{BASE}/api/agents/remit-corridor-fx/invoke`); 200 `{ result }`. |
| **AC-2** payout vía compose (post-guards) | W2 | `payout/submit/route.test.ts` | payload que pasa guards 1-8 (simulated_dev, secretos off/local) + `adapter="a2a-gateway"` → invoca `{URL}/compose` con el payout agent; NO fetch directo al agente. |
| **AC-3** discover antes de compose | W0 | `gateway-client.test.ts` | `runViaGateway` llama `/discover` (body `capabilities:[cap]`) ANTES de `/compose`; el step usa `slug`/`registry` del agente resuelto, no un slug hardcodeado. |
| **AC-4** fail-closed | W3 | `gateway-client.test.ts` + `quote/route.test.ts` + `payout/submit/route.test.ts` | (i) `/discover` throw/timeout → `unavailable` → 502; (ii) `/discover` `agents:[]` → `no_agent` → 502; (iii) `/compose` `!ok` → 502; en las routes: **jamás** hace fetch al punto-a-punto (`expect(directFetch).not.toHaveBeenCalled()`). |
| **AC-5** gateway resuelve precio/x402 | W0 | `gateway-client.test.ts` | el request a `/compose` lleva header `x-a2a-key`; el body NO contiene payload x402/firma; Chaski no arma ningún challenge. |
| **AC-6** flag OFF byte-idéntico | W1+W2 | `quote/route.test.ts`, `payout/submit/route.test.ts`, `guard8-intact.test.ts` | con `adapter="a2a"` (o unset) los tests punto-a-punto existentes siguen VERDES; el fetch va al `{BASE}/api/agents/.../invoke` de siempre. guard8-intact verde sin tocar. |
| **AC-7** creds server-only, no logueadas | W0 | `gateway-client.test.ts` | falta `WASIAI_A2A_GATEWAY_URL`/`AGENT_KEY` → `not_configured` (sin fetch); en errores el texto NUNCA contiene la URL ni la key (`expect(msg).not.toContain(KEY)`). |
| **AC-8** idempotencyKey intacto + PII-free | W2 | `payout/submit/route.test.ts` | el `input` del compose step es el body con `idempotencyKey` sin regenerar; la respuesta de error NUNCA contiene `beneficiary` (`expect(raw).not.toContain("999888777")`). |

**Test de guards byte-idénticos (CD-2, explícito):** `guard8-intact.test.ts` corre con
`adapter="a2a-gateway"` seteado además del secreto → sigue devolviendo 403 SIN forward (los guards
cortan antes de leer el `adapter`). Se agrega un caso que confirma que con el flag gateway ON, un
payload que NO pasa el guard 8 NUNCA llega a `runViaGateway` (`expect(gatewaySpy).not.toHaveBeenCalled()`).

---

## 8. Decisiones técnicas (DT)

Ratifico DT-1..DT-5 del work-item y agrego DT-A2A-6..10 (resoluciones a Missing Inputs):

- **DT-A2A-1** (=DT-1): `POST /compose` single-step, NO `/orchestrate`. Chaski sabe determinísticamente
  el agente; el LLM goal-based agrega latencia/costo/no-determinismo a un money-path KYC-gated (CD-7).
- **DT-A2A-2** (=DT-2, resuelve **Missing #2**): `agent`/`registry` del step se resuelven vía
  `POST /discover` por `capability` **parametrizada por env** (`WASIAI_A2A_{FX,PAYOUT}_CAPABILITY`,
  con placeholder + slug esperado opcional), NO por slug hardcodeado 1:1. `agents:[]` → fail-closed,
  jamás fallback al slug (CD-5). Los strings reales de capability se confirman contra el AgentCard en
  la verificación e2e (Missing #1), NO en F3.
- **DT-A2A-3** (=DT-3): credencial = Agent Key prepaga server-only (`WASIAI_A2A_AGENT_KEY`, header
  `x-a2a-key`), NO x402 pay-per-call. Simétrico a `REMIT_AGENTS_BASE_URL`/`DIDIT_API_KEY`. El
  aprovisionamiento de la key es founder-gated, **Scope OUT** (§10, Missing #1).
- **DT-A2A-4** (=DT-4): `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` gana el 3er valor `"a2a-gateway"` (no
  reemplaza `"a2a"`): rollout seguro, el punto-a-punto queda como respaldo operativo. Un flag cablea
  quote+payout (invariante anti-mixto).
- **DT-A2A-5** (=DT-5): en payout SOLO cambia el bloque de forward final (post guard 8); guards 1-8
  byte-idénticos. En quote la rama gateway se agrega al tope y la rama punto-a-punto queda intacta.
- **DT-A2A-6** (Missing #3, wire fact): el gateway desenvuelve el `{ result }` del agente
  (`compose.ts:940`, `data.result ?? data`) ⇒ `runViaGateway` devuelve `steps[0].output` SIN
  re-desenvolver; la route revalida con el `isValid*Result` existente. Evita el doble-unwrap (bug
  clásico de shape stale que CD-10 previene).
- **DT-A2A-7** (Missing #4, naming): `WASIAI_A2A_GATEWAY_URL`, `WASIAI_A2A_AGENT_KEY`,
  `WASIAI_A2A_{FX,PAYOUT}_{CAPABILITY,SLUG}`; módulo `src/infrastructure/a2a/gateway-client.ts`
  (junto a `gateways.ts`, mismo folder de infraestructura A2A).
- **DT-A2A-8** (wiring): `container.ts` `useA2a` incluye `"a2a-gateway"` (selecciona los `A2a*Gateway`
  que pegan a las routes) y el guard EIP-3009 acepta ambos adapters reales (§5). Inerte por default.
- **DT-A2A-9** (consecuencia de CD-2): el guard 1 de payout (`!BASE → 501`) queda byte-idéntico ⇒ en
  modo gateway el payout **sigue exigiendo** `REMIT_AGENTS_BASE_URL` seteada (aunque el forward ya no
  la use para el transporte). En quote la rama gateway se ramifica ANTES del guard BASE ⇒ quote-gateway
  NO exige `REMIT_AGENTS_BASE_URL`. Operativamente en modo gateway se setean las 3 juntas
  (`REMIT_AGENTS_BASE_URL` + `WASIAI_A2A_GATEWAY_URL` + `WASIAI_A2A_AGENT_KEY`). Documentado en `.env.example`.
- **DT-A2A-10** (CD-15): tipos del gateway **reproducidos narrow** en `gateway-client.ts` (no se
  importa de `wasiai-a2a`: repo separado, CD-1). Responses tipadas `unknown` + estrechadas con
  `isRecord`/`Array.isArray`. Cero `any`.

---

## 9. Constraint Directives (CD)

Heredo CD-1..CD-8 del work-item (vigentes) y agrego CD-A2A-9..11:

- **CD-1**: PROHIBIDO tocar `wasiai-a2a` (solo lectura). ✔ ningún archivo del gateway en Scope IN.
- **CD-2**: PROHIBIDO remover/reordenar/debilitar los guards 1-8 de `submit/route.ts` (`L73-333`
  byte-idénticos). El forward final es lo único que cambia.
- **CD-3**: `WASIAI_A2A_GATEWAY_URL`/`WASIAI_A2A_AGENT_KEY` SOLO server-side (sin `NEXT_PUBLIC_`).
- **CD-4**: PROHIBIDO loguear/ecoar `beneficiary`/PII o la Agent Key en cualquier response de error
  (extendido a `gateway-client.ts`).
- **CD-5**: OBLIGATORIO fail-closed (502/503 opaco) ante cualquier error del gateway (timeout, DNS,
  5xx, `/discover` vacío) — CERO fallback silencioso al punto-a-punto (evidencia de AC-4).
- **CD-6**: default del flag (≠ `"a2a-gateway"`) SHALL dejar el comportamiento byte-idéntico.
- **CD-7**: PROHIBIDO usar `/orchestrate` (LLM) para este money-path determinístico.
- **CD-8**: `idempotencyKey` viaja INTACTO dentro del `input` del compose step, nunca regenerado.
- **CD-A2A-9** (auto-blindaje HU-SOL-11 + WKH-227, recurrente ×2): el gate estático del repo es
  **`tsc --noEmit`** + `vitest run`, NO `next lint` (removido en Next 16 → "Invalid project
  directory"). El Dev verifica `npx tsc --noEmit` COMPLETO (no solo build) y que el conteo de
  test-files **subió** (nuevos tests recogidos), no solo que "pasó" (referencia:
  HU-SOL-11 auto-blindaje#3, WKH-227 auto-blindaje#2).
- **CD-A2A-10**: `gateway-client.ts` es **server-only** — PROHIBIDO importarlo desde un componente
  cliente (`"use client"`) o desde `container.ts` (que corre en el bundle browser). Solo lo importan
  las routes `app/api/a2a/*` (server). Así las `WASIAI_A2A_*` nunca se inlinean al browser (AC-7).
- **CD-A2A-11** (CD-15 mirror): sin `any`; toda response del gateway se estrecha con type-guards
  explícitos (`isRecord`/`Array.isArray`), espejo de `gateways.ts:42-77`.

---

## 10. Scope OUT / dependencias (no bloquean F3)

- **Aprovisionamiento de la Agent Key** (`WASIAI_A2A_AGENT_KEY`) en el marketplace `wasiai-a2a`:
  founder/ops-gated, **fuera de esta HU** (Missing #1). El código se implementa y testea íntegramente
  con el **gateway MOCKEADO**; el e2e real contra el gateway vivo es verificación posterior
  (runbook de provisioning: crear/fondear la key testnet/devnet, mismo patrón RUNBOOK-M5).
- Confirmación de los strings reales de `capability` contra el AgentCard: verificación e2e posterior
  (parametrizado por env hasta entonces, DT-A2A-2).
- `wasiai-a2a` (gateway) — SOLO LECTURA (CD-1).
- `/orchestrate` — descartado (DT-1).
- `gateways.ts` client-side (`A2a*Gateway`) — su contrato hacia el dominio NO cambia.
- WKH-233 (KYC vía agente) — hermana; el `gateway-client.ts` es reusable por ella (no vinculante).
- Settlement del principal (Base/Solana), EIP-3009 real, mainnet/dinero real — ortogonal/off.

---

## 11. Exemplars verificados (paths reales confirmados con Read)

| Para... | Exemplar (path real) |
|---------|----------------------|
| Route server-only con fail-closed opaco + timeout | `app/api/a2a/quote/route.ts` |
| Guard-order + forward block a modificar | `app/api/a2a/payout/submit/route.ts` (`L363-401`) |
| Type-guards sin `any` (shape defensivo) | `src/infrastructure/a2a/gateways.ts:42-77` |
| Wiring del flag en composition root | `src/composition/container.ts:71,84-85,89` |
| Test de route (stubEnv + stubGlobal fetch) | `app/api/a2a/quote/route.test.ts` |
| Test de guard byte-idéntico | `app/api/a2a/payout/guard8-intact.test.ts` |
| Doc de env server-only | `.env.example` (bloque `REMIT_AGENTS_BASE_URL`) |
| Contrato gateway `/discover` | `wasiai-a2a/src/routes/discover.ts:61-108` (SOLO lectura) |
| Contrato gateway `/compose` + unwrap | `wasiai-a2a/src/routes/compose.ts:337-356` + `src/services/compose.ts:939-940` (SOLO lectura) |
| Tipos gateway | `wasiai-a2a/src/types/index.ts:193-225,280-295,321-332,380-424` (SOLO lectura) |

---

## 12. Readiness Check

- [x] Contrato de `/discover` confirmado (body, response `DiscoveryResult`, sin auth).
- [x] Contrato de `/compose` confirmado (body, `ComposeStep`, auth `x-a2a-key`, máx 5 steps, response `ComposeResult`).
- [x] Shape de `Agent`/`DiscoveryResult`/`ComposeResult`/`StepResult` confirmado (§3) → tipado sin `any` (Missing #3 resuelto).
- [x] Wire fact del unwrap `data.result ?? data` confirmado (`compose.ts:940`) → extracción correcta (DT-A2A-6).
- [x] Slugs reales de los agentes confirmados vía fixtures vendoreadas (`remit-corridor-fx`/`remit-cashout-payout`).
- [x] Capabilities NO confirmables desde código → **parametrizadas por env** con fallback documentado (Missing #2 resuelto sin bloqueo).
- [x] Guard-order 1-8 de payout leído íntegro → estrategia de cambio SOLO-forward validada (CD-2/DT-5).
- [x] Punto de wiring del flag identificado (`container.ts`) → cambio inerte por default (AC-6/CD-6).
- [x] Naming de env/módulo fijado (Missing #4 resuelto).
- [x] Mapeo AC→wave→test completo (8 AC, ≥1 test c/u) incluyendo AC-4 fail-closed y byte-identidad.
- [x] Exemplars con path real (§11).
- [x] Auto-blindaje histórico incorporado (CD-A2A-9: gate estático `tsc`, no `next lint`).
- [x] Agent Key provisioning documentado como Scope OUT / dependencia e2e (Missing #1).
- [ ] **NEEDS CLARIFICATION**: ninguno bloqueante. (Los strings exactos de capability quedan
      resueltos por parametrización env; su confirmación es verificación e2e, no diseño.)

**Veredicto:** SDD LISTO para `SPEC_APPROVED`. Sin TBDs bloqueantes.
