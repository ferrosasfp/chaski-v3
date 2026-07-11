# CR — Code Review — WKH-183

**Veredicto**: APPROVED — 0 BLOQUEANTES, 0 MENORES

**Fecha**: 2026-07-11  
**Branch**: `fix/183-higiene-pending-store-money-fx-copy-env` @ `3c37ed5`

## Resumen ejecutivo

11 archivos de código + docs, 100% aditivos para tests (sin regresión de cobertura existente). Calidad de implementación consistente con el patrón del repo: try/catch normalizado con error tipado (`kyc_pending_unavailable`), `noUncheckedIndexedAccess` respetado en tests nuevos, imports verificados contra `ports.ts`, comentarios explícitos en dominios/infra delicados. Sin anti-patterns ni deuda introducida.

## Hallazgos

**BLOQUEANTES**: 0  
**MENORES**: 0

## Revisión clave por archivo

| Archivo | Hallazgo |
|---------|----------|
| `kyc-pending-store.ts` (AC-1) | try/catch normalizado: `throw new Error("kyc_pending_unavailable")` — no swallow silencioso de `DOMException`. Error tipado, reutilizable en humanError. ✅ |
| `start-kyc.ts` (AC-2/3/4) | Reorder (`pending.save()` L62 ANTES de `repo.save()` L68) — líneas verificadas, orden correcto. Cierra el brick sin rollback/compensación. ✅ |
| `flow-vm.ts` (AC-5/6 + DT-2) | **Mover** `humanError` desde flow.tsx, exportar, agregar ramas wallet. CD-5 ordering verificado: `kyc_pending_unavailable` **antes** de `code.includes("kyc")`. Copy específico para 3 códigos wallet nuevos. ✅ |
| `flow.tsx` (AC-5/6) | Borrar `humanError` local, importar desde `./flow-vm`. Línea 17 (`import {...humanError...}`); line 144 (`guard()` → `setError(humanError(...))`) idéntica. ✅ |
| `fallback/gateways.ts` (AC-7/AC-8) | Comentario explícito adyacente a `FallbackKycGateway.simulated()` (L66-68): "SIEMPRE aprueba... NUNCA representa un rechazo". L53: `Money.of(netUsd * rate, "PEN")` — doble redondeo eliminado, único redondeo = `Money.of()`. ✅ |
| `money.ts` (AC-9) | Cap `Number.MAX_SAFE_INTEGER`: `if (minor > Number.MAX_SAFE_INTEGER) throw new Error(...)`. Error tipado idéntico al patrón existente. ✅ |
| `fakes.ts` (DT-7) | Nuevo doble `ThrowingKycPendingStore` — implementa `KycPendingStore`, `save()` lanza, `get()`/`clear()` in-memory. NO muta `FakeKycPendingStore` (CD-6). ✅ |
| Tests (`use-cases.test.ts`, `flow-vm.test.ts`, `money.test.ts`) | 100% aditivos (0 líneas borradas). `use-cases.test:158-167` (redirect→resume) intacto y verde. Test estrella (AC-2) verifica `repo.get(id).status === "created"` tras fallo. ✅ |
| `.env.example` | AC-10: `NEXT_PUBLIC_REOWN_PROJECT_ID=` agregado (no-op si 182 ya lo incluyó). AC-11: `NEXT_PUBLIC_KYC_MODE` anotado **deprecated/no-op**, NO borrado (DT-5). ✅ |

## Verificaciones de estándar

- **TypeScript strict**: `tsc --noEmit` exit 0, 0 errores.
- **noUncheckedIndexedAccess**: tests nuevos evitan index-access crudo sin guards (CD-7). ✅
- **Imports verificados**: símbolos (`KycPending`, `KycPendingStore`) importados de `../application/ports` (verificado con Read). ✅
- **Sin hallazgos de seguridad**: ownership guard en `kyc-pending-store.ts` N/A (no toca `a2a_agent_keys`). ✅
- **Diff acotado en compartidos (CD-9)**: hunks de `gateways.ts` y `.env.example` restringidos a las líneas de V1-V6, 0 cambios ajenos. ✅

## No-regresión

- **Happy path KYC** (flujo fallback, creación): `use-cases.test.ts:57-70` intacto, verde.
- **Redirect exitoso**: `use-cases.test.ts:158-167` (Didit redirect → ResumeKyc aplica passed) intacto, verde.
- **FX demo**: mismo monto observable a 2 decimales (`Money.of` único redondeo, casos reales ≤ $1M).
- **Fallback aprobación**: `use-cases.test.ts:184-206` (AC-12 fallback identity) intacto, verde.

**CR FINAL: APPROVED. Code quality consistente, 0 anti-patterns, 0 regresiones introducidas. Listo para QA/F4.**
