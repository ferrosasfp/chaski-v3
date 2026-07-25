# Work Item — [WKH-218] Chaski corre SOBRE los rieles A2A (no punto-a-punto)

## Resumen
Hoy Chaski (`chaski-v3`) llama a los agentes `remit-corridor-fx` (quote) y `remit-cashout-payout`
(payout) **punto-a-punto**: `app/api/a2a/{quote,payout/submit}/route.ts` hacen
`fetch(REMIT_AGENTS_BASE_URL + "/api/agents/<slug-hardcodeado>/invoke")` directo, sin pasar por el
gateway `wasiai-a2a` (sin discovery, sin `/compose`/`/orchestrate`, sin fee-split ni x402
aguas-abajo del gateway). Esta HU es la **keystone del pitch** del programa Solana LATAM Labs: hace
que Chaski enrute el quote + el payout a través del gateway (`POST /discover` + `POST /compose`,
DT-1) con una Agent Key propia, para que la tesis "Chaski es una app que corre SOBRE los rieles A2A"
sea cierta en código, no solo en el deck. Devnet/testnet, cero dinero real, código de producción.

## Sizing
- SDD_MODE: full (QUALITY, estructural — cambia el transporte del quote+payout core)
- Estimación: L
- Branch sugerido: `feat/033-wkh-218-chaski-sobre-rieles-a2a`

## Grounding (F0)

### Estado actual confirmado en código (chaski-v3)
- `app/api/a2a/quote/route.ts:28,32`: `BASE = process.env.REMIT_AGENTS_BASE_URL` (server-only,
  CD-9 ya vigente) → `fetch(`${BASE}/api/agents/remit-corridor-fx/invoke`)`. Slug **literal** en
  el string del path.
- `app/api/a2a/payout/submit/route.ts:366`: mismo patrón, `fetch(`${BASE}/api/agents/
  remit-cashout-payout/invoke`)`, pero DESPUÉS de un guard-order fail-closed de 8 pasos (autoridad
  WKH-180/202, PoP WKH-206/HU-SOL-8, atestación de settlement WKH-168) — el forward es el **último**
  paso (`L363-401`), los guards 1-8 son intocables (ver Scope OUT/CD-2).
- `src/infrastructure/a2a/gateways.ts` (`A2aQuoteGateway`/`A2aPayoutGateway`, cliente-side): llaman
  a las rutas propias de Chaski (`/api/a2a/quote`, `/api/a2a/payout/submit`) — estas NO cambian
  (siguen siendo el mismo contrato hacia el dominio); el cambio de transporte va DENTRO de las
  routes server-side.
- `src/composition/container.ts:71,84-85,89`: un solo flag `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`
  (`"fallback"`(default, mock) | `"a2a"`(punto-a-punto real)) cablea `quotes`+`payouts` juntos
  (DT-4 de WKH-186: evita quote-real+payout-mock mixto).
- `.env.example:100-115`: `REMIT_AGENTS_BASE_URL` documentada como server-only, sin `NEXT_PUBLIC_`,
  acoplada a `DIDIT_API_KEY` (nota operativa existente, no tocada por esta HU).
- No existe HOY ningún cliente de `wasiai-a2a` dentro de `chaski-v3` (`Glob src/infrastructure/a2a/`
  solo devuelve `gateways.ts` + sus tests, que hablan con las rutas propias, no con el gateway).

### Contrato real del gateway (wasiai-a2a, SOLO LECTURA — CD-1)
Verificado leyendo el código fuente (no inventado):
- `POST /discover` (`wasiai-a2a/src/routes/discover.ts:61-108`): body JSON
  `{ capabilities?: string|string[], q?: string, maxPrice?, minReputation?, limit?, registry?,
  verified?, includeInactive? }` → `discoveryService.discover(...)`, responde el shape de
  `DiscoveryResult` (lista de `Agent` con `slug`, `registry`, `payment`, `metadata`, etc. —
  `src/types/index.ts`, no releído campo-por-campo en este F0, el Architect debe confirmar el shape
  exacto de `Agent` en F2). Sin auth (`fastify.get/post` sin `requirePaymentOrA2AKey`).
- `POST /compose` (`wasiai-a2a/src/routes/compose.ts:337-643`): body `{ steps: ComposeStep[],
  maxBudget?: number }`, cada `ComposeStep = { agent: string, registry?: string, input: object,
  passOutput?: boolean }` (máx 5 steps, `compose.ts:373-379`). Requiere auth
  (`requirePaymentOrA2AKey`, `compose.ts:352-355`) — o Agent Key prepaga (`x-a2a-key`) o x402
  pay-per-call. `composeService.compose()` (`wasiai-a2a/src/services/compose.ts:104-...`) resuelve
  cada step vía `discoveryService`, liquida el pago x402/fee-split aguas abajo, invoca al agente
  real y devuelve `{ success, steps: StepResult[], totalCostUsdc, ... }`. El `input` de cada step se
  forwardea tal cual al agente resuelto (mismo shape que Chaski hoy arma para
  `/invoke`).
- `POST /orchestrate` (`wasiai-a2a/src/routes/orchestrate.ts`): goal-based con planning LLM
  (`{ goal: string, budget: number, ... }`) — **descartado** para esta HU (DT-1): Chaski ya sabe
  determinísticamente qué agente invocar (FX o payout), no necesita que un LLM interprete un
  `goal` en texto libre para un money-path KYC-gated (latencia/costo/no-determinismo
  innecesarios).
- Los agentes `remit-corridor-fx`/`remit-cashout-payout` (y `remit-kyc-validator`) están **YA
  registrados y facturables** en el marketplace A2A (confirmado por trabajo previo del ecosistema,
  registro gratis vía WKH-173 con `x-payment-chain: avalanche-fuji` — el código de registro/DB no
  vive en `chaski-v3` ni se pudo re-verificar en este F0 por no ser código, ver Missing Inputs #2).

## Acceptance Criteria (EARS)
- AC-1: WHEN el usuario solicita un quote de FX Y `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=a2a-gateway`
  está activo, the system SHALL resolver e invocar `remit-corridor-fx` a través de
  `POST {WASIAI_A2A_GATEWAY_URL}/compose` (single-step) en vez de `fetch` directo a
  `REMIT_AGENTS_BASE_URL`.
- AC-2: WHEN el payout pasa los 8 guards de autorización (autoridad/PoP/atestación, intactos) Y
  `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=a2a-gateway` está activo, the system SHALL invocar
  `remit-cashout-payout` a través de `POST {WASIAI_A2A_GATEWAY_URL}/compose` (single-step) en vez
  de `fetch` directo — el forward es el ÚNICO bloque que cambia de transporte.
- AC-3: WHEN Chaski necesita resolver el agente de FX o de payout bajo el modo `a2a-gateway`, the
  system SHALL consultar `POST /discover` del gateway (por `capabilities`, no por un slug
  hardcodeado 1:1) ANTES de armar el step de `/compose` — el mínimo aceptable del ticket original
  (discovery reemplaza el slug hardcodeado).
- AC-4 (estrella): IF `WASIAI_A2A_GATEWAY_URL` es inalcanzable (timeout/DNS/5xx) O `/discover` no
  resuelve ningún agente para la capability pedida, THEN el quote y/o el payout SHALL fallar
  fail-closed (502/503 opaco, mismo patrón `a2a_unavailable`/`a2a_upstream_error` ya vigente) SIN
  ningún fallback silencioso al punto-a-punto — apagar el gateway rompe el flujo (prueba de que
  Chaski depende del riel, no lo bypassea).
- AC-5: WHEN Chaski invoca un agente vía `/compose` bajo el modo `a2a-gateway`, the system SHALL
  dejar que el gateway resuelva el precio y liquide el pago/fee-split x402 aguas abajo — Chaski NO
  reimplementa ni firma el x402 del agente, solo autentica el `/compose` con su propia Agent Key
  server-only.
- AC-6: WHILE el flag `a2a-gateway` está OFF (default, o cualquier otro valor de
  `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`), the system SHALL preservar el comportamiento actual
  byte-idéntico (`fallback` mock o `a2a` punto-a-punto) — esta HU CONSTRUYE, NO ENCIENDE (mismo
  patrón que WKH-186/209/211/WKH-216).
- AC-7: the system SHALL leer la credencial del gateway (Agent Key / `WASIAI_A2A_AGENT_KEY`) y la
  `WASIAI_A2A_GATEWAY_URL` SOLO server-side (sin prefijo `NEXT_PUBLIC_`), y NUNCA loguearla ni
  ecoarla en un error.
- AC-8: WHEN Chaski forwardea el payout vía `/compose`, the system SHALL preservar
  `idempotencyKey` intacto en el `input` del step y NUNCA incluir el `beneficiary` (PII) en logs o
  mensajes de error (mismo patrón CD-5/CD-10 ya vigente en `submit/route.ts`).

## Scope IN
- `app/api/a2a/quote/route.ts` — nueva rama `a2a-gateway` (discover + compose), rama `a2a`
  (punto-a-punto) intacta.
- `app/api/a2a/payout/submit/route.ts` — SOLO el bloque de forward final (`L363-401` aprox.);
  guards 1-8 (`L73-333`) **NO se tocan** (CD-2).
- Nuevo: `src/infrastructure/a2a/gateway-client.ts` (o nombre que el Architect confirme) — helper
  server-only que encapsula `POST /discover` + `POST /compose` contra `wasiai-a2a`, con manejo de
  timeout/errores fail-closed (mismo patrón `AbortSignal.timeout(10_000)` ya usado).
- `.env.example` — documentar `WASIAI_A2A_GATEWAY_URL` (server-only), `WASIAI_A2A_AGENT_KEY`
  (server-only), 3er valor de `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` (`"a2a-gateway"`).
- Tests nuevos/actualizados: `app/api/a2a/quote/route.test.ts`, `app/api/a2a/payout/submit/
  route.test.ts`, `app/api/a2a/payout/guard8-intact.test.ts` (extender el test que ya prueba que
  los guards 1-8 no cambian), test del nuevo `gateway-client.ts`.

## Scope OUT
- `wasiai-a2a` (repo del gateway) — SOLO LECTURA, PROHIBIDO tocarlo (CD-1). Cualquier cambio de
  contrato HTTP del lado del gateway es un ticket cross-repo separado.
- `POST /orchestrate` — descartado por DT-1, no se usa.
- Guards 1-8 de `submit/route.ts` (autoridad, PoP, atestación de settlement) — intocables (CD-2).
- `src/infrastructure/a2a/gateways.ts` (cliente-side `A2aQuoteGateway`/`A2aPayoutGateway`) — su
  contrato hacia el dominio (`Quote`, `PayoutRecord`) NO cambia; siguen llamando a las rutas propias
  de Chaski, que son las que cambian de transporte internamente.
- WKH-233 (KYC vía agente A2A) — ticket hermano, F1 bloqueado, NO se resuelve ni se toca acá.
- Registro/aprovisionamiento de agentes Solana-native en el marketplace (WKH-235/236) — dependencia
  del e2e real, NO bloquea el código de esta HU (ver Missing Inputs #2 y nota de e2e).
- Cualquier cambio de `NEXT_PUBLIC_CHAIN_ID`/settlement del principal (Base/Solana) — ortogonal, el
  pago que liquida el gateway es el FEE del agente, no el principal de la remesa.
- Dinero real / mainnet — devnet/testnet, cero plata real (mismo guardrail del programa).

## Decisiones técnicas (DT-N)
- DT-1: usar `POST /compose` (single-step, determinístico) en vez de `POST /orchestrate` (LLM
  goal-based). Chaski ya sabe exactamente qué agente invocar; `/orchestrate` agregaría latencia,
  costo de LLM y no-determinismo innecesarios a un money-path KYC-gated. `/discover` se usa ADEMÁS
  (no en vez) de `/compose` para resolver el agente antes de armar el step (DT-2).
- DT-2: el `agent`/`registry` del step de `/compose` se resuelven dinámicamente vía `POST
  /discover` con un query por `capabilities` (ej. `fx-quote`/`cashout-payout`, nombre exacto a
  confirmar en F2 contra los `AgentCard` reales), NO un match hardcodeado 1:1 al slug string
  literal — cumple el mínimo aceptable del ticket original y evita que un rename/re-registro del
  agente rompa Chaski sin redeploy. Si `/discover` no resuelve ningún agente → fail-closed (AC-4),
  NUNCA fallback al slug hardcodeado anterior.
- DT-3: modelo de credencial = Agent Key prepaga propia de Chaski (`WASIAI_A2A_AGENT_KEY`,
  server-only, header `x-a2a-key`), NO el modelo x402 pay-per-call con firma de wallet — evita
  agregarle al sender una firma EIP-3009/ed25519 más (ya firma el principal de la remesa) y es
  simétrico al patrón server-only ya vigente (`REMIT_AGENTS_BASE_URL`, `FACILITATOR_API_KEY`,
  `SETTLE_ATTESTATION_SECRET`). Requiere aprovisionamiento founder-gated fuera de esta HU (Missing
  Input #1).
- DT-4: `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` gana un 3er valor `"a2a-gateway"` (además de
  `"fallback"|"a2a"` existentes), en vez de reemplazar `"a2a"` — permite rollout seguro: el modo
  punto-a-punto actual queda disponible como respaldo operativo explícito durante la transición
  (un solo flag sigue cableando quote+payout juntos, mismo invariante anti-mixto de WKH-186/DT-4).
- DT-5: el forward de `payout/submit/route.ts` cambia SOLO el bloque final (post guard 8); los
  guards 1-8 quedan byte-idénticos — el gateway se invoca DESPUÉS de que Chaski ya autorizó el
  payout, preservando los gates G1/G3/G5 del money-path.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar código de `wasiai-a2a` — solo lectura (ya se verificó el contrato real
  de `/discover`/`/compose` en este F0, sin inventar shape).
- CD-2: PROHIBIDO remover, reordenar o debilitar los guards 1-8 de `submit/route.ts` (autoridad
  WKH-202, PoP WKH-206/HU-SOL-8, atestación WKH-168) — esta HU es SOLO un cambio de transporte del
  forward final.
- CD-3: OBLIGATORIO que `WASIAI_A2A_GATEWAY_URL`/`WASIAI_A2A_AGENT_KEY` vivan SOLO server-side (sin
  `NEXT_PUBLIC_`), mismo patrón que `REMIT_AGENTS_BASE_URL` (CD-9 de WKH-186).
- CD-4: PROHIBIDO loguear o ecoar en cualquier response de error el `beneficiary`/PII o la Agent
  Key — mismo patrón CD-5 ya vigente, extendido al nuevo `gateway-client.ts`.
- CD-5: OBLIGATORIO fail-closed (502/503 opaco) ante cualquier error del gateway (timeout, DNS,
  5xx, `/discover` vacío) — CERO fallback silencioso al punto-a-punto cuando `a2a-gateway` está
  activo (es la evidencia de AC-4).
- CD-6: el default del flag (`a2a-gateway` NO seteado) SHALL dejar el comportamiento actual
  byte-idéntico — esta HU CONSTRUYE, NO ENCIENDE (mismo patrón WKH-186/209/211/WKH-216).
- CD-7: PROHIBIDO usar `/orchestrate` (LLM planning) para este money-path determinístico (DT-1).
- CD-8: el `idempotencyKey` viaja INTACTO dentro del `input` del compose step, nunca regenerado
  (mismo patrón CD-10 vigente).

## Missing Inputs
- [NO bloqueante para F2, BLOQUEANTE para el e2e real] #1: aprovisionamiento de la Agent Key
  (`WASIAI_A2A_AGENT_KEY`) de Chaski en el marketplace `wasiai-a2a` — crear/fondear la key
  (testnet/devnet) es una acción founder/ops-gated fuera de esta HU (mismo patrón que M5/
  RUNBOOK-M5.md de HU-SOL-11). El código puede implementarse y testearse íntegramente con el
  gateway MOCKEADO; el e2e real contra el gateway vivo requiere esta key.
- [NO bloqueante para F2] #2: nombre exacto de la(s) `capability(ies)` con la(s) que
  `remit-corridor-fx`/`remit-cashout-payout` están registrados en el marketplace (para el query de
  `/discover` de DT-2) — no se pudo verificar desde código (el registro es un dato de DB/publish
  API, no código fuente en ningún repo montado). El Architect debe confirmarlo contra el
  `AgentCard` real (vía un `GET /discover?q=remit-corridor-fx` manual o similar) antes de cerrar el
  SDD, o dejar el capability-query parametrizable por env como fallback seguro.
- [NO bloqueante para F2] #3: shape exacto del tipo `Agent`/`DiscoveryResult` que devuelve
  `/discover` (`wasiai-a2a/src/types/index.ts`, no releído campo-por-campo en este F0) — el
  Architect debe confirmarlo en F2 para tipar el `gateway-client.ts` sin `any` (CD-15 del propio
  `wasiai-a2a`, mismo estándar que ya sigue `chaski-v3`).
- [NO bloqueante] #4: el nombre final del env var / módulo (`WASIAI_A2A_GATEWAY_URL` vs
  `A2A_GATEWAY_URL`, `gateway-client.ts` vs otro nombre) es una propuesta del Analyst — el
  Architect puede renombrar en F2 sin impacto de diseño.

## Análisis de paralelismo
- Repo `chaski-v3` (según `_INDEX.md` completo): NO hay otra HU en F1/F2/F3 activa en este momento
  — único analyst corriendo. La última HU con F1 abierto (WKH-233, KYC vía agente) está
  **BLOQUEADA** para F2 pendiente de ratificación del founder, sin trabajo de código en curso.
- Coordinación con WKH-233 (hermana, NO bloqueante): esa HU también propone que Chaski componga un
  agente (`remit-kyc-validator`) vía A2A en vez de Didit directo, con su propio flag
  `NEXT_PUBLIC_KYC_ADAPTER` y su propio wiring en `container.ts`. Si WKH-233 se ratifica y corre en
  paralelo o después de esta HU, el `gateway-client.ts` que esta HU crea (discover+compose contra
  `wasiai-a2a`) es reusable por WKH-233 en vez de que esa HU cablee su propio cliente al agente KYC
  — recomendación no vinculante para el Architect de esa HU, a evaluar si el orden de ejecución lo
  permite. Sin overlap de archivos hoy (WKH-233 toca `app/api/kyc/*`/`authority.ts`, esta HU toca
  `app/api/a2a/*`) — riesgo BAJO, coordinar solo si ambas corren F3 en la misma ventana.
- Esta HU NO bloquea ninguna otra HU del backlog conocido; es aditiva y flag-gated (default OFF).
- Dependencia externa (no-código, no bloquea F2/F3): provisión de la Agent Key en `wasiai-a2a`
  (Missing Input #1) — solo bloquea el e2e real, no el desarrollo/testing con gateway mockeado.
