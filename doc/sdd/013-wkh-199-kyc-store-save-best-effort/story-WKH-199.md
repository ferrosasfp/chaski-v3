# Story File — #199: KYC re-brick — `KycStore.save()` best-effort + reorder critical-write-first

> SDD: doc/sdd/013-wkh-199-kyc-store-save-best-effort/sdd.md
> Fecha: 2026-07-14
> Branch: fix/199-kyc-store-save-best-effort

---

## Goal

`KycStore.save()` (`kyc-store.ts`) escribe en `localStorage` SIN try/catch: si `setItem` lanza
(quota / private-browsing) la excepción sube al caller. En `ResumeKyc`/`StartKyc` ese `save()` corre
ANTES del write crítico (`applyKyc()` + `repo.save()`), así que un fallo del **cache no-crítico**
bloquea la persistencia del KYC aprobado y "re-brickea" la remesa (misma clase de bug que WKH-183
resolvió en `kyc-pending-store`). Fix en dos capas: (1) envolver el `setItem` de `save()` en un
try/catch best-effort **idéntico al de `clear()`**; (2) reordenar `kycStore.save()` para que corra
DESPUÉS de `repo.save()` en ambos use-cases. Sin cambios de dominio, firmas ni scope.

## Acceptance Criteria (EARS)

> Copiados del SDD/work-item aprobado. QA los verifica en F4.

1. **AC-1**: IF `localStorage.setItem` lanza dentro de `KycStore.save()` (quota / private-browsing),
   THEN the system SHALL capturar la excepción y resolver normalmente (best-effort, sin propagar) —
   simétrico con `clear()` (`kyc-store.ts:118-122`).
2. **AC-2**: WHEN `ResumeKyc.execute()` procesa una decisión terminal `approved && payoutAllowed` Y el
   write de cache `kycStore.save()` falla, the system SHALL igual ejecutar `applyKyc()` + `repo.save()`,
   de modo que el KYC quede persistido en el `RemittanceRepository` y `execute()` resuelva
   `{ kind: "passed", snapshot }` (nunca lanzar por la falla del cache).
3. **AC-3**: WHEN `StartKyc.execute()` recibe `kind: "completed"` con `approved && payoutAllowed` Y el
   write de cache `kycStore.save()` falla, the system SHALL igual ejecutar `applyKyc()` + `repo.save()`,
   de modo que `execute()` resuelva `{ kind: "done", snapshot }` reflejando `kyc_passed`.
4. **AC-4**: WHILE el write de cache falla silenciosamente dentro de `resumeKyc.execute()`, the system
   SHALL evitar que el loop de resume en `flow.tsx` (L109-113) entre al timeout por esa causa — el loop
   SHALL alcanzar `step:"confirm"` (passed) o `step:"verify"` (failed) según la decisión real.
5. **AC-5**: the system SHALL preservar el comportamiento actual byte-a-byte cuando `kycStore.save()` SÍ
   tiene éxito (regresión cero al KYC-once: `ConnectWallet` / 2ª remesa reusan el KYC recordado).
6. **AC-6**: the test suite SHALL incluir, como mínimo: (a) test en `kyc-store.test.ts` que simule
   `setItem` lanzando dentro de `save()` y assertee `resolves.toBeUndefined()`; (b) test en
   `use-cases.test.ts` que fuerce el fallo del cache en `ResumeKyc` y verifique
   `repo.get(id)?.snapshot.status === "kyc_passed"`; (c) el mismo para `StartKyc` rama `"completed"`.

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/test-support/fakes.ts` | Modificar (agregar clase) | Agregar `ThrowingSaveKycStore implements KycStore`: `save()` lanza, `get`/`clear` in-memory | `ThrowingClearKycStore` (mismo archivo, L243-254) |
| 2 | `src/infrastructure/kyc-store.ts` | Modificar | Envolver `s.setItem(...)` de `save()` (L105) en try/catch best-effort idéntico a `clear()` (L118-122) | `clear()` mismo archivo, L118-122 |
| 3 | `src/application/use-cases/resume-kyc.ts` | Modificar | Mover el `if (v.approved && v.payoutAllowed) await this.kycStore.save(...)` (L47) a DESPUÉS de `await this.repo.save(r)` (L49) | §4.2 SDD |
| 4 | `src/application/use-cases/start-kyc.ts` | Modificar | Mover el `if (...) await this.kycStore.save(...)` (L53) a DESPUÉS de `await this.repo.save(r)` (L55), SOLO rama `"completed"` | §4.3 SDD |
| 5 | `src/infrastructure/kyc-store.test.ts` | Modificar (agregar test) | Test AC-1: `MemStorage` con `setItem` override que lanza → `store.save("0xAAA", kyc)` `.resolves.toBeUndefined()` | test "AC-5: clear NO propaga" L168-179 |
| 6 | `src/application/use-cases.test.ts` | Modificar (widen setup + 2 tests) | Widen `setup()` opts `kycStore` a `KycStore`; agregar test AC-2 (ResumeKyc) y AC-3 (StartKyc completed) con `ThrowingSaveKycStore` | tests L179-189 (resume), L166-177 (completed) |
| 7 | `project-context.md` | Modificar | Corregir nota "Patrón de acceso a base de datos" (L103-106): `kyc-store.ts` `save`/`clear` = best-effort/fail-silent; `kyc-pending-store.ts` = re-lanza | §4.7 SDD |

## Exemplars

### Exemplar 1: try/catch best-effort de `clear()` (para el fix de `save()`, archivo #2)
**Archivo**: `src/infrastructure/kyc-store.ts` L110-123
```ts
async clear(address: string): Promise<void> {
  const all = this.read();
  delete all[address.toLowerCase()];
  const s = ls();
  if (!s) {
    this.mem = all;
    return;
  }
  try {
    s.setItem(KEY, JSON.stringify(all));
  } catch {
    /* quota / private-browsing: best-effort — no throw (AC-5/CD-5) */
  }
}
```
**Patrón clave**: el `if (!s)` retorna temprano ANTES del try/catch (SSR); el try/catch envuelve SOLO
el `s.setItem(...)`; catch vacío que traga (swallow), sin `throw`, sin distinguir tipo de error.
Replicar byte-a-byte en `save()` (ajustando solo el comentario a AC-1/CD-3).

### Exemplar 2: `ThrowingClearKycStore` (molde para `ThrowingSaveKycStore`, archivo #1)
**Archivo**: `src/test-support/fakes.ts` L243-254
```ts
export class ThrowingClearKycStore implements KycStore {
  private m = new Map<string, KycVerification>();
  async get(address: string): Promise<KycVerification | null> {
    return this.m.get(address.toLowerCase()) ?? null;
  }
  async save(address: string, kyc: KycVerification): Promise<void> {
    this.m.set(address.toLowerCase(), kyc);
  }
  async clear(_address: string): Promise<void> {
    throw new Error("kyc_store_unavailable");
  }
}
```
**Patrón clave**: invertir cuál método lanza — en `ThrowingSaveKycStore` **`save()` lanza** y `clear()`
es in-memory. Reusar imports YA presentes (`KycStore`, `KycVerification`, `Map` nativo) — CD-8, sin
símbolos nuevos.

### Exemplar 3: test de excepción en storage (para archivo #5)
**Archivo**: `src/infrastructure/kyc-store.test.ts` L168-179 (+ fixture `kyc` L32-45, `MemStorage` L9-29)
```ts
it("AC-5: clear NO propaga la excepción si setItem lanza (quota/private-browsing)", async () => {
  const throwing = new (class extends MemStorage {
    override setItem(): void {
      throw new Error("QuotaExceededError");
    }
  })();
  (globalThis as { window?: { localStorage: Storage } }).window = { localStorage: throwing };
  const store = new LocalKycStore();
  await expect(store.clear("0xAAA")).resolves.toBeUndefined();
});
```
**Patrón clave**: subclase anónima de `MemStorage` con `override setItem` que lanza; inyectada en
`globalThis.window.localStorage`; assert `.resolves.toBeUndefined()`. Para el test AC-1: idéntico pero
`store.save("0xAAA", kyc)` en vez de `clear`, reusando la fixture `kyc` ya definida (L32-45).

### Exemplar 4: setup + tests de use-cases (para archivo #6)
**Archivo**: `src/application/use-cases.test.ts` — `setup()` L29-63, test resume L179-189, KYC-once L166-177
```ts
function setup(opts?: {
  kyc?: FakeKycGateway;
  payout?: FakePayoutGateway;
  kycStore?: FakeKycStore;   // ← ⚠️ WIDEN a KycStore (ver Constraint OBLIGATORIO abajo)
  pending?: KycPendingStore;
}) { /* ... */ }

// Test resume (molde AC-2):
const { create, startKyc, lock, resumeKyc } = setup({ kyc: new FakeKycGateway({}, true) });
const r0 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
await lock.execute({ remittanceId: r0.snapshot.id });
const start = await startKyc.execute({ remittanceId: r0.snapshot.id, address: "0xSender" });
expect(start.kind).toBe("redirect");
const res = await resumeKyc.execute();
expect(res.kind).toBe("passed");
if (res.kind === "passed") expect(res.snapshot.status).toBe("kyc_passed");

// Test KYC-once completed (molde AC-3):
const { create, startKyc, lock } = setup({ kycStore });
const r1 = await create.execute({ amountUsd: 400, beneficiary: beneficiary() });
await lock.execute({ remittanceId: r1.snapshot.id });
const res = await startKyc.execute(kycInput(r1.snapshot.id)); // FakeKycGateway default → completed
expect(res.kind).toBe("done");
```
**Patrón clave**: `setup()` inyecta `kycStore`/`pending`; `repo` se expone para el assert de persistencia
(`(await repo.get(id))?.snapshot.status`). `FakeKycGateway({}, true)` fuerza redirect (path resume);
`FakeKycGateway` default resuelve `completed` (path start). `beneficiary()`, `kycInput()`,
`ThrowingKycPendingStore` ya importados en el archivo.

## ⚠️ Edición crítica en archivo #6 (setup type widening)

`setup()` tipa hoy `kycStore?: FakeKycStore` (clase concreta con campo privado `m`). Por el tipado
estructural de TS con miembros privados, `ThrowingSaveKycStore` **NO es asignable** a `FakeKycStore` →
`tsc` rojo si lo pasás directo. Solución OBLIGATORIA y mínima:

1. En el import type de ports agregar `KycStore`:
   `import type { KycPendingStore, KycStore } from "./ports";` (hoy solo importa `KycPendingStore`, L12).
2. Cambiar la firma del opts: `kycStore?: FakeKycStore` → `kycStore?: KycStore` (L32). `FakeKycStore`
   sigue siendo asignable a `KycStore`, así que los callers existentes NO se rompen.
3. Importar la fake nueva desde `../test-support/fakes`: agregar `ThrowingSaveKycStore` a la lista de
   imports (bloque L13-27).

Esto NO viola CD-7: no cambia la firma del port `KycStore` ni de los ctors/`save()` — solo **ensancha**
el tipo de un parámetro opcional del helper de test para aceptar cualquier implementación del port.

## Constraint Directives

### OBLIGATORIO
- **CD-3**: el try/catch de `save()` debe ser **simétrico al de `clear()` de kyc-store** (swallow
  best-effort, sin re-throw, sin distinguir error) — NO al de `kyc-pending-store.ts` (que re-lanza).
  Mismo estilo/comentario que L118-122.
- **CD-4**: el test AC-1 en `kyc-store.test.ts` reusa el patrón `MemStorage` con `setItem` override (el
  del test AC-5 de `clear()`, L168-179).
- **CD-5**: agregar `ThrowingSaveKycStore` en `test-support/fakes.ts` (paralela a `ThrowingClearKycStore`)
  y usarla en los tests de `ResumeKyc`/`StartKyc`.
- **CD-7 (Auto-Blindaje WKH-180/181)**: PROHIBIDO cambiar la firma del port `KycStore` o de
  `save()`/ctores de los use-cases. La fake se **agrega**, no muta. (El widening del opts de `setup()` es
  ensanchar, no cambiar el port — permitido, ver sección crítica arriba.)
- **CD-8 (Auto-Blindaje WKH-180)**: al escribir `ThrowingSaveKycStore` reusar imports YA presentes en
  `fakes.ts` (`KycStore`, `KycVerification`); NO inventar símbolos de `ports.ts`/`remittance.ts`.
- **CD-9 (Auto-Blindaje WKH-179/181)**: `tsconfig` tiene `noUncheckedIndexedAccess`; evitar index-access
  crudo en tests (`arr[0].x`); usar `?.`/guardas. Usar `(await repo.get(id))?.snapshot.status`.
- **CD-10 (Auto-Blindaje WKH-180/181/187)**: antes de reordenar, correr
  `grep -rn "kycStore.save\|\.save(" src/application/use-cases/resume-kyc.ts src/application/use-cases/start-kyc.ts`
  y confirmar que las únicas llamadas a `kycStore.save()` son las dos que reordenás.

### PROHIBIDO
- **CD-1**: NO cambiar la condición `v.approved && v.payoutAllowed` que gatea el `kycStore.save()`. Se
  mueve la **línea completa** (el `if` viaja intacto con ella).
- **CD-2**: NO tocar el gate `confirm_requires_kyc_passed` (`domain/remittance.ts`) ni la autoridad
  server-side de payout (`confirm-and-send.ts`, WKH-180).
- **CD-6**: NO tocar `kyc-pending-store.ts`, la rama `redirect` de `start-kyc.ts` (L59-70, WKH-183), el
  overlay/timeout de `flow.tsx` (WKH-188), ni `FakeKycStore`/`ThrowingClearKycStore`/otras fakes
  existentes. Fix acotado, sin expansión de scope.
- NO agregar dependencias nuevas (ninguna).
- NO modificar archivos fuera de la tabla "Files to Modify/Create".
- NO "mejorar" código adyacente ni reformatear tests ajenos (WKH-198 corre en paralelo sobre otros
  archivos; en `use-cases.test.ts` agregá en bloque nuevo, no toques tests existentes salvo el widen del
  `setup()` opts).

## Test Expectations

| Test | ACs | Framework | Tipo |
|------|-----|-----------|------|
| `kyc-store.test.ts` — "AC-1: save NO propaga si setItem lanza" | AC-1 | vitest | unit |
| `use-cases.test.ts` — "AC-2: ResumeKyc persiste kyc_passed pese al fallo del cache" | AC-2 | vitest | unit (use-case) |
| `use-cases.test.ts` — "AC-3: StartKyc completed persiste kyc_passed pese al fallo del cache" | AC-3 | vitest | unit (use-case) |
| (regresión) tests existentes de KYC-once / redirect-resume / V1-estrella | AC-4, AC-5 | vitest | siguen verdes |

**Nota crítica (por qué el reorder DT-2 es indispensable):** con `ThrowingSaveKycStore` (que SÍ lanza,
independiente del try/catch de DT-1), los tests AC-2/AC-3 **solo pasan si `repo.save` corrió ANTES** del
`kycStore.save`. Sin el reorder, `kycStore.save` lanzaría antes de `applyKyc`/`repo.save`, `execute()`
rechazaría y el repo quedaría sin `kyc_passed` → test rojo. Así el test verifica el reorder, mientras
AC-1 verifica el try/catch en aislamiento. **Escribí ambos tests DESPUÉS de aplicar W1 (reorder).**

### Test-First
Lógica de negocio / infraestructura con condicional → **Sí** (test-first recomendado). En la práctica,
por la nota anterior, los tests AC-2/AC-3 requieren el reorder ya aplicado para pasar; ordená: W1
(reorder + try/catch) → W2 (tests). El test AC-1 sí puede escribirse antes del fix de `save()` (fallará
rojo hasta aplicar el try/catch) si querés test-first estricto en el store.

## Waves

### Wave -1: Environment Gate (verificar antes de tocar código)
```bash
cd /home/ferdev/.openclaw/workspace/chaski-v2
npm install 2>/dev/null || echo "Sin package.json"
# Archivos base del Scope IN existen:
ls src/infrastructure/kyc-store.ts src/application/use-cases/resume-kyc.ts \
   src/application/use-cases/start-kyc.ts src/test-support/fakes.ts \
   src/infrastructure/kyc-store.test.ts src/application/use-cases.test.ts \
   project-context.md 2>/dev/null || echo "FALTA archivo base"
# Baseline verde antes de empezar:
npx tsc --noEmit && npx vitest run
```
**Si algo falla en Wave -1:** PARAR y reportar al orquestador. No implementar sobre entorno roto.

### Wave 0 (Serial Gate — completar antes de W2)
- [ ] W0.1: Agregar `ThrowingSaveKycStore` a `src/test-support/fakes.ts` (archivo #1, Exemplar 2).
      Verificar: `npx tsc --noEmit` limpio.

### Wave 1 (Parallelizable — los 3 archivos son independientes entre sí)
- [ ] W1.1: try/catch best-effort en `KycStore.save()` → `kyc-store.ts` (archivo #2, Exemplar 1). CD-3.
- [ ] W1.2: reorder `kycStore.save()` DESPUÉS de `repo.save()` → `resume-kyc.ts` (archivo #3). CD-1.
- [ ] W1.3: reorder `kycStore.save()` DESPUÉS de `repo.save()`, SOLO rama `"completed"` → `start-kyc.ts`
      (archivo #4). CD-1, CD-6 (NO tocar rama redirect L59-70).
- Antes de W1.2/W1.3 correr el grep de CD-10.

### Wave 2 (Depende de W0 + W1)
- [ ] W2.1: test AC-1 en `kyc-store.test.ts` (archivo #5, Exemplar 3). Depende de W1.1.
- [ ] W2.2: widen `setup()` opts + tests AC-2 y AC-3 en `use-cases.test.ts` (archivo #6, Exemplar 4 +
      sección crítica). Depende de W0.1 + W1.2 + W1.3.

### Wave 3 (Final — doc + verificación, 100% independiente)
- [ ] W3.1: corregir nota "Patrón de acceso a base de datos" en `project-context.md` (archivo #7, §4.7).
- [ ] W3.2: `npx tsc --noEmit` limpio + `npx vitest run` verde (suite completa + 3 tests nuevos).

### Verificación Incremental
| Wave | Verificación |
|------|--------------|
| W0 | `tsc --noEmit` pasa |
| W1 | `tsc --noEmit` pasa (tests aún no dependen de W1 hasta W2) |
| W2 | `tsc --noEmit` + `vitest run` verde (incl. 3 nuevos) |
| W3 | full QA: `tsc` limpio + suite verde |

## Out of Scope

- `src/infrastructure/kyc-pending-store.ts` (WKH-183) — NO tocar.
- Rama `redirect` de `start-kyc.ts` (L59-70) — NO tocar.
- `flow.tsx` overlay / timeout (WKH-188) — NO tocar.
- `domain/remittance.ts`, `confirm-and-send.ts` (gate KYC / payout authority, WKH-180) — NO tocar.
- `FakeKycStore`, `ThrowingClearKycStore` y demás fakes existentes — NO mutar (solo AGREGAR la nueva).
- Archivos de WKH-198 (`remittance.ts`, `wallet.ts`, `gateways.ts`, `quote/route.ts`) — NO tocar.
- NO "mejorar" código adyacente, NO agregar funcionalidad no listada.

## Escalation Rule

> Si algo no está en este Story File, Dev PARA y escala a Architect. No inventar, no asumir.

Situaciones de escalation:
- El grep de CD-10 encuentra llamadas a `kycStore.save()` FUERA de las dos líneas esperadas.
- Widen del `setup()` opts rompe `tsc` en un caller no previsto de `use-cases.test.ts`.
- La firma real del port `KycStore` en `ports.ts` difiere de `{ get; save; clear }`.
- Conflicto de merge con WKH-198 en `use-cases.test.ts`.
- Cualquier ambigüedad en un AC o necesidad de tocar un archivo fuera de la tabla.

---

*Story File generado por NexusAgil — F2.5 (WKH-199)*
