# Work Item — [WKH-199] KYC re-brick — `KycStore.save()` best-effort

## Resumen
`LocalKycStore.save()` (`src/infrastructure/kyc-store.ts:97-106`) NO está envuelto en
try/catch, a diferencia de `clear()` (`:118-122`) que sí lo está. En `resume-kyc.ts:47` y en
la rama `"completed"` de `start-kyc.ts:51-57`, `kycStore.save()` (cache no-crítico,
KYC-once) se llama ANTES de `applyKyc()`+`repo.save()` (el store crítico). Si `setItem`
lanza (quota excedida / Safari private-browsing), la excepción aborta el `execute()` del
use-case ANTES de persistir el KYC aprobado en el repo: en `flow.tsx:109-113` el
`try { res = await c.resumeKyc.execute(); } catch { break; }` corta el loop y cae al
timeout — un KYC que YA PASÓ se pierde, el usuario ve la card de timeout y al reintentar
arranca un Didit nuevo. Es la misma clase de bug ("write no-crítico bloquea el crítico")
que WKH-183 cerró para `kyc-pending-store.ts`/`start-kyc.ts` (rama redirect), reincidiendo
acá en el cache de KYC-once. Fix: `KycStore.save()` best-effort (try/catch simétrico a
`clear()`) + reordenar el write no-crítico DESPUÉS del crítico en ambos use-cases.

## Sizing
- SDD_MODE: bugfix
- Estimación: S
- Branch sugerido: fix/199-kyc-store-save-best-effort

## Acceptance Criteria (EARS)

- AC-1: IF `localStorage.setItem` lanza dentro de `KycStore.save()` (quota excedida /
  private-browsing), THEN the system SHALL capturar la excepción y resolver normalmente
  (best-effort, sin propagar el error al caller) — simétrico con `clear()`
  (`kyc-store.ts:118-122`).

- AC-2: WHEN `ResumeKyc.execute()` procesa una decisión terminal `approved && payoutAllowed`
  Y el write de cache `kycStore.save()` falla, the system SHALL igual ejecutar
  `applyKyc()` + `repo.save()`, de modo que el KYC aprobado quede persistido en el
  `RemittanceRepository` y `execute()` resuelva `{ kind: "passed", snapshot }` (nunca lanzar
  por la falla del cache).

- AC-3: WHEN `StartKyc.execute()` recibe un resultado `kind: "completed"` del
  `KycGateway.start()` con `approved && payoutAllowed` Y el write de cache
  `kycStore.save()` falla, the system SHALL igual ejecutar `applyKyc()` + `repo.save()`, de
  modo que `execute()` resuelva `{ kind: "done", snapshot }` reflejando `kyc_passed` (nunca
  lanzar por la falla del cache).

- AC-4: WHILE el write de cache (`kycStore.save()`) falla silenciosamente dentro de
  `resumeKyc.execute()`, the system SHALL evitar que el loop de resume en `flow.tsx`
  (`c.resumeKyc.execute()` en el `try/catch { break }`, L109-113) entre al camino de
  timeout por esa causa — el loop SHALL alcanzar `step: "confirm"` (passed) o
  `step: "verify"` (failed) según el resultado real de la decisión, nunca el fallback de
  timeout causado únicamente por un error de escritura de cache.

- AC-5: the system SHALL preservar el comportamiento actual byte-a-byte cuando
  `kycStore.save()` SI tiene éxito (regresión cero al KYC-once: `ConnectWallet`/segunda
  remesa de la misma wallet reusan el KYC recordado, igual que hoy).

- AC-6: the test suite SHALL incluir, como mínimo: (a) un test en `kyc-store.test.ts` que
  simule `setItem` lanzando dentro de `save()` (mismo patrón `MemStorage` del test existente
  "AC-5: clear NO propaga..." L168-179) y assertee `resolves.toBeUndefined()`; (b) un test
  en `use-cases.test.ts` (o archivo dedicado) que fuerce el fallo del cache en `ResumeKyc` y
  verifique `repo.get(id)?.snapshot.status === "kyc_passed"`; (c) el mismo test para
  `StartKyc` rama `"completed"`.

## Scope IN
- `src/infrastructure/kyc-store.ts` — envolver `save()` en try/catch best-effort (idéntico
  patrón a `clear()`, L118-122).
- `src/application/use-cases/resume-kyc.ts` — reordenar `kycStore.save()` (L47) DESPUÉS de
  `applyKyc()`+`repo.save()` (L48-49).
- `src/application/use-cases/start-kyc.ts` — mismo reorden en la rama `"completed"`
  (L51-57); la rama `redirect` (L59-70) ya sigue este patrón desde WKH-183, NO tocar.
- `src/infrastructure/kyc-store.test.ts` — nuevo test de `setItem` lanzando en `save()`.
- `src/application/use-cases.test.ts` y/o tests dedicados
  (`resume-kyc.test.ts`/`start-kyc.test.ts`, decisión del Architect en F2) + nueva fake
  `ThrowingSaveKycStore` en `src/test-support/fakes.ts` (paralela a
  `ThrowingKycPendingStore`, que ya existe).
- `project-context.md` — actualizar la nota "Patrón de acceso a base de datos" (hoy dice
  "nunca fallo silencioso en save/clear", lo cual ya no es preciso post-fix: `save()` Y
  `clear()` de `kyc-store.ts` son AMBOS best-effort/fail-silent por diseño).

## Scope OUT
- El resto del flujo KYC: `kyc-pending-store.ts` (ya resuelto por WKH-183, mismo patrón, no
  reabrir), `didit/decision.ts`, `didit/kyc-gateway.ts`.
- La autoridad server-side de payout (`confirm-and-send.ts`, WKH-180) y el gate de
  compliance `confirm_requires_kyc_passed` (`remittance.ts`) — invariantes intactas.
- El overlay UX / timeout corto del resume-loop (`flow.tsx`) — ya cerrado por WKH-188; esta
  HU NO reabre ese fix, solo evita que el loop entre al camino de timeout por una causa
  distinta (falla de cache).
- `persistence.ts` (repo de remesas) — sin cambios, ya es el store crítico correcto.
- El fix de `isQuoteExpired`/shape de `expiresAt` (hallazgo A de la misma auditoría, WKH-198)
  — HU distinta, sin overlap de archivos.

## Decisiones técnicas (DT-N)
- DT-1: Fix principal = envolver `KycStore.save()` en try/catch best-effort (mismo bloque
  y comentario que `clear()`), NO solo reordenar. Justificación: el reorder solo (sin
  try/catch) deja la clase `KycStore` con un método asimétrico — cualquier caller futuro
  que llame `save()` antes de un write crítico (patrón que YA existe hoy en dos lugares)
  reintroduce el bug. El try/catch en el método es la defensa de raíz.
- DT-2: Reordenar `kycStore.save()` DESPUÉS de `applyKyc()`+`repo.save()` en ambos
  use-cases (defensa en profundidad, mismo principio "critical write first" que WKH-183 ya
  estableció en la rama `redirect` de `start-kyc.ts`). Aunque DT-1 ya vuelve el write
  no-crítico inofensivo, el reorden documenta la intención (comentario inline) y protege
  ante un futuro `KycStore` que NO sea `LocalKycStore` (p.ej. un adapter remoto sin
  try/catch propio).
- DT-3: NO tocar la condición de gate `v.approved && v.payoutAllowed` que decide si se
  llama `kycStore.save()` en ninguno de los dos use-cases — se mantiene idéntica,
  evita side-effects fuera de scope.
- DT-4: Actualizar `project-context.md` (sección "Patrón de acceso a base de datos") al
  cerrar esta HU para reflejar que `save()`/`clear()` de `kyc-store.ts` son ambos
  best-effort — evita que una HU futura asuma "throw" por la doc desactualizada.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO cambiar la condición de negocio `approved && payoutAllowed` que decide
  si se persiste en el `KycStore` — queda intacta en `resume-kyc.ts` y `start-kyc.ts`.
- CD-2: PROHIBIDO tocar el gate `confirm_requires_kyc_passed` (`remittance.ts`) o la
  autoridad server-side de payout (`confirm-and-send.ts`, WKH-180) — fuera de scope.
- CD-3: OBLIGATORIO que el try/catch de `KycStore.save()` sea simétrico al de `clear()`
  (mismo estilo: `try { s.setItem(...) } catch { /* comentario best-effort */ }`), sin
  distinguir tipos de error (mismo criterio hoy en `clear()`).
- CD-4: OBLIGATORIO el test de `kyc-store.test.ts` que simula `setItem` lanzando DENTRO de
  `save()` (reusar el patrón `MemStorage` con `setItem` override, ya usado en el test AC-5
  de `clear()`).
- CD-5: OBLIGATORIO agregar la fake `ThrowingSaveKycStore` en `test-support/fakes.ts`
  (paralela a `ThrowingKycPendingStore` existente) y usarla en los tests de `ResumeKyc`/
  `StartKyc` que verifiquen persistencia del KYC aprobado pese al fallo del cache.
- CD-6: PROHIBIDO tocar `kyc-pending-store.ts`, el overlay/timeout de `flow.tsx` (WKH-188)
  ni ninguna otra invariante de negocio fuera de la reordenada/try-catch descrita — fix
  acotado, sin expansión de scope.

## Missing Inputs
- Ninguno bloqueante. El hallazgo viene con evidencia archivo:línea completa de la
  auditoría adversarial #2 y el patrón de fix ya tiene precedente exacto en WKH-183
  (mismo repo, mismo tipo de reorden, misma fake `Throwing*Store`).
- [NEEDS CLARIFICATION] no bloqueante: si los tests nuevos de `ResumeKyc`/`StartKyc` van en
  `use-cases.test.ts` (archivo compartido existente) o en archivos dedicados
  `resume-kyc.test.ts`/`start-kyc.test.ts` — decisión de estilo del Architect en F2, no
  afecta el comportamiento ni las ACs.

## Análisis de paralelismo
- Esta HU trabaja sobre el estado ya mergeado de WKH-178..188 (`main`). No bloquea ninguna
  HU downstream conocida (no toca `confirm-and-send.ts`, `ports.ts` de autoridad, ni
  value-delivery de WKH-186).
- Sin colisión de merge esperada: los últimos en tocar `start-kyc.ts`/`resume-kyc.ts` fueron
  WKH-183 (reorden en la rama `redirect`) y WKH-187 (comentarios de reorden money-path),
  ambas ya mergeadas; ninguna HU abierta actualmente toca `kyc-store.ts`,
  `resume-kyc.ts` o `start-kyc.ts`.
- **Corre en paralelo con WKH-198** (Hallazgo A de la misma auditoría adversarial #2,
  analyst paralelo): WKH-198 toca `remittance.ts`, `wallet.ts`, `gateways.ts` y
  `quote/route.ts`; WKH-199 toca `kyc-store.ts`, `resume-kyc.ts`, `start-kyc.ts` y
  `test-support/fakes.ts`. Sin overlap de archivos detectado — ambas pueden avanzar F2/F3
  sin coordinación de merge.
- NNN `012` fue tomado primero por WKH-198 (colisión detectada en F1) — esta HU usa `013`
  (ver stub obsoleto en `doc/sdd/012-wkh-199-kyc-store-save-best-effort/work-item.md`).
