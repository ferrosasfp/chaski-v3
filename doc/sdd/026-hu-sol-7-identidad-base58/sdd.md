# SDD #026: [WKH-213 / HU-SOL-7] Identidad multi-VM (address base58) — GATE DE SEGURIDAD (IDOR)

> SPEC_APPROVED: no
> Fecha: 2026-07-21
> Tipo: improvement (money-path + gate de seguridad IDOR)
> SDD_MODE: full
> Branch: `feat/026-hu-sol-7-identidad-base58`
> Artefactos: `doc/sdd/026-hu-sol-7-identidad-base58/`
> Gate previo: HU_APPROVED (cumplido). AR OBLIGATORIO tras F3 (gate de seguridad).

---

## 1. Resumen

`.toLowerCase()` es correcto para EVM (checksum case-insensitive) pero **corrompe base58**: Solana es
case-sensitive y dos pubkeys distintas pueden colapsar al mismo string lowercaseado. Como el guard de
ownership real de este repo es app-layer (`.eq('sender_address', <caller>)` con `SUPABASE_SERVICE_ROLE_KEY`
= BYPASSRLS), lowercasear una pubkey Solana abre un **IDOR cross-tenant** (un pagador Solana muta la fila
de otro) y rompe el **KYC-once** (una wallet recibe el KYC de otra por colisión de clave).

Esta HU introduce un helper único **VM-aware** `canonicalizeAddress(address, vm)` y reemplaza los **15
sitios lógicos** (25 invocaciones `.toLowerCase()` sobre address/owner, 9 archivos) por él, sin cambiar
NADA observable en EVM (byte-idéntico, CD-2/AC-5), y migra aditivamente `remittance_settlements.chain_id`
hacia una identidad de red que también sirva a Solana (Opción A, DT-3). No wirea Solana en runtime
(Scope OUT); es un refactor de canonicalización + tipos/migración que **desbloquea** HU-SOL-8 (PoP
ed25519) y HU-SOL-9 (settle no-custodial Solana).

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 026 / WKH-213 / HU-SOL-7 |
| **Tipo** | improvement (seguridad, money-path) |
| **SDD_MODE** | full |
| **Objetivo** | Canonicalización de address VM-aware en los 15 sitios reales + migración aditiva de `chain_id` a identidad de red, cerrando el IDOR base58 (CR-2) SIN cambiar el comportamiento EVM. |
| **Reglas de negocio** | EVM byte-idéntico (CD-2). Solana case-sensitive (nunca `.toLowerCase()`). `vm` SIEMPRE explícito, nunca inferido por shape (CD-4). Guard-order money-path intacto (CD-8). Migración aditiva PENDING-DEPLOY (CD-6). |
| **Scope IN** | Ver §6 IN — helper nuevo + 15 sitios + migración + `vm` en el ledger + tests IDOR. |
| **Scope OUT** | Ver §6 OUT — PoP ed25519 (SOL-8), settle Solana (SOL-9), nonce bytes32 (AC-9), wallet Solana (SOL-2), aplicar la migración (founder). |
| **Missing Inputs** | Resueltos en F2 (ver §10). Sin bloqueantes. |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1** WHEN se llama `canonicalizeAddress(address, vm)`, THE system SHALL normalizar con `.toLowerCase()`
  si `vm==='evm'` (byte-idéntico) y preservar el casing base58 exacto validando con `PublicKey` si
  `vm==='solana'`.
- **AC-2** WHEN se canonicaliza una pubkey Solana mixed-case, THE system SHALL producir un valor que
  conserva el case (NUNCA colapsa al lowercase) — verificado con `canonicalizeAddress(K,'solana') !== K.toLowerCase()`.
- **AC-3** WHEN `recordPayoutOutcome` filtra por `sender_address`, THE system SHALL canonicalizar
  `senderAddress` con el `vm` correcto ANTES del `.eq(...)` (guard CD-9 real intacto).
- **AC-4** WHEN `LocalKycStore.get/save/clear` opera sobre una wallet, THE system SHALL usar SIEMPRE la
  MISMA clave canónica para esa wallet en las tres operaciones (round-trip íntegro; otra clave → `null`).
- **AC-5** WHILE la VM activa es `evm`, THE system SHALL producir el mismo comportamiento observable que
  hoy en los 9 archivos — la suite existente pasa SIN cambios de expectativa.
- **AC-6** IF `canonicalizeAddress` recibe un `vm` desconocido O una address Solana malformada, THEN THE
  system SHALL fallar fail-loud (throw). (EVM: ver DT-1b — supremacía de CD-2.)
- **AC-7** THE system SHALL reemplazar los 25 usos de `.toLowerCase()` sobre address/owner (15 sitios,
  EXCLUYENDO el nonce bytes32) por `canonicalizeAddress(address, vm)` — sin `.toLowerCase()` crudo residual.
- **AC-8** THE system SHALL migrar aditivamente `remittance_settlements.chain_id` hacia un shape que
  represente también una red Solana (Opción A), marcada `-- PENDING-DEPLOY`.
- **AC-9** WHILE `settle/principal/route.ts:263` compara un nonce bytes32, THE system SHALL dejarlo intacto.

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/infrastructure/chain.ts` | Exemplar del fail-loud Solana + hogar de `resolveActiveVm` | `resolveSolanaUsdcMint` (L135-143): `new PublicKey(raw)` en try/catch → throw. `resolveActiveVm()` (L121-126): `NEXT_PUBLIC_VM` unset→`'evm'`, `'solana'` explícito, otro→throw. Ya importa `PublicKey` de `@solana/web3.js` y `isAddress` de viem. |
| `src/infrastructure/persistence/supabase-settlement-ledger.ts` | Sitio #1 (3 sitios, 5 invocaciones); guard CD-9 real (L163) | SERVER-ONLY (BYPASSRLS). `recordPayoutOutcome` (L159-164): `.eq('idempotency_key').eq('sender_address', input.senderAddress.toLowerCase())`. Inserts L104/105/134/135 lowercasean. Métodos reciben `chainId:number`, NO `vm`. |
| `supabase/migrations/20260716T000000_create_remittance_settlements.sql` | Base de la migración AC-8 | `chain_id integer not null` (L9). Header `-- PENDING-DEPLOY` (L1-2). `sender_address text not null` (owner). RLS deny-all (L34-35). Patrón: la aplica el founder. |
| `src/infrastructure/persistence.ts` | Sitio #2 (`list`/`clearByOwner`) | `target = address.toLowerCase()` + `s.ownerAddress.toLowerCase() === target` (L119/121, L129/132). Client-side (localStorage). Owners de test no-hex (`"0xAAA"`). |
| `src/infrastructure/kyc-store.ts` | Sitio #3 (KYC-once, `get`/`save`/`clear`) | Clave del Record = `address.toLowerCase()` (L91/99/116). Client-side. |
| `src/infrastructure/payout/authority.ts` | Sitio #4 (ownership Didit) | L83: `d.vendorData.toLowerCase() !== address.toLowerCase()`. Server-only. Comentario ya asume "direcciones EVM". |
| `app/api/a2a/payout/submit/route.ts` | Sitio #5 (PoP P3 + atestación A7) | L143 `ch.address.toLowerCase() !== address.toLowerCase()`; L223 `att.from.toLowerCase() !== address.toLowerCase()`. `address` sólo validado no-vacío (L80-83), NO `isAddress`. Guard-order WKH-202/168/206. Importa `resolveChainId`. |
| `app/api/payout/prepare/route.ts` | Sitio #6 (PoP) | L127 `ch.address.toLowerCase() !== address.toLowerCase()`. |
| `app/api/a2a/payout/challenge/route.ts` | Sitio #7 (emisor PoP) | L54 `if(!isAddress(address)) 400` ANTES de L61 `const addr = address.toLowerCase()` (address YA válida acá). |
| `src/presentation/flow-vm.ts` | Sitio #8 (`isFallbackWalletAddress`, UI) | L28 `address.toLowerCase() === FALLBACK_WALLET_ADDRESS.toLowerCase()`. `FALLBACK_WALLET_ADDRESS` = `"0xDEMO...A11ce"` (**no-hex**, `isAddress:false` verificado). |
| `app/api/settle/principal/route.ts` (L263) | AC-9 Scope OUT | Nonce bytes32 `keccak256(...)` — NO es address, NO se toca. |
| `src/application/ports.ts` | Contrato `SettlementLedger` a extender (DT-4) | 3 métodos con inputs sin `vm`. `SettlementRecord.chainId:number`. Tipos `EvmAuthorization`/`SolanaAuthorization` ya multi-VM (WKH-206). |
| `src/test-support/fakes.ts` (L453-560) | Fake `SettlementLedger` (cascada del port) | Implementa los 3 métodos con literal-type inputs → deben aceptar `vm` al extender el port. |
| `*.test.ts` (ledger, orphan, persistence, kyc-store, submit, settle, prepare, challenge) | Baseline + cascada de call-sites | Ledger test `SENDER="0xAbC...11"`; persistence usa `"0xAAA"`/`"0xZZZ"` (no-hex) en sitios canonicalizados. Mocks de ledger en 5 route-tests. |
| Auto-blindaje WKH-207 y WKH-211 | Aprendizaje histórico | Patrón recurrente (≥2 HUs): extender un port con campo REQUERIDO rompe `tsc` en TODOS los callers/impl/fake/mocks a la vez → planificar en la MISMA wave. Mutation self-checks obligatorios. Mock supabase = builder thenable. |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/infrastructure/address.ts` (nuevo, `canonicalizeAddress`) | `resolveSolanaUsdcMint` (`chain.ts:135-143`) | Fail-loud vía `new PublicKey(raw)` en try/catch → throw; consistencia repo. |
| `src/infrastructure/address.test.ts` (nuevo) | `chain.test.ts` | Estructura de test del helper multi-VM (vitest, casos evm/solana/throw). |
| Nueva migración `supabase/migrations/*.sql` | `20260716T000000_create_remittance_settlements.sql` | Header PENDING-DEPLOY, DDL idempotente (`if not exists`/`add constraint`), la aplica el founder. |
| Extensión de `SettlementLedger` (`ports.ts` + impl + fake + mocks) | WKH-207 auto-blindaje ("campo requerido = cascada mismo commit") | Evita gate rojo por `tsc` parcial. |
| Tests IDOR CD-9 | `supabase-settlement-ledger.test.ts` (mock thenable) + auto-blindaje WKH-207 W1 | Assert exacto sobre el `.eq('sender_address', <canónico>)`. |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes | Nota |
|-------|--------|---------------------|------|
| `remittance_settlements` | Definida en migración **PENDING-DEPLOY** (aún NO aplicada a prod, sin filas EVM a reconciliar) | `chain_id integer not null`, `sender_address text not null` (owner), `receiver_address text not null` | Ventana de migración limpia — la Opción A aditiva no tiene filas que reconciliar. |

### Componentes reutilizables

- `resolveActiveVm()` (`chain.ts:121`) — ÚNICA fuente del `vm` activo por deployment (CD-4). Todos los
  call-sites de esta HU obtienen `vm` de acá (o lo reciben como parámetro en el ledger, DT-4). Hoy
  retorna `'evm'` (env unset) ⇒ byte-idéntico.
- `PublicKey` de `@solana/web3.js` — ya dependencia del repo (usada en `chain.ts`), sin dependencia nueva.

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| # | Archivo | Acción | Qué cambia | Wave | Exemplar |
|---|---------|--------|-----------|------|----------|
| 1 | `src/infrastructure/address.ts` | Crear | `canonicalizeAddress(address, vm)` (helper único) | W0 | `chain.ts:135-143` |
| 2 | `src/infrastructure/address.test.ts` | Crear | AC-1/AC-2/AC-6/AC-5(evm byte-id incl. no-hex) | W0 | `chain.test.ts` |
| 3 | `supabase/migrations/20260721T000000_add_vm_network_id_to_remittance_settlements.sql` | Crear | Opción A aditiva (AC-8), PENDING-DEPLOY | W1 | `20260716T000000_*.sql` |
| 4 | `src/application/ports.ts` | Modificar | `vm:'evm'\|'solana'` (requerido) en los 3 inputs del `SettlementLedger` (DT-4) | W1 | — |
| 5 | `src/infrastructure/persistence/supabase-settlement-ledger.ts` | Modificar | Sitios L104/105/134/135/163 → `canonicalizeAddress(x, input.vm)` | W1 | — |
| 6 | `src/test-support/fakes.ts` | Modificar | Fake acepta `vm` en los 3 métodos (cascada del port) | W1 | — |
| 7 | `app/api/payout/prepare/route.ts` | Modificar | L127 PoP → helper; + pasar `vm` a `recordOrderPrepared` | W1(ledger)+W2(PoP) | — |
| 8 | `app/api/settle/principal/route.ts` | Modificar | Pasar `vm` a `recordPrincipalIn` (NO tocar L263) | W1 | — |
| 9 | `app/api/a2a/payout/submit/route.ts` | Modificar | L143/L223 → helper; + pasar `vm` a `recordPayoutOutcome` | W1(ledger)+W2(guards) | — |
| 10 | `app/api/a2a/payout/challenge/route.ts` | Modificar | L61 → helper | W2 | — |
| 11 | `src/infrastructure/payout/authority.ts` | Modificar | L83 → helper (ambas addresses) | W2 | — |
| 12 | `src/infrastructure/persistence.ts` | Modificar | L119/121/129/132 → helper | W2 | — |
| 13 | `src/infrastructure/kyc-store.ts` | Modificar | L91/99/116 → helper | W2 | — |
| 14 | `src/presentation/flow-vm.ts` | Modificar | L28 → helper (address + FALLBACK) | W2 | — |
| 15 | Mocks de `SettlementLedger` en 5 route-tests (`submit`, `settle`, `prepare`) | Modificar | Aceptar `vm` en el mock/input (cascada) | W1 | auto-blindaje WKH-207 |
| 16 | `*.idor.test.ts` / adiciones a `kyc-store.test.ts`, `persistence.test.ts`, ledger test | Crear/Modificar | Tests IDOR CD-9 + round-trip Solana + regresión EVM | W3 | ledger test |

### 4.2 Modelo de datos — Migración AC-8, **Opción A aditiva (DT-3)**

DDL de la nueva migración (`20260721T000000_add_vm_network_id_to_remittance_settlements.sql`):

```sql
-- 20260721T000000_add_vm_network_id_to_remittance_settlements.sql — PENDING-DEPLOY (HU-SOL-7/AC-8/CD-6).
-- NO aplicar: la aplica el founder (acción gated, mismo patrón que 20260716T000000_*).
-- Aditiva (Opción A, DT-3): NO cambia el TIPO de chain_id (sigue integer → mapRow() y los guards
-- money-path que comparan chainId:number quedan byte-idénticos). Agrega identidad de red Solana.

alter table public.remittance_settlements
  add column if not exists vm         text not null default 'evm',
  add column if not exists network_id text;   -- cluster/CAIP-2 Solana (ej. 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'); NULL en EVM

-- Solana no tiene chainId numérico ⇒ chain_id pasa a NULLABLE. Es una RELAJACIÓN (drop not null),
-- NO un ALTER COLUMN ... TYPE destructivo (CD-6): las filas EVM existentes conservan su valor.
alter table public.remittance_settlements
  alter column chain_id drop not null;

-- Coherencia VM ↔ identidad de red (fail-closed a nivel DB):
--   evm    ⇒ chain_id NOT NULL  Y  network_id NULL
--   solana ⇒ network_id NOT NULL Y chain_id NULL
alter table public.remittance_settlements
  add constraint remittance_settlements_vm_chk       check (vm in ('evm','solana')),
  add constraint remittance_settlements_vm_netid_chk check (
    (vm = 'evm'    and chain_id is not null and network_id is null) or
    (vm = 'solana' and network_id is not null and chain_id is null)
  );
```

**Por qué es byte-seguro para EVM:** `vm default 'evm'` backfillea las filas existentes; con `chain_id`
presente y `network_id` NULL satisfacen el CHECK. `chain_id` **sigue `integer`** ⇒ `mapRow()`
(`chainId:number`) y los 3+ guards money-path que comparan `chainId:number` NO se tocan (AC-5/CD-8).

**Escritura del ledger en esta HU:** los inserts (`recordOrderPrepared`/`recordPrincipalIn`) **NO
escriben** `vm`/`network_id` — el `default 'evm'` + `network_id` NULL producen una fila EVM coherente,
manteniendo el row-shape del upsert **byte-idéntico** (cero riesgo para los tests de ledger que asertan
campos exactos). Persistir `vm`/`network_id` explícitos se **difiere a HU-SOL-9** (cuando existan filas
Solana). El parámetro `vm` del ledger en esta HU se usa **sólo** para `canonicalizeAddress` (DT-4).

### 4.3 El helper `canonicalizeAddress(address, vm)` (DT-1 / DT-1b / DT-2)

Ubicación: **módulo nuevo `src/infrastructure/address.ts`** (DT-2 — separa "canonicalización" de "config
de red"). Firma: `canonicalizeAddress(address: string, vm: 'evm' | 'solana'): string`.

- **`vm === 'evm'` (DT-1b — supremacía de CD-2):** retorna `address.toLowerCase()` **puro, byte-idéntico,
  SIN validar `isAddress`**. Ver §4.3.1 (landmine). NUNCA throw en la rama EVM.
- **`vm === 'solana'` (DT-1):** round-trip `new PublicKey(address).toBase58()` dentro de try/catch —
  valida formato base58 (32 bytes) Y normaliza a la codificación canónica; base58 inválido → **throw**
  (fail-loud, AC-6), mismo patrón que `resolveSolanaUsdcMint`. Preserva el casing (base58 es
  case-sensitive) ⇒ cierra la colisión (AC-2).
- **`vm` desconocido:** `throw` (fail-loud, AC-6). Discriminante exhaustivo (`switch`/if-else), sin
  object-injection (patrón `chain.ts`).

Error opaco y estable (ej. `throw new Error("address_canonicalization_failed")`), sin ecoar la address
(no-PII / no-oracle).

#### 4.3.1 DESIGN RESOLUTION — AC-6 (EVM `isAddress`) vs CD-2 (byte-idéntico) [RESUELTO EN F2]

**Tensión detectada en grounding (evidencia archivo:línea):** AC-6 pide, literalmente, que la rama EVM
valide con `isAddress` y haga throw ante malformación. Pero:

1. `FALLBACK_WALLET_ADDRESS = "0xDEMO00000000000000000000000000000A11ce"` (`wallet.ts:48`) es **no-hex**
   (`M`, `O` no son hex) ⇒ `isAddress` = **false** (verificado ejecutando viem). Fluye por `flow-vm.ts:28`
   → una rama EVM estricta **tiraría** en modo demo.
2. Tests EVM existentes pasan owners **no-`isAddress`** a sitios canonicalizados:
   `persistence.test.ts` usa `"0xAAA"`, `"0xBBB"`, `"0xZZZ"` en `list()`/`clearByOwner()` (L65-123). Una
   rama EVM estricta rompería ~decenas de tests → **viola CD-2/AC-5** ("si un test EVM necesita cambiar,
   es diseño incorrecto — parar y escalar").

**Resolución (Architect, F2):** la rama EVM es **`.toLowerCase()` puro (byte-idéntico, sin throw)**. CD-2
es OBLIGATORIO y "la más crítica"; el vector de IDOR que esta HU cierra es **Solana** (case-collision),
no la validación EVM. El fail-loud de AC-6 se cumple **totalmente** para: (a) `vm` desconocido, (b) Solana
malformado. La porción "isAddress para EVM" de AC-6 queda **superada por CD-2 para la rama EVM**. La
validación EVM real ya ocurre upstream donde importa al money-path (ej. `challenge/route.ts:54`
`if(!isAddress)`→400 antes de canonicalizar). **No es un blocker** (es la única lectura auto-consistente
del conjunto AC-5+AC-6+CD-1+CD-2), pero se marca de forma prominente para visibilidad de AR/founder.

### 4.4 `vm` en el `SettlementLedger` (DT-4 — parámetro explícito)

Se agrega `vm: 'evm' | 'solana'` (REQUERIDO) a los inputs de `recordOrderPrepared`, `recordPrincipalIn`
y `recordPayoutOutcome` (`ports.ts`). Sin inferencia por `chainId` (CD-4). Los 3 callers server-only
(routes `prepare`/`settle`/`submit`) pasan `vm: resolveActiveVm()` (hoy `'evm'` ⇒ byte-idéntico). El
guard CD-9 (`recordPayoutOutcome`) sigue siendo `.eq('idempotency_key').eq('sender_address', <canónico>)`
— NO se agrega `vm` al filtro, NO se reordena, NO se relaja (CD-5).

> **Cascada obligatoria (auto-blindaje WKH-207/WKH-211):** un campo REQUERIDO en un input de interfaz
> NO es aditivo para los callers. Extender `SettlementLedger` deja `tsc` rojo a la vez en: impl real,
> `test-support/fakes.ts`, y los mocks/inputs de los 5 route-tests + los 2 tests unitarios del ledger
> (`supabase-settlement-ledger.test.ts`, `orphan-ledger.test.ts`). **TODO se cierra en W1**, o el gate de
> W1 nunca pasa. Agregar `vm:'evm'` a los **inputs** de esos tests es mecánico (NO cambia expectativas
> ni asserts de valor ⇒ compatible con CD-2).

### 4.5 Flujo principal (Happy Path — EVM, byte-idéntico)

1. Un call-site (ej. `recordPayoutOutcome`) invoca `canonicalizeAddress(senderAddress, resolveActiveVm())`.
2. `resolveActiveVm()` → `'evm'` (env unset). El helper retorna `senderAddress.toLowerCase()`.
3. El `.eq('sender_address', ...)` recibe el MISMO valor que hoy ⇒ comportamiento observable idéntico.

### 4.6 Flujo Solana (habilitado, no wireado en runtime)

1. Con `vm==='solana'`, `canonicalizeAddress(pubkey,'solana')` = `new PublicKey(pubkey).toBase58()`
   (case preservado). Dos pubkeys que sólo difieren en case → canónicos **distintos** ⇒ el `.eq(...)` /
   la clave del KycStore discriminan por case ⇒ **IDOR cerrado / KYC-once correcto**.
2. Address Solana malformada → `throw` ⇒ el caller fail-cierra (en el ledger, dentro del try/catch
   best-effort CD-17 de la ruta ⇒ nunca 500 crudo; el guard cross-tenant nunca corre con un valor colisión).

### 4.7 Flujo de error

1. `vm` desconocido o base58 malformado → `canonicalizeAddress` **throw**.
2. En sitios money-path server-only bajo try/catch best-effort (ledger writes) → capturado y logueado,
   response byte-idéntica (CD-17). En sitios de comparación de guard (submit/prepare/authority/challenge)
   con `vm='evm'` no hay throw (rama lenient) ⇒ comportamiento intacto.

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- Helper Solana fail-loud vía `new PublicKey(raw).toBase58()` en try/catch — patrón `resolveSolanaUsdcMint`.
- `vm` SIEMPRE explícito: `resolveActiveVm()` (o parámetro del ledger). NUNCA inferido por shape (CD-4).
- Rama EVM = `.toLowerCase()` puro byte-idéntico (§4.3.1). Ningún test EVM cambia su expectativa (CD-2).
- Extensión del port `SettlementLedger` + TODOS sus callers/impl/fake/mocks en la MISMA wave (W1).
- Migración: aditiva Opción A, header `-- PENDING-DEPLOY`, `if not exists`/`add constraint`. NO ejecutarla.
- `npm run qa` (typecheck `tsc --noEmit` completo + vitest) verde al cierre de CADA wave (CD-7).

### PROHIBIDO
- **CD-1** NO dejar NINGÚN `.toLowerCase()` crudo sobre una address/owner en los 9 archivos de Scope IN
  (un residual es BLOQUEANTE en CR).
- **CD-2** NO cambiar la expectativa de NINGÚN test EVM. Si un test EVM debe cambiar su assert para
  compilar → diseño incorrecto, parar y escalar (agregar `vm:'evm'` a un **input** NO es cambiar expectativa).
- **CD-3** NO usar `.toLowerCase()` para "normalizar" una pubkey Solana en ningún sitio. NO comparar
  addresses EVM con `===` sin canonicalizar primero.
- **CD-4** NO inferir el `vm` de la SHAPE de la address (ej. "empieza con 0x"). `vm` viaja explícito.
- **CD-5** NO debilitar el guard de ownership de `recordPayoutOutcome` (`.eq('sender_address', ...)` sigue
  server-side, sobre el valor YA canonicalizado; no condicional).
- **CD-6** Migración ADITIVA — PROHIBIDO `ALTER COLUMN ... TYPE` destructivo sobre `chain_id`.
- **CD-7** `npm run qa` completo antes de considerar la HU lista (lección WKH-196: precision-loss sólo
  visible con `tsc --noEmit` sobre tests).
- **CD-8** NO tocar la lógica de negocio de `authority.ts`/`submit`/`prepare`/`settle` más allá del
  reemplazo puntual `.toLowerCase()`→`canonicalizeAddress`. Guard-order (WKH-168/202/206/207/211) intacto;
  ningún guard se reordena/elimina/cambia de status HTTP.
- **CD-9** Al menos un test IDOR ejecutable por sitio crítico (`recordPayoutOutcome`, `kyc-store`, guard
  PoP de `submit`) que pruebe que dos pubkeys Solana que sólo difieren en case NO colisionan — el AR debe
  poder correr el ataque CR-2 y verlo FALLAR.
- **CD-10 (heredado auto-blindaje):** al extender el port, mutation self-checks en W3 sobre el guard
  CD-9 y sobre la rama Solana del helper (`grep -rn MUTANT` = 0 al cerrar).
- NO agregar dependencias nuevas (`@solana/web3.js` ya existe). NO wirear Solana en runtime. NO tocar
  el nonce bytes32 (`settle/principal/route.ts:263`, AC-9).

## 6. Scope

**IN:**
- Helper `src/infrastructure/address.ts` (`canonicalizeAddress`) + su test.
- Reemplazo de los **15 sitios lógicos** (25 invocaciones) en los 9 archivos (tabla §4.1 #5,7-14).
- Migración aditiva Opción A (`20260721T000000_*.sql`), PENDING-DEPLOY.
- `vm` como parámetro explícito de los 3 métodos del `SettlementLedger` (+ cascada callers/fake/mocks).
- Tests IDOR CD-9 (no-colisión Solana en `recordPayoutOutcome`/`kyc-store`/guard PoP), round-trip KYC-once
  Solana (AC-4), fail-loud (AC-6), regresión EVM byte-idéntica (AC-5).

**OUT:**
- PoP ed25519 Solana (HU-SOL-8) — sólo se asegura que la canonicalización que el PoP EVM usa sea VM-aware.
- Settle no-custodial Solana / `settle/principal/route.ts` completo (HU-SOL-9); el nonce bytes32:263 (AC-9).
- Wallet/firma Solana (HU-SOL-2). Persistir `vm`/`network_id` en filas del ledger (HU-SOL-9).
- Aplicar la migración a prod (founder, gated). Ningún flag activa comportamiento Solana runtime.

## 7. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|-----------|
| Rama EVM estricta rompe demo/tests (landmine no-hex) | A→cerrado | A | §4.3.1: rama EVM = `.toLowerCase()` puro. Test explícito con `"0xAAA"`/`FALLBACK`. |
| Cascada del port deja `tsc` rojo parcial (W1) | M | M | CD (§4.4): impl+fake+mocks+ledger-tests en W1. Auto-blindaje WKH-207. |
| Añadir `vm` al filtro `.eq` debilita/rompe el guard | B | A | CD-5: `.eq` NO cambia; `vm` sólo alimenta `canonicalizeAddress`. |
| `flow-vm.isFallbackWalletAddress` con `vm='solana'` (FALLBACK es EVM) tiraría | B (runtime evm) | B | Residual documentado: FALLBACK es EVM-only; `vm='evm'` hoy. Guard/fallback Solana = HU-SOL-2. |
| Migración con `add constraint` valida filas existentes | B | B | Sin filas en prod (PENDING-DEPLOY nunca aplicada); `default 'evm'` backfillea coherente. |
| CHECK con `chain_id null` para solana pero mapRow espera number | B | M | Sólo filas Solana (inexistentes esta HU). mapRow EVM intacto; `SettlementRecord.chainId:number` no re-tipado (HU-SOL-9). |

## 8. Dependencias

- HU-SOL-1 (WKH-206, DONE, mergeada): provee `resolveActiveVm`, `@solana/web3.js`, tipos multi-VM. Esta
  HU consume su output; no reabre `chain.ts` salvo import.
- Coordinar orden de merge con cualquier HU money-path que toque `supabase-settlement-ledger.ts`,
  `authority.ts`, `submit`/`prepare`/`challenge` (mismos 5 archivos de alto riesgo). Ninguna activa hoy.

## 9. Missing Inputs

- N/A — todos resueltos en F2 (ver §10). La migración la aplica el founder (gated), no bloquea F3.

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| RESUELTO (steer) | §4.2 | DT-3: migración = **Opción A aditiva** (`network_id`+`vm`+CHECK, `chain_id` integer intacto). | No |
| RESUELTO (Architect) | §4.3 | DT-2: helper en módulo nuevo `src/infrastructure/address.ts`. | No |
| RESUELTO (steer) | §4.3 | DT-1: Solana = round-trip `new PublicKey(raw).toBase58()`. | No |
| RESUELTO (steer) | §4.4 | DT-4: `vm` como parámetro explícito del `SettlementLedger`. | No |
| RESUELTO (Architect, prominente) | §4.3.1 | DT-1b: AC-6 `isAddress` EVM superado por CD-2 (rama EVM lenient). Visibilidad AR/founder. | No |

> Gate: sin `[NEEDS CLARIFICATION]` pendientes. Todos los TBD del work-item cerrados en F2.

---

## 11. Plan de Implementación (Waves)

### Wave 0 (Serial Gate) — helper aislado
- **W0.1** Crear `src/infrastructure/address.ts` con `canonicalizeAddress` (§4.3). SIN tocar call-sites.
- **W0.2** Crear `src/infrastructure/address.test.ts`: AC-1 (evm=`toLowerCase`, solana=`toBase58`),
  AC-2 (`canonicalizeAddress(K,'solana') !== K.toLowerCase()`, case preservado), AC-6 (vm desconocido
  throw; base58 malformado throw), AC-5 (evm byte-id sobre `"0xAAA"`, `"0xZzZ"`, `FALLBACK_WALLET_ADDRESS`
  → nunca throw, `=== input.toLowerCase()`).
- **Gate W0:** `npm run qa` verde (suite existente intacta; helper cubierto).

### Wave 1 (Contratos + DB — cascada del port en un commit)
- **W1.1** Crear la migración `20260721T000000_*.sql` (§4.2). NO ejecutar.
- **W1.2** `ports.ts`: agregar `vm:'evm'|'solana'` (requerido) a los 3 inputs del `SettlementLedger`.
- **W1.3** `supabase-settlement-ledger.ts`: L104/105/134/135/163 → `canonicalizeAddress(x, input.vm)`.
  Row-shape del upsert byte-idéntico (NO escribir `vm`/`network_id`, §4.2).
- **W1.4** Callers server-only pasan `vm: resolveActiveVm()`: `prepare/route.ts` (`recordOrderPrepared`),
  `settle/principal/route.ts` (`recordPrincipalIn`), `submit/route.ts` (`recordPayoutOutcome`).
- **W1.5** `test-support/fakes.ts` + mocks/inputs de `submit`/`settle`/`prepare` route-tests + los 2 tests
  unitarios del ledger (`supabase-settlement-ledger.test.ts`, `orphan-ledger.test.ts`): agregar `vm:'evm'`
  a los inputs (mecánico, sin cambiar asserts).
- **Gate W1:** `npm run qa` verde. Asserts de valor de los tests de ledger (sender/receiver lowercased)
  intactos (byte-id EVM).

### Wave 2 (Reemplazo de los 15 sitios restantes — por archivo, guard-order intacto)
- **W2.1** `persistence.ts` L119/121, L129/132 → helper (`vm=resolveActiveVm()`).
- **W2.2** `kyc-store.ts` L91/99/116 → helper.
- **W2.3** `authority.ts` L83 → helper (vendorData + address).
- **W2.4** `submit/route.ts` L143 (PoP P3) + L223 (atestación A7) → helper. Guard-order intacto (CD-8).
- **W2.5** `prepare/route.ts` L127 → helper.
- **W2.6** `challenge/route.ts` L61 → helper (isAddress:54 se mantiene ANTES).
- **W2.7** `flow-vm.ts` L28 → helper (address + FALLBACK). Nota residual HU-SOL-2.
- **Gate W2:** `npm run qa` verde. `grep -rn "\.toLowerCase()" <9 archivos>` sobre address = 0 (CD-1);
  el nonce:263 (AC-9) intacto.

### Wave 3 (Tests IDOR CD-9 + regresión + mutation self-checks)
- **W3.1** IDOR ledger: `recordPayoutOutcome({vm:'solana', senderAddress: K})` → `.eq('sender_address', K)`
  con case preservado (`=== K` y `!== K.toLowerCase()`) ⇒ dos senders case-distintos → filtros distintos
  (no cross-mutación). Positivo: matchea su propia fila.
- **W3.2** IDOR/round-trip KYC-once (AC-4): con `NEXT_PUBLIC_VM='solana'`, `save(K,kyc)`+`get(K)` round-trip;
  `get(K')` (otra pubkey Solana) → `null`; una variante lowercase inválida de K → `get` fail-loud (throw),
  NUNCA devuelve la entry de la víctima.
- **W3.3** IDOR guard PoP `submit`: assert que `canonicalizeAddress(chAddr,'solana') !== canonicalizeAddress(addr,'solana')`
  cuando difieren sólo en case (invariante que el guard P3 usa) ⇒ 403 (ataque falla).
- **W3.4** Regresión EVM byte-id (AC-5): con `vm='evm'`, todos los sitios idénticos; suite completa verde.
- **W3.5** Mutation self-checks (CD-10): mutar la rama Solana (`toBase58` → `toLowerCase`) mata W3.1-W3.3;
  mutar el `.eq('sender_address')` mata el test de ownership; restaurar byte-a-byte (`grep -rn MUTANT`=0).
- **Gate W3:** `npm run qa` verde full.

## 12. Test Plan

| Test | AC/CD que cubre | Wave | Framework |
|------|-----------------|------|-----------|
| `address.test.ts` evm/solana/throw | AC-1, AC-2, AC-6, AC-5 | W0 | vitest |
| `supabase-settlement-ledger.test.ts` (`vm:'evm'` inputs, asserts intactos) | AC-3, AC-5, CD-5 | W1 | vitest |
| `*.idor.test.ts` recordPayoutOutcome case-preservado | AC-3, CD-9 | W3 | vitest |
| `kyc-store.test.ts` round-trip Solana + get(otra)→null | AC-4, CD-9 | W3 | vitest |
| `address.test.ts` guard-PoP invariante Solana | CD-9 (submit) | W3 | vitest |
| `persistence.test.ts` byte-id EVM (`"0xAAA"`/`"0xZZZ"`) | AC-5, CD-2 | W3 | vitest |
| Suite completa (562+ tests) sin cambio de expectativa | AC-5 | W1/W2/W3 | vitest |
| Migración: inspección DDL (header PENDING-DEPLOY, aditiva) | AC-8 | W1 | review |
| `settle/principal` tests (nonce:263 intacto) | AC-9 | W2 | vitest |

## 13. Readiness Check

```
[x] Cada AC tiene ≥1 archivo asociado en tabla 4.1 (AC-1..9 mapeados)
[x] Cada archivo en 4.1 tiene Exemplar verificado con Glob/Read (chain.ts, chain.test.ts, migración 20260716, ledger test)
[x] Sin [NEEDS CLARIFICATION] pendientes (DT-1/1b/2/3/4 resueltos, §10)
[x] Constraint Directives incluyen ≥3 PROHIBIDO (CD-1..10 + genéricos)
[x] Context Map con ≥2 archivos leídos (14 archivos + 2 auto-blindaje)
[x] Scope IN/OUT explícitos y no ambiguos (§6)
[x] BD: tabla remittance_settlements verificada (migración PENDING-DEPLOY, sin filas)
[x] Happy Path completo (§4.5) + flujo error (§4.7)
[x] Landmine byte-id EVM resuelto y documentado (§4.3.1) — no rompe tests existentes
[x] Cascada del port planificada en W1 (auto-blindaje WKH-207/211)
```

**No blockers.** Las 4 clarifications del work-item están cerradas (steers + decisión Architect §4.3.1).
El SDD está listo para SPEC_APPROVED.

---

*SDD generado por NexusAgil — FULL — WKH-213/HU-SOL-7*
