# Story File — #014: [WKH-201] `forgetAndDisconnect` purga la PII persistida del beneficiario

> SDD: doc/sdd/014-wkh-201-forget-disconnect-purge-persisted-pii/sdd.md
> Fecha: 2026-07-14
> Branch: `feat/201-forget-disconnect-purge-persisted-pii`
> SDD_MODE: mini · bugfix seguridad (aditivo)

---

## Goal

El reset "¿No sos vos? / Empezar de nuevo" (WKH-184) limpia el KYC-once, el pending y el estado React,
pero **NO** borra el repo persistido `chaski.remittances.v1` (`LocalRepo`), que retiene la PII del
beneficiario (`beneficiary.name`, `beneficiary.destination` = celular Yape/CCI) y la identity del sender.
Esta HU cierra el gap agregando un método **aditivo** `clearByOwner(address)` a `RemittanceRepository`,
lo implementa en `LocalRepo` (blob real) y en `InMemoryRepo` (fake), y lo llama best-effort como tercera
limpieza dentro de `ForgetKyc.execute()`. Cero cambios de dominio, cero UI nueva, estrictamente aditivo.

## Acceptance Criteria (EARS)

> Copiados del SDD aprobado. QA los verifica en F4.

1. **AC-1**: WHEN `forgetAndDisconnect` ejecuta para una `address` conectada, THE sistema SHALL remover
   de `chaski.remittances.v1` toda entry cuyo `ownerAddress` matchee esa `address` (case-insensitive,
   misma normalización que `list()`), de modo que un `repo.list(address)` posterior devuelva `[]`.
2. **AC-2**: WHEN el purge para `address` completa, THE sistema SHALL NOT borrar, modificar ni leer-leak
   ninguna entry cuyo `ownerAddress` pertenezca a OTRA address — scopeado exclusivamente a la wallet
   conectada (misma garantía que `list()`). Las entries con `ownerAddress === null` también persisten.
3. **AC-3**: WHEN el purge completa, ninguna PII del beneficiario (`beneficiary.name`,
   `beneficiary.destination`) ni identity del sender de entries de esa `address` SHALL permanecer legible
   bajo `chaski.remittances.v1` en `localStorage` (borrado real del blob JSON, no un reset in-memory).
4. **AC-4**: IF el purge del repo falla (`localStorage` no disponible / quota — private browsing), THEN
   `ForgetKyc.execute()` SHALL NOT rechazar y el resto del reset (`kycStore.clear`, `pending.clear`) SHALL
   correr a término — mismo patrón best-effort que WKH-184.
5. **AC-5**: WHEN `forgetAndDisconnect` ejecuta sin fallo de storage, el happy-path existente de KYC-once
   y pending SHALL permanecer sin cambios (`kycStore.clear(address)` y `pending.clear()` ejecutan
   exactamente como antes) — el fix es aditivo, no reemplaza la lógica de reset existente.

## Files to Modify/Create

> NINGÚN archivo nuevo. Los 7 son modificaciones aditivas. NO se toca `list()`, `save()`, `get()`.

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/application/ports.ts` | Modificar | Agregar `clearByOwner(address: string): Promise<void>;` a la interfaz `RemittanceRepository`, **después** de `list` (tras L124), con comentario que ate el scoping a `list()`. | firma de `list()` `ports.ts:123-124` |
| 2 | `src/infrastructure/persistence.ts` | Modificar | Nuevo método `clearByOwner` en `LocalRepo`: `read()` → `map.delete(id)` de las entries que matchean el owner (filtro IDÉNTICO a `list`) → `write(map)`. Sin try/catch interno. | `LocalRepo.list()` `persistence.ts:114-121` + `LocalRepo.save()` L98-105 |
| 3 | `src/test-support/fakes.ts` | Modificar | (a) `InMemoryRepo.clearByOwner` (gemelo del filtro sobre `this.store`); (b) nueva clase `ThrowingClearByOwnerRepo implements RemittanceRepository` cuyo `clearByOwner` re-lanza (save/get/list mínimos operativos). | `InMemoryRepo.list()` `fakes.ts:82-87` + `ThrowingClearKycStore` `fakes.ts:243-254` |
| 4 | `src/application/use-cases/forget-kyc.ts` | Modificar | 3er arg `repo: RemittanceRepository` en el constructor; 3er try/catch best-effort `await this.repo.clearByOwner(input.address)` **appendeado** tras `pending.clear()`. Los 2 try/catch existentes quedan INTACTOS y PRIMERO. Importar `RemittanceRepository` de `../ports`. | los 2 try/catch `forget-kyc.ts:12-21` |
| 5 | `src/composition/container.ts` | Modificar | L89: `forgetKyc: new ForgetKyc(kycStore, kycPending, repo)` — reusar el `repo` (`const repo = new LocalRepo()`) de L49. **OJO**: la var del pending es `kycPending`, NO `pending`. | wiring de otros use-cases L82-88 (repo ya inyectado) |
| 6 | `src/infrastructure/persistence.test.ts` | Modificar | Nuevo `describe("LocalRepo.clearByOwner")` con AC-1/AC-2/AC-3, reusando `MemStorage` + `beforeEach/afterEach` + helper `withOwner`. | `describe("LocalRepo.list …")` `persistence.test.ts:62-87` |
| 7 | `src/application/use-cases/forget-kyc.test.ts` | Modificar | Nuevos casos AC-1 (repo purgado vía `InMemoryRepo`), AC-4 (`ThrowingClearByOwnerRepo` → no rechaza), AC-5 (aditividad). Todas las construcciones de `ForgetKyc` existentes deben pasar un 3er arg repo. | casos existentes `forget-kyc.test.ts:28-70` |

## Exemplars

### Exemplar 1: `LocalRepo.clearByOwner` — reusa read/write, mismo filtro que list
**Archivo**: `src/infrastructure/persistence.ts:114-121` (`list`) + `:98-105` (`save`)
**Usar para**: Archivo #2
**Patrón clave** — forma canónica (copiar el filtro EXACTO de `list()`):
```ts
async clearByOwner(address: string): Promise<void> {
  const target = address.toLowerCase();
  const map = this.read();
  for (const [id, s] of map) {
    if (s.ownerAddress != null && s.ownerAddress.toLowerCase() === target) {
      map.delete(id);
    }
  }
  this.write(map);
}
```
- Normalización `address.toLowerCase()` + guard `s.ownerAddress != null` — LITERALMENTE el mismo predicado que `list()` L119.
- `read()`/`write()` privados ya existen (L72-92); NO reimplementarlos.
- NO recrear un `Map` vacío. NO tocar claves de `localStorage` ajenas a `KEY`. Preservar entries de otros owners y las `ownerAddress === null`.
- **Sin try/catch interno** (CD-8): si `write()` lanza (quota/private-browsing), la promesa rechaza y el llamador la absorbe — simétrico con `save()`, que tampoco traga sus errores.

### Exemplar 2: `InMemoryRepo.clearByOwner` — gemelo sobre `this.store`
**Archivo**: `src/test-support/fakes.ts:82-87` (`InMemoryRepo.list`)
**Usar para**: Archivo #3(a)
**Patrón clave**:
```ts
async clearByOwner(address: string): Promise<void> {
  const target = address.toLowerCase();
  for (const [id, s] of this.store) {
    if (s.ownerAddress != null && s.ownerAddress.toLowerCase() === target) {
      this.store.delete(id);
    }
  }
}
```
- Mismo predicado. `this.store` ES el store (Map) → mutación directa, sin read/write.

### Exemplar 3: `ThrowingClearByOwnerRepo` — doble que re-lanza (para AC-4)
**Archivo**: `src/test-support/fakes.ts:243-254` (`ThrowingClearKycStore`)
**Usar para**: Archivo #3(b)
**Patrón clave** — molde de doble que falla SOLO en el método de limpieza; el resto operativo/mínimo:
```ts
// Doble que SIEMPRE falla en clearByOwner (simula localStorage roto) para el test defensivo
// de WKH-201/AC-4: ForgetKyc debe resolver igual y correr las otras limpiezas (CD-2/CD-7).
export class ThrowingClearByOwnerRepo implements RemittanceRepository {
  async save(_r: Remittance): Promise<void> {}
  async get(_id: string): Promise<Remittance | null> {
    return null;
  }
  async list(_address: string): Promise<RemittanceState[]> {
    return [];
  }
  async clearByOwner(_address: string): Promise<void> {
    throw new Error("remittance_repo_unavailable");
  }
}
```
- `RemittanceRepository`, `Remittance`, `RemittanceState` ya están importados en `fakes.ts` (L1-32) — no agregar imports.
- CD-7: NO reutilizar `InMemoryRepo` para AC-4 (su `clearByOwner` tiene éxito → no ejercita el path de fallo).

### Exemplar 4: Tercer try/catch en `ForgetKyc.execute()`
**Archivo**: `src/application/use-cases/forget-kyc.ts:11-22`
**Usar para**: Archivo #4
**Patrón clave** — los 2 try/catch existentes INTACTOS y PRIMERO; se APPENDEA un tercero independiente:
```ts
import type { KycStore, KycPendingStore, RemittanceRepository } from "../ports";
// ...
constructor(
  private readonly kycStore: KycStore,
  private readonly pending: KycPendingStore,
  private readonly repo: RemittanceRepository,
) {}

async execute(input: { address: string }): Promise<void> {
  try {
    await this.kycStore.clear(input.address); // AC-5 — intacto
  } catch {
    /* storage roto: no rompe el reset */
  }
  try {
    await this.pending.clear(); // AC-5 — intacto
  } catch {
    /* storage roto: execute() NUNCA rechaza */
  }
  try {
    await this.repo.clearByOwner(input.address); // WKH-201/AC-1 — best-effort (CD-2)
  } catch {
    /* AC-4: storage roto no rompe el reset */
  }
}
```
- CD-2: PROHIBIDO envolver las tres limpiezas en un único `try`. Tres bloques independientes.

### Exemplar 5: Harness de tests directos de `LocalRepo`
**Archivo**: `src/infrastructure/persistence.test.ts:13-60`
**Usar para**: Archivo #6
**Patrón clave** (NO reinventar — ya existen en el archivo):
- `class MemStorage implements Storage` (L13-33) — stub Map-backed, tipado explícito (CD-9).
- `beforeEach` setea `globalThis.window.localStorage = storage`; `afterEach` lo borra (L36-42).
- `function withOwner(id, owner)` (L55-60): `Remittance.create(...)` → `attachQuote(seedQuote, NOW)` → `startKyc(NOW, owner)` — seedea una remesa con `ownerAddress` y PII (`beneficiary()`). Usalo para seedear.
- Para una entry `ownerAddress === null`: `Remittance.create("x1", beneficiary(), Money.of(400,"USDC"), NOW)` **sin** `startKyc` (patrón en L78).

### Exemplar 6: Tests de integración de `ForgetKyc`
**Archivo**: `src/application/use-cases/forget-kyc.test.ts:28-70`
**Usar para**: Archivo #7
**Patrón clave**:
- Imports desde `../../test-support/fakes` (`FakeKycStore`, `FakeKycPendingStore`, ahora también `InMemoryRepo`, `ThrowingClearByOwnerRepo`).
- **Toda** construcción de `ForgetKyc` ahora recibe 3 args: `new ForgetKyc(kycStore, pending, repo)`. Actualizá los 4 casos existentes (L35, L46, L57, L68) para pasar un `new InMemoryRepo()` (o el doble en el caso de fallo) — de lo contrario tsc rompe.
- Para seedear el repo con una entry del owner en `forget-kyc.test.ts`, construí una `Remittance` con owner localmente (mismo recipe que `withOwner`): `Remittance.create(id, beneficiary(), Money.of(400,"USDC"), iso)` → `.attachQuote(quote, iso)` → `.startKyc(iso, address)` → `await repo.save(rem)`. `beneficiary`, `Money`, `Remittance` se importan de `../../test-support/fakes` y `../../domain/*` (ver imports existentes L5-8).

## Constraint Directives

### OBLIGATORIO
- **CD-1**: `clearByOwner(address)` scopeado EXCLUSIVAMENTE a esa `address` (case-insensitive). Copiar el filtro EXACTO de `list()` (`persistence.ts:119`): `s.ownerAddress != null && s.ownerAddress.toLowerCase() === target`.
- **CD-2**: La purga del repo es best-effort — si `clearByOwner` rechaza, `ForgetKyc.execute()` NO rechaza ni impide `kycStore.clear`/`pending.clear`. Tres try/catch independientes.
- **CD-6**: Implementar `clearByOwner` en LOS DOS implementadores concretos — `LocalRepo` (`persistence.ts`) E `InMemoryRepo` (`fakes.ts`). Son los únicos 2 (grep confirmado). Al terminar W1 correr la suite COMPLETA (`vitest run`), no solo los tests anchoreados — agregar a la interfaz obliga a ambos a compilar.
- **CD-7**: Para AC-4, doble dedicado `ThrowingClearByOwnerRepo` que re-lance en `clearByOwner`. Molde: `ThrowingClearKycStore` (`fakes.ts:243-254`).
- **CD-9**: TypeScript strict. Tipar explícito (como `MemStorage implements Storage`). Cero `any`.

### PROHIBIDO
- **CD-8**: NO agregar try/catch DENTRO de `clearByOwner` que trague el error de storage — la degradación vive SOLO en el llamador (`ForgetKyc`). Un `clearByOwner` que nunca rechaza rompería AC-4.
- **CD-1 (neg)**: NO borrar el map completo, NO borrar entries de otro owner, NO borrar entries `ownerAddress === null`.
- **CD-3**: NO tocar `list()` (`persistence.ts:114-121`) — intacto (scope OUT).
- **CD-5**: NO cambiar firma ni comportamiento de `save`/`get`/`list`. Cero regresión en los 7 use-cases que consumen el repo.
- **CD-4**: NO tocar archivos fuera de `chaski-v2/`. NO tocar `yarvis`, `wasiai-v2`, `agentshop-*` (demo live). NO tocar archivos fuera de la tabla "Files to Modify/Create".
- NO agregar dependencias nuevas — **ninguna**. NO agregar imports que no existan ya en cada archivo (salvo `InMemoryRepo`/`ThrowingClearByOwnerRepo` en el test de integración y `RemittanceRepository` en `forget-kyc.ts`).
- NO crear archivos de test nuevos (los 2 existen).

## Test Expectations

| Test | ACs | Framework | Tipo |
|------|-----|-----------|------|
| `persistence.test.ts` › `clearByOwner borra las entries del owner → list vacío` | AC-1 | vitest | unit |
| `persistence.test.ts` › `clearByOwner NO toca otros owners ni null` | AC-2 | vitest | unit |
| `persistence.test.ts` › `clearByOwner borra del blob real (repo fresco → list [])` | AC-3 | vitest | unit |
| `forget-kyc.test.ts` › `AC-1: forget purga el repo del owner (list → [])` | AC-1 | vitest | integration |
| `forget-kyc.test.ts` › `AC-4: si clearByOwner rechaza, execute resuelve y kyc/pending igual se limpian` | AC-4 | vitest | integration |
| `forget-kyc.test.ts` › `AC-5: aditivo — kycStore.clear y pending.clear siguen corriendo con repo OK` | AC-5 | vitest | integration |

**Asserts clave por test:**
- **AC-1 (persistence)**: `save(withOwner("a1","0xAAA"))` + `save(withOwner("a2","0xAAA"))` → `clearByOwner("0xaaa")` (lower → prueba case-insensitive) → `expect(await repo.list("0xAAA")).toEqual([])`.
- **AC-2 (persistence)**: seed `0xAAA` + `0xBBB` + una entry null (`Remittance.create` sin `startKyc`) → `clearByOwner("0xAAA")` → `list("0xBBB")` intacto (id presente) Y la entry null persiste (`await repo.get(nullId)` != null).
- **AC-3 (persistence)**: tras `clearByOwner`, instanciar un `new LocalRepo()` FRESCO (re-lee del `storage` real) → `list(address)` = `[]`. Opcional: `storage.getItem(KEY)` no contiene el `beneficiary.destination` del owner purgado.
- **AC-1 (integration)**: `InMemoryRepo` seedeado con una remesa de `0xSender`; tras `execute({address:"0xSender"})`, `await repo.list("0xSender")` = `[]`.
- **AC-4 (integration)**: `ThrowingClearByOwnerRepo` + `FakeKycStore` seedeado (`save`) + `FakeKycPendingStore` seedeado → `execute()` `.resolves.toBeUndefined()` Y `kycStore.get(addr)` = null Y `pending.get()` = null.
- **AC-5 (integration)**: `InMemoryRepo` (seedeado) + stores seedeados → `execute()` → los tres limpios (kyc null, pending null, `list` `[]`).

### Criterio Test-First
Lógica de negocio / persistencia → **Sí, test-first** (o al menos ambos verdes al cerrar cada wave).

## Waves

### Wave -1: Environment Gate (verificar antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v2
# deps instaladas
npm install 2>/dev/null || echo "revisar package.json"
# archivos base del Scope IN existen
ls src/application/ports.ts src/infrastructure/persistence.ts src/test-support/fakes.ts \
   src/application/use-cases/forget-kyc.ts src/composition/container.ts \
   src/infrastructure/persistence.test.ts src/application/use-cases/forget-kyc.test.ts \
   2>/dev/null || echo "FALTA archivo base — PARAR"
# baseline verde antes de empezar
npx vitest run 2>&1 | tail -5
npx tsc --noEmit 2>&1 | tail -5
```
**Si algo falla en Wave -1:** PARAR y reportar al orquestador. No implementar sobre un entorno roto.

### Wave 1 (Serial Gate — contrato + impls + tests directos)
- [ ] W1.1: `ports.ts` — agregar `clearByOwner` a `RemittanceRepository` → Archivo #1
- [ ] W1.2: `persistence.ts` — `LocalRepo.clearByOwner` → Archivo #2 / Exemplar 1
- [ ] W1.3: `fakes.ts` — `InMemoryRepo.clearByOwner` (a) + clase `ThrowingClearByOwnerRepo` (b) → Archivo #3 / Exemplars 2,3
- [ ] W1.4: `persistence.test.ts` — describe `LocalRepo.clearByOwner` (AC-1/2/3) → Archivo #6 / Exemplar 5
- [ ] **Gate W1**: `npx vitest run` COMPLETO en verde + `npx tsc --noEmit` limpio (CD-6). Agregar el método a la interfaz obliga a que ambos implementadores compilen; cualquier consumidor roto sale acá.

### Wave 2 (depende de W1 — wiring)
- [ ] W2.1: `forget-kyc.ts` — 3er arg `repo` + 3er try/catch → Archivo #4 / Exemplar 4
- [ ] W2.2: `container.ts:89` — `new ForgetKyc(kycStore, kycPending, repo)` → Archivo #5
- [ ] **Gate W2**: `npx tsc --noEmit` limpio (el cambio de firma del constructor puede romper `forget-kyc.test.ts` hasta W3 — esperado).

### Wave 3 (depende de W1+W2 — integración)
- [ ] W3.1: `forget-kyc.test.ts` — actualizar los 4 casos existentes al 3er arg repo + agregar AC-1/AC-4/AC-5 → Archivo #7 / Exemplar 6
- [ ] **Gate final**: `npx vitest run` COMPLETO verde + `npx tsc --noEmit` limpio + biome/lint sin errores. 6 tests nuevos presentes.

### Verificación Incremental
| Wave | Verificación al completar |
|------|--------------------------|
| W1 | tsc + suite COMPLETA verde |
| W2 | tsc (test de integración puede quedar rojo hasta W3) |
| W3 | tsc + suite COMPLETA verde + lint |

## Out of Scope
- `list()`, `save()`, `get()` de `LocalRepo`/`InMemoryRepo` — NO tocar (CD-3/CD-5).
- KYC-once (`KycStore`) y pending (`KycPendingStore`) — ya cubiertos por WKH-184; NO cambiar su lógica.
- Entries `ownerAddress === null` — quedan FUERA del purge (deben persistir).
- Otras keys de `localStorage`, cifrado, UI nueva, `flow.tsx` (el reset React ya existe y no cambia).
- Demo live: `yarvis`, `wasiai-v2`, `agentshop-*`. NO tocar.
- NO "mejorar" código adyacente. NO agregar funcionalidad no listada.

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect.** No inventar, no asumir.

Situaciones de escalation:
- Un exemplar (path/línea) ya no coincide con lo descrito.
- Un import necesario no está disponible.
- `RemittanceState` no expone `ownerAddress` como se asume, o el filtro de `list()` cambió.
- Ambigüedad en un AC.
- El cambio requiere tocar un archivo fuera de la tabla "Files to Modify/Create".

---

*Story File generado por NexusAgil — F2.5 (MINI, bugfix seguridad aditivo)*
