# Work Item — [WKH-198] Fail-closed en expiry de quote — guard NaN + validación de shape de fecha

## Resumen
El guard de vencimiento del quote (`isQuoteExpired`, `src/domain/remittance.ts:257-259`) usa
`new Date(quote.expiresAt).getTime() <= new Date(nowIso).getTime()`. Si `expiresAt` es un string que
no parsea a fecha (basura devuelta por un agente, tampering de `localStorage`, tipo NO validado
aguas arriba), `getTime()` devuelve `NaN`, y **cualquier comparación `NaN <= x` es `false`** en
JavaScript — el quote **nunca vence**, anulando el control de FX rancio. En modo EIP-3009 real
(flag `NEXT_PUBLIC_EIP3009_ENABLED`), el mismo dato malformado hace que `wallet.ts:75` y `:189`
(`BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000))`) computen `BigInt(NaN)`, que lanza
`RangeError: The number NaN cannot be converted to a BigInt` **sin catch** al momento de firmar —
la remesa queda atascada en `confirmed` sin refund. Beneficiario: la integridad del money-path
(protección contra tasa FX vieja) y la resiliencia del flujo de firma real. Hallazgo A de la
auditoría adversarial #2 de `chaski-v2`.

## Sizing
- SDD_MODE: bugfix
- Estimación: S
- Pipeline: QUALITY (AR obligatorio — case type MONEY-PATH-INTEGRITY: el bug anula un control de
  negocio real, gate de expiry de quote, aunque no toca la autoridad de payout WKH-180 ni el gate
  de compliance `confirm_requires_kyc_passed`; el proyecto usa QUALITY siempre para `chaski-v2`, ver
  `doc/sdd/_INDEX.md`)
- Branch sugerido: fix/198-quote-expiry-fail-closed

## F0 — Grounding (código real verificado)

### Root cause confirmado
- `src/domain/remittance.ts:257-259`:
  ```ts
  private isQuoteExpired(quote: Quote, nowIso: string): boolean {
    return new Date(quote.expiresAt).getTime() <= new Date(nowIso).getTime();
  }
  ```
  Si `quote.expiresAt` no parsea (`Date.parse` → `NaN`), la comparación `NaN <= number` evalúa
  `false` en JS (toda comparación con `NaN` es `false` salvo `!=`) → el método devuelve `false`
  ("no expirado") para CUALQUIER `nowIso`, sin importar cuán en el futuro sea. Este método privado
  es la única fuente de verdad de vencimiento; lo consumen `attachQuote` (L213),
  `confirm` (L224) e `isQuoteStillValid` (L253-255, público) — el bug se propaga a las tres
  invariantes que dependen de "el quote sigue vigente".
- `src/infrastructure/wallet.ts:75` (`InjectedWallet.authorizePrincipal`) y `:189`
  (`WalletConnectWallet.authorizePrincipal`), rama `eip3009Enabled()` (flag OFF por default,
  WKH-186/AC-9):
  ```ts
  const validBefore = BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000));
  ```
  `Date.parse` no-fecha → `NaN`; `Math.floor(NaN)` → `NaN`; `BigInt(NaN)` lanza `RangeError`
  síncrono, no capturado por ningún `try/catch` en el llamador (`ConfirmAndSend`,
  `src/application/use-cases/confirm-and-send.ts`) — la promesa de `authorizePrincipal` rechaza,
  pero el estado del agregado ya puede estar en `confirmed` (transición previa) sin
  `principalTx`, sin camino de refund automático desde ese punto.

### Dónde se valida hoy el shape del quote (2 lugares, mismo gap en ambos)
- `app/api/a2a/quote/route.ts:12-23` (`isValidQuoteResult`, server-side proxy a
  `remit-corridor-fx`): valida `typeof v.expiresAt === "string"` — CUALQUIER string pasa,
  incluyendo `"no-es-fecha"`, `""`, `"NaN"`.
- `src/infrastructure/a2a/gateways.ts:42-53` (`isValidQuoteShape`, `A2aQuoteGateway` client-side):
  MISMO chequeo, mismo gap (`typeof v.expiresAt === "string"` sin validar que parsea).
- `src/infrastructure/fallback/gateways.ts:57` (`FallbackQuoteGateway.requestQuote`) construye
  `expiresAt` con `new Date(Date.now() + QUOTE_TTL_MS).toISOString()` — SIEMPRE válido, sin gap
  (el adapter fallback no es vector de este bug, pero tampoco es defensa: si el dominio confía en
  "el fallback siempre genera bien", el guard del dominio sigue roto para cualquier otro productor).
- Conclusión: hay 3 productores de `Quote.expiresAt` (`FallbackQuoteGateway` siempre válido,
  `A2aQuoteGateway`/`isValidQuoteShape` y el proxy server `isValidQuoteResult` sin validar
  parseabilidad) y 1 solo consumidor de la invariante de vencimiento (`isQuoteExpired`, dominio).
  El fix correcto es doble: (a) fail-closed en el consumidor (defensa de último recurso, cubre
  CUALQUIER productor presente o futuro, incluyendo `Remittance.rehydrate` desde `localStorage`
  potencialmente tampereado) + (b) rechazar en el borde de shape (evita que basura llegue siquiera
  a construirse como `Quote`).

## Acceptance Criteria (EARS)

- AC-1: IF `quote.expiresAt` no parsea a una fecha válida (`Number.isNaN(new
  Date(quote.expiresAt).getTime())`), THEN `isQuoteExpired` SHALL devolver `true` (tratarlo como
  EXPIRADO) — fail-closed, sin importar el valor de `nowIso`. Este comportamiento SHALL
  propagarse a los 3 consumidores existentes sin cambiar sus firmas: `attachQuote` (rechaza con
  `quote_expired`), `confirm` (rechaza con `confirm_quote_expired`), `isQuoteStillValid`
  (devuelve `false`).
- AC-2: WHEN `quote.expiresAt` parsea a una fecha válida y su timestamp es `<=` el timestamp de
  `nowIso` (también válido), the system SHALL tratar el quote como EXPIRADO (comportamiento actual,
  SHALL NOT regresionar).
- AC-3: WHEN `quote.expiresAt` parsea a una fecha válida y su timestamp es `>` el timestamp de
  `nowIso` (también válido), the system SHALL NOT tratar el quote como expirado (comportamiento
  actual, SHALL NOT regresionar).
- AC-4: IF el `result` recibido en `app/api/a2a/quote/route.ts` (`isValidQuoteResult`) o en
  `src/infrastructure/a2a/gateways.ts` (`isValidQuoteShape`) tiene `expiresAt` de tipo `string`
  pero que NO parsea a una fecha válida (`Number.isNaN(new Date(v.expiresAt).getTime())`), THEN
  ambos validadores SHALL rechazar el shape como inválido (mismo camino de error ya existente:
  `502 { error: "a2a_bad_shape" }` en la route, `throw new Error("a2a_quote_bad_shape")` en el
  gateway) — ANTES de que el valor llegue a construirse como `Quote` de dominio.
- AC-5: WHERE `NEXT_PUBLIC_EIP3009_ENABLED=true` (rama real de firma EIP-3009, `wallet.ts:75`/`:189`),
  IF el `expiresAt` del quote en curso no parsea a una fecha válida, THEN el sistema SHALL fallar
  con un error explícito y capturable (no un `RangeError` opaco de `BigInt(NaN)` propagado sin
  contexto) — defensa en profundidad para el caso en que un `Quote` malformado llegue a este punto
  por un camino distinto al de AC-4 (ej. `Remittance.rehydrate` desde un `localStorage` tampereado
  que bypasea la validación de shape del gateway).

## Scope IN
- `src/domain/remittance.ts` — método privado `isQuoteExpired` (L257-259): agregar el guard
  `Number.isNaN(...)` fail-closed. Sin cambios de firma pública; `attachQuote`, `confirm`,
  `isQuoteStillValid` heredan el fix sin modificarse.
- `src/domain/remittance.test.ts` — tests nuevos: `expiresAt` malformado → expirado (AC-1);
  `expiresAt` válido pasado → expirado (AC-2, ya cubierto probablemente, verificar no-regresión);
  `expiresAt` válido futuro → no expirado (AC-3, ya cubierto probablemente, verificar
  no-regresión).
- `src/infrastructure/a2a/gateways.ts` — `isValidQuoteShape` (L42-53): agregar el chequeo de
  parseabilidad de `expiresAt`.
- `src/infrastructure/a2a/gateways.test.ts` — test nuevo: `result` con `expiresAt` no-parseable →
  `A2aQuoteGateway.requestQuote` rechaza con `a2a_quote_bad_shape` (AC-4).
- `app/api/a2a/quote/route.ts` — `isValidQuoteResult` (L12-23): mismo chequeo de parseabilidad de
  `expiresAt`.
- (si existe o se agrega un test de route) test nuevo equivalente para AC-4 del lado server.
- `src/infrastructure/wallet.ts` — L75 y L189 (rama `eip3009Enabled()`): guard defensivo antes de
  `BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000))` (AC-5).
- `src/infrastructure/wallet.test.ts` — test nuevo (si el harness EIP-3009 ya existe en este
  archivo, ver F2) cubriendo AC-5 con `NEXT_PUBLIC_EIP3009_ENABLED=true` + `expiresAt` malformado.

## Scope OUT
- `src/infrastructure/fallback/gateways.ts` (`FallbackQuoteGateway`) — genera `expiresAt` siempre
  válido (`new Date(...).toISOString()`); no es vector de este bug, sin cambios.
- El resto del money-path: `assertReceiveConsistent`, `isDeliveredWithinReceiveTolerance`, el
  guard de monto lockeado (WKH-182) — sin cambios, fuera de scope.
- El enforcement del submit / autoridad server-side de payout (WKH-180,
  `payout-authority-gateway.ts`, `/api/payout/validate`) — es otra HU (**WKH-202**, mencionada en
  el brief), NO se toca acá.
- Los flags de payout / value-delivery (`NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`,
  `PAYOUT_ALLOW_MOCK`) — sin cambios.
- `src/domain/remittance.ts` `TRANSITIONS`, `confirm()` (invariantes de compliance/KYC) — solo se
  toca el guard interno de `isQuoteExpired`, ninguna transición ni gate adicional.
- El mecanismo de refund/recuperación de una remesa que quede `confirmed` sin `principalTx` tras un
  `RangeError` — AC-5 previene el `RangeError` crudo (fail loud con error capturable), pero el
  manejo de recuperación de ese estado intermedio (si `ConfirmAndSend` debe además intentar un
  refund automático) queda fuera de scope salvo que F2 determine que es trivial y ya cubierto por
  el flujo de error existente de `ConfirmAndSend`.

## Decisiones técnicas (DT-N)
- DT-1: El fix vive en 2 capas independientes y complementarias — (a) el dominio
  (`isQuoteExpired`) como última línea de defensa fail-closed, que protege incluso ante un `Quote`
  que llegó malformado por CUALQUIER camino (incluyendo `Remittance.rehydrate` desde
  `localStorage`); y (b) el borde de validación de shape (`isValidQuoteShape` /
  `isValidQuoteResult`), que rechaza el dato malo ANTES de que se construya un `Quote`. No son
  redundantes: (a) es defensa en profundidad, (b) es prevención en el borde. Ambas se implementan
  en la misma HU (ambas ya están señaladas en el hallazgo original).
- DT-2: El guard usa `Number.isNaN(...)` explícito (no `!Number.isFinite(...)` ni comparación con
  `=== NaN`, que siempre es `false` por definición de IEEE 754) — es el único chequeo correcto y
  estándar en JS/TS para detectar un `Date`/`getTime()` inválido.
- DT-3: El guard de `wallet.ts` (AC-5) es DEFENSIVO, no la corrección primaria — con AC-1 (dominio)
  y AC-4 (shape) ya instalados, un `Quote` con `expiresAt` malformado nunca debería llegar a
  `authorizePrincipal` en un flujo normal (habría fallado antes en `attachQuote`/`confirm`). AC-5
  cubre el caso residual de datos rehidratados que bypasean esas capas (tampering de
  `localStorage` post-`attachQuote`). El Architect decide en F2 el mecanismo exacto (early-return
  con error nombrado vs. re-uso de `isQuoteExpired` antes de firmar).
- DT-4: No se introduce un tipo `Quote` runtime-validado (branded type / parse-don't-validate
  completo) en esta HU — sería expandir scope más allá del hallazgo puntual de la auditoría. El fix
  es quirúrgico: 2 guards de `NaN` + 2 chequeos de shape, todos en los puntos exactos señalados por
  el hallazgo.

## Constraint Directives (CD-N)
- CD-1 (MONEY-PATH, CRÍTICA): OBLIGATORIO que `isQuoteExpired` trate CUALQUIER `expiresAt` (o
  `nowIso`) que no parsee a fecha válida como EXPIRADO — nunca como "no expirado". PROHIBIDO
  cualquier cambio que haga que una comparación con `NaN` resulte en "vigente".
- CD-2: PROHIBIDO modificar las firmas públicas de `attachQuote`, `confirm`, `isQuoteStillValid`
  o de `Quote`/`RemittanceState` — el fix es interno a `isQuoteExpired` y a los validadores de
  shape, sin tocar contratos existentes.
- CD-3: PROHIBIDO tocar `TRANSITIONS`, `confirm_requires_kyc_passed`, o cualquier invariante de
  compliance/KYC de `remittance.ts` — el scope es exclusivamente el guard de vencimiento del quote.
- CD-4: PROHIBIDO tocar `src/infrastructure/payout/payout-authority-gateway.ts`,
  `confirm-and-send.ts` (autoridad server-side WKH-180), o cualquier lógica de payout — es WKH-202,
  fuera de esta HU.
- CD-5: OBLIGATORIO que el chequeo de parseabilidad en `isValidQuoteShape` (`gateways.ts`) y en
  `isValidQuoteResult` (`quote/route.ts`) use la MISMA lógica (`Number.isNaN(new
  Date(v.expiresAt).getTime())`) que el guard del dominio — evitar que un mismo valor sea
  "válido" en un lado e "inválido" en el otro.
- CD-6: OBLIGATORIO agregar/actualizar tests en la MISMA HU (Scope IN) cubriendo explícitamente:
  `expiresAt` malformado (string no-fecha, ej. `"not-a-date"`), y verificar que
  quote-válido-pasado / quote-válido-futuro (comportamiento actual) NO regresiona.
- CD-7: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/` — no tocar `wasiai-a2a`,
  `wasiai-v2`, `wasiai-remittance-agents`, ni el demo (`yarvis`/`agentshop-*`).
- CD-8: PROHIBIDO introducir un `try/catch` silencioso en `wallet.ts` que trague el error de
  `expiresAt` malformado sin propagarlo — AC-5 exige fail LOUD (error explícito capturable por el
  llamador), no fail silent.

## Missing Inputs
- [TBD] Mecanismo exacto del guard defensivo en `wallet.ts` (AC-5/DT-3): ¿reusar una función
  exportada de `remittance.ts` (ej. exponer `isExpiresAtValid` puro) o duplicar el chequeo
  `Number.isNaN` localmente en `wallet.ts`? No cambia el comportamiento observable — el Architect
  decide en F2 según el patrón de dependencias existente (dominio→infra es la dirección permitida
  hoy; infra no debería importar lógica privada del dominio salvo que se exponga explícitamente).
- [TBD] Si existe o no un test-file dedicado para `app/api/a2a/quote/route.ts` (no se encontró uno
  en el grounding de F0) — si no existe, el Architect decide en F2 si esta HU lo crea (aunque sea
  mínimo, cubriendo solo AC-4) o si el chequeo se valida solo vía `gateways.test.ts`
  (`isValidQuoteShape`, misma lógica por CD-5) y el de la route queda cubierto por code review
  manual. No bloqueante — no cambia el fix de producción.

## Análisis de paralelismo
- Esta HU trabaja sobre `main` ya consolidado post-WKH-178..188 (ver `doc/sdd/_INDEX.md`, todas las
  HUs previas en estado DONE). No hay HUs abiertas en paralelo reportadas sobre `chaski-v2` al
  momento de este F1.
- Toca `src/domain/remittance.ts` (mismo archivo que tocaron WKH-182/187) y
  `src/infrastructure/wallet.ts` (mismo archivo que tocó WKH-186) — ambas HUs están DONE y
  mergeadas, sin colisión de merge esperada, pero el Architect debe leer el estado ACTUAL de esos
  archivos (post-WKH-186/187) antes de diseñar el fix exacto.
- Es una HU auto-contenida, de bajo riesgo y quirúrgica (2-3 archivos de producción, guards
  puntuales) — no bloquea ni depende de WKH-168 (desembolso real) ni de WKH-202 (enforcement del
  submit, hallazgo relacionado de la misma auditoría, explícitamente fuera de scope acá). Puede
  correr en paralelo con cualquier otra HU del backlog que no toque
  `remittance.ts`/`wallet.ts`/`gateways.ts`/`quote/route.ts` simultáneamente.
