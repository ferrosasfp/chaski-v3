# SDD #014: [WKH-201] `forgetAndDisconnect` purga la PII persistida del beneficiario

> SPEC_APPROVED: no
> Fecha: 2026-07-14
> Tipo: bugfix (seguridad — cierre de hallazgo D, auditoría adversarial #2)
> SDD_MODE: mini
> Branch: `feat/201-forget-disconnect-purge-persisted-pii`
> Artefactos: `doc/sdd/014-wkh-201-forget-disconnect-purge-persisted-pii/`

---

## 1. Resumen

WKH-184 afirmó que el reset "¿No sos vos? / Empezar de nuevo" borra la PII del beneficiario en un
dispositivo compartido, pero solo limpia el KYC-once (`KycStore`), el pending (`KycPendingStore`) y el
estado React in-memory. El repo persistido `chaski.remittances.v1` (`LocalRepo`) **retiene**
`beneficiary.name`, `beneficiary.destination` (celular Yape/CCI) y la identity reducida del sender.
Esta HU cierra el gap con un método aditivo `clearByOwner(address)` en `RemittanceRepository`, su impl
en `LocalRepo` (reusando `read()`/`write()`, mismo criterio de scoping que `list()`), su gemelo en el
fake `InMemoryRepo`, y una tercera llamada best-effort en `ForgetKyc.execute()`. Sin cambios de
dominio, sin UI nueva, estrictamente aditiva.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 014 / WKH-201 |
| **Tipo** | bugfix seguridad (aditivo) |
| **SDD_MODE** | mini |
| **Objetivo** | Purgar de verdad las remesas del owner conectado en el repo persistido cuando se ejecuta el reset, no solo la copia visible en memoria. |
| **Scope IN** | `ports.ts`, `persistence.ts`, `fakes.ts`, `forget-kyc.ts`, `container.ts`, tests (`persistence.test.ts` + `forget-kyc.test.ts`) |
| **Scope OUT** | KYC-once/pending (ya cubiertos WKH-184), `list()` (intacto), otras keys de localStorage, entries `ownerAddress===null`, cifrado, UI nueva, demo live (`yarvis`/`wasiai-v2`) |

### Acceptance Criteria (EARS)

- **AC-1**: WHEN `forgetAndDisconnect` ejecuta para una `address` conectada, THE sistema SHALL remover
  de `chaski.remittances.v1` toda entry cuyo `ownerAddress` matchee esa `address` (case-insensitive,
  misma normalización que `list()`), de modo que un `repo.list(address)` posterior devuelva `[]`.
- **AC-2**: WHEN el purge para `address` completa, THE sistema SHALL NOT borrar, modificar ni leer-leak
  ninguna entry cuyo `ownerAddress` pertenezca a OTRA address — scopeado exclusivamente a la wallet
  conectada, misma garantía que `list()` (CD-5 de WKH-181).
- **AC-3**: WHEN el purge completa, ninguna PII del beneficiario (`beneficiary.name`,
  `beneficiary.destination`) ni identity del sender de entries de esa `address` SHALL permanecer
  legible bajo `chaski.remittances.v1` en `localStorage` (borrado real del blob JSON persistido, no un
  reset de estado React/in-memory).
- **AC-4**: IF el purge del repo falla (`localStorage` no disponible / quota — private browsing), THEN
  `ForgetKyc.execute()` SHALL NOT rechazar y el resto del reset (`kycStore.clear`, `pending.clear`)
  SHALL correr a término — mismo patrón best-effort que WKH-184 (AC-5 / CD-8).
- **AC-5**: WHEN `forgetAndDisconnect` ejecuta sin fallo de storage, el happy-path existente de
  KYC-once y pending SHALL permanecer sin cambios (`kycStore.clear(address)` y `pending.clear()` SHALL
  ejecutar exactamente como antes) — el fix es aditivo, no reemplaza la lógica de reset existente.

## 3. Context Map (Codebase Grounding)

### Archivos leídos (verificados con Read/Glob/Grep, líneas reales al 2026-07-14)

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/application/ports.ts:120-125` | Interfaz a extender | `RemittanceRepository` expone `save`/`get`/`list(address)`. `list` documentado como "scopeada por wallet, case-insensitive". Ningún método de borrado. |
| `src/infrastructure/persistence.ts:69-122` | Impl a extender | `LocalRepo` con `read()`/`write()` privados; `list()` (L114-121) filtra `s.ownerAddress != null && s.ownerAddress.toLowerCase() === target`. `save()` (L94-107) muestra el patrón mutar-map + `write(map)`. |
| `src/application/use-cases/forget-kyc.ts:1-23` | Use-case a extender | Constructor `(kycStore, pending)`; `execute()` con DOS try/catch independientes best-effort. Comentarios citan AC/CD de WKH-184. |
| `src/composition/container.ts:49,89` | Wiring | `const repo = new LocalRepo()` (L49) ya instanciado y reusado; `forgetKyc: new ForgetKyc(kycStore, kycPending, ...)` (L89) — la var del pending es `kycPending`, no `pending`. |
| `src/test-support/fakes.ts:66-88,241-254` | Fake a extender + exemplar de doble que falla | `InMemoryRepo` (L66-88) implementa la interfaz con `store: Map`; `list()` (L82-87) usa el mismo filtro que `LocalRepo`. `ThrowingClearKycStore` (L241-254) es el molde del doble que re-lanza en `clear()`. |
| `src/application/use-cases/forget-kyc.test.ts:1-71` | Test suite a extender | Usa `FakeKycStore`/`FakeKycPendingStore`/`ThrowingClearKycStore`/`ThrowingClearKycPendingStore`. Ningún assert sobre el repo (gap confirmado). |
| `src/infrastructure/persistence.test.ts:1-213` | **EXISTE** — resuelve NEEDS CLARIFICATION #2 | Harness `MemStorage implements Storage` (L13-33) + `beforeEach/afterEach` que setea/borra `globalThis.window.localStorage`; helper `withOwner(id, owner)` (L55-60) que seedea una remesa con `ownerAddress`. Describe blocks por método (`list`, `save`, `read`). |

### Exemplars verificados

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `LocalRepo.clearByOwner` | `LocalRepo.list()` (`persistence.ts:114-121`, filtro de owner) + `LocalRepo.save()` (`persistence.ts:98-105`, mutar-map + `write()`) | Mismo criterio de scoping + reuso de `read()`/`write()`. |
| `InMemoryRepo.clearByOwner` | `InMemoryRepo.list()` (`fakes.ts:82-87`) | Gemelo del filtro de owner sobre `this.store`. |
| `ThrowingClearByOwnerRepo` (nuevo doble) | `ThrowingClearKycStore` (`fakes.ts:241-254`) | Doble que re-lanza en el método de limpieza; save/get/list quedan operativos/mínimos. |
| Tercer try/catch en `ForgetKyc.execute()` | Los dos try/catch existentes (`forget-kyc.ts:12-21`) | Best-effort independiente por limpieza. |
| Tests `LocalRepo.clearByOwner` | `persistence.test.ts` describe `list` (L62-87) + helper `withOwner`/`MemStorage` | Cobertura directa de storage real (blob) para AC-3. |
| Tests integración `ForgetKyc` | `forget-kyc.test.ts` casos AC-1/AC-3/AC-5 (L28-70) | Molde para AC-1/AC-4/AC-5 con repo. |

### Estado de implementadores de la interfaz (exhaustivo, `grep`)

`RemittanceRepository` tiene **exactamente 2 implementadores concretos**, ambos en Scope IN:
`LocalRepo` (`persistence.ts:69`) e `InMemoryRepo` (`fakes.ts:66`). Los use-cases
(`create-remittance`, `start-kyc`, `resume-kyc`, `lock-quote`, `confirm-and-send`, `track-remittance`,
`list-history`) solo CONSUMEN la interfaz — no la implementan. Agregar un método a la interfaz obliga a
implementarlo en LOS DOS o TypeScript strict falla la compilación (ver CD-6).

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué cambia | Exemplar |
|---------|--------|-----------|----------|
| `src/application/ports.ts` | Modificar | Agregar `clearByOwner(address: string): Promise<void>;` a `RemittanceRepository` (tras `list`, L124), con comentario que aten el scoping a `list()`. | firma de `list()` L123-124 |
| `src/infrastructure/persistence.ts` | Modificar | Nuevo método `clearByOwner` en `LocalRepo`: `read()` → borrar del map las entries que matchean el owner (mismo filtro que `list`) → `write(map)`. | `list()` L114-121 + `save()` L98-105 |
| `src/test-support/fakes.ts` | Modificar | (a) `InMemoryRepo.clearByOwner` (gemelo sobre `this.store`); (b) nueva clase `ThrowingClearByOwnerRepo implements RemittanceRepository` cuyo `clearByOwner` re-lanza. | `InMemoryRepo.list()` L82-87 + `ThrowingClearKycStore` L241-254 |
| `src/application/use-cases/forget-kyc.ts` | Modificar | Tercer arg `repo: RemittanceRepository` en el constructor; tercer try/catch best-effort `await this.repo.clearByOwner(input.address)` tras `pending.clear()`. | los 2 try/catch L12-21 |
| `src/composition/container.ts` | Modificar | L89: `new ForgetKyc(kycStore, kycPending, repo)` (el `repo` de L49). | L82-88 (repo ya inyectado en otros use-cases) |
| `src/infrastructure/persistence.test.ts` | Modificar | Nuevo describe `LocalRepo.clearByOwner` (AC-1/2/3). | describe `list` L62-87 |
| `src/application/use-cases/forget-kyc.test.ts` | Modificar | Nuevos casos AC-1 (repo purgado), AC-4 (repo roto → no rechaza), AC-5 (aditividad). | casos existentes L28-70 |

### 4.2 Firma del método nuevo (DT-1)

```
// ports.ts — RemittanceRepository (aditivo)
clearByOwner(address: string): Promise<void>;
```

### 4.3 Impl `LocalRepo.clearByOwner` (forma canónica — reusa read/write, mismo filtro que list)

Leer el map, borrar in-place las entries cuyo `ownerAddress` matchee (case-insensitive, `!= null`),
reescribir. Mantiene entries de otros owners Y entries `ownerAddress === null` (DT-3, AC-2). NO recrea
un map vacío, NO toca claves ajenas a `KEY`.

```
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

> El fallo de storage (AC-4) surge naturalmente: si `write()` lanza (quota/private-browsing), la
> promesa rechaza y el try/catch de `ForgetKyc` la absorbe. NO hay que agregar try/catch DENTRO de
> `clearByOwner` — la degradación best-effort vive en el llamador (simétrico con `save`, que tampoco
> tragа sus errores).

### 4.4 `ForgetKyc.execute()` (tercer try/catch, orden preservado)

Los dos try/catch existentes quedan INTACTOS y PRIMERO (AC-5). Se APPENDEA un tercero:

```
async execute(input: { address: string }): Promise<void> {
  try { await this.kycStore.clear(input.address); } catch { /* CD-8 */ }
  try { await this.pending.clear(); } catch { /* CD-8 */ }
  try { await this.repo.clearByOwner(input.address); } catch { /* AC-4: storage roto no rompe el reset */ }
}
```

### 4.5 Flujo principal (Happy Path)

1. Persona A usó el dispositivo: `chaski.remittances.v1` tiene entries con `ownerAddress = 0xA`.
2. Persona A (o B) clickea "Empezar de nuevo" → `flow.tsx:303` llama `forgetKyc.execute({ address })`.
3. `execute()` limpia KYC-once, pending, y llama `repo.clearByOwner(0xA)`.
4. `clearByOwner` borra del blob persistido SOLO las entries de `0xA`; entries de otros owners y null
   quedan intactas.
5. `flow.tsx` resetea el estado React (sin cambios). Resultado: `repo.list(0xA)` → `[]`, y la PII de
   `0xA` ya no es legible en `localStorage`.

### 4.6 Flujo de error (AC-4)

1. `localStorage` no disponible (private browsing) → `clearByOwner` rechaza en `write()`.
2. El tercer try/catch de `execute()` traga el error; `execute()` resuelve `undefined`.
3. `kycStore.clear`/`pending.clear` (que corrieron ANTES) ya completaron; el reset de estado React en
   `flow.tsx` sigue su curso. La app NO crashea.

## 5. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (INVIOLABLES)

- **CD-1**: `clearByOwner(address)` OBLIGATORIO scopeado EXCLUSIVAMENTE a esa `address`
  (case-insensitive). PROHIBIDO cualquier impl que borre el map completo, entries de otro owner, o
  entries `ownerAddress === null` (AC-2). Mismo criterio que `list()` (`persistence.ts:119`).
- **CD-2**: La purga del repo es best-effort — si `clearByOwner` rechaza, `ForgetKyc.execute()` NO
  rechaza ni impide `kycStore.clear`/`pending.clear`/el reset React (AC-4). PROHIBIDO envolver las tres
  limpiezas en un único `try`.
- **CD-3**: PROHIBIDO tocar `list()` (`persistence.ts:114-121`) — intacto (scope OUT).
- **CD-4**: PROHIBIDO tocar archivos fuera de `chaski-v2/`. PROHIBIDO tocar `yarvis`, `wasiai-v2`,
  `agentshop-*` (demo live).
- **CD-5**: PROHIBIDO cambiar firma o comportamiento de `save`/`get`/`list`. HU estrictamente aditiva;
  cero regresión en los 7 use-cases que ya dependen del repo.

### Nuevos (derivados del grounding + Auto-Blindaje histórico)

- **CD-6**: OBLIGATORIO implementar `clearByOwner` en LOS DOS implementadores concretos —
  `LocalRepo` (`persistence.ts`) E `InMemoryRepo` (`fakes.ts`) — o TypeScript strict falla la
  compilación. Correr la suite COMPLETA (`vitest`) tras Wave 1, no solo los tests anchoreados.
  *Referencia: WKH-187 auto-blindaje#1 — el anchor list del Story File nunca es exhaustivo al cambiar
  un contrato; grepear todos los implementadores/consumidores y correr la suite entera.*
- **CD-7**: Para el test defensivo de AC-4, OBLIGATORIO un doble dedicado
  (`ThrowingClearByOwnerRepo`) que re-lance en `clearByOwner`. PROHIBIDO reutilizar `InMemoryRepo`
  (su `clearByOwner` tiene éxito → no ejercita el path de fallo). Molde: `ThrowingClearKycStore`
  (`fakes.ts:241-254`).
- **CD-8**: PROHIBIDO agregar un try/catch DENTRO de `clearByOwner` que trague el error de storage —
  la degradación vive SOLO en el llamador (`ForgetKyc`), simétrico con `save()`. Un `clearByOwner` que
  nunca rechaza rompería el test de AC-4.
- **CD-9**: PROHIBIDO usar `any` explícito (TypeScript strict, Golden Path). Si el nuevo doble o los
  tests necesitan tipar un stub, tipar explícito como hace `persistence.test.ts:13` (`MemStorage
  implements Storage`) y `fakes.ts`.

## 6. Waves de implementación

### Wave 0 / W1 (serial — contrato + impls + tests directos)
1. `ports.ts` — agregar `clearByOwner` a la interfaz.
2. `persistence.ts` — `LocalRepo.clearByOwner` (§4.3).
3. `fakes.ts` — `InMemoryRepo.clearByOwner` + clase `ThrowingClearByOwnerRepo`.
4. `persistence.test.ts` — describe `LocalRepo.clearByOwner` (AC-1/2/3).
   → **Gate de wave**: `vitest run` COMPLETO en verde (CD-6). La adición a la interfaz obliga a que
   ambos implementadores compilen; cualquier consumidor roto sale acá.

### W2 (depende de W1 — wiring)
5. `forget-kyc.ts` — tercer arg `repo` + tercer try/catch (§4.4).
6. `container.ts:89` — `new ForgetKyc(kycStore, kycPending, repo)`.

### W3 (depende de W1+W2 — integración)
7. `forget-kyc.test.ts` — AC-1 (repo purgado vía `InMemoryRepo`), AC-4 (`ThrowingClearByOwnerRepo` →
   no rechaza), AC-5 (aditividad: kycStore/pending siguen limpiando).
   → **Gate final**: `vitest run` COMPLETO verde + `tsc`/biome sin errores.

## 7. Plan de tests (≥1 por AC)

| AC | Archivo | Test | Assert clave |
|----|---------|------|--------------|
| **AC-1** | `persistence.test.ts` | `clearByOwner borra las entries del owner → list vacío` | `save(withOwner("a1","0xAAA"))` + `save(withOwner("a2","0xAAA"))` → `clearByOwner("0xaaa")` (lower, prueba case-insensitive) → `list("0xAAA")` = `[]` |
| **AC-1** | `forget-kyc.test.ts` | `AC-1: forget purga el repo del owner (list → [])` | con `InMemoryRepo` seedeado; tras `execute({address})`, `repo.list(address)` = `[]` |
| **AC-2** | `persistence.test.ts` | `clearByOwner NO toca otros owners ni null` | seed `0xAAA` + `0xBBB` + una entry `ownerAddress===null` (`Remittance.create` sin `startKyc`, ver `persistence.test.ts:78`) → `clearByOwner("0xAAA")` → `list("0xBBB")` intacto Y la entry null persiste (verificar vía `get(id)` != null) |
| **AC-3** | `persistence.test.ts` | `clearByOwner borra del blob real (no solo in-memory)` | tras `clearByOwner`, instanciar un `new LocalRepo()` FRESCO (re-lee de `storage`) → `list(address)` = `[]`; opcional: `storage.getItem(KEY)` no contiene `beneficiary.destination` del owner purgado |
| **AC-4** | `forget-kyc.test.ts` | `AC-4: si clearByOwner rechaza, execute resuelve y kyc/pending igual se limpian` | `ThrowingClearByOwnerRepo` + `FakeKycStore` seedeado + `FakeKycPendingStore` seedeado → `execute()` `resolves.toBeUndefined()` Y `kycStore.get(addr)` = null Y `pending.get()` = null |
| **AC-5** | `forget-kyc.test.ts` | `AC-5: aditivo — kycStore.clear y pending.clear siguen corriendo con repo OK` | `InMemoryRepo` + stores seedeados → `execute()` → los tres limpios (kyc null, pending null, list `[]`) |

> Los tests directos de `LocalRepo` usan el harness existente `MemStorage` + `beforeEach/afterEach`
> (`persistence.test.ts:13-42`) y el helper `withOwner` (L55-60) — NO reinventarlos.

## 8. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Olvidar `InMemoryRepo.clearByOwner` → tsc rojo | Media | Bajo | CD-6 + gate de wave (suite completa). Falla ruidosa en compilación, no silenciosa. |
| Impl que borra de más (null/otros owners) | Baja | Alto (regresión de aislamiento) | CD-1 + AC-2 test explícito con 3 owners + null. Copiar el filtro EXACTO de `list()`. |
| `clearByOwner` traga su propio error → AC-4 nunca ejercita el fallo | Baja | Medio | CD-8: sin try/catch interno; el doble `ThrowingClearByOwnerRepo` re-lanza. |
| Confusión var `pending` vs `kycPending` en `container.ts` | Baja | Bajo | §4.1 fija el nombre real: `kycPending` (container L51). |

## 9. Missing Inputs — RESUELTOS en F2

- **DT-3 / NEEDS CLARIFICATION #1 (entries `ownerAddress===null`)**: **RESUELTO — quedan FUERA del
  purge.** Confirmado el default recomendado. `clearByOwner` filtra `s.ownerAddress != null && match`,
  idéntico a `list()` (`persistence.ts:119`). No pertenecen a ningún owner conectado y no son el vector
  del hallazgo D. Test de AC-2 lo verifica (la entry null persiste tras el purge).
- **NEEDS CLARIFICATION #2 (existencia de `persistence.test.ts`)**: **RESUELTO — SÍ EXISTE**
  (`src/infrastructure/persistence.test.ts`, 213 líneas, harness `MemStorage` + `withOwner`). La
  cobertura directa de `LocalRepo.clearByOwner` (AC-1/2/3) VA en ese archivo; la cobertura de
  integración de `ForgetKyc` (AC-1/4/5) va en `forget-kyc.test.ts` vía `InMemoryRepo`. NO se crea
  ningún archivo de test nuevo.

## 10. Readiness Check

| Ítem | Estado |
|------|--------|
| Todos los `[NEEDS CLARIFICATION]` resueltos | ✅ (§9: null-owner OUT; persistence.test.ts existe) |
| Exemplars verificados con Read (paths reales) | ✅ (todos los paths/líneas confirmados) |
| Implementadores de la interfaz enumerados exhaustivamente | ✅ (2: LocalRepo, InMemoryRepo — grep) |
| CDs heredados del work-item presentes | ✅ (CD-1..CD-5) |
| CDs nuevos anti-alucinación / Auto-Blindaje | ✅ (CD-6..CD-9) |
| Waves definitivas con orden serial/paralelo | ✅ (W1 serial → W2 → W3) |
| Plan de tests ≥1 por AC con archivo destino | ✅ (6 tests, 5 ACs cubiertos) |
| Stack respetado (TS strict, sin `any`, sin deps nuevas) | ✅ (CD-9; cero dependencias nuevas) |
| Scope OUT respetado (`list()`, demo live, otras keys) | ✅ (CD-3/CD-4) |
| Sin código de producción escrito por el Architect | ✅ (solo spec) |

**Veredicto**: SDD listo para `SPEC_APPROVED`. Sin TBDs bloqueantes.

---

*SDD generado por NexusAgil — MINI (bugfix seguridad, aditivo)*
