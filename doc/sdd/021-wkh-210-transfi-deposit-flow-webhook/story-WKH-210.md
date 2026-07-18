# Story File — WKH-210 · Receptor de webhooks de TransFi sobre el ledger (WKH-207)

> Contrato autocontenido para el Dev (F3). **NO reabras el SDD** — todo lo que necesitás está acá.
> Fuente: `sdd.md` (SPEC_APPROVED) + `work-item.md`. Baseline al abrir: **36 test files / 460 tests
> verdes**, `npx tsc --noEmit` = 0. Gate de cada wave: `npm run qa` (= `npm run typecheck && npm run test`).

---

## 0. Contexto mínimo (leer una vez)

Una remesa que ya pagó el principal on-chain (`principal_in`) y forwardeó al agente `remit-cashout-payout`
(`submitted`) **no llega a estado terminal automático**: TransFi liquida el fiat async
(`asset_deposited → fund_settled` minutos después) y Chaski hoy solo se entera por el barrido
`reconcile-orphans`, que siempre degrada a `manual_review` (humano fuera de banda).

Esta HU cierra ese gap con **un endpoint nuevo, aislado y aditivo**: `POST /api/webhooks/transfi`.
Recibe el webhook de estado de TransFi, **verifica el HMAC (fail-closed)**, lo procesa
**idempotentemente** (claim-once) y actualiza la fila del ledger correlacionando por `payoutId`.

Es la mitad "recibir confirmación" del loop async. **NO** es el reorder no-custodial (`to=depositAddress`)
→ eso es **WKH-211** (otro ticket, otro SDD). **NO se diseña acá.**

Sandbox / Base Sepolia únicamente, cero plata real. Flags `NEXT_PUBLIC_EIP3009_ENABLED` /
`TRANSFI_ADAPTER_READY` **quedan OFF** en todos los entornos → el flujo demo/mock es **byte-idéntico** a
pre-HU (esta HU no toca `confirm-and-send.ts` ni `wallet.ts`).

---

## 1. Scope IN (lista exhaustiva de archivos a tocar)

| # | Archivo | Acción | Wave |
|---|---|---|---|
| 1 | `src/application/ports.ts` | +método `recordWebhookOutcome` en `SettlementLedger` | W0 |
| 2 | `src/infrastructure/persistence/supabase-settlement-ledger.ts` | +impl del método | W0 |
| 3 | `src/test-support/fakes.ts` | +impl en `FakeSettlementLedger` (cascada tsc, CD-11) | W0 |
| 4 | `src/infrastructure/webhooks/webhook-event-store.ts` | NUEVO (claim-once) | W0 |
| 5 | `src/infrastructure/webhooks/transfi-hmac.ts` | NUEVO (hmac/map/parse) | W0 |
| 6 | `app/api/webhooks/transfi/route.ts` | NUEVO (endpoint) | W1 |
| 7 | `app/api/webhooks/transfi/route.test.ts` | NUEVO | W2 |
| 8 | `src/infrastructure/webhooks/webhook-event-store.test.ts` | NUEVO | W2 |
| 9 | `src/infrastructure/webhooks/transfi-hmac.test.ts` | NUEVO | W2 |
| 10 | `src/infrastructure/persistence/supabase-settlement-ledger.test.ts` | +tests del método nuevo | W2 |
| 11 | `app/api/a2a/payout/submit/route.ts` (líneas 244-251) | **MNR-1: SOLO comentario** | W2 |
| 12 | `.env.example` | +`TRANSFI_WEBHOOK_SECRET` | W2 |

**Fuera de scope (NO tocar):** `wallet.ts`, `confirm-and-send.ts`, `settle/principal/route.ts` (S1-V9),
guards 1-8 de `payout/submit/route.ts` (salvo el comentario MNR-1), cualquier `PayoutOrderGateway`, el
reorder no-custodial (WKH-211), filas `manual_review`, encender los flags.

---

## 2. Anti-Hallucination Checklist (verificado por el Architect — usalo como verdad)

- ✅ `SettlementLedger` vive en `src/application/ports.ts:237-267`. Estados
  `SettlementLedgerStatus` = `principal_in | submitted | settled | failed | forward_error | manual_review`
  (`ports.ts:211-217`). Métodos actuales: `recordPrincipalIn`, `recordPayoutOutcome`, `listStale`,
  `markOutcome`. **Ninguno indexado por `payoutId` solo** → por eso el método nuevo.
- ✅ `SupabaseSettlementLedger`: `TABLE = "remittance_settlements"`
  (`supabase-settlement-ledger.ts:21`). `STALE_STATUSES = [principal_in, submitted, forward_error]`
  (`:28-32`) — **es el set NO-terminal, reusalo tal cual** (DT-2b). `markOutcome` usa
  `.update(patch).eq("id", …)` (`:167`). Factory `getSettlementLedger()` → `null` con flag OFF/envs
  ausentes (`:177-182`). El `error` en throws es un **enum estable con `error.code`**, NUNCA PII.
- ✅ `FakeSettlementLedger implements SettlementLedger` en `src/test-support/fakes.ts:409`. Store
  `Map<string, SettlementRecord>`. `recordPayoutOutcome` (`:448-465`) itera el store y mutá
  `status/payoutId/lastError/updatedAt` — **clonar ese estilo** (sin el owner-scoping).
- ✅ Claim-once exemplar EXACTO: `src/infrastructure/auth/pop-nonce-store.ts` (leído entero). Union
  `{ok:true} | {ok:false;alreadyUsed:true} | {ok:false;unavailable:true}`, `getRedis()` memoizado con
  env leída DENTRO, `redis.set(key,"1",{nx:true,ex})` → `"OK"`=primer uso / `!=="OK"`=replay /
  `catch|sin-cliente`=unavailable. `__resetPopNonceStore()`. TTL `86_400`.
- ✅ HMAC exemplar: `attestation.ts:36-38` (`createHmac("sha256", secret).update(x).digest(...)`),
  timing-safe `attestation.ts:68-73` / `reconcile-orphans/route.ts:22-29` (`safeEqual`: **longitud
  primero** — `timingSafeEqual` TIRA con buffers de distinto largo — luego `timingSafeEqual`).
  ⚠️ `attestation.ts` usa `digest("base64url")`; **TransFi usa `digest("hex")`** (spec confirmada).
- ✅ Fail-closed HTTP exemplar: `reconcile-orphans/route.ts:45-61` → secreto ausente **501**
  (`*_not_configured`), header ausente/mismatch **401** (`*_unauthorized`), `getSettlementLedger()===null`
  **501** (`*_not_enabled`). Todo leído en runtime.
- ✅ Header HMAC de TransFi: **`X-Transfi-Hmac-Hash`** (spec confirmada), HMAC-SHA256 hex sobre el
  **body crudo**.
- ⚠️ **NO confirmado en la spec** (→ parseo defensivo + `TODO(sandbox)`, NO inventar): el nombre del
  campo del order-id en el body del webhook y el eventId nativo. Ver W0.5.
- ✅ MNR-1 vive en `app/api/a2a/payout/submit/route.ts:244-251` (verificado, ver W2.5).
- ✅ `.env.example` **no** tiene `TRANSFI_WEBHOOK_SECRET` hoy (verificado con grep).

---

## 3. Constraint Directives (reglas VERIFICABLES — el CR/AR las va a chequear)

- **CD-1 — flags OFF**: PROHIBIDO encender `NEXT_PUBLIC_EIP3009_ENABLED` / `TRANSFI_ADAPTER_READY` en
  cualquier entorno. Verificable: `git diff` no toca esos flags en ningún `.env*`.
- **CD-2 — fail-closed en cascada**: sin `TRANSFI_WEBHOOK_SECRET` → **501 ANTES de leer el body**;
  firma ausente/inválida → **401 ANTES de parsear**. Verificable: en el test de AC-1, un spy de
  `req.text` **no debe ser llamado**.
- **CD-3 — no-PII / nunca el body crudo**: PROHIBIDO loguear o persistir `raw`/`body`/campos de
  beneficiario. Solo `payoutId` / `status` mapeado / `"transfi_fund_failed"` (enum) viajan al ledger.
  La respuesta nunca ecoa el payload. `lastError` es SIEMPRE un enum estable, jamás el `reason` crudo.
- **CD-4 — idempotencia atómica ANTES de mutar**: el `claimWebhookEventOnce` se llama **antes** de
  `recordWebhookOutcome`. Un 2º delivery del mismo evento NO re-muta. Verificable: test AC-3.
- **CD-5 — NO tocar guard-order settle/submit**: cero cambios de lógica en `settle/principal/route.ts`
  y guards 1-8 de `payout/submit/route.ts`. **El MNR-1 es SOLO comentario** (única excepción autorizada).
- **CD-11 — extensión de port = cascada en la MISMA wave (W0)**: agregar `recordWebhookOutcome` a la
  interfaz deja `tsc` rojo en `supabase-settlement-ledger.ts` Y `fakes.ts` hasta que ambos lo
  implementen. Se cierran los 3 en W0 o el gate de W0 no pasa. Ref: WKH-207 auto-blindaje#1.
- **CD-13 — asertar HTTP EXACTO**: los tests asertan el código exacto (501 / 401 / 400 / 200 / 503),
  NUNCA "≠200". Un fail-open parcial (501→cae a 401) pasaría desapercibido si solo asertás "no-200".
  Ref: WKH-207 auto-blindaje#3.
- **CD-12 — el método nuevo NO es owner-scoped**: `recordWebhookOutcome` NO recibe ni filtra por
  `senderAddress`. El guard es el HMAC. Documentalo en el JSDoc del método.

---

## 4. Waves

### W0 — Contratos + tipos + stores (SERIAL) · gate `npm run qa`

Los 3 primeros archivos van juntos: extender el port dispara la cascada tsc (CD-11).

#### W0.1 — `src/application/ports.ts` (dentro de `interface SettlementLedger`)

Agregar, con el JSDoc que documenta la exención de owner-scoping (CD-12):

```ts
// webhook TransFi (WKH-210): UPDATE por payout_id, NO owner-scoped (el guard es el HMAC del endpoint,
// CD-12). Solo aplica a filas NO-terminales (principal_in|submitted|forward_error): nunca reclasifica
// manual_review ni degrada un estado terminal (DT-2b). 0-match ⇒ no-op sin error (AC-8).
recordWebhookOutcome(input: {
  payoutId: string;
  status: SettlementLedgerStatus; // solo 'submitted' | 'settled' | 'failed' (post-mapeo)
  error?: string | null;          // enum estable, NUNCA el motivo crudo (DT-8/CD-3)
}): Promise<void>;
```

#### W0.2 — `src/infrastructure/persistence/supabase-settlement-ledger.ts`

Implementar en `SupabaseSettlementLedger` (patrón `markOutcome:167`, pero por `payout_id` + filtro
NON_TERMINAL). Reusar `STALE_STATUSES` como el set no-terminal:

```ts
async recordWebhookOutcome(input: {
  payoutId: string;
  status: SettlementLedgerStatus;
  error?: string | null;
}): Promise<void> {
  const patch: Record<string, unknown> = {
    status: input.status,
    updated_at: new Date().toISOString(),
  };
  if (input.error !== undefined) patch.last_error = input.error;
  const { error } = await this.client
    .from(TABLE)
    .update(patch)
    .eq("payout_id", input.payoutId)
    .in("status", STALE_STATUSES as unknown as string[]); // no-terminal set (DT-2b)
  if (error) throw new Error(`ledger_record_webhook_outcome_failed:${error.code ?? "unknown"}`);
}
```
Nota: este método NO lee columnas → **no aplica el `::text` de `value_minor`** (ese cast solo importa en
selects que traen `value_minor`; acá es un UPDATE puro). No agregues selects.

#### W0.3 — `src/test-support/fakes.ts` (`FakeSettlementLedger`)

Implementar clonando el estilo de `recordPayoutOutcome:448-465`, pero **matcheando por `payoutId` y
filtrando por NON_TERMINAL** (sin owner-scoping):

```ts
async recordWebhookOutcome(input: {
  payoutId: string;
  status: SettlementLedgerStatus;
  error?: string | null;
}): Promise<void> {
  const NON_TERMINAL: SettlementLedgerStatus[] = ["principal_in", "submitted", "forward_error"];
  for (const r of this.store.values()) {
    // NO owner-scoped (CD-12): correlaciona solo por payoutId. Filtro NON_TERMINAL = DT-2b:
    // nunca degrada un estado terminal ni reclasifica manual_review.
    if (r.payoutId === input.payoutId && NON_TERMINAL.includes(r.status)) {
      r.status = input.status;
      if (input.error !== undefined) r.lastError = input.error;
      r.updatedAt = this.nowIso;
    }
  }
}
```

#### W0.4 — `src/infrastructure/webhooks/webhook-event-store.ts` (NUEVO)

Clon EXACTO de `pop-nonce-store.ts` (leelo). Cambios: namespace `transfi:evt:${key}`, nombres
`WebhookEventClaim` / `claimWebhookEventOnce` / `__resetWebhookEventStore`. Contrato:

```ts
export type WebhookEventClaim =
  | { ok: true }
  | { ok: false; alreadyUsed: true }
  | { ok: false; unavailable: true };
// SET `transfi:evt:${key}` "1" NX EX 86_400 → "OK"=primer uso / !=="OK"=replay / catch|sin-cliente=unavailable.
export async function claimWebhookEventOnce(key: string): Promise<WebhookEventClaim>;
export function __resetWebhookEventStore(): void; // solo tests (CD-10)
```
- `getRedis()` memoizado con env (`UPSTASH_REDIS_REST_URL`/`TOKEN`) leída DENTRO (CD-10).
- Sin cliente → `{ok:false, unavailable:true}` (fail-closed). `catch` → idem. PROHIBIDO devolver
  `{ok:true}` en el catch (sería puerta al replay). Copiá la cabecera de comentario adaptada.

#### W0.5 — `src/infrastructure/webhooks/transfi-hmac.ts` (NUEVO)

```ts
// verifyTransfiHmac: HMAC-SHA256(raw).digest('hex') con TRANSFI_WEBHOOK_SECRET (leído DENTRO, CD-10);
// timing-safe (LONGITUD primero, patrón attestation.ts:68-73 / reconcile:22-29). Devuelve false ante
// secreto ausente, firma ausente o mismatch (fail-closed).
export function verifyTransfiHmac(raw: string, signature: string | null): boolean;

// mapTransfiStatus: 'asset_deposited'→'submitted', 'fund_settled'→'settled', 'fund_failed'→'failed';
// CUALQUIER otro (incl. 'initiated'/'expired'/desconocido) → null (AC-7/CD-7). NUNCA inferir terminal.
export function mapTransfiStatus(status: string): SettlementLedgerStatus | null;

// extractPayoutId: candidatos EN ORDEN orderId→id→transactionId→orderNumber (primer string no-vacío).
// DT-5. Marcá el bloque con:
//   // TODO(sandbox): confirmar el campo real del order-id contra un webhook real de TransFi
export function extractPayoutId(body: Record<string, unknown>): string | null;

// extractEventId: candidatos eventId→webhookId→deliveryId (string no-vacío); si ninguno →
// fallback composite `${payoutId}:${status}`. DT-6. Marcá con:
//   // TODO(sandbox): usar el eventId nativo de TransFi si el webhook real lo trae (dedup más preciso)
export function extractEventId(body: Record<string, unknown>, payoutId: string, status: string): string;
```
Podés exportar un tipo `TransfiWebhookFields` si te ayuda a tipar. `verifyTransfiHmac`: si
`signature == null` o `!secret` → `return false` (no tires). Computá `expected` hex, compará
timing-safe (Buffer, longitud primero). PROHIBIDO `JSON.parse`/re-serializar acá (recibe el raw string).

**Gate W0**: `npm run qa` verde (tsc 0, 460 tests siguen pasando — todavía sin tests nuevos).

---

### W1 — Endpoint (depende de W0) · gate `npm run qa`

#### W1.1 — `app/api/webhooks/transfi/route.ts` (NUEVO)

`export async function POST(req: Request): Promise<Response>` con el orden de guards EXACTO (DT-9). Usá
`NextResponse.json`. Todo env leído en runtime.

```
1. secret = process.env.TRANSFI_WEBHOOK_SECRET
   └─ ausente          → 501 { error: "webhook_not_configured" }   [ANTES de leer body — CD-2/AC-1]
2. raw = await req.text()                                          [UNA sola vez — CD-9/DT-4]
3. sig = req.headers.get("x-transfi-hmac-hash")
   └─ verifyTransfiHmac(raw, sig) === false → 401 { error: "webhook_unauthorized" } [CD-2/AC-2, sin parsear]
4. ledger = getSettlementLedger()
   └─ null             → 501 { error: "webhook_not_enabled" }      [DT-3/AC-10]
5. body = JSON.parse(raw)  (try/catch)
   └─ throw            → 400 { error: "webhook_bad_request" }
6. payoutId = extractPayoutId(body)
   status   = typeof body.status === "string" ? body.status : ""
   └─ !payoutId        → 200 { ok: true, ignored: "no_payout_id" } [AC-8b]
7. mapped = mapTransfiStatus(status)
   └─ mapped === null  → 200 { ok: true, ignored: "unmapped_status" } [AC-7/CD-7, SIN claim, SIN mutar]
8. try {  // MUTAR PRIMERO — at-least-once idempotente (FIX AR MNR-1, antes claim-before-mutate)
     await ledger.recordWebhookOutcome({
       payoutId, status: mapped,
       error: mapped === "failed" ? "transfi_fund_failed" : undefined, // DT-8, enum estable
     });
   } catch → 503 { error: "webhook_unavailable" }                  [DB throw, NUNCA 500; NO quema key]
9. eventKey = extractEventId(body, payoutId, status)
   await claimWebhookEventOnce(eventKey)                           [CD-4, DESPUÉS de mutar, best-effort]
   └─ resultado IGNORADO (alreadyUsed | unavailable | ok) → igual 200: el claim ya no gatea la mutación
10. return 200 { ok: true }
```
**Idempotencia at-least-once (FIX AR MNR-1)**: `recordWebhookOutcome` filtra por `STALE_STATUSES`
(`principal_in`/`submitted`/`forward_error`) ⇒ aplicar la misma transición N veces = 1 vez (la 2ª+ es
no-op) y jamás degrada un terminal. Por eso la mutación va **primero** y el claim **después**: si el
ledger tira, se devuelve 503 **sin quemar la key** ⇒ el retry de TransFi re-entrega el evento y lo
re-muta idempotentemente, sin perder la transición (el orden claim-antes-de-mutar la perdía: quemaba la
key, el retry veía `alreadyUsed` y respondía 200 dedupeado SIN re-mutar).
Import del ledger: `getSettlementLedger` desde
`../../../../src/infrastructure/persistence/supabase-settlement-ledger` (mismo estilo de path relativo
que `reconcile-orphans/route.ts:15`; confirmá el nº de `../` según la profundidad de
`app/api/webhooks/transfi/`). `claimWebhookEventOnce` + los helpers desde
`src/infrastructure/webhooks/…`.

**No-PII (CD-3)**: nada de `console.log(raw|body)`; la respuesta jamás ecoa el payload.

**Gate W1**: `npm run qa` verde.

---

### W2 — Tests + MNR-1 + docs (depende de W1; paralelizable entre sí) · gate `npm run qa`

Convención de tests de endpoint (leé `reconcile-orphans/route.test.ts` para el molde): `vi.hoisted` +
`vi.mock` del ledger factory, `FakeSettlementLedger`, `vi.stubEnv`, spy/mock de `claimWebhookEventOnce`,
`afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); })`. La firma HMAC de cada fixture se
computa con `createHmac("sha256", secret).update(RAW_STRING_EXACTO).digest("hex")` sobre el **mismo
string** que mandás como body.

#### W2.1 — `app/api/webhooks/transfi/route.test.ts` (NUEVO) — ≥1 test por AC (CD-13, asertar código exacto)

| AC | Escenario | Aserción clave |
|---|---|---|
| AC-1 | sin `TRANSFI_WEBHOOK_SECRET` → 501 `webhook_not_configured` | 501; **spy de `req.text` NO llamado** |
| AC-2 | firma ausente → 401; firma que no matchea → 401 | 401; `recordWebhookOutcome` NO llamado |
| AC-2 (crudo) | firma válida para el RAW exacto pasa; el mismo objeto re-serializado con otro spacing → 401 | prueba que NO se re-`JSON.stringify` (DT-4) |
| AC-3 | claim `alreadyUsed` → 200; la mutación YA se aplicó (idempotente por STALE filter) | 200; `recordWebhookOutcome` llamado 1×; fila `settled` (FIX AR MNR-1: at-least-once) |
| AC-4 | firma OK + `fund_settled` + payoutId existente → `settled` | fake.store: `settled` |
| AC-5 | firma OK + `fund_failed` → `failed`, `lastError:"transfi_fund_failed"` | enum estable; el `reason` crudo del payload NUNCA en el ledger |
| AC-6 | firma OK + `asset_deposited` → `submitted` | fake.store: `submitted` |
| AC-7 | firma OK + `status:"expired"` (y un valor basura) → 200 `unmapped_status` | 200; claim-once NO llamado; ledger NO mutado |
| AC-8 | firma OK + payoutId inexistente → 200, sin crear fila | 200; `fake.store.size` sin cambios |
| AC-8b | firma OK + body sin candidato de payoutId → 200 `no_payout_id` | 200; `recordWebhookOutcome` NO llamado |
| AC-9 | (transversal) ningún test observa raw/PII en ledger ni respuesta | fake.store: solo `payoutId/status/lastError-enum`; respuesta `{ok:true}` sin ecos |
| AC-10 | flag OFF (`getSettlementLedger()===null`) + firma válida → 501 `webhook_not_enabled` | 501 (DT-3) |
| AC-11 | fixtures chainId 84532 / sandbox; ningún `fetch` de red real | 100% mock |
| DT-2b | `asset_deposited` tardío sobre fila ya `settled` → no baja el status | fake.store sigue `settled` |
| best-effort | claim `unavailable` (Upstash caído) POST-mutación → 200 (la mutación ya se aplicó idempotente; dedup skippeado) | 200; `recordWebhookOutcome` SÍ llamado antes del claim |
| 503-b | `recordWebhookOutcome` rechaza (DB throw) → 503, NO 500 | 503 |
| 400 | firma válida + body no-JSON → 400 `webhook_bad_request` | 400 |

#### W2.2 — `src/infrastructure/webhooks/webhook-event-store.test.ts` (NUEVO)
Primer uso `ok:true`, replay `alreadyUsed`, sin envs Upstash `unavailable`, `catch`→`unavailable`.
`__resetWebhookEventStore()` entre stubs de env (sin esto `vi.stubEnv` no toma efecto tras la 1ª llamada).

#### W2.3 — `src/infrastructure/webhooks/transfi-hmac.test.ts` (NUEVO)
- `verifyTransfiHmac`: firma buena (hex sobre el raw exacto) → true; firma mala → false; `null` → false;
  sin secreto → false.
- `mapTransfiStatus`: los 3 conocidos → estados; `"initiated"`/`"expired"`/basura → `null`.
- `extractPayoutId`: cada candidato en orden gana; sin candidatos → `null`.
- `extractEventId`: con `eventId` nativo lo usa; sin ninguno → `${payoutId}:${status}`; dos status
  distintos NO colisionan.

#### W2.4 — `src/infrastructure/persistence/supabase-settlement-ledger.test.ts` (+tests del método nuevo)
Update por `payout_id`, filtro `.in("status", …)` con NON_TERMINAL, 0-match sin throw, error de supabase
→ throw con `ledger_record_webhook_outcome_failed:*`. **Mock supabase-js = thenable builder**
(WKH-207 auto-blindaje#2): el builder chainable debe ser `thenable` (`then(resolve){ resolve(result) }`);
NO `mockResolvedValue` sobre el builder.

#### W2.5 — `app/api/a2a/payout/submit/route.ts` líneas 244-251 · MNR-1 (SOLO comentario)
**Antes de editar: `Read` inmediato del bloque y copiá el `old_string` VERBATIM** (WKH-209
auto-blindaje#1: un `old_string` mal transcrito hace fallar el Edit). El bloque actual (líneas 244-251):

```
    // El gatillo real NO es "el día que haya dos redes" (ese era el encuadre equivocado del hallazgo
    // original): es REUSAR SETTLE_ATTESTATION_SECRET entre entornos. Preview en Fuji + prod en
    // mainnet con el MISMO secreto ⇒ una atestación emitida en Fuji con USDC de FAUCET (gratis)
    // valida el HMAC en mainnet y ata monto (A6), pagador (A7) y quote (A7′) sin objeción ⇒ payout
    // REAL de $400 por $0. Pasa con UNA SOLA cadena ⇒ es un error de ops, no un ítem de roadmap.
    // CD-9: se compara contra la env SERVER-SIDE. PROHIBIDO un chainId del body: un campo del caller
    // sería exactamente el binding falso que este guard mata.
    // Sin try/catch: resolveChainId() no tira (chain.ts:9-13 hace fallback a 43114), a diferencia de
```
Reemplazá **solo la terminología Avalanche stale** por Base, **sin cambiar el sentido ni una línea de
lógica** (`if (att.chainId !== resolveChainId())` intacto):
- "Preview en Fuji + prod en mainnet" → "Preview en Base Sepolia (84532) + prod en Base mainnet (8453)".
- "emitida en Fuji con USDC de FAUCET" → "emitida en Base Sepolia con USDC de FAUCET".
- "fallback a 43114" → "fallback a 84532" (línea 251; afirmación funcional "no tira" sigue verdadera).

Verificá que `chain.ts` efectivamente hace fallback a `84532` antes de escribir ese número; si el
fallback real difiere, dejá el número real y anotá `[SDD-GAP]` — no inventes. Cero cambios de lógica/guard.

#### W2.6 — `.env.example`
Agregar `TRANSFI_WEBHOOK_SECRET` (server-only, **SIN** `NEXT_PUBLIC_`), con comentario breve: secreto del
webhook de TransFi para verificar el HMAC entrante; ausente ⇒ el endpoint responde 501 (fail-closed).

**Gate W2**: `npm run qa` verde. Conteo esperado: **460 + (tus tests nuevos)**, tsc 0.

---

## 5. Auto-blindaje (obligatorio antes de declarar DONE)

1. **`grep -rn MUTANT app/ src/` = 0** al cerrar (tras revertir todos los mutantes de prueba).
2. **Mutation self-check** — montá cada mutante, corré los tests, confirmá que **mata ≥1 test**,
   revertí:
   - **(a) HMAC sobre body crudo**: en `route.ts` cambiá el `verifyTransfiHmac(raw,…)` por firmar sobre
     `JSON.stringify(JSON.parse(raw))` → el test AC-2(crudo) debe **fallar** (401 donde esperaba 200, o
     viceversa). Revertí.
   - **(b) fail-closed sin secreto**: hacé que `secret` ausente caiga a 401 (o a 200) en vez de 501 → el
     test AC-1 debe **fallar** por código exacto (CD-13). Revertí.
   - **(c) idempotencia**: comentá el `claimWebhookEventOnce` / dejá pasar el 2º delivery → el test AC-3
     debe **fallar** (`recordWebhookOutcome` llamado 2 veces). Revertí.
3. **Response mocks**: si mockeás `NextResponse`/globals de fetch, usá `mockImplementation`, **no
   `mockResolvedValue`** para devolver una `Response` (WKH-207: `mockResolvedValue` no reconstruye el
   objeto correctamente en todas las ramas).
4. **Mock supabase = thenable builder** (WKH-207 auto-blindaje#2), no `mockResolvedValue` sobre el
   builder chainable.
5. **Conteo de tests ejecutando**: baseline actual del repo = **36 files / 460 tests** (verificado por el
   Architect con `npx vitest run`). Confirmá que tras la HU el total sube por tus tests nuevos y que
   **ningún baseline se rompió**. Corré `npx tsc --noEmit` completo (no solo `npm run build`, que excluye
   tests) — lección WKH-196.
6. Escribí `doc/sdd/021-wkh-210-transfi-deposit-flow-webhook/auto-blindaje.md` con los mutantes probados.

---

## 6. Done Definition

- [ ] W0/W1/W2 completas; `npm run qa` verde (tsc 0 + todos los tests, baseline 460 + nuevos, ninguno roto).
- [ ] `recordWebhookOutcome` en interfaz + impl Supabase + `FakeSettlementLedger` (cascada CD-11 cerrada).
- [ ] `webhook-event-store.ts` (claim-once fail-closed) + `transfi-hmac.ts` (hmac hex/map/parse defensivo
      con los 2 `TODO(sandbox)`).
- [ ] `route.ts` con el orden de guards DT-9 y los códigos HTTP exactos (501/401/501/400/200/503).
- [ ] ≥1 test por AC-1..11 + DT-2b + los 3 códigos extra (503-a, 503-b, 400), asertando código exacto.
- [ ] MNR-1 aplicado (SOLO comentario, líneas 244-251) con `old_string` verbatim; guard `att.chainId`
      intacto.
- [ ] `.env.example` con `TRANSFI_WEBHOOK_SECRET`.
- [ ] CD-1 (flags OFF), CD-3 (no-PII), CD-5 (guards intactos) verificables en el `git diff`.
- [ ] Auto-blindaje: `grep MUTANT`=0, 3 mutantes probados+revertidos, doc escrito.
- [ ] Flujo demo byte-idéntico (esta HU no toca `confirm-and-send.ts` / `wallet.ts` / `settle`).
```
