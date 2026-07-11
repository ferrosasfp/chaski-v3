# Code Review — WKH-184 (Reset KYC-once + señal FallbackWallet, Opción D)

**Veredicto**: APROBADO — 0 BLOQUEANTES, 0 MENOR (los 2 MENORs de AR fueron fixeados)
**Fecha**: 2026-07-11
**Rama**: `feat/184-fallback-wallet-reset-demo-signal`
**Commit base para review**: `a36e308` + fix-pack post-AR (working tree)

---

## Resumen de la revisión

### Fix-pack post-AR — Ambos MENORs resueltos

**MNR-1 (PII de beneficiario anterior no limpia en reset)** — RESUELTO
- **Ubicación**: `src/presentation/flow.tsx:239-257` (handler `forgetAndDisconnect`)
- **Fix**: ahora incluye `setRecipient(""); setDestination(""); setScanStage(0); setAmount("400")` además de `address/rem/preview/step`.
- **Evidencia**: líneas 246-254 en working tree.
- **Veredicto**: ✅ SATISFACE AC-1/AC-4 (reset limpia TODO el estado, incluyendo form precargado).

**MNR-2 (`pending.clear()` sin try/catch puede rechazar)** — RESUELTO
- **Ubicación**: `src/application/use-cases/forget-kyc.ts:14-21` (método `execute()`)
- **Fix**: `await this.pending.clear()` ahora envuelto en su propio try/catch (similar a `kycStore.clear`).
- **Evidencia**: líneas 17-21 en working tree. Test nuevo en `forget-kyc.test.ts:63-70` valida que `execute()` resuelve incluso si `pending.clear()` rechaza (usa doble `ThrowingClearKycPendingStore`).
- **Veredicto**: ✅ SATISFACE AC-5/CD-8 (best-effort sin rechazar, even si storage falla).

---

## Calidad de código — Scoping y patrones

| Aspecto | Status | Evidencia |
|--------|--------|-----------|
| **Scoping de `clear(address)`** | ✅ | `kyc-store.ts:110-123` — `delete all[address.toLowerCase()]` + case-insensitive. Nunca borra mapa completo. Tests AC-2. |
| **Best-effort en storage** | ✅ | Ambos `kycStore.clear()` y `pending.clear()` envueltos en try/catch. Sin exception no capturada que impida UI. |
| **Constante única (CD-4)** | ✅ | `wallet.ts:8` exporta `FALLBACK_WALLET_ADDRESS`; `flow-vm.ts:12` importa (no re-hardcodea). Grep: literal `0xDEMO…` solo en `wallet.ts:8`. |
| **Helper puro sin side-effects** | ✅ | `flow-vm.ts:10-13` — `isFallbackWalletAddress()` es función pura; importa const, compara case-insensitive, sin I/O. |
| **Control de UI con gating** | ✅ | `flow.tsx:295-327` — control dentro de `{address ? … : null}` del header; no se renderiza sin address (AC-6). State local `confirmReset` maneja 2 estados (reposo/confirmando). |
| **Banner de fallback no-bloqueante** | ✅ | `flow.tsx:333-339` — `Pill tone="warn"` condicionado a `address && isFallbackWalletAddress(address)`. Solo informativo (CD-2/AC-8). |
| **Regresión: `resetTo()` intacto** | ✅ | `flow.tsx:695-703` sin diff en commit. `onRetryKyc`/`Receipt.onNew` siguen usando `resetTo` → "enviar otra" preserva `address` (CD-7). |
| **Regresión: banner WKH-178 intacto** | ✅ | `flow.tsx:341-345` — "Modo demo" condición idéntica: `rem && isDemoMode(rem) && (step==="review"\|\|step==="track")`. Banner fallback es elemento separado. |
| **Wiring en container** | ✅ | `container.ts:38,65` — `forgetKyc: ForgetKyc` agregado a interfaz y retorno (sigue patrón de `abandonPendingKyc`). `kycStore`/`kycPending` ya inyectadas. |
| **Tests de acuerdo al SDD §8** | ✅ | `kyc-store.test.ts` (AC-2/5), `forget-kyc.test.ts` (AC-1/3/5), `flow-vm.test.ts` (AC-7/9), `wallet.test.ts` (AC-8/9). AC-4/6/7-render por code review (sin RTL). **167 tests PASS** (vitest run). |

---

## TypeScript / Build

| Check | Resultado |
|-------|-----------|
| `tsc --noEmit` | ✅ exit 0 — sin errores de tipo. `KycStore.clear` implementado en `LocalKycStore` + `FakeKycStore` (CD-10). |
| `npm run build` | ✅ "Compiled successfully". Next.js build sin warning sobre imports nuevos (FALLBACK_WALLET_ADDRESS es valor puro, sin deps adicionales). |
| Bundle size | ✅ Sin impacto esperado — una constante string + un helper puro + un use-case pequeño. |

---

## Security / Ownership (WKH-53/54 compliance)

| Item | Status | Nota |
|------|--------|------|
| `KycStore.clear(address)` scoped | ✅ | SOLO limpia la key de la address recibida. NO bypassa ownership por address (patrón lowercasing case-insensitive idéntico a `get`/`save`). |
| `ForgetKyc` no expone queries no-scopeadas | ✅ | Use-case recibe `address` como input, lo pasa a `kycStore.clear(address)`. Sin queries de mapa completo. |
| Ningún nuevo endpoint API expuesto | ✅ | `forgetKyc` es un use-case interno, wireado en `container`; no hay nueva ruta HTTP en esta HU. |

---

## Regresiones / Guardas

| Regresión potencial | Status | Evidencia |
|---------------------|--------|-----------|
| "Enviar otra" preserva wallet | ✅ intacta | `resetTo()` sin diff — `Receipt.onNew` (`:600`) sigue preservando `address`. AC-8 del story ("enviar otra con la misma wallet") funciona. |
| KYC-once sigue reutilizable en wallets reales | ✅ intacta | `start-kyc.ts` sin diff. `InjectedWallet`/`WalletConnectWallet` sin cambios. Aislamiento WKH-181 (lowercasing) intacto. |
| Flujo completa sin wallet real | ✅ intacta | `pickWallet()` sin diff (AC-8/CD-2). Ningún hard-require nuevo en la ruta de FallbackWallet. |
| Tests de WKH-178/179/180/181/182/183 no rompidos | ✅ | `npm run build` verde (la mayoría de tests de esas HUs están integrados). No hay regresión detectada en el pipeline. |

---

## Veredicto

**APROBADO SIN BLOQUEANTES NI MENORES.** Ambos MENORs de AR fueron resueltos correctamente:
- MNR-1: formulario limpio en reset (PII beneficiario anterior + campos del monto precargado).
- MNR-2: `pending.clear()` envuelto en try/catch (best-effort sin rechazar).

El código es de calidad, cumple todas las CDs, no regresiona WKH-178-183, y está listo para QA/F4.

**Próximo paso**: F4 (QA validation + drift detection de ACs).
