# Work Item — [WKH-216 / HU-SOL-13] Integración del escrow (chaski deposita + facilitator verifica/libera)

## Resumen
Cablea el escrow Anchor (`solana-programs`, DONE/devnet) al flujo REAL de la remesa Solana de
Chaski: en vez de transferir USDC directo a TransFi, el sender deposita al vault del escrow
(`deposit`, ya armado por HU-SOL-5); el facilitator verifica el estado on-chain del escrow
(vault + `EscrowState`) y, recién tras KYC + orden TransFi confirmados, firma/broadcastea el
`release` (authority) hacia el beneficiary; el sender puede recuperar los fondos vía `refund`
trustless si el off-ramp falla y pasó el `deadline`. Repos: `chaski-v3` + `wasiai-facilitator`.

## Sizing
- SDD_MODE: full (QUALITY, cross-repo)
- Estimación: **XL** — ver "Recomendación de split" abajo. El Analyst NO recomienda ejecutar esta
  HU como una sola unidad de trabajo F2→F3; recomienda que el Architect la parta en al menos 2-3
  sub-HUs antes de generar el Story File (mismo patrón que WKH-168→WKH-207, WKH-210→WKH-211).
- Branch sugerido:
  - `chaski-v3`: `feat/029-hu-sol-13-escrow-integration` (o el prefijo del sub-split que decida F2)
  - `wasiai-facilitator`: branch propio, convención `WFAC-N` de ese repo — el Architect debe
    confirmar el próximo número libre en F2 (fuera del alcance de este Analyst, que solo leyó ese
    repo, no escribió en él).

## Grounding (F0 — evidencia leída)

- `solana-programs/programs/escrow/src/lib.rs` (programa Anchor, `declare_id!`
  `BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA`, devnet):
  - `deposit(remittance_id, beneficiary, authority, amount, deadline)`: crea `EscrowState` PDA
    (`seeds = ["escrow", sender, remittance_id]`) + vault ATA (owner = PDA, off-curve). El
    `sender` firma; transfiere `sender_ata → vault`.
  - `release(remittance_id)`: `has_one = authority` (Anchor `ConstraintHasOne`/2001 si firma
    otro), `has_one = beneficiary`, `has_one = sender`, `has_one = mint` — TODO declarativo, no
    `require!` imperativo. CEI: `status = Released` ANTES del CPI. Transfiere `vault →
    beneficiary_ata` por `escrow_state.amount` (firmado por la PDA vía `invoke_signed`).
  - `refund(remittance_id)`: requiere `sender: Signer` (el REFUND LO FIRMA EL SENDER, no es
    "cualquiera" — la HU dice "el sender recupera", coincide con el código). Guards:
    `status == Deposited` + `Clock.unix_timestamp >= deadline`. CEI: `status = Refunded` antes
    del CPI. `vault → sender_ata`.
  - `close(remittance_id)`: requiere `status != Deposited` (terminal) — Scope OUT explícito de
    esta HU (housekeeping, no mueve valor de negocio).
  - `EscrowState`: `sender, beneficiary, authority, mint, amount, deadline, status
    (Deposited|Released|Refunded), bump`.
- `chaski-v3/src/infrastructure/solana-wallet.ts` (HU-SOL-5, DONE 2026-07-21,
  `feat/025-hu-sol-5-wallet-deposit-escrow` commit `79ff56b`): `authorizePrincipal` YA arma la
  ix `deposit` completa (PDA `escrow_state`, vault ATA, `sender_ata`, `reference` Solana-Pay),
  fija `feePayer = resolveSolanaFacilitatorPubkey()`, partial-firma SOLO con la wallet, serializa
  a base64 y la devuelve — **NUNCA broadcastea** (comentario explícito L5-7: "el broadcast es del
  facilitator (HU-SOL-14)"). El comentario de `SolanaEscrowDeposit` en `ports.ts:162-167` dice
  literal: `beneficiary`/`authority` "Resuelto por HU-SOL-13" — confirma que ESTA HU es la
  responsable de resolver esos dos pubkeys y pasarlos al 3er arg de `authorizePrincipal`, cosa
  que **hoy nadie hace**: `confirm-and-send.ts` no tiene NINGUNA rama `vm === "solana"`.
- `chaski-v3/src/application/use-cases/confirm-and-send.ts`: 100% shaped para EVM/EIP-3009 hoy
  (`eip3009`, `isAddressEqual` de viem, guard C1 `if (!eip3009) throw`, `PrincipalSettlementGateway`
  tipado EIP-3009). Es el archivo de MÁS alto riesgo del repo (marcado así por WKH-210/211: "ninguna
  otra HU debería tocarlo sin coordinación"). Para "cablear" el `deposit` Solana acá hace falta una
  rama `vm`-discriminada nueva, análoga a la rama EVM pero usando `SolanaPrincipalAuthorization`
  (`partialSignedTx`, `reference`) en vez de `{authorization, signature}`.
- `chaski-v3/app/api/settle/principal/route.ts`: ruta 100% EVM (S1-V9, EIP-712, `broadcastSettle`
  vía `facilitator-client.ts`). NO tiene contraparte Solana. Wiring del deposit real necesita, como
  mínimo, un lugar server-side que reciba `partialSignedTx`+`reference` y los reenvíe al
  facilitator — no existe hoy.
- `wasiai-facilitator/src/chains/solana-adapter.ts` (HU-SOL-6/WKH-205, HELD en
  `feat/026-wkh-205-solana-adapter`, NO en `main`): implementa `SettlementAdapter` **verify-only**
  — verifica una tx SPL-USDC FINALIZED que acredita a un `payTo` arbitrario (pin de mint+programId,
  delta neto pre/post balances, replay-dedup `UNIQUE(signature)`). Docstring explícito: "Non-EVM: no
  viem clients, **no operator broadcast wallet**, no circuit breaker" y "Solana rails auto-broadcast
  from the client wallet" (`types.ts:134-135`, WKH-204/AC-4). **No conoce el programa escrow**: no
  lee PDAs, no deserializa `EscrowState`, no tiene lógica de vault. Extenderlo a "verificar el
  vault + estado del programa" es agregar deserialización Anchor/borsh de una cuenta nueva —
  correcto conceptualmente, pero además la HU pide que el facilitator **firme y broadcastee**
  `release`, lo cual es una capacidad que **ningún adapter Solana tiene hoy** (los EVM sí, vía
  `getOperatorAccount()`/`OPERATOR_PRIVATE_KEY`, `src/infra/wallet.ts`).
- `wasiai-facilitator/src/chains/types.ts` (`SettlementAdapter`/`ChainAdapter`): el contrato
  `SettlementAdapter` (que implementa Solana) es **verify+settle sobre transferencias YA
  broadcasteadas por el cliente** — no tiene ningún método "firmar y enviar una instrucción
  server-side". El `ChainAdapter` (EVM) SÍ tiene `getWalletClient()` (capacidad de firma), pero
  ESE contrato es viem-shaped (`WalletClient`), no reusable para Solana/Anchor sin adaptación.
- `wasiai-facilitator/src/infra/wallet.ts`: patrón exemplar para la release-authority — singleton
  lazy `getOperatorAccount()` desde `OPERATOR_PRIVATE_KEY` (validado por regex, nunca logueado,
  `ChainAdapterInitError` con el nombre de la env var si falta). Se propone un análogo Solana
  (DT-5).
- `chaski-v3/doc/sdd/_INDEX.md` (sección "⚪ SOLANA LATAM LABS"): HU-SOL-1 (`023`), HU-SOL-4
  (`024`), HU-SOL-5 (`025`) y HU-SOL-7 (`026`) están **DONE**. HU-SOL-6/WKH-205 está **HELD** (no
  mergeado a `main`, branch `feat/026-wkh-205-solana-adapter` — NOTA: ese branch usa el número
  `026`, que en `chaski-v3/_INDEX.md` ya lo tiene HU-SOL-7; es una numeración de OTRO repo
  (`wasiai-facilitator`), no hay colisión real de NNN dentro de `chaski-v3/doc/sdd/`, solo una
  coincidencia de dígitos entre dos repos con convenciones de branch distintas — se documenta para
  que el Architect no se confunda). **HU-SOL-9 (definición de la `authority` del release, según
  cita textual de la HU) NO aparece en `_INDEX.md` como DONE ni como F1/F2 en curso** — ver
  Missing Inputs #2, bloqueante.
- No se encontró el IDL TypeScript-side del programa fuera de
  `chaski-v3/src/infrastructure/solana/escrow-idl.ts` (copia pinneada ya usada por HU-SOL-5) y
  `solana-programs/target/idl/escrow.json` (build artifact) — ambos consistentes con `lib.rs`.

## Acceptance Criteria (EARS)

- AC-1 (deposit cableado, chaski): WHEN el sender confirma una remesa Solana con KYC aprobado y
  quote vigente, the system SHALL invocar `WalletPort.authorizePrincipal(quote, remittanceId,
  { escrow: { beneficiary, authority } })` con `beneficiary`/`authority` resueltos SERVER-SIDE (no
  desde el body/cliente), de forma que la wallet construya y partial-firme la ix `deposit` del
  escrow en vez de cualquier transferencia directa a TransFi.
- AC-2 (verify vault, facilitator): WHILE el facilitator procesa una solicitud de `release` para
  una remesa, the system SHALL leer on-chain la cuenta `EscrowState` (PDA derivada de
  `["escrow", sender, remittance_id]`) y el balance del vault ATA, y SHALL verificar
  `status == Deposited`, `mint == USDC configurado`, y `vault.amount == escrow_state.amount` ANTES
  de construir o firmar cualquier instrucción `release`.
- AC-3 (release autorizado): WHEN el facilitator recibe una solicitud de `release` para una remesa
  cuyo KYC está confirmado, cuya orden TransFi está completada/confirmada, y cuyo destino declarado
  coincide con `escrow_state.beneficiary` verificado en AC-2, the system SHALL firmar la ix
  `release` con la keypair de la `authority` configurada y broadcastearla, transfiriendo el vault
  al `beneficiary_ata`.
- AC-4 (release NO autorizado rechazado): IF una solicitud de `release` llega sin KYC
  confirmado, sin orden TransFi completada, con un beneficiary que NO coincide con
  `escrow_state.beneficiary`, o con `escrow_state.status != Deposited` (ya liberado/reembolsado),
  THEN the system SHALL rechazar la solicitud ANTES de construir o firmar ninguna instrucción
  on-chain, y SHALL NOT transferir fondos.
- AC-5 (release no-replayable): IF el facilitator recibe una segunda solicitud de `release` para
  una remesa cuyo `escrow_state.status` ya es `Released` (verificado on-chain, AC-2) o cuya
  release ya fue procesada por este facilitator (dedup local), THEN the system SHALL rechazar la
  solicitud SIN re-firmar ni re-broadcastear ninguna transacción.
- AC-6 (refund trustless post-deadline): WHEN el sender dispara el refund desde la UI de chaski
  DESPUÉS de que `Clock.unix_timestamp >= escrow_state.deadline` Y `escrow_state.status ==
  Deposited` (el off-ramp falló o nunca se completó), the system SHALL construir y permitir que el
  sender firme la ix `refund` del escrow, devolviendo el vault a la `sender_ata` — sin requerir
  ninguna firma ni aprobación de la `authority`/facilitator.
- AC-7 (refund rechazado pre-deadline): IF el sender intenta disparar un refund ANTES de
  `escrow_state.deadline`, THEN the system SHALL bloquear/ocultar la acción en la UI (defensa en
  profundidad; el programa on-chain YA rechaza con `DeadlineNotReached` si igual se envía).

## Scope IN
- `chaski-v3/src/application/use-cases/confirm-and-send.ts`: rama nueva `vm === "solana"` que
  resuelve `SolanaEscrowDeposit` (beneficiary/authority) y pasa el 3er arg de
  `authorizePrincipal`; maneja el retorno `SolanaPrincipalAuthorization`
  (`partialSignedTx`+`reference`) — patrón de inyección opcional flag-gated, análogo al `settlement?`
  ya establecido (WKH-168), para preservar byte-identidad EVM por construcción.
- `chaski-v3/src/application/ports.ts`: puerto nuevo (o extensión aditiva) para el settle Solana —
  forma exacta [NEEDS CLARIFICATION], ver DT-1.
- `chaski-v3/app/api/...`: endpoint/ruta server-side nueva (o extensión) que recibe
  `partialSignedTx`+`reference` y coordina con el facilitator — forma exacta a definir en F2.
- `chaski-v3/src/presentation/`: acción de refund en la UI de tracking (post-deadline, estado
  `payout_failed`/equivalente).
- `wasiai-facilitator/src/chains/solana-adapter.ts` (o módulo hermano nuevo,
  ej. `solana-escrow-adapter.ts`): lectura+deserialización de `EscrowState` (AC-2) + capacidad
  nueva de firmar/broadcastear `release` (AC-3/AC-4/AC-5) con la release-authority keypair.
- `wasiai-facilitator/src/infra/`: singleton de release-authority (análogo a `wallet.ts`, DT-5).

## Scope OUT
- El armado base del `deposit` (`solana-wallet.ts:authorizePrincipal`) — YA implementado por
  HU-SOL-5, DONE. Esta HU lo consume, no lo reconstruye.
- El **broadcast gasless** del `deposit` (completar la firma de fee-payer + enviar la tx) —
  explícitamente HU-SOL-14 según el comentario de `solana-wallet.ts:7` y el texto de esta HU. Ver
  Missing Inputs #1: el LÍMITE exacto entre "cablear" (esta HU) y "broadcastear" (HU-SOL-14) es
  ambiguo y bloqueante para F2.
- El binding/definición de la `authority` del release — la HU cita textualmente "La authority del
  release = la que define HU-SOL-9". Esta HU CONSUME esa definición, no la crea. Ver Missing
  Inputs #2 (bloqueante: HU-SOL-9 no confirma DONE en `_INDEX.md`).
- El 402 intent de HU-SOL-10.
- `close` (housekeeping del vault tras estado terminal) — el programa lo soporta, pero no es parte
  del value-delivery ni de los ACs pedidos.
- Cualquier cambio a `solana-programs` (el Anchor program es DONE/deployado devnet, CD-1).
- El deploy real a Railway/prod del facilitator con la release-authority configurada — queda
  founder-gated (mismo patrón que toda esta HU: devnet + flags OFF, cero plata real).

## Decisiones técnicas (DT-N)
- DT-1: El settle Solana necesita un puerto/interfaz NUEVO (no reusar `PrincipalSettlementGateway`,
  que está 100% EIP-3009-shaped: `authorization: Eip3009Authorization; signature: string`). Se
  propone un `SolanaSettlementGateway` cuyo input espeje `SolanaPrincipalAuthorization`
  (`partialSignedTx: string; reference: string`) — decisión final de forma queda para el Architect.
- DT-2: `confirm-and-send.ts` debe ganar una rama `vm`-discriminada (usando el resultado ya
  tipado de `authorizePrincipal`: `eip3009?` vs `solana?`), reusando el patrón de inyección
  opcional flag-gated (`settlement?`) ya validado en WKH-168/WKH-211 para garantizar por
  construcción que el path EVM permanece byte-idéntico si el flag Solana está OFF.
- DT-3: `beneficiary`/`authority` de `SolanaEscrowDeposit` deben resolverse SERVER-SIDE (nunca
  confiar en el browser) — mismo espíritu no-custodial que el `depositAddress` atestado de
  WKH-211 (`DepositAttestation` HMAC). El Architect debe decidir si se reusa/extiende
  `PayoutPrepareGateway` o se crea un prepare-equivalente Solana.
- DT-4: La deserialización de `EscrowState` en el facilitator debe usar el IDL Anchor pinneado
  (mismo patrón que `chaski-v3/src/infrastructure/solana/escrow-idl.ts`), NUNCA offsets de bytes
  ad-hoc — reduce el riesgo de romperse silenciosamente si el layout de la cuenta cambia.
- DT-5: La release-authority sigue el patrón exemplar `getOperatorAccount()`/`OPERATOR_PRIVATE_KEY`
  de `wasiai-facilitator/src/infra/wallet.ts` — singleton lazy, nunca logueado, `*InitError` con
  el nombre de la env var si falta. Env var propuesta:
  `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` (formato a definir en F2 — base58 vs JSON array de
  bytes, convención estándar de Solana CLI/`@solana/web3.js` `Keypair.fromSecretKey`).

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar `solana-programs` — el programa Anchor deployado en devnet es la
  fuente de verdad inmutable para esta HU.
- CD-2: OBLIGATORIO mantener el path EVM byte-idéntico — ninguna suite EVM cambia assertion
  (mismo invariante que HU-SOL-1/4/5).
- CD-3: PROHIBIDO que el facilitator firme/broadcastee `release` sin haber leído y verificado
  `EscrowState.status == Deposited` on-chain en la MISMA invocación (nunca desde estado cacheado
  o desde el body del caller).
- CD-4: PROHIBIDO derivar el `beneficiary`/destino del release desde el body de la request del
  cliente — SIEMPRE leerlo de `escrow_state.beneficiary` verificado on-chain.
- CD-5: OBLIGATORIO devnet + flags OFF en toda esta HU — cero plata real, ningún deploy a mainnet.
- CD-6: PROHIBIDO loguear, serializar en respuestas HTTP, o exponer de cualquier forma la
  release-authority secret key (mismo invariante que `OPERATOR_PRIVATE_KEY`).
- CD-7: OBLIGATORIO reusar `canonicalizeAddress` (HU-SOL-7) para cualquier comparación de pubkeys
  base58 en la capa de aplicación de chaski.
- CD-8: OBLIGATORIO respetar el Ownership Guard (WKH-53) — cualquier query nueva sobre tablas con
  `owner_ref` (ej. si el facilitator persiste el release en un ledger propio) debe filtrar por
  `owner_ref` además del `id`.
- CD-9: OBLIGATORIO idempotencia/anti-replay en el flujo de `release` (evitar doble-firma/doble-
  broadcast de la misma remesa), análogo al `UNIQUE(signature)` dedup ya existente en
  `solana-adapter.ts` para el verify-only actual.
- CD-10: PROHIBIDO que el `refund` de la UI de chaski permita a alguien distinto del `sender`
  disparar/firmar la instrucción (el programa YA lo exige a nivel Anchor — `Signer` — pero la capa
  de aplicación no debe reintroducir una superficie donde otro caller pueda intentar disparar el
  refund de una remesa ajena).

## Missing Inputs
- **[BLOQUEANTE #1]** Límite exacto entre esta HU (HU-SOL-13, "cablear el deposit") y HU-SOL-14
  ("broadcast gasless"): ¿AC-1 se demuestra solo hasta la construcción+partial-firma del
  `deposit` (dejando el broadcast real como un gateway stub/no-op hasta que HU-SOL-14 exista), o
  esta HU necesita un mínimo de capacidad de broadcast funcional en el facilitator para que el
  deposit "entre" de verdad al vault? Afecta directamente si AC-1 es demostrable end-to-end en
  esta HU o solo parcialmente (firma sin broadcast).
- **[BLOQUEANTE #2]** Estado real de HU-SOL-9 ("define la authority del release", citada
  textualmente en el ticket): NO aparece como DONE, F1 ni F2-en-curso en
  `chaski-v3/doc/sdd/_INDEX.md` (solo HU-SOL-1/4/5/7 confirmados DONE). Sin esa definición, no hay
  una fuente de verdad clara de quién/cómo se resuelve la `authority` pubkey que
  `SolanaEscrowDeposit.authority` necesita (AC-1) ni la keypair correspondiente que el facilitator
  usaría para firmar `release` (AC-3/DT-5). Requiere confirmación del founder/orquestador antes de
  que el Architect cierre el SDD: ¿HU-SOL-9 corre ANTES (bloqueante real) o esta HU asume una
  authority devnet-de-prueba (ej. la misma `OPERATOR_PRIVATE_KEY`-equivalente) como placeholder
  temporal?
- [NO bloqueante] Endpoint exacto donde chaski entrega `partialSignedTx`+`reference` al
  facilitator para el deposit, y donde solicita el `release` (¿nueva ruta `/solana/escrow/*` en
  `wasiai-facilitator`, o extensión de `/settle` con un método nuevo?) — decisión de arquitectura
  para el Architect en F2, no bloquea F1.
- [NO bloqueante] Forma exacta del `SolanaSettlementGateway` (DT-1) y de la fuente server-side de
  `beneficiary`/`authority` (DT-3) — detalle de F2.
- [Observación, NO bloqueante para esta HU] `chaski-v3/project-context.md` está desactualizado
  (fecha 2026-07-12, sigue diciendo "Chaski v2", no menciona el stack Solana ya agregado por
  HU-SOL-1/4/5/7 — `@solana/web3.js`, `@solana/wallet-adapter-react`, `@coral-xyz/anchor`,
  `@solana/spl-token`, `@noble/hashes`). Este Analyst NO lo actualiza por estar fuera del scope
  explícito de esta tarea (`doc/sdd/029-.../` y `_INDEX.md` únicamente) — se deja como nota para
  que el orquestador lo agende como follow-up de higiene.

## Análisis de paralelismo
- **Cross-repo por diseño**: la porción `chaski-v3` (wiring del deposit + UI de refund) y la
  porción `wasiai-facilitator` (verify vault + release) pueden ejecutarse en **waves separadas**
  del Dev, incluso por sub-agentes distintos, siempre que compartan el contrato de interfaz
  (DT-1/DT-3) acordado en F2 ANTES de que ninguno de los dos empiece a codear — el riesgo de
  desalineación de contrato es el principal peligro de paralelizar cross-repo.
- **Recomendación de split (para el Architect, F2)**: dado el tamaño XL y los 2 bloqueantes, se
  sugiere partir en:
  1. **HU-SOL-13a** (chaski, wiring del deposit): rama `vm==="solana"` en `confirm-and-send.ts` +
     puerto `SolanaSettlementGateway` (posiblemente con un adapter stub/mock hasta que exista
     broadcast real) + refund UI. Bajo-medio riesgo si se seguey el patrón `settlement?` opcional
     ya probado.
  2. **HU-SOL-13b** (facilitator, verify-only, BAJO riesgo): extiende `solana-adapter.ts` (o
     módulo hermano) para leer/deserializar `EscrowState` + vault (AC-2). Es de solo-lectura, no
     requiere ninguna keypair nueva — puede ir en paralelo con 13a sin dependencia dura.
  3. **HU-SOL-13c** (facilitator, ALTO riesgo, capacidad NUEVA): firma+broadcast de `release`
     (AC-3/AC-4/AC-5) — requiere resolver el Bloqueante #2 (HU-SOL-9) primero, y probablemente
     debería fusionarse/coordinarse con el trabajo real de HU-SOL-14 (broadcast) dado que ambas
     piezas necesitan la MISMA infraestructura de "el facilitator firma y envía una tx Solana",
     hoy inexistente en el repo.
  4. El refund (AC-6/AC-7) es de bajo riesgo y puede ir con 13a (mismo repo, mismo sender-signs
     pattern que el deposit).
- **No debe correr en paralelo** con ninguna otra HU que toque `confirm-and-send.ts` (mismo
  invariante ya documentado por WKH-210/211: es el archivo de mayor riesgo del repo). A la fecha
  de este F1 no hay otra HU activa conocida sobre ese archivo en `chaski-v3`.
- Bloquea/depende de: HU-SOL-12 (escrow Anchor, DONE), HU-SOL-5 (deposit, DONE), HU-SOL-6
  (adaptador Solana verify-only, HELD — no en `main`, esta HU probablemente necesita que se
  mergee primero o al menos coordinar con su branch), y — bloqueante — HU-SOL-9 (definición de la
  authority, estado no confirmado).
