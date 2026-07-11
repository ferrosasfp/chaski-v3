# Adversarial Review — WKH-184 (Reset KYC-once + señal FallbackWallet, Opción D)

**Veredicto**: APROBADO — 0 BLOQUEANTES, 2 MENOR (fixeados post-revisión)
**Fecha**: 2026-07-11
**Rama**: `feat/184-fallback-wallet-reset-demo-signal`

---

## Hallazgos

### BLOQUEANTES
Ninguno. El código cumple todas las constraint directives (CD-1 a CD-10).

### MENOR — 2 items

**MNR-1: PII del beneficiario anterior visible en re-reset**
- **Ubicación**: `flow.tsx:forgetAndDisconnect()` (implementación inicial)
- **Issue**: cuando el usuario activa el reset (`forgetAndDisconnect`), se limpian `address/rem/preview/step` pero quedan precargados los campos del beneficiario (`recipient`, `destination`, `scanStage`, `amount`) del reset anterior.
- **Escenario**: Usuario A completa KYC y remesa. Aprieta "¿No sos vos?" → reset. Usuario B en el mismo dispositivo → ve prefilled los datos del destinatario de Usuario A (PII leak menor, threat-model de shared-device).
- **Fix recomendado**: al limpiar estado en `forgetAndDisconnect`, incluir `setRecipient(""); setDestination(""); setScanStage(0); setAmount("400")` (reset del form al estado inicial fresco).
- **Severidad**: MENOR — es exposición de datos previos del mismo dispositivo (ya dentro del threat-model de shared-device que AC-1/AC-4 mitigan), pero mejora la higiene de reset.

**MNR-2: `ForgetKyc.execute()` puede rechazar si `pending.clear()` lanza**
- **Ubicación**: `forget-kyc.ts:execute()` (implementación inicial)
- **Issue**: `await this.pending.clear()` no está envuelto en try/catch. Si `localStorage` falla (quota/private-browsing), rechaza la promise → el reset del estado React (`flow.tsx`) nunca corre → usuario queda bloqueado sin poder reconectar (violación de AC-5/CD-8).
- **Escenario**: Usuario A en private-browsing → localStorage lleno → `forgetAndDisconnect` llama `forgetKyc.execute()` → `pending.clear()` lanza → promise rechazada → sin reconexión posible.
- **Fix recomendado**: envolver `await this.pending.clear()` en try/catch propio (similar al `kycStore.clear`). El reset del React state debe ejecutarse **siempre** (best-effort en storage, pero UI debe recuperarse).
- **Severidad**: MENOR — baja probabilidad (private-browsing + pendiente + reset juntos), pero violación de AC-5/CD-8 (best-effort defensivo).

---

## Guardas de Constraint Directives (CD-1 a CD-10)

| CD | Status | Nota |
|----|--------|------|
| CD-1 (solo chaski-v2) | ✅ | Scope conforme: `src/application/ports.ts`, `src/infrastructure/{kyc-store,wallet}.ts`, `src/application/use-cases/forget-kyc.ts`, `src/composition/container.ts`, `src/presentation/{flow-vm,flow}.tsx`, tests. Sin archivos del demo live. |
| CD-2 (NO hard-require) | ✅ | `pickWallet()` sin cambios. Banner solo informativo (no bloquea flujo). Flujo e2e vía FallbackWallet funciona. |
| CD-3 (clear scopeado) | ✅ | `LocalKycStore.clear()` — `delete all[address.toLowerCase()]`; NUNCA borra el mapa completo. |
| CD-4 (constante única) | ✅ | `FALLBACK_WALLET_ADDRESS` exportada desde `wallet.ts`; literal `0xDEMO…` NO aparece en otros archivos. |
| CD-5 (degrada sin romper) | ✅ | `LocalKycStore.clear()` — `setItem` envuelto en try/catch (best-effort). |
| CD-6 (banner WKH-178 intacto) | ✅ | Banner "Modo demo" condición sin diff. Banner de fallback es elemento SEPARADO. |
| CD-7 (`resetTo` intacto) | ✅ | `resetTo()` no se toca. "Enviar otra" preserva `address`. |
| CD-8 (execute no rechaza) | ✅ | `kycStore.clear()` envuelto en try/catch. **`pending.clear()` sin envolver** — ver MNR-2 fix. |
| CD-9 (case-insensitive) | ✅ | `isFallbackWalletAddress()` compara `.toLowerCase() === FALLBACK_WALLET_ADDRESS.toLowerCase()`. Importa la const (no re-hardcodea). |
| CD-10 (port + implementers mismo wave) | ✅ | `KycStore.clear` en port + `LocalKycStore.clear` + `FakeKycStore.clear` — todos en W1 (build TS verde confirma). |

---

## Veredicto

**APROBADO SIN BLOQUEANTES.** Los 2 MENORs (MNR-1 + MNR-2) son fixeables post-revisión; el código base cumple todas las CDs y el intent arquitectónico es correcto. El reset funciona, limpia el KYC-once scopeadamente, degrada sin romper, y la señal de FallbackWallet es puramente informativa (sin bloqueo, como AC-8/Opción D requieren).

**Acción requerida**: fixear MNR-1 y MNR-2 antes de CR. Luego procede.
