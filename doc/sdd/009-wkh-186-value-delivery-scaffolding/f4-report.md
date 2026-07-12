# F4 Validation Report — WKH-186 (Chaski v2, value-delivery scaffolding, MONEY-PATH)

**Veredicto: APROBADO PARA DONE**
**Fecha**: 2026-07-11
**Branch**: `feat/186-value-delivery-scaffolding-a2a-eip3009-ready` (repo `chaski-v2`)
**Commits**: `eebc7a3` (docs) + `c1e08da` (W0+W1) + `d285788` (W2+W3+W4) + fix-pack de 4 MENOR (uncommitted, verificado por diff)

> Nota de proceso: no se encontraron `ar-report.md`/`cr-report.md` en disco en
> `doc/sdd/009-wkh-186-value-delivery-scaffolding/`. Se validó el fix-pack de 4 MENOR directamente
> por `git diff HEAD` (ver §3) en lugar de leerlo de un reporte escrito — cada uno de los 4 items
> tiene código + test correspondiente, consistente con lo declarado por el orquestador.

---

## 1. Runtime gates (ejecutados por QA, no re-uso de outputs previos por ausencia de cr-report.md)

| Gate | Comando | Resultado |
|------|---------|-----------|
| Typecheck | `npx tsc --noEmit` | ✅ exit 0, "TypeScript compilation completed" |
| Tests | `npx vitest run` | ✅ `Test Files 25 passed (25)` / `Tests 223 passed (223)` — coincide con el esperado |
| Build | `npm run build` (`next build --webpack`) | ✅ compiló OK; rutas `ƒ /api/a2a/quote` y `ƒ /api/a2a/payout/submit` marcadas **Dynamic (server-rendered)**, no estáticas — correcto para server-only I/O |

25 archivos `.test.*` en disco (incluye `src/presentation/flow.test.tsx`, el harness RTL de WKH-185) — los 25 corren y pasan, confirmando regresión intacta.

---

## 2. VERIFICACIÓN CRÍTICA CD-2 — cero dinero real por default

Confirmado por lectura directa de código, capa por capa, con NINGUNA de las 5 env vars nuevas seteada (verificado también que `.env.local` no las define — `grep` sin matches):

1. **`src/composition/container.ts:55,68-69`** — `adapter = process.env.NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` (unset) → `useA2a = adapter === "a2a"` → `false` → cablea `FallbackQuoteGateway`/`FallbackPayoutGateway` (L69/L73). El adapter `a2a` (que hace `fetch` real) NUNCA se instancia por default.
2. **`src/infrastructure/fallback/gateways.ts:95-116`** — `FallbackPayoutGateway.submit()` devuelve `{status:"submitted", deliveredPen:null, ...}`; `.status()` devuelve `{status:"settled", deliveredPen:null, ...}`. Comentario explícito L1-3/L96: "MOCK — no desembolsa". Byte-idéntico a pre-HU.
3. **`src/infrastructure/wallet.ts:22-24,69,92-98,184,206-211`** — `eip3009Enabled()` lee `NEXT_PUBLIC_EIP3009_ENABLED === "true"` (unset → `false`) → en ambos wallets reales (`InjectedWallet`/`WalletConnectWallet`) el `if (eip3009Enabled())` no entra → cae al path default `client.signMessage(...)` (firma simbólica, sin `transferWithAuthorization`). `FallbackWallet.authorizePrincipal` (L112-114) no se tocó, sigue devolviendo `0xdemo...`.
4. **`src/infrastructure/refund/ledger-refund-gateway.ts`** — `LedgerRefundGateway` (el ÚNICO `RefundGateway` cableado, `container.ts:75`, sin flag) es ledger-only por construcción: `creditBack()` no hace I/O ni movimiento on-chain, solo retorna `{refundTx: "refund-ledger-<ts>"}` sintético. Comentario L1-5 explícito: "NO revierte ningún movimiento on-chain real".
5. **`app/api/a2a/quote/route.ts:26-27`, `app/api/a2a/payout/submit/route.ts:31-32`** — `BASE = process.env.REMIT_AGENTS_BASE_URL` (server-only, unset por default) → `if (!BASE) return 501` — ni siquiera se intenta el `fetch` al agente remoto sin configuración explícita. Nunca hay un default de URL "de prod" hardcodeado.
6. **Guard fail-loud (`container.ts:59-67`)** — si alguien setea `EIP3009_ENABLED=true` sin las 3 condiciones (`adapter=a2a` + receiver válido + usdc válido), `createContainer()` **throws** y la app no arranca. Imposible un modo mixto (firma real + payout mock) silencioso. Verificado con 6 tests en `container.test.ts` (CD-3/CD-4/CD-16/AC-11 + 2 del fix-pack MNR-A).

**Conclusión CD-2**: con el estado actual del repo (todas las env vars nuevas unset, confirmado en `.env.local` también), NINGUNA capa mueve dinero real. Ningún default peligroso encontrado. **CD-2 PASS.**

---

## 3. Verificación de los 4 fixes del fix-pack (MNR-A/B/C/D) — confirmados por diff + test

| Fix | Archivo:línea | Verificado |
|-----|---------------|------------|
| **MNR-A** | `src/infrastructure/chain.ts:35-39` (`resolveReceiverAddress()`, `isAddress` fail-loud) + `container.ts:66` (guard llama la función) + `wallet.ts:73,187` (ambos wallets usan la función en vez de `as \`0x${string}\`` crudo) | ✅ Un receiver malformado (`0xNOT_A_VALID_ADDRESS` o checksum inválido) → `throw "payout_receiver_not_configured"` en `createContainer()`, NO en sign-time. 2 tests nuevos en `container.test.ts` (líneas "MNR-A") verdes. |
| **MNR-B** | `src/infrastructure/a2a/gateways.ts:137-153` (`status()` cache-miss) | ✅ Antes devolvía `status:"failed"` en cache-miss (recarga → Map vacío → false-refund). Ahora devuelve `status:"submitted"` (no-terminal) + `failureReason:"payout_status_unknown"` → `TrackRemittance` NO transiciona a `payout_failed`, la remesa queda recuperable. Test `gateways.test.ts` "MNR-B" + test `track-remittance.test.ts:119-130` confirman `out.status === "payout_submitted"`, `refund.calls.length === 0`. |
| **MNR-C** | `app/api/a2a/payout/submit/route.ts:23-26` (`isValidPayoutResult`) | ✅ Alineado con `isValidPayoutShape` del gateway (`gateways.ts:66`): `payoutId===null` solo válido en `failed`/`blocked`. 3 tests nuevos en `route.test.ts` (settled/submitted sin payoutId → 502; failed sin payoutId → 200). |
| **MNR-D** | `src/application/use-cases/track-remittance.ts:39-57` (try/catch alrededor de la reconciliación) | ✅ Simétrico con `ConfirmAndSend` (que ya tenía try/catch en su rama submit). Si `isDeliveredWithinReceiveTolerance` lanza (`reconcile_currency_mismatch`), se degrada a `failAndRefund` en vez de dejar escapar el rechazo crudo. Test `track-remittance.test.ts:132-146` (moneda divergente USDC vs PEN) → `out.status === "refunded"`, `failureReason === "reconcile_currency_mismatch"`. |

**Los 4 fixes están implementados con evidencia código + test. 0 pendientes.**

---

## 4. Los 14 ACs — con evidencia archivo:línea

| AC | Texto (resumen) | Status | Evidencia |
|----|------------------|--------|-----------|
| AC-1 | Default/`fallback` → Fallback gateways, byte-idéntico | ✅ PASS | `container.ts:55,68-69,73`; test `container.test.ts:8-10` "AC-1"; regresión: 223/223 verdes |
| AC-2 | `"a2a"` → `A2aQuoteGateway`/`A2aPayoutGateway` cableados | ✅ PASS | `container.ts:68-69`; test `container.test.ts:12-15` "AC-2" |
| AC-3 | `requestQuote()` → POST `/api/a2a/quote` → mapea `{result}`→`Quote` | ✅ PASS | `gateways.ts:93-108`; `app/api/a2a/quote/route.ts`; test `gateways.test.ts:35-51` "AC-3" |
| AC-4 | `submit()` → POST `/api/a2a/payout/submit`, `idempotencyKey` intacto, `kycVerificationId` propagado | ✅ PASS | `gateways.ts:116-135`; test `gateways.test.ts:73-87` "AC-4" (asserts `sent.idempotencyKey`/`kycPayoutAllowed`/`kycVerificationId`) |
| AC-5 | !200/shape inválido → error PII-free explícito, nunca silencioso | ✅ PASS | `gateways.ts:104,106,129,131`; routes L41/43-45 (quote), L41/43-45 (payout); tests `gateways.test.ts:57-70,109-124` (assert `msg` no contiene "Mamá"/"999888777") |
| AC-6 | `deliveredPen` no-nulo → reconciliar PRE-`markSettled` con MISMA tolerancia; mismatch → `payout_failed(payout_amount_mismatch)` | ✅ PASS | `remittance.ts:113-119` (`isDeliveredWithinReceiveTolerance`, reusa `RECEIVE_TOL_ABS_PEN`/`REL`); `confirm-and-send.ts:112-119`; `track-remittance.ts:39-51`; tests `confirm-and-send.test.ts:190-224`, `track-remittance.test.ts:50-91` (dentro/borde/fuera de tolerancia) |
| AC-7 | CUALQUIER `payout_failed` → `creditBack()` + `markRefunded()` en el MISMO `execute()` | ✅ PASS | `failAndRefund()` en `confirm-and-send.ts:32-46` (6 call-sites: L70,79,96,117,122,126) + `track-remittance.ts:16-30` (2 call-sites: L49,59); tests de refund en ambos `.test.ts` + `use-cases.test.ts:123` (`payout_failed`→`refunded`) |
| AC-8 | `LedgerRefundGateway` ledger-only, DEFAULT en container, gap de clawback documentado | ✅ PASS | `ledger-refund-gateway.ts:1-17` (comentario explícito); `container.ts:75` (default, sin flag); test `ledger-refund-gateway.test.ts` |
| AC-9 | Flag off/unset → `signMessage` byte-idéntico | ✅ PASS | `wallet.ts:22-24,92-98,206-211`; tests `wallet.test.ts` "flag OFF (default)" (Injected + WalletConnect), assert `signTypedData` NO llamado |
| AC-10 | Flag on → `signTypedData` real de `transferWithAuthorization` a `PAYOUT_RECEIVER_ADDRESS` | ✅ PASS | `wallet.ts:69-91,184-205`; tests `wallet.test.ts` "flag ON" (domain/types/`to`=receiver/`value`=`quote.send.minor`) en ambos wallets |
| AC-11 | EIP-3009 on + (adapter≠a2a ∨ sin receiver/usdc) → throw fail-loud en `createContainer()` | ✅ PASS | `container.ts:59-67`; 6 tests en `container.test.ts` (CD-3/CD-4/CD-16/AC-11 + 2 MNR-A) |
| AC-12 | `.env.example` documenta las 4(+1) vars con default mock/off | ✅ PASS | `.env.example:51-71`, cada var con comentario de default y efecto; incluye la 5ª (`NEXT_PUBLIC_USDC_CONTRACT_ADDRESS`, DT-10/CD-16) como exige la nota del story-file §7 |
| AC-13 | Cobertura de tests para adapters/refund/refund-on-failure/guard | ✅ PASS | Meta-AC — cubierto por AC-3 a AC-11 arriba; `gateways.test.ts`, `ledger-refund-gateway.test.ts`, `confirm-and-send.test.ts`, `track-remittance.test.ts`, `wallet.test.ts`, `container.test.ts` |
| AC-14 | `status()` del adapter a2a devuelve el `PayoutRecord` cacheado del `submit()` | ✅ PASS | `gateways.ts:137-153` (cache `Map`, con la corrección MNR-B en cache-miss: `submitted` en vez de `failed`); tests `gateways.test.ts:126-133` ("AC-14") + "MNR-B" |

**14/14 ACs PASS.**

---

## 5. Regresión

- `npx vitest run` → 223/223 verdes, incluye `src/presentation/flow.test.tsx` (harness RTL de WKH-185) y `src/application/use-cases.test.ts` (ripple CD-11 actualizado: `use-cases.test.ts:52-53` ctors con `refund`, `L123` assertion `payout_failed`→`refunded`, verificado por lectura).
- `confirm-and-send.test.ts` — assertions previas de WKH-180/182 (`authority false → payout_failed`, ahora en `refunded`; "submit/authorizePrincipal NOT called") preservadas junto con `failureReason` (confirmado: `markRefunded()` en `remittance.ts:240-241` solo patchea `refundTx`, nunca toca `failureReason`).
- Demo default (`FallbackQuoteGateway`/`FallbackPayoutGateway`/`FallbackWallet`) sin modificar (`fallback/gateways.ts` diff = 0 líneas tocadas por esta HU; `wallet.ts` `FallbackWallet` intacto L102-115).
- `test-container.ts` — override `refund?` default `FakeRefundGateway` (regresión-neutral), el harness RTL sigue construyendo el container 100% fallback.

---

## 6. Drift Detection

- **Scope**: `git diff --name-only main...HEAD` → 27 archivos, TODOS dentro de `chaski-v2/` (código+tests+docs). Cero archivos fuera de Scope IN del story-file (incluye el ripple `use-cases.test.ts` esperado por CD-11, y `doc/sdd/_INDEX.md` como doc de tracking estándar). **CD-1 PASS.**
- **Wave order**: commits `c1e08da` (W0+W1) → `d285788` (W2+W3+W4), consistente con el orden declarado en story-file §6. El fix-pack (uncommitted) toca únicamente `gateways.ts`/`chain.ts`/`wallet.ts`/`container.ts`/`track-remittance.ts`/`route.ts` + sus tests — bloques ya tocados por W1-W3, sin abrir archivos nuevos fuera de scope.
- **Spec drift**: spot-check de 3 funciones clave (`isDeliveredWithinReceiveTolerance`, `A2aPayoutGateway.status()`, guard de `createContainer()`) — firmas y comportamiento coinciden exactamente con §4.3/§4.4/§4.7 del story-file (con las 4 mejoras del fix-pack encima, documentadas).
- **Test drift**: todos los tests declarados en el test-plan (§9) existen y corresponden 1:1 a sus ACs (ver tabla §4).

**Drift: none (fuera de lo esperado por Scope IN + fix-pack documentado).**

---

## 7. Constraint Directives — checklist

| CD | Status | Evidencia |
|----|--------|-----------|
| CD-1 | ✅ | Diff 100% dentro de `chaski-v2/` (§6) |
| CD-2 (CRÍTICA) | ✅ | §2 completo, 6 capas verificadas |
| CD-3/CD-4/CD-16 | ✅ | `container.ts:59-67`, tests en `container.test.ts` |
| CD-5 | ✅ | Ningún `beneficiary.name`/`destination` interpolado en throws/logs; verificado en `gateways.ts`, ambas routes, tests explícitos que aseveran ausencia de PII en mensajes de error |
| CD-6 | ✅ | `isDeliveredWithinReceiveTolerance` reusa `RECEIVE_TOL_ABS_PEN`/`RECEIVE_TOL_REL`, sin constante nueva (`remittance.ts:105-107,113-119`) |
| CD-7 | ✅ | 5 sitios conceptuales (6 call-sites) en `ConfirmAndSend` + 2 en `TrackRemittance`, todos vía `failAndRefund()` |
| CD-8 | ✅ | Comentario explícito en `ledger-refund-gateway.ts:1-5` |
| CD-9 | ✅ | `REMIT_AGENTS_BASE_URL` sin `NEXT_PUBLIC_`, leído solo en las routes server-side; las routes devuelven solo `{result}`/`{error}`, nunca `BASE` |
| CD-10 | ✅ | `idempotencyKey` forwardeado tal cual en `gateways.ts:126` y las routes (`JSON.stringify(body)` sin tocar el campo); test `gateways.test.ts:83` asserta el valor exacto |
| CD-11 | ✅ | `use-cases.test.ts` ripple actualizado (verificado L52-53/L123) |
| CD-12 | ✅ | `?? null`/optional-chaining consistente en accesos de shape (`v.status`, `v.payoutId`, etc.) en type-guards |
| CD-13 | ✅ | `RefundGateway`/`PayoutRecord`/`PayoutSubmit`/`PayoutGateway` — nombres exactos verificados en `ports.ts:88-89` |
| CD-14 | ✅ | `isAddress`/`toHex`/`signTypedData`/`createWalletClient` de `viem`, sin reconstrucción manual |
| CD-15 | ✅ | Sin `any` explícito en el código nuevo; type-guards (`isRecord`, `isValidQuoteShape`, `isValidPayoutShape`) |
| CD-17 | ✅ | Assertions `payout_failed`→`refunded` actualizadas + `failureReason` preservado (confirmado en `markRefunded`, §5) |

**17/17 CDs cumplidas.**

---

## 8. Veredicto

**APROBADO PARA DONE.**

Money-path garantía verificada en 6 capas independientes (adapter default, fallback gateways, wallet
default, refund ledger-only, routes server-only sin BASE por default, guard fail-loud) — con las 5
env vars nuevas efectivamente unset tanto en código como en `.env.local` del entorno de validación.
Los 4 fixes del fix-pack (MNR-A/B/C/D) cierran gaps reales de money-path (cast crudo de address,
false-refund por cache-miss, validador de shape divergente, rejection cruda no fail-safe) y están
respaldados por tests nuevos. 14/14 ACs PASS con evidencia archivo:línea, 17/17 CDs cumplidas, 0
drift, gates en verde (tsc 0 / vitest 223/223 / build OK).
