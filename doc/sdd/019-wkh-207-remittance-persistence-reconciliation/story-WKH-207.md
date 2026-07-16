# Story File — [WKH-207] Persistencia server-side + reconciliación de remesas huérfanas

> **Contrato ejecutable para el Dev (F3).** Seguí las waves EN ORDEN (W0→W1→W2→W3→W4). Cada wave es
> autocontenida: **no necesitás abrir el SDD** para implementarla. Si algo NO está acá, PARÁ y escalá al
> Architect — NO inventes APIs, paths ni columnas.
> **Gate de TODA wave: `npm run qa`** (= `tsc --noEmit` + `vitest run`). **NUNCA `npm run build`**
> (excluye los tests → oculta errores de tsc en mocks — lección WKH-196/WKH-168 auto-blindaje#3, CD-16).
> **Branch:** `feat/207-remittance-persistence-reconciliation`.
> SDD: `doc/sdd/019-wkh-207-remittance-persistence-reconciliation/sdd.md`.

---

## 0. Contexto mínimo (leé esto una vez)

Hoy el estado de la remesa vive SOLO en `localStorage` y `ConfirmAndSend.execute()` corre client-side. Si
el browser se cierra entre `principal_in` (USDC YA verificado on-chain adentro) y un estado terminal, la
remesa queda **huérfana, con el dinero adentro y sin forma de reconciliar**. Esta HU construye dos cosas
**sin tocar el guard-order del money-path**:

1. **Persistencia server-side** — un ledger en Postgres **propio de chaski-v2** (Supabase), escrito como
   side-effect **ADITIVO** en `/api/settle/principal` (post-V9) y `/api/a2a/payout/submit` (post-forward).
2. **Reconciliación** — endpoint admin protegido por secreto compartido que detecta remesas varadas y las
   marca **SIEMPRE para resolución `manual_review` con evidencia**. **NUNCA reintenta el forward** ⇒ el
   doble-pago es imposible por construcción. (El retry-forward automático está **FUERA DE SCOPE / DEFERIDO**
   — ver §8: reconstruir el body del forward requiere `beneficiary`/PII que CD-7 prohíbe persistir.)

**Todo es flag-gated y byte-idéntico OFF.** Sin el flag y/o sin la migración aplicada, cada flujo actual
responde **exactamente igual que hoy**. La migración se entrega **PENDING-DEPLOY** (archivo SQL, **NUNCA
aplicada** — la aplica el founder, acción gated).

**CONSTRUÍS, NO ENCENDÉS.** Al terminar F3: flag OFF por default, migración sin aplicar. NO existe
`RECONCILE_AUTO_RETRY` (retry deferido, §8).

**Total: 5 waves (W0→W4) · 6 archivos NUEVOS · 6 archivos MODIFICADOS · tests (≥1 por AC).**

### Coordinación con WKH-205 (crítico — leé antes de W2.3)

WKH-205 (`018`) **mergea PRIMERO** (F3 serial). Cuando llegues a `submit/route.ts`:
- Asumí que `submit/route.ts` **ya trae el fix de 205 mergeado** — re-baseá sobre él.
- WKH-205 SOLO toca la línea `isRecord` (L39-41). **El wiring de 207 NO toca esa línea** — es
  **post-forward** (después del bloque `try` del forward, ~L265+). No hay colisión de diseño, a lo sumo de
  líneas en `ports.ts` (aditivo).

---

## 1. Acceptance Criteria (EARS) — copiados del SDD, QA los verifica en F4

- **AC-1**: WHEN settle verificado on-chain (`verifySettlementOnChain → ok:true`) Y flag ON, THE system
  SHALL escribir el registro server-side (txHash, monto verificado, receiver, sender, quoteId, timestamp)
  ANTES de responder la atestación.
- **AC-2**: WHILE flag OFF (default), THE system SHALL comportarse **byte-idéntico** a pre-HU.
- **AC-3**: WHEN el forward del payout retorna (ok/4xx/5xx/timeout) Y flag ON, THE system SHALL actualizar
  el registro correlacionado con el resultado.
- **AC-4**: WHEN corre la reconciliación, THE system SHALL identificar varadas (settle verificado sin
  resolución terminal tras un umbral configurable).
- **AC-5** (a nivel de dato): THE system SHALL **persistir** el `idempotencyKey`
  (`${remittanceId}:${quoteId}`) como invariante para un retry futuro — PROHIBIDO regenerar. Esta HU
  **NO ejecuta** retry-forward automático (deferido, §8); AC-5 se satisface por dato persistido + contrato.
- **AC-6** (path principal): WHEN corre la reconciliación sobre una varada, THE system SHALL marcar
  **`manual_review` con evidencia** (txHash, monto, address, quoteId, status, attempts) — SIEMPRE, sin
  reintentar el forward. PROHIBIDO asumir éxito, PROHIBIDO desembolsar un 2º pago.
- **AC-7**: THE system SHALL exponer la reconciliación protegida por auth server-side — NUNCA pública.
- **AC-8**: THE system SHALL entregar la migración como archivo **PENDING-DEPLOY**.
- **AC-9**: IF la tabla persiste datos por usuario, THEN THE system SHALL aplicar ownership app-layer + RLS.
- **AC-10**: WHILE migración no aplicada Y/O flag OFF, THE system SHALL degradar con gracia sin romper nada.

---

## 2. Constraint Directives — reglas VERIFICABLES (heredadas del SDD, NO se relajan)

### PROHIBIDO
- **CD-1**: **NO aplicar la migración a NINGUNA DB** (dev/staging/prod). Solo entregás el archivo `.sql`
  PENDING-DEPLOY. NO corras `supabase db push`, `psql`, ningún runner. Sin runner en CI.
- **CD-2**: **NO encender el flag** de persistencia por default. `SETTLEMENT_LEDGER_ENABLED` OFF al terminar
  F3. Byte-idéntico OFF (AC-2) — verificable por test.
- **CD-3**: **NO tocar** el guard-order 1-8 de `submit/route.ts` ni la atestación/PoP. Solo aditivo POST-forward.
- **CD-4**: **NO tocar** el guard-order S1-V9 de `settle/principal` ni broadcast→verify→attest. Solo aditivo tras V9.
- **CD-5**: **NO tocar** la orquestación de `confirm-and-send.ts`. Único toque permitido: **1 argumento
  aditivo** (`remittanceId: s.id`) a la llamada `settle()` existente (L139-145). NO alterás la secuencia.
- **CD-6**: **NO permitir doble-pago.** El reconcile resuelve SIEMPRE a `manual_review` y **NUNCA reintenta
  el forward** (retry deferido, §8) ⇒ el 2º desembolso es imposible por construcción.
- **CD-7**: **NO persistir PII cruda.** Solo evidencia money-path (txHash, montos, address, quoteId, status,
  timestamps). NUNCA documento/fecha de nacimiento/nacionalidad/beneficiary. `last_error` es un **enum estable**, no PII.
- **CD-8**: **NO exponer el reconcile sin auth.** 401 sin credencial; **501 sin secreto configurado**.
- **CD-11**: `supabase-server.ts` / `supabase-settlement-ledger.ts` son **server-only**: PROHIBIDO
  importarlos desde cualquier módulo `"use client"` o componente/browser. Solo route handlers server.
- **CD-12**: Todo `select` de `value_minor` (numeric(78,0)) DEBE castear **`::text`** y parsear en JS —
  precisión uint256 (WKH-196). PROHIBIDO leer `value_minor` como número JSON crudo.
- **CD-13**: El registro del settle se escribe con los **valores verificados on-chain**
  (`verified.valueMinor/from/to/txHash`), NUNCA un eco del body del cliente.
- **CD-15**: el **retry-forward automático está FUERA DE SCOPE** de esta HU — NO implementes
  `RECONCILE_AUTO_RETRY` ni ningún branch que re-forwardee al agente. Doble bloqueo: (a) el agente no
  deduplica por sí mismo, (b) el forward no es reconstruible sin persistir `beneficiary`/PII (CD-7). Toda
  varada ⇒ `manual_review`. Retry deferido a HU futura (§8).
- **CD-17**: **NO poner el I/O de persistencia FUERA del try/catch que degrada.** En las rutas, el persist va
  en su **PROPIO try/catch** que NUNCA rompe el money-path (best-effort). Patrón WKH-168 C3 + WKH-206#1.

### OBLIGATORIO
- **CD-9**: Filtrar por owner (`sender_address`) en TODA query/mutación de la tabla desde `src/`/`app/api/`,
  **salvo** el reconcile admin (global, protegido por secreto).
- **CD-10**: Persistencia = **Supabase PROPIO de chaski-v2**. PROHIBIDO la DB de `wasiai-a2a`.
- **CD-14**: Toda lectura de env del ledger/reconcile (`SETTLEMENT_LEDGER_ENABLED`, `SUPABASE_*`,
  `RECONCILE_*`) ocurre **DENTRO del handler/factory en runtime** — NUNCA en el top-level del módulo.
- **CD-16**: Gate de cada wave = **`npm run qa`**. NUNCA `npm run build`.
- **CD-18** (tests): `mockImplementation` (no `mockResolvedValue`) para cualquier `Response`/stream reusado;
  `vi.fn` con retorno de unión discriminada necesita **tipo explícito**; verificar **por mutación** que el
  test llega a la rama que dice probar.
- **Dep nueva única**: `@supabase/supabase-js`. NINGUNA otra.
- **NO hardcodear** URL/keys/secretos — todo por env server-only.
- **NO tocar** el demo del jurado, `wasiai-facilitator`, `wasiai-a2a`, `wasiai-v2`.

---

## 3. Files to Create/Modify

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `supabase/migrations/<ts>_create_remittance_settlements.sql` | Crear | Tabla + índices + RLS. **PENDING-DEPLOY** (§4, verbatim). | §4 (copiar tal cual) |
| 2 | `src/application/ports.ts` | Modificar | + port `SettlementLedger` + tipos `SettlementRecord`/`SettlementLedgerStatus`; extender `PrincipalSettlementGateway.settle` input con `remittanceId: string`. | `RemittanceRepository`, `PrincipalSettlementGateway` (mismo archivo) |
| 3 | `src/infrastructure/persistence/supabase-server.ts` | Crear | Cliente Supabase lazy memoizado server-only, `null` si faltan envs. | `src/infrastructure/rate-limit.ts:33-60` |
| 4 | `src/infrastructure/persistence/supabase-settlement-ledger.ts` | Crear | `SupabaseSettlementLedger implements SettlementLedger` + factory `getSettlementLedger()` (null si OFF/unconfigured). Reads con `::text` (CD-12). | `persistence.ts` + `rate-limit.ts` |
| 5 | `src/infrastructure/settlement/http-settlement-gateway.ts` | Modificar | Enviar `remittanceId` en el body del POST a `/api/settle/principal` (aditivo). | archivo actual (L87-93) |
| 6 | `src/application/use-cases/confirm-and-send.ts` | Modificar (1 línea) | Pasar `remittanceId: s.id` en `settle({...})` (L139-145). NO toca guard-order (CD-5). | L120 (ya pasa `s.id`) |
| 7 | `app/api/settle/principal/route.ts` | Modificar (aditivo post-V9) | Flag-gated: leer/validar `body.remittanceId`, binding nonce opcional, `ledger.recordPrincipalIn(...)` best-effort ANTES de responder. Sin tocar S1-V9 (CD-4). | patrón L179-215 |
| 8 | `app/api/a2a/payout/submit/route.ts` | Modificar (aditivo post-forward) | Flag-gated: `ledger.recordPayoutOutcome(...)` owner-scoped tras el forward. Sin tocar guards 1-8 (CD-3). **Re-basear sobre WKH-205.** | patrón forward L267-283 |
| 9 | `app/api/admin/reconcile-orphans/route.ts` | Crear | POST protegido por secreto compartido timing-safe. listStale → **`markOutcome('manual_review')` con evidencia** (SIN branch de retry-forward, §8). | `submit/route.ts` guard-order + `attestation.ts:68-73` |
| 10 | `.env.example` | Modificar | Documentar las 7 envs nuevas (§W0.3). | tail (bloque WKH-186) |
| 11 | `src/test-support/fakes.ts` | Modificar | + `FakeSettlementLedger` (in-memory). | `InMemoryRepo` fakes.ts:70 |
| 12 | Tests (`*.test.ts`) | Crear/Modificar | ≥1 por AC (§Test Expectations). | tests de ruta existentes |

---

## 4. Migración SQL — COPIAR VERBATIM (PENDING-DEPLOY, NO aplicar — CD-1/AC-8)

> Nombre del archivo: `supabase/migrations/<ts>_create_remittance_settlements.sql` donde `<ts>` es el
> timestamp de creación (ej. `20260716T000000`). **NO existe `supabase/` en el repo hoy — es la primera
> migración.** El archivo se entrega y NADA MÁS: no lo apliques, no lo corras, no lo pongas en CI.

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

-- RLS defensa en profundidad (AC-9/CD-9). La app usa SUPABASE_SERVICE_ROLE_KEY (BYPASSRLS) ⇒ el guard
-- REAL es el filtro app-layer `.eq('sender_address', <caller>)`. RLS protege ante un client anon-key.
alter table public.remittance_settlements enable row level security;
-- Sin policy permisiva ⇒ deny-all para roles no-service (fail-closed). El service key opera igual.
```

**FSM del ledger** (independiente de la FSM del dominio):

| status | Significado | Terminal p/ reconcile |
|--------|-------------|-----------------------|
| `principal_in` | Settle verificado escrito; forward aún no registrado (candidato #1 a varado) | NO |
| `submitted` | Forward reenviado, respuesta `submitted` del agente | NO |
| `forward_error` | Forward falló/timeout (AMBIGUO si el agente lo recibió) | NO |
| `settled` | Forward confirmado `settled` | SÍ |
| `failed` | Forward retornó `failed`/`blocked` explícito | SÍ (no reintentable) |
| `manual_review` | La reconciliación no pudo resolver → humano (AC-6) | SÍ |

---

## 5. Contratos exactos (del SDD §4.3) — COPIAR, NO reinventar

### Port `SettlementLedger` + tipos (ports.ts, aditivo, mismo estilo que `RemittanceRepository`)

```ts
export type SettlementLedgerStatus =
  | 'principal_in' | 'submitted' | 'settled' | 'failed' | 'forward_error' | 'manual_review';

export interface SettlementRecord {
  id: string;
  remittanceId: string;
  quoteId: string;
  idempotencyKey: string;
  txHash: string;
  chainId: number;
  senderAddress: string;
  receiverAddress: string;
  valueMinor: number;          // parseado desde value_minor::text (CD-12)
  status: SettlementLedgerStatus;
  attempts: number;
  payoutId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SettlementLedger {
  // settle route (AC-1): upsert por tx_hash (ON CONFLICT DO NOTHING), status principal_in.
  recordPrincipalIn(input: {
    remittanceId: string; quoteId: string; idempotencyKey: string; txHash: string;
    chainId: number; senderAddress: string; receiverAddress: string; valueMinor: number;
  }): Promise<void>;
  // submit route (AC-3): UPDATE owner-scoped por (idempotencyKey, senderAddress).
  recordPayoutOutcome(input: {
    idempotencyKey: string; senderAddress: string;
    status: SettlementLedgerStatus; payoutId?: string | null; error?: string | null;
  }): Promise<void>;
  // reconcile (AC-4): no-terminales más viejas que olderThanIso. Global (admin) — sin owner filter.
  listStale(input: { olderThanIso: string; limit: number }): Promise<SettlementRecord[]>;
  // reconcile (AC-6): incrementa attempts + set status/last_error. Por id.
  markOutcome(input: {
    id: string; status: SettlementLedgerStatus; payoutId?: string | null;
    error?: string | null; incrementAttempt: boolean;
  }): Promise<void>;
}
```

Extensión de `PrincipalSettlementGateway.settle` input (aditivo, mismo bloque L142-153):

```ts
settle(input: {
  authorization: Eip3009Authorization;
  signature: string;
  address: string;
  quoteId: string;
  expectedValueMinor: number;
  remittanceId: string;   // ← NUEVO (aditivo). El cliente ya tiene s.id.
}): Promise< ... >   // el return NO cambia
```

### Factory `getSettlementLedger(): SettlementLedger | null`
Devuelve `null` cuando `process.env.SETTLEMENT_LEDGER_ENABLED !== "true"` **O** el cliente Supabase es
`null` (envs ausentes). Las rutas hacen:
```ts
const ledger = getSettlementLedger();
if (ledger) { try { await ledger.recordX(...); } catch (e) { console.error("[ledger] <enum>", e); } }
// si !ledger ⇒ skip total ⇒ byte-idéntico (AC-2/AC-10)
```

### Mapeo forward-result → status (submit route, AC-3)
| Resultado del forward | status |
|-----------------------|--------|
| `res.ok` + shape válido + `result.status === "settled"` | `settled` |
| `res.ok` + shape válido + `result.status === "submitted"` | `submitted` |
| `res.ok` + shape válido + `result.status === "failed"`/`"blocked"` | `failed` |
| `!res.ok` (upstream 4xx/5xx) | `forward_error` |
| shape inválido (`a2a_bad_shape`) | `forward_error` |
| `catch` (timeout/DNS/parse) | `forward_error` |

---

## 6. Waves

### Wave -1: Environment Gate (verificar ANTES de tocar código)
```bash
cd /home/ferdev/.openclaw/workspace/chaski-v2
npm install 2>/dev/null || echo "revisar package.json"
# Verificar que los archivos base del Scope IN existen:
ls src/application/ports.ts src/infrastructure/rate-limit.ts \
   src/infrastructure/settlement/attestation.ts \
   app/api/settle/principal/route.ts app/api/a2a/payout/submit/route.ts \
   src/infrastructure/settlement/http-settlement-gateway.ts \
   src/application/use-cases/confirm-and-send.ts src/test-support/fakes.ts .env.example 2>/dev/null \
   || echo "FALTA archivo base — PARAR"
# Confirmar que WKH-205 ya está mergeado en submit/route.ts (isRecord L39-41) antes de W2.3.
git log --oneline -5
```
**Si algo falla:** PARAR y reportar al orquestador. No implementar sobre entorno roto.

---

### Wave 0 — Serial Gate (contratos + esquema + tipos). NO toca lógica existente.
- [ ] **W0.1** — Crear `supabase/migrations/<ts>_create_remittance_settlements.sql` — **COPIAR VERBATIM §4**.
  **NO aplicar** (CD-1). Es solo un archivo.
- [ ] **W0.2** — `ports.ts`: agregar `SettlementLedgerStatus`, `SettlementRecord`, `SettlementLedger`
  (§5, aditivo, después de `RemittanceRepository`) + agregar `remittanceId: string` al input de
  `PrincipalSettlementGateway.settle`. **NO** cambiar el return de `settle`.
- [ ] **W0.3** — `.env.example`: agregar un bloque nuevo `# ── Settlement ledger + reconciliación (WKH-207) ──`
  al final con las **5 envs** (todas server-only, SIN `NEXT_PUBLIC_`, todas vacías por default). **NO
  agregues `RECONCILE_MAX_ATTEMPTS` ni `RECONCILE_AUTO_RETRY`** — el retry-forward está fuera de scope (§8):
  ```
  SUPABASE_URL=
  SUPABASE_SERVICE_ROLE_KEY=
  SETTLEMENT_LEDGER_ENABLED=            # "true" para encender (default OFF = byte-idéntico, CD-2)
  RECONCILE_ADMIN_SECRET=              # ausente ⇒ /reconcile-orphans responde 501 (CD-8)
  RECONCILE_STALE_THRESHOLD_SECONDS=   # default 900 (15 min)
  ```
- [ ] **W0.4** — `fakes.ts`: agregar `FakeSettlementLedger implements SettlementLedger` (in-memory,
  patrón `InMemoryRepo` fakes.ts:70). Guardá los records en un `Map`; `listStale` filtra por status
  no-terminal + `updatedAt < olderThanIso`; `markOutcome`/`recordPayoutOutcome` mutan por id/owner.
- **Gate**: `npm run qa` (tsc verde). **DoD W0**: tipos compilan; migración presente (no aplicada); fake compila.

---

### Wave 1 — Persistence impl (depende de W0)
- [ ] **W1.1** — Crear `src/infrastructure/persistence/supabase-server.ts`.
  **Exemplar exacto: `rate-limit.ts:33-60`.** Factory memoizada (`let cached: SupabaseClient | null = null`),
  lee `process.env.SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` **DENTRO** de la fn (CD-14), `return null` si
  faltan. `createClient(url, key, { auth: { persistSession: false } })`. **Server-only (CD-11).** Exportá
  también `__resetSupabaseClient()` para tests (patrón `__resetKycRateLimitClient`).
- [ ] **W1.2** — Crear `src/infrastructure/persistence/supabase-settlement-ledger.ts`:
  - `class SupabaseSettlementLedger implements SettlementLedger` — usa el cliente de W1.1.
  - `recordPrincipalIn`: `insert` con `onConflict: 'tx_hash'` ignore (upsert idempotente), `status='principal_in'`.
    Escribí `sender_address`/`receiver_address` **lowercased**.
  - `recordPayoutOutcome`: **UPDATE owner-scoped** — `.eq('idempotency_key', ...).eq('sender_address', <lower>)`
    (CD-9). Set `status`, `payout_id`, `last_error`, `updated_at = now()`.
  - `listStale`: `select` con **`value_minor::text`** (CD-12) — ej.
    `.select('id, remittance_id, quote_id, idempotency_key, tx_hash, chain_id, sender_address, receiver_address, value_minor::text, status, attempts, payout_id, last_error, created_at, updated_at')`;
    filtro `.in('status', ['principal_in','submitted','forward_error']).lt('updated_at', olderThanIso).limit(limit)`.
    Parseá `value_minor` (string) → `number` en JS al mapear a `SettlementRecord`.
  - `markOutcome`: UPDATE por `id`; `incrementAttempt` ⇒ `attempts = attempts + 1` (usá una RPC/`raw` o
    lee-incrementa-escribe; si lee-incrementa, seguí owner-agnóstico porque es admin).
  - Factory `getSettlementLedger(): SettlementLedger | null` — `null` si `SETTLEMENT_LEDGER_ENABLED !== "true"`
    o si el cliente Supabase es `null` (§5). Lee la env **DENTRO** (CD-14).
  - **Tests** (`supabase-settlement-ledger.test.ts`): mockeá el cliente Supabase (chainable builder).
    Cubrí: (a) `listStale` retorna no-terminales < umbral, **excluye** terminal/fresh (AC-4); (b)
    `recordPayoutOutcome`/queries incluyen `.eq('sender_address', caller)` — otro owner **no** puede mutar
    (AC-9/R3); (c) el select de `listStale` contiene `value_minor::text` (CD-12); (d) factory devuelve
    `null` con flag OFF y con envs ausentes (AC-10).
- **Gate**: `npm run qa` + tests de ledger/factory. **DoD W1**: ledger implementado; owner-scope verificado;
  `::text` presente; factory null-safe.

---

### Wave 2 — Wiring aditivo en las 2 rutas (depende de W0+W1)
- [ ] **W2.1** — `http-settlement-gateway.ts` (L87-93): agregar `remittanceId: input.remittanceId` al
  `JSON.stringify` del body + agregar `remittanceId: string` al input de `settle`. Y
  `confirm-and-send.ts` (L139-145): agregar **1 línea** `remittanceId: s.id,` a la llamada `settle({...})`.
  **NO tocar nada más de confirm-and-send** (CD-5).
- [ ] **W2.2** — `settle/principal/route.ts` — **post-V9, aditivo** (después de emitir `attestation`,
  ANTES del `return` L206). En su **PROPIO try/catch** (CD-17):
  ```ts
  const ledger = getSettlementLedger();        // CD-14: leído en runtime
  if (ledger) {
    try {
      const remittanceId = parsed.remittanceId;
      if (typeof remittanceId === "string" && remittanceId.trim()) {
        // Binding nonce OPCIONAL (defensa en profundidad, DT-3): si NO matchea, NO persiste esa fila (log), settle OK.
        // keccak256(toBytes(`${remittanceId}:${quoteId}`)) === nonce   (patrón wallet.ts:37-39, viem)
        // Si matchea (o decidís no bloquear por mismatch → solo loguear):
        await ledger.recordPrincipalIn({
          remittanceId, quoteId, idempotencyKey: `${remittanceId}:${quoteId}`,
          txHash: verified.txHash, chainId,
          senderAddress: verified.from, receiverAddress: verified.to,   // CD-13: valores VERIFICADOS, no eco del body
          valueMinor: verified.valueMinor,
        });
      }
    } catch (e) { console.error("[ledger] recordPrincipalIn_failed", e); } // best-effort, NUNCA rompe (CD-17/DT-5)
  }
  return NextResponse.json({ ... }, { status: 200 });   // ← respuesta IGUAL que hoy
  ```
  - **NO tocar** S1-V9 (CD-4). El persist va DESPUÉS de la atestación y ANTES del return.
  - **CD-13**: usá `verified.from`/`verified.to`/`verified.valueMinor`/`verified.txHash`, NUNCA el body.
  - Binding nonce: `nonce` está disponible (auth, L82). Import `keccak256, toBytes` de `viem`. Si el
    `remittanceId` declarado no matchea el nonce firmado → **no persistas** esa fila + `console.error` (no
    rompas el settle).
  - **Tests** (`settle/principal/route.test.ts`): (a) flag ON ⇒ `recordPrincipalIn` llamado con
    `{txHash, valueMinor, from, to, quoteId, remittanceId}` **verificados** ANTES de responder (AC-1/CD-13);
    (b) flag OFF ⇒ ledger **NUNCA** llamado, body/status **byte-idéntico** (AC-2); (c) binding nonce
    mismatch ⇒ **no persiste** (log), settle responde 200 (DT-3); (d) ledger `recordPrincipalIn` throw ⇒
    settle **igual responde 200** (CD-17).
- [ ] **W2.3** — `payout/submit/route.ts` — **post-forward, aditivo** (después del bloque `try` del forward
  ~L267-283). **Re-basear sobre WKH-205** (ver §0). Registrá el outcome **owner-scoped** en su propio
  try/catch, mapeando el resultado (tabla §5). El persist NO debe cambiar la respuesta:
  ```ts
  // dentro/después del forward, capturar el status mapeado y hacer, en su propio try/catch:
  const ledger = getSettlementLedger();
  if (ledger) {
    try {
      const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
      if (idempotencyKey) {
        await ledger.recordPayoutOutcome({
          idempotencyKey, senderAddress: address,   // CD-9: owner = address ya validado
          status: <mapForwardResult>, payoutId: <result.payoutId ?? null>, error: <enum|null>,
        });
      }
    } catch (e) { console.error("[ledger] recordPayoutOutcome_failed", e); }
  }
  ```
  - **NO tocar** guards 1-8 (CD-3). NO tocar la línea `isRecord` L39-41 (es de WKH-205).
  - `address` = L78 (ya validado por los guards). `body.idempotencyKey` se forwardea tal cual (L271).
  - **Tests** (`payout/submit/route.test.ts`): (a) flag ON ⇒ forward ok/4xx/5xx/timeout ⇒
    `recordPayoutOutcome` con status mapeado (AC-3); (b) flag OFF ⇒ ledger NUNCA llamado, response
    byte-idéntico (AC-2). Mocks de `fetch`/`Response` con **`mockImplementation`** (CD-18).
- **Gate**: `npm run qa` + route tests + **byte-idéntico OFF**. **DoD W2**: wiring aditivo; money-path
  intacto; flag OFF byte-idéntico verificado por test.

---

### Wave 3 — Reconcile endpoint (depende de W0+W1) — SOLO `manual_review`, SIN retry-forward (§8)
- [ ] **W3.1** — Crear `app/api/admin/reconcile-orphans/route.ts` (POST). Estructura fail-closed:
  1. **Auth (AC-7/CD-8)**: `const secret = process.env.RECONCILE_ADMIN_SECRET` (CD-14). Ausente ⇒ **501**
     (no configurado). Leer header `authorization: Bearer <secret>` (o `x-reconcile-secret`). Comparar con
     **`timingSafeEqual`** (patrón `attestation.ts:68-73`: longitud primero, luego `timingSafeEqual` sobre
     Buffers). Mismatch/ausente ⇒ **401**.
  2. **listStale**: `olderThanIso = new Date(Date.now() - RECONCILE_STALE_THRESHOLD_SECONDS*1000).toISOString()`
     (default 900s), `limit` acotado. `const ledger = getSettlementLedger(); if (!ledger) return 501/200`
     graceful (flag OFF).
  3. Por cada varada: **derivar** `idempotencyKey = \`${record.remittanceId}:${record.quoteId}\`` y
     **aseverar** `=== record.idempotencyKey` (AC-5, invariante de dato — NUNCA regenerar). Es solo una
     verificación de consistencia; **no dispara ninguna acción de forward**.
  4. **Resolución = SOLO `manual_review` (AC-6/CD-6/CD-15)**: por cada varada,
     `markOutcome({ id: record.id, status: 'manual_review', incrementAttempt: true })` con la evidencia ya
     persistida (txHash, monto, address, quoteId, status, attempts). **NO reintentes el forward. NO llames
     a `fetch`/al agente. NO implementes `RECONCILE_AUTO_RETRY`.** El retry-forward está deferido (§8).
  5. **Respuesta**: conteos agregados `{ scanned, manualReview }` — **NUNCA PII ni montos/addresses de
     terceros** (CD-7).
  - **Tests** (`reconcile-orphans/route.test.ts`): (a) sin secreto env ⇒ 501; secreto inválido ⇒ 401;
    válido ⇒ 200 (AC-7/R2); (b) reconcile deriva el `idempotencyKey` del registro y aseveras
    `=== record.idempotencyKey` (AC-5, invariante de dato); (c) toda varada ⇒ `markOutcome('manual_review')`
    con evidencia, SIEMPRE (AC-6/CD-6); (d) **No-doble-pago (trivial por construcción)**: `fetch` está
    **spy-eado con 0 llamadas** — el reconcile NUNCA re-forwardea. **El test debe MATAR el mutante**: si un
    dev agregara un `fetch`/re-forward, el assert de "0 llamadas a fetch" tiene que fallar (CD-18).
- **Gate**: `npm run qa` + reconcile tests. **DoD W3**: auth 501/401/200; toda varada → `manual_review`;
  cero llamadas a `fetch` (mutante que agregue re-forward muere).

---

### Wave 4 — Integración + QA full
- [ ] **W4.1** — Batería completa: todos los ACs cubiertos, byte-idéntico OFF, ownership app-layer,
  precisión `::text`. Corré **`npm run qa` full** (tsc + vitest run). **CONTÁ los tests ejecutando**
  (no asumas que corren): el mutante fail-open del no-doble-pago debe morir. Confirmá que al final:
  flag OFF, migración sin aplicar, y que el reconcile NO reintenta el forward (no existe `RECONCILE_AUTO_RETRY`, §8).
- **DoD W4**: `npm run qa` verde; AC-1..AC-10 con test; CDs respetadas.

### Verificación incremental
| Wave | Verificación |
|------|--------------|
| W0 | `npm run qa` (tsc verde); migración presente NO aplicada |
| W1 | `npm run qa` + tests ledger/factory (owner-scope, `::text`, null-safe) |
| W2 | `npm run qa` + route tests + byte-idéntico OFF |
| W3 | `npm run qa` + reconcile tests (auth + no-doble-pago mutación) |
| W4 | full `npm run qa` + conteo de tests |

---

## 7. Test Expectations

| Test | ACs/Riesgo | Wave | Archivo |
|------|-----------|------|---------|
| Flag ON: settle verificado ⇒ `recordPrincipalIn` con valores verificados ANTES de responder | AC-1/CD-13 | W2 | `app/api/settle/principal/route.test.ts` |
| Flag OFF: ledger NUNCA llamado; response byte-idéntico | AC-2/R5 | W2 | `settle/principal/route.test.ts` + `payout/submit/route.test.ts` |
| Flag ON: forward ok/4xx/5xx/timeout ⇒ `recordPayoutOutcome` status mapeado | AC-3 | W2 | `payout/submit/route.test.ts` |
| `listStale` retorna no-terminales < umbral, excluye terminal/fresh | AC-4 | W1 | `supabase-settlement-ledger.test.ts` |
| Reconcile deriva el idempotencyKey del registro y aseveras `=== record.idempotencyKey` (invariante de dato, no ejecuta retry) | AC-5 | W3 | `reconcile-orphans/route.test.ts` |
| Toda varada ⇒ `markOutcome('manual_review')` con evidencia; SIEMPRE, sin reintentar | AC-6/CD-6 | W3 | `reconcile-orphans/route.test.ts` |
| Sin secreto ⇒ 501; inválido ⇒ 401; válido ⇒ 200 | AC-7/R2 | W3 | `reconcile-orphans/route.test.ts` |
| Migración existe, no aplicada (file-only) | AC-8/R4 | W0 | check de proceso + presencia de archivo |
| Queries de ruta incluyen `.eq('sender_address', caller)`; otro owner no muta | AC-9/R3 | W1 | `supabase-settlement-ledger.test.ts` |
| Envs ausentes ⇒ `getSettlementLedger()` null ⇒ rutas skip sin throw | AC-10/R9 | W1 | factory test + route tests |
| **No-doble-pago (trivial)**: el reconcile NUNCA llama a `fetch`/forward — spy con 0 llamadas (**mutante que agregue re-forward muere**) | R1/CD-6/CD-18 | W3 | `reconcile-orphans/route.test.ts` |
| Binding nonce: `remittanceId` que no matchea `keccak256` ⇒ no persiste (log), settle OK | DT-3 | W2 | `settle/principal/route.test.ts` |
| `::text` presente en select de `value_minor` | CD-12 | W1 | `supabase-settlement-ledger.test.ts` |

**Reglas de test (CD-18):** `mockImplementation` (no `mockResolvedValue`) para `Response`/stream reusado;
`vi.fn` con retorno de unión discriminada → tipo explícito; verificar **por mutación** que cada test llega
a la rama que dice probar; **contar** los tests ejecutando. Gate: `npm run qa` (CD-16).

---

## 8. Retry-forward DEFERIDO (resolución del SDD-GAP-1, aprobada por el orquestador)

**Decisión cerrada — NO reabrir:** el **retry-forward automático de la reconciliación queda FUERA DE SCOPE
de esta HU**. NO implementes `RECONCILE_AUTO_RETRY` ni ningún branch que re-forwardee al agente.

**Por qué (doble bloqueo money-safe):**
1. **El agente no deduplica** por sí mismo (verificado en `wasiai-remittance-agents`): reintentar un forward
   AMBIGUO reabriría el vector de doble-pago.
2. **El forward no es reconstruible** desde el ledger: el body del forward al agente
   (`submit/route.ts:271`) **incluye `beneficiary` (PII)**, que **CD-7 PROHÍBE persistir** y la tabla
   `remittance_settlements` NO guarda. Reconstruirlo exigiría inventar/derivar el `beneficiary` → violaría
   CD-7 y podría desembolsar a un destino equivocado.

**Lo que SÍ construís (100% money-safe, implementable con los datos persistidos):**
- El reconcile detecta varadas (`listStale`) y marca **SIEMPRE `manual_review` con evidencia** (txHash,
  monto, address, quoteId, status, attempts). Un humano resuelve fuera de banda.
- El `idempotencyKey` (`${remittanceId}:${quoteId}`) queda **persistido y documentado** como invariante
  para el retry futuro (AC-5 a nivel de dato), pero **NO se ejecuta ningún retry**.

**PROHIBIDO en el reconcile:** llamar a `fetch`, re-forwardear al agente, inventar/derivar `beneficiary`,
crear la env `RECONCILE_AUTO_RETRY`. Si creés que necesitás una columna nueva o una fuente de `beneficiary`
→ **PARÁ y escalá al Architect** (es cambio de diseño/scope, no una decisión del Dev). El retry se retoma
en una HU futura que decida la política de manejo de `beneficiary`.

---

## 9. Contrato de Integración ⚠️ BLOQUEANTE

### Cliente (`http-settlement-gateway.ts`) → `POST /api/settle/principal`
**Request (aditivo — se agrega `remittanceId`):**
```json
{
  "authorization": "Eip3009Authorization — igual que hoy",
  "signature": "string 0x-hex — igual que hoy",
  "address": "string 0x address — igual que hoy",
  "quoteId": "string — igual que hoy",
  "expectedValueMinor": "number entero >=1 — igual que hoy",
  "remittanceId": "string no-vacío — NUEVO (= s.id del cliente)"
}
```
**Response**: **SIN CAMBIOS** (200 `{txHash, valueMinor, from, to, attestation}`; enums de error iguales).
El `remittanceId` solo se usa server-side para el ledger (flag ON). Con flag OFF se **ignora** (byte-idéntico).

### Reconcile admin → `POST /api/admin/reconcile-orphans`
**Request**: header `authorization: Bearer <RECONCILE_ADMIN_SECRET>` (o `x-reconcile-secret`). Body vacío/opcional.
**Response exitoso (200):** `{ "scanned": number, "manualReview": number }` (sin `retried`/`settled`: el reconcile no reintenta, §8)
**Errores:**
| HTTP | Cuándo |
|---|---|
| 501 | `RECONCILE_ADMIN_SECRET` ausente (no configurado) — CD-8 |
| 401 | secreto ausente/inválido en el header — CD-8 |
| 200 | ejecutado (aunque `scanned=0`) |

> NUNCA PII, montos ni addresses de terceros en la respuesta (CD-7).

---

## 10. Out of Scope (NO tocar bajo ninguna circunstancia)
- **Aplicar la migración** a cualquier DB (CD-1). Solo el archivo.
- **Encender flags** por default (CD-2/CD-15).
- Guard-order de submit (1-8) / settle (S1-V9) + orquestación de `confirm-and-send` (salvo el arg aditivo).
- Clawback on-chain real (heredado WKH-168/DT-8).
- Automatizar el disparo (cron/Vercel Cron/GitHub Actions) — se entrega invocable.
- UI de estado de reconciliación.
- Habilitar payout real / TransFi ready.
- `wasiai-facilitator` / `wasiai-a2a` / `wasiai-v2` y el demo del jurado.
- Persistir `beneficiary` u otra PII (CD-7).
- Deps npm nuevas salvo `@supabase/supabase-js`.
- NO "mejorar" código adyacente. NO refactors no solicitados.

---

## 11. Escalation Rule
> **Si algo no está en este Story File, PARÁ y escalá al Architect.** No inventes, no asumas, no improvises.

Situaciones de escalation:
- Un archivo del exemplar ya no existe (o WKH-205 aún no mergeó en `submit/route.ts`).
- Un import que necesitás no está disponible.
- La tabla tendría columnas distintas a §4 (ej. necesitás `beneficiary` → ver [SDD-GAP] §8).
- Ambigüedad en un AC o en el binding nonce.
- El cambio requiere tocar archivos fuera de la tabla §3.

---

*Story File generado por NexusAgil — F2.5 · WKH-207*
