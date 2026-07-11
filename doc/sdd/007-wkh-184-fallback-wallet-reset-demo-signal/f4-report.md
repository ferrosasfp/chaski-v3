# F4 — Validation Report — WKH-184 (Reset KYC-once + señal FallbackWallet, Opción D)

**Veredicto**: **APROBADO PARA DONE** (condicionado a commitear el fix-pack — ver Hallazgo #1)
**Fecha**: 2026-07-11
**Repo/branch**: `chaski-v2` @ `feat/184-fallback-wallet-reset-demo-signal`

---

## ⚠️ Hallazgo #1 (drift de proceso, NO bloqueante para el código en sí)

El fix-pack de los 2 MENORs (MNR-1 y MNR-2) que CR/AR aprobaron **está en el working tree pero NO
commiteado**. El único commit de la rama es `a36e308` (implementación base). `git status` muestra:

```
 M src/application/use-cases/forget-kyc.test.ts
 M src/application/use-cases/forget-kyc.ts
 M src/presentation/flow.tsx
 M src/test-support/fakes.ts
 M tsconfig.tsbuildinfo
```

Confirmado con `git diff main...HEAD` (solo `a36e308`) vs `git diff` (working tree sin commitear):
el diff de `a36e308` **no incluye** `setRecipient("")`/`setDestination("")`/`setScanStage(0)`/
`setAmount("400")` en `forgetAndDisconnect` (MNR-1), ni el `try/catch` extra alrededor de
`pending.clear()` en `ForgetKyc.execute()` (MNR-2), ni `ThrowingClearKycPendingStore` en `fakes.ts`.
Todos los runtime checks de este reporte (tsc/vitest/build) corrieron **contra el working tree
actual** (con el fix-pack aplicado) — por eso pasan. Pero si `nexus-docs` hace `git push` sin
commitear primero, el fix-pack se pierde. **Acción requerida antes de DONE/push: commitear estos 5
archivos** (Dev o Docs, un solo commit tipo `fix(WKH-184): fix-pack MNR-1/MNR-2 post-CR`).

---

## Runtime gates (ejecutados por QA sobre el working tree)

| Gate | Comando | Resultado |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | ✅ exit 0 — "TypeScript compilation completed" |
| Tests | `npx vitest run` | ✅ `PASS (167) FAIL (0)` — coincide con el target del Done Definition del SDD (167) |
| Build | `npm run build` (`next build --webpack`) | ✅ "Compiled successfully" + TS + páginas OK, exit 0 |
| Grep CD-4/AC-9 | `grep -rn "0xDEMO" src/` | ✅ SOLO `src/infrastructure/wallet.ts:10` |

## Scope / drift (CD-1)

`git diff --name-only main...HEAD` (commit + working tree combinados) = exactamente los 12 archivos
del Scope IN del Story File §2, más `doc/sdd/007-.../*.md` + `doc/sdd/_INDEX.md` (docs) +
`tsconfig.tsbuildinfo` (build artifact, no código). **Cero archivos fuera de `chaski-v2/`. Cero
archivos del demo live (`yarvis`/`wasiai-v2`/`agentshop-*`) tocados.** Drift: **none** más allá del
Hallazgo #1 (proceso de commit, no de scope).

---

## ACs (9/9 evidencia)

| AC | Texto (resumen) | Status | Evidencia | Método |
|---|---|---|---|---|
| AC-1 | Reset limpia KYC-once → fuerza re-verify | ✅ PASS | `forget-kyc.test.ts:29-38` "olvida el KYC-once… (get → null)"; `start-kyc.ts:36-41` sin tocar (rama `remembered` NO se toma si `get()`→null) | test + code review |
| AC-2 | Clear scopeado, case-insensitive, no afecta otras addresses | ✅ PASS | `kyc-store.test.ts:147-166` (2 tests: scoped + case-insensitive); `kyc-store.ts:110-123` `delete all[address.toLowerCase()]` | test + code review |
| AC-3 | Reset limpia el pending | ✅ PASS | `forget-kyc.test.ts:40-49` "limpia el pending en curso" | test |
| AC-4 | Reset limpia estado React (address/rem/preview/step), sin reload | ✅ PASS | `flow.tsx:239-257` `forgetAndDisconnect`: `setAddress(null); setRem(null); setPreview(null); setStep("send")`; sin `window.location.reload` en el archivo (grep negativo) | code review (sin RTL, según SDD §6/8) |
| AC-5 | Degrada sin romper si storage falla | ✅ PASS | `kyc-store.test.ts:168-179` (`setItem` que lanza → `clear` resuelve); `forget-kyc.test.ts:51-70` (2 tests: `kycStore.clear` rechaza Y `pending.clear` rechaza → `execute()` resuelve igual) | test |
| AC-6 | Control de reset solo visible con `address !== null` | ✅ PASS | `flow.tsx:295-327`: todo el bloque del control (badge + "¿No sos vos?"/confirmación) vive dentro de `{address ? (...) : null}` | code review (sin RTL, según SDD §6/8) |
| AC-7 | Señal soft de FallbackWallet | ✅ PASS | `flow-vm.test.ts:66-82` (`isFallbackWalletAddress`: true/false/null/case-insensitive); banner `flow.tsx:333-339` condición `address && isFallbackWalletAddress(address)` | test + code review |
| AC-8 | Flujo completa e2e sin wallet real (NO hard-require) | ✅ PASS | `wallet.test.ts:100-112` (`FallbackWallet.connect()` retorna la const; `pickWallet()` sin injected/sin REOWN → `FallbackWallet`); `wallet.ts:154-163` `pickWallet()` sin diff de lógica (solo el literal→const) | test + code review |
| AC-9 | 0xDEMO fuente única | ✅ PASS | `grep -rn "0xDEMO" src/` → solo `wallet.ts:10`; `flow-vm.test.ts:71-73` uppercase-variant test; `flow-vm.ts:12-13` importa la const, no re-hardcodea | grep + test |

**9/9 PASS.**

---

## Fix-pack (MNR-1 y MNR-2) — verificación puntual

- **MNR-1** (PII de beneficiario anterior no debe quedar precargada tras reset): `flow.tsx:246-254`
  (working tree) — `forgetAndDisconnect` ahora también hace `setRecipient(""); setDestination("");
  setScanStage(0); setAmount("400")` además de `address/rem/preview/step`. Confirmado por code review
  directo del archivo. No hay test unitario nuevo para esto (es estado de UI, mismo criterio AC-4 =
  code review, consistente con el SDD). **Evidencia**: `src/presentation/flow.tsx:246-254`.
- **MNR-2** (`ForgetKyc.execute()` no debe rechazar si `pending.clear()` lanza, CD-8): `forget-kyc.ts:17-21`
  (working tree) envuelve `await this.pending.clear()` en su propio try/catch. Test nuevo:
  `forget-kyc.test.ts:63-70` "CD-8: si pending.clear rechaza… execute resuelve igual y NO rechaza" —
  usa el nuevo doble `ThrowingClearKycPendingStore` (`fakes.ts:172-183`). **PASS** (parte de los 167
  verdes). **Evidencia**: `src/application/use-cases/forget-kyc.ts:17-21` + `forget-kyc.test.ts:63-70`.

Ambos fixes verificados en el working tree — ver Hallazgo #1 sobre el estado de commit.

---

## Regresiones críticas

| Regresión a guardar | Status | Evidencia |
|---|---|---|
| `resetTo()`/"enviar otra" preserva `address` | ✅ intacto | `flow.tsx:695-703` sin diff — `git diff main...HEAD -- flow.tsx` no toca `resetTo`; sigue sin `setAddress`. `onRetryKyc` (`:231-235`) y `Receipt.onNew` (`:600`) siguen llamando `resetTo` sin address |
| Banner "Modo demo" (WKH-178) intacto | ✅ intacto | `flow.tsx:341-345` — condición `rem && isDemoMode(rem) && (step==="review"||step==="track")` sin diff en el commit (confirmado línea a línea contra el diff) |
| Aislamiento WKH-181 (wallet real) intacto | ✅ intacto | `InjectedWallet`/`WalletConnectWallet` (`wallet.ts:19-150`) sin diff funcional (solo el import/uso de la const en `FallbackWallet`, no en las reales); `get`/`save`/`clear` siguen lowercaseando |
| Flujo completa e2e sin wallet real (CD-2) | ✅ intacto | `pickWallet()` (`wallet.ts:158-163`) sin diff; `wallet.test.ts:107-112` confirma `FallbackWallet` sin gating nuevo |

---

## CDs (10)

| CD | Status | Nota |
|---|---|---|
| CD-1 (solo chaski-v2) | ✅ | scope diff verificado, sin archivos fuera de `chaski-v2/` ni del demo live |
| CD-2 (no hard-require) | ✅ | `pickWallet()` sin diff; banner solo informativo |
| CD-3 (clear scopeado) | ✅ | `kyc-store.ts:110-123` + tests AC-2 |
| CD-4 (constante única) | ✅ | grep confirma único literal |
| CD-5 (degrada sin romper) | ✅ | `kyc-store.test.ts:168-179` |
| CD-6 (banner WKH-178 sin cambios) | ✅ | condición idéntica, banner fallback separado |
| CD-7 (resetTo intacto) | ✅ | sin diff en `resetTo()` |
| CD-8 (execute no rechaza) | ✅ | ambos clears (`kycStore` y `pending`) envueltos en try/catch propio — reforzado por el fix-pack MNR-2 |
| CD-9 (case-insensitive, sin re-hardcode) | ✅ | `flow-vm.ts:12-13` + test uppercase |
| CD-10 (port + implementers misma wave) | ✅ | `ports.ts`, `kyc-store.ts` (`LocalKycStore`), `fakes.ts` (`FakeKycStore`, `ThrowingClearKycStore`) — build TS verde confirma que ningún `implements KycStore` quedó sin `clear` |

**10/10 CDs cumplidos.**

---

## Gates (confirmados por QA — CR no dejó reporte en disco para esta HU)

No existe `ar-report.md`/`cr-report.md` en `doc/sdd/007-.../` (no se escribieron a disco para esta
HU). QA re-ejecutó los 3 gates directamente (tsc/vitest/build, ver arriba) — todos verdes.

---

## Veredicto

**APROBADO PARA DONE**, con una acción de proceso pendiente antes del push: **commitear el fix-pack
no commiteado** (`forget-kyc.ts`, `forget-kyc.test.ts`, `flow.tsx`, `fakes.ts` — MNR-1 + MNR-2,
verificados arriba con evidencia y tests verdes). El código, tests y build son correctos; el único
gap es que vive sin commitear en el working tree.
