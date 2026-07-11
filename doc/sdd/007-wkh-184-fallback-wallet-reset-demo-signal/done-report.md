# Report — WKH-184 (Reset KYC-once + señal soft de FallbackWallet, Opción D)

**Veredicto final**: ✅ **DONE** (APROBADO PARA MERGE + DEPLOY)
**Fecha de cierre**: 2026-07-11
**Rama**: `feat/184-fallback-wallet-reset-demo-signal` (desde `main`)
**Commit base de implementación**: `a36e308` + fix-pack post-CR (working tree)

---

## Resumen ejecutivo

WKH-184 cierra formalmente el residual AC-8 diferido de WKH-181: implementa control manual de reset explícito del KYC-once (scopeado por address, best-effort en storage, sin reload) + banner soft de advertencia de `FallbackWallet` (puramente informativo, sin hard-require). El founder eligió **Opción D** (reset + señal, sin pseudo-address ni wallet real obligatoria). Todas las 9 ACs cumplen. Pipeline QUALITY completo (F0→F1→F2→F2.5→F3→AR→CR→F4) ejecutado. Auditoría Chaski v2 (WKH-178 a WKH-184) **100% cerrada, TODAS las HUs en DONE**.

---

## Pipeline ejecutado (F0 → DONE)

| Fase | Hito / Gate | Artefacto | Status | Fecha |
|------|------------|----------|--------|-------|
| **F0** | Grounding codebase | `work-item.md` § "Contexto verificado" | Completo | 2026-07-10 |
| **F1** | HU_APPROVED | `work-item.md` + 9 ACs (EARS) + 5 CDs + 4 DTs | ✅ APROBADO | 2026-07-10 |
| **F2** | SDD + constraint mapping | `sdd.md` (11 secciones, context map, decisiones, waves) | ✅ SPEC_APPROVED | 2026-07-10 |
| **F2.5** | Story File (contrato para Dev) | `story-file.md` (anti-hallucination checklist, 5 piezas, waves) | ✅ Contrato OK | 2026-07-10 |
| **F3 Wave 1** | `KycStore.clear` port + adapter | `ports.ts`, `kyc-store.ts`, `fakes.ts`, tests | ✅ Implementado (commit `a36e308`) | 2026-07-11 |
| **F3 Wave 2** | Use-case `ForgetKyc` + wiring | `forget-kyc.ts`, `container.ts`, tests | ✅ Implementado (commit `a36e308`) | 2026-07-11 |
| **F3 Wave 3** | `FALLBACK_WALLET_ADDRESS` + helper | `wallet.ts`, `flow-vm.ts`, tests | ✅ Implementado (commit `a36e308`) | 2026-07-11 |
| **F3 Wave 4** | UI: control reset + banner fallback | `flow.tsx` (2 piezas, 1 handler, 1 banner) | ✅ Implementado (commit `a36e308`) | 2026-07-11 |
| **AR** | Adversarial Review | `ar-report.md` | ✅ APROBADO (0 BLQ, 2 MNR) | 2026-07-11 |
| **CR (post-fix-pack)** | Code Review | `cr-report.md` | ✅ APROBADO (0 BLQ, 0 MNR after fixes) | 2026-07-11 |
| **F4** | QA + drift detection | `f4-report.md` | ✅ APROBADO PARA DONE (9/9 ACs, 10/10 CDs, tsc/vitest/build verde) | 2026-07-11 |
| **DONE** | Docs + cierre | Este report | ✅ COMPLETADO | 2026-07-11 |

---

## Qué se construyó (resumen funcional)

### 1. **Reset explícito del KYC-once** (core mitigation AC-1 a AC-6)

El usuario toca control "¿No sos vos?" (visible en header mientras hay wallet conectada) → máquina 2-estados:
- **Reposo**: botón "¿No sos vos?" (subtle text).
- **Confirmando**: tooltip inline "Esto borra tu verificación en este dispositivo." + botones "Empezar de nuevo" / "Cancelar".

Al confirmar:
1. `ForgetKyc.execute({ address })` limpia:
   - **KYC-once** de esa address exacta (scoped, case-insensitive, via `KycStore.clear(address)` en localStorage).
   - **Pending en curso** (global, via `KycPendingStore.clear()`) — evita leak de sesión stale en siguiente usuario.
2. Reset del estado React **sin reload**: `address = null`, `rem = null`, `preview = null`, `step = "send"`, formulario limpio (recipient/destination/scanStage/amount = "").
3. UI vuelve al step "send" inicial → exige reconexión (nuevo `connect`).

**Benefit**: en dispositivo compartido sin wallet real, cada usuario puede borrar la identidad del anterior y completar KYC propio sin colisión de "María Elena vieja".

### 2. **Señal soft de FallbackWallet** (mitigation AC-7 a AC-9)

Banner permanente ("Sin aislamiento por wallet en este dispositivo — conectá MetaMask o WalletConnect.") visible desde step `connect` en adelante mientras `FallbackWallet` esté activo (detected via `isFallbackWalletAddress(address)`).

**Benefit**: usuario vuelto visible que el dispositivo NO tiene aislamiento real, sugiere conectar wallet real. **Sin bloqueante** (AC-8/Opción D: flujo completa igual via FallbackWallet).

### 3. **Fonte única de la address demo** (CD-4/AC-9)

Literal `0xDEMO00000000000000000000000000000A11ce` extraído a `export const FALLBACK_WALLET_ADDRESS` en `wallet.ts`; consumible desde presentación (via `flow-vm.ts`). Único lugar del repo con el literal (grep confirma).

---

## Acceptance Criteria — Resultado final (9/9 PASS)

| AC | Descripción (EARS) | Status | Método de validación | Evidencia (archivo:línea) |
|----|--------------------|--------|----------------------|--------------------------|
| **AC-1** | Reset limpia KYC-once de la address, fuerza re-verify | ✅ PASS | Unit test | `forget-kyc.test.ts:29-38` (save + execute → get = null) |
| **AC-2** | Clear scoped exclusivamente a la address (case-insensitive) | ✅ PASS | Unit test | `kyc-store.test.ts:147-166` (2 tests: scoped + insensitive) + `kyc-store.ts:110-123` |
| **AC-3** | Reset limpia pending en curso | ✅ PASS | Unit test | `forget-kyc.test.ts:40-49` |
| **AC-4** | Reset limpia estado React (address/rem/preview/step/form), sin reload | ✅ PASS | Code review (SDD §8: sin RTL) | `flow.tsx:239-257` (forgetAndDisconnect, no window.location.reload) |
| **AC-5** | Degrada sin romper si `localStorage` falla | ✅ PASS | Unit test + coverage | `kyc-store.test.ts:168-179` (setItem que lanza) + `forget-kyc.test.ts:51-70` (both clears reject → execute resuelve) |
| **AC-6** | Control visible solo con `address !== null` | ✅ PASS | Code review (SDD §8: sin RTL) | `flow.tsx:295-327` (dentro de {address ? … : null}) |
| **AC-7** | Señal soft de FallbackWallet (banner informativo) | ✅ PASS | Unit test + code review | `flow-vm.test.ts:66-82` (helper true/false cases) + `flow.tsx:333-339` (banner conditional) |
| **AC-8** | Flujo completa e2e sin wallet real (NO hard-require) | ✅ PASS | Unit test + code review | `wallet.test.ts:100-112` (FallbackWallet funciona, pickWallet sin gating) |
| **AC-9** | Detección desde fuente única (no duplicar literal) | ✅ PASS | Unit test + grep | `flow-vm.test.ts:71-73` + grep: SOLO `wallet.ts:8` tiene `0xDEMO…` |

**Veredicto de ACs**: 9/9 PASS (100% cobertura).

---

## Hallazgos AR/CR (fin del pipeline de revisión)

### AR Veredicto: APROBADO (0 BLOQUEANTES, 2 MENOR)

| Hallazgo | Severidad | Estado |
|----------|-----------|--------|
| PII de beneficiario anterior no limpia en reset | MENOR (MNR-1) | ✅ FIXEADO (forgetAndDisconnect ahora limpia recipient/destination/scanStage/amount) |
| `pending.clear()` sin try/catch puede rechazar | MENOR (MNR-2) | ✅ FIXEADO (envuelto en try/catch propio en ForgetKyc.execute) |

### CR Veredicto: APROBADO (0 BLOQUEANTES post-fix-pack, 0 MENOR)

- MNR-1 + MNR-2 resueltos correctamente. Tests nuevos pasan (vitest 167/167).
- Scoping correcto, best-effort, no hard-require, regresiones guardadas (WKH-178/179/180/181/182/183 intactas).
- Build TS verde (CD-10: port + implementers en misma wave).

---

## Constraint Directives (10/10 cumplidas)

| CD | Contenido | Verificación |
|----|-----------|--------------|
| **CD-1** | SOLO `chaski-v2/`. Nada del demo live. | ✅ git diff scope exacto: 12 archivos src/ + docs + build artifact |
| **CD-2** | NO hard-require de wallet real. Flujo e2e via FallbackWallet. | ✅ `pickWallet()` sin gating nuevo, banner informativo |
| **CD-3** | `clear(address)` scoped, case-insensitive, NUNCA borra mapa completo | ✅ `kyc-store.ts:110-123`, tests AC-2 |
| **CD-4** | Literal `0xDEMO…` en UN SOLO archivo | ✅ grep confirma `wallet.ts:8` único |
| **CD-5** | `clear` degrada sin romper si storage falla | ✅ try/catch en `LocalKycStore.clear()` |
| **CD-6** | Banner WKH-178 sin cambios, fallback banner SEPARADO | ✅ condición idéntica, 2 banners distintos |
| **CD-7** | `resetTo()` intacto, "enviar otra" preserva address | ✅ sin diff en `resetTo()`, `onRetryKyc`/`Receipt.onNew` intactos |
| **CD-8** | `ForgetKyc.execute()` NO rechaza por storage | ✅ try/catch en ambas clauses (`kycStore.clear()` + `pending.clear()`) |
| **CD-9** | `isFallbackWalletAddress` case-insensitive, no re-hardcodea | ✅ `.toLowerCase()` en ambos lados, importa const |
| **CD-10** | Port + implementers en misma wave | ✅ `KycStore.clear` + `LocalKycStore.clear` + `FakeKycStore.clear` en W1; build TS verde |

**Veredicto de CDs**: 10/10 cumplidas (100%).

---

## F4 QA Gates (todos PASS)

| Gate | Comando | Resultado | Evidencia |
|------|---------|-----------|-----------|
| **Typecheck** | `tsc --noEmit` | ✅ exit 0 | Compilación TS sin errores |
| **Tests** | `npx vitest run` | ✅ 167 PASS / 0 FAIL | Matches SDD Done Definition target |
| **Build** | `npm run build` | ✅ "Compiled successfully" | next build sin warning |
| **CD-4 grep** | `grep -rn "0xDEMO" src/` | ✅ SOLO `wallet.ts:10` | Fuente única verificada |

**Veredicto de gates**: 4/4 PASS.

---

## Auto-Blindaje / Lecciones para próximas HUs

### (A) Patrones reutilizables extraídos en esta HU

1. **Best-effort en storage con try/catch dual** (CD-5/CD-8):
   - Ambas clauses de limpieza (`kycStore.clear()` Y `pending.clear()`) envueltas en try/catch propio.
   - UI state reset ejecutado SIEMPRE (el try/catch aísla fallos de storage).
   - Aplicable a cualquier HU que toque `localStorage` en flujos críticos.

2. **Scoping por address case-insensitive** (CD-3):
   - Pattern: `address.toLowerCase()` en AMBOS lados (storage key Y comparación).
   - Usado ya en WKH-181 (KycStore.get/save). WKH-184 extiende a `clear`.
   - Reutilizable en cualquier dominio multi-tenant por wallet.

3. **Máquina de estados 2-pasos en UI** (DT-3):
   - `useState<boolean>` para "reposo/confirmando".
   - Click directo sin modal pesado (mejora UX en móvil, reduce fricción en hackathon).
   - Usable para confirmaciones destructivas (logout, reset, delete).

4. **Detección de tipo de wallet via constante pura** (DT-2):
   - Exportar address como const (NO método de port).
   - Menor superficie de cambio (no toca interfaz de dominio).
   - Helper puro sin I/O (`isFallbackWalletAddress`) importa la const.
   - Patrón reusable si en futuro se agregan más tipos de wallet (ej. trazador simulado para testnet).

5. **Cleanup diferenciado: reset vs "enviar otra"** (DT-4):
   - `forgetAndDisconnect()` nueva y **separada** de `resetTo()` (evita flag proliferation).
   - `resetTo()` preserva `address` (reuso de wallet en "enviar otra").
   - `forgetAndDisconnect()` limpia `address` (fuerza reconexión).
   - Patrón: cuando dos comportamientos parecidos tienen semántica distinta, función separada > flags.

### (B) Gotchas y anti-patrones identificados

1. **NO confundir "storage fail gracefully" con "test coverage de UI"** (SDD §8):
   - AC-4/AC-6 (reset del estado React, visibilidad del control) se validan por code review (sin RTL/jsdom en el repo).
   - El try/catch asegura que el comportamiento degradado es correcto; la prueba de que el botón se renderiza es code review.
   - En próximas HUs con tests de presentación, considerar jsdom si el cambio es complejo.

2. **CD-10 trap: agregar métodos a interfaz sin actualizar TODOS los implementers**:
   - `KycStore.clear` agregado a puerto → DEBE estar en `LocalKycStore` Y `FakeKycStore` en la misma ola (W1).
   - Omitir uno = `tsc --noEmit` rompe (build-block).
   - Grep defensivo: `grep -n "implements KycStore" src/` antes de agregar métodos a port.

3. **Differenciar "best-effort" en try/catch vs "ignorar errores completamente"**:
   - AC-5/CD-5/CD-8 es "el try/catch aísla el fallo pero la UI se recupera".
   - NO es "silenciar errores y ocultar el problema al usuario".
   - Para debugging, considerar un logger silencioso (`console.debug`) dentro del catch (sin throw).

### (C) Decisiones de producto que quedaron claras

1. **Opción D es la ganadora**: reset manual + señal soft, sin pseudo-address ni hard-require.
   - Simplificó el scope respecto a las alternativas (sin criptografía, sin API nueva).
   - Jurado del hackathon puede probar sin wallet real.
   - Dispositivos compartidos tienen salida manual clara ("¿No sos vos?").

2. **La PII del beneficiario sigue siendo threat-model de shared-device**: es AC-1/AC-4 + MNR-1 (higiene de formulario).
   - El reset del KYC-once limpia la identidad del anterior usuario (core).
   - El reset del formulario limpia la direccion del anterior (higiene, MNR-1).
   - Aún así, un usuario malintencionado en el mismo dispositivo CON wallet inyectada puede ver el KYC del anterior (pero AC-6/AC-7 de WKH-181 mitiga eso — wallets reales aíslan).
   - Consenso: aceptable para hackathon (shared-device está documentado, no es privacidad absoluta).

---

## Auditoría Chaski v2 — Estado de cierre

Este es el **último cierre** de la auditoría coordinada 2026-07-10 en Chaski v2.

| HU | Título (cortado) | Status | Path report |
|----|-----------------|--------|-------------|
| WKH-178 | P0 demo-safe (recibo + timeout/reset) | DONE 2026-07-10 | `001-wkh-178-demo-safe-fixes/done-report.md` |
| WKH-179 | P0 seguridad (IDOR PII + auth) | DONE 2026-07-10 | `002-wkh-179-kyc-idor-auth-ratelimit/done-report.md` |
| WKH-180 | P1 seguridad (autoridad payout server-side) | DONE 2026-07-11 | `003-wkh-180-payout-authority-server-side/done-report.md` |
| WKH-181 | P1 (PII persistence + historial por wallet) | DONE 2026-07-11 | `004-wkh-181-pii-persistence-history-per-wallet/done-report.md` |
| WKH-182 | P2 money-path robustez | DONE 2026-07-11 | `005-wkh-182-money-path-robustez/done-report.md` |
| WKH-183 | P3 higiene menores | DONE 2026-07-11 | `006-wkh-183-higiene-menores/done-report.md` |
| **WKH-184** | **Residual AC-8: reset + señal FallbackWallet** | **DONE 2026-07-11** | **`007-wkh-184-fallback-wallet-reset-demo-signal/done-report.md`** |

**Auditoría 100% cerrada**: todas las 7 HUs en estado DONE. WKH-181 AC-8 (residual diferido) **formalmente resuelta** por WKH-184. No quedan hallazgos bloqueantes ni diferidos en el backlog de Chaski v2.

---

## Archivos modificados (git diff summary)

**Total: 12 archivos src/ + docs + build artifact**

### Dominio (1 archivo)
- `src/application/ports.ts` — `KycStore` interfaz (nuevo método `clear`)

### Aplicación (1 archivo)
- `src/application/use-cases/forget-kyc.ts` — **NUEVO** use-case `ForgetKyc` (orquesta clears + best-effort)

### Infraestructura (4 archivos)
- `src/infrastructure/kyc-store.ts` — `LocalKycStore.clear()` (scoped, best-effort)
- `src/infrastructure/wallet.ts` — `FALLBACK_WALLET_ADDRESS` constante exportada (fuente única)
- `src/test-support/fakes.ts` — `FakeKycStore.clear` + `ThrowingClearKycPendingStore` (dobles de test)
- `src/infrastructure/kyc-store.test.ts` — tests AC-2 (scoped) + AC-5 (storage fail)

### Composición (1 archivo)
- `src/composition/container.ts` — wiring de `forgetKyc` (interfaz + retorno)

### Presentación (3 archivos)
- `src/presentation/flow-vm.ts` — `isFallbackWalletAddress()` helper (case-insensitive, importa const)
- `src/presentation/flow.tsx` — control reset (2-estados) + `forgetAndDisconnect()` + banner fallback
- `src/presentation/flow-vm.test.ts` — tests AC-7/AC-9 del helper

### Testing (2 archivos)
- `src/application/use-cases/forget-kyc.test.ts` — **NUEVO** tests AC-1/AC-3/AC-5 (ForgetKyc + best-effort)
- `src/infrastructure/wallet.test.ts` — tests AC-8/AC-9 (FallbackWallet + pickWallet)

### Documentación (7 archivos)
- `doc/sdd/007-wkh-184-fallback-wallet-reset-demo-signal/work-item.md`
- `doc/sdd/007-wkh-184-fallback-wallet-reset-demo-signal/sdd.md`
- `doc/sdd/007-wkh-184-fallback-wallet-reset-demo-signal/story-file.md`
- `doc/sdd/007-wkh-184-fallback-wallet-reset-demo-signal/ar-report.md`
- `doc/sdd/007-wkh-184-fallback-wallet-reset-demo-signal/cr-report.md`
- `doc/sdd/007-wkh-184-fallback-wallet-reset-demo-signal/f4-report.md`
- `doc/sdd/007-wkh-184-fallback-wallet-reset-demo-signal/done-report.md` (este archivo)

### Build artifact (1 archivo, no código)
- `tsconfig.tsbuildinfo` — timestamp, sin impacto

---

## Acción requerida pre-MERGE

### Commit pendiente (NO CÓDIGO, solo proceso)

El fix-pack post-CR (MNR-1 + MNR-2) está aplicado en el working tree pero **sin commitear**. Archivos:
- `src/application/use-cases/forget-kyc.ts` — MNR-2 (try/catch en pending.clear())
- `src/application/use-cases/forget-kyc.test.ts` — test nuevo para MNR-2
- `src/presentation/flow.tsx` — MNR-1 (limpieza de PII en form)
- `src/test-support/fakes.ts` — doble `ThrowingClearKycPendingStore`
- `tsconfig.tsbuildinfo` — artifact (auto-generado)

**Acción requerida antes de push a origin/main:**
1. Leer el working tree (esto ya está hecho por QA en F4).
2. `git add` solo los archivos src/ + docs (omitir `tsconfig.tsbuildinfo`).
3. `git commit -m "fix(WKH-184): fix-pack MNR-1 + MNR-2 post-CR"` (o similar, alineado con el git log del repo).
4. `git push origin feat/184-fallback-wallet-reset-demo-signal`.
5. Abrir PR (o mergear a `main` si el proceso es directo en este proyecto).

**Nota**: Docs (`nexus-docs`) NO commitea código. El orquestador o `nexus-dev` encargado de la rama debe hacerlo.

---

## Veredicto Final

✅ **WKH-184 = DONE (MERGE-READY)**

- Pipeline QUALITY: F0 → F1 → F2 → F2.5 → F3 → AR → CR → F4 completado.
- 9/9 ACs PASS, 10/10 CDs cumplidas.
- 0 BLOQUEANTES, 0 MENOR post-fix-pack.
- Auditoría Chaski v2 (7 HUs, 2026-07-10/11) 100% cerrada.
- AC-8 residual de WKH-181 formalmente resuelto.
- Fix-pack aplicado, verificado, listo para commit.
- Próximo paso: **commit + push + merge a main** (acción del orquestador/dev).

---

## Checksums de validación

| Verbo | Resultado |
|------|-----------|
| `tsc --noEmit` | ✅ exit 0 |
| `vitest run` | ✅ 167 PASS |
| `npm run build` | ✅ "Compiled successfully" |
| `git diff --stat main...HEAD` | ✅ 12 files src/ + docs + build artifact (scope exacto) |
| `grep -rn "0xDEMO" src/` | ✅ SOLO wallet.ts:8 (CD-4) |

---

**Este reporte cierra formalmente WKH-184 en estado DONE. El artefacto está listo para merge a `main`.**
