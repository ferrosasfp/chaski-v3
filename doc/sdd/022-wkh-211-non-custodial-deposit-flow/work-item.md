# Work Item — [WKH-211] Value-delivery no-custodial: el USDC del sender va directo al `depositAddress` de TransFi

## Resumen
Cierra el principio no-custodial del founder ("WasiAI NUNCA custodia el USDC"): hoy el settle del
principal firma y transmite `transferWithAuthorization(to=RECEIVER_ESTÁTICO)`; esta HU reordena el
money-path para que el sender firme y transmita directo a un `depositAddress` que TransFi asigna
POR ORDEN, eliminando el paso intermedio por un receiver de plataforma. Es, literalmente, un cambio
del **modelo de seguridad** del invariante `to` que protege el settle desde WKH-168/186/209 — no una
reordenación de dos llamadas. Esta HU **construye y testea mockeado**; no mueve plata real ni crea
órdenes reales (gateado al founder).

## Sizing
- SDD_MODE: full (QUALITY, siempre en este proyecto)
- Estimación: **XL**
- Branch sugerido: `feat/022-wkh-211-non-custodial-deposit-flow`

### Justificación del sizing
F0 confirma y **amplía** lo que el F0 de WKH-210 ya había anticipado (ver `_INDEX.md` L241-272 y
`doc/sdd/021-wkh-210-transfi-deposit-flow-webhook/work-item.md` L31-63): el `to` de la firma
EIP-3009 es hoy un invariante de seguridad FIJO usado en 4 puntos independientes (ver Grounding).
Volverlo dinámico exige una fuente de verdad server-side nueva, no-falsificable, y toca el
`WalletPort`, ambas wallets reales, y el guard-order completo de `settle/principal`. Sizing **XL**
(no L) por dos hallazgos NUEVOS de este F0 que WKH-210 no pudo ver (no tenía acceso al repo del
agente):

1. **Dependencia cross-repo NO resuelta**: `remit-cashout-payout` (WKH-208, repo
   `wasiai-remittance-agents`, DONE 2026-07-17) agrega `depositAddress` al tipo INTERNO
   `PayoutResult` (`src/providers/types.ts:112-123`), pero el **output HTTP del agente**
   (`CashoutPayoutOutput`, `src/agents/cashout-payout.ts:50-59`) **NO lo expone** — el mapeo final
   (`cashout-payout.ts:248-257`) lo descarta silenciosamente, y la route
   (`src/app/api/agents/remit-cashout-payout/invoke/route.ts:21-22`) sólo devuelve lo que
   `runCashoutPayout` retorna. Verificado con `Read` de los 3 archivos. **`chaski-v2` no puede
   consumir `depositAddress` hasta que ese contrato HTTP cambie en el repo externo** — es trabajo
   fuera de este repo, bloqueante para el AC-1 de esta HU.
2. **Conflicto estructural con el gate G3 (WKH-168)**: el guard 8 de
   `app/api/a2a/payout/submit/route.ts:178-267` EXIGE una `settlementAttestation` (prueba de que el
   USDC YA entró on-chain) **ANTES** de forwardear al agente que crea la orden TransFi (y por ende,
   antes de poder obtener el `depositAddress`). El reorder exige llamar al agente **ANTES** de que
   exista esa atestación (para conseguir el `depositAddress` antes de firmar) — es decir, el mismo
   endpoint que hoy exige "la plata ya entró" tendría que dejar de exigirlo para el caso de "todavía
   no firmé". Esto NO es ajustable con un flag: el submit actual y el "prepare" que esta HU necesita
   son, por diseño, dos operaciones con reglas de gate DISTINTAS y potencialmente el mismo call
   subyacente al agente (`runCashoutPayout` hace KYC-gate + creación de orden TransFi en un solo
   paso — no hay endpoint separado de "solo crear orden" en el agente hoy). Ver Grounding y Tabla de
   riesgo.

Ambos hallazgos son señales de que el blast-radius real es MAYOR al que la HU original (y el propio
WKH-210) estimaron. El Analyst recomienda que el Architect evalúe en F2 si conviene un split
adicional (ver DT-1 y Missing Inputs), pero el work-item se entrega como una única HU (WKH-211) por
instrucción explícita del orquestador.

## Grounding (F0) — hallazgos clave, todos verificados con Read

### Los 4 puntos del invariante `to`/receiver ESTÁTICO (chaski-v2)
1. **`src/infrastructure/wallet.ts:96-140` (`InjectedWallet.authorizePrincipal`) y `:240-292`
   (`WalletConnectWallet.authorizePrincipal`)** — el `to` que se firma (EIP-712
   `TransferWithAuthorization`) es SIEMPRE `resolveReceiverAddress()` (línea 97 y 251), leído de
   `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS` (env pública). Ambas implementaciones reales duplican la
   misma lógica byte-a-byte (nonce determinístico, domain EIP-712 por red, etc.) — cualquier cambio
   se hace en LAS DOS.
2. **`app/api/settle/principal/route.ts`** — S12 (líneas 144-147): `isAddressEqual(to, receiver)`
   rechaza si el `to` firmado ≠ env. V1-V9 (líneas 174-185): `verifySettlementOnChain({ ...,
   expectedTo: receiver })` verifica ON-CHAIN que el log `Transfer` del USDC fue A ESE MISMO env —
   **nunca al `to` del body** (comentario explícito línea 180: "CD-9: env, NO el `to` del body").
   Este es el guard MÁS FUERTE de los 4: compara contra la cadena real, no contra una firma.
3. **`src/application/use-cases/confirm-and-send.ts:177-191` (C5)** — vuelve a comparar `res.to`
   (hecho de la cadena, devuelto por el verificador) contra `this.settlement.receiver` (mismo env,
   inyectado en el container — línea 42 documenta por qué está ACOPLADO al gateway y no es un
   parámetro opcional suelto: evitar el fail-open silencioso de un `receiver?: string` undefined).
4. **`src/infrastructure/chain.ts:81-90` (`resolveReceiverAddress`)** — única fuente del literal:
   lee `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS`, fail-loud (`isAddress`) si falta o está malformada.

### Dónde el `depositAddress` NO entra hoy (confirmado, no solo "no encontrado")
- `src/application/ports.ts:62-95` (`PayoutSubmit`/`PayoutRecord`/`PayoutGateway`) — sin campo
  `depositAddress`.
- `src/infrastructure/a2a/gateways.ts:19-36,57-70,85-94` (`RawPayoutResult`,
  `isValidPayoutShape`, `mapResultToPayoutRecord`) — el shape crudo que se parsea NO incluye
  `depositAddress`; agregarlo requiere extender el type guard Y el mapeo.
- `src/infrastructure/fallback/gateways.ts:95-118` (`FallbackPayoutGateway`) — el mock no produce
  ningún `depositAddress` (ni falta, porque el demo sigue byte-idéntico con flags OFF).
- **Lado del agente** (`wasiai-remittance-agents`, repo externo, SÍ presente en el workspace):
  - `src/providers/types.ts:112-123` — `PayoutResult.depositAddress: string | null` YA EXISTE (WKH-208/DT-4, aditivo). `null` en el fallback y en `status()`.
  - `src/providers/payout.ts` — `TransFiPayoutProvider.execute()` (real) captura el `depositAddress`
    de la respuesta `POST /v3/orders` (parseo defensivo, `TODO(sandbox)` para el nombre JSON exacto —
    smoke AC-4 de WKH-208 aún pendiente, gateado al founder).
  - `src/agents/cashout-payout.ts:50-59` (`CashoutPayoutOutput`) y `:248-257` (mapeo de retorno) —
    **NO incluyen `depositAddress`**. Se descarta entre `provider.execute()` y el retorno del
    agente. Confirmado con Read íntegro del archivo.
  - `src/app/api/agents/remit-cashout-payout/invoke/route.ts:21-22` — devuelve
    `{ result: runCashoutPayout(...) }` tal cual; hereda la omisión de arriba.
  - **Conclusión**: el `depositAddress` existe en el provider interno pero está atrapado — no sale
    del agente por HTTP. Es un gap real en `wasiai-remittance-agents`, no una ausencia de wiring en
    `chaski-v2`. Ver Missing Inputs #2 (BLOQUEANTE).

### El patrón de attestation existente (WKH-168) como exemplar del binding
- `src/infrastructure/settlement/attestation.ts` (`issueSettlementAttestation`/
  `verifySettlementAttestation`) — HMAC-SHA256 sobre un payload base64url
  (`{txHash,chainId,valueMinor,from,to,quoteId,exp}`), `node:crypto`
  (`createHmac`/`timingSafeEqual`), secreto leído DENTRO de la función (`SETTLE_ATTESTATION_SECRET`,
  nunca top-level), TTL 15 min, verificación timing-safe longitud-primero. Emitida en
  `settle/principal/route.ts:189-199` SOLO después de V9 (verificación on-chain real) y consumida en
  `submit/route.ts` guard 8 (A1-A9, líneas 178-267): single-use vía `claimAttestationOnce`
  (Upstash `SET NX`), ata monto (A6)/pagador (A7)/quote (A7′)/cadena (A7″).
- **Por qué es el exemplar correcto para el binding del `depositAddress`, pero insuficiente tal
  cual**: la atestación actual PRUEBA algo que YA PASÓ en la cadena (post-hoc). El binding que esta
  HU necesita es DISTINTO en naturaleza: debe atestiguar algo que el SERVER decidió ANTES de que
  exista ninguna transacción (`remittanceId → depositAddress` es una decisión de negocio de TransFi
  en el momento de crear la orden, no un hecho verificable on-chain). El mismo mecanismo
  criptográfico (HMAC propio, `node:crypto`, TTL corto, claim-once) es reutilizable; el CONTENIDO y
  el MOMENTO de emisión son otros. Ver DT-2/DT-3 y las opciones A/B/C abajo.

### El orden actual (`confirm-and-send.ts`, líneas 83-276)
`confirm()` → autoridad KYC server-side (WKH-180) → re-check de expiry (M2) →
**`wallet.authorizePrincipal()` (firma, `to`=receiver estático)** →
**`settlement.gateway.settle()` (`/api/settle/principal`, BROADCAST+VERIFY+ATTEST)** →
`markPrincipalIn` → 2º re-check de expiry → **`payouts.submit()` (`/api/a2a/payout/submit` →
agente, EXIGE la atestación del paso anterior)**. El reorder que pide la HU invierte los pasos 3 y 4:
el forward al agente (que hoy crea la orden TransFi como efecto colateral de `submit`) tendría que
ocurrir ANTES de la firma — pero el guard 8 de `submit/route.ts` hace IMPOSIBLE llamarlo sin una
atestación que, por construcción, no puede existir todavía. Este es el "conflicto estructural con
G3" del Sizing.

## La decisión que hay que plantear al founder (binding del `depositAddress`)

El `to` deja de ser un env fijo comparable byte-a-byte; pasa a ser un valor **dinámico, por orden,
que solo TransFi conoce**. El vector central que ataca el AR de esta HU es: *¿cómo evita el sistema
que un caller inyecte un `depositAddress` arbitrario (el suyo propio, o el de un tercero) y desvíe
el USDC del sender?* Tres enfoques, con trade-offs:

- **A) `depositAddress` atestado server-side (HMAC), mismo patrón que `attestation.ts`**: el server
  firma `{remittanceId, quoteId, depositAddress, chainId, exp}` inmediatamente después de crear la
  orden TransFi (o de recibir el `depositAddress` de un endpoint de creación). El guard S12/V1-V9
  reescrito verifica esa atestación (HMAC válido + `remittanceId`/`quoteId` coinciden + no vencida)
  ANTES de aceptar `to=depositAddress`, en vez de comparar contra el env fijo. El caller nunca puede
  inyectar un `to` propio porque no puede forjar el HMAC. **Trade-off**: requiere que el server haya
  llamado a TransFi (o al agente) para obtener el `depositAddress` ANTES de que el cliente firme —
  exige el endpoint nuevo de la opción B.
- **B) Endpoint nuevo `/api/payout/prepare` (o similar) que crea la orden y devuelve el
  `depositAddress` atestado, ANTES del settle**: re-usa los guards de autoridad KYC (2-6 de
  `submit/route.ts`, SIN el guard 8/atestación de settlement, que no aplica todavía) para invocar al
  agente (una vez que exponga `depositAddress`, Missing Inputs #2), y emite la atestación de la
  opción A sobre el resultado. El flujo cliente pasaría a ser: confirm → autoridad KYC → **prepare
  (nuevo)** → firma (`to`=depositAddress atestado) → settle (ahora verifica CONTRA la atestación de
  prepare, no contra un env) → **submit** (con una NUEVA semántica: ya no crea la orden, solo
  confirma/reconcilia — o se fusiona con `prepare` si el agente soporta reintentos idempotentes por
  `idempotencyKey`/`partnerId`). Es la combinación natural de A + el reorder real.
- **C) Otra que el Architect evalúe mejor** (ej.: firma delegada por el propio TransFi de un mensaje
  EIP-712 con el `depositAddress`, sin pasar por un HMAC propio — más fuerte criptográficamente pero
  depende de que TransFi exponga esa capacidad, no confirmado en la spec leída por WKH-208).

**Riesgo nuevo que ninguna de las tres opciones resuelve sola** (ver Tabla de riesgo): crear la
orden TransFi ANTES de que el USDC se haya movido significa que un `prepare` exitoso seguido de un
`settle` fallido (wallet rechaza firmar, red cae, el quote vence entre `prepare` y la firma) deja una
**orden TransFi real, con `depositAddress` real, esperando fondos que nunca llegan** — un vector
operativo que HOY NO EXISTE (hoy solo se crea la orden después de que el principal ya está
verificado adentro). Hace falta una política de expiración/cancelación de esas órdenes huérfanas
(fuera del alcance de lo que TransFi confirmó a WKH-208; a verificar en F2/sandbox).

**Marcado `[NEEDS CLARIFICATION] BLOQUEANTE para F2`** — el founder debe validar el enfoque (A/B/C)
y estar consciente del riesgo de órdenes huérfanas antes de que el Architect diseñe el SDD.

## Acceptance Criteria (EARS)

- AC-1: WHEN el flujo de settle real está habilitado (`NEXT_PUBLIC_EIP3009_ENABLED=true` Y
  `TRANSFI_ADAPTER_READY=true`, ambos OFF por default), the system SHALL firmar y transmitir la
  autorización EIP-3009 con `to` igual al `depositAddress` atestado server-side para ESA remesa
  (`remittanceId`), NUNCA al `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS` estático.
- AC-2: WHEN el server emite el binding del `depositAddress` (HMAC/atestación, cualquiera sea el
  enfoque A/B/C confirmado en F2), the system SHALL producir un token no-falsificable sin el secreto
  server-side, atado a `remittanceId` + `quoteId` + `chainId` + una expiración corta (mismo estándar
  que `SettlementAttestation`, TTL ≤ 15 min).
- AC-3: IF un caller intenta que la wallet firme o que `settle/principal` acepte un `to` que NO
  coincide con el `depositAddress` atestado para ESE `remittanceId`/`quoteId` (inyectado, de un
  tercero, o reciclado de otra orden), THEN the system SHALL rechazar la operación (firma o settle,
  según dónde se detecte primero) sin transmitir ni verificar nada on-chain con ese `to`.
- AC-4: the system SHALL ejecutar el reorder ÚNICAMENTE contra Base Sepolia testnet y el sandbox de
  TransFi en tests — ningún test ni código de esta HU asume ni apunta a mainnet real ni dispara una
  orden real fuera de una ejecución explícitamente autorizada por el founder (gateada, "la corre él
  con `!`").
- AC-5: WHILE `NEXT_PUBLIC_EIP3009_ENABLED` y `TRANSFI_ADAPTER_READY` permanecen en su valor default
  (OFF/ausente) en todos los entornos compartidos, the system SHALL mantener el flujo de demo/mock
  byte-idéntico a pre-HU (el reorder y el binding nuevo son código MUERTO sin ambos flags ON).
- AC-6: the system SHALL preservar, sin debilitar, TODAS las garantías de seguridad ya existentes
  del money-path (WKH-168 verificación on-chain V1-V9, WKH-202 autoridad KYC server-side, WKH-206
  proof-of-possession, WKH-207 ledger/reconciliación, WKH-209 domain EIP-712 por red) — cualquier
  cambio de guard-order debe documentarse explícitamente como DT con la justificación de por qué NO
  reduce la fuerza del guard que reemplaza.
- AC-7: IF el `depositAddress` no pudo obtenerse (agente no disponible, orden TransFi rechazada,
  KYC no autorizado, o `wasiai-remittance-agents` aún no expone el campo — Missing Inputs #2), THEN
  the system SHALL fallar ANTES de pedirle a la wallet que firme nada (nunca se le muestra al
  usuario una firma con un `to` no confirmado por el server).
- AC-8: the system SHALL NUNCA persistir ni loguear el `depositAddress` junto a PII del beneficiario
  (mismo criterio CD-7 de WKH-207/CD-3 de WKH-210) — solo el `remittanceId`/`quoteId`/`depositAddress`/
  `chainId` (hechos operativos, no PII) viajan al binding y, si corresponde, al ledger.

## Scope IN
- `src/infrastructure/wallet.ts:85-147,240-300` (`InjectedWallet.authorizePrincipal`,
  `WalletConnectWallet.authorizePrincipal`) — el `to` deja de resolverse vía
  `resolveReceiverAddress()`; pasa a recibir/usar el `depositAddress` atestado.
- `src/application/ports.ts` (`WalletPort.authorizePrincipal`, `PrincipalSettlementGateway`,
  posible port nuevo del binding) — cambio de firma aditivo cuidadoso (evitar el patrón fail-open de
  un parámetro opcional suelto, mismo criterio que el comentario de `confirm-and-send.ts:30-41`).
- `app/api/settle/principal/route.ts` (S12 líneas 144-147, V1-V9 líneas 174-185) — el `expectedTo`
  deja de ser `resolveReceiverAddress()`; pasa a validarse contra el binding atestado del
  `remittanceId`.
- `src/application/use-cases/confirm-and-send.ts` (orden de pasos 3-4, líneas 118-195) — inserta el
  paso de obtención/binding del `depositAddress` ANTES de `authorizePrincipal`.
- `app/api/a2a/payout/submit/route.ts` (guard-order, particularmente el guard 8/atestación,
  líneas 178-267) — su semántica cambia: deja de ser el ÚNICO punto que crea la orden TransFi, o
  cambia su gate para no exigir una atestación que ya no puede existir en ese momento del flujo
  (decisión de F2, ver DT-2/binding).
- Endpoint nuevo (candidato `/api/payout/prepare`, nombre a confirmar en F2) — si el enfoque B se
  confirma.
- `.env.example` — documentar cualquier env nueva del binding (server-only, sin `NEXT_PUBLIC_` salvo
  que se justifique lo contrario).
- **Cross-repo (fuera de este repo, pero bloqueante — ver Missing Inputs #2)**:
  `wasiai-remittance-agents/src/agents/cashout-payout.ts` (`CashoutPayoutOutput` +
  mapeo de retorno) necesita exponer `depositAddress` en el HTTP output. Esta HU (scope de
  `chaski-v2`) NO puede tocar ese repo directamente; se documenta como dependencia externa.

## Scope OUT
- El envío on-chain real / la creación de una orden TransFi real fuera de un test mockeado — GATEADO
  al founder (`!`), consistente con WKH-208/WKH-209/WKH-210.
- Encender `NEXT_PUBLIC_EIP3009_ENABLED` o `TRANSFI_ADAPTER_READY` en cualquier entorno compartido.
- El webhook receiver de TransFi (`app/api/webhooks/transfi/route.ts`) — YA DONE (WKH-210), esta HU
  NO lo modifica salvo que el binding nuevo requiera correlacionar el `depositAddress` en el ledger
  (a decidir en F2; si aplica, es un campo ADITIVO al `SettlementLedger`, nunca un cambio de guard
  del webhook).
- Cualquier cambio al provider `TransFiPayoutProvider`/`payout.ts` del repo
  `wasiai-remittance-agents` MÁS ALLÁ de exponer `depositAddress` en el output HTTP del agente — el
  contrato interno (`PayoutResult`) YA existe (WKH-208), no se toca su forma.
- Migrar o modificar la persistencia de `remittance_settlements` (WKH-207) salvo el campo aditivo
  del `depositAddress` si el binding elegido en F2 lo requiere.
- Debilitar, remover o "temporalmente saltear" el guard 8 (atestación de settlement) de
  `submit/route.ts` SIN reemplazarlo por un guard de fuerza equivalente — prohibido explícitamente
  (ver CD-2).

## Decisiones técnicas (DT-N)
- DT-1 (a resolver en F2, con el founder — ver Missing Inputs #1): enfoque de binding A/B/C. El
  Analyst recomienda B (endpoint `prepare` + atestación de `depositAddress`, patrón `attestation.ts`)
  por ser la extensión más directa de infraestructura ya auditada y probada en este repo (WKH-168),
  pero NO es una decisión del Analyst — requiere aprobación explícita.
- DT-2: el guard 8 de `submit/route.ts` (atestación de settlement, G3/WKH-168) tiene que
  REDISEÑARSE, no eliminarse: la garantía "no hay payout sin evidencia de que el USDC entró" debe
  preservarse en ALGÚN punto del flujo reordenado (probablemente movida a un guard NUEVO en el paso
  final, post-settle, que confirma tanto la atestación de settlement COMO que el settle fue AL
  `depositAddress` correcto — dos ataduras en vez de una). Ver AC-6.
- DT-3: la fuente de verdad `remittanceId → depositAddress` debe ser HMAC-atestada (mismo mecanismo
  criptográfico que `attestation.ts`: `node:crypto`, secreto leído dentro de la función, TTL corto,
  timing-safe), NUNCA confiada a un valor que viaje desde el cliente sin verificación server-side —
  aunque el mecanismo se reutiliza, es un tipo de atestación NUEVO y distinto (pre-settlement, no
  post-verificación on-chain).
- DT-4: dependencia cross-repo (Missing Inputs #2) — esta HU NO puede considerarse completable en
  `chaski-v2` sola. El Architect debe decidir en F2 si el Scope IN incluye coordinar/esperar el
  cambio en `wasiai-remittance-agents`, o si esta HU se entrega con esa pieza mockeada/stubeada hasta
  que el companion ticket del otro repo cierre.
- DT-5: el riesgo de "orden TransFi huérfana" (prepare exitoso + settle fallido) es un residual NUEVO
  que ninguna HU previa contempló — se documenta en la Tabla de riesgo; su mitigación completa
  (expiración/cancelación de órdenes TransFi sin fondos) puede exceder el alcance de esta HU y
  quedar como follow-up explícito, a decidir en F2.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO mover USDC real o crear una orden TransFi real fuera de un test mockeado en
  cualquier ejecución no explícitamente autorizada por el founder.
- CD-2: OBLIGATORIO que el `depositAddress` usado como `to` de la firma esté ATESTADO
  criptográficamente por el server (HMAC o equivalente, nunca un valor confiado sin verificar) —
  ningún caller puede inyectar un `to` arbitrario y lograr que la wallet lo firme o que
  `settle/principal` lo acepte.
- CD-3: PROHIBIDO remover o debilitar el guard 8 (atestación de settlement, G3/WKH-168) sin
  reemplazarlo por una garantía de fuerza EQUIVALENTE en el flujo reordenado (ver DT-2) — el AR de
  esta HU ataca específicamente este punto.
- CD-4: PROHIBIDO encender `NEXT_PUBLIC_EIP3009_ENABLED` o `TRANSFI_ADAPTER_READY` en cualquier
  entorno compartido como parte de esta HU.
- CD-5: PROHIBIDO tocar `wasiai-remittance-agents` directamente desde esta HU (repo distinto, otro
  pipeline QUALITY) — solo se documenta la dependencia (DT-4).
- CD-6: OBLIGATORIO que un `depositAddress` obtenido pero nunca confirmado por un settle exitoso
  (orden huérfana) NUNCA se reporte como `principal_in` ni dispare un payout — el ledger solo avanza
  con evidencia on-chain real (mismo principio que V1-V9 hoy).
- CD-7: PROHIBIDO persistir o loguear el `depositAddress` junto a PII del beneficiario.

## Tabla de riesgo (money-path) — el vector central es DESVÍO DE FONDOS

| Riesgo | Severidad | Mitigación |
|---|---|---|
| Un atacante declara un `depositAddress` propio/ajeno y logra que la wallet firme `to=ese address`, desviando el USDC del sender | CRÍTICA | El `to` firmado DEBE provenir de un binding atestado server-side (HMAC), nunca de un campo del body/UI controlado por el cliente (CD-2/DT-3) — mismo estándar que `SettlementAttestation` |
| El guard S12/V1-V9 de `settle/principal` se reescribe para comparar contra un valor "server-trusted" mal derivado (ej. el `to` del body sin atar a la atestación), reabriendo el gap que V1-V9 cerraba desde WKH-168 | CRÍTICA | La verificación ON-CHAIN (V6/V8) sigue siendo obligatoria; se AGREGA la comparación contra el `depositAddress` atestado, nunca se REEMPLAZA por una comparación más débil |
| El guard 8 (atestación de settlement) se remueve/saltea para poder llamar al agente ANTES del settle, y nadie lo repone en un punto equivalente → un atacante con KYC propio aprobado vuelve a poder pedir un payout arbitrario sin haber pagado (regresión directa al bug que WKH-168/G3 cerró) | CRÍTICA | DT-2: el guard se REDISEÑA (movido, no eliminado); AC-6 exige preservar la garantía; el AR de esta HU debe intentar explícitamente este ataque |
| `prepare` (o el agente) crea una orden TransFi real con `depositAddress` asignado, y el `settle` posterior falla (wallet rechaza firmar, red cae, quote vence) → orden huérfana esperando fondos que nunca llegan | NUEVA, MEDIA-ALTA (operativo, no fuga directa de fondos) | DT-5: política de expiración/cancelación de órdenes sin `principal_in` — a diseñar en F2; mínimo viable: TTL corto en la atestación del `depositAddress` (AC-2) para que la ventana de exposición sea acotada |
| `chaski-v2` intenta leer `depositAddress` de la respuesta del agente antes de que `wasiai-remittance-agents` lo exponga por HTTP (gap real confirmado en F0) → excepción no controlada o `depositAddress` `undefined` tratado como válido | ALTA (bloqueante de desarrollo, no de producción si se testea bien) | DT-4/CD-5: dependencia cross-repo documentada; el parseo defensivo del binding DEBE rechazar (fail-closed) un `depositAddress` ausente/malformado, nunca asumir un default |
| El `depositAddress` atestado se reusa/replay para OTRO `remittanceId` (ej. reciclar una atestación vieja para desviar el USDC de una remesa distinta hacia la orden de otro sender) | ALTA | La atestación DEBE atar `remittanceId` + `quoteId` + `chainId` (mismo patrón A6/A7/A7′/A7″ de `submit/route.ts`), single-use si aplica (claim-once, Upstash) |
| PII del beneficiario o el `depositAddress` terminan en un log/persistencia junto a datos identificables | MEDIA | CD-7, mismo criterio que WKH-207/WKH-210 (solo IDs/enums, nunca PII) |

## Missing Inputs
- **[BLOQUEANTE F2, decisión de founder]** Enfoque de binding del `depositAddress` (A/B/C, ver
  sección dedicada arriba). El Architect NO debe diseñar el SDD sin esta confirmación — es la
  decisión de arquitectura money-path central de la HU.
- **[BLOQUEANTE F2, dependencia cross-repo]** `wasiai-remittance-agents` (WKH-208, DONE) expone
  `depositAddress` en el tipo interno `PayoutResult`, pero **NO en el output HTTP del agente**
  (`CashoutPayoutOutput`/`invoke/route.ts`) — confirmado con Read, no es una suposición. Se necesita
  un companion ticket (fuera de este work-item, otro repo) que agregue `depositAddress` al output
  del agente ANTES de que esta HU pueda considerarse completable end-to-end. El Architect debe
  decidir en F2 si esta HU se entrega con esa pieza stubeada/mockeada mientras el companion ticket
  corre en paralelo, o si se bloquea hasta que cierre.
- **[BLOQUEANTE F2]** Cómo se preserva el guard 8/G3 (atestación de settlement pre-payout) en el
  flujo reordenado (DT-2) — el Architect necesita diseñar explícitamente el guard de reemplazo antes
  de tocar `submit/route.ts`, no puede ser un "ajuste sobre la marcha" en F3.
- **[NO bloqueante, resolver en F2]** Nombre y forma exacta del endpoint nuevo (`prepare` u otro) si
  se confirma el enfoque B — incluye si se fusiona con `submit` (mismo endpoint, dos fases) o queda
  separado.
- **[NO bloqueante, resolver en F2]** Política de expiración/cancelación de órdenes TransFi
  huérfanas (DT-5) — puede exceder el alcance de esta HU; si así se decide, registrar como follow-up
  explícito (no dejarlo implícito/olvidado).
- **[NO bloqueante]** Si el `SettlementLedger` (WKH-207) necesita un campo aditivo `deposit_address`
  para poder correlacionar/auditar, o si el binding vive enteramente en el token HMAC sin
  persistencia server-side adicional.

## Análisis de paralelismo
- Esta HU **bloquea** completar el value-delivery no-custodial end-to-end, pero NO bloquea ninguna
  otra HU activa de `chaski-v2` conocida — es la última pieza pendiente del value-delivery real
  (WKH-168/186/202/206/207/209/210 ya DONE).
- **Depende fuertemente** (Missing Inputs #2) de un companion ticket en `wasiai-remittance-agents`
  que exponga `depositAddress` en el HTTP output del agente. Esa pieza es pequeña y aislada en el
  otro repo (aditiva, mismo patrón que WKH-208/DT-4) pero es un prerequisito real, no cosmético.
- **No hay otra HU corriendo en paralelo sobre `chaski-v2`** en este momento (único analyst activo,
  mismo patrón de coordinación que WKH-202/168/206/205/207/209/210).
- Colisión de archivos esperada con cualquier HU futura que toque `wallet.ts`,
  `confirm-and-send.ts`, `settle/principal/route.ts` o `submit/route.ts` — son, con esta HU, los
  archivos de MÁS alto riesgo de todo el repo; ninguna otra HU debería tocarlos en la misma ventana
  sin coordinación explícita del orquestador.
