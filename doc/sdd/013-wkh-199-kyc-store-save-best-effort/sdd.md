# SDD — [WKH-199] KYC re-brick: `KycStore.save()` best-effort + reorder critical-write-first

- **SDD_MODE**: bugfix
- **Estimación**: S
- **Branch sugerido**: `fix/199-kyc-store-save-best-effort`
- **Base**: `main` (post WKH-178..188, con WKH-183 y WKH-187 ya mergeados). Corre en paralelo con
  WKH-198 sin overlap de archivos (ver §7).
- **Gate previo**: HU_APPROVED otorgado.
- **NNN**: `013` (el `012` lo tomó WKH-198 en F1; stub obsoleto en `doc/sdd/012-wkh-199-…/`).

---

## 1. Context Map (archivos leídos + patrón extraído)

Todas las líneas verificadas al 2026-07-14 sobre `main` con Read directo.

| Archivo | Líneas | Qué extraje / por qué |
|---------|--------|-----------------------|
| `src/infrastructure/kyc-store.ts` | 90-124 | `save()` (97-106): `s.setItem(KEY, JSON.stringify(all))` en **L105 SIN try/catch**. `clear()` (110-123): `setItem` idéntico pero **envuelto** en try/catch (118-122) con comentario best-effort `/* quota / private-browsing: best-effort — no throw (AC-5/CD-5) */`. Ambos comparten estructura: `read()` → mutar `all` → `const s = ls()` → `if (!s) { this.mem = all; return; }` → `setItem`. **Objetivo DT-1 (AC-1): replicar exactamente el try/catch de `clear()` en `save()`.** |
| `src/application/use-cases/resume-kyc.ts` | 46-51 | Orden actual: `if (v.approved && v.payoutAllowed) await this.kycStore.save(p.address, v);` (**L47**, cache no-crítico) → `r.applyKyc(v, …)` (48) → `await this.repo.save(r)` (49, write crítico) → `await this.pending.clear()` (50). **Objetivo DT-2 (AC-2): mover L47 DESPUÉS de L49.** |
| `src/application/use-cases/start-kyc.ts` | 51-70 | Rama `"completed"` (51-57): `if (v.approved && v.payoutAllowed) await this.kycStore.save(input.address, v);` (**L53**) → `r.applyKyc` (54) → `repo.save` (55) → `return {kind:"done"}` (56). Rama `redirect` (59-70) **ya sigue "critical-write-first"** desde WKH-183 (pending.save antes de repo.save) — **CD-6: NO tocar.** **Objetivo DT-2 (AC-3): mover L53 DESPUÉS de L55, solo en la rama completed.** |
| `src/infrastructure/kyc-pending-store.ts` | 1-32 | **Exemplar del patrón WKH-183** (precedente exacto): `save()` (8-14) y `clear()` (25-31) envuelven `setItem`/`removeItem` en try/catch que re-lanza `Error("kyc_pending_unavailable")`. Diferencia con `kyc-store.ts`: aquí el catch **re-lanza**; en `kyc-store.ts` el catch de `clear()` es **swallow/best-effort**. **CD-3: el `save()` de kyc-store DEBE seguir a `clear()` de kyc-store (swallow), NO a kyc-pending-store (re-throw).** CD-6: este archivo NO se toca. |
| `src/test-support/fakes.ts` | 143-254 | `ThrowingKycPendingStore` (158-169): implementa `KycPendingStore`, `save()` lanza, `get`/`clear` in-memory — **molde de la nueva `ThrowingSaveKycStore`**. `FakeKycStore` (228-239): implementa `KycStore` (`get`/`save`/`clear` sobre `Map`). `ThrowingClearKycStore` (243-254): implementa `KycStore`, `clear()` lanza `Error("kyc_store_unavailable")`, `get`/`save` in-memory — **el paralelo exacto simétrico a lo que necesito para `save()`.** |
| `src/infrastructure/kyc-store.test.ts` | 9-29, 168-179 | `MemStorage` stub (9-29, `implements Storage`, Map-backed, jsdom no instalado). Test "AC-5: clear NO propaga…" (168-179): subclasea `MemStorage` con `override setItem(): void { throw new Error("QuotaExceededError"); }`, lo inyecta en `globalThis.window.localStorage`, y assertea `await expect(store.clear("0xAAA")).resolves.toBeUndefined()`. **Exemplar EXACTO del test AC-6(a) para `save()`.** `beforeEach`/`afterEach` (48-55) montan/desmontan `window`. |
| `src/application/use-cases.test.ts` | 29-63, 179-204 | `setup()` (29-63) cablea `ResumeKyc`/`StartKyc` con `opts.kycStore?` inyectable (39) y `opts.pending?` (40). Test "Didit redirect → resume aplica…" (179-189) usa `FakeKycGateway({}, true)` + `resumeKyc.execute()`. Test estrella WKH-183 "V1 ⭐" (191-204) usa `pending: new ThrowingKycPendingStore()` + `repo.get(id)` assert de status persistido. **Exemplar EXACTO de los tests AC-6(b)/(c): mismo `setup({ kycStore: new ThrowingSaveKycStore(), … })` + assert `repo.get(id)?.snapshot.status === "kyc_passed"`.** Confirma que `use-cases.test.ts` es el hogar de los tests de ResumeKyc/StartKyc (resuelve el [NEEDS CLARIFICATION], §DT-5). |
| `src/application/ports.ts` (vía imports de fakes) | — | `KycStore` = `{ get(address): Promise<KycVerification\|null>; save(address, kyc): Promise<void>; clear(address): Promise<void> }` (confirmado por `FakeKycStore`/`ThrowingClearKycStore` que lo implementan). **La firma del port NO cambia (CD-7).** |
| `project-context.md` | 103-106 | Sección "Patron de acceso a base de datos": *"…usan `localStorage` con try/catch (fail explicito: `throw new Error(...)` … nunca fallo silencioso en `save`/`clear`)"*. **Impreciso post-fix**: `clear()` de kyc-store YA es fail-silent hoy, y `save()` lo será. **Objetivo DT-4 (AC del work-item DT-4): corregir la nota.** |

**Precedente directo**: WKH-183 cerró la MISMA clase de bug ("write no-crítico bloquea el crítico") en
`kyc-pending-store.ts`/`start-kyc.ts` rama redirect (reorder + fake `Throwing*Store`). Esta HU aplica
el mismo playbook al cache KYC-once (`kyc-store.ts`, rama completed + resume). Ver
`doc/sdd/006-wkh-183-higiene-menores/auto-blindaje.md#W2`.

---

## 2. Decisiones técnicas (DT-N)

- **DT-1 (fix de raíz — try/catch en `save()`)** — heredada del work-item. Envolver el `s.setItem(...)`
  de `kyc-store.ts:105` en un try/catch **idéntico byte-a-byte al de `clear()` (118-122)**: mismo
  bloque, mismo estilo de comentario best-effort, sin distinguir tipos de error. Es la defensa de raíz:
  cualquier caller que llame `save()` antes de un write crítico (patrón que hoy existe en 2 lugares)
  deja de poder bloquear el crítico. La firma `save(address, kyc): Promise<void>` NO cambia.

- **DT-2 (defensa en profundidad — reorder critical-write-first)** — heredada. Mover
  `kycStore.save()` DESPUÉS de `applyKyc()`+`repo.save()` en **ambos** use-cases:
  - `resume-kyc.ts`: L47 baja a después de L49.
  - `start-kyc.ts` rama `"completed"`: L53 baja a después de L55.
  Mismo principio que WKH-183 estableció en la rama `redirect`. Aunque DT-1 ya vuelve el write
  inofensivo para `LocalKycStore`, el reorder documenta la intención (comentario inline) y protege
  ante un `KycStore` futuro que NO sea `LocalKycStore` (p.ej. un adapter remoto sin try/catch propio).
  **Este reorder es lo que hacen pasar los tests AC-6(b)/(c)** (con `ThrowingSaveKycStore` que SÍ
  lanza, solo el reorder garantiza que `repo.save` ya corrió).

- **DT-3 (gate de negocio intacto)** — heredada. La condición `v.approved && v.payoutAllowed` que
  decide si se llama `kycStore.save()` NO se toca en ninguno de los dos use-cases (CD-1). Solo se
  mueve la línea completa; el `if (...)` viaja con ella sin cambios.

- **DT-4 (doc — `project-context.md`)** — heredada. Corregir la nota "Patron de acceso a base de
  datos" (L103-106) para reflejar que `save()` Y `clear()` de `kyc-store.ts` son best-effort/
  fail-silent por diseño, mientras `kyc-pending-store.ts` sigue re-lanzando. Evita que una HU futura
  asuma "throw" por doc desactualizada. Diff acotado a esas líneas.

- **DT-5 (ubicación de tests — resuelve el [NEEDS CLARIFICATION])** — **DECISIÓN**: los tests nuevos de
  `ResumeKyc`/`StartKyc` (AC-6 b/c) van en **`src/application/use-cases.test.ts`** (archivo compartido
  existente), NO en archivos dedicados. Justificación: (a) es el hogar ESTABLECIDO de todos los tests
  de estos dos use-cases (los tests redirect/resume/KYC-once/V1-estrella de WKH-183 viven ahí,
  L179-225); (b) el `setup()` helper (L29-63) ya inyecta `kycStore`/`pending` — reusable sin
  boilerplate; (c) el precedente WKH-183 puso su test estrella acá (L191-204). Crear
  `resume-kyc.test.ts`/`start-kyc.test.ts` fragmentaría el patrón sin beneficio. El test unit del
  store (AC-6 a) va en `kyc-store.test.ts` (junto al de `clear()`, su gemelo).

- **DT-6 (fake nueva — `ThrowingSaveKycStore`)** — heredada (CD-5 del work-item). Se **agrega** a
  `test-support/fakes.ts` un doble que implementa `KycStore` y **lanza en `save()`** (`get`/`clear`
  in-memory), molde de `ThrowingKycPendingStore` (158-169) y simétrico a `ThrowingClearKycStore`
  (243-254). NO muta `FakeKycStore` ni ningún doble existente (CD-8/Auto-Blindaje). Simula el peor
  caso (store que lanza) para verificar que el reorder DT-2 protege el write crítico aun sin DT-1.

---

## 3. Constraint Directives (CD-N)

**Heredados del work-item** (INVIOLABLES):
- **CD-1**: PROHIBIDO cambiar la condición `v.approved && v.payoutAllowed` que gatea el `kycStore.save()`
  en `resume-kyc.ts` y `start-kyc.ts`. Se mueve la línea completa, el `if` viaja intacto.
- **CD-2**: PROHIBIDO tocar el gate `confirm_requires_kyc_passed` (`domain/remittance.ts`) o la
  autoridad server-side de payout (`confirm-and-send.ts`, WKH-180) — fuera de scope.
- **CD-3**: OBLIGATORIO que el try/catch de `save()` sea **simétrico al de `clear()` de kyc-store**
  (swallow best-effort, sin re-throw, sin distinguir error) — NO al de `kyc-pending-store.ts` (que
  re-lanza). Mismo comentario/estilo que L118-122.
- **CD-4**: OBLIGATORIO el test en `kyc-store.test.ts` que simula `setItem` lanzando DENTRO de `save()`
  reusando el patrón `MemStorage` con `setItem` override (el del test AC-5 de `clear()`, L168-179).
- **CD-5**: OBLIGATORIO agregar `ThrowingSaveKycStore` en `test-support/fakes.ts` (paralela a
  `ThrowingKycPendingStore`) y usarla en los tests de `ResumeKyc`/`StartKyc`.
- **CD-6**: PROHIBIDO tocar `kyc-pending-store.ts`, la rama `redirect` de `start-kyc.ts` (WKH-183), el
  overlay/timeout de `flow.tsx` (WKH-188) ni ninguna otra invariante fuera de la reorder/try-catch
  descrita — fix acotado, sin expansión de scope.

**Agregados en F2 (Auto-Blindaje histórico — patrones de error recurrentes):**
- **CD-7 (sin drift de firmas — Auto-Blindaje WKH-180#W2, WKH-181#W1)**: PROHIBIDO cambiar la firma del
  port `KycStore` o de `save()`/ctor de los use-cases. En ≥2 HUs previas, agregar un param a un
  ctor/método rompió `tsc` en callers **fuera del Scope IN** (`use-cases.test.ts`,
  `confirm-and-send.test.ts`). Esta HU NO cambia firmas: `save()` conserva `(address, kyc)`; la fake
  se **agrega**, no muta. Referencia: `003-wkh-180…/auto-blindaje.md`, `004-wkh-181…/auto-blindaje.md`.
- **CD-8 (import de tipos EXACTOS — Auto-Blindaje WKH-180#W2)**: al escribir `ThrowingSaveKycStore` en
  `fakes.ts`, reusar los imports YA presentes (`KycStore`, `KycVerification` — L12-32); NO inventar
  símbolos de `ports.ts`/`remittance.ts`. Referencia: WKH-180 importó `PayoutAuthority` (inexistente)
  y rompió `tsc`.
- **CD-9 (`noUncheckedIndexedAccess` en tests — Auto-Blindaje WKH-179#W1, WKH-181#W2)**: el `tsconfig`
  tiene `noUncheckedIndexedAccess`; todo acceso por índice es `T | undefined`. En los tests nuevos
  evitar index-access crudo (`arr[0].x`); usar `?.`/non-null guardado. Aplica si algún assert indexa.
  Referencia: `002-wkh-179…/auto-blindaje.md`, `004-wkh-181…/auto-blindaje.md`.
- **CD-10 (grep de callers antes de reorder — Auto-Blindaje WKH-180/181/187)**: el reorder NO cambia
  firmas, así que no debería ripplear; aun así, antes de F3 el Dev corre
  `grep -rn "kycStore.save\|\.save(" src/application/use-cases/resume-kyc.ts src/application/use-cases/start-kyc.ts`
  para confirmar que las únicas llamadas a `kycStore.save()` son las dos reordenadas.

---

## 4. Diseño del fix (por archivo)

### 4.1 `src/infrastructure/kyc-store.ts` — try/catch en `save()` (DT-1, AC-1)

Estado actual (97-106):
```
async save(address, kyc): Promise<void> {
  const all = this.read();
  all[address.toLowerCase()] = { v: kyc, savedAt: Date.now() };
  const s = ls();
  if (!s) { this.mem = all; return; }
  s.setItem(KEY, JSON.stringify(all));   // ← L105 SIN try/catch
}
```
Fix: envolver la L105 en el try/catch **idéntico al de `clear()` (118-122)** — mismo estilo, comentario
best-effort análogo. El resto del método (read, mutación, rama `!s`) queda intacto. El `!s` (SSR /
localStorage inaccesible) ya retorna temprano; el catch cubre solo el path browser donde `setItem`
lanza (quota / private-browsing). Resultado: `save()` resuelve `undefined` aun si `setItem` lanza —
simétrico con `clear()`, satisface AC-1 y AC-5 (éxito byte-a-byte cuando `setItem` NO lanza: el
try/catch es transparente en el happy path).

### 4.2 `src/application/use-cases/resume-kyc.ts` — reorder (DT-2, AC-2)

Estado actual (46-51):
```
const v = dec.verification;
if (v.approved && v.payoutAllowed) await this.kycStore.save(p.address, v);  // L47 cache no-crítico
r.applyKyc(v, this.clock.nowIso());   // L48 write crítico → repo
await this.repo.save(r);              // L49 write crítico persistido
await this.pending.clear();           // L50
return { kind: r.status === "kyc_passed" ? "passed" : "failed", snapshot: r.snapshot };
```
Fix: mover la línea del `if (...) kycStore.save(...)` a DESPUÉS de `await this.repo.save(r)` (queda
entre L49 y `pending.clear()`), con comentario inline "cache no-crítico DESPUÉS del write crítico
(WKH-199)". `applyKyc`+`repo.save` corren SIEMPRE antes del cache. Si `kycStore.save` lanzara (adapter
sin try/catch), el KYC ya está persistido en el repo y el `return {kind:"passed"}` no se alcanza SOLO
si `kycStore.save` está antes — al moverlo después, con DT-1 no lanza y con reorder tampoco importa.
CD-1: `if (v.approved && v.payoutAllowed)` intacto.

### 4.3 `src/application/use-cases/start-kyc.ts` — reorder rama `"completed"` (DT-2, AC-3)

Estado actual (51-57):
```
if (res.kind === "completed") {
  const v = res.verification;
  if (v.approved && v.payoutAllowed) await this.kycStore.save(input.address, v);  // L53
  r.applyKyc(v, this.clock.nowIso());   // L54
  await this.repo.save(r);              // L55
  return { kind: "done", snapshot: r.snapshot };
}
```
Fix: mover la L53 a DESPUÉS de `await this.repo.save(r)` (entre L55 y el `return`), mismo comentario
inline. **Solo la rama `"completed"`**; la rama `redirect` (59-70) NO se toca (WKH-183, CD-6). CD-1: el
`if` intacto.

### 4.4 `src/test-support/fakes.ts` — `ThrowingSaveKycStore` (DT-6, CD-5)

Agregar (molde de `ThrowingClearKycStore` L243-254, invirtiendo cuál método lanza):
```ts
// Doble que SIEMPRE falla en save() (simula localStorage lleno / private-browsing) para WKH-199:
// ResumeKyc/StartKyc deben persistir el KYC aprobado en el repo pese al fallo del cache no-crítico.
export class ThrowingSaveKycStore implements KycStore {
  private m = new Map<string, KycVerification>();
  async get(address: string): Promise<KycVerification | null> {
    return this.m.get(address.toLowerCase()) ?? null;
  }
  async save(_address: string, _kyc: KycVerification): Promise<void> {
    throw new Error("kyc_store_unavailable");
  }
  async clear(address: string): Promise<void> {
    this.m.delete(address.toLowerCase());
  }
}
```
Imports YA presentes (`KycStore`, `KycVerification`, `Map` nativo) — CD-8, sin símbolos nuevos.

### 4.5 `src/infrastructure/kyc-store.test.ts` — test AC-6(a)

Agregar dentro del `describe` de save/persistencia (o del de clear, junto a su gemelo L168-179),
reusando el patrón `MemStorage` + `setItem` override:
```ts
it("AC-1: save NO propaga la excepción si setItem lanza (quota/private-browsing)", async () => {
  const throwing = new (class extends MemStorage {
    override setItem(): void { throw new Error("QuotaExceededError"); }
  })();
  (globalThis as { window?: { localStorage: Storage } }).window = { localStorage: throwing };
  const store = new LocalKycStore();
  await expect(store.save("0xAAA", kyc)).resolves.toBeUndefined();
});
```

### 4.6 `src/application/use-cases.test.ts` — tests AC-6(b) y AC-6(c)

Reusar `setup({ kycStore: new ThrowingSaveKycStore() })` + `ThrowingSaveKycStore` importada de fakes.
- **AC-6(b) — ResumeKyc**: `setup({ kyc: new FakeKycGateway({}, true), kycStore: new ThrowingSaveKycStore() })`;
  create → lock → `startKyc.execute()` (redirect) → `resumeKyc.execute()`. Assert:
  `res.kind === "passed"` **y** `(await repo.get(id))?.snapshot.status === "kyc_passed"` (el cache
  falló pero el KYC quedó persistido; `execute()` NO lanzó).
- **AC-6(c) — StartKyc rama completed**: `setup({ kycStore: new ThrowingSaveKycStore() })` (FakeKycGateway
  default → `kind:"completed"`); create → lock → `startKyc.execute()`. Assert: `res.kind === "done"`
  **y** `(await repo.get(id))?.snapshot.status === "kyc_passed"`.

> **Nota crítica (por qué el reorder DT-2 es indispensable):** con `ThrowingSaveKycStore` (que SÍ lanza,
> independiente de DT-1), estos dos tests **solo pasan si `repo.save` corrió ANTES** del `kycStore.save`.
> Sin el reorder, `kycStore.save` lanzaría antes de `applyKyc`/`repo.save`, `execute()` rechazaría y el
> repo quedaría sin `kyc_passed` → test rojo. Así el test verifica DT-2, mientras AC-6(a) verifica DT-1
> en aislamiento.

### 4.7 `project-context.md` — nota (DT-4)

Reescribir L104-106 para distinguir: `kyc-store.ts` (`save`/`clear` **best-effort/fail-silent** por
diseño) vs `kyc-pending-store.ts` (`save`/`clear` **re-lanzan** `kyc_pending_unavailable`). Diff
acotado a esas líneas, sin reformatear el resto de la sección.

---

## 5. Waves de implementación

| Wave | Archivos | ACs | Serial? |
|------|----------|-----|---------|
| **W0** — contrato de test (serial, primero) | `src/test-support/fakes.ts` (agregar `ThrowingSaveKycStore`, DT-6) | (habilita AC-6 b/c) | Prerrequisito de W2; sin deps propias |
| **W1** — fix de producción (paralelizable entre sí) | `src/infrastructure/kyc-store.ts` (try/catch, DT-1) · `src/application/use-cases/resume-kyc.ts` (reorder, DT-2) · `src/application/use-cases/start-kyc.ts` (reorder rama completed, DT-2) | AC-1, AC-2, AC-3 | Los 3 archivos son independientes entre sí |
| **W2** — tests (depende de W0+W1) | `src/infrastructure/kyc-store.test.ts` (AC-6a) · `src/application/use-cases.test.ts` (AC-6 b/c) | AC-4, AC-5, AC-6 | `kyc-store.test.ts` depende de W1(kyc-store); `use-cases.test.ts` depende de W0 + W1(resume/start) |
| **W3** — doc (100% independiente) | `project-context.md` (DT-4) | — | En cualquier momento |

Riesgo bajo y acotado: 4 archivos de código/test + 1 doc, sin cambios de firma ni de dominio.

---

## 6. Plan de tests (≥1 por AC)

Todos en vitest, patrón existente. `tsc` strict + `noUncheckedIndexedAccess` (CD-9).

| AC | Test (archivo) | Qué verifica |
|----|----------------|--------------|
| **AC-1** | `kyc-store.test.ts` (nuevo, §4.5) | `MemStorage` con `setItem` override que lanza → `store.save("0xAAA", kyc)` `.resolves.toBeUndefined()` (best-effort, no propaga). Patrón espejo del test de `clear()` L168-179. **CD-4.** |
| **AC-2** | `use-cases.test.ts` (nuevo, §4.6 AC-6b) | `ResumeKyc` con `ThrowingSaveKycStore`: `res.kind === "passed"` y `repo.get(id)?.snapshot.status === "kyc_passed"` — KYC persistido pese al fallo del cache; `execute()` NO lanza. |
| **AC-3** | `use-cases.test.ts` (nuevo, §4.6 AC-6c) | `StartKyc` rama completed con `ThrowingSaveKycStore`: `res.kind === "done"` y `repo.get(id)?.snapshot.status === "kyc_passed"`. |
| **AC-4** | (comportamiento) Cubierto por AC-2/AC-3 a nivel use-case: como `execute()` resuelve normal (nunca lanza por el cache), el loop de `flow.tsx` (L109-113) alcanza `passed`/`failed` — nunca cae al timeout por esta causa. Sin nuevo test de UI (CD-6: no reabrir WKH-188); el harness de `flow.test.tsx` de WKH-188 sigue verde. |
| **AC-5 (regresión cero)** | `use-cases.test.ts` (existentes) | "KYC-once: la 2da remesa reusa el KYC" (L166-177) y "Didit redirect → resume aplica…" (L179-189) y "ConnectWallet devuelve KYC recordado" (L148-164) **siguen verdes** tras el reorder (cuando `save()` tiene éxito, el comportamiento es byte-a-byte). |
| **AC-6** | (a) `kyc-store.test.ts` (b)(c) `use-cases.test.ts` | Los 3 tests concretos exigidos por el work-item (ver AC-1/2/3). |

**Regresión adicional a vigilar (verde esperado, sin cambios):** el happy path
`use-cases.test.ts:72-85`, el `FallbackKycGateway` AC-12 (L243-266), y el V1-estrella de WKH-183
(L191-204, usa `pending`, no `kycStore` — ortogonal al reorder).

---

## 7. Paralelismo y no-colisión (WKH-198)

WKH-198 (Hallazgo A de la misma auditoría #2) toca `remittance.ts`, `wallet.ts`, `gateways.ts`,
`quote/route.ts`. WKH-199 toca `kyc-store.ts`, `resume-kyc.ts`, `start-kyc.ts`, `fakes.ts`,
`kyc-store.test.ts`, `use-cases.test.ts`, `project-context.md`. **Sin overlap de archivos** → ambas
avanzan F2/F3 sin coordinación de merge. Único punto de contacto potencial: `use-cases.test.ts` (si
WKH-198 agregara tests de quote-expiry ahí) — el diff de esta HU se limita a los 2 tests nuevos de
AC-6; el Dev re-verifica por contenido (no por línea) antes de editar, y agrega en bloque nuevo (no
reformatea tests ajenos).

---

## 8. Análisis de regresión (AC-5)

- **`save()` happy path:** el try/catch es transparente cuando `setItem` no lanza → serialización y
  round-trip idénticos. Los tests de persistencia/TTL/scrub/round-trip de `kyc-store.test.ts` (L57-145)
  siguen verdes sin cambios.
- **Reorder resume/start:** cuando `kycStore.save()` tiene éxito, ambos writes ocurren igual; solo
  cambia el ORDEN relativo (crítico primero, cache después). `ConnectWallet`/2ª-remesa leen del store
  con el mismo contenido → KYC-once intacto.
- **Rama redirect de start-kyc (WKH-183):** NO se toca. Rama done/completed: solo reorder de una línea.
- **Dominio/FSM:** cero cambios en `remittance.ts`/`TRANSITIONS` — el estado persistido y las
  transiciones son idénticos.
- **`kyc-pending-store.ts` / `flow.tsx` overlay:** intactos (CD-6).

---

## 9. Readiness Check

- [x] Work-item leído completo (6 ACs, 6 CDs heredados, DT-1..4, Scope IN/OUT).
- [x] Exemplars verificados con Read (paths + líneas reales al 2026-07-14): `kyc-store.ts` (90-124),
      `resume-kyc.ts` (46-51), `start-kyc.ts` (51-70), `kyc-pending-store.ts` (1-32, precedente WKH-183),
      `fakes.ts` (143-254, `ThrowingKycPendingStore`/`FakeKycStore`/`ThrowingClearKycStore`),
      `kyc-store.test.ts` (9-29 `MemStorage`, 168-179 test clear), `use-cases.test.ts` (29-63 setup,
      179-204 tests redirect/resume/V1), `project-context.md` (103-106).
- [x] **[NEEDS CLARIFICATION] resuelto (DT-5)**: tests de ResumeKyc/StartKyc → `use-cases.test.ts`
      (patrón establecido); test unit del store → `kyc-store.test.ts`. Sin archivos dedicados.
- [x] CD-1 respetado: `v.approved && v.payoutAllowed` intacto (se mueve la línea completa).
- [x] CD-3 respetado: try/catch de `save()` = swallow best-effort simétrico a `clear()` de kyc-store,
      NO al re-throw de kyc-pending-store.
- [x] CD-6 respetado: `kyc-pending-store.ts`, rama redirect de start-kyc, overlay/timeout de flow.tsx
      (WKH-188) NO se tocan.
- [x] Auto-Blindaje histórico incorporado: CD-7 (drift de firmas, WKH-180/181), CD-8 (símbolos
      inexistentes, WKH-180), CD-9 (`noUncheckedIndexedAccess`, WKH-179/181), CD-10 (grep de callers).
- [x] Fix simétrico al precedente WKH-183 (reorder + fake `Throwing*Store`), documentado en §1.
- [x] Plan de tests ≥1 por AC, con los 3 tests concretos que exige AC-6 (a: setItem throw en save;
      b: ResumeKyc persiste pese al fallo; c: StartKyc idem).
- [x] Paralelismo con WKH-198 verificado: sin overlap de archivos (§7).
- [x] Sin `[NEEDS CLARIFICATION]` pendientes.

**SDD LISTO para SPEC_APPROVED.**
