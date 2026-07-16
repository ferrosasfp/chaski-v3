# SDD #019: [WKH-207] Persistencia server-side + reconciliación de remesas huérfanas

> SPEC_APPROVED: no
> Fecha: 2026-07-16
> Tipo: feature (cambio arquitectónico, money-path)
> SDD_MODE: full
> Branch: feat/207-remittance-persistence-reconciliation
> Artefactos: doc/sdd/019-wkh-207-remittance-persistence-reconciliation/

---

## 1. Resumen

Cierra el último residual del gate de Fase A (nombrado por WKH-168/AC-9 y los comentarios en
`ports.ts:119-124`, `confirm-and-send.ts:198-201`, `submit/route.ts:26-28`): hoy el estado de la
remesa vive SOLO en `localStorage` y `ConfirmAndSend.execute()` corre client-side. Si el browser se
cierra entre `principal_in` (USDC YA verificado on-chain adentro) y un estado terminal, la remesa
queda **huérfana, con el dinero REALMENTE adentro y sin forma de reconciliar**.

Esta HU construye dos cosas, sin tocar el guard-order del money-path:

1. **Persistencia server-side** del estado crítico de settlement — un ledger en Postgres propio de
   chaski-v2 (DT-1 = Opción C, decidida por el founder en HU_APPROVED), escrito como side-effect
   ADITIVO en `/api/settle/principal` (post-V9) y `/api/a2a/payout/submit` (post-forward).
2. **Un mecanismo de reconciliación** (endpoint admin protegido por secreto compartido) que detecta
   remesas varadas y las marca para resolución **manual** con evidencia — NUNCA reintenta el forward,
   así que el doble-pago es imposible por construcción. (El retry-forward automático se DEFIERE, §10/DT-4:
   requeriría persistir `beneficiary`/PII, prohibido por CD-7.)

Todo es **flag-gated y byte-idéntico OFF**: sin el flag y/o sin la migración aplicada, cada flujo
actual responde exactamente igual que hoy. La migración se entrega **PENDING-DEPLOY** (archivo SQL,
nunca aplicada — la aplica el founder, gated).

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 019 / WKH-207 |
| **Tipo** | feature (arquitectónico, money-path) |
| **SDD_MODE** | full |
| **Objetivo** | Persistir server-side el settlement del principal + reconciliar remesas varadas sin depender del browser, con idempotencia anti-doble-pago. |
| **Reglas de negocio** | Cero deuda técnica; flag-gated OFF por default; migración PENDING-DEPLOY; nunca doble-pago; ownership app-layer + RLS; nunca PII cruda. |
| **Scope IN** | Ver §6 IN |
| **Scope OUT** | Ver §6 OUT |
| **Missing Inputs** | DT-1 resuelto (C, founder). DT-3, umbral, dedupe-agente, trigger → resueltos en §4/§10. |

### Acceptance Criteria (EARS)

Heredados literales del work-item (AC-1..AC-10). Ver `work-item.md` §Acceptance Criteria. Resumen:

- **AC-1**: WHEN settle verificado on-chain (`verifySettlementOnChain → ok:true`) Y flag ON, THE
  system SHALL escribir el registro server-side (txHash, monto verificado, receiver, sender,
  quoteId, timestamp) ANTES de responder la atestación.
- **AC-2**: WHILE flag OFF (default), THE system SHALL comportarse byte-idéntico a pre-HU.
- **AC-3**: WHEN el forward del payout retorna (ok/4xx/5xx/timeout) Y flag ON, THE system SHALL
  actualizar el registro correlacionado con el resultado.
- **AC-4**: WHEN corre la reconciliación, THE system SHALL identificar varadas (settle verificado sin
  resolución terminal tras un umbral configurable).
- **AC-5** (reencuadrado — ver §10/DT-4): THE system SHALL **persistir** el `idempotencyKey`
  (`${remittanceId}:${quoteId}`) como dato/invariante disponible para un retry futuro — PROHIBIDO
  regenerarlo. Esta HU **NO ejecuta** un retry-forward automático (queda fuera de scope, §10/DT-4);
  AC-5 se satisface a nivel de **dato persistido + contrato**, no de ejecución.
- **AC-6** (path principal): WHEN corre la reconciliación sobre una varada, THE system SHALL marcar
  **`manual_review` con evidencia** (txHash, monto, address, quoteId, status, attempts) — SIEMPRE, sin
  reintentar el forward. PROHIBIDO asumir éxito, PROHIBIDO desembolsar un 2º pago.
- **AC-7**: THE system SHALL exponer la reconciliación protegida por auth server-side — NUNCA pública.
- **AC-8**: THE system SHALL entregar la migración como archivo PENDING-DEPLOY.
- **AC-9**: IF la tabla persiste datos por usuario, THEN THE system SHALL aplicar ownership app-layer + RLS.
- **AC-10**: WHILE migración no aplicada Y/O flag OFF, THE system SHALL degradar con gracia sin romper nada.

## 3. Context Map (Codebase Grounding)

### Archivos leídos (archivo:línea)

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `app/api/settle/principal/route.ts:1-216` | Punto de escritura #1 (post-V9). Verificar shape del body y dónde inyectar el persist. | Body recibe `authorization`, `signature`, `address`, `quoteId`, `expectedValueMinor` — **NO `remittanceId`** (confirma DT-3). Guard-order S1-S13 → BROADCAST S14-S21 → VERIFY V1-V9 → attest (L188-203) → response (L206). Envs se leen DENTRO del handler (`process.env.NEXT_PUBLIC_EIP3009_ENABLED` L46). Valores verificados: `verified.valueMinor/from/to/txHash` (server-truth, NO eco del cliente). |
| `app/api/a2a/payout/submit/route.ts:1-284` | Punto de escritura #2 (post-forward). Guard-order + de dónde sale el idempotencyKey. | Guards 1-8 (BASE→formato→autoridad→PoP→atestación) todos DENTRO del handler; envs leídas en runtime (`SETTLE_ATTESTATION_SECRET` L179). `body.idempotencyKey` se forwardea tal cual (L271). `att.txHash/valueMinor/from` verificados. Forward en try/catch L267-283 (2xx / `a2a_upstream_error` 502 / `a2a_bad_shape` 502 / catch `a2a_unavailable` 502). **WKH-205 toca `isRecord` L39-41.** |
| `src/application/ports.ts:1-210` | Dónde declarar el port nuevo + extender `settle()`. | `RemittanceRepository` (L194-202) es el repo client-side localStorage (save/get/list/clearByOwner). `PrincipalSettlementGateway.settle` (L142-153) recibe `{authorization, signature, address, quoteId, expectedValueMinor}`. Ports son interfaces puras; la infra las implementa. |
| `src/infrastructure/persistence.ts:1-138` | Exemplar de repo + reductor PII + CAS. | `LocalRepo` es localStorage-only; usa `toPersistedIdentity` (CD-7 reductor PII). NO sirve como base del ledger (concern distinto, browser). |
| `src/infrastructure/rate-limit.ts:1-60` | Exemplar de cliente Upstash lazy server-only. | `getLimiters()` (L54-60): factory memoizada (`let cached`), lee envs en runtime, **devuelve null si faltan** (feature-detect). Este es el patrón EXACTO para el cliente Supabase + factory del ledger (AC-10). |
| `src/infrastructure/settlement/attestation.ts:11-73` | Exemplar de auth con secreto compartido timing-safe. | `node:crypto` `createHmac` + `timingSafeEqual` (L12,68-73); "NO jsonwebtoken/jose (patrón kyc-auth.ts)". Base para el guard de auth del reconcile endpoint. |
| `src/infrastructure/wallet.ts:37-39` | Confirmar el binding nonce↔remittanceId (integridad DT-3). | `deterministicNonce = keccak256(toBytes(\`${remittanceId}:${quoteId}\`))`. Permite VERIFICAR server-side que un `remittanceId` declarado coincide con el nonce firmado (defensa en profundidad). |
| `src/application/use-cases/confirm-and-send.ts:120-249` | De dónde sale `s.id` (=remittanceId) y el `idempotencyKey`. | `idempotencyKey = \`${s.id}:${quote.quoteId}\`` (L216). `settle()` se llama en L139-145 (modo real, `this.settlement`); `s.id` ya se pasa a `wallet.authorizePrincipal(quote, s.id)` (L120). Toque aditivo = 1 línea (`remittanceId: s.id`). |
| `src/composition/container.ts:48-121` | Cómo se cablea flag-gated (settlement/pop). | Patrón "instanciar SOLO con flag on ⇒ undefined = demo byte-idéntico por construcción" (L89-97). Las rutas API NO pasan por el container (son server handlers que importan infra directo). |
| `src/test-support/{fakes,test-container}.ts` | Dónde va el fake del port + wiring. | 20+ fakes `implements <Port>`; `InMemoryRepo` (fakes.ts:70), `FakeSettlementGateway` (fakes.ts:362). `test-container.ts` inyecta overrides. El ledger NO va al container (lo usan rutas), pero el fake sí es útil para tests de ruta/ledger. |
| `wasiai-remittance-agents/src/providers/payout.ts:1-115` | **Verificar dedupe del agente (DT-4/AC-6).** | `TransFiPayoutProvider` (L11-42) delega la idempotencia a TransFi vía header `idempotency-key` (L22) — el agente **NO mantiene su propio store de dedupe**. `FallbackPayoutProvider` (L68-89) es MOCK: `payoutId: \`fallback-${idempotencyKey}\``, `status:"settled"`, `deliveredLocal:null` (**no mueve plata**, determinístico). `getPayoutProvider` (L108) usa fallback si no hay `TRANSFI_API_KEY`; TransFi exige `TRANSFI_ADAPTER_READY=true` (L111, hoy no ready). **Conclusión: el agente NO garantiza dedupe por sí mismo.** |
| `doc/sdd/016-.../auto-blindaje.md`, `doc/sdd/017-.../auto-blindaje.md` | Errores recurrentes de las 2 últimas DONE. | Patrones recurrentes (≥2 HUs): (a) gate = `npm run qa`, NO `npm run build` (WKH-168#3, WKH-196); (b) I/O fuera del try/catch del use-case deja la remesa varada (WKH-168 C3, WKH-206#1); (c) `mockImplementation` no `mockResolvedValue` para `Response` reusado (WKH-168#2); (d) `vi.fn` de unión discriminada necesita tipo explícito (WKH-206#2); (e) verificar que el test llega a la rama que dice probar (WKH-168#4). → CD-16/CD-17/CD-18. |

### Exemplars (verificados con Glob/Read)

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/infrastructure/persistence/supabase-server.ts` (nuevo) | `src/infrastructure/rate-limit.ts:33-60` | Factory lazy memoizada server-only que devuelve null si faltan envs (feature-detect AC-10). |
| `src/infrastructure/persistence/supabase-settlement-ledger.ts` (nuevo) | `src/infrastructure/persistence.ts` (estructura de clase `implements`) + `rate-limit.ts` (factory `getSettlementLedger()`) | Clase `implements SettlementLedger`; factory que devuelve `null` cuando flag OFF / envs ausentes. |
| `app/api/admin/reconcile-orphans/route.ts` (nuevo) | `app/api/a2a/payout/submit/route.ts` (guard-order fail-closed) + `attestation.ts:68-73` (timing-safe compare) | Auth por secreto compartido timing-safe; fail-closed; enums opacos. |
| `supabase/migrations/*.sql` (nuevo) | N/A (primera migración del repo) — patrón conceptual `owner_ref`+RLS de wasiai-a2a `CLAUDE.md` | Postgres estándar; RLS + índices para reconciliación. |
| `SettlementLedger` port en `ports.ts` | `RemittanceRepository`, `PrincipalSettlementGateway` (mismo archivo) | Interfaz pura, sin acoplar a Supabase. |
| `FakeSettlementLedger` en `fakes.ts` | `InMemoryRepo` (fakes.ts:70), `FakeSettlementGateway` (fakes.ts:362) | In-memory `implements SettlementLedger`. |

### Estado de BD relevante

| Tabla | Existe | Columnas |
|-------|--------|----------|
| `remittance_settlements` | **NO** (se crea en la migración PENDING-DEPLOY) | ver §4.2 |
| — | — | No hay `supabase/` dir ni ninguna migración `.sql` en el repo hoy (verificado). Es la PRIMERA dep de BD del proyecto. |

### Dep nueva

`@supabase/supabase-js` — **NO está en `package.json`** (verificado: deps actuales no incluyen ningún
cliente de DB). Es la primera dep de persistencia real. Justificación en §8.

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `supabase/migrations/<ts>_create_remittance_settlements.sql` | Crear | Tabla + índices + RLS. **PENDING-DEPLOY** (AC-8/CD-1). | §4.2 |
| `src/application/ports.ts` | Modificar | + port `SettlementLedger` + tipo `SettlementRecord`/`SettlementLedgerStatus`; extender `PrincipalSettlementGateway.settle` input con `remittanceId: string`. | ports.ts (mismo archivo) |
| `src/infrastructure/persistence/supabase-server.ts` | Crear | Cliente Supabase lazy memoizado, server-only, null si faltan envs. | `rate-limit.ts:33-60` |
| `src/infrastructure/persistence/supabase-settlement-ledger.ts` | Crear | `SupabaseSettlementLedger implements SettlementLedger` + factory `getSettlementLedger()` (null si OFF/unconfigured). Reads con `::text` (CD-12). | `persistence.ts` + `rate-limit.ts` |
| `src/infrastructure/settlement/http-settlement-gateway.ts` | Modificar | Enviar `remittanceId` en el body del POST a `/api/settle/principal` (aditivo). | archivo actual |
| `src/application/use-cases/confirm-and-send.ts` | Modificar (1 línea aditiva) | Pasar `remittanceId: s.id` en la llamada `settle({...})` (L139-145). NO toca guard-order (CD-5). | L120 (ya pasa `s.id`) |
| `app/api/settle/principal/route.ts` | Modificar (aditivo post-V9) | Flag-gated: leer/validar `body.remittanceId`, verificar binding nonce (opcional), `ledger.recordPrincipalIn(...)` best-effort ANTES de responder. Sin tocar S1-V9 (CD-4). | patrón `SETTLE_ATTESTATION_SECRET` L179-203 |
| `app/api/a2a/payout/submit/route.ts` | Modificar (aditivo post-forward) | Flag-gated: `ledger.recordPayoutOutcome(...)` owner-scoped tras el forward. Sin tocar guards 1-8 (CD-3). **Merge tras WKH-205** (§4.10). | patrón forward L267-283 |
| `app/api/admin/reconcile-orphans/route.ts` | Crear | POST protegido por secreto compartido timing-safe. listStale → **markOutcome(`manual_review`) con evidencia** (sin retry-forward, §10/DT-4). | `payout/submit` + `attestation.ts:68-73` |
| `.env.example` | Modificar | Documentar envs nuevas (ver §4.3). | bloque WKH-206 (tail) |
| `src/test-support/fakes.ts` | Modificar | + `FakeSettlementLedger` (in-memory). | `InMemoryRepo` fakes.ts:70 |
| Tests (`*.test.ts`) | Crear/Modificar | ≥1 por AC (ver §Test Plan). | tests de ruta existentes |

### 4.2 Modelo de datos — migración PENDING-DEPLOY

Tabla `remittance_settlements` (Postgres, proyecto Supabase PROPIO de chaski-v2 — org FREE nueva):

```sql
-- <ts>_create_remittance_settlements.sql — PENDING-DEPLOY (WKH-207/AC-8/CD-1).
-- NO aplicar: la aplica el founder (acción gated, classifier).
create table if not exists public.remittance_settlements (
  id                uuid primary key default gen_random_uuid(),
  remittance_id     text not null,                       -- aggregate id del cliente (s.id)
  quote_id          text not null,
  idempotency_key   text not null,                       -- `${remittance_id}:${quote_id}` (AC-5, retry)
  tx_hash           text not null,                       -- settle del principal VERIFICADO on-chain
  chain_id          integer not null,
  sender_address    text not null,                       -- payer on-chain (from), lowercased — OWNER (AC-9)
  receiver_address  text not null,                       -- receiver de plataforma (to, de ENV)
  value_minor       numeric(78,0) not null,              -- uint256-safe; leer SIEMPRE con ::text (CD-12, WKH-196)
  status            text not null default 'principal_in',-- ver enum abajo
  attempts          integer not null default 0,          -- contador de reintentos de reconciliación (AC-6)
  payout_id         text,                                -- del result del agente cuando se conoce
  last_error        text,                                -- enum estable de fallo, NUNCA PII (CD-7)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint remittance_settlements_status_chk check (status in
    ('principal_in','submitted','settled','failed','forward_error','manual_review'))
);

-- Idempotencia de inserción: un settle = una fila (settle podría reintentarse a nivel red).
create unique index if not exists uq_remit_settle_txhash on public.remittance_settlements (tx_hash);
create unique index if not exists uq_remit_settle_idem   on public.remittance_settlements (idempotency_key);
-- Query de reconciliación (AC-4): no-terminales más viejas que el umbral. Índice parcial.
create index if not exists idx_remit_settle_stale on public.remittance_settlements (updated_at)
  where status in ('principal_in','submitted','forward_error');
-- Ownership lookups / RLS (AC-9).
create index if not exists idx_remit_settle_owner on public.remittance_settlements (sender_address);

-- RLS defensa en profundidad (AC-9/CD-9). La app usa SUPABASE_SERVICE_KEY (BYPASSRLS) ⇒ el guard
-- REAL es el filtro app-layer `.eq('sender_address', <caller>)`. RLS protege ante un client anon-key.
alter table public.remittance_settlements enable row level security;
-- Sin policy permisiva ⇒ deny-all para roles no-service (fail-closed). El service key opera igual.
```

**Estados (FSM del ledger, independiente de la FSM del dominio):**

| status | Significado | Terminal p/ reconcile |
|--------|-------------|-----------------------|
| `principal_in` | Settle verificado escrito; forward aún no registrado (candidato #1 a varado) | NO |
| `submitted` | Forward reenviado, respuesta `submitted` del agente (esperando confirmación) | NO |
| `forward_error` | Forward falló/timeout (candidato a varado — AMBIGUO si el agente lo recibió) | NO |
| `settled` | Forward confirmado `settled` | SÍ |
| `failed` | Forward retornó `failed`/`blocked` explícito | SÍ (registro, no reintentable) |
| `manual_review` | La reconciliación no pudo resolver con certeza → humano (AC-6) | SÍ |

**Precisión uint256 (CD-12, lección WKH-196):** `value_minor` es `numeric(78,0)`. supabase-js/PostgREST
lee `numeric` como número JSON → `JSON.parse` redondea >2^53. TODO `select` de `value_minor` DEBE
castear `::text` (`.select('value_minor::text')` o vista) y parsear en JS. Aunque los montos reales
(USDC 6-dec, ~4e8 para $400) hoy caben en `number`, el patrón es obligatorio por consistencia y
futuro (R6/precisión).

### 4.3 Componentes / Servicios

**Port nuevo `SettlementLedger` (ports.ts)** — interfaz pura:

```
SettlementLedgerStatus = 'principal_in'|'submitted'|'settled'|'failed'|'forward_error'|'manual_review'
SettlementRecord = { id, remittanceId, quoteId, idempotencyKey, txHash, chainId,
                     senderAddress, receiverAddress, valueMinor: number, status, attempts,
                     payoutId: string|null, lastError: string|null, createdAt, updatedAt }

interface SettlementLedger {
  // settle route (AC-1): upsert por tx_hash (ON CONFLICT DO NOTHING), status principal_in.
  recordPrincipalIn(input: { remittanceId; quoteId; idempotencyKey; txHash; chainId;
                             senderAddress; receiverAddress; valueMinor: number }): Promise<void>;
  // submit route (AC-3): UPDATE owner-scoped por (idempotencyKey, senderAddress).
  recordPayoutOutcome(input: { idempotencyKey; senderAddress;
                               status: SettlementLedgerStatus; payoutId?: string|null;
                               error?: string|null }): Promise<void>;
  // reconcile (AC-4): no-terminales más viejas que olderThanIso. Global (admin) — sin owner filter.
  listStale(input: { olderThanIso: string; limit: number }): Promise<SettlementRecord[]>;
  // reconcile (AC-6): incrementa attempts + set status/last_error. Por id.
  markOutcome(input: { id; status: SettlementLedgerStatus; payoutId?: string|null;
                       error?: string|null; incrementAttempt: boolean }): Promise<void>;
}
```

**Factory `getSettlementLedger(): SettlementLedger | null`** — devuelve `null` cuando
`SETTLEMENT_LEDGER_ENABLED !== "true"` O el cliente Supabase es `null` (envs ausentes). Las rutas
hacen `const ledger = getSettlementLedger(); if (!ledger) { /* skip, byte-idéntico */ }` (AC-2/AC-10).

**Cliente Supabase server-only** (`supabase-server.ts`): factory memoizada como `rate-limit.ts` —
lee `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` en runtime, `createClient(...)` con `auth: { persistSession:false }`,
null si faltan. **NUNCA se importa desde un módulo `"use client"`** (CD-11): vive bajo
`src/infrastructure/persistence/` e importado solo por route handlers server.

**Endpoint reconcile** (`app/api/admin/reconcile-orphans/route.ts`, POST):
1. **Auth (AC-7/CD-8):** leer `RECONCILE_ADMIN_SECRET` en runtime. Ausente ⇒ `501` (no configurado,
   fail-closed — NUNCA público). Header `authorization: Bearer <secret>` (o `x-reconcile-secret`);
   compare `timingSafeEqual` (patrón attestation.ts:68-73). Mismatch/ausente ⇒ `401`.
2. **listStale:** `olderThanIso = now - RECONCILE_STALE_THRESHOLD_SECONDS`, `limit` acotado.
3. Por cada varada: derivar `idempotencyKey` del registro (`${remittance_id}:${quote_id}`) y aseverar
   `=== record.idempotency_key` (AC-5, NUNCA regenerar). Es una **invariante de dato** (no ejecuta nada).
4. **Resolución = SOLO `manual_review` con evidencia (AC-6/CD-6/CD-15):** por cada varada,
   `markOutcome({ id, status:'manual_review', incrementAttempt:true })` con la evidencia ya persistida
   (txHash, monto, address, quoteId, status, attempts). **El endpoint NO reintenta el forward.**
   **El retry-forward automático queda FUERA DE SCOPE de esta HU** (deferido, ver §10/DT-4) por doble
   bloqueo: (a) el agente de payout **no deduplica** por sí mismo (verificado, §4.3 nota) y (b) el body
   del forward al agente requiere **`beneficiary` (PII)**, que **CD-7 prohíbe persistir** y la tabla NO
   guarda ⇒ el forward **no es reconstruible** desde el ledger. No se implementa `RECONCILE_AUTO_RETRY`
   ni ningún branch de retry-forward.
5. Respuesta: conteos agregados (`{ scanned, manualReview }`) — NUNCA PII ni montos/addresses de terceros.

**Por qué el retry-forward se DIFIERE (DT-4/CD-6/CD-15 — grounded):** doble bloqueo money-safe.
(a) Verifiqué `wasiai-remittance-agents/src/providers/payout.ts` — el agente **NO deduplica por sí
mismo**: el adapter TransFi delega en el header `idempotency-key` (dedupe del PARTNER, hoy no
verificable — `TRANSFI_ADAPTER_READY` no está en `true`), y el fallback es MOCK. (b) Reconstruir el
body del forward exige `beneficiary` (PII) que **CD-7 prohíbe persistir**; inventarlo/derivarlo sería
violar CD-7 y arriesgar un mal-pago. Por CD-6 ("preferir varado antes que doble-pago"), esta HU
resuelve TODA varada a `manual_review` con evidencia y **difiere** el retry automático a una HU futura
que decida la política de manejo de `beneficiary`. La invariante AC-5 (reuso del `idempotencyKey`)
queda **persistida y documentada** para ese futuro, sin ejecutarse acá.

### 4.4 Flujo principal (Happy Path) — modo real, flag ON, migración aplicada

1. Cliente firma EIP-3009; `confirm-and-send` llama `settle({..., remittanceId: s.id})`.
2. `/api/settle/principal`: S1-V9 (intacto) → atestación emitida (intacto) → **[nuevo, aditivo]**
   flag ON + client resuelto ⇒ (opcional) verificar `keccak256(remittanceId:quoteId) === nonce`;
   `ledger.recordPrincipalIn({txHash: verified.txHash, valueMinor: verified.valueMinor, from, to, quoteId, remittanceId, idempotencyKey})`
   en su PROPIO try/catch → responde atestación (igual que hoy).
3. Cliente llama `/api/a2a/payout/submit`; guards 1-8 (intacto) → forward (intacto) → **[nuevo]**
   `ledger.recordPayoutOutcome({idempotencyKey: body.idempotencyKey, senderAddress: address, status: mapForwardResult(...)})`
   owner-scoped, en su propio try/catch → responde `{result}` (igual que hoy).
4. Si el browser se cierra entre 2 y 3: el registro queda en `principal_in` (varado, pero **con
   evidencia server-side**).
5. Founder invoca `POST /api/admin/reconcile-orphans` (secreto): detecta la varada y la marca
   `manual_review` con evidencia (txHash, monto, address, quoteId, status, attempts). **No reintenta el
   forward** (retry-forward deferido, §10/DT-4). El humano resuelve fuera de banda con la evidencia.

### 4.5 Flujo de error

- **Flag OFF / migración no aplicada / envs ausentes:** `getSettlementLedger()` → `null` ⇒ las rutas
  saltean el persist ⇒ byte-idéntico (AC-2/AC-10). Ninguna ruta empieza a fallar por código apagado.
- **DB caída con flag ON (write en settle):** el persist va en su propio try/catch → `console.error`
  (enum, sin PII) y **NO rompe el money-path** — se responde la atestación igual. Trade-off explícito
  (DT-5): romper la respuesta NO recupera el USDC ya adentro y además garantiza el huérfano; el
  money-path completando siempre gana. Residual: un write fallido deja un hueco que solo captura el
  log de ops (aceptable: flag opt-in, DB-down raro, alternativa estrictamente peor).
- **Reconcile sin secreto configurado:** `501`. Con secreto inválido: `401`. Nunca ejecuta sin auth.
- **Varada detectada:** SIEMPRE `manual_review` con evidencia (AC-6). El endpoint NO reintenta el
  forward (retry-forward deferido, §10/DT-4) ⇒ el vector de doble-pago es **imposible por construcción**
  (nunca se dispara un 2º desembolso).

## 5. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (CD-1..CD-10) — vigentes íntegros

- **CD-1**: PROHIBIDO aplicar la migración a cualquier DB — solo archivo PENDING-DEPLOY.
- **CD-2**: PROHIBIDO encender el flag de persistencia por default — OFF al terminar F3 (byte-idéntico).
- **CD-3**: PROHIBIDO tocar el guard-order 1-8 de `submit/route.ts` ni la atestación/PoP — solo aditivo POST-guards.
- **CD-4**: PROHIBIDO tocar el guard-order S1-V9 de `settle/principal` ni broadcast→verify→attest — solo aditivo tras V9.
- **CD-5**: PROHIBIDO tocar la orquestación/secuencia de `confirm-and-send.ts` (CAS→autoridad→expiry→firma→expiry→submit). *El único toque permitido es 1 argumento aditivo (`remittanceId: s.id`) a la llamada `settle()` existente — NO altera la secuencia.*
- **CD-6**: PROHIBIDO que el retry pueda producir doble-pago — preferir "varado, manual" antes que un 2º desembolso.
- **CD-7**: PROHIBIDO persistir PII cruda — solo evidencia money-path (txHash, montos, address, quoteId, status, timestamps). NUNCA documento/fecha de nacimiento/nacionalidad. `last_error` es enum, no PII.
- **CD-8**: PROHIBIDO exponer el reconcile sin auth — 401/403 sin la credencial; 501 sin secreto configurado.
- **CD-9**: OBLIGATORIO filtrar por owner (`sender_address`) en TODA query/mutación de la tabla desde `src/`/`app/api/`, salvo el reconcile admin (global, protegido por secreto). Patrón `owner_ref` del ecosistema.
- **CD-10**: PROHIBIDO usar la DB de wasiai-a2a (Opción B) — DT-1 = C (Supabase propio de chaski-v2).

### Específicos del SDD (CD-11..CD-18)

- **CD-11**: `@supabase/supabase-js` es la ÚNICA dep nueva. Los módulos `supabase-server.ts` /
  `supabase-settlement-ledger.ts` son **server-only**: PROHIBIDO importarlos desde cualquier módulo
  `"use client"` o componente/browser. Solo route handlers + código server los importan.
- **CD-12**: Todo `select` de `value_minor` (numeric(78,0)) DEBE castear `::text` y parsear en JS —
  precisión uint256 (WKH-196). PROHIBIDO leer `value_minor` como número JSON crudo.
- **CD-13**: El registro se escribe con los valores **verificados on-chain** (`verified.valueMinor/from/to/txHash`
  en settle; `att.*` en submit), NUNCA un eco del body del cliente (R6).
- **CD-14**: Toda lectura de env del ledger/reconcile (`SETTLEMENT_LEDGER_ENABLED`, `SUPABASE_*`,
  `RECONCILE_*`) ocurre DENTRO del handler/factory en runtime — NUNCA en el top-level del módulo
  (patrón `SETTLE_ATTESTATION_SECRET` / `PAYOUT_POP_SECRET`; habilita byte-idéntico OFF + scoping por entorno).
- **CD-15** (actualizado): el **retry-forward automático está FUERA DE SCOPE** de esta HU — NO se
  implementa `RECONCILE_AUTO_RETRY` ni ningún branch que re-forwardee al agente. Doble bloqueo: (a) el
  agente no deduplica por sí mismo (verificado, §4.3) y (b) el forward no es reconstruible sin persistir
  `beneficiary`/PII (CD-7). La reconciliación resuelve TODA varada a `manual_review`. El retry se difiere
  a una HU futura (§10/DT-4). PROHIBIDO wirear un forward real desde el reconcile en esta HU.
- **CD-16**: El gate de cada wave es **`npm run qa`** (`tsc --noEmit` + `vitest run`), NUNCA
  `npm run build` (excluye tests) — lección recurrente WKH-196/WKH-168 auto-blindaje#3.
- **CD-17**: PROHIBIDO poner el I/O de persistencia (write/update del ledger) FUERA
  del try/catch que degrada. En las rutas, el persist va en su PROPIO try/catch que NUNCA rompe el
  money-path — patrón recurrente WKH-168 C3 (`settle`) + WKH-206#1 (`prove`).
- **CD-18**: En tests: `mockImplementation` (no `mockResolvedValue`) para cualquier `Response`/stream
  reusado (WKH-168#2); `vi.fn` con retorno de unión discriminada necesita tipo explícito (WKH-206#2);
  verificar por mutación que el test llega a la rama que dice probar (WKH-168#4).

### PROHIBIDO (general)

- NO agregar deps salvo `@supabase/supabase-js`.
- NO modificar archivos fuera de §4.1 / Scope IN.
- NO hardcodear URL/keys/secretos — todo por env server-only.
- NO tocar el demo del jurado, `wasiai-facilitator`, `wasiai-a2a`, `wasiai-v2`.

## 6. Scope

**IN:**
- Migración `remittance_settlements` (SQL PENDING-DEPLOY) + índices + RLS.
- Port `SettlementLedger` + tipos en `ports.ts`; `PrincipalSettlementGateway.settle` +`remittanceId`.
- Cliente Supabase server-only + `SupabaseSettlementLedger` + factory (flag-gated, ownership).
- Wiring aditivo en `settle/principal` (post-V9) y `payout/submit` (post-forward).
- `remittanceId` aditivo: `http-settlement-gateway.ts` + 1 línea en `confirm-and-send.ts`.
- Endpoint `reconcile-orphans` (auth secreto compartido, listStale, **solo `manual_review` con evidencia**).
- `.env.example` (envs nuevas) + `FakeSettlementLedger` + tests (≥1 por AC).

**OUT:**
- **Retry-forward automático de la reconciliación** (re-enviar al agente) — DEFERIDO (§10/DT-4): bloqueado
  por reconstrucción de `beneficiary`/PII (CD-7) + dedupe del agente no garantizado. NO se implementa
  `RECONCILE_AUTO_RETRY` ni ningún branch de re-forward. Esta HU solo marca `manual_review`.
- Aplicar la migración (acción gated del founder).
- Encender flags por default en cualquier entorno.
- Guard-order de submit/settle + orquestación de `confirm-and-send` (salvo el arg aditivo).
- Clawback on-chain real (heredado WKH-168/DT-8).
- Automatizar el disparo (cron/Vercel Cron/GitHub Actions) — se entrega invocable (§10).
- UI de estado de reconciliación (operación admin).
- Habilitar payout real / TransFi ready.
- `wasiai-facilitator`/`wasiai-a2a`/`wasiai-v2` y el demo del jurado.

## 7. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| R1 — Doble-pago en el retry | M | A | **Eliminado por construcción:** el reconcile NUNCA reintenta el forward (retry-forward deferido, §10/DT-4). Resuelve SIEMPRE a `manual_review` (AC-6/CD-6/CD-15). |
| R2 — Reconcile público/sin auth | B | A | AC-7/CD-8: secreto compartido timing-safe; 501 sin secreto, 401 sin credencial. |
| R3 — IDOR en la tabla | M | A | AC-9/CD-9: `.eq('sender_address', caller)` en toda query/mutación de ruta + RLS. |
| R4 — Migración aplicada por error | B | A | AC-8/CD-1: archivo PENDING-DEPLOY, sin runner en CI. |
| R5 — Flag ON en scope equivocado | M | M | CD-2/CD-14: OFF default, env leída en runtime; byte-idéntico OFF (AC-2). |
| R6 — Reconciliar con datos del cliente | B | A | AC-1/CD-13: se persiste el valor verificado on-chain, nunca el eco del body. |
| R7 — PII en la tabla | B | M | CD-7: solo evidencia money-path; `last_error` enum; sin identidad. |
| R8 — Colisión merge con WKH-205 en submit | M | B | §4.10: 205 mergea primero; el toque de 207 es post-forward, no la línea `isRecord` L39-41. |
| R9 — Write del ledger rompe el money-path | B | A | CD-17/DT-5: persist en try/catch propio, best-effort; el money-path siempre responde. |
| R10 — Precisión uint256 en `value_minor` | B | M | CD-12: `::text` en todo select (WKH-196). |
| R11 (residual) — Auto-retry del forward diferido | — | — | **Aceptado/deferido:** el retry automático del forward queda fuera de scope, bloqueado por (a) reconstrucción del `beneficiary`/PII (CD-7 lo prohíbe persistir) + (b) dedupe del agente no garantizado. Mientras tanto: `manual_review` con evidencia (humano fuera de banda). Se retoma en una HU futura que decida la política de `beneficiary` para retry. |

## 8. Dependencias

- **`@supabase/supabase-js`** (dep nueva). Justificación: DT-1 = Opción C exige un cliente Postgres
  real con queries relacionales para la reconciliación (índices nativos, no manuales como en Upstash).
  Es el cliente oficial, ya probado en el ecosistema (wasiai-a2a). Import server-only (CD-11). Es la
  primera dep de BD del repo (verificado: no hay ninguna hoy).
- Proyecto Supabase propio de chaski-v2 (org FREE nueva) — lo crea el **founder** en paralelo; NO se
  necesita vivo para F2/F3 (se diseña contra Postgres estándar; migración PENDING-DEPLOY).
- **WKH-205 mergea PRIMERO** (F3 serial). Cuando WKH-207 llegue a F3, `submit/route.ts` ya tendrá el
  fix de 205. El wiring de 207 es post-forward — no choca con `isRecord` L39-41.

## 9. Missing Inputs

- [x] DT-1: **RESUELTO** — Opción C (Supabase propio de chaski-v2), decidido por el founder en HU_APPROVED.
- [x] DT-3: **RESUELTO** — Opción 1 (agregar `remittanceId` explícito al body de settle). Ver §10/DT-3.
- [x] Umbral de "varada": **RESUELTO con default** — `RECONCILE_STALE_THRESHOLD_SECONDS` default 900 (15 min), configurable por env. El founder puede overridear.
- [x] Dedupe del agente: **RESUELTO/VERIFICADO** — el agente NO deduplica por sí mismo (§4.3). Esto, sumado a que el forward no es reconstruible sin `beneficiary`/PII (CD-7), **DEFIERE el retry-forward** fuera de esta HU (§10/DT-4); la reconciliación resuelve a `manual_review`.
- [ ] Trigger de la reconciliación: **[TBD, NO bloqueante]** — se entrega invocable + runbook; Vercel Cron/GitHub Actions es follow-up de ops (§10). No bloquea el SDD.

## 10. Uncertainty Markers + Decisiones cerradas

### DT-1 — Dónde persiste → **Opción C (Supabase/Postgres propio de chaski-v2)** [CERRADA por founder]

Postgres real con queries/índices nativos para reconciliación; respeta el guardrail standalone (NO
wasiai-a2a, CD-10; NO Upstash para el estado de remesa). Migración PENDING-DEPLOY.

### DT-2 — Puntos de escritura server-side [CERRADA]

`/api/settle/principal` post-V9 (`recordPrincipalIn`) + `/api/a2a/payout/submit` post-forward
(`recordPayoutOutcome`). ADITIVO al final de la lógica existente; sin tocar guard-order (CD-3/CD-4).
`confirm-and-send.ts` NO se reordena — solo se persiste como side-effect en las rutas.

### DT-3 — Correlación del registro → **Opción 1: `remittanceId` explícito en el body de settle** [CERRADA]

**Elegida la Opción 1** (agregar `remittanceId` al body de `/api/settle/principal`), NO la Opción 2
(`(address, quoteId, txHash)`). Justificación:
1. **AC-5 lo exige (a nivel de dato):** el `idempotencyKey = ${remittanceId}:${quoteId}` debe quedar
   PERSISTIDO como invariante para un retry futuro (§10/DT-4). El nonce es one-way
   (`keccak256(remittanceId:quoteId)`, wallet.ts:37-39) ⇒ NO se puede recuperar `remittanceId` de la
   cadena ni del nonce. Sin persistir `remittanceId` en el settle, la reconciliación NO puede reconstruir
   el idempotencyKey → AC-5 imposible incluso a nivel de dato. La Opción 2 no da `remittanceId`.
2. **Aditivo y mínimo:** el cliente ya tiene `s.id` y ya lo pasa a `wallet.authorizePrincipal(quote, s.id)`
   (confirm-and-send.ts:120). Pasarlo también a `settle()` es 1 línea; validarlo en la ruta es aditivo,
   solo cuando el flag está ON (byte-idéntico OFF).
3. **Integridad (defensa en profundidad):** la ruta puede verificar `keccak256(remittanceId:quoteId) === nonce`
   ⇒ el `remittanceId` persistido queda **criptográficamente atado** a lo que el usuario firmó (un
   cliente no puede persistir un remittanceId falso). Si no matchea: no persiste esa fila + log (no
   rompe el settle). Barato (viem `keccak256`/`toBytes` ya en uso).
4. **Correlación settle↔submit:** ambas rutas derivan el mismo `idempotency_key`
   (`${remittanceId}:${quoteId}`); el submit tiene `body.idempotencyKey` (forwardeado, L271) y actualiza
   `WHERE idempotency_key = ? AND sender_address = ?` (owner-scoped, CD-9). No necesita tocar el bloque
   de atestación (desacoplado).

### DT-4 — Idempotencia del retry → **retry-forward DEFERIDO (fuera de scope de esta HU)** [CERRADA]

El `idempotencyKey` (`${remittanceId}:${quoteId}`) se **persiste** y se reusa como invariante para un
retry futuro, NUNCA se regenera (AC-5, a nivel de dato). **PERO el retry-forward automático NO se
implementa en esta HU** — doble bloqueo money-safe:

1. **Dedupe del agente:** verificado en `wasiai-remittance-agents/src/providers/payout.ts` — el agente
   `remit-cashout-payout` **NO deduplica por sí mismo** (delega en el header `idempotency-key` de TransFi,
   hoy no verificable; el fallback es MOCK).
2. **Reconstrucción del forward:** el body del forward al agente incluye **`beneficiary` (PII)**, que
   **CD-7 prohíbe persistir** y la tabla `remittance_settlements` NO guarda. Sin `beneficiary` el forward
   **no es reconstruible** desde el ledger; inventarlo/derivarlo violaría CD-7 y arriesgaría un mal-pago.

Por CD-6 ("preferir varado antes que doble-pago"), la reconciliación de esta HU resuelve TODA varada a
**`manual_review` con evidencia** (el humano resuelve fuera de banda). El retry-forward automático —y con
él la env `RECONCILE_AUTO_RETRY`— se **difiere a una HU futura** que decida la política de manejo de
`beneficiary` para retry. No se implementa `RECONCILE_AUTO_RETRY` ni ningún branch de re-forward acá.

### DT-5 (NUEVA) — Best-effort vs money-path en el write de settle [CERRADA]

El `recordPrincipalIn` es best-effort en su propio try/catch (CD-17): si la DB está caída con el flag
ON, se loguea (enum) y **igual se responde la atestación** — romper la respuesta no recupera el USDC
ya adentro y garantiza el huérfano (peor). Residual documentado: un write fallido deja un hueco que
solo el log de ops captura (aceptable: opt-in, raro, alternativa peor).

### DT-6 (NUEVA) — Umbral + trigger [CERRADA con default / TBD no bloqueante]

Umbral: `RECONCILE_STALE_THRESHOLD_SECONDS` default **900s (15 min)** — generoso para no mal-clasificar
un forward lento, tight para ops; configurable. Trigger: **[TBD no bloqueante]** — se entrega el
endpoint invocable + runbook (curl con secreto); Vercel Cron/GitHub Actions es follow-up de ops
(Scope OUT). No bloquea F3.

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| [TBD] | §10/DT-6 | Automatizar el disparo (cron) — se entrega invocable | No |

> Gate: no quedan `[NEEDS CLARIFICATION]`. El único [TBD] (trigger) es Scope OUT y no bloquea.

## 4.10 Coordinación con WKH-205 (paralelo)

WKH-205 (`018`) toca `validate/route.ts`, `challenge/route.ts`, `rate-limit.ts` y SOLO la línea
`isRecord` (L39-41) de `submit/route.ts`. **F3 serial: WKH-205 mergea PRIMERO.** El wiring de WKH-207
en `submit/route.ts` es **post-forward** (después de L265), no toca `isRecord`. Cuando WKH-207 llegue
a F3, asumir que `submit/route.ts` ya trae el fix de 205 mergeado y re-basear sobre él. `ports.ts` es
un hotspot histórico de colisión: el toque de 207 (agregar el port `SettlementLedger` + `remittanceId`)
es aditivo → conflicto de líneas como máximo, no de diseño.

---

## Test Plan

| Test | AC/Riesgo | Wave | Archivo |
|------|-----------|------|---------|
| Flag ON: settle verificado ⇒ `recordPrincipalIn` con {txHash, valueMinor, from, to, quoteId, remittanceId} **antes** de responder | AC-1/CD-13 | W2 | `app/api/settle/principal/route.test.ts` |
| Flag OFF: ledger NUNCA llamado; response body/status byte-idéntico | AC-2/R5 | W2 | `settle/principal/route.test.ts` + `payout/submit/route.test.ts` |
| Flag ON: forward ok/4xx/5xx/timeout ⇒ `recordPayoutOutcome` con status mapeado | AC-3 | W2 | `payout/submit/route.test.ts` |
| `listStale` retorna no-terminales < umbral, excluye terminal/fresh | AC-4 | W1 | `supabase-settlement-ledger.test.ts` |
| Reconcile deriva `idempotencyKey` del registro (`${remittance_id}:${quote_id}`) y aseveras `=== record.idempotency_key` (invariante de dato, no ejecuta retry) | AC-5 | W3 | `reconcile-orphans/route.test.ts` |
| Reconcile sobre una varada ⇒ `markOutcome('manual_review')` con evidencia (txHash/monto/address/quoteId/status/attempts); SIEMPRE, sin reintentar | AC-6/CD-6 | W3 | `reconcile-orphans/route.test.ts` |
| Sin secreto env ⇒ 501; secreto inválido ⇒ 401; válido ⇒ 200 | AC-7/R2 | W3 | `reconcile-orphans/route.test.ts` |
| Migración existe, no aplicada (file-only; no runner en CI) | AC-8/R4 | W0 | check de proceso + presencia de archivo |
| `recordPayoutOutcome`/queries de ruta incluyen `.eq('sender_address', caller)`; otro owner no puede mutar | AC-9/R3 | W1 | `supabase-settlement-ledger.test.ts` |
| Envs ausentes ⇒ `getSettlementLedger()` null ⇒ rutas skip sin throw; flag ON + client null ⇒ graceful | AC-10/R9 | W1 | factory test + route tests |
| **No-doble-pago (trivial por construcción):** el reconcile NUNCA llama a `fetch`/forward — spy sobre `fetch` con 0 llamadas; el mutante que agregue un re-forward debe MORIR | R1/CD-6/CD-18 | W3 | `reconcile-orphans/route.test.ts` |
| Binding nonce: `remittanceId` que no matchea `keccak256(remittanceId:quoteId)` ⇒ no persiste (log), settle OK | DT-3 | W2 | `settle/principal/route.test.ts` |

> Mocks de `fetch`/`Response` con `mockImplementation` (CD-18). `vi.fn` de uniones tipado explícito.
> Verificar por mutación que cada test llega a su rama (CD-18). Gate: `npm run qa` (CD-16).

---

## Plan de Waves (F3)

### Wave 0 — Serial Gate (contratos + esquema + tipos)
- [ ] W0.1: `supabase/migrations/<ts>_create_remittance_settlements.sql` (PENDING-DEPLOY). — §4.2
- [ ] W0.2: `ports.ts` — `SettlementLedger` + `SettlementRecord`/`SettlementLedgerStatus`; `settle` +`remittanceId`.
- [ ] W0.3: `.env.example` — `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SETTLEMENT_LEDGER_ENABLED`, `RECONCILE_ADMIN_SECRET`, `RECONCILE_STALE_THRESHOLD_SECONDS`. (NO `RECONCILE_MAX_ATTEMPTS` ni `RECONCILE_AUTO_RETRY`: el retry-forward está fuera de scope, §10/DT-4.)
- [ ] W0.4: `fakes.ts` — `FakeSettlementLedger`.
- Verificación: `npm run qa` (tsc).

### Wave 1 — Persistence impl (depende de W0)
- [ ] W1.1: `supabase-server.ts` (cliente lazy null-safe). Exemplar: `rate-limit.ts:33-60`.
- [ ] W1.2: `supabase-settlement-ledger.ts` (`implements SettlementLedger` + `getSettlementLedger()` gated; `::text` reads) + tests.
- Verificación: `npm run qa` + tests de ledger/factory.

### Wave 2 — Wiring aditivo en las 2 rutas (depende de W0+W1)
- [ ] W2.1: `http-settlement-gateway.ts` + 1 línea `confirm-and-send.ts` (`remittanceId: s.id`).
- [ ] W2.2: `settle/principal/route.ts` — post-V9, flag-gated, best-effort (try/catch propio) + binding nonce opcional + tests.
- [ ] W2.3: `payout/submit/route.ts` — post-forward, flag-gated, owner-scoped + tests. **Re-basear sobre WKH-205.**
- Verificación: `npm run qa` + route tests + byte-idéntico OFF.

### Wave 3 — Reconcile endpoint (depende de W0+W1)
- [ ] W3.1: `app/api/admin/reconcile-orphans/route.ts` (auth timing-safe, listStale, **solo `manual_review`
  con evidencia — SIN branch de retry-forward**, §10/DT-4) + tests.
- Verificación: `npm run qa` + reconcile tests (no-doble-pago es trivial: el forward NUNCA se reintenta).

### Wave 4 — Integración + QA
- [ ] W4.1: batería completa de ACs + byte-idéntico + ownership + full `npm run qa`.

---

## Readiness Check

```
[x] Cada AC tiene ≥1 archivo asociado en §4.1 y ≥1 test en el Test Plan (AC-1..AC-10)
[x] Cada archivo en §4.1 tiene Exemplar verificado (Glob/Read) — §3 Exemplars
[x] No hay [NEEDS CLARIFICATION] pendientes (DT-1/DT-3/DT-4/umbral/dedupe cerrados; trigger = [TBD] no bloqueante Scope OUT)
[x] Constraint Directives: 10 heredadas + 8 nuevas (>3 PROHIBIDO)
[x] Context Map: 12 archivos leídos con archivo:línea + 2 auto-blindaje
[x] Scope IN/OUT explícitos (§6)
[x] BD: tabla NO existe hoy (verificado) → migración PENDING-DEPLOY diseñada contra Postgres estándar
[x] Happy Path completo (§4.4)
[x] Flujo de error definido (§4.5): flag OFF, DB caída, sin secreto, varada → manual_review
[x] Dep nueva justificada (@supabase/supabase-js, server-only) — §8
[x] Coordinación WKH-205 documentada (§4.10)
[x] Lecciones auto-blindaje incorporadas (CD-12/16/17/18)
```

**READINESS: VERDE.** Listo para SPEC_APPROVED.

---

*SDD generado por NexusAgil — FULL*
