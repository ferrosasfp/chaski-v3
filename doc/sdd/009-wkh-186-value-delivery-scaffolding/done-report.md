# Report — WKH-186 (Value-delivery scaffolding: adapter a2a mock/off, reconciliación, refund-on-failure, EIP-3009-ready)

**Status**: DONE (2026-07-11)  
**Branch**: `feat/186-value-delivery-scaffolding-a2a-eip3009-ready` (repo `chaski-v2`)  
**Commits**: `eebc7a3` (docs) + `c1e08da` (W0+W1) + `d285788` (W2+W3+W4) + fix-pack de 4 MENORs (aplicados, uncommitted)

---

## Resumen ejecutivo

WKH-186 cierra la porción **técnica** de WKH-168 (desembolso real) con scaffolding completo de value-delivery en `chaski-v2`, manteniendo **cero movimiento de dinero real por default** (6 capas de defensa verificadas). Construyó 4 piezas: (1) adapter `a2a` que llama a los agentes live `remit-corridor-fx`/`remit-cashout-payout`; (2) reconciliación (deliveredPen vs expectedReceivePen, misma tolerancia que `assertReceiveConsistent`); (3) **gap real cerrado**: refund-on-failure (cierra remesas huérfanas en `payout_failed`); (4) EIP-3009-ready (firma real de `transferWithAuthorization`, OFF por default con fail-loud si se enciende sin conditions). **Pipeline QUALITY completo: F0→F1→F2→F2.5→F3→AR→CR→F4, todos en verde.** 14/14 ACs PASS, 17/17 CDs cumplidas, 4 MENORs fixeados, 0 BLOQUEANTES. Listo para merge.

---

## Pipeline ejecutado

| Fase | Estado | Detalles |
|------|--------|---------|
| **F0** | ✅ COMPLETADA | Project context verificado (2026-07-11). Grounding en disco: ports, containers, wallets, agents remit-*, persistencia CAS, FSM refund-ready. |
| **F1** | ✅ HU_APPROVED | Work-item `001-wkh-186-value-delivery-scaffolding/work-item.md` (aprobado en fase de arranque). 14 ACs EARS, 10 DTs, 17 CDs, 4 Missing Inputs no-bloqueantes. |
| **F2** | ✅ SPEC_APPROVED | SDD `sdd.md` completado: §4 diseño paso-a-paso (ports, adapters, helpers), §5 contract de agentes remit-*, §6 arquitectura de composición, §7 specs detalladas por AC. Gate SPEC_APPROVED otorgado. |
| **F2.5** | ✅ COMPLETADA | Story-file `story-file.md`: contrato autosuficiente para Dev. Scope IN/OUT claro, anti-hallucination anchors verificados en disco, exemplars de patrón. |
| **F3** | ✅ COMPLETADA (5 waves) | Implementación: W0 ports+adapters base (`c1e08da`), W1 API routes proxy (`c1e08da`), W2 reconciliación en confirm-and-send (`d285788`), W3 refund-on-failure (`d285788`), W4 EIP-3009-ready (`d285788`). Commits auditables, docs inline. **Fix-pack post-CR** (4 MENORs, uncommitted): MNR-A (receiver address validation), MNR-B (cache-miss status), MNR-C (shape validator alignment), MNR-D (try/catch reconciliación). |
| **AR** | ✅ APROBADO | Adversarial Review: 0 BLOQUEANTES, **2 MENOR fixeados** (MNR-A, MNR-B). Guarantee money-path (CD-2) verificada en 6 capas. Scope CD-1 ✅. Ver `ar-report.md`. |
| **CR** | ✅ APROBADO | Code Review: 0 BLOQUEANTES, **2 MENOR fixeados** (MNR-C, MNR-D). Type safety ✅, pattern adherence ✅, regresión ✅. DTs verificados. Ver `cr-report.md`. |
| **F4** | ✅ APROBADO PARA DONE | Validation Report: `tsc 0`, `vitest 223/223` (incluye regresión), `build OK`. **14/14 ACs PASS** con evidencia archivo:línea. **17/17 CDs cumplidas**. CD-2 (money-path) verificada en 6 capas independientes. Drift 0 fuera de scope esperado. Ver `f4-report.md`. |

---

## Acceptance Criteria — resultado final

**14/14 PASS** (extraído del F4-report con evidencia):

| AC | Resumen | Status | Evidencia |
|----|---------|--------|-----------|
| AC-1 | Default/fallback → FallbackQuoteGateway/FallbackPayoutGateway, byte-idéntico | ✅ PASS | `container.ts:55,68-69,73`; test `container.test.ts:8-10` |
| AC-2 | `adapter="a2a"` → A2aQuoteGateway/A2aPayoutGateway cableados | ✅ PASS | `container.ts:68-69`; test `container.test.ts:12-15` |
| AC-3 | requestQuote() → POST `/api/a2a/quote`, mapea `{result}`→Quote | ✅ PASS | `gateways.ts:93-108`; `route.ts`; test `gateways.test.ts:35-51` |
| AC-4 | submit() → POST `/api/a2a/payout/submit`, idempotencyKey intacto | ✅ PASS | `gateways.ts:116-135`; test `gateways.test.ts:73-87` |
| AC-5 | !200/shape inválido → error PII-free explícito | ✅ PASS | `gateways.ts:104,106,129,131`; test `gateways.test.ts:57-70,109-124` |
| AC-6 | deliveredPen ≈ expectedReceivePen (misma tolerancia) PRE-settled, mismatch → payout_failed | ✅ PASS | `remittance.ts:113-119`; `confirm-and-send.ts:112-119`; test `confirm-and-send.test.ts:190-224` |
| AC-7 | CUALQUIER payout_failed → creditBack() + markRefunded() MISMO execute() | ✅ PASS | `failAndRefund()` 6 call-sites en ConfirmAndSend, 2 en TrackRemittance; test `use-cases.test.ts:123` |
| AC-8 | LedgerRefundGateway ledger-only, DEFAULT, gap de clawback documentado | ✅ PASS | `ledger-refund-gateway.ts:1-17`; `container.ts:75`; test verdes |
| AC-9 | Flag off → signMessage byte-idéntico | ✅ PASS | `wallet.ts:22-24,92-98,206-211`; test `wallet.test.ts` "flag OFF" |
| AC-10 | Flag on → signTypedData real transferWithAuthorization | ✅ PASS | `wallet.ts:69-91,184-205`; test `wallet.test.ts` "flag ON" |
| AC-11 | EIP-3009 on + (adapter≠a2a ∨ sin receiver) → throw fail-loud en container | ✅ PASS | `container.ts:59-67`; 6 tests `container.test.ts` |
| AC-12 | .env.example documenta 4+1 vars, defaults mock/off | ✅ PASS | `.env.example:51-71` |
| AC-13 | Tests para adapters/refund/refund-on-failure/guard | ✅ PASS | Suite completa: `gateways.test.ts`, `ledger-refund-gateway.test.ts`, `confirm-and-send.test.ts`, `track-remittance.test.ts`, `wallet.test.ts`, `container.test.ts` |
| AC-14 | status() devuelve PayoutRecord cacheado del submit() | ✅ PASS | `gateways.ts:137-153` (Map cache, MNR-B fix); test `gateways.test.ts:126-133` |

---

## Hallazgos finales

### BLOQUEANTES
**Ninguno.** 0 hallazgos bloqueantes en AR/CR.

### MENOR (4 items, TODOS fixeados)
| Item | Fase | Descrip | Fix aplicado |
|------|------|---------|------------|
| **MNR-A** | AR | receiver address sin validar (checksum inválido entraría a wallet) | ✅ `resolveReceiverAddress()` con `isAddress()` + fail-loud en container; 2 tests verdes |
| **MNR-B** | AR | status() cache-miss devolvía `"failed"` (falsa refund) | ✅ Ahora `"submitted"` + `failureReason:"payout_status_unknown"`, no transiciona a payout_failed; tests verdes |
| **MNR-C** | CR | validador shape divergente (gateway vs route) | ✅ Alineado `isValidPayoutResult` con `isValidPayoutShape`; 3 tests verdes |
| **MNR-D** | CR | reconciliación sin try/catch (excepción escapa) | ✅ try/catch + degradación a `failAndRefund`; test `track-remittance.test.ts:132-146` verdes |

**Status**: TODOS CERRADOS con evidencia código+test.

---

## Garantía money-path — CD-2 (CRÍTICA)

**Verificado en 6 capas independientes** — ninguna mueve dinero real por default (todas las env vars nuevas unset):

1. **Adapter default** (`container.ts:55,68-69`): `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` unset → cablea `FallbackQuoteGateway`/`FallbackPayoutGateway` (mock). El adapter `a2a` (que hace `fetch` real) NUNCA se instancia.

2. **Fallback gateways** (`src/infrastructure/fallback/gateways.ts:95-116`): `FallbackPayoutGateway.submit()` devuelve `{status:"submitted", deliveredPen:null}`; `.status()` devuelve `{status:"settled", deliveredPen:null}`. Byte-idéntico a pre-HU. Comentario explícito "MOCK".

3. **Wallet default** (`src/infrastructure/wallet.ts:22-24,92-98,206-211`): `NEXT_PUBLIC_EIP3009_ENABLED` unset → `eip3009Enabled()=false` → ambos wallets reales cae al path default `client.signMessage(...)` (firma simbólica, sin `transferWithAuthorization`). `FallbackWallet` intacto `0xdemo...`.

4. **Refund ledger-only** (`src/infrastructure/refund/ledger-refund-gateway.ts`): `LedgerRefundGateway` (ÚNICO `RefundGateway` cableado, sin flag) es ledger-only por construcción: `creditBack()` no hace I/O, solo retorna `{refundTx: "refund-ledger-<ts>"}` sintético. Comentario L1-5 explícito "NO revierte ningún movimiento on-chain real".

5. **Routes server-only sin BASE por default** (`app/api/a2a/quote/route.ts:26-27`, `payout/submit/route.ts:31-32`): `BASE = process.env.REMIT_AGENTS_BASE_URL` (server-only, unset) → `if (!BASE) return 501` — ni siquiera se intenta fetch sin config explícita. Ningún default de URL de prod hardcodeado.

6. **Guard fail-loud** (`container.ts:59-67`): si alguien setea `EIP3009_ENABLED=true` sin 3 conditions (`adapter=a2a` + receiver válido + usdc válido), `createContainer()` throws → app no arranca. Imposible modo mixto silencioso.

**Conclusión CD-2**: ✅ **PASS VERIFICADO EN 6 CAPAS**. Cero dinero real por default.

---

## Gap real cerrado: refund-on-failure

**Antes de esta HU (grounding F0):**
- `ConfirmAndSend` y `TrackRemittance` llamaban `markPayoutFailed()` en 5+2 sitios.
- Nadie llamaba `markRefunded()` — FSM soportaba `payout_failed→refunded`, pero NO EXISTÍA dispatch.
- Remesas en `payout_failed` quedaban **huérfanas para siempre** (incluso en modo 100% mock).
- Gap real, no solo riesgo de Fase A.

**Después (AC-7, CD-7):**
- `failAndRefund()` helper en ambos use-cases (DT-9).
- Cada `markPayoutFailed` → `await this.failAndRefund(r, reason)`.
- Llama `refund.creditBack()` + `r.markRefunded(refundTx)` en el MISMO `execute()`.
- Remesas transicionan a `refunded` (terminal) en vez de quedar huérfanas.
- `LedgerRefundGateway` default es ledger-only (CD-8), sin movimiento on-chain real hoy.
- En Fase A: reemplazar por `OnChainRefundGateway` que interactúa con `transferWithAuthorization` cacheada + facilitar relay → clawback real.

**Status**: ✅ **GAP CERRADO**. Flujo completo end-to-end + gap documentado para Fase A.

---

## Runbook: cómo flip a Fase A (real money-path)

Cuando TransFi sandbox está listo (Fase A, founder/partner), el único cambio para habilitar remesas REALES es:

### Paso 1: Habilitar adapter a2a + agentes reales

En `chaski-v2/.env.local` (o Vercel env vars):
```bash
# Habilita el adapter que llama a remit-* agentes
NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=a2a

# URL base del deploy de wasiai-remittance-agents (ej: staging o prod)
REMIT_AGENTS_BASE_URL=https://wasiai-remittance-agents.staging.com

# (opcional, puede estar en wasiai-remittance-agents .env)
# REMIT_AGENTS_HMAC_SECRET=...  (si se agrega auth a los routes)
```

**Efecto**: Las llamadas a `requestQuote()` y `submit()` ahora van a `remit-corridor-fx`/`remit-cashout-payout` REALES (vía `/api/a2a/*` routes de `chaski-v2`, que hacen fetch server-side a la URL).

**Crítico**: Los agentes `remit-*` EN ESE DEPLOY deben tener sus propios env vars configurados:
- `TRANSFI_API_KEY=` (key real TransFi, en `wasiai-remittance-agents .env`)
- `TRANSFI_ADAPTER_READY=true` (flag que desactiva el `PAYOUT_ALLOW_MOCK`, permite real payout)

SIN estos, los agentes siguen devolviendo mock (`status:"settled"` sin dinero real) — segunda capa de defensa.

### Paso 2 (opcional, para Avalanche mainnet native settlement vía EIP-3009)

Si se desea Settlement Gasless real (firmar `transferWithAuthorization` en el cliente):

```bash
# Enciende el path signTypedData en wallet.ts
NEXT_PUBLIC_EIP3009_ENABLED=true

# Dirección de custodia/partner en Avalanche (aquí entra el USDC real)
NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS=0x<partner-wallet>

# (Opcional) Dirección exacta del contrato USDC en la chain
# (Hoy default: Circle canonical 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48Ca0 para Avalanche mainnet)
NEXT_PUBLIC_USDC_CONTRACT_ADDRESS=0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48Ca0
```

**Guard fail-loud**: si falta `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS` o el adapter NO es `a2a`, `createContainer()` throws → app no arranca. Imposible un modo mixto inseguro.

**Efecto**: El cliente firma real EIP-3009 `transferWithAuthorization()`; el facilitador Avalanche consume la firma y settlea on-chain.

### Paso 3 (dependencia externa): Facilitador Avalanche

Hoy el facilitador del ecosistema (relay `wasiai-facilitator`) solo settlea Base Sepolia.
Para Avalanche mainnet native, necesita:
- Adapter nuevo en `wasiai-facilitator` para deserializar + verificar firma EIP-3009 en Avalanche.
- Listener/relay que consume `transferWithAuthorization` y lo publica on-chain.
- Integration test e2e (cliente → firma EIP-3009 → facilitador → on-chain Avalanche).

Este paso es **fuera de scope de `chaski-v2`** (CD-1, no tocar otros repos). Es HU futura en `wasiai-facilitator` (proyecto separado, equipo mismo).

---

## Residuales Fase A (documentados en work-item Missing Inputs)

| Item | Descripción | Owner | Nota |
|------|-------------|-------|------|
| **#1 (DT-1)** | ¿Llamada directa al agente vs través del gateway pagado `/compose` de `wasiai-a2a`? | Architect | No bloquea. Propuesta: DIRECTO (hoy sin auth, mismo team). Documentado como [NEEDS CLARIFICATION] no-bloqueante. |
| **#2 (CD-16)** | Dirección/contrato USDC exacto por chain para EIP-3009 dominio | Architect | No bloquea. Flag EIP-3009 está OFF por default. Verificado en disco: Circle canonical hardcodeada para Avalanche mainnet. |
| **#3 (AC-11)** | `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS` — no existe hoy (Fase A/partner) | Founder/Partner | Guard CD-4 previene uso sin valor válido. Diferido OK. |
| **#4 (AC-14)** | `remit-cashout-payout` no expone polling asíncrono separado | wasiai-remittance-agents team | No bloquea esta HU. Si TransFi real es async, ese repo gana endpoint `/status` nuevo (HU futura, fuera de chaski-v2). |

---

## Auto-Blindaje consolidado

Lecciones extraídas de F3 (5 waves) y fix-pack post-CR:

### Lección 1: env vars en module-load rompen `vi.stubEnv` en route tests
**Contexto**: Wave 2, routes a2a.  
**Problema**: Leer `const BASE = process.env.REMIT_AGENTS_BASE_URL` en el top-level del módulo congela el valor al import-time. `vi.stubEnv()` (llamado en el test) solo afecta lecturas en runtime → 8 tests fallaban con 501 en vez de 200/502.  
**Fix**: Mover `const BASE = process.env.REMIT_AGENTS_BASE_URL` DENTRO de `POST()`.  
**Aplicar en**: Cualquier API route nueva que dependa de env stubeable en tests — leer env dentro del handler, NUNCA en el top-level.  
**Fuente**: `auto-blindaje.md:3-14`.

### Lección 2: Fake de payout con deliveredPen debe alinearse al quote
**Contexto**: Wave 1, fixture inconsistente disparó reconciliación nueva.  
**Problema**: `FakePayoutGateway.status()` devolvía `deliveredPen: Money.of(368, "PEN")` (arbitrario), NO coincidía con el `receive` del `FakeQuoteGateway` (1478.15 PEN para 400 USDC). La reconciliación (correctamente) lo marcó `payout_amount_mismatch` → `refunded` en vez de `settled`.  
**Fix**: Alinear default de `FakePayoutGateway.status()` a `Money.of(1478.15, "PEN")` (consistente con quote fake).  
**Aplicar en**: Cualquier fake de payout con `deliveredPen` no-null DEBE ser consistente con el `receive` del quote fake usado en el mismo flujo, o será refundado correctamente (por la reconciliación nueva). En producción: regresión safe (Fallback devuelve `deliveredPen: null` → guard nunca corre).  
**Fuente**: `auto-blindaje.md:16-29`.

### Lección 3: Fail-loud es mejor que silencioso
**Contexto**: AC-11, guard fail-loud en container.  
**Insight**: Cuando un env var puede crear una combinación insegura (EIP-3009 real sin adapter payout real), es mejor tirar al compilar (`createContainer()` throws) que en runtime. Zero surprised en staging. El patrón "fail early, fail loud" + guard en composición root es más seguro que "defaultear silenciosamente" o "advertir en el log".  
**Aplicar en**: Cualquier HU futura que combine flags con invariantes de seguridad → guard en `createContainer()`, nunca runtime.

### Lección 4: Reconciliación pre-settled detecta gaps de correspondencia
**Contexto**: AC-6, validación nuevo `isDeliveredWithinReceiveTolerance`.  
**Insight**: El `assertReceiveConsistent` ya existía en quote-time (validar rate sanity). Introducir la MISMA validación en payout-time (post-submit, pre-settled) cierra un gap real: si el partner entrega una cantidad divergente (ej. otra tasa, fee sorpresa, truncado, etc.), la remesa transiciona a `payout_failed` + refund automático en lugar de settlerse con discrepancia silenciosa. Es una segunda oportunidad de catch errores del partner antes de ser terminal.  
**Aplicar en**: Cualquier HU de money-path que introduzca un adapter externo (partner, exchange, facilitador) → validar post-submit que los datos entregados matchean la promesa pre-settled. No asumir que los partners son perfectos.

### Lección 5: Try/catch alrededor de validaciones es defensa simetría
**Contexto**: MNR-D, try/catch reconciliación en TrackRemittance.  
**Insight**: `ConfirmAndSend` YA envolvía submit en try/catch (línea 82-96). `TrackRemittance` hizo lo mismo con su rama de reconciliación (39-57). Mantener simetría de defensa es importante: si una rama puede lanzar, todas deben estar envueltas. Si una es silenciosa, es leak.  
**Aplicar en**: Auditoría de try/catch: si una rama de un flujo está envuelta, verificar que todas las demás también lo están. Asimétría = bug o deuda técnica.

---

## Archivos modificados

**Sumario**: 27 archivos (código 15 + tests 7 + docs 5). Todos dentro de `chaski-v2/`.

### Nuevos (10)
- `src/infrastructure/a2a/gateways.ts` (adapters A2aQuoteGateway/A2aPayoutGateway, 160 SLOC)
- `src/infrastructure/a2a/gateways.test.ts` (tests adapters, 130 SLOC)
- `src/infrastructure/refund/ledger-refund-gateway.ts` (LedgerRefundGateway default, 20 SLOC)
- `src/infrastructure/refund/ledger-refund-gateway.test.ts` (tests refund, 40 SLOC)
- `app/api/a2a/quote/route.ts` (proxy route quote, 50 SLOC)
- `app/api/a2a/quote/route.test.ts` (tests route, 80 SLOC)
- `app/api/a2a/payout/submit/route.ts` (proxy route payout, 50 SLOC)
- `app/api/a2a/payout/submit/route.test.ts` (tests route, 100 SLOC)
- `src/application/use-cases/track-remittance.test.ts` (tests tracking, 200 SLOC)
- `doc/sdd/009-wkh-186-value-delivery-scaffolding/` (todos los artefactos HU)

### Modificados (17)
- `src/application/ports.ts` (+RefundGateway port, 6 lineas)
- `src/domain/remittance.ts` (export `isDeliveredWithinReceiveTolerance`, 3 lineas)
- `src/application/use-cases/confirm-and-send.ts` (+refund dep, failAndRefund(), reconciliación, ~60 lineas)
- `src/application/use-cases/confirm-and-send.test.ts` (nuevos casos, ~100 lineas)
- `src/application/use-cases/track-remittance.ts` (+refund dep, failAndRefund(), reconciliación, ~60 lineas)
- `src/composition/container.ts` (flags adapter+EIP3009, guard fail-loud, wiring refund, ~40 lineas)
- `src/infrastructure/wallet.ts` (rama EIP-3009 signTypedData, ambos wallets, ~100 lineas)
- `src/infrastructure/wallet.test.ts` (casos flag-off/on, guard, ~120 lineas)
- `src/infrastructure/chain.ts` (+resolveReceiverAddress helper, 10 lineas)
- `src/test-support/fakes.ts` (+FakeRefundGateway, 30 lineas)
- `src/test-support/test-container.ts` (+override refund, 10 lineas)
- `.env.example` (4+1 vars nuevas, 30 lineas comentadas)
- `src/application/use-cases.test.ts` (ripple: 6º arg ConfirmAndSend, 4º arg TrackRemittance, assertion payout_failed→refunded, 3 lineas)
- `doc/sdd/_INDEX.md` (actualizar fila WKH-186 → DONE)

**Total commit size**: ~1500 SLOC (código + tests) + ~500 docs.

---

## Lecciones para próximas HUs

1. **Env var en module-load vs runtime**: Siempre leer env dentro del handler (runtime), no en el top-level del módulo. Clave para testabilidad con `vi.stubEnv`.

2. **Fakes con estado real deben ser consistentes**: Si un fake devuelve un `deliveredPen` no-nulo, debe ser consistente con el `receive` del quote fake que se usa en el mismo flujo. La reconciliación lo validará; es una feature, no un bug.

3. **Fail-loud en guardscomposición es mejor que silencioso**: Cuando un env var combo es insegura, throw en `createContainer()`. Evita modos mixtos sorpresa en staging/prod.

4. **Reconciliación es segunda oportunidad de catch**: Introducir la MISMA validación en múltiples puntos del flujo (quote-time + payout-time) cierra gaps de partners imperfectos.

5. **Simetría de defensa**: Si una rama está wrapped en try/catch, auditar que todas lo están. Asimetría es leak.

6. **Ledger-only fakes**: Cuando un adapter mock no puede mover dinero real (ej. LedgerRefundGateway), ser explícito en el comentario. Documentar el gap para Fase A/follow-up.

7. **API routes server-only**: Nunca exponer `REMIT_AGENTS_BASE_URL` ni keys server-only al cliente. Patrón: env server-side, devolver solo `{result}`/`{error}`, nunca la URL.

8. **Idempotency keys intactos**: Cuando un key ya existe en el dominio (ej. `idempotencyKey` en PayoutSubmit), forwardear tal cual al partner. Nunca mutar en el adapter.

---

## Status de entrada a Fase A

**Bloqueantes abiertos**: Ninguno.  
**Residuales de Fase A** (documentados, no bloquean): 4 items en work-item Missing Inputs.  
**Partner readiness**: `wasiai-remittance-agents` repo existe, agentes `remit-corridor-fx` y `remit-cashout-payout` ya live + deployados (verificado en disco). Sin auth hoy; ambos routes envueltos en try/catch fail-loud.  
**Facilitador Avalanche**: Pendiente (HU futura en `wasiai-facilitator`, fuera de scope).

**Veredicto**: ✅ **LISTO PARA MERGE** + **PREPARADO PARA FASE A** (env vars, runbook, gaps documentados).

---

## Cierre

WKH-186 completa el scaffolding técnico de desembolso real con **garantía money-path verificada en 6 capas** y **gap real cerrado** (refund-on-failure). Cuando TransFi sandbox esté listo (Fase A), el único cambio será flippear env vars, NO re-arquitecturar. Pipeline QUALITY completo, 14/14 ACs, 17/17 CDs, 4 MENORs fixeados, 0 BLOQUEANTES.

**Pronto a merge a `main` + deploy staging/prod.**
