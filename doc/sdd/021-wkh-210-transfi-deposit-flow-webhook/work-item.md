# Work Item — [WKH-210] Cerrar el loop async de TransFi: receptor de webhooks (fund_settled) sobre el ledger de WKH-207

## Resumen
Cierra el gap de confirmación asíncrona del value-delivery: un endpoint nuevo
(`app/api/webhooks/transfi/route.ts`) que recibe, verifica (HMAC fail-closed) y procesa
idempotentemente los webhooks de estado de TransFi (`asset_deposited` / `fund_settled` /
`fund_failed`), actualizando el `SettlementLedger` (WKH-207) para que una remesa cuyo principal
ya entró on-chain llegue a un estado terminal AUTOMÁTICO en vez de depender solo de
`reconcile-orphans` (`manual_review`). Sandbox/testnet (Base Sepolia) únicamente, cero plata real.

**Split explícito respecto de la HU original**: el envío no-custodial del USDC directo al
`depositAddress` de TransFi (`to=depositAddress` en la firma EIP-3009) queda **fuera de esta HU**
— ver DT-1 y la sección Missing Inputs. Esta HU es SOLO la mitad "recibir confirmación" del loop
async; la mitad "enviar directo, sin custodia" se recomienda como ticket separado.

## Sizing
- SDD_MODE: full (QUALITY, siempre en este proyecto)
- Estimación: **L**
- Branch sugerido: `feat/021-wkh-210-transfi-deposit-flow-webhook`

### Justificación del sizing y del split
F0 encontró que la HU tal como fue descrita (reorder no-custodial + webhook) es en realidad **dos
piezas de riesgo y blast-radius muy distintos**:

1. **Webhook receiver (esta HU, `WKH-210`)**: sigue el patrón YA establecido 3 veces en este
   repo (`attestation.ts`/`attestation-store.ts` para HMAC+single-use, `pop-nonce-store.ts` para
   claim-once, `reconcile-orphans/route.ts` para auth por secreto compartido). Es un endpoint
   NUEVO y AISLADO: no requiere tocar ningún guard-order existente. Riesgo bounded, tamaño **L**
   por la superficie nueva (auth entrante + idempotencia + extensión del port `SettlementLedger`),
   pero NO XL.
2. **Reorder no-custodial (`to=depositAddress`)**: al leer `wallet.ts:96-140` y
   `app/api/settle/principal/route.ts:59-68,112-151,177-185`, el receiver del settle HOY es un
   **único address estático de plataforma**, leído de una env **pública**
   (`NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS`, `chain.ts:86-90`) y usado en CUATRO puntos como
   invariante de seguridad fijo:
   - `wallet.ts:97` — el `to` que se firma (EIP-712) es siempre `resolveReceiverAddress()`.
   - `settle/principal/route.ts:144-146` (S12) — rechaza si el `to` firmado ≠ ese mismo env.
   - `settle/principal/route.ts:177-185` (V1-V9) — verifica ON-CHAIN que el log `Transfer` fue
     A ESE MISMO env (`expectedTo: receiver`), NUNCA al `to` del body.
   - `confirm-and-send.ts:177-191` (C5) — vuelve a comparar `res.to` contra
     `this.settlement.receiver` (mismo env, inyectado en el container).

   Convertir el receiver en un valor **dinámico por remesa** (el `depositAddress` que TransFi
   asigna por orden) rompe la premisa de las 4 verificaciones de arriba: ya no hay un env fijo
   contra el cual comparar — hace falta una fuente de verdad SERVER-SIDE, por `remittanceId`, de
   "cuál es el depositAddress correcto para ESTA orden" (si no, un atacante podría declarar
   cualquier `to` como "mi depositAddress" y el guard S12/V1-V9 lo aceptaría). Eso implica:
   - Un paso NUEVO, ANTES de `authorizePrincipal` (hoy paso 3 de `confirm-and-send.ts`): crear la
     orden en TransFi (server-side) y persistir `remittanceId → depositAddress` de forma confiable.
   - Un `WalletPort.authorizePrincipal` que reciba el `to` como parámetro (hoy lo resuelve
     internamente vía env, en AMBAS implementaciones reales — `InjectedWallet` y
     `WalletConnectWallet`).
   - Reescribir el guard S12/V1-V9 de `settle/principal/route.ts` para validar el `to` contra el
     depositAddress TRUSTED del `remittanceId` (lookup server-side), no contra un env fijo.
   - Un nuevo port (`PayoutOrderGateway` o similar) que separe "crear orden / obtener
     depositAddress" de "confirmar/forward del payout" — hoy `PayoutGateway.submit()` hace ambas
     cosas en un solo call.

   Esto es un cambio de **modelo de seguridad**, no una reordenación de dos llamadas. Y depende de
   un insumo que F0 **no pudo verificar** (ver Missing Inputs #1: WKH-208 no está en este
   workspace). Por eso el Analyst recomienda que el reorder se registre como un **ticket nuevo**
   con su propio F2 (SDD) + Adversarial Review dedicado — no debería colarse dentro de esta HU ni
   ser evaluado por el mismo AR que la del webhook.

## Grounding (F0) — hallazgos clave
- `src/application/use-cases/confirm-and-send.ts` (277 líneas): orquesta
  confirm→autoridad→expiry→`authorizePrincipal`→`settlement.gateway.settle()`
  (`settle/principal`)→`markPrincipalIn`→2º expiry check→`payouts.submit()`
  (`/api/a2a/payout/submit`). El orden es **settle primero, forward (payout) después** — el
  founder pide invertirlo para que el forward/orden de TransFi ocurra ANTES de firmar. Esto
  requeriría separar "crear orden" de "confirmar payout" en el `PayoutGateway`, ver arriba.
- `src/application/ports.ts:62-95` (`PayoutSubmit`/`PayoutRecord`/`PayoutGateway`): **NO existe
  ningún campo `depositAddress`** hoy. `PayoutRecord` tiene `payoutId, status, deliveredPen,
  txRef, failureReason, provenance` — nada más.
- `src/infrastructure/a2a/gateways.ts:19-36` (`RawPayoutResult`/`A2aPayoutGateway`): el shape
  crudo que se parsea del agente `remit-cashout-payout` tampoco tiene `depositAddress`.
- `src/infrastructure/wallet.ts:96-146,240-292`: el `to` de la firma EIP-3009 es SIEMPRE
  `resolveReceiverAddress()` (env estática), en ambas wallets reales.
- `app/api/settle/principal/route.ts`: guard-order S1-V9 completo, con S12 (`to` == env) y V1-V9
  (verificación on-chain contra el mismo env) como invariantes de seguridad centrales.
- `app/api/a2a/payout/submit/route.ts`: guards 1-8 (autoridad KYC → PoP opcional → atestación
  settlement). La atestación (`attestation.ts:15-23`) YA incluye un campo `to`, pero el submit
  route **nunca lo valida** (solo valida `att.from`, guard A7). Si el reorder llegara a
  implementarse, ese sería el punto natural para atar el payout al `depositAddress` correcto.
- `src/infrastructure/persistence/supabase-settlement-ledger.ts` (WKH-207, tabla
  `remittance_settlements`): `SettlementLedgerStatus` = `principal_in | submitted | settled |
  failed | forward_error | manual_review`. Métodos: `recordPrincipalIn` (por `settle`),
  `recordPayoutOutcome` (owner-scoped por `idempotencyKey`+`senderAddress`, usado por `submit`),
  `listStale`/`markOutcome` (usados por `reconcile-orphans`). **Ningún método está indexado por
  `payoutId` solo** — el webhook de TransFi necesita correlacionar por el `payoutId`/`orderId` que
  TransFi conoce, no por `idempotencyKey`+`senderAddress` (que el webhook no tiene).
- `app/api/admin/reconcile-orphans/route.ts`: patrón de referencia para auth por secreto
  compartido fail-closed (501 sin config, 401 si no matchea, timing-safe) + ledger flag-gated
  (`getSettlementLedger() === null` ⇒ 501).
- `src/infrastructure/settlement/attestation.ts` + `attestation-store.ts`: patrón de referencia
  para HMAC propio (`createHmac`/`timingSafeEqual`) — el webhook de TransFi es la operación
  INVERSA (verificar una firma AJENA sobre un payload ajeno, no emitir una propia).
- `src/infrastructure/auth/pop-nonce-store.ts`: patrón de referencia de claim-once atómico sobre
  Upstash — reusable para la idempotencia del `eventId` del webhook (DT-3).
- **`app/api/a2a/payout/submit/route.ts:244-248`** (MNR-1 heredado de la CR de WKH-209): el
  comentario del guard A7″ menciona `"Preview en Fuji + prod en mainnet"` — terminología de
  Avalanche que quedó stale desde que WKH-209 movió el settlement a Base (Sepolia 84532 / mainnet
  8453). Comentario únicamente, cero lógica — se agrega al Scope IN de esta HU (barrido barato).
- **No se encontró ningún archivo relacionado a TransFi en `chaski-v2`** (`Glob **/*transfi*` →
  vacío) ni un repo `wasiai-remittance-agents` en `/home/ferdev/.openclaw/workspace` (el agente
  `remit-cashout-payout`, según la nota de WKH-186 en `_INDEX.md`, vive en ESE repo externo, que
  no está presente en este workspace). No pude verificar la premisa "WKH-208 ya devuelve
  `depositAddress`" desde este repo — ver Missing Inputs #1 (BLOQUEANTE).

## Acceptance Criteria (EARS)

- AC-1: WHEN llega un POST a `/api/webhooks/transfi` sin `TRANSFI_WEBHOOK_SECRET` configurado en
  el server, the system SHALL responder `501` sin leer ni procesar el body (fail-closed, mismo
  patrón que `reconcile-orphans/route.ts:47-51`).
- AC-2: WHEN llega un POST a `/api/webhooks/transfi` con `TRANSFI_WEBHOOK_SECRET` configurado pero
  la cabecera de firma HMAC está ausente o no matchea (comparación timing-safe sobre el body
  CRUDO, no el JSON re-serializado), the system SHALL responder `401` sin mutar el ledger.
- AC-3: WHEN llega un webhook con firma válida y un `eventId` (o equivalente) ya procesado
  anteriormente, the system SHALL responder `200` de forma idempotente SIN volver a mutar el
  ledger (claim-once atómico, mismo patrón que `pop-nonce-store.ts`/`attestation-store.ts`).
- AC-4: WHEN llega un webhook con firma válida, `eventId` nuevo y `status: "fund_settled"` para un
  `payoutId` que existe en el ledger, the system SHALL actualizar esa fila a `status: "settled"`.
- AC-5: WHEN llega un webhook con firma válida, `eventId` nuevo y `status: "fund_failed"` para un
  `payoutId` que existe en el ledger, the system SHALL actualizar esa fila a `status: "failed"`
  con un `lastError` que sea un enum estable (nunca el motivo/mensaje crudo del payload de TransFi).
- AC-6: WHEN llega un webhook con firma válida, `eventId` nuevo y `status: "asset_deposited"` para
  un `payoutId` que existe en el ledger, the system SHALL actualizar esa fila a `status:
  "submitted"` (confirmación intermedia: el USDC llegó al `depositAddress`, TransFi aún no liquidó
  el payout local).
- IF el `status` del webhook no es ninguno de los tres reconocidos (`asset_deposited` /
  `fund_settled` / `fund_failed`), THEN the system SHALL responder `200` (ACK, para no generar
  reintentos infinitos de TransFi) SIN mutar el ledger (AC-7) — nunca inferir un estado terminal
  de un valor no reconocido.
- IF el `payoutId` del webhook no matchea ninguna fila del ledger, THEN the system SHALL responder
  `200` (ACK) SIN error 5xx y sin crear una fila nueva (AC-8) — un webhook de una orden ajena/de
  otro entorno no debe romper el endpoint.
- AC-9: the system SHALL NUNCA persistir ni loguear el body crudo del webhook ni ningún campo de
  beneficiario/PII — solo `eventId`, `status` (mapeado), `payoutId` y un `lastError` de tipo enum
  viajan al ledger (mismo criterio CD-7 de WKH-207).
- AC-10: WHILE `NEXT_PUBLIC_EIP3009_ENABLED` y `TRANSFI_ADAPTER_READY` permanecen en su valor
  default (OFF/ausente) en todos los entornos compartidos, the system SHALL mantener el flujo de
  demo/mock byte-idéntico a pre-HU (esta HU no altera `confirm-and-send.ts` ni `wallet.ts`).
- AC-11: the system SHALL correr exclusivamente contra Base Sepolia / sandbox de TransFi en tests
  y en cualquier ejecución no explícitamente autorizada por el founder — ningún test ni código de
  esta HU asume ni apunta a mainnet real.

## Scope IN
- `app/api/webhooks/transfi/route.ts` (NUEVO) — HMAC fail-closed + idempotencia + mapeo de status
  + update del ledger.
- `app/api/webhooks/transfi/route.test.ts` (NUEVO).
- `src/application/ports.ts:237-267` (interfaz `SettlementLedger`) — método aditivo nuevo, ej.
  `recordWebhookOutcome({ payoutId, status, eventId, error })`, indexado por `payoutId` (no
  owner-scoped como `recordPayoutOutcome`, ya que el caller autenticado es TransFi vía HMAC, no un
  browser de usuario).
- `src/infrastructure/persistence/supabase-settlement-ledger.ts:73-170` — implementación del
  método nuevo (`.eq('payout_id', ...)`, patrón `markOutcome` existente).
- `src/infrastructure/persistence/supabase-settlement-ledger.test.ts` — tests del método nuevo.
- `src/infrastructure/webhooks/webhook-event-store.ts` (NUEVO) — idempotencia claim-once sobre
  Upstash, mismo patrón que `src/infrastructure/auth/pop-nonce-store.ts`.
- `src/infrastructure/webhooks/webhook-event-store.test.ts` (NUEVO).
- `src/infrastructure/webhooks/transfi-hmac.ts` (NUEVO, o co-ubicado en `route.ts` si el Architect
  prefiere) — verificación HMAC-SHA256 sobre el body crudo, mismo espíritu criptográfico que
  `src/infrastructure/settlement/attestation.ts:36-38,68-73` pero INVERSO (verificar la firma de
  un tercero, no emitir la propia).
- **`app/api/a2a/payout/submit/route.ts:244-248`** — MNR-1: corregir el comentario stale
  "Fuji"/mainnet-Avalanche a terminología Base Sepolia (84532)/Base mainnet (8453). Comentario
  únicamente, CERO cambio de lógica/guard-order.
- `.env.example` — documentar `TRANSFI_WEBHOOK_SECRET` (server-only, sin `NEXT_PUBLIC_`).

## Scope OUT
- El reorder no-custodial (`to=depositAddress` en la firma EIP-3009) — ver DT-1, split explícito.
  NO se toca `src/infrastructure/wallet.ts` (ni `InjectedWallet` ni `WalletConnectWallet`), NI el
  orden de pasos de `src/application/use-cases/confirm-and-send.ts`.
- El guard-order de `app/api/settle/principal/route.ts` (S1-V9) — CERO cambios, salvo que una HU
  futura (el reorder) lo toque explícitamente.
- Los guards 1-8 de `app/api/a2a/payout/submit/route.ts` — CERO cambios, salvo el comentario
  puntual MNR-1 ya listado en Scope IN.
- Ningún nuevo port de "creación de orden TransFi" (`PayoutOrderGateway` o similar) — pertenece al
  reorder, no a esta HU.
- `wasiai-facilitator`, `wasiai-a2a`, `wasiai-v2`, `wasiai-remittance-agents` (repos externos) —
  ningún cambio; esta HU solo consume contratos ya publicados si existen.
- Ningún send on-chain real ni webhook disparado en vivo contra el sandbox real de TransFi — solo
  mockeado en tests. La ejecución en vivo (gateada, "la corre el founder") queda fuera del código
  que esta HU entrega.
- `NEXT_PUBLIC_EIP3009_ENABLED` y `TRANSFI_ADAPTER_READY` — no se encienden en ningún entorno
  compartido como parte de esta HU.
- Reconciliación automática de `manual_review` existente (WKH-207) — el webhook SOLO actualiza
  filas que aún NO llegaron a `manual_review`; no reintenta ni reclasifica filas ya marcadas
  `manual_review` por `reconcile-orphans` (ese es un scope distinto, deferred allá).

## Decisiones técnicas (DT-N)
- DT-1: **Split** — el reorder no-custodial queda diferido a un ticket nuevo (candidato: WKH-211,
  a confirmar por el orquestador), con su propio F2/SDD y Adversarial Review dedicado, dado el
  cambio de modelo de seguridad que implica (ver Sizing) y la dependencia no verificada de WKH-208.
- DT-2: `SettlementLedger` gana un método nuevo indexado por `payoutId` (no por
  `idempotencyKey`+`senderAddress` como `recordPayoutOutcome`), porque el webhook de TransFi no
  conoce ninguno de esos dos campos — solo conoce SU PROPIO `payoutId`/`orderId` y el `eventId`.
  El guard de autenticación (HMAC) reemplaza al ownership-scoping que protege al resto de las
  mutaciones del ledger.
- DT-3: Idempotencia vía claim-once (Upstash SET NX + TTL), mismo patrón que
  `pop-nonce-store.ts`/`attestation-store.ts`: fail-closed si Upstash está caído (503, nunca
  procesar sin poder garantizar exactly-once).
- DT-4: HMAC verificado sobre el **body crudo** (string, pre-`JSON.parse`) — Next.js App Router
  permite leer `req.text()` una sola vez; el handler debe leer texto primero, verificar, y RECIÉN
  ENTONCES `JSON.parse`. Cabecera asumida `X-Transfi-Hmac-Hash` (heredada del prompt del
  orquestador) — a confirmar contra la doc real de sandbox de TransFi en F2 (Missing Inputs #4).
- DT-5: Mapeo de status: `asset_deposited → submitted`, `fund_settled → settled`, `fund_failed →
  failed`; cualquier otro valor → no-op + ACK 200 (AC-7), nunca inferir estado terminal de un
  valor desconocido (mismo espíritu fail-closed que el guard NaN de WKH-198).
- DT-6: El comentario stale de `submit/route.ts:244-248` (MNR-1, heredado de la CR de WKH-209) se
  corrige en esta HU por bajo riesgo/alto valor (comentario únicamente, ningún cambio de guard).

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO encender `NEXT_PUBLIC_EIP3009_ENABLED` o `TRANSFI_ADAPTER_READY` en cualquier
  entorno compartido (local, preview, prod) como parte de esta HU.
- CD-2: OBLIGATORIO fail-closed en el webhook: sin `TRANSFI_WEBHOOK_SECRET` → 501; firma
  ausente/inválida → 401; NUNCA se lee/mapea el body de negocio antes de verificar la firma.
- CD-3: PROHIBIDO loguear o persistir el body crudo del webhook, o cualquier campo de PII —
  únicamente `eventId`/`status` mapeado/`payoutId`/`lastError` (enum) llegan al ledger.
- CD-4: OBLIGATORIO idempotencia atómica (claim-once) ANTES de mutar el ledger — dos deliveries
  del mismo `eventId` (TransFi reintenta webhooks agresivamente) jamás producen una doble mutación.
- CD-5: PROHIBIDO tocar el guard-order de `app/api/settle/principal/route.ts` (S1-V9) o los guards
  1-8 de `app/api/a2a/payout/submit/route.ts` en esta HU (salvo el comentario puntual DT-6).
- CD-6: PROHIBIDO implementar el reorder no-custodial (`to=depositAddress`) en esta HU — cualquier
  código que cambie `wallet.ts`, el orden de `confirm-and-send.ts`, o el guard S12/V1-V9 de
  `settle/principal/route.ts` queda fuera de scope (ver DT-1).
- CD-7: OBLIGATORIO que un `status` desconocido/no mapeado se ACK-ee (200) SIN mutar el ledger —
  jamás inferir `settled`/`failed` de un valor no reconocido explícitamente.
- CD-8: PROHIBIDO ejecutar o testear contra TransFi sandbox real / mainnet sin autorización
  explícita del founder ("gateado, lo corre él con `!`") — todo test de esta HU usa fixtures/mocks.

## Tabla de riesgo (money-path)

| Riesgo | Severidad | Mitigación |
|---|---|---|
| Webhook falsificado marca una remesa `settled` sin que el USDC haya llegado realmente | ALTA | HMAC fail-closed + timing-safe sobre body crudo (CD-2), secreto solo server-side (nunca `NEXT_PUBLIC_`) |
| Replay del mismo webhook (TransFi reintenta agresivamente en timeouts) duplica el update o deja el ledger en un estado inconsistente | MEDIA | Idempotencia claim-once por `eventId`, atómica, ANTES de mutar (CD-4/DT-3) |
| El reorder no-custodial se implementa apurado dentro de esta HU y rompe el guard S12/V1-V9 (el `to` deja de ser un valor server-trusted) | CRÍTICA si ocurriera | Diferido explícitamente a un ticket nuevo con su propio SDD/AR (DT-1/CD-6) |
| PII de TransFi (nombre/documento del beneficiario) llega en el payload del webhook y se loguea o persiste por error | MEDIA | CD-3: solo enum/ids al ledger, nunca el body crudo |
| Ledger deshabilitado (`SETTLEMENT_LEDGER_ENABLED` OFF) y el webhook responde 200 igual, ocultando silenciosamente que nada se persistió | BAJA | Decisión explícita a tomar en F2 (Missing Inputs #3): recomendado 501, mismo patrón que `reconcile-orphans` |
| Un `payoutId` de un entorno/red distinta (ej. preview vs prod) colisiona y contamina el ledger equivocado | BAJA-MEDIA | Igual que WKH-202/A7″: si se reusa el mismo `TRANSFI_WEBHOOK_SECRET` entre entornos, un webhook de sandbox podría validar en prod — documentar como riesgo operativo, no de código (mismo patrón ya documentado para `SETTLE_ATTESTATION_SECRET`) |

## Missing Inputs
- **[BLOQUEANTE F2]** No pude verificar, desde este workspace, que WKH-208 exista y devuelva
  `depositAddress`. El código de `remit-cashout-payout` vive (según la nota de WKH-186 en
  `_INDEX.md`) en el repo externo `wasiai-remittance-agents`, que NO está presente en
  `/home/ferdev/.openclaw/workspace`. Hoy, en `chaski-v2`, ni `PayoutRecord`/`PayoutSubmit`
  (`ports.ts:62-95`) ni `RawPayoutResult` (`gateways.ts:19-36`) tienen ningún campo
  `depositAddress`. Antes de que el Architect cierre el F2 del reorder (ticket separado, DT-1),
  se necesita confirmación humana de: (a) que WKH-208 está mergeado en `wasiai-remittance-agents`,
  (b) el shape exacto de la respuesta, (c) si existe un endpoint de "solo crear orden" distinto
  del submit actual.
- **[BLOQUEANTE, decisión de founder]** Confirmar el split (DT-1): ¿el reorder no-custodial se
  abre como ticket nuevo separado (recomendación del Analyst) o el founder insiste en que vaya
  dentro de esta misma HU pese al blast-radius documentado en Sizing?
- **[NO bloqueante, resolver en F2]** Comportamiento del webhook cuando `getSettlementLedger()` es
  `null` (flag OFF): ¿501 (mismo patrón que `reconcile-orphans`) o 200 no-op? Recomendación del
  Analyst: 501, por consistencia con el resto de los endpoints admin/system de este repo.
- **[NO bloqueante]** Confirmar el nombre exacto de la cabecera HMAC de TransFi
  (`X-Transfi-Hmac-Hash` es un supuesto heredado del prompt del orquestador, no verificado contra
  documentación real de TransFi sandbox) antes de que el Architect fije el contrato en F2.
- **[NO bloqueante]** Confirmar el identificador que el webhook usa para correlacionar con nuestro
  `payout_id` — ¿TransFi lo llama `id`, `orderId`, `transactionId`? Afecta el shape exacto del
  body que `route.ts` parsea.

## Análisis de paralelismo
- Esta HU **no bloquea** ninguna otra HU activa: es aditiva (endpoint nuevo + método nuevo del
  port `SettlementLedger`), no modifica ningún guard-order existente salvo el comentario puntual
  MNR-1 (DT-6).
- **No hay otra HU corriendo en paralelo sobre `chaski-v2` en este momento** (único analyst activo,
  según la convención ya establecida en `_INDEX.md` para WKH-202/168/206/205/207/209).
- El reorder no-custodial (ticket separado recomendado, DT-1) SÍ dependerá de esta HU en un
  sentido débil: reusará el mismo `SettlementLedger`/ledger table, y probablemente el mismo patrón
  de idempotencia (`webhook-event-store.ts`) si el reorder también necesita esperar confirmación
  async antes de marcar `settled`. Pero esta HU (WKH-210) no depende del reorder para completarse:
  puede mergear primero.
- Colisión de archivos: ninguna conocida. `submit/route.ts` recibe solo el cambio puntual de
  comentario (líneas 244-248) — si alguna otra HU futura toca ese mismo archivo en la misma
  ventana, coordinar por línea (riesgo bajo, ya visto con el patrón WKH-205/WKH-207).
