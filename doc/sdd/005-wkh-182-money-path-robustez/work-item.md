# Work Item — [WKH-182] Money-path robustez: validación de dominio del quote, lock optimista, chain configurable y monto lockeado al payout

## Resumen
Auditoría adversarial 2026-07-10 (backlog 180-183, mismo repo `chaski-v2`, ya con WKH-178/179/180/181
mergeados en `main`). Esta HU cierra 6 gaps de robustez del money-path que hoy son **latentes**
(la firma es simbólica — `signMessage`, no EIP-3009 real — y el payout es `FallbackPayoutGateway`
MOCK) pero se vuelven **reales y explotables** en cuanto WKH-168 (desembolso real) y la firma
EIP-3009 real entren en producción: (A5) el dominio no valida que `receive` sea consistente con
`send`/`feeUsd`/`rate`; (A6) `ConfirmAndSend` + `LocalRepo.save()` hacen read-modify-write sin lock
optimista (doble-confirm/doble-submit en carrera); (M1) la chain está hardcodeada a Avalanche
mainnet (43114) en vez de leerse de env; (M2) el `expiresAt` del quote no se re-chequea entre
`confirm()` y `payouts.submit()` (ventana de espera por firma de wallet real puede tardar minutos);
(M3) `payouts.submit()` recibe `amountUsd` (USDC bruto) pero NO el `receive` PEN lockeado que el
usuario confirmó — el adapter de payout tendría que re-derivar el monto en soles, rompiendo la
garantía de "lo que viste es lo que llega"; (M4) no hay verificación de `chainId` post-connect ni
validación de la address antes de pedir la firma.

## Sizing
- Modo de proceso: QUALITY (Chaski es siempre QUALITY por convención de proyecto)
- SDD_MODE: full (toca domain — `remittance.ts`/`RemittanceState` — + ports + 2 use-cases/adapters +
  infra de persistencia + infra de wallet; 6 hallazgos distintos, no es un fix contenido)
- Estimación: L
- Branch sugerido: `fix/182-money-path-robustez`

## F0 — Grounding (líneas verificadas 2026-07-11, sobre `main` post WKH-178/179/180/181)

### A5 — el dominio no valida `receive` vs `send`/`feeUsd`/`rate`
`src/domain/remittance.ts:181-186` (`attachQuote`):
```ts
attachQuote(quote: Quote, now: string): void {
  if (quote.send.minor !== this.state.sendUsd.minor) throw new Error("quote_amount_mismatch");
  if (this.isQuoteExpired(quote, now)) throw new Error("quote_expired");
  this.to("quoted", now, { quote });
}
```
Solo valida `send` contra el monto que el sender pidió, y expiry. NO hay ninguna verificación de
que `quote.receive` sea coherente con `quote.send`, `quote.feeUsd` y `quote.rate`. Un
`QuoteGateway` comprometido, buggy, o un ataque de tampering en tránsito (hoy el `QuoteGateway` es
`FallbackQuoteGateway`, mañana un agente A2A remoto `remit-corridor-fx`) puede devolver un
`receive` inflado o degradado sin que el dominio lo rechace — el invariante "el monto que se
muestra en Review es matemáticamente el que resulta de send/fee/rate" no está protegido.
Grounding de la fórmula real hoy (`src/infrastructure/fallback/gateways.ts:46-60`,
`FallbackQuoteGateway.requestQuote`):
```ts
const netUsd = Math.max(0, req.amountUsd - FLAT_FEE_USD);
receive: Money.of(Number((netUsd * rate).toFixed(2)), "PEN"),
```
Es decir, hoy `receive ≈ round((send.major - feeUsd.major) * rate, 2)`. Esta fórmula es la que el
Architect debe replicar como chequeo de dominio en F2 (con tolerancia por redondeo — el agente real
`remit-corridor-fx` podría redondear distinto).

### A6 — sin lock optimista / CAS en `confirm-and-send.ts` + `persistence.ts`
`src/application/use-cases/confirm-and-send.ts:24-77` (`ConfirmAndSend.execute`) hace: `repo.get(id)`
(línea 25) → `r.confirm()` + `repo.save(r)` (líneas 29-30) → autoridad server-side (líneas 40-49,
con `repo.save()` si falla) → `wallet.authorizePrincipal()` (espera la firma del usuario en su
wallet — puede tardar arbitrariamente, línea 53) + `repo.save()` (línea 55) → `payouts.submit()`
(línea 60) + `repo.save()` final (línea 76). **4 lecturas/escrituras separadas del mismo
`remittanceId`, sin ningún token de versión.** `src/infrastructure/persistence.ts:91-95`
(`LocalRepo.save`) confirma que la escritura es blind read-modify-write:
```ts
async save(r: Remittance): Promise<void> {
  const map = this.read();
  map.set(r.snapshot.id, r.snapshot);
  this.write(map);
}
```
No hay `version`/`updatedAt` comparado contra lo ya persistido — el último `save()` en llegar
GANA sin detectar que otro proceso pisó el estado en el medio. El dominio (`Remittance.to()`,
`remittance.ts:162-167`) SÍ valida transiciones válidas (`canTransition`), lo cual evita que un
doble-`confirm()` sobre la MISMA instancia rehidratada crashee con estados imposibles, pero NO
evita la carrera real: dos llamadas a `ConfirmAndSend.execute({remittanceId})` concurrentes (doble
click, retry de red, doble tab) cada una hace su propio `repo.get()` ANTES de que la otra escriba
— ambas leen `status: "quoted"`, ambas pasan `r.confirm()` localmente, ambas piden
`wallet.authorizePrincipal()` (dos prompts de firma) y ambas intentan `payouts.submit()` con el
mismo `idempotencyKey` (`${s.id}:${quote.quoteId}`, línea 58) — la idempotencia depende 100% de que
el `PayoutGateway` de abajo la implemente correctamente (el `FallbackPayoutGateway` actual,
`fallback/gateways.ts:92-103`, NO chequea idempotencyKey, genera un nuevo `payoutId` cada vez).

### M1 — chain hardcodeada
`src/infrastructure/wallet.ts` importa `avalanche` de `viem/chains` (línea 4, mainnet 43114) y lo
usa hardcodeado en `InjectedWallet.connect()` (línea 21), `InjectedWallet.authorizePrincipal()`
(línea 35) y `WalletConnectWallet.authorizePrincipal()` (línea 113). `WalletConnectWallet.
ensureProvider()` (línea 83) hardcodea `chains: [43114]` en el init de `EthereumProvider`. No hay
ninguna referencia a `NEXT_PUBLIC_CHAIN_ID` ni a Fuji (43113) en todo el archivo (grep confirmado).
`.env.example` NO tiene ninguna variable de chain hoy (solo `NEXT_PUBLIC_REOWN_PROJECT_ID` implícito
en `wallet.ts:130`, no documentado en `.env.example` tampoco — gap adyacente, fuera de scope
estricto de esta HU salvo que el Architect decida agregarlo junto con `NEXT_PUBLIC_CHAIN_ID`).

### M2 — expiry no re-chequeado entre confirm y submit
`Remittance.confirm()` (`remittance.ts:189-196`) chequea `isQuoteExpired` en el momento T1 (línea
194). Entre ese punto y `payouts.submit()` (`confirm-and-send.ts:60-66`) transcurren: la
re-validación de autoridad server-side (llamada de red a `/api/payout/validate`, línea 41-44) y
`wallet.authorizePrincipal()` (línea 53 — espera la firma real del usuario en su wallet, que puede
tardar minutos en el mundo real, sobre todo con WalletConnect/deep-link a un wallet móvil). Ningún
punto entre esos dos pasos vuelve a comprobar `quote.expiresAt`. `isQuoteExpired` es un método
`private` del agregado (`remittance.ts:214-216`) — no hay forma pública hoy de re-chequearlo sin
exponer un método nuevo o intentar `attachQuote`/`confirm` de nuevo (lo cual violaría la máquina de
estados, `quoted→quoted` es la única auto-transición permitida, `confirmed` no vuelve a `quoted`).

### M3 — al payout se le pasa USD bruto, no el `receive` PEN lockeado
`confirm-and-send.ts:60-66`:
```ts
const rec = await this.payouts.submit({
  quoteId: quote.quoteId,
  amountUsd: s.sendUsd.major,
  beneficiary: s.beneficiary,
  kycVerificationId: kyc.verificationId,
  idempotencyKey,
});
```
`PayoutSubmit` (`src/application/ports.ts:63-69`) NO tiene ningún campo de monto en PEN:
```ts
export interface PayoutSubmit {
  quoteId: string;
  amountUsd: number;
  beneficiary: Beneficiary;
  kycVerificationId: string;
  idempotencyKey: string;
}
```
El `PayoutGateway` de abajo solo recibe `quoteId` + `amountUsd` — si el partner de cashout real
(agente `remit-cashout-payout`, o el partner directo) re-deriva el monto en soles a partir de
`amountUsd` y SU PROPIA tasa vigente en el momento del submit (en vez de usar el `quote.receive`
que el usuario vio y confirmó en el Review), el beneficiario puede recibir un monto distinto al
prometido — rompe la garantía de "recibo real" que WKH-178 instaló en la UI. El `quoteId` viaja,
así que EN TEORÍA el partner podría recuperar el `receive` original si guarda sus propios quotes,
pero el contrato (`PayoutSubmit`) no lo garantiza ni lo hace explícito — depende de una convención
implícita no tipada.

### M4 — sin verificación de chainId ni de la address
`InjectedWallet.connect()` (`wallet.ts:18-26`) llama `client.requestAddresses()` y usa el primer
address devuelto sin verificar `client.getChainId()` contra el chainId esperado — si el usuario
tiene MetaMask conectado a OTRA red (ej. Ethereum mainnet, Polygon), la firma de
`authorizePrincipal()` se pide igual, sin aviso ni bloqueo. `WalletConnectWallet.connect()`
(`wallet.ts:97-104`) tiene el mismo gap: pasa `chains: [43114]` al `EthereumProvider.init()` pero
no valida post-connect que la sesión realmente quedó en esa chain (WalletConnect permite que el
wallet del usuario apruebe una chain distinta de la solicitada). Tampoco hay validación de formato
de la address devuelta (aunque `viem` normalmente devuelve direcciones checksummed, no hay guard
explícito si `requestAddresses()`/`accounts` devuelve algo inesperado).

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `Remittance.attachQuote()` recibe un `Quote`, the system SHALL validar que
  `quote.receive` es consistente con `quote.send`, `quote.feeUsd` y `quote.rate` (fórmula
  `receive ≈ (send - feeUsd) * rate`, con una tolerancia de redondeo a definir por el Architect en
  F2 — grounding: la fórmula real hoy vive en `fallback/gateways.ts:46-60`).
- **AC-2**: IF el `receive` del quote diverge de lo calculado más allá de la tolerancia definida,
  THEN the system SHALL rechazar el `attachQuote()` (lanzar un error explícito, ej.
  `quote_receive_mismatch`) y NO transicionar el estado a `quoted`.
- **AC-3**: WHEN `ConfirmAndSend.execute()` persiste un cambio de estado vía
  `RemittanceRepository.save()`, the system SHALL usar un token de versión/concurrencia leído al
  inicio del use-case para detectar si el estado persistido cambió desde esa lectura.
- **AC-4**: IF el token de versión no coincide con el persistido al momento de escribir (carrera
  detectada — otra ejecución de `ConfirmAndSend`/otro use-case escribió en el medio), THEN the
  system SHALL fallar-loud esa escritura (NO pisar silenciosamente el estado ajeno) con una razón
  explícita (ej. `concurrent_modification`), sin continuar a los pasos posteriores (firma de
  wallet, `payouts.submit()`) si la detección ocurre antes de esos pasos.
- **AC-5**: WHILE el flujo de `ConfirmAndSend.execute()` está entre `r.confirm()` y
  `payouts.submit()`, the system SHALL re-chequear inmediatamente antes de `payouts.submit()` que
  el `quote.expiresAt` lockeado no haya vencido, y IF venció en esa ventana THEN the system SHALL
  marcar la remesa `payout_failed` con una razón explícita (ej. `quote_expired_before_submit`) SIN
  llamar a `payouts.submit()` ni a `wallet.authorizePrincipal()` si el re-chequeo ocurre antes de
  ese paso.
- **AC-6**: WHEN `ConfirmAndSend` invoca `payouts.submit()`, the system SHALL incluir el
  `quote.receive` (Money en PEN) lockeado como parte del `PayoutSubmit`, de forma que el
  `PayoutGateway` reciba explícitamente el monto que el usuario confirmó en el Review (no solo
  `amountUsd` en USDC).
- **AC-7**: the system SHALL derivar el chainId objetivo de los adapters de `WalletPort`
  (`InjectedWallet`, `WalletConnectWallet`) de una variable de entorno (`NEXT_PUBLIC_CHAIN_ID`) en
  vez de un import hardcodeado de `viem/chains` (`avalanche`/43114) — `[NEEDS CLARIFICATION]` el
  valor default (43114 vs 43113) se resuelve en Missing Inputs.
- **AC-8**: WHEN una wallet (inyectada o WalletConnect) completa `connect()`, the system SHALL
  verificar que el chainId de la sesión coincide con el chainId configurado, y IF no coincide THEN
  the system SHALL rechazar la conexión (o requerir explícitamente un chain-switch) antes de
  permitir `authorizePrincipal()`.
- **AC-9**: WHEN `wallet.authorizePrincipal()` va a pedir la firma, the system SHALL validar que
  `wallet.getAddress()` devuelve una address EVM bien formada y no-nula, y IF es nula o malformada
  THEN the system SHALL abortar sin pedir la firma.

## Scope IN
- `src/domain/remittance.ts` — `attachQuote()`: chequeo de consistencia receive/send/fee/rate
  (AC-1/AC-2); posible campo de versión/concurrencia en `RemittanceState` si el Architect decide
  que el lock optimista vive en el dominio (a definir en F2, ver DT-2).
- `src/domain/remittance.test.ts` — cobertura nueva de AC-1/AC-2 (casos válidos/inválidos/límite de
  tolerancia).
- `src/application/use-cases/confirm-and-send.ts` — re-chequeo de expiry antes de `submit()`
  (AC-5); inclusión de `quote.receive` en el `PayoutSubmit` (AC-6); manejo de fallo de CAS del
  repo (AC-3/AC-4).
- `src/application/use-cases/confirm-and-send.test.ts` — cobertura nueva de AC-3/AC-4/AC-5/AC-6
  (extiende la suite ya existente de WKH-180, no la reemplaza).
- `src/application/ports.ts` — `PayoutSubmit`: nuevo campo `expectedReceivePen: Money` (AC-6, sin
  romper el contrato de `deliveredPen` ya existente en `PayoutRecord`); `RemittanceRepository.save()`
  — contrato de CAS a definir en F2 (ej. lanzar un error tipado en conflicto, o devolver un
  resultado discriminado; el Architect decide la forma exacta).
- `src/infrastructure/persistence.ts` — `LocalRepo.save()`: implementación del CAS (comparar contra
  lo leído antes de escribir; hoy es blind read-modify-write, línea 91-95).
- `src/infrastructure/wallet.ts` — chain desde `NEXT_PUBLIC_CHAIN_ID` en vez de `avalanche`
  hardcodeado (AC-7); verificación de chainId post-connect en `InjectedWallet` y
  `WalletConnectWallet` (AC-8); validación de address antes de firmar (AC-9).
- `src/test-support/fakes.ts` — actualizar fakes (`InMemoryRepo`, `FakePayoutGateway`, `FakeWallet`)
  para soportar los nuevos contratos (CAS, `expectedReceivePen`, chainId) sin romper los tests ya
  existentes de WKH-180/181.
- `.env.example` — documentar `NEXT_PUBLIC_CHAIN_ID` (nueva).
- `src/infrastructure/fallback/gateways.ts` — SOLO si el Architect determina en F2 que
  `FallbackPayoutGateway`/`FallbackQuoteGateway` necesitan ajuste menor para no romper con los
  contratos nuevos (ej. aceptar `expectedReceivePen` sin usarlo, ya que sigue siendo mock) — no se
  espera cambio de comportamiento del mock.

## Scope OUT
- Desembolso real (WKH-168) — `FallbackPayoutGateway` sigue siendo MOCK. Esta HU endurece los
  contratos/invariantes que WKH-168 va a necesitar, no implementa el desembolso.
- Firma EIP-3009 real (hoy `authorizePrincipal()` usa `signMessage`, un mensaje simbólico, no una
  autorización on-chain real) — fuera de scope, es otra HU futura del roadmap de money-path.
- Autoridad server-side de KYC/payout (WKH-180, ya DONE) — esta HU NO reabre ni modifica
  `PayoutAuthorityGateway`/`app/api/payout/validate`, solo agrega los pasos 2.5 (M2) y ajusta el
  payload de `submit()` (M3) alrededor del enforcement ya instalado.
- Reducción/persistencia de PII (WKH-181, ya DONE) — no se toca `kyc-store.ts`,
  `toPersistedIdentity`, ni el filtrado de `list()` por wallet.
- Rediseño de UI/UX del flujo de confirmación (mensajes de error nuevos van con texto mínimo
  funcional; el diseño visual final queda a criterio del Architect/Dev, sin expandir scope).
- Migración de `LocalRepo`/`localStorage` a un backend con DB real — el CAS de AC-3/AC-4 se
  implementa DENTRO del modelo de persistencia actual (localStorage), no reemplaza la arquitectura
  de persistencia.
- Cualquier archivo fuera de `chaski-v2/` — ver CD-1.
- El demo live actual (agentshop, cobraya, Chaski v1 pre-rebrand) — CD-1 explícito abajo.
- Cambios a `remit-corridor-fx`/`remit-cashout-payout` (agentes A2A en `wasiai-a2a`) — la validación
  de dominio (AC-1/AC-2) se hace del lado de `chaski-v2` sobre el `Quote` que RECIBE, no se le pide
  al agente remoto que cambie su contrato.

## Decisiones técnicas (DT-N)
- DT-1: la tolerancia de AC-1/AC-2 se calcula en base a la fórmula ya usada por
  `FallbackQuoteGateway` (`receive ≈ round((send - feeUsd) * rate, 2)`, `fallback/gateways.ts:53`)
  — el Architect fija el epsilon exacto en F2 (candidato razonable: tolerancia relativa ~0.5-1% o
  absoluta de unos pocos centavos PEN, para absorber diferencias de redondeo entre el cliente y un
  eventual agente remoto `remit-corridor-fx` que redondee distinto). NO se exige que el agente
  remoto documente su fórmula exacta — el chequeo es defensivo, no un acoplamiento de contrato.
- DT-2: el lock optimista (AC-3/AC-4) se implementa como un campo de versión (ej. `updatedAt` ya
  existente en `RemittanceState`, o un `version: number` nuevo incremental) comparado en
  `LocalRepo.save()` contra lo ya persistido — el Architect decide en F2 si reusa `updatedAt` (ya
  existe, cero campo nuevo, pero depende de la resolución del reloj/`Clock`) o agrega `version`
  explícito (más robusto, requiere tocar `Remittance.to()` para incrementarlo). Dado que
  `RemittanceRepository`/`LocalRepo` son la ÚNICA implementación de persistencia hoy (no hay
  multi-tab real testeado, pero SÍ es el vector de M2/A6 documentado), el CAS debe vivir en la
  capa de infra (`persistence.ts`), no en el dominio — mismo principio de Clean Architecture usado
  en WKH-180 (DT-2 de esa HU: la I/O no entra al dominio puro).
- DT-3: el re-chequeo de expiry (AC-5) requiere exponer un método público nuevo en `Remittance`
  (ej. `isQuoteStillValid(now): boolean` o similar) ya que `isQuoteExpired` es `private`
  (`remittance.ts:214`) — el Architect decide el nombre/forma exacta en F2, manteniendo el dominio
  puro (recibe `now` inyectado, no usa `Date.now()` directo, mismo patrón ya establecido en
  `Clock`/`isQuoteExpired`).
- DT-4: `NEXT_PUBLIC_CHAIN_ID` (AC-7) es la única fuente de verdad del chainId para AMBOS wallets
  (`InjectedWallet` y `WalletConnectWallet`) — evita que queden desincronizados (hoy
  `WalletConnectWallet` hardcodea `[43114]` en el init de WC, independiente de lo que use
  `InjectedWallet`). El valor default (43114 mainnet vs 43113 Fuji testnet) es
  `[NEEDS CLARIFICATION]`, ver Missing Inputs — NO se asume sin confirmación humana porque cambia
  qué red ve el usuario final en el demo.
- DT-5: M3 (AC-6) NO reemplaza `amountUsd` en `PayoutSubmit` — se AGREGA `expectedReceivePen` como
  campo nuevo. Mantener ambos permite que el `PayoutGateway` real audite/reconcilie (verificar que
  `amountUsd` convertido a la tasa que EL PARTNER ve coincide razonablemente con
  `expectedReceivePen`, análogo a AC-1/AC-2 pero del lado del payout) sin perder el dato bruto en
  USDC que hoy ya se usa para telemetría/logging.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/` — ni el demo live
  (agentshop/cobraya/Chaski v1), ni `wasiai-a2a`, ni ningún agente `remit-*`. Esta HU es
  exclusivamente `chaski-v2/`.
- CD-2: PROHIBIDO que `ConfirmAndSend` llame a `wallet.authorizePrincipal()` o `payouts.submit()`
  si el re-chequeo de expiry (AC-5) o la detección de carrera (AC-4) ya determinaron que el paso
  debe abortar — el orden de los guards es: CAS/carrera → expiry re-check → firma → submit (nunca
  al revés).
- CD-3: PROHIBIDO que la validación de dominio de AC-1/AC-2 dependa de I/O (llamadas de red, fecha
  del sistema sin inyectar) — debe ser una función pura sobre los campos del `Quote` ya recibido,
  siguiendo el mismo principio que el resto de `remittance.ts` (Clock inyectado, sin
  `Date.now()`/`Math.random()` directos).
- CD-4: OBLIGATORIO que el CAS de AC-3/AC-4 sea fail-loud (lanzar/propagar un error explícito) —
  PROHIBIDO que una escritura en conflicto se resuelva silenciosamente con "el último gana" (ese
  es exactamente el bug que esta HU cierra).
- CD-5: OBLIGATORIO que `NEXT_PUBLIC_CHAIN_ID` (o el mecanismo equivalente que decida el Architect)
  sea la ÚNICA fuente del chainId para `InjectedWallet` y `WalletConnectWallet` — PROHIBIDO dejar
  un chainId hardcodeado en un adapter y configurable en el otro (evita el drift ya existente hoy
  entre el import `avalanche` y el `chains: [43114]` de WalletConnect).

## Missing Inputs
- `[NEEDS CLARIFICATION]` — BLOQUEANTE para F2: ¿el chainId default (AC-7/AC-8) debe seguir siendo
  Avalanche mainnet (43114, lo que firma hoy el demo) o pasar a Fuji testnet (43113)? La firma hoy
  es simbólica (`signMessage`, no mueve fondos reales) así que 43114 no es peligroso HOY, pero
  cablear `NEXT_PUBLIC_CHAIN_ID` es el momento natural de decidir la red objetivo antes de que
  llegue la firma EIP-3009 real (fuera de scope de esta HU, pero la env var que se defina acá va a
  ser la que use esa HU futura). Coordinar con que el WalletConnect (REOWN) ya está configurado
  para 43114 en producción — cambiar el default rompe el demo actual si no se actualiza en
  paralelo la config de REOWN/Vercel env.
- `[NEEDS CLARIFICATION]` — tolerancia exacta de AC-1/AC-2 (DT-1): el Architect debe fijar un
  epsilon concreto en F2; el Analyst no tiene la fórmula real de un eventual `remit-corridor-fx`
  remoto (hoy solo existe el fallback local) para calibrarla con precisión.
- `[NEEDS CLARIFICATION]` — forma exacta del contrato de CAS en `RemittanceRepository.save()`
  (DT-2): ¿excepción tipada, resultado discriminado `{ok:boolean}`, o un método `saveIfVersion()`
  separado? Afecta la firma del port — el Architect lo decide en F2 con impacto en todos los
  use-cases que llaman `repo.save()` (`create-remittance.ts`, `lock-quote.ts`, `start-kyc.ts`,
  `resume-kyc.ts`, `confirm-and-send.ts`, `track-remittance.ts` — grep pendiente de confirmar
  cuáles necesitan el token de versión vs cuáles pueden seguir con `save()` simple porque no están
  en el hot-path de doble-submit).
- `[resuelto en F1]` — fórmula base de consistencia receive/send/fee/rate: confirmada contra
  `fallback/gateways.ts:53` (ver DT-1); el Architect solo necesita fijar la tolerancia, no
  redescubrir la fórmula.

## Análisis de paralelismo
- No bloquea ni es bloqueada por WKH-178/179/180/181 (todas DONE, mergeadas, live) — esta HU corre
  sobre ese estado base sin reabrir esos gaps.
- Coordina con **WKH-183** (analyst paralelo, mismo backlog de auditoría 2026-07-10, NNN
  coordinado bajo `chaski-v2/doc/sdd/`) — si WKH-183 también toca `confirm-and-send.ts`,
  `ports.ts`, `persistence.ts`, o `wallet.ts`, hay que coordinar orden de merge entre Architects
  antes de F3 (mismo patrón de coordinación ya documentado en done-reports de WKH-179/180/181).
- Bloquea parcialmente a **WKH-168** (desembolso real): el `PayoutGateway` real que WKH-168
  instale debería asumir que `PayoutSubmit` YA incluye `expectedReceivePen` (AC-6) — si WKH-168
  mergea antes que esta HU, tendría que volver a tocar el mismo contrato después. Orden de merge
  sugerido: WKH-182 antes que WKH-168 (mismo patrón de precedencia que WKH-180→WKH-168 ya
  documentado).
- Puede correr en paralelo con cualquier HU que NO toque `remittance.ts`, `confirm-and-send.ts`,
  `ports.ts`, `persistence.ts`, `wallet.ts`, o `fallback/gateways.ts`.
