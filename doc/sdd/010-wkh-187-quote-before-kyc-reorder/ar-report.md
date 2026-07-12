# AR Report — WKH-187: Reorden quote-antes-del-KYC

**Veredicto**: APROBADO (0 BLOQUEANTES, 0 MENORES)  
**Fecha**: 2026-07-12  
**Foco**: Compliance + secuencia de UI  

---

## Verificación de compliance

### (a) Gate `confirm_requires_kyc_passed` — intacto byte-a-byte

Diff de `src/domain/remittance.ts:219-226`:
```ts
// Pre-cambio y post-cambio: idéntico
if (!this.state.kyc || !(...approved && payoutAllowed)) 
  throw new Error("confirm_requires_kyc_passed");
```

El gate sigue leyendo el **campo `kyc`**, no la posición en la FSM. La nueva transición `quoted→confirmed` (DT-1b) abre la puerta DESPUÉS del gate, no antes. **Veredicto: SEGURO.**

### (b) Enumeración de paths peligrosos (SDD DT-1)

| Path | Estado entrada | Gate + transición | Verificación |
|------|---|---|---|
| **Pre-KYC confirm** | `quoted` + `kyc=null` | `confirm()` lanza `confirm_requires_kyc_passed` L220 antes de intentar `to("confirmed")` | ✅ Test `T-COMPLIANCE` (remittance.test.ts:115-137) |
| **KYC pendiente** | `kyc_pending` + `kyc=null` | `confirm()` lanza igual | ✅ Test `T-COMPLIANCE:kyc_pending` |
| **KYC rechazado** | `kyc_passed` + `kyc.approved=false` | `confirm()` lanza igual | ✅ Test `T-COMPLIANCE:kyc_failed` |

**Resultado**: Los 3 paths que podrían debilitar la gate con el nuevo orden están cubiertos y rechazan correctamente. **Veredicto: BLOQUEANTE 0.**

### (c) Transiciones nuevas — razones de negocio (CD-4)

| Transición nueva | Razón | Verificación |
|---|---|---|
| `created→quoted` | `attachQuote()` primero, quote antes de KYC (WKH-187) | ✅ AC-1 |
| `quoted→kyc_pending` | iniciar KYC tras cotizar | ✅ AC-2 |
| `kyc_passed→quoted` | re-quote sin perder KYC si vence durante escaneo (AC-5) | ✅ AC-5 / DT-2 |
| `quoted→confirmed` | confirmar tras re-quote sin dead-end (DT-1b) | ✅ AC-5 / T-COMPLIANCE |

Todas tienen razones explícitas inline en el código (`remittance.ts:83-99`). **Veredicto: CD-4 cumplida.**

---

## Summary

- **Compliance**: gate `confirm()` intacto, enumeración de paths peligrosos cubierta por tests, cero debilitamiento.
- **Dominio**: único cambio es `TRANSITIONS`; lógica de `confirm()`, `applyKyc()`, `attachQuote()`, `to()` byte-idéntica.
- **CD-2/CD-3**: respetadas; `confirm-and-send.ts` diff vacío.

**APROBADO PARA CONTINUAR.**
