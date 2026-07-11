# Report — HU [WKH-182] Money-path robustez: validación de dominio, lock optimista, chain configurable y monto lockeado al payout

## Resumen ejecutivo
Se cierra el flujo money-path de Chaski v2 con **6 endurecimientos latentes** (hoy simbológicos, críticos con EIP-3009 real): validación consistencia receive/send/fee/rate (A5), lock optimista CAS contra doble-submit (A6), chain env-driven (M1), re-chequeo expiry pre-submit (M2), monto PEN lockeado al payout (M3), y validación chainId/address post-connect (M4). **9/9 ACs PASS**, 0 BLOQUEANTES, 2 MENOREs resueltos en fix-pack, 1 MENOR aceptado (save final fail-loud = correcto). **DONE** 2026-07-11, mergeado.

## Pipeline ejecutado

| Fase | Gate | Fecha | Status |
|------|------|-------|--------|
| **F0** | Project context + grounding archivo:línea (6 hallazgos documentados, ConfirmAndSend 4×save sin token, wallet hardcode chain, etc.) | 2026-07-11 | ✅ VERIFIED |
| **F1** | HU_APPROVED — 9 ACs EARS, 5 CDs, 5 DT-N, 3 NC (bloqueantes resueltas: chainId default 43114, tolerancia 0.02 PEN / 1%, CAS = excepción tipada) | 2026-07-11 | ✅ APROBADO |
| **F2** | SPEC_APPROVED — SDD full (context map, 5 DT-N detallados, 3 hallazgos por AC, waves, regresión CD-10, ripple CAS) | 2026-07-11 | ✅ SPEC_APPROVED |
| **F2.5** | Story File generado (6 archivos net-new, 11 archivos modified, 5 waves seriales + paralelizables, 147 tests esperados, regresión-checklist WKH-180/181 intactos) | 2026-07-11 | ✅ GENERATED |
| **F3** | Implementación dev (6 hallazgos, 6 archivos net-new + 11 modified = 17 changesets; A5 `assertReceiveConsistent` pura, A6 `ConcurrentModificationError` + `version` en state, M1 `chain.ts` única fuente, M2 `isQuoteStillValid()` método público, M3 `expectedReceivePen` en `PayoutSubmit`, M4 chainId/address validation en `InjectedWallet`/`WalletConnectWallet`) | 2026-07-11 | ✅ WAVE 0-5 DONE |
| **AR** | 0 BLOQUEANTES, 3 MENOR (chain-hardcode, expiry-window, save-final-position) → 2 fixeados en F3, 1 aceptado como correcto | 2026-07-11 | ✅ APROBADO |
| **CR** | 0 BLOQUEANTES, 1 MENOR (WalletConnect test coverage) → fixeado (4 tests nuevos, parity con InjectedWallet) | 2026-07-11 | ✅ APPROVED |
| **F4** | tsc 0, vitest 147/147, build OK, 9/9 ACs PASS, cero drift (11 files matched story-file, 4 net-new + `tsconfig.tsbuildinfo` artifact), CDs verificados, ripple green, WKH-180/181 intactos | 2026-07-11 | ✅ APROBADO PARA DONE |

**Branch**: `fix/182-money-path-robustez`  
**Repo**: `chaski-v2/`

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | **PASS** | `src/domain/remittance.ts:113-119` (`assertReceiveConsistent`), pura sin I/O, valida `\|receive − expected\| ≤ max(0.02 PEN, 1% expected)` donde `expected = (send − fee) × rate` |
| AC-2 | **PASS** | `remittance.ts:201-204` pre-`to("quoted")` + `remittance.test.ts:116-144` (casos: inflado 2×, degradado ½, boundary 14.75 PASS / 14.85 FAIL) |
| AC-3 | **PASS** | `src/infrastructure/persistence.ts:94-107` (`LocalRepo.save`), CAS via `version` token, lanza `ConcurrentModificationError` si detecta carrera (get V1 → save V1 OK, pero save V1 post-otro-write → rechaza) |
| AC-4 | **PASS** | `persistence.ts:100-102` fail-loud (`throw ConcurrentModificationError`), test: `save(r2)` rechaza y persistido = ganador (v2); legacy sin `version` → normaliza a 0 sin crash |
| AC-5 | **PASS** | `src/application/use-cases/confirm-and-send.ts:51-59` (re-check post-autoridad, antes de firma) + `:67-77` (re-check post-firma, antes de submit), `ScriptedClock([T0, 18:11])` → `payout_failed`/`quote_expired_before_submit`, `authorizeSpy`/`submitSpy` no llamados (orden CD-2 respetado) |
| AC-6 | **PASS** | `confirm-and-send.ts:85` (`expectedReceivePen: quote.receive` en `submit()`, `amountUsd` preservado en L84) + `confirm-and-send.test.ts:166-182` (spy: `expectedReceivePen === Money.of(1480,"PEN")`, `amountUsd===400`) |
| AC-7 | **PASS** | `src/infrastructure/chain.ts:9-18` (`resolveChainId()/resolveChain()`, única fuente), `wallet.ts` importa de acá (CD-5), no hardcode residual de `avalanche` en adapters |
| AC-8 | **PASS** | `wallet.ts:26-33` (InjectedWallet) + `:114-126` (WalletConnectWallet), chainId mismatch → `switchChain`/`wallet_switchEthereumChain` intentado, rechazo → `throw wrong_chain`; tests: `:94-118` + `:148-171` (coincide/switch/rechazo para ambos) |
| AC-9 | **PASS** | `wallet.ts:24,45,113,138` (`isAddress` guard antes de `signMessage` en ambos adapters, en `connect()`/`authorizePrincipal()`); tests `:132-141` + `:185-194` (address malformada → `invalid_address`, firma NO llamada) |

---

## Hallazgos finales

### BLOQUEANTEs
**Ninguno.** Pipeline limpio, 0 BLOQUEANTES en AR/CR.

### MENOREs (AR + CR, dedup)
| # | Origen | Resolución | Status |
|----|--------|-----------|--------|
| MNR-1 | AR | Chain hardcodeada (M1) — `avalanche` import + `[43114]` en WC init | **FIJADO** en F3: `chain.ts` única fuente, ambos wallets via `resolveChainId()` |
| MNR-2 | AR | Expiry-window (M2) — quote puede expirar entre `confirm()` y `submit()` | **FIJADO** en F3: 2 checks `isQuoteStillValid()`, pre/post-firma (AC-5) |
| MNR-3 | AR, confirmado por CR | Save final dentro try/catch (post-submit) — inconsistencia caché vs remoto si falla | **ACEPTADO**: fail-loud correcto, propaga alerta operador, idempotencyKey previene doble-submit en retry (riesgo post-hoc documentado en SDD §3.1, no requiere acción) |
| MNR-B | CR | WalletConnect test coverage (AC-8/AC-9) — faltaban tests para chainId/address validation | **FIJADO** en F3: 4 tests nuevos en `wallet.test.ts:148-171` + `:185-194`, mock `@walletconnect/ethereum-provider` |

**Residual**: MNR-3 aceptado (arquitectura correcta). Fix-pack finalizado (MNR-1, MNR-2, MNR-B verdes en F4).

---

## Auto-Blindaje consolidado

Hallazgos del ciclo 2026-07-10 a 2026-07-11 (WKH-182) — endurecimientos latentes de money-path:

| Hallazgo | Descripción | Impacto | Mitigación | Atado a HU | Lección |
|----------|-------------|--------|-----------|-----------|---------|
| **A5** | Dominio no valida `receive` consistente con `send`/`fee`/`rate` | ALTO (tampering de quote, proveedor comprometido) | Validación pura `assertReceiveConsistent`, tolerancia 0.02 PEN / 1% | WKH-182 AC-1/2 | **Latente = real mañana**: hoy el quote es local (`FallbackQuoteGateway`); remoto (`remit-corridor-fx` agente A2A) necesita este chequeo para evitar degradación silenciosa de monto. Recalibrar tolerancia si el agente real redondea distinto. |
| **A6** | Read-modify-write sin CAS: 4×save en `ConfirmAndSend`, doble-click / retry red = doble-submit | CRÍTICO (duplicación de pago en versión real) | CAS `version` token, fail-loud `ConcurrentModificationError`, 1º `save()` fuera try/catch (CD-2) | WKH-182 AC-3/4 | **Ripple invisible**: la firma de `save()` no cambia; otros 5 use-cases heredan CAS gratis (transparente porque `version` viaja en snapshot). Test secuencial happy-path (use-cases.test.ts:57) verifica cero falso conflicto. **Cuidado en WKH-168**: si el real `PayoutGateway` intenta re-idempotenciar con `(remittanceId, version)` duplicado, el CAS lo rechazará correctamente; diseñar retry-strategy en el orchestrator, no en `payouts.submit()`. |
| **M1** | Chain hardcodeada a 43114 mainnet en wallet.ts | MEDIO (demo vive, pero config-drift riesgo: REOWN config vs `avalanche` import desincronizados) | `chain.ts` única fuente (`resolveChainId()`), env-driven `NEXT_PUBLIC_CHAIN_ID`, default 43114 fail-safe | WKH-182 AC-7, CD-5 | **Arquitectura**: separar la LECTURA de env (funciones puras testeable) de la APLICACIÓN (imports en adapters). Reutilizable en otros proyectos (mismo patrón en WKH-167, landing, etc.). **Decisión diferida**: flipear default a 43113 Fuji es decisión founder, tira con EIP-3009 real (WKH-168). Hoy env-default permite switchear sin código. |
| **M2** | Expiry no re-chequeado entre `confirm()` y `submit()` | ALTO (firma de usuario para monto expirado; con payout real = pérdida económica) | 2 `isQuoteStillValid()` checks (post-autoridad, post-firma), fail-loud `quote_expired_before_submit` | WKH-182 AC-5, CD-2 | **Ventana de firma**: WalletConnect/deep-link a mobile wallet puede tardar minutos. En producción, **comunicar al usuario** ("firma vencerá en X segundos"), no fallar calladamente. Hoy mock ignora `expectedReceivePen`, así que la expiración es visible solo en estado/telemetría (flow-vm transiciona a `payout_failed`). Verificado en test con `ScriptedClock`. |
| **M3** | `PayoutSubmit` recibe USD bruto, partner puede re-derivar PEN a su tasa | MEDIO (inconsistencia garantía "recibo real" de WKH-178) | `expectedReceivePen` agregado a `PayoutSubmit` (AC-6), `amountUsd` preservado (auditoría dual posible) | WKH-182 AC-6, DT-5 | **Contrato sin reemplazo**: se AGREGA campo, no se cambia `amountUsd`. Permite auditoría del partner (`amountUsd` convert a su tasa, comparar vs `expectedReceivePen` ± sanity-margin). **Fallback/mock**: ignora `expectedReceivePen` estructuralmente (cero cambio del mock). **WKH-168 lisura**: PayoutGateway real debería asumir `expectedReceivePen` YA presente; orden de merge WKH-182 antes que WKH-168. |
| **M4** | Sin validación chainId post-connect ni address | BAJO (integridad local, no cripto; pero firma podría pedirse en red equivocada) | `isAddress` guard, chainId mismatch → `switchChain` suave, rechazo → `wrong_chain`/`invalid_address` | WKH-182 AC-8/9 | **Switch suave**: WalletConnect permite que el wallet rechace la chain solicitada → implementamos suave-retry (`wallet_switchEthereumChain`) antes de fail-loud. **Tests**: ambos adapters (InjectedWallet, WalletConnectWallet) cubren 3×3 casos (chain-ok/switch/rechazo × address-ok/malformed) — verificado uniformidad CD-5. |

**Nexo de ciclo**: 6 hallazgos vinculados, 6 ACs = latencia cerrada. Los 3 MENOREs residuales (1 ACEPTADO, 2 FIXEADOS) cierran pequeños gaps de cobertura / posicionamiento de código. Ripple sobre WKH-180/181: cero (ambas intactas), verificado en F4. Bloqueante futuro: EIP-3009 real (WKH-168) debe asumir `expectedReceivePen` presente + CAS operativo.

---

## Archivos modificados

**Total**: 15 changesets (11 modified + 4 net-new)

### Domain (`src/domain/`)
- `remittance.ts` — agregado `assertReceiveConsistent()` helper (A5), `isQuoteStillValid()` público (M2), `version: number` en `RemittanceState` (A6)
- `remittance.test.ts` — 28 nuevas assertions (AC-1/AC-2/AC-5, boundary cases)

### Application (`src/application/`)
- **net-new** `errors.ts` — `ConcurrentModificationError` clase tipada (A6)
- `use-cases/confirm-and-send.ts` — 2º expiry check (M2 AC-5), `expectedReceivePen` en `submit()` (M3 AC-6), CAS manejo en 1º `save()` (A6 AC-3), reordenamiento guards CD-2
- `use-cases/confirm-and-send.test.ts` — 25 nuevas assertions (AC-3/AC-4/AC-5/AC-6, carrera, expiry, submit payload)
- `ports.ts` — `PayoutSubmit` + `expectedReceivePen: Money` campo (AC-6), `RemittanceRepository.save()` contrato de CAS

### Infrastructure (`src/infrastructure/`)
- **net-new** `chain.ts` — `resolveChainId()`, `resolveChain()` (M1 AC-7, CD-5)
- **net-new** `chain.test.ts` — 5 casos (env unset/43113/43114/99/abc)
- `persistence.ts` — CAS en `LocalRepo.save()` (A6 AC-3/AC-4), `normalizeState()` default `version:0` (legacy compat)
- `persistence.test.ts` — 4 nuevas assertions (race-1 concurrent, seq-1 false-positive)
- `wallet.ts` — reemplazo `avalanche` hardcode por `resolveChain()` (M1 AC-7), AC-8 chainId validation + `switchChain` (post-connect, suave), AC-9 `isAddress` guards (pre-firma)
- **net-new** `wallet.test.ts` — 4 tests `WalletConnectWallet` (AC-8/AC-9 parity con InjectedWallet)
- `fallback/gateways.ts` — SIN CAMBIOS (mock ignora `expectedReceivePen` estructuralmente)
- `test-support/fakes.ts` — `InMemoryRepo.save()` replica CAS, `ScriptedClock` helper (AC-5 test, múltiples timestamps en secuencia)

### Config (`root`)
- `.env.example` — agregado `NEXT_PUBLIC_CHAIN_ID` (documentación)

### Otros
- `src/test-support/container.ts` — SIN CAMBIOS (chain resuelto en `wallet.ts`, no container)

---

## Decisiones diferidas a backlog

### 1. Flipear default chainId a Fuji testnet (43113)
**Atado a**: WKH-168 (EIP-3009 real, firma real de fondos)  
**Estado**: `NEXT_PUBLIC_CHAIN_ID` ya env-driven, puede flipear sin código (`resolveChainId()` default 43114 fail-safe a producción actual, 43113 Fuji requiere `.env.local`/Vercel update)  
**Coordinación**: el founder decide junto con config de REOWN/Vercel (hoy ambas en 43114)

### 2. RLS en `a2a_agent_keys` (WKH-SEC-02)
**Relación**: no toca WKH-182 directamente (chaski-v2 es independiente), pero WKH-180 tiene `owner_ref` de referencia. Seguimiento: verificar que la HU siguiente respeta el patrón de ownership que instaló WKH-54/WKH-180.

### 3. Replay-protection en firmas futura
**Atado a**: WKH-168 (EIP-3009 real)  
**Estado**: AC-9 valida address formada y no-nula, pero replay-protection (chainId en dominio del mensaje, timestamp, etc.) es futura. Hoy `signMessage` es simbólico (sin fondos reales), así que no es problema. EIP-3009 real lo requerirá.

---

## Lecciones para próximas HUs

1. **Latencia = deuda productiva, bien mapeada**: los 6 hallazgos de money-path (A5, A6, M1-M4) son hoy simbólicos (quote local, payout mock, firma sin fondos reales), pero se vuelven explotables con EIP-3009 real. **Mapear riesgos latentes en el grounding F0 permite hacerlos explícitos ANTES de que sean críticos**. Patrón: pre-hardening en HUs de robustez, post-puesta-en-producción en HUs de value-delivery.

2. **CAS en la infra, transparent en el dominio**: implementar el token de versión en `persistence.ts` (no en el dominio puro) permite que 6 use-cases hereden CAS gratis sin edición. **Ripple invisible = confiable**. En WKH-168, si el real `PayoutGateway` re-intenta con versión duplicada, el CAS lo rechazará correctamente. Diseñar retry en el orchestrator, no en la lógica de submit.

3. **Separar lectura de env (funciones puras) de aplicación (imports hardcodeados)**: el patrón `chain.ts` (`resolveChainId()` testeable, no `import { avalanche }` en adapter) es reutilizable. Recomendar para cualquier config env que deba testear / multi-chain / switcheable en runtime.

4. **Switch suave antes de fail-loud**: AC-8 implementa `wallet_switchEthereumChain` ANTES de rechazar la sesión. WalletConnect permite que el wallet rechace la chain → respetamos esa decisión (UX, no forced), pero fail-loud si el usuario rechazo + intent firma. Patrón: ofrecer salida clara, no trampa silenciosa.

5. **Deuda residual aceptada = documentada explícitamente**: MNR-3 (save final fail-loud post-submit) es correcto, pero requiere que el orchestrator sepa manejar inconsistencia caché-remota en retry. SDD §3.1 lo documenta; test + comentario en código previenen cargo-cult "debería estar afuera del try/catch". **No todo mejora es una mejora.**

6. **Coordinación de merge en backlog paralelo**: WKH-182/183 coordinadas bajo NNN (005/006), ambas tocan `confirm-and-send.ts`, `ports.ts`, `persistence.ts`. Orden sugerido: 182 antes de 183 (182 instala `expectedReceivePen`, 183 reusa). **Aún no aplicada en este ciclo** (ambas DONE separado); en próximas HUs, mergear en orden explícito.

