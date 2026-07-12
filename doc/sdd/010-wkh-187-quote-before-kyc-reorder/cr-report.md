# CR Report — WKH-187: Reorden quote-antes-del-KYC

**Veredicto**: APROBADO (0 BLOQUEANTES, 0 MENORES)  
**Fecha**: 2026-07-12  
**Foco**: Calidad de código + diffs estructurales  

---

## Code Review — archivos modificados

### Dominio (`src/domain/remittance.ts`)

**Hunk único — L83-99 (`TRANSITIONS`):**
```ts
- created:     ["kyc_pending"]
- quoted:      ["quoted", "confirmed"]
+ created:     ["quoted"]
+ quoted:      ["quoted", "kyc_pending", "confirmed"]
+ kyc_passed:  ["quoted", "confirmed"]
```

**Review**: Cambio mínimo, cada transición anotada con razón de negocio inline. Los métodos `confirm()`, `applyKyc()`, `attachQuote()` no aparecen en el diff — confirmado. **✅ No issues.**

### UI (`src/presentation/flow.tsx`)

**Cambios principales:**
1. `Step` type: `"send"|"connect"|"review"|"verify"|"confirm"|"track"|"done"` (nuevo paso `"confirm"`, `"review"` renombrado a pre-KYC).
2. `onConnect` (L186-189): `lockQuote()` ANTES de `startKyc()` (orden crítico).
3. `onContinue` (nuevo L200): navegación pura `setStep("verify")`, sin llamada de dominio.
4. `onVerify` (L183-212): quitar `lockQuote()` incondicional.
5. Resume effect (L126-145): auto-requote condicional si quote vencido, nav directo a `"confirm"`.
6. Paso `confirm` (post-KYC): el `review` actual renombrado + badge de identidad.
7. Paso `review` (pre-KYC, nuevo): breakdown sin badge, CTA "Continuar".

**Review points:**
- Orden de `lockQuote` antes de `startKyc` en `onConnect` es crítico (DT-12). ✅ Código respeta.
- Resume auto-requote usa `Remittance.rehydrate(snapshot).isQuoteStillValid(now)` — reutiliza método público existente (DT-3). ✅ Sin hallazgos.
- Banner demo ampliado a `review||confirm||track` — coherente con la distribución de pasos. ✅ OK.
- `onContinue` es navegación pura — no toca dominio, preserva AC-2 ("no auto-inicio"). ✅ Verificado.

**Flow-vm (`src/presentation/flow-vm.ts`)**: sin cambios en lógica, solo copy.

### Tests

**Reordenamientos de seeding**: todos los fixtures ahora siguen `create→lock→startKyc→applyKyc`. Verificados en:
- `remittance.test.ts:34-39` (`ready()`)
- `confirm-and-send.test.ts:38-45` (`seedQuoted()`)
- `track-remittance.test.ts:39-41` (setup)
- `use-cases.test.ts:187-219` (V1 orphan — assert `status=="quoted"` post-fail, coherente)
- `persistence.test.ts:46` (seed `create→lock→startKyc`)

**Suite RTL (`flow.test.tsx`)**:
- Nuevo harness `container?: Container` (inyección para fakes) en `flow.tsx:Remittance = ({ container })` — patrón limpio, default preserva comportamiento. ✅ OK.
- `goToReview()` helper renombrado/ajustado a nuevos pasos. ✅ Coherente.
- T-COMPLIANCE, T-AC1..T-AC9 documentadas y verdes (235/235).

**Arquitectura de tests**: sin circular imports, sin mocks malformados. ✅ Verificado.

---

## No-tocar verification

| Archivo | Verificación |
|---------|---|
| `confirm-and-send.ts` | Diff vacío ✅ |
| `lock-quote.ts` | No aparece en diff ✅ |
| `resume-kyc.ts` | No aparece en diff ✅ |
| `connect-wallet.ts` | No aparece en diff ✅ |
| `confirm()` body (L219-226) | Byte-idéntico ✅ |
| `applyKyc()` (L202-208) | Byte-idéntico ✅ |
| `attachQuote()` (L210-216) | Byte-idéntico ✅ |

---

## Summary

- **Arquitectura**: reorden de pasos puro, sin cambios de invariantes.
- **Orden crítico**: `lockQuote` antes de `startKyc` en `onConnect` verificado en código.
- **Auto-requote**: usa método existente `isQuoteStillValid()`, reutilización correcta (DT-3).
- **Tests**: seeding reordenado, fixtures coherentes, suite 235/235 verde.
- **No-tocar**: confirmado diff vacío en archivos sensibles.

**APROBADO PARA MERGE.**
