# F4 Validation Report — WKH-187: Reorden quote-antes-del-KYC (MONEY-PATH)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-12
**Repo**: `chaski-v2` · branch `feat/187-quote-before-kyc-reorder` · commit `e5155e2`

## Runtime gates (ejecutados por QA)
- `npx tsc --noEmit` → exit 0, sin errores.
- `npx vitest run` → **PASS 235 / FAIL 0** (matches el esperado del Story File §5 Wave 3).
- `npm run build` (`next build --webpack`) → `✓ Compiled successfully`, `Finished TypeScript`, 8 páginas generadas, sin errores (solo warning inocuo de lockfile duplicado en el monorepo, no relacionado a esta HU).

## VERIFICACIÓN CRÍTICA DE COMPLIANCE

**(a) `confirm-and-send.ts` sin tocar (CD-3):**
```
$ git diff main...HEAD -- src/application/use-cases/confirm-and-send.ts
(vacío)
```
Confirmado: el diff completo de la HU no incluye ni una línea de `confirm-and-send.ts`. La autoridad server-side WKH-180 (`authority.authorize()`) y los re-checks de expiry corren exactamente igual.

**(b) `remittance.ts` — único cambio es `TRANSITIONS` (CD-13):**
```
$ git diff main...HEAD -- src/domain/remittance.ts
 1 file changed, 11 insertions(+), 11 deletions(-)
```
El diff completo (un solo hunk, L83-99 aprox) reescribe únicamente el objeto `TRANSITIONS` con comentarios de razón de negocio inline (CD-4). `confirm()` (L219-226), `applyKyc()` (L202-208), `attachQuote()` (L210-216), `startKyc()` (L198-200) y `to()` (L191-196, shallow-merge) quedan **byte-idénticos** — no aparecen en ningún hunk del diff.

Gate duro verificado en el código actual (`src/domain/remittance.ts`):
- L221: `throw new Error("confirm_requires_kyc_passed")`
- L223: `throw new Error("confirm_requires_quote")`
- L224: `throw new Error("confirm_quote_expired")` (vía `isQuoteExpired`)
- L225: `this.to("confirmed", now)` — ocurre DESPUÉS de los tres guards.

**(c) T-COMPLIANCE prueba el gate en el nuevo orden** — `src/domain/remittance.test.ts:112-137`:
```ts
describe("WKH-187 — reorden quote-antes-del-KYC (money-path INVIOLABLE)", () => {
  it("T-COMPLIANCE: confirm() sin KYC lanza confirm_requires_kyc_passed en el NUEVO orden", () => {
    // desde `quoted` (created→quoted, kyc=null): el path pre-KYC más peligroso (DT-1b abre quoted→confirmed)
    ...
    expect(() => q.confirm(T0)).toThrow(/confirm_requires_kyc_passed/); // L121
    expect(q.status).toBe("quoted"); // NO transicionó a confirmed        // L122
    // desde `kyc_pending` ...
    expect(() => p.confirm(T0)).toThrow(/confirm_requires_kyc_passed/);  // L129
    // KYC rechazado tampoco confirma
    expect(() => f.confirm(T0)).toThrow(/confirm_requires_kyc_passed/);  // L136
  });
```
Los 3 sub-casos (quoted sin KYC, kyc_pending, kyc rechazado) rechazan `confirm()` con el mismo error. Corrido en el suite completo → PASS (incluido en los 235/235).

Sin evidencia de debilitamiento, condicional-por-flag ni bypass. **CD-2/CD-3/CD-13 respetados.**

## ACs (9/9)

| AC | Texto (resumen EARS) | Status | Evidencia |
|----|----|--------|-----------|
| AC-1 | Al conectar wallet, cotizar ANTES de cualquier KYC y mostrar el monto lockeado | PASS | `flow.tsx:186-189` (`lockQuote` en `onConnect`, antes de `startKyc`); test `flow.test.tsx:190-202` T-AC1/T-REORDER — quote visible, sin UI de KYC |
| AC-2 | Paso pre-KYC con CTA explícita que dispara el KYC (no auto-inicio) | PASS | `flow.tsx:200` `const onContinue = () => setStep("verify")` (navegación pura, sin llamada de dominio); test `flow.test.tsx:205-215` T-AC2 |
| AC-3 | `confirm()` L219-222 byte-idéntico, rechaza sin KYC en el nuevo orden | PASS | diff vacío en el cuerpo de `confirm()`; test `remittance.test.ts:115-137` T-COMPLIANCE (ver arriba) |
| AC-4 | KYC-once salta `verify`, va directo a confirmación, preserva quote | PASS | `flow.tsx:190-198` (branch `rememberedKyc` → `setStep("confirm")` tras `lockQuote`+`startKyc`); test `flow.test.tsx:218-233` T-AC4 |
| AC-5 | Quote vencido entre `attachQuote()` y `confirm()` bloquea confirm y ofrece recuperación sin re-KYC | PASS | dominio: `remittance.test.ts:140-148` T-AC5a, `remittance.test.ts:169-182` T-REQUOTE; UI: `flow.test.tsx:247-267` T-AC5b (`onRelock` re-cotiza sin volver al escaneo) |
| AC-6 | Resume `passed` navega a confirmación usando el quote del snapshot, sin re-cotizar si vigente | PASS | `flow.tsx:126-145` (`isQuoteStillValid` vía `Remittance.rehydrate`, CD-11); test `flow.test.tsx:270-285` T-AC6 (`lockSpy` NO llamado) |
| AC-7 | Autoridad server-side WKH-180 sin cambio de comportamiento | PASS | `confirm-and-send.ts` diff vacío; tests intactos `confirm-and-send.test.ts:48` "authority false → payout_failed" y `:72` "kyc.approved forjado pero authority false → bloqueado (override server-side)" — solo el seeding se reordenó (L38-45), la aserción no cambió |
| AC-8 | Paso de confirmación final muestra badge de identidad junto al quote | PASS | `flow.tsx:628-640` (`rem.kyc?.identity` renderizado en el paso `confirm`, junto al breakdown del quote L610-627); test `flow.test.tsx:236-244` T-AC8 |
| AC-9 | Resto de la FSM post-`confirmed` sin cambios de comportamiento | PASS | `TRANSITIONS` diff — `confirmed`/`principal_in`/`payout_submitted`/`settled`/`payout_failed`/`refunded` idénticos (comentario "(sin cambios)" inline); test `remittance.test.ts:185-195` T-AC9 (happy path a `settled` intacto) |

## Regresión
- **Demo (WKH-178/184)**: banner ampliado a `review`/`confirm`/`track` (`flow.tsx:363`); `flow.test.tsx:108-127` T1 sigue verde con el monto PEN concreto y el banner una sola vez.
- **KYC-once (WKH-181/184)**: branch `rememberedKyc` preservado en `onConnect`, solo cambia el destino (`confirm` directo); T-AC4 verde. Reset "¿No sos vos?" intacto (T4/T5 en `flow.test.tsx:146-187`, verdes).
- **WKH-180/182/186 aguas abajo**: `confirm-and-send.ts` sin tocar; suite de 12 tests de `confirm-and-send.test.ts` verde con seeding reordenado (solo comentarios/orden de llamadas, sin lógica nueva); `use-cases.test.ts`, `track-remittance.test.ts`, `persistence.test.ts` ídem — spot-check confirma cero cambios de aserciones salvo strings de estado esperado (`"created"`→`"quoted"`, coherente con el reorden).
- **Harness RTL (WKH-185)**: `flow.test.tsx` T3 (fake timers, CD-10, patrón `Object.defineProperty` sobre `location`) intacto sin modificar.
- Suite completa: 235/235 verde (incluye los 12 tests del plan + regresión).

## Drift
- **Scope**: `git diff --name-only main...HEAD` = exactamente los 9 archivos de código del Scope IN (`remittance.ts`, `remittance.test.ts`, `start-kyc.ts`, `confirm-and-send.test.ts`, `track-remittance.test.ts`, `use-cases.test.ts`, `persistence.test.ts`, `flow.tsx`, `flow.test.tsx`) + docs (`doc/sdd/010-.../*`, `doc/sdd/_INDEX.md`). Cero archivos fuera de scope.
- **Waves**: un solo commit (`e5155e2`), pero el diseño interno respeta el orden W0→W3 (dominio → use-cases → UI → tests RTL), sin evidencia de violación de dependencia.
- **NO-TOCAR**: `confirm-and-send.ts`, `lock-quote.ts`, `resume-kyc.ts`, `connect-wallet.ts` no aparecen en el diff — confirmado.
- Stepper labels coherentes con §3.2: `["Enviar","Revisar","Identidad","Seguir"]` (`flow.tsx:20`).
- **drift: none.**

## CDs
- **CD-1**: sin archivos fuera de `chaski-v2/`. OK.
- **CD-2/CD-13 (compliance)**: `confirm()`/`applyKyc()`/`attachQuote()`/`startKyc()`/`to()` byte-idénticos (verificado por diff, no solo por lectura). OK.
- **CD-3 (compliance)**: `confirm-and-send.ts` diff vacío. OK.
- **CD-4**: las 3 transiciones nuevas de `TRANSITIONS` llevan razón de negocio inline (`remittance.ts:83-99`, comentarios `// WKH-187: ...`). OK.
- **CD-5**: demo + KYC-once verificados en regresión arriba. OK.
- **CD-11**: resume usa `Remittance.rehydrate(snapshot).isQuoteStillValid(now)` (`flow.tsx:128`), no recalcula fecha en la UI. OK.
- **CD-12**: `onConnect` hace `lockQuote` SIEMPRE antes de `startKyc` (`flow.tsx:186-189`), incluido el branch KYC-once. OK.

## Gates (confirmados por el orquestador — AR 0 BLQ/0 MENOR, CR 0 BLQ/0 MENOR, sin fix-pack)
- lint/tsc/vitest/build: re-ejecutados por QA en esta fase (no había `cr-report.md`/`ar-report.md` en disco para leer exit codes; el orquestador confirmó los veredictos de AR/CR en el prompt de esta tarea) → todos verdes, ver "Runtime gates" arriba.

**Listo para DONE.**
