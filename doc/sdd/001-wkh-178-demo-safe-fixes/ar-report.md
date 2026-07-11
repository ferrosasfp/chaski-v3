# AR Report — WKH-178 (Chaski v2 demo-safe fixes)

**Veredicto**: APROBADO (0 BLOQUEANTES + 1 MENOR)  
**Fecha**: 2026-07-10  
**Reviewer**: nexus-adversary  
**Branch**: Working tree (cambios sin commitear al momento de AR)

---

## Resumen ejecutivo

WKH-178 implementó 3 fixes demo-safe (recibo `S/0.00`, banner "Modo demo", KYC timeout) en 4 waves seriales sobre `chaski-v2/`. Toda la implementación es **presentación + dominio de dominio mínimo (1 firma ampliada)**. La arquitectura es limpia: scaffolding (W0) → uso-cases y componentes (W1–W3) con **cero violaciones de dependencies**, CDs respetadas, tests de lógica pura automatizados. **APROBADO**.

---

## Hallazgos: 1 MENOR

### MENOR-A · Mensaje de timeout duplicado en el render

**Ubicación**: `src/presentation/flow.tsx:126-131` (branch de timeout del efecto resume)  
**Problema**: Inicialmente el wave-plan del SDD indicaba `setError("...")` en el timeout, pero eso causaba que el mensaje se renderizara TAMBIÉN en el Card `timedOut` (`:300-306`), produciendo redundancia visual.  
**Fix**: El Dev sacó el `setError` — el mensaje vive solo en la Card `timedOut`. **Confirmado** en `:130` comentario explícito `// La card de timedOut ya comunica el mensaje; no seteamos error para no duplicarlo (MENOR-A)`.  
**Estado**: RESUELTO en el fix-pack.

---

## Checks de seguridad / invariantes

| Check | Resultado |
|-------|-----------|
| **CD-1**: NO tocar demo live (yarvis, agentshop-*) | OK — `git diff --name-only` = solo archivos bajo `chaski-v2/src` |
| **CD-2**: NO tocar `src/app/api/**` ni DiditKycGateway | OK — ni FakeGateways tocados (CD-4 respetada) |
| **CD-3**: "Modo demo" derivado de `provenance`, sin flags | OK — `isDemoMode()` lee solo `quote?.provenance` / `kyc?.provenance` |
| **CD-4**: FallbackPayoutGateway/KycGateway intactas | OK — lectura de `gateways.ts` confirma identidad "María Elena" y `deliveredPen:null` sin cambios |
| **CD-5**: Único cambio de dominio = ampliar `markSettled` sig. | OK — `remittance.ts:176` cambio de `Money` a `Money \| null`; TRANSITIONS intacto |
| **CD-6**: Presentación NO importa `KycPendingStore` | OK — `grep LocalKycPendingStore flow.tsx` = 0; clear via `c.abandonPendingKyc.execute()` |
| **Ownership**: cleancode, sin inyección de dependencias rotas | OK — patrón `Container` uniforme, 10 use-cases ahora (todos con `.execute()`) |

---

## Contrato de implementación (anti-hallucination)

### ✓ AC-1: `deliveredPen:null` pasthrough
- **Firma**: `markSettled(..., deliveredPen: Money | null, ...)` — ampliada correctamente.
- **Uso**: `track-remittance.ts:20` y `confirm-and-send.ts:52` SIN `?? Money.zero`.
- **Test**: "payout settled con deliveredPen null → preserva null" PASS.

### ✓ AC-2/AC-3: Recibo fallback + placeholder
- **Helper puro**: `deliveredDisplay(rem: RemittanceState): Money | null` (`flow-vm.ts:10`).
- **Render**: `flow.tsx:604,612` usa el helper y fallback `"—"` cuando null.
- **Tests**: AC-2 ("null → usa quote.receive") PASS; AC-3 ("ambos null → null") PASS.

### ✓ AC-4/AC-5/AC-6: "Modo demo"
- **Detector puro**: `isDemoMode(rem)` → `quote?.provenance === "local-fallback" || kyc?.provenance === "local-fallback"`.
- **Ubicación**: Banner top (`flow.tsx:283-287`, steps `review`/`track`); Pill en Receipt (`:614-618`, step `done`).
- **Sin duplicación**: Verificado en fix-pack (banner NO incluye `done`, Receipt es único en `done`).
- **Tests**: AC-4 ("local-fallback → true") PASS; AC-6 ("didit → false") PASS.

### ✓ AC-7/AC-8/AC-9: KYC timeout + reset
- **Clear**: `flow.tsx:128` → `await c.abandonPendingKyc.execute()` (limpia el pending).
- **Botón**: Card `timedOut` (`flow.tsx:299-308`) con `<Button onClick={onRetryKyc}>Reintentar</Button>`.
- **Handler**: `onRetryKyc` (`flow.tsx:230-234`) resetea a `send` SIN reload.
- **No re-bloqueo**: `resumedRef` evita re-disparo del efecto resume.
- **Test**: AC-7 "limpia pending (próximo resume no re-bloquea)" PASS.

---

## Scope (drift check)

**Modificados**: `track-remittance.ts`, `confirm-and-send.ts`, `remittance.ts`, `container.ts`, `flow.tsx`, `ui.tsx`, `use-cases.test.ts`  
**Nuevos**: `abandon-pending-kyc.ts`, `abandon-pending-kyc.test.ts`, `flow-vm.ts`, `flow-vm.test.ts`

**Exactamente** el Scope IN de la Story File. Cero archivos fuerita.

---

## Gates técnicos

- **`tsc --noEmit`**: 0 errores (imports de `Money` limpios tras cambios en W1).
- **Regresión**: `remittance.test.ts` (callers de `markSettled` con `Money`) sigue PASS — ampliación backward-compatible.
- **Tests nuevos**: `flow-vm.test.ts` (AC-2..6, helpers puros) 6 PASS; `abandon-pending-kyc.test.ts` (AC-7) 1 PASS.

---

## Conclusión

**APROBADO PARA CR.** El único hallazgo MENOR fue la redundancia de mensaje en timeout (resoluble cambio trivial de render); el Dev lo fixeó en el fix-pack. Arquitectura limpia, CDs respetadas, zero dependencies violations. Listo para Code Review.
