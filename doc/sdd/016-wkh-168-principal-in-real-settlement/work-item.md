# Work Item — [WKH-168] GATE Fase A / G3 — Principal-in real: que `principal_in` signifique que el USDC llegó

## Resumen

Hoy `principal_in` se marca inmediatamente después de que `authorizePrincipal` produce una
**firma** (`signTypedData`/`signMessage`), nunca una transacción transmitida — nadie hace
`waitForTransactionReceipt` en todo el repo (verificado: 0 ocurrencias). Esta HU cierra la mitad
NO bloqueada por TransFi del gate G3 de la Fase A: broadcastear la autorización EIP-3009 firmada,
esperar el receipt on-chain, y **verificar monto + receiver** antes de transicionar a
`principal_in`. Reusa el relayer auditado `wasiai-facilitator` (que ya tiene un adapter Avalanche
Fuji real, `WFAC-52`) en vez de escribir un settle nuevo en el money-path. Todo esto queda
**gateado por los flags existentes, off por default** — la HU construye, no enciende.

## Sizing

- SDD_MODE: full (QUALITY, override del orquestador — money-path)
- Estimación: **L** (ver "Qué cierra / Qué NO cierra" — se recomienda SPLIT, ver abajo)
- Branch sugerido: `feat/168-principal-in-real-settlement`

### Veredicto sobre el tamaño — recomiendo SPLIT

El HU original (según la pista del orquestador) mezcla dos problemas de naturaleza distinta:

1. **Settle real + verificación** (firmar → transmitir → esperar receipt → validar monto/receiver
   antes de `markPrincipalIn`). Es **testeable en testnet HOY**, self-contained dentro de
   `confirm-and-send.ts`/`wallet.ts`/un nuevo gateway de settlement, y **no requiere cambiar dónde
   vive el estado**. → **ESTA HU (WKH-168), tamaño L.**
2. **Persistencia server-side + reconciliación de huérfanos** (el problema real de "el usuario
   cierra la pestaña entre `principal_in` y `payout_submitted`"). Esto es un cambio arquitectónico
   (mover el repo de `localStorage` a algo server-side) **más un sweep/reconciliación** que hoy no
   existe ni siquiera en diseño — ver DT-2. Es su propia HU, candidata a **L/XL**, y **debería
   registrarse como HU nueva** (sugerido: siguiente NNN libre tras esta, ej. WKH-207) en vez de
   inflar esta.

**Por qué el split es seguro**: la Mitad A (esta HU) reduce el riesgo real del gate G3 — hoy un
atacante puede simular `principal_in` sin que el USDC exista; con esta HU, `principal_in` requiere
un receipt on-chain verificado. El problema de persistencia (huérfanos si se cierra la pestaña) es
un residual **distinto**, no nuevo (existe HOY con el mock; simplemente antes no importaba porque
nunca había dinero real de por medio). No hace que la Mitad A sea insegura por sí sola: si el
browser se cierra ANTES del receipt, la transición nunca ocurre (fail-closed, `confirmed` se queda
"colgado" pero sin plata movida salvo que la escritura de `principal_in` ya haya ocurrido — ver
AC-9/Missing Inputs).

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `NEXT_PUBLIC_EIP3009_ENABLED=true` y el usuario autoriza el principal, the system
  SHALL transmitir (`broadcast`) la autorización `transferWithAuthorization` firmada — no solo
  retener la firma — mediante un gateway de settlement dedicado.
- **AC-2**: WHEN el gateway de settlement devuelve un receipt minado, the system SHALL verificar
  que el `to` on-chain coincide con `resolveReceiverAddress()` y que el `value`/monto coincide con
  `quote.send.minor` **antes** de transicionar a `principal_in`.
- **AC-3**: IF el receipt indica una transacción revertida, O el monto/receiver no coincide, O el
  gateway de settlement devuelve error (incluyendo `CHAIN_UNAVAILABLE`, cap diario agotado,
  `OPERATOR_FUNDING_LOW`, timeout), THEN the system SHALL **NO** transicionar a `principal_in` y
  SHALL transicionar `confirmed → payout_failed` (reusando `failAndRefund` existente), dejando
  `principalTx` en `null`.
- **AC-4**: WHEN se alcanza `principal_in` en modo EIP-3009 real, the system SHALL persistir el
  **hash de transacción verificado on-chain** como `principalTx` — nunca la firma cruda.
- **AC-5**: WHILE `NEXT_PUBLIC_EIP3009_ENABLED` está unset/`false` (default), the system SHALL
  preservar el comportamiento byte-idéntico a pre-HU: `authorizePrincipal` devuelve el resultado
  simbólico de `signMessage`, `markPrincipalIn` se llama inmediatamente sin intentar broadcast.
- **AC-6**: IF una remesa alcanza `principal_in` en modo EIP-3009 real y luego transiciona a
  `payout_failed`, THEN the system SHALL registrar una marca/`failureReason`/log distinguible que
  indique que el refund automático (`LedgerRefundGateway`) es **ledger-only y NO revierte** el
  principal ya settleado — en vez de reusar en silencio el mismo camino que hoy es inofensivo
  porque el principal nunca se movió de verdad.
- **AC-7**: WHEN se transmite el settlement en modo EIP-3009 real, the system SHALL hacerlo desde
  una ruta server-side (nunca exponer credenciales del facilitador al cliente) que delega en el
  endpoint `/settle` auditado de `wasiai-facilitator` para la chain configurada, en vez de
  implementar lógica nueva de escritura on-chain/receipt en `chaski-v2`.
- **AC-8**: the system SHALL NO debilitar el guard fail-loud de `container.ts:56-61` (EIP-3009 on
  sin `adapter=a2a`/receiver/usdc → la app no arranca) como parte de esta HU.
- **AC-9**: the system SHALL documentar explícitamente (work-item + comentario inline en el nuevo
  gateway) que el riesgo de remesa huérfana entre `confirmed`/`principal_in` y el estado terminal
  por cierre de pestaña **NO** se cierra en esta HU (ver DT-2 y la HU de seguimiento recomendada).

## Scope IN

- `src/application/use-cases/confirm-and-send.ts` — insertar el paso de settle+verify entre la
  firma (`authorizePrincipal`) y `markPrincipalIn`, solo en rama EIP-3009 real.
- `src/infrastructure/wallet.ts` — ajustar el shape de retorno de `authorizePrincipal` en la rama
  real si el Architect decide que el settle necesita el payload EIP-3009 completo (no solo la
  firma) para reenviarlo al facilitador.
- `src/application/ports.ts` — nuevo port (nombre a definir en F2, ej. `PrincipalSettlementGateway`)
  con implementación real (llama a `wasiai-facilitator`) y fallback/fake (preserva AC-5).
- Nueva ruta server-only en `app/api/**` (patrón de `app/api/a2a/payout/submit/route.ts`) que
  reenvía al `/settle` de `wasiai-facilitator` — credenciales SIEMPRE server-side (CD-4).
- `src/composition/container.ts` — cablear el nuevo gateway (sin tocar el guard existente, AC-8).
- `src/infrastructure/refund/ledger-refund-gateway.ts` y/o `confirm-and-send.ts` — la marca de
  "refund no-real" de AC-6 (mínimo: enriquecer el `reason`/log, sin rediseñar refund).
- `.env.example` — documentar las env vars nuevas (server-only: `FACILITATOR_API_KEY`,
  `FACILITATOR_BASE_URL` o equivalente; ver DT-1) — **NUNCA** `NEXT_PUBLIC_`.
- `src/test-support/fakes.ts` / `src/test-support/test-container.ts` — fake del nuevo gateway.
- Tests correspondientes (ver Plan de tests).

## Scope OUT

- **Mitad B (payout USDC→PEN→Yape / TransFi)** — bloqueada por el sandbox del partner, queda tras
  `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=a2a` como está hoy.
- **Persistencia server-side del estado de la remesa** (mover `RemittanceRepository` fuera de
  `localStorage`) y **reconciliación de remesas huérfanas** — recomendado como HU de seguimiento
  (ver DT-2 y sección "Qué cierra / Qué NO cierra"). NO se decide ni se implementa acá.
- **Clawback on-chain real** (revertir un `transferWithAuthorization` ya settleado) — es
  técnicamente una transferencia inversa, requiere autorización del RECEIVER, no del sender.
  Confirmado imposible de resolver con el patrón actual de `RefundGateway`; declarado explícitamente
  fuera de scope (más allá de AC-6, que solo pide honestidad sobre el gap, no cerrarlo).
- Habilitar el payout real o los flags por default (CD-1).
- El demo del jurado (`chaski-ai.vercel.app`, `yarvis`, `agentshop-*`, `wasiai-agentshop`).
- El repo `wasiai-remittance-agents`.
- G5/WKH-206 (posesión criptográfica) — HU aparte.
- WKH-205 (follow-ups de WKH-202) — backlog separado de chaski-v2.
- Modificar código de `wasiai-facilitator` o `wasiai-a2a` — se consumen SOLO como servicios HTTP
  externos (CD-6).

## Decisiones técnicas (DT-N)

### DT-1 — Veredicto: REUSAR `wasiai-facilitator`, NO escribir un relayer nuevo

**Verificado en disco** (`/home/ferdev/.openclaw/workspace/wasiai-facilitator`):

- `src/methods/eip3009/settle.ts` es **DEAD CODE** (comentario explícito L1-17: "NOT wired into
  runtime"). El path LIVE es `src/chains/base-adapter.ts` (`BaseEip3009Adapter`), consumido por
  los adapters concretos (`src/chains/avalanche.ts`, `src/chains/kite.ts`, `src/chains/base.ts`).
- **`src/chains/avalanche.ts` YA tiene un adapter Avalanche real y auditado**:
  `avalancheFujiAdapter` (chainId 43113, **opt-in solo por env `AVALANCHE_FUJI_RPC_URL`**, "WFAC-52
  delivered full real EIP-3009 settle + verify against Fuji RPC") y `avalancheMainnetAdapter`
  (43114, opt-in doble: `AVALANCHE_MAINNET_ENABLED=true` + RPC URL). **Coincide exactamente** con
  las 2 chains que `chaski-v2/src/infrastructure/chain.ts:resolveChainId()` ya soporta (43113/43114)
  — no hace falta adapter nuevo del lado del facilitador.
- El endpoint público `POST /settle` (`src/routes/settle.ts`) ya tiene: auth por
  `FACILITATOR_API_KEY` (`requireFacilitatorKey`), idempotencia (Redis, cache + lock in-flight),
  cap diario por caller, **`payTo` allowlist** (`payto-allowlist.ts` — relevante: podríamos pedir
  al operador del facilitador que agregue nuestro `resolveReceiverAddress()` al allowlist),
  circuit-breaker por chain, ledger de auditoría, y devuelve `{settled, transactionHash,
  blockNumber, amount, from, to, asset}` — el shape exacto que necesita AC-2/AC-4.
- **Conclusión**: el settle real (simulate → write → waitForTransactionReceipt → check revert) YA
  está escrito, auditado (memoria: "relayer x402 propio (A+ auditado)") y coincide de chain.
  Escribir un segundo relayer en `chaski-v2` para la misma chain sería duplicar superficie de
  ataque en el money-path sin necesidad (CD-5). **Reusar >> reescribir.**

**Lo que SÍ falta resolver en F2** (no bloquea F1, son inputs para el Architect):
1. ¿El deploy corriente del facilitador (URL de prod/staging) tiene `AVALANCHE_FUJI_RPC_URL`
   configurada y el relayer fondeado en Fuji? (Precedente de memoria: gotchas de fondeo de gas en
   Kite/Base — Avalanche Fuji no verificado en esta sesión, es un `[NEEDS CLARIFICATION]`.)
2. ¿Chaski v2 obtiene un `FACILITATOR_API_KEY` propio, o comparte el existente? Impacto en
   `payTo` allowlist / daily cap / rate-limit por key.
3. ¿El payload que `wallet.ts` firma hoy (`TransferWithAuthorization` EIP-712) calza 1:1 con el
   `SettleRequestSchema` (Zod) de `wasiai-facilitator`? Verificar shape exacto en F2
   (`src/core/schemas.ts` del facilitador).
4. El facilitador expone el settle como **x402 flow** (`accepted`/`payload` shape) — confirmar en
   F2 si `chaski-v2` arma ese envelope server-side o si hace falta un adapter de traducción.

### DT-2 — Persistencia: 3 opciones, NO decidida acá (F2), pero con recomendación no-vinculante

El problema real: la orquestación de `ConfirmAndSend.execute()` corre **client-side**
(`presentation/flow.tsx` invoca `container.confirmAndSend.execute(...)`), y el repo persiste en
`localStorage` (`src/infrastructure/persistence.ts`). Si el usuario cierra la pestaña entre
`principal_in` (dinero YA en camino/settleado) y `payout_submitted`/`settled`, la remesa queda
huérfana **en el propio dispositivo** — nadie más puede verla ni completarla.

**Insight importante para el Architect**: mover SOLO el storage (localStorage → DB) **no alcanza**.
Mientras `ConfirmAndSend.execute()` sea una función que corre en el JS del browser, cerrar la
pestaña a mitad de un `await` aborta la ejecución sin importar dónde se lee/escribe el estado — el
código que dispararía el SIGUIENTE paso (submit del payout) simplemente nunca se ejecuta. Cerrar
el gap de verdad requiere **dos piezas**, no una:
1. Persistencia server-side (para que el estado sea recuperable/consultable desde cualquier lugar).
2. Un mecanismo que **reanude o resuelva** remesas huérfanas sin depender de que el mismo browser
   vuelva a abrir la pestaña (ej. cron/webhook de reconciliación server-side que consulta el
   facilitador por `transactionHash`/`payoutId` y completa o falla la remesa).

**Opciones evaluadas**:

| Opción | Pros | Contras | Nueva infra |
|--------|------|---------|-------------|
| **A. Upstash Redis** (chaski-v2 ya lo tiene cableado, hoy SOLO para rate-limit, `rate-limit.ts`) | Cero dependencia nueva; el shape de `RemittanceState` + CAS por `version` que `LocalRepo` ya implementa es prácticamente copiable 1:1 a un `UpstashRepo` (GET/compare-version/SET); rápido de implementar | KV puro — sin queries relacionales, sin transacciones multi-key reales (compare-and-swap emulado, no atómico entre múltiples remesas); no es el lugar natural para un cron de reconciliación con queries ("dame todas las `principal_in` de hace >10min") sin mantener índices manuales | Ninguna (env vars ya existen) |
| **B. Supabase de `wasiai-a2a`** | Postgres real (transacciones, RLS, queries por estado/fecha triviales); el patrón `owner_ref` + RLS + guard app-layer YA está documentado y probado ahí (ver `CLAUDE.md` de `wasiai-a2a`, `WKH-53`/`WKH-54`) | Choca literalmente con el guardrail de `chaski-v2/project-context.md`: "NUNCA tocar `wasiai-a2a`... desde este repo — Chaski v2 es standalone". Usar su DB como servicio externo (sin tocar su código) es una lectura posible pero ambigua — **requiere confirmación humana explícita**, no es una llamada del Analyst | Ninguna nueva, pero acopla dos proyectos operacionalmente (quién paga/administra esa DB para chaski-v2) |
| **C. Supabase/Postgres propio de `chaski-v2`** | Respeta 100% el guardrail "standalone"; Postgres real con transacciones/queries/reconciliación nativas; mismo patrón que `wasiai-a2a` ya validó (puede copiarse el diseño, no el proyecto) | Infra nueva (proyecto, credenciales, migraciones, RLS) — el mayor lift de las 3 opciones | Sí — proyecto Supabase nuevo |

**Recomendación no-vinculante**: para el ALCANCE de la HU de seguimiento (persistencia +
reconciliación), **Opción C** (Supabase propio) es la más alineada con los guardrails existentes y
con lo que ya se demostró funcionar en `wasiai-a2a` (mismo patrón `owner_ref`/RLS, reproducible).
**Opción A (Upstash)** es aceptable como paso intermedio/MVP si se prioriza velocidad sobre
queries de reconciliación robustas — dado que Upstash YA está cableado, es la opción de MENOR
fricción para arrancar, con el riesgo documentado de que el cron de reconciliación tendrá que
mantener sus propios índices manuales (ej. un set ordenado por timestamp de remesas no-terminales).
**Opción B queda descartada salvo decisión humana explícita** — viola la letra del guardrail
"standalone" tal como está escrito hoy.

**Esta decisión NO se toma en esta HU** (Scope OUT) — se documenta para que el Architect (F2 de la
HU de seguimiento) o el humano la resuelvan con este trade-off como input.

### DT-3 — Shape del nuevo port (no vinculante, propuesta para F2)

Algo como:
```ts
export interface PrincipalSettlementGateway {
  settle(input: {
    signedAuthorization: /* payload EIP-3009 completo, no solo el string de firma */;
    quote: Quote;
  }): Promise<
    | { ok: true; txHash: string; amount: string; to: string; from: string }
    | { ok: false; reason: string } // mapea CHAIN_UNAVAILABLE, INSUFFICIENT_BALANCE, etc.
  >;
}
```
El fallback/default (`NEXT_PUBLIC_EIP3009_ENABLED` off) NO debe instanciar este gateway — preserva
AC-5 sin tocarlo. El Architect decide el nombre exacto y si vive en `ports.ts` junto a `WalletPort`
o como port nuevo separado.

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO habilitar el payout real por default, o setear `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=a2a`
  / `NEXT_PUBLIC_EIP3009_ENABLED=true` en cualquier entorno como parte de esta HU. Los flags siguen
  off por default al terminar F3.
- **CD-2**: PROHIBIDO debilitar, remover o volver condicional el guard fail-loud de
  `src/composition/container.ts:56-61` (EIP-3009 on sin adapter=a2a/receiver/usdc → la app no
  arranca). Es una invariante money-path sagrada.
- **CD-3**: PROHIBIDO tocar el demo del jurado (`chaski-ai.vercel.app`, `wasiai-agentshop`, `yarvis`,
  `agentshop-*`, grant Team1).
- **CD-4**: PROHIBIDO exponer `FACILITATOR_API_KEY` (o cualquier credencial del facilitador) al
  cliente — SIEMPRE server-side, NUNCA con prefijo `NEXT_PUBLIC_`.
- **CD-5**: PROHIBIDO implementar un relayer/broadcast on-chain propio en `chaski-v2` sin que el
  Architect documente explícitamente en el SDD por qué NO se pudo reusar `wasiai-facilitator`
  (DT-1 establece que la reutilización es la opción por defecto).
- **CD-6**: PROHIBIDO modificar código de `wasiai-facilitator` o `wasiai-a2a` desde esta HU — se
  consumen ÚNICAMENTE como servicios HTTP externos (server-side fetch), nunca importando su código.
- **CD-7**: OBLIGATORIO — cualquier transición a `principal_in` en modo EIP-3009 real DEBE estar
  precedida por una verificación de monto Y receiver contra el receipt on-chain (AC-2); un receipt
  sin verificar NUNCA es suficiente.
- **CD-8**: PROHIBIDO decidir o implementar en esta HU el cambio de persistencia (localStorage →
  server-side) o la reconciliación de huérfanos — es Scope OUT explícito (DT-2), HU de seguimiento.

## Categorías de riesgo de seguridad (money-path — se mueve el PRINCIPAL, no fees)

| Riesgo | Descripción | Mitigación en esta HU |
|--------|-------------|------------------------|
| **R1 — Pérdida de fondos** | El sender firma/paga pero el sistema nunca confirma la llegada real → payout se dispara sobre dinero inexistente (el bug de fondo que motiva la HU) | AC-1/AC-2/AC-3: broadcast + receipt + verificación monto/receiver ANTES de `principal_in` |
| **R2 — Receipt no verificado** | Confiar ciegamente en `{settled:true}` del gateway sin chequear `to`/`amount` reales | AC-2 (verificación explícita, no solo `ok:true`) |
| **R3 — Leak de credencial** | `FACILITATOR_API_KEY` llega al bundle del cliente | CD-4 + patrón ya establecido (`REMIT_AGENTS_BASE_URL` server-only) |
| **R4 — Remesa huérfana** | Browser cerrado entre `principal_in` y terminal, plata movida sin resolución | **NO cerrado en esta HU** (AC-9, DT-2) — riesgo residual documentado, HU de seguimiento |
| **R5 — Refund engañoso** | `LedgerRefundGateway` reporta un `refundTx` sintético como si fuera una reversión real, una vez que el principal SÍ se movió de verdad | AC-6 (marca/log distinguible, no resuelve el clawback real) |
| **R6 — Fail-open del facilitador** | Circuit-breaker abierto / cap diario agotado / RPC caído interpretado como éxito | AC-3 (cualquier error del gateway → `payout_failed`, nunca `principal_in`) |

## Qué cierra / Qué NO cierra

**Cierra**:
- El bug de fondo: `principal_in` deja de significar "firmó" y pasa a significar "hay un receipt
  on-chain verificado con el monto y receiver correctos" (cuando el flag está ON).
- El G3 "de verdad" en el sentido de integridad de transacción: ya no es posible que un atacante
  reclame `principal_in` sin haber movido el USDC (dado que el flag está encendido — sigue OFF por
  default hoy).
- Reuso de infraestructura auditada en vez de superficie de ataque nueva (DT-1/CD-5).

**NO cierra**:
- La Fase A completa: **sigue bloqueada** por (a) Mitad B / TransFi (Scope OUT explícito de esta
  HU), (b) G5/WKH-206 (posesión criptográfica), (c) partners/legal (founder).
- El riesgo de remesa huérfana por cierre de pestaña (R4/DT-2) — requiere una HU aparte.
- El clawback real de un principal ya settleado (imposible con el patrón `RefundGateway` actual,
  requeriría autorización del receiver).
- Verificación de que el partner de payout (Mitad B) entrega lo prometido — eso ya lo cubre la
  reconciliación de WKH-186/AC-6, ortogonal a esta HU.

## Missing Inputs

- **[NEEDS CLARIFICATION, NO bloqueante para F2]** ¿El deploy corriente de `wasiai-facilitator`
  (URL a usar desde `chaski-v2`) tiene `AVALANCHE_FUJI_RPC_URL` configurada y el relayer fondeado
  en Fuji? Sin esto, AC-1 no es testeable end-to-end en testnet real (sí lo es con fakes/mocks,
  ver Plan de tests).
- **[NEEDS CLARIFICATION, NO bloqueante para F2]** ¿`chaski-v2` obtiene su propio
  `FACILITATOR_API_KEY`, o comparte uno existente del ecosistema? Impacta `payTo` allowlist y cap
  diario compartido.
- **[NEEDS CLARIFICATION, BLOQUEANTE para la HU de seguimiento, no para esta]** DT-2: cuál de las 3
  opciones de persistencia se adopta — requiere decisión humana (Opción B choca con el guardrail
  "standalone" tal como está escrito).
- **[TBD, resoluble en F2 leyendo el repo]** Shape exacto del `SettleRequestSchema` (Zod) del
  facilitador vs. lo que `wallet.ts` firma hoy — confirmar campo a campo.
- **[SIN PRODUCT CONTEXT]** No existe `product-context.md`. Contexto de negocio asumido (dado por
  el orquestador, no inventado): remesas USDC→PEN→Yape; sender cripto-nativo; los legs regulados
  los ejecutan partners licenciados; WasiAI es la capa de orquestación, no el money transmitter.

## Análisis de paralelismo

- **Ninguna HU corriendo actualmente en `chaski-v2`** (verificado en `_INDEX.md`: la última DONE es
  WKH-202, `015`). Sin riesgo de colisión de merge activa.
- **WKH-205** (follow-ups de WKH-202) y **WKH-206** (G5, posesión criptográfica) están **abiertas
  pero NO arrancadas** — no bloquean ni son bloqueadas por esta HU (tocan áreas distintas: WKH-206
  es de identidad/posesión, no de settlement).
- Esta HU **bloquea** (no puede cerrarse antes de) la HU de seguimiento de persistencia (DT-2): esa
  HU depende de que el settle real ya esté verificando monto/receiver, porque si se mueve la
  persistencia primero sin la verificación, se persiste con más confianza un dato que sigue siendo
  potencialmente falso.
- Esta HU **toca los mismos archivos** que WKH-186/WKH-202 (`confirm-and-send.ts`, `ports.ts`,
  `container.ts`, `wallet.ts`) — todas ya en `main`, sin overlap de HUs activas.
- No bloquea al demo (CD-3) ni a G5 (WKH-206, independiente).

## Plan de tests (≥1 por AC)

Cómo testear un settle on-chain sin cadena real: **inyectar un fake del nuevo
`PrincipalSettlementGateway`** (mismo patrón que `FakePayoutGateway`/`FakeRefundGateway` en
`test-support/fakes.ts`) que devuelve receipts sintéticos controlados por el test — análogo a como
`FakePayoutGateway` ya simula settle/status del payout sin HTTP real. Para la ruta API server-side
nueva (`app/api/**`), mockear `fetch` (patrón ya usado en `app/api/a2a/*/route.test.ts`) en vez de
llamar al facilitador real.

| AC | Test |
|----|------|
| AC-1 | Unit `confirm-and-send.test.ts`: con EIP-3009 on + fake settlement gateway, verificar que se invoca `settle()` con el payload firmado (no solo se guarda la firma). |
| AC-2 | Unit: fake gateway devuelve `{ok:true, to:"0xOTRO", amount:"400000000"}` (mismatch) → assert que `markPrincipalIn` NUNCA se llama y se transiciona a `payout_failed`. Caso positivo: `to`/`amount` correctos → `markPrincipalIn` se llama con el `txHash`. |
| AC-3 | Unit: fake gateway devuelve `{ok:false, reason:"CHAIN_UNAVAILABLE"}` / revert / timeout → `payout_failed`, `principalTx` sigue `null`, `failAndRefund` invocado. |
| AC-4 | Unit: assert `r.snapshot.principalTx === txHash` (el hash devuelto por el fake), no la firma cruda pasada como input. |
| AC-5 | Regresión: `NEXT_PUBLIC_EIP3009_ENABLED` unset → suite existente de `confirm-and-send.test.ts` (WKH-180/186/198) sigue 100% verde sin modificar sus asserts; el nuevo gateway NUNCA se instancia (spy en el constructor/factory). |
| AC-6 | Unit: seed remesa en `principal_in` (modo real simulado) → forzar `payout_failed` → assert que el `reason`/log contiene la marca de "refund no-real" (string estable, testeable). |
| AC-7 | Unit de la ruta API nueva (`app/api/**/route.test.ts`, mock de `fetch`): assert que el body/headers enviados al facilitador NO incluyen la credencial en la respuesta al cliente, y que el cliente (`gateways.ts` o similar) llama a la ruta propia, no directo a `wasiai-facilitator`. |
| AC-8 | Regresión: reusar los 6 tests existentes de `container.test.ts` sobre el guard — deben seguir pasando sin modificación de aserciones. |
| AC-9 | Revisión de código/documentación (CR): comentario inline presente en el nuevo gateway/port citando esta limitación; no requiere test automatizado (es un requisito documental). |

**Gate**: `npm run qa` (`tsc --noEmit` + `vitest run`) — recordar que NO hay `tsconfig.build.json`,
así que `tsc --noEmit` cubre tests también (precedente WKH-196, prohibido validar solo con
`npm run build`). Imports relativos en `app/api/**` (el alias `@/` no resuelve en vitest).
