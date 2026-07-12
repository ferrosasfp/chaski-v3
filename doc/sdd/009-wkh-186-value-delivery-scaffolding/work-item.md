# Work Item — [WKH-186] Value-delivery scaffolding: adapter a2a (mock/off), reconciliación + idempotencia, refund-on-failure, EIP-3009-ready

## Resumen
Porción **técnica** de WKH-168 (desembolso real), sin depender del partner/sandbox TransFi. Construye
el scaffolding completo de value-delivery en `chaski-v2` — **cero movimiento de dinero real, todo
mock/apagado por default** — para que cuando llegue Fase A (creds TransFi) el único cambio sea
flippear env vars, no re-arquitecturar. 4 piezas: (1) adapter `a2a` que llama a los agentes live
`remit-corridor-fx`/`remit-cashout-payout` detrás de un flag de composición (default = fallback
local, como hoy); (2) reconciliación (USDC debitado == entregado, dentro de tolerancia) +
idempotencia end-to-end; (3) refund-on-failure (credit-back ledger-only, cierra el gap de remesas
huérfanas en `payout_failed`); (4) wallet EIP-3009-ready: `signTypedData` real de
`transferWithAuthorization`, detrás de un flag desactivado por default + fail-loud si se enciende
sin payout real.

## Sizing
- Modo de proceso: QUALITY (chaski-v2 es siempre QUALITY por convención de proyecto)
- SDD_MODE: full (toca 2 ports nuevos, 2 use-cases existentes, 2 adapters nuevos, `wallet.ts`,
  `chain.ts`, `container.ts`, 2 API routes nuevas, fakes/test-container — no es un fix contenido)
- Estimación: L
- Branch sugerido: `feat/186-value-delivery-scaffolding-a2a-eip3009-ready`

## F0 — Grounding (líneas verificadas 2026-07-11, sobre `main` post WKH-178..185)

### Ports actuales (`src/application/ports.ts`)
- `PayoutSubmit` (líneas 63-70) YA incluye `expectedReceivePen: Money` (WKH-182) además de
  `quoteId`, `amountUsd`, `beneficiary`, `kycVerificationId`, `idempotencyKey`. **No requiere
  romper el contrato** para mapear al agente remoto (ver abajo) — el único campo que el agente
  remoto exige y el port no tiene es `kycPayoutAllowed: boolean`, que el adapter puede sintetizar
  en `true` porque `ConfirmAndSend` (líneas 40-49) ya bloqueó el submit si `PayoutAuthorityGateway`
  no autorizó (WKH-180) — para cuando se llega a `submit()`, el KYC server-side YA está confirmado.
- `PayoutGateway` (líneas 78-81): `submit()` + `status()`. NO existe hoy ningún `RefundGateway`.
- `QuoteGateway` (líneas 21-23): `requestQuote(req: QuoteRequest): Promise<Quote>`.

### Fallback actual (`src/infrastructure/fallback/gateways.ts`)
- Línea 3: comentario explícito "Los adapters REALES (que llaman a los agentes remit-* vía las API
  routes) van en `./a2a` (post-sandbox)" — confirma dónde debe vivir el adapter nuevo.
- `FallbackPayoutGateway.submit()` (líneas 98-106) siempre devuelve `status:"submitted"`,
  `deliveredPen:null`; `.status()` (107-115) siempre resuelve a `settled` con `deliveredPen:null` —
  la UI usa el `quote.receive`, no `deliveredPen`, porque el mock nunca "entrega" nada verificable.

### Composition root (`src/composition/container.ts`)
- Líneas 43-70 (`createContainer`): cablea `FallbackQuoteGateway`/`FallbackPayoutGateway`
  incondicionalmente. Es el ÚNICO lugar que debe conocer el adapter concreto (comentario línea 1-3);
  acá va el flag nuevo.
- `ConfirmAndSend` se construye con `(wallet, payouts, repo, clock, payoutAuthority)` (línea 64) —
  necesita una dependencia nueva (`refund`) para AC-7/AC-8.
- `TrackRemittance` se construye con `(payouts, repo, clock)` (línea 65) — misma necesidad.

### `confirm-and-send.ts` (el enforcement + submit + el gap de refund)
- Líneas 40-49: gate de autoridad server-side (WKH-180) — `markPayoutFailed` sin refund.
- Líneas 79-98 (submit): en el `catch` (línea 96-97) y en la rama `rec.status === "failed"`
  (línea 93-94), llama `r.markPayoutFailed(...)` **y nada más** — NO hay ningún `markRefunded()`
  en todo el archivo (confirmado, grep de `use-cases/*.ts`: `markRefunded` NO aparece en ningún
  use-case existente). El dominio permite la transición `payout_failed → refunded`
  (`remittance.ts:95`) pero **nadie la dispara**: una remesa que llega a `payout_failed` queda
  huérfana ahí para siempre. Esto es un gap real hoy (incluso en modo 100% mock), no solo un riesgo
  de Fase A.

### `track-remittance.ts` (el otro punto donde se puede llegar a `payout_failed`)
- Líneas 12-27: polling de `payouts.status()`. Rama `rec.status === "failed"` (línea 22-24) hace
  `r.markPayoutFailed(...)` — mismo gap de refund que `confirm-and-send.ts`.

### `wallet.ts` (el `signMessage` simbólico + el comentario EIP-3009)
- `InjectedWallet.authorizePrincipal()` (líneas 46-58) y `WalletConnectWallet.authorizePrincipal()`
  (líneas 139-149): ambas firman con `client.signMessage(...)` — un mensaje humano-legible, NO una
  autorización on-chain. Comentario explícito líneas 51-52: "DEMO: firma un MENSAJE... En
  producción: EIP-3009 signTypedData del transferWithAuthorization → el principal viaja gasless al
  partner via el facilitator."
- `resolveChain()`/`resolveChainId()` (`chain.ts`) ya son env-driven (`NEXT_PUBLIC_CHAIN_ID`,
  WKH-182) — única fuente para ambos wallets. Es la base que el path EIP-3009 real debe reusar
  (misma chain, mismo principio "una sola fuente de verdad").

### `remittance.ts` (estados relevantes)
- `TRANSITIONS` (líneas 85-97): `confirmed→[principal_in, payout_failed]`,
  `principal_in→[payout_submitted, payout_failed]`, `payout_submitted→[settled, payout_failed]`,
  `payout_failed→[refunded]`, `refunded→[]` (terminal). La máquina YA soporta refund; falta el
  use-case que la dispare.
- `assertReceiveConsistent()` (líneas 109-119): la fórmula/tolerancia de consistencia
  `receive ≈ (send − fee) × rate` que la reconciliación de payout DEBE reusar (misma tolerancia,
  no una nueva, ver CD-6) — hoy solo se aplica en `attachQuote()` (quote-time), esta HU la necesita
  también en payout-time (post-submit, antes de `settled`).

### El contrato real de los agentes `remit-*` (repo `wasiai-remittance-agents`, verificado en disco)
- Contrato HTTP uniforme: `POST /api/agents/<slug>/invoke` → `200 { result: {...} }` /
  `400 { error, details }` / `502 { error }`. **Nunca 500 crudo** (ambos routes envuelven todo en
  try/catch, `remit-cashout-payout/invoke/route.ts:20-30`,
  `remit-corridor-fx/invoke/route.ts:17-27`).
- `remit-corridor-fx` (`corridor-fx.ts:13-24`): input `{ amountUsd, destCountry?, destCurrency?,
  payoutMethod? }` → output `{ slug, rate, feeUsd, netDeliveredLocal, localCurrency, etaMinutes,
  quoteId, expiresAt, provenance }` — mapea 1:1 a `Quote` del dominio (`rate`→`rate`,
  `netDeliveredLocal`→`receive.major`, `feeUsd`→`feeUsd`, `etaMinutes`→`etaMinutes`,
  `expiresAt`→`expiresAt`).
- `remit-cashout-payout` (`cashout-payout.ts:17-31`): input `{ quoteId, amountUsd,
  kycVerificationId, kycPayoutAllowed, beneficiary:{name,country,method,destination},
  idempotencyKey }` → output `{ slug, executed, status, payoutId, deliveredLocal, txRef, reason,
  provenance }`. `status` ∈ `"submitted"|"settled"|"failed"|"blocked"`. **Resuelve TODO en el mismo
  round-trip del `invoke`** (no hay un segundo endpoint de polling/status separado) — el fallback
  mock (`FallbackPayoutProvider`, `providers/payout.ts:68-89`) siempre devuelve `status:"settled"`
  inmediatamente.
- **`PAYOUT_ALLOW_MOCK`** (README del repo, líneas 136-140): el deploy actual del agente corre en
  mock por diseño (`TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY` sin setear) — el agente MISMO tiene su
  propio fail-safe (`assertPayoutProviderSafe()`, `cashout-payout.ts:44-72`) que impide desembolso
  real sin key+readiness real, **independiente** de lo que haga `chaski-v2`. Esto es una segunda
  capa de seguridad money-path fuera del control de esta HU (defensa en profundidad ya existente).
- **Sin auth/paywall en el `invoke` route hoy** (confirmado leyendo `route.ts` de ambos agentes:
  cero middleware) — una llamada directa server-side desde `chaski-v2` a la URL del deploy es HOY
  técnicamente gratis y bypassea el modelo económico x402/fee-split del gateway `wasiai-a2a`
  (`PRICE_USDC=0.03` por invocación es el precio que se cobraría SI se invocara vía
  `/compose`/`/orchestrate` del gateway, no vía este endpoint directo). Ver Missing Inputs #1.

### Persistencia (CAS ya implementado, WKH-182)
- `LocalRepo.save()` (`persistence.ts:94-107`) YA tiene lock optimista con `version` +
  `ConcurrentModificationError` — el submit del payout a2a y el refund heredan este guard sin
  cambios (cada `execute()` de `ConfirmAndSend`/`TrackRemittance` sigue usando `repo.save()` tal
  cual).

## Acceptance Criteria (EARS)

- **AC-1**: WHERE `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` no está seteada o vale `"fallback"`, the
  system SHALL cablear `FallbackQuoteGateway`/`FallbackPayoutGateway` en `container.ts`
  (comportamiento actual, byte-idéntico a hoy — DEFAULT).
- **AC-2**: WHERE `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` vale `"a2a"`, the system SHALL cablear
  `A2aQuoteGateway`/`A2aPayoutGateway` (nuevos, `src/infrastructure/a2a/`) en `container.ts` en vez
  del fallback.
- **AC-3**: WHEN `A2aQuoteGateway.requestQuote()` se invoca, the system SHALL llamar server-side
  (vía una API route nueva de `chaski-v2`, `app/api/a2a/quote`) al contrato
  `POST /api/agents/remit-corridor-fx/invoke` del servicio `wasiai-remittance-agents` (URL
  server-only de `REMIT_AGENTS_BASE_URL`) y mapear el `{ result }` recibido al `Quote` del dominio.
- **AC-4**: WHEN `A2aPayoutGateway.submit()` se invoca, the system SHALL llamar server-side (vía
  `app/api/a2a/payout/submit`) al contrato `POST /api/agents/remit-cashout-payout/invoke`,
  propagando `idempotencyKey` SIN mutarlo y `kycVerificationId`, y SHALL mapear el `{ result }`
  recibido a `PayoutRecord`.
- **AC-5**: IF la respuesta del agente remoto (`quote` o `payout`) no es HTTP 200 o el body no
  matchea el shape esperado, THEN el adapter a2a SHALL propagar un error explícito (nunca
  silencioso, nunca un throw sin catch en el use-case) sin exponer PII (`beneficiary`) ni detalles
  internos al llamador.
- **AC-6**: WHEN el `PayoutRecord` recibido de `submit()`/`status()` trae `deliveredPen` no-nulo,
  the system SHALL validar, ANTES de transicionar a `settled`, que es consistente con
  `expectedReceivePen` dentro de la MISMA tolerancia usada por `assertReceiveConsistent`
  (`remittance.ts`), y IF diverge más allá de esa tolerancia THEN the system SHALL marcar
  `payout_failed` con razón `payout_amount_mismatch` (nunca `settled`).
- **AC-7**: WHEN `ConfirmAndSend` o `TrackRemittance` transicionan una remesa a `payout_failed` (por
  cualquier razón: gate de autoridad, expiry, error de submit, status failed, mismatch de AC-6), the
  system SHALL invocar inmediatamente un `RefundGateway.creditBack()` y, si resuelve,
  `Remittance.markRefunded()` en el MISMO `execute()` — ninguna remesa debe quedar huérfana en
  `payout_failed`.
- **AC-8**: the system SHALL implementar `LedgerRefundGateway` (adapter mock/ledger-only, CERO
  movimiento on-chain real) como el `RefundGateway` DEFAULT cableado en `container.ts`, con el gap
  de clawback real documentado explícitamente en código (comentario) y en este work-item (CD-8).
- **AC-9**: WHERE `NEXT_PUBLIC_EIP3009_ENABLED` no está seteada o vale `"false"`, the system SHALL
  preservar el comportamiento actual de `authorizePrincipal()` (firma `signMessage` simbólica,
  byte-idéntico a hoy — DEFAULT).
- **AC-10**: WHERE `NEXT_PUBLIC_EIP3009_ENABLED` vale `"true"` (y pasa el guard de AC-11), the
  system SHALL construir y firmar (`signTypedData`) una autorización `transferWithAuthorization`
  (EIP-3009) real para el contrato USDC de la chain resuelta por `resolveChain()`, dirigida a
  `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS`.
- **AC-11**: IF `NEXT_PUBLIC_EIP3009_ENABLED` vale `"true"` Y (`NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`
  no vale `"a2a"` O `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS` no está seteada), THEN the system SHALL
  fallar-loud en la construcción del `container` (throw explícito en `createContainer()`, NUNCA
  defaultear en silencio a un modo mixto inseguro).
- **AC-12**: the system SHALL documentar en `.env.example` las 4 variables nuevas
  (`NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`, `REMIT_AGENTS_BASE_URL`, `NEXT_PUBLIC_EIP3009_ENABLED`,
  `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS`) con sus defaults mock/off explícitos en el comentario.
- **AC-13**: the system SHALL cubrir con tests (nivel use-case/adapter, dobles inyectados — sin red
  real) `A2aQuoteGateway`, `A2aPayoutGateway`, `LedgerRefundGateway`, el flujo refund-on-failure
  (AC-7) y el guard fail-loud de AC-11, siguiendo el patrón de test ya existente
  (`confirm-and-send.test.ts`, `wallet.test.ts`).
- **AC-14**: WHEN `PayoutGateway.status()` se invoca sobre el adapter a2a, the system SHALL devolver
  el último `PayoutRecord` conocido (cacheado desde el `submit()` que ya resolvió el estado final),
  dado que `remit-cashout-payout` no expone hoy un endpoint de polling asíncrono separado —
  documentado como gap `[NEEDS CLARIFICATION]` de Fase A (ver Missing Inputs #4).

## Scope IN
- `src/infrastructure/a2a/gateways.ts` (nuevo) — `A2aQuoteGateway` + `A2aPayoutGateway`.
- `src/infrastructure/a2a/gateways.test.ts` (nuevo).
- `src/infrastructure/refund/ledger-refund-gateway.ts` (nuevo) — `LedgerRefundGateway`.
- `src/infrastructure/refund/ledger-refund-gateway.test.ts` (nuevo).
- `app/api/a2a/quote/route.ts` (nuevo) — proxy server-side a `remit-corridor-fx`.
- `app/api/a2a/quote/route.test.ts` (nuevo).
- `app/api/a2a/payout/submit/route.ts` (nuevo) — proxy server-side a `remit-cashout-payout`.
- `app/api/a2a/payout/submit/route.test.ts` (nuevo).
- `src/application/ports.ts` — nuevo port `RefundGateway` (`creditBack(...)`); `PayoutRecord`/
  `PayoutSubmit` NO requieren campos nuevos (ver F0).
- `src/application/use-cases/confirm-and-send.ts` — nueva dependencia `refund: RefundGateway`;
  wiring de AC-6 (reconciliación pre-`settled`) y AC-7 (refund-on-failure) en cada rama que hoy
  llama `markPayoutFailed`.
- `src/application/use-cases/confirm-and-send.test.ts` — cobertura nueva (extiende, no reemplaza,
  la suite de WKH-180/182).
- `src/application/use-cases/track-remittance.ts` — misma nueva dependencia `refund` + mismo
  wiring de AC-6/AC-7 en su rama `failed`.
- `src/application/use-cases/track-remittance.test.ts` — cobertura nueva.
- `src/composition/container.ts` — flag `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` (AC-1/AC-2), guard
  fail-loud EIP-3009 (AC-11), wiring de `refund` en `ConfirmAndSend`/`TrackRemittance`.
- `src/infrastructure/wallet.ts` — flag `NEXT_PUBLIC_EIP3009_ENABLED` (AC-9/AC-10): rama nueva de
  `signTypedData` `transferWithAuthorization` en `InjectedWallet`/`WalletConnectWallet`, sin tocar
  el path default (`signMessage`).
- `src/infrastructure/wallet.test.ts` — cobertura nueva del flag y el guard.
- `src/infrastructure/chain.ts` — SOLO si el Architect decide en F2 que necesita un helper
  `resolveUsdcAddress()` análogo a `resolveChain()` para el dominio EIP-3009 (a definir en F2, ver
  Missing Inputs #2).
- `src/test-support/fakes.ts` + `src/test-support/test-container.ts` — `FakeRefundGateway` nuevo,
  sin romper el harness RTL de WKH-185 (default sigue siendo el container 100% fallback).
- `.env.example` — 4 vars nuevas (AC-12).

## Scope OUT
- Movimiento real de USDC/fiat — PROHIBIDO en esta HU (CD-2). Ningún env var nuevo puede tener un
  default que mueva plata real.
- Credenciales/keys reales de TransFi (`TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY`) — viven en
  `wasiai-remittance-agents`, fuera de `chaski-v2` (CD-1), y son responsabilidad de Fase A.
- Clawback ON-CHAIN real (revertir una `transferWithAuthorization` ya settleada) — el
  `LedgerRefundGateway` de esta HU es ledger-only (AC-8); el clawback real es follow-up de Fase A.
- Un facilitator/relayer que consuma la firma EIP-3009 real y la settlee on-chain para Avalanche —
  no existe hoy (el facilitator del ecosistema solo confirma settle en Base Sepolia); fuera de
  scope, el flag de AC-10 deja la firma "lista pero sin destino de settlement".
- `A2aKycGateway` (llamar a `remit-kyc-validator`) — Chaski ya integra Didit directo (WKH-179/180,
  producción real); sería redundante y no está pedido en el ticket.
- Modificar `wasiai-remittance-agents` ni `wasiai-a2a` (CD-1) — incluye NO agregar un endpoint de
  polling/status al agente `remit-cashout-payout` (ver AC-14/Missing Inputs #4, es HU futura en ese
  repo).
- Rediseño de UI/copy para mostrar estados nuevos (`refunded`, mismatch) — solo wiring de datos; el
  diseño visual queda a criterio de una HU de UI separada.
- Hardcodear/decidir la dirección de contrato USDC real por chain — Missing Inputs #2.
- Decidir si el adapter a2a llama DIRECTO al agente o pasa por el gateway pagado `wasiai-a2a` — el
  Analyst propone DIRECTO por default (ver DT-1/Missing Inputs #1), el Architect puede revisarlo.

## Decisiones técnicas (DT-N)
- DT-1: el adapter a2a llama DIRECTO server-side a la URL de deploy de `wasiai-remittance-agents`
  (`REMIT_AGENTS_BASE_URL` + `/api/agents/<slug>/invoke`), NO a través del gateway pagado
  `/compose`/`/orchestrate` de `wasiai-a2a`. Justificación: (a) mismo patrón arquitectónico ya
  usado en `chaski-v2` para I/O externo — server route propia con la URL/key server-side
  (`DiditKycGateway`→`/api/kyc/*`, `HttpPayoutAuthorityGateway`→`/api/payout/validate`); (b) el
  `invoke` route de los agentes remit-* hoy no tiene auth/paywall, así que técnicamente es
  equivalente en seguridad; (c) evita depender del settlement x402 dentro de un flujo money-path
  que YA está gated por su propio flag mock/off — agregar una capa de pago real complicaría el
  scaffolding sin necesidad, dado que ambos servicios son del mismo team. Queda documentado como
  `[NEEDS CLARIFICATION]` no bloqueante (Missing Inputs #1) por si el Architect/founder prefiere
  el modelo de marketplace real desde el día uno.
- DT-2: el refund-on-failure (AC-7) se dispara SINCRÓNICAMENTE dentro del mismo `execute()` que
  detecta el `payout_failed` (no un cron/use-case separado) — cierra el gap de remesas huérfanas
  sin agregar orquestación nueva; mantiene el patrón "cada `execute()` deja la remesa en un estado
  terminal o explícitamente recuperable" ya usado en `ConfirmAndSend`.
- DT-3: `LedgerRefundGateway.creditBack()` es un NO-OP de negocio (no hay custodia real que
  revertir en modo mock — `authorizePrincipal()` no mueve fondos on-chain salvo que el flag
  EIP-3009 esté encendido, que a su vez requiere el payout REAL, gated) — solo produce un
  `refundTx` sintético documentado como ledger-only, análogo al patrón `FallbackWallet`
  (`0xdemo${...}`). El comentario de código debe ser explícito para que nadie lo confunda con un
  refund real en Fase A.
- DT-4: `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` controla AMBOS gateways (`quote` + `payout`) con un
  único flag (no dos flags independientes) — evita combinaciones inconsistentes (ej. quote real +
  payout mock, que rompería la garantía de "el `receive` que ves es el que confirmás").
- DT-5: `PayoutSubmit`/`PayoutRecord` (`ports.ts`) NO se modifican — el campo `kycPayoutAllowed`
  que exige `remit-cashout-payout` se sintetiza en `true` DENTRO del adapter a2a (no en el port),
  porque `ConfirmAndSend` ya garantiza esa invariante antes de llegar a `submit()` (WKH-180). Evita
  tocar la firma del port y el resto de sus consumidores (`fallback/gateways.ts`,
  `test-support/fakes.ts`).
- DT-6: el guard fail-loud de AC-11 vive en `createContainer()` (composition root), no en
  `wallet.ts` — mismo principio que el resto del proyecto ("la I/O y las decisiones de wiring no
  entran al dominio/adapter puro", DT-2 de WKH-180/182): el `container.ts` es el único lugar que
  conoce AMBOS flags simultáneamente.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/` — ni el demo live, ni `wasiai-a2a`,
  ni `wasiai-remittance-agents`. Esta HU es exclusivamente `chaski-v2/`.
- CD-2 (**CRÍTICA money-path**): PROHIBIDO habilitar movimiento real de USDC/fiat en esta HU.
  TODOS los adapters nuevos (a2a quote/payout, EIP-3009 signing, refund) SHALL quedar mock/off por
  DEFAULT. Ningún env var nuevo puede tener un valor default que mueva plata real ni que apunte a
  un endpoint/contrato de producción con capacidad de desembolso real.
- CD-3: OBLIGATORIO fail-loud (throw explícito en `createContainer()`) si
  `NEXT_PUBLIC_EIP3009_ENABLED="true"` sin que `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER="a2a"` — el
  adapter fallback NUNCA debe recibir una autorización EIP-3009 firmada de verdad (AC-11).
- CD-4: OBLIGATORIO fail-loud si `NEXT_PUBLIC_EIP3009_ENABLED="true"` sin
  `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS` seteada — no hay a quién dirigir el
  `transferWithAuthorization` (AC-11).
- CD-5: PROHIBIDO que el adapter a2a (o las API routes que lo respaldan) loguee o interpole
  `beneficiary.name`/`beneficiary.destination` (PII) en warnings/errores — mismo patrón ya
  establecido en `payout-authority-gateway.ts` (cero PII) y en el propio agente remoto
  (`remit-cashout-payout/invoke/route.ts`, que tampoco los ecoa).
- CD-6: OBLIGATORIO que la reconciliación (AC-6) sea PREVIA a `markSettled` y reuse la MISMA
  tolerancia que `assertReceiveConsistent` en `remittance.ts` — PROHIBIDO introducir una tolerancia
  nueva/distinta sin justificación explícita del Architect en F2.
- CD-7: OBLIGATORIO que toda transición a `payout_failed` (en `ConfirmAndSend` Y en
  `TrackRemittance`) dispare el refund-on-failure (AC-7) en el mismo `execute()` — PROHIBIDO dejar
  una remesa huérfana en `payout_failed` sin intentar el refund.
- CD-8: OBLIGATORIO documentar explícitamente (comentario de código + este work-item) que
  `LedgerRefundGateway.creditBack()` es ledger-only en esta HU — NO revierte ningún movimiento
  on-chain real. El clawback on-chain real es explícitamente Scope OUT / follow-up de Fase A.
- CD-9: PROHIBIDO que las nuevas API routes (`app/api/a2a/*`) expongan `REMIT_AGENTS_BASE_URL` (ni
  ninguna key futura) al cliente — mismo patrón server-only que `/api/payout/validate` y
  `/api/kyc/*`.
- CD-10: OBLIGATORIO que el `idempotencyKey` ya existente (`${remittanceId}:${quoteId}`,
  `confirm-and-send.ts:80`) viaje INTACTO hasta `CashoutPayoutInput.idempotencyKey` del agente
  remoto — PROHIBIDO regenerar/mutar la key en el adapter a2a.

## Missing Inputs
- `[NEEDS CLARIFICATION]` no bloqueante — **#1 (DT-1)**: ¿el adapter a2a debe llamar DIRECTO al
  `invoke` URL del deploy de `wasiai-remittance-agents` (gratis hoy, sin auth, bypassea el
  fee-split/x402 de `wasiai-a2a`) o pasar por el gateway pagado (`PRICE_USDC=0.03`/invocación,
  respeta el modelo económico del marketplace aunque sea el mismo team)? Propuesta default:
  DIRECTO (DT-1). No bloquea el scaffolding mock (cero plata real igual en ambos casos); el
  Architect puede revisarlo en F2.
- `[NEEDS CLARIFICATION]` no bloqueante — **#2**: dirección/contrato USDC exacto por chain
  (Avalanche 43114 mainnet / 43113 Fuji) para el dominio EIP-3009 de AC-10 — ¿constante
  hardcodeada (Circle canonical) o env var (`NEXT_PUBLIC_USDC_CONTRACT_ADDRESS`)? El flag está OFF
  por default (AC-9), así que no bloquea el scaffolding; el Architect lo resuelve en F2.
- `[NEEDS CLARIFICATION]` no bloqueante — **#3**: `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS` — no existe
  hoy ninguna wallet de custodia/partner en Avalanche (TransFi/partner es Fase A, founder). Hasta
  entonces no hay valor real que setear; el flag EIP-3009 seguirá inerte por el guard de CD-4
  incluso si alguien lo enciende sin esta variable.
- `[NEEDS CLARIFICATION]` no bloqueante — **#4 (AC-14)**: `remit-cashout-payout` no expone hoy un
  endpoint de polling/status asíncrono separado (resuelve todo en el `invoke`). Si TransFi real es
  asíncrono, el agente necesitaría un endpoint `/status` nuevo — eso es una HU futura EN
  `wasiai-remittance-agents` (CD-1 prohíbe tocarlo acá), no en `chaski-v2`.

## Análisis de paralelismo
- Trabaja sobre `main` post WKH-178/179/180/181/182/183/184/185 (todas DONE) — no reabre ninguno
  de esos gaps.
- No bloquea ni es bloqueada por ninguna HU viva de `chaski-v2` — el backlog 178-185 está 100%
  cerrado, sin HUs concurrentes hoy en este repo.
- Es la porción técnica de **WKH-168** (desembolso real): WKH-168 completo (con creds/sandbox
  TransFi reales) queda bloqueado hasta Fase A (founder/partner). Esta HU (WKH-186) deja el
  scaffolding listo para que WKH-168 real solo tenga que: (a) setear `TRANSFI_API_KEY`/
  `TRANSFI_ADAPTER_READY` en `wasiai-remittance-agents`, (b) flippear
  `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=a2a` en `chaski-v2`, (c) eventualmente
  `NEXT_PUBLIC_EIP3009_ENABLED=true` + `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS` cuando exista un
  facilitator real para Avalanche — sin re-arquitecturar `confirm-and-send.ts`/`ports.ts`/
  `container.ts` de nuevo.
- Coordina con `wasiai-remittance-agents` (repo separado, mismo team, ya con `remit-corridor-fx` y
  `remit-cashout-payout` live/deployados) — CD-1 prohíbe tocarlo en esta HU; el eventual endpoint
  de polling asíncrono (Missing Inputs #4) es HU futura en ESE repo, coordinada pero no incluida
  acá.
