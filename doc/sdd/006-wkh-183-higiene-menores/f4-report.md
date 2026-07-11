# F4 — Validation Report — WKH-183 (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-11
**Repo**: chaski-v2, branch `fix/183-higiene-pending-store-money-fx-copy-env` @ `3c37ed5`

## Runtime gates (ejecutados por QA)
- `npx tsc --noEmit` → exit 0, "TypeScript compilation completed"
- `npx vitest run` → `PASS (154) FAIL (0)`, exit 0
- `npm run build` (`next build --webpack`) → "Compiled successfully", TS check limpio, 6 páginas generadas, exit 0

## ACs (11/11 PASS)

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `src/infrastructure/kyc-pending-store.ts:8-14,25-31` — `save()`/`clear()` con try/catch, re-lanza `new Error("kyc_pending_unavailable")` (no crudo); `get()` intacto (16-24) |
| AC-2 ⭐ | PASS | `src/application/use-cases/start-kyc.ts:62-69` — orden invertido (`pending.save` L62 antes de `repo.save` L68); test estrella `use-cases.test.ts:176-188` → `repo.get(id).status === "created"` tras rechazo |
| AC-3 | PASS | Mismo test (`use-cases.test.ts:183-185`) — `rejects.toThrow`, nunca llega a `{kind:"redirect"}`; `flow.tsx` navegación (L193-197, sin diff) sigue gated por `await execute()` exitoso |
| AC-4 | PASS | `use-cases.test.ts:190-` (retry con store sano avanza sin `invalid_transition`) + no-regresión: diff de `use-cases.test.ts` es 100% aditivo (0 líneas borradas) → test `:158-167` (redirect→resume) intacto y verde |
| AC-5 | PASS | `flow-vm.ts:21-22` (`no_wallet` → copy específico); test `flow-vm.test.ts:66-68` |
| AC-6 | PASS | `flow-vm.ts:23-24` (`no_account`/`wallet_not_connected` → "Reconectá"); test `flow-vm.test.ts:71-73` |
| AC-7 | PASS | `gateways.ts:66-68` — comentario explícito "SIEMPRE aprueba... NUNCA representa un rechazo" + referencia al gate WKH-180; runtime sin cambio (`simulated()` L75-92 idéntico) |
| AC-8 | PASS | `gateways.ts:53` — `Money.of(netUsd * rate, "PEN")`, un solo redondeo (comentario "sin doble round (V4)") |
| AC-9 | PASS | `money.ts:22-24` — cap `> Number.MAX_SAFE_INTEGER` con `invalid_money_amount`; test `money.test.ts:25-29` (`1e12` throws, `1_000_000` no throws) |
| AC-10 | PASS (no-op, documentado) | `.env.example:49` `NEXT_PUBLIC_REOWN_PROJECT_ID=` ya presente (agregado por WKH-182); confirmado leído en `wallet.ts:156`; auto-blindaje.md documenta el no-op, no hay duplicación |
| AC-11 | PASS | `.env.example` diff (L16-18) anota `NEXT_PUBLIC_KYC_MODE` como `[DEPRECATED — no-op desde WKH-180]`, variable no borrada; confirmado `grep -r "KYC_MODE" src/` → 0 matches (no se lee en ningún lado) |

## V1 (bug real) — verificación directa del fix
Test estrella `src/application/use-cases.test.ts:176-188`: con `ThrowingKycPendingStore` forzando fallo en `pending.save()`, `startKyc.execute()` rechaza con `/kyc_pending_unavailable/` y `repo.get(id).snapshot.status === "created"` (no `"kyc_pending"` huérfano). PASS confirmado en corrida real (`npx vitest run` → 154/154 verde, incluye este test). Código fuente (`start-kyc.ts:62-68`) consistente con el diagnóstico del Story File: `pending.save()` corre antes que `repo.save(r)`, así que si el primero lanza, el segundo nunca ejecuta y la mutación in-memory (`r.startKyc()` L33) se descarta.

## Regresión crítica
- `git diff main --name-only` → 11 archivos de código + `.env.example`, exactamente el Scope IN del Story File (§2). Ningún archivo de `app/api/**` (WKH-179/180) tocado.
- `git diff main -- src/domain/remittance.ts` → vacío. **CD-3 confirmado**: `RemittanceStatus`/`TRANSITIONS` intactos.
- `git diff main -- src/test-support/fakes.ts` → 100% aditivo (solo agrega `ThrowingKycPendingStore`), `FakeKycPendingStore` sin tocar.
- `git diff main -- src/application/use-cases.test.ts` → 0 líneas borradas (aditivo puro); no-regresión de tests existentes confirmada por inspección + corrida verde.
- `StartKyc` ctor (`start-kyc.ts:15-21`) sin cambio de firma (5 params, mismo orden) — **CD-6 OK**. `setup()` en el test agrega opt `pending?: KycPendingStore` sin tocar el ctor real.
- FX (`gateways.ts:53`) da el mismo monto en el caso común (un solo redondeo vía `Money.of`, no cambia el resultado numérico salvo edge cases de doble-round) — **CD-2 OK**.
- `flow.tsx:17` importa `humanError` desde `./flow-vm`; `grep -n "function humanError" flow.tsx` → 0 matches (definición local borrada, sin duplicado). Build (`next build`) compila limpio, confirma que el import resuelve.

## Drift
- Ninguno. Archivos tocados = Scope IN exacto del Story File §2. Los 11 ACs mapean 1:1 a cambios verificados en código + test. `auto-blindaje.md` documenta correctamente el no-op de AC-10 (ya cubierto por WKH-182) — coincide con lo observado en `.env.example`.

## CDs
- CD-1: `git diff main --name-only` sin rastro de `yarvis`/`wasiai-v2`/`agentshop-*` — OK
- CD-2: sin cambio de runtime observable (KYC fallback sigue aprobando siempre, FX mismo monto) — OK
- CD-3: `remittance.ts` sin diff — OK
- CD-4: cap en `money.ts:22` es `Number.MAX_SAFE_INTEGER` (técnico) — OK
- CD-5: `flow-vm.ts:19` (`kyc_pending_unavailable`) chequeado ANTES de `code.includes("kyc")` (L25) — OK, test explícito `flow-vm.test.ts:76-80`
- CD-6: firmas de `StartKyc`, `Money.of`, `KycPendingStore`, `FakeKycPendingStore` sin cambio — OK
- CD-9: diff acotado en `gateways.ts` (solo L53 + comentario V3) y `.env.example` (solo bloque `NEXT_PUBLIC_KYC_MODE`, AC-10 correctamente no-op) — OK

## AR/CR follow-up
- AR: APROBADO 0 BLQ/0 MENOR. CR: APPROVED 0 BLQ/0 MENOR. Sin fix-pack necesario (confirmado por el orquestador, sin hallazgos que resolver).

## Gates
- typecheck/tests/build: PASS (ejecutados directamente por QA arriba — no había cr-report.md en el dir para confirmar exit codes de CR, por lo que se corrieron los 3 gates de punta a punta como evidencia primaria)

**Listo para DONE.**
