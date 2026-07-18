# SDD — [WKH-210] Receptor de webhooks de TransFi sobre el ledger de WKH-207

> F2 (QUALITY, full). Input: `work-item.md` (11 ACs, DT-1..6, CD-1..8) +
> `wasiai-remittance-agents/doc/transfi-offramp-api-spec.md` (sección Webhooks).
> **Split ya decidido en el gate (HU_APPROVED)**: esta HU = SOLO el webhook receiver. El reorder
> no-custodial (`to=depositAddress`) es WKH-211 (otro ticket, otro SDD) — NO se diseña acá (CD-6).

---

## 1. Contexto

Hoy una remesa que ya pagó el principal on-chain (`principal_in` en el ledger de WKH-207) y ya
forwardeó al agente `remit-cashout-payout` (`submitted`) **no llega a un estado terminal automático**:
TransFi liquida el fiat de forma **asíncrona** (`asset_deposited → fund_settled` minutos después) y
Chaski no tiene forma de enterarse salvo el barrido `reconcile-orphans`, que SIEMPRE degrada a
`manual_review` (un humano fuera de banda). Esta HU cierra ese gap con un **endpoint nuevo, aislado y
aditivo** (`app/api/webhooks/transfi/route.ts`) que recibe los webhooks de estado de TransFi,
verifica su firma HMAC (fail-closed), los procesa de forma idempotente y actualiza la fila del ledger
correlacionando por `payoutId`.

Es la mitad "recibir confirmación" del loop async. La mitad "enviar directo sin custodia" (reorder)
queda fuera (WKH-211). El endpoint es un **consumidor de una firma AJENA** (verifica el HMAC que
TransFi emite sobre su propio payload) — la operación inversa de `attestation.ts` (que EMITE nuestra
propia firma). Sandbox / Base Sepolia únicamente, cero plata real (CD-8/AC-11).

---

## 2. Context Map (archivos leídos — verificados con Read)

| Archivo:línea | Por qué | Qué patrón extraje |
|---|---|---|
| `src/infrastructure/settlement/attestation.ts:12,36-38,68-73` | HMAC propio (`createHmac`/`timingSafeEqual`), secreto leído DENTRO de la función | Verificación timing-safe: **longitud primero** (timingSafeEqual TIRA con buffers de distinto largo), luego `timingSafeEqual`. `node:crypto`, NO jose/jwt. |
| `src/infrastructure/settlement/attestation-store.ts:16-67` | claim-once `SET NX EX` sobre Upstash, fail-CLOSED | Cliente memoizado, env leída DENTRO (`getRedis()`), `set(key,"1",{nx:true,ex})` → `"OK"`=primer uso / `null`=replay / `catch`=`unavailable`. `__reset*()` para tests. |
| `src/infrastructure/auth/pop-nonce-store.ts:16-64` | gemelo de attestation-store (mismo patrón claim-once) | Union type `{ok:true} \| {ok:false,alreadyUsed:true} \| {ok:false,unavailable:true}`. TTL 86_400. Namespace por prefijo (`pop:nonce:${nonce}`). |
| `app/api/admin/reconcile-orphans/route.ts:13-61` | auth fail-closed + ledger flag-gated | secreto ausente → **501** (`*_not_configured`); mismatch/ausente → **401**; `getSettlementLedger()===null` → **501** (`*_not_enabled`); `safeEqual()` local (patrón attestation:68-73). Todo leído en runtime. |
| `app/api/admin/reconcile-orphans/route.test.ts` | convención de tests de endpoint | `vi.hoisted` + `vi.mock` del ledger factory; `FakeSettlementLedger`; `vi.stubEnv`; `afterEach` con `vi.unstubAllEnvs/Globals`; **asertar el código EXACTO** (501 vs 401). |
| `src/application/ports.ts:205-267` | interfaz `SettlementLedger` + `SettlementLedgerStatus` | Estados: `principal_in\|submitted\|settled\|failed\|forward_error\|manual_review`. Métodos existentes: `recordPrincipalIn`, `recordPayoutOutcome`, `listStale`, `markOutcome`. **Ninguno indexado por `payoutId` solo** → hace falta el método nuevo (DT-2). |
| `src/infrastructure/persistence/supabase-settlement-ledger.ts:21-182` | impl del ledger + factory | `TABLE="remittance_settlements"`; `markOutcome` = `.update(patch).eq("id",...)`; `getSettlementLedger()`=null con flag OFF/envs ausentes; `error` en throws es enum estable, NUNCA PII. `STALE_STATUSES=[principal_in,submitted,forward_error]`. |
| `src/test-support/fakes.ts:409-465` | `FakeSettlementLedger implements SettlementLedger` | **Agregar un método a la interfaz obliga a implementarlo también acá** (o `tsc` rojo). Store `Map<string,SettlementRecord>`. |
| `app/api/a2a/payout/submit/route.ts:240-255` | MNR-1 (comentario stale) | Líneas 244-248/251 mencionan "Preview en Fuji + prod en mainnet" / "fallback a 43114" — terminología Avalanche stale desde WKH-209 (Base). Comentario únicamente. |
| `wasiai-remittance-agents/doc/transfi-offramp-api-spec.md:42-45` | contrato del webhook de TransFi | **Header `X-Transfi-Hmac-Hash` CONFIRMADO**; HMAC-SHA256 sobre body CRUDO con el webhook secret, **`digest('hex')`** CONFIRMADO; estados `initiated → asset_deposited → fund_settled / fund_failed / expired`, campo `status`, `entityType:"order"`. **Nombre del campo del order-id en el body: NO CONFIRMADO** (el status GET es `/v3/orders/{orderId}`). |

**Exemplars verificados con Glob/Read** (todos existen, paths reales): `attestation.ts`,
`attestation-store.ts`, `pop-nonce-store.ts`, `reconcile-orphans/route.ts` (+ `.test.ts`),
`supabase-settlement-ledger.ts`, `ports.ts`, `test-support/fakes.ts`, `payout/submit/route.ts`.

---

## 3. Decisiones técnicas (DT-N)

- **DT-1 (heredada del work-item — SPLIT confirmado)**: el reorder no-custodial queda en WKH-211. Esta
  HU NO toca `wallet.ts`, ni el orden de `confirm-and-send.ts`, ni el guard S1-V9 de
  `settle/principal/route.ts`. Cerrado por gate — no se reabre.

- **DT-2 — Método nuevo del ledger indexado por `payoutId`**: se agrega
  `recordWebhookOutcome({ payoutId, status, error? })` a `SettlementLedger`. El webhook de TransFi
  **no conoce** `idempotencyKey` ni `senderAddress` (los que scope-an `recordPayoutOutcome`), solo su
  propio `payoutId`/`orderId`. El guard de autenticación (HMAC) **reemplaza** al ownership-scoping
  (CD-9 no aplica: el caller es TransFi vía HMAC, no un browser de usuario). La impl es
  `.update(patch).eq("payout_id", payoutId).in("status", NON_TERMINAL)` — patrón `markOutcome`
  (línea 167) pero por `payout_id`.

- **DT-2b — Filtro `.in("status", NON_TERMINAL)` como backstop de robustez**: el UPDATE solo aplica a
  filas cuyo status ∈ `[principal_in, submitted, forward_error]` (= `STALE_STATUSES` ya definido,
  `supabase-settlement-ledger.ts:28`). Esto logra tres cosas de una:
  1. **Scope OUT del work-item**: nunca reclasifica una fila ya en `manual_review`.
  2. **No-downgrade / out-of-order**: un `asset_deposited` que llega TARDE (después de `fund_settled`)
     no baja una fila `settled`→`submitted` (el status ya es terminal, fuera del set).
  3. **Backstop de idempotencia** además del claim-once: un `fund_settled` redeliverado sobre una fila
     ya `settled` no matchea → no-op silencioso.
  Un UPDATE que matchea 0 filas en supabase-js **no es error** → satisface AC-8 (`payoutId` inexistente
  → 200 ACK, sin crear fila) por construcción.

- **DT-3 — Ledger OFF ⇒ 501** (resuelve el `[NEEDS CLARIFICATION]` no-bloqueante #3 del work-item).
  Cuando `getSettlementLedger()===null` (flag `SETTLEMENT_LEDGER_ENABLED`≠"true" O envs Supabase
  ausentes), el endpoint responde **501** (`webhook_not_enabled`), idéntico a
  `reconcile-orphans/route.ts:59-61`. **Justificación**: (a) consistencia con TODOS los endpoints
  system/admin de este repo (reconcile devuelve 501, no 200-noop); (b) fail-loud honesto — un 200 con
  ledger OFF mentiría a TransFi ("recibido y procesado") mientras nada se persiste, ocultando drift de
  config (riesgo BAJA de la tabla del work-item); (c) TransFi reintenta ante 501, así que cuando el
  flag se encienda el webhook eventualmente se procesa (no se pierde). Con el flag OFF en todos los
  entornos compartidos (default, CD-1/AC-10) el endpoint es un no-op fail-loud → byte-idéntico.

- **DT-4 — HMAC sobre el body CRUDO, `digest('hex')`, header `X-Transfi-Hmac-Hash`** (CONFIRMADO en la
  spec, línea 44). El handler lee `const raw = await req.text()` **una sola vez**, computa
  `createHmac("sha256", secret).update(raw).digest("hex")`, compara **timing-safe** (longitud primero,
  patrón attestation:68-73) contra el header, y **recién entonces** `JSON.parse(raw)`. PROHIBIDO
  `JSON.parse` → re-`JSON.stringify` para el HMAC: rompería la firma (whitespace/orden de claves).

- **DT-5 — Correlación por `payoutId`: parseo DEFENSIVO por candidatos + `TODO(sandbox)`**
  (resuelve el `[NEEDS CLARIFICATION]` no-bloqueante #4). La spec NO fija el nombre del campo del
  order-id en el **body del webhook** (solo que el status GET es `/v3/orders/{orderId}`). Igual que
  WKH-208 hizo parseo defensivo, `route.ts` extrae el order-id probando candidatos EN ORDEN:
  `orderId → id → transactionId → orderNumber`. El primero que sea string no-vacío gana. Marcá el
  bloque con `// TODO(sandbox): confirmar el campo real del order-id contra un webhook real de TransFi`.
  Ese order-id es nuestro `payoutId` (el que `remit-cashout-payout`/WKH-208 devolvió y persistimos).

- **DT-6 — `eventId` para idempotencia: candidatos + fallback composite `${payoutId}:${status}`**.
  La spec NO documenta un `eventId` de webhook. `route.ts` extrae el event-id probando
  `eventId → webhookId → deliveryId` (string no-vacío). **Si ninguno existe**, usa la clave composite
  `${payoutId}:${status}` como idempotency key. Esto es CORRECTO: dedup-ea replays de la MISMA
  transición (TransFi reintenta agresivamente) pero permite transiciones DISTINTAS del mismo order
  (`asset_deposited` y luego `fund_settled` NO colisionan porque el `status` difiere). Marcá
  `// TODO(sandbox): usar el eventId nativo de TransFi si el webhook real lo trae (dedup más preciso)`.

- **DT-7 — Mapeo de status (DT-5 del work-item)**: `asset_deposited → submitted`,
  `fund_settled → settled`, `fund_failed → failed`. Cualquier otro (`initiated`, `expired`, o valor
  desconocido) → **no-op + ACK 200** (AC-7/CD-7), NUNCA inferir un estado terminal de un valor no
  reconocido explícitamente. `mapTransfiStatus()` devuelve `SettlementLedgerStatus | null` (null = no
  mapeable).

- **DT-8 — `lastError` como enum estable, NUNCA el motivo crudo** (CD-3/AC-5/AC-9). Un
  `fund_failed` persiste `error: "transfi_fund_failed"` (constante). El `reason`/mensaje del payload de
  TransFi (posible PII o texto libre) NUNCA se lee para el ledger ni se loguea. Los demás mapeos
  (`submitted`/`settled`) no setean `error`.

- **DT-9 — Fail-closed en cascada, orden de guards estricto**: secreto ausente → 501 ANTES de leer el
  body (CD-2); firma inválida → 401 ANTES de parsear el body (CD-2); ledger OFF → 501; JSON inválido →
  400; status no mapeable → 200 no-op (sin claim, sin mutar); mutar PRIMERO, claim-once DESPUÉS
  best-effort (CD-4, FIX AR MNR-1 = at-least-once idempotente; el orden claim-antes-de-mutar producía
  lost-update); DB throw → 503 (no 500) SIN quemar la key ⇒ retry re-muta; Upstash caído en el claim
  post-mutación → igual 200 (best-effort). Éxito → 200.

---

## 4. Constraint Directives (CD-N)

Heredadas del work-item **CD-1..CD-8** (todas vigentes, no se relajan). Se agregan del SDD:

- **CD-9 (SDD) — Body crudo leído UNA vez, HMAC antes de parsear**: `req.text()` se llama exactamente
  una vez; el `JSON.parse` ocurre DESPUÉS del check HMAC. PROHIBIDO `req.json()` (consume el stream y
  pierde el crudo) o re-serializar para firmar (DT-4).
- **CD-10 (SDD) — Env leída DENTRO de la función en runtime** (`TRANSFI_WEBHOOK_SECRET`,
  Upstash, `SETTLEMENT_LEDGER_ENABLED`): patrón atestation:29-34 / pop-nonce:28-35. En top-level
  `vi.stubEnv` no toma efecto → tests flaky. Recurrente en este repo (WKH-168/206/207 auto-blindajes).
- **CD-11 (SDD) — Extender el port fuerza impl + fake en la MISMA wave (W0)**: agregar
  `recordWebhookOutcome` a `SettlementLedger` deja `tsc` rojo en `supabase-settlement-ledger.ts` Y en
  `test-support/fakes.ts` hasta que ambos lo implementen. Se cierran los tres en W0 o el gate de W0 no
  pasa. **Referencia: WKH-207 auto-blindaje#1 (2026-07-16, error recurrente de extensión de port).**
- **CD-12 (SDD) — El nuevo método NO es owner-scoped**: `recordWebhookOutcome` NO recibe ni filtra por
  `senderAddress` (a diferencia de `recordPayoutOutcome`). El guard es el HMAC del endpoint. Documentar
  esta excepción en el JSDoc del método (igual que `listStale`/`markOutcome` documentan su exención de
  CD-9-ownership por ser admin).
- **CD-13 (SDD) — Tests asertan el código HTTP EXACTO** (501 vs 401 vs 400 vs 200 vs 503), nunca
  "no-200". Un fail-open parcial (ej. 501→cae a 401) pasaría desapercibido si solo se asertara
  "≠200". **Referencia: WKH-207 auto-blindaje#3 (2026-07-16).**

---

## 5. Waves de implementación

### W0 — Contratos + tipos + stores (SERIAL, gate: `npm run qa` verde / `tsc` 0)

Extender el port fuerza la cascada impl+fake en el MISMO commit (CD-11) — por eso van juntos en W0.

- **W0.1** `src/application/ports.ts` — agregar `recordWebhookOutcome(...)` a la interfaz
  `SettlementLedger` (contrato en §6.1). JSDoc: indexado por `payoutId`, NO owner-scoped (CD-12), auth =
  HMAC del endpoint.
- **W0.2** `src/infrastructure/persistence/supabase-settlement-ledger.ts` — implementar
  `recordWebhookOutcome` en `SupabaseSettlementLedger` (patrón `markOutcome`, pero
  `.eq("payout_id", …).in("status", NON_TERMINAL)`; reusar `STALE_STATUSES` como el set no-terminal).
- **W0.3** `src/test-support/fakes.ts` — implementar `recordWebhookOutcome` en `FakeSettlementLedger`
  (iterar el store; matchear `payoutId` && `NON_TERMINAL.includes(status)`; setear `status`/`lastError`/
  `updatedAt`).
- **W0.4** `src/infrastructure/webhooks/webhook-event-store.ts` (NUEVO) — claim-once `SET NX EX` sobre
  Upstash, clon de `pop-nonce-store.ts`. Namespace `transfi:evt:${key}`. Union type
  `WebhookEventClaim`. `__resetWebhookEventStore()` para tests.
- **W0.5** `src/infrastructure/webhooks/transfi-hmac.ts` (NUEVO) — `verifyTransfiHmac(raw, signature)`
  (HMAC-SHA256 hex + timing-safe), `mapTransfiStatus(status): SettlementLedgerStatus | null`, y los
  helpers de parseo defensivo `extractPayoutId(body)` / `extractEventId(body, payoutId, status)`.
  Tipos: `TransfiWebhookFields`.

### W1 — Endpoint (depende de W0)

- **W1.1** `app/api/webhooks/transfi/route.ts` (NUEVO) — `POST` handler con el orden de guards de DT-9
  (contrato en §6.2). Consume W0.4 (claim-once), W0.5 (hmac/map/parse), `getSettlementLedger()`.

### W2 — Tests + MNR-1 + docs (depende de W1; paralelizable entre sí)

- **W2.1** `app/api/webhooks/transfi/route.test.ts` (NUEVO) — ≥1 test por AC-1..AC-11 (§7).
- **W2.2** `src/infrastructure/webhooks/webhook-event-store.test.ts` (NUEVO) — claim-once: primer uso
  ok, replay `alreadyUsed`, Upstash ausente/caído `unavailable`.
- **W2.3** `src/infrastructure/webhooks/transfi-hmac.test.ts` (NUEVO) — HMAC sobre body crudo
  (firma buena/mala/ausente), `mapTransfiStatus` (3 conocidos + desconocidos → null), parseo defensivo
  de candidatos.
- **W2.4** `src/infrastructure/persistence/supabase-settlement-ledger.test.ts` — tests del método nuevo
  (update por `payout_id`, filtro `NON_TERMINAL`, 0-match sin error). Mock supabase-js **thenable
  builder** (WKH-207 auto-blindaje#2).
- **W2.5** `app/api/a2a/payout/submit/route.ts:244-248` — **MNR-1**: reemplazar la prosa "Preview en
  Fuji + prod en mainnet con el MISMO secreto…" por terminología Base (Sepolia 84532 / mainnet 8453).
  **SOLO comentario, CERO cambio de lógica/guard** (CD-5 exceptúa comentarios; esta es la HU autorizada
  a barrerlo). Copiar el `old_string` VERBATIM del Read inmediato (WKH-209 auto-blindaje#1).
  Nota: la línea 251 (`fallback a 43114`) es prosa cuya afirmación funcional ("no tira") sigue siendo
  verdadera pero menciona el chainId viejo — barrerla también a `84532` en el mismo Edit (bajo riesgo).
- **W2.6** `.env.example` — documentar `TRANSFI_WEBHOOK_SECRET` (server-only, SIN `NEXT_PUBLIC_`).

---

## 6. Contratos exactos

### 6.1 — Método nuevo del ledger (`SettlementLedger`)

```ts
// src/application/ports.ts — dentro de la interfaz SettlementLedger
// webhook TransFi (WKH-210): UPDATE por payout_id, NO owner-scoped (el guard es el HMAC del endpoint,
// CD-12). Solo aplica a filas NO-terminales (principal_in|submitted|forward_error): nunca reclasifica
// manual_review ni degrada un estado terminal (DT-2b). 0-match ⇒ no-op sin error (AC-8).
recordWebhookOutcome(input: {
  payoutId: string;
  status: SettlementLedgerStatus; // solo 'submitted' | 'settled' | 'failed' (post-mapeo)
  error?: string | null;          // enum estable, NUNCA el motivo crudo (DT-8/CD-3)
}): Promise<void>;
```

Impl (Supabase):
```ts
async recordWebhookOutcome(input): Promise<void> {
  const patch: Record<string, unknown> = { status: input.status, updated_at: new Date().toISOString() };
  if (input.error !== undefined) patch.last_error = input.error;
  const { error } = await this.client
    .from(TABLE)
    .update(patch)
    .eq("payout_id", input.payoutId)
    .in("status", STALE_STATUSES as unknown as string[]); // no-terminal set (DT-2b)
  if (error) throw new Error(`ledger_record_webhook_outcome_failed:${error.code ?? "unknown"}`);
}
```

### 6.2 — Endpoint `POST /api/webhooks/transfi` (orden de guards = DT-9)

```
1. secret = process.env.TRANSFI_WEBHOOK_SECRET (runtime, CD-10)
   └─ ausente          → 501 { error: "webhook_not_configured" }   [ANTES de leer body, CD-2/AC-1]
2. raw = await req.text()                                          [una sola vez, CD-9/DT-4]
3. sig = req.headers.get("x-transfi-hmac-hash")
   └─ verifyTransfiHmac(raw, sig) === false → 401 { error: "webhook_unauthorized" } [CD-2/AC-2, sin parsear]
4. ledger = getSettlementLedger()
   └─ null             → 501 { error: "webhook_not_enabled" }      [DT-3/AC-10]
5. body = JSON.parse(raw)  (try/catch)
   └─ throw            → 400 { error: "webhook_bad_request" }      [firma buena pero payload no-JSON]
6. payoutId = extractPayoutId(body)                                [DT-5, defensivo]
   status   = typeof body.status === "string" ? body.status : ""
   └─ !payoutId        → 200 { ok: true, ignored: "no_payout_id" } [no se puede correlacionar, AC-8]
7. mapped = mapTransfiStatus(status)                               [DT-7]
   └─ mapped === null  → 200 { ok: true, ignored: "unmapped_status" } [AC-7/CD-7, SIN claim, SIN mutar]
8. try {  // MUTAR PRIMERO — at-least-once idempotente (FIX AR MNR-1, antes claim-before-mutate)
     await ledger.recordWebhookOutcome({
       payoutId, status: mapped,
       error: mapped === "failed" ? "transfi_fund_failed" : undefined, // DT-8, enum estable
     });
   } catch → 503 { error: "webhook_unavailable" }                  [DB throw, NUNCA 500; NO quema key]
9. eventKey = extractEventId(body, payoutId, status)              [DT-6]
   await claimWebhookEventOnce(eventKey)                           [CD-4, DESPUÉS de mutar, best-effort]
   └─ resultado IGNORADO (alreadyUsed | unavailable | ok) → igual 200 [AC-3; el claim ya no gatea]
10. return 200 { ok: true }                                        [AC-4/5/6]
```
**FIX AR MNR-1 (at-least-once idempotente)**: `recordWebhookOutcome` filtra por `STALE_STATUSES` ⇒
aplicar la misma transición N veces = 1 vez (2ª+ = no-op) y nunca degrada un terminal. Mutar primero +
claim después ⇒ un DB-throw devuelve 503 **sin quemar la key**, así el retry de TransFi re-muta
idempotentemente (el orden claim-antes-de-mutar quemaba la key y el retry veía `alreadyUsed` → 200
dedupeado SIN re-mutar = lost-update de la transición).

**No-PII (CD-3/AC-9)**: en NINGÚN punto se loguea ni persiste `raw`, `body`, ni campos de
beneficiario. Solo `payoutId` / `mapped` / `"transfi_fund_failed"` viajan al ledger. La respuesta
nunca ecoa el payload.

### 6.3 — `transfi-hmac.ts` (helpers)

```ts
// verifyTransfiHmac: HMAC-SHA256(raw, secret).digest('hex'), timing-safe (longitud primero). CD-10:
// secret leído dentro. Devuelve false ante secreto/firma ausente o mismatch (fail-closed).
export function verifyTransfiHmac(raw: string, signature: string | null): boolean;

// mapTransfiStatus: 'asset_deposited'→'submitted', 'fund_settled'→'settled', 'fund_failed'→'failed';
// cualquier otro (incl. 'initiated'/'expired') → null (AC-7/CD-7). NUNCA inferir terminal de desconocido.
export function mapTransfiStatus(status: string): SettlementLedgerStatus | null;

// extractPayoutId: candidatos en orden orderId→id→transactionId→orderNumber (string no-vacío). DT-5.
export function extractPayoutId(body: Record<string, unknown>): string | null;

// extractEventId: eventId→webhookId→deliveryId; fallback `${payoutId}:${status}`. DT-6.
export function extractEventId(body: Record<string, unknown>, payoutId: string, status: string): string;
```

### 6.4 — `webhook-event-store.ts` (claim-once, clon de pop-nonce-store)

```ts
export type WebhookEventClaim =
  | { ok: true }
  | { ok: false; alreadyUsed: true }
  | { ok: false; unavailable: true };
// SET `transfi:evt:${key}` "1" NX EX 86_400 → "OK"=primer uso / null=replay / catch|sin-cliente=unavailable.
export async function claimWebhookEventOnce(key: string): Promise<WebhookEventClaim>;
export function __resetWebhookEventStore(): void; // solo tests (CD-10)
```

---

## 7. Plan de tests (≥1 por AC, TODO mockeado — CD-8/AC-11, sin sandbox real ni send)

Convención: `vi.hoisted`+`vi.mock` del ledger factory, `FakeSettlementLedger`, `vi.stubEnv`, spy de
Upstash/claim-once, `afterEach(vi.unstubAllEnvs/Globals)`. **Asertar el código EXACTO** (CD-13). Firma
HMAC de fixtures computada con `createHmac` sobre el string crudo EXACTO que se envía como body.

| AC | Test | Aserción |
|---|---|---|
| AC-1 | sin `TRANSFI_WEBHOOK_SECRET` → 501 `webhook_not_configured` | status 501; **spy de `req.text` NO llamado** (body no leído) |
| AC-2 | secreto set + firma ausente → 401; + firma que no matchea → 401 | status 401; ledger.recordWebhookOutcome NO llamado |
| AC-2 (crudo) | HMAC sobre el body **CRUDO**: firma válida para el string exacto pasa; el mismo objeto re-serializado con otro spacing → 401 | prueba que NO se re-`JSON.stringify` antes de firmar (DT-4) |
| AC-3 | eventId ya reclamado (claim `alreadyUsed`) → 200; la mutación YA se aplicó (idempotente por STALE filter) | status 200 `{ok:true}`; recordWebhookOutcome llamado 1×; fila `settled` (FIX AR MNR-1: at-least-once) |
| AC-4 | firma OK + `fund_settled` + payoutId existente → fila `settled` | fake.store: status `settled`; recordWebhookOutcome llamado con `{status:"settled"}` |
| AC-5 | firma OK + `fund_failed` → fila `failed` con `lastError:"transfi_fund_failed"` | enum estable; **el `reason` crudo del payload NUNCA aparece en el ledger** |
| AC-6 | firma OK + `asset_deposited` → fila `submitted` | fake.store: status `submitted` |
| AC-7 | firma OK + `status:"expired"` (y un valor basura) → 200 `unmapped_status`, sin claim, sin mutar | status 200; claim-once NO llamado; recordWebhookOutcome NO llamado |
| AC-8 | firma OK + payoutId inexistente en el ledger → 200, sin crear fila | status 200; fake.store.size sin cambios (UPDATE 0-match) |
| AC-8b | firma OK + body sin ningún candidato de payoutId → 200 `no_payout_id` | status 200; recordWebhookOutcome NO llamado |
| AC-9 | (transversal) ningún test observa el `raw`/PII en el ledger ni en la respuesta | fake.store: solo `payoutId/status/lastError-enum`; respuesta = `{ok:true}` sin ecos |
| AC-10 | flag OFF (`getSettlementLedger()===null`) con firma válida → 501 `webhook_not_enabled` | status 501 (DT-3) |
| AC-11 | fixtures usan chainId 84532 / sandbox; ningún fetch a red real | (implícito: 100% mock, sin `fetch` de red) |
| DT-2b | `asset_deposited` tardío sobre fila ya `settled` → no baja el status (filtro NON_TERMINAL) | fake.store: sigue `settled` |
| DT-3/503 | claim-once `unavailable` (Upstash caído) → 503, ledger NO mutado | status 503; recordWebhookOutcome NO llamado |
| 503 | `recordWebhookOutcome` rechaza (DB throw) → 503, NO 500 | status 503 |
| 400 | firma válida + body no-JSON → 400 `webhook_bad_request` | status 400 |

**Unit (W2.2/W2.3/W2.4)**: `webhook-event-store` (ok/alreadyUsed/unavailable + `__reset`);
`transfi-hmac` (verify buena/mala/ausente sobre crudo, `mapTransfiStatus` 3+desconocidos, extractPayoutId
por candidatos, extractEventId con y sin eventId nativo); `supabase-settlement-ledger.recordWebhookOutcome`
(update por payout_id, filtro NON_TERMINAL, 0-match sin throw) con mock **thenable builder** (WKH-207
auto-blindaje#2 — no usar `mockResolvedValue` sobre el builder chainable).

---

## 8. Readiness Check

| Ítem | Estado |
|---|---|
| Todos los exemplars verificados con Read (paths reales) | ✅ (§2) |
| Header HMAC confirmado | ✅ `X-Transfi-Hmac-Hash`, hex, body crudo (spec:44) |
| Shape del port `SettlementLedger` verificado | ✅ (ports.ts:237-267) |
| Método nuevo indexado por `payoutId` (no owner-scoped) contratado | ✅ DT-2 / §6.1 / CD-12 |
| Ledger-OFF resuelto | ✅ **501** (DT-3), consistente con reconcile-orphans |
| Nombre del order-id en el body | ⚠️ NO en la spec → **parseo defensivo + `TODO(sandbox)`** (DT-5), NO inventado |
| `eventId` de webhook | ⚠️ NO en la spec → **candidatos + fallback `${payoutId}:${status}` + `TODO(sandbox)`** (DT-6) |
| Split del reorder (WKH-211) fuera de scope | ✅ CD-6, no se diseña |
| `confirm-and-send.ts` / `wallet.ts` intactos | ✅ Scope OUT / CD-6 |
| MNR-1 (comentario stale) en scope | ✅ W2.5 (solo comentario, líneas 244-248/251) |
| No-PII garantizado | ✅ CD-3/DT-8/AC-9 (solo enum/ids al ledger) |
| Idempotencia claim-once ANTES de mutar | ✅ DT-9 paso 8 / CD-4 |
| Test por cada AC-1..11 | ✅ §7 |
| Auto-blindaje histórico aplicado | ✅ CD-11 (WKH-207#1), CD-13 (WKH-207#3), thenable-mock (WKH-207#2), env-in-fn (CD-10), Edit-verbatim (WKH-209#1) |
| `[NEEDS CLARIFICATION]` sin resolver | **NINGUNO** — los 2 no-bloqueantes se resolvieron (DT-3 ledger-OFF, DT-5/DT-6 header/id con `TODO(sandbox)` defensivo) |

**Los dos `TODO(sandbox)`** (campo del order-id y eventId nativo) NO son bloqueantes ni ambigüedades
del diseño: el comportamiento está 100% definido para todos los candidatos plausibles; el `TODO` solo
marca el punto a confirmar cuando el founder corra el sandbox real (gateado, CD-8). El SDD está
**LISTO para SPEC_APPROVED**.

---

## 9. Scope (recordatorio, del work-item)

**IN**: `app/api/webhooks/transfi/route.ts` (+`.test.ts`), `src/application/ports.ts` (método aditivo),
`src/infrastructure/persistence/supabase-settlement-ledger.ts` (+`.test.ts`),
`src/test-support/fakes.ts` (impl del método en el fake — **agregado por CD-11**, no estaba explícito en
el work-item pero es obligatorio para `tsc`), `src/infrastructure/webhooks/webhook-event-store.ts`
(+`.test.ts`), `src/infrastructure/webhooks/transfi-hmac.ts` (+`.test.ts`),
`app/api/a2a/payout/submit/route.ts:244-248,251` (MNR-1, solo comentario), `.env.example`.

**OUT**: reorder no-custodial (WKH-211), `wallet.ts`, orden de `confirm-and-send.ts`, guard S1-V9 de
`settle/principal/route.ts`, guards 1-8 de `payout/submit/route.ts` (salvo MNR-1), cualquier
`PayoutOrderGateway`, repos externos, send on-chain real / webhook en vivo, encender
`NEXT_PUBLIC_EIP3009_ENABLED`/`TRANSFI_ADAPTER_READY`, reclasificar filas `manual_review`.
