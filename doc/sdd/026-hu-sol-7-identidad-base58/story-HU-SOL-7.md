# Story File — #026: [WKH-213 / HU-SOL-7] Identidad multi-VM (address base58) — GATE DE SEGURIDAD (IDOR)

> SDD: `doc/sdd/026-hu-sol-7-identidad-base58/sdd.md`
> Work Item: `doc/sdd/026-hu-sol-7-identidad-base58/work-item.md`
> Fecha: 2026-07-21
> Branch: `feat/026-hu-sol-7-identidad-base58`
> Tipo: improvement (money-path + gate de seguridad IDOR). **AR OBLIGATORIO tras F3.**

---

## Goal

`.toLowerCase()` es correcto para EVM (checksum case-insensitive) pero **corrompe base58** (Solana es
case-sensitive: dos pubkeys distintas colapsan al mismo string lowercaseado). Como el guard de ownership
real es app-layer (`.eq('sender_address', <caller>)` con `SUPABASE_SERVICE_ROLE_KEY` = BYPASSRLS),
lowercasear una pubkey Solana abre un **IDOR cross-tenant** y rompe el **KYC-once**. Esta HU introduce un
helper único VM-aware `canonicalizeAddress(address, vm)` y reemplaza los **15 sitios lógicos** (25
invocaciones `.toLowerCase()`, 9 archivos) por él, **SIN cambiar NADA observable en EVM** (byte-idéntico),
más una migración aditiva `remittance_settlements` (Opción A) que da identidad de red a Solana. NO wirea
Solana en runtime (Scope OUT); es refactor de canonicalización + tipos que desbloquea HU-SOL-8 y HU-SOL-9.

---

## 🥇 REGLA DE ORO (leé esto ANTES de tocar código)

1. **AC-5 / CD-2 es la regla suprema: NINGÚN test EVM cambia su expectativa.** La rama EVM del helper es
   `address.toLowerCase()` **PURO, byte-idéntico, SIN `isAddress`**. **NO agregues `isAddress` a la rama
   EVM** — la romperías con owners no-hex de test (`"0xAAA"`, `"0xZZZ"`) y con `FALLBACK_WALLET_ADDRESS`
   (`"0xDEMO...A11ce"`, no-hex → `isAddress===false`). Si un test EVM necesita cambiar su `expect(...)`
   para compilar → **diseño incorrecto, PARÁ y escalá al Architect**. Agregar `vm: "evm"` a un **input**
   de un test NO es cambiar una expectativa (es cascada mecánica del port — permitido).
2. **CD-1: cero `.toLowerCase()` crudo sobre address/owner** en los 9 archivos de Scope IN tras la HU. Un
   residual es **BLOQUEANTE** en CR.
3. **CD-3: NUNCA lowercasear una pubkey base58** (ni en producción ni en fakes/tests). NUNCA comparar
   addresses EVM con `===` sin canonicalizar primero.
4. **CD-4: NUNCA inferir `vm` por la SHAPE del string** (ej. "empieza con 0x"). El `vm` viaja explícito:
   `resolveActiveVm()` o el parámetro `vm` del ledger.
5. **CD-8: guard-order del money-path INTACTO.** Solo reemplazás `.toLowerCase()` → `canonicalizeAddress`.
   Ningún guard se reordena, elimina, ni cambia de status HTTP. NO tocás lógica de negocio adyacente.
6. **AC-9: NO tocar `settle/principal/route.ts:263`** — es un **nonce bytes32** (`keccak256`), NO una
   address. Queda con su `.toLowerCase()` intacto.

---

## Acceptance Criteria (EARS) — copiados del SDD aprobado

- **AC-1** WHEN se llama `canonicalizeAddress(address, vm)`, THE system SHALL normalizar con `.toLowerCase()`
  si `vm==='evm'` (byte-idéntico) y preservar el casing base58 exacto validando con `PublicKey` si
  `vm==='solana'`.
- **AC-2** WHEN se canonicaliza una pubkey Solana mixed-case, THE system SHALL producir un valor que
  conserva el case (NUNCA colapsa al lowercase) — `canonicalizeAddress(K,'solana') !== K.toLowerCase()`.
- **AC-3** WHEN `recordPayoutOutcome` filtra por `sender_address`, THE system SHALL canonicalizar
  `senderAddress` con el `vm` correcto ANTES del `.eq(...)`.
- **AC-4** WHEN `LocalKycStore.get/save/clear` opera sobre una wallet, THE system SHALL usar SIEMPRE la
  MISMA clave canónica para esa wallet en las tres operaciones (round-trip íntegro; otra clave → `null`).
- **AC-5** WHILE la VM activa es `evm`, THE system SHALL producir el mismo comportamiento observable que
  hoy en los 9 archivos — la suite existente pasa SIN cambios de expectativa.
- **AC-6** IF `canonicalizeAddress` recibe un `vm` desconocido O una address Solana malformada, THEN THE
  system SHALL fallar fail-loud (throw). (EVM: rama lenient, ver DT-1b §4.3.1 del SDD.)
- **AC-7** THE system SHALL reemplazar los 25 usos de `.toLowerCase()` sobre address/owner (15 sitios,
  EXCLUYENDO el nonce bytes32) por `canonicalizeAddress(address, vm)` — sin residuos.
- **AC-8** THE system SHALL migrar aditivamente `remittance_settlements.chain_id` hacia un shape que
  represente también una red Solana (Opción A), marcada `-- PENDING-DEPLOY`.
- **AC-9** WHILE `settle/principal/route.ts:263` compara un nonce bytes32, THE system SHALL dejarlo intacto.

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Wave | Exemplar |
|---|---------|--------|-----------|------|----------|
| 1 | `src/infrastructure/address.ts` | Crear | `canonicalizeAddress(address, vm)` (helper único) | W0 | `chain.ts:135-143` |
| 2 | `src/infrastructure/address.test.ts` | Crear | AC-1/AC-2/AC-6 + AC-5 byte-id no-hex | W0 | `chain.test.ts` |
| 3 | `supabase/migrations/20260721T000000_add_vm_network_id_to_remittance_settlements.sql` | Crear | Opción A aditiva (AC-8), PENDING-DEPLOY. NO ejecutar | W1 | `20260716T000000_create_remittance_settlements.sql` |
| 4 | `src/application/ports.ts` | Modificar | `vm:'evm'\|'solana'` (requerido) en los 3 inputs del `SettlementLedger` | W1 | — |
| 5 | `src/infrastructure/persistence/supabase-settlement-ledger.ts` | Modificar | L104/105/134/135/163 → `canonicalizeAddress(x, input.vm)` | W1 | — |
| 6 | `src/test-support/fakes.ts` | Modificar | Fake acepta `vm` + canonicaliza internamente (mirror) | W1 | — |
| 7 | `app/api/payout/prepare/route.ts` | Modificar | L127 PoP → helper + pasar `vm` a `recordOrderPrepared` | W1+W2 | — |
| 8 | `app/api/settle/principal/route.ts` | Modificar | Pasar `vm` a `recordPrincipalIn`. **NO tocar L263** | W1 | — |
| 9 | `app/api/a2a/payout/submit/route.ts` | Modificar | L143/L223 → helper + pasar `vm` a `recordPayoutOutcome` | W1+W2 | — |
| 10 | Mocks/inputs de ledger en route-tests + 2 unit-tests del ledger | Modificar | Agregar `vm:'evm'` a inputs (cascada, mecánico) | W1 | auto-blindaje WKH-207 |
| 11 | `src/infrastructure/persistence.ts` | Modificar | L119/121/129/132 → helper | W2 | — |
| 12 | `src/infrastructure/kyc-store.ts` | Modificar | L91/99/116 → helper | W2 | — |
| 13 | `src/infrastructure/payout/authority.ts` | Modificar | L83 → helper (ambas addresses) | W2 | — |
| 14 | `app/api/a2a/payout/challenge/route.ts` | Modificar | L61 → helper (isAddress:54 se mantiene ANTES) | W2 | — |
| 15 | `src/presentation/flow-vm.ts` | Modificar | L28 → helper (address + FALLBACK) | W2 | — |
| 16 | Tests IDOR CD-9 + round-trip + mutation self-checks | Crear/Modificar | Ver §Tests (W3) | W3 | ledger test |

---

## Anti-Hallucination Checklist (verificá antes y durante)

- [ ] **Baseline**: `npm run qa` verde ANTES de tocar nada (typecheck + vitest, 562+ tests).
- [ ] `resolveActiveVm()` existe en `src/infrastructure/chain.ts:121` y hoy retorna `'evm'` (env
      `NEXT_PUBLIC_VM` unset). Verificado.
- [ ] `PublicKey` de `@solana/web3.js` YA es dependencia (usada en `chain.ts:135-143`). **NO agregar deps.**
- [ ] Los 15 sitios están en las líneas listadas (verificadas por Architect: L104/105/134/135/163 ledger,
      L119/121/129/132 persistence, L91/99/116 kyc-store, L83 authority, L143/223 submit, L127 prepare,
      L61 challenge, L28 flow-vm).
- [ ] `FALLBACK_WALLET_ADDRESS` (`src/infrastructure/wallet.ts:48`) es no-hex → `isAddress===false`. La
      rama EVM del helper NO debe tirar con él.
- [ ] `settle/principal/route.ts:263` es un **nonce bytes32**, NO address → NO se toca.
- [ ] Si un import que necesitás no existe, o un test EVM exige cambiar su assert → **PARÁ y escalá.**

---

## Exemplars (patrones reales del codebase — seguilos)

### Exemplar 1: fail-loud Solana vía `PublicKey`
**Archivo**: `src/infrastructure/chain.ts:135-143` (`resolveSolanaUsdcMint`)
**Usar para**: la rama `vm==='solana'` del helper (#1).
**Patrón clave**:
```ts
try {
  new PublicKey(raw); // lanza si no es base58 válido
} catch {
  throw new Error("solana_usdc_mint_not_configured"); // fail-loud
}
```
- Discriminante exhaustivo (`switch`/if-else), sin object-injection.
- Error opaco y estable, **sin ecoar la address** (no-PII / no-oracle).

### Exemplar 2: `resolveActiveVm()` — única fuente del vm activo
**Archivo**: `src/infrastructure/chain.ts:121-126`
**Usar para**: todos los call-sites que necesitan `vm` (CD-4). Hoy retorna `'evm'` ⇒ byte-idéntico.

### Exemplar 3: migración PENDING-DEPLOY
**Archivo**: `supabase/migrations/20260716T000000_create_remittance_settlements.sql`
**Usar para**: la migración nueva (#3). Header `-- PENDING-DEPLOY`, DDL idempotente
(`if not exists`/`add constraint`), la aplica el founder (NO el pipeline).

### Exemplar 4: cascada del port (auto-blindaje WKH-207/WKH-211)
**Usar para**: #4/#5/#6/#10. Un campo REQUERIDO en un input de interfaz deja `tsc` rojo a la vez en:
impl real + `fakes.ts` + mocks/inputs de route-tests + 2 unit-tests del ledger. **TODO se cierra en W1**
o el gate de W1 nunca pasa.

### Exemplar 5: mock thenable del ledger para el test IDOR
**Archivo**: `src/infrastructure/persistence/supabase-settlement-ledger.test.ts`
**Usar para**: el test IDOR de `recordPayoutOutcome` (W3.1) que asserta el argumento exacto del
`.eq('sender_address', <canónico>)`.

---

## Constraint Directives

### OBLIGATORIO
- Helper Solana fail-loud vía `new PublicKey(raw).toBase58()` en try/catch — patrón Exemplar 1.
- `vm` SIEMPRE explícito: `resolveActiveVm()` (o parámetro `vm` del ledger). NUNCA inferido por shape.
- Rama EVM del helper = `address.toLowerCase()` **puro**, byte-idéntico, SIN `isAddress`, NUNCA throw.
- Extensión del port `SettlementLedger` + TODOS sus callers/impl/fake/mocks en la MISMA wave (W1).
- Migración aditiva Opción A, header `-- PENDING-DEPLOY`, `if not exists`/`add constraint`. NO ejecutarla.
- `npm run qa` (typecheck `tsc --noEmit` completo + vitest) verde al cierre de CADA wave (CD-7).

### PROHIBIDO
- **CD-1** dejar NINGÚN `.toLowerCase()` crudo sobre address/owner en los 9 archivos de Scope IN.
- **CD-2** cambiar la expectativa de NINGÚN test EVM (agregar `vm:'evm'` a un input NO es cambiar expectativa).
- **CD-3** usar `.toLowerCase()` para "normalizar" una pubkey Solana en ningún sitio. Comparar EVM con
  `===` sin canonicalizar.
- **CD-4** inferir el `vm` de la SHAPE de la address.
- **CD-5** debilitar el guard de `recordPayoutOutcome` (`.eq('sender_address', ...)` sigue server-side,
  sobre el valor YA canonicalizado; NO agregar `vm` al filtro, NO reordenar, NO relajar).
- **CD-6** `ALTER COLUMN ... TYPE` destructivo sobre `chain_id` (sigue `integer`).
- **CD-8** tocar lógica de negocio de `authority.ts`/`submit`/`prepare`/`settle` más allá del reemplazo
  puntual. Guard-order intacto.
- Agregar dependencias nuevas (`@solana/web3.js` ya existe). Wirear Solana en runtime. Tocar el nonce
  bytes32 (`settle/principal/route.ts:263`, AC-9).

---

## Waves

### Wave -1: Environment Gate (verificar antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
npm install 2>/dev/null || echo "Sin package.json"
# Baseline verde OBLIGATORIO:
npm run qa
# Archivos base del Scope IN existen:
ls src/infrastructure/chain.ts src/application/ports.ts \
   src/infrastructure/persistence/supabase-settlement-ledger.ts \
   src/infrastructure/persistence.ts src/infrastructure/kyc-store.ts \
   src/infrastructure/payout/authority.ts src/presentation/flow-vm.ts \
   app/api/a2a/payout/submit/route.ts app/api/payout/prepare/route.ts \
   app/api/a2a/payout/challenge/route.ts app/api/settle/principal/route.ts \
   supabase/migrations/20260716T000000_create_remittance_settlements.sql 2>/dev/null \
   || echo "FALTA archivo base — PARAR"
```
**Si el baseline NO está verde o falta un archivo → PARAR y reportar al orquestador.**

---

### Wave 0 (Serial Gate) — helper aislado, SIN tocar call-sites

**W0.1 — Crear `src/infrastructure/address.ts`:**
```ts
import { PublicKey } from "@solana/web3.js";

/**
 * Canonicalización de address VM-aware (HU-SOL-7 / WKH-213).
 *  - evm:    address.toLowerCase() PURO, byte-idéntico (checksum EVM case-insensitive). SIN isAddress
 *            (CD-2, supremacía del byte-idéntico sobre el fail-loop de AC-6 en la rama EVM — SDD §4.3.1).
 *            NUNCA throw.
 *  - solana: round-trip new PublicKey(address).toBase58() (valida base58 32 bytes + normaliza la
 *            codificación canónica). Case-sensitive ⇒ cierra la colisión IDOR (AC-2). Malformado → throw.
 *  - vm desconocido: throw (fail-loud, AC-6). Sin inferencia por shape (CD-4).
 */
export function canonicalizeAddress(address: string, vm: "evm" | "solana"): string {
  switch (vm) {
    case "evm":
      return address.toLowerCase(); // byte-idéntico, NUNCA throw (CD-2)
    case "solana":
      try {
        return new PublicKey(address).toBase58(); // valida + normaliza, preserva el case
      } catch {
        throw new Error("address_canonicalization_failed"); // fail-loud, no ecoa la address
      }
    default:
      throw new Error("address_canonicalization_failed"); // vm desconocido (fail-loud, AC-6)
  }
}
```
> **PROHIBIDO** en este archivo: `isAddress` en la rama EVM; ecoar la address en el mensaje de error;
> agregar deps. El error debe ser opaco y estable (no-oracle).

**W0.2 — Crear `src/infrastructure/address.test.ts`** (vitest, molde `chain.test.ts`):
- AC-1 evm: `canonicalizeAddress("0xAbC123","evm") === "0xabc123"`.
- AC-1 solana: para una pubkey base58 válida `K`, `canonicalizeAddress(K,"solana") === new PublicKey(K).toBase58()`.
- AC-2 no-colisión: con `K` mixed-case válida, `canonicalizeAddress(K,"solana") !== K.toLowerCase()`
  (case preservado). Usá pubkeys base58 reales (ej. las de `chain.ts`: mint devnet
  `"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"`).
- AC-6: `canonicalizeAddress("no-base58-!!!","solana")` throw; `canonicalizeAddress("x","dogecoin" as any)`
  throw (vm desconocido).
- AC-5 byte-id / no-hex: `canonicalizeAddress("0xAAA","evm") === "0xaaa"`,
  `canonicalizeAddress("0xZZZ","evm") === "0xzzz"`, y sobre `FALLBACK_WALLET_ADDRESS`
  (import de `../infrastructure/wallet`) → NUNCA throw, `=== FALLBACK_WALLET_ADDRESS.toLowerCase()`.

**Gate W0**: `npm run qa` verde (suite existente intacta; helper cubierto).

---

### Wave 1 (Contratos + DB — cascada del port en UN commit)

> ⚠️ **Regla de la cascada (auto-blindaje WKH-207/211):** W1 se hace COMPLETA en un commit. Extender el
> port deja `tsc` rojo a la vez en impl + fake + mocks + 2 unit-tests del ledger + los 3 callers. NO
> hay gate verde parcial. Cerrá todo W1 antes de `npm run qa`.

**W1.1 — Crear la migración** `supabase/migrations/20260721T000000_add_vm_network_id_to_remittance_settlements.sql` (literal, NO ejecutar):
```sql
-- 20260721T000000_add_vm_network_id_to_remittance_settlements.sql — PENDING-DEPLOY (HU-SOL-7/AC-8/CD-6).
-- NO aplicar: la aplica el founder (acción gated, mismo patrón que 20260716T000000_*).
-- Aditiva (Opción A, DT-3): NO cambia el TIPO de chain_id (sigue integer → mapRow() y los guards
-- money-path que comparan chainId:number quedan byte-idénticos). Agrega identidad de red Solana.

alter table public.remittance_settlements
  add column if not exists vm         text not null default 'evm',
  add column if not exists network_id text;   -- cluster/CAIP-2 Solana; NULL en EVM

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

**W1.2 — `src/application/ports.ts`:** agregar `vm: "evm" | "solana";` (REQUERIDO) a los 3 inputs del
`SettlementLedger`:
- `recordOrderPrepared` (input, ~L306-314) → agregar `vm: "evm" | "solana";`
- `recordPrincipalIn` (input, ~L316-325) → agregar `vm: "evm" | "solana";`
- `recordPayoutOutcome` (input, ~L327-333) → agregar `vm: "evm" | "solana";`
> NO tocar `listStale`/`markOutcome`/`recordWebhookOutcome` (no reciben `vm`).

**W1.3 — `src/infrastructure/persistence/supabase-settlement-ledger.ts`:** agregar
`import { canonicalizeAddress } from "../address";` y reemplazar:
- L104 `sender_address: input.senderAddress.toLowerCase(),` → `sender_address: canonicalizeAddress(input.senderAddress, input.vm),`
- L105 `receiver_address: input.depositAddress.toLowerCase(),` → `receiver_address: canonicalizeAddress(input.depositAddress, input.vm),`
- L134 `sender_address: input.senderAddress.toLowerCase(),` → `sender_address: canonicalizeAddress(input.senderAddress, input.vm),`
- L135 `receiver_address: input.receiverAddress.toLowerCase(),` → `receiver_address: canonicalizeAddress(input.receiverAddress, input.vm),`
- L163 `.eq("sender_address", input.senderAddress.toLowerCase());` → `.eq("sender_address", canonicalizeAddress(input.senderAddress, input.vm));`
> **NO escribir `vm`/`network_id` en el upsert** (el `default 'evm'` + `network_id` NULL producen la fila
> EVM coherente; row-shape byte-idéntico — SDD §4.2). El parámetro `vm` acá se usa **sólo** para
> `canonicalizeAddress`. NO tocar `.eq("idempotency_key", ...)` ni el orden del guard (CD-5).

**W1.4 — Callers server-only pasan `vm: resolveActiveVm()`** (hoy `'evm'` ⇒ byte-idéntico):
- `app/api/payout/prepare/route.ts` — en `recordOrderPrepared({...})` (~L206-214) agregar `vm: resolveActiveVm(),`.
  `resolveChainId` ya se importa de `../../../../src/infrastructure/chain` (L17): **extender ese import** a
  `import { resolveChainId, resolveActiveVm } from "../../../../src/infrastructure/chain";`.
- `app/api/settle/principal/route.ts` — en `recordPrincipalIn({...})` (~L266-275) agregar `vm: resolveActiveVm(),`.
  Extender el import de L19 (`import { resolveChainId, resolveReceiverAddress, resolveUsdcAddress, resolveActiveVm } from "...chain"`).
  **NO tocar L263 (nonce).**
- `app/api/a2a/payout/submit/route.ts` — en `recordPayoutOutcome({...})` (~L283-289) agregar `vm: resolveActiveVm(),`.
  Extender el import de L36 (`import { resolveChainId, resolveActiveVm } from "../../../../../src/infrastructure/chain";`).

**W1.5 — `src/test-support/fakes.ts`** (`FakeSettlementLedger`): agregar `vm: "evm" | "solana";` a los 3
inputs (`recordOrderPrepared` ~L468-476, `recordPrincipalIn` ~L503-511, `recordPayoutOutcome` ~L537-542)
y **canonicalizar internamente** para que el fake sea mirror fiel (EVM byte-idéntico + correcto en Solana):
agregar `import { canonicalizeAddress } from "../infrastructure/address";` y reemplazar:
- L491 `senderAddress: input.senderAddress.toLowerCase(),` → `canonicalizeAddress(input.senderAddress, input.vm)`
- L492 `receiverAddress: input.depositAddress.toLowerCase(),` → `canonicalizeAddress(input.depositAddress, input.vm)`
- L525 `senderAddress: input.senderAddress.toLowerCase(),` → `canonicalizeAddress(input.senderAddress, input.vm)`
- L526 `receiverAddress: input.receiverAddress.toLowerCase(),` → `canonicalizeAddress(input.receiverAddress, input.vm)`
- L544 `const owner = input.senderAddress.toLowerCase();` → `const owner = canonicalizeAddress(input.senderAddress, input.vm);`
> Con `vm:'evm'` esto es idéntico a `.toLowerCase()` ⇒ ningún assert de los tests que usan el fake cambia.

**W1.6 — Cascada de tests (mecánica, sin cambiar asserts):** corré `npx tsc --noEmit` y agregá
`vm: "evm"` a TODO input literal de `recordOrderPrepared`/`recordPrincipalIn`/`recordPayoutOutcome` que
`tsc` marque rojo. Sitios esperados:
- `src/infrastructure/persistence/supabase-settlement-ledger.test.ts` (inputs de los 3 métodos).
- `src/infrastructure/persistence/orphan-ledger.test.ts` (inputs vía `FakeSettlementLedger`).
- Mocks/inputs en `app/api/a2a/payout/submit/route.test.ts`, `app/api/settle/principal/route.test.ts`
  (+ `.static.test.ts` / `.binding.test.ts`), `app/api/payout/prepare/route.test.ts`.
> Si un mock es una `vi.fn()` tipada como `SettlementLedger`, hereda la firma nueva del port (no requiere
> cambio). Solo los inputs LITERALES pasados a los métodos necesitan `vm:'evm'`. **NO cambiar ningún
> `expect(...)` de valor** (sender/receiver lowercased siguen igual — byte-id EVM). Si algún `expect`
> exige cambiar → PARÁ y escalá (CD-2).

**Gate W1**: `npm run qa` verde. Asserts de valor de los tests del ledger intactos (byte-id EVM).

---

### Wave 2 (Reemplazo de los 15 sitios restantes — por archivo, guard-order intacto)

> Cada archivo: agregar el import del helper + `resolveActiveVm`, reemplazar el/los `.toLowerCase()`.
> **NO tocar nada más** (CD-8). Import paths verificados por el Architect (abajo).

**W2.1 — `src/infrastructure/persistence.ts`** (imports: `import { canonicalizeAddress } from "./address";`
`import { resolveActiveVm } from "./chain";`):
- L119 `const target = address.toLowerCase();` → `const target = canonicalizeAddress(address, resolveActiveVm());`
- L121 `s.ownerAddress.toLowerCase() === target` → `canonicalizeAddress(s.ownerAddress, resolveActiveVm()) === target`
- L129 `const target = address.toLowerCase();` → `const target = canonicalizeAddress(address, resolveActiveVm());`
- L132 `s.ownerAddress.toLowerCase() === target` → `canonicalizeAddress(s.ownerAddress, resolveActiveVm()) === target`

**W2.2 — `src/infrastructure/kyc-store.ts`** (imports: `from "./address"` + `from "./chain"`):
- L91 `this.read()[address.toLowerCase()]` → `this.read()[canonicalizeAddress(address, resolveActiveVm())]`
- L99 `all[address.toLowerCase()] = {...}` → `all[canonicalizeAddress(address, resolveActiveVm())] = {...}`
- L116 `delete all[address.toLowerCase()];` → `delete all[canonicalizeAddress(address, resolveActiveVm())];`

**W2.3 — `src/infrastructure/payout/authority.ts`** (imports: `from "../address"` + `from "../chain"`):
- L83 `if (d.vendorData !== "" && d.vendorData.toLowerCase() !== address.toLowerCase()) {` →
  `if (d.vendorData !== "" && canonicalizeAddress(d.vendorData, resolveActiveVm()) !== canonicalizeAddress(address, resolveActiveVm())) {`
  > Ambas addresses por el helper. La guarda `d.vendorData !== ""` se mantiene ANTES (no canonicalizar `""`).

**W2.4 — `app/api/a2a/payout/submit/route.ts`** (ya importa `resolveActiveVm` tras W1.4; agregar
`import { canonicalizeAddress } from "../../../../../src/infrastructure/address";`):
- L143 `if (ch.address.toLowerCase() !== address.toLowerCase()) {` →
  `if (canonicalizeAddress(ch.address, resolveActiveVm()) !== canonicalizeAddress(address, resolveActiveVm())) {`
- L223 `if (att.from.toLowerCase() !== address.toLowerCase()) {` →
  `if (canonicalizeAddress(att.from, resolveActiveVm()) !== canonicalizeAddress(address, resolveActiveVm())) {`
  > Guard-order P3/A7 INTACTO (CD-8). Solo cambia la comparación, no la posición ni el status 403.

**W2.5 — `app/api/payout/prepare/route.ts`** (ya importa `resolveActiveVm` tras W1.4; agregar
`import { canonicalizeAddress } from "../../../../src/infrastructure/address";`):
- L127 `if (ch.address.toLowerCase() !== address.toLowerCase()) {` →
  `if (canonicalizeAddress(ch.address, resolveActiveVm()) !== canonicalizeAddress(address, resolveActiveVm())) {`

**W2.6 — `app/api/a2a/payout/challenge/route.ts`** (agregar `resolveActiveVm` al import de L11 y
`import { canonicalizeAddress } from "../../../../../src/infrastructure/address";`):
- L61 `const addr = address.toLowerCase();` → `const addr = canonicalizeAddress(address, resolveActiveVm());`
  > `if (!isAddress(address))` de L54 se MANTIENE ANTES (address ya válida acá). NO tocar L60 (`resolveChainId`).

**W2.7 — `src/presentation/flow-vm.ts`** (imports: `import { canonicalizeAddress } from "../infrastructure/address";`
`import { resolveActiveVm } from "../infrastructure/chain";`):
- L28 `return !!address && address.toLowerCase() === FALLBACK_WALLET_ADDRESS.toLowerCase();` →
  `return !!address && canonicalizeAddress(address, resolveActiveVm()) === canonicalizeAddress(FALLBACK_WALLET_ADDRESS, resolveActiveVm());`
  > **Residual documentado (SDD §7):** `FALLBACK_WALLET_ADDRESS` es EVM-only (`"0xDEMO..."`, no-hex). Con
  > `vm==='solana'` el helper tiraría; hoy `resolveActiveVm()==='evm'` ⇒ byte-idéntico y sin throw. El
  > guard/fallback Solana es HU-SOL-2. Aceptable en esta HU.

**Gate W2**: `npm run qa` verde. Verificar CD-1:
```bash
grep -rn "\.toLowerCase()" \
  src/infrastructure/persistence/supabase-settlement-ledger.ts src/infrastructure/persistence.ts \
  src/infrastructure/kyc-store.ts src/infrastructure/payout/authority.ts src/presentation/flow-vm.ts \
  app/api/a2a/payout/submit/route.ts app/api/payout/prepare/route.ts \
  app/api/a2a/payout/challenge/route.ts app/api/settle/principal/route.ts
```
El único `.toLowerCase()` que puede quedar es **`settle/principal/route.ts:263`** (nonce bytes32, AC-9).
Cualquier otro residual sobre una address/owner = **BLOQUEANTE**.

---

### Wave 3 (Tests IDOR CD-9 + regresión + mutation self-checks)

> El AR (gate de seguridad) debe poder correr el ataque CR-2 y verlo **FALLAR**. Dos pubkeys Solana que
> sólo difieren en case NO deben colisionar. Usá pubkeys base58 reales de distinto casing (verificá que
> ambas sean `new PublicKey(...)`-válidas y `a !== b`).

**W3.1 — IDOR ledger `recordPayoutOutcome`** (nuevo `*.idor.test.ts` o adición a
`supabase-settlement-ledger.test.ts`, mock thenable estilo Exemplar 5): llamar
`recordPayoutOutcome({ vm:'solana', senderAddress: K, idempotencyKey, status })` y asertar que el
argumento del `.eq("sender_address", ...)` es **`=== new PublicKey(K).toBase58()`** (case preservado) y
**`!== K.toLowerCase()`**. Con dos senders case-distintos `K`/`K'` → los filtros son distintos (no
cross-mutación). Positivo: `vm:'evm'` sigue produciendo `senderAddress.toLowerCase()` (byte-id).

**W3.2 — IDOR / round-trip KYC-once (AC-4)** en `kyc-store.test.ts`: con `NEXT_PUBLIC_VM='solana'`
(mockear la env / `resolveActiveVm`), `save(K, kyc)` + `get(K)` → round-trip (misma entry); `get(K')`
(otra pubkey Solana válida) → `null`; una variante lowercase INVÁLIDA de `K` → `get` **throw** (fail-loud),
NUNCA devuelve la entry de la víctima. Restaurar la env al final (`afterEach`).

**W3.3 — IDOR guard PoP `submit`**: test del invariante que usa el guard P3 — con dos pubkeys Solana
case-distintas, `canonicalizeAddress(chAddr,'solana') !== canonicalizeAddress(addr,'solana')` ⇒ la
comparación de L143 daría true ⇒ 403 (el ataque falla). Podés cubrirlo como unit del invariante en
`address.test.ts` y/o como test de ruta (`submit/route.test.ts`) con `vm='solana'`.

**W3.4 — Regresión EVM byte-id (AC-5)**: con `vm='evm'` (default), la suite completa (562+) verde SIN
cambios de expectativa. Incluye `persistence.test.ts` con owners no-hex (`"0xAAA"`/`"0xZZZ"`) y
`flow-vm` con `FALLBACK`.

**W3.5 — Mutation self-checks (CD-10):**
- Mutá la rama Solana del helper (`toBase58()` → `toLowerCase()`) ⇒ W3.1-W3.3 deben **fallar** (rojo).
- Mutá el `.eq("sender_address", ...)` (ej. quitar el filtro) ⇒ el test de ownership debe fallar.
- Restaurá byte-a-byte. Confirmá `grep -rn "MUTANT" src app` = 0 al cerrar.

**Gate W3**: `npm run qa` verde full + `tsc --noEmit` completo (CD-7).

---

### Verificación Incremental

| Wave | Verificación al completar |
|------|--------------------------|
| W0 | `npm run qa` (helper cubierto, suite intacta) |
| W1 | `npm run qa` (cascada del port cerrada, byte-id EVM) |
| W2 | `npm run qa` + `grep .toLowerCase()` sobre los 9 archivos = solo nonce:263 |
| W3 | `npm run qa` full + mutation self-checks + `tsc --noEmit` |

---

## Test Expectations

| Test | ACs/CD que cubre | Framework | Wave |
|------|------------------|-----------|------|
| `address.test.ts` (evm/solana/throw/no-hex) | AC-1, AC-2, AC-6, AC-5 | vitest | W0 |
| `supabase-settlement-ledger.test.ts` (`vm:'evm'` inputs, asserts intactos) | AC-3, AC-5, CD-5 | vitest | W1 |
| IDOR `recordPayoutOutcome` case-preservado (mock thenable) | AC-3, CD-9 | vitest | W3 |
| `kyc-store.test.ts` round-trip Solana + `get(otra)→null` + lowercase→throw | AC-4, CD-9 | vitest | W3 |
| Invariante guard-PoP Solana (`submit`/`address.test.ts`) | CD-9 (submit) | vitest | W3 |
| `persistence.test.ts` byte-id EVM (`"0xAAA"`/`"0xZZZ"`) | AC-5, CD-2 | vitest | W3 |
| Suite completa (562+) sin cambio de expectativa | AC-5 | vitest | W1/W2/W3 |
| Migración: inspección DDL (header PENDING-DEPLOY, aditiva) | AC-8 | review | W1 |

**Test-first**: SÍ para el helper (W0) y los tests IDOR (W3). El reemplazo de call-sites (W1/W2) es
refactor byte-idéntico cubierto por la suite existente.

---

## Out of Scope (NO tocar)

- **`settle/principal/route.ts:263`** — nonce bytes32 (AC-9). Se queda con su `.toLowerCase()`.
- PoP ed25519 Solana (HU-SOL-8). Settle no-custodial Solana (HU-SOL-9). Wallet/firma Solana (HU-SOL-2).
- Persistir `vm`/`network_id` en los inserts del ledger (HU-SOL-9). En esta HU el upsert NO escribe esas
  columnas (usa el `default 'evm'`).
- Aplicar la migración a prod (founder, gated). Ningún flag activa comportamiento Solana runtime.
- Cambiar el tipo de `chain_id` (sigue `integer`). Tocar `resolveChainId`/`NetworkConfig`/`SettlementRecord.chainId`.
- "Mejorar" código adyacente, reordenar guards, cambiar status HTTP, agregar deps.

---

## Escalation Rule

**Si algo no está en este Story File, PARÁ y escalá al Architect.** No inventes, no asumas, no improvises.

Situaciones de escalation:
- Un test EVM necesita cambiar su `expect(...)` de valor para compilar (viola CD-2/AC-5).
- Una línea listada NO está donde se indica (el código derivó desde el grounding).
- Un import que necesitás no existe / el path relativo no resuelve.
- La rama EVM del helper parece necesitar `isAddress` para pasar algún test (NO — parar y escalar).
- El reemplazo requiere tocar un archivo fuera de la tabla "Files to Modify/Create".
- El `grep` de CD-1 encuentra un `.toLowerCase()` sobre address que no sabés cómo resolver sin tocar
  lógica de negocio.

---

*Story File generado por NexusAgil — F2.5 — WKH-213 / HU-SOL-7*
