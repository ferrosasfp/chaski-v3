# Work Item — [HU-SOL-5 / WKH-207*] chaski-v3: wallet Solana firma+envía el `deposit` al escrow (SPL, gasless-facilitator)

## Resumen
`SolanaWallet` (nueva implementación de `WalletPort`/variante Solana) arma la instrucción
`deposit` del programa escrow Anchor (HU-SOL-12, ya DONE en `solana-programs/`) usando su IDL,
con el `reference` de Solana Pay para trazabilidad y el **facilitator como fee payer** (gasless
estructural, la ejecución real es HU-SOL-14). La wallet conectada solo hace **partial-sign** —
NUNCA transmite la tx ella misma — y el payload firmado se entrega al facilitator. Reemplaza el
depósito directo a TransFi por un depósito al **vault del escrow** (custodia trustless). El path
EVM queda intacto. `pickWallet()` debe reflejar el dispatch por VM (ver Missing Inputs #2 sobre
un conflicto de diseño detectado con HU-SOL-4). Sprint 2 del programa Solana LATAM Labs.

*Nota de numeración (mismo criterio que HU-SOL-1/WKH-206, ver `_INDEX.md` L472-475): el ticket
Jira reutilizado para esta HU es **WKH-207**, que en `_INDEX.md` fila 24 YA está usado y **DONE**
para una HU completamente distinta ("Persistencia server-side + reconciliación de remesas
huérfanas"). Se asume reuso intencional de numeración cross-programa (el programa Solana LATAM
Labs usa su propia numeración `HU-SOL-N` independiente del backlog Jira `WKH-NNN` de chaski-v2) —
ver Missing Inputs #4 (NO bloqueante, se recomienda confirmación explícita del orquestador).

## Sizing
- SDD_MODE: full
- Estimación: L
- Branch sugerido: `feat/025-hu-sol-5-wallet-deposit-escrow`

## Grounding (F0)

- **`WalletPort`** (`src/application/ports.ts:218-235`): `connect()`, `getAddress()`,
  `authorizePrincipal(quote, remittanceId, deposit?: {address})` → `{tx, eip3009?}`,
  `signMessage(message)`. El shape de retorno es 100% EVM (`eip3009?`); NO hay un slot para una tx
  Solana parcialmente firmada + su `reference`. `VmAuthorization`/`SolanaAuthorization`
  (`ports.ts:150-159`, HU-SOL-1 DONE) ya son un placeholder de TIPOS de envelope, sin lógica.
- **`wallet.ts`** (`src/infrastructure/wallet.ts`): `InjectedWallet`/`WalletConnectWallet` firman
  `transferWithAuthorization` (EIP-3009) real cuando `eip3009Enabled()`, con `to` = `deposit.address`
  ATESTADO server-side (WKH-211, fail-loud sin él — mismo patrón que esta HU debe replicar para
  `beneficiary`/`authority` Solana). `pickWallet()` (líneas 326-331) es **100% EVM-only hoy**: NO
  llama a `resolveActiveVm()`, NO tiene ninguna rama Solana.
- **`chain.ts`** (HU-SOL-1, DONE): `resolveActiveVm()` (`"evm"` default / `"solana"` / throw),
  `resolveSolanaNetworkConfig()` (devnet), `resolveSolanaUsdcMint()` (valida con `PublicKey` de
  `@solana/web3.js`, NUNCA `isAddress` de viem). `resolveActiveNetworkConfig()` es el dispatcher
  multi-VM existente — patrón a replicar para el dispatch de wallet.
- **`facilitator-client.ts`** (`src/infrastructure/settlement/facilitator-client.ts`): ÚNICO
  archivo que conoce `FACILITATOR_BASE_URL`/`FACILITATOR_API_KEY` y hace el POST a `/settle`
  (broadcast del `transferWithAuthorization` EVM ya firmado). Es el exemplar del patrón "cliente
  firma, facilitator transmite" que esta HU debe replicar del lado Solana — pero el contrato HTTP
  real del facilitator para Solana (endpoint, payload) NO existe todavía (HU-SOL-14, Scope OUT).
- **Programa escrow Anchor** (`solana-programs/programs/escrow/src/lib.rs`, HU-SOL-12 **DONE**,
  IDL en `solana-programs/target/idl/escrow.json`, program id
  `BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA`, devnet only): instrucción
  `deposit(ctx, remittance_id: [u8;16], beneficiary: Pubkey, authority: Pubkey, amount: u64, deadline: i64)`.
  Accounts: `sender: Signer(mut)`, `mint: Account<Mint>`, `escrow_state: Account<EscrowState>` (PDA
  `init`, seeds `[b"escrow", sender, remittance_id]`, `payer = sender`), `vault: Account<TokenAccount>`
  (ATA `init`, `payer = sender`, `authority = escrow_state`), `sender_ata: Account<TokenAccount>(mut)`,
  `token_program`, `associated_token_program`, `system_program`. **NO** declara ningún account
  `reference` (Solana Pay) — el programa no lo conoce.
- **Hallazgo crítico de F0 (gasless vs rent)**: el `init` de `escrow_state`+`vault` fija
  `payer = sender` en el propio programa Anchor (líneas 201-221 de `lib.rs`, HU-SOL-12 ya DONE e
  inmutable en esta HU). El "gasless" que declara HU-SOL-14 solo puede cubrir el fee de red de la
  transacción (5000 lamports base, vía `feePayer`) — el rent-exemption de las 2 cuentas que crea
  `deposit` se deduce de la wallet del `sender`, NO del facilitator. Un sender con 0 SOL no puede
  completar el deposit aunque el facilitator pague el fee de red. Documentado en Missing Inputs #6
  para HU-SOL-13/HU-SOL-14, no resuelto por esta HU.
- **`doc/sdd/024-hu-sol-4-wallet-adapter/work-item.md`** (HU-SOL-4/WKH-212, F1 únicamente — sin
  código, `@solana/wallet-adapter-react` etc. NO están en `package.json` todavía): DT-2 de esa HU
  decide explícitamente que `pickWallet()` **sigue siendo EVM-only** y que el dispatch multi-VM
  vive en `container.ts` (composition root), NO dentro de `pickWallet()`. CD-4 de esa HU prohíbe
  tocar `WalletPort` "salvo estrictamente necesario". Ambas decisiones entran en tensión directa
  con esta tarea (ver Missing Inputs #2/#3).
- **`package.json`**: `@solana/web3.js` `^1.98.4` ya instalado (HU-SOL-1). NO hay
  `@coral-xyz/anchor`, `@solana/spl-token` ni `@solana/pay` — HU-SOL-4 va a agregar
  `@solana/spl-token`/`@solana/pay` (pinneados) pero NO `@coral-xyz/anchor` (necesario para
  construir la ix desde el IDL con el cliente típico de Anchor).
- **Tests**: `src/infrastructure/wallet.test.ts` es el exemplar de test para el adapter nuevo
  (mismo patrón que seguirá HU-SOL-4 para su propio adapter).

## Acceptance Criteria (EARS)

- **AC-1**: WHEN el usuario con VM activa Solana confirma el envío del principal, THE system SHALL
  construir, vía `SolanaWallet`, la instrucción `deposit` del programa escrow (IDL de HU-SOL-12,
  program id `BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA`) con los argumentos
  `remittance_id: [u8;16]`, `beneficiary: Pubkey`, `authority: Pubkey`, `amount: u64`,
  `deadline: i64` y los accounts exigidos por el IDL (`sender`, `mint`, `escrow_state` PDA, `vault`
  ATA, `sender_ata`, `token_program`, `associated_token_program`, `system_program`).
- **AC-2**: WHEN se arma la transacción de deposit, THE system SHALL fijar el `feePayer` de la
  transacción a la Pubkey del facilitator (env-driven) Y SHALL firmarla ÚNICAMENTE con la wallet
  Solana conectada (partial-sign) — NUNCA con una clave del facilitator.
- **AC-3**: IF la transacción de deposit fue partial-signed por la wallet, THEN THE system SHALL
  NUNCA transmitirla directamente a la red (`sendTransaction`/`sendRawTransaction`) — SHALL
  entregarla serializada al facilitator para que complete la firma/broadcast (HU-SOL-14).
- **AC-4**: WHEN se arma la ix deposit, THE system SHALL incluir la `reference` de Solana Pay como
  cuenta adicional no-signer/no-writable de la transacción (`remainingAccounts`, patrón Solana
  Pay), SIN alterar los accounts declarados por el IDL del escrow (que no conoce `reference`).
- **AC-5**: WHILE la VM activa es EVM (`resolveActiveVm() !== "solana"`), THE system SHALL mantener
  `pickWallet()`, `InjectedWallet`, `WalletConnectWallet`, `FallbackWallet` y el flujo de firma
  EIP-3009 byte-idénticos a hoy — cero regresión, ningún test EVM existente cambia de expectativa.
- **AC-6**: WHEN `resolveActiveVm() === "solana"`, THE system SHALL despachar la construcción/uso
  de la wallet hacia `SolanaWallet`, de forma observable equivalente a "`pickWallet()` dispatch por
  VM" (el mecanismo exacto —dentro de `pickWallet()` o en el composition root— es decisión de F2;
  ver Missing Inputs #2).
- **AC-7**: IF no hay wallet Solana conectada (`getAddress()` devuelve `null`) al intentar armar el
  deposit, THEN THE system SHALL fallar fail-loud (throw) sin construir ni firmar una tx parcial.
- **AC-8**: THE system SHALL deriva `amount`/`deadline` de datos ya canónicos (`Money.minor` del
  quote / expiración del quote en unix seconds), sin floats — mismo criterio que CD-16 de WKH-168.

## Scope IN
- Adapter nuevo `SolanaWallet` (nombre exacto a confirmar en F2; puede coincidir/coordinar con el
  adapter que arma HU-SOL-4 para el bridge de conexión) que implementa la construcción de la ix
  `deposit` del escrow (IDL HU-SOL-12) usando `@coral-xyz/anchor` u otra construcción equivalente
  desde el IDL (decisión de F2 — ver Missing Inputs #5 sobre la dependencia nueva).
- Inclusión de la `reference` de Solana Pay como cuenta extra no-signer (`remainingAccounts`).
- `feePayer` = Pubkey del facilitator (nuevo resolver env-driven, análogo a
  `resolveReceiverAddress`/`resolveUsdcAddress` de `chain.ts`) + partial-sign por la wallet
  conectada, sin auto-broadcast.
- Punto de entrega del payload (tx serializada parcialmente firmada) hacia el facilitator — el
  cliente HTTP concreto que la transmite es HU-SOL-14 (Scope OUT); esta HU define la forma de la
  salida (qué le entrega `SolanaWallet` al caller) para que HU-SOL-14 la consuma.
- Dispatch por VM del punto de entrada de wallet (`pickWallet()` y/o el composition root, según
  decida F2 — ver Missing Inputs #2), gateado por `resolveActiveVm()`.
- Dependencia nueva `@coral-xyz/anchor` (pinneada, coordinada con HU-SOL-25) si F2 confirma que es
  la vía de construcción de la ix.
- Tests unitarios del adapter nuevo (mismo patrón que `wallet.test.ts`).

## Scope OUT
- Fee-payer gasless REAL (firma de red + broadcast efectivo por el facilitator) — **HU-SOL-14**.
- Verificación server-side del vault/settlement Solana (equivalente a `onchain-verifier.ts` EVM) —
  **HU-SOL-13**.
- Resolución de negocio de `beneficiary`/`authority` Pubkey (mapeo depositAddress TransFi → wallet
  Solana, identidad del facilitator) — **HU-SOL-13** (esta HU asume que esos valores YA le llegan
  resueltos al `SolanaWallet`, ver Missing Inputs #1).
- Proof-of-possession ed25519 (equivalente SIWE) — **HU-SOL-8**.
- El programa escrow Anchor en sí (`solana-programs/`) — ya existe, HU-SOL-12 **DONE**, inmutable
  en esta HU (repo externo, fuera de `chaski-v3`).
- Árbol de providers `@solana/wallet-adapter-react` / UI de conexión (botón, modal) — **HU-SOL-4
  (WKH-212)**, en curso, F1 solamente hoy.
- Cierre de los `[TBD HU-SOL-2]` de `SolanaAuthorization` (`ports.ts:150-157`).
- Mainnet Solana — solo devnet (config ya resuelta por HU-SOL-1).
- Cualquier cambio al path EVM en producción (WKH-168/202/206/207/209/210/211, todas DONE).

## Decisiones técnicas (DT-N)
- DT-1: `SolanaWallet` construye la ix `deposit` a partir del IDL real (`solana-programs/target/idl/
  escrow.json`), NO reimplementando el layout borsh a mano salvo que F2 justifique lo contrario.
- DT-2: El feePayer gasless se modela ESTRUCTURALMENTE en esta HU (`transaction.feePayer` =
  Pubkey del facilitator, env-driven), pero el partial-sign real del facilitator + el broadcast son
  HU-SOL-14 — `SolanaWallet` NUNCA transmite la tx.
- DT-3: La `reference` de Solana Pay se agrega como cuenta extra no-signer/no-writable
  (`remainingAccounts` del builder de instrucción de Anchor) — el escrow IDL (HU-SOL-12, DONE,
  inmutable) no declara ningún account `reference`; no se puede tocar el programa para agregarlo.
- DT-4: Reutilizar la misma Pubkey del facilitator para `authority` (quien puede invocar `release`
  en el escrow) y para `feePayer` — salvo que F2 decida separar ambos roles con envs distintas.
- DT-5: [NEEDS CLARIFICATION — decisión de F2, ver Missing Inputs #2] Dónde vive exactamente el
  dispatch por VM del entrypoint de wallet: dentro de `pickWallet()` (como pide literalmente esta
  tarea) vs. en el composition root `container.ts` (como ya decidió DT-2 de HU-SOL-4). Ambas HUs
  tocan los mismos archivos — requiere coordinación de orden/diseño antes de F3 de cualquiera.

## Constraint Directives (CD-N)
- CD-1: OBLIGATORIO — `SolanaWallet` NUNCA auto-envía/broadcastea la transacción de deposit
  (`sendTransaction`/`sendRawTransaction`); solo partial-sign + entrega al facilitator (AC-3).
- CD-2: PROHIBIDO transmitir la deposit tx directo a la red sin pasar por el facilitator gasless
  (HU-SOL-14) — la wallet firma, el facilitator completa y transmite.
- CD-3: OBLIGATORIO — el deposit va SIEMPRE al vault del escrow (PDA `escrow_state`/ATA), NUNCA a
  un address estático de TransFi (a diferencia del legacy EVM pre-WKH-211).
- CD-4: OBLIGATORIO — el path EVM (`pickWallet` EVM adapters, `InjectedWallet`,
  `WalletConnectWallet`, `FallbackWallet`, firma EIP-3009) queda BYTE-IDÉNTICO; ningún test EVM
  existente (`wallet.test.ts`, `container.test.ts`, `flow.test.tsx`) cambia de expectativa.
- CD-5: PROHIBIDO modificar el programa escrow Anchor o su IDL (`solana-programs/`) — HU-SOL-12 ya
  DONE, repo externo, fuera de scope.
- CD-6: PROHIBIDO hardcodear el program id / mint / Pubkey del facilitator — todos env-driven o
  reusados de `chain.ts` (mismo patrón que `resolveReceiverAddress`/`resolveUsdcAddress`).
- CD-7: OBLIGATORIO — `amount`/`deadline` se derivan de datos canónicos (`Money.minor`,
  `quote.expiresAt`), sin floats (AC-8, mismo criterio CD-16 de WKH-168).
- CD-8: PROHIBIDO que `SolanaWallet` invente/asuma un `beneficiary`/`authority` por default — sin
  esos valores resueltos por el caller, falla fail-loud (mismo criterio que `deposit_address_missing`
  en `wallet.ts` EVM).

## Missing Inputs
- **[BLOQUEANTE F2]** #1: Cómo se resuelven `beneficiary: Pubkey` y `authority: Pubkey` para la ix
  deposit — la capa de negocio que los provee (mapeo TransFi depositAddress → beneficiary Solana,
  identidad del facilitator) es HU-SOL-13 (Scope OUT de esta HU). El Architect debe decidir: (a)
  extender el argumento `deposit?` de `authorizePrincipal` (o crear un método/port nuevo específico
  Solana) para aceptar estos campos ya resueltos por el caller — recomendación del Analyst, mismo
  patrón que WKH-211 (`deposit.address` inyectado, fail-loud sin él); o (b) stubear con placeholders
  documentados hasta que HU-SOL-13 exista. Bloquea el diseño de la firma exacta de `SolanaWallet`.
- **[BLOQUEANTE F2]** #2: Conflicto de diseño detectado en F0 — esta tarea pide "pickWallet()
  dispatch por VM", pero HU-SOL-4 (`024`, mismo repo, F1 sin código todavía) decidió explícitamente
  (DT-2) que `pickWallet()` sigue EVM-only y el dispatcher multi-VM vive en `container.ts`. El
  Architect debe reconciliar ambas HUs: mover el dispatch a `pickWallet()` (reabre la decisión de
  HU-SOL-4) o interpretar el pedido del orquestador como el comportamiento observable del conjunto
  `pickWallet()` + `container.ts` (sin tocar `pickWallet()` literalmente). Alto riesgo de colisión
  de merge en `container.ts`/`wallet.ts` con HU-SOL-4 si no se coordina.
- **[BLOQUEANTE F2]** #3: `WalletPort.authorizePrincipal` (`ports.ts:224-231`) hoy solo devuelve
  `{tx, eip3009?}` — sin slot para una tx Solana parcialmente firmada + su `reference`. El Architect
  debe decidir si extiende `WalletPort` (tensiona con CD-4 de HU-SOL-4 — "no tocar `WalletPort`
  salvo estrictamente necesario" — aquí parece necesario) o crea un port/método nuevo específico
  para Solana.
- **[NO bloqueante]** #4: colisión de identificador Jira — `WKH-207` (asignado a esta HU por el
  orquestador) ya está usado y DONE en `_INDEX.md` fila 24 para una HU distinta. Se asume reuso
  intencional de numeración cross-programa (mismo patrón que HU-SOL-1/WKH-206). Se recomienda
  confirmación explícita del orquestador, igual que se documentó para HU-SOL-1.
- **[NO bloqueante]** #5: `@coral-xyz/anchor` (o la lib elegida para construir la ix desde el IDL)
  NO está en la lista de deps que HU-SOL-4 va a agregar (`@solana/wallet-adapter-*`,
  `@solana/spl-token`, `@solana/pay`) — esta HU necesita agregarla, pinneada, coordinado con
  HU-SOL-25 (supply-chain).
- **[NO bloqueante, hallazgo de F0]** #6: el "gasless" de HU-SOL-14 solo puede cubrir el fee de red
  (5000 lamports vía `feePayer`); el rent de `escrow_state`+`vault` que crea `deposit` está fijado
  por el programa (`payer = sender`, HU-SOL-12 DONE e inmutable) — se deduce de la wallet del
  sender, no del facilitator. Documentar para HU-SOL-13/HU-SOL-14 (posible funding previo del
  sender); no resuelto por esta HU.

## Análisis de paralelismo
- **Bloqueada por** HU-SOL-4 (`024`, WKH-212, F1 sin código aún) **para F3**: necesita el bridge
  `WalletContext`→`WalletPort` y las deps `@solana/wallet-adapter-*` ya instaladas. El F1/F2 (SDD)
  de esta HU SÍ puede avanzar en paralelo con el F1/F2 de HU-SOL-4.
- **Bloqueada por** HU-SOL-12 (escrow Anchor, DONE en repo externo `solana-programs/`) — consume su
  IDL/program id ya deployado en devnet; sin dependencia de código pendiente de esa HU.
- **Bloquea a** HU-SOL-13 (verificación server-side del vault) y HU-SOL-14 (gasless real) — ambas
  necesitan que esta HU produzca la tx armada + partial-signed antes de poder completarla/verificarla.
- **Riesgo de colisión ALTO** con HU-SOL-4 sobre `container.ts`/`wallet.ts` (mismos archivos,
  Missing Input #2) — coordinar orden explícito de F3/merge con el orquestador antes de arrancar
  cualquiera de las dos implementaciones.
- No debería tocar el path EVM en producción (WKH-168/202/206/207/209/210/211, todas DONE) — mismo
  criterio CD-4/CD-5.
