# Work Item — [WKH-227 / HU-SOL-24] Contratos A2A tipados + IDL versionado + golden EVM tests

## Resumen
Sprint 2 de la auditoría de 2ª ola de testing cierra dos deudas de testing cross-repo (T-3, T-9)
sobre los 4 repos del ecosistema Chaski (`chaski-v3`, `wasiai-facilitator`,
`wasiai-remittance-agents`, `solana-programs`): (1) los contratos HTTP entre repos hoy son
validadores manuales duplicados que driftean en silencio ante un rename, (2) el IDL del escrow
Anchor está copiado a mano en dos repos consumidores sin ningún test que lo garantice, y (3) el
"EVM byte-idéntico" que todas las HUs Solana vienen prometiendo se verifica hoy solo por review
manual. Es 100% ADITIVO — solo agrega fixtures, hashes y golden tests; cero cambio de
comportamiento runtime.

## Sizing
- SDD_MODE: full
- Estimación: L (cross-repo: toca 4 repos, aunque cada cambio individual es chico y aditivo)
- Branch sugerido: `feat/032-wkh-227-contratos-idl-golden`
- Riesgo: MEDIO — no hay monorepo ni CI compartida entre los 4 repos, así que la "detección de
  drift" es necesariamente semi-manual (ver DT-1/DT-2 y Missing Inputs). El riesgo NO es de
  ejecución (todo el trabajo es local a cada repo) sino de sostenibilidad: si un dev cambia el
  schema del provider y NO actualiza el fixture vendoreado del consumer en el mismo PR, el drift
  sigue siendo silencioso. Documentado como limitación conocida, no bloqueante para F1.

## Grounding (F0) — sitios reales de drift

### T-3 — validadores manuales duplicados
1. `chaski-v3/app/api/a2a/quote/route.ts:13-25` (`isValidQuoteResult`) — espeja a mano el shape de
   `CorridorFxOutput` de `wasiai-remittance-agents/src/agents/corridor-fx.ts:22-24`
   (`quoteId: string, rate: number, feeUsd: number, netDeliveredLocal: number, etaMinutes: number,
   expiresAt: string, provenance: string`). Ningún import compartido; si el agente renombra
   `feeUsd` → `feeUsd2`, `isValidQuoteResult` sigue devolviendo `false` limpio (falla igual, por
   suerte) — pero si el agente AGREGA un campo requerido nuevo sin que el validador lo exija, el
   drift pasa desapercibido (falso-verde).
2. `chaski-v3/src/infrastructure/settlement/facilitator-client.ts:88-104` (rama EIP-3009,
   `broadcastSettle`) y `:194-209` (rama Solana, `verifySolanaSettlement`) — construyen a mano los
   objetos `payload` que el `/settle` de `wasiai-facilitator` espera, replicando por convención
   (sin import) el shape de `wasiai-facilitator/src/core/schemas.ts::AcceptedSchema` (L62-72),
   `AcceptedExtraSchema` (L49-55), `PayloadSchema` (L81-86), `Eip3009RequestSchema` (L101-110) y
   `SolanaRequestSchema` (L171-178). Todos los objetos del facilitador son `.strict()`
   (`schemas.ts:46,55,72,86,110,143,162,169,178`): un campo extra o faltante del lado de chaski
   ⇒ 400 en runtime, no en test — el drift se descubre en producción.
3. `wasiai-remittance-agents/src/agents/kyc-validator.ts` (`KycInputSchema` L16-24,
   `KycAgentOutput` L34-43) y `cashout-payout.ts` (`CashoutPayoutInputSchema` L18-46,
   `CashoutPayoutOutput` L50-60) son los otros dos contratos HTTP `/invoke` que Chaski consume sin
   ningún test de paridad — Scope IN de esta HU aunque el HU macro solo cite `quote`/`submit`
   explícitamente (mismo patrón de riesgo, mismo fix).

### IDL del escrow — estado actual (dato importante para F2)
- Fuente de verdad: `solana-programs/target/idl/escrow.json` (`address:
  "DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x"`, discriminators `deposit=[242,35,198,137,82,225,
  242,182]`, `release=[253,249,15,206,28,127,193,241]`, etc.)
- `chaski-v3/src/infrastructure/solana/escrow-idl.ts` — copia pinneada, **verificada byte-a-byte
  idéntica** a la fuente (mismo `address`, mismos discriminators, mismos types/errors) al momento
  de este grounding (2026-07-22).
- `wasiai-facilitator/src/chains/escrow-idl.ts` — copia pinneada, **también idéntica** (única
  diferencia cosmética: comillas simples vs dobles por el linter de cada repo — el contenido
  estructural es igual).
- **NO han divergido todavía.** Pero hoy esa igualdad es pura disciplina manual (comentarios
  "COPIA PINNEADA, NO SE EDITA" en ambos archivos) — cero test la garantiza. Esta HU cierra
  exactamente ese hueco antes de que ocurra el primer drift real.

### T-9 — payloads EVM a congelar en golden tests (Scope IN)
1. `chaski-v3/src/infrastructure/wallet.ts:15-24` (`TRANSFER_WITH_AUTHORIZATION_TYPES`, el struct
   EIP-712 de `transferWithAuthorization`) + el `message`/`domain` construido en `:109-127` —
   golden del objeto `signTypedData` input completo (domain+types+message) para un input fijo.
2. `chaski-v3/src/infrastructure/wallet.ts:130-143` — golden del objeto
   `eip3009.authorization` serializado (`value`/`validAfter`/`validBefore` como STRING decimal,
   CD-16) que sale de `authorizePrincipal()`.
3. `chaski-v3/src/infrastructure/settlement/facilitator-client.ts:88-104` — golden del `payload`
   completo que arma `broadcastSettle()` (el body real del POST `/settle`, rama EIP-3009).
4. `chaski-v3/src/infrastructure/settlement/deposit-attestation.ts:62-65`
   (`issueDepositAttestation`) — golden del formato `${b64url(JSON)}.${b64url(hmac)}` para un
   payload fijo + secret fijo (determinístico, sin fecha real — usar `exp` fijo).
5. Scope OUT explícito: el envelope Solana base58 (`facilitator-client.ts:194-209`) NO es golden
   de esta HU — T-9 dice literalmente "EVM byte-idéntico"; el payload Solana es intencionalmente
   nuevo/evolutivo y congelarlo contradice el propósito de las HUs Solana en curso.

## Acceptance Criteria (EARS)
- AC-1: WHEN un campo de un schema Zod del lado PROVIDER (`wasiai-remittance-agents` o
  `wasiai-facilitator`) cambia de nombre y el fixture vendoreado del lado CONSUMER (`chaski-v3`)
  se actualiza para reflejar el nuevo shape, THEN el validador manual existente del consumer
  (`isValidQuoteResult`, o el zod-parse del payload en `facilitator-client.ts`) SHALL rechazar el
  fixture actualizado hasta que el código consumer se actualice también — el test de contrato
  SHALL fallar (rojo), no pasar en silencio.
- AC-2: the system SHALL exponer un test de auto-consistencia por cada IDL vendoreado
  (`chaski-v3/src/infrastructure/solana/escrow-idl.ts` y
  `wasiai-facilitator/src/chains/escrow-idl.ts`) que compute el hash SHA-256 de la copia local y
  lo compare contra una constante pinneada en el mismo commit; IF el contenido del archivo se
  edita a mano sin actualizar la constante, THEN el test SHALL fallar.
- AC-3: WHERE los 4 repos están montados localmente en el mismo workspace (como en este entorno de
  desarrollo), the system SHALL proveer un test best-effort adicional que compare el hash del IDL
  vendoreado contra `solana-programs/target/idl/escrow.json` leído por path relativo de sibling
  repo, SHALL saltarse (skip, no fallar) limpiamente cuando ese path no exista (CI de cada repo
  desplegado de forma independiente, sin acceso a repos hermanos).
- AC-4: WHEN cualquiera de los 4 payloads EVM listados en Grounding/T-9 (EIP-712 typed-data input,
  `eip3009.authorization` serializado, body de `/settle` EIP-3009, formato de
  `issueDepositAttestation`) cambia un solo byte de su serialización para un input fijo de
  prueba, THEN el golden/snapshot test correspondiente SHALL fallar.
- AC-5: the system SHALL usar `string`/`bigint` en minor-units (nunca `number` float) para
  cualquier campo de contrato NUEVO que represente un monto ON-CHAIN (uint256/u64 — ej.
  `accepted.amount`, `authorization.value`, montos del escrow); los montos FIAT existentes
  (`amountUsd`, `feeUsd`, `rate`, `netDeliveredLocal` de la capa FX/quote) SHALL permanecer como
  `z.number()` — son cantidades de moneda fiduciaria (USD/PEN), no unidades on-chain, y la lección
  WKH-196 (precisión NUMERIC(78,0) > 2^53) no les aplica; esta HU NO los convierte.
- AC-6: WHILE se ejecuta la suite de tests existente de los 4 repos (`chaski-v3`, `wasiai-facilitator`,
  `wasiai-remittance-agents`), the system SHALL mantener el 100% de los tests previos en verde —
  cero cambio de comportamiento runtime, solo tests/fixtures/schemas nuevos aditivos.
- AC-7: IF un fixture de contrato se vendorea de un repo PROVIDER a un repo CONSUMER, THEN el
  archivo vendoreado SHALL llevar un comentario de cabecera identificando el repo/archivo de
  origen y la fecha de sincronización — mismo patrón ya usado para el IDL ("COPIA PINNEADA,
  NO SE EDITA").

## Scope IN
- `chaski-v3/contracts/` (carpeta nueva) — fixtures vendoreados de los 3 contratos `/invoke`
  (`remit-corridor-fx`, `remit-kyc-validator`, `remit-cashout-payout`) y del contrato `/settle`
  del facilitator, + tests de contrato que replayan esos fixtures contra los validadores
  manuales existentes en `chaski-v3` (`isValidQuoteResult`, el zod-parse de
  `facilitator-client.ts`).
- `chaski-v3/contracts/` — golden tests de los 4 payloads EVM listados arriba (T-9).
- `chaski-v3/contracts/` + `wasiai-facilitator/src/chains/` (o carpeta equivalente) — test de
  hash del IDL vendoreado (AC-2), + test best-effort de comparación cross-repo (AC-3).
- `wasiai-remittance-agents/contracts/` (carpeta nueva) — fixtures PROVIDER-side generados desde
  los zod schemas reales (`CorridorFxInputSchema`/`Output`, `KycInputSchema`/`Output`,
  `CashoutPayoutInputSchema`/`Output`) + test "el fixture cumple mi propio schema hoy" (ancla la
  fuente de verdad del lado que la posee).
- `wasiai-facilitator/contracts/` (carpeta nueva) — mismo patrón para `AcceptedSchema` /
  `VerifyRequestSchema` / `SettleRequestSchema` (`core/schemas.ts`).
- Un archivo `CONTRACT-VERSIONS.md` (o `.json`) en `chaski-v3/contracts/` que liste, por cada
  fixture vendoreado, el repo/commit de origen — mecanismo de trazabilidad manual (DT-1).

## Scope OUT
- NO se toca ningún schema/validador EXISTENTE (ni Zod, ni Anchor, ni serialización) — solo se
  agregan tests/fixtures/hashes nuevos.
- NO se crea un paquete npm compartido ni un monorepo/workspace cross-repo (DT-1: descartado por
  sobre-ingeniería dado el timeline y que no hay registry privado ya configurado).
- NO se congela el payload Solana base58 en golden tests (T-9 es EVM-only; scope explícito arriba).
- NO se toca `solana-programs/` — es la fuente de verdad, se lee pero no se modifica.
- NO se resuelve el hallazgo BLOQUEANTE de WKH-208/HU-SOL-9 (schema Zod del facilitator rechaza
  `asset`/`payTo` base58 en ramas EVM) — es un bug funcional preexistente, no un problema de
  testing de contrato; fuera de esta HU.
- NO se agrega CI cross-repo real (GitHub Actions que dispare tests de un repo cuando otro
  cambia) — sería el fix correcto a largo plazo pero requiere infraestructura nueva (webhooks,
  triggers) fuera del scope de una HU de Sprint 2; documentado como Missing Input #1.

## Decisiones técnicas (DT-N)
- DT-1: **Sin monorepo, `contracts/` vive DUPLICADO por repo (fixtures vendoreados), NO como
  paquete npm compartido.** Los 4 repos son deploys independientes (Vercel/Railway) sin registry
  privado. El mecanismo real: (a) el repo PROVIDER (dueño del schema) commitea fixtures que
  pasan su propio `schema.parse()` — ancla la fuente de verdad; (b) el repo CONSUMER vendorea
  (copia) ese mismo fixture con un header de origen (AC-7) y lo replaya contra su propio
  validador manual; (c) cuando el provider cambia el shape, el dev que hace ese cambio DEBE
  actualizar el fixture vendoreado en el mismo trabajo (documentado en `CONTRACT-VERSIONS.md`).
  Esto detecta drift DENTRO de una sesión de cambio (AC-1) pero NO detecta automáticamente un
  drift que ocurra en otra sesión sin que alguien recuerde sincronizar — limitación conocida,
  ver Missing Inputs #1.
- DT-2: **Hash del IDL en dos niveles.** Nivel 1 (siempre corre en CI): SHA-256 de la copia local
  vendoreada vs. una constante pinneada en el mismo archivo — detecta ediciones manuales
  accidentales de la copia (typos, refactors que tocan el objeto sin querer). Nivel 2
  (best-effort, solo corre si el path sibling `../solana-programs` existe — cierto en este
  workspace de desarrollo, falso en CI real de cada repo desplegado por separado): compara contra
  `solana-programs/target/idl/escrow.json` directamente. Nivel 2 es la ÚNICA detección real de
  drift contra la fuente de verdad; se documenta explícitamente su naturaleza best-effort.
- DT-3: **4 payloads EVM congelados como golden (no más, no menos)** — los listados en
  Grounding/T-9. Se descartan otros candidatos (ej. el envelope completo de
  `verifySolanaSettlement`) por estar fuera del scope EVM-only de T-9, y el mensaje `signMessage`
  del modo demo (`wallet.ts:146-149`) por no ser un contrato cross-repo (nadie más lo parsea).
- DT-4: **Los montos FIAT (`amountUsd`, `feeUsd`, `rate`, `netDeliveredLocal`) se quedan como
  `z.number()`.** Son cantidades de moneda fiduciaria calculadas server-side (no leídas de
  NUMERIC(78,0) on-chain vía supabase-js), la lección de precisión de WKH-196 no aplica. Solo los
  campos que representan unidades on-chain (uint256/u64) están sujetos a la regla
  string/bigint — y esos YA están correctamente tipados hoy (`Uint256StringSchema` en el
  facilitador, `amountMinor: string` en `facilitator-client.ts`). AC-5 formaliza esto para que
  F2 no reabra la discusión.
- DT-5: Los fixtures del lado agentes (`wasiai-remittance-agents`) se generan a partir de un
  input/output REAL capturado de los tests unitarios existentes de cada agente
  (`corridor-fx.test.ts`, `kyc-validator.test.ts`, `cashout-payout.test.ts`) — no se inventan
  valores nuevos; se reusan los fixtures que esos tests ya usan como input canónico.

## Constraint Directives (CD-N)
- CD-1: **OBLIGATORIO — CERO cambio de comportamiento runtime.** Esta HU es puramente aditiva:
  tests, fixtures, hashes, comentarios. Ningún schema Zod existente, ningún IDL, ninguna función
  de infraestructura cambia su lógica ni su shape de salida. AC-6 lo verifica con la suite
  existente en verde.
- CD-2: **PROHIBIDO** editar `solana-programs/target/idl/escrow.json` — es la fuente de verdad
  generada por `anchor build`, se lee, nunca se escribe desde esta HU.
- CD-3: **PROHIBIDO** crear un paquete npm publicado o un workspace/monorepo cross-repo — ver
  DT-1 (rechazado por scope/timeline).
- CD-4: **OBLIGATORIO** — el "EVM byte-idéntico" que golden-testea T-9 SHALL capturar el
  comportamiento ACTUAL (2026-07-22) como fuente de verdad — el golden test se genera A PARTIR
  del código existente (snapshot del estado actual), NUNCA se escribe el valor esperado "a mano"
  ni se ajusta el código para que matchee un valor imaginado.
- CD-5: **PROHIBIDO** tocar `chaski-v3/app/api/a2a/quote/route.ts` más allá de lo necesario para
  que su validador manual (`isValidQuoteResult`) sea testeado por contrato — no se reescribe la
  función, no se reemplaza por el zod schema del agente (importar código de otro repo violaría el
  patrón "se consume SOLO como servicio HTTP" ya establecido para el facilitator, CD-6 de
  `facilitator-client.ts`).
- CD-6: **OBLIGATORIO** — todo fixture vendoreado lleva header con origen + fecha (AC-7),
  replicando el patrón ya usado para el IDL ("COPIA PINNEADA, NO SE EDITA... fuente:
  <repo>/<path>").
- CD-7: **PROHIBIDO** que cualquier fixture de contrato incluya PII real (DNI, nombres) —
  reusar patrones ya sanitizados de los tests existentes (mismo criterio que
  `kyc-validator.ts` L28-43, que ya excluye `travelRuleData`/`legalId` del output).

## Missing Inputs
- [resuelto en F2, no bloqueante] #1: el mecanismo de drift-detection descrito (DT-1/DT-2) es
  semi-manual porque no hay CI cross-repo. Una solución más fuerte (ej. GitHub Action en cada
  provider que dispare un `repository_dispatch` a los consumers, o un paquete npm privado) queda
  fuera de esta HU por costo/tiempo — F2 debe decidir si documenta esto como deuda técnica
  explícita (nuevo ticket) o lo deja como está.
- [resuelto en F2, no bloqueante] #2: confirmar en F2 si `wasiai-remittance-agents` y
  `wasiai-facilitator` (los repos PROVIDER) están dentro del alcance de ejecución de esta misma
  HU (mismo Story File, mismo Dev wave) o si se dividen en 2-3 HUs paralelas por repo — dado que
  son 4 repos, el Architect puede preferir 3 Story Files/waves (uno por repo consumer/provider)
  para paralelizar Dev, en vez de un solo Story File monolítico.

## Análisis de paralelismo
- Esta HU NO bloquea ninguna otra HU en curso: es puramente aditiva (tests/fixtures), no toca
  lógica de negocio ni flags.
- Puede correr en PARALELO con cualquier HU activa de money-path o Solana (WKH-214/HU-SOL-11 ya
  DONE, no hay HU abierta en este momento que compita por los mismos archivos de
  producción — los archivos que esta HU toca en modo escritura son `route.ts`/`wallet.ts`/
  `facilitator-client.ts`/`deposit-attestation.ts` SOLO para agregar tests junto a ellos, no para
  modificarlos).
- Dado que toca 4 repos, es candidata natural a 3 waves paralelas de Dev (una por repo consumer:
  `chaski-v3`; y dos por repo provider: `wasiai-remittance-agents`, `wasiai-facilitator`), cada
  una con su propio Story File — decisión final en F2 (ver Missing Input #2).
- Companion natural (no bloqueante, mismo dominio): el hallazgo BLOQUEANTE de WKH-208/HU-SOL-9
  (schema Zod del facilitator rechaza base58 en ramas EVM) sería detectado automáticamente por el
  contract test de AC-1 una vez que exista — argumento a favor de priorizar esta HU antes de
  reabrir esa rama Solana.
