# F4 — Validation Report — WKH-182 Money-path robustez (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-11
**Repo/branch**: `chaski-v2/` @ `fix/182-money-path-robustez` (uncommitted working tree, sin AR/CR report en disco — verificado contra fuente vía Read/Bash)

## Runtime gates (ejecutados por QA, no re-ejecutados de CR porque no había cr-report.md en disco)
- `npx tsc --noEmit` → **0 errores** (exit 0)
- `npx vitest run` → **147 PASS / 0 FAIL** (exit 0) — matchea el esperado (147)
- `npx next build --webpack` → **compiló OK** (Next.js 16.2.10, TS pasado, 6 páginas generadas, exit 0) — CR no lo había corrido, lo corrí yo

## ACs (9/9 PASS)
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `src/domain/remittance.ts:113-119` (`assertReceiveConsistent`, pura, sin I/O) + `src/domain/remittance.test.ts:109-114` "AC-1: receive consistente... → status quoted" |
| AC-2 | PASS | `remittance.ts:201-204` (llamada tras `quote_expired`, antes de `to("quoted")`) + `remittance.test.ts:116-144` (inflado 2×, degradado ½, boundary dentro/afuera: delta 14.75 pasa / 14.85 falla) |
| AC-3 | PASS | `src/infrastructure/persistence.ts:94-107` (CAS en `LocalRepo.save`) + `src/infrastructure/persistence.test.ts` (carrera: `race-1`, dos `get()` version 1, `save(r1)`→v2, `save(r2)` rechazado; + secuencial `seq-1` sin falso conflicto) |
| AC-4 | PASS | `persistence.ts:100-102` (`throw ConcurrentModificationError`, fail-loud, `map` no se toca antes del throw) + test: `save(r2)` rechaza con `ConcurrentModificationError`, persistido = versión del ganador (v2); + legacy sin `version` → normaliza a 0 sin crash |
| AC-5 | PASS | `src/application/use-cases/confirm-and-send.ts:51-59` (re-check tras autoridad WKH-180, antes de firma) + `confirm-and-send.test.ts:122-141` `ScriptedClock([T0, 18:11])` → `payout_failed`/`quote_expired_before_submit`, `authorizeSpy` y `submitSpy` NO llamados |
| AC-6 | PASS | `confirm-and-send.ts:85` (`expectedReceivePen: quote.receive` en `submit()`, `amountUsd` preservado L84) + `confirm-and-send.test.ts:166-182` `submitSpy` recibe `expectedReceivePen === Money.of(1480,"PEN")` y `amountUsd===400` |
| AC-7 | PASS | `src/infrastructure/chain.ts:9-18` (`resolveChainId`/`resolveChain`, única fuente, fail-safe a 43114) + `src/infrastructure/chain.test.ts` (unset→43114, "43113"→fuji, "43114"→mainnet, "99"/"abc"→43114) — 5 casos verdes |
| AC-8 | PASS | `wallet.ts:26-33` (InjectedWallet) + `wallet.ts:114-126` (WalletConnectWallet): chainId mismatch → `switchChain`/`wallet_switchEthereumChain`, rechazo → `throw wrong_chain` + `src/infrastructure/wallet.test.ts:94-118,148-171` (ambos adapters: coincide/switch/rechazo) |
| AC-9 | PASS | `wallet.ts:24,45,113,138` (`isAddress` guard antes de `signMessage` en ambos adapters, en `connect()` y `authorizePrincipal()`) + `wallet.test.ts:132-141,185-194` (address malformada → `invalid_address`, `personal_sign`/`eth_sign` NO llamado) |

## Fix-pack (2 MENORes, verificados)
- **MNR-A (2º expiry check pre-submit)**: PASS. `confirm-and-send.ts:67-77` — el 2º check corre DESPUÉS de `authorizePrincipal`/`markPrincipalIn` (firma ya ocurrida) y ANTES del bloque `submit()`. Test `confirm-and-send.test.ts:143-164`: `ScriptedClock([T0,T0,T0,18:11])` → `authorizeSpy` llamado 1 vez (firma SÍ ocurrió), `submitSpy` NO llamado, `principalTx==="0xprincipal"` (queda en `principal_in→payout_failed`, camino de refund). Orden de guards CD-2 (CAS→autoridad→expiry→firma→**expiry**→submit) respetado literalmente en el código.
- **MNR-B (tests de `WalletConnectWallet`)**: PASS. `src/infrastructure/wallet.test.ts:12-15` mockea el lazy-import `@walletconnect/ethereum-provider`; 4 tests nuevos cubren chainId-ok/switch/rechazo (`:148-171`) + address malformada (`:185-194`) sobre `WalletConnectWallet`, antes sin cobertura.

## Regresión crítica
- WKH-180 (autoridad server-side): paso intacto en `confirm-and-send.ts:40-49`, `PayoutAuthorityGateway`/`app/api/payout/validate` sin diff (`git diff main` vacío). 4 tests WKH-180 preexistentes de `confirm-and-send.test.ts` siguen verdes (dentro de los 147).
- WKH-181 (PII/list por-wallet): `kyc-store.ts`/`toPersistedIdentity`/`list()` sin diff. `normalizeState` (`persistence.ts:45-51`) solo agrega default `version:0`, no toca la reducción de identity.
- Ripple del CAS: `src/application/use-cases.test.ts` y `src/presentation/flow-vm.test.ts` **sin diff** (`git diff main` vacío) y siguen pasando dentro del run de 147 — confirma en runtime que los otros 5 use-cases heredan CAS transparente sin edición, tal como predice SDD §3.2.
- Demo (chain 43114, mock): `resolveChainId()` default 43114 confirmado por `chain.test.ts` caso "unset". `fallback/gateways.ts` sin diff (`git diff main` vacío) → mock ignora `expectedReceivePen` estructuralmente, camino a `settled` intacto.

## Drift
- **Ninguno.** `git diff --name-only main` (código, excluyendo `doc/`) = exactamente los 11 archivos modificados + `tsconfig.tsbuildinfo` (artefacto de build) que matchean 1:1 la tabla "Files to Modify/Create" del Story File, más 4 archivos NEW (`errors.ts`, `chain.ts`, `chain.test.ts`, `wallet.test.ts`) también listados. Cero archivos fuera de tabla. `fallback/gateways.ts`, `container.ts`, `kyc-store.ts`, `flow.tsx`, `app/api/payout/validate` — sin diff, confirmado.

## CDs
- CD-1: 100% dentro de `chaski-v2/` — OK (repo root = chaski-v2, `git diff --name-only main` sin rutas externas).
- CD-2: orden CAS→autoridad→expiry→firma→expiry→submit — verificado literal en `confirm-and-send.ts:29-99`.
- CD-3: `assertReceiveConsistent` pura, sin `Date.now()`/red — verificado (`remittance.ts:113-119`).
- CD-4: fail-loud confirmado (`ConcurrentModificationError` propagado, test AC-3/AC-4 verifica que el ganador no es pisado).
- CD-5: única fuente `resolveChainId()`/`resolveChain()` para ambos adapters — verificado, sin hardcode residual (`wallet.ts` sin import directo de `avalanche`/`43114` fuera de `chain.ts`).

## Gates (confirmados por QA — sin cr-report.md en disco, se ejecutaron directamente)
- typecheck: PASS (0 errores) · tests: PASS (147/147) · build: PASS (Next.js compiló + TS + páginas generadas)
- lint: NO ejecutado (no crítico para money-path; recomendar a Docs/orquestador correr `npm run lint` antes de push si no se corrió en CR)

## Nota de proceso
No se encontró `cr-report.md` ni `ar-report.md` en `doc/sdd/005-wkh-182-money-path-robustez/` — el estado de "AR+CR APROBARON 0 BLOQUEANTES, 2 MENORes fixeados" viene del brief del orquestador, no de un artefacto en disco. QA verificó el fix-pack directamente contra el código y los tests (evidencia arriba), no como confirmación ciega del reporte. Recomendar a `nexus-docs` dejar constancia de este gap en el done-report (o pedir al orquestador que el CR deje su reporte en disco en HUs futuras).

**Listo para DONE.**
